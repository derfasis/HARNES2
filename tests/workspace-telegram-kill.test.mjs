// Offline transport-contract tests. No model, network, credentials or real Telegram client.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, readJson } from '../business/config.mjs';
import { Store } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { MtprotoTelegramChannel } from '../business/channels/telegram-mtproto.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-private-intake-'));
  const store = new Store(directory);
  const config = readJson(path.join(ROOT, 'config/default.json'));
  config.telegram.allowedChatIds = ['100', '200'];
  const service = new BusinessService(store, config);
  service.setTelegramAccount('999');
  const channel = new MtprotoTelegramChannel(service);
  channel.accountId = '999';
  channel.connected = true;
  channel.initializePrivateIntake();
  const client = { addEventHandler(handler) { this.handler = handler; }, async disconnect() {} };
  channel.registerIncomingHandler(client);
  t.after(async () => {
    await channel.stop();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const emit = (id, chatId = '100', extra = {}) => client.handler({
    isPrivate: true,
    chatId,
    message: { id, message: `message ${id}`, date: new Date('2026-01-01T00:00:00.000Z'),
      async getSender() { return { firstName: `Person ${chatId}` }; }, ...extra }
  });
  const health = () => JSON.parse(store.get("SELECT cursor FROM channel_offsets WHERE channel='telegram-private-intake-v1' AND account_id='partner-001:999'").cursor);
  return { channel, store, emit, health };
}

test('private MTProto callbacks queue synchronously while an earlier event is delayed', async t => {
  const h = harness(t), gate = deferred(), entered = deferred();
  const first = h.emit(1, '100', { async getSender() { entered.resolve(); await gate.promise; return { firstName: 'A' }; } });
  await entered.promise;
  const second = h.emit(2, '200');
  assert.equal(h.channel.privatePending, 2, 'both callback events were admitted before async processing');
  gate.resolve();
  await h.channel.drain();
  assert.equal(h.store.get("SELECT COUNT(*) n FROM messages WHERE direction='in'").n, 2);
  assert.equal(h.health().last_message_id, '2');
  assert.equal(h.health().coverage, 'unverified');
  assert.equal(h.channel.readiness().private_intake.phase, 'catching_up');
  void first; void second;
});

test('an inbound failure latches a durable gap across later successful messages', async t => {
  const h = harness(t);
  h.emit(1, '100', { async getSender() { throw new Error('raw provider payload must not escape'); } });
  h.emit(2, '200');
  await h.channel.drain();
  const health = h.health();
  assert.equal(health.phase, 'gap');
  assert.equal(health.gap.code, 'INBOUND_PROCESSING_FAILED');
  assert.equal(health.coverage, 'unverified');
  assert.equal(health.last_message_id, '2', 'later success advances observation without clearing the gap');
  assert.equal(JSON.stringify(health).includes('raw provider payload'), false);
  assert.equal(h.channel.readiness().private_intake.phase, 'gap');
  assert.match(h.channel.readiness().error, /Не удалось сохранить/);
});

test('a new channel instance preserves the observed cursor but never claims historical coverage', async t => {
  const h = harness(t);
  h.emit(7, '100');
  await h.channel.drain();
  const restarted = new MtprotoTelegramChannel(h.channel.service);
  restarted.accountId = '999';
  restarted.initializePrivateIntake();
  assert.equal(restarted.readiness().private_intake.phase, 'catching_up');
  assert.equal(restarted.readiness().private_intake.coverage, 'unverified');
  assert.equal(JSON.parse(h.store.get("SELECT cursor FROM channel_offsets WHERE channel='telegram-private-intake-v1' AND account_id='partner-001:999'").cursor).last_message_id, '7');
});

test('stop drains callbacks already admitted and reports unverified coverage', async t => {
  const h = harness(t), gate = deferred(), entered = deferred();
  h.emit(1, '100', { async getSender() { entered.resolve(); await gate.promise; return { firstName: 'A' }; } });
  await entered.promise;
  h.emit(2, '200');
  const stopping = h.channel.stop();
  gate.resolve();
  await stopping;
  const health = await h.channel.drain();
  assert.equal(h.store.get("SELECT COUNT(*) n FROM messages WHERE direction='in'").n, 2);
  assert.equal(health.phase, 'catching_up');
  assert.equal(health.coverage, 'unverified');
});

test('bounded queue overload refuses admission and leaves a durable sticky gap', async t => {
  const h = harness(t), gate = deferred(), entered = deferred();
  h.channel.privateQueueLimit = 1;
  h.emit(1, '100', { async getSender() { entered.resolve(); await gate.promise; return { firstName: 'A' }; } });
  await entered.promise;
  h.emit(2, '200');
  assert.equal(h.channel.privatePending, 1);
  gate.resolve();
  await h.channel.drain();
  assert.equal(h.store.get("SELECT COUNT(*) n FROM messages WHERE direction='in'").n, 1);
  assert.equal(h.health().gap.code, 'QUEUE_OVERFLOW');
  assert.equal(h.channel.readiness().private_intake.phase, 'gap');
});

test('failed intake checkpoint commit cannot advance the claimed durable private cursor', async t => {
  const h = harness(t); h.emit(1); await h.channel.drain();
  const original = h.store.run.bind(h.store); let injected = false;
  h.store.run = (sql, ...args) => {
    if (!injected && sql.includes('INSERT INTO channel_offsets') && args[0] === 'telegram-private-intake-v1' && JSON.parse(args[2]).last_message_id === '2') {
      injected = true; throw new Error('synthetic checkpoint persistence failure');
    }
    return original(sql, ...args);
  };
  h.emit(2); await h.channel.drain();
  assert.equal(injected, true);
  assert.equal(h.health().last_message_id, '1');
  assert.equal(h.channel.privateHealth.last_message_id, '1');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM messages').n, 1);
  assert.equal(h.channel.readiness().private_intake.phase, 'gap');
  assert.equal(h.health().coverage, 'unverified');
});
