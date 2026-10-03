// Focused guard regressions for races and durable assessment integrity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { audienceHarness, SOURCE, SOURCE_B, proposalFrom } from './audience-test-helpers.mjs';

async function needFixture(h, { accepted = true, sourceIds = [SOURCE] } = {}) {
  const goal = await h.open({ source_ids: sourceIds });
  await h.ingest({ message_id: 'history-root', text: 'How do I get started with setup?' });
  h.service.audience.reconcile({ limit: 10 });
  const captured = await h.capture(goal.goal_id), assessment = h.service.audience.assessment(captured.assessment_id);
  const proposal = await h.command('audience.propose', { assessment_id: assessment.id, output: proposalFrom(assessment.packet) });
  let need = h.service.audience.need(proposal.need_ids[0]);
  if (accepted) {
    await h.command('audience.review', { need_id: need.id, expected_revision: need.revision,
      expected_basis_fingerprint: need.basis_fingerprint, decision: 'accept', note: 'Accept fixture need.' });
    need = h.service.audience.need(need.id);
  }
  return { goal, need };
}

async function focusedPacket(h, need, requestId = undefined) {
  await h.ingest({ message_id: 'followup-root', text: 'Where is the first setup step?' });
  h.service.audience.reconcile({ limit: 10 });
  const context = h.service.audience.reassessmentContext(need.id);
  h.config.audience.modelEnabled = true;
  const payload = { need_id: need.id, expected_revision: need.revision,
    expected_basis_fingerprint: context.need_basis_fingerprint,
    expected_context_fingerprint: context.context_fingerprint };
  const requested = await h.command('audience.reassess', payload, requestId);
  return { context, payload, assessment: h.service.audience.assessment(requested.assessment_id) };
}

function focusedOutput(packet, needId, context) {
  const prior = packet.exchanges.find(e => context.prior_exchange_ids.includes(e.id));
  const fresh = packet.exchanges.find(e => context.new_exchange_ids.includes(e.id));
  assert.ok(prior && fresh, 'test packet contains selected history and a fresh canonical exchange');
  const oldEvidence = prior.evidence[0], newEvidence = fresh.evidence[0];
  return proposalFrom(packet, { need_id: needId, exchange_ids: [prior.id, fresh.id],
    evidence_event_ids: [oldEvidence.source_event_id, newEvidence.source_event_id],
    support_quotes: [
      { source_event_id: oldEvidence.source_event_id, quote: oldEvidence.text },
      { source_event_id: newEvidence.source_event_id, quote: newEvidence.text },
    ] });
}

test('a new watched-source head during focused processing invalidates completion', async t => {
  const h = audienceHarness(t), { need } = await needFixture(h, { sourceIds: [SOURCE, SOURCE_B] });
  const { context, assessment } = await focusedPacket(h, need);
  await h.ingest({ source_id: SOURCE_B, message_id: 'racing-root', text: 'A root arrived on the other watched source.' });
  assert.ok(h.service.continuity.head(SOURCE_B) > context.observation_heads.find(([source]) => source === SOURCE_B)[1],
    'positive control: the independently watched source head advanced');
  await assert.rejects(h.command('audience.propose', { assessment_id: assessment.id,
    output: focusedOutput(assessment.packet, need.id, context) }), { code: 'AUDIENCE_STALE_BASIS' });
});

test('a target review that changes its revision invalidates a pending focused result', async t => {
  const h = audienceHarness(t), { need } = await needFixture(h, { accepted: false });
  const { context, assessment } = await focusedPacket(h, need);
  await h.command('audience.review', { need_id: need.id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint, decision: 'accept', note: 'Accept while focus is pending.' });
  await assert.rejects(h.command('audience.propose', { assessment_id: assessment.id,
    output: focusedOutput(assessment.packet, need.id, context) }), { code: 'AUDIENCE_STALE_BASIS' });
});

test('replaying a reassessment receipt after target review revalidates the old request', async t => {
  const h = audienceHarness(t), { need } = await needFixture(h);
  const requestId = '651445b3-d95e-42b4-92cb-873a74525db1';
  const { context, payload, assessment } = await focusedPacket(h, need, requestId);
  const output = focusedOutput(assessment.packet, need.id, context);
  await h.command('audience.propose', { assessment_id: assessment.id, output });
  const revised = h.service.audience.need(need.id);
  await h.command('audience.review', { need_id: need.id, expected_revision: revised.revision,
    expected_basis_fingerprint: revised.basis_fingerprint, decision: 'accept', note: 'Review focused revision.' });
  await assert.rejects(h.command('audience.reassess', payload, requestId), { code: 'AUDIENCE_STALE_BASIS' });
});

test('tampered focused packet text cannot substitute for canonical source text', async t => {
  const h = audienceHarness(t), { need } = await needFixture(h);
  const { context, assessment } = await focusedPacket(h, need);
  const row = h.store.get('SELECT packet_json FROM audience_assessments WHERE id=?', assessment.id);
  const tampered = JSON.parse(row.packet_json);
  tampered.exchanges[0].evidence[0].text = 'Tampered source text that was never observed.';
  h.store.run('UPDATE audience_assessments SET packet_json=? WHERE id=?', JSON.stringify(tampered), assessment.id);
  await assert.rejects(h.command('audience.propose', { assessment_id: assessment.id,
    output: focusedOutput(tampered, need.id, context) }), { code: 'AUDIENCE_RECORD_INVALID' });
});
