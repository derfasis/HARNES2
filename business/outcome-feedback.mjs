// Deterministic observation, separate from an operator's business conclusion.
import { id, hash } from './store.mjs';
import { AppError, ensure, requiredText, dateTime, now } from './errors.mjs';
import { OUTCOME_KINDS } from './outcome-tables.mjs';

const VERSION = 2;
const CURSOR = 'outcome-observation-v2';
const check = (ok, code, status = 409) => ensure(ok, code, status, code);
const fields = (p, keys) => check(p && typeof p === 'object' && !Array.isArray(p)
  && Object.keys(p).every(k => keys.includes(k)), 'OUTCOME_FIELDS_INVALID', 400);
const timestamp = row => row.occurred_at ?? row.created_at;

export class OutcomeLoop {
  constructor(service) { this.service = service; this.db = service.store; }
  get partnerId() { return this.service.config.partnerId; }
  enabled() { check(this.service.config.outcomes?.enabled === true, 'OUTCOME_DISABLED'); }
  record(kind, payload, actor = 'system') {
    const cid = payload.conversation_id ?? (payload.window_id ? this.db.get('SELECT conversation_id FROM outcome_observation_windows WHERE id=? AND partner_id=?',
      payload.window_id, this.partnerId)?.conversation_id : null);
    this.db.event(this.partnerId, cid ?? null, `outcome.${kind}`, actor, payload);
  }
  ownedMessage(cid, mid, direction) {
    this.service.conversation(cid);
    const message = this.db.get('SELECT * FROM messages WHERE id=? AND conversation_id=? AND direction=?', mid, cid, direction);
    check(message, 'OUTCOME_MESSAGE_SCOPE_INVALID');
    return message;
  }
  // Captured with canonical delivery in its transaction, before the optional observer.
  deliveryIntent(cid, mid) {
    if (this.service.config.outcomes?.enabled !== true) return null;
    const sent = this.ownedMessage(cid, mid, 'out');
    const opened = timestamp(sent);
    check(typeof opened === 'string' && Number.isFinite(Date.parse(opened)), 'OUTCOME_DELIVERY_TIME_INVALID');
    const closes = new Date(Date.parse(opened) + (this.service.config.outcomes.responseWindowSeconds ?? 604800) * 1000).toISOString();
    this.record('delivery_observed', { conversation_id: cid, message_id: mid, opened_at: opened, closes_at: closes });
    return { opened_at: opened, closes_at: closes };
  }
  observeSent(cid, mid, deliveredAt = null, coverage = 'unverified', deadline = null) {
    if (!this.db.db.isTransaction) return this.db.transaction(() => this.observeSent(cid, mid, deliveredAt, coverage, deadline));
    if (this.service.config.outcomes?.enabled !== true) return null;
    check(coverage === 'unverified', 'OUTCOME_COVERAGE_PROOF_REQUIRED');
    const sent = this.ownedMessage(cid, mid, 'out');
    const opened = timestamp(sent);
    check(deliveredAt === null || dateTime(deliveredAt) === dateTime(opened), 'OUTCOME_DELIVERY_TIME_MISMATCH');
    check(typeof opened === 'string' && Number.isFinite(Date.parse(opened)), 'OUTCOME_DELIVERY_TIME_INVALID');
    const existing = this.db.get('SELECT id FROM outcome_observation_windows WHERE partner_id=? AND message_id=?', this.partnerId, mid);
    if (existing) return existing.id;
    const draft = sent.draft_id ? this.service.draft(sent.draft_id) : null;
    if (draft) check(draft.conversation_id === cid && draft.status === 'sent', 'OUTCOME_DELIVERY_NOT_CONFIRMED');
    const action = draft ? this.db.get('SELECT * FROM engagement_actions WHERE draft_id=?', draft.id) : null;
    const decision = action ? this.service.engagement.decision(action.decision_id) : null;
    const engagement = decision ? this.service.engagement.get(decision.engagement_id) : null;
    check(!engagement || engagement.partner_id === this.partnerId && engagement.conversation_id === cid, 'OUTCOME_PROVENANCE_SCOPE_INVALID');
    const attempt = draft ? this.db.get("SELECT * FROM delivery_attempts WHERE draft_id=? AND status='sent' ORDER BY created_at DESC,rowid DESC LIMIT 1", draft.id) : null;
    const version = attempt?.draft_version ?? draft?.current_version ?? null;
    if (draft) {
      check(attempt && this.db.get('SELECT text FROM draft_versions WHERE draft_id=? AND version=?', draft.id, version)?.text === sent.text,
        'OUTCOME_DELIVERY_PROVENANCE_INVALID');
    }
    const wid = id(), closes = deadline === null
      ? new Date(Date.parse(opened) + (this.service.config.outcomes.responseWindowSeconds ?? 604800) * 1000).toISOString() : dateTime(deadline);
    check(Date.parse(closes) > Date.parse(opened), 'OUTCOME_WINDOW_TIME_INVALID');
    this.db.run(`INSERT INTO outcome_observation_windows(id,partner_id,conversation_id,message_id,draft_id,draft_version,decision_id,engagement_id,delivery_attempt_id,
      opened_at,closes_at,time_basis,coverage,outcome,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'unverified','pending',?)`,
      wid, this.partnerId, cid, mid, draft?.id ?? null, version, decision?.id ?? null, engagement?.id ?? null, attempt?.id ?? null,
      opened, closes, sent.time_basis, now());
    this.record('window_opened', { window_id: wid, conversation_id: cid, message_id: mid, time_basis: sent.time_basis });
    return wid;
  }
  cursor() {
    const empty = { window: '', delivery: 0, review: '' };
    try {
      const value = JSON.parse(this.db.get('SELECT cursor FROM channel_offsets WHERE channel=? AND account_id=?', CURSOR, this.partnerId)?.cursor ?? '{}');
      check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => ['window','delivery','review'].includes(k)), 'OUTCOME_CURSOR_INVALID');
      const cursor = { ...empty, ...value }, uuid = /^(?:|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;
      check(typeof cursor.window === 'string' && uuid.test(cursor.window) && typeof cursor.review === 'string' && uuid.test(cursor.review)
        && Number.isSafeInteger(cursor.delivery) && cursor.delivery >= 0
        && cursor.delivery <= (this.db.get("SELECT COALESCE(MAX(id),0) id FROM events WHERE partner_id=? AND kind='outcome.delivery_observed'", this.partnerId).id),
      'OUTCOME_CURSOR_INVALID');
      return cursor;
    } catch (error) {
      if (!(error instanceof AppError) && !(error instanceof SyntaxError)) throw error;
      this.record('cursor_reset', { reason: error.code ?? 'INVALID_JSON' });
      return empty;
    }
  }
  saveCursor(value) {
    this.db.run('INSERT INTO channel_offsets(channel,account_id,cursor) VALUES(?,?,?) ON CONFLICT(channel,account_id) DO UPDATE SET cursor=excluded.cursor',
      CURSOR, this.partnerId, JSON.stringify(value));
  }
  recoverDeliveries(limit, cursor) {
    const rows = this.db.all("SELECT id,payload_json FROM events WHERE partner_id=? AND kind='outcome.delivery_observed' AND id>? ORDER BY id LIMIT ?",
      this.partnerId, cursor.delivery, limit);
    for (const event of rows) {
      this.db.db.exec('SAVEPOINT outcome_intent');
      try {
        const p = JSON.parse(event.payload_json);
        check(p && typeof p.conversation_id === 'string' && typeof p.message_id === 'string'
          && typeof p.opened_at === 'string' && typeof p.closes_at === 'string', 'OUTCOME_INTENT_INVALID');
        this.observeSent(p.conversation_id, p.message_id, p.opened_at, 'unverified', p.closes_at);
        this.db.db.exec('RELEASE outcome_intent');
      } catch (error) {
        this.db.db.exec('ROLLBACK TO outcome_intent'); this.db.db.exec('RELEASE outcome_intent');
        if (!(error instanceof AppError) && !(error instanceof SyntaxError)) throw error;
        this.record('delivery_quarantined', { delivery_event_id: event.id, reason: error.code ?? 'INVALID_JSON' });
      }
      cursor.delivery = event.id;
    }
    return rows.length;
  }
  reply(window, at) {
    check(Number.isFinite(Date.parse(window.opened_at)) && Number.isFinite(Date.parse(window.closes_at))
      && Date.parse(window.closes_at) > Date.parse(window.opened_at), 'OUTCOME_WINDOW_TIME_INVALID');
    const upper = new Date(Math.min(Date.parse(window.closes_at), at)).toISOString();
    // For equal source/recorded timestamps, an already durable pre-send inbound is
    // not a reply. Provider precision alone cannot establish ordering.
    return this.db.get(`SELECT * FROM messages WHERE conversation_id=? AND direction='in'
      AND COALESCE(occurred_at,created_at)>=? AND COALESCE(occurred_at,created_at)<=?
      AND (COALESCE(occurred_at,created_at)>? OR rowid>(SELECT rowid FROM messages WHERE id=?))
      AND NOT(time_basis='source' AND ?='source' AND occurred_at=?)
      ORDER BY COALESCE(occurred_at,created_at),rowid LIMIT 1`, window.conversation_id, window.opened_at, upper, window.opened_at, window.message_id, window.time_basis, window.opened_at);
  }
  ambiguousTiming(window) {
    return window.time_basis === 'source' && !!this.db.get("SELECT id FROM messages WHERE conversation_id=? AND direction='in' AND time_basis='source' AND occurred_at=? LIMIT 1",
      window.conversation_id, window.opened_at);
  }
  coverageProof(window) {
    if (window.coverage !== 'continuous' || !window.coverage_event_id) return null;
    const event = this.db.get("SELECT * FROM events WHERE id=? AND partner_id=? AND kind='outcome.coverage_attested' AND actor='operator'",
      window.coverage_event_id, this.partnerId);
    if (!event) return null;
    let p; try { p = JSON.parse(event.payload_json); } catch { return null; }
    if (!p || typeof p !== 'object' || Array.isArray(p) || event.conversation_id !== window.conversation_id
      || p.proof_level !== 'owner_attested_interval' || typeof p.evidence !== 'string' || !p.evidence.trim()
      || typeof p.covered_from !== 'string' || typeof p.covered_through !== 'string'
      || !Number.isFinite(Date.parse(p.covered_from)) || !Number.isFinite(Date.parse(p.covered_through))) return null;
    return p.window_id === window.id && Date.parse(p.covered_from) <= Date.parse(window.opened_at)
      && Date.parse(p.covered_through) >= Date.parse(window.closes_at) && Date.parse(p.covered_through) <= Date.now() ? event : null;
  }
  attest(p, actor) {
    if (!this.db.db.isTransaction) return this.db.transaction(() => this.attest(p, actor));
    this.enabled(); check(actor?.kind === 'operator', 'OUTCOME_OPERATOR_REQUIRED', 403);
    fields(p, ['window_id','covered_from','covered_through','evidence','expected_coverage_event_id']);
    const window = this.db.get('SELECT * FROM outcome_observation_windows WHERE id=? AND partner_id=?', p.window_id, this.partnerId);
    check(window, 'OUTCOME_WINDOW_NOT_FOUND', 404); this.service.conversation(window.conversation_id);
    check(['pending','unknown'].includes(window.outcome), 'OUTCOME_WINDOW_RESOLVED');
    check((p.expected_coverage_event_id ?? null) === window.coverage_event_id, 'OUTCOME_COVERAGE_REVIEW_STALE');
    const from = dateTime(p.covered_from), through = dateTime(p.covered_through), evidence = requiredText(p.evidence, 'evidence', 2000);
    check(Date.parse(from) <= Date.parse(window.opened_at) && Date.parse(through) >= Date.parse(window.closes_at)
      && Date.parse(through) <= Date.now(), 'OUTCOME_COVERAGE_INTERVAL_INVALID', 400);
    this.record('coverage_attested', { window_id: window.id, covered_from: from, covered_through: through, evidence,
      proof_level: 'owner_attested_interval' }, 'operator');
    const eventId = this.db.get('SELECT last_insert_rowid() id').id;
    this.db.run("UPDATE outcome_observation_windows SET coverage='continuous',coverage_event_id=?,outcome='pending' WHERE id=?", eventId, window.id);
    return { window_id: window.id, coverage_event_id: eventId, proof_level: 'owner_attested_interval' };
  }
  revokeCoverage(p, actor) {
    if (!this.db.db.isTransaction) return this.db.transaction(() => this.revokeCoverage(p, actor));
    this.enabled(); check(actor?.kind === 'operator', 'OUTCOME_OPERATOR_REQUIRED', 403);
    fields(p, ['window_id','evidence','expected_coverage_event_id']);
    const window = this.db.get('SELECT * FROM outcome_observation_windows WHERE id=? AND partner_id=?', p.window_id, this.partnerId);
    check(window, 'OUTCOME_WINDOW_NOT_FOUND', 404); this.service.conversation(window.conversation_id);
    check(window.coverage_event_id !== null && p.expected_coverage_event_id === window.coverage_event_id, 'OUTCOME_COVERAGE_REVIEW_STALE');
    const evidence = requiredText(p.evidence, 'evidence', 2000);
    this.db.run("UPDATE outcome_candidates SET status='superseded',resolution_note='COVERAGE_REVOKED',updated_at=?,revision=revision+1 WHERE window_id=? AND kind='no_response_observed' AND status='pending'", now(), window.id);
    this.db.run("UPDATE outcome_observation_windows SET coverage='gapped',coverage_event_id=NULL,outcome=CASE WHEN outcome='expired_unanswered' THEN 'unknown' ELSE outcome END WHERE id=?", window.id);
    this.record('coverage_revoked', { window_id: window.id, previous_coverage_event_id: window.coverage_event_id, evidence }, 'operator');
    return { window_id: window.id, coverage: 'gapped' };
  }
  fingerprint(window, message, kind, evidence, basis, observedAt) {
    const { outcome, answered_at, candidate_id, coverage, coverage_event_id, ...windowBasis } = window;
    const sent = this.db.get('SELECT * FROM messages WHERE id=?', window.message_id);
    const version = window.draft_id ? this.db.get('SELECT * FROM draft_versions WHERE draft_id=? AND version=?', window.draft_id, window.draft_version) : null;
    const attempt = window.delivery_attempt_id ? this.db.get('SELECT * FROM delivery_attempts WHERE id=?', window.delivery_attempt_id) : null;
    const action = window.draft_id ? this.db.get('SELECT * FROM engagement_actions WHERE draft_id=?', window.draft_id) : null;
    const decision = window.decision_id ? this.db.get('SELECT * FROM engagement_decisions WHERE id=?', window.decision_id) : null;
    const { status: decisionStatus, ...immutableDecision } = decision ?? {};
    const proof = kind === 'no_response_observed' ? this.coverageProof(window) : null;
    return hash(JSON.stringify({ window: windowBasis, message, sent, version, attempt, action, decision: immutableDecision, kind, evidence, basisText: basis, observedAt,
      ...(kind === 'no_response_observed' ? { coverage, coverage_event_id, proof } : {}) }));
  }
  propose({ conversationId, kind, detector, basis, evidence, messageId = null, draftId = null, decisionId = null, windowId = null, observedAt = null }) {
    if (!this.db.db.isTransaction) return this.db.transaction(() => this.propose({ conversationId, kind, detector, basis, evidence, messageId, draftId, decisionId, windowId, observedAt }));
    this.enabled();
    check(kind === 'reply_observed' && detector === 'reply_after_send' || kind === 'no_response_observed' && detector === 'window_expired',
      'OUTCOME_DETECTOR_INVALID', 400);
    requiredText(basis, 'basis', 1000);
    check(evidence && typeof evidence === 'object' && !Array.isArray(evidence) && Buffer.byteLength(JSON.stringify(evidence)) <= 8000,
      'OUTCOME_EVIDENCE_REQUIRED', 400);
    const window = this.db.get('SELECT * FROM outcome_observation_windows WHERE id=? AND partner_id=?', windowId, this.partnerId);
    check(window && window.conversation_id === conversationId, 'OUTCOME_WINDOW_SCOPE_INVALID');
    const sent = this.ownedMessage(conversationId, window.message_id, 'out');
    const message = this.ownedMessage(conversationId, messageId, kind === 'reply_observed' ? 'in' : 'out');
    check(window.draft_id === draftId && window.decision_id === decisionId, 'OUTCOME_PROVENANCE_SCOPE_INVALID');
    check(evidence.window_id === window.id && evidence.sent_message_id === sent.id, 'OUTCOME_EVIDENCE_SCOPE_INVALID');
    const at = dateTime(observedAt);
    if (kind === 'reply_observed') {
      check(evidence.reply_message_id === message.id && evidence.reply_at === timestamp(message) && at === timestamp(message)
        && Date.parse(at) >= Date.parse(window.opened_at) && Date.parse(at) <= Math.min(Date.parse(window.closes_at), Date.now()),
        'OUTCOME_REPLY_TIME_INVALID');
    } else {
      check(message.id === sent.id && at === window.closes_at && Date.parse(at) <= Date.now() && this.coverageProof(window)
        && !this.reply(window, Date.now()) && !this.ambiguousTiming(window), 'OUTCOME_COVERAGE_PROOF_REQUIRED');
    }
    const fingerprint = this.fingerprint(window, message, kind, evidence, basis, at);
    const existing = this.db.get('SELECT id,status FROM outcome_candidates WHERE partner_id=? AND window_id=? AND detector=? AND detector_version=? AND kind=? AND basis_fingerprint=?',
      this.partnerId, window.id, detector, VERSION, kind, fingerprint);
    if (existing) return { candidate_id: existing.id, duplicate: true, status: existing.status };
    const cid = id();
    this.db.run(`INSERT INTO outcome_candidates(id,partner_id,conversation_id,engagement_id,kind,detector,detector_version,basis,evidence_json,
      source_message_id,draft_id,decision_id,window_id,draft_version,basis_fingerprint,observed_at,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`, cid, this.partnerId, conversationId, window.engagement_id, kind, detector, VERSION,
      basis, JSON.stringify(evidence), message.id, window.draft_id, window.decision_id, window.id, window.draft_version,
      fingerprint, at, now(), now());
    this.record('candidate_created', { candidate_id: cid, conversation_id: conversationId, kind, detector, detector_version: VERSION });
    return { candidate_id: cid, duplicate: false };
  }
  reconcile({ now: at = Date.now(), limit = 20 } = {}) {
    if (this.service.config.outcomes?.enabled !== true) return { disabled: true };
    check(Number.isFinite(at) && Number.isFinite(new Date(at).getTime()) && Number.isInteger(limit) && limit >= 1 && limit <= 100, 'OUTCOME_RECONCILE_INVALID', 400);
    return this.db.transaction(() => {
      const cursor = this.cursor(), recovered = this.recoverDeliveries(limit, cursor);
      const select = (after, before, count) => this.db.all(`SELECT * FROM outcome_observation_windows
        WHERE partner_id=? AND outcome IN ('pending','unknown','expired_unanswered') AND id>? AND id<=? ORDER BY id LIMIT ?`, this.partnerId, after, before, count);
      const prior = cursor.window;
      const rows = select(prior, '~', limit);
      if (rows.length < limit && prior) rows.push(...select('', prior, limit - rows.length));
      let answered = 0, expired = 0, unknown = 0;
      for (const window of rows) {
        this.db.db.exec('SAVEPOINT outcome_window');
        try {
        this.service.conversation(window.conversation_id);
        const reply = this.reply(window, at);
        if (reply) {
          if (window.candidate_id) {
            this.db.run("UPDATE outcome_candidates SET status='superseded',resolution_note='LATE_POSITIVE_EVIDENCE',updated_at=?,revision=revision+1 WHERE id=? AND status='pending'", now(), window.candidate_id);
            this.record('observation_corrected', { window_id: window.id, previous_candidate_id: window.candidate_id, reason: 'LATE_POSITIVE_EVIDENCE' });
          }
          const result = this.propose({ conversationId: window.conversation_id, kind: 'reply_observed', detector: 'reply_after_send',
            basis: 'An inbound message was observed within this delivered message’s interval; association is not causation.',
            evidence: { window_id: window.id, sent_message_id: window.message_id, reply_message_id: reply.id, reply_at: timestamp(reply),
              timing_basis: window.time_basis === 'source' && reply.time_basis === 'source' ? 'source_timestamps' : 'recorded_or_owner_attested' },
            messageId: reply.id, draftId: window.draft_id, decisionId: window.decision_id, windowId: window.id, observedAt: timestamp(reply) });
          this.db.run("UPDATE outcome_observation_windows SET outcome='answered',answered_at=?,candidate_id=? WHERE id=?", timestamp(reply), result.candidate_id, window.id);
          this.record('window_answered', { window_id: window.id, candidate_id: result.candidate_id }); answered++;
        } else if (window.outcome === 'pending' && Date.parse(window.closes_at) <= at) {
          if (this.coverageProof(window) && !this.ambiguousTiming(window)) {
            const result = this.propose({ conversationId: window.conversation_id, kind: 'no_response_observed', detector: 'window_expired',
              basis: 'No inbound evidence was recorded during an interval explicitly attested by the owner.',
              evidence: { window_id: window.id, sent_message_id: window.message_id, opened_at: window.opened_at, closes_at: window.closes_at,
                coverage_event_id: window.coverage_event_id, proof_level: 'owner_attested_interval' },
              messageId: window.message_id, draftId: window.draft_id, decisionId: window.decision_id, windowId: window.id, observedAt: window.closes_at });
            this.db.run("UPDATE outcome_observation_windows SET outcome='expired_unanswered',candidate_id=? WHERE id=?", result.candidate_id, window.id);
            this.record('window_expired', { window_id: window.id, candidate_id: result.candidate_id }); expired++;
          } else {
            this.db.run("UPDATE outcome_observation_windows SET outcome='unknown' WHERE id=?", window.id);
            this.record('window_unknown', { window_id: window.id, reason: this.ambiguousTiming(window) ? 'TIMING_AMBIGUOUS' : 'COVERAGE_UNVERIFIED' }); unknown++;
          }
        }
        this.db.db.exec('RELEASE outcome_window');
        } catch (error) {
          this.db.db.exec('ROLLBACK TO outcome_window'); this.db.db.exec('RELEASE outcome_window');
          if (!(error instanceof AppError) && !(error instanceof SyntaxError)) throw error;
          this.db.run("UPDATE outcome_observation_windows SET outcome='superseded' WHERE id=?", window.id);
          this.db.run("UPDATE outcome_candidates SET status='superseded',resolution_note='PROVENANCE_INVALID',updated_at=?,revision=revision+1 WHERE window_id=? AND status='pending'", now(), window.id);
          this.record('window_quarantined', { window_id: window.id, reason: error.code ?? 'INVALID_JSON' });
        }
        cursor.window = window.id; // Advance even if waiting or unknown; survive restart.
      }
      const reviewRows = this.db.all("SELECT * FROM outcome_candidates WHERE partner_id=? AND status='pending' AND id>? ORDER BY id LIMIT ?", this.partnerId, cursor.review, limit);
      if (!reviewRows.length && cursor.review) cursor.review = '';
      for (const candidate of reviewRows) {
        if (!this.fresh(candidate)) {
          this.db.run("UPDATE outcome_candidates SET status='superseded',resolution_note='EVIDENCE_STALE',revision=revision+1,updated_at=? WHERE id=? AND status='pending'", now(), candidate.id);
          this.db.run("UPDATE outcome_observation_windows SET outcome='unknown',candidate_id=NULL WHERE id=? AND candidate_id=?", candidate.window_id, candidate.id);
          this.record('candidate_stale', { candidate_id: candidate.id });
        }
        cursor.review = candidate.id;
      }
      this.saveCursor(cursor);
      return { scanned: rows.length, recovered, windows: answered + expired + unknown, answered, expired, unknown, unverified: unknown };
    });
  }
  get(cid) {
    const row = this.db.get(`SELECT oc.* FROM outcome_candidates oc JOIN conversations c ON c.id=oc.conversation_id
      JOIN persons p ON p.id=c.person_id WHERE oc.id=? AND oc.partner_id=? AND p.partner_id=oc.partner_id`, cid, this.partnerId);
    check(row, 'OUTCOME_CANDIDATE_NOT_FOUND', 404); return row;
  }
  fresh(row) {
    if (row.detector_version !== VERSION || !row.window_id || !row.basis_fingerprint) return false;
    const window = this.db.get('SELECT * FROM outcome_observation_windows WHERE id=? AND partner_id=?', row.window_id, this.partnerId);
    const message = this.db.get('SELECT * FROM messages WHERE id=? AND conversation_id=?', row.source_message_id, row.conversation_id);
    if (!window || !message || window.candidate_id !== row.id || window.conversation_id !== row.conversation_id
      || window.draft_id !== row.draft_id || window.decision_id !== row.decision_id
      || window.draft_version !== row.draft_version || window.engagement_id !== row.engagement_id
      || (row.kind === 'reply_observed' ? row.detector !== 'reply_after_send' : row.kind !== 'no_response_observed' || row.detector !== 'window_expired')
      || this.fingerprint(window, message, row.kind, JSON.parse(row.evidence_json), row.basis, row.observed_at) !== row.basis_fingerprint) return false;
    if (window.draft_id) {
      const draft = this.db.get('SELECT * FROM drafts WHERE id=? AND conversation_id=?', window.draft_id, row.conversation_id);
      const sent = this.db.get("SELECT * FROM messages WHERE id=? AND conversation_id=? AND direction='out'", window.message_id, row.conversation_id);
      const attempt = this.db.get("SELECT * FROM delivery_attempts WHERE id=? AND draft_id=? AND draft_version=? AND status='sent'", window.delivery_attempt_id, window.draft_id, window.draft_version);
      if (!draft || draft.status !== 'sent' || draft.current_version !== window.draft_version || !sent || !attempt
        || this.db.get('SELECT text FROM draft_versions WHERE draft_id=? AND version=?', draft.id, window.draft_version)?.text !== sent.text) return false;
    }
    if (row.kind === 'no_response_observed' && (!this.coverageProof(window) || this.reply(window, Date.now()) || this.ambiguousTiming(window))) return false;
    return true;
  }
  confirm(cid, p, actor) {
    if (!this.db.db.isTransaction) return this.db.transaction(() => this.confirm(cid, p, actor));
    this.enabled(); check(actor?.kind === 'operator', 'OUTCOME_OPERATOR_REQUIRED', 403);
    fields(p, ['candidate_id','kind','evidence','value','decisionId','note','expected_revision','outcome_id']);
    const row = this.get(cid);
    check(row.status === 'pending', 'OUTCOME_CANDIDATE_RESOLVED');
    check(p.expected_revision === row.revision, 'OUTCOME_REVIEW_STALE');
    check(this.fresh(row), 'OUTCOME_EVIDENCE_STALE');
    check(OUTCOME_KINDS.includes(p.kind), 'OUTCOME_KIND_INVALID', 400);
    check(p.decisionId === undefined || p.decisionId === null || p.decisionId === row.decision_id, 'OUTCOME_DECISION_MISMATCH');
    const note = p.note == null ? null : requiredText(p.note, 'note', 1000);
    const evidence = requiredText(p.evidence, 'evidence', 2000);
    let result;
    if (p.outcome_id) {
      const existing = this.db.get('SELECT * FROM outcome_events WHERE id=? AND conversation_id=?', p.outcome_id, row.conversation_id);
      this.service.conversation(row.conversation_id);
      check(existing && existing.kind === p.kind && (p.value == null || p.value === existing.value), 'OUTCOME_LINK_SCOPE_INVALID');
      result = { outcome_id: existing.id };
    } else {
      check(!this.db.get('SELECT id FROM outcome_events WHERE conversation_id=? AND source_message_id=? AND kind=?',
        row.conversation_id, row.source_message_id, p.kind), 'OUTCOME_EXISTING_RESULT_REQUIRES_LINK');
      result = this.service.recordOutcome(row.conversation_id, { kind: p.kind, evidence, value: p.value ?? null,
        source_message_id: row.source_message_id, draft_id: row.draft_id, decision_id: row.decision_id });
    }
    const association = this.db.get('SELECT * FROM decision_outcomes WHERE outcome_id=?', result.outcome_id);
    this.db.run("UPDATE outcome_candidates SET status='confirmed',outcome_id=?,resolution_note=?,updated_at=?,revision=revision+1 WHERE id=?", result.outcome_id, note, now(), cid);
    this.record('candidate_confirmed', { candidate_id: cid, conversation_id: row.conversation_id, outcome_id: result.outcome_id, kind: p.kind,
      decision_id: association?.decision_id ?? null, candidate_decision_id: row.decision_id, evidence, linked_existing: !!p.outcome_id }, 'operator');
    return { outcome_id: result.outcome_id, candidate_id: cid, decision_id: association?.decision_id ?? null,
      candidate_decision_id: row.decision_id, outcome_decision_id: association?.decision_id ?? null,
      association: association?.attribution ?? null, causal_credit: 'not_established' };
  }
  reject(cid, p, actor) {
    if (!this.db.db.isTransaction) return this.db.transaction(() => this.reject(cid, p, actor));
    this.enabled(); check(actor?.kind === 'operator', 'OUTCOME_OPERATOR_REQUIRED', 403);
    fields(p, ['candidate_id','note','note_kind','expected_revision']);
    const row = this.get(cid); check(row.status === 'pending', 'OUTCOME_CANDIDATE_RESOLVED');
    check(p.expected_revision === row.revision, 'OUTCOME_REVIEW_STALE');
    const note = requiredText(p.note, 'note', 1000), noteKind = p.note_kind == null ? null : requiredText(p.note_kind, 'note_kind', 100);
    this.db.run("UPDATE outcome_candidates SET status='rejected',resolution_note=?,updated_at=?,revision=revision+1 WHERE id=?", noteKind ? `${noteKind}: ${note}` : note, now(), cid);
    this.record('candidate_rejected', { candidate_id: cid, note_kind: noteKind }, 'operator');
    return { candidate_id: cid, status: 'rejected' };
  }
  detail(cid) {
    const row = this.get(cid);
    const association = row.outcome_id ? this.db.get('SELECT d.* FROM decision_outcomes d JOIN outcome_events o ON o.id=d.outcome_id WHERE o.id=? AND o.conversation_id=?', row.outcome_id, row.conversation_id) : null;
    return { ...row, evidence: JSON.parse(row.evidence_json), evidence_current: this.fresh(row), conversation_open: true,
      review_enabled: this.service.config.outcomes?.enabled === true, candidate_decision_id: row.decision_id,
      actual_outcome_decision_id: association?.decision_id ?? null, outcome_decision_id: association?.decision_id ?? null,
      association: association?.attribution ?? null,
      window: row.window_id ? this.db.get('SELECT * FROM outcome_observation_windows WHERE id=? AND partner_id=?', row.window_id, this.partnerId) : null };
  }
  list({ status = 'pending', limit = 20, cursor = '' } = {}) {
    check(Number.isInteger(limit) && limit > 0 && limit <= 50 && typeof cursor === 'string' && cursor.length <= 36, 'OUTCOME_PAGE_INVALID', 400);
    check(['pending','confirmed','rejected','superseded','unknown','all'].includes(status), 'OUTCOME_STATUS_INVALID', 400);
    const rows = this.db.all(`SELECT oc.id,oc.conversation_id,oc.kind,oc.detector,oc.detector_version,oc.revision,oc.basis,oc.observed_at,oc.status FROM outcome_candidates oc
      JOIN conversations c ON c.id=oc.conversation_id JOIN persons p ON p.id=c.person_id
      WHERE oc.partner_id=? AND p.partner_id=oc.partner_id ${status === 'all' ? '' : 'AND oc.status=?'} AND oc.id>? ORDER BY oc.id LIMIT ?`,
      this.partnerId, ...(status === 'all' ? [] : [status]), cursor, limit + 1);
    return { items: rows.slice(0, limit), next_cursor: rows.length > limit ? rows[limit - 1].id : null };
  }
  coverage() {
    const counts = Object.fromEntries(this.db.all('SELECT outcome,COUNT(*) n FROM outcome_observation_windows WHERE partner_id=? GROUP BY outcome', this.partnerId).map(r => [r.outcome,r.n]));
    const states = Object.fromEntries(this.db.all('SELECT status,COUNT(*) n FROM outcome_candidates WHERE partner_id=? GROUP BY status', this.partnerId).map(r => [r.status,r.n]));
    const outcomes = this.db.get("SELECT COUNT(DISTINCT outcome_id) n FROM outcome_candidates WHERE partner_id=? AND status='confirmed'", this.partnerId).n;
    const unknownDelivery = this.db.get(`SELECT COUNT(*) n FROM drafts d JOIN conversations c ON c.id=d.conversation_id
      JOIN persons p ON p.id=c.person_id WHERE p.partner_id=? AND d.status IN ('sending','delivery_unknown')`, this.partnerId).n;
    const eligible = this.db.get(`SELECT COUNT(*) n FROM (
      SELECT json_extract(payload_json,'$.message_id') mid FROM events WHERE partner_id=? AND kind='outcome.delivery_observed'
      UNION SELECT message_id mid FROM outcome_observation_windows WHERE partner_id=?)`, this.partnerId, this.partnerId).n;
    const unobserved = this.db.get(`SELECT COUNT(DISTINCT json_extract(e.payload_json,'$.message_id')) n FROM events e
      WHERE e.partner_id=? AND e.kind='outcome.delivery_observed' AND NOT EXISTS(SELECT 1 FROM outcome_observation_windows w
      WHERE w.partner_id=e.partner_id AND w.message_id=json_extract(e.payload_json,'$.message_id'))`, this.partnerId).n;
    return { windows: Object.values(counts).reduce((a,b) => a+b, 0), answered: counts.answered ?? 0,
      expired_unanswered: counts.expired_unanswered ?? 0, pending_windows: counts.pending ?? 0, superseded_windows: counts.superseded ?? 0,
      unknown_windows: (counts.pending ?? 0) + (counts.unknown ?? 0),
      unverified_windows: this.db.get("SELECT COUNT(*) n FROM outcome_observation_windows WHERE partner_id=? AND outcome IN ('pending','unknown') AND coverage!='continuous'", this.partnerId).n,
      confirmed_candidates: states.confirmed ?? 0, rejected_candidates: states.rejected ?? 0, pending_candidates: states.pending ?? 0,
      outcomes, eligible_deliveries: eligible, not_observed_deliveries: unobserved, unknown_delivery_messages: unknownDelivery,
      causal_credit: 'not_established', scope: 'Window lifecycle counts; outcomes are distinct confirmed results linked to these observations. Unknown delivery is separate.' };
  }
}

export function outcomeCommand(service, action, p, actor) {
  const loop = service.outcomes;
  if (action === 'outcome.candidate_confirm') return loop.confirm(p.candidate_id, p, actor);
  if (action === 'outcome.candidate_reject') return loop.reject(p.candidate_id, p, actor);
  if (action === 'outcome.coverage_attest') return loop.attest(p, actor);
  if (action === 'outcome.coverage_revoke') return loop.revokeCoverage(p, actor);
  if (action === 'outcome.candidate_list') return { ...loop.list(p), coverage: loop.coverage() };
  throw new Error(`Unknown outcome command: ${action}`);
}
