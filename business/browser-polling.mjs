// Which browser sources a tick may read, and in what order.
//
// A configured page does not change every twenty seconds, and a page that is down does not become
// more down by being asked again. Reading every source on every tick therefore spends the operator's
// network and the host's time on bytes that are already known, and a failing site is the worst case
// of exactly that: it is read, it fails, nothing changes, and the next tick reads it again.
//
// The state is in memory on purpose. It is a reading schedule, not a fact about the world, and a
// restart is allowed to forget it — after a restart every source is due once, and the per-tick
// budget spreads those first reads over the first few ticks rather than firing all of them at once.
import { sourceTransportKind } from './source-ingestion.mjs';

// How many browser pages one tick may read. A named constant rather than configuration, because it
// bounds the damage a misconfigured operator list can do; a list of fifty sources is bounded by a
// number nobody has to think about, and the operator who wants more can raise it here deliberately.
export const MAX_BROWSER_POLLS_PER_TICK = 2;

const intervalOf = (service, sourceId) => {
  const entry = (service.config.opportunity?.browserSources ?? []).find((s) => s.sourceId === sourceId);
  return Number.isInteger(entry?.pollEverySeconds) ? entry.pollEverySeconds : 300;
};

// The sources this tick may read, and the ones it merely passed over.
//
// Two different lists, because two different things are tracked. A *selected* source is read, and
// being read is what its interval protects. A *considered* source was due and was not read, because
// the tick's budget was already spent — and it is stamped too, because a source that keeps coming
// back as due drains the whole list within a minute and the interval stops meaning anything. Five
// sources, a budget of two and a five-minute interval therefore take fifteen minutes for a round,
// and a configuration larger than the budget can serve goes stale rather than lying about it.
//
// The order is by when a source was last *read*, not when it was last considered. That distinction
// is the whole anti-starvation rule: after a full round every source carries the same considered-at
// stamp, so ordering by that stamp ties all of them, and a tie-break by name picks the same first two
// on every round for ever. A source never read has no read-at at all and outranks everything that
// has one — which is what makes the rotation actually rotate.
export function dueBrowserSources(service, sourceReaders, state, { now = Date.now(), budget = MAX_BROWSER_POLLS_PER_TICK } = {}) {
  const candidates = [];
  for (const { sourceId } of sourceReaders ?? []) {
    if (sourceTransportKind(service, sourceId) !== 'browser') continue;
    const record = state.get(sourceId) ?? {};
    if (record.consideredAt !== undefined
      && now - record.consideredAt < intervalOf(service, sourceId) * 1000) continue;
    candidates.push({ sourceId, readAt: record.readAt ?? -1 });
  }
  candidates.sort((left, right) => left.readAt - right.readAt
    || (left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0));
  return { selected: candidates.slice(0, Math.max(0, budget)),
    considered: candidates.map((entry) => entry.sourceId) };
}

// Stamped before the attempt rather than in one branch after another, so the two outcomes cannot
// stamp differently and so a source that fails waits exactly as long as one that succeeds.
export const markBrowserConsidered = (state, sourceId, at = Date.now()) => {
  const record = state.get(sourceId) ?? {};
  state.set(sourceId, { ...record, consideredAt: at });
};
export const markBrowserRead = (state, sourceId, at = Date.now()) => {
  const record = state.get(sourceId) ?? {};
  state.set(sourceId, { ...record, consideredAt: at, readAt: at });
};
