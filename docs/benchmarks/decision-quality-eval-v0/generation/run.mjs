// Generation runner for the decision-quality evaluation.
//
// This script does not run by itself. It refuses to start unless the owner has explicitly
// authorised paid model calls, because generation is the one step in this programme that costs
// money and sends text outside the machine. Both gates are checked here rather than trusted.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateCorpus, validateEvaluation } from '../validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROMPT_PATH = path.join(HERE, 'prompt.md');
export const CORPUS_PATH = path.join(HERE, 'corpus.json');

export const promptDigest = () => crypto.createHash('sha256')
  .update(fs.readFileSync(PROMPT_PATH, 'utf8')).digest('hex');

// Two gates, both explicit, neither inferred from configuration that might be set by accident.
export function generationGate(environment = process.env) {
  const reasons = [];
  if (environment.HARNES_OWNER_APPROVED_MODEL_CALLS !== 'yes')
    reasons.push('owner_has_not_authorised_paid_model_calls');
  if (environment.HARNES_EVAL_MAX_COST_USD === undefined)
    reasons.push('no_cost_cap_declared');
  else if (!(Number(environment.HARNES_EVAL_MAX_COST_USD) > 0))
    reasons.push('cost_cap_must_be_positive');
  return { allowed: reasons.length === 0, reasons };
}

export const loadCorpus = () => JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));

// The corpus must be structurally valid *before* anything is sent anywhere. A generation run
// that starts from a corrupted corpus produces a corrupted benchmark with extra steps.
export function preflight(corpus) {
  const problems = validateCorpus(corpus);
  // An offline claim also needs the corpus to stand on its own, checked with the same rules the
  // report will be held to.
  if (corpus?.proof_level === 'offline_human_eval') {
    for (const problem of validateEvaluation(corpus, { case_results: corpus.cases ?? [] }))
      if (!problems.some((existing) => existing.rule === problem.rule)) problems.push(problem);
  }
  return [...new Map(problems.map((problem) => [problem.rule, problem])).values()];
}

export const plan = (corpus) => corpus.cases
  .filter((item) => item.model_output === null || item.model_output === undefined)
  .map((item) => ({ case_id: item.case_id, source_event_id: item.frozen_input.source_event_id ?? null }));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const gate = generationGate();
  const corpus = loadCorpus();
  const problems = preflight(corpus);
  console.log(JSON.stringify({
    stage: 'preflight',
    prompt_sha256: promptDigest(),
    corpus_cases: corpus.cases.length,
    planned_generations: plan(corpus).length,
    structural_problems: problems,
    generation_gate: gate,
    live_proof: false,
  }, null, 2));
  if (!gate.allowed) {
    console.error('\nGeneration refused. Set HARNES_OWNER_APPROVED_MODEL_CALLS=yes and a positive');
    console.error('HARNES_EVAL_MAX_COST_USD only after the owner has authorised them in writing.');
    process.exit(2);
  }
  if (problems.length) {
    console.error('\nRefusing to generate from a structurally invalid corpus.');
    process.exit(1);
  }
  console.error('\nNo generation implemented yet: the corpus has no cases to generate against.');
  process.exit(3);
}
