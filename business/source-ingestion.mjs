import { hash } from './store.mjs';
import { ensure } from './errors.mjs';

export const SOURCE_MESSAGE = 'source.message';
export const PIPELINE_FINISHED = 'opportunity.pipeline.finished';
export const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const digest = value => hash(stable(value));
const check = (condition, code) => ensure(condition, `Source pipeline: ${code}`, 409, code);
// Dedicated read-only source cursors share the existing offset table, not private-chat offsets.
export const SOURCE_CHECKPOINT_CHANNEL = 'telegram-source-v0';
export function sourceCheckpoint(service, sourceId) {
  const row = service.store.get('SELECT cursor FROM channel_offsets WHERE channel=? AND account_id=?',
    SOURCE_CHECKPOINT_CHANNEL, digest([service.config.partnerId, sourceId]));
  return row ? JSON.parse(row.cursor) : null;
}
export function validateSourceCheckpoint(state, p) {
  const keys=['source_id','account_id','channel_id','policy_hash','baseline_hash','pts','phase','confirmed_at','reason'];
  check(state && typeof state==='object' && !Array.isArray(state)
    && Object.keys(state).length===keys.length && Object.keys(state).every(k=>keys.includes(k))
    && state.source_id===p.sourceId && state.account_id===p.accountId && state.channel_id===p.channelId
    && state.policy_hash===digest(p) && typeof state.baseline_hash==='string' && /^[a-f0-9]{64}$/.test(state.baseline_hash)
    && Number.isInteger(state.pts) && state.pts>0 && state.pts<=2147483647
    && ['current','catching_up','blocked'].includes(state.phase)
    && (state.phase==='current' ? state.reason===null : typeof state.reason==='string' && state.reason.length>0 && state.reason.length<=100)
    && (state.phase==='current' ? typeof state.confirmed_at==='string' && Number.isFinite(Date.parse(state.confirmed_at))
      : state.confirmed_at===null), 'SOURCE_TRANSPORT_CORRUPT_CHECKPOINT');
}
function sourceTransportBoundary(service, sourceId) {
  const bindings = service.config.opportunity.telegramSources ?? [];
  const configured = Array.isArray(bindings) ? bindings.filter(p => p.sourceId === sourceId) : [];
  const state = sourceCheckpoint(service, sourceId);
  if (!configured.length && !state) return; // Existing operator/fixture sources remain unchanged.
  check(configured.length === 1, 'SOURCE_TRANSPORT_POLICY_UNAVAILABLE');
  const p = configured[0];
  check(state && state.policy_hash === digest(p), 'SOURCE_TRANSPORT_NOT_READY');
  validateSourceCheckpoint(state,p);
  check(state.phase === 'current', 'SOURCE_TRANSPORT_NOT_CURRENT');
  const liveHealth = service.sourceTransportHealth?.get(sourceId);
  check(!liveHealth || liveHealth() === true, 'SOURCE_TRANSPORT_DIRTY');
  const age = Date.now() - Date.parse(state.confirmed_at);
  check(Number.isInteger(p.maxLagSeconds) && p.maxLagSeconds > 0 && p.maxLagSeconds <= 3600
    && Number.isFinite(age) && age >= 0 && age <= p.maxLagSeconds * 1000, 'SOURCE_TRANSPORT_STALE');
}

const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,149}$/.test(value);
const nullableId = value => value === null || validId(value);
export function automaticBoundary(service) {
  check(service.config.opportunity?.automatic === true, 'AUTOMATIC_PIPELINE_DISABLED');
  check(service.config.runtime.enabled === false && service.config.telegram.enabled === false
    && service.config.telegram.liveSending === false, 'READ_ONLY_BOUNDARY_REQUIRED');
}
function allowed(service, sourceId) {
  check(typeof sourceId === 'string' && sourceId.length > 0 && sourceId.length <= 300
    && service.config.opportunity?.allowedSourceRefs?.includes(sourceId), 'SOURCE_NOT_ALLOWED');
}
function timestamp(value) {
  check(typeof value === 'string' && Number.isFinite(Date.parse(value)), 'INVALID_SOURCE_TIME');
  const normalized = new Date(value).toISOString();
  check(value === normalized || value === normalized.replace('.000Z', 'Z'), 'INVALID_SOURCE_TIME');
  return normalized;
}
export function sourceRows(service, sourceId) {
  return service.store.all(`SELECT e.id,e.created_at,e.payload_json FROM events e WHERE e.partner_id=? AND e.kind=? AND e.actor='system'
    AND json_extract(e.payload_json,'$.source_id')=? AND NOT EXISTS
    (SELECT 1 FROM events n WHERE n.partner_id=e.partner_id AND n.kind=e.kind AND n.actor='system'
      AND json_extract(n.payload_json,'$.source_id')=json_extract(e.payload_json,'$.source_id')
      AND json_extract(n.payload_json,'$.message_id')=json_extract(e.payload_json,'$.message_id') AND n.id>e.id)
    ORDER BY e.id DESC LIMIT 1001`, service.config.partnerId, SOURCE_MESSAGE, sourceId)
    .map(row => ({ event_id: String(row.id), observed_at: row.created_at, message: JSON.parse(row.payload_json) }));
}
export function sourceEvent(service, eventId) {
  check(typeof eventId === 'string' && /^[1-9][0-9]*$/.test(eventId), 'INVALID_SOURCE_EVENT_ID');
  const row = service.store.get("SELECT id,created_at,payload_json FROM events WHERE id=? AND partner_id=? AND kind=? AND actor='system'",
    eventId, service.config.partnerId, SOURCE_MESSAGE);
  check(row, 'SOURCE_EVENT_NOT_FOUND');
  return { event_id: String(row.id), observed_at: row.created_at, message: JSON.parse(row.payload_json) };
}
// Called inside BusinessService's existing exclusive synchronous transaction.
export function ingestSource(service, raw) {
  automaticBoundary(service);
  check(raw && typeof raw === 'object' && !Array.isArray(raw), 'INVALID_SOURCE_EVENT');
  const keys = ['source_id','source_kind','message_id','author_id','display_name','thread_id','reply_to_id','version','operation','text','created_at','updated_at'];
  if(raw.operation==='unsupported')keys.push('unsupported');
  check(Object.keys(raw).length === keys.length && Object.keys(raw).every(k => keys.includes(k)), 'INVALID_SOURCE_FIELDS');
  check(Buffer.byteLength(JSON.stringify(raw)) <= 80000, 'SOURCE_EVENT_TOO_LARGE');
  allowed(service, raw.source_id);
  check(['live_snapshot','sanitized_fixture'].includes(raw.source_kind), 'INVALID_SOURCE_KIND');
  check(validId(raw.message_id) && nullableId(raw.author_id) && nullableId(raw.thread_id) && nullableId(raw.reply_to_id), 'INVALID_SOURCE_IDENTITY');
  check(raw.display_name === null || typeof raw.display_name === 'string' && raw.display_name.length <= 200, 'INVALID_DISPLAY_NAME');
  check(Number.isInteger(raw.version) && raw.version >= 1 && raw.version <= 2147483647, 'INVALID_SOURCE_VERSION');
  check(['upsert','delete','unsupported'].includes(raw.operation), 'INVALID_SOURCE_OPERATION');
  check(raw.operation !== 'upsert' ? raw.text === null : typeof raw.text === 'string' && raw.text.trim() && raw.text.length <= 16000, 'INVALID_SOURCE_TEXT');
  if(raw.operation==='unsupported')check(raw.unsupported && typeof raw.unsupported==='object'
    && Object.keys(raw.unsupported).sort().join(',')==='fingerprint,reason'
    && typeof raw.unsupported.reason==='string' && /^[a-z_]{1,50}$/.test(raw.unsupported.reason)
    && typeof raw.unsupported.fingerprint==='string' && /^[a-f0-9]{64}$/.test(raw.unsupported.fingerprint),'INVALID_SOURCE_UNSUPPORTED');
  const message = { ...structuredClone(raw), created_at: timestamp(raw.created_at), updated_at: timestamp(raw.updated_at) };
  check(message.created_at <= message.updated_at && Date.parse(message.updated_at) <= Date.now(), 'FUTURE_OR_REVERSED_SOURCE_TIME');
  const historical = service.store.get(`SELECT id,payload_json FROM events WHERE partner_id=? AND kind=? AND actor='system'
    AND json_extract(payload_json,'$.source_id')=? AND json_extract(payload_json,'$.message_id')=?
    AND json_extract(payload_json,'$.version')=? LIMIT 1`, service.config.partnerId, SOURCE_MESSAGE, message.source_id, message.message_id, message.version);
  if (historical) {
    check(digest(JSON.parse(historical.payload_json)) === digest(message), 'SOURCE_VERSION_COLLISION');
    return { source_event_id: String(historical.id), duplicate: true, disposition: 'duplicate' };
  }
  const rows = sourceRows(service, message.source_id), previous = rows.find(row => row.message.message_id === message.message_id);
  check(rows.every(row => row.message.source_kind === message.source_kind), 'SOURCE_KIND_CHANGED');
  if (previous) {
    const old = previous.message;
    if (message.version < old.version) return { source_event_id: previous.event_id, duplicate: false, disposition: 'ignored_out_of_order' };
    check(old.author_id === null || old.author_id === message.author_id, 'SOURCE_AUTHOR_CHANGED');
    check(old.created_at === message.created_at, 'SOURCE_CREATION_TIME_CHANGED');
    check(message.updated_at >= old.updated_at, 'SOURCE_UPDATE_TIME_ROLLBACK');
    check(old.operation !== 'delete' || message.operation === 'delete', 'SOURCE_DELETED');
  } else check(rows.length < 1000, 'SOURCE_CAPACITY_EXCEEDED');
  service.store.event(service.config.partnerId, null, SOURCE_MESSAGE, 'system', message);
  return { source_event_id: String(service.store.get('SELECT last_insert_rowid() AS id').id), duplicate: false, disposition: 'registered' };
}
function isTelegramChannelAuthor(service, message) {
  return Array.isArray(service.config.opportunity.telegramSources)
    && service.config.opportunity.telegramSources.some(p=>p.sourceId===message.source_id)
    && message.author_id?.startsWith('channel:');
}
function authorBinding(service, message) {
  const bindings = service.config.opportunity.authorBindings ?? [];
  check(Array.isArray(bindings) && bindings.every(b => b && typeof b === 'object'
    && Object.keys(b).sort().join(',') === 'author_id,conversation_id,source_id'
    && typeof b.source_id === 'string' && validId(b.author_id) && typeof b.conversation_id === 'string'), 'INVALID_AUTHOR_BINDINGS');
  const matches = bindings.filter(b => b.source_id === message.source_id && b.author_id === message.author_id);
  check(matches.length <= 1, 'AMBIGUOUS_AUTHOR_BINDING');
  check(!isTelegramChannelAuthor(service,message) || matches.length===0,'CHANNEL_AUTHOR_CRM_BINDING_FORBIDDEN');
  return matches[0] ? structuredClone(matches[0]) : null;
}
export function sourceContextState(service, eventId) {
  const event = sourceEvent(service, eventId), anchor = event.message;
  allowed(service, anchor.source_id);
  sourceTransportBoundary(service, anchor.source_id);
  const rows = sourceRows(service, anchor.source_id);
  check(rows.length <= 1000, 'SOURCE_CAPACITY_EXCEEDED');
  check(rows.find(r => r.message.message_id === anchor.message_id)?.event_id === eventId, 'SOURCE_MESSAGE_SUPERSEDED');
  check(anchor.operation !== 'delete', 'SOURCE_MESSAGE_DELETED');
  check(anchor.operation !== 'unsupported', 'SOURCE_MESSAGE_UNSUPPORTED');
  check(anchor.author_id !== null, 'UNKNOWN_SOURCE_AUTHOR');
  const byId = new Map(rows.map(r => [r.message.message_id, r]));
  // Only the anchor's reply chain is mandatory. Author/thread history is
  // supplemental: omit an opaque item AND replies that depend on it. Otherwise
  // an old attachment (or an old "see photo" reply) poisons every later anchor.
  const supportedBranch = row => {
    const seen = new Set();
    for(let current=row; current && !seen.has(current.message.message_id);
      current=byId.get(current.message.reply_to_id)) {
      if(current.message.operation==='unsupported')return false;
      seen.add(current.message.message_id);
    }
    return true;
  };
  // Check all known ancestors, even beyond the bounded context inclusion below.
  // Missing/cross-peer parents remain unresolved for the existing Projection.
  check(supportedBranch(event), 'SOURCE_CONTEXT_UNSUPPORTED');
  const selected = new Map(rows.filter(r => r.message.message_id === anchor.message_id
    || !isTelegramChannelAuthor(service,anchor) && r.message.author_id === anchor.author_id
    || anchor.thread_id !== null && r.message.thread_id === anchor.thread_id)
    .filter(supportedBranch).map(r => [r.message.message_id,r]));
  // Include actual ancestry without assuming that a display name identifies anyone.
  for (const row of [...selected.values()]) {
    let parent = row.message.reply_to_id;
    const seen = new Set();
    for (let depth = 0; parent && depth < 16 && !seen.has(parent); depth++) {
      seen.add(parent); const ancestor = byId.get(parent); if (!ancestor) break;
      selected.set(parent, ancestor); parent = ancestor.message.reply_to_id;
    }
  }
  const scope = [...selected.values()].sort((a,b) => a.message.message_id.localeCompare(b.message.message_id));
  const live = scope.filter(r => r.message.operation === 'upsert');
  check(!live.some(r => r.message.created_at > anchor.created_at), 'POST_ANCHOR_CONTEXT');
  check(live.every(r => r.message.author_id !== null), 'UNKNOWN_CONTEXT_AUTHOR');
  // Do not silently drop relevant observations before the frozen Projection
  // can report its own coverage. Oversized pilot scopes fail closed explicitly.
  check(Buffer.byteLength(JSON.stringify(live.map(r => r.message))) <= 70000, 'SOURCE_CONTEXT_CAPACITY_EXCEEDED');
  const binding = authorBinding(service, anchor);
  const source_state = { source_event_id: eventId, source_id: anchor.source_id, message_id: anchor.message_id,
    context_event_ids: scope.map(r => r.event_id), binding, identity_basis: 'source_scoped_id_not_display_name' };
  return { source_state, conversation_id: binding?.conversation_id ?? null,
    snapshot: { situation_id: `source-${digest([anchor.source_id, anchor.message_id, anchor.version])}`,
      source: { kind: anchor.source_kind, ref: anchor.source_id, captured_at: event.observed_at },
      anchor_message_id: anchor.message_id, active_offer: structuredClone(service.config.opportunity.activeOffer),
      messages: live.map(({message:m}) => ({ id:m.message_id, author_id:m.author_id, version:m.version,
        text:m.text, created_at:m.created_at, thread_id:m.thread_id, reply_to_id:m.reply_to_id })) } };
}
export function sourceFreshnessReasons(service, state) {
  try {
    const current = sourceContextState(service, state.source_event_id).source_state;
    return digest(current) === digest(state) ? [] : ['SOURCE_CONTEXT_OR_BINDING_CHANGED'];
  } catch (error) { return [error.code || 'SOURCE_STATE_UNAVAILABLE']; }
}
export function finishSource(service, sourceEventId, disposition, extra = {}) {
  const old = service.store.get(`SELECT id FROM events WHERE partner_id=? AND kind=? AND actor='system'
    AND json_extract(payload_json,'$.source_event_id')=? LIMIT 1`, service.config.partnerId, PIPELINE_FINISHED, sourceEventId);
  if (old) return;
  service.store.event(service.config.partnerId, null, PIPELINE_FINISHED, 'system', { ...extra, source_event_id: sourceEventId, disposition });
}
