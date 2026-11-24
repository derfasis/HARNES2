// Owner chat: the owner talks to his partner through a private Telegram bot of his own.
//
// It is a thin transport over the notebook, not a second brain. A message from the owner becomes
// an owner note; the note wakes the partner the ordinary way; his answer is delivered back here.
// The bot speaks to exactly one chat - the first private chat that sent /start - and to nobody
// else: a stranger's message is neither stored nor answered. It never writes to contacts, so it
// is independent of telegram.liveSending. It runs only when PARTNER_OWNER_BOT_TOKEN is set.
import fs from 'node:fs';
import path from 'node:path';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export class OwnerChat {
  constructor(service, { token = process.env.PARTNER_OWNER_BOT_TOKEN, api, pollSeconds = 10 } = {}) {
    this.service = service; this.token = token; this.pollSeconds = pollSeconds; this.stopped = false;
    this.file = path.join(service.store.directory, 'owner-chat.json');
    this.state = { chat_id: null, offset: 0, notes: [], delivered: [] };
    try { Object.assign(this.state, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* first start */ }
    this.api = api ?? (async (method, body) => {
      const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout((this.pollSeconds + 20) * 1000) });
      const answer = await response.json();
      if (!answer.ok) throw new Error('OWNER_CHAT_API'); // never the provider text: it can echo the token
      return answer.result;
    });
  }
  get enabled() { return Boolean(this.token) && this.service.notebook.enabled; }
  status() { return { enabled: this.enabled, bound: this.state.chat_id !== null, waiting_answers: this.state.notes.filter(id => !this.state.delivered.includes(id)).length }; }
  save() {
    this.state.notes = this.state.notes.slice(-200); this.state.delivered = this.state.delivered.slice(-200);
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state), { flush: true }); fs.renameSync(temporary, this.file);
  }
  say(text) { return this.api('sendMessage', { chat_id: this.state.chat_id, text: String(text).slice(0, 4000) }); }
  async receive(update) {
    // The cursor moves first: a message is handled at most once, and the note command is keyed by
    // the update, so even a replayed update cannot file the same words twice.
    this.state.offset = update.update_id + 1; this.save();
    const message = update.message;
    if (message?.chat?.type !== 'private' || typeof message.text !== 'string') return;
    if (this.state.chat_id === null) {
      if (message.text.trim() !== '/start') return;
      this.state.chat_id = message.chat.id; this.save();
      await this.say('Привет. Это прямой чат с твоим партнёром. Пиши сюда как человеку — отвечу, как дойду до сообщения, обычно в пределах минуты-двух.');
      return;
    }
    if (message.chat.id !== this.state.chat_id || message.text.startsWith('/')) return;
    try {
      const made = await this.service.command('notebook.owner_note', { text: message.text }, `owner-chat:${update.update_id}`);
      this.state.notes.push(made.note_id); this.save();
    } catch (error) {
      await this.say(`Не смог передать партнёру: ${error.status ? error.message : 'внутренняя ошибка, смотри панель'}`);
    }
  }
  // An answer is marked delivered before it is sent: if the send fails it stays readable in the
  // dashboard, and the owner is never sent the same answer twice.
  async deliver() {
    if (this.state.chat_id === null) return;
    const entries = this.service.notebook.snapshot().sections.notes.entries;
    for (const noteId of this.state.notes) {
      if (this.state.delivered.includes(noteId)) continue;
      const note = entries.find(entry => entry.id === noteId);
      if (note?.meta.status !== 'answered') continue;
      this.state.delivered.push(noteId); this.save();
      await this.say(note.fields.answer);
    }
  }
  async step() {
    const updates = await this.api('getUpdates', { offset: this.state.offset, timeout: this.pollSeconds, allowed_updates: ['message'] });
    if (this.stopped) return; // shutting down: the cursor has not moved, so nothing is lost
    for (const update of updates) await this.receive(update);
    await this.deliver();
  }
  start() {
    this.loop = (async () => {
      while (!this.stopped) { try { await this.step(); } catch { if (!this.stopped) await wait(5000); } }
    })();
  }
  stop() { this.stopped = true; }
}
