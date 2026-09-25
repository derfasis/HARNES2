// Stage 3A contract: read-only reason-state surface (WAIT/IGNORE unlock conditions).
// proof_level=integration; live_proof=false. No writes, no model, no scheduler, no live transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, readJson } from '../business/config.mjs';
import { BusinessService } from '../business/service.mjs';
import { Store, id } from '../business/store.mjs';

const SOURCE = 'public:stage3a';
const TEXT = 'I have two hours a week. What does this offer involve?';
const NOW = '2026-09-25T12:00:00.000Z';

function source(extra = {}) {
  return { source_id: SOURCE, source_kind: 'sanitized_fixture', message_id: 'message:1',
    author_id: 'user:1', display_name: 'Synthetic author', thread_id: 'thread:1', reply_to_id: null,
    version: 1, operation: 'upsert', text: TEXT, created_at: '2026-09-25T10:00:00.000Z',
    updated_at: '2026-09-25T10:00:00.000Z', ...extra };
}

function harness(t, prefix = 'harnes2-stage3a-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const settings = readJson(path.join(ROOT, 'config/default.json'));
  settings.discovery = { ...settings.discovery, enabled: true, ttlSeconds: 86400 };
  settings.opportunity = { ...settings.opportunity, automatic: true, allowedSourceRefs: [SOURCE],
    activeOffer: { id: 'stage3a-offer', version: 'v1', text: 'Synthetic offer', criteria: [], exclusions: [] } };
  settings.runtime = { ...settings.runtime, enabled: false, model: '', baseUrl: '' };
  settings.telegram = { ...settings.telegram, enabled: false, liveSending: false };
  settings.engagement = { ...settings.engagement, enabled: false };
  let store = new Store(directory), service = new BusinessService(store, settings);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { settings, get store() { return store; }, get service() { return service; },
    command(action, payload, request = id(), actor = { kind: 'operator' }) {
      return service.command(action, payload, request, actor);
    },
    ingest(raw = source()) { return service.command('source.ingest', raw, id(), { kind: 'channel', sourceId: raw.source_id }); },
    detail(situationId) { return service.discoveryDetail(situationId); },
    surface(options = {}, actor = { kind: 'operator' }) { return service.discoveryReasonStates(options, actor); },
    restart() { store.close(); store = new Store(directory); store.recover(); service = new BusinessService(store, settings); } };
}

function assessmentPayload(h, situationId, decision = 'OBSERVE') {
  const detail = h.detail(situationId);
  const evidence = detail.evidence.map((item) => String(item.source_event_id));
  return { situation_id: situationId, expected_revision: detail.revision,
    expected_evidence_fingerprint: detail.evidence_fingerprint, decision, evidence_event_ids: evidence,
    hypothesis: { text: 'A bounded explanation may help; interest is unconfirmed.', evidence_event_ids: evidence,
      attributed_claims: [{ source_event_id: evidence[0], quote: 'I have two hours a week.' }],
      inferences: [{ text: 'Available time may constrain fit.', evidence_event_ids: evidence }],
      uncertainty: ['The time claim is unverified.'] },
    why_now: { reason: 'The explicit question may deserve attention while evidence is current.', evidence_event_ids: evidence },
    ...(decision === 'CANDIDATE' ? { opening_proposal: { text: 'I can explain the time requirements.',
      rationale: 'Answer only after separate authorization.', constraints: ['operator review only'] } } : {}) };
}

function reasonPayload(h, situationId, decision, extra = {}) {
  const detail = h.detail(situationId);
  const assessmentId = String(detail.assessments.at(-1).id);
  return { situation_id: situationId, assessment_id: assessmentId, expected_revision: detail.revision,
    expected_evidence_fingerprint: detail.evidence_fingerprint, decision,
    reason: `Stage 3A ${decision.toLowerCase()} contract`, ...extra };
}

async function candidate(h, decision = 'OBSERVE', messageId = 'message:1', threadId = 'thread:1') {
  const ingested = await h.ingest(source({ message_id: messageId, thread_id: threadId,
    text: `${TEXT} (${messageId})` }));
  const row = h.store.get('SELECT situation_id FROM discovery_evidence WHERE source_event_id=?', ingested.source_event_id);
  await h.command('discovery.assess', assessmentPayload(h, row.situation_id, decision));
  return row.situation_id;
}

function item0(page) { return page.items[0]; }

const EFFECT_TABLES = ['events', 'command_receipts', 'tasks', 'discovery_situations', 'discovery_evidence',
  'persons', 'conversations', 'messages', 'facts', 'engagements', 'drafts', 'approvals'];

// Row contents, not just counts: a read that mutates an existing row must still fail this.
function snapshot(h) {
  return EFFECT_TABLES.map((table) => {
    const rows = h.store.all(`SELECT * FROM ${table} ORDER BY id`).map((row) => JSON.stringify(row));
    return `${table}[${rows.join(',')}]`;
  }).join('|');
}

test('S3A IGNORE is listed as BLOCKED and unlocks on new evidence', async t => {
  const h = harness(t);
  const situationId = await candidate(h, 'CANDIDATE');
  const result = await h.command('discovery.reason', reasonPayload(h, situationId, 'IGNORE'));
  const before = snapshot(h);
  const page = h.surface();
  assert.equal(snapshot(h), before, 'surface must not write');
  assert.deepEqual(Object.keys(item0(page)).sort(), ['allowed_effects', 'contact_permission', 'decision',
    'evidence_fingerprint', 'executable', 'freshness', 'reason', 'revision', 'situation_id', 'state',
    'storage_status', 'transition_id', 'unlock', 'wait']);
  assert.equal(page.items.length, 1);
  const [item] = page.items;
  assert.equal(item.situation_id, situationId);
  assert.equal(item.decision, 'IGNORE');
  assert.equal(item.wait, null);
  assert.equal(item.state, 'BLOCKED');
  assert.equal(item.unlock, 'EVIDENCE_CHANGE');
  assert.equal(item.revision, result.revision);
  assert.equal(item.evidence_fingerprint, h.detail(situationId).evidence_fingerprint);
  assert.equal(item.storage_status, 'OBSERVING');
  assert.equal(typeof item.transition_id, 'string');
  assert.equal(item.freshness.fresh, true);
  assert.deepEqual(Object.keys(item.freshness).sort(), ['fresh', 'reasons']);
  assert.equal(JSON.stringify(page).includes('two hours a week'), false, 'surface must not expose source text');
  assert.deepEqual(item.allowed_effects, []);
  assert.equal(item.executable, false);
  assert.equal(item.contact_permission, false);
  // New evidence retires the IGNORE basis: the row leaves the surface entirely.
  await h.ingest(source({ message_id: 'message:2', text: 'New evidence changes the question.' }));
  assert.deepEqual(h.surface().items, []);
});

test('S3A WAIT evidence_change and WAIT deadline carry their own unlock conditions', async t => {
  const h = harness(t);
  const change = await candidate(h, 'CANDIDATE');
  await h.command('discovery.reason', reasonPayload(h, change, 'WAIT', { wait: { kind: 'evidence_change' } }));
  const other = harness(t, 'harnes2-stage3a-deadline-');
  const deadlineSituation = await candidate(other, 'CANDIDATE');
  await other.command('discovery.reason', reasonPayload(other, deadlineSituation, 'WAIT',
    { wait: { kind: 'deadline', at: '2099-01-01T00:00:00.000Z' } }));

  const evidenceChange = h.surface().items.find((item) => item.situation_id === change);
  assert.equal(evidenceChange.state, 'BLOCKED');
  assert.equal(evidenceChange.unlock, 'EVIDENCE_CHANGE');
  assert.deepEqual(evidenceChange.wait, { kind: 'evidence_change' });

  const deadline = other.surface().items.find((item) => item.situation_id === deadlineSituation);
  assert.equal(deadline.state, 'BLOCKED');
  assert.equal(deadline.unlock, 'DEADLINE_OR_EVIDENCE_CHANGE');
  assert.deepEqual(deadline.wait, { kind: 'deadline', at: '2099-01-01T00:00:00.000Z' });
});

test('S3A a reached deadline reports READY/DEADLINE_REACHED and survives restart', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  const h = harness(t);
  const situationId = await candidate(h);
  await h.command('discovery.reason', reasonPayload(h, situationId, 'WAIT',
    { wait: { kind: 'deadline', at: '2026-09-25T12:00:05.000Z' } }));
  assert.equal(h.surface().items[0].state, 'BLOCKED');
  t.mock.timers.tick(10000);
  const ready = h.surface().items[0];
  assert.equal(ready.state, 'READY');
  assert.equal(ready.unlock, 'DEADLINE_OR_EVIDENCE_CHANGE');
  assert.equal(ready.reason, 'DEADLINE_REACHED');
  h.restart();
  const afterRestart = h.surface().items[0];
  assert.equal(afterRestart.state, 'READY');
  assert.equal(afterRestart.situation_id, situationId);
});

test('S3A each situation is listed once under its own latest transition and a STOP leaves the surface', async t => {
  const h = harness(t);
  const ignored = await candidate(h, 'CANDIDATE');
  await h.command('discovery.reason', reasonPayload(h, ignored, 'IGNORE'));
  const waited = await candidate(h, 'CANDIDATE', 'message:2', 'thread:2');
  await h.command('discovery.reason', reasonPayload(h, waited, 'WAIT', { wait: { kind: 'evidence_change' } }));
  const items = h.surface().items;
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.situation_id).sort(), [ignored, waited].sort());
  assert.equal(items.find((item) => item.situation_id === ignored).decision, 'IGNORE');
  assert.equal(items.find((item) => item.situation_id === waited).decision, 'WAIT');
  assert.equal(items.find((item) => item.situation_id === waited).unlock, 'EVIDENCE_CHANGE');

  const stopped = harness(t, 'harnes2-stage3a-stop-');
  const stopSituation = await candidate(stopped, 'CANDIDATE');
  await stopped.command('discovery.reason', reasonPayload(stopped, stopSituation, 'STOP'));
  assert.deepEqual(stopped.surface().items, []);
});

test('S3A a newer assessment on the same basis retires the previous transition row', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  const h = harness(t);
  const situationId = await candidate(h);
  await h.command('discovery.reason', reasonPayload(h, situationId, 'WAIT',
    { wait: { kind: 'deadline', at: '2026-09-25T12:00:05.000Z' } }));
  t.mock.timers.tick(10000);
  assert.equal(h.surface().items[0].state, 'READY');
  await h.command('discovery.assess', assessmentPayload(h, situationId));
  assert.deepEqual(h.surface().items, [], 'a new assessment supersedes the old transition');
});

test('S3A surface is operator-only, strict, and bounded by limit plus keyset cursor', async t => {
  const h = harness(t);
  const ids = [];
  for (let index = 0; index < 5; index += 1) {
    const situationId = await candidate(h, 'CANDIDATE', `message:${index + 1}`, `thread:${index + 1}`);
    ids.push(situationId);
    await h.command('discovery.reason', reasonPayload(h, situationId, 'IGNORE'));
  }
  const ordered = [...ids].sort();
  assert.deepEqual(h.surface().items.map((item) => item.situation_id), ordered);

  const seen = [];
  let cursor = null;
  for (let page = 0; page < 5; page += 1) {
    const result = h.surface(cursor ? { limit: 2, cursor } : { limit: 2 });
    for (const item of result.items) seen.push(item.situation_id);
    if (!result.next_cursor) break;
    cursor = result.next_cursor;
  }
  assert.deepEqual(seen, ordered);
  assert.equal(new Set(seen).size, seen.length);

  assert.throws(() => h.surface({}, { kind: 'agent' }), { code: 'DISCOVERY_OPERATOR_REQUIRED' });
  assert.throws(() => h.surface({}, { kind: 'system' }), { code: 'DISCOVERY_OPERATOR_REQUIRED' });
  assert.throws(() => h.surface({ unexpected: true }), { code: 'DISCOVERY_FIELDS_INVALID' });
  assert.throws(() => h.surface({ limit: 0 }), { code: 'DISCOVERY_FIELDS_INVALID' });
  assert.throws(() => h.surface({ limit: 1000 }), { code: 'DISCOVERY_FIELDS_INVALID' });
  assert.throws(() => h.surface({ limit: 1.5 }), { code: 'DISCOVERY_FIELDS_INVALID' });
  assert.throws(() => h.surface({ cursor: 123 }), { code: 'DISCOVERY_FIELDS_INVALID' });
  assert.throws(() => h.surface({ cursor: 'zzz' }), { code: 'DISCOVERY_FIELDS_INVALID' });
});

test('S3A stale and revoked evidence is reported honestly and never repaired by reading', async t => {
  const h = harness(t);
  const expired = await candidate(h, 'CANDIDATE');
  await h.command('discovery.reason', reasonPayload(h, expired, 'IGNORE'));
  h.store.run("UPDATE discovery_situations SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?", expired);

  const revoked = harness(t, 'harnes2-stage3a-revoked-');
  const revokedSituation = await candidate(revoked, 'CANDIDATE');
  await revoked.command('discovery.reason', reasonPayload(revoked, revokedSituation, 'IGNORE'));
  revoked.settings.opportunity.allowedSourceRefs = [];

  const before = snapshot(h);
  const item = h.surface().items.find((row) => row.situation_id === expired);
  assert.equal(item.freshness.fresh, false);
  assert.ok(item.freshness.reasons.length > 0);
  assert.equal(snapshot(h), before);

  const beforeRevoked = snapshot(revoked);
  const revokedItem = revoked.surface().items.find((row) => row.situation_id === revokedSituation);
  assert.equal(revokedItem.freshness.fresh, false);
  assert.ok(revokedItem.freshness.reasons.length > 0);
  assert.equal(snapshot(revoked), beforeRevoked);
});
