import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspaceHarness } from './helpers/workspace-harness.mjs';
import { hash } from '../business/store.mjs';

const materialProposal = (material) => ({ capability_id: 'material.export_local.v1', title: 'Ready material',
  instructions: 'Publish this reviewed material locally.', expected_result: 'An exact local copy.', due_at: null, material });

test('material export binds the reviewed immutable version and verifies exact published bytes', async t => {
  const h = workspaceHarness(t), caseId = await h.ready();
  const continuity = h.service.continuity.detail(h.service.work.detail(caseId).thread_id);
  const acceptedBasis = continuity.basis_fingerprint;
  const { material_id: materialId } = await h.material(caseId);
  await h.approve(caseId, materialId);
  const approved = h.service.work.detail(caseId).materials.find(m => m.id === materialId);

  const actionId = await h.execute(caseId, materialId);
  const detail = h.service.actions.detail(actionId);
  assert.equal(detail.status, 'completed');
  assert.equal(detail.proposal.capability_id, 'material.export_local.v1');
  assert.deepEqual(detail.proposal.material, { id: approved.id, sha256: approved.sha256 });
  assert.equal(detail.packet.material.content, approved.content);
  assert.equal(detail.packet.material.sha256, approved.sha256);
  assert.equal(detail.packet.material.version, approved.version);
  assert.equal(detail.packet.material.thread_id, detail.thread_id);
  assert.equal(detail.packet.material.basis_fingerprint, acceptedBasis);
  assert.equal(h.service.continuity.detail(detail.thread_id).basis_fingerprint, acceptedBasis,
    'material review and export must not mutate accepted Continuity');

  const artifact = await h.scheduler.actionRuntime.capabilities.artifact(h.service.actions.get(actionId));
  const file = path.join(h.directory, 'action-artifacts', `${actionId}.json`);
  const bytes = fs.readFileSync(file);
  assert.equal(artifact.format, 'harnes2-owner-material-v1');
  assert.equal(artifact.material.content, approved.content);
  assert.equal(artifact.material.sha256, hash(Buffer.from(approved.content, 'utf8')));
  assert.equal(hash(bytes), detail.attempts[0].verification.sha256);
  assert.equal(detail.attempts[0].verification.state, 'present');
  assert.equal(artifact.contact_permission, false);
  assert.equal(artifact.external_write, false);
});

test('material reference is required only for material export and old proposal canonical form is unchanged', async t => {
  const h = workspaceHarness(t), caseId = await h.ready();
  const { material_id: materialId } = await h.material(caseId); await h.approve(caseId, materialId);
  const approved = h.service.work.detail(caseId).materials.find(m => m.id === materialId);
  const threadId = h.service.work.detail(caseId).thread_id;
  const basis = h.service.continuity.detail(threadId).basis_fingerprint;
  const legacy = { capability_id: 'brief.publish_local.v1', title: 'Brief', instructions: 'Review the packet.',
    expected_result: 'Owner-local brief.', due_at: null };
  const legacyAction = await h.command('action.propose', { thread_id: threadId, expected_basis_fingerprint: basis,
    proposal: legacy, reason: 'Preserve existing brief behavior' });
  const stored = JSON.parse(h.service.actions.get(legacyAction.action_id).proposal_json);
  assert.deepEqual(stored, legacy);
  assert.equal(Object.hasOwn(stored, 'material'), false);

  await assert.rejects(h.command('action.propose', { thread_id: threadId, expected_basis_fingerprint: basis,
    proposal: materialProposal(undefined), reason: 'Missing material pin' }));
  await assert.rejects(h.command('action.propose', { thread_id: threadId, expected_basis_fingerprint: basis,
    proposal: { ...legacy, material: { id: approved.id, sha256: approved.sha256 } }, reason: 'Legacy action with material' }));
  assert.deepEqual(h.service.actions.checkedProposal(materialProposal({ id: approved.id, sha256: approved.sha256 })),
    { ...materialProposal({ id: approved.id, sha256: approved.sha256 }) });
});

test('model action planning cannot select or export owner-reviewed material', async t => {
  const h = workspaceHarness(t), caseId = await h.ready();
  h.config.actions.modelEnabled = true;
  const threadId = h.service.work.detail(caseId).thread_id;
  const basis = h.service.continuity.detail(threadId).basis_fingerprint;
  const { action_id: actionId } = await h.command('action.request_plan', { thread_id: threadId, expected_basis_fingerprint: basis });
  const row = h.service.actions.get(actionId);
  assert.throws(() => h.service.actions.applyPlan(row, { kind: 'action', reason: 'Try to select material',
    proposal: materialProposal({ id: 'material-id', sha256: 'a'.repeat(64) }) }), { code: 'ACTION_MATERIAL_OWNER_PREPARATION_REQUIRED' });
  assert.equal(h.service.actions.get(actionId).status, 'plan_requested');
});
