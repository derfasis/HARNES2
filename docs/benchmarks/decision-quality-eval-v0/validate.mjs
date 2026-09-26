// Structure validator for the decision-quality evaluation corpus and report.
// It checks shape, never quality. A non-zero exit means the benchmark is corrupted,
// NOT that the system under test performed badly — those must never share an exit code.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const AXES = ['grounding', 'intent_understanding', 'calibration', 'relevance',
  'decision_quality', 'operator_usefulness'];

const FAILURE_TAGS = ['invented_fact', 'unsupported_permission', 'missed_opportunity',
  'overclaim', 'wrong_intent', 'premature_action'];
const CLAIM_REF = /^prov_[A-Za-z0-9._-]{1,120}$/;
const PROOF_LEVELS = ['synthetic_contract_eval', 'offline_human_eval'];
const CASE_KEYS = ['case_id', 'provenance', 'frozen_input', 'offer', 'operator_goal', 'gold_annotations',
  'model_output', 'scores', 'adjudication', 'final_axes', 'failure_tags'];
const REPORT_KEYS = ['corpus_id', 'proof_level', 'live_proof', 'model', 'scored_cases',
  'not_applicable_cases', 'axis_summary', 'case_results', 'failed_cases'];

// The JSON Schemas are compiled and run as a real second guard on the same data the hand-written
// invariants see. The hand-written checks stay canonical for cross-field rules; the schemas catch
// shape and type drift between the two, which is how a dangling $ref would otherwise hide.
const ajv = new Ajv({ strict: false });
const compiled = {
  corpus: ajv.compile(JSON.parse(fs.readFileSync(path.join(HERE, 'corpus.schema.json'), 'utf8'))),
  report: ajv.compile(JSON.parse(fs.readFileSync(path.join(HERE, 'report.schema.json'), 'utf8'))),
};
const schemaProblems = (kind, value, at) => (compiled[kind](value) ? []
  : (compiled[kind].errors ?? []).map((error) => ({ at: `${at}${error.instancePath || ''}`.trim(),
    rule: `schema:${error.keyword}` })));

const own = (value, keys) => keys.every((key) => Object.prototype.hasOwnProperty.call(value ?? {}, key));
const extraKeys = (value, keys) => Object.keys(value ?? {}).filter((key) => !keys.includes(key));
const validScore = (value) => (Number.isInteger(value) && value >= 0 && value <= 3) || value === 'N/A';

// Deliberately hand-written rather than schema-driven: a validator that can be reconfigured
// alongside the data can be talked into accepting anything. It checks the rules that matter and
// names the rule it broke.
// The reviewer protocol, applied identically to a corpus case and to a report case_result.
function validateReviews(reviews, adjudication, at, problems) {
  const require_ = (condition, rule) => { if (!condition) problems.push({ at, rule }); };
  require_(Array.isArray(reviews) && reviews.length === 2, 'exactly_two_reviews_required');
  const list = Array.isArray(reviews) ? reviews : [];
  const reviewers = new Set();
  for (const scoring of list) {
    require_(typeof scoring?.reviewer === 'string' && scoring.reviewer.length > 0, 'scoring_reviewer_required');
    require_(scoring?.axes && typeof scoring.axes === 'object', 'scoring_axes_required');
    require_(extraKeys(scoring, ['reviewer', 'axes', 'failure_tags']).length === 0, 'scoring_has_extra_fields');
    require_(Array.isArray(scoring?.failure_tags), 'scoring_failure_tags_required');
    require_(extraKeys(scoring?.axes, AXES).length === 0, 'scoring_axes_has_extra_fields');
    for (const axis of AXES) require_(own(scoring?.axes, [axis]), `axis_${axis}_required`);
    for (const axis of AXES) require_(validScore(scoring?.axes?.[axis]), `axis_${axis}_score_invalid`);
    for (const tag of Array.isArray(scoring?.failure_tags) ? scoring.failure_tags : [])
      require_(FAILURE_TAGS.includes(tag), `failure_tag_unknown:${tag}`);
    reviewers.add(scoring?.reviewer);
  }
  require_(reviewers.size === 2, 'two_distinct_reviewers_required');
  // Any difference at all needs a third person. Leaving room for an undefined "small" gap is how
  // two people invent a rule nobody wrote down.
  const divergent = list.length === 2 && AXES.some((axis) => list[0]?.axes?.[axis] !== list[1]?.axes?.[axis]);
  require_(divergent === !!adjudication, divergent ? 'adjudication_required' : 'adjudication_not_expected');
  if (adjudication) {
    require_(typeof adjudication.reviewer === 'string' && adjudication.reviewer.length > 0,
      'adjudication_reviewer_required');
    // The adjudicator is a third person, not one of the two who already scored the case.
    require_(!reviewers.has(adjudication.reviewer), 'adjudicator_must_be_a_third_reviewer');
    require_(extraKeys(adjudication, ['reviewer', 'final_axes', 'reason']).length === 0,
      'adjudication_has_extra_fields');
    require_(typeof adjudication.reason === 'string' && adjudication.reason.length > 0,
      'adjudication_reason_required');
    require_(extraKeys(adjudication.final_axes, AXES).length === 0 && own(adjudication.final_axes, AXES),
      'adjudication_final_axes_required');
    for (const axis of AXES)
      require_(validScore(adjudication.final_axes?.[axis]), `adjudication_axis_${axis}_score_invalid`);
  }
  return problems;
}

// The published final_axes is never a free choice: it is what the two reviewers agreed on, or
// exactly what the adjudicator wrote. Anything else is a number that appeared from nowhere.
function checkPublishedAxes(reviews, adjudication, finalAxes, at, problems) {
  const require_ = (condition, rule) => { if (!condition) problems.push({ at, rule }); };
  // A corrupted shape must yield findings, not a TypeError: a validator that crashes on bad input
  // cannot report that the input is bad.
  const list = Array.isArray(reviews) ? reviews : [];
  if (list.length !== 2) { require_(false, 'exactly_two_reviews_required'); return; }
  const [a, b] = list;
  for (const axis of AXES) {
    const left = a?.axes?.[axis], right = b?.axes?.[axis];
    if (left === right) {
      // The reviewers agreed here. Nobody, including the adjudicator, may change it.
      require_(finalAxes?.[axis] === left, `agreed_axis_${axis}_must_not_be_rewritten`);
      if (adjudication) require_(adjudication?.final_axes?.[axis] === left,
        `adjudicator_must_preserve_agreed_axis_${axis}`);
    } else {
      // Only a disputed axis may be resolved, and only by the third person.
      require_(!!adjudication, `disputed_axis_${axis}_needs_adjudication`);
      require_(finalAxes?.[axis] === adjudication?.final_axes?.[axis],
        `disputed_axis_${axis}_must_be_the_adjudicated_score`);
    }
  }
}

// The aggregate tags of a case are the union of what its reviewers wrote, never a separate field
// someone can clear.
export const derivedTags = (reviews) => {
  const list = Array.isArray(reviews) ? reviews : [];
  const tags = new Set();
  for (const scoring of list) for (const tag of Array.isArray(scoring?.failure_tags) ? scoring.failure_tags : []) tags.add(tag);
  return [...tags].sort();
};

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

  validateReviews(item.scores, item.adjudication, at, problems);
  checkPublishedAxes(item.scores, item.adjudication, item.final_axes, at, problems);
  if (!Array.isArray(item.failure_tags)) problems.push({ at, rule: 'case_failure_tags_required' });
  else if (!sameValue([...item.failure_tags].sort(), derivedTags(item.scores)))
    problems.push({ at, rule: 'case_failure_tags_must_be_the_reviewers_union' });
  return problems;
}

export function validateCorpus(corpus) {
  const problems = [];
  if (!corpus || typeof corpus !== 'object') return [{ at: 'corpus', rule: 'corpus_must_be_object' }];
  if (extraKeys(corpus, ['corpus_id', 'proof_level', 'live_proof', 'generation', 'cases']).length > 0)
    problems.push({ at: 'corpus', rule: 'corpus_has_extra_fields' });
  if (corpus.proof_level === 'offline_human_eval' && !corpus.generation)
    problems.push({ at: 'corpus', rule: 'offline_eval_requires_frozen_generation_identity' });
  if (corpus.corpus_id !== 'decision-quality-eval-v0') problems.push({ at: 'corpus', rule: 'corpus_id_mismatch' });
  if (!PROOF_LEVELS.includes(corpus.proof_level)) problems.push({ at: 'corpus', rule: 'corpus_proof_level_known' });
  if (corpus.live_proof !== false) problems.push({ at: 'corpus', rule: 'live_proof_must_be_false' });
  if (!Array.isArray(corpus.cases)) problems.push({ at: 'corpus', rule: 'cases_must_be_array' });
  else if (corpus?.proof_level === 'offline_human_eval' && corpus.cases.some((item) =>
    item?.provenance?.kind !== 'anonymized_real'
    || !/^prov_[A-Za-z0-9._-]+$/.test(item.provenance.provenance_claim_ref ?? '')))
    problems.push({ at: 'corpus', rule: 'offline_eval_cases_must_be_anonymized_real_with_a_provenance_claim' });
  else {
    const seen = new Set();
    for (const item of corpus.cases) {
      const id = item?.case_id;
      if (id) { if (seen.has(id)) problems.push({ at: id, rule: 'case_id_must_be_unique' }); seen.add(id); }
      problems.push(...validateCase(item, id ?? 'case'));
    }
    problems.push(...schemaProblems('corpus', corpus, 'corpus.'));
  }
  return problems;
}

const axisFailed = (score) => score !== 'N/A' && score <= 1;
const round3 = (value) => Math.round(value * 1000) / 1000;
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Everything a report asserts is recomputed from case_results. A metric that cannot be derived
// from the per-case results is a number someone typed, and a benchmark cannot be built on that.
export function deriveReportFacts(report) {
  const results = Array.isArray(report?.case_results) ? report.case_results : [];
  const axis = Object.fromEntries(AXES.map((name) => [name, { scores: [], na: 0 }]));
  const failures = [];
  for (const result of results) {
    for (const name of AXES) {
      const score = result?.final_axes?.[name];
      if (score === 'N/A') axis[name].na += 1;
      else if (Number.isInteger(score)) axis[name].scores.push(score);
      else continue;
      if (axisFailed(score) && result?.case_id) {
        failures.push({ case_id: result.case_id, axis: name, score, failure_tags: derivedTags(result.reviews) });
      }
    }
  }
  const summary = Object.fromEntries(AXES.map((name) => {
    const { scores, na } = axis[name];
    return [name, { scored: scores.length, na,
      mean: scores.length ? round3(scores.reduce((a, b) => a + b, 0) / scores.length) : null }];
  }));
  return {
    scored_cases: results.length,
    not_applicable_cases: results.filter((result) => AXES.every((name) => result?.final_axes?.[name] === 'N/A')).length,
    axis_summary: summary,
    failed_cases: failures.sort((a, b) => `${a.case_id}|${a.axis}`.localeCompare(`${b.case_id}|${b.axis}`)),
  };
}

export function validateReport(report) {
  const problems = [];
  if (!report || typeof report !== 'object') return [{ at: 'report', rule: 'report_must_be_object' }];
  if (extraKeys(report, REPORT_KEYS).length > 0)
    problems.push({ at: 'report', rule: 'report_has_extra_fields' });
  if (report.corpus_id !== 'decision-quality-eval-v0') problems.push({ at: 'report', rule: 'corpus_id_mismatch' });
  if (report.proof_level !== 'offline_human_eval')
    problems.push({ at: 'report', rule: 'report_proof_level_must_be_offline_human_eval' });
  if (report.live_proof !== false) problems.push({ at: 'report', rule: 'live_proof_must_be_false' });
  if (extraKeys(report.model ?? {}, ['id', 'version', 'prompt_id', 'prompt_digest']).length > 0
    || typeof report.model?.id !== 'string' || typeof report.model?.version !== 'string'
    || typeof report.model?.prompt_id !== 'string' || typeof report.model?.prompt_digest !== 'string')
    problems.push({ at: 'report', rule: 'model_must_be_named_with_version_and_digest' });
  if (!Array.isArray(report.case_results)) {
    problems.push({ at: 'report', rule: 'case_results_required' });
    return problems;
  }
  const seenCaseIds = new Set();
  report.case_results.forEach((result, index) => {
    const at = `report.case_results[${index}]`;
    if (extraKeys(result ?? {}, ['case_id', 'reviews', 'adjudication', 'final_axes', 'failure_tags', 'failed']).length > 0)
      problems.push({ at, rule: 'case_result_has_extra_fields' });
    if (typeof result?.case_id !== 'string' || result.case_id.length === 0)
      problems.push({ at, rule: 'case_id_required' });
    if (seenCaseIds.has(result?.case_id)) problems.push({ at, rule: 'case_id_must_be_unique' });
    seenCaseIds.add(result?.case_id);
    if (extraKeys(result?.final_axes, AXES).length > 0 || !own(result?.final_axes, AXES))
      problems.push({ at, rule: 'final_axes_required' });
    for (const axis of AXES) if (!validScore(result?.final_axes?.[axis]))
      problems.push({ at: axis, rule: 'final_axis_score_invalid' });
    if (!Array.isArray(result?.failure_tags)) problems.push({ at, rule: 'failure_tags_required' });
    for (const tag of Array.isArray(result?.failure_tags) ? result.failure_tags : [])
      if (!FAILURE_TAGS.includes(tag)) problems.push({ at, rule: `failure_tag_unknown:${tag}` });
    if (!sameValue([...(Array.isArray(result?.failure_tags) ? result.failure_tags : [])].sort(),
      derivedTags(result?.reviews)))
      problems.push({ at, rule: 'failure_tags_must_be_the_reviewers_union' });
    if (typeof result?.failed !== 'boolean') problems.push({ at, rule: 'failed_flag_required' });
    else if (result.failed !== AXES.some((axis) => axisFailed(result.final_axes?.[axis])))
      problems.push({ at, rule: 'failed_flag_must_match_final_axes' });
    // The same reviewer protocol applies inside a report, not only inside a corpus case.
    validateReviews(result?.reviews, result?.adjudication, at, problems);
    checkPublishedAxes(result?.reviews, result?.adjudication, result?.final_axes, at, problems);
  });
  problems.push(...schemaProblems('report', report, 'report.'));
  // A single headline number is exactly what this benchmark refuses to produce.
  if (report.aggregate_score !== undefined) problems.push({ at: 'report', rule: 'no_aggregate_magic_score' });
  for (const axis of AXES)
    if (report.axis_summary?.[axis] && report.axis_summary[axis].aggregate_score !== undefined)
      problems.push({ at: `report.axis_summary.${axis}`, rule: 'no_aggregate_magic_score' });
  const facts = deriveReportFacts(report);
  if (report.scored_cases !== facts.scored_cases)
    problems.push({ at: 'report.scored_cases', rule: 'scored_cases_must_be_derived' });
  if (report.not_applicable_cases !== undefined && report.not_applicable_cases !== facts.not_applicable_cases)
    problems.push({ at: 'report.not_applicable_cases', rule: 'not_applicable_cases_must_be_derived' });
  if (!report.axis_summary || typeof report.axis_summary !== 'object') {
    problems.push({ at: 'report', rule: 'axis_summary_required' });
  } else for (const axis of AXES) {
    if (!sameValue(report.axis_summary[axis], facts.axis_summary[axis]))
      problems.push({ at: `report.axis_summary.${axis}`, rule: 'axis_summary_must_be_derived' });
  }
  // failed_cases is an exact derivation, not a selection: no duplicates, nothing invented.
  const listed = Array.isArray(report.failed_cases) ? report.failed_cases : [];
  if (!Array.isArray(report.failed_cases)) problems.push({ at: 'report', rule: 'failed_cases_required' });
  const keys = listed.map((row) => `${row?.case_id}|${row?.axis}`);
  if (new Set(keys).size !== keys.length)
    problems.push({ at: 'report.failed_cases', rule: 'failed_cases_must_not_duplicate' });
  for (const row of listed) {
    if (extraKeys(row ?? {}, ['case_id', 'axis', 'score', 'failure_tags']).length > 0)
      problems.push({ at: 'report.failed_cases', rule: 'failed_case_has_extra_fields' });
    if (!AXES.includes(row?.axis)) problems.push({ at: 'report.failed_cases', rule: 'failed_case_axis_known' });
    if (!validScore(row?.score)) problems.push({ at: 'report.failed_cases', rule: 'failed_case_score_invalid' });
  }
  if (!sameValue([...listed].map((row) => ({ case_id: row?.case_id, axis: row?.axis, score: row?.score,
    failure_tags: [...(Array.isArray(row?.failure_tags) ? row.failure_tags : [])].sort() })), facts.failed_cases))
    problems.push({ at: 'report.failed_cases', rule: 'failed_cases_must_be_exactly_derived' });
  return problems;
}

// A report may only claim a real offline evaluation if the corpus behind it really holds one —
// and the report is a projection of that corpus, never a second independent source of truth.
export function validateEvaluation(corpus, report) {
  const problems = [];
  const cases = Array.isArray(corpus?.cases) ? corpus.cases : [];
  // The report's claim decides what the corpus must be. A report may not fall back on the corpus
  // labelling itself synthetic and quietly claim a real measurement.
  if (report?.proof_level === 'offline_human_eval' && corpus?.proof_level !== 'offline_human_eval')
    problems.push({ at: 'corpus', rule: 'offline_report_requires_offline_corpus' });
  const claimsReal = corpus?.proof_level === 'offline_human_eval' || report?.proof_level === 'offline_human_eval';
  if (claimsReal) {
    if (cases.length === 0) problems.push({ at: 'corpus', rule: 'offline_eval_requires_cases' });
    if (!corpus?.generation || typeof corpus.generation !== 'object')
      problems.push({ at: 'corpus', rule: 'offline_eval_requires_frozen_generation_identity' });
    for (const item of cases) {
      const at = item?.case_id ?? 'case';
      if (item?.provenance?.kind !== 'anonymized_real')
        problems.push({ at, rule: 'offline_eval_case_must_be_anonymized_real' });
      if (!CLAIM_REF.test(item?.provenance?.provenance_claim_ref ?? ''))
        problems.push({ at, rule: 'offline_eval_case_requires_provenance_claim' });
      if (item?.model_output === null || item?.model_output === undefined)
        problems.push({ at, rule: 'offline_eval_case_requires_model_output' });
    }
  }
  // The generation identity is frozen in the corpus. Without it a benchmark cannot honestly be
  // attributed to a model, and "prompt_id" alone is a free string rather than a reference.
  const generation = corpus?.generation;
  if (generation) {
    for (const key of ['model_id', 'model_version', 'prompt_ref', 'prompt_digest'])
      if (typeof generation[key] !== 'string' || generation[key].length === 0)
        problems.push({ at: 'corpus.generation', rule: `generation_${key}_required` });
    if (report?.model) {
      if (report.model.id !== generation.model_id) problems.push({ at: 'report.model', rule: 'model_id_must_match_corpus' });
      if (report.model.version !== generation.model_version) problems.push({ at: 'report.model', rule: 'model_version_must_match_corpus' });
      if (report.model.prompt_id !== generation.prompt_ref) problems.push({ at: 'report.model', rule: 'prompt_ref_must_match_corpus' });
      // Exact equality, always: an absent digest is not a passing digest.
      if (report.model.prompt_digest !== generation.prompt_digest)
        problems.push({ at: 'report.model', rule: 'prompt_digest_must_match_corpus' });
    }
  }
  const byId = new Map(cases.filter((item) => item?.case_id).map((item) => [item.case_id, item]));
  const reportIds = (Array.isArray(report?.case_results) ? report.case_results : [])
    .map((row) => row?.case_id).filter(Boolean).sort();
  const corpusIds = [...byId.keys()].sort();
  if (corpusIds.length > 0 && !sameValue(corpusIds, reportIds))
    problems.push({ at: 'report', rule: 'report_case_ids_must_match_corpus' });
  // Reviews and adjudication in the report must be the corpus's own, compared by reviewer id so
  // that ordering cannot hide a substitution.
  const canonical = (reviews) => [...(Array.isArray(reviews) ? reviews : [])]
    .map((scoring) => ({ reviewer: scoring?.reviewer, axes: scoring?.axes,
      failure_tags: [...(Array.isArray(scoring?.failure_tags) ? scoring.failure_tags : [])].sort() }))
    .sort((a, b) => String(a.reviewer).localeCompare(String(b.reviewer)));
  for (const result of Array.isArray(report?.case_results) ? report.case_results : []) {
    const source = byId.get(result?.case_id);
    if (!source) continue;
    if (!sameValue(canonical(result?.reviews), canonical(source.scores)))
      problems.push({ at: result.case_id, rule: 'report_reviews_must_match_corpus_scores' });
    const left = source.adjudication ?? null, right = result?.adjudication ?? null;
    const sameAdjudication = (!left && !right) || (!!left && !!right
      && left.reviewer === right.reviewer && sameValue(left.final_axes, right.final_axes)
      && left.reason === right.reason);
    if (!sameAdjudication)
      problems.push({ at: result.case_id, rule: 'report_adjudication_must_match_corpus' });
    if (source.final_axes !== undefined && !sameValue(result?.final_axes, source.final_axes))
      problems.push({ at: result.case_id, rule: 'report_final_axes_must_match_corpus' });
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
