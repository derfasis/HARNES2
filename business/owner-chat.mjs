// Owner chat: the owner talks to his partner in Hermes' own Telegram gateway
// (adapters/hermes/owner_gateway). Hermes carries the conversation, its sessions and its long-term
// memory; none of that is rebuilt here.
//
// This file is only the door from that conversation into the partner's durable work. One turn of
// the chat is admitted as one run of the partner's own, so what he writes in his notebook or
// schedules for himself while talking to the owner passes the same gates as his desk work - the
// control plane, the stop-list, the daily allowance - and is kept as a run the owner can open.
//
// The gateway opens and closes a turn (a Hermes plugin calls /internal/chat/turn). A turn that only
// talks admits nothing: the run and its ticket appear with the first write and are released when
// the turn ends, when its writing window runs out, or when the gateway abandons it. An outcome
// reported by the owner arrives as a new message, therefore in a new turn and a new run, which is
// what keeps "a result cannot be recorded in the run that opened the expectation" true in chat.
import path from 'node:path';
import { ROOT, readJson } from './config.mjs';
import { loadPartnerKnowledge } from './knowledge.mjs';
import { AppError, ensure, now, requiredText } from './errors.mjs';
import { hash, id } from './store.mjs';

export const OWNER_CHAT_RUNTIME = 'owner-chat';
// What the chat may do without a run: look. Everything else is a write and needs the turn's run.
const READS = new Set(['partner_get_context', 'partner_list_work', 'partner_search_experience']);
const DESK = "partner_id=? AND conversation_id IS NULL AND kind NOT IN ('opportunity_review','discovery_review','owner_action')";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const refuse = (message, status, code) => { throw new AppError(message, status, code); };
const flat = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
// A section carries a marker with the hash of its text. The gateway repeats a section only when
// that marker is no longer in the conversation: after a change, a new session or a compaction.
const section = (key, text) => {
  const sha256 = hash(text), marker = `[рабочий стол · ${key} · ${sha256.slice(0, 12)}]`;
  return { key, sha256, marker, text: `${marker}\n${text}` };
};

export class OwnerChat {
  constructor(service, { turnMs = 15 * 60000, waitMs = 45000, pollMs = 1500, windowMs = null } = {}) {
    this.service = service; this.turnMs = turnMs; this.waitMs = waitMs; this.pollMs = pollMs; this.maxWindowMs = windowMs;
    this.turn = null; this.stopped = false;
  }
  isRead(name) { return READS.has(name); }
  status() { return { turn_open: Boolean(this.turn), writing: Boolean(this.turn?.run), run_id: this.turn?.run?.id ?? null }; }
  // How long a turn may keep writing once it started: never longer than its control ticket lives.
  windowMs() {
    const byTicket = this.service.control.enabled ? Math.max(1000, this.service.control.ttl - 15000) : this.turnMs;
    return this.maxWindowMs === null ? byTicket : Math.min(byTicket, this.maxWindowMs);
  }

  // What the partner needs in front of him when the owner writes: his own notebook, and where
  // the work stands. Facts of the offer are not copied here; he reads them with partner_get_context.
  sections() {
    const out = [], notebook = this.service.notebook.digest({ conversation: false });
    if (notebook) out.push(section('тетрадь', notebook.content));
    out.push(section('обстановка', this.situation()));
    return out;
  }
  situation() {
    const store = this.service.store, partnerId = this.service.config.partnerId;
    const profile = readJson(path.join(ROOT, 'partner/profile.json'));
    const pack = loadPartnerKnowledge({ audience: 'planning' }).find(item => item.id === profile.activeOffer);
    const lines = ['# Где мы сейчас', '', `Активное предложение: ${profile.activeOffer}${pack?.version ? `, версия материалов ${pack.version}` : ''}.`];
    const spec = pack?.owner_specification;
    if (spec?.status === 'available_for_planning') lines.push(`Материалы владельца по нему действуют до ${spec.review_after}. После этого срока условий у тебя не будет, пока владелец не даст актуальные: напомни ему заранее.`);
    else if (spec) lines.push(`Материалы владельца по нему сейчас недоступны (${spec.reason}). Условий у тебя нет: не называй их по памяти и попроси у владельца актуальные.`);
    const open = store.all(`SELECT title FROM tasks WHERE ${DESK} AND status IN ('pending','running','interrupted') ORDER BY due_at LIMIT 8`, partnerId);
    const waiting = store.get(`SELECT COUNT(*) AS n FROM tasks WHERE ${DESK} AND status='proposed'`, partnerId).n;
    lines.push(open.length ? `За столом в работе: ${open.map(task => `«${flat(task.title, 90)}»`).join('; ')}.` : 'За столом сейчас нет задач в работе.');
    if (waiting) lines.push(`Ждут решения владельца: ${waiting}.`);
    // What the desk finished lately, in the partner's own words, so that in chat he can say what
    // came of the work he set himself instead of guessing.
    const done = store.all(`SELECT t.title,r.status,r.result_json FROM runs r JOIN tasks t ON t.id=r.task_id
      WHERE r.partner_id=? AND r.conversation_id IS NULL AND r.runtime='hermes' AND r.status IN ('completed','failed') AND r.finished_at>=?
      ORDER BY r.finished_at DESC LIMIT 3`, partnerId, new Date(Date.now() - 3 * 86400000).toISOString());
    if (done.length) lines.push('', 'Недавно сделано за столом:', ...done.map(run => {
      let note = '';
      try { note = flat(JSON.parse(run.result_json ?? '{}').final_response, 280); } catch { /* an unreadable result is shown as no note */ }
      return `- «${flat(run.title, 90)}» — ${run.status === 'completed' ? (note || 'готово, заметки нет') : 'запуск не удался'}`;
    }));
    lines.push('', 'Подробности смотри сам: partner_get_context (материалы, контакты, уроки) и partner_list_work (задачи).');
    return lines.join('\n');
  }

  // What the machine around him can do and what is switched on, so that in chat he plans with
  // the real tools instead of guessing. Read through partner_get_context; nothing here is a secret.
  system() {
    const cfg = this.service.config, store = this.service.store;
    return {
      capabilities: readJson(path.join(ROOT, 'partner/capabilities.json')).map(({ id, name, status, effect }) => ({ id, name, status, effect })),
      switches: { desk_runs: cfg.runtime.enabled === true, own_tasks_per_day: cfg.autonomy?.maxOwnTasksPerDay ?? 0,
        telegram_account_reading: cfg.telegram.enabled === true, telegram_sending_from_service: cfg.telegram.liveSending === true,
        public_sources_read: (cfg.opportunity.telegramSources?.length ?? 0) + (cfg.opportunity.browserSources?.length ?? 0),
        inbound_review: cfg.opportunity.automatic === true, discovery: cfg.discovery?.enabled === true,
        audience_research: cfg.audience?.enabled === true, source_scout: cfg.scout?.enabled === true },
      counts: { people: store.get('SELECT COUNT(*) AS n FROM persons WHERE partner_id=?', cfg.partnerId).n,
        tasks_waiting_for_owner: store.get(`SELECT COUNT(*) AS n FROM tasks WHERE partner_id=? AND status='proposed'`, cfg.partnerId).n },
      note: 'Сервис читает разрешённые чаты и готовит черновики; сам он людям не отправляет (telegram_sending_from_service). Твои руки вовне — твой браузер и аккаунты, в которые владелец в нём вошёл. Выключенное включает владелец: скажи ему, что нужно и зачем.',
    };
  }

  async begin(p = {}) {
    ensure(!this.stopped, 'Приложение завершает работу', 503);
    const turnId = requiredText(p.turn_id, 'turn_id', 150);
    // A turn that was never closed is over the moment the next one begins.
    if (this.turn && this.turn.id !== turnId) await this.finish(this.turn, 'interrupted');
    if (!this.turn) {
      const turn = { id: turnId, sessionId: typeof p.session_id === 'string' ? p.session_id.slice(0, 200) : '', openedAt: now(),
        deadline: Date.now() + this.turnMs, run: null, admitting: null, held: null, release: null, closed: false, windowClosed: false, outcome: null };
      turn.timer = setTimeout(() => { void this.finish(turn, 'interrupted'); }, this.turnMs); turn.timer.unref?.();
      this.turn = turn;
    }
    return { turn_id: turnId, sections: this.sections() };
  }
  async end(p = {}) {
    const turnId = requiredText(p.turn_id, 'turn_id', 150);
    const turn = this.turn?.id === turnId ? this.turn : null, runId = turn?.run?.id ?? null;
    if (turn) await this.finish(turn, 'completed');
    return { turn_id: turnId, closed: Boolean(turn), run_id: runId };
  }
  async finish(turn, outcome) {
    if (!turn.closed) {
      turn.closed = true; turn.outcome = outcome; clearTimeout(turn.timer);
      if (this.turn === turn) this.turn = null;
      turn.release?.(outcome);
    }
    try { await turn.admitting; } catch { /* the write that asked for the run already has the error */ }
    await turn.held;
  }
  async close() { this.stopped = true; if (this.turn) await this.finish(this.turn, 'interrupted'); }

  // The scope a write runs under. The first write of a turn admits the run; the rest share it.
  async writeScope() {
    const turn = this.turn;
    if (!turn || turn.closed || Date.now() >= turn.deadline) refuse('Записывать в тетрадь и ставить себе задачи можно только во время хода в чате с владельцем. Сейчас ход не открыт.', 403, 'OWNER_CHAT_TURN_REQUIRED');
    if (!turn.run && !turn.windowClosed) {
      // A refused admission is forgotten, so a later write of the same turn may try again.
      turn.admitting ??= this.admit(turn).catch(error => { turn.admitting = null; throw error; });
      await turn.admitting;
    }
    if (turn.windowClosed) refuse('Время на записи в этом ходе вышло. Скажи владельцу, что запишешь это в ответ на его следующее сообщение.', 409, 'OWNER_CHAT_WINDOW_CLOSED');
    if (!turn.run || turn.closed) refuse('Ход в чате уже закрыт.', 409, 'OWNER_CHAT_TURN_CLOSED');
    return turn.run.scope;
  }
  // Desk runs and chat turns share the private plane, one at a time. A desk run is short, so the
  // chat waits for it a little rather than telling the owner "later".
  async admit(turn) {
    const cfg = this.service.config, until = Date.now() + this.waitMs;
    // Without the control plane nothing else counts the day's runs for a chat turn.
    if (!this.service.control.enabled) {
      const today = this.service.store.get('SELECT COUNT(*) AS n FROM runs WHERE partner_id=? AND created_at>=?', cfg.partnerId, now().slice(0, 10)).n;
      if (today >= cfg.runtime.maxRunsPerDay) refuse('Дневной лимит запусков исчерпан: запись сегодня недоступна. Скажи об этом владельцу и не называй запись сделанной.', 409, 'OWNER_CHAT_RUN_BUDGET');
    }
    for (;;) {
      let bind; const bound = new Promise(resolve => { bind = resolve; });
      const held = this.service.control.run('private', 'owner_chat', () => this.hold(turn, bind));
      const first = await Promise.race([bound, held.then(result => ({ refused: result?.disposition ?? 'OWNER_CHAT_TURN_CLOSED' }))]);
      if (!first.refused) { turn.held = held.catch(() => {}); return; }
      if (turn.closed) refuse('Ход в чате уже закрыт.', 409, 'OWNER_CHAT_TURN_CLOSED');
      if (first.refused !== 'CONTROL_CAPACITY') refuse(`Запись сейчас недоступна (${first.refused}). Скажи об этом владельцу и не называй запись сделанной.`, 409, first.refused);
      if (Date.now() + this.pollMs >= until) refuse('Сейчас идёт твой рабочий запуск за столом, и он ещё не закончился. Повтори запись чуть позже в этом же ходе или скажи владельцу, что запишешь следующим сообщением.', 409, 'OWNER_CHAT_BUSY');
      await wait(this.pollMs);
    }
  }
  async hold(turn, bind) {
    const store = this.service.store, cfg = this.service.config;
    const scope = await this.service.exclusive(() => store.transaction(() => {
      if (turn.closed) return null;
      const runId = id();
      // The model call of a chat turn is made by the gateway, not by this service. What it cost is
      // not known here and is not this service's spending, so the run is marked `external`: it is
      // never shown as a known zero, and it does not stand in the desk's way as an unpaid bill.
      store.run('INSERT INTO runs(id,partner_id,task_id,conversation_id,status,runtime,model,context_json,cost_status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        runId, cfg.partnerId, null, null, 'running', OWNER_CHAT_RUNTIME, cfg.runtime.model || 'hermes-gateway',
        JSON.stringify({ schema_version: 1, origin: 'owner_chat', turn_id: turn.id, session_id: turn.sessionId, opened_at: turn.openedAt }), 'external', now());
      this.service.control.bindRun(runId);
      store.event(cfg.partnerId, null, 'run.started', 'system', { run_id: runId, origin: 'owner_chat' });
      const ticket = this.service.control.ticket(runId);
      return { kind: 'agent', runId, conversationId: null, ...(ticket ? { controlTicketId: ticket.id } : {}) };
    }));
    if (!scope) return;
    turn.run = { id: scope.runId, scope };
    const outcome = turn.closed ? turn.outcome : await new Promise(resolve => {
      turn.release = resolve;
      turn.window = setTimeout(() => { turn.windowClosed = true; resolve('completed'); }, this.windowMs()); turn.window.unref?.();
      bind(scope);
    });
    clearTimeout(turn.window);
    await this.service.exclusive(() => store.transaction(() => {
      const status = outcome === 'completed' ? 'completed' : 'interrupted';
      const writes = store.get('SELECT COUNT(*) AS n FROM tool_calls WHERE run_id=?', scope.runId).n;
      const changed = store.run("UPDATE runs SET status=?,result_json=?,error=?,finished_at=? WHERE id=? AND status='running'", status,
        JSON.stringify({ completed: status === 'completed', origin: 'owner_chat', turn_id: turn.id, tool_calls: writes,
          final_response: `Ход в чате с владельцем. Записей в тетрадь и своих задач за ход: ${writes}. Сам разговор хранит Hermes, здесь только то, что партнёр записал.` }),
        status === 'completed' ? null : 'Ход в чате не был закрыт шлюзом', now(), scope.runId);
      if (changed.changes) store.event(cfg.partnerId, null, `run.${status}`, 'system', { run_id: scope.runId, origin: 'owner_chat', cost_status: 'external' });
    }));
  }
}
