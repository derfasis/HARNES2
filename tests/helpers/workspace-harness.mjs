import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, readJson } from '../../business/config.mjs';
import { Store, id } from '../../business/store.mjs';
import { BusinessService } from '../../business/service.mjs';
import { Scheduler } from '../../business/scheduler.mjs';

export const SOURCE = 'public:workspace-fixture';
export function workspaceHarness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-workspace-'));
  const config = readJson(path.join(ROOT, 'config/default.json'));
  config.continuity = { enabled: true, modelEnabled: false };
  config.actions = { enabled: true, modelEnabled: false, maxModelRunsPerDay: 5 };
  config.workspace = { enabled: true, modelEnabled: false };
  config.controlPlane = { enabled: true, maxConcurrent: 3, reservationUsd: 0.25 };
  Object.assign(config.opportunity, { automatic: true, allowedSourceRefs: [SOURCE],
    activeOffer: readJson(path.join(ROOT, 'benchmarks/opportunity-projection-v0/case-01.json')).active_offer });
  let store = new Store(directory), service = new BusinessService(store, config);
  let scheduler = new Scheduler(service, { decide() { throw Error('Model not authorized'); }, run() { throw Error('Model not authorized'); }, close() {} }, null);
  const beforeCleanup = [];
  t.after(async () => { for (const close of beforeCleanup) await close(); scheduler.stop(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const h = { directory, config, beforeCleanup, get store() { return store; }, get service() { return service; }, get scheduler() { return scheduler; },
    command(a, p, request = id(), actor = { kind: 'operator' }) { return service.command(a, p, request, actor); },
    ingest(extra = {}) { return this.command('source.ingest', { source_id: SOURCE, source_kind: 'sanitized_fixture',
      message_id: 'm1', author_id: 'a1', display_name: null, thread_id: null, reply_to_id: null, version: 1,
      operation: 'upsert', text: 'Two hours weekly.', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...extra }, id(), { kind: 'channel', sourceId: SOURCE }); },
    async accept(thread_id) {
      service.continuity.reconcile(); const d = service.continuity.detail(thread_id);
      const { turn_id } = await this.command('continuity.capture', { thread_id, expected_revision: d.revision, expected_basis_fingerprint: d.basis_fingerprint });
      const turn = service.continuity.turn(turn_id), e = turn.packet.evidence.at(-1);
      await this.command('continuity.propose', { turn_id, output: { summary: { text: 'Review the stated time requirement.', evidence_event_ids: [e.source_event_id] },
        claims: [{ source_event_id: e.source_event_id, quote: e.text }], hypotheses: [], unknowns: ['Unverified source statement.'],
        next: { kind: 'observe', reason: 'Watch corrections', wake_at: null, owner_question: null } } });
      await this.command('continuity.review', { turn_id, expected_basis_fingerprint: turn.basis_fingerprint, decision: 'accept', note: 'Owner reviewed interpretation' });
      return service.continuity.detail(thread_id);
    },
    async ready() {
      const { thread_id } = await this.command('work.goal', { title: 'Time', objective: 'Prepare an evidence-grounded response', success_condition: 'Owner receives a ready local material', source_ids: [SOURCE], max_age_seconds: 3600 });
      await this.ingest(); const d = await this.accept(thread_id);
      const { case_id } = await this.command('work.open', { thread_id, expected_basis_fingerprint: d.basis_fingerprint, title: 'Explain time required' });
      return case_id;
    },
    async material(case_id, content = '# Time\n\nThe source states two hours weekly. This is unverified.') {
      const d = service.work.detail(case_id);
      return this.command('work.material', { case_id, expected_revision: d.revision, title: 'Time response', content, evidence_event_ids: d.evidence_event_ids });
    },
    async approve(case_id, material_id) {
      const d = service.work.detail(case_id), m = d.materials.find(x => x.id === material_id);
      return this.command('work.review', { case_id, expected_revision: d.revision, material_id, sha256: m.sha256, decision: 'approve', note: 'Reviewed exact content' });
    },
    async execute(case_id, material_id, capability_id = 'material.export_local.v1') {
      const d = service.work.detail(case_id);
      const { action_id } = await this.command('work.prepare_action', { case_id, expected_revision: d.revision, material_id, capability_id });
      const a = service.actions.detail(action_id);
      await this.command('action.grant', { action_id, expected_revision: a.revision, proposal_hash: a.proposal_hash, expires_at: new Date(Date.now() + 3600000).toISOString() });
      await scheduler.sourceTick(); await scheduler.actionTick(); await scheduler.actionTick(); await service.work.reconcile();
      return action_id;
    },
    restart() { scheduler.stop(); store.close(); store = new Store(directory); store.recover(); service = new BusinessService(store, config);
      scheduler = new Scheduler(service, { decide() { throw Error('Model not authorized'); }, close() {} }, null); }
  }; return h;
}
