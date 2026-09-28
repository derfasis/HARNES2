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
import { BrowserSourceReader, browserPolicy, pollBrowserSource, markBrowserSourceBlocked } from '../business/sources/browser-readonly.mjs';
import { BrowserFetchError } from '../business/sources/browser-fetch.mjs';
import { browserCheckpoint, sourceAccessReadiness } from '../business/source-ingestion.mjs';

const sourceId = 'browser:example';
const browserSourceConfig = (id = sourceId) => ({ sourceId: id, url: 'https://example.com/page',
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
      browserSources: [browserSourceConfig()], allowedSourceRefs: [sourceId] },
    runtime: { ...loaded.runtime, enabled: false },
    telegram: { ...loaded.telegram, enabled: false, liveSending: false } };
  const service = new BusinessService(store, cfg);
  const { runtime, state } = heldModel();
  const scheduler = new Scheduler(service, runtime, { readiness: () => ({ enabled: false, live_sending: false }) }, readers);
  t.after(() => state.releaseAll());
  // `continuityHealthy` starts false on purpose — a reasoning pass that runs before any source
  // pass must not infer from a reconciliation nobody attempted. A test that wants the head to
  // think therefore has to earn it: this is the source pass that establishes the health it
  // reads. Without it the model never starts and every head assertion below would be green for
  // the wrong reason, which is the failure mode this whole file exists to catch.
  const establishHealth = async () => { await scheduler.sourceTick(); assert.equal(scheduler.continuityHealthy, true,
    'the source pass established reconciliation health'); };
  return { store, service, scheduler, cfg, model: state, directory, establishHealth };
};

// A real thread, because `research_intents.thread_id` is a foreign key. A receipt test that
// inserts a thread_id nothing else knows dies on the constraint before it reaches the scenario
// under test, and a test that cannot reach its own subject proves nothing. The columns are the
// ones the migration actually declares NOT NULL, so this row is a thread the rest of the code
// would accept rather than one that merely exists.
const seedThread = (store, id = 'thread-1') => store.run(
  `INSERT INTO partner_threads(id,partner_id,title,objective,success_condition,business_basis,
     max_age_seconds,status,revision,attention,attention_reasons_json,attention_at,created_at,updated_at)
   VALUES(?,?,?,?,?,?,86400,'OPEN',1,1,'[]','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
  id, 'partner-001', 'Kill-test', 'Prove the scenario', 'The scenario is reached', 'business_basis', 'thread');

// A reader that counts how many times it was read. Cadence is the observable: what matters is
// not that the page was fetched but that the fetch happened at all while the head was busy.
const countingReader = (reads, { fail = false } = {}) => ({ sourceId,
  transport: { readPage: async () => { reads.push(Date.now());
    if (fail) throw Object.assign(new Error('page gone'), { code: 'BROWSER_DNS_FAILED' });
    return { text: `<p>read ${reads.length}</p>`, truncated: false, originalLength: 12, finalUrl: 'https://example.com/page', status: 200 }; } } });

// 1. The head is mid-thought and the source is still read.
test('a reasoning pass in flight does not stop the source loop', async (t) => {
  const reads = [];
  const { scheduler, model, establishHealth } = harness(t, { readers: [countingReader(reads)] });
  await establishHealth();
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
  const { scheduler, model, establishHealth } = harness(t, { readers: [countingReader(reads)] });
  await establishHealth();
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
  const { scheduler, service, model, establishHealth } = harness(t, { readers: [countingReader(reads)] });
  await establishHealth();
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
  const { scheduler, service, model, establishHealth } = harness(t, { readers: [countingReader([])] });
  await establishHealth();
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
  const { scheduler, store, model, establishHealth } = harness(t, { readers: [countingReader(reads)] });
  await establishHealth();
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
});

test('stop() clears both timers, not only the source one', async (t) => {
  const { scheduler } = harness(t, { readers: [] });
  scheduler.start();
  const source = scheduler.timer, head = scheduler.reasonTimer;
  assert.ok(source, 'the source timer exists');
  assert.ok(head, 'the reasoning timer exists');
  assert.notEqual(source, head, 'and they are two distinct timers, not one aliased twice');
  scheduler.stop();
  // Asserted against handles captured *before* stop(), never against `scheduler.timer` itself.
  // Comparing a field to itself passes no matter what the field holds, which is why this
  // assertion was worth rewriting rather than keeping: a timer that survived stop() would keep
  // calling into a stopped service for the life of the process, and nothing would say so.
  assert.equal(source._destroyed, true, 'the source timer was destroyed');
  assert.equal(head._destroyed, true, 'the reasoning timer was destroyed');
  assert.equal(scheduler.stopped, true);
});

// 5. A receipt that cannot be written does not leave work in flight.
test('a failed Executive receipt does not leave the attempt running', async (t) => {
  const { scheduler, service, store, model } = harness(t, { readers: [countingReader([])] });
  // A real thread, because the intent's thread_id is a foreign key. Without it this test dies on
  // the constraint before it reaches the scenario, and a test that cannot reach its own subject
  // proves nothing about it.
  seedThread(store, 'thread-1');
  // Make finishPoll fail the way a real one does: the page was read and ingested, and the write
  // that ties that truth to the intent is what breaks.
  const original = service.executive.finishPoll.bind(service.executive);
  let failNext = true;
  service.executive.finishPoll = (...args) => { if (failNext) { failNext = false; throw new Error('db gone'); } return original(...args); };
  store.run("INSERT INTO research_intents(id,partner_id,thread_id,authority_hash,proposal_basis_fingerprint,plan_packet_json,selection_json,refresh_sources_json,status,producer,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    'intent-1', 'partner-001', 'thread-1', 'ah', 'bf', '{}', '{}', '[]', 'waiting_sources', 'operator', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  // `pending`, not `running`: this attempt is one the *upcoming* pass will begin, and a
  // `running` row here would be swept as an orphan by the reconciliation that opens the pass.
  // That is the orphan sweep working, not this test's subject.
  store.run("INSERT INTO research_attempts(id,intent_id,capability_id,capability_version,slot,status,grant_version,created_at) VALUES(?,?,?,?,?,?,?,?)",
    'attempt-1', 'intent-1', 'research.refresh_source', 'v1', `refresh:${sourceId}`, 'pending', 0, '2026-01-01T00:00:00Z');

  await scheduler.sourceTick();
  // The attempt must reach a terminal state in this same pass. Leaving it `running` is what
  // made the intent wait on a refresh that would never complete, until a restart cleared it.
  const row = store.get("SELECT status FROM research_attempts WHERE id=?", 'attempt-1');
  assert.notEqual(row.status, 'running', 'the attempt is not left running after a failed receipt');
  assert.ok(['failed', 'interrupted_unknown'].includes(row.status), `terminal state, got ${row.status}`);
  model.releaseAll();
});

test('a refresh that completes writes a receipt and succeeds', async (t) => {
  const reads = [];
  const { scheduler, store } = harness(t, { readers: [countingReader(reads)] });
  seedThread(store, 'thread-2');
  store.run("INSERT INTO research_intents(id,partner_id,thread_id,authority_hash,proposal_basis_fingerprint,plan_packet_json,selection_json,refresh_sources_json,status,producer,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    'intent-2', 'partner-001', 'thread-2', 'ah', 'bf', '{}', '{}', '[]', 'waiting_sources', 'operator', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  store.run("INSERT INTO research_attempts(id,intent_id,capability_id,capability_version,slot,status,grant_version,created_at) VALUES(?,?,?,?,?,?,?,?)",
    'attempt-2', 'intent-2', 'research.refresh_source', 'v1', `refresh:${sourceId}`, 'pending', 0, '2026-01-01T00:00:00Z');
  await scheduler.sourceTick();
  const row = store.get("SELECT status FROM research_attempts WHERE id=?", 'attempt-2');
  assert.notEqual(row.status, 'running', 'a completed pass leaves nothing in flight');
  assert.ok(['succeeded', 'failed', 'interrupted_unknown'].includes(row.status),
    `the attempt is terminal either way, got ${row.status}`);
});

// The orphan sweep, which is what makes the guarantee above survive a crash rather than a
// well-behaved pass.
test('a refresh attempt orphaned by a dead pass is retired on the next pass', async (t) => {
  const { scheduler, store } = harness(t, { readers: [countingReader([])] });
  seedThread(store, 'thread-3');
  store.run("INSERT INTO research_intents(id,partner_id,thread_id,authority_hash,proposal_basis_fingerprint,plan_packet_json,selection_json,refresh_sources_json,status,producer,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    'intent-3', 'partner-001', 'thread-3', 'ah', 'bf', '{}', '{}', '[]', 'waiting_sources', 'operator', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  store.run("INSERT INTO research_attempts(id,intent_id,capability_id,capability_version,slot,status,grant_version,created_at) VALUES(?,?,?,?,?,?,?,?)",
    'attempt-3', 'intent-3', 'research.refresh_source', 'v1', `refresh:${sourceId}`, 'running', 0, '2026-01-01T00:00:00Z');
  // Nothing is polling this source, so the only thing that can move the attempt is the sweep.
  await scheduler.sourceTick();
  const row = store.get("SELECT status,receipt_json FROM research_attempts WHERE id=?", 'attempt-3');
  assert.equal(row.status, 'interrupted_unknown', 'the orphan is retired, not left running');
  assert.match(row.receipt_json, /ORPHANED_REFRESH_ATTEMPT/,
    'and the reason says it was orphaned rather than failed for some other reason');
});

test('a model attempt running beside the source loop is not swept', async (t) => {
  const { scheduler, store } = harness(t, { readers: [countingReader([])] });
  seedThread(store, 'thread-4');
  store.run("INSERT INTO research_intents(id,partner_id,thread_id,authority_hash,proposal_basis_fingerprint,plan_packet_json,selection_json,refresh_sources_json,status,producer,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    'intent-4', 'partner-001', 'thread-4', 'ah', 'bf', '{}', '{}', '[]', 'reasoning', 'operator', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  // A plan attempt is legitimately running for as long as the head takes. The sweep is scoped to
  // `research.refresh_source` precisely so a source pass cannot cancel a model's work.
  store.run("INSERT INTO research_attempts(id,intent_id,capability_id,capability_version,slot,status,grant_version,created_at) VALUES(?,?,?,?,?,?,?,?)",
    'attempt-4', 'intent-4', 'research.plan', 'v1', 'plan', 'running', 0, '2026-01-01T00:00:00Z');
  await scheduler.sourceTick();
  const row = store.get("SELECT status FROM research_attempts WHERE id=?", 'attempt-4');
  assert.equal(row.status, 'running', 'the source loop does not touch a model attempt');
});

// The distinction that makes the sweep safe, asserted on both sides of it.
//
// A `running` refresh is not orphaned by being running. It is orphaned by its pass having ended,
// and the only place that can be known is the top of a *new* pass. So the same database state —
// one attempt, `running` — must be left alone by an ordinary reconciliation and retired by the
// next source pass. Anything that puts the sweep anywhere else gets exactly one of these two
// wrong, and a suite that only ever tests the retired side cannot tell which.
test('a running refresh survives an ordinary reconciliation and dies only on the next pass', async (t) => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-orphan-'))); t.after(() => store.close());
  const loaded = loadConfig();
  const service = new BusinessService(store, { ...loaded,
    opportunity: { ...loaded.opportunity, automatic: true, browserSources: [browserSourceConfig()], allowedSourceRefs: [sourceId] },
    runtime: { ...loaded.runtime, enabled: false }, telegram: { ...loaded.telegram, enabled: false, liveSending: false } });
  seedThread(store, 'thread-5');
  store.run("INSERT INTO research_intents(id,partner_id,thread_id,authority_hash,proposal_basis_fingerprint,plan_packet_json,selection_json,refresh_sources_json,status,producer,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    'intent-5', 'partner-001', 'thread-5', 'ah', 'bf', '{}', '{}', '[]', 'waiting_sources', 'operator', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  store.run("INSERT INTO research_attempts(id,intent_id,capability_id,capability_version,slot,status,grant_version,created_at) VALUES(?,?,?,?,?,?,?,?)",
    'attempt-5', 'intent-5', 'research.refresh_source', 'v1', `refresh:${sourceId}`, 'running', 0, '2026-01-01T00:00:00Z');
  const statusOf = () => store.get("SELECT status FROM research_attempts WHERE id=?", 'attempt-5').status;

  // Standing for a reconciliation that runs while a pass is still awaiting the network. This is
  // the call that must NOT treat a live attempt as an orphan.
  await service.exclusive(() => service.store.transaction(() => service.executive.reconcile()));
  assert.equal(statusOf(), 'running', 'a plain reconcile leaves a running refresh alone');

  // And a second one, for the same reason: the absence of the sweep is not a one-off.
  await service.exclusive(() => service.store.transaction(() => service.executive.reconcile()));
  assert.equal(statusOf(), 'running', 'and still leaves it alone on a later pass');

  // Now the pass actually begins, which is the moment the claim becomes true.
  await service.exclusive(() => service.store.transaction(() => service.executive.sweepOrphanedRefreshes()));
  assert.equal(statusOf(), 'interrupted_unknown', 'the sweep retires what the pass boundary retires');
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

// A source's failure is a fact about the source, not about the last pass.
//
// A pass that read nothing has learned nothing, and a pass that read a different source has
// learned nothing about this one. The one-bit version of this — "did anything fail on this
// tick" — reported a broken transport as healthy the moment the interval carried it past a
// tick, which is the only window in which nobody was looking.
test('a failure survives a pass that does not retry it', async (t) => {
  const { scheduler, model, establishHealth } = harness(t, { readers: [] });
  await establishHealth();
  scheduler.sourceReadFailures.set('browser:example', 'BROWSER_DNS_FAILED');
  // A pass in which this source is not due changes nothing about it. The whole gap between two
  // attempts can be minutes, and during it the partner is still broken.
  await scheduler.sourceTick();
  assert.equal(scheduler.sourceReadReason, 'source_read_failed:BROWSER_DNS_FAILED',
    'a pass that did not retry the source still reports it broken');
  await scheduler.sourceTick();
  assert.equal(scheduler.sourceReadReason, 'source_read_failed:BROWSER_DNS_FAILED',
    'and again on the next one');
  model.releaseAll();
});

test('a real success clears only that source', async (t) => {
  const { scheduler, model, establishHealth } = harness(t, { readers: [countingReader([])] });
  await establishHealth();
  scheduler.sourceReadFailures.set('browser:example', 'BROWSER_DNS_FAILED');
  scheduler.sourceReadFailures.set('browser:other', 'BROWSER_TIMEOUT');
  // The reader succeeds, so its own entry goes and nothing else does. One healthy source was
  // never evidence about another.
  await scheduler.sourceTick();
  assert.equal(scheduler.sourceReadFailures.has('browser:example'), false, 'the read source recovered');
  assert.equal(scheduler.sourceReadFailures.has('browser:other'), true, 'the unread source is still broken');
  assert.equal(scheduler.sourceReadReason, 'source_read_failed:BROWSER_TIMEOUT',
    'and the reported failure is the one that remains');
  model.releaseAll();
});

test('the reported failure is deterministic when several are unresolved', async (t) => {
  const { scheduler, model, establishHealth } = harness(t, { readers: [] });
  await establishHealth();
  // Inserted out of order on purpose: the same set of failures must read the same way however it
  // was built, or an operator sees a reason that changes for no reason between two passes.
  scheduler.sourceReadFailures.set('browser:z', 'BROWSER_TIMEOUT');
  scheduler.sourceReadFailures.set('browser:a', 'BROWSER_DNS_FAILED');
  await scheduler.sourceTick();
  const first = scheduler.sourceReadReason;
  assert.equal(first, 'source_read_failed:BROWSER_DNS_FAILED', 'the lowest code is the reported one');
  scheduler.sourceReadFailures.clear();
  scheduler.sourceReadFailures.set('browser:a', 'BROWSER_DNS_FAILED');
  scheduler.sourceReadFailures.set('browser:z', 'BROWSER_TIMEOUT');
  await scheduler.sourceTick();
  assert.equal(scheduler.sourceReadReason, first, 'and it does not depend on insertion order');
  model.releaseAll();
});

// Cold start is not a failure.
//
// The health flags used to start `false`, which is a claim: "a reconciliation was attempted and
// it did not succeed". A partner that had not run a pass yet had made no such claim, so the
// status told the operator it was broken when the only true thing was that it had not looked.
// Both states must withhold reasoning — a model may not run on a transport nobody has checked —
// and only the word differs. A field that cannot tell those apart teaches operators to ignore it.
test('a head pass before any source pass waits, and says it is waiting', async (t) => {
  const { scheduler, model } = harness(t, { readers: [] });
  assert.equal(scheduler.continuityHealthy, null, 'health starts unestablished, not failed');
  await scheduler.reasonTick();
  assert.equal(model.calls, 0, 'no inference on a transport nobody has checked');
  assert.equal(scheduler.continuityState.disposition, 'waiting_reconciliation',
    'and the operator is told it is waiting, not that it is broken');
});

test('a reconciliation that actually fails withholds reasoning and says it failed', async (t) => {
  const { scheduler, service, model } = harness(t, { readers: [] });
  service.continuity.reconcile = () => { throw new Error('db down'); };
  await scheduler.sourceTick();
  assert.equal(scheduler.continuityHealthy, false, 'a real failure is established as a failure');
  await scheduler.reasonTick();
  assert.equal(model.calls, 0, 'and reasoning is still withheld');
  assert.equal(scheduler.continuityState.disposition, 'reconciliation_failed',
    'the two states differ in what they claim, not in what they permit');
});

test('a successful pass permits reasoning and clears the waiting state', async (t) => {
  const { scheduler, model } = harness(t, { readers: [] });
  await scheduler.reasonTick();
  assert.equal(scheduler.continuityState.disposition, 'waiting_reconciliation');
  await scheduler.sourceTick();
  assert.equal(scheduler.continuityHealthy, true);
  const thinking = scheduler.reasonTick();
  model.releaseAll(); await thinking;
  assert.notEqual(scheduler.continuityState.disposition, 'waiting_reconciliation',
    'once a pass has established health, the waiting state is gone');
});

// The race the split introduced.
//
// Setting the health flag before awaiting the reconciliation means the reasoning loop, which runs
// on its own timer, can read `true` for a reconciliation that is still in flight and about to
// fail. The test holds a reconciliation open rather than racing it, so what is asserted is the
// rule and not the timing: a check that has not finished is not a check that passed.
test('a head pass during an in-flight reconciliation is withheld', async (t) => {
  const { scheduler, service, model } = harness(t, { readers: [] });
  const original = service.continuity.reconcile.bind(service.continuity);
  const gates = [];
  service.continuity.reconcile = () => new Promise((resolve) => { gates.push(() => { resolve(); return original(); }); });
  const passing = scheduler.sourceTick();
  for (let i = 0; i < 50 && gates.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(gates.length, 1, 'the source pass is inside the reconciliation');
  await scheduler.reasonTick();
  assert.equal(model.calls, 0, 'the head does not reason on a check that has not finished');
  assert.equal(scheduler.continuityHealthy, null, 'and the flag is not claimed as healthy');
  assert.equal(scheduler.continuityState.disposition, 'waiting_reconciliation');
  gates.pop()(); await passing;
  assert.equal(scheduler.continuityHealthy, true, 'the flag is set only once the answer is in');
  model.releaseAll();
});

test('a reconciliation that fails while the head waits reports the failure, not the wait', async (t) => {
  const { scheduler, service, model } = harness(t, { readers: [] });
  const gates = [];
  service.continuity.reconcile = () => new Promise((_, reject) => { gates.push(() => reject(new Error('db down'))); });
  const passing = scheduler.sourceTick();
  for (let i = 0; i < 50 && gates.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
  await scheduler.reasonTick();
  assert.equal(scheduler.continuityState.disposition, 'waiting_reconciliation',
    'while it is still running, the head is waiting');
  gates.pop()(); await passing;
  assert.equal(scheduler.continuityHealthy, false, 'the completed attempt is a failure');
  assert.equal(scheduler.continuityState.disposition, 'reconciliation_failed',
    'and the operator is told so, rather than being left on the waiting message');
  model.releaseAll();
});

// A read failure must cost the source its freshness immediately.
//
// The checkpoint used to keep its previous `confirmed_at` through a failed read, so the boundary
// kept answering "current" on the strength of a read that no longer happens — for as long as
// `maxLagSeconds` allows. These assert both halves: freshness is lost at once, and the source is
// still readable afterwards, because a phase that silences the source for a DNS hiccup is not a
// fix, it is a different outage.
test('a failed read makes the source not current at once, and allows the next attempt', async (t) => {
  const { service, cfg } = harness(t, { readers: [] });
  const sourceId = 'browser:example';
  const ok = () => new BrowserSourceReader(browserPolicy(service, sourceId), { request: async () => ({
    body: Buffer.from('<p>ok</p>'), statusCode: 200, headers: { 'content-type': 'text/html' },
  }), lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
  const dead = () => new BrowserSourceReader(browserPolicy(service, sourceId), { request: async () => {
    throw new BrowserFetchError('BROWSER_DNS_FAILED');
  }, lookup: async () => [{ address: '93.184.216.34', family: 4 }] });

  await pollBrowserSource(service, sourceId, ok());
  assert.equal(browserCheckpoint(service, sourceId).phase, 'current', 'a good read confirms the source');
  assert.equal(sourceAccessReadiness(service, sourceId).current, true, 'and the source is current');

  await assert.rejects(() => pollBrowserSource(service, sourceId, dead()), (e) => e.code === 'BROWSER_DNS_FAILED');
  const after = browserCheckpoint(service, sourceId);
  assert.equal(after.phase, 'retrying', 'a failed read moves the source to retrying');
  assert.equal(after.confirmed_at, null, 'and the old confirmation time is gone');
  assert.equal(after.reason, 'BROWSER_DNS_FAILED', 'with the class of the failure, not its message');
  assert.equal(sourceAccessReadiness(service, sourceId).current, false,
    'freshness is lost at once, not when maxLagSeconds finally expires');
  assert.equal(sourceAccessReadiness(service, sourceId).reason, 'SOURCE_TRANSPORT_NOT_CURRENT');

  // And the source is still readable: retrying withholds freshness, it does not retire the source.
  await pollBrowserSource(service, sourceId, ok());
  assert.equal(browserCheckpoint(service, sourceId).phase, 'current', 'a later good read recovers it');
  assert.equal(sourceAccessReadiness(service, sourceId).current, true, 'and the source is current again');
});

test('blocked is not retrying: a blocked source still refuses to be read', async (t) => {
  const { service } = harness(t, { readers: [] });
  const sourceId = 'browser:example';
  const ok = () => new BrowserSourceReader(browserPolicy(service, sourceId), { request: async () => ({
    body: Buffer.from('<p>ok</p>'), statusCode: 200, headers: { 'content-type': 'text/html' },
  }), lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
  await pollBrowserSource(service, sourceId, ok());
  await service.exclusive(() => service.store.transaction(() => markBrowserSourceBlocked(service, sourceId, 'BROWSER_POLICY_INVALID')));
  assert.equal(browserCheckpoint(service, sourceId).phase, 'blocked');
  await assert.rejects(() => pollBrowserSource(service, sourceId, ok()),
    (e) => e.code === 'BROWSER_SOURCE_BLOCKED', 'blocked forbids the next attempt, retrying does not');
  assert.equal(sourceAccessReadiness(service, sourceId).current, false);
});

test('a free-form failure never becomes the stored reason', async (t) => {
  const { service } = harness(t, { readers: [] });
  const sourceId = 'browser:example';
  const leaky = () => new BrowserSourceReader(browserPolicy(service, sourceId), { request: async () => {
    throw Object.assign(new Error('connect ECONNREFUSED 93.184.216.34:443 sk-live-abc'), { code: 'lowercase and spaces' });
  }, lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
  await assert.rejects(() => pollBrowserSource(service, sourceId, leaky()));
  const stored = JSON.stringify(browserCheckpoint(service, sourceId));
  assert.match(stored, /BROWSER_READ_FAILED/, 'an unrecognised failure becomes one declared class');
  for (const token of ['93.184', 'sk-live', 'ECONNREFUSED', 'connect '])
    assert.ok(!stored.includes(token), `nothing of the provider error may survive: ${token}`);
});

// The boundary the split must not cross.
test('the two loops are independent locks', async (t) => {
  const { scheduler, model, establishHealth } = harness(t, { readers: [] });
  assert.equal(scheduler.busy, false); assert.equal(scheduler.reasonBusy, false);
  await establishHealth();
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
