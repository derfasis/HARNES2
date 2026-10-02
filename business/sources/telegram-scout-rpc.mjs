// Read-only discovery/history adapter over the already connected Telegram owner.
// It never creates a client, subscribes to updates, or uses GramJS convenience
// methods that could join a peer or alter account state.
import { createRequire } from 'node:module';
import { AppError } from '../errors.mjs';
import { digest } from '../source-ingestion.mjs';
import { Api, decimal, mapTelegramMessage } from './telegram-gramjs-semantic.mjs';
import { telegramRead } from '../telegram-read-gate.mjs';

const require = createRequire(import.meta.url);
const bigInt = require('big-integer');
const MAX_RPC_MS = 15_000;
const MAX_FLOOD_WAIT = 604_800;

function check(condition) {
  if (!condition) throw new AppError('Telegram scout received invalid peer data', 409, 'SCOUT_MAPPING_INVALID');
}

function identifier(value) {
  check(typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value));
  check(BigInt(value) <= 9_223_372_036_854_775_807n);
  return value;
}

function accessHash(value) {
  if (value == null) return null;
  check(typeof value === 'string');
  return checkedHash(value);
}

function sdkAccessHash(value) {
  if (value == null) return null;
  check(typeof value === 'object' && typeof value.toString === 'function');
  return checkedHash(value.toString());
}

function checkedHash(result) {
  check(/^-?[0-9]{1,20}$/.test(result));
  const integer = BigInt(result);
  check(integer >= -9_223_372_036_854_775_808n && integer <= 9_223_372_036_854_775_807n);
  return result;
}

function publicName(channel) {
  const primary = typeof channel.username === 'string' && channel.username.trim() ? channel.username.trim() : null;
  if (primary) return primary;
  const active = channel.usernames?.find(entry => entry?.active && typeof entry.username === 'string' && entry.username.trim());
  return active?.username?.trim() ?? null;
}

function channelKind(channel) {
  if (channel.megagroup || channel.gigagroup) return 'group';
  if (channel.broadcast) return 'channel';
  return null;
}

function candidateFrom(channel, linkedFrom) {
  if (!(channel instanceof Api.Channel) || channel.min || channel.restricted) return null;
  const kind = channelKind(channel);
  const channel_id = decimal(channel.id);
  if (!kind || typeof channel.title !== 'string' || !channel.title.trim()) return null;
  const candidate = {
    channel_id,
    username: publicName(channel),
    title: channel.title,
    kind,
    joined: channel.left !== true,
    access_hash: sdkAccessHash(channel.accessHash),
  };
  if (linkedFrom != null) candidate.linked_from = identifier(linkedFrom);
  return candidate;
}

function dateIso(value) {
  const date = value instanceof Date ? value : new Date(Number(value) * 1000);
  check(Number.isFinite(date.getTime()));
  return date.toISOString();
}

function safeFailure(error) {
  if (error instanceof AppError && /^SCOUT_/.test(error.code)) return error;
  const message = String(error?.errorMessage ?? error?.message ?? error?.constructor?.name ?? '');
  const seconds = Number(error?.seconds ?? error?.value ?? message.match(/FLOOD_WAIT_?(\d+)/i)?.[1]);
  if (/FLOOD_WAIT/i.test(message) && Number.isFinite(seconds) && seconds > 0) {
    if (seconds > MAX_FLOOD_WAIT) {
      const held=new AppError('Telegram scout FLOOD_WAIT requires manual retry after a long rate limit',429,'SCOUT_FLOOD_WAIT_MANUAL');
      held.retrySeconds=Math.ceil(seconds);return held;
    }
    const retrySeconds = Math.max(1, Math.ceil(seconds));
    const wrapped = new AppError('Telegram scout is rate limited', 429, 'SCOUT_FLOOD_WAIT');
    wrapped.retrySeconds = retrySeconds;
    return wrapped;
  }
  if (/CHANNEL_(?:PRIVATE|INVALID)|USERNAME_(?:INVALID|NOT_OCCUPIED)|PEER_ID_INVALID/i.test(message))
    return new AppError('Telegram channel access is unavailable for this account', 409, 'SCOUT_ACCESS_UNAVAILABLE');
  return new AppError('Telegram scout RPC failed', 502, 'SCOUT_RPC_FAILED');
}

function inputChannel(channel_id, access_hash) {
  return new Api.InputChannel({ channelId: bigInt(identifier(channel_id)), accessHash: bigInt(accessHash(access_hash)) });
}

export class TelegramScoutRpc {
  #owner;
  #client;
  #accountId;
  #generation;
  #beforeRead;
  #sourceId;
  #priority;

  constructor(owner,{beforeRead=()=>{},sourceId=null,priority='audit'}={}) {
    if (!owner || !owner.client || typeof owner.client.invoke !== 'function')
      throw new TypeError('A connected MTProto Telegram owner is required');
    this.#owner = owner;
    this.#client = owner.client;
    this.#accountId = owner.accountId ?? null;
    this.#generation = owner.clientGeneration;
    if (!this.#accountId || owner.stopped === true || owner.connected !== true || this.#client.connected !== true)
      throw new AppError('Telegram scout is disconnected',409,'SCOUT_DISCONNECTED');
    this.#beforeRead=beforeRead;this.#sourceId=sourceId;this.#priority=priority;
  }

  get accountId() { return this.#accountId; }

  connected() {
    return this.#owner.stopped !== true && this.#owner.connected === true
      && this.#owner.client === this.#client && this.#owner.accountId === this.#accountId
      && this.#owner.clientGeneration === this.#generation && this.#client.connected === true;
  }

  #assertConnected() {
    if (!this.connected()) throw new AppError('Telegram scout is disconnected', 409, 'SCOUT_DISCONNECTED');
  }

  async #invoke(request) {
    this.#assertConnected();
    let timer;
    try {
      const invoke=()=>{
        this.#assertConnected();this.#beforeRead();
        return Promise.race([
        this.#client.invoke(request),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new AppError('Telegram scout RPC timed out', 504, 'SCOUT_RPC_TIMEOUT')), MAX_RPC_MS);
        }),
        ]);
      };
      const service=this.#owner.service;
      const result = await (service?telegramRead(service,{accountId:this.accountId,sourceId:this.#sourceId,priority:this.#priority},invoke):invoke());
      // The account/client may be replaced while a queued read or provider call is pending.
      // Discard that result before any caller can project or persist it.
      this.#assertConnected();
      return result;
    } catch (error) {
      if (error instanceof AppError && ['SCOUT_RPC_TIMEOUT', 'SCOUT_DISCONNECTED'].includes(error.code)) throw error;
      throw safeFailure(error);
    } finally {
      clearTimeout(timer);
    }
  }

  async search({ query, limit = 20 } = {}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 256
        || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AppError('Invalid Telegram scout search request', 400, 'SCOUT_INVALID_REQUEST');
    const response = await this.#invoke(new Api.contacts.Search({ q: query.trim(), limit }));
    check(Array.isArray(response?.chats));
    const candidates = [];
    for (const chat of Array.isArray(response?.chats) ? response.chats : []) {
      const candidate = candidateFrom(chat);
      if (candidate) candidates.push(candidate);
      if (candidates.length >= limit) break;
    }
    return { candidates, inexact: true };
  }

  async #entity({ channel_id, username, access_hash }) {
    let id = channel_id == null ? null : identifier(channel_id);
    let hash = access_hash;
    let entity = null;
    if (typeof username === 'string' && username.trim()) {
      const name = username.trim().replace(/^@/, '');
      const response = await this.#invoke(new Api.contacts.ResolveUsername({ username: name }));
      entity = (response?.chats ?? []).find(chat => chat instanceof Api.Channel
        && (publicName(chat)?.toLowerCase() === name.toLowerCase()));
    } else if (id != null) {
      if (hash == null) {
        // GramJS Session.getInputEntity is a synchronous cache lookup. Do not use
        // client.getInputEntity here: that convenience method may perform network RPCs.
        let cached;
        try { cached = this.#owner.client.session?.getInputEntity(`-100${id}`); } catch { /* Cache miss. */ }
        if (cached && typeof cached.then !== 'function'
            && (cached instanceof Api.InputChannel || cached instanceof Api.InputPeerChannel)
            && decimal(cached.channelId) === id && cached.accessHash != null)
          hash = sdkAccessHash(cached.accessHash);
      }
      if (hash != null) {
        const response = await this.#invoke(new Api.channels.GetChannels({ id: [inputChannel(id, hash)] }));
      entity = (response?.chats ?? []).find(chat => chat instanceof Api.Channel && decimal(chat.id) === id);
      }
    }
    if (entity != null) {
      check(!entity.min && !entity.restricted);
      const resolvedId = decimal(entity.id);
      check(id == null || id === resolvedId);
      id = resolvedId;
      if (hash != null) check(sdkAccessHash(entity.accessHash) === accessHash(hash));
      return entity;
    }
    // Numeric private peers need a local session cache entry. A miss is reported
    // explicitly; the adapter never falls back to getDialogs/getUsers or enumeration.
    throw new AppError('Telegram channel is unavailable from the local session cache or public username', 409, 'SCOUT_ACCESS_UNAVAILABLE');
  }

  async resolve({ channel_id, username, access_hash } = {}) {
    if (channel_id == null && !(typeof username === 'string' && username.trim()))
      throw new AppError('A channel id or username is required', 400, 'SCOUT_INVALID_REQUEST');
    const entity = await this.#entity({ channel_id, username, access_hash });
    const found = candidateFrom(entity);
    check(found);
    const resolvedHash = entity.accessHash == null ? accessHash(access_hash) : sdkAccessHash(entity.accessHash);
    return {
      channel_id: decimal(entity.id),
      username: publicName(entity),
      title: entity.title,
      kind: found.kind,
      joined: entity.left !== true,
      access_hash: resolvedHash,
    };
  }

  async discussions(candidate) {
    const peer = await this.#entity(candidate ?? {});
    check(peer.accessHash != null);
    const sourceId = decimal(peer.id);
    const response = await this.#invoke(new Api.channels.GetFullChannel({
      channel: inputChannel(sourceId, sdkAccessHash(peer.accessHash)),
    }));
    check(response?.fullChat instanceof Api.ChannelFull && decimal(response.fullChat.id)===sourceId);
    const linkedId = response?.fullChat?.linkedChatId;
    if (linkedId == null) return null;
    const id = decimal(linkedId);
    const linked = (response.chats ?? []).find(chat => chat instanceof Api.Channel && decimal(chat.id) === id);
    const result = linked ? candidateFrom(linked, sourceId) : null;
    return result?.kind === 'group' ? result : null;
  }

  async history({ channel_id, access_hash, username, before_id = 0, limit = 50, until_date } = {}) {
    const id = identifier(channel_id);
    if (!Number.isSafeInteger(before_id) || before_id < 0 || before_id > 2147483647
        || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AppError('Invalid Telegram scout history request', 400, 'SCOUT_INVALID_REQUEST');
    const hash = accessHash(access_hash);
    if (hash == null) throw new AppError('A channel access hash is required', 400, 'SCOUT_INVALID_REQUEST');
    let offsetDate = 0;
    if (until_date != null) {
      const millis = until_date instanceof Date ? until_date.getTime()
        : typeof until_date === 'string' ? Date.parse(until_date) : Number(until_date) * 1000;
      if (!Number.isFinite(millis)) throw new AppError('Invalid history date', 400, 'SCOUT_INVALID_REQUEST');
      offsetDate = Math.floor(millis / 1000);
    }
    const peer = new Api.InputPeerChannel({ channelId: bigInt(id), accessHash: bigInt(hash) });
    const response = await this.#invoke(new Api.messages.GetHistory({
      peer, offsetId: before_id, offsetDate, addOffset: 0, limit, maxId: 0, minId: 0, hash: bigInt.zero,
    }));
    check(Array.isArray(response?.messages)&&response.messages.length<=limit);
    const nativeMessages = response.messages;
    const projected = [];
    let oldest = null;
    for (const native of nativeMessages) {
      if (native?.id != null) {
        const rawId = Number(native.id);
        if (Number.isSafeInteger(rawId) && rawId > 0) oldest = oldest == null ? rawId : Math.min(oldest, rawId);
      }
      if (!(native instanceof Api.Message || native instanceof Api.MessageService)) continue;
      const semantic = mapTelegramMessage({ channelId: id }, native);
      const messageId = String(semantic.id);
      const author = semantic.from_id;
      const unsupported = semantic.unsupported?.reason ?? null;
      const text = semantic.text;
      projected.push({
        message_id: messageId,
        author_ref: author ? `${author.kind}:${author.id}` : null,
        date: dateIso(semantic.date),
        text,
        reply_to: semantic.reply_to_msg_id == null ? null : String(semantic.reply_to_msg_id),
        unsupported,
        content_hash: digest(semantic),
        link: typeof username === 'string' && /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(username)
          ? `https://t.me/${username}/${messageId}` : null,
      });
    }
    return { messages: projected, oldest_id: oldest, empty: nativeMessages.length === 0,
      requested_count: limit, received_count: nativeMessages.length };
  }
}
