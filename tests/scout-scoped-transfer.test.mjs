import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../business/config.mjs';
import { Store, hash, id } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { exportPartner } from '../business/export.mjs';
import { REFERENCE_TABLES } from '../business/reference-tables.mjs';
import { SCOUT_QUERY_TABLES } from '../business/scout-tables.mjs';
import { RuntimeActivation } from '../business/deployment.mjs';
import { processScoutAssessment } from '../business/scout-reasoning.mjs';
import { ACCOUNT, channel, message, noHistory, scoutHarness } from './scout-test-helpers.mjs';

const profileUrl = 'https://models.example.test/v1';
const validOutput = {
  recommendation: 'consider',
  reason: 'A bounded source discussion merits operator review.',
  evidence_refs: ['1'],
  opportunities: [{ description: 'Review the cited discussion.', evidence_refs: ['1'] }],
  uncertainty: ['The sample does not establish current intent.'],
};

async function prepared(t) {
  const priorKey = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'offline-scoped-transfer-sentinel';
  t.after(() => priorKey === undefined ? delete process.env.PARTNER_MODEL_API_KEY
    : process.env.PARTNER_MODEL_API_KEY = priorKey);
  const h = scoutHarness(t, { resolve: async () => channel({ joined: true }), history: async input => input.before_id
    ? noHistory(input)
    : { empty: false, requested_count: input.limit, received_count: 1, oldest_id: 1,
        messages: [message('1', { text: 'I am considering reselling a product line. Which suppliers support small shops?' })] } });
  Object.assign(h.config.runtime, { enabled: false, model: '', baseUrl: '', dailyBudgetUsd: 5 });
  h.config.opportunity.automatic = false;
  h.config.modelProfiles = { allowedBaseUrls: [profileUrl] };
  h.config.controlPlane.enabled = true;
  h.service.deployment = new RuntimeActivation({ id: id(), label: 'Transfer fixture', mode: 'scoped_reasoning',
    expires_at: new Date(Date.now() + 3600000).toISOString() });
  const campaign = await h.campaign('small business product sourcing');
  await h.authorize(campaign);
  const candidate = await h.seed(campaign);
  const sample = await h.auditAndSeal(campaign, candidate);
  const profile = await h.command('model.profile_create', { label: 'Transfer fixture profile', provider: 'custom',
    api_mode: 'chat_completions', base_url: profileUrl, model: 'offline-transfer-model', max_output_tokens: 900,
    input_usd_per_million: 2, output_usd_per_million: 3 });
  const request = await h.command('scout.request_assessment', { campaign_id: campaign.id, revision: campaign.revision,
    candidate_id: candidate.id, sample_id: sample.id, model_profile_id: profile.profile_id,
    expected_model_profile_hash: profile.definition_hash, expires_at: new Date(Date.now() + 5 * 60000).toISOString(),
    purpose: 'One offline transfer assessment for this sealed sample.' });
  return { h, campaign, candidate, sample, profile, request };
}

function destinationFor(name) {
  return path.join(ROOT, 'exports', `${name}-${id()}`);
}

function importBundle(t, h, bundle, name) {
  const source = path.join(h.store.directory, `${name}.json`);
  const destination = destinationFor(name);
  fs.writeFileSync(source, JSON.stringify(bundle), { flag: 'wx' });
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, ['scripts/import.mjs', source, destination],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return { destination, child };
}

test('schema-18 catalogue imports without Scout scoped requests; schema-20 transfer revokes authority and retains spent receipt', async t => {
  const x = await prepared(t);
  let runtimeCalls = 0;
  const outcome = await processScoutAssessment(x.h.service, { decide: async () => {
    runtimeCalls++;
    return { completed: true, final_response: JSON.stringify(validOutput), usage: { input_tokens: 21, output_tokens: 9 } };
  } });
  assert.equal(outcome.disposition, 'assessment_proposed');
  assert.equal(runtimeCalls, 1);

  const requestBefore = x.h.store.get('SELECT * FROM scout_model_requests WHERE id=?', x.request.request_id);
  const receiptBefore = x.h.store.get('SELECT * FROM scout_assessments WHERE id=?', outcome.assessment_id);
  const jobBefore = x.h.store.get('SELECT * FROM scout_jobs WHERE id=?', x.request.job_id);
  assert.equal(requestBefore.run_id, receiptBefore.run_id);
  assert.equal(jobBefore.status, 'completed');
  assert.throws(() => x.h.store.run('UPDATE scout_model_requests SET run_id=NULL WHERE id=?', requestBefore.id), /SCOUT_MODEL_REQUEST/);

  // Simulate a forged queued job and reset attempt counters. The immutable request
  // still names the run that consumed this one-shot authority.
  x.h.store.run("UPDATE scout_jobs SET status='queued',attempts=0,run_id=NULL,owner_id=NULL WHERE id=?", jobBefore.id);
  assert.equal(x.h.store.get('SELECT run_id FROM scout_model_requests WHERE id=?', requestBefore.id).run_id, receiptBefore.run_id);
  const retry = await processScoutAssessment(x.h.service, { decide: async () => { runtimeCalls++; throw new Error('must not forward'); } });
  assert.notEqual(retry.disposition, 'assessment_proposed');
  assert.equal(runtimeCalls, 1);

  const old18 = exportPartner(x.h.store);
  old18.migrations = old18.migrations.slice(0, 18);
  for (const table of REFERENCE_TABLES) delete old18.tables[table];
  for (const table of SCOUT_QUERY_TABLES) delete old18.tables[table];
  delete old18.tables.scout_model_requests;
  old18.tables_sha256 = hash(JSON.stringify(old18.tables));
  const imported18 = importBundle(t, x.h, old18, 'scout-transfer-schema18');
  const oldStore = new Store(path.join(imported18.destination, 'data'));
  try {
    assert.equal(oldStore.all('SELECT * FROM schema_migrations').length, 21);
    assert.equal(oldStore.get('SELECT COUNT(*) n FROM scout_model_requests').n, 0);
    assert.equal(oldStore.get('SELECT COUNT(*) n FROM scout_message_queries').n, 0);
    assert.equal(oldStore.get('SELECT COUNT(*) n FROM scout_query_receipts').n, 0);
    assert.equal(oldStore.get('SELECT COUNT(*) n FROM scout_query_proposals').n, 0);
    assert.deepEqual(oldStore.all('PRAGMA foreign_key_check'), []);
  } finally { oldStore.close(); }

  const current20 = exportPartner(x.h.store);
  current20.migrations = current20.migrations.slice(0, 20);
  for (const table of SCOUT_QUERY_TABLES) delete current20.tables[table];
  current20.tables_sha256 = hash(JSON.stringify(current20.tables));
  assert.equal(current20.migrations.length, 20);
  const imported19 = importBundle(t, x.h, current20, 'scout-transfer-schema20');
  const store = new Store(path.join(imported19.destination, 'data'));
  try {
    const transferredRequest = store.get('SELECT * FROM scout_model_requests WHERE id=?', requestBefore.id);
    const transferredJob = store.get('SELECT * FROM scout_jobs WHERE id=?', jobBefore.id);
    const transferredReceipt = store.get('SELECT * FROM scout_assessments WHERE id=?', receiptBefore.id);
    assert.equal(transferredRequest.status, 'revoked');
    assert.equal(transferredRequest.revocation_reason, 'TRANSFER_AUTHORITY_REQUIRES_REVIEW');
    assert.equal(transferredRequest.run_id, receiptBefore.run_id);
    assert.equal(transferredJob.status, 'stale');
    assert.equal(transferredJob.run_id, null, 'forged queue state is retired during transfer');
    assert.equal(transferredReceipt.status, 'stale');
    assert.equal(transferredReceipt.run_id, receiptBefore.run_id);
    assert.equal(transferredReceipt.output_json, receiptBefore.output_json, 'the completed assessment receipt remains inspectable');
    assert.equal(store.get('SELECT status FROM scout_grants WHERE campaign_id=?', x.campaign.id).status, 'revoked');
    assert.equal(store.get('SELECT status FROM model_profiles WHERE id=?', x.profile.profile_id).status, 'revoked');
    assert.deepEqual(store.all('PRAGMA foreign_key_check'), []);

    const restored = new BusinessService(store, x.h.config);
    restored.setTelegramAccount(ACCOUNT);
    let forwarded = 0;
    const afterTransfer = await processScoutAssessment(restored, { decide: async () => { forwarded++; } });
    assert.notEqual(afterTransfer.disposition, 'assessment_proposed');
    assert.equal(forwarded, 0, 'transferred request, job, Scout grant and profile cannot authorize a forward');
  } finally { store.close(); }
});
