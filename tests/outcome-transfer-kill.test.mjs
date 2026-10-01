// Transfer must preserve verifiable positive observations and historical decisions while
// stripping every claim of silence that cannot be proved after the boundary. All fixtures are
// local; this test uses neither a model nor a channel adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { BusinessService } from '../business/service.mjs';
import { exportPartner } from '../business/export.mjs';
import { readJson, ROOT } from '../business/config.mjs';
import { Store, hash, id, migrationChecksumMatches } from '../business/store.mjs';

const legacyCandidateColumns = ['basis','conversation_id','created_at','decision_id','detector','detector_version','draft_id',
  'engagement_id','evidence_json','id','kind','observed_at','outcome_id','partner_id','resolution_note','revision','source_message_id','status','updated_at'];
const legacyWindowColumns = ['answered_at','candidate_id','closes_at','conversation_id','created_at','coverage','draft_id','id','message_id','opened_at','outcome','partner_id'];
const noCoverage008Checksum = '9bf883d940a6a174c88a1e68ecde384966b14632813f616322beafbae154498e';

function createPreRelease008(directory, checksum = noCoverage008Checksum) {
  const old008 = spawnSync('git', ['show', '9855eb99a014f56f46389215e17e0c2d3f079ee2:business/migrations/008-outcome-candidates.sql'],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.equal(old008.status, 0, old008.stderr);
  assert.equal(hash(old008.stdout), noCoverage008Checksum, 'the fixture is the actual pre-release migration, not an invented schema');
  fs.mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(path.join(directory, 'partner.sqlite'));
  try {
    db.exec('PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
    const files = fs.readdirSync(path.join(ROOT, 'business/migrations')).filter(file => file.endsWith('.sql')).sort();
    for (const file of files.slice(0, 7)) {
      const sql = fs.readFileSync(path.join(ROOT, 'business/migrations', file), 'utf8');
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(file, hash(sql), '2026-09-01T00:00:00.000Z');
    }
    db.exec(checksum === 'a255f1b438928fd000279ed19b87b57ba3881512d32d613f292e99ecae640a64'
      ? old008.stdout.replace(/\r?\n/g, '\r\n') : old008.stdout);
    db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run('008-outcome-candidates.sql', checksum, '2026-09-01T00:00:00.000Z');
  } finally { db.close(); }
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-outcome-transfer-'));
  const source = new Store(path.join(directory, 'source'));
  const config = readJson(path.join(ROOT, 'config/default.json'));
  config.outcomes = { enabled: true, responseWindowSeconds: 604800 };
  const service = new BusinessService(source, config);
  const staged = path.join(ROOT, 'exports', `outcome-transfer-${id()}`);
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  t.after(() => {
    try { source.close(); } catch { /* already closed */ }
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(staged, { recursive: true, force: true });
  });
  return { directory, source, service, config, staged };
}

async function conversation(service, name) {
  const result = await service.command('person.create', { name, source: 'offline transfer fixture' }, id(), { kind: 'operator' });
  return result.conversation_id;
}

function message(store, cid, direction, text, at) {
  const mid = id();
  store.run(`INSERT INTO messages(id,conversation_id,direction,text,author,source,created_at,occurred_at,time_basis)
    VALUES(?,?,?,?,?,?,?,?,?)`, mid, cid, direction, text, direction === 'out' ? 'operator' : 'contact', 'offline fixture', at, at, 'source');
  return mid;
}

async function positiveFixture(h, suffix = '') {
  const cid = await conversation(h.service, `Positive ${suffix}`);
  const opened = '2026-01-01T00:00:00.000Z';
  const sent = message(h.source, cid, 'out', 'Would Thursday work?', opened);
  h.service.outcomes.observeSent(cid, sent, opened);
  const replyAt = '2026-01-01T12:00:00.000Z';
  const reply = message(h.source, cid, 'in', 'Thursday works.', replyAt);
  h.service.outcomes.reconcile({ now: Date.parse('2026-01-02T00:00:00.000Z') });
  return { cid, sent, reply };
}

function managedObservation(h, cid, label, offsetHours) {
  const db = h.source, at = new Date(Date.parse('2026-02-01T00:00:00.000Z') + offsetHours * 3600_000).toISOString();
  const engagementId = id(), decisionId = id(), permissionId = id(), draftId = id(), versionId = id(), attemptId = id();
  db.run(`INSERT INTO engagements(id,partner_id,conversation_id,topic,current_need,unknowns_json,close_condition,status,revision,created_at,updated_at)
    VALUES(?,?,?,?,?,'[]',?,'OPEN',1,?,?)`, engagementId, h.config.partnerId, cid, label, 'Shared result', 'Result confirmed', at, at);
  db.run(`INSERT INTO engagement_decisions(id,engagement_id,run_id,engagement_revision,conversation_revision,kind,reason,evidence_json,
    expected_next,snapshot_json,strategy_version_id,status,author,created_at) VALUES(?,?,NULL,1,1,'ACT',?,'[]',?,'{}',NULL,'current','operator',?)`,
    decisionId, engagementId, label, 'Review the reply', at);
  db.run(`INSERT INTO contact_permissions(id,partner_id,person_id,conversation_id,channel,account_id,purpose,granted_by,evidence,valid_from,expires_at,revoked_at,created_at)
    SELECT ?,p.partner_id,p.id,c.id,'manual',NULL,'reply','operator','offline permission',?, ?,NULL,?
      FROM conversations c JOIN persons p ON p.id=c.person_id WHERE c.id=?`, permissionId, at, '2027-01-01T00:00:00.000Z', at, cid);
  db.run(`INSERT INTO drafts(id,conversation_id,action,reason,status,context_revision,current_version,created_at)
    VALUES(?,?,'reply',?,'sent',1,1,?)`, draftId, cid, label, at);
  db.run('INSERT INTO draft_versions(id,draft_id,version,text,author,reason,created_at) VALUES(?,?,1,?,?,?,?)',
    versionId, draftId, `Proposal ${label}`, 'operator', 'offline fixture', at);
  db.run(`INSERT INTO engagement_actions(draft_id,decision_id,permission_id,purpose,explained_json,created_at)
    VALUES(?,?,?,'reply','[]',?)`, draftId, decisionId, permissionId, at);
  const sentId = message(db, cid, 'out', `Proposal ${label}`, at);
  db.run('UPDATE messages SET draft_id=? WHERE id=?', draftId, sentId);
  db.run(`INSERT INTO delivery_attempts(id,draft_id,draft_version,channel,recipient,status,external_id,error,created_at,finished_at)
    VALUES(?,?,1,'manual','local','sent',NULL,NULL,?,?)`, attemptId, draftId, at, at);
  h.service.outcomes.observeSent(cid, sentId, at);
  const replyAt = new Date(Date.parse(at) + 3600_000).toISOString();
  const replyId = message(db, cid, 'in', `Reply ${label}`, replyAt);
  return { engagementId, decisionId, draftId, sentId, replyId, at, replyAt };
}

function alterAs008(bundle, { withoutCoverage = false } = {}) {
  bundle.migrations = bundle.migrations.slice(0, 8);
  for (const row of bundle.tables.messages) { delete row.occurred_at; delete row.time_basis; }
  bundle.tables.outcome_candidates = bundle.tables.outcome_candidates.map(row =>
    Object.fromEntries(legacyCandidateColumns.map(key => [key, row[key]])));
  bundle.tables.outcome_observation_windows = bundle.tables.outcome_observation_windows.map(row => {
    const old = Object.fromEntries(legacyWindowColumns.map(key => [key, row[key]]));
    if (withoutCoverage) delete old.coverage;
    return old;
  });
  if (withoutCoverage) bundle.migrations.find(m => m.version === '008-outcome-candidates.sql').checksum = noCoverage008Checksum;
  bundle.tables_sha256 = hash(JSON.stringify(bundle.tables));
  return bundle;
}

function importBundle(t, h, bundle, suffix) {
  const sourceFile = path.join(h.directory, `${suffix}.json`);
  fs.writeFileSync(sourceFile, JSON.stringify(bundle));
  const child = spawnSync(process.execPath, ['scripts/import.mjs', sourceFile, h.staged], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  return child;
}

test('v9 export imports, reopens, and keeps only an exact fresh positive candidate', async t => {
  const h = fixture(t);
  const { cid, sent, reply } = await positiveFixture(h);
  const silentCid = await conversation(h.service, 'Attested silence');
  const silentSent = message(h.source, silentCid, 'out', 'A silence interval.', '2026-01-01T00:00:00.000Z');
  h.service.outcomes.observeSent(silentCid, silentSent, '2026-01-01T00:00:00.000Z');
  const silentWindow = h.source.get('SELECT * FROM outcome_observation_windows WHERE message_id=?', silentSent);
  h.service.outcomes.attest({ window_id: silentWindow.id, covered_from: '2025-12-31T00:00:00.000Z',
    covered_through: silentWindow.closes_at, evidence: 'local transfer fixture' }, { kind: 'operator' });
  const bundle = exportPartner(h.source);
  const child = importBundle(t, h, bundle, 'v9-export');
  assert.equal(child.status, 0, child.stderr);

  const reopened = new Store(path.join(h.staged, 'data'));
  try {
    const service = new BusinessService(reopened, { ...h.config, partnerId: bundle.tables.partners[0].id });
    const candidate = reopened.get("SELECT * FROM outcome_candidates WHERE source_message_id=?", reply);
    assert.equal(candidate.status, 'pending');
    assert.equal(candidate.kind, 'reply_observed');
    assert.equal(candidate.conversation_id, cid);
    assert.equal(candidate.window_id, reopened.get('SELECT id FROM outcome_observation_windows WHERE message_id=?', sent).id);
    assert.equal(service.outcomes.fresh(candidate), true);
    assert.equal(reopened.get('SELECT outcome FROM outcome_observation_windows WHERE id=?', candidate.window_id).outcome, 'answered');
    const transferredSilence = reopened.get('SELECT * FROM outcome_observation_windows WHERE message_id=?', silentSent);
    assert.equal(transferredSilence.outcome, 'unknown');
    assert.equal(transferredSilence.coverage, 'unverified');
    assert.equal(transferredSilence.coverage_event_id, null, 'a source attestation cannot certify destination silence');
    assert.equal(reopened.get('SELECT COUNT(*) n FROM outcome_events').n, 0, 'an observation remains separate from an outcome');
    assert.deepEqual(reopened.all('PRAGMA foreign_key_check'), []);
  } finally { reopened.close(); }
});

for (const withoutCoverage of [false, true]) test(`v8 import downgrades old silence proof (${withoutCoverage ? 'pre-release 008' : 'published 008'})`, async t => {
  const h = fixture(t);
  const { sent, reply } = await positiveFixture(h, String(withoutCoverage));
  const resolved = await positiveFixture(h, `resolved-${withoutCoverage}`);
  h.source.run("UPDATE outcome_candidates SET status='rejected',resolution_note='Historical operator decision' WHERE source_message_id=?", resolved.reply);
  const silentCid = await conversation(h.service, `Silent ${withoutCoverage}`);
  const silentSent = message(h.source, silentCid, 'out', 'A second proposal.', '2026-01-01T00:00:00.000Z');
  h.service.outcomes.observeSent(silentCid, silentSent, '2026-01-01T00:00:00.000Z');
  h.source.run("UPDATE outcome_observation_windows SET coverage='continuous',outcome='pending' WHERE message_id=?", silentSent);
  const bundle = alterAs008(exportPartner(h.source), { withoutCoverage });
  const child = importBundle(t, h, bundle, `v8-${withoutCoverage}`);
  assert.equal(child.status, 0, child.stderr);

  const reopened = new Store(path.join(h.staged, 'data'));
  try {
    const oldCandidate = reopened.get('SELECT * FROM outcome_candidates WHERE source_message_id=?', reply);
    assert.equal(oldCandidate.status, 'superseded');
    assert.equal(oldCandidate.resolution_note, 'DETECTOR_VERSION_CHANGED');
    const answered = reopened.get('SELECT * FROM outcome_observation_windows WHERE message_id=?', sent);
    assert.equal(answered.outcome, 'unknown', 'a v1 answer linked to a pending candidate is not carried as a resolved observation');
    assert.equal(answered.coverage, 'unverified');
    assert.equal(answered.coverage_event_id, null);
    assert.equal(answered.candidate_id, null);
    const historical = reopened.get('SELECT * FROM outcome_candidates WHERE source_message_id=?', resolved.reply);
    assert.equal(historical.status, 'rejected');
    const historicalWindow = reopened.get('SELECT * FROM outcome_observation_windows WHERE message_id=?', resolved.sent);
    assert.equal(historicalWindow.outcome, 'answered');
    assert.equal(historicalWindow.candidate_id, historical.id);
    const silent = reopened.get('SELECT * FROM outcome_observation_windows WHERE message_id=?', silentSent);
    assert.equal(silent.outcome, 'unknown');
    assert.equal(silent.coverage, 'unverified');
    assert.equal(silent.coverage_event_id, null);
    assert.deepEqual(reopened.all('PRAGMA foreign_key_check'), []);
  } finally { reopened.close(); }
});

test('valid foreign keys do not let a transferred candidate cross conversations', async t => {
  const h = fixture(t);
  const { reply } = await positiveFixture(h);
  const otherConversation = await conversation(h.service, 'Other conversation');
  const bundle = exportPartner(h.source);
  bundle.tables.outcome_candidates.find(row => row.source_message_id === reply).conversation_id = otherConversation;
  bundle.tables_sha256 = hash(JSON.stringify(bundle.tables));
  const child = importBundle(t, h, bundle, 'cross-conversation-tamper');
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /Outcome references cross a partner, conversation, or provenance boundary/);
});

test('actual pre-release 008 database upgrades without rewriting its migration receipt', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-pre-release-008-'));
  const badDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-bad-008-'));
  t.after(() => { fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(badDirectory, { recursive: true, force: true }); });
  createPreRelease008(directory);
  createPreRelease008(badDirectory, 'unknown-checksum');

  const store = new Store(directory);
  try {
    assert.equal(store.get("SELECT checksum FROM schema_migrations WHERE version='008-outcome-candidates.sql'").checksum, noCoverage008Checksum);
    assert.ok(store.all('PRAGMA table_info(messages)').some(column => column.name === 'occurred_at'));
    assert.ok(store.all('PRAGMA table_info(outcome_observation_windows)').some(column => column.name === 'coverage_event_id'));
    assert.equal(store.get("SELECT COUNT(*) n FROM schema_migrations WHERE version='009-outcome-observation-integrity.sql'").n, 1);
  } finally { store.close(); }

  const rejected = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import { Store } from './business/store.mjs'; new Store(process.argv.at(-1));", badDirectory],
  { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Applied migration was changed: 008-outcome-candidates.sql/);
});

test('the exact pre-release CRLF receipt upgrades but cannot authorize changed current migration SQL', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-old-crlf-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const checksum = 'a255f1b438928fd000279ed19b87b57ba3881512d32d613f292e99ecae640a64';
  createPreRelease008(directory, checksum);
  const store = new Store(directory);
  try { assert.equal(store.get("SELECT checksum FROM schema_migrations WHERE version='008-outcome-candidates.sql'").checksum, checksum); }
  finally { store.close(); }
  const changed = hash(fs.readFileSync(path.join(ROOT, 'business/migrations/008-outcome-candidates.sql'), 'utf8') + '\n-- changed');
  assert.equal(migrationChecksumMatches('008-outcome-candidates.sql', checksum, changed), false);
});

test('transfer discards even plausible local recovery progress so an orphan delivery intent is restored', async t => {
  const h = fixture(t), cid = await conversation(h.service, 'Orphan transfer');
  const sent = message(h.source, cid, 'out', 'Delivered, observer did not run.', '2026-03-01T00:00:00.000Z');
  h.service.outcomes.deliveryIntent(cid, sent);
  const last = h.source.get("SELECT MAX(id) id FROM events WHERE kind='outcome.delivery_observed'").id;
  h.source.run("INSERT INTO channel_offsets VALUES('outcome-observation-v2',?,?)", h.config.partnerId,
    JSON.stringify({ delivery: last, window: '', review: '' }));
  const child = importBundle(t, h, exportPartner(h.source), 'orphan-cursor-transfer');
  assert.equal(child.status, 0, child.stderr);
  const store = new Store(path.join(h.staged, 'data'));
  try {
    assert.equal(store.get("SELECT * FROM channel_offsets WHERE channel='outcome-observation-v2'"), undefined);
    const service = new BusinessService(store, h.config);
    service.outcomes.reconcile();
    assert.equal(store.get('SELECT COUNT(*) n FROM outcome_observation_windows WHERE message_id=?', sent).n, 1);
    assert.equal(store.get('SELECT COUNT(*) n FROM delivery_attempts').n, 0);
    assert.equal(store.get('SELECT COUNT(*) n FROM outcome_events').n, 0);
  } finally { store.close(); }
});

test('answered window keeps its scoped owner proof event across export/import', async t => {
  const h = fixture(t), cid = await conversation(h.service, 'Attested answered window');
  const sentAt = '2026-03-01T00:00:00.000Z', sent = message(h.source, cid, 'out', 'A question.', sentAt);
  h.service.outcomes.observeSent(cid, sent, sentAt);
  const window = h.source.get('SELECT * FROM outcome_observation_windows WHERE message_id=?', sent);
  h.service.outcomes.attest({ window_id: window.id, covered_from: '2026-02-28T00:00:00.000Z',
    covered_through: window.closes_at, evidence: 'continuous local observation' }, { kind: 'operator' });
  const replyAt = '2026-03-01T01:00:00.000Z', reply = message(h.source, cid, 'in', 'Yes.', replyAt);
  h.service.outcomes.reconcile({ now: Date.parse('2026-03-01T02:00:00.000Z') });
  const answered = h.source.get('SELECT * FROM outcome_observation_windows WHERE id=?', window.id);
  assert.equal(answered.outcome, 'answered');
  assert.equal(h.source.get('SELECT conversation_id FROM events WHERE id=?', answered.coverage_event_id).conversation_id, cid);

  const child = importBundle(t, h, exportPartner(h.source), 'attested-answered-window');
  assert.equal(child.status, 0, child.stderr);
  const reopened = new Store(path.join(h.staged, 'data'));
  try {
    const restored = reopened.get('SELECT * FROM outcome_observation_windows WHERE id=?', window.id);
    assert.equal(restored.outcome, 'answered');
    assert.equal(restored.coverage, 'continuous');
    assert.equal(reopened.get('SELECT conversation_id FROM events WHERE id=?', restored.coverage_event_id).conversation_id, cid);
    assert.equal(reopened.get('SELECT status FROM outcome_candidates WHERE source_message_id=?', reply).status, 'pending');
  } finally { reopened.close(); }
});

test('explicitly linked overlapping managed decisions transfer one outcome and one canonical credit', async t => {
  const h = fixture(t), cid = await conversation(h.service, 'Overlapping decisions');
  const first = managedObservation(h, cid, 'Decision one', 0);
  h.source.run("UPDATE engagements SET status='CLOSED' WHERE id=?", first.engagementId);
  const second = managedObservation(h, cid, 'Decision two', 2);
  h.service.outcomes.reconcile({ now: Date.parse('2026-02-02T00:00:00.000Z') });
  const candidateOne = h.source.get('SELECT * FROM outcome_candidates WHERE source_message_id=?', first.replyId);
  const candidateTwo = h.source.get('SELECT * FROM outcome_candidates WHERE source_message_id=?', second.replyId);
  assert.ok(candidateOne && candidateTwo);
  assert.notEqual(candidateOne.decision_id, candidateTwo.decision_id);

  const created = await h.service.command('outcome.candidate_confirm', {
    candidate_id: candidateOne.id, kind: 'joined', evidence: 'Operator confirmed the shared result.', expected_revision: candidateOne.revision,
  }, id(), { kind: 'operator' });
  await h.service.command('outcome.candidate_confirm', {
    candidate_id: candidateTwo.id, kind: 'joined', evidence: 'Operator linked the same result.', outcome_id: created.outcome_id,
    expected_revision: candidateTwo.revision,
  }, id(), { kind: 'operator' });
  assert.equal(h.source.get('SELECT COUNT(*) n FROM outcome_events').n, 1);
  assert.equal(h.source.get('SELECT COUNT(*) n FROM decision_outcomes').n, 1);
  assert.equal(h.source.get('SELECT decision_id FROM decision_outcomes WHERE outcome_id=?', created.outcome_id).decision_id, first.decisionId);
  const bundle = exportPartner(h.source);
  const child = importBundle(t, h, bundle, 'overlapping-managed-observations');
  assert.equal(child.status, 0, child.stderr);

  const reopened = new Store(path.join(h.staged, 'data'));
  try {
    assert.equal(reopened.get('SELECT COUNT(*) n FROM outcome_events').n, 1);
    assert.equal(reopened.get('SELECT COUNT(*) n FROM decision_outcomes').n, 1);
    assert.equal(reopened.get("SELECT COUNT(*) n FROM outcome_candidates WHERE outcome_id=? AND status='confirmed'", created.outcome_id).n, 2);
    assert.equal(reopened.get('SELECT decision_id FROM decision_outcomes WHERE outcome_id=?', created.outcome_id).decision_id, first.decisionId);
    assert.equal(reopened.get(`SELECT COUNT(*) n FROM events WHERE kind='outcome.candidate_confirmed' AND actor='operator'
      AND conversation_id=? AND json_extract(payload_json,'$.outcome_id')=? AND json_extract(payload_json,'$.linked_existing')=1`, cid, created.outcome_id).n, 1);
    assert.deepEqual(reopened.all('PRAGMA foreign_key_check'), []);
  } finally { reopened.close(); }
});
