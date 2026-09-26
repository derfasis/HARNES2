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
import { generationGate, loadInput, outputProblems, plan, preflight, promptDigest }
  from './staging.mjs';

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

export const completedCases = (directory = OUTPUTS_DIR) => {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
};

export async function runGeneration({
  input = loadInput(), callModel, environment = process.env, directory = OUTPUTS_DIR,
  store = fileStore(directory), gate = generationGate(environment, input), problems = preflight(input),
  done = completedCases(directory),
} = {}) {
  const summary = { stage: 'generation', prompt_sha256: promptDigest(), live_proof: false,
    planned: 0, generated: 0, refused: 0, results: [] };
  if (!gate.allowed) return { exit: EXIT.refused, summary, reasons: gate.reasons };
  if (problems.length > 0) return { exit: EXIT.invalid, summary, problems };
  if (typeof callModel !== 'function')
    return { exit: EXIT.refused, summary,
      reasons: ['no_model_transport_supplied_the_call_is_injected_not_implicit'] };

  const todo = plan(input, done);
  summary.planned = todo.length;
  for (const item of todo) {
    const staged = input.cases.find((entry) => entry.case_id === item.case_id);
    const response = await callModel({ prompt: fs.readFileSync(path.join(HERE, 'prompt.md'), 'utf8'),
      case: item, staged });
    const identity = response && typeof response === 'object' && !Array.isArray(response) ? response : {};
    const raw = typeof response === 'string' ? response : identity.raw;
    const failures = [...identityProblems(identity), ...outputProblems(raw, staged)];
    if (failures.length > 0) {
      summary.refused += 1;
      summary.results.push({ case_id: item.case_id, accepted: false, problems: failures });
      continue;
    }
    store(item.case_id, { raw, output: JSON.parse(raw), prompt_sha256: summary.prompt_sha256,
      model_id: identity.model_id, model_version: identity.model_version });
    summary.generated += 1;
    summary.results.push({ case_id: item.case_id, accepted: true, problems: [] });
  }
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
