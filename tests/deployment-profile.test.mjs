import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const safeConfig = () => {
  const config = JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, 'config/default.json'), 'utf8'));
  config.controlPlane.enabled = true;
  config.opportunity.automatic = true;
  config.audience.enabled = true;
  return config;
};

async function fixture({ state = 'new', mode = 'scoped_reasoning', credentials = null } = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-profile-')));
  const root = path.join(dir, 'release');
  fs.mkdirSync(root);
  fs.cpSync(path.join(SOURCE_ROOT, 'business'), path.join(root, 'business'), { recursive: true });
  fs.cpSync(path.join(SOURCE_ROOT, 'contracts'), path.join(root, 'contracts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'config'));
  fs.copyFileSync(path.join(SOURCE_ROOT, 'config/default.json'), path.join(root, 'config/default.json'));
  fs.cpSync(path.join(SOURCE_ROOT, 'partner'), path.join(root, 'partner'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(SOURCE_ROOT, 'scripts/run-deployment.mjs'), path.join(root, 'scripts/run-deployment.mjs'));
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  fs.symlinkSync(path.join(SOURCE_ROOT, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git(['init', '-q']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'user.name', 'Deployment Fixture']);
  git(['add', '.']);
  git(['commit', '-qm', 'verified fixture']);
  const codeSha = git(['rev-parse', 'HEAD']);

  const configPath = path.join(dir, 'managed-config.json');
  const configBytes = Buffer.from(JSON.stringify(safeConfig(), null, 2));
  fs.writeFileSync(configPath, configBytes);
  const credentialsPath = credentials ? path.join(dir, 'credentials.env') : null;
  if (credentialsPath) fs.writeFileSync(credentialsPath, credentials);
  const profilePath = path.join(dir, 'deployment.json');
  const profile = {
    version: 1, id: randomUUID(), label: 'Test activation', code_root: root, code_sha: codeSha,
    data_directory: path.join(dir, 'state'), config_file: configPath, config_sha256: hash(configBytes),
    credentials_file: credentialsPath, partner_id: 'partner-001',
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(), mode, state,
  };
  const writeProfile = () => fs.writeFileSync(profilePath, JSON.stringify(profile));
  writeProfile();
  const api = await import(pathToFileURL(path.join(root, 'business/deployment.mjs')).href);
  return { dir, root, profile, profilePath, configPath, configBytes, writeProfile, api };
}

test('preparation verifies a sealed clean checkout and keeps read-only authority explicit', async t => {
  const f = await fixture({ mode: 'read_only' });
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const prepared = await f.api.prepareDeployment(f.profilePath);
  assert.equal(prepared.identity.verified, true);
  assert.equal(prepared.identity.code_sha, f.profile.code_sha);
  assert.equal(prepared.identity.config_sha256, f.profile.config_sha256);
  assert.equal(prepared.identity.profile_fingerprint, f.api.deploymentFingerprint(f.profile));
  assert.equal(prepared.directory, f.profile.data_directory);
  assert.equal(prepared.activation.summary().mode, 'read_only');
  assert.equal(prepared.activation.summary().contact_permission, false);
  assert.throws(() => prepared.activation.assertModelAllowed(), { code: 'CONTROL_ACTIVATION_MODELS_OFF' });
  assert.equal(Object.isFrozen(prepared.config), true);
  assert.equal(Object.isFrozen(prepared.config.runtime), true);
  assert.equal(Object.isFrozen(prepared.identity), true);
  assert.equal(prepared.activation.matchesPreparedIdentity(prepared.identity, prepared.directory), true);
  assert.equal(prepared.activation.matchesPreparedIdentity({ ...prepared.identity, mode: 'scoped_reasoning' }, prepared.directory), false);
  assert.equal(prepared.activation.matchesPreparedIdentity(prepared.identity, f.dir), false);
  assert.equal(Object.getOwnPropertyDescriptor(prepared.activation, 'mode').writable, false);
  assert.equal(Object.getOwnPropertyDescriptor(prepared.activation, 'id').writable, false);
  assert.equal(Object.getOwnPropertyDescriptor(prepared.activation, 'expiresAt').writable, false);
  assert.equal(Object.getOwnPropertyDescriptor(prepared.activation, 'profileFingerprint').writable, false);
  assert.equal(JSON.stringify(prepared.activation.summary()).includes(f.profile.config_file), false);
  assert.equal(JSON.stringify(prepared.activation.summary()).includes(f.profile.data_directory), false);
  assert.equal(fs.existsSync(path.join(prepared.directory, 'partner.sqlite')), false);
});

test('wrong checkout identity is rejected before config or state access', async t => {
  const f = await fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  f.profile.code_sha = '0'.repeat(40);
  f.writeProfile();
  await assert.rejects(f.api.prepareDeployment(f.profilePath), { code: 'DEPLOYMENT_CODE_IDENTITY_MISMATCH' });
  assert.equal(fs.existsSync(f.profile.data_directory), false);
});

test('CLI inspect verifies the sealed profile read-only without installing credentials or creating state', async t => {
  const f = await fixture({ credentials: 'PARTNER_MODEL_API_KEY=inspect-file-secret' });
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const original = process.env.PARTNER_MODEL_API_KEY;
  const output = execFileSync(process.execPath, [path.join(f.root, 'scripts/run-deployment.mjs'), '--inspect', f.profilePath], {
    cwd: f.root, encoding: 'utf8', env: { ...process.env, PARTNER_MODEL_API_KEY: 'ambient-inspect-sentinel' },
  });
  const receipt = JSON.parse(output);
  assert.equal(receipt.status, 'verified');
  assert.equal(receipt.identity.profile_fingerprint, f.api.deploymentFingerprint(f.profile));
  assert.equal(receipt.identity.config_sha256, f.profile.config_sha256);
  assert.equal(output.includes('inspect-file-secret'), false);
  assert.equal(output.includes('ambient-inspect-sentinel'), false);
  assert.equal(output.includes(f.profile.credentials_file), false);
  assert.equal(fs.existsSync(f.profile.data_directory), false);
  assert.equal(process.env.PARTNER_MODEL_API_KEY, original, 'inspection does not alter the parent process environment');
});

test('dirty release code is rejected before config or state access', async t => {
  const f = await fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  fs.appendFileSync(path.join(f.root, 'business/deployment.mjs'), '\n// changed after sealing\n');
  await assert.rejects(f.api.prepareDeployment(f.profilePath), { code: 'DEPLOYMENT_CODE_DIRTY' });
  assert.equal(fs.existsSync(f.profile.data_directory), false);
});

test('config hash mismatch is rejected before data directory creation', async t => {
  const f = await fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  fs.appendFileSync(f.configPath, ' ');
  await assert.rejects(f.api.prepareDeployment(f.profilePath), { code: 'DEPLOYMENT_CONFIG_HASH_MISMATCH' });
  assert.equal(fs.existsSync(f.profile.data_directory), false);
});

test('new state rejects an external leaf junction into the release before credentials or writes', async t => {
  const f = await fixture({ credentials: 'PARTNER_MODEL_API_KEY=fixture-must-not-install' });
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const target = path.join(f.root, 'empty-state-target');
  const link = path.join(f.dir, 'external-state-link');
  fs.mkdirSync(target);
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  f.profile.data_directory = link;
  f.writeProfile();

  const previousKey = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'ambient-must-remain';
  t.after(() => {
    if (previousKey === undefined) delete process.env.PARTNER_MODEL_API_KEY;
    else process.env.PARTNER_MODEL_API_KEY = previousKey;
  });
  await assert.rejects(f.api.prepareDeployment(f.profilePath), { code: 'DEPLOYMENT_STATE_PATH_INVALID' });
  assert.equal(process.env.PARTNER_MODEL_API_KEY, 'ambient-must-remain');
  assert.deepEqual(fs.readdirSync(target), []);
  assert.equal(fs.existsSync(path.join(target, 'partner.sqlite')), false);
});

test('new state rejects a dangling external leaf link before creating its release target', async t => {
  const f = await fixture({ credentials: 'PARTNER_MODEL_API_KEY=fixture-must-not-install' });
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const target = path.join(f.root, 'future-state-target');
  const link = path.join(f.dir, 'dangling-state-link');
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  f.profile.data_directory = link;
  f.writeProfile();

  const previousKey = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'ambient-must-remain';
  t.after(() => {
    if (previousKey === undefined) delete process.env.PARTNER_MODEL_API_KEY;
    else process.env.PARTNER_MODEL_API_KEY = previousKey;
  });
  await assert.rejects(f.api.prepareDeployment(f.profilePath), { code: 'DEPLOYMENT_STATE_PATH_INVALID' });
  assert.equal(process.env.PARTNER_MODEL_API_KEY, 'ambient-must-remain');
  assert.equal(fs.existsSync(target), false);
});

test('new state rejects a dangling linked ancestor before creating its release target', async t => {
  const f = await fixture({ credentials: 'PARTNER_MODEL_API_KEY=fixture-must-not-install' });
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const target = path.join(f.root, 'future-ancestor-target');
  const link = path.join(f.dir, 'dangling-state-parent');
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(fs.existsSync(target), false);
  f.profile.data_directory = path.join(link, 'state');
  f.writeProfile();

  const previousKey = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'ambient-must-remain';
  t.after(() => {
    if (previousKey === undefined) delete process.env.PARTNER_MODEL_API_KEY;
    else process.env.PARTNER_MODEL_API_KEY = previousKey;
  });
  await assert.rejects(f.api.prepareDeployment(f.profilePath), { code: 'DEPLOYMENT_STATE_PATH_INVALID' });
  assert.equal(process.env.PARTNER_MODEL_API_KEY, 'ambient-must-remain');
  assert.equal(fs.existsSync(target), false);
});

test('the verifier parses the exact config bytes whose digest it checked', async t => {
  const f = await fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const alternate = safeConfig();
  alternate.scheduler.tickSeconds = 25;
  const alternateBytes = Buffer.from(JSON.stringify(alternate, null, 2));
  const originalRead = fs.readFileSync;
  let configReads = 0;
  fs.readFileSync = function(file, ...args) {
    if (path.resolve(String(file)) === path.resolve(f.configPath) && ++configReads === 2) return alternateBytes;
    return originalRead.call(this, file, ...args);
  };
  try {
    const prepared = await f.api.prepareDeployment(f.profilePath);
    assert.equal(prepared.config.scheduler.tickSeconds, 20, 'later path content is not substituted for the sealed bytes');
  } finally { fs.readFileSync = originalRead; }
  assert.equal(configReads, 1, 'the verified config file is opened once and the same captured bytes are parsed');
  assert.equal(fs.existsSync(f.profile.data_directory), true);
});

test('every managed safety fence is enforced through the clean-checkout preparation path', async t => {
  const mutations = [
    ['controlPlane.enabled', c => { c.controlPlane.enabled = false; }],
    ['runtime.enabled', c => { c.runtime.enabled = true; }],
    ['runtime.model', c => { c.runtime.model = 'fixture-model'; }],
    ['runtime.baseUrl', c => { c.runtime.baseUrl = 'https://example.invalid'; }],
    ['audience.modelEnabled', c => { c.audience.modelEnabled = true; }],
    ['private Telegram intake', c => { c.telegram.allowedChatIds = ['123']; }],
    ['live sending', c => { c.telegram.liveSending = true; c.telegram.allowedChatIds = ['123']; }],
    ['automatic opportunity processing', c => { c.opportunity.automatic = false; }],
  ];
  for (const [label, mutate] of mutations) {
    await t.test(label, async t2 => {
      const f = await fixture();
      t2.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
      const config = safeConfig();
      mutate(config);
      const bytes = Buffer.from(JSON.stringify(config, null, 2));
      fs.writeFileSync(f.configPath, bytes);
      f.profile.config_sha256 = hash(bytes);
      f.writeProfile();
      assert.throws(() => f.api.assertSafeConfig(config, f.profile.mode), { code: 'DEPLOYMENT_CONFIG_UNSAFE' });
      const preflightCode = label === 'live sending' ? 'DEPLOYMENT_CONFIG_INVALID' : 'DEPLOYMENT_CONFIG_UNSAFE';
      await assert.rejects(f.api.prepareDeployment(f.profilePath), { code: preflightCode });
      assert.equal(fs.existsSync(f.profile.data_directory), false);
    });
  }
});

test('credentials are loaded selectively and session paths resolve beside the credential file', async t => {
  const f = await fixture({ credentials: [
    'PARTNER_MODEL_API_KEY=fixture-model-secret',
    'PARTNER_TELEGRAM_SESSION_FILE=./session.txt',
    'UNAPPROVED_SECRET=not-installed',
  ].join('\n') });
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(f.dir, 'session.txt'), 'synthetic-session');
  const oldKey = process.env.PARTNER_MODEL_API_KEY;
  const oldUnknown = process.env.UNAPPROVED_SECRET;
  process.env.PARTNER_MODEL_API_KEY = 'ambient-must-not-win';
  delete process.env.UNAPPROVED_SECRET;
  t.after(() => {
    if (oldKey === undefined) delete process.env.PARTNER_MODEL_API_KEY; else process.env.PARTNER_MODEL_API_KEY = oldKey;
    if (oldUnknown === undefined) delete process.env.UNAPPROVED_SECRET; else process.env.UNAPPROVED_SECRET = oldUnknown;
  });
  const prepared = await f.api.prepareDeployment(f.profilePath);
  assert.equal(process.env.PARTNER_MODEL_API_KEY, 'fixture-model-secret');
  assert.equal(process.env.PARTNER_TELEGRAM_SESSION_FILE, path.join(f.dir, 'session.txt'));
  assert.equal(process.env.UNAPPROVED_SECRET, undefined);
  const publicState = JSON.stringify({ identity: prepared.identity, activation: prepared.activation.summary() });
  assert.equal(publicState.includes('fixture-model-secret'), false);
  assert.equal(publicState.includes(f.dir), false);
});

test('a stopped activation marker cannot be restarted from a new-state profile', async t => {
  const f = await fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const runtime = path.join(f.profile.data_directory, 'runtime');
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, `activation-${f.profile.id}.json`), JSON.stringify({
    version: 1, id: f.profile.id, code_sha: f.profile.code_sha, expires_at: f.profile.expires_at,
    profile_fingerprint: f.api.deploymentFingerprint(f.profile),
    phase: 'stopped', stop_reason: 'operator_stop', instance_id: randomUUID(), pid: 999_999_999,
  }));
  await assert.rejects(f.api.prepareDeployment(f.profilePath), { code: 'CONTROL_ACTIVATION_STOPPED' });
  assert.equal(fs.existsSync(path.join(f.profile.data_directory, 'partner.sqlite')), false);
});

test('an expired durable marker cannot be restarted even while the profile timestamp is unchanged', async t => {
  const f = await fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const runtime = path.join(f.profile.data_directory, 'runtime');
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, `activation-${f.profile.id}.json`), JSON.stringify({
    version: 1, id: f.profile.id, code_sha: f.profile.code_sha, expires_at: f.profile.expires_at,
    profile_fingerprint: f.api.deploymentFingerprint(f.profile),
    phase: 'expired', stop_reason: 'activation_expired', instance_id: randomUUID(), pid: 999_999_999,
  }));
  await assert.rejects(f.api.prepareDeployment(f.profilePath), { code: 'CONTROL_ACTIVATION_EXPIRED' });
  assert.equal(fs.existsSync(path.join(f.profile.data_directory, 'partner.sqlite')), false);
});

test('existing state is backed up through SQLite so committed WAL data is retained before activation', async t => {
  const f = await fixture({ state: 'existing' });
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(f.profile.data_directory, 'runtime'), { recursive: true });
  const { Store } = await import(pathToFileURL(path.join(f.root, 'business/store.mjs')).href);
  const store = new Store(f.profile.data_directory);
  store.db.exec('CREATE TABLE backup_probe (value TEXT NOT NULL)');
  store.run('INSERT INTO backup_probe(value) VALUES(?)', 'committed-in-wal');
  // Keep the writer open so a raw database copy would miss the committed WAL page.
  fs.writeFileSync(path.join(f.profile.data_directory, 'runtime/service.json'), JSON.stringify({ pid: 999_999_999 }));
  try {
    await f.api.prepareDeployment(f.profilePath);
    const backupDir = path.join(f.profile.data_directory, 'backups');
    const backupName = fs.readdirSync(backupDir).find(name => name.endsWith('.sqlite'));
    assert.ok(backupName, 'pre-activation snapshot was created');
    const snapshot = new DatabaseSync(path.join(backupDir, backupName), { readOnly: true });
    try {
      assert.equal(snapshot.prepare('SELECT value FROM backup_probe').get().value, 'committed-in-wal');
    } finally { snapshot.close(); }
  } finally { store.close(); }
});

test('an unknown applied migration is rejected before backup or credential installation', async t => {
  const f = await fixture({ state: 'existing', credentials: 'PARTNER_MODEL_API_KEY=must-not-install' });
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(f.profile.data_directory, 'runtime'), { recursive: true });
  const { Store, hash: storeHash } = await import(pathToFileURL(path.join(f.root, 'business/store.mjs')).href);
  const store = new Store(f.profile.data_directory);
  store.run('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)', '999-future.sql', storeHash('future'), new Date().toISOString());
  store.close();
  fs.writeFileSync(path.join(f.profile.data_directory, 'runtime/service.json'), JSON.stringify({ pid: 999_999_999 }));
  const before = process.env.PARTNER_MODEL_API_KEY;
  try {
    await assert.rejects(f.api.prepareDeployment(f.profilePath), { code: 'DEPLOYMENT_STATE_SCHEMA_UNKNOWN' });
    assert.equal(fs.existsSync(path.join(f.profile.data_directory, 'backups')), false);
    assert.equal(process.env.PARTNER_MODEL_API_KEY, before);
  } finally {
    if (before === undefined) delete process.env.PARTNER_MODEL_API_KEY;
    else process.env.PARTNER_MODEL_API_KEY = before;
  }
});

test('same-ID crash recovery rejects a changed mode, config hash, or credential reference before backup', async t => {
  const variants = [
    ['mode', async f => { f.profile.mode = 'scoped_reasoning'; }],
    ['config bytes/hash', async f => {
      const config = safeConfig();
      config.scheduler.tickSeconds = 25;
      const bytes = Buffer.from(JSON.stringify(config, null, 2));
      fs.writeFileSync(f.configPath, bytes);
      f.profile.config_sha256 = hash(bytes);
    }],
    ['credential reference', async f => {
      const other = path.join(f.dir, 'alternate-credentials.env');
      fs.writeFileSync(other, 'PARTNER_MODEL_API_KEY=alternate-test-only');
      f.profile.credentials_file = other;
    }],
  ];
  for (const [label, mutate] of variants) {
    await t.test(label, async t2 => {
      const f = await fixture({ state: 'existing', mode: 'read_only', credentials: 'PARTNER_MODEL_API_KEY=original-test-only' });
      t2.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
      fs.mkdirSync(path.join(f.profile.data_directory, 'runtime'), { recursive: true });
      const { Store } = await import(pathToFileURL(path.join(f.root, 'business/store.mjs')).href);
      const store = new Store(f.profile.data_directory); store.close();
      const serviceFile = path.join(f.profile.data_directory, 'runtime/service.json');
      fs.writeFileSync(serviceFile, JSON.stringify({ pid: 999_999_999 }));
      const previousKey = process.env.PARTNER_MODEL_API_KEY;
      const initial = await f.api.prepareDeployment(f.profilePath);
      const marker = {
        version: 1, id: f.profile.id, code_sha: f.profile.code_sha, expires_at: f.profile.expires_at,
        profile_fingerprint: initial.identity.profile_fingerprint, phase: 'active', stop_reason: null,
        instance_id: randomUUID(), pid: 999_999_999,
      };
      fs.writeFileSync(path.join(f.profile.data_directory, 'runtime', `activation-${f.profile.id}.json`), JSON.stringify(marker));
      const backupsBefore = fs.readdirSync(path.join(f.profile.data_directory, 'backups')).length;
      const installedKey = process.env.PARTNER_MODEL_API_KEY;
      t2.after(() => {
        if (previousKey === undefined) delete process.env.PARTNER_MODEL_API_KEY;
        else process.env.PARTNER_MODEL_API_KEY = previousKey;
      });
      await mutate(f);
      f.writeProfile();
      await assert.rejects(f.api.prepareDeployment(f.profilePath), { code: 'DEPLOYMENT_ACTIVATION_PROFILE_MISMATCH' });
      assert.equal(fs.readdirSync(path.join(f.profile.data_directory, 'backups')).length, backupsBefore,
        'profile mismatch is rejected before another pre-activation backup');
      assert.equal(process.env.PARTNER_MODEL_API_KEY, installedKey, 'mismatched profile does not load replacement credentials');
    });
  }
});
