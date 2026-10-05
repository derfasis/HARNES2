import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ROOT } from '../business/config.mjs';
import { Store, hash, migrationChecksumMatches } from '../business/store.mjs';

const migrationVersion = '011-source-scout.sql';
const fixturePath = new URL('./fixtures/deployed-011-source-scout.sql', import.meta.url);
const fixtureChecksum = '9d13b835d8e0788a7d8c1272dd78d652a934f6a0342b8926c97cf84556eefa04';
const releaseLfChecksum = 'd9eee200ae3e9075cdd6d08addc0c34abaa9e97a039398bd30bf35e8abbf286e';
const releaseCrlfChecksum = '045478ba2f61a237f9f1da2502c1404d808aed450202306ab55be97da0d10da5';

function fixtureBytes() {
  const bytes = fs.readFileSync(fixturePath);
  assert.equal(hash(bytes), fixtureChecksum, 'the fixture must retain the deployed mixed-ending bytes');
  return bytes;
}

function createSchemaEleven(directory, { receiptChecksum = fixtureChecksum } = {}) {
  fs.mkdirSync(directory, { recursive: true });
  const databasePath = path.join(directory, 'partner.sqlite');
  const db = new DatabaseSync(databasePath);
  try {
    db.exec('PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
    const migrationsDirectory = path.join(ROOT, 'business/migrations');
    const priorMigrations = fs.readdirSync(migrationsDirectory).filter(file => file.endsWith('.sql')).sort().slice(0, 10);
    for (const file of priorMigrations) {
      const sql = fs.readFileSync(path.join(migrationsDirectory, file), 'utf8');
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(file, hash(sql), '2026-09-01T00:00:00.000Z');
    }

    const deployed011 = fixtureBytes();
    db.exec(deployed011.toString('utf8'));
    db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(migrationVersion, receiptChecksum, '2026-09-01T00:00:00.000Z');

    const profile = JSON.parse(fs.readFileSync(path.join(ROOT, 'partner/profile.json'), 'utf8'));
    db.prepare('INSERT INTO partners VALUES(?,?,?,?,?)').run(profile.id, profile.name, profile.mission, profile.version, '2026-09-01T00:00:00.000Z');
    db.prepare(`INSERT INTO scout_campaigns
      (id,partner_id,title,topic,config_json,revision,topic_hash,status,created_at,updated_at)
      VALUES(?,?,?,?,?,1,?,'active',?,?)`).run(
      'deployed-campaign', profile.id, 'Deployed campaign', 'local history', '{}', 'topic-hash-011',
      '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    db.prepare(`INSERT INTO scout_candidates
      (id,campaign_id,account_id,channel_id,username,title,kind,joined,origin_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,0,?,?,?)`).run(
      'deployed-candidate', 'deployed-campaign', 'reader-1', 'channel-77', 'sample_channel', 'Sample channel', 'channel', '{}',
      '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    db.prepare(`INSERT INTO scout_grants
      (id,campaign_id,campaign_revision,kind,account_id,candidate_id,purpose,expires_at,status,created_at)
      VALUES(?,?,1,'audit',?,?,? ,?,'active',?)`).run(
      'deployed-grant', 'deployed-campaign', 'reader-1', 'deployed-candidate', 'bounded audit',
      '2027-01-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
  } finally { db.close(); }
  return databasePath;
}

function makeTempDirectory(t, label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `harnes2-migration-${label}-`));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('deployed 011 fixture is byte-pinned and excluded from Git line-ending conversion', () => {
  const bytes = fixtureBytes();
  const canonicalLf = Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  const canonicalCrlf = Buffer.from(canonicalLf.toString('utf8').replace(/\n/g, '\r\n'), 'utf8');
  assert.equal(hash(canonicalLf), releaseLfChecksum);
  assert.equal(hash(canonicalCrlf), releaseCrlfChecksum);
  assert.match(fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8'),
    /^tests\/fixtures\/deployed-011-source-scout\.sql -text -diff -merge\s*$/m,
    'the immutable historical bytes must bypass Git text normalization and text merging');
});

test('schema 11 with the deployed receipt upgrades to 012 and preserves scout rows and authority across restarts', t => {
  const directory = makeTempDirectory(t, 'upgrade');
  createSchemaEleven(directory);

  for (let restart = 0; restart < 3; restart++) {
    const store = new Store(directory);
    try {
      assert.equal(store.get('SELECT COUNT(*) AS n FROM schema_migrations').n, 16);
      assert.equal(store.get('SELECT checksum FROM schema_migrations WHERE version=?', migrationVersion).checksum, fixtureChecksum,
        'the historical receipt remains byte-for-byte unchanged');
      assert.equal(store.get("SELECT COUNT(*) AS n FROM schema_migrations WHERE version='012-audience-intelligence.sql'").n, 1);
      assert.equal(store.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='audience_goals'").n, 1);
      assert.deepEqual({ ...store.get(`SELECT id,campaign_id,account_id,channel_id,title FROM scout_candidates WHERE id='deployed-candidate'`) }, {
        id: 'deployed-candidate', campaign_id: 'deployed-campaign', account_id: 'reader-1', channel_id: 'channel-77', title: 'Sample channel',
      });
      assert.deepEqual({ ...store.get(`SELECT id,kind,account_id,candidate_id,purpose,status FROM scout_grants WHERE id='deployed-grant'`) }, {
        id: 'deployed-grant', kind: 'audit', account_id: 'reader-1', candidate_id: 'deployed-candidate', purpose: 'bounded audit', status: 'active',
      });
      assert.deepEqual(store.all('PRAGMA foreign_key_check').map(row => ({ ...row })), []);
    } finally { store.close(); }
  }
});

test('an unknown schema-11 receipt rejects startup without installing 012 or rewriting the receipt', t => {
  const directory = makeTempDirectory(t, 'unknown-receipt');
  const databasePath = createSchemaEleven(directory, { receiptChecksum: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' });
  const moduleUrl = pathToFileURL(path.join(ROOT, 'business/store.mjs')).href;
  const source = `const {Store}=await import(${JSON.stringify(moduleUrl)}); try { const store=new Store(${JSON.stringify(directory)}); store.close(); process.exit(0); } catch (error) { console.error(error.message); process.exit(2); }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /Applied migration was changed: 011-source-scout\.sql/);

  const db = new DatabaseSync(databasePath);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='audience_goals'").get().n, 0);
    assert.equal(db.prepare('SELECT checksum FROM schema_migrations WHERE version=?').get(migrationVersion).checksum,
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
  } finally { db.close(); }
});

test('the 011 compatibility pin accepts only known historical receipts against known release bytes', () => {
  const currentSql = fs.readFileSync(path.join(ROOT, 'business/migrations', migrationVersion), 'utf8');
  const currentChecksum = hash(currentSql);
  assert.ok([releaseLfChecksum, releaseCrlfChecksum].includes(currentChecksum),
    'the checked-out migration bytes must match one explicitly pinned release encoding');
  const knownReceipts = [fixtureChecksum, releaseLfChecksum, releaseCrlfChecksum];
  for (const receipt of knownReceipts) {
    assert.equal(migrationChecksumMatches(migrationVersion, receipt, releaseLfChecksum), true);
    assert.equal(migrationChecksumMatches(migrationVersion, receipt, releaseCrlfChecksum), true);
  }
  assert.equal(migrationChecksumMatches(migrationVersion, currentChecksum, currentChecksum), true,
    'the normal current receipt remains valid');

  const canonicalLf = Buffer.from(fixtureBytes().toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  const unknownMixed = hash(Buffer.from(canonicalLf.toString('utf8').replace('\n', '\r\n'), 'utf8'));
  assert.notEqual(unknownMixed, fixtureChecksum);
  assert.equal(migrationChecksumMatches(migrationVersion, unknownMixed, releaseLfChecksum), false);
  assert.equal(migrationChecksumMatches(migrationVersion, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', releaseLfChecksum), false);
  assert.equal(migrationChecksumMatches('010-partner-workspace.sql', fixtureChecksum, releaseLfChecksum), false);
  assert.equal(migrationChecksumMatches(migrationVersion, fixtureChecksum, hash(`${currentSql}\n-- changed current migration`)), false,
    'a historical receipt cannot authorize modified current SQL');
});
