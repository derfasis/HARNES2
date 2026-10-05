// Owner-approved observation epochs. Reuses SQLite command transactions and source gates.
import path from 'node:path';
import Ajv from 'ajv';
import { ROOT, readJson } from './config.mjs';
import { AppError, ensure, now } from './errors.mjs';
import { id } from './store.mjs';
import { digest, sourceCheckpointState } from './source-ingestion.mjs';
import { effectiveSourceConfig } from './scout-policy.mjs';

const validate = new Ajv({ strict:true }).compile(readJson(path.join(ROOT,'contracts/audience-source-renewal.schema.json')));
const HASH = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
// Explicit fail-closed history budget; never silently validate only a tail of the chain.
export const MAX_WATCH_EPOCHS = 256;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const check = (ok, code) => ensure(ok,code,409,code);
const epochPolicy = row => digest({ version:1,purpose:'audience_source_watch_epoch_v1',
  id:row.id,goal_id:row.goal_id,source_ref:row.source_ref,generation:row.generation,
  source_policy_hash:row.source_policy_hash,observation_floor:row.observation_floor });
const transitionHash = row => { const { transition_sha256,...definition } = row; return digest(definition); };
const resultFor = row => ({goal_id:row.goal_id,source_ref:row.source_ref,epoch_id:row.id,policy_hash:row.policy_hash,
  observation_floor:row.observation_floor,gap:true,executable:false,contact_permission:false,allowed_effects:[]});

export function validateWatchEpoch(row) {
  return row && Object.keys(row).sort().join(',') ===
    'created_at,generation,goal_id,id,observation_floor,policy_hash,preview_sha256,prior_cursor,prior_policy_hash,source_policy_hash,source_ref,transition_sha256'
    && UUID.test(row.id) && UUID.test(row.goal_id) && typeof row.source_ref === 'string' && row.source_ref.length > 0 && row.source_ref.length <= 200
    && integer(row.generation) && row.generation > 0 && row.generation <= MAX_WATCH_EPOCHS && integer(row.prior_cursor) && integer(row.observation_floor)
    && row.observation_floor >= row.prior_cursor
    && ['prior_policy_hash','source_policy_hash','policy_hash','preview_sha256','transition_sha256'].every(k => typeof row[k] === 'string' && HASH.test(row[k]))
    && typeof row.created_at === 'string' && Number.isFinite(Date.parse(row.created_at))
    && row.policy_hash === epochPolicy(row) && row.transition_sha256 === transitionHash(row);
}

// Used during transfer, where all historical rows are already being inspected.
export function validateWatchEpochs(store) {
  const previous = new Map();
  for (const row of store.all('SELECT * FROM audience_watch_epochs ORDER BY goal_id,source_ref,generation')) {
    const key = JSON.stringify([row.goal_id,row.source_ref]), prior = previous.get(key);
    check(validateWatchEpoch(row) && row.generation === (prior?.generation ?? 0) + 1
      && (!prior || row.prior_policy_hash === prior.policy_hash && row.prior_cursor >= prior.observation_floor), 'AUDIENCE_WATCH_EPOCH_INVALID');
    previous.set(key,row);
  }
  for (const row of previous.values()) {
    const watch = store.get('SELECT * FROM audience_watches WHERE goal_id=? AND source_ref=?',row.goal_id,row.source_ref);
    check(watch && watch.policy_hash === row.policy_hash && integer(watch.cursor) && watch.cursor >= row.observation_floor,'AUDIENCE_WATCH_EPOCH_INVALID');
  }
  return true;
}

export function watchEpoch(a, watch) {
  const rows = a.store.all('SELECT * FROM audience_watch_epochs WHERE goal_id=? AND source_ref=? ORDER BY generation LIMIT ?',watch.goal_id,watch.source_ref,MAX_WATCH_EPOCHS+1);
  if (!rows.length) return null;
  check(rows.length <= MAX_WATCH_EPOCHS,'AUDIENCE_WATCH_EPOCH_INVALID');
  let prior = null;
  for (const row of rows) {
    check(validateWatchEpoch(row) && row.generation === (prior?.generation ?? 0)+1
      && (!prior || row.prior_policy_hash === prior.policy_hash && row.prior_cursor >= prior.observation_floor),'AUDIENCE_WATCH_EPOCH_INVALID');
    prior = row;
  }
  check(prior.policy_hash === watch.policy_hash && integer(watch.cursor) && watch.cursor >= prior.observation_floor,'AUDIENCE_WATCH_EPOCH_INVALID');
  return prior;
}

export function sourceRenewalPreview(a,p) {
  a.requireEnabled();
  check(p && typeof p === 'object' && Object.keys(p).sort().join(',') === 'goal_id,source_ref','AUDIENCE_FIELDS_INVALID');
  const goal = a.goal(p.goal_id), watch = a.watches(goal.id).find(w => w.source_ref === p.source_ref);
  check(goal.status === 'OPEN' && watch?.status === 'revoked','AUDIENCE_RENEWAL_UNAVAILABLE');
  check(effectiveSourceConfig(a.service).opportunity.allowedSourceRefs.includes(p.source_ref),'AUDIENCE_SOURCE_NOT_PERMITTED');
  const priorEpoch = watchEpoch(a,watch);
  check((priorEpoch?.generation ?? 0) < MAX_WATCH_EPOCHS,'AUDIENCE_WATCH_EPOCH_LIMIT');
  const currentPolicy = a.policyHash(p.source_ref), head = a.service.continuity.head(p.source_ref);
  check(HASH.test(watch.policy_hash) && integer(watch.cursor) && integer(head) && head >= watch.cursor,'AUDIENCE_WATCH_EPOCH_INVALID');
  const transport = a.service.continuity.health({ ...watch,status:'active',policy_hash:a.service.continuity.policyHash(p.source_ref) });
  const value = { version:1,purpose:'audience_source_renewal_preview_v1',goal_id:goal.id,source_ref:p.source_ref,
    expected_revision:goal.revision,goal_basis_sha256:digest({title:goal.title,objective:goal.objective,max_age_seconds:goal.max_age_seconds}),
    prior_policy_hash:watch.policy_hash,current_source_policy_hash:currentPolicy,old_cursor:watch.cursor,
    old_status:watch.status,old_reason:watch.reason,head,observation_floor:head,gap:true,
    source_checkpoint_sha256:digest(sourceCheckpointState(a.service,p.source_ref)),
    transport_current:transport.current,transport_reason:transport.reason ?? null };
  return Object.freeze({...value,preview_sha256:digest(value)});
}

export function assertRenewalRequest(a,p,previous = null) {
  a.requireEnabled(); check(validate(p),'AUDIENCE_RENEWAL_REQUEST_INVALID');
  check(p.acknowledge_gap === true,'AUDIENCE_GAP_ACK_REQUIRED');
  if (previous) {
    let result; try { result = JSON.parse(previous.result_json); } catch { throw new AppError('AUDIENCE_WATCH_EPOCH_INVALID',409,'AUDIENCE_WATCH_EPOCH_INVALID'); }
    const goal = a.goal(p.goal_id), watch = a.watches(goal.id).find(w => w.source_ref === p.source_ref);
    check(goal.status === 'OPEN' && goal.revision === p.expected_revision && watch && a.watchAuthority(watch).current,'AUDIENCE_RENEWAL_UNAVAILABLE');
    const epoch = watchEpoch(a,watch);
    check(epoch?.preview_sha256 === p.preview_sha256 && digest(result) === digest(resultFor(epoch)),'AUDIENCE_RENEWAL_UNAVAILABLE');
    return epoch;
  }
  const preview = sourceRenewalPreview(a,{goal_id:p.goal_id,source_ref:p.source_ref});
  check(preview.expected_revision === p.expected_revision && preview.preview_sha256 === p.preview_sha256,'AUDIENCE_RENEWAL_PREVIEW_CHANGED');
  return preview;
}

export function renewSource(a,p) {
  const preview = assertRenewalRequest(a,p), prior = a.watches(p.goal_id).find(w => w.source_ref === p.source_ref);
  const previous = watchEpoch(a,prior);
  const row = { id:id(),goal_id:p.goal_id,source_ref:p.source_ref,generation:(previous?.generation ?? 0)+1,
    prior_policy_hash:prior.policy_hash,source_policy_hash:preview.current_source_policy_hash,policy_hash:'',
    prior_cursor:prior.cursor,observation_floor:preview.observation_floor,preview_sha256:preview.preview_sha256,created_at:now() };
  row.policy_hash = epochPolicy(row); row.transition_sha256 = transitionHash(row);
  check(validateWatchEpoch(row),'AUDIENCE_WATCH_EPOCH_INVALID');
  a.store.run('INSERT INTO audience_watch_epochs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',...Object.values(row));
  const changed = a.store.run("UPDATE audience_watches SET policy_hash=?,cursor=?,status='active',reason=NULL WHERE goal_id=? AND source_ref=? AND status='revoked'",
    row.policy_hash,row.observation_floor,row.goal_id,row.source_ref);
  check(changed.changes === 1,'AUDIENCE_RENEWAL_COMMIT_FAILED');
  // All commands share one SQLite transaction. Old dependent work is retired before commit.
  a.retire(row.goal_id);
  a.record('source_renewed',{...row,acknowledged_gap:true},'operator');
  return resultFor(row);
}
