// Domain authority over fixed local effects. No provider tools or arbitrary targets.
import path from 'node:path';
import Ajv from 'ajv';
import { ROOT, readJson } from './config.mjs';
import { id } from './store.mjs';
import { ensure, requiredText, dateTime, now, AppError } from './errors.mjs';
import { automaticBoundary, digest } from './source-ingestion.mjs';
import { HUMAN_ACTION_TASK } from './action-tables.mjs';

export const ACTION_VERSION = '1.0.0';
export const ACTION_STALE_ERRORS = new Set(['ACTION_AUTHORITY_CHANGED','ACTION_STALE_BASIS','ACTION_STALE_EVIDENCE',
  'ACTION_ACCEPTED_MEMORY_REQUIRED','ACTION_PENDING_REVIEW','EXECUTIVE_AUTHORITY_CHANGED','EXECUTIVE_SOURCE_REVOKED']);
export const actionSchema = readJson(path.join(ROOT, 'contracts/action-proposal.schema.json'));
const validate = new Ajv({ strict: true, allowUnionTypes: true }).compile(actionSchema);
export const ACTION_CAPABILITIES = Object.freeze([
  Object.freeze({ id: 'brief.publish_local.v1', version: 1, effect: 'owner_local_file', target: 'owner-local', label: 'Локальный brief', verification: 'exact_bytes_sha256' }),
  Object.freeze({ id: 'owner_handoff.create.v1', version: 1, effect: 'human_only_task', target: 'owner-local', label: 'Задача владельцу', verification: 'durable_task_identity_and_payload' }),
  Object.freeze({ id: 'material.export_local.v1', version: 1, effect: 'owner_local_file', target: 'owner-local', label: 'Ready material', verification: 'exact_bytes_sha256' }),
]);
const LEGACY_ACTION_CAPABILITIES = Object.freeze(ACTION_CAPABILITIES.filter(c => c.id !== 'material.export_local.v1'));
const EFFECTS = { contact_permission: false, external_write: false };
export const actionCheck = (ok, code, status = 409) => ensure(ok, code, status, code);
const check = actionCheck;
const fields = (p, keys) => check(p && typeof p === 'object' && !Array.isArray(p)
  && Object.keys(p).every(k => keys.includes(k)), 'ACTION_FIELDS_INVALID', 400);
const TERMINAL = ['revoked','rejected','stale','no_action'];
const refs = o => [...new Set([...o.summary.evidence_event_ids, ...o.claims.map(c => c.source_event_id),
  ...o.hypotheses.flatMap(h => [...h.evidence_event_ids, ...h.counterevidence_event_ids])])];
export class ActionLoop {
  constructor(service) { this.service = service; this.db = service.store; }
  get partnerId() { return this.service.config.partnerId; }
  enabled() {
    check(this.service.config.actions?.enabled === true && this.service.config.continuity?.enabled === true, 'ACTION_DISABLED');
    check(!this.service.control?.enabled || !this.service.control.stopped && this.service.control.processCurrent(), 'ACTION_RUNTIME_OWNER_REQUIRED');
    automaticBoundary(this.service);
  }
  get(actionId) {
    const row = this.db.get('SELECT * FROM action_proposals WHERE id=? AND partner_id=?', actionId, this.partnerId);
    check(row, 'ACTION_NOT_FOUND', 404); return row;
  }
  update(row, patch) {
    this.db.run(`UPDATE action_proposals SET ${Object.keys(patch).map(k => `${k}=?`).join(',')},revision=revision+1,updated_at=? WHERE id=?`,
      ...Object.values(patch), now(), row.id);
  }
  record(kind, payload, actor = 'system') { this.db.event(this.partnerId, null, `action.${kind}`, actor, payload); }
  authority(threadId, capabilityId = null) {
    // Preserve the exact authority fingerprint used by already-created v1 brief/handoff grants.
    const capabilities = capabilityId === 'material.export_local.v1' ? ACTION_CAPABILITIES : LEGACY_ACTION_CAPABILITIES;
    return digest({ authority: this.service.executive.authority(threadId), version: ACTION_VERSION, capabilities });
  }
  basis(threadId) {
    const c = this.service.continuity, d = c.detail(threadId);
    check(d.ready && d.memory?.current === true && d.memory.content, 'ACTION_ACCEPTED_MEMORY_REQUIRED');
    check(!d.attention.pending && d.latest_turn?.id === d.memory.turn_id && d.latest_turn.status === 'accepted', 'ACTION_PENDING_REVIEW');
    return d;
  }
  packet(d) {
    const selected = refs(d.memory.content), c = this.service.continuity;
    check(selected.length > 0 && selected.length <= 32, 'ACTION_EVIDENCE_REQUIRED');
    const states = c.evidenceStates(c.thread(d.id), c.watches(d.id), selected);
    check(selected.every(ref => states.get(ref)?.current), 'ACTION_STALE_EVIDENCE');
    return { thread_id: d.id, objective: d.objective, success_condition: d.success_condition, turn_id: d.memory.turn_id,
      epistemic_status: 'unverified_interpretation', interpretation: d.memory.content, evidence: selected.map(ref => states.get(ref)),
      basis_fingerprint: d.basis_fingerprint, coverage: d.coverage, ...EFFECTS };
  }
  current(row, { enabled = false } = {}) {
    if (enabled) this.enabled();
    const capabilityId = JSON.parse(row.proposal_json ?? 'null')?.capability_id ?? null;
    check(this.authority(row.thread_id, capabilityId) === row.authority_hash, 'ACTION_AUTHORITY_CHANGED');
    const d = this.basis(row.thread_id);
    check(d.basis_fingerprint === row.basis_fingerprint && d.memory.turn_id === row.turn_id, 'ACTION_STALE_BASIS');
    const packet = JSON.parse(row.packet_json), proposal = JSON.parse(row.proposal_json ?? 'null'), c = this.service.continuity;
    const states = c.evidenceStates(c.thread(row.thread_id), c.watches(row.thread_id), packet.evidence.map(e => e.source_event_id));
    check(packet.evidence.every(e => states.get(e.source_event_id)?.current), 'ACTION_STALE_EVIDENCE');
    if (proposal?.capability_id === 'material.export_local.v1') {
      check(packet.material && proposal.material?.id === packet.material.id && proposal.material?.sha256 === packet.material.sha256,
        'ACTION_MATERIAL_MISMATCH');
      check(this.service.work?.assertMaterial, 'ACTION_MATERIAL_UNAVAILABLE');
      this.service.work.assertMaterial(packet.material, row.thread_id, row.basis_fingerprint);
    } else check(packet.material === undefined, 'ACTION_MATERIAL_MISMATCH');
    return d;
  }
  checkedProposal(value) {
    check(Buffer.byteLength(JSON.stringify(value ?? null)) <= 16000 && validate(value), 'ACTION_PROPOSAL_INVALID', 400);
    check((value.capability_id === 'material.export_local.v1') === (value.material !== undefined), 'ACTION_MATERIAL_REFERENCE_INVALID', 400);
    if (value.due_at !== null) dateTime(value.due_at);
    // Canonical property order; caller insertion order cannot change the grant identity.
    const proposal = { capability_id: value.capability_id, title: value.title, instructions: value.instructions,
      expected_result: value.expected_result, due_at: value.due_at === null ? null : dateTime(value.due_at) };
    // Keep the legacy canonical object byte-for-byte identical when the optional pin is absent.
    if (value.material !== undefined) proposal.material = { id: value.material.id, sha256: value.material.sha256 };
    return proposal;
  }
  // The identity of "this exact action", and it has to be the identity of the action rather than
  // of the observations that were fresh when it was proposed.
  //
  // Hashing the whole packet made re-reading a page a new action. A browser reread confirms the
  // existing version rather than producing a new message — the evidence's `confirmed_at` moves —
  // so the same proposal over the same text hashed differently, `ACTION_DUPLICATE_PROPOSAL` found
  // nothing, and an action whose grant had been revoked could be proposed again and granted
  // afresh. That is the exact thing the revoke is supposed to prevent, defeated by a timestamp.
  //
  // What identifies the action is what it says and what it rests on: the source, the message, its
  // version, its text, and the proposal itself. When any of those change the hash must change, and
  // `current`/`reasons` must not — they are derived from the clock, and a proposal that is still
  // the same proposal is a duplicate whether or not it is still current. Staleness has its own
  // refusal, `ACTION_STALE_EVIDENCE`, and freshness has its own; neither is the duplicate check's
  // business.
  static staticEvidence(evidence) {
    return evidence.map((e) => ({ source_event_id: e.source_event_id, source_ref: e.source_ref,
      author_id: e.author_id, message_id: e.message_id, message_version: e.message_version,
      text: e.text, truncated: e.truncated }));
  }
  proposalHash(row, proposal) {
    const packet = JSON.parse(row.packet_json);
    return digest({ partner_id: this.partnerId, thread_id: row.thread_id, turn_id: row.turn_id,
      authority_hash: row.authority_hash, basis_fingerprint: row.basis_fingerprint,
      packet: { ...packet, evidence: ActionLoop.staticEvidence(packet.evidence ?? []) },
      proposal, capability: ACTION_CAPABILITIES.find(c => c.id === proposal.capability_id) });
  }
  applyPlan(row, output) {
    fields(output, ['kind','reason','proposal']); requiredText(output.reason, 'reason', 2000);
    check(['action','no_action'].includes(output.kind) && (output.kind === 'action') === (output.proposal !== null), 'ACTION_PLAN_INVALID', 400);
    this.current(row, { enabled: true });
    if (output.kind === 'no_action') { this.update(row, { status: 'no_action', reason: output.reason }); return; }
    const proposal = this.checkedProposal(output.proposal), fingerprint = this.proposalHash(row, proposal);
    check(proposal.capability_id !== 'material.export_local.v1', 'ACTION_MATERIAL_OWNER_PREPARATION_REQUIRED');
    check(!this.db.get('SELECT id FROM action_proposals WHERE proposal_hash=? AND id<>?', fingerprint, row.id), 'ACTION_DUPLICATE_PROPOSAL');
    this.update(row, { status: 'proposed', title: proposal.title, reason: output.reason, proposal_json: JSON.stringify(proposal), proposal_hash: fingerprint });
  }
  create(p, planning = false) {
    this.enabled(); fields(p, ['thread_id','expected_basis_fingerprint', ...(planning ? [] : ['proposal','reason'])]);
    if (planning) check(this.service.config.actions.modelEnabled === true, 'ACTION_MODEL_DISABLED');
    const d = this.basis(p.thread_id); check(d.basis_fingerprint === p.expected_basis_fingerprint, 'ACTION_STALE_BASIS');
    const proposal = planning ? null : this.checkedProposal(p.proposal);
    const packet = this.packet(d);
    if (proposal?.capability_id === 'material.export_local.v1') {
      check(this.service.work?.materialPacket, 'ACTION_MATERIAL_UNAVAILABLE');
      const material = this.service.work.materialPacket(proposal.material, d.id, d.basis_fingerprint);
      check(material && material.id === proposal.material.id && material.sha256 === proposal.material.sha256,
        'ACTION_MATERIAL_MISMATCH');
      packet.material = material;
    }
    const row = { id: id(), thread_id: d.id, turn_id: d.memory.turn_id, basis_fingerprint: d.basis_fingerprint,
      authority_hash: this.authority(d.id, proposal?.capability_id ?? null), packet_json: JSON.stringify(packet) };
    const reason = planning ? 'Owner requested one bounded proposal' : requiredText(p.reason, 'reason', 2000);
    const fingerprint = proposal ? this.proposalHash(row, proposal) : null;
    const existing = fingerprint && this.db.get('SELECT id FROM action_proposals WHERE partner_id=? AND proposal_hash=?', this.partnerId, fingerprint);
    if (existing) return { action_id: existing.id, duplicate: true, ...EFFECTS };
    check(!planning || !this.db.get("SELECT id FROM action_proposals WHERE thread_id=? AND status IN ('plan_requested','planning')", d.id), 'ACTION_PLAN_PENDING');
    check(this.db.get("SELECT COUNT(*) n FROM action_proposals WHERE partner_id=? AND status IN ('plan_requested','planning','proposed','authorized','verifying','unknown')", this.partnerId).n < 100, 'ACTION_CAPACITY');
    this.db.run(`INSERT INTO action_proposals(id,partner_id,thread_id,turn_id,basis_fingerprint,authority_hash,packet_json,proposal_json,proposal_hash,title,reason,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, row.id, this.partnerId, d.id, row.turn_id, row.basis_fingerprint, row.authority_hash, row.packet_json,
      proposal ? JSON.stringify(proposal) : null, fingerprint, proposal?.title ?? 'Action proposal requested', reason, planning ? 'plan_requested' : 'proposed', now(), now());
    this.record('proposed', { action_id: row.id, proposal_hash: fingerprint, planning }, 'operator');
    return { action_id: row.id, ...EFFECTS };
  }
  latest(row) { return this.db.get('SELECT a.* FROM action_attempts a JOIN action_grants g ON g.id=a.grant_id WHERE a.action_id=? ORDER BY g.version DESC LIMIT 1', row.id); }
  grant(p, retry = false) {
    this.enabled(); fields(p, ['action_id','expected_revision','proposal_hash','expires_at']);
    const row = this.get(p.action_id); check(row.revision === p.expected_revision, 'ACTION_REVISION_CONFLICT');
    this.current(row, { enabled: true });
    check(row.proposal_hash && row.proposal_hash === p.proposal_hash && row.proposal_hash === this.proposalHash(row, this.checkedProposal(JSON.parse(row.proposal_json))), 'ACTION_PROPOSAL_CHANGED');
    const attempt = this.latest(row);
    check(!this.db.get("SELECT id FROM action_grants WHERE action_id=? AND status IN ('revoked','stale')", row.id), 'ACTION_AUTHORITY_RETIRED');
    check(retry ? ['failed','unknown'].includes(row.status) && !row.verify_requested && attempt?.verification_state === 'absent'
      : row.status === 'proposed' && !attempt, retry ? 'ACTION_ABSENCE_REQUIRED' : 'ACTION_NOT_GRANTABLE');
    const expiry = dateTime(p.expires_at), delta = Date.parse(expiry) - Date.now();
    check(delta >= 1000 && delta <= 86400000, 'ACTION_EXPIRY_INVALID', 400);
    const grantId = id(), version = this.db.get('SELECT COALESCE(MAX(version),0)+1 n FROM action_grants WHERE action_id=?', row.id).n;
    this.db.run(`INSERT INTO action_grants(id,action_id,version,proposal_hash,authority_hash,basis_fingerprint,expires_at,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'active',?,?)`, grantId, row.id, version, row.proposal_hash, row.authority_hash, row.basis_fingerprint, expiry, now(), now());
    this.update(row, { status: 'authorized', verify_requested: 0 });
    this.record('granted', { action_id: row.id, grant_id: grantId, version, proposal_hash: row.proposal_hash, expires_at: expiry, max_attempts: 1, retry }, 'operator');
    return { action_id: row.id, grant_id: grantId, ...EFFECTS };
  }
  assertGrant(row, grant) {
    this.current(row, { enabled: true });
    check(row.status === 'authorized' && grant?.status === 'active' && Date.parse(grant.expires_at) > Date.now(), 'ACTION_GRANT_UNAVAILABLE');
    check(grant.action_id === row.id && grant.proposal_hash === row.proposal_hash && grant.authority_hash === row.authority_hash
      && grant.basis_fingerprint === row.basis_fingerprint && grant.max_attempts === 1, 'ACTION_GRANT_MISMATCH');
    check(row.proposal_hash === this.proposalHash(row, this.checkedProposal(JSON.parse(row.proposal_json))), 'ACTION_PROPOSAL_CHANGED');
  }
  retire(row, status, reason) {
    this.db.run("UPDATE action_grants SET status=?,reason=?,updated_at=? WHERE action_id=? AND status IN ('active','consumed')",
      status === 'stale' ? 'stale' : 'revoked', reason, now(), row.id);
    this.db.run("UPDATE action_attempts SET status='not_executed',finished_at=? WHERE action_id=? AND status='prepared'", now(), row.id);
    if (row.task_id) this.db.run("UPDATE tasks SET status='cancelled' WHERE id=? AND kind=? AND status IN ('proposed','pending')", row.task_id, HUMAN_ACTION_TASK);
    this.update(row, { status, reason }); this.record(status, { action_id: row.id, reason });
  }
  invalidate(row, reason) {
    if (TERMINAL.includes(row.status)) return;
    if (row.status !== 'completed') { this.retire(row, 'stale', reason); return; }
    // Keep historical physical completion separate from now-retired authority.
    const result = this.db.run("UPDATE action_grants SET status='stale',reason=?,updated_at=? WHERE action_id=? AND status IN ('active','consumed')", reason, now(), row.id);
    if (row.task_id) this.db.run("UPDATE tasks SET status='cancelled' WHERE id=? AND status IN ('proposed','pending')", row.task_id);
    if (result.changes) { this.update(row, { reason }); this.record('authority_stale', { action_id: row.id, reason }); }
  }
  command(action, p, actor) {
    check(actor?.kind === 'operator', 'ACTION_OPERATOR_REQUIRED', 403);
    if (action === 'action.propose' || action === 'action.request_plan') return this.create(p, action === 'action.request_plan');
    if (action === 'action.grant' || action === 'action.retry') return this.grant(p, action === 'action.retry');
    const row = this.get(p.action_id); check(row.revision === p.expected_revision, 'ACTION_REVISION_CONFLICT');
    if (action === 'action.revoke' || action === 'action.reject') {
      fields(p, ['action_id','expected_revision','reason']);
      check(!TERMINAL.includes(row.status) && (action !== 'action.reject' || ['proposed','plan_requested'].includes(row.status)), 'ACTION_TERMINAL');
      this.retire(row, action === 'action.revoke' ? 'revoked' : 'rejected', requiredText(p.reason, 'reason', 2000));
    } else if (action === 'action.verify') {
      fields(p, ['action_id','expected_revision']); check(this.latest(row), 'ACTION_NO_ATTEMPT');
      this.update(row, { verify_requested: 1 }); this.record('verification_requested', { action_id: row.id }, 'operator');
    } else {
      fields(p, ['action_id','expected_revision','note', ...(action === 'action.handoff_resolve' ? ['outcome'] : [])]);
      this.current(row, { enabled: true });
      check(!this.db.get("SELECT id FROM action_grants WHERE action_id=? AND status IN ('revoked','stale')", row.id), 'ACTION_AUTHORITY_RETIRED');
      const task = row.task_id && this.db.get('SELECT * FROM tasks WHERE id=? AND partner_id=? AND kind=?', row.task_id, this.partnerId, HUMAN_ACTION_TASK);
      check(row.status === 'completed' && !row.verify_requested && this.latest(row)?.verification_state === 'present' && task, 'ACTION_HANDOFF_NOT_VERIFIED');
      const note = requiredText(p.note, 'note', 2000);
      if (action === 'action.handoff_acknowledge') check(task.status === 'proposed', 'ACTION_HANDOFF_STATE');
      else check(action === 'action.handoff_resolve' && task.status === 'pending' && ['done','declined'].includes(p.outcome), 'ACTION_HANDOFF_STATE');
      const status = action === 'action.handoff_acknowledge' ? 'pending' : p.outcome === 'done' ? 'done' : 'cancelled';
      this.db.run('UPDATE tasks SET status=? WHERE id=?', status, task.id); this.update(row, { reason: note });
      this.record(action.slice(7), { action_id: row.id, task_id: task.id, note, outcome: p.outcome ?? null,
        epistemic_status: 'owner_report_not_independent_business_verification' }, 'operator');
    }
    return { action_id: row.id, ...EFFECTS };
  }
  // Persistent round-robin cursor; bounded work even with many historical rows.
  page(channel, where, limit = 20) {
    const cursor = this.db.get('SELECT cursor FROM channel_offsets WHERE channel=? AND account_id=?', channel, this.partnerId)?.cursor ?? '';
    const query = (after, n, before = null) => this.db.all(`SELECT * FROM action_proposals WHERE partner_id=? AND id>? AND (${where}) ${before ? 'AND id<=?' : ''} ORDER BY id LIMIT ?`, this.partnerId, after, ...(before ? [before] : []), n);
    let rows = query(cursor, limit); if (cursor && rows.length < limit) rows = rows.concat(query('', limit - rows.length, cursor));
    return rows;
  }
  advance(channel, row) {
    this.db.run('INSERT INTO channel_offsets VALUES(?,?,?) ON CONFLICT(channel,account_id) DO UPDATE SET cursor=excluded.cursor', channel, this.partnerId, row.id);
  }
  reconcile() {
    return this.db.transaction(() => {
      const rows = this.page('action-maintenance-v1', "status NOT IN ('revoked','rejected','stale','no_action')");
      for (const row of rows) {
        this.advance('action-maintenance-v1', row);
        try { this.current(row); }
        catch (e) {
          if (!(e instanceof AppError)) throw e;
          this.invalidate(row, e.code);
          continue;
        }
        const grant = this.db.get("SELECT * FROM action_grants WHERE action_id=? AND status='active'", row.id);
        if (grant && Date.parse(grant.expires_at) <= Date.now()) {
          this.db.run("UPDATE action_grants SET status='expired',reason='ACTION_EXPIRED',updated_at=? WHERE id=?", now(), grant.id);
          this.db.run("UPDATE action_attempts SET status='not_executed',finished_at=? WHERE grant_id=? AND status='prepared'", now(), grant.id);
          this.update(row, { status: 'stale', reason: 'ACTION_EXPIRED' }); this.record('expired', { action_id: row.id, grant_id: grant.id });
        }
      }
      return { actions: rows.length };
    });
  }
  detail(actionId) {
    const row = this.get(actionId), { packet_json, proposal_json, ...rest } = row;
    let current = true, reason = null;
    try { this.current(row); }
    catch (e) { if (!(e instanceof AppError)) throw e; current = false; reason = e.code; }
    const grants = this.db.all('SELECT * FROM action_grants WHERE action_id=? ORDER BY version', row.id);
    if (grants.some(g => ['stale','revoked'].includes(g.status))) { current = false; reason ??= 'ACTION_AUTHORITY_RETIRED'; }
    const attempts = this.db.all('SELECT * FROM action_attempts WHERE action_id=? ORDER BY rowid', row.id)
      .map(({ receipt_json, verification_json, ...a }) => ({ ...a, receipt: receipt_json ? JSON.parse(receipt_json) : null, verification: verification_json ? JSON.parse(verification_json) : null }));
    const enabled = this.service.config.actions?.enabled === true && this.service.config.continuity?.enabled === true;
    return { ...rest, packet: JSON.parse(packet_json), proposal: proposal_json ? JSON.parse(proposal_json) : null, current, current_reason: reason, grants, attempts,
      human_task: row.task_id ? this.db.get('SELECT * FROM tasks WHERE id=? AND partner_id=?', row.task_id, this.partnerId) ?? null : null,
      can_grant: enabled && current && row.status === 'proposed' && !attempts.length,
      can_retry: enabled && current && !row.verify_requested && ['failed','unknown'].includes(row.status) && attempts.at(-1)?.verification_state === 'absent',
      can_revoke: !TERMINAL.includes(row.status), artifact_available: !!proposal_json
        && ['brief.publish_local.v1','material.export_local.v1'].includes(JSON.parse(proposal_json).capability_id) && attempts.length > 0, ...EFFECTS };
  }
  list({ limit = 20, cursor = '' } = {}) {
    check(Number.isInteger(limit) && limit > 0 && limit <= 50 && typeof cursor === 'string' && cursor.length <= 36, 'ACTION_PAGE_INVALID', 400);
    const rows = this.db.all('SELECT id,thread_id,title,status,revision FROM action_proposals WHERE partner_id=? AND id>? ORDER BY id LIMIT ?', this.partnerId, cursor, limit + 1);
    return { items: rows.slice(0, limit), next_cursor: rows.length > limit ? rows[limit - 1].id : null,
      enabled: this.service.config.actions?.enabled === true, model_enabled: this.service.config.actions?.modelEnabled === true, capabilities: ACTION_CAPABILITIES, ...EFFECTS };
  }
}
