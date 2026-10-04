// An interpretation of one frozen sample, never an authority or source-fact provider.
import { ensure } from './errors.mjs';
import { digest } from './source-ingestion.mjs';

const check = (value, code) => ensure(value, code, 400, code);

export function decisionBindings(output, packet) {
  const review = output.decision_review;
  check(review?.disposition === (output.needs.length ? 'needs_proposed' : 'no_need_proposed'), 'AUDIENCE_DECISION_CONTRADICTION');
  const rows = review.exchange_reviews;
  check(rows.length === packet.exchanges.length && new Set(rows.map(r => r.exchange_id)).size === rows.length,
    'AUDIENCE_DECISION_INCOMPLETE');
  for (const row of rows) {
    const exchange = packet.exchanges.find(e => e.id === row.exchange_id);
    check(exchange && row.evidence_event_ids.every(ref => exchange.evidence.some(e => e.source_event_id === ref)), 'AUDIENCE_DECISION_SCOPE');
    const texts = new Map(exchange.evidence.map(e => [e.source_event_id,e.text]));
    check(row.support_quotes.every(q => row.evidence_event_ids.includes(q.source_event_id) && texts.get(q.source_event_id)?.includes(q.quote))
      && row.evidence_event_ids.every(ref => row.support_quotes.some(q => q.source_event_id === ref)), 'AUDIENCE_DECISION_QUOTE_MISMATCH');
  }
  return review;
}

export function audienceModelPacket(packet) {
  const {withheld_exchanges:coveredWithheld,...coverage} = packet.coverage ?? {};
  const withheld = packet.withheld_exchanges ?? coveredWithheld ?? [];
  const reasonCounts = Object.create(null);
  for (const e of withheld) for (const reason of new Set(e.reasons ?? []))
    reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  // Durable IDs, every selected source text, relationship and all source clocks survive.
  // Excluded scopes are represented as omissions, never reintroduced as prompt evidence.
  return structuredClone({ projection_version:1,id:packet.id,revision:packet.revision,title:packet.title,objective:packet.objective,
    assessment_id:packet.assessment_id,proposal_contract_version:packet.proposal_contract_version,
    basis_fingerprint:packet.basis_fingerprint,
    exchanges:packet.exchanges.map(e => ({id:e.id,source_ref:e.source_ref,anchor_id:e.anchor_id,
      fingerprint:e.fingerprint,evidence:e.evidence,unsupported_count:e.unsupported_count})),
    needs:packet.needs,
    coverage:{...coverage,withheld_sample_exchanges:withheld.length,withheld_reason_counts:reasonCounts},
    ...(packet.reassessment ? {reassessment:packet.reassessment} : {}),
    ...(packet.reasoning_retry ? {reasoning_retry:packet.reasoning_retry} : {}),
    executable:false,contact_permission:false,allowed_effects:[] });
}

export function assessmentDecision({ row, packet, output, run, current, validateOutput, validateAuthority }) {
  const envelope = {scope:'supplied_packet_only',epistemic_status:'unverified_model_interpretation',resolution:'unknown',
    state:'not_recorded',review:null};
  if (!output?.decision_review) {
    if (row.producer === 'model' && row.status === 'invalid') return {...envelope,state:'invalid'};
    let requiresReview = false;
    try {
      const frozen = run && JSON.parse(run.context_json), receipt = run?.result_json && JSON.parse(run.result_json);
      requiresReview = frozen?.decision_contract_version === 1 || frozen?.model_projection_version === 1
        || receipt?.decision_contract_version === 1 || receipt?.model_projection_version === 1
        || receipt?.model_input_fingerprint !== undefined || receipt?.output_fingerprint !== undefined;
    } catch { return {...envelope,state:'invalid'}; }
    if (!requiresReview) return envelope;
    return {...envelope,state:!current ? 'stale' : row.status === 'invalid' || run.status === 'completed' ? 'invalid' : 'not_recorded'};
  }
  try {
    check(row.producer === 'model' && ['proposed','stale'].includes(row.status) && run?.status === 'completed', 'AUDIENCE_DECISION_RECEIPT_INVALID');
    const frozen = JSON.parse(run.context_json), receipt = JSON.parse(run.result_json);
    check(frozen.decision_contract_version === 1 && frozen.model_projection_version === 1
      && receipt.decision_contract_version === 1 && receipt.model_projection_version === 1
      && typeof frozen.model_input_fingerprint === 'string' && /^[a-f0-9]{64}$/.test(frozen.model_input_fingerprint)
      && receipt.model_input_fingerprint === frozen.model_input_fingerprint
      && frozen.assessment_id === row.id && frozen.goal_id === row.goal_id
      && row.run_id === run.id && receipt.run_id === run.id && receipt.assessment_id === row.id && receipt.goal_id === row.goal_id
      && digest(frozen.packet) === digest(packet) && receipt.output_fingerprint === digest(output)
      && validateOutput(output), 'AUDIENCE_DECISION_RECEIPT_INVALID');
    check(receipt.disposition === (output.needs.length ? 'proposal_created' : packet.reassessment ? 'no_revision_proposed' : 'no_need_proposed'),
      'AUDIENCE_DECISION_RECEIPT_INVALID');
    decisionBindings(output,packet);
    if (validateAuthority) validateAuthority(frozen);
    return {...envelope,state:current ? 'current' : 'stale',review:output.decision_review};
  } catch {
    return {...envelope,state:'invalid',reason:'AUDIENCE_DECISION_RECEIPT_INVALID'};
  }
}
