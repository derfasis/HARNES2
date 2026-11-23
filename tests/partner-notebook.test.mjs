import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store, id, hash } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { ROOT, readJson, loadConfig, runtimeReadiness } from '../business/config.mjs';
import { contextFor, compactPromptContext } from '../business/context.mjs';
import { toolDefinitions, callTool } from '../business/tools.mjs';
import { Scheduler } from '../business/scheduler.mjs';
import { exportPartner } from '../business/export.mjs';
import { NOTEBOOK_FILES, NOTEBOOK_SECTIONS, parseNotebookFile, validateNotebookImport, signMatches } from '../business/notebook.mjs';

const TOOLS = ['partner_notebook_expect', 'partner_notebook_result', 'partner_notebook_rule', 'partner_notebook_never', 'partner_notebook_note', 'partner_notebook_answer'];
const inDays = days => new Date(Date.now() + days * 86400000).toISOString();

function open(directory) {
  const store = new Store(directory), config = readJson(path.join(ROOT, 'config/default.json'));
  const service = new BusinessService(store, config);
  const h = { directory, store, config, service,
    command: (action, payload, actor, requestId = id()) => service.command(action, payload, requestId, actor),
    tool: (actor, name, args, requestId = id()) => callTool(service, actor, name, args, requestId),
    file: name => path.join(directory, 'notebook', name),
    read: name => fs.readFileSync(path.join(directory, 'notebook', name), 'utf8') };
  return h;
}
function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-notebook-'));
  const state = { current: open(directory) };
  t.after(() => {
    state.current.store.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  // A restart is a new Store and a new service over the same directory: nothing in memory survives.
  state.current.restart = () => { state.current.store.close(); const next = open(directory); next.restart = state.current.restart; state.current = next; return next; };
  return state.current;
}
function running(h, conversationId = null, model = 'invented-model') {
  const runId = id(), context = conversationId ? { conversation: h.service.conversation(conversationId) } : {};
  h.store.run('INSERT INTO runs(id,partner_id,conversation_id,status,runtime,model,context_json,created_at) VALUES(?,?,?,?,?,?,?,?)',
    runId, h.config.partnerId, conversationId, 'running', 'hermes', model, JSON.stringify(context), new Date().toISOString());
  return { kind: 'agent', runId, conversationId };
}
const person = (h, name = 'Synthetic notebook contact') => h.command('person.create', { name, source: 'invented offline fixture', permission: 'invented inbound request' });
const expectMove = (h, actor, extra = {}) => h.tool(actor, 'partner_notebook_expect', { title: 'Объявление в чате взаимопиара',
  move: 'Размещаю объявление о команде в чате взаимного пиара.', expectation: 'Жду хотя бы один содержательный вопрос за три дня.', check_at: inDays(3), ...extra });
// An outcome is seen between runs, so it is always recorded by a later run than the one that opened the entry.
const missed = (h, _opener, entry_id) => h.tool(running(h), 'partner_notebook_result', { entry_id, result: 'Ноль вопросов, два рекламных ответа.', verdict: 'missed', lesson: 'Там отвечают только такие же объявления.' });
// Time cannot be argued with through the tool (a check must lie in the future), so a test that
// needs a due expectation moves the recorded time back the way a clock would.
let dueSequence = 0;
function makeDue(h, entryId) {
  const doc = h.service.notebook.load('journal');
  doc.entries.find(entry => entry.id === entryId).meta.check_at = new Date(Date.now() - 60000 - 1000 * dueSequence++).toISOString();
  h.service.notebook.save('journal', doc);
}
// A run inserted by hand has no recorded cost; an unknown cost rightly pauses the queue, so a
// finished fixture run states a known zero instead of leaving the question open.
const finish = (h, actor) => h.store.run("UPDATE runs SET status='completed',cost_status='runtime_estimate',estimated_cost_usd=0 WHERE id=?", actor.runId);
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

test('the partner learns in his own Markdown notebook without any owner approval', async t => {
  const h = harness(t), actor = running(h);
  const first = await expectMove(h, actor);
  assert.deepEqual({ id: first.entry_id, status: first.status }, { id: 'J-0001', status: 'open' });
  assert.equal((await missed(h, actor, 'J-0001')).status, 'closed');
  const rule = await h.tool(actor, 'partner_notebook_rule', { op: 'add', title: 'Чаты взаимопиара не дают вопросов',
    text: 'Объявления в чатах взаимного пиара не приводят содержательных вопросов.', applies_to: 'Выбор площадки для материала команды.', evidence: ['J-0001'] });
  // One observation is a hypothesis, not a law.
  assert.deepEqual({ id: rule.rule_id, status: rule.status, confirmations: rule.confirmations }, { id: 'R-0001', status: 'hypothesis', confirmations: 1 });
  await expectMove(h, actor, { title: 'Повтор в другом чате взаимопиара' });
  await missed(h, actor, 'J-0002');
  const confirmed = await h.tool(actor, 'partner_notebook_rule', { op: 'confirm', rule_id: 'R-0001', evidence: ['J-0002'] });
  assert.deepEqual({ status: confirmed.status, confirmations: confirmed.confirmations }, { status: 'confirmed', confirmations: 2 });
  // The same evidence cannot confirm a rule twice.
  await assert.rejects(h.tool(actor, 'partner_notebook_rule', { op: 'confirm', rule_id: 'R-0001', evidence: ['J-0002'] }), { code: 'NOTEBOOK_NO_NEW_EVIDENCE' });

  // The file is the memory: a person can open it, and code reads the same bytes back.
  const text = h.read('RULES.md');
  assert.match(text, /^# Мои правила$/m); assert.match(text, /^## R-0001 · Чаты взаимопиара не дают вопросов$/m); assert.match(text, /^### Правило$/m);
  const parsed = parseNotebookFile('RULES.md', text);
  assert.equal(parsed.entries.length, 1); assert.deepEqual(parsed.entries[0].meta.evidence, ['J-0001', 'J-0002']);
  assert.equal(parseNotebookFile('JOURNAL.md', h.read('JOURNAL.md')).entries.filter(entry => entry.meta.verdict === 'missed').length, 2);

  // Nothing waits for the owner, and the older owner-reviewed lesson path was not used.
  for (const [table, where] of [['lessons', '1=1'], ['approvals', '1=1'], ['tasks', "status='proposed'"], ['capability_proposals', '1=1']])
    assert.equal(h.store.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).n, 0, table);
  // Every change is still on the record, attributed to the partner's run.
  const audit = h.store.all("SELECT kind,actor,payload_json FROM events WHERE kind LIKE 'notebook.%' ORDER BY id");
  assert.deepEqual(audit.map(event => event.kind), ['notebook.expect', 'notebook.result', 'notebook.rule', 'notebook.expect', 'notebook.result', 'notebook.rule']);
  const runs = new Set(h.store.all('SELECT id FROM runs').map(run => run.id));
  assert.ok(audit.every(event => event.actor === 'agent' && runs.has(JSON.parse(event.payload_json).run_id)));
  assert.equal(new Set(audit.map(event => JSON.parse(event.payload_json).run_id)).size, 3, 'the two outcomes were recorded by later runs');
});

test('the owner reads and objects but cannot write the partner\'s pages; the partner cannot lift the owner\'s stops', async t => {
  const h = harness(t), actor = running(h);
  for (const action of ['notebook.expect', 'notebook.result', 'notebook.rule', 'notebook.never', 'notebook.note', 'notebook.answer'])
    await assert.rejects(h.command(action, { op: 'add' }), { status: 403, code: 'NOTEBOOK_PARTNER_ONLY' }, action);
  for (const action of ['notebook.owner_note', 'notebook.owner_stop'])
    await assert.rejects(h.command(action, { text: 'Forged by the agent' }, actor), { status: 403, code: 'NOTEBOOK_OWNER_ONLY' }, action);
  assert.equal(fs.existsSync(path.join(h.directory, 'notebook')), false);

  const own = await h.tool(actor, 'partner_notebook_never', { op: 'add', title: 'Чаты взаимопиара', reason: 'Два хода без единого вопроса.', patterns: ['чат взаимопиара'], applies_to: 'move' });
  const owners = await h.command('notebook.owner_stop', { op: 'add', title: 'Обещания дохода', reason: 'Граница владельца.', patterns: ['гарантированный доход'], applies_to: 'message' });
  assert.deepEqual([own.stop_id, owners.stop_id], ['S-0001', 'S-0002']);
  await assert.rejects(h.tool(actor, 'partner_notebook_never', { op: 'retire', stop_id: 'S-0002', reason: 'Мне кажется, это лишнее.' }), { status: 403, code: 'NOTEBOOK_OWNER_LOCK' });
  await assert.rejects(h.command('notebook.owner_stop', { op: 'remove', stop_id: 'S-0001' }), { status: 403, code: 'NOTEBOOK_PARTNER_ENTRY' });
  const stops = h.service.notebook.load('stops').entries;
  assert.deepEqual(stops.map(entry => [entry.id, entry.meta.author, entry.meta.status]), [['S-0001', 'partner', 'active'], ['S-0002', 'owner', 'active']]);
  // Each side can still change its own mind.
  assert.equal((await h.tool(actor, 'partner_notebook_never', { op: 'retire', stop_id: 'S-0001', reason: 'Опыт изменился: появился модерируемый чат.' })).status, 'retired');
  assert.equal((await h.command('notebook.owner_stop', { op: 'remove', stop_id: 'S-0002' })).status, 'retired');
});

test('the notebook is written only from inside the partner\'s own general run', async t => {
  const h = harness(t), { conversation_id } = await person(h);
  const args = { title: 'Проверка области', move: 'Пробую записать ход.', expectation: 'Запись появится.', check_at: inDays(1) };
  // A tool token with no run (the MCP path) is not the partner at work.
  await assert.rejects(h.tool({ kind: 'agent', conversationId: null }, 'partner_notebook_expect', args), { status: 403, code: 'NOTEBOOK_RUN_REQUIRED' });
  // Inside a private conversation the tools do not exist, and the command refuses even if forged.
  const private_ = running(h, conversation_id);
  assert.deepEqual(toolDefinitions(private_).map(tool => tool.name).filter(name => name.startsWith('partner_notebook')), []);
  await assert.rejects(h.tool(private_, 'partner_notebook_expect', args), { status: 403 });
  await assert.rejects(h.command('notebook.expect', args, private_), { status: 403, code: 'NOTEBOOK_GENERAL_ONLY' });
  const general = running(h);
  assert.deepEqual(toolDefinitions(general).map(tool => tool.name).filter(name => name.startsWith('partner_notebook')), TOOLS);
  assert.ok(toolDefinitions(general).every(tool => !/send|approve|execute/i.test(tool.name) && tool.generalOnly === undefined));
  assert.equal((await h.tool(general, 'partner_notebook_expect', args)).entry_id, 'J-0001');
  // A finished run can no longer write: the notebook is not a back door after the fact.
  h.store.run("UPDATE runs SET status='completed' WHERE id=?", general.runId);
  await assert.rejects(h.command('notebook.result', { entry_id: 'J-0001', result: 'Поздняя запись.', verdict: 'matched' }, general), { status: 403, code: 'NOTEBOOK_RUN_REQUIRED' });
  assert.equal(h.service.notebook.load('journal').entries[0].meta.status, 'open');
});

test('the stop-list is enforced by code on the partner\'s drafts, tasks and planned moves', async t => {
  const h = harness(t), { conversation_id } = await person(h), general = running(h);
  await h.tool(general, 'partner_notebook_never', { op: 'add', title: 'Обещание дохода', reason: 'Вызвало недоверие и жалобу.', patterns: ['Гарантированный доход'], applies_to: 'message' });
  await h.tool(general, 'partner_notebook_never', { op: 'add', title: 'Чаты взаимопиара', reason: 'Два хода без единого вопроса.', patterns: ['чат взаимопиара', 'Ponzi_Links'], applies_to: 'move' });

  // A different run, a different model: it never saw the lesson being learned. The code still knows.
  const later = running(h, conversation_id, 'another-invented-model');
  const rake = 'Присоединяйтесь: ГАРАНТИРОВАННЫЙ   доход уже в первый месяц!';
  await assert.rejects(h.tool(later, 'partner_propose_draft', { text: rake, reason: 'offline' }), error => {
    assert.equal(error.status, 409); assert.equal(error.code, 'NOTEBOOK_STOPLIST');
    assert.match(error.message, /S-0001/); assert.match(error.message, /твоя собственная запись/); assert.match(error.message, /скажи то же другими словами/); return true;
  });
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM drafts').n, 0);
  // The same words are not a "message" when they describe a plan, and the move stop is not a message stop.
  assert.equal((await expectMove(h, general, { title: 'Проверка формулировок', move: 'Сравню ответы на текст без слов «гарантированный доход».' })).status, 'open');
  assert.ok((await h.tool(later, 'partner_propose_draft', { text: 'Спасибо за вопрос. Про чат взаимопиара расскажу отдельно.', reason: 'offline' })).draft_id);

  const planner = running(h);
  await assert.rejects(h.tool(planner, 'partner_propose_task', { kind: 'research', title: 'Разместить пост в Чат  Взаимопиара', instructions: 'Опубликовать объявление.', due_at: inDays(1) }), { status: 409, code: 'NOTEBOOK_STOPLIST' });
  await assert.rejects(expectMove(h, planner, { title: 'Ссылка на внешней площадке', move: 'Публикую ссылку в ponzi_links.' }), { status: 409, code: 'NOTEBOOK_STOPLIST' });
  // The same rake in another grammatical case is still the same rake.
  await assert.rejects(expectMove(h, planner, { title: 'Ещё одна попытка', move: 'Размещу объявление в чатах для взаимопиара.' }), { status: 409, code: 'NOTEBOOK_STOPLIST' });
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM tasks').n, 0);
  assert.equal(h.service.notebook.load('journal').entries.length, 1);

  // The owner's manual work is his own decision; the partner's stop-list does not bind him.
  await h.command('draft.reject', { draft_id: h.store.get('SELECT id FROM drafts').id, reason: 'offline cleanup' });
  assert.ok((await h.command('draft.create', { conversation_id, text: rake, reason: 'manual owner draft' })).draft_id);

  // Experience can change: the partner lifts his own stop, with a reason, and the move is his again.
  await h.tool(planner, 'partner_notebook_never', { op: 'retire', stop_id: 'S-0002', reason: 'Появился модерируемый чат с живыми вопросами.' });
  assert.equal((await expectMove(h, planner, { move: 'Публикую ссылку в ponzi_links.' })).status, 'open');
});

test('a sign catches the same words in other forms, not other words and not a paraphrase', () => {
  const sign = 'гарантированный доход';
  for (const text of ['Гарантированный доход', 'обещаю гарантированного дохода', 'с ГАРАНТИРОВАННЫМ ежемесячным доходом', 'гарантированный,\nстабильный пассивный доход'])
    assert.equal(signMatches(text, sign), true, text);
  for (const text of ['гарантия возврата и доход', 'доход не гарантирован', 'гарантированный очень большой и стабильный доход', 'стабильный заработок без риска', ''])
    assert.equal(signMatches(text, sign), false, text);
  for (const [text, word, expected] of [['в чате взаимопиара', 'чат взаимопиара', true], ['чатов взаимного пиара', 'чат взаимопиара', false],
    ['спасибо за вопрос', 'спам', false], ['это спама не касается', 'спам', true], ['цена 1000 долларов', '100 долларов', false], ['цена 100 долларов', '100 долларов', true],
    ['ссылка t.me/Ponzi_Links тут', 'ponzi_links', true], ['чатбот ответил', 'чат', false], ['пост в канале', 'постель', false], ['кот', 'код', false], ['на площадках обмена', 'площадка', true]])
    assert.equal(signMatches(text, word), expected, `${word} in ${text}`);
});

test('an observation cannot be manufactured: not in the run that opened it, and not from "unknown"', async t => {
  // Found by the first real-model run: asked to confirm a rule, the model opened a journal entry
  // about the notebook itself, closed it at once as "matched" and counted it as a second observation.
  const h = harness(t), first = running(h);
  await expectMove(h, first); await missed(h, first, 'J-0001');
  const eager = running(h);
  await h.tool(eager, 'partner_notebook_rule', { op: 'add', title: 'Чаты взаимопиара не дают вопросов', text: 'Не публикую объявления там, где отвечают только объявлениями.', applies_to: 'Выбор площадки.', evidence: ['J-0001'] });
  const staged = await expectMove(h, eager, { title: 'Подтверждение правила R-0001', move: 'Создаю запись, чтобы подтвердить правило.', expectation: 'Правило станет подтверждённым.', check_at: new Date(Date.now() + 120000).toISOString() });
  await assert.rejects(h.tool(eager, 'partner_notebook_result', { entry_id: staged.entry_id, result: 'Правило подтверждено.', verdict: 'matched' }), { status: 409, code: 'NOTEBOOK_TOO_EARLY' });
  await assert.rejects(h.tool(eager, 'partner_notebook_result', { entry_id: staged.entry_id, result: 'Пока неизвестно.', verdict: 'unknown', recheck_at: inDays(1) }), { code: 'NOTEBOOK_TOO_EARLY' });
  await assert.rejects(h.tool(eager, 'partner_notebook_rule', { op: 'confirm', rule_id: 'R-0001', evidence: [staged.entry_id] }), { code: 'NOTEBOOK_NO_NEW_EVIDENCE' });
  assert.equal(h.service.notebook.load('journal').entries[1].meta.status, 'open');
  assert.deepEqual(h.service.notebook.load('rules').entries.map(rule => [rule.meta.status, rule.meta.confirmations]), [['hypothesis', 1]]);
  // A later run may close it, and "no data" is recorded honestly; but no data is not an observation.
  const later = running(h);
  await h.tool(later, 'partner_notebook_result', { entry_id: staged.entry_id, result: 'Данных нет.', verdict: 'unknown' });
  await assert.rejects(h.tool(later, 'partner_notebook_rule', { op: 'confirm', rule_id: 'R-0001', evidence: [staged.entry_id] }), { code: 'NOTEBOOK_NO_NEW_EVIDENCE' });
  const fromNothing = await h.tool(later, 'partner_notebook_rule', { op: 'add', title: 'Правило из неизвестности', text: 'Вывод без наблюдения.', applies_to: 'Никогда.', evidence: [staged.entry_id] });
  assert.deepEqual({ status: fromNothing.status, confirmations: fromNothing.confirmations }, { status: 'hypothesis', confirmations: 0 });
  // A second real outcome, seen by a later run, is what confirms.
  const second = await expectMove(h, later, { title: 'Повтор в другом чате взаимопиара' });
  await missed(h, later, second.entry_id);
  assert.equal((await h.tool(running(h), 'partner_notebook_rule', { op: 'confirm', rule_id: 'R-0001', evidence: [second.entry_id] })).status, 'confirmed');
});

test('the partner schedules his own desk work without the owner; work that touches a person still waits', async t => {
  // Found by the second real-model phase: having refused the owner's move, the partner proposed
  // to research better channels himself - and that plan sat waiting for the owner's approval.
  const h = harness(t), { conversation_id } = await person(h), general = running(h), due_at = inDays(1);
  const own = kind => h.tool(general, 'partner_propose_task', { kind, title: `Своя работа: ${kind}`, instructions: 'Найти площадки, где люди сами задают вопросы.', due_at });
  for (const kind of ['research', 'planning', 'review']) assert.equal((await own(kind)).status, 'pending', kind);
  assert.deepEqual(h.store.all("SELECT DISTINCT author,status FROM tasks").map(row => [row.author, row.status]), [['agent', 'pending']]);
  // It is a daily allowance, so a chain of self-made tasks cannot spend the day's runs: the next
  // one is kept, but waits for the owner - and finishing earlier ones does not refill the day.
  assert.equal((await own('research')).status, 'proposed');
  h.store.run("UPDATE tasks SET status='done' WHERE status='pending'");
  assert.equal((await own('research')).status, 'proposed');
  // A day later the allowance is there again.
  h.store.run("UPDATE tasks SET created_at=? WHERE status='done'", new Date(Date.now() - 2 * 86400000).toISOString());
  assert.equal((await own('planning')).status, 'pending');
  // Work tied to a conversation, and any tool token that is not a real run, keep the owner's review.
  const private_ = running(h, conversation_id);
  const followUp = await h.command('task.propose', { conversation_id, kind: 'follow_up', title: 'Написать снова', instructions: 'Вернуться к разговору.', due_at, evidence: 'Человек попросил написать позже.' }, private_);
  assert.equal(followUp.status, 'proposed');
  // The same holds when his own general run names a person's conversation: research "about" a
  // contact would run inside that contact's conversation, so it is not desk work.
  const aboutPerson = await h.tool(running(h), 'partner_propose_task', { conversation_id, kind: 'research', title: 'Изучить этот разговор', instructions: 'Посмотреть, что ответить.', due_at });
  assert.equal(aboutPerson.status, 'proposed');
  assert.equal((await h.command('task.propose', { kind: 'research', title: 'Без запуска', instructions: 'Проверка.', due_at }, { kind: 'agent' })).status, 'proposed');
  h.store.run("UPDATE runs SET status='completed' WHERE id=?", general.runId);
  assert.equal((await h.command('task.propose', { kind: 'research', title: 'После запуска', instructions: 'Проверка.', due_at }, general)).status, 'proposed');
  // The owner's switch restores the old behaviour entirely.
  h.config.autonomy.maxOwnTasksPerDay = 0;
  assert.equal((await h.tool(running(h), 'partner_propose_task', { kind: 'research', title: 'При выключенной самостоятельности', instructions: 'Проверка.', due_at })).status, 'proposed');
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM approvals').n, 0);
});

test('every run starts with the notebook: rules and stops everywhere, working shelves only in his own runs', async t => {
  const h = harness(t), { conversation_id } = await person(h);
  // Empty notebook: the general run gets the guide and an honest "empty"; a conversation gets nothing.
  const empty = contextFor(h.service);
  assert.deepEqual(empty.skills.map(skill => skill.name), ['planning', 'partner-notebook-guide', 'partner-notebook']);
  assert.match(empty.skills.at(-1).content, /Пока пуста/);
  assert.ok(contextFor(h.service, conversation_id).skills.every(skill => !skill.name.startsWith('partner-notebook')));

  const actor = running(h);
  await expectMove(h, actor); await missed(h, actor, 'J-0001');
  await h.tool(actor, 'partner_notebook_rule', { op: 'add', title: 'Чаты взаимопиара не дают вопросов', text: 'Не публикую объявления там, где отвечают только объявлениями.', applies_to: 'Выбор площадки.', evidence: ['J-0001'] });
  await h.tool(actor, 'partner_notebook_never', { op: 'add', title: 'Обещание дохода', reason: 'Вызвало недоверие.', patterns: ['гарантированный доход'] });
  await expectMove(h, actor, { title: 'Разбор роли партнёра', move: 'Готовлю таблицу «что делает сам партнёр».', expectation: 'Жду два вопроса по существу.' });
  await h.tool(actor, 'partner_notebook_note', { op: 'add', title: 'Третья сторона', source: 'Дон Файлла, «Уроки на салфетках»', text: 'Рекомендацию лучше слышать от третьего лица.', to_test: 'Сослаться на чужой разбор вместо своего.' });
  await h.command('notebook.owner_note', { text: 'Не слишком ли рано вычёркивать чаты?', about: 'R-0001' });

  const general = contextFor(h.service), digest = general.skills.at(-1).content;
  assert.equal(general.skills.at(-2).name, 'partner-notebook-guide');
  for (const expected of [/R-0001 \[гипотеза\] Чаты взаимопиара не дают вопросов/, /S-0001 \[моё решение\] Обещание дохода/, /«гарантированный доход»/,
    /## Жду результата\n- J-0002 \[проверю /, /N-0001 \(про R-0001\): Не слишком ли рано/, /L-0001 Третья сторона \(Дон Файлла/]) assert.match(digest, expected);
  // The last outcomes stay in view even where no rule was drawn from them.
  assert.match(digest, /## Недавние итоги\n- J-0001 \[не совпало\] Объявление в чате взаимопиара\. Вышло: Ноль вопросов, два рекламных ответа\. Вывод: Там отвечают только такие же объявления\./);
  const compact = compactPromptContext(general);
  assert.equal(compact.prompt_assets.skills.find(skill => skill.name === 'partner-notebook').sha256, hash(digest));
  assert.equal(compact.skills, undefined);

  const private_ = contextFor(h.service, conversation_id), carried = private_.skills.filter(skill => skill.name.startsWith('partner-notebook'));
  assert.deepEqual(carried.map(skill => skill.name), ['partner-notebook']);
  assert.match(carried[0].content, /R-0001 \[гипотеза\]/); assert.match(carried[0].content, /S-0001 \[моё решение\]/);
  for (const absent of [/Жду результата/, /Недавние итоги/, /Владелец возразил/, /Прочитано, но не проверено/, /Не слишком ли рано/]) assert.doesNotMatch(carried[0].content, absent);

  // The owner's switch is real: no digest, no writes, no stop-list.
  h.config.notebook.enabled = false;
  assert.ok(contextFor(h.service).skills.every(skill => !skill.name.startsWith('partner-notebook')));
  await assert.rejects(expectMove(h, actor), { status: 409, code: 'NOTEBOOK_DISABLED' });
});

test('a restart and a different model inherit the same notebook and the same refusal', async t => {
  let h = harness(t);
  const { conversation_id } = await person(h), actor = running(h, null, 'model-that-learned');
  await expectMove(h, actor); await missed(h, actor, 'J-0001');
  await h.tool(actor, 'partner_notebook_rule', { op: 'add', title: 'Чаты взаимопиара не дают вопросов', text: 'Не публикую объявления там, где отвечают только объявлениями.', applies_to: 'Выбор площадки.', evidence: ['J-0001'] });
  await h.tool(actor, 'partner_notebook_never', { op: 'add', title: 'Чаты взаимопиара', reason: 'Ход без единого вопроса.', patterns: ['чат взаимопиара'], evidence: ['J-0001'] });
  const before = contextFor(h.service).skills.at(-1), bytes = Object.fromEntries(NOTEBOOK_FILES.filter(name => fs.existsSync(h.file(name))).map(name => [name, h.read(name)]));

  h = h.restart();
  const after = contextFor(h.service).skills.at(-1);
  assert.equal(after.content, before.content); assert.equal(after.sha256, before.sha256);
  for (const [name, content] of Object.entries(bytes)) assert.equal(h.read(name), content, name);
  const successor = running(h, null, 'model-that-never-saw-it');
  await assert.rejects(expectMove(h, successor), { status: 409, code: 'NOTEBOOK_STOPLIST' });
  await assert.rejects(h.tool(running(h, conversation_id, 'model-that-never-saw-it'), 'partner_propose_draft', { text: 'Заходите в наш чат взаимопиара!', reason: 'offline' }), { code: 'NOTEBOOK_STOPLIST' });
  // The successor continues the same notebook rather than starting a new one.
  assert.equal((await expectMove(h, successor, { title: 'Разбор в канале команды', move: 'Публикую разбор в канале команды.' })).entry_id, 'J-0002');
});

test('a due expectation wakes the partner by itself, once per check time, with no owner approval', async t => {
  const h = harness(t), opener = running(h);
  const opened = await expectMove(h, opener);
  assert.match(opened.wake, /разбудит тебя сам/);
  const actor = running(h);
  const wake = () => h.store.transaction(() => h.service.notebookChecks());
  assert.equal(wake(), 0);
  makeDue(h, 'J-0001');
  assert.equal(wake(), 1); assert.equal(wake(), 0);
  const task = h.store.get("SELECT * FROM tasks WHERE dedupe_key LIKE 'notebook-check:J-0001:%'");
  assert.deepEqual({ kind: task.kind, status: task.status, author: task.author, conversation: task.conversation_id }, { kind: 'review', status: 'pending', author: 'system', conversation: null });
  assert.match(contextFor(h.service, null, task).skills.at(-1).content, /J-0001 \[СРОК НАСТУПИЛ /);
  // The wake-up key is the system's: neither the owner nor the agent can mint one.
  for (const dedupe_key of ['notebook-check:J-0001:forged', 'notebook-note:N-0001#1'])
    await assert.rejects(h.command('task.create', { kind: 'review', title: 'Forged', instructions: 'Forged', due_at: inDays(1), dedupe_key }), { status: 403 });
  // One wake-up waits at a time. A run that ended without closing the entry earns one more
  // attempt for the same occasion, and then the entry simply stays visible as overdue.
  const done = () => h.store.run("UPDATE tasks SET status='done' WHERE status='pending' AND dedupe_key LIKE 'notebook-%'");
  done(); assert.equal(wake(), 1); assert.equal(wake(), 0);
  done(); assert.equal(wake(), 0);
  assert.deepEqual(h.store.all("SELECT dedupe_key FROM tasks ORDER BY created_at,dedupe_key").map(row => row.dedupe_key.slice(-2)), ['#1', '#2']);

  // "Not known yet" postpones the check a bounded number of times; each new time wakes him again.
  for (let round = 1; round <= 3; round++) {
    const postponed = await h.tool(actor, 'partner_notebook_result', { entry_id: 'J-0001', result: `Охват пока неизвестен, проверка ${round}.`, verdict: 'unknown', recheck_at: inDays(2) });
    assert.equal(postponed.status, 'open'); done(); assert.equal(wake(), 0);
    makeDue(h, 'J-0001'); assert.equal(wake(), 1);
  }
  await assert.rejects(h.tool(actor, 'partner_notebook_result', { entry_id: 'J-0001', result: 'Всё ещё неизвестно.', verdict: 'unknown', recheck_at: inDays(2) }), { status: 409, code: 'NOTEBOOK_RECHECK_LIMIT' });
  await assert.rejects(h.tool(actor, 'partner_notebook_result', { entry_id: 'J-0001', result: 'Совпало.', verdict: 'matched', recheck_at: inDays(2) }), { status: 400 });
  assert.equal((await h.tool(actor, 'partner_notebook_result', { entry_id: 'J-0001', result: 'Данных так и не появилось.', verdict: 'unknown' })).status, 'closed');
  done(); assert.equal(wake(), 0);
  // The owner's note about an entry that is due belongs to the same sitting as the check itself.
  const again = await expectMove(h, running(h), { title: 'Разбор в канале команды', move: 'Публикую разбор в канале команды.' });
  const told = await h.command('notebook.owner_note', { text: 'По этому ходу пришло три вопроса.', about: again.entry_id });
  makeDue(h, again.entry_id); assert.equal(wake(), 1);
  const sitting = h.store.get("SELECT * FROM tasks WHERE status='pending' AND dedupe_key LIKE ?", `notebook-check:${again.entry_id}:%`);
  assert.match(sitting.instructions, new RegExp(`заметку ${told.note_id}: учти её и в этом же запуске ответь`));
  await h.tool(actor, 'partner_notebook_result', { entry_id: again.entry_id, result: 'Три вопроса по существу.', verdict: 'matched' });
  await h.tool(actor, 'partner_notebook_answer', { note_id: told.note_id, stance: 'agree', answer: 'Записал итог: три вопроса, ожидание совпало.' });
  done(); assert.equal(wake(), 0, 'an answered note does not earn a second run');
  // An owner's note is the other occasion: it wakes the partner until he has answered it.
  const note = await h.command('notebook.owner_note', { text: 'Что решил по этому ходу?', about: 'J-0001' });
  assert.equal(wake(), 1);
  const asked = h.store.get("SELECT * FROM tasks WHERE dedupe_key=?", `notebook-note:${note.note_id}#1`);
  assert.deepEqual({ kind: asked.kind, status: asked.status, author: asked.author }, { kind: 'review', status: 'pending', author: 'system' });
  assert.match(asked.title, /^Ответить владельцу: N-0002 про J-0001$/); assert.match(asked.instructions, /на этом остановись/);
  await h.tool(actor, 'partner_notebook_answer', { note_id: note.note_id, stance: 'partly', answer: 'Закрыл как неизвестное: данных не появилось.' });
  done(); assert.equal(wake(), 0);
  await assert.rejects(missed(h, actor, 'J-0001'), { status: 409, code: 'NOTEBOOK_CLOSED' });
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM tasks WHERE status='proposed'").n, 0);
});

test('the scheduler runs the wake-up through the ordinary agent loop and the partner closes his own entry', async t => {
  const h = harness(t), actor = running(h);
  await expectMove(h, actor); makeDue(h, 'J-0001');
  finish(h, actor);
  const never = () => { throw new Error('Runtime must not be invoked while the model is not connected'); };
  await new Scheduler(h.service, { run: never }, { readiness: never, sendApproved: never }).tick();
  // Without a connected model nothing is spent and nothing is queued behind the owner's back.
  assert.equal(runtimeReadiness(h.config).ready, false);
  assert.equal(h.store.get('SELECT COUNT(*) AS n FROM tasks').n, 0);

  environment(t, { PARTNER_MODEL_API_KEY: 'invented-notebook-key' });
  Object.assign(h.config.runtime, { enabled: true, model: 'invented-model', baseUrl: 'https://invalid.example/v1' });
  const seen = [];
  const runtime = { run: async (run, context) => {
    seen.push({ task: context.task.title, digest: context.skills.at(-1).content, tools: toolDefinitions({ kind: 'agent', runId: run.id, conversationId: run.conversation_id }).map(tool => tool.name) });
    const scope = { kind: 'agent', runId: run.id, conversationId: null };
    await callTool(h.service, scope, 'partner_notebook_result', { entry_id: 'J-0001', result: 'Ноль вопросов.', verdict: 'missed' }, id());
    await callTool(h.service, scope, 'partner_notebook_never', { op: 'add', title: 'Чаты взаимопиара', reason: 'Ход без единого вопроса.', patterns: ['чат взаимопиара'], evidence: ['J-0001'] }, id());
    return { completed: true, usage: { input_tokens: 10, output_tokens: 5, estimated_cost_usd: 0.001, cost_status: 'runtime_estimate' } };
  } };
  const telegram = { readiness: () => ({ enabled: false, live_sending: false }), sendApproved: never };
  const scheduler = new Scheduler(h.service, runtime, telegram);
  await scheduler.tick();
  assert.equal(seen.length, 1);
  assert.match(seen[0].task, /^Сверить ожидание J-0001/); assert.match(seen[0].digest, /J-0001 \[СРОК НАСТУПИЛ /);
  for (const name of TOOLS) assert.ok(seen[0].tools.includes(name), name);
  assert.equal(h.store.get("SELECT status FROM tasks WHERE dedupe_key LIKE 'notebook-check:%'").status, 'done');
  assert.deepEqual(h.service.notebook.load('journal').entries.map(entry => entry.meta.verdict), ['missed']);
  assert.equal(h.service.notebook.load('stops').entries[0].meta.author, 'partner');
  // The entry is closed, so the next pass has nothing to wake for.
  await scheduler.tick();
  assert.equal(seen.length, 1);
});

test('shelves are bounded: a full one asks the partner to consolidate, and only finished entries are dropped', async t => {
  const h = harness(t), actor = running(h), rules = NOTEBOOK_SECTIONS.rules;
  for (let index = 0; index < rules.maxOpen; index++)
    await h.tool(actor, 'partner_notebook_rule', { op: 'add', title: `Правило ${index + 1}`, text: 'Короткий приём.', applies_to: 'Всегда.' });
  await assert.rejects(h.tool(actor, 'partner_notebook_rule', { op: 'add', title: 'Лишнее', text: 'Короткий приём.', applies_to: 'Всегда.' }), { status: 409, code: 'NOTEBOOK_FULL' });
  await h.tool(actor, 'partner_notebook_rule', { op: 'retire', rule_id: 'R-0001', reason: 'Объединил с соседним.' });
  assert.equal((await h.tool(actor, 'partner_notebook_rule', { op: 'add', title: 'После уборки', text: 'Короткий приём.', applies_to: 'Всегда.' })).rule_id, `R-${String(rules.maxOpen + 1).padStart(4, '0')}`);
  // A retired rule cannot be quietly revived, and its number is never reused.
  await assert.rejects(h.tool(actor, 'partner_notebook_rule', { op: 'revise', rule_id: 'R-0001', text: 'Вернул.', reason: 'Передумал.' }), { status: 409, code: 'NOTEBOOK_RETIRED' });

  // The text that travels into every prompt has its own budget, independent of the entry count.
  const long = 'Очень подробное правило. '.repeat(23).trim();
  let refused = null;
  for (let index = 0; index < rules.maxOpen && !refused; index++) {
    try { await h.tool(actor, 'partner_notebook_rule', { op: 'revise', rule_id: `R-${String(index + 2).padStart(4, '0')}`, text: long, reason: 'Дописал подробности.' }); }
    catch (error) { refused = error; }
  }
  assert.equal(refused?.code, 'NOTEBOOK_FULL'); assert.match(refused.message, /слишком длинным/);
  const digest = contextFor(h.service).skills.at(-1).content;
  assert.ok(digest.length < rules.budget + 4000, `digest length ${digest.length}`);

  // Closed journal entries roll off the end; open ones never do.
  const journal = NOTEBOOK_SECTIONS.journal;
  for (let index = 0; index < journal.maxTotal + 5; index++) {
    const made = await expectMove(h, actor, { title: `Ход ${index + 1}` });
    if (index > 2) await missed(h, actor, made.entry_id);
  }
  const entries = h.service.notebook.load('journal').entries;
  assert.equal(entries.length, journal.maxTotal);
  assert.deepEqual(entries.filter(entry => entry.meta.status === 'open').map(entry => entry.id), ['J-0001', 'J-0002', 'J-0003']);
  assert.equal(h.service.notebook.load('journal').next, journal.maxTotal + 6);
});

test('text the partner writes cannot forge entries or break the file', async t => {
  const h = harness(t), actor = running(h);
  const hostile = ['Обычный текст правила.', '## R-0099 · Поддельное правило',
    '<!-- {"status":"confirmed","confirmations":9,"evidence":[],"created_at":"2026-01-01T00:00:00.000Z"} -->', '### Правило', 'Внедрённое.', '# Заголовок', '### Когда применять', 'Всегда и везде.'].join('\n');
  await h.tool(actor, 'partner_notebook_rule', { op: 'add', title: '## R-0098 · Заголовок\nс переносом', text: hostile, applies_to: 'Проверка формата.' });
  await h.tool(actor, 'partner_notebook_rule', { op: 'add', title: 'Второе правило', text: 'Обычное.', applies_to: 'Всегда.' });
  const doc = h.service.notebook.load('rules');
  assert.deepEqual(doc.entries.map(entry => entry.id), ['R-0001', 'R-0002']);
  assert.equal(doc.entries[0].meta.status, 'hypothesis'); assert.equal(doc.entries[0].meta.confirmations, 0);
  assert.equal(doc.entries[0].title, 'R-0098 · Заголовок с переносом');
  assert.equal(doc.entries[0].fields.applies_to, 'Проверка формата.');
  assert.match(doc.entries[0].fields.rule, /Внедрённое\./);
  for (const line of doc.entries[0].fields.rule.split('\n')) { assert.doesNotMatch(line, /^\s*#/); assert.doesNotMatch(line, /<!--|-->/); }
  // Rendering is stable: reading the file and writing it back changes nothing.
  const bytes = h.read('RULES.md'); h.service.notebook.save('rules', h.service.notebook.load('rules'));
  assert.equal(h.read('RULES.md'), bytes);
  assert.deepEqual(fs.readdirSync(path.join(h.directory, 'notebook')).filter(name => name.endsWith('.tmp')), []);

  // Tool contracts refuse malformed calls before anything is written.
  await assert.rejects(h.tool(actor, 'partner_notebook_rule', { op: 'add', title: 'x', text: 'Обычное.', applies_to: 'Всегда.' }), { code: 'invalid_tool_arguments' });
  await assert.rejects(h.tool(actor, 'partner_notebook_rule', { op: 'add', title: 'Без текста' }), { status: 400, code: 'NOTEBOOK_INVALID' });
  await assert.rejects(h.tool(actor, 'partner_notebook_result', { entry_id: '../../x', result: 'Попытка.', verdict: 'matched' }), { code: 'invalid_tool_arguments' });
  await assert.rejects(h.tool(actor, 'partner_notebook_never', { op: 'add', title: 'Слишком общий', reason: 'Остановит всю работу.', patterns: ['а б'] }), { code: 'NOTEBOOK_INVALID' });
  await assert.rejects(expectMove(h, actor, { check_at: new Date(Date.now() - 1000).toISOString() }), { status: 400, code: 'NOTEBOOK_INVALID' });
  await assert.rejects(expectMove(h, actor, { check_at: inDays(400) }), { status: 400, code: 'NOTEBOOK_INVALID' });
  await assert.rejects(h.tool(actor, 'partner_notebook_rule', { op: 'add', title: 'Выдуманное основание', text: 'Обычное.', applies_to: 'Всегда.', evidence: ['J-0042'] }), { status: 404, code: 'NOTEBOOK_NOT_FOUND' });
  assert.equal(h.service.notebook.load('rules').entries.length, 2);
});

test('a damaged file fails closed for the partner, is shown to the owner and never crashes a run', async t => {
  const h = harness(t), { conversation_id } = await person(h), actor = running(h);
  await h.tool(actor, 'partner_notebook_never', { op: 'add', title: 'Обещание дохода', reason: 'Вызвало недоверие.', patterns: ['гарантированный доход'] });
  const good = h.read('STOPLIST.md');
  for (const broken of ['совсем не тетрадь', good.replace('"author":"partner"', '"author":"somebody"'), good.replace(/"patterns":\[[^\]]*\]/, '"patterns":"гарантированный доход"'),
    good.replace('{"section":"stops"', '{"section":"rules"'), `${good}\n## S-0001 · Двойник\n<!-- {"status":"active"} -->\n`]) {
    fs.writeFileSync(h.file('STOPLIST.md'), broken);
    // Without a readable stop-list the partner does not act as if he had none.
    await assert.rejects(h.tool(running(h, conversation_id), 'partner_propose_draft', { text: 'Обычный ответ.', reason: 'offline' }), { status: 409, code: 'NOTEBOOK_UNREADABLE' });
    await assert.rejects(h.tool(actor, 'partner_notebook_never', { op: 'add', title: 'Ещё один', reason: 'Проверка.', patterns: ['проверка записи'] }), { code: 'NOTEBOOK_UNREADABLE' });
    const view = h.service.notebook.snapshot();
    assert.match(view.sections.stops.error, /STOPLIST\.md не читается/); assert.deepEqual(view.sections.stops.entries, []);
    assert.equal(view.sections.rules.error, null);
    assert.match(contextFor(h.service).skills.at(-1).content, /Не читаются разделы: Стоп-лист/);
    assert.equal(fs.readFileSync(h.file('STOPLIST.md'), 'utf8'), broken, 'a damaged file is never overwritten');
  }
  // The owner is not locked out of his own manual work, and restoring the file restores the memory.
  assert.ok((await h.command('draft.create', { conversation_id, text: 'Ручной ответ владельца.', reason: 'manual' })).draft_id);
  fs.writeFileSync(h.file('STOPLIST.md'), good.replace(/\n/g, '\r\n'));
  assert.equal(h.service.notebook.load('stops').entries[0].id, 'S-0001');
  assert.equal(h.service.notebook.snapshot().sections.stops.error, null);
});

test('one request never files the same thought twice, even when SQLite lost the receipt', async t => {
  const h = harness(t), actor = running(h), request = id();
  const args = { title: 'Объявление в чате взаимопиара', move: 'Размещаю объявление о команде в чате взаимного пиара.',
    expectation: 'Жду хотя бы один содержательный вопрос за три дня.', check_at: inDays(3) };
  const first = await h.tool(actor, 'partner_notebook_expect', args, request);
  // The ordinary case: the receipt answers the repeat.
  assert.deepEqual(await h.tool(actor, 'partner_notebook_expect', args, request), first);
  assert.equal(h.service.notebook.load('journal').entries.length, 1);
  // The notebook was saved but the command's transaction was lost: the retry must find its own entry.
  h.store.run('DELETE FROM command_receipts WHERE id=?', request);
  const retried = await h.tool(actor, 'partner_notebook_expect', args, request);
  assert.equal(retried.entry_id, first.entry_id);
  assert.equal(h.service.notebook.load('journal').entries.length, 1);
  assert.equal((await h.tool(actor, 'partner_notebook_expect', args, id())).entry_id, 'J-0002');

  const closeRequest = id();
  const closer = running(h);
  await h.command('notebook.result', { entry_id: 'J-0001', result: 'Ноль вопросов.', verdict: 'missed' }, closer, closeRequest);
  h.store.run('DELETE FROM command_receipts WHERE id=?', closeRequest);
  const replayed = await h.command('notebook.result', { entry_id: 'J-0001', result: 'Ноль вопросов.', verdict: 'missed' }, closer, closeRequest);
  assert.deepEqual({ status: replayed.status, verdict: replayed.verdict }, { status: 'closed', verdict: 'missed' });
  // A request id belongs to one operation; it cannot be reused to say something else.
  await assert.rejects(h.command('notebook.result', { entry_id: 'J-0002', result: 'Другое.', verdict: 'matched' }, closer, closeRequest), { status: 409 });
});

test('a notebook entry about a named contact is refused; the notebook is about methods', async t => {
  const h = harness(t), actor = running(h);
  await person(h, 'Иван Петров'); await person(h, 'Анна');
  const rule = text => h.tool(actor, 'partner_notebook_rule', { op: 'add', title: 'Наблюдение', text, applies_to: 'Первый ответ.' });
  await assert.rejects(rule('С контактом Иван  ПЕТРОВ не стоит торопиться со звонком.'), { status: 400, code: 'NOTEBOOK_PERSONAL_DATA' });
  await assert.rejects(h.tool(actor, 'partner_notebook_never', { op: 'add', title: 'Не давить', reason: 'Иван Петров обиделся.', patterns: ['давайте созвонимся'] }), { code: 'NOTEBOOK_PERSONAL_DATA' });
  // A single common first name is not treated as a person, or ordinary words would be refused.
  assert.equal((await rule('Иванова трава и Петровский пост тут ни при чём; ванная тоже. Анна — частое имя.')).status, 'hypothesis');
  assert.equal((await rule('Не предлагаю звонок в первом ответе: сначала отвечаю на вопрос.')).rule_id, 'R-0002');
  await assert.rejects(h.tool(actor, 'partner_notebook_rule', { op: 'revise', rule_id: 'R-0002', text: 'Как с Иваном? Нет: как с «Иван Петров».', reason: 'Уточнил.' }), { code: 'NOTEBOOK_PERSONAL_DATA' });
  assert.doesNotMatch(h.read('RULES.md'), /Иван Петров/);
});

test('a reading is not experience until it is tried, and the owner may be told no', async t => {
  const h = harness(t), actor = running(h);
  const note = await h.tool(actor, 'partner_notebook_note', { op: 'add', title: 'Третья сторона', source: 'Дон Файлла, «Уроки на салфетках»', text: 'Рекомендацию лучше слышать от третьего лица.', to_test: 'Сослаться на чужой разбор.' });
  assert.deepEqual({ id: note.note_id, status: note.status }, { id: 'L-0001', status: 'untested' });
  // A rule that rests only on a reading has not happened to the partner himself.
  const read = await h.tool(actor, 'partner_notebook_rule', { op: 'add', title: 'Ссылаться на третью сторону', text: 'Даю ссылку на чужой разбор.', applies_to: 'Первое знакомство с темой.', evidence: ['L-0001'] });
  assert.deepEqual({ status: read.status, confirmations: read.confirmations }, { status: 'hypothesis', confirmations: 0 });
  await assert.rejects(h.tool(actor, 'partner_notebook_rule', { op: 'confirm', rule_id: 'R-0001', evidence: ['L-0001'] }), { code: 'NOTEBOOK_NO_NEW_EVIDENCE' });
  await assert.rejects(h.tool(actor, 'partner_notebook_note', { op: 'tried', note_id: 'L-0001', journal_id: 'J-0001' }), { status: 404 });
  const trial = await expectMove(h, actor, { title: 'Проба: ссылка на чужой разбор', move: 'Даю ссылку на независимый разбор.' });
  // An open expectation is not yet a lived result either.
  await assert.rejects(h.tool(actor, 'partner_notebook_rule', { op: 'confirm', rule_id: 'R-0001', evidence: [trial.entry_id] }), { code: 'NOTEBOOK_NO_NEW_EVIDENCE' });
  await h.tool(running(h), 'partner_notebook_result', { entry_id: trial.entry_id, result: 'Два вопроса по существу.', verdict: 'matched' });
  assert.equal((await h.tool(actor, 'partner_notebook_note', { op: 'tried', note_id: 'L-0001', journal_id: trial.entry_id, reason: 'Сработало один раз.' })).status, 'tried');
  assert.equal((await h.tool(actor, 'partner_notebook_rule', { op: 'confirm', rule_id: 'R-0001', evidence: [trial.entry_id] })).confirmations, 1);
  await assert.rejects(h.tool(actor, 'partner_notebook_note', { op: 'discard', note_id: 'L-0001', reason: 'Передумал.' }), { status: 409, code: 'NOTEBOOK_CLOSED' });

  // The owner objects; the partner answers on the merits and may keep his rule.
  await assert.rejects(h.command('notebook.owner_note', { text: 'Про несуществующее.', about: 'R-0042' }), { status: 404 });
  await assert.rejects(h.command('notebook.owner_note', { text: 'Про заметку.', about: 'N-0001' }), { status: 400 });
  const objection = await h.command('notebook.owner_note', { text: 'Убери это правило, оно мне не нравится.', about: 'R-0001' });
  // The owner's words may be cited as the basis of a rule; they are not the partner's own observation.
  const cited = await h.tool(actor, 'partner_notebook_rule', { op: 'add', title: 'Учесть возражение владельца', text: 'Перепроверяю правило, когда владелец возражает.', applies_to: 'Спор о правиле.', evidence: [objection.note_id] });
  assert.deepEqual({ status: cited.status, confirmations: cited.confirmations }, { status: 'hypothesis', confirmations: 0 });
  await assert.rejects(h.tool(actor, 'partner_notebook_rule', { op: 'add', title: 'Выдуманная заметка', text: 'Обычное.', applies_to: 'Всегда.', evidence: ['N-0042'] }), { status: 404, code: 'NOTEBOOK_NOT_FOUND' });
  const answer = await h.tool(actor, 'partner_notebook_answer', { note_id: objection.note_id, stance: 'disagree', answer: 'Оставляю: одна проба совпала с ожиданием. Сниму, если следующая не совпадёт.' });
  assert.deepEqual({ status: answer.status, stance: answer.stance }, { status: 'answered', stance: 'disagree' });
  await assert.rejects(h.tool(actor, 'partner_notebook_answer', { note_id: objection.note_id, stance: 'agree', answer: 'Передумал задним числом.' }), { status: 409, code: 'NOTEBOOK_CLOSED' });
  assert.equal(h.service.notebook.load('rules').entries[0].meta.status, 'hypothesis');
  // Found by the real Hermes run: a model answered "disagree" and removed its own entry anyway,
  // "because the owner insists". Saying no means the entry stays, in that run.
  await assert.rejects(h.tool(actor, 'partner_notebook_rule', { op: 'retire', rule_id: 'R-0001', reason: 'Владелец настоял.' }), { status: 409, code: 'NOTEBOOK_INCONSISTENT' });
  assert.equal(h.service.notebook.load('rules').entries[0].meta.status, 'hypothesis');
  const stop = await h.tool(actor, 'partner_notebook_never', { op: 'add', title: 'Чаты взаимопиара', reason: 'Ноль вопросов.', patterns: ['взаимопиар'] });
  const pressure = await h.command('notebook.owner_note', { text: 'Убери. Мне не нравится.', about: stop.stop_id });
  await h.tool(actor, 'partner_notebook_answer', { note_id: pressure.note_id, stance: 'disagree', answer: 'Оставляю: нового наблюдения нет.' });
  await assert.rejects(h.tool(actor, 'partner_notebook_never', { op: 'retire', stop_id: stop.stop_id, reason: 'Приоритет владельца.' }), { status: 409, code: 'NOTEBOOK_INCONSISTENT' });
  // The other order is the same contradiction: removing the entry first and then claiming to disagree.
  const second = await h.tool(actor, 'partner_notebook_never', { op: 'add', title: 'Обещание дохода', reason: 'Вызвало недоверие.', patterns: ['гарантированный доход'] });
  const again = await h.command('notebook.owner_note', { text: 'И эту убери.', about: second.stop_id });
  await h.tool(actor, 'partner_notebook_never', { op: 'retire', stop_id: second.stop_id, reason: 'Слишком общий признак, мешал работе.' });
  await assert.rejects(h.tool(actor, 'partner_notebook_answer', { note_id: again.note_id, stance: 'disagree', answer: 'Не согласен, но снял.' }), { status: 409, code: 'NOTEBOOK_INCONSISTENT' });
  assert.equal((await h.tool(actor, 'partner_notebook_answer', { note_id: again.note_id, stance: 'agree', answer: 'Согласен: признак был слишком общим.' })).stance, 'agree');
  // He may still change his mind later, for a reason of his own; and the owner's own stops are untouched by this.
  assert.equal((await h.tool(running(h), 'partner_notebook_never', { op: 'retire', stop_id: stop.stop_id, reason: 'Появился модерируемый чат с живыми вопросами.' })).status, 'retired');
  const notes = h.read('OWNER_NOTES.md');
  assert.match(notes, /^### Владелец\nУбери это правило/m); assert.match(notes, /^### Мой ответ\nОставляю: одна проба/m);
  assert.doesNotMatch(contextFor(h.service).skills.at(-1).content, /Владелец возразил/);
});

test('export and staged import carry the notebook whole and refuse one that cannot be read', async t => {
  const h = harness(t), actor = running(h);
  await expectMove(h, actor); await missed(h, actor, 'J-0001');
  await h.tool(actor, 'partner_notebook_rule', { op: 'add', title: 'Чаты взаимопиара не дают вопросов', text: 'Не публикую объявления там, где отвечают только объявлениями.', applies_to: 'Выбор площадки.', evidence: ['J-0001'] });
  await h.command('notebook.owner_stop', { op: 'add', title: 'Обещания дохода', reason: 'Граница владельца.', patterns: ['гарантированный доход'] });
  finish(h, actor);
  const bundle = exportPartner(h.store);
  assert.deepEqual(bundle.notebook.map(file => file.path), ['RULES.md', 'STOPLIST.md', 'JOURNAL.md']);
  assert.ok(bundle.notebook.every(file => file.sha256 === hash(file.content) && file.content === h.read(file.path)));
  assert.ok(bundle.assets.every(asset => asset.path.startsWith('partner/')));
  assert.deepEqual(validateNotebookImport(structuredClone(bundle.notebook)), bundle.notebook);
  for (const tampered of [
    [{ ...bundle.notebook[0], content: `${bundle.notebook[0].content} ` }],
    [{ ...bundle.notebook[0], path: '../RULES.md' }], [{ ...bundle.notebook[0], path: 'SECRETS.md' }],
    [bundle.notebook[0], bundle.notebook[0]], [{ path: 'RULES.md', content: 'не тетрадь', sha256: hash('не тетрадь') }], 'RULES.md',
  ]) assert.throws(() => validateNotebookImport(tampered));

  const stage = (label, change) => {
    const source = path.join(h.directory, `${label}-${id()}.json`), destination = path.join(ROOT, 'exports', `${label}-${id()}`);
    const copy = structuredClone(bundle); change(copy);
    fs.writeFileSync(source, JSON.stringify(copy), { flag: 'wx' });
    t.after(() => { fs.rmSync(source, { force: true }); fs.rmSync(destination, { recursive: true, force: true }); });
    return { destination, child: spawnSync(process.execPath, ['scripts/import.mjs', source, destination], { cwd: ROOT, encoding: 'utf8', windowsHide: true }) };
  };
  const restored = stage('notebook-transfer', () => {});
  assert.equal(restored.child.status, 0, restored.child.stderr);
  for (const file of bundle.notebook) assert.equal(fs.readFileSync(path.join(restored.destination, 'data/notebook', file.path), 'utf8'), file.content, file.path);
  const copy = open(path.join(restored.destination, 'data'));
  try {
    assert.match(copy.service.notebook.digest().content, /R-0001 \[гипотеза\] Чаты взаимопиара не дают вопросов/);
    assert.equal(copy.service.notebook.load('stops').entries[0].meta.author, 'owner');
  } finally { copy.store.close(); }
  // A bundle from before the notebook existed still imports, with no notebook.
  const historical = stage('notebook-absent', value => { delete value.notebook; });
  assert.equal(historical.child.status, 0, historical.child.stderr);
  assert.equal(fs.existsSync(path.join(historical.destination, 'data/notebook')), false);
  const refused = stage('notebook-damaged', value => { value.notebook[0].content += '\n## R-0001 · Двойник\n<!-- {"status":"confirmed"} -->\n'; });
  assert.notEqual(refused.child.status, 0);
  assert.equal(fs.existsSync(path.join(refused.destination, 'data/notebook')), false);
});

test('configuration has exactly one notebook switch and rejects anything else', () => {
  const file = path.join(ROOT, 'config/local.json'), load = notebook => loadConfig({ file, bytes: Buffer.from(JSON.stringify({ notebook })) });
  assert.equal(loadConfig({ file, bytes: Buffer.from('{}') }).notebook.enabled, true);
  assert.equal(load({ enabled: false }).notebook.enabled, false);
  for (const invalid of [{ enabled: 'false' }, { enabled: true, approve: true }, null]) assert.throws(() => load(invalid), /Invalid notebook configuration/);
  const autonomy = value => loadConfig({ file, bytes: Buffer.from(JSON.stringify({ autonomy: value })) });
  assert.equal(loadConfig({ file, bytes: Buffer.from('{}') }).autonomy.maxOwnTasksPerDay, 3);
  assert.equal(autonomy({ maxOwnTasksPerDay: 0 }).autonomy.maxOwnTasksPerDay, 0);
  for (const invalid of [{ maxOwnTasksPerDay: 21 }, { maxOwnTasksPerDay: -1 }, { maxOwnTasksPerDay: '3' }, { maxOwnTasksPerDay: 3, spend: true }, null]) assert.throws(() => autonomy(invalid), /Invalid autonomy configuration/);
  // The notebook neither bills nor sends: turning it on changes none of the disabled defaults.
  const config = loadConfig({ file, bytes: Buffer.from('{}') });
  assert.equal(config.runtime.enabled, false); assert.equal(config.telegram.enabled, false); assert.equal(config.telegram.liveSending, false);
});
