import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT } from '../business/config.mjs';

const args = process.argv.slice(2);
const valueAfter = flag => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const source = valueAfter('--source');
const destination = path.resolve(valueAfter('--output') ?? path.join(ROOT, 'data/benchmarks/situation-router/real-sanitized'));
if (!source) throw new Error('Usage: node scripts/prepare-situation-router-fixtures.mjs --source D:\\HARNES\\lead-search\\data\\leads.db');

const sourcePath = path.resolve(source);
const forbidden = /(^|[\\/_.-])(env|session|sessions|credential|credentials|cookie|cookies|secret|secrets|token|auth)([\\/_.-]|$)/iu;
if (forbidden.test(sourcePath) || !sourcePath.toLowerCase().endsWith(path.join('data', 'leads.db').toLowerCase())) {
  throw new Error('Source must be the old lead-search data/leads.db path, not a secret/session/config file.');
}
if (!fs.existsSync(sourcePath)) throw new Error(`Source DB not found: ${sourcePath}`);

const relativeOutput = path.relative(ROOT, destination);
if (!relativeOutput || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput) || !relativeOutput.toLowerCase().startsWith('data\\benchmarks\\situation-router')) {
  throw new Error('Output must stay under HARNES2/data/benchmarks/situation-router.');
}

const db = new DatabaseSync(sourcePath, { readOnly: true });
db.exec('PRAGMA query_only=ON');
const rows = sql => db.prepare(sql).all();
const scalar = (sql, ...params) => db.prepare(sql).get(...params);

const rawValues = [
  ...rows('SELECT telegram_user_id AS value, username, display_name FROM persons'),
  ...rows('SELECT chat_id AS value, username, title AS display_name FROM chats'),
].flatMap(row => [row.value, row.username, row.display_name])
  .filter(value => typeof value === 'string' && value.trim().length >= 3)
  .map(value => value.trim())
  .filter((value, index, all) => all.indexOf(value) === index)
  .sort((a, b) => b.length - a.length);

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const textTokens = rawValues.filter(value => value.length >= 4 && !/^user[-_]\d+$/iu.test(value) && !/^person[-_ ]?\d+$/iu.test(value));
const safeText = value => {
  let text = String(value ?? '').trim();
  for (const token of textTokens) text = text.replace(new RegExp(escapeRegex(token), 'giu'), '[PERSON]');
  text = text
    .replace(/\b(?:t\.me|telegram\.me)\/[A-Za-z0-9_+/?=&%#.-]+/giu, '[URL]')
    .replace(/https?:\/\/\S+|www\.\S+/giu, '[URL]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, '[EMAIL]')
    .replace(/@[A-Za-z0-9_]{3,}/gu, '[HANDLE]')
    .replace(/\+?\d[\d\s().-]{6,}\d/gu, '[PHONE]')
    .replace(/(?<![\p{L}])\d{5,}(?![\p{L}])/gu, '[ID]');
  return text || '[REDACTED]';
};

const leadRows = rows(`
  SELECT m.chat_id,m.msg_id,m.sender_id,m.text,m.date,m.is_out
  FROM messages m JOIN leads l ON l.chat_id=m.chat_id AND l.msg_id=m.msg_id
  WHERE m.is_out=0 AND m.sender_id IS NOT NULL AND trim(m.text)<>''
  ORDER BY COALESCE(l.score,0) DESC,m.date ASC,m.msg_id ASC
`);
const otherRows = rows(`
  SELECT m.chat_id,m.msg_id,m.sender_id,m.text,m.date,m.is_out
  FROM messages m LEFT JOIN leads l ON l.chat_id=m.chat_id AND l.msg_id=m.msg_id
  WHERE l.chat_id IS NULL AND m.is_out=0 AND m.sender_id IS NOT NULL AND trim(m.text)<>''
  ORDER BY m.date ASC,m.msg_id ASC
`);

function chooseRows() {
  const chosen = [];
  const usedPairs = new Set();
  const add = row => {
    const pair = `${row.chat_id}:${row.sender_id}`;
    if (usedPairs.has(pair)) return false;
    usedPairs.add(pair); chosen.push(row); return true;
  };
  for (const pool of [leadRows, otherRows]) for (const row of pool) {
    if (chosen.length >= 20) break;
    add(row);
  }
  if (chosen.length < 20) {
    for (const row of [...leadRows, ...otherRows]) {
      if (chosen.length >= 20) break;
      if (!chosen.some(item => item.chat_id === row.chat_id && item.msg_id === row.msg_id)) chosen.push(row);
    }
  }
  if (chosen.length !== 20) throw new Error(`Не удалось выбрать ровно 20 ситуаций: ${chosen.length}`);
  return chosen;
}

const personIds = new Map();
const nextPersonId = raw => {
  const key = String(raw);
  if (!personIds.has(key)) personIds.set(key, `user-${String(personIds.size + 1).padStart(3, '0')}`);
  return personIds.get(key);
};

function beforeMessages(row) {
  const chat = db.prepare(`
    SELECT chat_id,msg_id,sender_id,text,date,is_out FROM messages
    WHERE chat_id=? AND trim(text)<>'' AND (date<? OR (date=? AND msg_id<?))
    ORDER BY date DESC,msg_id DESC LIMIT 50
  `).all(String(row.chat_id), row.date, row.date, row.msg_id).reverse();
  const author = db.prepare(`
    SELECT chat_id,msg_id,sender_id,text,date,is_out FROM messages
    WHERE sender_id=? AND trim(text)<>'' AND is_out=0 AND (date<? OR (date=? AND msg_id<?))
    ORDER BY date DESC,msg_id DESC LIMIT 20
  `).all(String(row.sender_id), row.date, row.date, row.msg_id).reverse();
  const merged = new Map();
  for (const item of [...chat, ...author]) merged.set(`${item.chat_id}:${item.msg_id}`, item);
  return [...merged.values()].sort((a, b) => a.date.localeCompare(b.date) || Number(a.msg_id) - Number(b.msg_id));
}

function makeFixture(row, caseNumber) {
  const prior = beforeMessages(row);
  const total = scalar(`
    SELECT COUNT(*) AS n FROM messages
    WHERE chat_id=? AND trim(text)<>'' AND (date<? OR (date=? AND msg_id<=?))
  `, String(row.chat_id), row.date, row.date, row.msg_id).n;
  const allMessages = [...prior, row].slice(-99).concat(row);
  const unique = new Map();
  for (const item of allMessages) unique.set(`${item.chat_id}:${item.msg_id}`, item);
  const selected = [...unique.values()].sort((a, b) => a.date.localeCompare(b.date) || Number(a.msg_id) - Number(b.msg_id));
  const localIds = new Map(selected.map((item, index) => [`${item.chat_id}:${item.msg_id}`, `m-${String(caseNumber).padStart(2, '0')}-${String(index + 1).padStart(3, '0')}`]));
  const messages = selected.map(item => ({
    id: localIds.get(`${item.chat_id}:${item.msg_id}`),
    channel: 'public',
    direction: item.is_out ? 'out' : 'in',
    author_id: item.is_out ? 'owner' : nextPersonId(item.sender_id),
    text: safeText(item.text),
    created_at: `2026-01-01T00:${String(Math.floor(selected.indexOf(item) / 60)).padStart(2, '0')}:${String(selected.indexOf(item) % 60).padStart(2, '0')}Z`,
    reply_to_id: null,
  }));
  const current = messages.at(-1);
  if (!current || current.direction !== 'in') throw new Error(`Current message is not inbound for case ${caseNumber}`);
  const personId = nextPersonId(row.sender_id);
  return {
    schema_version: 1,
    situation_id: `real-${String(caseNumber).padStart(2, '0')}`,
    source: { kind: 'sanitized_fixture', ref: `old-lead-search/sanitized/real-${String(caseNumber).padStart(2, '0')}`, captured_at: '2026-01-01T00:00:00Z' },
    message: current,
    snapshot: { messages, total_count: Math.max(Number(total), messages.length), truncated: Number(total) > messages.length },
    person: { person_id: personId, relationship: 'unknown', known_facts: [] },
    public_profile: { display_name: `Person ${String(personId).slice(-3)}`, username: `user_${String(personId).slice(-3)}`, bio: null, links: [], source_message_ids: [] },
    goal: { text: 'Понять, есть ли в живом разговоре естественный способ быть полезным в теме wellness и партнёрства.', allowed_channels: ['public', 'dm'] },
    constraints: { review_required: true, never_send: true, no_cold_outreach: true, call_time_unconfirmed: true },
  };
}

const fixtures = chooseRows().map((row, index) => makeFixture(row, index + 1));
const serialized = JSON.stringify(fixtures);
const leaked = rawValues.filter(value => value.length >= 5 && serialized.toLocaleLowerCase().includes(value.toLocaleLowerCase()));
if (leaked.length) throw new Error('Sanitization verification failed for one or more source identifiers.');
if (/\b(?:t\.me|telegram\.me)\/[A-Za-z0-9_+/?=&%#.-]+/iu.test(serialized)) {
  throw new Error('Sanitization verification failed for a Telegram link.');
}

db.close();
fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });
for (const fixture of fixtures) fs.writeFileSync(path.join(destination, `${fixture.situation_id}.json`), JSON.stringify(fixture, null, 2), 'utf8');
console.log(`Created ${fixtures.length} sanitized Situation Router fixtures.`);
