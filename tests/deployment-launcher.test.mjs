import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const SOURCE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const supported = process.platform === 'win32';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-launcher-')));
  const reservation = net.createServer();
  await new Promise((resolve,reject) => reservation.once('error',reject).listen(0,'127.0.0.1',resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const root = path.join(dir, 'release');
  fs.mkdirSync(root);
  for (const name of ['business','partner','public','scripts'])
    fs.cpSync(path.join(SOURCE_ROOT, name), path.join(root, name), { recursive:true });
  fs.cpSync(path.join(SOURCE_ROOT,'contracts'),path.join(root,'contracts'),{recursive:true});
  fs.mkdirSync(path.join(root,'config'));
  fs.copyFileSync(path.join(SOURCE_ROOT,'config/default.json'), path.join(root,'config/default.json'));
  fs.writeFileSync(path.join(root,'.gitignore'),'node_modules/\n');
  fs.symlinkSync(path.join(SOURCE_ROOT,'node_modules'),path.join(root,'node_modules'),'junction');
  const git = args => execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git(['init','-q']); git(['config','user.email','deployment-test@example.invalid']);
  git(['config','user.name','Deployment Launcher Test']); git(['add','.']);
  git(['commit','-qm','isolated verified launcher fixture']);
  const codeSha = git(['rev-parse','HEAD']);
  const config = JSON.parse(fs.readFileSync(path.join(root,'config/default.json'),'utf8'));
  config.server.host = '127.0.0.1'; config.server.port = port;
  config.scheduler.enabled = false;
  config.runtime.enabled = false; config.runtime.model = ''; config.runtime.baseUrl = '';
  for (const field of ['executive','continuity','actions','workspace','scout']) config[field].modelEnabled = false;
  config.executive.autoPlan = false;
  config.telegram.enabled = false; config.telegram.liveSending = false; config.telegram.allowedChatIds = [];
  config.controlPlane.enabled = true;
  config.audience.enabled = true; config.audience.modelEnabled = false;
  config.opportunity.automatic = true; config.opportunity.telegramSources = []; config.opportunity.browserSources = [];
  const configPath = path.join(dir,'managed-config.json');
  const configBytes = Buffer.from(JSON.stringify(config,null,2)); fs.writeFileSync(configPath,configBytes);
  const profilePath = path.join(dir,'deployment.json');
  const rootAlias = path.join(dir,'release-alias');
  fs.symlinkSync(root,rootAlias,'junction');
  // A sealed owner path may name the same directory through a junction. The
  // verifier must pin the resolved data target, while its fingerprint still
  // binds the exact original profile; string-only binding fails on Windows8.3 too.
  const stateParent = path.join(dir,'state-parent');
  const stateParentAlias = path.join(dir,'state-parent-alias');
  fs.mkdirSync(stateParent);
  fs.symlinkSync(stateParent,stateParentAlias,'junction');
  const profile = { version:1, id:randomUUID(), label:'Isolated launcher acceptance', code_root:rootAlias,
    code_sha:codeSha, data_directory:path.join(stateParentAlias,'state'), config_file:configPath, config_sha256:hash(configBytes),
    credentials_file:null, partner_id:config.partnerId,
    expires_at:new Date(Date.now()+30*60_000).toISOString(), mode:'read_only', state:'new' };
  const writeProfile = () => fs.writeFileSync(profilePath,JSON.stringify(profile));
  writeProfile();
  const powershell = process.env.SystemRoot
    ? path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe') : 'powershell.exe';
  const invoke = operation => spawnSync(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
    path.join(root,'scripts/deployment.ps1'),'-Operation',operation,'-Profile',profilePath,'-NoBrowser'],
  { encoding:'utf8',timeout:45_000,windowsHide:true });
  const receiptPath = path.join(profile.data_directory,'runtime','service.json');
  const markerPath = path.join(profile.data_directory,'runtime',`activation-${profile.id}.json`);
  const receipt = () => JSON.parse(fs.readFileSync(receiptPath,'utf8'));
  const writeReceipt = value => fs.writeFileSync(receiptPath,JSON.stringify(value));
  const origin = record => `http://127.0.0.1:${record.port}`;
  let cleanup = async () => {};
  t.after(async () => {
    try { await cleanup(); } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
  return { dir,root,profile,profilePath,writeProfile,configPath,configBytes,invoke,receipt,writeReceipt,receiptPath,markerPath,origin,setCleanup:fn=>{cleanup=fn;} };
}

async function waitFor(predicate, message, timeout = 8000) {
  const until = Date.now()+timeout;
  while (Date.now()<until) { if (await predicate()) return; await wait(50); }
  assert.ok(await predicate(),message);
}

test('PowerShell managed launcher verifies identity, refuses forged receipts, and drains only its owned server', { skip:!supported && 'Windows PowerShell launcher acceptance runs on Windows.' }, async t => {
  const f = await fixture(t);
  const wrong = { ...f.profile, code_sha:'0'.repeat(40) };
  fs.writeFileSync(f.profilePath,JSON.stringify(wrong));
  const wrongStart = f.invoke('Start');
  assert.notEqual(wrongStart.status,0,'a profile for a different checkout is rejected');
  assert.match(`${wrongStart.stdout}\n${wrongStart.stderr}`,/DEPLOYMENT_CODE_IDENTITY_MISMATCH/);
  assert.equal(fs.existsSync(f.profile.data_directory),false,'identity failure happens before state creation');
  f.writeProfile();

  const start = f.invoke('Start');
  const startupError = path.join(f.dir,'logs',f.profile.id,'deployment.err.log');
  assert.equal(start.status,0,`${start.stdout}\n${start.stderr}\n${fs.existsSync(startupError) ? fs.readFileSync(startupError,'utf8') : ''}`);
  const first = f.receipt();
  f.setCleanup(async () => {
    if (!fs.existsSync(f.receiptPath)) return;
    let health;
    try { health = await (await fetch(`${f.origin(first)}/health`)).json(); } catch { return; }
    if (health?.release?.pid !== first.pid || health?.release?.instance_id !== first.instance_id
      || health?.release?.deployment_id !== f.profile.id) return;
    f.writeReceipt(first);
    const stop = f.invoke('Stop');
    if (stop.status === 0) await waitFor(() => {
      try { return JSON.parse(fs.readFileSync(f.markerPath,'utf8')).phase === 'stopped'; } catch { return false; }
    },'owned fixture server drains during cleanup',10_000).catch(()=>{});
  });

  assert.equal(first.verified,true); assert.equal(first.code_root,f.root); assert.equal(first.code_sha,f.profile.code_sha);
  assert.equal(first.deployment_id,f.profile.id); assert.equal(first.status,'running');
  assert.equal(typeof first.instance_id,'string'); assert.equal(Number.isInteger(first.pid),true);
  assert.match(first.profile_fingerprint,/^[a-f0-9]{64}$/,'receipt carries a sealed profile fingerprint');
  const inspect = spawnSync(process.execPath,[path.join(f.root,'scripts/run-deployment.mjs'),'--inspect',f.profilePath],
    {encoding:'utf8',timeout:15_000,windowsHide:true});
  assert.equal(inspect.status,0,`${inspect.stdout}\n${inspect.stderr}`);
  const inspectedFingerprint = JSON.parse(inspect.stdout).identity?.profile_fingerprint;
  assert.match(inspectedFingerprint,/^[a-f0-9]{64}$/,'read-only CLI inspection returns the selected profile fingerprint');
  assert.equal(first.profile_fingerprint,inspectedFingerprint,'running receipt is bound to this exact profile');
  const healthResponse = await fetch(`${f.origin(first)}/health`);
  assert.equal(healthResponse.status,200);
  const health = await healthResponse.json();
  assert.equal(health.release.instance_id,first.instance_id); assert.equal(health.release.pid,first.pid);
  assert.equal(health.release.port,first.port); assert.equal(health.release.code_sha,f.profile.code_sha);
  assert.equal(health.release.code_root,f.root); assert.equal(health.release.deployment_id,f.profile.id);
  assert.equal(health.activation.mode,'read_only'); assert.equal(health.activation.contact_permission,false);

  const repeatStart = f.invoke('Start');
  assert.equal(repeatStart.status,0,`${repeatStart.stdout}\n${repeatStart.stderr}`);
  assert.match(repeatStart.stdout,/Already running/);
  assert.deepEqual(f.receipt(),first,'repeat launch reuses the verified instance and receipt');
  const assertOriginalOwner = async () => {
    const response = await fetch(`${f.origin(first)}/health`);
    assert.equal(response.status,200);
    const current = await response.json();
    assert.equal(current.release.pid,first.pid); assert.equal(current.release.instance_id,first.instance_id);
  };

  fs.appendFileSync(f.configPath,' ');
  const changedConfig = f.invoke('Start');
  assert.notEqual(changedConfig.status,0,'changed sealed config is rejected before reusing the instance');
  assert.match(`${changedConfig.stdout}\n${changedConfig.stderr}`,/DEPLOYMENT_(?:CONFIG_HASH_MISMATCH|PROFILE_INSPECTION_FAILED)/);
  await assertOriginalOwner();
  fs.writeFileSync(f.configPath,f.configBytes);

  f.profile.mode = 'scoped_reasoning'; f.writeProfile();
  const changedMode = f.invoke('Start');
  assert.notEqual(changedMode.status,0,'same activation id cannot silently switch capability mode');
  assert.match(`${changedMode.stdout}\n${changedMode.stderr}`,/DEPLOYMENT_INSTANCE_MISMATCH/);
  await assertOriginalOwner();
  f.profile.mode = 'read_only'; f.writeProfile();

  f.profile.partner_id = 'partner-other'; f.writeProfile();
  const changedPartner = f.invoke('Start');
  assert.notEqual(changedPartner.status,0,'an existing instance cannot be rebound to another partner');
  assert.match(`${changedPartner.stdout}\n${changedPartner.stderr}`,/DEPLOYMENT_(?:PARTNER_MISMATCH|PROFILE_INSPECTION_FAILED)/);
  await assertOriginalOwner();
  f.profile.partner_id = 'partner-001'; f.writeProfile();

  const mismatchedInstance = { ...first, instance_id:randomUUID() };
  f.writeReceipt(mismatchedInstance);
  const instanceStop = f.invoke('Stop');
  assert.notEqual(instanceStop.status,0,'stop refuses a forged instance nonce');
  assert.match(`${instanceStop.stdout}\n${instanceStop.stderr}`,/DEPLOYMENT_INSTANCE_MISMATCH/);
  assert.equal((await fetch(`${f.origin(first)}/health`)).status,200,'mismatch does not terminate the healthy owner');

  const mismatchedPort = { ...first, port:first.port === 65535 ? 65534 : first.port+1 };
  f.writeReceipt(mismatchedPort);
  const portStop = f.invoke('Stop');
  assert.notEqual(portStop.status,0,'stop refuses a receipt whose port is not the owned server');
  assert.match(`${portStop.stdout}\n${portStop.stderr}`,/DEPLOYMENT_INSTANCE_(?:MISMATCH|HEALTH_UNVERIFIED)/);
  assert.equal((await fetch(`${f.origin(first)}/health`)).status,200,'port mismatch leaves the known server alive');

  f.writeReceipt(first);
  const stop = f.invoke('Stop');
  assert.equal(stop.status,0,`${stop.stdout}\n${stop.stderr}`);
  await waitFor(async () => {
    try {
      const marker = JSON.parse(fs.readFileSync(f.markerPath,'utf8'));
      return marker.phase === 'stopped' && f.receipt().status === 'stopped';
    } catch { return false; }
  },'stop drains and persists a durable marker',12_000);
  const marker = JSON.parse(fs.readFileSync(f.markerPath,'utf8'));
  assert.equal(marker.instance_id,first.instance_id); assert.equal(marker.stop_reason,'operator_stop');
  await assert.rejects(fetch(`${f.origin(first)}/health`));

  const restart = f.invoke('Start');
  assert.notEqual(restart.status,0,'the same stopped activation cannot be rearmed');
  await waitFor(() => {
    try { return JSON.parse(fs.readFileSync(f.markerPath,'utf8')).phase === 'stopped'; } catch { return false; }
  },'failed same-id restart preserves stopped marker');
  assert.equal(JSON.parse(fs.readFileSync(f.markerPath,'utf8')).instance_id,first.instance_id);
});
