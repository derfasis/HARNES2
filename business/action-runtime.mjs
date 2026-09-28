import { id } from './store.mjs';
import { now, AppError } from './errors.mjs';
import { actionCheck as check } from './actions.mjs';
import { LocalActionCapabilities } from './action-capabilities.mjs';

// Ownership is shared by every runtime attached to the same service. Durable
// attempt/grant CAS protects the dispatch boundary across independent workers.
const owners = new WeakSet();
const lostReceipts = new WeakMap();
const CURSOR = 'action-execution-v1';
const retired = status => ['revoked','rejected','stale'].includes(status);
export class ActionRuntime {
  constructor(service, { ready = () => true, capabilities = new LocalActionCapabilities(service) } = {}) {
    this.service = service; this.capabilities = capabilities; this.ready = ready; this.busy = false; this.stopped = false;
    if (!lostReceipts.has(service)) lostReceipts.set(service, new Map());
  }
  stop() { this.stopped = true; }
  prepare() {
    const a = this.service.actions, db = this.service.store;
    // Only attempts whose owning call has actually returned are eligible here.
    // A storage outage may have prevented even the fallback unknown write.
    for (const [attemptId, actionId] of lostReceipts.get(this.service)) {
      const attempt = db.get('SELECT status FROM action_attempts WHERE id=?', attemptId);
      if (attempt?.status === 'dispatching') {
        db.run("UPDATE action_attempts SET status='unknown',finished_at=? WHERE id=?", now(), attemptId);
        const row = a.get(actionId); a.update(row, { status: retired(row.status) ? row.status : 'unknown', verify_requested: 1 });
        a.record('recovered_unknown', { action_id: actionId, attempt_id: attemptId, reason: 'RECEIPT_PERSIST_FAILED' });
      }
      // Keep the entry until after the enclosing transaction commits (tick).
    }
    const rows = a.page(CURSOR, "verify_requested=1 OR status IN ('authorized','verifying')", 20);
    for (const row of rows) {
      a.advance(CURSOR, row);
      const attempt = a.latest(row);
      // Never diagnose another live dispatch as orphaned here.
      if (attempt?.status === 'dispatching') continue;
      if ((row.verify_requested || row.status === 'verifying') && attempt && attempt.status !== 'prepared') return { row, attempt, mode: 'verify' };
      if (row.status !== 'authorized' || !this.ready() || this.service.config.actions?.enabled !== true) continue;
      const grant = db.get("SELECT * FROM action_grants WHERE action_id=? AND status='active'", row.id);
      try { a.assertGrant(row, grant); }
      catch (e) { if (!(e instanceof AppError)) throw e; a.retire(row, 'stale', e.code); continue; }
      let prepared = db.get('SELECT * FROM action_attempts WHERE grant_id=?', grant.id);
      if (!prepared) {
        const attemptId = id();
        db.run("INSERT INTO action_attempts(id,action_id,grant_id,status,created_at) VALUES(?,?,?,'prepared',?)", attemptId, row.id, grant.id, now());
        prepared = db.get('SELECT * FROM action_attempts WHERE id=?', attemptId);
        a.record('prepared', { action_id: row.id, attempt_id: attemptId, grant_id: grant.id });
      }
      if (prepared.status === 'prepared') return { row, attempt: prepared, grant, mode: 'execute' };
    }
    return null;
  }
  assertDispatch(work) {
    const a = this.service.actions, row = a.get(work.row.id), db = this.service.store;
    check(!this.stopped && this.ready(), 'ACTION_RUNTIME_NOT_READY'); a.current(row, { enabled: true });
    const grant = db.get('SELECT * FROM action_grants WHERE id=?', work.attempt.grant_id);
    check(row.status === 'authorized' && grant.status === 'consumed' && Date.parse(grant.expires_at) > Date.now()
      && grant.proposal_hash === row.proposal_hash && grant.authority_hash === row.authority_hash && grant.basis_fingerprint === row.basis_fingerprint
      && db.get('SELECT status FROM action_attempts WHERE id=?', work.attempt.id)?.status === 'dispatching', 'ACTION_GRANT_UNAVAILABLE');
    check(row.proposal_hash === a.proposalHash(row, a.checkedProposal(JSON.parse(row.proposal_json))), 'ACTION_PROPOSAL_CHANGED');
  }
  async tick() {
    if (this.stopped || owners.has(this.service)) return { disposition: 'busy_or_stopped' };
    owners.add(this.service); this.busy = true;
    const db = this.service.store, a = this.service.actions;
    try {
      const work = await this.service.exclusive(() => db.transaction(() => this.prepare()));
      lostReceipts.get(this.service).clear();
      if (!work) return { disposition: 'idle' };
      if (work.mode === 'verify') {
        let verification;
        try { verification = await this.capabilities.verify(work.row); }
        catch { verification = { state: 'unavailable', reason: 'VERIFIER_FAILED' }; }
        if (!['present','absent','mismatch','unavailable'].includes(verification?.state)) verification = { state: 'unavailable', reason: 'VERIFIER_INVALID' };
        await this.service.exclusive(() => db.transaction(() => {
          const row = a.get(work.row.id);
          db.run('UPDATE action_attempts SET verification_state=?,verification_json=?,verified_at=? WHERE id=?', verification.state, JSON.stringify(verification), now(), work.attempt.id);
          const status = retired(row.status) ? row.status : verification.state === 'present' ? 'completed' : verification.state === 'absent' ? 'failed' : 'unknown';
          const latestGrant = db.get('SELECT id FROM action_grants WHERE action_id=? ORDER BY version DESC LIMIT 1', row.id);
          // A historical probe may finish after another operator command. It may
          // append its observation, never take ownership of a newer grant.
          if (latestGrant?.id === work.attempt.grant_id) a.update(row, { status, verify_requested: 0 });
          a.record('verified', { action_id: row.id, attempt_id: work.attempt.id, verification, business_outcome: 'not_verified' });
        }));
        return { disposition: 'verified', action_id: work.row.id, verification_state: verification.state };
      }
      const dispatch = await this.service.exclusive(() => db.transaction(() => {
        const row = a.get(work.row.id), grant = db.get('SELECT * FROM action_grants WHERE id=?', work.grant.id);
        // Another process may already have claimed this prepared attempt.
        if (db.get('SELECT status FROM action_attempts WHERE id=?', work.attempt.id)?.status !== 'prepared') return false;
        if (this.stopped || !this.ready()) return false; // Hold prepared work; a busy pass is not revocation.
        try { a.assertGrant(row, grant); }
        catch (e) { if (!(e instanceof AppError)) throw e; a.retire(row, 'stale', e.code); return false; }
        db.run("UPDATE action_grants SET status='consumed',updated_at=? WHERE id=?", now(), grant.id);
        db.run("UPDATE action_attempts SET status='dispatching' WHERE id=?", work.attempt.id);
        a.record('dispatching', { action_id: row.id, attempt_id: work.attempt.id, grant_id: grant.id }); return true;
      }));
      if (!dispatch) return { disposition: 'withheld' };
      let receipt, succeeded = false;
      try {
        const result = await this.capabilities.execute(work.row, work.attempt, () => this.assertDispatch(work));
        receipt = { ...result, action_id: work.row.id, attempt_id: work.attempt.id, grant_id: work.grant.id, proposal_hash: work.row.proposal_hash }; succeeded = true;
      } catch { receipt = { outcome: 'unknown', reason: 'EXECUTION_NOT_PROVEN', action_id: work.row.id, attempt_id: work.attempt.id, grant_id: work.grant.id }; }
      try {
        await this.service.exclusive(() => db.transaction(() => {
          const row = a.get(work.row.id);
          db.run('UPDATE action_attempts SET status=?,receipt_json=?,finished_at=? WHERE id=?', succeeded ? 'returned' : 'unknown', JSON.stringify(receipt), now(), work.attempt.id);
          a.update(row, { status: retired(row.status) ? row.status : succeeded ? 'verifying' : 'unknown', verify_requested: 1 });
          a.record('receipt', { action_id: row.id, attempt_id: work.attempt.id, receipt });
        }));
      } catch (error) {
        // This worker has returned, so its dispatch is now an orphan. If the DB is
        // unavailable too, startup recovery makes exactly this transition later.
        lostReceipts.get(this.service).set(work.attempt.id, work.row.id);
        await this.service.exclusive(() => db.transaction(() => {
          db.run("UPDATE action_attempts SET status='unknown',finished_at=? WHERE id=? AND status='dispatching'", now(), work.attempt.id);
          const row = a.get(work.row.id); a.update(row, { status: retired(row.status) ? row.status : 'unknown', verify_requested: 1 });
        }));
        lostReceipts.get(this.service).delete(work.attempt.id);
        throw error;
      }
      return { disposition: succeeded ? 'receipt_recorded' : 'unknown', action_id: work.row.id };
    } finally { owners.delete(this.service); this.busy = false; }
  }
}
