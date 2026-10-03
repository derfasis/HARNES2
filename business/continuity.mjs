// Domain continuity only. SQLite and the existing Scheduler own persistence/execution.
import path from 'node:path';
import Ajv from 'ajv';
import { ROOT, readJson } from './config.mjs';
import { id } from './store.mjs';
import { ensure, requiredText, dateTime, now, AppError } from './errors.mjs';
import { sourceEvent, sourceRows, sourceAccessReadiness, sourceTransportKind, browserCheckpoint, digest } from './source-ingestion.mjs';
import { effectiveSourceConfig } from './scout-policy.mjs';

export const proposalSchema = readJson(path.join(ROOT, 'contracts/continuity-proposal.schema.json'));
const validate = new Ajv({ strict: true, allowUnionTypes: true }).compile(proposalSchema);
const check = (ok, code, status = 409) => ensure(ok, code, status, code);
const fields = (p, names) => check(p && typeof p === 'object' && !Array.isArray(p)
  && Object.keys(p).every(k => names.includes(k)), 'CONTINUITY_FIELDS_INVALID', 400);
const parse = JSON.parse;
const WINDOW = 8, MAX_SOURCES = 4;
const CURSOR = 'partner-continuity-sweep-v1';
const AUTHORITY = Object.freeze({ executable: false, contact_permission: false, allowed_effects: [] });
const refs = out => [...new Set([...(out?.summary.evidence_event_ids ?? []), ...(out?.claims ?? []).map(c => c.source_event_id),
  ...(out?.hypotheses ?? []).flatMap(h => [...h.evidence_event_ids, ...h.counterevidence_event_ids])])];

export class ContinuityLoop {
  constructor(service) { this.service = service; this.store = service.store; }
  get partnerId() { return this.service.config.partnerId; }
  enabled() { check(this.service.config.continuity?.enabled === true, 'CONTINUITY_DISABLED'); }
  businessBasis() { return digest({ mission: this.service.partner().mission,
    offer: this.service.config.opportunity?.activeOffer, goal: this.service.config.opportunity?.goalText }); }
  policyHash(sourceRef) {
    const cfg = effectiveSourceConfig(this.service).opportunity;
    const browser = cfg.browserSources?.find(p => p.sourceId === sourceRef);
    const telegram = cfg.telegramSources?.find(p => p.sourceId === sourceRef);
    const policy = browser ? { ...browser } : telegram ?? { sourceId: sourceRef, kind: 'fixture' };
    if (browser) delete policy.pollEverySeconds;
    return digest(policy);
  }
  health(watch) {
    if (watch.status === 'revoked') return { current: false, reason: watch.reason };
    if (this.policyHash(watch.source_ref) !== watch.policy_hash)
      return { current: false, reason: 'CONTINUITY_SOURCE_POLICY_CHANGED' };
    try { return sourceAccessReadiness(this.service, watch.source_ref); }
    catch { return { current: false, reason: 'CONTINUITY_SOURCE_UNAVAILABLE' }; }
  }
  thread(threadId) {
    const row = this.store.get('SELECT * FROM partner_threads WHERE id=? AND partner_id=?', threadId, this.partnerId);
    check(row, 'CONTINUITY_NOT_FOUND', 404); return row;
  }
  watches(threadId) { return this.store.all('SELECT * FROM partner_watches WHERE thread_id=? ORDER BY source_ref', threadId); }
  head(sourceRef) {
    return this.store.get("SELECT COALESCE(MAX(id),0) n FROM events WHERE partner_id=? AND kind='source.message' AND actor='system' AND payload_json->>'$.source_id'=?",
      this.partnerId, sourceRef).n;
  }
  record(kind, payload, actor = 'system') { this.store.event(this.partnerId, null, `continuity.${kind}`, actor, payload); }
  changed(row, reasons) {
    const combined = [...new Set([...parse(row.attention_reasons_json), ...reasons])];
    this.store.run('UPDATE partner_threads SET revision=revision+1,attention=1,attention_reasons_json=?,attention_at=?,updated_at=? WHERE id=?',
      JSON.stringify(combined), row.attention ? row.attention_at : now(), now(), row.id);
    this.store.run("UPDATE partner_turns SET status='stale' WHERE thread_id=? AND status IN ('captured','proposed')", row.id);
    this.record('attention', { thread_id: row.id, reasons, revision: row.revision + 1 });
  }
  observe(threadId, sourceRef, sourceId, origin) {
    const source = sourceEvent(this.service, String(sourceId));
    check(source.message.source_id === sourceRef, 'CONTINUITY_EVIDENCE_SCOPE');
    this.store.run(`INSERT INTO partner_observations VALUES(?,?,?,?,?)
      ON CONFLICT(thread_id,source_ref,message_id) DO UPDATE SET source_event_id=excluded.source_event_id,origin=excluded.origin`,
      threadId, sourceRef, source.message.message_id, Number(sourceId), origin);
    // A bounded working window, not deletion of canonical source history or episodes.
    this.store.run(`DELETE FROM partner_observations WHERE thread_id=? AND source_ref=? AND source_event_id NOT IN
      (SELECT source_event_id FROM partner_observations WHERE thread_id=? AND source_ref=? ORDER BY source_event_id DESC LIMIT ?)`,
      threadId, sourceRef, threadId, sourceRef, WINDOW);
  }
  evidenceStates(row, watches, ids) {
    const result = new Map();
    const events = this.store.all(`SELECT id,created_at,payload_json FROM events WHERE partner_id=? AND kind='source.message'
      AND actor='system' AND id IN (SELECT value FROM json_each(?)) ORDER BY id`, this.partnerId, JSON.stringify(ids));
    for (const watch of watches) {
      const selected = events.filter(e => parse(e.payload_json).source_id === watch.source_ref);
      if (!selected.length) continue;
      const current = new Map(sourceRows(this.service, watch.source_ref, selected.map(e => parse(e.payload_json).message_id))
        .map(e => [e.message.message_id, e]));
      const access = this.health(watch);
      // A re-read of an unchanged HTTP document confirms the existing version;
      // it is not a new message. Telegram signal age still uses its intake time.
      const confirmation = access.current && sourceTransportKind(this.service, watch.source_ref) === 'browser'
        ? browserCheckpoint(this.service, watch.source_ref)?.confirmed_at : null;
      for (const e of selected) {
        const m = parse(e.payload_json), latest = current.get(m.message_id);
        const reasons = [];
        if (!access.current) reasons.push(access.reason);
        if (!latest || latest.event_id !== String(e.id) || m.operation !== 'upsert') reasons.push('CONTINUITY_EVIDENCE_SUPERSEDED');
        if (typeof m.text !== 'string' || !m.text.trim()) reasons.push('CONTINUITY_EVIDENCE_UNSUPPORTED');
        const freshnessAt = confirmation ?? e.created_at;
        if (Date.parse(freshnessAt) + row.max_age_seconds * 1000 <= Date.now()) reasons.push('CONTINUITY_EVIDENCE_EXPIRED');
        result.set(String(e.id), { source_event_id: String(e.id), source_ref: watch.source_ref, author_id: m.author_id,
          message_id: m.message_id, message_version: m.version, observed_at: e.created_at, confirmed_at: confirmation,
          current: !reasons.length, reasons, text: typeof m.text === 'string' ? m.text.slice(0, 2000) : null,
          truncated: typeof m.text === 'string' && m.text.length > 2000 });
      }
    }
    return result;
  }
  detail(threadId) {
    const row = this.thread(threadId), watches = this.watches(row.id);
    // Opt-in owner-selected audience exchange. Generic continuity keeps its whole-source contract.
    const audienceScope = this.service.audience?.workScope(row.id) ?? null;
    const observations = this.store.all('SELECT * FROM partner_observations WHERE thread_id=? ORDER BY source_ref,source_event_id', row.id);
    const memoryRow = row.memory_turn_id ? this.store.get('SELECT id,output_json FROM partner_turns WHERE id=? AND thread_id=? AND status=?', row.memory_turn_id, row.id, 'accepted') : null;
    const memoryOutput = memoryRow ? parse(memoryRow.output_json) : null;
    const states = this.evidenceStates(row, watches, [...new Set([...observations.map(o => String(o.source_event_id)), ...refs(memoryOutput)])]);
    const businessCurrent = row.business_basis === this.businessBasis() && row.pause_reason !== 'CONTINUITY_BUSINESS_BASIS_CHANGED';
    const memoryCurrent = !!memoryRow && row.status !== 'CLOSED' && businessCurrent
      && (!audienceScope || audienceScope.current) && refs(memoryOutput).every(ref => states.get(ref)?.current === true);
    const memory = memoryRow ? { turn_id: memoryRow.id, epistemic_status: 'unverified_interpretation', current: memoryCurrent,
      content: memoryCurrent ? memoryOutput : null, reasons: memoryCurrent ? [] : ['CONTINUITY_MEMORY_STALE'] } : null;
    const evidence = observations.filter(o => !audienceScope || audienceScope.evidence_event_ids.includes(String(o.source_event_id)))
      .map(o => ({ ...states.get(String(o.source_event_id)), origin: o.origin })).filter(e => e.current === true);
    const windowIds = new Set(evidence.map(e => e.source_event_id));
    const memoryEvidence = memoryCurrent ? refs(memoryOutput).filter(ref => !windowIds.has(ref))
      .map(ref => ({ ...states.get(ref), origin: 'accepted_memory_support' })) : [];
    const watchStates = watches.map(w => ({ ...w, health: this.health(w), head: this.head(w.source_ref) }));
    const backlog = audienceScope ? audienceScope.reasons.includes('AUDIENCE_SCOPE_BACKLOG')
      : watchStates.some(w => w.status === 'active' && w.health.current && w.head > w.cursor);
    const dependency = { businessCurrent, watches: watchStates.map(w => [w.source_ref, w.status, w.health]),
      evidence: [...states.values()].map(e => [e.source_event_id, e.current, e.reasons]),
      ...(audienceScope ? { audience: audienceScope } : {}) };
    const basis = { revision: row.revision, business_basis: row.business_basis, dependency,
      watches: watchStates.map(w => audienceScope ? [w.source_ref, w.policy_hash] : [w.source_ref, w.policy_hash, w.cursor, w.head]), memory_turn_id: row.memory_turn_id };
    const operatorNotes = this.store.all(`SELECT id,created_at,payload_json FROM events WHERE partner_id=? AND kind='continuity.owner_note'
      AND actor='operator' AND payload_json->>'$.thread_id'=? ORDER BY id DESC LIMIT 5`, this.partnerId, row.id)
      .map(e => ({ id: String(e.id), text: parse(e.payload_json).text, recorded_at: e.created_at, kind: 'operator_guidance_not_source_fact' })).reverse();
    const latestTurn = this.store.get('SELECT id,status,producer,basis_revision FROM partner_turns WHERE thread_id=? ORDER BY rowid DESC LIMIT 1', row.id) ?? null;
    return { id: row.id, title: row.title, objective: row.objective, success_condition: row.success_condition,
      status: row.status, pause_reason: row.pause_reason, revision: row.revision, max_age_seconds: row.max_age_seconds,
      attention: { pending: !!row.attention, reasons: parse(row.attention_reasons_json), since: row.attention_at },
      wake_at: row.wake_at, watches: watchStates, evidence, memory_evidence: memoryEvidence, memory, backlog, operator_notes: operatorNotes, latest_turn: latestTurn,
      coverage: { recent_items_per_source: WINDOW, selection: 'bounded_recent_window_not_complete_history', max_memory_refs: 32, max_operator_notes: 5 },
      dependency_hash: digest(dependency), basis_fingerprint: digest(basis),
      ready: row.status === 'OPEN' && businessCurrent && (!audienceScope || audienceScope.current)
        && !backlog && evidence.length + memoryEvidence.length > 0,
      ...(audienceScope ? { audience_scope: audienceScope } : {}),
      ...AUTHORITY };
  }
  list({ limit = 20, cursor = '' } = {}) {
    check(Number.isInteger(limit) && limit >= 1 && limit <= 50 && typeof cursor === 'string' && cursor.length <= 36, 'CONTINUITY_PAGE_INVALID');
    const rows = this.store.all('SELECT id,title,status,revision,attention,attention_at,wake_at FROM partner_threads WHERE partner_id=? AND id>? ORDER BY id LIMIT ?', this.partnerId, cursor, limit + 1);
    return { items: rows.slice(0, limit).map(r => ({ ...r, ...AUTHORITY })), next_cursor: rows.length > limit ? rows[limit - 1].id : null,
      enabled: this.service.config.continuity?.enabled === true, model_enabled: this.service.config.continuity?.modelEnabled === true,
      source_refs: (effectiveSourceConfig(this.service).opportunity?.allowedSourceRefs ?? []).filter(ref => typeof ref === 'string').slice(0, 100) };
  }
  turn(turnId) {
    const row = this.store.get('SELECT t.* FROM partner_turns t JOIN partner_threads p ON p.id=t.thread_id WHERE t.id=? AND p.partner_id=?', turnId, this.partnerId);
    check(row, 'CONTINUITY_TURN_NOT_FOUND', 404);
    const { packet_json, output_json, ...rest } = row;
    const current = this.detail(row.thread_id);
    let reviewable = row.status === 'proposed' && current.ready && current.basis_fingerprint === row.basis_fingerprint;
    if (reviewable) {
      try { this.assertCurrent(row); }
      catch (e) { if (!(e instanceof AppError)) throw e; reviewable = false; }
    }
    return { ...rest, packet: parse(packet_json), packet_captured_at: row.created_at,
      output: output_json ? parse(output_json) : null,
      reviewable, ...AUTHORITY };
  }
  open(p) {
    this.enabled(); fields(p, ['title', 'objective', 'success_condition', 'source_ids', 'max_age_seconds', 'initial_evidence_event_ids']);
    const title = requiredText(p.title, 'title', 200), objective = requiredText(p.objective, 'objective', 2000);
    const success = requiredText(p.success_condition, 'success_condition', 2000);
    check(Array.isArray(p.source_ids) && p.source_ids.length > 0 && p.source_ids.length <= MAX_SOURCES
      && new Set(p.source_ids).size === p.source_ids.length, 'CONTINUITY_SOURCE_SCOPE');
    const maxAge = p.max_age_seconds ?? 604800;
    check(Number.isInteger(maxAge) && maxAge >= 60 && maxAge <= 2592000, 'CONTINUITY_AGE_INVALID');
    check(this.store.get("SELECT COUNT(*) n FROM partner_threads WHERE partner_id=? AND status<>'CLOSED'", this.partnerId).n < 100, 'CONTINUITY_OPEN_LIMIT');
    const threadId = id();
    this.store.run(`INSERT INTO partner_threads(id,partner_id,title,objective,success_condition,business_basis,max_age_seconds,status,attention_reasons_json,attention_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'OPEN','["opened"]',?,?,?)`, threadId, this.partnerId, title, objective, success, this.businessBasis(), maxAge, now(), now(), now());
    for (const sourceRef of p.source_ids) {
      requiredText(sourceRef, 'source_id', 300);
      // Enrollment requires authorization, not a live connection. Missing health is visible.
      const allowedSourceRefs = effectiveSourceConfig(this.service).opportunity?.allowedSourceRefs;
      check(Array.isArray(allowedSourceRefs) && allowedSourceRefs.includes(sourceRef), 'CONTINUITY_SOURCE_SCOPE');
      this.store.run('INSERT INTO partner_watches VALUES(?,?,?,?,?,NULL)', threadId, sourceRef, this.policyHash(sourceRef), this.head(sourceRef), 'active');
    }
    const initial = p.initial_evidence_event_ids ?? [];
    check(Array.isArray(initial) && initial.length <= WINDOW * MAX_SOURCES && new Set(initial).size === initial.length, 'CONTINUITY_EVIDENCE_SCOPE');
    const initialCounts = new Map();
    for (const ref of initial) {
      const source = sourceEvent(this.service, ref);
      check(p.source_ids.includes(source.message.source_id), 'CONTINUITY_EVIDENCE_SCOPE');
      initialCounts.set(source.message.source_id, (initialCounts.get(source.message.source_id) ?? 0) + 1);
      check(initialCounts.get(source.message.source_id) <= WINDOW, 'CONTINUITY_INITIAL_WINDOW_EXCEEDED');
      const row = this.thread(threadId), watches = this.watches(threadId);
      check(this.evidenceStates(row, watches, [ref]).get(ref)?.current, 'CONTINUITY_STALE_BASIS');
      this.observe(threadId, source.message.source_id, ref, 'owner_selected_history');
    }
    this.store.run('UPDATE partner_threads SET dependency_hash=? WHERE id=?', this.detail(threadId).dependency_hash, threadId);
    this.record('opened', { thread_id: threadId, source_ids: p.source_ids, initial_evidence_event_ids: initial }, 'operator');
    return { thread_id: threadId, revision: 1, ...AUTHORITY };
  }
  capture(p) {
    this.enabled(); fields(p, ['thread_id', 'expected_revision', 'expected_basis_fingerprint']);
    const packet = this.detail(p.thread_id);
    check(packet.ready && packet.revision === p.expected_revision && packet.basis_fingerprint === p.expected_basis_fingerprint, 'CONTINUITY_STALE_BASIS');
    check(packet.attention.pending, 'CONTINUITY_NO_ATTENTION');
    check(!this.store.get('SELECT id FROM partner_turns WHERE thread_id=? AND basis_revision=?', packet.id, packet.revision), 'CONTINUITY_ALREADY_CONSIDERED');
    check(!this.store.get("SELECT id FROM partner_turns WHERE thread_id=? AND status IN ('captured','running','proposed')", packet.id), 'CONTINUITY_TURN_PENDING');
    check(Buffer.byteLength(JSON.stringify(packet)) <= 600000, 'CONTINUITY_PACKET_TOO_LARGE');
    const turnId = id();
    this.store.run(`INSERT INTO partner_turns(id,thread_id,basis_revision,basis_fingerprint,packet_json,status,producer,created_at)
      VALUES(?,?,?,?,?,'captured','operator',?)`, turnId, packet.id, packet.revision, packet.basis_fingerprint, JSON.stringify(packet), now());
    this.record('captured', { thread_id: packet.id, turn_id: turnId, basis_fingerprint: packet.basis_fingerprint });
    return { turn_id: turnId, ...AUTHORITY };
  }
  assertCurrent(turn) {
    const current = this.detail(turn.thread_id);
    check(current.ready && current.basis_fingerprint === turn.basis_fingerprint, 'CONTINUITY_STALE_BASIS');
    // A scoped research packet may retain selected items beyond the recent window.
    // Validate these versions too; the window fingerprint alone cannot guard them.
    const packet = turn.packet ?? parse(turn.packet_json);
    const selected = [...packet.evidence, ...packet.memory_evidence].map(e => e.source_event_id);
    const states = this.evidenceStates(this.thread(turn.thread_id), this.watches(turn.thread_id), selected);
    check(selected.every(ref => states.get(ref)?.current), 'CONTINUITY_STALE_BASIS');
    this.service.executive?.assertTurnCurrent(turn);
  }
  propose(p, producer = 'operator') {
    fields(p, ['turn_id', 'output']); const turn = this.turn(p.turn_id);
    check(turn.status === (producer === 'model' ? 'running' : 'captured'), 'CONTINUITY_TURN_UNAVAILABLE');
    this.assertCurrent(turn);
    check(Buffer.byteLength(JSON.stringify(p.output ?? null)) <= 60000 && validate(p.output), 'CONTINUITY_PROPOSAL_INVALID', 400);
    const evidence = new Map([...turn.packet.evidence, ...turn.packet.memory_evidence].map(e => [e.source_event_id, e]));
    check(refs(p.output).length <= 32, 'CONTINUITY_MEMORY_LIMIT');
    check(refs(p.output).every(ref => evidence.has(ref)), 'CONTINUITY_EVIDENCE_SCOPE');
    check(p.output.claims.every(c => evidence.get(c.source_event_id).text.includes(c.quote)), 'CONTINUITY_QUOTE_MISMATCH');
    const next = p.output.next;
    check(next.kind === 'ask_owner' ? typeof next.owner_question === 'string' && next.owner_question.trim() : next.owner_question === null, 'CONTINUITY_NEXT_INVALID');
    check(next.kind === 'observe' || next.wake_at === null, 'CONTINUITY_NEXT_INVALID');
    if (next.wake_at !== null) check(Date.parse(dateTime(next.wake_at)) > Date.now(), 'CONTINUITY_DEADLINE_INVALID');
    this.store.run("UPDATE partner_turns SET output_json=?,status='proposed',producer=? WHERE id=?", JSON.stringify(p.output), producer, turn.id);
    this.record('proposed', { thread_id: turn.thread_id, turn_id: turn.id, producer });
    return { turn_id: turn.id, ...AUTHORITY };
  }
  review(p) {
    fields(p, ['turn_id', 'expected_basis_fingerprint', 'decision', 'note']); const turn = this.turn(p.turn_id);
    check(['proposed', 'stale'].includes(turn.status) && turn.output !== null, 'CONTINUITY_TURN_UNAVAILABLE');
    check(p.expected_basis_fingerprint === turn.basis_fingerprint, 'CONTINUITY_STALE_BASIS');
    check(['accept', 'reject'].includes(p.decision), 'CONTINUITY_REVIEW_INVALID');
    const note = requiredText(p.note, 'review note', 2000);
    if (p.decision === 'accept') {
      this.enabled(); check(turn.status === 'proposed', 'CONTINUITY_STALE_BASIS'); this.assertCurrent(turn);
      const next = turn.output.next;
      if (next.wake_at !== null) check(Date.parse(next.wake_at) > Date.now(), 'CONTINUITY_DEADLINE_INVALID');
      this.store.run(`UPDATE partner_threads SET memory_turn_id=?,revision=revision+1,attention=0,attention_reasons_json='[]',wake_at=?,status=?,updated_at=? WHERE id=?`,
        turn.id, next.wake_at, next.kind === 'close' ? 'CLOSED' : 'OPEN', now(), turn.thread_id);
    } else if (this.detail(turn.thread_id).basis_fingerprint === turn.basis_fingerprint) {
      this.store.run("UPDATE partner_threads SET attention=0,attention_reasons_json='[]' WHERE id=?", turn.thread_id);
    }
    this.store.run('UPDATE partner_turns SET status=?,review_note=?,reviewed_at=? WHERE id=?', p.decision === 'accept' ? 'accepted' : 'rejected', note, now(), turn.id);
    if (p.decision === 'accept') this.store.run('UPDATE partner_threads SET dependency_hash=? WHERE id=?', this.detail(turn.thread_id).dependency_hash, turn.thread_id);
    this.record('reviewed', { thread_id: turn.thread_id, turn_id: turn.id, decision: p.decision, note }, 'operator');
    return { thread_id: turn.thread_id, turn_id: turn.id, ...AUTHORITY };
  }
  command(action, p, actor) {
    check(actor?.kind === 'operator', 'CONTINUITY_OPERATOR_REQUIRED', 403);
    if (action === 'continuity.open') return this.open(p);
    if (action === 'continuity.capture') return this.capture(p);
    if (action === 'continuity.propose') {
      this.enabled(); check(!this.turn(p.turn_id).packet.research, 'EXECUTIVE_SUBMIT_REQUIRED'); return this.propose(p);
    }
    if (action === 'continuity.review') return this.review(p);
    if (action === 'continuity.note') {
      this.enabled(); fields(p, ['thread_id', 'expected_revision', 'text']); const row = this.thread(p.thread_id);
      check(row.status !== 'CLOSED' && row.revision === p.expected_revision, 'CONTINUITY_REVISION_CONFLICT');
      const text = requiredText(p.text, 'operator note', 2000);
      this.record('owner_note', { thread_id: row.id, text }, 'operator'); this.changed(row, ['owner_input']);
      return { thread_id: row.id, ...AUTHORITY };
    }
    fields(p, ['thread_id', 'expected_revision', 'reason']); const row = this.thread(p.thread_id);
    check(row.revision === p.expected_revision && row.status !== 'CLOSED', 'CONTINUITY_REVISION_CONFLICT');
    const reason = requiredText(p.reason, 'reason', 2000);
    if (action === 'continuity.resume') {
      this.enabled(); check(row.status === 'PAUSED' && row.pause_reason !== 'CONTINUITY_BUSINESS_BASIS_CHANGED'
        && row.business_basis === this.businessBasis(), 'CONTINUITY_STALE_BASIS');
    }
    const status = action === 'continuity.close' ? 'CLOSED' : action === 'continuity.pause' ? 'PAUSED' : 'OPEN';
    this.changed(row, [action.slice('continuity.'.length)]);
    this.store.run('UPDATE partner_threads SET status=?,pause_reason=?,wake_at=NULL WHERE id=?', status,
      row.pause_reason === 'CONTINUITY_BUSINESS_BASIS_CHANGED' ? row.pause_reason : status === 'PAUSED' ? 'OPERATOR_PAUSED' : null, row.id);
    this.record('status', { thread_id: row.id, status, reason }, 'operator');
    return { thread_id: row.id, status, ...AUTHORITY };
  }
  reconcile({ limit = 10, event_limit: eventLimit = 20 } = {}) {
    check(Number.isInteger(limit) && limit >= 1 && limit <= 20 && Number.isInteger(eventLimit)
      && eventLimit >= 1 && eventLimit <= 50, 'CONTINUITY_RECONCILE_LIMIT');
    return this.store.transaction(() => {
      const cursor = this.store.get('SELECT cursor FROM channel_offsets WHERE channel=? AND account_id=?', CURSOR, this.partnerId)?.cursor ?? '';
      const page = (after, n, before = null) => this.store.all(`SELECT * FROM partner_threads WHERE partner_id=? AND status<>'CLOSED' AND id>?
        ${before === null ? '' : 'AND id<=?'} ORDER BY id LIMIT ?`, this.partnerId, after, ...(before === null ? [] : [before]), n);
      let rows = page(cursor, limit);
      if (cursor && rows.length < limit) rows = rows.concat(page('', limit - rows.length, cursor));
      if (!rows.length) return { threads: 0, events: 0 };
      let events = 0;
      for (const row of rows) {
        const reasons = [];
        if (row.business_basis !== this.businessBasis() && row.pause_reason !== 'CONTINUITY_BUSINESS_BASIS_CHANGED') {
          this.store.run("UPDATE partner_threads SET status='PAUSED',pause_reason='CONTINUITY_BUSINESS_BASIS_CHANGED' WHERE id=?", row.id);
          reasons.push('business_basis_changed');
        }
        for (const watch of this.watches(row.id)) {
          const health = this.health(watch);
          if (watch.status === 'active' && ['SOURCE_NOT_ALLOWED', 'CONTINUITY_SOURCE_POLICY_CHANGED'].includes(health.reason)) {
            this.store.run("UPDATE partner_watches SET status='revoked',reason=? WHERE thread_id=? AND source_ref=?", health.reason, row.id, watch.source_ref);
            reasons.push('source_revoked'); continue;
          }
          if (!health.current || this.service.config.continuity?.enabled !== true || this.thread(row.id).status !== 'OPEN') continue;
          const incoming = this.store.all(`SELECT id FROM events WHERE partner_id=? AND kind='source.message' AND actor='system'
            AND payload_json->>'$.source_id'=? AND id>? ORDER BY id LIMIT ?`, this.partnerId, watch.source_ref, watch.cursor, eventLimit);
          const scoped = this.service.audience?.workScope(row.id);
          for (const event of incoming) {
            if (!scoped) this.observe(row.id, watch.source_ref, event.id, 'watched_change');
            events++;
          }
          if (incoming.length) {
            this.store.run('UPDATE partner_watches SET cursor=? WHERE thread_id=? AND source_ref=?', incoming.at(-1).id, row.id, watch.source_ref);
            if (!scoped) reasons.push('evidence_changed');
          }
        }
        if (this.service.config.continuity?.enabled === true && this.thread(row.id).status === 'OPEN'
          && row.wake_at && Date.parse(row.wake_at) <= Date.now()) {
          this.store.run('UPDATE partner_threads SET wake_at=NULL WHERE id=?', row.id); reasons.push('deadline');
        }
        const state = this.detail(row.id);
        const temporarilyBlocked = this.service.audience?.temporaryWorkBlock(row.id) === true;
        if (state.dependency_hash !== row.dependency_hash && !temporarilyBlocked) reasons.push('evidence_state_changed');
        if (reasons.length) this.changed(row, [...new Set(reasons)]);
        if (!temporarilyBlocked) this.store.run('UPDATE partner_threads SET dependency_hash=? WHERE id=?', state.dependency_hash, row.id);
      }
      this.store.run(`INSERT INTO channel_offsets VALUES(?,?,?) ON CONFLICT(channel,account_id) DO UPDATE SET cursor=excluded.cursor`,
        CURSOR, this.partnerId, rows.at(-1)?.id ?? '');
      return { threads: rows.length, events };
    });
  }
}
