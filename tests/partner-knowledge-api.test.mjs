import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start } from '../business/server.mjs';
import { ROOT, readJson } from '../business/config.mjs';
import { loadPartnerKnowledge } from '../business/knowledge.mjs';

test('authenticated operator state uses the country reference projection without enabling runtime or effects', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-knowledge-api-'));
  const config = readJson(path.join(ROOT, 'config/default.json'));
  config.server.port = 0; config.scheduler.enabled = false;
  const app = await start({ config, directory });
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(`${origin}/api/state`)).status, 403);
  const session = await (await fetch(`${origin}/api/session`)).json();
  const response = await fetch(`${origin}/api/state`, { headers: { 'x-partner-token': session.token } });
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.deepEqual(state.knowledge, loadPartnerKnowledge({ audience: 'operator' }));
  assert.equal(state.configuration.runtime_enabled, false);
  assert.equal(config.telegram.enabled, false); assert.equal(config.telegram.liveSending, false);
  for (const table of ['persons', 'contact_permissions', 'drafts', 'delivery_attempts'])
    assert.equal(app.store.get(`SELECT COUNT(*) n FROM ${table}`).n, 0, table);
});
