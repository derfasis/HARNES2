import test from 'node:test';
import assert from 'node:assert/strict';
import { probeDemandCandidates } from '../experiments/demand-radar-v0/probe.mjs';

const mission = { id: 'commercial-needs', revision: 1, families: [
  { id: 'unmonetized_client_questions', contains_any: ['клиенты спрашивают', 'клієнти запитують'] },
  { id: 'time_capacity', contains_any: ['не могу брать больше клиентов', 'не можу брати більше клієнтів'] },
] };
const messages = [
  { message_id: '101', author_ref: 'account-ru', date: '2026-09-01T09:00:00Z',
    text: 'Клиенты спрашивают про товары, а я пока предлагаю только услуги.' },
  { message_id: '102', author_ref: 'account-ua', date: '2026-09-01T10:00:00Z',
    text: 'Клієнти запитують про товари, але я не хочу продавати MLM.' },
  { message_id: '103', author_ref: 'seller', date: '2026-09-01T11:00:00Z',
    text: 'Цитата клиента: «Клиенты спрашивают, где найти дилеров». Пишите мне.' },
  { message_id: '104', author_ref: 'account-ru', date: '2026-09-02T09:00:00Z',
    text: 'Я передумала. Никакие дополнительные товары продавать не буду.', reply_to: '101' },
  { message_id: '105', author_ref: 'account-ru', date: '2026-09-01T09:00:00Z',
    text: 'Клиенты спрашивают про товары, а я пока предлагаю только услуги.' },
  { message_id: '106', author_ref: 'account-third', date: '2026-09-01T10:00:00Z',
    text: 'Не могу брать больше клиентов: времени нет.', reply_to: '999' },
  { message_id: '107', author_ref: 'account-ua', date: '2026-09-01T10:00:00Z',
    text: null, unsupported: true },
];
const sample = { status: 'sealed', source_ref: 'scout-sample:synthetic', digest: 'fixture-digest',
  coverage: 'message_limit', messages };

test('keeps source text/negation, same author cancellation, role ambiguity and unknown fit', () => {
  const r = probeDemandCandidates({ mission, sample });
  assert.deepEqual(r.candidates.map(x => x.message_id), ['101','102','103','105','106']);
  assert.equal(r.candidates[1].text, messages[1].text);
  assert.equal(r.candidates[1].acquisition_matches[0].family_id, 'unmonetized_client_questions');
  assert.equal(r.candidates[2].author_ref, 'seller'); // Still a candidate, NEVER called an own request.
  assert(r.candidates[0].same_author_other_message_ids.includes('104')); // Cancellation remains available.
  assert.equal(r.candidates[3].duplicate_of, '101');
  assert.equal(r.candidates[4].context_incomplete, true);
  assert.equal(r.verdict.semantic_intent, 'NOT_ASSESSED');
  assert.equal(r.verdict.offer_fit, 'UNKNOWN');
  assert.equal(r.verdict.contact_permission, false);
  assert.equal(r.verdict.can_promote_to_discovery, false);
});

test('preserves denominator, omitted, nonmatches and no source completeness claim', () => {
  const r = probeDemandCandidates({ mission, sample });
  assert.deepEqual(r.counts, { raw_messages: 7, eligible_messages: 6, candidates: 5,
    unselected: 1, omitted: 1, exact_same_author_repeats: 1,
    distinct_source_scoped_author_refs: 4 });
  assert.equal(r.unselected[0].message_id, '104');
  assert.equal(r.omitted[0].reason, 'unsupported');
  assert.equal(r.sample.continuous_coverage_proven, false);
  assert.equal(r.sample.digest_checked, false);
  assert.equal(r.verdict.model_calls, 0);
  assert.equal(r.verdict.network_calls, 0);
});

test('an empty route is NOT zero market demand or a semantic NEGATIVE', () => {
  const r = probeDemandCandidates({ mission: { ...mission, revision: 2,
    families: [{ id: 'offtopic', contains_any: ['nothing-this-sample-says'] }] }, sample });
  assert.equal(r.counts.candidates, 0);
  assert.equal(r.counts.unselected, 6);
  assert.equal(r.verdict.current_intent, 'UNKNOWN');
  assert.equal(r.sample.declared_coverage, 'message_limit');
});

test('rejects unknown sample, duplicate IDs and invalid mission', () => {
  assert.throws(() => probeDemandCandidates({ mission, sample: { ...sample, status: 'collecting' } }), /SEALED_SAMPLE_REQUIRED/);
  assert.throws(() => probeDemandCandidates({ mission, sample: { ...sample, messages: [messages[0], messages[0]] } }), /MESSAGE_INVALID/);
  assert.throws(() => probeDemandCandidates({ mission: { ...mission, families: [{ id: 'x', contains_any: [] }] }, sample }), /FAMILY_INVALID/);
});
