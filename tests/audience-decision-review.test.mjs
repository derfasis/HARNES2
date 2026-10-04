// Black-box decision-review acceptance. All model responses are bounded local
// fixtures; no provider, network, or real credential is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../business/config.mjs';
import { exportPartner } from '../business/export.mjs';
import { Store, id } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { audienceHarness, SOURCE, SOURCE_B, proposalFrom } from './audience-test-helpers.mjs';
import { processAudienceAssessment } from '../business/audience-reasoning.mjs';
import { digest } from '../business/source-ingestion.mjs';

const RUNTIME = 'hermes-audience-v1';

function configure(h) {
  h.config.audience.modelEnabled = true;
  h.config.audience.maxRunsPerDay = 20;
  h.config.runtime.enabled = true;
  h.config.runtime.maxRunsPerDay = 50;
  h.config.runtime.baseUrl = 'https://unused-decision-review.invalid/v1';
  h.config.runtime.model = 'offline-fake-decision-review';
  h.config.runtime.dailyBudgetUsd = null;
  h.config.runtime.inputUsdPerMillion = null;
  h.config.runtime.outputUsdPerMillion = null;
  h.config.controlPlane.maxConcurrent = 3;
}

async function prepared(t, { twoExchanges = false } = {}) {
  const previousKey = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'offline-decision-review-sentinel-never-sent';
  t.after(() => { if (previousKey === undefined) delete process.env.PARTNER_MODEL_API_KEY; else process.env.PARTNER_MODEL_API_KEY = previousKey; });
  const h = audienceHarness(t); configure(h);
  const goal = await h.open({ source_ids: twoExchanges ? [SOURCE, SOURCE_B] : [SOURCE] });
  await h.ingest({ message_id: 'decision-root-a', source_id: SOURCE, text: 'How can I begin the setup?' });
  if (twoExchanges) await h.ingest({ message_id: 'decision-root-b', source_id: SOURCE_B, text: 'Where is the first setup step?' });
  h.service.audience.reconcile({ limit: 20 });
  const detail = h.service.audience.detail(goal.goal_id);
  assert.equal(detail.ready, true);
  const grant = await h.command('audience.attention_grant', {
    goal_id: goal.goal_id, expected_revision: detail.revision,
    expected_scope_fingerprint: detail.attention.scope_fingerprint,
    max_attempts: 1, expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    reason: 'Bounded offline decision-review acceptance.'
  });
  return { h, goal, grant };
}

function reviewFor(packet, overrides = {}) {
  return {
    version: 1, scope: 'supplied_packet_only', disposition: 'no_need_proposed',
    summary: 'The supplied exchanges do not support a distinct need proposal.',
    unknowns: ['This bounded packet does not establish what other audience members need.'],
    exchange_reviews: packet.exchanges.map(exchange => ({
      exchange_id: exchange.id, judgment: 'no_proposal',
      reason: 'The supplied text is a question, but it does not establish a separate actionable need.',
      evidence_event_ids: [exchange.evidence[0].source_event_id],
      support_quotes: [{ source_event_id: exchange.evidence[0].source_event_id, quote: exchange.evidence[0].text }]
    })),
    ...overrides
  };
}

function outputFor(packet, { needs = [], review = reviewFor(packet) } = {}) {
  return { needs, ...(review === null ? {} : { decision_review: review }) };
}

function fake(outputFactory, { before = async () => {} } = {}) {
  let calls = 0, beforeError = null;
  return { get calls() { return calls; }, get beforeError() { return beforeError; }, runtime: { decide: async (run, context) => {
    calls++;
    try { await before(context, run); } catch (error) { beforeError = error; throw error; }
    const output = typeof outputFactory === 'function' ? outputFactory(context.packet) : outputFactory;
    return { completed: true, final_response: JSON.stringify(output),
      usage: { input_tokens: 37, output_tokens: 19 },
      model_identity: { model_id: 'offline-fake', model_version: '1' } };
  } } };
}

async function run(h, model) { return processAudienceAssessment(h.service, model.runtime); }

test('honest empty result is inspectable, scoped, inert, and cannot rebill after restart', async t => {
  const { h } = await prepared(t);
  const model = fake(packet => outputFor(packet));
  const result = await run(h, model);
  assert.equal(result.disposition, 'no_need_proposed');
  assert.equal(model.calls, 1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_work_links').n, 0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs WHERE runtime=?', RUNTIME).n, 1);
  const assessment = h.service.audience.assessment(result.assessment_id);
  assert.deepEqual(assessment.decision_review, {
    state: 'current', review: reviewFor(assessment.packet),
    epistemic_status: 'unverified_model_interpretation', resolution: 'unknown', scope: 'supplied_packet_only'
  });
  const runRow = h.store.get('SELECT * FROM runs WHERE id=?', assessment.run_id);
  assert.equal(runRow.input_tokens, 37); assert.equal(runRow.output_tokens, 19);
  assert.equal(JSON.parse(runRow.result_json).output_fingerprint, digest(assessment.output));
  h.restart();
  const again = await run(h, model);
  assert.equal(model.calls, 1, 'a closed no-need result is not purchased again after process recovery');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs WHERE runtime=?', RUNTIME).n, 1);
  assert.notEqual(again.disposition, 'no_need_proposed');
});

test('valid needs and decision-review disposition agree and preserve proposal dependencies', async t => {
  const { h } = await prepared(t);
  const model = fake(packet => {
    const positiveReview = reviewFor(packet, { disposition: 'needs_proposed',
      summary: 'One direct question supports a bounded clarification proposal.',
      exchange_reviews: packet.exchanges.map(e => ({ ...reviewFor({ exchanges: [e] }).exchange_reviews[0], judgment: 'relevant',
        reason: 'A direct setup question supports the proposed clarification.' })) });
    return outputFor(packet, { needs: proposalFrom(packet).needs, review: positiveReview });
  });
  const result = await run(h, model);
  assert.equal(result.disposition, 'proposal_created');
  const assessment = h.service.audience.assessment(result.assessment_id);
  assert.equal(assessment.decision_review.state, 'current');
  assert.equal(assessment.decision_review.review.disposition, 'needs_proposed');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 1);
  assert.equal(assessment.decision_review.resolution, 'unknown');
});

const malformedReviewCases = [
  ['missing review', p => null],
  ['duplicate exchange', p => { const r = reviewFor(p); r.exchange_reviews.push(structuredClone(r.exchange_reviews[0])); return r; }],
  ['omitted exchange', p => { const r = reviewFor(p); r.exchange_reviews.pop(); return r; }, true],
  ['foreign exchange', p => { const r = reviewFor(p); r.exchange_reviews[0].exchange_id = 'exchange-from-another-packet'; return r; }],
  ['foreign event reference', p => { const r = reviewFor(p); r.exchange_reviews[0].evidence_event_ids = ['999999']; return r; }],
  ['omitted exchange citations', p => { const r = reviewFor(p); r.exchange_reviews[0].evidence_event_ids = []; r.exchange_reviews[0].support_quotes = []; return r; }],
  ['quote does not match cited source', p => { const r = reviewFor(p); r.exchange_reviews[0].support_quotes[0].quote = 'invented source text'; return r; }],
  ['disposition contradicts needs', p => { const r = reviewFor(p); r.disposition = 'needs_proposed'; return r; }],
  ['unsupported disposition', p => { const r = reviewFor(p); r.disposition = 'resolved'; return r; }]
];

for (const [label, mutate, twoExchanges = false] of malformedReviewCases) test(`model decision review rejects ${label}`, async t => {
  const { h } = await prepared(t, { twoExchanges });
  const model = fake(packet => outputFor(packet, { review: mutate(packet) }));
  const result = await run(h, model);
  assert.equal(model.calls, 1);
  assert.notEqual(result.disposition, 'no_need_proposed');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 0);
  const assessment = h.service.audience.assessment(result.assessment_id);
  assert.ok(['invalid', 'stale'].includes(assessment.decision_review?.state), 'invalid review is not exposed as a current judgment');
  assert.equal(h.store.get('SELECT status FROM audience_assessments WHERE id=?', result.assessment_id).status, 'invalid');
});

test('stale edit during inference withholds both no-need decision and dependent proposals but retains usage', async t => {
  const { h } = await prepared(t);
  let edit;
  const model = fake(packet => outputFor(packet), { before: async () => {
    edit = await h.ingest({ message_id: 'decision-root-a', version: 2, text: 'Actually, I need help choosing a plan.' });
    h.service.audience.reconcile({ limit: 20 });
  } });
  const result = await run(h, model);
  assert.equal(model.beforeError, null, 'the source mutation fixture completed before returning its model output');
  assert.ok(h.store.get('SELECT id FROM events WHERE id=?', edit.source_event_id), 'edited source event is durably recorded');
  assert.notEqual(result.disposition, 'no_need_proposed');
  const assessment = h.service.audience.assessment(result.assessment_id);
  assert.equal(assessment.current, false, 'the frozen assessment basis is stale after the source edit');
  assert.ok(['stale', 'interrupted'].includes(assessment.status), 'stale-basis or Control Plane withholding is terminal and non-applying');
  assert.equal(assessment.decision_review.state, 'stale', JSON.stringify({ result, status: assessment.status, current: assessment.current }));
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 0);
  const runRow = h.store.get('SELECT * FROM runs WHERE id=?', assessment.run_id);
  assert.equal(runRow.input_tokens, 37); assert.equal(runRow.output_tokens, 19);
});

test('delete during inference withholds the stale exchange decision and retains usage', async t => {
  const { h } = await prepared(t);
  let deletion;
  const model = fake(packet => outputFor(packet), { before: async () => {
    deletion = await h.ingest({ message_id: 'decision-root-a', version: 2, operation: 'delete', text: null });
    h.service.audience.reconcile({ limit: 20 });
  } });
  const result = await run(h, model);
  assert.equal(model.beforeError, null, 'delete and reconciliation must complete before the injected result returns');
  assert.ok(h.store.get('SELECT id FROM events WHERE id=?', deletion.source_event_id), 'delete source event is durably recorded');
  assert.notEqual(result.disposition, 'no_need_proposed');
  const assessment = h.service.audience.assessment(result.assessment_id);
  assert.equal(assessment.current, false, 'the frozen assessment basis is stale after source deletion');
  assert.ok(['stale', 'interrupted'].includes(assessment.status), 'stale-basis or Control Plane withholding is terminal and non-applying');
  assert.equal(assessment.decision_review.state, 'stale', JSON.stringify({ result, status: assessment.status, current: assessment.current }));
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 0);
  const runRow = h.store.get('SELECT * FROM runs WHERE id=?', assessment.run_id);
  assert.equal(runRow.input_tokens, 37); assert.equal(runRow.output_tokens, 19);
});

test('source withdrawal during inference cannot apply the returned interpretation', async t => {
  const { h } = await prepared(t);
  const model = fake(packet => outputFor(packet), { before: async () => {
    h.config.opportunity.allowedSourceRefs = [SOURCE_B];
    h.service.audience.detail(h.store.get('SELECT id FROM audience_goals').id);
    h.config.opportunity.allowedSourceRefs = [SOURCE, SOURCE_B];
  } });
  const result = await run(h, model);
  assert.equal(model.beforeError, null, 'source withdrawal fixture completed before returning its model output');
  assert.notEqual(result.disposition, 'no_need_proposed');
  const assessment = h.service.audience.assessment(result.assessment_id);
  assert.equal(assessment.current, false, 'withdrawn source watch makes the frozen assessment stale');
  assert.equal(assessment.status, 'stale');
  assert.equal(assessment.decision_review.state, 'stale');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 0);
});

test('deleting the frozen run decision-contract marker during inference cannot downgrade validation', async t => {
  const { h } = await prepared(t);
  let runId;
  const model = fake(packet => outputFor(packet), { before: async (_context, run) => {
    runId = run.id;
    const row = h.store.get('SELECT context_json FROM runs WHERE id=?', run.id);
    const context = JSON.parse(row.context_json); delete context.decision_contract_version;
    h.store.run('UPDATE runs SET context_json=? WHERE id=?', JSON.stringify(context), run.id);
  } });
  const result = await run(h, model);
  assert.equal(model.beforeError, null, 'run-contract mutation fixture completed before injected inference returned');
  assert.equal(model.calls, 1);
  assert.notEqual(result.disposition, 'no_need_proposed');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 0);
  const assessment = h.service.audience.assessment(result.assessment_id);
  assert.equal(assessment.status, 'invalid');
  assert.equal(assessment.decision_review.state, 'invalid');
  const closed = h.store.get('SELECT status,input_tokens,output_tokens FROM runs WHERE id=?', runId);
  assert.equal(closed.status, 'failed');
  assert.equal(closed.input_tokens, 37); assert.equal(closed.output_tokens, 19);
});

test('transferred completed decision stays historical and cannot restore live attention authority', async t => {
  const { h, goal } = await prepared(t);
  const result = await run(h, fake(packet => outputFor(packet)));
  const before = h.service.audience.assessment(result.assessment_id);
  assert.equal(before.decision_review.state, 'current');
  const bundle = exportPartner(h.store), file = path.join(h.directory, `decision-transfer-${id()}.json`);
  fs.writeFileSync(file, JSON.stringify(bundle), { flag: 'wx' });
  const destination = path.join(ROOT, 'exports', `decision-transfer-${id()}`);
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, ['scripts/import.mjs', file, destination],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  const restored = new Store(path.join(destination, 'data'));
  try {
    const service = new BusinessService(restored, h.config);
    const assessment = service.audience.assessment(result.assessment_id);
    assert.equal(assessment.status, 'stale');
    assert.equal(assessment.decision_review.state, 'stale');
    assert.deepEqual(assessment.decision_review.review, before.decision_review.review,
      'historical decision receipt survives transfer with its original interpretation');
    assert.equal(assessment.decision_review.resolution, 'unknown');
    assert.ok(restored.get('SELECT id FROM runs WHERE id=? AND status=\'completed\'', assessment.run_id),
      'historical run receipt and usage remain auditable');
    const grant = service.audience.detail(goal.goal_id).attention.grants[0];
    assert.equal(grant.status, 'revoked');
    assert.equal(service.attention.eligible(goal.goal_id), null, 'a historical decision cannot restore attention authority');
  } finally { restored.close(); }
});

test('persisted decision-review corruption is hidden as invalid without granting resolution', async t => {
  const { h } = await prepared(t);
  const result = await run(h, fake(packet => outputFor(packet)));
  const row = h.store.get('SELECT output_json FROM audience_assessments WHERE id=?', result.assessment_id);
  const saved = JSON.parse(row.output_json); saved.decision_review.exchange_reviews[0].evidence_event_ids[0] = '999999';
  h.store.run('UPDATE audience_assessments SET output_json=? WHERE id=?', JSON.stringify(saved), result.assessment_id);
  const runRow = h.store.get('SELECT id,result_json FROM runs WHERE id=(SELECT run_id FROM audience_assessments WHERE id=?)', result.assessment_id);
  const receipt = JSON.parse(runRow.result_json); receipt.output_fingerprint = digest(saved);
  h.store.run('UPDATE runs SET result_json=? WHERE id=?', JSON.stringify(receipt), runRow.id);
  const assessment = h.service.audience.assessment(result.assessment_id);
  assert.equal(assessment.decision_review.state, 'invalid');
  assert.equal(assessment.decision_review.review, null);
  assert.equal(assessment.decision_review.resolution, 'unknown');
});

test('completed decision review becomes stale after its source exchange changes, without claiming resolution', async t => {
  const { h } = await prepared(t);
  const result = await run(h, fake(packet => outputFor(packet)));
  const before = h.service.audience.assessment(result.assessment_id);
  await h.ingest({ message_id: 'decision-root-a', version: 2, text: 'A changed version of the question.' });
  h.service.audience.reconcile({ limit: 20 });
  const after = h.service.audience.assessment(result.assessment_id);
  assert.equal(after.decision_review.state, 'stale');
  assert.deepEqual(after.decision_review.review, before.decision_review.review,
    'historical model interpretation remains inspectable with a stale label');
  assert.equal(after.decision_review.resolution, 'unknown');
});

for (const corruption of ['review_removed', 'output_malformed']) test(`completed run with ${corruption} is invalid, not rationale-free history`, async t => {
  const { h } = await prepared(t);
  const result = await run(h, fake(packet => outputFor(packet)));
  if (corruption === 'review_removed') {
    const row = h.store.get('SELECT output_json FROM audience_assessments WHERE id=?', result.assessment_id);
    const output = JSON.parse(row.output_json); delete output.decision_review;
    h.store.run('UPDATE audience_assessments SET output_json=? WHERE id=?', JSON.stringify(output), result.assessment_id);
  } else {
    h.store.run("UPDATE audience_assessments SET output_json='{' WHERE id=?", result.assessment_id);
  }
  const assessment = h.service.audience.assessment(result.assessment_id);
  assert.equal(assessment.decision_review.state, 'invalid');
  assert.equal(assessment.decision_review.review, null);
});

test('closed run output fingerprint binds the complete saved model output', async t => {
  const { h } = await prepared(t);
  const result = await run(h, fake(packet => outputFor(packet)));
  const row = h.store.get('SELECT result_json FROM runs WHERE id=(SELECT run_id FROM audience_assessments WHERE id=?)', result.assessment_id);
  const receipt = JSON.parse(row.result_json); receipt.output_fingerprint = digest({ needs: [] });
  h.store.run('UPDATE runs SET result_json=? WHERE id=(SELECT run_id FROM audience_assessments WHERE id=?)',
    JSON.stringify(receipt), result.assessment_id);
  const assessment = h.service.audience.assessment(result.assessment_id);
  assert.equal(assessment.decision_review.state, 'invalid');
  assert.equal(assessment.decision_review.review, null);
});

test('corrupting the interpretation receipt does not rewrite an unrelated valid need basis', async t => {
  const { h } = await prepared(t);
  const model = fake(packet => {
    const review = reviewFor(packet, { disposition: 'needs_proposed', summary: 'A direct question supports one proposal.',
      exchange_reviews: packet.exchanges.map(e => ({ ...reviewFor({ exchanges: [e] }).exchange_reviews[0], judgment: 'relevant' })) });
    return outputFor(packet, { needs: proposalFrom(packet).needs, review });
  });
  const result = await run(h, model);
  const need = h.service.audience.need(h.store.get('SELECT id FROM audience_needs').id);
  const basis = need.basis_fingerprint;
  const row = h.store.get('SELECT output_json FROM audience_assessments WHERE id=?', result.assessment_id);
  const output = JSON.parse(row.output_json); output.decision_review.summary = 'tampered interpretation';
  h.store.run('UPDATE audience_assessments SET output_json=? WHERE id=?', JSON.stringify(output), result.assessment_id);
  assert.equal(h.service.audience.assessment(result.assessment_id).decision_review.state, 'invalid');
  const stillValidNeed = h.service.audience.need(need.id);
  assert.equal(stillValidNeed.basis_fingerprint, basis);
  assert.equal(stillValidNeed.current, true, 'review-only corruption cannot change proposal evidence dependencies');
});

test('historical manual empty output reports that rationale was not recorded', async t => {
  const h = audienceHarness(t); configure(h);
  const goal = await h.open({ source_ids: [SOURCE] });
  await h.ingest({ message_id: 'manual-empty-root', text: 'How can I begin the setup?' });
  h.service.audience.reconcile({ limit: 10 });
  const capture = await h.capture(goal.goal_id);
  await h.command('audience.propose', { assessment_id: capture.assessment_id, output: { needs: [] } });
  const assessment = h.service.audience.assessment(capture.assessment_id);
  assert.equal(assessment.decision_review.state, 'not_recorded');
  assert.equal(assessment.decision_review.review, null);
  assert.equal(assessment.decision_review.resolution, 'unknown');
});

test('focused model empty result is reviewable but does not revise or resolve its target', async t => {
  const previousKey = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'offline-decision-review-sentinel-never-sent';
  t.after(() => { if (previousKey === undefined) delete process.env.PARTNER_MODEL_API_KEY; else process.env.PARTNER_MODEL_API_KEY = previousKey; });
  const h = audienceHarness(t); configure(h);
  const goal = await h.open({ source_ids: [SOURCE] });
  await h.ingest({ message_id: 'focused-decision-root', text: 'How can I begin the setup?' });
  h.service.audience.reconcile({ limit: 10 });
  const capture = await h.capture(goal.goal_id);
  const packet = h.service.audience.assessment(capture.assessment_id).packet;
  const proposal = await h.command('audience.propose', { assessment_id: capture.assessment_id,
    output: proposalFrom(packet) });
  let need = h.service.audience.need(proposal.need_ids[0]);
  await h.command('audience.review', { need_id: need.id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint, decision: 'accept', note: 'Synthetic test setup.' });
  need = h.service.audience.need(need.id);
  await h.ingest({ message_id: 'focused-decision-root-2', text: 'Where is the first setup step?' });
  h.service.audience.reconcile({ limit: 10 });
  const context = h.service.audience.reassessmentContext(need.id);
  const requested = await h.command('audience.reassess', { need_id: need.id,
    expected_revision: context.need_revision, expected_basis_fingerprint: context.need_basis_fingerprint,
    expected_context_fingerprint: context.context_fingerprint });
  const focused = h.service.audience.assessment(requested.assessment_id);
  const result = await run(h, fake(modelPacket => outputFor(modelPacket)));
  assert.equal(result.assessment_id, focused.id);
  assert.equal(result.disposition, 'no_revision_proposed');
  const after = h.service.audience.assessment(focused.id);
  assert.equal(after.decision_review.state, 'current');
  assert.equal(after.decision_review.review.disposition, 'no_need_proposed');
  assert.equal(after.decision_review.resolution, 'unknown');
  assert.equal(h.service.audience.need(need.id).revision, need.revision);
});
