import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, id } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { ROOT, readJson } from '../business/config.mjs';
import { callTool, toolDefinitions } from '../business/tools.mjs';
import { OwnerChat, OWNER_CHAT_RUNTIME } from '../business/owner-chat.mjs';
import { loadPartnerKnowledge } from '../business/knowledge.mjs';
import { start } from '../business/server.mjs';

// The scope the service gives the owner's chat gateway (Hermes) for its connection token.
const GATEWAY = Object.freeze({ kind: 'agent', conversationId: null, ownerChat: true });
const inDays = days => new Date(Date.now() + days * 86400000).toISOString();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(predicate, label) { for (let i = 0; i < 400; i++) { if (predicate()) return; await pause(5); } assert.fail(`never happened: ${label}`); }

function harness(t, { control = false, chat } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-owner-chat-'));
  const store = new Store(directory), config = readJson(path.join(ROOT, 'config/default.json'));
  const service = new BusinessService(store, config);
  if (chat) service.ownerChat = new OwnerChat(service, chat);
  if (control) { config.controlPlane.enabled = true; config.runtime.enabled = true; service.control.acquireProcess(); }
  t.after(async () => {
    await service.ownerChat.close();
    if (control) { service.control.close(); service.control.releaseProcess(); }
    store.close(); fs.rmSync(directory, { recursive: true, force: true });
  });
  const tool = (name, args, requestId = id()) => callTool(service, GATEWAY, name, args, requestId);
  return { directory, store, config, service, chat: service.ownerChat, tool,
    expect: (extra = {}) => tool('partner_notebook_expect', { title: 'Разбор роли партнёра в канале', move: 'Публикую короткий разбор: что делает партнёр и чем помогает команда.',
      expectation: 'Жду хотя бы два содержательных вопроса за три дня.', check_at: inDays(3), ...extra }),
    runs: () => store.all("SELECT * FROM runs WHERE runtime=? ORDER BY created_at,rowid", OWNER_CHAT_RUNTIME),
    tickets: () => store.all("SELECT * FROM control_tickets ORDER BY created_at,rowid"),
    journal: () => service.notebook.load('journal').entries };
}

test('outside a chat turn the gateway may look at the desk but cannot write', async t => {
  const h = harness(t, { control: true });
  // The chat sees the same general tools as a desk run of the partner, nothing conversation-bound.
  const names = toolDefinitions(GATEWAY).map(tool => tool.name);
  for (const name of ['partner_get_context', 'partner_list_work', 'partner_notebook_expect', 'partner_notebook_answer', 'partner_propose_task']) assert.ok(names.includes(name), name);
  for (const name of ['partner_propose_draft', 'partner_propose_fact', 'partner_commit_decision']) assert.equal(names.includes(name), false, name);

  const context = await h.tool('partner_get_context', {});
  assert.equal(context.partner.activeOffer, 'yovi-prelaunch');
  // A desk run is told that its final text is an internal note; in chat the owner reads the answer.
  assert.match(context.instructions, /для разговора с владельцем/); assert.doesNotMatch(context.instructions, /internal note/);
  assert.deepEqual(await h.tool('partner_list_work', {}), []);
  await assert.rejects(h.expect(), { status: 403, code: 'OWNER_CHAT_TURN_REQUIRED' });
  await assert.rejects(h.tool('partner_propose_task', { kind: 'research', title: 'Найти каналы', instructions: 'Посмотреть, где спрашивают сами.', due_at: inDays(1) }), { status: 403, code: 'OWNER_CHAT_TURN_REQUIRED' });
  assert.deepEqual(h.runs(), []); assert.deepEqual(h.tickets(), []); assert.deepEqual(h.journal(), []);
  // Reading left no run behind either: a look is not a run.
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM runs').n, 0);
});

test('one chat turn is one run of the partner: writes share it, the end closes it, an outcome needs a later turn', async t => {
  const h = harness(t, { control: true });
  const opened = await h.chat.begin({ turn_id: 'turn-1', session_id: 'session-1' });
  assert.deepEqual(opened.sections.map(section => section.key), ['тетрадь', 'обстановка']);
  for (const section of opened.sections) { assert.ok(section.text.startsWith(`${section.marker}\n`)); assert.match(section.marker, /^\[рабочий стол · .+ · [a-f0-9]{12}\]$/); }
  // A turn that only talks admits nothing: no run, no ticket, the desk is free.
  assert.deepEqual(h.runs(), []); assert.deepEqual(h.tickets(), []);
  assert.deepEqual(h.chat.status(), { turn_open: true, writing: false, run_id: null });

  const first = await h.expect();
  assert.equal(first.entry_id, 'J-0001');
  const [run] = h.runs();
  assert.equal(run.status, 'running'); assert.equal(run.task_id, null); assert.equal(run.conversation_id, null);
  // The gateway made the model call, so this service neither knows its cost nor counts it as its own.
  assert.equal(run.cost_status, 'external'); assert.equal(run.estimated_cost_usd, null);
  assert.equal(JSON.parse(run.context_json).turn_id, 'turn-1');
  const [ticket] = h.tickets();
  assert.deepEqual([ticket.plane, ticket.operation, ticket.status, ticket.run_id], ['private', 'owner_chat', 'running', run.id]);
  assert.equal(h.journal()[0].meta.run_id, run.id);
  assert.deepEqual(h.chat.status(), { turn_open: true, writing: true, run_id: run.id });

  // The second write of the turn is the same run, and both are kept as its tool calls.
  await h.tool('partner_notebook_note', { op: 'add', title: 'Совет владельца про длину', source: 'владелец, чат', text: 'Разборы короче пяти абзацев читают чаще.', to_test: 'Сравнить короткий и длинный разбор.' });
  assert.equal(h.runs().length, 1); assert.equal(h.tickets().length, 1);
  assert.deepEqual(h.store.all('SELECT name FROM tool_calls WHERE run_id=? ORDER BY created_at,rowid', run.id).map(row => row.name), ['partner_notebook_expect', 'partner_notebook_note']);
  // What came of a move arrives from outside, so it cannot be written in the turn that opened it.
  await assert.rejects(h.tool('partner_notebook_result', { entry_id: 'J-0001', result: 'Два вопроса.', verdict: 'matched' }), { status: 409, code: 'NOTEBOOK_TOO_EARLY' });

  assert.deepEqual(await h.chat.end({ turn_id: 'turn-1' }), { turn_id: 'turn-1', closed: true, run_id: run.id });
  const closed = h.runs()[0];
  assert.equal(closed.status, 'completed'); assert.ok(closed.finished_at); assert.equal(closed.error, null);
  // The refused result is not among them: only what was actually written counts.
  assert.equal(JSON.parse(closed.result_json).tool_calls, 2);
  assert.equal(h.tickets()[0].status, 'completed');
  assert.deepEqual(h.chat.status(), { turn_open: false, writing: false, run_id: null });
  await assert.rejects(h.expect({ title: 'После закрытия хода' }), { status: 403, code: 'OWNER_CHAT_TURN_REQUIRED' });
  // Closing twice, or closing a turn that is not the open one, changes nothing.
  assert.deepEqual(await h.chat.end({ turn_id: 'turn-1' }), { turn_id: 'turn-1', closed: false, run_id: null });

  // The owner's next message is a new turn and a new run: now his words can close the entry.
  const next = await h.chat.begin({ turn_id: 'turn-2', session_id: 'session-1' });
  assert.notEqual(next.sections[0].marker, opened.sections[0].marker, 'the notebook changed, so its marker did');
  assert.match(next.sections[0].text, /J-0001/);
  const result = await h.tool('partner_notebook_result', { entry_id: 'J-0001', result: 'Владелец сообщил: пришло пять вопросов за два дня.', verdict: 'matched' });
  assert.equal(result.status, 'closed');
  const second = h.runs()[1];
  assert.notEqual(second.id, run.id); assert.equal(JSON.parse(second.context_json).turn_id, 'turn-2');
  await h.chat.end({ turn_id: 'turn-2' });
  assert.deepEqual(h.runs().map(row => row.status), ['completed', 'completed']);
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM control_tickets WHERE status IN ('reserved','running')").n, 0);
  // Chat runs are not model spending of this service: they are not shown as unknown bills.
  assert.equal(h.service.metrics().unknown_cost_runs, 0);
});

test('the stop-list and the daily allowance hold in chat exactly as at the desk', async t => {
  const h = harness(t, { control: true });
  await h.service.command('notebook.owner_stop', { op: 'add', title: 'Чаты взаимопиара', reason: 'Ноль вопросов за три дня.', patterns: ['чат взаимопиара'] }, id(), { kind: 'operator' });
  const opened = await h.chat.begin({ turn_id: 'turn-1' });
  assert.match(opened.sections[0].text, /Так больше не делаю/);
  await assert.rejects(h.expect({ move: 'Размещаю объявление в чате взаимопиара.' }), { status: 409, code: 'NOTEBOOK_STOPLIST' });
  await assert.rejects(h.tool('partner_propose_task', { kind: 'research', title: 'Пост в чат взаимопиара', instructions: 'Опубликовать объявление.', due_at: inDays(1) }), { status: 409, code: 'NOTEBOOK_STOPLIST' });
  // The owner's stop cannot be lifted from the chat by the partner.
  await assert.rejects(h.tool('partner_notebook_never', { op: 'retire', stop_id: 'S-0001', reason: 'Владелец настаивает.' }), { status: 403, code: 'NOTEBOOK_OWNER_LOCK' });

  // His own desk work goes straight to work within the allowance; beyond it the task waits for the owner.
  const own = n => h.tool('partner_propose_task', { kind: 'research', title: `Изучить каналы про wellness ${n}`, instructions: 'Найти площадки, где люди сами задают вопросы о партнёрских программах.', due_at: inDays(1) });
  const made = [];
  for (let n = 1; n <= h.config.autonomy.maxOwnTasksPerDay + 1; n++) made.push(await own(n));
  const statuses = made.map(task => h.store.get('SELECT status,author FROM tasks WHERE id=?', task.task_id));
  assert.deepEqual(statuses.map(task => task.status), [...Array(h.config.autonomy.maxOwnTasksPerDay).fill('pending'), 'proposed']);
  assert.ok(statuses.every(task => task.author === 'agent'));
  await h.chat.end({ turn_id: 'turn-1' });
  // Nothing in a chat turn reached a person: no draft, no conversation, no send.
  for (const table of ['drafts', 'delivery_attempts', 'persons', 'conversations']) assert.equal(h.store.get(`SELECT COUNT(*) AS n FROM ${table}`).n, 0, table);
});

test('the desk and the chat take turns on the private plane', async t => {
  const h = harness(t, { control: true, chat: { waitMs: 80, pollMs: 10 } });
  const gate = deferred(), desk = h.service.control.run('private', 'conversation', () => gate.promise);
  await until(() => h.tickets().length === 1, 'the desk run is admitted');
  await h.chat.begin({ turn_id: 'turn-1' });
  // The desk is busy: the chat waits a little, then says so instead of writing behind its back.
  await assert.rejects(h.expect(), { status: 409, code: 'OWNER_CHAT_BUSY' });
  assert.deepEqual(h.runs(), []); assert.deepEqual(h.journal(), []);
  gate.resolve(); await desk;
  // The same turn may try again once the desk is free.
  assert.equal((await h.expect()).entry_id, 'J-0001');
  // And while the chat is writing, the desk is told to come back later rather than run alongside.
  assert.equal((await h.service.control.run('private', 'conversation', () => assert.fail('the desk ran during a chat turn'))).disposition, 'CONTROL_CAPACITY');
  await h.chat.end({ turn_id: 'turn-1' });
  let ran = false; await h.service.control.run('private', 'conversation', () => { ran = true; });
  assert.equal(ran, true, 'the plane is free again after the turn');
});

test('a turn the gateway abandoned does not keep its run or the plane', async t => {
  const h = harness(t, { control: true, chat: { turnMs: 120 } });
  await h.chat.begin({ turn_id: 'turn-1' }); await h.expect();
  // The gateway never closed the turn (a crash, an interrupted reply): time closes it.
  await until(() => h.runs()[0].status !== 'running', 'the abandoned turn is closed');
  assert.equal(h.runs()[0].status, 'interrupted'); assert.match(h.runs()[0].error, /не был закрыт/);
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM control_tickets WHERE status IN ('reserved','running')").n, 0);
  assert.deepEqual(h.chat.status(), { turn_open: false, writing: false, run_id: null });
  // What he had written stays written; the notebook is not rolled back with the turn.
  assert.equal(h.journal().length, 1);

  // A new message while the previous turn is still open closes the previous one.
  h.service.ownerChat = new OwnerChat(h.service);
  await h.service.ownerChat.begin({ turn_id: 'turn-2' }); await h.expect({ title: 'Второй ход' });
  await h.service.ownerChat.begin({ turn_id: 'turn-3' });
  assert.deepEqual(h.runs().map(run => run.status), ['interrupted', 'interrupted']);
  await h.expect({ title: 'Третий ход' });
  assert.equal(h.runs().length, 3); assert.equal(JSON.parse(h.runs()[2].context_json).turn_id, 'turn-3');
  await h.service.ownerChat.end({ turn_id: 'turn-3' });
  assert.equal(h.runs()[2].status, 'completed');
});

test('a long turn stops writing when its window closes, and the desk gets the plane back', async t => {
  const h = harness(t, { control: true, chat: { windowMs: 60 } });
  await h.chat.begin({ turn_id: 'turn-1' }); await h.expect();
  await until(() => h.runs()[0].status === 'completed', 'the writing window closed');
  await assert.rejects(h.expect({ title: 'Позже в том же ходе' }), { status: 409, code: 'OWNER_CHAT_WINDOW_CLOSED' });
  assert.equal(h.runs().length, 1, 'a turn gets one run, not a second one after the window');
  let ran = false; await h.service.control.run('private', 'conversation', () => { ran = true; });
  assert.equal(ran, true);
  await h.chat.end({ turn_id: 'turn-1' });
});

test('without the control plane a chat write still needs a turn, a run and room in the day', async t => {
  const h = harness(t);
  await assert.rejects(h.expect(), { status: 403, code: 'OWNER_CHAT_TURN_REQUIRED' });
  await h.chat.begin({ turn_id: 'turn-1' });
  assert.equal((await h.expect()).entry_id, 'J-0001');
  assert.equal(h.runs()[0].status, 'running'); assert.deepEqual(h.tickets(), []);
  await h.chat.end({ turn_id: 'turn-1' });
  assert.equal(h.runs()[0].status, 'completed');

  h.config.runtime.maxRunsPerDay = 1;
  await h.chat.begin({ turn_id: 'turn-2' });
  await assert.rejects(h.expect({ title: 'Сверх дневного лимита' }), { status: 409, code: 'OWNER_CHAT_RUN_BUDGET' });
  assert.equal(h.runs().length, 1);
  await h.chat.end({ turn_id: 'turn-2' });
});

test('what the partner is shown in chat: his notebook and where the work stands, never the terms themselves', async t => {
  const h = harness(t);
  const text = h.chat.situation();
  const pack = loadPartnerKnowledge({ audience: 'planning' }).find(item => item.id === 'yovi-prelaunch');
  assert.match(text, /Активное предложение: yovi-prelaunch, версия материалов 2\.0\.0\./);
  // Whether the owner's materials are still in force is said either way; it is never left out.
  if (pack.facts.length) assert.match(text, /действуют до 2026-11-28T00:00:00Z/);
  else assert.match(text, /сейчас недоступны \(OWNER_SPECIFICATION_RECHECK_REQUIRED\)/);
  assert.match(text, /За столом сейчас нет задач в работе\./);
  for (const fact of pack.facts) assert.equal(text.includes(fact.text), false, 'offer terms are read through partner_get_context, not copied into the chat');

  // Desk work and what came of it appear in the partner's own words.
  const taskId = id(), runId = id(), at = new Date().toISOString();
  h.store.run("INSERT INTO tasks(id,partner_id,conversation_id,kind,title,instructions,due_at,status,author,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    taskId, h.config.partnerId, null, 'research', 'Изучить каналы про wellness', 'Найти площадки.', at, 'done', 'agent', at);
  h.store.run("INSERT INTO runs(id,partner_id,task_id,status,runtime,model,context_json,result_json,cost_status,estimated_cost_usd,created_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    runId, h.config.partnerId, taskId, 'completed', 'hermes', 'invented-model', '{}', JSON.stringify({ final_response: 'Нашёл три канала, где люди сами спрашивают про партнёрские программы.' }), 'runtime_estimate', 0, at, at);
  await h.service.command('task.create', { kind: 'planning', title: 'Спланировать неделю', instructions: 'Выбрать один ход.', due_at: inDays(1) }, id(), { kind: 'operator' });
  const later = h.chat.situation();
  assert.match(later, /За столом в работе: «Спланировать неделю»\./);
  assert.match(later, /Недавно сделано за столом:\n- «Изучить каналы про wellness» — Нашёл три канала/);
  // A chat run of his own is not reported back to him as desk work.
  await h.chat.begin({ turn_id: 'turn-1' }); await h.expect(); await h.chat.end({ turn_id: 'turn-1' });
  assert.equal(h.chat.situation().includes('Ход в чате'), false);
});

test('over HTTP only the gateway token opens a turn, and a stop closes an open turn cleanly', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-owner-chat-http-'));
  const config = readJson(path.join(ROOT, 'config/default.json'));
  config.server.port = 0; config.scheduler.enabled = false;
  const app = await start({ config, directory });
  let closed = false;
  t.after(async () => { if (!closed) await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const { token: operator } = await (await fetch(`${origin}/api/session`)).json();
  const gateway = readJson(path.join(directory, 'runtime/mcp-connection.json')).token;
  const post = (route, bearer, body) => fetch(`${origin}${route}`, { method: 'POST', headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const state = async () => (await fetch(`${origin}/api/state`, { headers: { 'x-partner-token': operator } })).json();

  // Neither an anonymous caller nor the owner's browser session can open the partner's turn.
  assert.equal((await post('/internal/chat/turn', null, { op: 'begin', turn_id: 'x' })).status, 403);
  assert.equal((await post('/internal/chat/turn', operator, { op: 'begin', turn_id: 'x' })).status, 403);
  assert.equal((await post('/internal/chat/turn', gateway, { op: 'pause', turn_id: 'x' })).status, 400);
  assert.equal((await post('/internal/chat/turn', gateway, { op: 'begin' })).status, 400);
  assert.deepEqual((await state()).owner_chat, { turn_open: false, writing: false, run_id: null });

  const begun = await post('/internal/chat/turn', gateway, { op: 'begin', turn_id: 'turn-1', session_id: 'session-1' });
  assert.equal(begun.status, 200);
  assert.deepEqual((await begun.json()).sections.map(section => section.key), ['тетрадь', 'обстановка']);
  const call = (name, args) => post('/internal/tools/call', gateway, { request_id: id(), name, arguments: args });
  const written = await call('partner_notebook_expect', { title: 'Разбор роли партнёра', move: 'Публикую короткий разбор.', expectation: 'Жду два вопроса за три дня.', check_at: inDays(3) });
  assert.equal(written.status, 200); assert.equal((await written.json()).entry_id, 'J-0001');
  const during = await state();
  assert.equal(during.owner_chat.turn_open, true); assert.equal(during.owner_chat.writing, true);
  const shown = during.runs.find(run => run.id === during.owner_chat.run_id);
  assert.deepEqual([shown.runtime, shown.status, shown.cost_status], [OWNER_CHAT_RUNTIME, 'running', 'external']);
  assert.equal(during.metrics.unknown_cost_runs, 0);
  // The owner can open the run and see what the partner wrote from the chat.
  const detail = await (await fetch(`${origin}/api/runs/${shown.id}`, { headers: { 'x-partner-token': operator } })).json();
  assert.deepEqual(detail.tools.map(row => row.name), ['partner_notebook_expect']);

  // Stopping the service with a turn open: the run is recorded as interrupted before the store closes.
  await app.close(); closed = true;
  const store = new Store(directory);
  try {
    const run = store.get('SELECT status,error FROM runs WHERE id=?', shown.id);
    assert.equal(run.status, 'interrupted'); assert.match(run.error, /не был закрыт/);
    // After a crash instead of a stop, the ordinary recovery does the same for any run left running.
    store.run("UPDATE runs SET status='running',finished_at=NULL WHERE id=?", shown.id); store.recover();
    assert.equal(store.get('SELECT status FROM runs WHERE id=?', shown.id).status, 'interrupted');
  } finally { store.close(); }
});
