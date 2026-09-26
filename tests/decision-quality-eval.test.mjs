// Stage 4D0: the evaluation protocol must be able to catch its own corruption.
// proof_level=synthetic_contract_eval; live_proof=false. No model, network, or live data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { AXES, deriveReportFacts, validateCase, validateCorpus, validateEvaluation, validateReport }
  from '../docs/benchmarks/decision-quality-eval-v0/validate.mjs';

const DIR = fileURLToPath(new URL('../docs/benchmarks/decision-quality-eval-v0/', import.meta.url));
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');
const axes = (value = 2) => Object.fromEntries(AXES.map((axis) => [axis, value]));
const realCase = (mutate = {}) => ({
  case_id: 'real-1',
  provenance: { kind: 'anonymized_real', provenance_claim_ref: 'prov_internal-1' },
  frozen_input: { source_text: '[PERSON_A]: скільки коштує участь?', author: '[PERSON_A]',
    context: 'public thread', known_unknowns: ['Цена не подтверждена.'] },
  offer: 'Synthetic offer', operator_goal: 'Assess usefulness for operator review only.',
  model_output: { hypothesis: 'Возможно, нужна цена.' },
  scores: [{ reviewer: 'r1', axes: axes(2), failure_tags: ['overclaim'] },
    { reviewer: 'r2', axes: axes(2), failure_tags: [] }],
  final_axes: axes(2), failure_tags: ['overclaim'], ...mutate,
});
const rules = (mutate) => validateCase(realCase(mutate)).map((entry) => entry.rule);

const validReport = (mutate = {}) => {
  const caseResults = [{ case_id: 'real-1', reviews: [
    { reviewer: 'r1', axes: axes(1), failure_tags: ['overclaim'] },
    { reviewer: 'r2', axes: axes(1), failure_tags: [] }],
    final_axes: axes(1), failure_tags: ['overclaim'], failed: true }];
  const facts = deriveReportFacts({ case_results: caseResults });
  return { corpus_id: 'decision-quality-eval-v0', proof_level: 'offline_human_eval', live_proof: false,
    model: { id: 'fixture', version: 'v1', prompt_id: 'p1', prompt_digest: 'sha256-0123456789abcdef' },
    scored_cases: facts.scored_cases, not_applicable_cases: facts.not_applicable_cases,
    axis_summary: facts.axis_summary, case_results: caseResults, failed_cases: facts.failed_cases,
    ...mutate };
};


// A complete, honest offline pair: everything the protocol will one day hold, so the whole chain
// is exercised on real data rather than on fragments.
const generation = { model_id: 'fixture-model', model_version: '2026-01', prompt_ref: 'prompt-7',
  prompt_digest: 'sha256-0123456789abcdef' };

const offlineCase = (mutate = {}) => realCase({ case_id: 'real-1',
  scores: [{ reviewer: 'r1', axes: axes(1), failure_tags: ['overclaim'] },
    { reviewer: 'r2', axes: axes(1), failure_tags: [] }],
  final_axes: axes(1), failure_tags: ['overclaim'], ...mutate });

const offlineCorpus = (mutate = {}) => ({ corpus_id: 'decision-quality-eval-v0',
  proof_level: 'offline_human_eval', live_proof: false, generation, cases: [offlineCase()], ...mutate });

const offlineReport = (mutate = {}) => {
  const report = validReport({ model: { id: generation.model_id, version: generation.model_version,
    prompt_id: generation.prompt_ref, prompt_digest: generation.prompt_digest } });
  return { ...report, ...mutate };
};

test('4D0 the shipped corpus is empty and claims no live proof', () => {
  const corpus = JSON.parse(read('corpus.json'));
  assert.deepEqual(corpus.cases, [], 'no invented "real" cases');
  assert.equal(corpus.live_proof, false);
  assert.deepEqual(validateCorpus(corpus), []);
});

test('4D0 both schemas compile and accept a valid fixture, rejecting a broken one', () => {
  const ajv = new Ajv({ strict: false });
  const corpusValidate = ajv.compile(JSON.parse(read('corpus.schema.json')));
  const reportValidate = ajv.compile(JSON.parse(read('report.schema.json')));
  const corpus = offlineCorpus();
  assert.equal(corpusValidate(corpus), true, JSON.stringify(corpusValidate.errors));
  assert.equal(corpusValidate({ ...corpus, generation: undefined }), false,
    'an offline corpus without a frozen generation identity is not a valid corpus');
  assert.equal(corpusValidate({ ...corpus, cases: [{ ...realCase(), scores: [realCase().scores[0]] }] }), false,
    'a schema that cannot be broken by a missing review is not a schema');
  const report = validReport();
  assert.equal(reportValidate(report), true, JSON.stringify(reportValidate.errors));
  assert.equal(reportValidate({ ...report, extra: 1 }), false, 'unknown report fields are refused');
  assert.equal(reportValidate({ ...report, live_proof: true }), false);
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

test('4D0 exactly two independent reviews, and the adjudicator is a third person', () => {
  const one = { ...realCase(), scores: [{ reviewer: 'r1', axes: axes(2), failure_tags: [] }] };
  assert.ok(validateCase(one).map((e) => e.rule).includes('exactly_two_reviews_required'));
  const same = { ...realCase(), scores: [{ reviewer: 'r1', axes: axes(2), failure_tags: [] },
    { reviewer: 'r1', axes: axes(2), failure_tags: [] }] };
  assert.ok(validateCase(same).map((e) => e.rule).includes('two_distinct_reviewers_required'));
  const diverged = realCase({ scores: [{ reviewer: 'r1', axes: axes(3), failure_tags: [] },
    { reviewer: 'r2', axes: axes(0), failure_tags: ['overclaim'] }], final_axes: axes(1),
    failure_tags: ['overclaim'] });
  assert.ok(validateCase(diverged).map((e) => e.rule).includes('adjudication_required'));
  assert.ok(validateCase({ ...diverged, adjudication: { reviewer: 'r1', reason: 'own case',
    final_axes: axes(1) } }).map((e) => e.rule).includes('adjudicator_must_be_a_third_reviewer'));
  assert.deepEqual(validateCase({ ...diverged, adjudication: { reviewer: 'r3',
    reason: 'Grounding is weak.', final_axes: axes(1) } }), []);
  assert.ok(validateCase({ ...realCase(), adjudication: { reviewer: 'r3', reason: 'unnecessary',
    final_axes: axes(2) } }).map((e) => e.rule).includes('adjudication_not_expected'));
  assert.equal(({ ...diverged, adjudication: { reviewer: 'r3', reason: 'x', final_axes: axes(1) } }).scores.length, 2,
    'an adjudication never replaces the two original reviews');
  assert.ok(validateCase(realCase({ scores: [{ reviewer: 'r1', axes: axes(1), failure_tags: [] },
    { reviewer: 'r2', axes: axes(2), failure_tags: [] }], final_axes: axes(1) })).map((e) => e.rule)
    .includes('disputed_axis_grounding_needs_adjudication'),
  'a one-point gap is still a gap');
});

test('4D0 every score must be 0..3 or N/A, and every failure tag must be known', () => {
  const withAxes = (value) => rules({ scores: [{ reviewer: 'r1', axes: value, failure_tags: [] },
    { reviewer: 'r2', axes: axes(2), failure_tags: [] }], final_axes: axes(2) });
  for (const invalid of [4, -1, 1.5, 'good'])
    assert.ok(withAxes({ ...axes(2), grounding: invalid }).includes('axis_grounding_score_invalid'));
  assert.ok(withAxes(Object.fromEntries(AXES.slice(0, 5).map((axis) => [axis, 2])))
    .some((rule) => rule.endsWith('_required')), 'a missing axis is refused');

  assert.ok(rules({ scores: [{ reviewer: 'r1', axes: axes(2), failure_tags: ['looks_ugly'] },
    { reviewer: 'r2', axes: axes(2), failure_tags: [] }], final_axes: axes(2),
  failure_tags: ['looks_ugly'] }).includes('failure_tag_unknown:looks_ugly'));
  assert.ok(rules({ scores: [{ reviewer: 'r1', axes: axes(2), note: 'extra' },
    { reviewer: 'r2', axes: axes(2), failure_tags: [] }], final_axes: axes(2) })
    .includes('scoring_has_extra_fields'));
  assert.ok(rules({ scores: [{ reviewer: 'r1', axes: axes(2) },
    { reviewer: 'r2', axes: axes(2), failure_tags: [] }], final_axes: axes(2) })
    .includes('scoring_failure_tags_required'));
  assert.ok(rules({ scores: [{ reviewer: 'r1', axes: axes('N/A'), failure_tags: [] },
    { reviewer: 'r2', axes: axes('N/A'), failure_tags: [] }], final_axes: axes('N/A'),
  failure_tags: [] }), [], 'a fully not-assessable case is publishable as is');
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
  assert.deepEqual(validateCase({ ...realCase(), model_output: { hypothesis: 'clearly wrong' } }), [],
    'a case may be wrong on purpose: quality is not the validator\'s job');
});

test('4D0 every report metric must be derivable from the case results', () => {
  assert.deepEqual(validateReport(validReport()), []);
  const reportRules = (mutate) => validateReport(validReport(mutate)).map((e) => e.rule);
  assert.ok(reportRules({ scored_cases: 99 }).includes('scored_cases_must_be_derived'));
  const wrongMean = validReport();
  wrongMean.axis_summary.grounding.mean = 3;
  assert.ok(validateReport(wrongMean).map((e) => e.rule).includes('axis_summary_must_be_derived'));
  const wrongCount = validReport();
  wrongCount.axis_summary.grounding.scored = 7;
  assert.ok(validateReport(wrongCount).map((e) => e.rule).includes('axis_summary_must_be_derived'));
  // failed_cases must match exactly, including the score and the tags, with no duplicates.
  const wrongScore = validReport();
  wrongScore.failed_cases[0].score = 2;
  assert.ok(validateReport(wrongScore).map((e) => e.rule).includes('failed_cases_must_be_exactly_derived'));
  const wrongTags = validReport();
  wrongTags.failed_cases[0].failure_tags = [];
  assert.ok(validateReport(wrongTags).map((e) => e.rule).includes('failed_cases_must_be_exactly_derived'));
  const duplicated = validReport();
  duplicated.failed_cases = [...duplicated.failed_cases, { ...duplicated.failed_cases[0] }];
  assert.ok(validateReport(duplicated).map((e) => e.rule).includes('failed_cases_must_not_duplicate'));
  assert.ok(reportRules({ aggregate_score: 87 }).includes('no_aggregate_magic_score'));
  assert.ok(reportRules({ model: { id: 'f', version: 'v1' } })
    .includes('model_must_be_named_with_version_and_digest'));
  assert.ok(reportRules({ proof_level: 'synthetic_contract_eval' })
    .includes('report_proof_level_must_be_offline_human_eval'));
  const lying = validReport();
  lying.case_results[0].failed = false;
  assert.ok(validateReport(lying).map((e) => e.rule).includes('failed_flag_must_match_final_axes'));
  const sameReviewer = validReport();
  sameReviewer.case_results[0].reviews[1].reviewer = 'r1';
  assert.ok(validateReport(sameReviewer).map((e) => e.rule).includes('two_distinct_reviewers_required'));
  const missingAdjudication = validReport();
  missingAdjudication.case_results[0].reviews[0].axes = axes(3);
  assert.ok(validateReport(missingAdjudication).map((e) => e.rule).includes('adjudication_required'));
});

test('4D0 case ids must be unique in the corpus and in the report', () => {
  const duplicated = { corpus_id: 'decision-quality-eval-v0', proof_level: 'offline_human_eval',
    live_proof: false, generation: { model_id: 'm', model_version: '1', prompt_ref: 'p',
      prompt_digest: 'a'.repeat(64) }, cases: [realCase(), realCase()] };
  assert.ok(validateCorpus(duplicated).map((e) => e.rule).includes('case_id_must_be_unique'));
  const report = validReport();
  report.case_results = [report.case_results[0], { ...report.case_results[0] }];
  report.failed_cases = [];
  report.axis_summary = deriveReportFacts(report).axis_summary;
  report.scored_cases = 2;
  report.not_applicable_cases = 0;
  report.failed_cases = deriveReportFacts(report).failed_cases;
  assert.ok(validateReport(report).map((e) => e.rule).includes('case_id_must_be_unique'));
});

test('4D0 a published score is either what both reviewers agreed or what the adjudicator wrote', () => {
  const agreed = validReport();
  assert.deepEqual(validateReport(agreed), [], 'an agreed score is publishable as is');
  const inflated = validReport();
  inflated.case_results[0].final_axes = axes(3);
  inflated.failed_cases = [];
  inflated.axis_summary = deriveReportFacts(inflated).axis_summary;
  inflated.scored_cases = 1;
  inflated.not_applicable_cases = 0;
  inflated.failed_cases = deriveReportFacts(inflated).failed_cases;
  assert.ok(validateReport(inflated).map((e) => e.rule)
    .some((r) => r.startsWith('agreed_axis_')), 'two reviewers scoring 1 cannot publish 3');
  // One disputed axis, adjudicated to 2: publishing 3 there is refused, publishing 2 is not.
  const adjudicated = validReport();
  adjudicated.case_results[0].reviews[0].axes = { ...axes(1), grounding: 3 };
  adjudicated.case_results[0].adjudication = { reviewer: 'r3', reason: 'Grounding is two.',
    final_axes: { ...axes(1), grounding: 2 } };
  adjudicated.case_results[0].final_axes = { ...axes(1), grounding: 3 };
  const adjudicatedRules = validateReport(adjudicated).map((e) => e.rule);
  assert.ok(adjudicatedRules.includes('disputed_axis_grounding_must_be_the_adjudicated_score'),
    adjudicatedRules.join(','));
});

test('4D0 the schemas guard the real data too, not only test fixtures', () => {
  const long = validReport();
  long.case_results[0].case_id = 'c1';
  long.case_results[0].failure_tags = 'not-an-array';
  const rules = validateReport(long).map((e) => e.rule);
  assert.ok(rules.includes('schema:type'), 'a malformed field is caught by the schema guard');
  const longText = validateCorpus({ corpus_id: 'decision-quality-eval-v0', proof_level: 'offline_human_eval',
    live_proof: false, cases: [{ ...realCase(), frozen_input: { ...realCase().frozen_input,
      source_text: 'x'.repeat(5000) } }] }).map((e) => e.rule);
  assert.ok(longText.some((rule) => rule.startsWith('schema:')), 'length limits come from the schema');
});

test('4D0 a real offline evaluation must be backed by a real corpus', () => {
  const agreed = { ...realCase(), scores: [{ reviewer: 'r1', axes: axes(1), failure_tags: ['overclaim'] },
      { reviewer: 'r2', axes: axes(1), failure_tags: [] }], final_axes: axes(1) };
  const generation = { model_id: 'fixture', model_version: 'v1', prompt_ref: 'p1',
    prompt_digest: 'sha256-0123456789abcdef' };
  const corpus = { corpus_id: 'decision-quality-eval-v0', proof_level: 'offline_human_eval',
    live_proof: false, generation, cases: [agreed] };
  const report = validReport({ model: { id: 'fixture', version: 'v1', prompt_id: 'p1',
    prompt_digest: 'sha256-0123456789abcdef' } });
  assert.deepEqual(validateEvaluation(corpus, report), []);
  assert.ok(validateEvaluation({ ...corpus, cases: [] }, report).map((e) => e.rule)
    .includes('offline_eval_requires_cases'));
  const fixture = { ...corpus, cases: [{ ...agreed, provenance: { kind: 'sanitized_fixture' } }] };
  assert.ok(validateEvaluation(fixture, report).map((e) => e.rule)
    .includes('offline_eval_case_must_be_anonymized_real'));
  const unclaimed = { ...corpus, cases: [{ ...agreed, provenance: { kind: 'anonymized_real' } }] };
  assert.ok(validateEvaluation(unclaimed, report).map((e) => e.rule)
    .includes('offline_eval_case_requires_provenance_claim'));
  const noOutput = { ...corpus, cases: [{ ...agreed, model_output: null }] };
  assert.ok(validateEvaluation(noOutput, report).map((e) => e.rule)
    .includes('offline_eval_case_requires_model_output'));
  const otherCase = validReport();
  otherCase.case_results[0].case_id = 'real-9';
  assert.ok(validateEvaluation(corpus, otherCase).map((e) => e.rule)
    .includes('report_case_ids_must_match_corpus'));
  // The empty protocol corpus cannot back a real measurement, even though it labels itself
  // synthetic rather than offline: the report's claim is what the corpus must satisfy.
  assert.ok(validateEvaluation(JSON.parse(read('corpus.json')), report).map((e) => e.rule)
    .includes('offline_report_requires_offline_corpus'));
});

test('4D0 an adjudicator may resolve only the axes the reviewers disputed', () => {
  // One axis is disputed, the rest are agreed: that is the case the protocol is written for.
  const disputed = realCase({ scores: [
    { reviewer: 'r1', axes: { ...axes(1), grounding: 3 }, failure_tags: [] },
    { reviewer: 'r2', axes: { ...axes(1), grounding: 2 }, failure_tags: [] }],
    final_axes: { ...axes(1), grounding: 2 }, failure_tags: [] });
  const honest = { ...disputed, adjudication: { reviewer: 'r3', reason: 'Grounding is two.',
    final_axes: { ...axes(1), grounding: 2 } } };
  assert.deepEqual(validateCase(honest), []);
  // The adjudicator may only resolve grounding. Raising relevance, which both agreed on, is refused.
  const rewritten = { ...disputed, final_axes: axes(3), adjudication: { reviewer: 'r3',
    reason: 'Inflated.', final_axes: axes(3) } };
  const rules = validateCase(rewritten).map((e) => e.rule);
  assert.ok(rules.includes('adjudicator_must_preserve_agreed_axis_relevance'), rules.join(','));
  assert.ok(rules.includes('agreed_axis_relevance_must_not_be_rewritten'), rules.join(','));
});

test('4D0 the case failure tags are the reviewers union, not a field someone can clear', () => {
  assert.deepEqual(validateCase(realCase({ failure_tags: ['overclaim'] })), []);
  assert.ok(validateCase(realCase({ failure_tags: [] })).map((e) => e.rule)
    .includes('case_failure_tags_must_be_the_reviewers_union'));
  const report = validReport();
  report.case_results[0].failure_tags = [];
  assert.ok(validateReport(report).map((e) => e.rule).includes('failure_tags_must_be_the_reviewers_union'));
});

test('4D0 a malformed reviews value yields findings and never an exception', () => {
  for (const reviews of [{}, null, 'nope', [1, 2]]) {
    const broken = validReport();
    broken.case_results[0].reviews = reviews;
    const found = validateReport(broken);
    assert.ok(found.length > 0, `reviews ${JSON.stringify(reviews)} must produce findings`);
  }
  const corpusBroken = { corpus_id: 'decision-quality-eval-v0', proof_level: 'offline_human_eval',
    live_proof: false, generation: { model_id: 'm', model_version: 'v1', prompt_ref: 'p',
      prompt_digest: 'sha256-0123456789abcdef' }, cases: [realCase({ scores: {} })] };
  assert.ok(validateCorpus(corpusBroken).length > 0);
});

test('4D0 a report cannot restate the corpus reviews or the frozen generation identity', () => {
  const agreed = { ...realCase(), scores: [{ reviewer: 'r1', axes: axes(1), failure_tags: ['overclaim'] },
    { reviewer: 'r2', axes: axes(1), failure_tags: [] }], final_axes: axes(1) };
  const generation = { model_id: 'fixture', model_version: 'v1', prompt_ref: 'p1',
    prompt_digest: 'sha256-0123456789abcdef' };
  const corpus = { corpus_id: 'decision-quality-eval-v0', proof_level: 'offline_human_eval',
    live_proof: false, generation, cases: [agreed] };
  const restated = validReport();
  restated.case_results[0].reviews[0].axes = axes(3);
  restated.case_results[0].reviews[1].axes = axes(3);
  restated.case_results[0].adjudication = { reviewer: 'r3', reason: 'inflated', final_axes: axes(3) };
  restated.case_results[0].final_axes = axes(3);
  restated.failed_cases = [];
  restated.axis_summary = deriveReportFacts(restated).axis_summary;
  restated.scored_cases = 1;
  restated.not_applicable_cases = 0;
  restated.failed_cases = deriveReportFacts(restated).failed_cases;
  assert.ok(validateEvaluation(corpus, restated).map((e) => e.rule)
    .includes('report_reviews_must_match_corpus_scores'));
  const wrongModel = validReport({ model: { id: 'other', version: 'v9', prompt_id: 'zz' } });
  assert.ok(validateEvaluation(corpus, wrongModel).map((e) => e.rule)
    .includes('model_id_must_match_corpus'));
  const noGeneration = { ...corpus, generation: undefined };
  assert.ok(validateEvaluation(noGeneration, validReport()).map((e) => e.rule)
    .includes('offline_eval_requires_frozen_generation_identity'));
});


test('4D0 the whole chain accepts a complete honest pair and refuses each missing piece', () => {
  // The end-to-end regression: the same data through corpus, report, and the link between them.
  assert.deepEqual(validateCorpus(offlineCorpus()), [],
    'a real offline corpus with a frozen generation identity must validate');
  assert.deepEqual(validateReport(offlineReport()), [],
    'a matching report must validate');
  assert.deepEqual(validateEvaluation(offlineCorpus(), offlineReport()), []);

  const noGeneration = offlineCorpus({ generation: undefined });
  assert.ok(validateCorpus(noGeneration).map((e) => e.rule)
    .includes('offline_eval_requires_frozen_generation_identity'));
  assert.ok(validateEvaluation(noGeneration, offlineReport()).map((e) => e.rule)
    .includes('offline_eval_requires_frozen_generation_identity'));

  const noDigest = offlineReport();
  delete noDigest.model.prompt_digest;
  assert.ok(validateReport(noDigest).map((e) => e.rule)
    .includes('model_must_be_named_with_version_and_digest'));
  const wrongDigest = offlineReport({ model: { ...offlineReport().model, prompt_digest: 'sha256-ffffffffffffffff' } });
  assert.ok(validateEvaluation(offlineCorpus(), wrongDigest).map((e) => e.rule)
    .includes('prompt_digest_must_match_corpus'));

  // A malformed tag list anywhere is a finding, never a crash.
  for (const value of [{}, null, 'overclaim', 7]) {
    const broken = offlineCorpus({ cases: [offlineCase({ failure_tags: value })] });
    const found = validateCorpus(broken);
    assert.ok(found.some((e) => e.rule.startsWith('case_failure_tags_')),
      `failure_tags ${JSON.stringify(value)} must produce a finding`);
  }
  const brokenReport = offlineReport();
  brokenReport.case_results[0].reviews = {};
  assert.ok(validateReport(brokenReport).length > 0);
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
