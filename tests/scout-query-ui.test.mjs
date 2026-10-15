import test from 'node:test';
import assert from 'node:assert/strict';
import { createScoutView } from '../public/scout.js';

const campaignId = '11111111-1111-4111-8111-111111111111';
const candidateId = '22222222-2222-4222-8222-222222222222';
const receiptId = '33333333-3333-4333-8333-333333333333';
const proposalId = '44444444-4444-4444-8444-444444444444';
const profileId = 'offline-profile';
const digest = 'a'.repeat(64);
const hash = 'b'.repeat(64);
const hostile = '<img src=x onerror="execute()">';
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function harness({ receipts = [], model = true } = {}) {
  const calls = [], dialogs = [];
  const profile = { id: profileId, label: 'Local review profile', state: 'available', definition_hash: hash, model_config: { model: 'offline-test-model' }, block_reasons: [] };
  const query = { id: 'query-1', candidate_id: candidateId, source: { channel_id: '123456789', username: 'sample_channel', title: 'Synthetic source' },
    query: 'looking for supplier', from: '2026-09-15', until: '2026-10-15', limit: 10, status: 'completed', reason: null, attempts: 1, receipts };
  const detail = { id: campaignId, title: 'Synthetic campaign', topic: 'Synthetic topic', revision: 4, status: 'active',
    config: { topic: 'Synthetic topic', queries: ['looking for supplier', 'need a vendor'] },
    authority: { scout: { id: 'audit-grant', current: true, status: 'active', expires_at: new Date(Date.now() + 3600000).toISOString() } },
    candidates: [{ id: candidateId, title: 'Synthetic source', username: 'sample_channel', channel_id: '123456789' }],
    message_queries: [query], jobs: [], unknown: [] };
  const snapshot = { enabled: true, model_enabled: false, model_scoped_available: model, model_profiles: model ? [profile] : [],
    campaigns: [{ id: campaignId, title: detail.title, topic: detail.topic, revision: 4, status: 'active', candidate_count: 1 }] };
  const api = async route => {
    calls.push({ method: 'GET', route });
    if (route === '/api/scout') return structuredClone(snapshot);
    if (route === `/api/scout/campaigns/${campaignId}`) return structuredClone(detail);
    throw new Error(`Unexpected read ${route}`);
  };
  const command = async (action, payload) => { calls.push({ method: 'POST', action, payload: structuredClone(payload) }); return { ok: true }; };
  const modal = (title, html, submit) => dialogs.push({ title, html, submit });
  const view = createScoutView({ api, command, esc, modal, refresh: async () => {} });
  return { view, calls, dialogs, detail, snapshot };
}

test('query receipts render escaped literal text, bounded selection, and unknown context without model or contact claims', async () => {
  const h = harness({ receipts: [{ id: receiptId, digest, retrieved_at: '2026-10-14T10:00:00.000Z', current: true,
    selection: { kind: 'message_query_v1', received_count: 12, returned_count: 10, omitted_count: 2, limit: 10, truncated: true, exhaustive: false },
    messages: [{ message_id: '19', date: '2026-10-14T09:00:00.000Z', text: hostile, unsupported: null, reply_to: { message_id: '18' }, link: 'https://t.me/sample_channel/19' }],
    proposals: [{ id: proposalId, status: 'proposed', current: true, summary: 'Context is incomplete.', items: [{ message_id: '19', quoted_text: hostile,
      interpretation: 'This may refer to another person.', classification: 'third_party_context', missing_context: ['Parent message unavailable'], suggested_public_reply: null }], unknowns: ['Author intent is unknown'], note: null }], model_requests: [] }] });
  await h.view.load();
  const html = h.view.render();
  assert.equal(html.includes(hostile), false);
  assert.match(html, /&lt;img src=x onerror=/);
  assert.match(html, /Получено 12 · опущено 2 · лимит 10/);
  assert.match(html, /Выборка не является полной историей/);
  assert.match(html, /Авторство или смысл неясны|третьем лице или приведённой цитате/);
  assert.match(html, /Parent message unavailable/);
  assert.match(html, /Текущий интерес, соответствие предложению и разрешение на контакт остаются неизвестными/);
  assert.match(html, /Текущность проверяется по локальным событиям; удалённые правки, не отражённые в этих данных, могут быть не видны/);
  assert.match(html, /Добавить без чтения истории/);
  assert.match(html, /Попыток задания: 1/);
  assert.deepEqual(h.calls.filter(call => call.method === 'POST'), []);
  assert.deepEqual(h.calls.filter(call => call.method === 'GET').map(call => call.route), ['/api/scout', `/api/scout/campaigns/${campaignId}`]);
});

test('empty result and unavailable text do not claim no opportunity or complete history', async () => {
  const h = harness({ receipts: [{ id: receiptId, digest, current: true, retrieved_at: '2026-10-14T10:00:00.000Z',
    selection: { kind: 'message_query_v1', received_count: 0, returned_count: 0, omitted_count: 0, limit: 10, truncated: false, exhaustive: false },
    messages: [], proposals: [], model_requests: [] }] });
  await h.view.load(); const html = h.view.render();
  assert.match(html, /Ничего не найдено по этому запросу/);
  assert.match(html, /не доказывает отсутствие таких запросов или потребностей/);
  assert.doesNotMatch(html, /Источник качественный|полная история получена/);
  assert.deepEqual(h.calls.filter(call => call.method === 'POST'), []);
});

test('source registration has an explicit no-history form and requires current audit on submit', async () => {
  const h = harness(); await h.view.load();
  await h.view.act('scout-register', campaignId);
  const form = h.dialogs.at(-1);
  assert.match(form.title, /без чтения истории/);
  assert.match(form.html, /не читает сообщения, не запускает поиск и не вызывает модель/);
  assert.deepEqual(h.calls.filter(call => call.method === 'POST'), []);
  await assert.rejects(() => form.submit({ reference: '  ' }), /Укажите публичный источник/);
  await form.submit({ reference: 'https://t.me/sample_channel' });
  const call = h.calls.filter(row => row.method === 'POST').at(-1);
  assert.deepEqual(call, { method: 'POST', action: 'scout.register', payload: { campaign_id: campaignId, revision: 4, reference: 'https://t.me/sample_channel' } });
});

test('query read requires selected campaign sources and queries, enforces bounded pairs, and submits only on confirmation', async () => {
  const h = harness(); await h.view.load();
  await h.view.act('scout-query-start', campaignId);
  const form = h.dialogs.at(-1);
  assert.match(form.html, /name="candidate_0"/);
  assert.match(form.html, /name="query_0"/);
  assert.deepEqual(h.calls.filter(call => call.method === 'POST'), []);
  await assert.rejects(() => form.submit({ candidate_0: 'yes', query_0: 'yes', window_days: '31', limit: '10' }), /от 1 до 30/);
  await form.submit({ candidate_0: 'yes', query_1: 'yes', window_days: '30', limit: '10' });
  const call = h.calls.filter(row => row.method === 'POST').at(-1);
  assert.deepEqual(call, { method: 'POST', action: 'scout.query_messages', payload: {
    campaign_id: campaignId, revision: 4, candidate_ids: [candidateId], queries: ['need a vendor'], window_days: 30, limit: 10,
  } });
});

test('model assessment is separate, requires explicit expiry and purpose, and binds exact receipt and profile hashes', async () => {
  const h = harness({ receipts: [{ id: receiptId, digest, current: true, retrieved_at: '2026-10-14T10:00:00.000Z',
    selection: { kind: 'message_query_v1', received_count: 1, returned_count: 1, omitted_count: 0, limit: 10, truncated: false, exhaustive: false },
    messages: [{ message_id: '20', date: '2026-10-14T09:00:00.000Z', text: 'Need a supplier' }], proposals: [], model_requests: [] }] });
  await h.view.load();
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 0, 'render does not call the model');
  await h.view.act('scout-query-assess', receiptId);
  const form = h.dialogs.at(-1);
  assert.match(form.html, /один возможный платный вызов модели/);
  assert.match(form.html, /Истечение по умолчанию через 30 минут/);
  assert.match(form.html, /контакт не разрешается/);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 0, 'opening the authorization form does not request an assessment');
  assert.throws(() => form.submit({ model_profile_id: profileId, expires_at: '', purpose: '' }), /будущий срок/);
  const expires_at = new Date(Date.now() + 10 * 60000).toISOString();
  await form.submit({ model_profile_id: profileId, expires_at, purpose: 'Interpret this exact bounded receipt.' });
  const call = h.calls.filter(row => row.method === 'POST').at(-1);
  assert.deepEqual(call, { method: 'POST', action: 'scout.request_query_assessment', payload: {
    campaign_id: campaignId, revision: 4, receipt_id: receiptId, expected_receipt_digest: digest,
    model_profile_id: profileId, expected_model_profile_hash: hash, expires_at, purpose: 'Interpret this exact bounded receipt.',
  } });
});

test('query proposal review explicitly approves only material for inspection', async () => {
  const h = harness({ receipts: [{ id: receiptId, digest, current: true, selection: { returned_count: 1 }, messages: [], model_requests: [],
    proposals: [{ id: proposalId, status: 'proposed', current: true, summary: 'Possible third-party quote.', items: [], unknowns: ['Author intent'], note: null }] }] });
  await h.view.load();
  const html = h.view.render(); assert.match(html, /Одобрить материал для просмотра/);
  await h.view.act('scout-query-review-approve', proposalId); const form = h.dialogs.at(-1);
  assert.match(form.html, /не разрешает контакт или отправку/);
  assert.deepEqual(h.calls.filter(call => call.method === 'POST'), []);
  await form.submit({ note: 'Reviewed the quote and its missing parent context.' });
  assert.deepEqual(h.calls.filter(call => call.method === 'POST').at(-1), { method: 'POST', action: 'scout.review_query', payload: {
    campaign_id: campaignId, revision: 4, proposal_id: proposalId, decision: 'approve', note: 'Reviewed the quote and its missing parent context.',
  } });
});
