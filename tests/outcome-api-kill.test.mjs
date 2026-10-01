import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start } from '../business/server.mjs';
import { id } from '../business/store.mjs';
import { ROOT, readJson, validateOutcomes } from '../business/config.mjs';

const config = () => {
  const value = readJson(path.join(ROOT, 'config/default.json'));
  value.server.port = 0;
  value.scheduler.enabled = false;
  value.outcomes = { enabled: true, responseWindowSeconds: 604800 };
  return value;
};

async function serverHarness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-outcome-api-'));
  const app = await start({ config: config(), directory });
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const session = await (await fetch(`${origin}/api/session`)).json();
  const headers = { 'x-partner-token': session.token };
  return { app, origin, headers };
}

async function createObservedReply(app) {
  const created = await app.service.command('person.create', { name: 'API subject', source: 'local API test' }, id());
  const conversation = app.store.get('SELECT * FROM conversations WHERE id=?', created.conversation_id);
  const sentAt = new Date(Date.now() - 1000).toISOString();
  const messageId = id();
  app.store.run(`INSERT INTO messages(id,conversation_id,direction,text,author,source,created_at)
    VALUES(?,?,'out','A local test draft','operator','local API test',?)`, messageId, conversation.id, sentAt);
  app.service.outcomes.observeSent(conversation.id, messageId, sentAt, 'unverified');
  await app.service.command('message.record', { conversation_id: conversation.id, direction: 'in',
    text: 'A local test reply', source: 'local API test' }, id(), { kind: 'channel' });
  app.service.outcomes.reconcile({ now: Date.now() });
  return app.store.get('SELECT * FROM outcome_candidates WHERE conversation_id=?', conversation.id);
}

test('outcome configuration requires a strict, usable read-only layer shape', () => {
  assert.doesNotThrow(() => validateOutcomes({ outcomes: { enabled: false, responseWindowSeconds: 0 } }));
  assert.doesNotThrow(() => validateOutcomes({ outcomes: { enabled: true, responseWindowSeconds: 3600 } }));
  for (const outcomes of [null, [], { enabled: 'false' }, { enabled: 1 },
    { enabled: false, responseWindowSeconds: 'one week' },
    { enabled: true }, { enabled: true, responseWindowSeconds: 3599 },
    { enabled: true, responseWindowSeconds: 31536001 },
    { enabled: true, responseWindowSeconds: 3600, modelEnabled: false },
    { enabled: false, maxModelRunsPerDay: 5 }]) {
    assert.throws(() => validateOutcomes({ outcomes }), undefined, JSON.stringify(outcomes));
  }
  assert.doesNotThrow(() => validateOutcomes({}), 'omitted outcomes stay disabled for embedded configs');
});

test('the real operator page serves the Outcome module referenced by its browser entrypoint', async t => {
  const { origin } = await serverHarness(t);
  const html = await fetch(origin);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /data-tab="outcomes"/);
  const entry = await fetch(origin + '/app.js');
  assert.equal(entry.status, 200);
  assert.match(await entry.text(), /import\('\.\/outcomes\.js'\)/);
  const module = await fetch(origin + '/outcomes.js');
  assert.equal(module.status, 200);
  assert.match(module.headers.get('content-type'), /javascript/);
  assert.match(await module.text(), /export function createOutcomesView/);
});

test('authenticated outcome list and detail API reject unrecognized or ambiguous input', async (t) => {
  const { app, origin, headers } = await serverHarness(t);
  const candidate = await createObservedReply(app);

  assert.equal((await fetch(`${origin}/api/outcomes`)).status, 403, 'outcome reads require the operator token');
  const listResponse = await fetch(`${origin}/api/outcomes?status=pending&limit=10`, { headers });
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].id, candidate.id);
  assert.equal(typeof list.coverage.windows, 'number');

  const detailResponse = await fetch(`${origin}/api/outcomes/${candidate.id}`, { headers });
  assert.equal(detailResponse.status, 200);
  assert.equal((await detailResponse.json()).kind, 'reply_observed');

  const invalidListQueries = [
    '?extra=1', '?status=pending&status=all', '?limit=1&limit=2', '?cursor=x&cursor=y',
    '?status=made-up', '?limit=0', '?limit=51', '?limit=1.5', '?cursor=not-an-id',
  ];
  for (const query of invalidListQueries) {
    const response = await fetch(`${origin}/api/outcomes${query}`, { headers });
    assert.equal(response.status, 400, `${query} must be rejected`);
  }

  for (const suffix of [`${candidate.id}?limit=1`, `${candidate.id}?extra=1`,
    `${candidate.id}/extra`, 'malformed-id']) {
    const response = await fetch(`${origin}/api/outcomes/${suffix}`, { headers });
    assert.equal(response.status, 400, `${suffix} must be rejected`);
  }
  assert.equal((await fetch(`${origin}/api/outcomes`, { method: 'POST', headers })).status, 405);
  assert.equal((await fetch(`${origin}/api/outcomes/${candidate.id}`, { method: 'DELETE', headers })).status, 405);
});
