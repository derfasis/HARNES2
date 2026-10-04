// Adversarial read-time and recovery checks for scoped Audience profiles.
// All evidence/provider behavior is synthetic and stays in-process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { audienceHarness, SOURCE, SOURCE_B, modelOutputFrom, proposalFrom } from './audience-test-helpers.mjs';
import { processAudienceAssessment } from '../business/audience-reasoning.mjs';

const PROFILE_URL = 'https://models.example.test/v1';
const RUNTIME = 'hermes-audience-v1';

function sentinel(t) {
  const previous = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'offline-kill-fixture-never-sent';
  t.after(() => previous === undefined ? delete process.env.PARTNER_MODEL_API_KEY
    : process.env.PARTNER_MODEL_API_KEY = previous);
}

function configure(h) {
  h.config.runtime.enabled = false;
  h.config.runtime.baseUrl = '';
  h.config.runtime.model = '';
  h.config.runtime.dailyBudgetUsd = 5;
  h.config.runtime.inputUsdPerMillion = null;
  h.config.runtime.outputUsdPerMillion = null;
  h.config.audience.modelEnabled = false;
  h.config.audience.maxRunsPerDay = 20;
  h.config.runtime.maxRunsPerDay = 50;
  h.config.modelProfiles = { allowedBaseUrls: [PROFILE_URL] };
}

const profilePayload = (overrides = {}) => ({ label:'Bounded offline profile', provider:'custom',
  api_mode:'chat_completions', base_url:PROFILE_URL, model:'offline-kill-model', max_output_tokens:800,
  input_usd_per_million:null, output_usd_per_million:null, ...overrides });

async function createProfile(h, overrides = {}) {
  return h.command('model.profile_create', profilePayload(overrides));
}

async function observed(h, name = 'kill') {
  const goal = await h.open({ title:`Synthetic ${name}`, objective:`Review ${name} evidence.`, source_ids:[SOURCE] });
  await h.ingest({ message_id:`${name}-event`, text:'How do I handle the next step?' });
  h.service.audience.reconcile({ limit:10 });
  const detail = h.service.audience.detail(goal.goal_id);
  assert.equal(detail.ready, true, 'positive control: source evidence is current and packet-ready');
  return { goal, detail };
}

async function grantProfile(h, goalId, profile, maxAttempts = 1) {
  const detail = h.service.audience.detail(goalId);
  const option = detail.attention.profile_options.find(p => p.profile_id === profile.profile_id || p.id === profile.profile_id);
  assert.ok(option, 'positive control: profile is visible in goal-scoped preview');
  assert.equal(option.can_grant, true);
  return h.command('audience.attention_grant', { goal_id:goalId, expected_revision:detail.revision,
    expected_scope_fingerprint:option.scope_fingerprint, model_profile_id:profile.profile_id,
    max_attempts:maxAttempts, expires_at:new Date(Date.now()+3600000).toISOString(),
    reason:'One finite adversarial offline attempt.' });
}

function successfulRuntime(before = async () => {}, outputForPacket = modelOutputFrom) {
  let calls = 0;
  return { get calls() { return calls; }, runtime:{ decide:async (run, context) => {
    calls++;
    await before(run, context);
    return { completed:true, final_response:JSON.stringify(outputForPacket(context.packet)),
      usage:{input_tokens:31,output_tokens:13}, model_identity:{model_id:'offline-kill-model',model_version:'fixture-v1'}, api_calls:1 };
  } } };
}

test('profile schema rejects secret fields and unsafe or untrusted credential destinations', async t => {
  const h = audienceHarness(t); configure(h);
  const bad = [
    [{ api_key:'never-store-this' }, 'MODEL_PROFILE_INVALID'],
    [{ credential:'never-store-this' }, 'MODEL_PROFILE_INVALID'],
    [{ secret_name:'PARTNER_MODEL_API_KEY' }, 'MODEL_PROFILE_INVALID'],
    [{ base_url:'https://user:pass@models.example.test/v1' }, 'MODEL_PROFILE_INVALID'],
    [{ base_url:'https://models.example.test/v1?key=secret' }, 'MODEL_PROFILE_INVALID'],
    [{ base_url:'https://models.example.test/v1#token' }, 'MODEL_PROFILE_INVALID'],
    [{ base_url:'http://remote.example.test/v1' }, 'MODEL_PROFILE_INVALID'],
    [{ max_output_tokens:127 }, 'MODEL_PROFILE_INVALID'],
    [{ input_usd_per_million:-0.01 }, 'MODEL_PROFILE_INVALID'],
    [{ provider:'unsafe provider' }, 'MODEL_PROFILE_INVALID'],
    [{ base_url:'https://other.example.test/v1' }, 'MODEL_PROFILE_ENDPOINT_NOT_ALLOWED'],
  ];
  for (const [overrides, code] of bad) await assert.rejects(createProfile(h, overrides), { code }, JSON.stringify(overrides));
  assert.equal(h.store.get('SELECT COUNT(*) n FROM model_profiles').n, 0, 'invalid metadata never persists');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 0, 'profile validation makes no model calls');
});

test('one corrupt profile is isolated in listing and leaves its healthy neighbor selectable', async t => {
  const h = audienceHarness(t); configure(h);
  const healthy = await createProfile(h, { label:'Healthy neighbor' });
  const corrupt = await createProfile(h, { label:'Corruption target' });
  h.store.run('UPDATE model_profiles SET definition_json=? WHERE id=?', '{"version":1}', corrupt.profile_id);
  const listing = h.service.modelProfiles.list();
  const healthyView = listing.profiles.find(p => p.id === healthy.profile_id);
  const corruptView = listing.profiles.find(p => p.id === corrupt.profile_id);
  assert.equal(healthyView.state, 'available');
  assert.equal(healthyView.definition_hash, healthy.definition_hash);
  assert.equal(corruptView.state, 'invalid');
  assert.ok(corruptView.block_reasons.includes('MODEL_PROFILE_INVALID'));
  assert.equal(listing.credential_ready, false, 'only a readiness boolean is exposed');
  assert.equal(JSON.stringify(listing).includes('PARTNER_MODEL_API_KEY'), false, 'no secret name/value is returned');
});

test('a captured manual ordinary packet cannot borrow a later profile grant', async t => {
  sentinel(t);
  const h = audienceHarness(t); configure(h);
  const { goal } = await observed(h, 'manual-pending');
  const captured = await h.capture(goal.goal_id);
  const profile = await createProfile(h);
  const grant = await grantProfile(h, goal.goal_id, profile);
  const fake = successfulRuntime();
  const result = await processAudienceAssessment(h.service, fake.runtime);
  assert.equal(fake.calls, 0);
  assert.equal(h.service.audience.assessment(captured.assessment_id).status, 'captured');
  assert.equal(h.service.audience.assessment(captured.assessment_id).producer, 'operator');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_attention_attempts WHERE grant_id=?', grant.grant_id).n, 0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs WHERE runtime=?', RUNTIME).n, 0);
  assert.notEqual(result.disposition, 'proposal_created');
});

test('source edit, delete, or revocation during a fake call withholds its late proposal and retains usage', async t => {
  sentinel(t);
  for (const change of ['edit','delete','revoke']) {
    const h = audienceHarness(t); configure(h);
    const { goal } = await observed(h, `late-${change}`);
    const profile = await createProfile(h);
    await grantProfile(h, goal.goal_id, profile);
    let callbackError;
    const fake = successfulRuntime(async () => {
      try {
        if (change === 'revoke') {
          h.config.opportunity.allowedSourceRefs = [];
          const afterRevocation = h.service.audience.detail(goal.goal_id);
          assert.equal(afterRevocation.watches[0].health.current, false, 'policy change revokes the watched source');
        } else {
          await h.ingest({ message_id:`late-${change}-event`, version:2,
            operation:change === 'delete' ? 'delete' : 'upsert',
            text:change === 'delete' ? null : 'Correction: that problem no longer applies.',
            updated_at:'2026-01-01T00:01:00.000Z' });
          h.service.audience.reconcile({ limit:10 });
          const row = h.service.audience.assessment(h.store.get('SELECT id FROM audience_assessments WHERE goal_id=?', goal.goal_id).id);
          assert.equal(row.current, false, 'changed canonical source makes the frozen run basis stale');
        }
      } catch (error) { callbackError = error; }
    });
    const result = await processAudienceAssessment(h.service, fake.runtime);
    assert.equal(callbackError, undefined, `callback setup completed for ${change}: ${callbackError?.stack ?? ''}`);
    assert.equal(fake.calls, 1);
    assert.notEqual(result.disposition, 'proposal_created', `${change} blocks late application`);
    const run = h.store.get('SELECT * FROM runs WHERE runtime=?', RUNTIME);
    assert.equal(run.status, 'failed');
    assert.equal(run.input_tokens, 31);
    assert.equal(run.output_tokens, 13);
    assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs WHERE goal_id=?', goal.goal_id).n, 0);
  }
});

test('lost Control Plane ownership withholds late output without refunding the call', async t => {
  sentinel(t);
  const h = audienceHarness(t); configure(h);
  const { goal } = await observed(h, 'owner-loss');
  const profile = await createProfile(h);
  await grantProfile(h, goal.goal_id, profile);
  let callbackError;
  const fake = successfulRuntime(async () => {
    try { h.service.control.close(); }
    catch (error) { callbackError = error; }
  });
  const result = await processAudienceAssessment(h.service, fake.runtime);
  assert.equal(callbackError, undefined);
  assert.equal(fake.calls, 1);
  assert.notEqual(result.disposition, 'proposal_created');
  const run = h.store.get('SELECT * FROM runs WHERE runtime=?', RUNTIME);
  assert.equal(run.status, 'failed');
  assert.equal(run.input_tokens, 31);
  assert.equal(run.output_tokens, 13);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs WHERE goal_id=?', goal.goal_id).n, 0);
});

test('profile-bound decision receipt becomes invalid after persisted profile or grant proof corruption', async t => {
  sentinel(t);
  const mutations = [
    ['frozen profile id', (h, run) => {
      const context = JSON.parse(run.context_json); context.model_profile.id = 'foreign-profile';
      h.store.run('UPDATE runs SET context_json=? WHERE id=?', JSON.stringify(context), run.id);
    }],
    ['frozen profile hash', (h, run) => {
      const context = JSON.parse(run.context_json); context.model_profile.definition_hash = '0'.repeat(64);
      h.store.run('UPDATE runs SET context_json=? WHERE id=?', JSON.stringify(context), run.id);
    }],
    ['frozen model configuration', (h, run) => {
      const context = JSON.parse(run.context_json); context.model_config.baseUrl = 'https://changed.example.test/v1';
      h.store.run('UPDATE runs SET context_json=? WHERE id=?', JSON.stringify(context), run.id);
    }],
    ['receipt profile id', (h, run) => {
      const receipt = JSON.parse(run.result_json); receipt.model_profile.id = 'foreign-profile';
      h.store.run('UPDATE runs SET result_json=? WHERE id=?', JSON.stringify(receipt), run.id);
    }],
    ['receipt profile hash', (h, run) => {
      const receipt = JSON.parse(run.result_json); receipt.model_profile.definition_hash = '0'.repeat(64);
      h.store.run('UPDATE runs SET result_json=? WHERE id=?', JSON.stringify(receipt), run.id);
    }],
    ['missing receipt profile', (h, run) => {
      const receipt = JSON.parse(run.result_json); delete receipt.model_profile;
      h.store.run('UPDATE runs SET result_json=? WHERE id=?', JSON.stringify(receipt), run.id);
    }],
    ['missing grant binding', (h, run) => {
      h.store.run('DELETE FROM audience_attention_models WHERE grant_id=(SELECT grant_id FROM audience_attention_attempts WHERE run_id=?)', run.id);
    }],
    ['tampered grant binding', (h, run) => {
      h.store.run('UPDATE audience_attention_models SET definition_hash=? WHERE grant_id=(SELECT grant_id FROM audience_attention_attempts WHERE run_id=?)', '0'.repeat(64), run.id);
    }],
  ];
  for (const [label, mutate] of mutations) await t.test(label, async t => {
    const h = audienceHarness(t); configure(h);
    const { goal } = await observed(h, `read-proof-${label.replaceAll(' ','-')}`);
    const profile = await createProfile(h);
    await grantProfile(h, goal.goal_id, profile);
    const fake = successfulRuntime();
    const result = await processAudienceAssessment(h.service, fake.runtime);
    assert.equal(result.disposition, 'proposal_created', `positive control for ${label}`);
    const before = h.service.audience.assessment(result.assessment_id);
    assert.equal(before.decision_review.state, 'current', `healthy receipt is current before ${label}`);
    assert.ok(before.decision_review.review);
    const run = h.store.get('SELECT * FROM runs WHERE runtime=?', RUNTIME);
    assert.equal(run.status, 'completed');
    mutate(h, run);
    const after = h.service.audience.assessment(result.assessment_id);
    assert.equal(after.current, true, 'evidence freshness is intentionally independent of model-authenticity proof');
    assert.equal(after.decision_review.state, 'invalid', `${label} must not retain a current model interpretation`);
    assert.equal(after.decision_review.review, null, `${label} hides the unbound interpretation`);
  });
});

function corruptCompletedProfileProof(h, run) {
  const context = JSON.parse(run.context_json);
  context.model_profile.definition_hash = '0'.repeat(64);
  h.store.run('UPDATE runs SET context_json=? WHERE id=?', JSON.stringify(context), run.id);
}

test('corrupt modern model proof blocks need display and owner acceptance while a valid revoked profile keeps its history', async t => {
  sentinel(t);
  const h = audienceHarness(t); configure(h);
  const { goal } = await observed(h, 'need-proof-review');
  const profile = await createProfile(h);
  await grantProfile(h, goal.goal_id, profile);
  const fake = successfulRuntime();
  const result = await processAudienceAssessment(h.service, fake.runtime);
  assert.equal(result.disposition, 'proposal_created');
  const id = h.store.get('SELECT id FROM audience_needs WHERE goal_id=?', goal.goal_id).id;
  const before = h.service.audience.need(id);
  assert.equal(before.current, true, 'positive control: source basis and model proof are valid');
  const beforeAssessment = h.service.audience.assessment(result.assessment_id);
  assert.equal(beforeAssessment.decision_review.state, 'current');

  const run = h.store.get('SELECT * FROM runs WHERE runtime=?', RUNTIME);
  corruptCompletedProfileProof(h, run);
  const invalidAssessment = h.service.audience.assessment(result.assessment_id);
  assert.equal(invalidAssessment.decision_review.state, 'invalid');
  assert.equal(invalidAssessment.current, true, 'source evidence remains current independently of proof integrity');
  assert.throws(() => h.service.audience.need(id), { code:'AUDIENCE_RECORD_INVALID' });
  await assert.rejects(h.command('audience.review', { need_id:id, expected_revision:before.revision,
    expected_basis_fingerprint:before.basis_fingerprint, decision:'accept', note:'Attempt acceptance after proof corruption.' }),
  { code:'AUDIENCE_RECORD_INVALID' });

  // A later profile revocation blocks new authority but does not rewrite a valid
  // completed interpretation or make its independently current need disappear.
  const h2 = audienceHarness(t); configure(h2);
  const seeded = await observed(h2, 'historical-profile-revoke');
  const historicalProfile = await createProfile(h2);
  await grantProfile(h2, seeded.goal.goal_id, historicalProfile);
  const historicalResult = await processAudienceAssessment(h2.service, successfulRuntime().runtime);
  assert.equal(historicalResult.disposition, 'proposal_created');
  const historicalNeedId = h2.store.get('SELECT id FROM audience_needs WHERE goal_id=?', seeded.goal.goal_id).id;
  const revoked = await h2.command('model.profile_revoke', { profile_id:historicalProfile.profile_id,
    expected_definition_hash:historicalProfile.definition_hash, reason:'Keep prior decision as historical evidence.' });
  assert.equal(revoked.state, 'revoked');
  assert.equal(h2.service.audience.assessment(historicalResult.assessment_id).decision_review.state, 'current');
  assert.equal(h2.service.audience.need(historicalNeedId).current, true);
});

test('accepted model need cannot open more work or import material after its completed proof is corrupted', async t => {
  sentinel(t);
  const h = audienceHarness(t); configure(h);
  const { goal } = await observed(h, 'accepted-work-proof');
  const profile = await createProfile(h);
  await grantProfile(h, goal.goal_id, profile);
  const materialOutput = packet => modelOutputFrom(packet,
    proposalFrom(packet, { next_step:'prepare_material' }));
  const result = await processAudienceAssessment(h.service, successfulRuntime(async () => {}, materialOutput).runtime);
  assert.equal(result.disposition, 'proposal_created');
  const needId = h.store.get('SELECT id FROM audience_needs WHERE goal_id=?', goal.goal_id).id;
  let need = h.service.audience.need(needId);
  await h.command('audience.review', { need_id:needId, expected_revision:need.revision,
    expected_basis_fingerprint:need.basis_fingerprint, decision:'accept', note:'Accept synthetic supported need.' });
  need = h.service.audience.need(needId);
  const staged = await h.command('audience.open_work', { need_id:needId,
    expected_revision:need.revision, expected_basis_fingerprint:need.basis_fingerprint });
  const turn = h.service.continuity.turn(staged.turn_id);
  await h.command('continuity.review', { turn_id:turn.id, expected_basis_fingerprint:turn.basis_fingerprint,
    decision:'accept', note:'Accept bounded synthetic Continuity proposal.' });
  const thread = h.service.continuity.detail(staged.thread_id);
  const opened = await h.command('work.open', { thread_id:staged.thread_id,
    expected_basis_fingerprint:thread.basis_fingerprint, title:'Prepare synthetic material' });
  const workCase = h.service.work.detail(opened.case_id);
  const imported = await h.command('audience.import_preview', { need_id:needId, expected_revision:need.revision,
    expected_basis_fingerprint:need.basis_fingerprint, case_id:opened.case_id,
    expected_case_revision:workCase.revision, expected_preview_sha256:need.preview_sha256 });
  assert.ok(imported.material_id, 'positive control: valid accepted preview imports into its current work case');

  const run = h.store.get('SELECT * FROM runs WHERE runtime=?', RUNTIME);
  corruptCompletedProfileProof(h, run);
  await assert.rejects(h.command('audience.open_work', { need_id:needId, expected_revision:need.revision,
    expected_basis_fingerprint:need.basis_fingerprint }), { code:'AUDIENCE_RECORD_INVALID' });
  await assert.rejects(h.command('audience.import_preview', { need_id:needId, expected_revision:need.revision,
    expected_basis_fingerprint:need.basis_fingerprint, case_id:opened.case_id,
    expected_case_revision:workCase.revision, expected_preview_sha256:need.preview_sha256 }),
  { code:'AUDIENCE_RECORD_INVALID' });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM work_materials WHERE case_id=?', opened.case_id).n, 1,
    'proof corruption cannot create or replay another material import');
});

test('corrupt prior proof for one eligible goal does not starve a healthy goal later in the bounded cursor pass', async t => {
  sentinel(t);
  const h = audienceHarness(t); configure(h);
  h.config.runtime.dailyBudgetUsd = null;

  const { goal:goalA } = await observed(h, 'isolation-a');
  const profileA = await createProfile(h, { label:'Goal A profile' });
  const grantA = await grantProfile(h, goalA.goal_id, profileA, 2);
  const first = await processAudienceAssessment(h.service, successfulRuntime().runtime);
  assert.equal(first.disposition, 'proposal_created');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_attention_attempts WHERE grant_id=?', grantA.grant_id).n, 1);

  await h.ingest({ message_id:'isolation-a-new-context', thread_id:'a-later-thread', text:'A later independent question.' });
  h.service.audience.reconcile({ limit:10 });
  const watchA = h.service.audience.watches(goalA.goal_id)[0];
  assert.equal(h.service.audience.health(watchA).current, true, 'A source remains current');
  assert.ok(h.store.get('SELECT COUNT(*) n FROM audience_exchanges WHERE goal_id=? AND considered_fingerprint IS NULL', goalA.goal_id).n > 0,
    'A has fresh unconsidered context and one remaining attempt');
  const runA = h.store.get('SELECT * FROM runs WHERE runtime=? AND id=(SELECT run_id FROM audience_assessments WHERE id=?)',
    RUNTIME, first.assessment_id);
  const receiptA = JSON.parse(runA.result_json);
  receiptA.model_profile.id = 'foreign-profile';
  h.store.run('UPDATE runs SET result_json=? WHERE id=?', JSON.stringify(receiptA), runA.id);

  const goalB = await h.open({ title:'Healthy goal B', objective:'Review B evidence.', source_ids:[SOURCE_B] });
  await h.ingest({ message_id:'isolation-b-question', source_id:SOURCE_B, text:'How should I begin with this separate topic?' });
  h.service.audience.reconcile({ limit:10 });
  const detailB = h.service.audience.detail(goalB.goal_id);
  assert.equal(detailB.ready, true, 'B has a current packet-ready source');
  const profileB = await createProfile(h, { label:'Goal B profile' });
  const grantB = await grantProfile(h, goalB.goal_id, profileB);

  // Continue after B, which wraps the bounded cursor to A first regardless of UUID ordering.
  h.store.run('INSERT INTO channel_offsets VALUES(?,?,?) ON CONFLICT(channel,account_id) DO UPDATE SET cursor=excluded.cursor',
    'audience-reason-v1', h.config.partnerId, goalB.goal_id);
  let callbackError;
  const calls = [];
  const pass = await processAudienceAssessment(h.service, { decide:async (run, context) => {
    try { calls.push(JSON.parse(run.context_json).goal_id); }
    catch (error) { callbackError = error; }
    return { completed:true, final_response:JSON.stringify(modelOutputFrom(context.packet)),
      usage:{input_tokens:31,output_tokens:13}, model_identity:{model_id:'offline-kill-model',model_version:'fixture-v1'}, api_calls:1 };
  } });

  assert.equal(callbackError, undefined);
  assert.equal(calls.length, 1, 'one normal finite model turn was spent');
  assert.deepEqual(calls, [goalB.goal_id], 'A is quarantined per-goal and the same pass advances to healthy B');
  assert.equal(pass.goal_id, goalB.goal_id);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs WHERE runtime=?', RUNTIME).n, 2,
    'the corrupted A proof did not create or rebill an A run');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_attention_attempts WHERE grant_id=?', grantA.grant_id).n, 1,
    'A allowance is retained, not refunded or consumed');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_attention_attempts WHERE grant_id=?', grantB.grant_id).n, 1,
    'only B receives the new attempt');
  assert.throws(() => h.service.audience.need(h.store.get('SELECT id FROM audience_needs WHERE goal_id=?', goalA.goal_id).id),
    { code:'AUDIENCE_RECORD_INVALID' }, 'A corrupted historical proof stays withheld after scheduler recovery');
});
