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
const CLOSE = '2026-01-01T01:00:00.000Z';
const AFTER = Date.parse('2026-01-02T00:00:00.000Z');
const operator = { kind: 'operator' };

function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'outcome-redteam-'));
  let store = new Store(directory);
  const config = readJson(path.join(ROOT, 'config/default.json'));
  config.outcomes = { enabled: true, responseWindowSeconds: 3600 };
  config.engagement.enabled = true;
  let service = new BusinessService(store, config);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const h = {
    config, get store() { return store; }, get service() { return service; },
    command(action, payload, requestId = id(), actor = operator) { return service.command(action, payload, requestId, actor); },
    restart() { store.close(); store = new Store(directory); store.recover(); service = new BusinessService(store, config); },
    async person() { return this.command('person.create', { name: 'Redteam synthetic', source: 'offline acceptance' }); },
    async inbound(cid, text = 'Reply', at = REPLY) {
      return this.command('message.record', { conversation_id: cid, text, source: 'offline owner attestation', occurred_at: at });
    },
    async prepare(cid = null, edited = false) {
      if (!cid) cid = (await this.person()).conversation_id;
      const incoming = await this.inbound(cid, 'Please answer', '2025-12-31T23:00:00.000Z');
      const engagement = service.engagement.current(cid);
      if (!store.get('SELECT id FROM contact_permissions WHERE conversation_id=? AND revoked_at IS NULL', cid)) {
        await this.command('permission.grant', { conversation_id: cid, purpose: 'reply', granted_by: 'owner', evidence: 'Explicit synthetic permission', valid_from: '2020-01-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' });
      }
      const decision = await this.command('decision.commit', { engagement_id: engagement.id,
        expected_revision: service.engagement.get(engagement.id).revision, kind: 'ACT', reason: 'Answer explicit request', expected_next: 'An observed reply',
        evidence: [{ type: 'message', id: incoming.message_id }], action: { purpose: 'reply', text: 'Synthetic delivered answer.' } });
      if (edited) await this.command('draft.edit', { draft_id: decision.draft_id, text: 'Owner edited delivered answer.' });
      await this.command('draft.approve', { draft_id: decision.draft_id });
      return { cid, ...decision };
    },
    async delivered(cid = null, at = OPEN, edited = false) {
      const prepared = await this.prepare(cid, edited);
      await this.command('delivery.manual', { draft_id: prepared.draft_id, evidence: 'Owner verified actual offline delivery', occurred_at: at });
      const sent = store.get('SELECT * FROM messages WHERE draft_id=?', prepared.draft_id);
      const window = store.get('SELECT * FROM outcome_observation_windows WHERE message_id=?', sent.id);
      assert.ok(window, 'positive control: actual delivery reached the observer');
      return { ...prepared, sent, window };
    },
    candidate(windowId, kind = 'reply_observed') {
      return store.get('SELECT * FROM outcome_candidates WHERE window_id=? AND kind=? AND status=?', windowId, kind, 'pending');
    },
    payload(candidate, extra = {}) {
      return { candidate_id: candidate.id, expected_revision: candidate.revision, kind: 'qualified', evidence: 'Owner independently verified this business fact', ...extra };
    },
    async attest(window) {
      return this.command('outcome.coverage_attest', { window_id: window.id, covered_from: window.opened_at,
        covered_through: window.closes_at, evidence: 'Owner reviewed the complete historical interval' });
    },
    state() {
      return Object.fromEntries(['outcome_events', 'decision_outcomes', 'outcome_candidates', 'outcome_observation_windows',
        'persons', 'conversations', 'engagements', 'engagement_decisions', 'contact_permissions', 'tasks', 'events', 'command_receipts']
        .map(table => [table, store.all(`SELECT * FROM ${table} ORDER BY rowid`)]));
    },
  };
  return h;
}

test('late intake inside an attested expired interval supersedes absence and observes the positive evidence', async t => {
  const h = harness(t), d = await h.delivered();
  await h.attest(d.window); h.service.outcomes.reconcile({ now: AFTER });
  const silence = h.candidate(d.window.id, 'no_response_observed');
  assert.ok(silence, 'positive control: silence was actually proposed');
  const reply = await h.inbound(d.cid);
  h.restart(); h.service.outcomes.reconcile({ now: AFTER });
  assert.equal(h.store.get('SELECT status FROM outcome_candidates WHERE id=?', silence.id).status, 'superseded');
  const positive = h.candidate(d.window.id);
  assert.ok(positive); assert.notEqual(positive.id, silence.id); assert.equal(positive.source_message_id, reply.message_id);
  assert.equal(h.store.get('SELECT outcome FROM outcome_observation_windows WHERE id=?', d.window.id).outcome, 'answered');
  await assert.rejects(h.command('outcome.candidate_confirm', h.payload(silence)), e => e.code === 'OUTCOME_CANDIDATE_RESOLVED');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_events').n, 0);
});

test('revoking and reattesting creates a new immutable observation rather than resurrecting the old candidate', async t => {
  const h = harness(t), d = await h.delivered();
  const proof = await h.attest(d.window); h.service.outcomes.reconcile({ now: AFTER });
  const first = h.candidate(d.window.id, 'no_response_observed'); assert.ok(first);
  await h.command('outcome.coverage_revoke', { window_id: d.window.id, expected_coverage_event_id: proof.coverage_event_id, evidence: 'Original interval attestation was mistaken' });
  h.restart(); await h.attest(d.window); h.service.outcomes.reconcile({ now: AFTER });
  const second = h.candidate(d.window.id, 'no_response_observed');
  assert.ok(second); assert.notEqual(second.id, first.id);
  assert.equal(h.store.get('SELECT status FROM outcome_candidates WHERE id=?', first.id).status, 'superseded');
  assert.equal(h.service.outcomes.detail(second.id).evidence_current, true);
  h.service.outcomes.reconcile({ now: AFTER });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_candidates').n, 2);
});

test('a stale proof review cannot replace or revoke a newer owner attestation', async t => {
  const h = harness(t), d = await h.delivered(), first = await h.attest(d.window);
  const replacement = await h.command('outcome.coverage_attest', { window_id: d.window.id,
    expected_coverage_event_id: first.coverage_event_id, covered_from: OPEN, covered_through: CLOSE,
    evidence: 'Updated independent complete interval review' });
  assert.notEqual(replacement.coverage_event_id, first.coverage_event_id);
  for (const expected of [undefined, first.coverage_event_id]) {
    await assert.rejects(h.command('outcome.coverage_revoke', { window_id: d.window.id,
      ...(expected === undefined ? {} : { expected_coverage_event_id: expected }), evidence: 'Stale review of old proof' }),
    e => e.code === 'OUTCOME_COVERAGE_REVIEW_STALE');
  }
  const current = h.store.get('SELECT * FROM outcome_observation_windows WHERE id=?', d.window.id);
  assert.equal(current.coverage_event_id, replacement.coverage_event_id); assert.equal(current.coverage, 'continuous');
});

test('a corrupted durable delivery obligation is quarantined once while the bounded tail recovers after restart', async t => {
  const h = harness(t), original = h.service.outcomes.observeSent;
  h.service.outcomes.observeSent = () => { throw new Error('Optional observer unavailable'); };
  let bad, good;
  try {
    bad = await h.prepare(); await h.command('delivery.manual', { draft_id: bad.draft_id, evidence: 'Actual first delivery', occurred_at: OPEN });
    good = await h.prepare(); await h.command('delivery.manual', { draft_id: good.draft_id, evidence: 'Actual second delivery', occurred_at: OPEN });
  } finally { h.service.outcomes.observeSent = original; }
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_observation_windows').n, 0, 'observer failure control');
  const intent = h.store.get("SELECT * FROM events WHERE kind='outcome.delivery_observed' ORDER BY id LIMIT 1");
  const payload = JSON.parse(intent.payload_json); payload.message_id = id();
  h.store.run('UPDATE events SET payload_json=? WHERE id=?', JSON.stringify(payload), intent.id);
  const inbound = await h.inbound(good.cid);
  h.restart(); h.service.outcomes.reconcile({ now: AFTER, limit: 1 });
  h.restart(); h.service.outcomes.reconcile({ now: AFTER, limit: 1 });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_candidates WHERE source_message_id=?', inbound.message_id).n, 1);
  const coverage = h.service.outcomes.coverage();
  assert.equal(coverage.eligible_deliveries, 2); assert.equal(coverage.not_observed_deliveries, 1); assert.equal(coverage.windows, 1);
  for (let i = 0; i < 3; i++) h.service.outcomes.reconcile({ now: AFTER, limit: 1 });
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='outcome.delivery_quarantined'").n, 1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM delivery_attempts').n, 2, 'recovery never replays a send');
});

test('partial optional observer writes roll back locally while delivered truth survives and recovery creates one window', async t => {
  const h = harness(t), prepared = await h.prepare(), original = h.service.outcomes.observeSent;
  let reached = 0;
  h.service.outcomes.observeSent = function (...args) {
    const result = original.apply(this, args); reached++;
    assert.ok(h.store.get('SELECT id FROM outcome_observation_windows WHERE message_id=?', args[1]), 'write really occurred before failpoint');
    throw new Error('Observer failed after durable projection insert');
  };
  try {
    await h.command('delivery.manual', { draft_id: prepared.draft_id, evidence: 'Verified actual delivery', occurred_at: OPEN });
  } finally { h.service.outcomes.observeSent = original; }
  assert.equal(reached, 1);
  assert.equal(h.store.get('SELECT status FROM drafts WHERE id=?', prepared.draft_id).status, 'sent');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_observation_windows').n, 0);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='outcome.window_opened'").n, 0);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='outcome.delivery_observed'").n, 1);
  h.restart(); h.service.outcomes.reconcile({ now: AFTER });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_observation_windows').n, 1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM delivery_attempts').n, 1);
});

test('an invalid window timestamp is isolated instead of aborting every unrelated reply forever', async t => {
  const h = harness(t), bad = await h.delivered(), good = await h.delivered();
  const reply = await h.inbound(good.cid);
  h.store.run('UPDATE outcome_observation_windows SET closes_at=? WHERE id=?', 'invalid-durable-time', bad.window.id);
  for (let i = 0; i < 3; i++) h.service.outcomes.reconcile({ now: AFTER, limit: 1 });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_candidates WHERE source_message_id=?', reply.message_id).n, 1);
  assert.equal(h.store.get('SELECT outcome FROM outcome_observation_windows WHERE id=?', bad.window.id).outcome, 'superseded');
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='outcome.window_quarantined'").n, 1);
});

for (const corruption of ['evidence_json', 'observed_at', 'draft_version', 'sent_message']) {
  test(`confirmation fails closed when ${corruption} is corrupted after the review snapshot`, async t => {
    const h = harness(t), d = await h.delivered(null, OPEN, true);
    await h.inbound(d.cid); h.service.outcomes.reconcile({ now: AFTER });
    const candidate = h.candidate(d.window.id); assert.ok(candidate);
    assert.equal(h.service.outcomes.detail(candidate.id).evidence_current, true, 'positive control before corruption');
    if (corruption === 'evidence_json') h.store.run('UPDATE outcome_candidates SET evidence_json=? WHERE id=?', JSON.stringify({ window_id: id(), sent_message_id: id(), reply_message_id: id() }), candidate.id);
    if (corruption === 'observed_at') h.store.run('UPDATE outcome_candidates SET observed_at=? WHERE id=?', '2099-01-01T00:00:00.000Z', candidate.id);
    if (corruption === 'draft_version') h.store.run('UPDATE outcome_candidates SET draft_version=? WHERE id=?', candidate.draft_version + 1, candidate.id);
    if (corruption === 'sent_message') h.store.run('UPDATE messages SET text=? WHERE id=?', 'Corrupted sent text', d.sent.id);
    assert.equal(h.service.outcomes.detail(candidate.id).evidence_current, false);
    await assert.rejects(h.command('outcome.candidate_confirm', h.payload(candidate)), e => e.code === 'OUTCOME_EVIDENCE_STALE');
    assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_events').n, 0);
    assert.equal(h.store.get('SELECT COUNT(*) n FROM decision_outcomes').n, 0);
  });
}

test('owner confirmation requires the exact reviewed revision and refusal performs no outcome write', async t => {
  const h = harness(t), d = await h.delivered();
  await h.inbound(d.cid); h.service.outcomes.reconcile({ now: AFTER });
  const candidate = h.candidate(d.window.id), valid = h.payload(candidate);
  const { expected_revision, ...missing } = valid;
  for (const payload of [missing, { ...valid, expected_revision: expected_revision + 1 }]) {
    await assert.rejects(h.command('outcome.candidate_confirm', payload), e => e.code === 'OUTCOME_REVIEW_STALE');
  }
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_events').n, 0);
  const result = await h.command('outcome.candidate_confirm', valid);
  assert.ok(result.outcome_id); assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_events').n, 1);
});

test('overlapping sent decisions share one verified business result through an explicit outcome link', async t => {
  const h = harness(t), a = await h.delivered(), b = await h.delivered(a.cid, '2026-01-01T00:00:10.000Z');
  await h.inbound(a.cid); h.service.outcomes.reconcile({ now: AFTER });
  const ca = h.candidate(a.window.id), cb = h.candidate(b.window.id); assert.ok(ca && cb);
  assert.notEqual(ca.decision_id, cb.decision_id);
  const first = await h.command('outcome.candidate_confirm', h.payload(ca, { kind: 'joined', value: 100 }));
  await assert.rejects(h.command('outcome.candidate_confirm', h.payload(cb, { kind: 'joined', value: 100 })), e => e.code === 'OUTCOME_EXISTING_RESULT_REQUIRES_LINK');
  const linked = await h.command('outcome.candidate_confirm', h.payload(cb, { kind: 'joined', value: 100, outcome_id: first.outcome_id }));
  assert.equal(linked.outcome_id, first.outcome_id);
  assert.equal(linked.candidate_decision_id, b.decision_id);
  assert.equal(linked.outcome_decision_id, a.decision_id);
  assert.equal(linked.causal_credit, 'not_established');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_events').n, 1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM decision_outcomes').n, 1);
  assert.equal(h.service.outcomes.coverage().outcomes, 1);
  assert.equal(h.service.outcomes.coverage().confirmed_candidates, 2);
});

test('recovery keeps unknown delivery outside eligible observed delivery and business outcomes', async t => {
  const h = harness(t), prepared = await h.prepare();
  const draft = h.service.draft(prepared.draft_id);
  h.store.transaction(() => {
    h.store.run("UPDATE drafts SET status='sending' WHERE id=?", draft.id);
    h.store.run("INSERT INTO delivery_attempts(id,draft_id,draft_version,channel,recipient,status,created_at) VALUES(?,?,?,?,?,'sending',?)", id(), draft.id, draft.current_version, 'manual_confirmation', prepared.cid, OPEN);
  });
  h.restart(); h.service.outcomes.reconcile({ now: AFTER });
  const coverage = h.service.outcomes.coverage();
  assert.equal(coverage.unknown_delivery_messages, 1);
  assert.equal(coverage.eligible_deliveries, 0); assert.equal(coverage.windows, 0); assert.equal(coverage.outcomes, 0);
  assert.equal(h.store.get('SELECT status FROM drafts WHERE id=?', draft.id).status, 'delivery_unknown');
});

for (const entrypoint of ['public', 'command']) {
  for (const failpoint of ['outcome', 'association', 'candidate']) {
    test(`${entrypoint} confirmation rolls back all persisted state when ${failpoint} write succeeds then throws`, async t => {
      const h = harness(t), d = await h.delivered();
      await h.inbound(d.cid); h.service.outcomes.reconcile({ now: AFTER });
      const candidate = h.candidate(d.window.id), payload = h.payload(candidate, { kind: 'joined' }), before = h.state();
      const pattern = { outcome: /^INSERT INTO outcome_events/, association: /^INSERT INTO decision_outcomes/,
        candidate: /^UPDATE outcome_candidates SET status='confirmed'/ }[failpoint];
      const original = h.store.run; let reached = 0;
      h.store.run = function (sql, ...args) {
        const result = original.call(this, sql, ...args);
        if (pattern.test(sql)) { reached++; throw new Error(`Injected ${failpoint} persisted write failure`); }
        return result;
      };
      try {
        if (entrypoint === 'public') assert.throws(() => h.service.outcomes.confirm(candidate.id, payload, operator), /Injected/);
        else await assert.rejects(h.command('outcome.candidate_confirm', payload), /Injected/);
      } finally { h.store.run = original; }
      assert.equal(reached, 1, 'positive control: the actual production write was reached');
      assert.deepEqual(h.state(), before);
    });
  }
}

test('direct canonical outcome writer also rolls back on a persisted association failure', async t => {
  const h = harness(t), d = await h.delivered(), before = h.state(), original = h.store.run;
  let reached = 0;
  h.store.run = function (sql, ...args) {
    const result = original.call(this, sql, ...args);
    if (/^INSERT INTO decision_outcomes/.test(sql)) { reached++; throw new Error('Canonical association failpoint'); }
    return result;
  };
  try {
    assert.throws(() => h.service.recordOutcome(d.cid, { kind: 'joined', evidence: 'Verified synthetic business event', draft_id: d.draft_id, decision_id: d.decision_id }), /Canonical association failpoint/);
  } finally { h.store.run = original; }
  assert.equal(reached, 1); assert.deepEqual(h.state(), before);
});

test('a saved confirmation receipt cannot replay across partners sharing the database', async t => {
  const h = harness(t), d = await h.delivered();
  await h.inbound(d.cid); h.service.outcomes.reconcile({ now: AFTER });
  const candidate = h.candidate(d.window.id), payload = h.payload(candidate), requestId = id();
  const result = await h.command('outcome.candidate_confirm', payload, requestId);
  assert.deepEqual(await h.command('outcome.candidate_confirm', payload, requestId), result, 'same-partner replay remains idempotent');
  const other = new BusinessService(h.store, { ...h.config, partnerId: id() });
  await assert.rejects(other.command('outcome.candidate_confirm', payload, requestId, operator), e => e.status === 409);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_events').n, 1);
});

test('outcome and model-cost denominators stay within their partner on a shared store', async t => {
  const h = harness(t), d = await h.delivered();
  const otherId = id(), other = new BusinessService(h.store, { ...h.config, partnerId: otherId });
  h.store.run('INSERT INTO partners VALUES(?,?,?,?,?)', otherId, 'Other owner', 'Other mission', 1, OPEN);
  const created = await other.command('person.create', { name: 'Other person', source: 'Offline scope fixture' }, id(), operator);
  await other.command('outcome.record', { conversation_id: created.conversation_id, kind: 'qualified', evidence: 'Other owner fact' }, id(), operator);
  h.store.run("INSERT INTO runs(id,partner_id,status,runtime,model,context_json,cost_status,estimated_cost_usd,created_at) VALUES(?,?,'completed','synthetic','offline-fixture','{}','reported',17,?)", id(), otherId, OPEN);
  assert.equal(h.service.metrics().qualified, undefined);
  assert.equal(h.service.metrics().known_cost_usd, 0);
  assert.equal(h.service.metrics().runs, 0);
  assert.equal(h.service.metrics().total_sent, 1);
  assert.equal(other.metrics().qualified, 1);
  assert.equal(other.metrics().known_cost_usd, 17);
  assert.equal(other.metrics().total_sent, 0);
  assert.equal(other.metrics().outcome_coverage.windows, 0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM delivery_attempts').n, 1);
});

test('historical qualification after joined preserves terminal stage, STOP, revoked contact authority and cancelled work', async t => {
  const h = harness(t), d = await h.delivered();
  await h.inbound(d.cid); h.service.outcomes.reconcile({ now: AFTER });
  const candidate = h.candidate(d.window.id);
  await h.command('outcome.record', { conversation_id: d.cid, kind: 'joined', evidence: 'Owner verified later completed business joining' });
  await h.command('person.stop', { conversation_id: d.cid });
  const suppressed = h.store.get('SELECT suppressed FROM persons WHERE id=(SELECT person_id FROM conversations WHERE id=?)', d.cid);
  assert.equal(suppressed.suppressed, 1);
  const beforeAttempts = h.store.get('SELECT COUNT(*) n FROM delivery_attempts').n;
  const result = await h.command('outcome.candidate_confirm', h.payload(candidate));
  assert.ok(result.outcome_id, 'historical truth can still be recorded');
  assert.equal(h.store.get('SELECT stage FROM conversations WHERE id=?', d.cid).stage, 'joined');
  assert.equal(h.store.get('SELECT status FROM engagements WHERE id=?', d.window.engagement_id).status, 'STOPPED');
  assert.equal(h.store.get('SELECT suppressed FROM persons WHERE id=(SELECT person_id FROM conversations WHERE id=?)', d.cid).suppressed, 1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM contact_permissions WHERE conversation_id=? AND revoked_at IS NULL', d.cid).n, 0);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM tasks WHERE conversation_id=? AND status IN ('pending','proposed','running')", d.cid).n, 0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM delivery_attempts').n, beforeAttempts);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 0);
});

for (const ordering of ['before', 'after']) {
  test(`equal-second provider evidence received ${ordering} delivery cannot become either reply or silence`, async t => {
    const h = harness(t);
    const { TelegramChannel } = await import('../business/channels/telegram.mjs');
    h.config.telegram.enabled = true; h.config.telegram.liveSending = true;
    h.config.telegram.allowedChatIds = ['66']; h.service.setTelegramAccount('777');
    const person = await h.command('person.create', { name: 'Provider precision synthetic', source: 'offline adapter acceptance',
      channel: 'telegram', external_id: '66', account_id: '777' });
    const ambiguous = () => h.command('message.record', { conversation_id: person.conversation_id,
      direction: 'in', text: 'Ambiguous provider instant', external_id: 'equal-provider-second', source: 'telegram:777:66:50', occurred_at: OPEN }, id(), { kind: 'channel' });
    if (ordering === 'before') await ambiguous();
    const prepared = await h.prepare(person.conversation_id);
    const channel = new TelegramChannel(h.service); let sendCalls = 0;
    channel.api = async (method) => {
      assert.equal(method, 'sendMessage'); sendCalls++;
      return { message_id: 51, date: Date.parse(OPEN) / 1000 };
    };
    assert.equal((await channel.sendApproved(prepared.draft_id)).status, 'sent');
    if (ordering === 'after') await ambiguous();
    const window = h.store.get('SELECT * FROM outcome_observation_windows WHERE conversation_id=?', person.conversation_id);
    assert.equal(window.time_basis, 'source');
    await h.attest(window); h.service.outcomes.reconcile({ now: AFTER });
    assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_candidates').n, 0, 'finite attestation cannot establish ordering inside a provider second');
    assert.equal(h.store.get('SELECT outcome FROM outcome_observation_windows WHERE id=?', window.id).outcome, 'unknown');
    const later = await h.command('message.record', { conversation_id: person.conversation_id,
      direction: 'in', text: 'Unambiguous later provider instant', external_id: 'next-provider-second', source: 'telegram:777:66:52',
      occurred_at: '2026-01-01T00:00:01.000Z' }, id(), { kind: 'channel' });
    h.restart(); h.service.outcomes.reconcile({ now: AFTER });
    const candidate = h.candidate(window.id); assert.ok(candidate);
    assert.equal(candidate.source_message_id, later.message_id);
    assert.equal(h.store.get('SELECT outcome FROM outcome_observation_windows WHERE id=?', window.id).outcome, 'answered');
    assert.equal(sendCalls, 1, 'only the explicitly invoked fake transport send was reached');
  });
}

test('mutable decision lifecycle keeps delivered evidence current but rewritten decision history is rejected', async t => {
  const h = harness(t), d = await h.delivered();
  await h.inbound(d.cid); h.service.outcomes.reconcile({ now: AFTER });
  const candidate = h.candidate(d.window.id);
  assert.equal(h.store.get('SELECT status FROM engagement_decisions WHERE id=?', d.decision_id).status, 'stale');
  assert.equal(h.service.outcomes.detail(candidate.id).evidence_current, true, 'ordinary delivered decision staleness is expected');
  h.store.run('UPDATE engagement_decisions SET snapshot_json=?,reason=? WHERE id=?', JSON.stringify({ strategy: 'Altered historical explanation' }), 'Rewritten historical decision', d.decision_id);
  assert.equal(h.service.outcomes.detail(candidate.id).evidence_current, false);
  await assert.rejects(h.command('outcome.candidate_confirm', h.payload(candidate)), e => e.code === 'OUTCOME_EVIDENCE_STALE');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_events').n, 0);
});

test('Bot replay after an old receipt and lost offset enriches one legacy row without duplicate work or authority', async t => {
  const h = harness(t);
  const { TelegramChannel } = await import('../business/channels/telegram.mjs');
  const { hash } = await import('../business/store.mjs');
  h.config.telegram.enabled = true; h.config.telegram.liveSending = false;
  h.config.telegram.allowedChatIds = ['66']; h.service.setTelegramAccount('777');
  const person = await h.command('person.create', { name: 'Legacy provider replay synthetic', source: 'offline', channel: 'telegram', external_id: '66', account_id: '777' });
  const delivered = await h.delivered(person.conversation_id);
  const oldPayload = { conversation_id: person.conversation_id, text: 'Native event durably recorded before upgrade', direction: 'in',
    external_id: '90', source: 'telegram:777:66:90' };
  const oldRequestId = 'telegram-update:777:901';
  const oldResult = await h.command('message.record', oldPayload, oldRequestId, { kind: 'channel' });
  h.store.run('UPDATE command_receipts SET fingerprint=? WHERE id=?', hash(JSON.stringify({ action: 'message.record', p: oldPayload,
    actor: 'channel', run: null, scope: null })), oldRequestId);
  h.store.run('UPDATE messages SET created_at=? WHERE id=?', REPLY, oldResult.message_id);
  h.service.outcomes.reconcile({ now: AFTER });
  const oldCandidate = h.candidate(delivered.window.id);
  assert.ok(oldCandidate); assert.equal(h.service.outcomes.detail(oldCandidate.id).evidence_current, true);
  assert.equal(h.store.get('SELECT cursor FROM channel_offsets WHERE channel=? AND account_id=?', 'telegram', '777'), undefined);
  const countTables = () => Object.fromEntries(['messages','persons','tasks','contact_permissions','delivery_attempts','outcome_observation_windows']
    .map(table => [table, h.store.get(`SELECT COUNT(*) n FROM ${table}`).n]));
  const before = countTables(), channel = new TelegramChannel(h.service);
  let polls = 0, sends = 0;
  const nativeAt = '2025-12-31T23:59:59.000Z';
  channel.api = async method => {
    if (method !== 'getUpdates') { sends++; throw new Error('Outbound must never be reached'); }
    polls++;
    return [{ update_id: 901, message: { message_id: 90, chat: { id: 66, type: 'private' },
      text: oldPayload.text, date: Date.parse(nativeAt) / 1000 } }];
  };
  const previousToken = process.env.PARTNER_TELEGRAM_BOT_TOKEN;
  process.env.PARTNER_TELEGRAM_BOT_TOKEN = '777:offline-fixture';
  try { await channel.poll(); await channel.poll(); }
  finally {
    if (previousToken === undefined) delete process.env.PARTNER_TELEGRAM_BOT_TOKEN;
    else process.env.PARTNER_TELEGRAM_BOT_TOKEN = previousToken;
  }
  assert.equal(polls, 2, 'positive control: both adapter polls actually reached the fake transport');
  assert.equal(sends, 0); assert.equal(channel.lastError, null);
  assert.equal(h.store.get('SELECT cursor FROM channel_offsets WHERE channel=? AND account_id=?', 'telegram', '777').cursor, '902');
  assert.deepEqual(countTables(), before);
  const enriched = h.store.get('SELECT occurred_at,time_basis FROM messages WHERE id=?', oldResult.message_id);
  assert.equal(enriched.occurred_at, nativeAt); assert.equal(enriched.time_basis, 'source');
  assert.equal(h.service.outcomes.detail(oldCandidate.id).evidence_current, false);
  await assert.rejects(h.command('outcome.candidate_confirm', h.payload(oldCandidate)), e => e.code === 'OUTCOME_EVIDENCE_STALE');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_events').n, 0);
  assert.ok(h.store.get('SELECT id FROM command_receipts WHERE id=?', oldRequestId), 'legacy receipt history is preserved');
});

for (const corruptedCursor of ['{broken-json', '{"delivery":[]}', '{"window":37}', '{"review":false}', '{"delivery":9007199254740991}']) {
  test(`an invalid persisted observation cursor ${corruptedCursor} cannot poison unrelated evidence`, async t => {
    const h = harness(t), d = await h.delivered();
    const reply = await h.inbound(d.cid);
    h.store.run('INSERT INTO channel_offsets(channel,account_id,cursor) VALUES(?,?,?)', 'outcome-observation-v2', h.config.partnerId, corruptedCursor);
    h.restart();
    for (let i = 0; i < 3; i++) h.service.outcomes.reconcile({ now: AFTER, limit: 1 });
    const candidate = h.candidate(d.window.id); assert.ok(candidate); assert.equal(candidate.source_message_id, reply.message_id);
    assert.equal(h.store.get('SELECT COUNT(*) n FROM delivery_attempts').n, 1);
    const cursor = JSON.parse(h.store.get('SELECT cursor FROM channel_offsets WHERE channel=? AND account_id=?', 'outcome-observation-v2', h.config.partnerId).cursor);
    assert.equal(typeof cursor.window, 'string'); assert.equal(typeof cursor.review, 'string'); assert.equal(typeof cursor.delivery, 'number');
    assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='outcome.cursor_reset'").n, 1, 'invalid durable cursor is audited once');
  });
}

test('valid JSON null in a coverage event invalidates silence instead of stopping unrelated observations', async t => {
  const h = harness(t), first = await h.delivered();
  const proof = await h.attest(first.window); h.service.outcomes.reconcile({ now: AFTER });
  const silence = h.candidate(first.window.id, 'no_response_observed'); assert.ok(silence);
  const second = await h.delivered(), reply = await h.inbound(second.cid);
  h.store.run('UPDATE events SET payload_json=? WHERE id=?', 'null', proof.coverage_event_id);
  for (let i = 0; i < 4; i++) h.service.outcomes.reconcile({ now: AFTER, limit: 1 });
  assert.ok(h.store.get('SELECT id FROM outcome_candidates WHERE source_message_id=? AND status=?', reply.message_id, 'pending'));
  assert.equal(h.store.get('SELECT status FROM outcome_candidates WHERE id=?', silence.id).status, 'superseded');
  assert.equal(h.store.get("SELECT COUNT(*) n FROM outcome_candidates WHERE kind='no_response_observed' AND status='pending'").n, 0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM outcome_events').n, 0);
});
