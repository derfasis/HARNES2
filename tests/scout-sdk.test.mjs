// Offline contract tests for the GramJS scout adapter and dynamic source admission.
// All Telegram responses below are constructed SDK objects; the fake owner has no socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { TelegramScoutRpc } from '../business/sources/telegram-scout-rpc.mjs';
import { Api } from '../business/sources/telegram-gramjs-semantic.mjs';
import { reconcileTelegramReaders } from '../business/sources/telegram-source-registry.mjs';
import { pollTelegramSource } from '../business/sources/telegram-readonly.mjs';
import { digest, sourceCheckpoint } from '../business/source-ingestion.mjs';
import { ScoutRuntime } from '../business/scout-runtime.mjs';
import { ACCOUNT, channel, message, noHistory, scoutHarness } from './scout-test-helpers.mjs';

const require = createRequire(import.meta.url);
const bigInt = require('big-integer');
const CHANNEL_ID = '123456789';
const ACCESS_HASH = '998877665544';

function sdkChannel(extra = {}) {
  return new Api.Channel({ id: bigInt(CHANNEL_ID), accessHash: bigInt(ACCESS_HASH), title: 'SDK Scout Group',
    username: 'sample_channel', date: 1767225600, megagroup: true, left: false, ...extra });
}

function bareOwner(invoke, extra = {}) {
  const client = { connected: true, invoke, get addEventHandler() { return undefined; } };
  return { client, accountId: ACCOUNT, connected: true, stopped: false, clientGeneration: 1, ...extra };
}

test('TelegramScoutRpc search consumes chats only and history keeps raw empty IDs and permalink', async () => {
  const requests = [];
  const channel = sdkChannel();
  const user = new Api.User({ id: bigInt(7), firstName: 'Ignored user' });
  const min = sdkChannel({ id: bigInt(123456790), min: true, username: 'minimum_peer' });
  const restricted = sdkChannel({ id: bigInt(123456791), restricted: true, username: 'restricted_peer' });
  const empty = new Api.MessageEmpty({ id: 12, peerId: new Api.PeerChannel({ channelId: bigInt(CHANNEL_ID) }) });
  const visible = new Api.Message({ id: 10, peerId: new Api.PeerChannel({ channelId: bigInt(CHANNEL_ID) }),
    fromId: new Api.PeerUser({ userId: bigInt(41) }), message: 'Visible normalized message', date: 1767225600,
    media: new Api.MessageMediaEmpty(), entities: [new Api.MessageEntityBold({ offset: 0, length: 7 })] });
  Object.assign(visible, { futureDisplayField: { ignored: true }, contact_permission: true });
  const service = new Api.MessageService({ id: 11, peerId: new Api.PeerChannel({ channelId: bigInt(CHANNEL_ID) }),
    fromId: new Api.PeerUser({ userId: bigInt(42) }), date: 1767225600,
    action: new Api.MessageActionChatAddUser({ users: [bigInt(8)] }) });
  const owner = bareOwner(async request => {
    requests.push(request);
    if (request instanceof Api.contacts.Search)
      return new Api.contacts.Found({ myResults: [], results: [], chats: [channel, min, restricted], users: [user] });
    if (request instanceof Api.messages.GetHistory)
      return new Api.messages.Messages({ messages: [empty, service, visible], chats: [], users: [] });
    throw new Error('Unexpected SDK request');
  });
  const rpc = new TelegramScoutRpc(owner);
  const found = await rpc.search({ query: 'bounded topic', limit: 4 });
  assert.deepEqual(found, { inexact: true, candidates: [{ channel_id: CHANNEL_ID, username: 'sample_channel',
    title: 'SDK Scout Group', kind: 'group', joined: true, access_hash: ACCESS_HASH }] });
  const page = await rpc.history({ channel_id: CHANNEL_ID, access_hash: ACCESS_HASH, username: 'sample_channel', limit: 4 });
  assert.equal(page.messages.length, 2);
  assert.deepEqual(page.messages.map(m => [m.message_id, m.text, m.unsupported]), [
    ['11', null, 'service'], ['10', 'Visible normalized message', null],
  ]);
  assert.equal(page.messages[0].link, 'https://t.me/sample_channel/11');
  assert.equal(page.messages[1].link, 'https://t.me/sample_channel/10');
  assert.deepEqual({ oldest_id: page.oldest_id, empty: page.empty, requested_count: page.requested_count,
    received_count: page.received_count }, { oldest_id: 10, empty: false, requested_count: 4, received_count: 3 });
  assert.equal(requests.length, 2);
  assert.ok(requests[0] instanceof Api.contacts.Search);
  assert.ok(requests[1] instanceof Api.messages.GetHistory);
  assert.equal(JSON.stringify(found).includes('raw_access_hash'), false);
});

test('username resolution rejects an alias that no longer names the requested channel', async () => {
  const other = sdkChannel({ id: bigInt(123456790), username: 'sample_channel' });
  const owner = bareOwner(async request => {
    assert.ok(request instanceof Api.contacts.ResolveUsername);
    return new Api.contacts.ResolvedPeer({ peer: new Api.PeerChannel({ channelId: bigInt(123456790) }),
      chats: [other], users: [] });
  });
  const rpc = new TelegramScoutRpc(owner);
  await assert.rejects(rpc.resolve({ channel_id: CHANNEL_ID, username: 'sample_channel' }),
    { code: 'SCOUT_MAPPING_INVALID' });
});

test('in-flight adapter result is discarded after owner client generation changes', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const owner = bareOwner(async request => {
    calls++;
    assert.ok(request instanceof Api.contacts.Search);
    await waiting;
    return { chats: [sdkChannel()], users: [] };
  });
  const rpc = new TelegramScoutRpc(owner);
  const pending = rpc.search({ query: 'bounded topic' });
  await Promise.resolve();
  const replacement = { connected: true, invoke: async () => ({ chats: [], users: [] }) };
  owner.client = replacement;
  owner.accountId = '991234567891';
  owner.clientGeneration++;
  release();
  await assert.rejects(pending, { code: 'SCOUT_DISCONNECTED' });
  assert.equal(calls, 1);
});

test('Telegram FloodWait is persisted in the shared account read gate without sleeping', async t => {
  const h = scoutHarness(t);
  let calls = 0;
  const owner = Object.assign(h.owner, { service: h.service, accountId: ACCOUNT, clientGeneration: 1,
    client: { connected: true, invoke: async request => {
      calls++;
      assert.ok(request instanceof Api.contacts.Search);
      throw Object.assign(new Error('FLOOD_WAIT_90'), { seconds: 90 });
    } } });
  const rpc = new TelegramScoutRpc(owner);
  await assert.rejects(rpc.search({ query: 'bounded topic' }), { code: 'SCOUT_FLOOD_WAIT' });
  const key = `${h.config.partnerId}:${ACCOUNT}`;
  const row = h.store.get('SELECT cursor FROM channel_offsets WHERE channel=? AND account_id=?', 'telegram-account-read-v1', key);
  assert.ok(row);
  assert.ok(Date.parse(JSON.parse(row.cursor).retry_at) >= Date.now() + 89_000);
  assert.equal(calls, 1);
});

test('a raw MessageEmpty page advances the history cursor before an explicit empty page seals it', async t => {
  const h = scoutHarness(t, { history: noHistory });
  const campaign = await h.campaign('Raw empty page cursor');
  await h.authorize(campaign);
  const candidate = await h.seed(campaign);
  const job = h.store.get("SELECT * FROM scout_jobs WHERE campaign_id=? AND kind='history' AND status='queued'", campaign.id);
  assert.ok(job);
  let historyCalls = 0;
  const owner = Object.assign(h.owner, { service: h.service, accountId: ACCOUNT, clientGeneration: 1,
    client: { connected: true, invoke: async request => {
      if (request instanceof Api.contacts.ResolveUsername)
        return new Api.contacts.ResolvedPeer({ peer: new Api.PeerChannel({ channelId: bigInt(CHANNEL_ID) }),
          chats: [sdkChannel()], users: [] });
      if (request instanceof Api.messages.GetHistory) {
        historyCalls++;
        const messages = historyCalls === 1
          ? [new Api.MessageEmpty({ id: 9, peerId: new Api.PeerChannel({ channelId: bigInt(CHANNEL_ID) }) })] : [];
        return new Api.messages.Messages({ messages, chats: [], users: [] });
      }
      throw new Error('Unexpected SDK request');
    } } });
  const runtime = new ScoutRuntime(h.service, owner);
  const first = await runtime.tick();
  assert.equal(first.disposition, 'sample_page');
  const cursor = JSON.parse(h.store.get('SELECT cursor_json FROM scout_jobs WHERE id=?', job.id).cursor_json);
  assert.equal(cursor.before_id, 9);
  assert.equal(historyCalls, 1);
  h.store.run('UPDATE scout_jobs SET next_at=? WHERE id=?', new Date(Date.now() - 1000).toISOString(), job.id);
  const second = await runtime.tick();
  assert.equal(second.disposition, 'sample_sealed');
  const sample = h.store.get('SELECT * FROM scout_samples WHERE id=?', job.sample_id);
  assert.equal(sample.status, 'sealed');
  assert.equal(sample.coverage, 'no_visible_messages');
  assert.deepEqual(JSON.parse(sample.messages_json), []);
  assert.equal(historyCalls, 2);
  assert.equal(h.store.get('SELECT sample_id FROM scout_candidates WHERE id=?', candidate.id).sample_id, sample.id);
});

function monitorGrant(campaign, candidate, sample) {
  return { campaign_id: campaign.id, revision: campaign.revision, candidate_id: candidate.id, sample_id: sample.id,
    assessment_id: null, expires_at: new Date(Date.now() + 86400000).toISOString(),
    purpose: 'Synthetic explicit monitor grant', max_lag_seconds: 300 };
}

async function admittedHarness(t) {
  const h = scoutHarness(t, { history: async input => input.before_id
    ? noHistory(input)
    : { empty: false, requested_count: input.limit, received_count: 1, oldest_id: 1, messages: [message('1')] } });
  const campaign = await h.campaign('Synthetic restart admission');
  await h.authorize(campaign);
  const candidate = await h.seed(campaign);
  const sample = await h.auditAndSeal(campaign, candidate);
  const admitted = await h.command('scout.admit', monitorGrant(campaign, candidate, sample));
  return { h, campaign, candidate, admitted };
}

function liveOwner(h, invoke) {
  const handlers = new Set();
  const client = { connected: true, invoke,
    addEventHandler(handler) { handlers.add(handler); }, removeEventHandler(handler) { handlers.delete(handler); } };
  return Object.assign(h.owner, { service: h.service, client, accountId: ACCOUNT, clientGeneration: 1,
    sourceReaders: [], handlers, onSourcesReady() {} });
}

function fullChannelReply(pts = 20) {
  return { fullChat: new Api.ChannelFull({ id: bigInt(CHANNEL_ID), pts }), chats: [sdkChannel()], users: [] };
}

test('dynamic admission resolves its public alias, bootstraps native pts, and polls to current without sends', async t => {
  const { h, candidate } = await admittedHarness(t);
  const requests = [];
  const owner = liveOwner(h, async request => {
    requests.push(request);
    if (request instanceof Api.contacts.ResolveUsername)
      return new Api.contacts.ResolvedPeer({ peer: new Api.PeerChannel({ channelId: bigInt(CHANNEL_ID) }),
        chats: [sdkChannel()], users: [] });
    if (request instanceof Api.channels.GetFullChannel) return fullChannelReply();
    if (request instanceof Api.updates.GetChannelDifference)
      return new Api.updates.ChannelDifferenceEmpty({ pts: 20, final: true });
    throw new Error('Unexpected SDK request');
  });
  t.after(async () => { for (const entry of owner.sourceReaders) await entry.transport.close().catch(() => {}); });
  await reconcileTelegramReaders(owner);
  assert.equal(owner.sourceReaders.length, 1);
  assert.equal(sourceCheckpoint(h.service, `telegram:channel:${candidate.channel_id}`).pts, 20);
  const reader = owner.sourceReaders[0].transport;
  const result = await pollTelegramSource(h.service, `telegram:channel:${candidate.channel_id}`, reader);
  assert.equal(result.pts, 20);
  assert.equal(sourceCheckpoint(h.service, `telegram:channel:${candidate.channel_id}`).phase, 'current');
  assert.ok(requests.some(request => request instanceof Api.contacts.ResolveUsername));
  assert.ok(requests.some(request => request instanceof Api.channels.GetFullChannel));
  assert.ok(requests.some(request => request instanceof Api.updates.GetChannelDifference));
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='source.message'").n, 0);
  for (const method of ['sendMessage', 'joinChannel', 'getDialogs']) assert.equal(owner.client[method], undefined);
});

test('revocation and successor admission after native validation block the queued durable apply', async t => {
  const { h, campaign, candidate, admitted } = await admittedHarness(t);
  const owner = liveOwner(h, async request => {
    if (request instanceof Api.contacts.ResolveUsername)
      return new Api.contacts.ResolvedPeer({ peer: new Api.PeerChannel({ channelId: bigInt(CHANNEL_ID) }),
        chats: [sdkChannel()], users: [] });
    if (request instanceof Api.channels.GetFullChannel) return fullChannelReply();
    if (request instanceof Api.updates.GetChannelDifference)
      return new Api.updates.ChannelDifference({ pts: 21, final: true,
        newMessages: [new Api.Message({ id: 21, peerId: new Api.PeerChannel({ channelId: bigInt(CHANNEL_ID) }),
          fromId: new Api.PeerUser({ userId: bigInt(41) }), message: 'Validated before revocation', date: 1767225600 })],
        otherUpdates: [], chats: [], users: [] });
    throw new Error('Unexpected SDK request');
  });
  t.after(async () => { for (const entry of owner.sourceReaders) await entry.transport.close().catch(() => {}); });
  await reconcileTelegramReaders(owner);
  assert.equal(owner.sourceReaders.length, 1);
  const sourceId = `telegram:channel:${candidate.channel_id}`;
  const reader = owner.sourceReaders[0].transport;
  const validatedRead = reader.readDifference.bind(reader);
  let revokeCompleted = false;
  reader.readDifference = async input => {
    const page = await validatedRead(input);
    await h.command('scout.revoke', { campaign_id: campaign.id, revision: campaign.revision,
      grant_id: admitted.grant_id });
    const frozen = sourceCheckpoint(h.service, sourceId);
    assert.equal(frozen.pts, 20);
    const sampleId = h.store.get('SELECT sample_id FROM scout_grants WHERE id=?', admitted.grant_id).sample_id;
    const successor = await h.command('scout.admit', { campaign_id: campaign.id, revision: campaign.revision,
      candidate_id: candidate.id, sample_id: sampleId, assessment_id: null,
      expires_at: new Date(Date.now() + 86400000).toISOString(), purpose: 'Synthetic successor monitor grant',
      max_lag_seconds: 300, catchup_from_pts: frozen.pts,
      expected_checkpoint_fingerprint: digest(frozen), accept_historical_gap: true });
    assert.ok(successor.grant_id);
    assert.equal(reader.ownsSource(), false);
    revokeCompleted = true;
    return page;
  };

  await assert.rejects(pollTelegramSource(h.service, sourceId, reader), { code: 'TELEGRAM_READER_RETIRED' });
  assert.equal(revokeCompleted, true);
  assert.equal(sourceCheckpoint(h.service, sourceId).pts, 20);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='source.message'").n, 0);
  assert.equal(h.store.get(`SELECT COUNT(*) n FROM events WHERE kind IN
    ('source.telegram.proof','source.telegram.reconciliation')`).n, 0);
});

test('revocation during username resolution cannot publish a baseline or reader', async t => {
  const { h, candidate, admitted } = await admittedHarness(t);
  let entered, release;
  const inside = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  let requests = 0;
  const owner = liveOwner(h, async request => {
    requests++;
    assert.ok(request instanceof Api.contacts.ResolveUsername);
    entered();
    await blocked;
    return new Api.contacts.ResolvedPeer({ peer: new Api.PeerChannel({ channelId: bigInt(CHANNEL_ID) }),
      chats: [sdkChannel()], users: [] });
  });
  const reconciling = reconcileTelegramReaders(owner);
  await inside;
  await h.command('scout.revoke', { campaign_id: h.store.get('SELECT campaign_id FROM scout_candidates WHERE id=?', candidate.id).campaign_id,
    revision: 1, grant_id: admitted.grant_id });
  release();
  await reconciling;
  assert.equal(owner.sourceReaders.length, 0);
  assert.equal(sourceCheckpoint(h.service, `telegram:channel:${candidate.channel_id}`), null);
  assert.equal(requests, 1);
});
