// Black-box contract tests for version 2 Audience opportunity proposals.
// All source events are synthetic and all services run offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { audienceHarness, SOURCE, proposalFrom } from './audience-test-helpers.mjs';

async function packetWithRoots(h) {
  const goal = await h.open({ source_ids: [SOURCE] });
  const request = await h.ingest({ message_id: 'timekeeper-request',
    text: 'We need a volunteer timekeeper for Saturday.' });
  const roster = await h.ingest({ message_id: 'roster-update',
    text: 'The volunteer roster was updated today.' });
  const unrelated = await h.ingest({ message_id: 'unrelated-announcement',
    text: 'The hall entrance will be repainted next month.' });
  await h.ingest({ message_id: 'opaque-leaf-media', thread_id: 'unrelated-leaf', operation: 'unsupported', text: null,
    unsupported: { reason: 'media', fingerprint: 'c'.repeat(64) } });
  h.service.audience.reconcile({ limit: 20 });
  const captured = await h.capture(goal.goal_id);
  const assessment = h.service.audience.assessment(captured.assessment_id);
  assert.equal(assessment.packet.exchanges.length, 3);
  return { goal, request, roster, unrelated, assessment, packet: assessment.packet };
}

function v2Proposal(packet, overrides = {}) {
  const byText = text => packet.exchanges.find(x => x.evidence.some(e => e.text.includes(text)));
  const supporting = byText('timekeeper');
  const related = byText('roster');
  const unrelated = byText('repainted');
  assert.ok(supporting && related && unrelated, 'fixture contains request, roster, and unrelated roots');
  const selected = [supporting, related];
  const refs = selected.flatMap(x => x.evidence.map(e => e.source_event_id));
  return { needs: [{ need_id: null, proposal_version: 2,
    title: 'Clarify whether a timekeeper is still needed',
    hypothesis: 'The group may still need a volunteer timekeeper for Saturday.',
    why_now: 'A direct request names the role and date.',
    exchange_ids: [supporting.id, related.id], evidence_event_ids: supporting.evidence.map(e => e.source_event_id),
    counterevidence_event_ids: [], context_event_ids: related.evidence.map(e => e.source_event_id),
    context_review: packet.exchanges.map(exchange => ({ exchange_id: exchange.id,
      classification: exchange.id === supporting.id ? 'supporting' : exchange.id === related.id ? 'related' : 'unrelated',
      evidence_event_ids: exchange.evidence.map(e => e.source_event_id),
      reason: exchange.id === supporting.id ? 'Directly states the volunteer role is needed.' :
        exchange.id === related.id ? 'Roster update is relevant context but does not say the role was filled.' :
          'Facility maintenance does not bear on the volunteer request.' })),
    next_step: 'prepare_material', reason: 'A short clarification could resolve current status.',
    unknowns: ['Whether the role has since been filled.'],
    support_quotes: refs.map(source_event_id => ({ source_event_id,
      quote: selected.flatMap(x => x.evidence).find(e => e.source_event_id === source_event_id).text })),
    material_preview: { title: 'Timekeeper status question',
      content: 'Источник asks for a volunteer timekeeper for Saturday.\nThe roster update does not establish whether that role was filled. Please confirm current status.\n',
      evidence_event_ids: supporting.evidence.map(e => e.source_event_id) }, ...overrides }] };
}

async function acceptedNeed(h, assessment, output = v2Proposal(assessment.packet)) {
  const created = await h.command('audience.propose', { assessment_id: assessment.id, output });
  const id = created.need_ids[0];
  let need = h.service.audience.need(id);
  await h.command('audience.review', { need_id: id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint, decision: 'accept',
    note: 'Reviewed the bounded request and roster context.' });
  need = h.service.audience.need(id);
  return { id, need };
}

async function readyCase(h, need) {
  const linked = await h.command('audience.open_work', { need_id: need.id,
    expected_revision: need.revision, expected_basis_fingerprint: need.basis_fingerprint });
  const turn = h.service.continuity.turn(linked.turn_id);
  await h.command('continuity.review', { turn_id: turn.id,
    expected_basis_fingerprint: turn.basis_fingerprint, decision: 'accept',
    note: 'Reviewed this bounded interpretation.' });
  const current = h.service.continuity.detail(linked.thread_id);
  const opened = await h.command('work.open', { thread_id: linked.thread_id,
    expected_basis_fingerprint: current.basis_fingerprint, title: 'Prepare a status question' });
  return { linked, case_id: opened.case_id };
}

test('source publication, source edit, and local observation clocks remain separate', async t => {
  const h = audienceHarness(t), goal = await h.open({ source_ids: [SOURCE] });
  const sourceTime = { created_at: '2026-01-02T03:04:05.000Z',
    updated_at: '2026-01-04T06:07:08.000Z' };
  const result = await h.command('source.ingest', { source_id: SOURCE, source_kind: 'sanitized_fixture',
    message_id: 'dated-question', author_id: `author:${SOURCE}`, display_name: null, thread_id: null,
    reply_to_id: null, version: 1, operation: 'upsert', text: 'How can I volunteer?',
    ...sourceTime },
    'dated-source-ingest', { kind: 'channel', sourceId: SOURCE });
  h.service.audience.reconcile({ limit: 10 });
  const captured = await h.capture(goal.goal_id), assessment = h.service.audience.assessment(captured.assessment_id);
  const dated = assessment.packet.exchanges.find(x => x.evidence.some(e => e.source_event_id === result.source_event_id)).evidence[0];
  assert.equal(dated.published_at, sourceTime.created_at);
  assert.equal(dated.source_updated_at, sourceTime.updated_at);
  assert.ok(Date.parse(dated.observed_at) > Date.parse(dated.source_updated_at),
    'local observation is later than source publication and edit time');
});

test('version 2 proposal accounts for both supplied root exchanges and keeps context in its basis', async t => {
  const h = audienceHarness(t), { assessment, packet } = await packetWithRoots(h);
  const output = v2Proposal(packet);
  const created = await h.command('audience.propose', { assessment_id: assessment.id, output });
  const need = h.service.audience.need(created.need_ids[0]);
  assert.equal(need.proposal_version, 2);
  assert.equal(need.context_review.length, packet.exchanges.length);
  assert.equal(new Set(need.context_review.map(x => x.exchange_id)).size, packet.exchanges.length);
  assert.deepEqual(new Set(need.context_review.map(x => x.exchange_id)), new Set(packet.exchanges.map(x => x.id)));
  assert.deepEqual(new Set(need.exchange_ids), new Set(output.needs[0].exchange_ids),
    'supporting and selected related exchanges are both in the durable selected basis');
  assert.deepEqual(need.context_event_ids, output.needs[0].context_event_ids);
  assert.deepEqual(new Set(need.preview_basis_event_ids), new Set([
    ...need.evidence_event_ids, ...need.counterevidence_event_ids, ...need.context_event_ids]),
  'server-computed preview basis covers selected support, counterevidence, and context');
  assert.match(need.preview_sha256, /^[a-f0-9]{64}$/);
  assert.equal(need.preview_sha256, createHash('sha256').update(output.needs[0].material_preview.content, 'utf8').digest('hex'));
});

test('missing, duplicated, invented, and out-of-packet context references are refused atomically', async t => {
  const h = audienceHarness(t), { assessment, packet } = await packetWithRoots(h);
  const valid = v2Proposal(packet);
  const missing = structuredClone(valid);
  delete missing.needs[0].context_review;
  await assert.rejects(h.command('audience.propose', { assessment_id: assessment.id, output: missing }),
    error => error.code === 'AUDIENCE_PROPOSAL_INVALID', 'incomplete coverage fails structural validation');
  const cases = [
    v2Proposal(packet, { context_review: [...valid.needs[0].context_review, valid.needs[0].context_review[0]] }),
    v2Proposal(packet, { context_review: valid.needs[0].context_review.map((x, i) => i ? x : { ...x, exchange_id: 'invented-exchange' }) }),
    v2Proposal(packet, { context_event_ids: ['999999999'] }),
    v2Proposal(packet, { context_review: valid.needs[0].context_review.map(x => ({ ...x,
      evidence_event_ids: ['999999999'] })) }),
  ];
  for (const output of cases)
    await assert.rejects(h.command('audience.propose', { assessment_id: assessment.id, output }),
      error => error.code !== 'AUDIENCE_PROPOSAL_INVALID',
      'well-shaped but out-of-scope or duplicate references fail a domain scope check, not only schema validation');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 0);
});

test('edited selected context blocks the accepted need and its work before and after restart', async t => {
  const h = audienceHarness(t), { assessment } = await packetWithRoots(h);
  const { id, need } = await acceptedNeed(h, assessment);
  await h.command('audience.open_work', { need_id: id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint });
  await h.ingest({ message_id: 'roster-update', version: 2,
    text: 'The timekeeper role has now been filled.' });
  assert.equal(h.service.audience.need(id).current, false, 'selected context edit blocks immediately');
  h.restart();
  assert.equal(h.service.audience.need(id).current, false, 'restart cannot restore stale selected context');
});

test('unrelated leaf media is disclosed but does not become a selected dependency', async t => {
  const h = audienceHarness(t), { assessment } = await packetWithRoots(h);
  const output = v2Proposal(assessment.packet);
  const before = h.service.audience.need((await h.command('audience.propose', { assessment_id: assessment.id, output })).need_ids[0]);
  await h.command('audience.review', { need_id: before.id, expected_revision: before.revision,
    expected_basis_fingerprint: before.basis_fingerprint, decision: 'accept',
    note: 'Reviewed the request and bounded context.' });
  assert.equal(before.context_event_ids.length, 1);
  assert.equal(before.current, true);
  await h.ingest({ message_id: 'unrelated-announcement', version: 2,
    text: 'The hall entrance repainting was postponed.' });
  let updated = h.service.audience.need(before.id);
  assert.equal(updated.status, 'accepted', 'unrelated source backlog is a temporary hold, not terminal staleness');
  assert.equal(updated.current, false, 'the projector temporarily withholds currentness while catching up');
  h.service.audience.reconcile({ limit: 10 });
  updated = h.service.audience.need(before.id);
  assert.equal(updated.current, true, 'after catch-up, an unrelated edit does not poison selected dependencies');
});

test('a mixed support and counterevidence exchange may be classified as counterevidence', async t => {
  const h = audienceHarness(t), goal = await h.open({ source_ids: [SOURCE] });
  await h.ingest({ message_id: 'mixed-request', text: 'We need a volunteer timekeeper for Saturday.' });
  await h.ingest({ message_id: 'mixed-reply', reply_to_id: 'mixed-request',
    text: 'Alex may already have accepted that role.' });
  await h.ingest({ message_id: 'mixed-roster', text: 'The volunteer roster was updated today.' });
  await h.ingest({ message_id: 'mixed-unrelated', text: 'The hall entrance will be repainted next month.' });
  h.service.audience.reconcile({ limit: 20 });
  const captured = await h.capture(goal.goal_id), assessment = h.service.audience.assessment(captured.assessment_id);
  const exchange = assessment.packet.exchanges.find(x => x.evidence.some(e => e.text.includes('Alex may')));
  const roster = assessment.packet.exchanges.find(x => x.evidence.some(e => e.text.includes('roster')));
  const unrelated = assessment.packet.exchanges.find(x => x.evidence.some(e => e.text.includes('repainted')));
  const positive = exchange.evidence.find(e => e.text.includes('We need'));
  const counter = exchange.evidence.find(e => e.text.includes('Alex may'));
  const context = roster.evidence[0];
  const allSelectedRefs = [positive, counter, context].map(e => e.source_event_id);
  const output = { needs: [{ proposal_version: 2, need_id: null,
    title: 'Check whether the timekeeper role is filled',
    hypothesis: 'The group may have filled a role it recently asked volunteers to cover.',
    why_now: 'The request and a later reply leave current status unclear.',
    exchange_ids: [exchange.id, roster.id], evidence_event_ids: [positive.source_event_id],
    counterevidence_event_ids: [counter.source_event_id], context_event_ids: [context.source_event_id],
    context_review: assessment.packet.exchanges.map(x => ({ exchange_id: x.id,
      classification: x.id === exchange.id ? 'counterevidence' : x.id === roster.id ? 'related' : 'unrelated',
      evidence_event_ids: x.evidence.map(e => e.source_event_id), reason: 'Accounted for with exact source references.' })),
    next_step: 'prepare_material', reason: 'Ask for current status before proposing next steps.',
    unknowns: ['Whether Alex accepted.'],
    support_quotes: allSelectedRefs.map(source_event_id => ({ source_event_id,
      quote: [positive, counter, context].find(e => e.source_event_id === source_event_id).text })),
    material_preview: { title: 'Confirm volunteer status', content: 'The request names a volunteer timekeeper.\nA later reply says Alex may have accepted.\nPlease confirm the current status.\n',
      evidence_event_ids: [positive.source_event_id] } }] };
  const created = await h.command('audience.propose', { assessment_id: assessment.id, output });
  const need = h.service.audience.need(created.need_ids[0]);
  assert.deepEqual(need.counterevidence_event_ids, [counter.source_event_id]);
  assert.equal(need.context_event_ids.includes(unrelated.evidence[0].source_event_id), false);
});

test('deleting selected context or revoking its source cannot restore an accepted need', async t => {
  const deleted = audienceHarness(t), seeded = await packetWithRoots(deleted);
  const { id: deletedId, need: deletedNeed } = await acceptedNeed(deleted, seeded.assessment);
  await deleted.command('audience.open_work', { need_id: deletedId, expected_revision: deletedNeed.revision,
    expected_basis_fingerprint: deletedNeed.basis_fingerprint });
  await deleted.ingest({ message_id: 'roster-update', version: 2, operation: 'delete', text: null });
  assert.equal(deleted.service.audience.need(deletedId).current, false);
  deleted.restart();
  assert.equal(deleted.service.audience.need(deletedId).current, false);

  const revoked = audienceHarness(t), revokeSeed = await packetWithRoots(revoked);
  const { id: revokedId, need: revokedNeed } = await acceptedNeed(revoked, revokeSeed.assessment);
  revoked.config.opportunity.allowedSourceRefs = [];
  revoked.service.audience.reconcile({ limit: 10 });
  revoked.config.opportunity.allowedSourceRefs = [SOURCE, 'public:audience-fixture-b'];
  revoked.restart();
  assert.equal(revoked.service.audience.need(revokedId).current, false,
    're-allowing the same source after revocation does not recover old selected evidence');
});

test('a preview cannot cross into a Work case linked to another Audience need', async t => {
  const h = audienceHarness(t), { assessment, packet } = await packetWithRoots(h);
  const primary = v2Proposal(packet).needs[0];
  const unrelated = packet.exchanges.find(x => x.evidence.some(e => e.text.includes('repainted')));
  const unrelatedRefs = unrelated.evidence.map(e => e.source_event_id);
  const secondary = { proposal_version: 2, need_id: null,
    title: 'Clarify the hall maintenance schedule',
    hypothesis: 'The entrance repainting schedule may need confirmation.',
    why_now: 'A source announced future repainting without a specific start date.',
    exchange_ids: [unrelated.id], evidence_event_ids: unrelatedRefs, counterevidence_event_ids: [],
    context_event_ids: [], context_review: packet.exchanges.map(exchange => ({ exchange_id: exchange.id,
      classification: exchange.id === unrelated.id ? 'supporting' : 'unrelated',
      evidence_event_ids: exchange.evidence.map(e => e.source_event_id), reason: 'Accounted for within this packet.' })),
    next_step: 'prepare_material', reason: 'Ask for a schedule clarification.', unknowns: ['Exact repainting date.'],
    support_quotes: unrelated.evidence.map(e => ({ source_event_id: e.source_event_id, quote: e.text })),
    material_preview: { title: 'Confirm hall maintenance date', content: 'A source mentions entrance repainting next month.\nPlease confirm the planned date.\n',
      evidence_event_ids: unrelatedRefs } };
  const created = await h.command('audience.propose', { assessment_id: assessment.id,
    output: { needs: [primary, secondary] } });
  const needs = created.need_ids.map(id => h.service.audience.need(id));
  const cases = [];
  for (const need of needs) {
    await h.command('audience.review', { need_id: need.id, expected_revision: need.revision,
      expected_basis_fingerprint: need.basis_fingerprint, decision: 'accept', note: 'Reviewed the bounded need.' });
    const accepted = h.service.audience.need(need.id);
    cases.push(await readyCase(h, accepted));
  }
  const first = h.service.audience.need(needs[0].id), foreignCase = h.service.work.detail(cases[1].case_id);
  await assert.rejects(h.command('audience.import_preview', { need_id: first.id,
    expected_revision: first.revision, expected_basis_fingerprint: first.basis_fingerprint,
    case_id: foreignCase.id, expected_case_revision: foreignCase.revision,
    expected_preview_sha256: first.preview_sha256 }));
  assert.equal(h.store.get('SELECT COUNT(*) n FROM work_materials WHERE case_id=?', foreignCase.id).n, 0,
    'cross-need refusal creates no material');
});

test('persisted preview edits fail closed against the immutable assessment output', async t => {
  const h = audienceHarness(t), { assessment, packet } = await packetWithRoots(h);
  const created = await h.command('audience.propose', { assessment_id: assessment.id,
    output: v2Proposal(packet) });
  const id = created.need_ids[0];
  const row = h.store.get('SELECT output_json FROM audience_needs WHERE id=?', id);
  const tampered = JSON.parse(row.output_json);
  tampered.material_preview.content += 'Unreviewed change.';
  h.store.run('UPDATE audience_needs SET output_json=? WHERE id=?', JSON.stringify(tampered), id);
  assert.throws(() => h.service.audience.need(id), { code: 'AUDIENCE_RECORD_INVALID' });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM work_materials').n, 0,
    'tampering does not produce imported Work material');
});

test('preview citation subsets are safe while outside references, oversize content, and authority fields are rejected', async t => {
  const h = audienceHarness(t), { assessment, packet } = await packetWithRoots(h);
  const valid = v2Proposal(packet);
  const basePreview = valid.needs[0].material_preview;
  const unrelatedRef = packet.exchanges.find(x => x.evidence.some(e => e.text.includes('repainted'))).evidence[0].source_event_id;
  const cases = [
    { output: v2Proposal(packet, { material_preview: { ...basePreview, evidence_event_ids: ['999999999'] } }),
      code: 'AUDIENCE_PREVIEW_SCOPE' },
    { output: v2Proposal(packet, { material_preview: { ...basePreview, evidence_event_ids: [unrelatedRef] } }),
      code: 'AUDIENCE_PREVIEW_SCOPE' },
    { output: v2Proposal(packet, { material_preview: { ...basePreview, content: 'x'.repeat(8001) } }),
      code: 'AUDIENCE_PROPOSAL_INVALID' },
    { output: v2Proposal(packet, { material_preview: { ...basePreview, recipient_id: 'person-1' } }),
      code: 'AUDIENCE_PROPOSAL_INVALID' },
    { output: v2Proposal(packet, { material_preview: { ...basePreview, execute: true } }),
      code: 'AUDIENCE_PROPOSAL_INVALID' },
  ];
  for (const item of cases)
    await assert.rejects(h.command('audience.propose', { assessment_id: assessment.id, output: item.output }),
      { code: item.code });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 0,
    'invalid preview metadata cannot partially persist a need');
});

test('preview import needs both reviews, exact current case and preview hash, and remains an idempotent proposal', async t => {
  const h = audienceHarness(t), { assessment } = await packetWithRoots(h);
  const proposal = await h.command('audience.propose', { assessment_id: assessment.id,
    output: v2Proposal(assessment.packet) });
  const id = proposal.need_ids[0];
  let need = h.service.audience.need(id);
  const stagedPayload = { need_id: id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint, case_id: 'not-open',
    expected_case_revision: 1, expected_preview_sha256: need.preview_sha256 };
  // A valid case does not exist until both reviews have run; this early command cannot create one.
  await assert.rejects(h.command('audience.import_preview', stagedPayload));
  assert.equal(h.store.get('SELECT COUNT(*) n FROM work_cases').n, 0);
  await h.command('audience.review', { need_id: id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint, decision: 'accept',
    note: 'Reviewed the bounded request and roster context.' });
  need = h.service.audience.need(id);
  const linked = await h.command('audience.open_work', { need_id: id,
    expected_revision: need.revision, expected_basis_fingerprint: need.basis_fingerprint });
  const turn = h.service.continuity.turn(linked.turn_id);
  await assert.rejects(h.command('audience.import_preview', { ...stagedPayload,
    expected_revision: need.revision, expected_basis_fingerprint: need.basis_fingerprint }));
  await h.command('continuity.review', { turn_id: turn.id,
    expected_basis_fingerprint: turn.basis_fingerprint, decision: 'accept',
    note: 'Reviewed this bounded interpretation.' });
  const ready = h.service.continuity.detail(linked.thread_id);
  const opened = await h.command('work.open', { thread_id: linked.thread_id,
    expected_basis_fingerprint: ready.basis_fingerprint, title: 'Prepare a status question' });
  const case_id = opened.case_id;
  const currentNeed = h.service.audience.need(id), work = h.service.work.detail(case_id);
  const selectedRefs = [...currentNeed.evidence_event_ids, ...currentNeed.counterevidence_event_ids, ...currentNeed.context_event_ids];
  const continuity = h.service.continuity.detail(linked.thread_id);
  assert.ok(continuity.memory.content.hypotheses.some(hypothesis =>
    currentNeed.context_event_ids.every(ref => hypothesis.context_event_ids?.includes(ref))),
  'accepted Continuity interpretation preserves selected context references');
  const workPacket = h.service.work.packet(h.service.work.get(case_id));
  assert.ok(selectedRefs.every(ref => workPacket.evidence.some(e => e.source_event_id === ref)),
    'the current Work packet carries all selected support, counterevidence, and context events');
  const payload = { need_id: id, expected_revision: currentNeed.revision,
    expected_basis_fingerprint: currentNeed.basis_fingerprint, case_id,
    expected_case_revision: work.revision, expected_preview_sha256: currentNeed.preview_sha256 };
  const request = '9d1fe3db-18d2-44bd-9ae0-ece58f800001';
  await assert.rejects(h.command('audience.import_preview', payload, request, { kind: 'agent' }), { status: 403 });
  await assert.rejects(h.command('audience.import_preview', { ...payload, expected_preview_sha256: '0'.repeat(64) }));
  await assert.rejects(h.command('audience.import_preview', { ...payload, expected_case_revision: work.revision + 1 }));
  await assert.rejects(h.command('audience.import_preview', { ...payload, case_id: 'another-partner-case' }));
  const imported = await h.command('audience.import_preview', payload, request);
  assert.ok(imported.material_id);
  assert.equal(h.service.work.detail(case_id).material.content, currentNeed.material_preview.content);
  assert.deepEqual(new Set(h.service.work.detail(case_id).material.evidence_event_ids), new Set(currentNeed.preview_basis_event_ids),
    'import uses the full server-computed basis even though model citations list support only');
  assert.equal(h.service.work.detail(case_id).material.status, 'proposed');
  await assert.rejects(h.command('audience.import_preview', payload, request, { kind: 'agent' }), { status: 403 },
    'a prior operator receipt cannot be replayed under an agent actor');
  const ownReceiptReplay = await h.command('audience.import_preview', payload, request);
  assert.equal(ownReceiptReplay.material_id, imported.material_id,
    'the same operator can safely replay its import while all current-state checks still pass');
  let currentWork = h.service.work.detail(case_id);
  const currentPayload = { ...payload, expected_case_revision: currentWork.revision };
  const again = await h.command('audience.import_preview', currentPayload, '9d1fe3db-18d2-44bd-9ae0-ece58f800002');
  assert.equal(again.material_id, imported.material_id, 'same need revision and preview reuse the durable material');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM work_materials WHERE case_id=?', case_id).n, 1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM persons').n, 0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM drafts').n, 0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM delivery_attempts').n, 0);
  h.restart();
  h.service.audience.reconcile({ limit: 10 });
  h.service.continuity.reconcile({ limit: 20 });
  currentWork = h.service.work.detail(case_id);
  const restartedPayload = { ...payload, expected_case_revision: currentWork.revision };
  const afterRestart = await h.command('audience.import_preview', restartedPayload, '9d1fe3db-18d2-44bd-9ae0-ece58f800003');
  assert.equal(afterRestart.material_id, imported.material_id);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM work_materials WHERE case_id=?', case_id).n, 1,
    'restart and a current duplicate request reuse the same durable material');
  let current = h.service.work.detail(case_id);
  await h.command('work.review', { case_id, expected_revision: current.revision,
    material_id: current.material.id, sha256: current.material.sha256, decision: 'approve',
    note: 'Reviewed exact bounded preview bytes.' });
  current = h.service.work.detail(case_id);
  h.config.actions.enabled = true; // Local test-only activation for a proposed Action; no grant or execution.
  const actionProposal = await h.command('work.prepare_action', { case_id, expected_revision: current.revision,
    material_id: current.material.id, capability_id: 'material.export_local.v1' });
  const action = h.service.actions.detail(actionProposal.action_id);
  assert.ok(selectedRefs.every(ref => action.packet.evidence.some(e => e.source_event_id === ref)),
    'the proposed local Action carries selected context evidence through accepted Continuity memory');
  assert.equal(action.status, 'proposed', 'evidence inclusion does not grant or execute an Action');
  await h.ingest({ message_id: 'roster-update', version: 2,
    text: 'The timekeeper role has now been filled.' });
  assert.equal(h.service.audience.need(id).current, false);
  await assert.rejects(h.command('audience.import_preview', restartedPayload, '9d1fe3db-18d2-44bd-9ae0-ece58f800003'));
  h.restart();
  await assert.rejects(h.command('audience.import_preview', restartedPayload));
});
