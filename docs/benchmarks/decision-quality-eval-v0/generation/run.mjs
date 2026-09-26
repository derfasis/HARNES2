// The execution phase of the decision-quality evaluation: plan, call, validate, store.
//
// The model call is injected. Nothing here knows how to reach a provider, and with no caller
// supplied the run refuses — so the transport stays a separate, reviewable decision, and the
// pipeline can be exercised end to end against a stub.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generationGate, loadInput, outputProblems, plan, preflight, promptDigest }
  from './staging.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OUTPUTS_DIR = path.join(HERE, 'outputs');

export const EXIT = { refused: 2, invalid: 1, nothing_to_do: 3, done: 0 };

// Store only what the contract accepts. A refused output is written nowhere, so a later run
// cannot mistake a malformed generation for a finished one.
export async function runGeneration({ input = loadInput(), callModel, environment = process.env,
  store = defaultStore, gate = generationGate(environment, input), problems = preflight(input) } = {}) {
  const summary = { stage: 'generation', prompt_sha256: promptDigest(), live_proof: false,
    planned: 0, generated: 0, refused: 0, results: [] };
  if (!gate.allowed) return { exit: EXIT.refused, summary, reasons: gate.reasons };
  if (problems.length > 0) return { exit: EXIT.invalid, summary, problems };
  if (typeof callModel !== 'function')
    return { exit: EXIT.refused, summary,
      reasons: ['no_model_transport_supplied_the_call_is_injected_not_implicit'] };

  const todo = plan(input);
  summary.planned = todo.length;
  for (const item of todo) {
    const raw = await callModel({ prompt: fs.readFileSync(path.join(HERE, 'prompt.md'), 'utf8'),
      case: item, staged: input.cases.find((entry) => entry.case_id === item.case_id) });
    const failures = outputProblems(raw, input.cases.find((entry) => entry.case_id === item.case_id));
    if (failures.length > 0) {
      summary.refused += 1;
      summary.results.push({ case_id: item.case_id, accepted: false, problems: failures });
      continue;
    }
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    store(item.case_id, { raw: typeof raw === 'string' ? raw : JSON.stringify(raw), output: parsed,
      prompt_sha256: summary.prompt_sha256 });
    summary.generated += 1;
    summary.results.push({ case_id: item.case_id, accepted: true, problems: [] });
  }
  return { exit: summary.generated > 0 ? EXIT.done : EXIT.nothing_to_do, summary };
}

function defaultStore() {
  const directory = OUTPUTS_DIR;
  return (caseId, payload) => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${caseId}.json`), JSON.stringify(payload, null, 2));
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // eslint-disable-next-line no-top-level-await
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
    console.error('\nNothing to generate: the staged input holds no ungenerated cases.');
    process.exit(EXIT.nothing_to_do);
  }
}
