// Durable query selections and inert hypotheses; never canonical source ingestion.
import { id } from './store.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { AppError, now, requiredText } from './errors.mjs';
import { digest } from './source-ingestion.mjs';
import { sourceObservationFloor } from './source-observation-epochs.mjs';
import { scoutQueryOutput, scoutQueryStoredOutput, SCOUT_QUERY_CONTRACT } from './scout-query-output.mjs';

export const SCOUT_QUERY_EVALUATOR='scout-query-intent-v1';
export const SCOUT_QUERY_INSTRUCTIONS=fs.readFileSync(path.join(ROOT,'partner/scout-query-intent.md'),'utf8').replace(/\r\n/g,'\n');
const check=(ok,code='SCOUT_QUERY_INVALID')=>{if(!ok)throw new AppError(code,409,code);};
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const native=x=>typeof x==='string'&&/^[1-9][0-9]{0,18}$/.test(x);
const username=x=>typeof x==='string'&&/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(x);
const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===keys.split(',').sort().join(',');
const fields=(p,keys)=>check(p&&typeof p==='object'&&!Array.isArray(p)&&Object.keys(p).every(k=>keys.includes(k)),'SCOUT_FIELDS_INVALID');
const parse=raw=>{try{return JSON.parse(raw);}catch{check(false);}};
const REQUEST_KEYS='version,id,partner_id,job_id,campaign_id,campaign_revision,topic_hash,audit_grant_id,account_id,candidate_id,channel_id,public_username,source_ref,query,from,until,limit,observation_floor,created_at';
const MODEL_KEYS='version,basis_kind,id,partner_id,job_id,campaign_id,campaign_revision,topic_hash,audit_grant_id,account_id,candidate_id,channel_id,source_ref,receipt_id,receipt_digest,query_request_id,receipt_retrieved_at,receipt_source_cursor,evaluator_version,model_profile_id,profile_hash,purpose,execution_bounds,model_config,expires_at,created_at';

export class ScoutQueries {
 constructor(service){this.service=service;this.db=service.store;}
 get scout(){return this.service.scout;}
 get partnerId(){return this.service.config.partnerId;}
 sourceCursor(){return this.db.get('SELECT COALESCE(MAX(id),0) n FROM events WHERE partner_id=?',this.partnerId).n;}
 isQueryJob(job){
   const cursor=parse(job.cursor_json);
   check(cursor&&typeof cursor==='object'&&!Array.isArray(cursor),'SCOUT_QUERY_CURSOR_INVALID');
   const associated=!!this.db.get('SELECT id FROM scout_message_queries WHERE job_id=?',job.id);
   // A foreign/unknown discriminant is never an ordinary username search.
   check(cursor.mode===undefined||job.kind==='search'&&cursor.mode==='message_query_v1'||job.kind==='assessment'&&cursor.mode==='query_intent_v1','SCOUT_QUERY_CURSOR_INVALID');
   if(job.kind==='search'&&!associated&&cursor.mode===undefined)check(exact(cursor,'query')&&typeof cursor.query==='string'&&cursor.query.trim(),'SCOUT_QUERY_CURSOR_INVALID');
   return associated||cursor.mode==='message_query_v1';
 }
 definition(row){
   check(row&&row.partner_id===this.partnerId&&hash(row.definition_hash));const d=parse(row.definition_json);
   check(exact(d,REQUEST_KEYS)&&d.version===1&&d.id===row.id&&uuid(d.id)&&d.partner_id===this.partnerId
     &&uuid(d.job_id)&&d.job_id===row.job_id&&uuid(d.campaign_id)&&d.campaign_id===row.campaign_id
     &&uuid(d.candidate_id)&&d.candidate_id===row.candidate_id&&uuid(d.audit_grant_id)&&d.audit_grant_id===row.grant_id
     &&Number.isInteger(d.campaign_revision)&&d.campaign_revision>0&&hash(d.topic_hash)
     &&native(d.account_id)&&native(d.channel_id)&&username(d.public_username)&&d.source_ref===`telegram:channel:${d.channel_id}`
     &&typeof d.query==='string'&&d.query.trim()===d.query&&d.query.length>0&&d.query.length<=200
     &&iso(d.from)&&iso(d.until)&&d.until===d.created_at&&d.created_at===row.created_at
     &&Date.parse(d.until)>Date.parse(d.from)&&Date.parse(d.until)-Date.parse(d.from)<=30*86400000
     &&Number.isInteger(d.limit)&&d.limit>=1&&d.limit<=100&&Number.isSafeInteger(d.observation_floor)&&d.observation_floor>=0
     &&digest(d)===row.definition_hash);
   return d;
 }
 assertRead(job,{runtime=true}={}){
   const row=this.db.get('SELECT * FROM scout_message_queries WHERE job_id=? AND partner_id=?',job?.id,this.partnerId),definition=this.definition(row);
   const d=definition,cursor=parse(job.cursor_json),{campaign,grant}=this.scout.jobAuthority(job,{runtime});
   check(job.kind==='search'&&job.sample_id===null&&job.id===d.job_id&&job.campaign_id===d.campaign_id
     &&job.campaign_revision===d.campaign_revision&&job.grant_id===d.audit_grant_id&&job.candidate_id===d.candidate_id
     &&campaign.topic_hash===d.topic_hash&&campaign.revision===d.campaign_revision&&grant.account_id===d.account_id
     &&exact(cursor,'mode,query_request_id,request_digest')&&cursor.mode==='message_query_v1'
     &&cursor.query_request_id===row.id&&cursor.request_digest===row.definition_hash,'SCOUT_QUERY_BINDING_INVALID');
   const candidate=this.scout.candidate(d.candidate_id,campaign.id);
   check(candidate.channel_id===d.channel_id&&candidate.account_id===d.account_id
     &&candidate.username?.toLowerCase()===d.public_username.toLowerCase(),'SCOUT_QUERY_SOURCE_CHANGED');
   check(JSON.parse(campaign.config_json).queries.includes(d.query),'SCOUT_QUERY_BINDING_INVALID');
   check(d.observation_floor===sourceObservationFloor(this.service,d.source_ref),'SCOUT_QUERY_STALE');
   return {request:row,row,definition,candidate,campaign,grant};
 }
 command(action,p){
   const c=this.scout.campaign(p.campaign_id);this.scout.revision(c,p);this.scout.current(c);
   if(action==='scout.review_query')return this.review(p,c);
   const grant=this.scout.auditGrant(c);
   if(action==='scout.request_query_assessment')return this.requestAssessment(p,c,grant);
   fields(p,['campaign_id','revision','candidate_ids','queries','window_days','limit']);
   check(Array.isArray(p.candidate_ids)&&p.candidate_ids.length>=1&&p.candidate_ids.length<=10
     &&new Set(p.candidate_ids).size===p.candidate_ids.length&&p.candidate_ids.every(uuid),'SCOUT_QUERY_SOURCES_INVALID');
   const configured=JSON.parse(c.config_json).queries;
   check(Array.isArray(p.queries)&&p.queries.length>=1&&p.queries.length<=10&&new Set(p.queries).size===p.queries.length
     &&p.queries.every(q=>configured.includes(q))&&p.queries.length*p.candidate_ids.length<=20,'SCOUT_QUERIES_INVALID');
   check(Number.isInteger(p.window_days)&&p.window_days>=1&&p.window_days<=30
     &&Number.isInteger(p.limit)&&p.limit>=1&&p.limit<=100,'SCOUT_QUERY_BOUNDS_INVALID');
   check(this.db.get('SELECT COUNT(*) n FROM scout_jobs WHERE campaign_id=?',c.id).n+p.queries.length*p.candidate_ids.length<=300,'SCOUT_JOB_HISTORY_CAPACITY');
   const created_at=now(),from=new Date(Date.parse(created_at)-p.window_days*86400000).toISOString(),request_ids=[],job_ids=[];
   for(const candidateId of p.candidate_ids){
     const candidate=this.scout.candidate(candidateId,c.id);
     check(candidate.account_id===grant.account_id&&username(candidate.username),'SCOUT_QUERY_PUBLIC_SOURCE_REQUIRED');
     for(const query of p.queries){
       const requestId=id(),jobId=id(),d={version:1,id:requestId,partner_id:this.partnerId,job_id:jobId,campaign_id:c.id,
         campaign_revision:c.revision,topic_hash:c.topic_hash,audit_grant_id:grant.id,account_id:grant.account_id,
         candidate_id:candidate.id,channel_id:candidate.channel_id,public_username:candidate.username,source_ref:`telegram:channel:${candidate.channel_id}`,
         query,from,until:created_at,limit:p.limit,observation_floor:sourceObservationFloor(this.service,`telegram:channel:${candidate.channel_id}`),created_at};
       const fingerprint=digest(d),cursor={mode:'message_query_v1',query_request_id:requestId,request_digest:fingerprint};
       this.db.run("INSERT INTO scout_jobs(id,campaign_id,campaign_revision,grant_id,candidate_id,kind,status,cursor_json,next_at,created_at,updated_at) VALUES(?,?,?,?,?,'search','queued',?,?,?,?)",jobId,c.id,c.revision,grant.id,candidate.id,JSON.stringify(cursor),created_at,created_at,created_at);
       this.db.run('INSERT INTO scout_message_queries VALUES(?,?,?,?,?,?,?,?,?)',requestId,this.partnerId,c.id,candidate.id,grant.id,jobId,JSON.stringify(d),fingerprint,created_at);
       request_ids.push(requestId);job_ids.push(jobId);
     }
   }
   this.scout.event('message_queries.requested',{campaign_id:c.id,request_ids,job_ids,contact_permission:false});
   return {request_ids,job_ids,status:'queued',contact_permission:false,allowed_effects:[]};
 }
 validateMessages(messages,d){
   check(Array.isArray(messages)&&messages.length<=d.limit,'SCOUT_QUERY_PAGE_INVALID');const seen=new Set();
   return messages.map(m=>{
     check(m&&native(m.message_id)&&Number(m.message_id)<=2147483647&&!seen.has(m.message_id)
       &&iso(m.date)&&Date.parse(m.date)>=Date.parse(d.from)&&Date.parse(m.date)<=Date.parse(d.until)
       &&hash(m.content_hash)&&(m.text===null||typeof m.text==='string'&&m.text.length<=16000)
       &&(m.author_ref===null||typeof m.author_ref==='string'&&m.author_ref.length<=100)
       &&(m.edit_date==null||iso(m.edit_date))
       &&(m.reply_to==null||native(m.reply_to))
       &&(m.reply_to_source==null||/^telegram:(?:channel|user|chat):[1-9][0-9]{0,18}$/.test(m.reply_to_source))
       &&(m.unsupported==null||m.unsupported===false||typeof m.unsupported==='string'&&m.unsupported.length<=200),'SCOUT_QUERY_MESSAGE_INVALID');
     check(!m.unsupported||m.text===null,'SCOUT_QUERY_MESSAGE_INVALID');seen.add(m.message_id);
     // Reconstruct safe public links from the pinned source, not untrusted content.
     return {message_id:m.message_id,author_ref:m.author_ref,date:m.date,edit_date:m.edit_date??null,text:m.text,
       reply_to:m.reply_to??null,reply_to_source:m.reply_to_source??null,unsupported:m.unsupported||null,content_hash:m.content_hash,
       link:`https://t.me/${d.public_username}/${m.message_id}`};
   });
 }
 applyReceipt(job,page,callId,sourceCursor){
   const {request,definition:d}=this.assertRead(job);
   check(Number.isSafeInteger(sourceCursor)&&sourceCursor>=d.observation_floor&&sourceCursor<=this.sourceCursor(),'SCOUT_QUERY_CURSOR_INVALID');
   const call=this.db.get('SELECT * FROM scout_calls WHERE id=? AND job_id=?',callId,job.id);
   check(call&&call.partner_id===this.partnerId&&call.account_id===d.account_id&&call.source_ref===d.source_ref
     &&call.status==='completed'&&call.operation==='message_query_v1','SCOUT_QUERY_CALL_INVALID');
   check(page&&page.selection_kind==='message_query_v1'&&page.exhaustive===false
     &&page.requested_count===d.limit
     &&Number.isInteger(page.received_count)&&page.received_count>=0&&page.received_count<=page.requested_count
     &&Number.isInteger(page.omitted_count)&&page.omitted_count>=0&&Array.isArray(page.messages)
     &&page.messages.length+page.omitted_count===page.received_count&&typeof page.truncated==='boolean'
     &&page.truncated===(page.received_count>=page.requested_count),'SCOUT_QUERY_PAGE_INVALID');
   const receiptId=id(),created_at=now(),messages=this.validateMessages(page.messages,d);
   const content={version:1,id:receiptId,query_request_id:request.id,request_digest:request.definition_hash,
     source_ref:d.source_ref,account_id:d.account_id,query:d.query,from:d.from,until:d.until,source_cursor:sourceCursor,retrieved_at:created_at,
     selection:{kind:'message_query_v1',requested_count:page.requested_count,received_count:page.received_count,returned_count:messages.length,
       omitted_count:page.omitted_count,limit:d.limit,truncated:page.truncated,exhaustive:false},messages};
   this.db.run('INSERT INTO scout_query_receipts VALUES(?,?,?,?,?,?,?)',receiptId,request.id,callId,sourceCursor,JSON.stringify(content),digest(content),created_at);
   // A concurrent native edit/delete observed after read admission wins over the frozen page.
   this.receipt(receiptId);
   return {receipt_id:receiptId};
 }
 receipt(receiptId,{current=true,runtime=false}={}){
   const row=this.db.get('SELECT r.* FROM scout_query_receipts r JOIN scout_message_queries q ON q.id=r.query_request_id WHERE r.id=? AND q.partner_id=?',receiptId,this.partnerId);
   check(row,'SCOUT_QUERY_RECEIPT_NOT_FOUND');const content=parse(row.content_json);
   check(hash(row.content_hash)&&digest(content)===row.content_hash&&exact(content,'version,id,query_request_id,request_digest,source_ref,account_id,query,from,until,source_cursor,retrieved_at,selection,messages')
     &&content.version===1&&content.id===row.id&&content.query_request_id===row.query_request_id&&content.source_cursor===row.source_cursor
     &&content.retrieved_at===row.created_at&&iso(row.created_at),'SCOUT_QUERY_RECEIPT_INVALID');
   const request=this.db.get('SELECT * FROM scout_message_queries WHERE id=?',row.query_request_id),d=this.definition(request);
   check(content.request_digest===request.definition_hash&&content.source_ref===d.source_ref&&content.account_id===d.account_id
     &&content.query===d.query&&content.from===d.from&&content.until===d.until&&Number.isSafeInteger(row.source_cursor)&&row.source_cursor>=d.observation_floor&&row.source_cursor<=this.sourceCursor(),'SCOUT_QUERY_RECEIPT_INVALID');
   const messages=this.validateMessages(content.messages,d);check(digest(messages)===digest(content.messages),'SCOUT_QUERY_RECEIPT_INVALID');
   const s=content.selection;check(exact(s,'kind,requested_count,received_count,returned_count,omitted_count,limit,truncated,exhaustive')
     &&s.kind==='message_query_v1'&&s.exhaustive===false&&s.limit===d.limit&&s.requested_count===d.limit
     &&Number.isInteger(s.received_count)&&s.received_count>=0&&s.received_count<=s.requested_count&&s.returned_count===messages.length
     &&s.omitted_count===s.received_count-s.returned_count&&s.omitted_count>=0&&s.truncated===(s.received_count>=s.requested_count),'SCOUT_QUERY_RECEIPT_INVALID');
   const job=this.db.get('SELECT * FROM scout_jobs WHERE id=?',d.job_id),call=this.db.get('SELECT * FROM scout_calls WHERE id=?',row.attempt_call_id);
   check(call?.status==='completed'&&call.partner_id===this.partnerId&&call.operation==='message_query_v1'&&call.job_id===job?.id&&call.account_id===d.account_id&&call.source_ref===d.source_ref,'SCOUT_QUERY_RECEIPT_INVALID');
   if(current){
     this.assertRead(job,{runtime});
     check(Date.parse(row.created_at)<=Date.now()+30000&&Date.now()-Date.parse(row.created_at)<=this.scout.cfg.auditMaxAgeSeconds*1000,'SCOUT_QUERY_STALE');
     if(messages.length){
       const changed=this.db.get(`SELECT id FROM events WHERE partner_id=? AND kind IN ('source.message','source.telegram.tombstone')
         AND json_extract(payload_json,'$.source_id')=? AND json_extract(payload_json,'$.message_id') IN (SELECT value FROM json_each(?)) AND id>? LIMIT 1`,
       this.partnerId,d.source_ref,JSON.stringify(messages.map(m=>`message:${m.message_id}`)),row.source_cursor);
       check(!changed,'SCOUT_QUERY_STALE');
     }
   }
   return {row,content,request,definition:d,job};
 }
 packet(receipt){
   const supported=[],excluded={opaque:0,oversize:0,capacity:0},rows=receipt.content.messages;let chars=0;
   for(const m of rows){
     if(m.unsupported||typeof m.text!=='string'||!m.text.trim()){excluded.opaque++;continue;}
     if(m.text.length>12000){excluded.oversize++;continue;}
     if(chars+m.text.length>24000){excluded.capacity++;continue;}
     chars+=m.text.length;supported.push({...m});
   }
   for(const m of supported)m.missing_parent=!!m.reply_to&&(!supported.some(p=>p.message_id===m.reply_to)||!!m.reply_to_source&&m.reply_to_source!==receipt.definition.source_ref);
   return {receipt_id:receipt.row.id,receipt_digest:receipt.row.content_hash,source_ref:receipt.definition.source_ref,
     query:receipt.definition.query,from:receipt.definition.from,until:receipt.definition.until,retrieved_at:receipt.row.created_at,
     selection:receipt.content.selection,messages:supported,excluded,complete_history:false,current_intent:'unknown',offer_fit:'unknown',contact_permission:false,allowed_effects:[]};
 }
 requestAssessment(p,c,grant){
   fields(p,['campaign_id','revision','receipt_id','expected_receipt_digest','model_profile_id','expected_model_profile_hash','purpose','expires_at']);
   const receipt=this.receipt(p.receipt_id,{runtime:true}),q=receipt.definition;
   check(q.campaign_id===c.id&&q.audit_grant_id===grant.id&&receipt.row.content_hash===p.expected_receipt_digest,'SCOUT_QUERY_STALE');
   check(this.packet(receipt).messages.length>0,'SCOUT_QUERY_SEMANTIC_EMPTY');
   const models=this.scout.modelRequests;models.managedActivation();
   const {profile,model_config,execution_bounds}=models.profile(p.model_profile_id,p.expected_model_profile_hash);
   check(iso(p.expires_at)&&Date.parse(p.expires_at)>Date.now()&&Date.parse(p.expires_at)<=Date.now()+86400000,'SCOUT_MODEL_REQUEST_EXPIRY_INVALID');
   const purpose=requiredText(p.purpose,'purpose',500),prior=this.db.get(`SELECT r.*,j.status job_status FROM scout_model_requests r JOIN scout_jobs j ON j.id=r.job_id WHERE r.partner_id=?
     AND json_extract(r.definition_json,'$.basis_kind')='message_query_receipt' AND json_extract(r.definition_json,'$.receipt_id')=?
     AND json_extract(r.definition_json,'$.model_profile_id')=? AND json_extract(r.definition_json,'$.profile_hash')=?
     AND json_extract(r.definition_json,'$.purpose')=? AND r.expires_at=? LIMIT 1`,this.partnerId,receipt.row.id,profile.profile_id,profile.definition_hash,purpose,p.expires_at);
   if(prior){models.validateDefinition(prior);return {request_id:prior.id,job_id:prior.job_id,fingerprint:prior.request_fingerprint,status:prior.job_status,reused:true};}
   check(!this.db.get(`SELECT r.id FROM scout_model_requests r JOIN scout_jobs j ON j.id=r.job_id WHERE r.partner_id=? AND r.status='active' AND r.expires_at>?
     AND j.status IN ('queued','running') AND json_extract(r.definition_json,'$.receipt_id')=?`,this.partnerId,now(),receipt.row.id),'SCOUT_MODEL_REQUEST_PENDING');
   check(this.db.get('SELECT COUNT(*) n FROM scout_jobs WHERE campaign_id=?',c.id).n<300,'SCOUT_JOB_HISTORY_CAPACITY');
   const requestId=id(),jobId=id(),created_at=now(),d={version:2,basis_kind:'message_query_receipt',id:requestId,partner_id:this.partnerId,job_id:jobId,
     campaign_id:c.id,campaign_revision:c.revision,topic_hash:c.topic_hash,audit_grant_id:grant.id,account_id:q.account_id,candidate_id:q.candidate_id,channel_id:q.channel_id,source_ref:q.source_ref,
     receipt_id:receipt.row.id,receipt_digest:receipt.row.content_hash,query_request_id:q.id,receipt_retrieved_at:receipt.row.created_at,receipt_source_cursor:receipt.row.source_cursor,
     evaluator_version:SCOUT_QUERY_EVALUATOR,model_profile_id:profile.profile_id,profile_hash:profile.definition_hash,purpose,execution_bounds,model_config,expires_at:p.expires_at,created_at};
   const fingerprint=digest(d),cursor={mode:'query_intent_v1',receipt_id:d.receipt_id,receipt_digest:d.receipt_digest,topic_hash:c.topic_hash,evaluator_version:SCOUT_QUERY_EVALUATOR};
   this.db.run("INSERT INTO scout_jobs(id,campaign_id,campaign_revision,grant_id,candidate_id,kind,status,cursor_json,next_at,created_at,updated_at) VALUES(?,?,?,?,?,'assessment','queued',?,?,?,?)",jobId,c.id,c.revision,grant.id,q.candidate_id,JSON.stringify(cursor),created_at,created_at,created_at);
   this.db.run("INSERT INTO scout_model_requests VALUES(?,?,?,NULL,?,?,?,?,'active',NULL,NULL)",requestId,this.partnerId,jobId,profile.profile_id,JSON.stringify(d),fingerprint,d.expires_at);
   this.scout.event('query_assessment.requested',{request_id:requestId,job_id:jobId,receipt_id:d.receipt_id,request_fingerprint:fingerprint,contact_permission:false});
   return {request_id:requestId,job_id:jobId,fingerprint,status:'queued',reused:false};
 }
 validateModelDefinition(row,d){
   check(exact(d,MODEL_KEYS)&&d.version===2&&d.basis_kind==='message_query_receipt'&&d.id===row.id&&d.partner_id===row.partner_id&&d.job_id===row.job_id
     &&d.model_profile_id===row.model_profile_id&&d.expires_at===row.expires_at&&uuid(d.campaign_id)&&Number.isInteger(d.campaign_revision)&&d.campaign_revision>0
     &&hash(d.topic_hash)&&uuid(d.audit_grant_id)&&native(d.account_id)&&uuid(d.candidate_id)&&native(d.channel_id)&&d.source_ref===`telegram:channel:${d.channel_id}`
     &&uuid(d.receipt_id)&&hash(d.receipt_digest)&&uuid(d.query_request_id)&&iso(d.receipt_retrieved_at)&&Number.isSafeInteger(d.receipt_source_cursor)&&d.receipt_source_cursor>=0
     &&d.evaluator_version===SCOUT_QUERY_EVALUATOR&&hash(d.profile_hash)&&typeof d.purpose==='string'&&d.purpose.trim().length>0&&d.purpose.length<=500
     &&exact(d.execution_bounds,'timeout_seconds,max_api_calls,max_iterations,max_output_tokens')&&Number.isInteger(d.execution_bounds.timeout_seconds)&&d.execution_bounds.timeout_seconds>=10&&d.execution_bounds.timeout_seconds<=1800
     &&d.execution_bounds.max_api_calls===1&&d.execution_bounds.max_iterations===2&&Number.isInteger(d.execution_bounds.max_output_tokens)&&d.execution_bounds.max_output_tokens>0
     &&exact(d.model_config,'provider,apiMode,baseUrl,model,maxOutputTokens,inputUsdPerMillion,outputUsdPerMillion,timeoutSeconds,maxApiCalls,maxIterations')
     &&d.model_config.timeoutSeconds===d.execution_bounds.timeout_seconds&&d.model_config.maxApiCalls===1&&d.model_config.maxIterations===2&&d.model_config.maxOutputTokens===d.execution_bounds.max_output_tokens
     &&iso(d.created_at)&&iso(d.expires_at)&&Date.parse(d.expires_at)>Date.parse(d.created_at)&&Date.parse(d.expires_at)<=Date.parse(d.created_at)+86400000
     &&(row.run_id===null||uuid(row.run_id))&&['active','revoked'].includes(row.status)
     &&(row.status==='active'?row.revoked_at===null&&row.revocation_reason===null:iso(row.revoked_at)&&typeof row.revocation_reason==='string'&&row.revocation_reason.trim())
     &&digest(d)===row.request_fingerprint,'SCOUT_MODEL_REQUEST_INVALID');return d;
 }
 modelBasis(d,job,{runtime=false}={}){
   const receipt=this.receipt(d.receipt_id,{runtime}),q=receipt.definition,cursor=parse(job.cursor_json);
   check(job.sample_id===null&&q.campaign_id===d.campaign_id&&q.campaign_revision===d.campaign_revision&&q.topic_hash===d.topic_hash
     &&q.audit_grant_id===d.audit_grant_id&&q.account_id===d.account_id&&q.candidate_id===d.candidate_id&&q.channel_id===d.channel_id&&q.source_ref===d.source_ref
     &&q.id===d.query_request_id&&receipt.row.content_hash===d.receipt_digest&&receipt.row.created_at===d.receipt_retrieved_at&&receipt.row.source_cursor===d.receipt_source_cursor
     &&exact(cursor,'mode,receipt_id,receipt_digest,topic_hash,evaluator_version')&&cursor.mode==='query_intent_v1'&&cursor.receipt_id===d.receipt_id
     &&cursor.receipt_digest===d.receipt_digest&&cursor.topic_hash===d.topic_hash&&cursor.evaluator_version===SCOUT_QUERY_EVALUATOR,'SCOUT_MODEL_REQUEST_STALE');
   const packet=this.packet(receipt);check(packet.messages.length>0,'SCOUT_QUERY_SEMANTIC_EMPTY');return {receipt,packet};
 }
 assertRunBasis(frozen,d){
   const receipt=this.receipt(d.receipt_id);
   check(frozen.receipt_id===d.receipt_id&&frozen.receipt_digest===d.receipt_digest&&frozen.basis_kind===d.basis_kind
     &&frozen.evaluator_version===SCOUT_QUERY_EVALUATOR&&frozen.packet_digest===digest(this.packet(receipt))
     &&frozen.instructions_digest===digest(SCOUT_QUERY_INSTRUCTIONS)&&frozen.output_contract_digest===digest(SCOUT_QUERY_CONTRACT),'SCOUT_MODEL_REQUEST_RUN_BINDING');
 }
 assertContext(run,context,live){
   const frozen=parse(run.context_json),packet={campaign:JSON.parse(live.campaign.config_json),...live.packet,scout_assessment_request:frozen.scout_assessment_request};
   check(exact(context,'packet,input,output_contract,router_instructions')&&digest(context.packet)===digest(packet)
     &&exact(context.input,'situation_id')&&context.input.situation_id===live.job.id
     &&digest(context.output_contract)===digest(SCOUT_QUERY_CONTRACT)&&context.router_instructions===SCOUT_QUERY_INSTRUCTIONS,'SCOUT_QUERY_RUNTIME_INPUT_INVALID');
 }
 persistProposal(run,job,result,packet){
   const live=this.scout.modelRequests.assertForRun(run),d=live.definition;
   check(d.version===2&&live.job.id===job.id&&digest(live.packet)===digest(packet),'SCOUT_QUERY_STALE');
   const checked=scoutQueryOutput(result,packet);
   if(!checked.output){const error=new AppError(checked.reason,409,checked.reason);error.diagnostic=checked.diagnostic;throw error;}
   const proposalId=id(),output=checked.output;
   this.db.run("INSERT INTO scout_query_proposals VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'proposed',NULL,?)",proposalId,this.partnerId,
     d.campaign_id,d.campaign_revision,d.candidate_id,d.receipt_id,d.receipt_digest,live.request.id,live.fingerprint,run.id,
     JSON.stringify(output),digest(output),now());
   return proposalId;
 }
 proposal(proposalId,c){
   const p=this.db.get('SELECT * FROM scout_query_proposals WHERE id=? AND campaign_id=? AND partner_id=?',proposalId,c.id,this.partnerId);check(p,'SCOUT_QUERY_PROPOSAL_NOT_FOUND');
   check(p.campaign_revision===c.revision&&p.status!=='stale'&&digest(parse(p.output_json))===p.output_digest,'SCOUT_QUERY_STALE');
   const request=this.db.get('SELECT * FROM scout_model_requests WHERE id=? AND partner_id=?',p.model_request_id,this.partnerId),d=this.scout.modelRequests.validateDefinition(request);
   check(d.version===2&&p.request_fingerprint===request.request_fingerprint&&p.receipt_id===d.receipt_id&&p.receipt_digest===d.receipt_digest
     &&p.candidate_id===d.candidate_id&&p.run_id===request.run_id,'SCOUT_QUERY_PROPOSAL_INVALID');
   check(d.account_id===this.service.telegramAccountId,'SCOUT_ACCOUNT_MISMATCH');
   const job=this.db.get('SELECT * FROM scout_jobs WHERE id=?',d.job_id),run=this.db.get('SELECT * FROM runs WHERE id=? AND partner_id=?',p.run_id,this.partnerId);
   check(job?.status==='completed'&&run?.status==='completed'&&run.runtime==='hermes-scout-v1'&&job.run_id===run.id,'SCOUT_QUERY_PROPOSAL_INVALID');
   const live=this.scout.modelRequests.liveBindings(request,d,job,{runtime:false,allowSpent:true}),frozen=parse(run.context_json);
   this.assertRunBasis(frozen,d);check(frozen.scout_assessment_request?.id===request.id&&frozen.scout_assessment_request?.fingerprint===request.request_fingerprint
     &&frozen.job_id===job.id&&frozen.campaign_id===c.id&&frozen.campaign_revision===c.revision&&digest(frozen.campaign_config)===digest(JSON.parse(c.config_json))
     &&frozen.model_profile?.id===d.model_profile_id&&frozen.model_profile?.definition_hash===d.profile_hash&&digest(frozen.model_config)===digest(live.model_config),'SCOUT_QUERY_PROPOSAL_INVALID');
   check(parse(run.result_json)?.proposal_id===p.id&&scoutQueryStoredOutput(parse(p.output_json),live.packet),'SCOUT_QUERY_PROPOSAL_INVALID');
   return p;
 }
 review(p,c){
   fields(p,['campaign_id','revision','proposal_id','decision','note']);this.scout.auditGrant(c);const proposal=this.proposal(p.proposal_id,c);
   check(proposal.status==='proposed','SCOUT_ASSESSMENT_ALREADY_REVIEWED');check(['approve','reject'].includes(p.decision),'SCOUT_REVIEW_INVALID');
   const status=p.decision==='approve'?'approved':'rejected';this.db.run('UPDATE scout_query_proposals SET status=?,note=? WHERE id=?',status,requiredText(p.note,'note',1000),proposal.id);
   this.scout.event('query_proposal.reviewed',{proposal_id:proposal.id,status,contact_permission:false,allowed_effects:[]});
   return {proposal_id:proposal.id,status,contact_permission:false,allowed_effects:[]};
 }
 presentation(c){
   return this.db.all('SELECT q.*,j.status,j.reason,j.attempts FROM scout_message_queries q JOIN scout_jobs j ON j.id=q.job_id WHERE q.campaign_id=? AND q.partner_id=? ORDER BY q.created_at DESC,q.rowid DESC LIMIT 100',c.id,this.partnerId).map(row=>{
     try{
       const d=this.definition(row),candidate=this.scout.candidate(d.candidate_id,c.id),receipts=this.db.all('SELECT id FROM scout_query_receipts WHERE query_request_id=? ORDER BY created_at,id LIMIT 3',row.id).map(r=>{
         try{
           const historical=this.receipt(r.id,{current:false});let current=true,reason=null;try{this.receipt(r.id);check(d.account_id===this.service.telegramAccountId,'SCOUT_ACCOUNT_MISMATCH');}catch(e){current=false;reason=e.code??'SCOUT_QUERY_INVALID';}
           const requests=this.db.all("SELECT job_id FROM scout_model_requests WHERE partner_id=? AND json_extract(definition_json,'$.receipt_id')=? ORDER BY rowid DESC LIMIT 30",this.partnerId,r.id);
           const proposals=this.db.all('SELECT * FROM scout_query_proposals WHERE receipt_id=? ORDER BY created_at DESC,rowid DESC LIMIT 30',r.id).map(p=>{
             try{this.proposal(p.id,c);return {id:p.id,status:p.status,current:true,...parse(p.output_json),note:p.note};}
             catch(e){return {id:p.id,status:'stale',current:false,reason:e.code??'SCOUT_QUERY_INVALID'};}
           });
           return {id:r.id,digest:historical.row.content_hash,...historical.content,current,reason,proposals,model_requests:requests.map(x=>this.scout.modelRequests.presentation(x.job_id))};
         }catch(e){return {id:r.id,current:false,reason:e.code??'SCOUT_QUERY_INVALID',messages:[],proposals:[],model_requests:[]};}
       });
       return {id:row.id,job_id:d.job_id,candidate_id:d.candidate_id,source:{channel_id:d.channel_id,username:d.public_username,title:candidate.title},query:d.query,from:d.from,until:d.until,limit:d.limit,status:row.status,reason:row.reason,attempts:row.attempts,receipts};
     }catch(e){return {id:row.id,status:'stale',reason:e.code??'SCOUT_QUERY_INVALID',receipts:[]};}
   });
 }
}
