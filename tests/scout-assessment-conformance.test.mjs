import test from 'node:test';
import assert from 'node:assert/strict';
import { processScoutAssessment } from '../business/scout-reasoning.mjs';
import { SCOUT_EVALUATOR_VERSION } from '../business/scout.mjs';
import { id } from '../business/store.mjs';
import { message, noHistory, scoutHarness } from './scout-test-helpers.mjs';

const validOutput = (refs=['1']) => ({
  recommendation:'consider', reason:'The bounded source sample contains a relevant discussion.',
  evidence_refs:refs, opportunities:[{description:'Review the discussion with the operator.',evidence_refs:[refs[0]??'1']}],
  uncertainty:['The bounded sample does not establish continuing demand.']
});

async function prepared(t,{text='A bounded synthetic source statement for operator review.'}={}) {
  const prior=process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY='offline-scout-conformance-key';
  t.after(()=>{if(prior===undefined)delete process.env.PARTNER_MODEL_API_KEY;else process.env.PARTNER_MODEL_API_KEY=prior;});
  const h=scoutHarness(t,{modelEnabled:true,history:input=>input.before_id?noHistory(input):{
    empty:false,requested_count:input.limit,received_count:1,oldest_id:1,messages:[message('1',{text})]
  }});
  h.config.runtime.model='offline-scout-conformance';
  h.config.runtime.baseUrl='http://127.0.0.1:1/v1';
  h.config.runtime.provider='custom';
  h.config.runtime.adapter='hermes';
  const campaign=await h.campaign('Synthetic assessment topic');
  await h.authorize(campaign);
  const candidate=await h.seed(campaign);
  const sample=await h.auditAndSeal(campaign,candidate);
  await h.command('scout.request_assessment',{campaign_id:campaign.id,revision:campaign.revision,candidate_id:candidate.id,sample_id:sample.id});
  const job=h.store.get("SELECT * FROM scout_jobs WHERE campaign_id=? AND kind='assessment'",campaign.id);
  return {h,campaign,candidate,sample,job};
}

async function assess(t,result,options={}) {
  const x=await prepared(t,options);
  const outcome=await processScoutAssessment(x.h.service,{decide:async(_run,context)=>{
    assert.equal(context.packet.contact_permission,false);
    assert.equal(context.packet.campaign.topic,'Synthetic assessment topic');
    return typeof result==='function'?result(context):result;
  }});
  return {...x,outcome};
}

function latestRun(h) { return h.store.get("SELECT * FROM runs WHERE runtime='hermes-scout-v1' ORDER BY created_at DESC LIMIT 1"); }

test('accepts a valid plain JSON assessment and records only the proposed assessment receipt',async t=>{
  const {h,campaign,candidate,outcome}=await assess(t,{completed:true,final_response:JSON.stringify(validOutput()),tool_calls:[],usage:{input_tokens:31,output_tokens:17}});
  assert.equal(outcome.disposition,'assessment_proposed');
  assert.equal(outcome.reason,'SCOUT_ASSESSMENT_PROPOSED');
  assert.equal(outcome.diagnostic,null);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM scout_assessments WHERE campaign_id=? AND status='proposed'",campaign.id).n,1);
  const run=latestRun(h);assert.equal(run.status,'completed');assert.equal(run.input_tokens,31);assert.equal(run.output_tokens,17);
  assert.equal(JSON.parse(run.result_json).diagnostic,null);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM scout_jobs WHERE campaign_id=? AND kind='assessment' AND status='completed'",campaign.id).n,1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM drafts').n,0);
  assert.ok(candidate.id);
});

test('classifies provider incomplete/error outcomes and persists only a safe normalized cause',async t=>{
  const hostile='provider-secret-DO-NOT-PERSIST';
  const {h,campaign,outcome}=await assess(t,{completed:false,error:hostile,failure_cause:hostile,debug_dump:hostile,final_response:hostile,usage:{input_tokens:9,output_tokens:4}});
  assert.equal(outcome.reason,'SCOUT_OUTPUT_INVALID');
  assert.equal(outcome.diagnostic.stage,'model');assert.equal(outcome.diagnostic.code,'SCOUT_MODEL_INCOMPLETE');
  assert.equal(outcome.diagnostic.failure_cause.kind,'worker_failure');
  const run=latestRun(h);assert.equal(run.status,'failed');assert.equal(run.input_tokens,9);assert.equal(run.output_tokens,4);
  assert.equal(JSON.parse(run.result_json).diagnostic.code,'SCOUT_MODEL_INCOMPLETE');
  assert.equal(h.store.get("SELECT status FROM scout_jobs WHERE campaign_id=? AND kind='assessment'",campaign.id).status,'failed');
  const serialized=JSON.stringify({outcome,run:run.result_json,job:h.service.scout.presentation(h.service.scout.campaign(campaign.id)).jobs});
  assert.equal(serialized.includes(hostile),false);
});

test('rejects tool calls and tool-bearing message envelopes before parsing their text',async t=>{
  for(const result of [
    {completed:true,final_response:JSON.stringify(validOutput()),tool_calls:[{id:'x',function:{arguments:'opaque'}}]},
    {completed:true,final_response:JSON.stringify(validOutput()),tool_calls:{malformed:true}},
    {completed:true,final_response:JSON.stringify(validOutput()),messages:[{role:'assistant',tool_calls:[{function:{name:'hidden'}}]}]},
    {completed:true,final_response:JSON.stringify(validOutput()),messages:[{role:'assistant',tool_calls:{malformed:true}}]},
    {completed:true,final_response:JSON.stringify(validOutput()),messages:[{role:'assistant',function_call:false}]},
    {completed:true,final_response:JSON.stringify(validOutput()),messages:[{role:'tool',content:'opaque'}]}
  ]) {
    const {h,campaign,outcome}=await assess(t,result);
    assert.equal(outcome.reason,'SCOUT_OUTPUT_INVALID');
    assert.deepEqual({stage:outcome.diagnostic.stage,code:outcome.diagnostic.code},{stage:'envelope',code:'SCOUT_TOOLS_FORBIDDEN'});
    assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_assessments WHERE campaign_id=?',campaign.id).n,0);
  }
});

test('rejects non-text responses and content beyond the UTF-8 byte ceiling',async t=>{
  const nonText=await assess(t,{completed:true,final_response:{text:JSON.stringify(validOutput())}});
  assert.equal(nonText.outcome.reason,'SCOUT_OUTPUT_INVALID');
  assert.equal(nonText.outcome.diagnostic.stage,'format');
  assert.equal(nonText.outcome.diagnostic.code,'SCOUT_OUTPUT_NOT_TEXT');
  const largeOutput={...validOutput(),reason:'é'.repeat(2000),
    opportunities:Array.from({length:5},()=>({description:'é'.repeat(1000),evidence_refs:['1']})),
    uncertainty:Array.from({length:10},()=> 'é'.repeat(500))};
  const largeJSON=JSON.stringify(largeOutput);
  assert.ok(largeJSON.length<24000&&Buffer.byteLength(largeJSON)>24000);
  const tooLarge=await assess(t,{completed:true,final_response:largeJSON});
  assert.equal(tooLarge.outcome.reason,'SCOUT_OUTPUT_INVALID');
  assert.equal(tooLarge.outcome.diagnostic.code,'SCOUT_OUTPUT_TOO_LARGE');
  assert.equal(tooLarge.h.store.get('SELECT COUNT(*) n FROM scout_assessments').n,0);
});

test('distinguishes markdown-fenced JSON from other malformed JSON without retaining the response',async t=>{
  for(const [response,code] of [
    ['```json\n'+JSON.stringify(validOutput())+'\n```','SCOUT_JSON_MARKDOWN_FENCE'],
    ['{this is not json; private-response-fragment}','SCOUT_JSON_INVALID']
  ]) {
    const {h,outcome}=await assess(t,{completed:true,final_response:response,usage:{input_tokens:2,output_tokens:3}});
    assert.equal(outcome.reason,'SCOUT_OUTPUT_INVALID');assert.equal(outcome.diagnostic.code,code);assert.equal(outcome.diagnostic.stage,'format');
    assert.equal(latestRun(h).output_tokens,3);
    const persisted=JSON.stringify({result:latestRun(h).result_json,jobs:h.service.scout.presentation(h.service.scout.campaign(h.store.get("SELECT campaign_id FROM scout_jobs WHERE kind='assessment'").campaign_id)).jobs});
    assert.equal(persisted.includes('private-response-fragment'),false);
  }
});

test('reports schema failure with a bounded safe keyword list, never echoing invalid fields',async t=>{
  const invalid={...validOutput(),recommendation:'sensitive-enum-value',private_field:'schema-payload-secret'};
  const {h,campaign,outcome}=await assess(t,{completed:true,final_response:JSON.stringify(invalid)});
  assert.equal(outcome.reason,'SCOUT_OUTPUT_INVALID');
  assert.equal(outcome.diagnostic.stage,'schema');assert.equal(outcome.diagnostic.code,'SCOUT_SCHEMA_INVALID');
  assert.ok(Array.isArray(outcome.diagnostic.schema_keywords));
  assert.equal(JSON.stringify(outcome.diagnostic).includes('sensitive-enum-value'),false);
  assert.equal(JSON.stringify(outcome.diagnostic).includes('schema-payload-secret'),false);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_assessments WHERE campaign_id=?',campaign.id).n,0);
});

test('preserves the known evidence failure reasons for unknown and missing consider references',async t=>{
  const unknown=await assess(t,{completed:true,final_response:JSON.stringify(validOutput(['999']))});
  assert.equal(unknown.outcome.reason,'SCOUT_EVIDENCE_INVALID');
  assert.equal(unknown.outcome.diagnostic.stage,'evidence');
  const missingOutput=validOutput([]);missingOutput.recommendation='consider';
  const missing=await assess(t,{completed:true,final_response:JSON.stringify(missingOutput)});
  assert.equal(missing.outcome.reason,'SCOUT_EVIDENCE_REQUIRED');
  assert.equal(missing.outcome.diagnostic.code,'SCOUT_EVIDENCE_REQUIRED');
});

test('projects a safe failure diagnosis after restart and does not schedule an automatic retry',async t=>{
  const {h,campaign,outcome}=await assess(t,{completed:true,final_response:'{broken}' });
  assert.equal(outcome.reason,'SCOUT_OUTPUT_INVALID');
  h.restart();
  const presentation=h.service.scout.presentation(h.service.scout.campaign(campaign.id));
  const job=presentation.jobs.find(x=>x.kind==='assessment');
  assert.equal(job.status,'failed');assert.equal(job.diagnostic.code,'SCOUT_JSON_INVALID');
  assert.equal(h.store.get("SELECT COUNT(*) n FROM scout_jobs WHERE campaign_id=? AND kind='assessment' AND status IN ('queued','running')",campaign.id).n,0);
  const run=latestRun(h);assert.equal(JSON.stringify(run.result_json).includes('{broken}'),false);
});

test('revoked assessment authority while inference is pending overrides any output diagnosis and applies no effects',async t=>{
  const x=await prepared(t);let begin,release;
  const started=new Promise(resolve=>{begin=resolve;});const pending=new Promise(resolve=>{release=resolve;});
  const processing=processScoutAssessment(x.h.service,{decide:async()=>{begin();await pending;return {completed:true,final_response:'not json',usage:{input_tokens:6,output_tokens:7}};}});
  await started;
  const auditGrant=x.h.store.get("SELECT id FROM scout_grants WHERE campaign_id=? AND kind='audit'",x.campaign.id).id;
  await x.h.command('scout.revoke',{campaign_id:x.campaign.id,revision:x.campaign.revision,grant_id:auditGrant});
  release();const outcome=await processing;
  assert.equal(outcome.reason,'SCOUT_RESULT_RETIRED');assert.equal(outcome.diagnostic,null);
  assert.equal(x.h.store.get('SELECT COUNT(*) n FROM scout_assessments WHERE campaign_id=?',x.campaign.id).n,0);
  const run=latestRun(x.h);assert.equal(run.input_tokens,6);assert.equal(run.output_tokens,7);
  assert.equal(JSON.parse(run.result_json).diagnostic,null);
  assert.equal(x.h.store.get("SELECT status FROM scout_jobs WHERE id=?",x.job.id).status,'stale');
  for(const table of ['drafts','approvals','delivery_attempts','outcome_events'])
    assert.equal(x.h.store.get(`SELECT COUNT(*) n FROM ${table}`).n,0,table);
});

test('a thrown provider error preserves its closed failure cause without persisting exception text',async t=>{
  const {h,outcome}=await assess(t,()=>{
    const error=new Error('private-provider-exception');
    error.failure_cause={kind:'provider_error',http_status:429,provider_error_type:'rate_limit',retryable:true,
      attempt_count:2,raw_response:'private-provider-payload',api_key:'private-credential'};
    throw error;
  });
  assert.equal(outcome.diagnostic.failure_cause.kind,'provider_error');
  assert.equal(outcome.diagnostic.failure_cause.http_status,429);
  assert.equal(outcome.diagnostic.failure_cause.attempt_count,2);
  assert.equal(latestRun(h).cost_status,'unknown');
  assert.doesNotMatch(latestRun(h).result_json,/private-provider|private-credential/);
});

test('old evaluator jobs are stale before any billable invocation',async t=>{
  const x=await prepared(t);
  const cursor=JSON.parse(x.job.cursor_json);cursor.evaluator_version='scout-assessment-v1';
  assert.notEqual(cursor.evaluator_version,SCOUT_EVALUATOR_VERSION);
  x.h.store.run('UPDATE scout_jobs SET cursor_json=? WHERE id=?',JSON.stringify(cursor),x.job.id);
  let calls=0;
  await processScoutAssessment(x.h.service,{decide:async()=>{calls++;return {completed:true,final_response:JSON.stringify(validOutput())};}});
  assert.equal(calls,0);
  assert.equal(x.h.store.get('SELECT status,reason FROM scout_jobs WHERE id=?',x.job.id).status,'stale');
  assert.equal(x.h.store.get('SELECT reason FROM scout_jobs WHERE id=?',x.job.id).reason,'SCOUT_ASSESSMENT_STALE');
  assert.equal(x.h.store.get('SELECT COUNT(*) n FROM runs').n,0);
});

test('reconciliation retires old or corrupt evaluator cursors even with billing disabled, preserving the healthy neighbor',async t=>{
  const x=await prepared(t),cursor=JSON.parse(x.job.cursor_json);
  cursor.evaluator_version='scout-assessment-v1';
  x.h.store.run('UPDATE scout_jobs SET cursor_json=? WHERE id=?',JSON.stringify(cursor),x.job.id);
  for(const topic of ['Healthy evaluator neighbor','Corrupt evaluator cursor']){
    const c=await x.h.campaign(topic);await x.h.authorize(c);const candidate=await x.h.seed(c);
    await x.h.command('scout.request_assessment',{campaign_id:c.id,revision:c.revision,candidate_id:candidate.id,sample_id:x.sample.id});
    if(topic.startsWith('Corrupt'))x.h.store.run("UPDATE scout_jobs SET cursor_json='not JSON' WHERE campaign_id=? AND kind='assessment'",c.id);
  }
  x.h.config.scout.modelEnabled=false;
  x.h.service.scout.reconcile();
  const jobs=x.h.store.all("SELECT j.status,j.reason,c.topic FROM scout_jobs j JOIN scout_campaigns c ON c.id=j.campaign_id WHERE j.kind='assessment'");
  assert.equal(jobs.find(j=>j.topic==='Healthy evaluator neighbor').status,'queued');
  for(const job of jobs.filter(j=>j.topic!=='Healthy evaluator neighbor')){
    assert.equal(job.status,'stale');
    assert.equal(job.reason,job.topic.startsWith('Corrupt')?'SCOUT_RECORD_INVALID':'SCOUT_ASSESSMENT_STALE');
  }
  assert.equal(x.h.store.get('SELECT COUNT(*) n FROM runs').n,0);
});

test('evaluator upgrade invalidates old advice without revoking independently granted monitoring',async t=>{
  const {h,campaign,candidate,sample,outcome}=await assess(t,{completed:true,final_response:JSON.stringify(validOutput())});
  await h.command('scout.review',{campaign_id:campaign.id,revision:campaign.revision,assessment_id:outcome.assessment_id,
    decision:'approve',note:'Explicit operator review of this synthetic assessment'});
  const admitted=await h.command('scout.admit',{campaign_id:campaign.id,revision:campaign.revision,candidate_id:candidate.id,
    sample_id:sample.id,assessment_id:outcome.assessment_id,purpose:'Explicit test source monitoring',max_lag_seconds:300,
    expires_at:new Date(Date.now()+86400000).toISOString()});
  assert.equal(h.service.scout.monitorAuthorityPolicies().length,1);
  const run=latestRun(h),context=JSON.parse(run.context_json);
  assert.equal(context.evaluator_version,SCOUT_EVALUATOR_VERSION);
  assert.deepEqual(context.campaign_config,JSON.parse(h.service.scout.campaign(campaign.id).config_json));
  assert.match(context.instructions_digest,/^[0-9a-f]{64}$/);
  assert.match(context.output_contract_digest,/^[0-9a-f]{64}$/);
  // Recreate a persisted pre-upgrade receipt/grant link. Assessment provenance
  // is immutable; production must never rewrite an old receipt into version 2.
  const legacyId=id();
  h.store.run("INSERT INTO scout_assessments(id,campaign_id,campaign_revision,candidate_id,sample_id,sample_digest,topic_hash,evaluator_version,output_json,run_id,status,created_at) SELECT ?,campaign_id,campaign_revision,candidate_id,sample_id,sample_digest,topic_hash,'scout-assessment-v1',output_json,run_id,'approved',created_at FROM scout_assessments WHERE id=?",legacyId,outcome.assessment_id);
  const grant={...h.store.get('SELECT * FROM scout_grants WHERE id=?',admitted.grant_id),id:id(),assessment_id:legacyId};
  await h.command('scout.revoke',{campaign_id:campaign.id,revision:campaign.revision,grant_id:admitted.grant_id});
  h.store.run(`INSERT INTO scout_grants(${Object.keys(grant).join(',')}) VALUES(${Object.keys(grant).map(()=>'?').join(',')})`,...Object.values(grant));
  const before=h.service.scout.monitorAuthorityPolicies();assert.equal(before.length,1);
  h.restart();
  const presentation=h.service.scout.presentation(h.service.scout.campaign(campaign.id));
  assert.equal(presentation.candidates[0].assessment.status,'stale');
  assert.equal(presentation.candidates[0].monitor_grant.id,grant.id);
  assert.equal(presentation.candidates[0].monitor_grant.current,true);
  assert.deepEqual(h.service.scout.monitorAuthorityPolicies(),before);
});

test('receipt projection closes malformed persisted diagnostics and ignores arbitrary provider fields',async t=>{
  const {h,campaign}=await assess(t,{completed:true,final_response:'{broken}'});
  const run=latestRun(h);
  const projection=()=>h.service.scout.presentation(h.service.scout.campaign(campaign.id)).jobs.find(j=>j.kind==='assessment');
  for(const diagnostic of [{stage:'format',code:'constructor'},{stage:'schema',code:'SCOUT_JSON_INVALID'},null]) {
    h.store.run('UPDATE runs SET result_json=? WHERE id=?',JSON.stringify({diagnostic,raw_response:'private-raw-text'}),run.id);
    assert.equal(projection().diagnostic,null);
    assert.doesNotMatch(JSON.stringify(projection()),/private-raw-text/);
  }
  h.store.run('UPDATE runs SET result_json=? WHERE id=?',JSON.stringify({diagnostic:{stage:'schema',code:'SCOUT_SCHEMA_INVALID',
    schema_keywords:['additionalProperties','private-property',null,'additionalProperties'],raw_response:'private-raw-text'}}),run.id);
  assert.deepEqual(projection().diagnostic,{stage:'schema',code:'SCOUT_SCHEMA_INVALID',schema_keywords:['additionalProperties']});
  h.store.run('UPDATE runs SET result_json=? WHERE id=?','malformed persisted JSON',run.id);
  assert.equal(projection().diagnostic,null);
});
