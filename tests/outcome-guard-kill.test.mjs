// Black-box outcome guard contracts. No model, network or Telegram activity.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, id } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { readJson, ROOT } from '../business/config.mjs';

const OPEN = '2026-01-01T00:00:00.000Z';
const REPLY = '2026-01-01T00:00:20.000Z';
const AFTER = Date.parse('2026-01-02T00:00:00.000Z');
const operator = { kind: 'operator' };

const harness = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-guard-'));
  const config = readJson(path.join(ROOT, 'config/default.json'));
  config.engagement.enabled = true;
  config.outcomes = { enabled: true, responseWindowSeconds: 3600 };
  let store = new Store(directory);
  t.after(() => { try { store.close(); } catch { /* a case closed it */ } fs.rmSync(directory, { recursive: true, force: true }); });
  let service = new BusinessService(store, config);
  const command = (action, payload, request = id(), actor = operator) => service.command(action, payload, request, actor);
  const h = {
    directory, get store() { return store; }, get service() { return service; }, command, operator,
    restart() {
      store.close();
      store = new Store(directory);
      store.recover();
      service = new BusinessService(store, config);
      return store;
    },
    person: () => command('person.create', { name: 'Guard', source: 'offline fixture' }),
    inbound: (cid, text = 'Reply', at = REPLY) =>
      command('message.record', { conversation_id: cid, text, source: 'offline owner attestation', occurred_at: at }),
    async delivered(cid = null, at = OPEN) {
      if (!cid) cid = (await h.person()).conversation_id;
      const incoming = await h.inbound(cid, 'Please answer', OPEN);
      const engagement = service.engagement.current(cid);
      if (!store.get('SELECT id FROM contact_permissions WHERE conversation_id=? AND revoked_at IS NULL', cid)) {
        await command('permission.grant', { conversation_id: cid, purpose: 'reply', granted_by: 'owner',
          evidence: 'Explicit synthetic permission', valid_from: '2020-01-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' });
      }
      const decision = await command('decision.commit', { engagement_id: engagement.id,
        expected_revision: service.engagement.get(engagement.id).revision, kind: 'ACT',
        reason: 'Answer explicit request', expected_next: 'An observed reply',
        evidence: [{ type: 'message', id: incoming.message_id }],
        action: { purpose: 'reply', text: 'Synthetic answer.' } });
      await command('draft.approve', { draft_id: decision.draft_id });
      await command('delivery.manual', { draft_id: decision.draft_id, evidence: 'Owner verified offline delivery', occurred_at: at });
      const sent = store.get('SELECT * FROM messages WHERE draft_id=?', decision.draft_id);
      const window = store.get('SELECT * FROM outcome_observation_windows WHERE message_id=?', sent.id);
      assert.ok(window, 'positive control: actual delivery reached the observer');
      return { cid, sent, window };
    },
  };
  return h;
};

// 1. Coverage is proved, never declared. Letting a caller assert `continuous` at window creation is
// exactly how a silence nobody vouched for becomes a fact about a conversation.
test('a window cannot declare its own coverage', async t => {
  const h = harness(t), d = await h.delivered();
  assert.equal(d.window.coverage, 'unverified', 'a window starts unverified, because nobody has said otherwise yet');
  const proofsBefore = h.store.get("SELECT COUNT(*) n FROM events WHERE kind='outcome.coverage_attested'").n;
  assert.throws(() => h.service.outcomes.observeSent(d.cid, d.sent.id, OPEN, 'continuous'),
    (e) => e.code === 'OUTCOME_COVERAGE_PROOF_REQUIRED',
    'the coverage flag cannot be asserted at opening; it is proved separately or not at all');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_observation_windows WHERE message_id=?', d.sent.id).n, 1,
    'refusing a fake declaration does not disturb the existing window');
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='outcome.coverage_attested'").n, proofsBefore,
    'refusing a fake declaration creates no proof');

  // Canonical delivery observation may be durable before the asynchronous window observer runs.
  // That real outbound is still unobserved until recovery opens the window, and cannot carry a
  // caller-supplied continuous claim either.
  const unobserved = id();
  h.store.run('INSERT INTO messages(id,conversation_id,direction,author,text,external_id,source,created_at) VALUES(?,?,?,?,?,?,?,?)',
    unobserved, d.cid, 'out', 'operator', 'real delivery pending observation', id(), 'offline fixture', OPEN);
  h.service.outcomes.deliveryIntent(d.cid, unobserved);
  assert.throws(() => h.service.outcomes.observeSent(d.cid, unobserved, OPEN, 'continuous'),
    e => e.code === 'OUTCOME_COVERAGE_PROOF_REQUIRED');
  assert.equal(h.store.get('SELECT id FROM outcome_observation_windows WHERE message_id=?', unobserved), undefined,
    'the unobserved real outbound still has no fabricated window');
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='outcome.coverage_attested'").n, proofsBefore,
    'the rejected recovery attempt leaves the proof ledger unchanged');
});

// 3. A settled window keeps the answer it already has. Rescanning adds nothing, so one reply cannot
// become two claims however many passes run afterwards.
test('a settled window keeps its single answer under rescanning', async t => {
  const h = harness(t), d = await h.delivered();
  await h.inbound(d.cid, 'An answer', REPLY);
  await h.service.outcomes.reconcile({ now: AFTER });
  assert.equal(h.store.all('SELECT id FROM outcome_candidates WHERE window_id=?', d.window.id).length, 1,
    'the reply settled the window once');
  await h.service.outcomes.reconcile({ now: AFTER });
  await h.service.outcomes.reconcile({ now: AFTER });
  assert.equal(h.store.all('SELECT id FROM outcome_candidates WHERE window_id=?', d.window.id).length, 1,
    'and rescanning it repeatedly leaves exactly one answer');
});

test('window deadlines must be strictly later than opening, and a later deadline is accepted', async t => {
  const h = harness(t), d = await h.delivered();
  const makeOutbound = at => {
    const messageId = id();
    h.store.run('INSERT INTO messages(id,conversation_id,direction,author,text,external_id,source,created_at) VALUES(?,?,?,?,?,?,?,?)',
      messageId, d.cid, 'out', 'operator', 'deadline boundary fixture', id(), 'offline fixture', at);
    return messageId;
  };
  for (const [label, deadline] of [['earlier', '2025-12-31T23:59:59.999Z'], ['equal', OPEN]]) {
    const messageId = makeOutbound(OPEN);
    const beforeWindows = h.store.get('SELECT COUNT(*) n FROM outcome_observation_windows').n;
    const beforeEvents = h.store.get("SELECT COUNT(*) n FROM events WHERE kind='outcome.window_opened'").n;
    assert.throws(() => h.service.outcomes.observeSent(d.cid, messageId, OPEN, 'unverified', deadline),
      e => e.code === 'OUTCOME_WINDOW_TIME_INVALID', `${label} deadline is refused`);
    assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_observation_windows').n, beforeWindows,
      `${label} deadline writes no window`);
    assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='outcome.window_opened'").n, beforeEvents,
      `${label} deadline writes no window-open event`);
  }
  const acceptedId = makeOutbound(OPEN);
  const accepted = h.service.outcomes.observeSent(d.cid, acceptedId, OPEN, 'unverified', REPLY);
  assert.equal(h.store.get('SELECT closes_at FROM outcome_observation_windows WHERE id=?', accepted).closes_at, REPLY,
    'a strictly later deadline opens the window');
});

test('only outcome.coverage_attest by an operator can create a coverage proof', async t => {
  const h = harness(t), d = await h.delivered();
  const payload = { window_id: d.window.id, covered_from: d.window.opened_at,
    covered_through: d.window.closes_at, evidence: 'Owner reviewed the complete synthetic interval' };
  const proofCount = () => h.store.get("SELECT COUNT(*) n FROM events WHERE kind='outcome.coverage_attested'").n;
  const before = proofCount();
  for (const actor of [{ kind: 'agent' }, { kind: 'channel' }, { kind: 'system' }]) {
    await assert.rejects(() => h.command('outcome.coverage_attest', payload, id(), actor), e => e.status === 403,
      `${actor.kind} cannot attest continuous coverage`);
  }
  assert.equal(proofCount(), before, 'non-operator refusals create no proof event');
  assert.equal(h.store.get('SELECT coverage FROM outcome_observation_windows WHERE id=?', d.window.id).coverage, 'unverified');
  const result = await h.command('outcome.coverage_attest', payload);
  assert.ok(result.coverage_event_id, 'operator command returns the proof event id');
  assert.equal(h.store.get("SELECT actor FROM events WHERE id=? AND kind='outcome.coverage_attested'", result.coverage_event_id).actor, 'operator');
  assert.equal(h.store.get('SELECT coverage FROM outcome_observation_windows WHERE id=?', d.window.id).coverage, 'continuous');
  const proof = h.service.outcomes.coverageProof(h.store.get('SELECT * FROM outcome_observation_windows WHERE id=?', d.window.id));
  assert.equal(proof.id, result.coverage_event_id, 'the persisted event actually validates as the interval proof');
  assert.equal(JSON.parse(proof.payload_json).proof_level, 'owner_attested_interval');
});

test('attestation accepts pending and unknown windows as positive controls', async t => {
  const h = harness(t), pending = await h.delivered();
  const attest = async window => h.command('outcome.coverage_attest', { window_id: window.id,
    covered_from: window.opened_at, covered_through: window.closes_at, evidence: 'Owner reviewed complete interval' });
  const pendingResult = await attest(pending.window);
  assert.ok(pendingResult.coverage_event_id);
  assert.equal(h.store.get('SELECT outcome FROM outcome_observation_windows WHERE id=?', pending.window.id).outcome, 'pending');

  const unknown = await h.delivered();
  await h.service.outcomes.reconcile({ now: Date.parse(unknown.window.closes_at) + 1 });
  const unknownWindow = h.store.get('SELECT * FROM outcome_observation_windows WHERE id=?', unknown.window.id);
  assert.equal(unknownWindow.outcome, 'unknown');
  const unknownResult = await attest(unknownWindow);
  assert.ok(unknownResult.coverage_event_id);
  assert.equal(h.store.get('SELECT outcome FROM outcome_observation_windows WHERE id=?', unknown.window.id).outcome, 'pending');
});

for (const closesAt of [OPEN, '2025-12-31T23:59:59.999Z']) test(`corrupt persisted close ${closesAt} is quarantined without starving healthy work or resurrecting after restart`, async t => {
  const h = harness(t);
  const bad = await h.delivered();
  const good = await h.delivered();
  await h.inbound(good.cid, 'A timely reply', REPLY);
  h.store.run('UPDATE outcome_observation_windows SET closes_at=? WHERE id=?', closesAt, bad.window.id);

  // Visit both windows with a one-item bound, regardless of randomized UUID ordering.
  for (let i = 0; i < 4; i += 1) {
    const pass = h.service.outcomes.reconcile({ now: AFTER, limit: 1 });
    assert.ok(pass.scanned <= 1, 'the pass respects the requested window bound');
  }
  const quarantine = h.store.get("SELECT payload_json FROM events WHERE kind='outcome.window_quarantined' AND json_extract(payload_json,'$.window_id')=?", bad.window.id);
  assert.ok(quarantine, 'the invalid persisted window is quarantined');
  assert.equal(JSON.parse(quarantine.payload_json).reason, 'OUTCOME_WINDOW_TIME_INVALID');
  assert.equal(h.store.get('SELECT outcome FROM outcome_observation_windows WHERE id=?', bad.window.id).outcome, 'superseded');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_candidates WHERE window_id=?', bad.window.id).n, 0,
    'invalid timing cannot manufacture a candidate');
  assert.equal(h.store.get('SELECT outcome FROM outcome_observation_windows WHERE id=?', good.window.id).outcome, 'answered',
    'the adjacent healthy conversation still produces a valid answer');
  assert.ok(h.store.get('SELECT id FROM outcome_candidates WHERE window_id=? AND kind=\'reply_observed\'', good.window.id));
  const cursorBeforeRestart = h.store.get("SELECT cursor FROM channel_offsets WHERE channel='outcome-observation-v2'").cursor;
  assert.ok(cursorBeforeRestart, 'bounded work persisted its cursor');

  const restarted = h.restart();
  for (let i = 0; i < 3; i += 1) h.service.outcomes.reconcile({ now: Date.parse('2026-01-03T00:00:00.000Z'), limit: 1 });
  assert.equal(restarted.get('SELECT outcome FROM outcome_observation_windows WHERE id=?', bad.window.id).outcome, 'superseded',
    'restart and later passes do not resurrect the invalid window');
  assert.equal(restarted.get('SELECT COUNT(*) n FROM outcome_candidates WHERE window_id=?', bad.window.id).n, 0);
  assert.equal(restarted.get("SELECT COUNT(*) n FROM events WHERE kind='outcome.window_quarantined' AND json_extract(payload_json,'$.window_id')=?", bad.window.id).n, 1,
    'restart does not repeatedly quarantine a terminal window');
  assert.equal(restarted.get('SELECT COUNT(*) n FROM outcome_candidates WHERE window_id=?', good.window.id).n, 1,
    'the healthy observation remains unique after recovery');
  const proofs = restarted.get("SELECT COUNT(*) n FROM events WHERE kind='outcome.coverage_attested'").n;
  await assert.rejects(() => h.command('outcome.coverage_attest', { window_id: bad.window.id,
    covered_from: bad.window.opened_at, covered_through: bad.window.closes_at, evidence: 'A terminal quarantine cannot be reopened' }),
  e => e.code === 'OUTCOME_WINDOW_RESOLVED');
  assert.equal(restarted.get("SELECT COUNT(*) n FROM events WHERE kind='outcome.coverage_attested'").n, proofs);
  assert.equal(restarted.get('SELECT outcome FROM outcome_observation_windows WHERE id=?', bad.window.id).outcome, 'superseded');
});

test('coverage attestation refuses resolved windows without side effects', async t => {
  const h = harness(t), answered = await h.delivered();
  await h.inbound(answered.cid, 'Answer', REPLY);
  h.service.outcomes.reconcile({ now: Date.parse(REPLY) });
  const answeredWindow = h.store.get('SELECT * FROM outcome_observation_windows WHERE id=?', answered.window.id);
  assert.equal(answeredWindow.outcome, 'answered');
  const snapshot = () => ({
    proofs: h.store.get("SELECT COUNT(*) n FROM events WHERE kind='outcome.coverage_attested'").n,
    candidates: h.store.get('SELECT COUNT(*) n FROM outcome_candidates WHERE window_id=?', answered.window.id).n,
    window: h.store.get('SELECT coverage,coverage_event_id,outcome,candidate_id FROM outcome_observation_windows WHERE id=?', answered.window.id),
  });
  const before = snapshot();
  await assert.rejects(() => h.command('outcome.coverage_attest', { window_id: answered.window.id,
    covered_from: answeredWindow.opened_at, covered_through: answeredWindow.closes_at, evidence: 'Late attestation' }),
  e => e.code === 'OUTCOME_WINDOW_RESOLVED');
  assert.deepEqual(snapshot(), before, 'answered-window refusal writes no proof, candidate or window change');

  const expired = await h.delivered();
  await h.command('outcome.coverage_attest', { window_id: expired.window.id, covered_from: expired.window.opened_at,
    covered_through: expired.window.closes_at, evidence: 'Owner reviewed complete interval' });
  h.service.outcomes.reconcile({ now: Date.parse(expired.window.closes_at) + 1 });
  const expiredWindow = h.store.get('SELECT * FROM outcome_observation_windows WHERE id=?', expired.window.id);
  assert.equal(expiredWindow.outcome, 'expired_unanswered');
  const proofCount = h.store.get("SELECT COUNT(*) n FROM events WHERE kind='outcome.coverage_attested'").n;
  await assert.rejects(() => h.command('outcome.coverage_attest', { window_id: expired.window.id,
    covered_from: expiredWindow.opened_at, covered_through: expiredWindow.closes_at, evidence: 'Second attestation',
    expected_coverage_event_id: expiredWindow.coverage_event_id }),
  e => e.code === 'OUTCOME_WINDOW_RESOLVED');
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='outcome.coverage_attested'").n, proofCount);
  assert.equal(h.store.get('SELECT outcome FROM outcome_observation_windows WHERE id=?', expired.window.id).outcome, 'expired_unanswered');
});
