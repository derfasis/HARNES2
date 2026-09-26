import fs from 'node:fs';
import { createRequire } from 'node:module';
import { id } from '../store.mjs';
import { AppError, ensure, now } from '../errors.mjs';
import { TelegramPublicSourceReader } from '../sources/telegram-public-reader.mjs';
import { GramjsSourceRpc } from '../sources/telegram-gramjs-rpc.mjs';

const require = createRequire(import.meta.url);
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');

export class MtprotoTelegramChannel {
  constructor(service) {
    this.service = service;
    this.client = null;
    this.accountId = null;
    this.connected = false;
    this.stopped = false;
    this.polling = false;
    this.lastError = null;
    this.lastEvent = null;
    this.peerEntities = new Map();
    this.sourceReaders = [];
    this.lastSourceError = null;
  }

  sessionString() {
    const inline = process.env.PARTNER_TELEGRAM_SESSION?.trim();
    if (inline) return inline;
    const file = process.env.PARTNER_TELEGRAM_SESSION_FILE?.trim();
    if (!file) return '';
    try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
  }

  credentials() {
    return {
      apiId: Number(process.env.PARTNER_TELEGRAM_API_ID),
      apiHash: process.env.PARTNER_TELEGRAM_API_HASH?.trim() || '',
      session: this.sessionString()
    };
  }

  readiness() {
    const cfg = this.service.config.telegram, credentials = this.credentials();
    return {
      enabled: cfg.enabled,
      transport: 'mtproto',
      configured: Boolean(credentials.apiId && credentials.apiHash && credentials.session),
      connected: this.connected,
      live_sending: cfg.liveSending,
      allowed_chats: cfg.allowedChatIds.length,
      account_id: this.service.telegramAccount(),
      last_event: this.lastEvent,
      error: this.lastError
    };
  }

  start() {
    if (this.stopped || !this.service.config.telegram.enabled) return;
    void this.connect().catch(error => { this.lastError = error.message; });
  }

  async connect() {
    const credentials = this.credentials();
    ensure(credentials.apiId > 0, 'MTProto API ID не настроен', 409);
    ensure(credentials.apiHash, 'MTProto API hash не настроен', 409);
    ensure(credentials.session, 'MTProto session не настроена', 409);
    this.client = new TelegramClient(new StringSession(credentials.session), credentials.apiId, credentials.apiHash, {
      connectionRetries: 5,
      deviceModel: 'HARNES2 Hermes',
      systemVersion: 'Windows'
    });
    await this.client.connect();
    const me = await this.client.getMe();
    this.accountId = String(me.id);
    this.service.setTelegramAccount(this.accountId);
    this.client.addEventHandler(event => this.handleIncoming(event).catch(error => { this.lastError = error.message; }), new NewMessage({ incoming: true }));
    this.connected = true;
    this.lastError = null;
    // Read-only sources borrow this connection rather than opening their own: a second
    // TelegramClient would be a second session, and the channel stays the connection's owner.
    await this.startSourceReaders().catch(error => { this.lastSourceError = error.message; });
  }

  // Lifecycle is fixed: connected, account verified, peer resolved, reader constructed, baselined,
  // then handed to the scheduler. A source that cannot be started never blocks the connection.
  async startSourceReaders() {
    const policies = this.service.config.opportunity?.telegramSources ?? [];
    this.sourceReaders = [];
    for (const policy of policies) {
      if (policy.accountId !== this.accountId) {
        this.lastSourceError = `source ${policy.sourceId} belongs to another account`;
        continue;
      }
      const rpc = new GramjsSourceRpc(this.client, this.service, policy.sourceId);
      const peer = await rpc.resolveInputChannel(policy.channelId);
      const reader = new TelegramPublicSourceReader(this.service, policy.sourceId, rpc, peer, null, { joinedPeer: true });
      await reader.bootstrap();
      this.sourceReaders.push({ sourceId: policy.sourceId, transport: reader });
    }
    if (typeof this.onSourcesReady === 'function') this.onSourcesReady(this.sourceReaders);
  }

  // Releasing a reader must not disconnect the shared client; the channel owns the connection.
  async stopSourceReaders() {
    for (const entry of this.sourceReaders ?? []) await entry.transport.close().catch(() => {});
    this.sourceReaders = [];
  }

  async handleIncoming(event) {
    if (this.stopped || !this.connected || this.polling) return;
    const message = event.message;
    if (!message || message.out || !(event.isPrivate || message.isPrivate)) return;
    const chatId = String(event.chatId ?? message.chatId ?? message.senderId ?? '');
    const cfg = this.service.config.telegram;
    if (!cfg.allowedChatIds.map(String).includes(chatId)) return;
    const text = String(message.message ?? message.text ?? '').trim();
    if (!text) return;

    this.polling = true;
    try {
      try {
        const peer = typeof message.getInputChat === 'function' ? await message.getInputChat() : null;
        if (peer) this.peerEntities.set(chatId, peer);
      } catch { /* The numeric ID remains available for the fallback lookup on send. */ }
      const sender = typeof message.getSender === 'function' ? await message.getSender() : null;
      const name = [sender?.firstName, sender?.lastName].filter(Boolean).join(' ') || chatId;
      const account = this.service.telegramAccount();
      let identity = this.service.store.get('SELECT * FROM channel_identities WHERE channel=? AND account_id=? AND external_id=?', 'telegram', account, chatId);
      if (!identity) {
        await this.service.command('person.create', {
          name,
          source: `Входящее MTProto-сообщение Telegram, chat ${chatId}`,
          channel: 'telegram',
          external_id: chatId,
          account_id: account,
          permission: `Ответ только на входящее сообщение Telegram ${message.id}; произвольная рассылка не разрешена`
        }, `telegram-mtproto-person:${account}:${chatId}`, { kind: 'channel' });
        identity = this.service.store.get('SELECT * FROM channel_identities WHERE channel=? AND account_id=? AND external_id=?', 'telegram', account, chatId);
      }
      const conversation = this.service.store.get('SELECT id FROM conversations WHERE channel_identity_id=?', identity.id);
      await this.service.command('message.record', {
        conversation_id: conversation.id,
        text,
        direction: 'in',
        external_id: String(message.id),
        source: `telegram:mtproto:${account}:${chatId}:${message.id}`
      }, `telegram-mtproto-update:${account}:${chatId}:${message.id}`, { kind: 'channel' });
      this.lastEvent = now();
      this.lastError = null;
    } finally { this.polling = false; }
  }

  async resolvePeer(chatId) {
    const cached = this.peerEntities.get(String(chatId));
    if (cached) return cached;
    const numericId = Number(chatId);
    ensure(Number.isSafeInteger(numericId), 'MTProto Telegram: некорректный ID собеседника', 409);
    try {
      const peer = await this.client.getInputEntity(numericId);
      this.peerEntities.set(String(chatId), peer);
      return peer;
    } catch (error) {
      throw new AppError(`MTProto Telegram: не удалось найти собеседника (${error.message})`, 502, 'telegram_unknown');
    }
  }

  async sendApproved(draftId, { autopilot = false } = {}) {
    return this.service.exclusive(async () => {
      const cfg = this.service.config.telegram;
      ensure(cfg.enabled && cfg.liveSending, 'Живая отправка Telegram выключена в конфигурации', 409);
      ensure(this.connected && this.client, 'MTProto Telegram не подключён', 409);
      const draft = this.service.validApproved(draftId), conversation = this.service.conversation(draft.conversation_id);
      const identity = this.service.store.get('SELECT * FROM channel_identities WHERE id=?', conversation.channel_identity_id);
      ensure(identity?.channel === 'telegram' && identity.account_id === this.service.telegramAccount(), 'Для этого разговора не настроен текущий MTProto-аккаунт', 409);
      ensure(cfg.allowedChatIds.map(String).includes(identity.external_id), 'Chat ID отсутствует в разрешённом списке', 409);
      const attempt = id();
      this.service.store.transaction(() => {
        this.service.store.run("UPDATE drafts SET status='sending' WHERE id=? AND status='approved'", draft.id);
        this.service.store.run('INSERT INTO delivery_attempts(id,draft_id,draft_version,channel,recipient,status,created_at) VALUES(?,?,?,?,?,?,?)', attempt, draft.id, draft.current_version, 'telegram', identity.external_id, 'sending', now());
      });
      let message;
      try {
        const peer = await this.resolvePeer(identity.external_id);
        message = await this.client.sendMessage(peer, { message: draft.text });
      }
      catch (error) {
        const wrapped = error instanceof AppError ? error : new AppError(`MTProto Telegram: ${error.message}`, 502, 'telegram_unknown');
        const status = wrapped.code === 'telegram_rejected' ? 'failed' : 'delivery_unknown';
        this.service.store.transaction(() => {
          this.service.store.run('UPDATE drafts SET status=? WHERE id=?', status, draft.id);
          this.service.store.run('UPDATE delivery_attempts SET status=?,error=?,finished_at=? WHERE id=?', status, wrapped.message, now(), attempt);
          this.service.store.event(this.service.config.partnerId, conversation.id, `delivery.${status}`, 'system', { draft_id: draft.id, attempt_id: attempt, autopilot, run_id: draft.run_id, model: this.service.config.runtime.model, conversation_revision: draft.context_revision });
        });
        return { status, error: wrapped.message };
      }
      try {
        this.service.store.transaction(() => {
          this.service.store.run("UPDATE delivery_attempts SET status='sent',external_id=?,finished_at=? WHERE id=?", String(message.id), now(), attempt);
          this.service.recordDelivered(draft, String(message.id), autopilot ? 'telegram_autopilot' : 'telegram');
          this.service.store.event(this.service.config.partnerId, conversation.id, 'delivery.sent', 'system', { draft_id: draft.id, draft_version: draft.current_version, external_id: String(message.id), autopilot, run_id: draft.run_id, model: this.service.config.runtime.model, conversation_revision: draft.context_revision, model_text: draft.text, sent_text: draft.text });
        });
      } catch {
        this.service.store.run("UPDATE drafts SET status='delivery_unknown' WHERE id=?", draft.id);
        this.service.store.run("UPDATE delivery_attempts SET status='delivery_unknown',error='Provider accepted; local commit failed' WHERE id=?", attempt);
        return { status: 'delivery_unknown' };
      }
      return { status: 'sent', external_id: String(message.id) };
    });
  }

  stop() {
    this.stopped = true;
    this.connected = false;
    if (this.client) void this.client.disconnect().catch(() => {});
  }
}
