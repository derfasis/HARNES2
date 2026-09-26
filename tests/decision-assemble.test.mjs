// Stage 4D assembly: staged input + generated output + human reviews become the finished corpus,
// and the report is derived from that corpus alone.
// proof_level=synthetic_contract_eval; live_proof=false. No model call, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AXES, promptDigest, stagedCaseDigest } from '../docs/benchmarks/decision-quality-eval-v0/generation/staging.mjs';
import { REVIEW_PROTOCOL, assembleCorpus, deriveReport } from '../docs/benchmarks/decision-quality-eval-v0/generation/assemble.mjs';
import { validateCorpus, validateEvaluation, validateReport } from '../docs/benchmarks/decision-quality-eval-v0/validate.mjs';

const axes = (value = 2) => Object.fromEntries(AXES.map((axis) => [axis, value]));

const stagedCase = (over = {}) => ({
  case_id: 'case-1',
  provenance: { kind: 'anonymized_real', provenance_claim_ref: 'prov_source_1' },
  situation: { situation_id: 'sit-1', goal_text: 'Assess usefulness.', allowed_channels: ['public'] },
  subject: { author_id: 'user-02' },
  messages: [
    { source_event_id: 'ev-1', author_id: 'user-01', version: 1, channel: 'public', direction: 'in',
      text: 'Обсуждаем партнёрство.', created_at: '2026-01-01T00:00:00.000Z', reply_to_id: null, is_anchor: false },
    { source_event_id: 'ev-2', author_id: 'user-02', version: 1, channel: 'public', direction: 'in',
      text: 'Как устроено партнёрство?', created_at: '2026-01-01T00:03:00.000Z', reply_to_id: 'ev-1', is_anchor: true }],
  offer: 'Synthetic offer', operator_goal: 'Assess usefulness.', known_unknowns: ['Цена не подтверждена.'],
  ...over });

const modelOutput = (over = {}) => ({
  hypothesis: { text: 'Возможно, нужен разбор.', evidence: [
    { source_event_id: 'ev-2', author_id: 'user-02', version: 1, text: 'Как устроено партнёрство?',
      kind: 'question', attribution: 'author_statement' }], contradictions: [], unknowns: [] },
  next_action: { schema_version: 1, situation_id: 'sit-1', decision: 'WAIT', confidence: 0.4,
    strategy: 'Подождать.', reason: 'Нужны детали.', evidence_message_ids: ['ev-2'], unknowns: [],
    risk_flags: [], draft: null, review: { required: true, status: 'pending', authorization: 'none' },
    reevaluate_after: null },
  authority: { contact_permission: false, allowed_effects: [] }, ...over });

const artefact = (staged, over = {}) => ({ raw: JSON.stringify(modelOutput()), prompt_sha256: promptDigest(),
  staged_case_sha256: stagedCaseDigest(staged), model_id: 'served-model', model_version: 'served-1', ...over });

const humanReview = (reviewer, over = {}) => ({ reviewer, protocol: REVIEW_PROTOCOL, axes: axes(),
  failure_tags: [], ...over });

const input = (cases = [stagedCase()], mutate = {}) => ({
  input_id: 'd4-generation-v0', live_proof: false, prompt_ref: 'prompt-7', cases, ...mutate });

test('4D a finished corpus is assembled from staged input, a valid artefact and two human reviews', () => {
  const staged = stagedCase();
  const { corpus, problems } = assembleCorpus({ input: input(), artefacts: { 'case-1': artefact(staged) },
    reviews: { 'case-1': [humanReview('anna'), humanReview('boris')] } });
  assert.deepEqual(problems, [], JSON.stringify(problems));
  assert.equal(corpus.proof_level, 'offline_human_eval');
  assert.equal(corpus.live_proof, false);
  assert.equal(corpus.generation.model_id, 'served-model');
  assert.equal(corpus.generation.prompt_digest, promptDigest());
  assert.equal(corpus.cases.length, 1);
  assert.equal(corpus.cases[0].scores.length, 2);
  assert.deepEqual(Object.keys(corpus.cases[0].final_axes).sort(), [...AXES].sort());
  assert.deepEqual(validateCorpus(corpus), [], 'the assembled corpus must satisfy the finished contract');
  assert.equal(corpus.generation.prompt_ref, 'prompt-7');
  // A staged input that never named a prompt cannot produce a corpus claiming one.
  const unnamed = assembleCorpus({ input: input(undefined, { prompt_ref: undefined }),
    artefacts: { 'case-1': artefact(staged) },
    reviews: { 'case-1': [humanReview('anna'), humanReview('boris')] } });
  assert.equal(unnamed.corpus, null);
  assert.ok(unnamed.problems.includes('the_staged_input_never_named_the_prompt_the_corpus_would_claim'));
});

test('4D a corpus that could not be defended is refused, not produced', () => {
  const staged = stagedCase();
  const artefactFor = (over) => artefact(staged, over);
  const good = [humanReview('anna'), humanReview('boris')];
  const refuses = (over = {}) => assembleCorpus({ input: input(), artefacts: { 'case-1': artefactFor() },
    reviews: { 'case-1': good }, ...over }).problems;

  // Only one review, or the same person twice.
  assert.ok(refuses({ reviews: { 'case-1': [good[0]] } })
    .some((rule) => rule.includes('exactly_two_human_reviews_are_required')));
  assert.ok(refuses({ reviews: { 'case-1': [humanReview('anna'), humanReview('anna')] } })
    .some((rule) => rule.includes('two_distinct_reviewers_are_required')));
  // A model may not stand in for a person.
  assert.ok(refuses({ reviews: { 'case-1': [humanReview('served-model'), humanReview('boris')] } })
    .some((rule) => rule.includes('a_model_may_not_stand_in_for_a_human_reviewer')));
  // The reviews must declare the protocol they were produced under.
  assert.ok(refuses({ reviews: { 'case-1': [humanReview('anna', { protocol: 'other' }), good[1]] } })
    .some((rule) => rule.includes('reviews_must_declare_the_reviewer_protocol')));
  // An artefact from another prompt, another case, or without identity.
  assert.ok(refuses({ artefacts: { 'case-1': artefact(staged, { prompt_sha256: 'stale' }) } })
    .some((rule) => rule.includes('artefact_was_produced_with_another_prompt')));
  assert.ok(refuses({ artefacts: { 'case-1': artefact(staged, { staged_case_sha256: 'other' }) } })
    .some((rule) => rule.includes('artefact_answers_another_case')));
  assert.ok(refuses({ artefacts: { 'case-1': artefact(staged, { model_id: undefined }) } })
    .some((rule) => rule.includes('artefact_has_no_model_id')));
  assert.ok(refuses({ artefacts: {} }).some((rule) => rule.includes('artefact_is_missing')));
});

test('4D disagreement needs the third person, and they may not touch an agreed axis', () => {
  const staged = stagedCase();
  const split = [humanReview('anna', { axes: { ...axes(2), grounding: 3 } }),
    humanReview('boris', { axes: axes(2) })];
  const build = (over) => assembleCorpus({ input: input(), artefacts: { 'case-1': artefact(staged) },
    reviews: { 'case-1': split }, ...over });

  assert.ok(build({}).problems.some((rule) => rule.includes('disputed_axis_grounding_needs_adjudication')));
  const resolved = build({ adjudications: { 'case-1': { reviewer: 'carol', reason: 'Грандинг слабее.',
    final_axes: axes(2) } } });
  assert.deepEqual(resolved.problems, [], JSON.stringify(resolved.problems));
  assert.equal(resolved.corpus.cases[0].final_axes.grounding, 2, 'the adjudicator decided the disputed axis');
  assert.equal(resolved.corpus.cases[0].adjudication.reviewer, 'carol');

  // Raising an axis both reviewers already agreed on is refused.
  assert.ok(build({ adjudications: { 'case-1': { reviewer: 'carol', reason: 'x', final_axes: axes(3) } } })
    .problems.some((rule) => rule.includes('agreed_axis_')));
  // The adjudicator may not be one of the two reviewers.
  assert.ok(build({ adjudications: { 'case-1': { reviewer: 'anna', reason: 'x', final_axes: axes(2) } } })
    .problems.some((rule) => rule.includes('adjudicator_must_be_a_third_reviewer')));
  // A not-assessable axis is disagreement too, when the other reviewer scored it.
  const na = [humanReview('anna', { axes: axes('N/A') }), humanReview('boris')];
  assert.ok(assembleCorpus({ input: input(), artefacts: { 'case-1': artefact(staged) },
    reviews: { 'case-1': na } }).problems.some((rule) => rule.includes('needs_adjudication')));
});

test('4D the report is derived from the corpus alone and its metrics are recomputed', () => {
  const staged = stagedCase();
  const { corpus } = assembleCorpus({ input: input(), artefacts: { 'case-1': artefact(staged) },
    reviews: { 'case-1': [humanReview('anna', { axes: axes(1), failure_tags: ['overclaim'] }),
      humanReview('boris', { axes: axes(1), failure_tags: [] })] } });
  const { report, problems } = deriveReport(corpus);
  assert.deepEqual(problems, [], JSON.stringify(problems));
  assert.equal(report.scored_cases, 1);
  assert.equal(report.axis_summary.grounding.mean, 1);
  assert.equal(report.case_results.length, 1);
  assert.equal(report.failed_cases.length, AXES.length, 'a score of 1 is a failure on every axis');
  assert.deepEqual(report.failed_cases[0].failure_tags, ['overclaim'], 'the union of both reviewers is carried');
  assert.deepEqual(validateReport(report), []);
  assert.deepEqual(validateEvaluation(corpus, report), []);

  // The report cannot be built from reviews and outputs directly, only from a corpus.
  assert.ok(deriveReport(null).problems.includes('a_report_needs_a_corpus'));
  assert.ok(deriveReport({ corpus_id: 'x' }).report === null, 'a corpus that does not validate yields no report');
});

test('4D one evaluation may not span two models', () => {
  const first = stagedCase();
  const second = stagedCase({ case_id: 'case-2' });
  const { problems } = assembleCorpus({
    input: input([first, second]),
    artefacts: { 'case-1': artefact(first), 'case-2': artefact(second, { model_id: 'other-model' }) },
    reviews: { 'case-1': [humanReview('anna'), humanReview('boris')],
      'case-2': [humanReview('anna'), humanReview('boris')] } });
  assert.ok(problems.some((rule) => rule.includes('the_evaluation_spans_several_models')));
  assert.equal(problems.some((rule) => rule.includes('spans_several_models:served-model@served-1')), true);
});

test('4D the assembly reads and writes nothing on its own', () => {
  const before = fs.readdirSync(path.join(process.cwd(), 'docs', 'benchmarks', 'decision-quality-eval-v0'));
  assert.ok(before.includes('corpus.json'), 'the shipped corpus is still the empty protocol one');
  const shipped = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'docs', 'benchmarks',
    'decision-quality-eval-v0', 'corpus.json'), 'utf8'));
  assert.deepEqual(shipped.cases, [], 'assembly never fabricates a case');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-assemble-'));
  fs.rmSync(directory, { recursive: true, force: true });
});
