// Stage 3E contract: the Discovery tab is a read-only viewer over the frozen 3B/3C projections.
// proof_level=integration; live_proof=false. No write path, no new dependency, no model run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

// The Discovery viewer renders whatever the API last returned. Tests drive it only through
// fetch, so a UI that quietly reaches for a write endpoint is visible here.
function ui({ list, detail, listStatus = 200, detailStatus = 200, detailOrder = ['a', 'b'] } = {}) {
  const calls = [];
  const context = vm.createContext({ console, Date, Map, JSON, Promise,
    crypto: { randomUUID: () => 'fixture-id' },
    document: { querySelector: () => ({}), querySelectorAll: () => [] } });
  const bootstrap = source.slice(0, source.indexOf("document.addEventListener('click'"));
  vm.runInContext(bootstrap + `
    globalThis.tab='discovery';
    globalThis.discoveryList=${JSON.stringify(list ?? { items: [], next_cursor: null })};
    globalThis.discoveryError=null;
    globalThis.discoveryDetail=null;
    globalThis.discoverySelection=null;
    globalThis.api=async(route,body)=>{
      globalThis.calls.push({route,body,method:body===undefined?'GET':'POST'});
      if(route==='/api/discovery/decisions')return {items:[],next_cursor:null};
      if(route.startsWith('/api/discovery/reason-states')){
        if(globalThis.listStatus!==200)throw new Error('Discovery недоступен');
        return globalThis.discoveryList;
      }
      if(route.startsWith('/api/discovery/')){
        const id=decodeURIComponent(route.split('/').at(-1));
        if(globalThis.detailStatus!==200)throw new Error('Ситуация больше недоступна');
        if(id===globalThis.staleDetail)throw new Error('Ситуация больше недоступна');
        return { ...globalThis.discoveryDetail, situation_id:id };
      }
      throw new Error('unexpected route');
    };
    globalThis.loadDiscovery=loadDiscovery;
    globalThis.selectSituation=selectSituation;
    globalThis.nextDiscoveryPage=nextDiscoveryPage;
    globalThis.discoveryTab=discoveryTab;
    globalThis.act=act;
    globalThis.render=()=>{};
    globalThis.discoveryDetailPanel=discoveryDetailPanel;
    globalThis.currentSelection=()=>discoverySelection;
    globalThis.setDetail=value=>{globalThis.discoveryDetail=value;};
    globalThis.setStaleDetail=id=>{globalThis.staleDetail=id;};
    globalThis.panel=()=>discoveryDetailPanel();
    globalThis.calls=[];
    globalThis.staleDetail=null;
    globalThis.listStatus=${listStatus};
    globalThis.detailStatus=${detailStatus};
    globalThis.detailOrder=${JSON.stringify(detailOrder)};
  `, context);
  context.discoveryDetail = detail;
  context.calls = calls;
  return context;
}

const situation = (over = {}) => ({
  situation_id: 'sit-1', status: 'OBSERVING', storage_status: 'OBSERVING', revision: 3,
  evidence_fingerprint: 'fp-1',
  basis: { source_ref: 'public:fixture', subject_ref: 'user:1', context_key: 'thread:1',
    purpose: 'opportunity', expires_at: '2026-12-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
  freshness: { fresh: true, reasons: [] },
  evidence: [{ source_event_id: '9', message_id: 'message:1', message_version: 1, author_id: 'user:1',
    observed_at: '2026-01-01T00:00:00.000Z', text: 'Что входит в предложение?', text_truncated: false }],
  assessments: [{ id: '5', created_at: '2026-01-01T00:00:01.000Z', decision: 'CANDIDATE',
    epistemic_status: 'unverified_proposal', reasoning_version: 1, reasoning_shape: 'structured_v1',
    hypothesis: { text: 'Возможно, нужен разбор.', text_truncated: false,
      attributed_claims: [{ source_event_id: '9', quote: 'Что входит в предложение?', quote_truncated: false }],
      inferences: [{ text: 'Возможности ограничены.', text_truncated: false, evidence_event_ids: ['9'] }],
      uncertainty: ['Не проверено'] },
    why_now: { reason: 'Вопрос задан прямо.', reason_truncated: false, evidence_event_ids: ['9'] },
    freshness: { fresh: true, reasons: [] },
    executable: false, contact_permission: false, allowed_effects: [] }],
  opening_proposals: [{ id: '6', created_at: '2026-01-01T00:00:02.000Z', text: 'Могу объяснить состав.',
    text_truncated: false, rationale: 'Только после разрешения.', rationale_truncated: false,
    constraints: ['operator review only'], executable: false, contact_permission: false, sent: false }],
  review_tasks: [{ id: 't1', status: 'proposed', created_at: '2026-01-01T00:00:02.000Z' }],
  executable: false, contact_permission: false, sent: false, allowed_effects: [],
  ...over,
});

const reasonRow = (over = {}) => ({
  situation_id: 'sit-1', storage_status: 'OBSERVING', revision: 3, evidence_fingerprint: 'fp-1',
  transition_id: '4', decision: 'WAIT', wait: { kind: 'deadline', at: '2099-01-01T00:00:00.000Z' },
  state: 'BLOCKED', unlock: 'DEADLINE_OR_EVIDENCE_CHANGE', reason: 'Ждём нового ответа',
  freshness: { fresh: true, reasons: [] },
  executable: false, contact_permission: false, allowed_effects: [], ...over });

test('3E list renders only the frozen reason-state fields and never invents meaning', async () => {
  const ctx = ui({ list: { items: [reasonRow()], next_cursor: 'cursor-2' } });
  await ctx.loadDiscovery();
  const html = ctx.discoveryTab();
  assert.match(html, /BLOCKED/);
  assert.match(html, /WAIT/);
  assert.match(html, /DEADLINE_OR_EVIDENCE_CHANGE/);
  assert.match(html, /Ждём нового ответа/);
  assert.match(html, /2099-01-01/);
  assert.doesNotMatch(html, /можно действовать/i);
  assert.doesNotMatch(html, /отправлено/i);
  // A READY row shows the literal reason, not an operator-friendly guess.
  const ready = ui({ list: { items: [reasonRow({ state: 'READY', reason: 'DEADLINE_REACHED' })], next_cursor: null } });
  await ready.loadDiscovery();
  assert.match(ready.discoveryTab(), /READY/);
  assert.match(ready.discoveryTab(), /DEADLINE_REACHED/);
});

test('3E the list issues one GET and pagination only follows the keyset cursor', async () => {
  const ctx = ui({ list: { items: [reasonRow()], next_cursor: 'cursor-2' } });
  await ctx.loadDiscovery();
  // One refresh reads both read-only Discovery surfaces, and never writes.
  assert.deepEqual(ctx.calls.map((call) => call.route),
    ['/api/discovery/reason-states', '/api/discovery/decisions']);
  assert.equal(ctx.calls.every((call) => call.method === 'GET'), true);
  await ctx.nextDiscoveryPage();
  const paged = ctx.calls.at(-1);
  assert.equal(paged.route, '/api/discovery/reason-states?cursor=cursor-2');
  assert.equal(paged.method, 'GET');
  assert.equal(ctx.calls.some((call) => call.method === 'POST'), false);
});

test('3E selecting a situation only GETs its detail and renders epistemic labels', async () => {
  const ctx = ui({ list: { items: [reasonRow()], next_cursor: null }, detail: situation() });
  await ctx.loadDiscovery();
  await ctx.selectSituation('sit-1');
  assert.equal(ctx.calls.at(-1).route, '/api/discovery/sit-1');
  assert.equal(ctx.calls[1].method, 'GET');
  const html = ctx.discoveryDetailPanel();
  assert.match(html, /Непроверенное предложение/);
  assert.match(html, /Зафиксированное наблюдение/);
  assert.match(html, /не подтверждённый факт/);
  assert.match(html, /Не отправлено/);
  assert.match(html, /Не даёт разрешения на контакт/);
  assert.match(html, /Не проверено/);
  assert.match(html, /Что входит в предложение\?/);
});

test('3E every truncation flag is shown next to the text it truncated', async () => {
  const long = { text: 'Обрезанный текст', text_truncated: true };
  const detail = situation({ evidence: [{ source_event_id: '9', message_id: 'message:1', message_version: 1,
      author_id: 'user:1', observed_at: '2026-01-01T00:00:00.000Z', ...long }],
    assessments: [{ id: '5', created_at: '2026-01-01T00:00:01.000Z', decision: 'CANDIDATE',
      epistemic_status: 'unverified_proposal', reasoning_version: 1, reasoning_shape: 'structured_v1',
      hypothesis: { ...long, attributed_claims: [{ source_event_id: '9', quote: 'Обрезанная цитата', quote_truncated: true }],
        inferences: [{ ...long, evidence_event_ids: ['9'] }], uncertainty: ['Не проверено'] },
      why_now: { reason: 'Обрезанная причина', reason_truncated: true, evidence_event_ids: ['9'] },
      freshness: { fresh: true, reasons: [] }, executable: false, contact_permission: false, allowed_effects: [] }],
    opening_proposals: [{ id: '6', created_at: '2026-01-01T00:00:02.000Z', text: 'Обрезанное предложение',
      text_truncated: true, rationale: 'Обрезанное обоснование', rationale_truncated: true,
      constraints: [], executable: false, contact_permission: false, sent: false }] });
  const ctx = ui({ list: { items: [reasonRow()], next_cursor: null }, detail });
  await ctx.loadDiscovery();
  await ctx.selectSituation('sit-1');
  const html = ctx.discoveryDetailPanel();
  assert.match(html, /Обрезан/);
  // evidence, hypothesis, claim quote, inference, WHY NOW, proposal text, proposal rationale.
  assert.equal((html.match(/обрезано/gi) ?? []).length, 7, 'every truncated field must say so');
});

test('3E source text is HTML-escaped and never becomes markup', async () => {
  const hostile = '<script>bad()</script><img src=x onerror=alert(1)>';
  const detail = situation({ evidence: [{ source_event_id: '9', message_id: 'message:1', message_version: 1,
    author_id: 'user:1', observed_at: '2026-01-01T00:00:00.000Z', text: hostile, text_truncated: false }] });
  const ctx = ui({ list: { items: [reasonRow()], next_cursor: null }, detail });
  await ctx.loadDiscovery();
  await ctx.selectSituation('sit-1');
  const html = ctx.discoveryDetailPanel();
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
});

test('3E 403 and a situation that vanished degrade locally without breaking the viewer', async () => {
  const denied = ui({ listStatus: 403 });
  await denied.loadDiscovery();
  assert.match(denied.discoveryTab(), /Discovery недоступен/);

  const ctx = ui({ list: { items: [reasonRow()], next_cursor: null }, detail: situation() });
  await ctx.loadDiscovery();
  ctx.staleDetail = 'sit-gone';
  await ctx.selectSituation('sit-gone');
  assert.match(ctx.discoveryDetailPanel(), /Ситуация больше недоступна/);
  // The list survives a failing detail.
  assert.match(ctx.discoveryTab(), /sit-1/);
});

test('3E a late response for an old selection cannot overwrite the current one', async () => {
  const ctx = ui({ list: { items: [reasonRow()], next_cursor: null }, detail: situation() });
  await ctx.loadDiscovery();
  const slow = ctx.selectSituation('sit-old');
  const fast = ctx.selectSituation('sit-1');
  await Promise.all([slow, fast]);
  assert.equal(ctx.discoveryDetail.situation_id, 'sit-1');
  assert.doesNotMatch(ctx.discoveryDetailPanel(), /sit-old/);
});

test('3E the Discovery tab exposes no action that could write anything', async () => {
  const ctx = ui({ list: { items: [reasonRow()], next_cursor: 'cursor-2' }, detail: situation() });
  await ctx.loadDiscovery();
  const html = ctx.discoveryTab();
  for (const action of ['discovery-approve', 'discovery-reason', 'discovery-transfer', 'discovery-stop',
    'discovery-assess', 'discovery-review']) {
    assert.equal(html.includes(`data-do="${action}`), false, `the viewer must not offer ${action}`);
  }
  assert.equal(/data-do="[^"]*discovery(?!-select|-next)[^"]*"/.test(html), false);
  assert.equal(html.includes('/api/commands'), false);
});

test('3E the wired click actions read only and never fall through to a command', async () => {
  const ctx = ui({ list: { items: [reasonRow()], next_cursor: 'cursor-2' }, detail: situation() });
  await ctx.loadDiscovery();
  await ctx.act('discovery-select', 'sit-1');
  assert.equal(ctx.currentSelection(), 'sit-1');
  assert.deepEqual(ctx.calls.map((call) => call.route),
    ['/api/discovery/reason-states', '/api/discovery/decisions', '/api/discovery/sit-1']);
  await ctx.act('discovery-next');
  assert.equal(ctx.calls.at(-1).route, '/api/discovery/reason-states?cursor=cursor-2');
  assert.equal(ctx.calls.at(-1).method, 'GET');
  assert.equal(ctx.calls.some((call) => call.method === 'POST'), false);
  assert.equal(ctx.calls.some((call) => call.route === '/api/commands'), false);
  // A viewer action must not reach the shared refresh tail either, which would claim "Сохранено".
  assert.equal(ctx.commands, undefined);
});

test('3E a background refresh re-reads the open situation instead of leaving a stale card', async () => {
  const ctx = ui({ list: { items: [reasonRow()], next_cursor: null }, detail: situation() });
  await ctx.loadDiscovery();
  await ctx.selectSituation('sit-1');
  assert.match(ctx.discoveryDetailPanel(), /Свежее/);

  // The situation goes stale underneath the viewer: the next refresh must notice.
  ctx.setDetail(situation({ freshness: { fresh: false, reasons: ['DISCOVERY_EXPIRED'] } }));
  await ctx.loadDiscovery();
  const updated = ctx.discoveryDetailPanel();
  assert.match(updated, /Неактуально: DISCOVERY_EXPIRED/);
  // The situation line changed; the assessment keeps its own, separately computed freshness.
  assert.doesNotMatch(updated, /<p>Свежее<\/p>/);

  // And if it disappears entirely, the card degrades instead of pretending it is still there.
  ctx.setStaleDetail('sit-1');
  await ctx.loadDiscovery();
  assert.match(ctx.discoveryDetailPanel(), /Ситуация больше недоступна/);
  assert.equal(ctx.currentSelection(), 'sit-1');
  assert.equal(ctx.calls.some((call) => call.method === 'POST'), false);
});
