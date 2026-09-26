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

// Deliberately hand-written rather than schema-driven: a benchmark whose validator can be
// reconfigured alongside the data can be talked into accepting anything. This checks the handful
// of rules that actually matter, and says which rule it broke.
export function validateCase(item, at = 'case') {
  const problems = [];
  const require_ = (condition, rule) => { if (!condition) problems.push({ at, rule }); };
  require_(item && typeof item === 'object' && !Array.isArray(item), 'case_must_be_object');
  if (problems.length) return problems;
  require_(typeof item.case_id === 'string' && item.case_id.length > 0, 'case_id_required');
  require_(item.provenance && typeof item.provenance === 'object', 'provenance_required');
  const kind = item.provenance?.kind;
  require_(kind === 'sanitized_fixture' || kind === 'anonymized_real', 'provenance_kind_known');
  // The one rule that matters most: a real case must prove it came from a real source.
  if (kind === 'anonymized_real')
    require_(typeof item.provenance.provenance_ref === 'string' && item.provenance.provenance_ref.length > 0,
      'real_case_requires_provenance_ref');
  require_(item.frozen_input && typeof item.frozen_input === 'object', 'frozen_input_required');
  require_(typeof item.frozen_input?.source_text === 'string' && item.frozen_input.source_text.length > 0,
    'frozen_input_source_text_required');
  require_(Array.isArray(item.frozen_input?.known_unknowns), 'frozen_input_known_unknowns_required');
  require_(typeof item.offer === 'string' && item.offer.length > 0, 'offer_required');
  require_(typeof item.operator_goal === 'string' && item.operator_goal.length > 0, 'operator_goal_required');
  require_(item.model_output === null || (typeof item.model_output === 'object' && !Array.isArray(item.model_output)),
    'model_output_object_or_null');
  for (const [index, scoring] of (item.scores ?? []).entries()) {
    const where = `${at}.scores[${index}]`;
    require_(typeof scoring?.reviewer === 'string' && scoring.reviewer.length > 0, 'scoring_reviewer_required');
    require_(scoring?.axes && typeof scoring.axes === 'object', 'scoring_axes_required');
    for (const axis of AXES)
      require_(axis in (scoring?.axes ?? {}), `axis_${axis}_required`);
    const valid = (value) => (Number.isInteger(value) && value >= 0 && value <= 3) || value === 'N/A';
    for (const axis of AXES) require_(valid(scoring?.axes?.[axis]), `axis_${axis}_score_invalid`);
    for (const tag of scoring?.failure_tags ?? [])
      require_(FAILURE_TAGS.includes(tag), `failure_tag_unknown:${tag}`);
  }
  if (item.adjudication) {
    require_(typeof item.adjudication.reviewer === 'string' && item.adjudication.reviewer.length > 0,
      'adjudication_reviewer_required');
    require_(typeof item.adjudication.reason === 'string' && item.adjudication.reason.length > 0,
      'adjudication_reason_required');
  }
  return problems;
}

export function validateCorpus(corpus) {
  const problems = [];
  if (!corpus || typeof corpus !== 'object') return [{ at: 'corpus', rule: 'corpus_must_be_object' }];
  if (corpus.corpus_id !== 'decision-quality-eval-v0') problems.push({ at: 'corpus', rule: 'corpus_id_mismatch' });
  if (corpus.live_proof !== false) problems.push({ at: 'corpus', rule: 'live_proof_must_be_false' });
  if (!Array.isArray(corpus.cases)) problems.push({ at: 'corpus', rule: 'cases_must_be_array' });
  else for (const item of corpus.cases) problems.push(...validateCase(item, item?.case_id ?? 'case'));
  return problems;
}

export function validateReport(report) {
  const problems = [];
  if (!report || typeof report !== 'object') return [{ at: 'report', rule: 'report_must_be_object' }];
  if (report.live_proof !== false) problems.push({ at: 'report', rule: 'live_proof_must_be_false' });
  if (!report.model || typeof report.model.id !== 'string' || typeof report.model.prompt_id !== 'string')
    problems.push({ at: 'report', rule: 'model_must_be_named' });
  if (!Number.isInteger(report.scored_cases) || report.scored_cases < 0)
    problems.push({ at: 'report', rule: 'scored_cases_required' });
  if (!report.axis_summary || typeof report.axis_summary !== 'object')
    problems.push({ at: 'report', rule: 'axis_summary_required' });
  else for (const axis of AXES) {
    const value = report.axis_summary[axis];
    if (!value || !Number.isInteger(value.scored) || !Number.isInteger(value.na))
      problems.push({ at: `report.axis_summary.${axis}`, rule: 'axis_counts_required' });
    // A single magic number across all axes is the thing this benchmark refuses to produce.
    if (value && value.aggregate_score !== undefined)
      problems.push({ at: `report.axis_summary.${axis}`, rule: 'no_aggregate_magic_score' });
  }
  if (!Array.isArray(report.failed_cases))
    problems.push({ at: 'report', rule: 'failed_cases_required' });
  return problems;
}

const corpus = JSON.parse(fs.readFileSync(path.join(HERE, 'corpus.json'), 'utf8'));
const problems = validateCorpus(corpus);
if (problems.length) {
  console.error(JSON.stringify({ corpus: 'corrupted', problems }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ corpus: 'ok', cases: corpus.cases.length, live_proof: false }));
