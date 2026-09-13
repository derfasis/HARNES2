// No Telegram client, credentials, network, send API or model is imported here.
// This is a bounded adapter-facing channel difference contract, NOT raw MTProto.
import { ensure, now } from '../errors.mjs';
import { automaticBoundary, digest, ingestSource, finishSource, sourceRows, sourceCheckpoint, SOURCE_CHECKPOINT_CHANNEL, validateSourceCheckpoint } from '../source-ingestion.mjs';

const UPDATE = 'source.telegram.update';
const TOMBSTONE = 'source.telegram.tombstone';
const PROOF = 'source.telegram.proof';
const RECOVERY = 'source.telegram.reconciliation';
const RECOVERY_REQUEST = 'source.telegram.recovery.requested';
const RECOVERY_FINISHED = 'source.telegram.recovery.finished';
export const TELEGRAM_RECONCILIATION = 'telegram-reconciliation-v1';
export const TELEGRAM_COUNTERLESS = 'telegram-reconciliation-v2';
const MAX_PTS = 2147483647;
const INTEGRITY = 'INTEGRITY_RECONCILIATION_REQUIRED';
const integrityErrors = new Set(['TELEGRAM_PTS_COLLISION','SOURCE_VERSION_COLLISION','TELEGRAM_AUTHOR_IDENTITY_CHANGED',
  'SOURCE_CREATION_TIME_CHANGED','SOURCE_UPDATE_TIME_ROLLBACK','TELEGRAM_MESSAGE_DELETED','TELEGRAM_DIFFERENCE_TOO_LONG',
  'SOURCE_TRANSPORT_CORRUPT_CHECKPOINT','TELEGRAM_RESPONSE_CURSOR_MISMATCH','TELEGRAM_SNAPSHOT_CONFLICT',
  'TELEGRAM_UNVERIFIED_REPLAY','TELEGRAM_PTS_GAP','TELEGRAM_UNACCOUNTED_PTS',INTEGRITY]);
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
function stateFor(service, p, authorizationId=null) {
  const state = sourceCheckpoint(service, p.sourceId);
  check(state, 'TELEGRAM_BOOTSTRAP_REQUIRED');
  check(state.policy_hash === digest(p), 'TELEGRAM_SOURCE_POLICY_CHANGED');
  validateSourceCheckpoint(state,p);
  check(state.reason!==INTEGRITY || authorizationId && telegramRecoveryAuthorization(service,p)===authorizationId,INTEGRITY);
  return state;
}
export const telegramUpdateKey = u => u.pts_count===0 ? digest([u.pts,u.kind,u.message?.id??[...u.message_ids].sort((a,b)=>a-b)]) : u.pts;
function receipt(service, p, pts, updateKey=null) {
  return service.store.get(`SELECT payload_json FROM events WHERE partner_id=? AND kind=? AND actor='system'
    AND json_extract(payload_json,'$.source_id')=? AND json_extract(payload_json,'$.pts')=?
    AND (json_extract(payload_json,'$.update_key')=? OR ? IS NULL AND json_extract(payload_json,'$.pts_count')>0) LIMIT 1`,
  service.config.partnerId, UPDATE, p.sourceId, pts,updateKey,updateKey);
}
export { policy as telegramSourcePolicy, receipt as telegramUpdateReceipt };
export function telegramRecoveryAuthorization(service,p) {
  const s=sourceCheckpoint(service,p.sourceId);
  if(s?.reason!==INTEGRITY)return null;
  validateSourceCheckpoint(s,p);
  const row=service.store.get(`SELECT id,payload_json FROM events WHERE partner_id=? AND kind=? AND actor='operator'
    AND json_extract(payload_json,'$.source_id')=? ORDER BY id DESC LIMIT 1`,service.config.partnerId,RECOVERY_REQUEST,p.sourceId);
  if(!row)return null;
  const request=JSON.parse(row.payload_json),id=String(row.id);
  fields(request,['source_id','checkpoint_fingerprint','reason','mode']);
  check(request.source_id===p.sourceId && request.mode==='retry_same_cursor','TELEGRAM_RECOVERY_CHECKPOINT_MISMATCH');
  if(request.checkpoint_fingerprint!==digest(s))return null;
  return service.store.get(`SELECT id FROM events WHERE partner_id=? AND kind=? AND actor='system'
    AND json_extract(payload_json,'$.authorization_id')=?`,service.config.partnerId,RECOVERY_FINISHED,id) ? null : id;
}
// Existing operator command, not a reset or permission to read/send by itself.
export function requestTelegramRecovery(service,raw,actor) {
  check(actor?.kind==='operator','TELEGRAM_RECOVERY_OPERATOR_REQUIRED');
  fields(raw,['source_id','checkpoint_fingerprint','reason']);
  const p=policy(service,raw.source_id),s=sourceCheckpoint(service,p.sourceId);
  check(s,'TELEGRAM_BOOTSTRAP_REQUIRED');validateSourceCheckpoint(s,p);
  check(s.reason===INTEGRITY && raw.checkpoint_fingerprint===digest(s),'TELEGRAM_RECOVERY_CHECKPOINT_MISMATCH');
  check(typeof raw.reason==='string' && raw.reason.trim() && raw.reason.length<=1000,'TELEGRAM_RECOVERY_REASON_REQUIRED');
  service.store.event(service.config.partnerId,null,RECOVERY_REQUEST,'operator',
    {source_id:p.sourceId,checkpoint_fingerprint:digest(s),reason:raw.reason,mode:'retry_same_cursor'});
  return {authorization_id:String(service.store.get('SELECT last_insert_rowid() AS id').id),pts:s.pts,
    phase:s.phase,contact_permission:false,allowed_effects:[]};
}
function finishRecovery(service,p,authorizationId,status) {
  if(authorizationId)service.store.event(service.config.partnerId,null,RECOVERY_FINISHED,'system',
    {source_id:p.sourceId,authorization_id:authorizationId,status});
}
function deleted(service,p,messageId) {
  return service.store.get(`SELECT id FROM events WHERE partner_id=? AND kind=? AND actor='system'
    AND json_extract(payload_json,'$.source_id')=? AND json_extract(payload_json,'$.message_id')=? LIMIT 1`,
  service.config.partnerId, TOMBSTONE, p.sourceId, messageId);
}
function timestamp(seconds) {
  check(integer(seconds), 'INVALID_TELEGRAM_TIME');
  check(seconds * 1000 <= Date.now(),'TELEGRAM_CLOCK_SKEW');
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
function proof(service,p,eventId,value) {
  service.store.event(service.config.partnerId,null,PROOF,'system',
    {contract_version:TELEGRAM_RECONCILIATION,source_id:p.sourceId,account_id:p.accountId,
      channel_id:p.channelId,source_event_id:eventId,...value});
}
function latestProof(service,p,eventId) {
  const row=service.store.get(`SELECT payload_json FROM events WHERE partner_id=? AND kind=? AND actor='system'
    AND json_extract(payload_json,'$.source_id')=? AND json_extract(payload_json,'$.source_event_id')=? ORDER BY id DESC LIMIT 1`,
  service.config.partnerId,PROOF,p.sourceId,eventId);
  return row ? JSON.parse(row.payload_json) : null;
}
function saveMessage(service,p,m,pts,ptsCount,recovery=null) {
  const row=sourceRows(service,p.sourceId).find(r=>r.message.message_id===`message:${m.id}`),old=row?.message;
  // Evidence revisions are application-local, not Telegram per-message PTS.
  const version=Math.max(pts,(old?.version??0)+1);
  const normalized = normalizeTelegramMessage(p,m,version);
  check(!deleted(service,p,normalized.message_id), 'TELEGRAM_MESSAGE_DELETED');
  check(!old || old.author_id===normalized.author_id, 'TELEGRAM_AUTHOR_IDENTITY_CHANGED');
  if(recovery && old && digest(old)===digest({...normalized,version:old.version}))return;
  const saved=ingestSource(service,normalized);
  proof(service,p,saved.source_event_id,{kind:'native_event',...recovery,pts,pts_count:ptsCount,content_fingerprint:digest(m)});
  return saved;
}
function saveUpdate(service,p,u,recovery=null) {
  fields(u,['kind','pts','pts_count','message','message_ids','channel_id','metadata_type','metadata_fingerprint']);
  check(integer(u.pts) && (integer(u.pts_count) || recovery && u.pts_count===0 && ['edit','delete'].includes(u.kind))
    && u.channel_id === p.channelId, 'INVALID_TELEGRAM_UPDATE');
  check(['new','edit','delete','metadata'].includes(u.kind), 'UNSUPPORTED_TELEGRAM_UPDATE');
  if(u.kind==='metadata')validateMetadata(u);
  else if (u.kind !== 'delete') {
    check(u.metadata_type===undefined && u.metadata_fingerprint===undefined,'UNSUPPORTED_TELEGRAM_FIELDS');
    check(u.message_ids === undefined, 'UNSUPPORTED_TELEGRAM_FIELDS');
    check(!recovery || u.message?.edit_date!=null,'INVALID_TELEGRAM_UPDATE');
    saveMessage(service,p,u.message,u.pts,u.pts_count,recovery);
  } else {
    check(u.metadata_type===undefined && u.metadata_fingerprint===undefined,'UNSUPPORTED_TELEGRAM_FIELDS');
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
      if (previous && previous.operation !== 'delete') {
        const saved=ingestSource(service,{...previous,version:Math.max(u.pts,previous.version+1),operation:'delete',text:null});
        proof(service,p,saved.source_event_id,{kind:'native_event',...recovery,pts:u.pts,pts_count:u.pts_count,operation:'delete'});
      }
    }
  }
  service.store.event(service.config.partnerId,null,UPDATE,'system',
    {source_id:p.sourceId,pts:u.pts,pts_count:u.pts_count,kind:u.kind,fingerprint:digest(u),
      ...(recovery?{update_key:telegramUpdateKey(u),proof_kind:'reconciled_event',batch_id:recovery.batch_id}:{}),
      ...(u.kind==='metadata'?{proof_kind:'native_event',metadata_type:u.metadata_type,content_basis:'plain_text_only'}:{})});
}
function validateMetadata(u) {
  check(u.message===undefined && u.message_ids===undefined && u.metadata_type==='webpage'
    && typeof u.metadata_fingerprint==='string' && /^[a-f0-9]{64}$/.test(u.metadata_fingerprint),'INVALID_TELEGRAM_METADATA');
}
function bounded(value) { check(Buffer.byteLength(JSON.stringify(value)) <= 1000000, 'TELEGRAM_PAGE_TOO_LARGE'); }

export function telegramRecoveryCoverage(service,p,pts,ptsCount=1) {
  const row=service.store.get(`SELECT payload_json FROM events WHERE partner_id=? AND kind=? AND actor='system'
    AND json_extract(payload_json,'$.source_id')=? AND json_extract(payload_json,'$.from_pts')<=?
    AND json_extract(payload_json,'$.watermark_pts')>=? ORDER BY id DESC LIMIT 1`,
  service.config.partnerId,RECOVERY,p.sourceId,pts-ptsCount,pts);
  if(!row)return false;
  const r=JSON.parse(row.payload_json),{batch_id,...body}=r;
  check([TELEGRAM_RECONCILIATION,TELEGRAM_COUNTERLESS].includes(r.contract_version) && r.account_id===p.accountId && r.channel_id===p.channelId
    && integer(r.from_pts) && integer(r.watermark_pts) && batch_id===digest(body)
    && r.watermark_pts<=sourceCheckpoint(service,p.sourceId)?.pts,'TELEGRAM_SNAPSHOT_CONFLICT');
  return true;
}
function recoveryBody(p,page) {
  return {contract_version:page.contract_version,source_id:p.sourceId,account_id:p.accountId,channel_id:p.channelId,
    from_pts:page.from_pts,watermark_pts:page.to_pts,response_kind:page.kind,final:page.final,
    request:{method:'updates.getChannelDifference',filter:'channelMessagesFilterEmpty',force:false,limit:100},
    response_fingerprint:page.response_fingerprint,snapshot_fingerprint:digest([...page.snapshots].sort((a,b)=>a.id-b.id)),
    ...(page.contract_version===TELEGRAM_COUNTERLESS?{recovered_fingerprint:digest([...page.recovered_updates].sort((a,b)=>telegramUpdateKey(a).localeCompare(telegramUpdateKey(b))))}:{})};
}
function reconcile(service,p,s,page) {
  check(Array.isArray(page.snapshots) && page.snapshots.length<=100,'INVALID_TELEGRAM_DIFFERENCE');
  check(typeof page.response_fingerprint==='string' && /^[a-f0-9]{64}$/.test(page.response_fingerprint),'INVALID_TELEGRAM_DIFFERENCE');
  const recovered=page.recovered_updates??[];
  check(Array.isArray(recovered) && recovered.length<=100 && page.updates.length+recovered.length<=100
    && (page.contract_version===TELEGRAM_COUNTERLESS ? page.kind==='difference' && recovered.length>0 : page.recovered_updates===undefined),'INVALID_TELEGRAM_DIFFERENCE');
  const body=recoveryBody(p,page),batchId=digest(body);
  const previous=service.store.get(`SELECT id FROM events WHERE partner_id=? AND kind=? AND actor='system'
    AND json_extract(payload_json,'$.batch_id')=?`,service.config.partnerId,RECOVERY,batchId);
  const historical=page.from_pts<s.pts;
  if(historical)check(previous && page.to_pts<=s.pts,'TELEGRAM_UNVERIFIED_REPLAY');
  else check(page.from_pts===s.pts,'TELEGRAM_PTS_GAP');
  const snapshots=new Map();
  for(const m of page.snapshots) {
    normalizeTelegramMessage(p,m,1);
    check(!snapshots.has(m.id),'TELEGRAM_SNAPSHOT_CONFLICT');snapshots.set(m.id,m);
  }
  check(page.kind!=='empty' || snapshots.size===0,'INVALID_TELEGRAM_EMPTY');
  const recoveredCoverage=recovered.some(u=>u.pts>page.from_pts && u.pts<=page.to_pts);
  const updates=[...page.updates].sort((a,b)=>a.pts-b.pts),seen=new Map();let cursor=page.from_pts;
  for(const u of updates) {
    check(integer(u.pts) && integer(u.pts_count) && u.pts<=page.to_pts && u.pts-u.pts_count>=0,'INVALID_TELEGRAM_PTS');
    const fingerprint=digest(u);
    if(seen.has(u.pts)){check(seen.get(u.pts)===fingerprint,'TELEGRAM_PTS_COLLISION');continue;}
    seen.set(u.pts,fingerprint);
    if(u.pts<=s.pts) {
      const old=receipt(service,p,u.pts);
      if(old)check(JSON.parse(old.payload_json).fingerprint===fingerprint,'TELEGRAM_PTS_COLLISION');
      else {
        check(telegramRecoveryCoverage(service,p,u.pts,u.pts_count),'TELEGRAM_UNVERIFIED_REPLAY');
        const sourceEventIds=validateHistoricalUpdate(service,p,u);
        service.store.event(service.config.partnerId,null,UPDATE,'system',
          {source_id:p.sourceId,pts:u.pts,pts_count:u.pts_count,kind:u.kind,fingerprint,
            proof_kind:'native_event',source_event_ids:sourceEventIds,disposition:'covered_historical_event'});
      }
      continue;
    }
    check(u.pts-u.pts_count>=cursor,'TELEGRAM_PTS_GAP');
    if(!snapshots.size && !recoveredCoverage)check(u.pts-u.pts_count===cursor,'TELEGRAM_PTS_GAP');cursor=u.pts;
    saveUpdate(service,p,u);
  }
  // Zero-count difference updates carry material state, not a native event interval.
  // Dedup them by scoped target as multiple updates may share one watermark.
  const recoveredSeen=new Map(),targets=new Set();
  for(const u of [...recovered].sort((a,b)=>a.pts-b.pts)) {
    fields(u,['kind','pts','pts_count','message','message_ids','channel_id']);
    check(integer(u.pts) && u.pts_count===0 && ['edit','delete'].includes(u.kind) && u.pts<=page.to_pts,'INVALID_TELEGRAM_PTS');
    check(u.channel_id===p.channelId,'INVALID_TELEGRAM_UPDATE');
    if(u.kind==='edit'){check(u.message_ids===undefined && u.message?.edit_date!=null,'INVALID_TELEGRAM_UPDATE');normalizeTelegramMessage(p,u.message,1);}
    else check(u.message===undefined && Array.isArray(u.message_ids) && u.message_ids.length>0 && u.message_ids.length<=100
      && u.message_ids.every(id=>integer(id)) && new Set(u.message_ids).size===u.message_ids.length,'INVALID_TELEGRAM_DELETE');
    const key=telegramUpdateKey(u),fingerprint=digest(u);
    if(recoveredSeen.has(key)){check(recoveredSeen.get(key)===fingerprint,'TELEGRAM_PTS_COLLISION');continue;}
    recoveredSeen.set(key,fingerprint);
    const samePtsPositive=u.kind==='delete' && updates.find(v=>v.pts===u.pts) || null;
    if(samePtsPositive) {
      // The server may deliver one delete natively (positive count) and again
      // counterless in the difference at the same watermark: equivalent message
      // id sets prove it is one event, not two deletions.
      check(samePtsPositive.kind==='delete' && samePtsPositive.message_ids.length===u.message_ids.length
        && [...samePtsPositive.message_ids].sort((a,b)=>a-b).join()===u.message_ids.slice().sort((a,b)=>a-b).join(),
        'TELEGRAM_SNAPSHOT_CONFLICT');
    }
    for(const id of u.message ? [u.message.id] : u.message_ids) {
      check(!targets.has(`${u.pts}:${id}`),'TELEGRAM_PTS_COLLISION');targets.add(`${u.pts}:${id}`);
      if(samePtsPositive)continue;
      const last=updates.filter(v=>v.message?.id===id || v.message_ids?.includes(id)).at(-1);
      check(!last || last.pts<u.pts || last.pts===u.pts && last.message && u.message
        && digest(last.message)===digest(u.message),'TELEGRAM_SNAPSHOT_CONFLICT');
    }
    const old=receipt(service,p,u.pts,key);
    if(old){check(JSON.parse(old.payload_json).fingerprint===fingerprint,'TELEGRAM_PTS_COLLISION');continue;}
    if(historical || u.pts<page.from_pts) {
      check(telegramRecoveryCoverage(service,p,u.pts,0),'TELEGRAM_UNVERIFIED_REPLAY');validateHistoricalUpdate(service,p,u);
      service.store.event(service.config.partnerId,null,UPDATE,'system',{source_id:p.sourceId,pts:u.pts,pts_count:0,kind:u.kind,
        fingerprint,update_key:key,proof_kind:'reconciled_event',batch_id:batchId,disposition:'covered_historical_event'});
    } else saveUpdate(service,p,u,{contract_version:TELEGRAM_COUNTERLESS,kind:'reconciled_event',
      from_pts:page.from_pts,watermark_pts:page.to_pts,batch_id:batchId});
  }
  if(historical)return false;
  if(!snapshots.size)check(cursor===page.to_pts || recovered.some(u=>u.pts===page.to_pts && u.pts>page.from_pts),'TELEGRAM_UNACCOUNTED_PTS');
  // A returned snapshot is final material state at the response watermark, not
  // another event placed arbitrarily among native edit/delete updates.
  for(const [id,m] of snapshots) {
    const last=[...updates.filter(u=>u.pts>page.from_pts),...recovered].sort((a,b)=>a.pts-b.pts)
      .filter(u=>u.message?.id===id || u.message_ids?.includes(id)).at(-1);
    check(!last || last.message && digest(last.message)===digest(m),'TELEGRAM_SNAPSHOT_CONFLICT');
    const old=sourceRows(service,p.sourceId).find(r=>r.message.message_id===`message:${id}`);
    const normalized=normalizeTelegramMessage(p,m,(old?.message.version??0)+1);
    check(old || page.to_pts>page.from_pts,'TELEGRAM_SNAPSHOT_CONFLICT');
    check(!old || old.message.author_id===normalized.author_id,'TELEGRAM_AUTHOR_IDENTITY_CHANGED');
    check(!deleted(service,p,normalized.message_id) && old?.message.operation!=='delete','TELEGRAM_MESSAGE_DELETED');
    const {version:ignored,...content}=normalized;
    const {version:oldVersion,...oldContent}=old?.message??{};
    const identical=!!old && digest(content)===digest(oldContent);
    const oldProof=old && latestProof(service,p,old.event_id);
    if(old && !identical)check(oldProof?.kind==='reconciled_snapshot' && page.to_pts>oldProof.watermark_pts
      && m.edit_date!=null,'TELEGRAM_SNAPSHOT_CONFLICT');
    const saved=identical ? {source_event_id:old.event_id} : ingestSource(service,normalized);
    // Preserve native provenance for an identical native-backed version.
    if(!identical || oldProof?.kind==='reconciled_snapshot')proof(service,p,saved.source_event_id,
      {kind:'reconciled_snapshot',message_id:normalized.message_id,from_pts:page.from_pts,
        watermark_pts:page.to_pts,batch_id:batchId,content_fingerprint:digest(m)});
  }
  if(!previous)service.store.event(service.config.partnerId,null,RECOVERY,'system',{...body,batch_id:batchId});
  return true;
}
function validateHistoricalUpdate(service,p,u) {
  fields(u,['kind','pts','pts_count','message','message_ids','channel_id','metadata_type','metadata_fingerprint']);
  check(u.channel_id===p.channelId && ['new','edit','delete','metadata'].includes(u.kind),'INVALID_TELEGRAM_UPDATE');
  if(u.kind==='metadata'){validateMetadata(u);return [];}
  check(u.metadata_type===undefined && u.metadata_fingerprint===undefined,'UNSUPPORTED_TELEGRAM_FIELDS');
  const rows=sourceRows(service,p.sourceId);
  if(u.kind==='delete') {
    check(u.message===undefined && Array.isArray(u.message_ids) && u.message_ids.length>0 && u.message_ids.length<=100
      && u.message_ids.every(id=>integer(id)) && new Set(u.message_ids).size===u.message_ids.length,'INVALID_TELEGRAM_DELETE');
    const known=u.message_ids.map(id=>rows.find(r=>r.message.message_id===`message:${id}`));
    check(known.every(r=>r?.message.operation==='delete'),'TELEGRAM_SNAPSHOT_CONFLICT');
    return known.map(r=>r.event_id);
  } else {
    check(u.message_ids===undefined,'UNSUPPORTED_TELEGRAM_FIELDS');
    const old=rows.find(r=>r.message.message_id===`message:${u.message?.id}`),r=old && latestProof(service,p,old.event_id);
    check(old && r && (r.watermark_pts??r.pts)>=u.pts,'TELEGRAM_SNAPSHOT_CONFLICT');
    const m=normalizeTelegramMessage(p,u.message,old.message.version);
    check(digest(old.message)===digest(m),'TELEGRAM_SNAPSHOT_CONFLICT');
    return [old.event_id];
  }
}

// Explicit operator-approved starting point. Not a claim of complete Telegram history.
// Call with bounded history read consistently at pts by the future transport.
export function bootstrapTelegramSource(service, sourceId, baseline,confirmBaseline=()=>true,stillOwned=()=>true) {
  const frozen=structuredClone(baseline);
  return service.exclusive(()=>service.store.transaction(()=>{
    check(stillOwned()===true,'TELEGRAM_READER_RETIRED');
    const p=policy(service,sourceId); fields(frozen,['pts','history']); bounded(frozen);
    check(integer(frozen.pts) && Array.isArray(frozen.history) && frozen.history.length<=100, 'INVALID_TELEGRAM_BASELINE');
    check(new Set(frozen.history.map(m=>m.id)).size===frozen.history.length,'DUPLICATE_BASELINE_MESSAGE');
    const old=sourceCheckpoint(service,sourceId), fingerprint=digest(frozen);
    if(old) {check(old.policy_hash===digest(p) && old.baseline_hash===fingerprint,'TELEGRAM_BASELINE_COLLISION');return {duplicate:true,pts:old.pts};}
    check(sourceRows(service,sourceId).length===0,'TELEGRAM_SOURCE_ALREADY_POPULATED');
    for(const message of frozen.history) {
      const saved=ingestSource(service,normalizeTelegramMessage(p,message,1));
      proof(service,p,saved.source_event_id,{kind:'reconciled_snapshot',message_id:`message:${message.id}`,
        watermark_pts:frozen.pts,batch_id:fingerprint,content_fingerprint:digest(message),basis:'bootstrap_context_only'});
      finishSource(service,saved.source_event_id,'bootstrap_context_only');
    }
    const accepted=confirmBaseline()===true;
    const state={source_id:sourceId,account_id:p.accountId,channel_id:p.channelId,policy_hash:digest(p),
      baseline_hash:fingerprint,pts:frozen.pts,phase:accepted?'catching_up':'blocked',confirmed_at:null,
      reason:accepted?'BOOTSTRAP_REQUIRES_DIFFERENCE':INTEGRITY};
    writeState(service,p,state);
    service.store.event(service.config.partnerId,null,'source.telegram.baseline','system',
      {source_id:sourceId,pts:frozen.pts,fingerprint,history_count:frozen.history.length,history_complete:false});
    return {duplicate:false,pts:state.pts};
  }));
}

export function disconnectTelegramSource(service,sourceId,reason='DISCONNECTED',stillOwned=()=>true,authorizationId=null) {
  // Never persist raw provider errors, sessions or credentials.
  return service.exclusive(()=>service.store.transaction(()=>{
    if(stillOwned()!==true)return;
    const p=policy(service,sourceId),latched=sourceCheckpoint(service,sourceId);
    if(latched?.reason===INTEGRITY){validateSourceCheckpoint(latched,p);
      if(authorizationId && telegramRecoveryAuthorization(service,p)===authorizationId)finishRecovery(service,p,authorizationId,'failed');return;}
    const s=stateFor(service,p);
    writeState(service,p,{...s,phase:reason===INTEGRITY?'blocked':'catching_up',confirmed_at:null,
      reason:reason===INTEGRITY?INTEGRITY:reason==='TELEGRAM_CLOCK_SKEW'?reason:reason==='READ_FAILED'?'READ_FAILED':'DISCONNECTED'});
  }));
}

// Durable ordered handoff. A page must account for ALL pts advances; opaque/unmapped
// other_updates and DifferenceTooLong are deliberately rejected, never skipped.
export function applyTelegramDifference(service,sourceId,page,expectedPts=null,confirmCurrent=()=>true,stillOwned=()=>true,authorizationId=null) {
  const frozen=structuredClone(page);
  return service.exclusive(()=>{
    const p=policy(service,sourceId);
    try { return service.store.transaction(()=>{
      check(stillOwned()===true,'TELEGRAM_READER_RETIRED');
      const s=stateFor(service,p,authorizationId); fields(frozen,['kind','account_id','channel_id','from_pts','to_pts','final','updates','contract_version','snapshots','response_fingerprint','recovered_updates']);bounded(frozen);
      const reconciled=frozen.contract_version!==undefined;
      check(reconciled ? [TELEGRAM_RECONCILIATION,TELEGRAM_COUNTERLESS].includes(frozen.contract_version)
        : frozen.snapshots===undefined && frozen.response_fingerprint===undefined && frozen.recovered_updates===undefined,'INVALID_TELEGRAM_DIFFERENCE');
      check(frozen.kind!=='too_long','TELEGRAM_DIFFERENCE_TOO_LONG');
      check(frozen.account_id===p.accountId && frozen.channel_id===p.channelId,'TELEGRAM_RESPONSE_SCOPE_MISMATCH');
      check(expectedPts===null || frozen.from_pts===expectedPts,'TELEGRAM_RESPONSE_CURSOR_MISMATCH');
      check(['difference','empty'].includes(frozen.kind) && integer(frozen.from_pts) && integer(frozen.to_pts)
        && frozen.to_pts>=frozen.from_pts && typeof frozen.final==='boolean' && Array.isArray(frozen.updates)
        && frozen.updates.length<=100,'INVALID_TELEGRAM_DIFFERENCE');
      check(reconciled || frozen.kind!=='empty' || frozen.updates.length===0 && frozen.from_pts===frozen.to_pts,'INVALID_TELEGRAM_EMPTY');
      check(!authorizationId || reconciled && frozen.from_pts===s.pts,'TELEGRAM_RECOVERY_TYPED_RESPONSE_REQUIRED');
      if(reconciled) {
        if(!reconcile(service,p,s,frozen))return {disposition:'duplicate',pts:s.pts};
        const final=frozen.final && confirmCurrent()===true;
        writeState(service,p,{...s,pts:frozen.to_pts,phase:final?'current':'catching_up',
          confirmed_at:final?now():null,reason:final?null:'DIFFERENCE_NOT_FINAL'});
        finishRecovery(service,p,authorizationId,'validated_page');
        return {disposition:'applied',pts:frozen.to_pts,phase:final?'current':'catching_up'};
      }
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
      // Optional native-reader attestation is synchronous, checked inside the commit.
      const final=frozen.final && confirmCurrent()===true;
      writeState(service,p,{...s,pts:cursor,phase:final?'current':'catching_up',
        confirmed_at:final?now():null,reason:final?null:'DIFFERENCE_NOT_FINAL'});
      return {disposition:'applied',pts:cursor,phase:final?'current':'catching_up'};
    }); } catch(error) {
      if(stillOwned()!==true)throw error;
      // Separate failure transaction keeps the previous cursor but invalidates evidence.
      // If DB is unavailable even here, rethrow: never report success or advance transport.
      service.store.transaction(()=>{
        const s=sourceCheckpoint(service,sourceId);
        if(s) writeState(service,p,{...s,phase:error.code==='TELEGRAM_CLOCK_SKEW' && s.reason!==INTEGRITY?'catching_up':'blocked',confirmed_at:null,
          reason:s.reason===INTEGRITY || integrityErrors.has(error.code)?INTEGRITY:error.code==='TELEGRAM_CLOCK_SKEW'?error.code:'INTAKE_FAILED'});
        if(authorizationId && telegramRecoveryAuthorization(service,p)===authorizationId)finishRecovery(service,p,authorizationId,'failed');
      });
      throw error;
    }
  });
}

// One bounded read per caller tick; no timers, background workers, implicit login or IO.
// transport must supply a narrowed readDifference capability, not a full client.
export async function pollTelegramSource(service,sourceId,transport) {
  check(transport && typeof transport.readDifference==='function','READ_DIFFERENCE_REQUIRED');
  const stillOwned=()=>transport.ownsSource ? transport.ownsSource()===true : true;
  check(stillOwned(),'TELEGRAM_READER_RETIRED');
  await disconnectTelegramSource(service,sourceId,'DISCONNECTED',stillOwned);
  const p=policy(service,sourceId),authorizationId=transport.recoveryAuthorization?.()??null,s=stateFor(service,p,authorizationId);
  let page;
  try {
    page=await transport.readDifference(Object.freeze({accountId:p.accountId,channelId:p.channelId,pts:s.pts,limit:100}));
  } catch(error) {
    await disconnectTelegramSource(service,sourceId,['TELEGRAM_MAPPING_INTEGRITY','TELEGRAM_UNSUPPORTED_WATERMARK_ADVANCE'].includes(error.code)
      ?INTEGRITY:error.code==='TELEGRAM_CLOCK_SKEW'?error.code:'READ_FAILED',stillOwned,authorizationId); throw error;
  }
  // An intake failure is not a transient read failure. Preserve its blocked state.
  const result=await applyTelegramDifference(service,sourceId,page,s.pts,
    ()=>transport.confirmCurrent ? transport.confirmCurrent(page.to_pts) : true,stillOwned,authorizationId);
  // Native buffers may be released only AFTER the durable source/receipt/cursor commit.
  if(transport.acknowledge) await transport.acknowledge(result.pts);
  return result;
}
