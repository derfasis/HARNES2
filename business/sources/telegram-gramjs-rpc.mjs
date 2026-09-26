// The read-only transport the public source reader needs, over a GramJS client that already
// exists. It creates no connection of its own: TelegramPublicSourceReader does the difference, the
// cursor, the recovery and the ingestion, and this only lends it the three calls it cannot do
// without, plus the raw update stream it filters for itself.
//
// Nothing here sends. It reads, and closing it drops its own subscription and nothing else.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { NewMessage } = require('telegram/events/NewMessage');
const { UpdateConnectionState } = require('telegram/network');
const { Api } = require('telegram');
const bigInt = require('big-integer');

export class GramjsSourceRpc {
  #client; #service; #sourceId; #handler = null; #faultHandler = null; #closed = false;

  constructor(client, service, sourceId) {
    if (!client || typeof client.invoke !== 'function' || typeof client.addEventHandler !== 'function')
      throw new TypeError('A connected GramJS client is required');
    this.#client = client;
    this.#service = service;
    this.#sourceId = sourceId;
  }

  // Raw updates, exactly as the SDK delivers them. Filtering is the reader's job: it is written
  // against these very classes and decides what a permitted delta is.
  subscribe(onUpdate, onFault) {
    if (this.#handler) return;
    this.#handler = event => { if (!this.#closed) onUpdate(event); };
    this.#faultHandler = () => { if (!this.#closed && typeof onFault === 'function') onFault(); };
    // nofilter: service messages and non-message updates must reach the reader too, because it is
    // the reader that knows which of them carry a cursor.
    this.#client.addEventHandler(this.#handler, new NewMessage({ incoming: true, nofilter: true }));
    this.#client.addEventHandler(this.#faultHandler, new UpdateConnectionState());
  }

  async invokeRead(request) { return this.#client.invoke(request); }

  connected() { return !this.#closed && this.#client.connected === true; }

  // The reader closing must not take the shared client down: the owner of the connection is the
  // channel, which may still be serving other work. Only this subscription is released.
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#handler) { this.#client.removeEventHandler(this.#handler); this.#handler = null; }
    if (this.#faultHandler) { this.#client.removeEventHandler(this.#faultHandler); this.#faultHandler = null; }
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
