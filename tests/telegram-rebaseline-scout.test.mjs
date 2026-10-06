import test from 'node:test';
import assert from 'node:assert/strict';
import { processScoutAssessment } from '../business/scout-reasoning.mjs';
import { sourceCheckpoint, digest } from '../business/source-ingestion.mjs';
import { bootstrapTelegramSource, disconnectTelegramSource } from '../business/sources/telegram-readonly.mjs';
import { commitTelegramRebaseline, telegramRebaselineAuthorization } from '../business/source-observation-epochs.mjs';
import { message, noHistory, scoutHarness } from './scout-test-helpers.mjs';

const assessmentOutput={
  recommendation:'consider',reason:'The bounded source sample contains a relevant discussion.',
  evidence_refs:['1'],opportunities:[{description:'Review this discussion with the operator.',evidence_refs:['1']}],
  uncertainty:['The bounded sample does not establish continuing demand.']
};

async function prepared(t) {
  const priorKey=process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY='offline-scout-rebaseline-key';
  t.after(()=>{if(priorKey===undefined)delete process.env.PARTNER_MODEL_API_KEY;else process.env.PARTNER_MODEL_API_KEY=priorKey;});
  const h=scoutHarness(t,{modelEnabled:true,history:input=>input.before_id?noHistory(input):{
    empty:false,requested_count:input.limit,received_count:1,oldest_id:1,messages:[message('1')]
  }});
  h.config.runtime.model='offline-scout-rebaseline';
  h.config.runtime.baseUrl='http://127.0.0.1:1/v1';
  h.config.runtime.provider='custom';
  h.config.runtime.adapter='hermes';
  const campaign=await h.campaign('Observation recovery sample');
  await h.authorize(campaign);
  const candidate=await h.seed(campaign);
  const sample=await h.auditAndSeal(campaign,candidate);
  await h.command('scout.request_assessment',{campaign_id:campaign.id,revision:campaign.revision,
    candidate_id:candidate.id,sample_id:sample.id});
  const outcome=await processScoutAssessment(h.service,{decide:async()=>({
    completed:true,final_response:JSON.stringify(assessmentOutput),tool_calls:[],usage:{input_tokens:10,output_tokens:10}
  })});
  assert.equal(outcome.disposition,'assessment_proposed');
  await h.command('scout.review',{campaign_id:campaign.id,revision:campaign.revision,
    assessment_id:outcome.assessment_id,decision:'approve',note:'Reviewed this synthetic historical sample'});
  const admitted=await h.command('scout.admit',{campaign_id:campaign.id,revision:campaign.revision,
    candidate_id:candidate.id,sample_id:sample.id,assessment_id:outcome.assessment_id,
    expires_at:new Date(Date.now()+86400000).toISOString(),purpose:'Bounded synthetic source monitoring',
    max_lag_seconds:300,catchup_from_pts:null,expected_checkpoint_fingerprint:null,accept_historical_gap:false});
  const sourceRef='telegram:channel:'+candidate.channel_id;
  const policy=h.service.scout.monitorPolicies().find(row=>row.sourceId===sourceRef);
  assert.ok(policy,'the admitted monitor grant must project one source policy');
  await bootstrapTelegramSource(h.service,sourceRef,{pts:10,history:[]});
  await disconnectTelegramSource(h.service,sourceRef,'INTEGRITY_RECONCILIATION_REQUIRED');
  const checkpoint=sourceCheckpoint(h.service,sourceRef);
  const authorization=await h.command('source.rebaseline',{source_id:sourceRef,
    checkpoint_fingerprint:digest(checkpoint),acknowledge_gap:true,
    expires_at:new Date(Date.now()+30*60*1000).toISOString(),
    reason:'Reviewed the unknown observation gap in this offline test.'});
  const auth=telegramRebaselineAuthorization(h.service,policy);
  assert.equal(auth.id,authorization.authorization_id);
  commitTelegramRebaseline(h.service,policy,auth,20);
  const presentation=h.service.scout.presentation(h.service.scout.campaign(campaign.id));
  const shown=presentation.candidates.find(row=>row.id===candidate.id);
  return {h,campaign,candidate,sample,shown};
}

test('Scout API normalizes joined membership to boolean for the operator surface',async t=>{
  const {shown}=await prepared(t);
  assert.equal(shown.joined,true);
});

test('a committed Telegram observation epoch makes old Scout samples and approvals stale without erasing history',async t=>{
  const {h,candidate,sample,shown}=await prepared(t);
  assert.equal(h.store.get('SELECT status FROM scout_samples WHERE id=?',sample.id).status,'sealed',
    'the audited sample remains retained');
  assert.equal(shown.sample.id,sample.id);
  assert.equal(shown.sample.current,false,'the prior bounded sample cannot be presented as current across a rebaseline');
  assert.equal(shown.assessment.status,'stale','an approval bound to now-stale sample evidence is no longer current');
  assert.equal(shown.observation_recovery.epoch.history_complete,false);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM source_observation_epochs').n,1);
});
