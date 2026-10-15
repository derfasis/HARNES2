import test from 'node:test';
import assert from 'node:assert/strict';
import { channel, message, scoutHarness } from './scout-test-helpers.mjs';

async function registered(h,campaign,reference){
  const queued=await h.command('scout.register',{campaign_id:campaign.id,revision:campaign.revision,reference});
  assert.equal(queued.status,'queued');
  await h.runtime.tick();
  return h.store.get('SELECT * FROM scout_candidates WHERE campaign_id=? AND username=?',campaign.id,reference.slice(1));
}

async function query(h,campaign,candidate,term='publisher physical programs'){
  return h.command('scout.query_messages',{campaign_id:campaign.id,revision:campaign.revision,
    candidate_ids:[candidate.id],queries:[term],window_days:30,limit:5});
}

test('restarted unknown message reads consume the same three-attempt cap',async t=>{
  let reads=0;
  const h=scoutHarness(t,{
    resolve:async({username}={})=>channel({channel_id:username==='first_channel'?'923456789':'923456790',username,kind:'group'}),
    messageSearch:async()=>{reads++;const error=new Error('synthetic timeout');error.code='SCOUT_RPC_TIMEOUT';throw error;},
  });
  const term='publisher physical programs',campaign=await h.campaign(term);
  await h.authorize(campaign);
  const candidate=await registered(h,campaign,'@first_channel');
  const queued=await query(h,campaign,candidate,term),jobId=queued.job_ids[0];

  for(let attempt=1;attempt<=3;attempt++){
    if(attempt>1){
      h.store.run("UPDATE scout_jobs SET status='interrupted',next_at=?,updated_at=? WHERE id=?",new Date(Date.now()-1000).toISOString(),new Date().toISOString(),jobId);
      h.restart();
    }
    await h.runtime.tick();
    assert.equal(h.store.get('SELECT attempts FROM scout_jobs WHERE id=?',jobId).attempts,attempt);
    assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_calls WHERE job_id=?',jobId).n,attempt*2,
      'resolve and native search reservations are both durably charged per attempt');
  }
  assert.equal(reads,3);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_query_receipts').n,0);

  h.store.run("UPDATE scout_jobs SET status='interrupted',next_at=?,updated_at=? WHERE id=?",new Date(Date.now()-1000).toISOString(),new Date().toISOString(),jobId);
  h.restart();
  await h.runtime.tick();
  assert.equal(reads,3,'a fourth native page must not be dispatched');
  assert.equal(h.store.get('SELECT attempts FROM scout_jobs WHERE id=?',jobId).attempts,3);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_calls WHERE job_id=?',jobId).n,6);
});

for(const corruption of ['unknown_cursor','durable_candidate_mismatch']) test(`invalid ${corruption} fails closed without history or discovery fallback`,async t=>{
  let searches=0,histories=0,messageReads=0;
  const h=scoutHarness(t,{
    resolve:async({username}={})=>channel({channel_id:username==='first_channel'?'1034567891':'1034567892',username,kind:'group'}),
    search:async()=>{searches++;return {candidates:[]};},
    history:async()=>{histories++;return {empty:true,requested_count:1,received_count:0,oldest_id:null,messages:[]};},
    messageSearch:async()=>{messageReads++;return {messages:[message('905')],requested_count:5,received_count:1,omitted_count:0,
      truncated:false,selection_kind:'message_query_v1',exhaustive:false};},
  });
  const term='publisher physical programs',campaign=await h.campaign(term);
  await h.authorize(campaign);
  const first=await registered(h,campaign,'@first_channel');
  const second=corruption==='durable_candidate_mismatch'?await registered(h,campaign,'@other_channel'):null;
  const queued=await query(h,campaign,first,term),jobId=queued.job_ids[0];
  if(corruption==='unknown_cursor'){
    h.store.run("UPDATE scout_jobs SET cursor_json='{}' WHERE id=?",jobId);
  }else{
    h.store.run('UPDATE scout_jobs SET candidate_id=? WHERE id=?',second.id,jobId);
  }

  await h.runtime.tick();

  assert.equal(searches,0);
  assert.equal(histories,0);
  assert.equal(messageReads,0);
  assert.equal(h.store.get('SELECT status FROM scout_jobs WHERE id=?',jobId).status,'stale');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_query_receipts').n,0);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_samples').n,0);
});
