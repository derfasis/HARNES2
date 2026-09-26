// The execution phase of the decision-quality evaluation: plan, call, validate, store.
//
// The model call is injected. Nothing here knows how to reach a provider, and with no caller
// supplied the run refuses — so the transport stays a separate, reviewable decision, and the
// pipeline can be exercised end to end against a stub.
//
// The transport contract is explicit: a call returns the raw text it received together with the
// model identity the runtime actually reported. Filling a model id in by hand later is exactly
// what this programme forbids.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_CALLS, completedOutputs, generationGate, loadInput, mixedIdentities, outputProblems,
  parseRaw, plan, preflight, promptDigest, stagedCaseDigest } from './staging.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OUTPUTS_DIR = path.join(HERE, 'outputs');

export const EXIT = { refused: 2, invalid: 1, nothing_to_do: 3, done: 0 };

// A generation is only acceptable with an identity the runtime stated. Silence is a refusal.
export const identityProblems = (identity) => {
  const problems = [];
  for (const key of ['model_id', 'model_version']) {
    if (typeof identity?.[key] !== 'string' || identity[key].length === 0)
      problems.push(`runtime_did_not_report_${key}`);
  }
  return problems;
};

export const fileStore = (directory = OUTPUTS_DIR) => (caseId, payload) => {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${caseId}.json`), JSON.stringify(payload, null, 2));
};

// Read the stored artefacts. A file that does not parse is reported as absent-with-a-reason rather
// than crashing the run, so a corrupt directory leads to regeneration, never to a silent skip.
export const readArtefacts = (directory = OUTPUTS_DIR) => {
  const artefacts = {};
  if (!fs.existsSync(directory)) return artefacts;
  for (const name of fs.readdirSync(directory)) {
    // The ledger is bookkeeping, not a generated artefact.
    if (!name.endsWith('.json') || name === LEDGER_FILE) continue;
    try { artefacts[name.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); }
    catch { artefacts[name.slice(0, -5)] = null; }
  }
  return artefacts;
};

// A call ledger that survives a run. A ceiling over stored outputs is not a ceiling over calls:
// a refused output stores nothing, and an uncounted rerun would quietly double the spend.
export const LEDGER_FILE = 'attempts.json';
// A ledger that cannot be read is not an empty ledger. Failing open here would hand the
// evaluation a fresh budget every time the file is damaged, which is the opposite of a ceiling.
export const readLedger = (directory = OUTPUTS_DIR) => {
  const file = path.join(directory, LEDGER_FILE);
  if (!fs.existsSync(file)) return { calls: 0, by_case: {} };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { corrupted: 'ledger_is_not_json' }; }
  const problems = [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) problems.push('ledger_must_be_an_object');
  else {
    if (!Number.isInteger(parsed.calls) || parsed.calls < 0 || parsed.calls > MAX_CALLS)
      problems.push('ledger_calls_must_be_an_integer_within_the_ceiling');
    if (!parsed.by_case || typeof parsed.by_case !== 'object' || Array.isArray(parsed.by_case))
      problems.push('ledger_by_case_must_be_an_object');
    else for (const [key, value] of Object.entries(parsed.by_case))
      if (!Number.isInteger(value) || value < 0) problems.push(`ledger_by_case_${key}_must_be_a_count`);
  }
  return problems.length ? { corrupted: problems[0] } : parsed;
};
export const writeLedger = (directory, ledger) => {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, LEDGER_FILE), JSON.stringify(ledger, null, 2));
};

export async function runGeneration({
  input = loadInput(), callModel, environment = process.env, directory = OUTPUTS_DIR,
  store = fileStore(directory),
  // The gate and the preflight run first, on purpose: persisted state is only read once the
  // staged corpus is known to be sound, because validating an artefact against a broken case
  // would reach into fields that do not exist.
  gate = null, problems = null, done = null, ledger = null,
} = {}) {
  const effectiveGate = gate ?? generationGate(environment, input);
  const effectiveProblems = problems ?? preflight(input);
  const summary = { stage: 'generation', prompt_sha256: promptDigest(), live_proof: false,
    planned: 0, generated: 0, refused: 0, results: [] };
  if (!effectiveGate.allowed) return { exit: EXIT.refused, summary, reasons: effectiveGate.reasons };
  if (effectiveProblems.length > 0) return { exit: EXIT.invalid, summary, problems: effectiveProblems };
  if (effectiveGate.allowed && !effectiveProblems.length) {
    const early = ledger ?? readLedger(directory);
    if (early.corrupted) return { exit: EXIT.invalid, summary,
      problems: [{ at: LEDGER_FILE, rule: `corrupted_ledger_never_restores_the_budget:${early.corrupted}` }] };
  }
  const completed = done ?? completedOutputs(input, readArtefacts(directory));
  const attempts = ledger ?? readLedger(directory);
  summary.calls_made = 0;
  summary.calls_budget = MAX_CALLS;
  // Artefacts from more than one model describe more than one evaluation, whatever the plan says.
  const mixed = mixedIdentities(completed);
  if (mixed) return { exit: EXIT.invalid, summary,
    problems: [{ at: 'outputs', rule: `stored_artefacts_span_several_models:${mixed.join(',')}` }] };
  if (typeof callModel !== 'function')
    return { exit: EXIT.refused, summary,
      reasons: ['no_model_transport_supplied_the_call_is_injected_not_implicit'] };

  // One evaluation, one model. The identity is frozen by whatever was already accepted, and if
  // nothing is stored yet, by the first accepted call. A later case from another model is refused
  // and written nowhere, because a corpus that mixes models cannot be attributed to any of them.
  const frozen = completed.size > 0 ? [...completed.values()][0] : null;
  // The budget counts every call the runtime was asked to make, refused ones included, and the
  // plan is trimmed to what is left: a plan one longer than the remaining budget must not overshoot.
  if (attempts.calls >= MAX_CALLS) return { exit: EXIT.refused, summary,
    reasons: ['model_call_ceiling_reached_no_further_calls_will_be_made'] };
  const todo = plan(input, completed).slice(0, Math.max(0, MAX_CALLS - attempts.calls));
  summary.planned = todo.length;
  let runIdentity = frozen ?? null;
  for (const item of todo) {
    const staged = input.cases.find((entry) => entry.case_id === item.case_id);
    // The attempt is persisted before the call, so a transport that dies mid-flight still costs.
    attempts.calls += 1;
    attempts.by_case[item.case_id] = (attempts.by_case[item.case_id] ?? 0) + 1;
    summary.calls_made += 1;
    writeLedger(directory, attempts);
    let response;
    try {
      response = await callModel({ prompt: fs.readFileSync(path.join(HERE, 'prompt.md'), 'utf8'),
        case: item, staged });
    } catch (error) {
      // A transport that throws is a refusal of this case, not a reason to lose the whole run.
      summary.refused += 1;
      summary.results.push({ case_id: item.case_id, accepted: false,
        problems: [`model_transport_call_failed:${error?.message ?? 'unknown'}`] });
      continue;
    }
    const identity = response && typeof response === 'object' && !Array.isArray(response) ? response : {};
    const { parsed, problems: parseProblems } = parseRaw(identity.raw);
    const failures = [...identityProblems(identity), ...parseProblems,
      ...(parseProblems.length ? [] : outputProblems(identity.raw, staged))];
    if (runIdentity && (identity.model_id !== runIdentity.model_id
      || identity.model_version !== runIdentity.model_version))
      failures.push('this_evaluation_is_frozen_to_another_model');
    if (failures.length > 0) {
      summary.refused += 1;
      summary.results.push({ case_id: item.case_id, accepted: false, problems: failures });
      continue;
    }
    runIdentity ??= { model_id: identity.model_id, model_version: identity.model_version };
    // `raw` is the only stored truth. The parsed object is derived on demand, so a hand-edited
    // `output` field can never disagree with the text the model actually produced.
    store(item.case_id, { raw: identity.raw, prompt_sha256: summary.prompt_sha256,
      staged_case_sha256: stagedCaseDigest(staged),
      model_id: identity.model_id, model_version: identity.model_version });
    summary.generated += 1;
    summary.results.push({ case_id: item.case_id, accepted: true, problems: [] });
  }
  summary.model_id = runIdentity?.model_id ?? null;
  summary.model_version = runIdentity?.model_version ?? null;
  summary.calls_total = attempts.calls;
  writeLedger(directory, attempts);
  return { exit: summary.generated > 0 ? EXIT.done : EXIT.nothing_to_do, summary };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runGeneration();
  console.log(JSON.stringify({ ...result.summary, exit: result.exit, reasons: result.reasons,
    problems: result.problems }, null, 2));
  if (result.exit === EXIT.refused) {
    console.error('\nGeneration refused: ' + (result.reasons ?? []).join(', '));
    process.exit(EXIT.refused);
  }
  if (result.exit === EXIT.invalid) {
    console.error('\nRefusing to generate from an invalid input.');
    process.exit(EXIT.invalid);
  }
  if (result.exit === EXIT.nothing_to_do) {
    console.error('\nNothing to generate: every staged case already has a stored output.');
    process.exit(EXIT.nothing_to_do);
  }
}
