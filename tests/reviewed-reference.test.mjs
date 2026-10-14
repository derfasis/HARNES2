import test from 'node:test';
import assert from 'node:assert/strict';
import { contextFor } from '../business/context.mjs';
import { id } from '../business/store.mjs';
import { SOURCE, workspaceHarness } from './helpers/workspace-harness.mjs';

async function managedQuestion(h) {
  // Reuse the real Continuity -> Work evidence/review path, without a model or transport.
  const sourceText = 'Germany fixture observation: listed participation costs vary by selected package.';
  h.ingest = function (extra = {}) {
    return this.command('source.ingest', { source_id: SOURCE, source_kind: 'sanitized_fixture',
      message_id: 'de-fixture-1', author_id: 'fixture-publisher', display_name: 'Fixture publisher',
      thread_id: null, reply_to_id: null, version: 1, operation: 'upsert', text: sourceText,
      created_at: '2026-10-14T00:00:00Z', updated_at: '2026-10-14T00:00:00Z', ...extra }, id(),
    { kind: 'channel', sourceId: SOURCE });
  };
  const caseId = await h.ready();
  const excerpt = sourceText;
  const proposed = await h.material(caseId, `# Germany fixture\n\n${excerpt}\n\nThis is a reviewed interpretation, not a verified fact.`);
  await h.approve(caseId, proposed.material_id);
  const person = await h.command('person.create', { name: 'Synthetic recipient', source: 'offline reviewed-reference test' });
  const inbound = await h.command('message.record', { conversation_id: person.conversation_id,
    text: 'What are the mandatory startup costs in Germany?', external_id: `question-${id()}`, source: 'synthetic-test' });
  // With managed Engagement enabled, recording the inbound opens the current episode.
  const engagement = h.service.engagement.current(person.conversation_id);
  assert.ok(engagement);
  return { caseId, excerpt, materialId: proposed.material_id, conversationId: person.conversation_id,
    questionMessageId: inbound.message_id, engagementId: engagement.id };
}

async function attach(h, fixture, overrides = {}) {
  const material = h.service.work.detail(fixture.caseId).material;
  return h.command('reference.attach', {
    engagement_id: fixture.engagementId,
    expected_revision: h.service.engagement.get(fixture.engagementId).revision,
    material_id: fixture.materialId,
    material_sha256: material.sha256,
    question_message_id: fixture.questionMessageId,
    offer_id: h.config.opportunity.activeOffer.id,
    market: 'DE',
    excerpt: fixture.excerpt,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    note: 'Scoped offline fixture review',
    ...overrides,
  }, id(), { kind: 'operator' });
}

function assertNoAuthorityEffects(h) {
  for (const table of ['contact_permissions', 'drafts', 'approvals', 'delivery_attempts', 'outcome_events'])
    assert.equal(h.store.get(`SELECT COUNT(*) n FROM ${table}`).n, 0, table);
}

test('operator can attach one exact approved source-backed Work excerpt to the current inbound question', async t => {
  const h = workspaceHarness(t);
  h.config.engagement.enabled = true;
  const fixture = await managedQuestion(h);
  const attached = await attach(h, fixture);
  assert.equal(typeof attached.reference_id, 'string');
  assertNoAuthorityEffects(h);
  const viaService = h.service.references.context(fixture.engagementId);
  const viaPrompt = contextFor(h.service, fixture.conversationId).reviewed_references;
  assert.deepEqual(viaPrompt, viaService);
  assert.equal(viaService.items.length, 1);
  assert.equal(viaService.items[0].excerpt, fixture.excerpt);
  assert.match(viaService.items[0].epistemic_status, /reviewed_interpretation_not_verified_fact/);
  assert.ok(Array.isArray(viaService.items[0].sources) && viaService.items[0].sources.length > 0);
  assert.equal(viaService.items[0].market, 'DE');
  assert.equal(viaService.items[0].question_message_id, fixture.questionMessageId);
  assert.equal(contextFor(h.service, fixture.conversationId).facts.length, 0);
});

test('managed private context provides the reviewed-reference envelope separately from person facts', async t => {
  const h = workspaceHarness(t);
  h.config.engagement.enabled = true;
  const fixture = await managedQuestion(h);
  const context = contextFor(h.service, fixture.conversationId);
  assert.ok(context.reviewed_references && Array.isArray(context.reviewed_references.items)
    && Array.isArray(context.reviewed_references.unavailable)
    && typeof context.reviewed_references.basis_fingerprint === 'string',
  'managed context must expose a bounded, freshness-bound reference envelope');
  assert.equal(context.facts.length, 0, 'research interpretation must not be promoted into person facts');
});

test('only operator can attach or revoke; invalid material hash and excerpt are atomic', async t => {
  const h = workspaceHarness(t);
  h.config.engagement.enabled = true;
  const fixture = await managedQuestion(h);
  const before = h.service.references.context(fixture.engagementId);
  const invoke = (overrides, actor = { kind: 'operator' }) => {
    const material = h.service.work.detail(fixture.caseId).material;
    return h.command('reference.attach', {
      engagement_id: fixture.engagementId,
      expected_revision: h.service.engagement.get(fixture.engagementId).revision,
      material_id: fixture.materialId,
      material_sha256: material.sha256,
      question_message_id: fixture.questionMessageId,
      offer_id: h.config.opportunity.activeOffer.id,
      market: 'DE',
      excerpt: fixture.excerpt,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      note: 'Scoped offline fixture review',
      ...overrides,
    }, id(), actor);
  };
  await assert.rejects(invoke({}, { kind: 'agent', runId: 'untrusted-run', conversationId: fixture.conversationId }), { code: 'REFERENCE_OPERATOR_REQUIRED' });
  await assert.rejects(invoke({ material_sha256: '0'.repeat(64) }), { code: 'WORK_MATERIAL_HASH_MISMATCH' });
  await assert.rejects(invoke({ excerpt: 'This text does not occur in the approved material.' }), { code: 'REFERENCE_EXCERPT_INVALID' });
  await assert.rejects(invoke({ offer_id: 'different-offer' }), { code: 'REFERENCE_OFFER_CHANGED' });
  await assert.rejects(invoke({ market: 'Germany' }), { code: 'REFERENCE_MARKET_INVALID' });
  await assert.rejects(invoke({ question_message_id: 'not-the-latest-inbound' }), { code: 'REFERENCE_QUESTION_CHANGED' });
  await assert.rejects(invoke({ expires_at: new Date(Date.now() - 1000).toISOString() }), { code: 'REFERENCE_DEADLINE_INVALID' });
  const partnerId = h.config.partnerId;
  const material = h.service.work.detail(fixture.caseId).material;
  const scopedPayload = { engagement_id: fixture.engagementId,
    expected_revision: h.service.engagement.get(fixture.engagementId).revision,
    material_id: fixture.materialId, material_sha256: material.sha256,
    question_message_id: fixture.questionMessageId, offer_id: h.config.opportunity.activeOffer.id,
    market: 'DE', excerpt: fixture.excerpt,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), note: 'Scoped offline fixture review' };
  h.config.partnerId = 'unrelated-partner';
  await assert.rejects(h.command('reference.attach', scopedPayload, id(), { kind: 'operator' }), error => error.status === 404);
  h.config.partnerId = partnerId;
  assert.deepEqual(h.service.references.context(fixture.engagementId), before);
  assertNoAuthorityEffects(h);
});

test('unreviewed material is rejected and a declared market stays a scoped label, not a person fact', async t => {
  const h = workspaceHarness(t);
  h.config.engagement.enabled = true;
  const fixture = await managedQuestion(h);
  const unreviewed = await h.material(fixture.caseId, `# New draft\n\n${fixture.excerpt}\n\nUnreviewed.`);
  fixture.materialId = unreviewed.material_id;
  await assert.rejects(attach(h, fixture), { code: 'WORK_MATERIAL_REVIEW_REQUIRED' });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM facts').n, 0);
  await h.approve(fixture.caseId, unreviewed.material_id);
  const attached = await attach(h, fixture);
  assert.equal(h.service.references.context(fixture.engagementId).items[0].market, 'DE');
  assert.equal(h.service.person(h.service.conversation(fixture.conversationId).person_id).market, undefined,
    'a declared research market must not become the recipient market');
  await assert.rejects(attach(h, fixture, { market: 'NL' }), { code: 'REFERENCE_SCOPE_CONFLICT' });
  assert.equal(h.service.references.context(fixture.engagementId).items[0].reference_id, attached.reference_id);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM facts').n, 0);
  assertNoAuthorityEffects(h);
});

test('operator revocation removes reading authority without changing contact permission', async t => {
  const h = workspaceHarness(t);
  h.config.engagement.enabled = true;
  const fixture = await managedQuestion(h);
  const attached = await attach(h, fixture);
  assert.equal(h.service.references.context(fixture.engagementId).items.length, 1);
  await assert.rejects(h.command('reference.revoke', {
    engagement_id: fixture.engagementId,
    expected_revision: h.service.engagement.get(fixture.engagementId).revision,
    reference_id: attached.reference_id,
    reason: 'The material was withdrawn for review',
  }, id(), { kind: 'agent', runId: 'untrusted-run', conversationId: fixture.conversationId }), { code: 'REFERENCE_OPERATOR_REQUIRED' });
  const revoked = await h.command('reference.revoke', {
    engagement_id: fixture.engagementId,
    expected_revision: h.service.engagement.get(fixture.engagementId).revision,
    reference_id: attached.reference_id,
    reason: 'The material was withdrawn for review',
  });
  assert.equal(revoked.status, 'revoked');
  const context = h.service.references.context(fixture.engagementId);
  assert.equal(context.items.length, 0);
  assert.ok(context.unavailable.length >= 1);
  assert.equal(JSON.stringify(context.unavailable).includes(fixture.excerpt), false);
  const reattached = await attach(h, fixture);
  assert.notEqual(reattached.reference_id, attached.reference_id,
    'revocation never reactivates the old id; only a fresh explicit command can create a new reference');
  const afterReattach = h.service.references.context(fixture.engagementId);
  assert.equal(afterReattach.items.length, 1);
  assert.ok(afterReattach.unavailable.some(item => item.id === attached.reference_id));
  assertNoAuthorityEffects(h);
});

test('new inbound withdraws the old question reference without leaking stale excerpt or poisoning the next question', async t => {
  const h = workspaceHarness(t);
  h.config.engagement.enabled = true;
  const fixture = await managedQuestion(h);
  await attach(h, fixture);
  const next = await h.command('message.record', { conversation_id: fixture.conversationId,
    text: 'Can you clarify which official German terms apply?', external_id: `question-${id()}`, source: 'synthetic-test' });
  const current = h.service.references.context(fixture.engagementId);
  assert.equal(current.items.length, 0);
  assert.ok(current.unavailable.length >= 1);
  assert.equal(JSON.stringify(current.unavailable).includes(fixture.excerpt), false);
  assert.equal(h.service.engagement.current(fixture.conversationId).status, 'OPEN');
  await assert.rejects(attach(h, fixture), { code: 'REFERENCE_QUESTION_CHANGED' });
  assertNoAuthorityEffects(h);
  assert.notEqual(next.message_id, fixture.questionMessageId);
});

test('changed source evidence withdraws the reference and cannot be restored by a retry', async t => {
  const h = workspaceHarness(t);
  h.config.engagement.enabled = true;
  const fixture = await managedQuestion(h);
  await attach(h, fixture);
  assert.equal(h.service.references.context(fixture.engagementId).items.length, 1);
  await h.ingest({ version: 2, text: 'A newer source version changes the quoted condition.' });
  await h.service.continuity.reconcile();
  const context = h.service.references.context(fixture.engagementId);
  assert.equal(context.items.length, 0);
  assert.ok(context.unavailable.length >= 1);
  assert.equal(JSON.stringify(context.unavailable).includes(fixture.excerpt), false);
  assertNoAuthorityEffects(h);
});

test('source change after a reference-backed ACT invalidates the draft before approval or delivery', async t => {
  const h = workspaceHarness(t);
  h.config.engagement.enabled = true;
  const fixture = await managedQuestion(h), attached = await attach(h, fixture);
  await h.command('permission.grant', { conversation_id: fixture.conversationId, purpose: 'reply',
    granted_by: 'synthetic recipient', evidence: 'Offline explicit reply request',
    valid_from: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
  h.config.runtime.enabled = true; h.config.runtime.model = 'offline-reference-fixture';
  h.config.runtime.baseUrl = 'https://example.invalid';
  const oldKey = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'offline-reference-fixture';
  t.after(() => { if (oldKey === undefined) delete process.env.PARTNER_MODEL_API_KEY; else process.env.PARTNER_MODEL_API_KEY = oldKey; });
  h.service.control.acquireProcess();
  h.beforeCleanup.push(() => h.service.control.close());
  let decision;
  h.scheduler.runtime = { async run(run, context) {
    assert.equal(context.reviewed_references.items.length, 1);
    const ticketId = h.service.control.scope.getStore().id;
    decision = await h.command('decision.commit', {
      engagement_id: fixture.engagementId,
      expected_revision: h.service.engagement.get(fixture.engagementId).revision,
      kind: 'ACT', reason: 'Use the scoped reviewed interpretation for this question',
      expected_next: 'Operator reviews the pending draft',
      evidence: [{ type: 'reference', id: attached.reference_id }],
      action: { purpose: 'reply', text: 'The reviewed Germany fixture says terms depend on the selected package.',
        explained: [], commitments: [] },
    }, id(), { kind: 'agent', runId: run.id, conversationId: fixture.conversationId, controlTicketId: ticketId });
    return { completed: true, usage: { input_tokens: 12, output_tokens: 9,
      estimated_cost_usd: 0, cost_status: 'runtime_estimate' } };
  }, close() {} };
  await h.scheduler.privateTick();
  assert.equal(h.service.draft(decision.draft_id).status, 'pending');
  await h.ingest({ version: 2, text: 'A newer source version changes the quoted condition.' });
  assert.equal(h.service.references.context(fixture.engagementId).items.length, 0,
    'freshness is read at access time; it does not wait for a sweeper');
  await assert.rejects(h.command('draft.approve', { draft_id: decision.draft_id }));
  assert.notEqual(h.service.draft(decision.draft_id).status, 'approved');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM delivery_attempts').n, 0);
});
