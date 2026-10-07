// Product-specific proposal bindings. This is not an agent runtime or authority provider.
import { hash } from './store.mjs';
import { ensure } from './errors.mjs';

const check = (ok, code) => ensure(ok, code, 400, code);
export const proposalRefs = n => [...new Set([...n.evidence_event_ids, ...n.counterevidence_event_ids, ...(n.context_event_ids ?? [])])];
export const previewHash = n => n.material_preview ? hash(Buffer.from(n.material_preview.content, 'utf8')) : null;

export function proposalBindings(output, packet) {
  const selected = packet.exchanges.filter(e => output.exchange_ids.includes(e.id));
  check(selected.length === output.exchange_ids.length, 'AUDIENCE_EVIDENCE_SCOPE');
  const references = proposalRefs(output), evidence = selected.flatMap(e => e.evidence);
  const support = new Set(evidence.map(e => e.source_event_id));
  check(references.every(ref => support.has(ref)) && selected.every(e => e.evidence.some(s => references.includes(s.source_event_id))), 'AUDIENCE_EVIDENCE_SCOPE');
  const texts = new Map(evidence.map(e => [e.source_event_id, e.text]));
  check(output.support_quotes.every(q => references.includes(q.source_event_id) && texts.get(q.source_event_id)?.includes(q.quote))
    && references.every(ref => output.support_quotes.some(q => q.source_event_id === ref)), 'AUDIENCE_QUOTE_MISMATCH');
  check(!output.evidence_event_ids.some(ref => output.counterevidence_event_ids.includes(ref)), 'AUDIENCE_EVIDENCE_CONTRADICTION');
  if (output.proposal_version !== 2) return { selected, references };

  const context = output.context_event_ids, reviews = output.context_review;
  check(references.length <= 32 && !context.some(ref => output.evidence_event_ids.includes(ref) || output.counterevidence_event_ids.includes(ref)), 'AUDIENCE_CONTEXT_INVALID');
  check(reviews.length === packet.exchanges.length && new Set(reviews.map(r => r.exchange_id)).size === reviews.length, 'AUDIENCE_CONTEXT_INCOMPLETE');
  for (const review of reviews) {
    const exchange = packet.exchanges.find(e => e.id === review.exchange_id);
    check(exchange && review.evidence_event_ids.every(ref => exchange.evidence.some(e => e.source_event_id === ref)), 'AUDIENCE_CONTEXT_SCOPE');
    const bound = exchange.evidence.map(e => e.source_event_id).filter(ref => references.includes(ref));
    if (review.classification === 'unrelated') {
      check(bound.length === 0 && !output.exchange_ids.includes(exchange.id), 'AUDIENCE_CONTEXT_CONTRADICTION');
      continue;
    }
    check(bound.length > 0 && bound.every(ref => review.evidence_event_ids.includes(ref))
      && review.evidence_event_ids.every(ref => bound.includes(ref)), 'AUDIENCE_CONTEXT_INCOMPLETE');
    if (review.classification === 'supporting') check(bound.some(ref => output.evidence_event_ids.includes(ref))
      && !bound.some(ref => output.counterevidence_event_ids.includes(ref)), 'AUDIENCE_CONTEXT_CONTRADICTION');
    if (review.classification === 'counterevidence') check(bound.some(ref => output.counterevidence_event_ids.includes(ref)), 'AUDIENCE_CONTEXT_CONTRADICTION');
    if (['related','uncertain'].includes(review.classification)) check(bound.some(ref => context.includes(ref)), 'AUDIENCE_CONTEXT_CONTRADICTION');
    if (review.classification === 'related') check(bound.every(ref => context.includes(ref)), 'AUDIENCE_CONTEXT_CONTRADICTION');
  }
  const preview = output.material_preview;
  if (preview) {
    check(output.next_step === 'prepare_material' && Buffer.byteLength(preview.content, 'utf8') <= 32000
      && preview.evidence_event_ids.every(ref => references.includes(ref)), 'AUDIENCE_PREVIEW_SCOPE');
  }
  const contact = output.first_contact;
  if (contact) {
    const target = evidence.find(e => e.source_event_id === contact.target_event_id);
    check(target && output.evidence_event_ids.includes(contact.target_event_id)
      && typeof target.text === 'string' && target.text.includes(contact.target_quote)
      && output.support_quotes.some(q => q.source_event_id === contact.target_event_id && q.quote.includes(contact.target_quote)),
    'FIRST_CONTACT_TARGET_INVALID');
    if (contact.channel === 'public_reply') check(output.next_step === 'prepare_material' && preview
      && preview.evidence_event_ids.includes(contact.target_event_id)
      && typeof target.author_id === 'string' && target.author_id.trim().length > 0, 'FIRST_CONTACT_RESPONSE_INVALID');
  }
  return { selected, references };
}

export function frozenProposalBasis(packet, selected) {
  const sources = [...new Set(selected.map(e => e.source_ref))];
  return { ...packet.scope, exchanges: packet.scope.exchanges.filter(e => selected.some(s => s.id === e.id)),
    policies: packet.scope.policies.filter(([source]) => sources.includes(source)) };
}
