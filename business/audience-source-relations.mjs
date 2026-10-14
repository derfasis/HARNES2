// Attach only topology copied from the immutable normalized source event.
import { AppError } from './errors.mjs';
import { sourceEvent, digest } from './source-ingestion.mjs';

const invalid = () => { throw new AppError('AUDIENCE_RECORD_INVALID', 409, 'AUDIENCE_RECORD_INVALID'); };

function relation(service, sourceRef, eventId, messageId, version, expectedMessage = null, authorId = undefined) {
  let event;
  try { event = sourceEvent(service, eventId); }
  catch { return invalid(); }
  const message = event.message;
  if (message.source_id !== sourceRef || message.message_id !== messageId || message.version !== version
    || authorId !== undefined && message.author_id !== authorId
    || expectedMessage && digest(message) !== digest(expectedMessage)) return invalid();
  return { thread_id: message.thread_id, reply_to_id: message.reply_to_id };
}

export function annotateAudienceEvidence(service, sourceRef, evidence) {
  if (!Array.isArray(evidence) || evidence.length > 32) return invalid();
  return evidence.map(item => {
    if (!item || item.source_ref !== sourceRef || typeof item.source_event_id !== 'string'
      || typeof item.message_id !== 'string' || !Number.isInteger(item.message_version)) return invalid();
    return { ...item, ...relation(service, sourceRef, item.source_event_id, item.message_id,
      item.message_version, null, item.author_id) };
  });
}

export function structuralAudienceRelations(service, sourceRef, rows, currentEventIds) {
  if (!Array.isArray(rows) || rows.length > 32 || !Array.isArray(currentEventIds)) return invalid();
  const current = new Set(currentEventIds);
  return rows.map(row => {
    const message = row?.message;
    if (!row || !message || current.has(row.event_id) || message.source_id !== sourceRef
      || typeof message.message_id !== 'string' || !Number.isInteger(message.version)) return invalid();
    const edge = relation(service, sourceRef, row.event_id, message.message_id, message.version, message);
    return { source_event_id: row.event_id, source_ref: sourceRef, message_id: message.message_id,
      message_version: message.version, ...edge, structural_only: true };
  });
}
