// HARNES authority/evidence boundary, not a Telegram parser or history downloader.
import path from 'node:path';
import Ajv from 'ajv';
import { ROOT, readJson } from './config.mjs';
import { id } from './store.mjs';
import { AppError, ensure } from './errors.mjs';
import { digest, sourceCheckpoint, validateSourceCheckpoint, SOURCE_CHECKPOINT_CHANNEL } from './source-ingestion.mjs';
import { telegramSourcePolicy, telegramRecoveryAuthorization } from './sources/telegram-readonly.mjs';

const REQUEST = 'source.telegram.rebaseline.requested', FINISHED = 'source.telegram.rebaseline.finished';
const INTEGRITY = 'INTEGRITY_RECONCILIATION_REQUIRED', INVALID = 'SOURCE_TRANSPORT_OBSERVATION_EPOCH_INVALID';
const validate = new Ajv({strict:true}).compile(readJson(path.join(ROOT,'contracts/telegram-rebaseline.schema.json')));
const check = (ok,code) => ensure(ok,code,409,code);
const integer = x => Number.isSafeInteger(x) && x > 0;
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const uuid = x => typeof x === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const iso = x => typeof x === 'string' && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
const transitionHash = row => digest(Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'transition_sha256')));
function event(store, partner, eventId, kind, actor) {
  const row = store.get('SELECT * FROM events WHERE id=? AND partner_id=? AND kind=? AND actor=?',eventId,partner,kind,actor);
  check(row,INVALID); return {...row,payload:JSON.parse(row.payload_json)};
}
function chain(store,partner,source) {
  try {
    const rows = store.all('SELECT * FROM source_observation_epochs WHERE partner_id=? AND source_ref=? ORDER BY generation LIMIT 129',partner,source);
    check(rows.length <= 128,INVALID); let previous = null;
    for (const row of rows) {
      check(uuid(row.id) && row.partner_id === partner && row.source_ref === source
        && row.generation === (previous?.generation ?? 0)+1 && row.previous_epoch_id === (previous?.id ?? null)
        && integer(row.authorization_event_id) && integer(row.baseline_event_id)
        && row.observation_floor === row.baseline_event_id && row.baseline_event_id > row.authorization_event_id
        && iso(row.created_at) && hash(row.baseline_hash) && hash(row.transition_sha256)
        && row.transition_sha256 === transitionHash(row),INVALID);
      const policy = JSON.parse(row.policy_json), prior = JSON.parse(row.previous_checkpoint_json);
      validateSourceCheckpoint(prior,policy);
      check(policy.sourceId === source && policy.accountId === row.account_id && policy.channelId === row.channel_id
        && prior.reason === INTEGRITY && row.baseline_pts > prior.pts && row.baseline_pts <= 2147483647
        && row.baseline_hash === digest({pts:row.baseline_pts,history:[]})
        && (!previous || prior.baseline_hash === previous.baseline_hash && prior.pts >= previous.baseline_pts
          && row.observation_floor > previous.observation_floor),INVALID);
      const requested = event(store,partner,row.authorization_event_id,REQUEST,'operator');
      const request = requested.payload, {policy_hash,...raw} = request;
      check(validate(raw) && raw.reason.trim() && iso(raw.expires_at) && iso(requested.created_at)
        && request.source_id === source && request.checkpoint_fingerprint === digest(prior)
        && policy_hash === digest(policy) && row.created_at >= requested.created_at
        && row.created_at < request.expires_at && Date.parse(request.expires_at)-Date.parse(requested.created_at) <= 3600000,INVALID);
      const baseline = event(store,partner,row.baseline_event_id,'source.telegram.baseline','system');
      check(digest(baseline.payload) === digest({source_id:source,pts:row.baseline_pts,fingerprint:row.baseline_hash,
        history_count:0,history_complete:false,epoch_id:row.id,generation:row.generation}) && baseline.created_at === row.created_at,INVALID);
      const receipts = store.all(`SELECT payload_json FROM events WHERE partner_id=? AND kind=? AND actor='system'
        AND payload_json->>'$.authorization_id'=?`,partner,FINISHED,String(row.authorization_event_id));
      check(receipts.length === 1 && digest(JSON.parse(receipts[0].payload_json)) === digest({source_id:source,
        authorization_id:String(row.authorization_event_id),status:'committed',epoch_id:row.id}),INVALID);
      previous = row;
    }
    // Removing the projection must not silently reinstate a legacy floor of zero.
    const markers = store.all(`SELECT id,payload_json FROM events WHERE partner_id=? AND kind='source.telegram.baseline'
      AND actor='system' AND payload_json->>'$.source_id'=? AND json_type(payload_json,'$.epoch_id') IS NOT NULL ORDER BY id LIMIT 129`,partner,source);
    check(markers.length === rows.length && markers.every((marker,i) => marker.id === rows[i].baseline_event_id),INVALID);
    return previous;
  } catch (error) { if(error instanceof AppError && error.code === INVALID) throw error; throw new AppError(INVALID,409,INVALID); }
}
function checkpointBinding(store,partner,source,epoch) {
  if(!epoch) return;
  const cursor = store.get('SELECT cursor FROM channel_offsets WHERE channel=? AND account_id=?',SOURCE_CHECKPOINT_CHANNEL,digest([partner,source]));
  check(cursor,INVALID); const s = JSON.parse(cursor.cursor);
  const policy = JSON.parse(epoch.policy_json);
  check(hash(s.policy_hash),INVALID);
  // Read-grant replacement may legitimately change policy_hash. Validate the
  // checkpoint shape and identity without confusing authority with observation.
  validateSourceCheckpoint({...s,policy_hash:digest(policy)},policy);
  check(s.source_id === source && s.account_id === epoch.account_id && s.channel_id === epoch.channel_id
    && s.baseline_hash === epoch.baseline_hash && integer(s.pts) && s.pts >= epoch.baseline_pts,INVALID);
}
export function sourceObservationEpoch(service,sourceRef) {
  const epoch = chain(service.store,service.config.partnerId,sourceRef);
  try { checkpointBinding(service.store,service.config.partnerId,sourceRef,epoch); }
  catch { throw new AppError(INVALID,409,INVALID); }
  return epoch;
}
export const sourceObservationFloor = (service,source) => sourceObservationEpoch(service,source)?.observation_floor ?? 0;
export function validateSourceObservationEpochs(store) {
  const sources = store.all(`SELECT partner_id,source_ref FROM source_observation_epochs UNION
    SELECT partner_id,payload_json->>'$.source_id' FROM events WHERE kind='source.telegram.baseline'
      AND actor='system' AND json_type(payload_json,'$.epoch_id') IS NOT NULL`);
  for(const {partner_id,source_ref} of sources) checkpointBinding(store,partner_id,source_ref,chain(store,partner_id,source_ref));
  return true;
}
function terminal(service,authorizationId) {
  return service.store.get(`SELECT id FROM events WHERE partner_id=? AND kind=? AND actor='system'
    AND payload_json->>'$.authorization_id'=?`,service.config.partnerId,FINISHED,String(authorizationId));
}
export function telegramRebaselineAuthorization(service,policy) {
  const row = service.store.get(`SELECT id,payload_json FROM events WHERE partner_id=? AND kind=? AND actor='operator'
    AND payload_json->>'$.source_id'=? ORDER BY id DESC LIMIT 1`,service.config.partnerId,REQUEST,policy.sourceId);
  if(!row || terminal(service,row.id)) return null;
  const request = JSON.parse(row.payload_json), {policy_hash,...raw} = request;
  check(validate(raw) && raw.reason.trim() && iso(raw.expires_at) && hash(policy_hash),'TELEGRAM_REBASELINE_AUTHORITY_INVALID');
  if(Date.parse(raw.expires_at) <= Date.now()) return null;
  const current = telegramSourcePolicy(service,policy.sourceId);
  if(digest(current) !== digest(policy) || policy_hash !== digest(policy)) return null;
  const s = sourceCheckpoint(service,policy.sourceId); if(!s) return null;
  validateSourceCheckpoint(s,policy); sourceObservationEpoch(service,policy.sourceId);
  if(s.reason !== INTEGRITY || digest(s) !== raw.checkpoint_fingerprint) return null;
  return {id:String(row.id),source_id:raw.source_id,checkpoint_fingerprint:raw.checkpoint_fingerprint,policy_hash,expires_at:raw.expires_at};
}
export function requestTelegramRebaseline(service,raw,actor) {
  check(actor?.kind === 'operator','TELEGRAM_REBASELINE_OPERATOR_REQUIRED');
  check(validate(raw) && raw.reason.trim() && iso(raw.expires_at),'TELEGRAM_REBASELINE_REQUEST_INVALID');
  check(Date.parse(raw.expires_at) > Date.now() && Date.parse(raw.expires_at) <= Date.now()+3600000,'TELEGRAM_REBASELINE_EXPIRY_INVALID');
  const policy = telegramSourcePolicy(service,raw.source_id), s = sourceCheckpoint(service,raw.source_id);
  check(s,'TELEGRAM_BOOTSTRAP_REQUIRED'); validateSourceCheckpoint(s,policy); sourceObservationEpoch(service,raw.source_id);
  check(s.reason === INTEGRITY && raw.checkpoint_fingerprint === digest(s),'TELEGRAM_REBASELINE_CHECKPOINT_MISMATCH');
  check(!telegramRebaselineAuthorization(service,policy) && !telegramRecoveryAuthorization(service,policy),'TELEGRAM_REBASELINE_PENDING');
  service.store.event(service.config.partnerId,null,REQUEST,'operator',{...raw,policy_hash:digest(policy)});
  return {authorization_id:String(service.store.get('SELECT last_insert_rowid() id').id),pts:s.pts,
    phase:s.phase,history_complete:false,contact_permission:false,allowed_effects:[]};
}
export function finishTelegramRebaseline(service,authorization,result) {
  const authId = typeof authorization === 'string' ? authorization : authorization?.id;
  check(typeof authId === 'string' && /^[1-9][0-9]*$/.test(authId),'TELEGRAM_REBASELINE_AUTHORITY_INVALID');
  const requested = event(service.store,service.config.partnerId,authId,REQUEST,'operator');
  if(terminal(service,authId)) return;
  check(['failed','cancelled','revoked'].includes(result?.status) && typeof result.reason === 'string'
    && /^[A-Z0-9_]{1,100}$/.test(result.reason),'TELEGRAM_REBASELINE_RESULT_INVALID');
  service.store.event(service.config.partnerId,null,FINISHED,'system',{
    source_id:requested.payload.source_id,authorization_id:authId,status:result.status,reason:result.reason});
}
export function cancelTelegramRebaseline(service,raw,actor) {
  check(actor?.kind === 'operator','TELEGRAM_REBASELINE_OPERATOR_REQUIRED');
  check(raw && Object.keys(raw).sort().join(',') === 'authorization_id,reason' && typeof raw.reason === 'string'
    && raw.reason.trim() && raw.reason.length <= 1000 && typeof raw.authorization_id === 'string'
    && /^[1-9][0-9]*$/.test(raw.authorization_id),'TELEGRAM_REBASELINE_CANCEL_INVALID');
  check(!terminal(service,raw.authorization_id),'TELEGRAM_REBASELINE_RESOLVED');
  finishTelegramRebaseline(service,raw.authorization_id,{status:'cancelled',reason:'OWNER_CANCELLED'});
  service.store.event(service.config.partnerId,null,'source.telegram.rebaseline.cancelled','operator',raw);
  return {authorization_id:raw.authorization_id,status:'cancelled',contact_permission:false,allowed_effects:[]};
}
// Invoked only by the controlled native reader after an authentic GramJS TooLong/peer/PTS check.
// Synchronous SQLite transaction is the durable commit point; no partial reset survives a crash.
export function commitTelegramRebaseline(service,policy,authorization,baselinePts) {
  return service.store.transaction(() => {
    const auth = telegramRebaselineAuthorization(service,policy);
    check(auth && digest(auth) === digest(authorization),'TELEGRAM_REBASELINE_AUTHORITY_STALE');
    const previous = sourceObservationEpoch(service,policy.sourceId), s = sourceCheckpoint(service,policy.sourceId);
    check(Number.isInteger(baselinePts) && baselinePts > s.pts && baselinePts <= 2147483647,'TELEGRAM_REBASELINE_PTS_INVALID');
    check((previous?.generation ?? 0) < 128,'TELEGRAM_REBASELINE_EPOCH_LIMIT');
    const epochId = id(), generation = (previous?.generation ?? 0)+1, baselineHash = digest({pts:baselinePts,history:[]});
    service.store.event(service.config.partnerId,null,'source.telegram.baseline','system',{
      source_id:policy.sourceId,pts:baselinePts,fingerprint:baselineHash,history_count:0,history_complete:false,epoch_id:epochId,generation});
    const baselineEvent = service.store.get('SELECT id,created_at FROM events WHERE id=last_insert_rowid()');
    const row = {id:epochId,partner_id:service.config.partnerId,source_ref:policy.sourceId,account_id:policy.accountId,
      channel_id:policy.channelId,generation,authorization_event_id:Number(auth.id),baseline_event_id:baselineEvent.id,
      previous_epoch_id:previous?.id ?? null,policy_json:JSON.stringify(policy),previous_checkpoint_json:JSON.stringify(s),
      baseline_pts:baselinePts,baseline_hash:baselineHash,observation_floor:baselineEvent.id,created_at:baselineEvent.created_at};
    row.transition_sha256 = transitionHash(row);
    service.store.run('INSERT INTO source_observation_epochs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',...Object.values(row));
    const next = {...s,baseline_hash:baselineHash,pts:baselinePts,phase:'catching_up',confirmed_at:null,reason:'NEW_OBSERVATION_EPOCH'};
    service.store.run('UPDATE channel_offsets SET cursor=? WHERE channel=? AND account_id=?',JSON.stringify(next),SOURCE_CHECKPOINT_CHANNEL,digest([service.config.partnerId,policy.sourceId]));
    service.store.event(service.config.partnerId,null,FINISHED,'system',{source_id:policy.sourceId,authorization_id:auth.id,status:'committed',epoch_id:epochId});
    sourceObservationEpoch(service,policy.sourceId);
    return {epoch_id:epochId,baseline_pts:baselinePts,baseline_hash:baselineHash,observation_floor:baselineEvent.id};
  });
}
export function observationRecoveryPresentation(service,sourceRef) {
  try {
    const epoch = sourceObservationEpoch(service,sourceRef), policy = telegramSourcePolicy(service,sourceRef), s = sourceCheckpoint(service,sourceRef);
    const auth = telegramRebaselineAuthorization(service,policy);
    if(s) validateSourceCheckpoint(s,policy);
    return {epoch:epoch ? {id:epoch.id,generation:epoch.generation,baseline_pts:epoch.baseline_pts,
      observation_floor:epoch.observation_floor,created_at:epoch.created_at,history_complete:false} : null,
    pending:auth ? {id:auth.id,expires_at:auth.expires_at} : null,eligible:s?.reason === INTEGRITY && !auth && !telegramRecoveryAuthorization(service,policy)};
  } catch { return {epoch:null,pending:null,eligible:false}; }
}
