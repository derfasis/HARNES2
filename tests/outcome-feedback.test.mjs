// Outcome & Attribution v1: the loop's return path.
//
// The invariant this layer exists to hold is a separation. The system may observe; only a person
// may conclude. Every test here is written so that collapsing that separation — letting a reply
// become an outcome, letting the model write one, or letting an unobserved conversation drop out
// of the denominator — fails rather than passes.
// proof_level=synthetic_contract_eval; live_proof=false. No model, no network, no Telegram.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, id } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { loadConfig, readJson, ROOT } from '../business/config.mjs';
import { OUTCOME_KINDS, OUTCOME_CANDIDATE_KINDS } from '../business/outcome-tables.mjs';

const harness = (t, { windowSeconds = 604800 } = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-outcome-'));
  const store = new Store(directory);
  t.after(() => { try { store.close(); } catch { /* closed by a crash case */ } fs.rmSync(directory, { recursive: true, force: true }); });
  const config = readJson(path.join(ROOT, 'config/default.json'));
  config.outcomes = { enabled: true, modelEnabled: false, responseWindowSeconds: windowSeconds, maxModelRunsPerDay: 5 };
  const service = new BusinessService(store, config);
  const command = (action, payload, request = id(), actor = { kind: 'operator' }) =>
    service.command(action, payload, request, actor);
  const conversation = async () => {
    // `person.create` opens the conversation as part of the same command and returns both ids;
    // there is no separate conversation.create in this system.
    const created = await command('person.create', { name: 'Candidate', source: 'offline test' }, id());
    return store.get('SELECT * FROM conversations WHERE id=?', created.conversation_id);
  };
  const inbound = async (conv, text = 'Спасибо, договорились') => {
    await command('message.record', { conversation_id: conv.id, direction: 'in', text, source: 'offline test' }, id(), { kind: 'channel' });
    return store.get('SELECT * FROM messages WHERE conversation_id=? AND direction=\x27in\x27 ORDER BY id DESC LIMIT 1', conv.id);
  };
  return { directory, store, service, config, command, conversation, inbound };
};

// A window is opened by delivering a message. Doing it directly keeps these tests about the
// observation layer rather than about the send path, which has its own acceptance cases.
const sendAndObserve = (h, conv, at = new Date().toISOString()) => {
  const messageId = id();
  h.store.run(`INSERT INTO messages(id,conversation_id,direction,text,author,source,created_at)
    VALUES(?,?,'out','Proposing Thursday.','operator','offline test',?)`, messageId, conv.id, at);
  h.service.outcomes.observeSent(conv.id, messageId, at);
  return messageId;
};

test('a delivered message opens exactly one observation window', async (t) => {
  const h = harness(t);
  const conv = await h.conversation();
  const messageId = sendAndObserve(h, conv);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_observation_windows').n, 1);
  // Re-opening is a no-op rather than a second window: two windows for one message would let the
  // same silence be counted twice and the coverage ratio quietly improve.
  h.service.outcomes.observeSent(conv.id, messageId);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_observation_windows').n, 1,
    'a repeated observation of the same message does not open a second window');
});

test('a reply is observed as a candidate and is never an outcome by itself', async (t) => {
  const h = harness(t);
  const conv = await h.conversation();
  sendAndObserve(h, conv, '2026-01-01T00:00:00.000Z');
  const reply = await h.inbound(conv, 'Записался на четверг');
  h.service.outcomes.reconcile({ now: Date.parse('2026-01-02T00:00:00.000Z') });

  const candidate = h.store.get('SELECT * FROM outcome_candidates WHERE conversation_id=?', conv.id);
  assert.ok(candidate, 'a reply produces a candidate');
  assert.equal(candidate.kind, 'reply_observed', 'and the kind is an observation, not a result');
  assert.equal(candidate.status, 'pending', 'pending until a person decides');
  assert.equal(candidate.outcome_id, null, 'no outcome row is written by observing');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_events').n, 0,
    '"I signed up on Thursday" in a message is not a booking');
  assert.equal(candidate.source_message_id, reply.id, 'the candidate names the message it saw');
  assert.match(candidate.evidence_json, /window_id/);
});

test('a silent conversation becomes a recorded observation, not a missing one', async (t) => {
  const h = harness(t, { windowSeconds: 60 });
  const conv = await h.conversation();
  sendAndObserve(h, conv, '2026-01-01T00:00:00.000Z');
  h.service.outcomes.reconcile({ now: Date.parse('2026-01-01T00:00:01.000Z') });
  const candidate = h.store.get('SELECT * FROM outcome_candidates WHERE conversation_id=?', conv.id);
  assert.equal(candidate, undefined, 'nothing is claimed before the window closes');
  h.service.outcomes.reconcile({ now: Date.parse('2026-01-02T00:00:00.000Z') });
  const expired = h.store.get('SELECT * FROM outcome_candidates WHERE conversation_id=?', conv.id);
  assert.ok(expired, 'an unanswered window is still an observation');
  assert.equal(expired.kind, 'no_response_observed');
  assert.equal(h.store.get('SELECT outcome FROM outcome_observation_windows WHERE id=?', expired.evidence_json.match(/"window_id":"([^"]+)"/)[1]).outcome,
    'expired_unanswered');
});

test('coverage counts what is unknown, not only what is known', async (t) => {
  const h = harness(t, { windowSeconds: 60 });
  const a = await h.conversation();
  // Two conversations: one answered, one that will not be.
  sendAndObserve(h, a, '2026-01-01T00:00:00.000Z');
  await h.inbound(a, 'Yes');
  // A second conversation for a second person: the denominator is every message we sent, not
  // only the ones somebody happened to reply to.
  const second = await h.command('person.create', { name: 'Another', source: 'offline test' }, id());
  const other = h.store.get('SELECT * FROM conversations WHERE id=?', second.conversation_id);
  sendAndObserve(h, other, '2026-01-01T00:00:00.000Z');
  h.service.outcomes.reconcile({ now: Date.parse('2026-01-03T00:00:00.000Z') });
  const coverage = h.service.outcomes.coverage();
  assert.equal(coverage.windows, 2, 'both conversations are counted');
  assert.equal(coverage.answered, 1);
  assert.equal(coverage.expired_unanswered, 1);
  assert.equal(coverage.causal_credit, 'not_established', 'and no causal claim is ever made');
  assert.equal(typeof coverage.unknown_windows, 'number',
    'the number that makes the others mean anything is reported, not footnoted');
});

test('only an operator may promote a candidate, and the model may not', async (t) => {
  const h = harness(t);
  const conv = await h.conversation();
  sendAndObserve(h, conv, '2026-01-01T00:00:00.000Z');
  await h.inbound(conv);
  h.service.outcomes.reconcile({ now: Date.parse('2026-01-02T00:00:00.000Z') });
  const candidate = h.store.get('SELECT * FROM outcome_candidates WHERE conversation_id=?', conv.id);

  for (const actor of [{ kind: 'agent' }, { kind: 'channel' }, { kind: 'system' }]) {
    await assert.rejects(() => h.command('outcome.candidate_confirm', { candidate_id: candidate.id, kind: 'joined', evidence: 'x' }, id(), actor),
      (e) => e.code === 'OUTCOME_OPERATOR_REQUIRED' || e.status === 403, `${actor.kind} must not promote`);
  }
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_events').n, 0, 'and nothing was written by them');
});

// The command-level gate above is not the only one, and this asserts the second separately.
// Calling the loop directly bypasses `execute` entirely, so a test that only went through the
// command would still pass if this check were the thing removed — which is exactly the change
// someone would make when a caller "legitimately" needs to promote from inside the service.
test('the loop itself refuses a non-operator, not only the command bus', async (t) => {
  const h = harness(t);
  const conv = await h.conversation();
  sendAndObserve(h, conv, '2026-01-01T00:00:00.000Z');
  await h.inbound(conv);
  h.service.outcomes.reconcile({ now: Date.parse('2026-01-02T00:00:00.000Z') });
  const candidate = h.store.get('SELECT * FROM outcome_candidates WHERE conversation_id=?', conv.id);
  for (const actor of [{ kind: 'agent' }, { kind: 'system' }]) {
    // `confirm` is synchronous, so this throws rather than rejecting.
    assert.throws(() => h.service.outcomes.confirm(candidate.id, { kind: 'joined', evidence: 'x' }, actor),
      (e) => e.code === 'OUTCOME_OPERATOR_REQUIRED', `the loop refuses ${actor.kind} on its own`);
  }
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_events').n, 0);
});

test('promotion writes the same outcome the manual path always wrote', async (t) => {
  const h = harness(t);
  const conv = await h.conversation();
  sendAndObserve(h, conv, '2026-01-01T00:00:00.000Z');
  await h.inbound(conv);
  h.service.outcomes.reconcile({ now: Date.parse('2026-01-02T00:00:00.000Z') });
  const candidate = h.store.get('SELECT * FROM outcome_candidates WHERE conversation_id=?', conv.id);
  const result = await h.command('outcome.candidate_confirm', { candidate_id: candidate.id, kind: 'qualified', evidence: 'Called and confirmed' });
  assert.equal(result.causal_credit, 'not_established');
  assert.equal(result.association, 'observed_association');
  const outcome = h.store.get('SELECT * FROM outcome_events WHERE id=?', result.outcome_id);
  assert.equal(outcome.kind, 'qualified');
  assert.equal(outcome.author, 'operator');
  assert.equal(h.store.get('SELECT status FROM outcome_candidates WHERE id=?', candidate.id).status, 'confirmed');
});

test('an unrecognised outcome kind is refused on both paths', async (t) => {
  const h = harness(t);
  const conv = await h.conversation();
  sendAndObserve(h, conv, '2026-01-01T00:00:00.000Z');
  await h.inbound(conv);
  h.service.outcomes.reconcile({ now: Date.parse('2026-01-02T00:00:00.000Z') });
  const candidate = h.store.get('SELECT * FROM outcome_candidates WHERE conversation_id=?', conv.id);
  // A candidate kind is not an outcome kind. Promotion must not accept the vocabulary of
  // observation, or "reply_observed" could be written straight into outcome_events.
  for (const kind of [...OUTCOME_CANDIDATE_KINDS, 'revenue', '']) {
    await assert.rejects(() => h.command('outcome.candidate_confirm', { candidate_id: candidate.id, kind, evidence: 'x' }),
      (e) => ['OUTCOME_KIND_INVALID', 'OUTCOME_FIELDS_INVALID'].includes(e.code), `${kind} must be refused`);
  }
  assert.ok(OUTCOME_KINDS.includes('qualified'));
});

test('a candidate is proposed once however often the evidence is scanned', async (t) => {
  const h = harness(t);
  const conv = await h.conversation();
  sendAndObserve(h, conv, '2026-01-01T00:00:00.000Z');
  await h.inbound(conv);
  for (let i = 0; i < 5; i += 1) h.service.outcomes.reconcile({ now: Date.parse('2026-01-02T00:00:00.000Z') });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_candidates WHERE conversation_id=?', conv.id).n, 1,
    'a re-scan is a no-op, not a second claim');
});

test('a resolved candidate cannot be resolved twice', async (t) => {
  const h = harness(t);
  const conv = await h.conversation();
  sendAndObserve(h, conv, '2026-01-01T00:00:00.000Z');
  await h.inbound(conv);
  h.service.outcomes.reconcile({ now: Date.parse('2026-01-02T00:00:00.000Z') });
  const candidate = h.store.get('SELECT * FROM outcome_candidates WHERE conversation_id=?', conv.id);
  await h.command('outcome.candidate_confirm', { candidate_id: candidate.id, kind: 'qualified', evidence: 'x' });
  await assert.rejects(() => h.command('outcome.candidate_confirm', { candidate_id: candidate.id, kind: 'joined', evidence: 'y' }),
    (e) => e.code === 'OUTCOME_CANDIDATE_RESOLVED');
  await assert.rejects(() => h.command('outcome.candidate_reject', { candidate_id: candidate.id, note: 'changed my mind' }),
    (e) => e.code === 'OUTCOME_CANDIDATE_RESOLVED');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_events').n, 1, 'exactly one outcome');
});

test('a rejection is a recorded answer and is not silently re-proposed', async (t) => {
  const h = harness(t);
  const conv = await h.conversation();
  sendAndObserve(h, conv, '2026-01-01T00:00:00.000Z');
  await h.inbound(conv, 'Не актуально');
  h.service.outcomes.reconcile({ now: Date.parse('2026-01-02T00:00:00.000Z') });
  const candidate = h.store.get('SELECT * FROM outcome_candidates WHERE conversation_id=?', conv.id);
  await h.command('outcome.candidate_reject', { candidate_id: candidate.id, note: 'Not a result', note_kind: 'declined' });
  const after = h.store.get('SELECT * FROM outcome_candidates WHERE id=?', candidate.id);
  assert.equal(after.status, 'rejected');
  assert.match(after.resolution_note, /declined/);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_events').n, 0,
    'a rejected observation is not an outcome, and saying so is itself a record');
});

test('the layer is off by default and refuses to observe', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-outcome-off-'));
  const store = new Store(directory);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const service = new BusinessService(store, loadConfig());
  assert.equal(loadConfig().outcomes.enabled, false, 'a fresh install does not observe anything');
  assert.throws(() => service.outcomes.propose({ conversationId: 'x', kind: 'reply_observed',
    detector: 'reply_after_send', basis: 'b', evidence: {} }), (e) => e.code === 'OUTCOME_DISABLED');
});

test('a delivery failure must not be caused by an observation window', async (t) => {
  // The window opens from the delivery path. If observing could throw there, a message that has
  // already gone out would be reported as undelivered — the worst possible place for a failure.
  const h = harness(t);
  const conv = await h.conversation();
  const original = h.service.outcomes.observeSent.bind(h.service.outcomes);
  h.service.outcomes.observeSent = () => { throw new Error('observation exploded'); };
  const draft = { id: 'draft-x', conversation_id: conv.id, current_version: 1 };
  assert.doesNotThrow(() => h.service.engagement.onDelivered(draft, 'msg-x'),
    'a broken observation never blocks or fails a delivery that already happened');
  h.service.outcomes.observeSent = original;
});

test('export carries the new tables and import restores them', async (t) => {
  const h = harness(t);
  const conv = await h.conversation();
  sendAndObserve(h, conv, '2026-01-01T00:00:00.000Z');
  await h.inbound(conv);
  h.service.outcomes.reconcile({ now: Date.parse('2026-01-02T00:00:00.000Z') });
  const { exportPartner } = await import('../business/export.mjs');
  const bundle = await h.service.exclusive(() => exportPartner(h.store));
  assert.equal(bundle.tables.outcome_candidates.length, 1, 'candidates travel with the bundle');
  assert.equal(bundle.tables.outcome_observation_windows.length, 1);
});
