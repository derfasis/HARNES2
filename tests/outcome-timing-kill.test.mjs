import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, id } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { readJson, ROOT } from '../business/config.mjs';
import { TelegramChannel } from '../business/channels/telegram.mjs';
import { MtprotoTelegramChannel } from '../business/channels/telegram-mtproto.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

const seconds = at => Math.floor(Date.parse(at) / 1000);

test('outcome timing follows Telegram source dates when an inbound command queues behind send', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-outcome-timing-'));
  const store = new Store(directory);
  t.after(() => {
    try { store.close(); } catch { /* the server/store was already closed */ }
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const config = readJson(path.join(ROOT, 'config/default.json'));
  config.telegram.enabled = true;
  config.telegram.liveSending = true;
  config.telegram.allowedChatIds = ['123', '124', '125', '126'];
  config.outcomes = { enabled: true, modelEnabled: false, responseWindowSeconds: 3600 };
  const service = new BusinessService(store, config);
  service.setTelegramAccount('987');

  const previousToken = process.env.PARTNER_TELEGRAM_BOT_TOKEN;
  process.env.PARTNER_TELEGRAM_BOT_TOKEN = '987:offline-fixture';
  t.after(() => {
    if (previousToken === undefined) delete process.env.PARTNER_TELEGRAM_BOT_TOKEN;
    else process.env.PARTNER_TELEGRAM_BOT_TOKEN = previousToken;
  });

  const channel = new TelegramChannel(service);
  let sendResult;
  let holdSend = true;
  let updates = [];
  let nextMessageId = 1000;
  const sendStarted = deferred();
  const getUpdatesStarted = deferred();
  const inboundCommandQueued = deferred();
  channel.api = async method => {
    if (method === 'getUpdates') {
      getUpdatesStarted.resolve();
      const batch = updates;
      updates = [];
      return batch;
    }
    if (method === 'sendMessage') {
      const result = sendResult;
      sendStarted.resolve();
      if (holdSend) return new Promise(resolve => { channel.releaseSend = () => resolve(result); });
      return result;
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  };

  async function createApprovedDraft(name, chatId) {
    const person = await service.command('person.create', {
      name,
      source: 'offline timing fixture',
      channel: 'telegram',
      external_id: chatId,
      account_id: '987',
      permission: 'fixture reply permission'
    }, id());
    const draft = await service.command('draft.create', {
      conversation_id: person.conversation_id,
      text: 'Thanks, I will follow up.'
    }, id());
    await service.command('draft.approve', { draft_id: draft.draft_id }, id());
    return { conversation_id: person.conversation_id, draft_id: draft.draft_id };
  }

  // The transport receives this inbound event before Telegram acknowledges the outgoing send.
  // Its command waits behind sendApproved's exclusive operation, so its DB row is committed after
  // the outbound row even though Telegram's message date proves it happened first.
  const earlier = await createApprovedDraft('Earlier inbound', '123');
  const sentAt = new Date(Math.floor((Date.now() - 120_000) / 1000) * 1000).toISOString();
  const inboundBeforeSend = new Date(Date.parse(sentAt) - 30_000).toISOString();
  sendResult = { message_id: nextMessageId++, date: seconds(sentAt) };
  const sendPromise = channel.sendApproved(earlier.draft_id);
  await sendStarted.promise;

  updates = [{ update_id: 1, message: {
    chat: { id: 123, type: 'private' }, message_id: 77, date: seconds(inboundBeforeSend), text: 'I sent this before the reply.'
  } }];
  const command = service.command.bind(service);
  service.command = (action, payload, ...rest) => {
    if (action === 'message.record' && payload?.external_id === '77') inboundCommandQueued.resolve();
    return command(action, payload, ...rest);
  };
  const pollPromise = channel.poll();
  await getUpdatesStarted.promise;
  await inboundCommandQueued.promise;
  channel.releaseSend();
  await sendPromise;
  await pollPromise;

  const firstMessages = store.all('SELECT id,direction,occurred_at,time_basis,rowid FROM messages WHERE conversation_id=? ORDER BY rowid', earlier.conversation_id);
  assert.deepEqual(firstMessages.map(message => message.direction), ['out', 'in'], 'the queued inbound row commits after the accepted send');
  assert.equal(firstMessages[0].occurred_at, sentAt, 'outbound provider date is preserved');
  assert.equal(firstMessages[1].occurred_at, inboundBeforeSend, 'inbound provider date is preserved');
  assert.equal(firstMessages[0].time_basis, 'source');
  assert.equal(firstMessages[1].time_basis, 'source');

  service.outcomes.reconcile({ now: Date.parse(sentAt) + 600_000 });
  assert.equal(store.get("SELECT COUNT(*) n FROM outcome_candidates WHERE conversation_id=? AND kind='reply_observed'", earlier.conversation_id).n, 0,
    'a source-timestamped inbound message from before delivery is not attributed as a reply');

  // Positive control: a later provider timestamp still produces the observation, regardless of
  // when the adapter happened to commit it locally.
  holdSend = false;
  const later = await createApprovedDraft('Later inbound', '124');
  const laterSentAt = new Date(Date.now() - 30_000).toISOString();
  const laterReplyAt = new Date(Date.parse(laterSentAt) + 10_000).toISOString();
  sendResult = { message_id: nextMessageId++, date: seconds(laterSentAt) };
  await channel.sendApproved(later.draft_id);
  updates = [{ update_id: 2, message: {
    chat: { id: 124, type: 'private' }, message_id: 78, date: seconds(laterReplyAt), text: 'This arrived after delivery.'
  } }];
  await channel.poll();
  service.outcomes.reconcile({ now: Date.parse(laterReplyAt) + 60_000 });
  assert.equal(store.get("SELECT COUNT(*) n FROM outcome_candidates WHERE conversation_id=? AND kind='reply_observed'", later.conversation_id).n, 1,
    'a provider-timestamped later inbound message remains a positive observation');

  const mtproto = new MtprotoTelegramChannel(service);
  mtproto.connected = true;
  const mtInbound = await createApprovedDraft('MTProto inbound', '125');
  const mtInboundAt = '2026-07-01T08:30:00.000Z';
  await mtproto.handleIncoming({ isPrivate: true, chatId: '125', message: {
    id: 79, isPrivate: true, chatId: '125', message: 'MTProto source timestamp', date: new Date(mtInboundAt)
  } });
  assert.equal(store.get('SELECT occurred_at FROM messages WHERE conversation_id=? AND direction=\'in\'', mtInbound.conversation_id).occurred_at, mtInboundAt,
    'MTProto incoming dates are also carried into stored messages');

  const mtOutbound = await createApprovedDraft('MTProto outbound', '126');
  const mtSentAt = '2026-07-01T08:45:00.000Z';
  mtproto.peerEntities.set('126', {});
  mtproto.client = { sendMessage: async () => ({ id: 2001, date: new Date(mtSentAt) }) };
  await mtproto.sendApproved(mtOutbound.draft_id);
  assert.equal(store.get('SELECT occurred_at FROM messages WHERE conversation_id=? AND direction=\'out\'', mtOutbound.conversation_id).occurred_at, mtSentAt,
    'MTProto delivery dates are carried into stored messages');
});
