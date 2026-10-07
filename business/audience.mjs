// Domain projection over canonical normalized events, not a Telegram parser or a job engine.
import path from 'node:path';
import Ajv from 'ajv';
import { ROOT, readJson } from './config.mjs';
import { id } from './store.mjs';
import { ensure, requiredText, now, AppError } from './errors.mjs';
import { sourceRows, sourceEvent, digest } from './source-ingestion.mjs';
import { effectiveSourceConfig } from './scout-policy.mjs';
import { proposalRefs, proposalBindings, previewHash, frozenProposalBasis } from './audience-proposals.mjs';
import { normalizeFailureCause } from './failure-cause.mjs';
import { decisionBindings, assessmentDecision } from './audience-decisions.mjs';
import { currentBasis, currentBasisState } from './audience-current-events.mjs';
import { FOLLOWUP_TEMPORARY } from './audience-followup.mjs';
import { watchEpoch, sourceRenewalPreview, assertRenewalRequest, renewSource } from './audience-source-renewal.mjs';
import { sourceObservationFloor } from './source-observation-epochs.mjs';
import { firstContactState, reviewFirstContact, assertFirstContactReview, commitFirstContactHead } from './first-contact-review.mjs';

const storedOutputSchema = readJson(path.join(ROOT, 'contracts/audience-assessment.schema.json'));
export const outputSchema = structuredClone(storedOutputSchema);
outputSchema.properties.needs.items.required.push('proposal_version', 'context_event_ids', 'context_review');
const validator = new Ajv({ strict: true, allowUnionTypes: true });
export const validateOutput = validator.compile(storedOutputSchema);
const validateLegacyModelOutput = validator.compile(structuredClone(outputSchema));
outputSchema.required.push('decision_review');
const validateModelOutput = validator.compile(outputSchema);
const validateReassessment = validator.compile(readJson(path.join(ROOT, 'contracts/audience-reassessment.schema.json')));
const validateReasoningRetry = validator.compile(readJson(path.join(ROOT, 'contracts/audience-reasoning-retry.schema.json')));
const check = (ok, code, status = 409) => ensure(ok, code, status, code);
const fields = (p, keys) => check(p && typeof p === 'object' && !Array.isArray(p)
  && Object.keys(p).every(k => keys.includes(k)), 'AUDIENCE_FIELDS_INVALID', 400);
const parse = JSON.parse, CURSOR = 'audience-reconcile-v1', BATCH = 8, MEMBERS = 32;
const AUTHORITY = Object.freeze({ executable: false, contact_permission: false, allowed_effects: [] });
const allRefs = proposalRefs;
const TEMPORARY = new Set(['AUDIENCE_SCOPE_BACKLOG','AUDIENCE_RECONCILIATION_UNPROVEN',
  'SOURCE_TRANSPORT_NOT_CURRENT','SOURCE_TRANSPORT_STALE','SOURCE_TRANSPORT_NOT_READY','SOURCE_TRANSPORT_DIRTY',
  'CONTINUITY_SOURCE_UNAVAILABLE','AUDIENCE_DISABLED']);
const sampleExchanges = pools => {
  const selected = [], content = new Set();
  for (let i = 0; i < BATCH && selected.length < BATCH; i++) for (const pool of pools) {
    if (selected.length >= BATCH) break;
    const e = pool[i]; if (!e) continue;
    const key = digest(e.evidence.map(s => s.text.trim().replace(/\s+/g, ' ')));
    if (content.has(key)) continue;
    content.add(key); selected.push(e);
  }
  return selected;
};

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
  sourceRenewalPreview(p) { return sourceRenewalPreview(this,p); }
  assertSourceRenewalRequest(p,previous = null) { return assertRenewalRequest(this,p,previous); }
  watchObservationFloor(watch) {
    try { return watchEpoch(this,watch)?.observation_floor ?? 0; }
    catch (error) { if (!(error instanceof AppError)) throw error; return Number.MAX_SAFE_INTEGER; }
  }
  watchAuthority(watch) {
    if (watch.status === 'revoked') return { current: false, reason: watch.reason ?? 'AUDIENCE_SOURCE_REVOKED' };
    const allowed = effectiveSourceConfig(this.service).opportunity.allowedSourceRefs;
    let epoch, invalid = false;
    let currentPolicy;
    try { epoch = watchEpoch(this,watch); currentPolicy = this.policyHash(watch.source_ref); }
    catch (error) { if (!(error instanceof AppError)) throw error; invalid = true; }
    const reason = invalid ? 'AUDIENCE_WATCH_EPOCH_INVALID' : !allowed.includes(watch.source_ref) ? 'SOURCE_NOT_ALLOWED'
      : currentPolicy !== (epoch?.source_policy_hash ?? watch.policy_hash) ? 'AUDIENCE_SOURCE_POLICY_CHANGED' : null;
    if (reason) {
      const changed = this.store.run("UPDATE audience_watches SET status='revoked',reason=? WHERE goal_id=? AND source_ref=? AND status='active'", reason, watch.goal_id, watch.source_ref);
      if (changed.changes) this.record('watch_revoked', { goal_id: watch.goal_id, source_ref: watch.source_ref, reason });
      return { current: false, reason };
    }
    return { current: true, reason: null };
  }
  health(watch) {
    const authority = this.watchAuthority(watch);
    if (!authority.current) return authority;
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
    for (const ref of sourceIds) this.store.run("INSERT INTO audience_watches VALUES(?,?,?,?,'active',NULL)", goalId, ref, this.policyHash(ref),sourceObservationFloor(this.service,ref));
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
    const floor = watch ? this.watchObservationFloor(watch) : Number.MAX_SAFE_INTEGER;
    const selectedIds = state.evidence.filter(ref => Number(ref) > floor);
    if (state.evidence.length && !selectedIds.length) reasons.push('AUDIENCE_EVIDENCE_BEFORE_RENEWAL');
    const evidence = [...this.service.continuity.evidenceStates({ max_age_seconds: goal.max_age_seconds },
      watch ? [{ ...watch, policy_hash: this.service.continuity.policyHash(watch.source_ref) }] : [], selectedIds).values()];
    if (!evidence.length) reasons.push('AUDIENCE_NO_SUPPORTED_EVIDENCE');
    if (evidence.length !== selectedIds.length) reasons.push('AUDIENCE_EVIDENCE_STALE');
    for (const e of evidence) if (!e.current) reasons.push(...e.reasons);
    if (watch && this.service.continuity.head(watch.source_ref) > watch.cursor) reasons.push('AUDIENCE_SCOPE_BACKLOG');
    return { id: exchange.id, source_ref: exchange.source_ref, anchor_id: exchange.anchor_id,
      fingerprint: exchange.fingerprint, current: reasons.length === 0, reasons: [...new Set(reasons)], evidence,
      unsupported_count: state.unsupported_count, coverage: 'bounded_explicit_reply_exchange_not_complete_history',
      considered: exchange.considered_fingerprint === exchange.fingerprint };
  }
  basis(goal, exchanges) {
    if (exchanges.some(e => e.evidence_scope === 'current_events_with_structural_ancestry_v1')) {
      check(exchanges.every(e => e.evidence_scope === 'current_events_with_structural_ancestry_v1'), 'AUDIENCE_RECORD_INVALID');
      return currentBasis(this, goal, exchanges);
    }
    const watches = this.watches(goal.id);
    return { goal_id: goal.id, revision: goal.revision,
      exchanges: exchanges.map(e => ({ id: e.id, fingerprint: e.fingerprint, source_ref: e.source_ref })),
      policies: [...new Set(exchanges.map(e => e.source_ref))].sort().map(ref => [ref, watches.find(w => w.source_ref === ref)?.policy_hash]) };
  }
  basisState(basis) {
    if (basis?.version === 2) return currentBasisState(this, basis);
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
      && w.status === 'active' && w.policy_hash === policy && this.watchAuthority(w).current))) reasons.push('AUDIENCE_SOURCE_REVOKED');
    return { current: reasons.length === 0, reasons: [...new Set(reasons)] };
  }
  assertBasis(basis) {
    check(this.basisState(basis).current, 'AUDIENCE_STALE_BASIS'); return this.goal(basis.goal_id);
  }
  hypothesisMemory(need) {
    return { id: need.id, revision: need.revision, status: need.status, title: need.title,
      hypothesis: need.hypothesis.slice(0, 600), next_step: need.next_step,
      basis_current: need.current, epistemic_status: 'unverified_interpretation',
      semantic_role: 'hypothesis_memory_not_source_evidence', hypothesis_truncated: need.hypothesis.length > 600,
      resolution: 'unknown' };
  }
  observationHeads(goalId) {
    return this.watches(goalId).map(w => [w.source_ref, this.service.continuity.head(w.source_ref)]);
  }
  reassessmentFingerprint(scope, focus) {
    return digest({ purpose: 'need_reassessment_v1', scope, need_id: focus.need_id,
      need_revision: focus.need_revision, need_basis_fingerprint: focus.need_basis_fingerprint,
      observation_heads: focus.observation_heads });
  }
  reassessmentAttemptFingerprint(scope, focus) {
    const context = this.reassessmentFingerprint(scope, focus);
    return focus.retry_of ? digest({ purpose: 'explicit_reassessment_retry_v1',
      context_fingerprint: context, retry_of: focus.retry_of }) : context;
  }
  assessmentRecord(assessmentId) {
    const row = this.store.get('SELECT a.* FROM audience_assessments a JOIN audience_goals g ON g.id=a.goal_id WHERE a.id=? AND g.partner_id=?', assessmentId, this.partnerId);
    check(row, 'AUDIENCE_ASSESSMENT_NOT_FOUND', 404); return row;
  }
  failedReassessment(row) {
    check(['interrupted','invalid'].includes(row.status) && row.producer === 'model', 'AUDIENCE_RETRY_UNAVAILABLE');
    check(typeof row.run_id === 'string', 'AUDIENCE_RECORD_INVALID');
    let packet, frozen, receipt;
    const run = this.store.get('SELECT * FROM runs WHERE id=? AND partner_id=?', row.run_id, this.partnerId);
    check(run && run.runtime === 'hermes-audience-v1', 'AUDIENCE_RECORD_INVALID');
    check(['failed','interrupted'].includes(run.status), 'AUDIENCE_RETRY_UNAVAILABLE');
    try { packet = row.packet ?? parse(row.packet_json); frozen = parse(run.context_json);
      receipt = run.result_json ? parse(run.result_json) : null; }
    catch { check(false, 'AUDIENCE_RECORD_INVALID'); }
    check(packet && validateReassessment(packet.reassessment) && packet.scope
      && packet.id === row.goal_id && packet.assessment_id === row.id
      && packet.basis_fingerprint === row.basis_fingerprint
      && this.reassessmentFingerprint(packet.scope, packet.reassessment) === packet.reassessment.context_fingerprint
      && this.reassessmentAttemptFingerprint(packet.scope, packet.reassessment) === row.basis_fingerprint,
    'AUDIENCE_RECORD_INVALID');
    check(frozen && frozen.assessment_id === row.id && frozen.goal_id === row.goal_id
      && frozen.packet && digest(frozen.packet) === digest(packet)
      && (!receipt || receipt && typeof receipt === 'object' && !Array.isArray(receipt)
        && !['proposal_created','no_revision_proposed','no_need_proposed'].includes(receipt.disposition)), 'AUDIENCE_RECORD_INVALID');
    return { row, packet, run };
  }
  attemptReceipt(row) {
    if (typeof row.run_id !== 'string') return null;
    const run = this.store.get('SELECT * FROM runs WHERE id=? AND partner_id=?', row.run_id, this.partnerId);
    if (!run || run.runtime !== 'hermes-audience-v1') return null;
    let context, result;
    try { context = parse(run.context_json); result = run.result_json ? parse(run.result_json) : null; }
    catch { return null; }
    if (!context || context.assessment_id !== row.id || context.goal_id !== row.goal_id) return null;
    const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
    const input = count(run.input_tokens), output = count(run.output_tokens);
    const estimated = ['configured_estimate','runtime_estimate'].includes(run.cost_status) && Number.isFinite(run.estimated_cost_usd) && run.estimated_cost_usd >= 0;
    return { run_id: run.id, status: run.status,
      model_api_calls: Number.isInteger(result?.model_api_calls) && result.model_api_calls >= 0 && result.model_api_calls <= 1000 ? result.model_api_calls : null,
      input_tokens: input, output_tokens: output,
      usage_status: input !== null && output !== null && (input > 0 || output > 0 || estimated) ? 'known' : 'unknown',
      cost_status: estimated ? run.cost_status : 'unknown', estimated_cost_usd: estimated ? run.estimated_cost_usd : null,
      failure_cause: result?.failure_cause ? normalizeFailureCause(result.failure_cause) : null };
  }
  retryState(row) {
    const reasons = []; let eligible = false, child = null;
    try {
      const parent = this.failedReassessment(row); this.assertAssessmentCurrent(row); eligible = true;
      const focus = { ...parent.packet.reassessment, retry_of: { assessment_id: row.id, basis_fingerprint: row.basis_fingerprint } };
      const basis = this.reassessmentAttemptFingerprint(parent.packet.scope, focus);
      child = this.store.get('SELECT id,status FROM audience_assessments WHERE goal_id=? AND basis_fingerprint=?', row.goal_id, basis) ?? null;
      if (child) reasons.push('AUDIENCE_ALREADY_CONSIDERED');
      if (this.store.get("SELECT id FROM audience_assessments WHERE goal_id=? AND status IN ('captured','running') LIMIT 1", row.goal_id)) reasons.push('AUDIENCE_ASSESSMENT_PENDING');
      this.service.control.assertModelBudget({ runtime: 'hermes-audience-v1', maxRunsPerDay: this.service.config.audience.maxRunsPerDay });
    } catch (error) {
      if (!(error instanceof AppError) && !(error instanceof SyntaxError)) throw error;
      reasons.push(error.code ?? 'AUDIENCE_RECORD_INVALID');
    }
    if (!this.enabled()) reasons.push('AUDIENCE_DISABLED');
    if (this.service.config.audience?.modelEnabled !== true) reasons.push('AUDIENCE_MODEL_DISABLED');
    if (this.service.config.controlPlane?.enabled !== true) reasons.push('AUDIENCE_CONTROL_REQUIRED');
    return { kind: 'focused', context_fingerprint: row.packet?.reassessment?.context_fingerprint
      ?? (() => { try { return parse(row.packet_json).reassessment?.context_fingerprint ?? null; } catch { return null; } })(),
      eligible, available: eligible && reasons.length === 0, reasons: [...new Set(reasons)], child_assessment: child };
  }
  assertRetryRequest(p) {
    this.requireEnabled(); fields(p, ['assessment_id','expected_basis_fingerprint','expected_context_fingerprint','reason']);
    check(this.service.config.audience?.modelEnabled === true, 'AUDIENCE_MODEL_DISABLED');
    check(this.service.config.controlPlane?.enabled === true, 'AUDIENCE_CONTROL_REQUIRED');
    check(typeof p.assessment_id === 'string' && p.assessment_id.length > 0 && p.assessment_id.length <= 36
      && typeof p.reason === 'string' && p.reason.trim().length > 0 && p.reason.length <= 500, 'AUDIENCE_FIELDS_INVALID', 400);
    const row = this.assessmentRecord(p.assessment_id), parent = this.failedReassessment(row);
    check(row.basis_fingerprint === p.expected_basis_fingerprint, 'AUDIENCE_STALE_BASIS');
    this.assertAssessmentCurrent(row);
    const context = this.reassessmentContext(parent.packet.reassessment.need_id);
    check(context.available && context.context_fingerprint === p.expected_context_fingerprint
      && context.context_fingerprint === parent.packet.reassessment.context_fingerprint, 'AUDIENCE_STALE_BASIS');
    return { ...parent, context };
  }
  retryReassessment(p) {
    const { row, packet: previous, context } = this.assertRetryRequest(p);
    const packet = structuredClone(previous), assessmentId = id();
    packet.assessment_id = assessmentId;
    packet.reassessment.retry_of = { assessment_id: row.id, basis_fingerprint: row.basis_fingerprint };
    const basis = this.reassessmentAttemptFingerprint(packet.scope, packet.reassessment);
    check(!this.store.get('SELECT id FROM audience_assessments WHERE goal_id=? AND basis_fingerprint=?', row.goal_id, basis), 'AUDIENCE_ALREADY_CONSIDERED');
    check(!context.pending_assessment, 'AUDIENCE_ASSESSMENT_PENDING');
    this.service.control.assertModelBudget({ runtime: 'hermes-audience-v1', maxRunsPerDay: this.service.config.audience.maxRunsPerDay });
    packet.basis_fingerprint = basis;
    this.store.run("INSERT INTO audience_assessments VALUES(?,?,?,?,'captured','operator',NULL,NULL,?)", assessmentId, row.goal_id, basis, JSON.stringify(packet), now());
    this.record('reassessment_retry_requested', { assessment_id: assessmentId, retry_of: row.id,
      parent_basis_fingerprint: row.basis_fingerprint, context_fingerprint: context.context_fingerprint,
      reason: p.reason.trim(), max_model_turns: 1 }, 'operator');
    return { assessment_id: assessmentId, retry_of: row.id, ...AUTHORITY };
  }
  ordinaryAttemptFingerprint(packet) {
    const context = digest(packet.scope);
    return packet.reasoning_retry ? digest({ purpose: 'explicit_audience_retry_v1', context_fingerprint: context,
      retry_of: packet.reasoning_retry.retry_of }) : context;
  }
  ordinaryPacketProof(row) {
    let packet;
    try { packet = row.packet ?? parse(row.packet_json); } catch { check(false, 'AUDIENCE_RECORD_INVALID'); }
    check(packet && typeof packet === 'object' && !Array.isArray(packet) && !packet.reassessment && packet.scope, 'AUDIENCE_RECORD_INVALID');
    if (packet.reasoning_retry !== undefined) check(validateReasoningRetry(packet.reasoning_retry)
      && packet.reasoning_retry.context_fingerprint === digest(packet.scope), 'AUDIENCE_RECORD_INVALID');
    check(packet.id === row.goal_id
      && packet.assessment_id === row.id && packet.proposal_contract_version === 2
      && packet.basis_fingerprint === row.basis_fingerprint
      && this.ordinaryAttemptFingerprint(packet) === row.basis_fingerprint, 'AUDIENCE_RECORD_INVALID');
    return packet;
  }
  failedOrdinary(row) {
    check(['interrupted','invalid'].includes(row.status) && row.producer === 'model', 'AUDIENCE_RETRY_UNAVAILABLE');
    const packet = this.ordinaryPacketProof(row);
    const run = this.store.get('SELECT * FROM runs WHERE id=? AND partner_id=?', row.run_id, this.partnerId);
    check(run && run.runtime === 'hermes-audience-v1', 'AUDIENCE_RECORD_INVALID');
    check(['failed','interrupted'].includes(run.status), 'AUDIENCE_RETRY_UNAVAILABLE');
    let frozen, receipt;
    try { frozen = parse(run.context_json); receipt = run.result_json ? parse(run.result_json) : null; }
    catch { check(false, 'AUDIENCE_RECORD_INVALID'); }
    check(frozen?.assessment_id === row.id && frozen.goal_id === row.goal_id && frozen.packet && digest(frozen.packet) === digest(packet)
      && (!receipt || typeof receipt === 'object' && !Array.isArray(receipt)
        && !['proposal_created','no_revision_proposed','no_need_proposed'].includes(receipt.disposition)), 'AUDIENCE_RECORD_INVALID');
    if (!packet.reasoning_retry) this.service.attention.assertHistory(run.id, row, frozen.attention_grant);
    else check(!frozen.attention_grant && !this.store.get('SELECT run_id FROM audience_attention_attempts WHERE run_id=?', run.id), 'AUDIENCE_RECORD_INVALID');
    return { row, packet, run };
  }
  ordinaryRetryState(row) {
    const reasons = []; let eligible = false, child = null, context = null;
    try {
      const parent = this.failedOrdinary(row); context = digest(parent.packet.scope);
      this.assertAssessmentCurrent(row);
      check(this.service.attention.scope(row.goal_id).fingerprint !== null, 'AUDIENCE_STALE_BASIS'); eligible = true;
      const packet = { ...parent.packet, reasoning_retry: { version: 1, model_requested: true,
        retry_of: { assessment_id: row.id, basis_fingerprint: row.basis_fingerprint }, context_fingerprint: context } };
      child = this.store.get('SELECT id,status FROM audience_assessments WHERE goal_id=? AND basis_fingerprint=?', row.goal_id, this.ordinaryAttemptFingerprint(packet)) ?? null;
      if (child) reasons.push('AUDIENCE_ALREADY_CONSIDERED');
      if (this.store.get("SELECT id FROM audience_assessments WHERE goal_id=? AND status IN ('captured','running') LIMIT 1", row.goal_id)) reasons.push('AUDIENCE_ASSESSMENT_PENDING');
      this.service.control.assertModelBudget({ runtime: 'hermes-audience-v1', maxRunsPerDay: this.service.config.audience.maxRunsPerDay });
    } catch (error) {
      if (!(error instanceof AppError) && !(error instanceof SyntaxError)) throw error;
      reasons.push(error.code ?? 'AUDIENCE_RECORD_INVALID');
    }
    if (!this.enabled()) reasons.push('AUDIENCE_DISABLED');
    if (this.service.config.audience?.modelEnabled !== true) reasons.push('AUDIENCE_MODEL_DISABLED');
    if (this.service.config.controlPlane?.enabled !== true) reasons.push('AUDIENCE_CONTROL_REQUIRED');
    return { kind: 'ordinary', context_fingerprint: context, eligible, available: eligible && reasons.length === 0,
      reasons: [...new Set(reasons)], child_assessment: child };
  }
  assertOrdinaryRetryRequest(p) {
    this.requireEnabled(); fields(p, ['assessment_id','expected_basis_fingerprint','expected_context_fingerprint','reason']);
    check(this.service.config.audience?.modelEnabled === true, 'AUDIENCE_MODEL_DISABLED');
    check(this.service.config.controlPlane?.enabled === true, 'AUDIENCE_CONTROL_REQUIRED');
    check(typeof p.assessment_id === 'string' && p.assessment_id.length > 0 && p.assessment_id.length <= 36
      && typeof p.expected_context_fingerprint === 'string'
      && typeof p.reason === 'string' && p.reason.trim().length > 0 && p.reason.length <= 500, 'AUDIENCE_FIELDS_INVALID', 400);
    const parent = this.failedOrdinary(this.assessmentRecord(p.assessment_id));
    check(parent.row.basis_fingerprint === p.expected_basis_fingerprint, 'AUDIENCE_STALE_BASIS');
    this.assertAssessmentCurrent(parent.row);
    check(digest(parent.packet.scope) === p.expected_context_fingerprint, 'AUDIENCE_STALE_BASIS');
    check(this.service.attention.scope(parent.row.goal_id).fingerprint !== null, 'AUDIENCE_STALE_BASIS');
    return parent;
  }
  retryAssessment(p) {
    const { row, packet: previous } = this.assertOrdinaryRetryRequest(p);
    const packet = structuredClone(previous), assessmentId = id();
    packet.assessment_id = assessmentId;
    packet.reasoning_retry = { version: 1, model_requested: true,
      retry_of: { assessment_id: row.id, basis_fingerprint: row.basis_fingerprint }, context_fingerprint: digest(packet.scope) };
    const basis = this.ordinaryAttemptFingerprint(packet);
    check(!this.store.get('SELECT id FROM audience_assessments WHERE goal_id=? AND basis_fingerprint=?', row.goal_id, basis), 'AUDIENCE_ALREADY_CONSIDERED');
    check(!this.store.get("SELECT id FROM audience_assessments WHERE goal_id=? AND status IN ('captured','running')", row.goal_id), 'AUDIENCE_ASSESSMENT_PENDING');
    this.service.control.assertModelBudget({ runtime: 'hermes-audience-v1', maxRunsPerDay: this.service.config.audience.maxRunsPerDay });
    packet.basis_fingerprint = basis;
    packet.reasoning_model_fingerprint = digest(this.service.attention.modelScope());
    this.store.run("INSERT INTO audience_assessments VALUES(?,?,?,?,'captured','operator',NULL,NULL,?)", assessmentId, row.goal_id, basis, JSON.stringify(packet), now());
    this.record('assessment_retry_requested', { assessment_id: assessmentId, retry_of: row.id,
      parent_basis_fingerprint: row.basis_fingerprint, context_fingerprint: digest(packet.scope),
      reason: p.reason.trim(), max_model_turns: 1 }, 'operator');
    return { assessment_id: assessmentId, retry_of: row.id, ...AUTHORITY };
  }
  cancelAssessment(p) {
    fields(p, ['assessment_id','expected_basis_fingerprint']); const row = this.assessmentRecord(p.assessment_id);
    this.ordinaryPacketProof(row);
    check(row.basis_fingerprint === p.expected_basis_fingerprint, 'AUDIENCE_STALE_BASIS');
    check(['captured','running'].includes(row.status), 'AUDIENCE_ASSESSMENT_UNAVAILABLE');
    this.store.run("UPDATE audience_assessments SET status='interrupted' WHERE id=?", row.id);
    this.record('assessment_canceled', { assessment_id: row.id }, 'operator');
    return { assessment_id: row.id, ...AUTHORITY };
  }
  reassessmentContext(needId) {
    const need = this.need(needId, { includeWorkCase: false }), goal = this.goal(need.goal_id);
    const stored = this.store.get('SELECT basis_json FROM audience_needs WHERE id=?', needId);
    const previous = parse(stored.basis_json);
    // Shape validation also rejects forged historical scopes. Superseded source versions
    // may be reread, but missing/revoked necessary ancestry cannot become evidence.
    check(!this.basisState(previous).reasons.includes('AUDIENCE_RECORD_INVALID'), 'AUDIENCE_RECORD_INVALID');
    const reasons = [];
    if (need.status === 'rejected') reasons.push('AUDIENCE_REJECTED_NEED');
    const prior = previous.exchanges.map(e => {
      const row = this.store.get('SELECT * FROM audience_exchanges WHERE id=? AND goal_id=?', e.id, goal.id);
      if (!row || row.source_ref !== e.source_ref) { reasons.push('AUDIENCE_EXCHANGE_CHANGED'); return null; }
      const current = this.exchangeState(goal, row);
      reasons.push(...current.reasons); return current;
    }).filter(Boolean);
    const oldAssessment = this.store.get('SELECT packet_json FROM audience_assessments WHERE id=? AND goal_id=?', need.assessment_id, goal.id);
    check(oldAssessment, 'AUDIENCE_RECORD_INVALID');
    const oldPacket = parse(oldAssessment.packet_json), previousHeads = oldPacket.reassessment?.observation_heads ?? oldPacket.observation_heads;
    // Legacy packets did not record a whole-source head. Starting at zero is
    // explicitly an unknown legacy window, not invented precision or newness.
    const baselineKnown = Array.isArray(previousHeads) && previousHeads.length > 0
      && previousHeads.every(p => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && Number.isInteger(p[1]) && p[1] >= 0);
    check(previousHeads === undefined || baselineKnown && new Set(previousHeads.map(p => p[0])).size === previousHeads.length
      && previousHeads.every(([ref, head]) => this.watches(goal.id).some(w => w.source_ref === ref)
        && head <= this.service.continuity.head(ref)), 'AUDIENCE_RECORD_INVALID');
    const floors = new Map(baselineKnown ? previousHeads : []), watches = this.watches(goal.id);
    const sourceCursor = this.store.get('SELECT cursor FROM channel_offsets WHERE channel=? AND account_id=?', 'audience-packet-source-v1', goal.id)?.cursor;
    const start = watches.findIndex(w => w.source_ref === sourceCursor) + 1;
    const rotated = watches.slice(start).concat(watches.slice(0, start));
    const queues = rotated.map(w => this.store.all(`SELECT * FROM audience_exchanges WHERE goal_id=? AND source_ref=?
      AND last_event_id>? ORDER BY last_event_id DESC LIMIT 100`, goal.id, w.source_ref, floors.get(w.source_ref) ?? 0)
      .map(e => this.exchangeState(goal, e, w)));
    const previousIds = new Set(prior.map(e => e.id));
    // Discovery's considered flag must not hide later context from a remembered need.
    const candidates = sampleExchanges(queues.map(q => q.filter(e => e.current && !previousIds.has(e.id))));
    const remaining = Math.max(0, BATCH - prior.length), fresh = candidates.slice(0, remaining);
    if (!remaining && candidates.length) reasons.push('AUDIENCE_CONTEXT_CAPACITY');
    const exchanges = [...prior, ...fresh], scope = this.basis(goal, exchanges);
    reasons.push(...this.basisState(scope).reasons);
    const focus = { need_id: need.id, need_revision: need.revision,
      need_basis_fingerprint: need.basis_fingerprint, observation_heads: this.observationHeads(goal.id) };
    const pending = this.store.get("SELECT id,status FROM audience_assessments WHERE goal_id=? AND status IN ('captured','running') ORDER BY rowid LIMIT 1", goal.id) ?? null;
    return { ...focus, context_fingerprint: this.reassessmentFingerprint(scope, focus),
      available: reasons.length === 0, current: reasons.length === 0, reasons: [...new Set(reasons)],
      prior_exchange_ids: prior.map(e => e.id), new_exchange_ids: fresh.map(e => e.id), exchanges, scope,
      hypothesis_memory: this.hypothesisMemory(need), pending_assessment: pending,
      model_enabled: this.service.config.audience?.modelEnabled === true && this.service.config.controlPlane?.enabled === true,
      coverage: { batch_exchanges: BATCH, max_messages_per_exchange: MEMBERS,
        source_completeness: 'unknown', selection: 'prior_basis_plus_latest_fair_changed_exchanges',
        baseline: baselineKnown ? 'previous_assessment_source_heads' : 'legacy_window_unknown',
        omitted_sample_exchanges: candidates.length - fresh.length,
        withheld_exchanges: queues.flat().filter(e => !e.current).slice(0, BATCH).map(e => ({ id: e.id, reasons: e.reasons })),
        interpretation: 'prior_hypothesis_is_not_source_evidence', resolution: 'unknown' }, ...AUTHORITY };
  }
  assertReassessmentRequest(p) {
    this.requireEnabled();
    fields(p, ['need_id','expected_revision','expected_basis_fingerprint','expected_context_fingerprint']);
    check(this.service.config.audience?.modelEnabled === true, 'AUDIENCE_MODEL_DISABLED');
    check(this.service.config.controlPlane?.enabled === true, 'AUDIENCE_CONTROL_REQUIRED');
    const context = this.reassessmentContext(p.need_id);
    check(context.available && context.need_revision === p.expected_revision
      && context.need_basis_fingerprint === p.expected_basis_fingerprint
      && context.context_fingerprint === p.expected_context_fingerprint, 'AUDIENCE_STALE_BASIS');
    return context;
  }
  reassess(p) {
    const context = this.assertReassessmentRequest(p), goal = this.goal(context.scope.goal_id);
    check(!this.store.get('SELECT id FROM audience_assessments WHERE goal_id=? AND basis_fingerprint=?', goal.id, context.context_fingerprint), 'AUDIENCE_ALREADY_CONSIDERED');
    check(!context.pending_assessment, 'AUDIENCE_ASSESSMENT_PENDING');
    const assessmentId = id();
    const packet = { id: goal.id, revision: goal.revision, title: goal.title, objective: goal.objective,
      assessment_id: assessmentId, proposal_contract_version: 2, basis_fingerprint: context.context_fingerprint,
      scope: context.scope, exchanges: context.exchanges, needs: [context.hypothesis_memory], coverage: context.coverage,
      reassessment: { version: 1, model_requested: true, need_id: context.need_id,
        need_revision: context.need_revision, need_basis_fingerprint: context.need_basis_fingerprint,
        context_fingerprint: context.context_fingerprint, observation_heads: context.observation_heads }, ...AUTHORITY };
    check(Buffer.byteLength(JSON.stringify(packet)) <= 600000, 'AUDIENCE_PACKET_TOO_LARGE');
    this.store.run("INSERT INTO audience_assessments VALUES(?,?,?,?,'captured','operator',NULL,NULL,?)", assessmentId, goal.id, context.context_fingerprint, JSON.stringify(packet), now());
    // A focused attempt does not consume another opportunity's discovery slot.
    this.record('reassessment_requested', { assessment_id: assessmentId, need_id: context.need_id,
      need_revision: context.need_revision, context_fingerprint: context.context_fingerprint }, 'operator');
    return { assessment_id: assessmentId, ...AUTHORITY };
  }
  cancelReassessment(p) {
    fields(p, ['assessment_id','expected_basis_fingerprint']); const a = this.assessment(p.assessment_id);
    check(validateReassessment(a.packet.reassessment) && a.basis_fingerprint === p.expected_basis_fingerprint,
      'AUDIENCE_REASSESSMENT_SCOPE');
    check(['captured','running'].includes(a.status), 'AUDIENCE_ASSESSMENT_UNAVAILABLE');
    this.store.run("UPDATE audience_assessments SET status='interrupted' WHERE id=?", a.id);
    this.record('reassessment_canceled', { assessment_id: a.id, need_id: a.packet.reassessment.need_id }, 'operator');
    return { assessment_id: a.id, ...AUTHORITY };
  }
  detail(goalId, { hypothesisMemory = false } = {}) {
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
    const exchanges = sampleExchanges(pools);
    const basis = this.basis(goal, exchanges);
    const needs = this.store.all('SELECT id FROM audience_needs WHERE goal_id=? ORDER BY updated_at DESC LIMIT 100', goal.id)
      .map(n => this.need(n.id, { includeWorkCase: !hypothesisMemory })).map(n => hypothesisMemory ? this.hypothesisMemory(n) : n);
    const assessments = this.store.all('SELECT id,status,producer,created_at,packet_json FROM audience_assessments WHERE goal_id=? ORDER BY rowid DESC LIMIT 10', goal.id)
      .map(({ packet_json, ...a }) => {
        try { const focus = parse(packet_json).reassessment; return { ...a, ...(focus ? { reassessment: focus } : {}) }; }
        catch { return { ...a, reason: 'AUDIENCE_RECORD_INVALID' }; }
      });
    return { ...goal, watches: projected, exchanges, needs, assessments, backlog,
      ...(!hypothesisMemory ? { attention: this.service.attention.summary(goalId) } : {}),
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
    const packet = this.detail(p.goal_id, { hypothesisMemory: true });
    check(packet.ready && (p.expected_revision === undefined || packet.revision === p.expected_revision)
      && packet.basis_fingerprint === p.expected_basis_fingerprint, 'AUDIENCE_STALE_BASIS');
    check(!this.store.get('SELECT id FROM audience_assessments WHERE goal_id=? AND basis_fingerprint=?', packet.id, packet.basis_fingerprint), 'AUDIENCE_ALREADY_CONSIDERED');
    check(!this.store.get("SELECT id FROM audience_assessments WHERE goal_id=? AND status IN ('captured','running')", packet.id), 'AUDIENCE_ASSESSMENT_PENDING');
    check(Buffer.byteLength(JSON.stringify(packet)) <= 600000, 'AUDIENCE_PACKET_TOO_LARGE');
    packet.scope = this.basis(this.goal(packet.id), packet.exchanges);
    packet.observation_heads = this.observationHeads(packet.id);
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
  assertAssessmentCurrent(row) {
    const packet = row.packet ?? parse(row.packet_json);
    check(packet && typeof packet === 'object' && !Array.isArray(packet), 'AUDIENCE_RECORD_INVALID');
    if (packet.followup !== undefined || packet.scope?.version === 2) {
      this.service.followup.assertPacket(row, { live: !['proposed','stale'].includes(row.status) });
      return this.assertBasis(packet.scope);
    }
    const goal = this.assertBasis(packet.scope);
    if (packet.reassessment !== undefined) {
      const focus = packet.reassessment;
      check(validateReassessment(focus) && packet.id === goal.id && packet.proposal_contract_version === 2
        && packet.basis_fingerprint === row.basis_fingerprint
        && this.reassessmentFingerprint(packet.scope, focus) === focus.context_fingerprint
        && this.reassessmentAttemptFingerprint(packet.scope, focus) === row.basis_fingerprint, 'AUDIENCE_RECORD_INVALID');
      // The completed assessment is historical output. Its own revision must not
      // make it invalid immediately; pending/running work still requires its target.
      if (row.status !== 'proposed') {
        if (focus.retry_of) {
          check(focus.retry_of.assessment_id !== row.id, 'AUDIENCE_RECORD_INVALID');
          const parent = this.failedReassessment(this.assessmentRecord(focus.retry_of.assessment_id));
          check(parent.row.goal_id === row.goal_id && parent.row.basis_fingerprint === focus.retry_of.basis_fingerprint
            && parent.packet.reassessment.context_fingerprint === focus.context_fingerprint, 'AUDIENCE_RECORD_INVALID');
        }
        const need = this.need(focus.need_id, { includeWorkCase: false });
        check(need.goal_id === goal.id && need.status !== 'rejected' && need.revision === focus.need_revision
          && need.basis_fingerprint === focus.need_basis_fingerprint
          && digest(this.observationHeads(goal.id)) === digest(focus.observation_heads), 'AUDIENCE_STALE_BASIS');
        const canonical = packet.scope.exchanges.map(e => this.exchangeState(goal,
          this.store.get('SELECT * FROM audience_exchanges WHERE id=? AND goal_id=?', e.id, goal.id)));
        const sourceContent = exchanges => exchanges.map(e => ({ id: e.id, source_ref: e.source_ref,
          fingerprint: e.fingerprint, evidence: e.evidence, unsupported_count: e.unsupported_count }));
        check(Array.isArray(packet.exchanges) && packet.exchanges.every(e => e && typeof e === 'object')
          && digest(sourceContent(packet.exchanges)) === digest(sourceContent(canonical))
          && Array.isArray(packet.needs) && packet.needs.length === 1
          && digest(packet.needs[0]) === digest(this.hypothesisMemory(need)), 'AUDIENCE_RECORD_INVALID');
      }
    } else if (packet.reasoning_retry !== undefined) {
      this.ordinaryPacketProof(row);
      check(packet.reasoning_model_fingerprint === digest(this.service.attention.modelScope()), 'AUDIENCE_STALE_BASIS');
      check(digest(this.observationHeads(goal.id)) === digest(packet.observation_heads), 'AUDIENCE_STALE_BASIS');
      if (row.status !== 'proposed') {
        const parent = this.failedOrdinary(this.assessmentRecord(packet.reasoning_retry.retry_of.assessment_id));
        check(parent.row.id !== row.id && parent.row.goal_id === row.goal_id
          && parent.row.basis_fingerprint === packet.reasoning_retry.retry_of.basis_fingerprint
          && digest(parent.packet.scope) === packet.reasoning_retry.context_fingerprint
          && digest(parent.packet.observation_heads) === digest(packet.observation_heads), 'AUDIENCE_RECORD_INVALID');
      }
    }
    if (!packet.reassessment && (packet.reasoning_retry !== undefined || ['interrupted','invalid'].includes(row.status) && row.producer === 'model')) {
      check(digest(this.observationHeads(goal.id)) === digest(packet.observation_heads), 'AUDIENCE_STALE_BASIS');
      const canonical = packet.scope.exchanges.map(e => this.exchangeState(goal,
        this.store.get('SELECT * FROM audience_exchanges WHERE id=? AND goal_id=?', e.id, goal.id)));
      const sourceContent = exchanges => exchanges.map(e => ({ id: e.id, source_ref: e.source_ref,
        fingerprint: e.fingerprint, evidence: e.evidence, unsupported_count: e.unsupported_count }));
      check(Array.isArray(packet.exchanges) && digest(sourceContent(packet.exchanges)) === digest(sourceContent(canonical)), 'AUDIENCE_RECORD_INVALID');
    }
    return goal;
  }
  decisionState(row, packet, output, current) {
    return assessmentDecision({ row, packet, output, current,
      run:row.run_id ? this.store.get('SELECT * FROM runs WHERE id=?',row.run_id) : null,validateOutput:validateModelOutput,
      validateAuthority:frozen => {
        if (packet.followup || packet.scope?.version === 2) this.service.followup.assertHistory(row.run_id, row, frozen.followup_request);
        else if (!packet.reassessment && !packet.reasoning_retry) this.service.attention.assertHistory(row.run_id, row, frozen.attention_grant);
      } });
  }
  assessment(assessmentId) {
    const row = this.assessmentRecord(assessmentId);
    let current = false; try { this.assertAssessmentCurrent(row); current = true; } catch { /* historical packet */ }
    const { packet_json, output_json, ...rest } = row;
    const packet = parse(packet_json);
    let output = null;
    try { output = output_json ? parse(output_json) : null; } catch { /* malformed output has no displayable interpretation */ }
    return { ...rest, packet, output,
      decision_review:this.decisionState(row, packet, output, current),
      retry: packet.reassessment ? this.retryState(row) : this.ordinaryRetryState(row), attempt_receipt: this.attemptReceipt(row),
      current, reviewable: current && ['captured', 'running', 'proposed'].includes(row.status), ...AUTHORITY };
  }
  propose(p, producer = 'operator') {
    this.requireEnabled(); fields(p, ['assessment_id', 'output']); const a = this.assessment(p.assessment_id);
    check(a.status === (producer === 'model' ? 'running' : 'captured'), 'AUDIENCE_ASSESSMENT_UNAVAILABLE'); this.assertAssessmentCurrent(a);
    const runContext = producer === 'model' && a.run_id ? parse(this.store.get('SELECT context_json FROM runs WHERE id=?',a.run_id)?.context_json ?? '{}') : {};
    const decisionContract = runContext.decision_contract_version === 1;
    check(Buffer.byteLength(JSON.stringify(p.output ?? null)) <= 60000 && validateOutput(p.output)
      && (producer !== 'model' || (decisionContract ? validateModelOutput(p.output)
        : a.packet.proposal_contract_version !== 2 || validateLegacyModelOutput(p.output))), 'AUDIENCE_PROPOSAL_INVALID', 400);
    if (p.output.decision_review) {
      check(producer === 'model' && decisionContract, 'AUDIENCE_DECISION_MODEL_ONLY');
      decisionBindings(p.output,a.packet);
    }
    if (a.packet.reassessment) check(p.output.needs.length <= 1
      && p.output.needs.every(n => n.need_id === a.packet.reassessment.need_id && n.proposal_version === 2), 'AUDIENCE_REASSESSMENT_SCOPE');
    if (a.packet.followup) check(producer === 'model' && p.output.needs.length <= 1
      && p.output.needs.every(n => n.need_id === a.packet.followup.need_id && n.proposal_version === 2), 'AUDIENCE_FOLLOWUP_SCOPE');
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
      if (output.first_contact) this.store.run(`INSERT INTO audience_first_contact_heads(need_id) VALUES(?)
        ON CONFLICT(need_id) DO UPDATE SET request_id=NULL,event_id=NULL,review_id=NULL`,needId);
      results.push(needId);
    }
    this.store.run("UPDATE audience_assessments SET status='proposed',producer=?,output_json=? WHERE id=?", producer, JSON.stringify(p.output), a.id);
    if (!a.packet.reassessment && !a.packet.followup) for (const e of a.packet.exchanges) this.store.run('UPDATE audience_exchanges SET considered_fingerprint=? WHERE id=?', e.fingerprint, e.id);
    this.record('proposed', { assessment_id: a.id, need_ids: results, producer }); return { assessment_id: a.id, need_ids: results, ...AUTHORITY };
  }
  need(needId, { includeWorkCase = true } = {}) {
    const row = this.store.get('SELECT n.* FROM audience_needs n JOIN audience_goals g ON g.id=n.goal_id WHERE n.id=? AND g.partner_id=?', needId, this.partnerId);
    check(row, 'AUDIENCE_NEED_NOT_FOUND', 404); let output, basis;
    try { output = parse(row.output_json); basis = parse(row.basis_json); }
    catch { throw new AppError('AUDIENCE_RECORD_INVALID', 409, 'AUDIENCE_RECORD_INVALID'); }
    check(validateOutput({ needs: [output] }) && basis?.goal_id === row.goal_id, 'AUDIENCE_RECORD_INVALID');
    check(basis.version !== 2 || output.proposal_version === 2, 'AUDIENCE_RECORD_INVALID');
    if (output.proposal_version === 2) {
      // The durable need is a projection of an immutable assessment, not an editable
      // authority document. Bind its text, references and selected context on read/import.
      try {
        const assessment = this.store.get('SELECT * FROM audience_assessments WHERE id=? AND goal_id=?', row.assessment_id, row.goal_id);
        const packet = parse(assessment.packet_json), original = parse(assessment.output_json);
        const { selected } = proposalBindings(output, packet);
        check(original.needs.some(n => digest(n) === digest(output))
          && digest(basis) === digest(frozenProposalBasis(packet, selected)), 'AUDIENCE_RECORD_INVALID');
        if (assessment.producer === 'model') {
          const run = assessment.run_id && this.store.get('SELECT * FROM runs WHERE id=? AND partner_id=?', assessment.run_id, this.partnerId);
          const frozen = run && parse(run.context_json);
          if (packet.followup || packet.scope?.version === 2 || basis.version === 2 || frozen?.followup_request
            || this.store.get('SELECT run_id FROM audience_followup_attempts WHERE assessment_id=?', assessment.id)) {
            check(run?.status === 'completed', 'AUDIENCE_RECORD_INVALID');
            this.service.followup.assertHistory(run.id, assessment, frozen?.followup_request);
          } else if (!packet.reassessment && !packet.reasoning_retry && (frozen?.attention_grant || frozen?.model_profile
            || frozen?.decision_contract_version !== undefined || frozen?.model_projection_version !== undefined
            || original.decision_review !== undefined ||
            this.store.get('SELECT run_id FROM audience_attention_attempts WHERE run_id=?', assessment.run_id))) {
            // Admission authenticity is independent of source freshness and of the
            // review-only rationale. A corrupt audit summary cannot rewrite a valid
            // need basis; a broken grant/profile proof cannot become accepted Work.
            // Missing admission records cannot downgrade a modern ordinary model
            // proposal into legacy history, even if its frozen markers also disappear.
            check(run.status === 'completed', 'AUDIENCE_RECORD_INVALID');
            this.service.attention.assertHistory(run.id, assessment, frozen.attention_grant);
          }
        }
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
    const result = { id: row.id, goal_id: row.goal_id, assessment_id: row.assessment_id, status: row.status, revision: row.revision,
      ...output, current: reasons.length === 0, reasons, epistemic_status: 'unverified_interpretation',
      context_accounting: output.proposal_version === 2 ? 'supplied_packet_only' : 'not_recorded',
      preview_sha256: previewHash(output), linked_work_case: workCase,
      // Model citations cannot narrow the inherited evidence/authority basis.
      preview_basis_event_ids: output.material_preview ? allRefs(output) : [],
      basis_fingerprint: digest({ revision: row.revision, basis, output }), review_note: row.review_note,
      reviewed_at: row.reviewed_at, thread_id: link?.thread_id ?? null, ...AUTHORITY };
    const packet = output.first_contact
      ? parse(this.store.get('SELECT packet_json FROM audience_assessments WHERE id=?',row.assessment_id).packet_json) : {exchanges:[]};
    return {...result,first_contact_state:firstContactState(this,result,packet)};
  }
  assertFirstContactReview(p, options) { return assertFirstContactReview(this,p,options); }
  commitFirstContactHead(needId,result,requestId,eventId) { commitFirstContactHead(this,needId,result,requestId,eventId); }
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
    const importedResponse = n.first_contact?.channel === 'public_reply' && this.store.get(`SELECT id FROM events
      WHERE partner_id=? AND kind='audience.preview_imported' AND payload_json->>'$.need_id'=? LIMIT 1`,this.partnerId,n.id);
    if (importedResponse && n.first_contact_state.state !== 'approved') reasons.push('FIRST_CONTACT_REVIEW_NOT_APPROVED');
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
    if (n.first_contact?.channel === 'public_reply') check(n.first_contact_state.state === 'approved', 'FIRST_CONTACT_REVIEW_NOT_APPROVED');
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
      const packet = parse(a.packet_json), state = this.basisState(packet.scope);
      if (state.reasons.some(r => !TEMPORARY.has(r))) this.store.run("UPDATE audience_assessments SET status='stale' WHERE id=?", a.id);
      else if (state.current && (packet.reassessment || packet.reasoning_retry || packet.followup) && a.status === 'captured') this.assertAssessmentCurrent(a);
      } catch (error) {
        if (!(error instanceof AppError) && !(error instanceof SyntaxError)) throw error;
        if (FOLLOWUP_TEMPORARY.has(error.code) && parse(a.packet_json).followup) continue;
        this.store.run("UPDATE audience_assessments SET status='stale' WHERE id=?", a.id);
        this.record('quarantined', { assessment_id: a.id, reason: 'AUDIENCE_RECORD_INVALID' });
      }
    }
    this.service.followup?.reconcile(goalId);
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
    if (action === 'audience.renew_source') return renewSource(this,p);
    if (action === 'audience.pause') return this.pause(p);
    if (action === 'audience.capture') return this.capture(p);
    if (action === 'audience.reassess') return this.reassess(p);
    if (action === 'audience.retry_reassessment') return this.retryReassessment(p);
    if (action === 'audience.cancel_reassessment') return this.cancelReassessment(p);
    if (action === 'audience.retry_assessment') return this.retryAssessment(p);
    if (action === 'audience.cancel_assessment') return this.cancelAssessment(p);
    if (action === 'audience.attention_grant') return this.service.attention.grant(p);
    if (action === 'audience.attention_revoke') return this.service.attention.revoke(p);
    if (action === 'audience.propose') return this.propose(p);
    if (action === 'audience.review') return this.review(p);
    if (action === 'audience.review_first_contact') return reviewFirstContact(this,p);
    if (action === 'audience.open_work') return this.openWork(p);
    if (action === 'audience.refresh_work') return this.openWork(p, true);
    if (action === 'audience.import_preview') return this.importPreview(p);
    check(false, 'AUDIENCE_COMMAND_UNKNOWN', 400);
  }
}
