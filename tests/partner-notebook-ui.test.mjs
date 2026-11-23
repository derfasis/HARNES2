import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start } from '../business/server.mjs';
import { ROOT, readJson } from '../business/config.mjs';
import { id } from '../business/store.mjs';
import { createNotebookView } from '../public/notebook.js';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const hostile = '<img src=x onerror="steal()">';
function snapshot({ enabled = true, stopsError = null } = {}) {
  const at = '2026-11-23T10:00:00.000Z', shelf = (file, title, entries, error = null) => ({ file, title, intro: '', labels: {}, max_open: 10, entries, error });
  return { enabled, directory: `C:\\data\\notebook${hostile}`, authority: 'Тетрадь ведёт партнёр.', sections: {
    rules: shelf('RULES.md', 'Мои правила', [
      { id: 'R-0001', title: hostile, meta: { status: 'confirmed', confirmations: 2, evidence: ['J-0001', 'J-0002'], created_at: at }, fields: { rule: hostile, applies_to: 'Выбор площадки.', change_note: '', retired_reason: '' } },
      { id: 'R-0002', title: 'Снятое', meta: { status: 'retired', confirmations: 0, evidence: [], created_at: at }, fields: { rule: 'Старое.', applies_to: 'Никогда.', change_note: '', retired_reason: 'Не подтвердилось.' } }]),
    stops: shelf('STOPLIST.md', 'Стоп-лист', stopsError ? [] : [
      { id: 'S-0001', title: 'Чаты взаимопиара', meta: { status: 'active', author: 'partner', applies_to: 'move', patterns: [hostile], evidence: ['J-0001'], created_at: at }, fields: { reason: 'Ноль вопросов.', retired_reason: '' } },
      { id: 'S-0002', title: 'Обещания дохода', meta: { status: 'active', author: 'owner', applies_to: 'any', patterns: ['гарантированный доход'], evidence: [], created_at: at }, fields: { reason: 'Граница владельца.', retired_reason: '' } }], stopsError),
    journal: shelf('JOURNAL.md', 'Журнал', [
      { id: 'J-0001', title: 'Закрытый ход', meta: { status: 'closed', verdict: 'missed', check_at: at, rechecks: 0, created_at: at, closed_at: at }, fields: { move: 'Ход.', expectation: 'Ждал.', basis: '', result: hostile, lesson: 'Вывод.' } },
      { id: 'J-0003', title: 'Открытый ход', meta: { status: 'open', verdict: null, check_at: '2020-01-01T00:00:00.000Z', rechecks: 1, created_at: at, closed_at: null }, fields: { move: 'Ход.', expectation: 'Жду.', basis: '', result: '', lesson: '' } }]),
    library: shelf('LIBRARY.md', 'Прочитанное', [
      { id: 'L-0001', title: 'Третья сторона', meta: { status: 'untested', tried_in: null, created_at: at }, fields: { source: hostile, text: 'Совет.', to_test: 'Проба.', outcome: '' } }]),
    notes: shelf('OWNER_NOTES.md', 'Возражения', [
      { id: 'N-0001', title: 'Про R-0001', meta: { status: 'answered', about: 'R-0001', stance: 'disagree', created_at: at, answered_at: at }, fields: { owner: 'Убери.', answer: hostile } }]),
  } };
}
function harness(options) {
  const calls = [], reads = [], dialogs = [];
  const view = createNotebookView({ esc,
    api: async (route, body) => { reads.push({ route, body }); assert.equal(route, '/api/notebook'); return snapshot(options); },
    command: async (action, payload) => { calls.push({ action, payload }); return {}; },
    panel: (title, body, action = '') => `<section><h2>${esc(title)}</h2>${body}${action}</section>`,
    empty: (title, text) => `<div class="empty">${esc(title)} ${esc(text)}</div>`,
    button: (title, action, itemId = '') => `<button data-do="${esc(action)}" data-id="${esc(itemId)}">${esc(title)}</button>`,
    field: (name, title, type = 'text', value = '') => `<div data-field="${esc(name)}" data-type="${esc(type)}" data-value="${esc(value)}">${esc(title)}</div>`,
    modal: (title, html, submit) => dialogs.push({ title, html, submit }) });
  return { view, calls, reads, dialogs };
}

test('the notebook view shows the partner\'s own words escaped, and reading never writes', async () => {
  const h = harness(); await h.view.load(); const html = h.view.render();
  assert.equal(html.includes(hostile), false); assert.ok(html.includes('&lt;img src=x'));
  for (const expected of ['R-0001', 'подтверждено', '×2', 'J-0001, J-0002', 'решение партнёра', 'ваш запрет', 'не совпало', 'срок наступил', 'срок переносился: 1', 'не согласен', 'не проверено'])
    assert.ok(html.includes(expected), expected);
  assert.deepEqual(h.calls, []); assert.ok(h.reads.every(read => read.body === undefined));
});

test('the owner can object or set his own stop, but nothing in the view approves or edits the partner', async () => {
  const h = harness(); await h.view.load(); const html = h.view.render();
  const actions = [...html.matchAll(/data-do="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual([...new Set(actions)].sort(), ['notebook-note-new', 'notebook-stop-new', 'notebook-stop-remove']);
  assert.doesNotMatch(html, /Одобрить|Активировать|Утвердить|Удалить|Изменить правило/);
  // The owner's own stop can be lifted by the owner; the partner's stop can only be argued with.
  assert.match(html, /data-do="notebook-stop-remove" data-id="S-0002"/); assert.doesNotMatch(html, /data-do="notebook-stop-remove" data-id="S-0001"/);
  assert.match(html, /data-do="notebook-note-new" data-id="S-0001"/); assert.match(html, /data-do="notebook-note-new" data-id="R-0001"/);
  // Retired and closed entries are history: there is nothing left to object to.
  assert.doesNotMatch(html, /data-do="notebook-note-new" data-id="R-0002"/); assert.doesNotMatch(html, /data-do="notebook-note-new" data-id="J-0001"/);
  assert.match(html, /data-do="notebook-note-new" data-id="J-0003"/);

  await h.view.act('notebook-note-new', 'R-0001');
  assert.match(h.dialogs.at(-1).title, /R-0001/); assert.match(h.dialogs.at(-1).html, /Запись он меняет сам/);
  await h.dialogs.at(-1).submit({ text: 'Не слишком ли рано?' });
  await h.view.act('notebook-note-new', '');
  await h.dialogs.at(-1).submit({ text: 'Общее наблюдение.' });
  await h.view.act('notebook-stop-new');
  assert.match(h.dialogs.at(-1).html, /не сможет снять/);
  await h.dialogs.at(-1).submit({ title: 'Обещания дохода', reason: 'Граница.', applies_to: 'message', patterns: ' гарантированный доход \n\nпассивный доход\n' });
  await h.view.act('notebook-stop-remove', 'S-0002');
  assert.match(h.dialogs.at(-1).html, /data-field="confirm"[^>]*data-value="no"/);
  await h.dialogs.at(-1).submit({ confirm: 'no' });
  assert.equal(h.calls.length, 3);
  await h.dialogs.at(-1).submit({ confirm: 'yes' });
  // A stop the view does not know (or the partner's own) opens no dialog at all.
  const before = h.dialogs.length; await h.view.act('notebook-stop-remove', 'S-0404'); assert.equal(h.dialogs.length, before);
  assert.deepEqual(h.calls, [
    { action: 'notebook.owner_note', payload: { text: 'Не слишком ли рано?', about: 'R-0001' } },
    { action: 'notebook.owner_note', payload: { text: 'Общее наблюдение.' } },
    { action: 'notebook.owner_stop', payload: { op: 'add', title: 'Обещания дохода', reason: 'Граница.', applies_to: 'message', patterns: ['гарантированный доход', 'пассивный доход'] } },
    { action: 'notebook.owner_stop', payload: { op: 'remove', stop_id: 'S-0002' } }]);
});

test('a switched-off notebook is read-only for the owner too, and a damaged shelf says so', async () => {
  const off = harness({ enabled: false }); await off.view.load();
  assert.match(off.view.render(), /Тетрадь выключена/); assert.doesNotMatch(off.view.render(), /data-do=/);
  const damaged = harness({ stopsError: `Тетрадь: файл STOPLIST.md не читается (${hostile}).` }); await damaged.view.load();
  const html = damaged.view.render();
  assert.match(html, /STOPLIST\.md не читается/); assert.equal(html.includes(hostile), false);
  assert.match(html, /R-0001/, 'the other shelves stay readable');
  assert.ok(harness().view.render().includes('Загружаем'), 'a view that has not loaded shows no stale data');
});

test('the dashboard serves the tab and the API keeps the two authors apart over HTTP', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-notebook-api-'));
  const config = readJson(path.join(ROOT, 'config/default.json'));
  config.server.port = 0; config.scheduler.enabled = false;
  const app = await start({ config, directory });
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const text = async route => { const response = await fetch(`${origin}${route}`); assert.equal(response.status, 200, route); return response.text(); };
  // The module the page imports is actually served, and the tab is wired in both files.
  assert.match(await text('/notebook.js'), /createNotebookView/);
  assert.match(await text('/'), /data-tab="notebook"/);
  const page = await text('/app.js');
  for (const wiring of ["import('./notebook.js')", "notebook:()=>notebookView.render()", "action.startsWith('notebook-')", "notebook:'Тетрадь партнёра'"]) assert.ok(page.includes(wiring), wiring);

  assert.equal((await fetch(`${origin}/api/notebook`)).status, 403);
  const { token } = await (await fetch(`${origin}/api/session`)).json(), headers = { 'x-partner-token': token, 'Content-Type': 'application/json' };
  const read = async () => (await fetch(`${origin}/api/notebook`, { headers })).json();
  assert.equal((await fetch(`${origin}/api/notebook?section=rules`, { headers })).status, 400);
  const empty = await read();
  assert.equal(empty.enabled, true); assert.equal(path.resolve(empty.directory), path.resolve(directory, 'notebook'));
  assert.deepEqual(Object.keys(empty.sections), ['rules', 'stops', 'journal', 'library', 'notes']);
  assert.ok(Object.values(empty.sections).every(section => section.entries.length === 0 && section.error === null));
  assert.equal(fs.existsSync(path.join(directory, 'notebook')), false, 'reading creates nothing');

  const post = async (action, payload) => fetch(`${origin}/api/commands`, { method: 'POST', headers, body: JSON.stringify({ request_id: id(), action, payload }) });
  assert.equal((await post('notebook.owner_stop', { op: 'add', title: 'Обещания дохода', reason: 'Граница владельца.', patterns: ['гарантированный доход'] })).status, 200);
  assert.equal((await post('notebook.owner_note', { text: 'Начни с разбора роли партнёра.' })).status, 200);
  // The operator session cannot write the partner's pages, whatever the payload says.
  for (const [action, payload] of [['notebook.rule', { op: 'add', title: 'Подложное', text: 'Правило владельца.', applies_to: 'Всегда.' }],
    ['notebook.answer', { note_id: 'N-0001', stance: 'agree', answer: 'Согласен сам с собой.' }], ['notebook.never', { op: 'retire', stop_id: 'S-0001', reason: 'Снимаю.' }]]) {
    const response = await post(action, payload); assert.equal(response.status, 403, action);
    assert.equal((await response.json()).code, 'NOTEBOOK_PARTNER_ONLY');
  }
  // A tool token outside a real run (the MCP connection) is not the partner at work either.
  const mcp = readJson(path.join(directory, 'runtime/mcp-connection.json'));
  const internal = await fetch(`${origin}/internal/tools/call`, { method: 'POST', headers: { Authorization: `Bearer ${mcp.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: id(), name: 'partner_notebook_rule', arguments: { op: 'add', title: 'Подложное', text: 'Правило без запуска.', applies_to: 'Всегда.' } }) });
  assert.equal(internal.status, 403); assert.equal((await internal.json()).code, 'NOTEBOOK_RUN_REQUIRED');

  const after = await read();
  assert.deepEqual(after.sections.stops.entries.map(entry => [entry.id, entry.meta.author]), [['S-0001', 'owner']]);
  assert.deepEqual(after.sections.notes.entries.map(entry => [entry.id, entry.meta.status]), [['N-0001', 'open']]);
  assert.equal(after.sections.rules.entries.length, 0);
  assert.deepEqual(fs.readdirSync(path.join(directory, 'notebook')).sort(), ['OWNER_NOTES.md', 'STOPLIST.md']);
  // Nothing about the notebook turned on a model, a channel or a send.
  assert.equal(config.runtime.enabled, false); assert.equal(config.telegram.enabled, false); assert.equal(config.telegram.liveSending, false);
  for (const table of ['runs', 'drafts', 'delivery_attempts', 'approvals', 'persons']) assert.equal(app.store.get(`SELECT COUNT(*) AS n FROM ${table}`).n, 0, table);
});
