// Stage 3D safety audit. Test-only: production code is not modified by this stage.
// proof_level=integration; live_proof=false. No model, network, Telegram, or scheduler run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { Store, id } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { start } from '../business/server.mjs';
import { ROOT, readJson } from '../business/config.mjs';

const SOURCE = 'public:discovery-fixture';
const baseTime = '2026-01-01T00:00:00.000Z';
const offer = { id: 'offer-audit', version: 'v1', text: 'Synthetic offer', criteria: ['scope'], exclusions: [] };

function source(extra = {}) {
  return { source_id: SOURCE, source_kind: 'sanitized_fixture', message_id: 'message:1', author_id: 'user:1',
    display_name: 'Fixture user', thread_id: 'thread:1', reply_to_id: null, version: 1, operation: 'upsert',
    text: 'What does this offer include?', created_at: baseTime, updated_at: baseTime, ...extra };
}

function config() {
  const value = readJson(path.join(ROOT, 'config/default.json'));
  value.opportunity = { ...value.opportunity, automatic: true, allowedSourceRefs: [SOURCE],
    activeOffer: structuredClone(offer) };
  value.discovery = { ...value.discovery, enabled: true, maxEvidence: 20, ttlSeconds: 604800, maxOpenSituations: 100 };
  value.runtime = { ...value.runtime, enabled: false, model: '', baseUrl: '' };
  value.telegram = { ...value.telegram, enabled: false, liveSending: false };
  value.engagement = { ...value.engagement, enabled: false };
  return value;
}

function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-audit-'));
  let store = new Store(directory);
  const settings = config();
  let service = new BusinessService(store, settings);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { settings, get store() { return store; }, get service() { return service; },
    command(action, payload, actor = { kind: 'operator' }, request = id()) {
      return service.command(action, payload, request, actor);
    },
    async ingest(raw = source()) {
      return service.command('source.ingest', raw, id(), { kind: 'channel', sourceId: raw.source_id });
    },
    situationId() { return store.get('SELECT situation_id FROM discovery_evidence ORDER BY rowid LIMIT 1').situation_id; },
    transitions(situationId) {
      return store.all("SELECT id,payload_json FROM events WHERE partner_id=? AND kind='discovery.reason.transitioned'"
        + ' AND json_extract(payload_json,\'$.situation_id\')=? ORDER BY id', settings.partnerId, situationId);
    },
    detail(idValue) { return service.discoveryDetail(idValue); },
    surface() { return service.discoveryReasonStates({}, { kind: 'operator' }); },
    presentation(idValue) { return service.discoveryPresentationDetail(idValue, { kind: 'operator' }); },
    restart() { store.close(); store = new Store(directory); store.recover(); service = new BusinessService(store, settings); } };
}

function assessmentPayload(detail, decision = 'CANDIDATE') {
  const evidence = detail.evidence.map((item) => String(item.source_event_id));
  return { situation_id: detail.id, expected_revision: detail.revision,
    expected_evidence_fingerprint: detail.evidence_fingerprint, decision, evidence_event_ids: evidence,
    hypothesis: { text: 'A bounded explanation may help; interest is unconfirmed.', evidence_event_ids: evidence,
      attributed_claims: [{ source_event_id: evidence[0], quote: 'What does this offer include?' }],
      inferences: [{ text: 'Fit is unconfirmed.', evidence_event_ids: evidence }],
      uncertainty: ['The time claim is unverified.'] },
    why_now: { reason: 'The explicit question may deserve attention.', evidence_event_ids: evidence },
    ...(decision === 'CANDIDATE' ? { opening_proposal: { text: 'I can explain the offer.',
      rationale: 'Answer only after separate authorization.', constraints: ['operator review only'] } } : {}) };
}

async function candidate(h, decision = 'CANDIDATE') {
  await h.ingest();
  const situationId = h.situationId();
  await h.command('discovery.assess', assessmentPayload(h.detail(situationId), decision));
  return situationId;
}

function reasonPayload(h, situationId, decision, extra = {}) {
  const detail = h.detail(situationId);
  return { situation_id: situationId, assessment_id: String(detail.assessments.at(-1).id),
    expected_revision: detail.revision, expected_evidence_fingerprint: detail.evidence_fingerprint,
    decision, reason: `Audit ${decision}`, ...extra };
}

// Every application table in the database, discovered from the schema rather than hand-listed,
// minus the shadow tables SQLite keeps for FTS indexes.
const INTERNAL_TABLES = new Set(['sqlite_sequence', 'lessons_fts_data', 'lessons_fts_idx',
  'lessons_fts_content', 'lessons_fts_docsize', 'lessons_fts_config']);
const PERSON_TABLES = store => store.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .map((row) => row.name).filter((name) => !INTERNAL_TABLES.has(name));

// Full row content of every user table, so a read or a decision that mutates an existing row is caught.
function fullSnapshot(h) {
  return PERSON_TABLES(h.store).map((table) => {
    const rows = h.store.all(`SELECT * FROM ${table} ORDER BY rowid`).map((row) => JSON.stringify(row));
    return `${table}[${rows.join(',')}]`;
  }).join('|');
}

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}

function request(port, route, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'GET',
      headers: token ? { 'x-partner-token': token } : {} }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject); req.end();
  });
}

// A1 — CANDIDATE, REVIEW, WAIT, IGNORE, STOP, and TRANSFER all require a durable assessment basis.
test('A1 no decision state is reachable without a durable assessment behind it', async t => {
  const h = harness(t);
  await h.ingest();
  const situationId = h.situationId();
  // A freshly observed situation is OBSERVING with no assessment: that is the allowed intake state.
  assert.equal(h.detail(situationId).status, 'OBSERVING');
  assert.equal(h.detail(situationId).assessments.length, 0);
  assert.deepEqual(h.surface().items, []);

  await assert.rejects(h.command('discovery.reason', { situation_id: situationId, assessment_id: 'any',
    expected_revision: h.detail(situationId).revision,
    expected_evidence_fingerprint: h.detail(situationId).evidence_fingerprint,
    decision: 'IGNORE', reason: 'Audit without an assessment' }),
  { code: 'DISCOVERY_REASON_ASSESSMENT_STALE' });
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM tasks WHERE kind='discovery_review'").n, 0);
  assert.equal(h.transitions(situationId).length, 0);

  await h.command('discovery.assess', assessmentPayload(h.detail(situationId), 'CANDIDATE'));
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM tasks WHERE kind='discovery_review' AND status='proposed'").n, 1);
  const second = harness(t);
  const secondId = await candidate(second);
  assert.equal(second.detail(secondId).assessments.length, 1);
});

// B — exactly one immutable transition per decision, tied to the current assessment and fingerprint.
test('B each reason decision leaves exactly one immutable transition on the current basis', async t => {
  const h = harness(t);
  const situationId = await candidate(h);
  const request = id();
  const payload = reasonPayload(h, situationId, 'WAIT', { wait: { kind: 'evidence_change' } });
  await h.command('discovery.reason', payload, { kind: 'operator' }, request);
  await h.command('discovery.reason', payload, { kind: 'operator' }, request);
  const transitions = h.transitions(situationId);
  assert.equal(transitions.length, 1, 'replaying one request must not create a second transition');
  const transition = JSON.parse(transitions[0].payload_json);
  const detail = h.detail(situationId);
  assert.equal(transition.assessment_id, String(detail.assessments.at(-1).id));
  assert.equal(transition.evidence_fingerprint, detail.evidence_fingerprint);
  assert.equal(transition.result_revision, transition.basis_revision + 1);
  assert.equal(transition.result_revision, detail.revision);
});

// C — unlock conditions exactly as Stage 2 defines them, and nothing else unlocks.
test('C IGNORE and WAIT unlock only on the condition their decision names', async t => {
  const ignored = harness(t);
  const ignoredId = await candidate(ignored);
  await ignored.command('discovery.reason', reasonPayload(ignored, ignoredId, 'IGNORE'));
  assert.equal(ignored.surface().items[0].unlock, 'EVIDENCE_CHANGE');
  assert.equal(ignored.surface().items[0].state, 'BLOCKED');
  ignored.restart();
  assert.equal(ignored.surface().items[0].state, 'BLOCKED', 'a restart is not an unlock');
  await assert.rejects(ignored.command('discovery.assess', assessmentPayload(ignored.detail(ignoredId), 'CANDIDATE')),
    { code: 'DISCOVERY_REASON_IGNORED' });
  await ignored.ingest(source({ message_id: 'message:2', text: 'New evidence changes the question.' }));
  assert.equal(ignored.surface().items.length, 0);

  const waited = harness(t);
  const waitedId = await candidate(waited);
  await waited.command('discovery.reason', reasonPayload(waited, waitedId, 'WAIT', { wait: { kind: 'evidence_change' } }));
  assert.equal(waited.surface().items[0].unlock, 'EVIDENCE_CHANGE');
  await assert.rejects(waited.command('discovery.assess', assessmentPayload(waited.detail(waitedId), 'CANDIDATE')),
    { code: 'DISCOVERY_REASON_WAITING' });

  // A deadline wait unlocks on the deadline OR on new evidence, and a restart is not an unlock.
  const deadline = harness(t);
  const deadlineId = await candidate(deadline);
  await deadline.command('discovery.reason', reasonPayload(deadline, deadlineId, 'WAIT',
    { wait: { kind: 'deadline', at: '2099-01-01T00:00:00.000Z' } }));
  const future = deadline.surface().items[0];
  assert.equal(future.state, 'BLOCKED');
  assert.equal(future.unlock, 'DEADLINE_OR_EVIDENCE_CHANGE');
  assert.deepEqual(future.wait, { kind: 'deadline', at: '2099-01-01T00:00:00.000Z' });
  deadline.restart();
  assert.equal(deadline.surface().items[0].state, 'BLOCKED', 'a restart is not an unlock');
  await assert.rejects(deadline.command('discovery.assess', assessmentPayload(deadline.detail(deadlineId), 'CANDIDATE')),
    { code: 'DISCOVERY_REASON_WAITING' });
  await deadline.ingest(source({ message_id: 'message:2', text: 'New evidence before the deadline.' }));
  assert.equal(deadline.surface().items.length, 0, 'new evidence also retires a deadline wait');
});

test('C2 a reached deadline is READY, and only then does it unlock', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00.000Z') });
  const h = harness(t);
  const situationId = await candidate(h);
  await h.command('discovery.reason', reasonPayload(h, situationId, 'WAIT',
    { wait: { kind: 'deadline', at: '2026-01-01T00:10:00.000Z' } }));
  assert.equal(h.surface().items[0].state, 'BLOCKED');
  h.restart();
  assert.equal(h.surface().items[0].state, 'BLOCKED');
  t.mock.timers.tick(11 * 60 * 1000);
  const ready = h.surface().items[0];
  assert.equal(ready.state, 'READY');
  assert.equal(ready.reason, 'DEADLINE_REACHED');
  assert.equal(ready.unlock, 'DEADLINE_OR_EVIDENCE_CHANGE');
  const reassessed = await h.command('discovery.assess', assessmentPayload(h.detail(situationId), 'CANDIDATE'));
  assert.equal(reassessed.status, 'OBSERVING');
  assert.ok(reassessed.review_task_id, 'a reached deadline lets the situation be re-assessed, not approved');
  assert.equal(h.surface().items.length, 0, 'a new assessment retires the transition that governed it');
});

// D — STOP closes one Discovery situation and nothing else exists on the other side.
test('D STOP touches no person, engagement, permission, draft, approval, or send state', async t => {
  const h = harness(t);
  const situationId = await candidate(h);
  const tasksBefore = h.store.all('SELECT id,kind,status FROM tasks ORDER BY id');
  const before = fullSnapshot(h);
  const result = await h.command('discovery.reason', reasonPayload(h, situationId, 'STOP'));
  assert.equal(result.status, 'STOPPED');
  const after = fullSnapshot(h);
  const section = (value, table) => value.split('|').find((part) => part.startsWith(`${table}[`));
  for (const table of ['persons', 'conversations', 'messages', 'contact_permissions', 'engagements',
    'drafts', 'approvals', 'delivery_attempts', 'outcome_events', 'lessons', 'runs']) {
    assert.equal(section(after, table), section(before, table), `${table} must be untouched by STOP`);
  }
  // The one task change STOP is allowed to make: cancelling its own proposed review.
  assert.equal(tasksBefore.length, 1);
  assert.equal(tasksBefore[0].status, 'proposed');
  assert.equal(JSON.stringify(h.store.all('SELECT id,kind,status FROM tasks ORDER BY id')),
    JSON.stringify(tasksBefore.map((row) => ({ ...row, status: 'cancelled' }))));
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM events WHERE kind='discovery.transferred'").n, 0);
  assert.equal(h.store.get('SELECT status FROM discovery_situations WHERE id=?', situationId).status, 'DISMISSED');
});

// E — both presentation surfaces deny internal field names, checked by field name, not by word search.
const FORBIDDEN_FIELD_NAMES = new Set(['payload_json', 'partner_id', 'offer_fingerprint', 'source_kind',
  'source', 'raw', 'transferred_engagement_id', 'conversation_id']);

function collectFieldNames(value, names = new Set()) {
  if (Array.isArray(value)) { for (const item of value) collectFieldNames(item, names); return names; }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) { names.add(key); collectFieldNames(child, names); }
  }
  return names;
}

test('E neither presentation surface exposes an internal field name', async t => {
  const h = harness(t);
  const situationId = await candidate(h);
  const detail = h.presentation(situationId);
  const list = h.surface();
  for (const names of [collectFieldNames(detail), collectFieldNames(list)]) {
    for (const name of names) assert.equal(FORBIDDEN_FIELD_NAMES.has(name), false, `forbidden field: ${name}`);
  }
  // The internal read model, by contrast, still carries the raw projection the surface must hide.
  const internalNames = collectFieldNames(h.detail(situationId));
  for (const name of ['payload_json', 'offer_fingerprint', 'source']) {
    assert.equal(internalNames.has(name), true, `internal projection should still carry ${name}`);
  }
  assert.equal(detail.situation_id, situationId);
  assert.equal(detail.evidence_fingerprint, h.detail(situationId).evidence_fingerprint);
});

// F — both HTTP reads change no user table at all, content included.
test('F HTTP reads mutate nothing in any user table', async t => {
  const denied = () => { throw Error('External model/Telegram call forbidden'); };
  const { mock } = await import('node:test');
  const fetchGuard = mock.method(globalThis, 'fetch', denied), spawnGuard = mock.method(childProcess, 'spawn', denied);
  syncBuiltinESMExports();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-audit-http-'));
  const settings = config();
  settings.server.port = await freePort();
  settings.scheduler.enabled = false;
  const app = await start({ directory, config: settings });
  t.after(async () => {
    await app.close();
    assert.equal(fetchGuard.mock.callCount(), 0);
    assert.equal(spawnGuard.mock.callCount(), 0);
    mock.restoreAll();
    assert.equal(path.dirname(directory), os.tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await app.service.command('source.ingest', source(), randomUUID(), { kind: 'channel', sourceId: SOURCE });
  const situationId = app.store.get('SELECT situation_id FROM discovery_evidence ORDER BY rowid LIMIT 1').situation_id;
  const detail = app.service.discoveryDetail(situationId);
  await app.service.command('discovery.assess', assessmentPayload(detail, 'CANDIDATE'), randomUUID(), { kind: 'operator' });
  const token = (await request(settings.server.port, '/api/session')).body.token;

  const tables = PERSON_TABLES(app.store);
  assert.ok(tables.length >= 30, 'the snapshot must cover the whole schema, not a hand-picked subset');
  const snapshot = () => tables.map((table) => {
    const rows = app.store.all(`SELECT * FROM ${table} ORDER BY rowid`).map((row) => JSON.stringify(row));
    return `${table}[${rows.join(',')}]`;
  }).join('|');
  const before = snapshot();
  const listed = await request(settings.server.port, '/api/discovery/reason-states', token);
  const opened = await request(settings.server.port, `/api/discovery/${situationId}`, token);
  assert.equal(listed.status, 200);
  assert.equal(opened.status, 200);
  assert.equal(snapshot(), before);
});

// G — each missing transfer prerequisite fails alone, and a failed transfer has zero side effects.
test('G transfer fails one prerequisite at a time and never crosses the Engagement boundary', async t => {
  const h = harness(t);
  const situationId = await candidate(h);
  const task = h.store.get("SELECT id FROM tasks WHERE kind='discovery_review' AND status='proposed'").id;
  const person = await h.command('person.create', { name: 'Existing recipient', source: 'synthetic operator' });
  await h.command('message.record', { conversation_id: person.conversation_id, text: 'Explicit inbound question', source: 'synthetic' });
  const inboundId = h.store.get('SELECT id FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1', person.conversation_id).id;

  const transfer = (overrides = {}) => h.command('discovery.transfer', { situation_id: situationId,
    conversation_id: person.conversation_id, inbound_message_id: inboundId, basis: 'Audit transfer attempt.', ...overrides });

  // G1 no approved review.
  let snapshot = fullSnapshot(h);
  await assert.rejects(transfer(), { code: 'DISCOVERY_REVIEW_REQUIRED' });
  assert.equal(fullSnapshot(h), snapshot, 'a rejected transfer must not write anything');
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM events WHERE kind='discovery.transferred'").n, 0);

  const detail = h.detail(situationId);
  await h.command('discovery.review', { task_id: task, expected_revision: detail.revision,
    expected_evidence_fingerprint: detail.evidence_fingerprint, decision: 'approve' });

  // G2 wrong author binding.
  h.settings.opportunity.authorBindings = [{ source_id: SOURCE, author_id: 'user:other', conversation_id: person.conversation_id }];
  snapshot = fullSnapshot(h);
  await assert.rejects(transfer(), { code: 'DISCOVERY_AUTHOR_BINDING_REQUIRED' });
  assert.equal(fullSnapshot(h), snapshot);

  // G3 no real inbound message for this conversation.
  h.settings.opportunity.authorBindings = [{ source_id: SOURCE, author_id: 'user:1', conversation_id: person.conversation_id }];
  snapshot = fullSnapshot(h);
  await assert.rejects(transfer({ inbound_message_id: 'message:does-not-exist' }), { code: 'DISCOVERY_INBOUND_REQUIRED' });
  assert.equal(fullSnapshot(h), snapshot);

  // G4 no typed reply grant yet.
  snapshot = fullSnapshot(h);
  await assert.rejects(transfer(), { code: 'typed_permission_required' });
  assert.equal(fullSnapshot(h), snapshot);

  // G5 a person who is suppressed cannot be reached even with every other prerequisite in place.
  await h.command('permission.grant', { conversation_id: person.conversation_id, purpose: 'reply',
    granted_by: 'synthetic recipient', evidence: 'synthetic explicit reply grant',
    valid_from: '2020-01-01T00:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z' });
  h.store.run('UPDATE persons SET suppressed=1 WHERE id=?', h.store.get('SELECT id FROM persons LIMIT 1').id);
  snapshot = fullSnapshot(h);
  await assert.rejects(transfer(), { code: /DISCOVERY_CONVERSATION_UNAVAILABLE/ });
  assert.equal(fullSnapshot(h), snapshot);
  h.store.run('UPDATE persons SET suppressed=0 WHERE id=?', h.store.get('SELECT id FROM persons LIMIT 1').id);

  // G6 a conversation the AI no longer owns is refused for the same reason.
  h.store.run("UPDATE conversations SET ownership='HUMAN_OWNED' WHERE id=?", person.conversation_id);
  snapshot = fullSnapshot(h);
  await assert.rejects(transfer(), { code: /DISCOVERY_CONVERSATION_UNAVAILABLE/ });
  assert.equal(fullSnapshot(h), snapshot);
  h.store.run("UPDATE conversations SET ownership='AI_OWNED' WHERE id=?", person.conversation_id);

  // G7 a conversation bound to a different person than the one on the evidence is not a match.
  const other = await h.command('person.create', { name: 'Unrelated recipient', source: 'synthetic operator' });
  h.settings.opportunity.authorBindings = [{ source_id: SOURCE, author_id: 'user:1', conversation_id: other.conversation_id }];
  snapshot = fullSnapshot(h);
  await assert.rejects(transfer(), { code: 'DISCOVERY_AUTHOR_BINDING_REQUIRED' });
  assert.equal(fullSnapshot(h), snapshot);
  h.settings.opportunity.authorBindings = [{ source_id: SOURCE, author_id: 'user:1', conversation_id: person.conversation_id }];

  // G8 with every prerequisite the transfer enters the existing Engagement boundary and nothing more.
  await h.command('permission.grant', { conversation_id: person.conversation_id, purpose: 'reply',
    granted_by: 'synthetic recipient', evidence: 'synthetic explicit reply grant',
    valid_from: '2020-01-01T00:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z' });
  const result = await transfer();
  assert.equal(result.status, 'TRANSFERRED');
  assert.equal(result.sends_started, false);
  assert.equal(result.drafts_created, 0);
  assert.equal(result.contact_permission_created, false);
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM events WHERE kind='discovery.transferred'").n, 1);
});

// H — actor boundaries: observe stays system-only, the rest stays operator-only.
test('H actor boundaries hold on every Discovery entry point', async t => {
  const h = harness(t);
  const situationId = await candidate(h);
  const observe = { context_key: 'thread:1', purpose: h.settings.discovery.purpose,
    source_event_id: h.detail(situationId).evidence[0].source_event_id };
  await assert.rejects(h.command('discovery.observe', observe, { kind: 'operator' }),
    { code: 'DISCOVERY_SYSTEM_ONLY' });
  await assert.rejects(h.command('discovery.observe', observe, { kind: 'agent' }),
    { code: 'DISCOVERY_SYSTEM_ONLY' });

  for (const actor of [{ kind: 'agent' }, { kind: 'system' }]) {
    await assert.rejects(h.command('discovery.assess', assessmentPayload(h.detail(situationId), 'CANDIDATE'), actor),
      { status: 403 });
    await assert.rejects(h.command('discovery.reason', reasonPayload(h, situationId, 'IGNORE'), actor), { status: 403 });
    await assert.rejects(h.command('discovery.review', { task_id: 'any', decision: 'approve',
      expected_revision: 0, expected_evidence_fingerprint: 'x' }, actor), { status: 403 });
    await assert.rejects(h.command('discovery.transfer', { situation_id: situationId, conversation_id: 'c',
      inbound_message_id: 'm', basis: 'x' }, actor), { status: 403 });
    assert.throws(() => h.service.discoveryReasonStates({}, actor), { code: 'DISCOVERY_OPERATOR_REQUIRED' });
    assert.throws(() => h.service.discoveryPresentationDetail(situationId, actor), { code: 'DISCOVERY_OPERATOR_REQUIRED' });
  }
  // The internal read model stays open to the service itself, by design and by contract.
  assert.equal(h.service.discoveryDetail(situationId).situation_id ?? h.service.discoveryDetail(situationId).id, situationId);
});

// I — stale authority never comes back through edit, delete, revoke, expiry, or a restart.
test('I stale authority stays stale across edit, delete, revoke, expiry, and restart', async t => {
  const edited = harness(t);
  const editedId = await candidate(edited);
  await edited.ingest(source({ message_id: 'message:1', version: 2, text: 'Edited before the decision.' }));
  await assert.rejects(edited.command('discovery.reason', reasonPayload(edited, editedId, 'IGNORE')),
    { code: /DISCOVERY_STALE/ });
  assert.equal(edited.transitions(editedId).length, 0);
  edited.restart();
  assert.equal(edited.transitions(editedId).length, 0);

  const deleted = harness(t);
  const deletedId = await candidate(deleted);
  await deleted.ingest(source({ message_id: 'message:1', version: 2, operation: 'delete', text: null }));
  await assert.rejects(deleted.command('discovery.reason', reasonPayload(deleted, deletedId, 'IGNORE')),
    { code: /DISCOVERY_STALE/ });

  const revoked = harness(t);
  const revokedId = await candidate(revoked);
  revoked.settings.opportunity.allowedSourceRefs = [];
  await assert.rejects(revoked.command('discovery.reason', reasonPayload(revoked, revokedId, 'IGNORE')),
    { code: /DISCOVERY_STALE/ });

  const expired = harness(t);
  const expiredId = await candidate(expired);
  expired.store.run("UPDATE discovery_situations SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?", expiredId);
  await assert.rejects(expired.command('discovery.reason', reasonPayload(expired, expiredId, 'IGNORE')),
    { code: /DISCOVERY_STALE/ });
  await assert.rejects(expired.command('discovery.review', { task_id: expired.store.get(
    "SELECT id FROM tasks WHERE kind='discovery_review' AND status='proposed'").id,
  expected_revision: expired.detail(expiredId).revision,
  expected_evidence_fingerprint: expired.detail(expiredId).evidence_fingerprint, decision: 'approve' }),
  { code: /DISCOVERY_STALE/ });
  // A restart does not grant authority back, whatever label the row carries: the decision path
  // stays closed and nothing was written while it was closed.
  expired.restart();
  assert.equal(expired.transitions(expiredId).length, 0);
  assert.equal(expired.surface().items.length, 0);
  await assert.rejects(expired.command('discovery.assess', assessmentPayload(expired.detail(expiredId), 'CANDIDATE')),
    { code: /DISCOVERY_STALE/ });
  await assert.rejects(expired.command('discovery.reason', reasonPayload(expired, expiredId, 'IGNORE')),
    { code: /DISCOVERY_STALE/ });
  assert.equal(expired.transitions(expiredId).length, 0);
});

test('I2 a superseded assessment loses its authority on the same evidence', async t => {
  const h = harness(t);
  const situationId = await candidate(h);
  const first = h.detail(situationId).assessments.at(-1);
  const firstTask = h.store.get("SELECT id FROM tasks WHERE kind='discovery_review' AND status='proposed'").id;
  // A newer assessment on the same evidence retires the earlier one without new evidence.
  const second = await h.command('discovery.assess', assessmentPayload(h.detail(situationId), 'CANDIDATE'));
  assert.ok(second.assessment_id !== String(first.id));
  assert.equal(h.store.get('SELECT status FROM tasks WHERE id=?', firstTask).status, 'cancelled');

  // A reason decision naming the superseded assessment is refused.
  const detail = h.detail(situationId);
  await assert.rejects(h.command('discovery.reason', { situation_id: situationId, assessment_id: String(first.id),
    expected_revision: detail.revision, expected_evidence_fingerprint: detail.evidence_fingerprint,
    decision: 'IGNORE', reason: 'Audit of a superseded assessment' }),
  { code: 'DISCOVERY_REASON_ASSESSMENT_STALE' });
  // And so is a review of the review task the superseded assessment created.
  await assert.rejects(h.command('discovery.review', { task_id: firstTask, expected_revision: detail.revision,
    expected_evidence_fingerprint: detail.evidence_fingerprint, decision: 'approve' }),
  { code: /DISCOVERY_REVIEW_NOT_AVAILABLE/ });
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM events WHERE kind='discovery.review.approved'").n, 0);
  assert.equal(h.transitions(situationId).length, 0);

  // The current assessment keeps its own authority.
  const current = h.detail(situationId);
  await h.command('discovery.reason', { situation_id: situationId, assessment_id: String(current.assessments.at(-1).id),
    expected_revision: current.revision, expected_evidence_fingerprint: current.evidence_fingerprint,
    decision: 'IGNORE', reason: 'Audit of the current assessment' });
  assert.equal(h.transitions(situationId).length, 1);
});
