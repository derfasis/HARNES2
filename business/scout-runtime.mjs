import { id } from './store.mjs';
import { now, AppError, ensure } from './errors.mjs';
import { digest } from './source-ingestion.mjs';
import { scoutSignals } from './scout-signals.mjs';
import { TelegramScoutRpc } from './sources/telegram-scout-rpc.mjs';
import { telegramReadState } from './telegram-read-gate.mjs';
const check=(ok,code)=>ensure(ok,code,409,code);
// One bounded page per clock. Existing SQLite records are the resumable workflow;
// GramJS owns protocol/history decoding. This loop never awaits inference.
export class ScoutRuntime {
 constructor(service,telegram,{rpcFactory=(owner,options)=>new TelegramScoutRpc(owner,options)}={}){this.service=service;this.telegram=telegram;this.rpcFactory=rpcFactory;this.busy=false;this.stopped=false;this.peers=new Map();this.state={disposition:'not_run'};}
 get scout(){return this.service.scout;}
 get db(){return this.service.store;}
 stop(){this.stopped=true;}
 reserve(job,operation,units){
   const {grant}=this.scout.jobAuthority(job);const day=now().slice(0,10),cfg=this.scout.cfg;
   const cooldown=this.db.get("SELECT MAX(retry_at) until_at FROM scout_calls WHERE partner_id=? AND account_id=?",this.scout.partnerId,grant.account_id)?.until_at;
   if(cooldown&&Date.parse(cooldown)>Date.now())return {wait:cooldown,reason:'SCOUT_ACCOUNT_BACKOFF'};
   const source=job.candidate_id?`telegram:channel:${this.scout.candidate(job.candidate_id,job.campaign_id).channel_id}`:null;
   const gate=telegramReadState(this.service,grant.account_id,{sourceId:source,priority:job.kind==='search'?'search':'audit'});
   if(!gate.ready)return {wait:gate.retry_at??new Date(Date.now()+60000).toISOString(),reason:gate.reason};
   const used=this.db.get('SELECT COUNT(*) n FROM scout_calls WHERE partner_id=? AND account_id=? AND created_at>=?',this.scout.partnerId,grant.account_id,day).n;
   const perSource=source?this.db.get('SELECT COUNT(*) n FROM scout_calls WHERE partner_id=? AND account_id=? AND source_ref=? AND created_at>=?',this.scout.partnerId,grant.account_id,source,day).n:0;
   if(used+units>cfg.maxRequestsPerDay||source&&perSource+units>cfg.maxRequestsPerSourceDay)
     return {wait:new Date(Date.parse(`${day}T00:00:00.000Z`)+86400000).toISOString(),reason:'SCOUT_READ_BUDGET'};
   const calls=[];for(let i=0;i<units;i++){const callId=id();this.db.run("INSERT INTO scout_calls(id,partner_id,account_id,job_id,source_ref,operation,status,created_at) VALUES(?,?,?,?,?,?,'started',?)",callId,this.scout.partnerId,grant.account_id,job.id,source,operation,now());calls.push(callId);}
   return {calls,account:grant.account_id};
 }
 settle(calls,status,reason=null,retryAt=null){for(const call of calls)this.db.run('UPDATE scout_calls SET status=?,reason=?,retry_at=?,finished_at=? WHERE id=? AND status=\'started\'',status,reason,retryAt,now(),call);}
 peerKey(candidate){return `${candidate.account_id}:${candidate.channel_id}`;}
 async tick(){
   if(this.busy||this.stopped||!this.scout.enabled||!this.telegram.connected||this.telegram.stopped)return this.state={disposition:'disabled_or_disconnected'};
   this.busy=true;let prepared;
   try{
     prepared=await this.service.exclusive(()=>this.db.transaction(()=>{
       this.scout.reconcile();
       for(const job of this.db.all("SELECT j.* FROM scout_jobs j JOIN scout_campaigns c ON c.id=j.campaign_id JOIN scout_grants g ON g.id=j.grant_id WHERE c.partner_id=? AND g.account_id=? AND j.status='queued' AND j.kind!='assessment' AND j.next_at<=? ORDER BY j.updated_at,j.id LIMIT 30",this.scout.partnerId,this.service.telegramAccountId,now())){
         try{
           const {grant}=this.scout.jobAuthority(job,{runtime:false});
           if(grant.account_id!==this.service.telegramAccountId)continue;
           this.scout.jobAuthority(job);JSON.parse(job.cursor_json);
           const reservation=this.reserve(job,job.kind,job.kind==='history'?2:job.kind==='resolve'?3:1);
           if(reservation.wait){this.db.run('UPDATE scout_jobs SET next_at=?,reason=?,updated_at=? WHERE id=?',reservation.wait,reservation.reason,now(),job.id);continue;}
           this.db.run("UPDATE scout_jobs SET status='running',owner_id=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='queued'",this.service.control.ownerId,now(),job.id);
           return {job,reservation,cursor:JSON.parse(job.cursor_json)};
         }catch(e){if(!(e instanceof AppError)&&!(e instanceof SyntaxError))throw e;this.db.run("UPDATE scout_jobs SET status='stale',reason=?,updated_at=? WHERE id=?",e.code??'SCOUT_RECORD_INVALID',now(),job.id);}
       }return null;
     }));
     if(!prepared)return this.state={disposition:'idle_or_budget_wait'};
     const {job,cursor,reservation}=prepared,rpc=this.rpcFactory(this.telegram,{beforeRead:()=>{check(!this.stopped,'SCOUT_STOPPED');this.scout.jobAuthority(job);const active=this.db.get('SELECT * FROM scout_jobs WHERE id=?',job.id);check(active?.status==='running'&&active.owner_id===this.service.control.ownerId,'SCOUT_JOB_RETIRED');},sourceId:job.candidate_id?`telegram:channel:${this.scout.candidate(job.candidate_id,job.campaign_id).channel_id}`:null,priority:job.kind==='search'?'search':'audit'});check(rpc.accountId===reservation.account,'SCOUT_ACCOUNT_MISMATCH');
     let output;
     try{
       if(job.kind==='search')output=await rpc.search({query:cursor.query,limit:Math.min(30,this.scout.cfg.maxCandidates)});
       else if(job.kind==='resolve'){
         const native=await rpc.resolve(cursor.reference);this.peers.set(`${reservation.account}:${native.channel_id}`,native);
         // A linked discussion is a candidate, never automatically a monitor permission.
         this.scout.jobAuthority(job);output={native,linked:native.kind==='channel'?await rpc.discussions(native):null};
       }else{
         const candidate=this.scout.candidate(job.candidate_id,job.campaign_id),sample=this.scout.sample(job.sample_id);
         let native=this.peers.get(this.peerKey(candidate));
         if(!native){native=await rpc.resolve({channel_id:candidate.channel_id,username:candidate.username});this.peers.set(this.peerKey(candidate),native);}
         this.scout.jobAuthority(job);check(!this.stopped,'SCOUT_STOPPED');
         check(native.channel_id===candidate.channel_id,'SCOUT_IDENTITY_CHANGED');
         output=await rpc.history({...native,before_id:cursor.before_id,until_date:cursor.until,limit:Math.min(100,this.scout.cfg.maxMessagesPerAudit-(cursor.scanned??0))});
       }
     }catch(e){
       return this.state=await this.service.exclusive(()=>this.db.transaction(()=>{
         if(!this.service.control.processCurrent())return {disposition:'ownership_lost'};
         // Persist provider backoff even after revoke; it is account health, not source authority.
         const retrySeconds=['SCOUT_FLOOD_WAIT','SCOUT_FLOOD_WAIT_MANUAL'].includes(e.code)?e.retrySeconds:null;
         const retryAt=retrySeconds?new Date(Date.now()+retrySeconds*1000).toISOString():null;
         this.settle(reservation.calls,e.code==='SCOUT_RPC_TIMEOUT'?'unknown':'failed',e.code??'SCOUT_READ_FAILED',retryAt);
         const current=this.db.get('SELECT * FROM scout_jobs WHERE id=?',job.id);
         if(current?.status==='running'&&current.owner_id===this.service.control.ownerId){
           const gate=telegramReadState(this.service,reservation.account),held=['SCOUT_READ_BUDGET','SCOUT_ACCOUNT_BACKOFF','SCOUT_READ_QUEUE_FULL'].includes(e.code);
           const retry=retryAt??(held?gate.retry_at??new Date(Date.now()+60000).toISOString():null);
           this.db.run('UPDATE scout_jobs SET status=?,reason=?,next_at=?,updated_at=? WHERE id=?',retry&&e.code!=='SCOUT_FLOOD_WAIT_MANUAL'?'queued':'failed',e.code??'SCOUT_READ_FAILED',retry??now(),now(),job.id);
         }return {disposition:retryAt?'backoff':'read_failed',job_id:job.id,reason:e.code??'SCOUT_READ_FAILED'};
       }));
     }
     return this.state=await this.service.exclusive(()=>this.db.transaction(()=>{
       if(!this.service.control.processCurrent())return {disposition:'ownership_lost'};
       const current=this.db.get('SELECT * FROM scout_jobs WHERE id=?',job.id);
       this.settle(reservation.calls,'completed');
       try{check(!this.stopped&&current?.status==='running'&&current.owner_id===this.service.control.ownerId,'SCOUT_JOB_RETIRED');this.scout.jobAuthority(current);check(rpc.connected()&&rpc.accountId===reservation.account,'SCOUT_CONNECTION_CHANGED');}
       catch(e){if(!(e instanceof AppError))throw e;this.db.run("UPDATE scout_jobs SET status='stale',reason=?,updated_at=? WHERE id=? AND status='running'",e.code,now(),job.id);return {disposition:'withheld',reason:e.code};}
       const {campaign,grant}=this.scout.jobAuthority(current);
       if(job.kind==='search'){
         check(output&&Array.isArray(output.candidates)&&output.candidates.length<=30,'SCOUT_SEARCH_INVALID');
         for(const native of output.candidates){
           if(this.db.get('SELECT COUNT(*) n FROM scout_candidates WHERE campaign_id=?',campaign.id).n>=this.scout.cfg.maxCandidates)break;
           const candidate=this.scout.upsertCandidate(campaign,grant,native,{kind:'telegram_username_search',query:cursor.query,inexact:true,observed_at:now()});
           this.peers.set(this.peerKey(candidate),native);
           this.queueAudit(campaign,grant,candidate);
           if(native.kind==='channel'&&native.username)this.scout.enqueue(campaign,grant,'resolve',{reference:{channel_id:native.channel_id,username:native.username}},candidate.id);
         }
       }else if(job.kind==='resolve'){
         const candidate=this.scout.upsertCandidate(campaign,grant,output.native,{kind:'owner_seed_or_resolved_candidate',reference:cursor.reference,observed_at:now()});this.queueAudit(campaign,grant,candidate);
         if(output.linked){const linked=this.scout.upsertCandidate(campaign,grant,output.linked,{kind:'linked_discussion',channel_id:output.native.channel_id,observed_at:now()});this.peers.set(this.peerKey(linked),output.linked);this.queueAudit(campaign,grant,linked);}
       }else{return this.applyHistory(current,cursor,output);}
       this.db.run("UPDATE scout_jobs SET status='completed',reason='BOUNDED_SEARCH_NOT_EXHAUSTIVE',updated_at=? WHERE id=?",now(),job.id);return {disposition:'candidates_added',job_id:job.id};
     }));
   }catch(e){
     if(prepared){await this.service.exclusive(()=>this.db.transaction(()=>{
       if(!this.service.control.processCurrent())return;
       const invalid=e instanceof AppError||e instanceof SyntaxError;
       const reason=invalid?e.code??'SCOUT_RECORD_INVALID':'RESULT_PERSIST_FAILED';
       this.settle(prepared.reservation.calls,invalid?'failed':'unknown',reason);
       this.db.run("UPDATE scout_jobs SET status=?,reason=?,updated_at=? WHERE id=? AND status='running' AND owner_id=?",invalid?'failed':'interrupted',reason,now(),prepared.job.id,this.service.control.ownerId);
     }));}throw e;
   }finally{this.busy=false;}
 }
 queueAudit(c,g,candidate){
   const pending=this.db.get("SELECT id FROM scout_jobs WHERE campaign_id=? AND campaign_revision=? AND grant_id=? AND candidate_id=? AND kind='history' AND status IN ('queued','running','interrupted') LIMIT 1",c.id,c.revision,g.id,candidate.id);if(pending)return;
   this.scout.command('scout.audit',{campaign_id:c.id,revision:c.revision,candidate_id:candidate.id},{kind:'operator'});
 }
 applyHistory(job,cursor,page){
   check(page&&Array.isArray(page.messages)&&typeof page.empty==='boolean'&&Number.isInteger(page.requested_count)&&page.requested_count>0&&page.requested_count<=100&&Number.isInteger(page.received_count)&&page.received_count>=0&&page.received_count<=page.requested_count&&page.messages.length<=page.received_count&&page.empty===(page.received_count===0),'SCOUT_PAGE_INVALID');
   check(Number.isSafeInteger(cursor.before_id)&&cursor.before_id>=0&&Number.isSafeInteger(cursor.scanned??0)&&(cursor.scanned??0)>=0&&Date.parse(cursor.from)<Date.parse(cursor.until),'SCOUT_HISTORY_CURSOR_INVALID');
   const sample=this.scout.sample(job.sample_id),prior=JSON.parse(sample.messages_json),messages=new Map(prior.map(m=>[m.message_id,m]));
   check(sample.status==='collecting'&&sample.requested_from===cursor.from&&sample.requested_until===cursor.until,'SCOUT_HISTORY_CURSOR_INVALID');
   let before=page.oldest_id,reached=false;
   check(page.empty===true||Number.isInteger(before)&&before>0&&(!cursor.before_id||before<cursor.before_id),'SCOUT_HISTORY_CURSOR_INVALID');
   for(const m of page.messages){
     check(m&&/^[1-9][0-9]*$/.test(m.message_id)&&Number(m.message_id)<=2147483647&&Number.isFinite(Date.parse(m.date))&&typeof m.content_hash==='string'&&/^[a-f0-9]{64}$/.test(m.content_hash)&&(m.text===null||typeof m.text==='string'&&m.text.length<=16000),'SCOUT_MESSAGE_INVALID');
     check(!cursor.before_id||Number(m.message_id)<cursor.before_id,'SCOUT_HISTORY_CURSOR_INVALID');
     if(Date.parse(m.date)<Date.parse(cursor.from)){reached=true;continue;}
     if(Date.parse(m.date)>Date.parse(cursor.until))continue;
     const old=messages.get(m.message_id);check(!old||digest(old)===digest(m),'SCOUT_HISTORY_CHANGED');messages.set(m.message_id,m);
   }
   const scanned=(cursor.scanned??0)+page.received_count;
   check(scanned<=this.scout.cfg.maxMessagesPerAudit,'SCOUT_PAGE_LIMIT_INVALID');
   const bounded=[...messages.values()].slice(0,this.scout.cfg.maxMessagesPerAudit),capacity=scanned>=this.scout.cfg.maxMessagesPerAudit;
   const done=page.empty===true||reached||capacity;
   const coverage=capacity?'message_limit':reached?'requested_window_sampled':page.empty?(bounded.length?'visible_history_end':'no_visible_messages'):'unverified';
   const fingerprint=done?digest({source_ref:sample.source_ref,account_id:sample.account_id,from:sample.requested_from,until:sample.requested_until,source_cursor:sample.source_cursor,messages:bounded,coverage}):null;
   this.db.run('UPDATE scout_samples SET messages_json=?,status=?,coverage=?,metrics_json=?,digest=?,finished_at=? WHERE id=? AND status=\'collecting\'',JSON.stringify(bounded),done?'sealed':'collecting',coverage,done?JSON.stringify(scoutSignals(bounded).metrics):null,fingerprint,done?now():null,sample.id);
   this.db.run('UPDATE scout_jobs SET status=?,cursor_json=?,next_at=?,updated_at=?,reason=? WHERE id=?',done?'completed':'queued',JSON.stringify({...cursor,before_id:before??cursor.before_id,messages:bounded.length,scanned}),new Date(Date.now()+1000).toISOString(),now(),done?coverage:null,job.id);
   if(done)this.db.run('UPDATE scout_candidates SET sample_id=?,reason=?,updated_at=? WHERE id=?',sample.id,coverage,now(),job.candidate_id);
   return {disposition:done?'sample_sealed':'sample_page',sample_id:sample.id,messages:bounded.length,continuous_coverage:false};
 }
}
