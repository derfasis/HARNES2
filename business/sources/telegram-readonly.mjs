// No Telegram client, credentials, network, send API or model is imported here.
// This is a bounded adapter-facing channel difference contract, NOT raw MTProto.
import { ensure, now } from '../errors.mjs';
import { automaticBoundary, digest, ingestSource, finishSource, sourceRows, sourceCheckpoint, SOURCE_CHECKPOINT_CHANNEL, validateSourceCheckpoint } from '../source-ingestion.mjs';

const UPDATE = 'source.telegram.update';
const TOMBSTONE = 'source.telegram.tombstone';
const MAX_PTS = 2147483647;
const INTEGRITY = 'INTEGRITY_RECONCILIATION_REQUIRED';
const integrityErrors = new Set(['TELEGRAM_PTS_COLLISION','SOURCE_VERSION_COLLISION','TELEGRAM_AUTHOR_IDENTITY_CHANGED',
  'SOURCE_CREATION_TIME_CHANGED','SOURCE_UPDATE_TIME_ROLLBACK','TELEGRAM_MESSAGE_DELETED','TELEGRAM_DIFFERENCE_TOO_LONG',
  'SOURCE_TRANSPORT_CORRUPT_CHECKPOINT',INTEGRITY]);
const check = (ok, code) => ensure(ok, `Telegram source: ${code}`, 409, code);
const integer = (n, min = 1) => Number.isInteger(n) && n >= min && n <= MAX_PTS;
const numericId = x => typeof x === 'string' && /^[1-9][0-9]{0,18}$/.test(x);
function fields(value, keys) {
  check(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(k => keys.includes(k)), 'UNSUPPORTED_TELEGRAM_FIELDS');
}
function policy(service, sourceId) {
  automaticBoundary(service);
  const all = service.config.opportunity.telegramSources ?? [];
  check(Array.isArray(all), 'INVALID_TELEGRAM_SOURCE_POLICY');
  const matches = all.filter(s => s.sourceId === sourceId);
  check(matches.length === 1, 'TELEGRAM_SOURCE_NOT_CONFIGURED');
  const p = matches[0];
  fields(p, ['sourceId','accountId','channelId','sourceKind','processingBasis','maxLagSeconds']);
  check(numericId(p.accountId) && numericId(p.channelId) && p.sourceId === `telegram:channel:${p.channelId}`
    && service.config.opportunity.allowedSourceRefs.includes(p.sourceId), 'TELEGRAM_SOURCE_SCOPE');
  check(['sanitized_fixture','live_snapshot'].includes(p.sourceKind), 'INVALID_TELEGRAM_SOURCE_KIND');
  check(typeof p.processingBasis === 'string' && p.processingBasis.trim().length > 0
    && p.processingBasis.length <= 1000, 'PROCESSING_AUTHORIZATION_REQUIRED');
  check(integer(p.maxLagSeconds) && p.maxLagSeconds <= 3600, 'INVALID_TELEGRAM_MAX_LAG');
  return p;
}
function scopeKey(service, p) { return digest([service.config.partnerId, p.sourceId]); }
function writeState(service, p, state) {
  service.store.run('INSERT INTO channel_offsets(channel,account_id,cursor) VALUES(?,?,?) ON CONFLICT(channel,account_id) DO UPDATE SET cursor=excluded.cursor',
    SOURCE_CHECKPOINT_CHANNEL, scopeKey(service,p), JSON.stringify(state));
}
function stateFor(service, p) {
  const state = sourceCheckpoint(service, p.sourceId);
  check(state, 'TELEGRAM_BOOTSTRAP_REQUIRED');
  check(state.policy_hash === digest(p), 'TELEGRAM_SOURCE_POLICY_CHANGED');
  validateSourceCheckpoint(state,p);
  check(state.reason!==INTEGRITY,INTEGRITY);
  return state;
}
function receipt(service, p, pts) {
  return service.store.get(`SELECT payload_json FROM events WHERE partner_id=? AND kind=? AND actor='system'
    AND json_extract(payload_json,'$.source_id')=? AND json_extract(payload_json,'$.pts')=? LIMIT 1`,
  service.config.partnerId, UPDATE, p.sourceId, pts);
}
function deleted(service,p,messageId) {
  return service.store.get(`SELECT id FROM events WHERE partner_id=? AND kind=? AND actor='system'
    AND json_extract(payload_json,'$.source_id')=? AND json_extract(payload_json,'$.message_id')=? LIMIT 1`,
  service.config.partnerId, TOMBSTONE, p.sourceId, messageId);
}
function timestamp(seconds) {
  check(Number.isInteger(seconds) && seconds > 0 && seconds * 1000 <= Date.now(), 'INVALID_TELEGRAM_TIME');
  return new Date(seconds * 1000).toISOString();
}
function peer(value) {
  fields(value,['kind','id']);
  check(['user','channel'].includes(value.kind) && numericId(value.id), 'INVALID_TELEGRAM_AUTHOR');
  return `${value.kind}:${value.id}`;
}
export function normalizeTelegramMessage(p, m, version) {
  fields(m,['id','channel_id','from_id','post','text','date','edit_date','reply_to_msg_id','reply_to_top_id','reply_to_channel_id']);
  check(integer(m.id) && m.channel_id === p.channelId, 'TELEGRAM_PEER_MISMATCH');
  check(typeof m.post === 'boolean', 'TELEGRAM_POST_FLAG_REQUIRED');
  check(typeof m.text === 'string' && m.text.trim() && m.text.length <= 16000, 'UNSUPPORTED_TELEGRAM_CONTENT');
  const author = m.from_id != null ? peer(m.from_id) : m.post ? `channel:${p.channelId}` : null;
  // This restricted contract cannot prove personal authorship of a broadcast post.
  // Signed/discussion/foreign-channel post variants require an explicit future mapper.
  check(!m.post || author === `channel:${p.channelId}`, 'UNSUPPORTED_TELEGRAM_POST_AUTHOR');
  const created = timestamp(m.date), updated = m.edit_date == null ? created : timestamp(m.edit_date);
  check(updated >= created, 'TELEGRAM_TIME_ROLLBACK');
  for (const key of ['reply_to_msg_id','reply_to_top_id']) check(m[key] == null || integer(m[key]), 'INVALID_TELEGRAM_REPLY');
  check(m.reply_to_channel_id == null || numericId(m.reply_to_channel_id), 'INVALID_TELEGRAM_REPLY_PEER');
  check(m.reply_to_channel_id == null || m.reply_to_msg_id != null, 'INVALID_TELEGRAM_REPLY');
  const otherPeer = m.reply_to_channel_id && m.reply_to_channel_id !== p.channelId;
  // Cross-peer links stay explicitly unresolved. Never merge message IDs across peers.
  const prefix = otherPeer ? `channel:${m.reply_to_channel_id}:` : '';
  return {source_id:p.sourceId, source_kind:p.sourceKind, message_id:`message:${m.id}`, author_id:author,
    display_name:null, thread_id:m.reply_to_top_id == null ? null : `${prefix}message:${m.reply_to_top_id}`,
    reply_to_id:m.reply_to_msg_id == null ? null : `${prefix}message:${m.reply_to_msg_id}`,
    version, operation:'upsert', text:m.text, created_at:created, updated_at:updated};
}
function saveMessage(service,p,m,pts) {
  const normalized = normalizeTelegramMessage(p,m,pts);
  check(!deleted(service,p,normalized.message_id), 'TELEGRAM_MESSAGE_DELETED');
  const old=sourceRows(service,p.sourceId).find(r=>r.message.message_id===normalized.message_id)?.message;
  check(!old || old.author_id===normalized.author_id, 'TELEGRAM_AUTHOR_IDENTITY_CHANGED');
  return ingestSource(service,normalized);
}
function saveUpdate(service,p,u) {
  fields(u,['kind','pts','pts_count','message','message_ids','channel_id']);
  check(integer(u.pts) && integer(u.pts_count) && u.channel_id === p.channelId, 'INVALID_TELEGRAM_UPDATE');
  check(['new','edit','delete'].includes(u.kind), 'UNSUPPORTED_TELEGRAM_UPDATE');
  if (u.kind !== 'delete') {
    check(u.message_ids === undefined, 'UNSUPPORTED_TELEGRAM_FIELDS');
    saveMessage(service,p,u.message,u.pts);
  } else {
    check(u.message === undefined && Array.isArray(u.message_ids) && u.message_ids.length > 0
      && u.message_ids.length <= 100 && u.message_ids.every(id=>integer(id))
      && new Set(u.message_ids).size === u.message_ids.length, 'INVALID_TELEGRAM_DELETE');
    const current = new Map(sourceRows(service,p.sourceId).map(r=>[r.message.message_id,r.message]));
    for (const id of u.message_ids) {
      const messageId=`message:${id}`, previous=current.get(messageId);
      if (!deleted(service,p,messageId)) service.store.event(service.config.partnerId,null,TOMBSTONE,'system',
        {source_id:p.sourceId,message_id:messageId,pts:u.pts});
      // Telegram deletion updates do not include author, body, creation or deletion time.
      // Unknown deletes stay native tombstones, never fabricate source identity or time.
      if (previous && previous.operation !== 'delete') ingestSource(service,{...previous,version:u.pts,operation:'delete',text:null});
    }
  }
  service.store.event(service.config.partnerId,null,UPDATE,'system',
    {source_id:p.sourceId,pts:u.pts,pts_count:u.pts_count,kind:u.kind,fingerprint:digest(u)});
}
function bounded(value) { check(Buffer.byteLength(JSON.stringify(value)) <= 1000000, 'TELEGRAM_PAGE_TOO_LARGE'); }

// Explicit operator-approved starting point. Not a claim of complete Telegram history.
// Call with bounded history read consistently at pts by the future transport.
export function bootstrapTelegramSource(service, sourceId, baseline) {
  const frozen=structuredClone(baseline);
  return service.exclusive(()=>service.store.transaction(()=>{
    const p=policy(service,sourceId); fields(frozen,['pts','history']); bounded(frozen);
    check(integer(frozen.pts) && Array.isArray(frozen.history) && frozen.history.length<=100, 'INVALID_TELEGRAM_BASELINE');
    check(new Set(frozen.history.map(m=>m.id)).size===frozen.history.length,'DUPLICATE_BASELINE_MESSAGE');
    const old=sourceCheckpoint(service,sourceId), fingerprint=digest(frozen);
    if(old) {check(old.policy_hash===digest(p) && old.baseline_hash===fingerprint,'TELEGRAM_BASELINE_COLLISION');return {duplicate:true,pts:old.pts};}
    check(sourceRows(service,sourceId).length===0,'TELEGRAM_SOURCE_ALREADY_POPULATED');
    for(const message of frozen.history) {
      const saved=saveMessage(service,p,message,frozen.pts);
      finishSource(service,saved.source_event_id,'bootstrap_context_only');
    }
    const state={source_id:sourceId,account_id:p.accountId,channel_id:p.channelId,policy_hash:digest(p),
      baseline_hash:fingerprint,pts:frozen.pts,phase:'catching_up',confirmed_at:null,reason:'BOOTSTRAP_REQUIRES_DIFFERENCE'};
    writeState(service,p,state);
    service.store.event(service.config.partnerId,null,'source.telegram.baseline','system',
      {source_id:sourceId,pts:frozen.pts,fingerprint,history_count:frozen.history.length,history_complete:false});
    return {duplicate:false,pts:state.pts};
  }));
}

export function disconnectTelegramSource(service,sourceId,reason='DISCONNECTED') {
  // Never persist raw provider errors, sessions or credentials.
  return service.exclusive(()=>service.store.transaction(()=>{
    const p=policy(service,sourceId),s=stateFor(service,p);
    writeState(service,p,{...s,phase:'catching_up',confirmed_at:null,reason:reason==='READ_FAILED'?'READ_FAILED':'DISCONNECTED'});
  }));
}

// Durable ordered handoff. A page must account for ALL pts advances; opaque/unmapped
// other_updates and DifferenceTooLong are deliberately rejected, never skipped.
export function applyTelegramDifference(service,sourceId,page) {
  const frozen=structuredClone(page);
  return service.exclusive(()=>{
    const p=policy(service,sourceId);
    try { return service.store.transaction(()=>{
      const s=stateFor(service,p); fields(frozen,['kind','account_id','channel_id','from_pts','to_pts','final','updates']);bounded(frozen);
      check(frozen.kind!=='too_long','TELEGRAM_DIFFERENCE_TOO_LONG');
      check(frozen.account_id===p.accountId && frozen.channel_id===p.channelId,'TELEGRAM_RESPONSE_SCOPE_MISMATCH');
      check(['difference','empty'].includes(frozen.kind) && integer(frozen.from_pts) && integer(frozen.to_pts)
        && frozen.to_pts>=frozen.from_pts && typeof frozen.final==='boolean' && Array.isArray(frozen.updates)
        && frozen.updates.length<=100,'INVALID_TELEGRAM_DIFFERENCE');
      check(frozen.kind!=='empty' || frozen.updates.length===0 && frozen.from_pts===frozen.to_pts,'INVALID_TELEGRAM_EMPTY');
      // Only the current cursor may confirm health. Historical duplicate pages cannot.
      check(frozen.from_pts<=s.pts,'TELEGRAM_PTS_GAP');
      let cursor=frozen.from_pts;
      const updates=[...frozen.updates].sort((a,b)=>a.pts-b.pts),seen=new Map();
      for(const u of updates) {
        check(integer(u.pts) && integer(u.pts_count),'INVALID_TELEGRAM_PTS');
        const fingerprint=digest(u);
        if(seen.has(u.pts)) {check(seen.get(u.pts)===fingerprint,'TELEGRAM_PTS_COLLISION');continue;}
        seen.set(u.pts,fingerprint);
        check(u.pts-u.pts_count===cursor,'TELEGRAM_PTS_GAP'); cursor=u.pts;
        if(u.pts<=s.pts) {
          const r=receipt(service,p,u.pts);
          check(r,'TELEGRAM_UNVERIFIED_REPLAY');
          check(JSON.parse(r.payload_json).fingerprint===fingerprint,'TELEGRAM_PTS_COLLISION');
        } else saveUpdate(service,p,u);
      }
      check(cursor===frozen.to_pts,'TELEGRAM_UNACCOUNTED_PTS');
      check(frozen.from_pts===s.pts || frozen.to_pts<=s.pts,'TELEGRAM_OVERLAPPING_PAGE');
      if(frozen.from_pts<s.pts) return {disposition:'duplicate',pts:s.pts};
      writeState(service,p,{...s,pts:cursor,phase:frozen.final?'current':'catching_up',
        confirmed_at:frozen.final?now():null,reason:frozen.final?null:'DIFFERENCE_NOT_FINAL'});
      return {disposition:'applied',pts:cursor,phase:frozen.final?'current':'catching_up'};
    }); } catch(error) {
      // Separate failure transaction keeps the previous cursor but invalidates evidence.
      // If DB is unavailable even here, rethrow: never report success or advance transport.
      service.store.transaction(()=>{
        const s=sourceCheckpoint(service,sourceId);
        if(s) writeState(service,p,{...s,phase:'blocked',confirmed_at:null,
          reason:s.reason===INTEGRITY || integrityErrors.has(error.code)?INTEGRITY:'INTAKE_FAILED'});
      });
      throw error;
    }
  });
}

// One bounded read per caller tick; no timers, background workers, implicit login or IO.
// transport must supply a narrowed readDifference capability, not a full client.
export async function pollTelegramSource(service,sourceId,transport) {
  check(transport && typeof transport.readDifference==='function','READ_DIFFERENCE_REQUIRED');
  await disconnectTelegramSource(service,sourceId);
  const p=policy(service,sourceId),s=stateFor(service,p);
  let page;
  try {
    page=await transport.readDifference(Object.freeze({accountId:p.accountId,channelId:p.channelId,pts:s.pts,limit:100}));
  } catch(error) {
    await disconnectTelegramSource(service,sourceId,'READ_FAILED'); throw error;
  }
  // An intake failure is not a transient read failure. Preserve its blocked state.
  check(page?.from_pts===s.pts,'TELEGRAM_RESPONSE_CURSOR_MISMATCH');
  return applyTelegramDifference(service,sourceId,page);
}
