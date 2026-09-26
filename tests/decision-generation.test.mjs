// Stage 4D: the generation path is prepared but gated, and the gate must be real.
// proof_level=synthetic_contract_eval; live_proof=false. No model call is made by this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generationGate, loadCorpus, plan, preflight, promptDigest, PROMPT_PATH, CORPUS_PATH }
  from '../docs/benchmarks/decision-quality-eval-v0/generation/run.mjs';

const GENERATION = fileURLToPath(new URL('../docs/benchmarks/decision-quality-eval-v0/generation/', import.meta.url));

test('4D the prompt is a committed file with a real digest', () => {
  const text = fs.readFileSync(PROMPT_PATH, 'utf8');
  assert.ok(text.length > 500, 'the prompt is committed, not assembled at runtime');
  const digest = promptDigest();
  assert.match(digest, /^[0-9a-f]{64}$/, 'the identity of an evaluation is a real SHA-256');
  assert.equal(digest, promptDigest(), 'the digest is stable across calls');
  assert.notEqual(digest, '0'.repeat(64));
});

test('4D generation is refused without an explicit owner authorisation and a cost cap', () => {
  const refused = generationGate({});
  assert.equal(refused.allowed, false);
  assert.ok(refused.reasons.includes('owner_has_not_authorised_paid_model_calls'));
  assert.ok(refused.reasons.includes('no_cost_cap_declared'));
  // A cap that is zero, negative, or a word is not a cap.
  for (const cap of ['0', '-5', 'free', '']) {
    const gate = generationGate({ HARNES_OWNER_APPROVED_MODEL_CALLS: 'yes', HARNES_EVAL_MAX_COST_USD: cap });
    assert.equal(gate.allowed, false, `cap ${JSON.stringify(cap)} must not unlock generation`);
  }
  const allowed = generationGate({ HARNES_OWNER_APPROVED_MODEL_CALLS: 'yes', HARNES_EVAL_MAX_COST_USD: '5' });
  assert.equal(allowed.allowed, true, JSON.stringify(allowed.reasons));
  // Anything other than an explicit yes stays shut.
  for (const value of ['YES', 'true', '1', 'no', undefined])
    assert.equal(generationGate({ HARNES_OWNER_APPROVED_MODEL_CALLS: value,
      HARNES_EVAL_MAX_COST_USD: '5' }).allowed, false, `${value} is not an explicit authorisation`);
});

test('4D preflight refuses to generate from a structurally invalid corpus', () => {
  const corpus = loadCorpus();
  assert.deepEqual(corpus.cases, [], 'the generation corpus is still empty, and says so');
  assert.equal(corpus.live_proof, false);
  assert.deepEqual(preflight(corpus), []);
  const emptyOffline = { ...corpus, proof_level: 'offline_human_eval' };
  assert.ok(preflight(emptyOffline).map((problem) => problem.rule)
    .includes('offline_eval_requires_cases'), 'an offline claim with no cases is refused before generation');
  const broken = { ...corpus, proof_level: 'offline_human_eval', cases: [{ case_id: 'x' }] };
  const problems = preflight(broken).map((problem) => problem.rule);
  assert.ok(problems.length > 0);
  assert.ok(problems.includes('frozen_input_required'));
  assert.ok(problems.includes('offline_eval_case_must_be_anonymized_real'));
  assert.deepEqual(plan(corpus), [], 'nothing to generate against, and the plan says so');
});

test('4D the runner refuses to start without the gate, whatever the corpus holds', () => {
  const child = childProcess;
  const result = child.spawnSync(process.execPath, [path.join(GENERATION, 'run.mjs')], { encoding: 'utf8' });
  assert.equal(result.status, 2, 'refusing is a distinct exit code, not a crash');
  const report = JSON.parse(result.stdout);
  assert.equal(report.generation_gate.allowed, false);
  assert.equal(report.live_proof, false);
  assert.match(result.stderr, /owner has authorised/i);
});

test('4D no generation output may exist while the corpus is empty', () => {
  const files = fs.readdirSync(GENERATION);
  assert.equal(files.includes('outputs'), false, 'no output is invented before anything is generated');
  assert.ok(files.includes('corpus.json'));
  assert.ok(files.includes('run.mjs'));
  assert.ok(files.includes('prompt.md'));
});
