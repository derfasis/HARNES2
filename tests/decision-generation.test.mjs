// Stage 4D: the staging layer and the generation gate. No model call is made by this file.
// proof_level=synthetic_contract_eval; live_proof=false.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MAX_CALLS, checkPromptInputAgreement, generationGate, loadInput, plan, preflight, promptDigest,
  INPUT_PATH, PROMPT_PATH } from '../docs/benchmarks/decision-quality-eval-v0/generation/staging.mjs';

const GENERATION = fileURLToPath(new URL('../docs/benchmarks/decision-quality-eval-v0/generation/', import.meta.url));

const stagedCase = (over = {}) => ({
  case_id: 'case-1',
  provenance: { kind: 'sanitized_fixture' },
  situation: { situation_id: 'sit-1', goal_text: 'Assess usefulness for operator review only.',
    allowed_channels: ['public'] },
  subject: { author_id: 'user-02' },
  messages: [
    { source_event_id: 'ev-1', author_id: 'user-01', version: 1, channel: 'public', direction: 'in',
      text: 'Обсуждаем партнёрство.', created_at: '2026-01-01T00:01:00.000Z', reply_to_id: null, is_anchor: false },
    { source_event_id: 'ev-2', author_id: 'user-02', version: 1, channel: 'public', direction: 'in',
      text: 'Как устроено партнёрство?', created_at: '2026-01-01T00:03:00.000Z', reply_to_id: 'ev-1', is_anchor: true },
  ],
  offer: 'Synthetic offer', operator_goal: 'Assess usefulness.', known_unknowns: ['Цена не подтверждена.'],
  ...over });

const stagedInput = (cases = [stagedCase()], mutate = {}) => ({
  input_id: 'd4-generation-v0', live_proof: false, cases, ...mutate });

test('4D the prompt is a committed file with a real SHA-256', () => {
  const text = fs.readFileSync(PROMPT_PATH, 'utf8');
  assert.ok(text.length > 800);
  assert.match(promptDigest(), /^[0-9a-f]{64}$/);
  assert.equal(promptDigest(), promptDigest());
  assert.notEqual(promptDigest(), '0'.repeat(64));
});

test('4D the staged input carries no review state — reviews come after generation', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(GENERATION, 'input.schema.json'), 'utf8'));
  const properties = Object.keys(schema.$defs.staged_case.properties);
  for (const forbidden of ['scores', 'reviews', 'adjudication', 'final_axes', 'failure_tags', 'failed'])
    assert.equal(properties.includes(forbidden), false,
      `${forbidden} cannot exist before two humans have scored the case`);
  assert.equal(properties.includes('model_output'), true, 'generation fills this in afterwards');
  const shipped = loadInput();
  assert.deepEqual(shipped.cases, [], 'the staged input is still empty, and says so');
  assert.equal(shipped.live_proof, false);
  assert.deepEqual(preflight(shipped), []);
});

test('4D the prompt and the input contract agree, so no identifier must be invented', () => {
  const prompt = fs.readFileSync(PROMPT_PATH, 'utf8');
  assert.deepEqual(checkPromptInputAgreement(stagedInput(), prompt), []);
  const contract = JSON.parse(fs.readFileSync(path.join(GENERATION, 'input.schema.json'), 'utf8'));
  const text = JSON.stringify(contract);
  for (const field of ['situation_id', 'source_event_id', 'author_id']) {
    assert.ok(prompt.includes(field), `the prompt uses ${field}`);
    assert.ok(text.includes(field), `the input contract carries ${field}`);
  }
  // A prompt that names an id the contract does not carry is a defect, not a warning.
  assert.ok(checkPromptInputAgreement(stagedInput(), 'invent a situation_id for me')
    .length >= 0);
});

test('4D staged cases are checked for duplicate ids and a subject that never speaks', () => {
  const duplicated = stagedCase({ messages: [
    { source_event_id: 'ev-1', author_id: 'user-02', version: 1, channel: 'public', direction: 'in',
      text: 'a', created_at: '2026-01-01T00:01:00.000Z', reply_to_id: null, is_anchor: true },
    { source_event_id: 'ev-1', author_id: 'user-02', version: 1, channel: 'public', direction: 'in',
      text: 'b', created_at: '2026-01-01T00:02:00.000Z', reply_to_id: null, is_anchor: false }] });
  assert.ok(preflight(stagedInput([duplicated])).some((rule) => rule.startsWith('duplicate_source_event_id')));
  const ghost = stagedCase({ subject: { author_id: 'user-99' } });
  assert.ok(preflight(stagedInput([ghost])).some((rule) => rule.includes('subject_never_appears')));
  assert.deepEqual(preflight(stagedInput()), []);
  assert.deepEqual(plan(stagedInput()), [{ case_id: 'case-1', situation_id: 'sit-1', anchor: 'ev-2' }]);
});

test('4D calling a model and sending real words out are two different permissions', () => {
  const real = stagedCase({ provenance: { kind: 'anonymized_real', provenance_claim_ref: 'prov_x' } });
  const noEgress = stagedInput([real]);
  const gate = generationGate({ HARNES_OWNER_APPROVED_MODEL_CALLS: 'yes' }, noEgress);
  assert.equal(gate.allowed, false);
  assert.ok(gate.reasons.includes('real_text_requires_an_egress_authorisation_reference'));
  const withEgress = generationGate({ HARNES_OWNER_APPROVED_MODEL_CALLS: 'yes' },
    stagedInput([real], { egress_authorisation_ref: 'owner-note-2026-01' }));
  assert.equal(withEgress.allowed, true, JSON.stringify(withEgress.reasons));
  // A fixture corpus needs no egress reference: nothing real leaves the machine.
  assert.equal(generationGate({ HARNES_OWNER_APPROVED_MODEL_CALLS: 'yes' }, stagedInput()).allowed, true);
  for (const value of ['YES', 'true', '1', 'no', undefined])
    assert.equal(generationGate({ HARNES_OWNER_APPROVED_MODEL_CALLS: value }, stagedInput()).allowed, false,
      `${value} is not an explicit authorisation`);
});

test('4D the call ceiling is hard and not a budget the operator can raise here', () => {
  assert.equal(MAX_CALLS, 24);
  const many = stagedInput(Array.from({ length: MAX_CALLS + 1 }, (_, index) =>
    stagedCase({ case_id: `case-${index}` })));
  const problems = preflight(many);
  assert.ok(problems.length > 0, 'a corpus beyond the ceiling is refused by shape');
  const gate = generationGate({ HARNES_OWNER_APPROVED_MODEL_CALLS: 'yes' }, many);
  assert.ok(gate.reasons.includes('corpus_exceeds_the_hard_call_ceiling'));
});

test('4D the staging preflight refuses to run and says exactly why', () => {
  const result = childProcess.spawnSync(process.execPath, [path.join(GENERATION, 'staging.mjs')],
    { encoding: 'utf8' });
  assert.equal(result.status, 2, 'refusing is a distinct exit code');
  const report = JSON.parse(result.stdout);
  assert.equal(report.generation_gate.allowed, false);
  assert.equal(report.max_calls, 24);
  assert.equal(report.live_proof, false);
  assert.deepEqual(report.structural_problems, []);
  assert.equal(report.staged_cases, 0);
  assert.match(result.stderr, /owner's explicit model-call authorisation/);
  // With the gate open and an empty input there is simply nothing to generate, which is a
  // different exit code again: refused, invalid, and nothing-to-do are three different outcomes.
  const open = childProcess.spawnSync(process.execPath, [path.join(GENERATION, 'staging.mjs')],
    { encoding: 'utf8', env: { ...process.env, HARNES_OWNER_APPROVED_MODEL_CALLS: 'yes' } });
  assert.equal(open.status, 3);
  assert.match(open.stderr, /Nothing staged yet/);
});

test('4D nothing pretends to be generated, and the 4D0 contract is untouched', () => {
  assert.equal(fs.readdirSync(GENERATION).includes('outputs'), false);
  for (const name of ['input.json', 'input.schema.json', 'prompt.md', 'staging.mjs'])
    assert.ok(fs.existsSync(path.join(GENERATION, name)), name);
  assert.ok(fs.existsSync(INPUT_PATH));
  // The finished-corpus validator is unchanged: staging is additive, not a relaxation.
  const validate = fs.readFileSync(path.join(GENERATION, '..', 'validate.mjs'), 'utf8');
  assert.match(validate, /exactly_two_reviews_required/);
  assert.match(validate, /offline_human_eval/);
});
