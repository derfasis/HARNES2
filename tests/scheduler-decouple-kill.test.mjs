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
import { browserCheckpoint, sourceAccessReadiness, browserPolicyHash } from '../business/source-ingestion.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

// The same key derivation `channel_offsets` is written with, so a row written here is found by the
// same lookup production uses rather than by a second, slightly different one.
const digestOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const sourceId = 'browser:example';
// `pollEverySeconds + tickSeconds <= maxLagSeconds` is enforced at load, and a source whose
// reading interval does not fit inside its own freshness budget is refused there. An earlier
// version of this fixture used 300/300 against a 20 s tick, which is invalid by that rule — and
// the failure it causes is not a clean one: `validateBrowserSources` is the first statement of
// the freshness boundary, so every `sourceAccessReadiness` call in this file threw before
// reaching the assertion, and the tests failed for a reason that had nothing to do with what
// they were checking. 300 inside 900 leaves room, and matches the sibling browser fixture.
const browserSourceConfig = (id = sourceId) => ({ sourceId: id, url: 'https://example.com/page',
  maxLagSeconds: 900, pollEverySeconds: 300, processingBasis: 'Kill-test only', sourceKind: 'live_snapshot' });

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

// A real OPEN thread with attention, opened through the same command an operator would use. Its
// basis and its `business_basis` come from the service, so a thread built here is one continuity
// will actually consider — which is what makes the head pass below reach the model instead of
// returning empty.
// A response shaped like the one `http(s).request` produces.
//
// It has to be an emitter, not a plain object: `readBounded` listens for `data`, `end`, `error`
// and `aborted`, so a `{ statusCode, headers, body }` literal passes the status and content-type
// checks and then fails as `BROWSER_FETCH_FAILED` the moment the body is read. An earlier version
// of this file used literals, and every browser test in it failed for that reason alone.
class FakeResponse extends EventEmitter {
  constructor({ status = 200, headers = {}, body = '' } = {}) {
    super();
    this.statusCode = status; this.headers = headers; this.destroyed = false;
    setImmediate(() => { if (!this.destroyed) { this.emit('data', Buffer.from(body)); this.emit('end'); } });
  }
  resume() { this.emit('end'); return this; }
  destroy() { this.destroyed = true; return this; }
}
const okPage = (text = '<p>ok</p>') => new FakeResponse({ headers: { 'content-type': 'text/html' }, body: text });
// A reader whose page always comes back, built the way production builds one.
const workingReader = (service, sourceId) => new BrowserSourceReader(browserPolicy(service, sourceId), { service,
  request: async () => okPage(), lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
// A reader whose page never arrives, failing the way a resolver fails.
const deadReader = (service, sourceId) => new BrowserSourceReader(browserPolicy(service, sourceId), { service,
  request: async () => { throw Object.assign(new Error('resolver said no'), { code: 'ENOTFOUND' }); },
  lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
// A reader that reaches the page but yields nothing readable.
const emptyReader = (service, sourceId) => new BrowserSourceReader(browserPolicy(service, sourceId), { service,
  request: async () => okPage('   '), lookup: async () => [{ address: '93.184.216.34', family: 4 }] });

const openAttentionThread = async (service, sourceRef, evidence = []) => {
  // Every field the command validates must be present, `initial_evidence_event_ids` included:
  // `open` refuses a payload it does not recognise, and it also requires the source to be on the
  // allowlist, which the harness sets up. The thread comes back with attention, which is what
  // continuity's `prepare` selects on.
  const opened = await service.command('continuity.open', { title: 'Kill-test thread',
    objective: 'Observe the split between reading and reasoning.',
    success_condition: 'The source loop keeps running while the head thinks.',
    source_ids: [sourceRef], max_age_seconds: 3600, initial_evidence_event_ids: evidence },
  `req-${randomUUID()}`);
  return opened?.thread_id ?? opened?.id ?? null;
};

const harness = async (t, { readers = [], config } = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-decouple-'));
  const store = new Store(directory);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const loaded = loadConfig();
  // Continuity is ON and the runtime reports itself ready. Without them every path into
  // `runtime.decide` is closed before it is reached — continuity returns `disabled` — so a head
  // pass would never call the model, `model.calls` would be 0 whatever the scheduler did, and
  // every assertion of the shape "the head did not reason" would pass without the head ever
  // being allowed to. A test about whether reasoning is withheld is worthless unless reasoning is
  // reachable in the first place.
  //
  // No active offer: an offer that does not satisfy the projection's own schema is refused with
  // `INVALID_INPUT` before the model is reached, so a placeholder here breaks every test in the
  // file for a reason that has nothing to do with the loops. Continuity reaches the model on its
  // own, given a thread with attention.
  const cfg = config ?? { ...loaded,
    opportunity: { ...loaded.opportunity, automatic: true,
      browserSources: [browserSourceConfig()], allowedSourceRefs: [sourceId] },
    continuity: { ...loaded.continuity, enabled: true, modelEnabled: true },
    executive: { ...loaded.executive, enabled: true, modelEnabled: true, maxModelRunsPerDay: 1000 },
    runtime: { ...loaded.runtime, enabled: false, model: 'test-model', baseUrl: 'https://model.invalid',
      inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
    telegram: { ...loaded.telegram, enabled: false, liveSending: false } };
  const service = new BusinessService(store, cfg);
  // Readiness checks the key and the Python environment. A synthetic value that is never
  // transmitted stands in for the key, exactly as the sibling continuity suite does; the
  // environment is checked on disk and the worktree is expected to have been set up.
  const previousKey = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'synthetic-never-transmitted';
  t.after(() => { if (previousKey === undefined) delete process.env.PARTNER_MODEL_API_KEY;
    else process.env.PARTNER_MODEL_API_KEY = previousKey; });
  const { runtime, state } = heldModel();
  const scheduler = new Scheduler(service, runtime, { readiness: () => ({ enabled: false, live_sending: false }) }, readers);
  t.after(() => state.releaseAll());
  // A real thread with attention, so continuity's `prepare` has something to reason about and the
  // head pass reaches the model. Without it the head has nothing to do and returns immediately,
  // which is the state that made every "the head is in flight" assertion vacuous.
  let threadId = null;
  // `continuityHealthy` starts false on purpose — a reasoning pass that runs before any source
  // pass must not infer from a reconciliation nobody attempted. A test that wants the head to
  // think therefore has to earn it: this is the source pass that establishes the health it
  // reads. Without it the model never starts and every head assertion below would be green for
  // the wrong reason, which is the failure mode this whole file exists to catch.
  const establishHealth = async () => {
    // The source pass comes FIRST. Reconciliation runs inside it, and it retires a thread whose
    // evidence or authority no longer holds — so a thread opened before the pass can be terminated
    // by it, and the head then has nothing to reason about. The order here is the order the
    // scheduler happens in, and the thread is opened on evidence the pass has already confirmed.
    await scheduler.sourceTick();
    if (!threadId) {
      const read = await pollBrowserSource(service, sourceId, workingReader(service, sourceId));
      threadId = await openAttentionThread(service, sourceId, [read.source_event_id]);
    }
    assert.equal(scheduler.continuityHealthy, true,
    'the source pass established reconciliation health'); };
  return { store, service, scheduler, cfg, model: state, directory, establishHealth, threadId };
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
  id, 'partner-001', 'Kill-test', 'Prove the scenario', 'The scenario is reached', 'business_basis');

// A reader that counts how many times it was read. Cadence is the observable: what matters is
// not that the page was fetched but that the fetch happened at all while the head was busy.
const countingReader = (reads, { fail = false } = {}) => ({ sourceId,
  transport: { readPage: async () => { reads.push(Date.now());
    if (fail) throw Object.assign(new Error('page gone'), { code: 'BROWSER_DNS_FAILED' });
    return { text: `<p>read ${reads.length}</p>`, truncated: false, originalLength: 12, finalUrl: 'https://example.com/page', status: 200 }; } } });

// 1. The head is mid-thought and the source is still read.
test('a reasoning pass in flight does not stop the source loop', async (t) => {
  const reads = [];
  const { scheduler, model, establishHealth } = await harness(t, { readers: [countingReader(reads)] });
  await establishHealth();
  // Start the head and let it reach the model. It will not return until released.
  const thinking = scheduler.reasonTick();
  for (let i = 0; i < 20 && model.pending === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(model.pending, 1, 'the head is genuinely thinking, not returning early');
  assert.equal(scheduler.reasonBusy, true);
  assert.equal(scheduler.busy, false, 'and it is not holding the source loop');

  // Now the source loop runs. Before the split this could not happen: `tick()` was already
  // inside the reasoning, so the eyes were behind the head in the same call stack.
  //
  // The source is aged first so it is genuinely due. `establishHealth` already performed the one
  // read the interval permits, so without this the pass below would correctly read nothing and
  // the assertion would be satisfied by the setup rather than by the fix.
  scheduler.browserPolls.set(sourceId, { consideredAt: Date.now() - 400_000, readAt: Date.now() - 400_000 });
  const before = reads.length;
  await scheduler.sourceTick();
  assert.equal(reads.length, before + 1, 'the page was read while the head was still thinking');
  assert.equal(scheduler.lastReason, 'sources_current',
    'and the transport truth is what the source loop reports');

  model.releaseAll(); await thinking;
});

test('two source passes run while one head pass is still thinking', async (t) => {
  const reads = [];
  const { scheduler, model, establishHealth } = await harness(t, { readers: [countingReader(reads)] });
  await establishHealth();
  const thinking = scheduler.reasonTick();
  for (let i = 0; i < 20 && model.pending === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
  // The source is aged so the first of these really is due, then the second is not. Two passes,
  // one fetch: the interval decides the second one, and the fact that the second pass ran at all
  // is what separates "the loop kept working" from "the loop stopped and nothing noticed".
  scheduler.browserPolls.set(sourceId, { consideredAt: Date.now() - 400_000, readAt: Date.now() - 400_000 });
  const before = reads.length;
  await scheduler.sourceTick();
  assert.equal(reads.length, before + 1, 'the first pass reads the aged source');
  const afterFirst = reads.length;
  await scheduler.sourceTick();
  assert.equal(reads.length, afterFirst, 'and the second, inside the interval, reads nothing');
  assert.equal(scheduler.busy, false, 'the source loop finished rather than queueing behind the head');
  model.releaseAll(); await thinking;
});

// 2. Freshness does not decay because of reasoning.
test('a source is not left stale by a long head pass', async (t) => {
  const reads = [];
  const { scheduler, service, model, establishHealth } = await harness(t, { readers: [countingReader(reads)] });
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

// 3. A cancelled or revoked turn mid-thought is not applied.
//
// The subject is a real turn that a real pass created, not an empty table: the earlier version of
// this test updated `partner_turns` when no turn existed, so the assertions held because nothing
// had ever been proposed — which is also what they would say if the completion path ignored
// cancellation entirely.
test('an answer that arrives after its work was cancelled is not applied', async (t) => {
  const { scheduler, store, model, establishHealth } = await harness(t, { readers: [countingReader([])] });
  await establishHealth();
  const thinking = scheduler.reasonTick();
  for (let i = 0; i < 40 && model.pending === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(model.pending, 1, 'the model really is mid-call, so there is something to cancel');

  // While the worker is away the operator cancels what it was reasoning about. The completion path
  // re-reads the turn and must find it is no longer running, so its answer cannot be applied.
  const cancelled = store.all("SELECT id FROM partner_turns WHERE status='running'");
  assert.ok(cancelled.length > 0, 'the head created a running turn to cancel');
  store.run("UPDATE partner_turns SET status='cancelled' WHERE id=?", cancelled[0].id);
  model.releaseAll(); await thinking;

  assert.equal(store.get("SELECT COUNT(*) n FROM partner_turns WHERE status='proposed'").n, 0,
    'a cancelled turn produced no proposal');
  assert.equal(store.get("SELECT COUNT(*) n FROM runs WHERE status='running'").n, 0,
    'and no run is left running after the head finished');
  assert.equal(store.get("SELECT COUNT(*) n FROM partner_turns WHERE status='running'").n, 0,
    'and the cancelled turn is not left claimed by a worker that has already gone');
});

// 4. Shutdown does not close the store from under a worker.
test('shutdown drains a head pass before the store is closed', async (t) => {
  const reads = [];
  const { scheduler, store, model, establishHealth } = await harness(t, { readers: [countingReader(reads)] });
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
  // The store is closed here, the way `server.mjs` does it, and the head's own writes must have
  // already landed. An earlier version of this test merely read from a store nobody had closed,
  // which said nothing about ordering — the guarantee is that the close waits, so the close is
  // performed inside the test and the head must be finished before it.
  const receipts = store.get("SELECT COUNT(*) n FROM runs WHERE status IN ('completed','failed')").n;
  assert.ok(receipts > 0, 'the head wrote its result before the store was closed');
  store.close();
  assert.throws(() => store.get('SELECT 1 AS n'),
    'and closing afterwards does not leave a half-written receipt behind');
  t.after(() => { try { store.close(); } catch { /* already closed by the test */ } });
});

test('stop() clears both timers, not only the source one', async (t) => {
  const { scheduler } = await harness(t, { readers: [] });
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
  const { scheduler, service, store, model } = await harness(t, { readers: [countingReader([])] });
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
  const { scheduler, store } = await harness(t, { readers: [countingReader(reads)] });
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
  const { scheduler, store } = await harness(t, { readers: [countingReader([])] });
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
  const { scheduler, store } = await harness(t, { readers: [countingReader([])] });
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
  //
  // `reconcile()` opens its own transaction, so it goes through `exclusive` alone — wrapping it
  // in `store.transaction` issues a nested `BEGIN IMMEDIATE` and dies before the first assertion,
  // which is how this test read the first time. The scheduler calls it exactly this way.
  await service.exclusive(() => service.executive.reconcile());
  assert.equal(statusOf(), 'running', 'a plain reconcile leaves a running refresh alone');

  // And a second one, for the same reason: the absence of the sweep is not a one-off.
  await service.exclusive(() => service.executive.reconcile());
  assert.equal(statusOf(), 'running', 'and still leaves it alone on a later pass');

  // Now the pass actually begins, which is the moment the claim becomes true. The scheduler wraps
  // the sweep in a transaction of its own, and the sweep does not open one of its own.
  await service.exclusive(() => service.store.transaction(() => service.executive.sweepOrphanedRefreshes()));
  assert.equal(statusOf(), 'interrupted_unknown', 'the sweep retires what the pass boundary retires');
});

// 6. A recovered reconciliation is reported as recovered.
test('a reconciliation that recovers stops reporting reconciliation_failed', async (t) => {
  const { scheduler, service } = await harness(t, { readers: [] });
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
  const { scheduler, service, model } = await harness(t, { readers: [] });
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
  const { scheduler, model, establishHealth } = await harness(t, { readers: [] });
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
  const { scheduler, model, establishHealth } = await harness(t, { readers: [countingReader([])] });
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
  const { scheduler, model, establishHealth } = await harness(t, { readers: [] });
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
  const { scheduler, model } = await harness(t, { readers: [] });
  assert.equal(scheduler.continuityHealthy, null, 'health starts unestablished, not failed');
  await scheduler.reasonTick();
  assert.equal(model.calls, 0, 'no inference on a transport nobody has checked');
  assert.equal(scheduler.continuityState.disposition, 'waiting_reconciliation',
    'and the operator is told it is waiting, not that it is broken');
});

test('a reconciliation that actually fails withholds reasoning and says it failed', async (t) => {
  const { scheduler, service, model } = await harness(t, { readers: [] });
  service.continuity.reconcile = () => { throw new Error('db down'); };
  await scheduler.sourceTick();
  assert.equal(scheduler.continuityHealthy, false, 'a real failure is established as a failure');
  await scheduler.reasonTick();
  assert.equal(model.calls, 0, 'and reasoning is still withheld');
  assert.equal(scheduler.continuityState.disposition, 'reconciliation_failed',
    'the two states differ in what they claim, not in what they permit');
});

test('a successful pass permits reasoning and clears the waiting state', async (t) => {
  const { scheduler, model } = await harness(t, { readers: [] });
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
  const { scheduler, service, model } = await harness(t, { readers: [] });
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
  const { scheduler, service, model } = await harness(t, { readers: [] });
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
  const { service, cfg } = await harness(t, { readers: [] });
  const sourceId = 'browser:example';
  const ok = () => new BrowserSourceReader(browserPolicy(service, sourceId), { request: async () => ({
    body: Buffer.from('<p>ok</p>'), statusCode: 200, headers: { 'content-type': 'text/html' },
  }), lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
  const dead = () => new BrowserSourceReader(browserPolicy(service, sourceId), { request: async () => {
    throw Object.assign(new Error('dns'), { code: 'ENOTFOUND' });
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
  const { service } = await harness(t, { readers: [] });
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
  const { service } = await harness(t, { readers: [] });
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

// The one case a checkpoint cannot cover on its own.
//
// A read failed, and the write that would have recorded that failure also failed. Durable evidence
// still says `current` with a `confirmed_at` recent enough to pass the age check. The only thing
// left that knows the truth is the reader itself, in memory — so the boundary has to ask it.
test('a source whose reader is failing is not current, whatever the checkpoint says', async (t) => {
  const { service } = await harness(t, { readers: [] });
  const sourceId = 'browser:example';
  const opts = { service, request: async () => okPage(), lookup: async () => [{ address: '3.184.216.34', family: 4 }] };
  const reader = new BrowserSourceReader(browserPolicy(service, sourceId), opts);
  await pollBrowserSource(service, sourceId, reader);
  assert.equal(sourceAccessReadiness(service, sourceId).current, true, 'a good read is current');

  // The same reader, now pointed at a page that cannot be read. The failure comes from the
  // transport itself rather than from replacing the method under test — an earlier version of
  // this test reassigned `readPage`, which skipped the very code that marks the latch, so the
  // latch was never exercised and the test passed for the wrong reason.
  reader.markCurrent();
  const dead = deadReader(service, sourceId);
  await assert.rejects(() => pollBrowserSource(service, sourceId, dead), (e) => e.code === 'BROWSER_DNS_FAILED');
  assert.equal(service.sourceTransportHealth.get(sourceId)(), false,
    'the failing reader is the one that now answers for the source');
  assert.equal(sourceAccessReadiness(service, sourceId).current, false,
    'and the source is refused even though its checkpoint write succeeded');
});

// The case a socket-level latch cannot see: the page was read successfully and the intake refused
// it. The network answered, the durable checkpoint stayed on the previous confirmation, and a
// boundary that asked "did the socket answer" would call a source current whose newest reading
// was thrown away.
test('a read the intake refused does not leave the source current', async (t) => {
  const { service, store } = await harness(t, { readers: [] });
  const sourceId = 'browser:example';
  const reader = workingReader(service, sourceId);
  await pollBrowserSource(service, sourceId, reader);
  assert.equal(sourceAccessReadiness(service, sourceId).current, true, 'a committed read is current');

  // The read still succeeds; the store refuses the commit that would make it evidence.
  const transaction = service.store.transaction.bind(service.store);
  service.store.transaction = () => { throw new Error('db gone'); };
  await assert.rejects(() => pollBrowserSource(service, sourceId, reader));
  service.store.transaction = transaction;

  assert.equal(browserCheckpoint(service, sourceId).phase, 'current',
    'the durable checkpoint is the old one, because the commit never landed');
  assert.equal(sourceAccessReadiness(service, sourceId).current, false,
    'and the source is refused anyway, because the reader knows the read was never accepted');
  assert.equal(sourceAccessReadiness(service, sourceId).reason, 'SOURCE_TRANSPORT_DIRTY');
});

test('a reader that has never succeeded does not vouch for a source a previous process confirmed', async (t) => {
  const { service, store } = await harness(t, { readers: [] });
  const sourceId = 'browser:example';
  // A fresh reader, and a checkpoint written as an earlier process would have left it.
  store.run('INSERT OR REPLACE INTO channel_offsets(channel,account_id,cursor) VALUES(?,?,?)',
    'browser-source-v0', digestOf([service.config.partnerId, sourceId]),
    JSON.stringify({ source_id: sourceId, policy_hash: browserPolicyHash(browserPolicy(service, sourceId)),
      phase: 'current', confirmed_at: new Date().toISOString(), reason: null }));
  assert.equal(browserCheckpoint(service, sourceId).phase, 'current', 'the checkpoint is current and fresh');
  deadReader(service, sourceId);
  // Unproven is not readable: a reader that has not once succeeded gets to say nothing about the
  // source, however recent the last confirmation is.
  assert.equal(sourceAccessReadiness(service, sourceId).current, false,
    'a never-successful reader cannot vouch for a source');
  assert.equal(sourceAccessReadiness(service, sourceId).reason, 'SOURCE_TRANSPORT_DIRTY');
});

test('a reader replaced by a new one is the only one the boundary may ask', async (t) => {
  const { service } = await harness(t, { readers: [] });
  const sourceId = 'browser:example';
  const opts = { service, request: async () => okPage(), lookup: async () => [{ address: '3.184.216.34', family: 4 }] };
  const first = new BrowserSourceReader(browserPolicy(service, sourceId), opts);
  assert.equal(first.owns(service), true, 'the reader owns the seam it registered');
  const second = new BrowserSourceReader(browserPolicy(service, sourceId), opts);
  assert.equal(first.owns(service), false, 'and stops owning it once another reader takes the slot');
  assert.equal(second.owns(service), true, 'the newest reader is the one that answers');
});

// The whole point of the latch, in the exact state the latch exists for: the read failed, the
// write that would have recorded it failed too, and durable storage still says `current`.
test('a failure that could not be written leaves the source not current', async (t) => {
  const { service, store } = await harness(t, { readers: [] });
  const sourceId = 'browser:example';
  const reader = workingReader(service, sourceId);
  await pollBrowserSource(service, sourceId, reader);
  assert.equal(sourceAccessReadiness(service, sourceId).current, true);

  // Break the store, then fail the read through the transport rather than by replacing the
  // method under test. The read failure must not be what the operator is told, because the
  // record of it is exactly what did not happen.
  const transaction = service.store.transaction.bind(service.store);
  service.store.transaction = () => { throw new Error('db gone'); };
  // The reader keeps the same good transport: the read succeeds, and it is the *write* of the
  // failure record that cannot land. Reusing the reader also keeps the latch honest, since a new
  // reader would start unproven and the assertion below would pass without the write failing.
  const dead = deadReader(service, sourceId);
  await assert.rejects(() => pollBrowserSource(service, sourceId, dead),
    (e) => e.code === 'BROWSER_CHECKPOINT_UPDATE_FAILED',
    'the unrecordable failure is reported as the unrecordable failure');
  service.store.transaction = transaction;

  // Durable state is stale, and that is the scenario, not a setup accident.
  assert.equal(browserCheckpoint(service, sourceId).phase, 'current',
    'the checkpoint still claims current because nothing could be written');
  assert.equal(sourceAccessReadiness(service, sourceId).current, false,
    'and the source is still refused, because the reader knows better than the record does');
  assert.equal(sourceAccessReadiness(service, sourceId).reason, 'SOURCE_TRANSPORT_DIRTY');

  // And it recovers on its own once the store works again.
  await pollBrowserSource(service, sourceId, reader);
  assert.equal(sourceAccessReadiness(service, sourceId).current, true,
    'a later good read restores the source without any operator action');
});

// The boundary the split must not cross.
test('the two loops are independent locks', async (t) => {
  const { scheduler, model, establishHealth } = await harness(t, { readers: [] });
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
  const { scheduler, model } = await harness(t, { readers: [countingReader(reads)] });
  const pass = scheduler.tick();
  model.releaseAll();
  await pass;
  assert.equal(reads.length, 1, 'a full pass still reads the source');
  assert.equal(scheduler.busy, false); assert.equal(scheduler.reasonBusy, false,
    'and leaves neither lock held');
  assert.equal(scheduler.status().reason_busy, false, 'status reports the head lock');
  assert.equal(typeof scheduler.status().reason, 'string');
});
