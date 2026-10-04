// A versioned evidence projection, not a relaxation of whole-exchange freshness.
// Expired ancestors establish lineage only. They never enter model citations.
import { AppError } from './errors.mjs';
import { digest, sourceRows } from './source-ingestion.mjs';

const HASH = /^[a-f0-9]{64}$/;
const IDS = value => Array.isArray(value) && value.length <= 32 && new Set(value).size === value.length
  && value.every(id => typeof id === 'string' && /^[1-9][0-9]*$/.test(id));
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
const fail = code => { throw new AppError(code, 409, code); };

export function currentExchange(a, goal, row, eventIds) {
  if (!row || !IDS(eventIds) || !eventIds.length) fail('AUDIENCE_RECORD_INVALID');
  const projection = a.projection(row), members = a.members(row), watch = a.watches(goal.id).find(w => w.source_ref === row.source_ref);
  const reasons = [];
  if (row.overflow) reasons.push('AUDIENCE_EXCHANGE_CAPACITY');
  if (projection.reasons.includes('AUDIENCE_RECORD_INVALID')) reasons.push('AUDIENCE_RECORD_INVALID');
  if (!a.enabled()) reasons.push('AUDIENCE_DISABLED');
  if (goal.status !== 'OPEN') reasons.push('AUDIENCE_GOAL_CHANGED');
  if (!watch) reasons.push('AUDIENCE_SOURCE_SCOPE');
  else {
    const health = a.health(watch);
    if (!health.current) reasons.push(health.reason);
    if (a.service.continuity.head(watch.source_ref) > watch.cursor) reasons.push('AUDIENCE_SCOPE_BACKLOG');
  }
  const latest = sourceRows(a.service, row.source_ref, members), byMessage = new Map(latest.map(e => [e.message.message_id, e]));
  const byEvent = new Map(latest.map(e => [e.event_id, e])), structural = new Map();
  const selected = eventIds.map(id => byEvent.get(id));
  for (const start of selected) {
    if (!start) { reasons.push('AUDIENCE_EXCHANGE_CHANGED'); continue; }
    let cursor = start; const seen = new Set();
    while (cursor) {
      const m = cursor.message;
      if (seen.has(m.message_id) || seen.size >= 32) { reasons.push('AUDIENCE_ANCESTRY_CYCLE'); break; }
      seen.add(m.message_id);
      if (m.operation !== 'upsert' || typeof m.text !== 'string' || !m.text.trim()) reasons.push('AUDIENCE_ANCHOR_UNSUPPORTED');
      if (!projection.members.some(([key, id, operation]) => key === m.message_id && id === cursor.event_id && operation === m.operation))
        reasons.push('AUDIENCE_EXCHANGE_CHANGED');
      if (!eventIds.includes(cursor.event_id)) structural.set(cursor.event_id, cursor);
      if (!m.reply_to_id) {
        if (m.message_id !== row.anchor_id) reasons.push('AUDIENCE_ANCESTRY_CHANGED');
        break;
      }
      cursor = byMessage.get(m.reply_to_id);
      if (!cursor) reasons.push('AUDIENCE_ANCESTRY_INCOMPLETE');
    }
  }
  const evidence = [...a.service.continuity.evidenceStates({ max_age_seconds: goal.max_age_seconds },
    watch ? [{ ...watch, policy_hash: a.service.continuity.policyHash(watch.source_ref) }] : [], eventIds).values()];
  if (evidence.length !== eventIds.length) reasons.push('AUDIENCE_EVIDENCE_STALE');
  for (const item of evidence) {
    if (!Number.isFinite(Date.parse(item.observed_at)) || item.confirmed_at!==null && !Number.isFinite(Date.parse(item.confirmed_at)))
      reasons.push('CONTINUITY_EVIDENCE_TIME_INVALID');
    if (!item.current) reasons.push(...item.reasons);
  }
  const currentIds = [...eventIds].sort((x,y) => Number(x)-Number(y));
  const structuralIds = [...structural.keys()].sort((x,y) => Number(x)-Number(y));
  const fingerprint = digest({ version:2, id:row.id, source_ref:row.source_ref, anchor_id:row.anchor_id,
    current:currentIds.map(id => [id,byEvent.get(id)?.message ?? null]),
    structural:structuralIds.map(id => [id,structural.get(id).message]) });
  return { id:row.id,source_ref:row.source_ref,anchor_id:row.anchor_id,fingerprint,
    current_event_ids:currentIds,structural_event_ids:structuralIds,
    evidence_scope:'current_events_with_structural_ancestry_v1',
    evidence:evidence.filter(e => e.current),current:reasons.length === 0,reasons:[...new Set(reasons)],
    unsupported_count:0,coverage:'bounded_new_current_events_with_verified_lineage' };
}

export function currentBasis(a, goal, exchanges) {
  return { version:2,purpose:'audience_current_events_v1',goal_id:goal.id,revision:goal.revision,
    exchanges:exchanges.map(e => ({id:e.id,source_ref:e.source_ref,fingerprint:e.fingerprint,
      current_event_ids:e.current_event_ids,structural_event_ids:e.structural_event_ids})),
    policies:[...new Set(exchanges.map(e => e.source_ref))].sort().map(ref => [ref,a.watches(goal.id).find(w => w.source_ref === ref)?.policy_hash]) };
}

export function currentBasisState(a, basis) {
  if (!exact(basis,'version,purpose,goal_id,revision,exchanges,policies') || basis.version !== 2
    || basis.purpose !== 'audience_current_events_v1' || typeof basis.goal_id !== 'string'
    || !Number.isInteger(basis.revision) || basis.revision < 1 || !Array.isArray(basis.exchanges)
    || !basis.exchanges.length || basis.exchanges.length > 8 || new Set(basis.exchanges.map(e => e?.id)).size !== basis.exchanges.length
    || !basis.exchanges.every(e => exact(e,'id,source_ref,fingerprint,current_event_ids,structural_event_ids')
      && typeof e.id === 'string' && typeof e.source_ref === 'string' && HASH.test(e.fingerprint)
      && IDS(e.current_event_ids) && e.current_event_ids.length && IDS(e.structural_event_ids)
      && !e.current_event_ids.some(id => e.structural_event_ids.includes(id)))
    || !Array.isArray(basis.policies) || !basis.policies.every(p => Array.isArray(p) && p.length === 2
      && typeof p[0] === 'string' && HASH.test(p[1]))
    || digest(basis.policies.map(p => p[0]).sort()) !== digest([...new Set(basis.exchanges.map(e => e.source_ref))].sort()))
    return {current:false,reasons:['AUDIENCE_RECORD_INVALID']};
  const reasons = [];
  try {
    const goal = a.goal(basis.goal_id);
    if (!a.enabled()) reasons.push('AUDIENCE_DISABLED');
    if (goal.status !== 'OPEN' || goal.revision !== basis.revision) reasons.push('AUDIENCE_GOAL_CHANGED');
    for (const e of basis.exchanges) {
      const row = a.store.get('SELECT * FROM audience_exchanges WHERE id=? AND goal_id=?',e.id,goal.id);
      const current = currentExchange(a,goal,row,e.current_event_ids);
      reasons.push(...current.reasons);
      if (current.source_ref !== e.source_ref || current.fingerprint !== e.fingerprint
        || digest(current.structural_event_ids) !== digest(e.structural_event_ids)) reasons.push('AUDIENCE_EXCHANGE_CHANGED');
    }
    if (!basis.policies.every(([ref,hash]) => a.watches(goal.id).some(w => w.source_ref === ref
      && w.status === 'active' && w.policy_hash === hash && a.policyHash(ref) === hash))) reasons.push('AUDIENCE_SOURCE_REVOKED');
  } catch (error) { if (!(error instanceof AppError)) throw error; reasons.push(error.code); }
  return {current:reasons.length === 0,reasons:[...new Set(reasons)]};
}
