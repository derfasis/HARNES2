import test from 'node:test';
import assert from 'node:assert/strict';
import { id } from '../business/store.mjs';
import { sourceCheckpoint } from '../business/source-ingestion.mjs';
import { processScoutAssessment } from '../business/scout-reasoning.mjs';
import { ACCOUNT, channel, message, noHistory, scoutHarness } from './scout-test-helpers.mjs';

const grantArgs=(campaign,candidate,sample,extra={})=>({campaign_id:campaign.id,revision:campaign.revision,candidate_id:candidate.id,sample_id:sample.id,
  assessment_id:null,expires_at:new Date(Date.now()+86400000).toISOString(),purpose:'Explicit synthetic monitor test',max_lag_seconds:300,...extra});
const future=()=>new Date(Date.now()+86400000).toISOString();

test('create, authorize, seed and bounded audit persist a sample without ingesting business messages',async t=>{
  let reads=0;const h=scoutHarness(t,{history:async input=>++reads===1?{empty:false,requested_count:input.limit,received_count:1,oldest_id:1,messages:[message()]}:noHistory(input)});
  const c=await h.campaign();
  await assert.rejects(h.command('scout.authorize',{campaign_id:c.id,revision:c.revision,purpose:'',expires_at:future()},{kind:'agent'}),{code:'SCOUT_OPERATOR_REQUIRED'});
  const auditGrant=await h.authorize(c);assert.ok(auditGrant);
  const candidate=await h.seed(c);assert.equal(candidate.channel_id,'123456789');
  assert.equal(candidate.origin_json.includes('access_hash'),false);
  for(const table of ['scout_candidates','scout_grants','scout_jobs','scout_samples','scout_calls'])
    assert.equal(h.store.all(`PRAGMA table_info(${table})`).some(column=>column.name.toLowerCase().includes('access_hash')),false,table);
  const sample=await h.auditAndSeal(c,candidate);
  assert.equal(sample.status,'sealed');assert.equal(sample.coverage,'visible_history_end');
  assert.ok(Number.isSafeInteger(sample.source_cursor));
  assert.ok(sample.source_cursor<=h.store.get('SELECT COALESCE(MAX(id),0) head FROM events').head);
  assert.equal(JSON.parse(sample.messages_json).length,1);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind LIKE 'source.%'").n,0);
  assert.equal(sourceCheckpoint(h.service,sample.source_ref),null);
  for(const table of ['persons','conversations','messages','channel_identities','drafts','approvals','delivery_attempts','outcome_events'])
    assert.equal(h.store.get(`SELECT COUNT(*) n FROM ${table}`).n,0,table);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind LIKE 'scout.%'").n>0,true);
});

test('explicit search uses the bounded fake RPC and produces candidates without creating a source checkpoint',async t=>{
  const found=channel({channel_id:'223456789',username:'found_channel',title:'Search Fixture',kind:'group'});
  const h=scoutHarness(t,{search:async({query,limit})=>{assert.equal(query,'Search fixture topic');assert.ok(limit>0);return {candidates:[found]};},history:input=>noHistory(input)});
  const c=await h.campaign('Search fixture topic');await h.authorize(c);
  const queued=await h.command('scout.search',{campaign_id:c.id,revision:c.revision});assert.equal(queued.jobs[0].status,'queued');
  const result=await h.runtime.tick();assert.equal(result.disposition,'candidates_added');
  const candidate=h.store.get('SELECT * FROM scout_candidates WHERE campaign_id=?',c.id);assert.equal(candidate.channel_id,found.channel_id);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='source.message'").n,0);
  assert.equal(sourceCheckpoint(h.service,`telegram:channel:${found.channel_id}`),null);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_jobs WHERE campaign_id=? AND kind=\'history\'',c.id).n,1);
  await h.runtime.tick();
  const sample=h.store.get('SELECT * FROM scout_samples WHERE candidate_id=?',candidate.id);assert.equal(sample.status,'sealed');assert.equal(sample.coverage,'no_visible_messages');
});

test('monitor admission alone projects the existing dynamic source policy and never mutates configuration',async t=>{
  let reads=0;const h=scoutHarness(t,{history:async input=>++reads===1?{empty:false,requested_count:input.limit,received_count:1,oldest_id:1,messages:[message()]}:noHistory(input)});
  const c=await h.campaign();await h.authorize(c);const candidate=await h.seed(c),sample=await h.auditAndSeal(c,candidate);
  assert.deepEqual(h.effective().opportunity.telegramSources,[]);
  assert.deepEqual(h.effective().opportunity.allowedSourceRefs,[]);
  const admitted=await h.command('scout.admit',grantArgs(c,candidate,sample));assert.equal(admitted.contact_permission,false);
  const effective=h.effective(),sourceRef=`telegram:channel:${candidate.channel_id}`;
  assert.deepEqual(effective.opportunity.allowedSourceRefs,[sourceRef]);
  assert.equal(effective.opportunity.telegramSources[0].accountId,ACCOUNT);
  assert.deepEqual(h.config.opportunity.telegramSources,[]);assert.deepEqual(h.config.opportunity.allowedSourceRefs,[]);
  assert.equal(h.service.scout.monitorPolicies().length,1);
  await h.command('scout.revoke',{campaign_id:c.id,revision:c.revision,grant_id:admitted.grant_id});
  assert.deepEqual(h.effective().opportunity.allowedSourceRefs,[]);
  assert.deepEqual(h.config.opportunity.telegramSources,[]);
});

test('topic revision retires old authority, work and assessment; a new campaign reuses only sealed history',async t=>{
  let reads=0;const h=scoutHarness(t,{history:async input=>++reads===1?{empty:false,requested_count:input.limit,received_count:1,oldest_id:1,messages:[message()]}:noHistory(input)});
  const first=await h.campaign('First topic');await h.authorize(first);const oldCandidate=await h.seed(first),sample=await h.auditAndSeal(first,oldCandidate);
  const grantId=h.store.get("SELECT id FROM scout_grants WHERE campaign_id=? AND kind='audit'",first.id).id;
  h.store.run("INSERT INTO scout_assessments(id,campaign_id,campaign_revision,candidate_id,sample_id,sample_digest,topic_hash,evaluator_version,output_json,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    id(),first.id,first.revision,oldCandidate.id,sample.id,sample.digest,h.store.get('SELECT topic_hash FROM scout_campaigns WHERE id=?',first.id).topic_hash,'scout-assessment-v1','{}','proposed',new Date().toISOString());
  h.store.run("INSERT INTO scout_jobs(id,campaign_id,campaign_revision,grant_id,kind,status,cursor_json,next_at,created_at,updated_at) VALUES(?,?,?,?,?,'queued','{}',?,?,?)",
    id(),first.id,first.revision,grantId,'search',future(),new Date().toISOString(),new Date().toISOString());
  const revised=await h.command('scout.revise',{campaign_id:first.id,revision:first.revision,topic:'Revised topic',audience:'Revised audience',language:'en',geography:'global',queries:['revised query']});
  assert.equal(revised.revision,2);
  assert.equal(h.store.get('SELECT status FROM scout_grants WHERE id=?',grantId).status,'stale');
  assert.equal(h.store.get("SELECT COUNT(*) n FROM scout_jobs WHERE campaign_id=? AND status='stale'",first.id).n,1);
  assert.equal(h.store.get("SELECT status FROM scout_assessments WHERE campaign_id=?",first.id).status,'stale');
  await assert.rejects(h.command('scout.search',{campaign_id:first.id,revision:first.revision}),{code:'SCOUT_REVISION_CONFLICT'});
  const second=await h.campaign('Separate topic');await h.authorize(second);const secondCandidate=await h.seed(second);
  const secondSample=h.store.get('SELECT sample_id FROM scout_candidates WHERE id=?',secondCandidate.id).sample_id;
  assert.equal(secondSample,sample.id,'the new campaign may inspect the sealed historical sample');
  assert.equal(h.store.get("SELECT COUNT(*) n FROM scout_jobs WHERE campaign_id=? AND kind='history'",second.id).n,0,'reuse schedules no new history read');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_assessments WHERE campaign_id=?',second.id).n,0,'history reuse creates no topic assessment');
  await assert.rejects(h.command('scout.request_assessment',{campaign_id:second.id,revision:second.revision,candidate_id:secondCandidate.id,sample_id:sample.id}),{code:'SCOUT_MODEL_DISABLED'});
  h.config.scout.modelEnabled=true;
  await h.command('scout.request_assessment',{campaign_id:second.id,revision:second.revision,candidate_id:secondCandidate.id,sample_id:sample.id});
  const assessmentJob=h.store.get("SELECT * FROM scout_jobs WHERE campaign_id=? AND kind='assessment'",second.id);
  assert.equal(JSON.parse(assessmentJob.cursor_json).topic_hash,h.store.get('SELECT topic_hash FROM scout_campaigns WHERE id=?',second.id).topic_hash);
  assert.equal(JSON.parse(assessmentJob.cursor_json).evaluator_version,'scout-assessment-v1');
});

test('revoking authority while history RPC is pending withholds the page and keeps its cursor',async t=>{
  let started,release;const began=new Promise(resolve=>{started=resolve;}),blocked=new Promise(resolve=>{release=resolve;});
  const h=scoutHarness(t,{history:async input=>{started();await blocked;return noHistory(input);}});
  const c=await h.campaign();const auditGrant=await h.authorize(c);const candidate=await h.seed(c);
  const job=h.store.get("SELECT * FROM scout_jobs WHERE campaign_id=? AND kind='history' AND status='queued'",c.id),before=job.cursor_json;
  const running=h.runtime.tick();await began;
  await h.command('scout.revoke',{campaign_id:c.id,revision:c.revision,grant_id:auditGrant});release();
  const outcome=await running;assert.equal(outcome.disposition,'withheld');assert.equal(outcome.reason,'SCOUT_JOB_RETIRED');
  assert.equal(h.store.get('SELECT status FROM scout_jobs WHERE id=?',job.id).status,'stale');
  assert.equal(h.store.get('SELECT cursor_json FROM scout_jobs WHERE id=?',job.id).cursor_json,before);
  assert.equal(h.store.get('SELECT status FROM scout_samples WHERE id=?',job.sample_id).status,'collecting');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_samples WHERE candidate_id=? AND status=\'sealed\'',candidate.id).n,0);
});

test('partial history survives restart with its exact grant, cursor, request budget and account backoff',async t=>{
  let reads=0;const h=scoutHarness(t,{history:async input=>{
    reads++;
    if(reads===1)return {empty:false,requested_count:input.limit,received_count:1,oldest_id:50,messages:[message('50')]};
    if(reads===2){assert.equal(input.before_id,50);return {empty:false,requested_count:input.limit,received_count:1,oldest_id:49,messages:[message('49')]};}
    assert.equal(input.before_id,49);return noHistory(input);
  }});
  const c=await h.campaign();const grantId=await h.authorize(c);const candidate=await h.seed(c);
  await h.runtime.tick();
  const job=h.store.get("SELECT * FROM scout_jobs WHERE campaign_id=? AND kind='history'",c.id),sampleBefore=h.store.get('SELECT * FROM scout_samples WHERE id=?',job.sample_id);
  assert.equal(job.status,'queued');assert.equal(JSON.parse(job.cursor_json).before_id,50);
  const budgetBefore=h.store.get('SELECT COUNT(*) n FROM scout_calls WHERE account_id=?',ACCOUNT).n;
  const call=h.store.get('SELECT * FROM scout_calls WHERE account_id=? ORDER BY created_at DESC LIMIT 1',ACCOUNT);
  const retryAt=new Date(Date.now()+60000).toISOString();h.store.run('UPDATE scout_calls SET retry_at=? WHERE id=?',retryAt,call.id);
  h.store.run("UPDATE scout_jobs SET status='running',owner_id=?,attempts=attempts+1 WHERE id=?",h.service.control.ownerId,job.id);
  h.store.run("UPDATE scout_calls SET status='started',finished_at=NULL WHERE id=?",call.id);
  h.restart();
  await h.service.exclusive(()=>h.store.transaction(()=>h.service.scout.reconcile()));
  const recovered=h.store.get('SELECT * FROM scout_jobs WHERE id=?',job.id);
  assert.equal(recovered.status,'queued');assert.equal(recovered.grant_id,grantId);assert.equal(recovered.sample_id,sampleBefore.id);
  assert.equal(JSON.parse(recovered.cursor_json).before_id,50);
  // Make the recovered page due; its original one-second pagination cadence
  // must not turn this backoff assertion into a wall-clock timing dependency.
  h.store.run('UPDATE scout_jobs SET next_at=? WHERE id=?',new Date(Date.now()-1000).toISOString(),job.id);
  await h.runtime.tick();
  const backedOff=h.store.get('SELECT * FROM scout_jobs WHERE id=?',job.id);
  assert.equal(backedOff.status,'queued');assert.equal(backedOff.reason,'SCOUT_ACCOUNT_BACKOFF');
  assert.ok(Date.parse(backedOff.next_at)>=Date.parse(retryAt));assert.equal(reads,1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_calls WHERE account_id=?',ACCOUNT).n,budgetBefore);
  assert.equal(h.store.get('SELECT status FROM scout_calls WHERE id=?',call.id).status,'unknown');
  h.store.run('UPDATE scout_calls SET retry_at=? WHERE id=?',new Date(Date.now()-1000).toISOString(),call.id);
  h.store.run('UPDATE scout_jobs SET next_at=? WHERE id=?',new Date(Date.now()-1000).toISOString(),job.id);
  await h.runtime.tick();
  const sampleAfter=h.store.get('SELECT * FROM scout_samples WHERE id=?',sampleBefore.id);
  assert.equal(sampleAfter.status,'collecting');assert.deepEqual(JSON.parse(sampleAfter.messages_json).map(m=>m.message_id),['50','49']);
  h.store.run('UPDATE scout_jobs SET next_at=? WHERE id=?',new Date(Date.now()-1000).toISOString(),job.id);await h.runtime.tick();
  assert.equal(h.store.get('SELECT status FROM scout_samples WHERE id=?',sampleBefore.id).status,'sealed');
  assert.equal(h.store.get('SELECT grant_id FROM scout_jobs WHERE id=?',job.id).grant_id,grantId);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM scout_calls WHERE account_id=?',ACCOUNT).n,budgetBefore+4);
  assert.equal(h.store.get('SELECT sample_id FROM scout_candidates WHERE id=?',candidate.id).sample_id,sampleBefore.id);
});

test('an inaccessible history read stays unknown while an explicit empty page is sealed as empty',async t=>{
  const unavailable=scoutHarness(t,{history:async()=>{throw Object.assign(new Error('opaque fixture access failure'),{code:'SCOUT_RPC_HISTORY_UNAVAILABLE'});}});
  const c=await unavailable.campaign();await unavailable.authorize(c);const candidate=await unavailable.seed(c);
  const job=unavailable.store.get("SELECT * FROM scout_jobs WHERE campaign_id=? AND kind='history'",c.id);
  await unavailable.runtime.tick();
  const failed=unavailable.store.get('SELECT * FROM scout_jobs WHERE id=?',job.id);
  assert.equal(failed.status,'failed');assert.equal(failed.reason,'SCOUT_RPC_HISTORY_UNAVAILABLE');
  assert.equal(unavailable.store.get('SELECT status FROM scout_samples WHERE id=?',job.sample_id).status,'collecting');
  assert.equal(unavailable.store.get('SELECT sample_id FROM scout_candidates WHERE id=?',candidate.id).sample_id,null);
  const empty=scoutHarness(t,{history:noHistory});
  const c2=await empty.campaign();await empty.authorize(c2);const candidate2=await empty.seed(c2);await empty.runtime.tick();
  const sample=empty.store.get('SELECT * FROM scout_samples WHERE candidate_id=?',candidate2.id);
  assert.equal(sample.status,'sealed');assert.equal(sample.coverage,'no_visible_messages');
});

test('invalid history cursor cannot seal a page and opaque reply anchors are omitted from semantic evidence',async t=>{
  let reads=0;const h=scoutHarness(t,{history:async input=>{
    reads++;if(reads===1)return {empty:false,requested_count:input.limit,received_count:1,oldest_id:80,messages:[message('80')]};
    if(reads===2&&input.before_id===80)return {empty:false,requested_count:input.limit,received_count:1,oldest_id:80,messages:[message('79')]};
    if(reads===3&&input.before_id===80){
      const opaque=message('70',{text:null,unsupported:true,content_hash:'a'.repeat(64)});
      const reply=message('71',{reply_to:'70',text:'Reply to an opaque parent.'});
      const meaningful=message('72',{reply_to:null,text:'A separate visible statement.'});
      return {empty:false,requested_count:input.limit,received_count:3,oldest_id:70,messages:[opaque,reply,meaningful]};
    }
    if(reads===4)return noHistory(input);
    return noHistory(input);
  }});
  const c=await h.campaign();await h.authorize(c);const candidate=await h.seed(c);await h.runtime.tick();
  const job=h.store.get("SELECT * FROM scout_jobs WHERE campaign_id=? AND kind='history'",c.id);
  h.store.run('UPDATE scout_jobs SET next_at=? WHERE id=?',new Date(Date.now()-1000).toISOString(),job.id);
  await assert.rejects(h.runtime.tick(),{code:'SCOUT_HISTORY_CURSOR_INVALID'});
  assert.equal(h.store.get('SELECT status FROM scout_samples WHERE id=?',job.sample_id).status,'collecting');
  assert.equal(JSON.parse(h.store.get('SELECT cursor_json FROM scout_jobs WHERE id=?',job.id).cursor_json).before_id,80);
  h.store.run('UPDATE scout_jobs SET status=\'queued\',next_at=? WHERE id=?',new Date(Date.now()-1000).toISOString(),job.id);
  await h.runtime.tick();
  h.store.run('UPDATE scout_jobs SET next_at=? WHERE id=?',new Date(Date.now()-1000).toISOString(),job.id);
  await h.runtime.tick();
  const sample=h.store.get('SELECT * FROM scout_samples WHERE id=?',job.sample_id);assert.equal(sample.status,'sealed');
  const presentation=h.service.scout.presentation(h.service.scout.campaign(c.id)),shown=presentation.candidates.find(x=>x.id===candidate.id).sample;
  assert.equal(shown.metrics.unsupported,1);assert.equal(shown.metrics.replies,1);
  assert.ok(shown.groups.every(group=>!group.evidence_refs.includes('70')&&!group.evidence_refs.includes('71')));
  assert.ok(shown.groups.some(group=>group.evidence_refs.includes('72')));
});

test('source edits and deletes after the sample cursor stale only the historical evidence basis',async t=>{
  for(const operation of ['edit','delete']){
    let reads=0;const h=scoutHarness(t,{history:async input=>++reads===1?{empty:false,requested_count:input.limit,received_count:1,oldest_id:1,messages:[message()]}:noHistory(input)});
    const c=await h.campaign(`Freshness ${operation}`);await h.authorize(c);const candidate=await h.seed(c),sample=await h.auditAndSeal(c,candidate);
    assert.equal(h.service.scout.sample(sample.id,candidate).status,'sealed');
    h.store.event(h.config.partnerId,null,operation==='delete'?'source.telegram.tombstone':'source.message','channel',{
      source_id:sample.source_ref,message_id:'message:1',operation,text:operation==='delete'?null:'Changed synthetic source text'});
    const laterId=h.store.get('SELECT MAX(id) id FROM events').id;assert.ok(laterId>sample.source_cursor);
    assert.throws(()=>h.service.scout.sample(sample.id,candidate),{code:'SCOUT_SAMPLE_STALE'});
    assert.equal(h.store.get('SELECT status FROM scout_samples WHERE id=?',sample.id).status,'sealed','the historic bytes remain immutable');
    assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind IN ('source.message','source.telegram.tombstone')").n,1);
  }
});

test('model-off requests create no assessment job or run; opt-in only queues topic-bound work',async t=>{
  let reads=0;const h=scoutHarness(t,{modelEnabled:false,history:async input=>++reads===1?{empty:false,requested_count:input.limit,received_count:1,oldest_id:1,messages:[message()]}:noHistory(input)});
  const c=await h.campaign('Model-off topic');await h.authorize(c);const candidate=await h.seed(c),sample=await h.auditAndSeal(c,candidate);
  const request={campaign_id:c.id,revision:c.revision,candidate_id:candidate.id,sample_id:sample.id};
  await assert.rejects(h.command('scout.request_assessment',request),{code:'SCOUT_MODEL_DISABLED'});
  let calls=0;const result=await processScoutAssessment(h.service,{decide:async()=>{calls++;throw new Error('Model access forbidden in this test');}});
  assert.deepEqual(result,{disposition:'disabled'});assert.equal(calls,0);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM scout_jobs WHERE campaign_id=? AND kind='assessment'",c.id).n,0);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM runs WHERE runtime='hermes-scout-v1'").n,0);
  h.config.scout.modelEnabled=true;
  await h.command('scout.request_assessment',request);
  const queued=h.store.get("SELECT cursor_json FROM scout_jobs WHERE campaign_id=? AND kind='assessment'",c.id);
  assert.equal(JSON.parse(queued.cursor_json).topic_hash,h.store.get('SELECT topic_hash FROM scout_campaigns WHERE id=?',c.id).topic_hash);
  assert.equal(calls,0);assert.equal(h.store.get("SELECT COUNT(*) n FROM runs WHERE runtime='hermes-scout-v1'").n,0);
});
