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

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
function request(port, route, body, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: body ? 'POST' : 'GET',
      headers: { ...(token ? { 'x-partner-token': token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
test('existing dashboard API reviews an isolated card with authentication, audit and zero external effects', async t => {
  const denied = () => { throw Error('External model/Telegram call forbidden'); };
  const fetchGuard = mock.method(globalThis, 'fetch', denied), spawnGuard = mock.method(childProcess, 'spawn', denied);
  syncBuiltinESMExports();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-dashboard-'));
  const config = readJson(path.join(ROOT, 'config/default.json'));
  config.server.port = await freePort(); config.scheduler.enabled = false;
  const input = readJson(path.join(ROOT, 'benchmarks/opportunity-projection-v0/case-01.json'));
  input.source.captured_at = new Date().toISOString();
  Object.assign(config.opportunity, { allowedSourceRefs: [input.source.ref], activeOffer: input.active_offer });
  const app = await start({ directory, config });
  t.after(async () => {
    await app.close(); assert.equal(fetchGuard.mock.callCount(), 0); assert.equal(spawnGuard.mock.callCount(), 0);
    mock.restoreAll(); syncBuiltinESMExports();
    assert.equal(path.dirname(directory), os.tmpdir()); fs.rmSync(directory, { recursive: true, force: true });
  });
  const c = await app.service.command('opportunity.capture', { snapshot: input }, randomUUID());
  const m = c.context.input.message;
  const output = { contract_version: 'opportunity-projection-v0', situation_id: c.context.input.situation_id,
    opportunity: { hypothesis: 'Hand-authored offline question.', evidence: [{ message_id: m.id, author_id: m.author_id,
      version: c.context.source_metadata.at(-1).version, span: m.text, kind: 'question', attribution: 'author_statement' }], contradictions: [], unknowns: ['Operator review required.'] },
    next_action: { schema_version: 1, situation_id: c.context.input.situation_id, decision: 'PUBLIC_REPLY', confidence: 0.8,
      strategy: 'Review.', reason: 'Offline fixture.', evidence_message_ids: [m.id], unknowns: [], risk_flags: [],
      draft: { channel: 'public', action: 'reply', target_id: m.author_id, text: 'Not sent.', source_message_ids: [m.id] },
      review: { required: true, status: 'pending', authorization: 'none' }, reevaluate_after: null },
    authority: { contact_permission: false, allowed_effects: [] } };
  const task = await app.service.command('opportunity.consume', { capture_id: c.capture_id, output }, randomUUID());
  const api = (route, body, token) => request(config.server.port, route, body, token);
  assert.equal((await api('/api/opportunities')).status, 403);
  assert.equal((await api(`/api/opportunities/${task.task_id}`)).status, 403);
  const token = (await api('/api/session')).body.token;
  const command = (action, payload) => ({ action, payload, request_id: randomUUID() });
  const queue = await api('/api/opportunities', undefined, token);
  assert.equal(queue.body.total, 1); assert.equal(queue.body.items[0].source_message.text, m.text);
  const d = (await api(`/api/opportunities/${task.task_id}`, undefined, token)).body;
  const p = { task_id: task.task_id, fingerprint: d.fingerprint, expected_revision: 0 };
  const edit = command('opportunity.review.edit', { ...p, text: 'Human revision.', reason: 'Offline API test.' });
  assert.equal((await api('/api/commands', edit)).status, 403);
  const edited = await api('/api/commands', edit, token); assert.equal(edited.status, 200);
  assert.deepEqual((await api('/api/commands', edit, token)).body, edited.body);
  assert.equal((await api('/api/commands', command('opportunity.review.approve', p), token)).status, 409);
  assert.equal((await api('/api/commands', command('opportunity.review.approve', { ...p, expected_revision: 1 }), token)).status, 200);
  assert.equal((await api('/api/opportunities', undefined, token)).body.total, 0);
  assert.equal((await api('/api/opportunities?status=approved', undefined, token)).body.total, 1);
  const detail = (await api(`/api/opportunities/${task.task_id}`, undefined, token)).body;
  assert.equal(detail.review.draft_text, 'Human revision.'); assert.equal(detail.review_history.length, 2);
  assert.deepEqual(detail.output, output); assert.equal(detail.executable, false); assert.equal(detail.contact_permission, false);
  assert.equal((await api('/api/commands', command('task.approve', { task_id: task.task_id }), token)).status, 409);
  assert.equal((await api('/api/deliver', { draft_id: task.task_id }, token)).status, 409);
  assert.equal((await api('/api/opportunities?limit=-1', undefined, token)).status, 409);
  assert.equal((await api('/api/commands', command('opportunity.review.reject', { ...p, expected_revision: 2, reason: 'Rejected after inspection.' }), token)).status, 200);
  assert.equal((await api('/api/opportunities?status=rejected', undefined, token)).body.total, 1);
  for (const table of ['runs', 'drafts', 'approvals', 'delivery_attempts', 'tool_calls']) assert.equal(app.store.get(`SELECT COUNT(*) AS n FROM ${table}`).n, 0);
  assert.equal(config.runtime.enabled, false); assert.equal(config.telegram.enabled, false); assert.equal(config.telegram.liveSending, false);
});
