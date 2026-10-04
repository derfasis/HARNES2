// Bounded, synthetic, no-tools model conformance run for the Audience assessment pipeline.
// The isolated database is written only under .cache and the model key is read from the
// caller's process environment, never from tracked configuration or printed output.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT, readJson } from '../business/config.mjs';
import { Store, id } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { HermesAdapter } from '../business/runtime.mjs';
import { processAudienceAssessment } from '../business/audience-reasoning.mjs';
import { validateOutput } from '../business/audience.mjs';

const SOURCE = 'public:synthetic-audience-conformance';
const MODEL_ID = /^[A-Za-z0-9._:/@+-]{1,200}$/;
const MAX_PROVIDER_ATTEMPTS = 3;

function args(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error('Arguments must use --name value form');
    if (key === '--help') return { help: true };
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    values[key.slice(2)] = value;
  }
  return values;
}

function usage() {
  return 'Usage: node scripts/audience-conformance.mjs --model ID --base-url URL [--provider custom]';
}

function safeModelConfig(options) {
  const model = options.model?.trim(), provider = options.provider?.trim() || 'custom';
  const baseUrl = options['base-url']?.trim();
  if (!model || !MODEL_ID.test(model)) throw new Error('A safe model ID is required');
  if (!baseUrl) throw new Error('A model base URL is required');
  const endpoint = new URL(baseUrl);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !(endpoint.protocol === 'https:' || endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)))
    throw new Error('Model URL must use HTTPS or loopback HTTP and contain no credentials/query');
  return { model, provider, baseUrl: baseUrl.replace(/\/$/, ''), apiMode: 'chat_completions' };
}

function syntheticConfig(model) {
  const config = structuredClone(readJson(path.join(ROOT, 'config/default.json')));
  config.runtime = { ...config.runtime, ...model, enabled: false, timeoutSeconds: 90, maxIterations: 2,
    maxOutputTokens: 1600, maxRunsPerDay: 1, dailyBudgetUsd: null };
  config.scheduler.enabled = false;
  config.telegram.enabled = false;
  config.telegram.liveSending = false;
  config.opportunity.automatic = true;
  config.opportunity.allowedSourceRefs = [SOURCE];
  config.audience = { ...config.audience, enabled: true, modelEnabled: true, maxRunsPerDay: 1 };
  config.continuity = { enabled: true, modelEnabled: false };
  config.workspace = { enabled: false, modelEnabled: false };
  config.controlPlane = { enabled: true, maxConcurrent: 2, reservationUsd: 0.25 };
  return config;
}

function acquireHistoryLock(cache) {
  const root = path.resolve(cache), lockPath = path.resolve(cache, 'summary.lock');
  if (!lockPath.toLowerCase().startsWith((root + path.sep).toLowerCase())) throw new Error('Invalid cache lock path');
  const lockId = randomUUID(), fd = fs.openSync(lockPath, 'wx', 0o600);
  fs.writeFileSync(fd, `${JSON.stringify({ lock_id: lockId, acquired_at_utc: new Date().toISOString() })}\n`, 'utf8');
  fs.fsyncSync(fd);
  return { path: lockPath, lockId, fd };
}

function writeHistory(cache, summaryPath, history, lockId) {
  const root = path.resolve(cache), target = path.resolve(summaryPath);
  if (!target.toLowerCase().startsWith((root + path.sep).toLowerCase())) throw new Error('Invalid cache summary path');
  const temporary = path.resolve(cache, `.summary-${lockId}-${randomUUID()}.tmp`);
  if (!temporary.toLowerCase().startsWith((root + path.sep).toLowerCase())) throw new Error('Invalid cache temporary path');
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, target); }
  catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
}

function releaseHistoryLock(cache, lock) {
  if (!lock) return;
  try { fs.closeSync(lock.fd); } catch {}
  const root = path.resolve(cache), lockPath = path.resolve(lock.path);
  if (!lockPath.toLowerCase().startsWith((root + path.sep).toLowerCase())) return;
  try {
    const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (current.lock_id === lock.lockId) fs.unlinkSync(lockPath);
  } catch { /* An uncertain lock is retained for manual inspection. */ }
}

function refreshHistoryTotals(history) {
  const attempts = history.attempts;
  const knownInputs = attempts.filter(item => Number.isInteger(item.input_tokens)).reduce((sum, item) => sum + item.input_tokens, 0);
  const knownOutputs = attempts.filter(item => Number.isInteger(item.output_tokens)).reduce((sum, item) => sum + item.output_tokens, 0);
  history.totals = {
    input_tokens: attempts.every(item => Number.isInteger(item.input_tokens)) ? knownInputs : null,
    output_tokens: attempts.every(item => Number.isInteger(item.output_tokens)) ? knownOutputs : null,
    known_input_tokens: knownInputs,
    known_output_tokens: knownOutputs,
    attempts_with_unknown_usage: attempts.filter(item => !Number.isInteger(item.input_tokens)
      || !Number.isInteger(item.output_tokens)).length,
    estimated_cost_usd: null,
    cost_status: 'unknown',
  };
}

function finalizeAttempt(history, attempt, run, runtimeResult, result, summaryPath, cache, lockId) {
  if (!attempt) return;
  const persisted = run ? JSON.parse(run.result_json ?? 'null') : null;
  Object.assign(attempt, {
    status: result?.disposition ?? 'runtime_failed',
    completed_at_utc: new Date().toISOString(),
    served_model_identity: persisted?.model_identity ?? null,
    input_tokens: Number.isInteger(run?.input_tokens) ? run.input_tokens : null,
    output_tokens: Number.isInteger(run?.output_tokens) ? run.output_tokens : null,
    estimated_cost_usd: typeof run?.estimated_cost_usd === 'number' ? run.estimated_cost_usd : null,
    cost_status: run?.cost_status ?? 'unknown',
    api_calls: Number.isInteger(runtimeResult?.api_calls) ? runtimeResult.api_calls : null,
  });
  refreshHistoryTotals(history);
  writeHistory(cache, summaryPath, history, lockId);
}

function diagnoseProposal(raw, packet) {
  if (typeof raw !== 'string' || !raw) return { stage: 'response', reason: 'empty_or_missing' };
  let output;
  try { output = JSON.parse(raw); }
  catch { return { stage: 'json_parse', reason: 'invalid_json' }; }
  if (!validateOutput(output)) return { stage: 'json_schema', reason: 'contract_mismatch',
    errors: (validateOutput.errors ?? []).slice(0, 8).map(error => ({ path: error.instancePath, keyword: error.keyword })) };
  const exchanges = new Map((packet?.exchanges ?? []).map(exchange => [exchange.id, exchange]));
  for (const need of output.needs) {
    const selected = need.exchange_ids.map(exchangeId => exchanges.get(exchangeId));
    if (selected.some(exchange => !exchange)) return { stage: 'domain_proof', reason: 'exchange_scope' };
    const evidence = new Map(selected.flatMap(exchange => exchange.evidence.map(item => [item.source_event_id, item.text])));
    const refs = [...new Set([...need.evidence_event_ids, ...need.counterevidence_event_ids])];
    if (!refs.every(ref => evidence.has(ref)) || !selected.every(exchange => exchange.evidence.some(item => refs.includes(item.source_event_id))))
      return { stage: 'domain_proof', reason: 'evidence_scope' };
    if (!need.support_quotes.every(quote => refs.includes(quote.source_event_id)
      && evidence.get(quote.source_event_id)?.includes(quote.quote))
      || !refs.every(ref => need.support_quotes.some(quote => quote.source_event_id === ref)))
      return { stage: 'domain_proof', reason: 'exact_quote_mismatch' };
    if (need.evidence_event_ids.some(ref => need.counterevidence_event_ids.includes(ref)))
      return { stage: 'domain_proof', reason: 'evidence_counterevidence_overlap' };
  }
  return null;
}

async function main() {
  const options = args(process.argv.slice(2));
  if (options.help) { process.stdout.write(`${usage()}\n`); return; }
  const model = safeModelConfig(options);
  if (!process.env.PARTNER_MODEL_API_KEY?.trim()) throw new Error('PARTNER_MODEL_API_KEY is absent; no model call was made');

  const cache = path.join(ROOT, '.cache', 'audience-conformance');
  fs.mkdirSync(cache, { recursive: true });
  const summaryPath = path.join(cache, 'summary.json');
  let lock = null, history, directory, currentAttempt = null;
  let store, service, runtime, grant;
  try {
    lock = acquireHistoryLock(cache);
    history = fs.existsSync(summaryPath) ? JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
      : { schema_version: 1, provider_attempt_count: 0, provider_attempt_cap: MAX_PROVIDER_ATTEMPTS,
        pre_provider_blocks: [], attempts: [] };
    if (!Number.isInteger(history.provider_attempt_count) || history.provider_attempt_count < 0
      || !Array.isArray(history.attempts) || !Array.isArray(history.pre_provider_blocks)
      || history.provider_attempt_count >= MAX_PROVIDER_ATTEMPTS)
      throw new Error('The three provider-attempt limit or cache history is invalid; no model call was made');
    directory = fs.mkdtempSync(path.join(cache, 'run-'));
    store = new Store(directory);
    const config = syntheticConfig(model);
    service = new BusinessService(store, config);
    runtime = new HermesAdapter(service, new Map());
    const actor = { kind: 'channel', sourceId: SOURCE };
    const ingest = (messageId, text, replyTo = null) => service.command('source.ingest', {
      source_id: SOURCE, source_kind: 'sanitized_fixture', message_id: messageId,
      author_id: `synthetic:${messageId}`, display_name: null, thread_id: null,
      reply_to_id: replyTo, version: 1, operation: 'upsert', text,
      created_at: new Date(Date.now() - 10 * 60_000).toISOString(), updated_at: new Date().toISOString(),
    }, id(), actor);

    const goal = await service.command('audience.open', { title: 'Synthetic audience conformance',
      objective: 'Find a real, unanswered setup question that warrants a concise owner-reviewed guide.',
      source_ids: [SOURCE], max_age_seconds: 3600 }, id(), { kind: 'operator' });
    await ingest('solved-question', 'How do I start the beginner workbook? I cannot find the first exercise.');
    await ingest('solved-reply', 'Open the pinned Start Here post, then choose the first workbook link.', 'solved-question');
    await ingest('unanswered-question', 'Where can I download the worksheet for the Sunday practice session?');
    await ingest('unrelated-noise', 'Good morning everyone! Hope you all have a lovely day.');
    service.audience.reconcile({ limit: 10, event_limit: 20 });
    const detail = service.audience.detail(goal.goal_id);
    grant = await service.command('audience.attention_grant', {goal_id:goal.goal_id,
      expected_revision:detail.revision,expected_scope_fingerprint:detail.attention.scope_fingerprint,
      max_attempts:1,expires_at:new Date(Date.now()+15*60_000).toISOString(),
      reason:'One finite synthetic conformance turn explicitly requested through this test CLI.'},id(),{kind:'operator'});

    const runtimeCapture = {};
    const observedRuntime = { async decide(run, context) {
      const attempt = { attempt: history.provider_attempt_count + 1, run_id: run.id,
        reserved_at_utc: new Date().toISOString(), status: 'reserved',
        requested_model_id: model.model, served_model_identity: null,
        input_tokens: null, output_tokens: null, estimated_cost_usd: null,
        cost_status: 'unknown', api_calls: null };
      history.attempts.push(attempt);
      history.provider_attempt_count++;
      refreshHistoryTotals(history);
      writeHistory(cache, summaryPath, history, lock.lockId);
      currentAttempt = attempt;
      const output = await runtime.decide(run, context);
      runtimeCapture.output = output;
      return output;
    } };
    const result = await processAudienceAssessment(service, observedRuntime);
    const runs = store.all("SELECT id,status,runtime,model,input_tokens,output_tokens,estimated_cost_usd,cost_status,result_json FROM runs WHERE runtime='hermes-audience-v1' ORDER BY created_at DESC");
    const assessment = result.assessment_id ? service.audience.assessment(result.assessment_id) : null;
    const needs = result.goal_id ? service.audience.detail(result.goal_id).needs : [];
    if (!runs[0]) {
      history.pre_provider_blocks.push({ disposition: result.disposition, model_call_made: false,
        external_contacts: 0, observed_at_utc: new Date().toISOString() });
      writeHistory(cache, summaryPath, history, lock.lockId);
      process.stdout.write(`${JSON.stringify({ synthetic: true, attempted_model_run: false,
        disposition: result.disposition, external_contacts: 0, report_saved: false }, null, 2)}\n`);
      process.exitCode = 2;
      return;
    }
    const receipt = runs[0]?.result_json ? JSON.parse(runs[0].result_json) : null;
    const toolCalls = runtimeCapture.output?.tool_calls;
    const toolCallCount = Array.isArray(toolCalls) ? toolCalls.length : null;
    const packetEvidence = assessment?.packet?.exchanges?.flatMap(exchange => exchange.evidence) ?? [];
    const messages = observedRuntime && runtimeCapture.output?.messages;
    const noToolsObserved = toolCallCount !== null
      ? toolCallCount === 0
      : Array.isArray(messages) && messages.every(message => message && typeof message === 'object'
        && !['tool', 'function'].includes(message.role) && !message.function_call
        && (message.tool_calls == null || Array.isArray(message.tool_calls) && message.tool_calls.length === 0));
    const report = {
      synthetic: true,
      external_contacts: 0,
      model: { provider: model.provider, requested_model_id: model.model, base_url: model.baseUrl },
      disposition: result.disposition,
      run: { status: runs[0].status, runtime: runs[0].runtime, requested_model_id: runs[0].model,
        input_tokens: runs[0].input_tokens, output_tokens: runs[0].output_tokens,
        estimated_cost_usd: runs[0].estimated_cost_usd, cost_status: runs[0].cost_status },
      receipt,
      served_model_identity: receipt?.model_identity ?? null,
      assessment: assessment ? { status: assessment.status, exchange_count: assessment.packet?.exchanges?.length ?? null } : null,
      database_counts: {
        audience_assessments: store.get('SELECT COUNT(*) n FROM audience_assessments WHERE goal_id=?', result.goal_id)?.n ?? 0,
        audience_exchanges: store.get('SELECT COUNT(*) n FROM audience_exchanges WHERE goal_id=?', result.goal_id)?.n ?? 0,
        audience_needs: store.get('SELECT COUNT(*) n FROM audience_needs WHERE goal_id=?', result.goal_id)?.n ?? 0,
        audience_runs: store.get("SELECT COUNT(*) n FROM runs WHERE runtime='hermes-audience-v1'")?.n ?? 0,
      },
      runtime_observation: {
        tool_call_count: toolCallCount,
        api_calls: Number.isInteger(runtimeCapture.output?.api_calls) ? runtimeCapture.output.api_calls : null,
      },
      effective_test_config: {
        runtime_enabled: config.runtime.enabled,
        audience_enabled: config.audience.enabled,
        audience_model_enabled: config.audience.modelEnabled,
        scheduler_enabled: config.scheduler.enabled,
        telegram_enabled: config.telegram.enabled,
        telegram_live_sending: config.telegram.liveSending,
        control_plane_enabled: config.controlPlane.enabled,
        control_plane_max_concurrent: config.controlPlane.maxConcurrent,
        max_runs_per_day: config.runtime.maxRunsPerDay,
        max_provider_attempts: MAX_PROVIDER_ATTEMPTS,
        max_iterations: config.runtime.maxIterations,
        timeout_seconds: config.runtime.timeoutSeconds,
      },
      need_count: needs.length,
      checks: {
        solved_question_fixture_present: packetEvidence.some(item => item.text?.includes('beginner workbook'))
          && packetEvidence.some(item => item.text?.includes('pinned Start Here post')),
        unrelated_noise_fixture_present: packetEvidence.some(item => item.text?.includes('lovely day')),
        no_tools_observed: noToolsObserved,
        runtime_disabled: config.runtime.enabled === false,
        audience_enabled_for_test: config.audience.enabled === true && config.audience.modelEnabled === true,
        scheduler_disabled: config.scheduler.enabled === false,
        telegram_disabled: config.telegram.enabled === false && config.telegram.liveSending === false,
        control_plane_enabled_for_test: config.controlPlane.enabled === true && config.controlPlane.maxConcurrent === 2,
      },
      evidence_store: directory,
      decision_review: assessment?.decision_review ?? null,
      output_contract_valid: ['proposal_created','no_need_proposed'].includes(result.disposition)
        && assessment?.decision_review?.state === 'current',
      invalid_output_diagnosis: result.disposition === 'invalid_output'
        ? diagnoseProposal(runtimeCapture.output?.final_response, assessment?.packet) : null,
      needs: needs.map(need => ({
        status: need.status, epistemic_status: need.epistemic_status, current: need.current,
        owner_review: 'pending_not_accepted',
        title: need.title, hypothesis: need.hypothesis, why_now: need.why_now,
        next_step: need.next_step, reason: need.reason, unknowns: need.unknowns,
        evidence_event_ids: need.evidence_event_ids, counterevidence_event_ids: need.counterevidence_event_ids,
        support_quotes: need.support_quotes,
      })),
    };
    finalizeAttempt(history, currentAttempt, runs[0], runtimeCapture.output, result, summaryPath, cache, lock.lockId);
    const reportPath = path.join(cache, 'latest.json');
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ ...report, cumulative_provider_attempts: history.provider_attempt_count,
      summary_path: summaryPath, report_path: reportPath }, null, 2)}\n`);
    if (!report.output_contract_valid) process.exitCode = 2;
  } finally {
    runtime?.close();
    if (service) {
      service.config.audience.modelEnabled=false;
      if (grant) try { await service.command('audience.attention_revoke',{grant_id:grant.grant_id,
        expected_grant_fingerprint:grant.grant_fingerprint,reason:'Finite conformance ended.'},id(),{kind:'operator'}); } catch { /* process exit cannot restore test authority */ }
    }
    try { service?.control?.close(); service?.control?.releaseProcess(); } catch {}
    try { store?.close(); } catch {}
    // Keep the isolated synthetic receipts, usage and grant closure for inspection.
    // They contain no provider credentials; the attempt cap is never reset here.
    releaseHistoryLock(cache, lock);
  }
}

main().catch(error => {
  // Deliberately omit error messages from provider/setup failures; they can contain request details.
  process.stderr.write(`Audience conformance did not complete (${error?.name || 'Error'}).\n`);
  process.exitCode = 1;
});
