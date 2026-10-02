// Headless operation admission. A resource ticket cannot authorize an effect.
// Reuse Node AsyncLocalStorage and the existing SQLite/run ledger; no second job engine.
import { AsyncLocalStorage } from 'node:async_hooks';
import { id } from './store.mjs';
import { ensure, now, AppError } from './errors.mjs';
import { ACTION_CAPABILITIES } from './actions.mjs';
const check = (ok, code) => ensure(ok, code, 409, code);
const PLANES = ['public','private','work'];
export { validateControl } from './control-policy.mjs';
export class ControlPlane {
  constructor(service) { this.service = service; this.db = service.store; this.ownerId = id(); this.scope = new AsyncLocalStorage(); this.stopped = false; this.processOwned = false; }
  get enabled() { return this.service.config.controlPlane?.enabled === true; }
  get ttl() { return (this.service.config.runtime.timeoutSeconds + 60) * 1000; }
  expiry() { return new Date(Date.now() + this.ttl).toISOString(); }
  ownerExpiry() { return new Date(Date.now() + 30000).toISOString(); }
  alive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return true;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
  }
  acquireProcess() {
    this.db.transaction(() => {
      const old = this.db.get('SELECT * FROM control_owners WHERE partner_id=?', this.service.config.partnerId);
      // Lease expiry makes the owner unable to act; it does not prove that its process stopped.
      // A successor may take over only after the PID is known dead (or this is the same owner).
      check(!old || old.owner_id === this.ownerId || !this.alive(old.pid), 'CONTROL_PROCESS_ALREADY_OWNED');
      // Disabling CP in a second launch must not permit recovery against a live owner's DB.
      if (!this.enabled) {
        if (old) this.db.run('DELETE FROM control_owners WHERE partner_id=? AND owner_id=?', this.service.config.partnerId, old.owner_id);
        return;
      }
      this.db.run('INSERT INTO control_owners VALUES(?,?,?,?) ON CONFLICT(partner_id) DO UPDATE SET owner_id=excluded.owner_id,pid=excluded.pid,expires_at=excluded.expires_at', this.service.config.partnerId, this.ownerId, process.pid, this.ownerExpiry());
    }); this.processOwned = this.enabled;
  }
  heartbeat() {
    if (!this.enabled || !this.processOwned || this.stopped) return;
    const changed = this.db.run('UPDATE control_owners SET expires_at=? WHERE partner_id=? AND owner_id=? AND expires_at>?', this.ownerExpiry(), this.service.config.partnerId, this.ownerId, now());
    if (!changed.changes) { this.stopped = true; throw new AppError('CONTROL_PROCESS_OWNERSHIP_LOST', 409, 'CONTROL_PROCESS_OWNERSHIP_LOST'); }
  }
  processCurrent() {
    const row = this.db.get('SELECT * FROM control_owners WHERE partner_id=?', this.service.config.partnerId);
    if (!this.processOwned && !row) return true;
    return row?.owner_id === this.ownerId && Date.parse(row.expires_at) > Date.now();
  }
  sweep() {
    if (!this.enabled) return;
    this.db.run("UPDATE control_tickets SET status='expired',reason='LEASE_EXPIRED',finished_at=? WHERE partner_id=? AND status IN ('reserved','running') AND expires_at<=?", now(), this.service.config.partnerId, now());
  }
  reserve(plane, operation) {
    check(this.enabled && !this.stopped && this.processCurrent(), 'CONTROL_NOT_READY'); check(PLANES.includes(plane), 'CONTROL_PLANE_INVALID');
    const cfg = this.service.config, c = cfg.controlPlane; this.sweep();
    const active = this.db.all("SELECT * FROM control_tickets WHERE partner_id=? AND status IN ('reserved','running')", cfg.partnerId);
    // Private conversation reasoning retains a slot even when public/material work is hot.
    const nonPrivate = active.filter(t => t.plane !== 'private').length;
    check(!active.some(t => t.plane === plane) && active.length < c.maxConcurrent && (plane === 'private' || nonPrivate < c.maxConcurrent - 1), 'CONTROL_CAPACITY');
    const spent = this.db.get(`SELECT COUNT(*) n,COALESCE(SUM(estimated_cost_usd),0) cost,
      SUM(CASE WHEN cost_status='unknown' AND status NOT IN ('running','analyzed') THEN 1 ELSE 0 END) unknown FROM runs WHERE partner_id=? AND created_at>=?`, cfg.partnerId, now().slice(0,10));
    const pendingCount = active.filter(t => !t.run_id).length;
    check(spent.n + pendingCount < cfg.runtime.maxRunsPerDay, 'CONTROL_RUN_BUDGET');
    const reserved = active.reduce((a,t) => a + t.reserved_usd, 0);
    check(cfg.runtime.dailyBudgetUsd === null || !spent.unknown && spent.cost + reserved + c.reservationUsd <= cfg.runtime.dailyBudgetUsd, 'CONTROL_COST_BUDGET');
    // Unowned running/unknown cost cannot be excused by a ticket in a different process.
    const unowned = this.db.get(`SELECT r.id FROM runs r WHERE r.partner_id=? AND r.created_at>=? AND r.cost_status='unknown'
      AND NOT EXISTS(SELECT 1 FROM control_tickets t WHERE t.run_id=r.id AND t.status IN ('reserved','running')) LIMIT 1`, cfg.partnerId, now().slice(0,10));
    check(cfg.runtime.dailyBudgetUsd === null || !unowned, 'CONTROL_UNKNOWN_COST');
    const ticketId = id(); this.db.run("INSERT INTO control_tickets(id,partner_id,plane,operation,owner_id,status,reserved_usd,expires_at,created_at) VALUES(?,?,?,?,?,'reserved',?,?,?)", ticketId, cfg.partnerId, plane, operation, this.ownerId, c.reservationUsd, this.expiry(), now());
    return this.db.get('SELECT * FROM control_tickets WHERE id=?', ticketId);
  }
  bindRun(runId) {
    if (!this.enabled) return;
    const ticket = this.scope.getStore(); check(ticket, 'CONTROL_TICKET_REQUIRED');
    const run = this.db.get('SELECT * FROM runs WHERE id=? AND partner_id=?', runId, this.service.config.partnerId); check(run?.status === 'running', 'CONTROL_RUN_INVALID');
    const changed = this.db.run("UPDATE control_tickets SET run_id=?,status='running' WHERE id=? AND owner_id=? AND status='reserved' AND run_id IS NULL AND expires_at>?", runId, ticket.id, this.ownerId, now());
    check(changed.changes === 1, 'CONTROL_TICKET_UNAVAILABLE');
  }
  ticket(runId) { return typeof runId === 'string' ? this.db.get('SELECT * FROM control_tickets WHERE run_id=? AND partner_id=?', runId, this.service.config.partnerId) : null; }
  canApply(runId) {
    if (!this.enabled) return !this.ticket(runId); // Turning CP off cannot turn its retired ticket into permission.
    const t = this.ticket(runId);
    return !this.stopped && this.processCurrent() && t?.owner_id === this.ownerId && ['running','completed'].includes(t.status)
      && Date.parse(t.expires_at) > Date.now() && (t.plane === 'private' ? this.service.config.runtime.enabled === true : this.service.config.opportunity.automatic === true)
      && this.service.config.telegram.liveSending === false;
  }
  require(runId, { plane } = {}) {
    if (!this.enabled) { check(!this.ticket(runId), 'CONTROL_TICKET_RETIRED'); return null; }
    const t = this.ticket(runId); check(this.canApply(runId) && t.status === 'running', 'CONTROL_TICKET_REQUIRED');
    const allowed = Array.isArray(plane) ? plane : plane ? [plane] : PLANES;
    check(allowed.includes(t.plane), 'CONTROL_PLANE_MISMATCH'); return t;
  }
  async run(plane, operation, fn) {
    if (!this.enabled) return fn();
    check(!this.scope.getStore(), 'CONTROL_NESTED_OPERATION');
    let ticket;
    try { ticket = await this.service.exclusive(() => this.db.transaction(() => this.reserve(plane, operation))); }
    catch (e) { if (!(e instanceof AppError)) throw e; return { disposition: e.code }; }
    let failed = false;
    try { return await this.scope.run(ticket, fn); }
    catch (e) { failed = true; throw e; }
    finally {
      await this.service.exclusive(() => this.db.transaction(() => {
        // An idle admission made no attempt; keep no artificial completed job.
        this.db.run('DELETE FROM control_tickets WHERE id=? AND owner_id=? AND run_id IS NULL', ticket.id, this.ownerId);
        this.db.run("UPDATE control_tickets SET status=?,finished_at=? WHERE id=? AND owner_id=? AND status IN ('reserved','running')", this.stopped ? 'interrupted' : failed ? 'failed' : 'completed', now(), ticket.id, this.ownerId);
      }));
    }
  }
  close() {
    this.stopped = true;
    this.db.run("UPDATE control_tickets SET status='interrupted',reason='OWNER_STOPPED',finished_at=? WHERE owner_id=? AND status IN ('reserved','running')", now(), this.ownerId);
  }
  releaseProcess() { this.db.run('DELETE FROM control_owners WHERE partner_id=? AND owner_id=?', this.service.config.partnerId, this.ownerId); }
  status() {
    return { enabled: this.enabled, active: this.db.all("SELECT id,plane,operation,run_id,status,expires_at,reserved_usd FROM control_tickets WHERE partner_id=? AND status IN ('reserved','running') ORDER BY created_at LIMIT 4", this.service.config.partnerId),
      limits: this.service.config.controlPlane ?? null, planes: PLANES.map(plane => ({ id: plane, max_active: 1, effect_authority: 'none_from_admission' })),
      capabilities: [{ id: 'source.read.v1', effect: 'read_only_public', authority: 'configured_source_allowlist' },
        { id: 'source.audit.v1', effect: 'bounded_read_only_history', authority: 'exact_current_owner_scout_audit_grant' },
        { id: 'source.monitor.v1', effect: 'read_only_public', authority: 'exact_current_owner_monitor_grant_and_native_checkpoint' },
        { id: 'conversation.reason.v1', effect: 'private_proposals', authority: 'existing_conversation_and_permissions' },
        { id: 'material.prepare.v1', effect: 'advisory_ready_material', authority: 'explicit_request_current_accepted_basis' },
        ...ACTION_CAPABILITIES.map(c => ({ ...c, authority: 'exact_unexpired_owner_action_grant' }))],
      no_outbound: this.service.config.telegram.liveSending === false, contact_permission: false, resource_ticket_is_authority: false };
  }
}
