// Adapter for the public OpenOutFind JSONL export. Does not run or import the donor.
import { ensure, now } from './errors.mjs';
import { digest } from './source-ingestion.mjs';

const KIND = 'executive.donor_candidate';
export const OPENOUTFIND_CONTRACT_REVISION = '36cf18fc69892fff9bbf71ca9748eec4198682a7';
export function importOpenOutFind(service, p) {
  service.executive.enabled();
  ensure(p && Object.keys(p).length === 1 && typeof p.jsonl === 'string' && Buffer.byteLength(p.jsonl) <= 48000,
    'Expected at most 48 KB of OpenOutFind JSONL', 400, 'DONOR_INPUT_INVALID');
  const lines = p.jsonl.split(/\r?\n/).filter(s => s.trim());
  ensure(lines.length >= 1 && lines.length <= 25, 'Choose 1–25 candidate records', 400, 'DONOR_INPUT_LIMIT');
  const records = lines.map(line => {
    let raw; try { raw = JSON.parse(line); } catch { ensure(false, 'Incomplete or invalid JSONL', 400, 'DONOR_JSON_INVALID'); }
    ensure(raw && typeof raw === 'object' && !Array.isArray(raw), 'Expected a candidate object', 400, 'DONOR_INPUT_INVALID');
    ensure((typeof raw.lead_id === 'string' && /^[A-Za-z0-9:_-]{1,100}$/.test(raw.lead_id))
      || Number.isSafeInteger(raw.lead_id) && raw.lead_id > 0, 'Candidate id missing', 400, 'DONOR_ID_INVALID');
    const projection = { lead_id: String(raw.lead_id) };
    for (const field of ['email','first_name','last_name','company','title','website','linkedin_url','reason','qualified_at','full_name','profile_text']) {
      const value = raw[field] ?? null;
      ensure(value === null || typeof value === 'string' && value.length <= (field === 'profile_text' ? 16000 : 4000),
        'Invalid candidate field', 400, 'DONOR_FIELD_INVALID');
      projection[field] = value;
    }
    ensure(typeof projection.reason === 'string' && projection.reason.trim(), 'Candidate explanation required', 400, 'DONOR_REASON_REQUIRED');
    return { record_key: digest(['openoutfind', projection]), donor: 'openoutfind', candidate: projection,
      input_sha256: digest(raw), adapter_contract_revision: OPENOUTFIND_CONTRACT_REVISION,
      exporter_revision: null, received_at: now(), epistemic_status: 'unverified_external_candidate',
      reason_kind: 'donor_model_interpretation', qualified_at_kind: 'donor_qualification_time_not_source_freshness',
      evidence_freshness: 'unknown', source_provenance: 'incomplete_export', contact_permission: false, executable: false };
  });
  const result = [];
  for (const record of records) {
    const existing = service.store.get(`SELECT id FROM events WHERE partner_id=? AND kind=? AND payload_json->>'$.record_key'=?`,
      service.config.partnerId, KIND, record.record_key);
    if (existing) { result.push({ event_id: String(existing.id), duplicate: true }); continue; }
    service.store.event(service.config.partnerId, null, KIND, 'operator', record);
    result.push({ event_id: String(service.store.get('SELECT last_insert_rowid() id').id), duplicate: false });
  }
  return { candidates: result, contact_permission: false, source_events_created: 0, executable: false };
}
export function listCandidates(service, { limit = 20, cursor = '0' } = {}) {
  ensure(Number.isInteger(limit) && limit >= 1 && limit <= 50 && typeof cursor === 'string' && /^(0|[1-9][0-9]{0,14})$/.test(cursor),
    'Invalid candidate page', 400, 'DONOR_PAGE_INVALID');
  const rows = service.store.all('SELECT id,payload_json FROM events WHERE partner_id=? AND kind=? AND id>? ORDER BY id LIMIT ?',
    service.config.partnerId, KIND, Number(cursor), limit + 1);
  return { items: rows.slice(0, limit).map(r => ({ event_id: String(r.id), ...JSON.parse(r.payload_json) })),
    next_cursor: rows.length > limit ? String(rows[limit - 1].id) : null };
}
