import Ajv from 'ajv';
import { digest } from './source-ingestion.mjs';

// Evaluation only: no model runner, source transport, business mutations or effects.
const text = { type: 'string', minLength: 1, maxLength: 16000 };
const id = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,149}$' };
const eventId = { type: 'string', pattern: '^[1-9][0-9]*$' };
const nullableId = { anyOf: [id, { type: 'null' }] };
const list = (items, maxItems = 1000) => ({ type: 'array', items, maxItems });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const DECISIONS = ['WAIT', 'IGNORE', 'REVIEW', 'STOP'];
const ASSESSMENTS = ['noise', 'insufficient_evidence', 'uncertain', 'need', 'opportunity', 'contradicted', 'refusal', 'resolved'];
const LABELS = ['positive', 'negative', 'uncertain', 'insufficient_evidence'];
const POSITIVE = new Set(['need', 'question', 'intent']);
const authoritySchema = object({ contact_permission: { const: false }, allowed_effects: { const: [] } });
const evidenceSchema = object({
  source_event_id: eventId, span: text,
  kind: { enum: ['need', 'question', 'intent', 'background', 'refusal', 'resolution', 'contradiction'] },
  attribution: { enum: ['author_statement', 'quoted_other', 'context'] },
});
const eventSchema = object({
  source_event_id: eventId, message_id: id, author_id: id, version: { type: 'integer', minimum: 1 },
  operation: { enum: ['upsert', 'delete', 'unsupported'] }, text: { anyOf: [text, { type: 'null' }] },
  created_at: text, updated_at: text, observed_at: text, reply_to_id: nullableId, thread_id: nullableId,
});
const checkpointSchema = object({
  id, after_event_id: eventId, anchor_message_id: id,
  judgment: object({
    label: { enum: LABELS }, rationale: text,
    acceptable_decisions: { ...list({ enum: DECISIONS }, 4), minItems: 1, uniqueItems: true },
    acceptable_assessments: { ...list({ enum: ASSESSMENTS }, 8), minItems: 1, uniqueItems: true },
    // Each alternative is a sufficient set of adjudicated exact spans, not a keyword rule.
    sufficient_evidence: list({ ...list(evidenceSchema, 20), minItems: 1 }, 10),
  }),
});
const corpusSchema = object({
  contract_version: { const: 'discovery-evaluation-v1' }, provenance: { const: 'synthetic_hand_authored' },
  offer: object({ id, version: text, text, criteria: { ...list(text, 20), minItems: 1 }, exclusions: list(text, 20) }),
  episodes: { ...list(object({
    id, purpose: text, source_id: text, subject_id: id,
    events: { ...list(eventSchema, 100), minItems: 1 },
    checkpoints: { ...list(checkpointSchema, 100), minItems: 1 },
    later_validation: list(object({
      after_event_id: eventId, checkpoint_id: id,
      interpretation: { enum: ['later_need_only', 'original_hypothesis_refuted', 'missed_existing_evidence', 'unknown'] },
      rationale: text,
    }), 20),
  }), 100), minItems: 1 },
});
const predictionSchema = object({
  checkpoint_id: id, prefix_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, offer_version: text,
  decision: { enum: DECISIONS }, assessment: { enum: ASSESSMENTS }, evidence: list(evidenceSchema, 20),
  authority: authoritySchema,
});
const ajv = new Ajv({ allErrors: true, strict: true });
const validCorpus = ajv.compile(corpusSchema);
const validPrediction = ajv.compile(predictionSchema);
const validPredictionSet = ajv.compile(object({
  contract_version: { const: 'discovery-predictions-v1' },
  provenance: object({ kind: { enum: ['model', 'human', 'synthetic_test'] }, label: text }),
  predictions: list({ type: 'object' }, 10000),
}));
const check = (condition, code) => { if (!condition) throw new Error(`Discovery evaluation: ${code}`); };
const time = value => {
  const milliseconds = Date.parse(value);
  check(Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value, 'INVALID_TIME');
  return milliseconds;
};
const emptyCounts = () => Object.fromEntries(LABELS.map(label => [label, 0]));
const ratio = (n, d) => d ? n / d : null;

function prefixContext(corpus, episode, checkpoint) {
  const cut = episode.events.findIndex(event => event.source_event_id === checkpoint.after_event_id);
  const prefix = episode.events.slice(0, cut + 1);
  const latest = new Map(prefix.map(event => [event.message_id, event]));
  const anchor = latest.get(checkpoint.anchor_message_id);
  const missing = new Set(), opaque = new Set(), deleted = new Set(), seen = new Set();
  let cycle = false;
  for (let current = anchor; current;) {
    if (seen.has(current.message_id)) { cycle = true; break; }
    seen.add(current.message_id);
    if (current.operation === 'unsupported') opaque.add(current.message_id);
    if (current.operation === 'delete') deleted.add(current.message_id);
    if (!current.reply_to_id) break;
    if (!latest.has(current.reply_to_id)) { missing.add(current.reply_to_id); break; }
    current = latest.get(current.reply_to_id);
  }
  const dependencySupported = event => {
    const chain = new Set();
    for (let current = event; current && !chain.has(current.message_id); current = latest.get(current.reply_to_id)) {
      chain.add(current.message_id);
      if (current.operation !== 'upsert') return false;
    }
    return true;
  };
  const observations = [...latest.values()].filter(event => event.operation === 'upsert' && dependencySupported(event))
    .map(({ operation, observed_at, ...event }) => structuredClone(event));
  const state = {
    contract_version: 'discovery-evaluation-context-v1', checkpoint_id: checkpoint.id,
    source_id: episode.source_id, subject_id: episode.subject_id, offer: structuredClone(corpus.offer),
    observed_through: { source_event_id: checkpoint.after_event_id, observed_at: prefix.at(-1).observed_at },
    anchor_message_id: checkpoint.anchor_message_id, observations,
    coverage: {
      unsupported_message_ids: [...latest.values()].filter(e => e.operation === 'unsupported').map(e => e.message_id),
      deleted_message_ids: [...latest.values()].filter(e => e.operation === 'delete').map(e => e.message_id),
      required_unsupported_message_ids: [...opaque], required_deleted_message_ids: [...deleted],
      missing_parent_ids: [...missing], reply_cycle: cycle,
      incomplete: opaque.size > 0 || deleted.size > 0 || missing.size > 0 || cycle,
    },
    authority: { contact_permission: false, allowed_effects: [] },
  };
  // Bind *all* observed revisions in the prefix, including tombstones. Labels and
  // later observations never enter this hash or the exported inference context.
  return { ...state, prefix_hash: digest({ context: state, observed_prefix: prefix }) };
}

export function validateDiscoveryCorpus(corpus) {
  check(validCorpus(corpus), 'INVALID_CORPUS_SCHEMA');
  const episodeIds = new Set(), checkpointIds = new Set(), eventIds = new Set();
  for (const episode of corpus.episodes) {
    check(!episodeIds.has(episode.id), 'DUPLICATE_EPISODE'); episodeIds.add(episode.id);
    const latest = new Map(), indices = new Map();
    let previousObserved = -Infinity;
    for (const [index, event] of episode.events.entries()) {
      check(!eventIds.has(event.source_event_id), 'DUPLICATE_EVENT'); eventIds.add(event.source_event_id);
      indices.set(event.source_event_id, index);
      const created = time(event.created_at), updated = time(event.updated_at), observed = time(event.observed_at);
      check(created <= updated && updated <= observed && observed >= previousObserved, 'REVERSED_OBSERVATION_TIME');
      previousObserved = observed;
      check(event.operation === 'upsert' ? typeof event.text === 'string' && event.text.trim() : event.text === null, 'INVALID_EVENT_TEXT');
      const old = latest.get(event.message_id);
      if (old) {
        check(event.version > old.version && event.author_id === old.author_id && event.created_at === old.created_at
          && event.updated_at >= old.updated_at, 'INVALID_REVISION');
        check(old.operation !== 'delete', 'RESURRECTED_DELETE');
      }
      latest.set(event.message_id, event);
    }
    let previousCut = -1;
    for (const checkpoint of episode.checkpoints) {
      check(!checkpointIds.has(checkpoint.id), 'DUPLICATE_CHECKPOINT'); checkpointIds.add(checkpoint.id);
      const cut = indices.get(checkpoint.after_event_id);
      check(cut !== undefined && cut > previousCut, 'INVALID_CHECKPOINT_CUT'); previousCut = cut;
      check(episode.events.slice(0, cut + 1).some(e => e.message_id === checkpoint.anchor_message_id), 'MISSING_ANCHOR');
      const context = prefixContext(corpus, episode, checkpoint);
      const available = new Map(context.observations.map(event => [event.source_event_id, event]));
      check(checkpoint.judgment.label === 'positive' ? checkpoint.judgment.sufficient_evidence.length > 0
        && checkpoint.judgment.acceptable_decisions.includes('REVIEW') : checkpoint.judgment.sufficient_evidence.length === 0,
      'INVALID_GOLD_SUPPORT');
      if (checkpoint.judgment.label === 'positive') check(!context.coverage.incomplete, 'POSITIVE_WITH_INCOMPLETE_CONTEXT');
      for (const option of checkpoint.judgment.sufficient_evidence) for (const reference of option) {
        const event = available.get(reference.source_event_id);
        check(event && event.text.includes(reference.span), 'GOLD_EVIDENCE_UNAVAILABLE_AT_CUT');
        check(event.author_id === episode.subject_id && POSITIVE.has(reference.kind)
          && reference.attribution === 'author_statement', 'GOLD_NOT_SUBJECT_NEED');
      }
    }
    for (const validation of episode.later_validation) {
      const checkpoint = episode.checkpoints.find(c => c.id === validation.checkpoint_id);
      check(checkpoint && indices.has(validation.after_event_id)
        && indices.get(validation.after_event_id) > indices.get(checkpoint.after_event_id), 'INVALID_LATER_VALIDATION');
      check(validation.interpretation !== 'missed_existing_evidence' || checkpoint.judgment.label === 'positive', 'HINDSIGHT_RELABEL');
    }
  }
  return corpus;
}

export function discoveryEvaluationContexts(corpus) {
  validateDiscoveryCorpus(corpus);
  return corpus.episodes.flatMap(episode => episode.checkpoints.map(checkpoint => prefixContext(corpus, episode, checkpoint)));
}

function predictionViolations(prediction, context) {
  const violations = [];
  if (!validPrediction(prediction)) return ['INVALID_PREDICTION_CONTRACT'];
  if (prediction.prefix_hash !== context.prefix_hash) violations.push('PREFIX_MISMATCH');
  if (prediction.offer_version !== context.offer.version) violations.push('OFFER_VERSION_MISMATCH');
  const byId = new Map(context.observations.map(event => [event.source_event_id, event]));
  const seen = new Set();
  let ownNeed = false;
  for (const reference of prediction.evidence) {
    const event = byId.get(reference.source_event_id);
    if (!event || !reference.span.trim() || !event.text.includes(reference.span)) violations.push('EVIDENCE_NOT_CURRENT_EXACT_SPAN');
    const key = JSON.stringify([reference.source_event_id, reference.span]);
    if (seen.has(key)) violations.push('DUPLICATE_EVIDENCE'); seen.add(key);
    if (event?.author_id === context.subject_id && POSITIVE.has(reference.kind) && reference.attribution === 'author_statement') ownNeed = true;
  }
  if (prediction.decision === 'REVIEW') {
    if (!ownNeed) violations.push('REVIEW_WITHOUT_SUBJECT_NEED');
    if (prediction.assessment !== 'opportunity') violations.push('REVIEW_WITHOUT_OPPORTUNITY');
    if (context.coverage.incomplete) violations.push('REVIEW_WITH_INCOMPLETE_CONTEXT');
  }
  return [...new Set(violations)];
}

export function evaluateDiscoveryPredictions(corpus, predictionSet = null) {
  const contexts = discoveryEvaluationContexts(corpus);
  const labels = emptyCounts();
  const checkpoints = corpus.episodes.flatMap(episode => episode.checkpoints);
  for (const checkpoint of checkpoints) labels[checkpoint.judgment.label]++;
  const base = {
    contract_version: 'discovery-evaluation-report-v1', corpus_provenance: corpus.provenance,
    live_proof: false, model_quality_measured: false, episodes: corpus.episodes.length, checkpoints: checkpoints.length,
    labels, precision: null, recall: null, conservative_precision: null, grounded_recall: null,
  };
  if (predictionSet === null) return { ...base, mode: 'corpus_validation', evaluated_predictions: 0,
    note: 'Structural and temporal validation only. No prediction quality or live/model capability measured.' };
  check(validPredictionSet(predictionSet), 'INVALID_PREDICTION_SET');
  const expected = new Set(contexts.map(context => context.checkpoint_id)), supplied = new Map();
  for (const prediction of predictionSet.predictions) {
    check(expected.has(prediction.checkpoint_id), 'UNKNOWN_PREDICTION_CHECKPOINT');
    check(!supplied.has(prediction.checkpoint_id), 'DUPLICATE_PREDICTION');
    supplied.set(prediction.checkpoint_id, prediction);
  }
  const byContext = new Map(contexts.map(context => [context.checkpoint_id, context]));
  const confusion = { true_positive: 0, false_positive: 0, false_negative: 0, true_negative: 0 };
  const missing = emptyCounts(), invalid = emptyCounts(), abstentions = emptyCounts();
  let reviews = 0, validCount = 0, unadjudicatedReviews = 0, grounded = 0, acceptable = 0;
  const cases = checkpoints.map(checkpoint => {
    const label = checkpoint.judgment.label, prediction = supplied.get(checkpoint.id);
    if (!prediction) { missing[label]++; return { checkpoint_id: checkpoint.id, label, status: 'missing' }; }
    const review = prediction.decision === 'REVIEW';
    if (review) reviews++;
    if (review && ['uncertain', 'insufficient_evidence'].includes(label)) unadjudicatedReviews++;
    const violations = predictionViolations(prediction, byContext.get(checkpoint.id));
    if (violations.length) { invalid[label]++; return { checkpoint_id: checkpoint.id, label, status: 'invalid', violations }; }
    validCount++;
    if (prediction.decision === 'WAIT') abstentions[label]++;
    if (label === 'positive') confusion[review ? 'true_positive' : 'false_negative']++;
    if (label === 'negative') confusion[review ? 'false_positive' : 'true_negative']++;
    const supportCovered = label === 'positive' && checkpoint.judgment.sufficient_evidence.some(option => option.every(gold =>
      prediction.evidence.some(ref => ref.source_event_id === gold.source_event_id && ref.kind === gold.kind
        && ref.attribution === gold.attribution && ref.span.includes(gold.span))));
    if (review && supportCovered) grounded++;
    const matches = checkpoint.judgment.acceptable_decisions.includes(prediction.decision)
      && checkpoint.judgment.acceptable_assessments.includes(prediction.assessment);
    if (matches) acceptable++;
    return { checkpoint_id: checkpoint.id, label, status: 'valid', decision: prediction.decision,
      assessment: prediction.assessment, acceptable: matches, sufficient_support_covered: supportCovered };
  });
  const byResult = new Map(cases.map(result => [result.checkpoint_id, result]));
  const detection = [];
  for (const episode of corpus.episodes) {
    // Separate windows: a later opportunity cannot repair a miss before a refusal.
    for (let i = 0; i < episode.checkpoints.length; i++) {
      if (episode.checkpoints[i].judgment.label !== 'positive') continue;
      const start = i, first = episode.checkpoints[i];
      while (i + 1 < episode.checkpoints.length && episode.checkpoints[i + 1].judgment.label === 'positive') i++;
      const found = episode.checkpoints.slice(start, i + 1).find(checkpoint => {
        const result = byResult.get(checkpoint.id);
        return result.status === 'valid' && result.decision === 'REVIEW' && result.sufficient_support_covered;
      });
      const offset = event => episode.events.findIndex(item => item.source_event_id === event);
      detection.push({ episode_id: episode.id, first_eligible_checkpoint: first.id,
        detected_checkpoint: found?.id ?? null,
        delay_observations: found ? offset(found.after_event_id) - offset(first.after_event_id) : null,
        window_closed: i + 1 < episode.checkpoints.length,
        missed_in_window: !found,
      });
    }
  }
  return { ...base, mode: 'supplied_prediction_scoring', declared_prediction_provenance: structuredClone(predictionSet.provenance),
    provenance_verified: false, model_quality_measured: predictionSet.provenance.kind === 'model' && supplied.size > 0,
    evaluated_predictions: supplied.size, boundary_valid_predictions: validCount,
    prediction_coverage: ratio(supplied.size, checkpoints.length), valid_coverage: ratio(validCount, checkpoints.length),
    missing_by_label: missing, invalid_by_label: invalid, wait_by_label: abstentions, confusion,
    precision: ratio(confusion.true_positive, confusion.true_positive + confusion.false_positive),
    recall: ratio(confusion.true_positive, labels.positive),
    conservative_precision: ratio(confusion.true_positive, reviews),
    grounded_recall: ratio(grounded, labels.positive),
    positive_misses_total: labels.positive - confusion.true_positive,
    positive_proposals: reviews, unadjudicated_positive_proposals: unadjudicatedReviews,
    acceptable_decision_assessment_rate: ratio(acceptable, checkpoints.length),
    detection_windows: detection, cases,
    note: 'Synthetic corpus; supplied provenance is unverified. Confusion excludes invalid/missing predictions; recall retains every positive checkpoint in its denominator. Exact-span validation cannot prove semantic attribution. No causal attribution or live proof.',
  };
}
