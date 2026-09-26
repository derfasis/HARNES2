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
  // A poll failure is reported by reading the checkpoint, and a corrupt checkpoint is exactly the
  // kind of state a poll fails on. Telemetry that throws there would abort the tick it reports on,
  // and a code copied from an exception could carry provider payload into durable storage.
  const { Scheduler } = await import('../business/scheduler.mjs');
  const { Store } = await import('../business/store.mjs');
  const { BusinessService } = await import('../business/service.mjs');
  const { loadConfig } = await import('../business/config.mjs');
  const { digest } = await import('../business/source-ingestion.mjs');
  // The automatic branch is the one that polls, and it is guarded, so the fixture has to stand in
  // the state a live read-only run actually runs in.
  const loaded = loadConfig();
  const cfg = { ...loaded, opportunity: { ...loaded.opportunity, automatic: true },
    runtime: { ...loaded.runtime, enabled: false },
    telegram: { ...loaded.telegram, enabled: true, liveSending: false } };
  // The fixture declares its own source rather than borrowing whatever local config happens to
  // say, so the test means the same thing on a developer machine and in CI.
  const sourceId = 'telegram:channel:100';
  cfg.opportunity.telegramSources = [{ accountId: '999', channelId: '100', sourceId,
    sourceKind: 'sanitized_fixture', processingBasis: 'Invented offline test only', maxLagSeconds: 120 }];
  cfg.opportunity.allowedSourceRefs = [sourceId];
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  for (const [label, thrown, expected] of [
    // A corrupt checkpoint breaks the poll itself with a parse error that carries no code, so the
    // recorded class is UNCLASSIFIED. What matters is that telemetry still survives the read.
    ['a corrupt checkpoint row', Error('bad json'), 'UNCLASSIFIED'],
    ['a free-form provider message', Object.assign(Error('auth key sk-live-abcdef provider said no'),
      { code: 'provider said no: sk-live-abcdef' }), 'UNCLASSIFIED'],
    ['no code at all', Error('plain failure'), 'UNCLASSIFIED'],
  ]) {
    // Its own database per case: telemetry accumulates by design, and a shared file would make
    // the count depend on how many times the suite had been run before.
    const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-poll-fail-')));
    const service = new BusinessService(store, cfg);
    const scheduler = new Scheduler(service, { close() {} },
      { readiness: () => ({ enabled: false, live_sending: false, connected: false, configured: false }) },
      [{ sourceId, transport: { readDifference: async () => { throw thrown; } } }]);
    // Corrupt the checkpoint first, so reading it inside telemetry fails too.
    // Corrupt the very row sourceCheckpoint reads, so the read inside telemetry fails too.
    store.run("INSERT OR REPLACE INTO channel_offsets(channel,account_id,cursor) VALUES(?,?,?)",
      'telegram-source-v0', digest([cfg.partnerId, sourceId]), '{not json');
    await scheduler.tick();
    const rows = store.all("SELECT payload_json FROM events WHERE kind='source.telegram.poll.failed'");
    assert.equal(rows.length, 1, `${label}: the failure is still recorded`);
    const payload = JSON.parse(rows[0].payload_json);
    assert.equal(payload.code, expected, `${label}: only a code-shaped value is recorded`);
    assert.equal(payload.checkpoint_pts, null, `${label}: an unreadable checkpoint is reported as null`);
    assert.equal(scheduler.busy, false, `${label}: the tick completed`);
    assert.doesNotMatch(rows[0].payload_json, /sk-live-abcdef/, `${label}: no provider payload is stored`);
    store.close();
    fs.rmSync(store.directory ?? '', { recursive: true, force: true });
  }
});
