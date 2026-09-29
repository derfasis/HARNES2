// Offline acceptance: real commands, SQLite and local capabilities. No model/network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, readJson } from '../business/config.mjs';
import { Store, id } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { ActionRuntime } from '../business/action-runtime.mjs';
import { LocalActionCapabilities } from '../business/action-capabilities.mjs';
import { processActionPlan } from '../business/action-reasoning.mjs';
import { Scheduler } from '../business/scheduler.mjs';
import { contextFor } from '../business/context.mjs';
import { exportPartner } from '../business/export.mjs';
import { hash } from '../business/store.mjs';
import { ACTION_TABLES } from '../business/action-tables.mjs';
import { spawnSync } from 'node:child_process';
import { start } from '../business/server.mjs';

const SOURCE = 'public:action-fixture';
export function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-actions-'));
  const config = readJson(path.join(ROOT, 'config/default.json'));
  config.continuity = { enabled: true, modelEnabled: false };
  config.actions = { enabled: true, modelEnabled: false, maxModelRunsPerDay: 5 };
  Object.assign(config.opportunity, { automatic: true, allowedSourceRefs: [SOURCE],
    activeOffer: readJson(path.join(ROOT, 'benchmarks/opportunity-projection-v0/case-01.json')).active_offer });
  let store = new Store(directory), service = new BusinessService(store, config), runtime = new ActionRuntime(service);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const h = { directory, config, get store() { return store; }, get service() { return service; }, get runtime() { return runtime; },
    command(a, p, request = id(), actor = { kind: 'operator' }) { return service.command(a, p, request, actor); },
    ingest(extra = {}) { return this.command('source.ingest', { source_id: SOURCE, source_kind: 'sanitized_fixture',
      message_id: 'm1', author_id: 'a1', display_name: null, thread_id: null, reply_to_id: null, version: 1,
      operation: 'upsert', text: 'Two hours weekly.', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...extra }, id(), { kind: 'channel', sourceId: SOURCE }); },
    detail(a) { return service.actions.detail(a); },
    sweep() { service.continuity.reconcile(); service.executive.reconcile(); service.actions.reconcile(); },
    restart() { store.close(); store = new Store(directory); store.recover(); service = new BusinessService(store, config); runtime = new ActionRuntime(service); },
    async accepted() {
      const { thread_id } = await this.command('continuity.open', { title: 'Time', objective: 'Understand time required',
        success_condition: 'Cite requirements', source_ids: [SOURCE], max_age_seconds: 3600 });
      await this.ingest(); this.sweep(); const d = service.continuity.detail(thread_id);
      const { turn_id } = await this.command('continuity.capture', { thread_id, expected_revision: d.revision, expected_basis_fingerprint: d.basis_fingerprint });
      const turn = service.continuity.turn(turn_id), e = turn.packet.evidence[0];
      await this.command('continuity.propose', { turn_id, output: { summary: { text: 'Two hours stated.', evidence_event_ids: [e.source_event_id] },
        claims: [{ source_event_id: e.source_event_id, quote: e.text }], hypotheses: [], unknowns: ['Unverified statement.'],
        next: { kind: 'observe', reason: 'Watch corrections', wake_at: null, owner_question: null } } });
      await this.command('continuity.review', { turn_id, expected_basis_fingerprint: turn.basis_fingerprint, decision: 'accept', note: 'Fixture reviewed' });
      return thread_id;
    },
    async propose(thread_id, capability = 'brief.publish_local.v1') {
      return (await this.command('action.propose', { thread_id, expected_basis_fingerprint: service.continuity.detail(thread_id).basis_fingerprint,
        reason: 'Owner wants the scoped result', proposal: { capability_id: capability, title: 'Time briefing', instructions: 'Review remaining uncertainty',
          expected_result: 'Local evidence package for owner', due_at: null } })).action_id;
    },
    grant(action_id, command = 'action.grant') { const d = this.detail(action_id); return this.command(command, { action_id,
      expected_revision: d.revision, proposal_hash: d.proposal_hash, expires_at: new Date(Date.now() + 3600000).toISOString() }); },
  }; return h;
}
const noOutbound = h => {
  for (const table of ['persons','conversations','contact_permissions','messages','drafts','approvals','delivery_attempts','facts','outcome_events'])
    assert.equal(h.store.get(`SELECT COUNT(*) n FROM ${table}`).n, 0, table);
};
test('proposal needs an exact owner grant; receipt and independent verification are separate', async t => {
  const h = harness(t), a = await h.propose(await h.accepted());
  await h.runtime.tick(); assert.equal(h.detail(a).attempts.length, 0);
  await h.grant(a); await h.runtime.tick();
  // The receipt is carried into the failure message on purpose. A publication that fails on a
  // platform we do not develop on is exactly the case this suite exists to catch, and an
  // assertion that only says 'verifying !== unknown' tells whoever reads the log nothing about
  // which step failed. `failure_stage` and `failure_class` are the whole point of that field.
  assert.equal(h.detail(a).status, 'verifying',
    `publication did not complete: ${JSON.stringify(h.detail(a).attempts[0]?.receipt ?? null)}`);
  assert.equal(h.detail(a).attempts[0].verification_state, 'unchecked');
  await h.runtime.tick(); assert.equal(h.detail(a).status, 'completed');
  assert.equal(h.detail(a).attempts[0].verification_state, 'present');
  const artifact = JSON.parse(fs.readFileSync(path.join(h.directory, 'action-artifacts', `${a}.json`), 'utf8'));
  assert.equal(artifact.packet.epistemic_status, 'unverified_interpretation');
  assert.equal(artifact.packet.evidence.length, 1); noOutbound(h);
});
for (const change of ['edit','delete','revoke','expiry','disable']) test(`${change} prevents dispatch, including restart`, async t => {
  const h = harness(t), a = await h.propose(await h.accepted()); await h.grant(a);
  if (change === 'edit' || change === 'delete') await h.ingest({ version: 2, operation: change === 'delete' ? 'delete' : 'upsert', text: change === 'delete' ? null : 'Changed', updated_at: '2026-01-01T00:01:00Z' });
  if (change === 'revoke') await h.command('action.revoke', { action_id: a, expected_revision: h.detail(a).revision, reason: 'Stop' });
  if (change === 'expiry') h.store.run('UPDATE action_grants SET expires_at=?', '2000-01-01T00:00:00.000Z');
  if (change === 'disable') h.config.actions.enabled = false;
  h.restart(); h.sweep(); await h.runtime.tick();
  assert.equal(fs.existsSync(path.join(h.directory, 'action-artifacts', `${a}.json`)), false); noOutbound(h);
});
test('handoff is human-only; acknowledgement and reported outcome do not assert business success', async t => {
  const h = harness(t), a = await h.propose(await h.accepted(), 'owner_handoff.create.v1');
  await h.grant(a); await h.runtime.tick(); await h.runtime.tick();
  let d = h.detail(a); assert.equal(d.status, 'completed'); assert.equal(d.human_task.kind, 'owner_action');
  for (const op of ['task.approve','task.retry','task.cancel']) await assert.rejects(h.command(op, { task_id: d.human_task.id }));
  await h.command('action.handoff_acknowledge', { action_id: a, expected_revision: d.revision, note: 'I will handle it' });
  d = h.detail(a); assert.equal(d.human_task.status, 'pending');
  await h.command('action.handoff_resolve', { action_id: a, expected_revision: d.revision, outcome: 'done', note: 'Owner report only' });
  assert.equal(h.detail(a).human_task.status, 'done'); noOutbound(h);
});

test('wrong actor, foreign partner, altered payload, revision and unregistered capability are refused', async t => {
  const h = harness(t), thread = await h.accepted(), a = await h.propose(thread), d = h.detail(a);
  const grant = { action_id: a, expected_revision: d.revision, proposal_hash: d.proposal_hash, expires_at: new Date(Date.now() + 60000).toISOString() };
  for (const actor of ['agent','channel','system']) await assert.rejects(h.command('action.grant', grant, id(), { kind: actor }), { status: 403 });
  for (const change of [{ expected_revision: 0 }, { proposal_hash: 'forged' }, { target: '/tmp/anything' }, { expires_at: '2000-01-01T00:00:00Z' }])
    await assert.rejects(h.command('action.grant', { ...grant, ...change }));
  const foreign = new BusinessService(h.store, { ...h.config, partnerId: 'other' });
  assert.throws(() => foreign.actions.detail(a), { status: 404 });
  await assert.rejects(h.propose(thread, 'telegram.send'));
  assert.equal(h.detail(a).grants.length, 0); noOutbound(h);
});

test('duplicate requests, semantic duplicates, and concurrent workers produce one effect', async t => {
  const h = harness(t), thread = await h.accepted(), a = await h.propose(thread);
  assert.equal(await h.propose(thread), a);
  const d = h.detail(a), request = id(), p = { action_id: a, expected_revision: d.revision,
    proposal_hash: d.proposal_hash, expires_at: new Date(Date.now() + 60000).toISOString() };
  assert.deepEqual(await h.command('action.grant', p, request), await h.command('action.grant', p, request));
  await Promise.all([h.runtime.tick(), new ActionRuntime(h.service).tick(), h.runtime.tick()]);
  assert.equal(h.detail(a).attempts.length, 1); await h.runtime.tick();
  // Same reasoning as the other publication assertion: the receipt travels into the failure
  // message, so a platform-specific publication failure is legible from the log rather than a
  // bare `completed !== unknown` that says nothing about which step failed.
  assert.equal(h.detail(a).status, 'completed',
    `publication did not complete: ${JSON.stringify(h.detail(a).attempts[0]?.receipt ?? null)}`);
  assert.equal(fs.readdirSync(path.join(h.directory, 'action-artifacts')).length, 1); noOutbound(h);
});

test('source revoke while disabled is durable; reallow and restart cannot resurrect pending work', async t => {
  const h = harness(t), a = await h.propose(await h.accepted()); await h.grant(a);
  h.config.actions.enabled = false; h.config.opportunity.allowedSourceRefs = []; h.sweep();
  h.config.actions.enabled = true; h.config.opportunity.allowedSourceRefs = [SOURCE]; h.restart(); h.sweep();
  await h.runtime.tick(); assert.equal(h.detail(a).status, 'stale');
  assert.equal(h.detail(a).attempts.length, 0); await assert.rejects(h.grant(a)); noOutbound(h);
});

for (const change of ['edit','owner_note','pause','age']) test(`${change} invalidates the accepted action basis before maintenance`, async t => {
  const h = harness(t), thread = await h.accepted(), a = await h.propose(thread); await h.grant(a);
  if (change === 'edit') await h.ingest({ version: 2, text: 'New statement', updated_at: '2026-01-01T00:01:00Z' });
  if (change === 'owner_note') await h.command('continuity.note', { thread_id: thread, expected_revision: h.service.continuity.detail(thread).revision, text: 'New priority' });
  if (change === 'pause') await h.command('continuity.pause', { thread_id: thread, expected_revision: h.service.continuity.detail(thread).revision, reason: 'Owner pause' });
  if (change === 'age') t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 3600001 });
  assert.equal(h.detail(a).current, false); await h.runtime.tick();
  assert.equal(h.detail(a).attempts.length, 0); noOutbound(h);
});

test('revocation while an adapter is waiting does not block observation or restore authority on completion', async t => {
  const h = harness(t), a = await h.propose(await h.accepted()); await h.grant(a);
  const local = new LocalActionCapabilities(h.service); let release, entered;
  const started = new Promise(r => { entered = r; }), blocked = new Promise(r => { release = r; });
  const runtime = new ActionRuntime(h.service, { capabilities: { verify: row => local.verify(row), async execute(...args) {
    const receipt = await local.execute(...args); entered(); await blocked; return receipt;
  } } });
  const pass = runtime.tick();
  // Bounded for the same reason as the other held-point wait: `started` only resolves once the
  // adapter has published, so an adapter that throws first leaves this awaiting for ever and the
  // file runs to the workflow timeout — a long wait that reports nothing about why.
  await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error(
    'adapter never reached held point')), 5000))]);
  await h.command('action.revoke', { action_id: a, expected_revision: h.detail(a).revision, reason: 'Stop while in flight' });
  await h.ingest({ message_id: 'm2', text: 'New observation continues.' });
  assert.equal(h.detail(a).status, 'revoked'); release(); await pass; await runtime.tick();
  const d = h.detail(a); assert.equal(d.status, 'revoked'); assert.equal(d.grants[0].status, 'revoked');
  assert.equal(d.attempts[0].verification_state, 'present'); noOutbound(h);
});

test('receipt transaction failure preserves unknown; independent recovery finds the single published effect', async t => {
  const h = harness(t), a = await h.propose(await h.accepted()); await h.grant(a);
  const original = h.store.event.bind(h.store); let failed = false;
  h.store.event = (...args) => { if (args[2] === 'action.receipt' && !failed) { failed = true; throw new Error('receipt failure'); } return original(...args); };
  await assert.rejects(h.runtime.tick(), /receipt failure/);
  h.store.event = original; assert.equal(h.detail(a).status, 'unknown'); assert.equal(h.detail(a).attempts[0].receipt, null);
  h.restart(); await h.runtime.tick(); assert.equal(h.detail(a).attempts[0].verification_state, 'present');
  assert.equal(h.detail(a).attempts.length, 1); noOutbound(h);
});

for (const when of ['before_effect','after_effect']) test(`process death ${when} never silently repeats a dispatched attempt`, async t => {
  const h = harness(t), a = await h.propose(await h.accepted()); await h.grant(a);
  const cfgFile = path.join(h.directory, 'fixture.json'); fs.writeFileSync(cfgFile, JSON.stringify(h.config));
  const script = `import fs from 'node:fs'; import {Store} from './business/store.mjs';
    import {BusinessService} from './business/service.mjs'; import {ActionRuntime} from './business/action-runtime.mjs';
    import {LocalActionCapabilities} from './business/action-capabilities.mjs';
    const db=new Store(process.argv[1]); const s=new BusinessService(db,JSON.parse(fs.readFileSync(process.argv[2],'utf8')));
    const cap=new LocalActionCapabilities(s);const original=cap.execute.bind(cap);
    cap.execute=async(...args)=>{if(process.argv[3]==='after_effect') await original(...args);process.exit(23);};
    await new ActionRuntime(s,{capabilities:cap}).tick();`;
  const child = spawnSync(process.execPath, ['--input-type=module','-e',script,h.directory,cfgFile,when], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 23, child.stderr);
  h.restart(); assert.equal(h.detail(a).attempts[0].status, 'unknown');
  await h.runtime.tick(); const d = h.detail(a);
  assert.equal(d.attempts[0].verification_state, when === 'after_effect' ? 'present' : 'absent');
  await h.runtime.tick(); assert.equal(h.detail(a).attempts.length, 1);
  if (when === 'before_effect') { await h.grant(a, 'action.retry'); await h.runtime.tick(); await h.runtime.tick(); assert.equal(h.detail(a).status, 'completed'); }
  noOutbound(h);
});

for (const result of ['mismatch','unavailable','absent']) test(`${result} is distinct and only independent absence enables explicit retry`, async t => {
  const h = harness(t), a = await h.propose(await h.accepted()); await h.grant(a);
  const local = new LocalActionCapabilities(h.service);
  const runtime = new ActionRuntime(h.service, { capabilities: { async execute() { throw new Error('no outcome'); },
    verify: result === 'unavailable' ? async () => { throw new Error('probe failed'); } : row => local.verify(row) } });
  if (result === 'mismatch') { fs.mkdirSync(path.join(h.directory, 'action-artifacts')); fs.writeFileSync(path.join(h.directory, 'action-artifacts', `${a}.json`), 'foreign bytes'); }
  await runtime.tick(); await assert.rejects(h.grant(a, 'action.retry')); await runtime.tick();
  assert.equal(h.detail(a).attempts[0].verification_state, result);
  if (result === 'absent') await h.grant(a, 'action.retry'); else await assert.rejects(h.grant(a, 'action.retry'));
  assert.equal(h.detail(a).attempts.length, 1); noOutbound(h);
});

test('existing mismatching artifact is never overwritten', async t => {
  const h = harness(t), a = await h.propose(await h.accepted()); await h.grant(a);
  const vault = path.join(h.directory, 'action-artifacts'), file = path.join(vault, `${a}.json`);
  fs.mkdirSync(vault); fs.writeFileSync(file, 'existing owner data');
  await h.runtime.tick(); await h.runtime.tick(); assert.equal(fs.readFileSync(file, 'utf8'), 'existing owner data');
  assert.equal(h.detail(a).attempts[0].verification_state, 'mismatch');
  await assert.rejects(h.runtime.capabilities.artifact(h.service.actions.get(a))); noOutbound(h);
});

test('vault junction cannot redirect writes outside the owner store', async t => {
  const h = harness(t), a = await h.propose(await h.accepted()); await h.grant(a);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-action-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(h.directory, 'action-artifacts'), process.platform === 'win32' ? 'junction' : 'dir');
  await h.runtime.tick(); await h.runtime.tick(); assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(h.detail(a).attempts[0].verification_state, 'unavailable'); noOutbound(h);
});

test('human-only kind stays outside agent context even when its state is pending', async t => {
  const h = harness(t), a = await h.propose(await h.accepted(), 'owner_handoff.create.v1');
  await h.grant(a); await h.runtime.tick(); await h.runtime.tick();
  await h.command('action.handoff_acknowledge', { action_id: a, expected_revision: h.detail(a).revision, note: 'Taking this' });
  const task = h.detail(a).human_task;
  assert.throws(() => contextFor(h.service, null, task), { code: 'candidate_not_executable' });
  assert.equal(contextFor(h.service).work.some(t => t.id === task.id), false);
  await assert.rejects(h.command('task.create', { kind: 'owner_action', title: 'Bypass', instructions: 'Bypass', due_at: new Date().toISOString() }));
  noOutbound(h);
});

test('maintenance cursor is durable, bounded and retires all pending grants while disabled', async t => {
  const h = harness(t), thread = await h.accepted(), base = h.service.continuity.detail(thread), ids = [];
  for (let n = 0; n < 27; n++) ids.push((await h.command('action.propose', { thread_id: thread, expected_basis_fingerprint: base.basis_fingerprint,
    reason: 'Fixture', proposal: { capability_id: 'brief.publish_local.v1', title: `Brief ${n}`, instructions: 'Read', expected_result: 'File', due_at: null } })).action_id);
  for (const a of ids) await h.grant(a);
  h.config.actions.enabled = false; h.config.opportunity.allowedSourceRefs = [];
  assert.equal(h.service.actions.reconcile().actions, 20); const cursor = h.store.get("SELECT cursor FROM channel_offsets WHERE channel='action-maintenance-v1'").cursor;
  h.restart(); assert.equal(h.store.get("SELECT cursor FROM channel_offsets WHERE channel='action-maintenance-v1'").cursor, cursor);
  assert.ok(h.service.actions.reconcile().actions <= 20);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM action_grants WHERE status='active'").n, 0); noOutbound(h);
});

test('execution cursor reaches a grant beyond unprobeable historical work', async t => {
  const h = harness(t), thread = await h.accepted(), base = h.service.continuity.detail(thread);
  for (let n = 0; n < 24; n++) {
    const { action_id } = await h.command('action.propose', { thread_id: thread, expected_basis_fingerprint: base.basis_fingerprint,
      reason: 'Fixture', proposal: { capability_id: 'brief.publish_local.v1', title: `History ${n}`, instructions: 'Read', expected_result: 'File', due_at: null } });
    // Adversarial recoverable queue entry; no attempt exists, so never pretend to verify.
    h.store.run('UPDATE action_proposals SET verify_requested=1 WHERE id=?', action_id);
  }
  const a = await h.propose(thread); await h.grant(a);
  for (let n = 0; n < 6; n++) await h.runtime.tick();
  assert.equal(h.detail(a).status, 'completed'); noOutbound(h);
});

for (const legacy of [false,true]) test(`${legacy ? 'v6' : 'v7'} transfer cannot carry live execution authority`, async t => {
  const h = harness(t), a = await h.propose(await h.accepted()); await h.grant(a);
  const bundle = exportPartner(h.store);
  if (legacy) { for (const table of ACTION_TABLES) delete bundle.tables[table]; bundle.migrations = bundle.migrations.slice(0,6); bundle.tables_sha256 = hash(JSON.stringify(bundle.tables)); }
  const source = path.join(h.directory, 'export.json'), destination = path.join(ROOT, 'exports', `actions-${id()}`);
  fs.writeFileSync(source, JSON.stringify(bundle));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, ['scripts/import.mjs', source, destination], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  const db = new Store(path.join(destination, 'data'));
  try {
    db.recover(); const service = new BusinessService(db, h.config); await new ActionRuntime(service).tick();
    assert.equal(db.get("SELECT COUNT(*) n FROM action_grants WHERE status='active'").n, 0);
    assert.equal(db.get('SELECT COUNT(*) n FROM action_attempts').n, 0);
    if (!legacy) assert.equal(service.actions.detail(a).status, 'revoked');
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
  } finally { db.close(); }
});

test('scheduler requires established reconciliation; a local action wake never calls a model', async t => {
  const h = harness(t), a = await h.propose(await h.accepted()); await h.grant(a);
  let calls = 0;
  const scheduler = new Scheduler(h.service, { decide() { calls++; throw new Error('No model allowed'); }, close() {} }, null);
  await scheduler.actionTick(); assert.equal(h.detail(a).attempts.length, 0);
  await scheduler.sourceTick(); await scheduler.actionTick(); assert.equal(h.detail(a).status, 'verifying');
  scheduler.continuityHealthy = false; await scheduler.actionTick(); // verification remains read-only
  assert.equal(h.detail(a).attempts[0].verification_state, 'present'); scheduler.stop(); assert.equal(calls, 0); noOutbound(h);
});

test('a real server exposes authenticated detail and artifact, and drains execution on shutdown', async t => {
  const h = harness(t), a = await h.propose(await h.accepted()); await h.grant(a); h.config.server.port = 0;
  const app = await start({ config: h.config, directory: h.directory }); t.after(() => app.close());
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(`${origin}/api/actions/${a}`)).status, 403);
  const { token } = await (await fetch(`${origin}/api/session`)).json(), headers = { 'x-partner-token': token };
  assert.equal((await fetch(`${origin}/api/actions?limit=20&limit=1`, { headers })).status, 400);
  assert.equal((await fetch(`${origin}/api/actions/${a}`, { headers })).status, 200);
  let release, entered;
  const ready = new Promise(r => { entered = r; }), hold = new Promise(r => { release = r; });
  const local = app.scheduler.actionRuntime.capabilities, original = local.execute.bind(local);
  local.execute = async (...args) => { const receipt = await original(...args); entered(); await hold; return receipt; };
  await app.scheduler.sourceTick(); const tick = app.scheduler.actionTick();
  // Bounded: if the adapter throws before it ever signals, `ready` would otherwise never resolve
  // and the file hangs until the workflow timeout — 27 minutes to learn that an adapter was not
  // reached. Five seconds answers the same question in five.
  await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error(
    'adapter never reached held point')), 5000))]);
  let closed = false; const closing = app.close().then(() => { closed = true; });
  await new Promise(r => setTimeout(r, 30)); assert.equal(closed, false); release(); await tick; await closing;
  h.restart(); await h.runtime.tick(); assert.equal(h.detail(a).attempts[0].verification_state, 'present'); noOutbound(h);
});

test('optional model proposal uses existing no-tool ledger and cannot grant or execute', async t => {
  const h = harness(t), thread = await h.accepted(); h.config.actions.modelEnabled = true;
  const old = process.env.PARTNER_MODEL_API_KEY; process.env.PARTNER_MODEL_API_KEY = 'offline-fixture';
  t.after(() => { if (old === undefined) delete process.env.PARTNER_MODEL_API_KEY; else process.env.PARTNER_MODEL_API_KEY = old; });
  Object.assign(h.config.runtime, { model: 'configured-fixture', baseUrl: 'https://fixture.invalid/v1' });
  const { action_id: a } = await h.command('action.request_plan', { thread_id: thread, expected_basis_fingerprint: h.service.continuity.detail(thread).basis_fingerprint });
  let calls = 0;
  const model = { async decide(run, c) { calls++; assert.equal(run.runtime, 'hermes-action-v1'); assert.equal(c.tools, undefined);
    return { completed: true, messages: [], tool_calls: [], final_response: JSON.stringify({ kind: 'action', reason: 'Prepare bounded brief',
      proposal: { capability_id: 'brief.publish_local.v1', title: 'Model brief', instructions: 'Read', expected_result: 'Local package', due_at: null } }),
      usage: { input_tokens: 5, output_tokens: 5, cost_status: 'runtime_estimate', estimated_cost_usd: 0.001 } }; } };
  assert.equal((await processActionPlan(h.service, model)).disposition, 'plan_recorded');
  await processActionPlan(h.service, model); assert.equal(calls, 1);
  assert.equal(h.detail(a).status, 'proposed'); assert.equal(h.detail(a).grants.length, 0);
  assert.equal(h.store.get('SELECT estimated_cost_usd FROM runs').estimated_cost_usd, 0.001); noOutbound(h);
});

for (const change of ['edit','revoke','disable','tools','authority']) test(`late/invalid model result (${change}) cannot grant or revive a proposal`, async t => {
  const h = harness(t), thread = await h.accepted(); h.config.actions.modelEnabled = true;
  const old = process.env.PARTNER_MODEL_API_KEY; process.env.PARTNER_MODEL_API_KEY = 'offline-fixture';
  t.after(() => { if (old === undefined) delete process.env.PARTNER_MODEL_API_KEY; else process.env.PARTNER_MODEL_API_KEY = old; });
  Object.assign(h.config.runtime, { model:'fixture', baseUrl:'https://fixture.invalid/v1' });
  const {action_id:a} = await h.command('action.request_plan', {thread_id:thread,expected_basis_fingerprint:h.service.continuity.detail(thread).basis_fingerprint});
  const result = await processActionPlan(h.service, { async decide() {
    if (change === 'edit') await h.ingest({version:2,text:'Different',updated_at:'2026-01-01T00:01:00Z'});
    if (change === 'revoke') await h.command('action.revoke',{action_id:a,expected_revision:h.detail(a).revision,reason:'Stop'});
    if (change === 'disable') h.config.actions.modelEnabled=false;
    return {completed:true,tool_calls:change==='tools'?[{name:'action.grant'}]:[],messages:[],
      usage:{input_tokens:5,output_tokens:5,cost_status:'runtime_estimate',estimated_cost_usd:0.003},
      final_response:JSON.stringify({kind:'action',reason:'Attempt',proposal:{capability_id:'brief.publish_local.v1',title:'Brief',instructions:'Read',expected_result:'File',due_at:null,
        ...(change==='authority'?{grant:true}:{})}})};
  } });
  assert.notEqual(result.disposition,'plan_recorded');assert.equal(h.detail(a).proposal,null);assert.equal(h.detail(a).grants.length,0);
  assert.equal(h.store.get('SELECT estimated_cost_usd FROM runs').estimated_cost_usd,0.003);noOutbound(h);
});

test('shared unknown model billing blocks the optional planner across restart', async t => {
  const h=harness(t),thread=await h.accepted();h.config.actions.modelEnabled=true;
  const old=process.env.PARTNER_MODEL_API_KEY;process.env.PARTNER_MODEL_API_KEY='offline-fixture';
  t.after(()=>{if(old===undefined)delete process.env.PARTNER_MODEL_API_KEY;else process.env.PARTNER_MODEL_API_KEY=old;});
  Object.assign(h.config.runtime,{model:'fixture',baseUrl:'https://fixture.invalid/v1',dailyBudgetUsd:1});
  await h.command('action.request_plan',{thread_id:thread,expected_basis_fingerprint:h.service.continuity.detail(thread).basis_fingerprint});
  h.store.run("INSERT INTO runs(id,partner_id,status,runtime,model,context_json,created_at) VALUES(?,?,'interrupted','other','fixture','{}',?)",id(),h.config.partnerId,new Date().toISOString());
  h.restart();let calls=0;const result=await processActionPlan(h.service,{decide(){calls++;return {};}});
  assert.equal(result.disposition,'budget_blocked');assert.equal(calls,0);noOutbound(h);
});

for (const fence of ['runtime','telegram','automatic']) test(`${fence} fence cannot be bypassed by a prior owner grant`, async t => {
  const h=harness(t),a=await h.propose(await h.accepted());await h.grant(a);
  if(fence==='runtime')h.config.runtime.enabled=true;
  if(fence==='telegram')h.config.telegram.liveSending=true;
  if(fence==='automatic')h.config.opportunity.automatic=false;
  await h.runtime.tick();assert.equal(h.detail(a).attempts.length,0);noOutbound(h);
});

test('schema defaults keep execution and model planning off independently of owner acceptance', () => {
  const cfg=readJson(path.join(ROOT,'config/default.json'));
  assert.equal(cfg.actions.enabled,false);assert.equal(cfg.actions.modelEnabled,false);
  assert.equal(cfg.runtime.enabled,false);assert.equal(cfg.telegram.liveSending,false);
});

test('receipt plus fallback persistence outage recovers on a later tick without restart or replay', async t => {
  const h=harness(t),a=await h.propose(await h.accepted());await h.grant(a);
  const local=new LocalActionCapabilities(h.service),original=h.store.run.bind(h.store);let unavailable=false,effects=0;
  h.store.run=(...args)=>{if(unavailable)throw new Error('database outage');return original(...args);};
  const runtime=new ActionRuntime(h.service,{capabilities:{verify:row=>local.verify(row),async execute(...args){
    const result=await local.execute(...args);effects++;unavailable=true;return result;
  }}});
  await assert.rejects(runtime.tick(),/database outage/);unavailable=false;
  assert.equal(h.detail(a).attempts[0].status,'dispatching');
  await runtime.tick();assert.equal(h.detail(a).attempts[0].verification_state,'present');assert.equal(effects,1);
  h.store.run=original;noOutbound(h);
});

test('probe persistence failure is retryable observation, never a second execution', async t => {
  const h=harness(t),a=await h.propose(await h.accepted());await h.grant(a);await h.runtime.tick();
  const original=h.store.event.bind(h.store);h.store.event=(...args)=>{if(args[2]==='action.verified')throw new Error('probe receipt outage');return original(...args);};
  await assert.rejects(h.runtime.tick(),/probe receipt outage/);assert.equal(h.detail(a).attempts[0].verification_state,'unchecked');
  h.store.event=original;await h.runtime.tick();assert.equal(h.detail(a).attempts.length,1);assert.equal(h.detail(a).status,'completed');noOutbound(h);
});

test('retry cannot race a pending read-only probe using its previous absence', async t => {
  const h=harness(t),a=await h.propose(await h.accepted());await h.grant(a);
  const runtime=new ActionRuntime(h.service,{capabilities:{async execute(){throw new Error('not dispatched');},async verify(){return {state:'absent'};}}});
  await runtime.tick();await runtime.tick();assert.equal(h.detail(a).can_retry,true);
  await h.command('action.verify',{action_id:a,expected_revision:h.detail(a).revision});
  await assert.rejects(h.grant(a,'action.retry'),{code:'ACTION_ABSENCE_REQUIRED'});noOutbound(h);
});

test('a denied grant latches observed source revocation even before the maintenance sweep', async t => {
  const h=harness(t),a=await h.propose(await h.accepted());
  h.config.opportunity.allowedSourceRefs=[];await assert.rejects(h.grant(a));
  assert.equal(h.detail(a).status,'stale');h.config.opportunity.allowedSourceRefs=[SOURCE];h.restart();
  await assert.rejects(h.grant(a));assert.equal(h.detail(a).grants.length,0);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='action.command_denied'").n,2);noOutbound(h);
});
