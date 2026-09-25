// Stage 1 acceptance: synthetic inputs through the real service/SQLite boundary.
// proof_level=integration; live_proof=false. No model, scheduler, or live transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, readJson } from '../business/config.mjs';
import { BusinessService } from '../business/service.mjs';
import { Store, id } from '../business/store.mjs';
import { applyTelegramDifference, bootstrapTelegramSource } from '../business/sources/telegram-readonly.mjs';

const SOURCE = 'public:stage1';
const TEXT = 'I have two hours a week. What does this offer involve?';
const source = (extra = {}) => ({ source_id: SOURCE, source_kind: 'sanitized_fixture',
  message_id: 'message:1', author_id: 'user:1', display_name: 'Synthetic author',
  thread_id: null, reply_to_id: null, version: 1, operation: 'upsert', text: TEXT,
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', ...extra });

function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-stage1-'));
  const settings = readJson(path.join(ROOT, 'config/default.json'));
  settings.discovery = { ...settings.discovery, enabled: true };
  settings.opportunity = { ...settings.opportunity, automatic: true, allowedSourceRefs: [SOURCE],
    activeOffer: { id: 'stage1-offer', version: 'v1', text: 'Synthetic offer', criteria: [], exclusions: [] } };
  settings.runtime = { ...settings.runtime, enabled: false, model: '', baseUrl: '' };
  settings.telegram = { ...settings.telegram, enabled: false, liveSending: false };
  let store = new Store(directory), service = new BusinessService(store, settings);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { settings, get store() { return store; }, get service() { return service; },
    command(action, payload, request = id(), actor = { kind: 'operator' }) {
      return service.command(action, payload, request, actor);
    },
    ingest(raw = source()) { return service.command('source.ingest', raw, id(), { kind: 'channel', sourceId: raw.source_id }); },
    detail(situationId) { return service.discoveryDetail(situationId); },
    restart() { store.close(); store = new Store(directory); store.recover(); service = new BusinessService(store, settings); },
  };
}

function payload(h, situationId, decision = 'OBSERVE') {
  const detail = h.detail(situationId);
  const evidence = detail.evidence.map(e => String(e.source_event_id));
  return { situation_id: detail.id, expected_revision: detail.revision,
    expected_evidence_fingerprint: detail.evidence_fingerprint, decision, evidence_event_ids: evidence,
    hypothesis: { text: 'A concise explanation may be useful; interest is unconfirmed.', evidence_event_ids: evidence,
      attributed_claims: [{ source_event_id: evidence[0], quote: 'I have two hours a week.' }],
      inferences: [{ text: 'Available time may constrain fit.', evidence_event_ids: evidence }],
      uncertainty: ['The time claim is unverified.', 'No intent to join or permission to contact is established.'] },
    why_now: { reason: 'The explicit question may deserve attention while its evidence is current.', evidence_event_ids: evidence },
    ...(decision === 'CANDIDATE' ? { opening_proposal: { text: 'I can explain the time requirements.',
      rationale: 'Answer the question if separately authorized.', constraints: ['operator review only'] } } : {}) };
}

async function fixture(h, decision = 'OBSERVE') {
  const ingested = await h.ingest();
  const row = h.store.get('SELECT situation_id FROM discovery_evidence WHERE source_event_id=?', ingested.source_event_id);
  const input = payload(h, row.situation_id, decision);
  const request = id();
  const result = await h.command('discovery.assess', input, request);
  return { input, result, request, sourceId: ingested.source_event_id, situationId: row.situation_id };
}

function proposal(h, f) { return h.detail(f.situationId).assessments.find(a => a.id === f.result.assessment_id); }
function noEffects(h) {
  for (const table of ['persons', 'conversations', 'channel_identities', 'messages', 'facts', 'contact_permissions',
    'engagements', 'drafts', 'approvals', 'delivery_attempts', 'outcome_events', 'lessons', 'runs']) {
    assert.equal(h.store.get(`SELECT COUNT(*) AS n FROM ${table}`).n, 0, table);
  }
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM tasks WHERE kind IN ('reply','engagement_evaluate')").n, 0);
  assert.deepEqual(h.store.all('PRAGMA foreign_key_check'), []);
}

test('S1 durable observations, attributed claims and uncertain interpretation stay separate after restart/replay', async t => {
  const h = harness(t), f = await fixture(h);
  const before = h.detail(f.situationId), a = proposal(h, f);
  assert.equal(a.reasoning_version, 1);
  assert.equal(a.epistemic_status, 'unverified_proposal');
  assert.deepEqual(a.hypothesis, f.input.hypothesis);
  assert.deepEqual(a.why_now, f.input.why_now);
  assert.equal(a.freshness.fresh, true);
  assert.equal(a.basis.evidence_fingerprint, f.input.expected_evidence_fingerprint);
  assert.equal(a.basis.offer_fingerprint, before.offer_fingerprint);
  assert.equal(a.basis.purpose, before.purpose);
  assert.equal(a.basis.expires_at, before.expires_at);
  assert.equal(a.basis.evidence[0].source_event_id, String(f.sourceId));
  assert.equal(a.basis.evidence[0].observed_at, h.store.get('SELECT created_at FROM events WHERE id=?', f.sourceId).created_at);
  assert.ok(Number.isFinite(Date.parse(a.basis.evidence[0].observed_at)));
  assert.equal(a.basis.evidence[0].author_id, 'user:1');
  assert.equal(a.basis.evidence[0].message_version, 1);
  assert.equal(before.evidence[0].source.text, TEXT);
  assert.equal(before.evidence[0].source.hypothesis, undefined);
  const durable = h.store.get("SELECT payload_json FROM events WHERE id=? AND kind='discovery.assessment'", a.id).payload_json;
  assert.deepEqual(JSON.parse(durable).hypothesis, f.input.hypothesis);
  h.restart();
  assert.deepEqual(await h.command('discovery.assess', f.input, f.request), f.result);
  assert.deepEqual(proposal(h, f), a);
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM events WHERE kind='discovery.assessment'").n, 1);
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM tasks').n, 0);
  noEffects(h);
});

test('S2 citations must match selected durable evidence; claims cannot forge observations or certainty', async t => {
  const h = harness(t), f = await fixture(h);
  await h.ingest(source({ message_id: 'other', author_id: 'user:other' }));
  const foreignId = String(h.store.get("SELECT id FROM events WHERE kind='source.message' ORDER BY id DESC LIMIT 1").id);
  const cases = [
    [p => { p.why_now.evidence_event_ids = []; }, 'DISCOVERY_REASONING_EVIDENCE_REQUIRED'],
    [p => { p.why_now.evidence_event_ids = [foreignId]; }, 'DISCOVERY_REASONING_EVIDENCE_SCOPE'],
    [p => { p.hypothesis.evidence_event_ids = [foreignId]; }, 'DISCOVERY_REASONING_EVIDENCE_SCOPE'],
    [p => { p.hypothesis.inferences[0].evidence_event_ids = [foreignId]; }, 'DISCOVERY_REASONING_EVIDENCE_SCOPE'],
    [p => { p.hypothesis.attributed_claims[0].source_event_id = foreignId; }, 'DISCOVERY_REASONING_EVIDENCE_SCOPE'],
    [p => { p.hypothesis.attributed_claims[0].quote = 'I consent to being contacted.'; }, 'DISCOVERY_CLAIM_QUOTE_MISMATCH'],
    [p => { p.hypothesis.attributed_claims[0].author_id = 'user:invented'; }, 'DISCOVERY_FIELDS_INVALID'],
    [p => { p.hypothesis.uncertainty = []; }, 'DISCOVERY_UNCERTAINTY_REQUIRED'],
    [p => { p.hypothesis.observed_facts = ['Confirmed interest']; }, 'DISCOVERY_FIELDS_INVALID'],
    [p => { p.why_now.fresh = true; }, 'DISCOVERY_FIELDS_INVALID'],
    [p => { p.why_now = 'Mixed legacy and structured reasoning'; }, 'DISCOVERY_FIELDS_INVALID'],
  ];
  const count = h.store.get('SELECT COUNT(*) AS n FROM events').n;
  for (const [mutate, code] of cases) {
    const p = payload(h, f.situationId); mutate(p);
    await assert.rejects(h.command('discovery.assess', p), { code });
  }
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM events').n, count);
  assert.equal(proposal(h, f).freshness.fresh, true);
  noEffects(h);
});

test('S2b references must be selected even within the same situation; proposals cannot be silently replaced or replayed', async t => {
  const h = harness(t), f = await fixture(h);
  const ingested = await h.ingest(source({ message_id: 'message:2' }));
  const input = payload(h, f.situationId);
  input.evidence_event_ids = [String(f.sourceId)];
  input.hypothesis.evidence_event_ids = [String(f.sourceId)];
  input.hypothesis.inferences[0].evidence_event_ids = [String(f.sourceId)];
  input.why_now.evidence_event_ids = [String(ingested.source_event_id)];
  await assert.rejects(h.command('discovery.assess', input), { code: 'DISCOVERY_REASONING_EVIDENCE_SCOPE' });
  input.why_now.evidence_event_ids = [String(f.sourceId)];
  input.hypothesis.uncertainty.push('The additional message does not establish consent either.');
  const result = await h.command('discovery.assess', input);
  const next = proposal(h, { situationId: f.situationId, result });
  assert.equal(next.basis.evidence.length, 1);
  // Change only the structured uncertainty on a fresh command: it must be durable,
  // cannot be replayed under the earlier request id, and supersedes the old proposal.
  const repeated = payload(h, f.situationId);
  const request = id();
  await h.command('discovery.assess', repeated, request);
  repeated.hypothesis.uncertainty.push('Another explicit unknown.');
  await assert.rejects(h.command('discovery.assess', repeated, request), { status: 409 });
  assert.ok(proposal(h, { situationId: f.situationId, result }).freshness.reasons.includes('DISCOVERY_ASSESSMENT_SUPERSEDED'));
  noEffects(h);
});

for (const operation of ['edit', 'delete']) test(`S3 ${operation} stales hypothesis and WHY NOW across restart and request replay`, async t => {
  const h = harness(t), f = await fixture(h, 'CANDIDATE');
  const old = proposal(h, f);
  await h.ingest(source({ version: 2, operation: operation === 'delete' ? 'delete' : 'upsert',
    text: operation === 'delete' ? null : 'Correction: I am no longer interested.', updated_at: '2026-01-01T00:01:00.000Z' }));
  assert.equal(proposal(h, f).freshness.fresh, false);
  h.restart();
  assert.deepEqual(await h.command('discovery.assess', f.input, f.request), f.result);
  assert.equal(proposal(h, f).freshness.fresh, false);
  assert.deepEqual(proposal(h, f).hypothesis, old.hypothesis);
  assert.deepEqual(proposal(h, f).why_now, old.why_now);
  await assert.rejects(h.command('discovery.review', { task_id: f.result.review_task_id, decision: 'approve',
    expected_revision: h.detail(f.situationId).revision, expected_evidence_fingerprint: old.evidence_fingerprint }));
  noEffects(h);
});

test('S4 revoked source stays stale after disabled restart, maintenance and reallow', async t => {
  const h = harness(t), f = await fixture(h);
  h.settings.opportunity.allowedSourceRefs = [];
  assert.ok(proposal(h, f).freshness.reasons.includes('SOURCE_NOT_ALLOWED'));
  h.settings.discovery.enabled = false;
  h.restart();
  h.service.reconcileDiscovery(); // Same bounded maintenance as baseline, including when disabled.
  h.settings.opportunity.allowedSourceRefs = [SOURCE];
  h.settings.discovery.enabled = true;
  h.restart();
  assert.equal(proposal(h, f).freshness.fresh, false);
  assert.ok(proposal(h, f).freshness.reasons.includes('SOURCE_REVOKED'));
  noEffects(h);
});

test('S5 new evidence stales the earlier interpretation, including a durable pending change after restart', async t => {
  const h = harness(t), f = await fixture(h);
  h.service.discoveryApply = () => { throw new Error('synthetic TX2 interruption'); };
  await h.ingest(source({ message_id: 'message:2', text: 'Actually, please clarify the cost too.' }));
  assert.ok(proposal(h, f).freshness.reasons.includes('DISCOVERY_PENDING_SOURCE_CHANGE'));
  h.restart();
  assert.equal(proposal(h, f).freshness.fresh, false);
  h.service.reconcileDiscovery();
  assert.equal(h.detail(f.situationId).freshness.fresh, true);
  assert.ok(proposal(h, f).freshness.reasons.includes('DISCOVERY_EVIDENCE_CHANGED'));
  const next = await h.command('discovery.assess', payload(h, f.situationId));
  assert.equal(h.detail(f.situationId).assessments.find(a => a.id === next.assessment_id).freshness.fresh, true);
  assert.ok(proposal(h, f).freshness.reasons.includes('DISCOVERY_ASSESSMENT_SUPERSEDED'));
  noEffects(h);
});

test('S6 WHY NOW expires using durable intake time, never refreshed by assessment or restart', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-25T12:00:00.000Z') });
  const h = harness(t); h.settings.discovery.ttlSeconds = 60;
  const f = await fixture(h), expires = proposal(h, f).basis.expires_at;
  t.mock.timers.tick(60001);
  h.restart();
  const a = proposal(h, f);
  assert.equal(a.basis.expires_at, expires);
  assert.ok(a.freshness.reasons.includes('DISCOVERY_EXPIRED'));
  await assert.rejects(h.command('discovery.assess', payload(h, f.situationId)), { code: /DISCOVERY_STALE/ });
  noEffects(h);
});

test('S7 structured candidate remains only a proposal before and after ordinary operator review', async t => {
  const h = harness(t), f = await fixture(h, 'CANDIDATE');
  assert.equal(f.result.contact_permission, false);
  assert.equal(f.result.executable, false);
  assert.deepEqual(f.result.allowed_effects, []);
  assert.equal(h.detail(f.situationId).opening_proposals.length, 1);
  await assert.rejects(h.command('discovery.assess', payload(h, f.situationId), id(), { kind: 'agent' }), { status: 403 });
  const detail = h.detail(f.situationId);
  await h.command('discovery.review', { task_id: f.result.review_task_id, decision: 'approve',
    expected_revision: detail.revision, expected_evidence_fingerprint: detail.evidence_fingerprint });
  assert.equal(proposal(h, f).epistemic_status, 'unverified_proposal');
  assert.equal(proposal(h, f).freshness.fresh, true, 'review changes authority state, not evidence basis');
  noEffects(h);
});

test('S8 legacy text assessments remain readable, unverified and subject to current freshness', async t => {
  const h = harness(t);
  const ingested = await h.ingest();
  const row = h.store.get('SELECT situation_id FROM discovery_evidence WHERE source_event_id=?', ingested.source_event_id);
  const p = { ...payload(h, row.situation_id), hypothesis: 'Legacy hypothesis', why_now: 'Legacy timing explanation' };
  const result = await h.command('discovery.assess', p);
  const f = { situationId: row.situation_id, result };
  assert.equal(proposal(h, f).reasoning_version, 0);
  assert.equal(proposal(h, f).hypothesis, p.hypothesis);
  assert.equal(proposal(h, f).epistemic_status, 'unverified_proposal');
  assert.equal(proposal(h, f).freshness.fresh, true);
  h.settings.opportunity.allowedSourceRefs = [];
  h.restart();
  assert.equal(proposal(h, f).freshness.fresh, false);
  noEffects(h);
});

test('S9 restart cannot treat the old Telegram checkpoint as current WHY NOW evidence', async t => {
  const h = harness(t), sourceId = 'telegram:channel:100';
  h.settings.opportunity.allowedSourceRefs = [sourceId];
  h.settings.opportunity.telegramSources = [{ sourceId, accountId: '999', channelId: '100',
    sourceKind: 'sanitized_fixture', processingBasis: 'Offline Stage 1 fixture', maxLagSeconds: 120 }];
  await bootstrapTelegramSource(h.service, sourceId, { pts: 10, history: [] });
  await applyTelegramDifference(h.service, sourceId, { kind: 'difference', account_id: '999', channel_id: '100',
    from_pts: 10, to_pts: 11, final: true,
    updates: [{ kind: 'new', channel_id: '100', pts: 11, pts_count: 1, message: { id: 1, channel_id: '100',
      from_id: { kind: 'user', id: '10' }, post: false, text: TEXT, date: 1767225600 } }] });
  h.service.reconcileDiscovery();
  const row = h.store.get('SELECT id FROM discovery_situations');
  assert.ok(row, 'offline transport fixture must produce a durable situation');
  const result = await h.command('discovery.assess', payload(h, row.id));
  const f = { situationId: row.id, result };
  assert.equal(proposal(h, f).freshness.fresh, true);
  h.restart();
  assert.equal(proposal(h, f).freshness.fresh, false);
  assert.ok(proposal(h, f).freshness.reasons.includes('SOURCE_TRANSPORT_NOT_CURRENT'));
  noEffects(h);
});
