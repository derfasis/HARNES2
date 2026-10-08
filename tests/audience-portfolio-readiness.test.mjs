// Partial-portfolio readiness acceptance. All provider calls are local fakes;
// Telegram credentials, RPC, billing, and external effects are not used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { audienceHarness, SOURCE, modelOutputFrom } from './audience-test-helpers.mjs';
import { processAudienceAssessment } from '../business/audience-reasoning.mjs';

const ATTENTION_RUNTIME = 'hermes-audience-v1';
const SOURCES = [SOURCE, ...Array.from({ length: 19 }, (_, i) => `telegram:channel:${9001 + i}`)];

function configure(h) {
  h.config.audience.modelEnabled = true;
  h.config.audience.maxRunsPerDay = 20;
  h.config.audience.maxSources = 20;
  h.config.runtime.enabled = true;
  h.config.runtime.maxRunsPerDay = 50;
  h.config.runtime.baseUrl = 'https://unused-partial-portfolio.invalid/v1';
  h.config.runtime.model = 'offline-partial-portfolio-fake';
  h.config.runtime.dailyBudgetUsd = null;
  h.config.runtime.inputUsdPerMillion = null;
  h.config.runtime.outputUsdPerMillion = null;
  h.config.controlPlane.maxConcurrent = 3;
  h.config.opportunity.allowedSourceRefs = [...SOURCES];
  // These 19 explicit transport sources have no current checkpoint. The normal
  // source-health boundary reports NOT_READY; no health method is monkeypatched.
  h.config.opportunity.telegramSources = SOURCES.slice(1).map((sourceId, i) => ({
    sourceId, accountId: '700000001', channelId: String(9001 + i),
    sourceKind: 'live_snapshot', maxLagSeconds: 120, processingBasis: 'Synthetic own-authored acceptance fixture',
  }));
}

function sentinel(t) {
  const previous = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'offline-partial-portfolio-sentinel-never-sent';
  t.after(() => {
    if (previous === undefined) delete process.env.PARTNER_MODEL_API_KEY;
    else process.env.PARTNER_MODEL_API_KEY = previous;
  });
}

async function seededPortfolio(h, { evidence = true } = {}) {
  const goal = await h.open({ title: 'Twenty-source partial portfolio', source_ids: SOURCES });
  if (evidence) {
    await h.ingest({ source_id: SOURCE, message_id: 'portfolio-question',
      text: 'How do I get started with the service?' });
  }
  h.service.audience.reconcile({ limit: 20, event_limit: 50 });
  return { goal, detail: h.service.audience.detail(goal.goal_id) };
}

function grantPayload(goalId, detail, maxAttempts = 1) {
  return { goal_id: goalId, expected_revision: detail.revision,
    expected_scope_fingerprint: detail.attention.scope_fingerprint,
    max_attempts: maxAttempts, expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    reason: 'Finite offline partial-portfolio readiness acceptance.' };
}

function fakeRuntime() {
  let calls = 0;
  let context = null;
  return { get calls() { return calls; }, get context() { return context; }, runtime: { decide: async (_run, packetContext) => {
    calls++;
    context = packetContext;
    return { completed: true, final_response: JSON.stringify(modelOutputFrom(packetContext.packet)),
      usage: { input_tokens: 17, output_tokens: 9 },
      model_identity: { model_id: 'offline-partial-portfolio-fake', model_version: '1' } };
  } } };
}

test('one current source in a 20-source goal can produce an ordinary inference while 19 transports are withheld', async t => {
  sentinel(t);
  const h = audienceHarness(t); configure(h);
  const { goal, detail } = await seededPortfolio(h);
  assert.equal(detail.watches.length, 20);
  assert.equal(detail.ready, true, 'positive control: one current supported exchange is selectable');
  assert.equal(detail.exchanges.length, 1);
  assert.equal(detail.exchanges[0].source_ref, SOURCE);
  assert.equal(detail.watches.filter(w => !w.health.current).length, 19);
  assert.ok(detail.watches.slice(1).every(w => w.health.reason === 'SOURCE_TRANSPORT_NOT_READY'),
    'the excluded sources use the real source transport readiness boundary');
  const enrolledWatchRefs = detail.watches.map(w => w.source_ref).sort();
  assert.deepEqual(enrolledWatchRefs, [...SOURCES].sort());

  const granted = await h.command('audience.attention_grant', grantPayload(goal.goal_id, detail));
  const preDispatch = h.service.audience.detail(goal.goal_id);
  assert.equal(preDispatch.ready, true);
  assert.equal(preDispatch.exchanges.length, 1);
  assert.equal(preDispatch.attention.source_current, false,
    'whole-portfolio source health remains separately visible');
  const fake = fakeRuntime();
  const result = await processAudienceAssessment(h.service, fake.runtime);
  assert.equal(result.disposition, 'proposal_created', 'the controlled local provider completed the selected evidence packet');
  assert.equal(fake.calls, 1);
  assert.equal(fake.context.packet.exchanges.length, 1);
  assert.equal(fake.context.packet.exchanges[0].source_ref, SOURCE,
    'the actual provider context contains only the healthy selected source');
  assert.equal(h.store.get('SELECT grant_id FROM audience_attention_attempts WHERE assessment_id=?', result.assessment_id).grant_id,
    granted.grant_id, 'the admitted assessment spends the original full-portfolio grant');
  const assessed = h.service.audience.detail(goal.goal_id);
  // Red witness on the pre-fix product: dispatch succeeded on the one valid
  // exchange, while the read-only Attention summary still says the whole goal
  // is not ready because 19 unrelated transports lack current checkpoints.
  assert.equal(preDispatch.attention.ready, true,
    'ordinary readiness must agree with the actual selected next-packet dispatch');
  assert.equal(preDispatch.attention.evidence_ready, true);
  assert.deepEqual(preDispatch.attention.source_summary, {
    enrolled_sources: 20, current_sources: 1, selected_sources: 1, selected_exchanges: 1,
    source_completeness: 'unknown',
  });
  assert.equal(assessed.exchanges.length, 0, 'completion durably marks the supplied exchange considered');
  assert.equal(assessed.attention.ready, false);
  assert.equal(assessed.attention.evidence_ready, false);
  assert.equal(assessed.attention.source_summary.selected_exchanges, 0);

  const grant = assessed.attention.grants[0];
  assert.equal(grant.status, 'exhausted');
  assert.equal(grant.attempts_used, 1);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM runs WHERE runtime=?", ATTENTION_RUNTIME).n, 1);
  h.restart();
  const afterRestart = h.service.audience.detail(goal.goal_id);
  assert.equal(afterRestart.attention.grants.find(g => g.id === grant.id).attempts_used, 1);
  assert.equal(afterRestart.exchanges.length, 0, 'restart does not restore already-considered evidence');
  const again = await processAudienceAssessment(h.service, fake.runtime);
  assert.notEqual(again.disposition, 'proposal_created');
  assert.equal(fake.calls, 1, 'restart cannot purchase a second turn against the exhausted grant');
  assert.equal(h.store.get("SELECT COUNT(*) n FROM runs WHERE runtime=?", ATTENTION_RUNTIME).n, 1);
});

test('current transports without supported unconsidered evidence are not ready for another inference', async t => {
  sentinel(t);
  const h = audienceHarness(t); configure(h);
  // No explicit transport policies means all 20 synthetic fixture sources pass
  // the real default fixture readiness path, with no source observations.
  h.config.opportunity.telegramSources = [];
  const { goal, detail } = await seededPortfolio(h, { evidence: false });
  assert.equal(detail.watches.length, 20);
  assert.equal(detail.watches.filter(w => w.health.current).length, 20,
    'all fixture sources are current even though none has observations');
  assert.equal(detail.exchanges.length, 0);
  await h.command('audience.attention_grant', grantPayload(goal.goal_id, detail));
  const fake = fakeRuntime();
  const beforeRuns = h.store.get("SELECT COUNT(*) n FROM runs WHERE runtime=?", ATTENTION_RUNTIME).n;
  const result = await processAudienceAssessment(h.service, fake.runtime);
  const after = h.service.audience.detail(goal.goal_id);
  assert.equal(after.attention.ready, false);
  assert.equal(after.attention.evidence_ready, false);
  assert.equal(after.attention.source_summary.selected_exchanges, 0);
  assert.notEqual(result.disposition, 'proposal_created');
  assert.equal(fake.calls, 0);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM runs WHERE runtime=?", ATTENTION_RUNTIME).n, beforeRuns);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_assessments WHERE goal_id=?', goal.goal_id).n, 0);
});

test('revoking one watch invalidates the original whole-goal authority despite a healthy selected exchange', async t => {
  sentinel(t);
  const h = audienceHarness(t); configure(h);
  const { goal, detail } = await seededPortfolio(h);
  await h.command('audience.attention_grant', grantPayload(goal.goal_id, detail));
  // Removing a source from the effective owner allowlist is an actual authority
  // withdrawal. Audience observes and durably marks that watch revoked.
  h.config.opportunity.allowedSourceRefs = [SOURCE, ...SOURCES.slice(2)];
  h.service.audience.detail(goal.goal_id); // first observation persists withdrawal
  const revoked = h.service.audience.detail(goal.goal_id);
  assert.ok(revoked.watches.some(w => w.source_ref === SOURCES[1] && w.status === 'revoked'));
  assert.ok(revoked.exchanges.some(e => e.source_ref === SOURCE),
    'the supported evidence is still present; revocation must not be disguised as no evidence');
  const fake = fakeRuntime();
  const result = await processAudienceAssessment(h.service, fake.runtime);
  const after = h.service.audience.detail(goal.goal_id);
  assert.notEqual(result.disposition, 'proposal_created');
  assert.equal(fake.calls, 0);
  assert.notEqual(after.attention.grants[0].status, 'active');
  assert.equal(h.store.get("SELECT COUNT(*) n FROM runs WHERE runtime=?", ATTENTION_RUNTIME).n, 0);
});

test('repeated detail and Attention previews are read-only and capture uses the exact displayed packet', async t => {
  sentinel(t);
  const h = audienceHarness(t); configure(h);
  const { goal, detail } = await seededPortfolio(h);
  await h.command('audience.attention_grant', grantPayload(goal.goal_id, detail, 2));

  const state = () => ({
    exchanges: h.store.all('SELECT id,fingerprint,considered_fingerprint FROM audience_exchanges WHERE goal_id=? ORDER BY id', goal.goal_id),
    packetCursor: h.store.get("SELECT cursor FROM channel_offsets WHERE channel='audience-packet-source-v1' AND account_id=?", goal.goal_id)?.cursor ?? null,
    captures: h.store.get('SELECT COUNT(*) n FROM audience_assessments WHERE goal_id=?', goal.goal_id).n,
    runs: h.store.get('SELECT COUNT(*) n FROM runs WHERE partner_id=?', h.config.partnerId).n,
    attempts: h.store.get('SELECT COUNT(*) n FROM audience_attention_attempts WHERE goal_id=?', goal.goal_id).n,
    events: h.store.get('SELECT COUNT(*) n FROM events WHERE partner_id=?', h.config.partnerId).n,
  });
  const before = state();
  assert.equal(before.packetCursor, null);
  const previews = [];
  for (let i = 0; i < 4; i++) {
    const view = h.service.audience.detail(goal.goal_id);
    const summary = h.service.attention.summary(goal.goal_id);
    assert.equal(view.ready, true);
    assert.equal(summary.ready, true);
    assert.equal(summary.evidence_ready, true);
    assert.deepEqual(view.exchanges.map(e => [e.id, e.fingerprint]), [[view.exchanges[0].id, before.exchanges[0].fingerprint]]);
    previews.push(view.exchanges.map(e => ({ id: e.id, fingerprint: e.fingerprint })));
    assert.deepEqual(state(), before, 'read-only presentation does not move evidence, cursor, capture, run, attempt or event state');
  }
  assert.ok(previews.every(p => JSON.stringify(p) === JSON.stringify(previews[0])));

  const captured = await h.capture(goal.goal_id);
  const assessment = h.service.audience.assessment(captured.assessment_id);
  assert.deepEqual(assessment.packet.exchanges.map(e => ({ id: e.id, fingerprint: e.fingerprint })), previews[0],
    'capture consumes precisely the evidence shown by the latest next-packet preview');
  assert.equal(h.store.get("SELECT cursor FROM channel_offsets WHERE channel='audience-packet-source-v1' AND account_id=?", goal.goal_id).cursor,
    assessment.packet.exchanges.at(-1).source_ref);
  assert.equal(h.store.get('SELECT considered_fingerprint FROM audience_exchanges WHERE id=?', previews[0][0].id).considered_fingerprint,
    previews[0][0].fingerprint);
});

test('held admitted provider exposes pending assessment and only the already-admitted last attempt can finish', async t => {
  sentinel(t);
  const h = audienceHarness(t); configure(h);
  const { goal, detail } = await seededPortfolio(h);
  const granted = await h.command('audience.attention_grant', grantPayload(goal.goal_id, detail, 1));

  let enterProvider;
  let releaseProvider;
  const entered = new Promise(resolve => { enterProvider = resolve; });
  const held = new Promise(resolve => { releaseProvider = resolve; });
  let calls = 0;
  const running = processAudienceAssessment(h.service, { decide: async (_run, context) => {
    calls++;
    enterProvider(context);
    await held;
    return { completed: true, final_response: JSON.stringify(modelOutputFrom(context.packet)),
      usage: { input_tokens: 19, output_tokens: 11 },
      model_identity: { model_id: 'offline-partial-portfolio-fake', model_version: '1' } };
  } });

  const admittedContext = await entered;
  assert.equal(admittedContext.packet.exchanges.length, 1);
  assert.equal(admittedContext.packet.exchanges[0].source_ref, SOURCE);
  const pendingView = h.service.audience.detail(goal.goal_id);
  assert.deepEqual({
    id: pendingView.attention.pending_assessment.id,
    status: pendingView.attention.pending_assessment.status,
    producer: pendingView.attention.pending_assessment.producer,
  }, { id: pendingView.attention.pending_assessment.id, status: 'running', producer: 'model' });
  assert.equal(pendingView.attention.evidence_ready, false,
    'capture already considered the admitted evidence, so it is not a next packet while provider work is pending');
  assert.equal(pendingView.attention.ready, false);
  assert.ok(pendingView.attention.block_reasons.includes('AUDIENCE_ASSESSMENT_PENDING'));
  assert.ok(pendingView.attention.block_reasons.includes('AUDIENCE_ATTENTION_REQUIRED'),
    'the only grant attempt is already reserved by the in-flight run');
  assert.equal(pendingView.attention.grants.find(g => g.id === granted.grant_id).status, 'exhausted');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_attention_attempts WHERE goal_id=?', goal.goal_id).n, 1);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM runs WHERE runtime=?", ATTENTION_RUNTIME).n, 1);

  releaseProvider();
  const completed = await running;
  assert.equal(completed.disposition, 'proposal_created', 'the in-flight admitted call may complete at the cap');
  assert.equal(calls, 1);
  const after = h.service.audience.detail(goal.goal_id);
  assert.equal(after.attention.pending_assessment, null);
  assert.equal(after.attention.evidence_ready, false);
  assert.equal(after.attention.ready, false);
  assert.equal(after.attention.grants.find(g => g.id === granted.grant_id).attempts_used, 1);
  assert.equal(after.attention.grants.find(g => g.id === granted.grant_id).status, 'exhausted');
  assert.equal(h.service.audience.assessment(completed.assessment_id).status, 'proposed');

  const next = await processAudienceAssessment(h.service, { decide: async () => {
    calls++;
    throw new Error('must not call provider again after the last admitted completion');
  } });
  assert.notEqual(next.disposition, 'proposal_created');
  assert.equal(calls, 1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_attention_attempts WHERE goal_id=?', goal.goal_id).n, 1);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM runs WHERE runtime=?", ATTENTION_RUNTIME).n, 1);
});
