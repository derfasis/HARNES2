import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ROOT } from './config.mjs';
import { automaticBoundary } from './source-ingestion.mjs';
import { failureError, normalizeFailureCause } from './failure-cause.mjs';

function childEnvironment(token) {
  const env = {};
  for (const key of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','HOME','LOCALAPPDATA','APPDATA','PROGRAMFILES','ProgramFiles','PATHEXT']) if (process.env[key]) env[key] = process.env[key];
  // Do not inherit ambient provider, Telegram, Codex or Hermes credentials/configuration.
  const modelCredentials = {};
  for (const key of ['PARTNER_MODEL_API_KEY', 'PARTNER_MODEL_API_KEY_SECONDARY', 'PARTNER_MODEL_API_KEY_TERTIARY']) {
    if (process.env[key]) modelCredentials[key] = process.env[key];
  }
  return { ...env, ...modelCredentials, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1',
    ...(token ? { PARTNER_RUN_TOKEN: token } : {}) };
}
export class HermesAdapter {
  constructor(service, tokens) { this.service = service; this.tokens = tokens; this.children = new Map(); }
  decide(run, context) { automaticBoundary(this.service); return this.run(run, context, true); }
  async run(run, context, decision = false) {
    if (decision) automaticBoundary(this.service);
    else if (this.service.config.opportunity?.automatic) throw new Error('Agent runs are disabled in automatic review-only mode');
    const config = this.service.config, token = decision ? null : randomBytes(32).toString('hex');
    const scope = { kind: 'agent', runId: run.id, conversationId: run.conversation_id, expiresAt: Date.now() + (config.runtime.timeoutSeconds + 30) * 1000 };
    const tools = decision ? [] : (await import('./tools.mjs')).toolDefinitions(scope);
    if (token) this.tokens.set(token, scope);
    const python = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const cwd = path.join(ROOT, 'data/runtime'); fs.mkdirSync(cwd, { recursive: true });
    return new Promise((resolve, reject) => {
      const child = spawn(python, [path.join(ROOT, decision ? 'scripts/situation_router_worker.py' : 'adapters/hermes/runner.py')], { cwd, env: childEnvironment(token), windowsHide: true, stdio: ['pipe','pipe','pipe'] });
      this.children.set(run.id, child);
      let stdout = '', bytes = 0, done = false, timedOut = false;
      const finish = (error, result) => { if (done) return; done = true; clearTimeout(timer); this.children.delete(run.id); if (token) this.tokens.delete(token); error ? reject(error) : resolve(result); };
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, config.runtime.timeoutSeconds * 1000 + 15000);
      child.on('error', () => finish(failureError('Cannot start the installed Hermes adapter', {
        kind: 'child_exit', timed_out: false, stdout_json_valid: false,
      })));
      child.stdin.on('error', () => {});
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { bytes += Buffer.byteLength(chunk); if (bytes > 12 * 1024 * 1024) { child.kill(); return; } stdout += chunk; });
      // Upstream logs can include raw provider responses. Persist only normalized result/trace.
      child.stderr.on('data', () => {});
      child.on('close', code => {
        if (timedOut) return finish(failureError('Hermes exceeded the configured run timeout', {
          kind: 'timeout', child_exit_code: code, timed_out: true, stdout_json_valid: false,
        }));
        if (bytes > 12 * 1024 * 1024) return finish(failureError('Hermes output exceeded the configured size limit', {
          kind: 'invalid_envelope', child_exit_code: code, timed_out: false, stdout_json_valid: false,
        }));
        let result;
        try { result = JSON.parse(stdout); } catch {
          return finish(failureError('Hermes returned an invalid result envelope', {
            kind: 'invalid_envelope', child_exit_code: code, timed_out: false, stdout_json_valid: false,
          }));
        }
        if (code !== 0) {
          result.error ||= 'CHILD_EXIT';
          result.failure_cause = normalizeFailureCause(
            result.failure_cause && typeof result.failure_cause === 'object'
              ? { ...result.failure_cause, child_exit_code: code, stdout_json_valid: true }
              : { kind: 'child_exit', child_exit_code: code, timed_out: false, stdout_json_valid: true },
          );
        } else if (result.failure_cause) {
          result.failure_cause = normalizeFailureCause(result.failure_cause);
        }
        finish(null, result);
      });
      // Hermes' empty-response retry ladder re-enters the loop only while
      // api_call_count < max_iterations, so a single-iteration decision run
      // can never execute its builtin retry. The second iteration is exactly
      // that one retry after an empty first response; attempts stay bounded.
      const envelope = decision
        ? { run_id: run.id, situation_id: context.input.situation_id, context, system_prompt: context.router_instructions,
          model: { ...config.runtime, maxIterations: 2 }, tools: [] }
        : { run_id: run.id, context, model: config.runtime, tools, business_url: `http://127.0.0.1:${config.server.port}` };
      child.stdin.end(JSON.stringify(envelope));
    });
  }
  cancel(runId) { const child = this.children.get(runId); if (child) child.kill(); }
  close() { for (const child of this.children.values()) child.kill(); }
}
