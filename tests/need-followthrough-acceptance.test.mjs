// Evidence-bounded Audience need follow-through acceptance. All sources and model replies
// are synthetic; Date is mocked so source age and future authority expiry share one clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { audienceHarness, SOURCE, SOURCE_B, modelOutputFrom, proposalFrom } from './audience-test-helpers.mjs';
import { processAudienceAssessment } from '../business/audience-reasoning.mjs';

const PROFILE_URL = 'https://models.example.test/v1';
const FIXED_NOW = '2026-01-01T00:30:00.000Z';
const OLD_TEXT = 'The original question whose source text will later expire.';

function setup(t) {
  t.mock.timers.enable({ apis:['Date'], now:new Date(FIXED_NOW) });
  const previous=process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY='offline-followthrough-sentinel-never-sent';
  t.after(()=>previous===undefined?delete process.env.PARTNER_MODEL_API_KEY:process.env.PARTNER_MODEL_API_KEY=previous);
  const h=audienceHarness(t);
  Object.assign(h.config.runtime,{enabled:false,baseUrl:'',model:'',dailyBudgetUsd:5,inputUsdPerMillion:null,outputUsdPerMillion:null,maxRunsPerDay:50});
  h.config.audience.enabled=true; h.config.audience.modelEnabled=false; h.config.audience.maxRunsPerDay=20;
  h.config.modelProfiles={allowedBaseUrls:[PROFILE_URL]};
  h.config.controlPlane.enabled=true; h.config.controlPlane.maxConcurrent=3;
  return h;
}

async function ingestAt(h,{sourceId=SOURCE,messageId,text,threadId=null,replyToId=null}) {
  const at=new Date().toISOString();
  return h.command('source.ingest',{source_id:sourceId,source_kind:'sanitized_fixture',message_id:messageId,
    author_id:`author:${sourceId}`,display_name:null,thread_id:threadId,reply_to_id:replyToId,
    version:1,operation:'upsert',text,created_at:at,updated_at:at},undefined,{kind:'channel',sourceId});
}

async function seedAcceptedNeed(h,{sourceId=SOURCE,name='followthrough',maxAgeSeconds=3600}={}) {
  const goal=await h.open({title:`Synthetic ${name}`,objective:'Continue the one previously observed need using only newer support.',
    source_ids:[sourceId],max_age_seconds:maxAgeSeconds});
  await h.ingest({source_id:sourceId,message_id:`${name}-old-anchor`,text:OLD_TEXT,thread_id:`${name}-thread`});
  h.service.audience.reconcile({limit:10});
  const detail=h.service.audience.detail(goal.goal_id);
  assert.equal(detail.ready,true,'positive control: the original synthetic observation is current at the fixture clock');
  const capture=await h.command('audience.capture',{goal_id:goal.goal_id,expected_revision:detail.revision,
    expected_basis_fingerprint:detail.basis_fingerprint});
  const packet=h.service.audience.assessment(capture.assessment_id).packet;
  const oldEventId=packet.exchanges[0].evidence[0].source_event_id;
  const proposal=await h.command('audience.propose',{assessment_id:capture.assessment_id,output:proposalFrom(packet)});
  let need=h.service.audience.need(proposal.need_ids[0]);
  await h.command('audience.review',{need_id:need.id,expected_revision:need.revision,
    expected_basis_fingerprint:need.basis_fingerprint,decision:'accept',note:'Accept the initial synthetic hypothesis.'});
  need=h.service.audience.need(need.id);
  assert.equal(need.status,'accepted');
  return {goal,need,oldEventId};
}

function agePastSourceWindow(t) { t.mock.timers.tick(90*60*1000); }

async function profile(h,label='Selected offline profile') {
  return h.command('model.profile_create',{label,provider:'custom',api_mode:'chat_completions',base_url:PROFILE_URL,
    model:'offline-followthrough-model',max_output_tokens:900,input_usd_per_million:2,output_usd_per_million:3});
}

async function requestFollowup(h,need,profileRecord,context=h.service.followup.context(need.id),overrides={}) {
  assert.equal(context.available,true,'positive control: current follow-up context is available');
  return h.command('audience.followup_request',{need_id:need.id,expected_revision:context.need_revision,
    expected_basis_fingerprint:context.need_basis_fingerprint,expected_context_fingerprint:context.context_fingerprint,
    model_profile_id:profileRecord.profile_id??profileRecord.id,expected_profile_hash:profileRecord.definition_hash,
    expires_at:new Date(Date.now()+60*60*1000).toISOString(),reason:'One bounded synthetic follow-up.',...overrides});
}

function successfulRuntime({calls=[],empty=false,oldCitation=null,targetNeedId=null}={}) {
  return {decide:async(_run,context)=>{
    calls.push({run:structuredClone(_run),context:structuredClone(context)});
    const packet=context.packet;
    let output=empty?{needs:[]}:proposalFrom(packet,{need_id:targetNeedId??context.packet.reassessment?.need_id??null,
      title:'Freshly supported follow-up revision',hypothesis:'The new observation supports this narrow continuation.',
      why_now:'Only the current follow-up packet supports this revision.',reason:'This synthetic revision cites current evidence only.'});
    if(oldCitation) output={...output,needs:[{...output.needs[0],evidence_event_ids:[oldCitation.eventId],
      support_quotes:[{source_event_id:oldCitation.eventId,quote:oldCitation.text}]}]};
    return {completed:true,final_response:JSON.stringify(modelOutputFrom(packet,output)),
      usage:{input_tokens:37,output_tokens:14},model_identity:{model_id:'offline-followthrough-model',model_version:'fixture-v1'},api_calls:1};
  }};
}

// All source timestamps and grant expiries share the mocked Date clock.
async function advanceAndIngest(t,h,{messageId,text,threadId,replyToId=null,sourceId=SOURCE}) {
  agePastSourceWindow(t);
  await ingestAt(h,{sourceId,messageId,text,threadId,replyToId});
  h.service.audience.reconcile({limit:10});
}

test('expired historical anchor stays text-free while an independent current exchange enables follow-up',async t=>{
  const h=setup(t),{goal,need,oldEventId}=await seedAcceptedNeed(h,{name:'fresh-independent'});
  await advanceAndIngest(t,h,{messageId:'new-independent-event',threadId:'new-independent-thread',
    text:'A fresh independent observation supports a practical next revision.'});
  const agedNeed=h.service.audience.need(need.id);
  assert.equal(agedNeed.status,'stale','expired historical support stales the old accepted hypothesis');
  const context=h.service.followup.context(need.id);
  assert.equal(context.available,true);
  assert.equal(context.scope.version,2);
  assert.equal(context.scope.purpose,'audience_current_events_v1');
  assert.ok(context.exchanges.some(exchange=>exchange.evidence.some(item=>item.text.includes('fresh independent observation'))));
  assert.ok(!context.exchanges.some(exchange=>exchange.evidence.some(item=>item.source_event_id===oldEventId||item.text.includes(OLD_TEXT))));
  assert.equal(JSON.stringify(context.historical_memory).includes(OLD_TEXT),false,'history contains metadata, not expired source text');
  assert.equal(h.service.audience.need(need.id).status,'stale','the old need remains stale until a new revision is reviewed');
  assert.equal(goal.goal_id,need.goal_id);
});

test('a fresh reply to an aged anchor is usable only as new evidence after lineage validation',async t=>{
  const h=setup(t),{need,oldEventId}=await seedAcceptedNeed(h,{name:'fresh-reply'});
  await advanceAndIngest(t,h,{messageId:'fresh-reply-event',threadId:'fresh-reply-thread',replyToId:'fresh-reply-old-anchor',
    text:'The old setup question is answered with a newly observed useful clarification.'});
  assert.equal(h.service.audience.need(need.id).status,'stale');
  const context=h.service.followup.context(need.id);
  assert.equal(context.available,true);
  const evidence=context.exchanges.flatMap(exchange=>exchange.evidence);
  assert.ok(evidence.some(item=>item.text.includes('newly observed useful clarification')));
  assert.ok(!evidence.some(item=>item.source_event_id===oldEventId||item.text.includes(OLD_TEXT)),
    'structural ancestry does not reintroduce expired parent text as current support');
  assert.ok(!JSON.stringify(context).includes(OLD_TEXT));
});

test('a model cannot cite expired prior text because it is absent from the follow-up packet',async t=>{
  const h=setup(t),{need,oldEventId}=await seedAcceptedNeed(h,{name:'no-old-citation'});
  await advanceAndIngest(t,h,{messageId:'citation-fresh-event',threadId:'citation-fresh-thread',
    text:'The new event supports one small follow-up.'});
  const context=h.service.followup.context(need.id),selected=await profile(h);
  const staleNeed=h.service.audience.need(need.id);
  assert.equal(staleNeed.status,'stale');
  await requestFollowup(h,need,selected,context);
  const calls=[],runtime=successfulRuntime({calls,oldCitation:{eventId:oldEventId,text:OLD_TEXT},targetNeedId:need.id});
  const result=await processAudienceAssessment(h.service,runtime);
  assert.equal(calls.length,1);
  assert.equal(JSON.stringify(calls[0].context.packet).includes(OLD_TEXT),false);
  assert.ok(!calls[0].context.packet.exchanges.some(exchange=>exchange.evidence.some(item=>item.source_event_id===oldEventId)));
  assert.notEqual(result.disposition,'proposal_created','a forged citation to an expired ancestor cannot support the revision');
  const after=h.service.audience.need(need.id);
  assert.deepEqual({revision:after.revision,status:after.status,basis_fingerprint:after.basis_fingerprint},
    {revision:staleNeed.revision,status:staleNeed.status,basis_fingerprint:staleNeed.basis_fingerprint},
    'invalid citation preserves the already-stale need without creating a revision');
});

test('an ordinary attention grant for another goal makes zero follow-up calls without an explicit request',async t=>{
  const h=setup(t),{need}=await seedAcceptedNeed(h,{name:'ordinary-isolation'});
  await advanceAndIngest(t,h,{messageId:'ordinary-isolation-new',threadId:'ordinary-isolation-fresh',
    text:'A new source event exists, but no follow-up request was granted.'});
  const staleNeed=h.service.audience.need(need.id);
  assert.equal(staleNeed.status,'stale');
  const profileRecord=await profile(h,'Ordinary-only profile');
  const other=await h.open({title:'Unrelated ordinary goal',objective:'This goal cannot fund the prior need.',source_ids:[SOURCE_B]});
  const otherDetail=h.service.audience.detail(other.goal_id),option=otherDetail.attention.profile_options.find(row=>row.profile_id===profileRecord.profile_id);
  assert.ok(option);
  await h.command('audience.attention_grant',{goal_id:other.goal_id,expected_revision:otherDetail.revision,
    expected_scope_fingerprint:option.scope_fingerprint,model_profile_id:profileRecord.profile_id,max_attempts:1,
    expires_at:new Date(Date.now()+60*60*1000).toISOString(),reason:'Ordinary authority is not follow-up authority.'});
  const context=h.service.followup.context(need.id);
  assert.equal(context.available,true);
  const calls=[],result=await processAudienceAssessment(h.service,successfulRuntime({calls}));
  assert.equal(calls.length,0);
  assert.equal(result.assessment_id,undefined,'no evidence on the unrelated granted goal admits any assessment');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_followup_attempts').n,0);
  const after=h.service.audience.need(need.id);
  assert.deepEqual({revision:after.revision,status:after.status,basis_fingerprint:after.basis_fingerprint},
    {revision:staleNeed.revision,status:staleNeed.status,basis_fingerprint:staleNeed.basis_fingerprint});
});

test('one exact profile-bound request spends one turn with global model flags off and proposes a fresh reviewable revision',async t=>{
  const h=setup(t),{need,oldEventId}=await seedAcceptedNeed(h,{name:'one-shot-success'});
  await advanceAndIngest(t,h,{messageId:'one-shot-new',threadId:'one-shot-fresh',text:'The fresh observation supports a practical checklist revision.'});
  const selected=await profile(h),context=h.service.followup.context(need.id);
  const staleNeed=h.service.audience.need(need.id);
  assert.equal(staleNeed.status,'stale');
  const request=await requestFollowup(h,need,selected,context),calls=[],runtime=successfulRuntime({calls,targetNeedId:need.id});
  const result=await processAudienceAssessment(h.service,runtime);
  assert.equal(result.disposition,'proposal_created');
  assert.equal(calls.length,1);
  const run=h.store.get('SELECT * FROM runs WHERE id=(SELECT run_id FROM audience_assessments WHERE id=?)',request.assessment_id);
  assert.equal(run.model,'offline-followthrough-model');
  assert.equal(JSON.parse(run.context_json).model_profile.id,selected.profile_id??selected.id);
  assert.equal(h.config.audience.modelEnabled,false); assert.equal(h.config.runtime.enabled,false);
  const revised=h.service.audience.need(need.id);
  assert.ok(revised.revision>staleNeed.revision);
  assert.equal(revised.status,'proposed','the prior acceptance does not transfer to a new revision');
  assert.equal(revised.current,true);
  assert.ok(!revised.evidence_event_ids.includes(oldEventId));
  for(const table of ['persons','conversations','drafts','approvals','delivery_attempts','work_cases','work_materials','action_proposals'])
    assert.equal(h.store.get(`SELECT COUNT(*) n FROM ${table}`).n,0,`${table} remains untouched by a follow-up proposal`);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_followup_attempts').n,1);
});

test('empty follow-up output leaves resolution unknown and does not revise or accept the need',async t=>{
  const h=setup(t),{need}=await seedAcceptedNeed(h,{name:'empty-followup'});
  await advanceAndIngest(t,h,{messageId:'empty-new',threadId:'empty-fresh',text:'A new event was considered but no new need is supported.'});
  const selected=await profile(h),context=h.service.followup.context(need.id);
  const staleNeed=h.service.audience.need(need.id);
  assert.equal(staleNeed.status,'stale');
  const request=await requestFollowup(h,need,selected,context),calls=[],result=await processAudienceAssessment(h.service,successfulRuntime({calls,empty:true}));
  assert.equal(calls.length,1);
  assert.equal(result.disposition,'no_revision_proposed');
  const assessment=h.service.audience.assessment(request.assessment_id);
  assert.equal(assessment.decision_review.resolution,'unknown');
  assert.equal(assessment.decision_review.review.disposition,'no_need_proposed');
  const unchanged=h.service.audience.need(need.id);
  assert.equal(unchanged.revision,staleNeed.revision);
  assert.equal(unchanged.status,'stale');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_followup_attempts').n,1);
});

test('a consumed failed follow-up stays terminal after restart and cannot rebill',async t=>{
  const h=setup(t),{need}=await seedAcceptedNeed(h,{name:'restart-followup'});
  await advanceAndIngest(t,h,{messageId:'restart-new',threadId:'restart-fresh',text:'A fresh event supports a bounded follow-up.'});
  const selected=await profile(h),context=h.service.followup.context(need.id),request=await requestFollowup(h,need,selected,context);
  const staleNeed=h.service.audience.need(need.id);
  assert.equal(staleNeed.status,'stale');
  let calls=0;
  const first=await processAudienceAssessment(h.service,{decide:async()=>{calls++;return {completed:false,error:'synthetic failure',usage:{input_tokens:23,output_tokens:0},model_identity:{model_id:'offline-followthrough-model',model_version:'fixture-v1'},api_calls:1};}});
  assert.notEqual(first.disposition,'proposal_created');
  assert.equal(calls,1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_followup_attempts WHERE request_id=?',request.request_id).n,1);
  h.restart();
  const resumed=await processAudienceAssessment(h.service,{decide:async()=>{calls++;throw new Error('a consumed request must never call again');}});
  assert.equal(calls,1);
  assert.notEqual(resumed.disposition,'proposal_created');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_followup_attempts WHERE request_id=?',request.request_id).n,1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs WHERE runtime=?','hermes-audience-v1').n,1);
});
