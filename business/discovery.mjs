// Durable discovery is a pre-interaction attention layer. It stores bounded
// references to source events and never creates a person, conversation,
// permission, draft, delivery, or engagement state by itself.
import { id } from './store.mjs';
import { ensure, requiredText, now } from './errors.mjs';
import { sourceEvent, sourceRows, sourceAccessReadiness, digest } from './source-ingestion.mjs';

export { DISCOVERY_TABLES, DISCOVERY_REVIEW_TASK, DISCOVERY_ACTIONS } from './discovery-tables.mjs';
export const DISCOVERY_PENDING = 'discovery.observation.pending';
export const DISCOVERY_APPLIED = 'discovery.observation.applied';
export const DISCOVERY_FAILED = 'discovery.observation.failed';

const check = (condition, code, status = 409) => ensure(condition, `Discovery: ${code}`, status, code);
const parse = value => JSON.parse(value);
const textList = (value, max = 20, maxLength = 2000) => {
  check(Array.isArray(value) && value.length <= max, 'DISCOVERY_LIST_INVALID');
  return value.map(item => requiredText(item, 'discovery text', maxLength));
};
const fields = (value, allowed) => check(value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.includes(key)), 'DISCOVERY_FIELDS_INVALID');
const bounded = value => check(Buffer.byteLength(JSON.stringify(value)) <= 100000, 'DISCOVERY_PAYLOAD_TOO_LARGE');
const operator = actor => check(actor?.kind === 'operator', 'DISCOVERY_OPERATOR_REQUIRED', 403);
const systemActor = actor => check(actor?.kind === 'system', 'DISCOVERY_SYSTEM_ONLY', 403);
const ACTIVE = "status IN ('OBSERVING','CANDIDATE')";
const DISCOVERY_MAX_ACTIVE_SITUATIONS = 1000;
const DISCOVERY_MAX_EVIDENCE_ROWS = 100000;
const CONTEXT_NONE = 'none:';
const CONTEXT_THREAD_PREFIX = 'thread:';
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
// A durable wait deadline must name a real calendar instant. Node would otherwise
// silently roll 2026-02-30 over into March, so the wall components are round-tripped.
function parseIsoInstant(value) {
  const parts = typeof value === 'string' ? ISO_INSTANT.exec(value) : null;
  if (!parts) return null;
  const [, year, month, day, hour, minute, second] = parts;
  const wall = new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second));
  if (Number.isNaN(wall.getTime()) || wall.getUTCFullYear() !== +year || wall.getUTCMonth() !== +month - 1
    || wall.getUTCDate() !== +day || wall.getUTCHours() !== +hour || wall.getUTCMinutes() !== +minute
    || wall.getUTCSeconds() !== +second) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

function contextKeyForThread(threadId) {
  return threadId === null || threadId === undefined ? CONTEXT_NONE : `${CONTEXT_THREAD_PREFIX}${threadId}`;
}

function canonicalContextKey(value) {
  const text = requiredText(value, 'context_key', 200);
  check(text === CONTEXT_NONE || text === 'root'
    || (text.startsWith(CONTEXT_THREAD_PREFIX) && text.length > CONTEXT_THREAD_PREFIX.length),
  'DISCOVERY_CONTEXT_KEY_INVALID');
  return text === 'root' ? CONTEXT_NONE : text;
}

function config(service) {
  check(service.config.discovery?.enabled === true, 'DISCOVERY_DISABLED');
  const value = service.config.discovery;
  const maxEvidence = value.maxEvidence ?? 20;
  const ttlSeconds = value.ttlSeconds ?? 604800;
  const maxOpenSituations = value.maxOpenSituations ?? 100;
  check(Number.isInteger(maxEvidence) && maxEvidence >= 1 && maxEvidence <= 100, 'DISCOVERY_MAX_EVIDENCE_INVALID');
  check(Number.isInteger(ttlSeconds) && ttlSeconds >= 60 && ttlSeconds <= 2592000, 'DISCOVERY_TTL_INVALID');
  check(Number.isInteger(maxOpenSituations) && maxOpenSituations >= 1 && maxOpenSituations <= 1000, 'DISCOVERY_OPEN_LIMIT_INVALID');
  const offer = service.config.opportunity?.activeOffer;
  check(offer && typeof offer === 'object', 'DISCOVERY_OFFER_REQUIRED');
  const purpose = requiredText(value.purpose, 'discovery purpose', 500);
  return { maxEvidence, ttlSeconds, maxOpenSituations, purpose, offerFingerprint: digest(offer) };
}

function situation(service, situationId) {
  const row = service.store.get('SELECT * FROM discovery_situations WHERE id=? AND partner_id=?', situationId, service.config.partnerId);
  check(row, 'DISCOVERY_SITUATION_NOT_FOUND', 404);
  return row;
}

function liveSituation(service, key) {
  const query = context => service.store.get(`SELECT * FROM discovery_situations WHERE partner_id=? AND source_ref=?
    AND subject_ref=? AND context_key=? AND purpose=? AND offer_fingerprint=? AND ${ACTIVE}
    AND expires_at>? ORDER BY updated_at DESC LIMIT 1`, service.config.partnerId,
  key[0], key[1], context, key[3], key[4], now());
  let row = query(key[2]);
  if (!row && key[2] === CONTEXT_NONE) {
    row = query('root');
    if (row) {
      service.store.run('UPDATE discovery_situations SET context_key=? WHERE id=?', CONTEXT_NONE, row.id);
      row = service.store.get('SELECT * FROM discovery_situations WHERE id=?', row.id);
    }
  }
  return row;
}

function evidenceRows(service, situationId) {
  return service.store.all(`SELECT de.*, e.payload_json, e.created_at AS observed_at FROM discovery_evidence de
    JOIN events e ON e.id=de.source_event_id WHERE de.situation_id=? ORDER BY de.created_at,de.rowid`, situationId)
    .map(row => ({ ...row, source: parse(row.payload_json) }));
}

function evidenceFingerprint(service, situationId) {
  const situation = service.store.get('SELECT * FROM discovery_situations WHERE id=? AND partner_id=?', situationId, service.config.partnerId);
  check(situation, 'DISCOVERY_SITUATION_NOT_FOUND', 404);
  const refs = evidenceRows(service, situationId).map(item => ({
    source_event_id: String(item.source_event_id), message_id: item.message_id, message_version: item.message_version,
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return digest({ situation_id: situation.id, source_ref: situation.source_ref, subject_ref: situation.subject_ref,
    context_key: situation.context_key, purpose: situation.purpose, offer_fingerprint: situation.offer_fingerprint, evidence: refs });
}

export function assessmentFingerprint({ situationId, revision, evidenceFingerprintValue, evidenceEventIds = [],
  decision, hypothesis, whyNow, opening }) {
  return digest({ situation_id: situationId, revision, evidence_fingerprint: evidenceFingerprintValue,
    evidence_event_ids: [...evidenceEventIds].map(String).sort(), decision, hypothesis, why_now: whyNow, opening });
}

function currentSourceMessage(service, sourceId, messageId) {
  return sourceRows(service, sourceId).find(row => row.message.message_id === messageId) ?? null;
}

const currentMessageKey = (sourceId, messageId) => `${sourceId}\u0000${messageId}`;

function currentSourceMessages(service, evidence) {
  const messageIdsBySource = new Map();
  for (const item of evidence) {
    if (!messageIdsBySource.has(item.source.source_id)) messageIdsBySource.set(item.source.source_id, new Set());
    messageIdsBySource.get(item.source.source_id).add(item.message_id);
  }
  const current = new Map();
  for (const [sourceId, messageIds] of messageIdsBySource) {
    for (const item of sourceRows(service, sourceId, [...messageIds]))
      current.set(currentMessageKey(sourceId, item.message.message_id), item);
  }
  return current;
}

function sourceIsCurrent(service, evidence, currentMessages = null) {
  const current = currentMessages
    ? currentMessages.get(currentMessageKey(evidence.source.source_id, evidence.message_id))
    : currentSourceMessage(service, evidence.source.source_id, evidence.message_id);
  return !!current && String(current.event_id) === String(evidence.source_event_id)
    && current.message.version === evidence.message_version
    && current.message.operation === 'upsert';
}

function sourceExpired(source, ttlSeconds) {
  const observedAt = Date.parse(source.observed_at);
  return Number.isFinite(observedAt) && observedAt + ttlSeconds * 1000 <= Date.now();
}

function hasPendingSourceChange(service, row) {
  return !!service.store.get(`SELECT p.id FROM events p
    JOIN events s ON s.partner_id=p.partner_id AND s.kind='source.message'
      AND s.id=CAST(p.payload_json->>'$.source_event_id' AS INTEGER)
    WHERE p.partner_id=? AND p.kind=?
      AND json_extract(s.payload_json,'$.source_id')=?
      AND json_extract(s.payload_json,'$.author_id')=?
      AND CASE WHEN json_extract(s.payload_json,'$.thread_id') IS NULL THEN ?
        ELSE ? || json_extract(s.payload_json,'$.thread_id') END=?
      AND json_extract(p.payload_json,'$.offer_fingerprint')=?
      AND json_extract(p.payload_json,'$.purpose')=?
      AND NOT EXISTS (SELECT 1 FROM events a WHERE a.partner_id=p.partner_id AND a.kind=?
        AND a.payload_json->>'$.source_event_id'=p.payload_json->>'$.source_event_id')
    LIMIT 1`, service.config.partnerId, DISCOVERY_PENDING, row.source_ref, row.subject_ref,
  CONTEXT_NONE, CONTEXT_THREAD_PREFIX, canonicalContextKey(row.context_key), row.offer_fingerprint, row.purpose,
  DISCOVERY_APPLIED);
}

function fresh(service, row, currentMessages = null, evidenceOverride = null) {
  if (!row || !['OBSERVING', 'CANDIDATE'].includes(row.status)) return { fresh: false, reasons: ['DISCOVERY_NOT_LIVE'] };
  if (Date.parse(row.expires_at) <= Date.now()) return { fresh: false, reasons: ['DISCOVERY_EXPIRED'] };
  const evidence = evidenceOverride ?? evidenceRows(service, row.id);
  const current = currentMessages ?? currentSourceMessages(service, evidence);
  const reasons = [];
  if (!evidence.length) reasons.push('DISCOVERY_EVIDENCE_EMPTY');
  if (evidence.some(item => !sourceIsCurrent(service, item, current))) reasons.push('DISCOVERY_EVIDENCE_STALE');
  if (hasPendingSourceChange(service, row)) reasons.push('DISCOVERY_PENDING_SOURCE_CHANGE');
  const offer = service.config.opportunity?.activeOffer;
  if (!offer || typeof offer !== 'object' || digest(offer) !== row.offer_fingerprint) reasons.push('DISCOVERY_OFFER_CHANGED');
  const purpose = typeof service.config.discovery?.purpose === 'string'
    ? service.config.discovery.purpose.trim() : null;
  if (purpose !== row.purpose) reasons.push('DISCOVERY_PURPOSE_CHANGED');
  const access = sourceAccessReadiness(service, row.source_ref);
  if (!access.current) reasons.push(access.reason);
  return { fresh: reasons.length === 0, reasons, evidence };
}

function expireDue(service, at = now()) {
  const rows = service.store.all(`SELECT * FROM discovery_situations WHERE partner_id=?
    AND status IN ('OBSERVING','CANDIDATE') AND expires_at<=? ORDER BY id`, service.config.partnerId, at);
  for (const row of rows) markStale(service, row, 'TTL_EXPIRED', { cancelReview: false });
  return rows.length;
}

function staleMaterialEvidenceRows(service) {
  const rows = service.store.all(`SELECT s.id AS situation_id,s.source_ref,de.source_event_id,de.message_id,de.message_version
    FROM discovery_situations s
    LEFT JOIN discovery_evidence de ON de.situation_id=s.id
    WHERE s.partner_id=? AND s.status IN ('OBSERVING','CANDIDATE')
    ORDER BY s.updated_at,s.id,de.rowid LIMIT ?`, service.config.partnerId, DISCOVERY_MAX_EVIDENCE_ROWS);
  const situations = new Map(), rowsBySource = new Map(), staleReasons = new Map();
  for (const row of rows) {
    if (!situations.has(row.situation_id)) situations.set(row.situation_id, { id: row.situation_id, source_ref: row.source_ref });
    if (!rowsBySource.has(row.source_ref)) rowsBySource.set(row.source_ref, []);
    rowsBySource.get(row.source_ref).push(row);
  }
  for (const [sourceRef, sourceRowsForCleanup] of rowsBySource) {
    const access = sourceAccessReadiness(service, sourceRef);
    if (access.reason === 'SOURCE_NOT_ALLOWED') {
      for (const row of sourceRowsForCleanup) {
        if (!staleReasons.has(row.situation_id)) staleReasons.set(row.situation_id, 'SOURCE_REVOKED');
      }
      continue;
    }
    const messageIds = [...new Set(sourceRowsForCleanup
      .filter(row => row.source_event_id !== null).map(row => row.message_id))];
    if (!messageIds.length) continue;
    const currentByMessage = new Map(sourceRows(service, sourceRef, messageIds)
      .map(item => [item.message.message_id, item]));
    for (const row of sourceRowsForCleanup) {
      if (row.source_event_id === null) continue;
      const current = currentByMessage.get(row.message_id);
      if (!current || String(current.event_id) !== String(row.source_event_id)
        || current.message.version !== row.message_version || current.message.operation !== 'upsert') {
        if (!staleReasons.has(row.situation_id)) staleReasons.set(row.situation_id, 'EVIDENCE_STALE');
      }
    }
  }
  const stale = [];
  for (const [situationId, reason] of staleReasons) {
    const row = situations.get(situationId);
    if (row) {
      markStale(service, row, reason);
      stale.push(situationId);
    }
  }
  return stale;
}

export function staleMaterialEvidence(service) {
  if (service.config.discovery?.enabled !== true) return [];
  return service.store.transaction(() => staleMaterialEvidenceRows(service));
}

const DISCOVERY_MAINTENANCE_MAX = 1000;
const REVOKED_MAINTENANCE_CURSOR_CHANNEL = 'discovery-revoked-maintenance-v1';

function readRevokedMaintenanceCursor(service) {
  const row = service.store.get('SELECT cursor FROM channel_offsets WHERE channel=? AND account_id=?',
    REVOKED_MAINTENANCE_CURSOR_CHANNEL, service.config.partnerId);
  if (!row) return null;
  try {
    const value = parse(row.cursor);
    return typeof value.source_ref === 'string' ? value.source_ref : null;
  } catch {
    return null;
  }
}

function writeRevokedMaintenanceCursor(service, sourceRef) {
  service.store.run(`INSERT INTO channel_offsets(channel,account_id,cursor) VALUES(?,?,?)
    ON CONFLICT(channel,account_id) DO UPDATE SET cursor=excluded.cursor`,
  REVOKED_MAINTENANCE_CURSOR_CHANNEL, service.config.partnerId, JSON.stringify({ source_ref: sourceRef }));
}

export function invalidateRevokedDiscoverySources(service, limit = DISCOVERY_MAINTENANCE_MAX) {
  check(Number.isInteger(limit) && limit >= 1 && limit <= DISCOVERY_MAINTENANCE_MAX,
    'DISCOVERY_MAINTENANCE_LIMIT');
  return service.store.transaction(() => {
    const scanLimit = limit;
    const maintenanceRows = (after, take, before = null) => {
      const predicates = [], params = [service.config.partnerId, service.config.partnerId,
        DISCOVERY_PENDING, DISCOVERY_APPLIED];
      if (after !== null) { predicates.push('source_ref > ?'); params.push(after); }
      if (before !== null) { predicates.push('source_ref <= ?'); params.push(before); }
      params.push(take);
      const predicate = predicates.length ? `WHERE ${predicates.join(' AND ')}` : '';
      return service.store.all(`SELECT source_ref FROM (
          SELECT COALESCE(source_ref,'') AS source_ref
          FROM discovery_situations
          WHERE partner_id=? AND status IN ('OBSERVING','CANDIDATE')
          UNION
          SELECT COALESCE(json_extract(s.payload_json,'$.source_id'),'') AS source_ref
          FROM events p
          JOIN events s ON s.partner_id=p.partner_id AND s.kind='source.message'
            AND s.id=CAST(p.payload_json->>'$.source_event_id' AS INTEGER)
          WHERE p.partner_id=? AND p.kind=?
            AND NOT EXISTS (SELECT 1 FROM events a WHERE a.partner_id=p.partner_id AND a.kind=?
              AND a.payload_json->>'$.source_event_id'=p.payload_json->>'$.source_event_id')
        ) AS grouped ${predicate} ORDER BY source_ref LIMIT ?`, ...params);
    };
    const cursor = readRevokedMaintenanceCursor(service);
    let sourceRefs = maintenanceRows(cursor, scanLimit);
    if (cursor !== null && sourceRefs.length < scanLimit) {
      sourceRefs = sourceRefs.concat(maintenanceRows(null, scanLimit - sourceRefs.length, cursor));
    }
    writeRevokedMaintenanceCursor(service, sourceRefs.length
      ? String(sourceRefs[sourceRefs.length - 1].source_ref ?? '') : null);

    const sourceRefValues = sourceRefs.map(row => String(row.source_ref ?? ''));
    const sourceRefSet = new Set(sourceRefValues);
    const revoked = new Set([...sourceRefSet]
      .filter(sourceRef => sourceAccessReadiness(service, sourceRef).reason === 'SOURCE_NOT_ALLOWED'));
    const queues = sourceRefValues.map(sourceRef => {
      const active = service.store.get(`SELECT * FROM discovery_situations
        WHERE partner_id=? AND status IN ('OBSERVING','CANDIDATE') AND source_ref=?
        ORDER BY updated_at,id LIMIT 1`, service.config.partnerId, sourceRef);
      const pending = service.store.get(`SELECT DISTINCT COALESCE(json_extract(s.payload_json,'$.source_id'),'') AS source_ref,
          CAST(p.payload_json->>'$.source_event_id' AS INTEGER) AS source_event_id
        FROM events p
        JOIN events s ON s.partner_id=p.partner_id AND s.kind='source.message'
          AND s.id=CAST(p.payload_json->>'$.source_event_id' AS INTEGER)
        WHERE p.partner_id=? AND p.kind=?
          AND NOT EXISTS (SELECT 1 FROM events a WHERE a.partner_id=p.partner_id AND a.kind=?
            AND a.payload_json->>'$.source_event_id'=p.payload_json->>'$.source_event_id')
          AND COALESCE(json_extract(s.payload_json,'$.source_id'),'')=?
        ORDER BY p.id LIMIT 1`, service.config.partnerId, DISCOVERY_PENDING, DISCOVERY_APPLIED, sourceRef);
      const items = [];
      if (active) items.push({ kind: 'active', row: active });
      if (pending) items.push({ kind: 'pending', row: pending });
      return { sourceRef, items };
    });
    let budget = limit;
    let count = 0;
    const rounds = Math.max(0, ...queues.map(queue => queue.items.length));
    for (let round = 0; round < rounds && budget > 0; round += 1) {
      for (const queue of queues) {
        if (!budget) break;
        const item = queue.items[round];
        if (!item || !revoked.has(queue.sourceRef)) continue;
        if (item.kind === 'active') markStale(service, item.row, 'SOURCE_REVOKED');
        else record(service, DISCOVERY_APPLIED, { source_event_id: String(item.row.source_event_id),
          stage: 'source_projection', projection_status: 'source_revoked' });
        count++;
        budget--;
      }
    }
    return count;
  });
}

function invalidateChangedOffers(service, offerFingerprint, purpose) {
  const rows = service.store.all(`SELECT * FROM discovery_situations WHERE partner_id=?
    AND status IN ('OBSERVING','CANDIDATE') AND (offer_fingerprint<>? OR purpose<>?) ORDER BY id`,
  service.config.partnerId, offerFingerprint, purpose);
  for (const row of rows) markStale(service, row, row.purpose !== purpose ? 'PURPOSE_CHANGED' : 'OFFER_CHANGED');
  return rows.length;
}

export function invalidateDiscoveryOffers(service) {
  if (service.config.discovery?.enabled !== true) return 0;
  const offer = service.config.opportunity?.activeOffer;
  if (!offer || typeof offer !== 'object') return 0;
  const purpose = requiredText(service.config.discovery.purpose, 'discovery purpose', 500);
  return invalidateChangedOffers(service, digest(offer), purpose);
}

function record(service, kind, payload) {
  service.store.event(service.config.partnerId, null, kind, 'system', payload);
  return String(service.store.get('SELECT last_insert_rowid() AS id').id);
}

function sourceMarker(service, sourceEventId, kind) {
  return service.store.get(`SELECT id,created_at,payload_json FROM events WHERE partner_id=?
    AND kind=? AND json_extract(payload_json,'$.source_event_id')=? ORDER BY id DESC LIMIT 1`,
  service.config.partnerId, kind, String(sourceEventId));
}

export function recordDiscoveryFailure(service, sourceEventId, error) {
  const code = String(error?.code ?? 'DISCOVERY_OBSERVATION_FAILED').slice(0, 120);
  const existing = service.store.get(`SELECT id FROM events WHERE partner_id=? AND kind=?
    AND json_extract(payload_json,'$.source_event_id')=? AND json_extract(payload_json,'$.code')=? LIMIT 1`,
  service.config.partnerId, DISCOVERY_FAILED, String(sourceEventId), code);
  if (existing) return String(existing.id);
  return record(service, DISCOVERY_FAILED, { source_event_id: String(sourceEventId), stage: 'source_projection', code });
}

function intakeBasis(service) {
  const offer = service.config.opportunity?.activeOffer;
  const purpose = service.config.discovery?.purpose;
  return {
    offer_fingerprint: offer && typeof offer === 'object' ? digest(offer) : null,
    purpose: typeof purpose === 'string' ? purpose.trim() : null,
  };
}

function markPending(service, sourceEventId) {
  if (sourceMarker(service, sourceEventId, DISCOVERY_PENDING) || sourceMarker(service, sourceEventId, DISCOVERY_APPLIED)) return false;
  record(service, DISCOVERY_PENDING, { source_event_id: String(sourceEventId), stage: 'source_projection', ...intakeBasis(service) });
  return true;
}

function cancelReviews(service, situationId) {
  service.store.run(`UPDATE tasks SET status='cancelled' WHERE id IN (
    SELECT t.id FROM tasks t JOIN events e ON e.id=t.evidence
    WHERE t.partner_id=? AND t.kind='discovery_review' AND t.status='proposed'
      AND e.kind='discovery.assessment' AND json_extract(e.payload_json,'$.situation_id')=?)`,
  service.config.partnerId, situationId);
}

function latestAssessment(service, situationId) {
  const row = service.store.get("SELECT id,payload_json FROM events WHERE partner_id=? AND kind='discovery.assessment' AND json_extract(payload_json,'$.situation_id')=? ORDER BY id DESC LIMIT 1",
    service.config.partnerId, situationId);
  return row ? { id: String(row.id), ...parse(row.payload_json) } : null;
}

function lastReasonTransition(service, situationId) {
  const row = service.store.get("SELECT id,payload_json FROM events WHERE partner_id=? AND kind='discovery.reason.transitioned' AND json_extract(payload_json,'$.situation_id')=? ORDER BY id DESC LIMIT 1",
    service.config.partnerId, situationId);
  return row ? { id: String(row.id), ...parse(row.payload_json) } : null;
}

function reasonGate(service, row) {
  const transition = lastReasonTransition(service, row.id);
  if (!transition || transition.evidence_fingerprint !== evidenceFingerprint(service, row.id)) return;
  if (transition.decision === 'IGNORE') check(false, 'DISCOVERY_REASON_IGNORED');
  if (transition.decision === 'WAIT') {
    const wait = transition.wait;
    const blocked = wait?.kind === 'evidence_change'
      || (wait?.kind === 'deadline' && Date.parse(wait.at) > Date.now());
    check(!blocked, 'DISCOVERY_REASON_WAITING');
  }
}

function markStale(service, row, reason, { cancelReview = true } = {}) {
  service.store.run("UPDATE discovery_situations SET status='STALE',revision=revision+1,updated_at=? WHERE id=?", now(), row.id);
  if (cancelReview) cancelReviews(service, row.id);
  record(service, 'discovery.situation.stale', { situation_id: row.id, reason });
  return service.store.get('SELECT * FROM discovery_situations WHERE id=?', row.id);
}

function touch(service, row, status = row.status) {
  service.store.run('UPDATE discovery_situations SET status=?,revision=revision+1,updated_at=? WHERE id=?', status, now(), row.id);
  return service.store.get('SELECT * FROM discovery_situations WHERE id=?', row.id);
}

function contextMatches(row, message) {
  return row.source_ref === message.source_id && row.subject_ref === message.author_id
    && canonicalContextKey(row.context_key) === contextKeyForThread(message.thread_id);
}

function staleForMessage(service, message, reason) {
  const rows = service.store.all(`SELECT DISTINCT s.* FROM discovery_situations s
    JOIN discovery_evidence de ON de.situation_id=s.id
    JOIN events e ON e.id=de.source_event_id
    WHERE s.partner_id=? AND json_extract(e.payload_json,'$.source_id')=?
      AND de.message_id=? AND s.status IN ('OBSERVING','CANDIDATE')`,
  service.config.partnerId, message.source_id, message.message_id);
  for (const row of rows) markStale(service, row, reason);
  return rows.map(row => row.id);
}

function addEvidence(service, row, sourceEventId) {
  const source = sourceEvent(service, String(sourceEventId));
  check(contextMatches(row, source.message), 'DISCOVERY_EVIDENCE_SCOPE');
  check(source.message.operation === 'upsert', 'DISCOVERY_EVIDENCE_UNSUPPORTED');
  const current = currentSourceMessage(service, source.message.source_id, source.message.message_id);
  check(current && String(current.event_id) === String(sourceEventId), 'DISCOVERY_SOURCE_EVENT_SUPERSEDED');
  const duplicate = service.store.get('SELECT id FROM discovery_evidence WHERE situation_id=? AND source_event_id=?', row.id, String(sourceEventId));
  if (duplicate) return { id: duplicate.id, duplicate: true };
  const count = service.store.get('SELECT COUNT(*) AS n FROM discovery_evidence WHERE situation_id=?', row.id).n;
  check(count < config(service).maxEvidence, 'DISCOVERY_EVIDENCE_LIMIT');
  const numericId = Number(sourceEventId);
  check(Number.isSafeInteger(numericId) && numericId > 0, 'DISCOVERY_SOURCE_EVENT_INVALID');
  const evidenceId = id();
  service.store.run('INSERT INTO discovery_evidence VALUES(?,?,?,?,?,?)', evidenceId, row.id, numericId,
    source.message.message_id, source.message.version, now());
  return { id: evidenceId, duplicate: false };
}

function observe(service, p, actor) {
  systemActor(actor);
  fields(p, ['source_event_id', 'context_key', 'purpose']);
  const sourceId = requiredText(p.source_event_id, 'source_event_id', 150);
  const source = sourceEvent(service, sourceId), message = source.message;
  const limits = config(service);
  const access = sourceAccessReadiness(service, message.source_id);
  check(access.current, 'DISCOVERY_SOURCE_NOT_CURRENT');
  if (message.operation !== 'upsert') {
    check(['delete', 'unsupported'].includes(message.operation), 'DISCOVERY_SOURCE_NOT_OBSERVABLE');
    const staleSituationIds = staleForMessage(service, message, message.operation === 'delete' ? 'SOURCE_DELETED' : 'SOURCE_UNSUPPORTED');
    return { disposition: message.operation === 'delete' ? 'source_deleted' : 'source_unsupported',
      stale_situation_ids: staleSituationIds, contact_permission: false, allowed_effects: [] };
  }
  check(message.author_id && !message.author_id.startsWith('channel:'), 'DISCOVERY_SUBJECT_NOT_AVAILABLE');
  const contextKey = canonicalContextKey(p.context_key);
  const purpose = requiredText(p.purpose, 'purpose', 500);
  expireDue(service);
  invalidateChangedOffers(service, limits.offerFingerprint, limits.purpose);
  const numericSourceId = Number(sourceId);
  check(Number.isSafeInteger(numericSourceId) && numericSourceId > 0, 'DISCOVERY_SOURCE_EVENT_INVALID');
  const priorEvidence = service.store.get(`SELECT de.id,de.situation_id,s.status,s.revision
    FROM discovery_evidence de JOIN discovery_situations s ON s.id=de.situation_id
    WHERE de.source_event_id=? AND s.partner_id=?`, numericSourceId, service.config.partnerId);
  if (priorEvidence) return { situation_id: priorEvidence.situation_id, status: priorEvidence.status,
    revision: priorEvidence.revision, evidence_id: priorEvidence.id, duplicate: true,
    contact_permission: false, allowed_effects: [] };
  const current = currentSourceMessage(service, message.source_id, message.message_id);
  if (message.operation === 'upsert' && current && String(current.event_id) === String(sourceId))
    staleForMessage(service, message, 'SOURCE_SUPERSEDED');
  if (message.operation === 'upsert' && sourceExpired(source, limits.ttlSeconds))
    return { disposition: 'source_expired', contact_permission: false, allowed_effects: [] };
  const key = [message.source_id, message.author_id, contextKey, purpose, limits.offerFingerprint];

  let row = liveSituation(service, key);
  if (row) {
    const existingEvidence = service.store.get('SELECT id FROM discovery_evidence WHERE situation_id=? AND source_event_id=?', row.id, sourceId);
    if (existingEvidence) return { situation_id: row.id, status: row.status, revision: row.revision,
      evidence_id: existingEvidence.id, duplicate: true, contact_permission: false, allowed_effects: [] };
    const oldForMessage = service.store.get('SELECT id FROM discovery_evidence WHERE situation_id=? AND message_id=?', row.id, message.message_id);
    const evidenceCount = service.store.get('SELECT COUNT(*) AS n FROM discovery_evidence WHERE situation_id=?', row.id).n;
    if (oldForMessage) row = markStale(service, row, 'SOURCE_SUPERSEDED');
    else if (evidenceCount >= limits.maxEvidence) {
      const newest = service.store.get('SELECT MAX(source_event_id) AS source_event_id FROM discovery_evidence WHERE situation_id=?', row.id);
      if (newest?.source_event_id != null && numericSourceId < Number(newest.source_event_id))
        return { disposition: 'source_obsolete', contact_permission: false, allowed_effects: [] };
      row = markStale(service, row, 'EVIDENCE_LIMIT_REACHED');
    }
  }
  if (!row || !['OBSERVING', 'CANDIDATE'].includes(row.status)) {
    const open = service.store.get(`SELECT COUNT(*) AS n FROM discovery_situations WHERE partner_id=?
      AND status IN ('OBSERVING','CANDIDATE') AND expires_at>?`, service.config.partnerId, now()).n;
    check(open < limits.maxOpenSituations, 'DISCOVERY_OPEN_LIMIT');
    const situationId = id(), created = now();
    const observedAt = Date.parse(source.observed_at);
    check(Number.isFinite(observedAt), 'DISCOVERY_SOURCE_OBSERVATION_TIME_INVALID');
    const expires = new Date(observedAt + limits.ttlSeconds * 1000).toISOString();
    service.store.run('INSERT INTO discovery_situations(id,partner_id,source_ref,source_kind,subject_ref,context_key,purpose,offer_fingerprint,status,revision,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      situationId, service.config.partnerId, message.source_id, message.source_kind, message.author_id, contextKey, purpose,
      limits.offerFingerprint, 'OBSERVING', 0, expires, created, created);
    row = service.store.get('SELECT * FROM discovery_situations WHERE id=?', situationId);
    record(service, 'discovery.situation.created', { situation_id: situationId, source_event_id: sourceId,
      context_key: contextKey, purpose, subject_basis: 'source_scoped_id_not_person' });
  }

  const evidence = addEvidence(service, row, sourceId);
  if (evidence.duplicate) return { situation_id: row.id, status: row.status, revision: row.revision,
    evidence_id: evidence.id, duplicate: true, contact_permission: false, allowed_effects: [] };
  cancelReviews(service, row.id);
  const updated = touch(service, row, 'OBSERVING');
  record(service, 'discovery.evidence.added', { situation_id: row.id, evidence_id: evidence.id, source_event_id: sourceId });
  return { situation_id: row.id, status: updated.status, revision: updated.revision, evidence_id: evidence.id,
    contact_permission: false, allowed_effects: [] };
}

// Interpretations live only in assessment events. The caller cannot supply
// observations, source attribution, freshness, or authority via this contract.
function assessmentReasoning(p, evidenceIds, currentEvidence) {
  if (typeof p.hypothesis === 'string' && typeof p.why_now === 'string') {
    return { hypothesis: requiredText(p.hypothesis, 'hypothesis', 4000),
      whyNow: requiredText(p.why_now, 'why_now', 4000), reasoningVersion: 0 };
  }
  fields(p.hypothesis, ['text', 'evidence_event_ids', 'attributed_claims', 'inferences', 'uncertainty']);
  fields(p.why_now, ['reason', 'evidence_event_ids']);
  const selected = new Set(evidenceIds);
  const references = value => {
    const refs = textList(value, 100, 150);
    check(refs.length > 0, 'DISCOVERY_REASONING_EVIDENCE_REQUIRED');
    check(new Set(refs).size === refs.length, 'DISCOVERY_REASONING_EVIDENCE_DUPLICATE');
    check(refs.every(ref => selected.has(ref)), 'DISCOVERY_REASONING_EVIDENCE_SCOPE');
    return refs;
  };
  const items = value => {
    check(Array.isArray(value) && value.length <= 20, 'DISCOVERY_LIST_INVALID');
    return value;
  };
  const hypothesis = {
    text: requiredText(p.hypothesis.text, 'hypothesis text', 4000),
    evidence_event_ids: references(p.hypothesis.evidence_event_ids),
    attributed_claims: items(p.hypothesis.attributed_claims).map(claim => {
      fields(claim, ['source_event_id', 'quote']);
      const sourceId = references([claim.source_event_id])[0];
      const quote = requiredText(claim.quote, 'claim quote', 4000);
      const evidence = currentEvidence.find(item => String(item.source_event_id) === sourceId);
      check(typeof evidence.source.text === 'string' && evidence.source.text.includes(quote), 'DISCOVERY_CLAIM_QUOTE_MISMATCH');
      // An exact quote proves only that the source said this, not that it is true.
      return { source_event_id: sourceId, quote };
    }),
    inferences: items(p.hypothesis.inferences).map(inference => {
      fields(inference, ['text', 'evidence_event_ids']);
      return { text: requiredText(inference.text, 'inference text', 4000),
        evidence_event_ids: references(inference.evidence_event_ids) };
    }),
    uncertainty: textList(p.hypothesis.uncertainty, 20, 2000),
  };
  check(hypothesis.uncertainty.length > 0, 'DISCOVERY_UNCERTAINTY_REQUIRED');
  return { hypothesis, whyNow: { reason: requiredText(p.why_now.reason, 'why_now reason', 4000),
    evidence_event_ids: references(p.why_now.evidence_event_ids) }, reasoningVersion: 1 };
}

function assessment(service, p) {
  const limits = config(service);
  invalidateChangedOffers(service, limits.offerFingerprint, limits.purpose);
  fields(p, ['situation_id', 'expected_revision', 'expected_evidence_fingerprint', 'decision', 'hypothesis', 'why_now', 'evidence_event_ids', 'opening_proposal']);
  const row = situation(service, p.situation_id);
  const currentEvidence = evidenceRows(service, row.id);
  const currentMessages = currentSourceMessages(service, currentEvidence);
  const state = fresh(service, row, currentMessages, currentEvidence);
  check(state.fresh, `DISCOVERY_STALE:${state.reasons.join(',')}`);
  check(p.expected_revision === row.revision, 'DISCOVERY_REVISION_CONFLICT');
  check(p.expected_evidence_fingerprint === evidenceFingerprint(service, row.id), 'DISCOVERY_EVIDENCE_FINGERPRINT_CONFLICT');
  reasonGate(service, row);
  check(['OBSERVE', 'DISMISS', 'CANDIDATE'].includes(p.decision), 'DISCOVERY_DECISION_INVALID');
  const evidenceIds = textList(p.evidence_event_ids, 100, 150);
  check(evidenceIds.length > 0, 'DISCOVERY_ASSESSMENT_EVIDENCE_REQUIRED');
  check(new Set(evidenceIds).size === evidenceIds.length, 'DISCOVERY_ASSESSMENT_EVIDENCE_DUPLICATE');
  const known = new Set(currentEvidence.map(item => String(item.source_event_id)));
  check(evidenceIds.every(value => known.has(value) && sourceIsCurrent(service,
    currentEvidence.find(item => String(item.source_event_id) === value), currentMessages)), 'DISCOVERY_ASSESSMENT_EVIDENCE_SCOPE');
  const { hypothesis, whyNow, reasoningVersion } = assessmentReasoning(p, evidenceIds, currentEvidence);
  check(p.decision === 'CANDIDATE' ? p.opening_proposal !== undefined : p.opening_proposal === undefined,
    'DISCOVERY_OPENING_SCOPE');
  const opening = p.opening_proposal === undefined ? null : (() => {
    fields(p.opening_proposal, ['text', 'rationale', 'constraints']);
    return { text: requiredText(p.opening_proposal.text, 'opening text', 4096),
      rationale: requiredText(p.opening_proposal.rationale, 'opening rationale', 4000),
      constraints: textList(p.opening_proposal.constraints ?? [], 20, 500) };
  })();
  bounded({ hypothesis, whyNow, evidenceIds, opening });
  cancelReviews(service, row.id);
  const resultRevision = row.revision + 1;
  const assessmentFingerprintValue = assessmentFingerprint({ situationId: row.id, revision: row.revision,
    evidenceFingerprintValue: evidenceFingerprint(service, row.id), evidenceEventIds: evidenceIds,
    decision: p.decision, hypothesis, whyNow, opening });
  const assessmentId = record(service, 'discovery.assessment', { situation_id: row.id, basis_revision: row.revision,
    result_revision: resultRevision, decision: p.decision, hypothesis, why_now: whyNow, evidence: evidenceIds,
    reasoning_version: reasoningVersion,
    evidence_fingerprint: evidenceFingerprint(service, row.id), assessment_fingerprint: assessmentFingerprintValue });
  const openingId = opening ? record(service, 'discovery.opening_proposal', { situation_id: row.id,
    assessment_id: assessmentId, ...opening }) : null;
  const updated = touch(service, row, p.decision === 'DISMISS' ? 'DISMISSED' : 'OBSERVING');
  const review = p.decision === 'CANDIDATE' ? service.addTask({ kind: 'discovery_review', title: 'Discovery review: CANDIDATE',
    instructions: 'Operator review only. Do not create a person, contact, permission, draft, or send.',
    evidence: assessmentId, due_at: now(), dedupe_key: `discovery-review:${row.id}:${updated.revision}` }, 'system', 'proposed') : null;
  record(service, 'discovery.review.created', { situation_id: row.id, assessment_id: assessmentId,
    opening_proposal_id: openingId, task_id: review?.task_id ?? null });
  return { situation_id: row.id, assessment_id: assessmentId, opening_proposal_id: openingId,
    review_task_id: review?.task_id ?? null, status: updated.status, revision: updated.revision,
    executable: false, contact_permission: false, allowed_effects: [] };
}

function reasonTransition(service, p, actor) {
  operator(actor);
  const limits = config(service);
  invalidateChangedOffers(service, limits.offerFingerprint, limits.purpose);
  fields(p, ['situation_id', 'assessment_id', 'expected_revision', 'expected_evidence_fingerprint',
    'decision', 'reason', 'wait']);
  const row = situation(service, p.situation_id);
  const fingerprint = evidenceFingerprint(service, row.id);
  const state = fresh(service, row);
  check(state.fresh, `DISCOVERY_STALE:${state.reasons.join(',')}`);
  check(p.expected_revision === row.revision, 'DISCOVERY_REVISION_CONFLICT');
  check(p.expected_evidence_fingerprint === fingerprint, 'DISCOVERY_EVIDENCE_FINGERPRINT_CONFLICT');
  const assessment = latestAssessment(service, row.id);
  check(assessment && assessment.id === String(p.assessment_id), 'DISCOVERY_REASON_ASSESSMENT_STALE');
  check(assessment.evidence_fingerprint === fingerprint, 'DISCOVERY_REASON_FINGERPRINT_CONFLICT');
  check(assessment.result_revision === row.revision, 'DISCOVERY_REASON_ASSESSMENT_STALE');
  check(['WAIT', 'IGNORE', 'STOP'].includes(p.decision), 'DISCOVERY_REASON_DECISION_INVALID');
  const reasonText = requiredText(p.reason, 'reason', 4000);
  let wait = null;
  if (p.decision === 'WAIT') {
    check(p.wait && typeof p.wait === 'object' && !Array.isArray(p.wait), 'DISCOVERY_WAIT_REQUIRED');
    const kind = p.wait.kind;
    check(kind === 'deadline' || kind === 'evidence_change', 'DISCOVERY_WAIT_INVALID');
    if (kind === 'evidence_change') {
      check(Object.keys(p.wait).length === 1, 'DISCOVERY_WAIT_INVALID');
      wait = { kind };
    } else {
      // Durable wait deadlines are stored and compared across restarts and hosts,
      // so only an explicit ISO-8601 instant is accepted and it is stored canonically.
      const at = Object.keys(p.wait).length === 2 ? parseIsoInstant(p.wait.at) : null;
      check(at && at.getTime() > Date.now(), 'DISCOVERY_WAIT_INVALID');
      wait = { kind, at: at.toISOString() };
    }
  } else {
    check(p.wait === undefined, 'DISCOVERY_WAIT_NOT_ALLOWED');
  }
  cancelReviews(service, row.id);
  const basisRevision = row.revision;
  const updated = touch(service, row, p.decision === 'STOP' ? 'DISMISSED' : 'OBSERVING');
  record(service, 'discovery.reason.transitioned', {
    situation_id: row.id, assessment_id: assessment.id,
    assessment_fingerprint: assessment.assessment_fingerprint, basis_revision: basisRevision,
    result_revision: updated.revision, evidence_fingerprint: fingerprint, decision: p.decision,
    reason: reasonText, wait,
  });
  return { situation_id: row.id, assessment_id: assessment.id, decision: p.decision, wait,
    status: p.decision === 'STOP' ? 'STOPPED' : updated.status, revision: updated.revision,
    storage_status: updated.status, executable: false, contact_permission: false,
    allowed_effects: [] };
}

const REASON_STATE_MAX_LIMIT = 100;
const freshnessVerdict = state => ({ fresh: state.fresh, reasons: state.reasons });
const SITUATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Read-only projection of situations whose latest durable reason transition still governs the
// current basis. It reports what blocks them and never repairs, expires, or unlocks anything.
function reasonStates(service, options, actor) {
  operator(actor);
  fields(options, ['limit', 'cursor']);
  const limit = options.limit === undefined ? REASON_STATE_MAX_LIMIT : options.limit;
  check(Number.isInteger(limit) && limit >= 1 && limit <= REASON_STATE_MAX_LIMIT, 'DISCOVERY_FIELDS_INVALID');
  if (options.cursor !== undefined) {
    // Keyset cursor is a situation id; a malformed one must not silently read as the first page.
    check(typeof options.cursor === 'string' && SITUATION_ID.test(options.cursor), 'DISCOVERY_FIELDS_INVALID');
  }
  const rows = service.store.all(`SELECT * FROM discovery_situations
    WHERE partner_id=? AND ${ACTIVE} AND id>? ORDER BY id LIMIT ?`,
  service.config.partnerId, options.cursor ?? '', limit + 1);
  const page = rows.slice(0, limit);
  const items = page.map((row) => {
    const transition = lastReasonTransition(service, row.id);
    const fingerprint = evidenceFingerprint(service, row.id);
    // A transition governs the basis only while it still produced the current revision and
    // describes the current evidence; a newer assessment or new evidence retires it.
    if (!transition || transition.evidence_fingerprint !== fingerprint
      || transition.result_revision !== row.revision) return null;
    const state = fresh(service, row);
    const deadlineReached = transition.decision === 'WAIT' && transition.wait?.kind === 'deadline'
      && Date.parse(transition.wait.at) <= Date.now();
    return { situation_id: row.id, storage_status: row.status, revision: row.revision,
      evidence_fingerprint: fingerprint, transition_id: transition.id, decision: transition.decision,
      wait: transition.wait ?? null, state: deadlineReached ? 'READY' : 'BLOCKED',
      unlock: transition.wait?.kind === 'deadline' ? 'DEADLINE_OR_EVIDENCE_CHANGE' : 'EVIDENCE_CHANGE',
      reason: deadlineReached ? 'DEADLINE_REACHED' : transition.reason,
      // Only the verdict travels here: the situation detail stays the place that exposes evidence.
      freshness: freshnessVerdict(state),
      executable: false, contact_permission: false, allowed_effects: [] };
  }).filter(Boolean);
  return { items, next_cursor: rows.length > limit ? page.at(-1).id : null };
}

function review(service, p, actor) {
  operator(actor);
  const limits = config(service);
  invalidateChangedOffers(service, limits.offerFingerprint, limits.purpose);
  fields(p, ['task_id', 'decision', 'expected_revision', 'expected_evidence_fingerprint']);
  check(p.decision === 'approve' || p.decision === 'reject', 'DISCOVERY_REVIEW_DECISION_INVALID');
  const task = service.store.get("SELECT * FROM tasks WHERE id=? AND partner_id=? AND kind='discovery_review'", p.task_id, service.config.partnerId);
  check(task && task.status === 'proposed', 'DISCOVERY_REVIEW_NOT_AVAILABLE');
  const assessmentRow = service.store.get('SELECT id,payload_json FROM events WHERE id=? AND partner_id=? AND kind=?',
    task.evidence, service.config.partnerId, 'discovery.assessment');
  check(assessmentRow, 'DISCOVERY_ASSESSMENT_NOT_FOUND');
  const assessment = parse(assessmentRow.payload_json), row = situation(service, assessment.situation_id);
  check(p.expected_revision === row.revision, 'DISCOVERY_REVISION_CONFLICT');
  check(p.expected_evidence_fingerprint === evidenceFingerprint(service, row.id), 'DISCOVERY_EVIDENCE_FINGERPRINT_CONFLICT');
  check(assessment.evidence_fingerprint === p.expected_evidence_fingerprint, 'DISCOVERY_ASSESSMENT_FINGERPRINT_CONFLICT');
  check(p.decision !== 'approve' || assessment.decision === 'CANDIDATE', 'DISCOVERY_APPROVAL_REQUIRES_CANDIDATE');
  if (p.decision === 'approve') {
    check(assessment.result_revision === row.revision, 'DISCOVERY_ASSESSMENT_STALE');
    const state = fresh(service, row);
    check(state.fresh, `DISCOVERY_STALE:${state.reasons.join(',')}`);
  } else if (assessment.result_revision !== row.revision) {
    const stale = service.store.get("SELECT payload_json FROM events WHERE partner_id=? AND kind='discovery.situation.stale' AND json_extract(payload_json,'$.situation_id')=? ORDER BY id DESC LIMIT 1",
      service.config.partnerId, row.id);
    check(stale && parse(stale.payload_json).reason === 'TTL_EXPIRED', 'DISCOVERY_ASSESSMENT_STALE');
  }
  const updated = touch(service, row, p.decision === 'approve' ? 'CANDIDATE' : 'DISMISSED');
  service.store.run("UPDATE tasks SET status='done' WHERE id=?", task.id);
  record(service, p.decision === 'approve' ? 'discovery.review.approved' : 'discovery.review.rejected', {
    situation_id: row.id, assessment_id: String(assessmentRow.id), task_id: task.id,
    evidence_fingerprint: assessment.evidence_fingerprint });
  return { situation_id: row.id, task_id: task.id, status: updated.status, revision: updated.revision,
    executable: false, contact_permission: false, allowed_effects: [] };
}

function requireTransferAuthorBinding(service, situationRow, conversationId) {
  const evidence = evidenceRows(service, situationRow.id)[0];
  check(evidence, 'DISCOVERY_AUTHOR_BINDING_REQUIRED');
  const bindings = service.config.opportunity?.authorBindings;
  check(Array.isArray(bindings), 'DISCOVERY_AUTHOR_BINDING_REQUIRED');
  const valid = bindings.every(binding => binding && typeof binding === 'object'
    && Object.keys(binding).length === 3
    && typeof binding.source_id === 'string' && typeof binding.author_id === 'string'
    && typeof binding.conversation_id === 'string');
  const authorMatches = valid ? bindings.filter(binding => binding.source_id === evidence.source.source_id
    && binding.author_id === evidence.source.author_id) : [];
  check(valid && authorMatches.length === 1
    && authorMatches[0].conversation_id === conversationId, 'DISCOVERY_AUTHOR_BINDING_REQUIRED');
}

function transfer(service, p) {
  const limits = config(service);
  invalidateChangedOffers(service, limits.offerFingerprint, limits.purpose);
  fields(p, ['situation_id', 'conversation_id', 'inbound_message_id', 'basis']);
  const row = situation(service, p.situation_id), state = fresh(service, row);
  check(state.fresh, `DISCOVERY_STALE:${state.reasons.join(',')}`);
  check(row.status === 'CANDIDATE', 'DISCOVERY_REVIEW_REQUIRED');
  check(!row.transferred_engagement_id, 'DISCOVERY_ALREADY_TRANSFERRED');
  const approved = service.store.get("SELECT id,payload_json FROM events WHERE partner_id=? AND kind='discovery.review.approved' AND json_extract(payload_json,'$.situation_id')=? ORDER BY id DESC LIMIT 1",
    service.config.partnerId, row.id);
  check(approved, 'DISCOVERY_REVIEW_REQUIRED');
  const conversation = service.conversation(p.conversation_id), person = service.person(conversation.person_id);
  check(!person.suppressed && conversation.ownership === 'AI_OWNED', 'DISCOVERY_CONVERSATION_UNAVAILABLE');
  requireTransferAuthorBinding(service, row, conversation.id);
  const inbound = service.store.get("SELECT * FROM messages WHERE id=? AND conversation_id=? AND direction='in'",
    requiredText(p.inbound_message_id, 'inbound_message_id', 150), conversation.id);
  check(inbound, 'DISCOVERY_INBOUND_REQUIRED');
  service.engagement.resolvePermission(conversation.id, 'reply');
  const basis = requiredText(p.basis, 'transfer basis', 4000);
  const existing = service.engagement.current(conversation.id);
  const engagement = existing ? service.engagement.get(existing.id) : service.engagement.get(
    service.engagement.open({ conversation_id: conversation.id, topic: 'Вхідне звернення після Discovery',
      current_need: 'Уточнити актуальну потребу за реальним вхідним повідомленням.',
      unknowns: ['Discovery is background evidence, not consent or confirmed interest.'],
      close_condition: 'Потребу з вхідного повідомлення вирішено або людина відмовилася.' }, { kind: 'operator' }, false).engagement_id,
  );
  service.engagement.signal(engagement, 'inbound', { message_id: inbound.id });
  const updated = touch(service, row, 'TRANSFERRED');
  service.store.run('UPDATE discovery_situations SET transferred_engagement_id=? WHERE id=?', engagement.id, row.id);
  record(service, 'discovery.transferred', { situation_id: row.id, assessment_id: parse(approved.payload_json).assessment_id,
    conversation_id: conversation.id, inbound_message_id: inbound.id, engagement_id: engagement.id, basis,
    contact_permission_created: false, drafts_created: 0, sends_started: false });
  return { situation_id: row.id, status: updated.status, revision: updated.revision, engagement_id: engagement.id,
    contact_permission_created: false, drafts_created: 0, sends_started: false };
}

function detail(service, situationId) {
  const row = situation(service, situationId), evidence = evidenceRows(service, row.id);
  const state = fresh(service, row, null, evidence), fingerprint = evidenceFingerprint(service, row.id);
  const staleEvent = service.store.get("SELECT payload_json FROM events WHERE partner_id=? AND kind='discovery.situation.stale' AND json_extract(payload_json,'$.situation_id')=? ORDER BY id DESC LIMIT 1",
    service.config.partnerId, row.id);
  const assessments = service.store.all("SELECT id,created_at,payload_json FROM events WHERE partner_id=? AND kind='discovery.assessment' AND json_extract(payload_json,'$.situation_id')=? ORDER BY id",
    service.config.partnerId, row.id).map(event => ({ id: String(event.id), ...parse(event.payload_json) }));
  const lastTransition = lastReasonTransition(service, row.id);
  const logicalStatus = row.status === 'DISMISSED' && lastTransition?.decision === 'STOP'
    ? 'STOPPED' : row.status;
  for (const assessment of assessments) {
    const reasons = [...state.reasons];
    if (staleEvent) reasons.push(parse(staleEvent.payload_json).reason);
    if (assessment.evidence_fingerprint !== fingerprint) reasons.push('DISCOVERY_EVIDENCE_CHANGED');
    if (assessment.id !== assessments.at(-1).id) reasons.push('DISCOVERY_ASSESSMENT_SUPERSEDED');
    assessment.reasoning_version ??= 0;
    assessment.epistemic_status = 'unverified_proposal';
    // Applies to BOTH hypothesis and WHY NOW. Recomputed from durable source
    // state, never from a persisted model assertion or a command receipt.
    assessment.freshness = { fresh: reasons.length === 0, reasons: [...new Set(reasons)] };
    assessment.basis = { source_ref: row.source_ref, subject_ref: row.subject_ref, context_key: row.context_key,
      purpose: row.purpose, offer_fingerprint: row.offer_fingerprint,
      evidence_fingerprint: assessment.evidence_fingerprint, expires_at: row.expires_at,
      evidence: evidence.filter(item => assessment.evidence.includes(String(item.source_event_id))).map(item => ({
        source_event_id: String(item.source_event_id), message_id: item.message_id, message_version: item.message_version,
        author_id: item.source.author_id, observed_at: item.observed_at,
        created_at: item.source.created_at, updated_at: item.source.updated_at,
      })) };
  }
  const openingProposals = service.store.all("SELECT id,created_at,payload_json FROM events WHERE partner_id=? AND kind='discovery.opening_proposal' AND json_extract(payload_json,'$.situation_id')=? ORDER BY id",
    service.config.partnerId, row.id).map(event => ({ id: String(event.id), ...parse(event.payload_json) }));
  const reviewTasks = service.store.all("SELECT id,status,created_at FROM tasks WHERE partner_id=? AND kind='discovery_review' AND evidence IN (SELECT id FROM events WHERE partner_id=? AND kind='discovery.assessment' AND json_extract(payload_json,'$.situation_id')=?) ORDER BY created_at",
    service.config.partnerId, service.config.partnerId, row.id);
  return { ...row, status: logicalStatus, storage_status: row.status, evidence, assessments,
    opening_proposals: openingProposals, review_tasks: reviewTasks,
    evidence_fingerprint: fingerprint, freshness: state,
    executable: false, contact_permission: false, allowed_effects: [] };
}

const PRESENTATION_TEXT_LIMIT = 2000;
// Every bounded presentation string carries an explicit truncation flag next to it.
const boundedText = (value, name) => {
  const text = typeof value === 'string' ? value : '';
  return text.length > PRESENTATION_TEXT_LIMIT
    ? { [name]: text.slice(0, PRESENTATION_TEXT_LIMIT), [`${name}_truncated`]: true }
    : { [name]: text, [`${name}_truncated`]: false };
};
// An allowlisted view for presentation surfaces. The internal discoveryDetail() keeps the full
// durable projection; this one carries only what an operator may read, and says so where it cuts.
function presentationDetail(service, situationId, actor) {
  operator(actor);
  const row = detail(service, situationId);
  return {
    situation_id: row.id, status: row.status, storage_status: row.storage_status, revision: row.revision,
    evidence_fingerprint: row.evidence_fingerprint,
    basis: { source_ref: row.source_ref, subject_ref: row.subject_ref, context_key: row.context_key,
      purpose: row.purpose, expires_at: row.expires_at, created_at: row.created_at, updated_at: row.updated_at },
    freshness: { fresh: row.freshness.fresh, reasons: [...row.freshness.reasons] },
    evidence: row.evidence.map((item) => {
      return { source_event_id: String(item.source_event_id), message_id: item.message_id,
        message_version: item.message_version, author_id: item.source?.author_id ?? null,
        observed_at: item.observed_at, ...boundedText(item.source?.text, 'text') };
    }),
    assessments: row.assessments.map((assessment) => {
      const hypothesis = boundedText(typeof assessment.hypothesis === 'string'
        ? assessment.hypothesis : assessment.hypothesis?.text, 'text');
      const whyNow = boundedText(typeof assessment.why_now === 'string'
        ? assessment.why_now : assessment.why_now?.reason, 'reason');
      // A v0 assessment stored two plain strings. They are projected into the same shape without
      // inventing claims, inferences, or uncertainty that were never recorded.
      const legacy = assessment.reasoning_version === 0;
      return {
        id: assessment.id, created_at: assessment.created_at, decision: assessment.decision,
        epistemic_status: assessment.epistemic_status, reasoning_version: assessment.reasoning_version,
        hypothesis: { ...hypothesis,
          attributed_claims: (typeof assessment.hypothesis === 'string' ? [] : assessment.hypothesis?.attributed_claims ?? [])
            .map(claim => ({ source_event_id: claim.source_event_id, ...boundedText(claim.quote, 'quote') })),
          inferences: (typeof assessment.hypothesis === 'string' ? [] : assessment.hypothesis?.inferences ?? [])
            .map(inference => ({ ...boundedText(inference.text, 'text'), evidence_event_ids: inference.evidence_event_ids })),
          uncertainty: typeof assessment.hypothesis === 'string' ? [] : assessment.hypothesis?.uncertainty ?? [] },
        why_now: { ...whyNow,
          evidence_event_ids: typeof assessment.why_now === 'string' ? [] : assessment.why_now?.evidence_event_ids ?? [] },
        freshness: { fresh: assessment.freshness.fresh, reasons: [...assessment.freshness.reasons] },
        reasoning_shape: legacy ? 'legacy_v0_strings' : 'structured_v1',
        executable: false, contact_permission: false, allowed_effects: [] };
    }),
    opening_proposals: row.opening_proposals.map(proposal => ({ id: proposal.id, created_at: proposal.created_at,
      ...boundedText(proposal.text, 'text'), ...boundedText(proposal.rationale, 'rationale'),
      constraints: proposal.constraints ?? [], executable: false, contact_permission: false, sent: false })),
    review_tasks: row.review_tasks.map(task => ({ id: task.id, status: task.status, created_at: task.created_at })),
    executable: false, contact_permission: false, sent: false, allowed_effects: [] };
}

export function markDiscoveryPending(service, sourceEventId) {
  if (service.config.discovery?.enabled !== true) return false;
  return markPending(service, sourceEventId);
}

export function hasDiscoveryPending(service, sourceEventId) {
  return !!sourceMarker(service, String(sourceEventId), DISCOVERY_PENDING);
}

const RECONCILE_CURSOR_CHANNEL = 'discovery-reconcile-v1';
function readReconcileCursor(service) {
  const row = service.store.get('SELECT cursor FROM channel_offsets WHERE channel=? AND account_id=?',
    RECONCILE_CURSOR_CHANNEL, service.config.partnerId);
  if (!row) return null;
  try {
    const value = parse(row.cursor);
    return typeof value.source_ref === 'string' ? value.source_ref : null;
  } catch { return null; }
}
function writeReconcileCursor(service, sourceRef) {
  service.store.run(`INSERT INTO channel_offsets(channel,account_id,cursor) VALUES(?,?,?)
    ON CONFLICT(channel,account_id) DO UPDATE SET cursor=excluded.cursor`, RECONCILE_CURSOR_CHANNEL,
  service.config.partnerId, JSON.stringify({ source_ref: sourceRef }));
}

export function discoveryObserveSource(service, sourceEventId) {
  const source = sourceEvent(service, String(sourceEventId)).message;
  return observe(service, {
    source_event_id: String(sourceEventId),
    context_key: contextKeyForThread(source.thread_id),
    purpose: service.config.discovery.purpose,
  }, { kind: 'system' });
}

// Opens its own transaction. Call only outside an active Store transaction.
export function ensureDiscoveryApplied(service, sourceEventId) {
  const sourceId = String(sourceEventId);
  if (service.config.discovery?.enabled === true) staleMaterialEvidence(service);
  return service.store.transaction(() => {
    let applied = sourceMarker(service, sourceId, DISCOVERY_APPLIED);
    if (applied) return { status: 'already_applied', source_event_id: sourceId, application_event_id: String(applied.id) };
    const pending = sourceMarker(service, sourceId, DISCOVERY_PENDING);
    if (!pending) return { status: 'deferred', source_event_id: sourceId, reason: 'DISCOVERY_PENDING_MARKER_MISSING' };
    const limits = config(service), pendingBasis = parse(pending.payload_json);
    if (pendingBasis.offer_fingerprint !== limits.offerFingerprint || pendingBasis.purpose !== limits.purpose) {
      const applicationId = record(service, DISCOVERY_APPLIED, { source_event_id: sourceId,
        stage: 'source_projection', projection_status: 'configuration_changed' });
      return { status: 'applied', source_event_id: sourceId, application_event_id: applicationId,
        disposition: 'configuration_changed' };
    }
    const source = sourceEvent(service, sourceId).message;
    const current = currentSourceMessage(service, source.source_id, source.message_id);
    if (current && String(current.event_id) !== sourceId) {
      const applicationId = record(service, DISCOVERY_APPLIED, { source_event_id: sourceId,
        stage: 'source_projection', projection_status: 'source_superseded' });
      return { status: 'applied', source_event_id: sourceId, application_event_id: applicationId,
        disposition: 'source_superseded' };
    }
    const readiness = sourceAccessReadiness(service, source.source_id);
    if (readiness.reason === 'SOURCE_NOT_ALLOWED') {
      const applicationId = record(service, DISCOVERY_APPLIED, { source_event_id: sourceId,
        stage: 'source_projection', projection_status: 'source_revoked' });
      return { status: 'applied', source_event_id: sourceId, application_event_id: applicationId,
        disposition: 'source_revoked' };
    }
    if (!readiness.current) return { status: 'deferred', source_event_id: sourceId, reason: readiness.reason };
    if (source.operation === 'upsert' && (!source.author_id || source.author_id.startsWith('channel:'))) {
      const applicationId = record(service, DISCOVERY_APPLIED, { source_event_id: sourceId,
        stage: 'source_projection', projection_status: 'subject_unavailable' });
      return { status: 'applied', source_event_id: sourceId, application_event_id: applicationId,
        disposition: 'subject_unavailable' };
    }
    const projection = discoveryObserveSource(service, sourceId);
    const applicationId = record(service, DISCOVERY_APPLIED, { source_event_id: sourceId, stage: 'source_projection',
      projection_status: projection.status ?? projection.disposition ?? 'recorded' });
    return { status: 'applied', source_event_id: sourceId, application_event_id: applicationId,
      situation_id: projection.situation_id ?? null, disposition: projection.disposition ?? null,
      stale_situation_ids: projection.stale_situation_ids ?? [] };
  });
}

export function reconcileDiscoveryPending(service, limit = 50) {
  check(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'DISCOVERY_RECONCILE_LIMIT');
  const reserveNormalSlot = service.config.discovery?.enabled === true && limit > 1 ? 1 : 0;
  const maintained = invalidateRevokedDiscoverySources(service, limit - reserveNormalSlot);
  const budget = Math.max(0, limit - maintained);
  if (service.config.discovery?.enabled !== true || budget === 0) return { processed: 0, failed: 0, deferred: 0 };
  const sourceLimit = Math.min(1000, Math.max(limit * 4, limit));
  const sourceRefRows = (after, take, before = null) => {
    const predicates = [], params = [service.config.partnerId, DISCOVERY_PENDING, DISCOVERY_APPLIED];
    if (after !== null) { predicates.push('source_ref > ?'); params.push(after); }
    if (before !== null) { predicates.push('source_ref <= ?'); params.push(before); }
    params.push(take);
    const predicate = predicates.length ? `WHERE ${predicates.join(' AND ')}` : '';
    return service.store.all(`SELECT source_ref FROM (
        SELECT COALESCE(json_extract(s.payload_json,'$.source_id'),'') AS source_ref
        FROM events p
        JOIN events s ON s.partner_id=p.partner_id
          AND s.id=CAST(p.payload_json->>'$.source_event_id' AS INTEGER) AND s.kind='source.message'
        WHERE p.partner_id=? AND p.kind=?
          AND NOT EXISTS (SELECT 1 FROM events a WHERE a.partner_id=p.partner_id AND a.kind=?
            AND a.payload_json->>'$.source_event_id'=p.payload_json->>'$.source_event_id')
        GROUP BY COALESCE(json_extract(s.payload_json,'$.source_id'),'')
      ) AS grouped ${predicate} ORDER BY source_ref LIMIT ?`, ...params);
  };
  const cursor = readReconcileCursor(service);
  let sourceRefs = sourceRefRows(cursor, sourceLimit);
  if (cursor !== null && sourceRefs.length < sourceLimit) {
    sourceRefs = sourceRefs.concat(sourceRefRows(null, sourceLimit - sourceRefs.length, cursor));
  }
  writeReconcileCursor(service, sourceRefs.length
    ? String(sourceRefs[sourceRefs.length - 1].source_ref ?? '') : null);
  const queues = [];
  let deferred = 0;
  for (const refRow of sourceRefs) {
    const sourceRef = String(refRow.source_ref ?? '');
    const rows = service.store.all(`WITH pending AS (
        SELECT DISTINCT CAST(p.payload_json->>'$.source_event_id' AS INTEGER) AS source_event_id,
          p.partner_id, p.payload_json->>'$.source_event_id' AS source_event_id_text
        FROM events p
        JOIN events s ON s.partner_id=p.partner_id
          AND s.id=CAST(p.payload_json->>'$.source_event_id' AS INTEGER) AND s.kind='source.message'
        WHERE COALESCE(json_extract(s.payload_json,'$.source_id'),'')=?
          AND p.partner_id=? AND p.kind=?
          AND NOT EXISTS (SELECT 1 FROM events a WHERE a.partner_id=p.partner_id AND a.kind=?
            AND a.payload_json->>'$.source_event_id'=p.payload_json->>'$.source_event_id')
      )
      SELECT source_event_id FROM pending
      ORDER BY CASE WHEN EXISTS (
        SELECT 1 FROM events f WHERE f.partner_id=pending.partner_id AND f.kind=?
          AND f.payload_json->>'$.source_event_id'=pending.source_event_id_text
          AND f.payload_json->>'$.code'='DISCOVERY_OPEN_LIMIT'
      ) THEN 1 ELSE 0 END, source_event_id LIMIT ?`,
    sourceRef, service.config.partnerId, DISCOVERY_PENDING, DISCOVERY_APPLIED, DISCOVERY_FAILED, limit);
    const access = sourceAccessReadiness(service, sourceRef);
    if (!access.current && access.reason !== 'SOURCE_NOT_ALLOWED') { deferred += rows.length; continue; }
    if (access.reason === 'SOURCE_NOT_ALLOWED') continue;
    if (rows.length) queues.push({ rows, index: 0 });
  }
  let processed = 0, failed = 0, attempts = 0;
  while (attempts < budget) {
    let progressed = false;
    for (const queue of queues) {
      if (attempts >= budget || queue.index >= queue.rows.length) continue;
      const row = queue.rows[queue.index++];
      attempts++;
      try {
        const result = ensureDiscoveryApplied(service, String(row.source_event_id));
        if (result.status === 'deferred') deferred++;
        else processed++;
      } catch (error) {
        if (error.code === 'DISCOVERY_SOURCE_NOT_CURRENT') deferred++;
        else {
          try { service.store.transaction(() => recordDiscoveryFailure(service, row.source_event_id, error)); }
          catch { /* keep the pending marker recoverable if the audit database is unavailable */ }
          failed++;
        }
      }
      progressed = true;
    }
    if (!progressed) break;
  }
  return { processed, failed, deferred };
}

export function discoveryCommand(service, action, payload, actor) {
  if (action === 'discovery.observe') return observe(service, payload, actor);
  operator(actor);
  if (action === 'discovery.assess') return assessment(service, payload);
  if (action === 'discovery.reason') return reasonTransition(service, payload, actor);
  if (action === 'discovery.review') return review(service, payload, actor);
  return transfer(service, payload);
}

export { detail as discoveryDetail, reasonStates as discoveryReasonStates, presentationDetail as discoveryPresentationDetail };
