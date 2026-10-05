// Exercise the actual Node/Hermes transport envelope and staging transfer boundary.
// Child spawn is intercepted; all source/model/credential data is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { ROOT } from '../business/config.mjs';
import { Store, id, hash } from '../business/store.mjs';
import { exportPartner } from '../business/export.mjs';
import { BusinessService } from '../business/service.mjs';
import { HermesAdapter } from '../business/runtime.mjs';
import { processAudienceAssessment } from '../business/audience-reasoning.mjs';
import { audienceHarness, SOURCE, modelOutputFrom } from './audience-test-helpers.mjs';

const ENDPOINT = 'https://profile-transport-fixture.invalid/v1';
function setup(t) {
  const previous = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'offline-profile-transport-sentinel';
  t.after(() => previous === undefined ? delete process.env.PARTNER_MODEL_API_KEY : process.env.PARTNER_MODEL_API_KEY = previous);
  const h = audienceHarness(t);
  Object.assign(h.config.runtime, { model: '', baseUrl: '', enabled: false, dailyBudgetUsd: null });
  h.config.audience.modelEnabled = false;
  h.config.audience.maxRunsPerDay = 5;
  h.config.modelProfiles = { allowedBaseUrls: [ENDPOINT] };
  return h;
}
async function grant(t, h) {
  const opened = await h.open({ source_ids: [SOURCE] });
  await h.ingest({ message_id: 'boundary-question', text: 'How should I prepare for tomorrow?' });
  h.service.audience.reconcile({ limit: 10 });
  const profile = await h.command('model.profile_create', { label: 'Transport fixture', provider: 'custom',
    api_mode: 'chat_completions', base_url: ENDPOINT, model: 'chosen-profile-model', max_output_tokens: 777,
    input_usd_per_million: 2, output_usd_per_million: 3 });
  const goal = h.service.audience.detail(opened.goal_id);
  const option = goal.attention.profile_options.find(p => p.profile_id === profile.profile_id);
  const granted = await h.command('audience.attention_grant', { goal_id: goal.id, expected_revision: goal.revision,
    expected_scope_fingerprint: option.scope_fingerprint, model_profile_id: profile.profile_id, max_attempts: 2,
    expires_at: new Date(Date.now() + 3600000).toISOString(), reason: 'Synthetic exact boundary verification.' });
  return { profile, granted, goal };
}
const fakeRuntime = { decide: async (_run, context) => ({ completed: true,
  final_response: JSON.stringify(modelOutputFrom(context.packet)), usage: { input_tokens: 13, output_tokens: 8 } }) };

test('actual HermesAdapter dispatches the frozen scoped profile with no tools, token, or global retargeting', async t => {
  const h = setup(t), { profile } = await grant(t, h);
  const tokens = new Map(), adapter = new HermesAdapter(h.service, tokens);
  t.after(() => adapter.close());
  let envelope, childEnv, argv;
  const intercepted = t.mock.method(childProcess, 'spawn', (_python, args, options) => {
    argv = args; childEnv = options.env;
    const child = new EventEmitter();
    child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {}; child.kill = () => child.emit('close', 1);
    child.stdin.end = text => {
      envelope = JSON.parse(text);
      queueMicrotask(() => { child.stdout.emit('data', JSON.stringify({ completed: true,
        final_response: JSON.stringify(modelOutputFrom(envelope.context.packet)),
        usage: { input_tokens: 13, output_tokens: 8 }, model_identity: { model_id: 'chosen-profile-model', model_version: 'synthetic-v1' } }));
      child.emit('close', 0); });
    };
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { intercepted.mock.restore(); syncBuiltinESMExports(); });
  const result = await processAudienceAssessment(h.service, { decide: async (run, context) => {
    // Simulate hot global edits after admission. They cannot redirect this job.
    h.config.runtime.model = 'wrong-live-global-model';
    h.config.runtime.baseUrl = 'https://unselected-fixture.invalid/v1';
    h.config.runtime.maxOutputTokens = 8000;
    return adapter.decide(run, context);
  } });
  assert.equal(result.disposition, 'proposal_created');
  assert.equal(intercepted.mock.callCount(), 1);
  assert.match(argv[0], /scripts[/\\]situation_router_worker\.py$/);
  assert.equal(envelope.model.baseUrl, ENDPOINT);
  assert.equal(envelope.model.model, 'chosen-profile-model');
  assert.equal(envelope.model.provider, 'custom'); assert.equal(envelope.model.apiMode, 'chat_completions');
  assert.equal(envelope.model.maxOutputTokens, 777); assert.equal(envelope.model.maxIterations, 2);
  assert.deepEqual(envelope.tools, []); assert.equal(envelope.business_url, undefined);
  assert.equal(envelope.context.router_instructions, undefined);
  assert.equal(childEnv.PARTNER_RUN_TOKEN, undefined); assert.equal(childEnv.PARTNER_TELEGRAM_SESSION, undefined);
  assert.equal(childEnv.PARTNER_TELEGRAM_API_HASH, undefined); assert.equal(tokens.size, 0);
  assert.equal(h.config.audience.modelEnabled, false); assert.equal(h.config.runtime.enabled, false);
  const run = h.store.get('SELECT * FROM runs WHERE runtime=?', 'hermes-audience-v1');
  assert.equal(run.model, 'chosen-profile-model');
  assert.equal(JSON.parse(run.result_json).model_profile.id, profile.profile_id);
  assert.equal(run.cost_status, 'configured_estimate');
  assert.equal(run.estimated_cost_usd, (13 * 2 + 8 * 3) / 1e6);
  for (const table of ['persons','conversations','drafts','contact_permissions','delivery_attempts','audience_work_links','action_proposals'])
    assert.equal(h.store.get(`SELECT COUNT(*) n FROM ${table}`).n, 0, `${table} remains empty`);
});

function importBundle(t, h, bundle) {
  const file = path.join(h.directory, `bundle-${id()}.json`);
  fs.writeFileSync(file, JSON.stringify(bundle), { flag: 'wx' });
  const destination = path.join(ROOT, 'exports', `scoped-model-transfer-${id()}`);
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  const child = childProcess.spawnSync(process.execPath, ['scripts/import.mjs', file, destination],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  return new Store(path.join(destination, 'data'));
}
test('schema-16 transfer preserves model and attempt history but revokes all scoped authority', async t => {
  const h = setup(t), { profile, granted, goal } = await grant(t, h);
  assert.equal((await processAudienceAssessment(h.service, fakeRuntime)).disposition, 'proposal_created');
  const bundle = exportPartner(h.store);
  assert.equal(bundle.migrations.length, 16);
  assert.equal(bundle.tables.audience_attention_attempts.length, 1);
  assert.equal(bundle.tables.model_profiles[0].definition_hash, profile.definition_hash);
  const restored = importBundle(t, h, bundle);
  try {
    const service = new BusinessService(restored, h.config);
    assert.equal(service.modelProfiles.get(profile.profile_id).state, 'revoked');
    assert.throws(() => service.modelProfiles.resolve(profile.profile_id), { code: 'MODEL_PROFILE_REVOKED' });
    assert.equal(service.modelProfiles.resolve(profile.profile_id, { historical: true }).definition_hash, profile.definition_hash);
    assert.equal(restored.get('SELECT status FROM audience_attention_grants WHERE id=?', granted.grant_id).status, 'revoked');
    assert.equal(restored.get('SELECT COUNT(*) n FROM audience_attention_attempts').n, 1);
    assert.equal(service.attention.eligible(goal.id), null);
    assert.equal(service.attention.hasScopedGrant(), false);
    assert.deepEqual(restored.all('PRAGMA foreign_key_check'), []);
  } finally { restored.close(); }
});
test('actual historical schema-13 catalogue imports with no invented profile or model authority', async t => {
  const h = setup(t);
  await h.open({ source_ids: [SOURCE] });
  const bundle = exportPartner(h.store);
  bundle.migrations = bundle.migrations.slice(0, 13);
  delete bundle.tables.model_profiles;
  delete bundle.tables.audience_attention_models;
  delete bundle.tables.audience_followup_requests;
  delete bundle.tables.audience_followup_attempts;
  delete bundle.tables.audience_watch_epochs;
  bundle.tables_sha256 = hash(JSON.stringify(bundle.tables));
  const restored = importBundle(t, h, bundle);
  try {
    assert.equal(restored.get('SELECT COUNT(*) n FROM schema_migrations').n, 16);
    assert.equal(restored.get('SELECT COUNT(*) n FROM model_profiles').n, 0);
    assert.equal(restored.get('SELECT COUNT(*) n FROM audience_attention_models').n, 0);
    assert.equal(new BusinessService(restored, h.config).attention.hasScopedGrant(), false);
    assert.deepEqual(restored.all('PRAGMA foreign_key_check'), []);
  } finally { restored.close(); }
});
