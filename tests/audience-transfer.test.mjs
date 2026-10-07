// Audience authority does not survive a workspace transfer. All fixtures are local and offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../business/config.mjs';
import { exportPartner } from '../business/export.mjs';
import { Store, hash, id } from '../business/store.mjs';
import { audienceHarness, SOURCE, proposalFrom } from './audience-test-helpers.mjs';

test('schema-18 transfer preserves audience work scope while revoking its authority', async t => {
  const h = audienceHarness(t);
  const goal = await h.open({ source_ids: [SOURCE] });
  await h.ingest({ message_id: 'transfer-question', text: 'How do I get started with the programme?' });
  h.service.audience.reconcile({ limit: 10 });
  const captured = await h.capture(goal.goal_id);
  const assessment = h.service.audience.assessment(captured.assessment_id);
  const proposal = await h.command('audience.propose', { assessment_id: assessment.id,
    output: proposalFrom(assessment.packet) });
  let need = h.service.audience.need(proposal.need_ids[0]);
  await h.command('audience.review', { need_id: need.id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint, decision: 'accept', note: 'Reviewed one direct question.' });
  need = h.service.audience.need(need.id);
  assert.equal(need.status, 'accepted');

  const work = await h.command('audience.open_work', { need_id: need.id,
    expected_revision: need.revision, expected_basis_fingerprint: need.basis_fingerprint });
  const turn = h.service.continuity.turn(work.turn_id);
  await h.command('continuity.review', { turn_id: turn.id, expected_basis_fingerprint: turn.basis_fingerprint,
    decision: 'accept', note: 'Reviewed the scoped Continuity proposal.' });
  const ready = h.service.continuity.detail(work.thread_id);
  const opened = await h.command('work.open', { thread_id: work.thread_id,
    expected_basis_fingerprint: ready.basis_fingerprint, title: 'Prepare a clear starting point' });
  assert.ok(opened.case_id);

  const bundle = exportPartner(h.store), file = path.join(h.directory, 'audience-transfer.json');
  assert.equal(bundle.migrations.length, 18);
  assert.equal(bundle.tables.audience_needs.find(row => row.id === need.id).status, 'accepted');
  assert.equal(bundle.tables.audience_work_links.find(row => row.thread_id === work.thread_id).need_id, need.id);
  fs.writeFileSync(file, JSON.stringify(bundle), { flag: 'wx' });
  const destination = path.join(ROOT, 'exports', `audience-transfer-${id()}`);
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, ['scripts/import.mjs', file, destination],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);

  const restored = new Store(path.join(destination, 'data'));
  try {
    assert.equal(restored.get('SELECT status FROM audience_watches WHERE goal_id=? AND source_ref=?', goal.goal_id, SOURCE).status, 'revoked');
    assert.equal(restored.get('SELECT status FROM audience_needs WHERE id=?', need.id).status, 'stale');
    assert.equal(restored.get('SELECT thread_id FROM audience_work_links WHERE need_id=?', need.id).thread_id, work.thread_id,
      'the historical dependency remains attached to the linked thread');
    assert.equal(restored.get('SELECT status FROM work_cases WHERE id=?', opened.case_id).status, 'stale');
    const service = new (await import('../business/service.mjs')).BusinessService(restored, h.config);
    const detail = service.continuity.detail(work.thread_id);
    assert.equal(detail.ready, false);
    assert.ok(detail.audience_scope, 'the linked thread must not fall back to generic Continuity');
    assert.ok(detail.audience_scope.reasons.includes('AUDIENCE_NEED_STALE'));
    assert.deepEqual(restored.all('PRAGMA foreign_key_check'), []);
  } finally { restored.close(); }
});

test('schema-17 first-contact proposal imports with an empty review-head table and no invented review', async t => {
  const h=audienceHarness(t), goal=await h.open({source_ids:[SOURCE],max_age_seconds:3600});
  const createdAt=new Date().toISOString();
  await h.command('source.ingest',{source_id:SOURCE,source_kind:'sanitized_fixture',message_id:'schema17-first-contact',
    author_id:`author:${SOURCE}`,display_name:null,thread_id:null,reply_to_id:null,version:1,operation:'upsert',
    text:'Where can I find the first step?',created_at:createdAt,updated_at:createdAt},id(),{kind:'channel',sourceId:SOURCE});
  h.service.audience.reconcile({limit:10});
  const capture=await h.capture(goal.goal_id),assessment=h.service.audience.assessment(capture.assessment_id);
  const event=assessment.packet.exchanges.flatMap(exchange=>exchange.evidence)[0];
  const output=proposalFrom(assessment.packet,{next_step:'prepare_material',material_preview:{title:'First step',
    content:'The question asks where to find the first step.',evidence_event_ids:[event.source_event_id]}});
  output.needs[0].first_contact={version:1,target_event_id:event.source_event_id,target_quote:event.text,
    channel:'public_reply',help:'Point to the first step if it is available.',
    channel_reason:'The public question names a concrete missing first step.'};
  const proposed=await h.command('audience.propose',{assessment_id:assessment.id,output});
  const bundle=exportPartner(h.store);
  bundle.migrations=bundle.migrations.slice(0,17);
  delete bundle.tables.audience_first_contact_heads;
  bundle.tables_sha256=hash(JSON.stringify(bundle.tables));
  assert.equal(bundle.migrations.length,17);

  const file=path.join(h.directory,'canonical-schema17-first-contact.json');
  fs.writeFileSync(file,JSON.stringify(bundle),{flag:'wx'});
  const destination=path.join(ROOT,'exports',`schema17-first-contact-${id()}`);
  t.after(()=>fs.rmSync(destination,{recursive:true,force:true}));
  const child=spawnSync(process.execPath,['scripts/import.mjs',file,destination],{cwd:ROOT,encoding:'utf8',windowsHide:true});
  assert.equal(child.status,0,child.stderr);
  const restored=new Store(path.join(destination,'data'));
  let imported;
  try {
    assert.equal(restored.get('SELECT COUNT(*) n FROM schema_migrations').n,18);
    assert.equal(restored.get('SELECT COUNT(*) n FROM audience_first_contact_heads').n,0);
    assert.equal(restored.get("SELECT COUNT(*) n FROM events WHERE kind='audience.review_first_contact'").n,0);
    imported=new (await import('../business/service.mjs')).BusinessService(restored,h.config);
    const need=imported.audience.need(proposed.need_ids[0]);
    assert.equal(need.first_contact_state.review,null);
    assert.notEqual(need.first_contact_state.state,'approved');
    assert.deepEqual(restored.all('PRAGMA foreign_key_check'),[]);
  } finally { imported?.control?.close?.(); restored.close(); }
});
