// Bounded autonomous Audience inference and recovery. Providers are local fakes;
// no test in this file opens a network connection or uses a real model key.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { exportPartner } from '../business/export.mjs';
import { ROOT } from '../business/config.mjs';
import { Store, hash, id } from '../business/store.mjs';
import { processAudienceAssessment } from '../business/audience-reasoning.mjs';
import { digest } from '../business/source-ingestion.mjs';
import { audienceHarness, SOURCE, SOURCE_B, modelOutputFrom } from './audience-test-helpers.mjs';

function runtimeConfig(h) {
  h.config.audience.modelEnabled = true;
  h.config.audience.maxRunsPerDay = 20;
  h.config.runtime.maxRunsPerDay = 40;
  h.config.runtime.baseUrl = 'https://unused-attention-test.invalid/v1';
  h.config.runtime.model = 'offline-fake-attention-runtime';
  h.config.runtime.dailyBudgetUsd = null;
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

async function readyGoal(h, { title = 'Bounded inference test goal', source = SOURCE } = {}) {
  const goal = await h.open({ title, source_ids: [source] });
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  await h.ingest({ message_id: `attention-${slug}`, text: 'How can I begin using the service safely?', source_id: source });
  h.service.audience.reconcile({ limit: 10 });
  assert.equal(h.service.audience.detail(goal.goal_id).ready, true);
  return goal.goal_id;
}

async function grantGoal(h, goalId, maxAttempts = 1, expiresAt = new Date(Date.now() + 3600000).toISOString()) {
  const detail = h.service.audience.detail(goalId);
  assert.equal(typeof detail.attention?.scope_fingerprint, 'string', 'detail provides the current immutable grant scope');
  return h.command('audience.attention_grant', {
    goal_id: goalId, expected_revision: detail.revision,
    expected_scope_fingerprint: detail.attention.scope_fingerprint,
    max_attempts: maxAttempts, expires_at: expiresAt,
    reason: 'Bounded offline verification for this selected goal.',
  });
}

function validResult(context, extra = {}) {
  return { completed: true, final_response: JSON.stringify(modelOutputFrom(context.packet)),
    usage: { input_tokens: 321, output_tokens: 87 },
    model_identity: { model_id: 'offline-fake', model_version: '1' }, ...extra };
}

function attempts(h, goalId) {
  return h.store.all('SELECT * FROM audience_attention_attempts WHERE goal_id=? ORDER BY rowid', goalId);
}

async function failedOrdinary(t, title = 'Ordinary retry authority fixture') {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  const goalId = await readyGoal(h, { title });
  await grantGoal(h, goalId, 1);
  const result = await processAudienceAssessment(h.service, { decide: async () => ({ completed: false,
    failure_cause: { kind: 'provider_error', provider_error_type: 'timeout', retryable: true },
    usage: { input_tokens: 91, output_tokens: 0 },
  }) });
  return { h, goalId, parent: h.service.audience.assessment(result.assessment_id) };
}

test('source readiness and global model switch do not authorize ordinary inference', async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  const goalId = await readyGoal(h);
  let calls = 0;
  const denied = await processAudienceAssessment(h.service, { decide: async () => { calls++; throw new Error('must not call'); } });
  assert.notEqual(denied.disposition, 'proposal_created');
  assert.equal(calls, 0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_attention_attempts').n, 0);

  const grant = await grantGoal(h, goalId, 1);
  h.config.audience.modelEnabled = false;
  await processAudienceAssessment(h.service, { decide: async () => { calls++; throw new Error('disabled switch must hold'); } });
  assert.equal(calls, 0);
  assert.equal(attempts(h, goalId).length, 0, 'pre-admission readiness denial spends no grant attempt');
  assert.equal(h.service.audience.detail(goalId).attention.grants.find(g => g.id === grant.grant_id).remaining_attempts, 1);
});

test('only the expressly granted goal can admit a run and its attempt binds the exact run and assessment', async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  const selected = await readyGoal(h, { title: 'Selected bounded goal' });
  const neighbor = await readyGoal(h, { title: 'Unselected neighboring goal' });
  const grant = await grantGoal(h, selected, 1);
  let calls = 0;
  await processAudienceAssessment(h.service, { decide: async (_run, context) => { calls++; return validResult(context); } });
  const rows = attempts(h, selected);
  assert.equal(calls, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].grant_id, grant.grant_id);
  assert.equal(rows[0].goal_id, selected);
  assert.equal(rows[0].assessment_id, h.service.audience.assessment(rows[0].assessment_id).id);
  assert.equal(h.store.get('SELECT status FROM runs WHERE id=?', rows[0].run_id).status, 'completed');
  assert.equal(attempts(h, neighbor).length, 0);
  await processAudienceAssessment(h.service, { decide: async () => { calls++; throw new Error('neighbor is not authorized'); } });
  assert.equal(calls, 1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 1);
});

test('concurrent ticks cannot exceed a one-attempt grant cap', async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  const goalId = await readyGoal(h);
  await grantGoal(h, goalId, 1);
  let calls = 0;
  const runtime = { decide: async (_run, context) => { calls++; return validResult(context); } };
  const [first, second] = await Promise.all([
    processAudienceAssessment(h.service, runtime), processAudienceAssessment(h.service, runtime),
  ]);
  assert.equal([first, second].filter(r => r.disposition === 'proposal_created').length, 1);
  assert.equal(calls, 1);
  assert.equal(attempts(h, goalId).length, 1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 1);
  assert.equal(h.service.audience.detail(goalId).attention.grants[0].attempts_used, 1);
});

test('an owner-created manual capture is never promoted into an implicit model request', async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  const goalId = await readyGoal(h);
  await grantGoal(h, goalId, 1);
  const manual = await h.capture(goalId);
  assert.equal(h.service.audience.assessment(manual.assessment_id).producer, 'operator');
  let calls = 0;
  const result = await processAudienceAssessment(h.service, { decide: async () => { calls++; throw new Error('manual packet must remain manual'); } });
  assert.notEqual(result.assessment_id, manual.assessment_id);
  assert.equal(calls, 0);
  assert.equal(h.service.audience.assessment(manual.assessment_id).status, 'captured');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 0);
  assert.equal(attempts(h, goalId).length, 0);
});

test('failed and unknown attempts count across restart, while the last admitted attempt can still apply at zero remaining', async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  const goalId = await readyGoal(h);
  const grant = await grantGoal(h, goalId, 2);
  const failed = await processAudienceAssessment(h.service, { decide: async () => ({
    completed: false, failure_cause: { kind: 'provider_error', provider_error_type: 'timeout', retryable: true },
    usage: { input_tokens: 45, output_tokens: 0 },
  }) });
  assert.equal(failed.disposition, 'model_failed');
  assert.equal(attempts(h, goalId).length, 1);
  assert.equal(h.store.get('SELECT cost_status FROM runs WHERE id=?', attempts(h, goalId)[0].run_id).cost_status, 'unknown');

  h.restart();
  await h.ingest({ message_id: 'attention-second-head', text: 'The same source asks how to choose a first step.' });
  h.service.audience.reconcile({ limit: 10 });
  let calls = 0;
  const completed = await processAudienceAssessment(h.service, { decide: async (_run, context) => { calls++; return validResult(context); } });
  assert.equal(calls, 1);
  assert.equal(completed.disposition, 'proposal_created');
  assert.equal(attempts(h, goalId).length, 2);
  const detail = h.service.audience.detail(goalId);
  assert.equal(detail.attention.grants.find(g => g.id === grant.grant_id).remaining_attempts, 0);
  const blocked = await processAudienceAssessment(h.service, { decide: async () => { calls++; throw new Error('cap is exhausted'); } });
  assert.notEqual(blocked.assessment_id, completed.assessment_id);
  assert.equal(calls, 1);
  assert.equal(attempts(h, goalId).length, 2);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 2);
  assert.ok(grant.grant_id);
});

test('revocation during an admitted call withholds its proposal and retains usage', async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  const goalId = await readyGoal(h);
  const grant = await grantGoal(h, goalId, 1);
  const grantView = h.service.audience.detail(goalId).attention.grants.find(g => g.id === grant.grant_id);
  const runtime = { decide: async (_run, context) => {
    await h.command('audience.attention_revoke', {
      grant_id: grant.grant_id, expected_grant_fingerprint: grantView.grant_fingerprint,
      reason: 'Stop this test mandate while the fake call is in flight.',
    });
    return validResult(context);
  } };
  const result = await processAudienceAssessment(h.service, runtime);
  assert.notEqual(result.disposition, 'proposal_created');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 0);
  const attempt = attempts(h, goalId)[0];
  assert.equal(attempt.grant_id, grant.grant_id);
  const run = h.store.get('SELECT * FROM runs WHERE id=?', attempt.run_id);
  assert.equal(run.status, 'failed');
  assert.equal(run.input_tokens, 321);
  assert.equal(run.output_tokens, 87);
  assert.equal(run.cost_status, 'unknown');
});

test('grant expiry is checked after admission without expiring the source lease', async t => {
  fakeKey(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:10.000Z') });
  const h = audienceHarness(t); runtimeConfig(h);
  const goalId = await readyGoal(h);
  const deadline = new Date(Date.now() + 60000).toISOString();
  const grant = await grantGoal(h, goalId, 1, deadline);
  const result = await processAudienceAssessment(h.service, { decide: async (_run, context) => {
    t.mock.timers.tick(60001);
    const detail = h.service.audience.detail(goalId);
    assert.ok(detail.watches.every(w => w.health.current), 'the source read leases remain valid');
    const sourceEvent = h.store.get("SELECT payload_json FROM events WHERE kind='source.message' AND json_extract(payload_json,'$.source_id')=? ORDER BY id DESC LIMIT 1", SOURCE);
    const observedAt = Date.parse(JSON.parse(sourceEvent.payload_json).created_at);
    const remainingAge = detail.max_age_seconds * 1000 - (Date.now() - observedAt);
    assert.ok(remainingAge > 0, 'the observation remains within its one-hour goal age limit');
    return validResult(context);
  } });
  assert.notEqual(result.disposition, 'proposal_created');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 0);
  assert.equal(h.store.get('SELECT input_tokens FROM runs WHERE id=?', attempts(h, goalId)[0].run_id).input_tokens, 321);
  assert.ok(grant.grant_id);
});

test('restart interrupts an in-flight ordinary purchase and does not resurrect it', async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  const goalId = await readyGoal(h);
  await grantGoal(h, goalId, 1);
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  let release;
  const gated = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const pending = processAudienceAssessment(h.service, { decide: async (_run, context) => {
    calls++;
    enter(context);
    return gated;
  } });
  const context = await entered;
  const running = h.store.get("SELECT id,run_id FROM audience_assessments WHERE status='running'");
  assert.ok(running?.run_id);
  h.restart();
  assert.equal(h.service.audience.assessment(running.id).status, 'interrupted');
  assert.equal(h.store.get('SELECT status FROM runs WHERE id=?', running.run_id).status, 'interrupted');
  release(validResult(context));
  await assert.rejects(pending);
  const retry = await processAudienceAssessment(h.service, { decide: async () => { calls++; throw new Error('crashed run cannot be resumed'); } });
  assert.notEqual(retry.assessment_id, running.id);
  assert.equal(calls, 1);
  assert.equal(attempts(h, goalId).length, 1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 1);
});

test('configured model, output limit, source policy and paused-goal changes kill late proposals', async t => {
  fakeKey(t);
  for (const mutation of ['model', 'output_limit', 'source_policy', 'goal_pause']) {
    const h = audienceHarness(t); runtimeConfig(h);
    const goalId = await readyGoal(h, { title: `Kill ${mutation} late result` });
    await grantGoal(h, goalId, 1);
    const runtime = { decide: async (_run, context) => {
      if (mutation === 'model') h.config.runtime.model = 'changed-after-admission';
      else if (mutation === 'output_limit') h.config.runtime.maxOutputTokens += 1;
      else if (mutation === 'source_policy') h.config.opportunity.allowedSourceRefs = [SOURCE_B];
      else {
        const current = h.service.audience.detail(goalId);
        await h.command('audience.pause', { goal_id: goalId, expected_revision: current.revision,
          reason: 'Pause while the offline fake call is pending.' });
      }
      return validResult(context);
    } };
    const result = await processAudienceAssessment(h.service, runtime);
    assert.notEqual(result.disposition, 'proposal_created', `${mutation} changes applicability during the call`);
    assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 0, `${mutation} cannot leave a proposal`);
    const attempt = attempts(h, goalId)[0];
    assert.ok(attempt, `${mutation} still records the admitted attempt`);
    const run = h.store.get('SELECT * FROM runs WHERE id=?', attempt.run_id);
    assert.equal(run.status, 'failed');
    assert.equal(run.input_tokens, 321);
    assert.equal(run.output_tokens, 87);
    assert.equal(run.cost_status, 'unknown');
  }
});

test('ordinary failed first assessment has a grant-independent explicit one-shot retry proof', async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  const goalId = await readyGoal(h);
  const grant = await grantGoal(h, goalId, 1);
  const failure = await processAudienceAssessment(h.service, { decide: async () => ({
    completed: false, failure_cause: { kind: 'provider_error', provider_error_type: 'timeout', retryable: true },
    usage: { input_tokens: 123, output_tokens: 0 },
  }) });
  const parent = h.service.audience.assessment(failure.assessment_id);
  assert.equal(parent.status, 'interrupted');
  assert.equal(parent.packet.reassessment, undefined, 'this is an ordinary first pass, with no need_id');
  assert.equal(parent.retry.context_fingerprint, digest(parent.packet.scope),
    'the explicit retry binds the canonical frozen goal/source scope');
  const payload = { assessment_id: parent.id, expected_basis_fingerprint: parent.basis_fingerprint,
    expected_context_fingerprint: parent.retry.context_fingerprint,
    reason: 'The transient fake provider timeout permits one explicit recovery.' };
  const receipt = await h.command('audience.retry_assessment', payload, 'ordinary-retry-first-request');
  const child = h.service.audience.assessment(receipt.assessment_id);
  assert.equal(child.status, 'captured');
  assert.notEqual(child.id, parent.id);
  assert.deepEqual(child.packet.reasoning_retry, {
    version: 1, model_requested: true,
    retry_of: { assessment_id: parent.id, basis_fingerprint: parent.basis_fingerprint },
    context_fingerprint: parent.retry.context_fingerprint,
  });
  assert.notEqual(child.basis_fingerprint, parent.basis_fingerprint);
  await assert.rejects(h.command('audience.retry_assessment', payload, 'ordinary-retry-second-request'),
    { code: 'AUDIENCE_ALREADY_CONSIDERED' });
  const replay = await h.command('audience.retry_assessment', payload, 'ordinary-retry-first-request');
  assert.deepEqual(replay, receipt);
  assert.equal(attempts(h, goalId).length, 1, 'explicit recovery has no ambient attempt binding');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 1);
  h.restart();
  assert.equal(h.service.audience.assessment(child.id).status, 'captured', 'an explicit captured request resumes once after restart');
  const completed = await processAudienceAssessment(h.service, { decide: async (_run, context) => validResult(context) });
  assert.equal(completed.assessment_id, child.id);
  assert.equal(completed.disposition, 'proposal_created');
  assert.equal(attempts(h, goalId).length, 1, 'the one-shot recovery does not spend or renew ambient allowance');
  const later = await processAudienceAssessment(h.service, { decide: async () => { throw new Error('completed retry ran twice'); } });
  assert.notEqual(later.assessment_id, child.id);
  assert.equal(h.service.audience.detail(goalId).attention.grants.find(g => g.id === attempts(h, goalId)[0].grant_id).remaining_attempts, 0);
  assert.equal(grant.grant_id, attempts(h, goalId)[0].grant_id);
});

test('ordinary retry rejects changed source evidence and altered context fingerprints', async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  const goalId = await readyGoal(h);
  await grantGoal(h, goalId, 1);
  const failure = await processAudienceAssessment(h.service, { decide: async () => ({ completed: false,
    failure_cause: { kind: 'provider_error', provider_error_type: 'timeout', retryable: true }, usage: { input_tokens: 1, output_tokens: 0 } }) });
  const parent = h.service.audience.assessment(failure.assessment_id);
  const payload = { assessment_id: parent.id, expected_basis_fingerprint: parent.basis_fingerprint,
    expected_context_fingerprint: parent.retry.context_fingerprint, reason: 'One bounded retry.' };
  await assert.rejects(h.command('audience.retry_assessment', { ...payload, expected_context_fingerprint: 'forged-context' }),
    { code: 'AUDIENCE_STALE_BASIS' });
  await assert.rejects(h.command('audience.retry_assessment', { ...payload, expected_context_fingerprint: undefined }),
    { code: 'AUDIENCE_FIELDS_INVALID' });
  await h.ingest({ message_id: 'new-head-after-failure', text: 'A materially new question changes the context.' });
  h.service.audience.reconcile({ limit: 10 });
  await assert.rejects(h.command('audience.retry_assessment', payload), { code: 'AUDIENCE_STALE_BASIS' });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_assessments').n, 1);
});

test('ordinary retry requires the exact frozen parent packet', async t => {
  const { h, parent } = await failedOrdinary(t, 'Frozen packet mismatch fixture');
  const run = h.store.get('SELECT * FROM runs WHERE id=?', parent.run_id);
  const frozen = JSON.parse(run.context_json);
  frozen.packet.objective = 'Forged model context after the paid attempt.';
  h.store.run('UPDATE runs SET context_json=? WHERE id=?', JSON.stringify(frozen), run.id);
  await assert.rejects(h.command('audience.retry_assessment', { assessment_id: parent.id,
    expected_basis_fingerprint: parent.basis_fingerprint, expected_context_fingerprint: parent.retry.context_fingerprint,
    reason: 'The frozen run no longer proves its exact parent packet.' }), { code: 'AUDIENCE_RECORD_INVALID' });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_assessments').n, 1);
});

test('ordinary retry rejects a corrupted exact run-to-assessment binding', async t => {
  const { h, goalId } = await failedOrdinary(t, 'Attempt binding mismatch fixture');
  const parent = h.store.get('SELECT * FROM audience_assessments WHERE goal_id=? ORDER BY rowid LIMIT 1', goalId);
  const targetId = id();
  h.store.run(`INSERT INTO audience_assessments(id,goal_id,basis_fingerprint,packet_json,status,producer,run_id,output_json,created_at)
    VALUES(?,?,?,'{}','stale','operator',NULL,NULL,?)`, targetId, goalId, `forged-${targetId}`, new Date().toISOString());
  h.store.run('UPDATE audience_attention_attempts SET assessment_id=? WHERE run_id=?', targetId, parent.run_id);
  await assert.rejects(h.command('audience.retry_assessment', { assessment_id: parent.id,
    expected_basis_fingerprint: parent.basis_fingerprint,
    expected_context_fingerprint: digest(JSON.parse(parent.packet_json).scope),
    reason: 'The attempt binding points at another assessment.' }), { code: 'AUDIENCE_ATTENTION_BINDING_INVALID' });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_assessments').n, 2,
    'corrupt binding cannot create a child beside the malformed target row');
});

test('late output is withheld after its exact run-to-assessment binding is corrupted', async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  const goalId = await readyGoal(h, { title: 'Late result binding mismatch fixture' });
  await grantGoal(h, goalId, 1);
  const result = await processAudienceAssessment(h.service, { decide: async (run, context) => {
    const targetId = id();
    h.store.run(`INSERT INTO audience_assessments(id,goal_id,basis_fingerprint,packet_json,status,producer,run_id,output_json,created_at)
      VALUES(?,?,?,'{}','stale','operator',NULL,NULL,?)`, targetId, goalId, `forged-late-${targetId}`, new Date().toISOString());
    h.store.run('UPDATE audience_attention_attempts SET assessment_id=? WHERE run_id=?', targetId, run.id);
    return validResult(context);
  } });
  assert.notEqual(result.disposition, 'proposal_created');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 0,
    'a late output cannot apply after its immutable attempt binding is corrupted');
  const run = h.store.get('SELECT r.* FROM runs r JOIN audience_assessments a ON a.run_id=r.id WHERE a.id=?', result.assessment_id);
  assert.equal(run.status, 'failed');
  assert.equal(run.input_tokens, 321);
  assert.equal(run.output_tokens, 87);
});

test('forged or missing ordinary child lineage withholds a late model result and usage remains', async t => {
  fakeKey(t);
  for (const mutation of ['forged_lineage', 'missing_marker']) {
    const { h, goalId, parent } = await failedOrdinary(t, `Child marker ${mutation}`);
    const request = await h.command('audience.retry_assessment', { assessment_id: parent.id,
      expected_basis_fingerprint: parent.basis_fingerprint, expected_context_fingerprint: parent.retry.context_fingerprint,
      reason: 'One explicit offline child turn.' });
    const child = h.service.audience.assessment(request.assessment_id);
    const result = await processAudienceAssessment(h.service, { decide: async (_run, context) => {
      const packet = structuredClone(context.packet);
      if (mutation === 'forged_lineage') packet.reasoning_retry.retry_of.basis_fingerprint = 'forged-parent-fingerprint';
      else delete packet.reasoning_retry;
      h.store.run('UPDATE audience_assessments SET packet_json=? WHERE id=?', JSON.stringify(packet), child.id);
      return validResult(context);
    } });
    assert.notEqual(result.disposition, 'proposal_created', mutation);
    assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 0);
    const run = h.store.get('SELECT * FROM runs WHERE id=?', h.service.audience.assessment(child.id).run_id);
    assert.equal(run.status, 'failed');
    assert.equal(run.input_tokens, 321);
    assert.equal(run.output_tokens, 87);
    assert.equal(attempts(h, goalId).length, 1, 'the retry child has no ambient grant binding');
  }
});

test('a canceled child stays terminal when the model is disabled and source evidence advances', async t => {
  fakeKey(t);
  const { h, goalId, parent } = await failedOrdinary(t, 'Canceled child evidence advance fixture');
  const request = await h.command('audience.retry_assessment', { assessment_id: parent.id,
    expected_basis_fingerprint: parent.basis_fingerprint, expected_context_fingerprint: parent.retry.context_fingerprint,
    reason: 'Prepare an explicit retry that will be canceled.' });
  const child = h.service.audience.assessment(request.assessment_id);
  await h.command('audience.cancel_assessment', { assessment_id: child.id,
    expected_basis_fingerprint: child.basis_fingerprint });
  h.config.audience.modelEnabled = false;
  await h.ingest({ message_id: 'canceled-child-new-evidence', text: 'A new source message changes the evidence.' });
  h.service.audience.reconcile({ limit: 10 });
  let calls = 0;
  await processAudienceAssessment(h.service, { decide: async () => { calls++; throw new Error('disabled child must not resume'); } });
  assert.equal(calls, 0);
  assert.equal(h.store.get('SELECT status FROM audience_assessments WHERE id=?', child.id).status, 'interrupted');
  h.config.audience.modelEnabled = true;
  await assert.rejects(h.command('audience.retry_assessment', { assessment_id: child.id,
    expected_basis_fingerprint: child.basis_fingerprint,
    expected_context_fingerprint: digest(child.packet.scope), reason: 'A canceled child is terminal.' }),
  { code: 'AUDIENCE_RETRY_UNAVAILABLE' });
  await assert.rejects(h.command('audience.retry_assessment', { assessment_id: parent.id,
    expected_basis_fingerprint: parent.basis_fingerprint, expected_context_fingerprint: parent.retry.context_fingerprint,
    reason: 'Changed evidence requires a fresh assessment.' }), { code: 'AUDIENCE_STALE_BASIS' });
  assert.equal(attempts(h, goalId).length, 1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 1);
});

test('a failed ordinary retry child needs its own explicit second-generation request', async t => {
  fakeKey(t);
  const { h, goalId, parent } = await failedOrdinary(t, 'Second-generation retry fixture');
  const firstRequest = await h.command('audience.retry_assessment', { assessment_id: parent.id,
    expected_basis_fingerprint: parent.basis_fingerprint, expected_context_fingerprint: parent.retry.context_fingerprint,
    reason: 'First explicit ordinary retry.' });
  const child = h.service.audience.assessment(firstRequest.assessment_id);
  const failedChild = await processAudienceAssessment(h.service, { decide: async () => ({ completed: false,
    failure_cause: { kind: 'provider_error', provider_error_type: 'timeout', retryable: true },
    usage: { input_tokens: 102, output_tokens: 0 },
  }) });
  assert.equal(failedChild.assessment_id, child.id);
  const stopped = h.service.audience.assessment(child.id);
  assert.equal(stopped.status, 'interrupted');
  const payload = { assessment_id: stopped.id, expected_basis_fingerprint: stopped.basis_fingerprint,
    expected_context_fingerprint: stopped.retry.context_fingerprint,
    reason: 'Authorize one new child after the prior explicit turn failed.' };
  const secondRequest = await h.command('audience.retry_assessment', payload, 'ordinary-second-generation');
  const grandchild = h.service.audience.assessment(secondRequest.assessment_id);
  assert.deepEqual(grandchild.packet.reasoning_retry, {
    version: 1, model_requested: true,
    retry_of: { assessment_id: stopped.id, basis_fingerprint: stopped.basis_fingerprint },
    context_fingerprint: digest(grandchild.packet.scope),
  });
  await assert.rejects(h.command('audience.retry_assessment', payload, 'ordinary-second-generation-duplicate'),
    { code: 'AUDIENCE_ALREADY_CONSIDERED' });
  const completed = await processAudienceAssessment(h.service, { decide: async (_run, context) => validResult(context) });
  assert.equal(completed.assessment_id, grandchild.id);
  assert.equal(completed.disposition, 'proposal_created');
  assert.equal(attempts(h, goalId).length, 1, 'neither explicit retry child consumes ambient allowance');
  assert.equal(h.store.get('SELECT input_tokens FROM runs WHERE id=?', parent.run_id).input_tokens, 91);
  assert.equal(h.store.get('SELECT input_tokens FROM runs WHERE id=?', stopped.run_id).input_tokens, 102);
});

test('transfer retires grants and pending retry requests without losing historical receipts', async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  const goalId = await readyGoal(h);
  const sourceGrant = await grantGoal(h, goalId, 2);
  const failed = await processAudienceAssessment(h.service, { decide: async () => ({ completed: false,
    failure_cause: { kind: 'provider_error', provider_error_type: 'timeout', retryable: true }, usage: { input_tokens: 77, output_tokens: 0 } }) });
  const parent = h.service.audience.assessment(failed.assessment_id);
  const request = await h.command('audience.retry_assessment', { assessment_id: parent.id,
    expected_basis_fingerprint: parent.basis_fingerprint, expected_context_fingerprint: parent.retry.context_fingerprint,
    reason: 'Prepare one explicit retry so transfer recovery can be checked.' });
  const bundle = exportPartner(h.store);
  assert.equal(bundle.tables.audience_attention_grants.length, 1, 'source export records the grant history');
  assert.equal(bundle.tables.audience_attention_attempts.length, 1, 'source export records the exact attempt receipt');
  const sourceAttempt = bundle.tables.audience_attention_attempts[0];
  const file = path.join(h.directory, 'attention-transfer.json');
  fs.writeFileSync(file, JSON.stringify(bundle), { flag: 'wx' });
  const destination = path.join(ROOT, 'exports', `attention-transfer-${id()}`);
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  const imported = spawnSync(process.execPath, ['scripts/import.mjs', file, destination],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.equal(imported.status, 0, imported.stderr);
  const transferred = new Store(path.join(destination, 'data'));
  try {
    const importedGrant = transferred.get('SELECT * FROM audience_attention_grants WHERE id=?', sourceGrant.grant_id);
    assert.ok(importedGrant, 'the immutable mandate remains auditable after transfer');
    assert.equal(importedGrant.status, 'revoked');
    assert.equal(importedGrant.revocation_reason, 'TRANSFER_AUTHORITY_REQUIRES_REVIEW');
    const importedAttempt = transferred.get('SELECT * FROM audience_attention_attempts WHERE run_id=?', sourceAttempt.run_id);
    assert.deepEqual({ ...importedAttempt }, { ...sourceAttempt }, 'the exact historical run-to-grant binding survives');
    assert.equal(transferred.get('SELECT status FROM audience_assessments WHERE id=?', request.assessment_id).status, 'stale');
    assert.equal(transferred.get('SELECT input_tokens FROM runs WHERE id=?', parent.run_id).input_tokens, 77,
      'the failed parent run usage survives transfer as history');
    const service = new (await import('../business/service.mjs')).BusinessService(transferred, h.config);
    let calls = 0;
    const result = await processAudienceAssessment(service, { decide: async () => { calls++; throw new Error('transfer cannot resume'); } });
    assert.notEqual(result.assessment_id, request.assessment_id);
    assert.equal(calls, 0);
    service.control.close(); service.control.releaseProcess();
  } finally { transferred.close(); }

  // A valid pre-013 export still has its historical v12 table catalogue even though
  // the current database also has later attention and follow-up tables.
  const legacy = structuredClone(bundle);
  legacy.migrations = legacy.migrations.slice(0, 12);
  delete legacy.tables.source_observation_epochs;
  delete legacy.tables.audience_first_contact_heads;
  delete legacy.tables.audience_followup_requests;
  delete legacy.tables.audience_followup_attempts;
  delete legacy.tables.audience_attention_grants;
  delete legacy.tables.audience_attention_attempts;
  delete legacy.tables.model_profiles;
  delete legacy.tables.audience_attention_models;
  delete legacy.tables.audience_watch_epochs;
  legacy.tables_sha256 = hash(JSON.stringify(legacy.tables));
  const legacyFile = path.join(h.directory, 'attention-transfer-v12.json');
  fs.writeFileSync(legacyFile, JSON.stringify(legacy), { flag: 'wx' });
  const legacyDestination = path.join(ROOT, 'exports', `attention-transfer-v12-${id()}`);
  t.after(() => fs.rmSync(legacyDestination, { recursive: true, force: true }));
  const legacyImport = spawnSync(process.execPath, ['scripts/import.mjs', legacyFile, legacyDestination],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.equal(legacyImport.status, 0, legacyImport.stderr);
  const restoredLegacy = new Store(path.join(legacyDestination, 'data'));
  try {
    assert.equal(restoredLegacy.get('SELECT COUNT(*) n FROM audience_attention_grants').n, 0);
    assert.equal(restoredLegacy.get('SELECT COUNT(*) n FROM audience_attention_attempts').n, 0);
    assert.equal(restoredLegacy.get('SELECT COUNT(*) n FROM schema_migrations').n, 18,
      'a pre-013 bundle is restored into the current schema without inventing authority');
  } finally { restoredLegacy.close(); }
});
