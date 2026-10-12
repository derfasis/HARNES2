import test from 'node:test';
import assert from 'node:assert/strict';
import { createScoutView } from '../public/scout.js';

const campaignId = '11111111-1111-4111-8111-111111111111';
const candidateId = '22222222-2222-4222-8222-222222222222';
const sampleId = '33333333-3333-4333-8333-333333333333';
const jobId = '44444444-4444-4444-8444-444444444444';
const requestId = '55555555-5555-4555-8555-555555555555';
const fingerprint = 'a'.repeat(64);
const profileId = 'offline-profile';
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function harness({ scopedAvailable = true, profiles = 'available', readOnly = false, modelRequest = null } = {}) {
  const calls = [], dialogs = [];
  const profile = { id: profileId, label: 'Offline review profile', state: 'available', block_reasons: [],
    definition_hash: fingerprint, model_config: { model: 'offline-review-model' } };
  const source = { id: candidateId, title: 'Synthetic source', username: 'sample_channel', channel_id: '123456789',
    kind: 'channel', joined: true, reason: 'Synthetic fixture',
    sample: { id: sampleId, current: true, finished_at: '2026-10-01T10:00:00.000Z', coverage: 'partial',
      metrics: { messages: 2, authors: 1, active_days: 1, replies: 0, exact_repeats: 0, unsupported: 0 },
      groups: [{ id: 'group-1', evidence_refs: ['ev-1'], preview: 'Synthetic evidence', messages: [] }] } };
  const job = { id: jobId, kind: 'assessment', status: 'queued', next_at: '2026-10-12T10:00:00.000Z',
    model_request: modelRequest ? { id: requestId, fingerprint, status: 'active', purpose: 'One bounded assessment',
      expires_at: new Date(Date.now() + 600000).toISOString(), spent: false, profile: { id: profileId } } : null };
  const detail = { id: campaignId, title: 'Synthetic campaign', topic: 'Synthetic topic', revision: 7, status: 'active',
    config: { topic: 'Synthetic topic', audience: 'Operators', language: 'en', geography: 'global', queries: ['sample'] },
    authority: { scout: { id: 'audit-grant', current: true, status: 'active' } },
    candidates: [source], jobs: modelRequest ? [job] : [], unknown: [] };
  const data = { enabled: true, model_enabled: false, model_scoped_available: scopedAvailable,
    deployment_mode: readOnly ? 'read_only' : 'scoped_reasoning', model_profiles: profiles === 'available' ? [profile] : [],
    account_id: 'synthetic-account', limits: { maxRequestsPerDay: 50 },
    campaigns: [{ id: campaignId, title: detail.title, topic: detail.topic, revision: 7, status: 'active', candidate_count: 1 }] };
  const api = async route => {
    calls.push({ method: 'GET', route });
    if (route === '/api/scout') return structuredClone(data);
    if (route === `/api/scout/campaigns/${campaignId}`) return structuredClone(detail);
    throw new Error(`Unexpected read ${route}`);
  };
  const command = async (action, payload) => {
    calls.push({ method: 'POST', action, payload: structuredClone(payload) });
    return { ok: true };
  };
  const modal = (title, html, submit) => dialogs.push({ title, html, submit });
  const view = createScoutView({ api, command, esc: escapeHtml, modal, refresh: async () => {} });
  return { view, calls, dialogs, data, detail };
}

test('scoped assessment requires explicit valid form submission and sends one exact sample/profile request', async () => {
  const h = harness();
  await h.view.load();
  assert.match(h.view.render(), /Разрешить одну оценку/);
  assert.deepEqual(h.calls.filter(call => call.method === 'POST'), []);

  await h.view.act('scout-assess-scoped', candidateId);
  const form = h.dialogs.at(-1);
  assert.match(form.html, /Текущий интерес человека и соответствие вашему предложению неизвестны/);
  assert.deepEqual(h.calls.filter(call => call.method === 'POST'), [], 'opening the form only performs fresh reads');
  assert.equal(h.calls.filter(call => call.method === 'GET' && call.route === '/api/scout').length, 2);
  assert.equal(h.calls.filter(call => call.method === 'GET' && call.route === `/api/scout/campaigns/${campaignId}`).length, 2);

  assert.throws(() => form.submit({ model_profile_id: profileId, expires_at: '', purpose: '' }), /будущий срок и цель/);
  assert.deepEqual(h.calls.filter(call => call.method === 'POST'), [], 'blank expiry and purpose do not create a request');

  const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
  await form.submit({ model_profile_id: profileId, expires_at: expiresAt, purpose: 'Review this one sealed sample.' });
  const posts = h.calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], { method: 'POST', action: 'scout.request_assessment', payload: {
    campaign_id: campaignId, revision: 7, candidate_id: candidateId, sample_id: sampleId,
    model_profile_id: profileId, expected_model_profile_hash: fingerprint, expires_at: expiresAt,
    purpose: 'Review this one sealed sample.',
  } });
  assert.deepEqual(posts.map(call => call.action), ['scout.request_assessment'],
    'the interaction requests no join, draft, person, or send action');
});

test('missing model profile and read-only availability cannot open a grant form', async () => {
  const missing = harness({ scopedAvailable: true, profiles: 'missing' });
  await missing.view.load();
  await assert.rejects(() => missing.view.act('scout-assess-scoped', candidateId), /Нет доступного профиля модели/);
  assert.equal(missing.dialogs.length, 0);
  assert.deepEqual(missing.calls.filter(call => call.method === 'POST'), []);

  const readOnly = harness({ scopedAvailable: false, profiles: 'missing', readOnly: true });
  await readOnly.view.load();
  await assert.rejects(() => readOnly.view.act('scout-assess-scoped', candidateId), /больше не доступны/);
  assert.equal(readOnly.dialogs.length, 0);
  assert.deepEqual(readOnly.calls.filter(call => call.method === 'POST'), []);
});

test('revoke reads the current job request and submits its exact fingerprint only after a reason', async () => {
  const h = harness({ modelRequest: true });
  await h.view.load();
  assert.match(h.view.render(), /Отозвать оценку/);
  assert.deepEqual(h.calls.filter(call => call.method === 'POST'), []);

  await h.view.act('scout-assessment-revoke', jobId);
  const form = h.dialogs.at(-1);
  assert.deepEqual(h.calls.filter(call => call.method === 'GET' && call.route === `/api/scout/campaigns/${campaignId}`).length, 2,
    'revoke resolves the request from a fresh campaign detail');
  assert.deepEqual(h.calls.filter(call => call.method === 'POST'), []);
  assert.throws(() => form.submit({ reason: '  ' }), /Укажите причину/);
  assert.deepEqual(h.calls.filter(call => call.method === 'POST'), []);

  await form.submit({ reason: 'The assessment is no longer needed.' });
  const posts = h.calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], { method: 'POST', action: 'scout.revoke_assessment', payload: {
    request_id: requestId, expected_fingerprint: fingerprint, reason: 'The assessment is no longer needed.',
  } });
});
