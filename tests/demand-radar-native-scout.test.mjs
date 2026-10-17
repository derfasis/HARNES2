// Native Scout-to-retrieval conformance. Synthetic SDK objects and a mocked invoke only;
// no Telegram socket, model call, or live source content.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { TelegramScoutRpc } from '../business/sources/telegram-scout-rpc.mjs';
import { Api } from '../business/sources/telegram-gramjs-semantic.mjs';
import { digest } from '../business/source-ingestion.mjs';
import { probeScoutDemandCandidates } from '../experiments/demand-radar-v0/probe.mjs';
import { scoutHarness } from './scout-test-helpers.mjs';

const require = createRequire(import.meta.url);
const bigInt = require('big-integer');
const ACCOUNT = '991234567890';
const CHANNEL_ID = '123456789';
const ACCESS_HASH = '998877665544';
const mission = { id: 'commercial-task-ru-ua', revision: 1, families: [
  { id: 'expressed_need', contains_any: ['supplier', 'inventory'] },
] };
const sha256Text = text => createHash('sha256').update(text).digest('hex');

function makeMessage(id, text, secondsAgo, authorId = 41) {
  return new Api.Message({
    id,
    peerId: new Api.PeerChannel({ channelId: bigInt(CHANNEL_ID) }),
    fromId: new Api.PeerUser({ userId: bigInt(authorId) }),
    message: text,
    date: Math.floor((Date.now() - secondsAgo * 1000) / 1000),
    media: new Api.MessageMediaEmpty(),
  });
}

function makeOpaqueService(id, secondsAgo, authorId = 41) {
  return new Api.MessageService({
    id,
    peerId: new Api.PeerChannel({ channelId: bigInt(CHANNEL_ID) }),
    fromId: new Api.PeerUser({ userId: bigInt(authorId) }),
    date: Math.floor((Date.now() - secondsAgo * 1000) / 1000),
    action: new Api.MessageActionChatAddUser({ users: [bigInt(8)] }),
  });
}

async function sealedNativeSample(t) {
  const native = [
    makeOpaqueService(20, 120),
    makeMessage(19, 'I need a supplier for a small inventory order.', 90),
  ];
  let rpc;
  let historyReads = 0;
  const h = scoutHarness(t, {
    resolve: async () => ({ channel_id: CHANNEL_ID, username: 'sample_channel',
      title: 'Synthetic Sample Channel', kind: 'channel', joined: true, access_hash: ACCESS_HASH }),
    history: async input => {
      return rpc.history({ channel_id: CHANNEL_ID, access_hash: ACCESS_HASH,
        username: 'sample_channel', before_id: input.before_id, until_date: input.until_date,
        limit: input.limit });
    },
  });
  const requests = [];
  Object.assign(h.owner, {
    connected: true, stopped: false, accountId: ACCOUNT, clientGeneration: 1,
    client: { connected: true, invoke: async request => {
      requests.push(request);
      assert.ok(request instanceof Api.messages.GetHistory);
      historyReads += 1;
      return new Api.messages.Messages({ messages: historyReads === 1 ? native : [], chats: [], users: [] });
    } },
  });
  rpc = new TelegramScoutRpc(h.owner);
  const campaign = await h.campaign('Synthetic native Scout demand');
  await h.authorize(campaign);
  const candidate = await h.seed(campaign);
  const sample = await h.auditAndSeal(campaign, candidate);
  assert.equal(sample.status, 'sealed');
  assert.equal(historyReads, 2, 'the real runtime consumes one actual RPC page and its terminating empty page');
  assert.equal(requests.length, 2);
  return sample;
}

function rowWithMessages(sample, messages, recomputeDigest) {
  const row = { ...sample, messages_json: JSON.stringify(messages) };
  if (recomputeDigest) {
    row.digest = digest({ source_ref: row.source_ref, account_id: row.account_id,
      from: row.requested_from, until: row.requested_until, source_cursor: row.source_cursor,
      messages, coverage: row.coverage });
  }
  return row;
}

test('native GramJS history survives Scout sealing with semantic commitment and opaque-message isolation', async t => {
  const sample = await sealedNativeSample(t);
  const raw = JSON.parse(sample.messages_json);
  const normal = raw.find(message => message.message_id === '19');
  const opaque = raw.find(message => message.message_id === '20');
  assert.ok(normal);
  assert.ok(opaque);
  assert.equal(normal.unsupported, null);
  assert.equal(opaque.unsupported, 'service');
  assert.notEqual(normal.content_hash, sha256Text(normal.text), 'Scout hashes the semantic projection, not just text');

  const result = probeScoutDemandCandidates({ mission, sample });
  const candidate = result.candidates.find(message => message.message_id === '19');
  assert.ok(candidate, 'the supported same-author message remains independently retrievable');
  assert.equal(candidate.content_hash, normal.content_hash, 'the native commitment is preserved verbatim');
  assert.equal(candidate.content_hash_kind, 'scout_semantic_commitment');
  assert.equal(candidate.text_hash, sha256Text(normal.text));
  const withheld = result.omitted.find(message => message.message_id === '20');
  assert.ok(withheld);
  assert.equal(withheld.unsupported_reason, 'service');
  assert.equal(withheld.source_content_hash, opaque.content_hash);
  assert.equal(result.sample.digest_checked, true);
});

test('native semantic hash or unsupported reason tampering is caught by the unchanged Scout digest', async t => {
  const sample = await sealedNativeSample(t);
  const messages = JSON.parse(sample.messages_json);
  for (const mutate of [
    rows => { rows.find(message => message.message_id === '19').content_hash = 'a'.repeat(64); },
    rows => { rows.find(message => message.message_id === '19').unsupported = 'fabricated'; },
  ]) {
    const changed = structuredClone(messages);
    mutate(changed);
    assert.throws(() => probeScoutDemandCandidates({ mission, sample: rowWithMessages(sample, changed, false) }),
      /SAMPLE_DIGEST_MISMATCH/);
  }
});

test('raw boolean unsupported is rejected as a non-native Scout message shape', async t => {
  const sample = await sealedNativeSample(t);
  const messages = JSON.parse(sample.messages_json);
  messages.find(message => message.message_id === '19').unsupported = false;
  const internallyConsistent = rowWithMessages(sample, messages, true);
  assert.throws(() => probeScoutDemandCandidates({ mission, sample: internallyConsistent }),
    /SAMPLE_MESSAGE_INVALID|MESSAGE_INVALID|SAMPLE_INVALID/);
});
