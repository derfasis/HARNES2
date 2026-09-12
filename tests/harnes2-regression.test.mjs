import test, { before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Socket } from 'node:net';
import { Store, TABLES, id, hash } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { ROOT, readJson, loadConfig, runtimeReadiness } from '../business/config.mjs';
import { contextFor, compactPromptContext, searchExperience } from '../business/context.mjs';
import { toolDefinitions, callTool } from '../business/tools.mjs';
import { Scheduler } from '../business/scheduler.mjs';
import { HermesAdapter } from '../business/runtime.mjs';
import { TelegramChannel } from '../business/channels/telegram.mjs';
import { MtprotoTelegramChannel } from '../business/channels/telegram-mtproto.mjs';
import { exportPartner } from '../business/export.mjs';
import { buildRouterContext } from '../business/situation-router.mjs';
import { buildOpportunityContext, parseOpportunityOutput } from '../business/opportunity-projection.mjs';

let blockedFetch, blockedSpawn, blockedSocket;
before(() => {
  const fail = () => { throw new Error('External execution is forbidden in offline regression'); };
  blockedFetch = mock.method(globalThis, 'fetch', fail);
  blockedSpawn = mock.method(childProcess, 'spawn', fail);
  blockedSocket = mock.method(Socket.prototype, 'connect', fail);
  syncBuiltinESMExports();
});
after(() => {
  assert.equal(blockedFetch.mock.callCount(), 0);
  assert.equal(blockedSpawn.mock.callCount(), 0);
  assert.equal(blockedSocket.mock.callCount(), 0);
  mock.restoreAll();
  syncBuiltinESMExports();
});

function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-regression-'));
  const store = new Store(directory);
  t.after(() => {
    store.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('harnes2-regression-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const config = readJson(path.join(ROOT, 'config/default.json'));
  const service = new BusinessService(store, config);
  const command = (action, payload, actor, requestId = id()) => service.command(action, payload, requestId, actor);
  const person = (extra = {}) => command('person.create', {
    name: 'Synthetic regression contact', source: 'invented offline fixture', permission: 'invented inbound request', ...extra,
  });
  const inbound = (conversation_id, text = 'A synthetic question', extra = {}) => command('message.record', {
    conversation_id, text, direction: 'in', source: 'invented offline fixture', ...extra,
  });
  const draft = (conversation_id, extra = {}, actor) => command('draft.create', {
    conversation_id, text: 'Synthetic pending draft', reason: 'offline regression', ...extra,
  }, actor);
  return { store, config, service, command, person, inbound, draft };
}

function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

function running(h, conversationId = null, extra = {}) {
  const runId = id();
  const context = conversationId ? { conversation: h.service.conversation(conversationId) } : {};
  h.store.run('INSERT INTO runs(id,partner_id,conversation_id,status,runtime,model,context_json,created_at) VALUES(?,?,?,?,?,?,?,?)',
    runId, h.config.partnerId, conversationId, 'running', 'hermes', 'invented-model', JSON.stringify(context), new Date().toISOString());
  if (extra.cost_status) h.store.run('UPDATE runs SET cost_status=? WHERE id=?', extra.cost_status, runId);
  return { kind: 'agent', runId, conversationId };
}

test('existing Store migrations, foreign keys and transaction rollback', t => {
  const { store } = harness(t);
  assert.equal(store.all('SELECT * FROM schema_migrations').length, 2);
  assert.deepEqual(store.all('PRAGMA foreign_key_check'), []);
  assert.throws(() => store.transaction(() => {
    store.run('UPDATE partners SET mission=?', 'rolled back');
    throw new Error('rollback');
  }), /rollback/);
  assert.notEqual(store.get('SELECT mission FROM partners').mission, 'rolled back');
});

test('command receipts are idempotent and reject request ID collisions', async t => {
  const h = harness(t), requestId = id();
  const payload = { name: 'Synthetic', source: 'offline fixture' };
  const first = await h.command('person.create', payload, undefined, requestId);
  assert.deepEqual(await h.command('person.create', payload, undefined, requestId), first);
  await assert.rejects(h.command('person.create', { ...payload, name: 'Changed' }, undefined, requestId), { status: 409 });
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM persons').n, 1);
});

test('inbound recording deduplicates and queues one reply task', async t => {
  const h = harness(t), { conversation_id } = await h.person();
  const first = await h.inbound(conversation_id, 'Question', { external_id: 'synthetic-1' });
  const duplicate = await h.inbound(conversation_id, 'Question', { external_id: 'synthetic-1' });
  assert.equal(duplicate.message_id, first.message_id);
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM tasks').n, 1);
  await assert.rejects(h.inbound(conversation_id, 'Changed', { external_id: 'synthetic-1' }), { status: 409 });
});

test('draft creation is neither approval nor delivery', async t => {
  const h = harness(t), { conversation_id } = await h.person();
  const created = await h.draft(conversation_id);
  assert.equal(h.service.draft(created.draft_id).status, 'pending');
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM approvals').n, 0);
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM delivery_attempts').n, 0);
  await assert.rejects(h.command('delivery.manual', { draft_id: created.draft_id, evidence: 'invented receipt' }), { status: 409 });
});

test('editing an approved draft invalidates approval for the new version', async t => {
  const h = harness(t), { conversation_id } = await h.person();
  const { draft_id } = await h.draft(conversation_id);
  const approved = await h.command('draft.approve', { draft_id });
  assert.equal(approved.sent, false);
  assert.equal(h.service.validApproved(draft_id).current_version, 1);
  await h.command('draft.edit', { draft_id, text: 'New synthetic version' });
  assert.equal(h.service.draft(draft_id).current_version, 2);
  assert.throws(() => h.service.validApproved(draft_id), { status: 409 });
  await h.command('draft.approve', { draft_id });
  assert.equal(h.service.validApproved(draft_id).current_version, 2);
});

test('new inbound context makes an existing approval stale', async t => {
  const h = harness(t), { conversation_id } = await h.person();
  const { draft_id } = await h.draft(conversation_id);
  await h.command('draft.approve', { draft_id });
  await h.inbound(conversation_id);
  assert.equal(h.service.draft(draft_id).status, 'stale');
  assert.throws(() => h.service.validApproved(draft_id), { status: 409 });
});

test('missing permission prevents owner approval', async t => {
  const h = harness(t), { conversation_id } = await h.person({ permission: '' });
  const { draft_id } = await h.draft(conversation_id);
  await assert.rejects(h.command('draft.approve', { draft_id }), { code: 'permission_required' });
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM approvals').n, 0);
});

test('agent cannot approve, record outcomes, resume suppression or take ownership', async t => {
  const h = harness(t), { conversation_id } = await h.person();
  const { draft_id } = await h.draft(conversation_id), actor = running(h, conversation_id);
  for (const action of ['draft.approve', 'outcome.record', 'person.resume', 'conversation.release']) {
    await assert.rejects(h.command(action, { conversation_id, draft_id, evidence: 'invented' }, actor), { status: 403 });
  }
});

test('explicit refusal suppresses contact and cancels queued tasks', async t => {
  const h = harness(t), contact = await h.person();
  await h.inbound(contact.conversation_id);
  const { draft_id } = await h.draft(contact.conversation_id);
  await h.inbound(contact.conversation_id, 'Do not contact me');
  assert.equal(h.service.person(contact.person_id).suppressed, 1);
  assert.equal(h.service.draft(draft_id).status, 'stale');
  assert.ok(h.store.all('SELECT status FROM tasks').every(task => task.status === 'cancelled'));
  await assert.rejects(h.draft(contact.conversation_id), { code: 'suppressed' });
});

test('human takeover blocks agent drafting and cancels tasks', async t => {
  const h = harness(t), { conversation_id } = await h.person();
  await h.inbound(conversation_id);
  await h.command('conversation.takeover', { conversation_id });
  await assert.rejects(h.draft(conversation_id), { code: 'human_owned' });
  assert.equal(h.store.get('SELECT status FROM tasks').status, 'cancelled');
});

test('restart recovery preserves unknown delivery without a retry or sent message', async t => {
  const h = harness(t), { conversation_id } = await h.person();
  const { draft_id } = await h.draft(conversation_id);
  await h.command('draft.approve', { draft_id });
  h.store.run("UPDATE drafts SET status='sending' WHERE id=?", draft_id);
  h.store.run('INSERT INTO delivery_attempts(id,draft_id,draft_version,channel,recipient,status,created_at) VALUES(?,?,?,?,?,?,?)',
    id(), draft_id, 1, 'telegram', 'invented-recipient', 'sending', new Date().toISOString());
  running(h, conversation_id);
  h.store.recover();
  assert.equal(h.service.draft(draft_id).status, 'delivery_unknown');
  assert.equal(h.store.get('SELECT status FROM delivery_attempts').status, 'delivery_unknown');
  assert.equal(h.store.get('SELECT status FROM runs').status, 'interrupted');
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM messages WHERE direction='out'").n, 0);
  assert.throws(() => h.service.validApproved(draft_id), { status: 409 });
});

test('manual delivery needs approval and does not invent attendance', async t => {
  const h = harness(t), { conversation_id } = await h.person();
  const { draft_id } = await h.draft(conversation_id, { action: 'propose_call' });
  await h.command('draft.approve', { draft_id });
  await h.command('delivery.manual', { draft_id, evidence: 'Synthetic manual receipt' });
  assert.equal(h.service.draft(draft_id).status, 'sent');
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM messages WHERE direction='out'").n, 1);
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM outcome_events').n, 0);
  await h.command('outcome.record', { conversation_id, kind: 'call_accepted', evidence: 'Synthetic acceptance' });
  assert.equal(h.service.metrics().call_accepted, 1);
  assert.equal(h.service.metrics().call_attended, undefined);
});

test('fact sources cannot cross conversations and candidate facts stay out of context', async t => {
  const h = harness(t), first = await h.person(), second = await h.person();
  const message = await h.inbound(second.conversation_id), actor = running(h, first.conversation_id);
  await assert.rejects(h.command('fact.propose', { conversation_id: first.conversation_id, text: 'Invented fact',
    source_ref: 'offline fixture', source_message_id: message.message_id }, actor));
  const candidate = await h.command('fact.propose', { conversation_id: first.conversation_id,
    text: 'Invented candidate fact', source_ref: 'offline fixture' }, actor);
  assert.equal(contextFor(h.service, first.conversation_id).facts.length, 0);
  await h.command('fact.review', { fact_id: candidate.fact_id, status: 'confirmed' });
  assert.equal(contextFor(h.service, first.conversation_id).facts.length, 1);
});

test('reviewed lessons are scoped to their conversation or explicitly general', async t => {
  const h = harness(t), first = await h.person(), second = await h.person();
  const add = async conversation_id => {
    const { lesson_id } = await h.command('lesson.propose', { conversation_id, title: 'Synthetic lesson',
      text: 'Synthetic knowledge', applicability: 'offline regression', evidence: 'invented fixture' });
    await h.command('lesson.review', { lesson_id, status: 'active' });
    return lesson_id;
  };
  const privateId = await add(first.conversation_id), generalId = await add(null);
  const own = searchExperience(h.service, '', first.conversation_id).map(lesson => lesson.id);
  assert.deepEqual(new Set(own), new Set([privateId, generalId]));
  assert.deepEqual(searchExperience(h.service, '', second.conversation_id).map(lesson => lesson.id), [generalId]);
});

test('Conversation Brain context remains bounded, scoped and compacted with asset hashes', async t => {
  const h = harness(t), first = await h.person(), second = await h.person();
  await h.inbound(first.conversation_id, 'x'.repeat(200));
  await h.inbound(first.conversation_id, 'y'.repeat(200));
  await h.inbound(second.conversation_id, 'Another person private message');
  h.config.context.maxRecentMessages = 1; h.config.context.maxMessageCharacters = 100;
  const context = contextFor(h.service, first.conversation_id), compact = compactPromptContext(context);
  assert.equal(context.messages.length, 1);
  assert.equal(context.messages[0].text, 'y'.repeat(100));
  assert.equal(context.messages[0].truncated, true);
  assert.equal(compact.identity, undefined);
  assert.equal(compact.prompt_assets.identity.sha256, hash(context.identity));
  assert.ok(context.instructions.includes('Missing evidence is unknown, not permission'));
});

test('tools expose proposals, never send or approve capabilities, and enforce scope', async t => {
  const h = harness(t), first = await h.person(), second = await h.person();
  const actor = running(h, first.conversation_id);
  const names = toolDefinitions(actor).map(tool => tool.name);
  assert.ok(names.includes('partner_propose_draft'));
  assert.ok(names.every(name => !/send|approve|execute/i.test(name)));
  assert.ok(!toolDefinitions({}).some(tool => tool.name === 'partner_propose_draft'));
  await assert.rejects(callTool(h.service, actor, 'partner_send', {}, id()), { status: 403 });
  await assert.rejects(callTool(h.service, actor, 'partner_propose_task', {
    conversation_id: second.conversation_id, kind: 'research', title: 'Synthetic', instructions: 'Synthetic',
    due_at: new Date().toISOString(),
  }, id()), { status: 403 });
  const proposed = await callTool(h.service, actor, 'partner_propose_draft', { text: 'Tool draft', reason: 'offline' }, id());
  assert.equal(h.service.draft(proposed.draft_id).status, 'pending');
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM approvals').n, 0);
});

test('stale runs cannot create fresh drafts through business tools', async t => {
  const h = harness(t), { conversation_id } = await h.person(), actor = running(h, conversation_id);
  await h.inbound(conversation_id);
  await assert.rejects(callTool(h.service, actor, 'partner_propose_draft', { text: 'Stale', reason: 'offline' }, id()), { code: 'stale_context' });
});

test('proposed tasks require owner review and follow-ups require evidence', async t => {
  const h = harness(t), { conversation_id } = await h.person(), actor = running(h, conversation_id);
  const payload = { conversation_id, kind: 'follow_up', title: 'Synthetic', instructions: 'Synthetic', due_at: new Date().toISOString() };
  await assert.rejects(h.command('task.propose', payload, actor));
  const { task_id } = await h.command('task.propose', { ...payload, evidence: 'Synthetic explicit agreement' }, actor);
  assert.equal(h.store.get('SELECT status FROM tasks WHERE id=?', task_id).status, 'proposed');
  await h.command('task.approve', { task_id });
  assert.equal(h.store.get('SELECT status FROM tasks WHERE id=?', task_id).status, 'pending');
});

test('runtime disabled leaves queued work untouched and calls no adapter or Telegram', async t => {
  const h = harness(t), { conversation_id } = await h.person();
  await h.inbound(conversation_id);
  const never = () => { throw new Error('Runtime or Telegram must not be invoked'); };
  const scheduler = new Scheduler(h.service, { run: never }, { readiness: never, sendApproved: never });
  await scheduler.tick();
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM runs').n, 0);
  assert.equal(h.store.get('SELECT status FROM tasks').status, 'pending');
  assert.equal(runtimeReadiness(h.config).ready, false);
});

test('unknown cost pauses the queue, never treating an unknown estimate as zero', async t => {
  const h = harness(t);
  environment(t, { PARTNER_MODEL_API_KEY: 'invented-regression-key' });
  Object.assign(h.config.runtime, { enabled: true, model: 'invented-model', baseUrl: 'https://invalid.example/v1' });
  running(h, null, { cost_status: 'unknown' });
  const scheduler = new Scheduler(h.service, { run: () => { throw new Error('No runtime call permitted'); } });
  await scheduler.tick();
  assert.ok(scheduler.lastReason.includes('неизвестна'));
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM runs').n, 1);
});

test('stubbed worker result preserves usage and does not automatically approve or send', async t => {
  const h = harness(t), { conversation_id } = await h.person();
  await h.inbound(conversation_id);
  environment(t, { PARTNER_MODEL_API_KEY: 'invented-regression-key' });
  Object.assign(h.config.runtime, { enabled: true, model: 'invented-model', baseUrl: 'https://invalid.example/v1' });
  let turns = 0, sends = 0;
  const runtime = { run: async run => {
    turns++;
    await h.draft(conversation_id, {}, { kind: 'agent', runId: run.id, conversationId: conversation_id });
    return { completed: true, usage: { input_tokens: 10, output_tokens: 5, cost_status: 'unknown' } };
  } };
  const telegram = { readiness: () => ({ enabled: false, live_sending: false }), sendApproved: () => { sends++; } };
  await new Scheduler(h.service, runtime, telegram).tick();
  assert.equal(turns, 1); assert.equal(sends, 0);
  assert.equal(h.store.get('SELECT status FROM tasks').status, 'done');
  assert.equal(h.store.get('SELECT cost_status FROM runs').cost_status, 'unknown');
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM approvals').n, 0);
});

test('Telegram transports remain disabled and cannot perform delivery', async t => {
  const h = harness(t), bot = new TelegramChannel(h.service), mtproto = new MtprotoTelegramChannel(h.service);
  const api = t.mock.method(bot, 'api', () => { throw new Error('Telegram API forbidden'); });
  const connect = t.mock.method(mtproto, 'connect', () => { throw new Error('MTProto connect forbidden'); });
  await bot.poll(); mtproto.start();
  await assert.rejects(bot.sendApproved('invented-draft'), { status: 409 });
  await assert.rejects(mtproto.sendApproved('invented-draft'), { status: 409 });
  assert.equal(api.mock.callCount(), 0); assert.equal(connect.mock.callCount(), 0);
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM delivery_attempts').n, 0);
});

test('Hermes adapter isolates credentials and cleans tokens using a fake child only', async t => {
  const h = harness(t), tokens = new Map();
  environment(t, { PARTNER_MODEL_API_KEY: 'invented-primary', PARTNER_MODEL_API_KEY_SECONDARY: 'invented-secondary',
    PARTNER_MODEL_API_KEY_TERTIARY: 'invented-tertiary', PARTNER_TELEGRAM_BOT_TOKEN: '123:invented',
    OPENAI_API_KEY: 'invented-ambient', HERMES_HOME: 'invented-home' });
  let options, envelope;
  const fake = new EventEmitter();
  fake.stdin = new PassThrough(); fake.stdout = new PassThrough(); fake.stderr = new PassThrough(); fake.kill = () => {};
  let stdin = '';
  fake.stdin.on('data', chunk => { stdin += chunk; });
  fake.stdin.on('finish', () => {
    envelope = JSON.parse(stdin);
    queueMicrotask(() => { fake.stdout.write(JSON.stringify({ completed: true })); fake.emit('close', 0); });
  });
  const spawn = t.mock.method(childProcess, 'spawn', (_executable, _args, cfg) => { options = cfg; return fake; });
  syncBuiltinESMExports();
  try {
    const adapter = new HermesAdapter(h.service, tokens);
    assert.deepEqual(await adapter.run({ id: 'invented-run', conversation_id: null }, {}), { completed: true });
    assert.equal(spawn.mock.callCount(), 1);
    assert.equal(options.env.PARTNER_MODEL_API_KEY_TERTIARY, 'invented-tertiary');
    assert.equal(options.env.PARTNER_MODEL_API_KEY_SECONDARY, 'invented-secondary');
    for (const key of ['PARTNER_TELEGRAM_BOT_TOKEN', 'OPENAI_API_KEY', 'HERMES_HOME']) assert.equal(options.env[key], undefined);
    assert.ok(envelope.tools.every(tool => !/send|approve|execute/i.test(tool.name)));
    assert.equal(tokens.size, 0); assert.equal(adapter.children.size, 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('exports preserve existing business evidence without secrets or runtime assets', async t => {
  const h = harness(t);
  await h.person();
  const bundle = exportPartner(h.store);
  assert.deepEqual(Object.keys(bundle.tables), TABLES);
  assert.equal(bundle.tables.persons.length, 1);
  assert.equal(bundle.tables_sha256, hash(JSON.stringify(bundle.tables)));
  assert.ok(bundle.assets.every(asset => asset.path.startsWith('partner/') && asset.sha256 === hash(asset.content)));
  assert.ok(bundle.excluded.includes('secrets'));
});

test('all tracked frozen Router fixtures build through unchanged v1 primitives offline', () => {
  const directory = path.join(ROOT, 'benchmarks/situation-router/synthetic');
  const files = fs.readdirSync(directory).filter(file => file.endsWith('.json'));
  assert.equal(files.length, 5);
  for (const file of files) assert.equal(buildRouterContext(readJson(path.join(directory, file))).contract, 'situation-router-v1');
});

test('Opportunity projection is not a business approval, tool or autopilot candidate', async t => {
  const h = harness(t);
  h.config.telegram.allowedChatIds = ['123456'];
  h.service.setTelegramAccount('invented-account');
  const { conversation_id } = await h.person({ channel: 'telegram', external_id: '123456', account_id: 'invented-account' });
  await h.inbound(conversation_id);
  await h.command('conversation.mode', { conversation_id, mode: 'AUTOPILOT' });
  const actor = running(h, conversation_id);
  const fixture = readJson(path.join(ROOT, 'benchmarks/opportunity-projection-v0/case-01.json'));
  const context = buildOpportunityContext(fixture, { allowedSourceRefs: [fixture.source.ref] });
  const before = exportPartner(h.store).tables;
  const message = context.input.message;
  const output = parseOpportunityOutput({
    contract_version: 'opportunity-projection-v0', situation_id: fixture.situation_id,
    opportunity: { hypothesis: 'Synthetic offer might explain the explicit question.', evidence: [{
      message_id: message.id, author_id: message.author_id, version: 2, span: message.text,
      kind: 'question', attribution: 'author_statement',
    }], contradictions: [], unknowns: ['No contact permission is supplied.'] },
    next_action: { schema_version: 1, situation_id: fixture.situation_id, decision: 'PUBLIC_REPLY', confidence: 0.9,
      strategy: 'Synthetic reviewed answer', reason: 'Explicit question', evidence_message_ids: [message.id],
      unknowns: [], risk_flags: [], draft: { channel: 'public', action: 'reply', target_id: message.author_id,
        text: 'Synthetic draft', source_message_ids: [message.id] },
      review: { required: true, status: 'pending', authorization: 'none' }, reevaluate_after: null },
    authority: { contact_permission: false, allowed_effects: [] },
  }, context);
  assert.deepEqual(exportPartner(h.store).tables, before);
  assert.deepEqual(h.service.autopilotCandidates(actor.runId), []);
  await assert.rejects(h.command('opportunity.approve', { conversation_id, projection: output }));
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM approvals').n, 0);
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM drafts').n, 0);
});

test('working local configuration retains disabled runtime and Telegram', () => {
  const config = loadConfig();
  assert.equal(config.runtime.enabled, false);
  assert.equal(config.telegram.enabled, false);
  assert.equal(config.telegram.liveSending, false);
});
