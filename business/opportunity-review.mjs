import { ensure, requiredText } from './errors.mjs';
import { opportunityDetail, OPPORTUNITY_TASK } from './opportunity-consumer.mjs';

export const REVIEW_ACTIONS = ['opportunity.review.edit', 'opportunity.review.approve', 'opportunity.review.reject'];
const kinds = REVIEW_ACTIONS.map(() => '?').join(',');
const check = (value, code) => ensure(value, `Opportunity review: ${code}`, 409, code);
function reviewEvents(service, taskId, fingerprint, limit = 100) {
  return service.store.all(`SELECT id,kind,actor,created_at,payload_json FROM events
    WHERE partner_id=? AND actor='operator' AND kind IN (${kinds})
    AND json_extract(payload_json,'$.task_id')=? AND json_extract(payload_json,'$.result.fingerprint')=?
    ORDER BY id DESC LIMIT ?`, service.config.partnerId, ...REVIEW_ACTIONS, taskId, fingerprint, limit)
    .map(e => ({ id: String(e.id), action: e.kind, actor: e.actor, created_at: e.created_at, ...JSON.parse(e.payload_json).result }));
}
export function opportunityReviewDetail(service, taskId) {
  const d = opportunityDetail(service, taskId), history = reviewEvents(service, taskId, d.fingerprint);
  const saved = history[0]?.review ?? { status: 'pending', revision: 0, draft_revision: 0,
    draft_text: d.output.next_action.draft?.text ?? null, approved_draft_revision: null, approved_fingerprint: null, reason: '' };
  const effectiveStatus = d.task.status === 'cancelled' ? 'cancelled'
    : saved.status === 'approved' && !d.freshness.fresh ? 'stale' : saved.status;
  const denials = service.store.all(`SELECT id,actor,created_at,payload_json FROM events
    WHERE partner_id=? AND kind='opportunity.review.denied' AND json_extract(payload_json,'$.task_id')=?
    ORDER BY id DESC LIMIT 30`, service.config.partnerId, taskId)
    .map(e => ({ id: String(e.id), actor: e.actor, created_at: e.created_at, ...JSON.parse(e.payload_json) }));
  return { ...d, review_contract_version: 'opportunity-review-v0',
    review: { ...saved, effective_status: effectiveStatus }, review_history: history, review_denials: denials };
}
// Human review is a typed extension, never a mutation of the frozen model output or an executable task.
export function reviewOpportunity(service, action, p) {
  check(REVIEW_ACTIONS.includes(action), 'INVALID_REVIEW_ACTION');
  const allowed = ['task_id', 'fingerprint', 'expected_revision', 'reason', ...(action.endsWith('.edit') ? ['text'] : [])];
  check(p && Object.keys(p).every(key => allowed.includes(key)), 'INVALID_REVIEW_FIELDS');
  check(typeof p.task_id === 'string' && p.task_id.length <= 100, 'INVALID_REVIEW_TASK');
  check(Number.isSafeInteger(p.expected_revision) && p.expected_revision >= 0, 'INVALID_REVIEW_REVISION');
  const d = opportunityReviewDetail(service, p.task_id), before = d.review;
  check(p.fingerprint === d.fingerprint, 'REVIEW_FINGERPRINT_MISMATCH');
  check(p.expected_revision === before.revision, 'REVIEW_REVISION_CONFLICT');
  check(d.task.status === 'proposed', 'REVIEW_TASK_UNAVAILABLE');
  check(p.reason === undefined || typeof p.reason === 'string' && p.reason.length <= 2000, 'INVALID_REVIEW_REASON');
  const review = { ...before, revision: before.revision + 1, reason: p.reason ?? '',
    approved_draft_revision: null, approved_fingerprint: null };
  delete review.effective_status;
  if (action.endsWith('.edit')) {
    check(d.output.next_action.draft !== null, 'REVIEW_HAS_NO_DRAFT');
    review.draft_text = requiredText(p.text, 'Review draft', 4096);
    review.draft_revision++;
    review.status = 'pending';
  } else if (action.endsWith('.approve')) {
    check(before.status === 'pending', 'REVIEW_ALREADY_DECIDED');
    check(d.freshness.fresh, 'STALE_REVIEW');
    check(!d.freshness.link || d.freshness.link.ownership === 'AI_OWNED', 'REVIEW_HUMAN_OWNED');
    review.status = 'approved';
    review.approved_draft_revision = review.draft_revision;
    review.approved_fingerprint = d.fingerprint;
  } else {
    check(before.status !== 'rejected', 'REVIEW_ALREADY_DECIDED');
    review.status = 'rejected';
  }
  return { review_contract_version: 'opportunity-review-v0', task_id: d.task.id, fingerprint: d.fingerprint, review, previous_status: before.status,
    ...(action.endsWith('.edit') ? { previous_text: before.draft_text } : {}),
    contact_permission: false, allowed_effects: [], executable: false };
}
export function opportunityReviews(service, { status = 'pending', limit = 50, offset = 0 } = {}) {
  check(['all', 'pending', 'approved', 'rejected', 'cancelled'].includes(status), 'INVALID_REVIEW_STATUS');
  check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100
    && Number.isSafeInteger(offset) && offset >= 0, 'INVALID_REVIEW_PAGE');
  const filter = `t.partner_id=? AND t.kind=? AND (?='all' OR
    CASE WHEN t.status='cancelled' THEN 'cancelled' ELSE COALESCE((
      SELECT json_extract(e.payload_json,'$.result.review.status') FROM events e
      WHERE e.partner_id=t.partner_id AND e.actor='operator' AND e.kind IN (${kinds})
      AND json_extract(e.payload_json,'$.task_id')=t.id ORDER BY e.id DESC LIMIT 1), 'pending') END=?)`;
  const params = [service.config.partnerId, OPPORTUNITY_TASK, status, ...REVIEW_ACTIONS, status];
  const total = service.store.get(`SELECT COUNT(*) AS n FROM tasks t WHERE ${filter}`, ...params).n;
  const rows = service.store.all(`SELECT t.id FROM tasks t WHERE ${filter} ORDER BY t.rowid DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
  const items = rows.map(t => {
    const d = opportunityReviewDetail(service, t.id), r = d.output.next_action;
    return { task_id: d.task.id, title: d.task.title, created_at: d.task.created_at, subject: d.subject,
      source_message: d.snapshot.messages.find(m => m.id === d.snapshot.anchor_message_id),
      decision: r.decision, summary: r.reason, target: r.draft?.target_id ?? d.subject.author_id,
      review: d.review, freshness: d.freshness };
  });
  return { items, total, status, limit, offset };
}
