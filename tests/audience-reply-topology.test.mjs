import test from 'node:test';
import assert from 'node:assert/strict';
import { audienceHarness, SOURCE, SOURCE_B, proposalFrom } from './audience-test-helpers.mjs';
import { audienceModelPacket } from '../business/audience-decisions.mjs';

async function readyGoal(h, sourceIds = [SOURCE]) {
  const goal = await h.open({ source_ids: sourceIds });
  h.service.audience.reconcile({ limit: 20 });
  const detail = h.service.audience.detail(goal.goal_id);
  assert.equal(detail.ready, true, 'positive control: supported source exchanges are current');
  return { goal, detail };
}

async function capture(h, goalId, detail = h.service.audience.detail(goalId)) {
  const result = await h.command('audience.capture', { goal_id: goalId,
    expected_revision: detail.revision, expected_basis_fingerprint: detail.basis_fingerprint });
  return h.service.audience.assessment(result.assessment_id);
}

function assertNoExternalEffects(h) {
  for (const table of ['persons', 'conversations', 'messages', 'drafts', 'approvals', 'delivery_attempts', 'action_attempts'])
    assert.equal(h.store.get(`SELECT COUNT(*) n FROM ${table}`).n, 0, `${table} remains empty`);
}

test('native source ingestion and model packet preserve exact reply/thread/source/event pairings across interleaved branches', async t => {
  const h = audienceHarness(t), topic = 'same-forum-topic';
  const goal = await h.open({ source_ids: [SOURCE, SOURCE_B] });
  const rows = [
    [SOURCE, 'root-a', null, 'A root'], [SOURCE, 'root-b', null, 'B root'],
    [SOURCE, 'reply-a', 'root-a', 'A reply'], [SOURCE_B, 'root-a', null, 'Other source root'],
    [SOURCE, 'reply-b', 'root-b', 'B reply']
  ];
  for (const [source_id, message_id, reply_to_id, text] of rows)
    await h.ingest({ source_id, message_id, reply_to_id, thread_id: topic, text });
  h.service.audience.reconcile({ limit: 20 });
  const detail = h.service.audience.detail(goal.goal_id);
  assert.equal(detail.exchanges.length, 3, 'two reply branches plus the same-ID event from a second source remain distinct');
  const assessment = await capture(h, goal.goal_id, detail), model = audienceModelPacket(assessment.packet);
  const observed = model.exchanges.flatMap(exchange => exchange.evidence.map(e => ({
    source_ref: exchange.source_ref, source_event_id: e.source_event_id, message_id: e.message_id,
    message_version: e.message_version, author_id: e.author_id, thread_id: e.thread_id, reply_to_id: e.reply_to_id
  })));
  const expected = assessment.packet.exchanges.flatMap(exchange => exchange.evidence.map(e => ({
    source_ref: exchange.source_ref, source_event_id: e.source_event_id, message_id: e.message_id,
    message_version: e.message_version, author_id: e.author_id, thread_id: topic,
    reply_to_id: ({ 'root-a': null, 'root-b': null, 'reply-a': 'root-a', 'reply-b': 'root-b' })[e.message_id]
  })));
  assert.deepEqual(observed, expected, 'the projection preserves each native message identity and edge together');
  assert.equal(new Set(observed.map(e => `${e.source_ref}\0${e.source_event_id}`)).size, observed.length);
  assert.ok(observed.some(e => e.source_ref === SOURCE && e.message_id === 'reply-a' && e.reply_to_id === 'root-a'));
  assert.ok(observed.some(e => e.source_ref === SOURCE && e.message_id === 'reply-b' && e.reply_to_id === 'root-b'));
  assert.ok(observed.some(e => e.source_ref === SOURCE_B && e.message_id === 'root-a' && e.reply_to_id === null));
  assertNoExternalEffects(h);
});

test('a parent found only in another source is unresolved and never borrowed into the model packet', async t => {
  const h = audienceHarness(t), goal = await h.open({ source_ids: [SOURCE, SOURCE_B] });
  await h.ingest({ source_id: SOURCE_B, message_id: 'foreign-parent', text: 'Other-source parent secret.' });
  await h.ingest({ source_id: SOURCE, message_id: 'cross-source-reply', reply_to_id: 'foreign-parent', text: 'Reply with no same-source parent.' });
  await h.ingest({ source_id: SOURCE, message_id: 'healthy-root', text: 'Independent supported message.' });
  h.service.audience.reconcile({ limit: 20 });
  const detail = h.service.audience.detail(goal.goal_id);
  const assessment = await capture(h, goal.goal_id, detail), model = audienceModelPacket(assessment.packet);
  assert.equal(model.exchanges.some(e => e.source_ref === SOURCE
    && e.evidence.some(row => row.message_id === 'foreign-parent')), false,
  'a same-ID parent in another source is not grafted into this source exchange');
  assert.equal(model.exchanges.some(e => e.evidence.some(row => row.message_id === 'cross-source-reply')), false);
  assert.ok(detail.withheld_exchanges.some(e => e.reasons.includes('AUDIENCE_ANCESTRY_INCOMPLETE')),
    'unresolved cross-source ancestry remains explicitly incomplete');
  assert.ok(model.exchanges.some(e => e.source_ref === SOURCE_B && e.evidence.some(row => row.message_id === 'foreign-parent')));
  assertNoExternalEffects(h);
});

test('editing or deleting a required parent makes the captured model assessment stale before proposal', async t => {
  for (const mutation of [{ operation: 'upsert', text: 'Edited parent.' }, { operation: 'delete', text: null }]) {
    const h = audienceHarness(t), goal = await h.open({ source_ids: [SOURCE] });
    await h.ingest({ message_id: 'edit-root', text: 'Original parent.', thread_id: 'topic' });
    await h.ingest({ message_id: 'edit-reply', reply_to_id: 'edit-root', text: 'Supported reply.', thread_id: 'topic' });
    h.service.audience.reconcile({ limit: 20 });
    const assessment = await capture(h, goal.goal_id);
    assert.equal(assessment.current, true, 'positive control: the selected reply and parent are initially current');
    await h.ingest({ message_id: 'edit-root', version: 2, operation: mutation.operation,
      text: mutation.text, thread_id: 'topic' });
    h.service.audience.reconcile({ limit: 20 });
    assert.equal(h.service.audience.assessment(assessment.id).current, false,
      `${mutation.operation} of required lineage invalidates the frozen assessment`);
    await assert.rejects(h.command('audience.propose', { assessment_id: assessment.id,
      output: proposalFrom(assessment.packet) }), { code: 'AUDIENCE_ASSESSMENT_UNAVAILABLE' });
    assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, 0);
    assertNoExternalEffects(h);
  }
});

test('an unrelated opaque leaf does not poison a supported reply branch or enter its evidence', async t => {
  const h = audienceHarness(t), goal = await h.open({ source_ids: [SOURCE] });
  await h.ingest({ message_id: 'healthy-root', text: 'Supported root.', thread_id: 'topic' });
  await h.ingest({ message_id: 'healthy-reply', reply_to_id: 'healthy-root', text: 'Supported reply.', thread_id: 'topic' });
  await h.ingest({ message_id: 'opaque-unrelated', operation: 'unsupported', text: null, thread_id: 'other-topic',
    unsupported: { reason: 'media', fingerprint: 'a'.repeat(64) } });
  h.service.audience.reconcile({ limit: 20 });
  const detail = h.service.audience.detail(goal.goal_id);
  assert.equal(detail.ready, true);
  const assessment = await capture(h, goal.goal_id, detail), model = audienceModelPacket(assessment.packet);
  const evidence = model.exchanges.flatMap(e => e.evidence);
  assert.deepEqual(evidence.map(e => e.message_id).sort(), ['healthy-reply', 'healthy-root']);
  assert.equal(JSON.stringify(model).includes('opaque-unrelated'), false);
  assertNoExternalEffects(h);
});

test('follow-up forwards native structural ancestry separately from current evidence', async t => {
  const start = new Date('2026-01-01T00:30:00.000Z');
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const oldKey = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'offline-reply-topology-sentinel-never-sent';
  t.after(() => oldKey === undefined ? delete process.env.PARTNER_MODEL_API_KEY : process.env.PARTNER_MODEL_API_KEY = oldKey);
  const h = audienceHarness(t), profileUrl = 'https://models.example.test/v1';
  Object.assign(h.config.runtime, { enabled: false, baseUrl: '', model: '', dailyBudgetUsd: 5,
    inputUsdPerMillion: null, outputUsdPerMillion: null, maxRunsPerDay: 50 });
  h.config.audience.enabled = true; h.config.audience.modelEnabled = false; h.config.audience.maxRunsPerDay = 20;
  h.config.modelProfiles = { allowedBaseUrls: [profileUrl] };
  h.config.controlPlane.enabled = true; h.config.controlPlane.maxConcurrent = 3;
  const ingestAt = (message_id, text, reply_to_id = null) => {
    const at = new Date().toISOString();
    return h.command('source.ingest', { source_id: SOURCE, source_kind: 'sanitized_fixture', message_id,
      author_id: `author:${SOURCE}`, display_name: null, thread_id: 'followup-topic', reply_to_id,
      version: 1, operation: 'upsert', text, created_at: at, updated_at: at }, undefined,
    { kind: 'channel', sourceId: SOURCE });
  };
  const goal = await h.open({ source_ids: [SOURCE], max_age_seconds: 3600 });
  await ingestAt('followup-old-anchor', 'Old structural parent text must never become current citation evidence.');
  h.service.audience.reconcile({ limit: 20 });
  const detail = h.service.audience.detail(goal.goal_id), initial = await capture(h, goal.goal_id, detail);
  const proposed = await h.command('audience.propose', { assessment_id: initial.id,
    output: proposalFrom(initial.packet) });
  let need = h.service.audience.need(proposed.need_ids[0]);
  await h.command('audience.review', { need_id: need.id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint, decision: 'accept', note: 'Accept the synthetic hypothesis.' });
  need = h.service.audience.need(need.id);

  t.mock.timers.tick(90 * 60 * 1000);
  await ingestAt('followup-current-reply', 'Fresh reply provides one current clarification.', 'followup-old-anchor');
  h.service.audience.reconcile({ limit: 20 });
  const context = h.service.followup.context(need.id);
  assert.equal(context.available, true, 'positive control: validated fresh reply can be selected');
  assert.equal(context.exchanges.length, 1);
  const exchange = context.exchanges[0];
  assert.equal(exchange.current_event_ids.length, 1);
  assert.equal(exchange.structural_event_ids.length, 1);
  const profile = await h.command('model.profile_create', { label: 'Offline reply topology fixture', provider: 'custom',
    api_mode: 'chat_completions', base_url: profileUrl, model: 'offline-model', max_output_tokens: 512,
    input_usd_per_million: 1, output_usd_per_million: 1 });
  const request = await h.command('audience.followup_request', { need_id: need.id,
    expected_revision: context.need_revision, expected_basis_fingerprint: context.need_basis_fingerprint,
    expected_context_fingerprint: context.context_fingerprint, model_profile_id: profile.profile_id,
    expected_profile_hash: profile.definition_hash, expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    reason: 'One bounded synthetic follow-up.' });
  const followup = h.service.audience.assessment(request.assessment_id);
  const model = audienceModelPacket(followup.packet), projected = model.exchanges[0];
  assert.equal(projected.evidence.length, 1);
  assert.equal(projected.evidence[0].source_event_id, exchange.current_event_ids[0]);
  assert.equal(projected.evidence[0].text, 'Fresh reply provides one current clarification.');
  assert.deepEqual(projected.structural_relations, [{ source_event_id: exchange.structural_event_ids[0],
    source_ref: SOURCE, message_id: 'followup-old-anchor', message_version: 1, thread_id: 'followup-topic',
    reply_to_id: null, structural_only: true }]);
  assert.equal(projected.structural_relations[0].source_event_id === projected.evidence[0].source_event_id, false);
  assert.equal(JSON.stringify(model).includes('Old structural parent text'), false,
    'structural lineage supplies no old text or citation authority');
  assertNoExternalEffects(h);
});
