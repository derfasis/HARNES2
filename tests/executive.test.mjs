import { ACTION_TABLES } from '../business/action-tables.mjs';
// Acceptance through real commands, SQLite, Scheduler and source adapters. No live providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, readJson } from '../business/config.mjs';
import { Store, id } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { Scheduler } from '../business/scheduler.mjs';
import { processExecutive } from '../business/executive-reasoning.mjs';
import { processContinuity } from '../business/continuity-reasoning.mjs';
import { listCandidates, OPENOUTFIND_CONTRACT_REVISION } from '../business/executive-donors.mjs';
import { DatabaseSync } from 'node:sqlite';
import { pollBrowserSource } from '../business/sources/browser-readonly.mjs';
import { spawnSync } from 'node:child_process';
import { exportPartner } from '../business/export.mjs';
import { hash } from '../business/store.mjs';
import { EXECUTIVE_TABLES } from '../business/executive-tables.mjs';
import { OUTCOME_TABLES } from '../business/outcome-tables.mjs';
import { WORK_TABLES, CONTROL_TABLES } from '../business/work-tables.mjs';
import { start } from '../business/server.mjs';

const SOURCE = 'public:executive', BROWSER = 'browser:executive';
const ACTIVE_OFFER = readJson(path.join(ROOT, 'benchmarks/opportunity-projection-v0/case-01.json')).active_offer;
const fixture = extra => ({ source_id: SOURCE, source_kind: 'sanitized_fixture', message_id: 'm1', author_id: 'a1',
  display_name: null, thread_id: null, reply_to_id: null, version: 1, operation: 'upsert', text: 'Two hours weekly.',
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', ...extra });
function harness(t, browser = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-executive-'));
  const config = readJson(path.join(ROOT, 'config/default.json'));
  config.continuity = { enabled: true, modelEnabled: false };
  config.executive = { enabled: true, modelEnabled: false, autoPlan: false, maxModelRunsPerDay: 5 };
  config.opportunity = { ...config.opportunity, automatic: true, allowedSourceRefs: [SOURCE, ...(browser ? [BROWSER] : [])],
    activeOffer: ACTIVE_OFFER, browserSources: browser ? [
      { sourceId: BROWSER, url: 'https://example.com/offer', maxLagSeconds: 3600, pollEverySeconds: 300,
        processingBasis: 'Executive synthetic test only', sourceKind: 'live_snapshot' }] : [] };
  let store = new Store(directory), service = new BusinessService(store, config);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const h = { directory, config, get store() { return store; }, get service() { return service; },
    command(action, payload, request = id(), actor = { kind: 'operator' }) { return service.command(action, payload, request, actor); },
    ingest(extra = {}) { return this.command('source.ingest', fixture(extra), id(), { kind: 'channel', sourceId: SOURCE }); },
    sweep() { service.continuity.reconcile(); return service.executive.reconcile(); },
    detail(intentId) { return service.executive.detail(intentId); },
    restart() { store.close(); store = new Store(directory); store.recover(); service = new BusinessService(store, config); },
    async open() { return (await this.command('continuity.open', { title: 'Check requirements', objective: 'Understand time requirements',
      success_condition: 'Current citations and remaining uncertainty', source_ids: config.opportunity.allowedSourceRefs, max_age_seconds: 3600 })).thread_id; },
    async propose(threadId, refresh = []) { const d = service.continuity.detail(threadId); return this.command('executive.propose', {
      thread_id: threadId, expected_basis_fingerprint: d.basis_fingerprint, plan: { question: 'What is the time requirement?',
        decision_to_inform: 'Clarify the offer', completion_criterion: 'Cite current evidence, retain uncertainty',
        evidence_event_ids: d.evidence.map(e => e.source_event_id), refresh_source_ids: refresh } }); },
    async authorize(intentId, allowModel = false) { const d = this.detail(intentId); return this.command('executive.authorize', {
      intent_id: intentId, expected_revision: d.revision, expected_basis_fingerprint: d.proposal_basis_fingerprint,
      allow_model: allowModel, deadline: new Date(Date.now() + 3600000).toISOString() }); },
  };
  return h;
}
const brief = packet => ({ summary: { text: 'The current source states two hours.', evidence_event_ids: [packet.evidence[0].source_event_id] },
  claims: [{ source_event_id: packet.evidence[0].source_event_id, quote: packet.evidence[0].text }], hypotheses: [],
  unknowns: ['Not independently verified.'], next: { kind: 'observe', reason: 'Watch for corrections.', wake_at: null, owner_question: null } });
const noEffects = h => {
  for (const table of ['persons', 'conversations', 'contact_permissions', 'messages', 'drafts', 'approvals', 'delivery_attempts', 'facts', 'lessons'])
    assert.equal(h.store.get(`SELECT COUNT(*) n FROM ${table}`).n, 0, table);
  assert.deepEqual(h.store.all('PRAGMA foreign_key_check'), []);
};
async function ready(h, allowModel = false) { const thread = await h.open(); await h.ingest(); h.sweep(); const { intent_id: iid } = await h.propose(thread);
  await h.authorize(iid, allowModel); h.sweep(); return { thread, iid }; }
function modelFixture(t, h) {
  const old = process.env.PARTNER_MODEL_API_KEY; process.env.PARTNER_MODEL_API_KEY = 'executive-offline-fixture';
  t.after(() => { if (old === undefined) delete process.env.PARTNER_MODEL_API_KEY; else process.env.PARTNER_MODEL_API_KEY = old; });
  Object.assign(h.config.runtime, { model: 'configured-fixture', baseUrl: 'https://fixture.invalid/v1' });
  h.config.executive.modelEnabled = true;
}
const modelResponse = value => ({ completed: true, final_response: JSON.stringify(value), messages: [], tool_calls: [],
  model_identity: { model_id: 'served-fixture', model_version: 'fixture-v1' },
  usage: { input_tokens: 20, output_tokens: 10, estimated_cost_usd: 0.002, cost_status: 'runtime_estimate' } });

test('Executive closes the manual question → evidence → brief → reviewed memory loop without effects', async t => {
  const h = harness(t), { thread, iid } = await ready(h);
  let d = h.detail(iid); assert.equal(d.status, 'ready'); assert.equal(d.packet.evidence.length, 1);
  await h.command('executive.submit_brief', { intent_id: iid, expected_revision: d.revision, output: brief(d.packet) });
  d = h.detail(iid); assert.equal(d.status, 'brief_proposed'); assert.equal(h.service.continuity.detail(thread).memory, null);
  await h.command('executive.review', { intent_id: iid, expected_revision: d.revision, decision: 'accept', note: 'Evidence checked.' });
  assert.equal(h.detail(iid).status, 'completed');
  assert.equal(h.service.continuity.detail(thread).memory.epistemic_status, 'unverified_interpretation');
  h.restart(); h.sweep(); assert.equal(h.detail(iid).status, 'completed'); noEffects(h);
});

test('research proposal is not a grant; unauthorized, duplicate and foreign evidence are refused', async t => {
  const h = harness(t), thread = await h.open(); await h.ingest(); h.sweep();
  const request = id(), packet = h.service.continuity.detail(thread);
  const p = { thread_id: thread, expected_basis_fingerprint: packet.basis_fingerprint,
    plan: { question: 'Question', decision_to_inform: 'Decision', completion_criterion: 'Evidence',
      evidence_event_ids: [packet.evidence[0].source_event_id], refresh_source_ids: [] } };
  const result = await h.command('executive.propose', p, request);
  assert.deepEqual(await h.command('executive.propose', p, request), result);
  h.sweep(); assert.equal(h.detail(result.intent_id).status, 'proposed');
  await assert.rejects(h.command('executive.propose', p, id(), { kind: 'agent' }), { status: 403 });
  await assert.rejects(h.propose(thread)); noEffects(h);
});

for (const operation of ['upsert', 'delete']) test(`pending brief cannot be accepted after source ${operation}, including before sweep`, async t => {
  const h = harness(t), { iid } = await ready(h); let d = h.detail(iid);
  await h.command('executive.submit_brief', { intent_id: iid, expected_revision: d.revision, output: brief(d.packet) });
  d = h.detail(iid); await h.ingest({ version: 2, operation, text: operation === 'delete' ? null : 'Actually ten hours.', updated_at: '2026-01-01T00:01:00Z' });
  await assert.rejects(h.command('executive.review', { intent_id: iid, expected_revision: d.revision, decision: 'accept', note: 'Unsafe.' }));
  assert.equal(h.detail(iid).reviewable, false); h.restart(); h.sweep(); assert.equal(h.detail(iid).status, 'superseded'); noEffects(h);
});

test('revoke observed while disabled is terminal; reallow and restart do not resurrect a grant', async t => {
  const h = harness(t), { iid } = await ready(h);
  h.config.executive.enabled = false; h.config.opportunity.allowedSourceRefs = []; h.sweep();
  h.config.executive.enabled = true; h.config.opportunity.allowedSourceRefs = [SOURCE]; h.restart(); h.sweep();
  assert.equal(h.detail(iid).status, 'superseded'); noEffects(h);
});

test('real Scheduler refresh stays on Browser cadence and accepts its own changed evidence', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-27T12:00:00Z') });
  const h = harness(t, true), thread = await h.open(); await h.ingest();
  let reads = 0, text = 'Two hours weekly.';
  const transport = { readPage: async () => { reads++; return { text, truncated: false, finalUrl: 'https://example.com/offer', status: 200 }; } };
  await pollBrowserSource(h.service, BROWSER, transport); h.sweep();
  const { intent_id: iid } = await h.propose(thread, [BROWSER]); await h.authorize(iid);
  const scheduler = new Scheduler(h.service, { decide: async () => { throw new Error('Model must be off'); } }, null, [{ sourceId: BROWSER, transport }]);
  scheduler.browserPolls.set(BROWSER, { readAt: Date.now(), consideredAt: Date.now() });
  await scheduler.tick(); assert.equal(reads, 1); assert.equal(h.detail(iid).status, 'waiting_sources');
  text = 'Correction: three hours weekly.'; t.mock.timers.tick(300001);
  await scheduler.tick(); h.sweep();
  const d = h.detail(iid); assert.equal(reads, 2); assert.equal(d.status, 'ready');
  assert.ok(d.packet.evidence.some(e => e.text === text)); noEffects(h);
});

test('deadline retires research without producing a brief', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-27T12:00:00Z') });
  const h = harness(t), { iid } = await ready(h); t.mock.timers.tick(3600001); h.sweep();
  assert.equal(h.detail(iid).status, 'cancelled');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 0); noEffects(h);
});

test('planning uses the existing no-tool contract, creates only a proposal, and never retries on quiet ticks', async t => {
  const h = harness(t); modelFixture(t, h); const thread = await h.open(); await h.ingest(); h.sweep();
  const d = h.service.continuity.detail(thread), { intent_id: iid } = await h.command('executive.request_plan', {
    thread_id: thread, expected_basis_fingerprint: d.basis_fingerprint });
  let calls = 0;
  const runtime = { async decide(run, context) {
    calls++; assert.equal(context.mode, 'plan'); assert.equal(run.runtime, 'hermes-executive-v1');
    assert.equal(context.tools, undefined);
    return modelResponse({ kind: 'research', reason: 'Clarify a material uncertainty', plan: {
      question: 'What time is needed?', decision_to_inform: 'Clarify requirements', completion_criterion: 'Cite the current statement',
      evidence_event_ids: context.packet.evidence.map(e => e.source_event_id), refresh_source_ids: [] } });
  } };
  assert.equal((await processExecutive(h.service, runtime)).disposition, 'plan_recorded');
  assert.equal(h.detail(iid).status, 'proposed'); assert.equal(h.detail(iid).grant_version, 0);
  h.restart(); h.sweep(); await processExecutive(h.service, runtime); assert.equal(calls, 1);
  const run = h.store.get('SELECT * FROM runs'); assert.equal(run.model, 'configured-fixture');
  assert.equal(JSON.parse(run.result_json).model_identity.model_id, 'served-fixture');
  assert.equal(JSON.parse(run.context_json).contract_fingerprint.length, 64); noEffects(h);
});

test('model brief remains unaccepted until review, and the permitted model run is consumed once', async t => {
  const h = harness(t); modelFixture(t, h); const { iid, thread } = await ready(h, true); let calls = 0;
  const runtime = { async decide(_run, context) { calls++; assert.equal(context.mode, 'brief'); return modelResponse(brief(context.packet)); } };
  assert.equal((await processExecutive(h.service, runtime)).disposition, 'brief_proposed');
  assert.equal(h.service.continuity.detail(thread).memory, null);
  h.sweep(); await processExecutive(h.service, runtime); assert.equal(calls, 1);
  assert.equal(h.detail(iid).attempts.find(a => a.slot === 'brief').status, 'succeeded'); noEffects(h);
});

for (const change of ['edit', 'cancel', 'revoke', 'disable']) test(`a ${change} during a fake model call refuses the result but accounts for usage`, async t => {
  const h = harness(t); modelFixture(t, h); const { iid } = await ready(h, true);
  const result = await processExecutive(h.service, { async decide(_run, context) {
    if (change === 'edit') await h.ingest({ version: 2, text: 'Changed', updated_at: '2026-01-01T00:01:00Z' });
    if (change === 'revoke') h.config.opportunity.allowedSourceRefs = [];
    if (change === 'disable') h.config.executive.modelEnabled = false;
    if (change === 'cancel') await h.command('executive.cancel', { intent_id: iid, expected_revision: h.detail(iid).revision, reason: 'Changed priorities' });
    return modelResponse(brief(context.packet));
  } });
  assert.notEqual(result.disposition, 'brief_proposed');
  assert.equal(h.store.get('SELECT output_json FROM partner_turns WHERE id=?', h.detail(iid).turn_id).output_json, null);
  assert.notEqual(h.store.get('SELECT status FROM partner_turns WHERE id=?', h.detail(iid).turn_id).status, 'running');
  assert.equal(h.store.get('SELECT estimated_cost_usd FROM runs').estimated_cost_usd, 0.002); noEffects(h);
});

test('result transaction failure cannot leave a partial proposal or silently retry paid work', async t => {
  const h = harness(t); modelFixture(t, h); const { iid } = await ready(h, true);
  const original = h.store.event.bind(h.store);
  h.store.event = (...args) => { if (args[2] === 'continuity.proposed') throw new Error('fixture storage fault'); return original(...args); };
  await assert.rejects(processExecutive(h.service, { decide: async (_r, c) => modelResponse(brief(c.packet)) }), /fixture storage fault/);
  h.store.event = original;
  assert.equal(h.detail(iid).status, 'interrupted_unknown');
  assert.equal(h.store.get('SELECT cost_status FROM runs').cost_status, 'unknown');
  assert.equal(h.store.get('SELECT output_json FROM partner_turns').output_json, null);
  h.restart(); h.sweep(); assert.equal((await processExecutive(h.service, { decide: () => assert.fail('Unexpected retry') })).disposition, 'budget_blocked'); noEffects(h);
});

test('a real process crash after durable preparation cannot resurrect a model attempt', async t => {
  const h = harness(t); modelFixture(t, h); const { iid } = await ready(h, true);
  const cfgPath = path.join(h.directory, 'fixture.json'); fs.writeFileSync(cfgPath, JSON.stringify(h.config));
  const script = `import fs from 'node:fs'; import {Store} from './business/store.mjs';
    import {BusinessService} from './business/service.mjs'; import {processExecutive} from './business/executive-reasoning.mjs';
    const s=new Store(process.argv[1]);const svc=new BusinessService(s,JSON.parse(fs.readFileSync(process.argv[2],'utf8')));
    await processExecutive(svc,{decide(){process.exit(23);}});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, h.directory, cfgPath], { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 23, result.stderr);
  h.restart(); h.sweep(); assert.equal(h.detail(iid).status, 'interrupted_unknown');
  h.config.runtime.dailyBudgetUsd = null; assert.equal((await processExecutive(h.service, { decide: () => assert.fail('Resurrection') })).disposition, 'idle'); noEffects(h);
});

test('scope, quotes and arbitrary tool-shaped output cannot be laundered into a brief', async t => {
  const h = harness(t), { iid } = await ready(h); const d = h.detail(iid), good = brief(d.packet);
  for (const output of [{ ...good, permission: true }, { ...good, claims: [{ ...good.claims[0], quote: 'Invented quote' }] },
    { ...good, summary: { text: 'Invented', evidence_event_ids: ['999999'] } }])
    await assert.rejects(h.command('executive.submit_brief', { intent_id: iid, expected_revision: d.revision, output }));
  await assert.rejects(h.command('continuity.propose', { turn_id: d.turn_id, output: good }), { code: 'EXECUTIVE_SUBMIT_REQUIRED' }); noEffects(h);
});

test('a malformed model tool transcript and raw provider error never enter durable output', async t => {
  const h = harness(t); modelFixture(t, h); const { iid } = await ready(h, true);
  await processExecutive(h.service, { decide: async (_r, c) => ({ ...modelResponse(brief(c.packet)), messages: [{ role: 'assistant', tool_calls: { secret: 'private-fixture-token' } }] }) });
  assert.equal(h.detail(iid).status, 'failed'); assert.equal(JSON.stringify(exportPartner(h.store)).includes('private-fixture-token'), false); noEffects(h);
});

test('selected old evidence stays guarded even after eviction from the Continuity window', async t => {
  const h = harness(t), thread = await h.open(); const first = await h.ingest(); h.sweep();
  const { intent_id: iid } = await h.propose(thread); await h.authorize(iid);
  for (let n = 0; n < 9; n++) await h.ingest({ message_id: `new:${n}` });
  h.sweep(); let d = h.detail(iid); assert.equal(d.status, 'ready');
  assert.equal(d.packet.evidence[0].source_event_id, first.source_event_id);
  await h.command('executive.submit_brief', { intent_id: iid, expected_revision: d.revision, output: brief(d.packet) });
  await h.ingest({ version: 2, text: 'Old item corrected', updated_at: '2026-01-01T00:01:00Z' });
  d = h.detail(iid); assert.equal(d.reviewable, false); assert.equal(h.service.continuity.turn(d.turn_id).reviewable, false); noEffects(h);
});

test('owner pause/resume invalidates authority even when the question text is unchanged', async t => {
  const h = harness(t), { thread, iid } = await ready(h);
  let d = h.service.continuity.detail(thread);
  await h.command('continuity.pause', { thread_id: thread, expected_revision: d.revision, reason: 'Pause' });
  d = h.service.continuity.detail(thread); await h.command('continuity.resume', { thread_id: thread, expected_revision: d.revision, reason: 'Resume' });
  assert.equal(h.detail(iid).current, false); h.sweep(); assert.equal(h.detail(iid).status, 'superseded'); noEffects(h);
});

test('research and attempts export/restore; legacy schema-5 bundle has empty research state', async t => {
  const h = harness(t), { iid } = await ready(h); const bundle = exportPartner(h.store);
  for (const legacy of [false, true]) {
    const data = structuredClone(bundle);
    if (legacy) {
      for (const table of [...EXECUTIVE_TABLES, ...ACTION_TABLES, ...OUTCOME_TABLES, ...WORK_TABLES, ...CONTROL_TABLES]) delete data.tables[table];
      for (const row of data.tables.messages) { delete row.occurred_at; delete row.time_basis; }
      // A real schema-5 export cannot contain research packets or their audit events.
      data.tables.partner_turns = [];
      data.tables.events = data.tables.events.filter(e => !e.kind.startsWith('executive.') && !['continuity.captured','continuity.attention'].includes(e.kind));
      data.tables.command_receipts = [];
      data.migrations = data.migrations.slice(0, 5); data.tables_sha256 = hash(JSON.stringify(data.tables));
    }
    const file = path.join(h.directory, `bundle-${legacy}.json`); fs.writeFileSync(file, JSON.stringify(data));
    const destination = path.join(ROOT, 'exports', `executive-test-${id()}`); t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
    const result = spawnSync(process.execPath, ['scripts/import.mjs', file, destination], { cwd: ROOT, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
    const restored = new Store(path.join(destination, 'data'));
    try { assert.deepEqual(restored.all('PRAGMA foreign_key_check'), []);
      assert.equal(restored.get('SELECT COUNT(*) n FROM research_intents').n, legacy ? 0 : 1);
      if (!legacy) assert.equal(new BusinessService(restored, h.config).executive.detail(iid).status, 'ready');
    } finally { restored.close(); }
  } noEffects(h);
});

test('actual operator HTTP API rejects unauthenticated and ambiguous queries and serves the research module', async t => {
  const h = harness(t); h.config.server.port = 0; h.config.scheduler.enabled = false;
  const app = await start({ config: h.config, directory: h.directory });
  try {
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const session = await (await fetch(`${base}/api/session`)).json(); const headers = { 'x-partner-token': session.token };
    assert.equal((await fetch(`${base}/api/executive/intents`)).status, 403);
    assert.equal((await fetch(`${base}/api/executive/intents?limit=1&limit=2`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/api/executive/intents?extra=1`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/api/executive/intents`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/api/executive/candidates`)).status, 403);
    assert.equal((await fetch(`${base}/api/executive/candidates?cursor=-1`, { headers })).status, 400);
    const script = await fetch(`${base}/research.js`); assert.equal(script.status, 200); assert.match(await script.text(), /createResearchView/);
  } finally { await app.close(); } noEffects(h);
});

test('accepted research owns automatic attention until it completes, including while waiting for a reader', async t => {
  const h = harness(t, true); modelFixture(t, h); h.config.continuity.modelEnabled = true;
  const thread = await h.open(); await h.ingest();
  await pollBrowserSource(h.service, BROWSER, { readPage: async () => ({ text: 'Evidence', truncated: false, finalUrl: 'https://example.com/offer', status: 200 }) });
  h.sweep(); const { intent_id: iid } = await h.propose(thread, [BROWSER]); await h.authorize(iid);
  const forbidden = { decide: () => assert.fail('Continuity stole the research question') };
  assert.equal((await processContinuity(h.service, forbidden)).disposition, 'idle');
  h.restart(); h.sweep(); assert.equal((await processContinuity(h.service, forbidden)).disposition, 'idle');
  assert.equal(h.detail(iid).status, 'waiting_sources'); noEffects(h);
});

test('a pending ordinary interpretation must be reviewed before research can reserve the question', async t => {
  const h = harness(t), thread = await h.open(); await h.ingest(); h.sweep();
  let d = h.service.continuity.detail(thread);
  const { turn_id: turnId } = await h.command('continuity.capture', { thread_id: thread, expected_revision: d.revision, expected_basis_fingerprint: d.basis_fingerprint });
  await h.command('continuity.propose', { turn_id: turnId, output: brief(h.service.continuity.turn(turnId).packet) });
  await assert.rejects(h.propose(thread), { code: 'EXECUTIVE_CONTINUITY_REVIEW_REQUIRED' });
  await h.command('continuity.review', { turn_id: turnId, expected_basis_fingerprint: d.basis_fingerprint, decision: 'accept', note: 'Checked before research' });
  const { intent_id: iid } = await h.propose(thread); assert.equal(h.detail(iid).status, 'proposed');
  modelFixture(t, h); h.config.continuity.modelEnabled = true;
  assert.equal((await processContinuity(h.service, { decide: () => assert.fail('Proposal lost its question') })).disposition, 'idle'); noEffects(h);
});

test('interrupted refresh never becomes success or retries after restart', async t => {
  const h = harness(t, true), thread = await h.open(); await h.ingest();
  await pollBrowserSource(h.service, BROWSER, { readPage: async () => ({ text: 'Evidence', truncated: false, finalUrl: 'https://example.com/offer', status: 200 }) });
  h.sweep(); const { intent_id: iid } = await h.propose(thread, [BROWSER]); await h.authorize(iid);
  const attempts = h.store.transaction(() => h.service.executive.beginPoll(BROWSER)); assert.equal(attempts.length, 1);
  h.restart(); h.sweep(); assert.equal(h.detail(iid).status, 'interrupted_unknown');
  assert.deepEqual(h.service.executive.beginPoll(BROWSER), []);
  assert.equal(h.detail(iid).attempts.find(a => a.slot.startsWith('refresh:')).status, 'interrupted_unknown'); noEffects(h);
});

test('automatic planning is opt-in and produces at most one proposal per accepted memory', async t => {
  const h = harness(t); modelFixture(t, h); const { iid, thread } = await ready(h);
  let d = h.detail(iid); await h.command('executive.submit_brief', { intent_id: iid, expected_revision: d.revision, output: brief(d.packet) });
  d = h.detail(iid); await h.command('executive.review', { intent_id: iid, expected_revision: d.revision, decision: 'accept', note: 'Checked' });
  h.sweep(); assert.equal(h.store.get('SELECT COUNT(*) n FROM research_intents').n, 1);
  h.config.executive.autoPlan = true; h.sweep(); assert.equal(h.store.get('SELECT COUNT(*) n FROM research_intents').n, 2);
  let calls = 0;
  const runtime = { decide: async () => { calls++; return modelResponse({ kind: 'no_research', reason: 'No useful new question', plan: null }); } };
  await processExecutive(h.service, runtime); h.restart(); h.sweep(); await processExecutive(h.service, runtime);
  assert.equal(calls, 1); assert.equal(h.service.continuity.detail(thread).memory.current, true); noEffects(h);
});

test('shared daily model budget also bounds Executive and is not reset by restart', async t => {
  const h = harness(t); modelFixture(t, h); const { iid } = await ready(h, true);
  h.config.runtime.maxRunsPerDay = 1;
  h.store.run("INSERT INTO runs(id,partner_id,status,runtime,model,context_json,created_at,cost_status) VALUES(?,?,'completed','other-worker','fixture','{}',?,'runtime_estimate')",
    id(), h.config.partnerId, new Date().toISOString());
  const runtime = { decide: () => assert.fail('Exceeded global daily budget') };
  assert.equal((await processExecutive(h.service, runtime)).disposition, 'budget_blocked');
  h.restart(); h.sweep(); assert.equal((await processExecutive(h.service, runtime)).disposition, 'budget_blocked');
  assert.equal(h.detail(iid).status, 'ready'); noEffects(h);
});

test('donor projection is atomic, deduplicated and never becomes evidence, identity or contact permission', async t => {
  const h = harness(t), record = { lead_id: 42, company: 'Example', reason: 'An unverified donor judgement',
    qualified_at: '2026-09-27', future_field: { credential: 'discard-fixture-token' } };
  const input = { jsonl: JSON.stringify(record) };
  await assert.rejects(h.command('executive.import_candidates', input, id(), { kind: 'agent' }), { status: 403 });
  const first = await h.command('executive.import_candidates', input);
  assert.equal(first.candidates[0].duplicate, false);
  const second = await h.command('executive.import_candidates', { jsonl: JSON.stringify({ ...record, future_field: 'changed ignored extra' }) });
  assert.equal(second.candidates[0].duplicate, true); assert.equal(first.candidates[0].event_id, second.candidates[0].event_id);
  await assert.rejects(h.command('executive.import_candidates', { jsonl: JSON.stringify({ ...record, lead_id: 43 }) + '\n{"lead_id":44}' }));
  h.restart(); const rows = listCandidates(h.service).items; assert.equal(rows.length, 1);
  assert.equal(rows[0].adapter_contract_revision, OPENOUTFIND_CONTRACT_REVISION);
  assert.equal(rows[0].exporter_revision, null); assert.equal(rows[0].evidence_freshness, 'unknown');
  assert.equal(rows[0].contact_permission, false); assert.equal(rows[0].executable, false);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='source.message'").n, 0);
  assert.equal(JSON.stringify(exportPartner(h.store)).includes('discard-fixture-token'), false); noEffects(h);
});

test('bounded maintenance eventually visits later intents across restarts', async t => {
  const h = harness(t), ids = [];
  for (let n = 0; n < 24; n++) {
    const thread = await h.open(); await h.ingest({ message_id: `item:${n}` });
    h.service.continuity.reconcile({ limit: 20 }); h.service.continuity.reconcile({ limit: 20 });
    ids.push((await h.propose(thread)).intent_id);
  }
  h.config.opportunity.allowedSourceRefs = [];
  const first = h.service.executive.reconcile(); assert.equal(first.intents, 20);
  h.restart(); const second = h.service.executive.reconcile(); assert.equal(second.intents, 4);
  assert.ok(ids.every(iid => h.detail(iid).status === 'superseded')); noEffects(h);
});

test('real schema-5 database upgrades in place without changing existing source truth', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-executive-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(directory, 'partner.sqlite'));
  db.exec('CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for (const version of fs.readdirSync(path.join(ROOT, 'business/migrations')).filter(f => f.endsWith('.sql')).sort().slice(0, 5)) {
    const sql = fs.readFileSync(path.join(ROOT, 'business/migrations', version), 'utf8'); db.exec(sql);
    db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(version, hash(sql), '2026-09-27T00:00:00.000Z');
  }
  const profile = readJson(path.join(ROOT, 'partner/profile.json'));
  db.prepare('INSERT INTO partners VALUES(?,?,?,?,?)').run(profile.id, 'Owner', 'Keep this mission', 1, '2026-09-27');
  db.prepare('INSERT INTO events(partner_id,conversation_id,kind,actor,payload_json,created_at) VALUES(?,NULL,?,?,?,?)')
    .run(profile.id, 'source.message', 'system', JSON.stringify(fixture({})), '2026-09-27T00:00:00.000Z');
  const before = db.prepare('SELECT * FROM events').all(); db.close();
  const migrated = new Store(directory);
  try {
    assert.equal(migrated.all('SELECT * FROM schema_migrations').length, 10);
    assert.deepEqual(migrated.all('SELECT * FROM events'), before);
    assert.equal(migrated.get('SELECT mission FROM partners').mission, 'Keep this mission');
    assert.equal(migrated.get('SELECT COUNT(*) n FROM research_intents').n, 0);
    assert.deepEqual(migrated.all('PRAGMA foreign_key_check'), []);
  } finally { migrated.close(); }
});
