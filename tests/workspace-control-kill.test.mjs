import test from 'node:test';
import assert from 'node:assert/strict';
import { id } from '../business/store.mjs';
import { workspaceHarness, SOURCE } from './helpers/workspace-harness.mjs';
import { HermesAdapter } from '../business/runtime.mjs';
import { callTool } from '../business/tools.mjs';
import { processWork } from '../business/work-reasoning.mjs';
import { checkAutomaticPrerequisite } from '../business/config.mjs';
import { automaticBoundary } from '../business/source-ingestion.mjs';
import { start } from '../business/server.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function spin(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setImmediate(r)); } assert.fail('expected state was never reached'); }
function bind(h, runtime = 'hermes-continuity-v1') {
  const runId = id(); h.store.run("INSERT INTO runs(id,partner_id,status,runtime,model,context_json,created_at) VALUES(?,?,'running',?,'fake','{}',?)", runId, h.config.partnerId, runtime, new Date().toISOString());
  h.service.control.bindRun(runId); return runId;
}

test('resource admission is atomic, reserves a private slot, and expired worker cannot release its successor', async t => {
  const h = workspaceHarness(t); h.config.controlPlane.maxConcurrent = 2;
  const gate = deferred(); let oldRun;
  const running = h.service.control.run('public', 'held', async () => { await h.service.exclusive(() => h.store.transaction(() => { oldRun = bind(h); })); await gate.promise; });
  await spin(() => oldRun);
  assert.equal((await h.service.control.run('work', 'competitor', () => assert.fail())).disposition, 'CONTROL_CAPACITY');
  let privateAdmitted = false;
  await h.service.control.run('private', 'inbound', () => { privateAdmitted = true; }); assert.equal(privateAdmitted, true);
  h.store.run("UPDATE control_tickets SET expires_at='2000-01-01T00:00:00Z' WHERE run_id=?", oldRun); h.service.control.sweep();
  assert.equal(h.service.control.canApply(oldRun), false);
  // Spend is unknown after expiration, so no successor may bill until the receipt is settled.
  assert.equal((await h.service.control.run('public', 'next', () => assert.fail())).disposition, 'CONTROL_UNKNOWN_COST');
  h.store.run("UPDATE runs SET status='failed',cost_status='configured_estimate',estimated_cost_usd=0 WHERE id=?", oldRun);
  const nextGate = deferred(); let successor;
  const next = h.service.control.run('public', 'next', async () => { await h.service.exclusive(() => h.store.transaction(() => { successor = bind(h); })); await nextGate.promise; });
  await spin(() => successor); gate.resolve(); await running;
  assert.equal(h.service.control.ticket(successor).status, 'running');
  nextGate.resolve(); await next;
});

test('unreserved runtime, direct service agent write and tool write cannot bypass operation authority', async t => {
  const h = workspaceHarness(t); h.config.runtime.enabled = true;
  assert.doesNotThrow(() => checkAutomaticPrerequisite(h.config)); assert.doesNotThrow(() => automaticBoundary(h.service));
  const runtime = new HermesAdapter(h.service, new Map());
  await assert.rejects(runtime.run({ id: id() }, {}), { code: 'CONTROL_TICKET_REQUIRED' });
  await assert.rejects(h.command('task.propose', { title: 'Unauthorized' }, undefined, { kind: 'agent' }), { code: 'CONTROL_TICKET_REQUIRED' });
  await assert.rejects(callTool(h.service, { kind: 'agent' }, 'partner_propose_task', { kind: 'research', title: 'Unauthorized', instructions: 'No authority', evidence: 'No evidence', due_at: new Date().toISOString() }, id()), { status: 403 });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM tasks').n, 0);
  h.config.telegram.liveSending = true; assert.throws(() => automaticBoundary(h.service), { code: 'READ_ONLY_BOUNDARY_REQUIRED' });
});

test('late model material after edit/revoke is discarded but usage is durable and restart never replays the request', async t => {
  const h = workspaceHarness(t), caseId = await h.ready(); h.config.workspace.modelEnabled = true;
  h.config.runtime.model = 'offline-fake'; h.config.runtime.baseUrl = 'https://example.invalid';
  const oldKey = process.env.PARTNER_MODEL_API_KEY; process.env.PARTNER_MODEL_API_KEY = 'offline-not-a-credential';
  t.after(() => { if (oldKey === undefined) delete process.env.PARTNER_MODEL_API_KEY; else process.env.PARTNER_MODEL_API_KEY = oldKey; });
  await h.command('work.request_material', { case_id: caseId, expected_revision: h.service.work.detail(caseId).revision });
  const gate = deferred(); let calls = 0;
  const fake = { async decide() { calls++; return gate.promise; } };
  const pending = processWork(h.service, fake); await spin(() => calls === 1);
  await h.ingest({ version: 2, text: 'Corrected statement.' }); await h.scheduler.sourceTick();
  gate.resolve({ completed: true, final_response: JSON.stringify({ title: 'Obsolete', content: 'Old interpretation', evidence_event_ids: ['1'] }), usage: { input_tokens: 10, output_tokens: 5, estimated_cost_usd: 0.01, cost_status: 'runtime_estimate' } });
  assert.notEqual((await pending).disposition, 'material_proposed'); assert.equal(h.store.get('SELECT COUNT(*) n FROM work_materials').n, 0);
  assert.equal(h.store.get("SELECT estimated_cost_usd FROM runs WHERE runtime='hermes-workspace-v1'").estimated_cost_usd, 0.01);
  h.restart(); await processWork(h.service, fake); assert.equal(calls, 1);
});

test('real server composition refuses a second process on another port and serves authenticated Workspace', async t => {
  const h = workspaceHarness(t); h.config.server.port = 0; h.config.scheduler.enabled = false;
  const app = await start({ config: h.config, directory: h.directory }); h.beforeCleanup.push(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(`${base}/api/workspace`)).status, 403);
  const { token } = await (await fetch(`${base}/api/session`)).json();
  const response = await fetch(`${base}/api/workspace`, { headers: { 'x-partner-token': token } }); assert.equal(response.status, 200);
  const state = await response.json(); assert.equal(state.control.resource_ticket_is_authority, false);
  assert.equal((await fetch(`${base}/workspace.js`)).status, 200);
  await assert.rejects(start({ config: h.config, directory: h.directory }), { code: 'CONTROL_PROCESS_ALREADY_OWNED' });
  const legacyConfig = structuredClone(h.config);
  legacyConfig.controlPlane.enabled = false;
  legacyConfig.workspace.enabled = false;
  legacyConfig.opportunity.automatic = false;
  await assert.rejects(start({ config: legacyConfig, directory: h.directory }).then(other => {
    h.beforeCleanup.push(() => other.close()); return other;
  }), { code: 'CONTROL_PROCESS_ALREADY_OWNED' });
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('a CP-admitted private run cannot inherit legacy autopilot after CP is disabled during inference', async t => {
  const h = workspaceHarness(t);
  const { conversation_id } = await h.command('person.create', { name: 'Synthetic inbound', source: 'Offline owner fixture', permission: 'Owner-authorized reply only' });
  await h.command('conversation.mode', { conversation_id, mode: 'AUTOPILOT' });
  await h.command('message.record', { conversation_id, direction: 'in', text: 'Please ask the owner to take over.', source: 'Offline inbound' });
  h.config.runtime.enabled = true; h.config.runtime.model = 'offline-fake'; h.config.runtime.baseUrl = 'https://example.invalid';
  const oldKey = process.env.PARTNER_MODEL_API_KEY; process.env.PARTNER_MODEL_API_KEY = 'offline-fake';
  t.after(() => { if (oldKey === undefined) delete process.env.PARTNER_MODEL_API_KEY; else process.env.PARTNER_MODEL_API_KEY = oldKey; });
  h.scheduler.runtime = { async run(run) {
    await h.command('draft.create', { conversation_id, action: 'handoff', text: 'Owner review required.' }, undefined, { kind: 'agent', runId: run.id, conversationId: conversation_id });
    // Keep the legacy AUTOPILOT conversation as a valid positive trigger; only admission changes.
    h.config.controlPlane.enabled = false;
    return { completed: true, usage: { estimated_cost_usd: 0, cost_status: 'runtime_estimate' } };
  }, close() {} };
  await h.scheduler.privateTick();
  assert.equal(h.store.get('SELECT COUNT(*) n FROM drafts').n, 1, 'the model proposal must really have succeeded before revocation');
  assert.equal(h.service.conversation(conversation_id).ownership, 'AI_OWNED', 'a retired CP ticket cannot enable legacy autopilot handoff');
  assert.equal(h.store.get('SELECT status FROM runs').status, 'cancelled');
  assert.equal(h.store.get('SELECT status FROM drafts').status, 'pending');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM approvals').n, 0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM delivery_attempts').n, 0);
});

test('a held public inference does not stop inbound drafting, source reconciliation, Outcome or local verification', async t => {
  const h = workspaceHarness(t), caseId = await h.ready(); const { material_id } = await h.material(caseId); await h.approve(caseId, material_id);
  const { action_id } = await h.command('work.prepare_action', { case_id: caseId, expected_revision: h.service.work.detail(caseId).revision, material_id, capability_id: 'material.export_local.v1' });
  const action = h.service.actions.detail(action_id);
  await h.command('action.grant', { action_id, expected_revision: action.revision, proposal_hash: action.proposal_hash, expires_at: new Date(Date.now() + 3600000).toISOString() });
  const evidence = h.service.work.detail(caseId).evidence_event_ids;
  await h.command('continuity.open', { title: 'Independent observation', objective: 'Understand the public source', success_condition: 'Explain uncertainty', source_ids: [SOURCE], initial_evidence_event_ids: evidence, max_age_seconds: 3600 });
  const { conversation_id } = await h.command('person.create', { name: 'Explicit inbound fixture', source: 'Owner-authorized synthetic private conversation', permission: 'Owner permits responding to this existing inbound only' });
  await h.command('message.record', { conversation_id, text: 'Please explain time required.', direction: 'in', source: 'Synthetic inbound' });
  h.config.runtime.enabled = true; h.config.runtime.model = 'offline-fake'; h.config.runtime.baseUrl = 'https://example.invalid'; h.config.continuity.modelEnabled = true;
  h.config.outcomes.enabled = true;
  const oldKey = process.env.PARTNER_MODEL_API_KEY; process.env.PARTNER_MODEL_API_KEY = 'offline-fake';
  t.after(() => { if (oldKey === undefined) delete process.env.PARTNER_MODEL_API_KEY; else process.env.PARTNER_MODEL_API_KEY = oldKey; });
  const gate = deferred(); let publicCalls = 0, privateCalls = 0;
  h.scheduler.runtime = { async decide() { publicCalls++; if (publicCalls === 1) return gate.promise; return { completed: false, usage: { estimated_cost_usd: 0, cost_status: 'runtime_estimate' } }; },
    async run(run) { privateCalls++; await h.command('draft.create', { conversation_id, purpose: 'reply', text: 'The source states two hours; the requirement remains unverified.', evidence: 'Reply only to the recorded inbound' }, undefined, { kind: 'agent', runId: run.id, conversationId: conversation_id });
      return { completed: true, usage: { estimated_cost_usd: 0, cost_status: 'runtime_estimate' } }; }, close() {} };
  await h.scheduler.sourceTick(); const publicPending = h.scheduler.reasonTick(); await spin(() => publicCalls === 1);
  await h.scheduler.privateTick(); assert.equal(privateCalls, 1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM drafts').n, 1);
  await h.scheduler.sourceTick(); assert.equal(h.scheduler.outcomesState.disposition, 'reconciled');
  await h.scheduler.actionTick(); await h.scheduler.actionTick(); assert.equal(h.service.actions.detail(action_id).status, 'completed');
  assert.equal(h.scheduler.reasonBusy, true); assert.equal(h.scheduler.busy, false);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM approvals').n, 0); assert.equal(h.store.get('SELECT COUNT(*) n FROM delivery_attempts').n, 0);
  gate.resolve({ completed: false, usage: { estimated_cost_usd: 0, cost_status: 'runtime_estimate' } }); await publicPending;
});
