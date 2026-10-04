// Authenticated localhost API composition, with the model worker intercepted before spawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { ROOT, readJson } from '../business/config.mjs';
import { id } from '../business/store.mjs';
import { start } from '../business/server.mjs';
import { proposalFrom, modelOutputFrom, SOURCE } from './audience-test-helpers.mjs';

const PROFILE_URL = 'https://followthrough-api-fixture.invalid/v1';
const freshText = 'A current reply completes the first step and asks what comes next.';

async function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'harnes2-followthrough-api-'));
  const previousKey = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'synthetic-followthrough-api-sentinel';
  t.after(() => previousKey === undefined ? delete process.env.PARTNER_MODEL_API_KEY : process.env.PARTNER_MODEL_API_KEY = previousKey);
  const config = structuredClone(readJson(path.join(ROOT,'config/default.json')));
  config.server.host='127.0.0.1'; config.server.port=0;
  config.scheduler.enabled=true; config.scheduler.tickSeconds=3600;
  Object.assign(config.runtime,{ enabled:false,baseUrl:'',model:'',dailyBudgetUsd:null,maxRunsPerDay:50,timeoutSeconds:45 });
  config.telegram.enabled=false; config.telegram.liveSending=false;
  config.audience={ ...config.audience,enabled:true,modelEnabled:false,sources:[SOURCE],maxRunsPerDay:10 };
  config.opportunity.allowedSourceRefs=[SOURCE]; config.opportunity.telegramSources=[]; config.opportunity.browserSources=[];
  config.opportunity.automatic=true;
  config.modelProfiles={ allowedBaseUrls:[PROFILE_URL] };
  config.controlPlane={ ...config.controlPlane,enabled:true,maxConcurrent:3,reservationUsd:0.25 };
  config.continuity={ ...config.continuity,enabled:true,modelEnabled:false };
  config.executive={ ...config.executive,enabled:false,modelEnabled:false };
  const app=await start({ config,directory });
  t.after(async()=>{ await app.close(); fs.rmSync(directory,{recursive:true,force:true}); });
  const origin=`http://127.0.0.1:${app.server.address().port}`;
  const session=await (await fetch(`${origin}/api/session`)).json();
  const headers={ 'x-partner-token':session.token,'content-type':'application/json' };
  const get=route=>fetch(`${origin}${route}`,{headers});
  const postCommand=(action,payload,requestId=id(),extra={})=>fetch(`${origin}/api/commands`,{method:'POST',headers,
    body:JSON.stringify({action,payload,request_id:requestId,...extra})});
  return { app,config,directory,origin,headers,get,postCommand };
}

async function seedNeed(app) {
  const service=app.service;
  const opened=await service.command('audience.open',{title:'API follow-up need',
    objective:'Use only new current evidence to reconsider one synthetic question.',source_ids:[SOURCE]},id());
  const ingest=(messageId,text,replyTo=null)=>service.command('source.ingest',{source_id:SOURCE,source_kind:'sanitized_fixture',
    message_id:messageId,author_id:`author:${SOURCE}`,display_name:null,thread_id:'api-followup-thread',reply_to_id:replyTo,
    version:1,operation:'upsert',text,created_at:new Date().toISOString(),updated_at:new Date().toISOString()},id(),
  {kind:'channel',sourceId:SOURCE});
  await ingest('api-followup-old','The historical question before the new reply.');
  service.audience.reconcile({limit:10});
  const goal=service.audience.detail(opened.goal_id);
  const capture=await service.command('audience.capture',{goal_id:opened.goal_id,
    expected_revision:goal.revision,expected_basis_fingerprint:goal.basis_fingerprint},id());
  const original=service.audience.assessment(capture.assessment_id);
  const proposed=await service.command('audience.propose',{assessment_id:capture.assessment_id,
    output:proposalFrom(original.packet)},id());
  let need=service.audience.need(proposed.need_ids[0]);
  await service.command('audience.review',{need_id:need.id,expected_revision:need.revision,
    expected_basis_fingerprint:need.basis_fingerprint,decision:'accept',note:'Synthetic original owner review.'},id());
  need=service.audience.need(need.id);
  const fresh=await ingest('api-followup-fresh',freshText,'api-followup-old');
  service.audience.reconcile({limit:10,event_limit:50});
  const profile=await service.command('model.profile_create',{label:'API isolated follow-up profile',provider:'custom',
    api_mode:'chat_completions',base_url:PROFILE_URL,model:'api-followthrough-model',max_output_tokens:600,
    input_usd_per_million:1,output_usd_per_million:2},id());
  return {goal,need,profile,freshEventId:fresh.source_event_id};
}

function interceptWorker(t) {
  const calls=[];
  const guard=t.mock.method(childProcess,'spawn',(_python,args,options)=>{
    const child=new EventEmitter();
    child.stdin=new EventEmitter(); child.stdout=new EventEmitter(); child.stderr=new EventEmitter();
    child.stdout.setEncoding=()=>{}; child.kill=()=>{queueMicrotask(()=>child.emit('close',1));return true;};
    child.stdin.end=text=>{
      const envelope=JSON.parse(text); calls.push({args,options,envelope});
      const packet=envelope.context.packet;
      const output=proposalFrom(packet,{need_id:packet.followup.need_id,title:'API fresh reviewable revision',
        hypothesis:'The new reply leaves one next-step question.',why_now:'This current reply asks for what comes next.',
        next_step:'observe',reason:'Only newly current evidence supports this narrow continuation.'});
      queueMicrotask(()=>{
        child.stdout.emit('data',JSON.stringify({completed:true,final_response:JSON.stringify(modelOutputFrom(packet,output)),
          usage:{input_tokens:29,output_tokens:11},model_identity:{model_id:'api-followthrough-model',model_version:'api-fixture-v1'},api_calls:1}));
        child.emit('close',0);
      });
    };
    return child;
  });
  syncBuiltinESMExports(); t.after(()=>{guard.mock.restore();syncBuiltinESMExports();});
  return {calls,guard};
}

function requestPayload(context,profile,overrides={}) {
  return {need_id:context.need_id,expected_revision:context.need_revision,
    expected_basis_fingerprint:context.need_basis_fingerprint,expected_context_fingerprint:context.context_fingerprint,
    model_profile_id:profile.profile_id,expected_profile_hash:profile.definition_hash,
    expires_at:new Date(Date.now()+60*60*1000).toISOString(),reason:'One explicit API follow-up request.',...overrides};
}

const waitFor = async predicate => {
  const until=Date.now()+5000;
  while(Date.now()<until) { if(predicate()) return; await new Promise(resolve=>setTimeout(resolve,10)); }
  assert.ok(predicate(),'timed out waiting for the scheduler tick to settle');
};

test('authenticated follow-up reads are inert; strict owner request is replay-safe and Scheduler wake admits only that focused public turn',async t=>{
  const h=await harness(t),seeded=await seedNeed(h.app);
  const contextRoute=`/api/audience/needs/${seeded.need.id}/followup-context`;
  const unauth=await fetch(`${h.origin}${contextRoute}`); assert.equal(unauth.status,403);
  const noCalls=interceptWorker(t);
  const before=()=>({requests:h.app.store.get('SELECT COUNT(*) n FROM audience_followup_requests').n,
    assessments:h.app.store.get('SELECT COUNT(*) n FROM audience_assessments').n,
    runs:h.app.store.get('SELECT COUNT(*) n FROM runs').n,
    offsets:h.app.store.get('SELECT COUNT(*) n FROM channel_offsets').n});
  const pre=before();
  const badQuery=await h.get(`${contextRoute}?ignored=1`); assert.equal(badQuery.status,400);
  const contextResponse=await h.get(contextRoute); assert.equal(contextResponse.status,200);
  const context=await contextResponse.json();
  assert.equal(context.available,true); assert.equal(context.need_id,seeded.need.id);
  assert.ok(context.exchanges.flatMap(exchange=>exchange.evidence).some(e=>e.source_event_id===seeded.freshEventId));
  assert.equal(JSON.stringify(context.exchanges).includes('The historical question before the new reply.'),false);
  assert.equal(h.config.runtime.enabled,false); assert.equal(h.config.audience.modelEnabled,false);
  assert.equal(noCalls.guard.mock.callCount(),0); assert.deepEqual(before(),pre,'preview GETs do not persist commands, runs or cursor movement');

  const requestId=id(),payload=requestPayload(context,seeded.profile);
  const cases=[
    {label:'unknown payload field',payload:{...payload,unexpected:'not contractual'}},
    {label:'wrong context',payload:{...payload,expected_context_fingerprint:'a'.repeat(64)}},
    {label:'wrong profile hash',payload:{...payload,expected_profile_hash:'b'.repeat(64)}},
    {label:'wrong need',payload:{...payload,need_id:id()}},
  ];
  const unauthCommand=await fetch(`${h.origin}/api/commands`,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({action:'audience.followup_request',payload:requestPayload(context,seeded.profile),request_id:id()})});
  assert.equal(unauthCommand.status,403,'follow-up authority commands require the operator session');
  for(const bad of cases) {
    const response=await h.postCommand('audience.followup_request',bad.payload,id());
    assert.ok([400,404,409].includes(response.status),`${bad.label}: ${response.status} ${await response.clone().text()}`);
  }
  assert.equal(h.app.store.get('SELECT COUNT(*) n FROM audience_followup_requests').n,0,
    'invalid or mismatched parameters create no authority rows');
  assert.equal(noCalls.guard.mock.callCount(),0);

  const accepted=await h.postCommand('audience.followup_request',payload,requestId);
  assert.equal(accepted.status,200,await accepted.clone().text());
  const first=await accepted.json(); assert.equal(first.executable,false); assert.equal(first.contact_permission,false);
  assert.equal(h.app.store.get('SELECT COUNT(*) n FROM audience_followup_requests').n,1);
  const replay=await h.postCommand('audience.followup_request',payload,requestId);
  assert.equal(replay.status,200); assert.deepEqual(await replay.json(),first);
  assert.equal(h.app.store.get('SELECT COUNT(*) n FROM audience_followup_requests').n,1,
    'an identical owner command receipt returns the same one-shot request');
  await assert.rejects(h.app.service.command('audience.followup_request',payload,requestId,{kind:'agent',runId:id()}),
    {code:'AUDIENCE_OPERATOR_REQUIRED'},'actor ownership is checked before receipt replay');
  assert.equal(h.app.store.get('SELECT COUNT(*) n FROM audience_followup_requests').n,1);
  assert.equal(h.app.store.get('SELECT COUNT(*) n FROM command_receipts WHERE id=?',requestId).n,1);

  const requestRoute=`/api/audience/followups/${first.request_id}`;
  const detailResponse=await h.get(requestRoute); assert.equal(detailResponse.status,200);
  const requestDetail=await detailResponse.json(); assert.equal(requestDetail.request_id,first.request_id);
  assert.equal(requestDetail.state,'captured');
  const detailBefore=before();
  assert.equal((await h.get(`${requestRoute}?ignored=1`)).status,400);
  assert.equal((await h.get(`/api/audience/followups/${id()}`)).status,404);
  assert.deepEqual(before(),detailBefore,'request history and unknown queries are read-only');
  assert.equal(noCalls.guard.mock.callCount(),0,'neither preview nor history invokes the model worker');

  const wake=await fetch(`${h.origin}/api/scheduler/wake`,{method:'POST',headers:h.headers});
  assert.equal(wake.status,202,await wake.clone().text());
  await waitFor(()=>h.app.store.get('SELECT status FROM runs WHERE runtime=?','hermes-audience-v1')?.status==='completed'
    && !h.app.scheduler.busy && !h.app.scheduler.reasonBusy);
  assert.equal(noCalls.guard.mock.callCount(),1);
  assert.equal(h.app.scheduler.audienceState.disposition,'proposal_created');
  assert.equal(h.config.runtime.enabled,false); assert.equal(h.config.runtime.baseUrl,''); assert.equal(h.config.audience.modelEnabled,false);
  const invocation=noCalls.calls[0],envelope=invocation.envelope;
  assert.equal(envelope.model.model,'api-followthrough-model'); assert.equal(envelope.model.timeoutSeconds,45);
  assert.equal(envelope.model.maxIterations,2); assert.deepEqual(envelope.tools,[]); assert.equal(envelope.business_url,undefined);
  assert.equal(invocation.options.env.PARTNER_RUN_TOKEN,undefined);
  const run=h.app.store.get("SELECT * FROM runs WHERE runtime='hermes-audience-v1'");
  const receipt=JSON.parse(run.result_json);
  const ticket=h.app.store.get('SELECT plane,operation FROM control_tickets WHERE run_id=?',run.id);
  assert.equal(run.status,'completed'); assert.equal(run.input_tokens,29); assert.equal(run.output_tokens,11);
  assert.deepEqual({plane:ticket?.plane,operation:ticket?.operation},{plane:'public',operation:'audience'});
  assert.equal(receipt.model_api_calls,1); assert.equal(receipt.followup_request.id,first.request_id);
  assert.equal(h.app.store.get('SELECT COUNT(*) n FROM audience_followup_attempts WHERE request_id=?',first.request_id).n,1);
  assert.equal(h.app.store.get('SELECT COUNT(*) n FROM audience_attention_attempts').n,0);
  assert.equal(h.app.store.get("SELECT COUNT(*) n FROM runs WHERE runtime<>'hermes-audience-v1'").n,0,
    'the wake uses only the public Audience slot; no private or other model plane runs');
  for(const table of ['persons','conversations','drafts','delivery_attempts','action_proposals'])
    assert.equal(h.app.store.get(`SELECT COUNT(*) n FROM ${table}`).n,0,`${table} remains untouched`);
});
