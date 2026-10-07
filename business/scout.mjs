import { id } from './store.mjs';
import { ensure, requiredText, now, AppError } from './errors.mjs';
import { digest, sourceCheckpoint, validateSourceCheckpoint, SOURCE_CHECKPOINT_CHANNEL } from './source-ingestion.mjs';
import { observationRecoveryPresentation, sourceObservationFloor } from './source-observation-epochs.mjs';
import { scoutSignals } from './scout-signals.mjs';
import { telegramReadState } from './telegram-read-gate.mjs';
import { scoutAssessmentDiagnostic } from './scout-assessment-output.mjs';
export { SCOUT_TABLES, SCOUT_COMMANDS } from './scout-tables.mjs';
const check=(ok,code)=>ensure(ok,code,409,code);
export const SCOUT_EVALUATOR_VERSION='scout-assessment-v3';
const future = raw => {const ms=Date.parse(raw);check(Number.isFinite(ms)&&ms>Date.now()&&ms<=Date.now()+30*86400000,'SCOUT_GRANT_TIME_INVALID');return new Date(ms).toISOString();};
const fields=(p,keys)=>check(p&&typeof p==='object'&&!Array.isArray(p)&&Object.keys(p).every(k=>keys.includes(k)),'SCOUT_FIELDS_INVALID');
function topicConfig(p) {
 const topic=requiredText(p.topic,'topic',1000), audience=requiredText(p.audience||topic,'audience',1000);
 const language=requiredText(p.language||'any','language',100),geography=requiredText(p.geography||'any','geography',200);
 check(Array.isArray(p.queries)&&p.queries.length>=1&&p.queries.length<=10,'SCOUT_QUERIES_INVALID');
 return {topic,audience,language,geography,queries:[...new Set(p.queries.map(q=>requiredText(q,'query',200)))]};
}
function reference(raw) {
 const text=requiredText(raw,'reference',300);
 if (/^(?:-100)?[1-9][0-9]{0,18}$/.test(text)) return {channel_id:text.startsWith('-100')?text.slice(4):text};
 const match=text.match(/^(?:https:\/\/(?:t\.me|telegram\.me)\/|@)?([A-Za-z][A-Za-z0-9_]{3,31})\/?$/);
 check(match,'SCOUT_PUBLIC_REFERENCE_REQUIRED');return {username:match[1]};
}
export class SourceScout {
 constructor(service){this.service=service;this.db=service.store;}
 get cfg(){return this.service.config.scout;}
 get partnerId(){return this.service.config.partnerId;}
 get enabled(){return this.cfg?.enabled===true&&this.service.config.controlPlane?.enabled===true&&this.service.config.telegram?.liveSending===false;}
 ready(){check(this.enabled&&this.service.control.processOwned&&this.service.control.processCurrent()&&!this.service.control.stopped,'SCOUT_DISABLED');}
 campaign(campaignId){const c=this.db.get('SELECT * FROM scout_campaigns WHERE id=? AND partner_id=?',campaignId,this.partnerId);check(c,'SCOUT_CAMPAIGN_NOT_FOUND');return c;}
 candidate(candidateId,campaignId){const c=this.db.get('SELECT * FROM scout_candidates WHERE id=? AND campaign_id=?',candidateId,campaignId);check(c,'SCOUT_CANDIDATE_NOT_FOUND');return c;}
 revision(c,p){check(c.revision===p.revision,'SCOUT_REVISION_CONFLICT');}
 current(c){check(c.status==='active','SCOUT_CAMPAIGN_PAUSED');check(digest(JSON.parse(c.config_json))===c.topic_hash,'SCOUT_CAMPAIGN_INVALID');}
 account(){const account=this.service.telegramAccountId;check(typeof account==='string'&&/^[1-9][0-9]{0,18}$/.test(account),'SCOUT_ACCOUNT_NOT_CONNECTED');return account;}
 grantCurrent(g,c,kind=g?.kind){return Boolean(g&&g.status==='active'&&g.kind===kind&&g.campaign_id===c.id&&g.campaign_revision===c.revision&&c.status==='active'&&Date.parse(g.expires_at)>Date.now());}
 auditGrant(c){const g=this.db.get("SELECT * FROM scout_grants WHERE campaign_id=? AND kind='audit' AND status='active' ORDER BY created_at DESC,rowid DESC LIMIT 1",c.id);check(this.grantCurrent(g,c,'audit')&&g.account_id===this.account(),'SCOUT_AUDIT_AUTHORITY_REQUIRED');return g;}
 jobAuthority(job,{runtime=true}={}){
   if(runtime)this.ready();
   const c=this.campaign(job.campaign_id);this.current(c);const g=this.db.get('SELECT * FROM scout_grants WHERE id=?',job.grant_id);
   check(job.campaign_revision===c.revision&&this.grantCurrent(g,c,'audit'),'SCOUT_AUTHORITY_STALE');
   if(runtime)check(g.account_id===this.account(),'SCOUT_AUTHORITY_STALE');
   return {campaign:c,grant:g};
 }
 event(kind,p){this.db.event(this.partnerId,null,`scout.${kind}`,'operator',p);}
 retire(c,reason){
   const sources=this.db.all("SELECT DISTINCT s.source_ref FROM scout_grants g JOIN scout_samples s ON s.id=g.sample_id WHERE g.campaign_id=? AND g.kind='monitor' AND g.status='active'",c.id);
   this.db.run("UPDATE scout_grants SET status='stale',reason=? WHERE campaign_id=? AND status='active'",reason,c.id);
   this.db.run("UPDATE scout_jobs SET status='stale',reason=?,updated_at=? WHERE campaign_id=? AND status IN ('queued','running','interrupted')",reason,now(),c.id);
   this.db.run("UPDATE scout_assessments SET status='stale' WHERE campaign_id=? AND status IN ('proposed','approved')",c.id);
   for(const {source_ref} of sources)this.syncMonitorCheckpoint(source_ref);
 }
 enqueue(c,g,kind,cursor,candidateId=null,sampleId=null){
   check(this.db.get("SELECT COUNT(*) n FROM scout_jobs WHERE campaign_id=?",c.id).n<300,'SCOUT_JOB_HISTORY_CAPACITY');
   const existing=this.db.get("SELECT * FROM scout_jobs WHERE campaign_id=? AND campaign_revision=? AND grant_id=? AND kind=? AND candidate_id IS ? AND status IN ('queued','running') AND cursor_json=?",c.id,c.revision,g.id,kind,candidateId,JSON.stringify(cursor));
   if(existing)return {job_id:existing.id,status:existing.status};
   const jobId=id();this.db.run("INSERT INTO scout_jobs(id,campaign_id,campaign_revision,grant_id,candidate_id,kind,status,cursor_json,sample_id,next_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?,?,?,?)",jobId,c.id,c.revision,g.id,candidateId,kind,JSON.stringify(cursor),sampleId,now(),now(),now());
   return {job_id:jobId,status:'queued'};
 }
 command(action,p,actor){
   check(actor?.kind==='operator','SCOUT_OPERATOR_REQUIRED');this.ready();
   if(action==='scout.create'){
     fields(p,['title','topic','audience','language','geography','queries']);
     check(this.db.get('SELECT COUNT(*) n FROM scout_campaigns WHERE partner_id=?',this.partnerId).n<50,'SCOUT_CAMPAIGN_CAPACITY');
     const config=topicConfig(p),campaignId=id();this.db.run("INSERT INTO scout_campaigns VALUES(?,?,?,?,?,1,?,'active',?,?)",campaignId,this.partnerId,requiredText(p.title,'title',200),config.topic,JSON.stringify(config),digest(config),now(),now());
     this.event('campaign.created',{campaign_id:campaignId});return {campaign_id:campaignId,revision:1};
   }
   const c=this.campaign(p.campaign_id);this.revision(c,p);
   if(action==='scout.revise'){
     fields(p,['campaign_id','revision','topic','audience','language','geography','queries']);const config=topicConfig(p);this.retire(c,'TOPIC_CHANGED');
     this.db.run("UPDATE scout_campaigns SET topic=?,config_json=?,topic_hash=?,revision=revision+1,status='active',updated_at=? WHERE id=?",config.topic,JSON.stringify(config),digest(config),now(),c.id);
     this.event('campaign.revised',{campaign_id:c.id,revision:c.revision+1});return {campaign_id:c.id,revision:c.revision+1};
   }
   if(action==='scout.pause'){
     fields(p,['campaign_id','revision']);this.retire(c,'CAMPAIGN_PAUSED');this.db.run("UPDATE scout_campaigns SET status='paused',revision=revision+1,updated_at=? WHERE id=?",now(),c.id);return {campaign_id:c.id,status:'paused'};
   }
   this.current(c);
   if(action==='scout.authorize'){
     fields(p,['campaign_id','revision','expires_at','purpose']);const account=this.account();
     check(this.db.get('SELECT COUNT(*) n FROM scout_grants WHERE campaign_id=?',c.id).n<500,'SCOUT_GRANT_CAPACITY');
     this.db.run("UPDATE scout_grants SET status='revoked',reason='AUTHORITY_REPLACED' WHERE campaign_id=? AND kind='audit' AND status='active'",c.id);
     this.db.run("UPDATE scout_jobs SET status='stale',reason='AUTHORITY_REPLACED',updated_at=? WHERE campaign_id=? AND status IN ('queued','running','interrupted')",now(),c.id);
     const grantId=id();this.db.run("INSERT INTO scout_grants(id,campaign_id,campaign_revision,kind,account_id,purpose,expires_at,status,created_at) VALUES(?,?,?,'audit',?,?,?,'active',?)",grantId,c.id,c.revision,account,requiredText(p.purpose,'purpose',1000),future(p.expires_at),now());
     this.event('audit.authorized',{campaign_id:c.id,grant_id:grantId,account_id:account});return {grant_id:grantId};
   }
   if(action==='scout.revoke'){
     fields(p,['campaign_id','revision','grant_id']);const grant=this.db.get('SELECT * FROM scout_grants WHERE id=? AND campaign_id=?',p.grant_id,c.id);check(grant,'SCOUT_GRANT_NOT_FOUND');
     this.db.run("UPDATE scout_grants SET status='revoked',reason='OWNER_REVOKED' WHERE id=?",grant.id);
     this.db.run("UPDATE scout_jobs SET status='stale',reason='OWNER_REVOKED',updated_at=? WHERE grant_id=? AND status IN ('queued','running','interrupted')",now(),grant.id);
     if(grant.kind==='monitor')this.syncMonitorCheckpoint(`telegram:channel:${this.candidate(grant.candidate_id,c.id).channel_id}`);
     this.event('grant.revoked',{campaign_id:c.id,grant_id:grant.id});return {grant_id:grant.id,status:'revoked'};
   }
   if(action==='scout.admit'){
     fields(p,['campaign_id','revision','candidate_id','sample_id','assessment_id','expires_at','purpose','max_lag_seconds','catchup_from_pts','expected_checkpoint_fingerprint','accept_historical_gap']);
     check(this.service.config.opportunity?.automatic===true,'SCOUT_MONITORING_REQUIRES_SOURCE_INGEST');
     const candidate=this.candidate(p.candidate_id,c.id),sample=this.sample(p.sample_id,candidate);
     check(candidate.joined===1,'SCOUT_MEMBERSHIP_REQUIRED');check(candidate.account_id===this.account(),'SCOUT_ACCOUNT_MISMATCH');
     check(!(this.service.config.opportunity?.telegramSources??[]).some(x=>x.sourceId===sample.source_ref),'SCOUT_SOURCE_STATIC_AUTHORITY');
     // One native source has one monitor authority epoch. A second topic cannot
     // silently override (or be shadowed by) another topic's freshness policy.
     check(!this.db.get("SELECT g.id FROM scout_grants g JOIN scout_candidates s ON s.id=g.candidate_id AND s.campaign_id=g.campaign_id AND s.account_id=g.account_id JOIN scout_campaigns p ON p.id=g.campaign_id WHERE p.partner_id=? AND g.kind='monitor' AND g.status='active' AND g.expires_at>? AND p.status='active' AND p.revision=g.campaign_revision AND s.channel_id=? AND NOT (g.campaign_id=? AND g.candidate_id=?) LIMIT 1",this.partnerId,now(),candidate.channel_id,c.id,candidate.id),'SCOUT_SOURCE_ALREADY_MONITORED');
     check(sample.status==='sealed'&&JSON.parse(sample.messages_json).some(m=>!m.unsupported&&typeof m.text==='string'&&m.text.trim()),'SCOUT_SAMPLE_NOT_USABLE');
     this.sampleFresh(sample);
     if(p.assessment_id){const a=this.assessment(p.assessment_id,c);check(a.status==='approved'&&a.sample_id===sample.id&&a.candidate_id===candidate.id,'SCOUT_ASSESSMENT_REVIEW_REQUIRED');}
     const lag=p.max_lag_seconds??300;check(Number.isInteger(lag)&&lag>=60&&lag<=3600,'SCOUT_MONITOR_LAG_INVALID');
     const checkpoint=sourceCheckpoint(this.service,sample.source_ref);
     if(checkpoint){
       check(Number.isInteger(p.catchup_from_pts)&&typeof p.expected_checkpoint_fingerprint==='string'&&p.accept_historical_gap===true,'SCOUT_CATCHUP_AUTHORITY_REQUIRED');
       check(p.catchup_from_pts===checkpoint.pts&&p.expected_checkpoint_fingerprint===digest(checkpoint),'SCOUT_CHECKPOINT_CHANGED');
     }else check(p.catchup_from_pts==null&&p.expected_checkpoint_fingerprint==null&&p.accept_historical_gap!==true,'SCOUT_CHECKPOINT_CHANGED');
     check(this.db.get("SELECT COUNT(*) n FROM scout_grants g JOIN scout_campaigns c ON c.id=g.campaign_id WHERE c.partner_id=? AND g.kind='monitor' AND g.status='active' AND g.expires_at>? AND NOT (g.campaign_id=? AND g.candidate_id=?)",this.partnerId,now(),c.id,candidate.id).n<100,'SCOUT_MONITOR_CAPACITY');
     check(this.db.get('SELECT COUNT(*) n FROM scout_grants WHERE campaign_id=?',c.id).n<500,'SCOUT_GRANT_CAPACITY');
     this.db.run("UPDATE scout_grants SET status='revoked',reason='MONITOR_REPLACED' WHERE campaign_id=? AND candidate_id=? AND kind='monitor' AND status='active'",c.id,candidate.id);
     const grantId=id();this.db.run("INSERT INTO scout_grants(id,campaign_id,campaign_revision,kind,account_id,candidate_id,sample_id,assessment_id,purpose,max_lag_seconds,catchup_from_pts,checkpoint_fingerprint,accept_historical_gap,expires_at,status,created_at) VALUES(?,?,?,'monitor',?,?,?,?,?,?,?,?,?,?,'active',?)",grantId,c.id,c.revision,candidate.account_id,candidate.id,sample.id,p.assessment_id??null,requiredText(p.purpose,'purpose',1000),lag,checkpoint?.pts??null,checkpoint?digest(checkpoint):null,checkpoint?1:0,future(p.expires_at),now());
     this.syncMonitorCheckpoint(sample.source_ref,{strict:true});
     this.event('monitor.admitted',{campaign_id:c.id,candidate_id:candidate.id,grant_id:grantId,source_ref:sample.source_ref,sample_id:sample.id,contact_permission:false});return {grant_id:grantId,source_ref:sample.source_ref,contact_permission:false};
   }
   const grant=this.auditGrant(c);
   if(action==='scout.seed'){fields(p,['campaign_id','revision','reference']);return this.enqueue(c,grant,'resolve',{reference:reference(p.reference)});}
   if(action==='scout.search'){
     fields(p,['campaign_id','revision']);return {jobs:JSON.parse(c.config_json).queries.map(query=>this.enqueue(c,grant,'search',{query}))};
   }
   if(action==='scout.audit'){
     fields(p,['campaign_id','revision','candidate_id']);const candidate=this.candidate(p.candidate_id,c.id);
     check(candidate.account_id===grant.account_id,'SCOUT_ACCOUNT_MISMATCH');
     const queued=this.db.get("SELECT id,status FROM scout_jobs WHERE campaign_id=? AND campaign_revision=? AND grant_id=? AND candidate_id=? AND kind='history' AND status IN ('queued','running','interrupted') LIMIT 1",c.id,c.revision,grant.id,candidate.id);
     if(queued)return {job_id:queued.id,status:queued.status};
     // Reuse a sealed, verifiable historical sample across campaign topics. Assessment remains topic-scoped.
     const sample=this.db.get("SELECT * FROM scout_samples WHERE account_id=? AND source_ref=? AND status='sealed' ORDER BY finished_at DESC LIMIT 1",candidate.account_id,`telegram:channel:${candidate.channel_id}`);
     if(sample){try{this.sampleFresh(sample);this.sample(sample.id);this.db.run('UPDATE scout_candidates SET sample_id=?,updated_at=? WHERE id=?',sample.id,now(),candidate.id);return {sample_id:sample.id,reused:true};}catch(e){if(!(e instanceof AppError))throw e;}}
     const sampleId=id(),until=now(),from=new Date(Date.now()-7*86400000).toISOString();
     const sourceCursor=this.db.get('SELECT COALESCE(MAX(id),0) head FROM events WHERE partner_id=?',this.partnerId).head;
     this.db.run("INSERT INTO scout_samples(id,candidate_id,account_id,source_ref,requested_from,requested_until,status,source_cursor,created_at) VALUES(?,?,?,?,?,?,'collecting',?,?)",sampleId,candidate.id,candidate.account_id,`telegram:channel:${candidate.channel_id}`,from,until,sourceCursor,now());
     return this.enqueue(c,grant,'history',{before_id:0,from,until,messages:0},candidate.id,sampleId);
   }
   if(action==='scout.request_assessment'){
     fields(p,['campaign_id','revision','candidate_id','sample_id']);check(this.cfg.modelEnabled===true,'SCOUT_MODEL_DISABLED');
     const candidate=this.candidate(p.candidate_id,c.id),sample=this.sample(p.sample_id,candidate);this.sampleFresh(sample);
     check(candidate.account_id===grant.account_id,'SCOUT_ACCOUNT_MISMATCH');
     return this.enqueue(c,grant,'assessment',{sample_digest:sample.digest,topic_hash:c.topic_hash,evaluator_version:SCOUT_EVALUATOR_VERSION},candidate.id,sample.id);
   }
   if(action==='scout.review'){
     fields(p,['campaign_id','revision','assessment_id','decision','note']);const assessment=this.assessment(p.assessment_id,c);
     check(assessment.status==='proposed','SCOUT_ASSESSMENT_ALREADY_REVIEWED');check(['approve','reject'].includes(p.decision),'SCOUT_REVIEW_INVALID');
     this.db.run('UPDATE scout_assessments SET status=?,note=? WHERE id=?',p.decision==='approve'?'approved':'rejected',requiredText(p.note,'note',1000),assessment.id);
     return {assessment_id:assessment.id,status:p.decision==='approve'?'approved':'rejected'};
   }
   throw new AppError('SCOUT_COMMAND_UNKNOWN',400,'SCOUT_COMMAND_UNKNOWN');
 }
 sampleFresh(sample){check(sample.status==='sealed'&&Number.isFinite(Date.parse(sample.finished_at))&&Date.parse(sample.finished_at)<=Date.now()+30000&&Date.now()-Date.parse(sample.finished_at)<=this.cfg.auditMaxAgeSeconds*1000,'SCOUT_SAMPLE_STALE');}
 sample(sampleId,candidate=null,{current=true}={}){
   const row=this.db.get('SELECT s.* FROM scout_samples s JOIN scout_candidates c ON c.id=s.candidate_id JOIN scout_campaigns p ON p.id=c.campaign_id WHERE s.id=? AND p.partner_id=?',sampleId,this.partnerId);check(row,'SCOUT_SAMPLE_NOT_FOUND');
   if(candidate)check(row.account_id===candidate.account_id&&row.source_ref===`telegram:channel:${candidate.channel_id}`,'SCOUT_SAMPLE_SCOPE');
   const messages=JSON.parse(row.messages_json);check(Array.isArray(messages)&&messages.length<=1500,'SCOUT_SAMPLE_INVALID');
   check(Number.isSafeInteger(row.source_cursor)&&row.source_cursor>=0,'SCOUT_SAMPLE_INVALID');
   if(current)check(row.source_cursor>=sourceObservationFloor(this.service,row.source_ref),'SCOUT_SAMPLE_STALE');
   if(row.status==='sealed')check(digest({source_ref:row.source_ref,account_id:row.account_id,from:row.requested_from,until:row.requested_until,source_cursor:row.source_cursor,messages,coverage:row.coverage})===row.digest,'SCOUT_SAMPLE_INVALID');
   // If a watched message has since changed/deleted, the frozen sample is historical only.
   if(current&&messages.length){
     const refs=messages.map(message=>`message:${message.message_id}`);
     const changed=this.db.get(`SELECT id FROM events WHERE partner_id=? AND kind IN ('source.message','source.telegram.tombstone') AND json_extract(payload_json,'$.source_id')=? AND json_extract(payload_json,'$.message_id') IN (${refs.map(()=>'?').join(',')}) AND id>? LIMIT 1`,this.partnerId,row.source_ref,...refs,row.source_cursor);
     // No cross-envelope field-by-field equivalence. A later durable revision makes
     // the frozen historical sample stale for a new assessment/admission, even if text matches.
     check(!changed,'SCOUT_SAMPLE_STALE');
   }
   return row;
 }
 assessment(assessmentId,c){
   const row=this.db.get('SELECT * FROM scout_assessments WHERE id=? AND campaign_id=?',assessmentId,c.id);check(row,'SCOUT_ASSESSMENT_NOT_FOUND');
   const sample=this.sample(row.sample_id);this.sampleFresh(sample);
   check(row.campaign_revision===c.revision&&row.topic_hash===c.topic_hash&&row.sample_digest===sample.digest&&row.evaluator_version===SCOUT_EVALUATOR_VERSION,'SCOUT_ASSESSMENT_STALE');return row;
 }
 upsertCandidate(c,g,native,origin){
   check(native&&/^[1-9][0-9]{0,18}$/.test(native.channel_id)&&['group','channel'].includes(native.kind),'SCOUT_CANDIDATE_INVALID');
   const existing=this.db.get('SELECT * FROM scout_candidates WHERE campaign_id=? AND account_id=? AND channel_id=?',c.id,g.account_id,native.channel_id);
   if(!existing)check(this.db.get('SELECT COUNT(*) n FROM scout_candidates WHERE campaign_id=?',c.id).n<this.cfg.maxCandidates,'SCOUT_CANDIDATE_CAPACITY');
   const candidateId=existing?.id??id();
   if(existing)this.db.run('UPDATE scout_candidates SET username=?,title=?,kind=?,joined=?,updated_at=? WHERE id=?',native.username??null,requiredText(native.title,'title',500),native.kind,native.joined===true?1:0,now(),candidateId);
   else this.db.run('INSERT INTO scout_candidates(id,campaign_id,account_id,channel_id,username,title,kind,joined,origin_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',candidateId,c.id,g.account_id,native.channel_id,native.username??null,requiredText(native.title,'title',500),native.kind,native.joined===true?1:0,JSON.stringify(origin),now(),now());
   return this.candidate(candidateId,c.id);
 }
 monitorPolicies(){
   if(!this.enabled||!this.service.control.processOwned||this.service.control.stopped||!this.service.control.processCurrent())return [];
   const account=this.service.telegramAccountId;if(!account)return [];
   return this.monitorAuthorityPolicies().filter(p=>p.accountId===account);
 }
 monitorAuthorityPolicies(){
   const campaigns=this.db.all("SELECT id,config_json,topic_hash FROM scout_campaigns WHERE partner_id=? AND status='active'",this.partnerId)
     .filter(c=>{try{return digest(JSON.parse(c.config_json))===c.topic_hash;}catch{return false;}}).map(c=>c.id);
   // Source ids and native checkpoints are partner/channel scoped, not account
   // scoped. Ambiguous authority must be withheld before filtering by account.
   const rows=this.db.all("SELECT g.*,c.channel_id,COUNT(*) OVER (PARTITION BY c.channel_id) authority_count FROM scout_grants g JOIN scout_candidates c ON c.id=g.candidate_id AND c.campaign_id=g.campaign_id AND c.account_id=g.account_id JOIN scout_campaigns p ON p.id=g.campaign_id WHERE p.partner_id=? AND p.id IN (SELECT value FROM json_each(?)) AND g.kind='monitor' AND g.status='active' AND g.expires_at>? AND p.status='active' AND p.revision=g.campaign_revision AND c.joined=1 ORDER BY g.created_at,g.id LIMIT 100",this.partnerId,JSON.stringify(campaigns),now());
   const policies=new Map();
   for(const g of rows){if(g.authority_count!==1)continue;
     if(!/^[1-9][0-9]{0,18}$/.test(g.account_id)||!/^[1-9][0-9]{0,18}$/.test(g.channel_id))continue;
     if(typeof g.purpose!=='string'||!g.purpose.trim()||g.purpose.length>1000||!Number.isInteger(g.max_lag_seconds)||g.max_lag_seconds<60||g.max_lag_seconds>3600)continue;
     const sourceId=`telegram:channel:${g.channel_id}`;if(policies.has(sourceId))continue;
     if((this.service.config.opportunity?.telegramSources??[]).some(p=>p.sourceId===sourceId))continue;
     policies.set(sourceId,this.monitorPolicy(g));}
   return [...policies.values()];
 }
 monitorPolicy(g){return {sourceId:`telegram:channel:${g.channel_id}`,accountId:g.account_id,channelId:g.channel_id,sourceKind:'live_snapshot',processingBasis:`Owner monitor grant ${g.id}: ${g.purpose}`.slice(0,1000),maxLagSeconds:g.max_lag_seconds};}
 // Authority epochs may change, native progress may not. Re-authorizing an already
 // admitted source resumes its durable PTS; it never resets an integrity latch or
 // claims coverage over the interval without a grant. Only known Scout policies
 // can cross this boundary; configured sources retain their existing rules.
 syncMonitorCheckpoint(sourceRef,{strict=false}={}){
   try{return this.rebindMonitorCheckpoint(sourceRef);}catch(error){
     if(strict)throw error;
     // Revocation must succeed even if the old cursor is corrupt. Keep the bad
     // record for diagnosis; never repair/reset it or resurrect its authority.
     this.service.sourceTransportHealth?.set(sourceRef,()=>false);
     this.db.event(this.partnerId,null,'scout.monitor.checkpoint_unproven','system',{source_ref:sourceRef,reason:error.code??'SCOUT_CHECKPOINT_INVALID'});
   }
 }
 rebindMonitorCheckpoint(sourceRef){
   const previous=sourceCheckpoint(this.service,sourceRef);if(!previous)return;
   const history=this.db.all("SELECT g.*,c.channel_id FROM scout_grants g JOIN scout_candidates c ON c.id=g.candidate_id JOIN scout_campaigns p ON p.id=g.campaign_id WHERE p.partner_id=? AND g.kind='monitor' AND c.channel_id=?",this.partnerId,previous.channel_id);
   const prior=history.map(g=>this.monitorPolicy(g)).find(p=>p.sourceId===sourceRef&&digest(p)===previous.policy_hash);
   check(prior,'SCOUT_CHECKPOINT_AUTHORITY_UNKNOWN');validateSourceCheckpoint(previous,prior);
   const next=this.monitorAuthorityPolicies().find(p=>p.sourceId===sourceRef);
   if(next){check(next.accountId===previous.account_id&&next.channelId===previous.channel_id,'SCOUT_CHECKPOINT_SCOPE');if(digest(next)===previous.policy_hash)return;}
   const integrity=previous.reason==='INTEGRITY_RECONCILIATION_REQUIRED';
   const state={...previous,policy_hash:next?digest(next):previous.policy_hash,phase:integrity?'blocked':'catching_up',confirmed_at:null,reason:integrity?previous.reason:next?'SCOUT_MONITOR_REAUTHORIZED':'SCOUT_MONITOR_REVOKED'};
   this.db.run('UPDATE channel_offsets SET cursor=? WHERE channel=? AND account_id=?',JSON.stringify(state),SOURCE_CHECKPOINT_CHANNEL,digest([this.partnerId,sourceRef]));
   this.db.event(this.partnerId,null,'scout.monitor.authority_changed','system',{source_ref:sourceRef,previous_policy_hash:previous.policy_hash,policy_hash:state.policy_hash,pts:state.pts,coverage_established:false});
 }
 reconcile(){
   this.ready();
   const expired=this.db.all("SELECT DISTINCT c.channel_id FROM scout_grants g JOIN scout_candidates c ON c.id=g.candidate_id JOIN scout_campaigns p ON p.id=g.campaign_id WHERE p.partner_id=? AND g.kind='monitor' AND g.status='active' AND g.expires_at<=?",this.partnerId,now());
   this.db.run("UPDATE scout_grants SET status='expired',reason='GRANT_EXPIRED' WHERE status='active' AND expires_at<=? AND campaign_id IN (SELECT id FROM scout_campaigns WHERE partner_id=?)",now(),this.partnerId);
   for(const {channel_id} of expired)this.syncMonitorCheckpoint(`telegram:channel:${channel_id}`);
   const cursorChannel='scout-job-reconcile-v1';
   const cursor=this.db.get('SELECT cursor FROM channel_offsets WHERE channel=? AND account_id=?',cursorChannel,this.partnerId)?.cursor??'';
   check(cursor===''||/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(cursor),'SCOUT_RECONCILE_CURSOR_INVALID');
   const page=(after,take,before=null)=>this.db.all(`SELECT * FROM scout_jobs WHERE status IN ('queued','interrupted') AND campaign_id IN (SELECT id FROM scout_campaigns WHERE partner_id=?) AND id>? ${before===null?'':'AND id<=?'} ORDER BY id LIMIT ?`,this.partnerId,after,...(before===null?[]:[before]),take);
   let jobs=page(cursor,30);
   if(cursor&&jobs.length<30)jobs=jobs.concat(page('',30-jobs.length,cursor));
   this.db.run('INSERT INTO channel_offsets(channel,account_id,cursor) VALUES(?,?,?) ON CONFLICT(channel,account_id) DO UPDATE SET cursor=excluded.cursor',cursorChannel,this.partnerId,jobs.at(-1)?.id??'');
   for(const job of jobs){
     try{
       const {grant}=this.jobAuthority(job,{runtime:false});
       if(job.kind==='assessment')check(JSON.parse(job.cursor_json)?.evaluator_version===SCOUT_EVALUATOR_VERSION,'SCOUT_ASSESSMENT_STALE');
       // Startup runs before getMe. Waiting for the right account must not retire
       // valid work or resurrect an interrupted billable assessment.
       if(grant.account_id!==this.service.telegramAccountId)continue;
       if(job.status==='interrupted')this.db.run("UPDATE scout_jobs SET status='queued',reason='READ_RETRY_AFTER_RESTART' WHERE id=? AND kind!='assessment'",job.id);
     }
     catch(e){if(!(e instanceof AppError)&&!(e instanceof SyntaxError))throw e;this.db.run("UPDATE scout_jobs SET status='stale',reason=?,updated_at=? WHERE id=?",e.code??'SCOUT_RECORD_INVALID',now(),job.id);}
   }
 }
 presentation(c){
   const candidates=this.db.all('SELECT * FROM scout_candidates WHERE campaign_id=? ORDER BY created_at,id LIMIT 100',c.id).map(candidate=>{
     let sample=null,assessment=null,reason=candidate.reason;
     try{if(candidate.sample_id){const s=this.sample(candidate.sample_id,candidate,{current:false}),messages=JSON.parse(s.messages_json),signals=scoutSignals(messages);sample={id:s.id,finished_at:s.finished_at,coverage:s.coverage,acquisition_kind:'bounded_non_atomic_history_sample',metrics:signals.metrics,groups:signals.groups,requested_from:s.requested_from,requested_until:s.requested_until,continuous_coverage:false,current:true};try{this.sampleFresh(s);this.sample(s.id,candidate);}catch(e){reason=e.code;sample.current=false;}}
       const a=this.db.get('SELECT * FROM scout_assessments WHERE campaign_id=? AND candidate_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',c.id,candidate.id);if(a){let status=a.status;try{this.assessment(a.id,c);}catch{status='stale';}assessment={id:a.id,status,...JSON.parse(a.output_json)};}}
     catch(e){if(!(e instanceof AppError)&&!(e instanceof SyntaxError))throw e;reason=e.code??'SCOUT_RECORD_INVALID';}
     const monitor=this.db.get("SELECT * FROM scout_grants WHERE campaign_id=? AND candidate_id=? AND kind='monitor' ORDER BY created_at DESC,rowid DESC LIMIT 1",c.id,candidate.id);
     const checkpoint=sourceCheckpoint(this.service,`telegram:channel:${candidate.channel_id}`);
     return {...candidate,joined:candidate.joined===1,source_ref:`telegram:channel:${candidate.channel_id}`,origin:JSON.parse(candidate.origin_json),sample,assessment,reason,checkpoint,checkpoint_fingerprint:checkpoint?digest(checkpoint):null,observation_recovery:observationRecoveryPresentation(this.service,`telegram:channel:${candidate.channel_id}`),monitor_grant:monitor?{...monitor,current:this.grantCurrent(monitor,c,'monitor')&&this.monitorAuthorityPolicies().some(p=>digest(p)===digest(this.monitorPolicy({...monitor,channel_id:candidate.channel_id}))),checkpoint}:null};
   });
   const grant=this.db.get("SELECT * FROM scout_grants WHERE campaign_id=? AND kind='audit' ORDER BY created_at DESC,rowid DESC LIMIT 1",c.id);
   return {...c,config:JSON.parse(c.config_json),authority:{scout:grant?{...grant,current:this.grantCurrent(grant,c,'audit')}:null},candidates,
     jobs:this.db.all('SELECT j.id,j.kind,j.status,j.reason,j.next_at,j.attempts,r.result_json FROM scout_jobs j LEFT JOIN runs r ON r.id=j.run_id AND r.partner_id=? AND r.runtime=\'hermes-scout-v1\' WHERE j.campaign_id=? ORDER BY j.updated_at DESC,j.rowid DESC LIMIT 30',this.partnerId,c.id).map(({result_json,...job})=>{
       let diagnostic=null;try{diagnostic=scoutAssessmentDiagnostic(JSON.parse(result_json)?.diagnostic);}catch{/* Corrupt receipts are not diagnostics. */}
       return {...job,diagnostic};
     }),
     unknown:['Search is incomplete.','History is a bounded sample, not continuous observation.','No contact, join or sending permission is created.']};
 }
 snapshot(){
   let readGate=null;try{if(this.enabled&&this.service.telegramAccountId)readGate=telegramReadState(this.service,this.service.telegramAccountId);}catch(e){readGate={ready:false,reason:e.code??'SCOUT_READ_GATE_INVALID'};}
   return {enabled:this.enabled,model_enabled:this.cfg?.modelEnabled===true,account_id:this.service.telegramAccountId,read_gate:readGate,limits:this.cfg??null,campaigns:this.db.all('SELECT c.id,c.title,c.topic,c.revision,c.status,c.updated_at,(SELECT COUNT(*) FROM scout_candidates s WHERE s.campaign_id=c.id) candidate_count FROM scout_campaigns c WHERE c.partner_id=? ORDER BY c.updated_at DESC LIMIT 50',this.partnerId)};
 }
}
