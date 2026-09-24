// Offline state-machine evidence, not a claim about model recognition quality.
import test,{before,after,mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Socket} from 'node:net';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {Store,id} from '../business/store.mjs';
import {BusinessService} from '../business/service.mjs';
import {ROOT,readJson} from '../business/config.mjs';
import {Scheduler} from '../business/scheduler.mjs';
import {discoveryDetail,discoveryFreshness,collectDiscovery,sweepDiscovery,discoveryContext} from '../business/discovery.mjs';
import {parseDiscoveryOutput} from '../business/discovery-projection.mjs';
import {sourceCheckpoint,digest,SOURCE_CHECKPOINT_CHANNEL,ingestSource} from '../business/source-ingestion.mjs';
import {bootstrapTelegramSource,disconnectTelegramSource,applyTelegramDifference} from '../business/sources/telegram-readonly.mjs';
import {exportPartner} from '../business/export.mjs';

let oldKey,guards;
before(()=>{
  const forbidden=()=>{throw Error('External access forbidden in Discovery regression');};
  guards=[mock.method(globalThis,'fetch',forbidden),mock.method(Socket.prototype,'connect',forbidden),mock.method(childProcess,'spawn',forbidden)];syncBuiltinESMExports();
  oldKey=process.env.PARTNER_MODEL_API_KEY;process.env.PARTNER_MODEL_API_KEY='invented-offline-test';
  const exists=fs.existsSync;mock.method(fs,'existsSync',p=>String(p).includes(`${path.sep}.venv${path.sep}`)||exists(p));
});
after(()=>{for(const g of guards)assert.equal(g.mock.callCount(),0);mock.restoreAll();syncBuiltinESMExports();if(oldKey===undefined)delete process.env.PARTNER_MODEL_API_KEY;else process.env.PARTNER_MODEL_API_KEY=oldKey;});
function answer(c,decision='WAIT') {
  const m=c.input.observations.at(-1),ref=m?{source_event_id:m.source_event_id,span:m.text,kind:'need',attribution:'author_statement'}:null;
  return {contract_version:'discovery-v1',situation_id:c.input.situation_id,revision:c.input.revision,decision,
    assessment:decision==='REVIEW'?'opportunity':decision==='STOP'?'refusal':decision==='IGNORE'?'noise':'uncertain',
    human_need:decision==='REVIEW'?'Understand the partnership':null,claims:[],
    hypothesis:ref?{text:'Possible current need; deterministic test fixture',status:decision==='REVIEW'?'supported':'working',evidence:[ref],counterevidence:[]}:null,
    unknowns:['Synthetic response does not establish model quality'],offer_fit:{status:decision==='REVIEW'?'supported':'none',reason:'Fixture',evidence:ref?[ref]:[],offer_version:c.input.offer.version},
    why_now:decision==='REVIEW'?{reason:'New question',evidence:[ref]}:null,opening:decision==='REVIEW'?{text:'Which aspect would you like to understand?',reason:'Direct continuation',evidence:[ref]}:null,
    authority:{contact_permission:false,allowed_effects:[]}};
}
function harness(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'discovery-'));
  let store=new Store(dir),config=readJson(path.join(ROOT,'config/default.json')),service=new BusinessService(store,config);
  Object.assign(config.opportunity,{automatic:true,allowedSourceRefs:['fixture:source'],activeOffer:readJson(path.join(ROOT,'benchmarks/opportunity-projection-v0/case-01.json')).active_offer});
  Object.assign(config.discovery,{enabled:true,batchSeconds:0});Object.assign(config.runtime,{model:'fixture',baseUrl:'https://invalid.example/v1',dailyBudgetUsd:null});
  let count=0,reply=c=>answer(c),scheduler;
  const runtime={decide:async(run,c)=>{count++;return {completed:true,final_response:JSON.stringify(await reply(c)),usage:{input_tokens:10,output_tokens:20},api_calls:1};},close(){},run(){throw Error('Discovery must not enter ordinary agent runtime');}};
  const build=()=>{scheduler=new Scheduler(service,runtime,{sendApproved(){throw Error('Forbidden send');},readiness(){throw Error('Forbidden Telegram access');}});};build();
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const created=new Date(Date.now()-60000).toISOString();
  return {config,get store(){return store;},get service(){return service;},get calls(){return count;},get scheduler(){return scheduler;},runtime,
    cmd:(action,p,actor={kind:'operator'},key=id())=>service.command(action,p,key,actor),
    ingest:(extra={})=>{const m={source_id:config.opportunity.allowedSourceRefs[0],source_kind:'sanitized_fixture',message_id:'m1',author_id:'author1',display_name:'Same display name',thread_id:null,reply_to_id:null,
      version:1,operation:'upsert',text:'I coach others',created_at:created,updated_at:created,...extra};
      // Internal normalized ingest fixture for checkpoint races; production wire intake is covered by Telegram suites.
      if(config.opportunity.telegramSources.length)return service.exclusive(()=>store.transaction(()=>ingestSource(service,m)));
      return service.command('source.ingest',m,id(),{kind:'channel',sourceId:m.source_id});},
    tick:()=>scheduler.tick(),respond:f=>{reply=f;},collect:()=>store.transaction(()=>collectDiscovery(service)),
    get row(){return store.get('SELECT * FROM discovery_situations ORDER BY rowid DESC LIMIT 1');},
    detail:()=>discoveryDetail(service,store.get('SELECT id FROM discovery_situations ORDER BY rowid DESC LIMIT 1').id),
    restart:()=>{store.close();store=new Store(dir);store.recover();service=new BusinessService(store,config);build();}};
}
async function positive(h) {h.respond(c=>answer(c,'REVIEW'));await h.ingest({text:'How does this partnership work?'});await h.tick();return h.detail();}
const reviewPayload=d=>({situation_id:d.id,decision_id:d.current_decision.id,expected_revision:d.revision,verdict:'approve',reason:'Operator reviewed evidence'});
async function bound(h) {
  const p=await h.cmd('person.create',{name:'Fixture',source:'Synthetic binding'});
  h.config.opportunity.authorBindings=[{source_id:h.config.opportunity.allowedSourceRefs[0],author_id:'author1',conversation_id:p.conversation_id}];
  const inbound=await h.cmd('message.record',{conversation_id:p.conversation_id,text:'Please explain the partnership',source:'synthetic'});
  return {...p,inbound_message_id:inbound.message_id};
}
const grant=(h,p)=>h.cmd('permission.grant',{conversation_id:p.conversation_id,purpose:'reply',granted_by:'fixture author',evidence:'Explicit request recorded independently',valid_from:'2020-01-01T00:00:00Z',expires_at:'2099-01-01T00:00:00Z'});

test('coalesced observations -> WAIT -> restart -> REVIEW; approval grants no permission or draft',async t=>{
  const h=harness(t);await h.ingest();await h.ingest({message_id:'m2',text:'Clients keep asking about nutrition'});await h.tick();
  assert.equal(h.calls,1);assert.equal(h.detail().observations.length,2);assert.equal(h.detail().decision,'WAIT');
  const first=h.detail().current_decision.id;h.restart();await h.tick();assert.equal(h.calls,1);
  h.respond(c=>{assert.ok(c.prior_hypothesis);return answer(c,'REVIEW');});
  await h.ingest({message_id:'m3',text:'How does this wellness partnership work?'});await h.tick();
  const d=h.detail();assert.equal(d.revision,2);assert.equal(d.decisions.length,2);assert.equal(d.decisions[1].id,first);
  const p=reviewPayload(d),key=id();const approved=await h.cmd('discovery.review',p,undefined,key);assert.deepEqual(await h.cmd('discovery.review',p,undefined,key),approved);
  for(const table of ['persons','messages','facts','drafts','contact_permissions','engagements'])assert.equal(h.store.get(`SELECT COUNT(*) n FROM ${table}`).n,0,table);
  await h.tick();assert.equal(h.calls,2);
});
test('IGNORE journal survives; profession/noise never automatically creates CRM or work',async t=>{
  const h=harness(t);h.respond(c=>answer(c,'IGNORE'));await h.ingest();await h.tick();await h.ingest({message_id:'m2',text:'Pizza after training :)'});await h.tick();
  assert.deepEqual(h.detail().decisions.map(d=>d.output.decision),['IGNORE','IGNORE']);assert.equal(h.store.get('SELECT COUNT(*) n FROM tasks').n,0);
});
test('edit/delete invalidates approval synchronously before another scheduler tick',async t=>{
  const h=harness(t),d=await positive(h);await h.cmd('discovery.review',reviewPayload(d));
  await h.ingest({version:2,text:'This was my client’s question, not mine'});
  assert.equal(discoveryFreshness(h.service,h.row).fresh,false);
  await assert.rejects(h.cmd('discovery.engage',{...reviewPayload(d),verdict:undefined,reason:undefined}),{status:409});
  await assert.rejects(h.cmd('discovery.review',reviewPayload(d)),{code:'DISCOVERY_NOT_FRESH'});
  h.respond(c=>{assert.equal(c.prior_hypothesis,null);return answer(c);});await h.tick();
  await h.ingest({version:3,operation:'delete',text:null});await h.tick();assert.equal(h.detail().observations.length,0);assert.equal(h.detail().decision,'WAIT');
});
test('old opaque picture and dependent supplemental branch do not poison an unrelated new message; required opaque ancestry blocks REVIEW',async t=>{
  const h=harness(t);await h.ingest({operation:'unsupported',text:null,unsupported:{reason:'media',fingerprint:'a'.repeat(64)}});
  await h.ingest({message_id:'m2',reply_to_id:'m1',text:'See that image'});await h.ingest({message_id:'m3',text:'Explain the partnership?'});
  h.respond(c=>{assert.deepEqual(c.input.observations.map(m=>m.message_id),['m3']);assert.equal(c.input.coverage.incomplete,false);return answer(c,'REVIEW');});await h.tick();assert.equal(h.detail().decision,'REVIEW');
  await h.ingest({message_id:'m4',reply_to_id:'m1',text:'Can you help with this picture?'});
  h.respond(c=>{assert.equal(c.input.coverage.incomplete,true);assert.throws(()=>parseDiscoveryOutput(answer(c,'REVIEW'),c),{code:'DISCOVERY_INCOMPLETE_CONTEXT'});return answer(c);});await h.tick();assert.equal(h.detail().decision,'WAIT');
});
test('missing/deleted/cyclic ancestry and truncation are explicit insufficient coverage',async t=>{
  const h=harness(t);await h.ingest({reply_to_id:'missing'});h.collect();let c=discoveryContext(h.service,h.row);assert.ok(c.input.coverage.reasons.includes('MISSING_ANCESTOR'));
  await h.ingest({message_id:'missing',reply_to_id:'m1'});h.collect();c=discoveryContext(h.service,h.row);assert.ok(c.input.coverage.reasons.includes('REPLY_CYCLE'));
  await h.ingest({message_id:'m3',text:'x'.repeat(500)});h.config.discovery.maxCharacters=100;h.collect();c=discoveryContext(h.service,h.row);assert.ok(c.input.coverage.reasons.includes('WINDOW_CAPACITY'));
});
test('output rejects forged spans, cross-author claims, old offer, authority, extra properties and ungrounded opening',async t=>{
  const h=harness(t);await h.ingest();h.collect();const c=discoveryContext(h.service,h.row);
  for(const mutate of [o=>o.hypothesis.evidence[0].span='fabrication',o=>o.offer_fit.offer_version='old',o=>o.authority.contact_permission=true,
    o=>o.send='now',o=>o.hypothesis.evidence[0].kind='background',o=>o.why_now.evidence=[],o=>o.opening.evidence=[]]) {
    const o=answer(c,'REVIEW');mutate(o);assert.throws(()=>parseDiscoveryOutput(o,c));
  }
  const other=structuredClone(c);other.input.observations[0].author_id='other';assert.throws(()=>parseDiscoveryOutput(answer(c,'REVIEW'),other),{code:'DISCOVERY_EVIDENCE_AUTHOR'});
});
test('tool-shaped model output rejected; bounded retries never create a decision',async t=>{
  const h=harness(t);await h.ingest();h.runtime.decide=async()=>({completed:true,final_response:'{}',messages:[{role:'tool',content:'x'}]});
  for(let n=0;n<4;n++){await h.tick();h.store.run("UPDATE runs SET finished_at='2001-01-01T00:00:00Z'");}
  assert.equal(h.store.get('SELECT COUNT(*) n FROM runs').n,3);assert.equal(h.store.get('SELECT COUNT(*) n FROM discovery_decisions').n,0);assert.equal(h.scheduler.lastReason,'attempt_limit');
});
test('operator-only review, config/read-only fence and budget prevent inference',async t=>{
  const h=harness(t);await h.ingest();h.config.runtime.maxRunsPerDay=0;await h.tick();assert.equal(h.calls,0);assert.equal(h.scheduler.lastReason,'budget_blocked');
  h.config.runtime.maxRunsPerDay=30;h.config.telegram.liveSending=true;await assert.rejects(h.tick(),{code:'READ_ONLY_BOUNDARY_REQUIRED'});h.config.telegram.liveSending=false;
  await assert.rejects(h.cmd('discovery.forget',{},{kind:'agent'}),{status:403});
});
async function transport(h) {
  const source='telegram:channel:100';h.config.opportunity.allowedSourceRefs=[source];h.config.opportunity.telegramSources=[{sourceId:source,accountId:'999',channelId:'100',sourceKind:'sanitized_fixture',processingBasis:'Offline test',maxLagSeconds:120}];
  await bootstrapTelegramSource(h.service,source,{pts:10,history:[]});await current(h,source);return source;
}
async function current(h,source) {const pts=sourceCheckpoint(h.service,source).pts;await applyTelegramDifference(h.service,source,{kind:'empty',account_id:'999',channel_id:'100',from_pts:pts,to_pts:pts,final:true,updates:[]});}
test('catch-up retains analyzed result across restart and finalizes after current without a second model call',async t=>{
  const h=harness(t),source=await transport(h);await h.ingest();h.respond(async c=>{await disconnectTelegramSource(h.service,source);return answer(c,'REVIEW');});
  await h.tick();assert.equal(h.scheduler.lastReason,'waiting_source');assert.equal(h.store.get('SELECT status FROM runs').status,'analyzed');
  h.restart();await h.tick();assert.equal(h.calls,1);await current(h,source);await h.tick();assert.equal(h.calls,1);assert.equal(h.detail().decision,'REVIEW');
});
test('integrity latch never finalizes; evidence change while transport is unavailable invalidates saved result first',async t=>{
  const h=harness(t),source=await transport(h);await h.ingest();h.respond(async c=>{await disconnectTelegramSource(h.service,source);return answer(c);});await h.tick();
  const checkpoint=sourceCheckpoint(h.service,source);checkpoint.phase='blocked';checkpoint.reason='INTEGRITY_RECONCILIATION_REQUIRED';
  h.store.run('UPDATE channel_offsets SET cursor=? WHERE channel=? AND account_id=?',JSON.stringify(checkpoint),SOURCE_CHECKPOINT_CHANNEL,digest([h.config.partnerId,source]));
  await h.tick();assert.equal(h.scheduler.lastReason,'integrity_blocked');assert.equal(h.calls,1);
  await h.ingest({version:2,text:'Changed evidence'});await h.tick();assert.equal(h.store.get('SELECT status FROM runs').status,'stale');assert.equal(h.store.get('SELECT COUNT(*) n FROM discovery_decisions').n,0);
});
test('forget during inference removes owned text and late result cannot resurrect it or rediscover the subject',async t=>{
  const h=harness(t);await h.ingest({text:'PRIVATE-DERIVED-TEST'});
  h.respond(async c=>{await h.cmd('discovery.forget',{situation_id:c.input.situation_id,expected_revision:c.input.revision,reason:'Erase derived case'});return answer(c);});
  await h.tick();assert.equal(h.row.status,'forgotten');const run=h.store.get('SELECT * FROM runs');assert.equal(run.status,'cancelled');assert.equal(run.result_json,null);assert.doesNotMatch(run.context_json,/PRIVATE-DERIVED-TEST/);assert.equal(run.input_tokens,10);
  await h.ingest({message_id:'m2',text:'new'});h.config.discovery.purpose.version='2';await h.tick();assert.equal(h.calls,1);assert.equal(h.store.get('SELECT COUNT(*) n FROM discovery_situations').n,1);
});
test('fixed expiry does not extend with activity; sweeper removes decision/run content while feature is disabled',async t=>{
  const h=harness(t);await positive(h);const expiry=h.row.expires_at;await h.ingest({message_id:'m2'});h.collect();assert.equal(h.row.expires_at,expiry);
  h.store.run("UPDATE discovery_situations SET expires_at='2001-01-01T00:00:00Z'");h.config.discovery.enabled=false;h.config.opportunity.automatic=false;await h.tick();
  assert.equal(h.row.status,'expired');assert.equal(h.detail().observations.length,0);assert.equal(h.store.get('SELECT input_json FROM discovery_decisions').input_json,'{}');assert.equal(h.store.get('SELECT result_json FROM runs').result_json,null);
});
test('approval + exact binding + real inbound + typed grant transfers only once to existing Engagement',async t=>{
  const h=harness(t),d=await positive(h);await h.cmd('discovery.review',reviewPayload(d));
  const p={situation_id:d.id,decision_id:d.current_decision.id,expected_revision:d.revision,inbound_message_id:'missing',permission_id:'missing'};
  await assert.rejects(h.cmd('discovery.engage',p),{code:'DISCOVERY_BINDING_REQUIRED'});
  const b=await bound(h);p.inbound_message_id=b.inbound_message_id;await assert.rejects(h.cmd('discovery.engage',p),{code:'DISCOVERY_REPLY_PERMISSION_REQUIRED'});
  const g=await grant(h,b);p.permission_id=g.permission_id;const result=await h.cmd('discovery.engage',p);
  assert.equal(result.status,'transferred');assert.equal(h.store.get('SELECT COUNT(*) n FROM engagements').n,1);assert.equal(h.store.get('SELECT COUNT(*) n FROM contact_permissions').n,1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM drafts').n,0);assert.equal(h.store.get('SELECT COUNT(*) n FROM facts').n,0);assert.equal(h.store.get('SELECT COUNT(*) n FROM engagement_beliefs').n,0);
  const engagement=h.service.engagement.get(result.engagement_id);
  const act=await h.cmd('decision.commit',{engagement_id:engagement.id,expected_revision:engagement.revision,kind:'ACT',reason:'Answer actual inbound',expected_next:'Recipient response',
    evidence:[{type:'message',id:b.inbound_message_id}],action:{purpose:'reply',text:'Here are the informational conditions.',explained:[],commitments:[]}});
  await h.cmd('draft.edit',{draft_id:act.draft_id,text:'Operator clarified the conditions.'});await h.cmd('draft.approve',{draft_id:act.draft_id});
  await h.cmd('delivery.manual',{draft_id:act.draft_id,evidence:'Synthetic observed manual delivery, no external send'});
  const outcome=await h.cmd('outcome.record',{conversation_id:b.conversation_id,kind:'declined',evidence:'Recipient clarified that format is unsuitable',draft_id:act.draft_id});
  const assessment=await h.cmd('discovery.assess',{situation_id:d.id,decision_id:d.current_decision.id,classification:'refuted',reason:'Later clarification',
    outcome_ids:[outcome.outcome_id],lesson_text:'Do not assume suitability from initial interest',limitations:'Single synthetic human-assisted case'});
  assert.equal(assessment.attribution,'human_assisted');assert.equal(assessment.causal_credit,'not_established');
  h.restart();h.config.opportunity.activeOffer.version='new-policy';await h.ingest({message_id:'m2',text:'More public discussion'});await h.tick();assert.equal(h.calls,1);
  assert.equal(h.detail().links[0].engagement_id,result.engagement_id);assert.deepEqual(h.store.all('PRAGMA foreign_key_check'),[]);
});
test('bridge rejects suppression, expired grants, foreign inbound and human ownership',async t=>{
  const h=harness(t),d=await positive(h),b=await bound(h),g=await grant(h,b);await h.cmd('discovery.review',reviewPayload(d));
  const p={situation_id:d.id,decision_id:d.current_decision.id,expected_revision:d.revision,inbound_message_id:b.inbound_message_id,permission_id:g.permission_id};
  const other=await h.cmd('person.create',{name:'Other',source:'fixture'}),message=await h.cmd('message.record',{conversation_id:other.conversation_id,text:'Other inbound',source:'fixture'});
  await assert.rejects(h.cmd('discovery.engage',{...p,inbound_message_id:message.message_id}),{code:'DISCOVERY_INBOUND_REQUIRED'});
  h.store.run("UPDATE contact_permissions SET expires_at='2001-01-01T00:00:00Z'");await assert.rejects(h.cmd('discovery.engage',p),{code:'DISCOVERY_REPLY_PERMISSION_REQUIRED'});
  await h.cmd('conversation.takeover',{conversation_id:b.conversation_id});await assert.rejects(h.cmd('discovery.engage',p),{code:'DISCOVERY_NOT_FRESH'});
  h.store.run("UPDATE conversations SET ownership='AI_OWNED' WHERE id=?",b.conversation_id);
  await h.cmd('person.stop',{conversation_id:b.conversation_id,reason:'No more contact'});await assert.rejects(h.cmd('discovery.engage',p),{code:'DISCOVERY_NOT_FRESH'});
});
test('later assessment distinguishes later need from missed earlier evidence; lessons are reviewed candidates, not runtime strategy',async t=>{
  const h=harness(t);const first=await h.ingest();await h.tick();const d=h.detail();const later=await h.ingest({message_id:'m2',text:'New need'});
  const p={situation_id:d.id,decision_id:d.current_decision.id,classification:'missed_existing_evidence',reason:'Test review',source_event_ids:[later.source_event_id],lesson_text:'TEST-LESSON',limitations:'Synthetic only'};
  await assert.rejects(h.cmd('discovery.assess',p),{code:'DISCOVERY_HINDSIGHT_EVIDENCE'});
  const result=await h.cmd('discovery.assess',{...p,classification:'later_need_only'});assert.equal(result.runtime_use,false);
  await h.cmd('discovery.lesson.review',{lesson_id:result.lesson_id,expected_revision:0,decision:'approve',evaluation:'Operator checked',limitations:'One synthetic case'});
  assert.equal(h.detail().lessons[0].status,'reviewed');assert.equal(h.store.get('SELECT COUNT(*) n FROM lessons').n,0);
  await h.cmd('discovery.assess',{...p,source_event_ids:[first.source_event_id]});
  await h.cmd('discovery.forget',{situation_id:d.id,expected_revision:d.revision,reason:'Done'});
  assert.equal(h.detail().lessons[0].text,'');assert.doesNotMatch(JSON.stringify(exportPartner(h.store).tables),/TEST-LESSON/);
});

test('bounded optional history and other-author reply context do not turn a busy author into permanent incomplete coverage',async t=>{
  const h=harness(t);h.config.discovery.maxMessages=3;
  for(let n=0;n<6;n++)await h.ingest({message_id:`m${n}`,text:`Old observation ${n}`});
  await h.ingest({message_id:'reply',author_id:'other',reply_to_id:'m5',text:'That format is not available here'});
  h.collect();const c=discoveryContext(h.service,h.store.get("SELECT * FROM discovery_situations WHERE subject_id='author1'"));
  assert.ok(c.input.observations.length<=3);assert.equal(c.input.coverage.incomplete,false);assert.ok(c.input.coverage.omitted_optional_count>0);
  assert.ok(c.input.observations.some(m=>m.author_id==='other'));assert.equal(c.input.coverage.history_complete,false);
});
test('batch deadline cannot be pushed forever by continuous new observations',async t=>{
  const h=harness(t);h.config.discovery.batchSeconds=60;await h.ingest();h.collect();const due=h.row.not_before;
  await h.ingest({message_id:'m2'});h.collect();assert.equal(h.row.not_before,due);await h.tick();assert.equal(h.calls,0);
  h.store.run("UPDATE discovery_situations SET not_before='2000-01-01T00:00:00Z'");await h.tick();assert.equal(h.calls,1);assert.equal(h.detail().observations.length,2);
});
test('STOP tombstone survives expiry and changed policy; discovery cannot reopen a refused purpose',async t=>{
  const h=harness(t);h.respond(c=>answer(c,'STOP'));await h.ingest({text:'Please do not contact me'});await h.tick();assert.equal(h.row.status,'stopped');
  h.store.run("UPDATE discovery_situations SET expires_at='2000-01-01T00:00:00Z'");await h.tick();h.config.opportunity.activeOffer.version='new';
  await h.ingest({message_id:'m2',text:'Unrelated later discussion'});await h.tick();assert.equal(h.calls,1);assert.equal(h.store.get('SELECT COUNT(*) n FROM discovery_situations').n,1);
});
test('evidence changes during inference reject the result; journal never treats superseded approval as actionable',async t=>{
  const h=harness(t);await h.ingest();h.respond(async c=>{await h.ingest({message_id:'m2'});return answer(c,'REVIEW');});await h.tick();
  assert.equal(h.store.get('SELECT status FROM runs').status,'stale');assert.equal(h.detail().current_decision,null);
  h.respond(c=>answer(c,'REVIEW'));await h.tick();assert.equal(h.detail().decision,'REVIEW');
  await h.ingest({message_id:'m3'});h.collect();assert.equal(h.detail().freshness.fresh,false);assert.ok(h.detail().freshness.reasons.includes('DISCOVERY_DECISION_STALE'));
});
