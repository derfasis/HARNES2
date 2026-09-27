// The reading schedule, and the promise that it bounds.
//
// Five sources and a budget of two is the shape that motivated it: without a budget, a list of
// fifty pages is fifty fetches every twenty seconds, forever, whether or not any of them changed.
// proof_level=synthetic_contract_eval; live_proof=false.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dueBrowserSources, markBrowserConsidered, markBrowserRead, MAX_BROWSER_POLLS_PER_TICK } from '../business/browser-polling.mjs';
import { Scheduler } from '../business/scheduler.mjs';
import { Store } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { loadConfig, validateBrowserSources } from '../business/config.mjs';
import { browserPolicy } from '../business/sources/browser-readonly.mjs';
import { browserPolicyHash } from '../business/source-ingestion.mjs';

const sourceId = (n) => `browser:page-${n}`;
const fiveSources = (n = 5) => Array.from({ length: n }, (_, index) => ({
  sourceId: sourceId(index + 1), url: `https://example.com/${index + 1}`, maxLagSeconds: 900,
  pollEverySeconds: 300, processingBasis: 'Cadence test only', sourceKind: 'live_snapshot',
}));

const service = (t, { browserSources = fiveSources(), telegramSources = [] } = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-cadence-'));
  const store = new Store(directory);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const loaded = loadConfig();
  const cfg = { ...loaded, opportunity: { ...loaded.opportunity, automatic: true,
    browserSources, telegramSources, allowedSourceRefs: [...browserSources, ...telegramSources].map((s) => s.sourceId) },
  runtime: { ...loaded.runtime, enabled: false },
  telegram: { ...loaded.telegram, enabled: false, liveSending: false } };
  return { store, service: new BusinessService(store, cfg), cfg };
};

const events = (store, kind) => store.all('SELECT payload_json FROM events WHERE kind=?', kind);
const readers = (cfg) => cfg.config.opportunity.browserSources.map((entry) => ({ sourceId: entry.sourceId, transport: {} }));
const telegramPolicy = { accountId: '1', channelId: '2', sourceId: 'telegram:channel:2', maxLagSeconds: 120,
  processingBasis: 'unchanged', sourceKind: 'sanitized_fixture' };

test('a tick reads at most the budget, and the rest wait their turn', () => {
  const cfg = { config: { opportunity: { browserSources: fiveSources() } } };
  const state = new Map();
  const { selected: due } = dueBrowserSources(cfg, readers(cfg), state, { now: 1_000_000, budget: 2 });
  assert.equal(due.length, MAX_BROWSER_POLLS_PER_TICK, 'two of five');
  // And the two that were not read are still due for the next tick rather than skipped.
  const { selected: next } = dueBrowserSources(cfg, readers(cfg), state, { now: 1_000_000, budget: 2 });
  assert.deepEqual(next.map((entry) => entry.sourceId), due.map((entry) => entry.sourceId),
    'nothing was marked, so the same two are still first in line');
});

test('the sources nobody read are read first, so none starves', () => {
  const cfg = { config: { opportunity: { browserSources: fiveSources() } } };
  const state = new Map();
  markBrowserConsidered(state, sourceId(1), 0);
  markBrowserConsidered(state, sourceId(2), 0);
  markBrowserConsidered(state, sourceId(3), 0);
  // Pages four and five have never been attempted, so they outrank the three that were just read.
  const { selected: due } = dueBrowserSources(cfg, readers(cfg), state, { now: 10_000, budget: 2 });
  assert.deepEqual(due.map((entry) => entry.sourceId), [sourceId(4), sourceId(5)]);
  // Round again with those two marked: the earlier three come back, so the cycle rotates.
  markBrowserConsidered(state, sourceId(4), 10_000);
  markBrowserConsidered(state, sourceId(5), 10_000);
  const { selected: rotated } = dueBrowserSources(cfg, readers(cfg), state, { now: 400_000, budget: 2 });
  assert.deepEqual(rotated.map((entry) => entry.sourceId), [sourceId(1), sourceId(2)],
    'the ones read longest ago are next');
});

test('a source read before its interval is not read again', () => {
  const cfg = { config: { opportunity: { browserSources: fiveSources() } } };
  const state = new Map();
  const now = 1_000_000;
  // All five attempted at the same instant, so the budget cannot be taken by a source that has
  // never been read — the only question left is whether the interval has elapsed.
  for (const entry of readers(cfg)) markBrowserConsidered(state, entry.sourceId, now);
  const { selected: soon } = dueBrowserSources(cfg, readers(cfg), state, { now: now + 299_000, budget: 2 });
  assert.equal(soon.length, 0, '299s of 300s is not yet due for anyone');
  const { selected: late } = dueBrowserSources(cfg, readers(cfg), state, { now: now + 301_000, budget: 2 });
  assert.equal(late.length, 2, 'past the interval the budget applies again');
});

test('a source that failed waits its interval too', () => {
  // This is the case the schedule exists for. Success is not the condition for waiting: a source
  // that only backs off after succeeding backs off never, and a dead site is re-read every tick.
  const cfg = { config: { opportunity: { browserSources: fiveSources() } } };
  const state = new Map();
  const now = 1_000_000;
  // Every one attempted, and the one that "failed" is not distinguishable in the state from the
  // one that succeeded — which is the point: a failure buys no shorter wait than a success.
  for (const entry of readers(cfg)) markBrowserConsidered(state, entry.sourceId, now);
  const { selected: next } = dueBrowserSources(cfg, readers(cfg), state, { now: now + 60_000, budget: 2 });
  assert.equal(next.length, 0, 'a failure does not make a source due again immediately');
  const { selected: after } = dueBrowserSources(cfg, readers(cfg), state, { now: now + 301_000, budget: 2 });
  assert.equal(after.length, 2, 'but everything comes back on its interval, failures included');
});

test('a restart lets every source be read once, without reading them all at once', () => {
  const cfg = { config: { opportunity: { browserSources: fiveSources() } } };
  const fresh = new Map();
  const { selected: first } = dueBrowserSources(cfg, readers(cfg), fresh, { now: 5_000_000, budget: 2 });
  assert.equal(first.length, 2, 'forgetting the schedule does not remove the budget');
  markBrowserRead(fresh, first[0].sourceId, 5_000_000);
  markBrowserRead(fresh, first[1].sourceId, 5_000_000);
  const { selected: second } = dueBrowserSources(cfg, readers(cfg), fresh, { now: 5_001_000, budget: 2 });
  assert.ok(!second.some((entry) => first.some((done) => done.sourceId === entry.sourceId)),
    'the first two are not re-read immediately after the restart');
  assert.ok(second.some((entry) => !first.some((done) => done.sourceId === entry.sourceId)),
    'and the ones that had never been read now go');
});

test('Telegram is not part of this: it is polled on every tick, as before', async (t) => {
  const { service: svc, cfg } = service(t, { telegramSources: [telegramPolicy] });
  const scheduler = new Scheduler(svc, { close() {} }, { readiness: () => ({ connected: false }) },
    [{ sourceId: telegramPolicy.sourceId, transport: { readDifference: async () => ({}) } }]);
  // A Telegram reader is never in the browser set, whatever its last attempt was.
  const state = new Map();
  markBrowserConsidered(state, telegramPolicy.sourceId, 0);
  const { selected: due } = dueBrowserSources(svc, scheduler.sourceReaders, state, { now: 1_000_000, budget: 2 });
  assert.equal(due.length, 0, 'a Telegram source is never selected by the browser schedule');
  // And the scheduler still attempts it: the failure below proves the Telegram path was entered.
  await scheduler.tick();
  assert.equal(scheduler.busy, false, 'the tick finished');
  assert.ok(cfg.opportunity.telegramSources.length === 1);
});

test('the reading interval is operational policy, not part of the source identity', (t) => {
  // Changing how often we look must not make the same page look like a different page, or the
  // boundary would refuse it as one whose policy changed.
  const { service: svc, cfg } = service(t, { browserSources: fiveSources(1) });
  const before = browserPolicyHash(cfg.opportunity.browserSources[0]);
  const slower = { ...cfg.opportunity.browserSources[0], pollEverySeconds: 600 };
  assert.equal(browserPolicyHash(slower), before, 'the interval does not enter the hash');
  // The policy the reader acts on still carries it, because the schedule needs it.
  assert.equal(browserPolicy(svc, cfg.opportunity.browserSources[0].sourceId).pollEverySeconds, 300);
});

test('a source may not be scheduled more slowly than its own freshness budget', (t) => {
  const { cfg } = service(t, { browserSources: fiveSources(1) });
  // 300s of reading plus the 20s tick fits inside a 900s budget.
  assert.doesNotThrow(() => validateBrowserSources(cfg));
  // A budget barely above the reading interval does not: the source could be stale by the time the
  // schedule even asks about it, so it is refused at load rather than discovered at runtime.
  const tooTight = { ...cfg, opportunity: { ...cfg.opportunity, browserSources: [
    { ...cfg.opportunity.browserSources[0], maxLagSeconds: 310 }] } };
  assert.throws(() => validateBrowserSources(tooTight), (error) => error.code === 'INVALID_BROWSER_SOURCES');
  const tooFast = { ...cfg, opportunity: { ...cfg.opportunity, browserSources: [
    { ...cfg.opportunity.browserSources[0], pollEverySeconds: 5 }] } };
  assert.throws(() => validateBrowserSources(tooFast), (error) => error.code === 'INVALID_BROWSER_SOURCES');
});

// The helper was right and its use was wrong. When nothing was due, the guard the scheduler
// used was false, no source was skipped, and every page was read again on every tick — so the
// cadence did nothing on exactly the ticks it existed for. These drive the scheduler rather than
// the helper, because the helper's own tests were green against code that read everything anyway.
const browserTickFixture = (cfg, { onRead } = {}) => cfg.opportunity.browserSources.map((entry) => ({
  sourceId: entry.sourceId,
  transport: { readPage: async () => { onRead?.(entry.sourceId); throw Object.assign(new Error('page unreadable'), { code: 'BROWSER_DNS_FAILED' }); } } }));
const failingTelegramReader = () => ({ sourceId: telegramPolicy.sourceId,
  transport: { readDifference: async () => { throw Object.assign(new Error('upstream'), { code: 'UPSTREAM_DOWN' }); } } });

test('a tick reads no browser at all when nothing is due', async (t) => {
  const { service: svc, cfg, store } = service(t, { telegramSources: [telegramPolicy] });
  const read = [];
  const scheduler = new Scheduler(svc, { close() {} }, { readiness: () => ({ connected: false }),
    lastSourceCode: null }, [failingTelegramReader(), ...browserTickFixture(cfg, { onRead: (id) => read.push(id) })]);
  for (const entry of cfg.opportunity.browserSources) {
    markBrowserConsidered(scheduler.browserPolls, entry.sourceId, Date.now());
  }
  await scheduler.tick();
  assert.equal(read.length, 0, 'no browser read was attempted on a tick where none was due');
  assert.equal(events(store, 'source.browser.poll.failed').length, 0);
  assert.equal(events(store, 'source.telegram.poll.failed').length, 1, 'Telegram is still polled every tick');
});

test('five due sources, a budget of two: exactly two read, and the next tick is quiet', async (t) => {
  const { service: svc, cfg, store } = service(t, { telegramSources: [telegramPolicy] });
  const read = [];
  const scheduler = new Scheduler(svc, { close() {} }, { readiness: () => ({ connected: false }),
    lastSourceCode: null }, [failingTelegramReader(), ...browserTickFixture(cfg, { onRead: (id) => read.push(id) })]);
  await scheduler.tick();
  assert.equal(read.length, MAX_BROWSER_POLLS_PER_TICK, 'exactly the budget, of five due');
  assert.equal(events(store, 'source.telegram.poll.failed').length, 1, 'Telegram is unaffected by the budget');
  // The next tick is a moment later: nothing browser is due, so nothing browser is read — which is
  // the case the broken guard got wrong.
  const before = read.length;
  await scheduler.tick();
  assert.equal(read.length, before, 'a tick later, with the interval unelapsed, reads nothing');
  assert.equal(events(store, 'source.telegram.poll.failed').length, 2, 'Telegram still polled on that tick too');
});

test('a source the budget left out waits its turn rather than draining the list', async (t) => {
  // Five due, a budget of two. The three that were not read are stamped as considered, not merely
  // left alone: if they came back as due on the next tick, the budget would drain the whole list
  // in a minute and the five-minute interval would mean nothing. They wait, and they do get read —
  // this is a turn being taken in order, not a source being dropped.
  const { service: svc, cfg } = service(t, {});
  const read = [];
  const scheduler = new Scheduler(svc, { close() {} }, { readiness: () => ({ connected: false }),
    lastSourceCode: null }, browserTickFixture(cfg, { onRead: (id) => read.push(id) }));
  await scheduler.tick();
  const firstRound = [...read];
  assert.equal(firstRound.length, MAX_BROWSER_POLLS_PER_TICK);

  const before = read.length;
  await scheduler.tick();
  assert.equal(read.length, before, 'the next tick, inside the interval, reads nothing at all');

  // The guarantee that matters is not a particular order within one round — every source
  // considered in the same tick has the same timestamp, so the order inside a round is a stable
  // tie-break. It is that nobody is left unread: with a budget of two, five sources and a
  // five-minute interval, everyone is read within three intervals and nobody starves.
  const all = cfg.opportunity.browserSources.map((entry) => entry.sourceId);
  for (let round = 0; round < 2; round += 1) {
    for (const id of [...scheduler.browserPolls.keys()]) {
      // The record is an object; subtracting from the object itself yields NaN, a NaN stamp
      // compares false against the interval, and the source then looks permanently due. That is
      // how this test was green for the wrong reason: it never aged anything at all.
      const record = scheduler.browserPolls.get(id);
      markBrowserConsidered(scheduler.browserPolls, id, record.consideredAt - 400_000);
    }
    await scheduler.tick();
  }
  assert.equal(read.length, 6, 'two more rounds of two');
  assert.deepEqual(new Set(read), new Set(all), 'every source is read at least once across the rounds');
  // Six reads over five sources cannot all be equal, and must not be lopsided either: the most
  // and least read differ by at most one, which is what an honest rotation looks like.
  const counts = new Map();
  for (const id of read) counts.set(id, (counts.get(id) ?? 0) + 1);
  const values = [...counts.values()];
  assert.ok(Math.max(...values) - Math.min(...values) <= 1,
    `reads are spread across the sources, not concentrated: ${JSON.stringify([...counts])}`);
});
