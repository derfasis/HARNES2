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
import { loadConfig, readJson, ROOT, validateOutcomes } from '../business/config.mjs';
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
  // `at` is set explicitly because a window only counts a reply that arrived while it was open:
  // `message.record` stamps the real clock, which in a fixture would place every reply decades
  // after the window closed, and every assertion about observing a reply would assert nothing.
  const inbound = async (conv, text = 'Спасибо, договорились', at = null) => {
    await command('message.record', { conversation_id: conv.id, direction: 'in', text, source: 'offline test' }, id(), { kind: 'channel' });
    const message = store.get("SELECT * FROM messages WHERE conversation_id=? AND direction='in' ORDER BY id DESC LIMIT 1", conv.id);
    if (at) store.run('UPDATE messages SET created_at=? WHERE id=?', at, message.id);
    return store.get('SELECT * FROM messages WHERE id=?', message.id);
  };
  return { directory, store, service, config, command, conversation, inbound };
};

// A window is opened by delivering a message. Doing it directly keeps these tests about the
// observation layer rather than about the send path, which has its own acceptance cases.
// `coverage` is explicit because a window may only assert silence when the transport vouched for
// the whole interval. Tests about observing a silence pass `continuous`; the test about what
// happens when it did not is the one that must omit it.
const sendAndObserve = (h, conv, at = new Date().toISOString(), coverage = 'continuous') => {
  const messageId = id();
  h.store.run(`INSERT INTO messages(id,conversation_id,direction,text,author,source,created_at)
    VALUES(?,?,'out','Proposing Thursday.','operator','offline test',?)`, messageId, conv.id, at);
  h.service.outcomes.observeSent(conv.id, messageId, at, coverage);
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
  const reply = await h.inbound(conv, 'Спасибо', '2026-01-01T12:00:00.000Z');
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
  await h.inbound(a, 'Yes', '2026-01-01T00:00:30.000Z');
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
  await h.inbound(conv, 'Спасибо', '2026-01-01T12:00:00.000Z');
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
  await h.inbound(conv, 'Спасибо', '2026-01-01T12:00:00.000Z');
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
  await h.inbound(conv, 'Спасибо', '2026-01-01T12:00:00.000Z');
  h.service.outcomes.reconcile({ now: Date.parse('2026-01-02T00:00:00.000Z') });
  const candidate = h.store.get('SELECT * FROM outcome_candidates WHERE conversation_id=?', conv.id);
  const result = await h.command('outcome.candidate_confirm', { candidate_id: candidate.id, kind: 'qualified', evidence: 'Called and confirmed' });
  assert.equal(result.causal_credit, 'not_established');
  // No decision was named, so there is no association to report. Returning a value here would be
  // an answer to a question nobody asked.
  assert.equal(result.association, null);
  assert.equal(result.causal_credit, 'not_established');
  const outcome = h.store.get('SELECT * FROM outcome_events WHERE id=?', result.outcome_id);
  assert.equal(outcome.kind, 'qualified');
  assert.equal(outcome.author, 'operator');
  assert.equal(h.store.get('SELECT status FROM outcome_candidates WHERE id=?', candidate.id).status, 'confirmed');
});

test('an unrecognised outcome kind is refused on both paths', async (t) => {
  const h = harness(t);
  const conv = await h.conversation();
  sendAndObserve(h, conv, '2026-01-01T00:00:00.000Z');
  await h.inbound(conv, 'Спасибо', '2026-01-01T12:00:00.000Z');
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
  await h.inbound(conv, 'Спасибо', '2026-01-01T12:00:00.000Z');
  for (let i = 0; i < 5; i += 1) h.service.outcomes.reconcile({ now: Date.parse('2026-01-02T00:00:00.000Z') });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_candidates WHERE conversation_id=?', conv.id).n, 1,
    'a re-scan is a no-op, not a second claim');
});

test('a resolved candidate cannot be resolved twice', async (t) => {
  const h = harness(t);
  const conv = await h.conversation();
  sendAndObserve(h, conv, '2026-01-01T00:00:00.000Z');
  await h.inbound(conv, 'Спасибо', '2026-01-01T12:00:00.000Z');
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
  await h.inbound(conv, 'Спасибо', '2026-01-01T12:00:00.000Z');
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

test('export carries the observation tables', async (t) => {
  const h = harness(t);
  const conv = await h.conversation();
  sendAndObserve(h, conv, '2026-01-01T00:00:00.000Z');
  await h.inbound(conv, 'Спасибо', '2026-01-01T12:00:00.000Z');
  h.service.outcomes.reconcile({ now: Date.parse('2026-01-02T00:00:00.000Z') });
  const { exportPartner } = await import('../business/export.mjs');
  const bundle = await h.service.exclusive(() => exportPartner(h.store));
  assert.equal(bundle.tables.outcome_candidates.length, 1, 'candidates travel with the bundle');
  assert.equal(bundle.tables.outcome_observation_windows.length, 1);
});

test('a rate that improved by recording less is visible as such', async (t) => {
  const h = harness(t, { windowSeconds: 60 });
  // Ten messages go out, two are answered. The cost-per-outcome will look excellent; the
  // coverage figure is what says that eight conversations were never observed at all.
  for (let i = 0; i < 10; i += 1) {
    const person = h.store.get('SELECT * FROM persons LIMIT 1');
    const created = await h.command('person.create', { name: `C${i}`, source: 'offline test' }, id());
    const conv = h.store.get('SELECT * FROM conversations WHERE id=?', created.conversation_id);
    void person;
    sendAndObserve(h, conv, '2026-01-01T00:00:00.000Z');
    if (i < 2) await h.inbound(conv, 'Спасибо', '2026-01-01T00:00:30.000Z');
  }
  h.service.outcomes.reconcile({ now: Date.parse('2026-01-03T00:00:00.000Z') });
  const metrics = h.service.metrics();
  assert.equal(metrics.outcome_coverage.windows, 10, 'every message is in the denominator');
  assert.equal(metrics.outcome_coverage.answered, 2);
  assert.equal(metrics.outcome_coverage.expired_unanswered, 8);
  assert.equal(metrics.outcome_coverage.unknown_windows, 0,
    'nothing is left uncounted once every window has been settled');
  // The headline: how much of what we sent we still cannot say anything about.
  assert.ok(metrics.outcome_coverage.windows >= metrics.outcome_coverage.answered,
    'coverage is reported next to the rates, not instead of them');
});

// The review is right that reading the source is not the same as reaching the endpoint: a test
// that greps the file passes while the route answers 404. These two routes were nested inside the
// /api/discovery/ block, where nothing could reach them, and only a real request shows that.
test('the review endpoints answer, and carry the denominator', async (t) => {
  const h = harness(t);
  h.config.scheduler.enabled = false;
  h.config.server = { ...h.config.server, port: 0 };
  const { start } = await import('../business/server.mjs');
  const app = await start({ config: h.config, directory: h.directory });
  let closed = false;
  try {
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const { token } = await (await fetch(`${origin}/api/session`)).json();
    const headers = { 'x-partner-token': token };

    // The pending candidate, made pending by an actual reply.
    const conv = await h.conversation();
    sendAndObserve(h, conv, '2026-01-01T00:00:00.000Z');
    await h.inbound(conv, 'Спасибо', '2026-01-01T12:00:00.000Z');
    h.service.outcomes.reconcile({ now: Date.parse('2026-01-02T00:00:00.000Z') });

    assert.equal((await fetch(`${origin}/api/outcomes`)).status, 403, 'unauthenticated reads are refused');
    const list = await (await fetch(`${origin}/api/outcomes`, { headers })).json();
    assert.ok(Array.isArray(list.items), 'the list answers with a list');
    assert.equal(list.items.length, 1, 'and the pending candidate is in it');
    assert.equal(typeof list.coverage.windows, 'number',
      'the list cannot show a flattering subset without its denominator');
    const one = await (await fetch(`${origin}/api/outcomes/${list.items[0].id}`, { headers })).json();
    assert.equal(one.kind, 'reply_observed');
    assert.equal(one.status, 'pending');
  } finally {
    // The directory is left to the harness teardown: the store still holds its files here, and
    // removing them underneath it fails on Windows.
    await app.close();
    closed = true;
  }
  assert.equal(closed, true, 'the server was closed before its directory went away');
});
test('the review endpoints are wired outside any other route prefix', async (t) => {
  const source = fs.readFileSync(new URL('../business/server.mjs', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf("if (url.pathname.startsWith('/api/discovery/'))"));
  const outcomes = source.indexOf("/api/outcomes')");
  assert.ok(outcomes > 0, 'the outcome routes exist');
  assert.ok(outcomes < source.indexOf("/api/discovery/'))"),
    'and they are declared before the discovery block, not inside it');
  assert.ok(!block.slice(0, block.indexOf("/api/discovery/reason-states")).includes("/api/outcomes"),
    'no outcome route is reachable only through the discovery prefix');
  // The list carries the denominator beside the items, so a page of candidates cannot be read as
  // "this is everything" while a conversation nobody answered stays invisible.
  const listRoute = source.slice(source.indexOf("url.pathname === '/api/outcomes'"), source.indexOf("url.pathname === '/api/outcomes'") + 320);
  assert.ok(listRoute.includes('coverage: service.outcomes.coverage()'),
    'the list response includes coverage');
});

// Promoting a candidate must go through the same writer the manual path uses. An earlier version
// inserted the row itself, which skipped everything around the insert — so a candidate confirmed
// as `joined` left the conversation AI-owned, the stage unmoved, and the engagement still live.
// The row existing is not the same as the result having been acted on.
test('a promoted candidate does everything a manually recorded outcome does', async (t) => {
  const h = harness(t);
  const conv = await h.conversation();
  sendAndObserve(h, conv, '2026-01-01T00:00:00.000Z');
  await h.inbound(conv, 'Записался', '2026-01-01T12:00:00.000Z');
  h.service.outcomes.reconcile({ now: Date.parse('2026-01-02T00:00:00.000Z') });
  const candidate = h.store.get('SELECT * FROM outcome_candidates WHERE conversation_id=?', conv.id);

  await h.command('outcome.candidate_confirm', { candidate_id: candidate.id, kind: 'joined', evidence: 'They joined the call' });
  assert.equal(h.store.get('SELECT stage FROM conversations WHERE id=?', conv.id).stage, 'joined',
    'the conversation advanced');
  assert.equal(h.store.get('SELECT ownership FROM conversations WHERE id=?', conv.id).ownership, 'HUMAN_OWNED',
    'a join hands the conversation to a person, as the manual path always did');
  // And the manual path still produces the same shape, so history does not fork.
  const second = await h.command('person.create', { name: 'Third', source: 'offline test' }, id());
  const other = h.store.get('SELECT * FROM conversations WHERE id=?', second.conversation_id);
  const manual = await h.command('outcome.record', { conversation_id: other.id, kind: 'declined', evidence: 'Not now' });
  assert.equal(h.store.get('SELECT ownership FROM conversations WHERE id=?', other.id).ownership, 'HUMAN_OWNED');
  assert.ok(manual.outcome_id);
});

// A reply has to lead back to the proposal that asked for it. The window is where that link is
// captured: a reply arrives with no memory of which draft invited it, so if the sent draft is not
// recorded at the moment of delivery, attribution is undecidable afterwards and every confirmed
// outcome is attributed as if the model had written the final text.
test('a candidate carries the draft that was sent, so attribution is decidable', async (t) => {
  const h = harness(t);
  const conv = await h.conversation();
  // A real draft, so the link is the production one rather than a column filled in by hand.
  const draftId = id();
  h.store.run("INSERT INTO drafts(id,conversation_id,action,reason,status,context_revision,current_version,created_at) VALUES(?,?,?,?,?,?,?,?)",
    draftId, conv.id, 'reply', 'fixture', 'sent', 1, 2, '2026-01-01T00:00:00.000Z');
  // Two versions: the model wrote the first, the owner rewrote it. That is the case where
  // attributing the result to the model would be wrong.
  h.store.run("INSERT INTO draft_versions(id,draft_id,version,text,author,reason,created_at) VALUES(?,?,?,?,?,?,?)",
    id(), draftId, 1, 'Model draft', 'model', 'initial', '2026-01-01T00:00:00.000Z');
  h.store.run("INSERT INTO draft_versions(id,draft_id,version,text,author,reason,created_at) VALUES(?,?,?,?,?,?,?)",
    id(), draftId, 2, 'Owner rewrite', 'operator', 'edited', '2026-01-01T00:00:10.000Z');
  const messageId = id();
  h.store.run("INSERT INTO messages(id,conversation_id,direction,text,author,source,draft_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
    messageId, conv.id, 'out', 'Proposing Thursday.', 'agent_assisted', 'offline test', draftId, '2026-01-01T00:00:00.000Z');
  h.service.outcomes.observeSent(conv.id, messageId, '2026-01-01T00:00:00.000Z');
  assert.equal(h.store.get("SELECT draft_id FROM outcome_observation_windows WHERE message_id=?", messageId).draft_id, draftId,
    'the window remembers which draft went out');

  await h.inbound(conv, 'Yes', '2026-01-01T12:00:00.000Z');
  h.service.outcomes.reconcile({ now: Date.parse('2026-01-02T00:00:00.000Z') });
  const candidate = h.store.get("SELECT * FROM outcome_candidates WHERE conversation_id=?", conv.id);
  assert.equal(candidate.draft_id, draftId, 'so the candidate that observes the reply points back at it');

  // Promotion carries that link into the outcome row rather than dropping it, and still refuses
  // to claim causation.
  const result = await h.command('outcome.candidate_confirm', { candidate_id: candidate.id, kind: 'qualified', evidence: 'Confirmed by call' });
  assert.equal(result.causal_credit, 'not_established');
  assert.equal(h.store.get("SELECT draft_id FROM outcome_events WHERE id=?", result.outcome_id).draft_id, draftId,
    'the recorded outcome points back at the draft that was sent');
});

test('a misconfigured observation window is refused', async (t) => {
  const base = readJson(path.join(ROOT, 'config/default.json'));
  // Zero would close every window the instant it opened; a year would mean a conversation is
  // never settled. Both are refused at load rather than discovered at runtime.
  for (const responseWindowSeconds of [0, -1, 31536001, 1.5]) {
    assert.throws(() => validateOutcomes({ outcomes: { ...base.outcomes, enabled: true, responseWindowSeconds } }),
      /responseWindowSeconds/, `${responseWindowSeconds} must be refused`);
  }
  assert.equal(validateOutcomes({ outcomes: { ...base.outcomes, enabled: true, responseWindowSeconds: 604800 } }).outcomes.responseWindowSeconds, 604800);
  // And a layer that is off is never checked, so a stale config cannot block startup.
  assert.doesNotThrow(() => validateOutcomes({ outcomes: { ...base.outcomes, enabled: false, responseWindowSeconds: 0 } }));
});

// The starvation the review named, as a test.
//
// The scan is bounded, so the question is what a bound excludes. Bounding the two kinds of work
// together — "has this been answered" and "has this run out of patience" — means twenty silent
// conversations hold the front of every pass and a conversation that was replied to an hour ago
// waits behind them for ever. The cheap question is answered without a bound; only the deadline
// question is rationed.
test('an answered conversation is never starved by twenty silent ones', async (t) => {
  const h = harness(t, { windowSeconds: 60 });
  // Twenty conversations go quiet and stay quiet.
  for (let i = 0; i < 20; i += 1) {
    const created = await h.command('person.create', { name: `Quiet${i}`, source: 'offline test' }, id());
    const quiet = h.store.get('SELECT * FROM conversations WHERE id=?', created.conversation_id);
    sendAndObserve(h, quiet, '2026-01-01T00:00:00.000Z');
  }
  // A twenty-first is replied to, and its window closes last.
  const last = await h.command('person.create', { name: 'Answered', source: 'offline test' }, id());
  const conv = h.store.get('SELECT * FROM conversations WHERE id=?', last.conversation_id);
  sendAndObserve(h, conv, '2026-01-01T00:00:00.000Z');
  await h.inbound(conv, 'Yes', '2026-01-01T00:00:30.000Z');

  h.service.outcomes.reconcile({ now: Date.parse('2026-01-03T00:00:00.000Z') });
  assert.equal(h.store.get("SELECT outcome FROM outcome_observation_windows WHERE conversation_id=?", conv.id).outcome, 'answered',
    'the answered conversation is settled in the first pass, however many silent ones are queued');
  assert.ok(h.store.get("SELECT id FROM outcome_candidates WHERE conversation_id=?", conv.id), 'and it left a candidate');
});

// A status that only ever records failure is a status an operator learns to ignore. A layer that
// recovered from one bad pass was still reported as broken for the rest of the process.
test('a recovered observation pass stops reporting reconcile_failed', async (t) => {
  const h = harness(t, { windowSeconds: 60 });
  const conv = await h.conversation();
  sendAndObserve(h, conv, '2026-01-01T00:00:00.000Z');
  const { Scheduler } = await import('../business/scheduler.mjs');
  const scheduler = new Scheduler(h.service, { close() {}, cancel() {} }, { readiness: () => ({}) }, []);
  const original = h.service.outcomes.reconcile.bind(h.service.outcomes);
  let fail = true;
  h.service.outcomes.reconcile = () => { if (fail) throw new Error('db down'); return original(); };
  await scheduler.sourceTick();
  assert.equal(scheduler.outcomesState.disposition, 'reconcile_failed', 'the failure is reported');
  fail = false;
  await scheduler.sourceTick();
  assert.notEqual(scheduler.outcomesState.disposition, 'reconcile_failed',
    'and a pass that works says so, rather than leaving the layer reported as broken for ever');
});

// The switches are booleans. A string 'false' is enabled to `=== true` and disabled to a
// truthiness check, and finding out which one the code believed is worse than refusing it.
test('the outcome switches refuse anything that is not a boolean', async (t) => {
  const base = readJson(path.join(ROOT, 'config/default.json'));
  for (const bad of ['false', 'true', 0, 1, null]) {
    assert.throws(() => validateOutcomes({ outcomes: { ...base.outcomes, enabled: bad, modelEnabled: bad } }),
      /Invalid enabled|Invalid modelEnabled/, `${JSON.stringify(bad)} must be refused`);
  }
  assert.doesNotThrow(() => validateOutcomes({ outcomes: { ...base.outcomes, enabled: true, modelEnabled: false } }));
  assert.doesNotThrow(() => validateOutcomes({}), 'a layer that is not configured at all is not an error');
});

// The defect the review named, and the one this layer had no way to see about itself.
//
// The MTProto channel drops an inbound update while a poll is in flight — `handleIncoming` returns
// early when `this.polling` is set. So for a window opened over that transport, "no reply in the
// table" and "a reply arrived and was thrown away" are the same row. A layer that asserts silence
// there is not measuring the conversation, it is measuring its own queue depth.
test('a window may not assert silence the transport cannot vouch for', async (t) => {
  const h = harness(t, { windowSeconds: 60 });
  const conv = await h.conversation();
  // Opened with no coverage claim: exactly what a channel that may drop updates produces.
  sendAndObserve(h, conv, '2026-01-01T00:00:00.000Z', 'unverified');
  h.service.outcomes.reconcile({ now: Date.parse('2026-01-03T00:00:00.000Z') });

  assert.equal(h.store.get("SELECT COUNT(*) n FROM outcome_candidates WHERE conversation_id=? AND kind='no_response_observed'", conv.id).n, 0,
    'no silence is claimed over a transport that did not vouch for the interval');
  assert.equal(h.store.get("SELECT outcome FROM outcome_observation_windows WHERE conversation_id=?", conv.id).outcome, 'pending',
    'the window stays open rather than being settled on evidence nobody has');
  const coverage = h.service.outcomes.coverage();
  assert.equal(coverage.unverified_windows, 1, 'and it is counted as unverified, not as an answer');
  assert.equal(coverage.expired_unanswered, 0);

  // A transport that *does* vouch for the interval may still assert silence.
  const ok = await h.conversation();
  sendAndObserve(h, ok, '2026-01-01T00:00:00.000Z', 'continuous');
  h.service.outcomes.reconcile({ now: Date.parse('2026-01-03T00:00:00.000Z') });
  assert.equal(h.store.get("SELECT kind FROM outcome_candidates WHERE conversation_id=?", ok.id).kind, 'no_response_observed',
    'a vouched interval may say that nobody replied');
});
