// The live soak found the one failure the poll telemetry could not see: after a reconnect the
// reader never started, so the poll loop iterated zero times and the source sat at its last
// confirmed cursor for an hour while every other signal stayed green.
// proof_level=synthetic_contract_eval; live_proof=false. No model call, no network, no Telegram.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Scheduler } from '../business/scheduler.mjs';
import { Store } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { loadConfig } from '../business/config.mjs';
import { bootstrapTelegramSource } from '../business/sources/telegram-readonly.mjs';

const sourceId = 'telegram:channel:100';

const harness = async (t, { readers, configured = true }) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-absent-'));
  const store = new Store(directory);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const loaded = loadConfig();
  const cfg = { ...loaded, opportunity: { ...loaded.opportunity, automatic: true },
    runtime: { ...loaded.runtime, enabled: false },
    telegram: { ...loaded.telegram, enabled: true, liveSending: false } };
  if (configured) cfg.opportunity.telegramSources = [{ accountId: '999', channelId: '100', sourceId,
    sourceKind: 'sanitized_fixture', processingBasis: 'Invented offline test only', maxLagSeconds: 120 }];
  else cfg.opportunity.telegramSources = [];
  cfg.opportunity.allowedSourceRefs = [sourceId];
  const service = new BusinessService(store, cfg);
  // A source that is not configured cannot be bootstrapped, and does not need to be: the point
  // of that case is that nothing was asked for in the first place.
  if (configured) await bootstrapTelegramSource(service, sourceId, { pts: 10, history: [] });
  const telegram = { readiness: () => ({ enabled: false, live_sending: false, connected: true,
    configured: true }) };
  const scheduler = new Scheduler(service, { close() {} }, telegram, readers);
  return { store, service, scheduler, cfg };
};

const events = (store, kind) => store.all('SELECT payload_json FROM events WHERE kind=?', kind);

test('a configured source with no reader is reported, not silently skipped', async (t) => {
  // The live shape: the channel connected, the reader failed to start, and the scheduler was
  // handed an empty list. The poll loop iterates zero times, so the failure telemetry never
  // fires either — and a source nobody is reading looks exactly like a quiet source.
  const { store, scheduler } = await harness(t, { readers: [] });
  await scheduler.tick();
  const rows = events(store, 'source.telegram.readers_absent');
  assert.equal(rows.length, 1, 'the absence of a reader is evidence, and it is recorded');
  assert.deepEqual(JSON.parse(rows[0].payload_json), { configured_sources: 1 });
  assert.equal(scheduler.lastReason, 'source_readers_absent',
    'the operator sees it in the status, not only in a table');
  // The failure telemetry must not also claim a poll failed: no poll was attempted.
  assert.equal(events(store, 'source.telegram.poll.failed').length, 0);
  assert.equal(scheduler.busy, false, 'the tick finished');
});

test('the absence is recorded once, not once per tick', async (t) => {
  const { store, scheduler } = await harness(t, { readers: [] });
  for (let i = 0; i < 5; i += 1) await scheduler.tick();
  assert.equal(events(store, 'source.telegram.readers_absent').length, 1,
    'a tick every twenty seconds must not become a flood of events');
  // A later tick that does find readers clears the latch, so a reader coming back is not silent.
  scheduler.sourceReaders = [{ sourceId, transport: { readDifference: async () => ({ kind: 'empty',
    kindOfPage: 'empty', account_id: '999', channel_id: '100', from_pts: 10, to_pts: 10, final: true,
    updates: [], contract_version: 'TELEGRAM_COUNTERLESS' }) } }];
  await scheduler.tick();
  assert.equal(scheduler.readersAbsentReported, false, 'the latch clears when a reader returns');
});

test('a source that is not configured is not an absent reader', async (t) => {
  // The list is empty by default, and empty is the safe state. Only a source that was asked for
  // and not delivered is a fault.
  const { store, scheduler } = await harness(t, { readers: [], configured: false });
  await scheduler.tick();
  assert.equal(events(store, 'source.telegram.readers_absent').length, 0);
});

test('readers present means no absence event, whatever the poll then does', async (t) => {
  const { store, scheduler } = await harness(t, { readers: [{ sourceId,
    transport: { readDifference: async () => { throw Object.assign(Error('down'), { code: 'UPSTREAM_DOWN' }); } } }] });
  await scheduler.tick();
  assert.equal(events(store, 'source.telegram.readers_absent').length, 0,
    'a reader that answered is not an absent reader');
  assert.equal(events(store, 'source.telegram.poll.failed').length, 1,
    'the poll failure is reported by the telemetry that already exists');
  assert.equal(scheduler.lastReason, 'source_read_failed:UPSTREAM_DOWN');
});

test('telemetry that cannot be written does not stop the tick', async (t) => {
  const { store, service, scheduler } = await harness(t, { readers: [] });
  const original = store.event.bind(store);
  store.event = (...args) => { if (args[2] === 'source.telegram.readers_absent') throw new Error('db down'); return original(...args); };
  await scheduler.tick();
  assert.equal(scheduler.lastReason, 'source_readers_absent', 'the reason still reaches the operator');
  assert.ok(service, 'the tick completed');
  store.event = original;
});
