import fs from 'node:fs';
import path from 'node:path';
import { ROOT, runtimeReadiness, usageAccounting } from './config.mjs';
import { id } from './store.mjs';
import { now, AppError, ensure } from './errors.mjs';
import { scoutSignals } from './scout-signals.mjs';
import { SCOUT_EVALUATOR_VERSION } from './scout.mjs';
import { digest } from './source-ingestion.mjs';
import { normalizeFailureCause } from './failure-cause.mjs';
import { SCOUT_ASSESSMENT_CONTRACT as contract, scoutAssessmentOutput } from './scout-assessment-output.mjs';
const instructions=fs.readFileSync(path.join(ROOT,'partner/scout-assessment.md'),'utf8').replace(/\r\n/g,'\n');
const check=(ok,code)=>ensure(ok,code,409,code);
export async function processScoutAssessment(service,runtime){
 const scout=service.scout,db=service.store;
 if(!scout.enabled||scout.cfg.modelEnabled!==true)return {disposition:'disabled'};
 if(service.scoutReasoningFault)return {disposition:'receipt_persistence_unproven'};
 if(!runtimeReadiness(service.config,{decision:true}).ready)return {disposition:'waiting_model'};
 return service.control.run('public','source_assessment',async()=>{
   const prepared=await service.exclusive(()=>db.transaction(()=>{
     const count=db.get("SELECT COUNT(*) n FROM runs WHERE partner_id=? AND runtime='hermes-scout-v1' AND created_at>=?",scout.partnerId,now().slice(0,10)).n;
     if(count>=scout.cfg.maxModelRunsPerDay)return null;
     for(const job of db.all("SELECT j.* FROM scout_jobs j JOIN scout_campaigns c ON c.id=j.campaign_id JOIN scout_grants g ON g.id=j.grant_id WHERE c.partner_id=? AND g.account_id=? AND j.kind='assessment' AND j.status='queued' AND j.next_at<=? ORDER BY j.updated_at,j.id LIMIT 20",scout.partnerId,service.telegramAccountId,now())){
       try{
         const {grant}=scout.jobAuthority(job,{runtime:false});
         if(grant.account_id!==service.telegramAccountId)continue;
         const {campaign}=scout.jobAuthority(job),candidate=scout.candidate(job.candidate_id,campaign.id),sample=scout.sample(job.sample_id,candidate),cursor=JSON.parse(job.cursor_json);scout.sampleFresh(sample);
         check(cursor.sample_digest===sample.digest&&cursor.topic_hash===campaign.topic_hash&&cursor.evaluator_version===SCOUT_EVALUATOR_VERSION,'SCOUT_ASSESSMENT_STALE');
         const signals=scoutSignals(JSON.parse(sample.messages_json));check(signals.groups.length>0,'SCOUT_SEMANTIC_SAMPLE_EMPTY');
         const runId=id();db.run("INSERT INTO runs(id,partner_id,status,runtime,model,context_json,created_at) VALUES(?,?,'running','hermes-scout-v1',?,?,?)",runId,scout.partnerId,service.config.runtime.model,JSON.stringify({job_id:job.id,campaign_id:campaign.id,campaign_revision:campaign.revision,campaign_config:JSON.parse(campaign.config_json),sample_id:sample.id,sample_digest:sample.digest,evaluator_version:SCOUT_EVALUATOR_VERSION,instructions_digest:digest(instructions),output_contract_digest:digest(contract),model_config:service.config.runtime}),now());
         service.control.bindRun(runId);db.run("UPDATE scout_jobs SET status='running',run_id=?,owner_id=?,attempts=attempts+1,updated_at=? WHERE id=?",runId,service.control.ownerId,now(),job.id);
         return {job,campaign,sample,signals,run:db.get('SELECT * FROM runs WHERE id=?',runId),context:{packet:{campaign:JSON.parse(campaign.config_json),sample:{id:sample.id,digest:sample.digest,coverage:sample.coverage,from:sample.requested_from,until:sample.requested_until},...signals,contact_permission:false},input:{situation_id:job.id},output_contract:contract,router_instructions:instructions}};
       }catch(e){if(!(e instanceof AppError)&&!(e instanceof SyntaxError))throw e;db.run("UPDATE scout_jobs SET status='stale',reason=?,updated_at=? WHERE id=?",e.code??'SCOUT_RECORD_INVALID',now(),job.id);}
     }return null;
   }));
   if(!prepared)return {disposition:'idle_or_budget'};
   let result;try{result=await runtime.decide(prepared.run,prepared.context);}catch(error){result={completed:false,failure_cause:normalizeFailureCause(error?.failure_cause)};}
   try{return await service.exclusive(()=>db.transaction(()=>{
     // Lost processes must not write even usage into a successor's state.
     if(!service.control.processCurrent())return {disposition:'ownership_lost'};
     const current=db.get('SELECT * FROM scout_jobs WHERE id=?',prepared.job.id),spent=usageAccounting(JSON.parse(prepared.run.context_json).model_config,result?.usage);
     let assessmentId=null,reason='SCOUT_MODEL_FAILED',diagnostic=null;
     try{
       check(current?.status==='running'&&current.owner_id===service.control.ownerId&&scout.enabled&&scout.cfg.modelEnabled===true&&service.control.canApply(prepared.run.id),'SCOUT_RESULT_RETIRED');
       const {campaign}=scout.jobAuthority(current),sample=scout.sample(current.sample_id);scout.sampleFresh(sample);
       check(campaign.topic_hash===prepared.campaign.topic_hash&&sample.digest===prepared.sample.digest,'SCOUT_ASSESSMENT_STALE');
       const checked=scoutAssessmentOutput(result,prepared.signals.groups);diagnostic=checked.diagnostic;
       check(checked.output,checked.reason);const output=checked.output;
       assessmentId=id();db.run("INSERT INTO scout_assessments(id,campaign_id,campaign_revision,candidate_id,sample_id,sample_digest,topic_hash,evaluator_version,output_json,run_id,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'proposed',?)",assessmentId,campaign.id,campaign.revision,current.candidate_id,sample.id,sample.digest,campaign.topic_hash,SCOUT_EVALUATOR_VERSION,JSON.stringify(output),prepared.run.id,now());reason='SCOUT_ASSESSMENT_PROPOSED';
     }catch(e){if(!(e instanceof AppError)&&!(e instanceof SyntaxError))throw e;reason=e.code??'SCOUT_OUTPUT_INVALID';}
     db.run('UPDATE scout_jobs SET status=?,reason=?,updated_at=? WHERE id=? AND status=\'running\' AND owner_id=?',assessmentId?'completed':'failed',reason,now(),prepared.job.id,service.control.ownerId);
     db.run('UPDATE runs SET status=?,result_json=?,error=?,input_tokens=?,output_tokens=?,estimated_cost_usd=?,cost_status=?,finished_at=? WHERE id=?',assessmentId?'completed':'failed',JSON.stringify({assessment_id:assessmentId,reason,diagnostic}),assessmentId?null:reason,spent.input,spent.output,spent.cost,spent.costStatus,now(),prepared.run.id);
     return {disposition:assessmentId?'assessment_proposed':'withheld',assessment_id:assessmentId,reason,diagnostic};
   }));}catch(error){
     // A model result without a durable receipt is not a successful assessment.
     // Do not repeat a billable job automatically; leave explicit retry to the owner.
     service.scoutReasoningFault=true;
     try{await service.exclusive(()=>db.transaction(()=>{
       if(!service.control.processCurrent())return;
       const spent=usageAccounting(JSON.parse(prepared.run.context_json).model_config,result?.usage);
       db.run("UPDATE scout_jobs SET status='interrupted',reason='SCOUT_RECEIPT_PERSIST_FAILED',updated_at=? WHERE id=? AND status='running' AND owner_id=?",now(),prepared.job.id,service.control.ownerId);
       db.run("UPDATE runs SET status='interrupted',error='SCOUT_RECEIPT_PERSIST_FAILED',input_tokens=?,output_tokens=?,estimated_cost_usd=?,cost_status=?,finished_at=? WHERE id=? AND status='running'",spent.input,spent.output,spent.cost,spent.costStatus,now(),prepared.run.id);
     }));}catch{ /* Startup recovery preserves unknown, never auto-inference. */ }
     throw error;
   }
 });
}
