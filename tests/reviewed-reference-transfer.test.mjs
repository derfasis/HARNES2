import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../business/config.mjs';
import { exportPartner } from '../business/export.mjs';
import { hash, id, Store, TABLES } from '../business/store.mjs';
import { REFERENCE_TABLES } from '../business/reference-tables.mjs';
import { SCOUT_QUERY_TABLES } from '../business/scout-tables.mjs';
import { digest } from '../business/source-ingestion.mjs';
import { workspaceHarness, SOURCE } from './helpers/workspace-harness.mjs';

async function preparedReference(h, sourceText = 'Germany fixture observation: listed participation costs vary by selected package.') {
  h.config.engagement.enabled = true;
  h.ingest = function () {
    return this.command('source.ingest', { source_id: SOURCE, source_kind: 'sanitized_fixture',
      message_id: 'de-transfer-fixture', author_id: 'fixture-publisher', display_name: null,
      thread_id: null, reply_to_id: null, version: 1, operation: 'upsert', text: sourceText,
      created_at: '2026-10-14T00:00:00.000Z', updated_at: '2026-10-14T00:00:00.000Z' }, id(),
    { kind: 'channel', sourceId: SOURCE });
  };
  const caseId = await h.ready();
  const material = await h.material(caseId, `# Germany fixture\n\n${sourceText}\n\nReviewed interpretation only.`);
  await h.approve(caseId, material.material_id);
  const person = await h.command('person.create', { name: 'Synthetic transfer recipient', source: 'offline test' });
  const inbound = await h.command('message.record', { conversation_id: person.conversation_id,
    text: 'What costs apply in Germany?', external_id: `transfer-question-${id()}`, source: 'synthetic-test' });
  const engagement = h.service.engagement.current(person.conversation_id);
  assert.ok(engagement);
  const reviewed = h.service.work.detail(caseId).material;
  const attached = await h.command('reference.attach', {
    engagement_id: engagement.id, expected_revision: engagement.revision, material_id: material.material_id,
    material_sha256: reviewed.sha256, question_message_id: inbound.message_id,
    offer_id: h.config.opportunity.activeOffer.id, market: 'DE', excerpt: sourceText,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), note: 'Offline transfer fixture review',
  });
  return { caseId, conversationId: person.conversation_id, engagementId: engagement.id,
    questionMessageId: inbound.message_id, referenceId: attached.reference_id, excerpt: sourceText };
}

function freezeBundle(bundle) { bundle.tables_sha256 = hash(JSON.stringify(bundle.tables)); return bundle; }
function stageImport(t, h, bundle, label) {
  const source = path.join(h.directory, `${label}-${id()}.json`);
  const destination = path.join(ROOT, 'exports', `${label}-${id()}`);
  fs.writeFileSync(source, JSON.stringify(freezeBundle(bundle)), { flag: 'wx' });
  t.after(() => {
    fs.rmSync(source, { force: true });
    fs.rmSync(destination, { recursive: true, force: true });
  });
  const child = spawnSync(process.execPath, ['scripts/import.mjs', source, destination],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  return { source, destination, child };
}
function historicalV20(bundle) {
  for (const table of SCOUT_QUERY_TABLES) delete bundle.tables[table];
  bundle.migrations = bundle.migrations.slice(0, 20);
  return freezeBundle(bundle);
}
function historicalV19(bundle) {
  historicalV20(bundle);
  for (const table of REFERENCE_TABLES) delete bundle.tables[table];
  bundle.migrations = bundle.migrations.slice(0, 19);
  return freezeBundle(bundle);
}

test('schema-19 catalogue stays exact and imports without the appended reference table', async t => {
  const h = workspaceHarness(t);
  const bundle = historicalV19(exportPartner(h.store));
  assert.equal(bundle.migrations.length, 19);
  assert.deepEqual(Object.keys(bundle.tables).sort(), TABLES.filter(table => !REFERENCE_TABLES.includes(table)&&!SCOUT_QUERY_TABLES.includes(table)).sort());
  const { destination, child } = stageImport(t, h, bundle, 'reviewed-reference-v19-transfer');
  assert.equal(child.status, 0, child.stderr);
  const restored = new Store(path.join(destination, 'data'));
  try {
    assert.equal(restored.get('SELECT COUNT(*) n FROM engagement_references').n, 0);
    assert.equal(restored.all('SELECT * FROM schema_migrations').length, 21,
      'staging upgrades the schema-19 bundle through the current schema');
    assert.deepEqual(restored.all('PRAGMA foreign_key_check'), []);
  } finally { restored.close(); }
});

test('schema-20 transfer keeps reference history and provenance but revokes every reading grant', async t => {
  const h = workspaceHarness(t), fixture = await preparedReference(h);
  const bundle = historicalV20(exportPartner(h.store));
  assert.equal(bundle.migrations.length, 20);
  assert.deepEqual(Object.keys(bundle.tables).sort(), TABLES.filter(table=>!SCOUT_QUERY_TABLES.includes(table)).sort());
  const original = bundle.tables.engagement_references.find(row => row.id === fixture.referenceId);
  assert.equal(original.status, 'active');
  const { destination, child } = stageImport(t, h, bundle, 'reviewed-reference-v20-transfer');
  assert.equal(child.status, 0, child.stderr);
  const restored = new Store(path.join(destination, 'data'));
  try {
    const reference = restored.get('SELECT * FROM engagement_references WHERE id=?', fixture.referenceId);
    assert.equal(reference.status, 'revoked');
    assert.equal(reference.reason, 'TRANSFER_REQUIRES_REFERENCE_ADMISSION');
    assert.equal(reference.engagement_id, fixture.engagementId);
    assert.equal(reference.question_message_id, fixture.questionMessageId);
    assert.equal(reference.market, 'DE');
    assert.equal(reference.excerpt, fixture.excerpt);
    assert.equal(reference.packet_json, original.packet_json);
    assert.equal(restored.get('SELECT status FROM work_materials WHERE id=?', reference.material_id).status, 'stale');
    assert.equal(restored.get('SELECT status FROM work_cases WHERE id=?', fixture.caseId).status, 'stale');
    assert.equal(restored.get('SELECT COUNT(*) n FROM contact_permissions').n, 0);
    assert.equal(restored.get('SELECT COUNT(*) n FROM drafts').n, 0);
    assert.deepEqual(restored.all('PRAGMA foreign_key_check'), []);
  } finally { restored.close(); }
});

test('schema-20 transfer accepts canonical truncation of long source observations', async t => {
  const h = workspaceHarness(t), sourceText = `Germany fixture observation: ${'long-source-'.repeat(220)}`;
  const fixture = await preparedReference(h, sourceText), bundle = historicalV20(exportPartner(h.store));
  const row = bundle.tables.engagement_references.find(value => value.id === fixture.referenceId);
  const packet = JSON.parse(row.packet_json);
  assert.equal(packet.observations[0].text, sourceText.slice(0, 2000));
  assert.equal(packet.observations[0].truncated, true);
  const { destination, child } = stageImport(t, h, bundle, 'reviewed-reference-long-source-transfer');
  assert.equal(child.status, 0, child.stderr);
  const restored = new Store(path.join(destination, 'data'));
  try {
    const reference = restored.get('SELECT * FROM engagement_references WHERE id=?', fixture.referenceId);
    assert.equal(reference.status, 'revoked');
    assert.equal(JSON.parse(reference.packet_json).observations[0].truncated, true);
  } finally { restored.close(); }
});

test('schema-20 transfer rejects a false truncation flag', async t => {
  const h = workspaceHarness(t), sourceText = `Germany fixture observation: ${'long-source-'.repeat(220)}`;
  const fixture = await preparedReference(h, sourceText), bundle = historicalV20(exportPartner(h.store));
  const row = bundle.tables.engagement_references.find(value => value.id === fixture.referenceId);
  const packet = JSON.parse(row.packet_json); packet.observations[0].truncated = false;
  row.packet_json = JSON.stringify(packet); row.packet_sha256 = digest(packet);
  const { destination, child } = stageImport(t, h, bundle, 'reviewed-reference-false-truncated-transfer');
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /Invalid transferred engagement reference/);
  assert.equal(fs.existsSync(destination), false);
});

test('schema-20 transfer rejects source observation text that differs from canonical truncation', async t => {
  const h = workspaceHarness(t), sourceText = `Germany fixture observation: ${'long-source-'.repeat(220)}`;
  const fixture = await preparedReference(h, sourceText), bundle = historicalV20(exportPartner(h.store));
  const row = bundle.tables.engagement_references.find(value => value.id === fixture.referenceId);
  const packet = JSON.parse(row.packet_json); packet.observations[0].text = `${packet.observations[0].text.slice(0, -1)}X`;
  row.packet_json = JSON.stringify(packet); row.packet_sha256 = digest(packet);
  const { destination, child } = stageImport(t, h, bundle, 'reviewed-reference-text-tamper-transfer');
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /Invalid transferred engagement reference/);
  assert.equal(fs.existsSync(destination), false);
});

test('malformed reference packet is rejected before staging data is created', async t => {
  const h = workspaceHarness(t), fixture = await preparedReference(h);
  const engagement = h.service.engagement.get(fixture.engagementId), material = h.service.work.detail(fixture.caseId).material;
  await h.command('reference.attach', { engagement_id: engagement.id, expected_revision: engagement.revision,
    material_id: material.id, material_sha256: material.sha256, question_message_id: fixture.questionMessageId,
    offer_id: h.config.opportunity.activeOffer.id, market: 'DE', excerpt: 'Reviewed interpretation only.',
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), note: 'Second offline fixture reference' });
  const bundle = exportPartner(h.store);
  assert.equal(bundle.tables.engagement_references.length, 2, 'the malformed record has a valid neighboring reference');
  const row = bundle.tables.engagement_references.find(value => value.id === fixture.referenceId);
  const packet = JSON.parse(row.packet_json); packet.unexpected = true;
  row.packet_json = JSON.stringify(packet); row.packet_sha256 = digest(packet);
  const { destination, child } = stageImport(t, h, bundle, 'reviewed-reference-invalid-packet');
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /Invalid transferred engagement reference/);
  assert.equal(fs.existsSync(destination), false, 'invalid bundle must not leave a partial restore directory');
});

test('reference whose material case belongs to another partner is rejected before staging', async t => {
  const h = workspaceHarness(t), fixture = await preparedReference(h), bundle = exportPartner(h.store);
  const reference = bundle.tables.engagement_references.find(row => row.id === fixture.referenceId);
  const material = bundle.tables.work_materials.find(row => row.id === reference.material_id);
  const workCase = bundle.tables.work_cases.find(row => row.id === material.case_id);
  workCase.partner_id = 'different-owner';
  const { destination, child } = stageImport(t, h, bundle, 'reviewed-reference-wrong-material-owner');
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /Invalid transferred engagement reference/);
  assert.equal(fs.existsSync(destination), false, 'invalid bundle must not leave a partial restore directory');
});

test('cross-conversation question binding is rejected before staging data is created', async t => {
  const h = workspaceHarness(t), fixture = await preparedReference(h);
  const other = await h.command('person.create', { name: 'Other synthetic recipient', source: 'offline test' });
  const otherQuestion = await h.command('message.record', { conversation_id: other.conversation_id,
    text: 'A question in another conversation.', external_id: `other-question-${id()}`, source: 'synthetic-test' });
  const bundle = exportPartner(h.store);
  const row = bundle.tables.engagement_references.find(value => value.id === fixture.referenceId);
  const packet = JSON.parse(row.packet_json);
  row.question_message_id = otherQuestion.message_id;
  packet.question_message_id = otherQuestion.message_id;
  row.packet_json = JSON.stringify(packet); row.packet_sha256 = digest(packet);
  const { destination, child } = stageImport(t, h, bundle, 'reviewed-reference-cross-scope');
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /Invalid transferred engagement reference/);
  assert.equal(fs.existsSync(destination), false, 'invalid bundle must not leave a partial restore directory');
});
