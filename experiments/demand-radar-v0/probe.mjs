// Offline retrieval-route probe over an already permitted, frozen Scout-style sample.
// Matching literal phrases makes DISCOVERY CANDIDATES, never assessed author intent.
function assert(ok, code) {
  if (!ok) throw new TypeError(code);
}
const usable = v => typeof v === 'string' && v.trim().length > 0;
const norm = text => text.normalize('NFC').toLocaleLowerCase('und');

export function probeDemandCandidates({ mission, sample }) {
  assert(mission && typeof mission === 'object' && usable(mission.id)
    && Number.isInteger(mission.revision) && mission.revision > 0,
  'MISSION_INVALID');
  assert(Array.isArray(mission.families) && mission.families.length > 0 && mission.families.length <= 12,
    'FAMILIES_INVALID');
  const ids = new Set();
  const families = mission.families.map(family => {
    assert(family && usable(family.id) && !ids.has(family.id)
      && Array.isArray(family.contains_any) && family.contains_any.length > 0
      && family.contains_any.length <= 24 && family.contains_any.every(term => usable(term) && term.length <= 120),
    'FAMILY_INVALID');
    ids.add(family.id);
    return { id: family.id, terms: [...new Set(family.contains_any.map(norm))] };
  });
  assert(sample && sample.status === 'sealed' && usable(sample.source_ref)
    && usable(sample.digest) && usable(sample.coverage)
    && Array.isArray(sample.messages) && sample.messages.length <= 1500,
  'SEALED_SAMPLE_REQUIRED');

  const byId = new Map();
  for (const m of sample.messages) {
    assert(m && usable(String(m.message_id ?? '')) && !byId.has(String(m.message_id))
      && usable(m.date) && Number.isFinite(Date.parse(m.date)), 'MESSAGE_INVALID');
    byId.set(String(m.message_id), m);
  }
  const candidates = [], unselected = [], omitted = [];
  const duplicateSeen = new Map();
  let eligible = 0, exactRepeats = 0;
  for (const m of sample.messages) {
    const messageId = String(m.message_id);
    if (m.unsupported || !usable(m.text)) {
      omitted.push({ message_id: messageId, reason: m.unsupported ? 'unsupported' : 'no_readable_text' });
      continue;
    }
    eligible++;
    const sourceText = m.text; // Entire original text, including negations and line breaks.
    const folded = norm(sourceText);
    const matches = families.map(family => ({ family_id: family.id,
      matched_terms: family.terms.filter(term => folded.includes(term)) }))
      .filter(hit => hit.matched_terms.length);
    const author = usable(m.author_ref) ? m.author_ref : null;
    const replyTo = m.reply_to == null ? null : String(m.reply_to);
    const duplicateKey = author === null ? null : JSON.stringify([author, replyTo, sourceText]);
    const duplicateOf = duplicateKey === null ? null : duplicateSeen.get(duplicateKey) ?? null;
    if (duplicateKey !== null && duplicateOf === null) duplicateSeen.set(duplicateKey, messageId);
    if (duplicateOf !== null) exactRepeats++;
    const sameAuthorOthers = author === null ? [] : sample.messages
      .filter(other => other !== m && other.author_ref === author)
      .map(other => String(other.message_id));
    const row = {
      source_ref: sample.source_ref, message_id: messageId, author_ref: author,
      published_at: m.date, observed_at: null, reply_to: replyTo, text: sourceText,
      duplicate_of: duplicateOf,
      context_incomplete: replyTo !== null && !byId.has(replyTo),
      same_author_other_message_ids: sameAuthorOthers,
    };
    if (matches.length) candidates.push({ ...row, acquisition_matches: matches });
    else unselected.push(row);
  }
  return {
    kind: 'historical_retrieval_probe_v0', mission_id: mission.id,
    mission_revision: mission.revision,
    sample: { source_ref: sample.source_ref, declared_digest: sample.digest,
      declared_coverage: sample.coverage, digest_checked: false,
      continuous_coverage_proven: false },
    counts: { raw_messages: sample.messages.length, eligible_messages: eligible,
      candidates: candidates.length, unselected: unselected.length,
      omitted: omitted.length, exact_same_author_repeats: exactRepeats,
      distinct_source_scoped_author_refs: new Set(sample.messages
        .filter(m => usable(m.author_ref)).map(m => m.author_ref)).size },
    candidates, unselected, omitted,
    verdict: { semantic_intent: 'NOT_ASSESSED', offer_fit: 'UNKNOWN',
      current_intent: 'UNKNOWN', contact_permission: false,
      can_promote_to_discovery: false, model_calls: 0, network_calls: 0 },
  };
}
