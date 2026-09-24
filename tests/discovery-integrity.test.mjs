// Offline Discovery integrity contract. No model, network, Telegram, or scheduler run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, id, hash } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { start } from '../business/server.mjs';
import { ROOT, readJson } from '../business/config.mjs';
import { sourceRows, sourceCheckpoint, digest } from '../business/source-ingestion.mjs';
import { applyTelegramDifference, bootstrapTelegramSource, disconnectTelegramSource } from '../business/sources/telegram-readonly.mjs';
import { exportPartner } from '../business/export.mjs';
import { assessmentFingerprint, invalidateRevokedDiscoverySources, staleMaterialEvidence } from '../business/discovery.mjs';

const offer = { id: 'offer-test', version: 'v1', text: 'Synthetic offer', criteria: ['scope'], exclusions: [] };
const baseTime = '2026-01-01T00:00:00.000Z';
function source(extra = {}) {
  return {
    source_id: 'public:discovery-fixture', source_kind: 'sanitized_fixture', message_id: 'message:1',
    author_id: 'user:1', display_name: 'Fixture user', thread_id: 'thread:1', reply_to_id: null,
    version: 1, operation: 'upsert', text: 'What does this offer include?', created_at: baseTime,
    updated_at: baseTime, ...extra,
  };
}
const TELEGRAM_SOURCE = 'telegram:channel:100';
const transportWire = (extra = {}) => ({ id: 1, channel_id: '100', from_id: { kind: 'user', id: '10' },
  post: false, text: 'What does this offer include?', date: 1767225600, ...extra });
const transportUpdate = (pts = 11, extra = {}) => ({ kind: 'new', channel_id: '100', pts, pts_count: 1,
  message: transportWire(), ...extra });
const transportPage = (from, to, updates = [], final = true) => ({ kind: from === to ? 'empty' : 'difference',
  account_id: '999', channel_id: '100', from_pts: from, to_pts: to, final, updates });

function config() {
  const value = readJson(path.join(ROOT, 'config/default.json'));
  value.opportunity = { ...value.opportunity, automatic: true, allowedSourceRefs: ['public:discovery-fixture'], activeOffer: structuredClone(offer) };
  value.discovery = { ...value.discovery, enabled: true, maxEvidence: 20, ttlSeconds: 604800, maxOpenSituations: 100 };
  value.runtime = { ...value.runtime, enabled: false, model: '', baseUrl: '' };
  value.telegram = { ...value.telegram, enabled: false, liveSending: false };
  return value;
}
function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-discovery-'));
  let store = new Store(directory);
  const settings = config();
  let service = new BusinessService(store, settings);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return {
    directory, settings, get store() { return store; }, get service() { return service; },
    command(action, payload, actor = { kind: 'operator' }, request = id()) { return service.command(action, payload, request, actor); },
    ingest(raw = source(), actor = { kind: 'channel', sourceId: raw.source_id }, request = id()) { return service.command('source.ingest', raw, request, actor); },
    sourceRows() { return sourceRows(service, 'public:discovery-fixture'); },
    situations() { return store.all('SELECT * FROM discovery_situations WHERE partner_id=? ORDER BY created_at,id', settings.partnerId); },
    evidence() { return store.all('SELECT * FROM discovery_evidence ORDER BY created_at,rowid'); },
    markers(kind) { return store.all('SELECT id,payload_json FROM events WHERE partner_id=? AND kind=? ORDER BY id', settings.partnerId, kind); },
    detail(idValue) { return service.discoveryDetail(idValue); },
    restart() { store.close(); store = new Store(directory); store.recover(); service = new BusinessService(store, settings); },
  };
}
function sourceEventId(h) { return h.sourceRows()[0].event_id; }
function counts(h) {
  return {
    source: h.store.get("SELECT COUNT(*) AS n FROM events WHERE kind='source.message'").n,
    evidence: h.evidence().length,
    applied: h.markers('discovery.observation.applied').length,
    pending: h.markers('discovery.observation.pending').length,
    failed: h.markers('discovery.observation.failed').length,
  };
}
function noExternalEffects(h, inboundMessages = 0, expectedPermissions = 0) {
  for (const table of ['drafts', 'approvals', 'delivery_attempts', 'outcome_events']) {
    assert.equal(h.store.get(`SELECT COUNT(*) AS n FROM ${table}`).n, 0, table);
  }
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM messages WHERE direction='out'").n, 0);
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM messages WHERE direction='in'").n, inboundMessages);
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM contact_permissions").n, expectedPermissions);
  assert.deepEqual(h.store.all('PRAGMA foreign_key_check'), []);
}

async function candidate(h) {
  const ingested = await h.ingest();
  const situationId = ingested.source_event_id ? h.situations()[0].id : null;
  const evidenceId = sourceEventId(h);
  const evidenceFingerprint = h.detail(situationId).evidence_fingerprint;
  return h.command('discovery.assess', {
    situation_id: situationId, expected_revision: h.situations()[0].revision,
    expected_evidence_fingerprint: evidenceFingerprint, decision: 'CANDIDATE',
    hypothesis: 'The bounded question may deserve operator attention.',
    why_now: 'The author explicitly asked about the offer.',
    evidence_event_ids: [evidenceId],
    opening_proposal: { text: 'I can explain the offer scope.', rationale: 'Answer the explicit question.', constraints: ['public review only'] },
  });
}

test('source truth and discovery application are separate, and source receipt has no derived state', async t => {
  const h = harness(t);
  const result = await h.ingest();
  assert.deepEqual(Object.keys(result).sort(), ['disposition', 'duplicate', 'source_event_id']);
  assert.equal(counts(h).source, 1); assert.equal(counts(h).evidence, 1); assert.equal(counts(h).applied, 1);
  noExternalEffects(h);
});

test('Telegram intake creates a durable pending marker and waits for a current checkpoint', async t => {
  const h = harness(t);
  h.settings.opportunity.telegramSources = [{ sourceId: TELEGRAM_SOURCE, accountId: '999', channelId: '100',
    sourceKind: 'sanitized_fixture', processingBasis: 'Offline Discovery transport fixture', maxLagSeconds: 120 }];
  h.settings.opportunity.allowedSourceRefs = [TELEGRAM_SOURCE];
  await bootstrapTelegramSource(h.service, TELEGRAM_SOURCE, { pts: 10, history: [] });
  await applyTelegramDifference(h.service, TELEGRAM_SOURCE, transportPage(10, 11, [transportUpdate()], false));
  assert.equal(sourceCheckpoint(h.service, TELEGRAM_SOURCE).phase, 'catching_up');
  assert.equal(h.markers('discovery.observation.pending').length, 1);
  assert.equal(h.markers('discovery.observation.applied').length, 0);
  assert.equal(h.situations().length, 0);
  const deferred = h.service.reconcileDiscovery();
  assert.equal(deferred.deferred, 1);
  assert.equal(deferred.processed, 0);
  await applyTelegramDifference(h.service, TELEGRAM_SOURCE, transportPage(11, 11));
  const applied = h.service.reconcileDiscovery();
  assert.equal(applied.processed, 1);
  assert.equal(applied.failed, 0);
  assert.equal(h.situations().length, 1);
  const situationId = h.situations()[0].id;
  assert.equal(h.detail(situationId).freshness.fresh, true);
  await disconnectTelegramSource(h.service, TELEGRAM_SOURCE);
  assert.equal(h.detail(situationId).freshness.fresh, false);
  noExternalEffects(h);
});

test('bootstrap history remains context-only and never becomes a Discovery signal', async t => {
  const h = harness(t);
  h.settings.opportunity.telegramSources = [{ sourceId: TELEGRAM_SOURCE, accountId: '999', channelId: '100',
    sourceKind: 'sanitized_fixture', processingBasis: 'Offline Discovery bootstrap fixture', maxLagSeconds: 120 }];
  h.settings.opportunity.allowedSourceRefs = [TELEGRAM_SOURCE];
  await bootstrapTelegramSource(h.service, TELEGRAM_SOURCE, { pts: 10, history: [transportWire({ id: 7 })] });
  await applyTelegramDifference(h.service, TELEGRAM_SOURCE, transportPage(10, 10));
  const historical = String(h.store.get("SELECT id FROM events WHERE kind='source.message' ORDER BY id LIMIT 1").id);
  await assert.rejects(h.command('discovery.observe', { source_event_id: historical, context_key: 'none:',
    purpose: h.settings.discovery.purpose }, { kind: 'operator' }), { code: 'DISCOVERY_SYSTEM_ONLY' });
  const result = h.service.reconcileDiscovery();
  assert.equal(result.processed, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.deferred, 0);
  assert.equal(h.markers('discovery.observation.pending').length, 0);
  assert.equal(h.evidence().length, 0);
  assert.equal(h.situations().length, 0);
  noExternalEffects(h);
});

test('canonical context keys distinguish null thread from literal root thread', async t => {
  const h = harness(t);
  await h.ingest(source({ message_id: 'message:null-thread', thread_id: null, text: 'No thread' }));
  await h.ingest(source({ message_id: 'message:root-thread', thread_id: 'root', text: 'Thread named root' }));
  const rows = h.situations();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.context_key).sort(), ['none:', 'thread:root']);
  assert.equal(h.evidence().length, 2);
  assert.equal(h.markers('discovery.observation.failed').length, 0);
  assert.equal(rows.every(row => h.detail(row.id).freshness.fresh), true);
  noExternalEffects(h);
});

test('source allowlist revocation blocks existing review and pending projection', async t => {
  const h = harness(t);
  const first = await candidate(h);
  const detail = h.detail(h.situations()[0].id);
  h.settings.opportunity.allowedSourceRefs = [];
  assert.equal(h.detail(detail.id).freshness.fresh, false);
  await assert.rejects(h.command('discovery.review', { task_id: first.review_task_id,
    expected_revision: detail.revision, expected_evidence_fingerprint: detail.evidence_fingerprint, decision: 'approve' }),
  { code: /DISCOVERY_STALE/ });

  const pending = harness(t);
  const original = pending.service.discoveryApply;
  try {
    pending.service.discoveryApply = () => { throw new Error('synthetic TX2 failure'); };
    await pending.ingest(source(), { kind: 'channel', sourceId: source().source_id }, 'revoked-pending');
  } finally { pending.service.discoveryApply = original; }
  pending.settings.opportunity.allowedSourceRefs = [];
  const blocked = pending.service.reconcileDiscovery();
  assert.equal(blocked.processed, 0);
  assert.equal(blocked.failed, 0);
  assert.equal(blocked.deferred, 0);
  assert.ok(pending.markers('discovery.observation.applied')
    .map(row => JSON.parse(row.payload_json)).some(row => row.projection_status === 'source_revoked'));
  pending.settings.opportunity.allowedSourceRefs = ['public:discovery-fixture'];
  const restored = pending.service.reconcileDiscovery();
  assert.equal(restored.processed, 0);
  assert.equal(restored.failed, 0);
  assert.equal(pending.situations().length, 0);
  assert.equal(pending.evidence().length, 0);
  noExternalEffects(h);
  noExternalEffects(pending);
});

test('malformed allowlist is a configuration error, not source revocation', async t => {
  const h = harness(t);
  await candidate(h);
  const before = h.situations()[0];
  h.settings.opportunity.allowedSourceRefs = 'public:discovery-fixture';
  await assert.rejects(h.ingest(source({ message_id: 'message:malformed-allowlist' })),
    { code: 'INVALID_SOURCE_ALLOWLIST' });
  assert.equal(h.situations().find(row => row.id === before.id).status, before.status);
  assert.throws(() => staleMaterialEvidence(h.service), { code: 'INVALID_SOURCE_ALLOWLIST' });
  noExternalEffects(h);
});

test('startup validates allowlist before creating Store', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const base = readJson(path.join(ROOT, 'config/default.json'));
  for (const allowedSourceRefs of ['public:discovery-fixture', ['public:discovery-fixture', 42]]) {
    const config = structuredClone(base);
    config.opportunity.allowedSourceRefs = allowedSourceRefs;
    await assert.rejects(start({ config, directory }), /Invalid opportunity\.allowedSourceRefs/);
    assert.equal(fs.existsSync(path.join(directory, 'partner.sqlite')), false);
  }
});

test('startup validates Telegram source policy before creating Store', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-telegram-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const base = readJson(path.join(ROOT, 'config/default.json'));
  base.opportunity.allowedSourceRefs = [TELEGRAM_SOURCE];
  const valid = { sourceId: TELEGRAM_SOURCE, accountId: '999', channelId: '100',
    sourceKind: 'sanitized_fixture', processingBasis: 'Offline config fixture', maxLagSeconds: 120 };
  for (const telegramSources of [TELEGRAM_SOURCE, [TELEGRAM_SOURCE], [{ sourceId: TELEGRAM_SOURCE }],
    [{ ...valid, extra: true }], [{ ...valid, accountId: '12345678901234567890' }]]) {
    const config = structuredClone(base);
    config.opportunity.telegramSources = telegramSources;
    await assert.rejects(start({ config, directory }), /Invalid opportunity\.telegramSources/);
    assert.equal(fs.existsSync(path.join(directory, 'partner.sqlite')), false);
  }
});

test('Telegram policy uses the same strict allowlist validation', async t => {
  const h = harness(t);
  h.settings.opportunity.telegramSources = [{ sourceId: TELEGRAM_SOURCE, accountId: '999', channelId: '100',
    sourceKind: 'sanitized_fixture', processingBasis: 'Offline malformed allowlist fixture', maxLagSeconds: 120 }];
  h.settings.opportunity.allowedSourceRefs = TELEGRAM_SOURCE;
  await assert.rejects(bootstrapTelegramSource(h.service, TELEGRAM_SOURCE, { pts: 10, history: [] }),
    { code: 'INVALID_SOURCE_ALLOWLIST' });
  noExternalEffects(h);
});

test('stale or transiently fenced discovery review can be rejected without external effects', async t => {
  const h = harness(t);
  const first = await candidate(h);
  const detail = h.detail(h.situations()[0].id);
  h.settings.opportunity.allowedSourceRefs = [];
  const rejected = await h.command('discovery.review', { task_id: first.review_task_id,
    expected_revision: detail.revision, expected_evidence_fingerprint: detail.evidence_fingerprint, decision: 'reject' });
  assert.equal(rejected.status, 'DISMISSED');
  assert.equal(h.store.get('SELECT status FROM tasks WHERE id=?', first.review_task_id).status, 'done');
  assert.equal(h.situations()[0].status, 'DISMISSED');
  noExternalEffects(h);
});

test('review remains rejectable after TTL cleanup materializes stale state', async t => {
  const h = harness(t);
  h.settings.discovery.ttlSeconds = 60;
  const first = await candidate(h);
  const row = h.situations()[0];
  h.store.run('UPDATE discovery_situations SET expires_at=? WHERE id=?', '2000-01-01T00:00:00.000Z', row.id);
  await h.ingest(source({ message_id: 'message:ttl-trigger', author_id: 'user:ttl-trigger', thread_id: 'thread:ttl-trigger' }));
  assert.equal(h.situations().find(item => item.id === row.id).status, 'STALE');
  assert.equal(h.store.get('SELECT status FROM tasks WHERE id=?', first.review_task_id).status, 'proposed');
  const detail = h.detail(row.id);
  const rejected = await h.command('discovery.review', { task_id: first.review_task_id,
    expected_revision: detail.revision, expected_evidence_fingerprint: detail.evidence_fingerprint, decision: 'reject' });
  assert.equal(rejected.status, 'DISMISSED');
  assert.equal(h.store.get('SELECT status FROM tasks WHERE id=?', first.review_task_id).status, 'done');
  noExternalEffects(h);
});

test('same request and different request for one source event do not duplicate evidence or revision', async t => {
  const h = harness(t);
  const initial = await h.ingest(source(), { kind: 'channel', sourceId: source().source_id }, 'request-1');
  const first = h.situations()[0];
  const differentRequest = await h.ingest(source(), { kind: 'channel', sourceId: source().source_id }, 'request-2');
  const sameRequest = await h.command('source.ingest', source(), { kind: 'channel', sourceId: source().source_id }, 'request-1');
  assert.equal(differentRequest.duplicate, true);
  assert.deepEqual(sameRequest, initial);
  assert.equal(h.evidence().length, 1); assert.equal(h.situations()[0].revision, first.revision);
  assert.equal(counts(h).applied, 1); noExternalEffects(h);
});

test('source.ingest recovery marker is created by the public command and can be drained after restart', async t => {
  const h = harness(t);
  const pendingSource = source();
  const sourceId = pendingSource.source_id;
  const original = h.service.discoveryApply;
  try {
    h.service.discoveryApply = () => { throw new Error('synthetic TX2 failure'); };
    await h.ingest(pendingSource, { kind: 'channel', sourceId }, 'crash-request');
  } finally {
    h.service.discoveryApply = original;
  }
  assert.equal(h.markers('discovery.observation.pending').length, 1);
  assert.equal(h.markers('discovery.observation.applied').length, 0);
  h.restart();
  const result = h.service.reconcileDiscovery();
  assert.equal(result.processed, 1);
  assert.equal(h.markers('discovery.observation.applied').length, 1);
  assert.equal(h.evidence().length, 1);
  noExternalEffects(h);
});

test('reconciliation closes superseded and non-observable pending markers without retry poisoning', async t => {
  const h = harness(t);
  const original = h.service.discoveryApply;
  let first;
  try {
    h.service.discoveryApply = () => { throw new Error('synthetic TX2 failure'); };
    first = await h.ingest(source(), { kind: 'channel', sourceId: source().source_id }, 'pending-v1');
  } finally { h.service.discoveryApply = original; }
  const current = await h.ingest(source({ version: 2, text: 'Current version', updated_at: '2026-01-01T00:01:00.000Z' }));
  assert.ok(current.source_event_id);
  const channel = await h.ingest(source({ message_id: 'message:channel', author_id: 'channel:100', version: 1,
    text: 'Channel post', updated_at: '2026-01-01T00:01:00.000Z' }));
  assert.ok(channel.source_event_id);
  const result = h.service.reconcileDiscovery();
  assert.equal(result.processed, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.deferred, 0);
  const applied = h.markers('discovery.observation.applied').map(row => JSON.parse(row.payload_json));
  assert.ok(applied.some(row => row.source_event_id === first.source_event_id && row.projection_status === 'source_superseded'));
  assert.ok(applied.some(row => row.projection_status === 'subject_unavailable'));
  assert.equal(h.evidence().length, 1);
  noExternalEffects(h);
});

test('re-enable after a source change stales old evidence before quota lookup', async t => {
  const h = harness(t);
  h.settings.discovery.maxOpenSituations = 1;
  const first = await candidate(h);
  const old = h.situations()[0];

  h.settings.discovery.enabled = false;
  const disabled = await h.ingest(source({ version: 2, text: 'Edited while Discovery was disabled', updated_at: '2026-01-01T00:01:00.000Z' }));
  assert.equal(h.markers('discovery.observation.pending').filter(row => JSON.parse(row.payload_json).source_event_id === String(disabled.source_event_id)).length, 0);

  h.settings.discovery.enabled = true;
  await h.ingest(source({ message_id: 'message:after-reenable', text: 'A new same-scope observation' }));
  const rows = h.situations();
  assert.equal(rows.find(row => row.id === old.id).status, 'STALE');
  assert.equal(h.store.get('SELECT status FROM tasks WHERE id=?', first.review_task_id).status, 'cancelled');
  const active = rows.filter(row => ['OBSERVING', 'CANDIDATE'].includes(row.status));
  assert.equal(active.length, 1);
  assert.notEqual(active[0].id, old.id);
  assert.equal(h.detail(active[0].id).freshness.fresh, true);
  noExternalEffects(h);
});

test('re-enable after a disabled delete stales old evidence before quota lookup', async t => {
  const h = harness(t);
  h.settings.discovery.maxOpenSituations = 1;
  const first = await candidate(h);
  const old = h.situations()[0];

  h.settings.discovery.enabled = false;
  const deleted = await h.ingest(source({ version: 2, operation: 'delete', text: null, updated_at: '2026-01-01T00:01:00.000Z' }));
  assert.equal(h.markers('discovery.observation.pending').filter(row => JSON.parse(row.payload_json).source_event_id === String(deleted.source_event_id)).length, 0);

  h.settings.discovery.enabled = true;
  await h.ingest(source({ message_id: 'message:after-delete-reenable', text: 'A new observation after deletion' }));
  const rows = h.situations();
  assert.equal(rows.find(row => row.id === old.id).status, 'STALE');
  assert.equal(h.store.get('SELECT status FROM tasks WHERE id=?', first.review_task_id).status, 'cancelled');
  const active = rows.filter(row => ['OBSERVING', 'CANDIDATE'].includes(row.status));
  assert.equal(active.length, 1);
  assert.notEqual(active[0].id, old.id);
  assert.equal(h.detail(active[0].id).freshness.fresh, true);
  noExternalEffects(h);
});

test('upsert edit invalidates the dependent situation and the old review task', async t => {
  const h = harness(t);
  const first = await candidate(h);
  assert.ok(first.review_task_id);
  const old = h.situations()[0];
  await h.ingest(source({ version: 2, text: 'Updated question', updated_at: '2026-01-01T00:01:00.000Z' }), { kind: 'channel', sourceId: source().source_id });
  assert.equal(h.situations().find(row => row.id === old.id).status, 'STALE');
  assert.equal(h.store.get("SELECT status FROM tasks WHERE id=?", first.review_task_id).status, 'cancelled');
  noExternalEffects(h);
});

test('cross-context edits stale the old situation before creating a new scope', async t => {
  const h = harness(t);
  const first = await candidate(h);
  const old = h.situations()[0];
  await h.ingest(source({ version: 2, thread_id: 'thread:2', text: 'Updated in another context', updated_at: '2026-01-01T00:01:00.000Z' }));
  assert.equal(h.situations().find(row => row.id === old.id).status, 'STALE');
  assert.equal(h.store.get("SELECT status FROM tasks WHERE id=?", first.review_task_id).status, 'cancelled');
  assert.equal(h.situations().filter(row => row.status === 'OBSERVING').length, 1);
  noExternalEffects(h);
});

test('delete and unsupported source versions invalidate dependent situations', async t => {
  const h = harness(t);
  const first = await candidate(h);
  const old = h.situations()[0];
  await h.ingest(source({ version: 2, operation: 'delete', text: null, updated_at: '2026-01-01T00:01:00.000Z' }), { kind: 'channel', sourceId: source().source_id });
  assert.equal(h.situations().find(row => row.id === old.id).status, 'STALE');
  await h.ingest(source({ message_id: 'message:2', version: 1, text: 'A second bounded question', updated_at: '2026-01-01T00:01:00.000Z' }), { kind: 'channel', sourceId: source().source_id });
  const second = h.situations().find(row => row.id !== old.id);
  assert.ok(second);
  await h.ingest(source({ message_id: 'message:2', version: 2, operation: 'unsupported', text: null, updated_at: '2026-01-01T00:02:00.000Z', unsupported: { reason: 'media', fingerprint: 'a'.repeat(64) } }), { kind: 'channel', sourceId: source().source_id });
  assert.equal(h.situations().find(row => row.id === second.id).status, 'STALE');
  assert.equal(counts(h).failed, 0); noExternalEffects(h);
});

test('assessment requires current revision and evidence fingerprint; only CANDIDATE can approve', async t => {
  const h = harness(t);
  const first = await candidate(h);
  const detail = h.detail(h.situations()[0].id);
  await assert.rejects(h.command('discovery.assess', { situation_id: detail.id, expected_revision: detail.revision + 1, expected_evidence_fingerprint: detail.evidence_fingerprint, decision: 'OBSERVE', hypothesis: 'x', why_now: 'y', evidence_event_ids: [sourceEventId(h)] }), { code: 'DISCOVERY_REVISION_CONFLICT' });
  await assert.rejects(h.command('discovery.assess', { situation_id: detail.id, expected_revision: detail.revision, expected_evidence_fingerprint: '0'.repeat(64), decision: 'OBSERVE', hypothesis: 'x', why_now: 'y', evidence_event_ids: [sourceEventId(h)] }), { code: 'DISCOVERY_EVIDENCE_FINGERPRINT_CONFLICT' });
  const reviewPayload = { task_id: first.review_task_id, expected_revision: detail.revision, expected_evidence_fingerprint: detail.evidence_fingerprint };
  const approved = await h.command('discovery.review', { ...reviewPayload, decision: 'approve' });
  assert.equal(approved.status, 'CANDIDATE');
  assert.equal(h.situations()[0].status, 'CANDIDATE');
  assert.equal(h.store.get("SELECT status FROM tasks WHERE id=?", first.review_task_id).status, 'done');
  const approval = JSON.parse(h.store.get("SELECT payload_json FROM events WHERE kind='discovery.review.approved' ORDER BY id DESC LIMIT 1").payload_json);
  assert.equal(approval.assessment_id, first.assessment_id);
  noExternalEffects(h);
});

test('assessment fingerprint binds selected evidence IDs independent of order', () => {
  const base = { situationId: 'situation-test', revision: 2, evidenceFingerprintValue: 'full-evidence',
    decision: 'OBSERVE', hypothesis: 'Bounded hypothesis', whyNow: 'Bounded reason', opening: null };
  const first = assessmentFingerprint({ ...base, evidenceEventIds: ['2', '1'] });
  const reordered = assessmentFingerprint({ ...base, evidenceEventIds: ['1', '2'] });
  const subset = assessmentFingerprint({ ...base, evidenceEventIds: ['1'] });
  assert.equal(first, reordered);
  assert.notEqual(first, subset);
});

test('a new assessment cancels the previous proposed review and creates one current card', async t => {
  const h = harness(t);
  const first = await candidate(h);
  const detail = h.detail(h.situations()[0].id);
  const second = await h.command('discovery.assess', {
    situation_id: detail.id, expected_revision: detail.revision,
    expected_evidence_fingerprint: detail.evidence_fingerprint, decision: 'CANDIDATE',
    hypothesis: 'A second bounded assessment supersedes the first review.',
    why_now: 'The operator is reviewing the current evidence again.',
    evidence_event_ids: [sourceEventId(h)],
    opening_proposal: { text: 'Current bounded opening.', rationale: 'Current assessment.', constraints: [] },
  });
  assert.equal(h.store.get("SELECT status FROM tasks WHERE id=?", first.review_task_id).status, 'cancelled');
  assert.equal(second.review_task_id !== first.review_task_id, true);
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM tasks WHERE kind='discovery_review' AND status='proposed'").n, 1);
  noExternalEffects(h);
});

test('a pending same-scope observation fences approval until reconciliation', async t => {
  const h = harness(t);
  const first = await candidate(h);
  const detail = h.detail(h.situations()[0].id);
  const original = h.service.discoveryApply;
  try {
    h.service.discoveryApply = () => { throw new Error('synthetic pending TX2 failure'); };
    await h.ingest(source({ message_id: 'message:pending', version: 1, text: 'New same-scope evidence' }));
  } finally { h.service.discoveryApply = original; }
  const fenced = h.detail(detail.id);
  assert.equal(fenced.freshness.fresh, false);
  assert.ok(fenced.freshness.reasons.includes('DISCOVERY_PENDING_SOURCE_CHANGE'));
  await assert.rejects(h.command('discovery.review', { task_id: first.review_task_id,
    expected_revision: detail.revision, expected_evidence_fingerprint: detail.evidence_fingerprint, decision: 'approve' }),
  { code: /DISCOVERY_STALE/ });
  const reconciled = h.service.reconcileDiscovery();
  assert.equal(reconciled.processed, 1);
  assert.equal(h.situations()[0].status, 'OBSERVING');
  assert.equal(h.store.get("SELECT status FROM tasks WHERE id=?", first.review_task_id).status, 'cancelled');
  assert.equal(h.evidence().length, 2);
  noExternalEffects(h);
});

test('evidence cap starts a new generation without retry poisoning', async t => {
  const h = harness(t);
  h.settings.discovery.maxEvidence = 1;
  const first = await candidate(h);
  const old = h.situations()[0];
  await h.ingest(source({ message_id: 'message:cap-next', text: 'Another bounded observation' }));
  const rows = h.situations();
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.id === old.id).status, 'STALE');
  assert.equal(h.store.get('SELECT status FROM tasks WHERE id=?', first.review_task_id).status, 'cancelled');
  const current = rows.find(row => row.id !== old.id);
  assert.equal(current.status, 'OBSERVING');
  assert.equal(h.evidence().length, 2);
  assert.equal(h.markers('discovery.observation.applied').length, 2);
  assert.equal(h.markers('discovery.observation.failed').length, 0);
  noExternalEffects(h);
});

test('older OPEN_LIMIT event cannot roll a newer generation backward', async t => {
  const h = harness(t);
  h.settings.discovery.maxOpenSituations = 1;
  h.settings.discovery.maxEvidence = 1;
  const occupant = await h.ingest(source({ message_id: 'message:obsolete-occupant', author_id: 'user:occupant',
    thread_id: 'thread:occupant', text: 'Occupies the only slot' }));
  assert.ok(occupant.source_event_id);
  assert.equal(h.situations().length, 1);
  const original = h.service.discoveryApply;
  let older;
  try {
    h.service.discoveryApply = () => { throw Object.assign(new Error('synthetic quota failure'), { code: 'DISCOVERY_OPEN_LIMIT' }); };
    older = await h.ingest(source({ message_id: 'message:obsolete-A', text: 'Older deferred observation' }));
  } finally { h.service.discoveryApply = original; }
  await h.ingest(source({ message_id: 'message:obsolete-occupant', author_id: 'user:occupant',
    thread_id: 'thread:occupant', version: 2, operation: 'delete', text: null,
    updated_at: '2026-01-01T00:01:00.000Z' }));
  const newer = await h.ingest(source({ message_id: 'message:obsolete-B', text: 'Newer current observation' }));
  const current = h.situations().find(row => row.status === 'OBSERVING');
  assert.ok(current);
  assert.equal(current.source_ref, source().source_id);

  const result = h.service.reconcileDiscovery();
  assert.equal(result.processed, 1);
  assert.equal(result.failed, 0);
  assert.equal(h.situations().find(row => row.id === current.id).status, 'OBSERVING');
  assert.equal(h.evidence().filter(row => row.situation_id === current.id).length, 1);
  const applied = h.markers('discovery.observation.applied').map(row => JSON.parse(row.payload_json));
  assert.equal(applied.find(row => row.source_event_id === older.source_event_id).projection_status, 'source_obsolete');
  assert.equal(applied.find(row => row.source_event_id === newer.source_event_id).projection_status, 'OBSERVING');
  noExternalEffects(h);
});

test('delayed pending observation expires against its source observation time', async t => {
  const h = harness(t);
  h.settings.discovery.ttlSeconds = 60;
  const original = h.service.discoveryApply;
  let ingested;
  try {
    h.service.discoveryApply = () => { throw new Error('synthetic delayed pending'); };
    ingested = await h.ingest(source({ message_id: 'message:delayed', version: 1, text: 'Old observation' }));
  } finally { h.service.discoveryApply = original; }
  h.store.run("DELETE FROM events WHERE kind='discovery.observation.failed' AND json_extract(payload_json,'$.source_event_id')=?", ingested.source_event_id);
  h.store.run("UPDATE events SET created_at=? WHERE kind='source.message' AND id=?", '2020-01-01T00:00:00.000Z', ingested.source_event_id);
  const result = h.service.reconcileDiscovery();
  assert.equal(result.processed, 1);
  assert.equal(result.failed, 0);
  assert.equal(h.situations().length, 0);
  assert.equal(h.evidence().length, 0);
  const applied = h.markers('discovery.observation.applied').map(row => JSON.parse(row.payload_json));
  assert.equal(applied.find(row => row.source_event_id === ingested.source_event_id).projection_status, 'source_expired');
  assert.equal(h.markers('discovery.observation.failed').length, 0);
  noExternalEffects(h);
});

test('expired delayed event cannot attach to an existing live generation', async t => {
  const h = harness(t);
  h.settings.discovery.ttlSeconds = 60;
  const original = h.service.discoveryApply;
  let delayed;
  let fresh;
  try {
    h.service.discoveryApply = () => { throw new Error('synthetic delayed pending'); };
    delayed = await h.ingest(source({ message_id: 'message:expired-existing', text: 'Expired delayed observation' }));
    h.store.run("DELETE FROM events WHERE kind='discovery.observation.failed' AND json_extract(payload_json,'$.source_event_id')=?", delayed.source_event_id);
    h.store.run("UPDATE events SET created_at=? WHERE kind='source.message' AND id=?", '2020-01-01T00:00:00.000Z', delayed.source_event_id);
    h.service.discoveryApply = original;
    fresh = await h.ingest(source({ message_id: 'message:fresh-existing', text: 'Fresh live observation' }));
  } finally { h.service.discoveryApply = original; }
  const result = h.service.reconcileDiscovery();
  assert.equal(result.processed, 1);
  assert.equal(result.failed, 0);
  assert.equal(h.situations().length, 1);
  assert.equal(h.evidence().length, 1);
  assert.equal(h.evidence()[0].source_event_id, Number(fresh.source_event_id));
  const applied = h.markers('discovery.observation.applied').map(row => JSON.parse(row.payload_json));
  assert.equal(applied.find(row => row.source_event_id === delayed.source_event_id).projection_status, 'source_expired');
  assert.equal(h.markers('discovery.observation.failed').length, 0);
  noExternalEffects(h);
});

test('unseen corrective source event is not starved by failed pending events', async t => {
  const h = harness(t);
  h.settings.discovery.maxOpenSituations = 1;
  const occupant = await h.ingest(source({ message_id: 'message:occupant', version: 1, text: 'Occupies quota' }));
  const occupantSituationId = h.store.get('SELECT situation_id FROM discovery_evidence WHERE source_event_id=?', occupant.source_event_id).situation_id;
  const original = h.service.discoveryApply;
  let deletion;
  try {
    h.service.discoveryApply = () => { throw Object.assign(new Error('synthetic quota failure'), { code: 'DISCOVERY_OPEN_LIMIT' }); };
    for (let index = 0; index < 50; index++) {
      await h.ingest(source({ message_id: `message:blocked:${index}`, text: 'Blocked by quota' }));
    }
    h.service.discoveryApply = () => ({ status: 'deferred' });
    deletion = await h.ingest(source({ message_id: 'message:occupant', version: 2, operation: 'delete',
      text: null, updated_at: '2026-01-01T00:01:00.000Z' }));
  } finally { h.service.discoveryApply = original; }
  const result = h.service.reconcileDiscovery();
  assert.ok(result.processed >= 1);
  const applied = h.markers('discovery.observation.applied').map(row => JSON.parse(row.payload_json));
  assert.ok(applied.some(row => row.source_event_id === deletion.source_event_id && row.projection_status === 'source_deleted'));
  assert.equal(h.store.get('SELECT status FROM discovery_situations WHERE id=?', occupantSituationId).status, 'STALE');
  assert.equal(occupant.source_event_id !== deletion.source_event_id, true);
  noExternalEffects(h);
});

test('transient failed source keeps source order while quota failures are deprioritized', async t => {
  const h = harness(t);
  h.settings.discovery.maxEvidence = 1;
  const original = h.service.discoveryApply;
  let first;
  let second;
  try {
    h.service.discoveryApply = () => { throw new Error('synthetic transient TX2 failure'); };
    first = await h.ingest(source({ message_id: 'message:order-a', text: 'Older observation' }));
    h.service.discoveryApply = () => ({ status: 'deferred' });
    second = await h.ingest(source({ message_id: 'message:order-b', text: 'Newer observation' }));
  } finally { h.service.discoveryApply = original; }
  const result = h.service.reconcileDiscovery();
  assert.equal(result.processed, 2);
  const rows = h.situations();
  assert.equal(rows.length, 2);
  const current = rows.find(row => ['OBSERVING', 'CANDIDATE'].includes(row.status));
  assert.equal(current.status, 'OBSERVING');
  assert.equal(h.evidence().find(row => row.situation_id === current.id).source_event_id, Number(second.source_event_id));
  assert.equal(h.markers('discovery.observation.failed').length, 1);
  noExternalEffects(h);
});

test('generic task commands cannot mutate a discovery review card', async t => {
  const h = harness(t);
  const first = await candidate(h);
  for (const action of ['task.approve', 'task.retry', 'task.cancel']) {
    await assert.rejects(h.command(action, { task_id: first.review_task_id }), { code: 'candidate_not_executable' });
  }
  noExternalEffects(h);
});

test('TTL expiry and maxOpen cleanup are deterministic', async t => {
  const h = harness(t);
  h.settings.discovery.ttlSeconds = 60;
  h.settings.discovery.maxOpenSituations = 1;
  await h.ingest();
  const row = h.situations()[0];
  await h.ingest(source({ message_id: 'message:2', author_id: 'user:2', version: 1, text: 'Second', updated_at: '2026-01-01T00:01:00.000Z' }));
  assert.equal(h.situations().filter(item => item.status === 'OBSERVING').length, 1);
  assert.equal(h.markers('discovery.observation.failed').length, 1);
  h.store.run('UPDATE discovery_situations SET expires_at=? WHERE id=?', '2000-01-01T00:00:00.000Z', row.id);
  const afterExpiry = h.service.reconcileDiscovery();
  assert.equal(afterExpiry.processed, 1);
  assert.equal(afterExpiry.failed, 0);
  assert.equal(h.situations().find(item => item.id === row.id).status, 'STALE');
  assert.equal(h.situations().filter(item => item.status === 'OBSERVING').length, 1);
  noExternalEffects(h);
});

test('lowered maxOpen still cleans a materially stale hidden generation', async t => {
  const h = harness(t);
  h.settings.discovery.maxOpenSituations = 2;
  const first = source({ message_id: 'message:limit-clean-1', author_id: 'user:limit-1', thread_id: 'thread:limit-1' });
  const second = source({ message_id: 'message:limit-clean-2', author_id: 'user:limit-2', thread_id: 'thread:limit-2' });
  await h.ingest(first);
  await h.ingest(second);
  const secondSituation = h.situations().find(row => row.subject_ref === 'user:limit-2');
  assert.ok(secondSituation);

  h.settings.discovery.enabled = false;
  await h.ingest(source({ message_id: 'message:limit-clean-2', author_id: 'user:limit-2', thread_id: 'thread:limit-2',
    version: 2, text: 'Materially changed while disabled', updated_at: '2026-01-01T00:01:00.000Z' }));
  h.settings.discovery.maxOpenSituations = 1;
  h.settings.discovery.enabled = true;
  const third = await h.ingest(source({ message_id: 'message:limit-clean-3', author_id: 'user:limit-3', thread_id: 'thread:limit-3' }));

  assert.equal(h.situations().find(row => row.id === secondSituation.id).status, 'STALE');
  assert.equal(h.evidence().some(row => row.situation_id === secondSituation.id), true);
  assert.equal(h.situations().some(row => row.subject_ref === 'user:limit-3'), false);
  assert.ok(h.markers('discovery.observation.failed').map(row => JSON.parse(row.payload_json))
    .some(row => row.source_event_id === String(third.source_event_id) && row.code === 'DISCOVERY_OPEN_LIMIT'));
  noExternalEffects(h);
});

test('material-stale cleanup batches current source state once per source', async t => {
  const h = harness(t);
  const refs = Array.from({ length: 3 }, (_, index) => `public:batch:${index}`);
  h.settings.opportunity.allowedSourceRefs = refs;
  h.settings.discovery.enabled = false;
  for (const sourceRef of refs) {
    for (let index = 0; index < 20; index++) {
      await h.ingest(source({ source_id: sourceRef, message_id: `unrelated:${sourceRef}:${index}` }),
        { kind: 'channel', sourceId: sourceRef });
    }
  }
  h.settings.discovery.enabled = true;
  for (const sourceRef of refs) {
    await h.ingest(source({ source_id: sourceRef, message_id: `referenced:${sourceRef}` }),
      { kind: 'channel', sourceId: sourceRef });
  }
  const originalAll = h.service.store.all;
  let sourceScans = 0, filteredRows = 0;
  h.service.store.all = function instrumentedAll(sql, ...params) {
    const result = originalAll.call(this, sql, ...params);
    if (sql.includes('SELECT e.id,e.created_at,e.payload_json')) sourceScans++;
    if (sql.includes('json_each')) filteredRows = Math.max(filteredRows, result.length);
    return result;
  };
  try { staleMaterialEvidence(h.service); } finally { h.service.store.all = originalAll; }
  assert.equal(sourceScans, refs.length);
  assert.equal(filteredRows, 1);
  noExternalEffects(h);
});

test('freshness and assessment batch current source state at maxEvidence', async t => {
  const h = harness(t);
  h.settings.discovery.maxEvidence = 100;
  for (let index = 0; index < 100; index++) {
    await h.ingest(source({ message_id: `message:assess-batch:${index}` }));
  }
  const row = h.situations()[0], evidence = h.evidence();
  assert.equal(evidence.length, 100);
  const originalAll = h.service.store.all;
  let sourceScans = 0;
  h.service.store.all = function instrumentedAll(sql, ...params) {
    if (sql.includes('SELECT e.id,e.created_at,e.payload_json')) sourceScans++;
    return originalAll.call(this, sql, ...params);
  };
  try {
    const detail = h.detail(row.id);
    assert.equal(sourceScans, 1);
    sourceScans = 0;
    await h.command('discovery.assess', { situation_id: row.id, expected_revision: row.revision,
      expected_evidence_fingerprint: detail.evidence_fingerprint, decision: 'OBSERVE',
      hypothesis: 'Batched currentness check', why_now: 'Assessment should reuse the batch',
      evidence_event_ids: evidence.map(item => String(item.source_event_id)) });
    assert.equal(sourceScans, 1);
  } finally { h.service.store.all = originalAll; }
  noExternalEffects(h);
});

test('permanently revoked source releases maxOpen before another source projection', async t => {
  const h = harness(t);
  h.settings.discovery.maxOpenSituations = 1;
  await h.ingest(source({ message_id: 'message:revoked-A', author_id: 'user:revoked-A', thread_id: 'thread:revoked-A' }));
  const revoked = h.situations()[0];
  h.settings.opportunity.allowedSourceRefs = ['public:allowed-B'];
  const allowed = await h.ingest(source({ source_id: 'public:allowed-B', message_id: 'message:allowed-B',
    author_id: 'user:allowed-B', thread_id: 'thread:allowed-B' }));
  assert.ok(allowed.source_event_id);
  assert.equal(h.situations().find(row => row.id === revoked.id).status, 'STALE');
  assert.ok(h.situations().some(row => row.source_ref === 'public:allowed-B' && row.status === 'OBSERVING'));
  noExternalEffects(h);
});

test('revoked active situation is invalidated at startup cleanup without pending events', async t => {
  const h = harness(t);
  const first = await candidate(h);
  const old = h.situations()[0];
  h.settings.opportunity.allowedSourceRefs = [];
  h.restart();
  const count = invalidateRevokedDiscoverySources(h.service);
  assert.equal(count, 1);
  assert.equal(h.situations().find(row => row.id === old.id).status, 'STALE');
  assert.equal(h.store.get('SELECT status FROM tasks WHERE id=?', first.review_task_id).status, 'cancelled');
  h.settings.opportunity.allowedSourceRefs = ['public:discovery-fixture'];
  assert.equal(h.detail(old.id).freshness.fresh, false);
  noExternalEffects(h);
});

test('revoked pending is terminalized during disabled startup maintenance', async t => {
  const h = harness(t);
  const original = h.service.discoveryApply;
  let ingested;
  try {
    h.service.discoveryApply = () => { throw new Error('synthetic disabled-startup pending'); };
    ingested = await h.ingest(source({ message_id: 'message:disabled-startup-pending' }));
  } finally { h.service.discoveryApply = original; }
  h.settings.discovery.enabled = false;
  h.settings.opportunity.allowedSourceRefs = [];
  h.restart();
  invalidateRevokedDiscoverySources(h.service);
  const applied = h.markers('discovery.observation.applied').map(row => JSON.parse(row.payload_json));
  assert.equal(applied.find(row => row.source_event_id === ingested.source_event_id).projection_status, 'source_revoked');
  h.settings.discovery.enabled = true;
  h.settings.opportunity.allowedSourceRefs = ['public:discovery-fixture'];
  const result = h.service.reconcileDiscovery();
  assert.equal(result.processed, 0);
  assert.equal(h.situations().length, 0);
  assert.equal(h.evidence().length, 0);
  noExternalEffects(h);
});

test('revoked pending source event terminates and cannot resurrect after re-allow', async t => {
  const h = harness(t);
  const original = h.service.discoveryApply;
  let ingested;
  try {
    h.service.discoveryApply = () => { throw new Error('synthetic pending before revoke'); };
    ingested = await h.ingest(source({ message_id: 'message:pending-revoked' }));
  } finally { h.service.discoveryApply = original; }
  h.settings.opportunity.allowedSourceRefs = [];
  const revoked = h.service.reconcileDiscovery();
  assert.equal(revoked.processed, 0);
  assert.equal(revoked.failed, 0);
  const applied = h.markers('discovery.observation.applied').map(row => JSON.parse(row.payload_json));
  assert.equal(applied.find(row => row.source_event_id === ingested.source_event_id).projection_status, 'source_revoked');
  assert.equal(h.situations().length, 0);
  assert.equal(h.evidence().length, 0);

  h.settings.opportunity.allowedSourceRefs = ['public:discovery-fixture'];
  const resurrected = h.service.reconcileDiscovery();
  assert.equal(resurrected.processed, 0);
  assert.equal(h.situations().length, 0);
  assert.equal(h.evidence().length, 0);
  noExternalEffects(h);
});

test('offer changes stale old situations and release maxOpen capacity', async t => {
  const h = harness(t);
  h.settings.discovery.maxOpenSituations = 1;
  const first = await candidate(h);
  const old = h.situations()[0];
  const oldDetail = h.detail(old.id);
  h.settings.opportunity.activeOffer = { ...offer, version: 'v2' };
  await assert.rejects(h.command('discovery.review', { task_id: first.review_task_id,
    expected_revision: oldDetail.revision, expected_evidence_fingerprint: oldDetail.evidence_fingerprint, decision: 'approve' }),
  { code: 'DISCOVERY_REVIEW_NOT_AVAILABLE' });
  assert.equal(h.situations().find(row => row.id === old.id).status, 'STALE');
  assert.equal(h.store.get("SELECT status FROM tasks WHERE id=?", first.review_task_id).status, 'cancelled');
  await h.ingest(source({ message_id: 'message:2', version: 1, text: 'New offer context', updated_at: '2026-01-01T00:01:00.000Z' }));
  assert.equal(h.situations().filter(row => row.status === 'OBSERVING').length, 1);
  noExternalEffects(h);
});

test('purpose changes stale old candidates and release maxOpen capacity', async t => {
  const h = harness(t);
  h.settings.discovery.maxOpenSituations = 1;
  const first = await candidate(h);
  const old = h.situations()[0];
  const oldDetail = h.detail(old.id);
  h.settings.discovery.purpose = 'Assess a different bounded purpose for operator review only.';
  assert.equal(h.detail(old.id).freshness.fresh, false);
  await assert.rejects(h.command('discovery.review', { task_id: first.review_task_id,
    expected_revision: oldDetail.revision, expected_evidence_fingerprint: oldDetail.evidence_fingerprint, decision: 'approve' }),
  { code: 'DISCOVERY_REVIEW_NOT_AVAILABLE' });
  assert.equal(h.situations().find(row => row.id === old.id).status, 'STALE');
  assert.equal(h.store.get('SELECT status FROM tasks WHERE id=?', first.review_task_id).status, 'cancelled');
  await h.ingest(source({ message_id: 'message:purpose-next', text: 'Observation for the new purpose' }));
  const active = h.situations().filter(row => ['OBSERVING', 'CANDIDATE'].includes(row.status));
  assert.equal(active.length, 1);
  assert.equal(active[0].purpose, h.settings.discovery.purpose);
  assert.equal(h.evidence().length, 2);
  noExternalEffects(h);
});

test('capacity failures are audited idempotently across reconciliation retries', async t => {
  const h = harness(t);
  h.settings.discovery.maxOpenSituations = 1;
  await h.ingest();
  await h.ingest(source({ message_id: 'message:2', author_id: 'user:2', version: 1,
    text: 'Blocked by quota', updated_at: '2026-01-01T00:01:00.000Z' }));
  const before = h.markers('discovery.observation.failed').length;
  assert.equal(before, 1);
  for (let i = 0; i < 6; i++) h.service.reconcileDiscovery();
  assert.equal(h.markers('discovery.observation.failed').length, before);
  noExternalEffects(h);
});

test('transfer creates engagement attention without external effects', async t => {
  const h = harness(t);
  const first = await candidate(h);
  const detail = h.detail(h.situations()[0].id);
  await h.command('discovery.review', { task_id: first.review_task_id, expected_revision: detail.revision, expected_evidence_fingerprint: detail.evidence_fingerprint, decision: 'approve' });
  const person = await h.command('person.create', { name: 'Existing recipient', source: 'synthetic operator' });
  h.settings.opportunity.authorBindings = [{
    source_id: source().source_id,
    author_id: source().author_id,
    conversation_id: person.conversation_id,
  }];
  await h.command('message.record', { conversation_id: person.conversation_id, text: 'Explicit inbound question', source: 'synthetic' });
  await h.command('permission.grant', { conversation_id: person.conversation_id, purpose: 'reply',
    granted_by: 'synthetic recipient', evidence: 'synthetic explicit reply grant',
    valid_from: '2020-01-01T00:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z' });
  const inboundId = h.store.get("SELECT id FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1", person.conversation_id).id;
  const approved = h.detail(h.situations()[0].id);
  const result = await h.command('discovery.transfer', { situation_id: approved.id, conversation_id: person.conversation_id, inbound_message_id: inboundId, basis: 'Operator explicitly linked the existing conversation.' });
  assert.equal(result.status, 'TRANSFERRED'); assert.equal(result.sends_started, false); assert.equal(result.drafts_created, 0);
  assert.equal(h.store.get("SELECT status FROM discovery_situations WHERE id=?", approved.id).status, 'TRANSFERRED');
  assert.equal(h.store.get("SELECT status FROM tasks WHERE conversation_id=? AND kind='reply' AND status='cancelled'", person.conversation_id)?.status, 'cancelled');
  const attention = h.store.get("SELECT t.id,et.trigger_json FROM tasks t JOIN engagement_tasks et ON et.task_id=t.id WHERE t.conversation_id=? AND t.kind='engagement_evaluate' AND t.status='pending'", person.conversation_id);
  assert.ok(attention);
  assert.equal(JSON.parse(attention.trigger_json).message_id, inboundId);
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM contact_permissions').n, 1);
  noExternalEffects(h, 1, 1);
});

test('v3 bundle from a clean database imports into v4 with empty discovery state', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-discovery-v3-'));
  const cleanStore = new Store(directory);
  t.after(() => { cleanStore.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const bundle = exportPartner(cleanStore);
  const v3 = structuredClone(bundle);
  delete v3.tables.discovery_situations;
  delete v3.tables.discovery_evidence;
  v3.migrations = v3.migrations.slice(0, 3);
  v3.tables_sha256 = hash(JSON.stringify(v3.tables));
  const file = path.join(directory, 'v3.json'); fs.writeFileSync(file, JSON.stringify(v3));
  const destination = path.join(ROOT, 'exports', `discovery-integrity-${id()}`);
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['scripts/import.mjs', file, destination], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const restored = new Store(path.join(destination, 'data'));
  try {
    assert.equal(restored.get('SELECT COUNT(*) AS n FROM discovery_situations').n, 0);
    assert.equal(restored.get('SELECT COUNT(*) AS n FROM discovery_evidence').n, 0);
    assert.deepEqual(restored.all('PRAGMA foreign_key_check'), []);
  } finally { restored.close(); }
});

test('multiple independent observations accumulate in one durable situation across restart', async t => {
  const h = harness(t);
  const before = {
    engagements: h.store.get('SELECT COUNT(*) AS n FROM engagements').n,
    decisions: h.store.get('SELECT COUNT(*) AS n FROM engagement_decisions').n,
    drafts: h.store.get('SELECT COUNT(*) AS n FROM drafts').n,
    approvals: h.store.get('SELECT COUNT(*) AS n FROM approvals').n,
    permissions: h.store.get('SELECT COUNT(*) AS n FROM contact_permissions').n,
    deliveries: h.store.get('SELECT COUNT(*) AS n FROM delivery_attempts').n,
  };
  const first = await h.ingest(source({ message_id: 'message:A', version: 1 }));
  const situationA = h.situations()[0];
  const fingerprintA = h.detail(situationA.id).evidence_fingerprint;
  const revisionA = situationA.revision;
  const second = await h.ingest(source({ message_id: 'message:B', version: 1 }));
  const situationB = h.situations().find(row => row.id === situationA.id);
  const fingerprintB = h.detail(situationA.id).evidence_fingerprint;
  const revisionB = situationB.revision;
  assert.notEqual(first.source_event_id, second.source_event_id);
  assert.equal(h.situations().filter(row => row.status === 'OBSERVING').length, 1);
  assert.equal(h.evidence().length, 2);
  assert.equal(revisionB, revisionA + 1);
  assert.notEqual(fingerprintB, fingerprintA);
  h.restart();
  const third = await h.ingest(source({ message_id: 'message:C', version: 1 }));
  const situationC = h.situations().find(row => row.id === situationA.id);
  const fingerprintC = h.detail(situationA.id).evidence_fingerprint;
  assert.equal(h.situations().filter(row => row.status === 'OBSERVING').length, 1);
  assert.equal(h.evidence().length, 3);
  assert.equal(situationC.revision, revisionB + 1);
  assert.notEqual(fingerprintC, fingerprintB);
  assert.deepEqual(h.store.all("SELECT id FROM events WHERE kind='source.message' ORDER BY id").map(row => String(row.id)), [first.source_event_id, second.source_event_id, third.source_event_id]);
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM engagements').n, before.engagements);
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM engagement_decisions').n, before.decisions);
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM drafts').n, before.drafts);
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM approvals').n, before.approvals);
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM contact_permissions').n, before.permissions);
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM delivery_attempts').n, before.deliveries);
  noExternalEffects(h);
});

test('late out-of-order source version is a semantic no-op for discovery', async t => {
  const h = harness(t);
  const first = await h.ingest(source({ message_id: 'message:late-order', version: 2, text: 'Current version', updated_at: '2026-01-01T00:01:00.000Z' }), { kind: 'channel', sourceId: source().source_id }, 'v2');
  const situation = h.situations()[0];
  const before = {
    revision: situation.revision,
    evidence: h.evidence().length,
    fingerprint: h.detail(situation.id).evidence_fingerprint,
    applied: h.markers('discovery.observation.applied').length,
    failed: h.markers('discovery.observation.failed').length,
    sourceRows: h.sourceRows().length,
  };
  const late = await h.ingest(source({ message_id: 'message:late-order', version: 1, text: 'Old version', updated_at: baseTime }), { kind: 'channel', sourceId: source().source_id }, 'late-v1');
  assert.equal(late.disposition, 'ignored_out_of_order');
  assert.equal(late.source_event_id, first.source_event_id);
  assert.equal(h.situations().find(row => row.id === situation.id).revision, before.revision);
  assert.equal(h.evidence().length, before.evidence);
  assert.equal(h.detail(situation.id).evidence_fingerprint, before.fingerprint);
  assert.equal(h.markers('discovery.observation.applied').length, before.applied);
  assert.equal(h.markers('discovery.observation.failed').length, before.failed);
  assert.equal(h.sourceRows().length, before.sourceRows);
  noExternalEffects(h);
});

test('replay and ignored out-of-order results cannot backfill pending after re-enable', async t => {
  const h = harness(t);
  h.settings.discovery.enabled = false;
  const raw = source({ message_id: 'message:disabled-v2', version: 2, text: 'Accepted while disabled', updated_at: '2026-01-01T00:01:00.000Z' });
  const registered = await h.ingest(raw, { kind: 'channel', sourceId: raw.source_id }, 'disabled-intake');
  assert.equal(registered.disposition, 'registered');
  assert.equal(h.markers('discovery.observation.pending').length, 0);

  h.settings.discovery.enabled = true;
  const replay = await h.command('source.ingest', raw, { kind: 'channel', sourceId: raw.source_id }, 'disabled-intake');
  assert.deepEqual(replay, registered);
  const late = await h.ingest(source({ message_id: 'message:disabled-v2', version: 1, text: 'Late old version', updated_at: baseTime }), { kind: 'channel', sourceId: raw.source_id }, 'late-disabled');
  assert.equal(late.disposition, 'ignored_out_of_order');
  assert.equal(late.source_event_id, registered.source_event_id);
  const direct = h.service.discoveryApply(h.service, registered.source_event_id);
  assert.equal(direct.status, 'deferred');
  assert.equal(direct.reason, 'DISCOVERY_PENDING_MARKER_MISSING');
  assert.deepEqual(counts(h), { source: 1, evidence: 0, applied: 0, pending: 0, failed: 0 });
  assert.equal(h.situations().length, 0);
  noExternalEffects(h);
});

test('pending intake basis cannot be reinterpreted after restart and config change', async t => {
  const h = harness(t);
  const original = h.service.discoveryApply;
  let ingested;
  try {
    h.service.discoveryApply = () => { throw new Error('synthetic basis pending'); };
    ingested = await h.ingest(source({ message_id: 'message:basis-pending' }));
  } finally { h.service.discoveryApply = original; }
  const pending = h.markers('discovery.observation.pending').map(row => JSON.parse(row.payload_json))
    .find(row => row.source_event_id === String(ingested.source_event_id));
  assert.equal(pending.offer_fingerprint, digest(h.settings.opportunity.activeOffer));
  assert.equal(pending.purpose, h.settings.discovery.purpose);

  h.restart();
  h.settings.opportunity.activeOffer = { ...offer, version: 'v2' };
  h.settings.discovery.purpose = 'A different bounded purpose after restart.';
  const result = h.service.reconcileDiscovery();
  assert.equal(result.processed, 1);
  assert.equal(result.failed, 0);
  const applied = h.markers('discovery.observation.applied').map(row => JSON.parse(row.payload_json));
  assert.equal(applied.find(row => row.source_event_id === ingested.source_event_id).projection_status, 'configuration_changed');
  assert.equal(h.situations().length, 0);
  assert.equal(h.evidence().length, 0);
  noExternalEffects(h);
});

test('large deferred transport backlog does not starve a ready source', async t => {
  const h = harness(t);
  h.settings.opportunity.telegramSources = [{ sourceId: TELEGRAM_SOURCE, accountId: '999', channelId: '100',
    sourceKind: 'sanitized_fixture', processingBasis: 'Offline reconciliation fairness fixture', maxLagSeconds: 120 }];
  h.settings.opportunity.allowedSourceRefs = [TELEGRAM_SOURCE, 'public:discovery-fixture'];
  await bootstrapTelegramSource(h.service, TELEGRAM_SOURCE, { pts: 10, history: [] });
  const updates = Array.from({ length: 201 }, (_, index) => transportUpdate(11 + index,
    { message: transportWire({ id: index + 1 }) }));
  for (let offset = 0; offset < updates.length; offset += 100) {
    const chunk = updates.slice(offset, offset + 100), from = 10 + offset;
    await applyTelegramDifference(h.service, TELEGRAM_SOURCE, transportPage(from, from + chunk.length, chunk, false));
  }
  const original = h.service.discoveryApply;
  try {
    h.service.discoveryApply = () => { throw new Error('synthetic ready-source TX2 failure'); };
    await h.ingest(source({ message_id: 'message:ready', version: 1, text: 'Ready public source' }));
  } finally { h.service.discoveryApply = original; }
  const result = h.service.reconcileDiscovery();
  assert.equal(result.processed, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.deferred, 50);
  assert.equal(h.situations().length, 1);
  assert.equal(h.situations()[0].source_ref, 'public:discovery-fixture');
  noExternalEffects(h);
});

test('revoked source maintenance releases a ready source without starvation', async t => {
  const h = harness(t);
  const deferred = Array.from({ length: 200 }, (_, index) => `public:deferred:${String(index).padStart(3, '0')}`);
  const ready = 'public:zz-ready';
  h.settings.opportunity.allowedSourceRefs = [...deferred, ready];
  const original = h.service.discoveryApply;
  try {
    h.service.discoveryApply = () => { throw new Error('synthetic source-group pending'); };
    for (const sourceRef of [...deferred, ready]) {
      await h.ingest(source({ source_id: sourceRef, message_id: `message:${sourceRef}`, text: 'Pending source group' }),
        { kind: 'channel', sourceId: sourceRef });
    }
  } finally { h.service.discoveryApply = original; }
  h.settings.opportunity.allowedSourceRefs = [ready];

  const first = h.service.reconcileDiscovery();
  assert.equal(first.processed, 1);
  assert.equal(first.failed, 0);
  assert.equal(first.deferred, 0);
  assert.ok(h.situations().some(row => row.source_ref === ready));
  h.restart();
  const second = h.service.reconcileDiscovery();
  assert.equal(second.processed, 0);
  assert.equal(second.failed, 0);
  noExternalEffects(h);
});

test('durable cursor does not duplicate a source after its cursor disappears', async t => {
  const h = harness(t);
  const original = h.service.discoveryApply;
  let ingested;
  try {
    h.service.discoveryApply = () => { throw new Error('synthetic cursor pending'); };
    ingested = await h.ingest(source({ message_id: 'message:cursor-missing' }));
  } finally { h.service.discoveryApply = original; }
  h.store.run(`INSERT INTO channel_offsets(channel,account_id,cursor) VALUES(?,?,?)
    ON CONFLICT(channel,account_id) DO UPDATE SET cursor=excluded.cursor`, 'discovery-reconcile-v1',
  h.settings.partnerId, JSON.stringify({ source_ref: 'public:aaa-missing' }));
  const result = h.service.reconcileDiscovery();
  assert.equal(result.processed, 1);
  assert.equal(result.failed, 0);
  assert.equal(h.markers('discovery.observation.applied').length, 1);
  assert.equal(h.markers('discovery.observation.applied')[0].payload_json.includes(ingested.source_event_id), true);
  noExternalEffects(h);
});

test('reconciliation processes pending markers in source order and is safe to repeat', async t => {
  const h = harness(t);
  await h.ingest(source({ message_id: 'message:a', version: 1 }), { kind: 'channel', sourceId: source().source_id }, 'a');
  const applied = h.store.get("SELECT id,payload_json FROM events WHERE kind='discovery.observation.applied'");
  const pendingPayload = { ...JSON.parse(applied.payload_json), offer_fingerprint: digest(h.settings.opportunity.activeOffer),
    purpose: h.settings.discovery.purpose };
  h.store.run("UPDATE events SET kind='discovery.observation.pending',payload_json=? WHERE id=?", JSON.stringify(pendingPayload), applied.id);
  const first = h.service.reconcileDiscovery();
  assert.equal(first.processed, 1); assert.equal(first.failed, 0);
  const second = h.service.reconcileDiscovery();
  assert.equal(second.processed, 0);
  noExternalEffects(h);
});
