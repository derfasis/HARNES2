import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, id } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { readJson, ROOT } from '../business/config.mjs';

function harness(t, enabled = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'outcome-kill-'));
  let store = new Store(directory);
  const config = readJson(path.join(ROOT, 'config/default.json'));
  config.outcomes = { enabled, responseWindowSeconds: 3600 };
  config.engagement.enabled = true;
  let service = new BusinessService(store, config);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return {
    directory, config,
    get store() { return store; }, get service() { return service; },
    command(action, payload, requestId = id(), actor = { kind: 'operator' }) { return service.command(action, payload, requestId, actor); },
    restart() { store.close(); store = new Store(directory); store.recover(); service = new BusinessService(store, config); },
    async person() { return this.command('person.create', { name: 'Synthetic', source: 'offline' }); },
    async message(cid, text, at) {
      const result = await this.command('message.record', { conversation_id: cid, text, source: 'offline', ...(at ? { occurred_at: at } : {}) });
      if (at) store.run('UPDATE messages SET created_at=? WHERE id=?', at, result.message_id);
      return result.message_id;
    },
    sent(cid, at) {
      const mid = id();
      store.run("INSERT INTO messages(id,conversation_id,direction,author,text,source,created_at) VALUES(?,?,'out','operator','Sent','offline',?)", mid, cid, at);
      service.outcomes.observeSent(cid, mid, at);
      return store.get('SELECT * FROM outcome_observation_windows WHERE message_id=?', mid);
    },
    async delivered(edited = false) {
      const { conversation_id: cid } = await this.person();
      const mid = await this.message(cid, 'Please reply');
      const engagement = service.engagement.current(cid);
      await this.command('permission.grant', { conversation_id: cid, purpose: 'reply', granted_by: 'owner', evidence: 'explicit fixture', valid_from: '2020-01-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' });
      const decision = await this.command('decision.commit', { engagement_id: engagement.id, expected_revision: service.engagement.get(engagement.id).revision, kind: 'ACT', reason: 'Answer request', expected_next: 'A reply', evidence: [{ type: 'message', id: mid }], action: { purpose: 'reply', text: 'Here is the answer.' } });
      if (edited) await this.command('draft.edit', { draft_id: decision.draft_id, text: 'Owner answer.' });
      await this.command('draft.approve', { draft_id: decision.draft_id });
      await this.command('delivery.manual', { draft_id: decision.draft_id, evidence: 'Actually delivered offline' });
      return { cid, ...decision, sent: store.get('SELECT * FROM messages WHERE draft_id=?', decision.draft_id) };
    },
  };
}

test('real approved delivery opens one window; disabled delivery opens none', async t => {
  for (const enabled of [false, true]) {
    const h = harness(t, enabled); const delivered = await h.delivered();
    const rows = h.store.all('SELECT * FROM outcome_observation_windows');
    assert.equal(rows.length, enabled ? 1 : 0);
    if (enabled) {
      assert.equal(rows[0].opened_at, delivered.sent.created_at);
      assert.equal(rows[0].draft_id, delivered.draft_id);
      assert.equal(rows[0].decision_id, delivered.decision_id);
    }
    assert.equal(h.store.get('SELECT COUNT(*) n FROM contact_permissions').n, 1, 'only the explicitly granted permission');
    assert.equal(h.store.get("SELECT COUNT(*) n FROM delivery_attempts WHERE channel='telegram'").n, 0);
  }
});

test('overlapping windows keep distinct candidate identity and exact sent provenance', async t => {
  const h = harness(t); const p = await h.person();
  const a = h.sent(p.conversation_id, '2026-01-01T00:00:00.000Z');
  const b = h.sent(p.conversation_id, '2026-01-01T00:00:10.000Z');
  const reply = await h.message(p.conversation_id, 'Reply', '2026-01-01T00:00:20.000Z');
  h.service.outcomes.reconcile({ now: Date.parse('2026-01-01T00:00:30.000Z') });
  const rows = h.store.all('SELECT * FROM outcome_candidates');
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map(r => r.window_id)), new Set([a.id, b.id]));
  assert.ok(rows.every(r => r.source_message_id === reply));
  h.restart(); h.service.outcomes.reconcile({ now: Date.parse('2026-01-01T00:00:30.000Z') });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_candidates').n, 2);
});

test('bounded reconciliation advances across silent historical windows and survives restart', async t => {
  const h = harness(t); let answered;
  for (let i = 0; i < 11; i++) {
    const p = await h.person(); h.sent(p.conversation_id, '2026-01-01T00:00:00.000Z');
    if (i >= 5) answered = await h.message(p.conversation_id, 'Reply', '2026-01-01T00:00:10.000Z');
  }
  for (let i = 0; i < 6; i++) {
    const before = h.store.get('SELECT COUNT(*) n FROM outcome_candidates').n;
    h.service.outcomes.reconcile({ now: Date.parse('2026-01-01T00:00:30.000Z'), limit: 2 });
    assert.ok(h.store.get('SELECT COUNT(*) n FROM outcome_candidates').n - before <= 2);
    if (i === 1) h.restart();
  }
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_candidates').n, 6);
  assert.ok(h.store.get('SELECT id FROM outcome_candidates WHERE source_message_id=?', answered));
});

test('reconcile time and window deadline both bound a reply; positive control actually settles', async t => {
  const h = harness(t); const p = await h.person();
  await h.message(p.conversation_id, 'Earlier', '2025-12-31T00:00:00.000Z');
  const window = h.sent(p.conversation_id, '2026-01-01T00:00:00.000Z');
  await h.message(p.conversation_id, 'Future relative to pass', '2026-01-01T00:00:20.000Z');
  h.service.outcomes.reconcile({ now: Date.parse('2026-01-01T00:00:10.000Z') });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_candidates').n, 0);
  h.service.outcomes.reconcile({ now: Date.parse('2026-01-01T00:00:30.000Z') });
  assert.equal(h.store.get('SELECT outcome FROM outcome_observation_windows WHERE id=?', window.id).outcome, 'answered');
  const other = await h.person(); const late = h.sent(other.conversation_id, '2026-01-01T00:00:00.000Z');
  await h.message(other.conversation_id, 'After deadline', '2026-01-01T02:00:00.000Z');
  h.service.outcomes.reconcile({ now: Date.parse('2026-01-02T00:00:00.000Z') });
  assert.equal(h.store.get('SELECT outcome FROM outcome_observation_windows WHERE id=?', late.id).outcome, 'unknown');
});

test('real edited engagement draft derives one durable human-assisted association', async t => {
  const h = harness(t); const d = await h.delivered(true);
  await h.message(d.cid, 'Thanks'); h.service.outcomes.reconcile();
  const candidate = h.store.get('SELECT * FROM outcome_candidates WHERE conversation_id=?', d.cid);
  assert.ok(candidate, 'production path reached observation');
  const result = await h.command('outcome.candidate_confirm', { candidate_id: candidate.id, expected_revision: candidate.revision, kind: 'qualified', evidence: 'Owner verified qualification' });
  assert.equal(result.association, 'human_assisted');
  assert.equal(result.decision_id, d.decision_id);
  assert.equal(result.causal_credit, 'not_established');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM decision_outcomes').n, 1);
});

test('unknown coverage terminates once, counts once, and creates no false silence', async t => {
  const h = harness(t); const p = await h.person(); const w = h.sent(p.conversation_id, '2026-01-01T00:00:00.000Z');
  for (let i = 0; i < 4; i++) h.service.outcomes.reconcile({ now: Date.parse('2026-01-02T00:00:00.000Z') });
  const c = h.service.outcomes.coverage();
  assert.equal(c.windows, 1); assert.equal(c.unknown_windows, 1); assert.equal(c.pending_windows, 0);
  assert.equal(h.store.get('SELECT outcome FROM outcome_observation_windows WHERE id=?', w.id).outcome, 'unknown');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_candidates').n, 0);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='outcome.window_unknown'").n, 1);
});

test('observer failure is recovered from durable delivery intent without a second send', async t => {
  const h = harness(t); const observe = h.service.outcomes.observeSent;
  h.service.outcomes.observeSent = () => { throw new Error('observer failure'); };
  const delivered = await h.delivered();
  assert.equal(h.store.get('SELECT status FROM drafts WHERE id=?', delivered.draft_id).status, 'sent');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_observation_windows').n, 0);
  h.service.outcomes.observeSent = observe; h.restart(); h.service.outcomes.reconcile();
  const windows = h.store.all('SELECT * FROM outcome_observation_windows');
  assert.equal(windows.length, 1); assert.equal(windows[0].message_id, delivered.sent.id);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM delivery_attempts').n, 1);
});
