// Black-box lifecycle coverage through the real localhost server and SQLite ledgers.
// Model completions are deterministic in-process adapters; no provider/network is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { start } from '../business/server.mjs';
import { ROOT, readJson } from '../business/config.mjs';
import { id } from '../business/store.mjs';
import { RuntimeActivation, workspaceIdentity } from '../business/deployment.mjs';
import { modelOutputFrom, SOURCE } from './audience-test-helpers.mjs';

const PROFILE_URL = 'https://deployment-runtime-fixture.invalid/v1';
const modelPayload = {
  label: 'isolated lifecycle profile', provider: 'custom', api_mode: 'chat_completions',
  base_url: PROFILE_URL, model: 'offline-lifecycle-model', max_output_tokens: 512,
  input_usd_per_million: null, output_usd_per_million: null,
};

function testConfig({ browserSources = [] } = {}) {
  const config = structuredClone(readJson(path.join(ROOT, 'config/default.json')));
  config.server.host = '127.0.0.1'; config.server.port = 0;
  config.scheduler.enabled = true; config.scheduler.tickSeconds = 3600;
  Object.assign(config.runtime, { enabled:false, provider:'custom', apiMode:'chat_completions', baseUrl:'', model:'',
    maxRunsPerDay:20, dailyBudgetUsd:null, inputUsdPerMillion:null, outputUsdPerMillion:null, timeoutSeconds:45 });
  config.telegram.enabled = false; config.telegram.liveSending = false; config.telegram.allowedChatIds = [];
  config.audience = { ...config.audience, enabled:true, modelEnabled:false, sources:[SOURCE], maxRunsPerDay:10 };
  config.continuity = { ...config.continuity, enabled:true, modelEnabled:false };
  config.opportunity.automatic = true; config.opportunity.allowedSourceRefs = [SOURCE];
  config.opportunity.telegramSources = []; config.opportunity.browserSources = browserSources;
  config.opportunity.allowedSourceRefs.push(...browserSources.map(source => source.sourceId));
  config.controlPlane = { ...config.controlPlane, enabled:true, maxConcurrent:3, reservationUsd:0.25 };
  config.modelProfiles = { allowedBaseUrls:[PROFILE_URL] };
  return config;
}

async function serverHarness(t, { mode = 'read_only', expiresAt = new Date(Date.now() + 60 * 60_000).toISOString(),
  browserSources = [], schedulerTickSeconds = 3600 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-deployment-runtime-'));
  const config = testConfig({ browserSources });
  config.scheduler.tickSeconds = schedulerTickSeconds;
  const activation = new RuntimeActivation({ id:randomUUID(), label:'Synthetic lifecycle test', mode, expires_at:expiresAt });
  const deployment = { activation };
  const app = await start({ config, directory, deployment });
  t.after(async () => {
    // close() can have started a drain from the activation-expiry timer after server.listening
    // becomes false. Always await the same close promise before removing the real SQLite store.
    try { await app.close(); }
    catch (error) { if (app.server.listening) throw error; }
    finally { fs.rmSync(directory, { recursive:true, force:true }); }
  });
  return { app, config, directory, activation, deployment };
}

async function apiFor(app) {
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const sessionResponse = await fetch(`${origin}/api/session`);
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  const headers = { 'x-partner-token':session.token, 'content-type':'application/json' };
  return {
    origin,
    headers,
    get:route => fetch(`${origin}${route}`, { headers }),
    post:(route,body) => fetch(`${origin}${route}`, { method:'POST', headers, body:JSON.stringify(body) }),
  };
}

async function readyGoal(service, label = 'activation') {
  const opened = await service.command('audience.open', {
    title:`${label} goal`, objective:'Understand one explicit public setup question.', source_ids:[SOURCE], max_age_seconds:3600,
  }, id());
  const at = new Date().toISOString();
  await service.command('source.ingest', { source_id:SOURCE, source_kind:'sanitized_fixture',
    message_id:`${label}-${randomUUID()}`, author_id:`author:${label}`, display_name:null, thread_id:`thread:${label}`,
    reply_to_id:null, version:1, operation:'upsert', text:'How can I get started with the first setup step?',
    created_at:at, updated_at:at }, id(), { kind:'channel', sourceId:SOURCE });
  service.audience.reconcile({ limit:10, event_limit:50 });
  const goal = service.audience.detail(opened.goal_id);
  assert.equal(goal.ready, true, 'fixture evidence is current and the goal is ready');
  return goal;
}

async function createProfileAndGrant(service, goal, { expiresAt = new Date(Date.now() + 60 * 60_000).toISOString(), maxAttempts = 1 } = {}) {
  const profile = await service.command('model.profile_create', modelPayload, id());
  const scope = service.attention.scope(goal.id, profile.profile_id);
  assert.ok(scope.fingerprint, 'profile and current source produce a finite grant scope');
  const grant = await service.command('audience.attention_grant', {
    goal_id:goal.id, expected_revision:goal.revision, expected_scope_fingerprint:scope.fingerprint,
    model_profile_id:profile.profile_id, max_attempts:maxAttempts, expires_at:expiresAt,
    reason:'One isolated lifecycle acceptance attempt.',
  }, id());
  assert.equal(service.attention.eligible(goal.id, { dispatch:true })?.id, grant.grant_id);
  return { profile, grant };
}

function counts(service, grantId) {
  return {
    runs:service.store.get('SELECT COUNT(*) n FROM runs WHERE partner_id=?', service.config.partnerId).n,
    attempts:service.store.get('SELECT COUNT(*) n FROM audience_attention_attempts WHERE grant_id=?', grantId).n,
  };
}

const waitFor = async (predicate, message, timeoutMs = 4000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), message);
};
async function freeLoopbackPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

test('managed activation API and identity source are available for lifecycle verification', async () => {
  const identity = workspaceIdentity();
  assert.equal(typeof identity.code_root, 'string');
  assert.ok(identity.code_sha === null || /^[a-f0-9]{40}$/.test(identity.code_sha));
  assert.equal(typeof identity.dirty, 'boolean');
  assert.equal(typeof identity.verified, 'boolean');
  assert.equal(typeof RuntimeActivation, 'function');
});

test('server health, authenticated state, and private receipt report one actual instance identity', async t => {
  const sentinel = 'activation-runtime-secret-sentinel';
  const previousKey = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = sentinel;
  t.after(() => previousKey === undefined ? delete process.env.PARTNER_MODEL_API_KEY : process.env.PARTNER_MODEL_API_KEY = previousKey);
  const { app, directory, activation } = await serverHarness(t);
  const { origin, get } = await apiFor(app);
  const [healthResponse, stateResponse] = await Promise.all([fetch(`${origin}/health`), get('/api/state')]);
  assert.equal(healthResponse.status, 200);
  assert.equal(stateResponse.status, 200);
  const health = await healthResponse.json(), state = await stateResponse.json();
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'runtime', 'service.json'), 'utf8'));
  const release = state.release;
  const healthRelease = health.release ?? health.identity;
  assert.ok(release && healthRelease, 'health and authenticated state expose release identity');
  for (const key of ['instance_id','pid','port','code_root','code_sha','dirty','verified','mode','deployment_id']) {
    assert.equal(typeof release[key] === 'undefined' && key === 'deployment_id' ? null : release[key],
      typeof receipt[key] === 'undefined' && key === 'deployment_id' ? null : receipt[key], `state receipt ${key}`);
    assert.equal(typeof healthRelease[key] === 'undefined' && key === 'deployment_id' ? null : healthRelease[key],
      typeof receipt[key] === 'undefined' && key === 'deployment_id' ? null : receipt[key], `health receipt ${key}`);
  }
  assert.equal(release.pid, process.pid);
  assert.equal(release.port, app.server.address().port);
  assert.equal(release.deployment_id, activation.id);
  assert.equal(state.activation.id, activation.id);
  assert.equal(state.activation.mode, 'read_only');
  assert.equal(release.verified, workspaceIdentity().verified,
    'a dirty/unmanaged test start reports the real workspace verification state');
  assert.doesNotMatch(JSON.stringify({ health, state, receipt }), new RegExp(sentinel));
});

test('read-only activation vetoes an old current finite grant before a run or attempt is admitted', async t => {
  const { app } = await serverHarness(t, { mode:'read_only' });
  const goal = await readyGoal(app.service, 'readonly');
  const { grant } = await createProfileAndGrant(app.service, goal);
  let providerInvocations = 0;
  app.scheduler.runtime.decide = async () => { providerInvocations++; throw new Error('read-only activation reached model runtime'); };
  await app.scheduler.sourceTick();
  const result = await app.scheduler.audienceReasonTick();
  assert.equal(result, undefined);
  assert.equal(app.scheduler.audienceState.disposition, 'CONTROL_ACTIVATION_MODELS_OFF');
  assert.deepEqual(counts(app.service, grant.grant_id), { runs:0, attempts:0 });
  assert.equal(providerInvocations, 0, 'no model runtime/provider call is made');
  assert.equal(app.service.attention.eligible(goal.id)?.id, grant.grant_id, 'activation denial does not revoke owner grant');
});

test('scoped activation alone makes no call; an explicit fresh grant remains blocked without credentials', async t => {
  const { app, activation } = await serverHarness(t, { mode:'scoped_reasoning' });
  const goal = await readyGoal(app.service, 'scoped');
  const profile = await app.service.command('model.profile_create', modelPayload, id());
  let providerInvocations = 0;
  app.scheduler.runtime.decide = async () => { providerInvocations++; throw new Error('credentials are intentionally absent'); };
  await app.scheduler.sourceTick();
  await app.scheduler.audienceReasonTick();
  assert.equal(app.scheduler.audienceState.disposition, 'disabled', 'profile/capability is not a grant');
  assert.deepEqual(counts(app.service, 'no-grant'), { runs:0, attempts:0 });

  const scope = app.service.attention.scope(goal.id, profile.profile_id);
  const grant = await app.service.command('audience.attention_grant', {
    goal_id:goal.id, expected_revision:goal.revision, expected_scope_fingerprint:scope.fingerprint,
    model_profile_id:profile.profile_id, max_attempts:1,
    expires_at:new Date(Date.now() + 60 * 60_000).toISOString(),
    reason:'One isolated lifecycle acceptance attempt.',
  }, id());
  const attention = app.service.attention.summary(goal.id);
  assert.equal(attention.source_current, true);
  assert.equal(attention.active_grant_id, grant.grant_id);
  assert.ok(attention.profile_options.find(row => row.profile_id === profile.profile_id).block_reasons.includes('MODEL_PROFILE_CREDENTIAL_NOT_READY'));
  await app.scheduler.audienceReasonTick();
  assert.equal(app.scheduler.audienceState.disposition, 'waiting_model');
  assert.deepEqual(counts(app.service, grant.grant_id), { runs:0, attempts:0 });
  assert.equal(providerInvocations, 0, 'scoped capability and grant do not cause calls without runtime credentials');
  assert.equal(activation.assertModelAllowed(), true, 'the scoped activation opens capability, not model authority');
});

test('a healthy scoped grant can complete through the live scheduler path and persist a valid no-need decision', async t => {
  const { app } = await serverHarness(t, { mode:'scoped_reasoning' });
  const goal = await readyGoal(app.service, 'positive');
  const { grant } = await createProfileAndGrant(app.service, goal, { maxAttempts:1 });
  const previousKey = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'offline-only-positive-control-key';
  t.after(() => previousKey === undefined ? delete process.env.PARTNER_MODEL_API_KEY : process.env.PARTNER_MODEL_API_KEY = previousKey);
  let calls = 0;
  app.scheduler.runtime.decide = async (_run, context) => {
    calls++;
    return { completed:true, final_response:JSON.stringify(modelOutputFrom(context.packet, { needs:[] })),
      usage:{input_tokens:29,output_tokens:13}, api_calls:1,
      model_identity:{provider:'custom',model:'offline-lifecycle-model',model_version:'local-test'} };
  };
  await app.scheduler.sourceTick();
  await app.scheduler.reasonTick();
  assert.equal(calls, 1, 'a current finite grant and scoped activation admit exactly one local completion');
  assert.equal(app.scheduler.audienceState.disposition, 'no_need_proposed');
  const run = app.service.store.get('SELECT * FROM runs WHERE runtime=? ORDER BY created_at DESC LIMIT 1', 'hermes-audience-v1');
  const assessmentId = JSON.parse(run.context_json).assessment_id;
  const assessment = app.service.audience.assessment(assessmentId);
  assert.equal(assessment.status, 'proposed');
  assert.equal(assessment.current, true);
  assert.equal(assessment.decision_review.state, 'current');
  assert.equal(assessment.decision_review.review.disposition, 'no_need_proposed');
  assert.equal(app.service.store.get('SELECT COUNT(*) n FROM audience_needs WHERE goal_id=?', goal.id).n, 0);
  assert.equal(app.service.store.get('SELECT COUNT(*) n FROM audience_attention_attempts WHERE grant_id=?', grant.grant_id).n, 1,
    'the successful result remains bound to exactly one consumed attempt');
  assert.equal(run.status, 'completed');
  assert.equal(run.input_tokens, 29); assert.equal(run.output_tokens, 13);
  assert.equal(run.cost_status, 'unknown');
  assert.equal(JSON.parse(run.result_json).model_api_calls, 1);
});

test('expiry withholds a late admitted completion, preserves usage and consumes rather than refunds its attempt', async t => {
  const { app, directory, activation } = await serverHarness(t, {
    mode:'scoped_reasoning', expiresAt:new Date(Date.now() + 3000).toISOString(),
  });
  const goal = await readyGoal(app.service, 'expiry');
  const { grant } = await createProfileAndGrant(app.service, goal, { maxAttempts:1 });
  const previousKey = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'offline-only-activation-test-key';
  t.after(() => previousKey === undefined ? delete process.env.PARTNER_MODEL_API_KEY : process.env.PARTNER_MODEL_API_KEY = previousKey);
  let releaseResult, providerInvocations = 0, observedRun = null;
  app.scheduler.runtime.decide = (run, context) => {
    providerInvocations++; observedRun = { run:structuredClone(run), context:structuredClone(context) };
    return new Promise(resolve => { releaseResult = resolve; });
  };
  await app.scheduler.sourceTick();
  const turn = app.scheduler.reasonTick();
  await waitFor(() => providerInvocations === 1 && typeof releaseResult === 'function', 'finite grant did not admit exactly one offline completion');
  assert.equal(counts(app.service, grant.grant_id).attempts, 1);
  assert.equal(counts(app.service, grant.grant_id).runs, 1);
  await waitFor(() => Date.now() >= Date.parse(activation.expiresAt), 'activation did not reach its frozen deadline');
  assert.throws(() => activation.assertModelAllowed(), error =>
    ['CONTROL_ACTIVATION_EXPIRED','CONTROL_ACTIVATION_STOPPED'].includes(error.code));

  const output = modelOutputFrom(observedRun.context.packet, { needs:[] });
  releaseResult({ completed:true, final_response:JSON.stringify(output), usage:{input_tokens:41,output_tokens:17},
    api_calls:1, model_identity:{provider:'custom',model:'offline-lifecycle-model',model_version:'local-test'} });
  await turn;
  assert.equal(providerInvocations, 1);

  // The expiry hook drains the scheduler before closing SQLite. Re-open read-only so the
  // assertion also holds when managed shutdown has already closed the in-process Store.
  const db = new DatabaseSync(path.join(directory, 'partner.sqlite'), { readOnly:true });
  try {
    const run = db.prepare('SELECT status,result_json,input_tokens,output_tokens,estimated_cost_usd,cost_status FROM runs WHERE id=?').get(observedRun.run.id);
    const assessment = db.prepare('SELECT status,output_json FROM audience_assessments WHERE id=?').get(JSON.parse(observedRun.run.context_json).assessment_id);
    const attempts = db.prepare('SELECT COUNT(*) n FROM audience_attention_attempts WHERE grant_id=?').get(grant.grant_id).n;
    assert.equal(run.status, 'failed');
    assert.equal(run.input_tokens, 41);
    assert.equal(run.output_tokens, 17);
    assert.equal(run.estimated_cost_usd, null);
    assert.equal(run.cost_status, 'unknown');
    assert.equal(JSON.parse(run.result_json).model_api_calls, 1);
    assert.equal(assessment.status, 'interrupted');
    assert.equal(assessment.output_json, null);
    assert.equal(attempts, 1, 'restart/expiry cannot refund the admitted attempt');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM audience_needs WHERE goal_id=?').get(goal.id).n, 0,
      'late output is withheld from proposal/history');
  } finally { db.close(); }
});

test('expired activation is refused before its data directory or SQLite store is created', async () => {
  const directory = path.join(os.tmpdir(), `harnes2-expired-activation-${randomUUID()}`);
  const activation = new RuntimeActivation({ id:randomUUID(), label:'Already expired', mode:'scoped_reasoning',
    expires_at:new Date(Date.now() - 1000).toISOString() });
  await assert.rejects(start({ config:testConfig(), directory, deployment:{activation} }), error =>
    error.code === 'CONTROL_ACTIVATION_EXPIRED');
  assert.equal(fs.existsSync(directory), false, 'expired authority is refused before persistent state is opened');
});

test('duplicate start refuses the live activation before it can touch the owned store', async t => {
  const { app, config, directory, deployment, activation } = await serverHarness(t, { mode:'scoped_reasoning' });
  const beforeReceipt = JSON.parse(fs.readFileSync(path.join(directory, 'runtime', 'service.json'), 'utf8'));
  const before = counts(app.service, 'no-grant');
  // A different activation cannot take over the same active store either. Using a second ID
  // exercises the owner check without relaxing the current-code identity check on the first ID.
  const duplicateDeployment = { activation:new RuntimeActivation({ id:randomUUID(), label:'Duplicate owner',
    mode:'scoped_reasoning', expires_at:new Date(Date.now() + 60 * 60_000).toISOString() }) };
  await assert.rejects(start({ config, directory, deployment:duplicateDeployment }), error =>
    error.code === 'DEPLOYMENT_PROCESS_ALREADY_OWNED');
  assert.equal(app.server.listening, true, 'rejected duplicate does not disturb the real owner');
  assert.deepEqual(counts(app.service, 'no-grant'), before, 'duplicate launch creates no run or attempt');
  const afterReceipt = JSON.parse(fs.readFileSync(path.join(directory, 'runtime', 'service.json'), 'utf8'));
  assert.deepEqual(afterReceipt, beforeReceipt, 'duplicate launch leaves the owner receipt byte-semantically unchanged');
  assert.equal(activation.summary().phase, 'active');
});

test('a stopped activation leaves an exact durable tombstone and cannot be rearmed by restarting the same id', async t => {
  const { app, config, directory, deployment, activation } = await serverHarness(t, { mode:'scoped_reasoning' });
  const before = counts(app.service, 'no-grant');
  const closePromise = app.close();
  assert.strictEqual(app.close(), closePromise, 'concurrent shutdown callers await the same drain');
  await closePromise;
  const markerFile = path.join(directory, 'runtime', `activation-${activation.id}.json`);
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  assert.deepEqual(Object.keys(marker).sort(), ['code_sha','expires_at','id','instance_id','phase','pid','profile_fingerprint','stop_reason','version']);
  assert.equal(marker.version, 1);
  assert.match(marker.profile_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(marker.profile_fingerprint, activation.summary().profile_fingerprint);
  assert.equal(marker.phase, 'stopped');
  assert.equal(marker.stop_reason, 'operator_stop');
  await assert.rejects(start({ config, directory, deployment }), error =>
    error.code === 'CONTROL_ACTIVATION_STOPPED');
  const db = new DatabaseSync(path.join(directory, 'partner.sqlite'), { readOnly:true });
  try {
    assert.deepEqual({ runs:db.prepare('SELECT COUNT(*) n FROM runs').get().n,
      attempts:db.prepare('SELECT COUNT(*) n FROM audience_attention_attempts').get().n }, before,
    'stopped activation restart neither recovers nor resets durable accounting');
  } finally { db.close(); }
});

test('activation-marker write failure closes model admission before shutdown can be retried', async t => {
  const { app, directory, activation } = await serverHarness(t, { mode:'scoped_reasoning' });
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = function(file, ...args) {
    if (path.basename(String(file)).startsWith(`activation-${activation.id}.json.`)) {
      const error = new Error('synthetic activation-marker persistence failure');
      error.code = 'EIO'; throw error;
    }
    return originalWrite.call(this, file, ...args);
  };
  try {
    assert.throws(() => app.close(), error => error.code === 'EIO');
  } finally { fs.writeFileSync = originalWrite; }
  assert.equal(app.server.listening, true, 'failed marker write is surfaced and does not fake a completed shutdown');
  assert.throws(() => activation.assertModelAllowed(), error => error.code === 'CONTROL_ACTIVATION_STOPPED');
  assert.equal(app.service.control.canApply('synthetic-run-id'), false,
    'a persistence failure cannot leave scoped model application authorized');
  await app.close();
  const marker = JSON.parse(fs.readFileSync(path.join(directory, 'runtime', `activation-${activation.id}.json`), 'utf8'));
  assert.equal(marker.phase, 'stopped');
});

test('HTTP stop marker-write failure is contained and the same authenticated instance can retry to a durable stop', async t => {
  const { app, config, directory, deployment, activation } = await serverHarness(t, { mode:'scoped_reasoning' });
  const { get, post } = await apiFor(app);
  const originalWrite = fs.writeFileSync;
  let markerWriteFailures = 0;
  fs.writeFileSync = function(file, ...args) {
    if (path.basename(String(file)).startsWith(`activation-${activation.id}.json.`) && markerWriteFailures === 0) {
      markerWriteFailures++;
      const error = new Error('one-shot private marker failure'); error.code = 'EIO'; throw error;
    }
    return originalWrite.call(this, file, ...args);
  };
  try {
    const first = await post('/api/runtime/stop', { instance_id:app.release.instance_id });
    assert.equal(first.status, 202, 'the endpoint reports asynchronous stop acceptance, not completed stop');
    await waitFor(() => markerWriteFailures === 1 && app.server.listening && app.scheduler.stopped,
      'the injected marker failure did not leave a retryable stopping instance');
    const healthResponse = await get('/health');
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.status, 'stopping');
    const sessionResponse = await get('/api/session');
    assert.equal(sessionResponse.status, 200, 'the same instance remains able to authenticate stop retry');
    assert.equal((await get('/api/state')).status, 503, 'ordinary state routes stay closed while stopping');
    assert.throws(() => activation.assertModelAllowed(), error => error.code === 'CONTROL_ACTIVATION_STOPPED');
    assert.equal(app.service.control.canApply('synthetic-run-id'), false);
  } finally { fs.writeFileSync = originalWrite; }

  const retry = await post('/api/runtime/stop', { instance_id:app.release.instance_id });
  assert.equal(retry.status, 202);
  await app.close();
  assert.equal(markerWriteFailures, 1);
  const marker = JSON.parse(fs.readFileSync(path.join(directory, 'runtime', `activation-${activation.id}.json`), 'utf8'));
  assert.equal(marker.phase, 'stopped', 'retry durably records the stop for the same activation identity');
  await assert.rejects(start({ config, directory, deployment }), error => error.code === 'CONTROL_ACTIVATION_STOPPED');
});

test('final stopped-receipt failure is reported while listener, owner, and SQLite handle are still closed', async t => {
  const { app, directory } = await serverHarness(t, { mode:'scoped_reasoning' });
  const originalWrite = fs.writeFileSync;
  let serviceReceiptWrites = 0;
  fs.writeFileSync = function(file, ...args) {
    if (path.basename(String(file)).startsWith('service.json.')) {
      serviceReceiptWrites++;
      if (serviceReceiptWrites === 2) {
        const error = new Error('synthetic final stopped-receipt failure'); error.code = 'EIO'; throw error;
      }
    }
    return originalWrite.call(this, file, ...args);
  };
  try {
    await assert.rejects(app.close(), error => error.code === 'EIO');
  } finally { fs.writeFileSync = originalWrite; }
  assert.equal(serviceReceiptWrites, 2, 'the injected fault occurred during final stopped receipt persistence');
  assert.equal(app.server.listening, false);
  assert.throws(() => app.store.get('SELECT COUNT(*) n FROM control_owners'),
    'the SQLite handle is closed even though close reports receipt persistence failure');
  const db = new DatabaseSync(path.join(directory, 'partner.sqlite'), { readOnly:true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM control_owners').get().n, 0,
      'the process owner lease is released when final receipt persistence fails');
    const marker = db.prepare('SELECT 1').get();
    assert.ok(marker, 'the durable store remains reopenable');
  } finally { db.close(); }
});

test('source loop does not admit a second reader after activation expiry and drains the admitted read', async t => {
  const browserSources = ['browser-a','browser-b'].map((sourceId, index) => ({ sourceId,
    sourceKind:'live_snapshot', processingBasis:'Synthetic local lifecycle read.',
    url:`https://example${index ? '.org' : '.com'}/public`, pollEverySeconds:1, maxLagSeconds:5 }));
  const { app, directory, activation } = await serverHarness(t, { mode:'read_only',
    expiresAt:new Date(Date.now() + 1800).toISOString(), browserSources, schedulerTickSeconds:1 });
  let releaseRead, readerMethodChecks = 0, firstReaderCalls = 0;
  const [first, second] = app.scheduler.sourceReaders;
  assert.equal(first.sourceId, 'browser-a');
  for (const reader of [first, second]) {
    const target = reader.transport;
    reader.transport = new Proxy(target, { get(object, property) {
      if (property === 'readPage') {
        readerMethodChecks++;
        return async () => {
          if (reader.sourceId === 'browser-a') {
            firstReaderCalls++;
            return new Promise(resolve => { releaseRead = () => resolve({ text:'A bounded synthetic page.',
              truncated:false, originalLength:24, finalUrl:'https://example.com/public', status:200 }); });
          }
          throw new Error('second reader was admitted after expiry');
        };
      }
      const value = Reflect.get(object, property, object);
      return typeof value === 'function' ? value.bind(object) : value;
    } });
  }
  const pass = app.scheduler.sourceTick();
  await waitFor(() => firstReaderCalls === 1 && typeof releaseRead === 'function', 'first browser read was not admitted');
  await waitFor(() => Date.now() >= Date.parse(activation.expiresAt) && !app.server.listening,
    'expiry did not begin closing the service');
  assert.equal(app.scheduler.busy, true, 'the admitted source pass remains busy during expiry drain');
  assert.equal(app.store.get('SELECT COUNT(*) n FROM control_owners').n, 1,
    'the store and process-owner receipt remain open until the admitted read settles');
  releaseRead();
  await pass;
  await app.close();
  assert.equal(firstReaderCalls, 1);
  assert.equal(readerMethodChecks, 2,
    'only the first reader entered pollBrowserSource; the stopped loop did not inspect/admit the second');
  const db = new DatabaseSync(path.join(directory, 'partner.sqlite'), { readOnly:true });
  try {
    const event = db.prepare("SELECT COUNT(*) n FROM events WHERE kind='source.browser.poll.failed'").get().n;
    assert.equal(event, 1, 'the already-admitted read leaves one durable recoverable poll outcome');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE kind='source.message' AND json_extract(payload_json,'$.source_id')='browser-a'").get().n, 0,
      'an observation returning after shutdown began is not committed as current evidence');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE kind='source.message' AND json_extract(payload_json,'$.source_id')='browser-b'").get().n, 0);
  } finally { db.close(); }
});

test('private startup-receipt failure releases the port and process owner before any scheduled source effect', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-startup-receipt-failure-'));
  const config = testConfig();
  config.server.port = await freeLoopbackPort();
  const activation = new RuntimeActivation({ id:randomUUID(), label:'Receipt failure fixture', mode:'read_only',
    expires_at:new Date(Date.now() + 60 * 60_000).toISOString() });
  const port = config.server.port;
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = function(file, ...args) {
    if (path.basename(String(file)).startsWith('service.json.')) {
      const error = new Error('synthetic private service receipt failure'); error.code = 'EIO'; throw error;
    }
    return originalWrite.call(this, file, ...args);
  };
  try {
    await assert.rejects(start({ config, directory, deployment:{activation} }), error => error.code === 'EIO');
  } finally { fs.writeFileSync = originalWrite; }
  const socketOpen = await new Promise(resolve => {
    const socket = net.createConnection({ host:'127.0.0.1', port });
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 500);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', () => { clearTimeout(timer); resolve(false); });
  });
  assert.equal(socketOpen, false, 'failed identity receipt leaves no live listener behind');
  const db = new DatabaseSync(path.join(directory, 'partner.sqlite'), { readOnly:true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM control_owners').get().n, 0, 'failed startup releases the process lease');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM runs').get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE kind='source.message'").get().n, 0,
      'scheduler never begins polling sources when its private startup receipt cannot be written');
  } finally { db.close(); fs.rmSync(directory, { recursive:true, force:true }); }
});
