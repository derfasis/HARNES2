import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudienceView } from '../public/audience.js';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const hostile = '<img src=x onerror="execute()">';

function harness({ modelEnabled = false, assessmentStatus = 'captured', emptyOutput = false } = {}) {
  const calls = [], reads = [];
  let currentModelEnabled = modelEnabled;
  const goal = { id:'g1', title:'Goal', objective:'Observe questions', status:'OPEN', revision:3, ready:true,
    needs:[{ id:'n1', title:'Need', status:'accepted', revision:4 }], assessments:[] };
  const need = { id:'n1', goal_id:'g1', assessment_id:'as-old', title:'Need', hypothesis:'Old interpretation',
    status:'accepted', revision:4, basis_fingerprint:'basis-old', current:true, support_quotes:[], evidence_event_ids:[],
    counterevidence_event_ids:[], exchange_ids:[], unknowns:[] };
  const oldAssessment = { id:'as-old', goal_id:'g1', status:'captured', current:true, packet:{ exchanges:[], unknowns:[] } };
  let focused = null;
  const context = { available:true, current:false, reasons:[hostile], context_fingerprint:'context-fp', need_id:'n1',
    need_revision:4, need_basis_fingerprint:'basis-old', prior_exchange_ids:['old-x'], new_exchange_ids:['new-x'],
    hypothesis_memory:{ hypothesis:'Historical model of need', resolution:'unknown', semantic_role:'hypothesis_memory_not_source_evidence' },
    exchanges:[
      { id:'old-x', source_ref:'forum:old', current:true, evidence:[{ source_event_id:'old-e', text:'Old evidence', published_at:'2026-01-01T10:00:00Z', source_updated_at:'2026-01-02T10:00:00Z', observed_at:'2026-01-03T10:00:00Z' }] },
      { id:'new-x', source_ref:'forum:new', current:false, reasons:[hostile], evidence:[{ source_event_id:'new-e', text:hostile, published_at:'2026-02-01T10:00:00Z', source_updated_at:'2026-02-02T10:00:00Z', observed_at:'2026-02-03T10:00:00Z' }] }
    ], scope:{ selection:'bounded', revision:3 }, model_enabled:modelEnabled, coverage:{ selection:'bounded', batch_exchanges:12, source_capacity:4, source_completeness:'unknown' },
    omissions:[{ id:'skip-x', source_ref:'forum:skip', reasons:[hostile] }], pending_assessment:null,
    contact_authorized:false, send_authorized:false };
  const api = async route => {
    reads.push(route);
    if (route.startsWith('/api/audience?')) return { items:[{ id:'g1', title:'Goal', status:'OPEN', revision:goal.revision }], enabled:true, model_enabled:currentModelEnabled };
    if (route === '/api/audience/g1') return structuredClone(goal);
    if (route === '/api/audience/needs/n1') return structuredClone(need);
    if (route === '/api/audience/assessments/as-old') return structuredClone(oldAssessment);
    if (route === '/api/audience/needs/n1/context') return structuredClone(context);
    if (route === '/api/audience/assessments/as-focused') return structuredClone(focused);
    assert.fail(`Unexpected API read ${route}`);
  };
  const view = createAudienceView({ api, command:async (action,payload) => {
    calls.push({ action, payload });
    if (action === 'audience.reassess') {
      focused = { id:'as-focused', goal_id:'g1', status:assessmentStatus, current:true, basis_fingerprint:'context-fp',
        packet:{ reassessment:{ version:1, need_id:'n1', need_revision:4, need_basis_fingerprint:'basis-old', context_fingerprint:'context-fp' }, exchanges:[] },
        output:emptyOutput ? { needs:[] } : null };
      goal.assessments = [{ id:'as-focused', status:assessmentStatus, reassessment:{ version:1, need_id:'n1', need_revision:4, need_basis_fingerprint:'basis-old', context_fingerprint:'context-fp' } }];
      return { assessment_id:'as-focused' };
    }
    return {};
  }, esc,
    panel:(title,body,action='') => `<section><h2>${esc(title)}</h2>${body}${action}</section>`,
    button:(title,action,id='') => `<button data-do="${esc(action)}" data-id="${esc(id)}">${esc(title)}</button>`,
    empty:(title,body='') => `<p>${esc(title)} ${esc(body)}</p>`,
    field:(name,title) => `<div data-field="${esc(name)}">${esc(title)}</div>`, modal:() => {}, refresh:() => {}, notify:() => {} });
  return { view, calls, reads, context, need, goal, setModelEnabled:value=>{currentModelEnabled=value;}, setContext:value=>Object.assign(context,value) };
}

test('context loads lazily, stays read-only when models are disabled, and shows escaped old/new evidence with distinct clocks', async () => {
  const h = harness({ modelEnabled:false });
  await h.view.load(); await h.view.act('audience-goal','g1'); await h.view.act('audience-need','n1');
  assert.ok(!h.reads.some(route => route.endsWith('/context')), 'ordinary selection must not load the context endpoint');
  assert.match(h.view.render(), /Пересмотреть с новым контекстом/);
  await h.view.act('audience-reassessment-context','n1');
  const html = h.view.render();
  assert.ok(h.reads.includes('/api/audience/needs/n1/context'));
  assert.match(html,/Историческое основание/); assert.match(html,/Новый контекст/);
  assert.match(html,/опубликовано/); assert.match(html,/источник изменён/); assert.match(html,/наблюдалось/);
  assert.match(html,/Ограниченный охват/); assert.match(html,/не доказывает полноту|не подтверждает полноту/);
  assert.match(html,/Модельные вызовы выключены/); assert.doesNotMatch(html,/data-do="audience-reassess"/);
  assert.ok(html.includes('&lt;img')); assert.equal(html.includes(hostile),false);
  await assert.rejects(h.view.act('audience-reassess','n1'),/Пересмотр недоступен/);
  assert.deepEqual(h.calls,[], 'loading context cannot approve, activate, or contact anyone');
});

test('enabled focused reassessment carries versioned context guards and remains a captured, non-authorizing assessment', async () => {
  const h = harness({ modelEnabled:true, assessmentStatus:'captured', emptyOutput:true });
  await h.view.load(); await h.view.act('audience-goal','g1'); await h.view.act('audience-need','n1');
  await h.view.act('audience-reassessment-context','n1');
  await h.view.act('audience-reassess','n1');
  assert.deepEqual(h.calls,[{ action:'audience.reassess', payload:{ need_id:'n1', expected_revision:4,
    expected_basis_fingerprint:'basis-old', expected_context_fingerprint:'context-fp' } }]);
  const html = h.view.render();
  assert.match(html,/Пересмотр гипотезы/); assert.match(html,/captured|Собрано/);
  assert.match(html,/Новая интерпретация не предложена; прежняя находка не признана решённой/);
  assert.match(html,/Отменить пересмотр/); assert.doesNotMatch(html,/Принять гипотезу/);
  assert.ok(!h.calls.some(call => ['audience.review','audience.open_work','audience.refresh_work'].includes(call.action)));
});

test('focused captured or running reassessment cancels against its frozen context basis, distinct from the need basis', async () => {
  for (const status of ['captured','running']) {
    const h = harness({ modelEnabled:true, assessmentStatus:status });
    await h.view.load(); await h.view.act('audience-goal','g1'); await h.view.act('audience-need','n1');
    await h.view.act('audience-reassessment-context','n1'); await h.view.act('audience-reassess','n1');
    await h.view.act('audience-cancel-reassessment','as-focused');
    assert.deepEqual(h.calls.at(-1),{ action:'audience.cancel_reassessment', payload:{ assessment_id:'as-focused', expected_basis_fingerprint:'context-fp' } });
  }
});

test('refreshing a changed need or model setting invalidates the previously loaded context', async () => {
  const h = harness({ modelEnabled:true });
  await h.view.load(); await h.view.act('audience-goal','g1'); await h.view.act('audience-need','n1');
  await h.view.act('audience-reassessment-context','n1');
  assert.match(h.view.render(),/data-do="audience-reassess"/);
  h.need.revision++;
  await h.view.load();
  let html = h.view.render();
  assert.match(html,/Пересмотреть с новым контекстом/);
  assert.doesNotMatch(html,/data-do="audience-reassess"/);

  await h.view.act('audience-reassessment-context','n1');
  h.setModelEnabled(false);
  await h.view.load();
  html = h.view.render();
  assert.match(html,/Пересмотреть с новым контекстом/);
  assert.doesNotMatch(html,/data-do="audience-reassess"/);
});

test('a context or setting change between display and submit blocks the stale request', async () => {
  const h = harness({ modelEnabled:true });
  await h.view.load(); await h.view.act('audience-goal','g1'); await h.view.act('audience-need','n1');
  await h.view.act('audience-reassessment-context','n1');
  h.setContext({ context_fingerprint:'changed-context' });
  await assert.rejects(h.view.act('audience-reassess','n1'),/изменились после просмотра/);
  assert.deepEqual(h.calls,[]);
  assert.match(h.view.render(),/changed-context/);
});
