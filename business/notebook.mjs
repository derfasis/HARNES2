// Partner Notebook v1: the partner's own professional experience, kept in Markdown.
//
// The files are the memory. Every run reads what is parsed from them, and the partner rewrites
// them himself through the commands below. Nothing here waits for an owner approval: the owner
// reads, may object, and may add his own hard stops, but he does not author the partner's rules.
// Code checks only what code can honestly check: shape, bounds, references and the stop-list.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { AppError, ensure, dateTime, now } from './errors.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const DAY = 86400000;
const MAX_HORIZON_DAYS = 90, MAX_RECHECKS = 3;
const HEADER = /^<!-- partner-notebook v1 (\{.*\}) -->$/;
const META = /^<!-- (\{.*\}) -->$/;
const ENTRY_ID = /^([RSJLN])-(\d{4,6})$/;

// One file per shelf. `fields` is the fixed order of the human-readable blocks inside an entry.
// `open` names the statuses that count against the working bound; `prune` is the order in which
// finished entries are dropped once the file is long. A full shelf is refused rather than
// trimmed of live entries: consolidating is the partner's job, and that pressure is the point.
// `budget` bounds the text that travels into every prompt, so the notebook stays a curated
// memory instead of growing into a log nobody rereads.
export const NOTEBOOK_SECTIONS = Object.freeze({
  rules: { file: 'RULES.md', prefix: 'R', title: 'Мои правила',
    intro: 'Как я работаю сейчас. Пишу и меняю сам. Гипотеза — одно наблюдение; подтверждено — два и больше.',
    fields: { rule: 'Правило', applies_to: 'Когда применять', change_note: 'Почему изменил', retired_reason: 'Почему снял' },
    statuses: ['hypothesis', 'confirmed', 'retired'], open: ['hypothesis', 'confirmed'], prune: ['retired'], maxOpen: 30, maxTotal: 60, budget: 8000 },
  stops: { file: 'STOPLIST.md', prefix: 'S', title: 'Стоп-лист: так больше не делаю',
    intro: 'Ходы и формулировки, к которым я не возвращаюсь. Код не пропустит совпадение, даже если я забуду.',
    fields: { reason: 'Почему', retired_reason: 'Почему снял' },
    statuses: ['active', 'retired'], open: ['active'], prune: ['retired'], maxOpen: 30, maxTotal: 60, budget: 4000 },
  journal: { file: 'JOURNAL.md', prefix: 'J', title: 'Журнал: ждал — получил',
    intro: 'Перед ходом записываю, чего жду и когда проверю. После — что вышло на самом деле.',
    fields: { move: 'Ход', expectation: 'Жду', basis: 'На чём основано', result: 'Вышло', lesson: 'Вывод' },
    statuses: ['open', 'closed'], open: ['open'], prune: ['closed'], maxOpen: 20, maxTotal: 80 },
  library: { file: 'LIBRARY.md', prefix: 'L', title: 'Прочитанное и советы: ещё не проверено на себе',
    intro: 'Чужой опыт: книги, форумы, советы. Это не мои правила, пока я не попробовал сам.',
    fields: { source: 'Источник', text: 'Что там сказано', to_test: 'Что хочу проверить', outcome: 'Что вышло' },
    statuses: ['untested', 'tried', 'discarded'], open: ['untested'], prune: ['discarded', 'tried'], maxOpen: 40, maxTotal: 80 },
  notes: { file: 'OWNER_NOTES.md', prefix: 'N', title: 'Возражения владельца и мои ответы',
    intro: 'Владелец читает тетрадь и может возразить. Решаю я: соглашаюсь или объясняю, почему нет.',
    fields: { owner: 'Владелец', answer: 'Мой ответ' },
    statuses: ['open', 'answered'], open: ['open'], prune: ['answered'], maxOpen: 10, maxTotal: 50 },
});
export const NOTEBOOK_FILES = Object.freeze(Object.values(NOTEBOOK_SECTIONS).map(section => section.file));
export const NOTEBOOK_AGENT_ACTIONS = Object.freeze(['notebook.expect', 'notebook.result', 'notebook.rule', 'notebook.never', 'notebook.note', 'notebook.answer']);
export const NOTEBOOK_OWNER_ACTIONS = Object.freeze(['notebook.owner_note', 'notebook.owner_stop']);
export const NOTEBOOK_ACTIONS = new Set([...NOTEBOOK_AGENT_ACTIONS, ...NOTEBOOK_OWNER_ACTIONS]);
// Task keys that wake the partner about his own notebook. The whole prefix is the system's.
export const NOTEBOOK_WAKE_PREFIX = 'notebook-';
const SECTION_BY_PREFIX = Object.fromEntries(Object.entries(NOTEBOOK_SECTIONS).map(([name, section]) => [section.prefix, name]));
const SECTION_BY_FILE = Object.fromEntries(Object.entries(NOTEBOOK_SECTIONS).map(([name, section]) => [section.file, name]));

const refuse = (message, code, status = 409) => { throw new AppError(message, status, code); };
const unreadable = (file, detail) => new AppError(`Тетрадь: файл ${file} не читается (${detail}). Исправьте или уберите файл; до этого раздел недоступен.`, 409, 'NOTEBOOK_UNREADABLE');
const strings = (value, max) => Array.isArray(value) && value.length <= max && value.every(item => typeof item === 'string');
const moment = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const flat = text => String(text ?? '').replace(/\s*\n\s*/g, ' ');
const VERDICTS = { matched: 'совпало', missed: 'не совпало', unknown: 'неизвестно' };
const short = (text, max) => { const value = flat(text); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };

// Text the partner writes becomes part of a Markdown file that code must be able to read back.
// Headings and HTML comments are the two things the format itself uses, so they are neutralised
// here rather than refused: a model that wrote "# Вывод" meant emphasis, not a new entry.
function clean(value, label, max, { min = 3, single = false, optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  ensure(typeof value === 'string', `${label}: требуется текст`, 400, 'NOTEBOOK_INVALID');
  let text = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replaceAll('<!--', '').replaceAll('-->', '')
    .split('\n').map(line => line.replace(/^\s*#+\s*/, '').trimEnd()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
  if (single) text = flat(text);
  ensure(text.length >= min && text.length <= max, `${label}: от ${min} до ${max} символов`, 400, 'NOTEBOOK_INVALID');
  return text;
}
export const foldForMatch = text => String(text ?? '').normalize('NFKC').toLowerCase().replaceAll('ё', 'е').replace(/\s+/g, ' ').trim();
const letter = character => /[\p{L}\p{N}]/u.test(character ?? '');
const words = text => foldForMatch(text).match(/[\p{L}\p{N}_]+/gu) ?? [];
// Russian changes a word's ending with its role in the sentence: «чат», «в чате», «чатов». A
// literal comparison would let the same rake through in another case, so two words count as
// the same when they share nearly all of the shorter one and most of the longer one. Numbers
// and very short words must be identical: «100» is not «1000», and «спам» is not «спасибо».
function sameWord(a, b) {
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length), longer = Math.max(a.length, b.length);
  if (shorter <= 2 || /\d/.test(a) || /\d/.test(b)) return false;
  let common = 0;
  while (common < shorter && a[common] === b[common]) common++;
  return common >= 3 && common >= shorter - 3 && common >= 0.6 * longer;
}
// A sign matches when its words appear in the same order, each at most two words after the
// previous one. This catches the same wording again; it does not catch a paraphrase, and it is
// not meant to: understanding the meaning of a rule stays the partner's own job.
export function signMatches(text, sign) {
  const haystack = words(text), needle = words(sign);
  if (!needle.length) return false;
  search: for (let start = 0; start < haystack.length; start++) {
    if (!sameWord(haystack[start], needle[0])) continue;
    let at = start;
    for (let index = 1; index < needle.length; index++) {
      let found = -1;
      for (let next = at + 1; next <= at + 3 && next < haystack.length; next++) if (sameWord(haystack[next], needle[index])) { found = next; break; }
      if (found < 0) continue search;
      at = found;
    }
    return true;
  }
  return false;
}
function containsWords(folded, phrase) {
  for (let at = folded.indexOf(phrase); at >= 0; at = folded.indexOf(phrase, at + 1))
    if (!letter(folded[at - 1]) && !letter(folded[at + phrase.length])) return true;
  return false;
}

// The parser trusts nothing it would later dereference. A person may have opened the file, and
// a field that is missing must stop the shelf here rather than fail somewhere inside a run.
function validMeta(name, meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || !NOTEBOOK_SECTIONS[name].statuses.includes(meta.status) || !moment(meta.created_at)) return false;
  if (name === 'rules') return Number.isInteger(meta.confirmations) && meta.confirmations >= 0 && strings(meta.evidence, 40);
  if (name === 'stops') return ['partner', 'owner'].includes(meta.author) && ['move', 'message', 'any'].includes(meta.applies_to)
    && strings(meta.patterns, 5) && meta.patterns.length >= 1 && strings(meta.evidence, 10);
  if (name === 'journal') return moment(meta.check_at) && Number.isInteger(meta.rechecks) && meta.rechecks >= 0
    && (meta.status === 'open' ? meta.verdict === null : ['matched', 'missed', 'unknown'].includes(meta.verdict));
  if (name === 'library') return meta.tried_in === null || typeof meta.tried_in === 'string';
  return (meta.about === null || typeof meta.about === 'string') && (meta.status === 'open' ? meta.stance === null : ['agree', 'partly', 'disagree'].includes(meta.stance));
}
function parseSection(name, raw) {
  const section = NOTEBOOK_SECTIONS[name], labels = new Map(Object.entries(section.fields).map(([key, label]) => [label, key]));
  const lines = String(raw).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const headerIndex = lines.findIndex(line => HEADER.test(line));
  if (headerIndex < 0) throw unreadable(section.file, 'нет служебной строки тетради');
  let header;
  try { header = JSON.parse(HEADER.exec(lines[headerIndex])[1]); } catch { throw unreadable(section.file, 'служебная строка повреждена'); }
  if (header?.section !== name || !Number.isInteger(header.next) || header.next < 1) throw unreadable(section.file, 'служебная строка не от этого раздела');
  const heading = new RegExp(`^## (${section.prefix}-\\d{4,6}) · (.+)$`);
  const entries = [], seen = new Set();
  let current = null, field = null;
  const finish = () => {
    if (!current) return;
    for (const key of Object.keys(current.fields)) current.fields[key] = current.fields[key].join('\n').trim();
    entries.push(current); current = null; field = null;
  };
  for (let index = headerIndex + 1; index < lines.length; index++) {
    const line = lines[index], match = heading.exec(line);
    if (match && META.test(lines[index + 1] ?? '')) {
      finish();
      let meta;
      try { meta = JSON.parse(META.exec(lines[index + 1])[1]); } catch { throw unreadable(section.file, `запись ${match[1]}: служебные данные повреждены`); }
      if (!validMeta(name, meta)) throw unreadable(section.file, `запись ${match[1]}: служебные данные неполны`);
      if (seen.has(match[1]) || Number(match[1].slice(2)) >= header.next) throw unreadable(section.file, `запись ${match[1]}: номер повторяется или выходит за счётчик`);
      seen.add(match[1]);
      current = { id: match[1], title: match[2].trim(), meta, fields: Object.fromEntries(Object.keys(section.fields).map(key => [key, []])) };
      index++; continue;
    }
    if (!current) continue; // the human-readable introduction above the first entry
    const label = /^### (.+)$/.exec(line);
    if (label && labels.has(label[1].trim())) { field = labels.get(label[1].trim()); continue; }
    if (field) current.fields[field].push(line);
    else if (line.trim()) throw unreadable(section.file, `запись ${current.id}: текст вне известных блоков`);
  }
  finish();
  return { next: header.next, entries };
}
function renderSection(name, doc) {
  const section = NOTEBOOK_SECTIONS[name];
  const out = [`# ${section.title}`, '', `<!-- partner-notebook v1 ${JSON.stringify({ section: name, next: doc.next })} -->`, '', section.intro, ''];
  for (const entry of doc.entries) {
    out.push(`## ${entry.id} · ${entry.title}`, `<!-- ${JSON.stringify(entry.meta)} -->`, '');
    for (const [key, label] of Object.entries(section.fields)) if (entry.fields[key]) out.push(`### ${label}`, entry.fields[key], '');
  }
  return out.join('\n');
}
export function parseNotebookFile(file, raw) {
  ensure(SECTION_BY_FILE[file], 'Неизвестный файл тетради', 400, 'NOTEBOOK_INVALID');
  return parseSection(SECTION_BY_FILE[file], raw);
}

export class PartnerNotebook {
  constructor(service) { this.service = service; }
  get enabled() { return this.service.config.notebook?.enabled === true; }
  get directory() { return path.join(this.service.store.directory, 'notebook'); }
  file(name) { return path.join(this.directory, NOTEBOOK_SECTIONS[name].file); }
  load(name) {
    let raw;
    try { raw = fs.readFileSync(this.file(name), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return { next: 1, entries: [] }; throw unreadable(NOTEBOOK_SECTIONS[name].file, 'ошибка чтения'); }
    return parseSection(name, raw);
  }
  // Atomic replace: a crash leaves the old file or the new one, never a half-written notebook.
  save(name, doc) {
    const section = NOTEBOOK_SECTIONS[name];
    if (section.budget) {
      const used = doc.entries.filter(entry => section.open.includes(entry.meta.status))
        .reduce((sum, entry) => sum + entry.title.length + Object.values(entry.fields).join('').length, 0);
      if (used > section.budget) refuse(`Тетрадь: раздел «${section.title}» стал слишком длинным, чтобы читать его перед каждым ходом. Сначала объедини или сними лишнее.`, 'NOTEBOOK_FULL');
    }
    const file = this.file(name), temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const content = renderSection(name, doc);
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      fs.writeFileSync(temporary, content, { encoding: 'utf8', flush: true });
      for (let attempt = 0; ; attempt++) {
        try { fs.renameSync(temporary, file); break; }
        catch (error) {
          // Windows refuses to replace a file another program holds open (an editor, a scanner).
          if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (attempt + 1));
        }
      }
    } catch {
      try { fs.rmSync(temporary, { force: true }); } catch { /* the temporary file is not the notebook */ }
      refuse('Тетрадь: запись не сохранена. Закройте файл в других программах и повторите.', 'NOTEBOOK_WRITE_FAILED', 503);
    }
    return sha256(content);
  }
  find(doc, entryId) {
    const entry = typeof entryId === 'string' ? doc.entries.find(item => item.id === entryId) : null;
    ensure(entry, `Запись ${typeof entryId === 'string' ? entryId.slice(0, 20) : ''} не найдена в тетради`, 404, 'NOTEBOOK_NOT_FOUND');
    return entry;
  }
  // A repeated request finds the entry it already made. The file can be ahead of SQLite by exactly
  // one write when a command's transaction fails after the notebook was saved; without this the
  // retry would file the same thought twice.
  replay(doc, requestId) { return doc.entries.find(entry => entry.meta.request_id === requestId) ?? null; }
  add(name, doc, entry) {
    const section = NOTEBOOK_SECTIONS[name];
    if (doc.entries.filter(item => section.open.includes(item.meta.status)).length >= section.maxOpen)
      refuse(`Тетрадь: раздел «${section.title}» заполнен (${section.maxOpen}). Сначала объедини, закрой или сними лишнее.`, 'NOTEBOOK_FULL');
    const created = { id: `${section.prefix}-${String(doc.next).padStart(4, '0')}`, ...entry };
    doc.next++; doc.entries.push(created);
    for (const status of section.prune) {
      while (doc.entries.length > section.maxTotal) {
        const index = doc.entries.findIndex(item => item.meta.status === status);
        if (index < 0) break;
        doc.entries.splice(index, 1);
      }
    }
    return created;
  }
  // Evidence must point at something that exists. A rule may rest on a reading, but only a journal
  // entry that was closed with an actual outcome counts as having happened to the partner himself.
  // "Unknown" is an honest answer and still not an observation.
  evidence(ids) {
    const list = ids ?? [];
    ensure(Array.isArray(list) && list.length <= 10 && list.every(id => typeof id === 'string' && /^[JLN]-\d{4,6}$/.test(id)),
      'Основание: до 10 ссылок на журнал (J-…), прочитанное (L-…) или заметку владельца (N-…)', 400, 'NOTEBOOK_INVALID');
    const unique = [...new Set(list)], journal = this.load('journal'), shelves = { J: journal, L: this.load('library'), N: this.load('notes') };
    for (const id of unique) this.find(shelves[id[0]], id);
    return { ids: unique, lived: unique.filter(id => id.startsWith('J') && ['matched', 'missed'].includes(journal.entries.find(entry => entry.id === id).meta.verdict)) };
  }
  // Rules and stops travel into private conversations. A contact's name does not belong there:
  // the notebook is about methods, and a name written into a rule would reach another person.
  // Only full names are checked; a single common first name would refuse ordinary words.
  assertNoContact(...texts) {
    const folded = ` ${foldForMatch(texts.join(' '))} `;
    for (const person of this.service.store.all('SELECT name FROM persons WHERE partner_id=?', this.service.config.partnerId)) {
      const name = foldForMatch(person.name);
      if (name.length >= 5 && name.includes(' ') && containsWords(folded, name))
        refuse('Тетрадь — про приёмы, не про людей. Убери имя контакта и опиши ситуацию в общем виде.', 'NOTEBOOK_PERSONAL_DATA', 400);
    }
  }
  // Saying "I disagree" and removing the entry anyway is yielding, not answering. In the run
  // where the partner told the owner no about an entry, that entry stays. He may still change
  // his mind in a later run, for a reason of his own.
  assertStands(entry, actor) {
    const yielded = this.load('notes').entries.some(note => note.meta.about === entry.id && note.meta.stance === 'disagree' && note.meta.answer_run_id === actor.runId);
    ensure(!yielded, 'Ты только что ответил владельцу «не согласен» про эту запись. Не согласен — оставь её. Если передумал по существу, реши это в другом запуске и назови причину.', 409, 'NOTEBOOK_INCONSISTENT');
    entry.meta.retired_run_id = actor.runId;
  }
  future(value, label) {
    const at = dateTime(value), delta = Date.parse(at) - Date.now();
    ensure(delta > 0 && delta <= MAX_HORIZON_DAYS * DAY, `${label}: момент в будущем, не дальше ${MAX_HORIZON_DAYS} дней`, 400, 'NOTEBOOK_INVALID');
    return at;
  }
  patterns(value) {
    ensure(Array.isArray(value) && value.length >= 1 && value.length <= 5, 'Стоп-лист: от 1 до 5 признаков', 400, 'NOTEBOOK_INVALID');
    const result = value.map(item => clean(item, 'Признак', 80, { single: true }));
    // A sign that matches almost anything would stop the partner from working at all.
    ensure(result.every(item => (foldForMatch(item).match(/[\p{L}\p{N}]/gu) ?? []).length >= 4), 'Признак слишком короткий: нужно хотя бы 4 буквы или цифры', 400, 'NOTEBOOK_INVALID');
    ensure(new Set(result.map(foldForMatch)).size === result.length, 'Признаки повторяются', 400, 'NOTEBOOK_INVALID');
    return result;
  }
  assertActor(action, actor) {
    ensure(this.enabled, 'Тетрадь выключена владельцем', 409, 'NOTEBOOK_DISABLED');
    if (NOTEBOOK_OWNER_ACTIONS.includes(action)) {
      ensure(actor?.kind === 'operator', 'Возражения и запреты владельца записывает только владелец', 403, 'NOTEBOOK_OWNER_ONLY');
      return;
    }
    // The notebook is the partner's own. The owner may object, but may not write the partner's
    // experience for him; and a tool token outside a real run is not the partner at work.
    ensure(actor?.kind === 'agent', 'Свою тетрадь ведёт сам партнёр. Владелец может возразить, но не пишет за него.', 403, 'NOTEBOOK_PARTNER_ONLY');
    const run = actor.runId ? this.service.store.get('SELECT status,conversation_id FROM runs WHERE id=? AND partner_id=?', actor.runId, this.service.config.partnerId) : null;
    ensure(run?.status === 'running', 'Тетрадь доступна только во время собственного запуска партнёра', 403, 'NOTEBOOK_RUN_REQUIRED');
    ensure(!run.conversation_id && !actor.conversationId, 'Тетрадь не ведётся изнутри личного разговора', 403, 'NOTEBOOK_GENERAL_ONLY');
  }
  command(action, p, requestId, actor) {
    this.assertActor(action, actor);
    const at = now();
    switch (action) {
      case 'notebook.expect': {
        const doc = this.load('journal'), old = this.replay(doc, requestId);
        if (old) return { entry_id: old.id, status: old.meta.status, check_at: old.meta.check_at };
        const entry = this.add('journal', doc, { title: clean(p.title, 'Название', 120, { single: true }),
          meta: { status: 'open', verdict: null, check_at: this.future(p.check_at, 'Срок проверки'), rechecks: 0, created_at: at, closed_at: null, run_id: actor.runId, request_id: requestId },
          fields: { move: clean(p.move, 'Ход', 600), expectation: clean(p.expectation, 'Ожидание', 600), basis: clean(p.basis, 'Основание', 400, { optional: true }), result: '', lesson: '' } });
        return { entry_id: entry.id, status: 'open', check_at: entry.meta.check_at, file_sha256: this.save('journal', doc),
          wake: 'Срок проверки разбудит тебя сам. Отдельная задача и одобрение владельца для этого не нужны.' };
      }
      case 'notebook.result': {
        const doc = this.load('journal'), entry = this.find(doc, p.entry_id);
        if (entry.meta.last_request_id === requestId) return { entry_id: entry.id, status: entry.meta.status, verdict: entry.meta.verdict, check_at: entry.meta.check_at };
        ensure(entry.meta.status === 'open', 'Эта запись журнала уже закрыта', 409, 'NOTEBOOK_CLOSED');
        // An outcome comes from the world, and the world is seen between runs. An entry opened and
        // closed inside one run is a note to oneself, not something that happened; allowing it let a
        // real model manufacture the second observation that turns a hypothesis into a confirmed rule.
        ensure(entry.meta.run_id !== actor.runId, 'Итог нельзя записать в том же запуске, где записано ожидание: результата ещё не могло быть. Срок проверки сам разбудит тебя позже.', 409, 'NOTEBOOK_TOO_EARLY');
        ensure(['matched', 'missed', 'unknown'].includes(p.verdict), 'Итог: matched, missed или unknown', 400, 'NOTEBOOK_INVALID');
        entry.fields.result = clean(p.result, 'Что вышло', 800); entry.meta.last_request_id = requestId;
        if (p.recheck_at !== undefined && p.recheck_at !== null) {
          // "Not known yet" is an honest answer, a bounded number of times. After that the entry
          // closes as unknown instead of waking the partner about it forever.
          ensure(p.verdict === 'unknown', 'Новый срок назначается только когда итог пока неизвестен', 400, 'NOTEBOOK_INVALID');
          ensure(entry.meta.rechecks < MAX_RECHECKS, `Срок уже переносился ${MAX_RECHECKS} раза. Закрой запись как неизвестную.`, 409, 'NOTEBOOK_RECHECK_LIMIT');
          entry.meta.check_at = this.future(p.recheck_at, 'Новый срок'); entry.meta.rechecks++;
          return { entry_id: entry.id, status: 'open', verdict: null, check_at: entry.meta.check_at, file_sha256: this.save('journal', doc) };
        }
        entry.fields.lesson = clean(p.lesson, 'Вывод', 600, { optional: true });
        Object.assign(entry.meta, { status: 'closed', verdict: p.verdict, closed_at: at });
        return { entry_id: entry.id, status: 'closed', verdict: p.verdict, file_sha256: this.save('journal', doc) };
      }
      case 'notebook.rule': {
        const doc = this.load('rules');
        ensure(['add', 'revise', 'confirm', 'retire'].includes(p.op), 'Правило: add, revise, confirm или retire', 400, 'NOTEBOOK_INVALID');
        const summary = entry => ({ rule_id: entry.id, status: entry.meta.status, confirmations: entry.meta.confirmations });
        if (p.op === 'add') {
          const old = this.replay(doc, requestId); if (old) return summary(old);
          const title = clean(p.title, 'Название', 120, { single: true }), rule = clean(p.text, 'Правило', 600), applies = clean(p.applies_to, 'Когда применять', 240);
          this.assertNoContact(title, rule, applies);
          const evidence = this.evidence(p.evidence);
          const entry = this.add('rules', doc, { title,
            meta: { status: evidence.lived.length >= 2 ? 'confirmed' : 'hypothesis', confirmations: evidence.lived.length, evidence: evidence.ids, created_at: at, updated_at: at, request_id: requestId },
            fields: { rule, applies_to: applies, change_note: '', retired_reason: '' } });
          return { ...summary(entry), file_sha256: this.save('rules', doc) };
        }
        const entry = this.find(doc, p.rule_id);
        if (entry.meta.last_request_id === requestId) return summary(entry);
        ensure(entry.meta.status !== 'retired', 'Это правило уже снято. Запиши новое, если передумал.', 409, 'NOTEBOOK_RETIRED');
        entry.meta.last_request_id = requestId; entry.meta.updated_at = at;
        if (p.op === 'retire') { this.assertStands(entry, actor); entry.fields.retired_reason = clean(p.reason, 'Почему снял', 400); entry.meta.status = 'retired'; }
        else if (p.op === 'confirm') {
          const fresh = this.evidence(p.evidence).lived.filter(id => !entry.meta.evidence.includes(id));
          ensure(fresh.length > 0, 'Подтверждение — это новая закрытая запись журнала, которой в основании правила ещё нет', 409, 'NOTEBOOK_NO_NEW_EVIDENCE');
          ensure(entry.meta.evidence.length + fresh.length <= 40, 'У правила уже достаточно оснований', 409, 'NOTEBOOK_FULL');
          entry.meta.evidence.push(...fresh); entry.meta.confirmations += fresh.length;
          if (entry.meta.confirmations >= 2) entry.meta.status = 'confirmed';
        } else {
          ensure(['title', 'text', 'applies_to'].some(key => p[key] !== undefined), 'Что именно меняется: title, text или applies_to', 400, 'NOTEBOOK_INVALID');
          if (p.title !== undefined) entry.title = clean(p.title, 'Название', 120, { single: true });
          if (p.text !== undefined) entry.fields.rule = clean(p.text, 'Правило', 600);
          if (p.applies_to !== undefined) entry.fields.applies_to = clean(p.applies_to, 'Когда применять', 240);
          this.assertNoContact(entry.title, entry.fields.rule, entry.fields.applies_to);
          entry.fields.change_note = clean(p.reason, 'Почему изменил', 400);
        }
        return { ...summary(entry), file_sha256: this.save('rules', doc) };
      }
      case 'notebook.never':
      case 'notebook.owner_stop': {
        const owner = action === 'notebook.owner_stop', author = owner ? 'owner' : 'partner', doc = this.load('stops');
        ensure(['add', owner ? 'remove' : 'retire'].includes(p.op), owner ? 'Запрет владельца: add или remove' : 'Стоп-лист: add или retire', 400, 'NOTEBOOK_INVALID');
        if (p.op === 'add') {
          const old = this.replay(doc, requestId); if (old) return { stop_id: old.id, status: old.meta.status };
          const title = clean(p.title, 'Название', 120, { single: true }), reason = clean(p.reason, 'Почему', 300), patterns = this.patterns(p.patterns);
          ensure(['move', 'message', 'any'].includes(p.applies_to ?? 'any'), 'Где действует: move, message или any', 400, 'NOTEBOOK_INVALID');
          if (!owner) this.assertNoContact(title, reason, ...patterns);
          const entry = this.add('stops', doc, { title,
            meta: { status: 'active', author, applies_to: p.applies_to ?? 'any', patterns, evidence: owner ? [] : this.evidence(p.evidence).ids, created_at: at, updated_at: at, request_id: requestId },
            fields: { reason, retired_reason: '' } });
          return { stop_id: entry.id, status: 'active', file_sha256: this.save('stops', doc) };
        }
        const entry = this.find(doc, p.stop_id);
        if (entry.meta.last_request_id === requestId) return { stop_id: entry.id, status: entry.meta.status };
        // The partner lifts his own stops when the evidence changes. The owner's stops are the
        // owner's boundary, and a boundary the partner could lift would not be one.
        ensure(entry.meta.author === author, owner ? 'Это запись самого партнёра. Возразите ему заметкой — снять её может только он.'
          : 'Этот запрет поставил владелец. Снять его может только владелец; несогласие запиши ответом на его заметку.', 403, owner ? 'NOTEBOOK_PARTNER_ENTRY' : 'NOTEBOOK_OWNER_LOCK');
        ensure(entry.meta.status === 'active', 'Эта запись уже снята', 409, 'NOTEBOOK_RETIRED');
        if (!owner) this.assertStands(entry, actor);
        entry.fields.retired_reason = clean(p.reason, 'Почему снял', 400, { optional: owner }) || 'Снято владельцем.';
        Object.assign(entry.meta, { status: 'retired', updated_at: at, last_request_id: requestId });
        return { stop_id: entry.id, status: 'retired', file_sha256: this.save('stops', doc) };
      }
      case 'notebook.note': {
        const doc = this.load('library');
        ensure(['add', 'tried', 'discard'].includes(p.op), 'Заметка: add, tried или discard', 400, 'NOTEBOOK_INVALID');
        if (p.op === 'add') {
          const old = this.replay(doc, requestId); if (old) return { note_id: old.id, status: old.meta.status };
          const entry = this.add('library', doc, { title: clean(p.title, 'Название', 120, { single: true }),
            meta: { status: 'untested', tried_in: null, created_at: at, updated_at: at, request_id: requestId },
            fields: { source: clean(p.source, 'Источник', 200, { single: true }), text: clean(p.text, 'Что там сказано', 1200), to_test: clean(p.to_test, 'Что хочу проверить', 400, { optional: true }), outcome: '' } });
          return { note_id: entry.id, status: 'untested', file_sha256: this.save('library', doc) };
        }
        const entry = this.find(doc, p.note_id);
        if (entry.meta.last_request_id === requestId) return { note_id: entry.id, status: entry.meta.status };
        ensure(entry.meta.status === 'untested', 'Эта заметка уже разобрана', 409, 'NOTEBOOK_CLOSED');
        if (p.op === 'tried') {
          // Reading becomes experience only through an attempt that was actually recorded.
          ensure(typeof p.journal_id === 'string' && /^J-\d{4,6}$/.test(p.journal_id), 'Укажи запись журнала, где ты это попробовал', 400, 'NOTEBOOK_INVALID');
          this.find(this.load('journal'), p.journal_id); entry.meta.tried_in = p.journal_id;
        }
        entry.fields.outcome = clean(p.reason, p.op === 'tried' ? 'Что вышло' : 'Почему отложил', 400, { optional: p.op === 'tried' });
        Object.assign(entry.meta, { status: p.op === 'tried' ? 'tried' : 'discarded', updated_at: at, last_request_id: requestId });
        return { note_id: entry.id, status: entry.meta.status, file_sha256: this.save('library', doc) };
      }
      case 'notebook.owner_note': {
        const doc = this.load('notes'), old = this.replay(doc, requestId);
        if (old) return { note_id: old.id, status: old.meta.status };
        const about = p.about ?? null;
        if (about !== null) {
          const prefix = ENTRY_ID.exec(typeof about === 'string' ? about : '')?.[1];
          ensure(prefix && prefix !== 'N', 'Заметка может относиться к правилу, запрету, записи журнала или прочитанному', 400, 'NOTEBOOK_INVALID');
          this.find(this.load(SECTION_BY_PREFIX[prefix]), about);
        }
        const entry = this.add('notes', doc, { title: about ? `Про ${about}` : 'Замечание владельца',
          meta: { status: 'open', about, stance: null, created_at: at, answered_at: null, request_id: requestId },
          fields: { owner: clean(p.text, 'Заметка', 1500), answer: '' } });
        return { note_id: entry.id, status: 'open', file_sha256: this.save('notes', doc) };
      }
      case 'notebook.answer': {
        const doc = this.load('notes'), entry = this.find(doc, p.note_id);
        if (entry.meta.last_request_id === requestId) return { note_id: entry.id, status: entry.meta.status, stance: entry.meta.stance };
        ensure(entry.meta.status === 'open', 'На эту заметку уже есть ответ', 409, 'NOTEBOOK_CLOSED');
        ensure(['agree', 'partly', 'disagree'].includes(p.stance), 'Позиция: agree, partly или disagree', 400, 'NOTEBOOK_INVALID');
        const prefix = ENTRY_ID.exec(entry.meta.about ?? '')?.[1];
        const target = prefix && prefix !== 'N' ? this.load(SECTION_BY_PREFIX[prefix]).entries.find(item => item.id === entry.meta.about) : null;
        ensure(!(p.stance === 'disagree' && target?.meta.retired_run_id === actor.runId), 'Ты уже снял эту запись в этом запуске — это согласие. Ответь честно: agree или partly.', 409, 'NOTEBOOK_INCONSISTENT');
        entry.fields.answer = clean(p.answer, 'Ответ', 1000);
        Object.assign(entry.meta, { status: 'answered', stance: p.stance, answered_at: at, answer_run_id: actor.runId, last_request_id: requestId });
        return { note_id: entry.id, status: 'answered', stance: p.stance, file_sha256: this.save('notes', doc) };
      }
      default: throw new AppError('Неизвестная команда тетради', 400);
    }
  }
  // The part of "never again" that does not depend on the model remembering. It runs on the
  // partner's own moves and outgoing texts; the owner's manual work is never blocked by it.
  guard(action, p, actor) {
    if (!this.enabled || actor?.kind !== 'agent') return;
    const target = action === 'draft.create' ? ['message', p.text]
      : action === 'task.propose' ? ['move', `${p.title ?? ''}\n${p.instructions ?? ''}`]
        : action === 'notebook.expect' ? ['move', `${p.title ?? ''}\n${p.move ?? ''}`] : null;
    if (!target) return;
    const hit = this.matchStop(target[1], target[0]);
    if (hit) refuse(`Стоп-лист ${hit.entry.id} «${hit.entry.title}»: совпал признак «${hit.pattern}». ${hit.entry.meta.author === 'owner'
      ? 'Этот запрет поставил владелец; выбери другой ход.' : 'Это твоя собственная запись. Выбери другой ход или сними её, если опыт изменился. Если ты лишь упоминаешь это как то, чего избегаешь, скажи то же другими словами.'}`, 'NOTEBOOK_STOPLIST');
  }
  matchStop(text, scope) {
    for (const entry of this.load('stops').entries) {
      if (entry.meta.status !== 'active' || !['any', scope].includes(entry.meta.applies_to)) continue;
      const pattern = entry.meta.patterns.find(item => signMatches(text, item));
      if (pattern) return { entry, pattern };
    }
    return null;
  }
  // Expectations whose check time has come. A damaged journal wakes nobody; the dashboard shows it.
  due(at = now()) {
    if (!this.enabled) return [];
    let doc;
    try { doc = this.load('journal'); } catch (error) { if (!(error instanceof AppError)) throw error; return []; }
    return doc.entries.filter(entry => entry.meta.status === 'open' && Date.parse(entry.meta.check_at) <= Date.parse(at))
      .sort((a, b) => Date.parse(a.meta.check_at) - Date.parse(b.meta.check_at));
  }
  // What should wake the partner next, most urgent first: a check that has come due, then an
  // owner's note he has not answered. Each key names one occasion; a postponed check carries
  // its new time and is therefore a new occasion.
  wakeups(at = now()) {
    if (!this.enabled) return [];
    let notes;
    try { notes = this.load('notes').entries.filter(note => note.meta.status === 'open'); } catch (error) { if (!(error instanceof AppError)) throw error; notes = []; }
    // When the owner has written about the very entry that came due, both belong to one sitting:
    // his note is usually the outcome itself, and a second run to "answer" it would be busywork.
    const about = entry => { const ids = notes.filter(note => note.meta.about === entry.id).map(note => note.id); return ids.length ? ` Владелец оставил про эту запись заметку ${ids.join(', ')}: учти её и в этом же запуске ответь на неё через partner_notebook_answer.` : ''; };
    const out = this.due(at).map(entry => ({ key: `${NOTEBOOK_WAKE_PREFIX}check:${entry.id}:${entry.meta.check_at}`,
      title: `Сверить ожидание ${entry.id}: ${entry.title}`.slice(0, 200),
      instructions: `Наступил срок проверки записи ${entry.id} в твоём журнале. Посмотри, что произошло на самом деле, и запиши это через partner_notebook_result. Если не совпало — сам реши, что меняешь: правило, стоп-лист или ничего. Если данных нет, честно отметь «неизвестно».${about(entry)}` }));
    for (const note of notes) out.push({ key: `${NOTEBOOK_WAKE_PREFIX}note:${note.id}`,
      title: `Ответить владельцу: ${note.id}${note.meta.about ? ` про ${note.meta.about}` : ''}`,
      instructions: `Владелец оставил в твоей тетради заметку ${note.id}. Прочитай её и ответь по существу через partner_notebook_answer: согласен, частично или нет. Если он сообщает, что вышло по записи журнала, сначала запиши этот результат через partner_notebook_result. Свои записи меняешь ты сам, если считаешь нужным. Ответил — на этом остановись: записи ради записей не нужны.` });
    return out;
  }
  // What the owner sees. It never throws: a damaged file is itself something to show.
  snapshot() {
    const sections = {};
    for (const [name, section] of Object.entries(NOTEBOOK_SECTIONS)) {
      const base = { file: section.file, title: section.title, intro: section.intro, labels: section.fields, max_open: section.maxOpen };
      try { sections[name] = { ...base, entries: this.load(name).entries, error: null }; }
      catch (error) { if (!(error instanceof AppError)) throw error; sections[name] = { ...base, entries: [], error: error.message }; }
    }
    return { enabled: this.enabled, directory: this.directory, sections,
      authority: 'Тетрадь ведёт партнёр. Владелец читает, возражает и ставит собственные запреты; правила партнёра не требуют одобрения.' };
  }
  // What the partner reads at the start of a run. Rules and stops go everywhere; the working
  // shelves (open expectations, owner notes, readings) only into his own general runs, because a
  // private conversation is not where he keeps his notebook.
  digest({ conversation = false, at = now() } = {}) {
    if (!this.enabled) return null;
    const out = [], broken = [];
    const read = name => {
      try { return this.load(name).entries; }
      catch (error) { if (!(error instanceof AppError)) throw error; broken.push(NOTEBOOK_SECTIONS[name].title); return []; }
    };
    const rules = read('rules').filter(entry => entry.meta.status !== 'retired'), stops = read('stops').filter(entry => entry.meta.status === 'active');
    if (rules.length) out.push('## Мои правила', ...rules.map(entry => `- ${entry.id} [${entry.meta.status === 'confirmed' ? `подтверждено ×${entry.meta.confirmations}` : 'гипотеза'}] ${entry.title}: ${flat(entry.fields.rule)} Когда: ${flat(entry.fields.applies_to)}`), '');
    if (stops.length) out.push('## Так больше не делаю (код не пропустит совпадение)', ...stops.map(entry => `- ${entry.id} [${entry.meta.author === 'owner' ? 'запрет владельца' : 'моё решение'}] ${entry.title}: ${flat(entry.fields.reason)} Признаки: ${entry.meta.patterns.map(item => `«${item}»`).join(', ')}`), '');
    if (!conversation) {
      const journal = read('journal'), open = journal.filter(entry => entry.meta.status === 'open').sort((a, b) => Date.parse(a.meta.check_at) - Date.parse(b.meta.check_at));
      // A person remembers last week's attempt even if he drew no rule from it. The last few
      // outcomes stay in view so that a move which just failed is not proposed again as new.
      const recent = journal.filter(entry => entry.meta.status === 'closed').slice(-6).reverse();
      const notes = read('notes').filter(entry => entry.meta.status === 'open'), readings = read('library').filter(entry => entry.meta.status === 'untested');
      if (open.length) out.push('## Жду результата', ...open.slice(0, 12).map(entry => `- ${entry.id} [${Date.parse(entry.meta.check_at) <= Date.parse(at) ? 'СРОК НАСТУПИЛ' : 'проверю'} ${entry.meta.check_at.slice(0, 16)}Z] ${entry.title}. Ход: ${short(entry.fields.move, 240)} Жду: ${short(entry.fields.expectation, 240)}`),
        ...(open.length > 12 ? [`- …и ещё ${open.length - 12} позже`] : []), '');
      if (recent.length) out.push('## Недавние итоги', ...recent.map(entry => `- ${entry.id} [${VERDICTS[entry.meta.verdict]}] ${entry.title}. Вышло: ${short(entry.fields.result, 200)}${entry.fields.lesson ? ` Вывод: ${short(entry.fields.lesson, 200)}` : ''}`), '');
      if (notes.length) out.push('## Владелец возразил — ответь сам, по существу', ...notes.slice(0, 5).map(entry => `- ${entry.id}${entry.meta.about ? ` (про ${entry.meta.about})` : ''}: ${short(entry.fields.owner, 600)}`),
        ...(notes.length > 5 ? [`- …и ещё ${notes.length - 5}`] : []), '');
      if (readings.length) out.push('## Прочитано, но не проверено на себе', ...readings.slice(-10).map(entry => `- ${entry.id} ${entry.title} (${short(entry.fields.source, 80)}): ${short(entry.fields.to_test || entry.fields.text, 300)}`), '');
    }
    if (broken.length) out.push(`Не читаются разделы: ${broken.join(', ')}. Не полагайся на память о них и скажи об этом владельцу.`, '');
    if (!out.length) return conversation ? null : { content: '# Моя тетрадь\n\nПока пуста. Первая запись появится, когда ты сделаешь ход и запишешь, чего от него ждёшь.' };
    return { content: ['# Моя тетрадь', '', 'Это мой собственный опыт: я сам его записал и сам меняю. Он не отменяет границы владельца и не заменяет факты о предложении.', '', ...out].join('\n').trim() };
  }
}
export function exportNotebook(directory) {
  const files = [];
  for (const name of NOTEBOOK_FILES) {
    let content;
    try { content = fs.readFileSync(path.join(directory, 'notebook', name), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    files.push({ path: name, content, sha256: sha256(content) });
  }
  return files;
}
// Import validates before anything is written: a known file name, an intact checksum and a body
// this version can read back. A notebook that cannot be parsed is not restored as a memory.
export function validateNotebookImport(files) {
  ensure(Array.isArray(files) && files.length <= NOTEBOOK_FILES.length, 'Invalid notebook files');
  const seen = new Set();
  for (const file of files) {
    ensure(file && typeof file.path === 'string' && NOTEBOOK_FILES.includes(file.path) && !seen.has(file.path), 'Invalid or duplicate notebook file');
    ensure(typeof file.content === 'string' && file.content.length <= 2_000_000 && sha256(file.content) === file.sha256, 'Notebook checksum mismatch');
    parseSection(SECTION_BY_FILE[file.path], file.content);
    seen.add(file.path);
  }
  return files;
}
