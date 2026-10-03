// The read-only transport the public source reader needs, over a GramJS client that already
// exists. It creates no connection of its own: TelegramPublicSourceReader does the difference, the
// cursor, the recovery and the ingestion, and this only lends it the three calls it cannot do
// without, plus the raw update stream it filters for itself.
//
// Nothing here sends. It reads, and closing it drops its own subscription and nothing else.
import { createRequire } from 'node:module';
import { telegramRead } from '../telegram-read-gate.mjs';
import { telegramSourcePolicy } from './telegram-readonly.mjs';

const require = createRequire(import.meta.url);
const { Api } = require('telegram');
const { UpdateConnectionState } = require('telegram/network');
const bigInt = require('big-integer');

export class GramjsSourceRpc {
  #client; #service; #sourceId; #accountId; #owner; #ownerAccountId; #generation; #handler = null; #builder = null; #closed = false;

  constructor(client, service, sourceId, { owner = null } = {}) {
    if (!client || typeof client.invoke !== 'function' || typeof client.addEventHandler !== 'function')
      throw new TypeError('A connected GramJS client is required');
    this.#client = client;
    this.#service = service;
    this.#sourceId = sourceId;
    this.#accountId = service.telegramAccountId;
    this.#owner = owner;
    this.#ownerAccountId = owner?.accountId;
    this.#generation = owner?.clientGeneration;
  }

  // Raw updates, exactly as the SDK delivers them. Filtering is the reader's job: it is written
  // against these very classes and decides what a permitted delta is.
  //
  // A builder that returns the update untouched is required. The SDK's own NewMessage builder
  // wraps the update in an event, and the reader is written against Api.Updates, Api.UpdateShort
  // and the Api.Update* family, so a wrapped event would silently never match. Polling would still
  // work, which is what makes this the kind of break a test cannot see.
  //
  // Connection-state events are the one class not passed through. The reader treats one as proof
  // that its evidence may be stale and invalidates the source, which is right for a real
  // disconnect. The SDK emits the same class as a keepalive about four times a minute, so
  // forwarding them blocked the source within seconds of connecting and nothing could ever be
  // ingested. SDK disconnect/broken states are forwarded even if async dispatch happens after
  // reconnect; a connected keepalive cannot stand in for a fresh difference.
  subscribe(onUpdate) {
    if (this.#builder) return;
    this.#builder = {
      resolved: true,
      async resolve() {},
      async filter(update) { return update; },
      build(update) { return update; },
    };
    this.#handler = event => {
      if (!this.ownsResource()) return;
      if (event instanceof UpdateConnectionState) {
        if (this.#client.connected === false || event.state === UpdateConnectionState.disconnected
            || event.state === UpdateConnectionState.broken) return onUpdate(event);
        return;
      }
      return onUpdate(event);
    };
    this.#client.addEventHandler(this.#handler, this.#builder);
  }

  async invokeRead(request) {
    const result=await telegramRead(this.#service,{accountId:this.#accountId,sourceId:this.#sourceId,priority:'monitor'},()=>{
      telegramSourcePolicy(this.#service,this.#sourceId);
      if(!this.connected())throw new Error('Source reader retired');
      return this.#client.invoke(request);
    });
    if(!this.connected())throw new Error('Source connection retired');
    return result;
  }

  // Stable ownership survives a temporary disconnect so its event can invalidate
  // the reader's epoch. A retired client/generation cannot update or commit again.
  ownsResource() {
    const control = this.#service.control;
    return !this.#closed && (!this.#accountId || this.#service.telegramAccountId === this.#accountId)
      && !control?.stopped && (!control || control.processCurrent())
      && (!this.#owner || this.#owner.stopped !== true && this.#owner.service === this.#service
        && this.#owner.client === this.#client && this.#owner.accountId === this.#ownerAccountId
        && this.#owner.clientGeneration === this.#generation);
  }

  connected() { return this.ownsResource() && this.#client.connected === true
    && (!this.#owner || this.#owner.connected === true); }

  // The reader closing must not take the shared client down: the owner of the connection is the
  // channel, which may still be serving other work. Only this subscription is released.
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#handler) { this.#client.removeEventHandler(this.#handler); this.#handler = null; }
  }

  // The policy carries the bare channel id, and the SDK only recognises a channel when the peer is
  // marked as one. Resolving the bare number looks for a user and fails with PeerUser. The SDK
  // also has no accessor that yields the InputChannel this reader needs, so it is built from the
  // entity the client already resolved, with its own access hash. Nothing is invented here.
  async resolveInputChannel(peer) {
    if (!this.ownsResource()) throw new Error('Source reader retired');
    const id = String(peer);
    const entity = await this.#client.getEntity(id.startsWith('-100') ? id : `-100${id}`);
    if (!this.ownsResource()) throw new Error('Source connection retired');
    if (!(entity instanceof Api.Channel) || entity.accessHash == null)
      throw new TypeError(`Peer ${peer} is not a channel this account can read`);
    return new Api.InputChannel({ channelId: bigInt(entity.id), accessHash: bigInt(entity.accessHash) });
  }
}
