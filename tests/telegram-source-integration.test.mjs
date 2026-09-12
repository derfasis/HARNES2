// Deterministic model-shaped fixtures, NEVER live or semantic-accuracy claims.
// Real BusinessService/SQLite/Projection/Router/Consumer. Missing dependencies
// fail the suite at import; there is deliberately no skip or substitute validator.
import test, { before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Socket } from 'node:net';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { Store, id } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { ROOT, readJson } from '../business/config.mjs';
import { Scheduler } from '../business/scheduler.mjs';
import { contextFor } from '../business/context.mjs';
import { callTool } from '../business/tools.mjs';

import {bootstrapTelegramSource,applyTelegramDifference,disconnectTelegramSource} from '../business/sources/telegram-readonly.mjs';
let guards, originalKey;
before(() => {
  const fail=()=>{throw Error('External execution forbidden');};
  guards=[mock.method(globalThis,'fetch',fail),mock.method(Socket.prototype,'connect',fail),mock.method(childProcess,'spawn',fail)];
  syncBuiltinESMExports();
  const exists=fs.existsSync; mock.method(fs,'existsSync',file=>String(file).includes(`${path.sep}.venv${path.sep}`)||exists(file));
  originalKey=process.env.PARTNER_MODEL_API_KEY;process.env.PARTNER_MODEL_API_KEY='invented-offline-test';
});
after(()=>{ guards.forEach(g=>assert.equal(g.mock.callCount(),0));mock.restoreAll();syncBuiltinESMExports();
  if(originalKey===undefined)delete process.env.PARTNER_MODEL_API_KEY;else process.env.PARTNER_MODEL_API_KEY=originalKey; });
function source(extra={}) {
  const time='2026-01-01T00:00:00.000Z';
  return {source_id:'public:fixture',source_kind:'sanitized_fixture',message_id:'m1',author_id:'a1',display_name:'Same name',
    version:1,thread_id:'t1',reply_to_id:null,operation:'upsert',text:'What does this offer include?',created_at:time,updated_at:time,...extra};
}
function output(context, decision='PUBLIC_REPLY',positive=true) {
  const m=context.input.message;
  return {contract_version:'opportunity-projection-v0',situation_id:context.input.situation_id,
    opportunity:{hypothesis:positive?'This offer may answer the author’s explicit question.':null,
      evidence:positive?[{message_id:m.id,author_id:m.author_id,version:context.source_metadata.at(-1).version,
        span:m.text,kind:'question',attribution:'author_statement'}]:[],contradictions:[],unknowns:['Semantics require operator verification.']},
    next_action:{schema_version:1,situation_id:context.input.situation_id,decision,confidence:0.8,strategy:'Review only; owner request requires HANDOFF.',
      reason:'Synthetic deterministic response.',evidence_message_ids:[m.id],unknowns:[],risk_flags:[],
      draft:['PUBLIC_REPLY','DM'].includes(decision)?{channel:decision==='DM'?'dm':'public',action:'reply',target_id:m.author_id,text:'Review proposal only.',source_message_ids:[m.id]}:null,
      review:{required:true,status:'pending',authorization:'none'},reevaluate_after:null},authority:{contact_permission:false,allowed_effects:[]}};
}
function harness(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'harnes2-auto-'));let store=new Store(directory);
  const config=readJson(path.join(ROOT,'config/default.json'));
  Object.assign(config.opportunity,{automatic:true,allowedSourceRefs:['public:fixture'],activeOffer:readJson(path.join(ROOT,'benchmarks/opportunity-projection-v0/case-01.json')).active_offer});
  Object.assign(config.runtime,{model:'invented-model',baseUrl:'https://invalid.example/v1',dailyBudgetUsd:null});
  let service=new BusinessService(store,config),calls=0,reply=c=>output(c);
  const runtime={decide:async (run,context)=>{calls++;return {completed:true,final_response:JSON.stringify(await reply(context)),api_calls:1,usage:{input_tokens:10,output_tokens:10}};},
    run:()=>{throw Error('Ordinary agent runtime must not run');},close:()=>{},cancel:()=>{}};
  let scheduler=new Scheduler(service,runtime,{readiness:()=>{throw Error('Telegram must not be queried');},sendApproved:()=>{throw Error('Sending forbidden');}});
  t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});
  return {config,get store(){return store;},get service(){return service;},get calls(){return calls;},get scheduler(){return scheduler;},
    command:(a,p,actor={kind:'operator'},key=id())=>service.command(a,p,key,actor),
    ingest:(m=source())=>service.command('source.ingest',m,id(),{kind:'channel',sourceId:m.source_id}),
    tick:()=>scheduler.tick(),respond:fn=>{reply=fn;},
    cards:()=>store.all("SELECT * FROM tasks WHERE kind='opportunity_review'"),
    detail:()=>service.opportunityDetail(store.get("SELECT id FROM tasks WHERE kind='opportunity_review'").id),
    retryDue:()=>store.run("UPDATE runs SET finished_at='2026-01-01T00:00:00.000Z',created_at='2026-01-01T00:00:00.000Z' WHERE status IN ('failed','interrupted')"),
    restart:()=>{store.close();store=new Store(directory);store.recover();service=new BusinessService(store,config);scheduler=new Scheduler(service,runtime);}};
}
function noEffects(h) {for(const table of ['drafts','approvals','delivery_attempts','outcome_events','tool_calls','messages'])assert.equal(h.store.get(`SELECT COUNT(*) AS n FROM ${table}`).n,0,table);
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM persons WHERE trim(permission)<>''").n,0);}

const sourceId='telegram:channel:100';
const wire=(extra={})=>({id:1,channel_id:'100',from_id:{kind:'user',id:'10'},post:false,text:'What does this offer include?',date:1767225600,...extra});
const update=(pts=11,extra={})=>({kind:'new',channel_id:'100',pts,pts_count:1,message:wire(),...extra});
const page=(updates=[update()],extra={})=>({kind:'difference',account_id:'999',channel_id:'100',from_pts:10,to_pts:11,final:true,updates,...extra});
async function telegramHarness(t) {
  const h=harness(t);h.config.opportunity.allowedSourceRefs=[sourceId];
  h.config.opportunity.telegramSources=[{sourceId,accountId:'999',channelId:'100',sourceKind:'sanitized_fixture',processingBasis:'Offline synthetic test only',maxLagSeconds:120}];
  await bootstrapTelegramSource(h.service,sourceId,{pts:10,history:[]});
  return h;
}
test('Telegram intake through real Scheduler/Router validators/Consumer yields review only',async t=>{
  const h=await telegramHarness(t);await applyTelegramDifference(h.service,sourceId,page());await h.tick();
  assert.equal(h.cards().length,1);assert.equal(h.detail().executable,false);assert.equal(h.detail().subject.author_id,'user:10');
  assert.equal(h.detail().source_identity.version,11);assert.equal(h.detail().contact_permission,false);noEffects(h);
});
test('partial recovery defers inference, final page releases pending durable event',async t=>{
  const h=await telegramHarness(t);await applyTelegramDifference(h.service,sourceId,page(undefined,{final:false}));await h.tick();assert.equal(h.calls,0);
  await applyTelegramDifference(h.service,sourceId,{kind:'empty',account_id:'999',channel_id:'100',from_pts:11,to_pts:11,final:true,updates:[]});await h.tick();assert.equal(h.cards().length,1);noEffects(h);
});
test('Telegram source remains pending after restart until transport reconfirms',async t=>{
  const h=await telegramHarness(t);await applyTelegramDifference(h.service,sourceId,page());h.restart();await h.tick();assert.equal(h.calls,0);
  await applyTelegramDifference(h.service,sourceId,{kind:'empty',account_id:'999',channel_id:'100',from_pts:11,to_pts:11,final:true,updates:[]});await h.tick();assert.equal(h.cards().length,1);
});
test('disconnect while model running discards result, never emits stale card',async t=>{
  const h=await telegramHarness(t);h.respond(async c=>{await disconnectTelegramSource(h.service,sourceId);return output(c);});
  await applyTelegramDifference(h.service,sourceId,page());await h.tick();assert.equal(h.cards().length,0);noEffects(h);
});
test('native edit stales old review; native delete cannot be a reply task',async t=>{
  const h=await telegramHarness(t);await applyTelegramDifference(h.service,sourceId,page());await h.tick();const first=h.cards()[0];
  await applyTelegramDifference(h.service,sourceId,page([update(12,{kind:'edit',message:wire({text:'Updated question'})})],{from_pts:11,to_pts:12}));await h.tick();
  assert.equal(h.cards().length,2);assert.equal(h.service.opportunityDetail(first.id).freshness.fresh,false);
  await applyTelegramDifference(h.service,sourceId,page([{kind:'delete',channel_id:'100',pts:13,pts_count:1,message_ids:[1]}],{from_pts:12,to_pts:13}));await h.tick();
  assert.equal(h.calls,2);for(const c of h.cards())assert.equal(h.service.opportunityDetail(c.id).freshness.fresh,false);noEffects(h);
});
test('duplicate native delivery does not create a second review or model call',async t=>{
  const h=await telegramHarness(t);await applyTelegramDifference(h.service,sourceId,page());await h.tick();
  await applyTelegramDifference(h.service,sourceId,page());await h.tick();assert.equal(h.cards().length,1);assert.equal(h.calls,1);noEffects(h);
});
test('Telegram review cannot be approved/retried or supplied to agent context',async t=>{
  const h=await telegramHarness(t);await applyTelegramDifference(h.service,sourceId,page());await h.tick();const task=h.cards()[0];
  await assert.rejects(h.command('task.approve',{task_id:task.id}));await assert.rejects(h.command('task.retry',{task_id:task.id}));
  assert.throws(()=>contextFor(h.service,null,task));assert.deepEqual(await callTool(h.service,{kind:'agent'},'partner_list_work',{},id()),[]);noEffects(h);
});

test('existing Scheduler tick reads injected source then creates operator review',async t=>{
  const h=await telegramHarness(t);let reads=0;
  h.scheduler.sourceReaders=[{sourceId,transport:{readDifference:async input=>{reads++;assert.equal(input.pts,10);return page();}}}];
  await h.tick();assert.equal(reads,1);assert.equal(h.cards().length,1);assert.equal(h.detail().executable,false);noEffects(h);
});

test('generic source.ingest cannot bypass a Telegram reader checkpoint',async t=>{
  const h=await telegramHarness(t);await applyTelegramDifference(h.service,sourceId,page());
  const native=JSON.parse(h.store.get("SELECT payload_json FROM events WHERE kind='source.message'").payload_json);
  const raw={...native,message_id:'message:2',version:999,text:'Unattested replacement'};
  for(const actor of [{kind:'operator'},{kind:'channel',sourceId}])
    await assert.rejects(h.command('source.ingest',raw,actor),{code:'SOURCE_TRANSPORT_INGEST_REQUIRED'});
  h.config.opportunity.telegramSources=[];
  await assert.rejects(h.command('source.ingest',raw),{code:'SOURCE_TRANSPORT_INGEST_REQUIRED'});
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM events WHERE kind='source.message'").n,1);
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM events WHERE kind='source.telegram.update'").n,1);
  assert.equal(h.store.get("SELECT json_extract(cursor,'$.pts') AS pts FROM channel_offsets WHERE channel='telegram-source-v0'").pts,11);
  assert.equal(h.calls,0);noEffects(h);
});

test('generic fixture source ingestion stays available outside Telegram transport scope',async t=>{
  const h=harness(t);await h.ingest();await h.tick();
  assert.equal(h.cards().length,1);assert.equal(h.detail().executable,false);noEffects(h);
});

test('configured Telegram source cannot be populated through generic ingest before bootstrap',async t=>{
  const h=harness(t);h.config.opportunity.allowedSourceRefs=[sourceId];
  h.config.opportunity.telegramSources=[{sourceId}];
  await assert.rejects(h.command('source.ingest',source({source_id:sourceId})),{code:'SOURCE_TRANSPORT_INGEST_REQUIRED'});
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM events WHERE kind='source.message'").n,0);noEffects(h);
});
