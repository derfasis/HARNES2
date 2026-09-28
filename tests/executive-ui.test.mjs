import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearchView } from '../public/research.js';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function harness({ current = true, model = true } = {}) {
  const calls = [], reads = [], dialogs = [];
  const hostile = '<img src=x onerror="execute()">';
  const detail = { id: 'i1', status: 'proposed', current, reviewable: false, revision: 7,
    question: hostile, completion_criterion: 'Cite evidence', selection: [{ source_ref: hostile }],
    limits: { refresh_reads: 1, brief_model_runs: 0 }, refresh_source_ids: ['browser:one'],
    proposal_basis_fingerprint: 'basis-visible-at-review', attempts: [], turn_id: null, packet: null };
  const api = async route => {
    reads.push(route);
    if (route.startsWith('/api/continuity/threads?')) return { enabled: true, items: [], source_refs: [] };
    if (route.startsWith('/api/executive/intents?')) return { enabled: true, model_enabled: model, items: [{ id: 'i1', question: hostile, status: 'proposed' }], refreshable_source_refs: [] };
    if (route === '/api/executive/intents/i1') return detail;
    if (route.startsWith('/api/executive/candidates?')) return { items: [{ candidate: { lead_id: '1', full_name: hostile, reason: hostile } }], next_cursor: null };
    assert.fail(`Unexpected API read ${route}`);
  };
  let view;
  view = createResearchView({ api, command: async (action, payload) => { calls.push({ action, payload }); return {}; }, esc,
    panel: (title, body, action = '') => `<section><h2>${esc(title)}</h2>${action}${body}</section>`,
    button: (title, action) => `<button data-do="${esc(action)}">${esc(title)}</button>`, empty: () => '',
    field: (name, title, type, value = '', options = []) => `<div data-field="${esc(name)}" data-value="${esc(value)}">${esc(title)}${esc(JSON.stringify(options))}</div>`,
    modal: (title, html, submit) => dialogs.push({ title, html, submit }), refresh: () => view.load() });
  return { view, calls, reads, dialogs, hostile, detail };
}

test('research read/render escapes imported and source text without performing commands', async () => {
  const h = harness(); await h.view.load(); await h.view.act('research-intent', 'i1');
  const html = h.view.render(); assert.equal(html.includes(h.hostile), false); assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('актуальность неизвестна')); assert.deepEqual(h.calls, []);
  assert.ok(h.reads.every(r => r.startsWith('/api/')));
});

test('authorization form defaults to no model and submits the exact reviewed revision and basis', async () => {
  const h = harness(); await h.view.load(); await h.view.act('research-intent', 'i1'); await h.view.act('research-authorize', 'i1');
  const dialog = h.dialogs.at(-1); assert.match(dialog.html, /data-field="allow_model" data-value="false"/);
  assert.deepEqual(h.calls, []); await dialog.submit({ allow_model: 'false' });
  const { action, payload } = h.calls[0]; assert.equal(action, 'executive.authorize');
  assert.equal(payload.allow_model, false); assert.equal(payload.expected_revision, 7);
  assert.equal(payload.expected_basis_fingerprint, 'basis-visible-at-review');
  assert.equal(payload.intent_id, 'i1'); assert.ok(Date.parse(payload.deadline) > Date.now());
});

test('stale plans expose no authorization or acceptance control', async () => {
  const h = harness({ current: false }); await h.view.load(); await h.view.act('research-intent', 'i1');
  const html = h.view.render(); assert.doesNotMatch(html, /data-do="research-(authorize|accept|brief)"/);
  assert.match(html, /data-do="research-cancel"/); assert.deepEqual(h.calls, []);
});

test('external import is an explicit operator command and never requests a model or source read', async () => {
  const h = harness({ model: false }); await h.view.load(); await h.view.act('research-import');
  assert.deepEqual(h.calls, []);
  const jsonl = '{"lead_id":1,"reason":"unverified"}'; await h.dialogs.at(-1).submit({ jsonl });
  assert.deepEqual(h.calls, [{ action: 'executive.import_candidates', payload: { jsonl } }]);
});
