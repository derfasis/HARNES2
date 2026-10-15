import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, readJson } from '../business/config.mjs';
import { Store, hash, id } from '../business/store.mjs';
import { exportPartner } from '../business/export.mjs';
import { start } from '../business/server.mjs';

const now = () => new Date().toISOString();

function importBundle(t, store, bundle, name) {
  const source = path.join(store.directory, `${name}.json`);
  const destination = path.join(ROOT, 'exports', `${name}-${id()}`);
  fs.writeFileSync(source, JSON.stringify(bundle), { flag: 'wx' });
  t.after(() => { fs.rmSync(source, { force: true }); fs.rmSync(destination, { recursive: true, force: true }); });
  const result = spawnSync(process.execPath, ['scripts/import.mjs', source, destination], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return { destination, result };
}

function oldSchema20(bundle) {
  const old = structuredClone(bundle);
  old.migrations = old.migrations.slice(0, 20);
  for (const table of ['scout_message_queries', 'scout_query_receipts', 'scout_query_proposals']) delete old.tables[table];
  old.tables_sha256 = hash(JSON.stringify(old.tables));
  return old;
}

function addQueryHistory(store) {
  const partner_id = store.get('SELECT id FROM partners LIMIT 1').id;
  const campaign_id = id(), candidate_id = id(), grant_id = id(), query_job_id = id(), query_id = id();
  const created_at = now(), expires_at = new Date(Date.now() + 3600000).toISOString();
  store.run(`INSERT INTO scout_campaigns(id,partner_id,title,topic,config_json,revision,topic_hash,status,created_at,updated_at)
    VALUES(?,?,?,?,?,1,?,'active',?,?)`, campaign_id, partner_id, 'Transfer fixture', 'Synthetic query',
    JSON.stringify({ topic: 'Synthetic query', queries: ['supplier'] }), hash('Synthetic query'), created_at, created_at);
  store.run(`INSERT INTO scout_candidates(id,campaign_id,account_id,channel_id,username,title,kind,joined,origin_json,sample_id,reason,created_at,updated_at)
    VALUES(?,?,?,'123456789','sample_channel','Synthetic source','channel',0,'{}',NULL,NULL,?,?)`, candidate_id, campaign_id, '123456789', created_at, created_at);
  store.run(`INSERT INTO scout_grants(id,campaign_id,campaign_revision,kind,account_id,candidate_id,sample_id,assessment_id,purpose,max_lag_seconds,
    catchup_from_pts,checkpoint_fingerprint,accept_historical_gap,expires_at,status,created_at,reason)
    VALUES(?,?,1,'audit','123456789',?,NULL,NULL,'Transfer fixture',NULL,NULL,NULL,0,?,'active',?,NULL)`, grant_id, campaign_id, candidate_id, expires_at, created_at);
  store.run(`INSERT INTO scout_jobs(id,campaign_id,campaign_revision,grant_id,candidate_id,kind,status,cursor_json,sample_id,run_id,owner_id,attempts,next_at,reason,created_at,updated_at)
    VALUES(?,?,1,?,?,'search','completed','{}',NULL,NULL,NULL,1,?,NULL,?,?)`, query_job_id, campaign_id, grant_id, candidate_id, created_at, created_at, created_at);
  const call_id = id();
  store.run(`INSERT INTO scout_calls(id,partner_id,account_id,job_id,source_ref,operation,status,retry_at,reason,created_at,finished_at)
    VALUES(?,?,'123456789',?,'telegram:channel:123456789','message_query_v1','completed',NULL,NULL,?,?)`, call_id, partner_id, query_job_id, created_at, created_at);
  const definition = { version: 1, campaign_id, campaign_revision: 1, candidate_id, query: 'supplier', window_days: 30, limit: 10 };
  const definition_json = JSON.stringify(definition), definition_hash = hash(definition_json);
  store.run(`INSERT INTO scout_message_queries(id,partner_id,campaign_id,candidate_id,grant_id,job_id,definition_json,definition_hash,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`, query_id, partner_id, campaign_id, candidate_id, grant_id, query_job_id, definition_json, definition_hash, created_at);
  const receipt_id = id(), content = { selection: { kind: 'message_query_v1', received_count: 1, returned_count: 1, omitted_count: 0, limit: 10, truncated: false, exhaustive: false }, messages: [{ message_id: '7', text: 'Looking for a supplier.' }] };
  const content_json = JSON.stringify(content);
  store.run(`INSERT INTO scout_query_receipts(id,query_request_id,attempt_call_id,source_cursor,content_json,content_hash,created_at)
    VALUES(?,?,?,0,?,?,?)`, receipt_id, query_id, call_id, content_json, hash(content_json), created_at);
  const profile_id = id(), profile_json = JSON.stringify({ label: 'Transfer-only profile', provider: 'custom', model: 'offline' });
  store.run(`INSERT INTO model_profiles(id,partner_id,definition_json,definition_hash,status,revoked_at,revocation_reason)
    VALUES(?,?,?,?,'available',NULL,NULL)`, profile_id, partner_id, profile_json, hash(profile_json));
  const proposals = [];
  for (const status of ['proposed', 'approved']) {
    const model_job_id = id(), model_request_id = id(), run_id = id(), proposal_id = id();
    store.run(`INSERT INTO scout_jobs(id,campaign_id,campaign_revision,grant_id,candidate_id,kind,status,cursor_json,sample_id,run_id,owner_id,attempts,next_at,reason,created_at,updated_at)
      VALUES(?,?,1,?,?,'assessment','completed','{}',NULL,?,NULL,1,?,NULL,?,?)`, model_job_id, campaign_id, grant_id, candidate_id, run_id, created_at, created_at, created_at);
    store.run(`INSERT INTO runs(id,partner_id,status,runtime,model,context_json,created_at) VALUES(?,?,'completed','query-transfer-test','offline','{}',?)`, run_id, partner_id, created_at);
    const request_json = JSON.stringify({ version: 2, receipt_id, receipt_digest: hash(content_json), model_profile_id: profile_id });
    store.run(`INSERT INTO scout_model_requests(id,partner_id,job_id,run_id,model_profile_id,definition_json,request_fingerprint,expires_at,status,revoked_at,revocation_reason)
      VALUES(?,?,?,?,?,?,?,?,'active',NULL,NULL)`, model_request_id, partner_id, model_job_id, run_id, profile_id, request_json, hash(request_json), expires_at);
    const output = { summary: 'Historical review material.', current_intent: 'unknown', offer_fit: 'unknown', contact_permission: false, unknowns: ['Intent'] };
    const output_json = JSON.stringify(output);
    store.run(`INSERT INTO scout_query_proposals(id,partner_id,campaign_id,campaign_revision,candidate_id,receipt_id,receipt_digest,model_request_id,
      request_fingerprint,run_id,output_json,output_digest,status,note,created_at)
      VALUES(?,?,?,1,?,?,?,?,?,?,?,?,?,NULL,?)`, proposal_id, partner_id, campaign_id, candidate_id, receipt_id, hash(content_json), model_request_id,
      hash(request_json), run_id, output_json, hash(output_json), status, created_at);
    proposals.push({ id: proposal_id, status });
  }
  return { campaign_id, query_id, receipt_id, proposal_ids: proposals };
}

test('schema-20 bundles retain their frozen catalogue and import into the current schema without query rows', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-query-transfer-v20-'));
  const store = new Store(directory);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const bundle = oldSchema20(exportPartner(store));
  assert.equal(bundle.migrations.length, 20);
  assert.equal(Object.hasOwn(bundle.tables, 'scout_message_queries'), false);
  const imported = importBundle(t, store, bundle, 'scout-query-transfer-v20');
  const target = new Store(path.join(imported.destination, 'data'));
  try {
    assert.equal(target.all('SELECT * FROM schema_migrations').length, 21, 'the new store applies its current migrations');
    assert.equal(target.get('SELECT COUNT(*) AS n FROM scout_message_queries').n, 0);
    assert.equal(target.get('SELECT COUNT(*) AS n FROM scout_query_receipts').n, 0);
    assert.equal(target.get('SELECT COUNT(*) AS n FROM scout_query_proposals').n, 0);
    assert.deepEqual(target.all('PRAGMA foreign_key_check'), []);
  } finally { target.close(); }
});

test('schema-21 export transfers query receipts as history and stales proposed or approved interpretations', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-query-transfer-v21-'));
  const store = new Store(directory);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const expected = addQueryHistory(store);
  const bundle = exportPartner(store);
  assert.equal(bundle.migrations.length, 21);
  assert.ok(bundle.tables.scout_message_queries.some(row => row.id === expected.query_id));
  assert.ok(bundle.tables.scout_query_receipts.some(row => row.id === expected.receipt_id));
  assert.deepEqual(bundle.tables.scout_query_proposals.map(row => row.status).sort(), ['approved', 'proposed']);
  const imported = importBundle(t, store, bundle, 'scout-query-transfer-v21');
  const target = new Store(path.join(imported.destination, 'data'));
  try {
    assert.equal(target.get('SELECT COUNT(*) AS n FROM scout_message_queries WHERE id=?', expected.query_id).n, 1);
    assert.equal(target.get('SELECT COUNT(*) AS n FROM scout_query_receipts WHERE id=?', expected.receipt_id).n, 1);
    const transferred = target.all('SELECT id,status FROM scout_query_proposals ORDER BY id');
    assert.deepEqual(transferred.map(row => row.status), ['stale', 'stale']);
    assert.deepEqual(new Set(transferred.map(row => row.id)), new Set(expected.proposal_ids.map(row => row.id)));
    assert.equal(target.get("SELECT COUNT(*) AS n FROM scout_grants WHERE status='active'").n, 0, 'query read authority is not transferred');
    assert.equal(target.get("SELECT COUNT(*) AS n FROM scout_model_requests WHERE status='active'").n, 0, 'model request authority is not transferred');
    assert.deepEqual(target.all('PRAGMA foreign_key_check'), []);
  } finally { target.close(); }
});

test('server serves the new Scout query view module as JavaScript', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-query-module-route-'));
  const config = structuredClone(readJson(path.join(ROOT, 'config/default.json')));
  config.server.port = 0; config.scheduler.enabled = false; config.telegram.enabled = false; config.telegram.liveSending = false;
  config.scout = { ...(config.scout ?? {}), enabled: false, modelEnabled: false };
  const app = await start({ config, directory });
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(`${origin}/scout-queries.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/javascript/);
  assert.match(await response.text(), /renderScoutQueries/);
});
