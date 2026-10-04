// Black-box acceptance for explicit recovery of a failed focused Audience assessment.
// All model behavior is supplied by a local stub; this suite never opens a network connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { processAudienceAssessment } from '../business/audience-reasoning.mjs';
import { audienceHarness, SOURCE, SOURCE_B, modelOutputFrom, proposalFrom } from './audience-test-helpers.mjs';

const runtimeConfig = h => {
  h.config.audience.modelEnabled = true;
  h.config.audience.maxRunsPerDay = 8;
  h.config.runtime.maxRunsPerDay = 20;
  h.config.runtime.baseUrl = 'https://unused-recovery-test.invalid/v1';
  h.config.runtime.model = 'offline-fake-recovery-runtime';
  // This fixture verifies finite calls without pricing. Budget-specific tests
  // separately confirm that unknown prior USD blocks when a ceiling is set.
  h.config.runtime.dailyBudgetUsd = null;
  h.config.runtime.inputUsdPerMillion = null;
  h.config.runtime.outputUsdPerMillion = null;
  h.config.controlPlane.maxConcurrent = 3;
};

function fakeKey(t) {
  const previous = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'offline-test-sentinel-never-sent';
  t.after(() => {
    if (previous === undefined) delete process.env.PARTNER_MODEL_API_KEY;
    else process.env.PARTNER_MODEL_API_KEY = previous;
  });
}

async function failedFocusedAttempt(t) {
  fakeKey(t);
  const h = audienceHarness(t);
  runtimeConfig(h);
  const goal = await h.open({ source_ids: [SOURCE] });
  await h.ingest({ message_id: 'recovery-question', text: 'How can I start safely?' });
  h.service.audience.reconcile({ limit: 10 });
  const captured = await h.capture(goal.goal_id);
  const ordinary = h.service.audience.assessment(captured.assessment_id);
  await h.command('audience.propose', { assessment_id: ordinary.id, output: proposalFrom(ordinary.packet) });
  let need = h.service.audience.need(h.store.get('SELECT id FROM audience_needs WHERE assessment_id=?', ordinary.id).id);
  await h.command('audience.review', { need_id: need.id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint, decision: 'accept', note: 'Review the observed question.' });
  need = h.service.audience.need(need.id);

  const context = h.service.audience.reassessmentContext(need.id);
  const requested = await h.command('audience.reassess', { need_id: need.id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint, expected_context_fingerprint: context.context_fingerprint });
  let calls = 0;
  const failure = await processAudienceAssessment(h.service, { decide: async () => {
    calls++;
    return { completed: false, failure_cause: { kind: 'provider_error', provider_error_type: 'timeout',
      retryable: true, attempt_count: 1 }, usage: { input_tokens: 321, output_tokens: 0 } };
  } });
  assert.equal(calls, 1, 'the failed parent is a real processed focused assessment');
  assert.equal(failure.assessment_id, requested.assessment_id);
  const parent = h.service.audience.assessment(requested.assessment_id);
  assert.equal(parent.status, 'interrupted');
  const run = h.store.get('SELECT * FROM runs WHERE id=?', parent.run_id);
  assert.equal(run.runtime, 'hermes-audience-v1');
  assert.equal(run.status, 'failed');
  assert.equal(run.cost_status, 'unknown');
  assert.equal(run.estimated_cost_usd, null);
  return { h, goal, need, parent, parentRun: run, calls };
}

function retryPayload(parent, reason = 'The provider timeout was transient; reconsider the same evidence once.') {
  return { assessment_id: parent.id, expected_basis_fingerprint: parent.basis_fingerprint,
    expected_context_fingerprint: parent.packet.reassessment.context_fingerprint, reason };
}

test('unchanged failed context stays locked to ordinary reassessment and is not automatically repurchased', async t => {
  const { h, need, parent, calls } = await failedFocusedAttempt(t);
  const context = h.service.audience.reassessmentContext(need.id);
  await assert.rejects(h.command('audience.reassess', { need_id: need.id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint, expected_context_fingerprint: context.context_fingerprint }),
  { code: 'AUDIENCE_ALREADY_CONSIDERED' });
  const next = await processAudienceAssessment(h.service, { decide: async () => { throw new Error('automatic repurchase'); } });
  assert.notEqual(next.disposition, 'proposal_created');
  assert.equal(calls, 1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 1);
});

test('operator retry creates one child bound to the same frozen context and parent attempt', async t => {
  const { h, parent } = await failedFocusedAttempt(t);
  const child = await h.command('audience.retry_reassessment', retryPayload(parent));
  const assessment = h.service.audience.assessment(child.assessment_id);
  assert.equal(assessment.status, 'captured');
  assert.notEqual(assessment.id, parent.id);
  assert.notEqual(assessment.basis_fingerprint, parent.basis_fingerprint);
  assert.equal(assessment.packet.reassessment.context_fingerprint, parent.packet.reassessment.context_fingerprint);
  assert.deepEqual(assessment.packet.reassessment.retry_of,
    { assessment_id: parent.id, basis_fingerprint: parent.basis_fingerprint });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_assessments WHERE id=?', parent.id).n, 1);
});

test('a failed child needs a fresh explicit retry request of its own', async t => {
  const { h, parent } = await failedFocusedAttempt(t);
  const childRequest = await h.command('audience.retry_reassessment', retryPayload(parent));
  const child = h.service.audience.assessment(childRequest.assessment_id);
  let calls = 0;
  const failed = await processAudienceAssessment(h.service, { decide: async () => {
    calls++;
    return { completed: false, failure_cause: { kind: 'provider_error', provider_error_type: 'timeout', retryable: true },
      usage: { input_tokens: 100, output_tokens: 0 } };
  } });
  assert.equal(calls, 1);
  assert.equal(failed.assessment_id, child.id);
  const stopped = h.service.audience.assessment(child.id);
  assert.equal(stopped.status, 'interrupted');
  const grandchildResult = await h.command('audience.retry_reassessment', retryPayload(stopped,
    'The first recovery attempt also timed out; authorize one new attempt.'));
  const grandchild = h.service.audience.assessment(grandchildResult.assessment_id);
  assert.notEqual(grandchild.basis_fingerprint, child.basis_fingerprint);
  assert.equal(grandchild.packet.reassessment.context_fingerprint, parent.packet.reassessment.context_fingerprint);
  assert.deepEqual(grandchild.packet.reassessment.retry_of,
    { assessment_id: child.id, basis_fingerprint: child.basis_fingerprint });
  const automatic = await processAudienceAssessment(h.service, { decide: async () => {
    throw new Error('another explicit request is required after the failed child');
  } });
  assert.notEqual(automatic.assessment_id, child.id);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 3);
});

test('retry leaves the original failure receipt and unknown cost unchanged after the child runs', async t => {
  const { h, parent, parentRun } = await failedFocusedAttempt(t);
  const child = await h.command('audience.retry_reassessment', retryPayload(parent));
  const result = await processAudienceAssessment(h.service, { decide: async (_run, context) => ({
    completed: true, final_response: JSON.stringify(modelOutputFrom(context.packet, { needs: [] })), usage: { input_tokens: 444, output_tokens: 12 },
    model_identity: { model_id: 'offline-fake', model_version: '1' },
  }) });
  assert.equal(result.assessment_id, child.assessment_id);
  const childAssessment = h.service.audience.assessment(child.assessment_id);
  assert.ok(childAssessment.run_id, 'the successful child has a persisted Hermes run');
  assert.equal(h.store.get('SELECT status FROM runs WHERE id=?', childAssessment.run_id).status, 'completed');
  const before = h.store.get('SELECT status,error,input_tokens,output_tokens,estimated_cost_usd,cost_status FROM runs WHERE id=?', parentRun.id);
  assert.deepEqual({ ...before }, { status: parentRun.status, error: parentRun.error, input_tokens: parentRun.input_tokens,
    output_tokens: parentRun.output_tokens, estimated_cost_usd: parentRun.estimated_cost_usd, cost_status: parentRun.cost_status });
  assert.equal(before.cost_status, 'unknown');
  assert.equal(before.estimated_cost_usd, null);
});

test('distinct retry IDs cannot make a second child; identical operator receipt only replays the first', async t => {
  const { h, parent } = await failedFocusedAttempt(t), payload = retryPayload(parent);
  await assert.rejects(h.command('audience.retry_reassessment', { ...payload, reason: '  ' }),
    { code: 'AUDIENCE_FIELDS_INVALID' });
  await assert.rejects(h.command('audience.retry_reassessment', { ...payload, reason: 'r'.repeat(501) }),
    { code: 'AUDIENCE_FIELDS_INVALID' });
  const first = await h.command('audience.retry_reassessment', payload, 'retry-request-0001');
  await assert.rejects(h.command('audience.retry_reassessment', payload, 'retry-request-0002'),
    { code: 'AUDIENCE_ALREADY_CONSIDERED' });
  const replay = await h.command('audience.retry_reassessment', payload, 'retry-request-0001');
  assert.deepEqual(replay, first);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_assessments WHERE json_extract(packet_json,\'$.reassessment.retry_of.assessment_id\')=?', parent.id).n, 1);
});

test('a nonoperator cannot create or replay retry authority', async t => {
  const { h, parent } = await failedFocusedAttempt(t), payload = retryPayload(parent);
  const requestId = 'retry-agent-replay';
  const first = await h.command('audience.retry_reassessment', payload, requestId);
  await assert.rejects(h.command('audience.retry_reassessment', payload, requestId, { kind: 'agent' }),
    error => error.status === 403 && error.code === 'AUDIENCE_OPERATOR_REQUIRED');
  await assert.rejects(h.command('audience.retry_reassessment', payload, 'retry-agent-create', { kind: 'agent' }),
    error => error.status === 403 && error.code === 'AUDIENCE_OPERATOR_REQUIRED');
  assert.equal(h.service.audience.assessment(first.assessment_id).status, 'captured');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_assessments WHERE json_extract(packet_json,\'$.reassessment.retry_of.assessment_id\')=?', parent.id).n, 1);
});

test('source revocation blocks both a new retry and a prior receipt replay', async t => {
  const { h, parent } = await failedFocusedAttempt(t), payload = retryPayload(parent);
  const requestId = 'retry-replay-after-revoke';
  await h.command('audience.retry_reassessment', payload, requestId);
  h.config.opportunity.allowedSourceRefs = [SOURCE_B];
  h.service.audience.reconcile({ limit: 10 });
  await assert.rejects(h.command('audience.retry_reassessment', payload, 'retry-before-revoke'),
    { code: 'AUDIENCE_STALE_BASIS' });
  // A previously issued receipt still cannot bypass the current source authority check.
  h.config.opportunity.allowedSourceRefs = [SOURCE];
  h.service.audience.reconcile({ limit: 10 });
  await assert.rejects(h.command('audience.retry_reassessment', payload, requestId),
    { code: 'AUDIENCE_STALE_BASIS' });
});

test('a new source head makes the frozen retry context stale before child creation', async t => {
  const { h, parent } = await failedFocusedAttempt(t), payload = retryPayload(parent);
  await h.ingest({ message_id: 'later-context', text: 'A new question changes the observed context.' });
  h.service.audience.reconcile({ limit: 10 });
  await assert.rejects(h.command('audience.retry_reassessment', payload), { code: 'AUDIENCE_STALE_BASIS' });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_assessments WHERE id<>?', parent.id).n, 1,
    'no retry child is added beside the existing ordinary assessment');
});

test('disabled model reasoning and Control Plane block retry', async t => {
  const { h, parent } = await failedFocusedAttempt(t), payload = retryPayload(parent);
  await h.command('audience.retry_reassessment', payload, 'retry-switch-replay');
  h.config.audience.modelEnabled = false;
  await assert.rejects(h.command('audience.retry_reassessment', payload, 'retry-switch-replay'),
    { code: 'AUDIENCE_MODEL_DISABLED' });
  await assert.rejects(h.command('audience.retry_reassessment', payload, 'retry-switch-new-id'),
    { code: 'AUDIENCE_MODEL_DISABLED' });
  h.config.audience.modelEnabled = true;
  h.config.controlPlane.enabled = false;
  await assert.rejects(h.command('audience.retry_reassessment', payload, 'retry-switch-plane'),
    { code: 'AUDIENCE_CONTROL_REQUIRED' });
});

test('completed focused assessment is not retry authority', async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  const goal = await h.open({ source_ids: [SOURCE] });
  await h.ingest({ message_id: 'completed-question', text: 'How can I start safely?' });
  h.service.audience.reconcile({ limit: 10 });
  const capture = await h.capture(goal.goal_id), ordinary = h.service.audience.assessment(capture.assessment_id);
  await h.command('audience.propose', { assessment_id: ordinary.id, output: proposalFrom(ordinary.packet) });
  let need = h.service.audience.need(h.store.get('SELECT id FROM audience_needs WHERE assessment_id=?', ordinary.id).id);
  await h.command('audience.review', { need_id: need.id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint, decision: 'accept', note: 'Reviewed.' });
  need = h.service.audience.need(need.id);
  const context = h.service.audience.reassessmentContext(need.id);
  const request = await h.command('audience.reassess', { need_id: need.id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint, expected_context_fingerprint: context.context_fingerprint });
  await processAudienceAssessment(h.service, { decide: async (_run, ctx) => ({ completed: true,
    final_response: JSON.stringify(modelOutputFrom(ctx.packet, { needs: [] })), usage: { input_tokens: 50, output_tokens: 5 } }) });
  const completed = h.service.audience.assessment(request.assessment_id);
  await assert.rejects(h.command('audience.retry_reassessment', retryPayload(completed)),
    { code: 'AUDIENCE_RETRY_UNAVAILABLE' });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 1);
});

test('missing or foreign frozen Hermes run cannot authorize a child', async t => {
  for (const mutation of ['missing', 'foreign_runtime']) {
    const { h, parent } = await failedFocusedAttempt(t), payload = retryPayload(parent);
    if (mutation === 'missing') h.store.run('UPDATE audience_assessments SET run_id=NULL WHERE id=?', parent.id);
    else h.store.run("UPDATE runs SET runtime='other-runtime' WHERE id=?", parent.run_id);
    await assert.rejects(h.command('audience.retry_reassessment', payload), { code: 'AUDIENCE_RECORD_INVALID' });
    assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_assessments').n, 2,
      `${mutation}: rejected authority creates no child`);
  }
});

test('corrupt parent packet lineage cannot authorize a child', async t => {
  const { h, parent } = await failedFocusedAttempt(t), payload = retryPayload(parent);
  h.store.run('UPDATE audience_assessments SET packet_json=? WHERE id=?', '{corrupt', parent.id);
  await assert.rejects(h.command('audience.retry_reassessment', payload), { code: 'AUDIENCE_RECORD_INVALID' });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_assessments WHERE id<>?', parent.id).n, 1,
    'the only other assessment is the existing ordinary parent; no child was inserted');
});
