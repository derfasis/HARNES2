// Stage 4D0: the evaluation protocol must be able to catch its own corruption.
// proof_level=synthetic_contract_eval; live_proof=false. No model, network, or live data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AXES, validateCase, validateCorpus, validateReport } from '../docs/benchmarks/decision-quality-eval-v0/validate.mjs';

const DIR = fileURLToPath(new URL('../docs/benchmarks/decision-quality-eval-v0/', import.meta.url));
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');
const axes = (value = 2) => Object.fromEntries(AXES.map((axis) => [axis, value]));
const realCase = () => ({
  case_id: 'real-1',
  provenance: { kind: 'anonymized_real', provenance_claim_ref: 'prov_internal-1' },
  frozen_input: { source_text: '[PERSON_A]: скільки коштує участь?', author: '[PERSON_A]',
    context: 'public thread', known_unknowns: ['Цена не подтверждена.'] },
  offer: 'Synthetic offer', operator_goal: 'Assess usefulness for operator review only.',
  model_output: { hypothesis: 'Возможно, нужна цена.' },
  scores: [{ reviewer: 'r1', axes: axes(2), failure_tags: ['overclaim'] },
    { reviewer: 'r2', axes: axes(2), failure_tags: [] }],
});
const rules = (mutate) => validateCase({ ...realCase(), ...mutate }).map((entry) => entry.rule);

test('4D0 the shipped corpus is empty and claims no live proof', () => {
  const corpus = JSON.parse(read('corpus.json'));
  assert.deepEqual(corpus.cases, [], 'no invented "real" cases');
  assert.equal(corpus.live_proof, false);
  assert.deepEqual(validateCorpus(corpus), []);
});

test('4D0 the protocol documents exist and the rubric has an anchor per level', () => {
  for (const name of ['README.md', 'rubric.md', 'failure-tags.md', 'anonymization.md',
    'reviewer-protocol.md', 'corpus.schema.json', 'report.schema.json']) {
    assert.ok(read(name).length > 0, name);
  }
  const rubric = read('rubric.md');
  for (const axis of ['Grounding', 'Intent understanding', 'Calibration', 'Relevance',
    'Decision quality', 'Operator usefulness']) {
    assert.match(rubric, new RegExp(`## \\d+\\. ${axis}`), `rubric must define ${axis}`);
  }
  assert.equal((rubric.match(/\*\*N\/A\*\*/g) ?? []).length, 6, 'every axis needs a not-assessable level');
});

test('4D0 a real case must carry a well-formed provenance claim, and it is only a claim', () => {
  assert.ok(rules({ provenance: { kind: 'anonymized_real' } })
    .includes('real_case_requires_provenance_claim_ref'));
  assert.ok(rules({ provenance: { kind: 'anonymized_real', provenance_claim_ref: 'banana' } })
    .includes('real_case_requires_provenance_claim_ref'), 'any non-empty string is not enough');
  assert.deepEqual(validateCase({ ...realCase(), provenance: { kind: 'sanitized_fixture' } }), []);
  const readme = read('README.md');
  assert.match(readme, /claim, not a proof/);
  assert.match(readme, /provenance_claim_ref/);
});

test('4D0 exactly two independent reviews are required', () => {
  const one = { ...realCase(), scores: [{ reviewer: 'r1', axes: axes(2), failure_tags: [] }] };
  assert.ok(validateCase(one).map((e) => e.rule).includes('exactly_two_reviews_required'));
  const same = { ...realCase(), scores: [{ reviewer: 'r1', axes: axes(2), failure_tags: [] },
    { reviewer: 'r1', axes: axes(2), failure_tags: [] }] };
  assert.ok(validateCase(same).map((e) => e.rule).includes('two_distinct_reviewers_required'));
  assert.deepEqual(validateCase(realCase()), []);
});

test('4D0 adjudication is required exactly on disagreement, and never replaces the reviews', () => {
  const diverged = { ...realCase(), scores: [{ reviewer: 'r1', axes: axes(3), failure_tags: [] },
    { reviewer: 'r2', axes: axes(0), failure_tags: ['overclaim'] }] };
  assert.ok(validateCase(diverged).map((e) => e.rule).includes('adjudication_required'));
  const naDiverged = { ...realCase(), scores: [{ reviewer: 'r1', axes: axes('N/A'), failure_tags: [] },
    { reviewer: 'r2', axes: axes(2), failure_tags: [] }] };
  assert.ok(validateCase(naDiverged).map((e) => e.rule).includes('adjudication_required'));
  const unnecessary = { ...realCase(), adjudication: { reviewer: 'r3', reason: 'looked again',
    final_axes: axes(2) } };
  assert.ok(validateCase(unnecessary).map((e) => e.rule).includes('adjudication_not_expected'));
  const resolved = { ...diverged, adjudication: { reviewer: 'r3', reason: 'Ground the first axis.',
    final_axes: axes(1) } };
  assert.deepEqual(validateCase(resolved), []);
  assert.equal(resolved.scores.length, 2, 'both original reviews survive the adjudication');
  const badFinal = { ...diverged, adjudication: { reviewer: 'r3', reason: 'x', final_axes: { grounding: 1 } } };
  assert.ok(validateCase(badFinal).map((e) => e.rule).includes('adjudication_final_axes_required'));
});

test('4D0 every score must be 0..3 or N/A, and every failure tag must be known', () => {
  const withAxes = (value) => rules({ scores: [{ reviewer: 'r1', axes: value, failure_tags: [] },
    { reviewer: 'r2', axes: axes(2), failure_tags: [] }] });
  for (const invalid of [4, -1, 1.5, 'good']) {
    assert.ok(withAxes({ ...axes(2), grounding: invalid }).includes('axis_grounding_score_invalid'),
      `score ${invalid} must be refused`);
  }
  assert.ok(withAxes(Object.fromEntries(AXES.slice(0, 5).map((axis) => [axis, 2])))
    .some((rule) => rule.endsWith('_required')), 'a missing axis is refused');
  assert.deepEqual(rules({ scores: [{ reviewer: 'r1', axes: axes('N/A'), failure_tags: [] },
    { reviewer: 'r2', axes: axes('N/A'), failure_tags: [] }] }), []);
  const tagged = rules({ scores: [{ reviewer: 'r1', axes: axes(2), failure_tags: ['looks_ugly'] },
    { reviewer: 'r2', axes: axes(2), failure_tags: [] }] });
  assert.ok(tagged.includes('failure_tag_unknown:looks_ugly'));
});

test('4D0 the validator enforces the structural rules the schemas declare', () => {
  assert.ok(rules({ case_id: '' }).includes('case_id_required'));
  assert.ok(rules({ frozen_input: { source_text: 'x' } }).includes('frozen_input_author_required'));
  assert.ok(rules({ frozen_input: { source_text: 'x', author: 'a' } }).includes('frozen_input_context_required'));
  assert.ok(rules({ extra: 1 }).includes('case_has_extra_fields'));
  assert.ok(rules({ provenance: { kind: 'made_up' } }).includes('provenance_kind_known'));
  assert.ok(rules({ model_output: 'text' }).includes('model_output_object_or_null'));
  assert.deepEqual(validateCase({ ...realCase(), model_output: null }), []);
  assert.ok(validateCorpus({ corpus_id: 'decision-quality-eval-v0', proof_level: 'live',
    live_proof: false, cases: [] }).map((e) => e.rule).includes('corpus_proof_level_known'));
  assert.ok(validateCorpus({ corpus_id: 'decision-quality-eval-v0',
    proof_level: 'synthetic_contract_eval', live_proof: true, cases: [] })
    .map((e) => e.rule).includes('live_proof_must_be_false'));
  // A case may be wrong on purpose: quality is not the validator's job.
  assert.deepEqual(validateCase({ ...realCase(), model_output: { hypothesis: 'clearly wrong' } }), []);
});

test('4D0 a report must name the model version, refuse a magic number, and derive its failures', () => {
  const report = () => ({ corpus_id: 'decision-quality-eval-v0', proof_level: 'offline_human_eval',
    live_proof: false, model: { id: 'fixture', version: 'v1', prompt_id: 'p1' }, scored_cases: 1,
    axis_summary: Object.fromEntries(AXES.map((axis) => [axis, { scored: 1, na: 0, mean: 1.5 }])),
    case_results: [{ case_id: 'c1', reviews: [{ reviewer: 'r1', axes: axes(1) },
      { reviewer: 'r2', axes: axes(1) }], final_axes: axes(1), failure_tags: ['overclaim'], failed: true }],
    // Every axis that scored 0 or 1 is listed, so nothing fails quietly.
    failed_cases: AXES.map((axis) => ({ case_id: 'c1', axis, score: 1, failure_tags: ['overclaim'] })) });
  assert.deepEqual(validateReport(report()), []);
  assert.ok(validateReport({ ...report(), model: { id: 'f', version: 'v1' } })
    .map((e) => e.rule).includes('model_must_be_named_with_version'));
  const magic = report(); magic.aggregate_score = 87;
  assert.ok(validateReport(magic).map((e) => e.rule).includes('no_aggregate_magic_score'));
  assert.ok(validateReport({ ...report(), proof_level: 'synthetic_contract_eval' })
    .map((e) => e.rule).includes('report_proof_level_must_be_offline_human_eval'));
  const hidden = { ...report(), failed_cases: report().failed_cases.slice(0, 1) };
  assert.ok(validateReport(hidden).map((e) => e.rule).some((r) => r.startsWith('failed_case_missing:')));
  const invented = { ...report(), failed_cases: [...report().failed_cases,
    { case_id: 'c1', axis: 'relevance', score: 1, failure_tags: ['overclaim'] },
    { case_id: 'c9', axis: 'relevance', score: 1, failure_tags: [] }] };
  assert.ok(validateReport(invented).map((e) => e.rule).some((r) => r.startsWith('failed_case_invented:')));
  const lying = { ...report(), case_results: [{ ...report().case_results[0], failed: false }] };
  assert.ok(validateReport(lying).map((e) => e.rule).includes('failed_flag_must_match_final_axes'));
});

test('4D0 the protocol separates proof levels and keeps the real one offline', () => {
  const readme = read('README.md');
  assert.match(readme, /synthetic_contract_eval/);
  assert.match(readme, /offline_human_eval/);
  assert.match(readme, /live_proof=false/);
  const corpusSchema = JSON.parse(read('corpus.schema.json'));
  assert.deepEqual(corpusSchema.properties.proof_level.enum,
    ['synthetic_contract_eval', 'offline_human_eval']);
  const reportSchema = JSON.parse(read('report.schema.json'));
  assert.deepEqual(reportSchema.properties.proof_level.enum, ['offline_human_eval']);
  assert.equal(reportSchema.properties.live_proof.const, false);
});

test('4D0 the anonymisation rules protect people without destroying the signal', () => {
  const rules = read('anonymization.md');
  for (const rule of ['PERSON_A', 'ACCOUNT_1', 'HIGH_VALUE_AMOUNT', 'provenance_claim_ref'])
    assert.ok(rules.includes(rule), `rules must show ${rule}`);
  assert.match(rules, /Preserve/);
  assert.match(rules, /Never/);
});
