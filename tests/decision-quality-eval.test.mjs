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

const realCase = () => ({
  case_id: 'real-1',
  provenance: { kind: 'anonymized_real', provenance_ref: 'internal-opaque-ref-1' },
  frozen_input: { source_text: '[PERSON_A]: скільки коштує участь?', author: '[PERSON_A]',
    context: 'public thread', known_unknowns: ['Цена не подтверждена.'] },
  offer: 'Synthetic offer', operator_goal: 'Assess usefulness for operator review only.',
  model_output: { hypothesis: 'Возможно, нужна цена.' },
  scores: [{ reviewer: 'r1', axes: Object.fromEntries(AXES.map((axis) => [axis, 2])),
    failure_tags: ['overclaim'] }],
});

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

test('4D0 a real case without a provenance reference is refused', () => {
  const problem = validateCase({ ...realCase(), provenance: { kind: 'anonymized_real' } });
  assert.deepEqual(problem.map((entry) => entry.rule), ['real_case_requires_provenance_ref']);
  const fixture = validateCase({ ...realCase(), provenance: { kind: 'sanitized_fixture' } });
  assert.deepEqual(fixture, [], 'a fixture case needs no reference');
});

test('4D0 structure is checked and quality is not', () => {
  const base = realCase();
  const rules = (mutate) => validateCase({ ...base, ...mutate }).map((entry) => entry.rule);
  assert.ok(rules({ operator_goal: '' }).includes('operator_goal_required'));
  assert.ok(rules({ frozen_input: { source_text: '' } }).includes('frozen_input_source_text_required'));
  assert.ok(rules({ provenance: { kind: 'made_up' } }).includes('provenance_kind_known'));
  assert.ok(rules({ model_output: 'text instead of an object' }).includes('model_output_object_or_null'));
  assert.deepEqual(validateCase({ ...base, model_output: null }), [], 'a case may wait for its model output');
  // A valid case passes regardless of how good the reasoning is: quality is not the validator's job.
  assert.deepEqual(validateCase({ ...base, model_output: { hypothesis: 'clearly wrong' } }), []);
});

test('4D0 every score must be 0..3 or N/A, and every failure tag must be known', () => {
  const base = realCase();
  const withAxes = (axes) => validateCase({ ...base, scores: [{ reviewer: 'r1', axes, failure_tags: [] }] })
    .map((entry) => entry.rule);
  assert.ok(withAxes({ ...Object.fromEntries(AXES.map((axis) => [axis, 4])) }).includes('axis_grounding_score_invalid'));
  assert.ok(withAxes({ ...Object.fromEntries(AXES.map((axis) => [axis, -1])) }).includes('axis_grounding_score_invalid'));
  assert.ok(withAxes({ ...Object.fromEntries(AXES.map((axis) => [axis, 1.5])) }).includes('axis_grounding_score_invalid'));
  assert.ok(withAxes(Object.fromEntries(AXES.slice(0, 5).map((axis) => [axis, 2])))
    .some((rule) => rule.endsWith('_required')), 'a missing axis is refused');
  const none = Object.fromEntries(AXES.map((axis) => [axis, 'N/A']));
  assert.deepEqual(validateCase({ ...base, scores: [{ reviewer: 'r1', axes: none, failure_tags: [] }] }), []);
  const tagged = validateCase({ ...base, scores: [{ reviewer: 'r1', axes: none, failure_tags: ['looks_ugly'] }] })
    .map((entry) => entry.rule);
  assert.ok(tagged.includes('failure_tag_unknown:looks_ugly'), 'a made-up tag is refused');
});

test('4D0 an adjudication must name a reviewer and a reason', () => {
  const base = realCase();
  const rules = (adjudication) => validateCase({ ...base, adjudication }).map((entry) => entry.rule);
  assert.deepEqual(validateCase(base), [], 'no adjudication is fine');
  assert.ok(rules({ reviewer: 'third', reason: 'Disagreement on grounding.' }).length === 0);
  assert.ok(rules({ reviewer: 'third' }).includes('adjudication_reason_required'));
  assert.ok(rules({ reason: 'because' }).includes('adjudication_reviewer_required'));
});

test('4D0 a report must name the model and refuse a single aggregate score', () => {
  const report = () => ({ corpus_id: 'decision-quality-eval-v0', proof_level: 'synthetic_contract_eval',
    live_proof: false, model: { id: 'fixture', version: 'v1', prompt_id: 'p1' }, scored_cases: 0,
    axis_summary: Object.fromEntries(AXES.map((axis) => [axis, { scored: 0, na: 0, mean: null }])),
    failed_cases: [] });
  assert.deepEqual(validateReport(report()), []);
  assert.ok(validateReport({ ...report(), live_proof: true }).map((e) => e.rule).includes('live_proof_must_be_false'));
  assert.ok(validateReport({ ...report(), model: { id: 'fixture' } }).map((e) => e.rule).includes('model_must_be_named'));
  const magic = report();
  magic.axis_summary.grounding.aggregate_score = 87;
  assert.ok(validateReport(magic).map((e) => e.rule).includes('no_aggregate_magic_score'));
});

test('4D0 the anonymisation rules protect people without destroying the signal', () => {
  const rules = read('anonymization.md');
  for (const rule of ['PERSON_A', 'ACCOUNT_1', 'HIGH_VALUE_AMOUNT', 'provenance_ref'])
    assert.ok(rules.includes(rule), `rules must show ${rule}`);
  assert.match(rules, /Preserve/);
  assert.match(rules, /Never/);
});
