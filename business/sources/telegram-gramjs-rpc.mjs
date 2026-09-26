// The read-only transport the public source reader needs, over a GramJS client that already
// exists. It creates no connection of its own: TelegramPublicSourceReader does the difference, the
// cursor, the recovery and the ingestion, and this only lends it the three calls it cannot do
// without, plus the raw update stream it filters for itself.
//
// Nothing here sends. It reads, and closing it drops its own subscription and nothing else.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Api } = require('telegram');
const { UpdateConnectionState } = require('telegram/network');
const bigInt = require('big-integer');

export class GramjsSourceRpc {
  #client; #service; #sourceId; #handler = null; #builder = null; #closed = false;

  constructor(client, service, sourceId) {
    if (!client || typeof client.invoke !== 'function' || typeof client.addEventHandler !== 'function')
      throw new TypeError('A connected GramJS client is required');
    this.#client = client;
    this.#service = service;
    this.#sourceId = sourceId;
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
  // ingested. Only a genuine loss of connection is reported; the reader still invalidates on any
  // failing read, so a real break is caught on the next poll either way.
  subscribe(onUpdate) {
    if (this.#builder) return;
    this.#builder = {
      resolved: true,
      async resolve() {},
      async filter(update) { return update; },
      build(update) { return update; },
    };
    this.#handler = event => {
      if (this.#closed) return;
      if (event instanceof UpdateConnectionState) {
        if (this.#client.connected === false) onUpdate(event);
        return;
      }
      onUpdate(event);
    };
    this.#client.addEventHandler(this.#handler, this.#builder);
  }

  async invokeRead(request) { return this.#client.invoke(request); }

  connected() { return !this.#closed && this.#client.connected === true; }

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
    const id = String(peer);
    const entity = await this.#client.getEntity(id.startsWith('-100') ? id : `-100${id}`);
    if (!(entity instanceof Api.Channel) || entity.accessHash == null)
      throw new TypeError(`Peer ${peer} is not a channel this account can read`);
    return new Api.InputChannel({ channelId: bigInt(entity.id), accessHash: bigInt(entity.accessHash) });
  }
}
