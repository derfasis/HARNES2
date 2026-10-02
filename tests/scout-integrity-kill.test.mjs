import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT, channel, message, scoutHarness } from './scout-test-helpers.mjs';
import { digest, sourceCheckpoint } from '../business/source-ingestion.mjs';
import { dueTelegramSources } from '../business/telegram-monitoring.mjs';
import { telegramRead, telegramReadState } from '../business/telegram-read-gate.mjs';
import { scoutSignals } from '../business/scout-signals.mjs';
import { processScoutAssessment } from '../business/scout-reasoning.mjs';
import { bootstrapTelegramSource, disconnectTelegramSource } from '../business/sources/telegram-readonly.mjs';
import { SCOUT_EVALUATOR_VERSION } from '../business/scout.mjs';

const future = () => new Date(Date.now() + 86_400_000).toISOString();
const monitorArgs = (campaign, candidate, sample, extra = {}) => ({
  campaign_id: campaign.id, revision: campaign.revision, candidate_id: candidate.id, sample_id: sample.id,
  assessment_id: null, expires_at: future(), purpose: 'Synthetic integrity test monitor', max_lag_seconds: 300, ...extra,
});
const gateRow = h => h.store.get("SELECT cursor FROM channel_offsets WHERE channel='telegram-account-read-v1' AND account_id=?", `${h.config.partnerId}:${ACCOUNT}`);
const acknowledge = checkpoint => ({ catchup_from_pts: checkpoint.pts,
  expected_checkpoint_fingerprint: digest(checkpoint), accept_historical_gap: true });

test('FLOOD_WAIT is durable account audit state and blocks monitor/search before and after restart', async t => {
  const h = scoutHarness(t); h.config.scout.maxRequestsPerDay = 10; h.config.scout.maxRequestsPerSourceDay = 10;
  const sourceId = 'telegram:channel:123456789'; let calls = 0;
  const wait = Object.assign(new Error('synthetic rate limit'), { code: 'SCOUT_FLOOD_WAIT', retrySeconds: 600 });
  await assert.rejects(telegramRead(h.service, { accountId: ACCOUNT, sourceId, priority: 'audit' }, async () => { calls++; throw wait; }),
    { code: 'SCOUT_FLOOD_WAIT' });
  const persisted = JSON.parse(gateRow(h).cursor);
  assert.ok(Date.parse(persisted.retry_at) > Date.now());
  assert.equal(calls, 1);
  for (const priority of ['monitor', 'search']) {
    await assert.rejects(telegramRead(h.service, { accountId: ACCOUNT, sourceId, priority }, async () => { calls++; }),
      { code: 'SCOUT_ACCOUNT_BACKOFF' });
  }
  h.restart();
  assert.equal(telegramReadState(h.service, ACCOUNT, { sourceId, priority: 'monitor' }).reason, 'SCOUT_ACCOUNT_BACKOFF');
  await assert.rejects(telegramRead(h.service, { accountId: ACCOUNT, sourceId, priority: 'search' }, async () => { calls++; }),
    { code: 'SCOUT_ACCOUNT_BACKOFF' });
  assert.equal(calls, 1, 'no read reaches the adapter during account cooldown');
  assert.equal(JSON.parse(gateRow(h).cursor).retry_at, persisted.retry_at);
});

test('audit reserve, global and per-source caps deny over-budget reads while admitted monitor reads reach the adapter', async t => {
  const h = scoutHarness(t); h.config.scout.maxRequestsPerDay = 10; h.config.scout.maxRequestsPerSourceDay = 10;
  let reads = 0;
  const call = (priority, sourceId) => telegramRead(h.service, { accountId: ACCOUNT, sourceId, priority }, async () => ++reads);
  const a = 'telegram:channel:123456789', b = 'telegram:channel:223456789';
  assert.equal(await call('audit', a), 1); assert.equal(await call('search', null), 2);
  await assert.rejects(call('audit', a), { code: 'SCOUT_READ_BUDGET' }, 'search/audit may spend only the reserved two of ten account reads');
  for (let i = 0; i < 8; i++) assert.equal(await call('monitor', a), i + 3);
  await assert.rejects(call('monitor', b), { code: 'SCOUT_READ_BUDGET' }, 'the shared account cap includes monitor reads');
  assert.equal(reads, 10);

  const perSource = scoutHarness(t); perSource.config.scout.maxRequestsPerDay = 10; perSource.config.scout.maxRequestsPerSourceDay = 2;
  let sourceReads = 0;
  const read = sourceId => telegramRead(perSource.service, { accountId: ACCOUNT, sourceId, priority: 'monitor' }, async () => ++sourceReads);
  await read(a); await read(a);
  await assert.rejects(read(a), { code: 'SCOUT_READ_BUDGET' }, 'a source cannot exceed its own daily quota');
  assert.equal(await read(b), 3, 'another source can still consume available account capacity');
  assert.equal(sourceReads, 3);
});

test('due Telegram monitors select at most two and rotate fairly across restart', t => {
  const h = scoutHarness(t);
  const ids = ['100001', '100002', '100003', '100004'];
  h.config.opportunity.telegramSources = ids.map(channelId => ({ sourceId: `telegram:channel:${channelId}`, accountId: ACCOUNT,
    channelId, sourceKind: 'live_snapshot', processingBasis: 'synthetic cadence test', maxLagSeconds: 300 }));
  h.config.opportunity.allowedSourceRefs = h.config.opportunity.telegramSources.map(p => p.sourceId);
  const readers = h.config.opportunity.telegramSources.map(policy => ({ sourceId: policy.sourceId }));
  const first = dueTelegramSources(h.service, readers).map(r => r.sourceId);
  assert.equal(first.length, 2);
  h.restart();
  const second = dueTelegramSources(h.service, readers).map(r => r.sourceId);
  assert.equal(second.length, 2);
  assert.equal(new Set([...first, ...second]).size, 4, 'the next due pass advances to the two not selected on the first pass');
  assert.deepEqual(dueTelegramSources(h.service, readers), [], 'the durable cadence prevents a third immediate pass');
});

for (const kind of ['source.message', 'source.telegram.tombstone']) {
  test(`a later ${kind} invalidates a sealed sample by durable id even when its timestamp matches`, async t => {
    let reads = 0;
    const h = scoutHarness(t, { history: async input => ++reads === 1
      ? { empty: false, requested_count: input.limit, received_count: 1, oldest_id: 1, messages: [message('1')] }
      : { empty: true, requested_count: input.limit, received_count: 0, oldest_id: null, messages: [] } });
    const campaign = await h.campaign(`Normalized source event ${kind}`); await h.authorize(campaign);
    const candidate = await h.seed(campaign), sample = await h.auditAndSeal(campaign, candidate);
    const sameTimestamp = sample.finished_at;
    const payload = { source_id: sample.source_ref, message_id: 'message:1', operation: kind.endsWith('tombstone') ? 'delete' : 'edit',
      ...(kind.endsWith('tombstone') ? {} : { text: 'Edited synthetic statement.' }) };
    h.store.event(h.config.partnerId, null, kind, 'system', payload);
    const eventId = h.store.get('SELECT MAX(id) id FROM events').id;
    h.store.run('UPDATE events SET created_at=? WHERE id=?', sameTimestamp, eventId);
    assert.ok(eventId > sample.source_cursor);
    assert.throws(() => h.service.scout.sample(sample.id, candidate), { code: 'SCOUT_SAMPLE_STALE' });
    assert.equal(h.store.get('SELECT status FROM scout_samples WHERE id=?', sample.id).status, 'sealed', 'old sample remains immutable history');
  });
}

test('opaque ancestry cannot re-enter semantic evidence transitively', () => {
  const opaque = message('10', { text: null, unsupported: true });
  const directReply = message('11', { reply_to: '10', text: 'Reply attached to an opaque source post.' });
  const nestedReply = message('12', { reply_to: '11', text: 'Reply whose ancestry includes the opaque post.' });
  const independent = message('13', { reply_to: null, text: 'Independent visible statement.' });
  const signals = scoutSignals([opaque, directReply, nestedReply, independent]);
  const refs = signals.groups.flatMap(group => group.evidence_refs);
  assert.ok(!refs.includes('10') && !refs.includes('11') && !refs.includes('12'));
  assert.ok(refs.includes('13'));
  assert.ok(signals.omitted.some(item => item.message_id === '12'), 'transitive descendants of an opaque anchor are explicitly omitted');
});

test('monitor revocation and re-admission preserve checkpoint progress, advance policy epoch, and retain integrity latch', async t => {
  let reads = 0;
  const h = scoutHarness(t, { history: async input => ++reads === 1
    ? { empty: false, requested_count: input.limit, received_count: 1, oldest_id: 1, messages: [message('1')] }
    : { empty: true, requested_count: input.limit, received_count: 0, oldest_id: null, messages: [] } });
  const campaign = await h.campaign('Checkpoint continuity'); await h.authorize(campaign);
  const candidate = await h.seed(campaign), sample = await h.auditAndSeal(campaign, candidate), sourceId = sample.source_ref;
  const admitted = await h.command('scout.admit', monitorArgs(campaign, candidate, sample));
  await bootstrapTelegramSource(h.service, sourceId, { pts: 10, history: [] });
  const baseline = sourceCheckpoint(h.service, sourceId);
  const revoke = async grantId => h.command('scout.revoke', { campaign_id: campaign.id, revision: campaign.revision, grant_id: grantId });
  await revoke(admitted.grant_id);
  const revoked = sourceCheckpoint(h.service, sourceId);
  assert.equal(revoked.pts, baseline.pts); assert.equal(revoked.baseline_hash, baseline.baseline_hash);
  assert.equal(revoked.phase, 'catching_up');
  await assert.rejects(h.command('scout.admit', monitorArgs(campaign, candidate, sample)), { code: 'SCOUT_CATCHUP_AUTHORITY_REQUIRED' });
  await assert.rejects(h.command('scout.admit', monitorArgs(campaign, candidate, sample, { ...acknowledge(revoked), catchup_from_pts: revoked.pts - 1 })),
    { code: 'SCOUT_CHECKPOINT_CHANGED' }, 'a stale checkpoint value cannot authorize re-admission');
  const readmitted = await h.command('scout.admit', monitorArgs(campaign, candidate, sample, acknowledge(revoked)));
  const durableGrant = h.store.get('SELECT * FROM scout_grants WHERE id=?', readmitted.grant_id);
  assert.equal(durableGrant.catchup_from_pts, revoked.pts);
  assert.equal(durableGrant.checkpoint_fingerprint, digest(revoked));
  assert.equal(durableGrant.accept_historical_gap, 1);
  assert.throws(() => h.store.run('UPDATE scout_grants SET catchup_from_pts=? WHERE id=?', revoked.pts + 1, readmitted.grant_id), /SCOUT_GRANT_IMMUTABLE/);
  const resumed = sourceCheckpoint(h.service, sourceId);
  assert.equal(resumed.pts, baseline.pts); assert.equal(resumed.baseline_hash, baseline.baseline_hash);
  assert.equal(resumed.phase, 'catching_up');
  assert.notEqual(resumed.policy_hash, baseline.policy_hash, 'new grant produces a new source authority epoch');

  await disconnectTelegramSource(h.service, sourceId, 'INTEGRITY_RECONCILIATION_REQUIRED');
  const latched = sourceCheckpoint(h.service, sourceId);
  assert.equal(latched.reason, 'INTEGRITY_RECONCILIATION_REQUIRED');
  await revoke(readmitted.grant_id);
  const revokedLatched = sourceCheckpoint(h.service, sourceId);
  assert.equal(revokedLatched.pts, baseline.pts); assert.equal(revokedLatched.baseline_hash, baseline.baseline_hash);
  assert.equal(revokedLatched.reason, 'INTEGRITY_RECONCILIATION_REQUIRED');
  await assert.rejects(h.command('scout.admit', monitorArgs(campaign, candidate, sample)), { code: 'SCOUT_CATCHUP_AUTHORITY_REQUIRED' });
  const reAdmitted = await h.command('scout.admit', monitorArgs(campaign, candidate, sample, acknowledge(revokedLatched)));
  assert.ok(reAdmitted.grant_id);
  const stillLatched = sourceCheckpoint(h.service, sourceId);
  assert.equal(stillLatched.pts, baseline.pts); assert.equal(stillLatched.baseline_hash, baseline.baseline_hash);
  assert.equal(stillLatched.reason, 'INTEGRITY_RECONCILIATION_REQUIRED');
  assert.equal(stillLatched.phase, 'blocked');
  assert.notEqual(stillLatched.policy_hash, latched.policy_hash);
});

test('monitor traffic does not consume the separate audit allocation', async t => {
  const h = scoutHarness(t); h.config.scout.maxRequestsPerDay = 10; h.config.scout.maxRequestsPerSourceDay = 10;
  let calls = 0;
  const read = priority => telegramRead(h.service, { accountId: ACCOUNT, sourceId: 'telegram:channel:123456789', priority }, async () => ++calls);
  for(let i = 0; i < 3; i++) await read('monitor');
  assert.equal(await read('audit'), 4); assert.equal(await read('search'), 5);
  await assert.rejects(read('audit'), { code: 'SCOUT_READ_BUDGET' });
  h.restart();
  const state = telegramReadState(h.service, ACCOUNT);
  assert.equal(state.requests, 5); assert.equal(state.audit_requests, 2);
  for(let i = 0; i < 5; i++) await read('monitor');
  await assert.rejects(read('monitor'), { code: 'SCOUT_READ_BUDGET' });
  assert.equal(calls, 10, 'global ceiling includes both classes while audit use is independently capped');
});

test('re-admission compares the whole acknowledged checkpoint even when PTS does not change', async t => {
  let reads = 0;
  const h = scoutHarness(t, { history: async input => ++reads === 1
    ? { empty: false, requested_count: input.limit, received_count: 1, oldest_id: 1, messages: [message('1')] }
    : { empty: true, requested_count: input.limit, received_count: 0, oldest_id: null, messages: [] } });
  const campaign = await h.campaign('Checkpoint fingerprint CAS'); await h.authorize(campaign);
  const candidate = await h.seed(campaign), sample = await h.auditAndSeal(campaign, candidate);
  const admitted = await h.command('scout.admit', monitorArgs(campaign, candidate, sample));
  await bootstrapTelegramSource(h.service, sample.source_ref, { pts: 10, history: [] });
  await h.command('scout.revoke', { campaign_id: campaign.id, revision: campaign.revision, grant_id: admitted.grant_id });
  const shown = sourceCheckpoint(h.service, sample.source_ref), grantCount = h.store.get('SELECT COUNT(*) n FROM scout_grants').n;
  // Simulate a separate recovery/failure writer changing the checkpoint after
  // presentation. A revoked source itself cannot call an authorized reader API.
  h.store.run('UPDATE channel_offsets SET cursor=? WHERE channel=? AND account_id=?',
    JSON.stringify({ ...shown, phase: 'blocked', confirmed_at: null, reason: 'INTEGRITY_RECONCILIATION_REQUIRED' }),
    'telegram-source-v0', digest([h.config.partnerId, sample.source_ref]));
  const changed = sourceCheckpoint(h.service, sample.source_ref);
  assert.equal(changed.pts, shown.pts); assert.notEqual(digest(changed), digest(shown));
  const readsBefore = reads;
  await assert.rejects(h.command('scout.admit', monitorArgs(campaign, candidate, sample, acknowledge(shown))),
    { code: 'SCOUT_CHECKPOINT_CHANGED' });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_grants').n, grantCount, 'refusal creates no replacement authority');
  assert.deepEqual(sourceCheckpoint(h.service, sample.source_ref), changed, 'refusal cannot rewrite the cursor');
  assert.equal(reads, readsBefore, 're-admission CAS fails before any adapter read');
  const accepted = await h.command('scout.admit', monitorArgs(campaign, candidate, sample, acknowledge(changed)));
  const grant = h.store.get('SELECT * FROM scout_grants WHERE id=?', accepted.grant_id);
  assert.equal(grant.checkpoint_fingerprint, digest(changed)); assert.equal(grant.accept_historical_gap, 1);
  h.restart();
  assert.equal(h.store.get('SELECT checkpoint_fingerprint FROM scout_grants WHERE id=?', accepted.grant_id).checkpoint_fingerprint, digest(changed));
  assert.equal(sourceCheckpoint(h.service, sample.source_ref).reason, 'INTEGRITY_RECONCILIATION_REQUIRED');
});

test('a retired process cannot reconcile or expire source authority', async t => {
  const h = scoutHarness(t), campaign = await h.campaign('Retired reconcile');
  const grantId = await h.authorize(campaign);
  const before = h.store.get('SELECT * FROM scout_grants WHERE id=?', grantId);
  h.service.control.close(); h.service.control.releaseProcess();
  assert.throws(() => h.service.scout.reconcile(), { code: 'SCOUT_DISABLED' });
  assert.deepEqual(h.store.get('SELECT * FROM scout_grants WHERE id=?', grantId), before);
});

test('fake assessment runtime accepts only actual sampled evidence and persists evaluator provenance and usage', async t => {
  const oldKey = process.env.PARTNER_MODEL_API_KEY; process.env.PARTNER_MODEL_API_KEY = 'offline-test-key-not-a-credential';
  t.after(() => { if (oldKey === undefined) delete process.env.PARTNER_MODEL_API_KEY; else process.env.PARTNER_MODEL_API_KEY = oldKey; });
  let reads = 0;
  const h = scoutHarness(t, { modelEnabled: true, history: async input => ++reads === 1
    ? { empty: false, requested_count: input.limit, received_count: 1, oldest_id: 1, messages: [message('1')] }
    : { empty: true, requested_count: input.limit, received_count: 0, oldest_id: null, messages: [] } });
  h.config.runtime.model = 'offline-fake'; h.config.runtime.baseUrl = 'https://example.invalid';
  const campaign = await h.campaign('Assessment evidence binding'); await h.authorize(campaign);
  const candidate = await h.seed(campaign), sample = await h.auditAndSeal(campaign, candidate);
  const sampleMaterial = JSON.parse(sample.messages_json), refs = scoutSignals(sampleMaterial).groups.flatMap(g => g.evidence_refs);
  const expectedDigest = digest({ source_ref: sample.source_ref, account_id: sample.account_id, from: sample.requested_from,
    until: sample.requested_until, source_cursor: sample.source_cursor, messages: sampleMaterial, coverage: sample.coverage });
  assert.equal(sample.digest, expectedDigest, 'sealed sample digest includes its schema-011 source event fence');
  assert.ok(Number.isSafeInteger(sample.source_cursor));

  h.config.scout.modelEnabled = true;
  const request = { campaign_id: campaign.id, revision: campaign.revision, candidate_id: candidate.id, sample_id: sample.id };
  await h.command('scout.request_assessment', request);
  const queued = h.store.get("SELECT cursor_json FROM scout_jobs WHERE campaign_id=? AND kind='assessment'", campaign.id);
  assert.equal(JSON.parse(queued.cursor_json).evaluator_version, SCOUT_EVALUATOR_VERSION);
  let invocation = 0;
  const runtime = { async decide(_run, context) {
    invocation++;
    const actualRefs = context.packet.groups.flatMap(group => group.evidence_refs);
    const evidence_refs = invocation === 1 ? actualRefs : ['999999'];
    return { completed: true, final_response: JSON.stringify({ recommendation: 'consider', reason: 'Offline evidence-bound assessment.',
      evidence_refs, opportunities: [], uncertainty: ['Sample is bounded and not continuous history.'] }),
      usage: { input_tokens: 20, output_tokens: 10, estimated_cost_usd: 0.01, cost_status: 'runtime_estimate' } };
  } };
  const accepted = await processScoutAssessment(h.service, runtime);
  assert.equal(accepted.disposition, 'assessment_proposed');
  const assessment = h.store.get('SELECT * FROM scout_assessments WHERE id=?', accepted.assessment_id);
  assert.equal(assessment.evaluator_version, SCOUT_EVALUATOR_VERSION);
  assert.equal(assessment.sample_digest, sample.digest);
  assert.equal(h.store.get('SELECT estimated_cost_usd FROM runs WHERE id=?', assessment.run_id).estimated_cost_usd, 0.01);

  const secondCampaign = await h.campaign('Fabricated reference rejected'); await h.authorize(secondCampaign);
  const secondCandidate = await h.seed(secondCampaign);
  assert.equal(h.store.get('SELECT sample_id FROM scout_candidates WHERE id=?', secondCandidate.id).sample_id, sample.id);
  await h.command('scout.request_assessment', { campaign_id: secondCampaign.id, revision: secondCampaign.revision,
    candidate_id: secondCandidate.id, sample_id: sample.id });
  const rejected = await processScoutAssessment(h.service, runtime);
  assert.equal(rejected.disposition, 'withheld');
  assert.equal(rejected.reason, 'SCOUT_EVIDENCE_INVALID');
  assert.equal(h.store.get("SELECT COUNT(*) n FROM scout_assessments WHERE campaign_id=?", secondCampaign.id).n, 0);
  assert.ok(refs.every(ref => ref !== '999999'));
});

test('audit grant expiry during a held history RPC withholds and discards the returned page', async t => {
  let enterHistory, releaseHistory;
  const entered = new Promise(resolve => { enterHistory = resolve; });
  const held = new Promise(resolve => { releaseHistory = resolve; });
  const h = scoutHarness(t, { history: async input => {
    enterHistory();
    await held;
    return { empty: false, requested_count: input.limit, received_count: 1, oldest_id: 1, messages: [message('1')] };
  } });
  const campaign = await h.campaign('Expiry while history is in flight'); await h.authorize(campaign);
  const candidate = await h.seed(campaign);
  await h.command('scout.audit', { campaign_id: campaign.id, revision: campaign.revision, candidate_id: candidate.id });
  const job = h.store.get("SELECT * FROM scout_jobs WHERE campaign_id=? AND kind='history' AND status='queued'", campaign.id);
  assert.ok(job);

  const realNow = Date.now;
  const realProcessCurrent = h.service.control.processCurrent.bind(h.service.control);
  let fakeNow = realNow();
  Date.now = () => fakeNow;
  let tick;
  try {
    tick = h.runtime.tick();
    await entered;
    assert.equal(h.store.get('SELECT status FROM scout_jobs WHERE id=?', job.id).status, 'running',
      'the job reached the held RPC before authority expired');
    fakeNow += 2 * 86_400_000;
    // Keep the process lease valid so this case isolates grant expiry rather than
    // simulating a worker handoff at the same time.
    h.service.control.processCurrent = () => true;
    releaseHistory();
    const result = await tick;
    assert.equal(result.disposition, 'withheld');
    assert.equal(result.reason, 'SCOUT_AUTHORITY_STALE');
    assert.equal(h.store.get('SELECT status FROM scout_jobs WHERE id=?', job.id).status, 'stale');
    const sample = h.store.get('SELECT * FROM scout_samples WHERE id=?', job.sample_id);
    assert.equal(sample.status, 'collecting');
    assert.deepEqual(JSON.parse(sample.messages_json), []);
    assert.equal(JSON.parse(h.store.get('SELECT cursor_json FROM scout_jobs WHERE id=?', job.id).cursor_json).before_id, 0,
      'the returned page did not advance the history cursor');
  } finally {
    Date.now = realNow;
    h.service.control.processCurrent = realProcessCurrent;
    releaseHistory();
    if (tick) await tick;
  }
});
