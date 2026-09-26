// Two things the live group proved: a sender's clock runs seconds ahead of ours, and a poll that
// fails used to leave no evidence that it had.
// proof_level=synthetic_contract_eval; live_proof=false. No model call, no network, no Telegram.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CLOCK_SKEW_TOLERANCE_MS, normalizeTelegramMessage } from '../business/sources/telegram-readonly.mjs';

const policy = { sourceId: 'telegram:channel:100', accountId: '999', channelId: '100',
  sourceKind: 'sanitized_fixture', processingBasis: 'Invented offline test data only', maxLagSeconds: 120 };
const message = (date) => ({ id: 1, channel_id: '100', from_id: { kind: 'user', id: '10' }, post: false,
  text: 'обычный текст', date });

// A fixed instant, so a slow run between "now" and the check cannot flip a boundary case. The
// tolerance lives on a real clock; the test must not.
const NOW_SECONDS = 1790000000;
const withFrozenClock = fn => {
  const real = Date.now;
  Date.now = () => NOW_SECONDS * 1000;
  try { return fn(); } finally { Date.now = real; }
};

test('a message time may sit ahead of the local clock, by a bounded amount only', () => {
  // The bound is the whole point. Zero tolerance refused a real message stamped fifteen seconds
  // ahead; no tolerance at all would admit any time whatsoever.
  assert.equal(CLOCK_SKEW_TOLERANCE_MS, 30000, 'the tolerance is a named part of the contract');
  const normalize = (aheadSeconds, policyOverride) => withFrozenClock(() =>
    normalizeTelegramMessage(policyOverride ?? policy, message(NOW_SECONDS + aheadSeconds), 1));
  assert.doesNotThrow(() => normalize(0), 'the present is fine');
  assert.doesNotThrow(() => normalize(15), 'fifteen seconds ahead is the case that actually happened');
  assert.doesNotThrow(() => normalize(30), 'exactly at the bound is still accepted');
  assert.throws(() => normalize(31), /TELEGRAM_CLOCK_SKEW/, 'one second past the bound is refused');
  assert.throws(() => normalize(3600), /TELEGRAM_CLOCK_SKEW/, 'an hour ahead is refused');
});

test('a message in the past is never refused, however old', () => withFrozenClock(() => {
  assert.doesNotThrow(() => normalizeTelegramMessage(policy, message(NOW_SECONDS - 86400), 1));
}));

test('the tolerance is not a source policy: a lag budget does not widen it', () => {
  // maxLagSeconds says how old evidence may be. Clock skew is a sender reading ahead of us, and
  // borrowing one for the other would let a stale source post time from the future.
  assert.equal(policy.maxLagSeconds, 120, 'the fixture carries a real lag budget');
  assert.throws(() => withFrozenClock(() => normalizeTelegramMessage({ ...policy, maxLagSeconds: 999999 },
    message(NOW_SECONDS + 60), 1)), /TELEGRAM_CLOCK_SKEW/,
  'a generous lag policy does not buy extra clock tolerance');
});

test('poll telemetry survives a corrupt checkpoint and refuses to record a free-form code', async () => {
  // Two separate promises are under test. Reading the checkpoint can itself fail on a corrupt row,
  // and telemetry that throws while reporting a failure would abort the tick it reports about. And
  // a code copied verbatim off an exception can carry a provider message into durable storage.
  const { Scheduler } = await import('../business/scheduler.mjs');
  const { Store } = await import('../business/store.mjs');
  const { BusinessService } = await import('../business/service.mjs');
  const { loadConfig } = await import('../business/config.mjs');
  const { digest } = await import('../business/source-ingestion.mjs');
  const { bootstrapTelegramSource } = await import('../business/sources/telegram-readonly.mjs');
  const os = await import('node:os'); const fs = await import('node:fs'); const path = await import('node:path');
  const loaded = loadConfig();
  // The automatic branch is the one that polls, and it is guarded, so the fixture stands in the
  // state a live read-only run is actually in, and declares its own source rather than borrowing
  // whatever local config happens to say.
  const cfg = { ...loaded, opportunity: { ...loaded.opportunity, automatic: true },
    runtime: { ...loaded.runtime, enabled: false },
    telegram: { ...loaded.telegram, enabled: true, liveSending: false } };
  const sourceId = 'telegram:channel:100';
  cfg.opportunity.telegramSources = [{ accountId: '999', channelId: '100', sourceId,
    sourceKind: 'sanitized_fixture', processingBasis: 'Invented offline test only', maxLagSeconds: 120 }];
  cfg.opportunity.allowedSourceRefs = [sourceId];

  for (const [label, thrown, expected, corrupt] of [
    // The checkpoint itself is unreadable, so reading it inside telemetry fails too.
    ['a corrupt checkpoint row', Error('bad json'), 'UNCLASSIFIED', true],
    // A well-formed checkpoint, so the failure class itself is what is being recorded.
    ['a free-form provider code', Object.assign(Error('auth key sk-live-abcdef provider said no'),
      { code: 'provider said no: sk-live-abcdef' }), 'UNCLASSIFIED', false],
    ['no code at all', Error('plain failure'), 'UNCLASSIFIED', false],
  ]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-poll-fail-'));
    const store = new Store(directory);
    const service = new BusinessService(store, cfg);
    if (corrupt) {
      store.run("INSERT OR REPLACE INTO channel_offsets(channel,account_id,cursor) VALUES(?,?,?)",
        'telegram-source-v0', digest([cfg.partnerId, sourceId]), '{not json');
    } else {
      await bootstrapTelegramSource(service, sourceId, { pts: 10, history: [] });
    }
    const scheduler = new Scheduler(service, { close() {} },
      { readiness: () => ({ enabled: false, live_sending: false, connected: false, configured: false }) },
      [{ sourceId, transport: { readDifference: async () => { throw thrown; } } }]);
    await scheduler.tick();
    const rows = store.all("SELECT payload_json FROM events WHERE kind='source.telegram.poll.failed'");
    assert.equal(rows.length, 1, `${label}: the failure is recorded, not swallowed`);
    const payload = JSON.parse(rows[0].payload_json);
    assert.equal(payload.code, expected, `${label}: only a code-shaped value is recorded`);
    assert.equal(scheduler.busy, false, `${label}: the tick finished`);
    assert.doesNotMatch(rows[0].payload_json, /sk-live-abcdef/, `${label}: no provider payload is stored`);
    if (corrupt) assert.equal(payload.checkpoint_pts, null, `${label}: an unreadable checkpoint reads as null`);
    else assert.equal(payload.checkpoint_pts, 10, `${label}: a readable checkpoint is reported`);
    assert.equal(scheduler.lastReason, `source_read_failed:${expected}`, `${label}: the class reaches the operator`);
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
