import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT, scoutHarness } from '../tests/scout-test-helpers.mjs';
import { dueTelegramSources } from '../business/telegram-monitoring.mjs';
import { telegramRead, telegramReadState } from '../business/telegram-read-gate.mjs';
import { sourceAccessReadiness, sourceCheckpoint } from '../business/source-ingestion.mjs';
import { applyTelegramDifference, bootstrapTelegramSource } from '../business/sources/telegram-readonly.mjs';

const START = Date.UTC(2026, 9, 8, 12, 0, 0);
const ids = count => Array.from({ length: count }, (_, i) => String(700000 + i));
const source = channelId => `telegram:channel:${channelId}`;

function configure(h, channelIds, { maxRequestsPerDay = 100, maxRequestsPerSourceDay = 20 } = {}) {
  const policies = channelIds.map(channelId => ({
    sourceId: source(channelId), accountId: ACCOUNT, channelId,
    sourceKind: 'live_snapshot',
    processingBasis: 'Synthetic offline portfolio fixture; no Telegram RPC or source claim',
    maxLagSeconds: 300,
  }));
  h.config.opportunity.telegramSources = policies;
  h.config.opportunity.allowedSourceRefs = policies.map(p => p.sourceId);
  h.config.scout.maxRequestsPerDay = maxRequestsPerDay;
  h.config.scout.maxRequestsPerSourceDay = maxRequestsPerSourceDay;
  h.service.sourceTransportHealth = new Map(policies.map(p => [p.sourceId, () => true]));
  return policies.map(({ sourceId }) => ({ sourceId }));
}

function selected(h, readers) {
  return dueTelegramSources(h.service, readers).map(row => row.sourceId);
}

async function currentSyntheticCheckpoint(h, channelId) {
  const sourceId = source(channelId);
  await bootstrapTelegramSource(h.service, sourceId, { pts: 10, history: [] });
  const result = await applyTelegramDifference(h.service, sourceId, {
    kind: 'empty', account_id: ACCOUNT, channel_id: channelId,
    from_pts: 10, to_pts: 10, final: true, updates: [],
  });
  assert.equal(result.phase, 'current');
  assert.equal(sourceAccessReadiness(h.service, sourceId).current, true);
  return sourceId;
}

const eventCounts = h => h.store.get(`SELECT
  (SELECT COUNT(*) FROM events WHERE kind='source.message') AS messages,
  (SELECT COUNT(*) FROM events WHERE kind='source.telegram.baseline') AS baselines,
  (SELECT COUNT(*) FROM events WHERE kind='source.telegram.update') AS updates`);

test('twenty-source rotation gives every reader one turn before a second, including across restart', t => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const h = scoutHarness(t), readers = configure(h, ids(20));
  const firstTurns = [];
  for (let pass = 0; pass < 3; pass++) {
    firstTurns.push(...selected(h, readers));
    t.mock.timers.tick(20_000);
    h.service.control.heartbeat();
  }
  assert.equal(firstTurns.length, 6);
  assert.equal(new Set(firstTurns).size, 6);

  h.restart();
  const resumed = [];
  for (let pass = 0; pass < 7; pass++) {
    resumed.push(...selected(h, readers));
    t.mock.timers.tick(20_000);
    h.service.control.heartbeat();
  }
  assert.equal(resumed.length, 14);
  assert.equal(new Set([...firstTurns, ...resumed]).size, 20,
    'all 20 sources get a first turn despite earlier sources becoming due again during the rotation');
  const secondTurn = selected(h, readers);
  assert.equal(secondTurn.length, 2);
  assert.ok(secondTurn.every(sourceId => firstTurns.includes(sourceId)),
    'only after all 20 first turns may an earlier source receive its second turn');
});

test('a source-specific quota excludes only that source while available portfolio neighbors advance', async t => {
  const h = scoutHarness(t), readers = configure(h, ids(20), { maxRequestsPerDay: 100, maxRequestsPerSourceDay: 1 });
  const limited = readers[0].sourceId;
  await telegramRead(h.service, { accountId: ACCOUNT, sourceId: limited, priority: 'monitor' }, async () => 'synthetic read');

  const due = [];
  for (let pass = 0; pass < 10; pass++) due.push(...selected(h, readers));
  assert.equal(due.length, 19);
  assert.equal(new Set(due).size, 19);
  assert.ok(!due.includes(limited), 'the exhausted source is excluded throughout all portfolio turns');
  assert.equal(telegramReadState(h.service, ACCOUNT, { sourceId: readers[19].sourceId }).ready, true,
    'the source-specific denial does not consume account-wide capacity for its neighbor');
});

test('account FLOOD_WAIT blocks every source and survives restart without source rotation bypass', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const h = scoutHarness(t), readers = configure(h, ids(20));
  let adapterCalls = 0;
  const wait = Object.assign(new Error('synthetic FLOOD_WAIT_600'), { code: 'SCOUT_FLOOD_WAIT', retrySeconds: 600 });
  await assert.rejects(telegramRead(h.service, {
    accountId: ACCOUNT, sourceId: readers[0].sourceId, priority: 'monitor',
  }, async () => { adapterCalls++; throw wait; }), { code: 'SCOUT_FLOOD_WAIT' });

  for (const reader of [readers[1], readers[19]]) {
    await assert.rejects(telegramRead(h.service, {
      accountId: ACCOUNT, sourceId: reader.sourceId, priority: 'monitor',
    }, async () => { adapterCalls++; }), { code: 'SCOUT_ACCOUNT_BACKOFF' });
  }
  assert.deepEqual(selected(h, readers), [], 'portfolio selection honors the account-wide backoff');
  h.restart();
  assert.equal(telegramReadState(h.service, ACCOUNT, { sourceId: readers[19].sourceId }).reason, 'SCOUT_ACCOUNT_BACKOFF');
  await assert.rejects(telegramRead(h.service, {
    accountId: ACCOUNT, sourceId: readers[10].sourceId, priority: 'monitor',
  }, async () => { adapterCalls++; }), { code: 'SCOUT_ACCOUNT_BACKOFF' });
  assert.deepEqual(selected(h, readers), []);
  assert.equal(adapterCalls, 1, 'no alternate source reaches the adapter during the account hold');
});

test('per-source quota denial creates no fresh evidence or current checkpoint', async t => {
  const h = scoutHarness(t), readers = configure(h, ['710001'], {
    maxRequestsPerDay: 10, maxRequestsPerSourceDay: 1,
  });
  const sourceId = await currentSyntheticCheckpoint(h, '710001');
  const checkpointBefore = sourceCheckpoint(h.service, sourceId);
  const countsBefore = eventCounts(h);
  let adapterCalls = 0;
  await telegramRead(h.service, { accountId: ACCOUNT, sourceId, priority: 'monitor' }, async () => { adapterCalls++; });
  await assert.rejects(telegramRead(h.service, { accountId: ACCOUNT, sourceId, priority: 'monitor' }, async () => { adapterCalls++; }),
    { code: 'SCOUT_READ_BUDGET' });

  assert.deepEqual(selected(h, readers), [], 'a due marker cannot turn a denied read into a poll');
  assert.deepEqual(sourceCheckpoint(h.service, sourceId), checkpointBefore);
  assert.equal(sourceCheckpoint(h.service, sourceId).phase, 'current',
    'the prior synthetic checkpoint remains exactly as it was; quota denial cannot confirm it again');
  assert.deepEqual(eventCounts(h), countsBefore, 'read-gate denial adds no source evidence or checkpoint event');
  assert.equal(adapterCalls, 1, 'the denied invocation never enters the adapter callback');
  const cadence = h.store.get("SELECT cursor FROM channel_offsets WHERE channel='scout-monitor-v1'");
  assert.deepEqual(JSON.parse(cadence.cursor).attempts, {},
    'the empty cadence envelope records no per-source poll attempt');
});

test('account backoff withholds current readiness and leaves synthetic checkpoint/evidence unchanged', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const h = scoutHarness(t), readers = configure(h, ['720001', '720002']);
  const sourceId = await currentSyntheticCheckpoint(h, '720001');
  const checkpointBefore = sourceCheckpoint(h.service, sourceId);
  const countsBefore = eventCounts(h);
  let adapterCalls = 0;
  const wait = Object.assign(new Error('synthetic account wait'), { code: 'SCOUT_FLOOD_WAIT', retrySeconds: 600 });
  await assert.rejects(telegramRead(h.service, { accountId: ACCOUNT, sourceId, priority: 'monitor' }, async () => {
    adapterCalls++;
    throw wait;
  }), { code: 'SCOUT_FLOOD_WAIT' });

  assert.equal(sourceAccessReadiness(h.service, sourceId).current, false,
    'account health hold removes current readiness even though the prior checkpoint is retained');
  assert.deepEqual(sourceCheckpoint(h.service, sourceId), checkpointBefore);
  assert.deepEqual(eventCounts(h), countsBefore, 'backoff is not source evidence and does not advance PTS');
  assert.deepEqual(selected(h, readers), [], 'all sources on the held account remain unselected');
  assert.equal(adapterCalls, 1);
});
