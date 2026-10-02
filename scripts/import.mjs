// Import to a new staging directory only; never replace the active partner database.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJson } from '../business/config.mjs';
import { Store, TABLES, hash, migrationChecksumMatches } from '../business/store.mjs';
import { ENGAGEMENT_TABLES } from '../business/engagement-tables.mjs';
import { DISCOVERY_TABLES } from '../business/discovery-tables.mjs';
import { CONTINUITY_TABLES } from '../business/continuity-tables.mjs';
import { ACTION_TABLES } from '../business/action-tables.mjs';
import { EXECUTIVE_TABLES } from '../business/executive-tables.mjs';
import { OUTCOME_TABLES } from '../business/outcome-tables.mjs';
import { WORK_TABLES, CONTROL_TABLES } from '../business/work-tables.mjs';
import { SCOUT_TABLES } from '../business/scout-tables.mjs';
import { BusinessService } from '../business/service.mjs';

const [source,destinationArg] = process.argv.slice(2);
if (!source || !destinationArg) throw new Error('Usage: npm run import -- export.json exports/restore-new');
const bundle = readJson(path.resolve(source)), destination = path.resolve(destinationArg);
const relative = path.relative(ROOT,destination);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Choose a new staging directory inside this project.');
if (fs.existsSync(destination)) throw new Error('Destination already exists. Choose a NEW directory.');
if (bundle.format !== 'digital-ai-partner' || bundle.schema_version !== 1 || !bundle.tables) throw new Error('Unsupported bundle');
const migrationCount = Array.isArray(bundle.migrations) ? bundle.migrations.length : -1;
const without = (...groups) => {
  const excluded = new Set([...groups.flat(),...SCOUT_TABLES]);
  return TABLES.filter(table => !excluded.has(table));
};
// These are historical export catalogues. Deriving them from the current list alone silently
// injected tables added by later migrations into older bundles (outcomes into v2-v7).
const inputCatalogues = new Map([
  [2, without(ENGAGEMENT_TABLES, DISCOVERY_TABLES, CONTINUITY_TABLES, EXECUTIVE_TABLES, ACTION_TABLES, OUTCOME_TABLES, WORK_TABLES, CONTROL_TABLES)],
  [3, without(DISCOVERY_TABLES, CONTINUITY_TABLES, EXECUTIVE_TABLES, ACTION_TABLES, OUTCOME_TABLES, WORK_TABLES, CONTROL_TABLES)],
  [4, without(CONTINUITY_TABLES, EXECUTIVE_TABLES, ACTION_TABLES, OUTCOME_TABLES, WORK_TABLES, CONTROL_TABLES)],
  [5, without(EXECUTIVE_TABLES, ACTION_TABLES, OUTCOME_TABLES, WORK_TABLES, CONTROL_TABLES)],
  [6, without(ACTION_TABLES, OUTCOME_TABLES, WORK_TABLES, CONTROL_TABLES)],
  [7, without(OUTCOME_TABLES, WORK_TABLES, CONTROL_TABLES)],
  [8, without(WORK_TABLES, CONTROL_TABLES)],
  [9, without(WORK_TABLES, CONTROL_TABLES)],
  [10, without()],
  [11, TABLES],
]);
const inputTables = inputCatalogues.get(migrationCount);
if (!inputTables) throw new Error('Migration version differs');
if (Object.keys(bundle.tables).sort().join('|') !== [...inputTables].sort().join('|')) throw new Error('Bundle table list differs from this release');
if (hash(JSON.stringify(bundle.tables)) !== bundle.tables_sha256) throw new Error('Table checksum mismatch');
const migrations = fs.readdirSync(path.join(ROOT,'business/migrations')).filter(f=>f.endsWith('.sql')).sort();
if (!Array.isArray(bundle.migrations) || bundle.migrations.length !== migrationCount || migrationCount < 2 || migrationCount > migrations.length) throw new Error('Migration version differs');
if (bundle.migrations.map(m=>m.version).sort().join('|') !== migrations.slice(0,migrationCount).join('|')) throw new Error('Migration prefix differs');
for (const migration of bundle.migrations) {
  if (!migrations.includes(migration.version)
    || !migrationChecksumMatches(migration.version, migration.checksum,
      hash(fs.readFileSync(path.join(ROOT,'business/migrations',migration.version),'utf8')))) throw new Error('Migration checksum differs');
}
if (!Array.isArray(bundle.assets)) throw new Error('Missing partner assets');
const assetPaths = new Set();
for (const asset of bundle.assets) {
  if (typeof asset.path !== 'string' || !/^partner\/[a-zA-Z0-9_./-]+\.(md|json)$/.test(asset.path) || asset.path.split('/').some(x=>!x || x === '.' || x === '..') || assetPaths.has(asset.path)) throw new Error('Invalid or duplicate asset path');
  if (typeof asset.content !== 'string' || hash(asset.content) !== asset.sha256) throw new Error('Asset checksum mismatch');
  if (asset.path.endsWith('.json')) JSON.parse(asset.content);
  assetPaths.add(asset.path);
}
if (!assetPaths.has('partner/profile.json')) throw new Error('Missing partner profile');
for (const table of inputTables) if (!Array.isArray(bundle.tables[table])) throw new Error(`Invalid rows for ${table}`);

const migration008 = bundle.migrations.find(m => m.version === '008-outcome-candidates.sql');
const legacyCandidateColumns = ['basis','conversation_id','created_at','decision_id','detector','detector_version','draft_id',
  'engagement_id','evidence_json','id','kind','observed_at','outcome_id','partner_id','resolution_note','revision','source_message_id','status','updated_at'];
const legacyWindowColumns = ['answered_at','candidate_id','closes_at','conversation_id','created_at','coverage','draft_id','id','message_id','opened_at','outcome','partner_id'];
const legacyWindowColumnsWithoutCoverage = legacyWindowColumns.filter(name => name !== 'coverage');
const legacy08HasCoverage = !['9bf883d940a6a174c88a1e68ecde384966b14632813f616322beafbae154498e',
  'a255f1b438928fd000279ed19b87b57ba3881512d32d613f292e99ecae640a64'].includes(migration008?.checksum);
const objectHasColumns = (row, columns) => row && typeof row === 'object' && !Array.isArray(row)
  && Object.keys(row).sort().join('|') === [...columns].sort().join('|');

function migratedOutcomeRows(table, rows, bundleTables) {
  if (migrationCount !== 8) return rows;
  if (table === 'outcome_candidates') {
    const windows = bundleTables.outcome_observation_windows;
    return rows.map(row => ({
      ...row,
      window_id: windows.find(window => window.candidate_id === row.id)?.id ?? null,
      draft_version: null,
      basis_fingerprint: null,
      status: row.status === 'pending' ? 'superseded' : row.status,
      resolution_note: row.status === 'pending' ? 'DETECTOR_VERSION_CHANGED' : row.resolution_note,
      revision: row.revision + (row.status === 'pending' ? 1 : 0),
    }));
  }
  if (table === 'outcome_observation_windows') {
    const candidates = new Map(bundleTables.outcome_candidates.map(row => [row.id, row]));
    const drafts = new Map(bundleTables.drafts.map(row => [row.id, row]));
    const decisionsByDraft = new Map(bundleTables.engagement_actions.map(row => [row.draft_id, row.decision_id]));
    const engagements = new Map(bundleTables.engagement_decisions.map(row => [row.id, row.engagement_id]));
    const indexedAttempts = bundleTables.delivery_attempts.map((row, index) => ({ ...row, transfer_index: index }));
    return rows.map(row => {
      const pendingCandidate = candidates.get(row.candidate_id)?.status === 'pending';
      const draft = row.draft_id ? drafts.get(row.draft_id) : null;
      const decisionId = row.draft_id ? decisionsByDraft.get(row.draft_id) ?? null : null;
      const sentAttempt = row.draft_id ? indexedAttempts.filter(attempt => attempt.draft_id === row.draft_id && attempt.status === 'sent')
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.transfer_index - b.transfer_index).at(-1) : null;
      const outcome = row.outcome === 'pending' || row.outcome === 'expired_unanswered'
        || row.outcome === 'answered' && pendingCandidate ? 'unknown' : row.outcome;
      return {
        ...row,
        draft_version: draft?.current_version ?? null,
        decision_id: decisionId,
        engagement_id: decisionId ? engagements.get(decisionId) ?? null : null,
        delivery_attempt_id: sentAttempt?.id ?? null,
        time_basis: 'recorded',
        coverage: 'unverified',
        coverage_event_id: null,
        outcome,
        answered_at: row.outcome === 'answered' && !pendingCandidate ? row.answered_at : null,
        candidate_id: row.outcome === 'answered' && !pendingCandidate ? row.candidate_id : null,
      };
    });
  }
  return rows;
}

function sanitizeTransferredOutcomes(store, partnerId) {
  const service = new BusinessService(store, { partnerId });
  // A transferred silence interval is not an observation of silence in the destination.
  // Preserve its history but remove the authority to derive a negative candidate from it.
  store.run("UPDATE outcome_observation_windows SET outcome='unknown',coverage='unverified',coverage_event_id=NULL,candidate_id=NULL WHERE outcome IN ('pending','expired_unanswered')");
  store.run("UPDATE outcome_candidates SET status='superseded',resolution_note='TRANSFER_COVERAGE_UNVERIFIED',revision=revision+1,updated_at=? WHERE status='pending' AND kind='no_response_observed'", new Date().toISOString());

  for (const candidate of store.all("SELECT * FROM outcome_candidates WHERE status='pending'")) {
    const window = candidate.window_id && store.get('SELECT * FROM outcome_observation_windows WHERE id=?', candidate.window_id);
    if (candidate.kind === 'reply_observed' && window?.outcome === 'answered' && service.outcomes.fresh(candidate)) continue;
    store.run("UPDATE outcome_candidates SET status='superseded',resolution_note='TRANSFER_PROVENANCE_UNVERIFIED',revision=revision+1,updated_at=? WHERE id=? AND status='pending'",
      new Date().toISOString(), candidate.id);
    if (window?.candidate_id === candidate.id) {
      store.run("UPDATE outcome_observation_windows SET candidate_id=NULL,outcome=CASE WHEN outcome='answered' THEN 'answered' ELSE 'unknown' END,coverage='unverified',coverage_event_id=NULL WHERE id=?",
        window.id);
    }
  }
}

function sanitizeTransferredPrivateState(store) {
  // Historical approvals are tied to a local conversation revision. Bump every revision
  // and stale only drafts that could still be approved or sent; keep delivery truth intact.
  store.run('UPDATE conversations SET revision=revision+1');
  store.run("UPDATE drafts SET status='stale' WHERE status IN ('pending','approved')");
}

function sanitizeTransferredWorkspace(store, partnerId) {
  const transferredAt = new Date().toISOString();
  // Process ownership and leases are local to the source process. Retain ticket/run history,
  // but ensure no imported row can reserve capacity or authorize result application.
  store.run('DELETE FROM control_owners WHERE partner_id=?', partnerId);
  store.run("UPDATE control_tickets SET status='interrupted',reason='TRANSFER_REQUIRES_NEW_OWNER',finished_at=? WHERE partner_id=? AND status IN ('reserved','running')",
    transferredAt, partnerId);
  store.run("UPDATE work_cases SET status='stale',reason='TRANSFER_REQUIRES_REVIEW',revision=revision+1,updated_at=? WHERE partner_id=? AND status='open'",
    transferredAt, partnerId);
  store.run("UPDATE work_materials SET status='stale' WHERE status IN ('proposed','approved') AND case_id IN (SELECT id FROM work_cases WHERE partner_id=?)",
    partnerId);
  store.run("UPDATE work_material_requests SET status='interrupted',reason='TRANSFER_REQUIRES_NEW_OWNER',finished_at=? WHERE status IN ('pending','running') AND case_id IN (SELECT id FROM work_cases WHERE partner_id=?)",
    transferredAt, partnerId);
  store.run("UPDATE work_expectations SET status='unknown',reason='TRANSFER_COVERAGE_UNVERIFIED',updated_at=? WHERE status='pending' AND case_id IN (SELECT id FROM work_cases WHERE partner_id=?)",
    transferredAt, partnerId);
}

function assertOutcomeIntegrity(store, { strictEvidence = false } = {}) {
  const invalid = [
    `SELECT w.id FROM outcome_observation_windows w
       JOIN conversations c ON c.id=w.conversation_id JOIN persons p ON p.id=c.person_id
       JOIN messages m ON m.id=w.message_id
      WHERE w.partner_id<>p.partner_id OR m.conversation_id<>w.conversation_id OR m.direction<>'out'
         OR w.draft_id IS NOT m.draft_id LIMIT 1`,
    `SELECT w.id FROM outcome_observation_windows w JOIN conversations c ON c.id=w.conversation_id
      WHERE w.draft_id IS NOT NULL AND NOT EXISTS
        (SELECT 1 FROM drafts d WHERE d.id=w.draft_id AND d.conversation_id=w.conversation_id) LIMIT 1`,
    `SELECT w.id FROM outcome_observation_windows w JOIN conversations c ON c.id=w.conversation_id
      WHERE w.engagement_id IS NOT NULL AND NOT EXISTS
        (SELECT 1 FROM engagements e WHERE e.id=w.engagement_id AND e.conversation_id=w.conversation_id AND e.partner_id=w.partner_id) LIMIT 1`,
    `SELECT w.id FROM outcome_observation_windows w
      WHERE w.decision_id IS NOT NULL AND NOT EXISTS
        (SELECT 1 FROM engagement_decisions d JOIN engagements e ON e.id=d.engagement_id
          WHERE d.id=w.decision_id AND d.engagement_id=w.engagement_id AND e.conversation_id=w.conversation_id) LIMIT 1`,
    `SELECT w.id FROM outcome_observation_windows w JOIN delivery_attempts a ON a.id=w.delivery_attempt_id
      WHERE a.draft_id IS NOT w.draft_id OR a.status<>'sent' LIMIT 1`,
    `SELECT w.id FROM outcome_observation_windows w JOIN events e ON e.id=w.coverage_event_id
      WHERE e.partner_id<>w.partner_id OR e.conversation_id IS NOT w.conversation_id LIMIT 1`,
    `SELECT w.id FROM outcome_observation_windows w JOIN outcome_candidates c ON c.id=w.candidate_id
      WHERE c.partner_id<>w.partner_id OR c.conversation_id<>w.conversation_id OR c.window_id<>w.id LIMIT 1`,
    `SELECT c.id FROM outcome_candidates c JOIN conversations v ON v.id=c.conversation_id JOIN persons p ON p.id=v.person_id
      WHERE c.partner_id<>p.partner_id LIMIT 1`,
    `SELECT c.id FROM outcome_candidates c WHERE c.engagement_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM engagements e WHERE e.id=c.engagement_id AND e.conversation_id=c.conversation_id AND e.partner_id=c.partner_id) LIMIT 1`,
    `SELECT c.id FROM outcome_candidates c WHERE c.decision_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM engagement_decisions d JOIN engagements e ON e.id=d.engagement_id
        WHERE d.id=c.decision_id AND e.id=c.engagement_id AND e.conversation_id=c.conversation_id AND e.partner_id=c.partner_id) LIMIT 1`,
    `SELECT c.id FROM outcome_candidates c WHERE c.source_message_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM messages m WHERE m.id=c.source_message_id AND m.conversation_id=c.conversation_id
        AND (c.kind!='reply_observed' OR m.direction='in')
        AND (c.kind!='no_response_observed' OR (m.direction='out' AND m.id=(SELECT w.message_id FROM outcome_observation_windows w WHERE w.id=c.window_id)))) LIMIT 1`,
    `SELECT c.id FROM outcome_candidates c WHERE c.draft_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM drafts d WHERE d.id=c.draft_id AND d.conversation_id=c.conversation_id) LIMIT 1`,
    `SELECT c.id FROM outcome_candidates c WHERE c.window_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM outcome_observation_windows w WHERE w.id=c.window_id AND w.partner_id=c.partner_id AND w.conversation_id=c.conversation_id
        AND w.draft_id IS c.draft_id AND w.decision_id IS c.decision_id AND w.engagement_id IS c.engagement_id) LIMIT 1`,
    `SELECT c.id FROM outcome_candidates c JOIN outcome_events o ON o.id=c.outcome_id
      JOIN conversations v ON v.id=c.conversation_id WHERE o.conversation_id<>c.conversation_id OR o.person_id<>v.person_id
         OR ((o.source_message_id IS NOT c.source_message_id OR o.draft_id IS NOT c.draft_id) AND NOT EXISTS
           (SELECT 1 FROM events audit WHERE audit.partner_id=c.partner_id AND audit.conversation_id=c.conversation_id
             AND audit.kind='outcome.candidate_confirmed' AND audit.actor='operator'
             AND json_extract(audit.payload_json,'$.candidate_id')=c.id
             AND json_extract(audit.payload_json,'$.outcome_id')=o.id
             AND json_extract(audit.payload_json,'$.linked_existing')=1)) LIMIT 1`,
  ];
  if (invalid.some(sql => store.get(sql))) throw new Error('Outcome references cross a partner, conversation, or provenance boundary');

  for (const row of store.all('SELECT id,kind,status,evidence_json,window_id,source_message_id,draft_id,decision_id FROM outcome_candidates')) {
    let evidence;
    try { evidence = JSON.parse(row.evidence_json); } catch { throw new Error('Invalid outcome evidence'); }
    const refs = [
      ['window_id', row.window_id], ['reply_message_id', row.kind === 'reply_observed' ? row.source_message_id : null],
      ['draft_id', row.draft_id], ['decision_id', row.decision_id],
    ];
    if (refs.some(([key, expected]) => evidence[key] != null && evidence[key] !== expected))
      throw new Error('Outcome evidence does not match its provenance columns');
    const window = row.window_id && store.get('SELECT message_id FROM outcome_observation_windows WHERE id=?', row.window_id);
    if (strictEvidence && row.status === 'pending' && row.window_id && (evidence.window_id !== row.window_id || evidence.sent_message_id !== window?.message_id
      || (row.kind === 'reply_observed' && evidence.reply_message_id !== row.source_message_id)))
      throw new Error('Outcome evidence omits required message provenance');
    if (evidence.sent_message_id != null) {
      if (!window || evidence.sent_message_id !== window.message_id) throw new Error('Outcome evidence does not match its sent message');
    }
  }
}

const store = new Store(path.join(destination,'data'));
try {
  store.transaction(()=>{
    store.db.exec('PRAGMA defer_foreign_keys=ON');
    for (const table of [...TABLES].reverse()) store.run(`DELETE FROM ${table}`);
    for (const table of TABLES) {
      const columns = store.all(`PRAGMA table_info(${table})`).map(c=>c.name);
      const statement = store.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`);
      const sourceRows = bundle.tables[table] ?? [];
      for (const sourceRow of sourceRows) {
        let row = sourceRow;
        if (migrationCount === 8 && table === 'outcome_candidates'
          && !objectHasColumns(row, legacyCandidateColumns)) throw new Error('Unexpected columns in outcome_candidates');
        if (migrationCount === 8 && table === 'outcome_observation_windows'
          && !objectHasColumns(row, legacy08HasCoverage ? legacyWindowColumns : legacyWindowColumnsWithoutCoverage))
          throw new Error('Unexpected columns in outcome_observation_windows');
        if (migrationCount < 9 && table === 'messages') {
          const oldColumns = columns.filter(name => !['occurred_at', 'time_basis'].includes(name));
          if (!objectHasColumns(row, oldColumns)) throw new Error('Unexpected columns in messages');
          row = { ...row, occurred_at: null, time_basis: 'recorded' };
        } else if (migrationCount === 8 && OUTCOME_TABLES.includes(table)) {
          // The v1 rows are adapted after both outcome arrays have been shape-checked below.
          continue;
        } else if (!objectHasColumns(row, columns)) throw new Error(`Unexpected columns in ${table}`);
        statement.run(...columns.map(c=>row[c]));
      }
    }
    if (migrationCount === 8) {
      for (const table of OUTCOME_TABLES) {
        const columns = store.all(`PRAGMA table_info(${table})`).map(c=>c.name);
        const statement = store.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`);
        for (const row of migratedOutcomeRows(table, bundle.tables[table], bundle.tables))
          statement.run(...columns.map(c=>row[c]));
      }
    }
    if (migrationCount >= 9) {
      const profile = bundle.assets.find(asset => asset.path === 'partner/profile.json');
      const partnerId = JSON.parse(profile.content).id;
      if (!partnerId || store.get('SELECT id FROM partners WHERE id=?', partnerId) == null) throw new Error('Imported profile does not match partner data');
      sanitizeTransferredOutcomes(store, partnerId);
    }
    sanitizeTransferredPrivateState(store);
    if (migrationCount >= 10) {
      const profile = bundle.assets.find(asset => asset.path === 'partner/profile.json');
      const partnerId = JSON.parse(profile.content).id;
      if (!partnerId || store.get('SELECT id FROM partners WHERE id=?', partnerId) == null) throw new Error('Imported profile does not match partner data');
      sanitizeTransferredWorkspace(store, partnerId);
    }
    if (migrationCount >= 11) {
      store.run("UPDATE scout_grants SET status='revoked',reason='TRANSFER_AUTHORITY_REQUIRES_REVIEW' WHERE status='active'");
      store.run("UPDATE scout_jobs SET status='stale',owner_id=NULL,reason='TRANSFER_AUTHORITY_REQUIRES_REVIEW' WHERE status IN ('queued','running','interrupted')");
      store.run("UPDATE scout_assessments SET status='stale' WHERE status IN ('proposed','approved')");
      store.run("UPDATE scout_calls SET status='unknown',reason='TRANSFER_READ_UNKNOWN' WHERE status='started'");
      store.run("DELETE FROM channel_offsets WHERE channel IN ('scout-monitor-v1','telegram-source-start-v1')");
    }
    // Observation cursors are local recovery progress, not transferable evidence.
    // Replaying committed intents is idempotent and never repeats a send.
    store.run("DELETE FROM channel_offsets WHERE channel='outcome-observation-v2'");
    assertOutcomeIntegrity(store, { strictEvidence: migrationCount >= 9 });
    // Exported grants are history, never transferable execution authority. Artifact
    // bytes are deliberately excluded from a whole-partner export.
    for (const row of store.all('SELECT id,partner_id,status FROM action_proposals')) {
      store.run("UPDATE action_grants SET status='revoked',reason='TRANSFER_REQUIRES_NEW_PROPOSAL',updated_at=? WHERE action_id=? AND status IN ('active','consumed')", new Date().toISOString(), row.id);
      store.run("UPDATE action_attempts SET status=CASE WHEN status='prepared' THEN 'not_executed' WHEN status='dispatching' THEN 'unknown' ELSE status END,verification_state='unavailable',verification_json=?,verified_at=NULL WHERE action_id=?",
        JSON.stringify({state:'unavailable',reason:'TRANSFER_BOUNDARY'}), row.id);
      store.run("UPDATE action_proposals SET status='revoked',reason='TRANSFER_REQUIRES_NEW_PROPOSAL',verify_requested=0,revision=revision+1 WHERE id=?", row.id);
      store.run("UPDATE tasks SET status='cancelled' WHERE id=(SELECT task_id FROM action_proposals WHERE id=?) AND status IN ('proposed','pending')", row.id);
      store.event(row.partner_id, null, 'action.transfer_invalidated', 'system', {action_id:row.id, previous_status:row.status, artifact_bytes_transferred:false});
    }
    if (store.all('PRAGMA foreign_key_check').length) throw new Error('Imported references are inconsistent');
  });
  for (const asset of bundle.assets) {
    const file = path.join(destination,asset.path);
    fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,asset.content,{flag:'wx'});
  }
  // Preserve the original interrupted/sending state until the next service startup recovers it.
  fs.writeFileSync(path.join(destination,'RESTORE-INFO.json'),JSON.stringify({source:path.resolve(source),exported_at:bundle.exported_at,created_at:new Date().toISOString(),status:'staged_not_activated'},null,2));
  console.log(`Restored to ${destination}. Active data was not changed. Follow README.md to activate after stopping the service.`);
} finally { store.close(); }
