// Black-box source authority renewal acceptance; synthetic events only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { audienceHarness, SOURCE, SOURCE_B, proposalFrom } from './audience-test-helpers.mjs';
import { currentExchange } from '../business/audience-current-events.mjs';

async function acceptedNeed(h, sourceId = SOURCE) {
  const goal = await h.open({ source_ids: [sourceId] });
  const original = await h.ingest({ message_id: 'before-withdrawal', source_id: sourceId,
    text: 'How can I get started with the programme?' });
  h.service.audience.reconcile({ limit: 10 });
  const captured = await h.capture(goal.goal_id);
  const assessment = h.service.audience.assessment(captured.assessment_id);
  const proposal = await h.command('audience.propose', { assessment_id: assessment.id,
    output: proposalFrom(assessment.packet) });
  let need = h.service.audience.need(proposal.need_ids[0]);
  await h.command('audience.review', { need_id: need.id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint, decision: 'accept', note: 'Synthetic acceptance fixture.' });
  need = h.service.audience.need(need.id);
  return { goal, original, assessment, need };
}

function withdrawAndReallow(h, goalId) {
  h.config.opportunity.allowedSourceRefs = [SOURCE_B];
  h.service.audience.reconcile({ limit: 10 });
  assert.equal(h.service.audience.watches(goalId).find(watch => watch.source_ref === SOURCE).status, 'revoked');
  h.config.opportunity.allowedSourceRefs = [SOURCE, SOURCE_B];
}

async function renewalPreview(h, goalId, sourceRef = SOURCE) {
  const preview = await h.service.audience.sourceRenewalPreview({ goal_id: goalId, source_ref: sourceRef });
  assert.ok(Object.isFrozen(preview), 'preview is an immutable snapshot');
  for (const field of ['version', 'purpose', 'goal_id', 'source_ref', 'preview_sha256', 'expected_revision',
    'prior_policy_hash', 'current_source_policy_hash', 'old_cursor', 'head', 'gap', 'observation_floor',
    'source_checkpoint_sha256', 'transport_current', 'transport_reason'])
    assert.ok(field in preview, `preview includes ${field}`);
  assert.equal(preview.version, 1);
  assert.equal(preview.purpose, 'audience_source_renewal_preview_v1');
  assert.equal(preview.goal_id, goalId);
  assert.equal(preview.source_ref, SOURCE);
  assert.match(preview.preview_sha256, /^[a-f0-9]{64}$/);
  assert.equal(preview.gap, true);
  assert.equal(preview.observation_floor, preview.head);
  assert.ok(preview.head >= preview.old_cursor);
  assert.equal(typeof preview.transport_current, 'boolean', 'preview reports source transport status');
  return preview;
}

test('same-goal source renewal creates a new authority epoch and admits only post-floor evidence', async t => {
  const h = audienceHarness(t), { goal, original, assessment, need } = await acceptedNeed(h);
  await h.ingest({ message_id: 'pending-before-withdrawal', text: 'A second question is being assessed.' });
  h.service.audience.reconcile({ limit: 10 });
  const pendingReceipt = await h.capture(goal.goal_id);
  const pending = h.service.audience.assessment(pendingReceipt.assessment_id);
  h.store.run("UPDATE audience_assessments SET status='running' WHERE id=?", pending.id);
  withdrawAndReallow(h, goal.goal_id);
  await h.ingest({ message_id: 'during-withdrawal', reply_to_id: 'before-withdrawal',
    text: 'This event arrived while source authority was withdrawn.' });
  const preview = await renewalPreview(h, goal.goal_id);
  assert.ok(preview.head > preview.old_cursor, 'withdrawn interval creates an explicit observation gap');

  const grantCount = h.store.get('SELECT COUNT(*) n FROM scout_grants').n;
  const attentionGrantCount = h.store.get('SELECT COUNT(*) n FROM audience_attention_grants').n;
  const receipt = await h.command('audience.renew_source', { goal_id: goal.goal_id, source_ref: SOURCE,
    expected_revision: preview.expected_revision, preview_sha256: preview.preview_sha256, acknowledge_gap: true });
  const watch = h.service.audience.watches(goal.goal_id).find(row => row.source_ref === SOURCE);
  assert.equal(watch.status, 'active');
  assert.notEqual(watch.policy_hash, preview.prior_policy_hash, 'renewal creates a distinct watch authority epoch');
  assert.ok(Number(watch.cursor) >= Number(preview.observation_floor), 'the resumed watch cannot consume the withdrawn interval');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_grants').n, grantCount,
    'source renewal does not create a Scout grant');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_attention_grants').n, attentionGrantCount,
    'source renewal does not create model authority');
  assert.ok(receipt);

  assert.equal(h.service.audience.need(need.id).status, 'stale', 'historical accepted need stays stale');
  await assert.rejects(h.command('audience.review', { need_id: need.id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint, decision: 'accept', note: 'Must not revive old evidence.' }));
  await assert.rejects(h.command('audience.propose', { assessment_id: assessment.id,
    output: proposalFrom(assessment.packet) }), error => ['AUDIENCE_ASSESSMENT_UNAVAILABLE', 'AUDIENCE_STALE_BASIS'].includes(error.code),
  'a cached pre-withdrawal assessment is terminal and cannot be applied after renewal');
  assert.equal(h.service.audience.assessment(assessment.id).status, 'stale', 'retirement is durable for the cached assessment');
  assert.equal(h.service.audience.assessment(pending.id).current, false, 'a late in-flight model result loses current source authority');
  assert.equal(h.service.audience.assessment(pending.id).reviewable, false);
  assert.throws(() => h.service.audience.propose({ assessment_id: pending.id, output: proposalFrom(pending.packet) }, 'model'),
    { code: 'AUDIENCE_STALE_BASIS' }, 'a late model completion cannot write against a renewed source epoch');
  h.store.run("UPDATE audience_assessments SET status='interrupted' WHERE id=?", pending.id);

  const fresh = await h.ingest({ message_id: 'after-renewal', text: 'What is the next step after getting started?' });
  const freshReply = await h.ingest({ message_id: 'after-renewal-reply', reply_to_id: 'before-withdrawal',
    text: 'I completed the first step and need the next instruction.' });
  h.service.audience.reconcile({ limit: 10 });
  const detail = h.service.audience.detail(goal.goal_id);
  const evidenceIds = detail.exchanges.flatMap(exchange => exchange.evidence.map(e => e.source_event_id));
  assert.ok(evidenceIds.includes(String(fresh.source_event_id)),
    'a new independent event is admitted after renewal');
  assert.ok(!evidenceIds.includes(original.source_event_id), 'old evidence is not reselected');
  assert.ok(!detail.exchanges.some(exchange => exchange.evidence.some(e => e.text.includes('withdrawn'))),
    'events inside the acknowledged gap are not admitted');
  const anchored = detail.exchanges.find(exchange => exchange.anchor_id === 'before-withdrawal');
  assert.ok(anchored, 'a fresh reply may use an old message as structural ancestry');
  assert.deepEqual(anchored.evidence.map(evidence => evidence.source_event_id), [String(freshReply.source_event_id)],
    'only the new reply is selected as evidence for the old structural exchange');
  assert.ok(anchored.evidence.every(evidence => Number(evidence.source_event_id) > Number(preview.observation_floor)),
    'v2 evidence citations stay above the renewed watch observation floor');
  const oldAnchorRow = h.store.get('SELECT * FROM audience_exchanges WHERE goal_id=? AND source_ref=? AND anchor_id=?',
    goal.goal_id, SOURCE, 'before-withdrawal');
  const oldAnchorProjection = currentExchange(h.service.audience, h.service.audience.goal(goal.goal_id), oldAnchorRow,
    [String(original.source_event_id)]);
  assert.equal(oldAnchorProjection.current, false, 'directly selecting the pre-renewal source event is refused');
  assert.ok(oldAnchorProjection.reasons.includes('AUDIENCE_EVIDENCE_BEFORE_RENEWAL'),
    'the refusal is specifically enforced by the source observation floor');

  const nextCapture = await h.capture(goal.goal_id);
  const nextAssessment = h.service.audience.assessment(nextCapture.assessment_id);
  assert.equal(nextAssessment.packet.proposal_contract_version, 2, 'positive control uses the current v2 proposal contract');
  const newProposal = proposalFrom(nextAssessment.packet);
  const newNeedReceipt = await h.command('audience.propose', { assessment_id: nextAssessment.id, output: newProposal });
  const newNeed = h.service.audience.need(newNeedReceipt.need_ids[0]);
  assert.ok(newNeed.evidence_event_ids.every(id => Number(id) > Number(preview.observation_floor)),
    'new need citations cannot select pre-renewal anchor evidence');
  assert.ok(!newNeed.evidence_event_ids.includes(original.source_event_id), 'old evidence remains structural context only');
});

test('renewal preview is bound to current head, goal revision, source, and policy', async t => {
  const h = audienceHarness(t), { goal } = await acceptedNeed(h);
  withdrawAndReallow(h, goal.goal_id);
  const preview = await renewalPreview(h, goal.goal_id);

  await h.ingest({ message_id: 'head-race', text: 'The source head advanced after preview.' });
  await assert.rejects(h.command('audience.renew_source', { goal_id: goal.goal_id, source_ref: SOURCE,
    expected_revision: preview.expected_revision, preview_sha256: preview.preview_sha256, acknowledge_gap: true }),
  'a changed source head invalidates the frozen gap snapshot');
  assert.equal(h.service.audience.watches(goal.goal_id).find(watch => watch.source_ref === SOURCE).status, 'revoked');

  await assert.rejects(Promise.resolve().then(() => h.service.audience.sourceRenewalPreview({
    goal_id: goal.goal_id, source_ref: SOURCE_B,
  })), 'a source outside this goal cannot be renewed through its preview');
  await assert.rejects(h.command('audience.renew_source', { goal_id: goal.goal_id, source_ref: SOURCE_B,
    expected_revision: preview.expected_revision, preview_sha256: preview.preview_sha256, acknowledge_gap: true }));
});

test('renewal refuses a preview after its goal revision or source policy changes', async t => {
  const h = audienceHarness(t), { goal } = await acceptedNeed(h);
  withdrawAndReallow(h, goal.goal_id);
  const preview = await renewalPreview(h, goal.goal_id);
  const payload = { goal_id: goal.goal_id, source_ref: SOURCE, expected_revision: preview.expected_revision,
    preview_sha256: preview.preview_sha256, acknowledge_gap: true };
  h.store.run('UPDATE audience_goals SET revision=revision+1 WHERE id=?', goal.goal_id);
  await assert.rejects(h.command('audience.renew_source', payload), 'a changed goal revision invalidates the preview');
  assert.equal(h.service.audience.watches(goal.goal_id).find(watch => watch.source_ref === SOURCE).status, 'revoked');

  const second = audienceHarness(t), { goal: otherGoal } = await acceptedNeed(second);
  withdrawAndReallow(second, otherGoal.goal_id);
  const otherPreview = await renewalPreview(second, otherGoal.goal_id);
  const originalPolicyHash = second.service.audience.policyHash.bind(second.service.audience);
  second.service.audience.policyHash = sourceRef => sourceRef === SOURCE
    ? 'changed-source-policy-after-preview' : originalPolicyHash(sourceRef);
  await assert.rejects(second.command('audience.renew_source', { goal_id: otherGoal.goal_id, source_ref: SOURCE,
    expected_revision: otherPreview.expected_revision, preview_sha256: otherPreview.preview_sha256, acknowledge_gap: true }),
  'a changed source policy invalidates the preview');
  assert.equal(second.service.audience.watches(otherGoal.goal_id).find(watch => watch.source_ref === SOURCE).status, 'revoked');
});

test('source renewal is operator-only and exact-authority replay survives restart', async t => {
  const h = audienceHarness(t), { goal } = await acceptedNeed(h);
  withdrawAndReallow(h, goal.goal_id);
  const preview = await renewalPreview(h, goal.goal_id);
  const payload = { goal_id: goal.goal_id, source_ref: SOURCE, expected_revision: preview.expected_revision,
    preview_sha256: preview.preview_sha256, acknowledge_gap: true };
  const requestId = '9b5bb9f3-5538-4df0-8f62-71c2b53b8e20';
  await assert.rejects(h.command('audience.renew_source', payload, requestId, { kind: 'agent' }));
  const renewed = await h.command('audience.renew_source', payload, requestId);
  h.restart();
  const replay = await h.command('audience.renew_source', payload, requestId);
  assert.deepEqual(replay, renewed, 'duplicate request returns its original durable receipt');
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='audience.source_renewed' AND json_extract(payload_json,'$.goal_id')=?", goal.goal_id).n,
    1, 'exact replay creates one renewal transition');
  await assert.rejects(h.command('audience.renew_source', { ...payload, acknowledge_gap: false }, requestId),
    'a request receipt cannot authorize changed renewal input');
});

test('tampered replay receipt is rejected while current, and authentic receipt cannot replay after revocation', async t => {
  const h = audienceHarness(t), { goal } = await acceptedNeed(h);
  withdrawAndReallow(h, goal.goal_id);
  const preview = await renewalPreview(h, goal.goal_id);
  const payload = { goal_id: goal.goal_id, source_ref: SOURCE, expected_revision: preview.expected_revision,
    preview_sha256: preview.preview_sha256, acknowledge_gap: true };
  const requestId = '62016cc9-aebb-49cc-bd2b-5f5918a1151b';
  const original = await h.command('audience.renew_source', payload, requestId);
  const forged = { ...original, executable: true, contact_permission: true, allowed_effects: ['send_message'] };
  h.store.run('UPDATE command_receipts SET result_json=? WHERE id=?', JSON.stringify(forged), requestId);
  await assert.rejects(h.command('audience.renew_source', payload, requestId), error =>
    ['AUDIENCE_RENEWAL_UNAVAILABLE', 'AUDIENCE_WATCH_EPOCH_INVALID'].includes(error.code),
  'the full persisted result is checked even while the watch remains current');
  h.store.run('UPDATE command_receipts SET result_json=? WHERE id=?', JSON.stringify(original), requestId);
  h.config.opportunity.allowedSourceRefs = [SOURCE_B];
  h.service.audience.reconcile({ limit: 10 });

  await assert.rejects(h.command('audience.renew_source', payload, requestId), error =>
    ['AUDIENCE_RENEWAL_UNAVAILABLE', 'AUDIENCE_WATCH_EPOCH_INVALID'].includes(error.code),
  'an authentic receipt cannot renew after its watch is revoked');
  assert.equal(h.service.audience.watches(goal.goal_id).find(watch => watch.source_ref === SOURCE).status, 'revoked');
});

test('a failed renewal audit write rolls back the watch transition', async t => {
  const h = audienceHarness(t), { goal } = await acceptedNeed(h);
  withdrawAndReallow(h, goal.goal_id);
  const preview = await renewalPreview(h, goal.goal_id);
  const payload = { goal_id: goal.goal_id, source_ref: SOURCE, expected_revision: preview.expected_revision,
    preview_sha256: preview.preview_sha256, acknowledge_gap: true };
  const originalEvent = h.store.event.bind(h.store);
  h.store.event = (partnerId, conversationId, kind, actor, value) => {
    if (kind.startsWith('audience.source_renew')) throw new Error('injected renewal receipt write failure');
    return originalEvent(partnerId, conversationId, kind, actor, value);
  };
  try {
    await assert.rejects(h.command('audience.renew_source', payload, '7751c530-55cb-48fe-90c5-c132016b6b75'),
      /injected renewal receipt write failure/);
  } finally {
    h.store.event = originalEvent;
  }
  const watch = h.service.audience.watches(goal.goal_id).find(row => row.source_ref === SOURCE);
  assert.equal(watch.status, 'revoked', 'failed receipt leaves prior authority terminal');
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='audience.source_renewed' AND json_extract(payload_json,'$.goal_id')=?", goal.goal_id).n,
    0, 'failed renewal leaves no partial durable transition');
});

test('a declined SQLite watch update cannot create a false success receipt or partial epoch', async t => {
  const h = audienceHarness(t), { goal } = await acceptedNeed(h);
  withdrawAndReallow(h,goal.goal_id);
  const preview = await renewalPreview(h,goal.goal_id);
  h.store.db.exec("CREATE TEMP TRIGGER decline_renewal BEFORE UPDATE ON audience_watches WHEN NEW.status='active' BEGIN SELECT RAISE(IGNORE); END;");
  await assert.rejects(h.command('audience.renew_source',{goal_id:goal.goal_id,source_ref:SOURCE,
    expected_revision:preview.expected_revision,preview_sha256:preview.preview_sha256,acknowledge_gap:true}),
    {code:'AUDIENCE_RENEWAL_COMMIT_FAILED'});
  assert.equal(h.service.audience.watches(goal.goal_id).find(w=>w.source_ref===SOURCE).status,'revoked');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_watch_epochs').n,0);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='audience.source_renewed'").n,0);
});

test('a corrupted epoch quarantines only its source and a healthy watched neighbor keeps advancing', async t => {
  const h = audienceHarness(t), goal = await h.open({ source_ids: [SOURCE, SOURCE_B] });
  await h.ingest({ message_id: 'epoch-source-a', source_id: SOURCE, text: 'Source A original question.' });
  await h.ingest({ message_id: 'epoch-source-b', source_id: SOURCE_B, text: 'Source B original question.' });
  h.service.audience.reconcile({ limit: 10 });
  h.config.opportunity.allowedSourceRefs = [SOURCE_B];
  h.service.audience.reconcile({ limit: 10 });
  h.config.opportunity.allowedSourceRefs = [SOURCE, SOURCE_B];
  for (let generation = 1; generation <= 3; generation++) {
    const preview = await renewalPreview(h, goal.goal_id);
    await h.command('audience.renew_source', { goal_id: goal.goal_id, source_ref: SOURCE,
      expected_revision: preview.expected_revision, preview_sha256: preview.preview_sha256, acknowledge_gap: true });
    if (generation < 3) {
      h.config.opportunity.allowedSourceRefs = [SOURCE_B];
      h.service.audience.reconcile({ limit: 10 });
      h.config.opportunity.allowedSourceRefs = [SOURCE, SOURCE_B];
    }
  }
  assert.equal(h.store.get('SELECT MAX(generation) generation FROM audience_watch_epochs WHERE goal_id=? AND source_ref=?',
    goal.goal_id, SOURCE).generation, 3);
  h.store.run("UPDATE audience_watch_epochs SET transition_sha256=? WHERE goal_id=? AND source_ref=? AND generation=1",
    'f'.repeat(64), goal.goal_id, SOURCE);

  h.service.audience.reconcile({ limit: 10 });
  const detail = h.service.audience.detail(goal.goal_id);
  const aWatch = detail.watches.find(watch => watch.source_ref === SOURCE);
  const bWatch = detail.watches.find(watch => watch.source_ref === SOURCE_B);
  assert.equal(aWatch.status, 'revoked');
  assert.equal(aWatch.reason, 'AUDIENCE_WATCH_EPOCH_INVALID');
  assert.equal(bWatch.status, 'active');
  assert.equal(bWatch.health.current, true, 'epoch corruption does not revoke an independent source');

  await h.ingest({ message_id: 'epoch-source-b-new', source_id: SOURCE_B, text: 'Source B continues with another question.' });
  h.service.audience.reconcile({ limit: 10 });
  assert.ok(h.service.audience.detail(goal.goal_id).exchanges.some(exchange => exchange.source_ref === SOURCE_B
    && exchange.evidence.some(evidence => evidence.text.includes('continues'))),
  'the unaffected neighboring source still admits its fresh event');
});
