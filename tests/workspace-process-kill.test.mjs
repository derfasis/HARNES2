import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Store } from '../business/store.mjs';
import { ROOT, readJson } from '../business/config.mjs';
import { validateControl } from '../business/control-plane.mjs';

function controlConfig() {
  const config = readJson(path.join(ROOT, 'config/default.json'));
  config.server.port = 0;
  config.scheduler.enabled = false;
  config.runtime.enabled = false;
  config.telegram.enabled = false;
  config.telegram.liveSending = false;
  config.controlPlane.enabled = true;
  config.controlPlane.maxConcurrent = 3;
  return config;
}

function waitForReady(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error(`Child server did not become ready: ${output}`)), timeoutMs);
    const finish = (error, port) => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      if (error) reject(error); else resolve(port);
    };
    const onData = chunk => {
      output += chunk.toString();
      const match = /READY (\d+)/.exec(output);
      if (match) finish(null, Number(match[1]));
    };
    const onExit = (code, signal) => finish(new Error(`Child exited before ready (${code ?? signal}): ${output}`));
    child.stdout.on('data', onData);
    child.on('exit', onExit);
  });
}

function safeChildEnv() {
  const accepted = new Set(['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','HOME','LOCALAPPDATA','APPDATA','PROGRAMFILES','ProgramFiles','PATHEXT']);
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => accepted.has(key)));
}

function launchServer(directory, config) {
  const serverUrl = pathToFileURL(path.join(ROOT, 'business/server.mjs')).href;
  const script = `import { start } from ${JSON.stringify(serverUrl)};\nconst app = await start({ config: ${JSON.stringify(config)}, directory: ${JSON.stringify(directory)} });\nprocess.stdout.write('READY ' + app.server.address().port + '\\n');\nawait new Promise(() => {});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT, env: safeChildEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  // Keep stderr attached so an unexpected child failure is surfaced in the readiness error.
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  return { child, ready: waitForReady(child).catch(error => { throw new Error(`${error.message}${stderr ? `\n${stderr}` : ''}`); }) };
}

function killAbruptly(pid) {
  if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else process.kill(pid, 'SIGKILL');
}

function exited(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
  });
}

test('a dead server process relinquishes its unexpired Control Plane lease for immediate restart', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-control-owner-kill-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = controlConfig();
  const first = launchServer(directory, config);
  const port = await first.ready;
  assert.ok(port > 0);

  const ownerStore = new Store(directory);
  const owner = ownerStore.get('SELECT pid,expires_at FROM control_owners WHERE partner_id=?', config.partnerId);
  ownerStore.close();
  assert.equal(owner.pid, first.child.pid);
  assert.ok(Date.parse(owner.expires_at) > Date.now(), 'the stale lease must still be live by time');
  assert.ok(Date.parse(owner.expires_at) - Date.now() > 10000, 'restart must happen well before lease expiry');

  killAbruptly(first.child.pid);
  await exited(first.child);

  const second = launchServer(directory, config);
  await assert.doesNotReject(second.ready, 'A confirmed dead process must relinquish its unexpired lease');
  const secondPort = await second.ready;
  assert.ok(secondPort > 0);
  assert.notEqual(second.child.pid, first.child.pid);
  killAbruptly(second.child.pid);
  await exited(second.child);
});

test('model-enabled Workspace requires a third Control Plane slot while two slots remain valid otherwise', () => {
  const config = controlConfig();
  config.workspace.enabled = true;
  config.workspace.modelEnabled = true;
  config.continuity.enabled = true;
  config.actions.enabled = true;
  config.opportunity.automatic = true;

  config.controlPlane.maxConcurrent = 2;
  assert.throws(() => validateControl(config), /Model-enabled Workspace requires a slot/);

  config.controlPlane.maxConcurrent = 3;
  assert.doesNotThrow(() => validateControl(config));
});
