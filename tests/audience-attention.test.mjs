// Bounded unattended Audience authority. Every model turn is an injected local fake;
// the sentinel credential is never sent to a provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { audienceHarness, SOURCE, SOURCE_B, proposalFrom } from './audience-test-helpers.mjs';
import { processAudienceAssessment } from '../business/audience-reasoning.mjs';

const ATTENTION_RUNTIME = 'hermes-audience-v1';

function configure(h, { modelEnabled = true } = {}) {
  h.config.audience.modelEnabled = modelEnabled;
  h.config.audience.maxRunsPerDay = 20;
  h.config.runtime.enabled = true;
  h.config.runtime.maxRunsPerDay = 50;
  h.config.runtime.baseUrl = 'https://unused-attention-test.invalid/v1';
  h.config.runtime.model = 'offline-fake-attention-model';
  h.config.runtime.dailyBudgetUsd = null;
  h.config.runtime.inputUsdPerMillion = null;
  h.config.runtime.outputUsdPerMillion = null;
  h.config.controlPlane.maxConcurrent = 3;
}

function sentinel(t) {
  const previous = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'offline-attention-sentinel-never-sent';
  t.after(() => {
    if (previous === undefined) delete process.env.PARTNER_MODEL_API_KEY;
    else process.env.PARTNER_MODEL_API_KEY = previous;
  });
}

async function observed(h, sourceId, messageId = 'attention-question') {
  const goal = await h.open({ source_ids: [sourceId] });
  await h.ingest({ message_id: messageId, source_id: sourceId, text: 'How can I get started?' });
  h.service.audience.reconcile({ limit: 10 });
  const detail = h.service.audience.detail(goal.goal_id);
  assert.equal(detail.ready, true, 'positive control: bounded source packet is ready');
  return { goal, detail };
}

function grantPayload(h, goalId, detail, extra = {}) {
  return { goal_id: goalId, expected_revision: detail.revision,
    expected_scope_fingerprint: detail.attention?.scope_fingerprint,
    max_attempts: 1, expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    reason: 'Bounded offline acceptance verification', ...extra };
}

function fakeModel({ before = async () => {}, fail = false } = {}) {
  let calls = 0;
  return { get calls() { return calls; }, runtime: { decide: async (_run, context) => {
    calls++;
    await before(context);
    if (fail) return { completed: false, error: 'offline injected provider failure',
      usage: { input_tokens: 23, output_tokens: 0 }, model_identity: { model_id: 'offline-fake', model_version: '1' } };
    return { completed: true, final_response: JSON.stringify(proposalFrom(context.packet)),
      usage: { input_tokens: 23, output_tokens: 12 }, model_identity: { model_id: 'offline-fake', model_version: '1' } };
  } } };
}

test('global model switch plus two ready goals spends only the one owner-granted goal', async t => {
  sentinel(t);
  const h = audienceHarness(t); configure(h);
  const a = await observed(h, SOURCE, 'goal-a-question');
  const b = await observed(h, SOURCE_B, 'goal-b-question');
  const authorized = await h.command('audience.attention_grant', grantPayload(h, a.goal.goal_id,
    h.service.audience.detail(a.goal.goal_id)));
  const fake = fakeModel();

  const first = await processAudienceAssessment(h.service, fake.runtime);
  assert.equal(first.disposition, 'proposal_created');
  assert.equal(first.goal_id, a.goal.goal_id);
  const second = await processAudienceAssessment(h.service, fake.runtime);
  assert.notEqual(second.goal_id, b.goal.goal_id,
    'the ready neighboring goal remains unauthorized even with the global model switch on');
  assert.equal(fake.calls, 1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs WHERE runtime=?', ATTENTION_RUNTIME).n, 1);
  assert.equal(h.service.audience.assessment(first.assessment_id).status, 'proposed');
  const grant = h.service.audience.detail(a.goal.goal_id).attention.grants.find(g => g.id === authorized.grant_id);
  assert.equal(grant.status, 'exhausted');
  assert.equal(grant.attempts_used, 1);
  assert.equal(grant.remaining_attempts, 0);
  assert.equal(h.service.audience.detail(b.goal.goal_id).attention.grants.length, 0);
});

test('without a goal grant automatic reasoning makes no call, capture, run, or considered-state change', async t => {
  sentinel(t);
  const h = audienceHarness(t); configure(h);
  const { goal } = await observed(h, SOURCE);
  const before = h.store.all('SELECT id,considered_fingerprint FROM audience_exchanges WHERE goal_id=? ORDER BY id', goal.goal_id);
  const fake = fakeModel();

  const result = await processAudienceAssessment(h.service, fake.runtime);
  assert.notEqual(result.disposition, 'proposal_created');
  assert.equal(fake.calls, 0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_assessments WHERE goal_id=?', goal.goal_id).n, 0,
    'blocked automatic attention does not create a captured assessment');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs WHERE runtime=?', ATTENTION_RUNTIME).n, 0);
  assert.deepEqual(h.store.all('SELECT id,considered_fingerprint FROM audience_exchanges WHERE goal_id=? ORDER BY id', goal.goal_id), before);
});

test('the last allowed attempt may finish, then later messages cannot buy another attempt', async t => {
  sentinel(t);
  const h = audienceHarness(t); configure(h);
  const { goal, detail } = await observed(h, SOURCE);
  await h.command('audience.attention_grant', grantPayload(h, goal.goal_id, detail, { max_attempts: 1 }));
  const fake = fakeModel();

  const last = await processAudienceAssessment(h.service, fake.runtime);
  assert.equal(last.disposition, 'proposal_created', 'zero remaining allowance does not revoke an admitted run');
  assert.equal(h.service.audience.assessment(last.assessment_id).status, 'proposed');
  await h.ingest({ message_id: 'attention-question-2', text: 'What should I do next?' });
  h.service.audience.reconcile({ limit: 10 });
  const after = await processAudienceAssessment(h.service, fake.runtime);
  assert.notEqual(after.disposition, 'proposal_created');
  assert.equal(fake.calls, 1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs WHERE runtime=?', ATTENTION_RUNTIME).n, 1);
});

test('disabled, unconfigured, and previously unknown spend do not purchase an attention attempt', async t => {
  sentinel(t);
  for (const state of ['disabled', 'unconfigured', 'unknown_budget']) {
    const h = audienceHarness(t); configure(h, { modelEnabled: state !== 'disabled' });
    const { goal, detail } = await observed(h, SOURCE);
    await h.command('audience.attention_grant', grantPayload(h, goal.goal_id, detail));
    if (state === 'unconfigured') h.config.runtime.model = '';
    if (state === 'unknown_budget') {
      h.config.runtime.dailyBudgetUsd = 5;
      h.store.run(`INSERT INTO runs(id,partner_id,status,runtime,model,context_json,cost_status,created_at)
        VALUES(?,?,'failed','offline-unrelated','offline-fixture','{}','unknown',?)`,
      'attention-unknown-spend-fixture', h.config.partnerId, new Date().toISOString());
    }
    const fake = fakeModel();

    const result = await processAudienceAssessment(h.service, fake.runtime);
    assert.notEqual(result.disposition, 'proposal_created', `${state} must block before purchase`);
    assert.equal(fake.calls, 0, `${state} must not call the injected provider`);
    assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_assessments WHERE goal_id=?', goal.goal_id).n, 0,
      `${state} must not capture the packet`);
    assert.equal(h.store.get('SELECT COUNT(*) n FROM runs WHERE runtime=?', ATTENTION_RUNTIME).n, 0);
  }
});

test('operator grant and revoke bind exact scope, retain receipts, and replay a duplicate grant idempotently', async t => {
  const h = audienceHarness(t); configure(h, { modelEnabled: false });
  const { goal, detail } = await observed(h, SOURCE);
  const payload = grantPayload(h, goal.goal_id, detail, { max_attempts: 3 });
  const requestId = '10101010-1010-4010-8010-101010101010';
  const created = await h.command('audience.attention_grant', payload, requestId);
  await assert.rejects(h.command('audience.attention_grant', payload, requestId, { kind: 'agent' }),
    { code: 'AUDIENCE_OPERATOR_REQUIRED' }, 'actor authorization precedes an existing idempotency receipt');
  const duplicate = await h.command('audience.attention_grant', payload, requestId);
  assert.deepEqual(duplicate, created);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='audience.attention_granted' AND json_extract(payload_json,'$.grant_id')=?", created.grant_id).n, 1,
    'duplicate request receipt creates one immutable grant event');
  const afterGrant = h.service.audience.detail(goal.goal_id).attention.grants.find(g => g.id === created.grant_id);
  assert.ok(afterGrant.grant_fingerprint);
  assert.equal(afterGrant.state, 'active');
  assert.equal(afterGrant.attempts_used, 0);
  assert.equal(afterGrant.remaining_attempts, 3);
  assert.equal(h.config.audience.modelEnabled, false, 'granting permission does not turn on the model switch');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs WHERE runtime=?', ATTENTION_RUNTIME).n, 0,
    'permission receipt alone is not a model purchase');

  const revokePayload = { grant_id: created.grant_id,
    expected_grant_fingerprint: afterGrant.grant_fingerprint, reason: 'End the bounded verification.' };
  const revokeRequestId = '20202020-2020-4020-8020-202020202020';
  const revoked = await h.command('audience.attention_revoke', revokePayload, revokeRequestId);
  await assert.rejects(h.command('audience.attention_revoke', revokePayload, revokeRequestId, { kind: 'agent' }),
    { code: 'AUDIENCE_OPERATOR_REQUIRED' }, 'revocation receipts cannot be replayed by another actor');
  assert.equal(revoked.grant_id, created.grant_id);
  const afterRevoke = h.service.audience.detail(goal.goal_id).attention.grants.find(g => g.id === created.grant_id);
  assert.equal(afterRevoke.status, 'revoked');
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='audience.attention_revoked' AND json_extract(payload_json,'$.grant_id')=?", created.grant_id).n, 1);
  assert.ok(h.store.get("SELECT id FROM events WHERE kind='audience.attention_granted' AND json_extract(payload_json,'$.actor')='operator' AND json_extract(payload_json,'$.goal_id')=?", goal.goal_id),
    'the durable grant receipt records operator ownership and target goal');
  assert.equal(detail.attention.scope_fingerprint, afterGrant.scope_fingerprint,
    'grant creation records the exact preexisting goal/source/model scope');
});

test('grant fields enforce attempt bounds, expiry window, and the current immutable scope', async t => {
  const h = audienceHarness(t); configure(h, { modelEnabled: false });
  const { goal, detail } = await observed(h, SOURCE);
  const valid = grantPayload(h, goal.goal_id, detail, { max_attempts: 50 });

  for (const max_attempts of [0, 51])
    await assert.rejects(h.command('audience.attention_grant', { ...valid, max_attempts }), { code: 'AUDIENCE_FIELDS_INVALID' });
  for (const expires_at of [new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() + 8 * 86400000).toISOString()])
    await assert.rejects(h.command('audience.attention_grant', { ...valid, expires_at }), { code: 'AUDIENCE_ATTENTION_EXPIRY_INVALID' });

  h.config.runtime.model = 'changed-after-scope-capture';
  await assert.rejects(h.command('audience.attention_grant', valid), { code: 'AUDIENCE_STALE_BASIS' });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_attention_grants').n, 0,
    'stale model scope leaves no permission record');

  const refreshed = h.service.audience.detail(goal.goal_id);
  const first = await h.command('audience.attention_grant', grantPayload(h, goal.goal_id, refreshed, { max_attempts: 50 }));
  const firstView = h.service.audience.detail(goal.goal_id).attention.grants.find(g => g.id === first.grant_id);
  assert.equal(firstView.remaining_attempts, 50, 'the inclusive upper bound is accepted');
  await h.command('audience.attention_revoke', { grant_id: first.grant_id,
    expected_grant_fingerprint: firstView.grant_fingerprint, reason: 'Exercise lower attempt boundary.' });
  const second = await h.command('audience.attention_grant', grantPayload(h, goal.goal_id,
    h.service.audience.detail(goal.goal_id), { max_attempts: 1 }));
  const secondView = h.service.audience.detail(goal.goal_id).attention.grants.find(g => g.id === second.grant_id);
  assert.equal(secondView.remaining_attempts, 1, 'the inclusive lower bound is accepted');
});

test('provider and API mode changes make the original grant ineligible before any purchase', async t => {
  sentinel(t);
  for (const [key, value] of [['provider', 'alternate-provider'], ['apiMode', 'responses']]) {
    const h = audienceHarness(t); configure(h);
    const { goal, detail } = await observed(h, SOURCE);
    await h.command('audience.attention_grant', grantPayload(h, goal.goal_id, detail));
    h.config.runtime[key] = value;
    const changed = h.service.audience.detail(goal.goal_id);
    assert.notEqual(changed.attention.scope_fingerprint, detail.attention.scope_fingerprint,
      `${key} participates in the immutable model scope`);
    assert.equal(changed.attention.grants[0].status, 'stale');

    const fake = fakeModel();
    const result = await processAudienceAssessment(h.service, fake.runtime);
    assert.notEqual(result.disposition, 'proposal_created');
    assert.equal(fake.calls, 0, `${key} change cannot spend the old grant`);
    assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_assessments WHERE goal_id=?', goal.goal_id).n, 0);
    assert.equal(h.store.get('SELECT COUNT(*) n FROM runs WHERE runtime=?', ATTENTION_RUNTIME).n, 0);
  }
});

test('remote cleartext HTTP endpoint cannot receive an attention grant or model call', async t => {
  sentinel(t);
  const h = audienceHarness(t); configure(h);
  const { goal, detail } = await observed(h, SOURCE);
  const staleGrantPayload = grantPayload(h, goal.goal_id, detail);
  h.config.runtime.baseUrl = 'http://model-provider.example/v1';

  await assert.rejects(h.command('audience.attention_grant', staleGrantPayload), { code: 'AUDIENCE_STALE_BASIS' });
  assert.equal(h.service.audience.detail(goal.goal_id).attention.model_configured, false);
  const fake = fakeModel();
  const result = await processAudienceAssessment(h.service, fake.runtime);
  assert.notEqual(result.disposition, 'proposal_created');
  assert.equal(fake.calls, 0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_attention_grants').n, 0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_assessments WHERE goal_id=?', goal.goal_id).n, 0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs WHERE runtime=?', ATTENTION_RUNTIME).n, 0);
});

test('observed source withdrawal is permanent for the old watch and grant after config restoration', async t => {
  sentinel(t);
  const h = audienceHarness(t); configure(h);
  const { goal, detail } = await observed(h, SOURCE);
  await h.command('audience.attention_grant', grantPayload(h, goal.goal_id, detail));

  h.config.opportunity.allowedSourceRefs = [SOURCE_B];
  h.service.audience.detail(goal.goal_id); // Observe and persist withdrawal while it is in force.
  assert.equal(h.store.get('SELECT status FROM audience_watches WHERE goal_id=? AND source_ref=?', goal.goal_id, SOURCE).status, 'revoked');
  h.config.opportunity.allowedSourceRefs = [SOURCE, SOURCE_B];
  const restored = h.service.audience.detail(goal.goal_id);
  assert.equal(h.store.get('SELECT status FROM audience_watches WHERE goal_id=? AND source_ref=?', goal.goal_id, SOURCE).status, 'revoked');
  assert.equal(restored.attention.scope_fingerprint, null);
  assert.equal(restored.attention.grants[0].status, 'stale');
  assert.equal(h.service.attention.eligible(goal.goal_id), null, 'restoration does not resurrect the old owner mandate');

  const fake = fakeModel();
  const result = await processAudienceAssessment(h.service, fake.runtime);
  assert.notEqual(result.disposition, 'proposal_created');
  assert.equal(fake.calls, 0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs WHERE runtime=?', ATTENTION_RUNTIME).n, 0);
});

test('a withdrawal observed during inference withholds late output and retains usage', async t => {
  sentinel(t);
  const h = audienceHarness(t); configure(h);
  const { goal, detail } = await observed(h, SOURCE);
  await h.command('audience.attention_grant', grantPayload(h, goal.goal_id, detail));
  const fake = fakeModel({ before: async () => {
    h.config.opportunity.allowedSourceRefs = [SOURCE_B];
    h.service.audience.detail(goal.goal_id); // Persist the source withdrawal before reallowing it.
    h.config.opportunity.allowedSourceRefs = [SOURCE, SOURCE_B];
  } });

  const result = await processAudienceAssessment(h.service, fake.runtime);
  assert.equal(result.disposition, 'AUDIENCE_STALE_BASIS');
  assert.equal(fake.calls, 1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 0,
    'late output for the withdrawn source watch is not applied');
  assert.equal(h.service.audience.assessment(result.assessment_id).status, 'stale');
  const run = h.store.get('SELECT * FROM runs WHERE id=?', h.service.audience.assessment(result.assessment_id).run_id);
  assert.equal(run.status, 'failed');
  assert.equal(run.input_tokens, 23);
  assert.equal(run.output_tokens, 12);
  assert.equal(run.cost_status, 'unknown');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_attention_attempts').n, 1,
    'the admitted attempt remains charged after its result is withheld');
});

test('renewal after a failed exhausted attempt preserves consideration and does not repurchase the same basis', async t => {
  sentinel(t);
  const h = audienceHarness(t); configure(h);
  const { goal, detail } = await observed(h, SOURCE);
  await h.command('audience.attention_grant', grantPayload(h, goal.goal_id, detail, { max_attempts: 1 }));
  const failedFake = fakeModel({ fail: true });
  const failed = await processAudienceAssessment(h.service, failedFake.runtime);
  assert.equal(failed.disposition, 'model_failed');
  const consideredAfterFailure = h.store.all('SELECT id,considered_fingerprint FROM audience_exchanges WHERE goal_id=? ORDER BY id', goal.goal_id);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs WHERE runtime=?', ATTENTION_RUNTIME).n, 1);
  const current = h.service.audience.detail(goal.goal_id);
  await h.command('audience.attention_grant', grantPayload(h, goal.goal_id, current, { max_attempts: 1,
    reason: 'Renew finite verification allowance after observed failure.' }));
  const nextFake = fakeModel();
  const next = await processAudienceAssessment(h.service, nextFake.runtime);
  assert.notEqual(next.disposition, 'proposal_created');
  assert.equal(nextFake.calls, 0, 'renewal does not buy an unchanged failed evidence basis again');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs WHERE runtime=?', ATTENTION_RUNTIME).n, 1);
  assert.deepEqual(h.store.all('SELECT id,considered_fingerprint FROM audience_exchanges WHERE goal_id=? ORDER BY id', goal.goal_id), consideredAfterFailure);
});
