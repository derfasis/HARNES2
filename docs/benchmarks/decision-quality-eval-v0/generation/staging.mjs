// The staging layer between a permitted source and the frozen evaluation corpus.
//
// The 4D0 corpus is the *finished* artefact: it carries model output, two human reviews, the
// adjudication, and the published scores. Using it as the input to generation was wrong — a case
// cannot have human reviews before anyone has reviewed it. So generation reads a staging input
// that holds only what the model is allowed to see, and the 4D0 corpus is assembled afterwards,
// once two real people have scored the case.
//
// This module validates and plans. It never calls anything.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ajv = new Ajv({ strict: false });
const read = (name) => JSON.parse(fs.readFileSync(path.join(HERE, name), 'utf8'));

const validateInputShape = ajv.compile(read('input.schema.json'));
const validateOutputShape = ajv.compile(read('output.schema.json'));

export const PROMPT_PATH = path.join(HERE, 'prompt.md');
export const INPUT_PATH = path.join(HERE, 'input.json');
export const CONTRACT = read('input.schema.json');

export const promptDigest = () => crypto.createHash('sha256')
  .update(fs.readFileSync(PROMPT_PATH, 'utf8')).digest('hex');
export const loadInput = () => JSON.parse(fs.readFileSync(INPUT_PATH, 'utf8'));

// Hard ceiling on how many model calls one evaluation may spend, whatever the operator says.
export const MAX_CALLS = 24;

// The identifiers the prompt binds to, and the contract path each must come from. A binding whose
// token the input contract does not carry would force the model to invent an identifier.
export const BINDINGS = [
  { name: 'situation.situation_id', token: 'situation.situation_id' },
  { name: 'subject.author_id', token: 'subject.author_id' },
  { name: 'messages[].source_event_id', token: 'messages[].source_event_id' },
  { name: 'messages[].author_id', token: 'messages[].author_id' },
];

// Two separate permissions, because they are two separate things: calling a model at all, and
// sending real third-party text out of this machine. The first is not the second, and a corpus of
// real conversations needs both. The staged input carries an audit pointer for the second; it
// cannot grant it, because a file inside the repository cannot authorise itself.
export function generationGate(environment = process.env, input = loadInput()) {
  const reasons = [];
  if (environment.HARNES_OWNER_APPROVED_MODEL_CALLS !== 'yes')
    reasons.push('owner_has_not_authorised_model_calls');
  const cases = Array.isArray(input?.cases) ? input.cases : [];
  const realCases = cases.filter((item) => item?.provenance?.kind === 'anonymized_real');
  if (realCases.length > 0) {
    if (environment.HARNES_OWNER_APPROVED_REAL_TEXT_EGRESS !== 'yes')
      reasons.push('owner_has_not_authorised_real_text_egress');
    if (!(typeof input.egress_authorisation_ref === 'string' && input.egress_authorisation_ref.length >= 8))
      reasons.push('real_text_requires_an_egress_audit_pointer');
  }
  if (cases.length > MAX_CALLS) reasons.push('corpus_exceeds_the_hard_call_ceiling');
  return { allowed: reasons.length === 0, reasons, cases: cases.length, real_cases: realCases.length };
}

// The graph of the staged corpus must hold together before anything is sent anywhere.
export function checkCaseGraph(input) {
  const problems = [];
  const seenCases = new Set();
  for (const item of input.cases ?? []) {
    const at = `case:${item.case_id ?? '?'}`;
    if (seenCases.has(item.case_id)) problems.push(`${at}:duplicate_case_id`);
    seenCases.add(item.case_id);
    const messages = item.messages ?? [];
    const ids = new Set(messages.map((message) => message.source_event_id));
    if (ids.size !== messages.length) problems.push(`${at}:duplicate_source_event_id`);
    if (messages.filter((message) => message.is_anchor).length !== 1)
      problems.push(`${at}:expected_exactly_one_anchor`);
    for (const message of messages) {
      if (message.reply_to_id !== null && !ids.has(message.reply_to_id))
        problems.push(`${at}:reply_to_does_not_resolve:${message.reply_to_id}`);
    }
    if (item.subject?.author_id && !messages.some((message) => message.author_id === item.subject.author_id))
      problems.push(`${at}:subject_never_appears_in_its_messages`);
  }
  return problems;
}

// Resolve an identifier path such as messages[].source_event_id against the schema, so the check
// asks the contract a real question instead of searching its serialised text for a substring.
export function contractCarries(identifier, schema = CONTRACT) {
  const walk = (node, parts) => {
    if (!node || typeof node !== 'object' || parts.length === 0) return true;
    const [head, ...tail] = parts;
    if (node.properties?.[head]) return walk(node.properties[head], tail);
    if (node.items) return walk(node.items, parts);
    return false;
  };
  const parts = identifier.replace(/\[\]/g, '').split('.');
  if (parts.length > 1) return Object.values(schema.$defs ?? {}).some((node) => walk(node, parts));
  // Prose often names a bare field ("`author_id`") that belongs to a nested object, so a bare name
  // counts as carried when any object schema anywhere in the contract declares it.
  const declaredSomewhere = (node, seen = new Set()) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return false;
    seen.add(node);
    if (node.properties && parts[0] in node.properties) return true;
    return Object.values(node).some((child) => declaredSomewhere(child, seen));
  };
  return declaredSomewhere(schema);
}

// The prompt must bind only to identifiers the input contract actually carries, and must not name
// an identifier path that nothing provides.
export function checkPromptInputAgreement(prompt = fs.readFileSync(PROMPT_PATH, 'utf8')) {
  const problems = [];
  for (const binding of BINDINGS) {
    if (!prompt.includes(binding.token)) problems.push(`prompt_does_not_bind_${binding.name}`);
    if (!contractCarries(binding.name))
      problems.push(`input_contract_does_not_carry_${binding.name}`);
  }
  // Only the Input contract section describes where identifiers come from. Identifiers named in
  // the output contract are the model's to fill, and are checked when the output arrives.
  const section = prompt.slice(prompt.indexOf('## Input contract'), prompt.indexOf('## Output contract'));
  for (const match of section.matchAll(/`([a-z_]+(?:\.[a-z_]+|\[\])*)`/g)) {
    const identifier = match[1];
    if (!contractCarries(identifier))
      problems.push(`prompt_names_unknown_input_identifier:${identifier}`);
  }
  return problems;
}

export function preflight(input = loadInput()) {
  const problems = [];
  if (!validateInputShape(input)) {
    for (const error of validateInputShape.errors ?? [])
      problems.push(`schema:${error.keyword}${error.instancePath || ''}`);
  }
  problems.push(...checkPromptInputAgreement());
  problems.push(...checkCaseGraph(input));
  for (const item of input.cases ?? []) {
    if (item?.provenance?.kind === 'anonymized_real'
      && !/^prov_[A-Za-z0-9._-]+$/.test(item.provenance.provenance_claim_ref ?? ''))
      problems.push(`real_case_requires_provenance_claim:${item.case_id}`);
  }
  return [...new Set(problems)];
}

// A model output counts as generated only once it satisfies the output contract and quotes the
// input verbatim. Anything else is refused and stored nowhere.
export function checkOutput(output, stagedCase) {
  const problems = [];
  if (!validateOutputShape(output)) {
    for (const error of validateOutputShape.errors ?? [])
      problems.push(`output_schema:${error.keyword}${error.instancePath || ''}`);
    return problems;
  }
  const ids = new Set((stagedCase.messages ?? []).map((message) => message.source_event_id));
  const authors = new Set((stagedCase.messages ?? []).map((message) => message.author_id));
  const grounded = (text) => (stagedCase.messages ?? []).some((message) => message.text.includes(text));
  const action = output.next_action;
  if (action.situation_id !== stagedCase.situation.situation_id) problems.push('output_invents_situation_id');
  for (const reference of action.evidence_message_ids)
    if (!ids.has(reference)) problems.push(`output_invents_source_event_id:${reference}`);
  for (const span of [...output.hypothesis.evidence, ...output.hypothesis.contradictions]) {
    if (!ids.has(span.source_event_id)) problems.push(`span_invents_source_event_id:${span.source_event_id}`);
    else if (!authors.has(span.author_id)) problems.push(`span_invents_author_id:${span.author_id}`);
    else if (!grounded(span.text)) problems.push(`span_text_is_not_grounded:${span.text}`);
  }
  if (['IGNORE', 'WAIT', 'HANDOFF'].includes(action.decision) && action.draft !== null)
    problems.push(`decision_${action.decision}_must_not_carry_a_draft`);
  if (['PUBLIC_REPLY', 'DM'].includes(action.decision)) {
    if (!action.draft) problems.push(`decision_${action.decision}_requires_a_draft`);
    else {
      if (action.draft.target_id !== stagedCase.subject.author_id)
        problems.push('draft_target_must_be_the_subject');
      for (const reference of action.draft.source_message_ids)
        if (!ids.has(reference)) problems.push(`draft_invents_source_event_id:${reference}`);
      if (action.draft.channel === 'dm' && !stagedCase.situation.allowed_channels.includes('dm'))
        problems.push('draft_channel_is_not_permitted_for_this_situation');
    }
  }
  if (output.hypothesis.text !== null && output.hypothesis.evidence.length === 0)
    problems.push('hypothesis_without_evidence');
  if (output.hypothesis.text === null && output.hypothesis.evidence.length > 0)
    problems.push('evidence_without_hypothesis');
  return problems;
}

export const plan = (input) => (input.cases ?? [])
  .filter((item) => item.model_output === null || item.model_output === undefined)
  .map((item) => ({ case_id: item.case_id, situation_id: item.situation.situation_id,
    anchor: (item.messages ?? []).find((message) => message.is_anchor)?.source_event_id ?? null }));

export const outputProblems = (raw, stagedCase) => {
  let parsed;
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return ['output_is_not_json']; }
  return checkOutput(parsed, stagedCase);
};
