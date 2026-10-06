// Immutable Telegram observation epochs transfer as evidence, never live reader authority.
// Fixtures use the synthetic native reader contract; no Telegram network or sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, readJson } from '../business/config.mjs';
import { Store, hash, id } from '../business/store.mjs';
import { exportPartner } from '../business/export.mjs';
import { BusinessService } from '../business/service.mjs';
import { sourceCheckpoint, digest } from '../business/source-ingestion.mjs';
import { commitTelegramRebaseline, telegramRebaselineAuthorization, validateSourceObservationEpochs } from '../business/source-observation-epochs.mjs';
import { bootstrapTelegramSource, disconnectTelegramSource } from '../business/sources/telegram-readonly.mjs';

const sourceId = 'telegram:channel:100', accountId = '999', channelId = '100';
const sourcePolicy = { sourceId, accountId, channelId, sourceKind: 'sanitized_fixture',
  processingBasis: 'Synthetic transfer fixture', maxLagSeconds: 120 };

async function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-rebaseline-transfer-'));
  const store = new Store(directory), config = readJson(path.join(ROOT, 'config/default.json'));
  Object.assign(config.opportunity, { automatic: true, telegramSources: [structuredClone(sourcePolicy)], allowedSourceRefs: [sourceId] });
  const service = new BusinessService(store, config);
  await bootstrapTelegramSource(service, sourceId, { pts: 10, history: [{ id: 1, channel_id: channelId, from_id: null, post: true,
    text: 'A synthetic pre-gap observation.', date: 1767225600, edit_date: null, reply_to_msg_id: null,
    reply_to_top_id: null, reply_to_channel_id: null }] });
  t.after(async () => { await service.tail.catch(() => {}); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, config, service };
}

async function pendingAuthorization(h) {
  await disconnectTelegramSource(h.service, sourceId, 'INTEGRITY_RECONCILIATION_REQUIRED');
  const checkpoint = sourceCheckpoint(h.service, sourceId);
  assert.equal(checkpoint.reason, 'INTEGRITY_RECONCILIATION_REQUIRED');
  assert.equal(digest(checkpoint), digest(sourceCheckpoint(h.service, sourceId)));
  return h.service.command('source.rebaseline', { source_id: sourceId, checkpoint_fingerprint: digest(checkpoint),
    acknowledge_gap: true, expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    reason: 'Synthetic operator acceptance for transfer verification.' }, `transfer-rebaseline-request-${id()}`);
}

async function committedEpoch(h) {
  const p = { ...sourcePolicy }, committed = [];
  for (const pts of [20, 30]) {
    if (pts > 20) await disconnectTelegramSource(h.service, sourceId, 'INTEGRITY_RECONCILIATION_REQUIRED');
    const authorization = await pendingAuthorization(h);
    const authorizationRow = telegramRebaselineAuthorization(h.service, p);
    assert.equal(authorizationRow.id, authorization.authorization_id);
    committed.push({ authorization, epoch: commitTelegramRebaseline(h.service, p, authorizationRow, pts) });
  }
  return { authorization: committed.at(-1).authorization, epoch: committed.at(-1).epoch };
}

function importBundle(t, h, bundle, label) {
  const file = path.join(h.directory, `telegram-epoch-${label}-${id()}.json`);
  fs.writeFileSync(file, JSON.stringify(bundle), { flag: 'wx' });
  const destination = path.join(ROOT, 'exports', `telegram-epoch-${label}-${id()}`);
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['scripts/import.mjs', file, destination],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  return { file, destination, result };
}

const updateTableChecksum = bundle => { bundle.tables_sha256 = hash(JSON.stringify(bundle.tables)); };

test('schema-17 export/import retains a committed cutover chain and does not restore active checkpoint authority', async t => {
  const h = await harness(t), { authorization, epoch } = await committedEpoch(h), bundle = exportPartner(h.store);
  assert.equal(bundle.migrations.length, 17);
  assert.ok(bundle.excluded.includes('transferable Telegram observation-rebaseline authority'));
  assert.deepEqual(bundle.tables.source_observation_epochs, h.store.all('SELECT * FROM source_observation_epochs ORDER BY source_ref,generation'));
  assert.equal(bundle.tables.source_observation_epochs.length, 2);
  assert.deepEqual(bundle.tables.source_observation_epochs.map(row => row.generation), [1, 2]);
  assert.equal(bundle.tables.source_observation_epochs[1].id, epoch.epoch_id);

  const { result, destination } = importBundle(t, h, bundle, 'committed');
  assert.equal(result.status, 0, result.stderr);
  const restored = new Store(path.join(destination, 'data'));
  try {
    const service = new BusinessService(restored, h.config);
    assert.deepEqual(restored.all('SELECT * FROM source_observation_epochs ORDER BY source_ref,generation'), bundle.tables.source_observation_epochs);
    assert.equal(validateSourceObservationEpochs(restored), true);
    const requestId = authorization.authorization_id;
    const terminal = restored.get(`SELECT payload_json FROM events WHERE kind='source.telegram.rebaseline.finished'
      AND json_extract(payload_json,'$.authorization_id')=? ORDER BY id DESC LIMIT 1`, requestId);
    assert.ok(terminal, 'committed request keeps its original native terminal receipt');
    assert.equal(JSON.parse(terminal.payload_json).status, 'committed');
    const checkpoint = sourceCheckpoint(service, sourceId);
    assert.equal(checkpoint.pts, 30, 'the latest cutover baseline remains visible as historical cursor state');
    assert.notEqual(checkpoint.phase, 'current', 'a transfer does not claim a fresh native observation');
    assert.equal(checkpoint.confirmed_at, null, 'the destination still needs a new forward observation');
    assert.deepEqual(restored.all('PRAGMA foreign_key_check'), []);
  } finally { restored.close(); }
});

test('schema-16 catalogue remains exact and upgrades without synthesizing a Telegram epoch', async t => {
  const h = await harness(t);
  const bundle = exportPartner(h.store);
  bundle.migrations = bundle.migrations.slice(0, 16);
  delete bundle.tables.source_observation_epochs;
  updateTableChecksum(bundle);
  const { result, destination } = importBundle(t, h, bundle, 'legacy16');
  assert.equal(result.status, 0, result.stderr);
  const restored = new Store(path.join(destination, 'data'));
  try {
    assert.equal(restored.get('SELECT COUNT(*) n FROM schema_migrations').n, 17);
    assert.equal(restored.get('SELECT COUNT(*) n FROM source_observation_epochs').n, 0);
    assert.deepEqual(restored.all('PRAGMA foreign_key_check'), []);
  } finally { restored.close(); }
});

test('schema-16 downgrade cannot strip committed schema-17 epoch markers and checkpoints', async t => {
  const h = await harness(t);
  await committedEpoch(h);
  const forged = exportPartner(h.store);
  forged.migrations = forged.migrations.slice(0, 16);
  delete forged.tables.source_observation_epochs;
  updateTableChecksum(forged);
  const { result } = importBundle(t, h, forged, 'forged-downgrade16');
  assert.notEqual(result.status, 0, 'removing the new table must not erase epoch authority evidence');
  assert.match(result.stderr, /SOURCE_TRANSPORT_OBSERVATION_EPOCH_INVALID/);
});

test('pending rebaseline authority is durably revoked on import and cannot be replayed', async t => {
  const h = await harness(t), authorization = await pendingAuthorization(h), bundle = exportPartner(h.store);
  const request = bundle.tables.events.find(row => row.kind === 'source.telegram.rebaseline.requested');
  assert.ok(request);
  const { result, destination } = importBundle(t, h, bundle, 'pending');
  assert.equal(result.status, 0, result.stderr);
  const restored = new Store(path.join(destination, 'data'));
  try {
    const authorizationId = authorization.authorization_id;
    const receipts = restored.all(`SELECT payload_json FROM events WHERE kind='source.telegram.rebaseline.finished'
      AND json_extract(payload_json,'$.authorization_id')=? ORDER BY id`, authorizationId).map(row => JSON.parse(row.payload_json));
    assert.equal(receipts.at(-1).status, 'revoked');
    assert.equal(receipts.at(-1).reason, 'TRANSFER_REVOKED');
    assert.equal(telegramRebaselineAuthorization(new BusinessService(restored, h.config), { ...sourcePolicy }), null,
      'the imported request cannot authorize a new reader cutover');
    assert.equal(restored.get('SELECT COUNT(*) n FROM source_observation_epochs').n, 0);
    assert.deepEqual(restored.all('PRAGMA foreign_key_check'), []);
  } finally { restored.close(); }
});

test('schema-16 downgrade cannot preserve an unresolved schema-17 request as active authority', async t => {
  const h = await harness(t), authorization = await pendingAuthorization(h), forged = exportPartner(h.store);
  forged.migrations = forged.migrations.slice(0, 16);
  delete forged.tables.source_observation_epochs;
  updateTableChecksum(forged);
  const { result, destination } = importBundle(t, h, forged, 'forged-downgrade16-pending');
  assert.equal(result.status, 0, result.stderr);
  const restored = new Store(path.join(destination, 'data'));
  try {
    const receipt = restored.get(`SELECT payload_json FROM events WHERE kind='source.telegram.rebaseline.finished'
      AND json_extract(payload_json,'$.authorization_id')=? ORDER BY id DESC LIMIT 1`, authorization.authorization_id);
    assert.ok(receipt, 'the retained request has a transfer-time terminal receipt');
    assert.equal(JSON.parse(receipt.payload_json).status, 'revoked');
    assert.equal(JSON.parse(receipt.payload_json).reason, 'TRANSFER_REVOKED');
    assert.equal(telegramRebaselineAuthorization(new BusinessService(restored, h.config), { ...sourcePolicy }), null,
      'the copied authorization is dead when the static Telegram source is attached again');
    assert.equal(restored.get('SELECT COUNT(*) n FROM source_observation_epochs').n, 0);
  } finally { restored.close(); }
});

test('schema-17 import rejects tampered epoch floor, hash, parent, event, checkpoint and bundle checksum', async t => {
  const h = await harness(t); await committedEpoch(h); const base = exportPartner(h.store);
  assert.equal(base.tables.source_observation_epochs.length, 2);
  const invalid = [
    { label: 'floor', edit: b => {
      const row = b.tables.source_observation_epochs[0];
      row.baseline_event_id = row.authorization_event_id; row.observation_floor = row.authorization_event_id;
    }, code: 'SOURCE_TRANSPORT_OBSERVATION_EPOCH_INVALID' },
    { label: 'hash', edit: b => { b.tables.source_observation_epochs[0].transition_sha256 = '0'.repeat(64); }, code: 'SOURCE_TRANSPORT_OBSERVATION_EPOCH_INVALID' },
    { label: 'parent', edit: b => { b.tables.source_observation_epochs[0].previous_epoch_id = id(); }, code: 'SOURCE_TRANSPORT_OBSERVATION_EPOCH_INVALID' },
    { label: 'event', edit: b => {
      const row = b.tables.source_observation_epochs[0]; row.baseline_event_id = 999999999; row.observation_floor = 999999999;
    }, code: 'SOURCE_TRANSPORT_OBSERVATION_EPOCH_INVALID' },
    { label: 'checkpoint', edit: b => {
      const row = b.tables.channel_offsets.find(x => x.channel === 'telegram-source-v0');
      const cursor = JSON.parse(row.cursor); cursor.baseline_hash = '0'.repeat(64); row.cursor = JSON.stringify(cursor);
    }, code: 'SOURCE_TRANSPORT_OBSERVATION_EPOCH_INVALID' },
    { label: 'checksum', edit: b => { b.tables.source_observation_epochs[0].observation_floor += 1; }, code: 'Table checksum mismatch', checksum: false },
  ];
  for (const item of invalid) {
    const bundle = structuredClone(base); item.edit(bundle);
    if (item.checksum !== false) updateTableChecksum(bundle);
    const { result } = importBundle(t, h, bundle, `tampered-${item.label}`);
    assert.notEqual(result.status, 0, `${item.label} mutation must fail closed`);
    assert.match(result.stderr, new RegExp(item.code), `${item.label} import rejection`);
  }
});
