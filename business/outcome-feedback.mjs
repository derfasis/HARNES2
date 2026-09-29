// The loop's return path: what actually happened after the partner acted.
//
// Everything above this line in the repository is the partner deciding and doing. None of it
// knows whether any of it mattered. `outcome_events` existed before this module and still is
// written in exactly one place — an operator typing into a form — which makes every rate
// derived from it a measure of the owner's diligence rather than of the partner's effect.
//
// This module changes what may be recorded automatically, and nothing about what may be
// *concluded*. A detector may say "a reply arrived". Only an operator or a trusted source may
// say "that reply was a booking". The gap between those two sentences is the layer.
import { id } from './store.mjs';
import { ensure, requiredText, now } from './errors.mjs';
import { digest } from './source-ingestion.mjs';
import { OUTCOME_KINDS } from './outcome-tables.mjs';

const outcomeCheck = (ok, code, status = 409) => ensure(ok, code, status, code);
const check = outcomeCheck;

// Bumped whenever a detector's rule changes, so a candidate always names the rule that produced
// it. A later version must not be able to explain an earlier claim away.
const DETECTOR_VERSION = 1;
const DETECTORS = ['reply_after_send', 'window_expired', 'owner_statement'];

// A reply is evidence that a reply happened. It is not evidence of a result, and the kinds below
// are deliberately the vocabulary of *observation*: none of them is a business outcome kind, so a
// candidate can never be promoted by matching on its own text.
const CANDIDATE_KINDS = new Set(['reply_observed', 'reaction_observed', 'no_response_observed',
  'engagement_closed', 'owner_booking_claimed', 'owner_outcome_stated']);

const fields = (p, keys) => check(p && typeof p === 'object' && !Array.isArray(p)
  && Object.keys(p).every(k => keys.includes(k)), 'OUTCOME_FIELDS_INVALID', 400);

export class OutcomeLoop {
  constructor(service) { this.service = service; this.db = service.store; }

  get partnerId() { return this.service.config.partnerId; }
  enabled() { check(this.service.config.outcomes?.enabled === true, 'OUTCOME_DISABLED'); }

  // A window opens when a message we sent goes out, and closes when someone answers or when the
  // patience runs out. Opening it is what makes "nobody replied" a recordable observation rather
  // than an absence we cannot see.
  observeSent(conversationId, messageId, deliveredAt = null) {
    // Gated here as well as at the scheduler. The scheduler only calls this pass when the feature
    // is on, but the call comes from the delivery path, and a caller that reaches it while the
    // layer is disabled must not be able to switch it on by writing a row. A layer that ships off
    // and records anyway is worse than one that ships off.
    if (this.service.config.outcomes?.enabled !== true) return null;
    const window = this.db.get('SELECT id,ownership FROM conversations WHERE id=?', conversationId);
    check(window, 'CONVERSATION_NOT_FOUND', 404);
    const existing = this.db.get('SELECT id FROM outcome_observation_windows WHERE partner_id=? AND message_id=?',
      this.partnerId, messageId);
    if (existing) return existing.id;
    const cfg = this.service.config.outcomes ?? {};
    const patience = Number.isInteger(cfg.responseWindowSeconds) ? cfg.responseWindowSeconds : 604800;
    // Measured from when the message actually went out, not from when this pass happened to notice.
    // A window that started counting from the notice would forgive a silence that began days
    // earlier, and after a restart the delay between the send and the first pass would silently
    // become patience the operator never granted.
    const id_ = id(), opened = deliveredAt ?? now();
    // The sent draft is recorded with the window, not looked up later: by the time a reply
    // arrives the mapping from reply back to the proposal that asked for it is the only thing
    // that makes attribution decidable, and it is not recoverable from the reply alone.
    const sent = this.db.get('SELECT draft_id FROM messages WHERE id=?', messageId);
    this.db.run(`INSERT INTO outcome_observation_windows(id,partner_id,conversation_id,message_id,draft_id,opened_at,closes_at,outcome,created_at)
      VALUES(?,?,?,?,?,?,?,'pending',?)`, id_, this.partnerId, conversationId, messageId, sent?.draft_id ?? null, opened,
    new Date(Date.parse(opened) + patience * 1000).toISOString(), opened);
    this.record('window_opened', { window_id: id_, conversation_id: conversationId, message_id: messageId });
    return id_;
  }

  // The candidate is the whole deliverable of an automatic pass. It is created only when the
  // durable unique key is free, so re-scanning the same evidence — after a restart, or on the next
  // tick, or because an operator re-ran a detector — is a no-op rather than a second claim.
  propose({ conversationId, kind, detector, basis, evidence, messageId = null, draftId = null, decisionId = null, windowId = null, observedAt = null }) {
    this.enabled();
    check(CANDIDATE_KINDS.has(kind), 'OUTCOME_CANDIDATE_KIND_INVALID', 400);
    check(DETECTORS.includes(detector), 'OUTCOME_DETECTOR_INVALID', 400);
    check(typeof basis === 'string' && basis.trim().length > 0 && basis.length <= 1000, 'OUTCOME_BASIS_REQUIRED', 400);
    check(evidence && typeof evidence === 'object' && !Array.isArray(evidence), 'OUTCOME_EVIDENCE_REQUIRED', 400);
    check(Buffer.byteLength(JSON.stringify(evidence)) <= 8000, 'OUTCOME_EVIDENCE_TOO_LARGE', 400);
    const at = observedAt ?? now();
    check(typeof at === 'string' && Number.isFinite(Date.parse(at)), 'OUTCOME_OBSERVED_AT_INVALID', 400);
    // Identity is the window when there is one. Two drafts can be outstanding in one conversation
    // and a single reply answers both, so keying on the message collapsed them into one candidate
    // carrying the first window's draft — the second proposal's provenance was simply gone. A
    // window is a question about one sent message, and it gets its own answer.
    const key = digest({ partner: this.partnerId, conversation: conversationId, detector, message: messageId, kind });
    const existing = windowId
      ? this.db.get("SELECT id,status FROM outcome_candidates WHERE partner_id=? AND detector=? AND kind=? AND json_extract(evidence_json,'$.window_id')=?", this.partnerId, detector, kind, windowId)
      : this.db.get('SELECT id,status FROM outcome_candidates WHERE partner_id=? AND conversation_id=? AND detector=? AND IFNULL(source_message_id,\'\')=? AND kind=?',
      this.partnerId, conversationId, detector, messageId ?? '', kind);
    if (existing) return { candidate_id: existing.id, duplicate: true, status: existing.status };
    const candidateId = id();
    this.db.run(`INSERT INTO outcome_candidates(id,partner_id,conversation_id,engagement_id,kind,detector,detector_version,
      basis,evidence_json,source_message_id,draft_id,decision_id,observed_at,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`, candidateId, this.partnerId, conversationId,
    this.engagementIdFor(conversationId), kind, detector, DETECTOR_VERSION, basis, JSON.stringify(evidence),
    messageId, draftId, decisionId, at, now(), now());
    void key;
    this.record('candidate_created', { candidate_id: candidateId, conversation_id: conversationId, kind, detector, observed_at: at });
    return { candidate_id: candidateId, duplicate: false };
  }

  engagementIdFor(conversationId) {
    return this.db.get('SELECT id FROM engagements WHERE conversation_id=? ORDER BY id DESC LIMIT 1', conversationId)?.id ?? null;
  }

  get(candidateId) {
    const row = this.db.get('SELECT * FROM outcome_candidates WHERE id=? AND partner_id=?', candidateId, this.partnerId);
    check(row, 'OUTCOME_CANDIDATE_NOT_FOUND', 404);
    return row;
  }

  // Bounded scan. Each pass looks at a fixed number of open windows, in a persistent round-robin,
  // so a long silence in one conversation cannot starve the rest — the same fairness rule the
  // source poller uses, for the same reason.
  reconcile({ now: at = Date.now(), limit = 20 } = {}) {
    return this.db.transaction(() => {
      // Ordered by when each window closes, not by a rotating cursor.
      //
      // A cursor that only advances past settled windows starves the tail: with twenty waiting
      // settleAnswered() first, then a bounded pass over what is still silent. A reply is a fact the
      // database can answer on its own and it costs one indexed lookup, so it is never rationed; a
      // silence that has run out is the part that needs a deadline to judge.
      const answered = this.settleAnswered(at);
      const rows = this.db.all(
        `SELECT * FROM outcome_observation_windows WHERE partner_id=? AND outcome='pending'
         ORDER BY closes_at, id LIMIT ?`, this.partnerId, limit);
      let expired = 0;
      for (const row of rows) if (this.closeWindow(row, at) === 'expired_unanswered') expired += 1;
      return { windows: answered + expired, answered, expired };
    });
  }

  // Every waiting window that has in fact been answered, settled in one bounded statement.
  //
  // `answered` is not a judgement that costs anything — it is "is there an inbound message after
  // this one" — so it must not sit behind a limit that is there for the other kind of work. When
  // both were rationed together, twenty silent conversations held the front of every pass and a
  // conversation someone had already replied to waited behind them indefinitely.
  settleAnswered(at = Date.now()) {
    const rows = this.db.all(
      `SELECT w.id, w.conversation_id, w.message_id, w.draft_id, w.opened_at, w.closes_at
         FROM outcome_observation_windows w
        WHERE w.partner_id=? AND w.outcome='pending'
          AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=w.conversation_id
                       AND m.direction='in' AND m.created_at>=? AND m.created_at<=?)
        ORDER BY w.closes_at, w.id`,
      this.partnerId, this.minOpenedAt(), new Date(at).toISOString());
    for (const row of rows) {
      // The reply has to be inside the window, not merely later than the send. A reply that
      // arrives after the patience ran out is a late reply, and counting it as an answer would
      // make the outcome of a window depend on whether the service happened to be running when
      // the window closed.
      const reply = this.db.get(
        `SELECT id, created_at FROM messages WHERE conversation_id=? AND direction='in'
           AND created_at>=? AND created_at<=? ORDER BY created_at LIMIT 1`,
        row.conversation_id, row.opened_at, this.windowClosesAt(row, at));
      if (!reply) continue;
      const candidate = this.propose({ conversationId: row.conversation_id, kind: 'reply_observed',
        detector: 'reply_after_send', basis: 'An inbound message arrived inside the observation window.',
        evidence: { window_id: row.id, sent_message_id: row.message_id, reply_message_id: reply.id, reply_at: reply.created_at },
        messageId: reply.id, draftId: row.draft_id ?? null, windowId: row.id, observedAt: reply.created_at });
      this.db.run("UPDATE outcome_observation_windows SET outcome='answered',answered_at=?,candidate_id=? WHERE id=?",
        reply.created_at, candidate.candidate_id, row.id);
      this.record('window_answered', { window_id: row.id, candidate_id: candidate.candidate_id });
    }
    return rows.length;
  }

  minOpenedAt() { return '1970-01-01T00:00:00.000Z'; }
  windowClosesAt(row, at = Date.now()) { return row.closes_at ?? new Date(at).toISOString(); }

  // Settling a silence. `answered` is already handled by settleAnswered, unbudgeted;
  // what is left is the one question that needs a deadline: has the patience run out.
  closeWindow(row, at = Date.now()) {
    if (row.outcome !== 'pending') return row.outcome;
    if (Date.parse(row.closes_at) > at) return 'pending';
    const candidate = this.propose({ conversationId: row.conversation_id, kind: 'no_response_observed',
      detector: 'window_expired', basis: 'The observation window closed with no inbound message.',
      evidence: { window_id: row.id, sent_message_id: row.message_id, opened_at: row.opened_at, closes_at: row.closes_at },
      messageId: row.message_id, draftId: row.draft_id ?? null, observedAt: row.closes_at });
    this.db.run("UPDATE outcome_observation_windows SET outcome='expired_unanswered',answered_at=?,candidate_id=? WHERE id=?",
      row.closes_at, candidate.candidate_id, row.id);
    this.record('window_expired', { window_id: row.id, candidate_id: candidate.candidate_id });
    return 'expired_unanswered';
  }

  // Resolution is the operator's. A candidate is promoted to a real outcome here, with the same
  // record the manual path has always written — so history does not fork into "recorded by hand"
  // and "recorded by detection", and every existing consumer of `outcome_events` keeps working.
  confirm(candidateId, { kind, evidence, value = null, decisionId = null, note = null }, actor) {
    this.enabled();
    check(actor?.kind === 'operator', 'OUTCOME_OPERATOR_REQUIRED', 403);
    fields({ kind, evidence, value, decisionId, note }, ['kind', 'evidence', 'value', 'decisionId', 'note']);
    const row = this.get(candidateId);
    check(row.status === 'pending', 'OUTCOME_CANDIDATE_RESOLVED');
    check(OUTCOME_KINDS.includes(kind), 'OUTCOME_KIND_INVALID', 400);
    const text = requiredText(evidence, 'evidence', 2000);
    const conversation = this.db.get('SELECT person_id FROM conversations WHERE id=?', row.conversation_id);
    check(conversation, 'CONVERSATION_NOT_FOUND', 404);
    const decision = decisionId ?? row.decision_id ?? null;
    if (decision) {
      const owned = this.db.get('SELECT id FROM engagement_decisions WHERE id=? AND engagement_id IN (SELECT id FROM engagements WHERE conversation_id=?)',
        decision, row.conversation_id);
      check(owned, 'OUTCOME_DECISION_NOT_IN_CONVERSATION', 400);
    }
    // The canonical path, not a second writer. A promotion that inserted the row itself would
    // skip the stage change, the ownership handover on a join or decline, the cancellation of work
    // the result just made pointless, and the engagement signal — so a confirmed `joined` would
    // leave the partner still treating the conversation as live.
    const recorded = this.service.recordOutcome(row.conversation_id, {
      kind, evidence: text, value, source_message_id: row.source_message_id, draft_id: row.draft_id,
      decision_id: decision });
    const outcomeId = recorded.outcome_id;
    void conversation;
    // The association and its attribution are written by `engagement.outcome`, which is the only
    // place that decides them. Reading the row back — rather than restating a guess here — is what
    // stops the API from reporting `observed_association` for an outcome the database recorded as
    // `human_assisted`, which is precisely the case a caller would want to be told about.
    const attribution = decision
      ? this.db.get('SELECT attribution FROM decision_outcomes WHERE outcome_id=?', outcomeId)?.attribution ?? null
      : null;
    this.db.run("UPDATE outcome_candidates SET status='confirmed',outcome_id=?,resolution_note=?,updated_at=?,revision=revision+1 WHERE id=?",
      outcomeId, note, now(), candidateId);
    this.record('candidate_confirmed', { candidate_id: candidateId, outcome_id: outcomeId, kind, decision_id: decision });
    return { outcome_id: outcomeId, candidate_id: candidateId, association: attribution, causal_credit: 'not_established' };
  }

  reject(candidateId, { note, note_kind = null }, actor) {
    this.enabled();
    check(actor?.kind === 'operator', 'OUTCOME_OPERATOR_REQUIRED', 403);
    fields({ note, note_kind }, ['note', 'note_kind']);
    const row = this.get(candidateId);
    check(row.status === 'pending', 'OUTCOME_CANDIDATE_RESOLVED');
    // A rejection is a real answer too: the owner looked and the observation does not become an
    // outcome. Recording that is what stops the same candidate being re-proposed forever.
    this.db.run("UPDATE outcome_candidates SET status='rejected',resolution_note=?,updated_at=?,revision=revision+1 WHERE id=?",
      note_kind ? `${note_kind}: ${requiredText(note, 'note', 1000)}` : requiredText(note, 'note', 1000), now(), candidateId);
    this.record('candidate_rejected', { candidate_id: candidateId, note_kind });
    return { candidate_id: candidateId, status: 'rejected' };
  }

  detail(candidateId) {
    const row = this.get(candidateId);
    return { ...row, evidence: JSON.parse(row.evidence_json), conversation_open: this.db.get('SELECT 1 x FROM conversations WHERE id=?', row.conversation_id) !== undefined };
  }

  list({ status = 'pending', limit = 20, cursor = '' } = {}) {
    check(Number.isInteger(limit) && limit > 0 && limit <= 50 && typeof cursor === 'string' && cursor.length <= 36,
      'OUTCOME_PAGE_INVALID', 400);
    check(['pending', 'confirmed', 'rejected', 'superseded', 'unknown', 'all'].includes(status), 'OUTCOME_STATUS_INVALID', 400);
    const where = status === 'all' ? '' : 'AND status=?';
    const rows = this.db.all(`SELECT id,conversation_id,kind,detector,basis,observed_at,status FROM outcome_candidates
      WHERE partner_id=? ${where} AND id>? ORDER BY id LIMIT ?`, this.partnerId, ...(status === 'all' ? [] : [status]), cursor, limit + 1);
    return { items: rows.slice(0, limit), next_cursor: rows.length > limit ? rows[limit - 1].id : null };
  }

  // The metric the layer is for: not how many outcomes there are, but how many conversations never
  // produced one. Without the denominator a rate improves when nobody records anything.
  coverage() {
    const windows = this.db.get(`SELECT COUNT(*) n FROM outcome_observation_windows WHERE partner_id=?`, this.partnerId).n;
    const by = (o) => this.db.get('SELECT COUNT(*) n FROM outcome_observation_windows WHERE partner_id=? AND outcome=?',
      this.partnerId, o).n;
    const confirmed = this.db.get("SELECT COUNT(*) n FROM outcome_candidates WHERE partner_id=? AND status='confirmed'", this.partnerId).n;
    const rejected = this.db.get("SELECT COUNT(*) n FROM outcome_candidates WHERE partner_id=? AND status='rejected'", this.partnerId).n;
    const pending = this.db.get("SELECT COUNT(*) n FROM outcome_candidates WHERE partner_id=? AND status='pending'", this.partnerId).n;
    const outcomes = this.db.get('SELECT COUNT(*) n FROM outcome_events WHERE person_id IN (SELECT person_id FROM conversations WHERE id IN (SELECT conversation_id FROM outcome_observation_windows WHERE partner_id=?))', this.partnerId).n;
    // "Unknown" is what is left once answered, unanswered, confirmed, rejected and still-open are
    // counted. It is reported as a number, not as a caveat in a comment.
    const accounted = by('answered') + by('expired_unanswered') + by('superseded');
    return { windows, answered: by('answered'), expired_unanswered: by('expired_unanswered'),
      pending_windows: by('pending'), confirmed_candidates: confirmed, rejected_candidates: rejected,
      pending_candidates: pending, outcomes,
      unknown_windows: Math.max(0, windows - accounted),
      causal_credit: 'not_established',
      scope: 'Observation coverage over delivered messages. A window is unknown when no candidate was ever proposed for it.' };
  }

  record(kind, payload, actor = 'system') { this.db.event(this.partnerId, null, `outcome.${kind}`, actor, payload); }
}

const CURSOR = 'outcome-feedback-v1';

// The command surface. Narrow on purpose: an operator may confirm, reject or look. There is no
// command that promotes a candidate without a person, and no command that lets anyone — including
// the model — write an outcome directly.
export function outcomeCommand(service, action, p, actor) {
  const loop = service.outcomes;
  if (action === 'outcome.candidate_confirm') return loop.confirm(p.candidate_id, p, actor);
  if (action === 'outcome.candidate_reject') return loop.reject(p.candidate_id, p, actor);
  if (action === 'outcome.candidate_list') return { ...loop.list(p ?? {}), coverage: loop.coverage() };
  throw new Error(`Unknown outcome command: ${action}`);
}
