// Situation Continuity acceptance: operator-scoped reassessment over canonical
// source evidence. Synthetic fixtures only; no model or network is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { audienceHarness, SOURCE, proposalFrom } from './audience-test-helpers.mjs';

async function acceptedNeed(h, question = 'How do I get started with the programme?') {
  const goal = await h.open();
  const source = await h.ingest({ message_id: 'day-1-root', text: question });
  h.service.audience.reconcile({ limit: 10 });
  const captured = await h.capture(goal.goal_id);
  const assessment = h.service.audience.assessment(captured.assessment_id);
  const proposed = await h.command('audience.propose', {
    assessment_id: assessment.id, output: proposalFrom(assessment.packet),
  });
  let need = h.service.audience.need(proposed.need_ids[0]);
  await h.command('audience.review', { need_id: need.id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint, decision: 'accept', note: 'Accepted for continuity.' });
  need = h.service.audience.need(need.id);
  return { goal, source, need };
}

async function acceptedNeedOnOtherSource(h) {
  const goal = await h.open({ source_ids: ['public:audience-fixture-b'] });
  await h.ingest({ source_id: 'public:audience-fixture-b', message_id: 'other-goal-root',
    text: 'How do I find the volunteer schedule?' });
  h.service.audience.reconcile({ limit: 10 });
  const captured = await h.capture(goal.goal_id), assessment = h.service.audience.assessment(captured.assessment_id);
  const proposed = await h.command('audience.propose', { assessment_id: assessment.id,
    output: proposalFrom(assessment.packet) });
  let need = h.service.audience.need(proposed.need_ids[0]);
  await h.command('audience.review', { need_id: need.id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint, decision: 'accept', note: 'Accepted separate fixture need.' });
  return h.service.audience.need(need.id);
}

async function addDayTwo(h, texts = ['Where is the first setup step?']) {
  const ingested = [];
  for (let i = 0; i < texts.length; i++) ingested.push(await h.ingest({
    message_id: `day-2-root-${i + 1}`, text: texts[i],
  }));
  h.service.audience.reconcile({ limit: 10 });
  return ingested;
}

function requestPayload(need, context) {
  return { need_id: need.id, expected_revision: need.revision,
    expected_basis_fingerprint: context.need_basis_fingerprint,
    expected_context_fingerprint: context.context_fingerprint };
}

function revisedOutput(packet, needId, context) {
  const old = packet.exchanges.find(e => context.prior_exchange_ids.includes(e.id));
  const fresh = packet.exchanges.find(e => context.new_exchange_ids.includes(e.id));
  assert.ok(old && fresh, 'reassessment packet contains selected history and new evidence');
  const oldEvidence = old.evidence[0], freshEvidence = fresh.evidence[0];
  return proposalFrom(packet, {
    need_id: needId,
    title: 'Clarify the first setup step',
    hypothesis: 'The original setup question remains open, and the newer question asks where to begin.',
    why_now: 'A newer source exchange revisits the same setup need.',
    exchange_ids: [old.id, fresh.id],
    evidence_event_ids: [oldEvidence.source_event_id, freshEvidence.source_event_id],
    support_quotes: [
      { source_event_id: oldEvidence.source_event_id, quote: oldEvidence.text },
      { source_event_id: freshEvidence.source_event_id, quote: freshEvidence.text },
    ],
    reason: 'The proposed continuity is supported by both quoted source exchanges.',
  });
}

async function reassess(h, need) {
  const context = h.service.audience.reassessmentContext(need.id);
  const requested = await h.command('audience.reassess', requestPayload(need, context));
  return { context, assessment: h.service.audience.assessment(requested.assessment_id) };
}

test('reassessment packet joins canonical prior and new roots without consuming ordinary discovery', async t => {
  const h = audienceHarness(t), { need } = await acceptedNeed(h);
  await addDayTwo(h);
  assert.equal(h.config.audience.modelEnabled, false, 'context can be inspected with model reasoning disabled');

  const context = h.service.audience.reassessmentContext(need.id);
  assert.equal(context.available, true);
  assert.equal(context.need_id, need.id);
  assert.equal(context.need_revision, need.revision);
  assert.equal(context.need_basis_fingerprint, need.basis_fingerprint);
  assert.equal(context.current, true);
  assert.deepEqual(context.reasons, []);
  assert.ok(context.prior_exchange_ids.length >= 1);
  assert.ok(context.new_exchange_ids.length >= 1);
  assert.equal(context.model_enabled, false);
  assert.equal(context.executable, false);
  assert.equal(context.contact_permission, false);
  assert.deepEqual(context.allowed_effects, []);

  const ordinaryBefore = h.service.audience.detail(need.goal_id).exchanges;
  const freshOrdinary = ordinaryBefore.filter(e => context.new_exchange_ids.includes(e.id));
  assert.ok(freshOrdinary.length > 0);
  assert.ok(freshOrdinary.some(e => !e.considered), 'new roots remain in ordinary discovery before reassessment');
  const offsetBefore = h.store.get("SELECT cursor FROM channel_offsets WHERE channel='audience-packet-source-v1' AND account_id=?", need.goal_id)?.cursor ?? null;

  h.config.audience.modelEnabled = true;
  const result = await h.command('audience.reassess', requestPayload(need, context));
  const packet = h.service.audience.assessment(result.assessment_id).packet;
  assert.equal(packet.reassessment.version, 1);
  assert.equal(packet.reassessment.model_requested, true);
  assert.equal(packet.reassessment.need_id, need.id);
  assert.equal(packet.reassessment.need_revision, need.revision);
  assert.equal(packet.reassessment.need_basis_fingerprint, need.basis_fingerprint);
  assert.equal(packet.reassessment.context_fingerprint, context.context_fingerprint);
  assert.deepEqual(packet.reassessment.observation_heads, context.observation_heads);
  assert.ok(packet.exchanges.length <= 8);
  assert.equal(new Set(packet.exchanges.map(e => e.id)).size, packet.exchanges.length);
  assert.ok(context.prior_exchange_ids.every(id => packet.exchanges.some(e => e.id === id)));
  assert.ok(context.new_exchange_ids.every(id => packet.exchanges.some(e => e.id === id)));

  const revised = revisedOutput(packet, need.id, context);
  const receipt = await h.command('audience.propose', { assessment_id: result.assessment_id, output: revised });
  assert.deepEqual(receipt.need_ids, [need.id]);
  const latest = h.service.audience.need(need.id);
  assert.equal(latest.revision, need.revision + 1);
  assert.ok(latest.evidence_event_ids.includes(need.evidence_event_ids[0]));
  assert.ok(latest.evidence_event_ids.some(ref => !need.evidence_event_ids.includes(ref)));

  const ordinaryAfter = h.service.audience.detail(need.goal_id).exchanges;
  assert.ok(ordinaryAfter.some(e => context.new_exchange_ids.includes(e.id) && !e.considered),
    'reassessment does not mark new exchanges considered by ordinary discovery');
  assert.equal(h.store.get("SELECT cursor FROM channel_offsets WHERE channel='audience-packet-source-v1' AND account_id=?", need.goal_id)?.cursor ?? null,
    offsetBefore, 'reassessment does not advance the ordinary packet cursor');
  assert.equal(h.config.audience.modelEnabled, true, 'test request gate does not alter helper production defaults');
  assert.equal(h.config.runtime.enabled, false);
  assert.equal(h.config.telegram.liveSending, false);
});

test('an empty reassessment leaves the target revision and unrelated new roots discoverable', async t => {
  const h = audienceHarness(t), { need } = await acceptedNeed(h);
  const unrelated = await addDayTwo(h, ['A separate question about event parking.']);
  h.config.audience.modelEnabled = true;
  const { context, assessment } = await reassess(h, need);
  assert.equal(context.hypothesis_memory.resolution, 'unknown');
  await h.command('audience.propose', { assessment_id: assessment.id, output: { needs: [] } });

  const after = h.service.audience.need(need.id);
  assert.equal(after.revision, need.revision);
  assert.equal(after.status, 'accepted');
  assert.equal(h.service.audience.assessment(assessment.id).output.needs.length, 0);
  const detail = h.service.audience.detail(need.goal_id);
  assert.ok(detail.exchanges.some(e => e.evidence.some(x => unrelated.some(s => s.source_event_id === x.source_event_id)) && !e.considered),
    'empty target output does not consume unrelated roots from ordinary discovery');
});

test('a target revision change after request rejects the late reassessment result', async t => {
  const h = audienceHarness(t), { need } = await acceptedNeed(h);
  await addDayTwo(h);
  h.config.audience.modelEnabled = true;
  const { context, assessment } = await reassess(h, need);
  await h.ingest({ message_id: 'day-1-root', version: 2, text: 'I found the answer to my original setup question.' });
  h.service.audience.reconcile({ limit: 10 });
  const changed = h.service.audience.need(need.id);
  assert.ok(changed.revision > need.revision, 'canonical source change advances the target need revision');
  assert.equal(changed.status, 'stale');
  await assert.rejects(h.command('audience.propose', { assessment_id: assessment.id,
    output: revisedOutput(assessment.packet, need.id, context) }));
});

test('editing historical evidence blocks a pending result until reconciliation refreshes the canonical exchange', async t => {
  const h = audienceHarness(t), { need } = await acceptedNeed(h);
  await addDayTwo(h);
  h.config.audience.modelEnabled = true;
  const { context, assessment } = await reassess(h, need);
  await h.ingest({ message_id: 'day-1-root', version: 2, text: 'The original setup issue has been clarified.' });
  await assert.rejects(h.command('audience.propose', { assessment_id: assessment.id,
    output: revisedOutput(assessment.packet, need.id, context) }),
  { code: 'AUDIENCE_STALE_BASIS' });

  h.service.audience.reconcile({ limit: 10 });
  const refreshed = h.service.audience.reassessmentContext(need.id);
  assert.equal(refreshed.current, true);
  assert.ok(refreshed.new_exchange_ids.length > 0);
});

for (const invalidation of ['delete', 'revoke']) test(`source ${invalidation} prevents reassessment`, async t => {
  const h = audienceHarness(t), { need } = await acceptedNeed(h);
  await addDayTwo(h);
  h.config.audience.modelEnabled = true;
  const { context, assessment } = await reassess(h, need);
  if (invalidation === 'delete') {
    await h.ingest({ message_id: 'day-2-root-1', version: 2, operation: 'delete', text: null });
  } else {
    h.config.opportunity.allowedSourceRefs = [];
    h.service.audience.reconcile({ limit: 10 });
    h.config.opportunity.allowedSourceRefs = [SOURCE];
  }
  await assert.rejects(h.command('audience.propose', { assessment_id: assessment.id,
    output: revisedOutput(assessment.packet, need.id, context) }), error =>
    ['AUDIENCE_STALE_BASIS', 'AUDIENCE_ASSESSMENT_UNAVAILABLE'].includes(error.code));
  const unavailable = h.service.audience.reassessmentContext(need.id);
  assert.equal(unavailable.current, false);
});

test('reassessment cannot create a new need or revise another need', async t => {
  const h = audienceHarness(t), { need } = await acceptedNeed(h);
  await addDayTwo(h);
  const otherNeed = await acceptedNeedOnOtherSource(h);
  h.config.audience.modelEnabled = true;
  const { context, assessment } = await reassess(h, need);
  const newNeed = revisedOutput(assessment.packet, null, context);
  const crossNeed = revisedOutput(assessment.packet, otherNeed.id, context);
  await assert.rejects(h.command('audience.propose', { assessment_id: assessment.id, output: newNeed }),
    { code: 'AUDIENCE_REASSESSMENT_SCOPE' });
  await assert.rejects(h.command('audience.propose', { assessment_id: assessment.id, output: crossNeed }),
    { code: 'AUDIENCE_REASSESSMENT_SCOPE' });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 2,
    'scope refusals leave both existing needs untouched and create no third need');
});

test('a completed receipt cannot be replayed after owner review', async t => {
  const h = audienceHarness(t), { need } = await acceptedNeed(h);
  await addDayTwo(h);
  h.config.audience.modelEnabled = true;
  const { context, assessment } = await reassess(h, need);
  const output = revisedOutput(assessment.packet, need.id, context);
  await h.command('audience.propose', { assessment_id: assessment.id, output });
  let revised = h.service.audience.need(need.id);
  await h.command('audience.review', { need_id: revised.id, expected_revision: revised.revision,
    expected_basis_fingerprint: revised.basis_fingerprint, decision: 'accept', note: 'Reviewed the revised need.' });
  revised = h.service.audience.need(need.id);
  assert.equal(revised.status, 'accepted');
  await assert.rejects(h.command('audience.propose', { assessment_id: assessment.id, output }),
    { code: 'AUDIENCE_ASSESSMENT_UNAVAILABLE' });
  assert.equal(h.service.audience.need(need.id).revision, revised.revision);
});

test('a completed receipt cannot be replayed after its source authority is revoked', async t => {
  const h = audienceHarness(t), { need } = await acceptedNeed(h);
  await addDayTwo(h);
  h.config.audience.modelEnabled = true;
  const { context, assessment } = await reassess(h, need);
  const output = revisedOutput(assessment.packet, need.id, context);
  await h.command('audience.propose', { assessment_id: assessment.id, output });
  h.config.opportunity.allowedSourceRefs = [];
  h.service.audience.reconcile({ limit: 10 });
  await assert.rejects(h.command('audience.propose', { assessment_id: assessment.id, output }),
    { code: 'AUDIENCE_ASSESSMENT_UNAVAILABLE' });
  assert.equal(h.service.audience.need(need.id).current, false);
});

test('eight historical exchanges fill the frozen focus scope and report omitted new roots', async t => {
  const h = audienceHarness(t), goal = await h.open();
  for (let i = 0; i < 8; i++) await h.ingest({ message_id: `day-1-root-${i + 1}`,
    text: `I need help with setup step ${i + 1}.` });
  h.service.audience.reconcile({ limit: 10 });
  const captured = await h.capture(goal.goal_id), assessment = h.service.audience.assessment(captured.assessment_id);
  const packet = assessment.packet;
  assert.equal(packet.exchanges.length, 8);
  const evidence = packet.exchanges.map(e => e.evidence[0]);
  const output = proposalFrom(packet, { title: 'Help with the setup sequence',
    exchange_ids: packet.exchanges.map(e => e.id), evidence_event_ids: evidence.map(e => e.source_event_id),
    support_quotes: evidence.map(e => ({ source_event_id: e.source_event_id, quote: e.text })) });
  const proposed = await h.command('audience.propose', { assessment_id: assessment.id, output });
  let need = h.service.audience.need(proposed.need_ids[0]);
  await h.command('audience.review', { need_id: need.id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint, decision: 'accept', note: 'Accepted bounded eight-root history.' });
  need = h.service.audience.need(need.id);
  await addDayTwo(h, ['A ninth source root remains outside the eight-exchange historical scope.']);
  const context = h.service.audience.reassessmentContext(need.id);
  assert.equal(context.prior_exchange_ids.length, 8);
  assert.equal(context.new_exchange_ids.length, 0);
  assert.equal(context.available, false);
  assert.ok(context.reasons.includes('AUDIENCE_CONTEXT_CAPACITY'));
  assert.equal(context.coverage.omitted_sample_exchanges, 1);
  assert.equal(context.coverage.resolution, 'unknown');
});

test('reassessment request requires model reasoning and Control Plane but context stays readable', async t => {
  const h = audienceHarness(t), { need } = await acceptedNeed(h);
  await addDayTwo(h);
  const context = h.service.audience.reassessmentContext(need.id);
  assert.equal(context.available, true);
  assert.equal(context.model_enabled, false);
  await assert.rejects(h.command('audience.reassess', requestPayload(need, context)), { code: 'AUDIENCE_MODEL_DISABLED' });
  h.config.audience.modelEnabled = true;
  h.config.controlPlane.enabled = false;
  await assert.rejects(h.command('audience.reassess', requestPayload(need, context)), { code: 'AUDIENCE_CONTROL_REQUIRED' });
});

test('historical need interpretation stays labeled unverified and is not source evidence', async t => {
  const h = audienceHarness(t), { need } = await acceptedNeed(h, 'I am confused about the first step.');
  await addDayTwo(h, ['Could someone point me to the first step?']);
  const context = h.service.audience.reassessmentContext(need.id);
  assert.equal(need.epistemic_status, 'unverified_interpretation');
  for (const exchange of context.exchanges) {
    for (const evidence of exchange.evidence) {
      assert.match(evidence.text, /first step|confused/i);
      assert.notEqual(evidence.text, need.hypothesis, 'the prior interpretation is not presented as observed source text');
    }
  }
});
