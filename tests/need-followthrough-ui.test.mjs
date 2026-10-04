import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudienceView } from '../public/audience.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g,
  c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const hostile = '<img src=x onerror="run()">';
const expires = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

function harness() {
  const goal = { id:'goal-1', title:'Private briefing', objective:'Understand current volunteer route questions',
    status:'OPEN', revision:7, needs:[{ id:'need-1', title:'Route verification', status:'stale', revision:5 }],
    assessments:[{ id:'assessment-old', status:'proposed', producer:'model' }] };
  const evidence = { source_event_id:'event-fresh', source_ref:'channel:synthetic', text:`Fresh evidence ${hostile}`,
    published_at:'2026-10-04T10:00:00.000Z', source_updated_at:'2026-10-04T10:00:00.000Z',
    observed_at:'2026-10-04T10:01:00.000Z', confirmed_at:'2026-10-04T10:01:00.000Z' };
  const need = { id:'need-1', goal_id:'goal-1', assessment_id:'assessment-old', title:'Route verification',
    hypothesis:'The owner needs a private route-verification briefing.', why_now:'A current question is unresolved.',
    next_step:'prepare_material', reason:'One fresh event asks who verifies the route.', unknowns:['The responsible role is not known.'],
    evidence_event_ids:['event-old'], counterevidence_event_ids:[], exchange_ids:['exchange-old'],
    support_quotes:[{ source_event_id:'event-old', quote:'An older synthetic source fragment.' }], status:'stale', revision:5,
    basis_fingerprint:'basis-old', current:false, reasons:['SOURCE_EVENT_EXPIRED'], epistemic_status:'unverified_interpretation' };
  const assessment = { id:'assessment-old', goal_id:'goal-1', status:'proposed', producer:'model', current:false,
    packet:{ exchanges:[{ id:'exchange-old', source_ref:'channel:synthetic', current:false,
      evidence:[{ source_event_id:'event-old', text:'An older synthetic source fragment.' }] }] }, output:null };
  const profile = { profile_id:'profile-a', label:'Bound profile', profile_hash:'profile-hash-a', state:'available',
    model:'gemini-flash', model_ready:true, available:true, reasons:[] };
  const context = { version:1, purpose:'audience_current_events_v1', need_id:'need-1', need_revision:5,
    need_basis_fingerprint:'basis-old', observation_heads:{ 'channel:synthetic':'head-9' },
    context_fingerprint:'context-hash-a', historical_memory:{ id:'memory-old', revision:4, status:'stale',
      title:`Past hypothesis ${hostile}`, hypothesis:'The route may need a named verifier.', next_step:'prepare_material',
      basis_current:false, epistemic_status:'unverified_interpretation', semantic_role:'hypothesis',
      hypothesis_truncated:false, resolution:'unknown' },
    historical_evidence:[{ source_ref:'channel:synthetic', message_id:'old-message', message_version:1,
      source_event_id:'event-old', current:false, reasons:['CONTINUITY_EVIDENCE_EXPIRED'], text:'OLD_EVIDENCE_NEVER_RENDER' }],
    exchanges:[{ id:'exchange-new', source_ref:'channel:synthetic', current:true,
      current_event_ids:['event-fresh'], structural_event_ids:['event-old-anchor'], evidence:[evidence] }],
    scope:{ version:2, purpose:'audience_current_events_v1', selection:'fresh current event versions', exchanges:[{
      id:'exchange-new', current_event_ids:['event-fresh'], structural_event_ids:['event-old-anchor'],
      fingerprint:'exchange-fingerprint-a' }] },
    available:true, reasons:[], profile_options:[profile], requests:[] };
  const reads = [], calls = [], dialogs = [];
  let responseContext = structuredClone(context);
  const api = async route => {
    reads.push(route);
    if (route === '/api/audience?limit=50') return { items:[{ id:'goal-1', title:goal.title }], enabled:true,
      model_enabled:false, next_cursor:null };
    if (route === '/api/audience/goal-1') return structuredClone(goal);
    if (route === '/api/audience/needs/need-1') return structuredClone(need);
    if (route === '/api/audience/assessments/assessment-old') return structuredClone(assessment);
    if (route === '/api/audience/needs/need-1/followup-context') return structuredClone(responseContext);
    assert.fail(`Unexpected API read ${route}`);
  };
  let view;
  view = createAudienceView({ api, command:async (action,payload) => {
    calls.push({ action,payload }); return { request_id:'request-new', assessment_id:'assessment-new', executable:false,
      contact_permission:false, allowed_effects:[] };
  }, esc,
    panel:(title,body,action='') => `<section><h2>${esc(title)}</h2>${body}${action}</section>`,
    button:(title,action,id='') => `<button data-do="${esc(action)}" data-id="${esc(id)}">${esc(title)}</button>`,
    empty:(title,body='') => `<p>${esc(title)} ${esc(body)}</p>`,
    field:(name,title,type='text',value='',options=[]) => {
      const choices = type === 'select' ? options.map(([v,label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('') : '';
      return `<label>${esc(title)}${type === 'textarea' ? `<textarea name="${esc(name)}"></textarea>` : type === 'select'
        ? `<select name="${esc(name)}">${choices}</select>` : `<input name="${esc(name)}" value="${esc(value)}">`}</label>`;
    },
    modal:(title,html,submit) => dialogs.push({ title,html,submit }), refresh:() => view.load(), notify:() => {} });
  return { view,goal,need,assessment,context,profile,reads,calls,dialogs,setContext:value=>{responseContext=structuredClone(value);} };
}

test('new-message preview uses canonical exchange and historical metadata, never old source text, and submits one explicit request', async () => {
  const h=harness();
  await h.view.load(); await h.view.act('audience-goal','goal-1'); await h.view.act('audience-need','need-1');
  assert.match(h.view.render(), /Пересмотреть с новым контекстом/);
  await h.view.act('audience-followup-context','need-1');
  let html=h.view.render();
  const panelStart=html.indexOf('<section class="context-review">');
  const panelEnd=html.indexOf('<div class="actions"><button data-do="audience-reassessment-context"',panelStart);
  const followupPanel=html.slice(panelStart,panelEnd);
  assert.ok(h.reads.includes('/api/audience/needs/need-1/followup-context'));
  assert.match(html,/Новые сообщения:<\/strong>\s*event-fresh/);
  assert.match(html,/сообщения, нужные для проверки связи: event-old-anchor/);
  assert.match(html,/сообщение old-message · версия 1 · CONTINUITY_EVIDENCE_EXPIRED/);
  assert.match(html,/Прежняя непроверенная гипотеза — это не факт и не подтверждение/);
  assert.ok(html.includes(`Past hypothesis ${esc(hostile)}`));
  assert.match(html,/The route may need a named verifier\./);
  assert.doesNotMatch(followupPanel,/assessment-old|оценка\s/i);
  assert.match(html,/профиль доступен для отдельного разбора/);
  assert.doesNotMatch(html,/lineage|evidence-bounded|upstream/i);
  assert.ok(html.includes('&lt;img src=x'));
  assert.equal(html.includes(hostile),false);
  assert.equal(followupPanel.includes('OLD_EVIDENCE_NEVER_RENDER'),false);
  assert.deepEqual(h.calls,[], 'preview loading is a read with no command or model request');
  assert.match(html,/data-do="audience-followup-request"/);

  await h.view.act('audience-followup-request','need-1');
  const modal=h.dialogs.at(-1);
  assert.match(modal.html,/один ограниченный разбор/i);
  assert.match(modal.html,/оплат|стоимост/i);
  assert.match(modal.html,/неизвестн/i);
  assert.match(modal.html,/profile-a/);
  const expiry=expires();
  await modal.submit({ model_profile_id:'profile-a', expires_at:expiry, reason:'  Reassess only from newly current evidence.  ' });
  assert.deepEqual(h.calls,[{ action:'audience.followup_request', payload:{ need_id:'need-1', expected_revision:5,
    expected_basis_fingerprint:'basis-old', expected_context_fingerprint:'context-hash-a', model_profile_id:'profile-a',
    expected_profile_hash:'profile-hash-a', expires_at:expiry, reason:'Reassess only from newly current evidence.' } }]);
});

test('follow-up confirmation refetches context and refuses changed revision, basis, context or profile hash without a command', async () => {
  const h=harness(); await h.view.load(); await h.view.act('audience-goal','goal-1'); await h.view.act('audience-need','need-1');
  await h.view.act('audience-followup-context','need-1'); await h.view.act('audience-followup-request','need-1');
  const changed=structuredClone(h.context); changed.need_revision=6; changed.need_basis_fingerprint='basis-new';
  changed.context_fingerprint='context-hash-new'; changed.profile_options[0].profile_hash='profile-hash-new';
  h.setContext(changed);
  await assert.rejects(h.dialogs.at(-1).submit({ model_profile_id:'profile-a', expires_at:expires(), reason:'Changed preview test.' }), /измен|обнов|контекст/i);
  assert.deepEqual(h.calls,[]);
});

test('unavailable context and blocked profile show reasons without offering a model request', async () => {
  const h=harness(); const unavailable=structuredClone(h.context);
  unavailable.available=false; unavailable.reasons=['FOLLOWUP_SOURCE_NOT_CURRENT'];
  unavailable.profile_options[0].model_ready=false; unavailable.profile_options[0].reasons=['MODEL_PROFILE_REVOKED'];
  h.setContext(unavailable);
  await h.view.load(); await h.view.act('audience-goal','goal-1'); await h.view.act('audience-need','need-1');
  await h.view.act('audience-followup-context','need-1');
  const html=h.view.render();
  assert.match(html,/FOLLOWUP_SOURCE_NOT_CURRENT/);
  assert.match(html,/MODEL_PROFILE_REVOKED/);
  assert.doesNotMatch(html,/data-do="audience-followup-request"/);
  assert.deepEqual(h.calls,[]);
});

test('request history revocation uses its frozen request fingerprint and never revokes an unrelated request', async () => {
  const h=harness(); const withRequest=structuredClone(h.context);
  withRequest.requests=[{ request_id:'request-existing', request_fingerprint:'request-fingerprint', need_id:'need-1',
    state:'captured', expires_at:expires(), profile_id:'profile-a', profile_hash:'profile-hash-a' },
  { request_id:'other-need-request', request_fingerprint:'other-fingerprint', need_id:'need-other', state:'captured' }];
  h.setContext(withRequest);
  await h.view.load(); await h.view.act('audience-goal','goal-1'); await h.view.act('audience-need','need-1');
  await h.view.act('audience-followup-context','need-1');
  assert.match(h.view.render(),/request-existing/);
  assert.doesNotMatch(h.view.render(),/other-need-request/);
  await h.view.act('audience-followup-revoke','request-existing');
  await h.dialogs.at(-1).submit({ reason:'The displayed one-shot request is no longer needed.' });
  assert.deepEqual(h.calls,[{ action:'audience.followup_revoke', payload:{ request_id:'request-existing',
    expected_request_fingerprint:'request-fingerprint', reason:'The displayed one-shot request is no longer needed.' } }]);
});

test('revocation recheck refuses a request that the server now binds to another need', async () => {
  const h=harness(); const withRequest=structuredClone(h.context);
  withRequest.requests=[{ request_id:'request-existing', request_fingerprint:'request-fingerprint', need_id:'need-1', state:'active' }];
  h.setContext(withRequest);
  await h.view.load(); await h.view.act('audience-goal','goal-1'); await h.view.act('audience-need','need-1');
  await h.view.act('audience-followup-context','need-1'); await h.view.act('audience-followup-revoke','request-existing');
  const rebound=structuredClone(withRequest);
  rebound.requests[0].need_id='need-other';
  h.setContext(rebound);
  await assert.rejects(h.dialogs.at(-1).submit({ reason:'Request association changed.' }), /измен|обнов/i);
  assert.deepEqual(h.calls,[]);
});
