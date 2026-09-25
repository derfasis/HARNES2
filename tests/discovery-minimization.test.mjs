// Stage 3C contract: presentation detail is an allowlisted projection, not the internal read model.
// proof_level=integration; live_proof=false. GET only, no writes, no model, no scheduler wake.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { start } from '../business/server.mjs';
import { ROOT, readJson } from '../business/config.mjs';

const SOURCE = 'public:stage3c';
const TEXT = 'I have two hours a week. What does this offer involve?';

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}

function request(port, route, { body, token, method } = {}) {
  const verb = method ?? (body ? 'POST' : 'GET');
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: verb,
      headers: { ...(token ? { 'x-partner-token': token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}

async function fixture(t) {
  const denied = () => { throw Error('External model/Telegram call forbidden'); };
  const fetchGuard = mock.method(globalThis, 'fetch', denied), spawnGuard = mock.method(childProcess, 'spawn', denied);
  syncBuiltinESMExports();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-stage3c-'));
  const config = readJson(path.join(ROOT, 'config/default.json'));
  config.server.port = await freePort();
  config.scheduler.enabled = false;
  config.discovery = { ...config.discovery, enabled: true, ttlSeconds: 86400 };
  config.opportunity = { ...config.opportunity, automatic: true, allowedSourceRefs: [SOURCE],
    activeOffer: { id: 'stage3c-offer', version: 'v1', text: 'Synthetic offer', criteria: [], exclusions: [] } };
  config.runtime = { ...config.runtime, enabled: false, model: '', baseUrl: '' };
  config.telegram = { ...config.telegram, enabled: false, liveSending: false };
  config.engagement = { ...config.engagement, enabled: false };
  const app = await start({ directory, config });
  t.after(async () => {
    await app.close();
    assert.equal(fetchGuard.mock.callCount(), 0);
    assert.equal(spawnGuard.mock.callCount(), 0);
    mock.restoreAll(); syncBuiltinESMExports();
    assert.equal(path.dirname(directory), os.tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { app, config, api: (route, options) => request(config.server.port, route, options) };
}

function source(extra = {}) {
  return { source_id: SOURCE, source_kind: 'sanitized_fixture', message_id: 'message:1', author_id: 'user:1',
    display_name: 'Synthetic author', thread_id: 'thread:1', reply_to_id: null, version: 1, operation: 'upsert',
    text: TEXT, created_at: '2026-09-25T10:00:00.000Z', updated_at: '2026-09-25T10:00:00.000Z', ...extra };
}

function assessmentPayload(detail) {
  const evidence = detail.evidence.map((item) => String(item.source_event_id));
  return { situation_id: detail.id, expected_revision: detail.revision,
    expected_evidence_fingerprint: detail.evidence_fingerprint, decision: 'CANDIDATE', evidence_event_ids: evidence,
    hypothesis: { text: 'A bounded explanation may help; interest is unconfirmed.', evidence_event_ids: evidence,
      attributed_claims: [{ source_event_id: evidence[0], quote: 'I have two hours a week.' }],
      inferences: [{ text: 'Available time may constrain fit.', evidence_event_ids: evidence }],
      uncertainty: ['The time claim is unverified.'] },
    why_now: { reason: 'The explicit question may deserve attention while evidence is current.', evidence_event_ids: evidence },
    opening_proposal: { text: 'I can explain the time requirements.', rationale: 'Answer only after separate authorization.',
      constraints: ['operator review only'] } };
}

async function candidate(app) {
  const ingested = await app.service.command('source.ingest', source(), randomUUID(),
    { kind: 'channel', sourceId: SOURCE });
  const row = app.store.get('SELECT situation_id FROM discovery_evidence WHERE source_event_id=?', ingested.source_event_id);
  const detail = app.service.discoveryDetail(row.situation_id);
  await app.service.command('discovery.assess', assessmentPayload(detail), randomUUID(), { kind: 'operator' });
  return row.situation_id;
}

const TOP_LEVEL_KEYS = ['allowed_effects', 'assessments', 'basis', 'contact_permission', 'evidence',
  'evidence_fingerprint', 'executable', 'freshness', 'opening_proposals', 'review_tasks', 'revision',
  'sent', 'situation_id', 'status', 'storage_status'];

test('3C detail is an allowlisted projection and hides the internal payload', async t => {
  const { app, config, api } = await fixture(t);
  const situationId = await candidate(app);
  const token = (await api('/api/session')).body.token;
  const before = app.store.all('SELECT * FROM events ORDER BY id').map(row => JSON.stringify(row)).join('|');

  const response = await api(`/api/discovery/${situationId}`, { token });
  assert.equal(response.status, 200);
  const after = app.store.all('SELECT * FROM events ORDER BY id').map(row => JSON.stringify(row)).join('|');
  assert.equal(after, before, 'presentation detail must not write');

  const body = response.body;
  assert.deepEqual(Object.keys(body).sort(), TOP_LEVEL_KEYS);
  assert.equal(body.situation_id, situationId);
  assert.equal(body.executable, false);
  assert.equal(body.contact_permission, false);
  assert.equal(body.sent, false);
  assert.deepEqual(body.allowed_effects, []);
  assert.deepEqual(Object.keys(body.basis).sort(), ['context_key', 'created_at', 'expires_at', 'purpose',
    'source_ref', 'subject_ref', 'updated_at']);

  // Nothing internal leaks: no partner id, no offer fingerprint, no raw event payload.
  const serialized = JSON.stringify(body);
  for (const leaked of ['payload_json', 'offer_fingerprint', 'partner_id', config.partnerId, 'source_kind']) {
    assert.equal(serialized.includes(leaked), false, `must not expose ${leaked}`);
  }

  const [item] = body.evidence;
  assert.deepEqual(Object.keys(item).sort(), ['author_id', 'message_id', 'message_version', 'observed_at',
    'source_event_id', 'text', 'text_truncated']);
  assert.equal(item.text, TEXT);
  assert.equal(item.text_truncated, false);

  const [assessment] = body.assessments;
  assert.equal(assessment.epistemic_status, 'unverified_proposal');
  // Stage 4E: the read-only basis binding an operator screen needs to know a decision is possible.
  assert.equal(assessment.result_revision, body.revision);
  assert.equal(assessment.evidence_fingerprint, body.evidence_fingerprint);
  assert.deepEqual(Object.keys(assessment).sort(), ['allowed_effects', 'contact_permission', 'decision',
    'epistemic_status', 'evidence_fingerprint', 'executable', 'freshness', 'hypothesis', 'id',
    'reasoning_shape', 'reasoning_version', 'result_revision', 'why_now']);
  assert.equal(assessment.hypothesis.text_truncated, false);
  assert.equal(assessment.reasoning_shape, 'structured_v1');
  assert.equal(assessment.hypothesis.attributed_claims[0].quote, 'I have two hours a week.');
  assert.equal(assessment.why_now.reason, assessment.why_now.reason);
  assert.deepEqual(Object.keys(assessment.freshness).sort(), ['fresh', 'reasons']);
  assert.deepEqual(Object.keys(assessment.why_now).sort(), ['evidence_event_ids', 'reason', 'reason_truncated']);
  assert.equal(assessment.executable, false);

  const [proposal] = body.opening_proposals;
  assert.deepEqual(Object.keys(proposal).sort(), ['constraints', 'contact_permission', 'executable', 'id',
    'rationale', 'rationale_truncated', 'sent', 'text', 'text_truncated']);
  assert.equal(proposal.sent, false);
  assert.equal(proposal.executable, false);
  assert.deepEqual(Object.keys(body.review_tasks[0]).sort(), ['created_at', 'id', 'status']);
});

test('3C evidence text is bounded and says so, and stale reasons survive the projection', async t => {
  const { app, api } = await fixture(t);
  const long = `${TEXT} ${'x'.repeat(6000)}`;
  const ingested = await app.service.command('source.ingest', source({ text: long }), randomUUID(),
    { kind: 'channel', sourceId: SOURCE });
  const situationId = app.store.get('SELECT situation_id FROM discovery_evidence WHERE source_event_id=?',
    ingested.source_event_id).situation_id;
  const token = (await api('/api/session')).body.token;
  const body = (await api(`/api/discovery/${situationId}`, { token })).body;
  const [item] = body.evidence;
  assert.equal(item.text_truncated, true);
  assert.ok(item.text.length <= 2000);
  assert.equal(item.text.startsWith(TEXT), true);

  app.store.run("UPDATE discovery_situations SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?", situationId);
  const expired = (await api(`/api/discovery/${situationId}`, { token })).body;
  assert.equal(expired.freshness.fresh, false);
  assert.ok(expired.freshness.reasons.includes('DISCOVERY_EXPIRED'));
});

test('3C presentation detail is operator-only and the internal read model is unchanged', async t => {
  const { app, api } = await fixture(t);
  const situationId = await candidate(app);
  assert.throws(() => app.service.discoveryPresentationDetail(situationId, { kind: 'agent' }),
    { code: 'DISCOVERY_OPERATOR_REQUIRED' });
  assert.throws(() => app.service.discoveryPresentationDetail(situationId, { kind: 'system' }),
    { code: 'DISCOVERY_OPERATOR_REQUIRED' });
  assert.throws(() => app.service.discoveryPresentationDetail(randomUUID(), { kind: 'operator' }),
    { code: 'DISCOVERY_SITUATION_NOT_FOUND' });

  const before = app.service.discoveryDetail(situationId);
  const presentation = app.service.discoveryPresentationDetail(situationId, { kind: 'operator' });
  const after = app.service.discoveryDetail(situationId);
  assert.deepEqual(after, before, 'internal discoveryDetail() must not change');
  assert.deepEqual(after.evidence[0].source, JSON.parse(app.store.get('SELECT payload_json FROM events WHERE id=?',
    after.evidence[0].source_event_id).payload_json), 'internal read model keeps the raw source payload');
  assert.equal(presentation.evidence[0].source, undefined);
});

test('3C every bounded text announces its own truncation, including quotes and proposals', async t => {
  const { app, api } = await fixture(t);
  const long = 'y'.repeat(3000);
  const ingested = await app.service.command('source.ingest', source({ text: `${TEXT} ${long}` }), randomUUID(),
    { kind: 'channel', sourceId: SOURCE });
  const situationId = app.store.get('SELECT situation_id FROM discovery_evidence WHERE source_event_id=?',
    ingested.source_event_id).situation_id;
  const detail = app.service.discoveryDetail(situationId);
  const evidence = [String(detail.evidence[0].source_event_id)];
  await app.service.command('discovery.assess', { situation_id: situationId, expected_revision: detail.revision,
    expected_evidence_fingerprint: detail.evidence_fingerprint, decision: 'CANDIDATE', evidence_event_ids: evidence,
    hypothesis: { text: long, evidence_event_ids: evidence,
      attributed_claims: [{ source_event_id: evidence[0], quote: long }],
      inferences: [{ text: long, evidence_event_ids: evidence }], uncertainty: [long.slice(0, 1900)] },
    why_now: { reason: long, evidence_event_ids: evidence },
    opening_proposal: { text: long, rationale: long, constraints: [long.slice(0, 450)] } },
  randomUUID(), { kind: 'operator' });
  const token = (await api('/api/session')).body.token;
  const body = (await api(`/api/discovery/${situationId}`, { token })).body;
  const [assessment] = body.assessments;
  assert.equal(assessment.hypothesis.text_truncated, true);
  assert.equal(assessment.hypothesis.text.length, 2000);
  assert.equal(assessment.hypothesis.attributed_claims[0].quote_truncated, true);
  assert.equal(assessment.hypothesis.attributed_claims[0].quote.length, 2000);
  assert.equal(assessment.hypothesis.inferences[0].text_truncated, true);
  assert.equal(assessment.why_now.reason_truncated, true);
  assert.equal(assessment.why_now.reason.length, 2000);
  const [proposal] = body.opening_proposals;
  assert.equal(proposal.text_truncated, true);
  assert.equal(proposal.rationale_truncated, true);
});

test('3C a legacy v0 assessment survives the projection with its two strings intact', async t => {
  const { app, config, api } = await fixture(t);
  const ingested = await app.service.command('source.ingest', source(), randomUUID(),
    { kind: 'channel', sourceId: SOURCE });
  const situationId = app.store.get('SELECT situation_id FROM discovery_evidence WHERE source_event_id=?',
    ingested.source_event_id).situation_id;
  const detail = app.service.discoveryDetail(situationId);
  // A pre-Stage-1 durable assessment: two plain strings, no structured reasoning, no version.
  app.store.run("INSERT INTO events(partner_id,kind,actor,payload_json,created_at) VALUES(?,?,?,?,?)",
    config.partnerId, 'discovery.assessment', 'operator:legacy', JSON.stringify({ situation_id: situationId,
      basis_revision: 0, result_revision: 1, decision: 'OBSERVE', hypothesis: 'Legacy free-text hypothesis.',
      why_now: 'Legacy free-text why now.', evidence: [String(detail.evidence[0].source_event_id)] }),
    new Date().toISOString());
  const token = (await api('/api/session')).body.token;
  const body = (await api(`/api/discovery/${situationId}`, { token })).body;
  const [assessment] = body.assessments;
  assert.equal(assessment.reasoning_version, 0);
  assert.equal(assessment.reasoning_shape, 'legacy_v0_strings');
  assert.equal(assessment.hypothesis.text, 'Legacy free-text hypothesis.');
  assert.equal(assessment.why_now.reason, 'Legacy free-text why now.');
  assert.deepEqual(assessment.hypothesis.attributed_claims, []);
  assert.deepEqual(assessment.hypothesis.inferences, []);
  assert.deepEqual(assessment.hypothesis.uncertainty, []);
  assert.deepEqual(assessment.why_now.evidence_event_ids, []);
  assert.equal(assessment.epistemic_status, 'unverified_proposal');
});
