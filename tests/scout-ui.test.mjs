import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start } from '../business/server.mjs';
import { ROOT, readJson } from '../business/config.mjs';
import { id } from '../business/store.mjs';
import { createScoutView } from '../public/scout.js';

const hostile = '<img src=x onerror="execute()">';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const campaignId = '11111111-1111-4111-8111-111111111111';
const candidateId = '22222222-2222-4222-8222-222222222222';
const sampleId = '33333333-3333-4333-8333-333333333333';
const assessmentId = '44444444-4444-4444-8444-444444444444';

function makeHarness({ enabled = true, modelEnabled = false, checkpoint = null, assessment = null } = {}) {
  const calls = [], dialogs = [];
  const source = { id:candidateId, channel_id:'-100123', username:'safe_name', title:hostile, kind:'channel', joined:true,
    sample:{id:sampleId,finished_at:'2026-10-01T10:00:00.000Z',coverage:'partial',metrics:{messages:2,authors:1,active_days:1,replies:0,exact_repeats:0,unsupported:0},groups:[{id:'group-1',evidence_refs:['ev-1'],preview:hostile,messages:[
      {message_id:'18',link:'https://evil.invalid/t.me/safe_name/18'},
      {message_id:'19',link:'https://t.me/safe_name/19'}]}]},
    assessment, checkpoint, checkpoint_fingerprint:checkpoint?'api-checkpoint-fingerprint':'', monitor_grant:null, reason:hostile };
  const detail={id:campaignId,title:hostile,topic:'Topic',revision:7,status:'active',config:{topic:'Topic',audience:'Operators',language:'ru',geography:'EU',queries:['seed']},authority:{scout:{id:'audit-grant',current:true,status:'active'}},candidates:[source],jobs:[],unknown:[]};
  const data={enabled,model_enabled:modelEnabled,account_id:'123',limits:{maxRequestsPerDay:50},read_gate:{ready:false,reason:'SCOUT_READ_BUDGET',requests:40,retry_at:'2099-01-01T00:00:00.000Z'},campaigns:[{id:campaignId,title:hostile,topic:'Topic',revision:7,status:'active',candidate_count:1}]};
  const api=async route=>{calls.push({method:'GET',route});if(route==='/api/scout')return structuredClone(data);if(route===`/api/scout/campaigns/${campaignId}`)return structuredClone(detail);throw new Error(`Unexpected read ${route}`);};
  const command=async(action,payload)=>{calls.push({method:'POST',action,payload:structuredClone(payload)});return {ok:true};};
  const modal=(title,html,submit)=>dialogs.push({title,html,submit});
  const view=createScoutView({api,command,esc,modal,refresh:async()=>{}});
  return {view,calls,dialogs,data,detail,source};
}

test('snapshot render escapes untrusted campaign and evidence text and suppresses hostile permalink hrefs without POSTs', async()=>{
  const h=makeHarness(); await h.view.load(); const html=h.view.render();
  assert.equal(html.includes(hostile),false);
  assert.match(html,/&lt;img src=x onerror=/);
  assert.equal(html.includes('href="https://evil.invalid'),false);
  assert.match(html,/href="https:\/\/t\.me\/safe_name\/19"/);
  assert.match(html,/SCOUT_READ_BUDGET/); assert.match(html,/40 \/ 50/); assert.match(html,/не вызовы Gemini/);
  assert.deepEqual(h.calls.filter(x=>x.method==='POST'),[]);
});

test('disabled model assessment stays disabled and cannot enqueue a command through the action handler', async()=>{
  const h=makeHarness({modelEnabled:false}); await h.view.load();
  const html=h.view.render(); assert.match(html,/disabled[^]*Запросить оценку/);
  await assert.rejects(()=>h.view.act('scout-assess',candidateId),/Оценка отключена/);
  assert.deepEqual(h.calls.filter(x=>x.method==='POST'),[]);
});

test('monitor admission requires explicit historical-gap consent and sends API checkpoint authority unchanged', async()=>{
  const checkpoint={pts:731}; const h=makeHarness({checkpoint}); await h.view.load();
  await h.view.act('scout-admit',candidateId); const form=h.dialogs.at(-1);
  assert.match(form.html,/name="allow_catchup"/); assert.doesNotMatch(form.html,/name="allow_catchup"[^>]*checked/);
  assert.match(form.html,/PTS 731/); assert.match(form.html,/включая период без прошлого разрешения/);
  assert.throws(()=>form.submit({expires_at:'2099-01-01T00:00',purpose:'Monitor',manual_review:'yes',manual_rationale:'Reviewed the displayed sample'}),/исторического чтения/);
  assert.equal(h.calls.filter(x=>x.method==='POST').length,0);
  await form.submit({allow_catchup:'yes',expires_at:'2099-01-01T00:00',purpose:'Monitor',manual_review:'yes',manual_rationale:'Reviewed this exact historical sample'});
  const call=h.calls.filter(x=>x.method==='POST').at(-1);
  assert.equal(call.action,'scout.admit');
  assert.deepEqual(call.payload,{campaign_id:campaignId,revision:7,candidate_id:candidateId,sample_id:sampleId,assessment_id:null,
    expires_at:new Date('2099-01-01T00:00').toISOString(),purpose:'Monitor\nОснование ручной проверки: Reviewed this exact historical sample',max_lag_seconds:300,
    catchup_from_pts:731,expected_checkpoint_fingerprint:'api-checkpoint-fingerprint',accept_historical_gap:true});
});

test('current approved assessment allows explicit admission with exact assessment and checkpoint, without manual-review fields', async()=>{
  const h=makeHarness({checkpoint:{pts:812},assessment:{id:assessmentId,status:'approved',current:true,reason:'Reviewed'}}); await h.view.load();
  await h.view.act('scout-admit',candidateId); const form=h.dialogs.at(-1);
  assert.doesNotMatch(form.html,/name="manual_review"/);
  await form.submit({allow_catchup:'yes',expires_at:'2099-01-01T00:00',purpose:'Bounded updates'});
  const call=h.calls.filter(x=>x.method==='POST').at(-1);
  assert.equal(call.payload.assessment_id,assessmentId);
  assert.equal(call.payload.purpose,'Bounded updates');
  assert.equal(call.payload.catchup_from_pts,812);
  assert.equal(call.payload.expected_checkpoint_fingerprint,'api-checkpoint-fingerprint');
  assert.equal(call.payload.accept_historical_gap,true);
});

test('topic revision submits only the selected campaign and its displayed revision', async()=>{
  const h=makeHarness(); await h.view.load(); await h.view.act('scout-revise',campaignId); const form=h.dialogs.at(-1);
  await form.submit({topic:'Revised topic',audience:'New audience',language:'en',geography:'CA',queries:'q1\nq2'});
  const call=h.calls.filter(x=>x.method==='POST').at(-1);
  assert.deepEqual(call,{method:'POST',action:'scout.revise',payload:{campaign_id:campaignId,revision:7,topic:'Revised topic',audience:'New audience',language:'en',geography:'CA',queries:['q1','q2']}});
});

test('operator server protects Scout snapshots and serves its public module with model and Telegram disabled',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'harnes2-scout-ui-'));
  const config=readJson(path.join(ROOT,'config/default.json'));
  config.server.port=0; config.scheduler.enabled=false; config.telegram.enabled=false; config.telegram.liveSending=false;
  config.scout={...(config.scout??{}),enabled:false,modelEnabled:false};
  const app=await start({config,directory}); t.after(async()=>{await app.close();fs.rmSync(directory,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${app.server.address().port}`;
  const page=await fetch(origin); assert.equal(page.status,200); assert.match(await page.text(),/data-tab="scout"|data-tab="sources"/);
  const module=await fetch(`${origin}/scout.js`); assert.equal(module.status,200); assert.match(await module.text(),/createScoutView/);
  assert.equal((await fetch(`${origin}/api/scout`)).status,403);
  const session=await(await fetch(`${origin}/api/session`)).json(); const headers={'x-partner-token':session.token};
  const snapshotResponse=await fetch(`${origin}/api/scout`,{headers}); assert.equal(snapshotResponse.status,200);
  const snapshot=await snapshotResponse.json(); assert.equal(snapshot.enabled,false); assert.equal(snapshot.model_enabled,false); assert.deepEqual(snapshot.campaigns,[]);
});

test('seed form does not turn hostile permalinks into links and API rejects a malicious seed reference',async t=>{
  const h=makeHarness(); await h.view.load(); await h.view.act('scout-seed',campaignId); const form=h.dialogs.at(-1);
  assert.doesNotMatch(form.html,/href=/);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'harnes2-scout-seed-ui-'));
  const config=readJson(path.join(ROOT,'config/default.json'));
  config.server.port=0; config.scheduler.enabled=false; config.telegram.enabled=false; config.telegram.liveSending=false;
  config.scout={...(config.scout??{}),enabled:true,modelEnabled:false}; config.controlPlane={...(config.controlPlane??{}),enabled:true}; config.telegram.transport='mtproto';
  const app=await start({config,directory}); t.after(async()=>{await app.close();fs.rmSync(directory,{recursive:true,force:true});});
  app.service.setTelegramAccount('123456789');
  const origin=`http://127.0.0.1:${app.server.address().port}`; const session=await(await fetch(`${origin}/api/session`)).json();
  const headers={'x-partner-token':session.token,'content-type':'application/json'};
  const post=async(action,payload)=>fetch(`${origin}/api/commands`,{method:'POST',headers,body:JSON.stringify({action,payload,request_id:id()})});
  const created=await post('scout.create',{title:'UI fixture',topic:'Topic',audience:'Operators',language:'en',geography:'US',queries:['Topic']}); assert.equal(created.status,200,await created.clone().text());
  const campaign=(await created.json()).campaign_id;
  const auth=await post('scout.authorize',{campaign_id:campaign,revision:1,expires_at:new Date(Date.now()+86400000).toISOString(),purpose:'Resolve an operator supplied source'}); assert.equal(auth.status,200,await auth.clone().text());
  const seed=await post('scout.seed',{campaign_id:campaign,revision:1,reference:'https://evil.invalid/t.me/safe_name'});
  assert.equal(seed.status,409,await seed.clone().text()); assert.match((await seed.json()).error,/SCOUT_REFERENCE_INVALID|Invalid|reference/i);
});
