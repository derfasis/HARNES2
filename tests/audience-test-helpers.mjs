import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, readJson } from '../business/config.mjs';
import { Store, id } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';

export const SOURCE = 'public:audience-fixture';
export const SOURCE_B = 'public:audience-fixture-b';
export const EVENT_TIME = '2026-01-01T00:00:00.000Z';

export function audienceHarness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-audience-'));
  let store = new Store(directory);
  const config = structuredClone(readJson(path.join(ROOT, 'config/default.json')));
  config.runtime.enabled = false;
  config.scheduler.enabled = false;
  config.telegram.enabled = false;
  config.telegram.liveSending = false;
  config.opportunity.automatic = true;
  config.audience = { enabled: true, modelEnabled: false, sources: [SOURCE, SOURCE_B] };
  config.opportunity.allowedSourceRefs = [SOURCE, SOURCE_B];
  config.continuity = { enabled: true, modelEnabled: false };
  config.workspace = { enabled: true, modelEnabled: false };
  config.controlPlane = { enabled: true, maxConcurrent: 3, reservationUsd: 0.25 };
  let service = new BusinessService(store, config);
  t.after(() => { try { service.control.close(); service.control.releaseProcess(); } catch {} store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const h = {
    directory, config,
    get store() { return store; },
    get service() { return service; },
    command(action, payload, request = id(), actor = { kind: 'operator' }) { return service.command(action, payload, request, actor); },
    ingest({ message_id, text, version = 1, operation = 'upsert', source_id = SOURCE, thread_id = null, reply_to_id = null, unsupported = undefined }) {
      return h.command('source.ingest', { source_id, source_kind: 'sanitized_fixture', message_id,
        author_id: `author:${source_id}`, display_name: null, thread_id, reply_to_id,
        version, operation, text, ...(unsupported ? { unsupported } : {}), created_at: EVENT_TIME, updated_at: EVENT_TIME }, id(),
      { kind: 'channel', sourceId: source_id });
    },
    open({ title = 'Understand one stated need', objective = 'Find one question worth asking', source_ids = [SOURCE], max_age_seconds = 3600 } = {}) {
      return h.command('audience.open', { title, objective, source_ids, max_age_seconds });
    },
    async capture(goalId) {
      const detail = service.audience.detail(goalId);
      return h.command('audience.capture', { goal_id: goalId, expected_revision: detail.revision,
        expected_basis_fingerprint: detail.basis_fingerprint });
    },
    restart() {
      try { service.control.close(); service.control.releaseProcess(); } catch {}
      store.close(); store = new Store(directory); store.recover(); service = new BusinessService(store, config);
    }
  };
  return h;
}

export function proposalFrom(packet, overrides = {}) {
  const exchange = packet.exchanges[0];
  const evidence = exchange.evidence[0];
  return { needs: [{ need_id: null, title: 'Clarify the stated setup',
    hypothesis: 'The person may need a simpler setup path.',
    why_now: 'They directly asked how to get started.', exchange_ids: [exchange.id],
    evidence_event_ids: [evidence.source_event_id], counterevidence_event_ids: [],
    next_step: 'observe', reason: 'One direct question supports a single clarification.',
    unknowns: ['Whether this applies to anyone else.'],
    support_quotes: [{ source_event_id: evidence.source_event_id, quote: evidence.text }], ...overrides }] };
}
