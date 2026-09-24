import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const attack='<img src=x onerror=alert(1)> <script>send()</script>';
const reference={source_event_id:'21',span:attack,kind:'need',attribution:'author_statement'};
const output={decision:'REVIEW',assessment:'opportunity',human_need:attack,
  claims:[{text:attack,evidence:[reference]}],hypothesis:{text:attack,status:'supported',evidence:[reference],counterevidence:[reference]},
  unknowns:[attack],offer_fit:{status:'relevant',reason:attack},why_now:{reason:attack,evidence:[reference]},
  opening:{text:attack,reason:attack,evidence:[reference]}};
const decision={id:'decision-1',revision:3,review_status:'pending',output};
const situation={id:'situation-1',source_id:attack,subject_id:attack,purpose_id:attack,status:'observing',revision:7,
  expires_at:'2026-10-01T00:00:00Z',current_decision_id:decision.id,current_decision:decision,
  assessment:'opportunity',decision:'REVIEW',availability:'current',freshness:{fresh:true,reasons:[]},
  observations:[{source_event_id:'21',message_id:'message:4',author_id:attack,version:9,text:attack,operation:'upsert',created_at:'2026-09-23T00:00:00Z',updated_at:'2026-09-23T00:00:00Z'}],
  decisions:[{...decision,created_at:'2026-09-23T00:00:00Z'}],links:[],assessments:[],lessons:[]};
function ui(detail=situation){
  const ctx=vm.createContext({Date,Map,JSON,crypto:{randomUUID:()=> 'fixture-id'}});
  vm.runInContext(source.slice(0,source.indexOf("document.addEventListener('click'"))+`
    globalThis.setup=value=>{discoveryDetail=value;state={discovery:{enabled:false,situations:[value]}};};
    globalThis.markup=discoveryReviewMarkup;globalThis.list=discovery;globalThis.action=act;
    modal=(title,content,submit)=>{globalThis.form={title,content,submit};};
    command=async(action,payload)=>{globalThis.call={action,payload};return {};};
    refresh=async()=>{};
  `,ctx);ctx.setup(detail);return ctx;
}
const plain=value=>JSON.parse(JSON.stringify(value));

test('discovery review escapes observation, hypothesis, unknowns, evidence and full journal',()=>{
  const ctx=ui(),html=ctx.markup(situation);
  assert.doesNotMatch(html,/<img|<script/);assert.match(html,/&lt;img/);
  assert.match(html,/message:4 · v9/);assert.match(html,/Event 21/);
  assert.match(html,/claims/);assert.match(html,/не установленный факт/);assert.match(html,/WHY NOW/);
  assert.match(html,/Одобрение разбора ≠ разрешение на контакт ≠ отправка/);
  assert.doesNotMatch(html,/data-do="(?:delivery-send|draft-approve|eng-permission-grant|task-approve)"/);
});

test('discovery queue exposes purpose, expiry, noncurrent state and disabled automation without executing work',()=>{
  const ctx=ui({...situation,availability:'integrity_blocked',freshness:{fresh:false,reasons:['INTEGRITY_RECONCILIATION_REQUIRED']}}),html=ctx.list();
  assert.match(html,/data-do="discovery-detail"/);assert.match(html,/проверка целостности/);
  assert.match(html,/INTEGRITY_RECONCILIATION_REQUIRED/);assert.match(html,/Автоматическое наблюдение выключено/);
  assert.doesNotMatch(html,/<img|data-do="wake"|data-do="delivery-send"/);
});

test('approval is disabled for unavailable or stale evidence and absent for terminal situations',()=>{
  const ctx=ui();
  for(const unavailable of [{availability:'waiting_source'},{availability:'integrity_blocked'},{freshness:{fresh:false,reasons:['EVIDENCE_CHANGED']}}]){
    const html=ctx.markup({...situation,...unavailable});
    assert.match(html,/data-do="discovery-approve"[^>]*disabled/);assert.doesNotMatch(html,/data-do="discovery-engage"/);
  }
  for(const status of ['expired','forgotten','engaged','handed_off','stopped'])assert.doesNotMatch(ctx.markup({...situation,status}),/data-do="discovery-(?:approve|engage)"/);
  const approved=ctx.markup({...situation,current_decision:{...decision,review_status:'approved'}});
  assert.match(approved,/data-do="discovery-engage"/);assert.doesNotMatch(approved,/data-do="discovery-approve"/);
});

test('WAIT and IGNORE remain visible decisions without fabricated opportunity or opening',()=>{
  const ctx=ui();
  for(const kind of ['WAIT','IGNORE']){
    const d={...decision,output:{...output,decision:kind,hypothesis:null,why_now:null,opening:null}};
    const html=ctx.markup({...situation,current_decision:d,decisions:[d]});
    assert.match(html,new RegExp(kind));assert.match(html,/Гипотеза не сформирована/);
    assert.match(html,/WAIT \/ IGNORE не требуют черновика/);assert.match(html,/Историческое решение/);
  }
});

test('opaque/deleted observation text cannot appear as visible textual evidence',()=>{
  const ctx=ui();
  for(const operation of ['unsupported','delete']){
    const html=ctx.markup({...situation,current_decision:null,decisions:[],observations:[{...situation.observations[0],operation,text:'SHOULD_NOT_RENDER_AS_EVIDENCE'}]});
    // Full JSON remains an explicitly marked audit package; the observation panel must omit stale text.
    const observationPanel=html.slice(html.indexOf('<h3>Наблюдения'),html.indexOf('<h3>Журнал'));
    assert.doesNotMatch(observationPanel,/SHOULD_NOT_RENDER_AS_EVIDENCE/);assert.match(observationPanel,/evidence/);
  }
});

test('review sends exact displayed situation/decision revision and no permission command',async()=>{
  const ctx=ui();await ctx.action('discovery-approve',situation.id);await ctx.form.submit({reason:'Evidence reviewed'});
  assert.equal(ctx.call.action,'discovery.review');assert.deepEqual(plain(ctx.call.payload),{situation_id:situation.id,expected_revision:7,decision_id:decision.id,verdict:'approve',reason:'Evidence reviewed'});
  assert.match(ctx.form.content,/Никакие сообщения не отправляются/);
});

test('bridge uses supplied existing IDs without granting permission or creating a draft',async()=>{
  const ctx=ui({...situation,current_decision:{...decision,review_status:'approved'}});
  await ctx.action('discovery-engage',situation.id);await ctx.form.submit({conversation_id:'c1',inbound_message_id:'m1',permission_id:'p1'});
  assert.equal(ctx.call.action,'discovery.engage');assert.deepEqual(plain(ctx.call.payload),{situation_id:situation.id,expected_revision:7,decision_id:decision.id,conversation_id:'c1',inbound_message_id:'m1',permission_id:'p1'});
  assert.match(ctx.form.content,/ID входящего сообщения/);assert.match(ctx.form.content,/ID существующего разрешения/);
});

test('later assessment retains chosen historical decision and distinguishes missed evidence from later need',async()=>{
  const ctx=ui({...situation,decisions:[{...decision,id:'old-ignore',output:{...output,decision:'IGNORE'}},decision]});
  await ctx.action('discovery-assess',situation.id);assert.match(ctx.form.content,/old-ignore/);assert.match(ctx.form.content,/later_need_only/);
  await ctx.form.submit({decision_id:'old-ignore',classification:'missed_existing_evidence',reason:'Review',source_event_ids:'21, 22',outcome_ids:'o1',lesson_text:'Candidate only',limitations:'Synthetic evidence'});
  assert.equal(ctx.call.action,'discovery.assess');assert.deepEqual(plain(ctx.call.payload.source_event_ids),['21','22']);assert.deepEqual(plain(ctx.call.payload.outcome_ids),['o1']);assert.equal(ctx.call.payload.decision_id,'old-ignore');
  assert.equal(ctx.call.payload.classification,'missed_existing_evidence');
});

test('forget and lesson review preserve optimistic versions; lesson review cannot activate runtime criteria',async()=>{
  const ctx=ui({...situation,lessons:[{id:'lesson-1',revision:2,status:'candidate',lesson_text:attack,limitations:attack}]});
  assert.doesNotMatch(ctx.markup({...situation,lessons:[{id:'lesson-1',revision:2,status:'candidate',lesson_text:attack}]}),/<img/);
  await ctx.action('discovery-forget',situation.id);await ctx.form.submit({reason:'Purpose ended'});
  assert.deepEqual(plain(ctx.call),{action:'discovery.forget',payload:{situation_id:situation.id,expected_revision:7,reason:'Purpose ended'}});
  await ctx.action('discovery-lesson-review','lesson-1');await ctx.form.submit({decision:'approve',evaluation:'Reviewed',limitations:'Small sample'});
  assert.equal(ctx.call.action,'discovery.lesson.review');assert.equal(ctx.call.payload.expected_revision,2);assert.equal(ctx.call.payload.decision,'approve');assert.match(ctx.form.content,/Критерии runtime автоматически не изменяются/);
});
