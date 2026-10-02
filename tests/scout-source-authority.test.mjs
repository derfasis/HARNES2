import test from 'node:test';
import assert from 'node:assert/strict';
import { id } from '../business/store.mjs';
import { digest, sourceCheckpoint } from '../business/source-ingestion.mjs';
import { bootstrapTelegramSource } from '../business/sources/telegram-readonly.mjs';
import { ACCOUNT, message, noHistory, scoutHarness } from './scout-test-helpers.mjs';

const args = (campaign, candidate, sample, lag = 300, extra = {}) => ({
  campaign_id: campaign.id, revision: campaign.revision, candidate_id: candidate.id,
  sample_id: sample.id, assessment_id: null, purpose: 'Explicit source authority test',
  expires_at: new Date(Date.now() + 86400000).toISOString(), max_lag_seconds: lag, ...extra,
});
async function twoTopics(t) {
  const h = scoutHarness(t, { history: async input => input.before_id ? noHistory(input)
    : { empty: false, requested_count: input.limit, received_count: 1, oldest_id: 1, messages: [message()] } });
  const a = await h.campaign('Topic A'); await h.authorize(a);
  const candidateA = await h.seed(a), sample = await h.auditAndSeal(a, candidateA);
  const b = await h.campaign('Topic B'); await h.authorize(b);
  const candidateB = await h.seed(b);
  assert.equal(candidateB.sample_id, sample.id, 'a topic can reuse history without acquiring monitor authority');
  return { h, a, b, candidateA, candidateB, sample };
}

async function healthyNeighbor(t) {
  const h = scoutHarness(t, {
    resolve: async input => input.username === 'healthy_channel'
      ? { channel_id: '223456789', username: 'healthy_channel', title: 'Synthetic Neighbor',
          kind: 'group', joined: true, access_hash: '887766554433' }
      : { channel_id: '123456789', username: 'sample_channel', title: 'Synthetic Sample Channel',
          kind: 'group', joined: true, access_hash: '998877665544' },
    history: async input => input.before_id ? noHistory(input)
      : { empty: false, requested_count: input.limit, received_count: 1, oldest_id: 1, messages: [message()] },
  });
  const a = await h.campaign('Topic A'); await h.authorize(a);
  const candidateA = await h.seed(a), sampleA = await h.auditAndSeal(a, candidateA);
  const b = await h.campaign('Topic B'); await h.authorize(b);
  const candidateB = await h.seed(b);
  const c = await h.campaign('Healthy neighbor topic'); await h.authorize(c);
  const candidateC = await h.seed(c, '@healthy_channel'), sampleC = await h.auditAndSeal(c, candidateC);
  return { h, a, b, c, candidateA, candidateB, candidateC, sampleA, sampleC };
}

test('a second topic cannot silently shadow a current monitor grant for the same account and channel', async t => {
  const { h, a, b, candidateA, candidateB, sample } = await twoTopics(t);
  const admitted = await h.command('scout.admit', args(a, candidateA, sample));
  const grantsBefore = h.store.get('SELECT COUNT(*) n FROM scout_grants').n;
  const readsBefore = h.store.get('SELECT COUNT(*) n FROM scout_calls').n;
  await assert.rejects(h.command('scout.admit', args(b, candidateB, sample, 60)),
    { code: 'SCOUT_SOURCE_ALREADY_MONITORED' });
  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_grants').n, grantsBefore);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_calls').n, readsBefore);
  assert.equal(sourceCheckpoint(h.service, sample.source_ref), null);
  const policy = h.service.scout.monitorPolicies()[0];
  assert.equal(policy.maxLagSeconds, 300);
  assert.match(policy.processingBasis, new RegExp(admitted.grant_id));
  assert.equal(h.service.scout.presentation(h.service.scout.campaign(a.id)).candidates[0].monitor_grant.current, true);
  assert.equal(h.service.scout.presentation(h.service.scout.campaign(b.id)).candidates[0].monitor_grant, null);
});

test('moving monitoring to another topic requires revoke and exact historical acknowledgement', async t => {
  const { h, a, b, candidateA, candidateB, sample } = await twoTopics(t);
  const first = await h.command('scout.admit', args(a, candidateA, sample));
  const policy = h.service.scout.monitorPolicies()[0];
  await bootstrapTelegramSource(h.service, policy.sourceId, { pts: 100, history: [] });
  await h.command('scout.revoke', { campaign_id: a.id, revision: a.revision, grant_id: first.grant_id });
  const checkpoint = sourceCheckpoint(h.service, sample.source_ref);
  await assert.rejects(h.command('scout.admit', args(b, candidateB, sample, 60)),
    { code: 'SCOUT_CATCHUP_AUTHORITY_REQUIRED' });
  const next = await h.command('scout.admit', args(b, candidateB, sample, 60, {
    catchup_from_pts: checkpoint.pts, expected_checkpoint_fingerprint: digest(checkpoint), accept_historical_gap: true,
  }));
  const effective = h.service.scout.monitorPolicies();
  assert.equal(effective.length, 1); assert.equal(effective[0].maxLagSeconds, 60);
  assert.match(effective[0].processingBasis, new RegExp(next.grant_id));
  const rebound = sourceCheckpoint(h.service, sample.source_ref);
  assert.equal(rebound.pts, 100); assert.equal(rebound.phase, 'catching_up'); assert.equal(rebound.confirmed_at, null);
  assert.equal(h.service.scout.presentation(h.service.scout.campaign(a.id)).candidates[0].monitor_grant.current, false);
  assert.equal(h.service.scout.presentation(h.service.scout.campaign(b.id)).candidates[0].monitor_grant.current, true);
});

test('legacy conflicting source grants fail closed after restart instead of first-grant-wins', async t => {
  const { h, a, b, candidateA, candidateB, sample } = await twoTopics(t);
  await h.command('scout.admit', args(a, candidateA, sample));
  h.store.run(`INSERT INTO scout_grants(id,campaign_id,campaign_revision,kind,account_id,candidate_id,sample_id,
    purpose,max_lag_seconds,expires_at,status,created_at) VALUES(?,?,?,'monitor',?,?,?,?,?,?,'active',?)`,
    id(), b.id, b.revision, ACCOUNT, candidateB.id, sample.id, 'Pre-release conflicting source grant', 60,
    new Date(Date.now() + 86400000).toISOString(), new Date().toISOString());
  h.restart();
  assert.deepEqual(h.service.scout.monitorPolicies(), []);
  assert.deepEqual(h.effective().opportunity.telegramSources, []);
  for (const campaign of [a, b]) {
    assert.equal(h.service.scout.presentation(h.service.scout.campaign(campaign.id)).candidates[0].monitor_grant.current, false);
  }
  assert.equal(h.store.get("SELECT COUNT(*) n FROM scout_grants WHERE kind='monitor' AND status='active'").n, 2,
    'conflicting authority is withheld without silently rewriting owner decisions');
});

test('legacy cross-campaign and cross-account references cannot poison valid authority or its healthy neighbor', async t => {
  const { h, a, b, c, candidateA, candidateB, candidateC, sampleA, sampleC } = await healthyNeighbor(t);
  const admittedA = await h.command('scout.admit', args(a, candidateA, sampleA));
  const admittedC = await h.command('scout.admit', args(c, candidateC, sampleC, 120));
  h.store.run(`INSERT INTO scout_grants(id,campaign_id,campaign_revision,kind,account_id,candidate_id,sample_id,
    purpose,max_lag_seconds,expires_at,status,created_at) VALUES(?,?,?,'monitor',?,?,?,?,?,?,'active',?)`,
    id(), b.id, b.revision, ACCOUNT, candidateA.id, sampleA.id, 'Legacy cross-campaign candidate reference', 60,
    new Date(Date.now() + 86400000).toISOString(), new Date().toISOString());
  h.store.run('UPDATE scout_candidates SET account_id=? WHERE id=?', '991234567891', candidateB.id);
  h.store.run(`INSERT INTO scout_grants(id,campaign_id,campaign_revision,kind,account_id,candidate_id,sample_id,
    purpose,max_lag_seconds,expires_at,status,created_at) VALUES(?,?,?,'monitor',?,?,?,?,?,?,'active',?)`,
    id(), b.id, b.revision, ACCOUNT, candidateB.id, sampleA.id, 'Legacy cross-account candidate reference', 60,
    new Date(Date.now() + 86400000).toISOString(), new Date().toISOString());

  h.restart();
  const policies = h.service.scout.monitorPolicies();
  assert.deepEqual(policies.map(policy => policy.sourceId).sort(), [sampleA.source_ref, sampleC.source_ref].sort());
  assert.match(policies.find(policy => policy.sourceId === sampleA.source_ref).processingBasis,
    new RegExp(admittedA.grant_id));
  assert.match(policies.find(policy => policy.sourceId === sampleC.source_ref).processingBasis,
    new RegExp(admittedC.grant_id));
  assert.equal(h.service.scout.presentation(h.service.scout.campaign(a.id)).candidates[0].monitor_grant.current, true);
  assert.equal(h.service.scout.presentation(h.service.scout.campaign(b.id)).candidates[0].monitor_grant.current, false);
  assert.equal(h.service.scout.presentation(h.service.scout.campaign(c.id)).candidates[0].monitor_grant.current, true);
});

test('configured static source remains authoritative after reloading an overlapping legacy monitor grant', async t => {
  const { h, a, candidateA, sampleA } = await healthyNeighbor(t);
  await h.command('scout.admit', args(a, candidateA, sampleA));
  const sourceId = sampleA.source_ref;
  const staticPolicy = { sourceId, accountId: ACCOUNT, channelId: candidateA.channel_id,
    sourceKind: 'live_snapshot', processingBasis: 'Explicit static source configuration', maxLagSeconds: 180 };
  h.config.opportunity.telegramSources = [staticPolicy];
  h.config.opportunity.allowedSourceRefs = [sourceId];

  h.restart();
  assert.deepEqual(h.service.scout.monitorPolicies(), []);
  assert.deepEqual(h.effective().opportunity.telegramSources, [staticPolicy]);
  assert.equal(h.service.scout.presentation(h.service.scout.campaign(a.id)).candidates[0].monitor_grant.current, false);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM scout_grants WHERE kind='monitor' AND status='active'").n, 1,
    'reload withholds an overlap without rewriting the persisted owner grant');
});
