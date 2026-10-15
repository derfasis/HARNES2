import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeActivation } from '../business/deployment.mjs';
import { processScoutAssessment } from '../business/scout-reasoning.mjs';
import { scoutQueryOutput } from '../business/scout-query-output.mjs';
import { digest } from '../business/source-ingestion.mjs';
import { id } from '../business/store.mjs';
import { channel, message, scoutHarness } from './scout-test-helpers.mjs';

const TERM='I need a supplier for physical goods';
const PROFILE_URL='https://models.example.test/v1';

function outputFor(messageId='906',classification='own_business_request',missingContext=[]){
  return {summary:'The author describes a supplier need.',unknowns:['Current intent and offer fit are unknown.'],items:[{
    message_id:messageId,
    interpretation:'The author describes a supplier need connected to a shop.',classification,missing_context:missingContext,
    suggested_public_reply:null,current_intent:'unknown',offer_fit:'unknown',contact_permission:false,
  }]};
}

function materialized(modelOutput,packet){
  return {...modelOutput,items:modelOutput.items.map(item=>({...item,
    quoted_text:packet.messages.find(message=>message.message_id===item.message_id)?.text,
  }))};
}

test('missing reply parent cannot support own positive intent; an unclear reading remains reviewable',()=>{
  const packet={source_ref:'telegram:channel:123456789',messages:[{message_id:'906',text:'I run a small shop and need a supplier for physical goods.',
    author_ref:'author-1',reply_to:'905',reply_to_source:'telegram:channel:123456789',missing_parent:true}]};
  const positive=outputFor('906','own_business_request',['The parent message is unavailable.']);
  const rejected=scoutQueryOutput({completed:true,final_response:JSON.stringify(positive)},packet);
  assert.equal(rejected.output,null);
  assert.match(rejected.reason,/ATTRIBUTION|CONTEXT/);

  const nonpositive=outputFor('906','unclear',['The parent message is unavailable.']);
  assert.deepEqual(scoutQueryOutput({completed:true,final_response:JSON.stringify(nonpositive)},packet).output,materialized(nonpositive,packet));
});

async function queryHarness(t,{multiple=false,messages=null}={}){
  let next='906';
  const h=scoutHarness(t,{
    resolve:async()=>channel({channel_id:'1134567891',kind:'group'}),
    history:async()=>{throw new Error('query integrity fixture must not read history');},
    messageSearch:async({limit})=>{
      const messageId=multiple?String(next++):'906';
      const selected=messages??[message(messageId,{author_ref:'author-self',date:new Date(Date.now()-60000).toISOString(),
        text:'I run a small shop and need a supplier for physical goods.'})];
      return {messages:selected,requested_count:limit,received_count:selected.length,omitted_count:0,
        truncated:false,selection_kind:'message_query_v1',exhaustive:false};
    },
  });
  const campaign=await h.campaign(TERM);await h.authorize(campaign);
  await h.command('scout.register',{campaign_id:campaign.id,revision:campaign.revision,reference:'@sample_channel'});
  await h.runtime.tick();
  const candidate=h.store.get('SELECT * FROM scout_candidates WHERE campaign_id=? AND username=?',campaign.id,'sample_channel');
  return {h,campaign,candidate};
}

test('opaque excluded reply parent stays missing without poisoning another author in the page',async t=>{
  const sourceRef='telegram:channel:1134567891';
  const shopText='I run a small shop and need a supplier for physical goods.';
  const x=await queryHarness(t,{messages:[
    message('905',{author_ref:'author-media',date:new Date(Date.now()-180000).toISOString(),text:null,unsupported:'media_only'}),
    message('906',{author_ref:'author-reply',date:new Date(Date.now()-120000).toISOString(),reply_to:'905',reply_to_source:sourceRef,text:shopText}),
    message('907',{author_ref:'author-other',date:new Date(Date.now()-60000).toISOString(),text:shopText}),
  ]});
  const {receipt}=await acquire(x),raw=x.h.service.scout.queries.receipt(receipt.id),packet=x.h.service.scout.queries.packet(raw);
  assert.equal(packet.excluded.opaque,1);
  assert.deepEqual(packet.messages.map(m=>m.message_id),['906','907']);
  const reply=packet.messages.find(m=>m.message_id==='906'),other=packet.messages.find(m=>m.message_id==='907');
  assert.equal(reply.missing_parent,true,'an opaque excluded parent is still unresolved');
  assert.equal(other.author_ref,'author-other');
  assert.equal(other.missing_parent,false,'unrelated author remains usable');

  const replyResult=scoutQueryOutput({completed:true,final_response:JSON.stringify(outputFor('906','own_business_request',[
    'The referenced parent is unavailable in the supported page.',
  ]))},packet);
  assert.equal(replyResult.output,null);
  const otherOutput=outputFor('907');
  assert.deepEqual(scoutQueryOutput({completed:true,final_response:JSON.stringify(otherOutput)},packet).output,materialized(otherOutput,packet));
});

async function acquire(x){
  const queued=await x.h.command('scout.query_messages',{campaign_id:x.campaign.id,revision:x.campaign.revision,
    candidate_ids:[x.candidate.id],queries:[TERM],window_days:30,limit:5});
  await x.h.runtime.tick();
  const receipt=x.h.service.scout.queries.presentation(x.h.service.scout.campaign(x.campaign.id))
    .flatMap(row=>row.receipts).find(row=>row.id);
  assert.ok(receipt,'query receipt should be created');
  return {queued,receipt};
}

test('account switch marks receipt and proposal noncurrent and blocks owner review',async t=>{
  const oldKey=process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY='offline-query-integrity-sentinel';
  t.after(()=>oldKey===undefined?delete process.env.PARTNER_MODEL_API_KEY:process.env.PARTNER_MODEL_API_KEY=oldKey);
  const x=await queryHarness(t),{receipt}=await acquire(x);
  Object.assign(x.h.config.runtime,{enabled:false,model:'',baseUrl:'',dailyBudgetUsd:5});
  x.h.config.modelProfiles={allowedBaseUrls:[PROFILE_URL]};
  x.h.config.scout.modelEnabled=false;x.h.config.opportunity.automatic=false;
  x.h.service.deployment=new RuntimeActivation({id:id(),label:'Offline query integrity',mode:'scoped_reasoning',
    expires_at:new Date(Date.now()+3600000).toISOString()});
  const profile=await x.h.command('model.profile_create',{label:'Offline query integrity profile',provider:'custom',api_mode:'chat_completions',
    base_url:PROFILE_URL,model:'offline-query-model',max_output_tokens:900,input_usd_per_million:2,output_usd_per_million:3});
  const request=await x.h.command('scout.request_query_assessment',{campaign_id:x.campaign.id,revision:x.campaign.revision,receipt_id:receipt.id,
    expected_receipt_digest:receipt.digest,model_profile_id:profile.profile_id,expected_model_profile_hash:profile.definition_hash,
    expires_at:new Date(Date.now()+5*60000).toISOString(),purpose:'One offline account-fence regression.'});
  const proposed=outputFor();
  const result=await processScoutAssessment(x.h.service,{decide:async()=>({completed:true,final_response:JSON.stringify(proposed),usage:{input_tokens:7,output_tokens:5}})});
  assert.equal(result.disposition,'query_proposed');
  const proposalId=result.proposal_id;
  const stored=x.h.store.get('SELECT output_json FROM scout_query_proposals WHERE id=?',proposalId);
  assert.equal(JSON.parse(stored.output_json).items[0].quoted_text,'I run a small shop and need a supplier for physical goods.');

  x.h.service.setTelegramAccount('8111111111');
  const after=x.h.service.scout.queries.presentation(x.h.service.scout.campaign(x.campaign.id)).flatMap(row=>row.receipts);
  const view=after.find(row=>row.id===receipt.id);
  assert.equal(view.current,false);
  assert.equal(view.proposals.find(row=>row.id===proposalId).current,false);
  await assert.rejects(x.h.command('scout.review_query',{campaign_id:x.campaign.id,revision:x.campaign.revision,
    proposal_id:proposalId,decision:'approve',note:'Must fail after account switch.'}),{code:'SCOUT_AUDIT_AUTHORITY_REQUIRED'});
  assert.equal(x.h.store.get('SELECT status FROM scout_query_proposals WHERE id=?',proposalId).status,'proposed');
  assert.ok(request.request_id);
});

test('forged future receipt cursor is rejected without invalidating a healthy neighboring receipt',async t=>{
  const x=await queryHarness(t,{multiple:true});
  const first=await acquire(x),second=await acquire(x);
  const healthyId=second.receipt.id,forgedId=first.receipt.id;
  const row=x.h.store.get('SELECT * FROM scout_query_receipts WHERE id=?',forgedId);
  const content=JSON.parse(row.content_json),future=x.h.service.scout.queries.sourceCursor()+1000;
  content.source_cursor=future;
  x.h.store.db.exec('DROP TRIGGER scout_query_receipt_immutable');
  x.h.store.run('UPDATE scout_query_receipts SET source_cursor=?,content_json=?,content_hash=? WHERE id=?',
    future,JSON.stringify(content),digest(content),forgedId);

  assert.throws(()=>x.h.service.scout.queries.receipt(forgedId),{code:'SCOUT_QUERY_RECEIPT_INVALID'});
  const healthy=x.h.service.scout.queries.receipt(healthyId);
  assert.equal(healthy.row.id,healthyId);
  const presentation=x.h.service.scout.queries.presentation(x.h.service.scout.campaign(x.campaign.id)).flatMap(row=>row.receipts);
  assert.equal(presentation.find(receipt=>receipt.id===forgedId).current,false);
  assert.equal(presentation.find(receipt=>receipt.id===healthyId).current,true);
});

test('receipt validation rejects a mutable call row relabeled as another operation',async t=>{
  const x=await queryHarness(t),{receipt}=await acquire(x);
  const row=x.h.store.get('SELECT attempt_call_id FROM scout_query_receipts WHERE id=?',receipt.id);
  assert.ok(row?.attempt_call_id);
  x.h.store.run("UPDATE scout_calls SET operation='history' WHERE id=?",row.attempt_call_id);
  assert.throws(()=>x.h.service.scout.queries.receipt(receipt.id),{code:'SCOUT_QUERY_RECEIPT_INVALID'});
  const view=x.h.service.scout.queries.presentation(x.h.service.scout.campaign(x.campaign.id)).flatMap(item=>item.receipts)
    .find(item=>item.id===receipt.id);
  assert.equal(view.current,false);
});
