// Focused Situation Continuity runtime boundaries. All source messages and model
// responses are synthetic; runtime.decide is stubbed and never opens a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { processAudienceAssessment } from '../business/audience-reasoning.mjs';
import { audienceHarness, SOURCE, SOURCE_B, proposalFrom, modelOutputFrom } from './audience-test-helpers.mjs';

function runtimeConfig(h) {
  h.config.audience.modelEnabled = true;
  h.config.audience.maxRunsPerDay = 5;
  h.config.runtime.maxRunsPerDay = 20;
  h.config.runtime.baseUrl = 'https://unused-situation-test.invalid/v1';
  h.config.runtime.model = 'offline-fake-situation-runtime';
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

async function acceptedNeed(h, { sourceId = SOURCE, prefix = 'situation' } = {}) {
  const goal = await h.open({ source_ids: [sourceId] });
  await h.ingest({ message_id: `${prefix}-root-1`, source_id: sourceId, text: 'How can I begin the setup?' });
  h.service.audience.reconcile({ limit: 10 });
  const manual = await h.capture(goal.goal_id);
  const assessment = h.service.audience.assessment(manual.assessment_id);
  const proposed = await h.command('audience.propose', { assessment_id: assessment.id,
    output: proposalFrom(assessment.packet) });
  let need = h.service.audience.need(proposed.need_ids[0]);
  await h.command('audience.review', { need_id: need.id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint, decision: 'accept', note: 'Accepted as an unverified working need.' });
  need = h.service.audience.need(need.id);
  return { goal, need, sourceId, prefix };
}

async function addRoot(h, { sourceId = SOURCE, prefix = 'situation', index = 2, text = 'Where is the first setup step?' } = {}) {
  const result = await h.ingest({ message_id: `${prefix}-root-${index}`, source_id: sourceId, text });
  h.service.audience.reconcile({ limit: 10 });
  return result;
}

async function requestReassessment(h, need) {
  const context = h.service.audience.reassessmentContext(need.id);
  const result = await h.command('audience.reassess', { need_id: need.id,
    expected_revision: context.need_revision,
    expected_basis_fingerprint: context.need_basis_fingerprint,
    expected_context_fingerprint: context.context_fingerprint });
  return { context, assessment: h.service.audience.assessment(result.assessment_id) };
}

function refreshedOutput(packet, need) {
  const oldEventIds = new Set([...need.evidence_event_ids, ...need.counterevidence_event_ids,
    ...(need.context_event_ids ?? [])]);
  const prior = packet.exchanges.find(e => e.evidence.some(x => oldEventIds.has(x.source_event_id)));
  const fresh = packet.exchanges.find(e => e.id !== prior?.id);
  assert.ok(prior && fresh, 'focused packet freezes prior and current source exchanges');
  const oldEvidence = prior.evidence[0], newEvidence = fresh.evidence[0];
  return proposalFrom(packet, { need_id: need.id, title: 'Clarify the first setup step',
    hypothesis: 'The original setup need may remain open, and a newer question asks where to begin.',
    why_now: 'A current source exchange revisits the setup question.',
    exchange_ids: [prior.id, fresh.id], evidence_event_ids: [oldEvidence.source_event_id, newEvidence.source_event_id],
    support_quotes: [{ source_event_id: oldEvidence.source_event_id, quote: oldEvidence.text },
      { source_event_id: newEvidence.source_event_id, quote: newEvidence.text }],
    reason: 'Both source exchanges support this proposed continuity.' });
}

function validResult(context, need, extra = {}) {
  return { completed: true, final_response: JSON.stringify(modelOutputFrom(context.packet,refreshedOutput(context.packet, need))),
    usage: { input_tokens: 211, output_tokens: 73 },
  model_identity: { model_id: 'offline-fake', model_version: '1' }, ...extra };
}

function runForAssessment(h, assessmentId) {
  return h.store.get("SELECT * FROM runs WHERE context_json->>'$.assessment_id'=?", assessmentId);
}

test('an explicitly captured focused reassessment runs once, resumes after restart, and is not repurchased', async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  const { need } = await acceptedNeed(h);
  await addRoot(h);
  const { assessment } = await requestReassessment(h, need);
  assert.equal(assessment.status, 'captured');
  h.restart();

  let calls = 0;
  const runtime = { decide: async (_run, context) => { calls++; return validResult(context, need); } };
  const first = await processAudienceAssessment(h.service, runtime);
  assert.equal(first.disposition, 'proposal_created');
  assert.equal(first.assessment_id, assessment.id);
  assert.equal(calls, 1);
  assert.equal(h.service.audience.assessment(assessment.id).status, 'proposed');
  assert.equal(h.service.audience.need(need.id).revision, need.revision + 1);
  const again = await processAudienceAssessment(h.service, runtime);
  assert.notEqual(again.disposition, 'proposal_created');
  assert.equal(calls, 1, 'a completed request cannot silently buy another assessment');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 1);
});

test('a process-recovered interrupted focused run is terminal and cannot be retried automatically', async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  const { need } = await acceptedNeed(h);
  await addRoot(h);
  const { assessment } = await requestReassessment(h, need);
  const runId = '00000000-0000-4000-8000-000000000091';
  h.store.run(`INSERT INTO runs(id,partner_id,status,runtime,model,context_json,created_at)
    VALUES(?,?,'running','hermes-audience-v1',?,?,?)`, runId, h.config.partnerId,
    h.config.runtime.model, JSON.stringify({ assessment_id: assessment.id, model_config: h.config.runtime }), new Date().toISOString());
  h.store.run("UPDATE audience_assessments SET status='running',producer='model',run_id=? WHERE id=?", runId, assessment.id);
  h.restart();
  assert.equal(h.service.audience.assessment(assessment.id).status, 'interrupted');
  let calls = 0;
  const next = await processAudienceAssessment(h.service, { decide: async () => { calls++; throw new Error('must not retry'); } });
  assert.notEqual(next.assessment_id, assessment.id);
  assert.equal(calls, 0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 1);
  assert.equal(h.store.get('SELECT status FROM runs WHERE id=?', runId).status, 'interrupted');
});

test('cancellation during a focused model call withholds late output and retains usage', async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  const { need } = await acceptedNeed(h);
  await addRoot(h);
  const { assessment } = await requestReassessment(h, need);
  const before = h.service.audience.need(need.id);
  let calls = 0;
  const result = await processAudienceAssessment(h.service, { decide: async (_run, context) => {
    calls++;
    await h.command('audience.cancel_reassessment', { assessment_id: assessment.id,
      expected_basis_fingerprint: assessment.basis_fingerprint });
    return validResult(context, need);
  } });
  assert.equal(calls, 1);
  assert.equal(result.disposition, 'interrupted');
  assert.equal(h.service.audience.assessment(assessment.id).status, 'interrupted');
  assert.equal(h.service.audience.need(need.id).revision, before.revision);
  const run = runForAssessment(h, assessment.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.input_tokens, 211);
  assert.equal(run.output_tokens, 73);
  assert.equal(run.cost_status, 'unknown');
});

for (const change of ['new_root', 'need_revision']) test(`a ${change.replace('_', ' ')} during model work blocks the frozen focused snapshot`, async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  const { need, sourceId, prefix } = await acceptedNeed(h);
  await addRoot(h, { sourceId, prefix });
  const { assessment } = await requestReassessment(h, need);
  let calls = 0;
  const result = await processAudienceAssessment(h.service, { decide: async (_run, context) => {
    calls++;
    if (change === 'new_root') {
      await addRoot(h, { sourceId, prefix, index: 3, text: 'A separate new question after capture.' });
    } else {
      await h.ingest({ message_id: `${prefix}-root-1`, source_id: sourceId, version: 2,
        text: 'The original question has been corrected.' });
      h.service.audience.reconcile({ limit: 10 });
      const stale = h.service.audience.need(need.id);
      await h.command('audience.review', { need_id: need.id, expected_revision: stale.revision,
        expected_basis_fingerprint: stale.basis_fingerprint, decision: 'reject', note: 'Updated review during model work.' });
    }
    return validResult(context, need);
  } });
  assert.equal(calls, 1);
  assert.notEqual(result.disposition, 'proposal_created');
  assert.equal(h.service.audience.need(need.id).revision > need.revision, change === 'need_revision');
  assert.equal(runForAssessment(h, assessment.id).input_tokens, 211,
    'usage is retained when snapshot validation blocks the proposal');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 1);
});

test('a stale focused request does not starve a healthy goal request', async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  const rows = [await acceptedNeed(h, { sourceId: SOURCE, prefix: 'goal-a' }),
    await acceptedNeed(h, { sourceId: SOURCE_B, prefix: 'goal-b' })].sort((a, b) => a.goal.goal_id.localeCompare(b.goal.goal_id));
  const [staleNeed, healthyNeed] = rows;
  await addRoot(h, { sourceId: staleNeed.sourceId, prefix: staleNeed.prefix });
  await addRoot(h, { sourceId: healthyNeed.sourceId, prefix: healthyNeed.prefix });
  const stale = await requestReassessment(h, staleNeed.need);
  const healthy = await requestReassessment(h, healthyNeed.need);
  // Start immediately before the stale goal so this pass must inspect and skip it
  // before moving on to the healthy neighbor.
  h.store.run(`INSERT INTO channel_offsets VALUES(?,?,?) ON CONFLICT(channel,account_id)
    DO UPDATE SET cursor=excluded.cursor`, 'audience-reason-v1', h.config.partnerId, '');
  await h.ingest({ source_id: staleNeed.sourceId, message_id: `${staleNeed.prefix}-root-3`,
    text: 'Changed after the focused request.' });
  let calls = 0;
  const runtime = { decide: async (_run, context) => {
    calls++;
    if (context.packet.reassessment?.need_id === healthyNeed.need.id) {
      return validResult(context, healthyNeed.need);
    }
    assert.fail('the stale focused snapshot must be skipped before model invocation');
  } };
  const result = await processAudienceAssessment(h.service, runtime);
  assert.equal(result.disposition, 'proposal_created');
  assert.equal(result.assessment_id, healthy.assessment.id);
  assert.equal(calls, 1);
  assert.equal(h.service.audience.assessment(stale.assessment.id).status, 'stale');
  assert.equal(h.service.audience.assessment(stale.assessment.id).status, 'stale');
});

test('ordinary manual captures are never implicit runtime work', async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  const { goal } = await acceptedNeed(h);
  await addRoot(h, { index: 2, text: 'A separate root remains ordinary discovery.' });
  const manual = await h.capture(goal.goal_id);
  assert.equal(h.service.audience.assessment(manual.assessment_id).packet.reassessment, undefined);
  let calls = 0;
  const next = await processAudienceAssessment(h.service, { decide: async () => { calls++; throw new Error('manual packet must not run'); } });
  assert.notEqual(next.assessment_id, manual.assessment_id);
  assert.equal(calls, 0);
});

test('empty focused result completes with no_revision_proposed and leaves the target unchanged', async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  const { need } = await acceptedNeed(h);
  await addRoot(h);
  const { assessment } = await requestReassessment(h, need);
  const result = await processAudienceAssessment(h.service, { decide: async (_run, context) => ({ completed: true,
    final_response: JSON.stringify(modelOutputFrom(context.packet,{ needs: [] })), usage: { input_tokens: 101, output_tokens: 14 },
    model_identity: { model_id: 'offline-fake', model_version: '1' } }) });
  assert.equal(result.disposition, 'no_revision_proposed');
  assert.equal(h.service.audience.need(need.id).revision, need.revision);
  assert.equal(h.service.audience.need(need.id).status, 'accepted');
  assert.equal(h.service.audience.assessment(assessment.id).status, 'proposed');
  const run = runForAssessment(h, assessment.id);
  assert.equal(run.status, 'completed');
  assert.equal(JSON.parse(run.result_json).disposition, 'no_revision_proposed');
  assert.equal(run.input_tokens, 101);
  assert.equal(run.output_tokens, 14);
});

test('new goal evidence after capture is rejected before model invocation', async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  const { need, sourceId, prefix } = await acceptedNeed(h);
  await addRoot(h, { sourceId, prefix });
  const { assessment } = await requestReassessment(h, need);
  await h.ingest({ source_id: sourceId, message_id: `${prefix}-root-3`,
    text: 'This root arrived after the frozen request.' });
  let calls = 0;
  const result = await processAudienceAssessment(h.service, { decide: async () => { calls++; throw new Error('stale snapshot must not run'); } });
  assert.notEqual(result.assessment_id, assessment.id);
  assert.equal(calls, 0);
  assert.equal(h.service.audience.assessment(assessment.id).status, 'stale');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 0);
});

test('malformed focused request markers fail closed before model invocation', async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  const { need } = await acceptedNeed(h);
  await addRoot(h);
  const { assessment } = await requestReassessment(h, need);
  const stored = h.store.get('SELECT packet_json FROM audience_assessments WHERE id=?', assessment.id);
  const packet = JSON.parse(stored.packet_json);
  packet.reassessment.model_requested = false;
  h.store.run('UPDATE audience_assessments SET packet_json=? WHERE id=?', JSON.stringify(packet), assessment.id);
  let calls = 0;
  await processAudienceAssessment(h.service, { decide: async () => { calls++; throw new Error('invalid marker must not run'); } });
  assert.equal(calls, 0);
  assert.equal(h.service.audience.assessment(assessment.id).status, 'stale');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 0);
});

test('revoked focused source scope is withheld before model invocation', async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  const { need } = await acceptedNeed(h);
  await addRoot(h);
  const { assessment } = await requestReassessment(h, need);
  h.config.opportunity.allowedSourceRefs = [];
  let calls = 0;
  await processAudienceAssessment(h.service, { decide: async () => { calls++; throw new Error('revoked source must not run'); } });
  assert.equal(calls, 0);
  assert.equal(h.service.audience.assessment(assessment.id).status, 'stale');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 0);
});

test('focused sampling includes ordinary-consumed roots since the need assessment without consuming discovery state', async t => {
  fakeKey(t);
  const h = audienceHarness(t); runtimeConfig(h);
  const { goal, need } = await acceptedNeed(h, { prefix: 'sampling' });

  // A normal assessment observes the next root and an empty proposal consumes it
  // for ordinary discovery without resolving or revising the accepted need.
  await addRoot(h, { prefix: 'sampling', index: 2,
    text: 'Where can I find the initial setup instructions?' });
  const ordinary = await h.capture(goal.goal_id);
  await h.command('audience.propose', { assessment_id: ordinary.assessment_id, output: { needs: [] } });
  assert.equal(h.service.audience.need(need.id).revision, need.revision);
  const consumed = h.store.get(`SELECT * FROM audience_exchanges WHERE goal_id=?
    AND EXISTS(SELECT 1 FROM json_each(member_ids_json) WHERE value=?)`, goal.goal_id, 'sampling-root-2');
  assert.ok(consumed);
  assert.equal(consumed.considered_fingerprint, consumed.fingerprint);

  const laterRoot = await addRoot(h, { prefix: 'sampling', index: 3,
    text: 'Could someone point me to the first setup step?' });
  const context = h.service.audience.reassessmentContext(need.id);
  assert.equal(context.current, true);
  assert.ok(context.prior_exchange_ids.some(id => need.exchange_ids.includes(id)));
  assert.ok(context.new_exchange_ids.includes(consumed.id),
    'focused comparison includes this canonical root even though ordinary discovery already consumed it');
  assert.ok(context.new_exchange_ids.some(id => context.exchanges.find(e => e.id === id)
    ?.evidence.some(item => item.source_event_id === laterRoot.source_event_id)));
  assert.ok(context.exchanges.find(e => e.id === consumed.id)?.current);
  assert.equal(context.exchanges.find(e => e.id === consumed.id)?.considered, true);

  const discoveryCursor = h.store.get("SELECT cursor FROM channel_offsets WHERE channel='audience-packet-source-v1' AND account_id=?",
    goal.goal_id)?.cursor ?? null;
  const { assessment } = await requestReassessment(h, need);
  const result = await processAudienceAssessment(h.service, { decide: async (_run, packetContext) =>
    validResult(packetContext, need) });
  assert.equal(result.disposition, 'proposal_created');
  assert.equal(h.store.get("SELECT cursor FROM channel_offsets WHERE channel='audience-packet-source-v1' AND account_id=?",
    goal.goal_id)?.cursor ?? null, discoveryCursor, 'focused work leaves the ordinary discovery cursor unchanged');
  const consumedAfter = h.store.get('SELECT considered_fingerprint,fingerprint FROM audience_exchanges WHERE id=?', consumed.id);
  const later = h.store.get(`SELECT e.considered_fingerprint,e.fingerprint FROM audience_exchanges e
    WHERE e.goal_id=? AND EXISTS(SELECT 1 FROM json_each(e.member_ids_json) WHERE value=?)`, goal.goal_id, 'sampling-root-3');
  assert.equal(consumedAfter.considered_fingerprint, consumedAfter.fingerprint);
  assert.ok(later);
  assert.notEqual(later.considered_fingerprint, later.fingerprint,
    'focused request and proposal leave the later root available to ordinary discovery');
  assert.equal(h.service.audience.assessment(assessment.id).status, 'proposed');
});
