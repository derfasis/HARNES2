import test from 'node:test';
import assert from 'node:assert/strict';
import { channel, message, scoutHarness } from './scout-test-helpers.mjs';

async function registerCandidate(h,campaign,reference='@sample_channel'){
  const queued=await h.command('scout.register',{campaign_id:campaign.id,revision:campaign.revision,reference});
  assert.equal(queued.status,'queued');
  assert.ok(queued.job_id);
  await h.runtime.tick();
  return h.store.get('SELECT * FROM scout_candidates WHERE campaign_id=?',campaign.id);
}

async function queueQuery(h,campaign,candidate,query='publisher physical programs',limit=5){
  return h.command('scout.query_messages',{
    campaign_id:campaign.id,revision:campaign.revision,candidate_ids:[candidate.id],
    queries:[query],window_days:30,limit,
  });
}

test('explicit registration resolves a candidate without sampling history or linked discussions',async t=>{
  let resolveCalls=0,historyCalls=0,discussionCalls=0;
  const h=scoutHarness(t,{
    resolve:async()=>{resolveCalls++;return channel({channel_id:'223456789',kind:'group'});},
    history:async()=>{historyCalls++;throw new Error('registration must not read history');},
    discussions:async()=>{discussionCalls++;throw new Error('registration must not inspect discussions');},
  });
  const campaign=await h.campaign('Publisher physical-goods programs');
  await h.authorize(campaign);
  const candidate=await registerCandidate(h,campaign);

  assert.equal(resolveCalls,1);
  assert.equal(historyCalls,0);
  assert.equal(discussionCalls,0);
  assert.equal(candidate.channel_id,'223456789');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_samples').n,0);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM scout_jobs WHERE kind='history'").n,0);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind LIKE 'source.%'").n,0);
});

test('message query stores a typed page receipt separately from history samples',async t=>{
  let reads=0,historyCalls=0;
  const h=scoutHarness(t,{
    resolve:async()=>channel({channel_id:'323456789',kind:'group'}),
    history:async()=>{historyCalls++;throw new Error('message query must not run history');},
    messageSearch:async()=>{
      reads++;
      return {messages:[message('901')],requested_count:5,received_count:1,omitted_count:0,
        truncated:false,selection_kind:'message_query_v1',exhaustive:false};
    },
  });
  const query='publisher physical programs';
  const campaign=await h.campaign(query);
  await h.authorize(campaign);
  const candidate=await registerCandidate(h,campaign);
  const queued=await queueQuery(h,campaign,candidate,query);

  assert.equal(queued.request_ids.length,1);
  assert.equal(queued.job_ids.length,1);
  await h.runtime.tick();

  assert.equal(reads,1);
  assert.equal(historyCalls,0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_message_queries').n,1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_query_receipts').n,1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_samples').n,0);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='source.message'").n,0);
  for(const table of ['persons','conversations','messages','contact_permissions','drafts','approvals','delivery_attempts'])
    assert.equal(h.store.get(`SELECT COUNT(*) n FROM ${table}`).n,0,table);
});

test('campaign topic revision stales queued message-query work before any native read',async t=>{
  let reads=0;
  const h=scoutHarness(t,{
    resolve:async()=>channel({channel_id:'423456789',kind:'group'}),
    messageSearch:async()=>{reads++;return {messages:[],requested_count:5,received_count:0,omitted_count:0,
      truncated:false,selection_kind:'message_query_v1',exhaustive:false};},
  });
  const query='publisher physical programs';
  const campaign=await h.campaign(query);
  await h.authorize(campaign);
  const candidate=await registerCandidate(h,campaign);
  const queued=await queueQuery(h,campaign,candidate,query);
  const jobId=queued.job_ids[0];
  assert.ok(jobId);

  const revised=await h.command('scout.revise',{
    campaign_id:campaign.id,revision:campaign.revision,topic:'Revised publisher topic',
    audience:'Revised audience',language:'en',geography:'global',queries:['revised query'],
  });
  assert.equal(revised.revision,2);
  await h.runtime.tick();

  assert.equal(reads,0);
  assert.equal(h.store.get('SELECT status FROM scout_jobs WHERE id=?',jobId).status,'stale');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_query_receipts').n,0);
});

for(const change of ['revoke','revise']) test(`an in-flight query response is withheld after ${change}`,async t=>{
  let enterRead,releaseRead;
  const entered=new Promise(resolve=>{enterRead=resolve;});
  const blocked=new Promise(resolve=>{releaseRead=resolve;});
  let reads=0;
  const h=scoutHarness(t,{
    resolve:async()=>channel({channel_id:change==='revoke'?'523456789':'623456789',kind:'group'}),
    messageSearch:async()=>{reads++;enterRead();await blocked;return {messages:[message('902')],requested_count:5,received_count:1,omitted_count:0,
      truncated:false,selection_kind:'message_query_v1',exhaustive:false};},
  });
  const query='publisher physical programs',campaign=await h.campaign(query);
  const grantId=await h.authorize(campaign);
  const candidate=await registerCandidate(h,campaign);
  const queued=await queueQuery(h,campaign,candidate,query);
  const jobId=queued.job_ids[0];

  const pending=h.runtime.tick();
  await entered;
  if(change==='revoke'){
    await h.command('scout.revoke',{campaign_id:campaign.id,revision:campaign.revision,grant_id:grantId});
  }else{
    await h.command('scout.revise',{campaign_id:campaign.id,revision:campaign.revision,topic:'Revised publisher topic',
      audience:'Revised audience',language:'en',geography:'global',queries:['revised query']});
  }
  releaseRead();
  await pending;

  assert.equal(reads,1);
  assert.equal(h.store.get('SELECT status FROM scout_jobs WHERE id=?',jobId).status,'stale');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_query_receipts').n,0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_samples').n,0);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='source.message'").n,0);
  for(const table of ['persons','conversations','messages','contact_permissions','drafts','approvals','delivery_attempts'])
    assert.equal(h.store.get(`SELECT COUNT(*) n FROM ${table}`).n,0,table);
});

test('empty and opaque pages retain honest selection counts and do not imply completeness',async t=>{
  const pages=[
    {messages:[],requested_count:5,received_count:0,omitted_count:0,truncated:false,selection_kind:'message_query_v1',exhaustive:false},
    {messages:[message('903',{text:null,unsupported:'service_message'})],requested_count:5,received_count:5,omitted_count:4,truncated:true,selection_kind:'message_query_v1',exhaustive:false},
  ];
  const h=scoutHarness(t,{
    resolve:async()=>channel({channel_id:'723456789',kind:'group'}),
    messageSearch:async()=>pages.shift(),
  });
  const query='publisher physical programs',campaign=await h.campaign(query);
  await h.authorize(campaign);
  const candidate=await registerCandidate(h,campaign);
  const first=await queueQuery(h,campaign,candidate,query,5);
  const second=await queueQuery(h,campaign,candidate,query,5);
  await h.runtime.tick();
  await h.runtime.tick();

  const receipts=h.store.all('SELECT content_json FROM scout_query_receipts ORDER BY created_at,id').map(row=>JSON.parse(row.content_json));
  assert.equal(receipts.length,2);
  const serialized=receipts.map(row=>JSON.stringify(row));
  assert.ok(serialized.some(row=>row.includes('"received_count":0')));
  assert.ok(serialized.some(row=>row.includes('"exhaustive":false')));
  assert.ok(serialized.some(row=>row.includes('"omitted_count":4')));
  assert.ok(serialized.some(row=>row.includes('"truncated":true')));
  assert.ok(serialized.some(row=>row.includes('"unsupported":"service_message"')));
  assert.notEqual(first.request_ids[0],second.request_ids[0]);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_samples').n,0);
});

test('query request and acquired receipt rows are immutable',async t=>{
  const h=scoutHarness(t,{
    resolve:async()=>channel({channel_id:'823456789',kind:'group'}),
    messageSearch:async()=>({messages:[message('904')],requested_count:5,received_count:1,omitted_count:0,
      truncated:false,selection_kind:'message_query_v1',exhaustive:false}),
  });
  const query='publisher physical programs',campaign=await h.campaign(query);
  await h.authorize(campaign);
  const candidate=await registerCandidate(h,campaign);
  const queued=await queueQuery(h,campaign,candidate,query);
  await h.runtime.tick();
  const requestId=queued.request_ids[0],receipt=h.store.get('SELECT id FROM scout_query_receipts LIMIT 1');
  assert.ok(receipt);
  assert.throws(()=>h.store.run('UPDATE scout_message_queries SET definition_json=? WHERE id=?','{}',requestId),/SCOUT_QUERY_IMMUTABLE/);
  assert.throws(()=>h.store.run('UPDATE scout_query_receipts SET content_json=? WHERE id=?','{}',receipt.id),/SCOUT_QUERY_RECEIPT_IMMUTABLE/);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_query_receipts WHERE id=?',receipt.id).n,1);
});
