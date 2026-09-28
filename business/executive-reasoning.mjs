// One opt-in, no-tool Hermes turn per tick. The worker and provider path are reused.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, runtimeReadiness, usageAccounting } from './config.mjs';
import { id } from './store.mjs';
import { now, AppError } from './errors.mjs';
import { digest } from './source-ingestion.mjs';
import { planSchema } from './executive.mjs';
import { proposalSchema } from './continuity.mjs';

const RUNTIME = 'hermes-executive-v1', CURSOR = 'partner-executive-reasoning-v1';
const instructions = fs.readFileSync(path.join(ROOT, 'partner/executive-reasoning.md'), 'utf8');
const identity = value => value && typeof value === 'object' && Object.keys(value).sort().join(',') === 'model_id,model_version'
  && [value.model_id, value.model_version].every(v => typeof v === 'string' && /^[A-Za-z0-9._:/@+-]{1,200}$/.test(v)) ? value : null;

function prepare(service) {
  const cfg = service.config, ex = service.executive, db = service.store;
  if (cfg.executive?.enabled !== true || cfg.executive?.modelEnabled !== true || cfg.continuity?.enabled !== true) return { disposition: 'disabled' };
  ex.enabled();
  if (!runtimeReadiness(cfg, { decision: true }).ready) return { disposition: 'waiting_model' };
  const counts = db.get(`SELECT COUNT(*) n,COALESCE(SUM(estimated_cost_usd),0) cost,
    COALESCE(SUM(CASE WHEN cost_status='unknown' THEN 1 ELSE 0 END),0) unknown,
    COALESCE(SUM(CASE WHEN runtime=? THEN 1 ELSE 0 END),0) executive FROM runs WHERE created_at>=?`, RUNTIME, now().slice(0, 10));
  if (counts.n >= cfg.runtime.maxRunsPerDay || counts.executive >= cfg.executive.maxModelRunsPerDay
    || cfg.runtime.dailyBudgetUsd !== null && (counts.unknown > 0 || counts.cost >= cfg.runtime.dailyBudgetUsd)) return { disposition: 'budget_blocked' };
  const cursor = db.get('SELECT cursor FROM channel_offsets WHERE channel=? AND account_id=?', CURSOR, cfg.partnerId)?.cursor ?? '';
  const page = (after, take, before = null) => db.all(`SELECT * FROM research_intents WHERE partner_id=? AND id>?
    AND (status='plan_requested' OR (status='ready' AND allow_model=1)) ${before ? 'AND id<=?' : ''} ORDER BY id LIMIT ?`,
    cfg.partnerId, after, ...(before ? [before] : []), take);
  let rows = page(cursor, 10); if (cursor && rows.length < 10) rows = rows.concat(page('', 10 - rows.length, cursor));
  for (const row of rows) {
    db.run('INSERT INTO channel_offsets VALUES(?,?,?) ON CONFLICT(channel,account_id) DO UPDATE SET cursor=excluded.cursor', CURSOR, cfg.partnerId, row.id);
    const planning = row.status === 'plan_requested', slot = planning ? 'plan' : 'brief';
    const attempt = db.get("SELECT * FROM research_attempts WHERE intent_id=? AND slot=? AND status='pending'", row.id, slot);
    if (!attempt) continue;
    try { ex.current(row, { packet: !planning }); if (planning) ex.assertBasis(row); }
    catch (e) { if (!(e instanceof AppError)) throw e; ex.terminate(row, 'superseded', e.code); continue; }
    const packet = JSON.parse(planning ? row.plan_packet_json : row.packet_json), runId = id();
    const contract = planning ? planSchema : proposalSchema;
    const context = { input: { situation_id: row.id }, mode: planning ? 'plan' : 'brief', packet,
      output_contract: contract, router_instructions: instructions };
    db.run(`INSERT INTO runs(id,partner_id,status,runtime,model,context_json,created_at) VALUES(?,?,'running',?,?,?,?)`,
      runId, cfg.partnerId, RUNTIME, cfg.runtime.model, JSON.stringify({ intent_id: row.id, attempt_id: attempt.id,
        mode: context.mode, packet, model_config: cfg.runtime, prompt_fingerprint: digest(instructions), contract_fingerprint: digest(contract) }), now());
    db.run("UPDATE research_attempts SET status='running',run_id=? WHERE id=?", runId, attempt.id);
    ex.update(row, { status: planning ? 'planning' : 'reasoning' });
    if (!planning) db.run("UPDATE partner_turns SET status='running',producer='model',run_id=? WHERE id=?", runId, row.turn_id);
    return { row, attempt, planning, context, run: db.get('SELECT * FROM runs WHERE id=?', runId) };
  }
  return { disposition: rows.length ? 'waiting_evidence' : 'idle' };
}

export async function processExecutive(service, runtime) {
  const prepared = await service.exclusive(() => service.store.transaction(() => prepare(service)));
  if (!prepared.run) return prepared;
  let result;
  try { result = await runtime.decide(prepared.run, prepared.context); }
  catch { result = { completed: false }; }
  const db = service.store, ex = service.executive;
  try {
    return await service.exclusive(() => db.transaction(() => {
      const row = ex.get(prepared.row.id), expected = prepared.planning ? 'planning' : 'reasoning';
      const { input, output, cost, costStatus } = usageAccounting(JSON.parse(prepared.run.context_json).model_config, result?.usage);
      const hasTools = result?.tool_calls != null && (!Array.isArray(result.tool_calls) || result.tool_calls.length !== 0)
        || result?.messages != null && (!Array.isArray(result.messages)
          || result.messages.some(m => !m || typeof m !== 'object' || ['tool','function'].includes(m.role)
            || m.tool_calls != null && (!Array.isArray(m.tool_calls) || m.tool_calls.length !== 0) || m.function_call));
      let disposition = row.status !== expected ? 'cancelled' : 'model_failed';
      if (row.status === expected && result?.completed === true && !result.error && !hasTools
        && typeof result.final_response === 'string' && Buffer.byteLength(result.final_response) <= 60000) {
        try {
          ex.current(row, { packet: !prepared.planning });
          if (service.config.executive?.modelEnabled !== true) throw new AppError('Model disabled', 409, 'EXECUTIVE_MODEL_DISABLED');
          if (prepared.planning) { ex.assertBasis(row); ex.applyPlan(row, JSON.parse(result.final_response)); }
          else ex.submit(row, JSON.parse(result.final_response), 'model');
          disposition = prepared.planning ? 'plan_recorded' : 'brief_proposed';
        } catch (e) {
          if (!(e instanceof AppError) && !(e instanceof SyntaxError)) throw e;
          disposition = e instanceof SyntaxError ? 'invalid_output' : e.code;
        }
      }
      const succeeded = ['plan_recorded', 'brief_proposed'].includes(disposition);
      if (!succeeded && row.status === expected) {
        ex.terminate(row, disposition.includes('STALE') || disposition.includes('AUTHORITY') || disposition.includes('REVOKED') ? 'superseded' : 'failed', disposition);
      }
      // Cancellation/reconciliation can retire the intent while the worker is away.
      // Release its turn when that worker returns, while still accounting for usage.
      if (!succeeded && row.turn_id) db.run("UPDATE partner_turns SET status='failed' WHERE id=? AND status='running'", row.turn_id);
      const modelIdentity = identity(result?.model_identity);
      const receipt = { outcome: disposition, intent_id: row.id, run_id: prepared.run.id,
        authority_hash: row.authority_hash, grant_version: row.grant_version, model_identity: modelIdentity,
        model_identity_reason: modelIdentity ? null : 'runtime_identity_missing_or_invalid' };
      db.run('UPDATE research_attempts SET status=?,receipt_json=?,finished_at=? WHERE id=?', succeeded ? 'succeeded' : 'failed', JSON.stringify(receipt), now(), prepared.attempt.id);
      db.run(`UPDATE runs SET status=?,result_json=?,error=?,input_tokens=?,output_tokens=?,estimated_cost_usd=?,cost_status=?,finished_at=? WHERE id=?`,
        succeeded ? 'completed' : 'failed', JSON.stringify(receipt), succeeded ? null : disposition, input, output, cost, costStatus, now(), prepared.run.id);
      return { disposition, intent_id: row.id };
    }));
  } catch (error) {
    // Durable result failures are not a semantic refusal. Roll back first, then retain
    // unknown billing and interrupt; recovery provides the same fallback after a crash.
    await service.exclusive(() => db.transaction(() => {
      db.run("UPDATE research_attempts SET status='interrupted_unknown',finished_at=? WHERE id=? AND status='running'", now(), prepared.attempt.id);
      db.run("UPDATE research_intents SET status='interrupted_unknown',reason='RESULT_PERSIST_FAILED',revision=revision+1,updated_at=? WHERE id=? AND status IN ('planning','reasoning')", now(), prepared.row.id);
      if (prepared.row.turn_id) db.run("UPDATE partner_turns SET status='interrupted' WHERE id=? AND status='running'", prepared.row.turn_id);
      db.run("UPDATE runs SET status='interrupted',error='RESULT_PERSIST_FAILED',finished_at=? WHERE id=? AND status='running'", now(), prepared.run.id);
    }));
    throw error;
  }
}
