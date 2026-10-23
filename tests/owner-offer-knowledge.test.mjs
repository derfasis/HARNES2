import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { projectKnowledge, loadPartnerKnowledge, ownerSpecificationDigest } from '../business/knowledge.mjs';
import { compactPromptContext, contextFor } from '../business/context.mjs';
import { callTool } from '../business/tools.mjs';

const RECORDED = '2026-10-23T00:00:00Z';
const REVIEW = '2026-10-25T00:00:00Z';
const SOURCE_BODY = 'Synthetic owner-provided presentation excerpt for projection tests.';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function offer(overrides = {}) {
  const asset = {
    schema: 'partner-knowledge-v1',
    id: 'yovi-prelaunch',
    version: '1.0.0',
    title: 'Synthetic prelaunch fixture',
    owner_specification: {
      phase: 'prelaunch',
      status: 'approved',
      recorded_at: RECORDED,
      review_after: REVIEW,
      owner_decision: 'use_supplied_presentations_for_prelaunch_preparation',
      sources: [{
        id: 'presentation-1',
        file_name: 'synthetic-presentation.pdf',
        document_version: 'fixture-v1',
        sha256: 'a'.repeat(64),
      }],
      approved_content_sha256: digest(SOURCE_BODY),
    },
    facts: [{
      id: 'fact-1',
      text: 'YOVI is described in the supplied presentation as a prelaunch partner project.',
      kind: 'owner_approved_presentation_summary',
      source_id: 'presentation-1',
      section: 'Synthetic fixture, section 1',
      source: SOURCE_BODY,
    }],
  };
  Object.assign(asset, overrides);
  if (asset.owner_specification && typeof asset.owner_specification === 'object')
    asset.owner_specification.approved_content_sha256 = ownerSpecificationDigest(asset);
  return asset;
}

function hiddenFacts(projected) {
  assert.deepEqual(projected.facts, [], 'invalid or withheld owner material has no usable fact entries');
  const packed = JSON.stringify(projected);
  for (const marker of [SOURCE_BODY, 'YOVI is described', 'synthetic-presentation.pdf', 'DO_NOT_LEAK']) {
    assert.equal(packed.includes(marker), false, `withheld content must not leak marker ${marker}`);
  }
}

test('owner presentation facts are planning-only and carry an explicit epistemic boundary', () => {
  const asset = offer();
  const at = Date.parse('2026-10-24T12:00:00Z');
  const model = projectKnowledge(asset, { at, audience: 'model' });
  hiddenFacts(model);
  assert.equal(model.owner_specification.status, 'available_for_planning');
  assert.equal('owner_decision' in model.owner_specification, false);
  assert.equal('sources' in model.owner_specification, false);

  for (const audience of ['planning', 'operator']) {
    const planning = projectKnowledge(asset, { at, audience });
    assert.equal(planning.facts.length, 1);
    assert.equal(planning.epistemic_status, 'owner_approved_presentation_summary_not_external_verification');
    assert.equal(planning.facts[0].id, 'fact-1');
    assert.equal(planning.facts[0].source_id, 'presentation-1');
    assert.equal(planning.facts[0].source, SOURCE_BODY);
    assert.equal(planning.facts[0].epistemic_status, 'owner_approved_presentation_summary_not_external_verification');
  }
});

test('facts become unavailable at review_after equality and malformed calendar dates fail closed', () => {
  const base = offer();
  const expired = projectKnowledge(base, { at: Date.parse(REVIEW), audience: 'planning' });
  hiddenFacts(expired);
  assert.equal(expired.owner_specification.status, 'unavailable');

  for (const review_after of ['2026-02-30T00:00:00Z', 'not-a-date', '2026-10-22T00:00:00Z']) {
    const invalid = offer({ owner_specification: {
      ...base.owner_specification,
      review_after,
    } });
    const projected = projectKnowledge(invalid, { at: Date.parse('2026-10-24T00:00:00Z'), audience: 'planning' });
    hiddenFacts(projected);
    assert.equal(projected.owner_specification.status, 'unavailable');
  }
});

test('future approval time, absent or unknown source links, duplicate IDs, and malformed approvals withhold facts', () => {
  const base = offer();
  const invalidAssets = [
    ['future recorded_at', offer({ owner_specification: {
      ...base.owner_specification, recorded_at: '2026-10-25T00:00:00Z',
    } })],
    ['missing source_id', offer({ facts: [{ ...base.facts[0], source_id: undefined }] })],
    ['unknown source_id', offer({ facts: [{ ...base.facts[0], source_id: 'unknown-source' }] })],
    ['duplicate source IDs', offer({ owner_specification: {
      ...base.owner_specification, sources: [...base.owner_specification.sources, { ...base.owner_specification.sources[0] }],
    } })],
    ['duplicate fact IDs', offer({ facts: [base.facts[0], { ...base.facts[0], text: 'Second synthetic summary.' }] })],
    ['malformed null approval', offer({ owner_specification: null })],
  ];
  for (const [label, invalid] of invalidAssets) {
    const projected = projectKnowledge(invalid, { at: Date.parse('2026-10-24T00:00:00Z'), audience: 'planning' });
    hiddenFacts(projected);
    assert.equal(projected.owner_specification.status, 'unavailable', label);
  }
});

test('owner approval rejects a mixed official-reference asset without leaking either body', () => {
  const mixed = offer({ official_references: [{
    id: 'mixed-ref', market: 'US',
    source: { url: 'https://source.invalid/DO_NOT_LEAK' },
    claims: [{ id: 'claim', section: '1', text: 'DO_NOT_LEAK reference claim' }],
  }] });
  const projected = projectKnowledge(mixed, { at: Date.parse('2026-10-24T00:00:00Z'), audience: 'planning' });
  hiddenFacts(projected);
  assert.equal('official_references' in projected, false);
});

test('revoked approvals and content or source changes without an updated digest withhold all body data', () => {
  const base = offer();
  const revoked = offer({ owner_specification: { ...base.owner_specification, status: 'revoked' } });
  hiddenFacts(projectKnowledge(revoked, { at: Date.parse('2026-10-24T00:00:00Z'), audience: 'planning' }));

  const changedFact = offer();
  changedFact.facts[0].text = 'DO_NOT_LEAK changed claim';
  hiddenFacts(projectKnowledge(changedFact, { at: Date.parse('2026-10-24T00:00:00Z'), audience: 'planning' }));

  const changedSource = offer();
  changedSource.owner_specification.sources[0].sha256 = 'b'.repeat(64);
  hiddenFacts(projectKnowledge(changedSource, { at: Date.parse('2026-10-24T00:00:00Z'), audience: 'planning' }));
});

test('a bad YOVI pack does not suppress a healthy sibling pack in the loader', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-offer-knowledge-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const stale = offer({ owner_specification: { ...offer().owner_specification, status: 'revoked' } });
  const sibling = {
    schema: 'partner-knowledge-v1', id: 'healthy-sibling', version: '1.0.0',
    facts: [{ id: 'sibling-fact', text: 'Independent healthy fixture.' }],
  };
  await fs.writeFile(path.join(directory, 'a-yovi.json'), JSON.stringify(stale));
  await fs.writeFile(path.join(directory, 'b-sibling.json'), JSON.stringify(sibling));
  const loaded = loadPartnerKnowledge({ directory, at: Date.parse('2026-10-24T00:00:00Z'), audience: 'planning' });
  assert.equal(loaded.length, 2);
  hiddenFacts(loaded[0]);
  assert.equal(loaded[1].id, 'healthy-sibling');
  assert.equal(loaded[1].facts[0].text, 'Independent healthy fixture.');
});

test('no-conversation planning context includes approved owner summaries; a conversation model context does not', async () => {
  let writes = 0;
  const service = {
    config: { partnerId: 'fixture-partner', context: { maxLessons: 3, maxRecentMessages: 3, maxMessageCharacters: 1000 } },
    partner: () => ({}),
    conversation: id => ({ id, person_id: 'fixture-person' }),
    person: id => ({ id, name: 'Fixture person' }),
    engagement: { managed: () => false, current: () => null },
    store: { all: () => [], run: () => { writes += 1; } },
  };
  const previousNow = Date.now;
  Date.now = () => Date.parse('2026-10-24T00:00:00Z');
  try {
    const planning = contextFor(service);
    const planningPack = planning.knowledge.find(pack => pack.id === 'yovi-prelaunch');
    assert.ok(planningPack, 'the real owner-approved pack is available to internal planning');
    assert.ok(planningPack.facts.length > 0);
    assert.equal(planningPack.epistemic_status, 'owner_approved_presentation_summary_not_external_verification');
    assert.deepEqual(compactPromptContext(planning).knowledge, planning.knowledge,
      'prompt compaction preserves planning facts and their provenance');

    const viaTool = await callTool(service, { kind: 'agent' }, 'partner_get_context', {}, 'fixture-request');
    assert.ok(viaTool.knowledge.find(pack => pack.id === 'yovi-prelaunch').facts.length > 0,
      'the actual context tool exposes the pack to internal planning');
    assert.equal('contact_permission' in viaTool, false);
    assert.equal('contact_permissions' in viaTool, false);
    assert.deepEqual(viaTool.contacts, []);
    assert.equal(writes, 0, 'reading the context creates no durable side effect');

    const conversation = contextFor(service, 'fixture-conversation');
    const modelPack = conversation.knowledge.find(pack => pack.id === 'yovi-prelaunch');
    assert.ok(modelPack);
    hiddenFacts(modelPack);
    const privateTool = await callTool(service, { kind: 'agent', conversationId: 'fixture-conversation' },
      'partner_get_context', {}, 'fixture-request');
    hiddenFacts(privateTool.knowledge.find(pack => pack.id === 'yovi-prelaunch'));
    assert.equal('contact_permission' in privateTool, false);
    assert.equal('contact_permissions' in privateTool, false);
    assert.equal(writes, 0);
  } finally {
    Date.now = previousNow;
  }
});
