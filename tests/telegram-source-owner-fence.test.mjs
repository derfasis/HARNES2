// Captured owner/client/generation kill cases over fake pinned SDK responses.
// Isolated SQLite only; no credentials, sockets, models, membership changes or sends.
import test, { before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Socket } from 'node:net';
import childProcess from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { Store } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { ROOT, readJson } from '../business/config.mjs';
import { sourceCheckpoint, sourceRows, sourceAccessReadiness } from '../business/source-ingestion.mjs';
import { applyTelegramDifference, pollTelegramSource } from '../business/sources/telegram-readonly.mjs';
import { GramjsSourceRpc } from '../business/sources/telegram-gramjs-rpc.mjs';
import { TelegramPublicSourceReader } from '../business/sources/telegram-public-reader.mjs';
import { reconcileTelegramReaders } from '../business/sources/telegram-source-registry.mjs';
import { MtprotoTelegramChannel } from '../business/channels/telegram-mtproto.mjs';
import { message as auditMessage, noHistory, scoutHarness } from './scout-test-helpers.mjs';

const require = createRequire(import.meta.url);
const { Api } = require('telegram');
const { UpdateConnectionState } = require('telegram/network');
const bigInt = require('big-integer');
const ACCOUNT = '991234567890';
const CHANNEL = '123456789';
const SOURCE = `telegram:channel:${CHANNEL}`;
const peer = () => new Api.InputChannel({ channelId: bigInt(CHANNEL), accessHash: bigInt('998877665544') });
const channel = () => new Api.Channel({ id: bigInt(CHANNEL), accessHash: bigInt('998877665544'),
  title: 'Isolated owner fence fixture', username: 'sample_channel', date: 1767225600, megagroup: true, left: false });
const full = () => ({ fullChat: new Api.ChannelFull({ id: bigInt(CHANNEL), pts: 20 }), chats: [channel()], users: [] });
const empty = () => new Api.updates.ChannelDifferenceEmpty({ pts: 20, final: true });
const message = () => new Api.Message({ id: 21, peerId: new Api.PeerChannel({ channelId: bigInt(CHANNEL) }),
  fromId: new Api.PeerUser({ userId: bigInt(41) }), message: 'Synthetic generation-fenced evidence',
  date: Math.floor(Date.now() / 1000), media: new Api.MessageMediaEmpty() });
const difference = () => new Api.updates.ChannelDifference({ pts: 21, final: true,
  newMessages: [message()], otherUpdates: [], chats: [], users: [] });

let ioGuards;
before(() => {
  const denied = () => { throw new Error('External IO forbidden in owner fence fixtures'); };
  ioGuards = [mock.method(globalThis, 'fetch', denied), mock.method(Socket.prototype, 'connect', denied),
    mock.method(childProcess, 'spawn', denied)];
  syncBuiltinESMExports();
});
after(() => {
  for (const guard of ioGuards) assert.equal(guard.mock.callCount(), 0);
  mock.restoreAll();
  syncBuiltinESMExports();
});

function fakeClient() {
  const handlers = new Set();
  return { connected: true, requests: [], handlers,
    async invoke(request) {
      this.requests.push(request);
      if (request instanceof Api.channels.GetFullChannel) return full();
      if (request instanceof Api.updates.GetChannelDifference) return empty();
      throw new Error('Unexpected fake SDK read');
    },
    async getEntity() { return channel(); },
    addEventHandler(handler) { handlers.add(handler); },
    removeEventHandler(handler) { handlers.delete(handler); },
    async emit(update) { await Promise.all([...handlers].map(handler => handler(update))); },
  };
}

function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-source-owner-fence-'));
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  const store = new Store(directory);
  const config = structuredClone(readJson(path.join(ROOT, 'config/default.json')));
  config.runtime.enabled = false;
  config.scheduler.enabled = false;
  config.telegram.enabled = false;
  config.telegram.transport = 'mtproto';
  config.telegram.liveSending = false;
  config.controlPlane.enabled = true;
  config.scout.enabled = false;
  config.scout.modelEnabled = false;
  Object.assign(config.opportunity, { automatic: true, allowedSourceRefs: [SOURCE], telegramSources: [{
    sourceId: SOURCE, accountId: ACCOUNT, channelId: CHANNEL, sourceKind: 'live_snapshot',
    processingBasis: 'Explicit synthetic read-only owner fence fixture', maxLagSeconds: 300,
  }] });
  const service = new BusinessService(store, config);
  service.control.acquireProcess();
  service.setTelegramAccount(ACCOUNT);
  const owner = new MtprotoTelegramChannel(service);
  owner.client = fakeClient();
  owner.accountId = ACCOUNT;
  owner.clientGeneration = 1;
  owner.connected = true;
  const rpc = new GramjsSourceRpc(owner.client, service, SOURCE, { owner });
  const reader = new TelegramPublicSourceReader(service, SOURCE, rpc, peer(), null, { joinedPeer: true });
  t.after(async () => {
    for (const entry of owner.sourceReaders) await entry.transport.close().catch(() => {});
    await reader.close().catch(() => {});
    await service.tail;
    for (const table of ['persons', 'conversations', 'drafts', 'delivery_attempts'])
      assert.equal(store.get(`SELECT COUNT(*) n FROM ${table}`).n, 0, `${table} remains empty`);
    service.control.close();
    service.control.releaseProcess();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { store, service, owner, rpc, reader,
    state: () => sourceCheckpoint(service, SOURCE),
    poll: () => pollTelegramSource(service, SOURCE, reader),
    replace() { const prior = owner.client; owner.client = fakeClient(); owner.clientGeneration++; return prior; },
  };
}

test('same-account client replacement fences old raw updates, reads and checkpoint ownership', async t => {
  const h = harness(t);
  await h.reader.bootstrap();
  await h.poll();
  assert.equal(sourceAccessReadiness(h.service, SOURCE).current, true);
  const current = h.state();
  const oldClient = h.replace();
  const requestCount = oldClient.requests.length;
  assert.equal(oldClient.connected, true, 'replacement does not rely on old socket shutdown');
  assert.equal(h.rpc.ownsResource(), false);
  assert.equal(h.rpc.connected(), false);
  assert.equal(h.reader.ownsSource(), false);
  assert.equal(h.reader.confirmCurrent(), false);
  assert.equal(sourceAccessReadiness(h.service, SOURCE).current, false);
  await oldClient.emit(new Api.UpdateNewChannelMessage({ pts: 21, ptsCount: 1, message: message() }));
  await h.reader.receive(new UpdateConnectionState({ state: 2 }));
  assert.equal(h.reader.status().buffered, 0);
  assert.deepEqual(h.state(), current, 'retired events cannot mutate the existing checkpoint');
  await assert.rejects(h.rpc.invokeRead(new Api.channels.GetFullChannel({ channel: peer() })), /Source reader retired/);
  assert.equal(oldClient.requests.length, requestCount, 'retired reads never reach the old SDK client');
});

test('generation-only retirement fences a reused client object', async t => {
  const h = harness(t);
  await h.reader.bootstrap();
  await h.poll();
  h.owner.clientGeneration++;
  assert.equal(h.owner.client.connected, true);
  assert.equal(h.rpc.ownsResource(), false);
  assert.equal(h.reader.ownsSource(), false);
  assert.equal(h.reader.confirmCurrent(), false);
  await assert.rejects(h.poll(), { code: 'TELEGRAM_READER_RETIRED' });
  assert.equal(h.state().pts, 20);
});

test('replacement while an SDK read waits discards its result before durable ingestion', async t => {
  const h = harness(t);
  await h.reader.bootstrap();
  let entered, release;
  const inside = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  h.owner.client.invoke = async request => {
    assert.ok(request instanceof Api.updates.GetChannelDifference);
    entered();
    await held;
    return difference();
  };
  const polling = h.poll();
  await inside;
  h.replace();
  release();
  await assert.rejects(polling, { code: 'PUBLIC_TELEGRAM_READ_FAILED' });
  assert.equal(h.state().pts, 20);
  assert.equal(sourceRows(h.service, SOURCE).length, 0);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='source.telegram.proof'").n, 0);
});

test('replacement after native validation fences the queued transactional commit', async t => {
  const h = harness(t);
  await h.reader.bootstrap();
  h.owner.client.invoke = async () => difference();
  const page = await h.reader.readDifference({ accountId: ACCOUNT, channelId: CHANNEL, pts: 20, limit: 100 });
  assert.equal(h.reader.confirmCurrent(page.to_pts), true);
  h.replace();
  await assert.rejects(applyTelegramDifference(h.service, SOURCE, page, 20,
    () => h.reader.confirmCurrent(page.to_pts), () => h.reader.ownsSource()), { code: 'TELEGRAM_READER_RETIRED' });
  assert.equal(h.state().pts, 20);
  assert.equal(sourceRows(h.service, SOURCE).length, 0);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind IN ('source.telegram.proof','source.telegram.reconciliation')").n, 0);
});

test('same-client disconnect invalidates the epoch before reconnect can claim freshness', async t => {
  const h = harness(t);
  await h.reader.bootstrap();
  await h.poll();
  const client = h.owner.client;
  client.connected = false;
  h.owner.connected = false;
  assert.equal(h.rpc.ownsResource(), true, 'stable identity still owns disconnect invalidation');
  await client.emit(new UpdateConnectionState({ state: 2 }));
  assert.equal(h.state().phase, 'catching_up');
  assert.equal(h.state().confirmed_at, null);
  client.connected = true;
  h.owner.connected = true;
  assert.equal(h.rpc.connected(), true);
  assert.equal(h.reader.confirmCurrent(), false, 'reconnect cannot reuse an earlier confirmed epoch');
  assert.equal(sourceAccessReadiness(h.service, SOURCE).current, false);
  await h.poll();
  assert.equal(h.reader.confirmCurrent(), true);
  assert.equal(sourceAccessReadiness(h.service, SOURCE).current, true);
});

test('delayed SDK disconnect dispatch still invalidates after the same client reconnects', async t => {
  const h = harness(t);
  await h.reader.bootstrap();
  await h.poll();
  const client = h.owner.client;
  await client.emit(new UpdateConnectionState(UpdateConnectionState.connected));
  assert.equal(h.reader.confirmCurrent(), true, 'connected keepalive preserves valid evidence');
  await client.emit(new UpdateConnectionState(UpdateConnectionState.disconnected));
  assert.equal(client.connected, true, 'SDK dispatcher may deliver an old disconnect after reconnect');
  assert.equal(h.reader.confirmCurrent(), false);
  assert.equal(h.state().phase, 'catching_up');
  await h.poll();
  assert.equal(h.reader.confirmCurrent(), true);
  await client.emit(new UpdateConnectionState(UpdateConnectionState.broken));
  assert.equal(h.reader.confirmCurrent(), false);
  assert.equal(h.state().confirmed_at, null);
});

test('registry replaces a retired same-policy reader instead of retaining its old generation', async t => {
  const h = harness(t);
  await h.reader.close();
  await reconcileTelegramReaders(h.owner);
  const prior = h.owner.sourceReaders[0].transport;
  await pollTelegramSource(h.service, SOURCE, prior);
  h.replace();
  assert.equal(prior.ownsSource(), false);
  await reconcileTelegramReaders(h.owner);
  assert.equal(h.owner.sourceReaders.length, 1);
  const replacement = h.owner.sourceReaders[0].transport;
  assert.notEqual(replacement, prior);
  assert.equal(prior.status().closed, true);
  await pollTelegramSource(h.service, SOURCE, replacement);
  assert.equal(sourceAccessReadiness(h.service, SOURCE).current, true);
});

test('static reader construction captures its Mtproto owner generation too', async t => {
  const h = harness(t);
  await h.reader.close();
  await h.owner.startSourceReaders();
  assert.equal(h.owner.sourceReaders.length, 1);
  const reader = h.owner.sourceReaders[0].transport;
  await pollTelegramSource(h.service, SOURCE, reader);
  assert.equal(reader.confirmCurrent(), true);
  h.replace();
  assert.equal(reader.ownsSource(), false);
  assert.equal(reader.confirmCurrent(), false);
  await assert.rejects(pollTelegramSource(h.service, SOURCE, reader), { code: 'TELEGRAM_READER_RETIRED' });
});

test('disabled dynamic Scout execution loses confirmation until a fresh native difference after reenable', async t => {
  const h = scoutHarness(t, { history: input => input.before_id ? noHistory(input) : {
    empty: false, requested_count: input.limit, received_count: 1, oldest_id: 1, messages: [auditMessage('1')],
  } });
  const campaign = await h.campaign('Dynamic execution enablement fixture');
  await h.authorize(campaign);
  const candidate = await h.seed(campaign);
  const sample = await h.auditAndSeal(campaign, candidate);
  await h.command('scout.admit', { campaign_id: campaign.id, revision: campaign.revision,
    candidate_id: candidate.id, sample_id: sample.id, assessment_id: null,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    purpose: 'Synthetic dynamic execution-toggle regression', max_lag_seconds: 300 });
  assert.equal(h.config.opportunity.telegramSources.some(policy => policy.sourceId === SOURCE), false,
    'this source obtains authority only from its durable Scout grant');
  const owner = new MtprotoTelegramChannel(h.service);
  owner.client = fakeClient();
  owner.accountId = ACCOUNT;
  owner.clientGeneration = 1;
  owner.connected = true;
  const rpc = new GramjsSourceRpc(owner.client, h.service, SOURCE, { owner });
  const reader = new TelegramPublicSourceReader(h.service, SOURCE, rpc, peer(), null, { joinedPeer: true });
  try {
    await reader.bootstrap();
    await pollTelegramSource(h.service, SOURCE, reader);
    assert.equal(sourceAccessReadiness(h.service, SOURCE).current, true);
    const beforeDisable = sourceCheckpoint(h.service, SOURCE);
    const requests = owner.client.requests.length;
    owner.client.invoke = async request => {
      owner.client.requests.push(request);
      return difference();
    };
    const validatedPage = await reader.readDifference({ accountId: ACCOUNT, channelId: CHANNEL, pts: 20, limit: 100 });
    h.config.scout.enabled = false;
    assert.equal(reader.ownsSource(), false);
    await assert.rejects(rpc.invokeRead(new Api.channels.GetFullChannel({ channel: peer() })),
      error => error.code === 'TELEGRAM_MONITOR_DISABLED');
    await assert.rejects(applyTelegramDifference(h.service, SOURCE, validatedPage, 20,
      () => reader.confirmCurrent(validatedPage.to_pts), () => reader.ownsSource()));
    await assert.rejects(pollTelegramSource(h.service, SOURCE, reader), { code: 'TELEGRAM_READER_RETIRED' });
    assert.equal(owner.client.requests.length, requests + 1, 'only the pre-disable validated SDK read occurred');
    assert.equal(sourceRows(h.service, SOURCE).length, 0, 'disabled execution cannot ingest the validated page');
    assert.deepEqual(sourceCheckpoint(h.service, SOURCE), beforeDisable,
      'volatile loss of execution authority neither writes a cursor nor resets integrity');
    h.config.scout.enabled = true;
    assert.equal(reader.ownsSource(), true, 'the same durable permission can resume execution');
    assert.equal(reader.confirmCurrent(), false, 'the pre-disable confirmation cannot revive on reenable');
    assert.equal(sourceAccessReadiness(h.service, SOURCE).current, false);
    owner.client.invoke = async request => {
      owner.client.requests.push(request);
      return difference();
    };
    await pollTelegramSource(h.service, SOURCE, reader);
    assert.equal(reader.confirmCurrent(), true);
    assert.equal(sourceAccessReadiness(h.service, SOURCE).current, true, 'fresh native difference proves currentness again');
    assert.equal(sourceCheckpoint(h.service, SOURCE).pts, 21);
  } finally {
    await reader.close().catch(() => {});
  }
});
