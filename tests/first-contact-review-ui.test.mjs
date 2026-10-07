import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudienceView } from '../public/audience.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const quote = 'Where can I find the first setup step?';
const preview = 'The source asks where to find the first setup step. The answer is not verified.';

function harness() {
  const calls = [], dialogs = [];
  const evidence = { source_event_id:'ev-first', source_ref:'forum:allowed', message_id:'message-4', author_id:'author-ref-4',
    text:quote, published_at:null, source_updated_at:null, observed_at:'2026-02-03T10:00:00Z' };
  const need = { id:'need-1', goal_id:'goal-1', assessment_id:'assessment-1', title:'First setup question',
    hypothesis:'A public question asks where the first setup step is.', why_now:'A direct question is present.', next_step:'prepare_material',
    reason:'The supplied source contains a direct question.', unknowns:['Whether the question is still unresolved is unknown.'],
    evidence_event_ids:['ev-first'], counterevidence_event_ids:[], context_event_ids:[], exchange_ids:['exchange-1'],
    support_quotes:[{source_event_id:'ev-first',quote}], status:'accepted', revision:3, basis_fingerprint:'need-basis-3',
    current:true, reasons:[], epistemic_status:'unverified_interpretation',
    material_preview:{title:'Possible clarification',content:preview,evidence_event_ids:['ev-first']}, preview_sha256:'preview-sha' };
  const firstContact = { version:1, target_event_id:'ev-first', target_quote:quote, channel:'public_reply',
    help:'A short public clarification could point to the first setup step.',
    channel_reason:'The question was posted in the public discussion; private contact is unsupported.' };
  const firstContactState = { version:1, state:'pending', proposal_sha256:'a'.repeat(64),
    target:{source_ref:'forum:allowed',source_event_id:'ev-first',message_id:'message-4',author_ref:'author-ref-4'},
    review:null, fit:'unknown', executable:false, contact_permission:false, allowed_effects:[], outcome:'not_observed' };
  const goal = {id:'goal-1',title:'Audience goal',status:'OPEN',revision:2,objective:'Understand public setup questions',
    source_refs:['forum:allowed'],needs:[{id:'need-1',title:need.title,status:need.status,revision:need.revision}],assessments:[]};
  const assessment = {id:'assessment-1',goal_id:'goal-1',status:'captured',producer:'operator',current:true,
    packet:{exchanges:[{id:'exchange-1',source_ref:'forum:allowed',current:true,evidence:[evidence]}]}};
  const api = async route => {
    if (route.startsWith('/api/audience?')) return {items:[{id:'goal-1',title:goal.title,status:'OPEN'}],next_cursor:null,enabled:true,model_enabled:false,source_refs:['forum:allowed']};
    if (route === '/api/audience/goal-1') return structuredClone(goal);
    if (route === '/api/audience/needs/need-1') return structuredClone(need);
    if (route === '/api/audience/assessments/assessment-1') return structuredClone(assessment);
    assert.fail(`Unexpected API route ${route}`);
  };
  let view;
  view = createAudienceView({api, command:async (action,payload) => {calls.push({action,payload}); return {};}, esc,
    panel:(title,body) => `<section><h2>${esc(title)}</h2>${body}</section>`,
    button:(title,action,id='') => `<button data-do="${esc(action)}" data-id="${esc(id)}">${esc(title)}</button>`,
    empty:(title,body='') => `<p>${esc(title)} ${esc(body)}</p>`,
    field:(name,title,type='text') => `<label>${esc(title)}<${type==='textarea'?'textarea':'input'} name="${esc(name)}"></${type==='textarea'?'textarea':'input'}></label>`,
    modal:(title,html,submit) => dialogs.push({title,html,submit}), refresh:async()=>view.load(), notify:()=>{} });
  return {view,calls,dialogs,goal,need,assessment,evidence,firstContact,firstContactState};
}

async function openNeed(h) {
  await h.view.load(); await h.view.act('audience-goal','goal-1'); await h.view.act('audience-need','need-1');
}

test('first response is visible as a separate, inert proposal and approval submits exact review binding', async () => {
  const h=harness();
  Object.assign(h.need,{first_contact:h.firstContact,first_contact_state:h.firstContactState});
  await openNeed(h);
  let html=h.view.render();
  assert.match(html,/Возможный первый ответ · отдельное решение/);
  assert.match(html,/Публичный ответ в исходном обсуждении/);
  assert.match(html,/неизвестно/); assert.match(html,/не наблюдался/);
  assert.match(html,/Точный текст предложения/); assert.ok(html.includes(preview));
  assert.match(html,/data-do="audience-first-contact-approve"/);
  assert.match(html,/data-do="audience-first-contact-reject"/);
  assert.doesNotMatch(html,/data-do="(?:send|copy|contact|message)/i);
  assert.deepEqual(h.calls,[]);

  await h.view.act('audience-first-contact-approve','need-1');
  assert.match(h.dialogs.at(-1).title,/только текст предложения/);
  await h.dialogs.at(-1).submit({note:'Reviewed the exact proposed text and public source context.'});
  assert.deepEqual(h.calls,[{action:'audience.review_first_contact',payload:{need_id:'need-1',expected_revision:3,
    expected_basis_fingerprint:'need-basis-3',expected_proposal_sha256:'a'.repeat(64),decision:'approve',
    note:'Reviewed the exact proposed text and public source context.'}}]);
});

test('need acceptance alone does not approve first response; approval requires current accepted public reply with material', async () => {
  const h=harness(); Object.assign(h.need,{first_contact:h.firstContact,first_contact_state:h.firstContactState,status:'proposed'});
  await openNeed(h); assert.doesNotMatch(h.view.render(),/data-do="audience-first-contact-approve"/);
  assert.match(h.view.render(),/data-do="audience-first-contact-reject"/);
  h.need.status='accepted'; delete h.need.material_preview; await h.view.load();
  assert.doesNotMatch(h.view.render(),/data-do="audience-first-contact-approve"/);
  h.need.material_preview={title:'Possible clarification',content:preview,evidence_event_ids:['ev-first']};
  h.need.current=false; h.need.reasons=['SOURCE_TRANSPORT_STALE']; await h.view.load();
  assert.doesNotMatch(h.view.render(),/data-do="audience-first-contact-(?:approve|reject)"/);
  assert.deepEqual(h.calls,[]);
});

test('hold recommendation and terminal/stale metadata expose status without approval controls', async () => {
  const h=harness();
  Object.assign(h.need,{status:'proposed',next_step:'observe',material_preview:undefined,
    first_contact:{...h.firstContact,channel:'none'},first_contact_state:{...h.firstContactState,state:'not_proposed'}});
  await openNeed(h);
  assert.match(h.view.render(),/Пока не отвечать/);
  assert.match(h.view.render(),/Ответ не предложен\./);
  assert.match(h.view.render(),/A short public clarification could point to the first setup step\./);
  assert.match(h.view.render(),/private contact is unsupported/);
  assert.match(h.view.render(),/Whether the question is still unresolved is unknown\./);
  assert.doesNotMatch(h.view.render(),/data-do="audience-first-contact-approve"/);
  assert.doesNotMatch(h.view.render(),/data-do="audience-first-contact-reject"/);
  h.need.first_contact_state={...h.firstContactState,state:'stale'}; await h.view.load();
  assert.doesNotMatch(h.view.render(),/data-do="audience-first-contact-(?:approve|reject)"/);
  assert.deepEqual(h.calls,[]);
});

test('approved first-response suggestion can be explicitly withdrawn with a fresh review bound to the same proposal hash', async () => {
  const h=harness();
  Object.assign(h.need,{first_contact:h.firstContact,first_contact_state:{...h.firstContactState,state:'approved',
    review:{id:'d8a41c9b-9381-4bc0-a51d-14375ac155f1',decision:'approve',note:'Approved exact preview.',reviewed_at:'2026-02-05T10:00:00Z'}}});
  await openNeed(h);
  assert.match(h.view.render(),/Текст предложения одобрен владельцем/);
  assert.match(h.view.render(),/data-do="audience-first-contact-reject"/);
  assert.doesNotMatch(h.view.render(),/data-do="audience-first-contact-approve"/);
  await h.view.act('audience-first-contact-reject','need-1');
  assert.match(h.dialogs.at(-1).title,/Отклонить предложение первого ответа/);
  await h.dialogs.at(-1).submit({note:'Withdrawing the prior text approval after review.'});
  assert.deepEqual(h.calls,[{action:'audience.review_first_contact',payload:{need_id:'need-1',expected_revision:3,
    expected_basis_fingerprint:'need-basis-3',expected_proposal_sha256:'a'.repeat(64),decision:'reject',
    note:'Withdrawing the prior text approval after review.'}}]);
});

test('mismatched authority, target, quote, or hash fails closed and untrusted text is escaped', async () => {
  const h=harness();
  Object.assign(h.need,{first_contact:{...h.firstContact,target_quote:'different quote <script>bad()</script>'},
    first_contact_state:{...h.firstContactState,contact_permission:true}});
  await openNeed(h); let html=h.view.render();
  assert.match(html,/не прошло проверку/i);
  assert.ok(html.includes('&lt;script&gt;bad()&lt;\/script&gt;'));
  assert.doesNotMatch(html,/data-do="audience-first-contact-(?:approve|reject)"/);
  h.need.first_contact={...h.firstContact}; h.need.first_contact_state={...h.firstContactState,proposal_sha256:'wrong'};
  await h.view.load(); html=h.view.render();
  assert.match(html,/не прошло проверку/i);
  assert.doesNotMatch(html,/data-do="audience-first-contact-(?:approve|reject)"/);
  assert.deepEqual(h.calls,[]);
});

test('modal rechecks exact current proposal binding before submitting review', async () => {
  const h=harness(); Object.assign(h.need,{first_contact:h.firstContact,first_contact_state:h.firstContactState});
  await openNeed(h); await h.view.act('audience-first-contact-approve','need-1');
  h.need.revision++; await h.view.load();
  await assert.rejects(h.dialogs.at(-1).submit({note:'Review note'}),/изменились/);
  assert.deepEqual(h.calls,[]);
});
