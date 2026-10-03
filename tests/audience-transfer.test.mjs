// Audience authority does not survive a workspace transfer. All fixtures are local and offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../business/config.mjs';
import { exportPartner } from '../business/export.mjs';
import { Store, id } from '../business/store.mjs';
import { audienceHarness, SOURCE, proposalFrom } from './audience-test-helpers.mjs';

test('schema-12 transfer preserves audience work scope while revoking its authority', async t => {
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
  assert.equal(bundle.migrations.length, 12);
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
