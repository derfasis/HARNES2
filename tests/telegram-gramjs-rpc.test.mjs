// The GramJS read-only transport: what it forwards to the source reader, and what it must not.
// proof_level=synthetic_contract_eval; live_proof=false. No model call, no network, no Telegram.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { GramjsSourceRpc } from '../business/sources/telegram-gramjs-rpc.mjs';

const require = createRequire(import.meta.url);
const { Api } = require('telegram');
const { UpdateConnectionState } = require('telegram/network');

// A stand-in for the GramJS client: it records what was registered so the test can drive the
// handler the way the SDK's dispatcher would.
const fakeClient = (connected = true) => {
  const registered = [];
  return {
    connected,
    invoke: async () => ({}),
    addEventHandler: (handler, builder) => registered.push({ handler, builder }),
    removeEventHandler: handler => {
      const at = registered.findIndex(entry => entry.handler === handler);
      if (at >= 0) registered.splice(at, 1);
    },
    registered,
    // Drive one update through the builder and the handler, exactly as the dispatcher does.
    emit: async update => {
      for (const { handler, builder } of registered.slice()) {
        if (await builder.filter(update)) handler(await builder.build(update));
      }
    },
  };
};

test('the SDK keepalive is not forwarded: it is a ping, not a lost connection', async () => {
  // The reader treats an UpdateConnectionState as proof its evidence went stale and invalidates
  // the source. The SDK emits that same class about four times a minute while perfectly connected,
  // so forwarding them blocked the source within seconds and nothing could ever be ingested.
  const client = fakeClient(true);
  const rpc = new GramjsSourceRpc(client, {}, 'telegram:channel:100');
  const seen = [];
  rpc.subscribe(update => seen.push(update));
  for (let ping = 0; ping < 8; ping += 1) await client.emit(new UpdateConnectionState({ state: ping }));
  assert.deepEqual(seen, [], 'eight keepalives on a live connection reach the reader as nothing');
});

test('a real loss of connection is still forwarded', async () => {
  // The fix must not blind the reader to genuine outages: it invalidates the source on a real
  // disconnect and also on any failing read, and this covers the first of those.
  const client = fakeClient(false);
  const rpc = new GramjsSourceRpc(client, {}, 'telegram:channel:100');
  const seen = [];
  rpc.subscribe(update => seen.push(update));
  const dropped = new UpdateConnectionState({ state: 2 });
  await client.emit(dropped);
  assert.deepEqual(seen, [dropped], 'a genuine disconnect reaches the reader');
});

test('message updates are forwarded untouched, in the shape the reader is written against', async () => {
  // The reader unwraps Api.Updates, Api.UpdateShort and the Api.Update* family itself. An SDK
  // event wrapper matches none of those, so every pushed update would be dropped in silence.
  const client = fakeClient(true);
  const rpc = new GramjsSourceRpc(client, {}, 'telegram:channel:100');
  const seen = [];
  rpc.subscribe(update => seen.push(update));
  const update = new Api.UpdateNewChannelMessage({
    pts: 42, pts_count: 1, channel_id: 100n,
    message: new Api.Message({ id: 1, date: 1767225600, message: 'text' }) });
  await client.emit(update);
  await client.emit(new Api.UpdatesCombined({ updates: [update], users: [], chats: [] }));
  assert.equal(seen.length, 2, 'both reach the reader');
  assert.ok(seen[0] instanceof Api.UpdateNewChannelMessage, 'and arrive as the raw update, not a wrapper');
  assert.ok(seen[1] instanceof Api.UpdatesCombined, 'including the batched form');
});

test('a closed reader stops receiving updates and unsubscribes from the shared client', async () => {
  // The reader borrows the channel's connection, so closing it must release only its own
  // subscription and must not touch the client.
  const client = fakeClient(true);
  const rpc = new GramjsSourceRpc(client, {}, 'telegram:channel:100');
  const seen = [];
  rpc.subscribe(update => seen.push(update));
  assert.equal(client.registered.length, 1, 'one subscription is registered');
  await rpc.close();
  assert.equal(client.registered.length, 0, 'and released on close');
  assert.equal(client.connected, true, 'the shared client is untouched');
  const update = new Api.UpdateNewChannelMessage({ pts: 43, pts_count: 1, channel_id: 100n,
    message: new Api.Message({ id: 2, date: 1767225600, message: 'later' }) });
  await client.emit(update);
  assert.deepEqual(seen, [], 'a closed reader is told nothing further');
  assert.equal(rpc.connected(), false);
});

test('a client that is not a client is refused rather than half-wired', () => {
  for (const bad of [null, undefined, {}, { invoke: async () => ({}) },
    { addEventHandler: () => {} }]) {
    assert.throws(() => new GramjsSourceRpc(bad, {}, 'telegram:channel:100'), /GramJS client is required/);
  }
});
