import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../business/config.mjs';
import { Store, id, hash } from '../business/store.mjs';
import { exportPartner } from '../business/export.mjs';
import { WORK_TABLES, CONTROL_TABLES } from '../business/work-tables.mjs';
import { SCOUT_TABLES } from '../business/scout-tables.mjs';
import { AUDIENCE_TABLES } from '../business/audience-tables.mjs';
import { MODEL_PROFILE_TABLES } from '../business/model-profile-tables.mjs';
import { BusinessService } from '../business/service.mjs';
import { workspaceHarness } from './helpers/workspace-harness.mjs';

function addPrivateHistory(h) {
  const personId = id(), created = new Date().toISOString();
  h.store.run('INSERT INTO persons(id,partner_id,name,source,notes,permission,suppressed,created_at) VALUES(?,?,?,?,?,?,?,?)',
    personId, h.config.partnerId, 'Transfer fixture', 'operator', '', '', 0, created);
  const drafts = {};
  for (const status of ['pending','approved','sent','delivery_unknown']) {
    const conversationId = id(), draftId = id();
    h.store.run(`INSERT INTO conversations(id,person_id,channel,ownership,revision,stage,created_at)
      VALUES(?,?,'telegram','AI_OWNED',7,'active',?)`, conversationId, personId, created);
    h.store.run(`INSERT INTO drafts(id,conversation_id,action,reason,status,context_revision,current_version,created_at)
      VALUES(?,?,'reply','transfer fixture',?,7,1,?)`, draftId, conversationId, status, created);
    h.store.run('INSERT INTO draft_versions(id,draft_id,version,text,author,reason,created_at) VALUES(?,?,1,?,?,?,?)',
      id(), draftId, `Historical ${status} text`, 'operator', '', created);
    if (status === 'approved') h.store.run('INSERT INTO approvals VALUES(?,?,?,?,?,?)', id(), draftId, 1, 7, 'operator', created);
    if (status === 'sent' || status === 'delivery_unknown') h.store.run(`INSERT INTO delivery_attempts(id,draft_id,draft_version,channel,recipient,status,external_id,error,created_at,finished_at)
      VALUES(?, ?, 1, 'telegram', 'fixture-recipient', ?, ?, NULL, ?, ?)`, id(), draftId, status,
    status === 'sent' ? 'external-sent-fixture' : null, created, created);
    drafts[status] = { id: draftId, conversation_id: conversationId };
  }
  return drafts;
}

function importBundle(t, h, destinationName, { migrationCount = 12 } = {}) {
  const bundle = exportPartner(h.store);
  if (migrationCount < 14) {
    for (const table of MODEL_PROFILE_TABLES) delete bundle.tables[table];
  }
  if (migrationCount < 13) {
    delete bundle.tables.audience_attention_grants;
    delete bundle.tables.audience_attention_attempts;
  }
  if (migrationCount < 12) {
    for (const table of AUDIENCE_TABLES) delete bundle.tables[table];
  }
  if (migrationCount < 11) {
    for (const table of SCOUT_TABLES) delete bundle.tables[table];
  }
  if (migrationCount < 10) {
    for (const table of [...WORK_TABLES, ...CONTROL_TABLES]) delete bundle.tables[table];
  }
  if (migrationCount < 14) {
    bundle.migrations = bundle.migrations.slice(0, migrationCount);
    bundle.tables_sha256 = hash(JSON.stringify(bundle.tables));
  }
  const source = path.join(h.directory, `${destinationName}.json`);
  const destination = path.join(ROOT, 'exports', `${destinationName}-${id()}`);
  fs.writeFileSync(source, JSON.stringify(bundle), { flag: 'wx' });
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, ['scripts/import.mjs', source, destination],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  return { destination, bundle };
}

test('schema-11 transfer keeps work/material history but removes live authority and invalidates private approvals', async t => {
  const h = workspaceHarness(t), caseId = await h.ready();
  const { material_id: materialId } = await h.material(caseId); await h.approve(caseId, materialId);
  const originalMaterial = h.service.work.detail(caseId).materials.find(m => m.id === materialId);
  const actionId = await h.execute(caseId, materialId);
  let work = h.service.work.detail(caseId);
  await h.command('work.expect', { case_id: caseId, expected_revision: work.revision, question: 'Any further public evidence?',
    deadline: new Date(Date.now() + 86400000).toISOString() });
  const privateDrafts = addPrivateHistory(h);
  const timestamp = new Date(Date.now() + 3600000).toISOString();
  const ownerId = id();
  h.store.run('INSERT INTO control_owners(partner_id,owner_id,pid,expires_at) VALUES(?,?,?,?)', h.config.partnerId, ownerId, process.pid, timestamp);
  const ticketIds = {};
  for (const status of ['reserved','running','completed']) {
    const ticketId = id(); ticketIds[status] = ticketId;
    h.store.run(`INSERT INTO control_tickets(id,partner_id,plane,operation,owner_id,status,reserved_usd,expires_at,created_at,finished_at,reason)
      VALUES(?,?,'work','material.prepare.v1',?,?,0.25,?,?,?,NULL)`, ticketId, h.config.partnerId, ownerId, status,
    timestamp, timestamp, status === 'completed' ? timestamp : null);
  }
  // Creating a pending request is an owner command; model execution stays disabled/offline.
  h.config.workspace.modelEnabled = true;
  const request = await h.command('work.request_material', { case_id: caseId, expected_revision: h.service.work.detail(caseId).revision });
  h.store.run("UPDATE work_material_requests SET status='running' WHERE id=?", request.request_id);

  const scoutCampaign=id(),scoutGrant=id(),scoutJob=id(),scoutCall=id(),created=new Date().toISOString();
  h.store.run("INSERT INTO scout_campaigns VALUES(?,?,?,?,?,1,?,'active',?,?)",scoutCampaign,h.config.partnerId,'Transfer Scout','Transfer Scout topic','{}','a'.repeat(64),created,created);
  h.store.run("INSERT INTO scout_grants(id,campaign_id,campaign_revision,kind,account_id,purpose,expires_at,status,created_at) VALUES(?,?,1,'audit',?,?,?,'active',?)",
    scoutGrant,scoutCampaign,'999','Transfer fixture',new Date(Date.now()+86400000).toISOString(),created);
  h.store.run("INSERT INTO scout_jobs(id,campaign_id,campaign_revision,grant_id,kind,status,cursor_json,next_at,created_at,updated_at) VALUES(?,?,1,?,'search','queued','{}',?,?,?)",
    scoutJob,scoutCampaign,scoutGrant,created,created,created);
  h.store.run("INSERT INTO scout_calls(id,partner_id,account_id,job_id,operation,status,created_at) VALUES(?,?,?,?,'search','started',?)",
    scoutCall,h.config.partnerId,'999',scoutJob,created);

  const { destination,bundle } = importBundle(t, h, 'workspace-transfer-v11', { migrationCount: 11 });
  assert.equal(bundle.migrations.length, 11, 'the fixture remains an actual schema-11 export');
  assert.equal(AUDIENCE_TABLES.some(table => Object.hasOwn(bundle.tables, table)), false);
  assert.equal(SCOUT_TABLES.every(table=>Object.hasOwn(bundle.tables,table)),true);
  const store = new Store(path.join(destination, 'data'));
  try {
    const restoredMaterial = store.get('SELECT * FROM work_materials WHERE id=?', materialId);
    assert.equal(restoredMaterial.content, originalMaterial.content);
    assert.equal(restoredMaterial.sha256, originalMaterial.sha256);
    assert.equal(restoredMaterial.status, 'stale');
    const restoredCase = store.get('SELECT * FROM work_cases WHERE id=?', caseId);
    assert.equal(restoredCase.status, 'stale'); assert.equal(restoredCase.reason, 'TRANSFER_REQUIRES_REVIEW');
    assert.equal(restoredCase.action_id, actionId);
    assert.equal(store.get('SELECT status FROM work_material_requests WHERE id=?', request.request_id).status, 'interrupted');
    assert.equal(store.get('SELECT status FROM work_expectations WHERE case_id=?', caseId).status, 'unknown');
    assert.equal(store.get('SELECT COUNT(*) n FROM control_owners').n, 0);
    assert.equal(store.get("SELECT status FROM control_tickets WHERE id=?", ticketIds.reserved).status, 'interrupted');
    assert.equal(store.get("SELECT status FROM control_tickets WHERE id=?", ticketIds.running).status, 'interrupted');
    assert.equal(store.get("SELECT status FROM control_tickets WHERE id=?", ticketIds.completed).status, 'completed', 'completed ticket is history');
    assert.equal(store.get("SELECT COUNT(*) n FROM control_tickets WHERE status IN ('reserved','running')").n, 0);
    assert.equal(store.get("SELECT status FROM action_proposals WHERE id=?", actionId).status, 'revoked');
    assert.equal(store.get("SELECT COUNT(*) n FROM action_grants WHERE action_id=? AND status IN ('active','consumed')", actionId).n, 0);
    assert.equal(store.get('SELECT status FROM scout_grants WHERE id=?',scoutGrant).status,'revoked');
    assert.equal(store.get('SELECT status FROM scout_jobs WHERE id=?',scoutJob).status,'stale');
    assert.equal(store.get('SELECT status FROM scout_calls WHERE id=?',scoutCall).status,'unknown');

    for (const state of ['pending','approved']) {
      const draft = privateDrafts[state];
      assert.equal(store.get('SELECT status FROM drafts WHERE id=?', draft.id).status, 'stale');
      assert.equal(store.get('SELECT revision FROM conversations WHERE id=?', draft.conversation_id).revision, 8);
    }
    assert.equal(store.get("SELECT COUNT(*) n FROM approvals WHERE draft_id=?", privateDrafts.approved.id).n, 1, 'approval history remains');
    for (const state of ['sent','delivery_unknown']) {
      assert.equal(store.get('SELECT status FROM drafts WHERE id=?', privateDrafts[state].id).status, state);
      assert.equal(store.get('SELECT status FROM delivery_attempts WHERE draft_id=?', privateDrafts[state].id).status, state);
    }
    const restored = new BusinessService(store, h.config);
    assert.throws(() => restored.work.materialPacket({ id: materialId, sha256: originalMaterial.sha256 }, restoredCase.thread_id, restoredCase.basis_fingerprint),
      { code: 'WORK_STALE_BASIS' });
    assert.deepEqual(store.all('PRAGMA foreign_key_check'), []);
    assert.equal(fs.existsSync(path.join(destination, 'data', 'action-artifacts', `${actionId}.json`)), false,
      'local artifact bytes are not included in a partner export');
  } finally { store.close(); }
});

test('schema-9 bundle remains a supported positive control with Outcome transfer sanitation', async t => {
  const h = workspaceHarness(t), caseId = await h.ready();
  const { material_id: materialId } = await h.material(caseId); await h.approve(caseId, materialId);
  const { destination, bundle } = importBundle(t, h, 'workspace-transfer-v9', { migrationCount: 9 });
  assert.equal(Object.keys(bundle.tables).some(table => [...WORK_TABLES, ...CONTROL_TABLES].includes(table)), false);
  const store = new Store(path.join(destination, 'data'));
  try {
    assert.equal(store.all('SELECT * FROM schema_migrations').length, 14);
    assert.equal(store.get('SELECT COUNT(*) n FROM work_cases').n, 0);
    assert.equal(store.get('SELECT COUNT(*) n FROM control_tickets').n, 0);
    assert.deepEqual(store.all('PRAGMA foreign_key_check'), []);
  } finally { store.close(); }
});

test('schema-10 historical bundle has work/control state but excludes later Scout tables',async t=>{
  const h=workspaceHarness(t),caseId=await h.ready();
  const {destination,bundle}=importBundle(t,h,'workspace-transfer-v10-history',{migrationCount:10});
  assert.equal(SCOUT_TABLES.some(table=>Object.hasOwn(bundle.tables,table)),false);
  assert.equal(Object.hasOwn(bundle.tables,'work_cases'),true);
  const store=new Store(path.join(destination,'data'));
  try{
    assert.equal(store.all('SELECT * FROM schema_migrations').length,14);
    assert.equal(store.get('SELECT COUNT(*) n FROM work_cases WHERE id=?',caseId).n,1);
    assert.equal(store.get('SELECT COUNT(*) n FROM scout_campaigns').n,0);
    assert.deepEqual(store.all('PRAGMA foreign_key_check'),[]);
  }finally{store.close();}
});
