// Structure validator for the decision-quality evaluation corpus and report.
// It checks shape, never quality. A non-zero exit means the benchmark is corrupted,
// NOT that the system under test performed badly — those must never share an exit code.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const AXES = ['grounding', 'intent_understanding', 'calibration', 'relevance',
  'decision_quality', 'operator_usefulness'];

const FAILURE_TAGS = ['invented_fact', 'unsupported_permission', 'missed_opportunity',
  'overclaim', 'wrong_intent', 'premature_action'];
const CLAIM_REF = /^prov_[A-Za-z0-9._-]{1,120}$/;
const PROOF_LEVELS = ['synthetic_contract_eval', 'offline_human_eval'];
const CASE_KEYS = ['case_id', 'provenance', 'frozen_input', 'offer', 'operator_goal', 'gold_annotations',
  'model_output', 'scores', 'adjudication'];
const REPORT_KEYS = ['corpus_id', 'proof_level', 'live_proof', 'model', 'scored_cases',
  'not_applicable_cases', 'axis_summary', 'case_results', 'failed_cases'];

const own = (value, keys) => keys.every((key) => Object.prototype.hasOwnProperty.call(value ?? {}, key));
const extraKeys = (value, keys) => Object.keys(value ?? {}).filter((key) => !keys.includes(key));
const validScore = (value) => (Number.isInteger(value) && value >= 0 && value <= 3) || value === 'N/A';

// Deliberately hand-written rather than schema-driven: a validator that can be reconfigured
// alongside the data can be talked into accepting anything. It checks the rules that matter and
// names the rule it broke.
export function validateCase(item, at = 'case') {
  const problems = [];
  const require_ = (condition, rule) => { if (!condition) problems.push({ at, rule }); };
  if (!item || typeof item !== 'object' || Array.isArray(item))
    return [{ at, rule: 'case_must_be_object' }];
  require_(extraKeys(item, CASE_KEYS).length === 0, 'case_has_extra_fields');
  require_(typeof item.case_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,149}$/.test(item.case_id),
    'case_id_required');
  require_(item.provenance && typeof item.provenance === 'object' && !Array.isArray(item.provenance),
    'provenance_required');
  require_(extraKeys(item.provenance, ['kind', 'provenance_claim_ref']).length === 0,
    'provenance_has_extra_fields');
  const kind = item.provenance?.kind;
  require_(kind === 'sanitized_fixture' || kind === 'anonymized_real', 'provenance_kind_known');
  // A claim, not a proof: it must be present and well formed so a human can look it up.
  if (kind === 'anonymized_real')
    require_(CLAIM_REF.test(item.provenance.provenance_claim_ref ?? ''),
      'real_case_requires_provenance_claim_ref');
  require_(item.frozen_input && typeof item.frozen_input === 'object' && !Array.isArray(item.frozen_input),
    'frozen_input_required');
  require_(extraKeys(item.frozen_input, ['source_text', 'author', 'context', 'known_unknowns']).length === 0,
    'frozen_input_has_extra_fields');
  require_(typeof item.frozen_input?.source_text === 'string' && item.frozen_input.source_text.length > 0,
    'frozen_input_source_text_required');
  require_(typeof item.frozen_input?.author === 'string' && item.frozen_input.author.length > 0,
    'frozen_input_author_required');
  require_(typeof item.frozen_input?.context === 'string', 'frozen_input_context_required');
  require_(Array.isArray(item.frozen_input?.known_unknowns), 'frozen_input_known_unknowns_required');
  require_(typeof item.offer === 'string' && item.offer.length > 0, 'offer_required');
  require_(typeof item.operator_goal === 'string' && item.operator_goal.length > 0, 'operator_goal_required');
  require_(item.model_output === null || (typeof item.model_output === 'object' && !Array.isArray(item.model_output)),
    'model_output_object_or_null');

  // The protocol: exactly two independent reviews, by two different people.
  const scores = item.scores ?? [];
  require_(Array.isArray(scores) && scores.length === 2, 'exactly_two_reviews_required');
  const reviewers = new Set();
  for (const scoring of scores) {
    require_(typeof scoring?.reviewer === 'string' && scoring.reviewer.length > 0, 'scoring_reviewer_required');
    require_(scoring?.axes && typeof scoring.axes === 'object', 'scoring_axes_required');
    require_(extraKeys(scoring?.axes, AXES).length === 0, 'scoring_axes_has_extra_fields');
    for (const axis of AXES) require_(own(scoring?.axes, [axis]), `axis_${axis}_required`);
    for (const axis of AXES) require_(validScore(scoring?.axes?.[axis]), `axis_${axis}_score_invalid`);
    for (const tag of scoring?.failure_tags ?? [])
      require_(FAILURE_TAGS.includes(tag), `failure_tag_unknown:${tag}`);
    reviewers.add(scoring?.reviewer);
  }
  require_(reviewers.size === 2, 'two_distinct_reviewers_required');

  // Adjudication is required exactly when the two reviews disagree, and never replaces them.
  const divergent = scores.length === 2 && AXES.some((axis) => {
    const [a, b] = [scores[0]?.axes?.[axis], scores[1]?.axes?.[axis]];
    if (a === 'N/A' || b === 'N/A') return a !== b;
    return Math.abs(a - b) >= 2;
  });
  require_(divergent === !!item.adjudication,
    divergent ? 'adjudication_required' : 'adjudication_not_expected');
  if (item.adjudication) {
    require_(typeof item.adjudication.reviewer === 'string' && item.adjudication.reviewer.length > 0,
      'adjudication_reviewer_required');
    require_(typeof item.adjudication.reason === 'string' && item.adjudication.reason.length > 0,
      'adjudication_reason_required');
    require_(extraKeys(item.adjudication.final_axes, AXES).length === 0 && own(item.adjudication.final_axes, AXES),
      'adjudication_final_axes_required');
    for (const axis of AXES)
      require_(validScore(item.adjudication.final_axes?.[axis]), `adjudication_axis_${axis}_score_invalid`);
  }
  return problems;
}

export function validateCorpus(corpus) {
  const problems = [];
  if (!corpus || typeof corpus !== 'object') return [{ at: 'corpus', rule: 'corpus_must_be_object' }];
  if (extraKeys(corpus, ['corpus_id', 'proof_level', 'live_proof', 'cases']).length > 0)
    problems.push({ at: 'corpus', rule: 'corpus_has_extra_fields' });
  if (corpus.corpus_id !== 'decision-quality-eval-v0') problems.push({ at: 'corpus', rule: 'corpus_id_mismatch' });
  if (!PROOF_LEVELS.includes(corpus.proof_level)) problems.push({ at: 'corpus', rule: 'corpus_proof_level_known' });
  if (corpus.live_proof !== false) problems.push({ at: 'corpus', rule: 'live_proof_must_be_false' });
  if (!Array.isArray(corpus.cases)) problems.push({ at: 'corpus', rule: 'cases_must_be_array' });
  else for (const item of corpus.cases) problems.push(...validateCase(item, item?.case_id ?? 'case'));
  return problems;
}

const axisFailed = (score) => score !== 'N/A' && score <= 1;

export function validateReport(report) {
  const problems = [];
  if (!report || typeof report !== 'object') return [{ at: 'report', rule: 'report_must_be_object' }];
  if (extraKeys(report, REPORT_KEYS).length > 0)
    problems.push({ at: 'report', rule: 'report_has_extra_fields' });
  if (report.corpus_id !== 'decision-quality-eval-v0') problems.push({ at: 'report', rule: 'corpus_id_mismatch' });
  if (report.proof_level !== 'offline_human_eval')
    problems.push({ at: 'report', rule: 'report_proof_level_must_be_offline_human_eval' });
  if (report.live_proof !== false) problems.push({ at: 'report', rule: 'live_proof_must_be_false' });
  if (!report.model || typeof report.model.id !== 'string' || typeof report.model.version !== 'string'
    || typeof report.model.prompt_id !== 'string')
    problems.push({ at: 'report', rule: 'model_must_be_named_with_version' });
  if (!Number.isInteger(report.scored_cases) || report.scored_cases < 0)
    problems.push({ at: 'report', rule: 'scored_cases_required' });
  if (!report.axis_summary || typeof report.axis_summary !== 'object')
    problems.push({ at: 'report', rule: 'axis_summary_required' });
  else for (const axis of AXES) {
    const value = report.axis_summary[axis];
    if (!value || !Number.isInteger(value.scored) || !Number.isInteger(value.na))
      problems.push({ at: `report.axis_summary.${axis}`, rule: 'axis_counts_required' });
    if (value && value.aggregate_score !== undefined)
      problems.push({ at: `report.axis_summary.${axis}`, rule: 'no_aggregate_magic_score' });
  }
  // A single headline number is exactly what this benchmark refuses to produce.
  if (report.aggregate_score !== undefined) problems.push({ at: 'report', rule: 'no_aggregate_magic_score' });
  if (!Array.isArray(report.case_results)) {
    problems.push({ at: 'report', rule: 'case_results_required' });
  } else {
    // failed_cases must be derivable from case_results, so a failing case cannot quietly vanish.
    const derived = new Set();
    report.case_results.forEach((result, index) => {
      if (!result || typeof result.case_id !== 'string' || result.case_id.length === 0)
        problems.push({ at: `report.case_results[${index}]`, rule: 'case_id_required' });
      const finalAxes = result?.final_axes ?? {};
      for (const axis of AXES) {
        const score = finalAxes[axis];
        if (!validScore(score)) problems.push({ at: `report.case_results[${index}].${axis}`, rule: 'final_axis_score_invalid' });
        else if (axisFailed(score)) derived.add(`${result.case_id}|${axis}`);
      }
      if (result && typeof result.failed !== 'boolean')
        problems.push({ at: `report.case_results[${index}]`, rule: 'failed_flag_required' });
      if (result && finalAxes && result.failed !== AXES.some((axis) => axisFailed(finalAxes[axis])))
        problems.push({ at: `report.case_results[${index}]`, rule: 'failed_flag_must_match_final_axes' });
    });
    if (!Array.isArray(report.failed_cases)) problems.push({ at: 'report', rule: 'failed_cases_required' });
    else {
      const listed = new Set(report.failed_cases.map((row) => `${row?.case_id}|${row?.axis}`));
      for (const missing of derived) if (!listed.has(missing))
        problems.push({ at: 'report.failed_cases', rule: `failed_case_missing:${missing}` });
      for (const invented of listed) if (!derived.has(invented))
        problems.push({ at: 'report.failed_cases', rule: `failed_case_invented:${invented}` });
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const corpus = JSON.parse(fs.readFileSync(path.join(HERE, 'corpus.json'), 'utf8'));
  const problems = validateCorpus(corpus);
  if (problems.length) {
    console.error(JSON.stringify({ corpus: 'corrupted', problems }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ corpus: 'ok', cases: corpus.cases.length, live_proof: false }));
}
