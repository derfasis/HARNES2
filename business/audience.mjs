// Domain projection over canonical normalized events, not a Telegram parser or a job engine.
import path from 'node:path';
import Ajv from 'ajv';
import { ROOT, readJson } from './config.mjs';
import { id } from './store.mjs';
import { ensure, requiredText, now, AppError } from './errors.mjs';
import { sourceRows, sourceEvent, digest } from './source-ingestion.mjs';
import { effectiveSourceConfig } from './scout-policy.mjs';
import { proposalRefs, proposalBindings, previewHash, frozenProposalBasis } from './audience-proposals.mjs';

const storedOutputSchema = readJson(path.join(ROOT, 'contracts/audience-assessment.schema.json'));
export const outputSchema = structuredClone(storedOutputSchema);
outputSchema.properties.needs.items.required.push('proposal_version', 'context_event_ids', 'context_review');
const validator = new Ajv({ strict: true, allowUnionTypes: true });
export const validateOutput = validator.compile(storedOutputSchema);
const validateModelOutput = validator.compile(outputSchema);
const check = (ok, code, status = 409) => ensure(ok, code, status, code);
const fields = (p, keys) => check(p && typeof p === 'object' && !Array.isArray(p)
  && Object.keys(p).every(k => keys.includes(k)), 'AUDIENCE_FIELDS_INVALID', 400);
const parse = JSON.parse, CURSOR = 'audience-reconcile-v1', BATCH = 8, MEMBERS = 32;
const AUTHORITY = Object.freeze({ executable: false, contact_permission: false, allowed_effects: [] });
const allRefs = proposalRefs;
const TEMPORARY = new Set(['AUDIENCE_SCOPE_BACKLOG','AUDIENCE_RECONCILIATION_UNPROVEN',
  'SOURCE_TRANSPORT_NOT_CURRENT','SOURCE_TRANSPORT_STALE','SOURCE_TRANSPORT_NOT_READY','SOURCE_TRANSPORT_DIRTY',
  'CONTINUITY_SOURCE_UNAVAILABLE','AUDIENCE_DISABLED']);

export class AudienceLoop {
  constructor(service) {
    this.service = service; this.store = service.store;
    if (service.config.audience?.enabled === true) service.audienceReconciliationHealth = null;
  }
  get partnerId() { return this.service.config.partnerId; }
  enabled() { return this.service.config.audience?.enabled === true; }
  requireEnabled() { check(this.enabled(), 'AUDIENCE_DISABLED'); }
  record(kind, value, actor = 'system') { this.store.event(this.partnerId, null, `audience.${kind}`, actor, value); }
  goal(goalId) {
    const row = this.store.get('SELECT * FROM audience_goals WHERE id=? AND partner_id=?', goalId, this.partnerId);
    check(row, 'AUDIENCE_NOT_FOUND', 404); return row;
  }
  watches(goalId) { return this.store.all('SELECT * FROM audience_watches WHERE goal_id=? ORDER BY source_ref', goalId); }
  policyHash(sourceRef) {
    // Regrant of identical dynamic policy is a new authority epoch, not resurrection.
    const cfg = effectiveSourceConfig(this.service), p = cfg.opportunity.telegramSources?.find(s => s.sourceId === sourceRef);
    const dynamic = p && !(this.service.config.opportunity.telegramSources ?? []).some(s => s.sourceId === sourceRef);
    const grants = dynamic ? this.store.all(`SELECT g.id,g.campaign_revision,g.expires_at FROM scout_grants g
      JOIN scout_candidates c ON c.id=g.candidate_id JOIN scout_campaigns a ON a.id=g.campaign_id
      WHERE a.partner_id=? AND c.channel_id=? AND g.account_id=? AND g.kind='monitor'
      AND g.status='active' AND g.expires_at>? AND a.status='active' AND a.revision=g.campaign_revision ORDER BY g.id`,
    this.partnerId, p.channelId, p.accountId, now()) : [];
    return digest({ policy: this.service.continuity.policyHash(sourceRef), grants });
  }
  health(watch) {
    if (watch.status === 'revoked') return { current: false, reason: watch.reason ?? 'AUDIENCE_SOURCE_REVOKED' };
    if (this.policyHash(watch.source_ref) !== watch.policy_hash) return { current: false, reason: 'AUDIENCE_SOURCE_POLICY_CHANGED' };
    // Continuity owns the common source transport/freshness boundary.
    return this.service.continuity.health({ ...watch, policy_hash: this.service.continuity.policyHash(watch.source_ref) });
  }
  open(p) {
    this.requireEnabled(); fields(p, ['title', 'objective', 'source_ids', 'max_age_seconds']);
    const title = requiredText(p.title, 'title', 200), objective = requiredText(p.objective, 'objective', 2000);
    const sourceIds = p.source_ids, allowed = effectiveSourceConfig(this.service).opportunity.allowedSourceRefs;
    check(Array.isArray(sourceIds) && sourceIds.length > 0 && sourceIds.length <= (this.service.config.audience.maxSources ?? 20)
      && new Set(sourceIds).size === sourceIds.length && sourceIds.every(s => typeof s === 'string' && allowed.includes(s)), 'AUDIENCE_SOURCE_SCOPE');
    const age = p.max_age_seconds ?? 604800;
    check(Number.isInteger(age) && age >= 60 && age <= 2592000, 'AUDIENCE_AGE_INVALID');
    check(this.store.get('SELECT COUNT(*) n FROM audience_goals WHERE partner_id=?', this.partnerId).n < 50, 'AUDIENCE_GOAL_LIMIT');
    const goalId = id();
    this.store.run("INSERT INTO audience_goals VALUES(?,?,?,?,1,'OPEN',?,?,?)", goalId, this.partnerId, title, objective, age, now(), now());
    for (const ref of sourceIds) this.store.run("INSERT INTO audience_watches VALUES(?,?,?,0,'active',NULL)", goalId, ref, this.policyHash(ref));
    this.record('opened', { goal_id: goalId, source_ids: sourceIds }, 'operator'); return { goal_id: goalId, ...AUTHORITY };
  }
  pause(p) {
    fields(p, ['goal_id', 'expected_revision', 'reason']); const row = this.goal(p.goal_id);
    check(row.revision === p.expected_revision && row.status === 'OPEN', 'AUDIENCE_REVISION_CONFLICT');
    const reason = requiredText(p.reason, 'reason', 2000);
    this.store.run("UPDATE audience_goals SET status='PAUSED',revision=revision+1,updated_at=? WHERE id=?", now(), row.id);
    this.retire(row.id); this.record('paused', { goal_id: row.id, reason }, 'operator'); return { goal_id: row.id, ...AUTHORITY };
  }
  // Bounded parent lookup works with opaque platform IDs; never infers identity from author.
  ancestry(sourceRef, message, cache = new Map()) {
    const chain = [], seen = new Set(); let m = message, missing = false;
    const lookup = key => {
      if (!cache.has(key)) cache.set(key, sourceRows(this.service, sourceRef, [key])[0] ?? null);
      return cache.get(key);
    };
    while (m) {
      if (seen.has(m.message_id) || chain.length >= MEMBERS) return { anchor: m.message_id, chain, incomplete: true };
      seen.add(m.message_id); chain.push(m.message_id);
      if (!m.reply_to_id) return { anchor: m.message_id, chain, incomplete: missing };
      const parent = lookup(m.reply_to_id);
      if (!parent) { chain.push(m.reply_to_id); return { anchor: m.reply_to_id, chain, incomplete: true }; }
      m = parent.message;
    }
    return { anchor: message.message_id, chain, incomplete: true };
  }
  members(row) {
    let members;
    try { members = parse(row.member_ids_json); }
    catch { throw new AppError('AUDIENCE_RECORD_INVALID', 409, 'AUDIENCE_RECORD_INVALID'); }
    check(Array.isArray(members) && members.length <= MEMBERS && new Set(members).size === members.length
      && members.every(m => typeof m === 'string' && m.length > 0 && m.length <= 200), 'AUDIENCE_RECORD_INVALID');
    return members;
  }
  projection(row) {
    const members = this.members(row);
    let state;
    try { state = parse(row.state_json); }
    catch { throw new AppError('AUDIENCE_RECORD_INVALID', 409, 'AUDIENCE_RECORD_INVALID'); }
    check(state && Object.keys(state).sort().join(',') === 'evidence,members,reasons,unsupported_count'
      && Array.isArray(state.members) && state.members.length <= MEMBERS
      && state.members.every(m => Array.isArray(m) && m.length === 3 && members.includes(m[0])
        && typeof m[1] === 'string' && /^[1-9][0-9]*$/.test(m[1]) && ['upsert','delete','unsupported'].includes(m[2]))
      && new Set(state.members.map(m => m[0])).size === state.members.length
      && Array.isArray(state.evidence) && digest(state.evidence) === digest(state.members.filter(m => m[2] === 'upsert').map(m => m[1]))
      && Array.isArray(state.reasons) && state.reasons.length <= 16 && state.reasons.every(r => typeof r === 'string')
      && (members.length > 0 || state.reasons.includes('AUDIENCE_RECORD_INVALID'))
      && state.unsupported_count === state.members.filter(m => m[2] === 'unsupported').length
      && digest({ members, state, overflow: !!row.overflow }) === row.fingerprint, 'AUDIENCE_RECORD_INVALID');
    return state;
  }
  quarantineExchange(row) {
    const members = [], state = { members: [], evidence: [], reasons: ['AUDIENCE_RECORD_INVALID'], unsupported_count: 0 };
    const fingerprint = digest({ members, state, overflow: true });
    this.store.run('UPDATE audience_exchanges SET member_ids_json=?,state_json=?,fingerprint=?,overflow=1,updated_at=? WHERE id=?',
      JSON.stringify(members), JSON.stringify(state), fingerprint, now(), row.id);
    this.record('quarantined', { exchange_id: row.id, reason: 'AUDIENCE_RECORD_INVALID' });
  }
  refreshExchange(row) {
    const members = this.members(row), latest = sourceRows(this.service, row.source_ref, members);
    const byId = new Map(latest.map(e => [e.message.message_id, e]));
    const reasons = [], canonical = latest.sort((a, b) => Number(a.event_id) - Number(b.event_id));
    if (row.overflow) reasons.push('AUDIENCE_EXCHANGE_CAPACITY');
    if (!byId.has(row.anchor_id)) reasons.push('AUDIENCE_ANCESTRY_INCOMPLETE');
    for (const key of members) {
      const event = byId.get(key);
      if (!event) { reasons.push('AUDIENCE_ANCESTRY_INCOMPLETE'); continue; }
      const m = event.message;
      // An unsupported leaf is unknown. A necessary opaque/deleted parent cannot be evidence.
      if ((m.message_id === row.anchor_id || latest.some(e => e.message.reply_to_id === m.message_id))
        && m.operation !== 'upsert') reasons.push('AUDIENCE_ANCHOR_UNSUPPORTED');
      if (m.reply_to_id && !byId.has(m.reply_to_id)) reasons.push('AUDIENCE_ANCESTRY_INCOMPLETE');
      let cursor = m; const seen = new Set();
      while (cursor) {
        if (seen.has(cursor.message_id)) { reasons.push('AUDIENCE_ANCESTRY_CYCLE'); break; }
        seen.add(cursor.message_id);
        if (!cursor.reply_to_id) {
          if (cursor.message_id !== row.anchor_id) reasons.push('AUDIENCE_ANCESTRY_CHANGED');
          break;
        }
        cursor = byId.get(cursor.reply_to_id)?.message;
      }
    }
    const state = { members: canonical.map(e => [e.message.message_id, e.event_id, e.message.operation]),
      evidence: canonical.filter(e => e.message.operation === 'upsert').map(e => e.event_id),
      reasons: [...new Set(reasons)], unsupported_count: canonical.filter(e => e.message.operation === 'unsupported').length };
    const fingerprint = digest({ members, state, overflow: !!row.overflow });
    this.store.run('UPDATE audience_exchanges SET fingerprint=?,state_json=?,updated_at=? WHERE id=?', fingerprint, JSON.stringify(state), now(), row.id);
  }
  intake(goal, watch, incoming) {
    const cache = new Map();
    for (const row of incoming) {
      const event = sourceEvent(this.service, String(row.id));
      const m = sourceRows(this.service, watch.source_ref, [event.message.message_id])[0]?.message ?? event.message;
      // Refresh old membership too: edits moving reply ancestry must invalidate its former scope.
      const old = this.store.all(`SELECT * FROM audience_exchanges WHERE goal_id=? AND source_ref=?
        AND EXISTS(SELECT 1 FROM json_each(member_ids_json) WHERE value=?)`, goal.id, watch.source_ref, m.message_id);
      for (const exchange of old) this.refreshExchange(exchange);
      if (m.operation !== 'upsert' && !m.reply_to_id && !old.length) continue;
      const ancestry = this.ancestry(watch.source_ref, m, cache);
      let exchange = this.store.get('SELECT * FROM audience_exchanges WHERE goal_id=? AND source_ref=? AND anchor_id=?', goal.id, watch.source_ref, ancestry.anchor);
      if (!exchange) {
        const capacity = this.service.config.audience?.maxExchangesPerSource ?? 100;
        if (this.store.get('SELECT COUNT(*) n FROM audience_exchanges WHERE goal_id=? AND source_ref=?', goal.id, watch.source_ref).n >= capacity) {
          const evict = this.store.get(`SELECT e.id FROM audience_exchanges e WHERE e.goal_id=? AND e.source_ref=?
            AND NOT EXISTS(SELECT 1 FROM audience_needs n,json_each(n.basis_json,'$.exchanges') x WHERE x.value->>'$.id'=e.id)
            AND NOT EXISTS(SELECT 1 FROM audience_assessments a,json_each(a.packet_json,'$.exchanges') x
              WHERE a.goal_id=e.goal_id AND a.status IN ('captured','running','proposed') AND x.value->>'$.id'=e.id)
            ORDER BY e.last_event_id LIMIT 1`, goal.id, watch.source_ref);
          if (evict) this.store.run('DELETE FROM audience_exchanges WHERE id=?', evict.id);
          else { this.store.run('UPDATE audience_watches SET reason=? WHERE goal_id=? AND source_ref=?', 'AUDIENCE_SOURCE_CAPACITY', goal.id, watch.source_ref); continue; }
        }
        const exchangeId = id();
        this.store.run('INSERT INTO audience_exchanges VALUES(?,?,?,?,?,?,?,?,NULL,0,?,?)', exchangeId, goal.id, watch.source_ref,
          ancestry.anchor, '[]', '', '{}', row.id, now(), now());
        exchange = this.store.get('SELECT * FROM audience_exchanges WHERE id=?', exchangeId);
      }
      // Quarantine is terminal for this projection; new messages cannot resurrect its proof.
      if (parse(exchange.state_json).reasons?.includes('AUDIENCE_RECORD_INVALID')) continue;
      const all = [...new Set([...this.members(exchange), ...ancestry.chain])];
      this.store.run('UPDATE audience_exchanges SET member_ids_json=?,overflow=?,last_event_id=? WHERE id=?',
        JSON.stringify(all.slice(0, MEMBERS)), exchange.overflow || all.length > MEMBERS ? 1 : 0, row.id, exchange.id);
      this.refreshExchange(this.store.get('SELECT * FROM audience_exchanges WHERE id=?', exchange.id));
    }
  }
  exchangeState(goal, exchange, watch = this.watches(goal.id).find(w => w.source_ref === exchange.source_ref)) {
    let state;
    try { state = this.projection(exchange); }
    catch (error) {
      if (!(error instanceof AppError)) throw error;
      return { id: exchange.id, source_ref: exchange.source_ref, anchor_id: exchange.anchor_id,
        fingerprint: exchange.fingerprint, current: false, reasons: ['AUDIENCE_RECORD_INVALID'], evidence: [],
        unsupported_count: null, coverage: 'bounded_explicit_reply_exchange_not_complete_history', considered: true };
    }
    const reasons = [...state.reasons], access = watch ? this.health(watch) : { current: false, reason: 'AUDIENCE_SOURCE_SCOPE' };
    if (!access.current) reasons.push(access.reason);
    if (goal.status !== 'OPEN') reasons.push('AUDIENCE_GOAL_PAUSED');
    if (!this.enabled()) reasons.push('AUDIENCE_DISABLED');
    // The immutable evidence versions are rechecked even before the projection cursor catches up.
    const evidence = [...this.service.continuity.evidenceStates({ max_age_seconds: goal.max_age_seconds },
      watch ? [{ ...watch, policy_hash: this.service.continuity.policyHash(watch.source_ref) }] : [], state.evidence).values()];
    if (!evidence.length) reasons.push('AUDIENCE_NO_SUPPORTED_EVIDENCE');
    if (evidence.length !== state.evidence.length) reasons.push('AUDIENCE_EVIDENCE_STALE');
    for (const e of evidence) if (!e.current) reasons.push(...e.reasons);
    if (watch && this.service.continuity.head(watch.source_ref) > watch.cursor) reasons.push('AUDIENCE_SCOPE_BACKLOG');
    return { id: exchange.id, source_ref: exchange.source_ref, anchor_id: exchange.anchor_id,
      fingerprint: exchange.fingerprint, current: reasons.length === 0, reasons: [...new Set(reasons)], evidence,
      unsupported_count: state.unsupported_count, coverage: 'bounded_explicit_reply_exchange_not_complete_history',
      considered: exchange.considered_fingerprint === exchange.fingerprint };
  }
  basis(goal, exchanges) {
    const watches = this.watches(goal.id);
    return { goal_id: goal.id, revision: goal.revision,
      exchanges: exchanges.map(e => ({ id: e.id, fingerprint: e.fingerprint, source_ref: e.source_ref })),
      policies: [...new Set(exchanges.map(e => e.source_ref))].sort().map(ref => [ref, watches.find(w => w.source_ref === ref)?.policy_hash]) };
  }
  basisState(basis) {
    if (!basis || typeof basis !== 'object' || Object.keys(basis).sort().join(',') !== 'exchanges,goal_id,policies,revision'
      || typeof basis.goal_id !== 'string' || !Number.isInteger(basis.revision) || basis.revision < 1
      || !Array.isArray(basis.exchanges) || !basis.exchanges.length || basis.exchanges.length > BATCH
      || !basis.exchanges.every(e => e && typeof e.id === 'string' && typeof e.source_ref === 'string' && /^[a-f0-9]{64}$/.test(e.fingerprint))
      || new Set(basis.exchanges.map(e => e.id)).size !== basis.exchanges.length
      || !Array.isArray(basis.policies) || basis.policies.length < 1 || basis.policies.length > BATCH
      || !basis.policies.every(p => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && /^[a-f0-9]{64}$/.test(p[1]))
      || digest(basis.policies.map(p => p[0]).sort()) !== digest([...new Set(basis.exchanges.map(e => e.source_ref))].sort()))
      return { current: false, reasons: ['AUDIENCE_RECORD_INVALID'] };
    const goal = this.goal(basis.goal_id);
    const reasons = [];
    if (!this.enabled()) reasons.push('AUDIENCE_DISABLED');
    if (goal.status !== 'OPEN' || goal.revision !== basis.revision) reasons.push('AUDIENCE_GOAL_CHANGED');
    for (const selected of basis.exchanges) {
      const row = this.store.get('SELECT * FROM audience_exchanges WHERE id=? AND goal_id=?', selected.id, goal.id);
      if (!row || row.fingerprint !== selected.fingerprint || row.source_ref !== selected.source_ref) reasons.push('AUDIENCE_EXCHANGE_CHANGED');
      if (row) reasons.push(...this.exchangeState(goal, row).reasons);
    }
    if (!basis.policies.every(([ref, policy]) => this.watches(goal.id).some(w => w.source_ref === ref
      && w.status === 'active' && w.policy_hash === policy && this.policyHash(ref) === policy))) reasons.push('AUDIENCE_SOURCE_REVOKED');
    return { current: reasons.length === 0, reasons: [...new Set(reasons)] };
  }
  assertBasis(basis) {
    check(this.basisState(basis).current, 'AUDIENCE_STALE_BASIS'); return this.goal(basis.goal_id);
  }
  detail(goalId) {
    const goal = this.goal(goalId), watches = this.watches(goal.id);
    const projected = watches.map(w => ({ ...w, health: this.health(w), head: this.service.continuity.head(w.source_ref) }));
    const backlog = projected.some(w => w.status === 'active' && w.head > w.cursor);
    const sourceCursor = this.store.get('SELECT cursor FROM channel_offsets WHERE channel=? AND account_id=?', 'audience-packet-source-v1', goal.id)?.cursor;
    const start = watches.findIndex(w => w.source_ref === sourceCursor) + 1;
    const rotated = watches.slice(start).concat(watches.slice(0, start));
    const queues = rotated.map(w => this.store.all(`SELECT * FROM audience_exchanges WHERE goal_id=? AND source_ref=?
      AND (considered_fingerprint IS NULL OR considered_fingerprint<>fingerprint) ORDER BY last_event_id LIMIT 100`, goal.id, w.source_ref)
      .map(e => this.exchangeState(goal, e, w)));
    const pools = queues.map(pool => pool.filter(e => e.current));
    // Round-robin sources within each finite packet; a noisy chat cannot fill all eight slots.
    const exchanges = [], content = new Set();
    for (let i = 0; i < BATCH && exchanges.length < BATCH; i++) for (const pool of pools) {
      if (exchanges.length >= BATCH) break;
      const e = pool[i]; if (!e) continue;
      const key = digest(e.evidence.map(s => s.text.trim().replace(/\s+/g, ' ')));
      if (content.has(key)) continue;
      content.add(key); exchanges.push(e);
    }
    const basis = this.basis(goal, exchanges);
    const needs = this.store.all('SELECT id FROM audience_needs WHERE goal_id=? ORDER BY updated_at DESC LIMIT 100', goal.id).map(n => this.need(n.id));
    const assessments = this.store.all('SELECT id,status,producer,created_at FROM audience_assessments WHERE goal_id=? ORDER BY rowid DESC LIMIT 10', goal.id);
    return { ...goal, watches: projected, exchanges, needs, assessments, backlog,
      withheld_exchanges: queues.flat().filter(e => !e.current).slice(0, BATCH),
      basis_fingerprint: digest(basis), ready: this.enabled() && goal.status === 'OPEN' && exchanges.length > 0,
      coverage: { batch_exchanges: BATCH, max_messages_per_exchange: MEMBERS, source_capacity: this.service.config.audience?.maxExchangesPerSource ?? 100,
        selection: 'bounded_reply_scopes_not_all_audience', source_completeness: 'unknown', identity_independence: 'unproven' }, ...AUTHORITY };
  }
  list({ limit = 20, cursor = '' } = {}) {
    check(Number.isInteger(limit) && limit >= 1 && limit <= 50 && typeof cursor === 'string' && cursor.length <= 36, 'AUDIENCE_PAGE_INVALID');
    const rows = this.store.all('SELECT id,title,status,revision FROM audience_goals WHERE partner_id=? AND id>? ORDER BY id LIMIT ?', this.partnerId, cursor, limit + 1);
    return { items: rows.slice(0, limit), next_cursor: rows.length > limit ? rows[limit - 1].id : null,
      enabled: this.enabled(), model_enabled: this.service.config.audience?.modelEnabled === true,
      source_refs: effectiveSourceConfig(this.service).opportunity.allowedSourceRefs.slice(0, 100), ...AUTHORITY };
  }
  capture(p) {
    this.requireEnabled(); fields(p, ['goal_id', 'expected_revision', 'expected_basis_fingerprint']);
    const packet = this.detail(p.goal_id);
    check(packet.ready && (p.expected_revision === undefined || packet.revision === p.expected_revision)
      && packet.basis_fingerprint === p.expected_basis_fingerprint, 'AUDIENCE_STALE_BASIS');
    check(!this.store.get('SELECT id FROM audience_assessments WHERE goal_id=? AND basis_fingerprint=?', packet.id, packet.basis_fingerprint), 'AUDIENCE_ALREADY_CONSIDERED');
    check(!this.store.get("SELECT id FROM audience_assessments WHERE goal_id=? AND status IN ('captured','running')", packet.id), 'AUDIENCE_ASSESSMENT_PENDING');
    check(Buffer.byteLength(JSON.stringify(packet)) <= 600000, 'AUDIENCE_PACKET_TOO_LARGE');
    packet.scope = this.basis(this.goal(packet.id), packet.exchanges);
    packet.proposal_contract_version = 2;
    const assessmentId = id();
    packet.assessment_id = assessmentId;
    this.store.run("INSERT INTO audience_assessments VALUES(?,?,?,?,'captured','operator',NULL,NULL,?)", assessmentId, packet.id, packet.basis_fingerprint, JSON.stringify(packet), now());
    // An attempted packet was considered even when the process crashes or the model fails.
    // New evidence can advance; a tick is never authority to rebill the failed packet.
    for (const e of packet.exchanges) this.store.run('UPDATE audience_exchanges SET considered_fingerprint=? WHERE id=?', e.fingerprint, e.id);
    this.store.run('INSERT INTO channel_offsets VALUES(?,?,?) ON CONFLICT(channel,account_id) DO UPDATE SET cursor=excluded.cursor',
      'audience-packet-source-v1', packet.id, packet.exchanges.at(-1).source_ref);
    this.record('captured', { assessment_id: assessmentId, goal_id: packet.id }); return { assessment_id: assessmentId, ...AUTHORITY };
  }
  assertAssessmentCurrent(row) { return this.assertBasis((row.packet ?? parse(row.packet_json)).scope); }
  assessment(assessmentId) {
    const row = this.store.get('SELECT a.* FROM audience_assessments a JOIN audience_goals g ON g.id=a.goal_id WHERE a.id=? AND g.partner_id=?', assessmentId, this.partnerId);
    check(row, 'AUDIENCE_ASSESSMENT_NOT_FOUND', 404);
    let current = false; try { this.assertAssessmentCurrent(row); current = true; } catch { /* historical packet */ }
    const { packet_json, output_json, ...rest } = row;
    return { ...rest, packet: parse(packet_json), output: output_json ? parse(output_json) : null,
      current, reviewable: current && ['captured', 'running', 'proposed'].includes(row.status), ...AUTHORITY };
  }
  propose(p, producer = 'operator') {
    this.requireEnabled(); fields(p, ['assessment_id', 'output']); const a = this.assessment(p.assessment_id);
    check(a.status === (producer === 'model' ? 'running' : 'captured'), 'AUDIENCE_ASSESSMENT_UNAVAILABLE'); this.assertAssessmentCurrent(a);
    check(Buffer.byteLength(JSON.stringify(p.output ?? null)) <= 60000 && validateOutput(p.output)
      && (producer !== 'model' || a.packet.proposal_contract_version !== 2 || validateModelOutput(p.output)), 'AUDIENCE_PROPOSAL_INVALID', 400);
    const seen = new Set(), results = [];
    for (const output of p.output.needs) {
      const { selected } = proposalBindings(output, a.packet);
      const basis = this.basis(this.goal(a.goal_id), selected);
      let existing = output.need_id ? this.store.get('SELECT * FROM audience_needs WHERE id=? AND goal_id=?', output.need_id, a.goal_id) : null;
      check(!output.need_id || existing, 'AUDIENCE_NEED_SCOPE');
      check(!existing || existing.status !== 'rejected', 'AUDIENCE_REJECTED_NEED');
      check(!seen.has(output.need_id ?? digest(output.evidence_event_ids.slice().sort())), 'AUDIENCE_DUPLICATE_NEED');
      seen.add(output.need_id ?? digest(output.evidence_event_ids.slice().sort()));
      if (existing) {
        const captured = a.packet.needs.find(n => n.id === existing.id);
        check(captured && captured.revision === existing.revision, 'AUDIENCE_STALE_BASIS');
      } else {
        check(this.store.get('SELECT COUNT(*) n FROM audience_needs WHERE goal_id=?', a.goal_id).n < 100, 'AUDIENCE_NEED_CAPACITY');
        // Exact support is not a second independent observation or a fresh need every tick.
        const duplicate = this.store.all('SELECT output_json FROM audience_needs WHERE goal_id=?', a.goal_id)
          .some(n => digest(parse(n.output_json).evidence_event_ids.slice().sort()) === digest(output.evidence_event_ids.slice().sort()));
        check(!duplicate, 'AUDIENCE_DUPLICATE_NEED');
      }
      const needId = existing?.id ?? id();
      if (existing) this.store.run("UPDATE audience_needs SET assessment_id=?,revision=revision+1,status='proposed',output_json=?,basis_json=?,review_note=NULL,reviewed_at=NULL,updated_at=? WHERE id=?",
        a.id, JSON.stringify(output), JSON.stringify(basis), now(), needId);
      else this.store.run("INSERT INTO audience_needs VALUES(?,?,?,1,'proposed',?,?,NULL,NULL,?,?)", needId, a.goal_id, a.id, JSON.stringify(output), JSON.stringify(basis), now(), now());
      results.push(needId);
    }
    this.store.run("UPDATE audience_assessments SET status='proposed',producer=?,output_json=? WHERE id=?", producer, JSON.stringify(p.output), a.id);
    for (const e of a.packet.exchanges) this.store.run('UPDATE audience_exchanges SET considered_fingerprint=? WHERE id=?', e.fingerprint, e.id);
    this.record('proposed', { assessment_id: a.id, need_ids: results, producer }); return { assessment_id: a.id, need_ids: results, ...AUTHORITY };
  }
  need(needId, { includeWorkCase = true } = {}) {
    const row = this.store.get('SELECT n.* FROM audience_needs n JOIN audience_goals g ON g.id=n.goal_id WHERE n.id=? AND g.partner_id=?', needId, this.partnerId);
    check(row, 'AUDIENCE_NEED_NOT_FOUND', 404); let output, basis;
    try { output = parse(row.output_json); basis = parse(row.basis_json); }
    catch { throw new AppError('AUDIENCE_RECORD_INVALID', 409, 'AUDIENCE_RECORD_INVALID'); }
    check(validateOutput({ needs: [output] }) && basis?.goal_id === row.goal_id, 'AUDIENCE_RECORD_INVALID');
    if (output.proposal_version === 2) {
      // The durable need is a projection of an immutable assessment, not an editable
      // authority document. Bind its text, references and selected context on read/import.
      try {
        const assessment = this.store.get('SELECT * FROM audience_assessments WHERE id=? AND goal_id=?', row.assessment_id, row.goal_id);
        const packet = parse(assessment.packet_json), original = parse(assessment.output_json);
        const { selected } = proposalBindings(output, packet);
        check(original.needs.some(n => digest(n) === digest(output))
          && digest(basis) === digest(frozenProposalBasis(packet, selected)), 'AUDIENCE_RECORD_INVALID');
      } catch { throw new AppError('AUDIENCE_RECORD_INVALID', 409, 'AUDIENCE_RECORD_INVALID'); }
    }
    const reasons = [...this.basisState(basis).reasons];
    if (row.status === 'stale' || row.status === 'rejected') reasons.push(`AUDIENCE_NEED_${row.status.toUpperCase()}`);
    const link = this.store.get('SELECT * FROM audience_work_links WHERE need_id=?', row.id);
    let workCase = null;
    if (includeWorkCase && link && output.material_preview) {
      const w = this.store.get('SELECT * FROM work_cases WHERE thread_id=? AND partner_id=? ORDER BY created_at DESC LIMIT 1', link.thread_id, this.partnerId);
      if (w) {
        let current = false;
        try { this.service.work.current(w); current = true; } catch { /* operator surface is fail-closed */ }
        workCase = { id: w.id, revision: w.revision, current };
      }
    }
    return { id: row.id, goal_id: row.goal_id, assessment_id: row.assessment_id, status: row.status, revision: row.revision,
      ...output, current: reasons.length === 0, reasons, epistemic_status: 'unverified_interpretation',
      context_accounting: output.proposal_version === 2 ? 'supplied_packet_only' : 'not_recorded',
      preview_sha256: previewHash(output), linked_work_case: workCase,
      // Model citations cannot narrow the inherited evidence/authority basis.
      preview_basis_event_ids: output.material_preview ? allRefs(output) : [],
      basis_fingerprint: digest({ revision: row.revision, basis, output }), review_note: row.review_note,
      reviewed_at: row.reviewed_at, thread_id: link?.thread_id ?? null, ...AUTHORITY };
  }
  review(p) {
    fields(p, ['need_id', 'expected_revision', 'expected_basis_fingerprint', 'decision', 'note']); const n = this.need(p.need_id);
    check(n.revision === p.expected_revision && n.basis_fingerprint === p.expected_basis_fingerprint, 'AUDIENCE_REVISION_CONFLICT');
    check(['accept', 'reject'].includes(p.decision) && ['proposed', 'stale'].includes(n.status), 'AUDIENCE_REVIEW_INVALID');
    if (p.decision === 'accept') { this.requireEnabled(); check(n.status === 'proposed' && n.current, 'AUDIENCE_STALE_BASIS'); }
    const note = requiredText(p.note, 'review note', 2000);
    this.store.run('UPDATE audience_needs SET status=?,revision=revision+1,review_note=?,reviewed_at=?,updated_at=? WHERE id=?',
      p.decision === 'accept' ? 'accepted' : 'rejected', note, now(), now(), n.id);
    this.record('reviewed', { need_id: n.id, decision: p.decision, note }, 'operator'); return { need_id: n.id, ...AUTHORITY };
  }
  workScope(threadId) {
    const link = this.store.get('SELECT l.* FROM audience_work_links l JOIN partner_threads t ON t.id=l.thread_id WHERE l.thread_id=? AND t.partner_id=?', threadId, this.partnerId);
    if (!link) return null;
    let n, basis;
    try {
      n = this.need(link.need_id, { includeWorkCase: false });
      basis = parse(link.basis_json);
      check(!this.basisState(basis).reasons.includes('AUDIENCE_RECORD_INVALID'), 'AUDIENCE_RECORD_INVALID');
    }
    catch (e) {
      if (!(e instanceof AppError) && !(e instanceof SyntaxError)) throw e;
      return { need_id: link.need_id, need_revision: link.need_revision, current: false, reasons: ['AUDIENCE_RECORD_INVALID'],
        evidence_event_ids: [], fingerprint: digest({ link, invalid: true }) };
    }
    const reasons = [...n.reasons];
    if (this.service.audienceReconciliationHealth === false || this.service.audienceReconciliationHealth === null)
      reasons.push('AUDIENCE_RECONCILIATION_UNPROVEN');
    if (n.status !== 'accepted' || n.revision !== link.need_revision) reasons.push('AUDIENCE_WORK_REVISION_STALE');
    if (digest(basis) !== digest(parse(this.store.get('SELECT basis_json FROM audience_needs WHERE id=?', n.id).basis_json))) reasons.push('AUDIENCE_WORK_SCOPE_STALE');
    return { need_id: n.id, need_revision: link.need_revision, current: reasons.length === 0, reasons,
      evidence_event_ids: allRefs(n), fingerprint: digest({ need_id: n.id, revision: link.need_revision, basis, current: !reasons.length, reasons }) };
  }
  temporaryWorkBlock(threadId) {
    const scope = this.workScope(threadId);
    return !!scope && !scope.current && scope.reasons.length > 0 && scope.reasons.every(r => TEMPORARY.has(r));
  }
  openWork(p, refresh = false) {
    this.requireEnabled(); fields(p, ['need_id', 'expected_revision', 'expected_basis_fingerprint']); const n = this.need(p.need_id);
    check(n.current && n.status === 'accepted' && n.revision === p.expected_revision
      && n.basis_fingerprint === p.expected_basis_fingerprint, 'AUDIENCE_STALE_BASIS');
    const selected = allRefs(n), sourceIds = [...new Set(selected.map(ref => sourceEvent(this.service, ref).message.source_id))];
    check(sourceIds.length <= 4 && selected.length <= 32 && sourceIds.every(ref => selected.filter(r => sourceEvent(this.service, r).message.source_id === ref).length <= 8), 'AUDIENCE_WORK_SCOPE_TOO_LARGE');
    check(refresh ? n.thread_id : !n.thread_id, 'AUDIENCE_WORK_LINK_EXISTS');
    const needRow = this.store.get('SELECT * FROM audience_needs WHERE id=?', n.id);
    let threadId;
    if (!refresh) threadId = this.service.continuity.open({ title: n.title, objective: this.goal(n.goal_id).objective,
      success_condition: `Owner-reviewed useful material for this supported need: ${n.title}`,
      source_ids: sourceIds, max_age_seconds: this.goal(n.goal_id).max_age_seconds, initial_evidence_event_ids: selected }).thread_id;
    else {
      threadId = n.thread_id; const thread = this.service.continuity.thread(threadId);
      check(thread.status === 'OPEN', 'AUDIENCE_WORK_THREAD_UNAVAILABLE');
      check(digest(this.service.continuity.watches(threadId).map(w => w.source_ref).sort()) === digest(sourceIds.slice().sort()), 'AUDIENCE_WORK_SCOPE_CHANGED');
      this.service.continuity.changed(thread, ['owner_audience_refresh']);
      this.store.run('UPDATE partner_threads SET memory_turn_id=NULL WHERE id=?', threadId);
      this.store.run('DELETE FROM partner_observations WHERE thread_id=?', threadId);
      for (const ref of selected) this.service.continuity.observe(threadId, sourceEvent(this.service, ref).message.source_id, ref, 'owner_selected_audience');
    }
    this.store.run(`INSERT INTO audience_work_links VALUES(?,?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET
      need_revision=excluded.need_revision,basis_json=excluded.basis_json`, threadId, n.id, n.revision, needRow.basis_json, now());
    const packet = this.service.continuity.detail(threadId);
    this.store.run('UPDATE partner_threads SET dependency_hash=? WHERE id=?', packet.dependency_hash, threadId);
    const capture = this.service.continuity.capture({ thread_id: threadId, expected_revision: packet.revision, expected_basis_fingerprint: packet.basis_fingerprint });
    const hypothesis = start => ({ text: n.hypothesis,
      evidence_event_ids: n.evidence_event_ids.slice(start, start + 16).length ? n.evidence_event_ids.slice(start, start + 16) : [n.evidence_event_ids[0]],
      counterevidence_event_ids: n.counterevidence_event_ids.slice(start, start + 16),
      ...(n.context_event_ids?.length ? { context_event_ids: n.context_event_ids.slice(start, start + 16) } : {}) });
    this.service.continuity.propose({ turn_id: capture.turn_id, output: {
      summary: { text: n.hypothesis, evidence_event_ids: n.evidence_event_ids.slice(0, 16) }, claims: [],
      hypotheses: [hypothesis(0), ...(Math.max(n.evidence_event_ids.length, n.counterevidence_event_ids.length, n.context_event_ids?.length ?? 0) > 16 ? [hypothesis(16)] : [])],
      unknowns: n.unknowns, next: { kind: 'ask_owner', reason: `${n.why_now}\n${n.reason}`.slice(0, 2000), wake_at: null,
        owner_question: `Review this unverified interpretation before opening work: ${n.title}` } } });
    this.record(refresh ? 'work_refreshed' : 'work_opened', { need_id: n.id, thread_id: threadId, turn_id: capture.turn_id }, 'operator');
    return { thread_id: threadId, turn_id: capture.turn_id, ...AUTHORITY };
  }
  assertPreviewImport(p, { replay = false } = {}) {
    this.requireEnabled(); this.service.work.enabled();
    fields(p, ['need_id','expected_revision','expected_basis_fingerprint','case_id','expected_case_revision','expected_preview_sha256']);
    const n = this.need(p.need_id, { includeWorkCase: false });
    check(n.current && n.status === 'accepted' && n.revision === p.expected_revision
      && n.basis_fingerprint === p.expected_basis_fingerprint, 'AUDIENCE_STALE_BASIS');
    check(n.proposal_version === 2 && n.material_preview && n.preview_sha256 === p.expected_preview_sha256, 'AUDIENCE_PREVIEW_HASH_MISMATCH');
    const row = this.service.work.get(p.case_id);
    check(n.thread_id && row.thread_id === n.thread_id, 'AUDIENCE_PREVIEW_CASE_SCOPE');
    this.service.work.current(row);
    const evidence = this.service.work.packet(row).evidence.map(e => e.source_event_id);
    check(allRefs(n).every(ref => evidence.includes(ref)), 'AUDIENCE_PREVIEW_SCOPE');
    const prior = this.store.get(`SELECT payload_json FROM events WHERE partner_id=? AND kind='audience.preview_imported'
      AND payload_json->>'$.need_id'=? AND payload_json->>'$.need_revision'=?
      AND payload_json->>'$.case_id'=? AND payload_json->>'$.preview_sha256'=? ORDER BY id DESC LIMIT 1`,
    this.partnerId, n.id, n.revision, row.id, n.preview_sha256);
    let material = null;
    if (prior) {
      try {
        material = this.service.work.material(parse(prior.payload_json).material_id);
        check(material.case_id === row.id && material.sha256 === n.preview_sha256 && previewHash({ material_preview: material }) === material.sha256
          && material.content === n.material_preview.content && material.title === n.material_preview.title
          && digest(material.evidence_event_ids) === digest(allRefs(n)), 'AUDIENCE_RECORD_INVALID');
      } catch { throw new AppError('AUDIENCE_RECORD_INVALID', 409, 'AUDIENCE_RECORD_INVALID'); }
      // A superseded/rejected material is never silently resurrected by replay/import.
      check(row.material_id === material.id && ['proposed','approved'].includes(material.status)
        && material.turn_id === row.turn_id && material.basis_fingerprint === row.basis_fingerprint, 'AUDIENCE_PREVIEW_SUPERSEDED');
    }
    check(Number.isInteger(p.expected_case_revision) && (row.revision === p.expected_case_revision
      || replay && material?.status === 'proposed' && row.revision === p.expected_case_revision + 1), 'WORK_REVISION_CONFLICT');
    return { n, row, material };
  }
  importPreview(p) {
    const { n, row, material } = this.assertPreviewImport(p);
    if (material) return { need_id: n.id, case_id: row.id, material_id: material.id, sha256: material.sha256, duplicate: true, ...AUTHORITY };
    const result = this.service.work.addMaterial(row, { ...n.material_preview, evidence_event_ids: allRefs(n) });
    this.record('preview_imported', { need_id: n.id, need_revision: n.revision, preview_sha256: n.preview_sha256,
      case_id: row.id, material_id: result.material_id, basis_fingerprint: row.basis_fingerprint }, 'operator');
    return { need_id: n.id, ...result, ...AUTHORITY };
  }
  retire(goalId) {
    for (const n of this.store.all("SELECT id FROM audience_needs WHERE goal_id=? AND status IN ('proposed','accepted')", goalId)) {
      try {
      const state = this.need(n.id);
      const terminal = state.reasons.some(r => ['AUDIENCE_EXCHANGE_CHANGED','AUDIENCE_GOAL_CHANGED','AUDIENCE_SOURCE_REVOKED',
        'AUDIENCE_SOURCE_POLICY_CHANGED','AUDIENCE_ANCHOR_UNSUPPORTED','AUDIENCE_ANCESTRY_INCOMPLETE',
        'AUDIENCE_ANCESTRY_CYCLE','AUDIENCE_ANCESTRY_CHANGED',
        'CONTINUITY_EVIDENCE_SUPERSEDED','CONTINUITY_EVIDENCE_EXPIRED','AUDIENCE_EXCHANGE_CAPACITY','AUDIENCE_RECORD_INVALID'].includes(r));
      if (terminal) this.store.run("UPDATE audience_needs SET status='stale',revision=revision+1,updated_at=? WHERE id=?", now(), n.id);
      } catch (error) {
        if (!(error instanceof AppError) && !(error instanceof SyntaxError)) throw error;
        this.store.run("UPDATE audience_needs SET status='stale',revision=revision+1,updated_at=? WHERE id=?", now(), n.id);
        this.record('quarantined', { need_id: n.id, reason: 'AUDIENCE_RECORD_INVALID' });
      }
    }
    for (const a of this.store.all("SELECT * FROM audience_assessments WHERE goal_id=? AND status IN ('captured','proposed')", goalId)) {
      try {
      const state = this.basisState(parse(a.packet_json).scope);
      if (state.reasons.some(r => !TEMPORARY.has(r))) this.store.run("UPDATE audience_assessments SET status='stale' WHERE id=?", a.id);
      } catch (error) {
        if (!(error instanceof AppError) && !(error instanceof SyntaxError)) throw error;
        this.store.run("UPDATE audience_assessments SET status='stale' WHERE id=?", a.id);
        this.record('quarantined', { assessment_id: a.id, reason: 'AUDIENCE_RECORD_INVALID' });
      }
    }
  }
  reconcile({ limit = 10, event_limit: eventLimit = 20 } = {}) {
    check(Number.isInteger(limit) && limit >= 1 && limit <= 20 && Number.isInteger(eventLimit) && eventLimit >= 1 && eventLimit <= 50, 'AUDIENCE_RECONCILE_LIMIT');
    this.service.audienceReconciliationHealth = null;
    try {
    const result = this.store.transaction(() => {
      const cursor = this.store.get('SELECT cursor FROM channel_offsets WHERE channel=? AND account_id=?', CURSOR, this.partnerId)?.cursor ?? '';
      const page = (after, n, before = null) => this.store.all(`SELECT * FROM audience_goals WHERE partner_id=? AND id>?
        ${before === null ? '' : 'AND id<=?'} ORDER BY id LIMIT ?`, this.partnerId, after, ...(before === null ? [] : [before]), n);
      let goals = page(cursor, limit); if (cursor && goals.length < limit) goals = goals.concat(page('', limit - goals.length, cursor));
      let events = 0;
      for (const goal of goals) {
        for (const watch of this.watches(goal.id)) {
          // Validate the bounded projection before JSON membership queries or intake. One
          // damaged exchange is withheld and audited without suppressing healthy neighbors.
          for (const exchange of this.store.all('SELECT * FROM audience_exchanges WHERE goal_id=? AND source_ref=? LIMIT 100', goal.id, watch.source_ref)) {
            try { this.projection(exchange); }
            catch (error) {
              if (!(error instanceof AppError)) throw error;
              this.quarantineExchange(exchange);
            }
          }
          const health = this.health(watch);
          if (watch.status === 'active' && ['SOURCE_NOT_ALLOWED', 'AUDIENCE_SOURCE_POLICY_CHANGED', 'CONTINUITY_SOURCE_POLICY_CHANGED'].includes(health.reason)) {
            this.store.run("UPDATE audience_watches SET status='revoked',reason=? WHERE goal_id=? AND source_ref=?", health.reason, goal.id, watch.source_ref); continue;
          }
          if (!health.current || !this.enabled() || goal.status !== 'OPEN') continue;
          const incoming = this.store.all(`SELECT id FROM events WHERE partner_id=? AND kind='source.message' AND actor='system'
            AND payload_json->>'$.source_id'=? AND id>? ORDER BY id LIMIT ?`, this.partnerId, watch.source_ref, watch.cursor, eventLimit);
          this.intake(goal, watch, incoming); events += incoming.length;
          if (incoming.length) this.store.run('UPDATE audience_watches SET cursor=? WHERE goal_id=? AND source_ref=?', incoming.at(-1).id, goal.id, watch.source_ref);
        }
        // A lagging unrelated source must not durably stale another source's need; per-need assertBasis scopes it.
        this.retire(goal.id);
      }
      if (goals.length) this.store.run('INSERT INTO channel_offsets VALUES(?,?,?) ON CONFLICT(channel,account_id) DO UPDATE SET cursor=excluded.cursor', CURSOR, this.partnerId, goals.at(-1).id);
      return { goals: goals.length, events };
    });
    this.service.audienceReconciliationHealth = true; return result;
    } catch (error) { this.service.audienceReconciliationHealth = false; throw error; }
  }
  command(action, p, actor) {
    check(actor?.kind === 'operator', 'AUDIENCE_OPERATOR_REQUIRED', 403);
    if (action === 'audience.open') return this.open(p);
    if (action === 'audience.pause') return this.pause(p);
    if (action === 'audience.capture') return this.capture(p);
    if (action === 'audience.propose') return this.propose(p);
    if (action === 'audience.review') return this.review(p);
    if (action === 'audience.open_work') return this.openWork(p);
    if (action === 'audience.refresh_work') return this.openWork(p, true);
    if (action === 'audience.import_preview') return this.importPreview(p);
    check(false, 'AUDIENCE_COMMAND_UNKNOWN', 400);
  }
}
