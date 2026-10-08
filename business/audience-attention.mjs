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
  modelScope(c = this.service.config.runtime) {
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
  binding(row) { return row?.id ? this.db.get('SELECT * FROM audience_attention_models WHERE grant_id=?', row.id) : null; }
  profile(row, { historical = false } = {}) {
    const binding = this.binding(row);
    if (!binding) return null;
    const profile = this.service.modelProfiles.resolve(binding.model_profile_id, { historical });
    check(profile.definition_hash === binding.definition_hash, 'AUDIENCE_ATTENTION_BINDING_INVALID');
    return profile;
  }
  scope(goalId, profileId = null) {
    const a = this.service.audience, goal = a.goal(goalId), watches = a.watches(goalId);
    let profile = null, profileError = null;
    try { if (profileId) profile = this.service.modelProfiles.resolve(profileId); }
    catch (error) { if (!(error instanceof AppError)) throw error; profileError = error.code; }
    const model = profileError ? null : this.modelScope(profile?.model_config);
    // Observed source withdrawal is terminal for that goal watch. Restoring the
    // same configuration is not a new owner admission or a fresh authority epoch.
    const authority = watches.map(w => a.watchAuthority(w));
    const valid = a.enabled() && goal.status === 'OPEN' && model && watches.length > 0
      && authority.every(state => state.current);
    const value = valid ? { version: 1, partner_id: this.partnerId, goal_id: goal.id, goal_revision: goal.revision,
      objective: goal.objective, max_age_seconds: goal.max_age_seconds,
      watches: watches.map(w => [w.source_ref, w.policy_hash]), model,
      ...(profile ? { version: 2, model_profile: { id: profile.profile_id, definition_hash: profile.definition_hash } } : {}) } : null;
    return { goal, model, profile, profileError, fingerprint: value ? digest(value) : null };
  }
  scopeFor(row) { return this.scope(row.goal_id, this.binding(row)?.model_profile_id); }
  definition(row, binding = this.binding(row)) {
    return { id: row.id, partner_id: row.partner_id, goal_id: row.goal_id, goal_revision: row.goal_revision,
      scope_fingerprint: row.scope_fingerprint, max_attempts: row.max_attempts, expires_at: row.expires_at,
      reason: row.reason, created_at: row.created_at,
      ...(binding ? { model_profile: { id: binding.model_profile_id, definition_hash: binding.definition_hash } } : {}) };
  }
  intact(row) {
    try {
      this.profile(row, { historical: true });
      return row?.partner_id === this.partnerId && Number.isInteger(row.max_attempts) && row.max_attempts >= 1 && row.max_attempts <= 50
        && Number.isFinite(Date.parse(row.expires_at)) && row.grant_fingerprint === digest(this.definition(row));
    } catch (error) { if (!(error instanceof AppError)) throw error; return false; }
  }
  used(row) { return this.db.get('SELECT COUNT(*) n FROM audience_attention_attempts WHERE grant_id=?', row.id).n; }
  live(row, scope = this.scopeFor(row)) {
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
  eligible(goalId, { dispatch = false } = {}) {
    const rows = this.db.all(`SELECT g.* FROM audience_attention_grants g WHERE g.partner_id=? AND g.goal_id=?
      AND g.status='active' AND g.expires_at>?
      AND (SELECT COUNT(*) FROM audience_attention_attempts a WHERE a.grant_id=g.id)<g.max_attempts ORDER BY g.rowid DESC LIMIT 100`,
    this.partnerId, goalId, now());
    return rows.find(row => (!dispatch || this.binding(row) || this.service.config.audience?.modelEnabled === true) && this.live(row)) ?? null;
  }
  hasScopedGrant() {
    // Routing hint only. Transactional admission validates every binding and current source.
    return !!this.db.get(`SELECT g.id FROM audience_attention_grants g JOIN audience_attention_models m ON m.grant_id=g.id
      JOIN model_profiles p ON p.id=m.model_profile_id JOIN audience_goals a ON a.id=g.goal_id
      WHERE g.partner_id=? AND g.status='active' AND p.status='available' AND a.status='OPEN' AND g.expires_at>?
      AND (SELECT COUNT(*) FROM audience_attention_attempts t WHERE t.grant_id=g.id)<g.max_attempts LIMIT 1`, this.partnerId, now());
  }
  modelEnabled() { return this.service.config.audience?.modelEnabled === true || this.hasScopedGrant() || this.service.followup?.hasPending(); }
  configurationFor(grant) {
    if (!grant) return this.service.config;
    check(this.live(grant), 'AUDIENCE_ATTENTION_REVOKED_OR_STALE');
    const profile = this.profile(grant);
    if (!profile) { check(this.service.config.audience?.modelEnabled === true, 'AUDIENCE_MODEL_DISABLED'); return this.service.config; }
    return { ...this.service.config, runtime: profile.model_config };
  }
  runtimeForRun(run) {
    const persisted = this.db.get('SELECT * FROM runs WHERE id=? AND partner_id=?', run.id, this.partnerId);
    check(run.runtime === 'hermes-audience-v1' && persisted?.runtime === run.runtime && persisted.status === 'running'
      && persisted.context_json === run.context_json, 'AUDIENCE_ATTENTION_BINDING_INVALID');
    const frozen = JSON.parse(run.context_json);
    const row = this.db.get('SELECT * FROM audience_assessments WHERE id=?', frozen.assessment_id);
    check(row?.run_id === run.id && row.status === 'running' && row.goal_id === frozen.goal_id,
      'AUDIENCE_ATTENTION_BINDING_INVALID');
    this.service.audience.assertAssessmentCurrent(row);
    const grant = this.assertHistory(run.id, row, frozen.attention_grant);
    const profile = this.profile(grant);
    check(profile && frozen.model_profile?.id === profile.profile_id && frozen.model_profile?.definition_hash === profile.definition_hash,
      'AUDIENCE_ATTENTION_BINDING_INVALID');
    check(this.live(grant) && this.modelScope(frozen.model_config) &&
      ['provider','apiMode','baseUrl','model','maxOutputTokens','inputUsdPerMillion','outputUsdPerMillion']
        .every(key => frozen.model_config[key] === profile.model_config[key]), 'AUDIENCE_ATTENTION_BINDING_INVALID');
    // Use frozen operational bounds as well as the frozen immutable profile, never global retargeting.
    check(Number.isInteger(frozen.model_config.timeoutSeconds) && frozen.model_config.timeoutSeconds >= 10
      && frozen.model_config.timeoutSeconds <= 1800, 'AUDIENCE_ATTENTION_BINDING_INVALID');
    return frozen.model_config;
  }
  summary(goalId, nextPacket = this.service.audience.nextPacket(goalId)) {
    const scope = this.scope(goalId), cfg = this.service.config;
    const grants = this.db.all('SELECT * FROM audience_attention_grants WHERE partner_id=? AND goal_id=? ORDER BY rowid DESC LIMIT 20', this.partnerId, goalId)
      .map(row => this.view(row));
    const eligible = this.eligible(goalId, { dispatch: true }), reasons = [];
    const selectedConfig = eligible ? this.configurationFor(eligible) : cfg;
    const selectedScope = eligible ? this.scopeFor(eligible) : scope;
    if (!selectedScope.fingerprint) reasons.push('AUDIENCE_ATTENTION_SCOPE_UNAVAILABLE');
    if (!eligible) reasons.push('AUDIENCE_ATTENTION_REQUIRED');
    if (!this.service.audience.enabled()) reasons.push('AUDIENCE_DISABLED');
    if (!eligible && cfg.audience?.modelEnabled !== true) reasons.push('AUDIENCE_MODEL_DISABLED');
    if (cfg.controlPlane?.enabled !== true) reasons.push('AUDIENCE_CONTROL_REQUIRED');
    const readiness = runtimeReadiness(selectedConfig, { decision: true });
    if (!readiness.ready) reasons.push('AUDIENCE_MODEL_NOT_READY');
    // All enrolled transport health is separate from a valid next bounded packet.
    // The ordinary dispatcher uses that same packet selection. A healthy subset
    // cannot renew/shrink the whole-goal grant: eligible/scope above still check
    // every original source authority epoch, including a revoked neighbor.
    const sourceCurrent = nextPacket.source_summary.enrolled_sources > 0
      && nextPacket.source_summary.current_sources === nextPacket.source_summary.enrolled_sources;
    if (!nextPacket.ready) reasons.push(sourceCurrent ? 'AUDIENCE_EVIDENCE_NOT_READY' : 'AUDIENCE_SOURCE_NOT_CURRENT');
    const pending = this.db.get("SELECT id,status,producer FROM audience_assessments WHERE goal_id=? AND status IN ('captured','running') ORDER BY rowid LIMIT 1", goalId) ?? null;
    if (pending) reasons.push('AUDIENCE_ASSESSMENT_PENDING');
    try { this.service.control.assertModelBudget({ runtime: 'hermes-audience-v1', maxRunsPerDay: cfg.audience.maxRunsPerDay }); }
    catch (error) { if (!(error instanceof AppError)) throw error; reasons.push(error.code); }
    const catalog = this.service.modelProfiles.list();
    const profileOptions = catalog.profiles.map(profile => {
      const profileScope = this.scope(goalId, profile.id);
      const blocks = [...profile.block_reasons];
      if (!profileScope.fingerprint) blocks.push(profileScope.profileError ?? 'AUDIENCE_ATTENTION_SCOPE_UNAVAILABLE');
      if (!nextPacket.ready) blocks.push(sourceCurrent ? 'AUDIENCE_EVIDENCE_NOT_READY' : 'AUDIENCE_SOURCE_NOT_CURRENT');
      if (cfg.controlPlane?.enabled !== true) blocks.push('AUDIENCE_CONTROL_REQUIRED');
      const ready = profileScope.profile && runtimeReadiness({ ...cfg, runtime: profileScope.profile.model_config }, { decision: true }).ready;
      if (!ready) blocks.push('AUDIENCE_MODEL_NOT_READY');
      return { ...profile, profile_id: profile.id, scope_fingerprint: profileScope.fingerprint,
        can_grant: !!profileScope.fingerprint && !this.eligible(goalId), model_ready: !!ready && cfg.controlPlane?.enabled === true,
        block_reasons: [...new Set(blocks)] };
    });
    return { scope_fingerprint: scope.fingerprint, model_configured: !!selectedScope.model,
      model_ready: readiness.ready && (cfg.audience?.modelEnabled === true || !!eligible) && cfg.controlPlane?.enabled === true,
      source_current: sourceCurrent, evidence_ready: nextPacket.ready, source_summary: nextPacket.source_summary,
      pending_assessment: pending, can_grant: !!scope.fingerprint && !this.eligible(goalId), grants,
      profile_options: profileOptions, allowed_base_urls: catalog.allowed_base_urls, credential_ready: catalog.credential_ready,
      active_grant_id: eligible?.id ?? null, ready: reasons.length === 0, block_reasons: [...new Set(reasons)], ...AUTHORITY };
  }
  assertGrantRequest(p) {
    check(validateGrant(p) && p.reason.trim().length > 0, 'AUDIENCE_FIELDS_INVALID', 400);
    check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(p.expires_at)
      && Date.parse(p.expires_at) > Date.now() && Date.parse(p.expires_at) <= Date.now() + 7 * 86400000,
    'AUDIENCE_ATTENTION_EXPIRY_INVALID', 400);
    const scope = this.scope(p.goal_id, p.model_profile_id);
    check(scope.goal.revision === p.expected_revision && scope.fingerprint !== null && scope.fingerprint === p.expected_scope_fingerprint,
      'AUDIENCE_STALE_BASIS');
    return scope;
  }
  grant(p) {
    const scope = this.assertGrantRequest(p);
    check(!this.eligible(p.goal_id), 'AUDIENCE_ATTENTION_ALREADY_GRANTED');
    const row = { id: id(), partner_id: this.partnerId, goal_id: p.goal_id, goal_revision: p.expected_revision,
      scope_fingerprint: p.expected_scope_fingerprint, max_attempts: p.max_attempts,
      expires_at: p.expires_at, reason: p.reason.trim(), created_at: now() };
    const binding = scope.profile ? { model_profile_id: scope.profile.profile_id, definition_hash: scope.profile.definition_hash } : null;
    const fp = digest(this.definition(row, binding));
    this.db.run("INSERT INTO audience_attention_grants VALUES(?,?,?,?,?,?,?,?,?,?,'active',NULL,NULL)",
      row.id, row.partner_id, row.goal_id, row.goal_revision, row.scope_fingerprint, row.max_attempts, row.expires_at, row.reason, row.created_at, fp);
    if (binding) this.db.run('INSERT INTO audience_attention_models VALUES(?,?,?)', row.id, binding.model_profile_id, binding.definition_hash);
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
    const run = this.db.get('SELECT * FROM runs WHERE id=? AND partner_id=?', runId, this.partnerId);
    let frozen;
    try { frozen = JSON.parse(run?.context_json); } catch { check(false, 'AUDIENCE_ATTENTION_BINDING_INVALID'); }
    check(run?.runtime === 'hermes-audience-v1' && frozen?.assessment_id === row.id && frozen.goal_id === row.goal_id,
      'AUDIENCE_ATTENTION_BINDING_INVALID');
    const profile = this.profile(grant, { historical: true });
    if (profile) {
      check(!frozen.packet?.reassessment && !frozen.packet?.reasoning_retry && frozen.model_profile?.id === profile.profile_id
        && frozen.model_profile?.definition_hash === profile.definition_hash && run.model === profile.model_config.model
        && ['provider','apiMode','baseUrl','model','maxOutputTokens','inputUsdPerMillion','outputUsdPerMillion']
          .every(key => frozen.model_config?.[key] === profile.model_config[key]), 'AUDIENCE_ATTENTION_BINDING_INVALID');
      if (run.status === 'completed') {
        let receipt;
        try { receipt = JSON.parse(run.result_json); } catch { check(false, 'AUDIENCE_ATTENTION_BINDING_INVALID'); }
        check(receipt?.model_profile && digest(receipt.model_profile) === digest(frozen.model_profile), 'AUDIENCE_ATTENTION_BINDING_INVALID');
      }
    } else check(!frozen.model_profile, 'AUDIENCE_ATTENTION_BINDING_INVALID');
    return grant;
  }
  assertRun(runId, row, frozenGrant) {
    const grant = this.assertHistory(runId, row, frozenGrant);
    // Remaining admission allowance is intentionally not checked: the last admitted turn may finish.
    check(this.live(grant), 'AUDIENCE_ATTENTION_REVOKED_OR_STALE');
  }
}
