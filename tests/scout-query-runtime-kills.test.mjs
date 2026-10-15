import test from 'node:test';
import assert from 'node:assert/strict';
import { channel, scoutHarness } from './scout-test-helpers.mjs';

test('query-shaped cursor cannot fall back to contacts.Search if its durable association is missing',async t=>{
  let discoveryCalls=0,messageReads=0;
  const h=scoutHarness(t,{
    resolve:async({username}={})=>channel({channel_id:'1234567891',username,kind:'group'}),
    search:async()=>{discoveryCalls++;return {candidates:[]};},
    messageSearch:async()=>{messageReads++;return {messages:[],requested_count:5,received_count:0,omitted_count:0,
      truncated:false,selection_kind:'message_query_v1',exhaustive:false};},
  });
  const term='publisher physical programs',campaign=await h.campaign(term);
  await h.authorize(campaign);
  const registered=await h.command('scout.register',{campaign_id:campaign.id,revision:campaign.revision,reference:'@sample_channel'});
  await h.runtime.tick();
  const candidate=h.store.get('SELECT * FROM scout_candidates WHERE campaign_id=?',campaign.id);
  const queued=await h.command('scout.query_messages',{campaign_id:campaign.id,revision:campaign.revision,
    candidate_ids:[candidate.id],queries:[term],window_days:30,limit:5});
  const jobId=queued.job_ids[0];
  const cursor=JSON.parse(h.store.get('SELECT cursor_json FROM scout_jobs WHERE id=?',jobId).cursor_json);
  // Simulate a damaged imported/local database that lost the association row;
  // production SQL guards normally prevent this deletion.
  h.store.db.exec('DROP TRIGGER scout_message_query_no_delete');
  h.store.run('DELETE FROM scout_message_queries WHERE job_id=?',jobId);
  h.store.run('UPDATE scout_jobs SET cursor_json=? WHERE id=?',JSON.stringify({...cursor,mode:undefined,query:term}),jobId);

  await h.runtime.tick();

  assert.equal(discoveryCalls,0,'a damaged query job must not issue an unscoped contacts.Search');
  assert.equal(messageReads,0);
  assert.equal(h.store.get('SELECT status FROM scout_jobs WHERE id=?',jobId).status,'stale');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_samples').n,0);
  assert.ok(registered.job_id);
});

test('valid JSON null cursor retires only the corrupt job instead of aborting the Scout tick',async t=>{
  let discoveryCalls=0,messageReads=0;
  const h=scoutHarness(t,{
    resolve:async({username}={})=>channel({channel_id:'1334567891',username,kind:'group'}),
    search:async()=>{discoveryCalls++;return {candidates:[]};},
    messageSearch:async()=>{messageReads++;return {messages:[],requested_count:5,received_count:0,omitted_count:0,
      truncated:false,selection_kind:'message_query_v1',exhaustive:false};},
  });
  const term='publisher physical programs',campaign=await h.campaign(term);
  await h.authorize(campaign);
  await h.command('scout.register',{campaign_id:campaign.id,revision:campaign.revision,reference:'@sample_channel'});
  await h.runtime.tick();
  const candidate=h.store.get('SELECT * FROM scout_candidates WHERE campaign_id=?',campaign.id);
  const queued=await h.command('scout.query_messages',{campaign_id:campaign.id,revision:campaign.revision,
    candidate_ids:[candidate.id],queries:[term],window_days:30,limit:5});
  const jobId=queued.job_ids[0];
  h.store.run("UPDATE scout_jobs SET cursor_json='null' WHERE id=?",jobId);

  await h.runtime.tick();

  assert.equal(discoveryCalls,0);
  assert.equal(messageReads,0);
  assert.equal(h.store.get('SELECT status FROM scout_jobs WHERE id=?',jobId).status,'stale');
});

test('malformed JSON cursor retires only the corrupt job without discovery fallback',async t=>{
  let discoveryCalls=0,messageReads=0;
  const h=scoutHarness(t,{
    resolve:async({username}={})=>channel({channel_id:'1434567891',username,kind:'group'}),
    search:async()=>{discoveryCalls++;return {candidates:[]};},
    messageSearch:async()=>{messageReads++;return {messages:[],requested_count:5,received_count:0,omitted_count:0,
      truncated:false,selection_kind:'message_query_v1',exhaustive:false};},
  });
  const term='publisher physical programs',campaign=await h.campaign(term);
  await h.authorize(campaign);
  await h.command('scout.register',{campaign_id:campaign.id,revision:campaign.revision,reference:'@sample_channel'});
  await h.runtime.tick();
  const candidate=h.store.get('SELECT * FROM scout_candidates WHERE campaign_id=?',campaign.id);
  const queued=await h.command('scout.query_messages',{campaign_id:campaign.id,revision:campaign.revision,
    candidate_ids:[candidate.id],queries:[term],window_days:30,limit:5});
  const jobId=queued.job_ids[0];
  h.store.run("UPDATE scout_jobs SET cursor_json='{' WHERE id=?",jobId);

  await h.runtime.tick();

  assert.equal(discoveryCalls,0);
  assert.equal(messageReads,0);
  assert.equal(h.store.get('SELECT status FROM scout_jobs WHERE id=?',jobId).status,'stale');
});

test('receipt persistence failure rolls back completion and restart uses a newly charged attempt',async t=>{
  let reads=0;
  const h=scoutHarness(t,{
    resolve:async({username}={})=>channel({channel_id:'2234567891',username,kind:'group'}),
    messageSearch:async()=>{reads++;return {messages:[],requested_count:5,received_count:0,omitted_count:0,
      truncated:false,selection_kind:'message_query_v1',exhaustive:false};},
  });
  const term='publisher physical programs',campaign=await h.campaign(term);
  await h.authorize(campaign);
  await h.command('scout.register',{campaign_id:campaign.id,revision:campaign.revision,reference:'@sample_channel'});
  await h.runtime.tick();
  const candidate=h.store.get('SELECT * FROM scout_candidates WHERE campaign_id=?',campaign.id);
  const queued=await h.command('scout.query_messages',{campaign_id:campaign.id,revision:campaign.revision,
    candidate_ids:[candidate.id],queries:[term],window_days:30,limit:5});
  const jobId=queued.job_ids[0],originalRun=h.store.run.bind(h.store);let failInsert=true;
  h.store.run=(sql,...params)=>{
    if(failInsert&&sql.startsWith('INSERT INTO scout_query_receipts')){failInsert=false;throw new Error('synthetic receipt write failure');}
    return originalRun(sql,...params);
  };

  await assert.rejects(h.runtime.tick(),/synthetic receipt write failure/);

  assert.equal(h.store.get('SELECT status FROM scout_jobs WHERE id=?',jobId).status,'interrupted');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_query_receipts').n,0);
  assert.deepEqual(h.store.all('SELECT status FROM scout_calls WHERE job_id=? ORDER BY created_at,id',jobId).map(x=>x.status),['unknown','unknown']);
  h.restart();
  await h.runtime.tick();

  assert.equal(reads,2);
  assert.equal(h.store.get('SELECT status FROM scout_jobs WHERE id=?',jobId).status,'completed');
  assert.equal(h.store.get('SELECT attempts FROM scout_jobs WHERE id=?',jobId).attempts,2);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_calls WHERE job_id=?',jobId).n,4);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_query_receipts').n,1);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM scout_calls WHERE job_id=? AND status='unknown'",jobId).n,2);
});

test('changed running-job owner withholds an otherwise valid native page',async t=>{
  let enterRead,releaseRead;
  const entered=new Promise(resolve=>{enterRead=resolve;}),blocked=new Promise(resolve=>{releaseRead=resolve;});
  let reads=0;
  const h=scoutHarness(t,{
    resolve:async({username}={})=>channel({channel_id:'3234567891',username,kind:'group'}),
    messageSearch:async()=>{reads++;enterRead();await blocked;return {messages:[],requested_count:5,received_count:0,omitted_count:0,
      truncated:false,selection_kind:'message_query_v1',exhaustive:false};},
  });
  const term='publisher physical programs',campaign=await h.campaign(term);
  await h.authorize(campaign);
  await h.command('scout.register',{campaign_id:campaign.id,revision:campaign.revision,reference:'@sample_channel'});
  await h.runtime.tick();
  const candidate=h.store.get('SELECT * FROM scout_candidates WHERE campaign_id=?',campaign.id);
  const queued=await h.command('scout.query_messages',{campaign_id:campaign.id,revision:campaign.revision,
    candidate_ids:[candidate.id],queries:[term],window_days:30,limit:5});
  const jobId=queued.job_ids[0],pending=h.runtime.tick();
  await entered;
  h.store.run("UPDATE scout_jobs SET owner_id='replaced-owner' WHERE id=?",jobId);
  releaseRead();
  await pending;

  assert.equal(reads,1);
  assert.equal(h.store.get('SELECT status FROM scout_jobs WHERE id=?',jobId).status,'stale');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_query_receipts').n,0);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM scout_calls WHERE job_id=? AND status='completed'",jobId).n,2);
});
