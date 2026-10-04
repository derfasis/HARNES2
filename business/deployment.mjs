// A deliberately small verifier for one local installation, not a deployment engine.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseEnv } from 'node:util';
import Ajv from 'ajv';
import { DatabaseSync, backup } from 'node:sqlite';
import { ROOT, loadConfig, readJson } from './config.mjs';
import { migrationChecksumMatches } from './store.mjs';
import { AppError } from './errors.mjs';

const profileSchema = readJson(path.join(ROOT, 'contracts/deployment-profile.schema.json'));
const validateProfile = new Ajv({ strict: true }).compile(profileSchema);
const CODE_SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PREPARED_PROFILE = Symbol('preparedDeploymentProfile');
const SECRET_KEYS = Object.freeze([
  'PARTNER_MODEL_API_KEY', 'PARTNER_MODEL_API_KEY_SECONDARY', 'PARTNER_MODEL_API_KEY_TERTIARY',
  'PARTNER_TELEGRAM_BOT_TOKEN', 'PARTNER_TELEGRAM_API_ID', 'PARTNER_TELEGRAM_API_HASH',
  'PARTNER_TELEGRAM_SESSION', 'PARTNER_TELEGRAM_SESSION_FILE',
]);
const fail = (code, status = 409) => { throw new AppError(code, status, code); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
const real = value => fs.realpathSync.native?.(value) ?? fs.realpathSync(value);
const contained = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// Keep the exact authority-bearing profile basis durable without storing paths or credentials
// in logs/receipts. Property order is fixed so the digest is stable across runtimes.
export function deploymentFingerprint(profile) {
  const basis = {
    version: profile?.version ?? 1,
    id: profile?.id ?? null,
    code_root: profile?.code_root ?? null,
    code_sha: profile?.code_sha ?? null,
    data_directory: profile?.data_directory ?? null,
    config_file: profile?.config_file ?? null,
    config_sha256: profile?.config_sha256 ?? null,
    credentials_file: profile?.credentials_file ?? null,
    partner_id: profile?.partner_id ?? null,
    mode: profile?.mode ?? null,
    state: profile?.state ?? null,
    expires_at: profile?.expires_at ?? null,
  };
  return sha256(JSON.stringify(basis));
}

export function workspaceIdentity(root = ROOT) {
  const absolute = path.resolve(root);
  try {
    const actualRoot = real(git(absolute, ['rev-parse', '--show-toplevel']));
    if (real(absolute) !== actualRoot) return { code_root: absolute, code_sha: null, dirty: true, verified: false, release_status: 'unverified' };
    const codeSha = git(absolute, ['rev-parse', 'HEAD']);
    if (!CODE_SHA.test(codeSha)) return { code_root: absolute, code_sha: null, dirty: true, verified: false, release_status: 'unverified' };
    const dirty = git(absolute, ['status', '--porcelain', '--untracked-files=all']).length > 0;
    return { code_root: actualRoot, code_sha: codeSha, dirty, verified: false, release_status: dirty ? 'dirty' : 'unmanaged' };
  } catch {
    return { code_root: absolute, code_sha: null, dirty: true, verified: false, release_status: 'unverified' };
  }
}

export function validateDeploymentProfile(profile, { root = ROOT, at = Date.now() } = {}) {
  if (!validateProfile(profile)) fail('DEPLOYMENT_PROFILE_INVALID', 400);
  for (const name of ['code_root', 'data_directory', 'config_file']) {
    if (!path.isAbsolute(profile[name])) fail('DEPLOYMENT_PROFILE_INVALID', 400);
  }
  if (profile.credentials_file !== null && !path.isAbsolute(profile.credentials_file)) fail('DEPLOYMENT_PROFILE_INVALID', 400);
  const expiresAt = Date.parse(profile.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= at || expiresAt > at + 7 * 86400_000) fail('DEPLOYMENT_PROFILE_EXPIRED', 409);
  let configuredRoot, selectedRoot;
  try { configuredRoot = real(profile.code_root); selectedRoot = real(root); }
  catch { fail('DEPLOYMENT_CODE_ROOT_MISMATCH'); }
  if (configuredRoot !== selectedRoot) fail('DEPLOYMENT_CODE_ROOT_MISMATCH');
  const identity = workspaceIdentity(selectedRoot);
  if (identity.code_sha !== profile.code_sha) fail('DEPLOYMENT_CODE_IDENTITY_MISMATCH');
  if (identity.dirty) fail('DEPLOYMENT_CODE_DIRTY');
  return { profile: structuredClone(profile), identity: { ...identity, verified: true, release_status: 'verified_profile' } };
}

export function assertSafeConfig(config, mode) {
  const allModelFlags = [config.audience?.modelEnabled, config.continuity?.modelEnabled, config.executive?.modelEnabled,
    config.actions?.modelEnabled, config.workspace?.modelEnabled, config.scout?.modelEnabled];
  if (config.controlPlane?.enabled !== true || config.runtime?.enabled !== false || config.runtime?.model !== ''
    || config.runtime?.baseUrl !== '' || allModelFlags.some(value => value !== false)
    || config.executive?.autoPlan !== false || config.telegram?.liveSending !== false
    || !Array.isArray(config.telegram?.allowedChatIds) || config.telegram.allowedChatIds.length !== 0
    || config.opportunity?.automatic !== true || config.audience?.enabled !== true
    || !['bot_api', 'mtproto'].includes(config.telegram?.transport)) fail('DEPLOYMENT_CONFIG_UNSAFE');
  // Scoped mode makes already-granted public Audience work available; it does not turn on
  // profile-less reasoning. Read-only additionally vetoes every model admission at CP.
  if (!['read_only', 'scoped_reasoning'].includes(mode)) fail('DEPLOYMENT_CONFIG_UNSAFE');
  return config;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

function inspectExistingState(directory, partnerId, { requireReceipt = true } = {}) {
  const database = path.join(directory, 'partner.sqlite');
  if (!fs.existsSync(database) || !fs.statSync(database).isFile()) fail('DEPLOYMENT_STATE_INCOMPATIBLE');
  const receiptFile = path.join(directory, 'runtime', 'service.json');
  if (fs.existsSync(receiptFile)) {
    let receipt;
    try { receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')); } catch { fail('DEPLOYMENT_STATE_OWNERSHIP_AMBIGUOUS'); }
    if (!Number.isInteger(receipt?.pid) || receipt.pid <= 0) fail('DEPLOYMENT_STATE_OWNERSHIP_AMBIGUOUS');
    if (processAlive(receipt?.pid)) fail('DEPLOYMENT_PROCESS_ALREADY_OWNED');
  } else if (requireReceipt) fail('DEPLOYMENT_STATE_OWNERSHIP_AMBIGUOUS');
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const migrations = db.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all();
    if (!migrations.length) fail('DEPLOYMENT_STATE_SCHEMA_UNKNOWN');
    const dir = path.join(ROOT, 'business', 'migrations');
    const published = [...fs.readdirSync(dir).filter(name => name.endsWith('.sql')).sort()];
    if (migrations.length > published.length || migrations.some((row, index) => row.version !== published[index]))
      fail('DEPLOYMENT_STATE_SCHEMA_UNKNOWN');
    for (const migration of migrations) {
      const checksum = sha256(fs.readFileSync(path.join(dir, migration.version)));
      if (!migrationChecksumMatches(migration.version, migration.checksum, checksum)) fail('DEPLOYMENT_STATE_SCHEMA_UNKNOWN');
    }
    const partner = db.prepare('SELECT id FROM partners WHERE id=?').get(partnerId);
    if (!partner) fail('DEPLOYMENT_PARTNER_MISMATCH');
    try {
      const owner = db.prepare('SELECT pid FROM control_owners WHERE partner_id=?').get(partnerId);
      if (owner && (!Number.isInteger(owner.pid) || owner.pid <= 0)) fail('DEPLOYMENT_STATE_OWNERSHIP_AMBIGUOUS');
      if (owner && processAlive(owner.pid)) fail('DEPLOYMENT_PROCESS_ALREADY_OWNED');
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (!String(error.message).includes('no such table')) throw error;
    }
    return database;
  } finally { db.close(); }
}

function assertNewState(directory) {
  if (fs.existsSync(directory) && (!fs.statSync(directory).isDirectory() || fs.readdirSync(directory).length))
    fail('DEPLOYMENT_STATE_INCOMPATIBLE');
}

function activationMarker(directory, profile) {
  const file = path.join(directory, 'runtime', `activation-${profile.id}.json`);
  if (!fs.existsSync(file)) return null;
  let marker;
  try { marker = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('DEPLOYMENT_ACTIVATION_MARKER_INVALID'); }
  const keys = 'code_sha,expires_at,id,instance_id,phase,pid,profile_fingerprint,stop_reason,version';
  if (!marker || typeof marker !== 'object' || Array.isArray(marker) || Object.keys(marker).sort().join(',') !== keys
    || marker.version !== 1 || marker.id !== profile.id || marker.code_sha !== profile.code_sha
    || marker.expires_at !== profile.expires_at || !HASH.test(marker.profile_fingerprint ?? '')
    || !['active', 'stopped', 'expired'].includes(marker.phase)
    || typeof marker.stop_reason !== 'string' && marker.stop_reason !== null
    || !UUID.test(marker.instance_id ?? '') || !Number.isInteger(marker.pid) || marker.pid <= 0)
    fail('DEPLOYMENT_ACTIVATION_MARKER_INVALID');
  if (marker.profile_fingerprint !== profile.profile_fingerprint) fail('DEPLOYMENT_ACTIVATION_PROFILE_MISMATCH');
  if (marker.phase === 'stopped') fail('CONTROL_ACTIVATION_STOPPED');
  if (marker.phase === 'expired' || Date.parse(marker.expires_at) <= Date.now()) fail('CONTROL_ACTIVATION_EXPIRED');
  if (processAlive(marker.pid)) fail('DEPLOYMENT_PROCESS_ALREADY_OWNED');
  return marker;
}

function assertNoActiveOwner(directory) {
  const receiptFile = path.join(directory, 'runtime', 'service.json');
  if (fs.existsSync(receiptFile)) {
    let receipt;
    try { receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')); } catch { fail('DEPLOYMENT_STATE_OWNERSHIP_AMBIGUOUS'); }
    if (!Number.isInteger(receipt?.pid) || receipt.pid <= 0) fail('DEPLOYMENT_STATE_OWNERSHIP_AMBIGUOUS');
    if (processAlive(receipt.pid)) fail('DEPLOYMENT_PROCESS_ALREADY_OWNED');
  }
  const database = path.join(directory, 'partner.sqlite');
  if (!fs.existsSync(database)) return;
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    let owners;
    try { owners = db.prepare('SELECT pid FROM control_owners').all(); }
    catch (error) { if (String(error.message).includes('no such table')) return; throw error; }
    for (const { pid } of owners) {
      if (!Number.isInteger(pid) || pid <= 0) fail('DEPLOYMENT_STATE_OWNERSHIP_AMBIGUOUS');
      if (processAlive(pid)) fail('DEPLOYMENT_PROCESS_ALREADY_OWNED');
    }
  } finally { db.close(); }
}

export function assertActivationAdmission(activation, directory) {
  if (!activation || typeof activation.summary !== 'function') fail('CONTROL_ACTIVATION_INVALID');
  const summary = activation.summary();
  if (summary.phase === 'stopped') fail('CONTROL_ACTIVATION_STOPPED');
  if (summary.phase === 'expired') fail('CONTROL_ACTIVATION_EXPIRED');
  const current = workspaceIdentity(ROOT);
  if (activation.pinnedCode && (current.code_sha !== activation.codeSha || current.dirty))
    fail('DEPLOYMENT_CODE_IDENTITY_MISMATCH');
  // Unmanaged activations do not claim a verified release, but any durable marker still
  // has to bind to the actual checkout SHA observed at admission.
  const expectedCodeSha = activation.pinnedCode ? activation.codeSha : current.code_sha;
  const state = path.resolve(directory);
  if (fs.existsSync(state)) {
    const marker = activationMarker(state, { id: activation.id, code_sha: expectedCodeSha,
      expires_at: activation.expiresAt, profile_fingerprint: activation.profileFingerprint });
    if (marker && marker.phase === 'active') assertNoActiveOwner(state);
    else if (!marker) assertNoActiveOwner(state);
  }
  return true;
}

function assertMarkerOnlyNewState(directory, markerFile) {
  const entries = fs.readdirSync(directory);
  if (entries.some(name => path.join(directory, name) !== path.dirname(markerFile) && name !== 'runtime'))
    fail('DEPLOYMENT_STATE_INCOMPATIBLE');
  const runtime = path.dirname(markerFile);
  if (fs.existsSync(runtime)) {
    for (const name of fs.readdirSync(runtime)) {
      if (path.join(runtime, name) !== markerFile && name !== 'service.json') fail('DEPLOYMENT_STATE_INCOMPATIBLE');
    }
  }
}

function canonicalExternal(value, root, { mustExist = true } = {}) {
  const resolved = path.resolve(value);
  let checked;
  if (mustExist || fs.existsSync(resolved)) checked = real(resolved);
  else {
    let parent = resolved;
    while (!fs.existsSync(parent)) {
      // existsSync follows links. A dangling leaf or ancestor must not be
      // mistaken for an ordinary new directory and created behind our fence.
      try {
        if (fs.lstatSync(parent).isSymbolicLink()) fail('DEPLOYMENT_STATE_PATH_INVALID');
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      }
      const next = path.dirname(parent);
      if (next === parent) fail('DEPLOYMENT_STATE_PATH_INVALID');
      parent = next;
    }
    checked = path.join(real(parent), path.relative(parent, resolved));
  }
  if (contained(root, checked)) fail('DEPLOYMENT_STATE_PATH_INVALID');
  return checked;
}

function parseCredentials(file) {
  if (!file) return {};
  let values;
  try { values = parseEnv(fs.readFileSync(file, 'utf8')); } catch { fail('DEPLOYMENT_CREDENTIALS_UNAVAILABLE'); }
  const selected = Object.fromEntries(SECRET_KEYS.filter(key => typeof values[key] === 'string' && values[key].length)
    .map(key => [key, values[key]]));
  const sessionFile = selected.PARTNER_TELEGRAM_SESSION_FILE;
  if (sessionFile) {
    const resolved = path.isAbsolute(sessionFile) ? sessionFile : path.resolve(path.dirname(file), sessionFile);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) fail('DEPLOYMENT_CREDENTIALS_UNAVAILABLE');
    selected.PARTNER_TELEGRAM_SESSION_FILE = resolved;
  }
  return selected;
}

function installCredentials(selected) {
  for (const key of SECRET_KEYS) delete process.env[key];
  Object.assign(process.env, selected);
}

export class RuntimeActivation {
  #codeSha;
  #pinnedCode;
  #dataDirectory;
  #configFile;
  #configSha256;
  #partnerId;
  #preparedProfile;

  constructor(profile) {
    if (!profile || !UUID.test(profile.id ?? '') || typeof profile.label !== 'string'
      || !['read_only', 'scoped_reasoning'].includes(profile.mode)
      || !Number.isFinite(Date.parse(profile.expires_at))) fail('DEPLOYMENT_PROFILE_INVALID', 400);
    const preparedProfile = profile[PREPARED_PROFILE] === true;
    for (const [key, value] of Object.entries({
      id: profile.id, label: profile.label, mode: profile.mode, expiresAt: profile.expires_at,
      profileFingerprint: preparedProfile ? profile.profile_fingerprint : deploymentFingerprint(profile),
    })) Object.defineProperty(this, key, { value, enumerable: true, writable: false, configurable: false });
    this.stopped = false;
    this.stopReason = null;
    this.phase = Date.parse(this.expiresAt) <= Date.now() ? 'expired' : 'active';
    this.#codeSha = profile.code_sha ?? null;
    this.#pinnedCode = preparedProfile && CODE_SHA.test(profile.code_sha ?? '');
    this.#preparedProfile = preparedProfile;
    this.#dataDirectory = preparedProfile ? profile.data_directory : null;
    this.#configFile = preparedProfile ? profile.config_file : null;
    this.#configSha256 = preparedProfile ? profile.config_sha256 : null;
    this.#partnerId = preparedProfile ? profile.partner_id : null;
    this.instanceId = profile.instance_id ?? null;
    this.pid = profile.pid ?? null;
  }
  get codeSha() { return this.#codeSha; }
  get pinnedCode() { return this.#pinnedCode; }
  bindInstance({ instance_id, pid, code_sha }) {
    if (!UUID.test(instance_id ?? '') || !Number.isInteger(pid) || pid <= 0 || !CODE_SHA.test(code_sha ?? ''))
      fail('DEPLOYMENT_INSTANCE_INVALID');
    if (this.#pinnedCode && code_sha !== this.#codeSha) fail('DEPLOYMENT_CODE_IDENTITY_MISMATCH');
    this.instanceId = instance_id;
    this.pid = pid;
    this.#codeSha = code_sha;
  }
  matchesPreparedIdentity(identity, directory) {
    return this.#preparedProfile && identity?.verified === true
      && identity.deployment_id === this.id && identity.mode === this.mode
      && identity.expires_at === this.expiresAt && identity.profile_fingerprint === this.profileFingerprint
      && identity.partner_id === this.#partnerId && identity.config_sha256 === this.#configSha256
      && typeof directory === 'string' && path.resolve(directory) === path.resolve(this.#dataDirectory)
      && typeof this.#configFile === 'string';
  }
  summary() {
    const phase = this.stopped ? 'stopped' : Date.parse(this.expiresAt) <= Date.now() ? 'expired' : 'active';
    return { version: 1, id: this.id, label: this.label, mode: this.mode, expires_at: this.expiresAt, phase,
      model_capability_available: phase === 'active' && this.mode === 'scoped_reasoning',
      explicit_authority_required: true, contact_permission: false, allowed_effects: [], stop_reason: this.stopReason,
      instance_id: this.instanceId, pid: this.pid, code_sha: this.codeSha, profile_fingerprint: this.profileFingerprint };
  }
  assertModelAllowed() {
    if (this.stopped) fail('CONTROL_ACTIVATION_STOPPED');
    if (Date.parse(this.expiresAt) <= Date.now()) fail('CONTROL_ACTIVATION_EXPIRED');
    if (this.mode === 'read_only') fail('CONTROL_ACTIVATION_MODELS_OFF');
    return true;
  }
  stop(reason = 'operator_stop') { this.stopped = true; this.phase = 'stopped'; this.stopReason = String(reason).slice(0, 100); }
}

function inspectDeploymentProfileFile(profileFile) {
  let profile;
  try {
    const bytes = fs.readFileSync(profileFile);
    if (bytes.length > 32_000) fail('DEPLOYMENT_PROFILE_INVALID', 400);
    profile = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof AppError) throw error;
    fail('DEPLOYMENT_PROFILE_INVALID', 400);
  }
  const checked = validateDeploymentProfile(profile);
  let configFile;
  try { configFile = canonicalExternal(profile.config_file, checked.identity.code_root); }
  catch (error) { if (error instanceof AppError) throw error; fail('DEPLOYMENT_CONFIG_UNAVAILABLE'); }
  let configBytes;
  try { configBytes = fs.readFileSync(configFile); } catch { fail('DEPLOYMENT_CONFIG_UNAVAILABLE'); }
  if (sha256(configBytes) !== profile.config_sha256 || !HASH.test(profile.config_sha256)) fail('DEPLOYMENT_CONFIG_HASH_MISMATCH');
  let config;
  try { config = loadConfig({ file: configFile, bytes: configBytes }); } catch { fail('DEPLOYMENT_CONFIG_INVALID'); }
  if (config.partnerId !== profile.partner_id) fail('DEPLOYMENT_PARTNER_MISMATCH');
  assertSafeConfig(config, profile.mode);
  const profileFingerprint = deploymentFingerprint(profile);
  const boundProfile = { ...profile, profile_fingerprint: profileFingerprint, [PREPARED_PROFILE]: true };
  const identity = { code_root: checked.identity.code_root, code_sha: checked.identity.code_sha,
    verified: checked.identity.verified, deployment_id: profile.id, partner_id: profile.partner_id,
    mode: profile.mode, state: profile.state, expires_at: profile.expires_at,
    config_sha256: profile.config_sha256, profile_fingerprint: profileFingerprint };
  return { profile: boundProfile, checked, configFile, config, identity };
}

// Validate a profile and its sealed config without reading credentials, inspecting or creating
// data state, writing a backup, or starting a process. This is the launcher's safe status probe.
export function inspectDeployment(profileFile) {
  const inspected = inspectDeploymentProfileFile(profileFile);
  return { identity: deepFreeze(inspected.identity) };
}

export async function prepareDeployment(profileFile) {
  const { profile, checked, configFile, config, identity } = inspectDeploymentProfileFile(profileFile);

  let credentialFile = null;
  try { if (profile.credentials_file !== null) credentialFile = canonicalExternal(profile.credentials_file, checked.identity.code_root); }
  catch (error) { if (error instanceof AppError) throw error; fail('DEPLOYMENT_CREDENTIALS_UNAVAILABLE'); }
  if (credentialFile && !fs.statSync(credentialFile).isFile()) fail('DEPLOYMENT_CREDENTIALS_UNAVAILABLE');

  const codeRoot = checked.identity.code_root;
  let directory;
  try { directory = canonicalExternal(profile.data_directory, codeRoot, { mustExist: profile.state === 'existing' }); }
  catch (error) { if (error instanceof AppError) throw error; fail('DEPLOYMENT_STATE_PATH_INVALID'); }
  let previousActivation = null, restartExisting = false;
  if (fs.existsSync(directory)) previousActivation = activationMarker(directory, profile);
  if (profile.state === 'existing') inspectExistingState(directory, profile.partner_id, { requireReceipt: !previousActivation });
  else if (previousActivation) {
    const hasDatabase = fs.existsSync(path.join(directory, 'partner.sqlite'));
    if (hasDatabase) {
      inspectExistingState(directory, profile.partner_id, { requireReceipt: false });
      restartExisting = true;
    } else assertMarkerOnlyNewState(directory, path.join(directory, 'runtime', `activation-${profile.id}.json`));
  } else assertNewState(directory);
  const selectedCredentials = parseCredentials(credentialFile);

  // The backup is complete before Store opens or applies a migration. It uses SQLite's
  // online backup API so committed WAL pages are included without copying raw WAL files.
  if (profile.state === 'existing' || restartExisting) {
    const backupDir = path.join(directory, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const target = path.join(backupDir, `pre-activation-${profile.id}-${Date.now()}.sqlite`);
    const source = new DatabaseSync(path.join(directory, 'partner.sqlite'), { readOnly: true });
    try { await backup(source, target); } catch { fail('DEPLOYMENT_BACKUP_FAILED'); } finally { source.close(); }
  } else fs.mkdirSync(directory, { recursive: true });

  installCredentials(selectedCredentials);
  // The prepared runtime pins actual resolved targets. Its immutable fingerprint
  // continues to bind the owner's exact original profile, including path spelling.
  const activation = new RuntimeActivation({ ...profile, data_directory: directory, config_file: configFile });
  return { config: deepFreeze(config), directory, activation, identity: deepFreeze(identity) };
}
