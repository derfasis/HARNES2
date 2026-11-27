import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { probeDemandCandidates, probeScoutDemandCandidates } from '../experiments/demand-radar-v0/probe.mjs';
import { ACCOUNT, message, noHistory, scoutHarness } from './scout-test-helpers.mjs';

const mission = { id: 'commercial-needs', revision: 1, families: [
  { id: 'commercial_task', contains_any: ['find a supplier'] },
] };
const digestText = value => createHash('sha256').update(value).digest('hex');
const msg = (message_id, extra = {}) => ({
  message_id, author_ref: 'author-1', date: '2026-09-01T09:00:00.000Z',
  text: 'I need to find a supplier for these products.', reply_to: null, unsupported: false,
  ...extra,
});
const legacySample = messages => ({ status: 'sealed', source_ref: 'fixture:opaque-source', digest: 'fixture-digest',
  coverage: 'message_limit', messages });
const fails = (fn, pattern = /SAMPLE_|MESSAGE_|ANCESTRY_|INPUT_|LIMIT/) => assert.throws(fn, pattern);

test('rejects coerced or oversized message identities and malformed message fields', () => {
  for (const id of [12, {}, 'x'.repeat(151)]) {
    fails(() => probeDemandCandidates({ mission, sample: legacySample([msg(id)]) }), /MESSAGE_|SAMPLE_/);
  }
  for (const malformed of [
    msg('1', { author_ref: 7 }),
    msg('1', { author_ref: 'a'.repeat(151) }),
    msg('1', { reply_to: {} }),
    msg('1', { unsupported: 'yes' }),
    msg('1', { text: 7 }),
    msg('1', { text: 'x'.repeat(16001) }),
    msg('1', { date: 'not-a-date' }),
  ]) {
    fails(() => probeDemandCandidates({ mission, sample: legacySample([malformed]) }));
  }
});

test('rejects a sample whose total text exceeds the offline input budget', () => {
  const messages = Array.from({ length: 126 }, (_, i) => msg(String(i + 1), { text: 'x'.repeat(16000) }));
  fails(() => probeDemandCandidates({ mission, sample: legacySample(messages) }), /INPUT_|LIMIT|SAMPLE_/);
});

test('walks full reply ancestry and labels missing, opaque, self and cyclic branches', () => {
  const messages = [
    msg('1', { reply_to: 'missing' }),
    msg('2', { reply_to: '1' }),
    msg('3', { unsupported: true, text: null }),
    msg('4', { reply_to: '3' }),
    msg('5', { reply_to: '5' }),
    msg('6', { reply_to: '7' }),
    msg('7', { reply_to: '6' }),
    msg('8', { author_ref: 'other-author' }),
  ];
  const result = probeDemandCandidates({ mission, sample: legacySample(messages) });
  const byId = new Map(result.candidates.map(candidate => [candidate.message_id, candidate]));
  assert.equal(byId.get('1').context_incomplete, true);
  assert.equal(byId.get('1').ancestry_reason, 'missing_reply_ancestry');
  assert.equal(byId.get('2').context_incomplete, true);
  assert.equal(byId.get('2').ancestry_reason, 'missing_reply_ancestry');
  assert.equal(byId.get('4').context_incomplete, true);
  assert.equal(byId.get('4').ancestry_reason, 'opaque_reply_ancestry');
  assert.equal(byId.get('5').ancestry_reason, 'cyclic_reply_ancestry');
  assert.equal(byId.get('6').ancestry_reason, 'cyclic_reply_ancestry');
  assert.equal(byId.get('8').context_incomplete, false); // Independent messages stay usable.
  assert.equal(byId.get('8').ancestry_reason, null);
});

test('caps same-author context references and labels truncation without inferring cancellation', () => {
  const messages = Array.from({ length: 40 }, (_, i) => msg(String(i + 1), {
    author_ref: 'one-author', text: `I need to find a supplier in case ${i}.`,
  }));
  const result = probeDemandCandidates({ mission, sample: legacySample(messages) });
  for (const candidate of result.candidates) {
    assert.equal(candidate.same_author_context_total, 39);
    assert.equal(candidate.same_author_other_message_ids.length, 32);
    assert.equal(candidate.same_author_context_truncated, true);
    assert.equal(candidate.semantic_intent, undefined);
    assert.equal(candidate.cancellation, undefined);
  }
});

test('returns detached output so later input mutation cannot alter evidence', () => {
  const sample = legacySample([msg('1')]);
  const result = probeDemandCandidates({ mission, sample });
  const originalText = result.candidates[0].text;
  sample.messages[0].text = 'Changed after the probe returned';
  sample.messages.push(msg('2'));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].text, originalText);
});

async function authenticScoutSample(t) {
  const h = scoutHarness(t, { history: async input => input.before_id
    ? noHistory(input)
    : { empty: false, requested_count: input.limit, received_count: 1, oldest_id: 1,
      messages: [message('1', { text: 'I need to find a supplier for these products.', unsupported: null })] } });
  const campaign = await h.campaign('Synthetic supplier task');
  await h.authorize(campaign);
  const candidate = await h.seed(campaign);
  const sample = await h.auditAndSeal(campaign, candidate);
  assert.equal(sample.status, 'sealed');
  assert.equal(sample.account_id, ACCOUNT);
  return sample;
}

test('Scout adapter verifies an authentic sealed row and leaves currentness unknown', async t => {
  const row = await authenticScoutSample(t);
  const result = probeScoutDemandCandidates({ mission, sample: row });
  assert.equal(result.sample.digest_checked, true);
  assert.equal(result.sample.currentness, 'NOT_CHECKED');
  assert.equal(result.verdict.current_intent, 'UNKNOWN');
  assert.equal(result.verdict.can_promote_to_discovery, false);
  assert.equal(result.verdict.contact_permission, false);
  assert.equal(result.verdict.model_calls, 0);
  assert.equal(result.verdict.network_calls, 0);
});

test('Scout adapter fails closed if any committed sample field is tampered', async t => {
  const original = await authenticScoutSample(t);
  const messages = JSON.parse(original.messages_json);
  messages[0].text = 'I need to find a supplier, but digest is unchanged.';
  messages[0].content_hash = digestText(messages[0].text);
  const tampered = { ...original, messages_json: JSON.stringify(messages) };
  fails(() => probeScoutDemandCandidates({ mission, sample: tampered }), /SAMPLE_|MESSAGE_/);

  const changedCoverage = { ...original, coverage: 'no_visible_messages' };
  fails(() => probeScoutDemandCandidates({ mission, sample: changedCoverage }), /SAMPLE_/);
});

test('old authentic Scout row is not presented as current', async t => {
  const original = await authenticScoutSample(t);
  const old = { ...original, finished_at: '2020-01-01T00:00:00.000Z' };
  const result = probeScoutDemandCandidates({ mission, sample: old });
  assert.equal(result.sample.currentness, 'NOT_CHECKED');
  assert.equal(result.verdict.current_intent, 'UNKNOWN');
  assert.equal(result.verdict.can_promote_to_discovery, false);
});
