import test from 'node:test';
import assert from 'node:assert/strict';
import { id } from '../business/store.mjs';
import { digest } from '../business/source-ingestion.mjs';
import { contextFor } from '../business/context.mjs';
import { SOURCE, workspaceHarness } from './helpers/workspace-harness.mjs';

const SOURCE_TEXT = Array.from({ length: 28 }, (_, i) => `Germany fixture item ${String(i + 1).padStart(2, '0')}: listed package details vary.`).join('\n');

async function fixture(t, count = 1) {
  const h = workspaceHarness(t);
  h.config.engagement.enabled = true;
  h.ingest = function (extra = {}) {
    return this.command('source.ingest', { source_id: SOURCE, source_kind: 'sanitized_fixture',
      message_id: 'de-fixture-1', author_id: 'fixture-publisher', display_name: 'Fixture publisher',
      thread_id: null, reply_to_id: null, version: 1, operation: 'upsert', text: SOURCE_TEXT,
      created_at: '2026-10-14T00:00:00Z', updated_at: '2026-10-14T00:00:00Z', ...extra }, id(),
    { kind: 'channel', sourceId: SOURCE });
  };
  const caseId = await h.ready();
  const content = `# Germany fixture\n\n${SOURCE_TEXT}\n\nReviewed interpretation, not a verified fact.`;
  const proposed = await h.material(caseId, content);
  await h.approve(caseId, proposed.material_id);
  const material = h.service.work.detail(caseId).material;
  const engagements = [];
  for (let i = 0; i < count; i++) {
    const person = await h.command('person.create', { name: `Synthetic recipient ${i}`, source: 'offline kill test',
      channel: 'telegram', external_id: String(71000 + i), account_id: 'fixture-bot' });
    const inbound = await h.command('message.record', { conversation_id: person.conversation_id,
      text: `What are the mandatory startup costs in Germany? ${i}`, external_id: `question-${i}-${id()}`, source: 'synthetic-test' });
    engagements.push({ conversationId: person.conversation_id,
      engagementId: h.service.engagement.current(person.conversation_id).id, questionMessageId: inbound.message_id });
  }
  h.service.setTelegramAccount('fixture-bot');
  return { h, caseId, materialId: proposed.material_id, materialHash: material.sha256, engagements };
}

async function attach(h, f, engagement, excerpt, expires = Date.now() + 3600000) {
  return h.command('reference.attach', {
    engagement_id: engagement.engagementId,
    expected_revision: h.service.engagement.get(engagement.engagementId).revision,
    material_id: f.materialId, material_sha256: f.materialHash,
    question_message_id: engagement.questionMessageId,
    offer_id: h.config.opportunity.activeOffer.id, market: 'DE', excerpt,
    expires_at: new Date(expires).toISOString(), note: 'Scoped offline kill fixture',
  });
}

async function actRuntime(t, f, engagement, referenceId, { runBody } = {}) {
  const { h } = f;
  await h.command('permission.grant', { conversation_id: engagement.conversationId, purpose: 'reply',
    granted_by: 'synthetic recipient', evidence: 'Offline explicit reply request',
    valid_from: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString() });
  h.config.runtime.enabled = true; h.config.runtime.model = 'offline-reference-fixture';
  h.config.runtime.baseUrl = 'https://example.invalid';
  const oldKey = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'offline-reference-fixture';
  t.after(() => { if (oldKey === undefined) delete process.env.PARTNER_MODEL_API_KEY; else process.env.PARTNER_MODEL_API_KEY = oldKey; });
  h.service.control.acquireProcess(); h.beforeCleanup.push(() => h.service.control.close());
  let decision;
  h.scheduler.runtime = { async run(run, context) {
    assert.equal(context.reviewed_references.items.some(item => item.reference_id === referenceId), true);
    if (runBody) return runBody(run, context);
    const ticketId = h.service.control.scope.getStore().id;
    decision = await h.command('decision.commit', {
      engagement_id: engagement.engagementId,
      expected_revision: h.service.engagement.get(engagement.engagementId).revision,
      kind: 'ACT', reason: 'Use the scoped reviewed interpretation for this question',
      expected_next: 'Operator reviews the pending draft',
      evidence: [{ type: 'reference', id: referenceId }],
      action: { purpose: 'reply', text: 'The reviewed Germany fixture says listed package details vary.', explained: [], commitments: [] },
    }, id(), { kind: 'agent', runId: run.id, conversationId: engagement.conversationId, controlTicketId: ticketId });
    return { completed: true, usage: { input_tokens: 17, output_tokens: 11, cost_status: 'unknown' } };
  }, close() {} };
  return { h, get decision() { return decision; }, tick: () => h.scheduler.privateTick() };
}

test('held private completion after source edit fails its frozen basis, accounts usage, and cannot resurrect on source retry', async t => {
  const f = await fixture(t), { h, engagements: [e] } = f;
  const { reference_id: refId } = await attach(h, f, e, 'Germany fixture item 01: listed package details vary.');
  let began;
  const started = new Promise(resolve => { began = resolve; });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let committed;
  const runtime = await actRuntime(t, f, e, refId, { runBody: async run => {
    const runId = run.id;
    const ticketId = h.service.control.scope.getStore().id;
    committed = await h.command('decision.commit', {
      engagement_id: e.engagementId,
      expected_revision: h.service.engagement.get(e.engagementId).revision,
      kind: 'ACT', reason: 'A valid reference-backed proposal is committed before the source changes',
      expected_next: 'Operator reviews the pending draft', evidence: [{ type: 'reference', id: refId }],
      action: { purpose: 'reply', text: 'The reviewed Germany fixture says listed package details vary.', explained: [], commitments: [] },
    }, id(), { kind: 'agent', runId, conversationId: e.conversationId, controlTicketId: ticketId });
    assert.equal(h.service.engagement.decision(committed.decision_id).status, 'current');
    assert.equal(h.service.draft(committed.draft_id).status, 'pending');
    began(); await held;
    return { completed: true, usage: { input_tokens: 41, output_tokens: 13, cost_status: 'unknown' } };
  } });
  const ticking = runtime.tick();
  await started;
  await h.ingest({ version: 2, text: 'A corrected source version supersedes every quoted condition.' });
  release(); await ticking;
  const run = h.store.get('SELECT * FROM runs ORDER BY created_at DESC LIMIT 1');
  assert.equal(run.status, 'cancelled');
  assert.equal(run.error, 'REFERENCE_BASIS_CHANGED');
  assert.equal(run.input_tokens, 41); assert.equal(run.output_tokens, 13);
  assert.equal(run.cost_status, 'unknown');
  assert.equal(h.store.get('SELECT status FROM engagement_decisions WHERE id=?', committed.decision_id).status, 'stale');
  assert.equal(h.store.get('SELECT status FROM drafts WHERE id=?', committed.draft_id).status, 'stale');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM approvals').n, 0);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM messages WHERE direction='out'").n, 0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM delivery_attempts').n, 0);
  await h.ingest({ version: 3, text: SOURCE_TEXT });
  await h.service.references.reconcile({ limit: 5 });
  assert.equal(h.service.references.context(e.engagementId).items.length, 0);
  assert.ok(h.service.references.context(e.engagementId).unavailable.some(row => row.id === refId));
});

test('expiry after draft approval denies before transport and a fresh reference cannot revive the old draft', async t => {
  const f = await fixture(t), { h, engagements: [e] } = f;
  const { reference_id: refId } = await attach(h, f, e, 'Germany fixture item 01: listed package details vary.', Date.now() + 2200);
  const runtime = await actRuntime(t, f, e, refId);
  await runtime.tick();
  const draftId = runtime.decision.draft_id;
  await h.command('draft.approve', { draft_id: draftId });
  h.config.telegram.enabled = true; h.config.telegram.liveSending = true;
  h.config.telegram.allowedChatIds = ['71000'];
  const { TelegramChannel } = await import('../business/channels/telegram.mjs');
  const channel = new TelegramChannel(h.service); let transports = 0;
  channel.api = async () => { transports++; return { message_id: 9001 }; };
  await new Promise(resolve => setTimeout(resolve, 2400));
  await assert.rejects(channel.sendApproved(draftId), error => error.code === 'REFERENCE_EXPIRED');
  assert.equal(h.service.draft(draftId).status, 'approved');
  assert.equal(transports, 0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM delivery_attempts').n, 0);
  await attach(h, f, e, 'Germany fixture item 02: listed package details vary.');
  assert.equal(h.service.draft(draftId).status, 'stale');
  await assert.rejects(channel.sendApproved(draftId), error => error.message === 'Нет действующего одобрения');
  assert.equal(transports, 0);
});

test('revocation invalidates an approved draft before transport and permission regrant does not revive it', async t => {
  const f = await fixture(t), { h, engagements: [e] } = f;
  const { reference_id: refId } = await attach(h, f, e, 'Germany fixture item 01: listed package details vary.');
  const runtime = await actRuntime(t, f, e, refId);
  await runtime.tick(); const draftId = runtime.decision.draft_id;
  await h.command('draft.approve', { draft_id: draftId });
  h.config.telegram.enabled = true; h.config.telegram.liveSending = true; h.config.telegram.allowedChatIds = ['71000'];
  const { TelegramChannel } = await import('../business/channels/telegram.mjs');
  const channel = new TelegramChannel(h.service); let transports = 0;
  channel.api = async () => { transports++; return { message_id: 9002 }; };
  await h.command('reference.revoke', { engagement_id: e.engagementId,
    expected_revision: h.service.engagement.get(e.engagementId).revision, reference_id: refId, reason: 'Withdrawn in fixture' });
  await h.command('permission.grant', { conversation_id: e.conversationId, purpose: 'reply',
    granted_by: 'synthetic recipient', evidence: 'Permission is separate from reference validity',
    valid_from: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString() });
  await assert.rejects(channel.sendApproved(draftId));
  assert.equal(h.service.draft(draftId).status, 'stale');
  assert.equal(transports, 0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM delivery_attempts').n, 0);
});

test('malformed packet is isolated to one unavailable reference while its healthy neighbor remains readable', async t => {
  const f = await fixture(t), { h, engagements: [e] } = f;
  const a = await attach(h, f, e, 'Germany fixture item 01: listed package details vary.');
  const b = await attach(h, f, e, 'Germany fixture item 02: listed package details vary.');
  const row = h.store.get('SELECT * FROM engagement_references WHERE id=?', a.reference_id);
  const packet = JSON.parse(row.packet_json); packet.observed_at = null;
  h.store.run('UPDATE engagement_references SET packet_json=?,packet_sha256=? WHERE id=?', JSON.stringify(packet), digest(packet), a.reference_id);
  const context = h.service.references.context(e.engagementId);
  assert.deepEqual(context.items.map(item => item.reference_id), [b.reference_id]);
  assert.ok(context.unavailable.some(item => item.id === a.reference_id && item.reason === 'REFERENCE_RECORD_INVALID'));
});

test('stale reference cannot remain in belief evidence or counterevidence; reconcile retires dependents without hiding an unrelated claim', async t => {
  const f = await fixture(t), { h, engagements: [e] } = f;
  const olderMessage = await h.command('message.record', { conversation_id: e.conversationId,
    text: 'I run a small agency.', external_id: `background-${id()}`, source: 'synthetic-test' });
  const claimText = 'I run a small agency.';
  await h.command('belief.record', { engagement_id: e.engagementId,
    expected_revision: h.service.engagement.get(e.engagementId).revision, kind: 'CLAIM', text: claimText,
    evidence: [{ type: 'message', id: olderMessage.message_id }] });
  const latestQuestion = await h.command('message.record', { conversation_id: e.conversationId,
    text: 'What are the mandatory startup costs in Germany?', external_id: `costs-${id()}`, source: 'synthetic-test' });
  e.questionMessageId = latestQuestion.message_id;
  const { reference_id: refId } = await attach(h, f, e, 'Germany fixture item 01: listed package details vary.');
  const directBelief = await h.command('belief.record', { engagement_id: e.engagementId,
    expected_revision: h.service.engagement.get(e.engagementId).revision, kind: 'HYPOTHESIS',
    text: 'Reference-backed hypothesis must disappear after its source changes.', evidence: [{ type: 'reference', id: refId }] });
  const counterBelief = await h.command('belief.record', { engagement_id: e.engagementId,
    expected_revision: h.service.engagement.get(e.engagementId).revision, kind: 'HYPOTHESIS',
    text: 'A reference used as counterevidence is also a dependency.',
    evidence: [{ type: 'message', id: olderMessage.message_id }], counterevidence: [{ type: 'reference', id: refId }] });
  const before = contextFor(h.service, e.conversationId).engagement.beliefs;
  assert.ok(before.some(belief => belief.id === directBelief.belief_id));
  assert.ok(before.some(belief => belief.id === counterBelief.belief_id));
  assert.ok(before.some(belief => belief.kind === 'CLAIM' && belief.text === claimText));

  await h.ingest({ version: 2, text: 'A corrected source version supersedes every quoted condition.' });
  const afterEdit = contextFor(h.service, e.conversationId).engagement.beliefs;
  assert.equal(afterEdit.some(belief => belief.id === directBelief.belief_id || belief.id === counterBelief.belief_id), false,
    'snapshot must not expose beliefs whose reference evidence is no longer current');
  assert.equal(afterEdit.some(belief => belief.kind === 'CLAIM' && belief.text === claimText), true,
    'unrelated message-backed claim remains available');
  assert.equal(JSON.stringify(afterEdit).includes('Reference-backed hypothesis must disappear'), false);

  h.service.references.reconcile({ limit: 10 });
  for (const beliefId of [directBelief.belief_id, counterBelief.belief_id])
    assert.equal(h.store.get('SELECT status FROM engagement_beliefs WHERE id=?', beliefId).status, 'stale',
      'durable belief status must record the invalidated reference dependency');
  const reconciled = contextFor(h.service, e.conversationId).engagement.beliefs;
  assert.equal(reconciled.some(belief => belief.id === directBelief.belief_id || belief.id === counterBelief.belief_id), false);
  assert.equal(reconciled.some(belief => belief.kind === 'CLAIM' && belief.text === claimText), true);
});

test('older live grant survives terminal history and four expired attachments stop consuming capacity', async t => {
  const f = await fixture(t), { h, engagements: [e] } = f;
  const original = await attach(h, f, e, 'Germany fixture item 01: listed package details vary.');
  for (let i = 2; i <= 22; i++) {
    const attached = await attach(h, f, e, `Germany fixture item ${String(i).padStart(2, '0')}: listed package details vary.`);
    await h.command('reference.revoke', { engagement_id: e.engagementId,
      expected_revision: h.service.engagement.get(e.engagementId).revision, reference_id: attached.reference_id, reason: `Terminal fixture ${i}` });
  }
  assert.ok(h.service.references.context(e.engagementId).items.some(item => item.reference_id === original.reference_id));
  for (let i = 23; i <= 25; i++) await attach(h, f, e, `Germany fixture item ${String(i).padStart(2, '0')}: listed package details vary.`);
  await assert.rejects(attach(h, f, e, 'Germany fixture item 26: listed package details vary.'), { code: 'REFERENCE_CAPACITY' });

  const expired = await fixture(t);
  for (let i = 1; i <= 4; i++) await attach(expired.h, expired, expired.engagements[0],
    `Germany fixture item ${String(i).padStart(2, '0')}: listed package details vary.`, Date.now() + 1200);
  await new Promise(resolve => setTimeout(resolve, 1400));
  await attach(expired.h, expired, expired.engagements[0], 'Germany fixture item 05: listed package details vary.');
  assert.equal(expired.h.service.references.context(expired.engagements[0].engagementId).items.length, 1);
});

test('source health gap retires a grant permanently; reconcile cursor reaches old references across pages', async t => {
  const f = await fixture(t, 23), { h, engagements } = f;
  const refs = [];
  for (const e of engagements) refs.push(await attach(h, f, e, 'Germany fixture item 01: listed package details vary.'));
  h.config.opportunity.allowedSourceRefs = [];
  assert.equal(h.service.references.context(engagements[0].engagementId).items.length, 0);
  let checked = 0;
  for (let i = 0; i < 8; i++) checked += h.service.references.reconcile({ limit: 3 }).checked;
  assert.ok(checked >= refs.length);
  h.config.opportunity.allowedSourceRefs = [SOURCE];
  for (let i = 0; i < refs.length; i++) {
    const row = h.store.get('SELECT status FROM engagement_references WHERE id=?', refs[i].reference_id);
    assert.notEqual(row.status, 'active', `reference ${i} was skipped by cursor reconciliation`);
    assert.equal(h.service.references.context(engagements[i].engagementId).items.length, 0);
  }
});

test('restart with default-off authority preserves reference history but does not activate it', async t => {
  const f = await fixture(t), { h, engagements: [e] } = f;
  const { reference_id: refId } = await attach(h, f, e, 'Germany fixture item 01: listed package details vary.');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 0);
  h.config.controlPlane.enabled = false;
  h.config.runtime.enabled = false; h.config.scheduler.enabled = false; h.config.engagement.enabled = false;
  h.restart();
  assert.equal(h.store.get('SELECT status FROM engagement_references WHERE id=?', refId).status, 'active');
  const hidden = h.service.references.context(e.engagementId);
  assert.equal(hidden.items.length, 0);
  assert.ok(hidden.unavailable.some(item => item.id === refId && item.reason === 'REFERENCE_DISABLED'));
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM delivery_attempts').n, 0);
});
