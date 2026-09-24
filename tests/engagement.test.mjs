import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {BusinessService,Scheduler,contextFor,Store,id} from './helpers/engagement-harness.mjs';
import {ROOT,readJson} from '../business/config.mjs';
import {exportPartner} from '../business/export.mjs';
import {callTool} from '../business/tools.mjs';

async function harness(t,{auto=false,channel='manual'}={}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'harnes-engagement-'));
  const config=readJson(path.join(ROOT,'config/default.json'));config.engagement.enabled=auto;
  let store=new Store(directory),service=new BusinessService(store,config);
  if(channel==='telegram'){Object.assign(config.telegram,{enabled:true,liveSending:true,allowedChatIds:['123']});service.setTelegramAccount('fixture-account');}
  t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});
  const h={directory,config,get store(){return store;},get service(){return service;},
    cmd:(action,p,a,request=id())=>service.command(action,p,request,a),
    restart(){store.close();store=new Store(directory);store.recover();service=new BusinessService(store,config);},
    get e(){return service.engagement.current(h.cid);},
    async inbound(text='Скільки коштує участь?',external=id()) {const r=await h.cmd('message.record',{conversation_id:h.cid,text,external_id:external,source:'synthetic-test'});h.mid=r.message_id;return r;},
    async open(){const r=await h.cmd('engagement.open',{conversation_id:h.cid,topic:'Умови партнерства',current_need:'Стартові витрати',close_condition:'Відповідь отримана або відмова',unknowns:['Умови ринку не перевірені']});h.eid=r.engagement_id;return r;},
    async grant(purpose='reply',extra={}){return h.cmd('permission.grant',{conversation_id:h.cid,purpose,granted_by:'fixture recipient',evidence:'Synthetic explicit request for this purpose',valid_from:'2020-01-01T00:00:00Z',expires_at:'2099-01-01T00:00:00Z',...extra});},
    async decide(kind,extra={},actor){return h.cmd('decision.commit',{engagement_id:h.eid,expected_revision:service.engagement.get(h.eid).revision,kind,reason:'Synthetic reason',expected_next:'Explicit observed event',evidence:[{type:'message',id:h.mid}],...extra},actor);},
    run(){const runId=id(),task=store.get("SELECT t.* FROM tasks t JOIN engagement_tasks et ON et.task_id=t.id WHERE et.engagement_id=? AND t.status='pending' LIMIT 1",h.eid);if(task)store.run("UPDATE tasks SET status='running' WHERE id=?",task.id);const ctx=contextFor(service,h.cid,task);store.run('INSERT INTO runs(id,partner_id,task_id,conversation_id,status,runtime,model,context_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)',runId,config.partnerId,task?.id??null,h.cid,'running','fixture','fixture-model',JSON.stringify(ctx),new Date().toISOString());return {kind:'agent',runId,conversationId:h.cid};}
  };
  const person=await h.cmd('person.create',{name:'Synthetic person',source:'offline test',permission:'legacy permission is not typed consent',...(channel==='telegram'?{channel:'telegram',external_id:'123',account_id:'fixture-account'}:{})});h.cid=person.conversation_id;h.pid=person.person_id;
  await h.inbound();if(!auto)await h.open();else h.eid=h.e.id;
  return h;
}
const act={purpose:'reply',text:'Загальну модель пояснено. Я уточню умови.',explained:['Загальну модель пояснено.'],commitments:[{text:'уточню умови',owner:'HUMAN'}]};
const pending=h=>h.store.get("SELECT COUNT(*) n FROM tasks WHERE conversation_id=? AND status='pending'",h.cid).n;

test('additive migration preserves legacy state; opt-in coalesces consecutive inbound and duplicates',async t=>{
 const h=await harness(t,{auto:true});assert.equal(h.store.all('SELECT * FROM schema_migrations').length,5);
 const r=await h.inbound('Ще одне питання','same');const rev=h.e.revision;
 const d=await h.inbound('Ще одне питання','same');assert.equal(d.message_id,r.message_id);assert.equal(h.e.revision,rev);
 assert.equal(pending(h),1);assert.equal(h.store.get('SELECT COUNT(*) n FROM engagements').n,1);
 await assert.rejects(h.inbound('Інший текст','same'),{status:409});assert.deepEqual(h.store.all('PRAGMA foreign_key_check'),[]);
});

test('CLAIM is a quote, HYPOTHESIS is not fact, verified facts require operator verification',async t=>{
 const h=await harness(t);await h.inbound('Я фітнес-тренер');const actor=h.run();
 const base={engagement_id:h.eid,expected_revision:h.e.revision,evidence:[{type:'message',id:h.mid}]};
 const claim=await h.cmd('belief.record',{...base,kind:'CLAIM',text:'Я фітнес-тренер'},actor);
 await h.cmd('belief.record',{...base,kind:'HYPOTHESIS',text:'Можливо, цікавиться wellness'},actor);
 await assert.rejects(h.cmd('belief.record',{...base,kind:'CLAIM',text:'Перевірений тренер'},actor));
 await assert.rejects(h.cmd('belief.record',{...base,kind:'VERIFIED_FACT',text:'Тренер',verification:'self-confidence'},actor),{status:403});
 assert.equal(h.store.get('SELECT COUNT(*) n FROM facts').n,0);assert.equal(h.store.get('SELECT COUNT(*) n FROM contact_permissions').n,0);
 assert.equal(h.store.get('SELECT kind FROM engagement_beliefs WHERE id=?',claim.belief_id).kind,'CLAIM');
 await h.decide('WAIT',{wait_for:['operator_response']},actor);
 await assert.rejects(h.cmd('belief.record',{...base,kind:'HYPOTHESIS',text:'post-decision change'},actor));
});

test('evidence and decision scope cannot cross people',async t=>{
 const h=await harness(t);const other=await h.cmd('person.create',{name:'Other',source:'synthetic'});const m=await h.cmd('message.record',{conversation_id:other.conversation_id,text:'secret',source:'synthetic'});
 await assert.rejects(h.decide('IGNORE',{evidence:[{type:'message',id:m.message_id}]}),{code:'invalid_evidence'});
 assert.equal(h.store.get('SELECT COUNT(*) n FROM engagement_decisions').n,0);
});

test('WAIT survives restart, irrelevant inbound does not wake, matching event wakes once',async t=>{
 const h=await harness(t);const d=await h.decide('WAIT',{wait_for:['operator_response']});assert.equal(pending(h),0);
 h.restart();assert.equal(h.e.status,'WAITING');assert.equal(pending(h),0);
 h.store.transaction(()=>h.service.engagement.sweep());assert.equal(pending(h),0);
 await h.inbound('Дякую');assert.equal(pending(h),0);assert.equal(h.service.engagement.decision(d.decision_id).status,'stale');
 const request=id(),payload={engagement_id:h.eid,event:'operator_response',evidence:'Operator confirmed costs'};
 await h.cmd('engagement.wake',payload,undefined,request);await h.cmd('engagement.wake',payload,undefined,request);
 assert.equal(pending(h),1);assert.equal(h.e.status,'OPEN');
});

test('WAIT deadline and commitment deadlines are one-shot durable transitions',async t=>{
 const h=await harness(t);await h.decide('WAIT',{wake_at:'2098-01-01T00:00:00Z'});
 h.store.transaction(()=>h.service.engagement.sweep('2098-01-01T00:00:00.000Z'));assert.equal(pending(h),1);
 const rev=h.e.revision;h.restart();h.store.transaction(()=>h.service.engagement.sweep('2098-01-02T00:00:00.000Z'));assert.equal(h.e.revision,rev);assert.equal(pending(h),1);
});

test('IGNORE consumes this signal; new inbound creates attention; duplicate decision denied',async t=>{
 const h=await harness(t);await h.decide('IGNORE');assert.equal(pending(h),0);
 await assert.rejects(h.decide('IGNORE'),{code:'decision_already_current'});await h.inbound();assert.equal(pending(h),1);
});

test('ACT requires typed permission; proposed commitment and explanation are not delivered truth',async t=>{
 const h=await harness(t);await assert.rejects(h.decide('ACT',{action:act}),{code:'typed_permission_required'});
 assert.equal(h.store.get('SELECT COUNT(*) n FROM engagement_decisions').n,0);
 await h.grant();const d=await h.decide('ACT',{action:act});assert.equal(h.service.draft(d.draft_id).status,'pending');
 assert.equal(h.store.get('SELECT status FROM engagement_commitments').status,'proposed');assert.equal(h.store.get('SELECT COUNT(*) n FROM engagement_explanations').n,0);
 await assert.rejects(h.cmd('delivery.manual',{draft_id:d.draft_id,evidence:'not approved'}));
 await h.cmd('draft.approve',{draft_id:d.draft_id});await h.cmd('delivery.manual',{draft_id:d.draft_id,evidence:'Synthetic observed manual send'});
 assert.equal(h.store.get('SELECT status FROM engagement_commitments').status,'open');assert.equal(h.store.get('SELECT COUNT(*) n FROM engagement_explanations').n,1);
 assert.equal(h.service.engagement.episode(d.decision_id).actual_messages.length,1);
});

test('human edit invalidates approval and does not confirm model promises or explanations',async t=>{
 const h=await harness(t);await h.grant();const d=await h.decide('ACT',{action:act});await h.cmd('draft.approve',{draft_id:d.draft_id});
 await h.cmd('draft.edit',{draft_id:d.draft_id,text:'Нічого не обіцяю.'});await assert.rejects(h.cmd('delivery.manual',{draft_id:d.draft_id,evidence:'fixture'}));
 await h.cmd('draft.approve',{draft_id:d.draft_id});await h.cmd('delivery.manual',{draft_id:d.draft_id,evidence:'observed operator send'});
 assert.equal(h.store.get('SELECT status FROM engagement_commitments').status,'proposed');assert.equal(h.store.get('SELECT COUNT(*) n FROM engagement_explanations').n,0);
 const outcome=await h.cmd('outcome.record',{conversation_id:h.cid,kind:'call_accepted',evidence:'Recipient accepted, attendance unknown',draft_id:d.draft_id});
 const ep=h.service.engagement.episode(d.decision_id);assert.equal(ep.versions.length,2);assert.equal(ep.actual_messages[0].text,'Нічого не обіцяю.');assert.equal(ep.outcomes[0].attribution,'human_assisted');assert.equal(ep.outcomes[0].id,outcome.outcome_id);assert.equal(ep.causal_credit,'not_established');
 assert.equal(h.store.get("SELECT COUNT(*) n FROM outcome_events WHERE kind='call_attended'").n,0);
});

test('stale run after consecutive inbound cannot decide; new pending attention is coalesced',async t=>{
 const h=await harness(t);const actor=h.run();const rev=h.e.revision;await h.inbound('new');await h.inbound('newer');
 await assert.rejects(h.decide('IGNORE',{expected_revision:rev},actor),{code:'stale_engagement'});
 assert.equal(pending(h),1);assert.equal(h.store.get('SELECT COUNT(*) n FROM engagement_decisions').n,0);
});

test('permission revocation invalidates approval; new grant does not revive old decision',async t=>{
 const h=await harness(t);const g=await h.grant();const d=await h.decide('ACT',{action:act});await h.cmd('draft.approve',{draft_id:d.draft_id});
 await h.cmd('permission.revoke',{conversation_id:h.cid,permission_id:g.permission_id,evidence:'revoked'});await h.grant();
 await assert.rejects(h.cmd('delivery.manual',{draft_id:d.draft_id,evidence:'fixture'}));assert.equal(h.service.engagement.decision(d.decision_id).status,'stale');
 assert.equal(h.store.get('SELECT COUNT(*) n FROM delivery_attempts').n,0);
});

test('expiry is rechecked at execution even without an event, and reply permission is not follow-up consent',async t=>{
 const h=await harness(t);const g=await h.grant();await assert.rejects(h.decide('ACT',{action:{...act,purpose:'follow_up'}}),{code:'typed_permission_required'});
 const d=await h.decide('ACT',{action:act});await h.cmd('draft.approve',{draft_id:d.draft_id});
 h.store.run("UPDATE contact_permissions SET expires_at='2001-01-01T00:00:00.000Z' WHERE id=?",g.permission_id);
 await assert.rejects(h.cmd('delivery.manual',{draft_id:d.draft_id,evidence:'fixture'}),{code:'typed_permission_required'});
});

test('HANDOFF immediately transfers ownership, acceptance is separate, return needs operator',async t=>{
 const h=await harness(t);const d=await h.decide('HANDOFF');assert.equal(h.service.conversation(h.cid).ownership,'HUMAN_OWNED');assert.equal(h.e.status,'HUMAN');assert.equal(pending(h),0);
 h.restart();await h.inbound('new inbound during handoff');assert.equal(pending(h),0);
 await assert.rejects(h.cmd('conversation.release',{conversation_id:h.cid}));
 await assert.rejects(h.cmd('handoff.resolve',{engagement_id:h.eid,handoff_id:d.handoff_id,resolution:'return',evidence:'premature'}));
 await h.cmd('handoff.accept',{engagement_id:h.eid,handoff_id:d.handoff_id});
 await h.cmd('handoff.resolve',{engagement_id:h.eid,handoff_id:d.handoff_id,resolution:'return',evidence:'Confirmed market conditions'});
 assert.equal(h.e.status,'OPEN');assert.equal(h.service.conversation(h.cid).ownership,'AI_OWNED');assert.equal(pending(h),1);
});

test('STOP dominates handoff, timers, old approval and restart; explicit resume does not revive matter',async t=>{
 const h=await harness(t);await h.grant();const d=await h.decide('ACT',{action:act});await h.cmd('draft.approve',{draft_id:d.draft_id});
 await h.inbound('Не пишіть мені');assert.equal(h.service.person(h.pid).suppressed,1);assert.equal(h.service.engagement.get(h.eid).status,'STOPPED');assert.equal(pending(h),0);
 h.restart();await assert.rejects(h.cmd('delivery.manual',{draft_id:d.draft_id,evidence:'old intent'}));assert.ok(h.store.get('SELECT revoked_at FROM contact_permissions').revoked_at);
 await h.cmd('person.resume',{conversation_id:h.cid,evidence:'new explicit consent'});await h.inbound('new');assert.equal(pending(h),0);
 await assert.rejects(h.cmd('draft.create',{conversation_id:h.cid,text:'legacy bypass'}));
});

test('ACT unknown delivery stays unknown on restart and blocks another ACT until reconciliation',async t=>{
 const h=await harness(t);await h.grant();const d=await h.decide('ACT',{action:act});await h.cmd('draft.approve',{draft_id:d.draft_id});
 h.store.run("UPDATE drafts SET status='sending' WHERE id=?",d.draft_id);
 h.store.run('INSERT INTO delivery_attempts(id,draft_id,draft_version,channel,recipient,status,created_at) VALUES(?,?,?,?,?,?,?)',id(),d.draft_id,1,'synthetic',h.cid,'sending',new Date().toISOString());
 h.restart();assert.equal(h.service.draft(d.draft_id).status,'delivery_unknown');await h.inbound();
 await assert.rejects(h.decide('ACT',{action:act}),{code:'delivery_unresolved'});assert.equal(h.store.get('SELECT COUNT(*) n FROM engagement_explanations').n,0);
 await h.cmd('delivery.reconcile',{draft_id:d.draft_id,status:'sent',evidence:'Checked external receipt',external_id:'observed-receipt'});
 assert.equal(h.service.engagement.episode(d.decision_id).actual_messages.length,1);
});

test('agent cannot grant permissions, activate learning, approve, fabricate outcomes or use direct legacy draft',async t=>{
 const h=await harness(t);const actor=h.run();
 for(const action of ['permission.grant','permission.revoke','learning.review','draft.approve','outcome.record','handoff.resolve'])await assert.rejects(h.cmd(action,{conversation_id:h.cid},actor),{status:403});
 await assert.rejects(h.cmd('draft.create',{conversation_id:h.cid,text:'bypass'},actor),{code:'decision_required'});
 await assert.rejects(h.service.command('decision.commit',{engagement_id:h.eid,expected_revision:h.e.revision,kind:'IGNORE',evidence:[{type:'message',id:h.mid}],reason:'fixture',expected_next:'none'},id(),{kind:'agent'}),{status:403});
});

test('learning requires observed episodes, preserves counterexamples and creates only operator-reviewed local strategy',async t=>{
 const h=await harness(t);const d=await h.decide('IGNORE');const o=await h.cmd('outcome.record',{conversation_id:h.cid,kind:'call_accepted',decision_id:d.decision_id,evidence:'Synthetic observed acceptance'});
 const input={engagement_id:h.eid,title:'Costs first',text:'Explain costs when asked.',applicability:'Only when explicitly asked about costs',outcome_ids:[o.outcome_id]};
 const lesson=await h.cmd('learning.propose',input);assert.equal(lesson.status,'candidate');assert.equal(h.store.get('SELECT COUNT(*) n FROM engagement_strategies').n,0);
 await assert.rejects(h.cmd('lesson.review',{lesson_id:lesson.lesson_id,status:'active'}));
 const review=await h.cmd('learning.review',{lesson_id:lesson.lesson_id,decision:'activate',evaluation:'Pilot guidance, not evidence of causal uplift',limitations:'One synthetic example; no measured general skill',counterexample_ids:[]});
 assert.equal(review.permissions_changed,false);assert.equal(h.store.get('SELECT COUNT(*) n FROM contact_permissions').n,0);assert.equal(h.store.get('SELECT version FROM engagement_strategies').version,1);
 assert.equal(contextFor(h.service,h.cid).engagement.strategies.length,1);
 await h.cmd('learning.review',{lesson_id:lesson.lesson_id,decision:'retire',evaluation:'Insufficient evidence',limitations:'Do not generalize'});assert.equal(contextFor(h.service,h.cid).engagement.strategies.length,0);
});

test('command atomicity rolls back decision, draft and receipts on invalid commitments',async t=>{
 const h=await harness(t);await h.grant();const before=h.store.get('SELECT COUNT(*) n FROM command_receipts').n;
 await assert.rejects(h.decide('ACT',{action:{...act,commitments:[{text:'invalid',owner:'EVERYONE'}]}}));
 assert.equal(h.store.get('SELECT COUNT(*) n FROM engagement_decisions').n,0);assert.equal(h.store.get('SELECT COUNT(*) n FROM drafts').n,0);assert.equal(h.store.get('SELECT COUNT(*) n FROM command_receipts').n,before);
});

test('decision kinds reject irrelevant fields instead of silently discarding them',async t=>{
 const h=await harness(t);await h.grant();
 await assert.rejects(h.decide('ACT',{action:act,wait_for:['inbound']}),/Only WAIT/);
 await assert.rejects(h.decide('IGNORE',{wait_for:['inbound']}),/Only WAIT/);
 assert.equal(h.store.get('SELECT COUNT(*) n FROM engagement_decisions').n,0);
 assert.equal(h.store.get('SELECT COUNT(*) n FROM drafts').n,0);
});

test('tool schema rejection identifies only path and keyword, never argument data',async t=>{
 const h=await harness(t),actor=h.run(),marker='sensitive-model-argument';
 const args={engagement_id:h.eid,expected_revision:h.e.revision,kind:'IGNORE',reason:'Synthetic',expected_next:'none',evidence:[{type:'message',id:h.mid}],state:{current_need:'Synthetic',unknowns:[],private_marker:marker}};
 await assert.rejects(callTool(h.service,actor,'partner_commit_decision',args,id()),error=>{
  assert.equal(error.code,'invalid_tool_arguments');
  assert.match(error.message,/\/state \(additionalProperties\)/);
  assert.doesNotMatch(error.message,/private_marker|sensitive-model-argument/);
  return true;
 });
});

test('export/import preserves new state, receipts, WAIT and references; legacy exact-prefix bundle upgrades safely',async t=>{
 const h=await harness(t);await h.decide('WAIT',{wait_for:['operator_response']});const bundle=exportPartner(h.store);const file=path.join(h.directory,'bundle.json');fs.writeFileSync(file,JSON.stringify(bundle));
 for(const legacy of [false,true]) {
  if(legacy){const {ENGAGEMENT_TABLES}=await import('../business/engagement-tables.mjs');const {hash}=await import('../business/store.mjs');for(const key of [...ENGAGEMENT_TABLES,...Object.keys(bundle.tables).filter(k=>k.startsWith('discovery_'))])delete bundle.tables[key];bundle.migrations=bundle.migrations.slice(0,2);bundle.tables_sha256=hash(JSON.stringify(bundle.tables));fs.writeFileSync(file,JSON.stringify(bundle));}
  const dest=path.join(ROOT,'exports',`engagement-test-${id()}`);t.after(()=>fs.rmSync(dest,{recursive:true,force:true}));
  const r=spawnSync(process.execPath,['scripts/import.mjs',file,dest],{cwd:ROOT,encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  const restored=new Store(path.join(dest,'data'));try{assert.deepEqual(restored.all('PRAGMA foreign_key_check'),[]);assert.equal(restored.get('SELECT COUNT(*) n FROM engagements').n,legacy?0:1);if(!legacy)assert.equal(restored.get('SELECT status FROM engagement_waits').status,'waiting');}finally{restored.close();}
 }
});

test('new engagement remains review-first even if conversation mode is AUTOPILOT',async t=>{
 const h=await harness(t);await h.grant();await h.cmd('conversation.mode',{conversation_id:h.cid,mode:'AUTOPILOT'});const actor=h.run();const d=await h.decide('ACT',{action:act},actor);
 assert.deepEqual(h.service.autopilotCandidates(actor.runId),[]);await assert.rejects(h.service.exclusive(()=>h.store.transaction(()=>h.service.approveAutopilot(d.draft_id,actor.runId))));
});

async function schedulerFixture(t,h,run) {
 const {mock}=await import('node:test');const old=fs.existsSync.bind(fs);
 const fsMock=mock.method(fs,'existsSync',p=>String(p).endsWith(path.join('.venv','bin','python'))||String(p).endsWith(path.join('.venv','Scripts','python.exe'))?true:old(p));
 const prior=process.env.PARTNER_MODEL_API_KEY;process.env.PARTNER_MODEL_API_KEY='synthetic-offline-test';
 Object.assign(h.config.runtime,{enabled:true,model:'offline-fixture',baseUrl:'https://offline.invalid',dailyBudgetUsd:null});
 t.after(()=>{fsMock.mock.restore();if(prior===undefined)delete process.env.PARTNER_MODEL_API_KEY;else process.env.PARTNER_MODEL_API_KEY=prior;});
 let count=0;const runtime={run:async(...args)=>{count++;return run(...args);},cancel(){},close(){}};
 return {scheduler:new Scheduler(h.service,runtime,{readiness:()=>({enabled:false})}),get count(){return count;}};
}

test('real Scheduler commits WAIT once; 100 idle ticks do not call runtime again',async t=>{
 const h=await harness(t);const f=await schedulerFixture(t,h,async(run,ctx)=>{
  await h.decide('WAIT',{wait_for:['operator_response']},{kind:'agent',runId:run.id,conversationId:h.cid});return {completed:true,usage:{input_tokens:1,output_tokens:1}};
 });
 await f.scheduler.tick();assert.equal(f.count,1);assert.equal(h.e.status,'WAITING');
 for(let i=0;i<100;i++)await f.scheduler.tick();assert.equal(f.count,1);assert.equal(h.store.get('SELECT status FROM tasks WHERE id=(SELECT task_id FROM runs LIMIT 1)').status,'done');
});

test('Scheduler records committed HANDOFF and STOP as completed after they cancel AI work',async t=>{
 for(const terminal of ['HANDOFF','STOP']) {
  const h=await harness(t);const f=await schedulerFixture(t,h,async run=>{
   await h.decide(terminal,{}, {kind:'agent',runId:run.id,conversationId:h.cid});
   return {completed:true,usage:{input_tokens:1,output_tokens:1}};
  });
  await f.scheduler.tick();
  assert.equal(f.count,1);
  assert.equal(h.store.get('SELECT status FROM runs').status,'completed');
  assert.equal(h.store.get('SELECT status FROM tasks WHERE id=(SELECT task_id FROM runs)').status,'done');
  if(terminal==='HANDOFF')assert.equal(h.service.conversation(h.cid).ownership,'HUMAN_OWNED');
  else assert.equal(h.service.person(h.pid).suppressed,1);
 }
});

test('Scheduler refuses success without a durable decision and does not spin on failure',async t=>{
 const h=await harness(t);const f=await schedulerFixture(t,h,async()=>({completed:true}));await f.scheduler.tick();
 assert.equal(h.store.get('SELECT error FROM runs').error,'ENGAGEMENT_DECISION_MISSING');
 for(let i=0;i<10;i++)await f.scheduler.tick();assert.equal(f.count,1);
});

test('inbound during runtime cancels old context; next tick sees combined messages',async t=>{
 const h=await harness(t);let first=true;
 const f=await schedulerFixture(t,h,async(run,ctx)=>{
  const actor={kind:'agent',runId:run.id,conversationId:h.cid};
  if(first){first=false;await h.inbound('Друге повідомлення');await h.inbound('Третє повідомлення');await assert.rejects(h.decide('IGNORE',{expected_revision:ctx.engagement.revision},actor));}
  else {assert.equal(ctx.messages.length,3);await h.decide('IGNORE',{},actor);}
  return {completed:true};
 });await f.scheduler.tick();assert.equal(pending(h),1);await f.scheduler.tick();assert.equal(f.count,2);assert.equal(pending(h),0);
});

test('restart of interrupted computation requires explicit retry, not invisible replay',async t=>{
 const h=await harness(t);const actor=h.run();h.restart();const task=h.store.get('SELECT * FROM tasks WHERE id=(SELECT task_id FROM runs WHERE id=?)',actor.runId);
 assert.equal(task.status,'interrupted');assert.equal(pending(h),0);await h.cmd('task.retry',{task_id:task.id});assert.equal(pending(h),1);
});

test('crash after committed WAIT cannot be retried as a new decision',async t=>{
 const h=await harness(t);const actor=h.run();await h.decide('WAIT',{wait_for:['operator_response']},actor);h.restart();
 const task=h.store.get('SELECT * FROM tasks WHERE id=(SELECT task_id FROM runs WHERE id=?)',actor.runId);
 await assert.rejects(h.cmd('task.retry',{task_id:task.id}),{status:409});assert.equal(pending(h),0);
});

test('STOP decision is recorded as agent choice, never forged as operator authority',async t=>{
 const h=await harness(t);const actor=h.run();const d=await h.decide('STOP',{},actor);assert.equal(d.stopped,true);assert.equal(h.service.person(h.pid).suppressed,1);
 assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='person.stop' AND actor='operator'").n,0);
 assert.equal(h.store.get("SELECT actor FROM events WHERE kind='decision.commit'").actor,'agent');
});

test('operator takeover suppresses pending work; explicit release creates one attention task',async t=>{
 const h=await harness(t);await h.cmd('conversation.takeover',{conversation_id:h.cid});assert.equal(h.e.status,'HUMAN');assert.equal(pending(h),0);
 await h.inbound('for operator');assert.equal(pending(h),0);await h.cmd('conversation.release',{conversation_id:h.cid});assert.equal(h.e.status,'OPEN');assert.equal(pending(h),1);
});

test('expired belief blocks sending without scheduler and sweep invalidates it once',async t=>{
 const h=await harness(t);await h.grant();const actor=h.run();
 const b=await h.cmd('belief.record',{engagement_id:h.eid,expected_revision:h.e.revision,kind:'HYPOTHESIS',text:'Question concerns costs',evidence:[{type:'message',id:h.mid}],expires_at:'2098-01-01T00:00:00Z'},actor);
 const d=await h.decide('ACT',{action:act},actor);await h.cmd('draft.approve',{draft_id:d.draft_id});
 h.store.transaction(()=>h.service.engagement.sweep('2098-01-02T00:00:00.000Z'));assert.equal(h.store.get('SELECT status FROM engagement_beliefs WHERE id=?',b.belief_id).status,'stale');await assert.rejects(h.cmd('delivery.manual',{draft_id:d.draft_id,evidence:'fixture'}));
 const rev=h.e.revision;h.store.transaction(()=>h.service.engagement.sweep('2098-01-03T00:00:00.000Z'));assert.equal(h.e.revision,rev);
});

test('source fact rejection makes dependent belief and decision stale',async t=>{
 const h=await harness(t);const f=await h.cmd('fact.create',{conversation_id:h.cid,text:'Operator assertion',source_ref:'synthetic source'});
 const a=h.run();const b=await h.cmd('belief.record',{engagement_id:h.eid,expected_revision:h.e.revision,kind:'HYPOTHESIS',text:'Conditional interpretation',evidence:[{type:'fact',id:f.fact_id}]},a);const d=await h.decide('IGNORE',{},a);
 await h.cmd('fact.review',{fact_id:f.fact_id,status:'rejected'});assert.equal(h.store.get('SELECT status FROM engagement_beliefs WHERE id=?',b.belief_id).status,'stale');assert.equal(h.service.engagement.decision(d.decision_id).status,'stale');
});

test('proposed text cannot smuggle an undelivered explanation or promise into memory',async t=>{
 const h=await harness(t);await h.grant();await assert.rejects(h.decide('ACT',{action:{purpose:'reply',text:'Hello',explained:['I verified the price']}}));await assert.rejects(h.decide('ACT',{action:{purpose:'reply',text:'Hello',commitments:[{text:'I will return',owner:'AI'}]}}));
 assert.equal(h.store.get('SELECT COUNT(*) n FROM engagement_decisions').n,0);
});

test('duplicate decision receipt is idempotent across restart, altered payload is rejected',async t=>{
 const h=await harness(t);const request=id(),p={engagement_id:h.eid,expected_revision:h.e.revision,kind:'IGNORE',reason:'fixture',expected_next:'nothing',evidence:[{type:'message',id:h.mid}]};
 const d=await h.cmd('decision.commit',p,undefined,request);h.restart();assert.deepEqual(await h.cmd('decision.commit',p,undefined,request),d);await assert.rejects(h.cmd('decision.commit',{...p,reason:'changed'},undefined,request));assert.equal(h.store.get('SELECT COUNT(*) n FROM engagement_decisions').n,1);
});

test('learning counterexamples and replacement strategy versions preserve full review history',async t=>{
 const h=await harness(t);const d=await h.decide('IGNORE');const o1=await h.cmd('outcome.record',{conversation_id:h.cid,kind:'call_accepted',decision_id:d.decision_id,evidence:'acceptance'});const o2=await h.cmd('outcome.record',{conversation_id:h.cid,kind:'no_show',decision_id:d.decision_id,evidence:'observed absence, not assumed'});
 const l=await h.cmd('learning.propose',{engagement_id:h.eid,title:'Candidate',text:'Conditional approach',applicability:'This context only',outcome_ids:[o1.outcome_id]});
 await h.cmd('learning.review',{lesson_id:l.lesson_id,decision:'activate',evaluation:'Limited pilot',limitations:'Not validated generally',counterexample_ids:[o2.outcome_id]});
 await h.cmd('learning.review',{lesson_id:l.lesson_id,decision:'activate',evaluation:'Second review',limitations:'Still local, still uncertain'});
 const versions=h.store.all('SELECT version,status FROM engagement_strategies ORDER BY version');assert.deepEqual(versions.map(v=>[v.version,v.status]),[[1,'retired'],[2,'active']]);assert.equal(h.store.get("SELECT COUNT(*) n FROM learning_episodes WHERE role='counterexample'").n,1);
});

test('one complete persistent-partner episode: claim, ACT, actual send, restart, WAIT, handoff, outcome, lesson',async t=>{
 const h=await harness(t);await h.inbound('Я фітнес-тренер. Хочу зрозуміти витрати.');await h.grant();const a=h.run();
 await h.cmd('belief.record',{engagement_id:h.eid,expected_revision:h.e.revision,kind:'CLAIM',text:'Я фітнес-тренер',evidence:[{type:'message',id:h.mid}]},a);
 const d=await h.decide('ACT',{action:act,state:{current_need:'Потрібні підтверджені стартові витрати',unknowns:['Ринкові умови']}},a);
 await h.cmd('draft.approve',{draft_id:d.draft_id});await h.cmd('delivery.manual',{draft_id:d.draft_id,evidence:'Synthetic actual receipt'});h.restart();
 assert.equal(h.e.current_need,'Потрібні підтверджені стартові витрати');assert.equal(h.service.engagement.snapshot(h.eid).explained.length,1);
 await h.decide('WAIT',{wait_for:['operator_response']});h.restart();assert.equal(h.e.status,'WAITING');assert.equal(pending(h),0);
 await h.cmd('engagement.wake',{engagement_id:h.eid,event:'operator_response',evidence:'Operator must resolve individual conditions'});const handoff=await h.decide('HANDOFF');h.restart();
 await h.cmd('handoff.accept',{engagement_id:h.eid,handoff_id:handoff.handoff_id});
 await h.inbound('Можемо поговорити з оператором');assert.equal(pending(h),0);
 const o=await h.cmd('outcome.record',{conversation_id:h.cid,kind:'call_attended',decision_id:handoff.decision_id,evidence:'Operator actually attended synthetic call'});
 const l=await h.cmd('learning.propose',{engagement_id:h.eid,title:'Explain known structure before handoff',text:'Consider this approach when exact local costs need confirmation',applicability:'Explicit cost questions',outcome_ids:[o.outcome_id]});
 assert.equal(h.store.get('SELECT status FROM lessons WHERE id=?',l.lesson_id).status,'candidate');assert.equal(h.store.get('SELECT COUNT(*) n FROM engagement_strategies').n,0);
 await h.cmd('learning.review',{lesson_id:l.lesson_id,decision:'activate',evaluation:'Manually reviewed local pilot guidance',limitations:'One synthetic episode cannot establish effectiveness'});
 await h.cmd('handoff.resolve',{engagement_id:h.eid,handoff_id:handoff.handoff_id,resolution:'return',evidence:'Question answered; user may ask another question'});
 assert.equal(contextFor(h.service,h.cid).engagement.strategies.length,1);assert.equal(h.service.engagement.episode(handoff.decision_id).outcomes[0].kind,'call_attended');assert.deepEqual(h.store.all('PRAGMA foreign_key_check'),[]);
});

test('a historical engagement cannot mutate the newer active matter',async t=>{
 const h=await harness(t);const old=h.eid;await h.cmd('engagement.close',{engagement_id:old,evidence:'Question resolved'});await h.open();const rev=h.e.revision;
 await assert.rejects(h.cmd('engagement.close',{engagement_id:old,evidence:'stale UI retry with different request ID'}),{status:409});assert.equal(h.e.revision,rev);assert.equal(pending(h),1);
});

test('STOP revokes typed grants even when the previous engagement was already closed',async t=>{
 const h=await harness(t);await h.grant();await h.cmd('engagement.close',{engagement_id:h.eid,evidence:'Resolved'});await h.cmd('person.stop',{conversation_id:h.cid});assert.ok(h.store.get('SELECT revoked_at FROM contact_permissions').revoked_at);
});

test('auto-enabled historical matters require an explicit new engagement instead of legacy fallback',async t=>{
 for(const terminal of ['CLOSED','STOPPED']) {
  const h=await harness(t,{auto:true});
  if(terminal==='CLOSED')await h.cmd('engagement.close',{engagement_id:h.eid,evidence:'Resolved'});
  else {await h.decide('STOP');await h.cmd('person.resume',{conversation_id:h.cid,evidence:'Synthetic explicit resume without reviving the old matter'});}
  await h.inbound(`New matter after ${terminal}`);
  assert.equal(h.service.engagement.current(h.cid),undefined);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM tasks WHERE conversation_id=? AND kind='reply' AND status='pending'",h.cid).n,0);
 }
});

test('explicit permission_changed WAIT wakes on grant; unrelated grants do not cause periodic attention',async t=>{
 const h=await harness(t);await h.decide('WAIT',{wait_for:['permission_changed']});assert.equal(pending(h),0);await h.grant();assert.equal(pending(h),1);assert.equal(h.e.status,'OPEN');
});

test('production TelegramChannel sends only approved typed ACT, records real version, never sends twice',async t=>{
 const {TelegramChannel}=await import('../business/channels/telegram.mjs');const h=await harness(t,{channel:'telegram'});await h.grant();const d=await h.decide('ACT',{action:act});
 const channel=new TelegramChannel(h.service);let calls=0;channel.api=async(method,body)=>{calls++;assert.equal(method,'sendMessage');assert.equal(body.text,act.text);return {message_id:77};};
 await assert.rejects(channel.sendApproved(d.draft_id));assert.equal(calls,0);await h.cmd('draft.approve',{draft_id:d.draft_id});
 const result=await channel.sendApproved(d.draft_id);assert.equal(result.status,'sent');assert.equal(calls,1);assert.equal(h.service.engagement.episode(d.decision_id).actual_messages[0].text,act.text);
 await assert.rejects(channel.sendApproved(d.draft_id));assert.equal(calls,1);
});

test('production TelegramChannel preserves transport uncertainty and does not blindly resend',async t=>{
 const {TelegramChannel}=await import('../business/channels/telegram.mjs');const h=await harness(t,{channel:'telegram'});await h.grant();const d=await h.decide('ACT',{action:act});await h.cmd('draft.approve',{draft_id:d.draft_id});
 const channel=new TelegramChannel(h.service);let calls=0;channel.api=async()=>{calls++;throw Object.assign(new Error('Synthetic connection loss'),{code:'telegram_unknown'});};
 const r=await channel.sendApproved(d.draft_id);assert.equal(r.status,'delivery_unknown');await assert.rejects(channel.sendApproved(d.draft_id));assert.equal(calls,1);
 assert.equal(h.service.engagement.episode(d.decision_id).actual_messages.length,0);assert.equal(h.store.get('SELECT status FROM engagement_commitments').status,'proposed');
});

test('revocation blocks production TelegramChannel before the external effect',async t=>{
 const {TelegramChannel}=await import('../business/channels/telegram.mjs');const h=await harness(t,{channel:'telegram'});const g=await h.grant();const d=await h.decide('ACT',{action:act});await h.cmd('draft.approve',{draft_id:d.draft_id});
 await h.cmd('permission.revoke',{conversation_id:h.cid,permission_id:g.permission_id,evidence:'Withdrawn before transport call'});const channel=new TelegramChannel(h.service);channel.api=async()=>{assert.fail('No external effect is allowed');};
 await assert.rejects(channel.sendApproved(d.draft_id));assert.equal(h.store.get('SELECT COUNT(*) n FROM delivery_attempts').n,0);
});

test('existing two-migration SQLite database upgrades in place without changing historical rows',async t=>{
 const {DatabaseSync}=await import('node:sqlite');const {hash}=await import('../business/store.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'harnes-upgrade-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const db=new DatabaseSync(path.join(dir,'partner.sqlite'));
 db.exec('CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
 for(const version of ['001-core.sql','002-conversation-mode.sql']){const sql=fs.readFileSync(path.join(ROOT,'business/migrations',version),'utf8');db.exec(sql);db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(version,hash(sql),'2026-09-01T00:00:00.000Z');}
 db.prepare('INSERT INTO partners VALUES(?,?,?,?,?)').run('partner-001','Old partner','Unchanged mission','1','2026-09-01T00:00:00.000Z');
 db.prepare('INSERT INTO persons(id,partner_id,name,source,permission,created_at) VALUES(?,?,?,?,?,?)').run('old-person','partner-001','Old person','historical source','legacy string','2026-09-01T00:00:00.000Z');db.close();
 const store=new Store(dir);try{assert.equal(store.all('SELECT * FROM schema_migrations').length,5);assert.equal(store.get("SELECT mission FROM partners WHERE id='partner-001'").mission,'Unchanged mission');assert.equal(store.get("SELECT permission FROM persons WHERE id='old-person'").permission,'legacy string');assert.equal(store.get('SELECT COUNT(*) n FROM contact_permissions').n,0);assert.deepEqual(store.all('PRAGMA foreign_key_check'),[]);}finally{store.close();}
});

test('delivered commitment deadline is one-shot; HUMAN obligation never queues AI work',async t=>{
 for(const owner of ['AI','HUMAN']) {
  const h=await harness(t);await h.grant();const d=await h.decide('ACT',{action:{...act,commitments:[{text:'уточню умови',owner,due_at:'2098-01-01T00:00:00Z'}]}});
  await h.cmd('draft.approve',{draft_id:d.draft_id});await h.cmd('delivery.manual',{draft_id:d.draft_id,evidence:'Synthetic delivered promise'});await h.decide('WAIT',{wait_for:['commitment_due']});h.restart();
  h.store.transaction(()=>h.service.engagement.sweep('2098-01-02T00:00:00.000Z'));assert.equal(pending(h),owner==='AI'?1:0);
  const rev=h.e.revision;assert.ok(h.store.get('SELECT due_fired_at FROM engagement_commitments').due_fired_at);assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='commitment.due'").n,1);
  h.restart();h.store.transaction(()=>h.service.engagement.sweep('2098-01-03T00:00:00.000Z'));assert.equal(h.e.revision,rev);assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='commitment.due'").n,1);
 }
});
