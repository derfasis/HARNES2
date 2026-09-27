// Which transport a source is read through, chosen by the source's own identity.
//
// The scheduler does not know what kind of source it is holding. It holds read-only readers and
// polls them; what decides the rest is the configured policy, exactly as it already does for
// Telegram. That is the whole point of routing through here rather than branching in the caller:
// a second `if browser` in the scheduler, in the pipeline, and in the error recorder would be
// three places to forget to update, and forgetting one is how a source ends up silently unread
// while everything reports that it is fine.
import { pollTelegramSource } from './sources/telegram-readonly.mjs';
import { pollBrowserSource } from './sources/browser-readonly.mjs';
import { sourceTransportKind } from './source-ingestion.mjs';

// The kind is decided in one place — the ingestion module, where the freshness boundary needs it
// too — and re-exported here, so the poller and the boundary cannot disagree about what a source
// is. Two independent decisions would eventually differ, and a source would be polled by one
// transport while judged by the other's rules.
export { sourceTransportKind };

// The one poll entry point. The scheduler calls this and nothing else.
export async function pollSource(service, sourceId, transport) {
  const kind = sourceTransportKind(service, sourceId);
  if (kind === 'browser') return pollBrowserSource(service, sourceId, transport);
  if (kind === 'telegram') return pollTelegramSource(service, sourceId, transport);
  const error = new Error(`No read-only transport is configured for ${kind} source`);
  error.code = 'SOURCE_TRANSPORT_UNAVAILABLE';
  throw error;
}

// The telemetry a failed poll is recorded under, so a browser failure is never filed as a Telegram
// one. Derived here, in the same place the kind is decided, so it cannot disagree with the poll.
export const pollFailureKind = (service, sourceId) =>
  `source.${sourceTransportKind(service, sourceId)}.poll.failed`;
