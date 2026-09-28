import fs from 'node:fs';
import path from 'node:path';
import { ROOT, runtimeReadiness, usageAccounting } from './config.mjs';
import { automaticBoundary, digest } from './source-ingestion.mjs';
import { proposalSchema } from './continuity.mjs';
import { id } from './store.mjs';
import { now, AppError } from './errors.mjs';

const RUNTIME = 'hermes-continuity-v1', CURSOR = 'partner-continuity-reason-v1';
const instructions = fs.readFileSync(path.join(ROOT, 'partner/continuity-reasoning.md'), 'utf8');
const modelIdentity = result => {
  const value = result?.model_identity;
  return value && Object.keys(value).sort().join(',') === 'model_id,model_version'
    && [value.model_id, value.model_version].every(v => typeof v === 'string' && /^[A-Za-z0-9._:/@+-]{1,200}$/.test(v))
    ? { model_id: value.model_id, model_version: value.model_version } : null;
};

function prepare(service) {
  const cfg = service.config;
  if (cfg.continuity?.enabled !== true || cfg.continuity?.modelEnabled !== true) return { disposition: 'disabled' };
  automaticBoundary(service);
  if (!runtimeReadiness(cfg, { decision: true }).ready) return { disposition: 'waiting_model' };
  const usage = service.store.get(`SELECT COUNT(*) n,COALESCE(SUM(estimated_cost_usd),0) cost,
    SUM(CASE WHEN cost_status='unknown' THEN 1 ELSE 0 END) unknown FROM runs WHERE created_at>=?`, now().slice(0, 10));
  if (usage.n >= cfg.runtime.maxRunsPerDay || cfg.runtime.dailyBudgetUsd !== null
    && (usage.unknown > 0 || usage.cost >= cfg.runtime.dailyBudgetUsd)) return { disposition: 'budget_blocked' };
  const cursor = service.store.get('SELECT cursor FROM channel_offsets WHERE channel=? AND account_id=?', CURSOR, cfg.partnerId)?.cursor ?? '';
  const page = (after, take, before = null) => service.store.all(`SELECT p.id FROM partner_threads p
    WHERE p.partner_id=? AND p.status='OPEN' AND p.attention=1 AND p.id>?
    ${before === null ? '' : 'AND p.id<=?'}
    AND NOT EXISTS (SELECT 1 FROM research_intents r WHERE r.thread_id=p.id
      AND r.status IN ('plan_requested','planning','proposed','waiting_sources','ready','reasoning','brief_proposed'))
    AND NOT EXISTS (SELECT 1 FROM partner_turns t WHERE t.thread_id=p.id AND
      (t.basis_revision=p.revision OR t.status IN ('running','captured','proposed'))) ORDER BY p.id LIMIT ?`,
    cfg.partnerId, after, ...(before === null ? [] : [before]), take);
  let rows = page(cursor, 10);
  if (cursor && rows.length < 10) rows = rows.concat(page('', 10 - rows.length, cursor));
  service.store.run('INSERT INTO channel_offsets VALUES(?,?,?) ON CONFLICT(channel,account_id) DO UPDATE SET cursor=excluded.cursor',
    CURSOR, cfg.partnerId, rows.at(-1)?.id ?? '');
  for (const row of rows) {
    const d = service.continuity.detail(row.id);
    if (!d.ready) continue;
    const capture = service.continuity.capture({ thread_id: d.id, expected_revision: d.revision, expected_basis_fingerprint: d.basis_fingerprint });
    const turn = service.continuity.turn(capture.turn_id), runId = id();
    const context = { input: { situation_id: d.id }, packet: turn.packet, output_contract: proposalSchema, router_instructions: instructions };
    service.store.run(`INSERT INTO runs(id,partner_id,status,runtime,model,context_json,created_at) VALUES(?,?,'running',?,?,?,?)`,
      runId, cfg.partnerId, RUNTIME, cfg.runtime.model, JSON.stringify({ turn_id: turn.id, model_config: cfg.runtime,
        prompt_fingerprint: digest(instructions), contract_fingerprint: digest(proposalSchema) }), now());
    service.store.run("UPDATE partner_turns SET status='running',producer='model',run_id=? WHERE id=?", runId, turn.id);
    return { run: service.store.get('SELECT * FROM runs WHERE id=?', runId), turn, context };
  }
  return { disposition: rows.length ? 'waiting_evidence' : 'idle' };
}

// Reuses HermesAdapter.decide: no tools/token, no new worker, no effect capability.
// One attempt per durable attention revision. Errors/restart require new evidence or
// explicit operator pause/resume; a scheduler tick is never retry authorization.
export async function processContinuity(service, runtime) {
  const prepared = await service.exclusive(() => service.store.transaction(() => prepare(service)));
  if (!prepared.run) return prepared;
  let result;
  try { result = await runtime.decide(prepared.run, prepared.context); }
  catch { result = { completed: false }; }
  try {
    return await service.exclusive(() => service.store.transaction(() => {
      const turn = service.continuity.turn(prepared.turn.id);
      if (turn.status !== 'running') return { disposition: 'interrupted' };
      const { input, output, cost, costStatus } = usageAccounting(JSON.parse(prepared.run.context_json).model_config, result?.usage);
      const tools = result?.tool_calls != null && (!Array.isArray(result.tool_calls) || result.tool_calls.length > 0)
        || result?.messages != null && !Array.isArray(result.messages)
        || result?.messages?.some(m => m?.role === 'tool' || m?.tool_calls?.length || m?.function_call);
      let disposition = 'model_failed';
      if (result?.completed === true && !result.error && !tools && typeof result.final_response === 'string'
        && Buffer.byteLength(result.final_response) <= 60000) {
        try {
          automaticBoundary(service);
          if (service.config.continuity?.enabled !== true || service.config.continuity?.modelEnabled !== true)
            throw new AppError('Continuity disabled during reasoning', 409, 'CONTINUITY_DISABLED');
          service.continuity.propose({ turn_id: turn.id, output: JSON.parse(result.final_response) }, 'model');
          disposition = 'proposal_created';
        } catch (error) {
          // Validation refusal is an outcome; a failed durable write is not.
          // Let SQLite/IO faults roll back the entire result transaction.
          if (!(error instanceof AppError) && !(error instanceof SyntaxError)) throw error;
          disposition = error.code === 'CONTINUITY_STALE_BASIS' ? 'stale'
            : ['CONTINUITY_DISABLED', 'READ_ONLY_BOUNDARY_REQUIRED'].includes(error.code) ? 'boundary_changed' : 'invalid_proposal';
        }
      }
      if (disposition !== 'proposal_created') service.store.run('UPDATE partner_turns SET status=? WHERE id=?', disposition === 'stale' ? 'stale' : 'failed', turn.id);
      service.store.run(`UPDATE runs SET status=?,result_json=?,error=?,input_tokens=?,output_tokens=?,estimated_cost_usd=?,cost_status=?,finished_at=? WHERE id=?`,
        disposition === 'proposal_created' ? 'completed' : 'failed', JSON.stringify({ disposition, turn_id: turn.id,
          model_identity: modelIdentity(result), model_identity_reason: modelIdentity(result) ? null : 'runtime_identity_missing_or_invalid' }),
        disposition === 'proposal_created' ? null : disposition, input, output, cost, costStatus, now(), prepared.run.id);
      return { disposition, turn_id: turn.id };
    }));
  } catch (error) {
    // If the result cannot commit, do not retry automatically or claim that billing
    // is known. Store recovery is the final fallback if the DB stays unavailable.
    await service.exclusive(() => service.store.transaction(() => {
      service.store.run("UPDATE partner_turns SET status='interrupted' WHERE id=? AND status='running'", prepared.turn.id);
      service.store.run("UPDATE runs SET status='interrupted',error='RESULT_PERSIST_FAILED',finished_at=? WHERE id=? AND status='running'", now(), prepared.run.id);
    }));
    throw error;
  }
}
