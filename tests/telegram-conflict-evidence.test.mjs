// Black-box coverage for bounded diagnostics on a refused Telegram reconciliation page.
// Synthetic local fixtures only: no Telegram client, model, credentials, or network access.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Store} from '../business/store.mjs';
import {BusinessService} from '../business/service.mjs';
import {Scheduler} from '../business/scheduler.mjs';
import {ROOT,readJson} from '../business/config.mjs';
import {digest,sourceCheckpoint,sourceRows} from '../business/source-ingestion.mjs';
import {applyTelegramDifference,bootstrapTelegramSource} from '../business/sources/telegram-readonly.mjs';

const sourceId='telegram:channel:100';
const p={sourceId,accountId:'999',channelId:'100',sourceKind:'sanitized_fixture',
  processingBasis:'Invented offline test only',maxLagSeconds:120};
const sha=value=>createHash('sha256').update(value).digest('hex');
const message=(id,text=`Fixture question ${id}?`,extra={})=>({id,channel_id:'100',from_id:null,post:true,text,
  date:1767225600,edit_date:null,reply_to_msg_id:null,reply_to_top_id:null,reply_to_channel_id:null,...extra});
const page=(from,to,updates=[],recovered_updates=[])=>({contract_version:recovered_updates.length?'telegram-reconciliation-v2':'telegram-reconciliation-v1',kind:'difference',
  account_id:p.accountId,channel_id:p.channelId,from_pts:from,to_pts:to,final:true,updates,snapshots:[],
  ...(recovered_updates.length?{recovered_updates}:{}),response_fingerprint:'a'.repeat(64)});
const deletion=(pts,ids,pts_count)=>({kind:'delete',pts,pts_count,message_ids:ids,channel_id:p.channelId});

function harness(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'harnes2-telegram-conflict-'));
  let store=new Store(directory),config=readJson(path.join(ROOT,'config/default.json'));
  Object.assign(config.opportunity,{automatic:true,telegramSources:[structuredClone(p)],allowedSourceRefs:[sourceId],
    activeOffer:readJson(path.join(ROOT,'benchmarks/opportunity-projection-v0/case-01.json')).active_offer});
  let service=new BusinessService(store,config),modelCalls=0;
  const runtime={decide:async()=>{modelCalls++;throw Error('conflicting source must not reach a model');},run:()=>{throw Error('agent forbidden');}};
  const scheduler=()=>new Scheduler(service,runtime,{readiness:()=>{throw Error('private Telegram forbidden');},
    sendApproved:()=>{throw Error('send forbidden');}});
  const api={get store(){return store;},get service(){return service;},get modelCalls(){return modelCalls;},scheduler,
    state:()=>sourceCheckpoint(service,sourceId),rows:()=>sourceRows(service,sourceId),
    apply:value=>applyTelegramDifference(service,sourceId,value),
    bootstrap:()=>bootstrapTelegramSource(service,sourceId,{pts:10,history:[]}),
    restart:()=>{store.close();store=new Store(directory);store.recover();service=new BusinessService(store,config);}};
  t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});
  return api;
}

async function seed(h,messages) {
  await h.bootstrap();
  await h.apply({...page(10,11),snapshots:messages,response_fingerprint:'b'.repeat(64)});
}
async function refuseDeleteConflict(h,nativeIds,recoveredIds,pts=12) {
  const candidate=page(h.state().pts,pts,[deletion(pts,nativeIds,1)],[deletion(pts,recoveredIds,0)]);
  await assert.rejects(h.apply(candidate),{code:'TELEGRAM_SNAPSHOT_CONFLICT'});
}
const conflictEvents=h=>h.store.all("SELECT payload_json FROM events WHERE kind='source.telegram.integrity_conflict'")
  .map(row=>JSON.parse(row.payload_json));
const eventCount=(h,kinds)=>h.store.get(`SELECT COUNT(*) AS n FROM events WHERE kind IN (${kinds.map(()=>'?').join(',')})`,...kinds).n;

test('same-pts delete mismatch publishes bounded page and set comparison diagnostics while refusing the page',async t=>{
  const h=harness(t);await seed(h,[message(7),message(8)]);const before=eventCount(h,['source.telegram.update','source.telegram.proof','source.telegram.reconciliation']);
  await refuseDeleteConflict(h,[7],[8]);
  assert.equal(conflictEvents(h).length,1);
  const [diagnostic]=conflictEvents(h);assert.ok(diagnostic);
  assert.equal(diagnostic.diagnostic_version,1);assert.equal(diagnostic.conflict_kind,'same_pts_delete_mismatch');
  assert.equal(diagnostic.page.contract_version,'telegram-reconciliation-v2');
  assert.equal(diagnostic.page.from_pts,11);assert.equal(diagnostic.page.to_pts,12);
  assert.equal(diagnostic.page.cursor_before,11);assert.equal(diagnostic.page.kind,'difference');
  assert.equal(diagnostic.page.final,true);assert.equal(diagnostic.page.native_update_count,1);
  assert.equal(diagnostic.page.recovered_update_count,1);assert.equal(diagnostic.page.snapshot_count,0);
  assert.equal(diagnostic.comparison.native.kind,'delete');assert.equal(diagnostic.comparison.native.pts,12);
  assert.equal(diagnostic.comparison.native.pts_count,1);assert.equal(diagnostic.comparison.native.target_count,1);
  assert.deepEqual(diagnostic.comparison.native.target_ids_sample,[7]);
  assert.equal(diagnostic.comparison.recovered.pts_count,0);assert.equal(diagnostic.comparison.recovered.target_count,1);
  assert.deepEqual(diagnostic.comparison.recovered.target_ids_sample,[8]);
  assert.equal(diagnostic.comparison.relationship,'disjoint');assert.equal(diagnostic.comparison.intersection_count,0);
  assert.match(diagnostic.comparison.native.target_set_sha256,/^[a-f0-9]{64}$/);
  assert.match(diagnostic.comparison.recovered.target_set_sha256,/^[a-f0-9]{64}$/);
  assert.equal(diagnostic.comparison.native.target_set_sha256,digest([7]));
  assert.equal(diagnostic.comparison.recovered.target_set_sha256,digest([8]));
  assert.equal(h.state().pts,11);assert.equal(h.state().phase,'blocked');
  assert.equal(eventCount(h,['source.telegram.update','source.telegram.proof','source.telegram.reconciliation']),before);
  assert.equal(h.rows().length,2);
});

test('diagnostic classifies subset mismatches, while an equal delete set still applies without a conflict event',async t=>{
  for(const [nativeIds,recoveredIds,relationship,intersection] of [
    [[7],[7,8],'native_subset',1],[[7,8],[7],'recovered_subset',1],
  ]) {
    const h=harness(t);await seed(h,[message(7),message(8)]);
    await refuseDeleteConflict(h,nativeIds,recoveredIds);
    const [diagnostic]=conflictEvents(h);
    assert.equal(diagnostic.comparison.relationship,relationship);
    assert.equal(diagnostic.comparison.intersection_count,intersection);
  }
  const equal=harness(t);await seed(equal,[message(7)]);
  await equal.apply(page(11,12,[deletion(12,[7],1)],[deletion(12,[7],0)]));
  assert.equal(equal.state().pts,12);assert.equal(equal.state().phase,'current');
  assert.deepEqual(conflictEvents(equal),[]);
  assert.equal(equal.rows()[0].message.operation,'delete');
});

test('diagnostic target summaries describe durable pre-page versions and tombstones',async t=>{
  const h=harness(t);await seed(h,[message(7),message(8)]);
  const original=new Map(h.rows().map(row=>[row.message.message_id,row]));
  await refuseDeleteConflict(h,[7],[8]);
  const [diagnostic]=conflictEvents(h);
  assert.deepEqual(diagnostic.durable_targets.map(target=>target.message_id).sort(),['message:7','message:8']);
  assert.ok(diagnostic.durable_targets.length<=16);
  for(const target of diagnostic.durable_targets) {
    const old=original.get(target.message_id);
    assert.equal(target.source_event_id,old.event_id);
    assert.equal(target.operation,'upsert');assert.equal(target.version,old.message.version);assert.equal(target.tombstoned,false);
  }
  assert.equal(h.rows().find(row=>row.message.message_id==='message:7').event_id,original.get('message:7').event_id);
  assert.equal(h.rows().find(row=>row.message.message_id==='message:7').message.operation,'upsert');
});

test('delete diagnostics cap target samples at 16 while counts and set digests retain tail differences',async t=>{
  const h=harness(t);const common=Array.from({length:16},(_,i)=>i+1),nativeTail=Array.from({length:84},(_,i)=>100+i),recoveredTail=Array.from({length:84},(_,i)=>300+i);
  await seed(h,Array.from({length:100},(_,i)=>message(i+1)));
  await refuseDeleteConflict(h,[...common,...nativeTail],[...common,...recoveredTail]);
  const [diagnostic]=conflictEvents(h),native=diagnostic.comparison.native,recovered=diagnostic.comparison.recovered;
  assert.equal(native.target_count,100);assert.equal(recovered.target_count,100);
  assert.ok(native.target_ids_sample.length<=16);assert.ok(recovered.target_ids_sample.length<=16);
  assert.deepEqual(native.target_ids_sample,recovered.target_ids_sample);
  assert.notEqual(native.target_set_sha256,recovered.target_set_sha256);
  assert.equal(native.target_set_sha256,digest([...common,...nativeTail].sort((a,b)=>a-b)));
  assert.equal(recovered.target_set_sha256,digest([...common,...recoveredTail].sort((a,b)=>a-b)));
  assert.equal(diagnostic.comparison.intersection_count,16);
  assert.equal(diagnostic.comparison.relationship,'overlap');

  const balanced=harness(t);await seed(balanced,Array.from({length:100},(_,i)=>message(i+1)));
  await refuseDeleteConflict(balanced,Array.from({length:100},(_,i)=>i+1),Array.from({length:100},(_,i)=>201+i));
  const sampled=conflictEvents(balanced)[0],durable=sampled.durable_targets.map(row=>row.message_id);
  const nativeIds=new Set(sampled.comparison.native.target_ids_sample.map(id=>`message:${id}`));
  const recoveredIds=new Set(sampled.comparison.recovered.target_ids_sample.map(id=>`message:${id}`));
  assert.ok(durable.length<=16);
  assert.ok(durable.some(id=>nativeIds.has(id)),'the durable sample represents native targets');
  assert.ok(durable.some(id=>recoveredIds.has(id)),'the durable sample represents recovered targets');
});

test('diagnostics contain neither stored message text nor opaque-content canaries',async t=>{
  const h=harness(t),textCanary='PRIVATE_MESSAGE_CANARY_7f31',opaqueCanary='OPAQUE_RAW_CANARY_9ac2';
  await seed(h,[message(7,textCanary),message(8,null,{unsupported:{reason:'media',fingerprint:sha(opaqueCanary)}})]);
  await refuseDeleteConflict(h,[7],[8]);
  const json=JSON.stringify(conflictEvents(h));
  assert.doesNotMatch(json,/PRIVATE_MESSAGE_CANARY_7f31|OPAQUE_RAW_CANARY_9ac2/);
  assert.doesNotMatch(json,/text|body|raw|payload|credential|session/i);
});

test('a failed diagnostic event write keeps the original conflict refusal and blocked checkpoint',async t=>{
  const h=harness(t);await seed(h,[message(7),message(8)]);
  const original=h.store.event.bind(h.store);h.store.event=(partnerId,conversationId,kind,actor,payload)=>{
    if(kind==='source.telegram.integrity_conflict')throw Error('diagnostic storage fault');
    return original(partnerId,conversationId,kind,actor,payload);
  };
  await refuseDeleteConflict(h,[7],[8]);
  assert.deepEqual(conflictEvents(h),[]);
  assert.equal(h.state().reason,'INTEGRITY_RECONCILIATION_REQUIRED');assert.equal(h.state().pts,11);
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM events WHERE kind='source.telegram.update'").n,0);
});

test('an unrelated integrity conflict keeps its legacy diagnostic fields',async t=>{
  const h=harness(t);await seed(h,[message(7)]);
  const changed=page(11,12);changed.snapshots=[message(7,'Replacement without proof?')];changed.response_fingerprint='c'.repeat(64);
  await assert.rejects(h.apply(changed),{code:'TELEGRAM_SNAPSHOT_CONFLICT'});
  const [diagnostic]=conflictEvents(h);
  assert.equal(diagnostic.conflict_kind,'snapshot_changed_without_newer_proof');
  assert.equal(diagnostic.source_id,sourceId);assert.equal(diagnostic.message_id,7);assert.equal(diagnostic.pts,null);
});

test('refusal stays blocked after restart and cannot trigger model calls or business effects',async t=>{
  const h=harness(t);await seed(h,[message(7),message(8)]);await refuseDeleteConflict(h,[7],[8]);
  h.restart();assert.equal(h.state().pts,11);assert.equal(h.state().phase,'blocked');
  assert.equal(h.state().reason,'INTEGRITY_RECONCILIATION_REQUIRED');
  await h.scheduler().tick();assert.equal(h.modelCalls,0);
  for(const table of ['persons','conversations','messages','drafts','approvals','delivery_attempts','tool_calls','outcome_events'])
    assert.equal(h.store.get(`SELECT COUNT(*) AS n FROM ${table}`).n,0,table);
});
