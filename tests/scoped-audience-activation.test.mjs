// Scoped Audience activation acceptance. Synthetic sources and an injected model
// keep these tests offline; the credential sentinel is never sent to a provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { audienceHarness, SOURCE, SOURCE_B, modelOutputFrom, proposalFrom } from './audience-test-helpers.mjs';
import { processAudienceAssessment } from '../business/audience-reasoning.mjs';
import { Scheduler } from '../business/scheduler.mjs';

const AUDIENCE_RUNTIME = 'hermes-audience-v1';
const PROFILE_URL = 'https://models.example.test/v1';

function sentinel(t) {
  const previous = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'offline-scoped-profile-sentinel-never-sent';
  t.after(() => {
    if (previous === undefined) delete process.env.PARTNER_MODEL_API_KEY;
    else process.env.PARTNER_MODEL_API_KEY = previous;
  });
}

function configureProfiles(h) {
  // Deliberately leave the global provider disabled and unconfigured. A profile
  // endpoint is allowed only by this server-side fixture policy.
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

async function observed(h, sourceId = SOURCE, prefix = 'scoped') {
  const goal = await h.open({ source_ids: [sourceId], objective: `Review only ${prefix} evidence.` });
  await h.ingest({ source_id: sourceId, message_id: `${prefix}-question`, text: 'How can I begin?' });
  h.service.audience.reconcile({ limit: 10 });
  const detail = h.service.audience.detail(goal.goal_id);
  assert.equal(detail.ready, true, 'positive control: a current synthetic exchange is available');
  return { goal, detail };
}

const profileDefinition = (overrides = {}) => ({
  label: 'Offline bounded profile', provider: 'custom', api_mode: 'chat_completions',
  base_url: PROFILE_URL, model: 'offline-profile-model', max_output_tokens: 1200,
  input_usd_per_million: 2, output_usd_per_million: 3, ...overrides,
});

async function createProfile(h, overrides = {}, request = undefined, actor = { kind: 'operator' }) {
  const result = await h.command('model.profile_create', profileDefinition(overrides), request, actor);
  return { ...result, profile_id: result.profile_id ?? result.id };
}

function profileOption(detail, profileId) {
  const options = detail.attention?.profile_options;
  assert.ok(Array.isArray(options), 'goal detail exposes per-profile activation previews');
  const option = options.find(row => row.profile_id === profileId || row.id === profileId);
  assert.ok(option, `profile ${profileId} appears in goal activation options`);
  return option;
}

async function grantProfile(h, goalId, profileId, { max_attempts = 1, expires_at = new Date(Date.now() + 3600000).toISOString() } = {}) {
  const detail = h.service.audience.detail(goalId);
  const option = profileOption(detail, profileId);
  assert.equal(option.can_grant, true, 'positive control: selected profile grant is available');
  assert.equal(option.profile_id, profileId);
  assert.match(option.scope_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(option.model_ready, true);
  assert.ok(Array.isArray(option.block_reasons));
  return h.command('audience.attention_grant', {
    goal_id: goalId, expected_revision: detail.revision,
    expected_scope_fingerprint: option.scope_fingerprint,
    model_profile_id: profileId, max_attempts, expires_at,
    reason: 'One bounded offline product acceptance attempt.',
  });
}

function successfulFake({ before = async () => {}, after = async () => {} } = {}) {
  let calls = 0;
  return { get calls() { return calls; }, runtime: { decide: async (run, context) => {
    calls++;
    await before(run, context);
    const packet = context.packet ?? JSON.parse(run.context_json).packet;
    const result = { completed: true, final_response: JSON.stringify(modelOutputFrom(packet)),
      usage: { input_tokens: 41, output_tokens: 19 },
      model_identity: { model_id: 'offline-profile-model', model_version: 'fixture-v1' }, api_calls: 1 };
    await after(run, context, result);
    return result;
  } } };
}

async function acceptedNeed(h, sourceId, prefix) {
  const { goal } = await observed(h, sourceId, prefix);
  const capture = await h.capture(goal.goal_id);
  const packet = h.service.audience.assessment(capture.assessment_id).packet;
  const proposal = await h.command('audience.propose', { assessment_id: capture.assessment_id,
    output: proposalFrom(packet) });
  let need = h.service.audience.need(proposal.need_ids[0]);
  await h.command('audience.review', { need_id: need.id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint, decision: 'accept', note: 'Synthetic accepted fixture.' });
  need = h.service.audience.need(need.id);
  return { goal, need };
}

test('profile create/list/revoke are operator-owned, immutable metadata, and never change global switches', async t => {
  const h = audienceHarness(t); configureProfiles(h);
  const { goal } = await observed(h);
  const before = structuredClone(h.config.runtime);
  const requestId = 'a0101010-1010-4010-8010-101010101010';
  const created = await createProfile(h, {}, requestId);
  await assert.rejects(createProfile(h, {}, requestId, { kind: 'agent' }),
    { code: 'MODEL_PROFILE_OPERATOR_REQUIRED' }, 'actor scope is checked before a prior command receipt');
  const replay = await createProfile(h, {}, requestId);
  assert.deepEqual(replay, created);
  assert.ok(created.profile_id && created.definition_hash);
  assert.deepEqual(h.config.runtime, before, 'profile metadata does not configure or enable the global provider');
  assert.equal(h.config.audience.modelEnabled, false);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 0, 'profile creation makes no model run');

  const profiles = h.service.modelProfiles.list();
  assert.ok(profiles.profiles.some(row => row.id === created.profile_id && row.definition_hash === created.definition_hash));
  const stored = profiles.profiles.find(row => row.id === created.profile_id);
  assert.deepEqual(Object.keys(stored).sort(), ['block_reasons','definition_hash','id','label','model_config','state'].sort());
  assert.ok(!Object.keys(stored).some(key => /secret|credential|api_key|token$/i.test(key)));
  await assert.rejects(createProfile(h, { api_key: 'sentinel-must-not-persist' }));
  await assert.rejects(createProfile(h, { base_url: 'https://attacker.invalid/v1' }));
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 0);
  assert.ok(!JSON.stringify(h.store.all('SELECT definition_json FROM model_profiles')).includes('sentinel-must-not-persist'));
  assert.equal(h.service.audience.detail(goal.goal_id).attention.profile_options.length > 0, true);

  const revoked = await h.command('model.profile_revoke', { profile_id: created.profile_id,
    expected_definition_hash: created.definition_hash, reason: 'End offline profile fixture.' },
  'c0101010-1010-4010-8010-101010101010');
  await assert.rejects(h.command('model.profile_revoke', { profile_id: created.profile_id,
    expected_definition_hash: created.definition_hash, reason: 'End offline profile fixture.' },
  'c0101010-1010-4010-8010-101010101010', { kind: 'agent' }),
  { code: 'MODEL_PROFILE_OPERATOR_REQUIRED' }, 'revocation actor scope is checked before an existing receipt');
  assert.equal(revoked.id, created.profile_id);
  await assert.rejects(h.command('model.profile_create', profileDefinition(), 'b0101010-1010-4010-8010-101010101010', { kind: 'channel' }),
    { code: 'MODEL_PROFILE_OPERATOR_REQUIRED' });
  const repeatedRevoke = await h.command('model.profile_revoke', { profile_id: created.profile_id,
    expected_definition_hash: created.definition_hash, reason: 'Repeat terminal revocation.' });
  assert.equal(repeatedRevoke.state, 'revoked', 'revoke replay cannot revive or edit the immutable definition');
  assert.equal(h.service.modelProfiles.get(created.profile_id).state, 'revoked');
});

test('available profile metadata alone cannot capture, call, or mark exchanges considered', async t => {
  sentinel(t);
  const h = audienceHarness(t); configureProfiles(h);
  const { goal } = await observed(h);
  const profile = await createProfile(h);
  const before = h.store.all('SELECT id,considered_fingerprint FROM audience_exchanges WHERE goal_id=? ORDER BY id', goal.goal_id);
  const fake = successfulFake();
  const result = await processAudienceAssessment(h.service, fake.runtime);
  assert.notEqual(result.disposition, 'proposal_created');
  assert.equal(fake.calls, 0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_assessments WHERE goal_id=?', goal.goal_id).n, 0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs WHERE runtime=?', AUDIENCE_RUNTIME).n, 0);
  assert.deepEqual(h.store.all('SELECT id,considered_fingerprint FROM audience_exchanges WHERE goal_id=? ORDER BY id', goal.goal_id), before);
  assert.ok(profile.profile_id, 'profile is present; it still grants no attempt by itself');
});

test('a profile grant does not promote an explicit operator-captured manual packet', async t => {
  sentinel(t);
  const h = audienceHarness(t); configureProfiles(h);
  const { goal } = await observed(h);
  const manual = await h.capture(goal.goal_id);
  const profile = await createProfile(h);
  const grant = await grantProfile(h, goal.goal_id, profile.profile_id);
  const fake = successfulFake();
  await processAudienceAssessment(h.service, fake.runtime);
  const assessment = h.service.audience.assessment(manual.assessment_id);
  assert.equal(assessment.status, 'captured');
  assert.equal(assessment.producer, 'operator');
  assert.equal(fake.calls, 0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs WHERE runtime=?', AUDIENCE_RUNTIME).n, 0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_attention_attempts WHERE grant_id=?', grant.grant_id).n, 0);
});

test('a profile grant runs only its selected goal with global runtime and Audience model switches off', async t => {
  sentinel(t);
  const h = audienceHarness(t); configureProfiles(h);
  const a = await observed(h, SOURCE, 'goal-a');
  const b = await observed(h, SOURCE_B, 'goal-b');
  const profile = await createProfile(h);
  await grantProfile(h, a.goal.goal_id, profile.profile_id);
  const fake = successfulFake();

  const result = await processAudienceAssessment(h.service, fake.runtime);
  assert.equal(result.disposition, 'proposal_created');
  assert.equal(result.goal_id, a.goal.goal_id);
  await processAudienceAssessment(h.service, fake.runtime);
  assert.equal(fake.calls, 1, 'a neighboring ready goal cannot borrow the selected profile grant');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs WHERE runtime=?', AUDIENCE_RUNTIME).n, 1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_assessments WHERE goal_id=? AND status IN (\'captured\',\'running\')', b.goal.goal_id).n, 0);
  assert.equal(h.config.runtime.enabled, false);
  assert.equal(h.config.audience.modelEnabled, false);
  assert.equal(h.config.runtime.baseUrl, '');
  assert.equal(h.config.runtime.model, '');
  for (const table of ['persons','conversations','drafts','approvals','delivery_attempts','work_cases'])
    assert.equal(h.store.get(`SELECT COUNT(*) n FROM ${table}`).n, 0, `${table} stays untouched by an Audience proposal`);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM audience_needs WHERE goal_id=? AND status='accepted'", a.goal.goal_id).n, 0,
    'the model-created need remains proposed for existing owner review');
});

test('a profile cannot fund a focused reassessment or focused retry for another goal', async t => {
  sentinel(t);
  const h = audienceHarness(t); configureProfiles(h);
  const a = await observed(h, SOURCE, 'ordinary-a');
  const b = await acceptedNeed(h, SOURCE_B, 'focused-b');
  await h.ingest({ source_id: SOURCE_B, message_id: 'focused-b-new', text: 'Could you explain the next step?' });
  h.service.audience.reconcile({ limit: 10 });

  // Create one failed focused parent and explicit retry under the old global path.
  // The new profile authority must not resume this captured retry for another goal.
  h.config.audience.modelEnabled = true;
  h.config.runtime.enabled = true;
  h.config.runtime.baseUrl = 'https://unused-focused-global.invalid/v1';
  h.config.runtime.model = 'offline-focused-global';
  h.config.runtime.dailyBudgetUsd = null;
  const context = h.service.audience.reassessmentContext(b.need.id);
  const captured = await h.command('audience.reassess', { need_id: b.need.id,
    expected_revision: context.need_revision, expected_basis_fingerprint: context.need_basis_fingerprint,
    expected_context_fingerprint: context.context_fingerprint });
  const parentResult = await processAudienceAssessment(h.service, { decide: async () => ({ completed: false,
    failure_cause: { kind: 'provider_error', provider_error_type: 'timeout', retryable: true,
      attempt_count: 1, http_status: null, timed_out: true, stdout_json_valid: false },
    usage: { input_tokens: 7, output_tokens: 0 }, model_identity: { model_id: 'offline-focused', model_version: 'v1' } }) });
  assert.equal(parentResult.assessment_id, captured.assessment_id);
  assert.equal(parentResult.disposition, 'model_failed');
  const parent = h.service.audience.assessment(captured.assessment_id);
  const latestContext = h.service.audience.reassessmentContext(b.need.id);
  const retry = await h.command('audience.retry_reassessment', { assessment_id: parent.id,
    expected_basis_fingerprint: parent.basis_fingerprint,
    expected_context_fingerprint: latestContext.context_fingerprint,
    reason: 'Keep the focused retry on its original global activation path.' });

  h.config.audience.modelEnabled = false;
  h.config.runtime.enabled = false;
  h.config.runtime.baseUrl = '';
  h.config.runtime.model = '';
  const profile = await createProfile(h);
  await grantProfile(h, a.goal.goal_id, profile.profile_id);
  const fake = successfulFake();
  const result = await processAudienceAssessment(h.service, fake.runtime);
  assert.equal(result.goal_id, a.goal.goal_id);
  assert.equal(fake.calls, 1, 'only the selected ordinary job is dispatched');
  assert.equal(h.service.audience.assessment(retry.assessment_id).status, 'captured',
    'focused retry cannot borrow another goal’s profile grant');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs WHERE context_json->>\'$.goal_id\'=?', b.goal.goal_id).n, 1,
    'the only focused run was the explicitly authorized global parent');
});

test('frozen profile identity/prices are used for the run and global config changes cannot retarget it', async t => {
  sentinel(t);
  const h = audienceHarness(t); configureProfiles(h);
  const { goal } = await observed(h);
  const profile = await createProfile(h, { model: 'frozen-model-v7', max_output_tokens: 777,
    input_usd_per_million: 4, output_usd_per_million: 9 });
  await grantProfile(h, goal.goal_id, profile.profile_id);
  let frozen;
  const fake = successfulFake({ before: async run => {
    frozen = JSON.parse(run.context_json);
    h.config.runtime.provider = 'mutated-global-provider';
    h.config.runtime.apiMode = 'responses';
    h.config.runtime.baseUrl = 'https://mutated-global.invalid/v1';
    h.config.runtime.model = 'mutated-global-model';
    h.config.runtime.maxOutputTokens = 16000;
  } });
  const result = await processAudienceAssessment(h.service, fake.runtime);
  assert.equal(result.disposition, 'proposal_created');
  assert.equal(frozen.model_config.provider, 'custom');
  assert.equal(frozen.model_config.apiMode ?? frozen.model_config.api_mode, 'chat_completions');
  assert.equal(frozen.model_config.baseUrl ?? frozen.model_config.base_url, PROFILE_URL);
  assert.equal(frozen.model_config.model, 'frozen-model-v7');
  assert.equal(frozen.model_config.maxOutputTokens ?? frozen.model_config.max_output_tokens, 777);
  assert.equal(frozen.model_config.inputUsdPerMillion ?? frozen.model_config.input_usd_per_million, 4);
  assert.equal(frozen.model_config.outputUsdPerMillion ?? frozen.model_config.output_usd_per_million, 9);
  const run = h.store.get('SELECT * FROM runs WHERE runtime=?', AUDIENCE_RUNTIME);
  assert.equal(run.model, 'frozen-model-v7');
  assert.equal(run.input_tokens, 41);
  assert.equal(run.output_tokens, 19);
  assert.equal(run.cost_status, 'configured_estimate');
  assert.ok(run.estimated_cost_usd > 0);
});

test('profile/grant/scope revoke or authority tampering during inference withholds output but retains usage', async t => {
  sentinel(t);
  for (const mutation of ['profile_revoke', 'grant_revoke', 'scope_stale', 'endpoint_policy_stale', 'profile_tamper', 'grant_tamper', 'binding_tamper', 'binding_deleted']) {
    const h = audienceHarness(t); configureProfiles(h);
    const { goal } = await observed(h, SOURCE, `late-${mutation}`);
    const profile = await createProfile(h);
    const grant = await grantProfile(h, goal.goal_id, profile.profile_id);
    let changed = false;
    const fake = successfulFake({ before: async run => {
      if (changed) return;
      changed = true;
      if (mutation === 'profile_revoke') await h.command('model.profile_revoke', { profile_id: profile.profile_id,
        expected_definition_hash: profile.definition_hash, reason: 'Revoke during bounded fake inference.' });
      else if (mutation === 'grant_revoke') {
        const view = h.service.audience.detail(goal.goal_id).attention.grants.find(row => row.id === grant.grant_id);
        await h.command('audience.attention_revoke', { grant_id: grant.grant_id,
          expected_grant_fingerprint: view.grant_fingerprint, reason: 'Revoke during bounded fake inference.' });
      } else if (mutation === 'scope_stale') h.config.opportunity.allowedSourceRefs = [SOURCE_B];
      else if (mutation === 'endpoint_policy_stale') h.config.modelProfiles.allowedBaseUrls = [];
      else if (mutation === 'profile_tamper') {
        h.store.run('UPDATE model_profiles SET definition_hash=? WHERE id=?', '0'.repeat(64), profile.profile_id);
      } else if (mutation === 'grant_tamper') {
        h.store.run('UPDATE audience_attention_grants SET max_attempts=max_attempts+1 WHERE id=?', grant.grant_id);
      } else if (mutation === 'binding_tamper') {
        const binding = h.store.get('SELECT * FROM audience_attention_models WHERE grant_id IS NOT NULL ORDER BY rowid DESC LIMIT 1');
        assert.ok(binding, 'positive control: profile-grant binding exists before tamper');
        h.store.run('UPDATE audience_attention_models SET definition_hash=? WHERE grant_id=?', '0'.repeat(64), binding.grant_id);
      } else {
        const binding = h.store.get('SELECT * FROM audience_attention_models WHERE grant_id IS NOT NULL ORDER BY rowid DESC LIMIT 1');
        assert.ok(binding, 'positive control: profile-grant binding exists before deletion');
        h.store.run('DELETE FROM audience_attention_models WHERE grant_id=?', binding.grant_id);
      }
      assert.equal(h.store.get('SELECT status FROM runs WHERE id=?', run.id).status, 'running');
    } });
    const result = await processAudienceAssessment(h.service, fake.runtime);
    assert.notEqual(result.disposition, 'proposal_created', `${mutation} prevents late proposal application`);
    assert.equal(fake.calls, 1);
    const run = h.store.get('SELECT * FROM runs WHERE runtime=?', AUDIENCE_RUNTIME);
    assert.equal(run.status, 'failed');
    assert.equal(run.input_tokens, 41);
    assert.equal(run.output_tokens, 19);
    assert.equal(h.service.audience.assessment(result.assessment_id).status === 'proposed', false);
    assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs WHERE goal_id=?', goal.goal_id).n, 0);
  }
});

test('disabled, stale policy, expiry, CP capacity, global/domain/financial budgets and unknown cost deny before purchase', async t => {
  sentinel(t);
  for (const state of ['audience_disabled', 'control_disabled', 'policy_stale', 'endpoint_policy', 'grant_expired', 'cp_capacity', 'runtime_cap', 'audience_cap', 'financial_cap', 'unknown_cost']) {
    const h = audienceHarness(t); configureProfiles(h);
    const { goal } = await observed(h, SOURCE, `budget-${state}`);
    const profile = await createProfile(h);
    const grant = await grantProfile(h, goal.goal_id, profile.profile_id, {
      expires_at: state === 'grant_expired' ? new Date(Date.now() + 80).toISOString() : new Date(Date.now() + 3600000).toISOString(),
    });
    if (state === 'audience_disabled') h.config.audience.enabled = false;
    if (state === 'control_disabled') h.config.controlPlane.enabled = false;
    if (state === 'policy_stale') h.config.opportunity.allowedSourceRefs = [SOURCE_B];
    if (state === 'endpoint_policy') h.config.modelProfiles.allowedBaseUrls = [];
    if (state === 'grant_expired') await new Promise(resolve => setTimeout(resolve, 100));
    if (state === 'cp_capacity') {
      h.service.control.acquireProcess();
      h.service.control.reserve('public', 'unrelated-public-work');
    }
    if (state === 'runtime_cap') h.config.runtime.maxRunsPerDay = 0;
    if (state === 'audience_cap') h.config.audience.maxRunsPerDay = 0;
    if (state === 'financial_cap') {
      h.config.runtime.dailyBudgetUsd = 0.1;
      h.store.run(`INSERT INTO runs(id,partner_id,status,runtime,model,context_json,estimated_cost_usd,cost_status,created_at)
        VALUES(?,?,'completed','offline-unrelated','offline-fixture','{}',0.2,'configured_estimate',?)`,
      `known-cost-${state}`, h.config.partnerId, new Date().toISOString());
    }
    if (state === 'unknown_cost') h.store.run(`INSERT INTO runs(id,partner_id,status,runtime,model,context_json,cost_status,created_at)
      VALUES(?,?,'failed','offline-unrelated','offline-fixture','{}','unknown',?)`, `unknown-${state}`, h.config.partnerId, new Date().toISOString());
    const fake = successfulFake();
    let result = null;
    if (state === 'control_disabled') {
      await assert.rejects(processAudienceAssessment(h.service, fake.runtime), { code: 'AUDIENCE_CONTROL_REQUIRED' });
    } else result = await processAudienceAssessment(h.service, fake.runtime);
    assert.notEqual(result?.disposition, 'proposal_created', state);
    assert.equal(fake.calls, 0, `${state} blocks before fake provider invocation`);
    assert.equal(h.store.get('SELECT COUNT(*) n FROM runs WHERE runtime=?', AUDIENCE_RUNTIME).n, 0);
    assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_attention_attempts WHERE grant_id=?', grant.grant_id).n, 0,
      `${state} refusal does not consume the finite attempt`);
    assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_assessments WHERE goal_id=? AND status IN (\'captured\',\'running\')', goal.goal_id).n, 0);
  }
});

test('profile-bound grant is operator-only before duplicate receipt replay', async t => {
  const h = audienceHarness(t); configureProfiles(h);
  const { goal } = await observed(h);
  const profile = await createProfile(h);
  const detail = h.service.audience.detail(goal.goal_id), option = profileOption(detail, profile.profile_id);
  const payload = { goal_id: goal.goal_id, expected_revision: detail.revision,
    expected_scope_fingerprint: option.scope_fingerprint, model_profile_id: profile.profile_id,
    max_attempts: 1, expires_at: new Date(Date.now() + 3600000).toISOString(),
    reason: 'One profile-bound operator grant for receipt-scope acceptance.' };
  const requestId = 'd0101010-1010-4010-8010-101010101010';
  const result = await h.command('audience.attention_grant', payload, requestId);
  await assert.rejects(h.command('audience.attention_grant', payload, requestId, { kind: 'agent' }),
    { code: 'AUDIENCE_OPERATOR_REQUIRED' });
  assert.deepEqual(await h.command('audience.attention_grant', payload, requestId), result);
  assert.equal(h.service.audience.detail(goal.goal_id).attention.grants.find(row => row.id === result.grant_id).attempts_used, 0);
});

test('Scheduler reason tick admits the profile-granted Audience job without waking other public planes', async t => {
  sentinel(t);
  const h = audienceHarness(t); configureProfiles(h);
  h.config.scheduler.enabled = true;
  h.config.continuity.enabled = true;
  h.config.continuity.modelEnabled = true;
  const { goal } = await observed(h);
  const sourceEventId = h.store.get("SELECT id FROM events WHERE kind='source.message' ORDER BY id DESC LIMIT 1").id;
  const thread = await h.command('continuity.open', { title: 'Independent eligible control',
    objective: 'Review the same synthetic source without profile authority.',
    success_condition: 'A source-grounded interpretation remains pending.', source_ids: [SOURCE],
    initial_evidence_event_ids: [String(sourceEventId)] });
  const continuity = h.service.continuity.detail(thread.thread_id);
  await h.command('continuity.capture', { thread_id: thread.thread_id, expected_revision: continuity.revision,
    expected_basis_fingerprint: continuity.basis_fingerprint });
  const profile = await createProfile(h);
  await grantProfile(h, goal.goal_id, profile.profile_id);
  const fake = successfulFake();
  const scheduler = new Scheduler(h.service, fake.runtime, null);
  scheduler.audienceHealthy = true;
  scheduler.continuityHealthy = true;
  await scheduler.reasonTick();
  await scheduler.reasonTick();
  assert.equal(fake.calls, 1, 'the profile grants one Audience turn only');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs WHERE runtime=?', AUDIENCE_RUNTIME).n, 1);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM runs WHERE runtime='hermes-continuity-v1'").n, 0,
    'eligible-looking Continuity work cannot borrow an Audience profile');
  assert.equal(h.service.continuity.turn(h.store.get('SELECT id FROM partner_turns WHERE thread_id=? ORDER BY rowid DESC LIMIT 1', thread.thread_id).id).status,
    'captured', 'the unrelated plane remains queued for its own global activation');
});

test('restart preserves profile authority history and an exhausted attempt cannot be refunded', async t => {
  sentinel(t);
  const h = audienceHarness(t); configureProfiles(h);
  const { goal } = await observed(h);
  const profile = await createProfile(h);
  const grant = await grantProfile(h, goal.goal_id, profile.profile_id, { max_attempts: 1 });
  const fake = successfulFake();
  const first = await processAudienceAssessment(h.service, fake.runtime);
  assert.equal(first.disposition, 'proposal_created');
  const oldRun = h.store.get('SELECT * FROM runs WHERE runtime=?', AUDIENCE_RUNTIME);
  h.restart();
  const grantView = h.service.audience.detail(goal.goal_id).attention.grants.find(row => row.id === grant.grant_id);
  assert.equal(grantView.attempts_used, 1);
  assert.equal(grantView.remaining_attempts, 0);
  await h.ingest({ message_id: 'scoped-after-restart', text: 'What is the next step?' });
  h.service.audience.reconcile({ limit: 10 });
  const after = await processAudienceAssessment(h.service, fake.runtime);
  assert.notEqual(after.disposition, 'proposal_created');
  assert.equal(fake.calls, 1);
  assert.deepEqual(h.store.get('SELECT * FROM runs WHERE runtime=?', AUDIENCE_RUNTIME), oldRun);
  assert.equal(h.service.modelProfiles.get(profile.profile_id).state, 'available', 'restart preserves profile metadata without restoring cap');
});
