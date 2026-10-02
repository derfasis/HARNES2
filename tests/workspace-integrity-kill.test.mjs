import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceHarness, SOURCE } from './helpers/workspace-harness.mjs';
import { id } from '../business/store.mjs';
import { processWork } from '../business/work-reasoning.mjs';

test('corrupt expectation quarantines its work, a healthy neighbour progresses through the bounded durable cursor, restart does not resurrect authority', async t => {
  const h = workspaceHarness(t), bad = await h.ready(); const m1 = (await h.material(bad)).material_id; await h.approve(bad, m1); await h.execute(bad, m1);
  let d = h.service.work.detail(bad);
  await h.command('work.expect', { case_id: bad, expected_revision: d.revision, question: 'Observe further evidence', deadline: new Date(Date.now() + 3600000).toISOString() });
  const { thread_id } = await h.command('continuity.open', { title: 'Neighbour', objective: 'Preserve independently useful work', success_condition: 'A reviewed local material', source_ids: [SOURCE], initial_evidence_event_ids: d.evidence_event_ids, max_age_seconds: 3600 });
  const basis = await h.accept(thread_id);
  const good = (await h.command('work.open', { thread_id, expected_basis_fingerprint: basis.basis_fingerprint, title: 'Healthy neighbour' })).case_id;
  const m2 = (await h.material(good)).material_id; await h.approve(good, m2); await h.execute(good, m2);
  d = h.service.work.detail(good);
  await h.command('work.expect', { case_id: good, expected_revision: d.revision, question: 'Observe further evidence', deadline: new Date(Date.now() + 3600000).toISOString() });
  h.store.run('UPDATE work_expectations SET deadline=opened_at WHERE case_id=?', bad);
  h.store.run('UPDATE work_expectations SET opened_at=?,deadline=? WHERE case_id=?', new Date(Date.now() - 10000).toISOString(), new Date(Date.now() - 5000).toISOString(), good);
  for (let i = 0; i < 4; i++) assert.equal(h.service.work.reconcile(1,1).cases, 1);
  assert.equal(h.store.get('SELECT reason FROM work_cases WHERE id=?', bad).reason, 'WORK_RECORD_INVALID');
  assert.equal(h.service.work.detail(good).expectation.status, 'unknown');
  assert.equal(h.service.work.detail(good).expectation.reason, 'COVERAGE_NOT_ESTABLISHED');
  assert.equal(h.service.work.detail(good).current, true);
  const cursor = h.store.get("SELECT cursor FROM channel_offsets WHERE channel='workspace-reconcile-v1'").cursor; assert.ok(cursor);
  h.restart(); h.service.work.reconcile(1,1);
  assert.equal(h.service.work.detail(bad).current, false);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM action_grants g JOIN action_proposals a ON a.id=g.action_id WHERE a.thread_id=? AND g.status='active'", h.service.work.detail(bad).thread_id).n, 0);
  assert.equal(h.service.work.detail(good).expectation.causal_credit, false);
});

test('corrupt case packet is withheld on operator read and cannot poison neighbouring workspace reads', async t => {
  const h = workspaceHarness(t), caseId = await h.ready();
  h.store.run('UPDATE work_cases SET packet_json=? WHERE id=?', '{', caseId);
  assert.equal(h.service.work.snapshot().cases[0].status, 'quarantined');
  h.service.work.reconcile();
  assert.equal(h.store.get('SELECT status FROM work_cases WHERE id=?', caseId).status, 'stale');
  assert.equal(h.service.work.presentation(caseId).current, false);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM action_grants').n, 0);
  // A different request id cannot repair integrity by replaying a failed mutation.
  await assert.rejects(h.command('work.material', { case_id: caseId, expected_revision: h.service.work.get(caseId).revision, title: 'Bypass', content: 'Unsafe', evidence_event_ids: ['1'] }, id()), { code: 'WORK_STALE_BASIS' });
});

test('valid JSON with missing evidence or fabricated source text cannot become current Work evidence', async t => {
  const h = workspaceHarness(t), caseId = await h.ready(), original = h.service.work.get(caseId).packet_json;
  h.store.run('UPDATE work_cases SET packet_json=? WHERE id=?', '{}', caseId);
  assert.equal(h.service.work.snapshot().cases[0].status, 'quarantined');
  h.service.work.reconcile();
  assert.equal(h.service.work.presentation(caseId).current, false);
  assert.equal(h.service.work.get(caseId).status, 'stale');
  const packet = JSON.parse(original); packet.evidence[0].text = 'Fabricated confirmation that this is a fact.';
  h.store.run("UPDATE work_cases SET status='open',packet_json=? WHERE id=?", JSON.stringify(packet), caseId);
  assert.equal(h.service.work.detail(caseId).current, false);
  await assert.rejects(h.material(caseId), { code: 'WORK_RECORD_INVALID' });
  h.store.run('UPDATE work_cases SET packet_json=? WHERE id=?', original, caseId);
  assert.equal(h.service.work.detail(caseId).current, true, 'unchanged real evidence remains usable');
});

test('a corrupt queued material packet is retired before inference and a healthy neighbour completes', async t => {
  const h = workspaceHarness(t), bad = await h.ready();
  const { thread_id } = await h.command('continuity.open', { title: 'Healthy queued work', objective: 'Preserve useful material work', success_condition: 'Owner receives a proposal', source_ids: [SOURCE], initial_evidence_event_ids: h.service.work.detail(bad).evidence_event_ids, max_age_seconds: 3600 });
  const basis = await h.accept(thread_id);
  const good = (await h.command('work.open', { thread_id, expected_basis_fingerprint: basis.basis_fingerprint, title: 'Healthy case' })).case_id;
  h.config.workspace.modelEnabled = true; h.config.runtime.model = 'offline-fake'; h.config.runtime.baseUrl = 'https://example.invalid';
  const oldKey = process.env.PARTNER_MODEL_API_KEY; process.env.PARTNER_MODEL_API_KEY = 'offline-fake';
  t.after(() => { if (oldKey === undefined) delete process.env.PARTNER_MODEL_API_KEY; else process.env.PARTNER_MODEL_API_KEY = oldKey; });
  const req = await h.command('work.request_material', { case_id: bad, expected_revision: h.service.work.detail(bad).revision });
  h.store.run("UPDATE work_material_requests SET packet_json='{',created_at='2000-01-01T00:00:00Z' WHERE id=?", req.request_id);
  await h.command('work.request_material', { case_id: good, expected_revision: h.service.work.detail(good).revision });
  assert.equal(h.service.work.detail(good).next_move, 'wait_material');
  let calls = 0;
  const pending = processWork(h.service, { async decide() { calls++; return { completed: true,
    final_response: JSON.stringify({ title: 'Healthy result', content: 'Based on the current source statement, which remains unverified.', evidence_event_ids: h.service.work.detail(good).evidence_event_ids }),
    usage: { estimated_cost_usd: 0, cost_status: 'runtime_estimate' } }; } });
  await assert.doesNotReject(pending, 'A corrupt queued packet must not block a healthy neighbouring request');
  const result = await pending;
  assert.equal(calls, 1);
  assert.equal(result.disposition, 'material_proposed'); assert.equal(result.case_id, good);
  assert.equal(h.service.work.detail(bad).request.reason, 'WORK_REQUEST_INVALID');
  assert.equal(h.service.work.detail(bad).material, null);
  assert.equal(h.service.work.detail(good).material.status, 'proposed');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM action_grants').n, 0);
});

test('public evidence observed after the expectation deadline cannot satisfy that expectation', async t => {
  const h = workspaceHarness(t), caseId = await h.ready(), materialId = (await h.material(caseId)).material_id;
  await h.approve(caseId, materialId); await h.execute(caseId, materialId);
  await h.command('work.expect', { case_id: caseId, expected_revision: h.service.work.detail(caseId).revision, question: 'Observe bounded new evidence', deadline: new Date(Date.now()+3600000).toISOString() });
  h.store.run('UPDATE work_expectations SET opened_at=?,deadline=? WHERE case_id=?', new Date(Date.now()-10000).toISOString(), new Date(Date.now()-5000).toISOString(), caseId);
  await h.ingest({ message_id: 'too-late', text: 'A new statement after the observation deadline.' });
  await h.scheduler.sourceTick();
  const expectation = h.service.work.detail(caseId).expectation;
  assert.equal(expectation.status, 'unknown');
  assert.deepEqual(expectation.observations, []);
  assert.equal(expectation.causal_credit, false);
});

test('a bounded reconciliation page cannot expire an expectation before reading its durable pre-deadline backlog', async t => {
  const h = workspaceHarness(t), caseId = await h.ready(), materialId = (await h.material(caseId)).material_id;
  await h.approve(caseId, materialId); await h.execute(caseId, materialId);
  await h.command('work.expect', { case_id: caseId, expected_revision: h.service.work.detail(caseId).revision, question: 'Observe bounded evidence', deadline: new Date(Date.now()+3600000).toISOString() });
  const cursor = h.service.work.detail(caseId).expectation.cursor;
  await h.ingest({ version: 2, operation: 'delete', text: null });
  await h.ingest({ message_id: 'new-evidence', text: 'A different public source statement within the observation window.' });
  const clock = Date.now();
  h.store.run('UPDATE events SET created_at=? WHERE id>? AND kind=?', new Date(clock-5000).toISOString(), cursor, 'source.message');
  h.store.run('UPDATE work_expectations SET opened_at=?,deadline=? WHERE case_id=?', new Date(clock-10000).toISOString(), new Date(clock-1000).toISOString(), caseId);
  h.service.work.reconcile(1,1);
  assert.equal(h.service.work.detail(caseId).expectation.status, 'pending', 'the first bounded page contains a delete, not the later valid statement');
  h.service.work.reconcile(1,1);
  assert.equal(h.service.work.detail(caseId).expectation.status, 'evidence_observed');
  assert.equal(h.service.work.detail(caseId).expectation.observations.length, 1);
  assert.equal(h.service.work.detail(caseId).expectation.causal_credit, false);
});
