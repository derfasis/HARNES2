import fs from 'node:fs';
import { createRequire } from 'node:module';
import { id } from '../store.mjs';
import { AppError, ensure, now } from '../errors.mjs';
import { TelegramPublicSourceReader } from '../sources/telegram-public-reader.mjs';
import { GramjsSourceRpc } from '../sources/telegram-gramjs-rpc.mjs';
import { reconcileTelegramReaders } from '../sources/telegram-source-registry.mjs';

const require = createRequire(import.meta.url);
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');

function telegramTimestamp(value) {
  let date = null;
  if (value instanceof Date) date = value;
  else if (Number.isSafeInteger(value) && value > 0) {
    date = new Date(value < 1_000_000_000_000 ? value * 1000 : value);
  }
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// Why a reader did not start, in a form that may be shown and stored. `resolveInputChannel` can
// fail with an SDK error, and those messages carry provider and peer detail, so only a code that
// is already shaped like one of ours is allowed out; everything else is a single class.
export const sourceFailureCode = (error) =>
  (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code))
    ? error.code : 'SOURCE_READER_BOOTSTRAP_FAILED';

export class MtprotoTelegramChannel {
  constructor(service) {
    this.service = service;
    this.client = null;
    this.clientGeneration = 0;
    this.accountId = null;
    this.connected = false;
    this.stopped = false;
    this.polling = false;
    this.lastError = null;
    this.lastEvent = null;
    this.peerEntities = new Map();
    this.sourceReaders = [];
    this.lastSourceError = null;
    this.privateQueue = [];
    this.privateQueueLimit = 256;
    this.privatePending = 0;
    this.privateDrain = null;
    this.privateGap = null;
    this.privateGapWrite = null;
    this.privateHealth = null;
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
      error: this.lastError,
      private_intake: {
        phase: this.privateGap ? 'gap' : this.privateHealth?.phase ?? 'catching_up',
        coverage: 'unverified',
        queued: this.privatePending,
        processing: this.polling,
        gap: this.privateGap ?? this.privateHealth?.gap ?? null,
        last_message_at: this.privateHealth?.last_message_at ?? null
      }
    };
  }

  start() {
    if (this.stopped || !this.service.config.telegram.enabled) return;
    void this.connect().catch(error => { this.lastError = error.message; });
  }

  async connect() {
    this.requireProcessOwner();
    const credentials = this.credentials();
    ensure(credentials.apiId > 0, 'MTProto API ID не настроен', 409);
    ensure(credentials.apiHash, 'MTProto API hash не настроен', 409);
    ensure(credentials.session, 'MTProto session не настроена', 409);
    this.client = new TelegramClient(new StringSession(credentials.session), credentials.apiId, credentials.apiHash, {
      ...(this.service.scout.enabled?{floodSleepThreshold:0,requestRetries:1}:{}),
      connectionRetries: 5,
      deviceModel: 'HARNES2 Hermes',
      systemVersion: 'Windows'
    });
    this.clientGeneration++;
    await this.client.connect();
    const me = await this.client.getMe();
    this.accountId = String(me.id);
    this.service.setTelegramAccount(this.accountId);
    this.initializePrivateIntake();
    this.registerIncomingHandler();
    this.connected = true;
    this.lastError = null;
    // Read-only sources borrow this connection rather than opening their own: a second
    // TelegramClient would be a second session, and the channel stays the connection's owner.
    // The message is kept internal; only a code-shaped class of it is allowed to leave.
    await this.startSourceReaders().catch(error => {
      this.lastSourceError = error.message;
      this.lastSourceCode = sourceFailureCode(error);
    });
  }

  // Lifecycle is fixed: connected, account verified, peer resolved, reader constructed, baselined,
  // then handed to the scheduler. A source that cannot be started never blocks the connection,
  // and never blocks another source either: one dead reader must not cost the live ones.
  async startSourceReaders() {
    if(this.service.scout.enabled)return reconcileTelegramReaders(this);
    const policies = this.service.config.opportunity?.telegramSources ?? [];
    this.sourceReaders = [];
    let firstError = null;
    let failureCode = null;
    try {
      for (const policy of policies) {
        if (policy.accountId !== this.accountId) {
          this.lastSourceError = `source ${policy.sourceId} belongs to another account`;
          failureCode ??= 'SOURCE_ACCOUNT_MISMATCH';
          continue;
        }
        try {
          const rpc = new GramjsSourceRpc(this.client, this.service, policy.sourceId, { owner: this });
          const peer = await rpc.resolveInputChannel(policy.channelId);
          const reader = new TelegramPublicSourceReader(this.service, policy.sourceId, rpc, peer, null, { joinedPeer: true });
          await reader.bootstrap();
          this.sourceReaders.push({ sourceId: policy.sourceId, transport: reader });
        } catch (error) {
          // The first failure is remembered and rethrown below, so the call still fails loudly.
          // What changes is that the sources after this one still get their chance to start.
          firstError ??= error;
          failureCode ??= sourceFailureCode(error);
        }
      }
    } finally {
      // The scheduler is told what actually came up, even when a reader did not. Publishing
      // only on the success path left the scheduler holding the empty list it was built with,
      // which is how a source that nobody is reading came to look like a source with nothing to
      // say. There is no retry here: this is an honest report of the current state, nothing more.
      this.lastSourceCode = failureCode;
      if (typeof this.onSourcesReady === 'function') this.onSourcesReady([...this.sourceReaders]);
    }
    if (firstError) throw firstError;
  }

  // Releasing a reader must not disconnect the shared client; the channel owns the connection.
  async stopSourceReaders() {
    for (const entry of this.sourceReaders ?? []) await entry.transport.close().catch(() => {});
    this.sourceReaders = [];
  }

  privateAccountKey(account = this.accountId) {
    return `${this.service.config.partnerId}:${account}`;
  }

  ownsProcess() {
    const control = this.service.control;
    return !control?.stopped && (!control || control.processCurrent());
  }

  requireProcessOwner() {
    ensure(this.ownsProcess(), 'Control Plane process ownership was lost', 409, 'CONTROL_PROCESS_OWNERSHIP_LOST');
  }

  registerIncomingHandler(client = this.client) {
    client.addEventHandler(event => {
      try { this.enqueueIncoming(event); }
      catch {
        this.lastError = 'Не удалось принять входящее сообщение Telegram';
        void this.latchPrivateGap('INBOUND_ADMISSION_FAILED');
      }
    }, new NewMessage({ incoming: true }));
  }

  privateHealthRow() {
    if (!this.accountId) return null;
    return this.service.store.get('SELECT cursor FROM channel_offsets WHERE channel=? AND account_id=?',
      'telegram-private-intake-v1', this.privateAccountKey());
  }

  // Startup always re-enters an explicitly unverified state. We have no private-message history
  // recovery protocol, so a persisted last message can never prove that the gap since it is closed.
  initializePrivateIntake() {
    if (!this.accountId) return;
    this.service.store.transaction(() => {
      this.requireProcessOwner();
      const row = this.privateHealthRow();
      let previous = {};
      try { previous = row ? JSON.parse(row.cursor) : {}; } catch { /* Corrupt health is not coverage. */ }
      this.privateGap = previous.gap ?? null;
      this.privateHealth = {
        version: 1,
        partner_id: this.service.config.partnerId,
        account_id: this.accountId,
        phase: this.privateGap ? 'gap' : 'catching_up',
        coverage: 'unverified',
        gap: this.privateGap,
        last_message_id: previous.last_message_id ?? null,
        last_message_at: previous.last_message_at ?? null,
        started_at: now()
      };
      this.service.store.run(`INSERT INTO channel_offsets(channel,account_id,cursor) VALUES(?,?,?)
        ON CONFLICT(channel,account_id) DO UPDATE SET cursor=excluded.cursor`,
        'telegram-private-intake-v1', this.privateAccountKey(), JSON.stringify(this.privateHealth));
    });
  }

  enqueueIncoming(event) {
    if (this.stopped || !this.connected || !this.ownsProcess()) return;
    // Fast filters do not await SDK methods and cannot race queue admission.
    const message = event.message;
    if (!message || message.out || !(event.isPrivate || message.isPrivate)) return;
    const chatId = String(event.chatId ?? message.chatId ?? message.senderId ?? '');
    const cfg = this.service.config.telegram;
    if (!cfg.allowedChatIds.map(String).includes(chatId)) return;
    const text = String(message.message ?? message.text ?? '').trim();
    if (!text) return;
    if (this.privatePending >= this.privateQueueLimit) {
      this.lastError = 'Очередь входящих сообщений Telegram переполнена';
      this.latchPrivateGap('QUEUE_OVERFLOW');
      return;
    }
    this.privatePending++;
    this.privateQueue.push(event);
    this.kickPrivateQueue();
  }

  kickPrivateQueue() {
    if (this.privateDrain) return;
    this.privateDrain = this.processPrivateQueue().finally(() => {
      this.privateDrain = null;
      if (this.privateQueue.length && !this.stopped) this.kickPrivateQueue();
    });
  }

  async processPrivateQueue() {
    this.polling = true;
    try {
      while (this.privateQueue.length) {
        const event = this.privateQueue.shift();
        try { await this.handleIncoming(event); }
        catch {
          // Provider exceptions may contain message text or credentials. Persist only a fixed code.
          await this.latchPrivateGap('INBOUND_PROCESSING_FAILED');
          this.lastError = 'Не удалось сохранить входящее сообщение Telegram';
        } finally { this.privatePending--; }
      }
    } finally { this.polling = false; }
  }

  async latchPrivateGap(code) {
    if (!this.ownsProcess()) return;
    const gap = this.privateGap ?? { code, at: now() };
    this.privateGap = gap;
    this.privateHealth = { ...(this.privateHealth ?? {}), version: 1,
      partner_id: this.service.config.partnerId, account_id: this.accountId,
      phase: 'gap', coverage: 'unverified', gap };
    const write = this.service.exclusive(() => this.service.store.transaction(() => {
        this.requireProcessOwner();
        this.service.store.run(`INSERT INTO channel_offsets(channel,account_id,cursor) VALUES(?,?,?)
          ON CONFLICT(channel,account_id) DO UPDATE SET cursor=excluded.cursor`,
          'telegram-private-intake-v1', this.privateAccountKey(), JSON.stringify(this.privateHealth));
      }));
    this.privateGapWrite = write;
    try {
      await write;
    } catch {
      // The volatile latch remains visible even when the durable failure record cannot be written.
      this.privateGap = gap;
    } finally {
      if (this.privateGapWrite === write) this.privateGapWrite = null;
    }
  }

  async handleIncoming(event) {
    this.requireProcessOwner();
    const message = event.message;
    if (!message || message.out || !(event.isPrivate || message.isPrivate)) return;
    const chatId = String(event.chatId ?? message.chatId ?? message.senderId ?? '');
    const cfg = this.service.config.telegram;
    if (!cfg.allowedChatIds.map(String).includes(chatId)) return;
    const text = String(message.message ?? message.text ?? '').trim();
    if (!text) return;
    const occurredAt = telegramTimestamp(message.date);

    try {
      const peer = typeof message.getInputChat === 'function' ? await message.getInputChat() : null;
      if (peer) this.peerEntities.set(chatId, peer);
    } catch { /* The numeric ID remains available for the fallback lookup on send. */ }
    this.requireProcessOwner();
    const sender = typeof message.getSender === 'function' ? await message.getSender() : null;
    this.requireProcessOwner();
    const name = [sender?.firstName, sender?.lastName].filter(Boolean).join(' ') || chatId;
    const account = this.service.telegramAccount();
    let identity = this.service.store.get('SELECT * FROM channel_identities WHERE channel=? AND account_id=? AND external_id=?', 'telegram', account, chatId);
    if (!identity) {
      const payload = {
        name,
        source: `Входящее MTProto-сообщение Telegram, chat ${chatId}`,
        channel: 'telegram',
        external_id: chatId,
        account_id: account,
        permission: `Ответ только на входящее сообщение Telegram ${message.id}; произвольная рассылка не разрешена`
      };
      const requestId = `telegram-mtproto-person:${account}:${chatId}`;
      await this.service.exclusive(() => this.service.store.transaction(() => {
        this.requireProcessOwner();
        return this.service.execute('person.create', payload, requestId, { kind: 'channel' });
      }));
      this.requireProcessOwner();
      identity = this.service.store.get('SELECT * FROM channel_identities WHERE channel=? AND account_id=? AND external_id=?', 'telegram', account, chatId);
    }
    const conversation = this.service.store.get('SELECT id FROM conversations WHERE channel_identity_id=?', identity.id);
    const payload = {
      conversation_id: conversation.id,
      text,
      direction: 'in',
      external_id: String(message.id),
      source: `telegram:mtproto:${account}:${chatId}:${message.id}`,
      ...(occurredAt ? { occurred_at: occurredAt, time_basis: 'source' } : {})
    };
    const requestId = `telegram-mtproto-update:v2:${this.service.config.partnerId}:${account}:${chatId}:${message.id}`;
    const committedHealth = await this.service.exclusive(() => this.service.store.transaction(() => {
      this.requireProcessOwner();
      // `execute` is the synchronous command body. Running it inside the same exclusive SQLite
      // transaction lets its message, audit and idempotency receipt commit with this intake cursor.
      const result = this.service.execute('message.record', payload, requestId, { kind: 'channel' });
      const previous = this.privateHealth ?? {};
      const nextHealth = { ...previous, version: 1, partner_id: this.service.config.partnerId,
        account_id: account, phase: this.privateGap ? 'gap' : 'catching_up', coverage: 'unverified',
        gap: this.privateGap ?? previous.gap ?? null, last_message_id: String(message.id), last_message_at: now() };
      this.service.store.run(`INSERT INTO channel_offsets(channel,account_id,cursor) VALUES(?,?,?)
        ON CONFLICT(channel,account_id) DO UPDATE SET cursor=excluded.cursor`,
        'telegram-private-intake-v1', this.privateAccountKey(account), JSON.stringify(nextHealth));
      return { result, health: nextHealth };
    }));
    this.requireProcessOwner();
    this.privateHealth = committedHealth.health;
    this.lastEvent = now();
    if (!this.privateGap) this.lastError = null;
  }

  async drain() {
    while (this.privateDrain || this.privateQueue.length || this.privateGapWrite) {
      const active = this.privateDrain;
      if (active) await active;
      else if (this.privateGapWrite) await this.privateGapWrite.catch(() => {});
      else this.kickPrivateQueue();
    }
    return this.readiness().private_intake;
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
          const occurredAt = telegramTimestamp(message?.date);
          this.service.recordDelivered(draft, String(message.id), autopilot ? 'telegram_autopilot' : 'telegram',
            occurredAt ? { occurred_at: occurredAt, time_basis: 'source' } : {});
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

  // Resolves once the readers are released and the connection they borrowed is gone, so a
  // shutdown can wait for this before closing the store.
  async stop() {
    this.stopped = true;
    this.connected = false;
    await this.drain();
    await this.stopSourceReaders().catch(() => {});
    try { await this.client?.disconnect(); } catch { /* A closing connection needs no report. */ }
  }
}
