// Which browser sources a tick may read, and in what order.
//
// A configured page does not change every twenty seconds, and a page that is down does not become
// more down by being asked again. Reading every source on every tick therefore spends the operator's
// network and the host's time on bytes that are already known, and a failing site is the worst case
// of exactly that: it is read, it fails, nothing changes, and the next tick reads it again.
//
// So the schedule lives here rather than in the reader: a source is read when its own interval has
// elapsed since its last *attempt*, not since it last succeeded. Success is not a condition for
// waiting, because a source that only backs off on success backs off never.
//
// The state is in memory on purpose. It is a reading schedule, not a fact about the world, and a
// restart is allowed to forget it — after a restart every source is due once, and the per-tick
// budget spreads those first reads over the first few ticks rather than firing all of them at once.
import { sourceTransportKind } from './source-ingestion.mjs';

// How many browser pages one tick may read. A named constant rather than configuration, because it
// bounds the damage a misconfigured operator list can do; a list of fifty sources is bounded by a
// number nobody has to think about, and the operator who wants more can raise it here deliberately.
export const MAX_BROWSER_POLLS_PER_TICK = 2;

const intervalOf = (service, sourceId) =>
  Number.isInteger(service.config.opportunity?.browserSources
    ?.find((entry) => entry.sourceId === sourceId)?.pollEverySeconds)
    ? service.config.opportunity.browserSources.find((entry) => entry.sourceId === sourceId).pollEverySeconds
    : 300;

// The sources this tick may read, in the order it should read them.
//
// Ordering is the anti-starvation rule. Sorted by last attempt, oldest first, with a source that has
// never been attempted counting as infinitely old, so a source that keeps losing the budget — because
// newer sources are read every tick — still comes first next time round. Without this, the order a
// configuration happens to list in would decide who is read and who is not.
export function dueBrowserSources(service, sourceReaders, state, { now = Date.now(), budget = MAX_BROWSER_POLLS_PER_TICK } = {}) {
  const candidates = [];
  for (const { sourceId } of sourceReaders ?? []) {
    if (sourceTransportKind(service, sourceId) !== 'browser') continue;
    const intervalMs = intervalOf(service, sourceId) * 1000;
    const lastAttempt = state.get(sourceId);
    // Never attempted, or the interval has elapsed. `lastAttempt === undefined` is not zero: a
    // restart must produce a first read, and treating it as 1970 would make every source
    // permanently overdue in a way that reads as a bug rather than as "read it once".
    if (lastAttempt !== undefined && now - lastAttempt < intervalMs) continue;
    candidates.push({ sourceId, lastAttempt: lastAttempt ?? -1 });
  }
  candidates.sort((left, right) => left.lastAttempt - right.lastAttempt
    || (left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0));
  return candidates.slice(0, Math.max(0, budget));
}

// Stamped after the attempt, whatever its outcome. This is the whole point: a source that fails
// waits its interval like any other, and is not retried on the next tick for having failed.
export const markBrowserAttempted = (state, sourceId, at = Date.now()) => { state.set(sourceId, at); };
