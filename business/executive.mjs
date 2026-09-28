import path from 'node:path';
import Ajv from 'ajv';
import { ROOT, readJson } from './config.mjs';
import { id } from './store.mjs';
import { ensure, requiredText, dateTime, now, AppError } from './errors.mjs';
import { automaticBoundary, digest, sourceRows, sourceTransportKind, sourceEvent } from './source-ingestion.mjs';
import { importOpenOutFind } from './executive-donors.mjs';

export const planSchema = readJson(path.join(ROOT, 'contracts/executive-plan.schema.json'));
const validatePlan = new Ajv({ strict: true }).compile(planSchema);
export const EXECUTIVE_VERSION = '1.0.0';
const ACTIVE = ['plan_requested', 'planning', 'proposed', 'waiting_sources', 'ready', 'reasoning', 'brief_proposed'];
const CURSOR = 'partner-executive-maintenance-v1';
const check = (ok, code, status = 409) => ensure(ok, code, status, code);
const fields = (p, names) => check(p && typeof p === 'object' && !Array.isArray(p)
  && Object.keys(p).every(k => names.includes(k)), 'EXECUTIVE_FIELDS_INVALID', 400);
const parse = JSON.parse;
const effects = { contact_permission: false, external_write: false };
const selectedEvidence = d => [...new Map([...d.evidence, ...d.memory_evidence].map(e => [e.source_event_id, e])).values()];

export class ExecutiveLoop {
  constructor(service) { this.service = service; this.db = service.store; }
  get partnerId() { return this.service.config.partnerId; }
  get continuity() { return this.service.continuity; }
  enabled() {
    check(this.service.config.executive?.enabled === true && this.service.config.continuity?.enabled === true, 'EXECUTIVE_DISABLED');
    automaticBoundary(this.service);
  }
  get(intentId) {
    const row = this.db.get('SELECT * FROM research_intents WHERE id=? AND partner_id=?', intentId, this.partnerId);
    check(row, 'EXECUTIVE_NOT_FOUND', 404); return row;
  }
  record(kind, p) { this.db.event(this.partnerId, null, `executive.${kind}`, 'system', p); }
  update(row, patch) {
    this.db.run(`UPDATE research_intents SET ${Object.keys(patch).map(k => `${k}=?`).join(',')},revision=revision+1,updated_at=? WHERE id=?`,
      ...Object.values(patch), now(), row.id);
  }
  // Evidence revisions are deliberately absent. A research refresh changes them.
  authority(threadId) {
    automaticBoundary(this.service);
    const t = this.continuity.thread(threadId), watches = this.continuity.watches(threadId);
    check(t.status === 'OPEN' && t.pause_reason === null && t.business_basis === this.continuity.businessBasis(), 'EXECUTIVE_AUTHORITY_CHANGED');
    for (const w of watches) check(w.status === 'active'
      && this.service.config.opportunity.allowedSourceRefs.includes(w.source_ref)
      && this.continuity.policyHash(w.source_ref) === w.policy_hash, 'EXECUTIVE_SOURCE_REVOKED');
    const control = this.db.get(`SELECT COALESCE(MAX(id),0) n FROM events WHERE partner_id=? AND actor='operator' AND
      (kind='partner.update' OR (kind IN ('continuity.owner_note','continuity.status') AND payload_json->>'$.thread_id'=?))`, this.partnerId, threadId).n;
    return digest({ thread: t.id, objective: t.objective, success: t.success_condition, business: t.business_basis,
      max_age_seconds: t.max_age_seconds, control, watches: watches.map(w => [w.source_ref, w.policy_hash]), version: EXECUTIVE_VERSION });
  }
  assertAuthority(row) { check(this.authority(row.thread_id) === row.authority_hash, 'EXECUTIVE_AUTHORITY_CHANGED'); }
  assertBasis(row) {
    this.assertAuthority(row);
    const d = this.continuity.detail(row.thread_id);
    check(d.ready && d.basis_fingerprint === row.proposal_basis_fingerprint, 'EXECUTIVE_STALE_BASIS');
    return d;
  }
  current(row, { packet = false, enabled = true } = {}) {
    if (enabled) this.enabled();
    this.assertAuthority(row);
    check(!row.deadline || Date.parse(row.deadline) > Date.now(), 'EXECUTIVE_DEADLINE');
    if (packet) {
      const p = row.packet_json ? parse(row.packet_json) : null;
      const d = this.continuity.detail(row.thread_id);
      check(p && d.ready && p.basis_fingerprint === d.basis_fingerprint, 'EXECUTIVE_STALE_BASIS');
      const states = this.continuity.evidenceStates(this.continuity.thread(row.thread_id), this.continuity.watches(row.thread_id), p.evidence.map(e => e.source_event_id));
      check(p.evidence.every(e => states.get(e.source_event_id)?.current), 'EXECUTIVE_STALE_EVIDENCE');
    }
  }
  attempt(row, capability, slot, status = 'pending', runId = null, receipt = null) {
    const attemptId = id();
    this.db.run(`INSERT INTO research_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?)`, attemptId, row.id, capability, EXECUTIVE_VERSION,
      slot, status, row.grant_version, runId, receipt === null ? null : JSON.stringify(receipt), now(), status === 'succeeded' ? now() : null);
    return attemptId;
  }
  terminate(row, status, reason) {
    this.update(row, { status, reason });
    this.db.run("UPDATE research_attempts SET status='cancelled',finished_at=? WHERE intent_id=? AND status='pending'", now(), row.id);
    if (row.turn_id) this.db.run("UPDATE partner_turns SET status='stale' WHERE id=? AND status IN ('captured','proposed')", row.turn_id);
    this.record('retired', { intent_id: row.id, status, reason });
  }
  planPacket(d) {
    return { thread_id: d.id, objective: d.objective, success_condition: d.success_condition,
      evidence: selectedEvidence(d).slice(0, 32), memory: d.memory, owner_notes: d.operator_notes,
      coverage: d.coverage, basis_fingerprint: d.basis_fingerprint,
      refreshable_sources: d.watches.filter(w => w.health.current && sourceTransportKind(this.service, w.source_ref) === 'browser').map(w => w.source_ref) };
  }
  applyPlan(row, output) {
    check(Buffer.byteLength(JSON.stringify(output ?? null)) <= 20000 && validatePlan(output), 'EXECUTIVE_PLAN_INVALID', 400);
    check((output.kind === 'research') === (output.plan !== null), 'EXECUTIVE_PLAN_INVALID', 400);
    if (output.kind === 'no_research') { this.update(row, { status: 'no_research', reason: output.reason }); return; }
    const d = this.assertBasis(row), packet = this.planPacket(d), plan = output.plan;
    const evidence = new Map(packet.evidence.map(e => [e.source_event_id, e]));
    check(plan.evidence_event_ids.every(ref => evidence.has(ref)), 'EXECUTIVE_EVIDENCE_SCOPE', 400);
    const chosen = plan.evidence_event_ids.map(ref => evidence.get(ref));
    check(plan.refresh_source_ids.every(ref => packet.refreshable_sources.includes(ref) && chosen.some(e => e.source_ref === ref)), 'EXECUTIVE_REFRESH_SCOPE', 400);
    this.update(row, { status: 'proposed', question: plan.question, decision_to_inform: plan.decision_to_inform,
      completion_criterion: plan.completion_criterion,
      selection_json: JSON.stringify(chosen.map(e => ({ source_ref: e.source_ref, message_id: e.message_id, source_event_id: e.source_event_id }))),
      refresh_sources_json: JSON.stringify(plan.refresh_source_ids), reason: output.reason });
  }
  create(p, planning = false, planKey = null) {
    this.enabled(); fields(p, ['thread_id', 'expected_basis_fingerprint', ...(planning ? [] : ['plan'])]);
    const d = this.continuity.detail(p.thread_id);
    check(d.ready && d.basis_fingerprint === p.expected_basis_fingerprint, 'EXECUTIVE_STALE_BASIS');
    check(!this.db.get("SELECT id FROM partner_turns WHERE thread_id=? AND status IN ('captured','running','proposed')", d.id), 'EXECUTIVE_CONTINUITY_REVIEW_REQUIRED');
    check(!this.db.get('SELECT id FROM research_intents WHERE thread_id=? AND status IN (SELECT value FROM json_each(?))', d.id, JSON.stringify(ACTIVE)), 'EXECUTIVE_ALREADY_ACTIVE');
    check(this.db.get('SELECT COUNT(*) n FROM research_intents WHERE partner_id=? AND status IN (SELECT value FROM json_each(?))', this.partnerId, JSON.stringify(ACTIVE)).n < 100, 'EXECUTIVE_CAPACITY');
    const intentId = id(), packet = this.planPacket(d);
    this.db.run(`INSERT INTO research_intents(id,partner_id,thread_id,motivating_turn_id,plan_key,selection_json,refresh_sources_json,
      authority_hash,proposal_basis_fingerprint,plan_packet_json,status,producer,created_at,updated_at)
      VALUES(?,?,?,?,?,'[]','[]',?,?,?,?,?,?,?)`, intentId, this.partnerId, d.id, d.memory?.turn_id ?? null, planKey,
      this.authority(d.id), d.basis_fingerprint, JSON.stringify(packet), planning ? 'plan_requested' : 'proposed', planning ? 'model' : 'operator', now(), now());
    if (!planning) this.applyPlan(this.get(intentId), { kind: 'research', reason: 'Owner research proposal', plan: p.plan });
    else this.attempt(this.get(intentId), 'research.plan', 'plan');
    this.record('created', { intent_id: intentId, thread_id: d.id, planning });
    return { intent_id: intentId, ...effects };
  }
  authorize(p) {
    this.enabled(); fields(p, ['intent_id', 'expected_revision', 'expected_basis_fingerprint', 'allow_model', 'deadline']);
    const row = this.get(p.intent_id);
    check(row.status === 'proposed' && row.revision === p.expected_revision, 'EXECUTIVE_REVISION_CONFLICT');
    check(row.proposal_basis_fingerprint === p.expected_basis_fingerprint, 'EXECUTIVE_STALE_BASIS'); this.assertBasis(row);
    check(typeof p.allow_model === 'boolean', 'EXECUTIVE_GRANT_INVALID', 400);
    const deadline = dateTime(p.deadline), delta = Date.parse(deadline) - Date.now();
    check(delta >= 1000 && delta <= 86400000, 'EXECUTIVE_DEADLINE_INVALID', 400);
    this.update(row, { status: 'waiting_sources', grant_version: row.grant_version + 1, authorized_at: now(),
      deadline, allow_model: Number(p.allow_model), reason: null });
    const granted = this.get(row.id);
    for (const sourceRef of parse(row.refresh_sources_json)) this.attempt(granted, 'research.refresh_source', `refresh:${sourceRef}`);
    this.attempt(granted, 'research.read_evidence', 'evidence');
    this.attempt(granted, 'research.submit_brief', 'brief');
    this.record('authorized', { intent_id: row.id, grant_version: granted.grant_version, allow_model: p.allow_model, deadline,
      max_refresh_reads: parse(row.refresh_sources_json).length, max_brief_model_runs: p.allow_model ? 1 : 0 });
    return { intent_id: row.id, ...effects };
  }
  // Only Scheduler calls these hooks around an already-due, trusted Browser poll.
  beginPoll(sourceRef) {
    if (this.service.config.executive?.enabled !== true) return [];
    const rows = this.db.all(`SELECT a.id AS attempt_id,i.* FROM research_attempts a JOIN research_intents i ON i.id=a.intent_id
      WHERE i.partner_id=? AND i.status='waiting_sources' AND a.capability_id='research.refresh_source'
      AND a.slot=? AND a.status='pending' ORDER BY i.created_at,i.id LIMIT 100`, this.partnerId, `refresh:${sourceRef}`);
    const started = [];
    for (const row of rows) {
      try { this.current(row); }
      catch (e) { if (!(e instanceof AppError)) throw e; this.terminate(row, 'superseded', e.code); continue; }
      this.db.run("UPDATE research_attempts SET status='running' WHERE id=?", row.attempt_id);
      started.push(row.attempt_id);
    }
    return started;
  }
  finishPoll(attemptIds, result, failed = false) {
    for (const aid of attemptIds) {
      const a = this.db.get("SELECT * FROM research_attempts WHERE id=? AND status='running'", aid); if (!a) continue;
      const row = this.get(a.intent_id); let reason = failed ? 'SOURCE_READ_FAILED' : null;
      try {
        this.current(row); check(row.status === 'waiting_sources', 'EXECUTIVE_CANCELLED');
        if (!failed) check(sourceEvent(this.service, String(result?.source_event_id ?? '')).message.source_id === a.slot.slice(8), 'EXECUTIVE_REFRESH_RECEIPT');
      }
      catch (e) { if (!(e instanceof AppError)) throw e; reason = e.code; }
      const receipt = { outcome: reason ? 'blocked' : result?.disposition === 'duplicate' ? 'no_new_evidence' : 'evidence_added',
        source_event_id: reason ? null : String(result?.source_event_id ?? ''), reason,
        authority_hash: row.authority_hash, grant_version: a.grant_version };
      this.db.run('UPDATE research_attempts SET status=?,receipt_json=?,finished_at=? WHERE id=?', reason ? 'failed' : 'succeeded', JSON.stringify(receipt), now(), aid);
      if (reason && ACTIVE.includes(row.status)) this.terminate(row, 'failed', reason);
    }
  }
  // Retire attempts whose receipt could not be written. The poll itself already happened and its
  // source truth is durable; what is missing is the proof that ties that truth to this intent, so
  // the attempt ends unproven rather than running. `interrupted_unknown` is the same state a crash
  // mid-receipt leaves, deliberately: an operator must be able to tell "we know it failed" from
  // "we never found out", and neither may be presented as a completed refresh.
  abandonPoll(attemptIds, reason = 'RECEIPT_PERSIST_FAILED') {
    for (const aid of attemptIds) {
      const a = this.db.get("SELECT * FROM research_attempts WHERE id=? AND status='running'", aid);
      if (!a) continue;
      this.db.run("UPDATE research_attempts SET status='interrupted_unknown',receipt_json=?,finished_at=? WHERE id=?",
        JSON.stringify({ outcome: 'unknown', reason, attempt_id: aid }), now(), aid);
      const row = this.db.get('SELECT * FROM research_intents WHERE id=?', a.intent_id);
      if (row && ACTIVE.includes(row.status))
        this.terminate(row, 'failed', reason);
    }
  }
  captureEvidence(row) {
    this.current(row);
    const refresh = this.db.all("SELECT * FROM research_attempts WHERE intent_id=? AND capability_id='research.refresh_source'", row.id);
    if (refresh.some(a => a.status === 'pending' || a.status === 'running')) return;
    if (refresh.some(a => a.status !== 'succeeded')) { this.terminate(row, 'failed', 'EXECUTIVE_REFRESH_INCOMPLETE'); return; }
    const d = this.continuity.detail(row.thread_id); if (d.backlog) return;
    if (this.db.get("SELECT id FROM partner_turns WHERE thread_id=? AND status IN ('captured','running','proposed')", row.thread_id)) return;
    const selection = parse(row.selection_json), currentIds = [];
    for (const s of selection) {
      const latest = sourceRows(this.service, s.source_ref, [s.message_id])[0];
      if (!latest || latest.message.operation !== 'upsert') { this.terminate(row, 'superseded', 'EXECUTIVE_EVIDENCE_MISSING'); return; }
      currentIds.push(latest.event_id);
    }
    const states = this.continuity.evidenceStates(this.continuity.thread(row.thread_id), this.continuity.watches(row.thread_id), currentIds);
    if (!d.ready || currentIds.some(ref => !states.get(ref)?.current)) { this.terminate(row, 'superseded', 'EXECUTIVE_STALE_EVIDENCE'); return; }
    this.continuity.changed(this.continuity.thread(row.thread_id), ['research_result']);
    const fresh = this.continuity.detail(row.thread_id);
    const { turn_id: turnId } = this.continuity.capture({ thread_id: row.thread_id, expected_revision: fresh.revision, expected_basis_fingerprint: fresh.basis_fingerprint });
    const packet = { ...fresh, evidence: currentIds.map(ref => states.get(ref)), memory_evidence: [], memory: null,
      research: { intent_id: row.id, grant_version: row.grant_version, authority_hash: row.authority_hash,
        question: row.question, decision_to_inform: row.decision_to_inform, completion_criterion: row.completion_criterion },
      coverage: { selection: 'explicit_items_current_versions', selected_items: currentIds.length,
        history_expanded: false, exhaustive: false, truncated: currentIds.some(ref => states.get(ref)?.truncated) } };
    this.db.run('UPDATE partner_turns SET packet_json=? WHERE id=?', JSON.stringify(packet), turnId);
    this.update(row, { status: 'ready', turn_id: turnId, packet_json: JSON.stringify(packet) });
    this.db.run("UPDATE research_attempts SET status='succeeded',receipt_json=?,finished_at=? WHERE intent_id=? AND slot='evidence'",
      JSON.stringify({ outcome: 'evidence_read', source_event_ids: currentIds, authority_hash: row.authority_hash }), now(), row.id);
    this.record('evidence_read', { intent_id: row.id, turn_id: turnId, source_event_ids: currentIds });
  }
  assertTurnCurrent(turn) {
    const meta = turn.packet?.research ?? (turn.packet_json ? parse(turn.packet_json).research : null);
    if (!meta) return;
    const row = this.get(meta.intent_id);
    check(['ready', 'reasoning', 'brief_proposed'].includes(row.status) && row.turn_id === turn.id
      && row.grant_version === meta.grant_version && row.authority_hash === meta.authority_hash, 'EXECUTIVE_GRANT_UNAVAILABLE');
    this.current(row, { packet: true });
  }
  submit(row, output, producer = 'operator') {
    check(row.status === (producer === 'model' ? 'reasoning' : 'ready'), 'EXECUTIVE_NOT_READY');
    this.current(row, { packet: true });
    this.continuity.propose({ turn_id: row.turn_id, output }, producer);
    this.update(row, { status: 'brief_proposed' });
    this.db.run("UPDATE research_attempts SET status='succeeded',receipt_json=?,finished_at=? WHERE intent_id=? AND slot='brief'",
      JSON.stringify({ outcome: 'brief_proposed', turn_id: row.turn_id, producer }), now(), row.id);
    return { intent_id: row.id, turn_id: row.turn_id, ...effects };
  }
  command(action, p, actor) {
    check(actor?.kind === 'operator', 'EXECUTIVE_OPERATOR_REQUIRED', 403);
    if (action === 'executive.import_candidates') return importOpenOutFind(this.service, p);
    if (action === 'executive.propose') return this.create(p);
    if (action === 'executive.request_plan') { this.enabled(); check(this.service.config.executive.modelEnabled === true, 'EXECUTIVE_MODEL_DISABLED'); return this.create(p, true); }
    if (action === 'executive.authorize') return this.authorize(p);
    const row = this.get(p.intent_id); check(row.revision === p.expected_revision, 'EXECUTIVE_REVISION_CONFLICT');
    if (action === 'executive.cancel') {
      fields(p, ['intent_id', 'expected_revision', 'reason']); check(ACTIVE.includes(row.status), 'EXECUTIVE_TERMINAL');
      this.terminate(row, 'cancelled', requiredText(p.reason, 'reason', 2000)); return { intent_id: row.id, ...effects };
    }
    if (action === 'executive.submit_brief') { fields(p, ['intent_id', 'expected_revision', 'output']); this.enabled(); return this.submit(row, p.output); }
    fields(p, ['intent_id', 'expected_revision', 'decision', 'note']); check(row.turn_id, 'EXECUTIVE_NO_BRIEF');
    const turn = this.continuity.turn(row.turn_id);
    const result = this.continuity.review({ turn_id: turn.id, expected_basis_fingerprint: turn.basis_fingerprint, decision: p.decision, note: p.note });
    this.update(row, { status: p.decision === 'accept' ? 'completed' : 'rejected' }); return result;
  }
  detail(intentId) {
    const row = this.get(intentId), { plan_packet_json, packet_json, selection_json, refresh_sources_json, ...rest } = row;
    let usable = false, reason = null;
    try { this.current(row, { packet: !!packet_json });
      if (['proposed','plan_requested','planning'].includes(row.status)) this.assertBasis(row);
      usable = ACTIVE.includes(row.status); }
    catch (e) { if (!(e instanceof AppError)) throw e; reason = e.code; }
    return { ...rest, selection: parse(selection_json), refresh_source_ids: parse(refresh_sources_json),
      packet: usable && packet_json ? parse(packet_json) : null, current: usable, current_reason: reason,
      reviewable: usable && row.status === 'brief_proposed',
      attempts: this.db.all('SELECT * FROM research_attempts WHERE intent_id=? ORDER BY rowid', row.id).map(({ receipt_json, ...a }) => ({ ...a, receipt: receipt_json ? parse(receipt_json) : null })),
      limits: { refresh_reads: parse(refresh_sources_json).length, brief_model_runs: row.allow_model ? 1 : 0, plan_model_runs: row.producer === 'model' ? 1 : 0 }, ...effects };
  }
  list({ limit = 20, cursor = '', thread_id: threadId = null } = {}) {
    check(Number.isInteger(limit) && limit >= 1 && limit <= 50 && typeof cursor === 'string' && cursor.length <= 36, 'EXECUTIVE_PAGE_INVALID', 400);
    if (threadId !== null) this.continuity.thread(threadId);
    const items = this.db.all(`SELECT id,thread_id,question,status,revision,reason,created_at,updated_at FROM research_intents
      WHERE partner_id=? AND id>? ${threadId ? 'AND thread_id=?' : ''} ORDER BY id LIMIT ?`, this.partnerId, cursor, ...(threadId ? [threadId] : []), limit + 1);
    return { items: items.slice(0, limit), next_cursor: items.length > limit ? items[limit - 1].id : null,
      enabled: this.service.config.executive?.enabled === true, model_enabled: this.service.config.executive?.modelEnabled === true,
      refreshable_source_refs: (this.service.config.opportunity?.browserSources ?? []).filter(s => this.service.config.opportunity.allowedSourceRefs.includes(s.sourceId)).map(s => s.sourceId).slice(0, 100),
      capabilities: ['research.read_evidence','research.refresh_source','research.submit_brief'].map(capability_id => ({ capability_id, version: EXECUTIVE_VERSION, effect: 'read_and_propose' })), ...effects };
  }
  queueAutoPlan() {
    const cfg = this.service.config;
    if (cfg.executive?.enabled !== true || cfg.executive.modelEnabled !== true || cfg.executive.autoPlan !== true || cfg.continuity?.enabled !== true) return;
    if (this.db.get('SELECT COUNT(*) n FROM research_intents WHERE partner_id=? AND status IN (SELECT value FROM json_each(?))', this.partnerId, JSON.stringify(ACTIVE)).n >= 100) return;
    try { this.enabled(); } catch (e) { if (!(e instanceof AppError)) throw e; return; }
    const key = 'partner-executive-planning-v1';
    const cursor = this.db.get('SELECT cursor FROM channel_offsets WHERE channel=? AND account_id=?', key, this.partnerId)?.cursor ?? '';
    const page = (after, take, before = null) => this.db.all(`SELECT id,memory_turn_id FROM partner_threads p
      WHERE partner_id=? AND status='OPEN' AND attention=0 AND memory_turn_id IS NOT NULL AND id>?
      ${before ? 'AND id<=?' : ''} AND NOT EXISTS (SELECT 1 FROM research_intents r WHERE r.thread_id=p.id
        AND (r.plan_key='auto:'||p.memory_turn_id OR r.status IN (SELECT value FROM json_each(?)))) ORDER BY id LIMIT ?`,
      this.partnerId, after, ...(before ? [before] : []), JSON.stringify(ACTIVE), take);
    let rows = page(cursor, 10); if (cursor && rows.length < 10) rows = rows.concat(page('', 10 - rows.length, cursor));
    for (const r of rows) {
      this.db.run('INSERT INTO channel_offsets VALUES(?,?,?) ON CONFLICT(channel,account_id) DO UPDATE SET cursor=excluded.cursor', key, this.partnerId, r.id);
      const d = this.continuity.detail(r.id);
      if (!d.ready || !d.memory?.current) continue;
      try { this.create({ thread_id: r.id, expected_basis_fingerprint: d.basis_fingerprint }, true, `auto:${r.memory_turn_id}`); break; }
      catch (e) { if (!(e instanceof AppError)) throw e; }
    }
  }
  reconcile() {
    return this.db.transaction(() => {
      const cursor = this.db.get('SELECT cursor FROM channel_offsets WHERE channel=? AND account_id=?', CURSOR, this.partnerId)?.cursor ?? '';
      const page = (after, take, before = null) => this.db.all(`SELECT * FROM research_intents WHERE partner_id=? AND id>?
        AND status IN (SELECT value FROM json_each(?)) ${before ? 'AND id<=?' : ''} ORDER BY id LIMIT ?`, this.partnerId, after, JSON.stringify(ACTIVE), ...(before ? [before] : []), take);
      let rows = page(cursor, 20); if (cursor && rows.length < 20) rows = rows.concat(page('', 20 - rows.length, cursor));
      for (const row of rows) {
        const turn = row.turn_id ? this.db.get('SELECT status FROM partner_turns WHERE id=?', row.turn_id) : null;
        if (turn?.status === 'accepted' || turn?.status === 'rejected') { this.update(row, { status: turn.status === 'accepted' ? 'completed' : 'rejected' }); continue; }
        try {
          this.current(row, { packet: !!row.packet_json, enabled: false });
          if (['plan_requested', 'planning', 'proposed'].includes(row.status)) this.assertBasis(row);
          if (turn && ['stale', 'interrupted', 'failed'].includes(turn.status)) throw new AppError('Research turn unavailable', 409, 'EXECUTIVE_STALE_BASIS');
        } catch (e) {
          if (!(e instanceof AppError)) throw e;
          this.terminate(row, e.code === 'EXECUTIVE_DEADLINE' ? 'cancelled' : 'superseded', e.code); continue;
        }
        if (row.status === 'waiting_sources' && this.service.config.executive?.enabled === true && this.service.config.continuity?.enabled === true) this.captureEvidence(row);
      }
      if (rows.length) this.db.run('INSERT INTO channel_offsets VALUES(?,?,?) ON CONFLICT(channel,account_id) DO UPDATE SET cursor=excluded.cursor', CURSOR, this.partnerId, rows.at(-1).id);
      this.queueAutoPlan();
      return { intents: rows.length };
    });
  }
}
