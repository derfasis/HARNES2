// Black-box regression for durable Scout authority across an owner server restart.
// All Telegram calls use constructed GramJS SDK fixtures; no socket, credentials, or model.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { id } from '../business/store.mjs';
import { start } from '../business/server.mjs';
import { digest, sourceAccessReadiness, sourceCheckpoint } from '../business/source-ingestion.mjs';
import { effectiveSourceConfig } from '../business/scout-policy.mjs';
import { pollTelegramSource } from '../business/sources/telegram-readonly.mjs';
import { reconcileTelegramReaders } from '../business/sources/telegram-source-registry.mjs';
import { Api } from '../business/sources/telegram-gramjs-semantic.mjs';
import { telegramRead } from '../business/telegram-read-gate.mjs';
import { ACCOUNT, channel, message, noHistory, scoutHarness } from './scout-test-helpers.mjs';

const require = createRequire(import.meta.url);
const bigInt = require('big-integer');
const CHANNEL_ID = '123456789';
const SOURCE = `telegram:channel:${CHANNEL_ID}`;
const OTHER_ACCOUNT = '991234567891';
const NEIGHBOR_CHANNEL_ID = '234567890';
const NEIGHBOR_SOURCE = `telegram:channel:${NEIGHBOR_CHANNEL_ID}`;

function monitorArgs(campaign, candidate, sample, expiresAt = new Date(Date.now() + 86400000).toISOString()) {
  return { campaign_id: campaign.id, revision: campaign.revision, candidate_id: candidate.id, sample_id: sample.id,
    assessment_id: null, expires_at: expiresAt,
    purpose: 'Synthetic explicit restart test', max_lag_seconds: 300 };
}

function nativeOwner(service, { channelId = CHANNEL_ID, username = 'sample_channel', fullPts = 20, withMessage = true } = {}) {
  const channelValue = bigInt(channelId);
  const messageAt=Math.floor(Date.now()/1000);
  const handlers = new Set();
  const client = { connected: true, invoke: async request => {
    if (request instanceof Api.contacts.ResolveUsername)
      return new Api.contacts.ResolvedPeer({ peer: new Api.PeerChannel({ channelId: channelValue }),
        chats: [new Api.Channel({ id: channelValue, accessHash: bigInt('998877665544'), title: 'Restart fixture',
          username, date: 1767225600, megagroup: true, left: false })], users: [] });
    if (request instanceof Api.channels.GetFullChannel)
      return { fullChat: new Api.ChannelFull({ id: channelValue, pts: fullPts }),
        chats: [new Api.Channel({ id: channelValue, accessHash: bigInt('998877665544'), title: 'Restart fixture',
          username, date: 1767225600, megagroup: true, left: false })], users: [] };
    if (request instanceof Api.updates.GetChannelDifference)
      return withMessage ? new Api.updates.ChannelDifference({ pts: fullPts + 1, final: true,
        newMessages: [new Api.Message({ id: fullPts + 1, peerId: new Api.PeerChannel({ channelId: channelValue }),
          fromId: new Api.PeerUser({ userId: bigInt(41) }), message: 'Synthetic current source evidence',
          date: messageAt, media: new Api.MessageMediaEmpty() })],
        otherUpdates: [], chats: [], users: [] })
        : new Api.updates.ChannelDifferenceEmpty({ pts: fullPts, final: true });
    throw new Error(`Unexpected fake SDK request: ${request.className}`);
  }, addEventHandler(handler) { handlers.add(handler); }, removeEventHandler(handler) { handlers.delete(handler); } };
  return { service, client, accountId: ACCOUNT, connected: true,
    stopped: false, clientGeneration: 1, sourceReaders: [], handlers,
    emit: update => Promise.all([...handlers].map(handler => handler(update))), onSourcesReady() {} };
}

async function candidateWithSample(h, { accountId, channelId, username, title }) {
  const campaign = await h.campaign(title);
  await h.authorize(campaign, `Synthetic review for ${accountId}`);
  h.runtime.rpcFactory = () => ({ accountId, connected: () => true,
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

async function prepareCurrentGoal(t, { closeForRestart = true, monitorExpiresAt = null } = {}) {
  const h = scoutHarness(t, { history: input => input.before_id ? noHistory(input) : {
    empty: false, requested_count: input.limit, received_count: 1, oldest_id: 1,
    messages: [message('1')],
  } });
  h.config.continuity.enabled = true;
  const campaign = await h.campaign('Owner restart continuity topic');
  await h.authorize(campaign);
  const candidate = await h.seed(campaign);
  const sample = await h.auditAndSeal(campaign, candidate);
  const { grant_id: grantId } = await h.command('scout.admit', monitorArgs(campaign, candidate, sample,
    monitorExpiresAt ?? new Date(Date.now() + 86400000).toISOString()));
  const owner = nativeOwner(h.service);
  await reconcileTelegramReaders(owner);
  assert.equal(owner.sourceReaders.length, 1);
  await pollTelegramSource(h.service, SOURCE, owner.sourceReaders[0].transport);
  assert.equal(sourceCheckpoint(h.service, SOURCE).phase, 'current');
  const evidence = h.store.all(`SELECT CAST(id AS TEXT) event_id FROM events WHERE partner_id=? AND kind='source.message'
    AND actor='system' AND json_extract(payload_json,'$.source_id')=? ORDER BY id`, h.config.partnerId, SOURCE);
  assert.ok(evidence.length);
  const goal = await h.command('continuity.open', { title: 'Restart fixture goal', objective: 'Preserve bounded current evidence',
    success_condition: 'Keep only current, authorized evidence', source_ids: [SOURCE],
    initial_evidence_event_ids: [evidence.at(-1).event_id], max_age_seconds: 3600 });
  await h.command('scout.search', { campaign_id: campaign.id, revision: campaign.revision });
  await h.command('scout.seed', { campaign_id: campaign.id, revision: campaign.revision, reference: '@sample_channel' });
  const queuedJobs = h.store.all("SELECT id,status FROM scout_jobs WHERE campaign_id=? AND status IN ('queued','interrupted') ORDER BY id", campaign.id);
  // Model the process stopping after it owns one durable queued job. Store.recover
  // must turn that real running state into interrupted before getMe is known.
  const recoveringJob = queuedJobs[0];
  h.store.run("UPDATE scout_jobs SET status='running',owner_id=? WHERE id=?", h.service.control.ownerId, recoveringJob.id);
  const restartJobs = queuedJobs.map(job => ({ id: job.id, status: job.id === recoveringJob.id ? 'interrupted' : job.status }));
  const directory = h.store.directory;
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()),
    'restart server must use a direct child of the operating system temporary directory');
  assert.ok(path.basename(directory).startsWith('harnes2-scout-'), 'restart server must use an isolated scout fixture directory');
  if (closeForRestart) {
    for (const entry of owner.sourceReaders) await entry.transport.close();
    h.service.control.close(); h.service.control.releaseProcess(); h.store.close();
  }
  return { h, directory, grantId, threadId: goal.thread_id, owner, queuedJobs, restartJobs };
}

test('server restart before account identity keeps durable monitor watch and waits for the matching native account', async t => {
  const { h, directory, grantId, threadId, queuedJobs, restartJobs } = await prepareCurrentGoal(t);
  let app, owner;
  const config = structuredClone(h.config);
  config.server.port = 0;
  config.scheduler.enabled = false;
  config.telegram.enabled = false;
  config.telegram.liveSending = false;
  try {
    app = await start({ config, directory });

    const grant = app.store.get('SELECT status,account_id FROM scout_grants WHERE id=?', grantId);
    const watch = app.store.get('SELECT status,reason FROM partner_watches WHERE thread_id=? AND source_ref=?', threadId, SOURCE);
    assert.equal(grant.status, 'active');
    assert.equal(grant.account_id, ACCOUNT);
    assert.equal(watch.status, 'active', 'a temporary unknown account is not revocation evidence');
    app.service.scout.reconcile();
    assert.equal(queuedJobs.some(job => job.status === 'queued'), true);
    assert.equal(restartJobs.some(job => job.status === 'interrupted'), true);
    for (const job of restartJobs) {
      assert.equal(app.store.get('SELECT status FROM scout_jobs WHERE id=?', job.id)?.status, job.status,
        'unknown native identity defers queued Scout work without retiring its authority');
    }
    assert.equal(app.service.telegramAccountId, null);
    assert.equal(effectiveSourceConfig(app.service).opportunity.telegramSources.some(policy => policy.sourceId === SOURCE), true,
      'the exact unexpired durable grant must remain projected while account identity is unavailable');
    assert.equal(sourceAccessReadiness(app.service, SOURCE).current, false,
      'a persisted checkpoint alone does not establish a current connected native account after restart');

    app.service.setTelegramAccount(ACCOUNT);
    app.service.continuity.reconcile();
    assert.equal(app.service.continuity.watches(threadId).find(row => row.source_ref === SOURCE).status, 'active');
    assert.equal(sourceCheckpoint(app.service, SOURCE).phase, 'catching_up',
      'persisted freshness must be withheld until native PTS is revalidated');
    owner = nativeOwner(app.service, { fullPts: 21, withMessage: false });
    await reconcileTelegramReaders(owner);
    await pollTelegramSource(app.service, SOURCE, owner.sourceReaders[0].transport);
    assert.equal(sourceAccessReadiness(app.service, SOURCE).current, true,
      'only a native read through the matching account restores currentness');
    assert.equal(sourceCheckpoint(app.service, SOURCE).phase, 'current');
    assert.equal(app.store.get("SELECT COUNT(*) n FROM events WHERE kind='source.message' AND json_extract(payload_json,'$.source_id')=?", SOURCE).n, 1);
    assert.equal(app.store.get('SELECT COUNT(*) n FROM persons').n, 0);
    assert.equal(app.store.get('SELECT COUNT(*) n FROM conversations').n, 0);
    assert.equal(app.store.get('SELECT COUNT(*) n FROM drafts').n, 0);
    assert.equal(app.store.get('SELECT COUNT(*) n FROM delivery_attempts').n, 0);
  } finally {
    for (const entry of owner?.sourceReaders ?? []) await entry.transport.close().catch(() => {});
    if (app) await app.close();
  }
});

test('temporary identity, lease and live-health failures withhold readiness but preserve authority', async t => {
  const { h, threadId, owner } = await prepareCurrentGoal(t, { closeForRestart: false });
  const sourceId = SOURCE;
  const health = h.service.sourceTransportHealth.get(sourceId);
  try {
    assert.equal(sourceAccessReadiness(h.service, sourceId).current, true, 'fixture starts with proven live native currentness');

    const pendingBeforeWrongAccount = h.store.all("SELECT id,status FROM scout_jobs WHERE status IN ('queued','interrupted') ORDER BY id");
    h.service.setTelegramAccount('991234567891');
    assert.equal(sourceAccessReadiness(h.service, sourceId).current, false, 'wrong native identity cannot reuse the checkpoint');
    h.service.scout.reconcile();
    assert.deepEqual(h.store.all("SELECT id,status FROM scout_jobs WHERE status IN ('queued','interrupted') ORDER BY id"), pendingBeforeWrongAccount,
      'wrong account defers otherwise valid Scout work');
    assert.equal(h.service.continuity.watches(threadId).find(row => row.source_ref === sourceId).status, 'active');
    h.service.setTelegramAccount(ACCOUNT);
    assert.equal(sourceAccessReadiness(h.service, sourceId).current, false,
      'restoring matching identity still requires native revalidation');
    await pollTelegramSource(h.service,sourceId,owner.sourceReaders[0].transport);
    assert.equal(sourceAccessReadiness(h.service, sourceId).current, true,
      'a fresh native difference proves currentness for the restored identity');

    h.service.control.stopped = true;
    h.service.control.processOwned = false;
    assert.equal(sourceAccessReadiness(h.service, sourceId).current, false, 'lost control-plane lease removes readiness');
    assert.equal(h.service.continuity.watches(threadId).find(row => row.source_ref === sourceId).status, 'active');
    h.service.control.stopped = false;
    h.service.control.processOwned = true;
    assert.equal(sourceAccessReadiness(h.service, sourceId).current, false,
      'restoring ownership cannot resurrect the previous native confirmation');
    await pollTelegramSource(h.service,sourceId,owner.sourceReaders[0].transport);
    assert.equal(sourceAccessReadiness(h.service, sourceId).current, true,
      'a new native difference restores readiness after ownership was unavailable');

    h.service.sourceTransportHealth.set(sourceId, () => false);
    assert.equal(sourceAccessReadiness(h.service, sourceId).current, false, 'the transport health latch withholds readiness');
    assert.equal(h.service.continuity.watches(threadId).find(row => row.source_ref === sourceId).status, 'active',
      'a temporary read-health failure is not a grant revocation');
    h.service.sourceTransportHealth.set(sourceId, health);
    assert.equal(sourceAccessReadiness(h.service, sourceId).current, true, 'clearing the transient health failure restores readiness');

    h.service.sourceTransportHealth.delete(sourceId);
    assert.equal(sourceAccessReadiness(h.service, sourceId).current, false,
      'a recent checkpoint without a registered live reader is not proof of currentness');
    h.service.sourceTransportHealth.set(sourceId, health);
    assert.equal(sourceAccessReadiness(h.service, sourceId).current, true,
      'only restoring the same still-live reader supplies the missing native proof');

    h.service.telegramReadFault = true;
    assert.equal(sourceAccessReadiness(h.service, sourceId).current, false, 'an unproven account read gate withholds readiness');
    h.service.telegramReadFault = false;
    assert.equal(sourceAccessReadiness(h.service, sourceId).current, true, 'clearing the read-gate latch restores readiness');

    const stale = sourceCheckpoint(h.service, sourceId);
    h.store.run('UPDATE channel_offsets SET cursor=? WHERE channel=? AND account_id=?',
      JSON.stringify({ ...stale, confirmed_at: new Date(Date.now() - 3601_000).toISOString() }),
      'telegram-source-v0', h.store.get('SELECT account_id FROM channel_offsets WHERE channel=?', 'telegram-source-v0').account_id);
    assert.equal(sourceAccessReadiness(h.service, sourceId).current, false, 'an over-age checkpoint cannot establish currentness');
    assert.equal(h.service.continuity.watches(threadId).find(row => row.source_ref === sourceId).status, 'active');

    await pollTelegramSource(h.service, sourceId, owner.sourceReaders[0].transport);
    assert.equal(sourceAccessReadiness(h.service, sourceId).current, true, 'a new native read replaces the stale confirmation');

    const floodWait = Object.assign(new Error('FLOOD_WAIT_30'), { code: 'SCOUT_FLOOD_WAIT', seconds: 30 });
    await assert.rejects(telegramRead(h.service, { accountId: ACCOUNT, sourceId, priority: 'monitor' }, async () => { throw floodWait; }),
      error => error === floodWait);
    assert.equal(sourceAccessReadiness(h.service, sourceId).current, false, 'account backoff withholds monitoring readiness');
    assert.equal(h.service.continuity.watches(threadId).find(row => row.source_ref === sourceId).status, 'active',
      'temporary account backoff keeps the durable watch');

    const beforeGenerationChange = sourceCheckpoint(h.service, sourceId);
    owner.clientGeneration++;
    assert.equal(owner.client.connected, true, 'the replaced native client remains connected in this fixture');
    assert.equal(sourceAccessReadiness(h.service, sourceId).current, false,
      'the prior native client generation cannot certify readiness after its owner advances');
    await owner.emit(new Api.UpdateNewChannelMessage({ pts: beforeGenerationChange.pts + 1, ptsCount: 1,
      message: new Api.Message({ id: beforeGenerationChange.pts + 1,
        peerId: new Api.PeerChannel({ channelId: bigInt(CHANNEL_ID) }),
        fromId: new Api.PeerUser({ userId: bigInt(41) }), message: 'Late event from the retired generation',
        date: Math.floor(Date.now() / 1000), media: new Api.MessageMediaEmpty() }) }));
    await assert.rejects(pollTelegramSource(h.service, sourceId, owner.sourceReaders[0].transport),
      error => error.code === 'TELEGRAM_READER_RETIRED');
    assert.deepEqual(sourceCheckpoint(h.service, sourceId), beforeGenerationChange,
      'a retired generation cannot advance its persisted checkpoint');
    assert.equal(h.service.continuity.watches(threadId).find(row => row.source_ref === sourceId).status, 'active');
  } finally {
    for (const entry of owner.sourceReaders) await entry.transport.close().catch(() => {});
  }
});

test('monitor expiry, owner revocation and campaign revision remove durable authority', async t => {
  const expiry = new Date(Date.now() + 1800).toISOString();
  const { h: expired, threadId: expiredThread, grantId: expiredGrant, owner: expiredOwner } =
    await prepareCurrentGoal(t, { closeForRestart: false, monitorExpiresAt: expiry });
  try {
    assert.equal(sourceAccessReadiness(expired.service, SOURCE).current, true);
    const waitMs = Date.parse(expiry) - Date.now() + 20;
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
    expired.service.scout.reconcile();
    expired.service.continuity.reconcile();
    assert.equal(expired.service.store.get('SELECT status FROM scout_grants WHERE id=?', expiredGrant).status, 'expired');
    assert.equal(sourceAccessReadiness(expired.service, SOURCE).current, false, 'expired monitor authority cannot remain current');
    assert.equal(expired.service.continuity.watches(expiredThread).find(row => row.source_ref === SOURCE).status, 'revoked');
  } finally {
    for (const entry of expiredOwner.sourceReaders) await entry.transport.close().catch(() => {});
  }

  const { h: revoked, threadId: revokedThread, grantId: revokedGrant, owner: revokedOwner } =
    await prepareCurrentGoal(t, { closeForRestart: false });
  try {
    assert.equal(sourceAccessReadiness(revoked.service, SOURCE).current, true);
    const campaign = revoked.service.scout.campaign(revoked.service.store.get('SELECT campaign_id FROM scout_grants WHERE id=?', revokedGrant).campaign_id);
    await revoked.command('scout.revoke', { campaign_id: campaign.id, revision: campaign.revision, grant_id: revokedGrant });
    revoked.service.continuity.reconcile();
    assert.equal(sourceAccessReadiness(revoked.service, SOURCE).current, false, 'owner revocation removes source authority');
    assert.equal(revoked.service.continuity.watches(revokedThread).find(row => row.source_ref === SOURCE).status, 'revoked');
  } finally {
    for (const entry of revokedOwner.sourceReaders) await entry.transport.close().catch(() => {});
  }

  const { h: revised, threadId: revisedThread, grantId: revisedGrant, owner: revisedOwner } =
    await prepareCurrentGoal(t, { closeForRestart: false });
  try {
    assert.equal(sourceAccessReadiness(revised.service, SOURCE).current, true);
    const campaign = revised.service.scout.campaign(revised.service.store.get('SELECT campaign_id FROM scout_grants WHERE id=?', revisedGrant).campaign_id);
    await revised.command('scout.revise', { campaign_id: campaign.id, revision: campaign.revision, topic: 'A revised topic',
      audience: 'Synthetic audience', language: 'en', geography: 'global', queries: ['A revised topic'] });
    revised.service.continuity.reconcile();
    assert.equal(sourceAccessReadiness(revised.service, SOURCE).current, false, 'campaign revision invalidates old monitor authority');
    assert.equal(revised.service.continuity.watches(revisedThread).find(row => row.source_ref === SOURCE).status, 'revoked');
  } finally {
    for (const entry of revisedOwner.sourceReaders) await entry.transport.close().catch(() => {});
  }
});

test('valid same-channel grants for two accounts fail closed while a healthy neighbor remains current', async t => {
  const { h, owner: firstOwner } = await prepareCurrentGoal(t, { closeForRestart: false });
  let neighborOwner;
  try {
    assert.equal(sourceAccessReadiness(h.service, SOURCE).current, true);
    // Finish setup work under its owning account before adding the second account;
    // the fixture runtime is deliberately replaced with a single-account RPC below.
    const initialCampaign = h.store.get('SELECT campaign_id FROM scout_grants WHERE kind=\'monitor\' AND status=\'active\'').campaign_id;
    for (let attempt = 0; attempt < 8; attempt++) {
      if (!h.store.get("SELECT 1 FROM scout_jobs WHERE campaign_id=? AND status IN ('queued','interrupted') LIMIT 1", initialCampaign)) break;
      await h.runtime.tick();
    }

    h.service.setTelegramAccount(OTHER_ACCOUNT);
    const conflicting = await candidateWithSample(h, { accountId: OTHER_ACCOUNT, channelId: CHANNEL_ID,
      username: 'second_account_channel', title: 'Conflicting account campaign' });
    const previous = sourceCheckpoint(h.service, SOURCE);
    const conflictingArgs = monitorArgs(conflicting.campaign, conflicting.candidate, conflicting.sample);
    conflictingArgs.catchup_from_pts = previous.pts;
    conflictingArgs.expected_checkpoint_fingerprint = digest(previous);
    conflictingArgs.accept_historical_gap = true;
    await assert.rejects(h.command('scout.admit', conflictingArgs), error => error.code === 'SCOUT_SOURCE_ALREADY_MONITORED');
    assert.deepEqual(sourceCheckpoint(h.service, SOURCE), previous, 'a rejected second admission cannot change the checkpoint');

    // Existing ledgers can contain independently valid grants created before the
    // global one-channel constraint. Insert that immutable legacy row as a fixture
    // so the projection itself is tested against historical cross-account conflict.
    const conflictingGrant = id();
    h.store.run(`INSERT INTO scout_grants(id,campaign_id,campaign_revision,kind,account_id,candidate_id,sample_id,
      assessment_id,purpose,max_lag_seconds,catchup_from_pts,checkpoint_fingerprint,accept_historical_gap,expires_at,status,created_at)
      VALUES(?,?,?,'monitor',?,?,?,?,?,?,?,?,?,?,'active',?)`, conflictingGrant, conflicting.campaign.id,
      conflicting.campaign.revision, OTHER_ACCOUNT, conflicting.candidate.id, conflicting.sample.id, null,
      'Legacy second-account monitor permission', 300, previous.pts, digest(previous), 1,
      new Date(Date.now() + 86400000).toISOString(), new Date().toISOString());
    assert.equal(h.store.get('SELECT status FROM scout_grants WHERE id=?', conflictingGrant).status, 'active',
      'the second account has a valid, independently reviewed monitor grant');

    h.service.setTelegramAccount(ACCOUNT);
    const neighbor = await candidateWithSample(h, { accountId: ACCOUNT, channelId: NEIGHBOR_CHANNEL_ID,
      username: 'neighbor_channel', title: 'Healthy neighbor campaign' });
    const { grant_id: neighborGrant } = await h.command('scout.admit', monitorArgs(neighbor.campaign, neighbor.candidate, neighbor.sample));
    assert.equal(h.store.get('SELECT status FROM scout_grants WHERE id=?', neighborGrant).status, 'active');

    const policies = h.service.scout.monitorAuthorityPolicies();
    assert.deepEqual(policies.map(policy => policy.sourceId), [NEIGHBOR_SOURCE],
      'same-channel authority is ambiguous across accounts and is excluded without hiding the healthy neighbor');
    assert.equal(effectiveSourceConfig(h.service).opportunity.telegramSources.some(policy => policy.sourceId === SOURCE), false);

    neighborOwner = nativeOwner(h.service, { channelId: NEIGHBOR_CHANNEL_ID, username: 'neighbor_channel' });
    await reconcileTelegramReaders(neighborOwner);
    assert.equal(neighborOwner.sourceReaders.length, 1);
    await pollTelegramSource(h.service, NEIGHBOR_SOURCE, neighborOwner.sourceReaders[0].transport);
    assert.equal(sourceAccessReadiness(h.service, NEIGHBOR_SOURCE).current, true,
      'the unambiguous neighbor can still establish currentness through its native account');
    assert.equal(sourceAccessReadiness(h.service, SOURCE).current, false,
      'neither account can use the globally ambiguous channel checkpoint');
  } finally {
    for (const entry of firstOwner.sourceReaders) await entry.transport.close().catch(() => {});
    for (const entry of neighborOwner?.sourceReaders ?? []) await entry.transport.close().catch(() => {});
  }
});
