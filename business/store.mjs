import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { ROOT, DATA, readJson } from './config.mjs';
import { now } from './errors.mjs';

export const id = () => randomUUID();
export const hash = value => createHash('sha256').update(value).digest('hex');
export const TABLES = ['partners','persons','channel_identities','conversations','messages','facts','tasks','runs','drafts','draft_versions','approvals','delivery_attempts','outcome_events','lessons','capability_proposals','skill_versions','events','command_receipts','channel_offsets','tool_calls'];
export class Store {
  constructor(directory = DATA) {
    fs.mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'partner.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const file of fs.readdirSync(path.join(ROOT, 'business/migrations')).filter(f => f.endsWith('.sql')).sort()) {
      const sql = fs.readFileSync(path.join(ROOT, 'business/migrations', file), 'utf8');
      const old = this.get('SELECT * FROM schema_migrations WHERE version=?', file);
      if (old && old.checksum !== hash(sql)) throw new Error(`Applied migration was changed: ${file}`);
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
      // A persisted last-seen timestamp is not proof of connection after a restart.
      this.run("UPDATE channel_offsets SET cursor=json_set(cursor,'$.phase','catching_up','$.confirmed_at',NULL,'$.reason','PROCESS_RESTART') WHERE channel='telegram-source-v0'");
      this.run("UPDATE delivery_attempts SET status='delivery_unknown',error='Service restarted during delivery',finished_at=? WHERE status='sending'", now());
      this.run("UPDATE drafts SET status='delivery_unknown' WHERE status='sending'");
      this.run("UPDATE tasks SET status='interrupted' WHERE status='running'");
      this.run("UPDATE runs SET status='interrupted',error='Service restarted; explicit retry required',finished_at=? WHERE status='running'", now());
    });
  }
  close() { this.db.close(); }
}
