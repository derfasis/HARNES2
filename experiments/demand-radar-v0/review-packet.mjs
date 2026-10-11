import { digest } from '../../business/source-ingestion.mjs';
import { assertVerifiedDemandProbe } from './probe.mjs';

const check = (ok, code) => { if (!ok) throw new TypeError(code); };
const oldest = (a, b) => Date.parse(a.published_at) - Date.parse(b.published_at)
  || a.message_id.localeCompare(b.message_id, 'en', { numeric: true });

// No model tools, runtime activation or DB writes. This is an inspectable input
// packet for later human/model review, not a ready-to-contact list.
export function buildDemandReviewPacket(input) {
  check(input && Object.keys(input).every(k => ['probe', 'max_anchors', 'max_characters', 'exploration_slots', 'cursor'].includes(k)),
    'INPUT_FIELDS_INVALID');
  const { probe, max_anchors = 8, max_characters = 24000,
    exploration_slots = Math.min(2, max_anchors), cursor = null } = input;
  check(Number.isInteger(max_anchors) && max_anchors >= 1 && max_anchors <= 24
    && Number.isInteger(max_characters) && max_characters >= 1 && max_characters <= 96000
    && Number.isInteger(exploration_slots) && exploration_slots >= 0 && exploration_slots <= max_anchors,
  'PACKET_LIMIT_INVALID');
  assertVerifiedDemandProbe(probe);
  const binding = digest([probe.probe_fingerprint, max_anchors, max_characters, exploration_slots]);
  const skipped = [];
  const eligible = rows => [...rows].sort(oldest).filter(row => {
    const reason = row.duplicate_of ? 'exact_duplicate_anchor' : row.context_incomplete ? row.ancestry_reason
      : row.text.length > max_characters ? 'anchor_character_limit' : null;
    if (reason) skipped.push({ message_id: row.message_id, reason });
    return reason === null;
  });
  const queues = { matched: eligible(probe.candidates), exploration: eligible(probe.unselected).reverse() };
  check(cursor == null || cursor && Object.keys(cursor).every(k => ['binding', 'matched', 'exploration'].includes(k))
    && cursor.binding === binding && ['matched', 'exploration'].every(route =>
      Number.isInteger(cursor[route]) && cursor[route] >= 0 && cursor[route] <= queues[route].length), 'CURSOR_INVALID');
  const offsets = { matched: cursor?.matched ?? 0, exploration: cursor?.exploration ?? 0 };
  const selected = [];
  let characters = 0;
  const pick = (route, slots) => {
    while (slots > 0 && offsets[route] < queues[route].length) {
      const anchor = queues[route][offsets[route]];
      if (characters + anchor.text.length > max_characters) break;
      selected.push({ anchor, route }); characters += anchor.text.length;
      offsets[route]++; slots--;
    }
  };
  // Reserve both anchor slots and their text before spending on matched context.
  pick('exploration', Math.min(exploration_slots, queues.exploration.length - offsets.exploration));
  pick('matched', max_anchors - selected.length);
  pick('exploration', max_anchors - selected.length);
  selected.sort((a, b) => (a.route === b.route ? oldest(a.anchor, b.anchor) : a.route === 'matched' ? -1 : 1));

  const readable = [...probe.candidates, ...probe.unselected];
  const byId = new Map(readable.map(m => [m.message_id, m]));
  const opaque = new Map(probe.omitted.map(m => [m.message_id, m]));
  const groups = selected.map(({ anchor, route }) => {
    const context = [], seen = new Set([anchor.message_id]);
    const add = row => { if (!seen.has(row.message_id)) { seen.add(row.message_id); context.push(row); } };
    let ancestor = anchor;
    while (ancestor.reply_to && byId.has(ancestor.reply_to)) {
      ancestor = byId.get(ancestor.reply_to); if (seen.has(ancestor.message_id)) break; add(ancestor);
    }
    for (const row of readable.filter(m => m.reply_to === anchor.message_id).sort(oldest)) add(row);
    if (anchor.author_ref !== null) for (const row of readable.filter(m => m.author_ref === anchor.author_ref)
      .sort((a, b) => -oldest(a, b))) add(row);
    const missing = new Set(probe.omitted.filter(m => m.reply_to === anchor.message_id
      || anchor.author_ref !== null && m.author_ref === anchor.author_ref).map(m => m.message_id));
    // Same-author context can belong to another thread. Preserve that thread's
    // ancestry too, or explicitly disclose it when the packet budget omits it.
    for (const row of context) {
      let parentId = row.reply_to;
      const chain = new Set([row.message_id]);
      while (parentId && !chain.has(parentId)) {
        chain.add(parentId);
        const parent = byId.get(parentId);
        if (!parent) { missing.add(parentId); break; }
        add(parent); parentId = parent.reply_to;
      }
    }
    const messages = [structuredClone(anchor)];
    let incomplete = false;
    for (const row of context) {
      if (messages.length >= 32 || characters + row.text.length > max_characters) {
        missing.add(row.message_id); continue;
      }
      messages.push(structuredClone(row)); characters += row.text.length;
      incomplete ||= row.context_incomplete;
      // Disclose unresolved parent references of context, not only the anchor.
      if (row.reply_to && !byId.has(row.reply_to)) missing.add(row.reply_to);
      if (row.reply_to && opaque.has(row.reply_to)) missing.add(row.reply_to);
    }
    return { anchor_message_id: anchor.message_id, route, messages,
      context_incomplete: incomplete || missing.size > 0,
      omitted_context_message_ids: [...missing] };
  });
  const remaining = ['matched', 'exploration'].reduce((n, route) => n + queues[route].length - offsets[route], 0);
  const result = { kind: 'historical_demand_review_packet_v1', binding, sample: structuredClone(probe.sample),
    mission_id: probe.mission_id, mission_revision: probe.mission_revision,
    groups, characters, skipped, remaining_anchors: remaining, deferred_count: remaining,
    next_cursor: remaining ? { binding, ...offsets } : null,
    limits: { max_anchors, max_characters, exploration_slots, context_rows_per_group: 32 },
    verdict: structuredClone(probe.verdict),
    uncertainty: ['Exploration is deterministic, not a random or representative market sample.',
      'Matching messages, author identifiers and anchors are not proven distinct people or opportunities.',
      'Historical content integrity does not prove current intent, completeness or processing/contact authority.'] };
  result.packet_fingerprint = digest(result);
  return result;
}
