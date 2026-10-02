import { ACTION_TABLES } from '../business/action-tables.mjs';
// Black-box acceptance for persistent work. Synthetic fixtures, real SQLite/service.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, readJson } from '../business/config.mjs';
import { Store, id } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { processContinuity } from '../business/continuity-reasoning.mjs';
import { Scheduler } from '../business/scheduler.mjs';
import { exportPartner } from '../business/export.mjs';
import { CONTINUITY_TABLES } from '../business/continuity-tables.mjs';
import { EXECUTIVE_TABLES } from '../business/executive-tables.mjs';
import { OUTCOME_TABLES } from '../business/outcome-tables.mjs';
import { WORK_TABLES, CONTROL_TABLES } from '../business/work-tables.mjs';
import { SCOUT_TABLES } from '../business/scout-tables.mjs';
import { spawnSync } from 'node:child_process';
import { hash } from '../business/store.mjs';
import { pollBrowserSource } from '../business/sources/browser-readonly.mjs';
import { bootstrapTelegramSource, applyTelegramDifference } from '../business/sources/telegram-readonly.mjs';
import http from 'node:http';
import { start } from '../business/server.mjs';

const A = 'public:continuity-a', B = 'public:continuity-b';
const raw = (extra = {}) => ({ source_id: A, source_kind: 'sanitized_fixture', message_id: 'message:1',
  author_id: 'user:1', display_name: null, thread_id: null, reply_to_id: null, version: 1,
  operation: 'upsert', text: 'The programme requires two hours weekly.',
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', ...extra });
function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-continuity-'));
  const config = readJson(path.join(ROOT, 'config/default.json'));
  config.continuity = { enabled: true, modelEnabled: false };
  config.opportunity = { ...config.opportunity, automatic: true, allowedSourceRefs: [A, B],
    activeOffer: { id: 'synthetic-offer', version: 'v1', text: 'Fixture only' } };
  let store = new Store(directory), service = new BusinessService(store, config);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, config, get store() { return store; }, get service() { return service; },
    command(action, payload, request = id(), actor = { kind: 'operator' }) { return service.command(action, payload, request, actor); },
    ingest(extra = {}) { return service.command('source.ingest', raw(extra), id(), { kind: 'channel', sourceId: extra.source_id ?? A }); },
    open(extra = {}) { return this.command('continuity.open', { title: 'Understand time requirements',
      objective: 'Compare stated requirements with public questions.', success_condition: 'Evidence and remaining gaps are clear to the owner.',
      source_ids: [A, B], max_age_seconds: 3600, ...extra }); },
    sweep(options) { return service.continuity.reconcile(options); },
    detail(threadId) { return service.continuity.detail(threadId); },
    capture(threadId) { const d = this.detail(threadId); return this.command('continuity.capture', {
      thread_id: threadId, expected_revision: d.revision, expected_basis_fingerprint: d.basis_fingerprint }); },
    restart() { store.close(); store = new Store(directory); store.recover(); service = new BusinessService(store, config); },
    crashProcess(script) {
      const configFile = path.join(directory, 'fixture-config.json'); fs.writeFileSync(configFile, JSON.stringify(config));
      store.close();
      try { return spawnSync(process.execPath, ['--input-type=module', '-e', script, directory, configFile], { cwd: ROOT, encoding: 'utf8' }); }
      finally { store = new Store(directory); store.recover(); service = new BusinessService(store, config); }
    },
  };
}
function noEffects(h) {
  for (const table of ['persons', 'conversations', 'contact_permissions', 'messages', 'drafts', 'approvals',
    'delivery_attempts', 'facts', 'lessons', 'engagements', 'tasks']) {
    assert.equal(h.store.get(`SELECT COUNT(*) n FROM ${table}`).n, 0, table);
  }
  assert.deepEqual(h.store.all('PRAGMA foreign_key_check'), []);
}
function output(packet, extra = {}) {
  const ref = packet.evidence[0].source_event_id;
  return { summary: { text: 'The available statement suggests a modest time requirement.', evidence_event_ids: [ref] },
    claims: [{ source_event_id: ref, quote: packet.evidence[0].text }],
    hypotheses: [{ text: 'Time may matter more than product details for this question.',
      evidence_event_ids: [ref], counterevidence_event_ids: [] }],
    unknowns: ['The statement has not been independently verified.'],
    next: { kind: 'observe', reason: 'Await new information.', wake_at: null, owner_question: null }, ...extra };
}
async function proposed(h, threadId, override = {}) {
  const captured = await h.capture(threadId);
  const turn = h.service.continuity.turn(captured.turn_id);
  await h.command('continuity.propose', { turn_id: turn.id, output: output(turn.packet, override) });
  return h.service.continuity.turn(turn.id);
}
const review = (h, turn, decision = 'accept') => h.command('continuity.review', { turn_id: turn.id,
  expected_basis_fingerprint: turn.basis_fingerprint, decision, note: 'Synthetic operator review.' });

test('working question spans two sources without creating a person or rewriting source truth', async t => {
  const h = harness(t), thread = await h.open();
  const first = await h.ingest();
  await h.ingest({ source_id: B, text: 'Is this possible with two hours weekly?' });
  h.sweep();
  const d = h.detail(thread.thread_id);
  assert.equal(d.evidence.length, 2);
  assert.equal(d.attention.pending, true);
  assert.deepEqual(new Set(d.evidence.map(e => e.source_ref)), new Set([A, B]));
  const turn = await proposed(h, d.id);
  assert.equal(h.detail(d.id).memory, null, 'a proposal is not accepted memory');
  await review(h, turn);
  assert.equal(h.detail(d.id).memory.epistemic_status, 'unverified_interpretation');
  assert.equal(h.detail(d.id).attention.pending, false);
  assert.equal(JSON.parse(h.store.get('SELECT payload_json FROM events WHERE id=?', first.source_event_id).payload_json).text, raw().text);
  h.restart();
  assert.equal(h.detail(d.id).memory.turn_id, turn.id);
  noEffects(h);
});

test('historical evidence is opt-in; unchanged input and quiet restarts do not recreate attention', async t => {
  const h = harness(t), old = await h.ingest();
  const empty = await h.open(); h.sweep();
  assert.equal(h.detail(empty.thread_id).evidence.length, 0);
  const seeded = await h.open({ initial_evidence_event_ids: [old.source_event_id] });
  assert.equal(h.detail(seeded.thread_id).evidence[0].origin, 'owner_selected_history');
  const turn = await proposed(h, seeded.thread_id); await review(h, turn);
  const before = h.detail(seeded.thread_id);
  await h.ingest(); h.sweep(); h.restart(); h.sweep();
  assert.equal(h.detail(seeded.thread_id).attention.pending, false);
  assert.equal(h.detail(seeded.thread_id).revision, before.revision);
  noEffects(h);
});

for (const operation of ['upsert', 'delete']) test(`source ${operation} invalidates pending proposal before reconciliation and memory after restart`, async t => {
  const h = harness(t), thread = await h.open(); await h.ingest(); h.sweep();
  const accepted = await proposed(h, thread.thread_id); await review(h, accepted);
  await h.ingest({ message_id: 'message:2' }); h.sweep();
  const pending = await proposed(h, thread.thread_id);
  await h.ingest({ version: 2, operation, text: operation === 'delete' ? null : 'Correction: ten hours are required.',
    updated_at: '2026-01-01T00:01:00.000Z' });
  await assert.rejects(review(h, pending), { code: 'CONTINUITY_STALE_BASIS' });
  h.restart();
  assert.equal(h.detail(thread.thread_id).memory.current, false);
  assert.equal(h.detail(thread.thread_id).memory.content, null, 'stale derived text is withheld from new context');
  await review(h, pending, 'reject'); // A stale proposal remains rejectable.
  h.sweep();
  assert.equal(h.detail(thread.thread_id).attention.pending, true);
  noEffects(h);
});

test('revocation while disabled retires the watch, and reallow/restart cannot revive memory', async t => {
  const h = harness(t), thread = await h.open(); await h.ingest(); h.sweep();
  await review(h, await proposed(h, thread.thread_id));
  h.config.opportunity.allowedSourceRefs = [B]; h.config.continuity.enabled = false;
  h.restart(); h.sweep({ limit: 1 });
  h.config.opportunity.allowedSourceRefs = [A, B]; h.config.continuity.enabled = true;
  h.restart(); h.sweep();
  const d = h.detail(thread.thread_id);
  assert.equal(d.watches.find(w => w.source_ref === A).status, 'revoked');
  assert.equal(d.memory.current, false);
  assert.equal(d.evidence.length, 0);
  noEffects(h);
});

test('a burst coalesces attention; bounded fair cursors progress across restart with a hot source', async t => {
  const h = harness(t), first = await h.open(), second = await h.open({ source_ids: [B] });
  for (let i = 0; i < 12; i++) await h.ingest({ message_id: `burst:${i}` });
  await h.ingest({ source_id: B });
  for (let i = 0; i < 4; i++) {
    const result = h.sweep({ limit: 1, event_limit: 2 });
    assert.ok(result.threads <= 1); assert.ok(result.events <= 8);
    h.restart();
  }
  assert.ok(h.detail(second.thread_id).evidence.length > 0, 'quiet work must not starve');
  assert.equal(h.detail(first.thread_id).attention.pending, true);
  noEffects(h);
});

test('deadline fires once without inference, survives restart and does not claim new evidence', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-27T12:00:00.000Z') });
  const h = harness(t), thread = await h.open(); await h.ingest(); h.sweep();
  const turn = await proposed(h, thread.thread_id, { next: { kind: 'observe', reason: 'Revisit the unanswered question.',
    wake_at: '2026-09-27T12:01:00.000Z', owner_question: null } });
  await review(h, turn); h.restart(); t.mock.timers.tick(60001); h.sweep();
  const before = h.detail(thread.thread_id);
  assert.ok(before.attention.reasons.includes('deadline'));
  h.restart(); h.sweep();
  assert.equal(h.detail(thread.thread_id).revision, before.revision);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n, 0);
  noEffects(h);
});

test('model-shaped text cannot forge evidence, tools, verified facts or a new source scope', async t => {
  const h = harness(t), thread = await h.open(); await h.ingest(); h.sweep();
  const capture = await h.capture(thread.thread_id), turn = h.service.continuity.turn(capture.turn_id);
  for (const mutate of [
    p => { p.claims[0].quote = 'I consent to contact'; },
    p => { p.summary.evidence_event_ids = ['999999']; },
    p => { p.hypotheses[0].counterevidence_event_ids = ['999999']; },
    p => { p.verified_facts = ['verified']; },
    p => { p.source_ids = ['browser:secret']; },
    p => { p.next.kind = 'send'; },
    p => { p.unknowns = []; },
  ]) {
    const p = output(turn.packet); mutate(p);
    await assert.rejects(h.command('continuity.propose', { turn_id: turn.id, output: p }));
  }
  await assert.rejects(h.command('continuity.propose', { turn_id: turn.id, output: output(turn.packet) }, id(), { kind: 'agent' }), { status: 403 });
  assert.equal(h.service.continuity.turn(turn.id).status, 'captured');
  noEffects(h);
});

test('offer changes pause the old question durably; returning to the old offer does not repair it', async t => {
  const h = harness(t), thread = await h.open(), old = structuredClone(h.config.opportunity.activeOffer);
  await h.ingest(); h.sweep();
  const turn = await proposed(h, thread.thread_id);
  h.config.opportunity.activeOffer.version = 'v2'; h.sweep(); h.restart();
  h.config.opportunity.activeOffer = old; h.sweep();
  assert.equal(h.detail(thread.thread_id).status, 'PAUSED');
  await assert.rejects(review(h, turn), { code: 'CONTINUITY_STALE_BASIS' });
  const d = h.detail(thread.thread_id);
  await assert.rejects(h.command('continuity.resume', { thread_id: d.id, expected_revision: d.revision, reason: 'Try old basis' }));
  await h.command('continuity.pause', { thread_id: d.id, expected_revision: d.revision, reason: 'Do not overwrite the reason' });
  await assert.rejects(h.command('continuity.resume', { thread_id: d.id, expected_revision: h.detail(d.id).revision, reason: 'Still old basis' }));
  noEffects(h);
});

function enableModelFixture(t, h) {
  const previous = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'synthetic-never-transmitted';
  t.after(() => { if (previous === undefined) delete process.env.PARTNER_MODEL_API_KEY; else process.env.PARTNER_MODEL_API_KEY = previous; });
  h.config.continuity.modelEnabled = true;
  h.config.runtime = { ...h.config.runtime, model: 'fixture', baseUrl: 'https://invalid.example/v1',
    maxRunsPerDay: 30, dailyBudgetUsd: 5, inputUsdPerMillion: 1, outputUsdPerMillion: 1 };
}
const modelResult = packet => ({ completed: true, final_response: JSON.stringify(output(packet)),
  usage: { input_tokens: 200, output_tokens: 100 }, tool_calls: [], messages: [],
  model_identity: { model_id: 'provider-fixture', model_version: 'provider-v1' } });

test('model proposal uses the no-tool seam, stays unaccepted, charges usage and never retries a quiet basis', async t => {
  const h = harness(t); enableModelFixture(t, h);
  const thread = await h.open(); await h.ingest(); h.sweep();
  let calls = 0;
  const runtime = { async decide(run, context) { calls++; assert.equal(run.runtime, 'hermes-continuity-v1');
    assert.match(context.router_instructions, /no\s+tools/);
    return modelResult(context.packet); } };
  const result = await processContinuity(h.service, runtime);
  assert.equal(result.disposition, 'proposal_created');
  assert.equal(h.detail(thread.thread_id).memory, null);
  assert.equal(h.service.continuity.turn(result.turn_id).producer, 'model');
  assert.equal(h.store.get("SELECT cost_status FROM runs WHERE runtime='hermes-continuity-v1'").cost_status, 'configured_estimate');
  const run = h.store.get("SELECT * FROM runs WHERE runtime='hermes-continuity-v1'");
  assert.equal(JSON.parse(run.result_json).model_identity.model_id, 'provider-fixture');
  assert.notEqual(JSON.parse(run.result_json).model_identity.model_id, run.model);
  assert.equal(JSON.parse(run.context_json).prompt_fingerprint.length, 64);
  h.restart(); h.sweep();
  assert.equal((await processContinuity(h.service, runtime)).disposition, 'idle');
  assert.equal(calls, 1);
  await review(h, h.service.continuity.turn(result.turn_id));
  assert.equal(h.detail(thread.thread_id).memory.current, true);
  noEffects(h);
});

test('an in-flight model result cannot outrun a source edit, and its cost is still recorded', async t => {
  const h = harness(t); enableModelFixture(t, h);
  await h.open(); await h.ingest(); h.sweep();
  const runtime = { async decide(_run, context) {
    await h.ingest({ version: 2, text: 'The requirement has changed.', updated_at: '2026-01-01T00:01:00.000Z' });
    return modelResult(context.packet);
  } };
  const result = await processContinuity(h.service, runtime);
  assert.equal(result.disposition, 'stale');
  const turn = h.service.continuity.turn(result.turn_id);
  assert.equal(turn.output, null);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs WHERE estimated_cost_usd>0').n, 1);
  await assert.rejects(review(h, turn));
  noEffects(h);
});

test('restart during reasoning preserves unknown cost and does not silently re-bill', async t => {
  const h = harness(t); enableModelFixture(t, h);
  await h.open(); await h.ingest(); h.sweep();
  const child = h.crashProcess(`
    import fs from 'node:fs';
    import { Store } from './business/store.mjs';
    import { BusinessService } from './business/service.mjs';
    import { processContinuity } from './business/continuity-reasoning.mjs';
    const store = new Store(process.argv[1]);
    const service = new BusinessService(store, JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
    await processContinuity(service, { decide() { process.exit(23); } });
    process.exit(99);
  `);
  assert.equal(child.status, 23, child.stderr);
  assert.equal(h.store.get('SELECT status FROM partner_turns').status, 'interrupted');
  assert.equal(h.store.get('SELECT cost_status FROM runs').cost_status, 'unknown');
  const runtime = { async decide() { assert.fail('A recovered attempt must not be billed again'); } };
  assert.equal((await processContinuity(h.service, runtime)).disposition, 'budget_blocked');
  h.config.runtime.dailyBudgetUsd = null;
  assert.equal((await processContinuity(h.service, runtime)).disposition, 'idle', 'one-attempt fence survives even without a cost cap');
  noEffects(h);
});

test('actual Scheduler wiring observes with model disabled and reasons only after explicit opt-in', async t => {
  const h = harness(t); enableModelFixture(t, h); h.config.continuity.modelEnabled = false;
  h.config.runtime.maxRunsPerDay = 1;
  const thread = await h.open(); await h.ingest();
  // Consume only the OLD opportunity work via its own public boundary, so this
  // test measures the new scheduler path without manufacturing a model failure.
  // Use actual source ID; IDs also include the thread's opening/audit events.
  const sourceId = String(h.store.get("SELECT id FROM events WHERE kind='source.message'").id);
  h.store.event(h.config.partnerId, null, 'opportunity.pipeline.finished', 'system', { source_event_id: sourceId, disposition: 'fixture' });
  let calls = 0;
  const runtime = { async decide(_run, context) { calls++; return modelResult(context.packet); } };
  const scheduler = new Scheduler(h.service, runtime, { readiness: () => ({ enabled: false }) });
  await scheduler.tick();
  assert.equal(h.detail(thread.thread_id).evidence.length, 1);
  assert.equal(calls, 0);
  h.config.continuity.modelEnabled = true;
  await scheduler.tick();
  assert.equal(calls, 1);
  assert.equal(h.store.get('SELECT status FROM partner_turns').status, 'proposed');
  await scheduler.tick(); assert.equal(calls, 1);
  noEffects(h);
});

test('browser receipt expiry after restart gates old evidence until a confirmed read; unchanged content creates no new observation', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-27T12:00:00.000Z') });
  const h = harness(t), sourceId = 'browser:continuity';
  h.config.opportunity.allowedSourceRefs = [sourceId];
  h.config.opportunity.browserSources = [{ sourceId, url: 'https://example.com/offer', maxLagSeconds: 900,
    pollEverySeconds: 300, processingBasis: 'Synthetic fixture', sourceKind: 'live_snapshot' }];
  const thread = await h.open({ source_ids: [sourceId] });
  const transport = { async readPage() { return { text: raw().text, truncated: false, finalUrl: 'https://example.com/offer', status: 200 }; } };
  await pollBrowserSource(h.service, sourceId, transport); h.sweep();
  await review(h, await proposed(h, thread.thread_id));
  const sourceCount = h.store.get("SELECT COUNT(*) n FROM events WHERE kind='source.message'").n;
  h.restart();
  // HTTP receipts are stateless observations valid for maxLagSeconds. Unlike the
  // Telegram stream, restarting the process alone does not invalidate that receipt.
  assert.equal(h.detail(thread.thread_id).memory.current, true);
  t.mock.timers.tick(900001);
  assert.equal(h.detail(thread.thread_id).memory.current, false);
  await pollBrowserSource(h.service, sourceId, transport); h.sweep();
  assert.equal(h.detail(thread.thread_id).memory.current, true);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='source.message'").n, sourceCount);
  t.mock.timers.tick(86400000);
  assert.equal(h.detail(thread.thread_id).memory.current, false);
  await pollBrowserSource(h.service, sourceId, transport); h.sweep();
  assert.equal(h.detail(thread.thread_id).memory.current, true, 'unchanged reference documents can be freshly confirmed without inventing a new source message');
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='source.message'").n, sourceCount);
  noEffects(h);
});

test('projection failure rolls back its cursor, never source truth; restart retries only the projection', async t => {
  const h = harness(t), thread = await h.open(); await h.ingest();
  const before = h.store.get('SELECT cursor FROM partner_watches WHERE thread_id=? AND source_ref=?', thread.thread_id, A).cursor;
  const original = h.store.run.bind(h.store);
  h.store.run = (sql, ...args) => { if (sql.startsWith('UPDATE partner_watches SET cursor')) throw new Error('synthetic cursor failure'); return original(sql, ...args); };
  assert.throws(() => h.sweep(), /synthetic cursor failure/);
  h.store.run = original;
  assert.equal(h.store.get('SELECT COUNT(*) n FROM partner_observations').n, 0);
  assert.equal(h.store.get('SELECT cursor FROM partner_watches WHERE thread_id=? AND source_ref=?', thread.thread_id, A).cursor, before);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='source.message'").n, 1);
  h.restart(); h.sweep(); assert.equal(h.detail(thread.thread_id).evidence.length, 1);
  noEffects(h);
});

test('new memory and cursors export/import; a four-migration bundle shape restores with empty continuity tables', async t => {
  const h = harness(t), thread = await h.open(); await h.ingest(); h.sweep();
  const accepted = await proposed(h, thread.thread_id); await review(h, accepted);
  const bundle = exportPartner(h.store);
  for (const legacy of [false, true]) {
    const data = structuredClone(bundle);
    if (legacy) {
      for (const table of [...CONTINUITY_TABLES, ...EXECUTIVE_TABLES, ...ACTION_TABLES, ...OUTCOME_TABLES, ...WORK_TABLES, ...CONTROL_TABLES, ...SCOUT_TABLES]) delete data.tables[table];
      for (const row of data.tables.messages) { delete row.occurred_at; delete row.time_basis; }
      data.migrations = data.migrations.slice(0, 4); data.tables_sha256 = hash(JSON.stringify(data.tables));
    }
    const file = path.join(h.directory, `bundle-${legacy}.json`); fs.writeFileSync(file, JSON.stringify(data));
    const destination = path.join(ROOT, 'exports', `continuity-test-${id()}`);
    t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
    const result = spawnSync(process.execPath, ['scripts/import.mjs', file, destination], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const store = new Store(path.join(destination, 'data'));
    try {
      assert.deepEqual(store.all('PRAGMA foreign_key_check'), []);
      if (!legacy) {
        const service = new BusinessService(store, h.config);
        assert.equal(service.continuity.detail(thread.thread_id).memory.turn_id, accepted.id);
        assert.equal(service.continuity.detail(thread.thread_id).attention.pending, false);
      } else assert.equal(store.get('SELECT COUNT(*) n FROM partner_threads').n, 0);
    } finally { store.close(); }
  }
  noEffects(h);
});

test('owner input resumes deliberation without becoming verified evidence or expanding the watch scope', async t => {
  const h = harness(t), thread = await h.open(); await h.ingest(); h.sweep();
  const turn = await proposed(h, thread.thread_id, { next: { kind: 'ask_owner', reason: 'The success criterion needs clarification.',
    wake_at: null, owner_question: 'Which requirement matters most?' } });
  await review(h, turn);
  const before = h.detail(thread.thread_id);
  const note = { thread_id: before.id, expected_revision: before.revision, text: 'Compare the time requirement first.' };
  const request = id();
  await h.command('continuity.note', note, request);
  await h.command('continuity.note', note, request);
  const d = h.detail(thread.thread_id);
  assert.ok(d.attention.reasons.includes('owner_input'));
  assert.equal(d.operator_notes.length, 1);
  assert.equal(d.operator_notes[0].kind, 'operator_guidance_not_source_fact');
  assert.deepEqual(d.watches.map(w => w.source_ref), before.watches.map(w => w.source_ref));
  const next = await proposed(h, thread.thread_id);
  assert.notEqual(next.id, turn.id);
  await assert.rejects(h.command('continuity.note', { ...note, expected_revision: d.revision, permission: true }));
  noEffects(h);
});

test('window eviction is explicit, keeps accepted dependencies auditable, and refuses overfull initial selections', async t => {
  const h = harness(t), thread = await h.open({ source_ids: [A] }); await h.ingest(); h.sweep();
  await review(h, await proposed(h, thread.thread_id));
  const initial = [];
  for (let i = 0; i < 12; i++) initial.push((await h.ingest({ message_id: `later:${i}` })).source_event_id);
  h.sweep();
  const d = h.detail(thread.thread_id);
  assert.equal(d.evidence.length, 8);
  assert.equal(d.coverage.selection, 'bounded_recent_window_not_complete_history');
  assert.equal(d.memory.current, true, 'window eviction is not deletion of the original evidence');
  assert.equal(d.memory_evidence.length, 1, 'retained understanding must keep its current support available for new reasoning');
  const captured = await h.capture(d.id), turn = h.service.continuity.turn(captured.turn_id);
  const next = output(turn.packet);
  next.summary.evidence_event_ids = [d.memory_evidence[0].source_event_id];
  await h.command('continuity.propose', { turn_id: turn.id, output: next });
  await review(h, h.service.continuity.turn(turn.id));
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='source.message'").n, 13);
  await assert.rejects(h.open({ source_ids: [A], initial_evidence_event_ids: initial }), { code: 'CONTINUITY_INITIAL_WINDOW_EXCEEDED' });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM partner_threads').n, 1);
  noEffects(h);
});

test('rejecting expired reasoning does not swallow the pending expiry attention', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-27T12:00:00.000Z') });
  const h = harness(t), thread = await h.open({ max_age_seconds: 60 }); await h.ingest(); h.sweep();
  const turn = await proposed(h, thread.thread_id);
  t.mock.timers.tick(60001);
  await assert.rejects(review(h, turn), { code: 'CONTINUITY_STALE_BASIS' });
  await review(h, turn, 'reject'); h.sweep();
  assert.ok(h.detail(thread.thread_id).attention.reasons.includes('evidence_state_changed'));
  noEffects(h);
});

test('model tool transcripts, invalid envelopes and raw provider errors are not persisted or retried', async t => {
  for (const variant of ['tools', 'bad_tools_shape', 'provider_error']) {
    const h = harness(t); enableModelFixture(t, h);
    await h.open(); await h.ingest(); h.sweep();
    const secret = 'synthetic-provider-secret-must-not-be-stored'; let calls = 0;
    const runtime = { async decide(_run, ctx) {
      calls++;
      if (variant === 'provider_error') throw new Error(secret);
      return { ...modelResult(ctx.packet), tool_calls: variant === 'tools' ? [{ name: secret }] : { name: secret } };
    } };
    assert.equal((await processContinuity(h.service, runtime)).disposition, 'model_failed');
    await processContinuity(h.service, runtime); assert.equal(calls, 1);
    assert.equal(JSON.stringify(exportPartner(h.store)).includes(secret), false);
    assert.equal(h.store.get('SELECT output_json FROM partner_turns').output_json, null);
    noEffects(h);
  }
});

test('real offline Telegram and browser adapters feed one question; a Telegram restart cannot revive a captured basis', async t => {
  const h = harness(t), telegram = 'telegram:channel:100', browser = 'browser:continuity';
  h.config.opportunity.allowedSourceRefs = [telegram, browser];
  h.config.opportunity.telegramSources = [{ sourceId: telegram, accountId: '999', channelId: '100',
    sourceKind: 'sanitized_fixture', processingBasis: 'Offline fixture', maxLagSeconds: 120 }];
  h.config.opportunity.browserSources = [{ sourceId: browser, url: 'https://example.com/offer', maxLagSeconds: 900,
    pollEverySeconds: 300, processingBasis: 'Offline fixture', sourceKind: 'live_snapshot' }];
  const thread = await h.open({ source_ids: [telegram, browser] });
  await bootstrapTelegramSource(h.service, telegram, { pts: 10, history: [] });
  await applyTelegramDifference(h.service, telegram, { kind: 'difference', account_id: '999', channel_id: '100',
    from_pts: 10, to_pts: 11, final: true, updates: [{ kind: 'new', channel_id: '100', pts: 11, pts_count: 1,
      message: { id: 1, channel_id: '100', from_id: { kind: 'user', id: '10' }, post: false, text: 'How much time is needed?', date: 1767225600 } }] });
  await pollBrowserSource(h.service, browser, { async readPage() { return { text: raw().text, truncated: false }; } });
  h.sweep();
  const d = h.detail(thread.thread_id);
  assert.equal(d.evidence.length, 2);
  const turn = await proposed(h, thread.thread_id);
  assert.deepEqual(new Set(turn.packet.evidence.map(e => e.source_ref)), new Set([telegram, browser]));
  h.restart();
  await assert.rejects(review(h, turn), { code: 'CONTINUITY_STALE_BASIS' });
  assert.equal(h.detail(thread.thread_id).watches.find(w => w.source_ref === telegram).health.reason, 'SOURCE_TRANSPORT_NOT_CURRENT');
  assert.equal(h.detail(thread.thread_id).memory, null);
  noEffects(h);
});

test('a derived continuity failure cannot stop the actual scheduler from ingesting source truth', async t => {
  const h = harness(t), browser = 'browser:continuity';
  h.config.opportunity.allowedSourceRefs = [browser];
  h.config.opportunity.browserSources = [{ sourceId: browser, url: 'https://example.com/offer', maxLagSeconds: 900,
    pollEverySeconds: 300, processingBasis: 'Offline fixture', sourceKind: 'live_snapshot' }];
  await h.open({ source_ids: [browser] });
  h.service.continuity.reconcile = () => { throw new Error('synthetic derived failure'); };
  let reads = 0;
  const scheduler = new Scheduler(h.service, { async decide() { assert.fail('Model disabled'); } }, {},
    [{ sourceId: browser, transport: { async readPage() { reads++; return { text: raw().text, truncated: false }; } } }]);
  await scheduler.tick();
  assert.equal(reads, 1);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='source.message'").n, 1);
  assert.equal(scheduler.status().continuity.disposition, 'reconciliation_failed');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM partner_observations').n, 0);
  noEffects(h);
});

test('real authenticated HTTP surface supports capture, proposal and review while unauthorized reads fail', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-continuity-http-'));
  const config = readJson(path.join(ROOT, 'config/default.json'));
  config.server.port = 0; config.scheduler.enabled = false;
  config.continuity = { enabled: true, modelEnabled: false };
  config.opportunity = { ...config.opportunity, automatic: true, allowedSourceRefs: [A] };
  const app = await start({ config, directory });
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  let token;
  // The Host header has to carry the port the server is actually listening on. With `port: 0` the
  // kernel picks one, and the check binds to that rather than to the configured `0` — so a header
  // that hard-codes `:0` names a host the server did not serve.
  const listeningPort = app.server.address().port;
  const request = (route, body, authenticated = true) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: listeningPort, path: route,
      method: body ? 'POST' : 'GET', headers: { host: `127.0.0.1:${listeningPort}`, 'content-type': 'application/json',
        ...(authenticated && token ? { 'x-partner-token': token } : {}) } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  assert.equal((await request('/api/continuity/threads')).status, 403);
  token = (await request('/api/session')).body.token;
  const command = async (action, payload) => {
    const response = await request('/api/commands', { action, payload, request_id: id() });
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
  };
  const thread = await command('continuity.open', { title: 'HTTP fixture', objective: 'Understand a bounded public statement.',
    success_condition: 'Owner sees the uncertainty.', source_ids: [A] });
  await command('source.ingest', raw());
  await app.service.exclusive(() => app.service.continuity.reconcile());
  const detail = (await request(`/api/continuity/threads/${thread.thread_id}`)).body;
  const captured = await command('continuity.capture', { thread_id: detail.id, expected_revision: detail.revision,
    expected_basis_fingerprint: detail.basis_fingerprint });
  const turn = (await request(`/api/continuity/turns/${captured.turn_id}`)).body;
  await command('continuity.propose', { turn_id: turn.id, output: output(turn.packet) });
  assert.equal((await request(`/api/continuity/turns/${turn.id}`)).body.reviewable, true);
  await command('continuity.review', { turn_id: turn.id, expected_basis_fingerprint: turn.basis_fingerprint, decision: 'accept', note: 'Offline HTTP review' });
  assert.equal((await request(`/api/continuity/threads/${detail.id}`)).body.memory.epistemic_status, 'unverified_interpretation');
  assert.equal((await request('/api/continuity/threads?limit=1&limit=2')).status, 400);
  assert.equal((await request('/api/continuity/threads?unknown=1')).status, 400);
  noEffects({ store: app.store });
});

test('result persistence failure rolls back the whole proposal and leaves an interrupted, non-retryable attempt', async t => {
  const h = harness(t); enableModelFixture(t, h);
  await h.open(); await h.ingest(); h.sweep();
  const original = h.store.event.bind(h.store);
  h.store.event = (...args) => { if (args[2] === 'continuity.proposed') throw new Error('synthetic result write failure'); return original(...args); };
  try {
    await assert.rejects(processContinuity(h.service, { async decide(_run, ctx) { return modelResult(ctx.packet); } }), /synthetic result write failure/);
  } finally { h.store.event = original; }
  assert.equal(h.store.get('SELECT status FROM partner_turns').status, 'interrupted');
  assert.equal(h.store.get('SELECT output_json FROM partner_turns').output_json, null);
  assert.equal(h.store.get('SELECT cost_status FROM runs').cost_status, 'unknown');
  noEffects(h);
});

test('an actual four-migration SQLite database upgrades in place without rewriting its source or mission', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-continuity-upgrade-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(directory, 'partner.sqlite'));
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for (const version of fs.readdirSync(path.join(ROOT, 'business/migrations')).filter(f => f.endsWith('.sql')).sort().slice(0, 4)) {
    const sql = fs.readFileSync(path.join(ROOT, 'business/migrations', version), 'utf8'); db.exec(sql);
    db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(version, hash(sql), '2026-09-01T00:00:00.000Z');
  }
  db.prepare('INSERT INTO partners VALUES(?,?,?,?,?)').run('partner-001', 'Baseline fixture', 'Original baseline mission', 'v1', '2026-09-01T00:00:00.000Z');
  db.prepare('INSERT INTO events(partner_id,kind,actor,payload_json,created_at) VALUES(?,?,?,?,?)')
    .run('partner-001', 'source.message', 'system', JSON.stringify(raw()), '2026-09-01T00:00:00.000Z');
  const before = db.prepare('SELECT * FROM events').all(); db.close();
  const store = new Store(directory);
  try {
    assert.deepEqual(store.all('SELECT * FROM events'), before);
    assert.equal(store.get('SELECT mission FROM partners').mission, 'Original baseline mission');
    assert.equal(store.all('SELECT * FROM schema_migrations').length, 11);
    assert.deepEqual(store.all('PRAGMA foreign_key_check'), []);
    noEffects({ store });
    for (const table of CONTINUITY_TABLES) assert.equal(store.get(`SELECT COUNT(*) n FROM ${table}`).n, 0);
  } finally { store.close(); }
});
