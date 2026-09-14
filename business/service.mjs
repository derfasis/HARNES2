import { id, hash } from './store.mjs';
import { AppError, ensure, requiredText, dateTime, now } from './errors.mjs';

import { captureOpportunity, consumeOpportunity, opportunityCapture, OPPORTUNITY_TASK } from './opportunity-consumer.mjs';

import { ingestSource, sourceCheckpoint } from './source-ingestion.mjs';
import { requestTelegramRecovery } from './sources/telegram-readonly.mjs';
import { REVIEW_ACTIONS, reviewOpportunity, opportunityReviewDetail, opportunityReviews } from './opportunity-review.mjs';

const OUTCOMES = new Set(['qualified','call_proposed','call_accepted','call_booked','call_attended','no_show','joined','declined','business_value']);
export class BusinessService {
  constructor(store, config) { this.store = store; this.config = config; this.tail = Promise.resolve(); this.telegramAccountId = null; }
  exclusive(fn) { const job = this.tail.then(fn); this.tail = job.catch(() => {}); return job; }
  partner() { return this.store.get('SELECT * FROM partners WHERE id=?', this.config.partnerId); }
  person(personId) {
    const row = this.store.get('SELECT * FROM persons WHERE id=? AND partner_id=?', personId, this.config.partnerId);
    ensure(row, 'Человек не найден', 404); return row;
  }
  conversation(conversationId) {
    const row = this.store.get('SELECT c.* FROM conversations c JOIN persons p ON p.id=c.person_id WHERE c.id=? AND p.partner_id=?', conversationId, this.config.partnerId);
    ensure(row, 'Разговор не найден', 404); return row;
  }
  draft(draftId) {
    const row = this.store.get('SELECT d.*,v.text FROM drafts d JOIN draft_versions v ON v.draft_id=d.id AND v.version=d.current_version WHERE d.id=?', draftId);
    ensure(row, 'Черновик не найден', 404); this.conversation(row.conversation_id); return row;
  }
  assertScope(actor, conversationId) {
    this.conversation(conversationId);
    ensure(actor.kind === 'operator' || !actor.conversationId || actor.conversationId === conversationId, 'Этот разговор вне области запуска', 403);
  }
  active(conversationId, { permission = false } = {}) {
    const conversation = this.conversation(conversationId), person = this.person(conversation.person_id);
    ensure(!person.suppressed, 'Контакт остановлен', 409, 'suppressed');
    ensure(conversation.ownership === 'AI_OWNED', 'Разговор ведёт человек', 409, 'human_owned');
    if (permission) ensure(person.permission.trim(), 'Зафиксируйте основание для контакта', 409, 'permission_required');
    return { conversation, person };
  }
  invalidate(conversationId, reason) {
    this.store.run('UPDATE conversations SET revision=revision+1 WHERE id=?', conversationId);
    this.store.run("UPDATE drafts SET status='stale' WHERE conversation_id=? AND status IN ('pending','approved')", conversationId);
    this.store.event(this.config.partnerId, conversationId, 'context_changed', 'system', { reason });
  }
  command(action, payload, requestId, actor = { kind: 'operator' }) {
    return this.exclusive(() => {
      try { return this.store.transaction(() => this.execute(action, payload, requestId, actor)); }
      catch (error) {
        if (REVIEW_ACTIONS.includes(action)) {
          // Denials survive the rolled-back command, without persisting untrusted text or grants.
          const task = typeof payload?.task_id === 'string' && this.store.get('SELECT id FROM tasks WHERE id=? AND partner_id=? AND kind=?', payload.task_id, this.config.partnerId, OPPORTUNITY_TASK);
          this.store.transaction(() => this.store.event(this.config.partnerId, null, 'opportunity.review.denied',
            ['operator','agent','channel'].includes(actor.kind) ? actor.kind : 'unknown',
            { action, task_id: task?.id ?? null, code: error.code ?? 'review_command_rejected',
              request_id: typeof requestId === 'string' && /^[a-f0-9-]{36}$/i.test(requestId) ? requestId : null }));
        }
        throw error;
      }
    });
  }
  execute(action, p, requestId, actor) {
    requiredText(requestId, 'request_id', 150);
    ensure(p && typeof p === 'object' && !Array.isArray(p), 'payload должен быть объектом');
    const fingerprint = hash(JSON.stringify({ action, p, actor: actor.kind, run: actor.runId ?? null, scope: actor.conversationId ?? null }));
    if (action === 'source.ingest') {
      ensure(actor.kind === 'operator' || actor.kind === 'channel' && actor.sourceId === p.source_id, 'Источник вне области adapter', 403);
      // Transport-owned sources must commit messages, native receipts and cursor together.
      const sources = this.config.opportunity?.telegramSources;
      ensure(!(Array.isArray(sources) && sources.some(s => s.sourceId === p.source_id)) && !sourceCheckpoint(this, p.source_id),
        'Источник требует transactional Telegram intake', 409, 'SOURCE_TRANSPORT_INGEST_REQUIRED');
    }
    const previous = this.store.get('SELECT * FROM command_receipts WHERE id=?', requestId);
    if (previous) { ensure(previous.fingerprint === fingerprint, 'request_id использован для другой операции', 409); return JSON.parse(previous.result_json); }
    const agentActions = new Set(['draft.create','fact.propose','lesson.propose','task.propose','capability.propose']);
    ensure(actor.kind === 'operator' || (actor.kind === 'agent' && agentActions.has(action)) || (actor.kind === 'channel' && ['person.create','message.record','source.ingest'].includes(action)), 'Операция доступна только владельцу', 403);
    let conversationId = p.conversation_id ?? null;
    if (['person.permission','person.stop','person.resume','conversation.mode','conversation.takeover','conversation.release','message.record','draft.create','fact.propose','fact.create','outcome.record'].includes(action)) requiredText(conversationId, 'conversation_id', 100);
    if (conversationId) this.assertScope(actor, conversationId);
    let result;
    switch (action) {
      case 'source.reconcile': result = requestTelegramRecovery(this,p,actor); break;
      case 'source.ingest': result = ingestSource(this, p); break;
      case 'opportunity.capture': result = captureOpportunity(this, p); break;
      case 'opportunity.consume': result = consumeOpportunity(this, p); break;
      case 'opportunity.review.edit':
      case 'opportunity.review.approve':
      case 'opportunity.review.reject': result = reviewOpportunity(this, action, p); break;
      case 'partner.update': {
        const mission = requiredText(p.mission, 'Цель', 5000);
        this.store.run('UPDATE partners SET mission=? WHERE id=?', mission, this.config.partnerId);
        result = this.partner(); break;
      }
      case 'person.create': {
        const personId = id(), convId = id(), identityId = id();
        const name = requiredText(p.name, 'Имя', 200), source = requiredText(p.source, 'Источник', 2000);
        const channel = p.channel ?? 'manual';
        ensure(['manual','telegram'].includes(channel), 'Неподдерживаемый канал');
        let channelIdentity = null;
        if (channel === 'telegram') {
          const externalId = requiredText(String(p.external_id ?? ''), 'Telegram chat ID', 50);
          ensure(/^-?\d+$/.test(externalId), 'Нужен числовой chat ID, не username');
          const account = requiredText(p.account_id ?? this.telegramAccount(), 'Bot account', 100);
          ensure(!this.store.get('SELECT id FROM channel_identities WHERE channel=? AND account_id=? AND external_id=?', channel, account, externalId), 'Этот Telegram chat уже существует', 409);
          channelIdentity = { externalId, account };
        }
        this.store.run('INSERT INTO persons(id,partner_id,name,source,notes,permission,created_at) VALUES(?,?,?,?,?,?,?)', personId, this.config.partnerId, name, source, String(p.notes ?? '').slice(0,8000), String(p.permission ?? '').slice(0,4000), now());
        if (channelIdentity) this.store.run('INSERT INTO channel_identities VALUES(?,?,?,?,?)', identityId, personId, channel, channelIdentity.account, channelIdentity.externalId);
        this.store.run('INSERT INTO conversations(id,person_id,channel_identity_id,channel,created_at) VALUES(?,?,?,?,?)', convId, personId, channelIdentity ? identityId : null, channel, now());
        conversationId = convId; result = { person_id: personId, conversation_id: convId }; break;
      }
      case 'person.permission': {
        const conv = this.conversation(conversationId);
        const permission = requiredText(p.evidence, 'Основание контакта', 4000);
        this.store.run('UPDATE persons SET permission=? WHERE id=?', permission, conv.person_id);
        this.invalidate(conversationId, 'permission_updated'); result = { updated: true }; break;
      }
      case 'person.stop': {
        const conv = this.conversation(conversationId);
        this.store.run('UPDATE persons SET suppressed=1 WHERE id=?', conv.person_id);
        for (const c of this.store.all('SELECT id FROM conversations WHERE person_id=?', conv.person_id)) {
          this.invalidate(c.id, 'stop');
          this.store.run("UPDATE tasks SET status='cancelled' WHERE conversation_id=? AND status IN ('pending','proposed','running','interrupted')", c.id);
        }
        result = { stopped: true }; break;
      }
      case 'person.resume': {
        const conv = this.conversation(conversationId);
        this.store.run('UPDATE persons SET suppressed=0,permission=? WHERE id=?', requiredText(p.evidence, 'Новое основание для контакта'), conv.person_id);
        this.invalidate(conversationId, 'explicit_resume'); result = { resumed: true }; break;
      }
      case 'conversation.takeover':
      case 'conversation.release': {
        const ownership = action.endsWith('takeover') ? 'HUMAN_OWNED' : 'AI_OWNED';
        this.store.run('UPDATE conversations SET ownership=? WHERE id=?', ownership, conversationId);
        this.invalidate(conversationId, ownership);
        if (ownership === 'HUMAN_OWNED') this.store.run("UPDATE tasks SET status='cancelled' WHERE conversation_id=? AND status IN ('pending','proposed','running')", conversationId);
        result = { ownership }; break;
      }
      case 'conversation.mode': {
        const mode = String(p.mode ?? ''); ensure(['REVIEW','AUTOPILOT'].includes(mode), 'Неизвестный режим разговора');
        this.conversation(conversationId);
        this.store.run('UPDATE conversations SET mode=? WHERE id=?', mode, conversationId);
        this.invalidate(conversationId, `mode_${mode.toLowerCase()}`);
        result = { mode }; break;
      }
      case 'message.record': {
        const text = requiredText(p.text, 'Текст', 16000), source = requiredText(p.source ?? 'operator_record', 'Источник', 2000);
        const direction = p.direction ?? 'in'; ensure(['in','out'].includes(direction), 'Некорректное направление');
        const messageId = id(), externalId = String(p.external_id ?? id());
        const duplicate = this.store.get('SELECT * FROM messages WHERE conversation_id=? AND direction=? AND external_id=?', conversationId, direction, externalId);
        if (duplicate) { ensure(duplicate.text === text, 'Событие с этим ID содержит другой текст', 409); result = { message_id: duplicate.id, duplicate: true }; break; }
        this.store.run('INSERT INTO messages(id,conversation_id,direction,author,text,external_id,source,created_at) VALUES(?,?,?,?,?,?,?,?)', messageId, conversationId, direction, direction === 'in' ? 'person' : 'operator', text, externalId, source, now());
        this.invalidate(conversationId, 'message_recorded');
        const conv = this.conversation(conversationId), person = this.person(conv.person_id);
        if (direction === 'in' && /(?:^\/stop\b|не\s+пишите|больше\s+не\s+писать|do\s+not\s+contact|stop\s+messaging|unsubscribe)/iu.test(text)) {
          this.store.run('UPDATE persons SET suppressed=1 WHERE id=?', person.id);
          for (const c of this.store.all('SELECT id FROM conversations WHERE person_id=?', person.id)) {
            this.invalidate(c.id, 'explicit_stop_message');
            this.store.run("UPDATE tasks SET status='cancelled' WHERE conversation_id=? AND status IN ('pending','proposed','running')", c.id);
          }
        } else if (direction === 'in' && !person.suppressed && conv.ownership === 'AI_OWNED') {
          this.addTask({ conversation_id: conversationId, kind: 'reply', title: `Ответить: ${person.name}`, instructions: 'Разбери новое сообщение, сохрани нужные предложения и выбери следующий шаг.', due_at: now(), evidence: messageId, dedupe_key: `inbound:${messageId}` }, 'system', 'pending');
        }
        result = { message_id: messageId }; break;
      }
      case 'draft.create': {
        const { conversation } = this.active(conversationId);
        if (actor.kind === 'agent') this.assertRunFresh(actor, conversationId);
        const text = requiredText(p.text, 'Текст черновика', 4096), draftId = id();
        const draftAction = p.action ?? 'reply'; ensure(['reply','clarify','propose_call','handoff'].includes(draftAction), 'Неизвестное действие черновика');
        ensure(!this.store.get("SELECT id FROM drafts WHERE conversation_id=? AND status IN ('pending','approved','sending')", conversationId), 'Обработайте существующий черновик', 409);
        this.store.run('INSERT INTO drafts(id,conversation_id,run_id,action,reason,context_revision,created_at) VALUES(?,?,?,?,?,?,?)', draftId, conversationId, actor.runId ?? null, draftAction, String(p.reason ?? '').slice(0,4000), conversation.revision, now());
        this.store.run('INSERT INTO draft_versions VALUES(?,?,?,?,?,?,?)', id(), draftId, 1, text, actor.kind, String(p.reason ?? '').slice(0,4000), now());
        result = { draft_id: draftId, status: 'pending' }; break;
      }
      case 'draft.edit': {
        const draft = this.draft(p.draft_id); conversationId = draft.conversation_id;
        ensure(['pending','approved'].includes(draft.status), 'Черновик уже недоступен для изменения', 409);
        const { conversation } = this.active(conversationId);
        ensure(conversation.revision === draft.context_revision, 'Контекст черновика устарел', 409);
        const version = draft.current_version + 1;
        this.store.run('INSERT INTO draft_versions VALUES(?,?,?,?,?,?,?)', id(), draft.id, version, requiredText(p.text, 'Текст', 4096), 'operator', String(p.reason ?? '').slice(0,2000), now());
        this.store.run("UPDATE drafts SET current_version=?,status='pending' WHERE id=?", version, draft.id);
        result = { draft_id: draft.id, version, status: 'pending' }; break;
      }
      case 'draft.approve': {
        const draft = this.draft(p.draft_id); conversationId = draft.conversation_id;
        ensure(draft.status === 'pending', 'Одобряется только ожидающий черновик', 409);
        const { conversation } = this.active(conversationId, { permission: true });
        ensure(draft.context_revision === conversation.revision, 'Контекст изменился', 409);
        this.store.run('INSERT INTO approvals VALUES(?,?,?,?,?,?)', id(), draft.id, draft.current_version, conversation.revision, 'operator', now());
        this.store.run("UPDATE drafts SET status='approved' WHERE id=?", draft.id);
        result = { draft_id: draft.id, status: 'approved', sent: false }; break;
      }
      case 'draft.reject': {
        const draft = this.draft(p.draft_id); conversationId = draft.conversation_id;
        ensure(['pending','approved','stale'].includes(draft.status), 'Этот черновик уже исполнялся', 409);
        this.store.run("UPDATE drafts SET status='rejected' WHERE id=?", draft.id); result = { rejected: true }; break;
      }
      case 'delivery.manual': {
        const draft = this.validApproved(p.draft_id); conversationId = draft.conversation_id;
        const receipt = requiredText(p.evidence, 'Подтверждение фактической ручной отправки', 4000), attempt = id();
        this.store.run('INSERT INTO delivery_attempts(id,draft_id,draft_version,channel,recipient,status,external_id,created_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?)', attempt, draft.id, draft.current_version, 'manual_confirmation', conversationId, 'sent', String(p.external_id ?? receipt).slice(0,1000), now(), now());
        this.recordDelivered(draft, String(p.external_id ?? attempt), 'operator_manual');
        result = { status: 'sent', delivery_attempt_id: attempt }; break;
      }
      case 'delivery.reconcile': {
        const draft = this.draft(p.draft_id); conversationId = draft.conversation_id;
        ensure(draft.status === 'delivery_unknown', 'Сверка доступна для неопределённой доставки', 409);
        ensure(['sent','failed'].includes(p.status), 'Нужен результат sent или failed');
        const evidence = requiredText(p.evidence, 'Подтверждение сверки', 4000);
        this.store.run('UPDATE delivery_attempts SET status=?,error=?,finished_at=? WHERE draft_id=? AND status=?', p.status, evidence, now(), draft.id, 'delivery_unknown');
        if (p.status === 'sent') this.recordDelivered(draft, String(p.external_id ?? id()), 'operator_reconciled');
        else this.store.run("UPDATE drafts SET status='failed' WHERE id=?", draft.id);
        result = { status: p.status }; break;
      }
      case 'task.create':
      case 'task.propose': {
        if (actor.conversationId) ensure(conversationId === actor.conversationId, 'Задача вне области разговора', 403);
        if (conversationId && actor.kind === 'agent') this.assertRunFresh(actor, conversationId);
        result = this.addTask(p, actor.kind, actor.kind === 'agent' ? 'proposed' : 'pending'); break;
      }
      case 'task.approve':
      case 'task.cancel':
      case 'task.retry': {
        const task = this.store.get('SELECT * FROM tasks WHERE id=? AND partner_id=?', p.task_id, this.config.partnerId);
        ensure(task, 'Задача не найдена', 404); conversationId = task.conversation_id;
        ensure(task.kind !== OPPORTUNITY_TASK || action === 'task.cancel', 'Opportunity candidate нельзя одобрить или поставить на исполнение', 409, 'candidate_not_executable');
        if (action === 'task.approve') ensure(task.status === 'proposed', 'Задача уже рассмотрена', 409);
        if (action === 'task.retry') ensure(['failed','interrupted','cancelled','blocked'].includes(task.status), 'Повтор недоступен', 409);
        if (action === 'task.cancel') ensure(!['done','cancelled'].includes(task.status), 'Задача уже завершена', 409);
        const status = action === 'task.cancel' ? 'cancelled' : 'pending';
        if (status === 'pending' && conversationId) this.active(conversationId);
        this.store.run('UPDATE tasks SET status=? WHERE id=?', status, task.id); result = { task_id: task.id, status }; break;
      }
      case 'fact.propose':
      case 'fact.create': {
        const conv = this.conversation(conversationId);
        if (actor.kind === 'agent') this.assertRunFresh(actor, conversationId);
        const sourceMessage = p.source_message_id ?? null;
        if (sourceMessage) ensure(this.store.get('SELECT id FROM messages WHERE id=? AND conversation_id=?', sourceMessage, conversationId), 'Источник не из этого разговора');
        const factId = id();
        this.store.run('INSERT INTO facts VALUES(?,?,?,?,?,?,?,?,?)', factId, conv.person_id, requiredText(p.text, 'Факт', 4000), sourceMessage, requiredText(p.source_ref, 'Источник', 2000), actor.kind === 'operator' ? 'confirmed' : 'candidate', actor.kind, actor.runId ?? null, now());
        if (actor.kind === 'operator') for (const c of this.store.all('SELECT id FROM conversations WHERE person_id=?', conv.person_id)) this.invalidate(c.id, 'confirmed_fact_added');
        result = { fact_id: factId }; break;
      }
      case 'fact.review': {
        const fact = this.store.get('SELECT * FROM facts WHERE id=?', p.fact_id); ensure(fact, 'Факт не найден', 404); this.person(fact.person_id);
        ensure(['confirmed','rejected'].includes(p.status), 'Неизвестный статус');
        this.store.run('UPDATE facts SET status=? WHERE id=?', p.status, fact.id);
        if (fact.status !== p.status) for (const c of this.store.all('SELECT id FROM conversations WHERE person_id=?', fact.person_id)) this.invalidate(c.id, 'fact_reviewed');
        result = { updated: true }; break;
      }
      case 'lesson.propose': {
        if (actor.conversationId) ensure(conversationId === actor.conversationId, 'Урок вне области разговора', 403);
        const lessonId = id();
        this.store.run('INSERT INTO lessons(id,partner_id,conversation_id,title,text,applicability,evidence,author,run_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', lessonId, this.config.partnerId, conversationId, requiredText(p.title, 'Название', 200), requiredText(p.text, 'Урок', 8000), requiredText(p.applicability, 'Область применимости', 2000), requiredText(p.evidence, 'Доказательства', 4000), actor.kind, actor.runId ?? null, now());
        result = { lesson_id: lessonId, status: 'candidate' }; break;
      }
      case 'lesson.review': {
        ensure(['active','retired','rejected'].includes(p.status), 'Неизвестный статус');
        const lesson = this.store.get('SELECT * FROM lessons WHERE id=? AND partner_id=?', p.lesson_id, this.config.partnerId); ensure(lesson, 'Урок не найден', 404);
        this.store.run('UPDATE lessons SET status=?,reviewed_at=? WHERE id=?', p.status, now(), lesson.id); result = { status: p.status }; break;
      }
      case 'outcome.record': {
        const conv = this.conversation(conversationId), outcomeId = id();
        ensure(OUTCOMES.has(p.kind), 'Неизвестный результат');
        if (p.source_message_id) ensure(this.store.get('SELECT id FROM messages WHERE id=? AND conversation_id=?', p.source_message_id, conversationId), 'Неверный источник сообщения');
        if (p.draft_id) ensure(this.draft(p.draft_id).conversation_id === conversationId, 'Черновик из другого разговора');
        if (p.value !== undefined && p.value !== null) ensure(typeof p.value === 'number' && Number.isFinite(p.value) && p.value >= 0, 'Некорректная величина результата');
        this.store.run('INSERT INTO outcome_events VALUES(?,?,?,?,?,?,?,?,?,?)', outcomeId, conv.person_id, conversationId, p.kind, requiredText(p.evidence, 'Подтверждение результата', 4000), p.source_message_id ?? null, p.draft_id ?? null, p.value ?? null, 'operator', now());
        this.store.run('UPDATE conversations SET stage=? WHERE id=?', p.kind, conversationId);
        if (['joined','declined'].includes(p.kind)) {
          this.store.run("UPDATE conversations SET ownership='HUMAN_OWNED' WHERE id=?", conversationId);
          this.invalidate(conversationId, p.kind);
          this.store.run("UPDATE tasks SET status='cancelled' WHERE conversation_id=? AND status IN ('pending','proposed','running')", conversationId);
        }
        result = { outcome_id: outcomeId }; break;
      }
      case 'capability.propose': {
        const proposalId = id();
        const permissions = p.permissions ?? []; ensure(Array.isArray(permissions) && permissions.length <= 20 && permissions.every(x => typeof x === 'string' && x.length <= 200), 'Нужен список прав');
        this.store.run('INSERT INTO capability_proposals(id,partner_id,name,purpose,permissions_json,acceptance,skill_content,author,created_at) VALUES(?,?,?,?,?,?,?,?,?)', proposalId, this.config.partnerId, requiredText(p.name, 'Способность', 100), requiredText(p.purpose, 'Назначение', 4000), JSON.stringify(permissions), requiredText(p.acceptance, 'Критерии приёмки', 4000), String(p.skill_content ?? '').slice(0,30000), actor.kind, now());
        result = { proposal_id: proposalId }; break;
      }
      case 'capability.review': {
        const proposal = this.store.get('SELECT * FROM capability_proposals WHERE id=? AND partner_id=?', p.proposal_id, this.config.partnerId); ensure(proposal, 'Предложение не найдено', 404);
        ensure(['accepted_for_development','rejected'].includes(p.status), 'Это рассмотрение идеи, не установка кода');
        this.store.run('UPDATE capability_proposals SET status=? WHERE id=?', p.status, proposal.id); result = { status: p.status }; break;
      }
      case 'skill.stage': {
        const proposal = this.store.get('SELECT * FROM capability_proposals WHERE id=? AND partner_id=?', p.proposal_id, this.config.partnerId); ensure(proposal, 'Предложение не найдено', 404);
        const content = requiredText(p.content, 'Содержание навыка', 30000), name = requiredText(p.name, 'Имя навыка', 80);
        ensure(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name), 'Имя: латиница, цифры и дефис');
        const version = this.store.get('SELECT COALESCE(MAX(version),0)+1 AS n FROM skill_versions WHERE name=?', name).n, skillId = id();
        this.store.run('INSERT INTO skill_versions VALUES(?,?,?,?,?,?,?,?,?)', skillId, proposal.id, name, version, content, hash(content), 'draft', null, now());
        result = { skill_id: skillId, version }; break;
      }
      case 'skill.review': {
        const skill = this.store.get('SELECT s.* FROM skill_versions s JOIN capability_proposals p ON p.id=s.proposal_id WHERE s.id=? AND p.partner_id=?', p.skill_id, this.config.partnerId); ensure(skill, 'Навык не найден', 404);
        ensure(['approved','retired','rejected'].includes(p.status), 'Неизвестный статус');
        if (p.status === 'approved') this.store.run("UPDATE skill_versions SET status='retired' WHERE name=? AND status='approved'", skill.name);
        this.store.run('UPDATE skill_versions SET status=?,reviewed_by=? WHERE id=?', p.status, 'operator', skill.id);
        result = { status: p.status, executable_code_installed: false }; break;
      }
      default: throw new AppError('Неизвестная команда', 400);
    }
    this.store.event(this.config.partnerId, conversationId, action, actor.kind, { ...p, result, run_id: actor.runId ?? null,
      ...(REVIEW_ACTIONS.includes(action) ? { request_id: requestId } : {}) });
    this.store.run('INSERT INTO command_receipts VALUES(?,?,?,?)', requestId, fingerprint, JSON.stringify(result), now());
    return result;
  }
  addTask(p, author, status) {
    const taskId = id(), due = dateTime(p.due_at ?? now()), convId = p.conversation_id ?? null;
    if (convId) this.conversation(convId);
    const key = p.dedupe_key ? requiredText(p.dedupe_key, 'dedupe_key', 200) : null;
    const kind = p.kind ?? 'research'; ensure(['reply','follow_up','research','planning','review',OPPORTUNITY_TASK].includes(kind), 'Неизвестный вид задачи');
    if (kind === OPPORTUNITY_TASK) ensure(author === 'system' && status === 'proposed', 'Opportunity review создаёт только проверенный consumer', 403);
    if (key?.startsWith('opportunity:')) ensure(kind === OPPORTUNITY_TASK && author === 'system' && status === 'proposed', 'Зарезервированный ключ consumer', 403);
    if (key) { const old = this.store.get('SELECT * FROM tasks WHERE dedupe_key=?', key); if (old) return { task_id: old.id, duplicate: true }; }
    if (kind === 'follow_up') { ensure(convId, 'Для follow-up нужен разговор'); requiredText(p.evidence, 'Основание follow-up', 2000); }
    this.store.run('INSERT INTO tasks(id,partner_id,conversation_id,kind,title,instructions,due_at,status,evidence,dedupe_key,author,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', taskId, this.config.partnerId, convId, kind, requiredText(p.title, 'Задача', 200), requiredText(p.instructions, 'Цель действия', 6000), due, status, String(p.evidence ?? '').slice(0,2000), key, author, now());
    return { task_id: taskId, status };
  }
  assertRunFresh(actor, conversationId) {
    if (!actor.runId) return;
    const run = this.store.get('SELECT * FROM runs WHERE id=?', actor.runId); ensure(run?.status === 'running', 'Запуск уже завершён', 409);
    const snapshot = JSON.parse(run.context_json);
    if (run.conversation_id) {
      const conv = this.conversation(conversationId);
      ensure(conv.revision === snapshot.conversation?.revision, 'Контекст изменился во время работы агента', 409, 'stale_context');
      this.active(conversationId);
    }
    if (run.task_id) ensure(this.store.get('SELECT status FROM tasks WHERE id=?', run.task_id)?.status === 'running', 'Задача отменена', 409);
  }
  validApproved(draftId) {
    const draft = this.draft(draftId), { conversation } = this.active(draft.conversation_id, { permission: true });
    ensure(draft.status === 'approved', 'Нет действующего одобрения', 409);
    ensure(conversation.revision === draft.context_revision, 'Разговор изменился', 409);
    ensure(this.store.get('SELECT id FROM approvals WHERE draft_id=? AND draft_version=? AND conversation_revision=?', draft.id, draft.current_version, conversation.revision), 'Одобрение не соответствует версии', 409);
    return draft;
  }
  recordDelivered(draft, externalId, source) {
    this.store.run("UPDATE drafts SET status='sent' WHERE id=?", draft.id);
    this.store.run('INSERT INTO messages(id,conversation_id,direction,author,text,external_id,source,draft_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)', id(), draft.conversation_id, 'out', source.startsWith('operator') ? 'operator' : 'agent_assisted', draft.text, externalId, source, draft.id, now());
    this.invalidate(draft.conversation_id, 'outgoing_recorded');
    if (draft.action === 'handoff') {
      this.store.run("UPDATE conversations SET ownership='HUMAN_OWNED' WHERE id=?", draft.conversation_id);
      this.store.run("UPDATE tasks SET status='cancelled' WHERE conversation_id=? AND status IN ('pending','proposed','running')", draft.conversation_id);
    }
  }
  autopilotCandidates(runId) {
    const allowed = this.config.telegram.allowedChatIds.map(String);
    if (!allowed.length) return [];
    const slots = allowed.map(() => '?').join(',');
    return this.store.all(`SELECT d.* FROM drafts d JOIN conversations c ON c.id=d.conversation_id JOIN persons p ON p.id=c.person_id JOIN channel_identities ci ON ci.id=c.channel_identity_id WHERE d.run_id=? AND d.status='pending' AND d.action IN ('reply','clarify','propose_call') AND c.mode='AUTOPILOT' AND c.ownership='AI_OWNED' AND p.suppressed=0 AND trim(p.permission)<>'' AND ci.channel='telegram' AND ci.account_id=? AND ci.external_id IN (${slots}) AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.direction='in') ORDER BY d.created_at`, runId, this.telegramAccount(), ...allowed);
  }
  approveAutopilot(draftId, runId) {
    const draft = this.draft(draftId);
    ensure(draft.run_id === runId, 'Черновик не принадлежит этому запуску', 409);
    ensure(draft.status === 'pending', 'Автономно отправляется только ожидающий черновик', 409);
    ensure(['reply','clarify','propose_call'].includes(draft.action), 'Действие требует участия владельца', 409);
    const { conversation } = this.active(draft.conversation_id, { permission: true });
    ensure(conversation.mode === 'AUTOPILOT', 'Автопилот выключен для разговора', 409);
    ensure(this.autopilotCandidates(runId).some(candidate => candidate.id === draft.id), 'Разговор не отвечает условиям автономной отправки', 409);
    this.store.run('INSERT INTO approvals VALUES(?,?,?,?,?,?)', id(), draft.id, draft.current_version, conversation.revision, 'autopilot', now());
    this.store.run("UPDATE drafts SET status='approved' WHERE id=?", draft.id);
    this.store.event(this.config.partnerId, conversation.id, 'autopilot.approved', 'system', {
      draft_id: draft.id, draft_version: draft.current_version, run_id: runId,
      model: this.config.runtime.model, conversation_revision: conversation.revision,
      model_text: draft.text
    });
    return { draft_id: draft.id, status: 'approved' };
  }
  autopilotHandoff(runId) {
    const draft = this.store.get("SELECT d.*,c.mode,c.ownership,p.suppressed FROM drafts d JOIN conversations c ON c.id=d.conversation_id JOIN persons p ON p.id=c.person_id WHERE d.run_id=? AND d.status='pending' AND d.action='handoff' LIMIT 1", runId);
    if (!draft || draft.mode !== 'AUTOPILOT' || draft.ownership !== 'AI_OWNED' || draft.suppressed) return null;
    this.store.run("UPDATE conversations SET ownership='HUMAN_OWNED',revision=revision+1 WHERE id=?", draft.conversation_id);
    this.store.run("UPDATE drafts SET status='stale' WHERE conversation_id=? AND status IN ('pending','approved','sending')", draft.conversation_id);
    this.store.run("UPDATE tasks SET status='cancelled' WHERE conversation_id=? AND status IN ('pending','proposed','running','interrupted')", draft.conversation_id);
    this.store.event(this.config.partnerId, draft.conversation_id, 'conversation.handoff_required', 'system', {
      draft_id: draft.id, draft_version: draft.current_version, run_id: runId,
      model: this.config.runtime.model, conversation_revision: draft.context_revision,
      model_text: draft.text
    });
    return draft;
  }
  setTelegramAccount(accountId) { this.telegramAccountId = accountId ? String(accountId) : null; }
  telegramAccount() { return this.telegramAccountId || process.env.PARTNER_TELEGRAM_ACCOUNT_ID || process.env.PARTNER_TELEGRAM_BOT_TOKEN?.split(':')[0] || 'unconfigured'; }
  opportunityCapture(captureId) { return opportunityCapture(this, captureId); }
  opportunityDetail(taskId) { return opportunityReviewDetail(this, taskId); }
  opportunityReviews(options) { return opportunityReviews(this, options); }
  detail(conversationId) {
    const conversation = this.conversation(conversationId), person = this.person(conversation.person_id);
    return { conversation, person,
      messages: this.store.all('SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at,rowid', conversationId),
      facts: this.store.all('SELECT * FROM facts WHERE person_id=? ORDER BY created_at DESC', person.id),
      drafts: this.store.all('SELECT * FROM drafts WHERE conversation_id=? ORDER BY created_at DESC', conversationId).map(d => ({ ...d, versions: this.store.all('SELECT * FROM draft_versions WHERE draft_id=? ORDER BY version', d.id), attempts: this.store.all('SELECT * FROM delivery_attempts WHERE draft_id=? ORDER BY created_at', d.id) })),
      outcomes: this.store.all('SELECT * FROM outcome_events WHERE conversation_id=? ORDER BY created_at DESC', conversationId),
      events: this.store.all('SELECT * FROM events WHERE conversation_id=? ORDER BY id DESC LIMIT 100', conversationId).map(e => ({ ...e, payload: JSON.parse(e.payload_json) })) };
  }
  snapshot() {
    const partnerId = this.config.partnerId;
    return { partner: this.partner(),
      opportunity_captures: this.store.all("SELECT id,created_at,json_extract(payload_json,'$.snapshot.source.ref') AS source FROM events WHERE partner_id=? AND kind='opportunity.snapshot' AND actor='system' ORDER BY id DESC LIMIT 20", partnerId),
      conversations: this.store.all('SELECT c.*,p.name,p.source,p.permission,p.suppressed,(SELECT text FROM messages WHERE conversation_id=c.id ORDER BY created_at DESC,rowid DESC LIMIT 1) AS last_message,(SELECT COUNT(*) FROM drafts WHERE conversation_id=c.id AND status=\'pending\') AS pending_drafts FROM conversations c JOIN persons p ON p.id=c.person_id WHERE p.partner_id=? ORDER BY c.created_at DESC', partnerId),
      tasks: this.store.all('SELECT * FROM tasks WHERE partner_id=? ORDER BY due_at DESC LIMIT 300', partnerId),
      runs: this.store.all('SELECT id,task_id,conversation_id,status,runtime,model,error,input_tokens,output_tokens,estimated_cost_usd,cost_status,created_at,finished_at FROM runs WHERE partner_id=? ORDER BY created_at DESC LIMIT 100', partnerId),
      lessons: this.store.all('SELECT * FROM lessons WHERE partner_id=? ORDER BY created_at DESC LIMIT 200', partnerId),
      proposals: this.store.all('SELECT * FROM capability_proposals WHERE partner_id=? ORDER BY created_at DESC', partnerId),
      skills: this.store.all('SELECT s.* FROM skill_versions s JOIN capability_proposals p ON p.id=s.proposal_id WHERE p.partner_id=? ORDER BY s.created_at DESC', partnerId),
      metrics: this.metrics(), events: this.store.all('SELECT id,kind,actor,created_at FROM events WHERE partner_id=? ORDER BY id DESC LIMIT 30', partnerId) };
  }
  metrics() {
    const counts = Object.fromEntries(this.store.all('SELECT kind,COUNT(DISTINCT person_id) AS n FROM outcome_events GROUP BY kind').map(x => [x.kind,x.n]));
    const usage = this.store.get('SELECT COUNT(*) AS runs,COALESCE(SUM(estimated_cost_usd),0) AS known_cost_usd,SUM(CASE WHEN cost_status=\'unknown\' THEN 1 ELSE 0 END) AS unknown_cost_runs FROM runs');
    const totalSent = this.store.get("SELECT COUNT(*) AS n FROM drafts WHERE status='sent'").n;
    const editedSent = this.store.get("SELECT COUNT(*) AS n FROM drafts WHERE status='sent' AND current_version>1").n;
    return { ...counts, ...usage, total_sent: totalSent, edited_sent: editedSent, edit_rate: totalSent ? editedSent / totalSent : null,
      cost_per_qualified: !usage.unknown_cost_runs && counts.qualified ? usage.known_cost_usd / counts.qualified : null,
      cost_per_joined: !usage.unknown_cost_runs && counts.joined ? usage.known_cost_usd / counts.joined : null,
      cost_scope: 'Model costs only; operator time and infrastructure are not yet measured.' };
  }
}
