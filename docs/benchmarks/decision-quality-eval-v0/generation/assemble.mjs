// The end of the evaluation pipeline: staged input + generated output + human reviews become the
// finished 4D0 corpus, and the report is derived from that corpus alone.
//
// The corpus is the single source of truth. A report is never built from reviews or generated
// output directly, because two sources of truth drift apart, and a report that disagrees with its
// own corpus is worse than no report.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AXES, BINDINGS, contractCarries, outputProblems, parseRaw, promptDigest, stagedCaseDigest }
  from './staging.mjs';
import { validateCorpus, validateEvaluation, validateReport } from '../validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REVIEW_PROTOCOL = 'decision-quality-eval-v0/reviewer-protocol';

const own = (value, keys) => keys.every((key) => Object.prototype.hasOwnProperty.call(value ?? {}, key));
const uniqueTags = (...lists) => [...new Set(lists.flatMap((list) => Array.isArray(list) ? list : []))].sort();

// Every artefact must be ours, from this prompt, for this exact case, and still valid. Otherwise
// the corpus would be a report on something the model was never asked.
function artefactProblems(artefact, staged, digest) {
  const problems = [];
  if (!artefact || typeof artefact !== 'object') return ['artefact_is_missing'];
  if (artefact.prompt_sha256 !== digest) problems.push('artefact_was_produced_with_another_prompt');
  if (artefact.staged_case_sha256 !== stagedCaseDigest(staged)) problems.push('artefact_answers_another_case');
  if (typeof artefact.model_id !== 'string' || !artefact.model_id) problems.push('artefact_has_no_model_id');
  if (typeof artefact.model_version !== 'string' || !artefact.model_version)
    problems.push('artefact_has_no_model_version');
  if (!problems.length) problems.push(...outputProblems(artefact.raw, staged));
  return problems;
}

// The published axes, computed the same way the evaluation itself computed them: an agreed axis is
// untouchable, a disputed one must be resolved by the third person.
function publishedAxes(reviews, adjudication) {
  const [a, b] = reviews;
  const axes = {};
  for (const axis of AXES) {
    const left = a?.axes?.[axis], right = b?.axes?.[axis];
    if (left === right) {
      if (adjudication && adjudication.final_axes?.[axis] !== left) return { problem: `agreed_axis_${axis}_must_not_be_rewritten` };
      axes[axis] = left;
    } else {
      if (!adjudication) return { problem: `disputed_axis_${axis}_needs_adjudication` };
      axes[axis] = adjudication.final_axes?.[axis];
    }
  }
  return { axes };
}

// Assemble the finished corpus. It refuses rather than producing a corpus that could not be
// defended: two human reviews, a third person for disagreement, and identity only from the
// generated artefacts.
export function assembleCorpus({ input, artefacts = {}, reviews = {}, adjudications = {},
  protocol = REVIEW_PROTOCOL } = {}) {
  const problems = [];
  const cases = [];
  const digest = promptDigest();
  const identities = new Map();

  for (const staged of input?.cases ?? []) {
    const caseId = staged.case_id;
    const artefact = artefacts[caseId];
    problems.push(...artefactProblems(artefact, staged, digest).map((rule) => `${caseId}:${rule}`));
    if (!artefact) continue;

    const pair = reviews[caseId] ?? [];
    if (pair.length !== 2) { problems.push(`${caseId}:exactly_two_human_reviews_are_required`); continue; }
    if (pair[0]?.reviewer === pair[1]?.reviewer) { problems.push(`${caseId}:two_distinct_reviewers_are_required`); continue; }
    // A model may not be one of the two people. The assembler cannot prove a person is a person;
    // it can only refuse the identities it can see are the machine.
    for (const review of pair) {
      if (typeof review?.reviewer !== 'string' || !review.reviewer) problems.push(`${caseId}:reviewer_id_is_required`);
      if (review?.reviewer === artefact.model_id || review?.kind === 'model' || review?.kind === 'agent')
        problems.push(`${caseId}:a_model_may_not_stand_in_for_a_human_reviewer`);
    }
    for (const review of pair) {
      if (review?.protocol !== protocol)
        problems.push(`${caseId}:reviews_must_declare_the_reviewer_protocol`);
      if (!own(review?.axes ?? {}, AXES)) problems.push(`${caseId}:review_is_missing_axes`);
      for (const axis of AXES) {
        const score = review?.axes?.[axis];
        if (!((Number.isInteger(score) && score >= 0 && score <= 3) || score === 'N/A'))
          problems.push(`${caseId}:axis_${axis}_score_is_invalid`);
      }
    }
    if (problems.some((rule) => rule.startsWith(`${caseId}:`))) continue;

    const adjudication = adjudications[caseId] ?? null;
    const published = publishedAxes(pair, adjudication);
    if (published.problem) { problems.push(`${caseId}:${published.problem}`); continue; }
    if (adjudication) {
      if (typeof adjudication.reviewer !== 'string' || !adjudication.reviewer)
        problems.push(`${caseId}:adjudication_reviewer_is_required`);
      else if (pair.some((review) => review.reviewer === adjudication.reviewer))
        problems.push(`${caseId}:adjudicator_must_be_a_third_reviewer`);
      if (typeof adjudication.reason !== 'string' || !adjudication.reason)
        problems.push(`${caseId}:adjudication_reason_is_required`);
    }

    identities.set(`${artefact.model_id}@${artefact.model_version}`, true);
    const [first, second] = pair;
    cases.push({
      case_id: caseId,
      provenance: staged.provenance,
      frozen_input: { source_text: staged.messages.find((message) => message.is_anchor)?.text ?? '',
        author: staged.subject.author_id, context: staged.situation.goal_text,
        known_unknowns: staged.known_unknowns ?? [] },
      offer: staged.offer,
      operator_goal: staged.operator_goal,
      gold_annotations: staged.gold_annotations,
      model_output: JSON.parse(artefact.raw),
      scores: [
        { reviewer: first.reviewer, axes: first.axes,
          failure_tags: [...(first.failure_tags ?? [])].sort() },
        { reviewer: second.reviewer, axes: second.axes,
          failure_tags: [...(second.failure_tags ?? [])].sort() },
      ],
      ...(adjudication ? { adjudication } : {}),
      final_axes: published.axes,
      failure_tags: uniqueTags(first.failure_tags, second.failure_tags,
        adjudication?.failure_tags),
    });
  }

  if (identities.size > 1) problems.push(`the_evaluation_spans_several_models:${[...identities.keys()].join(',')}`);
  const promptRef = input?.prompt_ref;
  if (typeof promptRef !== 'string' || !promptRef)
    problems.push('the_staged_input_never_named_the_prompt_the_corpus_would_claim');
  if (problems.length) return { corpus: null, problems };

  const first = Object.entries(artefacts)[0]?.[1] ?? {};
  const corpus = {
    corpus_id: 'decision-quality-eval-v0',
    proof_level: 'offline_human_eval',
    live_proof: false,
    // The finished corpus must name the prompt it evaluated. If the staged input never named one,
    // the corpus cannot claim a prompt identity, so nothing is produced.
    generation: { model_id: first.model_id, model_version: first.model_version,
      prompt_ref: promptRef, prompt_digest: digest },
    cases: cases.map((item) => {
      // The shape the 4D0 corpus schema demands, rebuilt from what we know.
      const artefact = artefacts[item.case_id];
      const { parsed } = parseRaw(artefact.raw);
      return { ...item, model_output: parsed };
    }),
  };
  // The corpus must satisfy the finished contract before anything is called finished.
  const corpusProblems = validateCorpus(corpus);
  if (corpusProblems.length) return { corpus: null, problems: corpusProblems };
  return { corpus, problems: [] };
}

// The report is derived from the corpus and nothing else.
export function deriveReport(corpus) {
  const problems = [];
  if (!corpus) return { report: null, problems: ['a_report_needs_a_corpus'] };
  const caseResults = (corpus.cases ?? []).map((item) => ({
    case_id: item.case_id,
    reviews: item.scores.map((score) => ({ reviewer: score.reviewer, axes: score.axes,
      failure_tags: score.failure_tags })),
    ...(item.adjudication ? { adjudication: item.adjudication } : {}),
    final_axes: item.final_axes,
    failure_tags: item.failure_tags,
    failed: AXES.some((axis) => item.final_axes[axis] !== 'N/A' && item.final_axes[axis] <= 1),
  }));
  // Ordered exactly as the validator recomputes them, so the two can be compared without
  // a difference in ordering masquerading as a difference in the data.
  const failedCases = [];
  for (const result of caseResults) {
    for (const axis of AXES) {
      const score = result.final_axes[axis];
      if (score !== 'N/A' && score <= 1)
        failedCases.push({ case_id: result.case_id, axis, score, failure_tags: result.failure_tags });
    }
  }
  failedCases.sort((a, b) => `${a.case_id}|${a.axis}`.localeCompare(`${b.case_id}|${b.axis}`));
  const report = {
    corpus_id: corpus.corpus_id,
    proof_level: 'offline_human_eval',
    live_proof: false,
    model: { id: corpus.generation?.model_id, version: corpus.generation?.model_version,
      prompt_id: corpus.generation?.prompt_ref, prompt_digest: corpus.generation?.prompt_digest },
    scored_cases: caseResults.length,
    not_applicable_cases: caseResults.filter((result) => AXES.every((axis) => result.final_axes[axis] === 'N/A')).length,
    axis_summary: Object.fromEntries(AXES.map((axis) => {
      const scores = caseResults.map((result) => result.final_axes[axis]);
      const usable = scores.filter((score) => score !== 'N/A');
      const mean = usable.length
        ? Math.round((usable.reduce((a, b) => a + b, 0) / usable.length) * 1000) / 1000 : null;
      return [axis, { scored: usable.length, na: scores.length - usable.length, mean }];
    })),
    case_results: caseResults,
    failed_cases: failedCases,
  };
  const reportProblems = validateReport(report);
  if (reportProblems.length) return { report: null, problems: reportProblems };
  const linkProblems = validateEvaluation({ ...corpus }, report);
  if (linkProblems.length) return { report: null, problems: linkProblems };
  return { report, problems: [] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.error('This module assembles and derives. It reads nothing and writes nothing on its own.');
  process.exit(0);
}
void contractCarries;
void BINDINGS;
