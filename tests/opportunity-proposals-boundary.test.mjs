// Independent boundary probes for v2 Audience proposals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { audienceHarness, SOURCE, SOURCE_B, EVENT_TIME, proposalFrom } from './audience-test-helpers.mjs';
import { pollBrowserSource } from '../business/sources/browser-readonly.mjs';
import { browserCheckpoint } from '../business/source-ingestion.mjs';

const BROWSER = 'browser:proposal-boundary';
const SOURCES = [SOURCE, SOURCE_B, 'public:audience-fixture-c', 'public:audience-fixture-d'];

async function proposeNeed(h, goalId, outputFactory = proposalFrom) {
  const captured = await h.capture(goalId), assessment = h.service.audience.assessment(captured.assessment_id);
  const output = outputFactory(assessment.packet);
  const proposed = await h.command('audience.propose', { assessment_id: assessment.id, output });
  return { assessment, output, id: proposed.need_ids[0], need: h.service.audience.need(proposed.need_ids[0]) };
}

async function reviewedNeed(h, id) {
  let need = h.service.audience.need(id);
  await h.command('audience.review', { need_id: id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint, decision: 'accept', note: 'Review exact bounded evidence.' });
  return h.service.audience.need(id);
}

async function readyCase(h, need) {
  const linked = await h.command('audience.open_work', { need_id: need.id,
    expected_revision: need.revision, expected_basis_fingerprint: need.basis_fingerprint });
  const turn = h.service.continuity.turn(linked.turn_id);
  await h.command('continuity.review', { turn_id: turn.id, expected_basis_fingerprint: turn.basis_fingerprint,
    decision: 'accept', note: 'Accept the bounded interpretation for this case.' });
  const current = h.service.continuity.detail(linked.thread_id);
  const opened = await h.command('work.open', { thread_id: linked.thread_id,
    expected_basis_fingerprint: current.basis_fingerprint, title: 'Prepare scoped material' });
  return h.service.work.detail(opened.case_id);
}

async function importPayload(h) {
  const goal = await h.open({ source_ids: [SOURCE] });
  await h.ingest({ message_id: 'boundary-need', text: 'Could someone help with the Saturday welcome desk?' });
  h.service.audience.reconcile({ limit: 10 });
  const result = await proposeNeed(h, goal.goal_id, packet => proposalFrom(packet, { next_step: 'prepare_material' }));
  const need = await reviewedNeed(h, result.id);
  const row = await readyCase(h, { ...need, id: result.id });
  return { need: h.service.audience.need(result.id), row };
}

test('Browser capture and edit clocks remain unknown even after its policy is removed', async t => {
  const h = audienceHarness(t);
  h.config.opportunity.allowedSourceRefs = [BROWSER];
  h.config.opportunity.browserSources = [{ sourceId: BROWSER, url: 'https://example.com/volunteer',
    sourceKind: 'live_snapshot', processingBasis: 'Read public page content only.',
    maxLagSeconds: 3600, pollEverySeconds: 120 }];
  const goal = await h.open({ source_ids: [BROWSER] });
  await pollBrowserSource(h.service, BROWSER, {
    async readPage() { return { text: 'Volunteers may contact the welcome desk.', finalUrl: 'https://example.com/volunteer', status: 200, truncated: false }; },
    markCurrent() {}, markDirty() {}
  });
  const checkpoint = browserCheckpoint(h.service, BROWSER);
  assert.equal(checkpoint.phase, 'current');
  h.service.audience.reconcile({ limit: 10 });
  const captured = await h.capture(goal.goal_id), assessment = h.service.audience.assessment(captured.assessment_id);
  const evidence = assessment.packet.exchanges.flatMap(exchange => exchange.evidence)[0];
  assert.equal(evidence.published_at, null);
  assert.equal(evidence.source_updated_at, null);

  // The durable checkpoint outlives the live policy, so the source kind must not
  // accidentally change Browser capture timestamps into source publication dates.
  h.config.opportunity.browserSources = [];
  assert.equal(browserCheckpoint(h.service, BROWSER).phase, 'current');
  const reread = h.service.continuity.evidenceStates({ max_age_seconds: 3600 },
    [{ source_ref: BROWSER, policy_hash: 'retired-policy' }], [evidence.source_event_id]).get(evidence.source_event_id);
  assert.equal(reread.published_at, null);
  assert.equal(reread.source_updated_at, null);
});

test('rejected or superseded imported material cannot be re-imported or resurrected', async t => {
  await t.test('rejected preview', async st => {
    const h = audienceHarness(st), { need, row } = await importPayload(h);
    const payload = { need_id: need.id, expected_revision: need.revision, expected_basis_fingerprint: need.basis_fingerprint,
      case_id: row.id, expected_case_revision: row.revision, expected_preview_sha256: need.preview_sha256 };
    const imported = await h.command('audience.import_preview', payload, '27c3a841-5b70-4c9c-a001-000000000001');
    let current = h.service.work.detail(row.id);
    await h.command('work.review', { case_id: row.id, expected_revision: current.revision, material_id: imported.material_id,
      sha256: imported.sha256, decision: 'reject', note: 'Rejected exact preview.' });
    current = h.service.work.detail(row.id);
    await assert.rejects(h.command('audience.import_preview', { ...payload, expected_case_revision: current.revision },
      '27c3a841-5b70-4c9c-a001-000000000002'));
    assert.equal(current.material.status, 'rejected');
    assert.equal(h.store.get('SELECT COUNT(*) n FROM work_materials WHERE case_id=?', row.id).n, 1);
  });
  await t.test('superseded preview and old receipt after later case revisions', async st => {
    const h = audienceHarness(st), { need, row } = await importPayload(h);
    const payload = { need_id: need.id, expected_revision: need.revision, expected_basis_fingerprint: need.basis_fingerprint,
      case_id: row.id, expected_case_revision: row.revision, expected_preview_sha256: need.preview_sha256 };
    const request = '27c3a841-5b70-4c9c-a001-000000000003';
    const imported = await h.command('audience.import_preview', payload, request);
    let current = h.service.work.detail(row.id);
    await h.command('work.review', { case_id: row.id, expected_revision: current.revision, material_id: imported.material_id,
      sha256: imported.sha256, decision: 'approve', note: 'Approved exact preview before superseding it.' });
    await assert.rejects(h.command('audience.import_preview', payload, request),
      'the original receipt cannot replay after the case/material review revision');
    current = h.service.work.detail(row.id);
    const refs = current.evidence_event_ids;
    await h.command('work.material', { case_id: row.id, expected_revision: current.revision,
      title: 'Replacement material', content: 'A separately reviewed replacement.', evidence_event_ids: refs });
    current = h.service.work.detail(row.id);
    assert.equal(current.material.status, 'proposed');
    await assert.rejects(h.command('audience.import_preview', { ...payload, expected_case_revision: current.revision },
      '27c3a841-5b70-4c9c-a001-000000000004'), 'a newer material pointer cannot resurrect an earlier preview');
    assert.equal(h.store.get('SELECT COUNT(*) n FROM work_materials WHERE case_id=?', row.id).n, 2);
  });
});

test('a v2 need with a damaged persisted context basis is quarantined before import', async t => {
  const h = audienceHarness(t), goal = await h.open({ source_ids: [SOURCE] });
  await h.ingest({ message_id: 'basis-primary', text: 'We need help staffing the Saturday welcome desk.' });
  await h.ingest({ message_id: 'basis-context', text: 'The volunteer roster was revised this morning.' });
  h.service.audience.reconcile({ limit: 10 });
  const proposed = await proposeNeed(h, goal.goal_id, packet => {
    const base = proposalFrom(packet, { next_step: 'prepare_material' }).needs[0];
    const selected = packet.exchanges;
    const refs = selected.flatMap(exchange => exchange.evidence.map(item => item.source_event_id));
    base.exchange_ids = selected.map(exchange => exchange.id);
    base.evidence_event_ids = selected[0].evidence.map(item => item.source_event_id);
    base.context_event_ids = selected.slice(1).flatMap(exchange => exchange.evidence.map(item => item.source_event_id));
    base.context_review = packet.exchanges.map((exchange, index) => ({ exchange_id: exchange.id,
      classification: index === 0 ? 'supporting' : 'related', evidence_event_ids: exchange.evidence.map(item => item.source_event_id),
      reason: 'Explicit source-scoped review.' }));
    base.support_quotes = refs.map(source_event_id => ({ source_event_id,
      quote: selected.flatMap(exchange => exchange.evidence).find(item => item.source_event_id === source_event_id).text }));
    base.material_preview = { title: 'Welcome desk question', content: 'Please confirm current welcome desk coverage.', evidence_event_ids: refs };
    return { needs: [base] };
  });
  const row = h.store.get('SELECT basis_json FROM audience_needs WHERE id=?', proposed.id);
  const basis = JSON.parse(row.basis_json);
  basis.exchanges = basis.exchanges.slice(0, 1); // structurally valid JSON, but silently drops the reviewed context exchange
  h.store.run('UPDATE audience_needs SET basis_json=? WHERE id=?', JSON.stringify(basis), proposed.id);
  assert.throws(() => h.service.audience.need(proposed.id), { code: 'AUDIENCE_RECORD_INVALID' });
  await assert.rejects(h.command('audience.import_preview', { need_id: proposed.id, expected_revision: proposed.need.revision,
    expected_basis_fingerprint: proposed.need.basis_fingerprint, case_id: 'none', expected_case_revision: 1,
    expected_preview_sha256: proposed.need.preview_sha256 }));
  assert.equal(h.store.get('SELECT COUNT(*) n FROM work_materials').n, 0);
});

test('new model assessments refuse a legacy v1 result even when its old schema validates', async t => {
  const h = audienceHarness(t), goal = await h.open({ source_ids: [SOURCE] });
  await h.ingest({ message_id: 'model-contract', text: 'How can I reserve the welcome desk?' });
  h.service.audience.reconcile({ limit: 10 });
  const captured = await h.capture(goal.goal_id), assessment = h.service.audience.assessment(captured.assessment_id);
  const oldOutput = proposalFrom(assessment.packet);
  for (const need of oldOutput.needs) {
    delete need.proposal_version; delete need.context_event_ids; delete need.context_review;
  }
  h.store.run("UPDATE audience_assessments SET status='running' WHERE id=?", assessment.id);
  assert.throws(() => h.service.audience.propose({ assessment_id: assessment.id, output: oldOutput }, 'model'),
    { code: 'AUDIENCE_PROPOSAL_INVALID' },
  'a new model assessment must satisfy v2 completeness, even though historical v1 rows remain readable');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 0);
});

test('editing stored preview bytes while preserving valid JSON fails the need read digest binding', async t => {
  const h = audienceHarness(t), goal = await h.open({ source_ids: [SOURCE] });
  await h.ingest({ message_id: 'preview-binding', text: 'Who can help at the welcome desk?' });
  h.service.audience.reconcile({ limit: 10 });
  const created = await proposeNeed(h, goal.goal_id, packet => proposalFrom(packet, { next_step: 'prepare_material' }));
  const stored = h.store.get('SELECT output_json FROM audience_needs WHERE id=?', created.id);
  const edited = JSON.parse(stored.output_json);
  edited.material_preview.content += 'Unreviewed sentence.';
  h.store.run('UPDATE audience_needs SET output_json=? WHERE id=?', JSON.stringify(edited), created.id);
  assert.throws(() => h.service.audience.need(created.id), { code: 'AUDIENCE_RECORD_INVALID' },
    'a validly shaped persisted preview must still match the immutable assessment output');
});

test('31 selected context events across four sources survive Continuity and Action bounds', async t => {
  const h = audienceHarness(t);
  h.config.opportunity.allowedSourceRefs = SOURCES;
  const goal = await h.open({ source_ids: SOURCES });
  for (let s = 0; s < SOURCES.length; s++) {
    const root = `many-root-${s}`;
    await h.ingest({ source_id: SOURCES[s], message_id: root, text: s === 0
      ? 'We need a volunteer at the welcome desk on Saturday.' : `The volunteer schedule note for group ${s} was updated.` });
    for (let i = 1; i < 8; i++) await h.ingest({ source_id: SOURCES[s], message_id: `${root}-reply-${i}`,
      reply_to_id: root, text: `Additional roster context ${s}-${i} is not evidence that the role was filled.` });
  }
  h.service.audience.reconcile({ limit: 20, event_limit: 50 });
  const captured = await h.capture(goal.goal_id), assessment = h.service.audience.assessment(captured.assessment_id), packet = assessment.packet;
  assert.equal(packet.exchanges.length, 4);
  const source0 = packet.exchanges.find(exchange => exchange.source_ref === SOURCES[0]);
  const support = source0.evidence[0];
  const contexts = packet.exchanges.flatMap(exchange => exchange.evidence.filter(item => item.source_event_id !== support.source_event_id));
  assert.equal(contexts.length, 31);
  const output = { needs: [{ proposal_version: 2, need_id: null,
    title: 'Confirm current welcome desk coverage',
    hypothesis: 'The group may need a volunteer at the welcome desk on Saturday.',
    why_now: 'One source explicitly requests help; selected roster updates provide bounded context.',
    exchange_ids: packet.exchanges.map(exchange => exchange.id), evidence_event_ids: [support.source_event_id],
    counterevidence_event_ids: [], context_event_ids: contexts.map(item => item.source_event_id),
    context_review: packet.exchanges.map(exchange => ({ exchange_id: exchange.id,
      classification: exchange === source0 ? 'supporting' : 'related',
      evidence_event_ids: exchange.evidence.map(item => item.source_event_id), reason: 'Reviewed the complete bounded exchange.' })),
    next_step: 'prepare_material', reason: 'A short owner-reviewed question can establish current coverage.',
    unknowns: ['Whether a volunteer has since been assigned.'],
    support_quotes: [support, ...contexts].map(item => ({ source_event_id: item.source_event_id, quote: item.text })),
    material_preview: { title: 'Welcome desk coverage', content: 'A source requests Saturday welcome desk help.\nPlease confirm whether someone is assigned.\n',
      evidence_event_ids: [support.source_event_id, ...contexts.map(item => item.source_event_id)] } }] };
  const created = await h.command('audience.propose', { assessment_id: assessment.id, output });
  const need = await reviewedNeed(h, created.need_ids[0]);
  const linked = await h.command('audience.open_work', { need_id: need.id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint });
  const turn = h.service.continuity.turn(linked.turn_id);
  const interpreted = turn.output;
  assert.equal(interpreted.hypotheses.flatMap(hypothesis => hypothesis.context_event_ids ?? []).length, 31);
  await h.command('continuity.review', { turn_id: turn.id, expected_basis_fingerprint: turn.basis_fingerprint,
    decision: 'accept', note: 'Review the complete selected context.' });
  const current = h.service.continuity.detail(linked.thread_id);
  const opened = await h.command('work.open', { thread_id: linked.thread_id,
    expected_basis_fingerprint: current.basis_fingerprint, title: 'Prepare a bounded question' });
  const caseId = opened.case_id, work = h.service.work.detail(caseId);
  assert.equal(work.evidence_event_ids.length, 32);
  const payload = { need_id: need.id, expected_revision: need.revision, expected_basis_fingerprint: need.basis_fingerprint,
    case_id: caseId, expected_case_revision: work.revision, expected_preview_sha256: need.preview_sha256 };
  const material = await h.command('audience.import_preview', payload);
  let reviewed = h.service.work.detail(caseId);
  await h.command('work.review', { case_id: caseId, expected_revision: reviewed.revision, material_id: material.material_id,
    sha256: material.sha256, decision: 'approve', note: 'Review exact bounded bytes.' });
  reviewed = h.service.work.detail(caseId);
  h.config.actions.enabled = true;
  const action = await h.command('work.prepare_action', { case_id: caseId, expected_revision: reviewed.revision,
    material_id: material.material_id, capability_id: 'material.export_local.v1' });
  const actionDetail = h.service.actions.detail(action.action_id);
  assert.equal(actionDetail.packet.evidence.length, 32);
  assert.deepEqual(new Set(actionDetail.packet.evidence.map(item => item.source_event_id)),
    new Set([support.source_event_id, ...contexts.map(item => item.source_event_id)]));
  assert.equal(actionDetail.status, 'proposed');
});

test('byte tampering of an imported material cannot be replayed as the reviewed preview', async t => {
  const h = audienceHarness(t), { need, row } = await importPayload(h);
  const payload = { need_id: need.id, expected_revision: need.revision, expected_basis_fingerprint: need.basis_fingerprint,
    case_id: row.id, expected_case_revision: row.revision, expected_preview_sha256: need.preview_sha256 };
  const imported = await h.command('audience.import_preview', payload, '27c3a841-5b70-4c9c-a001-000000000005');
  const content = h.store.get('SELECT content FROM work_materials WHERE id=?', imported.material_id).content;
  // Fault injection bypasses the deliberate immutable-row trigger to simulate a
  // damaged durable store; production commands cannot mutate this column.
  h.store.run('DROP TRIGGER work_material_immutable');
  h.store.run('UPDATE work_materials SET content=? WHERE id=?', `${content}Tampered bytes.`, imported.material_id);
  const current = h.service.work.detail(row.id);
  await assert.rejects(h.command('audience.import_preview', { ...payload, expected_case_revision: current.revision },
    '27c3a841-5b70-4c9c-a001-000000000006'), { code: 'AUDIENCE_RECORD_INVALID' });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM work_materials WHERE case_id=?', row.id).n, 1);
});

test('updating a v2 need on a fresh packet resets review and stales its prior linked Work scope', async t => {
  const h = audienceHarness(t), goal = await h.open({ source_ids: [SOURCE] });
  await h.ingest({ message_id: 'revision-old-support', text: 'Could a volunteer help at the Saturday welcome desk?' });
  await h.ingest({ message_id: 'revision-old-context', text: 'The roster was refreshed yesterday.' });
  h.service.audience.reconcile({ limit: 10 });
  const first = await proposeNeed(h, goal.goal_id, packet => {
    const base = proposalFrom(packet).needs[0];
    const ctx = packet.exchanges.find(exchange => exchange.evidence.some(item => item.text.includes('roster')));
    base.exchange_ids = [...new Set([...base.exchange_ids, ctx.id])];
    base.context_event_ids = ctx.evidence.map(item => item.source_event_id);
    base.context_review = packet.exchanges.map(exchange => ({ exchange_id: exchange.id,
      classification: exchange.id === ctx.id ? 'related' : 'supporting',
      evidence_event_ids: exchange.evidence.map(item => item.source_event_id), reason: 'Reviewed in first version.' }));
    base.support_quotes = [...base.support_quotes, ...ctx.evidence.map(item => ({ source_event_id: item.source_event_id, quote: item.text }))];
    return { needs: [base] };
  });
  const accepted = await reviewedNeed(h, first.id);
  const linked = await h.command('audience.open_work', { need_id: accepted.id, expected_revision: accepted.revision,
    expected_basis_fingerprint: accepted.basis_fingerprint });
  await h.ingest({ message_id: 'revision-new-support', text: 'A separate follow-up asks when a volunteer is available.' });
  h.service.audience.reconcile({ limit: 10 });
  const nextCapture = await h.capture(goal.goal_id), next = h.service.audience.assessment(nextCapture.assessment_id);
  assert.ok(next.packet.needs.some(item => item.id === accepted.id), 'the prior need is available only as an explicit revision candidate');
  const newExchange = next.packet.exchanges.find(exchange => exchange.evidence.some(item => item.text.includes('separate follow-up')));
  const oldId = accepted.id;
  const revisedOutput = proposalFrom(next.packet, { need_id: oldId, title: 'Clarify the new volunteer availability question' });
  const revised = await h.command('audience.propose', { assessment_id: next.id, output: revisedOutput });
  const updated = h.service.audience.need(revised.need_ids[0]);
  assert.equal(updated.revision, accepted.revision + 1);
  assert.equal(updated.status, 'proposed', 'a revised inference always returns for a fresh owner review');
  assert.deepEqual(updated.context_event_ids, [], 'old selected context is intentionally not silently inherited into a new packet');
  const priorThread = h.service.continuity.detail(linked.thread_id);
  assert.equal(priorThread.ready, false, 'the old accepted memory cannot continue under the revised need basis');
  assert.ok(newExchange, 'revision basis came from a distinct newly supplied exchange');
});
