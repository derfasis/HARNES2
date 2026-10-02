import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceHarness } from './helpers/workspace-harness.mjs';

test('two-day work: ready material, independent local verification, expectation, restart, changed evidence, same goal/case', async t => {
  const h = workspaceHarness(t), case_id = await h.ready();
  const basis = h.service.continuity.detail(h.service.work.detail(case_id).thread_id).basis_fingerprint;
  const { material_id } = await h.material(case_id); await h.approve(case_id, material_id);
  assert.equal(h.service.continuity.detail(h.service.work.detail(case_id).thread_id).basis_fingerprint, basis, 'material review must not alter memory basis');
  const action_id = await h.execute(case_id, material_id);
  assert.equal(h.service.actions.detail(action_id).status, 'completed');
  const artifact = await h.scheduler.actionRuntime.capabilities.artifact(h.service.actions.get(action_id));
  assert.equal(artifact.material.content, h.service.work.detail(case_id).material.content);
  let d = h.service.work.detail(case_id);
  await h.command('work.expect', { case_id, expected_revision: d.revision, question: 'Was any further public evidence observed?', deadline: new Date(Date.now() + 86400000).toISOString() });
  h.restart(); await h.scheduler.sourceTick(); await h.scheduler.actionTick();
  assert.equal(h.store.get('SELECT COUNT(*) n FROM work_cases').n, 1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM action_attempts').n, 1, 'restart verifies; never replays effect');
  await h.ingest({ message_id: 'm2', text: 'Requirement depends on the task.' }); await h.scheduler.sourceTick();
  d = h.service.work.detail(case_id);
  assert.equal(d.expectation.status, 'evidence_observed');
  assert.equal(d.expectation.causal_credit, false);
  assert.equal(d.current, false);
  await h.accept(d.thread_id); d = h.service.work.detail(case_id);
  await h.command('work.refresh', { case_id, expected_revision: d.revision, expected_basis_fingerprint: h.service.continuity.detail(d.thread_id).basis_fingerprint });
  assert.equal(h.service.work.detail(case_id).current, true);
  const secondMaterial = (await h.material(case_id, 'The later source says time depends on the task. This remains an unverified source statement.')).material_id;
  await h.approve(case_id, secondMaterial);
  const secondAction = await h.execute(case_id, secondMaterial);
  d = h.service.work.detail(case_id);
  assert.equal(d.action.id, secondAction);
  assert.equal(d.next_move, 'define_expectation', 'a previous action expectation cannot silently become the new action expectation');
  const previousExpectation = d.expectation.id;
  await h.command('work.expect', { case_id, expected_revision: d.revision, question: 'Does the current source add evidence about the updated material?', deadline: new Date(Date.now() + 86400000).toISOString() });
  assert.equal(h.service.work.detail(case_id).expectation.action_id, secondAction);
  assert.equal(h.store.get('SELECT reason FROM work_expectations WHERE id=?', previousExpectation).reason, 'EXPECTATION_REPLACED');
  assert.equal(h.store.get("SELECT COUNT(*) n FROM work_expectations WHERE status IN ('pending','evidence_observed')").n, 1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM partner_threads').n, 1);
  for (const table of ['persons','conversations','contact_permissions','drafts','approvals','delivery_attempts','outcome_events'])
    assert.equal(h.store.get(`SELECT COUNT(*) n FROM ${table}`).n, 0, table);
});

test('material version/review is exact and dependent stale evidence refuses effect authority', async t => {
  const h = workspaceHarness(t), case_id = await h.ready(); const { material_id } = await h.material(case_id);
  await assert.rejects(h.command('work.prepare_action', { case_id, expected_revision: h.service.work.detail(case_id).revision, material_id, capability_id: 'material.export_local.v1' }), { code: 'WORK_MATERIAL_REVIEW_REQUIRED' });
  await h.approve(case_id, material_id);
  const old = h.service.work.detail(case_id).material;
  await h.material(case_id, 'Different exact content');
  await assert.rejects(h.command('work.prepare_action', { case_id, expected_revision: h.service.work.detail(case_id).revision, material_id, capability_id: 'material.export_local.v1' }), { code: 'WORK_MATERIAL_SUPERSEDED' });
  assert.equal(h.service.work.detail(case_id).materials.find(m => m.id === material_id).sha256, old.sha256);
  await h.ingest({ version: 2, operation: 'delete', text: null });
  await assert.rejects(h.material(case_id), { code: 'WORK_STALE_BASIS' });
});

test('workspace proposal and admission ticket never manufacture owner authority', async t => {
  const h = workspaceHarness(t), case_id = await h.ready(); const { material_id } = await h.material(case_id);
  const p = { case_id, expected_revision: h.service.work.detail(case_id).revision, material_id, sha256: h.service.work.detail(case_id).material.sha256, decision: 'approve', note: 'approve' };
  await assert.rejects(h.command('work.review', p, undefined, { kind: 'agent' }), { status: 403 });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM action_grants').n, 0);
  h.config.workspace.enabled = false;
  await assert.rejects(h.material(case_id), { code: 'WORKSPACE_DISABLED' });
});
