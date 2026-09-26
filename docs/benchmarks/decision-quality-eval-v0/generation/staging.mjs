// The staging layer between a permitted source and the frozen evaluation corpus.
//
// The 4D0 corpus is the *finished* artefact: it carries model output, two human reviews, the
// adjudication, and the published scores. Using it as the input to generation was wrong — a case
// cannot have human reviews before anyone has reviewed it. So generation reads a staging input
// that holds only what the model is allowed to see, and the 4D0 corpus is assembled afterwards,
// once two real people have scored the case.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ajv = new Ajv({ strict: false });
const validateInputShape = ajv.compile(JSON.parse(fs.readFileSync(path.join(HERE, 'input.schema.json'), 'utf8')));

export const PROMPT_PATH = path.join(HERE, 'prompt.md');
export const INPUT_PATH = path.join(HERE, 'input.json');

export const promptDigest = () => crypto.createHash('sha256')
  .update(fs.readFileSync(PROMPT_PATH, 'utf8')).digest('hex');
export const loadInput = () => JSON.parse(fs.readFileSync(INPUT_PATH, 'utf8'));

// Hard ceiling on how many model calls one evaluation may spend, whatever the operator says.
export const MAX_CALLS = 24;

// Two separate permissions, because they are two separate things:
//   * calling a model at all, and
//   * sending real third-party text out of this machine.
// The first is not the second, and a corpus of real conversations needs both.
export function generationGate(environment = process.env, input = loadInput()) {
  const reasons = [];
  if (environment.HARNES_OWNER_APPROVED_MODEL_CALLS !== 'yes')
    reasons.push('owner_has_not_authorised_model_calls');
  const cases = Array.isArray(input?.cases) ? input.cases : [];
  const realCases = cases.filter((item) => item?.provenance?.kind === 'anonymized_real');
  if (realCases.length > 0 && !(typeof input.egress_authorisation_ref === 'string'
    && input.egress_authorisation_ref.length >= 8))
    reasons.push('real_text_requires_an_egress_authorisation_reference');
  if (cases.length > MAX_CALLS) reasons.push('corpus_exceeds_the_hard_call_ceiling');
  return { allowed: reasons.length === 0, reasons, cases: cases.length, real_cases: realCases.length };
}

// The prompt may only name identifiers the input contract actually carries. Comparing against the
// contract, not against the current file, is what makes the check meaningful while the corpus is
// still empty: an empty file proves nothing either way.
export function checkPromptInputAgreement(input, prompt) {
  const problems = [];
  const contract = JSON.stringify(JSON.parse(fs.readFileSync(path.join(HERE, 'input.schema.json'), 'utf8')));
  for (const field of ['situation_id', 'source_event_id', 'author_id']) {
    if (prompt.includes(field) && !contract.includes(field))
      problems.push(`prompt_names_${field}_but_the_input_contract_does_not_carry_it`);
  }
  const ids = new Set();
  for (const item of input.cases ?? []) {
    for (const message of item.messages ?? []) {
      if (ids.has(message.source_event_id)) problems.push(`duplicate_source_event_id:${message.source_event_id}`);
      ids.add(message.source_event_id);
    }
    const subject = item.subject?.author_id;
    if (subject && !(item.messages ?? []).some((message) => message.author_id === subject))
      problems.push(`case_${item.case_id}_subject_never_appears_in_its_messages`);
  }
  return problems;
}

export function preflight(input = loadInput()) {
  const problems = [];
  if (!validateInputShape(input)) {
    for (const error of validateInputShape.errors ?? []) problems.push(`schema:${error.keyword}${error.instancePath || ''}`);
  }
  const prompt = fs.readFileSync(PROMPT_PATH, 'utf8');
  problems.push(...checkPromptInputAgreement(input, prompt));
  for (const item of input.cases ?? []) {
    if (item?.provenance?.kind === 'anonymized_real'
      && !/^prov_[A-Za-z0-9._-]+$/.test(item.provenance.provenance_claim_ref ?? ''))
      problems.push(`real_case_requires_provenance_claim:${item.case_id}`);
  }
  return [...new Set(problems)];
}

// The plan is what generation *would* do, and it is what the call budget is checked against.
export const plan = (input) => (input.cases ?? [])
  .filter((item) => item.model_output === null || item.model_output === undefined)
  .map((item) => ({ case_id: item.case_id, situation_id: item.situation.situation_id,
    anchor: (item.messages ?? []).find((message) => message.is_anchor)?.source_event_id ?? null }));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = loadInput();
  const problems = preflight(input);
  const gate = generationGate(process.env, input);
  console.log(JSON.stringify({
    stage: 'preflight',
    prompt_sha256: promptDigest(),
    staged_cases: (input.cases ?? []).length,
    planned_generations: plan(input).length,
    max_calls: MAX_CALLS,
    structural_problems: problems,
    generation_gate: gate,
    live_proof: false,
  }, null, 2));
  if (!gate.allowed) {
    console.error('\nGeneration refused. It needs the owner\'s explicit model-call authorisation,');
    console.error('an egress reference for real third-party text, and a corpus within the call ceiling.');
    process.exit(2);
  }
  if (problems.length) {
    console.error('\nRefusing to generate from an invalid input.');
    process.exit(1);
  }
  console.error('\nNothing staged yet: input.json holds no cases.');
  process.exit(3);
}
