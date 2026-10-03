// Exercise the paid-run state machine with an injected local fake. The provider key is a sentinel;
// runtime.decide is always stubbed, so this file never opens a network connection or calls a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { processAudienceAssessment } from '../business/audience-reasoning.mjs';
import { audienceHarness, SOURCE, proposalFrom } from './audience-test-helpers.mjs';

function runtimeConfig(h) {
  h.config.audience.modelEnabled = true;
  h.config.audience.maxRunsPerDay = 3;
  h.config.runtime.maxRunsPerDay = 20;
  h.config.runtime.baseUrl = 'https://unused-audience-test.invalid/v1';
  h.config.runtime.model = 'offline-fake-audience-runtime';
  h.config.runtime.dailyBudgetUsd = 5;
  h.config.runtime.inputUsdPerMillion = null;
  h.config.runtime.outputUsdPerMillion = null;
  h.config.controlPlane.maxConcurrent = 3;
}

function fakeKey(t) {
  const previous = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'offline-test-sentinel-never-sent';
  t.after(() => {
    if (previous === undefined) delete process.env.PARTNER_MODEL_API_KEY;
    else process.env.PARTNER_MODEL_API_KEY = previous;
  });
}

async function observed(h, sourceId = SOURCE) {
  const goal = await h.open({ source_ids: [sourceId] });
  await h.ingest({ message_id: 'question-1', source_id: sourceId, text: 'How can I start safely?' });
  h.service.audience.reconcile({ limit: 10 });
  assert.equal(h.service.audience.detail(goal.goal_id).ready, true, 'positive control: one bounded source packet is ready');
  return goal.goal_id;
}

function validResult(context, extra = {}) {
  return { completed: true, final_response: JSON.stringify(proposalFrom(context.packet)),
    usage: { input_tokens: 321, output_tokens: 87 }, model_identity: { model_id: 'offline-fake', model_version: '1' }, ...extra };
}

function runRow(h, assessmentId) {
  const assessment = h.service.audience.assessment(assessmentId);
  return h.store.get('SELECT * FROM runs WHERE id=?', assessment.run_id);
}

test('valid fake model receipt creates only a proposed need and never retries the considered batch', async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  await observed(h);
  let calls = 0;
  const runtime = { decide: async (_run, context) => { calls++; return validResult(context); } };

  const first = await processAudienceAssessment(h.service, runtime);
  assert.equal(first.disposition, 'proposal_created');
  assert.equal(calls, 1);
  const assessment = h.service.audience.assessment(first.assessment_id);
  assert.equal(assessment.status, 'proposed');
  assert.equal(assessment.producer, 'model');
  assert.equal(assessment.output.needs.length, 1);
  const needId = h.store.get('SELECT id FROM audience_needs WHERE assessment_id=?', assessment.id).id;
  const need = h.service.audience.need(needId);
  assert.equal(need.status, 'proposed', 'model output is never owner acceptance');
  const run = runRow(h, first.assessment_id);
  assert.equal(run.status, 'completed');
  assert.equal(run.input_tokens, 321);
  assert.equal(run.output_tokens, 87);
  assert.equal(run.cost_status, 'unknown', 'missing prices do not become zero cost');
  assert.equal(run.estimated_cost_usd, null);

  const next = await processAudienceAssessment(h.service, runtime);
  assert.notEqual(next.disposition, 'proposal_created');
  assert.equal(calls, 1, 'the same captured exchange batch does not trigger a second model attempt');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 1);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM control_tickets WHERE status IN ('reserved','running')").n, 0);
});

test('tool-bearing result is refused and its usage remains recorded', async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  await observed(h);
  let calls = 0;
  const runtime = { decide: async (_run, context) => {
    calls++;
    return validResult(context, { tool_calls: [{ id: 'tool-1', function: { name: 'source.ingest', arguments: '{}' } }] });
  } };

  const result = await processAudienceAssessment(h.service, runtime);
  assert.equal(calls, 1);
  assert.equal(result.disposition, 'model_failed');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 0);
  assert.equal(h.service.audience.assessment(result.assessment_id).status, 'interrupted');
  const run = runRow(h, result.assessment_id);
  assert.equal(run.status, 'failed');
  assert.equal(run.error, 'model_failed');
  assert.equal(run.input_tokens, 321);
  assert.equal(run.cost_status, 'unknown');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM control_tickets WHERE status IN (\'reserved\',\'running\')').n, 0);
});

test('source edit during the model turn withholds the result but keeps usage', async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  await observed(h);
  const runtime = { decide: async (_run, context) => {
    await h.ingest({ message_id: 'question-1', version: 2, text: 'The source corrected its earlier question.' });
    return validResult(context);
  } };

  const result = await processAudienceAssessment(h.service, runtime);
  assert.equal(result.disposition, 'AUDIENCE_STALE_BASIS');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 0);
  assert.equal(h.service.audience.assessment(result.assessment_id).status, 'stale');
  const run = runRow(h, result.assessment_id);
  assert.equal(run.status, 'failed');
  assert.equal(run.input_tokens, 321);
  assert.equal(run.output_tokens, 87);
  assert.equal(run.cost_status, 'unknown');
});

test('disabling Audience model reasoning while a call is in flight withholds its result', async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  await observed(h);
  const runtime = { decide: async (_run, context) => {
    h.config.audience.modelEnabled = false;
    return validResult(context);
  } };

  const result = await processAudienceAssessment(h.service, runtime);
  assert.equal(result.disposition, 'AUDIENCE_MODEL_DISABLED');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 0);
  assert.equal(h.service.audience.assessment(result.assessment_id).status, 'interrupted');
  const run = runRow(h, result.assessment_id);
  assert.equal(run.status, 'failed');
  assert.equal(run.input_tokens, 321);
  assert.equal(run.cost_status, 'unknown');
});

test('a later fabricated quote rolls back every earlier need from the same model packet', async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  await observed(h);
  const runtime = { decide: async (_run, context) => {
    const valid = proposalFrom(context.packet).needs[0];
    const invalid = { ...structuredClone(valid), title: 'Second hypothesis', support_quotes: [
      { source_event_id: valid.evidence_event_ids[0], quote: 'This sentence is not in the source.' }] };
    return { ...validResult(context), final_response: JSON.stringify({ needs: [valid, invalid] }) };
  } };

  const result = await processAudienceAssessment(h.service, runtime);
  assert.equal(result.disposition, 'AUDIENCE_QUOTE_MISMATCH');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 0, 'no first-row partial proposal survives');
  assert.equal(h.service.audience.assessment(result.assessment_id).status, 'invalid');
  const run = runRow(h, result.assessment_id);
  assert.equal(run.status, 'failed');
  assert.equal(run.input_tokens, 321);
  assert.equal(run.cost_status, 'unknown');
});

test('failed result receipt persistence interrupts the same packet and prevents automatic repurchase', async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  await observed(h);
  let calls = 0, injected = false;
  const runtime = { decide: async (_run, context) => { calls++; return validResult(context); } };
  const originalRun = h.store.run.bind(h.store);
  h.store.run = (sql, ...params) => {
    if (!injected && sql.startsWith('UPDATE runs SET status=?,result_json=')) {
      injected = true;
      throw new Error('injected durable receipt write failure');
    }
    return originalRun(sql, ...params);
  };

  await assert.rejects(processAudienceAssessment(h.service, runtime), /injected durable receipt write failure/);
  h.store.run = originalRun;
  assert.equal(injected, true);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 0, 'the failed receipt transaction rolls back its proposal');
  const assessment = h.store.get('SELECT id,status FROM audience_assessments');
  const run = h.store.get('SELECT * FROM runs');
  assert.equal(assessment.status, 'interrupted');
  assert.equal(run.status, 'interrupted');
  assert.equal(run.error, 'RESULT_PERSIST_FAILED');
  const next = await processAudienceAssessment(h.service, runtime);
  assert.notEqual(next.disposition, 'proposal_created');
  assert.equal(calls, 1, 'the interrupted captured batch is not billed again');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 1);
});

test('global run budget is checked before creating a run or invoking the model', async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  h.config.runtime.maxRunsPerDay = 1;
  await observed(h);
  h.store.run(`INSERT INTO runs(id,partner_id,status,runtime,model,context_json,created_at)
    VALUES(?,?,'failed','other-runtime','offline-test','{}',?)`, 'budget-fixture-run', h.config.partnerId, new Date().toISOString());
  let calls = 0;
  const result = await processAudienceAssessment(h.service, { decide: async () => { calls++; throw new Error('must not run'); } });
  assert.equal(result.disposition, 'CONTROL_RUN_BUDGET', 'Control Plane rejects the request before a domain run is created');
  assert.equal(calls, 0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_assessments').n, 0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM control_tickets').n, 0, 'pre-call denial leaves no resource reservation');
});
