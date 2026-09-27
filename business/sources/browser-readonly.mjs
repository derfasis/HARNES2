// The read-only browser reader.
//
// One configured page is one source item. It produces the same strict envelope the Telegram reader
// produces, and hands it to the same `ingestSource`, so nothing downstream learns that a browser
// exists. What the envelope gives us for free is the version discipline: a repeated identical
// event is a duplicate and creates nothing, a changed event must carry a higher version, and
// `created_at` may never move once set. So the reader's job is to make a page's identity stable,
// its content the only thing that changes, and its creation time the first time we saw it.
//
// The reader holds no write path. There is no method that submits a form, follows a POST, or sends
// anything; the only operation available is reading a page the operator configured.
import { createHash } from 'node:crypto';
import { AppError, ensure } from '../errors.mjs';
import { ingestSource, sourceRows, browserCheckpoint, writeBrowserCheckpoint, browserPolicyHash,
  browserPolicyShape, BROWSER_CHECKPOINT_CHANNEL } from '../source-ingestion.mjs';
import { fetchPublicPage, LIMITS } from './browser-fetch.mjs';
import { sanitizeHtml } from './browser-sanitize.mjs';

export const browserPolicy = (service, sourceId) => {
  const configured = (service.config.opportunity?.browserSources ?? []).find((entry) => entry.sourceId === sourceId);
  ensure(configured, 'BROWSER_SOURCE_NOT_CONFIGURED');
  const { sourceId: id, url, maxLagSeconds, pollEverySeconds } = configured;
  ensure(typeof id === 'string' && id.length > 0 && id.length <= 300, 'BROWSER_POLICY_INVALID');
  ensure(typeof url === 'string' && url.length > 0 && url.length <= 2000, 'BROWSER_POLICY_INVALID');
  ensure(Number.isInteger(maxLagSeconds) && maxLagSeconds > 0 && maxLagSeconds <= 3600, 'BROWSER_POLICY_INVALID');
  ensure(Number.isInteger(pollEverySeconds) && pollEverySeconds > 0 && pollEverySeconds <= 3600, 'BROWSER_POLICY_INVALID');
  // The interval is carried but deliberately outside the hashed shape. How often we choose to
  // look is an operational decision; what the source *is* — same URL, same freshness budget — is
  // the identity. Folding the interval in would make changing a reading schedule look like
  // changing the source, and the boundary would refuse it as a different one.
  return Object.freeze({ ...browserPolicyShape({ sourceId: id, url, maxLagSeconds }), pollEverySeconds });
};

const digest = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

// The identities are derived, not invented per run: the same page always yields the same message
// and author, so an unchanged page is recognisably the same item on every poll and after any
// restart. The author is scoped to this source, so two configured pages from one site are two
// authors rather than one person appearing twice.
const identities = (policy) => ({
  message_id: `page:${digest([policy.sourceId, policy.url])}`,
  author_id: `site:${digest([policy.sourceId, new URL(policy.url).hostname])}`,
});

export class BrowserSourceReader {
  #policy; #transport;
  // `request` and `lookup` are the boundary's seams. Both default to the real ones, so a reader
  // built in production opens a real socket, and a test can state what a host resolves to and how
  // a socket behaves without either reaching a network.
  constructor(policy, { request, lookup } = {}) { this.#policy = policy; this.#transport = { request, lookup }; }
  policy() { return this.#policy; }

  // The only thing this class can do. There is deliberately no write counterpart.
  async readPage() {
    const page = await fetchPublicPage(this.#policy.url, this.#transport);
    const { text, truncated, originalLength } = sanitizeHtml(page.body.toString('utf8'), LIMITS.maxTextChars);
    if (!text) { const error = new AppError('The page yielded no readable text', 422, 'BROWSER_EMPTY_PAGE'); error.code = 'BROWSER_EMPTY_PAGE'; throw error; }
    return { text, truncated, originalLength, finalUrl: page.finalUrl, status: page.status };
  }
}

// Builds the envelope for what was read, using the source's own history to decide the version and
// the creation time. The history is the durable record, so this survives a restart: a poll after a
// crash computes the same version it would have computed before it.
const envelopeFor = (service, policy, page) => {
  const { message_id: messageId, author_id: authorId } = identities(policy);
  const previous = sourceRows(service, policy.sourceId).find((row) => row.message.message_id === messageId);
  const contentDigest = digest(page.text);
  const now = new Date().toISOString();

  if (previous) {
    // Unchanged content is not a new version. Returning the stored version makes `ingestSource`
    // see a byte-identical event, which it records as a duplicate: the page is read, and nothing
    // new is claimed. The comparison is against the text actually stored, which is the only copy
    // that survives a restart.
    if (digest(previous.message.text) === contentDigest) {
      return { source_id: policy.sourceId, source_kind: 'live_snapshot', message_id: messageId,
        author_id: authorId, display_name: null, thread_id: null, reply_to_id: null,
        version: previous.message.version, operation: 'upsert', text: page.text,
        created_at: previous.message.created_at, updated_at: previous.message.updated_at };
    }
    return { source_id: policy.sourceId, source_kind: 'live_snapshot', message_id: messageId,
      author_id: authorId, display_name: null, thread_id: null, reply_to_id: null,
      version: previous.message.version + 1, operation: 'upsert', text: page.text,
      // Creation time belongs to the item, not to the revision of it.
      created_at: previous.message.created_at, updated_at: now };
  }
  return { source_id: policy.sourceId, source_kind: 'live_snapshot', message_id: messageId,
    author_id: authorId, display_name: null, thread_id: null, reply_to_id: null,
    version: 1, operation: 'upsert', text: page.text, created_at: now, updated_at: now };
};

// Read one configured page and feed it through the same intake every other source uses.
//
// The network read happens outside any lock, because holding a transaction open across a socket is
// how a slow page becomes a blocked service. Everything after it — reading the source's history,
// deriving the version, ingesting, and marking the source current — happens inside one exclusive
// transaction, so a crash can never leave "the page was ingested" and "the source is current" as
// two different facts.
export async function pollBrowserSource(service, sourceId, transport) {
  ensure(transport && typeof transport.readPage === 'function', 'The browser reader is required', 409, 'BROWSER_READER_REQUIRED');
  const policy = browserPolicy(service, sourceId);

  // A source that has been blocked stays blocked until something clears it. A failed poll marks the
  // reason, and the next poll is refused rather than quietly reading on as if nothing had happened.
  const existing = browserCheckpoint(service, sourceId);
  if (existing && existing.policy_hash !== browserPolicyHash(policy))
    ensure(false, 'The browser policy changed since the source was last confirmed', 409, 'BROWSER_POLICY_CHANGED_SINCE_CONFIRMATION');
  if (existing?.phase === 'blocked') ensure(false, 'The browser source is blocked', 409, 'BROWSER_SOURCE_BLOCKED');

  const page = await transport.readPage();

  const result = await service.exclusive(() => service.store.transaction(() => {
    const envelope = envelopeFor(service, policy, page);
    const ingested = ingestSource(service, envelope);
    // Written with the intake, never after it: a page that was ingested and a source that was not
    // marked current would read as a failure that never happened.
    writeBrowserCheckpoint(service, sourceId, { source_id: sourceId, policy_hash: browserPolicyHash(policy),
      phase: 'current', confirmed_at: new Date().toISOString(), reason: null });
    return ingested;
  }));
  return { ...result, disposition: result.disposition, browser: { truncated: page.truncated, final_url: page.finalUrl } };
}

// A failed read is recorded as a blocked source with its class of failure, so the next poll refuses
// rather than pretending the page is still fresh. Only a code leaves this function: a provider or
// network message can carry detail, and this lands in durable storage.
export function markBrowserSourceBlocked(service, sourceId, code) {
  const policy = browserPolicy(service, sourceId);
  const clean = /^[A-Z][A-Z0-9_]{1,63}$/.test(String(code)) ? String(code) : 'BROWSER_READ_FAILED';
  service.store.run('INSERT OR REPLACE INTO channel_offsets(channel,account_id,cursor) VALUES(?,?,?)',
    BROWSER_CHECKPOINT_CHANNEL, digest([service.config.partnerId, sourceId]),
    JSON.stringify({ source_id: sourceId, policy_hash: browserPolicyHash(policy), phase: 'blocked',
      confirmed_at: null, reason: clean }));
  return clean;
}
