import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT, scoutHarness } from './scout-test-helpers.mjs';
import { telegramRead, telegramReadState } from '../business/telegram-read-gate.mjs';

const sourceId = 'telegram:channel:123456789';
const gateRow = h => h.store.get("SELECT cursor FROM channel_offsets WHERE channel='telegram-account-read-v1' AND account_id=?",
  `${h.config.partnerId}:${ACCOUNT}`);
const read = (h, priority, id = sourceId) => telegramRead(h.service,
  { accountId: ACCOUNT, sourceId: id, priority }, async () => true);

test('per-source audit reserve leaves the remaining hard cap for monitor reads', async t => {
  const h = scoutHarness(t); h.config.scout.maxRequestsPerDay = 30; h.config.scout.maxRequestsPerSourceDay = 10;
  await read(h, 'audit'); await read(h, 'search');
  await assert.rejects(read(h, 'audit'), { code: 'SCOUT_READ_BUDGET' }, 'only two of ten per-source reads are allocated to audit/search');
  const state = JSON.parse(gateRow(h).cursor);
  assert.equal(state.sources[sourceId], 2); assert.equal(state.audit_sources[sourceId], 2);
  for (let i = 0; i < 8; i++) await read(h, 'monitor');
  await assert.rejects(read(h, 'monitor'), { code: 'SCOUT_READ_BUDGET' }, 'the shared source hard cap still includes all read classes');
  assert.equal(JSON.parse(gateRow(h).cursor).sources[sourceId], 10);
});

test('monitor-first traffic preserves audit allocation and the audit counter survives restart', async t => {
  const h = scoutHarness(t); h.config.scout.maxRequestsPerDay = 30; h.config.scout.maxRequestsPerSourceDay = 10;
  for (let i = 0; i < 8; i++) await read(h, 'monitor');
  for (let i = 0; i < 2; i++) await read(h, 'audit');
  const stored = JSON.parse(gateRow(h).cursor);
  assert.equal(stored.sources[sourceId], 10); assert.equal(stored.audit_sources[sourceId], 2);
  h.restart();
  assert.equal(telegramReadState(h.service, ACCOUNT, { sourceId, priority: 'audit' }).audit_sources[sourceId], 2);
  await assert.rejects(read(h, 'audit'), { code: 'SCOUT_READ_BUDGET' });
  assert.equal(JSON.parse(gateRow(h).cursor).sources[sourceId], 10);
});

test('malformed per-source audit accounting fails closed', t => {
  const h = scoutHarness(t); h.config.scout.maxRequestsPerDay = 30; h.config.scout.maxRequestsPerSourceDay = 10;
  h.store.run('INSERT INTO channel_offsets(channel,account_id,cursor) VALUES(?,?,?)', 'telegram-account-read-v1',
    `${h.config.partnerId}:${ACCOUNT}`, JSON.stringify({ day: new Date().toISOString().slice(0, 10), requests: 0,
      audit_requests: 0, sources: {}, audit_sources: [], retry_at: null }));
  assert.throws(() => telegramReadState(h.service, ACCOUNT, { sourceId, priority: 'audit' }), { code: 'SCOUT_READ_GATE_INVALID' });
});

test('legacy source totals are conservatively charged to audit allocation', async t => {
  const h = scoutHarness(t); h.config.scout.maxRequestsPerDay = 30; h.config.scout.maxRequestsPerSourceDay = 10;
  h.store.run('INSERT INTO channel_offsets(channel,account_id,cursor) VALUES(?,?,?)', 'telegram-account-read-v1',
    `${h.config.partnerId}:${ACCOUNT}`, JSON.stringify({ day: new Date().toISOString().slice(0, 10), requests: 2,
      audit_requests: 0, sources: { [sourceId]: 2 }, retry_at: null }));
  const legacy = telegramReadState(h.service, ACCOUNT, { sourceId, priority: 'audit' });
  assert.equal(legacy.audit_sources[sourceId], 2);
  await assert.rejects(read(h, 'audit'), { code: 'SCOUT_READ_BUDGET' }, 'an old source total cannot be reclassified as fresh monitor traffic');
  await read(h, 'monitor');
  const migrated = JSON.parse(gateRow(h).cursor);
  assert.equal(migrated.sources[sourceId], 3); assert.equal(migrated.audit_sources[sourceId], 2);
  await assert.rejects(read(h, 'audit'), { code: 'SCOUT_READ_BUDGET' });
});

test('source cap one grants zero audit capacity and one monitor read', async t => {
  const h = scoutHarness(t); h.config.scout.maxRequestsPerDay = 10; h.config.scout.maxRequestsPerSourceDay = 1;
  await assert.rejects(read(h, 'audit'), { code: 'SCOUT_READ_BUDGET' });
  assert.equal(gateRow(h), undefined, 'denial does not persist or charge an adapter call');
  await read(h, 'monitor');
  await assert.rejects(read(h, 'monitor'), { code: 'SCOUT_READ_BUDGET' });
  const state = JSON.parse(gateRow(h).cursor);
  assert.equal(state.sources[sourceId], 1); assert.equal(state.audit_sources[sourceId] ?? 0, 0);
});
