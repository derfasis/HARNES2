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

test('a message time may sit ahead of the local clock, by a bounded amount only', () => {
  // The bound is the whole point. Zero tolerance refused a real message stamped fifteen seconds
  // ahead; no tolerance at all would admit any time whatsoever.
  assert.equal(CLOCK_SKEW_TOLERANCE_MS, 30000, 'the tolerance is a named part of the contract');
  const now = Date.now() / 1000;
  const accept = seconds => normalizeTelegramMessage(policy, message(Math.floor(now + seconds)), 1);
  assert.doesNotThrow(() => accept(0), 'the present is fine');
  assert.doesNotThrow(() => accept(15), 'fifteen seconds ahead is the case that actually happened');
  assert.doesNotThrow(() => accept(30), 'exactly at the bound is still accepted');
  assert.throws(() => accept(31), /TELEGRAM_CLOCK_SKEW/, 'one second past the bound is refused');
  assert.throws(() => accept(3600), /TELEGRAM_CLOCK_SKEW/, 'an hour ahead is refused');
});

test('a message in the past is never refused, however old', () => {
  const yesterday = Math.floor(Date.now() / 1000) - 86400;
  assert.doesNotThrow(() => normalizeTelegramMessage(policy, message(yesterday), 1));
});

test('the tolerance is not a source policy: a lag budget does not widen it', () => {
  // maxLagSeconds says how old evidence may be. Clock skew is a sender reading ahead of us, and
  // borrowing one for the other would let a stale source post time from the future.
  assert.equal(policy.maxLagSeconds, 120, 'the fixture carries a real lag budget');
  assert.throws(() => normalizeTelegramMessage({ ...policy, maxLagSeconds: 999999 },
    message(Math.floor(Date.now() / 1000) + 60), 1), /TELEGRAM_CLOCK_SKEW/,
  'a generous lag policy does not buy extra clock tolerance');
});
