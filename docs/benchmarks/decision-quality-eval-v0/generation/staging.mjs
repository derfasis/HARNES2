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

export const AXES = ['grounding', 'intent_understanding', 'calibration', 'relevance',
  'decision_quality', 'operator_usefulness'];

export const PROMPT_PATH = path.join(HERE, 'prompt.md');
export const INPUT_PATH = path.join(HERE, 'input.json');
export const CONTRACT = read('input.schema.json');

export const promptDigest = () => crypto.createHash('sha256')
  .update(fs.readFileSync(PROMPT_PATH, 'utf8')).digest('hex');

// The exact staged case a generation answered. If any part of the case changes — the offer, the
// goal, a known unknown — the stored answer is an answer to a different question and is not complete.
export const stagedCaseDigest = (stagedCase) => crypto.createHash('sha256')
  .update(JSON.stringify(stagedCase)).digest('hex');
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

// The decision names exactly one channel. Comparing the words directly would be wrong:
// PUBLIC_REPLY is not spelled "public".
const DECISION_CHANNEL = { PUBLIC_REPLY: 'public', DM: 'dm' };

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
  // A prompt reference costs nothing to supply and cannot be invented later, so a non-empty corpus
  // must name it now — otherwise real calls would be spent against a corpus that cannot be closed.
  if (Array.isArray(input?.cases) && input.cases.length > 0
    && (typeof input.prompt_ref !== 'string' || !input.prompt_ref))
    problems.push('non_empty_generation_input_must_name_its_prompt');
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
  // Every attribute of a span is checked against the one message its source_event_id names.
  // Checking them independently would let a span borrow an id from one message, an author from
  // another and a text from a third.
  const byId = new Map((stagedCase.messages ?? []).map((message) => [message.source_event_id, message]));
  const ids = new Set(byId.keys());
  const action = output.next_action;
  if (action.situation_id !== stagedCase.situation.situation_id) problems.push('output_invents_situation_id');
  for (const reference of action.evidence_message_ids)
    if (!ids.has(reference)) problems.push(`output_invents_source_event_id:${reference}`);
  for (const span of [...output.hypothesis.evidence, ...output.hypothesis.contradictions]) {
    const message = byId.get(span.source_event_id);
    if (!message) { problems.push(`span_invents_source_event_id:${span.source_event_id}`); continue; }
    if (span.author_id !== message.author_id)
      problems.push(`span_author_does_not_belong_to_its_message:${span.source_event_id}`);
    if (span.version !== message.version)
      problems.push(`span_version_does_not_match_its_message:${span.source_event_id}`);
    if (!message.text.includes(span.text))
      problems.push(`span_text_is_not_grounded_in_its_own_message:${span.source_event_id}`);
  }
  if (['IGNORE', 'WAIT', 'HANDOFF'].includes(action.decision) && action.draft !== null)
    problems.push(`decision_${action.decision}_must_not_carry_a_draft`);
  if (['PUBLIC_REPLY', 'DM'].includes(action.decision)) {
    if (!action.draft) problems.push(`decision_${action.decision}_requires_a_draft`);
    else {
      // The decision and the channel are one claim: they cannot disagree, and the channel has to
      // be one the situation actually permits.
      if (action.draft.channel !== DECISION_CHANNEL[action.decision])
        problems.push(`draft_channel_does_not_match_decision_${action.decision}`);
      if (!stagedCase.situation.allowed_channels.includes(action.draft.channel))
        problems.push(`draft_channel_is_not_permitted_for_this_situation:${action.draft.channel}`);
      if (action.draft.target_id !== stagedCase.subject.author_id)
        problems.push('draft_target_must_be_the_subject');
      for (const reference of action.draft.source_message_ids)
        if (!ids.has(reference)) problems.push(`draft_invents_source_event_id:${reference}`);
    }
  }
  if (output.hypothesis.text !== null && output.hypothesis.evidence.length === 0)
    problems.push('hypothesis_without_evidence');
  if (output.hypothesis.text === null && output.hypothesis.evidence.length > 0)
    problems.push('evidence_without_hypothesis');
  return problems;
}

// A stored artefact only counts as complete when it is actually ours, from this prompt, and still
// valid against this case. A file name is not evidence of anything: a stale output from an older
// prompt, a hand-made file, or a corrupt one must all be re-generated rather than trusted.
export const completedOutputs = (input, artefacts, digest = promptDigest()) => {
  const completed = new Map();
  for (const [caseId, artefact] of Object.entries(artefacts ?? {})) {
    const staged = (input.cases ?? []).find((item) => item.case_id === caseId);
    if (!staged) continue;
    if (!artefact || typeof artefact !== 'object') continue;
    if (artefact.prompt_sha256 !== digest) continue;
    if (artefact.staged_case_sha256 !== stagedCaseDigest(staged)) continue;
    if (typeof artefact.model_id !== 'string' || !artefact.model_id
      || typeof artefact.model_version !== 'string' || !artefact.model_version) continue;
    if (outputProblems(artefact.raw, staged).length > 0) continue;
    completed.set(caseId, { model_id: artefact.model_id, model_version: artefact.model_version });
  }
  return completed;
};

// One evaluation, one model. Artefacts left behind by different runs are refused outright rather
// than quietly reported as finished work under no single identity.
export const mixedIdentities = (completed) => {
  const identities = new Set([...completed.values()].map((value) => `${value.model_id}@${value.model_version}`));
  return identities.size > 1 ? [...identities] : null;
};

// The staged input is immutable, so completion lives in the persisted outputs.
export const plan = (input, completed = new Map()) => {
  const done = completed instanceof Map ? completed : new Map(Object.entries(completed ?? {}));
  return (input.cases ?? [])
    .filter((item) => !done.has(item.case_id))
    .map((item) => ({ case_id: item.case_id, situation_id: item.situation.situation_id,
      anchor: (item.messages ?? []).find((message) => message.is_anchor)?.source_event_id ?? null }));
};

// The transport hands back text. Anything else — an object, a number, undefined — is a refusal,
// not something to hand to a parser and hope for.
export const parseRaw = (raw) => {
  if (typeof raw !== 'string') return { parsed: null, problems: ['raw_must_be_the_text_the_runtime_returned'] };
  try { return { parsed: JSON.parse(raw), problems: [] }; }
  catch { return { parsed: null, problems: ['output_is_not_json'] }; }
};

export const outputProblems = (raw, stagedCase) => {
  const { parsed, problems } = parseRaw(raw);
  return problems.length ? problems : checkOutput(parsed, stagedCase);
};
