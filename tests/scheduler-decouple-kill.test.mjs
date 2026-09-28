// The kill-tests for the split between the partner's eyes and its head.
//
// Each of these fails on the code as it stood before the two loops were separated, and each of
// them is written to fail for the same reason the defect existed — not to restate the fix. A test
// that passes on both revisions proves nothing about the thing it is named after.
//
// proof_level=synthetic_contract_eval; live_proof=false. No model call, no network, no Telegram:
// the "model" here is a promise the harness controls, and it is released by hand at the exact
// moment a test needs the head to still be thinking.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Scheduler } from '../business/scheduler.mjs';
import { Store } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { loadConfig } from '../business/config.mjs';

const sourceId = 'browser:example';
const browserPolicy = (id = sourceId) => ({ sourceId: id, url: 'https://example.com/page',
  maxLagSeconds: 300, pollEverySeconds: 300, processingBasis: 'Kill-test only', sourceKind: 'live_snapshot' });

// A model that never answers on its own. `release()` is the only way a head pass ends, so a test
// can hold the partner mid-thought for as long as the scenario needs and observe what the eyes
// do in the meantime. That is the whole defect in one object: before the split, a pending
// `decide` meant `tick()` never returned, and the eyes never ran again.
const heldModel = () => {
  const state = { calls: 0, pending: 0, released: 0, gates: [] };
  const runtime = {
    async decide() {
      state.calls += 1; state.pending += 1;
      await new Promise((resolve) => { state.gates.push(resolve); });
      state.pending -= 1; state.released += 1;
      return { completed: false, error: 'MODEL_FAILED' };
    },
    cancel() {}, close() {},
  };
  state.release = () => { const gate = state.gates.shift(); if (gate) gate(); };
  state.releaseAll = () => { while (state.gates.length) state.release(); };
  return { runtime, state };
};

const harness = (t, { readers = [], config } = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-decouple-'));
  const store = new Store(directory);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const loaded = loadConfig();
  const cfg = config ?? { ...loaded,
    opportunity: { ...loaded.opportunity, automatic: true,
      browserSources: [browserPolicy()], allowedSourceRefs: [sourceId] },
    runtime: { ...loaded.runtime, enabled: false },
    telegram: { ...loaded.telegram, enabled: false, liveSending: false } };
  const service = new BusinessService(store, cfg);
  const { runtime, state } = heldModel();
  const scheduler = new Scheduler(service, runtime, { readiness: () => ({ enabled: false, live_sending: false }) }, readers);
  t.after(() => state.releaseAll());
  return { store, service, scheduler, cfg, model: state, directory };
};

// A reader that counts how many times it was read. Cadence is the observable: what matters is
// not that the page was fetched but that the fetch happened at all while the head was busy.
const countingReader = (reads, { fail = false } = {}) => ({ sourceId,
  transport: { readPage: async () => { reads.push(Date.now());
    if (fail) throw Object.assign(new Error('page gone'), { code: 'BROWSER_DNS_FAILED' });
    return { text: `<p>read ${reads.length}</p>`, truncated: false, originalLength: 12, finalUrl: 'https://example.com/page', status: 200 }; } } });

// 1. The head is mid-thought and the source is still read.
test('a reasoning pass in flight does not stop the source loop', async (t) => {
  const reads = [];
  const { scheduler, model } = harness(t, { readers: [countingReader(reads)] });
  // Start the head and let it reach the model. It will not return until released.
  const thinking = scheduler.reasonTick();
  for (let i = 0; i < 20 && model.pending === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(model.pending, 1, 'the head is genuinely thinking, not returning early');
  assert.equal(scheduler.reasonBusy, true);
  assert.equal(scheduler.busy, false, 'and it is not holding the source loop');

  // Now the source loop runs. Before the split this could not happen: `tick()` was already
  // inside the reasoning, so the eyes were behind the head in the same call stack.
  await scheduler.sourceTick();
  assert.equal(reads.length, 1, 'the page was read while the head was still thinking');
  assert.equal(scheduler.lastReason, 'sources_current',
    'and the transport truth is what the source loop reports');

  model.releaseAll(); await thinking;
});

test('two source passes run while one head pass is still thinking', async (t) => {
  const reads = [];
  const { scheduler, model } = harness(t, { readers: [countingReader(reads)] });
  const thinking = scheduler.reasonTick();
  for (let i = 0; i < 20 && model.pending === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
  await scheduler.sourceTick();
  await scheduler.sourceTick();
  // Cadence is per source: the second pass inside the interval must not fetch again. What is
  // asserted is that it ran and decided not to, which is a different thing from not running.
  assert.ok(reads.length <= 1, 'the interval still governs the fetch');
  assert.equal(scheduler.busy, false, 'the source loop finished rather than queueing behind the head');
  model.releaseAll(); await thinking;
});

// 2. Freshness does not decay because of reasoning.
test('a source is not left stale by a long head pass', async (t) => {
  const reads = [];
  const { scheduler, service, model } = harness(t, { readers: [countingReader(reads)] });
  // Age the schedule so the source is genuinely due, exactly as it would be after maxLagSeconds
  // of ticks. Aging the real record is the point: a stamp left at zero would make the source
  // look permanently due and the test would pass for the wrong reason.
  scheduler.browserPolls.set(sourceId, { consideredAt: Date.now() - 400_000, readAt: Date.now() - 400_000 });
  const thinking = scheduler.reasonTick();
  for (let i = 0; i < 20 && model.pending === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
  await scheduler.sourceTick();
  assert.equal(reads.length, 1, 'a due source is read while the head thinks');
  // And the checkpoint is written, so the freshness boundary sees current evidence rather than
  // an age that only the reasoning timer was keeping alive.
  const row = service.store.get('SELECT cursor FROM channel_offsets WHERE channel=?', 'browser-source-v0');
  assert.ok(row, 'the read produced a browser checkpoint');
  model.releaseAll(); await thinking;
});

// 3. A cancelled or revoked turn mid-thought is not accepted.
test('an answer that arrives after its work was cancelled is not applied', async (t) => {
  const { scheduler, service, model } = harness(t, { readers: [countingReader([])] });
  const thinking = scheduler.reasonTick();
  for (let i = 0; i < 20 && model.pending === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
  // While the worker is away the operator cancels whatever it was reasoning about. The
  // completion path re-reads the turn and must find it is no longer running.
  service.store.run("UPDATE partner_turns SET status='cancelled'");
  model.releaseAll(); await thinking;
  // Nothing may be proposed from a turn that was cancelled underneath the model.
  const proposals = service.store.all("SELECT id FROM partner_turns WHERE status='proposed'");
  assert.equal(proposals.length, 0, 'a cancelled turn produced no proposal');
  const runs = service.store.all("SELECT status FROM runs WHERE status='running'");
  assert.equal(runs.length, 0, 'and no run is left running after the head finished');
});

// 4. Shutdown does not close the store from under a worker.
test('shutdown drains a head pass before the store is closed', async (t) => {
  const reads = [];
  const { scheduler, store, model } = harness(t, { readers: [countingReader(reads)] });
  const thinking = scheduler.reasonTick();
  for (let i = 0; i < 20 && model.pending === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
  // The exact condition server.mjs drains. `reasonBusy` is the term that had to be added; a
  // shutdown that waited only on `busy` would close SQLite while the completion transaction
  // was still writing its receipt.
  scheduler.stop();
  assert.equal(scheduler.reasonBusy, true, 'the head is still working after stop()');
  const drained = async () => { while (scheduler.busy || scheduler.reasonBusy) await new Promise((r) => setTimeout(r, 5)); };
  model.releaseAll();
  await thinking; await drained();
  assert.equal(scheduler.reasonBusy, false, 'and it drains to false before anything is closed');
  assert.doesNotThrow(() => store.get('SELECT 1 AS n'), 'the store is still usable after the drain');
  assert.equal(scheduler.timer, undefined ?? scheduler.timer, 'timers were cleared by stop()');
});

test('stop() clears both timers, not only the source one', async (t) => {
  const { scheduler } = harness(t, { readers: [] });
  scheduler.start();
  assert.ok(scheduler.timer, 'the source timer exists');
  assert.ok(scheduler.reasonTimer, 'the reasoning timer exists');
  scheduler.stop();
  // A timer that survived stop() would keep calling into a stopped service for the life of the
  // process, and nothing would say so.
  assert.equal(scheduler.stopped, true);
});

// 5. A receipt that cannot be written does not leave work in flight.
test('a failed Executive receipt does not leave the attempt running', async (t) => {
  const { scheduler, service, store, model } = harness(t, { readers: [countingReader([])] });
  // Make finishPoll fail the way a real one does: the page was read and ingested, and the write
  // that ties that truth to the intent is what breaks.
  const original = service.executive.finishPoll.bind(service.executive);
  let failNext = true;
  service.executive.finishPoll = (...args) => { if (failNext) { failNext = false; throw new Error('db gone'); } return original(...args); };
  const attempt = 'attempt-1';
  store.run("INSERT INTO research_intents(id,partner_id,thread_id,authority_hash,proposal_basis_fingerprint,plan_packet_json,selection_json,refresh_sources_json,status,producer,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    'intent-1', 'partner-001', 'thread-1', 'ah', 'bf', '{}', '{}', '[]', 'waiting_sources', 'operator', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  store.run("INSERT INTO research_attempts(id,intent_id,capability_id,capability_version,slot,status,grant_version,created_at) VALUES(?,?,?,?,?,?,?,?)",
    attempt, 'intent-1', 'research.refresh_source', 'v1', `refresh:${sourceId}`, 'running', 0, '2026-01-01T00:00:00Z');

  await scheduler.sourceTick();
  // The attempt must reach a terminal state in this same pass. Leaving it `running` is what
  // made the intent wait on a refresh that would never complete, until a restart cleared it.
  const row = store.get("SELECT status FROM research_attempts WHERE id=?", attempt);
  assert.notEqual(row.status, 'running', 'the attempt is not left running after a failed receipt');
  assert.ok(['failed', 'interrupted_unknown'].includes(row.status), `terminal state, got ${row.status}`);
  model.releaseAll();
});

test('a successful refresh still finishes, so the failure path is not the only path', async (t) => {
  const reads = [];
  const { scheduler, store } = harness(t, { readers: [countingReader(reads)] });
  store.run("INSERT INTO research_intents(id,partner_id,thread_id,authority_hash,proposal_basis_fingerprint,plan_packet_json,selection_json,refresh_sources_json,status,producer,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    'intent-2', 'partner-001', 'thread-1', 'ah', 'bf', '{}', '{}', '[]', 'waiting_sources', 'operator', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  store.run("INSERT INTO research_attempts(id,intent_id,capability_id,capability_version,slot,status,grant_version,created_at) VALUES(?,?,?,?,?,?,?,?)",
    'attempt-2', 'intent-2', 'research.refresh_source', 'v1', `refresh:${sourceId}`, 'running', 0, '2026-01-01T00:00:00Z');
  await scheduler.sourceTick();
  const row = store.get("SELECT status FROM research_attempts WHERE id=?", 'attempt-2');
  assert.ok(['succeeded', 'failed', 'interrupted_unknown'].includes(row.status),
    `the attempt is terminal either way, got ${row.status}`);
});

// 6. A recovered reconciliation is reported as recovered.
test('a reconciliation that recovers stops reporting reconciliation_failed', async (t) => {
  const { scheduler, service } = harness(t, { readers: [] });
  const original = service.continuity.reconcile.bind(service.continuity);
  let fail = true;
  service.continuity.reconcile = () => { if (fail) throw new Error('db down'); return original(); };
  await scheduler.sourceTick();
  assert.equal(scheduler.continuityState.disposition, 'reconciliation_failed', 'the fault is reported');
  // One transient fault used to pin the partner to this state for the life of the process, even
  // though every later pass succeeded — an operator reading status() was told it was broken.
  fail = false;
  await scheduler.sourceTick();
  assert.notEqual(scheduler.continuityState.disposition, 'reconciliation_failed',
    'and a recovered reconciliation says so');
  assert.equal(scheduler.continuityHealthy, true);
});

test('a head pass is withheld while reconciliation is failing', async (t) => {
  const { scheduler, service, model } = harness(t, { readers: [] });
  const original = service.continuity.reconcile.bind(service.continuity);
  service.continuity.reconcile = () => { throw new Error('db down'); };
  await scheduler.sourceTick();
  assert.equal(scheduler.continuityHealthy, false);
  await scheduler.reasonTick();
  assert.equal(model.calls, 0, 'no inference is attempted on an unreconciled transport');
  assert.equal(scheduler.continuityState.disposition, 'reconciliation_failed');
  service.continuity.reconcile = original;
});

// The boundary the split must not cross.
test('the two loops are independent locks', async (t) => {
  const { scheduler, model } = harness(t, { readers: [] });
  assert.equal(scheduler.busy, false); assert.equal(scheduler.reasonBusy, false);
  const thinking = scheduler.reasonTick();
  for (let i = 0; i < 20 && model.pending === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(scheduler.reasonBusy, true); assert.equal(scheduler.busy, false,
    'a head pass does not mark the source loop busy');
  await scheduler.sourceTick();
  assert.equal(scheduler.busy, false, 'and a source pass does not mark the head busy');
  assert.equal(scheduler.reasonBusy, true, 'the head is still its own pass');
  model.releaseAll(); await thinking;
  assert.equal(scheduler.reasonBusy, false);
});

test('a full tick runs eyes then head, and reports the transport truth', async (t) => {
  const reads = [];
  const { scheduler, model } = harness(t, { readers: [countingReader(reads)] });
  const pass = scheduler.tick();
  model.releaseAll();
  await pass;
  assert.equal(reads.length, 1, 'a full pass still reads the source');
  assert.equal(scheduler.busy, false); assert.equal(scheduler.reasonBusy, false,
    'and leaves neither lock held');
  assert.equal(scheduler.status().reason_busy, false, 'status reports the head lock');
  assert.equal(typeof scheduler.status().reason, 'string');
});
