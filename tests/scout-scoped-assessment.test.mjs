import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeActivation } from '../business/deployment.mjs';
import { HermesAdapter } from '../business/runtime.mjs';
import { processScoutAssessment } from '../business/scout-reasoning.mjs';
import { id } from '../business/store.mjs';
import { channel, message, noHistory, scoutHarness } from './scout-test-helpers.mjs';

const PROFILE_URL='https://models.example.test/v1';
const successful={recommendation:'consider',reason:'A bounded source discussion merits operator review.',
  evidence_refs:['1'],opportunities:[{description:'Review the cited discussion.',evidence_refs:['1']}],
  uncertainty:['The sample does not establish current intent.']};

async function prepared(t,{mode='scoped_reasoning',messages=null,resolveJoined=false}={}) {
  const oldKey=process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY='offline-scoped-assessment-sentinel';
  t.after(()=>oldKey===undefined?delete process.env.PARTNER_MODEL_API_KEY:process.env.PARTNER_MODEL_API_KEY=oldKey);
  const h=scoutHarness(t,{resolve:async()=>channel({joined:resolveJoined}),history:async input=>input.before_id?noHistory(input):{
    empty:false,requested_count:input.limit,received_count:messages?.length??1,oldest_id:Number(messages?.[0]?.message_id??'1'),
    messages:messages??[message('1',{text:'I am considering reselling a product line. Which suppliers support small shops?'})]
  }});
  Object.assign(h.config.runtime,{enabled:false,model:'',baseUrl:'',dailyBudgetUsd:5});
  h.config.opportunity.automatic=false;
  h.config.modelProfiles={allowedBaseUrls:[PROFILE_URL]};
  h.config.controlPlane.enabled=true;
  h.service.deployment=new RuntimeActivation({id:id(),label:'Offline scoped test',mode,expires_at:new Date(Date.now()+3600000).toISOString()});
  const campaign=await h.campaign('small business product sourcing');
  const grant=await h.authorize(campaign);
  const candidate=await h.seed(campaign);
  const sample=await h.auditAndSeal(campaign,candidate);
  const profile=await h.command('model.profile_create',{label:'Offline test profile',provider:'custom',api_mode:'chat_completions',
    base_url:PROFILE_URL,model:'offline-scoped-model',max_output_tokens:900,input_usd_per_million:2,output_usd_per_million:3});
  const request={campaign_id:campaign.id,revision:campaign.revision,candidate_id:candidate.id,sample_id:sample.id,
    model_profile_id:profile.profile_id,expected_model_profile_hash:profile.definition_hash,
    expires_at:new Date(Date.now()+5*60000).toISOString(),purpose:'One offline assessment for this sealed sample.'};
  return {h,campaign,grant,candidate,sample,profile,request};
}

async function request(x,overrides={}) { return x.h.command('scout.request_assessment',{...x.request,...overrides}); }
function runtime({onCall=()=>{},result={completed:true,final_response:JSON.stringify(successful)},delay=null}={}) {
  return {decide:async(run,context)=>{onCall(run,context);if(delay)await delay;return typeof result==='function'?result(run,context):result;}};
}

test('scoped request runs one exact sample with global model and automatic opportunity disabled',async t=>{
  const x=await prepared(t);let calls=0,seen;
  await request(x);
  const sourceEventCount=x.h.store.get("SELECT COUNT(*) n FROM events WHERE kind LIKE 'source.%'").n;
  const outcome=await processScoutAssessment(x.h.service,runtime({onCall:(run,ctx)=>{calls++;seen={run,ctx};}}));
  assert.equal(outcome.disposition,'assessment_proposed');assert.equal(calls,1);
  assert.equal(x.h.config.scout.modelEnabled,false);assert.equal(x.h.config.runtime.model,'');assert.equal(x.h.config.opportunity.automatic,false);
  assert.equal(seen.run.model,'offline-scoped-model');assert.equal(seen.ctx.packet.sample.current_intent,'unknown');
  assert.equal(seen.ctx.packet.sample.offer_fit,'unknown');assert.equal(seen.ctx.packet.contact_permission,false);
  assert.equal(seen.ctx.packet.scout_assessment_request.id,x.h.store.get('SELECT id FROM scout_model_requests').id);
  const stored=x.h.store.get("SELECT * FROM runs WHERE runtime='hermes-scout-v1'");
  assert.equal(stored.input_tokens,null);assert.equal(stored.cost_status,'unknown');
  assert.equal(x.h.store.get('SELECT COUNT(*) n FROM scout_assessments').n,1);
  for(const table of ['persons','conversations','messages','drafts','delivery_attempts','contact_permissions'])
    assert.equal(x.h.store.get(`SELECT COUNT(*) n FROM ${table}`).n,0,`${table} remains untouched`);
  assert.equal(x.h.store.get("SELECT COUNT(*) n FROM events WHERE kind LIKE 'source.%'").n,sourceEventCount,
    'assessment adds no source observation events');
});

test('no scoped request means the disabled global model cannot call runtime; read-only activation rejects requests',async t=>{
  const x=await prepared(t);let calls=0;
  assert.equal((await processScoutAssessment(x.h.service,runtime({onCall:()=>calls++}))).disposition,'disabled');
  assert.equal(calls,0);
  const y=await prepared(t,{mode:'read_only'});
  await assert.rejects(request(y),{code:'CONTROL_ACTIVATION_MODELS_OFF'});
  assert.equal(y.h.store.get("SELECT COUNT(*) n FROM scout_model_requests").n,0);
});

test('a valid scoped request is not starved behind more than twenty disabled legacy assessment jobs',async t=>{
  const x=await prepared(t),legacyIds=[];
  const old='2020-01-01T00:00:00.000Z';
  for(let n=0;n<21;n++) {
    const jobId=id();legacyIds.push(jobId);
    x.h.store.run(`INSERT INTO scout_jobs(id,campaign_id,campaign_revision,grant_id,candidate_id,kind,status,cursor_json,sample_id,
      next_at,created_at,updated_at) VALUES(?,?,?,?,?,'assessment','queued',?,?,?, ?,?)`,
      jobId,x.campaign.id,x.campaign.revision,x.grant,x.candidate.id,
      JSON.stringify({sample_digest:x.sample.digest,topic_hash:x.h.service.scout.campaign(x.campaign.id).topic_hash,evaluator_version:'scout-assessment-v3'}),
      x.sample.id,new Date(Date.now()-1000).toISOString(),old,old);
  }
  const scoped=await request(x);let calls=0,seenJobId=null;
  const outcome=await processScoutAssessment(x.h.service,runtime({onCall:run=>{calls++;seenJobId=JSON.parse(run.context_json).job_id;}}));
  assert.equal(outcome.disposition,'assessment_proposed');assert.equal(calls,1);assert.equal(seenJobId,scoped.job_id);
  assert.equal(x.h.store.get(`SELECT COUNT(*) n FROM scout_jobs WHERE id IN (${legacyIds.map(()=>'?').join(',')}) AND status='queued' AND attempts=0`,...legacyIds).n,21,
    'disabled legacy work remains untouched while the scoped job progresses');
});

test('scoped authority rejects wrong profile hash, account, sample, candidate, revision, expiry, and revocation',async t=>{
  const x=await prepared(t);
  await assert.rejects(request(x,{expected_model_profile_hash:'0'.repeat(64)}),{code:'SCOUT_MODEL_PROFILE_STALE'});
  await assert.rejects(request(x,{candidate_id:id()}),{code:'SCOUT_CANDIDATE_NOT_FOUND'});
  await assert.rejects(request(x,{sample_id:id()}),{code:'SCOUT_SAMPLE_NOT_FOUND'});
  const stale={...x.request,revision:x.campaign.revision+1};
  await assert.rejects(x.h.command('scout.request_assessment',stale),{code:'SCOUT_REVISION_CONFLICT'});
  const account=x.h.store.get('SELECT * FROM scout_candidates WHERE id=?',x.candidate.id);
  x.h.store.run('UPDATE scout_candidates SET account_id=? WHERE id=?','991234567891',x.candidate.id);
  await assert.rejects(request(x),{code:'SCOUT_SAMPLE_SCOPE'});
  x.h.store.run('UPDATE scout_candidates SET account_id=? WHERE id=?',account.account_id,x.candidate.id);
  await assert.rejects(request(x,{expires_at:new Date(Date.now()-1000).toISOString()}),{code:'SCOUT_MODEL_REQUEST_EXPIRY_INVALID'});
  const created=await request(x);
  await x.h.command('scout.revoke_assessment',{request_id:created.request_id,expected_fingerprint:created.fingerprint,reason:'Offline test revoke'});
  let calls=0;
  assert.notEqual((await processScoutAssessment(x.h.service,runtime({onCall:()=>calls++}))).disposition,'assessment_proposed');
  assert.equal(calls,0);
});

test('source edits and tombstones invalidate a scoped sample before model execution',async t=>{
  for(const operation of ['edit','delete']) {
    const x=await prepared(t);await request(x);
    x.h.store.event(x.h.service.config.partnerId,null,operation==='delete'?'source.telegram.tombstone':'source.message','operator',
      {source_id:x.sample.source_ref,message_id:'message:1',operation,...(operation==='edit'?{text:'Changed after sample capture.'}:{})});
    assert.throws(()=>x.h.service.scout.sample(x.sample.id,x.candidate),{code:'SCOUT_SAMPLE_STALE'});
    let calls=0;const outcome=await processScoutAssessment(x.h.service,runtime({onCall:()=>calls++}));
    assert.equal(calls,0);assert.notEqual(outcome.disposition,'assessment_proposed');
  }
});

test('revocation while model work is delayed withholds the result and retains usage',async t=>{
  const x=await prepared(t);const created=await request(x);let startedResolve,finishResolve;
  const started=new Promise(resolve=>startedResolve=resolve),finish=new Promise(resolve=>finishResolve=resolve);
  const pending=processScoutAssessment(x.h.service,runtime({onCall:()=>startedResolve(),delay:finish,result:{completed:true,final_response:JSON.stringify(successful),
    api_calls:1,model_identity:{model_id:'served-after-revocation',model_version:'provider-v2'},usage:{input_tokens:12,output_tokens:5}}}));
  await started;
  await x.h.command('scout.revoke_assessment',{request_id:created.request_id,expected_fingerprint:created.fingerprint,reason:'Revoke during offline test'});
  finishResolve();const outcome=await pending;
  assert.equal(outcome.disposition,'withheld');assert.equal(outcome.reason,'SCOUT_MODEL_REQUEST_RUN_OWNER');
  assert.equal(x.h.store.get('SELECT COUNT(*) n FROM scout_assessments').n,0);
  assert.equal(x.h.store.get("SELECT status FROM runs WHERE runtime='hermes-scout-v1'").status,'failed');
  assert.equal(x.h.store.get("SELECT input_tokens FROM runs WHERE runtime='hermes-scout-v1'").input_tokens,12);
  const receipt=JSON.parse(x.h.store.get("SELECT result_json FROM runs WHERE runtime='hermes-scout-v1'").result_json).runtime_receipt;
  assert.equal(receipt.api_calls,1);assert.equal(receipt.model_identity.model_id,'served-after-revocation');
  assert.equal(x.h.store.get('SELECT COUNT(*) n FROM scout_assessments').n,0);
});

for(const mutation of ['audit grant','model profile','campaign revision']) test(`late result is withheld after ${mutation} changes`,async t=>{
  const x=await prepared(t),created=await request(x);let startedResolve,finishResolve;
  const started=new Promise(resolve=>startedResolve=resolve),finish=new Promise(resolve=>finishResolve=resolve);
  const pending=processScoutAssessment(x.h.service,runtime({onCall:()=>startedResolve(),delay:finish,
    result:{completed:true,final_response:JSON.stringify(successful),usage:{input_tokens:7,output_tokens:4}}}));
  await started;
  if(mutation==='audit grant') await x.h.command('scout.revoke',{campaign_id:x.campaign.id,revision:x.campaign.revision,grant_id:x.grant});
  else if(mutation==='model profile') await x.h.command('model.profile_revoke',{profile_id:x.profile.profile_id,
    expected_definition_hash:x.profile.definition_hash,reason:'Revoke offline scoped test profile.'});
  else await x.h.command('scout.revise',{campaign_id:x.campaign.id,revision:x.campaign.revision,topic:'Revised offline topic',
    audience:'Revised offline audience',language:'en',geography:'global',queries:['revised offline query']});
  finishResolve();const outcome=await pending;
  assert.notEqual(outcome.disposition,'assessment_proposed');
  assert.equal(x.h.store.get('SELECT COUNT(*) n FROM scout_assessments').n,0);
  const run=x.h.store.get("SELECT * FROM runs WHERE runtime='hermes-scout-v1'");
  assert.equal(run.input_tokens,7);assert.equal(run.output_tokens,4);
  assert.equal(x.h.store.get('SELECT attempts FROM scout_jobs WHERE id=?',created.job_id).attempts,1);
});

test('exact command replay after a completed request returns spent authority and cannot call runtime twice',async t=>{
  const x=await prepared(t),first=await request(x);let calls=0;
  const one=await processScoutAssessment(x.h.service,runtime({onCall:()=>calls++}));
  assert.equal(one.disposition,'assessment_proposed');assert.equal(calls,1);
  x.h.restart();const replay=await request(x);
  assert.equal(replay.request_id,first.request_id);assert.equal(replay.job_id,first.job_id);assert.equal(replay.reused,true);
  const second=await processScoutAssessment(x.h.service,runtime({onCall:()=>calls++}));
  assert.equal(second.disposition,'disabled');assert.equal(calls,1);
  assert.equal(x.h.store.get('SELECT COUNT(*) n FROM scout_model_requests').n,1);
});

for(const tamper of ['remove request marker','replace frozen model config']) test(`Hermes adapter rejects ${tamper} under enabled legacy globals before child dispatch`,async t=>{
  const x=await prepared(t);await request(x);
  x.h.config.scout.modelEnabled=true;x.h.config.opportunity.automatic=true;
  Object.assign(x.h.config.runtime,{enabled:false,model:'legacy-global-model',baseUrl:PROFILE_URL,provider:'custom',adapter:'hermes'});
  const adapter=new HermesAdapter(x.h.service,new Map());let childDispatches=0,guardRejected=false,guardCode=null;
  adapter.run=async()=>{childDispatches++;throw new Error('CHILD_DISPATCH_REACHED');};
  const runtime={decide:async(run,context)=>{
    assert.ok(x.h.store.get('SELECT id FROM scout_model_requests WHERE run_id=? AND partner_id=?',run.id,x.h.config.partnerId));
    const frozen=JSON.parse(run.context_json);
    if(tamper==='remove request marker') delete frozen.scout_assessment_request;
    else frozen.model_config={...frozen.model_config,model:'unreviewed-model-substitution'};
    run.context_json=JSON.stringify(frozen);
    x.h.store.run('UPDATE runs SET context_json=? WHERE id=?',run.context_json,run.id);
    try{await adapter.decide(run,context);}catch(error){
      guardCode=error?.code??error?.message??null;guardRejected=typeof error?.code==='string'&&error.code.startsWith('SCOUT_MODEL_REQUEST_');
    }
    return {completed:false,error:'MODEL_BLOCKED_BY_SCOPED_AUTHORITY',usage:{input_tokens:0,output_tokens:0}};
  }};
  const outcome=await processScoutAssessment(x.h.service,runtime);
  assert.equal(guardRejected,true,`boundary returned ${guardCode??'no scoped authority error'}`);assert.equal(childDispatches,0);
  assert.notEqual(outcome.disposition,'assessment_proposed');
  assert.equal(x.h.store.get('SELECT COUNT(*) n FROM scout_assessments').n,0);
});

test('one run is spent across restart and manual attempt/run reset; receipt failure never replays',async t=>{
  const x=await prepared(t),created=await request(x);let calls=0;
  const first=await processScoutAssessment(x.h.service,runtime({onCall:()=>calls++,result:{completed:false,usage:{input_tokens:4,output_tokens:2}}}));
  assert.notEqual(first.disposition,'assessment_proposed');assert.equal(calls,1);
  const job=x.h.store.get('SELECT * FROM scout_jobs WHERE id=?',created.job_id);
  assert.equal(job.attempts,1);x.h.restart();
  x.h.store.run("UPDATE scout_jobs SET status='queued',attempts=0,run_id=NULL,owner_id=NULL WHERE id=?",created.job_id);
  assert.equal((await processScoutAssessment(x.h.service,runtime({onCall:()=>calls++}))).disposition,'disabled');
  assert.equal(calls,1);

  const y=await prepared(t),failed=await request(y);let failCalls=0;
  const original=y.h.store.run.bind(y.h.store);let inject=true;
  y.h.store.run=(sql,...args)=>{if(inject&&String(sql).includes('INSERT INTO scout_assessments')){inject=false;throw new Error('synthetic receipt write failure');}return original(sql,...args);};
  await assert.rejects(processScoutAssessment(y.h.service,runtime({onCall:()=>failCalls++,result:{completed:true,final_response:JSON.stringify(successful),usage:{input_tokens:9,output_tokens:3}}})));
  y.h.store.run=original;
  assert.equal(failCalls,1);y.h.restart();
  assert.equal((await processScoutAssessment(y.h.service,runtime({onCall:()=>failCalls++}))).disposition,'disabled');
  assert.equal(failCalls,1);assert.equal(y.h.service.scoutReasoningFault,undefined);
  assert.equal(y.h.store.get('SELECT status FROM scout_jobs WHERE id=?',failed.job_id).status,'interrupted');
});

test('evidence references must be members of the sealed sample and never create customer-facing effects',async t=>{
  const x=await prepared(t);await request(x);
  const bad={...successful,evidence_refs:['missing'],opportunities:[{description:'Unsupported claim.',evidence_refs:['missing']}]};
  const outcome=await processScoutAssessment(x.h.service,runtime({result:{completed:true,final_response:JSON.stringify(bad),usage:{input_tokens:8,output_tokens:6}}}));
  assert.equal(outcome.disposition,'withheld');assert.equal(x.h.store.get('SELECT COUNT(*) n FROM scout_assessments').n,0);
  assert.equal(x.h.store.get('SELECT COUNT(*) n FROM drafts').n,0);
  assert.equal(x.h.store.get('SELECT COUNT(*) n FROM delivery_attempts').n,0);
});

test('scoped runtime receipt preserves the provider-served identity, not the configured model alias',async t=>{
  const x=await prepared(t);await request(x);
  const secret='sk-provider-raw-secret-must-never-persist';
  const outcome=await processScoutAssessment(x.h.service,runtime({result:{completed:true,final_response:JSON.stringify(successful),
    api_calls:1,model_identity:{model_id:'served-model-2026-10',model_version:'provider-build-17'},
    provider_raw:secret,debug_dump:secret,api_key:secret,usage:{input_tokens:18,output_tokens:9}}}));
  assert.equal(outcome.disposition,'assessment_proposed');
  const {run,result}=(()=>{const row=x.h.store.get("SELECT * FROM runs WHERE runtime='hermes-scout-v1'");return {run:row,result:JSON.parse(row.result_json)};})();
  assert.equal(run.model,'offline-scoped-model','configured profile alias remains separate from served identity');
  assert.deepEqual(result.runtime_receipt,{api_calls:1,api_call_scope:'worker_httpx_generation_requests',
    proxy_internal_retries:'unknown',model_identity:{model_id:'served-model-2026-10',model_version:'provider-build-17'}});
  assert.equal(JSON.stringify(result).includes(secret),false);
});

for(const [label,override] of [
  ['missing call count',{api_calls:undefined}],
  ['invalid call count',{api_calls:true}],
  ['excess call count',{api_calls:2}],
  ['missing identity',{model_identity:undefined}],
  ['malformed identity',{model_identity:{model_id:'configured-or-hostile identity',model_version:'v1'}}],
  ['projects valid identity despite extra fields',{model_identity:{model_id:'served-model',model_version:'v1',provider_raw:'provider secret must not persist'}}],
]) test(`scoped runtime receipt leaves ${label} unknown and drops provider raw fields`,async t=>{
  const x=await prepared(t);await request(x);const secret='provider raw secret must not persist';
  const result={completed:true,final_response:JSON.stringify(successful),api_calls:1,
    model_identity:{model_id:'served-model',model_version:'v1'},provider_raw:secret,debug_dump:secret,
    usage:{input_tokens:5,output_tokens:3},...override};
  const outcome=await processScoutAssessment(x.h.service,runtime({result}));
  assert.equal(outcome.disposition,'assessment_proposed');
  const receipt=JSON.parse(x.h.store.get("SELECT result_json FROM runs WHERE runtime='hermes-scout-v1'").result_json).runtime_receipt;
  if(Object.hasOwn(override,'api_calls')) assert.equal(receipt.api_calls,null);
  if(Object.hasOwn(override,'model_identity')) {
    const identity=override.model_identity;
    const expected=identity&&/^[A-Za-z0-9._:+/\\-]{1,160}$/.test(identity.model_id??'')
      &&identity.model_version!==undefined&& (identity.model_version===null||/^[A-Za-z0-9._:+/\\-]{1,160}$/.test(identity.model_version))
      ?{model_id:identity.model_id,model_version:identity.model_version}:null;
    assert.deepEqual(receipt.model_identity,expected);
  }
  assert.equal(JSON.stringify(receipt).includes(secret),false);
  assert.equal(JSON.stringify(receipt).includes('provider_raw'),false);
});
