import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { ROOT, DATA, readJson } from './config.mjs';
import { now } from './errors.mjs';
import { ENGAGEMENT_TABLES } from './engagement-tables.mjs';
import { DISCOVERY_TABLES } from './discovery-tables.mjs';
import { CONTINUITY_TABLES } from './continuity-tables.mjs';
import { ACTION_TABLES } from './action-tables.mjs';
import { EXECUTIVE_TABLES } from './executive-tables.mjs';
import { OUTCOME_TABLES } from './outcome-tables.mjs';
import { WORK_TABLES, CONTROL_TABLES } from './work-tables.mjs';
import { SCOUT_TABLES } from './scout-tables.mjs';

export const id = () => randomUUID();
export const hash = value => createHash('sha256').update(value).digest('hex');
const LEGACY_MIGRATION_CHECKSUMS = new Map([
  ['008-outcome-candidates.sql', new Set([
    '9bf883d940a6a174c88a1e68ecde384966b14632813f616322beafbae154498e',
    'a255f1b438928fd000279ed19b87b57ba3881512d32d613f292e99ecae640a64',
  ])],
]);
export function migrationChecksumMatches(version, recordedChecksum, currentChecksum) {
  return recordedChecksum === currentChecksum || version === '008-outcome-candidates.sql'
    && ['5b12514a28dcf5a62e2b4996b301b4e1a3cf1c79fa171143c1084eea0c27a37e',
      'a570b569340c8b9f93d3b179655d3fc9170f75f3c023d71c1dda71dac2d29049'].includes(currentChecksum)
    && (LEGACY_MIGRATION_CHECKSUMS.get(version)?.has(recordedChecksum) === true
      || ['5b12514a28dcf5a62e2b4996b301b4e1a3cf1c79fa171143c1084eea0c27a37e',
        'a570b569340c8b9f93d3b179655d3fc9170f75f3c023d71c1dda71dac2d29049'].includes(recordedChecksum));
}
export const TABLES = ['partners','persons','channel_identities','conversations','messages','facts','tasks','runs','drafts','draft_versions','approvals','delivery_attempts','outcome_events','lessons','capability_proposals','skill_versions','events','command_receipts','channel_offsets','tool_calls',...ENGAGEMENT_TABLES,...DISCOVERY_TABLES,...CONTINUITY_TABLES,...EXECUTIVE_TABLES,...ACTION_TABLES,...OUTCOME_TABLES,...WORK_TABLES,...CONTROL_TABLES,...SCOUT_TABLES];
export class Store {
  constructor(directory = DATA) {
    this.directory = path.resolve(directory);
    fs.mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'partner.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const file of fs.readdirSync(path.join(ROOT, 'business/migrations')).filter(f => f.endsWith('.sql')).sort()) {
      const sql = fs.readFileSync(path.join(ROOT, 'business/migrations', file), 'utf8');
      const old = this.get('SELECT * FROM schema_migrations WHERE version=?', file);
      if (old && !migrationChecksumMatches(file, old.checksum, hash(sql))) throw new Error(`Applied migration was changed: ${file}`);
      if (!old) this.transaction(() => { this.db.exec(sql); this.run('INSERT INTO schema_migrations VALUES(?,?,?)', file, hash(sql), now()); });
    }
    const profile = readJson(path.join(ROOT, 'partner/profile.json'));
    this.run('INSERT OR IGNORE INTO partners VALUES(?,?,?,?,?)', profile.id, profile.name, profile.mission, profile.version, now());
  }
  get(sql, ...params) { return this.db.prepare(sql).get(...params); }
  all(sql, ...params) { return this.db.prepare(sql).all(...params); }
  run(sql, ...params) { return this.db.prepare(sql).run(...params); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); if (result?.then) throw new Error('Transactions must be synchronous'); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  event(partnerId, conversationId, kind, actor, payload) {
    this.run('INSERT INTO events(partner_id,conversation_id,kind,actor,payload_json,created_at) VALUES(?,?,?,?,?,?)', partnerId, conversationId ?? null, kind, actor, JSON.stringify(payload), now());
  }
  recover() {
    this.transaction(() => {
      this.run("UPDATE scout_calls SET status='unknown',reason='PROCESS_RESTART',finished_at=? WHERE status='started'", now());
      this.run("UPDATE scout_jobs SET status='interrupted',reason='PROCESS_RESTART',owner_id=NULL,updated_at=? WHERE status='running'", now());
      this.run("UPDATE control_tickets SET status='interrupted',reason='PROCESS_RESTART',finished_at=? WHERE status IN ('reserved','running')", now());
      this.run("UPDATE work_material_requests SET status='interrupted',reason='PROCESS_RESTART',finished_at=? WHERE status='running'", now());
      this.run(`INSERT INTO events(partner_id,conversation_id,kind,actor,payload_json,created_at)
        SELECT p.partner_id,NULL,'action.recovered_unknown','system',json_object('action_id',p.id,'attempt_id',a.id,'reason','PROCESS_RESTART'),?
        FROM action_attempts a JOIN action_proposals p ON p.id=a.action_id WHERE a.status='dispatching'`, now());
      this.run("UPDATE action_proposals SET status='failed',reason='PROCESS_RESTART',revision=revision+1,updated_at=? WHERE status='planning'", now());
      this.run(`UPDATE action_proposals SET status=CASE WHEN status IN ('revoked','rejected','stale') THEN status ELSE 'unknown' END,
        verify_requested=1,revision=revision+1,updated_at=? WHERE EXISTS
        (SELECT 1 FROM action_attempts a WHERE a.action_id=action_proposals.id AND a.status='dispatching')`, now());
      this.run("UPDATE action_attempts SET status='unknown',finished_at=? WHERE status='dispatching'", now());
      // Last verification is historical evidence, not proof that local bytes survived
      // a power loss or offline move. Re-probe, never replay, after every startup.
      this.run("UPDATE action_proposals SET verify_requested=1 WHERE status='completed'");
      this.run(`UPDATE research_intents SET status='interrupted_unknown',reason='PROCESS_RESTART',revision=revision+1,updated_at=?
        WHERE status IN ('planning','waiting_sources','reasoning') AND EXISTS
        (SELECT 1 FROM research_attempts a WHERE a.intent_id=research_intents.id AND a.status='running')`, now());
      this.run("UPDATE research_attempts SET status='interrupted_unknown',finished_at=? WHERE status='running'", now());
      this.run("UPDATE partner_turns SET status='interrupted' WHERE status='running'");
      // A persisted last-seen timestamp is not proof of connection after a restart.
      this.run("UPDATE channel_offsets SET cursor=json_set(cursor,'$.phase','catching_up','$.confirmed_at',NULL,'$.reason','PROCESS_RESTART') WHERE channel='telegram-source-v0' AND json_extract(cursor,'$.reason') IS NOT 'INTEGRITY_RECONCILIATION_REQUIRED'");
      this.run("UPDATE delivery_attempts SET status='delivery_unknown',error='Service restarted during delivery',finished_at=? WHERE status='sending'", now());
      this.run("UPDATE drafts SET status='delivery_unknown' WHERE status='sending'");
      this.run("UPDATE tasks SET status='interrupted' WHERE status='running'");
      this.run("UPDATE runs SET status='interrupted',error='Service restarted; explicit retry required',finished_at=? WHERE status='running'", now());
    });
  }
  close() { this.db.close(); }
}
