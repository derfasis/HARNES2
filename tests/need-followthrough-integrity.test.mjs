// Adversarial integrity checks for completed one-shot Audience follow-up proofs.
// Provider results and public-source records are synthetic; Date uses one coherent fixture clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { audienceHarness, SOURCE, EVENT_TIME, proposalFrom, modelOutputFrom } from './audience-test-helpers.mjs';
import { processAudienceAssessment } from '../business/audience-reasoning.mjs';
import { sourceEvent } from '../business/source-ingestion.mjs';

const PROFILE_URL='https://followup-integrity.example.test/v1';
const FIXED_NOW='2026-01-01T00:30:00.000Z';

function setup(t,label) {
  t.mock.timers.enable({apis:['Date'],now:new Date(FIXED_NOW)});
  const previous=process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY='offline-followup-integrity-sentinel';
  t.after(()=>previous===undefined?delete process.env.PARTNER_MODEL_API_KEY:process.env.PARTNER_MODEL_API_KEY=previous);
  const h=audienceHarness(t);
  Object.assign(h.config.runtime,{enabled:false,baseUrl:'',model:'',timeoutSeconds:120,dailyBudgetUsd:5,
    inputUsdPerMillion:null,outputUsdPerMillion:null,maxRunsPerDay:50});
  h.config.audience.modelEnabled=false;
  h.config.audience.maxRunsPerDay=20;
  h.config.modelProfiles={allowedBaseUrls:[PROFILE_URL]};
  h.config.opportunity.allowedSourceRefs=[SOURCE];
  h.config.controlPlane.enabled=true;
  return h;
}

async function ingestAt(h,{messageId,text,threadId,createdAt=new Date().toISOString()}) {
  return h.command('source.ingest',{source_id:SOURCE,source_kind:'sanitized_fixture',message_id:messageId,
    author_id:'synthetic-author',display_name:null,thread_id:threadId,reply_to_id:null,version:1,operation:'upsert',
    text,created_at:createdAt,updated_at:createdAt},undefined,{kind:'channel',sourceId:SOURCE});
}

async function createProfile(h) {
  return h.command('model.profile_create',{label:'Synthetic integrity profile',provider:'custom',api_mode:'chat_completions',
    base_url:PROFILE_URL,model:'offline-followup-integrity-model',max_output_tokens:900,
    input_usd_per_million:2,output_usd_per_million:3});
}

async function makeNeed(h,label) {
  const goal=await h.open({title:`Synthetic integrity ${label}`,objective:'Continue only a freshly supported synthetic question.',
    source_ids:[SOURCE],max_age_seconds:3600});
  await ingestAt(h,{messageId:`${label}-anchor`,text:`The original synthetic question for ${label}.`,threadId:`${label}-thread`,createdAt:EVENT_TIME});
  h.service.audience.reconcile({limit:10});
  const detail=h.service.audience.detail(goal.goal_id);
  assert.equal(detail.ready,true,'positive control: original fixture evidence is current');
  const captured=await h.command('audience.capture',{goal_id:goal.goal_id,expected_revision:detail.revision,
    expected_basis_fingerprint:detail.basis_fingerprint});
  const packet=h.service.audience.assessment(captured.assessment_id).packet;
  const proposal=await h.command('audience.propose',{assessment_id:captured.assessment_id,output:proposalFrom(packet)});
  let need=h.service.audience.need(proposal.need_ids[0]);
  await h.command('audience.review',{need_id:need.id,expected_revision:need.revision,
    expected_basis_fingerprint:need.basis_fingerprint,decision:'accept',note:'Accept the synthetic baseline.'});
  need=h.service.audience.need(need.id);
  assert.equal(need.status,'accepted');
  return {goal,need};
}

async function addFresh(h,label) {
  await ingestAt(h,{messageId:`${label}-fresh`,text:`A new synthetic observation supports ${label}.`,threadId:`${label}-fresh-thread`});
  h.service.audience.reconcile({limit:10});
}

async function makeRequest(h,need,profile,context=h.service.followup.context(need.id)) {
  assert.equal(context.available,true,'positive control: exact current context is available');
  return h.command('audience.followup_request',{need_id:need.id,expected_revision:context.need_revision,
    expected_basis_fingerprint:context.need_basis_fingerprint,expected_context_fingerprint:context.context_fingerprint,
    model_profile_id:profile.profile_id??profile.id,expected_profile_hash:profile.definition_hash,
    expires_at:new Date(Date.now()+60*60*1000).toISOString(),reason:'One synthetic integrity check.'});
}

async function completedProof(t,label) {
  const h=setup(t,label),{goal,need:baseline}=await makeNeed(h,label),profile=await createProfile(h);
  t.mock.timers.tick(90*60*1000);
  await addFresh(h,label);
  const request=await makeRequest(h,baseline,profile);
  const runtime={decide:async(_run,context)=>({completed:true,
    final_response:JSON.stringify(modelOutputFrom(context.packet,proposalFrom(context.packet,{need_id:baseline.id,
      title:'Synthetic supported revision',hypothesis:'The new observation supports a narrow revision.',
      why_now:'This current packet supplies the new support.'}))),
    usage:{input_tokens:31,output_tokens:12},model_identity:{model_id:'offline-followup-integrity-model',model_version:'fixture-v1'},api_calls:1})};
  const result=await processAudienceAssessment(h.service,runtime);
  assert.equal(result.disposition,'proposal_created','positive control: fake runtime completed a valid follow-up proposal');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_followup_attempts WHERE request_id=?',request.request_id).n,1);
  let need=h.service.audience.need(baseline.id);
  assert.equal(need.status,'proposed');
  assert.equal(need.current,true);
  assert.equal(need.proposal_version,2);
  await h.command('audience.review',{need_id:need.id,expected_revision:need.revision,
    expected_basis_fingerprint:need.basis_fingerprint,decision:'accept',note:'Accept the valid synthetic revision.'});
  need=h.service.audience.need(need.id);
  assert.equal(need.status,'accepted','positive control: valid completed proof permits ordinary owner review');
  const assessment=h.service.audience.assessmentRecord(request.assessment_id);
  assert.equal(assessment.status,'proposed');
  assert.equal(assessment.run_id!=null,true);
  return {h,goal,baseline,need,profile,request,assessment};
}

test('completed follow-up packet text forgery fails canonical source binding even when frozen run copy matches',async t=>{
  const {h,need,assessment}=await completedProof(t,'packet-forgery');
  assert.equal(h.service.audience.need(need.id).status,'accepted','valid completed proof reads before the forgery');
  const packet=JSON.parse(assessment.packet_json);
  const eventRef=packet.exchanges[0].evidence[0].source_event_id;
  const originalText=packet.exchanges[0].evidence[0].text;
  packet.exchanges[0].evidence[0].text=`${originalText} forged without a source edit`;
  const run=h.store.get('SELECT * FROM runs WHERE id=?',assessment.run_id);
  const frozen=JSON.parse(run.context_json);
  frozen.packet=structuredClone(packet);
  h.store.run('UPDATE audience_assessments SET packet_json=? WHERE id=?',JSON.stringify(packet),assessment.id);
  h.store.run('UPDATE runs SET context_json=? WHERE id=?',JSON.stringify(frozen),run.id);
  assert.equal(packet.exchanges[0].evidence[0].source_event_id,eventRef);
  assert.equal(sourceEvent(h.service,eventRef).message.text,originalText,
    'the durable source event remains unchanged while both packet copies are forged');
  assert.throws(()=>h.service.audience.need(need.id),{code:'AUDIENCE_RECORD_INVALID'});
  await assert.rejects(h.command('audience.review',{need_id:need.id,expected_revision:need.revision,
    expected_basis_fingerprint:need.basis_fingerprint,decision:'reject',note:'This must fail closed.'}),
  {code:'AUDIENCE_RECORD_INVALID'});
});

test('a v2 need cannot remove proposal_version to downgrade to legacy interpretation',async t=>{
  const {h,need}=await completedProof(t,'proposal-version-downgrade');
  assert.equal(h.service.audience.need(need.id).status,'accepted','valid completed proof reads before downgrade');
  const row=h.store.get('SELECT output_json,basis_json FROM audience_needs WHERE id=?',need.id);
  const output=JSON.parse(row.output_json),basis=JSON.parse(row.basis_json);
  assert.equal(basis.version,2);
  delete output.proposal_version;
  h.store.run('UPDATE audience_needs SET output_json=? WHERE id=?',JSON.stringify(output),need.id);
  assert.throws(()=>h.service.audience.need(need.id),{code:'AUDIENCE_RECORD_INVALID'});
  await assert.rejects(h.command('audience.review',{need_id:need.id,expected_revision:need.revision,
    expected_basis_fingerprint:need.basis_fingerprint,decision:'reject',note:'This must fail closed.'}),
  {code:'AUDIENCE_RECORD_INVALID'});
});

test('withdrawal then restoration of the same allowed source remains blocked',async t=>{
  const {h,goal,need,profile}=await completedProof(t,'allowlist-withdraw-restore');
  await addFresh(h,'allowlist-after-completion');
  const before=h.service.followup.context(need.id);
  assert.equal(before.available,true,'positive control: the valid completed proof and current source begin available');
  h.config.opportunity.allowedSourceRefs=[];
  h.service.audience.detail(goal.goal_id); // Observes and retires the watch while the source is disallowed.
  assert.equal(h.service.audience.watches(goal.goal_id)[0].status,'revoked');
  h.config.opportunity.allowedSourceRefs=[SOURCE];
  const restored=h.service.followup.context(need.id);
  assert.equal(restored.available,false);
  assert.ok(restored.reasons.includes('AUDIENCE_SOURCE_REVOKED'));
  await assert.rejects(makeRequest(h,need,profile,before),{code:'AUDIENCE_STALE_BASIS'});
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_followup_attempts').n,1,
    'restoring the identical allowlist cannot revive authority or spend another attempt');
});

test('execution bounds are part of preview identity and remain frozen after request',async t=>{
  const {h,need,profile}=await completedProof(t,'execution-bounds');
  t.mock.timers.tick(60*1000);
  await addFresh(h,'execution-bounds-second');
  const initial=h.service.followup.context(need.id),frozenTimeout=initial.execution_bounds.timeout_seconds;
  assert.equal(initial.available,true,'positive control: a new current event permits another exact preview');
  h.config.runtime.timeoutSeconds=frozenTimeout+60;
  await assert.rejects(makeRequest(h,need,profile,initial),{code:'AUDIENCE_STALE_BASIS'});
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_followup_requests').n,1,
    'changing a bound between preview and request does not create a request');

  h.config.runtime.timeoutSeconds=frozenTimeout;
  const refreshed=h.service.followup.context(need.id),request=await makeRequest(h,need,profile,refreshed);
  assert.deepEqual(refreshed.execution_bounds,{timeout_seconds:frozenTimeout,max_api_calls:2});
  h.config.runtime.timeoutSeconds=frozenTimeout+60;
  const result=await processAudienceAssessment(h.service,{decide:async(_run,context)=>({completed:true,
    final_response:JSON.stringify(modelOutputFrom(context.packet,{needs:[]})),usage:{input_tokens:21,output_tokens:6},
    model_identity:{model_id:'offline-followup-integrity-model',model_version:'fixture-v1'},api_calls:1})});
  assert.equal(result.disposition,'no_revision_proposed');
  const run=h.store.get('SELECT * FROM runs WHERE id=(SELECT run_id FROM audience_assessments WHERE id=?)',request.assessment_id);
  const frozen=JSON.parse(run.context_json);
  assert.equal(frozen.model_config.timeoutSeconds,frozenTimeout);
  assert.equal(frozen.packet.execution_bounds.timeout_seconds,frozenTimeout);
  assert.equal(frozen.packet.execution_bounds.max_api_calls,2);
  assert.equal(h.config.runtime.timeoutSeconds,frozenTimeout+60,'the hot global value remains changed but cannot retarget the accepted request');
});
