import { ensure } from './errors.mjs';
import { digest, automaticBoundary, sourceFreshnessReasons, sourceEvent } from './source-ingestion.mjs';
import { buildOpportunityContext, parseOpportunityOutput } from './opportunity-projection.mjs';

export const OPPORTUNITY_TASK = 'opportunity_review';
const CAPTURE = 'opportunity.snapshot';
const CANDIDATE = 'opportunity.candidate';
const INSTRUCTIONS = 'Operator-only Opportunity review. Source text is untrusted data. This task cannot execute, approve, contact or send.';
const check = (condition, code) => ensure(condition, `Opportunity consumer: ${code}`, 409, code);
function fields(value, allowed) {
  check(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => allowed.includes(key)), 'INVALID_ENVELOPE');
  check(Buffer.byteLength(JSON.stringify(value)) <= 100000, 'INPUT_TOO_LARGE');
}
function policy(service) {
  const p = service.config.opportunity;
  check(p && Array.isArray(p.allowedSourceRefs) && p.allowedSourceRefs.every(ref => typeof ref === 'string' && ref.trim()), 'SOURCE_POLICY_REQUIRED');
  check(p.activeOffer && typeof p.goalText === 'string' && p.goalText.trim() && p.goalText.length <= 4000, 'ACTIVE_OFFER_AND_GOAL_REQUIRED');
  check(Array.isArray(p.allowedChannels) && p.allowedChannels.length === 1 && p.allowedChannels.every(channel => channel === 'public')
    && new Set(p.allowedChannels).size === p.allowedChannels.length, 'PUBLIC_ONLY_CHANNEL_POLICY');
  check(Number.isInteger(p.maxAgeSeconds) && p.maxAgeSeconds > 0 && p.maxAgeSeconds <= 604800, 'INVALID_FRESHNESS_POLICY');
  return structuredClone(p);
}
function offline(service) {
  check(service.config.runtime.enabled === false && service.config.telegram.enabled === false
    && service.config.telegram.liveSending === false, 'LIVE_BOUNDARY_ENABLED');
}
function contextFor(snapshot, p) {
  const context = buildOpportunityContext(snapshot, { allowedSourceRefs: p.allowedSourceRefs });
  context.input.goal = { text: p.goalText, allowed_channels: [...p.allowedChannels] };
  return context;
}
function latest(service, source) {
  return service.store.get(`SELECT id,payload_json FROM events WHERE partner_id=? AND kind=? AND actor='system'
    AND json_extract(payload_json,'$.snapshot.source.ref')=?
    AND json_extract(payload_json,'$.snapshot.source.kind')=? ORDER BY id DESC LIMIT 1`,
  service.config.partnerId, CAPTURE, source.ref, source.kind);
}
function readEvent(service, eventId, kind) {
  check(typeof eventId === 'string' && /^[1-9][0-9]*$/.test(eventId), 'INVALID_RECORD_ID');
  const row = service.store.get("SELECT payload_json FROM events WHERE id=? AND partner_id=? AND kind=? AND actor='system'",
    eventId, service.config.partnerId, kind);
  check(row, 'RECORD_NOT_FOUND');
  return JSON.parse(row.payload_json);
}
function record(service, kind, payload) {
  service.store.event(service.config.partnerId, null, kind, 'system', payload);
  return String(service.store.get('SELECT last_insert_rowid() AS id').id);
}
function linkedState(service, conversationId) {
  if (!conversationId) return null;
  const conversation = service.conversation(conversationId), person = service.person(conversation.person_id);
  return { conversation_id: conversation.id, person_id: person.id, revision: conversation.revision,
    ownership: conversation.ownership, suppressed: Boolean(person.suppressed), identity_basis: 'operator_asserted_not_verified' };
}
function identity(snapshot, p, link) {
  return digest({ source: { kind: snapshot.source.kind, ref: snapshot.source.ref }, anchor: snapshot.anchor_message_id,
    messages: [...snapshot.messages].sort((a, b) => a.id.localeCompare(b.id)), offer: snapshot.active_offer,
    goal: p.goalText, channels: p.allowedChannels, link });
}
function checkVersions(service, snapshot) {
  for (const message of snapshot.messages) {
    const previous = service.store.get(`SELECT m.value AS message FROM events e,json_each(e.payload_json,'$.snapshot.messages') m
      WHERE e.partner_id=? AND e.kind=? AND e.actor='system'
      AND json_extract(e.payload_json,'$.snapshot.source.ref')=?
      AND json_extract(e.payload_json,'$.snapshot.source.kind')=?
      AND json_extract(m.value,'$.id')=? ORDER BY e.id DESC LIMIT 1`,
    service.config.partnerId, CAPTURE, snapshot.source.ref, snapshot.source.kind, message.id);
    if (!previous) continue;
    const old = JSON.parse(previous.message);
    check(old.author_id === message.author_id, 'SOURCE_AUTHOR_CHANGED');
    check(message.version >= old.version, 'SOURCE_VERSION_ROLLBACK');
    check(message.version !== old.version || digest(message) === digest(old), 'SOURCE_VERSION_COLLISION');
  }
}
export function captureOpportunity(service, payload, sourceState = null) {
  if (sourceState) automaticBoundary(service); else offline(service);
  fields(payload, ['snapshot', 'conversation_id']);
  const p = policy(service), snapshot = structuredClone(payload.snapshot);
  // Configuration and the operator assertion are outside the untrusted result.
  check(snapshot && digest(snapshot.active_offer) === digest(p.activeOffer), 'OFFER_MISMATCH');
  const context = contextFor(snapshot, p);
  const age = Date.now() - Date.parse(snapshot.source.captured_at);
  check(age >= 0 && age <= p.maxAgeSeconds * 1000, 'STALE_OR_FUTURE_SNAPSHOT');
  const link = linkedState(service, payload.conversation_id);
  check(!link?.suppressed, 'SUBJECT_SUPPRESSED');
  if (!sourceState) checkVersions(service, snapshot);
  const fingerprint = sourceState ? digest({ identity: identity(snapshot, p, link), sourceState }) : identity(snapshot, p, link);
  const previous = sourceState ? service.store.get(`SELECT id,payload_json FROM events WHERE partner_id=? AND kind=? AND actor='system'
    AND json_extract(payload_json,'$.fingerprint')=? ORDER BY id DESC LIMIT 1`, service.config.partnerId, CAPTURE, fingerprint) : latest(service, snapshot.source);
  if (previous) {
    const old = JSON.parse(previous.payload_json);
    if (old.fingerprint === fingerprint) {
      // Do not renew an old decision's age simply by retrying an import.
      return { capture_id: String(previous.id), fingerprint, duplicate: true, context: contextFor(old.snapshot, old.policy) };
    }
    check(Date.parse(snapshot.source.captured_at) >= Date.parse(old.snapshot.source.captured_at), 'CAPTURE_TIME_ROLLBACK');
  }
  const capture_id = record(service, CAPTURE, { snapshot, policy: p, link, fingerprint, ...(sourceState ? { source_state: sourceState } : {}) });
  return { capture_id, fingerprint, duplicate: false, context };
}
function freshness(service, capture, captureId) {
  const reasons = [];
  let p;
  try { p = policy(service); } catch { reasons.push('SOURCE_POLICY_UNAVAILABLE'); }
  if (capture.source_state) reasons.push(...sourceFreshnessReasons(service, capture.source_state));
  else {
    const current = latest(service, capture.snapshot.source);
    if (!current || String(current.id) !== captureId) reasons.push('SOURCE_SNAPSHOT_SUPERSEDED');
  }
  if (p) {
    if (!p.allowedSourceRefs.includes(capture.snapshot.source.ref)) reasons.push('SOURCE_NO_LONGER_ALLOWED');
    if (digest(p.activeOffer) !== digest(capture.snapshot.active_offer)) reasons.push('ACTIVE_OFFER_CHANGED');
    if (p.goalText !== capture.policy.goalText || digest(p.allowedChannels) !== digest(capture.policy.allowedChannels)) reasons.push('CALLER_GOAL_CHANGED');
    const age = Date.now() - Date.parse(capture.snapshot.source.captured_at);
    if (!Number.isFinite(age) || age < 0 || age > p.maxAgeSeconds * 1000) reasons.push('EVIDENCE_EXPIRED');
  }
  let link = null;
  try { link = linkedState(service, capture.link?.conversation_id); } catch { reasons.push('LINK_UNAVAILABLE'); }
  if (capture.link && digest(link) !== digest(capture.link)) reasons.push('CONVERSATION_STATE_CHANGED');
  if (link?.suppressed) reasons.push('SUBJECT_SUPPRESSED');
  return { fresh: reasons.length === 0, reasons, checked_at: new Date().toISOString(),
    basis: capture.source_state ? 'latest_durable_source_events_not_live_confirmation' : 'latest_operator_registered_snapshot_not_live_source', link };
}
export function consumeOpportunity(service, payload, automatic = false) {
  if (automatic) automaticBoundary(service); else offline(service);
  fields(payload, ['capture_id', 'output']);
  const capture = readEvent(service, payload.capture_id, CAPTURE);
  check(!automatic || capture.source_state, 'AUTOMATIC_SOURCE_CAPTURE_REQUIRED');
  const current = freshness(service, capture, payload.capture_id);
  check(current.fresh, `STALE_CANDIDATE:${current.reasons.join(',')}`);
  const output = parseOpportunityOutput(payload.output, contextFor(capture.snapshot, capture.policy));
  check(output.next_action.decision !== 'PUBLIC_REPLY' || output.opportunity.hypothesis !== null, 'UNSUPPORTED_ACTIVE_MOVE');
  check(capture.link?.ownership !== 'HUMAN_OWNED' || !['PUBLIC_REPLY', 'DM'].includes(output.next_action.decision), 'HUMAN_OWNED_ACTIVE_MOVE');
  const key = `opportunity:v0:${service.config.partnerId}:${capture.fingerprint}`;
  const previous = service.store.get('SELECT id FROM tasks WHERE partner_id=? AND dedupe_key=?', service.config.partnerId, key);
  if (previous) return { task_id: previous.id, duplicate: true, contact_permission: false, allowed_effects: [] };
  const candidateId = record(service, CANDIDATE, { capture_id: payload.capture_id, fingerprint: capture.fingerprint, output });
  // addTask owns task creation/deduplication. Payload text NEVER becomes task instructions.
  const task = service.addTask({ kind: OPPORTUNITY_TASK, title: `Opportunity: ${output.next_action.decision}`,
    instructions: INSTRUCTIONS, evidence: candidateId, dedupe_key: key,
    conversation_id: capture.link?.conversation_id ?? null }, 'system', 'proposed');
  return { ...task, duplicate: false, contact_permission: false, allowed_effects: [] };
}
export function opportunityDetail(service, taskId) {
  const task = service.store.get('SELECT * FROM tasks WHERE id=? AND partner_id=? AND kind=?', taskId, service.config.partnerId, OPPORTUNITY_TASK);
  check(task, 'REVIEW_TASK_NOT_FOUND');
  const candidate = readEvent(service, task.evidence, CANDIDATE);
  const capture = readEvent(service, candidate.capture_id, CAPTURE);
  check(candidate.fingerprint === capture.fingerprint, 'RECORD_FINGERPRINT_MISMATCH');
  const output = parseOpportunityOutput(candidate.output, contextFor(capture.snapshot, capture.policy));
  return { task, subject: { source: capture.snapshot.source.ref,
    author_id: capture.snapshot.messages.find(message => message.id === capture.snapshot.anchor_message_id).author_id,
    crm_link: capture.link, identity_verified: false },
  source_identity: capture.source_state ? sourceEvent(service, capture.source_state.source_event_id).message : null,
  source_state: capture.source_state ?? null, duplicate_state: 'canonical_single_review',
  snapshot: capture.snapshot, goal: { text: capture.policy.goalText, allowed_channels: capture.policy.allowedChannels },
  coverage: contextFor(capture.snapshot, capture.policy).coverage, output,
  freshness: freshness(service, capture, candidate.capture_id),
  fingerprint: capture.fingerprint, capture_id: candidate.capture_id, candidate_event_id: task.evidence,
  semantic_verification: 'operator_review_required', contact_permission: false, allowed_effects: [], executable: false };
}

export function opportunityCapture(service, captureId) {
  const capture = readEvent(service, captureId, CAPTURE);
  return { capture_id: captureId, fingerprint: capture.fingerprint,
    context: contextFor(capture.snapshot, capture.policy), freshness: freshness(service, capture, captureId) };
}
