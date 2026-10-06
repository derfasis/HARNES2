// Black-box recovery acceptance using BusinessService and the pinned GramJS TL classes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {Store} from '../business/store.mjs';
import {BusinessService} from '../business/service.mjs';
import {ROOT,readJson} from '../business/config.mjs';
import {sourceCheckpoint,sourceRows,sourceHistoryRows,digest} from '../business/source-ingestion.mjs';
import {pollTelegramSource} from '../business/sources/telegram-readonly.mjs';
import {Api} from '../business/sources/telegram-public-mapper.mjs';
import {TelegramPublicSourceReader} from '../business/sources/telegram-public-reader.mjs';
const require=createRequire(import.meta.url),b=require('big-integer');
const sourceId='telegram:channel:100',accountId='999',channelId='100';
const peer=()=>new Api.InputChannel({channelId:b(100),accessHash:b(200)});
const message=(id=1)=>new Api.Message({id,peerId:new Api.PeerChannel({channelId:b(100)}),
  fromId:new Api.PeerUser({userId:b(10)}),message:'A public question?',date:1767225600});
const empty=(pts=10)=>new Api.updates.ChannelDifferenceEmpty({pts,final:true});
const difference=(pts=11)=>new Api.updates.ChannelDifference({pts,final:true,newMessages:[message()],otherUpdates:[],chats:[],users:[]});
const full=()=>({fullChat:new Api.ChannelFull({id:b(100),pts:10}),
  chats:[new Api.Channel({id:b(100),accessHash:b(200),username:'fixture_peer',megagroup:true})]});
const tooLong=(dialogPts,peerId=100,final=true)=>new Api.updates.ChannelDifferenceTooLong({
  final,timeout:0,dialog:new Api.Dialog({peer:new Api.PeerChannel({channelId:b(peerId)}),pts:dialogPts}),
  messages:[message(99)],chats:[],users:[]});
const waitable=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function harness(t,{joinedPeer=false}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'harnes2-rebaseline-'));
  let store=new Store(dir),config=readJson(path.join(ROOT,'config/default.json'));
  Object.assign(config.opportunity,{automatic:true,telegramSources:[{sourceId,accountId,channelId,sourceKind:'sanitized_fixture',
    processingBasis:'Invented offline test only',maxLagSeconds:120}],allowedSourceRefs:[sourceId]});
  let service=new BusinessService(store,config);let reply=empty(),fullReply=full(),reads=[];
  const rpc={invokeRead:async r=>{reads.push(r);return r instanceof Api.channels.GetFullChannel?typeof fullReply==='function'?fullReply(r):fullReply:
    typeof reply==='function'?reply(r):reply;},subscribe:()=>{},connected:()=>true,close:async()=>{}};
  let reader=new TelegramPublicSourceReader(service,sourceId,rpc,peer(),joinedPeer?null:'fixture_peer',{joinedPeer});
  const state=()=>sourceCheckpoint(service,sourceId);
  const authorize=async()=>service.command('source.rebaseline',{source_id:sourceId,
    checkpoint_fingerprint:digest(state()),acknowledge_gap:true,expires_at:new Date(Date.now()+30*60_000).toISOString(),
    reason:'Operator reviewed the lost interval; accept an empty-history cutover.'},'native-rebaseline-operator');
  const restart=async({bootstrap=true}={})=>{await reader.close();store.close();store=new Store(dir);store.recover();
    service=new BusinessService(store,config);
    reader=new TelegramPublicSourceReader(service,sourceId,rpc,peer(),joinedPeer?null:'fixture_peer',{joinedPeer});
    if(bootstrap)await reader.bootstrap();};
  const h={dir,config,get store(){return store;},get service(){return service;},get reader(){return reader;},reads,
    setReply:r=>reply=r,setFull:r=>fullReply=r,state,authorize,restart,
    poll:()=>pollTelegramSource(service,sourceId,reader),bootstrap:()=>reader.bootstrap()};
  t.after(async()=>{await reader.close().catch(()=>{});await service.tail.catch(()=>{});try{store.close();}catch{}fs.rmSync(dir,{recursive:true,force:true});});
  return h;
}
async function integrityLatch(h){await h.bootstrap();h.setReply(difference());await h.poll();
  assert.equal(sourceRows(h.service,sourceId).length,1);await h.reader.fault();
  assert.equal(h.state().reason,'INTEGRITY_RECONCILIATION_REQUIRED');}

test('native TooLong rebaseline cuts over empty history and requires a later forward poll for currentness',async t=>{
  const h=harness(t,{joinedPeer:true});await integrityLatch(h);const originalPts=h.state().pts;const authorization=await h.authorize();
  await h.restart({bootstrap:false});
  h.setReply(r=>r instanceof Api.updates.GetChannelDifference?tooLong(20):full());
  await h.reader.bootstrap();
  const differenceRequest=h.reads.filter(r=>r instanceof Api.updates.GetChannelDifference).at(-1);
  assert.equal(differenceRequest.pts,originalPts,'bootstrap observes the gap from the latched cursor');
  assert.equal(h.state().pts,20);assert.equal(h.state().phase,'catching_up');assert.equal(h.state().reason,'NEW_OBSERVATION_EPOCH');
  assert.equal(sourceRows(h.service,sourceId).length,0,'old evidence is below the new observation floor');
  assert.equal(sourceHistoryRows(h.service,sourceId).length,1,'the original event remains in the audit history');
  for(const table of ['persons','conversations','messages','drafts','approvals','delivery_attempts','tool_calls','outcome_events'])
    assert.equal(h.store.get(`SELECT COUNT(*) n FROM ${table}`).n,0,`${table} stays untouched by rebaseline`);
  assert.equal(h.reader.confirmCurrent(),false,'the accepted gap is not a freshness proof');
  const baselines=h.store.all("SELECT payload_json FROM events WHERE kind='source.telegram.baseline' ORDER BY id");
  assert.equal(baselines.length,2);
  const epoch=JSON.parse(baselines.at(-1).payload_json);assert.notEqual(epoch.epoch_id,authorization.authorization_id);
  assert.equal(h.store.get('SELECT authorization_event_id FROM source_observation_epochs WHERE id=?',epoch.epoch_id).authorization_event_id,
    Number(authorization.authorization_id));
  h.setReply(empty(20));await h.poll();assert.equal(h.state().phase,'current');assert.equal(h.reader.confirmCurrent(),true);
});

test('rebaseline requires actual native TL and a final TooLong whose dialog proves a forward matching channel PTS',async t=>{
  for(const response of [
    {className:'updates.ChannelDifferenceTooLong',pts:20,final:true,dialog:new Api.Dialog({peer:new Api.PeerChannel({channelId:b(100)}),pts:20})},
    tooLong(10),tooLong(20,200),tooLong(20,100,false),
  ]) {
    const h=harness(t);await integrityLatch(h);const originalPts=h.state().pts;await h.authorize();await h.restart({bootstrap:false});h.setReply(response);
    await assert.rejects(h.reader.bootstrap());assert.equal(h.state().pts,originalPts);assert.equal(h.state().reason,'INTEGRITY_RECONCILIATION_REQUIRED');
    assert.equal(h.store.get("SELECT COUNT(*) n FROM source_observation_epochs").n,0);
    assert.equal(JSON.parse(h.store.get("SELECT payload_json FROM events WHERE kind='source.telegram.rebaseline.finished' ORDER BY id DESC LIMIT 1").payload_json).status,'failed');
  }
});

test('reader created before pending rebaseline loses ownership, while restarted reader selects latest epoch',async t=>{
  const h=harness(t);await integrityLatch(h);const old=h.reader;await h.authorize();
  assert.equal(old.ownsSource(),false,'pending authorization fences a reader that predates it');
  const before=h.state(),eventCount=h.store.get('SELECT COUNT(*) n FROM events').n;
  await old.receive(new Api.UpdateNewChannelMessage({pts:12,ptsCount:1,message:message(2)}));
  assert.deepEqual(h.state(),before);assert.equal(h.store.get('SELECT COUNT(*) n FROM events').n,eventCount);
  await h.restart({bootstrap:false});
  h.setReply(r=>r instanceof Api.updates.GetChannelDifference?tooLong(20):full());await h.reader.bootstrap();
  const epochCount=()=>h.store.get("SELECT COUNT(*) n FROM source_observation_epochs").n;
  assert.equal(epochCount(),1);await h.restart();assert.equal(h.state().pts,20);assert.equal(epochCount(),1);
});

test('cancelled pending rebaseline cannot commit after an awaited native read returns',async t=>{
  const h=harness(t);await integrityLatch(h);const originalPts=h.state().pts;const authorization=await h.authorize();await h.restart({bootstrap:false});
  let entered,release;const inside=new Promise(r=>entered=r),held=new Promise(r=>release=r);
  h.setReply(async r=>{if(r instanceof Api.updates.GetChannelDifference){entered();await held;return tooLong(20);}return full();});
  const polling=assert.rejects(h.reader.bootstrap());await inside;
  await h.service.command('source.rebaseline_cancel',{authorization_id:authorization.authorization_id,
    reason:'Operator cancelled while observation was pending.'},'native-rebaseline-cancel');release();await polling;
  assert.equal(h.state().pts,originalPts);assert.equal(h.state().reason,'INTEGRITY_RECONCILIATION_REQUIRED');
  assert.equal(h.store.get("SELECT COUNT(*) n FROM source_observation_epochs").n,0);
});

test('expired or revoked rebaseline authority during an awaited read leaves the integrity cursor unchanged',async t=>{
  for(const mode of ['revoked','expired']) {
    if(mode==='expired') {
      t.mock.timers.enable({apis:['Date']});
      t.mock.timers.setTime(Date.parse('2026-01-02T00:00:00Z'));
    }
    const h=harness(t);await integrityLatch(h);const original=h.state(),authorization=await h.authorize();await h.restart({bootstrap:false});
    let entered,release;const inside=new Promise(r=>entered=r),held=new Promise(r=>release=r);
    h.setReply(async r=>{if(r instanceof Api.updates.GetChannelDifference){entered();await held;return tooLong(20);}return full();});
    const reading=assert.rejects(h.reader.bootstrap());await inside;
    if(mode==='expired') {
      t.mock.timers.setTime(Date.now()+31*60_000);
    }
    else h.config.opportunity.telegramSources=[];
    release();await reading;
    assert.deepEqual(h.state(),original);assert.equal(h.store.get('SELECT COUNT(*) n FROM source_observation_epochs').n,0);
    assert.equal(JSON.parse(h.store.get("SELECT payload_json FROM events WHERE kind='source.telegram.rebaseline.finished' ORDER BY id DESC LIMIT 1").payload_json).status,'failed');
  }
});

test('native callbacks during rebaseline reads or the queued commit fence the gap cutover',async t=>{
  for(const mode of ['fault-during-full','refresh-during-difference','malformed-during-difference','benign-before-commit']) {
    const h=harness(t);await integrityLatch(h);const original=h.state();await h.authorize();await h.restart({bootstrap:false});
    const waiting=waitable(),release=waitable();
    let unlockCommit;
    if(mode==='fault-during-full') h.setFull(async()=>{waiting.resolve();await release.promise;return full();});
    else if(mode==='refresh-during-difference' || mode==='malformed-during-difference')
      h.setReply(async()=>{waiting.resolve();await release.promise;return tooLong(20);});
    else {
      const locked=waitable(),unlock=waitable();h.service.exclusive(async()=>{locked.resolve();await unlock.promise;});await locked.promise;
      unlockCommit=unlock.resolve;
      h.setReply(()=>{waiting.resolve();return tooLong(20);});
    }
    const boot=h.reader.bootstrap();await waiting.promise;
    if(mode==='fault-during-full') await h.reader.fault();
    else if(mode==='refresh-during-difference') await h.reader.receive(new Api.UpdateChannel({channelId:b(100)}));
    else if(mode==='malformed-during-difference') await h.reader.receive(new Api.UpdateNewChannelMessage({pts:12,ptsCount:0,message:message(2)}));
    else {
      await new Promise(resolve=>setImmediate(resolve));
      await h.reader.receive(new Api.UpdateNewChannelMessage({pts:12,ptsCount:1,message:message(2)}));
    }
    release.resolve();
    if(mode==='benign-before-commit') {
      await new Promise(resolve=>setImmediate(resolve));
      unlockCommit();
    }
    await assert.rejects(boot);
    assert.deepEqual(h.state(),original,`${mode} must preserve the blocked cursor`);
    assert.equal(h.store.get('SELECT COUNT(*) n FROM source_observation_epochs').n,0,`${mode} cannot create an epoch`);
    assert.equal(h.reader.status().blocked,mode==='fault-during-full'||mode==='malformed-during-difference');
  }
});
