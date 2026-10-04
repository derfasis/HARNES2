import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJson, runtimeReadiness, usageAccounting } from './config.mjs';
// One bounded, no-tool Hermes turn per public slot. A durable assessment prevents a
// scheduler tick or process restart from silently purchasing another attempt.
import { outputSchema } from './audience.mjs';
import { id } from './store.mjs';
import { now, AppError } from './errors.mjs';
import { automaticBoundary, digest } from './source-ingestion.mjs';
import { normalizeFailureCause } from './failure-cause.mjs';
import { audienceModelPacket } from './audience-decisions.mjs';

const RUNTIME = 'hermes-audience-v1';
const INSTRUCTIONS = fs.readFileSync(path.join(ROOT, 'partner/audience-reasoning.md'), 'utf8');
const OWNER_LANGUAGE = readJson(path.join(ROOT, 'partner/profile.json')).language;
const modelIdentity = value => value && typeof value === 'object' && Object.keys(value).sort().join(',') === 'model_id,model_version'
  && [value.model_id, value.model_version].every(v => typeof v === 'string' && /^[A-Za-z0-9._:/@+-]{1,200}$/.test(v)) ? value : null;

function prepare(service) {
  const cfg = service.config, db = service.store, audience = service.audience;
  if (cfg.audience?.enabled !== true || cfg.audience?.modelEnabled !== true) return { disposition: 'disabled' };
  if (cfg.controlPlane?.enabled !== true) throw new AppError('Audience model reasoning requires Control Plane admission', 409, 'AUDIENCE_CONTROL_REQUIRED');
  automaticBoundary(service);
  if (!runtimeReadiness(cfg, { decision: true }).ready) return { disposition: 'waiting_model' };
  const counts = db.get(`SELECT COUNT(*) n,COALESCE(SUM(estimated_cost_usd),0) cost,
    COALESCE(SUM(CASE WHEN cost_status='unknown' AND (status NOT IN ('running','analyzed') OR NOT EXISTS
      (SELECT 1 FROM control_tickets t WHERE t.run_id=runs.id AND t.status IN ('reserved','running'))) THEN 1 ELSE 0 END),0) unknown,
    COALESCE(SUM(CASE WHEN runtime=? THEN 1 ELSE 0 END),0) audience FROM runs WHERE partner_id=? AND created_at>=?`,
    RUNTIME, cfg.partnerId, now().slice(0, 10));
  if (counts.n >= cfg.runtime.maxRunsPerDay || counts.audience >= cfg.audience.maxRunsPerDay
    || cfg.runtime.dailyBudgetUsd !== null && (counts.unknown > 0 || counts.cost >= cfg.runtime.dailyBudgetUsd)) return { disposition: 'budget_blocked' };

  let cursor = db.get('SELECT cursor FROM channel_offsets WHERE channel=? AND account_id=?', 'audience-reason-v1', cfg.partnerId)?.cursor ?? '';
  const seen = new Set();
  // The domain cursor chooses which public plane gets a turn. This inner cursor fairly rotates
  // through goals, with wraparound, and an assessment itself fixes the exact evidence batch.
  for (let pageNo = 0; pageNo < 2; pageNo++) {
    const page = audience.list({ limit: 50, cursor });
    const goals = Array.isArray(page) ? page : page?.items ?? page?.goals ?? [];
    if (!goals.length) {
      if (cursor) { cursor = ''; continue; }
      break;
    }
    for (const item of goals) {
      const goalId = item.id ?? item.goal_id;
      if (!goalId || seen.has(goalId)) continue;
      seen.add(goalId);
      cursor = goalId;
      db.run('INSERT INTO channel_offsets VALUES(?,?,?) ON CONFLICT(channel,account_id) DO UPDATE SET cursor=excluded.cursor',
        'audience-reason-v1', cfg.partnerId, cursor);
      // Only a focused packet explicitly requested for a model may resume from
      // captured. Existing manual captures remain manual and retain their fence.
      let grant = null;
      let row = db.get("SELECT * FROM audience_assessments WHERE goal_id=? AND status='captured' ORDER BY rowid LIMIT 1", goalId);
      if (row) {
        try {
          const capturedPacket = JSON.parse(row.packet_json);
          if (!capturedPacket || typeof capturedPacket !== 'object' || Array.isArray(capturedPacket))
            throw new AppError('Invalid audience packet', 409, 'AUDIENCE_RECORD_INVALID');
          if (!capturedPacket.reassessment && !capturedPacket.reasoning_retry) continue;
          audience.assertAssessmentCurrent(row);
        } catch (error) {
          if (!(error instanceof AppError) && !(error instanceof SyntaxError)) throw error;
          db.run("UPDATE audience_assessments SET status='stale' WHERE id=? AND status='captured'", row.id);
          audience.record('reassessment_withheld', { assessment_id: row.id, reason: error.code ?? 'AUDIENCE_RECORD_INVALID' });
          continue;
        }
      } else {
        grant = service.attention.eligible(goalId);
        if (!grant) continue;
        const packet = audience.detail(goalId, { hypothesisMemory: true });
        if (!packet.ready) continue;
        try {
          const capture = audience.capture({ goal_id: goalId, expected_revision: packet.revision,
            expected_basis_fingerprint: packet.basis_fingerprint });
          row = db.get('SELECT * FROM audience_assessments WHERE id=?', capture.assessment_id);
        } catch (error) {
          if (error instanceof AppError) continue;
          throw error;
        }
      }
      if (!row || row.status !== 'captured') continue;
      audience.assertAssessmentCurrent(row);
      const assessmentId = row.id;
      const runId = id(), contract = outputSchema;
      const assessmentPacket = JSON.parse(row.packet_json);
      const context = { input: { situation_id: goalId }, owner_language: OWNER_LANGUAGE, assessment_created_at:row.created_at,
        packet: audienceModelPacket(assessmentPacket),
        output_contract: contract, router_instructions: INSTRUCTIONS };
      db.run(`INSERT INTO runs(id,partner_id,status,runtime,model,context_json,created_at)
        VALUES(?,?,'running',?,?,?,?)`, runId, cfg.partnerId, RUNTIME, cfg.runtime.model,
        JSON.stringify({ assessment_id: assessmentId, goal_id: goalId, owner_language: OWNER_LANGUAGE, packet: assessmentPacket,
          ...(grant ? { attention_grant: { id: grant.id, grant_fingerprint: grant.grant_fingerprint } } : {}),
          model_config: cfg.runtime, prompt_fingerprint: digest(INSTRUCTIONS), contract_fingerprint: digest(contract),
          decision_contract_version:1,model_input_fingerprint:digest(context),model_projection_version:1 }), now());
      if (grant) service.attention.bind(grant, row, runId);
      if (service.control) service.control.bindRun(runId);
      const changed = db.run("UPDATE audience_assessments SET status='running',producer='model',run_id=? WHERE id=? AND status='captured'", runId, assessmentId);
      if (changed.changes !== 1) {
        db.run("UPDATE runs SET status='interrupted',error='ASSESSMENT_RETIRED',finished_at=? WHERE id=?", now(), runId);
        continue;
      }
      return { goalId, assessmentId, run: db.get('SELECT * FROM runs WHERE id=?', runId), context };
    }
    const next = page?.next_cursor ?? page?.nextCursor ?? null;
    if (next) { cursor = next; continue; }
    cursor = '';
  }
  return { disposition: seen.size ? 'waiting_evidence' : 'idle' };
}

async function processAudienceInternal(service, runtime) {
  const prepared = await service.exclusive(() => service.store.transaction(() => prepare(service)));
  if (!prepared.run) return prepared;
  let result, controlDenial = null;
  try { result = await runtime.decide(prepared.run, prepared.context); }
  catch (error) {
    if (String(error?.code ?? '').startsWith('CONTROL_')) controlDenial = error.code;
    result = { completed: false, failure_cause: normalizeFailureCause(error?.failure_cause) };
  }
  const db = service.store;
  try {
    return await service.exclusive(() => db.transaction(() => {
      const assessment = db.get('SELECT * FROM audience_assessments WHERE id=?', prepared.assessmentId);
      const usage = usageAccounting(JSON.parse(prepared.run.context_json).model_config, result?.usage);
      const hasTools = result?.tool_calls != null && (!Array.isArray(result.tool_calls) || result.tool_calls.length !== 0)
        || result?.messages != null && (!Array.isArray(result.messages)
          || result.messages.some(m => !m || typeof m !== 'object' || ['tool','function'].includes(m.role)
            || m.tool_calls != null && (!Array.isArray(m.tool_calls) || m.tool_calls.length !== 0) || m.function_call));
      let disposition = assessment?.status !== 'running' ? 'interrupted' : controlDenial ? 'control_withheld' : 'model_failed';
      if (assessment?.status === 'running' && result?.completed === true && !result.error && !hasTools
        && typeof result.final_response === 'string' && Buffer.byteLength(result.final_response) <= 60000) {
        try {
          if (service.control && !service.control.canApply(prepared.run.id))
            throw new AppError('Control-plane result is no longer applicable', 409, 'CONTROL_RESULT_WITHHELD');
          if (service.config.audience?.enabled !== true || service.config.audience?.modelEnabled !== true)
            throw new AppError('Audience model reasoning disabled', 409, 'AUDIENCE_MODEL_DISABLED');
          if (service.config.controlPlane?.enabled !== true)
            throw new AppError('Audience model reasoning requires Control Plane admission', 409, 'AUDIENCE_CONTROL_REQUIRED');
          automaticBoundary(service);
          const frozen = JSON.parse(prepared.run.context_json);
          const liveRun = db.get('SELECT status,context_json FROM runs WHERE id=?',prepared.run.id);
          if (liveRun?.status !== 'running' || liveRun.context_json !== prepared.run.context_json
            || frozen.decision_contract_version !== 1 || frozen.model_projection_version !== 1
            || frozen.model_input_fingerprint !== digest(prepared.context)
            || assessment.run_id !== prepared.run.id || assessment.goal_id !== frozen.goal_id
            || digest(JSON.parse(assessment.packet_json)) !== digest(frozen.packet))
            throw new AppError('Audience run packet changed', 409, 'AUDIENCE_RECORD_INVALID');
          service.audience.assertAssessmentCurrent(assessment);
          const packet = JSON.parse(assessment.packet_json);
          if (!packet.reassessment && !packet.reasoning_retry) service.attention.assertRun(prepared.run.id, assessment, frozen.attention_grant);
          const output = JSON.parse(result.final_response);
          // The audience proposal validates and writes several needs in one call. Keep a bad
          // later need from leaving earlier partial proposals behind when we record invalid.
          db.db.exec('SAVEPOINT audience_model_proposal');
          try {
            service.audience.propose({ assessment_id: assessment.id, output }, 'model');
            db.db.exec('RELEASE SAVEPOINT audience_model_proposal');
          } catch (error) {
            db.db.exec('ROLLBACK TO SAVEPOINT audience_model_proposal');
            db.db.exec('RELEASE SAVEPOINT audience_model_proposal');
            throw error;
          }
          disposition = output.needs.length ? 'proposal_created' : packet.reassessment ? 'no_revision_proposed' : 'no_need_proposed';
        } catch (error) {
          if (!(error instanceof AppError) && !(error instanceof SyntaxError)) throw error;
          disposition = String(error.code ?? '').startsWith('CONTROL_') ? 'control_withheld'
            : error instanceof SyntaxError ? 'invalid_output' : error.code;
        }
      }
      const applied = ['proposal_created', 'no_revision_proposed', 'no_need_proposed'].includes(disposition);
      if (assessment?.status === 'running' && !applied) {
        const lower = disposition.toLowerCase();
        const status = lower.includes('stale') || lower.includes('basis') ? 'stale'
          : lower === 'invalid_output' || lower.startsWith('audience_')
            && !['audience_disabled', 'audience_model_disabled', 'audience_control_required'].includes(lower)
            ? 'invalid' : 'interrupted';
        db.run('UPDATE audience_assessments SET status=? WHERE id=? AND status=\'running\'', status, assessment.id);
      }
      const receipt = { disposition, goal_id: prepared.goalId, assessment_id: prepared.assessmentId,
        ...(applied ? {output_fingerprint:digest(JSON.parse(db.get('SELECT output_json FROM audience_assessments WHERE id=?',prepared.assessmentId).output_json))} : {}),
        run_id: prepared.run.id, model_identity: modelIdentity(result?.model_identity),
        model_identity_reason: modelIdentity(result?.model_identity) ? null : 'runtime_identity_missing_or_invalid',
        model_api_calls: Number.isInteger(result?.api_calls) && result.api_calls >= 0 && result.api_calls <= 1000 ? result.api_calls : null,
        failure_cause: result?.completed !== true && result?.failure_cause ? normalizeFailureCause(result.failure_cause) : null };
      db.run(`UPDATE runs SET status=?,result_json=?,error=?,input_tokens=?,output_tokens=?,estimated_cost_usd=?,cost_status=?,finished_at=? WHERE id=?`,
        applied ? 'completed' : 'failed', JSON.stringify(receipt),
        applied ? null : disposition, usage.input, usage.output, usage.cost, usage.costStatus, now(), prepared.run.id);
      return { disposition, goal_id: prepared.goalId, assessment_id: prepared.assessmentId };
    }));
  } catch (error) {
    // A failed durable receipt must never permit the same batch to be billed again.
    await service.exclusive(() => db.transaction(() => {
      db.run("UPDATE audience_assessments SET status='interrupted' WHERE id=? AND status='running'", prepared.assessmentId);
      db.run("UPDATE runs SET status='interrupted',error='RESULT_PERSIST_FAILED',finished_at=? WHERE id=? AND status='running'", now(), prepared.run.id);
    }));
    throw error;
  }
}

export async function processAudienceAssessment(service, runtime) {
  if (service.config.controlPlane?.enabled !== true) return processAudienceInternal(service, runtime);
  try { return await service.control.run('public', 'audience', () => processAudienceInternal(service, runtime)); }
  catch (error) {
    if (String(error?.code ?? '').startsWith('CONTROL_')) return { disposition: 'control_withheld' };
    throw error;
  }
}
