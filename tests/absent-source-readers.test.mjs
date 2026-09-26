// The live soak found the one failure the poll telemetry could not see: after a reconnect the
// reader never started, so the poll loop had nothing to poll and the source sat at its last
// confirmed cursor for an hour while every other signal stayed green.
// proof_level=synthetic_contract_eval; live_proof=false. No model call, no network, no Telegram.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Scheduler } from '../business/scheduler.mjs';
import { sourceFailureCode } from '../business/channels/telegram-mtproto.mjs';
import { Store } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { loadConfig } from '../business/config.mjs';
import { bootstrapTelegramSource } from '../business/sources/telegram-readonly.mjs';

const sourceId = 'telegram:channel:100';
const otherSourceId = 'telegram:channel:200';

const policy = (id, accountId = '999') => ({ accountId, channelId: id.split(':').at(-1), sourceId: id,
  sourceKind: 'sanitized_fixture', processingBasis: 'Invented offline test only', maxLagSeconds: 120 });

const harness = async (t, { readers = [], configured = [sourceId], lastSourceCode = null } = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-absent-'));
  const store = new Store(directory);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const loaded = loadConfig();
  const cfg = { ...loaded, opportunity: { ...loaded.opportunity, automatic: true,
    telegramSources: configured.map((id) => policy(id)) },
    runtime: { ...loaded.runtime, enabled: false },
    telegram: { ...loaded.telegram, enabled: true, liveSending: false } };
  cfg.opportunity.allowedSourceRefs = configured;
  const service = new BusinessService(store, cfg);
  // A source that is not configured cannot be bootstrapped, and does not need to be: the point
  // of that case is that nothing was asked for in the first place.
  for (const id of configured) await bootstrapTelegramSource(service, id, { pts: 10, history: [] });
  const telegram = { lastSourceCode, readiness: () => ({ enabled: false, live_sending: false,
    connected: true, configured: true }) };
  const scheduler = new Scheduler(service, { close() {} }, telegram, readers);
  return { store, service, scheduler };
};

const events = (store, kind) => store.all('SELECT payload_json FROM events WHERE kind=?', kind);
const failing = (code) => ({ sourceId, transport: { readDifference: async () => {
  throw Object.assign(Error('down'), code ? { code } : {}); } } });

test('a configured source with no reader is reported, not silently skipped', async (t) => {
  // The live shape: the channel connected, the reader failed to start, and the scheduler was
  // handed an empty list. The poll loop then has nothing to iterate, so the failure telemetry
  // never fires either — and a source nobody is reading looks exactly like a quiet source.
  const { store, scheduler } = await harness(t, { readers: [] });
  await scheduler.tick();
  const rows = events(store, 'source.telegram.readers_absent');
  assert.equal(rows.length, 1, 'the absence of a reader is evidence, and it is recorded');
  assert.deepEqual(JSON.parse(rows[0].payload_json), { configured_sources: 1, active_readers: 0,
    missing_readers: 1, cause_code: 'SOURCE_READER_BOOTSTRAP_FAILED' });
  assert.equal(scheduler.lastReason, 'source_readers_absent:SOURCE_READER_BOOTSTRAP_FAILED',
    'the operator sees it in the status, not only in a table');
  // The failure telemetry must not also claim a poll failed: no poll was attempted.
  assert.equal(events(store, 'source.telegram.poll.failed').length, 0);
  assert.equal(scheduler.busy, false, 'the tick finished');
});

test('one live reader among several does not make a dead source look healthy', async (t) => {
  // Counting readers rather than comparing them is the blind spot this guards: 2 configured,
  // 1 raised, 1 dead, and a system that only counted would call that fine.
  const { store, scheduler } = await harness(t, { configured: [sourceId, otherSourceId],
    readers: [failing('UPSTREAM_DOWN')] });
  await scheduler.tick();
  const [row] = events(store, 'source.telegram.readers_absent');
  assert.deepEqual(JSON.parse(row.payload_json), { configured_sources: 2, active_readers: 1,
    missing_readers: 1, cause_code: 'SOURCE_READER_BOOTSTRAP_FAILED' });
  assert.equal(scheduler.lastReason, 'source_readers_absent:SOURCE_READER_BOOTSTRAP_FAILED');
  // The reader that did come up is still polled, and its own failure is still reported.
  assert.equal(events(store, 'source.telegram.poll.failed').length, 1);
});

test('the absence is recorded once, not once per tick', async (t) => {
  const { store, scheduler } = await harness(t, { readers: [] });
  for (let i = 0; i < 5; i += 1) await scheduler.tick();
  assert.equal(events(store, 'source.telegram.readers_absent').length, 1,
    'a tick every twenty seconds must not become a flood of events');
  // A later tick that does find every reader clears the latch, so a reader coming back is quiet.
  scheduler.sourceReaders = [{ sourceId, transport: { readDifference: async () => ({}) } }];
  await scheduler.tick();
  assert.equal(scheduler.readersAbsentReported, false, 'the latch clears when a reader returns');
});

test('a source that is not configured is not an absent reader', async (t) => {
  // The list is empty by default, and empty is the safe state. Only a source that was asked for
  // and not delivered is a fault.
  const { store, scheduler } = await harness(t, { readers: [], configured: [] });
  await scheduler.tick();
  assert.equal(events(store, 'source.telegram.readers_absent').length, 0);
});

test('readers present for every configured source means no absence event', async (t) => {
  const { store, scheduler } = await harness(t, { readers: [failing('UPSTREAM_DOWN')] });
  await scheduler.tick();
  assert.equal(events(store, 'source.telegram.readers_absent').length, 0,
    'a reader that answered is not an absent reader');
  assert.equal(events(store, 'source.telegram.poll.failed').length, 1,
    'the poll failure is reported by the telemetry that already exists');
  assert.equal(scheduler.lastReason, 'source_read_failed:UPSTREAM_DOWN');
});

test('the cause shown is a code, and the message behind it never leaves', async (t) => {
  // `resolveInputChannel` can fail with an SDK error whose message carries provider and peer
  // detail. Only a code already shaped like one of ours may be shown; everything else is one class.
  const { store, scheduler } = await harness(t, { readers: [],
    lastSourceCode: 'CHANNEL_INVALID' });
  await scheduler.tick();
  assert.equal(scheduler.lastReason, 'source_readers_absent:CHANNEL_INVALID');
  assert.equal(JSON.parse(events(store, 'source.telegram.readers_absent')[0].payload_json).cause_code,
    'CHANNEL_INVALID');
  for (const code of ['provider said no: sk-live-abcdef', 'lowercase_code', '', 'X', null, 42])
    assert.equal(sourceFailureCode({ code }), 'SOURCE_READER_BOOTSTRAP_FAILED', `${code} must not pass`);
  assert.equal(sourceFailureCode({ code: 'SOURCE_ACCOUNT_MISMATCH' }), 'SOURCE_ACCOUNT_MISMATCH');
  assert.equal(sourceFailureCode({}), 'SOURCE_READER_BOOTSTRAP_FAILED');
});

test('telemetry that cannot be written does not stop the tick', async (t) => {
  const { store, scheduler } = await harness(t, { readers: [] });
  const original = store.event.bind(store);
  store.event = (...args) => {
    if (args[2] === 'source.telegram.readers_absent') throw new Error('db down');
    return original(...args);
  };
  await scheduler.tick();
  assert.equal(scheduler.lastReason, 'source_readers_absent:SOURCE_READER_BOOTSTRAP_FAILED',
    'the reason still reaches the operator');
  assert.equal(scheduler.busy, false, 'the tick finished');
  store.event = original;
});

test('the scheduler is told what came up even when a reader does not', async () => {
  // The root of it. Publishing only on the success path left the scheduler holding the empty
  // list it was constructed with, so a failed reader and a healthy source looked the same.
  const { MtprotoTelegramChannel } = await import('../business/channels/telegram-mtproto.mjs');
  const published = [];
  const service = { config: { opportunity: { telegramSources: [policy(sourceId)] } } };
  const channel = new MtprotoTelegramChannel(service);
  channel.accountId = '999';
  channel.client = { connected: true, invoke: async () => ({}), addEventHandler: () => {}, removeEventHandler: () => {}, getEntity: async () => {
    throw Object.assign(new Error('peer lookup failed, key sk-live-abcdef'), { code: 'PEER_ID_INVALID' });
  } };
  channel.onSourcesReady = (readers) => published.push(readers);
  await assert.rejects(() => channel.startSourceReaders(), /peer lookup failed/,
    'the failure still propagates: this publishes state, it does not swallow the fault');
  assert.deepEqual(published, [[]], 'the scheduler is handed the truth: nothing came up');
  // The same catch the connect path uses, and the same classification.
  await channel.startSourceReaders().catch(error => { channel.lastSourceCode = sourceFailureCode(error); });
  assert.equal(channel.lastSourceCode, 'PEER_ID_INVALID');
});

test('a source belonging to another account is named, and does not throw', async () => {
  const { MtprotoTelegramChannel } = await import('../business/channels/telegram-mtproto.mjs');
  const published = [];
  const service = { config: { opportunity: { telegramSources: [policy(sourceId, '999')] } } };
  const channel = new MtprotoTelegramChannel(service);
  channel.accountId = '111';
  channel.client = { connected: true, invoke: async () => ({}), addEventHandler: () => {}, removeEventHandler: () => {}, getEntity: async () => { throw new Error('must not be reached'); } };
  channel.onSourcesReady = (readers) => published.push(readers);
  await channel.startSourceReaders();
  assert.deepEqual(published, [[]]);
  assert.equal(channel.lastSourceCode, 'SOURCE_ACCOUNT_MISMATCH',
    'a fixed code, never the message that names the source');
});
