import test from 'node:test';
import assert from 'node:assert/strict';
import { probeDemandCandidates, probeScoutDemandCandidates } from '../experiments/demand-radar-v0/probe.mjs';
import { buildDemandReviewPacket } from '../experiments/demand-radar-v0/review-packet.mjs';
import { message, noHistory, scoutHarness } from './scout-test-helpers.mjs';

const mission = { id: 'commercial-needs', revision: 1, families: [
  { id: 'commercial_task', contains_any: ['find a supplier'] },
] };
const matched = (id, extra = {}) => message(String(id), {
  text: `I need to find a supplier for batch ${id}.`, ...extra,
});
const plain = (id, text, extra = {}) => message(String(id), { text, ...extra });
const names = group => group.messages.map(row => row.message_id);
const throwsContract = (fn, pattern = /SAMPLE_UNVERIFIED|CURSOR|INTEGRITY|LIMIT|MISSION|PROBE/) => assert.throws(fn, pattern);

async function verifiedProbe(t, rows, selectedMission = mission) {
  const nativeRows = rows.map(m => ({ ...m, unsupported: m.unsupported ? 'SYNTHETIC_OPAQUE' : null }));
  const h = scoutHarness(t, { history: async input => input.before_id
    ? noHistory(input)
    : { empty: false, requested_count: input.limit, received_count: rows.length,
      oldest_id: Math.min(...rows.map(row => Number(row.message_id))), messages: nativeRows } });
  const campaign = await h.campaign('Synthetic supplier task');
  await h.authorize(campaign);
  const candidate = await h.seed(campaign);
  const sample = await h.auditAndSeal(campaign, candidate);
  assert.equal(sample.status, 'sealed');
  return probeScoutDemandCandidates({ mission: selectedMission, sample });
}

test('refuses a legacy unverified probe and invalid packet bounds', () => {
  const legacy = probeDemandCandidates({ mission, sample: {
    status: 'sealed', source_ref: 'fixture:old', digest: 'declared-only', coverage: 'message_limit',
    messages: [matched(1)],
  } });
  throwsContract(() => buildDemandReviewPacket({ probe: legacy }), /SAMPLE_UNVERIFIED/);

  const verifiedShape = { ...legacy, sample: { ...legacy.sample, digest_checked: true } };
  throwsContract(() => buildDemandReviewPacket({ probe: verifiedShape }), /PROBE_INTEGRITY|INTEGRITY/);
  for (const options of [
    { max_anchors: 0 }, { max_anchors: 25 }, { max_characters: 0 }, { max_characters: 96001 },
    { exploration_slots: -1 }, { max_anchors: 1, exploration_slots: 2 },
  ]) throwsContract(() => buildDemandReviewPacket({ probe: verifiedShape, ...options }));
});

test('selects matched anchors first, reserves exploration, and skips duplicate anchors', async t => {
  const rows = [
    matched(100, { author_ref: 'author-a', reply_to: '90' }),
    matched(101, { author_ref: 'author-a', reply_to: '90', text: 'I need to find a supplier for batch 100.' }),
    matched(200, { author_ref: 'author-b' }),
    plain(300, 'A readable message that does not match the route.', { author_ref: 'author-c' }),
    plain(90, 'Parent context predating the anchor.', { author_ref: 'parent-author', date: new Date(Date.now() - 600000).toISOString() }),
  ];
  const probe = await verifiedProbe(t, rows);
  const before = structuredClone(probe);
  const packet = buildDemandReviewPacket({ probe, max_anchors: 3, exploration_slots: 1 });
  assert.deepEqual(packet.groups.map(group => [group.anchor_message_id, group.route]), [
    ['100', 'matched'], ['200', 'matched'], ['300', 'exploration'],
  ]);
  assert.deepEqual(packet.groups[0].messages.find(row => row.message_id === '101')?.text,
    rows[1].text); // Duplicate stays available in its source context.
  const reversedProbe = await verifiedProbe(t, [...rows].reverse());
  const reversedPacket = buildDemandReviewPacket({ probe: reversedProbe, max_anchors: 3, exploration_slots: 1 });
  assert.deepEqual(reversedPacket.groups.map(group => [group.anchor_message_id, group.route]),
    packet.groups.map(group => [group.anchor_message_id, group.route]));
  assert.deepEqual(probe, before); // Packet construction is read-only.
  assert.equal(packet.verdict.semantic_intent, 'NOT_ASSESSED');
  assert.equal(packet.verdict.offer_fit, 'UNKNOWN');
  assert.equal(packet.verdict.current_intent, 'UNKNOWN');
  assert.equal(packet.verdict.contact_permission, false);
  assert.equal(packet.verdict.can_promote_to_discovery, false);
});

test('context order is anchor, ancestry, direct replies, then latest same-author rows', async t => {
  const rows = [
    plain(80, 'Older message by the anchor author.', { author_ref: 'author-a', date: new Date(Date.now() - 300000).toISOString() }),
    plain(90, 'Parent message from another author.', { author_ref: 'author-b', reply_to: null, date: new Date(Date.now() - 240000).toISOString() }),
    matched(100, { author_ref: 'author-a', reply_to: '90', date: new Date(Date.now() - 180000).toISOString() }),
    plain(110, 'A direct reply from another participant.', { author_ref: 'author-c', reply_to: '100', date: new Date(Date.now() - 120000).toISOString() }),
    plain(120, 'A vendor says the supplier pitch is not wanted.', { author_ref: 'author-d', reply_to: '100', date: new Date(Date.now() - 90000).toISOString() }),
    plain(130, 'I changed my mind and will not look for suppliers.', { author_ref: 'author-a', date: new Date(Date.now() - 60000).toISOString() }),
  ];
  const probe = await verifiedProbe(t, rows);
  const packet = buildDemandReviewPacket({ probe, max_anchors: 1, exploration_slots: 0 });
  assert.equal(packet.groups.length, 1);
  assert.deepEqual(names(packet.groups[0]), ['100', '90', '110', '120', '130', '80']);
  assert.equal(packet.groups[0].messages.find(row => row.message_id === '120').text, rows[4].text);
  assert.equal(packet.groups[0].messages.find(row => row.message_id === '130').text, rows[5].text);
});

test('keeps nested replies from other authors through depth three, including newest counterevidence', async t => {
  const rows = [
    matched(100, { author_ref: 'author-a', reply_to: null, date: new Date(Date.now() - 240000).toISOString() }),
    plain(110, 'Could you explain what this request means?', { author_ref: 'author-b', reply_to: '100', date: new Date(Date.now() - 180000).toISOString() }),
    plain(120, 'I think the earlier phrase was quoted from someone else.', { author_ref: 'author-c', reply_to: '110', date: new Date(Date.now() - 120000).toISOString() }),
    plain(130, 'That is right: this was another person’s request, and I do not want the offer.', { author_ref: 'author-d', reply_to: '120', date: new Date(Date.now() - 60000).toISOString() }),
  ];
  const probe = await verifiedProbe(t, rows);
  const packet = buildDemandReviewPacket({ probe, max_anchors: 1, max_characters: 2000, exploration_slots: 0 });
  const group = packet.groups[0];
  assert.deepEqual(names(group), ['100', '110', '120', '130']);
  assert.equal(group.messages[3].text, rows[3].text);
  assert.equal(group.context_incomplete, false);
});

test('walks through an opaque descendant, discloses its ID, and retains readable nested context', async t => {
  const rows = [
    matched(100, { author_ref: 'author-a', reply_to: null }),
    plain(110, null, { author_ref: 'author-b', reply_to: '100', unsupported: true }),
    plain(120, 'This was someone else’s question; I do not want more information.',
      { author_ref: 'author-c', reply_to: '110' }),
  ];
  const probe = await verifiedProbe(t, rows);
  const packet = buildDemandReviewPacket({ probe, max_anchors: 1, max_characters: 2000, exploration_slots: 0 });
  const group = packet.groups[0];
  assert.deepEqual(names(group), ['100', '120']);
  assert.equal(group.messages[1].text, rows[2].text);
  assert.ok(group.omitted_context_message_ids.includes('110'));
  assert.equal(group.context_incomplete, true);
});

test('caps a nested reply branch at 32 rows and lists every omitted descendant', async t => {
  const rows = [matched(100, { author_ref: 'author-0', reply_to: null,
    date: new Date(Date.now() - 100000).toISOString() })];
  for (let id = 101; id < 140; id++) rows.push(plain(id,
    `Reply ${id} adds context without matching the acquisition phrase.`,
    { author_ref: `author-${id}`, reply_to: String(id - 1), date: new Date(Date.now() - (140 - id) * 1000 - 50000).toISOString() }));
  const probe = await verifiedProbe(t, rows);
  const packet = buildDemandReviewPacket({ probe, max_anchors: 1, max_characters: 24000, exploration_slots: 0 });
  const group = packet.groups[0];
  assert.equal(group.messages.length, 32);
  assert.deepEqual(group.omitted_context_message_ids, ['132', '133', '134', '135', '136', '137', '138', '139']);
  assert.equal(group.context_incomplete, true);
});

test('character budget discloses a deferred grandchild and deeper reply without slicing text', async t => {
  const anchor = matched(100, { author_ref: 'author-a', reply_to: null });
  const direct = plain(110, 'A short direct reply.', { author_ref: 'author-b', reply_to: '100' });
  const grandchild = plain(120, `A long nested reply ${'x'.repeat(180)}.`,
    { author_ref: 'author-c', reply_to: '110' });
  const deeper = plain(130, 'The deepest reply contains a counterstatement.',
    { author_ref: 'author-d', reply_to: '120' });
  const probe = await verifiedProbe(t, [anchor, direct, grandchild, deeper]);
  const budget = anchor.text.length + direct.text.length;
  const packet = buildDemandReviewPacket({ probe, max_anchors: 1, max_characters: budget, exploration_slots: 0 });
  const group = packet.groups[0];
  assert.deepEqual(names(group), ['100', '110']);
  assert.deepEqual(group.omitted_context_message_ids, ['120', '130']);
  assert.equal(group.context_incomplete, true);
  assert.equal(packet.characters, budget);
  assert.equal(group.messages[0].text, anchor.text);
  assert.equal(group.messages[1].text, direct.text);
  assert.ok(!group.messages.some(row => row.text.includes('xxxxx')));
});

test('skips incomplete ancestry without consuming the only anchor slot', async t => {
  const rows = [
    matched(100, { reply_to: '999' }),
    matched(200, { author_ref: 'independent-author', reply_to: null }),
  ];
  const probe = await verifiedProbe(t, rows);
  const packet = buildDemandReviewPacket({ probe, max_anchors: 1, exploration_slots: 0 });
  assert.deepEqual(packet.groups.map(group => group.anchor_message_id), ['200']);
  const skipped = Object.values(packet).flat().find(value => value && value.message_id === '100' && value.reason);
  assert.ok(skipped, 'incomplete candidate is explained as a skipped anchor');
  assert.match(skipped.reason, /ancestry|context|incomplete/i);
});

test('never truncates a message to fit the packet and advances past an oversized anchor', async t => {
  const rows = [
    matched(100, { text: `I need to find a supplier. ${'x'.repeat(400)}` }),
    matched(200, { author_ref: 'author-b' }),
  ];
  const probe = await verifiedProbe(t, rows);
  const packet = buildDemandReviewPacket({ probe, max_anchors: 1, max_characters: 120, exploration_slots: 0 });
  assert.deepEqual(packet.groups.map(group => group.anchor_message_id), ['200']);
  const skipped = Object.values(packet).flat().find(value => value && value.message_id === '100' && value.reason);
  assert.ok(skipped, 'oversized anchor is disclosed as skipped');
  assert.match(skipped.reason, /size|character|budget|limit/i);
  for (const group of packet.groups) {
    for (const row of group.messages) assert.ok(row.text.length <= 120);
  }
});

test('caps context at 32 rows and discloses every omitted relevant author message', async t => {
  const rows = Array.from({ length: 40 }, (_, i) => matched(100 + i, {
    author_ref: 'one-author', text: `I need to find a supplier for message ${i}.`,
    date: new Date(Date.now() - (500000 - i * 1000)).toISOString(),
  }));
  const probe = await verifiedProbe(t, rows);
  const packet = buildDemandReviewPacket({ probe, max_anchors: 1, max_characters: 24000, exploration_slots: 0 });
  const group = packet.groups[0];
  assert.equal(group.messages.length, 32);
  assert.equal(group.context_incomplete, true);
  assert.equal(group.omitted_context_message_ids.length, 8);
  assert.equal(new Set(group.omitted_context_message_ids).size, 8);
  const totalText = packet.groups.flatMap(g => g.messages).reduce((n, row) => n + row.text.length, 0);
  assert.ok(totalText <= 24000);
});

test('reserves whole anchors before context and discloses oversized contextual messages', async t => {
  const rows = [matched(100, { author_ref: 'author-a' }),
    plain(110, 'A long but valid contextual reply. ' + 'x'.repeat(800), { author_ref: 'peer', reply_to: '100' }),
    plain(200, 'A keywordless business question.', { author_ref: 'author-b' })];
  const probe = await verifiedProbe(t, rows);
  const packet = buildDemandReviewPacket({ probe, max_anchors: 2, max_characters: 120, exploration_slots: 1 });
  assert.deepEqual(packet.groups.map(g => g.anchor_message_id), ['100', '200']);
  const first = packet.groups[0];
  assert.equal(first.messages[0].text, rows[0].text);
  assert(first.context_incomplete); assert(first.omitted_context_message_ids.includes('110'));
  assert(!first.messages.some(m => m.message_id === '110'), 'never slice context text to manufacture coverage');
  assert.equal(packet.characters, rows[0].text.length + rows[2].text.length);
  assert(packet.characters <= 120);
});

test('discloses opaque same-author context outside the reply branch without labeling it intent', async t => {
  const rows = [
    matched(100, { author_ref: 'one-author', reply_to: null }),
    plain(90, null, { author_ref: 'one-author', unsupported: true, reply_to: null }),
    plain(110, 'I changed my mind and will not look for suppliers.', { author_ref: 'one-author' }),
  ];
  const probe = await verifiedProbe(t, rows);
  const packet = buildDemandReviewPacket({ probe, max_anchors: 1, exploration_slots: 0 });
  const group = packet.groups[0];
  assert.ok(group.omitted_context_message_ids.includes('90'));
  assert.equal(group.context_incomplete, true);
  const laterCancellation = group.messages.find(row => row.message_id === '110');
  assert.equal(laterCancellation.text, rows[2].text);
  assert.equal(laterCancellation.semantic_intent, undefined);
  assert.equal(laterCancellation.cancellation, undefined);
});

test('does not present a same-author reply as complete while silently omitting its parent', async t => {
  const rows = [
    matched(100, { author_ref: 'one-author', reply_to: null }),
    plain(199, 'A vendor reply that gives the same-author message its context.', { author_ref: 'vendor-author', reply_to: null }),
    plain(200, 'I changed my mind and will not look for suppliers.', { author_ref: 'one-author', reply_to: '199' }),
  ];
  const probe = await verifiedProbe(t, rows);
  const packet = buildDemandReviewPacket({ probe, max_anchors: 1, exploration_slots: 0 });
  const group = packet.groups[0];
  const includesParent = group.messages.some(row => row.message_id === '199');
  const disclosesOmission = group.omitted_context_message_ids.includes('199') && group.context_incomplete;
  assert.ok(includesParent || disclosesOmission,
    'include the parent or disclose that same-author reply context was omitted');
});

test('packet cursor advances without starvation and rejects changed mission or probe content', async t => {
  const rows = [matched(100), matched(200, { author_ref: 'author-b' }), matched(300, { author_ref: 'author-c' })];
  const probe = await verifiedProbe(t, rows);
  const first = buildDemandReviewPacket({ probe, max_anchors: 1, exploration_slots: 0 });
  assert.deepEqual(first.groups.map(group => group.anchor_message_id), ['100']);
  assert.ok(first.next_cursor);
  assert.ok(first.deferred_count > 0);
  assert.ok(Array.isArray(first.remaining_anchors) || Number.isInteger(first.remaining_anchors));
  const second = buildDemandReviewPacket({ probe, max_anchors: 1, exploration_slots: 0, cursor: first.next_cursor });
  assert.deepEqual(second.groups.map(group => group.anchor_message_id), ['200']);

  throwsContract(() => buildDemandReviewPacket({ probe, max_anchors: 1, max_characters: 23999,
    exploration_slots: 0, cursor: first.next_cursor }), /CURSOR|INTEGRITY/);
  const changedMissionProbe = await verifiedProbe(t, rows, { ...mission, revision: 2 });
  throwsContract(() => buildDemandReviewPacket({ probe: changedMissionProbe,
    max_anchors: 1, exploration_slots: 0, cursor: first.next_cursor }), /CURSOR|INTEGRITY/);
  const altered = structuredClone(probe);
  altered.candidates[0].text = 'Changed after verification while the declared sample digest stays the same.';
  throwsContract(() => buildDemandReviewPacket({ probe: altered, max_anchors: 1,
    exploration_slots: 0, cursor: first.next_cursor }), /INTEGRITY|CURSOR/);
});
