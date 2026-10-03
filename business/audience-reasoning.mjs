import fs from 'node:fs';
import path from 'node:path';
import { ROOT, runtimeReadiness, usageAccounting } from './config.mjs';
// One bounded, no-tool Hermes turn per public slot. A durable assessment prevents a
// scheduler tick or process restart from silently purchasing another attempt.
import { outputSchema } from './audience.mjs';
import { id } from './store.mjs';
import { now, AppError } from './errors.mjs';
import { automaticBoundary, digest } from './source-ingestion.mjs';

const RUNTIME = 'hermes-audience-v1';
const INSTRUCTIONS = fs.readFileSync(path.join(ROOT, 'partner/audience-reasoning.md'), 'utf8');
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
      const packet = audience.detail(goalId);
      if (!packet.ready) continue;
      let capture;
      try {
        capture = audience.capture({ goal_id: goalId, expected_revision: packet.revision,
          expected_basis_fingerprint: packet.basis_fingerprint });
      } catch (error) {
        if (error instanceof AppError) continue;
        throw error;
      }
      const assessmentId = capture.assessment_id;
      const row = db.get('SELECT * FROM audience_assessments WHERE id=?', assessmentId);
      if (!row || row.status !== 'captured') continue;
      const runId = id(), contract = outputSchema;
      const assessmentPacket = JSON.parse(row.packet_json);
      const context = { input: { situation_id: goalId }, packet: assessmentPacket,
        output_contract: contract, router_instructions: INSTRUCTIONS };
      db.run(`INSERT INTO runs(id,partner_id,status,runtime,model,context_json,created_at)
        VALUES(?,?,'running',?,?,?,?)`, runId, cfg.partnerId, RUNTIME, cfg.runtime.model,
        JSON.stringify({ assessment_id: assessmentId, goal_id: goalId, packet: assessmentPacket,
          model_config: cfg.runtime, prompt_fingerprint: digest(INSTRUCTIONS), contract_fingerprint: digest(contract) }), now());
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
    result = { completed: false };
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
          service.audience.assertAssessmentCurrent(assessment);
          // The audience proposal validates and writes several needs in one call. Keep a bad
          // later need from leaving earlier partial proposals behind when we record invalid.
          db.db.exec('SAVEPOINT audience_model_proposal');
          try {
            service.audience.propose({ assessment_id: assessment.id, output: JSON.parse(result.final_response) }, 'model');
            db.db.exec('RELEASE SAVEPOINT audience_model_proposal');
          } catch (error) {
            db.db.exec('ROLLBACK TO SAVEPOINT audience_model_proposal');
            db.db.exec('RELEASE SAVEPOINT audience_model_proposal');
            throw error;
          }
          disposition = 'proposal_created';
        } catch (error) {
          if (!(error instanceof AppError) && !(error instanceof SyntaxError)) throw error;
          disposition = String(error.code ?? '').startsWith('CONTROL_') ? 'control_withheld'
            : error instanceof SyntaxError ? 'invalid_output' : error.code;
        }
      }
      if (assessment?.status === 'running' && disposition !== 'proposal_created') {
        const lower = disposition.toLowerCase();
        const status = lower.includes('stale') || lower.includes('basis') ? 'stale'
          : lower === 'invalid_output' || lower.startsWith('audience_')
            && !['audience_disabled', 'audience_model_disabled', 'audience_control_required'].includes(lower)
            ? 'invalid' : 'interrupted';
        db.run('UPDATE audience_assessments SET status=? WHERE id=? AND status=\'running\'', status, assessment.id);
      }
      const receipt = { disposition, goal_id: prepared.goalId, assessment_id: prepared.assessmentId,
        run_id: prepared.run.id, model_identity: modelIdentity(result?.model_identity),
        model_identity_reason: modelIdentity(result?.model_identity) ? null : 'runtime_identity_missing_or_invalid' };
      db.run(`UPDATE runs SET status=?,result_json=?,error=?,input_tokens=?,output_tokens=?,estimated_cost_usd=?,cost_status=?,finished_at=? WHERE id=?`,
        disposition === 'proposal_created' ? 'completed' : 'failed', JSON.stringify(receipt),
        disposition === 'proposal_created' ? null : disposition, usage.input, usage.output, usage.cost, usage.costStatus, now(), prepared.run.id);
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
