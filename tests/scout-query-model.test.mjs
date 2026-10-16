import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeActivation } from '../business/deployment.mjs';
import { HermesAdapter } from '../business/runtime.mjs';
import { processScoutAssessment } from '../business/scout-reasoning.mjs';
import { scoutQueryOutput, scoutQueryStoredOutput } from '../business/scout-query-output.mjs';
import { digest } from '../business/source-ingestion.mjs';
import { id } from '../business/store.mjs';
import { channel, message, scoutHarness } from './scout-test-helpers.mjs';

const PROFILE_URL='https://models.example.test/v1';
const TERM='I need a supplier for physical goods';

function validIntent(){
  return {summary:'The author describes a supplier need for an existing small shop.',unknowns:[
    'The bounded query page is not complete history.','Publication wording does not establish current intent or product fit.',
  ],items:[{message_id:'906',interpretation:'The author states a physical-goods supplier need connected to a small shop.',classification:'own_business_request',
    missing_context:[],suggested_public_reply:'What type of goods are you sourcing for the shop?',current_intent:'unknown',offer_fit:'unknown',contact_permission:false}]};
}

test('query output contract requires literal included evidence, closed interpretation labels, and no tools',()=>{
  const packet={source_ref:'telegram:channel:123456789',messages:[{message_id:'1',text:'I run a small shop and need a supplier for physical goods.',
    author_ref:'author-1',reply_to:null,reply_to_source:null,missing_parent:false}]};
  const output={summary:'The author describes a physical-goods supplier need.',unknowns:['Publication intent may not reflect current intent.'],items:[{
    message_id:'1',interpretation:'The author describes a need connected to an existing shop.',classification:'own_business_request',missing_context:[],
    suggested_public_reply:null,current_intent:'unknown',offer_fit:'unknown',contact_permission:false,
  }]};
  const accepted=scoutQueryOutput({completed:true,final_response:JSON.stringify(output)},packet);
  assert.equal(accepted.output.items[0].quoted_text,packet.messages[0].text,
    'server materializes the complete supported source message as the quote');
  assert.equal(scoutQueryOutput({completed:true,final_response:JSON.stringify({...output,items:[{...output.items[0],message_id:'999'}]})},packet).reason,
    'SCOUT_QUERY_EVIDENCE_INVALID');
  assert.equal(scoutQueryOutput({completed:true,final_response:JSON.stringify({...output,items:[{...output.items[0],quoted_text:'I need a supplier'}]})},packet).reason,
    'SCOUT_QUERY_SCHEMA_INVALID');
  assert.equal(scoutQueryOutput({completed:true,final_response:JSON.stringify({...output,items:[{...output.items[0],current_intent:'yes'}]})},packet).reason,
    'SCOUT_QUERY_SCHEMA_INVALID');
  assert.equal(scoutQueryOutput({completed:true,final_response:JSON.stringify(output),tool_calls:[{name:'search'}]},packet).reason,
    'SCOUT_QUERY_TOOLS_FORBIDDEN');
  const opaqueExcluded={source_ref:packet.source_ref,messages:[]};
  assert.equal(scoutQueryOutput({completed:true,final_response:JSON.stringify(output)},opaqueExcluded).reason,'SCOUT_QUERY_EVIDENCE_INVALID');
  assert.equal(scoutQueryOutput({completed:true,final_response:JSON.stringify({...output,items:[...output.items,output.items[0]]})},packet).reason,
    'SCOUT_QUERY_EVIDENCE_INVALID');
});

const PRIVATE_SCHEMA_SENTINEL='private-query-schema-sentinel';
for(const testCase of [
  {keyword:'additionalProperties',name:'additional properties',mutate:output=>({...output,private_field:PRIVATE_SCHEMA_SENTINEL})},
  {keyword:'required',name:'required fields',mutate:output=>{const{summary,...rest}=output;return rest;}},
  {keyword:'enum',name:'enum values',mutate:output=>({...output,items:output.items.map(item=>({...item,classification:PRIVATE_SCHEMA_SENTINEL}))})},
  {keyword:'const',name:'constant values',mutate:output=>({...output,items:output.items.map(item=>({...item,current_intent:PRIVATE_SCHEMA_SENTINEL}))})},
])test(`query schema diagnostic safely reports ${testCase.keyword}`,()=>{
  const packet={source_ref:'telegram:channel:123456789',messages:[{message_id:'906',text:'I run a small shop and need a supplier. ',
    author_ref:'author-1',reply_to:null,reply_to_source:null,missing_parent:false}]};
  const result=scoutQueryOutput({completed:true,final_response:JSON.stringify(testCase.mutate(validIntent()))},packet);
  assert.equal(result.reason,'SCOUT_QUERY_SCHEMA_INVALID');
  assert.deepEqual(result.diagnostic,{stage:'schema',code:'SCOUT_SCHEMA_INVALID',schema_keywords:[testCase.keyword]});
  assert.equal(JSON.stringify(result.diagnostic).includes(PRIVATE_SCHEMA_SENTINEL),false);
});

async function prepared(t){
  const oldKey=process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY='offline-query-intent-sentinel';
  t.after(()=>oldKey===undefined?delete process.env.PARTNER_MODEL_API_KEY:process.env.PARTNER_MODEL_API_KEY=oldKey);
  const h=scoutHarness(t,{
    resolve:async()=>channel({channel_id:'1134567891',kind:'group'}),
    history:async()=>{throw new Error('query assessment must not acquire history');},
    messageSearch:async({limit})=>({messages:[message('906',{author_ref:'author-self',date:new Date(Date.now()-60000).toISOString(),
      text:'I run a small shop and need a supplier for physical goods.'})],requested_count:limit,received_count:1,omitted_count:0,
      truncated:false,selection_kind:'message_query_v1',exhaustive:false}),
  });
  Object.assign(h.config.runtime,{enabled:false,model:'',baseUrl:'',dailyBudgetUsd:5});
  h.config.modelProfiles={allowedBaseUrls:[PROFILE_URL]};
  h.config.scout.modelEnabled=false;
  h.config.opportunity.automatic=false;
  h.service.deployment=new RuntimeActivation({id:id(),label:'Offline query assessment',mode:'scoped_reasoning',
    expires_at:new Date(Date.now()+3600000).toISOString()});
  const campaign=await h.campaign(TERM),grant=await h.authorize(campaign);
  await h.command('scout.register',{campaign_id:campaign.id,revision:campaign.revision,reference:'@sample_channel'});
  await h.runtime.tick();
  const candidate=h.store.get('SELECT * FROM scout_candidates WHERE campaign_id=? AND username=?',campaign.id,'sample_channel');
  const queued=await h.command('scout.query_messages',{campaign_id:campaign.id,revision:campaign.revision,candidate_ids:[candidate.id],
    queries:[TERM],window_days:30,limit:5});
  await h.runtime.tick();
  const presentation=h.service.scout.queries.presentation(h.service.scout.campaign(campaign.id));
  const receipt=presentation.flatMap(request=>request.receipts).find(row=>row.current);
  assert.ok(receipt,'fixture acquired one current message-query receipt');
  const profile=await h.command('model.profile_create',{label:'Offline query profile',provider:'custom',api_mode:'chat_completions',
    base_url:PROFILE_URL,model:'offline-query-model',max_output_tokens:900,input_usd_per_million:2,output_usd_per_million:3});
  const request={campaign_id:campaign.id,revision:campaign.revision,receipt_id:receipt.id,expected_receipt_digest:receipt.digest,
    model_profile_id:profile.profile_id,expected_model_profile_hash:profile.definition_hash,
    expires_at:new Date(Date.now()+5*60000).toISOString(),purpose:'One offline interpretation of this exact message receipt.'};
  return {h,campaign,grant,candidate,queued,receipt,profile,request};
}

async function request(x,overrides={}){
  return x.h.command('scout.request_query_assessment',{...x.request,...overrides});
}

test('query interpretation requires a separate exact version-2 scoped model request',async t=>{
  const x=await prepared(t);
  await assert.rejects(request(x,{expected_receipt_digest:'0'.repeat(64)}),{code:'SCOUT_QUERY_STALE'});
  const created=await request(x);
  const row=x.h.store.get('SELECT * FROM scout_model_requests WHERE id=?',created.request_id);
  const definition=JSON.parse(row.definition_json),job=x.h.store.get('SELECT * FROM scout_jobs WHERE id=?',created.job_id);
  assert.equal(definition.version,2);
  assert.equal(definition.basis_kind,'message_query_receipt');
  assert.equal(definition.receipt_id,x.receipt.id);
  assert.equal(definition.receipt_digest,x.receipt.digest);
  assert.equal(definition.query_request_id,x.queued.request_ids[0]);
  assert.equal(definition.evaluator_version,'scout-query-intent-v1');
  assert.equal(job.sample_id,null,'query receipts do not masquerade as history samples');
  assert.equal(JSON.parse(job.cursor_json).mode,'query_intent_v1');
  assert.equal(x.h.config.scout.modelEnabled,false);
  assert.equal(x.h.config.runtime.model,'');
  const packet=x.h.service.scout.queries.packet(x.h.service.scout.queries.receipt(x.receipt.id));
  assert.equal(packet.current_intent,'unknown');
  assert.equal(packet.offer_fit,'unknown');
  assert.equal(packet.contact_permission,false);
  assert.equal(packet.messages.length,1);
  assert.equal(packet.messages[0].message_id,'906');
  assert.equal(x.h.store.get('SELECT COUNT(*) n FROM scout_model_requests').n,1);
  for(const table of ['persons','conversations','messages','contact_permissions','drafts','approvals','delivery_attempts'])
    assert.equal(x.h.store.get(`SELECT COUNT(*) n FROM ${table}`).n,0,table);
});

for(const [operation,article,label] of [['edit','an','edit'],['delete','a','deletion']]) test(`${article} ${label} observation invalidates query assessment before model dispatch`,async t=>{
  const x=await prepared(t);
  x.h.store.event(x.h.service.config.partnerId,null,operation==='delete'?'source.telegram.tombstone':'source.message','operator',
    {source_id:x.receipt.source_ref,message_id:'message:906',operation,...(operation==='edit'?{text:'Changed after query acquisition.'}:{})});
  await assert.rejects(request(x),{code:'SCOUT_QUERY_STALE'});
  let calls=0;
  const outcome=await processScoutAssessment(x.h.service,{decide:async()=>{calls++;return {completed:false};}});
  assert.notEqual(outcome.disposition,'assessment_proposed');
  assert.equal(calls,0);
  assert.equal(x.h.store.get('SELECT COUNT(*) n FROM scout_model_requests').n,0);
  assert.equal(x.h.store.get('SELECT COUNT(*) n FROM scout_query_proposals').n,0);
});

test('scoped query interpretation persists only a grounded inert proposal over the exact receipt',async t=>{
  const x=await prepared(t);await request(x);let calls=0,seen;
  const output=validIntent();
  const outcome=await processScoutAssessment(x.h.service,{decide:async(run,context)=>{
    calls++;seen={run,context};
    assert.equal(context.packet.receipt_id,x.receipt.id);
    assert.equal(context.packet.receipt_digest,x.receipt.digest);
    assert.equal(context.packet.current_intent,'unknown');
    assert.equal(context.packet.offer_fit,'unknown');
    assert.equal(context.packet.contact_permission,false);
    assert.equal(context.packet.messages.length,1);
    assert.equal(context.packet.messages[0].message_id,'906');
    assert.equal(context.packet.scout_assessment_request.id,x.h.store.get('SELECT id FROM scout_model_requests').id);
    assert.equal(run.model,'offline-query-model');
    assert.equal(x.h.config.scout.modelEnabled,false);
    assert.equal(x.h.config.runtime.model,'');
    return {completed:true,final_response:JSON.stringify(output),usage:{input_tokens:19,output_tokens:12}};
  }});
  assert.equal(calls,1);assert.equal(outcome.disposition,'query_proposed');
  const stored=x.h.store.get('SELECT * FROM scout_query_proposals WHERE id=?',outcome.proposal_id);
  assert.ok(stored);assert.equal(stored.receipt_id,x.receipt.id);assert.equal(stored.receipt_digest,x.receipt.digest);
  assert.equal(stored.status,'proposed');
  assert.deepEqual(JSON.parse(stored.output_json),{...output,items:output.items.map(item=>({...item,
    quoted_text:'I run a small shop and need a supplier for physical goods.'}))});
  assert.equal(x.h.store.get('SELECT input_tokens FROM runs WHERE id=?',stored.run_id).input_tokens,19);
  for(const table of ['persons','conversations','messages','contact_permissions','drafts','approvals','delivery_attempts'])
    assert.equal(x.h.store.get(`SELECT COUNT(*) n FROM ${table}`).n,0,table);
});

test('schema keyword diagnostic survives restart without persisting private model output or effects',async t=>{
  const x=await prepared(t);await request(x);
  const invalid={...validIntent(),items:validIntent().items.map(item=>({...item,current_intent:PRIVATE_SCHEMA_SENTINEL}))};
  const outcome=await processScoutAssessment(x.h.service,{decide:async()=>({completed:true,final_response:JSON.stringify(invalid),
    usage:{input_tokens:17,output_tokens:23}})});
  assert.equal(outcome.disposition,'withheld');
  assert.equal(outcome.reason,'SCOUT_QUERY_SCHEMA_INVALID');
  assert.deepEqual(outcome.diagnostic,{stage:'schema',code:'SCOUT_SCHEMA_INVALID',schema_keywords:['const']});
  assert.equal(x.h.store.get('SELECT COUNT(*) n FROM scout_query_proposals').n,0);
  const run=x.h.store.get("SELECT * FROM runs WHERE runtime='hermes-scout-v1'");
  assert.equal(run.status,'failed');
  assert.equal(run.input_tokens,17);assert.equal(run.output_tokens,23);
  assert.equal(JSON.stringify(JSON.parse(run.result_json).diagnostic).includes(PRIVATE_SCHEMA_SENTINEL),false);
  const presentation=()=>x.h.service.scout.presentation(x.h.service.scout.campaign(x.campaign.id));
  const first=JSON.stringify(presentation());
  assert.equal(first.includes(PRIVATE_SCHEMA_SENTINEL),false);
  assert.deepEqual(presentation().jobs.find(job=>job.id===JSON.parse(run.context_json).job_id).diagnostic,
    {stage:'schema',code:'SCOUT_SCHEMA_INVALID',schema_keywords:['const']});
  x.h.restart();
  const afterRestart=JSON.stringify(presentation());
  assert.equal(afterRestart.includes(PRIVATE_SCHEMA_SENTINEL),false);
  assert.deepEqual(presentation().jobs.find(job=>job.id===JSON.parse(run.context_json).job_id).diagnostic,
    {stage:'schema',code:'SCOUT_SCHEMA_INVALID',schema_keywords:['const']});
  assert.equal(x.h.store.get('SELECT COUNT(*) n FROM scout_query_proposals').n,0);
  for(const table of ['persons','conversations','messages','contact_permissions','drafts','approvals','delivery_attempts'])
    assert.equal(x.h.store.get(`SELECT COUNT(*) n FROM ${table}`).n,0,table);
});

test('a recomputed digest cannot legitimize a tampered materialized source quote',async t=>{
  const x=await createProposal(t),row=x.h.store.get('SELECT * FROM scout_query_proposals WHERE id=?',x.outcome.proposal_id);
  const damaged=JSON.parse(row.output_json);
  damaged.items[0].quoted_text='Fabricated wording absent from the native message.';
  const receipt=x.h.service.scout.queries.receipt(x.receipt.id),packet=x.h.service.scout.queries.packet(receipt);
  assert.equal(scoutQueryStoredOutput(damaged,packet),null);

  // Simulate an attacker who bypasses the immutable-row trigger and recomputes
  // the ordinary digest; semantic source binding must still reject the record.
  x.h.store.run('DROP TRIGGER scout_query_proposal_immutable');
  x.h.store.run('UPDATE scout_query_proposals SET output_json=?,output_digest=? WHERE id=?',JSON.stringify(damaged),digest(damaged),row.id);
  assert.throws(()=>x.h.service.scout.queries.proposal(row.id,x.h.service.scout.campaign(x.campaign.id)),{code:'SCOUT_QUERY_PROPOSAL_INVALID'});
  const visible=x.h.service.scout.queries.presentation(x.h.service.scout.campaign(x.campaign.id))
    .flatMap(query=>query.receipts).flatMap(receiptRow=>receiptRow.proposals).find(proposal=>proposal.id===row.id);
  assert.equal(visible.current,false);
  assert.equal(visible.status,'stale');
  assert.equal(visible.reason,'SCOUT_QUERY_PROPOSAL_INVALID');
  await assert.rejects(x.h.command('scout.review_query',{campaign_id:x.campaign.id,revision:x.campaign.revision,
    proposal_id:row.id,decision:'approve',note:'Tampered literal text cannot be approved.'}),{code:'SCOUT_QUERY_PROPOSAL_INVALID'});
});

for(const tamper of ['packet_message','output_contract','router_instructions']) test(`HermesAdapter blocks ${tamper} tampering before the child boundary`,async t=>{
  const x=await prepared(t);await request(x);let runCalls=0,guardCode=null;
  const runtime={decide:async(run,context)=>{
    const adapter=new HermesAdapter(x.h.service,new Map());
    adapter.run=async()=>{runCalls++;return {completed:true,final_response:JSON.stringify(validIntent()),usage:{input_tokens:10,output_tokens:4}};};
    if(tamper==='packet_message')context.packet.messages[0].text='tampered after the immutable receipt was frozen';
    else if(tamper==='output_contract')context.output_contract={...context.output_contract,description:'altered'};
    else context.router_instructions+=' altered';
    try{return await adapter.decide(run,context);}catch(error){guardCode=error.code;throw error;}
  }};
  const outcome=await processScoutAssessment(x.h.service,runtime);
  assert.equal(guardCode,'SCOUT_QUERY_RUNTIME_INPUT_INVALID');
  assert.equal(runCalls,0,'no child dispatch occurs after a frozen-context mismatch');
  assert.notEqual(outcome.disposition,'query_proposed');
  assert.equal(x.h.store.get('SELECT COUNT(*) n FROM scout_query_proposals').n,0);
});

test('untampered HermesAdapter query context reaches only the intercepted child boundary',async t=>{
  const x=await prepared(t);await request(x);let runCalls=0;
  const outcome=await processScoutAssessment(x.h.service,{decide:async(run,context)=>{
    const adapter=new HermesAdapter(x.h.service,new Map());
    adapter.run=async(_run,_context,decision)=>{
      assert.equal(decision,true);
      const current=x.h.service.scout.modelRequests.assertForRun(run);
      assert.equal(current.definition.version,2);
      assert.equal(current.definition.receipt_id,x.receipt.id);
      runCalls++;
      return {completed:true,final_response:JSON.stringify(validIntent()),usage:{input_tokens:13,output_tokens:8}};
    };
    return adapter.decide(run,context);
  }});
  assert.equal(runCalls,1);
  assert.equal(outcome.disposition,'query_proposed');
});

async function createProposal(t,expiresAt=new Date(Date.now()+5*60000).toISOString()){
  const x=await prepared(t);await request(x,{expires_at:expiresAt});
  const outcome=await processScoutAssessment(x.h.service,{decide:async()=>({completed:true,final_response:JSON.stringify(validIntent()),
    usage:{input_tokens:9,output_tokens:4}})});
  assert.equal(outcome.disposition,'query_proposed');
  return {...x,outcome};
}

test('owner review approves a query proposal once and creates no person, draft, or outbound authority',async t=>{
  const x=await createProposal(t);
  const reviewed=await x.h.command('scout.review_query',{campaign_id:x.campaign.id,revision:x.campaign.revision,
    proposal_id:x.outcome.proposal_id,decision:'approve',note:'Inspect the bounded evidence and inert wording.'});
  assert.equal(reviewed.status,'approved');
  assert.equal(reviewed.contact_permission,false);
  assert.deepEqual(reviewed.allowed_effects,[]);
  await assert.rejects(x.h.command('scout.review_query',{campaign_id:x.campaign.id,revision:x.campaign.revision,
    proposal_id:x.outcome.proposal_id,decision:'reject',note:'Second decision must be refused.'}),{code:'SCOUT_ASSESSMENT_ALREADY_REVIEWED'});
  assert.equal(x.h.store.get('SELECT status FROM scout_query_proposals WHERE id=?',x.outcome.proposal_id).status,'approved');
  for(const table of ['persons','conversations','messages','contact_permissions','drafts','approvals','delivery_attempts'])
    assert.equal(x.h.store.get(`SELECT COUNT(*) n FROM ${table}`).n,0,table);
});

for(const invalidation of ['expiry','profile','account','edit']) test(`query proposal review is blocked after ${invalidation} invalidation`,async t=>{
  const expiresAt=invalidation==='expiry'?new Date(Date.now()+2500).toISOString():new Date(Date.now()+5*60000).toISOString();
  const x=await createProposal(t,expiresAt);
  if(invalidation==='expiry') await new Promise(resolve=>setTimeout(resolve,2600));
  else if(invalidation==='profile') await x.h.command('model.profile_revoke',{profile_id:x.profile.profile_id,
    expected_definition_hash:x.profile.definition_hash,reason:'Offline query profile revocation.'});
  else if(invalidation==='account') x.h.store.run('UPDATE scout_candidates SET account_id=? WHERE id=?','991234567891',x.candidate.id);
  else x.h.store.event(x.h.service.config.partnerId,null,'source.message','operator',
    {source_id:x.receipt.source_ref,message_id:'message:906',operation:'edit',text:'Changed after the proposal was created.'});

  await assert.rejects(x.h.command('scout.review_query',{campaign_id:x.campaign.id,revision:x.campaign.revision,
    proposal_id:x.outcome.proposal_id,decision:'approve',note:'This stale proposal cannot be approved.'}));
  assert.equal(x.h.store.get("SELECT COUNT(*) n FROM scout_query_proposals WHERE id=? AND status='approved'",x.outcome.proposal_id).n,0);
  for(const table of ['persons','conversations','messages','contact_permissions','drafts','approvals','delivery_attempts'])
    assert.equal(x.h.store.get(`SELECT COUNT(*) n FROM ${table}`).n,0,table);
});

test('revocation during query interpretation records usage but cannot persist a proposal or effects',async t=>{
  const x=await prepared(t),created=await request(x);let begin,release;
  const started=new Promise(resolve=>{begin=resolve;}),pending=new Promise(resolve=>{release=resolve;});
  const processing=processScoutAssessment(x.h.service,{decide:async()=>{
    begin();await pending;return {completed:true,final_response:'{}',usage:{input_tokens:11,output_tokens:7}};
  }});
  await started;
  await x.h.command('scout.revoke_assessment',{request_id:created.request_id,expected_fingerprint:created.fingerprint,reason:'Offline query test revoke'});
  release();
  const outcome=await processing;
  assert.notEqual(outcome.disposition,'query_proposed');
  assert.equal(x.h.store.get('SELECT COUNT(*) n FROM scout_query_proposals').n,0);
  const run=x.h.store.get("SELECT * FROM runs WHERE runtime='hermes-scout-v1'");
  assert.equal(run.input_tokens,11);assert.equal(run.output_tokens,7);
  for(const table of ['persons','conversations','messages','contact_permissions','drafts','approvals','delivery_attempts'])
    assert.equal(x.h.store.get(`SELECT COUNT(*) n FROM ${table}`).n,0,table);
});

test('a spent query model request never runs again after restart',async t=>{
  const x=await prepared(t),created=await request(x);let calls=0;
  const runtime={decide:async()=>{calls++;return {completed:false,usage:{input_tokens:5,output_tokens:2}};}};
  const first=await processScoutAssessment(x.h.service,runtime);
  assert.notEqual(first.disposition,'query_proposed');assert.equal(calls,1);
  assert.equal(x.h.store.get('SELECT attempts FROM scout_jobs WHERE id=?',created.job_id).attempts,1);
  x.h.restart();
  const second=await processScoutAssessment(x.h.service,runtime);
  assert.notEqual(second.disposition,'query_proposed');assert.equal(calls,1);
  assert.equal(x.h.store.get('SELECT COUNT(*) n FROM scout_query_proposals').n,0);
});

for(const testCase of [
  {name:'JSON markdown fence',reason:'SCOUT_QUERY_OUTPUT_INVALID',diagnostic:{stage:'format',code:'SCOUT_JSON_MARKDOWN_FENCE'},
    result:()=>({completed:true,final_response:`\`\`\`json\n${JSON.stringify(validIntent())}\n\`\`\`\nprivate-query-provider-sentinel`})},
  {name:'malformed JSON',reason:'SCOUT_QUERY_OUTPUT_INVALID',diagnostic:{stage:'format',code:'SCOUT_JSON_INVALID'},
    result:()=>({completed:true,final_response:'{broken-json-private-query-provider-sentinel'})},
  {name:'invalid output schema',reason:'SCOUT_QUERY_SCHEMA_INVALID',diagnostic:{stage:'schema',code:'SCOUT_SCHEMA_INVALID',schema_keywords:['additionalProperties']},
    result:()=>({completed:true,final_response:JSON.stringify({...validIntent(),private_field:'private-query-provider-sentinel'})})},
  {name:'incomplete provider failure',reason:'SCOUT_QUERY_MODEL_INCOMPLETE',diagnostic:{stage:'model',code:'SCOUT_MODEL_INCOMPLETE',failure_cause:{
    kind:'provider_error',http_status:429,provider_error_type:'rate_limit',retryable:true,attempt_count:2,child_exit_code:null,timed_out:false,stdout_json_valid:false,
  }},result:()=>({completed:false,error:'private-query-provider-sentinel',failure_cause:{kind:'provider_error',http_status:429,
    provider_error_type:'rate_limit',retryable:true,attempt_count:2,raw_response:'private-query-provider-sentinel',api_key:'private-query-provider-sentinel'}})},
]) test(`query failure diagnostics safely report ${testCase.name}`,async t=>{
  const x=await prepared(t);await request(x);
  const outcome=await processScoutAssessment(x.h.service,{decide:async()=>testCase.result()});
  assert.equal(outcome.disposition,'withheld');
  assert.equal(outcome.reason,testCase.reason);
  assert.deepEqual(outcome.diagnostic,testCase.diagnostic);
  assert.equal(x.h.store.get('SELECT COUNT(*) n FROM scout_query_proposals').n,0);
  const run=x.h.store.get("SELECT * FROM runs WHERE runtime='hermes-scout-v1'");
  assert.equal(run.status,'failed');
  const stored=JSON.stringify({result:JSON.parse(run.result_json),presentation:x.h.service.scout.presentation(x.h.service.scout.campaign(x.campaign.id))});
  assert.deepEqual(JSON.parse(run.result_json).diagnostic,testCase.diagnostic);
  assert.equal(stored.includes('private-query-provider-sentinel'),false,'raw provider content must never reach persisted run or presentation');
  const jobId=JSON.parse(run.context_json).job_id;
  const job=x.h.service.scout.presentation(x.h.service.scout.campaign(x.campaign.id)).jobs.find(row=>row.id===jobId);
  assert.deepEqual(job.diagnostic,testCase.diagnostic);
});
