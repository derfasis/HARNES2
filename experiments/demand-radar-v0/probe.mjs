import { createHash } from 'node:crypto';
import { digest } from '../../business/source-ingestion.mjs';

// Retrieval over frozen history, never a semantic verdict or an authority grant.
const verified = new WeakMap();
const usable = v => typeof v === 'string' && v.trim().length > 0;
const bounded = (v, n) => usable(v) && v.length <= n;
const optionalRef = v => v == null || bounded(v, 150);
const norm = text => text.normalize('NFC').toLocaleLowerCase('und');
const iso = v => bounded(v, 40) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 19) === v.slice(0, 19);
const hashText = value => createHash('sha256').update(value).digest('hex');
function check(ok, code) { if (!ok) throw new TypeError(code); }

function ancestry(message, byId) {
  const seen = new Set();
  let current = message;
  while (current) {
    if (seen.has(current.message_id)) return 'cyclic_reply_ancestry';
    seen.add(current.message_id);
    if (current.unsupported || !usable(current.text)) return 'opaque_reply_ancestry';
    if (current.reply_to == null) return null;
    current = byId.get(current.reply_to);
    if (!current) return 'missing_reply_ancestry';
  }
  return null;
}

export function probeDemandCandidates({ mission, sample }) {
  check(mission && !Array.isArray(mission) && bounded(mission.id, 120)
    && Number.isSafeInteger(mission.revision) && mission.revision > 0, 'MISSION_INVALID');
  check(Array.isArray(mission.families) && mission.families.length > 0 && mission.families.length <= 12,
    'FAMILIES_INVALID');
  const ids = new Set();
  const families = mission.families.map(family => {
    check(family && bounded(family.id, 120) && !ids.has(family.id)
      && Array.isArray(family.contains_any) && family.contains_any.length > 0
      && family.contains_any.length <= 24 && family.contains_any.every(term => bounded(term, 120)),
    'FAMILY_INVALID');
    ids.add(family.id);
    return { id: family.id, terms: [...new Set(family.contains_any.map(norm))] };
  });
  check(sample && sample.status === 'sealed' && bounded(sample.source_ref, 300)
    && bounded(sample.digest, 150) && bounded(sample.coverage, 100)
    && Array.isArray(sample.messages) && sample.messages.length <= 1500, 'SEALED_SAMPLE_REQUIRED');

  const byId = new Map(), byAuthor = new Map();
  let characters = 0;
  for (const m of sample.messages) {
    check(m && bounded(m.message_id, 150) && !byId.has(m.message_id) && iso(m.date)
      && optionalRef(m.author_ref) && optionalRef(m.reply_to)
      && (m.unsupported == null || typeof m.unsupported === 'boolean')
      && (m.text == null || typeof m.text === 'string' && m.text.length <= 16000)
      && (m.link == null || bounded(m.link, 2048))
      && (m.content_hash == null || typeof m.content_hash === 'string'
        && /^[a-f0-9]{64}$/.test(m.content_hash) && m.content_hash === hashText(m.text ?? '')),
    'MESSAGE_INVALID');
    characters += m.text?.length ?? 0;
    check(characters <= 2_000_000, 'INPUT_TEXT_LIMIT');
    byId.set(m.message_id, m);
    if (m.author_ref != null) {
      if (!byAuthor.has(m.author_ref)) byAuthor.set(m.author_ref, []);
      byAuthor.get(m.author_ref).push(m);
    }
  }
  // Prefer recent same-author context, but never treat co-occurrence as cancellation.
  for (const rows of byAuthor.values()) rows.sort((a, b) => Date.parse(b.date) - Date.parse(a.date)
    || a.message_id.localeCompare(b.message_id));
  const candidates = [], unselected = [], omitted = [];
  const duplicateSeen = new Map();
  for (const m of [...sample.messages].sort((a, b) => Date.parse(a.date) - Date.parse(b.date)
    || a.message_id.localeCompare(b.message_id, 'en', { numeric: true }))) {
    if (m.author_ref == null || m.unsupported || !usable(m.text)) continue;
    const key = JSON.stringify([m.author_ref, m.reply_to ?? null, m.text]);
    if (!duplicateSeen.has(key)) duplicateSeen.set(key, m.message_id);
  }
  let eligible = 0, exactRepeats = 0;
  for (const m of sample.messages) {
    const author = m.author_ref ?? null, replyTo = m.reply_to ?? null;
    if (m.unsupported || !usable(m.text)) {
      omitted.push({ message_id: m.message_id, author_ref: author, published_at: m.date,
        reply_to: replyTo, reason: m.unsupported ? 'unsupported' : 'no_readable_text' });
      continue;
    }
    eligible++;
    const folded = norm(m.text);
    const matches = families.map(family => ({ family_id: family.id,
      matched_terms: family.terms.filter(term => folded.includes(term)) })).filter(hit => hit.matched_terms.length);
    const duplicateKey = author === null ? null : JSON.stringify([author, replyTo, m.text]);
    const firstId = duplicateKey === null ? null : duplicateSeen.get(duplicateKey);
    const duplicateOf = firstId === m.message_id ? null : firstId ?? null;
    if (duplicateOf !== null) exactRepeats++;
    const sameAuthorOthers = author === null ? [] : byAuthor.get(author).filter(other => other !== m);
    const ancestryReason = ancestry(m, byId);
    const row = {
      source_ref: sample.source_ref, message_id: m.message_id, author_ref: author,
      published_at: m.date, observed_at: null, reply_to: replyTo, text: m.text,
      link: m.link ?? null, content_hash: m.content_hash ?? hashText(m.text), text_hash: hashText(m.text),
      content_hash_kind: 'text_sha256',
      duplicate_of: duplicateOf, context_incomplete: ancestryReason !== null, ancestry_reason: ancestryReason,
      same_author_other_message_ids: sameAuthorOthers.slice(0, 32).map(other => other.message_id),
      same_author_context_total: sameAuthorOthers.length, same_author_context_truncated: sameAuthorOthers.length > 32,
    };
    if (matches.length) candidates.push({ ...row, acquisition_matches: matches });
    else unselected.push(row);
  }
  return {
    kind: 'historical_retrieval_probe_v1', mission_id: mission.id, mission_revision: mission.revision,
    mission_fingerprint: digest({ id: mission.id, revision: mission.revision, families }),
    sample: { source_ref: sample.source_ref, declared_digest: sample.digest,
      declared_coverage: sample.coverage, digest_checked: false, currentness: 'NOT_CHECKED',
      continuous_coverage_proven: false },
    counts: { raw_messages: sample.messages.length, eligible_messages: eligible,
      candidates: candidates.length, unselected: unselected.length, omitted: omitted.length,
      exact_same_author_repeats: exactRepeats, distinct_source_scoped_author_refs: byAuthor.size },
    candidates, unselected, omitted,
    verdict: { semantic_intent: 'NOT_ASSESSED', offer_fit: 'UNKNOWN', current_intent: 'UNKNOWN',
      contact_permission: false, can_promote_to_discovery: false, model_calls: 0, network_calls: 0 },
  };
}

// Thin adapter for the existing Scout sealed-row commitment; no Telegram parser.
export function probeScoutDemandCandidates({ mission, sample }) {
  check(sample && sample.status === 'sealed' && bounded(sample.id, 150) && bounded(sample.candidate_id, 150)
    && typeof sample.account_id === 'string' && /^[1-9][0-9]{0,18}$/.test(sample.account_id)
    && iso(sample.requested_from) && iso(sample.requested_until)
    && Date.parse(sample.requested_from) < Date.parse(sample.requested_until)
    && Number.isSafeInteger(sample.source_cursor) && sample.source_cursor >= 0
    && typeof sample.messages_json === 'string' && sample.messages_json.length <= 8_000_000
    && typeof sample.digest === 'string' && /^[a-f0-9]{64}$/.test(sample.digest)
    && ['message_limit', 'requested_window_sampled', 'visible_history_end', 'no_visible_messages', 'unverified'].includes(sample.coverage)
    && iso(sample.finished_at), 'SAMPLE_INVALID');
  let messages;
  try { messages = JSON.parse(sample.messages_json); } catch { throw new TypeError('SAMPLE_JSON_INVALID'); }
  check(Array.isArray(messages) && messages.length <= 1500, 'SAMPLE_MESSAGES_INVALID');
  for (const m of messages) {
    check(m && typeof m.message_id === 'string' && /^[1-9][0-9]{0,9}$/.test(m.message_id) && Number(m.message_id) <= 2147483647
      && (m.reply_to == null || typeof m.reply_to === 'string' && /^[1-9][0-9]{0,9}$/.test(m.reply_to) && Number(m.reply_to) <= 2147483647)
      && (m.unsupported === null || bounded(m.unsupported, 300))
      && typeof m.content_hash === 'string' && /^[a-f0-9]{64}$/.test(m.content_hash)
      && (m.text === null || typeof m.text === 'string' && m.text.length <= 16000) && iso(m.date)
      && Date.parse(m.date) >= Date.parse(sample.requested_from)
      && Date.parse(m.date) <= Date.parse(sample.requested_until), 'SAMPLE_MESSAGE_INVALID');
  }
  const actual = digest({ source_ref: sample.source_ref, account_id: sample.account_id,
    from: sample.requested_from, until: sample.requested_until, source_cursor: sample.source_cursor,
    messages, coverage: sample.coverage });
  check(actual === sample.digest, 'SAMPLE_DIGEST_MISMATCH');
  // Real Scout RPC uses a nullable opaque reason and digest(semantic), not a
  // boolean and a hash of text. Verify raw commitment before this small bridge.
  const result = probeDemandCandidates({ mission, sample: { ...sample, messages: messages.map(m => ({
    ...m, unsupported: m.unsupported !== null, content_hash: hashText(m.text ?? ''),
  })) } });
  const originalById = new Map(messages.map(m => [m.message_id, m]));
  for (const row of [...result.candidates, ...result.unselected]) {
    row.content_hash = originalById.get(row.message_id).content_hash;
    row.content_hash_kind = 'scout_semantic_commitment';
  }
  for (const row of result.omitted) {
    row.source_content_hash = originalById.get(row.message_id).content_hash;
    row.unsupported_reason = originalById.get(row.message_id).unsupported;
  }
  result.sample = { ...result.sample, sample_id: sample.id, candidate_id: sample.candidate_id,
    account_id: sample.account_id, requested_from: sample.requested_from, requested_until: sample.requested_until,
    source_cursor: sample.source_cursor, declared_finished_at: sample.finished_at, digest_checked: true,
    // Digest checks content integrity, not authenticity, current DB policy or a grant.
    usage_authority: 'NOT_CHECKED', observation_epoch: 'NOT_CHECKED',
    message_hash_verification: 'BOUND_BY_SAMPLE_COMMITMENT', message_format: 'scout_rpc_v1' };
  const fingerprint = digest(result);
  result.probe_fingerprint = fingerprint;
  verified.set(result, fingerprint);
  return result;
}

export function assertVerifiedDemandProbe(probe) {
  check(probe?.sample?.digest_checked === true, 'SAMPLE_UNVERIFIED');
  const { probe_fingerprint: fingerprint, ...content } = probe;
  check(verified.get(probe) === fingerprint && digest(content) === fingerprint, 'PROBE_INTEGRITY_INVALID');
}
