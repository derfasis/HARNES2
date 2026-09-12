import { id } from './store.mjs';
import { now } from './errors.mjs';
import { runtimeReadiness, usageAccounting } from './config.mjs';
import { captureOpportunity, consumeOpportunity } from './opportunity-consumer.mjs';
import { parseOpportunityOutput } from './opportunity-projection.mjs';
import { automaticBoundary, sourceContextState, SOURCE_MESSAGE, PIPELINE_FINISHED, finishSource } from './source-ingestion.mjs';

const RUNTIME = 'hermes-opportunity';
const MAX_ATTEMPTS = 3;
const terminalSource = new Set(['SOURCE_MESSAGE_SUPERSEDED','SOURCE_MESSAGE_DELETED','UNKNOWN_SOURCE_AUTHOR',
  'UNKNOWN_CONTEXT_AUTHOR','POST_ANCHOR_CONTEXT','SOURCE_NOT_ALLOWED','SUBJECT_SUPPRESSED','SOURCE_CONTEXT_CAPACITY_EXCEEDED']);
function disposition(service, run, value, extra = {}) {
  const context = JSON.parse(run.context_json);
  finishSource(service, context.source_event_id, value, { run_id: run.id, ...extra });
  service.store.run('UPDATE runs SET status=?,error=?,finished_at=? WHERE id=?', value === 'review_created' || value === 'no_opportunity' ? 'completed' : 'failed',
    ['review_created','no_opportunity'].includes(value) ? null : value, now(), run.id);
  return { disposition: value, ...extra };
}
// This commit includes result disposition, candidate event and task. A DB error
// rolls all of it back; the previously saved analyzed run remains resumable.
function complete(service, run) {
  const saved = JSON.parse(run.context_json), result = JSON.parse(run.result_json);
  const captured = service.opportunityCapture(saved.capture_id);
  if (!captured.freshness.fresh) return disposition(service, run, 'stale', { reasons: captured.freshness.reasons });
  let output;
  try { output = parseOpportunityOutput(result.final_response, captured.context); }
  catch { return disposition(service, run, 'invalid_model_output'); }
  const decision = output.next_action.decision;
  if (decision === 'PUBLIC_REPLY' && output.opportunity.hypothesis === null) return disposition(service, run, 'unsupported_active_move');
  if (captured.freshness.link?.ownership === 'HUMAN_OWNED' && ['PUBLIC_REPLY','DM'].includes(decision)) return disposition(service, run, 'human_owned_active_move');
  if (decision !== 'HANDOFF' && output.opportunity.hypothesis === null) return disposition(service, run, 'no_opportunity');
  const review = consumeOpportunity(service, { capture_id: saved.capture_id, output }, true);
  return disposition(service, run, 'review_created', review);
}
function prepare(service) {
  automaticBoundary(service);
  // Pick unfinished source events, not tasks. Existing review rows are NEVER jobs.
  const pending = service.store.all(`SELECT e.id FROM events e WHERE e.partner_id=? AND e.kind=? AND e.actor='system'
    AND NOT EXISTS (SELECT 1 FROM events d WHERE d.partner_id=e.partner_id AND d.kind=? AND d.actor='system'
      AND json_extract(d.payload_json,'$.source_event_id')=CAST(e.id AS TEXT)) ORDER BY e.id LIMIT 100`,
  service.config.partnerId, SOURCE_MESSAGE, PIPELINE_FINISHED);
  for (const source of pending) {
    const eventId = String(source.id);
    const attempts = service.store.all(`SELECT * FROM runs WHERE partner_id=? AND runtime=?
      AND json_extract(context_json,'$.source_event_id')=? ORDER BY rowid DESC`, service.config.partnerId, RUNTIME, eventId);
    const last = attempts[0];
    if (last?.status === 'analyzed') return { result: complete(service, last) };
    if (last?.status === 'running') continue;
    if (attempts.length >= MAX_ATTEMPTS) {
      finishSource(service, eventId, 'attempt_limit'); return { result: { disposition: 'attempt_limit' } };
    }
    if (last && Date.now() - Date.parse(last.finished_at ?? last.created_at) < service.config.scheduler.tickSeconds * 1000 * 2 ** (attempts.length - 1)) continue;
    let state, capture;
    try {
      state = sourceContextState(service, eventId);
      if (!service.config.opportunity.activeOffer) return { result: { disposition: 'waiting_offer' } };
      // No inference with stale evidence or an unavailable runtime. A saved
      // model result can still be consumed above without new model access.
      const ready = runtimeReadiness(service.config, { decision: true });
      if (!ready.ready) return { result: { disposition: 'waiting_model', missing: ready.missing } };
      const cfg = service.config.runtime;
      const usage = service.store.get(`SELECT COUNT(*) AS n,COALESCE(SUM(estimated_cost_usd),0) AS cost,
        SUM(CASE WHEN cost_status='unknown' THEN 1 ELSE 0 END) AS unknown FROM runs WHERE created_at>=?`, now().slice(0,10));
      if (usage.n >= cfg.maxRunsPerDay || cfg.dailyBudgetUsd !== null && (usage.unknown > 0 || usage.cost >= cfg.dailyBudgetUsd))
        return { result: { disposition: 'budget_blocked' } };
      capture = captureOpportunity(service, { snapshot: state.snapshot, ...(state.conversation_id ? { conversation_id: state.conversation_id } : {}) }, state.source_state);
    } catch (error) {
      if (!terminalSource.has(error.code) && error.code !== 'STALE_OR_FUTURE_SNAPSHOT') throw error;
      finishSource(service, eventId, error.code); return { result: { disposition: error.code } };
    }
    // The capture and run intent are durable in the SAME transaction.
    const runId = id();
    service.store.run(`INSERT INTO runs(id,partner_id,conversation_id,status,runtime,model,context_json,created_at)
      VALUES(?,?,?,?,?,?,?,?)`, runId, service.config.partnerId, null, 'running', RUNTIME, service.config.runtime.model,
    JSON.stringify({ source_event_id: eventId, capture_id: capture.capture_id, model_config: service.config.runtime }), now());
    service.store.event(service.config.partnerId, null, 'opportunity.inference.started', 'system', { source_event_id: eventId, run_id: runId });
    return { run: service.store.get('SELECT * FROM runs WHERE id=?', runId), context: capture.context };
  }
  return { result: { disposition: pending.length ? 'waiting_retry_or_running' : 'idle' } };
}
export async function processSourceOpportunity(service, runtime) {
  automaticBoundary(service);
  const prepared = await service.exclusive(() => service.store.transaction(() => prepare(service)));
  if (prepared.result) return prepared.result;
  let result;
  try { result = await runtime.decide(prepared.run, prepared.context); }
  catch { result = { completed: false, error: 'MODEL_FAILED' }; }
  // Never persist provider exceptions, credentials, tool transcripts or raw logs.
  const messages = Array.isArray(result?.messages) ? result.messages : [];
  const tools = result?.tool_calls?.length || result?.messages != null && !Array.isArray(result.messages)
    || messages.some(m => m?.role === 'tool' || m?.tool_calls?.length || m?.function_call);
  const ok = result?.completed === true && !result.error && !tools && typeof result.final_response === 'string'
    && Buffer.byteLength(result.final_response) <= 90000;
  try {
    await service.exclusive(() => service.store.transaction(() => {
    const { input, output, cost, costStatus } = usageAccounting(JSON.parse(prepared.run.context_json).model_config, result?.usage);
    const clean = { final_response: ok ? result.final_response : '', api_calls: Number.isSafeInteger(result?.api_calls) && result.api_calls >= 0 ? result.api_calls : null };
    service.store.run(`UPDATE runs SET status=?,result_json=?,error=?,input_tokens=?,output_tokens=?,estimated_cost_usd=?,cost_status=?,finished_at=?
      WHERE id=? AND status='running'`, ok ? 'analyzed' : 'failed', JSON.stringify(clean), ok ? null : 'MODEL_FAILED', input, output, cost, costStatus, now(), prepared.run.id);
  }));
  } catch (error) {
    // A one-off persistence failure must not leave this live process waiting
    // forever on its own abandoned 'running' claim. If SQLite is unavailable,
    // restart recovery remains the final fallback; never mark the event done.
    await service.exclusive(() => service.store.transaction(() => {
      service.store.run("UPDATE runs SET status='interrupted',error='RESULT_PERSIST_FAILED',finished_at=? WHERE id=? AND status='running'", now(), prepared.run.id);
    }));
    throw error;
  }
  if (!ok) return { disposition: 'model_failed' };
  return service.exclusive(() => service.store.transaction(() => {
    automaticBoundary(service);
    const run = service.store.get('SELECT * FROM runs WHERE id=?', prepared.run.id);
    if (run.status !== 'analyzed') return { disposition: 'result_already_handled' };
    return complete(service, run);
  }));
}
