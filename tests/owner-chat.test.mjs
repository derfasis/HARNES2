import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, id } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { ROOT, readJson } from '../business/config.mjs';
import { callTool } from '../business/tools.mjs';
import { OwnerChat } from '../business/owner-chat.mjs';

function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-owner-chat-'));
  const store = new Store(directory), service = new BusinessService(store, readJson(path.join(ROOT, 'config/default.json')));
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const sent = [], queue = [];
  const api = async (method, body) => { if (method === 'sendMessage') { sent.push(body); return {}; } assert.equal(method, 'getUpdates'); return queue.splice(0).filter(update => update.update_id >= body.offset); };
  const chat = () => new OwnerChat(service, { token: 'offline-token', api });
  let next = 100;
  const message = (chatId, text, type = 'private') => queue.push({ update_id: next++, message: { chat: { id: chatId, type }, text } });
  const answer = (noteId, text) => {
    const runId = id();
    store.run('INSERT INTO runs(id,partner_id,status,runtime,model,context_json,created_at) VALUES(?,?,?,?,?,?,?)', runId, service.config.partnerId, 'running', 'hermes', 'invented-model', '{}', new Date().toISOString());
    return callTool(service, { kind: 'agent', runId, conversationId: null }, 'partner_notebook_answer', { note_id: noteId, stance: 'partly', answer: text }, id());
  };
  return { service, store, directory, sent, chat, message, answer, notes: () => service.notebook.load('notes').entries };
}

test('the owner talks to his partner through his own bot: one chat, notes in, answers out once', async t => {
  const h = harness(t), bot = h.chat();
  // Before /start nobody is the owner, and words sent early are not kept.
  h.message(111, 'привет'); await bot.step();
  assert.equal(h.notes().length, 0); assert.equal(h.sent.length, 0); assert.equal(bot.status().bound, false);
  h.message(111, '/start'); await bot.step();
  assert.equal(bot.status().bound, true); assert.equal(h.sent.length, 1); assert.equal(h.sent[0].chat_id, 111);

  // A stranger who finds the bot afterwards is neither stored nor answered, and cannot rebind it.
  h.message(999, '/start'); h.message(999, 'я тоже владелец'); h.message(-5, 'из группы', 'group'); await bot.step();
  assert.equal(h.notes().length, 0); assert.equal(h.sent.length, 1);

  h.message(111, 'Что думаешь про чаты взаимопиара?'); h.message(111, '/help'); await bot.step();
  assert.deepEqual(h.notes().map(note => [note.id, note.meta.status, note.fields.owner]), [['N-0001', 'open', 'Что думаешь про чаты взаимопиара?']]);
  // The note wakes the partner the ordinary way; nothing is sent until he has actually answered.
  assert.equal(h.store.transaction(() => h.service.notebookChecks()), 1);
  await bot.step(); assert.equal(h.sent.length, 1);
  await h.answer('N-0001', 'Не стоит: в прошлый раз ноль вопросов.');
  await bot.step(); await bot.step();
  assert.deepEqual(h.sent.slice(1), [{ chat_id: 111, text: 'Не стоит: в прошлый раз ноль вопросов.' }]);

  // A restart continues the same chat and repeats nothing; a note written in the dashboard stays there.
  const restarted = h.chat();
  assert.deepEqual(restarted.status(), { enabled: true, bound: true, waiting_answers: 0 });
  await h.service.command('notebook.owner_note', { text: 'Заметка из панели.' }, id());
  await h.answer('N-0002', 'Ответ в панели.');
  await restarted.step(); assert.equal(h.sent.length, 2);
  // A refused message is reported to the owner instead of vanishing.
  h.message(111, 'x'); await restarted.step();
  assert.match(h.sent.at(-1).text, /^Не смог передать партнёру: /); assert.equal(h.notes().length, 2);
  // No contact, draft or delivery is ever created by this chat.
  for (const table of ['persons', 'conversations', 'drafts', 'delivery_attempts']) assert.equal(h.store.get(`SELECT COUNT(*) AS n FROM ${table}`).n, 0, table);
});

test('without a token, or with the notebook switched off, the owner chat does not run', t => {
  const h = harness(t);
  assert.equal(new OwnerChat(h.service, { token: undefined }).enabled, false);
  h.service.config.notebook.enabled = false;
  assert.equal(h.chat().enabled, false);
});
