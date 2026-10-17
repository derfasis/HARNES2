import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { projectKnowledge, loadPartnerKnowledge } from '../business/knowledge.mjs';
import { compactPromptContext, contextFor } from '../business/context.mjs';

const REVIEW_AT = '2026-01-08T12:00:00.000Z';
const CHECKED_AT = '2026-01-01T12:00:00.000Z';
const SHA = 'a'.repeat(64);

function reference(overrides = {}) {
  return {
    id: 'de-rules',
    market: 'DE',
    status: 'active',
    source: {
      url: 'https://official.example/de/rules.pdf',
      document_version: '2026-01',
      sha256: SHA,
      checked_at: CHECKED_AT,
      review_after: REVIEW_AT,
    },
    claims: [
      { id: 'entry', section: '2.1', text: 'No product purchase is required to register.' },
    ],
    ...overrides,
  };
}

function asset(overrides = {}) {
  return {
    schema: 'partner-knowledge-v1',
    id: 'pm-international',
    version: '1.0.0',
    title: 'PM / FitLine test offer',
    status: 'needs_owner_materials',
    owner_selected_market: null,
    facts: [{ text: 'Owner selected PM-International / FitLine as a test offer.', kind: 'owner_requirement' }],
    missing: ['Owner market', 'Current participation costs', 'Compensation plan'],
    boundaries: ['Do not invent fees, income or product claims.'],
    official_references: [reference()],
    ...overrides,
  };
}

function unavailable(ref) {
  assert.equal(ref.status, 'unavailable');
  assert.equal(typeof ref.id, 'string');
  assert.ok('market' in ref);
  assert.ok(typeof ref.reason === 'string' && ref.reason.length > 0);
  assert.equal('claims' in ref, false, 'unavailable source claims must not reach the model');
  assert.equal('source' in ref, false, 'unavailable source metadata/content must not reach the model');
  assert.equal('text' in ref, false, 'unavailable source content must not reach the model');
}

test('default model projection exposes only reference metadata while operator projection can inspect current source claims', () => {
  const at = Date.parse('2026-01-08T11:59:59.999Z');
  const model = projectKnowledge(asset(), { at });
  assert.equal(model.owner_selected_market, null);
  assert.deepEqual(model.missing, ['Owner market', 'Current participation costs', 'Compensation plan']);
  assert.equal(model.facts[0].text, 'Owner selected PM-International / FitLine as a test offer.');
  assert.equal(model.official_references.length, 1);
  assert.equal(model.official_references[0].status, 'available_for_review');
  assert.equal(model.official_references[0].market, 'DE');
  assert.equal('claims' in model.official_references[0], false, 'model receives no market-specific claim body');
  assert.equal('source' in model.official_references[0], false, 'model receives no country source body');
  assert.equal(JSON.stringify(model).includes('No product purchase is required'), false);
  const projected = projectKnowledge(asset(), { at, audience: 'operator' });
  assert.equal(projected.owner_selected_market, null);
  assert.deepEqual(projected.missing, ['Owner market', 'Current participation costs', 'Compensation plan']);
  assert.equal(projected.facts[0].text, 'Owner selected PM-International / FitLine as a test offer.');
  assert.equal(projected.official_references.length, 1);
  const operatorRef = projected.official_references[0];
  assert.equal(operatorRef.id, 'de-rules');
  assert.equal(operatorRef.market, 'DE');
  assert.equal(operatorRef.status, 'reference_only');
  assert.equal(operatorRef.epistemic_status, 'source_attributed_summary_not_independent_verification');
  assert.equal(operatorRef.source.url, 'https://official.example/de/rules.pdf');
  assert.equal(operatorRef.claims[0].id, 'entry');
  assert.equal(typeof operatorRef.currentness_basis, 'string');
  assert.equal('contact_permission' in projected, false, 'knowledge projection creates no contact permission');
});

test('a reference expires at review_after equality', () => {
  const projected = projectKnowledge(asset(), { at: Date.parse(REVIEW_AT) });
  unavailable(projected.official_references[0]);
  assert.equal(projected.owner_selected_market, null);
});

test('future, invalid, or missing source dates fail closed without leaking claims', () => {
  const cases = [
    ['future checked_at', { checked_at: '2026-01-09T00:00:00.000Z' }],
    ['invalid checked_at', { checked_at: 'not-a-date' }],
    ['impossible checked_at calendar date', { checked_at: '2026-02-31T00:00:00.000Z' }],
    ['missing checked_at', { checked_at: undefined }],
    ['invalid review_after', { review_after: 'not-a-date' }],
    ['impossible review_after calendar date', { review_after: '2026-02-31T00:00:00.000Z' }],
    ['missing review_after', { review_after: undefined }],
  ];
  for (const [name, changes] of cases) {
    const src = { ...reference().source, ...changes };
    const projected = projectKnowledge(asset({ official_references: [reference({ source: src })] }), { at: Date.parse(REVIEW_AT) - 1 });
    assert.doesNotThrow(() => unavailable(projected.official_references[0]), name);
  }
});

test('inverted and longer-than-seven-day review windows fail closed', () => {
  const cases = [
    { checked_at: '2026-01-02T00:00:00.000Z', review_after: '2026-01-01T00:00:00.000Z' },
    { checked_at: '2026-01-01T00:00:00.000Z', review_after: '2026-01-08T00:00:00.001Z' },
  ];
  for (const source of cases) {
    const projected = projectKnowledge(asset({ official_references: [reference({ source: { ...reference().source, ...source } })] }), { at: Date.parse('2026-01-03T00:00:00.000Z') });
    unavailable(projected.official_references[0]);
  }
});

test('revoked references and incomplete source identity fail closed', () => {
  const invalids = [
    reference({ id: 'revoked', status: 'revoked' }),
    reference({ id: 'url-missing', source: { ...reference().source, url: '' } }),
    reference({ id: 'hash-missing', source: { ...reference().source, sha256: 'no-hash' } }),
    reference({ id: 'version-missing', source: { ...reference().source, document_version: '' } }),
    reference({ id: 'market-invalid', market: 'Germany' }),
  ];
  const projected = projectKnowledge(asset({ official_references: invalids }), { at: Date.parse('2026-01-03T00:00:00.000Z') });
  assert.equal(projected.official_references.length, invalids.length);
  projected.official_references.forEach(unavailable);
});

test('a revoked or stale reference does not suppress a healthy sibling', () => {
  const refs = [
    reference({ id: 'revoked-sibling', status: 'revoked' }),
    reference({ id: 'stale-sibling', source: { ...reference().source, review_after: '2026-01-02T00:00:00.000Z' } }),
    reference({ id: 'healthy-sibling' }),
  ];
  const projected = projectKnowledge(asset({ official_references: refs }), { at: Date.parse('2026-01-03T00:00:00.000Z'), audience: 'operator' });
  assert.equal(projected.official_references.length, 3);
  unavailable(projected.official_references[0]);
  unavailable(projected.official_references[1]);
  assert.equal(projected.official_references[2].status, 'reference_only');
  assert.equal(projected.official_references[2].claims[0].id, 'entry');
});

test('duplicate group or claim IDs are withheld without invalidating valid siblings', () => {
  const validSibling = reference({ id: 'hr-rules', market: 'HR' });
  const duplicateGroups = [reference(), reference({ market: 'HR' }), validSibling];
  const duplicateClaims = reference({ id: 'claims-bad', claims: [
    { id: 'same', section: '1', text: 'first hidden claim' },
    { id: 'same', section: '2', text: 'second hidden claim' },
  ] });
  const projected = projectKnowledge(asset({ official_references: [...duplicateGroups, duplicateClaims] }), { at: Date.parse('2026-01-03T00:00:00.000Z'), audience: 'operator' });
  assert.equal(projected.official_references.length, 4);
  unavailable(projected.official_references[0]);
  unavailable(projected.official_references[1]);
  assert.equal(projected.official_references[2].status, 'reference_only', 'a valid sibling survives another group’s duplicate ID');
  unavailable(projected.official_references[3]);
});

test('malformed root reference collection fails closed without discarding owner facts', () => {
  const malformed = {
    id: { nested: 'DO_NOT_LEAK_ID' },
    market: { nested: 'DO_NOT_LEAK_MARKET' },
    claims: [{ id: 'secret', text: 'DO_NOT_LEAK_CLAIM' }],
    source: { url: 'https://secret.invalid/DO_NOT_LEAK_SOURCE' },
  };
  const projected = projectKnowledge(asset({ official_references: malformed }), { at: Date.parse('2026-01-03T00:00:00.000Z') });
  assert.equal(projected.facts[0].text, 'Owner selected PM-International / FitLine as a test offer.');
  const packed = JSON.stringify(projected.official_references);
  assert.doesNotMatch(packed, /DO_NOT_LEAK_ID|DO_NOT_LEAK_MARKET|DO_NOT_LEAK_CLAIM|DO_NOT_LEAK_SOURCE/);
  for (const ref of projected.official_references) unavailable(ref);
});

test('loader returns assets in deterministic filename order', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'partner-knowledge-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'zeta.json'), JSON.stringify(asset({ id: 'zeta', official_references: [] })));
  await fs.writeFile(path.join(directory, 'alpha.json'), JSON.stringify(asset({ id: 'alpha', official_references: [] })));
  const first = await loadPartnerKnowledge({ at: Date.parse('2026-01-03T00:00:00.000Z'), directory });
  const second = await loadPartnerKnowledge({ at: Date.parse('2026-01-03T00:00:00.000Z'), directory });
  assert.deepEqual(first.map(x => x.id), ['alpha', 'zeta']);
  assert.deepEqual(second, first);
});

test('context and compact prompt retain the projected pack and unknown market without creating work or permissions', () => {
  const service = {
    config: { partnerId: 'fixture-partner', context: { maxLessons: 3 } },
    partner: () => ({}),
    store: { all: () => [] },
    engagement: { managed: () => false },
  };
  const context = contextFor(service);
  const compact = compactPromptContext(context);
  const contextJson = JSON.stringify(context);
  const compactJson = JSON.stringify(compact);
  assert.ok(Array.isArray(context.knowledge));
  assert.ok(context.knowledge.some(pack => pack.id === 'pm-international'), 'the projected business knowledge pack stays in model context');
  const pack = context.knowledge.find(item => item.id === 'pm-international');
  assert.equal(pack.selected_market, null);
  assert.ok(pack.missing.length > 0);
  assert.ok(pack.missing.some(item => item.includes('Выбранный рынок владельца')));
  assert.ok(pack.official_references.length > 0);
  assert.ok(pack.official_references.every(ref => ref.status === 'available_for_review' || ref.status === 'unavailable'));
  assert.ok(pack.official_references.every(ref => !('claims' in ref) && !('source' in ref)));
  assert.doesNotMatch(contextJson, /pmagbde\.pdf|Договор возникает после принятия заявления PM/);
  assert.doesNotMatch(compactJson, /pmagbde\.pdf|Договор возникает после принятия заявления PM/);
  assert.deepEqual(compact.knowledge, context.knowledge, 'prompt compaction preserves the already projected knowledge catalog');
  assert.deepEqual(context.work, []);
  assert.deepEqual(context.contacts, []);
  assert.equal(context.contact_permission, undefined);
});
