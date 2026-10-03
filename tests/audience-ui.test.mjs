import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudienceView } from '../public/audience.js';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const hostile = '<img src=x onerror="execute()">';

function harness() {
  const calls = [], reads = [], dialogs = [];
  const goal = { id:'g1', title:'Audience goal', objective:'Understand questions', status:'OPEN', revision:3,
    basis_fingerprint:'goal-basis', ready:true, backlog:true, coverage:{ selection:'bounded', source_completeness:'unknown' },
    watches:[{ source_ref:'forum:allowed', status:'active', cursor:5, head:7, health:{ current:false, reason:'SOURCE_TRANSPORT_STALE' } }],
    withheld_exchanges:[{ id:'x-withheld', source_ref:'forum:allowed', current:false, reasons:['AUDIENCE_ANCESTRY_CYCLE'], unsupported_count:2 }],
    needs:[{ id:'n1', title:'Question hypothesis', status:'accepted', revision:4 }],
    assessments:[{ id:'as1', status:'captured', producer:'operator', created_at:'2026-01-01T00:00:00Z' }] };
  const evidence = { source_event_id:'ev1', source_ref:'forum:allowed', text:'How can I begin safely?', published_at:'2026-02-01T10:00:00Z', source_updated_at:'2026-02-02T10:00:00Z', observed_at:'2026-02-03T10:00:00Z', confirmed_at:'2026-02-04T10:00:00Z' };
  let current = true;
  const need = { id:'n1', goal_id:'g1', assessment_id:'as1', title:'Question hypothesis', hypothesis:'People ask how to begin.', why_now:'A direct question appeared.', next_step:'research', reason:'One observed question.', unknowns:['Representativeness is unknown.'],
    evidence_event_ids:['ev1'], counterevidence_event_ids:[], exchange_ids:['x1'], support_quotes:[{source_event_id:'ev1',quote:evidence.text}], status:'accepted', revision:4,
    basis_fingerprint:'need-basis', current, reasons:[], epistemic_status:'unverified_interpretation', thread_id:null };
  const assessment = { id:'as1', goal_id:'g1', status:'captured', producer:'operator', current:true,
    packet:{ exchanges:[{ id:'x1', source_ref:'forum:allowed', current:true, reasons:[], evidence:[evidence] }], unknowns:['Coverage is bounded.'] }, output:null };
  const api = async route => {
    reads.push(route);
    if (route.startsWith('/api/audience?')) return { items:[{id:'g1',title:goal.title,status:goal.status,revision:goal.revision}], next_cursor:null, enabled:true, model_enabled:false, source_refs:['forum:allowed'] };
    if (route === '/api/audience/g1') return structuredClone(goal);
    if (route === '/api/audience/needs/n1') return { ...structuredClone(need), current };
    if (route === '/api/audience/assessments/as1') return structuredClone(assessment);
    assert.fail(`Unexpected API read ${route}`);
  };
  let view;
  view = createAudienceView({ api, command:async (action,payload) => { calls.push({action,payload}); return action === 'audience.propose' ? {assessment_id:'as1',need_ids:['n2']} : {thread_id:'t2',turn_id:'turn2'}; }, esc,
    panel:(title,body,action='') => `<section><h2>${esc(title)}</h2>${body}${action}</section>`,
    button:(title,action,id='') => `<button data-do="${esc(action)}" data-id="${esc(id)}">${esc(title)}</button>`, empty:(title,body='') => `<p>${esc(title)} ${esc(body)}</p>`,
    field:(name,title,type,value='') => `<div data-field="${esc(name)}" data-value="${esc(value)}">${esc(title)}</div>`,
    modal:(title,html,submit) => dialogs.push({title,html,submit}), refresh:() => view.load(), notify:() => {} });
  return {view,calls,reads,dialogs,goal,need,assessment,evidence,setCurrent:value=>{current=value;}};
}

test('source health and withheld exchanges are visible; imported reasons are escaped and reads are inert', async () => {
  const h=harness(); h.goal.withheld_exchanges[0].reasons=[hostile];
  await h.view.load(); await h.view.act('audience-goal','g1');
  const html=h.view.render();
  assert.match(html,/указатель 5, верхняя граница 7/);
  assert.match(html,/SOURCE_TRANSPORT_STALE/);
  assert.match(html,/Исключён из текущего основания/);
  assert.ok(html.includes('&lt;img'));
  assert.equal(html.includes(hostile),false);
  assert.deepEqual(h.calls,[]);
  assert.ok(h.reads.every(route=>route.startsWith('/api/')));
});

test('manual proposal cites an exact captured source fragment and includes its exchange reference', async () => {
  const h=harness(); await h.view.load(); await h.view.act('audience-goal','g1'); await h.view.act('audience-assessment','as1'); await h.view.act('audience-propose','as1');
  await h.dialogs.at(-1).submit({ title:'Starting question', hypothesis:'People need a safe starting point.', why_now:'One question is available.', next_step:'research', reason:'The source asks directly.', unknowns:'Representativeness is unknown.', evidence_0:'ev1' });
  const proposal=h.calls[0]; assert.equal(proposal.action,'audience.propose');
  assert.deepEqual(proposal.payload.output.needs[0].support_quotes,[{source_event_id:'ev1',quote:'How can I begin safely?'}]);
  assert.deepEqual(proposal.payload.output.needs[0].evidence_event_ids,['ev1']);
  assert.deepEqual(proposal.payload.output.needs[0].exchange_ids,['x1']);
  assert.deepEqual(proposal.payload.output.needs[0].counterevidence_event_ids,[]);
  assert.deepEqual(proposal.payload.output.needs[0].unknowns,['Representativeness is unknown.']);
});

test('only a current accepted hypothesis offers Continuity work, and the command carries reviewed basis', async () => {
  const h=harness(); await h.view.load(); await h.view.act('audience-goal','g1'); await h.view.act('audience-need','n1');
  assert.match(h.view.render(),/data-do="audience-open-work"/);
  h.setCurrent(false); await h.view.load();
  assert.doesNotMatch(h.view.render(),/data-do="audience-open-work"/);
  assert.deepEqual(h.calls,[]);
  h.setCurrent(true); await h.view.load(); await h.view.act('audience-open-work','n1');
  assert.equal(h.calls[0].action,'audience.open_work');
  assert.deepEqual(h.calls[0].payload,{need_id:'n1',expected_revision:4,expected_basis_fingerprint:'need-basis'});
});

test('version 2 shows complete context, distinct source clocks and escaped inert preview; only a current linked case can import', async () => {
  const h=harness();
  h.assessment.packet.exchanges.push({ id:'x2', source_ref:'forum:allowed', current:true, evidence:[
    { source_event_id:'ev2', text:hostile, published_at:'2026-02-01T10:00:00Z', source_updated_at:'2026-02-02T10:00:00Z', observed_at:'2026-02-03T10:00:00Z' }
  ] });
  Object.assign(h.need, { proposal_version:2, context_event_ids:['ev2'], context_review:[
    { exchange_id:'x1', classification:'supporting', evidence_event_ids:['ev1'], reason:'Directly states the question.' },
    { exchange_id:'x2', classification:'unrelated', evidence_event_ids:[], reason:hostile }
  ], material_preview:{ title:hostile, content:'# Exact proposal\n\n' + hostile, evidence_event_ids:['ev1'] },
  preview_sha256:'server-sha', linked_work_case:{ id:'case-1', revision:8, current:true } });
  await h.view.load(); await h.view.act('audience-goal','g1'); await h.view.act('audience-need','n1');
  await h.view.act('audience-assessment','as1');
  const assessmentHtml=h.view.render();
  assert.match(assessmentHtml,/опубликовано/); assert.match(assessmentHtml,/источник изменён/); assert.match(assessmentHtml,/наблюдалось/); assert.match(assessmentHtml,/Browser подтвердил/);
  await h.view.act('audience-need','n1');
  let html=h.view.render();
  assert.match(html,/Поддерживает/); assert.match(html,/Не относится/);
  assert.ok(html.includes('&lt;img'));
  assert.equal(html.includes(hostile),false);
  assert.match(html,/Exact proposal/); assert.match(html,/server-sha/);
  assert.match(html,/не проверен владельцем/); assert.match(html,/проверки материала в Work/);
  assert.match(html,/data-do="audience-import-preview"/);
  assert.deepEqual(h.calls,[]);
  await h.view.act('audience-import-preview','n1');
  assert.deepEqual(h.calls[0], { action:'audience.import_preview', payload:{ need_id:'n1', expected_revision:4,
    expected_basis_fingerprint:'need-basis', case_id:'case-1', expected_case_revision:8, expected_preview_sha256:'server-sha' } });

  h.calls.length=0; h.need.linked_work_case.current=false; await h.view.load();
  assert.doesNotMatch(h.view.render(),/data-do="audience-import-preview"/);
  await assert.rejects(h.view.act('audience-import-preview','n1'),/актуального связанного дела Work/);
  assert.deepEqual(h.calls,[]);
});

test('need-linked assessment loads even when it is absent from the bounded goal summary; v1 stays explicitly historical', async () => {
  const h=harness();
  h.goal.assessments=[];
  await h.view.load(); await h.view.act('audience-goal','g1'); await h.view.act('audience-need','n1');
  assert.ok(h.reads.includes('/api/audience/assessments/as1'));
  assert.match(h.view.render(),/Историческое предложение версии 1/);
  assert.match(h.view.render(),/нет зафиксированной проверки полного контекста/);
  assert.doesNotMatch(h.view.render(),/data-do="audience-import-preview"/);
});
