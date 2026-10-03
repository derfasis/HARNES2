// Black-box acceptance for Audience Intelligence; synthetic source events only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { audienceHarness, SOURCE, SOURCE_B, proposalFrom } from './audience-test-helpers.mjs';
import { scoutHarness, channel, message, noHistory } from './scout-test-helpers.mjs';

async function seeded(h, { text = 'How do I get started with the programme?', source_id = SOURCE } = {}) {
  const goal = await h.open({ source_ids: [source_id] });
  const source = await h.ingest({ message_id: 'question-1', text, source_id });
  h.service.audience.reconcile({ limit: 10 });
  const detail = h.service.audience.detail(goal.goal_id);
  assert.equal(detail.exchanges.length, 1, 'bounded reconcile admitted the authorized event');
  const captured = await h.capture(goal.goal_id);
  const assessment = h.service.audience.assessment(captured.assessment_id);
  return { goal, source, detail, captured, assessment, packet: assessment.packet };
}

async function proposeAndAccept(h, packet) {
  const proposal = await h.command('audience.propose', { assessment_id: packet.assessment_id,
    output: proposalFrom(packet) });
  const id = proposal.need_ids[0];
  let need = h.service.audience.need(id);
  const receipt = await h.command('audience.review', { need_id: id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint, decision: 'accept', note: 'Reviewed one direct question.' });
  need = h.service.audience.need(receipt.need_id);
  return { id, need, receipt };
}

test('one question becomes an owner-reviewed need, then separately reviewed Continuity work', async t => {
  const h = audienceHarness(t), { goal, source, assessment, packet } = await seeded(h, t);
  assert.equal(packet.exchanges.length, 1);
  assert.equal(packet.exchanges[0].evidence[0].source_event_id, source.source_event_id);
  assert.equal(h.config.audience.modelEnabled, false);

  const proposal = await h.command('audience.propose', { assessment_id: assessment.id, output: proposalFrom(packet) });
  let need = h.service.audience.need(proposal.need_ids[0]);
  assert.equal(need.status, 'proposed');
  const requestId = '11111111-1111-4111-8111-111111111111';
  const review = { need_id: need.id, expected_revision: need.revision, expected_basis_fingerprint: need.basis_fingerprint,
    decision: 'accept', note: 'Reviewed one direct question.' };
  const receipt = await h.command('audience.review', review, requestId);
  need = h.service.audience.need(receipt.need_id);
  assert.equal(need.status, 'accepted');
  await assert.rejects(h.command('audience.review', review, requestId, { kind: 'agent' }));
  assert.equal(h.service.audience.need(need.id).status, 'accepted', 'a forbidden actor cannot replay the owner receipt');

  const before = Object.fromEntries(['persons', 'conversations', 'messages', 'drafts', 'approvals', 'delivery_attempts']
    .map(table => [table, h.store.get(`SELECT COUNT(*) n FROM ${table}`).n]));
  const work = await h.command('audience.open_work', { need_id: need.id,
    expected_revision: need.revision, expected_basis_fingerprint: need.basis_fingerprint });
  const continuity = h.service.continuity.detail(work.thread_id);
  assert.equal(continuity.memory, null, 'opening work stages a proposal; it does not accept interpretation');
  const turn = h.service.continuity.turn(work.turn_id);
  assert.equal(turn.status, 'proposed');
  await h.command('continuity.review', { turn_id: turn.id, expected_basis_fingerprint: turn.basis_fingerprint,
    decision: 'accept', note: 'Reviewed Continuity proposal.' });
  const ready = h.service.continuity.detail(work.thread_id);
  const opened = await h.command('work.open', { thread_id: work.thread_id,
    expected_basis_fingerprint: ready.basis_fingerprint, title: 'Prepare a clear starting point' });
  assert.ok(opened.case_id);
  for (const [table, count] of Object.entries(before))
    assert.equal(h.store.get(`SELECT COUNT(*) n FROM ${table}`).n, count, `${table} remains unchanged`);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='source.message'").n, 1);
  assert.equal(h.store.get('SELECT status FROM audience_goals WHERE id=?', goal.goal_id).status, 'OPEN');
});

test('made-up exchange and evidence references cannot be promoted', async t => {
  const h = audienceHarness(t), { assessment, packet } = await seeded(h);
  const invalid = proposalFrom(packet, { exchange_ids: ['foreign-exchange'], evidence_event_ids: ['999999'],
    support_quotes: [{ source_event_id: '999999', quote: 'A made-up source quote.' }] });
  await assert.rejects(h.command('audience.propose', { assessment_id: assessment.id, output: invalid }), { code: 'AUDIENCE_EVIDENCE_SCOPE' });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 0, 'invalid output has no partial need write');
});

test('a valid source reference with a fabricated quotation is refused', async t => {
  const h = audienceHarness(t), { assessment, packet } = await seeded(h);
  const invalid = proposalFrom(packet, { support_quotes: [{ source_event_id: packet.exchanges[0].evidence[0].source_event_id,
    quote: 'The source said something it never said.' }] });
  await assert.rejects(h.command('audience.propose', { assessment_id: assessment.id, output: invalid }), { code: 'AUDIENCE_QUOTE_MISMATCH' });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 0);
});

test('capture is finite and an identical packet cannot be billed or proposed twice', async t => {
  const h = audienceHarness(t), { goal, assessment } = await seeded(h);
  await assert.rejects(h.capture(goal.goal_id), { code: 'AUDIENCE_STALE_BASIS' });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_assessments').n, 1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 0, 'capture and duplicate refusal invoke no model');
  assert.equal(h.service.audience.assessment(assessment.id).status, 'captured');
});

test('late assessment completion cannot write a proposal after its source basis changes', async t => {
  const h = audienceHarness(t), { assessment, packet } = await seeded(h);
  await h.ingest({ message_id: 'question-1', version: 2, operation: 'delete', text: null });
  await assert.rejects(h.command('audience.propose', { assessment_id: assessment.id,
    output: proposalFrom(packet) }), { code: 'AUDIENCE_STALE_BASIS' });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 0,
    'a late result for revoked evidence has no partial write');
  assert.equal(h.store.get('SELECT status FROM audience_assessments WHERE id=?', assessment.id).status, 'captured');
});

test('restart retires an in-flight offline assessment and allows a newly observed batch', async t => {
  const h = audienceHarness(t), { goal, assessment } = await seeded(h);
  // Model the durable state after an offline evaluator claimed a captured packet but died
  // before writing a result. Store recovery must terminalize it without creating a run.
  h.store.run("UPDATE audience_assessments SET status='running' WHERE id=?", assessment.id);
  h.restart();
  h.service.audience.reconcile({ limit: 10 });
  assert.equal(h.service.audience.assessment(assessment.id).status, 'interrupted');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 0);
  await h.ingest({ message_id: 'question-2', text: 'Where can I find the next step?' });
  h.service.audience.reconcile({ limit: 10 });
  const detail = h.service.audience.detail(goal.goal_id);
  assert.ok(detail.ready);
  const next = await h.capture(goal.goal_id);
  assert.notEqual(next.assessment_id, assessment.id);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_assessments').n, 2);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 0);
});

test('unrelated media and another thread do not change the selected need or work basis', async t => {
  const h = audienceHarness(t), { packet } = await seeded(h), { id, need } = await proposeAndAccept(h, packet);
  const needBasis = need.basis_fingerprint;
  const work = await h.command('audience.open_work', { need_id: id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint });
  const before = h.service.continuity.detail(work.thread_id).basis_fingerprint;
  await h.ingest({ message_id: 'opaque-media', operation: 'unsupported', text: null, thread_id: 'other-thread',
    unsupported: { reason: 'media', fingerprint: 'a'.repeat(64) } });
  await h.ingest({ message_id: 'other-question', text: 'An unrelated question.', thread_id: 'other-thread' });
  h.service.audience.reconcile({ limit: 10 });
  const after = h.service.continuity.detail(work.thread_id);
  assert.equal(h.service.audience.need(id).status, 'accepted');
  assert.equal(h.service.audience.need(id).current, true);
  assert.equal(h.service.audience.need(id).basis_fingerprint, needBasis);
  assert.equal(after.basis_fingerprint, before);
  assert.equal(after.audience_scope.current, true);
});

test('a new reply blocks work before reconcile and stales the need after the exchange is refreshed', async t => {
  const h = audienceHarness(t), { packet } = await seeded(h), { id, need } = await proposeAndAccept(h, packet);
  await h.command('audience.open_work', { need_id: id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint });
  await h.ingest({ message_id: 'reply-1', reply_to_id: 'question-1', text: 'I also need to know what happens next.' });
  assert.equal(h.service.audience.need(id).current, false, 'source head/backlog blocks stale work immediately');
  const latest = h.service.audience.need(id);
  await assert.rejects(h.command('audience.refresh_work', { need_id: id, expected_revision: latest.revision,
    expected_basis_fingerprint: latest.basis_fingerprint }));
  h.service.audience.reconcile({ limit: 10 });
  assert.equal(h.service.audience.need(id).status, 'stale');
});

test('deleting a necessary anchor stales its need after restart', async t => {
  const h = audienceHarness(t), { packet } = await seeded(h), { id, need } = await proposeAndAccept(h, packet);
  await h.command('audience.open_work', { need_id: id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint });
  await h.ingest({ message_id: 'question-1', version: 2, operation: 'delete', text: null });
  h.service.audience.reconcile({ limit: 10 });
  h.restart();
  assert.equal(h.service.audience.need(id).status, 'stale');
  assert.equal(h.service.audience.need(id).current, false);
});

test('source revoke followed by reallow and restart cannot resurrect an accepted need', async t => {
  const h = audienceHarness(t), { packet } = await seeded(h), { id, need } = await proposeAndAccept(h, packet);
  h.config.opportunity.allowedSourceRefs = [SOURCE_B];
  h.service.audience.reconcile({ limit: 10 });
  h.restart();
  h.config.opportunity.allowedSourceRefs = [SOURCE, SOURCE_B];
  h.service.audience.reconcile({ limit: 10 });
  h.restart();
  assert.equal(h.service.audience.need(id).status, 'stale');
  assert.equal(h.service.audience.detail(need.goal_id).watches[0].status, 'revoked');
});

test('reissued Scout monitor authority cannot revive an Audience watch from an older grant epoch', async t => {
  let reads = 0;
  const h = scoutHarness(t, { history: async input => ++reads === 1
    ? { empty: false, requested_count: input.limit, received_count: 1, oldest_id: 1, messages: [message()] }
    : noHistory(input) });
  h.config.audience = { enabled: true, modelEnabled: false, sources: [] };
  const campaign = await h.campaign(); await h.authorize(campaign);
  const candidate = await h.seed(campaign), sample = await h.auditAndSeal(campaign, candidate);
  const grant = extra => ({ campaign_id: campaign.id, revision: campaign.revision, candidate_id: candidate.id,
    sample_id: sample.id, assessment_id: null, expires_at: new Date(Date.now() + 86400000).toISOString(),
    purpose: 'Bounded synthetic Audience authority epoch test', max_lag_seconds: 300, ...extra });
  const admitted = await h.command('scout.admit', grant());
  const goal = await h.command('audience.open', { title: 'Check an authorized public source',
    objective: 'Understand one observed question', source_ids: [admitted.source_ref] });
  const oldWatch = h.service.audience.watches(goal.goal_id)[0];
  const oldPolicy = oldWatch.policy_hash;
  // Isolate Audience's authority-epoch decision from the separately tested native transport gate.
  h.service.continuity.health = () => ({ current: true, reason: null });
  await h.command('scout.revoke', { campaign_id: campaign.id, revision: campaign.revision, grant_id: admitted.grant_id });
  await h.command('scout.admit', grant());
  assert.notEqual(h.service.audience.policyHash(admitted.source_ref), oldPolicy,
    'a newly issued monitor grant has a distinct durable authority epoch');
  assert.deepEqual(h.service.audience.health(oldWatch), { current: false, reason: 'AUDIENCE_SOURCE_POLICY_CHANGED' },
    'the previous watch cannot regain current status after the same source is re-admitted');
});

test('event budget advances fairly across two sources despite a noisy source', async t => {
  const h = audienceHarness(t), goal = await h.open({ source_ids: [SOURCE, SOURCE_B] });
  for (let i = 0; i < 7; i++) await h.ingest({ message_id: `noise-${i}`, text: `Noisy source item ${i}.`, source_id: SOURCE });
  await h.ingest({ message_id: 'quiet-1', text: 'A quiet source question.', source_id: SOURCE_B });
  const result = h.service.audience.reconcile({ limit: 10, event_limit: 1 });
  assert.equal(result.events, 2, 'one event budget is applied independently per watched source');
  const detail = h.service.audience.detail(goal.goal_id);
  assert.ok(detail.exchanges.some(e => e.source_ref === SOURCE_B), 'the quiet source progresses on the first bounded pass');
});

test('packet cap rotates across more than eight authorized sources without starving the tail', async t => {
  const h = audienceHarness(t), sources = Array.from({ length: 10 }, (_, i) => `public:audience-fairness-${i + 1}`);
  h.config.audience.sources = sources;
  h.config.opportunity.allowedSourceRefs = sources;
  const goal = await h.open({ source_ids: sources });
  for (const [i, source_id] of sources.entries())
    await h.ingest({ message_id: `question-${i + 1}`, source_id, text: `Distinct source question ${i + 1}.` });
  h.service.audience.reconcile({ limit: 20, event_limit: 1 });
  const first = h.service.audience.detail(goal.goal_id);
  assert.equal(first.exchanges.length, 8);
  const firstSources = first.exchanges.map(e => e.source_ref);
  assert.equal(new Set(firstSources).size, 8, 'the first packet uses distinct sources before taking a second item');
  const capture = await h.capture(goal.goal_id);
  const packet = h.service.audience.assessment(capture.assessment_id).packet;
  await h.command('audience.propose', { assessment_id: capture.assessment_id, output: proposalFrom(packet) });
  const next = h.service.audience.detail(goal.goal_id).exchanges;
  assert.deepEqual(next.map(e => e.source_ref), sources.filter(source => !firstSources.includes(source)),
    'the two sources beyond the packet cap become the next packet instead of being starved');
});

test('expired entries ahead of the queue cannot hide its fresh ninth exchange', async t => {
  const h = audienceHarness(t), goal = await h.open({ source_ids: [SOURCE], max_age_seconds: 60 });
  const eventIds = [];
  for (let i = 0; i < 9; i++) {
    const result = await h.ingest({ message_id: `age-${i + 1}`, text: `Separate recent question ${i + 1}.` });
    eventIds.push(result.source_event_id);
  }
  h.service.audience.reconcile({ limit: 10, event_limit: 50 });
  for (const eventId of eventIds.slice(0, 8))
    h.store.run('UPDATE events SET created_at=? WHERE id=?', '2020-01-01T00:00:00.000Z', Number(eventId));
  const detail = h.service.audience.detail(goal.goal_id);
  assert.equal(detail.ready, true, 'the fresh exchange beyond eight expired rows is still selectable');
  assert.deepEqual(detail.exchanges.map(exchange => exchange.anchor_id), ['age-9']);
});

test('malformed linked exchange is quarantined while reconciliation advances a healthy neighbour and survives restart', async t => {
  const h = audienceHarness(t), goal = await h.open({ source_ids: [SOURCE, SOURCE_B] });
  await h.ingest({ message_id: 'supported-question', text: 'How do I get started?' });
  h.service.audience.reconcile({ limit: 10 });
  const captured = await h.capture(goal.goal_id), assessment = h.service.audience.assessment(captured.assessment_id);
  const proposed = await h.command('audience.propose', { assessment_id: assessment.id,
    output: proposalFrom(assessment.packet) });
  let need = h.service.audience.need(proposed.need_ids[0]);
  await h.command('audience.review', { need_id: need.id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint, decision: 'accept', note: 'One direct question supports review.' });
  need = h.service.audience.need(need.id);
  const work = await h.command('audience.open_work', { need_id: need.id,
    expected_revision: need.revision, expected_basis_fingerprint: need.basis_fingerprint });
  const exchangeId = JSON.parse(h.store.get('SELECT basis_json FROM audience_needs WHERE id=?', need.id).basis_json).exchanges[0].id;

  h.store.run("UPDATE audience_exchanges SET member_ids_json=? WHERE id=?", '{corrupt', exchangeId);
  await h.ingest({ message_id: 'source-a-after-corruption', text: 'A later item touches the damaged scope.' });
  await h.ingest({ message_id: 'healthy-neighbour', source_id: SOURCE_B, text: 'A separate source still has a new question.' });
  h.service.audience.reconcile({ limit: 10, event_limit: 50 });

  assert.equal(h.service.audience.need(need.id).status, 'stale');
  assert.ok(h.service.audience.detail(goal.goal_id).exchanges.some(exchange => exchange.source_ref === SOURCE_B),
    'the healthy source progresses after the corrupt exchange is isolated');
  assert.equal(h.service.audienceReconciliationHealth, true);
  const linked = h.service.continuity.detail(work.thread_id).audience_scope;
  assert.ok(linked && !linked.current, 'the previously opened work stays tied to its damaged Audience scope');
  h.restart(); h.service.audience.reconcile({ limit: 10, event_limit: 50 });
  assert.equal(h.service.audience.need(need.id).status, 'stale');
  assert.ok(!h.service.continuity.detail(work.thread_id).audience_scope.current,
    'restart does not recover authority from the malformed exchange');
});

test('cyclic reply ancestry is excluded instead of becoming a supported exchange', async t => {
  const h = audienceHarness(t), goal = await h.open();
  await h.ingest({ message_id: 'cycle-a', reply_to_id: 'cycle-b', text: 'First cyclic message.' });
  await h.ingest({ message_id: 'cycle-b', reply_to_id: 'cycle-a', text: 'Second cyclic message.' });
  h.service.audience.reconcile({ limit: 10 });
  const detail = h.service.audience.detail(goal.goal_id);
  assert.equal(detail.ready, false);
  assert.equal(detail.exchanges.length, 0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 0);
});

test('corrupted linked need is quarantined, remains scoped, and is not resurrected on restart', async t => {
  const h = audienceHarness(t), { packet } = await seeded(h), { id, need } = await proposeAndAccept(h, packet);
  const work = await h.command('audience.open_work', { need_id: id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint });
  h.store.run("UPDATE audience_needs SET basis_json=? WHERE id=?", '{corrupt', id);
  await assert.rejects(Promise.resolve().then(() => h.service.audience.need(id)), { code: 'AUDIENCE_RECORD_INVALID' });
  h.service.audience.reconcile({ limit: 10 });
  assert.equal(h.store.get('SELECT status FROM audience_needs WHERE id=?', id).status, 'stale');
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='audience.quarantined' AND json_extract(payload_json,'$.need_id')=?", id).n, 1);
  const scope = h.service.continuity.detail(work.thread_id).audience_scope;
  assert.ok(scope, 'corrupt linked work keeps its narrow Audience provenance');
  assert.equal(scope.current, false);
  assert.ok(scope.reasons.includes('AUDIENCE_RECORD_INVALID'));
  h.restart(); h.service.audience.reconcile({ limit: 10 });
  assert.equal(h.store.get('SELECT status FROM audience_needs WHERE id=?', id).status, 'stale');
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='audience.quarantined' AND json_extract(payload_json,'$.need_id')=?", id).n, 1,
    'restart does not repeat quarantine or restore current authority');
});

test('a corrupt work-link basis stays blocked without aborting healthy Continuity reconciliation', async t => {
  const h = audienceHarness(t), { packet } = await seeded(h), { id, need } = await proposeAndAccept(h, packet);
  const linked = await h.command('audience.open_work', { need_id: id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint });
  const neighbor = await h.command('continuity.open', { title: 'Healthy independent work', objective: 'Observe a separate source',
    success_condition: 'Preserve the separate evidence', source_ids: [SOURCE_B], max_age_seconds: 3600 });
  h.store.run('UPDATE audience_work_links SET basis_json=? WHERE thread_id=?', '{corrupt', linked.thread_id);
  await h.ingest({ message_id: 'neighbor-after-link-corruption', source_id: SOURCE_B, text: 'A healthy new question.' });
  const reconciled = h.service.continuity.reconcile({ limit: 20, event_limit: 50 });
  assert.equal(reconciled.threads, 2);
  const scope = h.service.continuity.detail(linked.thread_id).audience_scope;
  assert.ok(scope, 'invalid link cannot fall back to unrestricted Continuity');
  assert.equal(scope.current, false);
  assert.deepEqual(scope.reasons, ['AUDIENCE_RECORD_INVALID']);
  assert.equal(h.service.audience.temporaryWorkBlock(linked.thread_id), false, 'corruption is never a reversible transport hold');
  assert.equal(h.service.continuity.detail(neighbor.thread_id).evidence.length, 1, 'healthy neighbor advances');
  h.restart(); h.service.audience.reconcile({ limit: 10 });
  h.service.continuity.reconcile({ limit: 20 });
  assert.equal(h.service.continuity.detail(linked.thread_id).audience_scope.current, false);
  assert.equal(h.service.continuity.detail(neighbor.thread_id).evidence.length, 1);
});

test('temporary unrelated-source backlog blocks work without retiring it and restores its basis after catch-up', async t => {
  const h = audienceHarness(t), { packet } = await seeded(h), { id, need } = await proposeAndAccept(h, packet);
  const staged = await h.command('audience.open_work', { need_id: id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint });
  const turn = h.service.continuity.turn(staged.turn_id);
  await h.command('continuity.review', { turn_id: turn.id, expected_basis_fingerprint: turn.basis_fingerprint,
    decision: 'accept', note: 'Accept bounded interpretation.' });
  const thread = h.service.continuity.detail(staged.thread_id);
  const opened = await h.command('work.open', { thread_id: staged.thread_id,
    expected_basis_fingerprint: thread.basis_fingerprint, title: 'Prepare an answer' });
  const d = h.service.work.detail(opened.case_id);
  const material = await h.command('work.material', { case_id: opened.case_id, expected_revision: d.revision,
    title: 'Starting point', content: 'A local, evidence-bound starting point.', evidence_event_ids: d.evidence_event_ids });
  const before = h.service.continuity.detail(staged.thread_id), caseBefore = h.service.work.detail(opened.case_id);

  for (let i = 0; i < 24; i++) await h.ingest({ message_id: `unrelated-${i}`, thread_id: 'other-thread', text: `Separate topic ${i}.` });
  assert.equal(h.service.work.detail(opened.case_id).current, false, 'unreconciled source head temporarily blocks the case');
  h.service.work.reconcile(20, 20);
  h.service.continuity.reconcile({ limit: 20 });
  assert.equal(h.service.work.detail(opened.case_id).status, caseBefore.status);
  assert.equal(h.service.work.detail(opened.case_id).material.id, material.material_id);
  h.service.audience.reconcile({ limit: 10, event_limit: 50 });
  const after = h.service.continuity.detail(staged.thread_id);
  const caseAfter = h.service.work.detail(opened.case_id);
  assert.equal(after.basis_fingerprint, before.basis_fingerprint);
  assert.equal(caseAfter.current, true);
  assert.equal(caseAfter.material.id, material.material_id);
});
