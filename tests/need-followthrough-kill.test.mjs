// Adversarial, synthetic-only acceptance for evidence-bounded focused follow-through.
import test from 'node:test';
import assert from 'node:assert/strict';
import { audienceHarness, SOURCE, SOURCE_B, proposalFrom, modelOutputFrom } from './audience-test-helpers.mjs';
import { processAudienceAssessment } from '../business/audience-reasoning.mjs';

const PROFILE_URL = 'https://models.followthrough.example.test/v1';
const RUNTIME = 'hermes-audience-v1';

function setup(t) {
  const previous = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'synthetic-followthrough-test-key-never-sent';
  t.after(() => previous === undefined ? delete process.env.PARTNER_MODEL_API_KEY
    : process.env.PARTNER_MODEL_API_KEY = previous);
  const h = audienceHarness(t);
  h.config.runtime.enabled = false;
  h.config.runtime.baseUrl = '';
  h.config.runtime.model = '';
  h.config.runtime.dailyBudgetUsd = null;
  h.config.runtime.maxRunsPerDay = 50;
  h.config.audience.modelEnabled = false;
  h.config.audience.maxRunsPerDay = 20;
  h.config.modelProfiles = { allowedBaseUrls:[PROFILE_URL] };
  return h;
}

async function acceptedNeed(h, { source = SOURCE, maxAge = 3600, anchor = 'first-question', thread = 'first-thread',
  proposalOverrides = {} } = {}) {
  const goal = await h.open({ title:'Follow one synthetic need', objective:'Check only fresh follow-up evidence.', source_ids:[source], max_age_seconds:maxAge });
  const original = await h.ingest({ message_id:anchor, thread_id:thread, source_id:source,
    text:'How can I get through the first setup step?' });
  h.service.audience.reconcile({ limit:10 });
  const capture = await h.capture(goal.goal_id), assessment = h.service.audience.assessment(capture.assessment_id);
  const proposed = await h.command('audience.propose', { assessment_id:assessment.id,
    output:proposalFrom(assessment.packet,proposalOverrides) });
  let need = h.service.audience.need(proposed.need_ids[0]);
  await h.command('audience.review', { need_id:need.id, expected_revision:need.revision,
    expected_basis_fingerprint:need.basis_fingerprint, decision:'accept', note:'Synthetic owner review of the original hypothesis.' });
  need = h.service.audience.need(need.id);
  return { goal, need, original, assessment, anchor, thread };
}

function useMockClock(t) {
  const realNow = Date.now;
  let mockedNow = realNow();
  Date.now = () => mockedNow;
  t.after(() => { Date.now = realNow; });
  return { advance(ms) { mockedNow += ms; return mockedNow; }, get now() { return mockedNow; } };
}

async function ingestAt(h, clock, input) {
  const result = await h.ingest(input);
  // Continuity freshness uses events.created_at as observed_at, not source payload created_at.
  h.store.run('UPDATE events SET created_at=? WHERE id=?', new Date(clock.now).toISOString(), Number(result.source_event_id));
  h.service.audience.reconcile({ limit:10, event_limit:50 });
  return result;
}

async function expiredNeedWithFresh(h, t, { source = SOURCE, sameExchangeReply = false, parentMode = 'intact' } = {}) {
  const clock = useMockClock(t);
  const seeded = await acceptedNeed(h, { source, anchor:'old-anchor', thread:'old-thread' });
  clock.advance(2 * 60 * 60 * 1000);
  if (parentMode === 'delete') {
    await ingestAt(h, clock, { message_id:seeded.anchor, source_id:source,
      thread_id:seeded.thread, version:2, operation:'delete', text:null });
  } else if (parentMode === 'unsupported') {
    await ingestAt(h, clock, { message_id:seeded.anchor, source_id:source,
      thread_id:seeded.thread, version:2, operation:'unsupported', text:null,
      unsupported:{ reason:'media', fingerprint:'a'.repeat(64) } });
  }
  const replyTo = parentMode === 'missing' ? 'missing-parent-anchor'
    : (sameExchangeReply || parentMode !== 'independent' ? seeded.anchor : null);
  const freshMessageId = 'fresh-followup-event';
  const fresh = await ingestAt(h, clock, { message_id:freshMessageId, source_id:source,
    thread_id:sameExchangeReply || parentMode !== 'independent' ? seeded.thread : 'fresh-followup-thread',
    ...(replyTo ? { reply_to_id:replyTo } : {}), text:'I completed the first step; now I need help with the next one.' });
  if (parentMode === 'revoke') {
    h.config.opportunity.allowedSourceRefs = [];
    h.service.audience.reconcile({ limit:10, event_limit:50 });
  }
  return { ...seeded, fresh, freshMessageId, clock };
}

async function profile(h) {
  return h.command('model.profile_create', { label:'Bounded follow-through profile', provider:'custom',
    api_mode:'chat_completions', base_url:PROFILE_URL, model:'synthetic-followthrough-model', max_output_tokens:800,
    input_usd_per_million:null, output_usd_per_million:null });
}

async function followupContextAndRequest(h, need, selectedProfile, context = h.service.followup.context(need.id)) {
  const option = context.profile_options.find(p => p.profile_id === selectedProfile.profile_id || p.id === selectedProfile.profile_id);
  assert.ok(option, 'selected immutable profile is visible for the exact fresh context');
  const request = await h.command('audience.followup_request', { need_id:need.id,
    expected_revision:context.need_revision, expected_basis_fingerprint:context.need_basis_fingerprint,
    expected_context_fingerprint:context.context_fingerprint, model_profile_id:selectedProfile.profile_id,
    expected_profile_hash:selectedProfile.definition_hash,
    expires_at:new Date(Date.now()+60*60*1000).toISOString(), reason:'One synthetic evidence-bounded focused follow-up.' });
  return { context, option, request };
}

function outputForFollowup(packet, needId) {
  return modelOutputFrom(packet, proposalFrom(packet, { need_id:needId,
    title:'Updated synthetic next-step need', hypothesis:'The current reply reports progress but leaves another step uncertain.',
    why_now:'A fresh current reply asks for the next step.', next_step:'observe' }));
}

function finiteRuntime({ before = async () => {}, outputFor = context => modelOutputFrom(context.packet) } = {}) {
  const calls = [];
  return { calls, runtime:{ decide:async (run, context) => {
    calls.push({ run_id:run.id, goal_id:JSON.parse(run.context_json).goal_id, assessment_id:JSON.parse(run.context_json).assessment_id,
      run_context:JSON.parse(run.context_json), packet:structuredClone(context.packet) });
    await before(run, context);
    return { completed:true, final_response:JSON.stringify(outputFor(context)), usage:{input_tokens:37,output_tokens:19},
      model_identity:{model_id:'synthetic-followthrough-model',model_version:'fixture-v1'}, api_calls:1 };
  } } };
}

test('an expired but intact ancestor is structural lineage only while its fresh reply forms current support', async t => {
  const h = setup(t);
  const seeded = await expiredNeedWithFresh(h, t, { sameExchangeReply:true, parentMode:'intact' });
  assert.ok(seeded.fresh.source_event_id);
  const context = h.service.followup.context(seeded.need.id);
  assert.equal(context.available,true,JSON.stringify({ reasons:context.reasons, scope:context.scope }));
  assert.equal(context.historical_memory.resolution,'unknown');
  assert.ok(context.historical_evidence.some(e => e.source_event_id === seeded.original.source_event_id
    && e.reasons.includes('CONTINUITY_EVIDENCE_EXPIRED')));
  assert.ok(!JSON.stringify(context.fresh_exchanges ?? context.exchanges).includes('How can I get through the first setup step?'),
    'expired source text is not forwarded as current support');
  assert.equal(context.scope.version,2);
  assert.equal(context.scope.purpose,'audience_current_events_v1');
  const entries = context.scope.exchanges;
  assert.ok(entries.some(e => e.current_event_ids.includes(seeded.fresh.source_event_id)));
  assert.ok(entries.some(e => e.structural_event_ids.includes(seeded.original.source_event_id)),
    'old existing parent may be structural lineage only');
  assert.ok(entries.every(e => !e.current_event_ids.includes(seeded.original.source_event_id)),
    'expired parent never reenters current support');
});

test('a fresh independent exchange supports follow-up without inventing ancestry from the expired hypothesis', async t => {
  const h = setup(t);
  const seeded = await expiredNeedWithFresh(h, t, { parentMode:'independent' });
  const context = h.service.followup.context(seeded.need.id);
  assert.equal(context.available,true,JSON.stringify({ reasons:context.reasons, scope:context.scope }));
  assert.ok(context.historical_evidence.some(e => e.source_event_id === seeded.original.source_event_id
    && e.reasons.includes('CONTINUITY_EVIDENCE_EXPIRED')));
  const scopes = context.scope.exchanges;
  assert.ok(scopes.some(e => e.current_event_ids.includes(seeded.fresh.source_event_id)));
  assert.ok(scopes.every(e => !e.structural_event_ids.includes(seeded.original.source_event_id)),
    'a distinct current exchange has no lineage to the old hypothesis source');
});

for (const parentMode of ['delete','unsupported','missing','revoke']) test(`required ${parentMode} ancestry/source authority blocks focused context`, async t => {
  const h = setup(t);
  const seeded = await expiredNeedWithFresh(h, t, { sameExchangeReply:true, parentMode });
  const context = h.service.followup.context(seeded.need.id);
  assert.equal(context.available,false,JSON.stringify({ mode:parentMode,reasons:context.reasons }));
  assert.ok(context.reasons.length > 0);
  assert.equal(context.scope?.exchanges?.some(e => e.current_event_ids.includes(seeded.fresh.source_event_id)), false,
    'blocked ancestry or revoked policy cannot promote the new child into current support');
});

test('loading context or holding only an ordinary grant never admits a focused attempt', async t => {
  const h = setup(t);
  const seeded = await expiredNeedWithFresh(h, t, { parentMode:'independent' });
  const selectedProfile = await profile(h);
  // Spend the finite ordinary grant on its own new sample before loading focused context.
  const ordinary = await h.service.attention.scope(seeded.goal.goal_id, selectedProfile.profile_id);
  const grant = await h.command('audience.attention_grant', { goal_id:seeded.goal.goal_id,
    expected_revision:ordinary.goal.revision, expected_scope_fingerprint:ordinary.fingerprint,
    model_profile_id:selectedProfile.profile_id, max_attempts:1,
    expires_at:new Date(Date.now()+60*60*1000).toISOString(), reason:'Ordinary discovery only.' });
  assert.ok(grant.grant_id);
  const ordinaryPass = finiteRuntime({ outputFor:context => modelOutputFrom(context.packet,{needs:[]}) });
  const ordinaryResult = await processAudienceAssessment(h.service,ordinaryPass.runtime);
  assert.equal(ordinaryPass.calls.length,1,'positive control: ordinary authority funds one ordinary sample');
  assert.equal(ordinaryResult.disposition,'no_need_proposed');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_attention_attempts WHERE grant_id=?',grant.grant_id).n,1);
  const context = h.service.followup.context(seeded.need.id);
  assert.equal(context.available,true);
  assert.equal(context.pending_request,null);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_followup_requests').n,0);
  // Do not create a focused request. A tick cannot borrow that separate authority.
  const fake = finiteRuntime();
  const result = await processAudienceAssessment(h.service, fake.runtime);
  assert.equal(fake.calls.length,0,JSON.stringify(result));
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_followup_attempts').n,0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs WHERE runtime=?',RUNTIME).n,1,
    'the separately authorized ordinary sample remains in history');
  assert.ok(fake.calls.every(call => !call.packet.followup),
    'ordinary authority never creates a focused packet');
});

test('a context preview is single-use against its exact source heads', async t => {
  const h = setup(t);
  const seeded = await expiredNeedWithFresh(h, t, { parentMode:'independent' });
  const selectedProfile = await profile(h);
  const preview = h.service.followup.context(seeded.need.id);
  assert.equal(preview.available,true);
  await ingestAt(h,seeded.clock,{ message_id:'event-after-preview',thread_id:'after-preview-thread',
    text:'This new event arrives after the owner preview.' });
  await assert.rejects(h.command('audience.followup_request',{ need_id:seeded.need.id,
    expected_revision:preview.need_revision,expected_basis_fingerprint:preview.need_basis_fingerprint,
    expected_context_fingerprint:preview.context_fingerprint,model_profile_id:selectedProfile.profile_id,
    expected_profile_hash:selectedProfile.definition_hash,expires_at:new Date(Date.now()+3600000).toISOString(),
    reason:'Must be refreshed after the source head advanced.' }));
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_followup_requests').n,0,
    'stale preview cannot create an authority record');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_followup_attempts').n,0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs WHERE runtime=?',RUNTIME).n,0);
});

for (const mutation of ['sourcehead','edit','needrevision','profile_revoke','request_revoke','cp_owner']) test(`late focused output is withheld after ${mutation} and usage/attempt remain`, async t => {
  const h = setup(t);
  const seeded = await expiredNeedWithFresh(h, t, { parentMode:'independent' });
  const selectedProfile = await profile(h);
  const preview = h.service.followup.context(seeded.need.id);
  assert.equal(preview.available,true);
  const { request } = await followupContextAndRequest(h, seeded.need, selectedProfile, preview);
  const needBeforeDispatch = h.store.get('SELECT revision,status,assessment_id,output_json,basis_json FROM audience_needs WHERE id=?',seeded.need.id);
  let callbackError;
  const fake = finiteRuntime({ outputFor:context => outputForFollowup(context.packet, seeded.need.id), before:async (run) => {
    try {
      if (mutation === 'sourcehead') {
        await ingestAt(h, seeded.clock, { message_id:'during-turn-new-head', thread_id:'later-thread',
          text:'A new source event arrived during the focused turn.' });
      } else if (mutation === 'edit') {
        await ingestAt(h, seeded.clock, { message_id:seeded.freshMessageId, version:2, thread_id:'fresh-followup-thread',
          text:'The selected fresh item was corrected during the turn.' });
      } else if (mutation === 'needrevision') {
        h.store.run('UPDATE audience_needs SET revision=revision+1 WHERE id=?', seeded.need.id);
      } else if (mutation === 'profile_revoke') {
        await h.command('model.profile_revoke', { profile_id:selectedProfile.profile_id,
          expected_definition_hash:selectedProfile.definition_hash, reason:'Synthetic late-turn revocation.' });
      } else if (mutation === 'request_revoke') {
        const saved = h.service.followup.detail(request.request_id ?? request.id);
        await h.command('audience.followup_revoke', { request_id:saved.request_id,
          expected_request_fingerprint:saved.request_fingerprint, reason:'Synthetic late-turn request revocation.' });
      } else if (mutation === 'cp_owner') h.service.control.close();
      else assert.fail(`unhandled mutation ${mutation}`);
    } catch (error) { callbackError = error; }
  } });
  const result = await processAudienceAssessment(h.service, fake.runtime);
  assert.equal(callbackError,undefined,`mutation setup succeeds: ${callbackError?.stack ?? ''}`);
  assert.equal(fake.calls.length,1,'one finite provider turn ran before the late mutation');
  assert.notEqual(result.disposition,'proposal_created',JSON.stringify(result));
  const attempt = h.store.get('SELECT * FROM audience_followup_attempts WHERE request_id=?',request.request_id ?? request.id);
  assert.ok(attempt,'late withheld output does not erase the consumed attempt');
  const run = h.store.get('SELECT * FROM runs WHERE id=?',fake.calls[0].run_id);
  assert.equal(run.input_tokens,37);
  assert.equal(run.output_tokens,19);
  const needAfterDispatch = h.store.get('SELECT revision,status,assessment_id,output_json,basis_json FROM audience_needs WHERE id=?',seeded.need.id);
  assert.equal(needAfterDispatch.revision, needBeforeDispatch.revision + (mutation === 'needrevision' ? 1 : 0),
    'late withheld output cannot add a revision beyond the explicit concurrent revision mutation');
  for (const field of ['status','assessment_id','output_json','basis_json'])
    assert.equal(needAfterDispatch[field],needBeforeDispatch[field],`late withheld output preserves need ${field}`);
});

for (const missing of ['request','attempt']) test(`missing ${missing} provenance cannot make a follow-up revision legacy-acceptable`, async t => {
  const h = setup(t);
  const seeded = await expiredNeedWithFresh(h, t, { parentMode:'independent' });
  const selectedProfile = await profile(h);
  const { request } = await followupContextAndRequest(h, seeded.need, selectedProfile);
  const fake = finiteRuntime({ outputFor:context => outputForFollowup(context.packet, seeded.need.id) });
  const result = await processAudienceAssessment(h.service, fake.runtime);
  assert.equal(result.disposition,'proposal_created');
  const requestId = request.request_id ?? request.id;
  if (missing === 'request') {
    h.store.db.exec('PRAGMA foreign_keys=OFF');
    h.store.run('DELETE FROM audience_followup_requests WHERE id=?',requestId);
    h.store.db.exec('PRAGMA foreign_keys=ON');
    assert.ok(h.store.all('PRAGMA foreign_key_check').length > 0,
      'the deliberate orphan is present only after FK enforcement was disabled outside a transaction');
  }
  else h.store.run('DELETE FROM audience_followup_attempts WHERE request_id=?',requestId);
  await assert.rejects(Promise.resolve().then(() => h.service.audience.need(seeded.need.id)),
    { code:'AUDIENCE_RECORD_INVALID' });
  const need = h.store.get('SELECT revision,status FROM audience_needs WHERE id=?',seeded.need.id);
  assert.equal(need.status,'proposed');
  assert.ok(need.revision > seeded.need.revision);
  await assert.rejects(h.command('audience.review', { need_id:seeded.need.id, expected_revision:need.revision,
    expected_basis_fingerprint:'a'.repeat(64), decision:'accept', note:'Must not accept without follow-up proof.' }),
  { code:'AUDIENCE_RECORD_INVALID' });
});

test('a corrupt pending follow-up request is skipped without starving a healthy goal turn', async t => {
  const h = setup(t);
  const a = await expiredNeedWithFresh(h, t, { parentMode:'independent' });
  const profileA = await profile(h);
  const requestedA = await followupContextAndRequest(h, a.need, profileA);

  const goalB = await h.open({ title:'Healthy B', objective:'Observe independent B.', source_ids:[SOURCE_B], max_age_seconds:3600 });
  await ingestAt(h,a.clock,{ message_id:'healthy-b-question', source_id:SOURCE_B, thread_id:'healthy-b-thread',
    text:'A separate current question for goal B.' });
  h.service.audience.reconcile({ limit:10 });
  const profileB = await profile(h);
  const ordinaryScopeB = h.service.attention.scope(goalB.goal_id, profileB.profile_id);
  const grantB = await h.command('audience.attention_grant', { goal_id:goalB.goal_id,
    expected_revision:ordinaryScopeB.goal.revision, expected_scope_fingerprint:ordinaryScopeB.fingerprint,
    model_profile_id:profileB.profile_id, max_attempts:1,
    expires_at:new Date(Date.now()+60*60*1000).toISOString(), reason:'Healthy ordinary B control.' });
  assert.ok(grantB.grant_id);
  h.store.run('DELETE FROM audience_followup_requests WHERE id=?',requestedA.request.request_id ?? requestedA.request.id);
  h.store.run('INSERT INTO channel_offsets VALUES(?,?,?) ON CONFLICT(channel,account_id) DO UPDATE SET cursor=excluded.cursor',
    'audience-reason-v1',h.config.partnerId,goalB.goal_id);

  let callbackError;
  const fake = finiteRuntime({ before:async () => { /* no mutation: provider fixture must be reached for B */ } });
  const result = await processAudienceAssessment(h.service, fake.runtime);
  assert.equal(callbackError,undefined);
  assert.equal(fake.calls.length,1,JSON.stringify(result));
  assert.equal(fake.calls[0].goal_id,goalB.goal_id,'healthy ordinary B progresses after corrupt A follow-up is skipped');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_attention_attempts WHERE grant_id=?',grantB.grant_id).n,1);
});

test('a focused revision never inherits old accepted need, Work, material, or Action state', async t => {
  const h = setup(t);
  const seeded = await acceptedNeed(h, { maxAge:3600, proposalOverrides:{ next_step:'prepare_material' } });
  const originalNeedRevision = seeded.need.revision;
  const originalNeedBasis = seeded.need.basis_fingerprint;
  const openedWork = await h.command('audience.open_work', { need_id:seeded.need.id,
    expected_revision:seeded.need.revision, expected_basis_fingerprint:seeded.need.basis_fingerprint });
  const turn = h.service.continuity.turn(openedWork.turn_id);
  await h.command('continuity.review', { turn_id:turn.id, expected_basis_fingerprint:turn.basis_fingerprint,
    decision:'accept', note:'Accept original synthetic work interpretation.' });
  const thread = h.service.continuity.detail(openedWork.thread_id);
  const openedCase = await h.command('work.open', { thread_id:openedWork.thread_id,
    expected_basis_fingerprint:thread.basis_fingerprint, title:'Original reviewed work' });
  let workCase = h.service.work.detail(openedCase.case_id);
  const imported = await h.command('audience.import_preview', { need_id:seeded.need.id,
    expected_revision:seeded.need.revision, expected_basis_fingerprint:seeded.need.basis_fingerprint,
    case_id:openedCase.case_id, expected_case_revision:workCase.revision,
    expected_preview_sha256:seeded.need.preview_sha256 });
  workCase = h.service.work.detail(openedCase.case_id);
  await h.command('work.review', { case_id:openedCase.case_id, expected_revision:workCase.revision,
    material_id:imported.material_id, sha256:imported.sha256, decision:'approve',
    note:'Approve only the exact original material.' });
  workCase = h.service.work.detail(openedCase.case_id);
  h.config.actions.enabled = true;
  const oldAction = await h.command('work.prepare_action', { case_id:openedCase.case_id,
    expected_revision:workCase.revision, material_id:imported.material_id,
    capability_id:'material.export_local.v1' });
  assert.equal(h.service.actions.detail(oldAction.action_id).status,'proposed');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM drafts').n,0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM delivery_attempts').n,0);

  await h.ingest({ message_id:'fresh-followup-for-inheritance', thread_id:'new-followup-thread',
    text:'The first step is complete; I need help with what follows.' });
  h.service.audience.reconcile({ limit:10 });
  const selectedProfile = await profile(h);
  const context = h.service.followup.context(seeded.need.id);
  assert.equal(context.available,true);
  const { request } = await followupContextAndRequest(h, seeded.need, selectedProfile, context);
  const fake = finiteRuntime({ outputFor:focusContext => outputForFollowup(focusContext.packet,seeded.need.id) });
  const result = await processAudienceAssessment(h.service,fake.runtime);
  assert.equal(result.disposition,'proposal_created');

  const revised = h.service.audience.need(seeded.need.id);
  assert.equal(revised.status,'proposed','updated proposal requires a new owner acceptance');
  assert.equal(revised.revision,originalNeedRevision+1);
  assert.notEqual(revised.basis_fingerprint,originalNeedBasis,'fresh evidence creates a new immutable need basis');
  assert.equal(revised.thread_id,openedWork.thread_id,'historical Work link remains attributable to its earlier revision');
  const historicalWork = h.service.work.detail(openedCase.case_id);
  assert.equal(historicalWork.current,false,'old Work case is no longer current for the revised need');
  assert.equal(historicalWork.material.status,'approved','old approval remains historical on its old case, not inherited');
  assert.equal(h.service.actions.detail(oldAction.action_id).current,false,'old Action proposal cannot be applied to the new need revision');
  assert.equal(h.service.actions.detail(oldAction.action_id).status,'proposed','follow-up does not create an approval or execution');
  assert.ok(h.service.followup.detail(request.request_id ?? request.id));
  for (const table of ['persons','conversations','drafts','delivery_attempts'])
    assert.equal(h.store.get(`SELECT COUNT(*) n FROM ${table}`).n,0,`${table} remains untouched`);
});
