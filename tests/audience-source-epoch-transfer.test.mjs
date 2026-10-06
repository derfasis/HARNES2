// Source watch epoch history transfers as audit evidence, never executable authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../business/config.mjs';
import { Store, hash, id } from '../business/store.mjs';
import { exportPartner } from '../business/export.mjs';
import { BusinessService } from '../business/service.mjs';
import { stable } from '../business/source-ingestion.mjs';
import { audienceHarness, SOURCE, SOURCE_B } from './audience-test-helpers.mjs';

function importBundle(t, h, bundle, label) {
  const file = path.join(h.directory, `source-epoch-${label}-${id()}.json`);
  fs.writeFileSync(file, JSON.stringify(bundle), { flag: 'wx' });
  const destination = path.join(ROOT, 'exports', `source-epoch-${label}-${id()}`);
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['scripts/import.mjs', file, destination],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  return { file, destination, result };
}

async function renewedWatch(h) {
  const goal = await h.open({ source_ids: [SOURCE] });
  await h.ingest({ message_id: 'epoch-before-gap', text: 'Synthetic pre-gap observation.' });
  h.service.audience.reconcile({ limit: 10 });
  const modelAuthority = await addModelAuthority(h, goal.goal_id);
  h.config.opportunity.allowedSourceRefs = [SOURCE_B];
  h.service.audience.reconcile({ limit: 10 });
  assert.equal(h.service.audience.watches(goal.goal_id)[0].status, 'revoked');
  h.config.opportunity.allowedSourceRefs = [SOURCE, SOURCE_B];
  await h.ingest({ message_id: 'epoch-inside-gap', text: 'Synthetic observation after withdrawal while the watch remains revoked.' });
  const preview = await h.service.audience.sourceRenewalPreview({ goal_id: goal.goal_id, source_ref: SOURCE });
  const requestId = '4dc616ac-4601-47f9-8ec2-2d9292c89df5';
  const payload = { goal_id: goal.goal_id, source_ref: SOURCE, expected_revision: preview.expected_revision,
    preview_sha256: preview.preview_sha256, acknowledge_gap: true };
  const receipt = await h.command('audience.renew_source', payload, requestId);
  return { goal, preview, requestId, payload, receipt, modelAuthority };
}

async function addModelAuthority(h, goalId) {
  const endpoint = 'https://source-epoch-transfer.invalid/v1';
  h.config.modelProfiles = { allowedBaseUrls: [endpoint] };
  const profile = await h.command('model.profile_create', { label: 'Source epoch transfer fixture', provider: 'custom',
    api_mode: 'chat_completions', base_url: endpoint, model: 'synthetic-transfer-model', max_output_tokens: 256,
    input_usd_per_million: 1, output_usd_per_million: 1 });
  const detail = h.service.audience.detail(goalId);
  const option = detail.attention.profile_options.find(row => row.profile_id === profile.profile_id);
  assert.ok(option, 'the selected test profile is a real option for this goal');
  const grant = await h.command('audience.attention_grant', { goal_id: goalId, expected_revision: detail.revision,
    expected_scope_fingerprint: option.scope_fingerprint, model_profile_id: profile.profile_id, max_attempts: 1,
    expires_at: new Date(Date.now() + 3600000).toISOString(), reason: 'Synthetic transfer authority fixture.' });
  return { profileId: profile.profile_id, grantId: grant.grant_id };
}

async function legacyWatch(h) {
  const goal = await h.open({ source_ids: [SOURCE] });
  await h.ingest({ message_id: 'legacy15-watch', text: 'Synthetic schema-15 baseline observation.' });
  h.service.audience.reconcile({ limit: 10 });
  const watch = h.service.audience.watches(goal.goal_id).find(row => row.source_ref === SOURCE);
  assert.equal(watch.status, 'active');
  assert.equal(watch.policy_hash, h.service.audience.policyHash(SOURCE));
  return { goal, watch };
}

async function secondEpoch(h, goalId) {
  await h.ingest({ message_id: 'epoch-after-first', text: 'Synthetic observation after the first renewed epoch.' });
  h.service.audience.reconcile({ limit: 10 });
  h.config.opportunity.allowedSourceRefs = [SOURCE_B];
  h.service.audience.reconcile({ limit: 10 });
  assert.equal(h.service.audience.watches(goalId).find(row => row.source_ref === SOURCE).status, 'revoked');
  h.config.opportunity.allowedSourceRefs = [SOURCE, SOURCE_B];
  await h.ingest({ message_id: 'epoch-second-gap', text: 'Synthetic observation during the second revoked interval.' });
  const preview = await h.service.audience.sourceRenewalPreview({ goal_id: goalId, source_ref: SOURCE });
  const requestId = 'b62a51b1-32e0-40d5-9eb4-2be52f0e74a1';
  const payload = { goal_id: goalId, source_ref: SOURCE, expected_revision: preview.expected_revision,
    preview_sha256: preview.preview_sha256, acknowledge_gap: true };
  await h.command('audience.renew_source', payload, requestId);
}

test('schema-17 export and real staging import retain epoch history while revoking authority and replay', async t => {
  const h = audienceHarness(t), renewed = await renewedWatch(h), oldModel = renewed.modelAuthority;
  const bundle = exportPartner(h.store);
  assert.equal(bundle.migrations.length, 17);
  assert.ok(bundle.excluded.includes('transferable audience source-watch authority'));
  assert.ok(Object.hasOwn(bundle.tables, 'audience_watch_epochs'));
  assert.deepEqual(bundle.tables.audience_watch_epochs, h.store.all('SELECT * FROM audience_watch_epochs ORDER BY goal_id,source_ref,generation'));
  assert.equal(bundle.tables.audience_watch_epochs.length, 1);

  const { result, destination } = importBundle(t, h, bundle, 'schema16');
  assert.equal(result.status, 0, result.stderr);
  const restored = new Store(path.join(destination, 'data'));
  try {
    const restoredEpochs = restored.all('SELECT * FROM audience_watch_epochs ORDER BY goal_id,source_ref,generation');
    assert.deepEqual(restoredEpochs, bundle.tables.audience_watch_epochs);
    assert.equal(restored.get('SELECT status FROM audience_watches WHERE goal_id=? AND source_ref=?',
      renewed.goal.goal_id, SOURCE).status, 'revoked');
    assert.equal(restored.get('SELECT status FROM audience_attention_grants WHERE id=?', oldModel.grantId).status, 'revoked');
    assert.equal(restored.get('SELECT status FROM model_profiles WHERE id=?', oldModel.profileId).status, 'revoked');
    assert.equal(restored.get('SELECT COUNT(*) n FROM audience_attention_models WHERE grant_id=?', oldModel.grantId).n, 1,
      'the model selection remains historical provenance');

    const service = new BusinessService(restored, h.config);
    await assert.rejects(service.command('audience.renew_source', renewed.payload, renewed.requestId),
      'an imported renewal receipt cannot reactivate its old watch');
    assert.equal(restored.get('SELECT status FROM audience_watches WHERE goal_id=? AND source_ref=?',
      renewed.goal.goal_id, SOURCE).status, 'revoked');
    assert.deepEqual(restored.all('PRAGMA foreign_key_check'), []);
  } finally { restored.close(); }
});

test('actual schema-15 catalogue preserves a legacy watch and imports through migration 17', async t => {
  const h = audienceHarness(t), { goal, watch: legacySourceWatch } = await legacyWatch(h);
  const bundle = exportPartner(h.store);
  bundle.migrations = bundle.migrations.slice(0, 15);
  delete bundle.tables.audience_watch_epochs;
  delete bundle.tables.source_observation_epochs;
  bundle.tables_sha256 = hash(JSON.stringify(bundle.tables));
  assert.equal(Object.hasOwn(bundle.tables, 'audience_watch_epochs'), false);
  const { result, destination } = importBundle(t, h, bundle, 'schema15');
  assert.equal(result.status, 0, result.stderr);
  const restored = new Store(path.join(destination, 'data'));
  try {
    assert.equal(restored.get('SELECT COUNT(*) n FROM schema_migrations').n, 17);
    assert.equal(restored.get('SELECT COUNT(*) n FROM audience_watch_epochs').n, 0);
    const importedWatch = restored.get('SELECT * FROM audience_watches WHERE goal_id=? AND source_ref=?', goal.goal_id, SOURCE);
    assert.equal(importedWatch.status, 'revoked');
    assert.equal(importedWatch.policy_hash, legacySourceWatch.policy_hash,
      'the real pre-epoch watch remains its historical schema-15 policy projection');
    assert.deepEqual(restored.all('PRAGMA foreign_key_check'), []);
  } finally { restored.close(); }
});

test('schema-17 import preserves a complete two-epoch chain and rejects broken history', async t => {
  const h = audienceHarness(t), { goal } = await renewedWatch(h), base = exportPartner(h.store);
  assert.equal(base.tables.audience_watch_epochs.length, 1);
  await secondEpoch(h, goal.goal_id);
  const complete = exportPartner(h.store);
  assert.deepEqual(complete.tables.audience_watch_epochs.map(row => row.generation), [1, 2]);
  const { result: importedResult, destination: importedDestination } = importBundle(t, h, complete, 'two-epochs');
  assert.equal(importedResult.status, 0, importedResult.stderr);
  const imported = new Store(path.join(importedDestination, 'data'));
  try {
    assert.deepEqual(imported.all('SELECT * FROM audience_watch_epochs ORDER BY generation'), complete.tables.audience_watch_epochs);
    assert.equal(imported.get('SELECT status FROM audience_watches WHERE goal_id=? AND source_ref=?', goal.goal_id, SOURCE).status, 'revoked');
  } finally { imported.close(); }

  const transitionDigest = row => {
    const { transition_sha256, ...definition } = row;
    return hash(stable(definition));
  };
  const malformed = [
    { label: 'bad-hash-chain', edit: row => { row.transition_sha256 = '0'.repeat(64); } },
    { label: 'bad-scalar', edit: row => { row.preview_sha256 = 'not-a-sha256'; } },
    { label: 'bad-prior-policy-link', edit: bundle => {
      bundle.tables.audience_watch_epochs[1].prior_policy_hash = 'f'.repeat(64);
      bundle.tables.audience_watch_epochs[1].transition_sha256 = transitionDigest(bundle.tables.audience_watch_epochs[1]);
    } },
  ];
  for (const { label, edit } of malformed) {
    const bundle = structuredClone(label === 'bad-prior-policy-link' ? complete : base);
    if (label === 'bad-prior-policy-link') edit(bundle);
    else edit(bundle.tables.audience_watch_epochs[0]);
    bundle.tables_sha256 = hash(JSON.stringify(bundle.tables));
    const { result, destination } = importBundle(t, h, bundle, label);
    assert.notEqual(result.status, 0, `${label} must be rejected`);
    assert.match(result.stderr, /AUDIENCE_WATCH_EPOCH_INVALID/);
    assert.equal(fs.existsSync(destination), true, 'failed imports remain isolated in their staging destination');
  }
  assert.ok(goal.goal_id);
});
