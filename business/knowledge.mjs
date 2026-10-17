// A small projection of checked-in research, not live source evidence or authority.
// Country terms reach a private question only through existing reviewed references.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJson } from './config.mjs';

const LABEL = 'source_attributed_summary_not_independent_verification';
const text = value => typeof value === 'string' && value.trim().length > 0;
const timestamp = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) return NaN;
  const parsed = Date.parse(value);
  const canonical = value.includes('.') ? value : value.replace(/Z$/, '.000Z');
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === canonical ? parsed : NaN;
};
const uniqueIds = rows => Array.isArray(rows) && rows.every(row => text(row?.id))
  && new Set(rows.map(row => row.id)).size === rows.length;
function reasonFor(group, at) {
  if (group?.status === 'revoked') return 'REFERENCE_REVOKED';
  const source = group?.source;
  let url;
  try { url = new URL(source?.url); } catch { return 'REFERENCE_SOURCE_INVALID'; }
  if (group?.status !== 'active' || !/^[A-Z]{2}$/.test(group?.market ?? '')
    || url.protocol !== 'https:' || url.username || url.password || !text(source.document_version)
    || !/^[a-f0-9]{64}$/.test(source.sha256 ?? '')
    || !uniqueIds(group.claims) || group.claims.length === 0 || group.claims.length > 32
    || group.claims.some(claim => !text(claim.section) || !text(claim.text))) return 'REFERENCE_INVALID';
  const checked = timestamp(source.checked_at), expiry = timestamp(source.review_after);
  if (!Number.isFinite(at) || !Number.isFinite(checked) || !Number.isFinite(expiry)
    || expiry <= checked || expiry - checked > 7 * 86400000 || checked > at) return 'REFERENCE_TIME_INVALID';
  return expiry <= at ? 'REFERENCE_RECHECK_REQUIRED' : null;
}

export function projectKnowledge(asset, { at = Date.now(), audience = 'model' } = {}) {
  const result = structuredClone(asset);
  if (!Object.hasOwn(result, 'official_references')) return result;
  // Reject a malformed catalogue without promoting any of its body to prompt data.
  const groups = result.official_references;
  if (result.schema !== 'partner-knowledge-v1' || !Array.isArray(groups) || groups.length > 16) {
    result.official_references = [];
    result.reference_status = 'REFERENCE_CATALOG_INVALID';
    return result;
  }
  const ids = groups.map(group => group?.id);
  result.official_references = groups.map((group, index) => {
    const validId = text(group?.id) && group.id.length <= 150;
    const reason = !validId || ids.filter(id => id === group.id).length !== 1 ? 'REFERENCE_ID_INVALID'
      : reasonFor(group, typeof at === 'number' ? at : Date.parse(at));
    // Whitelist metadata: a revoked/corrupt group's arbitrary fields must not leak.
    const metadata = { id: validId ? group.id : `invalid-reference-${index}`,
      market: /^[A-Z]{2}$/.test(group?.market ?? '') ? group.market : null, epistemic_status: LABEL };
    if (reason) return { ...metadata, status: 'unavailable', reason };
    if (audience !== 'operator') return { ...metadata, status: 'available_for_review',
      use: 'Country-specific content is withheld. An operator must attach current source-backed Work material to the exact question through reference.attach.' };
    return { ...metadata, status: 'reference_only', source: structuredClone(group.source), claims: structuredClone(group.claims),
      currentness_basis: 'Manual retrieval on checked_at; no continuous monitoring or independent verification. Recheck before use. review_after is a maintenance deadline, not proof of currentness.' };
  });
  return result;
}

export function loadPartnerKnowledge(options = {}) {
  const directory = options.directory ?? path.join(ROOT, 'partner/knowledge');
  return fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort()
    .map(name => projectKnowledge(readJson(path.join(directory, name)), options));
}
