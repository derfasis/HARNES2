// Finite, synthetic experiment around the existing Audience/Hermes pipeline.
// No scheduler, production activation, tools, contact, or automatic retry.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT, readJson } from '../../business/config.mjs';
import { Store, id } from '../../business/store.mjs';
import { BusinessService } from '../../business/service.mjs';
import { HermesAdapter } from '../../business/runtime.mjs';
import { processAudienceAssessment } from '../../business/audience-reasoning.mjs';
import { digest } from '../../business/source-ingestion.mjs';
import { loadFrozenFidelity } from './freeze.mjs';

const CAP = 8;
const SEQUENCE = ['1A','1B','2A','2B','3A','3B','4A','4B'];
const OBJECTIVE = 'Find participants’ own commercial tasks in these supplied conversations. Preserve speaker, resources, conditions, alternative models and later status. Prepare only an internal owner brief; no external contact. Offer facts and compatibility are unknown. A task can be useful to understand even when it does not fit our offer.';
const EFFECT_TABLES = ['persons','contact_permissions','conversations','drafts','delivery_attempts','audience_work_links','action_proposals'];
const MODEL_ID = /^[A-Za-z0-9._:/@+-]{1,200}$/;
const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); };
const boundedJson = (filename, maximum = 2_000_000) => {
  check(fs.statSync(filename).size <= maximum, 'FIDELITY_FILE_TOO_LARGE');
  const bytes = fs.readFileSync(filename); check(bytes.length <= maximum, 'FIDELITY_FILE_TOO_LARGE');
  return JSON.parse(bytes.toString('utf8'));
};

function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    check(['--run','--review','--status','--help','--model','--base-url'].includes(key) && !(key in result), 'FIDELITY_ARGUMENT_INVALID');
    if (['--help','--status'].includes(key)) result[key] = true;
    else { const value = argv[++i]; check(typeof value === 'string' && !value.startsWith('--'), 'FIDELITY_ARGUMENT_INVALID'); result[key] = value; }
  }
  check(['--run','--review','--status','--help'].filter(k => result[k]).length === 1, 'FIDELITY_COMMAND_REQUIRED');
  check(result['--run'] || !result['--model'] && !result['--base-url'], 'FIDELITY_ARGUMENT_INVALID');
  return result;
}

function modelConfig(opts) {
  const model = opts['--model'], baseUrl = opts['--base-url'];
  check(typeof model === 'string' && MODEL_ID.test(model), 'FIDELITY_MODEL_INVALID');
  const url = new URL(baseUrl);
  check(!url.username && !url.password && !url.search && !url.hash &&
    (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)), 'FIDELITY_ENDPOINT_INVALID');
  check(process.env.PARTNER_MODEL_API_KEY?.trim(), 'FIDELITY_CREDENTIAL_ABSENT');
  return { model, provider: 'custom', baseUrl: baseUrl.replace(/\/$/, ''), apiMode: 'chat_completions' };
}

// Existing conformance CLI's exclusive lock, fsync and atomic summary replacement
// pattern, in a distinct namespace. A reservation is consumed even after a crash.
function acquire(cache) {
  const filename = path.join(cache, 'history.lock'), lock_id = randomUUID();
  const fd = fs.openSync(filename, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify({ lock_id, acquired_at: new Date().toISOString() })); fs.fsyncSync(fd); }
  catch (error) { fs.closeSync(fd); throw error; }
  return { filename, lock_id, fd };
}
function persist(cache, history, lock) {
  const temporary = path.join(cache, `.history-${lock.lock_id}-${randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(history, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, path.join(cache, 'history.json')); }
  catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
}
function release(lock) {
  if (!lock) return;
  try { fs.closeSync(lock.fd); } catch {}
  try { if (boundedJson(lock.filename, 4096).lock_id === lock.lock_id) fs.unlinkSync(lock.filename); } catch {}
}

function historyFor(cache, frozen) {
  const file = path.join(cache, 'history.json');
  if (!fs.existsSync(file)) return { version: 1, manifest_hash: frozen.manifest_hash,
    max_logical_attempts: CAP, logical_attempts: 0, requested_model: null, stop_reason: null, attempts: [] };
  const h = boundedJson(file);
  check(h.version === 1 && h.manifest_hash === frozen.manifest_hash && h.max_logical_attempts === CAP &&
    Array.isArray(h.attempts) && h.attempts.length <= CAP && h.logical_attempts === h.attempts.length &&
    h.attempts.every((a, i) => a.cell_id === SEQUENCE[i]), 'FIDELITY_HISTORY_INVALID');
  return h;
}

function cellConfig(model, source) {
  const config = structuredClone(readJson(path.join(ROOT, 'config/default.json')));
  config.runtime = { ...config.runtime, ...model, enabled: false, timeoutSeconds: 120,
    maxIterations: 2, maxOutputTokens: 5000, maxRunsPerDay: 1, dailyBudgetUsd: null };
  config.scheduler.enabled = false; config.telegram.enabled = false; config.telegram.liveSending = false;
  config.opportunity.automatic = true; config.opportunity.allowedSourceRefs = [source];
  config.audience = { ...config.audience, enabled: true, modelEnabled: true, maxRunsPerDay: 1 };
  config.continuity = { enabled: true, modelEnabled: false };
  config.workspace = { enabled: false, modelEnabled: false };
  config.controlPlane = { enabled: true, maxConcurrent: 2, reservationUsd: 0.25 };
  return config;
}

function bindPrompt(service, run, context, instructions) {
  const frozen = JSON.parse(run.context_json);
  const beforePacket = digest(context.packet), beforeGrant = digest(frozen.attention_grant);
  // A is canonical with LF line endings; B appends the frozen, general brief.
  // Mutate only this experimental prepared context before dispatch, and keep its
  // actual hashes in the durable run. Never relabel B as canonical A afterward.
  context.router_instructions = instructions;
  frozen.prompt_fingerprint = digest(instructions);
  frozen.model_input_fingerprint = digest(context);
  const replacement = JSON.stringify(frozen);
  check(service.store.run('UPDATE runs SET context_json=? WHERE id=? AND status=\'running\' AND context_json=?',
    replacement, run.id, run.context_json).changes === 1, 'FIDELITY_PROMPT_BIND_FAILED');
  run.context_json = replacement;
  check(beforePacket === digest(context.packet) && beforeGrant === digest(frozen.attention_grant), 'FIDELITY_BASIS_CHANGED');
  // IDs/capture clocks are regenerated by the real domain lifecycle. Bind the
  // controlled source/task fields separately so a B input drift cannot masquerade
  // as an instruction effect; do not claim byte-identical model inputs.
  const sourceTask = { owner_language: context.owner_language, title: context.packet.title,
    objective: context.packet.objective, exchanges: context.packet.exchanges.map(e => ({
      source_ref: e.source_ref, anchor_id: e.anchor_id, unsupported_count: e.unsupported_count,
      evidence: e.evidence.map(({ observed_at, confirmed_at, ...facts }) => facts),
    })).sort((a, b) => a.anchor_id.localeCompare(b.anchor_id)) };
  return { prompt_hash: digest(instructions), model_input_hash: digest(context), packet_hash: beforePacket,
    controlled_source_task_hash: digest(sourceTask) };
}

function noTools(output) {
  if (!Array.isArray(output?.tool_calls) || output.tool_calls.length !== 0) return false;
  return output.messages == null || Array.isArray(output.messages) && output.messages.every(m => m &&
    !['tool','function'].includes(m.role) && !m.function_call &&
    (m.tool_calls == null || Array.isArray(m.tool_calls) && m.tool_calls.length === 0));
}

async function runCell(opts, frozen, cache, history, lock) {
  const cellId = opts['--run'];
  check(!history.stop_reason, 'FIDELITY_STOPPED');
  check(history.logical_attempts < CAP && cellId === SEQUENCE[history.logical_attempts], 'FIDELITY_CELL_NOT_NEXT');
  const prior = history.attempts.at(-1);
  // Every semantic judgment is made by an independent reviewer after reading the
  // frozen oracle and exact output. No automatic "green" keyword evaluator.
  check(!prior || prior.status === 'completed' && prior.review &&
    (prior.arm === 'A' || prior.review.verdict === 'PASS'), 'FIDELITY_REVIEW_REQUIRED');
  const model = modelConfig(opts);
  check(!history.requested_model || digest(history.requested_model) === digest(model), 'FIDELITY_MODEL_CHANGED');
  const fixture = frozen.cases.cases[Number(cellId[0]) - 1], arm = cellId[1];
  const directory = fs.mkdtempSync(path.join(cache, 'cell-'));
  let store, service, runtime, grant, attempt, runtimeOutput, result, savedReport;
  try {
    store = new Store(directory); service = new BusinessService(store, cellConfig(model, fixture.source_ref));
    runtime = new HermesAdapter(service, new Map());
    const goal = await service.command('audience.open', { title: `Synthetic fidelity ${fixture.id}`,
      objective: OBJECTIVE, source_ids: [fixture.source_ref], max_age_seconds: 3600 }, id(), { kind: 'operator' });
    const actor = { kind: 'channel', sourceId: fixture.source_ref };
    for (const m of fixture.messages) await service.command('source.ingest', {
      source_id: fixture.source_ref, source_kind: 'sanitized_fixture', message_id: m.id,
      author_id: m.author_ref, display_name: null, thread_id: null, reply_to_id: m.reply_to,
      version: 1, operation: 'upsert', text: m.text,
      created_at: m.published_at, updated_at: m.published_at,
    }, id(), actor);
    service.audience.reconcile({ limit: 10, event_limit: 40 });
    const detail = service.audience.detail(goal.goal_id);
    const supplied = detail.exchanges.flatMap(e => e.evidence);
    check(fixture.messages.length === supplied.length && fixture.messages.every(m => supplied.some(e =>
      e.message_id === m.id && e.author_id === m.author_ref && e.text === m.text && e.published_at === m.published_at && !e.truncated)), 'FIDELITY_FIXTURE_NOT_COMPLETE');
    grant = await service.command('audience.attention_grant', { goal_id: goal.goal_id,
      expected_revision: detail.revision, expected_scope_fingerprint: detail.attention.scope_fingerprint,
      max_attempts: 1, expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      reason: 'One explicitly authorized, synthetic Stage0 test cell; no contact or enduring activation.' }, id(), { kind: 'operator' });
    result = await processAudienceAssessment(service, { async decide(run, context) {
      const bindings = bindPrompt(service, run, context, frozen.prompts[arm]);
      check(arm !== 'B' || history.attempts.at(-1)?.controlled_source_task_hash === bindings.controlled_source_task_hash,
        'FIDELITY_COMPARISON_INPUT_DRIFT');
      attempt = { cell_id: cellId, case_id: fixture.id, arm, run_id: run.id, directory,
        status: 'reserved', reserved_at: new Date().toISOString(), ...bindings,
        review: null, output_hash: null, served_model_identity: null,
        input_tokens: null, output_tokens: null, estimated_cost_usd: null, cost_status: 'unknown',
        upstream_wire_requests: null, retry_accounting: 'UNKNOWN', max_hermes_iterations: 2 };
      history.requested_model ??= model; history.attempts.push(attempt); history.logical_attempts++;
      persist(cache, history, lock); // write-ahead, before invoking the native adapter
      runtimeOutput = await runtime.decide(run, context);
      return runtimeOutput;
    } });
    check(attempt, 'FIDELITY_PRE_PROVIDER_BLOCK');
    const run = store.get('SELECT * FROM runs WHERE id=?', attempt.run_id);
    const receipt = run.result_json ? JSON.parse(run.result_json) : null;
    const assessment = result.assessment_id ? service.audience.assessment(result.assessment_id) : null;
    const counts = Object.fromEntries(EFFECT_TABLES.map(table => [table, store.get(`SELECT COUNT(*) n FROM ${table}`).n]));
    const accepted = ['proposal_created','no_need_proposed'].includes(result.disposition) &&
      assessment?.decision_review?.state === 'current';
    const output = assessment?.output ?? null;
    savedReport = { version: 1, synthetic: true, cell_id: cellId, case_id: fixture.id, arm,
      experiment_type: 'UNPAIRED_NATIVE_FIDELITY_OBSERVATIONS', causal_comparison: false,
      manifest_hash: frozen.manifest_hash, baseline_sha: frozen.manifest.baseline_sha,
      ...bindingsOf(attempt), disposition: result.disposition, output, output_hash: output ? digest(output) : null,
      // Unapplied responses are retained for diagnosing malformed JSON/contracts.
      raw_response: typeof runtimeOutput?.final_response === 'string' ? runtimeOutput.final_response : null,
      receipt, served_model_identity: receipt?.model_identity ?? null,
      usage: { input_tokens: run.input_tokens, output_tokens: run.output_tokens,
        estimated_cost_usd: run.estimated_cost_usd, cost_status: run.cost_status },
      reported_hermes_api_calls: Number.isInteger(runtimeOutput?.api_calls) ? runtimeOutput.api_calls : null,
      upstream_wire_requests: null, retry_accounting: 'UNKNOWN', comparative_attribution: 'INCONCLUSIVE_NONIDENTICAL_MODEL_INPUTS',
      declared_fixture_observed_at: fixture.observed_at, actual_capture_at: assessment?.created_at ?? null,
      nuisance_variation: ['domain_generated_goal_assessment_exchange_ids','actual_observation_capture_clocks'],
      semantic_verdict: 'NOT_REVIEWED', processing_basis: 'RESEARCHER_AUTHORED_SYNTHETIC_ONLY',
      evidence_store: directory, packet: assessment?.packet ?? null,
      decision_review: assessment?.decision_review ?? null, side_effect_counts: counts,
      checks: { output_applied_with_current_receipt: accepted, tools_empty: noTools(runtimeOutput),
        receipt_matches_actual_prompt: receipt?.model_input_fingerprint === attempt.model_input_hash &&
          JSON.parse(run.context_json).prompt_fingerprint === attempt.prompt_hash,
        all_fixture_messages_preserved: true, no_contact_artifacts: Object.values(counts).every(n => n === 0),
        production_runtime_disabled: service.config.runtime.enabled === false,
        telegram_disabled: service.config.telegram.enabled === false && service.config.telegram.liveSending === false,
        scheduler_disabled: service.config.scheduler.enabled === false },
      test_authority_closed: false };
    Object.assign(attempt, { status: Object.values(savedReport.checks).every(Boolean) ? 'completed' : 'blocked',
      completed_at: new Date().toISOString(), output_hash: savedReport.output_hash,
      served_model_identity: savedReport.served_model_identity, ...savedReport.usage,
      disposition: result.disposition });
    if (attempt.status !== 'completed') history.stop_reason = 'RUNTIME_OR_CONTRACT_OR_SAFETY_FAILURE';
  } catch (error) {
    if (attempt) { attempt.status = 'unknown'; attempt.completed_at = new Date().toISOString(); }
    history.stop_reason = attempt ? 'ATTEMPT_UNKNOWN_NO_RETRY' : 'PRE_PROVIDER_BLOCK';
    history.last_failure_code = /^FIDELITY_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'FIDELITY_RUNTIME_ERROR';
  } finally {
    runtime?.close();
    if (service) {
      service.config.audience.modelEnabled = false;
      let closed = !grant;
      if (grant) try {
        await service.command('audience.attention_revoke', { grant_id: grant.grant_id,
          expected_grant_fingerprint: grant.grant_fingerprint, reason: 'Finite synthetic Stage0 cell ended.' }, id(), { kind: 'operator' });
        closed = store.get('SELECT status FROM audience_attention_grants WHERE id=?', grant.grant_id)?.status === 'revoked';
      } catch { closed = false; }
      if (savedReport) savedReport.test_authority_closed = closed;
      if (!closed) { history.stop_reason = 'TEST_AUTHORITY_CLOSE_FAILED'; if (attempt) attempt.status = 'blocked'; }
      try { service.control?.close(); service.control?.releaseProcess(); } catch { history.stop_reason = 'CONTROL_CLOSE_FAILED'; }
    }
    try { store?.close(); } catch { history.stop_reason = 'STORE_CLOSE_FAILED'; }
    if (savedReport) {
      const reportPath = path.join(cache, `${cellId}.json`);
      const fd = fs.openSync(reportPath, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(savedReport, null, 2) + '\n'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      attempt.report_path = reportPath;
      attempt.report_hash = digest(savedReport);
    }
    persist(cache, history, lock);
  }
  process.stdout.write(JSON.stringify({ cell_id: cellId, status: attempt?.status ?? 'not_dispatched',
    logical_attempts: history.logical_attempts, max_logical_attempts: CAP, stop_reason: history.stop_reason,
    report_path: attempt?.report_path ?? null, semantic_verdict: 'NOT_REVIEWED' }) + '\n');
  if (history.stop_reason) process.exitCode = 2;
}

function bindingsOf(a) { return { prompt_hash: a.prompt_hash, model_input_hash: a.model_input_hash, packet_hash: a.packet_hash,
  controlled_source_task_hash: a.controlled_source_task_hash }; }

function recordReview(opts, frozen, cache, history, lock) {
  const review = boundedJson(opts['--review'], 100_000), attempt = history.attempts.at(-1);
  check(attempt?.status === 'completed' && !attempt.review && !history.stop_reason, 'FIDELITY_REVIEW_NOT_AVAILABLE');
  const gold = frozen.gold.cases.find(g => g.case_id === attempt.case_id);
  check(review.version === 1 && review.cell_id === attempt.cell_id && review.case_id === attempt.case_id &&
    review.output_hash === attempt.output_hash && review.gold_case_hash === digest(gold) &&
    typeof review.reviewer === 'string' && review.reviewer.trim() &&
    ['PASS','FAIL','UNKNOWN'].includes(review.verdict), 'FIDELITY_REVIEW_BINDING_INVALID');
  const checklist = { source_facts: gold.source_facts, required_distinctions: gold.required_distinctions,
    forbidden_claims: gold.forbidden_claims, critical_failures: gold.critical_failures };
  let allPass = true, anyFail = false;
  for (const [key, expected] of Object.entries(checklist)) {
    const rows = review[key];
    check(Array.isArray(rows) && rows.length === expected.length && rows.every((r, i) => r.index === i &&
      ['PASS','FAIL','UNKNOWN'].includes(r.result) && typeof r.reason === 'string' && r.reason.trim()), 'FIDELITY_REVIEW_INCOMPLETE');
    allPass &&= rows.every(r => r.result === 'PASS'); anyFail ||= rows.some(r => r.result === 'FAIL');
  }
  for (const key of ['currentness','positive_control','offer_fit','contact_permission']) {
    const r = review[key];
    check(r && ['PASS','FAIL','UNKNOWN'].includes(r.result) && typeof r.reason === 'string' && r.reason.trim(), 'FIDELITY_REVIEW_INCOMPLETE');
    allPass &&= r.result === 'PASS'; anyFail ||= r.result === 'FAIL';
  }
  check(review.verdict === (allPass ? 'PASS' : anyFail ? 'FAIL' : 'UNKNOWN'), 'FIDELITY_REVIEW_CONTRADICTION');
  const report = boundedJson(attempt.report_path);
  check(digest(report) === attempt.report_hash && report.output_hash === attempt.output_hash && report.output && digest(report.output) === attempt.output_hash &&
    report.test_authority_closed === true, 'FIDELITY_REPORT_CHANGED');
  check(!gold.positive_control_required || report.output.needs.length > 0 || review.positive_control.result === 'FAIL',
    'FIDELITY_POSITIVE_CONTROL_EMPTY');
  attempt.review = review;
  if (review.verdict === 'UNKNOWN' || attempt.arm === 'B' && review.verdict !== 'PASS') history.stop_reason = 'SEMANTIC_REVIEW_STOP';
  if (attempt.arm === 'B') {
    const a = history.attempts.at(-2);
    const identity = attempt.served_model_identity;
    const comparable = identity && a.served_model_identity && digest(identity) === digest(a.served_model_identity);
    attempt.comparability = comparable ? 'REPORTED_IDENTITY_EQUAL_UNPAIRED_UPSTREAM_UNATTESTED' : 'UNKNOWN_REPORTED_IDENTITY_DIFFERS_OR_MISSING';
    if (!comparable) history.stop_reason ??= 'MODEL_COMPARABILITY_UNKNOWN';
  }
  persist(cache, history, lock);
  process.stdout.write(JSON.stringify({ cell_id: attempt.cell_id, semantic_verdict: review.verdict,
    stop_reason: history.stop_reason, comparability: attempt.comparability ?? null }) + '\n');
}

async function main() {
  const opts = options(process.argv.slice(2));
  if (opts['--help']) { process.stdout.write('Usage: run.mjs --run 1A --model ID --base-url URL | --review FILE | --status\n'); return; }
  const frozen = loadFrozenFidelity(ROOT), cache = path.join(ROOT, '.cache/commercial-task-fidelity-stage0-v1');
  fs.mkdirSync(cache, { recursive: true });
  let lock;
  try {
    lock = acquire(cache);
    const history = historyFor(cache, frozen);
    if (opts['--run']) await runCell(opts, frozen, cache, history, lock);
    else if (opts['--review']) recordReview(opts, frozen, cache, history, lock);
    else process.stdout.write(JSON.stringify({ ...history, next_cell: !history.stop_reason && history.logical_attempts < CAP ? SEQUENCE[history.logical_attempts] : null }, null, 2) + '\n');
  } finally { release(lock); }
}

main().catch(error => {
  const code = /^FIDELITY_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'FIDELITY_LOCAL_OR_RUNTIME_ERROR';
  process.stderr.write(code + '\n'); process.exitCode = 1;
});
