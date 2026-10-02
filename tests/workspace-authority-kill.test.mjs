import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspaceHarness } from './helpers/workspace-harness.mjs';
import { processWork } from '../business/work-reasoning.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function spin(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setImmediate(r)); }
  assert.fail('expected state was never reached');
}
function modelReady(h, t) {
  h.config.workspace.modelEnabled = true;
  h.config.runtime.model = 'offline-fake'; h.config.runtime.baseUrl = 'https://example.invalid';
  const oldKey = process.env.PARTNER_MODEL_API_KEY; process.env.PARTNER_MODEL_API_KEY = 'offline-not-a-credential';
  t.after(() => { if (oldKey === undefined) delete process.env.PARTNER_MODEL_API_KEY; else process.env.PARTNER_MODEL_API_KEY = oldKey; });
}
const validMaterial = (h, caseId) => ({ completed: true,
  final_response: JSON.stringify({ title: 'Reviewed response', content: '# Response\n\nGrounded in current evidence.', evidence_event_ids: h.service.work.detail(caseId).evidence_event_ids }),
  usage: { input_tokens: 10, output_tokens: 5, estimated_cost_usd: 0.01, cost_status: 'runtime_estimate' } });

test('the same valid model material succeeds with current authority and remains a proposal without grants', async t => {
  const h = workspaceHarness(t), caseId = await h.ready(); modelReady(h, t);
  const basis = h.service.continuity.detail(h.service.work.detail(caseId).thread_id).basis_fingerprint;
  await h.command('work.request_material', { case_id: caseId, expected_revision: h.service.work.detail(caseId).revision });
  const result = await processWork(h.service, { async decide() { return validMaterial(h, caseId); } });
  assert.equal(result.disposition, 'material_proposed');
  assert.equal(h.service.work.detail(caseId).material.status, 'proposed');
  assert.equal(h.service.work.detail(caseId).material.producer, 'model');
  assert.equal(h.service.work.detail(caseId).request.status, 'completed');
  assert.equal(h.service.continuity.detail(h.service.work.detail(caseId).thread_id).basis_fingerprint, basis);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM action_grants').n, 0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM drafts').n, 0);
});

test('turning Workspace off while inference is pending discards material and keeps spend accounting', async t => {
  const h = workspaceHarness(t), caseId = await h.ready(); modelReady(h, t);
  await h.command('work.request_material', { case_id: caseId, expected_revision: h.service.work.detail(caseId).revision });
  const gate = deferred(); let calls = 0;
  const pending = processWork(h.service, { async decide() { calls++; return gate.promise; } });
  await spin(() => calls === 1);
  // Keep modelEnabled true so this isolates the Workspace kill switch.
  h.config.workspace.enabled = false;
  gate.resolve(validMaterial(h, caseId));
  const result = await pending;
  assert.notEqual(result.disposition, 'material_proposed');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM work_materials').n, 0);
  assert.equal(h.store.get("SELECT estimated_cost_usd FROM runs WHERE runtime='hermes-workspace-v1'").estimated_cost_usd, 0.01);
  assert.equal(h.store.get('SELECT input_tokens FROM runs WHERE runtime=\'hermes-workspace-v1\'').input_tokens, 10);
});

test('closing a case during inference preserves the stale request and records model usage', async t => {
  const h = workspaceHarness(t), caseId = await h.ready(); modelReady(h, t);
  const { request_id: requestId } = await h.command('work.request_material', { case_id: caseId, expected_revision: h.service.work.detail(caseId).revision });
  const gate = deferred(); let calls = 0;
  const pending = processWork(h.service, { async decide() { calls++; return gate.promise; } });
  await spin(() => calls === 1);
  const detail = h.service.work.detail(caseId);
  await h.command('work.close', { case_id: caseId, expected_revision: detail.revision, reason: 'Owner closed the workcase' });
  gate.resolve(validMaterial(h, caseId));
  const result = await pending;
  assert.notEqual(result.disposition, 'material_proposed');
  assert.equal(h.store.get('SELECT status FROM work_cases WHERE id=?', caseId).status, 'closed');
  assert.equal(h.store.get('SELECT status FROM work_material_requests WHERE id=?', requestId).status, 'stale');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM work_materials').n, 0);
  assert.equal(h.store.get("SELECT estimated_cost_usd FROM runs WHERE runtime='hermes-workspace-v1'").estimated_cost_usd, 0.01);
  assert.equal(h.store.get("SELECT output_tokens FROM runs WHERE runtime='hermes-workspace-v1'").output_tokens, 5);
});

for (const change of ['edit', 'delete', 'source revoke', 'evidence age']) {
  test(`real ${change} invalidates a granted material export before local publication`, async t => {
    const h = workspaceHarness(t), caseId = await h.ready();
    const { material_id: materialId } = await h.material(caseId); await h.approve(caseId, materialId);
    const detail = h.service.work.detail(caseId);
    const { action_id: actionId } = await h.command('work.prepare_action', { case_id: caseId, expected_revision: detail.revision,
      material_id: materialId, capability_id: 'material.export_local.v1' });
    const action = h.service.actions.detail(actionId);
    await h.command('action.grant', { action_id: actionId, expected_revision: action.revision,
      proposal_hash: action.proposal_hash, expires_at: new Date(Date.now() + 3600000).toISOString() });

    if (change === 'edit') await h.ingest({ version: 2, text: 'The source was corrected.' });
    else if (change === 'delete') await h.ingest({ version: 2, operation: 'delete', text: null });
    else if (change === 'source revoke') h.config.opportunity.allowedSourceRefs = [];
    else {
      const evidenceId = detail.evidence_event_ids[0];
      h.store.run("UPDATE events SET created_at='2000-01-01T00:00:00.000Z' WHERE id=? AND kind='source.message'", Number(evidenceId));
    }

    await h.scheduler.sourceTick();
    await h.scheduler.actionTick();
    assert.equal(h.service.work.detail(caseId).status, 'stale');
    assert.equal(h.service.actions.get(actionId).status, 'stale');
    assert.equal(h.store.get("SELECT status FROM action_grants WHERE action_id=? ORDER BY version DESC LIMIT 1", actionId).status, 'stale');
    assert.equal(fs.existsSync(path.join(h.directory, 'action-artifacts', `${actionId}.json`)), false);
  });
}
