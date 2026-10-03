// Recovery regression for valid Scout work that must wait for its owning account.
// All jobs are created through owner commands; only crash-state status is fixture SQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT, message, noHistory, scoutHarness } from './scout-test-helpers.mjs';
import { effectiveSourceConfig } from '../business/scout-policy.mjs';

const OTHER_ACCOUNT = '991234567891';

async function candidateWithSample(h, { channelId, username, title }) {
  const campaign = await h.campaign(title);
  await h.authorize(campaign, `Synthetic monitor review for ${channelId}`);
  h.runtime.rpcFactory = () => ({ accountId: ACCOUNT, connected: () => true,
    search: async () => ({ candidates: [] }),
    resolve: async () => ({ channel_id: channelId, username, title, kind: 'channel', joined: true, access_hash: 'synthetic-access-hash' }),
    discussions: async () => null,
    history: async input => input.before_id ? noHistory(input) : { empty: false, requested_count: input.limit, received_count: 1,
      oldest_id: 1, messages: [message('1')] } });
  await h.command('scout.seed', { campaign_id: campaign.id, revision: campaign.revision, reference: `@${username}` });
  await h.runtime.tick();
  const candidate = h.store.get('SELECT * FROM scout_candidates WHERE campaign_id=? ORDER BY created_at LIMIT 1', campaign.id);
  const sample = await h.auditAndSeal(campaign, candidate);
  return { campaign, candidate, sample };
}

function monitorArgs(campaign, candidate, sample) {
  return { campaign_id: campaign.id, revision: campaign.revision, candidate_id: candidate.id, sample_id: sample.id,
    assessment_id: null, expires_at: new Date(Date.now() + 86400000).toISOString(),
    purpose: 'Synthetic durable source review', max_lag_seconds: 300 };
}

test('bounded reconciliation rotates past foreign-account work without reviving assessments or revoked jobs', async t => {
  const h = scoutHarness(t, { modelEnabled: true, history: input => input.before_id ? noHistory(input) : {
    empty: false, requested_count: input.limit, received_count: 1, oldest_id: 1, messages: [message('1')],
  } });

  const assessmentCampaign = await h.campaign('Interrupted assessment recovery');
  await h.authorize(assessmentCampaign);
  const candidate = await h.seed(assessmentCampaign, '@assessment_channel');
  const sample = await h.auditAndSeal(assessmentCampaign, candidate);
  const assessment = await h.command('scout.request_assessment', { campaign_id: assessmentCampaign.id,
    revision: assessmentCampaign.revision, candidate_id: candidate.id, sample_id: sample.id });
  h.store.run("UPDATE scout_jobs SET status='interrupted',reason='PROCESS_RESTART',owner_id=NULL WHERE id=?", assessment.job_id);

  const revokedCampaign = await h.campaign('Revoked audit recovery');
  const revokedGrant = await h.authorize(revokedCampaign);
  const revokedJob = (await h.command('scout.search', { campaign_id: revokedCampaign.id,
    revision: revokedCampaign.revision })).jobs[0];
  await h.command('scout.revoke', { campaign_id: revokedCampaign.id, revision: revokedCampaign.revision,
    grant_id: revokedGrant });
  assert.equal(h.store.get('SELECT status FROM scout_jobs WHERE id=?', revokedJob.job_id).status, 'stale',
    'explicitly revoked audit authority stales its dependent job');

  const readCampaign = await h.campaign('Interrupted read recovery');
  await h.authorize(readCampaign);
  const readJob = (await h.command('scout.search', { campaign_id: readCampaign.id, revision: readCampaign.revision })).jobs[0];
  h.store.run("UPDATE scout_jobs SET status='interrupted',reason='PROCESS_RESTART',owner_id=NULL WHERE id=?", readJob.job_id);

  // The kill case is about bounded cursor progress, not random UUID ordering.
  // No call or reconciliation cursor owns this newly queued job yet; give the
  // legitimate owner-created row a deterministic high UUID for this fixture.
  const orderedReadJobId = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_calls WHERE job_id=?', readJob.job_id).n, 0,
    'the unexecuted fixture job has no call receipt that refers to its id');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM channel_offsets WHERE cursor=?', readJob.job_id).n, 0,
    'the unexecuted fixture job is not yet a persisted reconciliation cursor');
  assert.equal(h.store.get('SELECT id FROM scout_jobs WHERE id=?', orderedReadJobId), undefined,
    'the deterministic fixture id is unused');
  h.store.run('UPDATE scout_jobs SET id=? WHERE id=?', orderedReadJobId, readJob.job_id);
  readJob.job_id = orderedReadJobId;

  h.service.setTelegramAccount(OTHER_ACCOUNT);
  const foreignCampaign = await h.campaign('Foreign account queued work');
  await h.authorize(foreignCampaign, 'Synthetic other-account queue fixture');
  let foreignCount = 0;
  const targetIsBeyondFirstPage = () => {
    const rows = h.store.all("SELECT id FROM scout_jobs WHERE status IN ('queued','interrupted') ORDER BY id");
    return rows.findIndex(row => row.id === readJob.job_id) >= 30;
  };
  while (foreignCount < 250 && (!targetIsBeyondFirstPage() || foreignCount < 40)) {
    const suffix = String(foreignCount).padStart(3, '0');
    await h.command('scout.seed', { campaign_id: foreignCampaign.id, revision: foreignCampaign.revision,
      reference: `@foreign_channel_${suffix}` });
    foreignCount++;
  }
  assert.ok(foreignCount > 30);
  assert.equal(targetIsBeyondFirstPage(), true,
    'the interrupted current-account read sits beyond the bounded first page of pending foreign jobs');
  const foreignIds = h.store.all("SELECT j.id FROM scout_jobs j JOIN scout_grants g ON g.id=j.grant_id WHERE g.account_id=? AND j.status='queued' ORDER BY j.id",
    OTHER_ACCOUNT).map(row => row.id);
  assert.ok(foreignIds.length > 30);

  h.service.setTelegramAccount(null);
  for (let pass = 0; pass < 3; pass++) h.service.scout.reconcile();
  assert.equal(h.store.get('SELECT status FROM scout_jobs WHERE id=?', readJob.job_id).status, 'interrupted',
    'unknown account preserves valid interrupted reads');
  assert.equal(h.store.get('SELECT status FROM scout_jobs WHERE id=?', assessment.job_id).status, 'interrupted',
    'unknown account preserves interrupted assessment state without queuing it');
  assert.deepEqual(h.store.all("SELECT id FROM scout_jobs WHERE status='queued' AND id IN (SELECT id FROM scout_jobs WHERE grant_id IN (SELECT id FROM scout_grants WHERE account_id=?)) ORDER BY id",
    OTHER_ACCOUNT).map(row => row.id), foreignIds, 'unknown account does not retire valid foreign-account work');

  h.service.setTelegramAccount(ACCOUNT);
  const maxPasses = Math.ceil((foreignIds.length + 10) / 30) + 3;
  let readStatus = 'interrupted';
  for (let pass = 0; pass < maxPasses && readStatus === 'interrupted'; pass++) {
    h.service.scout.reconcile();
    readStatus = h.store.get('SELECT status FROM scout_jobs WHERE id=?', readJob.job_id).status;
  }
  assert.equal(readStatus, 'queued', 'rotating bounded passes eventually reach and requeue the current-account read');
  assert.equal(h.store.get('SELECT status FROM scout_jobs WHERE id=?', assessment.job_id).status, 'interrupted',
    'an interrupted assessment still requires a fresh explicit owner request');
  assert.equal(h.store.get('SELECT status FROM scout_jobs WHERE id=?', revokedJob.job_id).status, 'stale',
    'reconciliation cannot revive work whose audit grant was explicitly revoked');
  assert.equal(h.store.get("SELECT COUNT(*) n FROM scout_jobs WHERE status='queued' AND grant_id IN (SELECT id FROM scout_grants WHERE account_id=?)", OTHER_ACCOUNT).n,
    foreignIds.length, 'foreign-account jobs remain queued while the current account is reconciled');
});

test('a campaign config hash mismatch withholds only that monitor authority and invalid cursors fail closed', async t => {
  const h = scoutHarness(t, { history: input => input.before_id ? noHistory(input) : {
    empty: false, requested_count: input.limit, received_count: 1, oldest_id: 1, messages: [message('1')],
  } });
  const corrupted = await candidateWithSample(h, { channelId: '345678901', username: 'corrupt_channel', title: 'Corrupted campaign authority' });
  const healthy = await candidateWithSample(h, { channelId: '456789012', username: 'healthy_channel', title: 'Healthy neighbor authority' });
  const corruptedGrant = await h.command('scout.admit', monitorArgs(corrupted.campaign, corrupted.candidate, corrupted.sample));
  const healthyGrant = await h.command('scout.admit', monitorArgs(healthy.campaign, healthy.candidate, healthy.sample));
  assert.equal(h.store.get('SELECT status FROM scout_grants WHERE id=?', corruptedGrant.grant_id).status, 'active');
  assert.equal(h.store.get('SELECT status FROM scout_grants WHERE id=?', healthyGrant.grant_id).status, 'active');
  assert.deepEqual(h.service.scout.monitorAuthorityPolicies().map(policy => policy.sourceId).sort(),
    ['telegram:channel:345678901', 'telegram:channel:456789012']);

  h.store.run('UPDATE scout_campaigns SET config_json=? WHERE id=?', JSON.stringify({ topic: 'tampered durable campaign record' }), corrupted.campaign.id);
  const policies = h.service.scout.monitorAuthorityPolicies();
  assert.deepEqual(policies.map(policy => policy.sourceId), ['telegram:channel:456789012'],
    'campaign config that no longer matches its pinned topic hash cannot project monitor authority');
  const effective = effectiveSourceConfig(h.service).opportunity.telegramSources.map(policy => policy.sourceId);
  assert.equal(effective.includes('telegram:channel:345678901'), false);
  assert.equal(effective.includes('telegram:channel:456789012'), true,
    'one damaged campaign does not suppress the healthy neighboring source');
  assert.equal(h.service.scout.monitorPolicies().some(policy => policy.sourceId === 'telegram:channel:456789012'), true);

  h.store.run(`INSERT INTO channel_offsets(channel,account_id,cursor) VALUES('scout-job-reconcile-v1',?,?)
    ON CONFLICT(channel,account_id) DO UPDATE SET cursor=excluded.cursor`, h.config.partnerId, 'not-a-valid-job-id');
  assert.throws(() => h.service.scout.reconcile(), error => error.code === 'SCOUT_RECONCILE_CURSOR_INVALID',
    'a malformed persisted reconciliation cursor fails closed');
});
