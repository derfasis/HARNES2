// Focused Audience retry recovery kill tests. Synthetic source evidence and an
// injected runtime keep every test offline; no configured provider is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../business/config.mjs';
import { Store, id } from '../business/store.mjs';
import { digest } from '../business/source-ingestion.mjs';
import { exportPartner } from '../business/export.mjs';
import { processAudienceAssessment } from '../business/audience-reasoning.mjs';
import { audienceHarness, SOURCE, SOURCE_B, proposalFrom } from './audience-test-helpers.mjs';

function modelConfig(h, { knownCost = true, maxRuns = 20 } = {}) {
  h.config.audience.modelEnabled = true;
  h.config.audience.maxRunsPerDay = 20;
  h.config.runtime.maxRunsPerDay = maxRuns;
  h.config.runtime.baseUrl = 'https://unused-audience-recovery.invalid/v1';
  h.config.runtime.model = 'offline-fake-audience-recovery';
  h.config.runtime.dailyBudgetUsd = 5;
  h.config.runtime.inputUsdPerMillion = knownCost ? 1 : null;
  h.config.runtime.outputUsdPerMillion = knownCost ? 1 : null;
  h.config.controlPlane.maxConcurrent = 3;
  h.config.controlPlane.reservationUsd = 0.25;
}

function fakeKey(t) {
  const previous = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'offline-audience-recovery-sentinel-never-sent';
  t.after(() => {
    if (previous === undefined) delete process.env.PARTNER_MODEL_API_KEY;
    else process.env.PARTNER_MODEL_API_KEY = previous;
  });
}

async function acceptedNeed(h, { sourceId = SOURCE, prefix = 'recovery' } = {}) {
  const goal = await h.open({ source_ids: [sourceId] });
  await h.ingest({ source_id: sourceId, message_id: `${prefix}-root-1`, text: 'How can I begin the setup?' });
  h.service.audience.reconcile({ limit: 10 });
  const capture = await h.capture(goal.goal_id);
  const packet = h.service.audience.assessment(capture.assessment_id).packet;
  const proposal = await h.command('audience.propose', { assessment_id: capture.assessment_id,
    output: proposalFrom(packet) });
  let need = h.service.audience.need(proposal.need_ids[0]);
  await h.command('audience.review', { need_id: need.id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint, decision: 'accept', note: 'Accepted synthetic recovery fixture.' });
  need = h.service.audience.need(need.id);
  return { goal, need, sourceId, prefix };
}

async function addRoot(h, { sourceId = SOURCE, prefix = 'recovery', index = 2,
  text = 'Where is the first setup step?' } = {}) {
  const result = await h.ingest({ source_id: sourceId, message_id: `${prefix}-root-${index}`, text });
  h.service.audience.reconcile({ limit: 10 });
  return result;
}

async function consumeOrdinary(h, goalId) {
  const capture = await h.capture(goalId);
  await h.command('audience.propose', { assessment_id: capture.assessment_id, output: { needs: [] } });
}

async function makeFailedParent(h, need, { usage = { input_tokens: 211, output_tokens: 73 } } = {}) {
  const context = h.service.audience.reassessmentContext(need.id);
  const requested = await h.command('audience.reassess', { need_id: need.id,
    expected_revision: context.need_revision,
    expected_basis_fingerprint: context.need_basis_fingerprint,
    expected_context_fingerprint: context.context_fingerprint });
  const assessment = h.service.audience.assessment(requested.assessment_id);
  const result = await processAudienceAssessment(h.service, { decide: async () => ({ completed: false,
    failure_cause: { kind: 'provider_error', provider_error_type: 'timeout', retryable: true,
      attempt_count: 1, http_status: null, timed_out: true, stdout_json_valid: false },
      usage, model_identity: { model_id: 'offline-fake', model_version: '1' } }) });
  assert.equal(result.assessment_id, assessment.id);
  assert.equal(result.disposition, 'model_failed');
  const failed = h.service.audience.assessment(assessment.id);
  assert.ok(['interrupted', 'failed'].includes(failed.status));
  const run = h.store.get('SELECT * FROM runs WHERE id=?', failed.run_id);
  assert.equal(run.status, 'failed');
  assert.equal(run.input_tokens, usage.input_tokens);
  assert.equal(run.output_tokens, usage.output_tokens);
  return { context, assessment: failed, run };
}

function retryPayload(parent, context, reason = 'Retry after the provider timeout.') {
  return { assessment_id: parent.id, expected_basis_fingerprint: parent.basis_fingerprint,
    expected_context_fingerprint: context.context_fingerprint, reason };
}

function runForAssessment(h, assessmentId) {
  return h.store.get("SELECT * FROM runs WHERE context_json->>'$.assessment_id'=?", assessmentId);
}

async function retryParent(h, parent, context) {
  const receipt = await h.command('audience.retry_reassessment', retryPayload(parent, context));
  return h.service.audience.assessment(receipt.assessment_id);
}

async function preparedNeed(h, options = {}) {
  const seeded = await acceptedNeed(h, options);
  await addRoot(h, seeded);
  // Focused sampling includes consumed canonical evidence. Marking the ordinary
  // exchange consumed keeps discovery from being mistaken for an implicit retry.
  await consumeOrdinary(h, seeded.goal.goal_id);
  return seeded;
}

test('a failed focused attempt is inert until one explicit retry creates a linked child that resumes once', async t => {
  fakeKey(t);
  const h = audienceHarness(t); modelConfig(h);
  const { goal, need } = await preparedNeed(h);
  const { context, assessment: parent, run: oldRun } = await makeFailedParent(h, need);

  let implicitCalls = 0;
  const implicit = await processAudienceAssessment(h.service, { decide: async () => {
    implicitCalls++; throw new Error('an unchanged failed assessment must not be repurchased');
  } });
  assert.notEqual(implicit.assessment_id, parent.id);
  assert.equal(implicitCalls, 0);
  assert.equal(runForAssessment(h, parent.id).id, oldRun.id);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 1);

  const child = await retryParent(h, parent, context);
  assert.equal(child.status, 'captured');
  assert.notEqual(child.id, parent.id);
  assert.notEqual(child.basis_fingerprint, parent.basis_fingerprint,
    'the child has its own immutable attempt fingerprint');
  assert.equal(child.packet.reassessment.context_fingerprint, context.context_fingerprint,
    'retry preserves the unchanged canonical source context');
  assert.deepEqual(child.packet.reassessment.retry_of, { assessment_id: parent.id, basis_fingerprint: parent.basis_fingerprint });
  assert.equal(h.service.audience.assessment(parent.id).status, parent.status);
  assert.deepEqual(runForAssessment(h, parent.id), oldRun, 'retry leaves the original usage receipt byte-for-byte unchanged');
  await assert.rejects(retryParent(h, parent, context));
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_assessments WHERE goal_id=?', goal.goal_id).n, 4,
    'duplicate parent requests do not create a second retry child');

  h.restart();
  let calls = 0;
  const runtime = { decide: async (_run, packetContext) => {
    calls++;
    assert.deepEqual(packetContext.packet.reassessment.retry_of,
      { assessment_id: parent.id, basis_fingerprint: parent.basis_fingerprint });
    return { completed: true, final_response: JSON.stringify({ needs: [] }),
      usage: { input_tokens: 101, output_tokens: 14 },
      model_identity: { model_id: 'offline-fake', model_version: '1' } };
  } };
  const resumed = await processAudienceAssessment(h.service, runtime);
  assert.equal(resumed.assessment_id, child.id);
  assert.equal(resumed.disposition, 'no_revision_proposed');
  assert.equal(calls, 1);
  assert.equal(h.service.audience.assessment(child.id).status, 'proposed');
  assert.equal(h.service.audience.need(need.id).revision, need.revision);
  await processAudienceAssessment(h.service, runtime);
  assert.equal(calls, 1, 'a completed child cannot be bought again');
});

test('a recovered running retry child is interrupted and never automatically retried', async t => {
  fakeKey(t);
  const h = audienceHarness(t); modelConfig(h);
  const { need } = await preparedNeed(h);
  const { context, assessment: parent } = await makeFailedParent(h, need);
  const child = await retryParent(h, parent, context);
  const runId = id();
  h.store.run(`INSERT INTO runs(id,partner_id,status,runtime,model,context_json,created_at)
    VALUES(?,?,'running','hermes-audience-v1',?,?,?)`, runId, h.config.partnerId,
  h.config.runtime.model, JSON.stringify({ assessment_id: child.id, goal_id: child.goal_id,
    packet: child.packet, model_config: h.config.runtime }), new Date().toISOString());
  h.store.run("UPDATE audience_assessments SET status='running',producer='model',run_id=? WHERE id=?", runId, child.id);
  h.restart();
  assert.equal(h.service.audience.assessment(child.id).status, 'interrupted');
  let calls = 0;
  await processAudienceAssessment(h.service, { decide: async () => { calls++; throw new Error('interrupted child must stay terminal'); } });
  assert.equal(calls, 0);
  assert.equal(h.store.get('SELECT status FROM runs WHERE id=?', runId).status, 'interrupted');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 2);
});

test('a focused assessment canceled before purchase has no retry authority', async t => {
  const h = audienceHarness(t); modelConfig(h);
  const { need } = await preparedNeed(h);
  const context = h.service.audience.reassessmentContext(need.id);
  const request = await h.command('audience.reassess', { need_id: need.id,
    expected_revision: context.need_revision,
    expected_basis_fingerprint: context.need_basis_fingerprint,
    expected_context_fingerprint: context.context_fingerprint });
  const canceled = h.service.audience.assessment(request.assessment_id);
  await h.command('audience.cancel_reassessment', { assessment_id: canceled.id,
    expected_basis_fingerprint: canceled.basis_fingerprint });
  const parent = h.service.audience.assessment(canceled.id);
  assert.equal(parent.status, 'interrupted');
  assert.equal(parent.run_id, null, 'canceled captured work never began a model purchase');
  await assert.rejects(h.command('audience.retry_reassessment', retryPayload(parent, context)),
    { code: 'AUDIENCE_RETRY_UNAVAILABLE' });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_assessments').n, 3,
    'there is no retry child without a corresponding failed model run');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 0);
});

test('priced failed-attempt receipt preserves its estimate instead of presenting unknown cost', async t => {
  fakeKey(t);
  const h = audienceHarness(t); modelConfig(h);
  const { need } = await preparedNeed(h);
  const { assessment: parent, run } = await makeFailedParent(h, need);
  assert.equal(run.cost_status, 'configured_estimate');
  const receipt = h.service.audience.assessment(parent.id).attempt_receipt;
  assert.ok(receipt);
  assert.notEqual(receipt.cost_status, 'unknown');
  assert.equal(receipt.estimated_cost_usd, run.estimated_cost_usd);
});

test('runtime-reported estimate provenance and amount survive in the attempt receipt', async t => {
  fakeKey(t);
  const h = audienceHarness(t); modelConfig(h, { knownCost: false });
  const { need } = await preparedNeed(h);
  const { assessment: parent, run } = await makeFailedParent(h, need, { usage: {
    input_tokens: 31, output_tokens: 17, cost_status: 'runtime_estimate', estimated_cost_usd: 0.0123,
  } });
  const receipt = h.service.audience.assessment(parent.id).attempt_receipt;
  assert.equal(run.cost_status, 'runtime_estimate');
  assert.equal(receipt.cost_status, 'runtime_estimate');
  assert.equal(receipt.estimated_cost_usd, 0.0123);
});

test('retry authority requires the failed run to freeze the exact failed assessment packet', async t => {
  fakeKey(t);
  const h = audienceHarness(t); modelConfig(h);
  const { need } = await preparedNeed(h);
  const { context, assessment: parent, run } = await makeFailedParent(h, need);
  const frozen = JSON.parse(run.context_json);
  frozen.packet.title = 'Mutated after the provider attempt';
  h.store.run('UPDATE runs SET context_json=? WHERE id=?', JSON.stringify(frozen), run.id);
  await assert.rejects(h.command('audience.retry_reassessment', retryPayload(parent, context)),
    { code: 'AUDIENCE_RECORD_INVALID' });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_assessments').n, 3,
    'a failed run with a mismatched frozen packet cannot authorize a child');
});

test('cancelling a retry child withholds late output and keeps actual usage', async t => {
  fakeKey(t);
  const h = audienceHarness(t); modelConfig(h);
  const { need } = await preparedNeed(h);
  const { context, assessment: parent } = await makeFailedParent(h, need);
  const child = await retryParent(h, parent, context);
  const before = h.service.audience.need(need.id);
  let calls = 0;
  const result = await processAudienceAssessment(h.service, { decide: async (_run, packetContext) => {
    calls++;
    await h.command('audience.cancel_reassessment', { assessment_id: child.id,
      expected_basis_fingerprint: child.basis_fingerprint });
    return { completed: true, final_response: JSON.stringify({ needs: [] }),
      usage: { input_tokens: 287, output_tokens: 99 },
      model_identity: { model_id: 'offline-fake', model_version: '1' } };
  } });
  assert.equal(calls, 1);
  assert.notEqual(result.disposition, 'no_revision_proposed');
  assert.equal(h.service.audience.assessment(child.id).status, 'interrupted');
  assert.equal(h.service.audience.need(need.id).revision, before.revision);
  const lateRun = runForAssessment(h, child.id);
  assert.equal(lateRun.status, 'failed');
  assert.equal(lateRun.input_tokens, 287);
  assert.equal(lateRun.output_tokens, 99);
  assert.equal(lateRun.cost_status, 'configured_estimate');
});

for (const mutation of ['edit', 'new_head', 'revoke']) test(`retry result is withheld after ${mutation.replace('_', ' ')} without losing usage`, async t => {
  fakeKey(t);
  const h = audienceHarness(t); modelConfig(h);
  const { need, sourceId, prefix } = await preparedNeed(h);
  const { context, assessment: parent } = await makeFailedParent(h, need);
  const child = await retryParent(h, parent, context);
  let calls = 0;
  const result = await processAudienceAssessment(h.service, { decide: async (_run, packetContext) => {
    calls++;
    if (mutation === 'edit') {
      await h.ingest({ source_id: sourceId, message_id: `${prefix}-root-1`, version: 2,
        text: 'The original setup question was corrected.' });
      h.service.audience.reconcile({ limit: 10 });
    } else if (mutation === 'new_head') {
      await addRoot(h, { sourceId, prefix, index: 3, text: 'A new question arrived after retry capture.' });
    } else {
      h.config.opportunity.allowedSourceRefs = [];
      h.service.audience.reconcile({ limit: 10 });
    }
    return { completed: true, final_response: JSON.stringify({ needs: [] }),
      usage: { input_tokens: 177, output_tokens: 38 },
      model_identity: { model_id: 'offline-fake', model_version: '1' } };
  } });
  assert.equal(calls, 1);
  assert.notEqual(result.disposition, 'no_revision_proposed');
  assert.notEqual(h.service.audience.assessment(child.id).status, 'proposed');
  const run = runForAssessment(h, child.id);
  assert.equal(run.input_tokens, 177);
  assert.equal(run.output_tokens, 38);
  if (mutation === 'new_head') assert.equal(h.service.audience.need(need.id).revision, need.revision);
  else assert.ok(h.service.audience.need(need.id).revision > need.revision,
    'canonical edit or source revocation updates the need state while withholding the result');
});

test('unknown USD and exhausted daily run budget block explicit retry without rewriting the old receipt', async t => {
  fakeKey(t);
  for (const mode of ['unknown_usd', 'run_budget']) {
    const h = audienceHarness(t); modelConfig(h, { knownCost: mode !== 'unknown_usd', maxRuns: 20 });
    const { need } = await preparedNeed(h);
    const { context, assessment: parent, run } = await makeFailedParent(h, need);
    if (mode === 'unknown_usd') {
      assert.equal(run.cost_status, 'unknown');
      assert.equal(run.estimated_cost_usd, null);
    } else {
      h.config.runtime.maxRunsPerDay = 1;
    }
    const receiptBefore = runForAssessment(h, parent.id);
    let blocked = false;
    try { await retryParent(h, parent, context); } catch { blocked = true; }
    assert.equal(blocked, true, `${mode}: an explicit request cannot create a child when configured budget admission fails`);
    assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_assessments').n, 3,
      `${mode}: rejected explicit request creates no child`);
    assert.deepEqual(runForAssessment(h, parent.id), receiptBefore,
      `${mode}: a blocked request cannot turn historical usage or unknown cost into zero`);
  }
});

test('budget exhaustion after child creation allows receipt acknowledgment but blocks model purchase', async t => {
  fakeKey(t);
  const h = audienceHarness(t); modelConfig(h);
  const { need } = await preparedNeed(h);
  const { context, assessment: parent, run } = await makeFailedParent(h, need);
  const payload = retryPayload(parent, context), requestId = 'retry-receipt-after-budget-exhaustion';
  const child = await h.command('audience.retry_reassessment', payload, requestId);
  assert.equal(h.service.audience.assessment(child.assessment_id).status, 'captured');
  h.config.runtime.maxRunsPerDay = 1;
  assert.deepEqual(await h.command('audience.retry_reassessment', payload, requestId), child,
    'a same-request receipt only acknowledges the existing child');
  let calls = 0;
  const attempt = await processAudienceAssessment(h.service, { decide: async () => {
    calls++; throw new Error('budget-blocked child must not reach the provider stub');
  } });
  assert.equal(calls, 0);
  assert.equal(attempt.disposition, 'CONTROL_RUN_BUDGET');
  assert.equal(h.service.audience.assessment(child.assessment_id).status, 'captured');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_assessments').n, 4);
  assert.equal(h.store.get('SELECT id FROM runs WHERE id=?', run.id).id, run.id,
    'rejected replay preserves the original failed usage receipt');
});

test('corrupt retry lineage is skipped so a healthy retry child behind it can run', async t => {
  fakeKey(t);
  const h = audienceHarness(t); modelConfig(h);
  const rows = [await preparedNeed(h, { sourceId: SOURCE, prefix: 'lineage-a' }),
    await preparedNeed(h, { sourceId: SOURCE_B, prefix: 'lineage-b' })]
    .sort((a, b) => a.goal.goal_id.localeCompare(b.goal.goal_id));
  const parents = [];
  for (const row of rows) {
    const failed = await makeFailedParent(h, row.need);
    parents.push({ ...failed, need: row.need });
  }
  const staleChild = await retryParent(h, parents[0].assessment, parents[0].context);
  const healthyChild = await retryParent(h, parents[1].assessment, parents[1].context);
  const tampered = structuredClone(staleChild.packet);
  tampered.reassessment.retry_of.assessment_id = 'forged-parent';
  const tamperedBasis = digest({ purpose: 'explicit_reassessment_retry_v1',
    context_fingerprint: tampered.reassessment.context_fingerprint,
    retry_of: tampered.reassessment.retry_of });
  tampered.basis_fingerprint = tamperedBasis;
  h.store.run('UPDATE audience_assessments SET packet_json=?,basis_fingerprint=? WHERE id=?',
    JSON.stringify(tampered), tamperedBasis, staleChild.id);
  h.store.run(`INSERT INTO channel_offsets VALUES(?,?,?) ON CONFLICT(channel,account_id)
    DO UPDATE SET cursor=excluded.cursor`, 'audience-reason-v1', h.config.partnerId, '');
  let calls = 0;
  const result = await processAudienceAssessment(h.service, { decide: async (_run, packetContext) => {
    calls++;
    assert.equal(packetContext.packet.reassessment.need_id, parents[1].need.id,
      'runtime only receives the healthy retry packet');
    return { completed: true, final_response: JSON.stringify({ needs: [] }),
      usage: { input_tokens: 80, output_tokens: 12 },
      model_identity: { model_id: 'offline-fake', model_version: '1' } };
  } });
  assert.equal(result.assessment_id, healthyChild.id);
  assert.equal(calls, 1);
  assert.notEqual(h.service.audience.assessment(staleChild.id).status, 'running');
  assert.equal(h.service.audience.assessment(healthyChild.id).status, 'proposed');
});

test('workspace transfer stales a captured retry child so import cannot resurrect it', async t => {
  fakeKey(t);
  const h = audienceHarness(t); modelConfig(h);
  const { need } = await preparedNeed(h);
  const { context, assessment: parent } = await makeFailedParent(h, need);
  const child = await retryParent(h, parent, context);
  assert.equal(child.status, 'captured');

  const bundle = exportPartner(h.store), source = path.join(h.directory, `audience-retry-transfer-${id()}.json`);
  const destination = path.join(ROOT, 'exports', `audience-retry-transfer-${id()}`);
  fs.writeFileSync(source, JSON.stringify(bundle), { flag: 'wx' });
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  const imported = spawnSync(process.execPath, ['scripts/import.mjs', source, destination],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.equal(imported.status, 0, imported.stderr);
  const store = new Store(path.join(destination, 'data'));
  try {
    const restored = store.get('SELECT * FROM audience_assessments WHERE id=?', child.id);
    assert.equal(restored.status, 'stale');
    let calls = 0;
    const { BusinessService } = await import('../business/service.mjs');
    const service = new BusinessService(store, h.config);
    try {
      const outcome = await processAudienceAssessment(service, { decide: async () => { calls++; throw new Error('transferred retry must not run'); } });
      assert.notEqual(outcome.assessment_id, child.id);
      assert.equal(calls, 0);
      assert.equal(service.audience.assessment(child.id).status, 'stale');
    } finally { service.control.close(); service.control.releaseProcess(); }
  } finally { store.close(); }
});
