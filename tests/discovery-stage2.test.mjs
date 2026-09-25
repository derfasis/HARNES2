// Stage 2 contract: WAIT/IGNORE/STOP reasoning transitions.
// proof_level=integration; live_proof=false. No model, scheduler, or live transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, readJson } from '../business/config.mjs';
import { BusinessService } from '../business/service.mjs';
import { Store, id } from '../business/store.mjs';

const SOURCE = 'public:stage2';
const TEXT = 'I have two hours a week. What does this offer involve?';
const NOW = '2026-09-25T12:00:00.000Z';

function source(extra = {}) {
  return { source_id: SOURCE, source_kind: 'sanitized_fixture', message_id: 'message:1',
    author_id: 'user:1', display_name: 'Synthetic author', thread_id: 'thread:1', reply_to_id: null,
    version: 1, operation: 'upsert', text: TEXT, created_at: '2026-09-25T10:00:00.000Z',
    updated_at: '2026-09-25T10:00:00.000Z', ...extra };
}

function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-stage2-'));
  const settings = readJson(path.join(ROOT, 'config/default.json'));
  settings.discovery = { ...settings.discovery, enabled: true, ttlSeconds: 86400 };
  settings.opportunity = { ...settings.opportunity, automatic: true, allowedSourceRefs: [SOURCE],
    activeOffer: { id: 'stage2-offer', version: 'v1', text: 'Synthetic offer', criteria: [], exclusions: [] } };
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

async function candidate(h, decision = 'OBSERVE') {
  const ingested = await h.ingest();
  const row = h.store.get('SELECT situation_id FROM discovery_evidence WHERE source_event_id=?', ingested.source_event_id);
  const result = await h.command('discovery.assess', assessmentPayload(h, row.situation_id, decision));
  return { situationId: row.situation_id, result };
}

function reasonPayload(h, fixture, decision, extra = {}) {
  const detail = h.detail(fixture.situationId);
  return { situation_id: fixture.situationId, assessment_id: String(fixture.result.assessment_id),
    expected_revision: detail.revision, expected_evidence_fingerprint: detail.evidence_fingerprint,
    decision, reason: `Stage 2 ${decision.toLowerCase()} contract`, ...extra };
}

function noEffects(h) {
  for (const table of ['persons', 'conversations', 'channel_identities', 'messages', 'facts', 'contact_permissions',
    'engagements', 'drafts', 'approvals', 'delivery_attempts', 'outcome_events', 'lessons', 'runs']) {
    assert.equal(h.store.get(`SELECT COUNT(*) AS n FROM ${table}`).n, 0, table);
  }
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM events WHERE kind='discovery.transferred'").n, 0);
  assert.deepEqual(h.store.all('PRAGMA foreign_key_check'), []);
}

test('S2 IGNORE consumes the assessment signal, keeps the situation live, and unlocks only new evidence', async t => {
  const h = harness(t), f = await candidate(h, 'CANDIDATE');
  const result = await h.command('discovery.reason', reasonPayload(h, f, 'IGNORE'));
  assert.equal(result.status, 'OBSERVING');
  assert.equal(result.decision, 'IGNORE');
  assert.ok(result.revision > f.result.revision);
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM tasks WHERE kind=\'discovery_review\' AND status=\'proposed\'').n, 0);
  await assert.rejects(h.command('discovery.assess', assessmentPayload(h, f.situationId)),
    { code: 'DISCOVERY_REASON_IGNORED' });
  await h.ingest(source({ message_id: 'message:2', text: 'New evidence changes the question.' }));
  const next = await h.command('discovery.assess', assessmentPayload(h, f.situationId));
  assert.equal(next.status, 'OBSERVING');
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM events WHERE kind='discovery.reason.transitioned'").n, 1);
  noEffects(h);
});

test('S2 WAIT evidence_change blocks the same basis until new evidence arrives', async t => {
  const h = harness(t), f = await candidate(h, 'CANDIDATE');
  const result = await h.command('discovery.reason', reasonPayload(h, f, 'WAIT', { wait: { kind: 'evidence_change' } }));
  assert.equal(result.status, 'OBSERVING');
  assert.deepEqual(result.wait, { kind: 'evidence_change' });
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM tasks WHERE kind=\'discovery_review\' AND status=\'proposed\'').n, 0);
  await assert.rejects(h.command('discovery.assess', assessmentPayload(h, f.situationId)),
    { code: 'DISCOVERY_REASON_WAITING' });
  h.restart();
  await assert.rejects(h.command('discovery.assess', assessmentPayload(h, f.situationId)),
    { code: 'DISCOVERY_REASON_WAITING' });
  await h.ingest(source({ message_id: 'message:2', text: 'Evidence change unlocks assessment.' }));
  assert.equal((await h.command('discovery.assess', assessmentPayload(h, f.situationId))).status, 'OBSERVING');
  noEffects(h);
});

test('S2 WAIT deadline is durable, does not move on restart, and unlocks after the deadline', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  const h = harness(t), f = await candidate(h);
  const deadline = '2026-09-25T12:00:01.000Z';
  const result = await h.command('discovery.reason', reasonPayload(h, f, 'WAIT', { wait: { kind: 'deadline', at: deadline } }));
  assert.equal(result.status, 'OBSERVING');
  assert.deepEqual(result.wait, { kind: 'deadline', at: deadline });
  await assert.rejects(h.command('discovery.assess', assessmentPayload(h, f.situationId)),
    { code: 'DISCOVERY_REASON_WAITING' });
  h.restart();
  await assert.rejects(h.command('discovery.assess', assessmentPayload(h, f.situationId)),
    { code: 'DISCOVERY_REASON_WAITING' });
  t.mock.timers.tick(2000);
  assert.equal((await h.command('discovery.assess', assessmentPayload(h, f.situationId))).status, 'OBSERVING');
  noEffects(h);
});

test('S2 STOP closes only this Discovery situation and never touches person, engagement, or source authority', async t => {
  const h = harness(t), f = await candidate(h, 'CANDIDATE');
  const result = await h.command('discovery.reason', reasonPayload(h, f, 'STOP'));
  assert.equal(result.status, 'STOPPED');
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM tasks WHERE kind=\'discovery_review\' AND status=\'proposed\'').n, 0);
  assert.equal(h.detail(f.situationId).status, 'STOPPED');
  await assert.rejects(h.command('discovery.assess', assessmentPayload(h, f.situationId)), { code: /DISCOVERY_STALE/ });
  h.restart();
  assert.equal(h.detail(f.situationId).status, 'STOPPED');
  const next = await h.ingest(source({ message_id: 'message:2', text: 'A genuinely new event.' }));
  const row = h.store.get('SELECT situation_id FROM discovery_evidence WHERE source_event_id=?', next.source_event_id);
  assert.notEqual(row.situation_id, f.situationId);
  noEffects(h);
});

test('S2 reason is stale-safe, operator-only, strict, and idempotent', async t => {
  const h = harness(t), f = await candidate(h);
  await h.ingest(source({ version: 2, text: 'Edited before the reason decision.' }));
  await assert.rejects(h.command('discovery.reason', reasonPayload(h, f, 'IGNORE')), { code: /DISCOVERY_STALE/ });

  const fresh = await candidate(h);
  const request = id();
  const payload = reasonPayload(h, fresh, 'IGNORE');
  await assert.rejects(h.command('discovery.reason', payload, request, { kind: 'agent' }), { status: 403 });
  await assert.rejects(h.command('discovery.reason', { ...payload, unexpected: true }), { code: 'DISCOVERY_FIELDS_INVALID' });
  const result = await h.command('discovery.reason', payload, request);
  assert.equal(await h.command('discovery.reason', payload, request).then((value) => value.status), result.status);
  await assert.rejects(h.command('discovery.reason', { ...payload, reason: 'changed payload' }, request), { status: 409 });
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM events WHERE kind='discovery.reason.transitioned'").n, 1);
  noEffects(h);
});
