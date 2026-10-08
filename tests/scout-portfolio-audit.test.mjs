import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT, message, scoutHarness } from '../tests/scout-test-helpers.mjs';

const withinWindowMessage = (id, text = 'Synthetic group conversation for bounded source audit.') =>
  message(String(id), { text, date: new Date(Date.now() - 60_000).toISOString() });

function groupCandidates(count) {
  return Array.from({ length: count }, (_, index) => ({
    channel_id: String(510000001 + index), username: `synthetic_group_${index + 1}`,
    title: `Synthetic Group ${index + 1}`, kind: 'group', joined: false,
  }));
}

async function startSearchCampaign(h, candidates, history) {
  const campaign = await h.campaign('Synthetic 20-community audit queue');
  const grantId = await h.authorize(campaign, 'Explicit offline synthetic group history review');
  h.runtime.rpcFactory = () => ({ accountId: ACCOUNT, connected: () => true,
    search: async () => ({ candidates }),
    resolve: async reference => {
      const requested = typeof reference === 'string' ? reference.replace(/^@/, '') : reference.username;
      const candidate = candidates.find(row => row.username === requested)
        ?? candidates.find(row => row.channel_id === String(reference.channel_id));
      if (!candidate) throw new Error(`Unexpected synthetic resolve: ${requested}`);
      return candidate;
    },
    discussions: async () => null,
    history,
  });
  await h.command('scout.search', { campaign_id: campaign.id, revision: campaign.revision });
  const search = await h.runtime.tick();
  assert.equal(search.disposition, 'candidates_added');
  return { campaign, grantId };
}

test('owner-authorized search drains twenty synthetic group audits at the 100-message cap without starvation', async t => {
  const candidates = groupCandidates(20), seen = [];
  const h = scoutHarness(t, { modelEnabled: false });
  h.config.scout.maxMessagesPerAudit = 100;
  h.config.scout.maxCandidates = 30;
  const { campaign } = await startSearchCampaign(h, candidates, async input => {
    seen.push({ channel_id: input.channel_id, before_id: input.before_id, limit: input.limit });
    const rows = Array.from({ length: input.limit }, (_, index) => withinWindowMessage(1000 - index));
    return { empty: false, requested_count: input.limit, received_count: rows.length,
      oldest_id: Number(rows.at(-1).message_id), messages: rows };
  });

  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_candidates WHERE campaign_id=?', campaign.id).n, 20);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM scout_jobs WHERE campaign_id=? AND kind='history' AND status='queued'", campaign.id).n, 20);
  for (let index = 0; index < 20; index++) {
    const state = await h.runtime.tick();
    assert.equal(state.disposition, 'sample_sealed', `history job ${index + 1} should make progress`);
  }

  const samples = h.store.all('SELECT * FROM scout_samples WHERE candidate_id IN (SELECT id FROM scout_candidates WHERE campaign_id=?)', campaign.id);
  assert.equal(samples.length, 20);
  assert.ok(samples.every(sample => sample.status === 'sealed' && sample.coverage === 'message_limit'));
  assert.ok(samples.every(sample => JSON.parse(sample.messages_json).length === 100));
  assert.equal(h.store.get("SELECT COUNT(*) n FROM scout_jobs WHERE campaign_id=? AND kind='history' AND status='queued'", campaign.id).n, 0);
  assert.equal(seen.length, 20);
  assert.ok(seen.every(call => call.before_id === 0 && call.limit === 100));
  assert.deepEqual(new Set(seen.map(call => call.channel_id)), new Set(candidates.map(candidate => candidate.channel_id)));
  assert.equal(h.config.scout.modelEnabled, false, 'model calls remain disabled for this offline test');
});

test('a midway restart resumes from the durable history cursor and preserves fixed seven-day bounds', async t => {
  const candidates = groupCandidates(1), beforeIds = [], resolved = [];
  const h = scoutHarness(t, { modelEnabled: false });
  h.config.scout.maxMessagesPerAudit = 100;
  const { campaign } = await startSearchCampaign(h, candidates, async input => {
    beforeIds.push(input.before_id);
    const start = input.before_id === 0 ? 150 : 100;
    const rows = Array.from({ length: 50 }, (_, index) => withinWindowMessage(start - index));
    return { empty: false, requested_count: input.limit, received_count: rows.length,
      oldest_id: Number(rows.at(-1).message_id), messages: rows };
  });
  const restartRpc = () => ({ accountId: ACCOUNT, connected: () => true,
    search: async () => ({ candidates }),
    resolve: async reference => { resolved.push(reference.channel_id); return candidates[0]; },
    discussions: async () => null,
    history: async input => {
      beforeIds.push(input.before_id);
      const start = input.before_id === 0 ? 150 : 100;
      const rows = Array.from({ length: 50 }, (_, index) => withinWindowMessage(start - index));
      return { empty: false, requested_count: input.limit, received_count: rows.length,
        oldest_id: Number(rows.at(-1).message_id), messages: rows };
    },
  });
  h.runtime.rpcFactory = restartRpc;
  const candidate = h.store.get('SELECT * FROM scout_candidates WHERE campaign_id=?', campaign.id);
  await h.command('scout.audit', { campaign_id: campaign.id, revision: campaign.revision, candidate_id: candidate.id });
  const firstPage = await h.runtime.tick();
  assert.equal(firstPage.disposition, 'sample_page');
  const job = h.store.get("SELECT * FROM scout_jobs WHERE campaign_id=? AND kind='history'", campaign.id);
  const cursor = JSON.parse(job.cursor_json);
  assert.equal(cursor.before_id, 101);
  assert.equal(cursor.scanned, 50);
  const partial = h.store.get('SELECT * FROM scout_samples WHERE id=?', job.sample_id);
  assert.equal(partial.status, 'collecting');
  const requestedWindowMs = Date.parse(partial.requested_until) - Date.parse(partial.requested_from);
  assert.ok(Math.abs(requestedWindowMs - 7 * 24 * 60 * 60 * 1000) < 2000,
    'sample semantics remain the existing fixed seven-day window');

  h.restart();
  h.runtime.rpcFactory = restartRpc;
  h.store.run('UPDATE scout_jobs SET next_at=? WHERE id=?', new Date(Date.now() - 1000).toISOString(), job.id);
  const resumed = await h.runtime.tick();
  assert.equal(resumed.disposition, 'sample_sealed', JSON.stringify({ resumed,
    job: h.store.get('SELECT status,reason,cursor_json FROM scout_jobs WHERE id=?', job.id), beforeIds }));
  assert.deepEqual(beforeIds, [0, 101], 'success path does not reread the first history page');
  assert.equal(resolved.length, 1, 'restart may re-resolve the peer, but resumes history at its stored offset');
  const sealed = h.store.get('SELECT * FROM scout_samples WHERE id=?', job.sample_id);
  assert.equal(sealed.status, 'sealed');
  assert.equal(sealed.coverage, 'message_limit');
  assert.equal(JSON.parse(sealed.messages_json).length, 100);
  assert.equal(JSON.parse(h.store.get('SELECT cursor_json FROM scout_jobs WHERE id=?', job.id).cursor_json).scanned, 100);
  assert.equal(h.config.scout.modelEnabled, false);
});

test('exhausted read budget and revoked audit authority leave partial samples unsealed', async t => {
  const candidates = groupCandidates(1), calls = [];
  const h = scoutHarness(t, { modelEnabled: false });
  h.config.scout.maxMessagesPerAudit = 300;
  h.config.scout.maxRequestsPerDay = 10;
  h.config.scout.maxRequestsPerSourceDay = 10;
  const { campaign, grantId } = await startSearchCampaign(h, candidates, async input => {
    calls.push(input.before_id);
    const start = input.before_id === 0 ? 500 : input.before_id - 1;
    const rows = Array.from({ length: 50 }, (_, index) => withinWindowMessage(start - index));
    return { empty: false, requested_count: input.limit, received_count: rows.length,
      oldest_id: Number(rows.at(-1).message_id), messages: rows };
  });
  const candidate = h.store.get('SELECT * FROM scout_candidates WHERE campaign_id=?', campaign.id);
  await h.command('scout.audit', { campaign_id: campaign.id, revision: campaign.revision, candidate_id: candidate.id });
  for (let page = 0; page < 4; page++) {
    if (page) h.store.run('UPDATE scout_jobs SET next_at=? WHERE status=\'queued\' AND campaign_id=? AND kind=\'history\'',
      new Date(Date.now() - 1000).toISOString(), campaign.id);
    assert.equal((await h.runtime.tick()).disposition, 'sample_page');
  }
  const job = h.store.get("SELECT * FROM scout_jobs WHERE campaign_id=? AND kind='history'", campaign.id);
  const sample = h.store.get('SELECT * FROM scout_samples WHERE id=?', job.sample_id);
  assert.equal(sample.status, 'collecting');
  assert.equal(JSON.parse(sample.messages_json).length, 200);
  h.store.run('UPDATE scout_jobs SET next_at=? WHERE id=?', new Date(Date.now() - 1000).toISOString(), job.id);
  const blocked = await h.runtime.tick();
  assert.equal(blocked.disposition, 'idle_or_budget_wait');
  assert.equal(h.store.get('SELECT status FROM scout_jobs WHERE id=?', job.id).status, 'queued');
  assert.equal(h.store.get('SELECT reason FROM scout_jobs WHERE id=?', job.id).reason, 'SCOUT_READ_BUDGET');
  assert.equal(h.store.get('SELECT status FROM scout_samples WHERE id=?', sample.id).status, 'collecting');
  assert.equal(JSON.parse(h.store.get('SELECT messages_json FROM scout_samples WHERE id=?', sample.id).messages_json).length, 200);
  assert.equal(calls.length, 4, 'budget denial occurs before another provider history call');

  await h.command('scout.revoke', { campaign_id: campaign.id, revision: campaign.revision, grant_id: grantId });
  assert.equal(h.store.get('SELECT status FROM scout_jobs WHERE id=?', job.id).status, 'stale');
  assert.equal(h.store.get('SELECT reason FROM scout_jobs WHERE id=?', job.id).reason, 'OWNER_REVOKED');
  assert.equal(h.store.get('SELECT status FROM scout_samples WHERE id=?', sample.id).status, 'collecting');
  assert.equal(h.store.get('SELECT coverage FROM scout_samples WHERE id=?', sample.id).coverage, 'unverified');
  assert.equal(h.config.scout.modelEnabled, false);
});
