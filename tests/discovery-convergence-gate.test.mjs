// Executable Discovery convergence contract. No model, network, Telegram, scheduler, or live send.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ROOT, readJson } from '../business/config.mjs';
import { contextFor } from '../business/context.mjs';
import {
  invalidateRevokedDiscoverySources,
  reconcileDiscoveryPending,
} from '../business/discovery.mjs';
import { BusinessService } from '../business/service.mjs';
import {
  digest,
  sourceCheckpoint,
  sourceRows,
} from '../business/source-ingestion.mjs';
import {
  applyTelegramDifference,
  bootstrapTelegramSource,
} from '../business/sources/telegram-readonly.mjs';
import { Store, id } from '../business/store.mjs';

const OFFER_A = {
  id: 'offer-convergence',
  version: 'v1',
  text: 'Synthetic convergence offer',
  criteria: ['explicit question'],
  exclusions: [],
};
const OFFER_B = { ...OFFER_A, version: 'v2', text: 'Changed synthetic offer' };
const BASE_TIME = '2026-01-01T00:00:00.000Z';
const SOURCE_ID = 'public:discovery-convergence';
const TELEGRAM_SOURCE = 'telegram:channel:100';

function source(extra = {}) {
  return {
    source_id: SOURCE_ID,
    source_kind: 'sanitized_fixture',
    message_id: 'message:1',
    author_id: 'user:1',
    display_name: 'Convergence fixture',
    thread_id: 'thread:1',
    reply_to_id: null,
    version: 1,
    operation: 'upsert',
    text: 'What does this offer include?',
    created_at: BASE_TIME,
    updated_at: BASE_TIME,
    ...extra,
  };
}

const transportWire = (extra = {}) => ({
  id: 1,
  channel_id: '100',
  from_id: { kind: 'user', id: '10' },
  post: false,
  text: 'What does this offer include?',
  date: 1767225600,
  ...extra,
});
const transportPage = (from, to, updates = [], final = true) => ({
  kind: from === to ? 'empty' : 'difference',
  account_id: '999',
  channel_id: '100',
  from_pts: from,
  to_pts: to,
  final,
  updates,
});

function config() {
  const value = readJson(path.join(ROOT, 'config/default.json'));
  value.opportunity = {
    ...value.opportunity,
    automatic: true,
    allowedSourceRefs: [SOURCE_ID],
    activeOffer: structuredClone(OFFER_A),
    authorBindings: [],
  };
  value.discovery = {
    ...value.discovery,
    enabled: true,
    maxEvidence: 20,
    maxOpenSituations: 100,
    ttlSeconds: 604800,
  };
  value.runtime = { ...value.runtime, enabled: false, model: '', baseUrl: '' };
  value.telegram = { ...value.telegram, enabled: false, liveSending: false };
  value.engagement = { ...value.engagement, enabled: false };
  return value;
}

function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-convergence-gate-'));
  let store = new Store(directory);
  const settings = config();
  let service = new BusinessService(store, settings);
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    settings,
    get store() { return store; },
    get service() { return service; },
    command(action, payload, actor = { kind: 'operator' }, request = id()) {
      return service.command(action, payload, request, actor);
    },
    ingest(raw = source(), actor = { kind: 'channel', sourceId: raw.source_id }, request = id()) {
      return service.command('source.ingest', raw, request, actor);
    },
    sourceRows(sourceId = SOURCE_ID) { return sourceRows(service, sourceId); },
    situations() {
      return store.all(
        'SELECT * FROM discovery_situations WHERE partner_id=? ORDER BY created_at,id',
        settings.partnerId,
      );
    },
    evidence() {
      return store.all('SELECT * FROM discovery_evidence ORDER BY created_at,rowid');
    },
    markers(kind) {
      return store.all(
        'SELECT id,payload_json FROM events WHERE partner_id=? AND kind=? ORDER BY id',
        settings.partnerId,
        kind,
      );
    },
    detail(situationId) { return service.discoveryDetail(situationId); },
    restart() {
      store.close();
      store = new Store(directory);
      store.recover();
      service = new BusinessService(store, settings);
    },
  };
}

function sourceEventId(h, sourceId = SOURCE_ID) {
  const row = h.sourceRows(sourceId)[0];
  assert.ok(row, `missing source event for ${sourceId}`);
  return row.event_id;
}

function eventCount(h, kind) {
  return h.store.get(
    'SELECT COUNT(*) AS n FROM events WHERE partner_id=? AND kind=?',
    h.settings.partnerId,
    kind,
  ).n;
}

function noContactEffects(h, expected = {}) {
  const expectations = {
    persons: 0,
    conversations: 0,
    channel_identities: 0,
    messages: 0,
    contact_permissions: 0,
    engagements: 0,
    drafts: 0,
    approvals: 0,
    delivery_attempts: 0,
    outcome_events: 0,
    ...expected,
  };
  for (const [table, count] of Object.entries(expectations)) {
    assert.equal(h.store.get(`SELECT COUNT(*) AS n FROM ${table}`).n, count, table);
  }
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM messages WHERE direction='out'").n, 0);
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM tasks WHERE kind IN ('reply','engagement_evaluate')").n, 0);
  assert.equal(eventCount(h, 'discovery.transferred'), 0);
  assert.deepEqual(h.store.all('PRAGMA foreign_key_check'), []);
}

async function candidate(h, raw = source()) {
  const ingested = await h.ingest(raw);
  assert.ok(ingested.source_event_id, 'candidate fixture did not create a source event');
  const situation = h.situations().find((row) => row.source_ref === raw.source_id);
  assert.ok(situation, 'candidate fixture did not create a situation');
  const detail = h.detail(situation.id);
  return h.command('discovery.assess', {
    situation_id: situation.id,
    expected_revision: detail.revision,
    expected_evidence_fingerprint: detail.evidence_fingerprint,
    decision: 'CANDIDATE',
    hypothesis: 'The explicit question may deserve operator attention.',
    why_now: 'The author asked a bounded question now.',
    evidence_event_ids: [sourceEventId(h, raw.source_id)],
    opening_proposal: {
      text: 'I can explain the bounded offer scope.',
      rationale: 'Answer the explicit question.',
      constraints: ['public review only'],
    },
  });
}

async function approvedCandidate(h, raw = source(), request = id()) {
  const review = await candidate(h, raw);
  const detail = h.detail(review.situation_id);
  const payload = {
    task_id: review.review_task_id,
    expected_revision: detail.revision,
    expected_evidence_fingerprint: detail.evidence_fingerprint,
    decision: 'approve',
  };
  const approved = await h.command('discovery.review', payload, { kind: 'operator' }, request);
  return { review, detail, payload, request, approved };
}

test('E1 edit or delete makes an approved decision durably stale', async (t) => {
  for (const mutation of ['edit', 'delete']) {
    const h = harness(t);
    const fixture = await approvedCandidate(h);
    const old = h.store.get('SELECT * FROM discovery_situations WHERE id=?', fixture.review.situation_id);
    await h.ingest(source({
      version: 2,
      operation: mutation === 'delete' ? 'delete' : 'upsert',
      text: mutation === 'delete' ? null : 'Updated bounded question',
      updated_at: '2026-01-01T00:01:00.000Z',
    }));
    const current = h.store.get('SELECT * FROM discovery_situations WHERE id=?', old.id);
    assert.equal(current.status, 'STALE');
    assert.ok(current.revision > old.revision);
    assert.equal(h.detail(old.id).freshness.fresh, false);
    assert.ok(h.detail(old.id).freshness.reasons.includes('DISCOVERY_NOT_LIVE'));
    const stale = h.store.get(
      "SELECT payload_json FROM events WHERE kind='discovery.situation.stale' AND json_extract(payload_json,'$.situation_id')=? ORDER BY id DESC LIMIT 1",
      old.id,
    );
    assert.ok(stale);
    assert.equal(h.store.get('SELECT status FROM tasks WHERE id=?', fixture.review.review_task_id).status, 'done');
    assert.equal(eventCount(h, 'discovery.review.approved'), 1);
    await assert.rejects(
      h.command('discovery.review', fixture.payload, { kind: 'operator' }, id()),
      { code: 'DISCOVERY_REVIEW_NOT_AVAILABLE' },
    );
    noContactEffects(h);
  }
});

test('E2 source revocation remains terminal across restart and re-allow', async (t) => {
  const h = harness(t);
  const request = id();
  const fixture = await approvedCandidate(h, source(), request);
  const taskStatus = h.store.get('SELECT status FROM tasks WHERE id=?', fixture.review.review_task_id).status;
  h.settings.opportunity.allowedSourceRefs = [];
  h.restart();
  invalidateRevokedDiscoverySources(h.service);
  h.settings.opportunity.allowedSourceRefs = [SOURCE_ID];
  h.restart();

  const current = h.store.get('SELECT * FROM discovery_situations WHERE id=?', fixture.review.situation_id);
  assert.equal(current.status, 'STALE');
  const stale = h.store.get(
    "SELECT payload_json FROM events WHERE kind='discovery.situation.stale' AND json_extract(payload_json,'$.situation_id')=? ORDER BY id DESC LIMIT 1",
    current.id,
  );
  assert.equal(JSON.parse(stale.payload_json).reason, 'SOURCE_REVOKED');
  assert.equal(h.detail(current.id).freshness.fresh, false);
  assert.equal(h.store.get('SELECT status FROM tasks WHERE id=?', fixture.review.review_task_id).status, taskStatus);
  assert.equal(eventCount(h, 'discovery.review.approved'), 1);

  const replay = await h.command('discovery.review', fixture.payload, { kind: 'operator' }, request);
  assert.deepEqual(replay, fixture.approved);
  assert.equal(h.store.get('SELECT revision FROM discovery_situations WHERE id=?', current.id).revision, current.revision);
  assert.equal(eventCount(h, 'discovery.review.approved'), 1);
  await assert.rejects(
    h.command('discovery.review', fixture.payload, { kind: 'operator' }, id()),
    { code: 'DISCOVERY_REVIEW_NOT_AVAILABLE' },
  );
  noContactEffects(h);
});

test('E3 bootstrap context never becomes a Discovery trigger', async (t) => {
  const h = harness(t);
  h.settings.opportunity.telegramSources = [{
    sourceId: TELEGRAM_SOURCE,
    accountId: '999',
    channelId: '100',
    sourceKind: 'sanitized_fixture',
    processingBasis: 'Offline convergence bootstrap fixture',
    maxLagSeconds: 120,
  }];
  h.settings.opportunity.allowedSourceRefs = [TELEGRAM_SOURCE];
  await bootstrapTelegramSource(h.service, TELEGRAM_SOURCE, {
    pts: 10,
    history: [transportWire({ id: 7 })],
  });
  await applyTelegramDifference(h.service, TELEGRAM_SOURCE, transportPage(10, 10));
  assert.equal(sourceCheckpoint(h.service, TELEGRAM_SOURCE).phase, 'current');

  const historical = String(h.store.get(
    "SELECT id FROM events WHERE kind='source.message' ORDER BY id LIMIT 1",
  ).id);
  const deferred = h.service.discoveryApply(h.service, historical);
  assert.equal(deferred.status, 'deferred');
  assert.equal(deferred.reason, 'DISCOVERY_PENDING_MARKER_MISSING');
  const result = h.service.reconcileDiscovery();
  assert.deepEqual(result, { processed: 0, failed: 0, deferred: 0 });
  assert.equal(h.sourceRows(TELEGRAM_SOURCE).length, 1);
  assert.equal(h.markers('discovery.observation.pending').length, 0);
  assert.equal(h.markers('discovery.observation.applied').length, 0);
  assert.equal(h.markers('discovery.observation.failed').length, 0);
  assert.equal(h.situations().length, 0);
  assert.equal(h.evidence().length, 0);
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM tasks WHERE kind='discovery_review'").n, 0);
  noContactEffects(h);
});

test('E4 intake offer and purpose basis survive restart without reinterpretation', async (t) => {
  for (const change of ['offer', 'purpose']) {
    const h = harness(t);
    const raw = source({ message_id: `message:basis-${change}` });
    const original = h.service.discoveryApply;
    let ingested;
    try {
      h.service.discoveryApply = () => { throw new Error(`synthetic ${change} pending basis`); };
      ingested = await h.ingest(raw);
    } finally {
      h.service.discoveryApply = original;
    }
    const pending = h.markers('discovery.observation.pending')
      .map((row) => JSON.parse(row.payload_json))
      .find((row) => row.source_event_id === String(ingested.source_event_id));
    assert.equal(pending.offer_fingerprint, digest(OFFER_A));
    assert.equal(pending.purpose, h.settings.discovery.purpose);

    h.restart();
    if (change === 'offer') h.settings.opportunity.activeOffer = structuredClone(OFFER_B);
    else h.settings.discovery.purpose = 'A changed purpose after durable intake.';
    const result = h.service.reconcileDiscovery();
    assert.equal(result.processed, 1);
    assert.equal(result.failed, 0);
    const applied = h.markers('discovery.observation.applied')
      .map((row) => JSON.parse(row.payload_json))
      .find((row) => row.source_event_id === String(ingested.source_event_id));
    assert.equal(applied.projection_status, 'configuration_changed');
    assert.equal(h.situations().length, 0);
    assert.equal(h.evidence().length, 0);
    assert.equal(eventCount(h, 'discovery.assessment'), 0);
    assert.equal(h.store.get("SELECT COUNT(*) AS n FROM tasks WHERE kind='discovery_review'").n, 0);
    noContactEffects(h);
  }
});

test('A1 Discovery approval creates no contact authority or external effect', async (t) => {
  const h = harness(t);
  const fixture = await approvedCandidate(h);
  assert.equal(fixture.approved.status, 'CANDIDATE');
  assert.equal(fixture.approved.contact_permission, false);
  assert.equal(fixture.approved.executable, false);
  assert.deepEqual(fixture.approved.allowed_effects, []);
  assert.equal(eventCount(h, 'discovery.review.approved'), 1);
  noContactEffects(h);
});

test('H1 proposal is not authorization until an operator approves', async (t) => {
  const h = harness(t);
  const person = await h.command('person.create', {
    name: 'Synthetic review target',
    source: 'Offline convergence fixture',
    permission: 'Legacy text is not typed consent',
  });
  const before = h.store.get('SELECT COUNT(*) AS n FROM persons').n;
  const review = await candidate(h);
  const transferPayload = {
    situation_id: review.situation_id,
    conversation_id: person.conversation_id,
    inbound_message_id: 'message:not-yet-recorded',
    basis: 'No operator approval exists.',
  };
  await assert.rejects(
    h.command('discovery.transfer', transferPayload),
    { code: 'DISCOVERY_REVIEW_REQUIRED' },
  );
  const detail = h.detail(review.situation_id);
  await assert.rejects(
    h.command('discovery.review', {
      task_id: review.review_task_id,
      expected_revision: detail.revision,
      expected_evidence_fingerprint: detail.evidence_fingerprint,
      decision: 'approve',
    }, { kind: 'agent' }),
    { status: 403 },
  );
  const approved = await h.command('discovery.review', {
    task_id: review.review_task_id,
    expected_revision: detail.revision,
    expected_evidence_fingerprint: detail.evidence_fingerprint,
    decision: 'approve',
  });
  assert.equal(approved.status, 'CANDIDATE');
  assert.equal(h.store.get('SELECT status FROM tasks WHERE id=?', review.review_task_id).status, 'done');
  assert.equal(eventCount(h, 'discovery.review.approved'), 1);
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM persons').n, before);
  assert.equal(eventCount(h, 'discovery.transferred'), 0);
  noContactEffects(h, { persons: 1, conversations: 1 });
});

test('H2 stale review can be rejected but cannot be approved', async (t) => {
  const h = harness(t);
  h.settings.discovery.ttlSeconds = 60;
  const review = await candidate(h);
  const row = h.situations()[0];
  h.store.run(
    'UPDATE discovery_situations SET expires_at=? WHERE id=?',
    '2000-01-01T00:00:00.000Z',
    row.id,
  );
  await h.ingest(source({
    message_id: 'message:ttl-trigger',
    author_id: 'user:ttl-trigger',
    thread_id: 'thread:ttl-trigger',
  }));
  assert.equal(h.store.get('SELECT status FROM discovery_situations WHERE id=?', row.id).status, 'STALE');
  assert.equal(h.store.get('SELECT status FROM tasks WHERE id=?', review.review_task_id).status, 'proposed');
  const detail = h.detail(row.id);
  const payload = {
    task_id: review.review_task_id,
    expected_revision: detail.revision,
    expected_evidence_fingerprint: detail.evidence_fingerprint,
  };
  await assert.rejects(
    h.command('discovery.review', { ...payload, decision: 'approve' }),
    { code: 'DISCOVERY_ASSESSMENT_STALE' },
  );
  const rejected = await h.command('discovery.review', { ...payload, decision: 'reject' });
  assert.equal(rejected.status, 'DISMISSED');
  assert.equal(h.store.get('SELECT status FROM tasks WHERE id=?', review.review_task_id).status, 'done');
  assert.equal(eventCount(h, 'discovery.review.rejected'), 1);
  assert.equal(eventCount(h, 'discovery.review.approved'), 0);
  noContactEffects(h);
});

test('H3 review decisions are revision-bound and idempotent', async (t) => {
  const h = harness(t);
  const first = await candidate(h);
  const firstDetail = h.detail(first.situation_id);
  await h.command('discovery.review', {
    task_id: first.review_task_id,
    expected_revision: firstDetail.revision,
    expected_evidence_fingerprint: firstDetail.evidence_fingerprint,
    decision: 'approve',
  });
  const currentDetail = h.detail(first.situation_id);
  const second = await h.command('discovery.assess', {
    situation_id: first.situation_id,
    expected_revision: currentDetail.revision,
    expected_evidence_fingerprint: currentDetail.evidence_fingerprint,
    decision: 'CANDIDATE',
    hypothesis: 'A second current assessment requires fresh review.',
    why_now: 'The operator requested a revision-bound retry.',
    evidence_event_ids: [sourceEventId(h)],
    opening_proposal: {
      text: 'Current bounded opening.',
      rationale: 'Current evidence only.',
      constraints: [],
    },
  });
  const secondDetail = h.detail(first.situation_id);
  await assert.rejects(h.command('discovery.review', {
    task_id: second.review_task_id,
    expected_revision: firstDetail.revision,
    expected_evidence_fingerprint: secondDetail.evidence_fingerprint,
    decision: 'approve',
  }), { code: 'DISCOVERY_REVISION_CONFLICT' });
  assert.equal(h.store.get('SELECT revision FROM discovery_situations WHERE id=?', first.situation_id).revision, secondDetail.revision);
  assert.equal(eventCount(h, 'discovery.review.approved'), 1);

  const request = id();
  const currentPayload = {
    task_id: second.review_task_id,
    expected_revision: secondDetail.revision,
    expected_evidence_fingerprint: secondDetail.evidence_fingerprint,
    decision: 'approve',
  };
  const approved = await h.command('discovery.review', currentPayload, { kind: 'operator' }, request);
  const approvedRevision = h.store.get('SELECT revision FROM discovery_situations WHERE id=?', first.situation_id).revision;
  const approvedEvents = eventCount(h, 'discovery.review.approved');
  h.restart();
  assert.deepEqual(
    await h.command('discovery.review', currentPayload, { kind: 'operator' }, request),
    approved,
  );
  assert.equal(h.store.get('SELECT revision FROM discovery_situations WHERE id=?', first.situation_id).revision, approvedRevision);
  assert.equal(eventCount(h, 'discovery.review.approved'), approvedEvents);
  await assert.rejects(
    h.command('discovery.review', { ...currentPayload, decision: 'reject' }, { kind: 'operator' }, request),
    { status: 409 },
  );
  noContactEffects(h);
});

test('R1 restart cannot resurrect terminal offer state', async (t) => {
  const h = harness(t);
  const review = await candidate(h);
  const old = h.situations()[0];
  h.settings.opportunity.activeOffer = structuredClone(OFFER_B);
  const detail = h.detail(old.id);
  await assert.rejects(h.command('discovery.review', {
    task_id: review.review_task_id,
    expected_revision: detail.revision,
    expected_evidence_fingerprint: detail.evidence_fingerprint,
    decision: 'approve',
  }));
  const stale = h.store.get('SELECT * FROM discovery_situations WHERE id=?', old.id);
  assert.equal(stale.status, 'STALE');
  const staleEvent = h.store.get(
    "SELECT payload_json FROM events WHERE kind='discovery.situation.stale' AND json_extract(payload_json,'$.situation_id')=? ORDER BY id DESC LIMIT 1",
    old.id,
  );
  assert.equal(JSON.parse(staleEvent.payload_json).reason, 'OFFER_CHANGED');
  assert.equal(h.store.get('SELECT status FROM tasks WHERE id=?', review.review_task_id).status, 'cancelled');

  h.settings.opportunity.activeOffer = structuredClone(OFFER_A);
  h.restart();
  assert.equal(h.store.get('SELECT status FROM discovery_situations WHERE id=?', old.id).status, 'STALE');
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM tasks WHERE kind='discovery_review' AND status='proposed'").n, 0);
  assert.deepEqual(h.service.reconcileDiscovery(), { processed: 0, failed: 0, deferred: 0 });
  noContactEffects(h);
});

test('R4 replaying one source event produces one durable effect', async (t) => {
  const h = harness(t);
  const raw = source();
  const first = await h.ingest(raw, { kind: 'channel', sourceId: SOURCE_ID }, 'r4-first');
  const before = h.situations()[0];
  const beforeDetail = h.detail(before.id);
  const replay = await h.command(
    'source.ingest',
    raw,
    { kind: 'channel', sourceId: SOURCE_ID },
    'r4-first',
  );
  const duplicate = await h.ingest(raw, { kind: 'channel', sourceId: SOURCE_ID }, 'r4-second');
  assert.deepEqual(replay, first);
  assert.equal(duplicate.duplicate, true);
  assert.equal(h.sourceRows().length, 1);
  assert.equal(h.markers('discovery.observation.pending').length, 1);
  assert.equal(h.markers('discovery.observation.applied').length, 1);
  assert.equal(h.situations().length, 1);
  assert.equal(h.evidence().length, 1);
  assert.equal(h.situations()[0].revision, before.revision);
  assert.equal(h.detail(before.id).evidence_fingerprint, beforeDetail.evidence_fingerprint);
  assert.equal(eventCount(h, 'discovery.evidence.added'), 1);
  noContactEffects(h);
});

test('U3 a corrupt pending Discovery review is not executable', async (t) => {
  const h = harness(t);
  const review = await candidate(h);
  h.store.run("UPDATE tasks SET status='pending' WHERE id=?", review.review_task_id);
  const task = h.store.get('SELECT * FROM tasks WHERE id=?', review.review_task_id);
  assert.equal(contextFor(h.service).work.some((row) => row.id === review.review_task_id), false);
  assert.throws(
    () => contextFor(h.service, null, task),
    { code: 'candidate_not_executable' },
  );
  for (const action of ['task.approve', 'task.retry', 'task.cancel']) {
    await assert.rejects(
      h.command(action, { task_id: review.review_task_id }),
      { code: 'candidate_not_executable' },
    );
  }
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM runs').n, 0);
  noContactEffects(h);
});

test('GAP R2 limit=1 bounds every durable maintenance effect', async (t) => {
  const h = harness(t);
  const refs = Array.from(
    { length: 20 },
    (_, index) => `public:revoked-backlog:${String(index).padStart(2, '0')}`,
  );
  h.settings.opportunity.allowedSourceRefs = refs;
  const original = h.service.discoveryApply;
  try {
    h.service.discoveryApply = () => { throw new Error('synthetic R2 pending backlog'); };
    for (const [index, sourceRef] of refs.entries()) {
      await h.ingest(source({
        source_id: sourceRef,
        message_id: `message:revoked-${index}`,
        author_id: `user:revoked-${index}`,
        thread_id: `thread:revoked-${index}`,
        text: `Pending revoked source ${index}`,
      }), { kind: 'channel', sourceId: sourceRef }, `r2-intake-${index}`);
    }
  } finally {
    h.service.discoveryApply = original;
  }
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM events WHERE kind='source.message'").n, 20);
  assert.equal(h.markers('discovery.observation.pending').length, 20);
  assert.equal(h.markers('discovery.observation.applied').length, 0);
  assert.equal(h.situations().length, 0);
  assert.equal(h.evidence().length, 0);

  h.settings.opportunity.allowedSourceRefs = [];
  reconcileDiscoveryPending(h.service, 1);
  const revokedMarkers = () => h.markers('discovery.observation.applied')
    .map((row) => JSON.parse(row.payload_json))
    .filter((row) => row.projection_status === 'source_revoked');
  const afterFirstCall = revokedMarkers().length;
  for (let index = 1; index < 20; index += 1) reconcileDiscoveryPending(h.service, 1);
  const finalMarkers = revokedMarkers();
  assert.equal(afterFirstCall, 1, 'R2 limit=1 terminalized more than one revoked pending marker');
  assert.equal(finalMarkers.length, 20);
  assert.equal(new Set(finalMarkers.map((row) => row.source_event_id)).size, 20);
  assert.equal(h.markers('discovery.observation.pending').length, 20);
  noContactEffects(h);
});

async function createTarget(h, raw, { channel = 'manual', accountId = null } = {}) {
  const person = await h.command('person.create', {
    name: `Synthetic target ${channel}`,
    source: 'Offline Discovery transfer fixture',
    permission: 'Legacy text is not typed consent',
    ...(channel === 'telegram' ? {
      channel,
      external_id: '12345',
      account_id: accountId,
    } : {}),
  });
  const inbound = await h.command('message.record', {
    conversation_id: person.conversation_id,
    text: 'A real inbound message for an operator-reviewed transfer.',
    external_id: id(),
    source: 'offline-convergence-gate',
  });
  h.settings.opportunity.authorBindings = [{
    source_id: raw.source_id,
    author_id: raw.author_id,
    conversation_id: person.conversation_id,
  }];
  return { ...person, inboundMessageId: inbound.message_id };
}

async function grant(h, conversationId, purpose = 'reply') {
  return h.command('permission.grant', {
    conversation_id: conversationId,
    purpose,
    granted_by: 'Synthetic recipient',
    evidence: 'Synthetic explicit typed grant for this offline test.',
    valid_from: '2020-01-01T00:00:00.000Z',
    expires_at: '2099-01-01T00:00:00.000Z',
  });
}

async function transfer(h, fixture, target, overrides = {}) {
  return h.command('discovery.transfer', {
    situation_id: fixture.review.situation_id,
    conversation_id: target.conversation_id,
    inbound_message_id: target.inboundMessageId,
    basis: 'Operator-reviewed Discovery evidence with a real inbound and typed grant.',
    ...overrides,
  });
}

async function transferOutcome(h, fixture, target, overrides = {}) {
  try {
    const result = await transfer(h, fixture, target, overrides);
    return { rejected: false, code: null, result };
  } catch (error) {
    return { rejected: true, code: error.code ?? error.status ?? null, result: null };
  }
}

test('GAP A2 transfer requires exact binding, real inbound, and typed reply grant', async (t) => {
  const scenarios = [
    'missing_author_binding',
    'wrong_conversation_binding',
    'missing_typed_grant',
    'follow_up_only_grant',
    'missing_inbound',
    'wrong_conversation_inbound',
  ];
  const failures = [];
  for (const scenario of scenarios) {
    const h = harness(t);
    const raw = source({ message_id: `message:a2-${scenario}` });
    const fixture = await approvedCandidate(h, raw);
    const target = await createTarget(h, raw);
    if (scenario === 'missing_author_binding') h.settings.opportunity.authorBindings = [];
    if (scenario === 'wrong_conversation_binding') {
      const other = await createTarget(h, raw);
      h.settings.opportunity.authorBindings[0].conversation_id = other.conversation_id;
    }
    if (scenario === 'missing_typed_grant') {
      // No grant exists.
    } else if (scenario === 'follow_up_only_grant') {
      await grant(h, target.conversation_id, 'follow_up');
    } else {
      await grant(h, target.conversation_id);
    }
    if (scenario === 'missing_inbound') {
      target.inboundMessageId = 'message:missing-inbound';
    }
    if (scenario === 'wrong_conversation_inbound') {
      const other = await createTarget(h, raw);
      target.inboundMessageId = other.inboundMessageId;
    }

    const outcome = await transferOutcome(h, fixture, target);
    if (!outcome.rejected) failures.push(scenario);
    if (outcome.rejected) {
      const situation = h.store.get('SELECT * FROM discovery_situations WHERE id=?', fixture.review.situation_id);
      assert.equal(situation.status, 'CANDIDATE');
      assert.equal(situation.transferred_engagement_id, null);
      assert.equal(eventCount(h, 'discovery.transferred'), 0);
      assert.equal(h.store.get('SELECT COUNT(*) AS n FROM engagements').n, 0);
    }
  }

  const positiveHarness = harness(t);
  const positiveRaw = source({ message_id: 'message:a2-positive' });
  const positiveFixture = await approvedCandidate(positiveHarness, positiveRaw);
  const positiveTarget = await createTarget(positiveHarness, positiveRaw);
  await grant(positiveHarness, positiveTarget.conversation_id);
  const positive = await transfer(positiveHarness, positiveFixture, positiveTarget);
  assert.equal(positive.status, 'TRANSFERRED');
  assert.equal(positive.contact_permission_created, false);
  assert.equal(positive.drafts_created, 0);
  assert.equal(positive.sends_started, false);
  assert.equal(positiveHarness.store.get('SELECT COUNT(*) AS n FROM contact_permissions').n, 1);
  assert.equal(positiveHarness.store.get('SELECT COUNT(*) AS n FROM messages WHERE direction=\'out\'').n, 0);

  const existingHarness = harness(t);
  existingHarness.settings.engagement.enabled = true;
  const existingRaw = source({ message_id: 'message:a2-existing-engagement' });
  const existingFixture = await approvedCandidate(existingHarness, existingRaw);
  const existingTarget = await createTarget(existingHarness, existingRaw);
  const existingEngagementId = existingHarness.service.engagement.current(existingTarget.conversation_id).id;
  await grant(existingHarness, existingTarget.conversation_id);
  const existing = await transferOutcome(existingHarness, existingFixture, existingTarget);
  if (existing.rejected) failures.push('existing_engagement_reuse');
  else {
    assert.equal(existing.result.engagement_id, existingEngagementId);
    assert.equal(existingHarness.store.get('SELECT COUNT(*) AS n FROM engagements').n, 1);
  }

  assert.deepEqual(failures, [], 'A2 accepted a transfer without a required binding/permission or failed to reuse Engagement');
});

test('GAP A3 typed reply grant must match person channel and account', async (t) => {
  const failures = [];
  const matchingRaw = source({ message_id: 'message:a3-matching' });
  const matchingHarness = harness(t);
  const matchingFixture = await approvedCandidate(matchingHarness, matchingRaw);
  const matchingTarget = await createTarget(matchingHarness, matchingRaw);
  await grant(matchingHarness, matchingTarget.conversation_id);
  const matching = await transferOutcome(matchingHarness, matchingFixture, matchingTarget);
  if (matching.rejected) failures.push('matching_grant');
  else {
    assert.equal(matching.result.status, 'TRANSFERRED');
    assert.equal(matchingHarness.store.get('SELECT COUNT(*) AS n FROM contact_permissions').n, 1);
  }

  const accountRaw = source({ message_id: 'message:a3-wrong-account' });
  const accountHarness = harness(t);
  const accountFixture = await approvedCandidate(accountHarness, accountRaw);
  const accountTarget = await createTarget(accountHarness, accountRaw, {
    channel: 'telegram',
    accountId: 'account-A',
  });
  const accountGrant = await grant(accountHarness, accountTarget.conversation_id);
  accountHarness.store.run(
    "UPDATE contact_permissions SET account_id='account-B' WHERE id=?",
    accountGrant.permission_id,
  );
  const wrongAccount = await transferOutcome(accountHarness, accountFixture, accountTarget);
  if (!wrongAccount.rejected) failures.push('wrong_account_grant');

  const channelRaw = source({ message_id: 'message:a3-wrong-channel' });
  const channelHarness = harness(t);
  const channelFixture = await approvedCandidate(channelHarness, channelRaw);
  const channelTarget = await createTarget(channelHarness, channelRaw);
  const channelGrant = await grant(channelHarness, channelTarget.conversation_id);
  channelHarness.store.run(
    "UPDATE contact_permissions SET channel='telegram' WHERE id=?",
    channelGrant.permission_id,
  );
  const wrongChannel = await transferOutcome(channelHarness, channelFixture, channelTarget);
  if (!wrongChannel.rejected) failures.push('wrong_channel_grant');

  assert.deepEqual(failures, [], 'A3 accepted a typed grant with a different channel or account');
});
