// A thin transport for the decision-quality generation: it hands the frozen prompt and one staged
// case to the existing isolated worker, and reports the model identity the runtime actually
// gave. It adds no model logic of its own, and it invents nothing.
//
// The identity requirement is deliberate. The finished corpus must be attributable to one model,
// so a worker that cannot say which model answered produces a refusal rather than an annotation
// filled in by hand.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ROOT, readJson } from '../../../../business/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKER = path.join(ROOT, 'scripts', 'situation_router_worker.py');
export const PYTHON = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

// The same rule the product uses: pass through only the model credentials, never the ambient
// Telegram, Codex or Hermes configuration.
const CREDENTIAL_KEYS = ['PARTNER_MODEL_API_KEY', 'PARTNER_MODEL_API_KEY_SECONDARY',
  'PARTNER_MODEL_API_KEY_TERTIARY'];
const PASSTHROUGH = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP',
  'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMFILES', 'ProgramFiles', 'PATHEXT'];

export const childEnvironment = (environment = process.env) => {
  const env = {};
  for (const key of PASSTHROUGH) if (environment[key]) env[key] = environment[key];
  for (const key of CREDENTIAL_KEYS) if (environment[key]) env[key] = environment[key];
  return { ...env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' };
};

// The exact envelope the existing worker reads. It requires run_id, situation_id, system_prompt,
// model and context, and refuses any envelope carrying tools. A fake worker will happily accept
// anything, so the shape is asserted against the worker's own source in the test suite.
export const ENVELOPE_KEYS = ['run_id', 'situation_id', 'system_prompt', 'model', 'context', 'tools'];

export const buildEnvelope = ({ prompt, staged, runId = randomUUID(), runtime }) => ({
  run_id: runId,
  situation_id: staged.situation.situation_id,
  system_prompt: prompt,
  tools: [],
  model: { model: runtime.model, provider: runtime.provider, apiMode: runtime.apiMode,
    baseUrl: runtime.baseUrl, maxIterations: 1, maxOutputTokens: runtime.maxOutputTokens,
    timeoutSeconds: runtime.timeoutSeconds },
  context: { subject: staged.subject, situation: staged.situation, messages: staged.messages,
    offer: staged.offer, operator_goal: staged.operator_goal, known_unknowns: staged.known_unknowns },
});

// Everything the worker will use, checked before a process is started. An obviously unready
// runtime must not cost an attempt: the call ledger counts it whether or not it was sensible.
export const LIMITS = { maxOutputTokens: [128, 16000], timeoutSeconds: [10, 1800] };

export const transportProblems = (runtime = {}, environment = process.env) => {
  const problems = [];
  for (const key of ['model', 'provider', 'baseUrl', 'apiMode']) {
    if (typeof runtime[key] !== 'string' || runtime[key].length === 0) problems.push(`runtime_config_is_missing_${key}`);
  }
  for (const [key, [low, high]] of Object.entries(LIMITS)) {
    const value = runtime[key];
    if (!Number.isInteger(value) || value < low || value > high) problems.push(`runtime_${key}_must_be_an_integer_between_${low}_and_${high}`);
  }
  // The worker's credential loader requires the primary key; the others are only extra fallbacks.
  if (typeof environment.PARTNER_MODEL_API_KEY !== 'string' || environment.PARTNER_MODEL_API_KEY.length === 0)
    problems.push('no_primary_model_credential_is_configured');
  const baseUrl = runtime.baseUrl;
  if (typeof baseUrl === 'string' && baseUrl.length > 0) {
    let parsed = null;
    try { parsed = new URL(baseUrl); } catch { problems.push('base_url_must_be_a_url'); }
    if (parsed) {
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)))
        problems.push('base_url_must_be_https_or_localhost_http');
      if (parsed.username || parsed.password) problems.push('base_url_must_not_carry_credentials');
      if (parsed.search || parsed.hash) problems.push('base_url_must_not_carry_a_query_or_fragment');
    }
  }
  return problems;
};

export const callOnce = ({ python = PYTHON, worker = WORKER, envelope, environment, cwd,
  spawnFn = spawn, timeoutMs = 180000 }) => new Promise((resolve, reject) => {
  const child = spawnFn(python, [worker], { cwd, env: childEnvironment(environment), windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', settled = false;
  const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
  const timer = setTimeout(() => { child.kill(); finish(new Error('worker_timeout')); }, timeoutMs);
  child.on('error', () => finish(new Error('worker_cannot_start')));
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('close', (code) => {
    if (code !== 0) return finish(new Error(`worker_exited_${code}`));
    let parsed;
    try { parsed = JSON.parse(stdout); }
    catch { return finish(new Error('worker_output_is_not_json')); }
    finish(null, { parsed, stderr });
  });
  child.stdin.end(JSON.stringify(envelope));
});

// The contract the evaluation needs: the runtime text plus the identity it reported.
// The readiness of the runtime, evaluated before generation so an unready runtime cannot spend a
// call from the ledger.
export const readiness = (runtime = {}, environment = process.env) => transportProblems(runtime, environment);

export const createTransport = ({ runtime = {}, runId, python, worker, environment = process.env,
  cwd = path.join(ROOT, 'data', 'runtime'), spawnFn = spawn } = {}) => async ({ prompt, staged }) => {
  const problems = transportProblems(runtime, environment);
  if (problems.length) return { raw: null, model_id: null, model_version: null, transport_problems: problems };
  const envelope = buildEnvelope({ prompt, staged, runId, runtime });
  const { parsed } = await callOnce({ python, worker, envelope, environment, cwd, spawnFn });
  if (!parsed?.completed) return { raw: parsed?.final_response ?? null, model_id: null, model_version: null,
    transport_problems: ['worker_reported_no_completed_response'] };
  // The identity must come from the worker, which reads it from what the model service reported.
  // It is not derived from configuration, and it is not guessed from the model name.
  const identity = parsed.model_identity ?? {};
  const modelId = identity.model_id ?? parsed.model_id ?? parsed.modelId ?? null;
  const modelVersion = identity.model_version ?? parsed.model_version ?? parsed.modelVersion ?? null;
  if (typeof modelId !== 'string' || !modelId || typeof modelVersion !== 'string' || !modelVersion) {
    return { raw: parsed.final_response ?? null, model_id: modelId, model_version: modelVersion,
      transport_problems: [parsed.model_identity_reason ?? 'worker_did_not_report_which_model_answered'] };
  }
  return { raw: parsed.final_response, model_id: modelId, model_version: modelVersion };
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runtime = readJson(path.join(ROOT, 'config', 'local.example.json')).runtime ?? {};
  const problems = transportProblems(runtime, process.env);
  console.log(JSON.stringify({ transport: 'cli', worker: WORKER, python: PYTHON,
    runtime_problems: problems, live_proof: false, makes_no_call: true }, null, 2));
  if (problems.length) {
    console.error('\nThe runtime configuration does not describe a model; the transport cannot call one.');
    process.exit(1);
  }
  console.error('\nThis module makes no call by itself. It is used through runGeneration(), which refuses\n'
    + 'until the owner authorises model calls.');
}
