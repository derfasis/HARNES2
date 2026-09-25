// Stage 3B contract: HTTP presentation boundary for the Discovery read model.
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

const SOURCE = 'public:stage3b';
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-stage3b-'));
  const config = readJson(path.join(ROOT, 'config/default.json'));
  config.server.port = await freePort();
  config.scheduler.enabled = false;
  config.discovery = { ...config.discovery, enabled: true, ttlSeconds: 86400 };
  config.opportunity = { ...config.opportunity, automatic: true, allowedSourceRefs: [SOURCE],
    activeOffer: { id: 'stage3b-offer', version: 'v1', text: 'Synthetic offer', criteria: [], exclusions: [] } };
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

function assessmentPayload(detail, decision = 'OBSERVE') {
  const evidence = detail.evidence.map((item) => String(item.source_event_id));
  return { situation_id: detail.id, expected_revision: detail.revision,
    expected_evidence_fingerprint: detail.evidence_fingerprint, decision, evidence_event_ids: evidence,
    hypothesis: { text: 'A bounded explanation may help; interest is unconfirmed.', evidence_event_ids: evidence,
      attributed_claims: [{ source_event_id: evidence[0], quote: 'I have two hours a week.' }],
      inferences: [{ text: 'Available time may constrain fit.', evidence_event_ids: evidence }],
      uncertainty: ['The time claim is unverified.'] },
    why_now: { reason: 'The explicit question may deserve attention while evidence is current.', evidence_event_ids: evidence } };
}

async function blockedSituation(app, decision, extra = {}) {
  const ingested = await app.service.command('source.ingest', source(), randomUUID(),
    { kind: 'channel', sourceId: SOURCE });
  const row = app.store.get('SELECT situation_id FROM discovery_evidence WHERE source_event_id=?', ingested.source_event_id);
  const before = app.service.discoveryDetail(row.situation_id);
  await app.service.command('discovery.assess', assessmentPayload(before), randomUUID(), { kind: 'operator' });
  const detail = app.service.discoveryDetail(row.situation_id);
  await app.service.command('discovery.reason', { situation_id: row.situation_id,
    assessment_id: String(detail.assessments.at(-1).id), expected_revision: detail.revision,
    expected_evidence_fingerprint: detail.evidence_fingerprint, decision, reason: `Stage 3B ${decision}`, ...extra },
  randomUUID(), { kind: 'operator' });
  return row.situation_id;
}

test('3B reason-states list is served behind the existing operator HTTP boundary and never writes', async t => {
  const { app, api } = await fixture(t);
  const situationId = await blockedSituation(app, 'IGNORE');
  assert.equal((await api('/api/discovery/reason-states')).status, 403);
  assert.equal((await api('/api/discovery/reason-states', { token: 'wrong-token' })).status, 403);
  assert.equal((await api(`/api/discovery/${situationId}`)).status, 403);

  const token = (await api('/api/session')).body.token;
  const before = app.store.all('SELECT * FROM events ORDER BY id').length
    + app.store.all('SELECT * FROM command_receipts ORDER BY id').length;
  const list = await api('/api/discovery/reason-states', { token });
  assert.equal(list.status, 200);
  const after = app.store.all('SELECT * FROM events ORDER BY id').length
    + app.store.all('SELECT * FROM command_receipts ORDER BY id').length;
  assert.equal(after, before, 'HTTP reads must not write');

  assert.equal(list.body.items.length, 1);
  const [item] = list.body.items;
  assert.equal(item.situation_id, situationId);
  assert.equal(item.decision, 'IGNORE');
  assert.equal(item.state, 'BLOCKED');
  assert.equal(item.unlock, 'EVIDENCE_CHANGE');
  assert.deepEqual(Object.keys(item.freshness).sort(), ['fresh', 'reasons']);
  assert.equal(item.executable, false);
  assert.equal(item.contact_permission, false);
  assert.deepEqual(item.allowed_effects, []);
  assert.equal(JSON.stringify(list.body).includes('two hours a week'), false, 'list must not expose source text');

  // The literal path is the list, never a situation lookup.
  const detail = await api(`/api/discovery/${situationId}`, { token });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.id, situationId);
  assert.equal(detail.body.assessments.at(-1).epistemic_status, 'unverified_proposal');
  assert.equal(detail.body.executable, false);
  assert.equal(detail.body.contact_permission, false);
});

test('3B list validates query strictly and refuses every non-GET method', async t => {
  const { app, api } = await fixture(t);
  await blockedSituation(app, 'WAIT', { wait: { kind: 'evidence_change' } });
  const token = (await api('/api/session')).body.token;
  const options = { token };

  const page = await api('/api/discovery/reason-states?limit=1', options);
  assert.equal(page.status, 200);
  assert.equal(page.body.items.length, 1);
  assert.equal(page.body.next_cursor, null);

  assert.equal((await api('/api/discovery/reason-states?limit=0', options)).status, 400);
  assert.equal((await api('/api/discovery/reason-states?limit=101', options)).status, 400);
  assert.equal((await api('/api/discovery/reason-states?limit=1.5', options)).status, 400);
  assert.equal((await api('/api/discovery/reason-states?limit=abc', options)).status, 400);
  assert.equal((await api('/api/discovery/reason-states?cursor=not-a-uuid', options)).status, 400);
  assert.equal((await api('/api/discovery/reason-states?status=OBSERVING', options)).status, 400);
  assert.equal((await api('/api/discovery/reason-states?limit=1&limit=2', options)).status, 400);

  for (const method of ['POST', 'PUT', 'PATCH']) {
    assert.equal((await api('/api/discovery/reason-states', { ...options, method, body: {} })).status, 405);
    assert.equal((await api('/api/discovery/anything', { ...options, method, body: {} })).status, 405);
  }
  assert.equal((await api('/api/discovery/reason-states', { ...options, method: 'DELETE' })).status, 405);
  assert.equal((await api('/api/discovery/anything', { ...options, method: 'DELETE' })).status, 405);
  assert.equal((await api(`/api/discovery/${randomUUID()}`, { ...options, method: 'POST', body: {} })).status, 405);
});
