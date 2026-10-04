// Domain mandate for ordinary Audience inference. SQLite and the existing run ledger
// own admission/accounting; this is neither a job engine nor an effect permission.
import path from 'node:path';
import Ajv from 'ajv';
import { ROOT, readJson, runtimeReadiness } from './config.mjs';
import { id } from './store.mjs';
import { ensure, now, AppError } from './errors.mjs';
import { digest } from './source-ingestion.mjs';

const validateGrant = new Ajv({ strict: true }).compile(readJson(path.join(ROOT, 'contracts/audience-attention-grant.schema.json')));
const check = (ok, code, status = 409) => ensure(ok, code, status, code);
const AUTHORITY = Object.freeze({ executable: false, contact_permission: false, allowed_effects: [] });

export class AudienceAttention {
  constructor(service) { this.service = service; this.db = service.store; }
  get partnerId() { return this.service.config.partnerId; }
  modelScope() {
    const c = this.service.config.runtime;
    let url;
    try { url = new URL(c.baseUrl); } catch { return null; }
    if (!['https:', 'http:'].includes(url.protocol) || url.protocol === 'http:' && !['127.0.0.1','localhost','[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash
      || typeof c.provider !== 'string' || !/^[a-z0-9_-]{1,50}$/i.test(c.provider)
      || !['chat_completions','responses'].includes(c.apiMode)
      || typeof c.model !== 'string' || !c.model.trim() || c.model.length > 200
      || !Number.isInteger(c.maxOutputTokens) || c.maxOutputTokens < 128 || c.maxOutputTokens > 16000) return null;
    return { provider: c.provider, api_mode: c.apiMode, base_url: url.href, model: c.model, max_output_tokens: c.maxOutputTokens };
  }
  scope(goalId) {
    const a = this.service.audience, goal = a.goal(goalId), watches = a.watches(goalId);
    const model = this.modelScope();
    // Observed source withdrawal is terminal for that goal watch. Restoring the
    // same configuration is not a new owner admission or a fresh authority epoch.
    const authority = watches.map(w => a.watchAuthority(w));
    const valid = a.enabled() && goal.status === 'OPEN' && model && watches.length > 0
      && authority.every(state => state.current);
    const value = valid ? { version: 1, partner_id: this.partnerId, goal_id: goal.id, goal_revision: goal.revision,
      objective: goal.objective, max_age_seconds: goal.max_age_seconds,
      watches: watches.map(w => [w.source_ref, w.policy_hash]), model } : null;
    return { goal, model, fingerprint: value ? digest(value) : null };
  }
  definition(row) {
    return { id: row.id, partner_id: row.partner_id, goal_id: row.goal_id, goal_revision: row.goal_revision,
      scope_fingerprint: row.scope_fingerprint, max_attempts: row.max_attempts, expires_at: row.expires_at,
      reason: row.reason, created_at: row.created_at };
  }
  intact(row) {
    return row?.partner_id === this.partnerId && Number.isInteger(row.max_attempts) && row.max_attempts >= 1 && row.max_attempts <= 50
      && Number.isFinite(Date.parse(row.expires_at)) && row.grant_fingerprint === digest(this.definition(row));
  }
  used(row) { return this.db.get('SELECT COUNT(*) n FROM audience_attention_attempts WHERE grant_id=?', row.id).n; }
  live(row, scope = this.scope(row.goal_id)) {
    return this.intact(row) && row.status === 'active' && Date.parse(row.expires_at) > Date.now()
      && scope.fingerprint !== null && row.scope_fingerprint === scope.fingerprint && row.goal_revision === scope.goal.revision;
  }
  view(row, scope) {
    const used = this.used(row), remaining = Math.max(0, row.max_attempts - used);
    const state = !this.intact(row) ? 'invalid' : row.status === 'revoked' ? 'revoked'
      : Date.parse(row.expires_at) <= Date.now() ? 'expired' : !this.live(row, scope) ? 'stale' : remaining === 0 ? 'exhausted' : 'active';
    return { ...this.definition(row), grant_fingerprint: row.grant_fingerprint, status: state, state,
      attempts_used: used, remaining_attempts: remaining, revoked_at: row.revoked_at, revocation_reason: row.revocation_reason };
  }
  eligible(goalId) {
    const scope = this.scope(goalId);
    if (!scope.fingerprint) return null;
    const rows = this.db.all(`SELECT g.* FROM audience_attention_grants g WHERE g.partner_id=? AND g.goal_id=?
      AND g.status='active' AND g.expires_at>? AND g.scope_fingerprint=?
      AND (SELECT COUNT(*) FROM audience_attention_attempts a WHERE a.grant_id=g.id)<g.max_attempts ORDER BY g.rowid DESC LIMIT 2`,
    this.partnerId, goalId, now(), scope.fingerprint);
    return rows.find(row => this.live(row, scope)) ?? null;
  }
  summary(goalId) {
    const scope = this.scope(goalId), cfg = this.service.config;
    const grants = this.db.all('SELECT * FROM audience_attention_grants WHERE partner_id=? AND goal_id=? ORDER BY rowid DESC LIMIT 20', this.partnerId, goalId)
      .map(row => this.view(row, scope));
    const eligible = this.eligible(goalId), reasons = [];
    if (!scope.fingerprint) reasons.push('AUDIENCE_ATTENTION_SCOPE_UNAVAILABLE');
    if (!eligible) reasons.push('AUDIENCE_ATTENTION_REQUIRED');
    if (!this.service.audience.enabled()) reasons.push('AUDIENCE_DISABLED');
    if (cfg.audience?.modelEnabled !== true) reasons.push('AUDIENCE_MODEL_DISABLED');
    if (cfg.controlPlane?.enabled !== true) reasons.push('AUDIENCE_CONTROL_REQUIRED');
    const readiness = runtimeReadiness(cfg, { decision: true });
    if (!readiness.ready) reasons.push('AUDIENCE_MODEL_NOT_READY');
    const watches = this.service.audience.watches(goalId);
    const sourceCurrent = watches.every(w => this.service.audience.health(w).current);
    if (!sourceCurrent) reasons.push('AUDIENCE_SOURCE_NOT_CURRENT');
    try { this.service.control.assertModelBudget({ runtime: 'hermes-audience-v1', maxRunsPerDay: cfg.audience.maxRunsPerDay }); }
    catch (error) { if (!(error instanceof AppError)) throw error; reasons.push(error.code); }
    return { scope_fingerprint: scope.fingerprint, model_configured: !!scope.model,
      model_ready: readiness.ready && cfg.audience?.modelEnabled === true && cfg.controlPlane?.enabled === true,
      source_current: sourceCurrent, can_grant: !!scope.fingerprint && !eligible, grants,
      active_grant_id: eligible?.id ?? null, ready: reasons.length === 0, block_reasons: [...new Set(reasons)], ...AUTHORITY };
  }
  assertGrantRequest(p) {
    check(validateGrant(p) && p.reason.trim().length > 0, 'AUDIENCE_FIELDS_INVALID', 400);
    check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(p.expires_at)
      && Date.parse(p.expires_at) > Date.now() && Date.parse(p.expires_at) <= Date.now() + 7 * 86400000,
    'AUDIENCE_ATTENTION_EXPIRY_INVALID', 400);
    const scope = this.scope(p.goal_id);
    check(scope.goal.revision === p.expected_revision && scope.fingerprint !== null && scope.fingerprint === p.expected_scope_fingerprint,
      'AUDIENCE_STALE_BASIS');
    return scope;
  }
  grant(p) {
    this.assertGrantRequest(p);
    check(!this.eligible(p.goal_id), 'AUDIENCE_ATTENTION_ALREADY_GRANTED');
    const row = { id: id(), partner_id: this.partnerId, goal_id: p.goal_id, goal_revision: p.expected_revision,
      scope_fingerprint: p.expected_scope_fingerprint, max_attempts: p.max_attempts,
      expires_at: p.expires_at, reason: p.reason.trim(), created_at: now() };
    const fp = digest(row);
    this.db.run("INSERT INTO audience_attention_grants VALUES(?,?,?,?,?,?,?,?,?,?,'active',NULL,NULL)",
      row.id, row.partner_id, row.goal_id, row.goal_revision, row.scope_fingerprint, row.max_attempts, row.expires_at, row.reason, row.created_at, fp);
    this.service.audience.record('attention_granted', { grant_id: row.id, goal_id: row.goal_id,
      actor: 'operator', max_attempts: row.max_attempts, expires_at: row.expires_at, scope_fingerprint: row.scope_fingerprint }, 'operator');
    return { grant_id: row.id, grant_fingerprint: fp, ...AUTHORITY };
  }
  revoke(p) {
    check(p && Object.keys(p).sort().join(',') === 'expected_grant_fingerprint,grant_id,reason'
      && typeof p.reason === 'string' && p.reason.trim().length > 0 && p.reason.length <= 500, 'AUDIENCE_FIELDS_INVALID', 400);
    const row = this.db.get('SELECT * FROM audience_attention_grants WHERE id=? AND partner_id=?', p.grant_id, this.partnerId);
    check(row, 'AUDIENCE_ATTENTION_NOT_FOUND', 404);
    check(this.intact(row) && row.grant_fingerprint === p.expected_grant_fingerprint, 'AUDIENCE_STALE_BASIS');
    if (row.status !== 'revoked') {
      this.db.run("UPDATE audience_attention_grants SET status='revoked',revoked_at=?,revocation_reason=? WHERE id=?", now(), p.reason.trim(), row.id);
      this.service.audience.record('attention_revoked', { grant_id: row.id, goal_id: row.goal_id, reason: p.reason.trim(), actor: 'operator' }, 'operator');
    }
    return { grant_id: row.id, ...AUTHORITY };
  }
  bind(grant, row, runId) {
    check(this.live(grant) && grant.goal_id === row.goal_id && this.used(grant) < grant.max_attempts, 'AUDIENCE_ATTENTION_REQUIRED');
    this.db.run('INSERT INTO audience_attention_attempts VALUES(?,?,?,?,?,?)', runId, grant.id, row.id, row.goal_id, grant.grant_fingerprint, now());
  }
  assertHistory(runId, row, frozenGrant) {
    const binding = this.db.get('SELECT * FROM audience_attention_attempts WHERE run_id=?', runId);
    check(binding && binding.assessment_id === row.id && binding.goal_id === row.goal_id, 'AUDIENCE_ATTENTION_BINDING_INVALID');
    const grant = this.db.get('SELECT * FROM audience_attention_grants WHERE id=? AND partner_id=?', binding.grant_id, this.partnerId);
    check(grant && this.intact(grant) && grant.goal_id === row.goal_id && binding.grant_fingerprint === grant.grant_fingerprint
      && frozenGrant?.id === grant.id && frozenGrant.grant_fingerprint === grant.grant_fingerprint,
    'AUDIENCE_ATTENTION_BINDING_INVALID');
    return grant;
  }
  assertRun(runId, row, frozenGrant) {
    const grant = this.assertHistory(runId, row, frozenGrant);
    // Remaining admission allowance is intentionally not checked: the last admitted turn may finish.
    check(this.live(grant), 'AUDIENCE_ATTENTION_REVOKED_OR_STALE');
  }
}
