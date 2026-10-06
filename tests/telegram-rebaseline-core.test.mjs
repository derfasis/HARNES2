import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, id } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { ROOT, readJson } from '../business/config.mjs';
import { sourceCheckpoint, sourceRows, sourceHistoryRows, sourceEvent, sourceContextState, sourceFreshnessReasons, digest } from '../business/source-ingestion.mjs';
import { sourceObservationEpoch, sourceObservationFloor, telegramRebaselineAuthorization, commitTelegramRebaseline } from '../business/source-observation-epochs.mjs';
import { bootstrapTelegramSource, applyTelegramDifference, disconnectTelegramSource } from '../business/sources/telegram-readonly.mjs';

const SOURCE='telegram:channel:100', B='public:healthy-neighbor';
const p={sourceId:SOURCE,accountId:'999',channelId:'100',sourceKind:'sanitized_fixture',processingBasis:'Invented offline recovery test',maxLagSeconds:120};
const message=(extra={})=>({id:1,channel_id:'100',from_id:{kind:'user',id:'10'},post:false,text:'How can I start training?',date:1767225600,...extra});
const page=(from,to,updates=[])=>({kind:updates.length?'difference':'empty',account_id:'999',channel_id:'100',from_pts:from,to_pts:to,final:true,updates});
const update=(pts,extra={})=>({kind:'new',channel_id:'100',pts,pts_count:1,message:message(extra)});
async function harness(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'harnes2-epoch-core-'));
  let store=new Store(dir),config=readJson(path.join(ROOT,'config/default.json'));
  Object.assign(config.opportunity,{automatic:true,telegramSources:[p],allowedSourceRefs:[SOURCE,B]});
  Object.assign(config.audience,{enabled:true,modelEnabled:false,sources:[SOURCE,B]});
  Object.assign(config.continuity,{enabled:true,modelEnabled:false});
  let service=new BusinessService(store,config);
  const h={config,dir,get store(){return store;},get service(){return service;},state:()=>sourceCheckpoint(service,SOURCE),
    command:(action,raw,request=id(),actor={kind:'operator'})=>service.command(action,raw,request,actor),
    request:()=>({source_id:SOURCE,checkpoint_fingerprint:digest(h.state()),acknowledge_gap:true,
      expires_at:new Date(Date.now()+1800000).toISOString(),reason:'Reviewed missing interval; continue empty history.'}),
    latch:()=>disconnectTelegramSource(service,SOURCE,'INTEGRITY_RECONCILIATION_REQUIRED'),
    commit:pts=>commitTelegramRebaseline(service,p,telegramRebaselineAuthorization(service,p),pts),
    restart:()=>{store.close();store=new Store(dir);store.recover();service=new BusinessService(store,config);}};
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  await bootstrapTelegramSource(service,SOURCE,{pts:10,history:[]});
  await applyTelegramDifference(service,SOURCE,page(10,11,[update(11)]));
  return h;
}
test('gap cutover preserves exact historical truth, forbids stale revival, and admits only later evidence',async t=>{
  const h=await harness(t),old=sourceRows(h.service,SOURCE)[0],before=sourceContextState(h.service,old.event_id).source_state;
  const oldPolicy=h.service.continuity.policyHash(SOURCE);await h.latch();
  const request=h.request(),receipt=await h.command('source.rebaseline',request,'once');
  assert.equal(h.state().pts,11);assert.equal(h.state().reason,'INTEGRITY_RECONCILIATION_REQUIRED');
  const epoch=h.commit(100);assert.equal(h.state().phase,'catching_up');
  assert.deepEqual(sourceEvent(h.service,old.event_id),old);assert.equal(sourceHistoryRows(h.service,SOURCE).length,1);
  assert.deepEqual(sourceRows(h.service,SOURCE),[]);assert.equal(sourceObservationFloor(h.service,SOURCE),epoch.observation_floor);
  assert.notEqual(h.service.continuity.policyHash(SOURCE),oldPolicy);
  await applyTelegramDifference(h.service,SOURCE,page(100,100));
  assert.equal(h.state().phase,'current');assert.equal(sourceFreshnessReasons(h.service,before).length>0,true);
  assert.throws(()=>sourceContextState(h.service,old.event_id));
  const count=h.store.get('SELECT COUNT(*) n FROM source_observation_epochs').n;
  assert.deepEqual(await h.command('source.rebaseline',request,'once'),receipt);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM source_observation_epochs').n,count,'receipt cannot execute twice');
  await applyTelegramDifference(h.service,SOURCE,page(100,101,[update(101,{id:2})]));
  assert.equal(sourceRows(h.service,SOURCE).length,1);assert.equal(sourceRows(h.service,SOURCE)[0].message.message_id,'message:2');
  h.restart();assert.equal(sourceObservationEpoch(h.service,SOURCE).id,epoch.epoch_id);assert.equal(h.state().phase,'catching_up');
  await applyTelegramDifference(h.service,SOURCE,page(101,101));assert.equal(sourceRows(h.service,SOURCE).length,1);
  for(const table of ['persons','conversations','drafts','delivery_attempts','tool_calls','outcome_events']) assert.equal(h.store.get(`SELECT COUNT(*) n FROM ${table}`).n,0,table);
});
test('operator identity is checked before replay; gap acknowledgement, expiry and checkpoint bind the grant',async t=>{
  const h=await harness(t);await h.latch();const raw=h.request();
  for(const bad of [{...raw,acknowledge_gap:false},{...raw,expires_at:new Date(Date.now()-1).toISOString()},
    {...raw,expires_at:new Date(Date.now()+7200000).toISOString()},{...raw,checkpoint_fingerprint:'a'.repeat(64)},
    {...raw,reason:' '},{...raw,contact_permission:true}]) await assert.rejects(h.command('source.rebaseline',bad));
  await h.command('source.rebaseline',raw,'grant');
  await assert.rejects(h.command('source.rebaseline',raw,'grant',{kind:'channel',sourceId:SOURCE}),{code:'TELEGRAM_REBASELINE_OPERATOR_REQUIRED'});
  await assert.rejects(h.command('source.reconcile',{source_id:SOURCE,checkpoint_fingerprint:digest(h.state()),reason:'Competing request'}));
});
test('cancel and changed authority prevent late commit and restart resurrection',async t=>{
  for(const cancel of [true,false]) {
    const h=await harness(t);await h.latch();const receipt=await h.command('source.rebaseline',h.request());
    const auth=telegramRebaselineAuthorization(h.service,p);
    if(cancel) await h.command('source.rebaseline_cancel',{authorization_id:receipt.authorization_id,reason:'Cancel pending cutover'});
    else h.config.opportunity.allowedSourceRefs=[];
    assert.throws(()=>commitTelegramRebaseline(h.service,p,auth,100));
    assert.equal(h.state().pts,11);assert.equal(h.store.get('SELECT COUNT(*) n FROM source_observation_epochs').n,0);
    h.restart();assert.throws(()=>commitTelegramRebaseline(h.service,p,auth,100));
  }
});
test('receipt persistence failure rolls back baseline, epoch, checkpoint and source floor together',async t=>{
  const h=await harness(t);await h.latch();await h.command('source.rebaseline',h.request());
  const before=h.state(),storeEvent=h.store.event.bind(h.store);
  h.store.event=(...args)=>{if(args[2]==='source.telegram.rebaseline.finished')throw new Error('Synthetic receipt write failure');return storeEvent(...args);};
  assert.throws(()=>h.commit(100),/receipt write failure/);h.store.event=storeEvent;
  assert.deepEqual(h.state(),before);assert.equal(sourceObservationFloor(h.service,SOURCE),0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM source_observation_epochs').n,0);
  assert.notEqual(telegramRebaselineAuthorization(h.service,p),null);h.restart();h.commit(100);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM source_observation_epochs').n,1);
});
test('historical identity, tombstones and versions remain enforced across a gap',async t=>{
  const h=await harness(t);await h.latch();await h.command('source.rebaseline',h.request());h.commit(100);
  await assert.rejects(applyTelegramDifference(h.service,SOURCE,page(100,101,[update(101,{from_id:{kind:'user',id:'999'}})])));
  assert.equal(h.state().pts,100);assert.equal(h.state().reason,'INTEGRITY_RECONCILIATION_REQUIRED');
  assert.equal(sourceRows(h.service,SOURCE).length,0);assert.equal(sourceHistoryRows(h.service,SOURCE)[0].message.author_id,'user:10');
});
test('new replies to pre-gap anchors remain incomplete rather than inventing current ancestry',async t=>{
  const h=await harness(t);await h.latch();await h.command('source.rebaseline',h.request());h.commit(100);
  await applyTelegramDifference(h.service,SOURCE,page(100,101,[update(101,{id:2,reply_to_msg_id:1})]));
  const opened=await h.command('audience.open',{title:'Check new gap',objective:'Observe current questions',source_ids:[SOURCE],max_age_seconds:604800});
  assert.equal(h.service.audience.watches(opened.goal_id)[0].cursor,sourceObservationFloor(h.service,SOURCE));
  await h.service.audience.reconcile();
  const packet=h.service.audience.detail(opened.goal_id);
  assert.equal(packet.exchanges.length,0,'pre-gap anchor cannot support a ready exchange');
});
test('accepted memory and captured pending reasoning remain stale after forward freshness and restart',async t=>{
  const h=await harness(t),old=sourceRows(h.service,SOURCE)[0];
  const opened=await h.command('continuity.open',{title:'A persistent question',objective:'Understand public training needs',
    success_condition:'Source evidence and gaps are visible',source_ids:[SOURCE],initial_evidence_event_ids:[old.event_id],max_age_seconds:604800});
  let detail=h.service.continuity.detail(opened.thread_id);
  const capture=await h.command('continuity.capture',{thread_id:detail.id,expected_revision:detail.revision,expected_basis_fingerprint:detail.basis_fingerprint});
  const turn=h.service.continuity.turn(capture.turn_id),output={summary:{text:'A question was stated',evidence_event_ids:[old.event_id]},
    claims:[{source_event_id:old.event_id,quote:old.message.text}],hypotheses:[],unknowns:['Intent beyond the question is unknown'],
    next:{kind:'observe',reason:'Await further evidence',wake_at:null,owner_question:null}};
  await h.command('continuity.propose',{turn_id:turn.id,output});
  await h.command('continuity.review',{turn_id:turn.id,expected_basis_fingerprint:turn.basis_fingerprint,decision:'accept',note:'Synthetic owner review'});
  assert.equal(h.service.continuity.detail(detail.id).memory.current,true);
  await h.command('continuity.note',{thread_id:detail.id,expected_revision:h.service.continuity.detail(detail.id).revision,text:'Reconsider if the context changes'});
  detail=h.service.continuity.detail(detail.id);
  const pending=await h.command('continuity.capture',{thread_id:detail.id,expected_revision:detail.revision,expected_basis_fingerprint:detail.basis_fingerprint});
  await h.latch();await h.command('source.rebaseline',h.request());h.commit(100);await applyTelegramDifference(h.service,SOURCE,page(100,100));
  assert.equal(h.service.continuity.detail(detail.id).memory.current,false);
  assert.equal(h.service.continuity.detail(detail.id).memory.content,null);
  await assert.rejects(h.command('continuity.propose',{turn_id:pending.turn_id,output}));
  h.restart();await applyTelegramDifference(h.service,SOURCE,page(100,100));
  assert.equal(h.service.continuity.detail(detail.id).memory.current,false);
  assert.equal(h.service.continuity.detail(detail.id).evidence.length,0);
});
test('corrupt or removed epoch fails closed per source without starving a healthy neighbor',async t=>{
  const h=await harness(t);await h.latch();await h.command('source.rebaseline',h.request());h.commit(100);
  await applyTelegramDifference(h.service,SOURCE,page(100,100));
  const opened=await h.command('audience.open',{title:'Two sources',objective:'Compare questions',source_ids:[SOURCE,B],max_age_seconds:604800});
  const neighbor=await h.command('source.ingest',{source_id:B,source_kind:'sanitized_fixture',message_id:'healthy',author_id:'person:fixture',
    display_name:null,thread_id:null,reply_to_id:null,version:1,operation:'upsert',text:'How can I start?',created_at:'2026-01-01T00:00:00.000Z',updated_at:'2026-01-01T00:00:00.000Z'});
  h.store.run("UPDATE source_observation_epochs SET transition_sha256=?",'a'.repeat(64));
  assert.throws(()=>sourceRows(h.service,SOURCE),{code:'SOURCE_TRANSPORT_OBSERVATION_EPOCH_INVALID'});
  await h.service.audience.reconcile();
  const watched=h.service.audience.watches(opened.goal_id);
  assert.equal(watched.find(w=>w.source_ref===SOURCE).status,'revoked');assert.equal(watched.find(w=>w.source_ref===B).status,'active');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_exchanges WHERE goal_id=? AND source_ref=?',opened.goal_id,B).n,1);
  assert.equal(sourceRows(h.service,B)[0].event_id,neighbor.source_event_id);
  h.store.run('DELETE FROM source_observation_epochs');assert.throws(()=>sourceRows(h.service,SOURCE),{code:'SOURCE_TRANSPORT_OBSERVATION_EPOCH_INVALID'});
});
