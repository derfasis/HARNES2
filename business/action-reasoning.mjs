// Optional no-tool proposal only. Reuses Hermes and the shared global run ledger.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJson, runtimeReadiness, usageAccounting } from './config.mjs';
import { id } from './store.mjs';
import { now, AppError } from './errors.mjs';
import { digest } from './source-ingestion.mjs';
import { actionSchema, actionCheck as check } from './actions.mjs';

const RUNTIME = 'hermes-action-v1', CURSOR = 'action-reasoning-v1';
const instructions = fs.readFileSync(path.join(ROOT, 'partner/action-reasoning.md'), 'utf8');
const contract = readJson(path.join(ROOT, 'contracts/action-plan.schema.json'));
// Deliver a self-contained schema to the existing no-tool worker.
contract.properties.proposal.anyOf[1] = { ...actionSchema };
delete contract.properties.proposal.anyOf[1].$schema;
function prepare(service) {
  const cfg = service.config, db = service.store, a = service.actions;
  if (cfg.actions?.enabled !== true || cfg.actions?.modelEnabled !== true || cfg.continuity?.enabled !== true) return { disposition: 'disabled' };
  a.enabled();
  if (!runtimeReadiness(cfg, { decision: true }).ready) return { disposition: 'waiting_model' };
  const counts = db.get(`SELECT COUNT(*) n,COALESCE(SUM(estimated_cost_usd),0) cost,
    COALESCE(SUM(CASE WHEN cost_status='unknown' THEN 1 ELSE 0 END),0) unknown,
    COALESCE(SUM(CASE WHEN runtime=? THEN 1 ELSE 0 END),0) actions FROM runs WHERE created_at>=?`, RUNTIME, now().slice(0, 10));
  if (counts.n >= cfg.runtime.maxRunsPerDay || counts.actions >= cfg.actions.maxModelRunsPerDay
    || cfg.runtime.dailyBudgetUsd !== null && (counts.unknown > 0 || counts.cost >= cfg.runtime.dailyBudgetUsd)) return { disposition: 'budget_blocked' };
  for (const row of a.page(CURSOR, "status='plan_requested'", 10)) {
    a.advance(CURSOR, row);
    try { a.current(row, { enabled: true }); }
    catch (e) { if (!(e instanceof AppError)) throw e; a.retire(row, 'stale', e.code); continue; }
    const packet = JSON.parse(row.packet_json), runId = id();
    const context = { input: { situation_id: row.id }, mode: 'action_plan', packet,
      output_contract: contract, router_instructions: instructions };
    db.run(`INSERT INTO runs(id,partner_id,status,runtime,model,context_json,created_at) VALUES(?,?,'running',?,?,?,?)`,
      runId, cfg.partnerId, RUNTIME, cfg.runtime.model, JSON.stringify({ action_id: row.id, packet, model_config: cfg.runtime,
        prompt_fingerprint: digest(instructions), contract_fingerprint: digest(contract) }), now());
    a.update(row, { status: 'planning', run_id: runId });
    return { row, context, run: db.get('SELECT * FROM runs WHERE id=?', runId) };
  }
  return { disposition: 'idle' };
}
export async function processActionPlan(service, runtime) {
  const db = service.store, a = service.actions;
  const work = await service.exclusive(() => db.transaction(() => prepare(service)));
  if (!work.run) return work;
  let result;
  try { result = await runtime.decide(work.run, work.context); } catch { result = { completed: false }; }
  try {
    return await service.exclusive(() => db.transaction(() => {
      const row = a.get(work.row.id);
      const { input, output, cost, costStatus } = usageAccounting(JSON.parse(work.run.context_json).model_config, result?.usage);
      const tools = result?.tool_calls != null && (!Array.isArray(result.tool_calls) || result.tool_calls.length !== 0)
        || result?.messages != null && (!Array.isArray(result.messages) || result.messages.some(m => !m || typeof m !== 'object'
          || ['tool','function'].includes(m.role) || m.function_call || m.tool_calls != null && (!Array.isArray(m.tool_calls) || m.tool_calls.length !== 0)));
      let disposition = row.status !== 'planning' ? 'cancelled' : 'model_failed';
      if (row.status === 'planning' && result?.completed === true && !result.error && !tools
        && typeof result.final_response === 'string' && Buffer.byteLength(result.final_response) <= 20000) {
        try {
          check(service.config.actions?.modelEnabled === true, 'ACTION_MODEL_DISABLED');
          a.applyPlan(row, JSON.parse(result.final_response)); disposition = 'plan_recorded';
        } catch (e) {
          if (!(e instanceof AppError) && !(e instanceof SyntaxError)) throw e;
          disposition = e instanceof SyntaxError ? 'invalid_output' : e.code;
        }
      }
      const succeeded = disposition === 'plan_recorded';
      if (!succeeded && row.status === 'planning') a.update(row, { status: 'failed', reason: disposition });
      const identity = result?.model_identity;
      const validIdentity = identity && Object.keys(identity).sort().join(',') === 'model_id,model_version'
        && [identity.model_id, identity.model_version].every(v => typeof v === 'string' && /^[A-Za-z0-9._:/@+-]{1,200}$/.test(v));
      const receipt = { outcome: disposition, action_id: row.id, proposal_only: true,
        model_identity: validIdentity ? identity : null, model_identity_reason: validIdentity ? null : 'runtime_identity_missing_or_invalid' };
      db.run(`UPDATE runs SET status=?,result_json=?,error=?,input_tokens=?,output_tokens=?,estimated_cost_usd=?,cost_status=?,finished_at=? WHERE id=?`,
        succeeded ? 'completed' : 'failed', JSON.stringify(receipt), succeeded ? null : disposition, input, output, cost, costStatus, now(), work.run.id);
      a.record('plan_result', receipt); return { disposition, action_id: row.id };
    }));
  } catch (error) {
    await service.exclusive(() => db.transaction(() => {
      db.run("UPDATE action_proposals SET status='failed',reason='RESULT_PERSIST_FAILED',revision=revision+1,updated_at=? WHERE id=? AND status='planning'", now(), work.row.id);
      db.run("UPDATE runs SET status='interrupted',error='RESULT_PERSIST_FAILED',finished_at=? WHERE id=? AND status='running'", now(), work.run.id);
    }));
    throw error;
  }
}
