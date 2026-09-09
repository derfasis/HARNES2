import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ROOT } from './config.mjs';
import { toolDefinitions } from './tools.mjs';

function childEnvironment(token) {
  const env = {};
  for (const key of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','HOME','LOCALAPPDATA','APPDATA','PROGRAMFILES','ProgramFiles','PATHEXT']) if (process.env[key]) env[key] = process.env[key];
  // Do not inherit ambient provider, Telegram, Codex or Hermes credentials/configuration.
  return { ...env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1',
    PARTNER_MODEL_API_KEY: process.env.PARTNER_MODEL_API_KEY, PARTNER_RUN_TOKEN: token };
}
export class HermesAdapter {
  constructor(service, tokens) { this.service = service; this.tokens = tokens; this.children = new Map(); }
  run(run, context) {
    const config = this.service.config, token = randomBytes(32).toString('hex');
    const scope = { kind: 'agent', runId: run.id, conversationId: run.conversation_id, expiresAt: Date.now() + (config.runtime.timeoutSeconds + 30) * 1000 };
    this.tokens.set(token, scope);
    const python = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const cwd = path.join(ROOT, 'data/runtime'); fs.mkdirSync(cwd, { recursive: true });
    return new Promise((resolve, reject) => {
      const child = spawn(python, [path.join(ROOT, 'adapters/hermes/runner.py')], { cwd, env: childEnvironment(token), windowsHide: true, stdio: ['pipe','pipe','pipe'] });
      this.children.set(run.id, child);
      let stdout = '', bytes = 0, done = false, timedOut = false;
      const finish = (error, result) => { if (done) return; done = true; clearTimeout(timer); this.children.delete(run.id); this.tokens.delete(token); error ? reject(error) : resolve(result); };
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, config.runtime.timeoutSeconds * 1000 + 15000);
      child.on('error', () => finish(new Error('Cannot start the installed Hermes adapter')));
      child.stdin.on('error', () => {});
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { bytes += Buffer.byteLength(chunk); if (bytes > 12 * 1024 * 1024) { child.kill(); return; } stdout += chunk; });
      // Upstream logs can include raw provider responses. Persist only normalized result/trace.
      child.stderr.on('data', () => {});
      child.on('close', code => {
        if (timedOut) return finish(new Error('Hermes exceeded the configured run timeout'));
        if (bytes > 12 * 1024 * 1024) return finish(new Error('Hermes output exceeded the configured size limit'));
        let result;
        try { result = JSON.parse(stdout); } catch { return finish(new Error('Hermes returned an invalid result envelope')); }
        if (code !== 0 && !result.error) result.error = 'Hermes process exited unsuccessfully';
        finish(null, result);
      });
      child.stdin.end(JSON.stringify({ run_id: run.id, context, model: config.runtime,
        tools: toolDefinitions(scope), business_url: `http://127.0.0.1:${config.server.port}` }));
    });
  }
  cancel(runId) { const child = this.children.get(runId); if (child) child.kill(); }
  close() { for (const child of this.children.values()) child.kill(); }
}
