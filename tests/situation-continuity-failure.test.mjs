import test from 'node:test';
import assert from 'node:assert/strict';
import { processAudienceAssessment } from '../business/audience-reasoning.mjs';
import { audienceHarness } from './audience-test-helpers.mjs';

for (const throws of [false, true]) test(`a ${throws ? 'thrown' : 'returned'} provider failure persists its closed cause without provider text or retry`, async t => {
  const h = audienceHarness(t), previous = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'offline-failure-sentinel-never-sent';
  t.after(() => previous === undefined ? delete process.env.PARTNER_MODEL_API_KEY : process.env.PARTNER_MODEL_API_KEY = previous);
  Object.assign(h.config.runtime, { baseUrl: 'https://unused-situation.invalid/v1', model: 'offline-failure', maxRunsPerDay: 20, dailyBudgetUsd: null });
  Object.assign(h.config.audience, { modelEnabled: true, maxRunsPerDay: 20 });
  await h.open(); await h.ingest({ message_id: 'failure-root', text: 'Can someone explain this setup?' });
  h.service.audience.reconcile();
  const secret = 'PRIVATE_RAW_PROVIDER_RESPONSE_NOT_TO_PERSIST';
  const cause = { kind: 'provider_error', provider_error_type: 'timeout', retryable: true, attempt_count: 1,
    http_status: null, timed_out: false, stdout_json_valid: true, raw_provider_body: secret };
  let calls = 0;
  const runtime = { decide: async () => {
    calls++;
    if (throws) throw Object.assign(new Error(secret), { failure_cause: cause });
    return { completed: false, error: secret, failure_cause: cause, api_calls: 1 };
  } };
  const result = await processAudienceAssessment(h.service, runtime);
  assert.equal(result.disposition, 'model_failed');
  const a = h.service.audience.assessment(result.assessment_id), run = h.store.get('SELECT * FROM runs WHERE id=?', a.run_id);
  const receipt = JSON.parse(run.result_json);
  assert.equal(receipt.failure_cause.kind, 'provider_error');
  assert.equal(receipt.failure_cause.provider_error_type, 'timeout');
  assert.equal(receipt.failure_cause.attempt_count, 1);
  assert.equal(receipt.model_api_calls, throws ? null : 1);
  assert.ok(!run.result_json.includes(secret));
  assert.equal(run.cost_status, 'unknown'); assert.equal(a.status, 'interrupted');
  await processAudienceAssessment(h.service, runtime);
  assert.equal(calls, 1); assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 0);
});
