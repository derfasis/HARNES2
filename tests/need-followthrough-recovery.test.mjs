// Durable recovery and receipt-boundary tests for focused Audience follow-through.
// Every provider response is synthetic; no network or credentialed client is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { audienceHarness, SOURCE, SOURCE_B, modelOutputFrom, proposalFrom } from './audience-test-helpers.mjs';
import { processAudienceAssessment } from '../business/audience-reasoning.mjs';

const PROFILE_URL = 'https://models.followthrough-recovery.example.test/v1';
const RUNTIME = 'hermes-audience-v1';

function setup(t) {
  t.mock.timers.enable({ apis:['Date'], now:new Date('2026-01-01T00:30:00.000Z') });
  const previous=process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY='synthetic-recovery-test-key-never-sent';
  t.after(()=>previous===undefined?delete process.env.PARTNER_MODEL_API_KEY:process.env.PARTNER_MODEL_API_KEY=previous);
  const h=audienceHarness(t);
  Object.assign(h.config.runtime,{enabled:false,baseUrl:'',model:'',dailyBudgetUsd:null,maxRunsPerDay:50});
  h.config.audience.enabled=true; h.config.audience.modelEnabled=false; h.config.audience.maxRunsPerDay=20;
  h.config.modelProfiles={allowedBaseUrls:[PROFILE_URL]};
  h.config.controlPlane.enabled=true; h.config.controlPlane.maxConcurrent=3;
  return h;
}

async function seedAccepted(h,name='recovery') {
  const goal=await h.open({title:`Synthetic ${name}`,objective:'Continue one accepted need from new support.',source_ids:[SOURCE],max_age_seconds:3600});
  await h.ingest({message_id:`${name}-old`,thread_id:`${name}-old-thread`,text:'A synthetic question establishes the original need.'});
  h.service.audience.reconcile({limit:10});
  const packet=h.service.audience.detail(goal.goal_id);
  const capture=await h.command('audience.capture',{goal_id:goal.goal_id,expected_revision:packet.revision,
    expected_basis_fingerprint:packet.basis_fingerprint});
  const assessment=h.service.audience.assessment(capture.assessment_id);
  const proposal=await h.command('audience.propose',{assessment_id:assessment.id,output:proposalFrom(assessment.packet)});
  let need=h.service.audience.need(proposal.need_ids[0]);
  await h.command('audience.review',{need_id:need.id,expected_revision:need.revision,
    expected_basis_fingerprint:need.basis_fingerprint,decision:'accept',note:'Synthetic initial review.'});
  need=h.service.audience.need(need.id);
  await h.ingest({message_id:`${name}-fresh`,thread_id:`${name}-fresh-thread`,text:'A new current observation supports a focused reassessment.'});
  h.service.audience.reconcile({limit:10});
  return {goal,need};
}

async function profile(h,label='Recovery profile') {
  return h.command('model.profile_create',{label,provider:'custom',api_mode:'chat_completions',base_url:PROFILE_URL,
    model:'synthetic-recovery-model',max_output_tokens:900,input_usd_per_million:2,output_usd_per_million:3});
}

async function request(h,need,selected,ttlMs=60*60*1000) {
  const context=h.service.followup.context(need.id);
  assert.equal(context.available,true,JSON.stringify({reasons:context.reasons}));
  return h.command('audience.followup_request',{need_id:need.id,expected_revision:context.need_revision,
    expected_basis_fingerprint:context.need_basis_fingerprint,expected_context_fingerprint:context.context_fingerprint,
    model_profile_id:selected.profile_id,expected_profile_hash:selected.definition_hash,
    expires_at:new Date(Date.now()+ttlMs).toISOString(),reason:'One finite synthetic follow-up.'});
}

function goodRuntime(calls=[],before=async()=>{}) {
  return {decide:async(run,context)=>{
    calls.push({run:structuredClone(run),context:structuredClone(context)});
    await before(run,context);
    const out=proposalFrom(context.packet,{need_id:context.packet.followup.need_id,
      title:'Synthetic fresh follow-up',hypothesis:'The current observation supports this narrow continuation.',
      why_now:'Only the newly supplied event supports the continuation.',reason:'Synthetic recovery fixture.'});
    return {completed:true,final_response:JSON.stringify(modelOutputFrom(context.packet,out)),
      usage:{input_tokens:41,output_tokens:17},model_identity:{model_id:'synthetic-recovery-model',model_version:'fixture-v1'},api_calls:1};
  }};
}

test('tampered captured packet is withheld before provider dispatch',async t=>{
  const h=setup(t),{need}=await seedAccepted(h,'tampered-captured'),selected=await profile(h),req=await request(h,need,selected);
  const row=h.store.get('SELECT packet_json FROM audience_assessments WHERE id=?',req.assessment_id),packet=JSON.parse(row.packet_json);
  packet.exchanges[0].evidence[0].text='tampered after owner confirmation';
  h.store.run('UPDATE audience_assessments SET packet_json=? WHERE id=?',JSON.stringify(packet),req.assessment_id);
  let calls=0;
  await processAudienceAssessment(h.service,{decide:async()=>{calls++;throw new Error('tampered packet must not dispatch');}});
  assert.equal(calls,0);
  assert.equal(h.service.audience.assessment(req.assessment_id).status,'stale');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_followup_attempts WHERE request_id=?',req.request_id).n,0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs WHERE runtime=?',RUNTIME).n,0);
});

test('TTL before admission retires the captured request without a run or attempt',async t=>{
  const h=setup(t),{need}=await seedAccepted(h,'ttl-before'),selected=await profile(h),req=await request(h,need,selected,1000);
  t.mock.timers.tick(1001);
  let calls=0;
  await processAudienceAssessment(h.service,{decide:async()=>{calls++;throw new Error('expired request must not dispatch');}});
  assert.equal(calls,0);
  assert.equal(h.service.followup.detail(req.request_id).state,'expired');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_followup_attempts WHERE request_id=?',req.request_id).n,0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs WHERE runtime=?',RUNTIME).n,0);
});

test('TTL during provider turn withholds output but keeps the admitted attempt and usage',async t=>{
  const h=setup(t),{need}=await seedAccepted(h,'ttl-during'),selected=await profile(h),req=await request(h,need,selected,1000);
  let calls=0;
  const result=await processAudienceAssessment(h.service,goodRuntime([],async()=>{calls++;t.mock.timers.tick(1001);}));
  assert.equal(calls,1);
  assert.notEqual(result.disposition,'proposal_created');
  const attempt=h.store.get('SELECT * FROM audience_followup_attempts WHERE request_id=?',req.request_id);
  assert.ok(attempt);
  const run=h.store.get('SELECT * FROM runs WHERE id=?',attempt.run_id);
  assert.equal(run.input_tokens,41); assert.equal(run.output_tokens,17);
  assert.equal(h.service.audience.need(need.id).status,'accepted');
});

test('crash after run admission and before a provider result cannot rebill after restart',async t=>{
  const h=setup(t),{need}=await seedAccepted(h,'crash-after-admission'),selected=await profile(h),req=await request(h,need,selected);
  let calls=0;
  await assert.rejects(processAudienceAssessment(h.service,{decide:async()=>{calls++;h.restart();throw new Error('synthetic process loss before result');}}));
  assert.equal(calls,1);
  const attempt=h.store.get('SELECT * FROM audience_followup_attempts WHERE request_id=?',req.request_id);
  assert.ok(attempt,'admission committed before the fake runtime entered');
  assert.equal(h.store.get('SELECT status FROM runs WHERE id=?',attempt.run_id).status,'interrupted');
  assert.equal(h.service.audience.assessment(req.assessment_id).status,'interrupted');
  let resumedCalls=0;
  await processAudienceAssessment(h.service,{decide:async()=>{resumedCalls++;throw new Error('consumed request must not resume');}});
  assert.equal(resumedCalls,0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_followup_attempts WHERE request_id=?',req.request_id).n,1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs WHERE runtime=?',RUNTIME).n,1);
});

test('captured unspent request survives restart and runs once',async t=>{
  const h=setup(t),{need}=await seedAccepted(h,'captured-restart'),selected=await profile(h),req=await request(h,need,selected);
  h.restart();
  assert.equal(h.service.followup.detail(req.request_id).assessment_status,'captured');
  const calls=[],result=await processAudienceAssessment(h.service,goodRuntime(calls));
  assert.equal(result.disposition,'proposal_created');
  assert.equal(calls.length,1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_followup_attempts WHERE request_id=?',req.request_id).n,1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs WHERE runtime=?',RUNTIME).n,1);
});

test('durable result persistence failure rolls back proposal and cannot rebill after restart',async t=>{
  const h=setup(t),{need}=await seedAccepted(h,'receipt-persist-failure'),selected=await profile(h),req=await request(h,need,selected);
  const original={revision:need.revision,status:need.status,basis_fingerprint:need.basis_fingerprint};
  h.store.db.exec(`CREATE TRIGGER injected_followup_result_failure BEFORE UPDATE OF result_json ON runs
    WHEN NEW.runtime='${RUNTIME}' AND NEW.status='completed' BEGIN SELECT RAISE(ABORT,'synthetic receipt persistence failure'); END`);
  let calls=0;
  await assert.rejects(processAudienceAssessment(h.service,goodRuntime([],async()=>{calls++;})));
  assert.equal(calls,1);
  assert.deepEqual(((n)=>({revision:n.revision,status:n.status,basis_fingerprint:n.basis_fingerprint}))(h.service.audience.need(need.id)),original,
    'the proposal and need revision roll back with the failed durable receipt');
  const attempt=h.store.get('SELECT * FROM audience_followup_attempts WHERE request_id=?',req.request_id);
  assert.ok(attempt);
  const interrupted=h.store.get('SELECT * FROM runs WHERE id=?',attempt.run_id);
  assert.equal(interrupted.status,'interrupted');
  assert.equal(interrupted.error,'RESULT_PERSIST_FAILED');
  assert.equal(interrupted.result_json,null,'a failed durable receipt leaves no completed proof');
  assert.equal(interrupted.input_tokens,41);
  assert.equal(interrupted.output_tokens,17);
  assert.equal(interrupted.cost_status,'configured_estimate');
  assert.ok(Math.abs(interrupted.estimated_cost_usd-((41*2+17*3)/1e6))<1e-12);
  h.store.db.exec('DROP TRIGGER injected_followup_result_failure');
  h.restart();
  let retries=0;
  await processAudienceAssessment(h.service,{decide:async()=>{retries++;throw new Error('persist failure cannot rebill');}});
  assert.equal(retries,0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_followup_attempts WHERE request_id=?',req.request_id).n,1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs WHERE runtime=?',RUNTIME).n,1);
});

test('profile definition tampering prevents captured request dispatch',async t=>{
  const h=setup(t),{need}=await seedAccepted(h,'profile-corrupt-before'),selected=await profile(h),req=await request(h,need,selected);
  const row=h.store.get('SELECT definition_json FROM model_profiles WHERE id=?',selected.profile_id),definition=JSON.parse(row.definition_json);
  definition.model='retargeted-after-capture';
  h.store.run('UPDATE model_profiles SET definition_json=? WHERE id=?',JSON.stringify(definition),selected.profile_id);
  let calls=0;
  await processAudienceAssessment(h.service,{decide:async()=>{calls++;throw new Error('corrupt immutable profile must not dispatch');}});
  assert.equal(calls,0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_followup_attempts WHERE request_id=?',req.request_id).n,0);
  assert.notEqual(h.service.audience.assessment(req.assessment_id).status,'proposed');
});

test('retargeting frozen run model configuration during a turn withholds its output and retains usage',async t=>{
  const h=setup(t),{need}=await seedAccepted(h,'run-retarget'),selected=await profile(h),req=await request(h,need,selected);
  let calls=0;
  const result=await processAudienceAssessment(h.service,goodRuntime([],async run=>{
    calls++;
    const frozen=JSON.parse(run.context_json);
    frozen.model_config.model='unapproved-retargeted-model';
    run.context_json=JSON.stringify(frozen);
    h.store.run('UPDATE runs SET context_json=? WHERE id=?',run.context_json,run.id);
  }));
  assert.equal(calls,1);
  assert.notEqual(result.disposition,'proposal_created');
  const attempt=h.store.get('SELECT * FROM audience_followup_attempts WHERE request_id=?',req.request_id);
  const run=h.store.get('SELECT * FROM runs WHERE id=?',attempt.run_id);
  assert.equal(run.input_tokens,41); assert.equal(run.output_tokens,17);
  assert.equal(h.service.audience.need(need.id).status,'accepted');
});

test('changing the frozen packet in the admitted run context cannot apply a result',async t=>{
  const h=setup(t),{need}=await seedAccepted(h,'run-packet-tamper'),selected=await profile(h),req=await request(h,need,selected);
  let calls=0;
  const result=await processAudienceAssessment(h.service,goodRuntime([],async run=>{
    calls++;
    const frozen=JSON.parse(run.context_json);
    frozen.packet.exchanges[0].evidence[0].text='changed after the model input was frozen';
    h.store.run('UPDATE runs SET context_json=? WHERE id=?',JSON.stringify(frozen),run.id);
  }));
  assert.equal(calls,1);
  assert.notEqual(result.disposition,'proposal_created');
  const attempt=h.store.get('SELECT * FROM audience_followup_attempts WHERE request_id=?',req.request_id);
  const run=h.store.get('SELECT * FROM runs WHERE id=?',attempt.run_id);
  assert.equal(run.input_tokens,41); assert.equal(run.output_tokens,17);
  assert.equal(h.service.audience.need(need.id).status,'accepted');
});

test('an observation-head-only context change blocks a focused result',async t=>{
  const h=setup(t),{need}=await seedAccepted(h,'observation-head-fingerprint'),selected=await profile(h),req=await request(h,need,selected);
  let calls=0,callbackError;
  const result=await processAudienceAssessment(h.service,goodRuntime([],async(_run,context)=>{
    calls++;
    try {
      await h.ingest({message_id:'late-unsupported',thread_id:'late-unsupported',operation:'unsupported',text:null,
        unsupported:{reason:'private_media',fingerprint:'a'.repeat(64)}});
      h.service.audience.reconcile({limit:10});
    } catch(error) { callbackError=error; }
  }));
  assert.equal(calls,1);
  assert.equal(callbackError,undefined,callbackError?.stack);
  assert.notEqual(result.disposition,'proposal_created');
  const after=h.service.audience.need(need.id);
  assert.equal(after.revision,need.revision);
  assert.equal(after.status,'accepted');
  const attempt=h.store.get('SELECT * FROM audience_followup_attempts WHERE request_id=?',req.request_id);
  const run=h.store.get('SELECT * FROM runs WHERE id=?',attempt.run_id);
  assert.equal(run.input_tokens,41); assert.equal(run.output_tokens,17);
});

test('injected temporary transport-health loss keeps captured authority pending until health returns',async t=>{
  const h=setup(t),{need}=await seedAccepted(h,'temporary-health'),selected=await profile(h),req=await request(h,need,selected);
  let current=false;
  const originalHealth=h.service.continuity.health;
  h.service.continuity.health=function(watch) {
    return current ? originalHealth.call(this,watch) : {current:false,reason:'SOURCE_TRANSPORT_NOT_CURRENT'};
  };
  t.after(()=>{ h.service.continuity.health=originalHealth; });
  const unavailable=h.service.followup.context(need.id);
  assert.equal(unavailable.available,false);
  assert.ok(unavailable.reasons.includes('SOURCE_TRANSPORT_NOT_CURRENT'));
  assert.equal(h.service.audience.assessment(req.assessment_id).current,false,
    'the captured assessment is not current while its observed transport health is down');
  h.service.followup.reconcile(need.goal_id);
  assert.equal(h.service.audience.assessment(req.assessment_id).status,'captured',
    'temporary health loss does not retire an unspent request');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_followup_attempts WHERE request_id=?',req.request_id).n,0);
  current=true;
  const calls=[],result=await processAudienceAssessment(h.service,goodRuntime(calls));
  assert.equal(result.disposition,'proposal_created');
  assert.equal(calls.length,1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_followup_attempts WHERE request_id=?',req.request_id).n,1);
});

test('temporary loss on a history-only source preserves a fresh other-source request for recovery',async t=>{
  const h=setup(t);
  const goal=await h.open({title:'Synthetic two-source recovery',objective:'Continue one accepted need from a second allowed source.',
    source_ids:[SOURCE,SOURCE_B],max_age_seconds:3600});
  await h.ingest({source_id:SOURCE,message_id:'two-source-old-anchor',thread_id:'two-source-old-thread',
    text:'An old synthetic source establishes the accepted baseline need.'});
  h.service.audience.reconcile({limit:10});
  const packet=h.service.audience.detail(goal.goal_id);
  assert.equal(packet.ready,true,'positive control: the history-only source begins healthy');
  const capture=await h.command('audience.capture',{goal_id:goal.goal_id,expected_revision:packet.revision,
    expected_basis_fingerprint:packet.basis_fingerprint});
  const original=h.service.audience.assessment(capture.assessment_id);
  const proposal=await h.command('audience.propose',{assessment_id:original.id,output:proposalFrom(original.packet)});
  let need=h.service.audience.need(proposal.need_ids[0]);
  await h.command('audience.review',{need_id:need.id,expected_revision:need.revision,
    expected_basis_fingerprint:need.basis_fingerprint,decision:'accept',note:'Synthetic two-source baseline.'});
  need=h.service.audience.need(need.id);
  await h.ingest({source_id:SOURCE_B,message_id:'two-source-fresh-event',thread_id:'two-source-fresh-thread',
    text:'A separate allowed source supplies a newly observed clarification.'});
  h.service.audience.reconcile({limit:10});
  const selected=await profile(h),context=h.service.followup.context(need.id);
  assert.equal(context.available,true,'positive control: the fresh event on the second source enables follow-up');
  assert.ok(context.exchanges.every(exchange=>exchange.source_ref===SOURCE_B));
  const req=await request(h,need,selected);

  let historyHealthy=false;
  const originalHealth=h.service.continuity.health;
  h.service.continuity.health=function(watch) {
    if(watch.source_ref===SOURCE) return historyHealthy?originalHealth.call(this,watch):{current:false,reason:'SOURCE_TRANSPORT_NOT_CURRENT'};
    return originalHealth.call(this,watch);
  };
  t.after(()=>{h.service.continuity.health=originalHealth;});
  const waiting=h.service.followup.context(need.id);
  assert.equal(waiting.available,false);
  assert.ok(waiting.reasons.includes('SOURCE_TRANSPORT_NOT_CURRENT'));
  h.service.audience.reconcile({limit:10});
  assert.equal(h.service.audience.assessment(req.assessment_id).status,'captured',
    'routine reconciliation also preserves the request during a temporary history-source wait');
  const calls=[],paused=await processAudienceAssessment(h.service,goodRuntime(calls));
  assert.equal(calls.length,0,'temporary history-source loss must not dispatch while evidence authority is uncertain');
  assert.notEqual(paused.disposition,'proposal_created');
  assert.equal(h.service.audience.assessment(req.assessment_id).status,'captured',
    'a temporary failure in history-only support must not terminally stale the fresh-source request');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_followup_attempts WHERE request_id=?',req.request_id).n,0);

  historyHealthy=true;
  const recoveredCalls=[],recovered=await processAudienceAssessment(h.service,goodRuntime(recoveredCalls));
  assert.equal(recovered.disposition,'proposal_created');
  assert.equal(recoveredCalls.length,1,'the same unspent request recovers without new authority');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_followup_attempts WHERE request_id=?',req.request_id).n,1);
});

test('focused output cannot revise a different existing need in the same goal',async t=>{
  const h=setup(t),{goal,need}=await seedAccepted(h,'wrong-target'),selected=await profile(h);
  const secondPacket=h.service.audience.detail(goal.goal_id);
  assert.equal(secondPacket.ready,true,'the new independent event can establish a separate positive-control need');
  const secondCapture=await h.command('audience.capture',{goal_id:goal.goal_id,expected_revision:secondPacket.revision,
    expected_basis_fingerprint:secondPacket.basis_fingerprint});
  const secondAssessment=h.service.audience.assessment(secondCapture.assessment_id);
  const secondProposal=await h.command('audience.propose',{assessment_id:secondAssessment.id,output:proposalFrom(secondAssessment.packet,
    {title:'A separate synthetic need',hypothesis:'A distinct new event supports a separate question.'})});
  const otherNeedId=secondProposal.need_ids[0];
  assert.notEqual(otherNeedId,need.id);
  const otherNeed=h.service.audience.need(otherNeedId);
  await h.command('audience.review',{need_id:otherNeedId,expected_revision:otherNeed.revision,
    expected_basis_fingerprint:otherNeed.basis_fingerprint,decision:'accept',note:'Synthetic separate target positive control.'});
  const otherAccepted=h.service.audience.need(otherNeedId);
  const req=await request(h,need,selected);
  let calls=0;
  const result=await processAudienceAssessment(h.service,{decide:async(_run,context)=>{
    calls++;
    const out=proposalFrom(context.packet,{need_id:otherNeedId,title:'Wrong target',hypothesis:'Must stay bound to the requested need.'});
    return {completed:true,final_response:JSON.stringify(modelOutputFrom(context.packet,out)),
      usage:{input_tokens:41,output_tokens:17},model_identity:{model_id:'synthetic-recovery-model',model_version:'fixture-v1'},api_calls:1};
  }});
  assert.equal(calls,1);
  assert.notEqual(result.disposition,'proposal_created');
  for(const [id,before] of [[need.id,need],[otherNeedId,otherAccepted]]) {
    const after=h.service.audience.need(id);
    assert.equal(after.revision,before.revision);
    assert.equal(after.status,before.status);
    assert.equal(after.basis_fingerprint,before.basis_fingerprint);
  }
  const attempt=h.store.get('SELECT * FROM audience_followup_attempts WHERE request_id=?',req.request_id);
  const run=h.store.get('SELECT * FROM runs WHERE id=?',attempt.run_id);
  assert.equal(run.input_tokens,41); assert.equal(run.output_tokens,17);
});

test('completed proof stays valid as history after request and profile revocation',async t=>{
  const h=setup(t),{need}=await seedAccepted(h,'revoked-history'),selected=await profile(h),req=await request(h,need,selected);
  const result=await processAudienceAssessment(h.service,goodRuntime());
  assert.equal(result.disposition,'proposal_created');
  const applied=h.service.audience.need(need.id);
  assert.equal(applied.status,'proposed');
  const detail=h.service.followup.detail(req.request_id);
  await h.command('audience.followup_revoke',{request_id:req.request_id,
    expected_request_fingerprint:detail.request_fingerprint,reason:'Retire unused future authority after completion.'});
  await h.command('model.profile_revoke',{profile_id:selected.profile_id,
    expected_definition_hash:selected.definition_hash,reason:'Retire the selected profile after completion.'});
  const stillValid=h.service.audience.need(need.id);
  assert.equal(stillValid.status,'proposed');
  assert.equal(stillValid.revision,applied.revision);
  assert.equal(stillValid.current,true);
  const assessment=h.service.audience.assessment(req.assessment_id);
  assert.equal(assessment.current,true);
  assert.equal(assessment.decision_review.state,'current');
  assert.equal(h.service.followup.detail(req.request_id).state,'revoked');
});

for(const apiCalls of [null,0,3,2]) test(`focused completion checks the frozen HTTP request cap (${apiCalls})`,async t=>{
    const h=setup(t),{need}=await seedAccepted(h,`http-accounting-${apiCalls}`),selected=await profile(h),req=await request(h,need,selected);
    const runtime=goodRuntime(),result=await processAudienceAssessment(h.service,{decide:async(run,context)=>({
      ...await runtime.decide(run,context),api_calls:apiCalls
    })});
    if(apiCalls===2) assert.equal(result.disposition,'proposal_created','positive control: two known requests are authorized');
    else {
      assert.equal(result.disposition,'AUDIENCE_FOLLOWUP_REQUEST_ACCOUNTING_INVALID');
      assert.equal(h.service.audience.need(need.id).status,'accepted');
      assert.equal(h.service.audience.need(need.id).revision,need.revision);
    }
    const attempt=h.store.get('SELECT * FROM audience_followup_attempts WHERE request_id=?',req.request_id);
    const run=h.store.get('SELECT * FROM runs WHERE id=?',attempt.run_id);
    assert.equal(run.input_tokens,41); assert.equal(run.output_tokens,17);
    assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_followup_attempts WHERE request_id=?',req.request_id).n,1);
});
