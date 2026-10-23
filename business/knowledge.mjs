// A small projection of checked-in research, not live source evidence or authority.
// Country terms reach a private question only through existing reviewed references.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
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

const OWNER_LABEL = 'owner_approved_presentation_summary_not_external_verification';

// Consistency binding to the checked-in source summaries, not a digital signature
// or proof that a publisher's statements have been independently verified.
export function ownerSpecificationDigest(asset) {
  return createHash('sha256').update(JSON.stringify({ id: asset.id, version: asset.version,
    review_after: asset.owner_specification?.review_after,
    sources: asset.owner_specification?.sources, facts: asset.facts })).digest('hex');
}

function ownerSpecificationReason(asset, at) {
  const spec = asset.owner_specification;
  if (spec?.status === 'revoked') return 'OWNER_SPECIFICATION_REVOKED';
  if (asset.schema !== 'partner-knowledge-v1' || !text(asset.id) || !text(asset.version)
    || Object.hasOwn(asset, 'official_references') || spec?.phase !== 'prelaunch' || spec.status !== 'approved'
    || spec.owner_decision !== 'use_supplied_presentations_for_prelaunch_preparation'
    || !uniqueIds(spec.sources) || spec.sources.length === 0 || spec.sources.length > 8
    || spec.sources.some(source => !text(source.file_name) || /[\\/:]/u.test(source.file_name)
      || !text(source.document_version) || !/^[a-f0-9]{64}$/u.test(source.sha256 ?? ''))
    || !uniqueIds(asset.facts) || asset.facts.length === 0 || asset.facts.length > 32
    || asset.facts.some(fact => !text(fact.text) || fact.text.length > 2000
      || fact.kind !== 'owner_approved_presentation_summary' || !text(fact.section) || !text(fact.source)
      || !spec.sources.some(source => source.id === fact.source_id))) return 'OWNER_SPECIFICATION_INVALID';
  const recorded = timestamp(spec.recorded_at), review = timestamp(spec.review_after);
  if (!Number.isFinite(at) || !Number.isFinite(recorded) || !Number.isFinite(review)
    || recorded > at || review <= recorded || review - recorded > 7 * 86400000)
    return 'OWNER_SPECIFICATION_TIME_INVALID';
  if (review <= at) return 'OWNER_SPECIFICATION_RECHECK_REQUIRED';
  if (spec.approved_content_sha256 !== ownerSpecificationDigest(asset)) return 'OWNER_SPECIFICATION_CHANGED';
  return null;
}

function projectOwnerSpecification(asset, { at, audience }) {
  const reason = ownerSpecificationReason(asset, typeof at === 'number' ? at : Date.parse(at));
  const projection = { schema: 'partner-knowledge-v1', id: asset.id, version: asset.version, title: asset.title,
    status: reason ? 'owner_specification_unavailable' : 'owner_approved_prelaunch',
    epistemic_status: OWNER_LABEL, facts: [],
    owner_specification: { phase: 'prelaunch', status: reason ? 'unavailable' : 'available_for_planning',
      ...(reason ? { reason } : {}),
      use: 'Owner-approved preparation only. Not proof of launch, performance, external verification, recipient interest or action authority.' } };
  // Private/model contexts receive the catalogue only. Preparing another offer
  // must never inject its commercial conditions into an existing conversation.
  if (reason || !['planning', 'operator'].includes(audience)) return projection;
  const spec = asset.owner_specification;
  projection.owner_specification = { ...projection.owner_specification, recorded_at: spec.recorded_at,
    review_after: spec.review_after, owner_decision: spec.owner_decision,
    approved_content_sha256: spec.approved_content_sha256,
    sources: spec.sources.map(({ id, file_name, document_version, sha256 }) => ({ id, file_name, document_version, sha256 })) };
  projection.facts = asset.facts.map(({ id, text, kind, source_id, section, source }) => ({ id, text, kind, source_id, section, source,
    epistemic_status: OWNER_LABEL }));
  for (const key of ['missing', 'boundaries']) if (Array.isArray(asset[key]))
    projection[key] = asset[key].filter(item => text(item)).slice(0, 32);
  return projection;
}

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
  if (Object.hasOwn(result, 'owner_specification')) return projectOwnerSpecification(result, { at, audience });
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
