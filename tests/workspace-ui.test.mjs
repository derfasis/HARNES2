import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start } from '../business/server.mjs';
import { ROOT, readJson } from '../business/config.mjs';
import { id } from '../business/store.mjs';
import { createWorkspaceView } from '../public/workspace.js';

const hostile = '<img src=x onerror="execute()">';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function harness({ enabled = true } = {}) {
  const calls = [], dialogs = [];
  const source = { id:'source-1', title:'Owner note', kind:'owner_note', content:hostile };
  const continuity = { id:'thread-1',memory:{current:true,epistemic_status:'unverified_interpretation',content:{summary:{text:'Owner reviewed interpretation.'}}},
    evidence:[{source_ref:'source-1',source_event_id:'event-2',text:hostile}],memory_evidence:[] };
  const detail = { id:'case-1', thread_id:'thread-1', title:'Prepare launch plan', status:'open', revision:7,
    current:true, basis_fingerprint:'basis-abc', reason:'Owner requested a launch plan',
    material:{id:'material-1',title:'Plan',version:2,content:hostile,sha256:'sha-123',evidence_event_ids:['event-2'],status:'proposed'}, action:null, expectation:null, observations:[], next_move:'review_material',
    materials:[{id:'material-1',title:'Plan',content:hostile,sha256:'sha-123',version:2,status:'proposed'}], evidence_event_ids:['event-2','event-3'] };
  const data = { enabled, model_enabled:false, goals:[{id:'goal-1',title:'Grow carefully',objective:'Find qualified partners',success_condition:'Three qualified introductions',status:'OPEN',revision:3,basis_fingerprint:'goal-basis',ready:true,attention:{pending:true,reasons:['opened']},memory:{current:false},latest_turn:null}],
    cases:[{...detail}], source_refs:[source], control:{enabled:true,active:[],limits:{},planes:[{id:'public'},{id:'private'}],capabilities:[]} };
  const api = async route => {
    calls.push({method:'GET',route});
    if (route === '/api/workspace') return structuredClone(data);
    if (route === '/api/workspace/cases/case-1') return structuredClone(detail);
    if (route === '/api/continuity/threads/thread-1') return structuredClone(continuity);
    if (route === '/api/continuity/turns/turn-1') return {id:'turn-1',thread_id:'goal-1',status:'captured',basis_fingerprint:'goal-basis',packet:{evidence:[{source_ref:'source-1',source_event_id:'19',text:'A source statement'}],memory_evidence:[]},output:null,reviewable:false};
    assert.fail(`Unexpected read ${route}`);
  };
  const command = async (action,payload) => {
    calls.push({method:'POST',action,payload:structuredClone(payload)});
    if(action==='continuity.capture'){ data.goals[0].latest_turn={id:'turn-1',status:'captured'}; return {turn_id:'turn-1'}; }
    return action==='work.open'?{case_id:'case-1'}:{action_id:'action-1',proposal_hash:'proposal-hash'};
  };
  const modal = (title,html,submit) => dialogs.push({title,html,submit});
  const view = createWorkspaceView({ api, command, esc, modal, refresh:async()=>{}, wake:async()=>calls.push({method:'POST',route:'/api/actions/wake'}) });
  return { view, calls, dialogs, data, detail };
}

test('workspace list and case detail escape owner material and keep evidence planes distinct', async () => {
  const h = harness(); await h.view.load(); await h.view.act('workspace-case-open','case-1');
  const html = h.view.render();
  assert.match(html,/Источник|Основание/);
  assert.match(html,/Материал владельца|Материал/);
  assert.match(html,/Рассмотрение материала/);
  assert.match(html,/Разрешение владельца|выдача права|grant/i);
  assert.match(html,/квитанц|независим|публикац/i);
  assert.match(html,/data-workspace-text-slot=/); assert.equal(html.includes(hostile),false);
  const slots=[...html.matchAll(/data-workspace-text-slot="(\d+)"/g)].map(([,index])=>({dataset:{workspaceTextSlot:index},textContent:''}));
  h.view.hydrate({querySelectorAll:()=>slots});
  assert.ok(slots.some(node=>node.textContent===hostile));
  assert.deepEqual(h.calls.filter(x=>x.method==='POST'),[]);
});

test('goal creation uses only explicit owner input and allowlisted source IDs', async () => {
  const h = harness(); await h.view.load(); await h.view.act('workspace-goal-new');
  const form = h.dialogs.at(-1); assert.match(form.html,/source-1/); assert.match(form.html,/max_age_seconds/);
  await assert.rejects(()=>form.submit({title:'',objective:'',success_condition:'',source_ids:[],max_age_seconds:''}),/Укажите цель/);
  assert.equal(h.calls.filter(x=>x.method==='POST').length,0);
  await form.submit({title:'New goal',objective:'Call three retailers',success_condition:'Three replies',source_ids:['source-1'],max_age_seconds:'3600'});
  assert.deepEqual(h.calls.filter(x=>x.method==='POST').at(-1),{method:'POST',action:'work.goal',payload:{title:'New goal',objective:'Call three retailers',success_condition:'Three replies',source_ids:['source-1'],max_age_seconds:3600}});
});

test('goal can capture current evidence and submit an owner-authored proposal tied to its source', async () => {
  const h=harness(); await h.view.load();
  assert.match(h.view.render(),/Зафиксировать текущее основание/);
  await h.view.act('workspace-goal-capture','goal-1');
  assert.deepEqual(h.calls.filter(x=>x.method==='POST').at(-1),{method:'POST',action:'continuity.capture',payload:{thread_id:'goal-1',expected_revision:3,expected_basis_fingerprint:'goal-basis'}});
  await h.view.act('workspace-goal-propose','turn-1');
  const form=h.dialogs.at(-1); assert.match(form.html,/19/);
  await form.submit({summary:'The source reports a launch plan.',evidence_event_id:'19',unknowns:'Who confirmed it?',next_kind:'observe',next_reason:'Wait for an independent confirmation.',owner_question:''});
  assert.deepEqual(h.calls.filter(x=>x.method==='POST').at(-1),{method:'POST',action:'continuity.propose',payload:{turn_id:'turn-1',output:{summary:{text:'The source reports a launch plan.',evidence_event_ids:['19']},claims:[],hypotheses:[],unknowns:['Who confirmed it?'],next:{kind:'observe',reason:'Wait for an independent confirmation.',wake_at:null,owner_question:null}}}});
});

test('ready goal opens a case using its API-provided thread and exact basis', async () => {
  const h=harness(); h.data.goals[0].memory={current:true,turn_id:'accepted-turn',content:{summary:{text:'Reviewed'}}}; await h.view.load(); await h.view.act('workspace-goal-open-case','goal-1');
  assert.deepEqual(h.calls.filter(x=>x.method==='POST').at(-1),{method:'POST',action:'work.open',payload:{thread_id:'goal-1',expected_basis_fingerprint:'goal-basis',title:'Grow carefully'}});
});

test('material creation and review preserve displayed revisions and exact content hash', async () => {
  const h = harness(); await h.view.load(); await h.view.act('workspace-case-open','case-1');
  await h.view.act('workspace-material-new','case-1');
  const form=h.dialogs.at(-1); await form.submit({title:'Owner revision',content:'Exact text \n',evidence_event_id:'event-2'});
  assert.deepEqual(h.calls.filter(x=>x.method==='POST').at(-1),{method:'POST',action:'work.material',payload:{case_id:'case-1',expected_revision:7,title:'Owner revision',content:'Exact text \n',evidence_event_ids:['event-2']}});
  await h.view.act('workspace-review-open','material-1');
  const review=h.dialogs.at(-1); assert.match(review.html,/sha-123/);
  await review.submit({decision:'approve',note:'Reviewed exact version'});
  assert.deepEqual(h.calls.filter(x=>x.method==='POST').at(-1),{method:'POST',action:'work.review',payload:{case_id:'case-1',expected_revision:7,material_id:'material-1',sha256:'sha-123',decision:'approve',note:'Reviewed exact version'}});
});

test('action preparation proposes only; explicit grant and local wake remain separate', async () => {
  const h=harness(); h.detail.materials[0].status='approved'; await h.view.load(); await h.view.act('workspace-case-open','case-1');
  await h.view.act('workspace-prepare-export','case-1'); const prep=h.dialogs.at(-1);
  await prep.submit({material_id:'material-1',capability_id:'material.export_local.v1'});
  assert.deepEqual(h.calls.filter(x=>x.method==='POST').at(-1),{method:'POST',action:'work.prepare_action',payload:{case_id:'case-1',expected_revision:7,material_id:'material-1',capability_id:'material.export_local.v1'}});
  assert.equal(h.calls.some(x=>x.route==='/api/actions/wake'),false);
  assert.equal(h.calls.filter(x=>x.method==='POST').length,1);
});

test('grant is an exact separate owner decision and local wake uses the explicit action endpoint', async () => {
  const h=harness(); h.detail.action={action_id:'action-9',proposal_hash:'hash-9',revision:11,status:'proposed',can_grant:true};
  await h.view.load(); await h.view.act('workspace-case-open','case-1');
  assert.match(h.view.render(),/Выдать отдельное разрешение/);
  await h.view.act('workspace-grant','case-1');
  const form=h.dialogs.at(-1); assert.match(form.html,/hash-9/);
  await form.submit({expires_at:'2099-01-01T00:00'});
  assert.deepEqual(h.calls.filter(x=>x.method==='POST').at(-1),{method:'POST',action:'action.grant',payload:{action_id:'action-9',expected_revision:11,proposal_hash:'hash-9',expires_at:new Date('2099-01-01T00:00').toISOString()}});
  await h.view.act('workspace-wake-local');
  assert.ok(h.calls.some(x=>x.route==='/api/actions/wake'));
});

test('refresh requires a new explicit basis fingerprint and preserves the shown revision', async () => {
  const h=harness(); h.detail.current=false; h.detail.current_basis_fingerprint='basis-new';
  await h.view.load(); await h.view.act('workspace-case-open','case-1');
  assert.match(h.view.render(),/Обновить основание/);
  await h.view.act('workspace-refresh','case-1');
  assert.deepEqual(h.calls.filter(x=>x.method==='POST').at(-1),{method:'POST',action:'work.refresh',payload:{case_id:'case-1',expected_revision:7,expected_basis_fingerprint:'basis-new'}});
});

test('disabled workspace explains state and emits no commands', async () => {
  const h=harness({enabled:false}); await h.view.load();
  assert.match(h.view.render(),/выключ|недоступ/i);
  await assert.rejects(()=>h.view.act('workspace-goal-new'),/выключ|недоступ/i);
  assert.equal(h.calls.filter(x=>x.method==='POST').length,0);
});

test('real operator server serves the workspace module and authenticated goal/case snapshots', async t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'harnes2-workspace-ui-'));
  const config=readJson(path.join(ROOT,'config/default.json'));
  config.server.port=0; config.scheduler.enabled=false;
  config.continuity={enabled:true,modelEnabled:false}; config.actions={enabled:true,modelEnabled:false,maxModelRunsPerDay:5};
  config.workspace={enabled:true,modelEnabled:false}; config.controlPlane={enabled:true,maxConcurrent:3,reservationUsd:0.25};
  const source='public:workspace-ui-api'; config.opportunity.automatic=true; config.opportunity.allowedSourceRefs=[source];
  config.opportunity.activeOffer=readJson(path.join(ROOT,'benchmarks/opportunity-projection-v0/case-01.json')).active_offer;
  const app=await start({config,directory}); t.after(async()=>{await app.close();fs.rmSync(directory,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${app.server.address().port}`;
  const session=await (await fetch(`${origin}/api/session`)).json(), headers={'x-partner-token':session.token};
  const html=await fetch(origin); assert.equal(html.status,200); assert.match(await html.text(),/data-tab="workspace"/);
  const module=await fetch(`${origin}/workspace.js`); assert.equal(module.status,200); assert.match(await module.text(),/createWorkspaceView/);
  assert.equal((await fetch(`${origin}/api/workspace`)).status,403);
  const service=app.service;
  const {thread_id}=await service.command('work.goal',{title:'UI goal',objective:'Prepare a sourced answer',success_condition:'Owner reviews a local material',source_ids:[source],max_age_seconds:3600},id());
  await service.command('source.ingest',{source_id:source,source_kind:'sanitized_fixture',message_id:'ui-message-1',author_id:'author-1',display_name:null,thread_id:null,reply_to_id:null,version:1,operation:'upsert',text:'The owner source states a two hour estimate.',created_at:new Date().toISOString(),updated_at:new Date().toISOString()},id(),{kind:'channel',sourceId:source});
  service.continuity.reconcile(); let goal=service.continuity.detail(thread_id);
  const {turn_id}=await service.command('continuity.capture',{thread_id,expected_revision:goal.revision,expected_basis_fingerprint:goal.basis_fingerprint},id());
  let turn=service.continuity.turn(turn_id), eventId=turn.packet.evidence[0].source_event_id;
  await service.command('continuity.propose',{turn_id,output:{summary:{text:'The source states a two hour estimate.',evidence_event_ids:[eventId]},claims:[],hypotheses:[],unknowns:['This estimate is not independently confirmed.'],next:{kind:'observe',reason:'Wait for corroborating evidence.',wake_at:null,owner_question:null}}},id());
  await service.command('continuity.review',{turn_id,expected_basis_fingerprint:turn.basis_fingerprint,decision:'accept',note:'Reviewed the source statement.'},id());
  goal=service.continuity.detail(thread_id);
  const {case_id}=await service.command('work.open',{thread_id,expected_basis_fingerprint:goal.basis_fingerprint,title:'Prepare answer'},id());
  const snapshotResponse=await fetch(`${origin}/api/workspace`,{headers}); assert.equal(snapshotResponse.status,200);
  const snapshot=await snapshotResponse.json(); assert.equal(snapshot.goals[0].id,thread_id); assert.equal(snapshot.cases[0].id,case_id);
  assert.ok(snapshot.source_refs.includes(source)); assert.ok(Array.isArray(snapshot.control.planes));
  const detailResponse=await fetch(`${origin}/api/workspace/cases/${case_id}`,{headers}); assert.equal(detailResponse.status,200);
  const detail=await detailResponse.json(); assert.equal(detail.basis_fingerprint,goal.basis_fingerprint); assert.ok(detail.evidence_event_ids.length);
});
