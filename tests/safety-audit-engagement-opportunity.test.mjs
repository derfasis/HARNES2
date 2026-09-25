// Stage 4C: safety audit of the Engagement and Opportunity write paths.
// proof_level=integration; live_proof=false. No model, network, Telegram, or scheduler run.
// A failure is a finding. It is not fixed here; it is reported.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { ROOT, readJson } from '../business/config.mjs';
import { Store, id } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { mock } from 'node:test';
import { syncBuiltinESMExports } from 'node:module';

const OPERATOR = { kind: 'operator' };

function tables(store) {
  return store.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .map((row) => row.name)
    .filter((name) => !/^sqlite_/.test(name) && !/_(data|idx|content|docsize|config)$/.test(name));
}

// Full row content of every table, so a rejected command that quietly wrote something is caught.
function snapshot(store) {
  return tables(store).map((table) => {
    const rows = store.all(`SELECT * FROM ${table} ORDER BY rowid`).map((row) => JSON.stringify(row));
    return `${table}[${rows.join(',')}]`;
  }).join('|');
}

const OFFER = { id: 'audit-offer', version: 'v1', text: 'Synthetic offer', criteria: [], exclusions: [] };

function settings() {
  const config = readJson(path.join(ROOT, 'config/default.json'));
  const fixture = readJson(path.join(ROOT, 'benchmarks/opportunity-projection-v0/case-01.json'));
  config.opportunity = { ...config.opportunity, automatic: true, allowedSourceRefs: [fixture.source.ref],
    activeOffer: structuredClone(fixture.active_offer) };
  config.engagement = { ...config.engagement, enabled: false };
  config.runtime = { ...config.runtime, enabled: false, model: '', baseUrl: '' };
  config.telegram = { ...config.telegram, enabled: false, liveSending: false };
  return config;
}

async function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes-audit-4c-'));
  let store = new Store(directory);
  const config = settings();
  let service = new BusinessService(store, config);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const h = { directory, config, get store() { return store; }, get service() { return service; },
    command: (action, payload, actor = OPERATOR, request = id()) => service.command(action, payload, request, actor),
    restart() { store.close(); store = new Store(directory); store.recover(); service = new BusinessService(store, config); } };
  const person = await h.command('person.create', { name: 'Synthetic person', source: 'offline audit' });
  h.cid = person.conversation_id;
  h.pid = person.person_id;
  const inbound = await h.command('message.record', { conversation_id: h.cid, text: 'Скільки коштує участь?', source: 'synthetic' });
  h.mid = inbound.message_id;
  const opened = await h.command('engagement.open', { conversation_id: h.cid, topic: 'Умови партнерства',
    current_need: 'Стартові витрати', close_condition: 'Відповідь отримана або відмова', unknowns: ['Умови не перевірені'] });
  h.eid = opened.engagement_id;
  h.grant = (purpose = 'reply', extra = {}) => h.command('permission.grant', { conversation_id: h.cid, purpose,
    granted_by: 'audit recipient', evidence: 'Synthetic explicit request for this purpose',
    valid_from: '2020-01-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z', ...extra });
  h.decide = (kind, extra = {}, actor = OPERATOR) => h.command('decision.commit', { engagement_id: h.eid,
    expected_revision: service.engagement.get(h.eid).revision, kind, reason: 'Audit reason',
    expected_next: 'Explicit observed event', evidence: [{ type: 'message', id: h.mid }], ...extra }, actor);
  h.actor = () => { const runId = id();
    const task = store.get("SELECT t.* FROM tasks t JOIN engagement_tasks et ON et.task_id=t.id WHERE et.engagement_id=? AND t.status='pending' LIMIT 1", h.eid);
    if (task) store.run("UPDATE tasks SET status='running' WHERE id=?", task.id);
    store.run('INSERT INTO runs(id,partner_id,task_id,conversation_id,status,runtime,model,context_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      runId, config.partnerId, task?.id ?? null, h.cid, 'running', 'fixture', 'fixture-model', '{}', new Date().toISOString());
    return { kind: 'agent', runId, conversationId: h.cid }; };
  return h;
}

// E1 — a decision is bound to the exact engagement revision and to a real message.
test('E1 a decision requires the current revision and real evidence', async t => {
  const h = await harness(t);
  // Each refusal is wrapped on its own: a group snapshot would only prove the combined effect.
  for (const refuse of [
    () => h.command('decision.commit', { engagement_id: h.eid, expected_revision: 999, kind: 'IGNORE',
      reason: 'x', expected_next: 'y', evidence: [{ type: 'message', id: h.mid }] }),
    () => h.decide('IGNORE', { evidence: [{ type: 'message', id: 'no-such-message' }] }),
  ]) {
    const before = snapshot(h.store);
    await assert.rejects(refuse(), { status: 409 });
    assert.equal(snapshot(h.store), before, 'a refused decision must not write anything');
  }
  assert.equal(h.service.engagement.get(h.eid).revision, 0);
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM engagement_decisions").n, 0);
});

// E2 — ACT is refused without a current typed permission matching person, conversation, channel, account.
test('E2 ACT needs a typed permission, and a broken one closes the door without writes', async t => {
  const h = await harness(t);
  let before = snapshot(h.store);
  await assert.rejects(h.decide('ACT', { action: { purpose: 'reply', text: 'Ответ.' } }),
    { code: 'typed_permission_required' });
  assert.equal(snapshot(h.store), before, 'a refused ACT must not write anything');

  await h.grant();
  before = snapshot(h.store);
  const permission = h.store.get('SELECT * FROM contact_permissions ORDER BY rowid DESC LIMIT 1');
  // Foreign keys are real, so the mismatches are made with real rows, not invented ids.
  const other = await h.command('person.create', { name: 'Other person', source: 'offline audit' });
  for (const [column, value] of [['person_id', other.person_id],
    ['conversation_id', other.conversation_id], ['channel', 'telegram']]) {
    h.store.run(`UPDATE contact_permissions SET ${column}=? WHERE id=?`, value, permission.id);
    const current = snapshot(h.store);
    await assert.rejects(h.decide('ACT', { action: { purpose: 'reply', text: 'Ответ.' } }),
      { code: 'typed_permission_required' });
    assert.equal(snapshot(h.store), current, `a grant with a wrong ${column} must be refused with no writes`);
    h.store.run(`UPDATE contact_permissions SET ${column}=? WHERE id=?`, permission[column], permission.id);
  }
  // Account isolation needs a conversation that really has one: on a manual channel
  // account_id is null and no mismatch could ever be expressed.
  h.store.run('INSERT INTO channel_identities(id,person_id,channel,account_id,external_id) VALUES(?,?,?,?,?)',
    id(), h.pid, 'telegram', 'account-a', 'external-a');
  const identity = h.store.get('SELECT id FROM channel_identities ORDER BY rowid DESC LIMIT 1').id;
  h.store.run("UPDATE conversations SET channel='telegram', channel_identity_id=? WHERE id=?", identity, h.cid);
  h.store.run("UPDATE contact_permissions SET channel='telegram', account_id='account-b' WHERE id=?",
    h.store.get('SELECT id FROM contact_permissions ORDER BY rowid DESC LIMIT 1').id);
  const current = snapshot(h.store);
  await assert.rejects(h.decide('ACT', { action: { purpose: 'reply', text: 'Ответ.' } }),
    { code: 'typed_permission_required' });
  assert.equal(snapshot(h.store), current, 'a grant bound to another account must be refused with no writes');
  h.store.run("UPDATE contact_permissions SET account_id='account-a' WHERE id=?",
    h.store.get('SELECT id FROM contact_permissions ORDER BY rowid DESC LIMIT 1').id);

  const decided = await h.decide('ACT', { action: { purpose: 'reply', text: 'Общая модель пояснена.' } });
  assert.equal(decided.kind, 'ACT');
  assert.ok(decided.decision_id);
});

// E3 — a suppressed person or a human-owned conversation produces no queued work.
test('E3 suppression and human ownership stop the queue without erasing history', async t => {
  const h = await harness(t);
  await h.grant();
  h.store.run('UPDATE conversations SET ownership=? WHERE id=?', 'HUMAN_OWNED', h.cid);
  let before = snapshot(h.store);
  await assert.rejects(h.decide('ACT', { action: { purpose: 'reply', text: 'Ответ.' } }), { status: 409 });
  assert.equal(snapshot(h.store), before);
  h.store.run('UPDATE conversations SET ownership=? WHERE id=?', 'AI_OWNED', h.cid);

  h.store.run('UPDATE persons SET suppressed=1 WHERE id=?', h.pid);
  before = snapshot(h.store);
  await assert.rejects(h.decide('ACT', { action: { purpose: 'reply', text: 'Ответ.' } }), { status: 409 });
  assert.equal(snapshot(h.store), before);
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM drafts").n, 0);
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM delivery_attempts").n, 0);
});

// E4 — a draft is never a send, and delivery truth is never invented.
test('E4 nothing in the audit path ever sends, and no delivery is claimed', async t => {
  const denied = () => { throw Error('External call forbidden'); };
  const fetchGuard = mock.method(globalThis, 'fetch', denied), spawnGuard = mock.method(childProcess, 'spawn', denied);
  syncBuiltinESMExports();
  const h = await harness(t);
  await h.grant();
  const decision = await h.decide('ACT', { action: { purpose: 'reply', text: 'Общая модель пояснена.',
    explained: ['Общая модель пояснена.'] } });
  // An ACT decision is a proposal. Even with a valid permission, it creates no delivery.
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM delivery_attempts").n, 0);
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM messages WHERE direction='out'").n, 0);
  assert.ok(decision.decision_id);
  assert.equal(fetchGuard.mock.callCount(), 0);
  assert.equal(spawnGuard.mock.callCount(), 0);
  mock.restoreAll(); syncBuiltinESMExports();
});

// E5 — replaying a request is idempotent, and changing it under the same id is a conflict.
test('E5 request replay is idempotent and payload changes conflict', async t => {
  const h = await harness(t);
  const request = id();
  const payload = { engagement_id: h.eid, expected_revision: 0, kind: 'IGNORE', reason: 'Audit',
    expected_next: 'Await inbound', evidence: [{ type: 'message', id: h.mid }] };
  const first = await h.command('decision.commit', payload, OPERATOR, request);
  const second = await h.command('decision.commit', payload, OPERATOR, request);
  assert.equal(second.status, first.status);
  const before = snapshot(h.store);
  await assert.rejects(h.command('decision.commit', { ...payload, reason: 'Changed' }, OPERATOR, request),
    { status: 409 });
  assert.equal(snapshot(h.store), before, 'a conflicting replay must not write anything');
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM engagement_decisions").n, 1);
});

// E6 — a restart neither resumes a closed case nor restores authority.
test('E6 a closed or stopped engagement stays closed across a restart', async t => {
  const stopped = await harness(t);
  await stopped.grant();
  await stopped.decide('STOP');
  stopped.restart();
  assert.equal(stopped.service.engagement.current(stopped.cid), undefined);
  const before = snapshot(stopped.store);
  await assert.rejects(stopped.decide('ACT', { action: { purpose: 'reply', text: 'Ответ.' } }), { status: 409 });
  assert.equal(snapshot(stopped.store), before);
  assert.equal(stopped.store.get("SELECT COUNT(*) AS n FROM delivery_attempts").n, 0);

  const closed = await harness(t);
  await closed.grant();
  await closed.decide('HANDOFF');
  const handoff = closed.store.get("SELECT id FROM engagement_handoffs WHERE status='requested' ORDER BY rowid DESC LIMIT 1");
  await closed.command('handoff.accept', { engagement_id: closed.eid, handoff_id: handoff.id });
  await closed.command('engagement.close', { engagement_id: closed.eid, evidence: 'Audit close: owner decision recorded.' });
  closed.restart();
  assert.equal(closed.service.engagement.current(closed.cid), undefined);
  const closedBefore = snapshot(closed.store);
  await assert.rejects(closed.decide('ACT', { action: { purpose: 'reply', text: 'Ответ.' } }), { status: 409 });
  assert.equal(snapshot(closed.store), closedBefore);
  assert.equal(closed.store.get("SELECT COUNT(*) AS n FROM delivery_attempts").n, 0);
});

// O1 — opportunity review is bound to the exact fingerprint and revision.
test('O1 opportunity review needs the exact fingerprint and revision', async t => {
  const h = await harness(t);
  const consumed = await captureAndConsume(h);
  const detail = h.service.opportunityDetail(consumed.task_id);
  const review = { task_id: consumed.task_id, fingerprint: detail.fingerprint, expected_revision: 0 };

  // Each refusal is wrapped on its own, and each may add exactly one denial event — nothing else.
  const denialsBefore = () => h.store.get("SELECT COUNT(*) AS n FROM events WHERE kind='opportunity.review.denied'").n;
  for (const payload of [{ ...review, fingerprint: 'wrong' }, { ...review, expected_revision: 42 },
    { ...review, unexpected: true }]) {
    const before = snapshot(h.store), denials = denialsBefore();
    await assert.rejects(h.command('opportunity.review.approve', payload), { status: 409 });
    const after = snapshot(h.store);
    const changed = tables(h.store).filter((table) => section(before, table) !== section(after, table));
    assert.deepEqual(changed, ['events'], `a refused review changed ${changed.join(', ')}`);
    assert.equal(denialsBefore(), denials + 1, 'exactly one denial is recorded per refusal');
  }
  // A refusal is designed to leave one durable trace: a denial event that survives the rollback.
  // It must carry only the action, the task, the error code and the request id — never the
  // untrusted payload, never a grant, never a status change.
  const denials = h.store.all("SELECT payload_json FROM events WHERE kind='opportunity.review.denied' ORDER BY id");
  for (const denial of denials) {
    const payload = JSON.parse(denial.payload_json);
    assert.deepEqual(Object.keys(payload).sort(), ['action', 'code', 'request_id', 'task_id']);
    assert.equal(payload.task_id, consumed.task_id);
    assert.equal(payload.contact_permission, undefined);
    assert.equal(payload.granted, undefined);
  }
  assert.equal(h.store.get('SELECT status FROM tasks WHERE id=?', consumed.task_id).status, 'proposed');
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM contact_permissions").n, 0);
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM drafts").n, 0);
});

const section = (value, table) => value.split('|').find((part) => part.startsWith(`${table}[`));

// O2 — approving a card is a review act, never a send.
test('O2 approving a card never sends and never grants contact', async t => {
  const h = await harness(t);
  const consumed = await captureAndConsume(h);
  const detail = h.service.opportunityDetail(consumed.task_id);
  const before = snapshot(h.store);
  const approved = await h.command('opportunity.review.approve', { task_id: consumed.task_id,
    fingerprint: detail.fingerprint, expected_revision: 0 });
  assert.equal(approved.review.status, 'approved');
  // The approval itself is explicitly non-executable and grants no contact.
  assert.equal(approved.executable, false);
  assert.equal(approved.contact_permission, false);
  assert.deepEqual(approved.allowed_effects, []);
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM delivery_attempts").n, 0);
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM messages WHERE direction='out'").n, 0);
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM contact_permissions").n, 0);
  assert.notEqual(snapshot(h.store), before, 'the approval itself is a durable change');
});

// O3 — the same review cannot be decided twice, and a decided card stays decided.
test('O3 a decided card cannot be re-decided, and replay stays idempotent', async t => {
  const h = await harness(t);
  const consumed = await captureAndConsume(h);
  const detail = h.service.opportunityDetail(consumed.task_id);
  const request = id();
  const payload = { task_id: consumed.task_id, fingerprint: detail.fingerprint, expected_revision: 0 };
  const first = await h.command('opportunity.review.approve', payload, OPERATOR, request);
  const second = await h.command('opportunity.review.approve', payload, OPERATOR, request);
  assert.equal(second.review.revision, first.review.revision);
  assert.equal(second.review.status, first.review.status);
  const current = h.service.opportunityDetail(consumed.task_id);
  const before = snapshot(h.store);
  await assert.rejects(h.command('opportunity.review.approve', { ...payload,
    fingerprint: current.fingerprint, expected_revision: current.review.revision }, OPERATOR, id()),
  { status: 409 });
  const after = snapshot(h.store);
  // A re-decide is a refusal, so the denial trail is the only permitted difference.
  assert.deepEqual(tables(h.store).filter((table) => section(before, table) !== section(after, table)),
    ['events']);
  assert.equal(h.service.opportunityDetail(consumed.task_id).review.revision, current.review.revision,
    'the settled revision does not move');
  // An approved review leaves the model output frozen and the card reviewable, not executed.
  const settled = h.service.opportunityDetail(consumed.task_id);
  assert.equal(settled.review.status, 'approved');
  assert.equal(settled.task.status, 'proposed');
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM tasks WHERE kind='opportunity_review' AND status='done'").n, 0);
});

// O4 — no external effect happens anywhere in this audit.
test('O4 the audit performs no external call of any kind', async t => {
  const denied = () => { throw Error('External call forbidden'); };
  const fetchGuard = mock.method(globalThis, 'fetch', denied), spawnGuard = mock.method(childProcess, 'spawn', denied);
  syncBuiltinESMExports();
  const h = await harness(t);
  await h.grant();
  await h.decide('WAIT', { wait_for: ['inbound'] });
  const consumed = await captureAndConsume(h);
  const detail = h.service.opportunityDetail(consumed.task_id);
  await h.command('opportunity.review.reject', { task_id: consumed.task_id, fingerprint: detail.fingerprint,
    expected_revision: 0, reason: 'Audit rejection' });
  assert.equal(fetchGuard.mock.callCount(), 0);
  assert.equal(spawnGuard.mock.callCount(), 0);
  mock.restoreAll(); syncBuiltinESMExports();
});

// The capture must be current, so the fixture timestamp is stamped at read time.
function snapshotFixture() {
  const fixture = readJson(path.join(ROOT, 'benchmarks/opportunity-projection-v0/case-01.json'));
  fixture.source.captured_at = new Date().toISOString();
  return fixture;
}

async function captureAndConsume(h) {
  const capture = await h.command('opportunity.capture', { snapshot: snapshotFixture() });
  const message = capture.context.input.message, situation = capture.context.input.situation_id;
  const output = { contract_version: 'opportunity-projection-v0', situation_id: situation,
    opportunity: { hypothesis: 'Hand-authored offline question.',
      evidence: [{ message_id: message.id, author_id: message.author_id,
        version: capture.context.source_metadata.at(-1).version, span: message.text,
        kind: 'question', attribution: 'author_statement' }],
      contradictions: [], unknowns: ['Operator review required.'] },
    next_action: { schema_version: 1, situation_id: situation, decision: 'PUBLIC_REPLY', confidence: 0.8,
      strategy: 'Review.', reason: 'Offline fixture.', evidence_message_ids: [message.id], unknowns: [], risk_flags: [],
      draft: { channel: 'public', action: 'reply', target_id: message.author_id, text: 'Not sent.',
        source_message_ids: [message.id] },
      review: { required: true, status: 'pending', authorization: 'none' }, reevaluate_after: null },
    authority: { contact_permission: false, allowed_effects: [] } };
  return h.command('opportunity.consume', { capture_id: capture.capture_id, output });
}
