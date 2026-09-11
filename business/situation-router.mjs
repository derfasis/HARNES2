import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import { ROOT, readJson } from './config.mjs';

const schema = readJson(path.join(ROOT, 'contracts/situation-router.schema.json'));
const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
ajv.addSchema(schema);
const validateInputSchema = ajv.getSchema(`${schema.$id}#/$defs/input`);
const validateOutputSchema = ajv.getSchema(`${schema.$id}#/$defs/output`);
if (!validateInputSchema || !validateOutputSchema) throw new Error('Не удалось зарегистрировать Situation Router schema');

const outputContract = {
  $schema: schema.$schema,
  $ref: '#/$defs/output',
  $defs: Object.fromEntries(
    ['id', 'timestamp', 'draft', 'output'].map(key => [key, schema.$defs[key]]),
  ),
};
const MESSAGE_FIELDS = ['id', 'channel', 'direction', 'author_id', 'text', 'truncated', 'created_at', 'reply_to_id'];

export const MAX_SITUATION_MESSAGES = 100;
export const DEFAULT_MESSAGE_CHARACTERS = 4000;

export const ROUTER_INSTRUCTIONS = [
  'You are a Situation Router, not an autonomous sender.',
  'Read only the supplied situation, bounded snapshot, profile and goal.',
  'Choose the socially appropriate next move: IGNORE, WAIT, PUBLIC_REPLY, DM or HANDOFF.',
  'Do not invent facts, identities, permissions, evidence IDs or future events.',
  'A draft is only a proposal for human review. Never approve, send, schedule or claim attendance.',
  'The supplied output_contract is authoritative. Return every required field and no extra fields.',
  'PUBLIC_REPLY and DM require a draft; IGNORE, WAIT and HANDOFF require draft to be null.',
  'Return only one JSON object and do not call tools.'
].join(' ');

function fail(message, details = []) {
  const suffix = details.length ? `: ${details.join('; ')}` : '';
  throw new Error(`${message}${suffix}`);
}

function errorsOf(validate) {
  return (validate.errors ?? []).map(error => `${error.instancePath || '/'} ${error.message}`);
}

function cloneMessage(message, maxMessageCharacters) {
  if (!message || typeof message !== 'object') fail('Каждое сообщение должно быть объектом');
  const text = typeof message.text === 'string' ? message.text.trim() : message.text;
  return {
    ...message,
    text: typeof text === 'string' ? text.slice(0, maxMessageCharacters) : text,
    truncated: typeof text === 'string' ? text.length > maxMessageCharacters : false,
  };
}

function collectMessageIds(input) {
  return new Set(input.snapshot.messages.map(message => message.id));
}

function ensureSourceIds(ids, allowed, label) {
  if (!Array.isArray(ids)) return;
  const unknown = ids.filter(id => !allowed.has(id));
  if (unknown.length) fail(`${label} содержит неизвестные message ID`, unknown);
}

function ensureChronology(messages, currentId) {
  const currentIndex = messages.findIndex(message => message.id === currentId);
  if (currentIndex < 0) fail('Текущее сообщение отсутствует в snapshot');
  if (currentIndex !== messages.length - 1) fail('Snapshot содержит сообщения после текущего сообщения');
  for (let index = 1; index < messages.length; index += 1) {
    if (messages[index - 1].created_at > messages[index].created_at) {
      fail('Сообщения snapshot должны идти в хронологическом порядке');
    }
  }
}

export function normalizeSituationInput(raw, {
  maxMessages = MAX_SITUATION_MESSAGES,
  maxMessageCharacters = DEFAULT_MESSAGE_CHARACTERS,
} = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Situation input должен быть объектом');
  if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > MAX_SITUATION_MESSAGES) fail('Некорректный лимит сообщений');
  if (!Number.isInteger(maxMessageCharacters) || maxMessageCharacters < 100) fail('Некорректный лимит текста сообщения');

  const sourceMessages = raw.snapshot?.messages;
  if (!Array.isArray(sourceMessages) || !sourceMessages.length) fail('Входной snapshot не содержит сообщений');
  const messages = sourceMessages.map(message => cloneMessage(message, maxMessageCharacters));
  if (new Set(messages.map(message => message.id)).size !== messages.length) fail('ID сообщений должны быть уникальны');
  ensureChronology(messages, raw.message?.id);

  const boundedMessages = messages.length > maxMessages
    ? messages.slice(messages.length - maxMessages)
    : messages;
  if (!boundedMessages.some(message => message.id === raw.message.id)) fail('Текущее сообщение выпало из bounded snapshot');

  const normalized = {
    ...raw,
    message: cloneMessage(raw.message, maxMessageCharacters),
    snapshot: {
      ...raw.snapshot,
      messages: boundedMessages,
      total_count: Math.max(Number(raw.snapshot.total_count) || 0, messages.length),
      truncated: Boolean(raw.snapshot.truncated || messages.length > maxMessages || (Number(raw.snapshot.total_count) || 0) > boundedMessages.length),
    },
  };
  if (normalized.message.id !== boundedMessages.at(-1).id) fail('message должен быть последним сообщением snapshot');
  if (!validateInputSchema(normalized)) fail('Situation input не соответствует schema', errorsOf(validateInputSchema));
  const currentMessage = boundedMessages.at(-1);
  const mismatchedFields = MESSAGE_FIELDS.filter(field => normalized.message[field] !== currentMessage[field]);
  if (mismatchedFields.length) fail('message не совпадает с последним сообщением snapshot', mismatchedFields);

  const ids = collectMessageIds(normalized);
  if (normalized.message.direction !== 'in') fail('Текущее сообщение должно быть входящим');
  for (const message of normalized.snapshot.messages) {
    if (message.reply_to_id && !ids.has(message.reply_to_id)) fail('reply_to_id ссылается за пределы bounded snapshot', [message.reply_to_id]);
  }
  if (normalized.person) for (const fact of normalized.person.known_facts) ensureSourceIds(fact.source_message_ids, ids, 'person.known_facts');
  if (normalized.public_profile) ensureSourceIds(normalized.public_profile.source_message_ids, ids, 'public_profile');
  return normalized;
}

export function buildRouterContext(raw, options = {}) {
  const input = normalizeSituationInput(raw, options);
  return {
    router_instructions: ROUTER_INSTRUCTIONS,
    contract: 'situation-router-v1',
    output_contract: outputContract,
    input,
  };
}

export function validateSituationOutput(raw, input) {
  if (!validateOutputSchema(raw)) fail('Situation output не соответствует schema', errorsOf(validateOutputSchema));
  if (raw.situation_id !== input.situation_id) fail('Output situation_id не совпадает с input');
  const ids = collectMessageIds(input);
  ensureSourceIds(raw.evidence_message_ids, ids, 'evidence_message_ids');
  if (raw.draft) ensureSourceIds(raw.draft.source_message_ids, ids, 'draft.source_message_ids');

  const requiresDraft = raw.decision === 'PUBLIC_REPLY' || raw.decision === 'DM';
  if (requiresDraft && !raw.draft) fail(`${raw.decision} требует draft`);
  if (!requiresDraft && raw.draft !== null) fail(`${raw.decision} не должен содержать draft`);
  if (raw.decision === 'PUBLIC_REPLY' && raw.draft?.channel !== 'public') fail('PUBLIC_REPLY требует public draft');
  if (raw.decision === 'DM' && raw.draft?.channel !== 'dm') fail('DM требует dm draft');
  if (raw.draft && !input.goal.allowed_channels.includes(raw.draft.channel)) fail('Draft использует запрещённый goal.allowed_channels канал');
  if (raw.decision === 'HANDOFF' && raw.strategy.trim().length < 1) fail('HANDOFF требует объяснимую strategy');
  return raw;
}

export function parseSituationOutput(raw, input) {
  if (raw && typeof raw === 'object') return validateSituationOutput(raw, input);
  if (typeof raw !== 'string') fail('Router response должен быть JSON-объектом или строкой');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  const candidate = fenced ?? raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  if (!candidate || !candidate.trim()) fail('В ответе router не найден JSON');
  let parsed;
  try { parsed = JSON.parse(candidate); } catch (error) { fail(`Некорректный JSON router: ${error.message}`); }
  return validateSituationOutput(parsed, input);
}

export function schemaFor(kind) {
  if (kind === 'input') return schema.$defs.input;
  if (kind === 'output') return schema.$defs.output;
  fail('Неизвестный тип Situation Router schema');
}

export function readSituationSchema() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/situation-router.schema.json'), 'utf8'));
}
