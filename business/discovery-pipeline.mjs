import { id } from './store.mjs';
import { now } from './errors.mjs';
import { automaticBoundary } from './source-ingestion.mjs';
import { runtimeReadiness, usageAccounting } from './config.mjs';
import { normalizeFailureCause } from './failure-cause.mjs';
import { collectDiscovery, sweepDiscovery, discoveryContext, discoveryFreshness, suppressDiscovery } from './discovery.mjs';
import { parseDiscoveryOutput, discoveryEvidence } from './discovery-projection.mjs';

const RUNTIME='hermes-discovery';
function complete(service,run) {
  const saved=JSON.parse(run.context_json),s=service.store.get('SELECT * FROM discovery_situations WHERE id=?',saved.situation_id);
  const freshness=s?discoveryFreshness(service,s):null;
  const stale=!s || s.revision!==saved.revision || freshness.semantic_reasons.length;
  if(stale) {
    service.store.run("UPDATE runs SET status='stale',error='DISCOVERY_CONTEXT_CHANGED',finished_at=? WHERE id=?",now(),run.id);
    return {disposition:'stale'};
  }
  if(!freshness.fresh)return {disposition:freshness.availability,reasons:freshness.reasons};
  let output;
  try {output=parseDiscoveryOutput(JSON.parse(run.result_json).final_response,saved.context);}
  catch {service.store.run("UPDATE runs SET status='failed',error='DISCOVERY_INVALID_OUTPUT',finished_at=? WHERE id=?",now(),run.id);return {disposition:'invalid_model_output'};}
  const decisionId=id();
  service.store.run("UPDATE discovery_decisions SET status='superseded' WHERE situation_id=? AND status='current'",s.id);
  service.store.run(`INSERT INTO discovery_decisions(id,situation_id,revision,run_id,input_json,output_json,evidence_json,created_at,status)
    VALUES(?,?,?,?,?,?,?,?,'current')`,decisionId,s.id,s.revision,run.id,JSON.stringify(saved.context),JSON.stringify(output),JSON.stringify(discoveryEvidence(output)),now());
  service.store.run('UPDATE discovery_situations SET current_decision_id=?,status=?,updated_at=? WHERE id=?',decisionId,output.decision==='STOP'?'stopped':'active',now(),s.id);
  if(output.decision==='STOP')suppressDiscovery(service,s,'stopped');
  service.store.run("UPDATE runs SET status='completed',finished_at=? WHERE id=?",now(),run.id);
  service.store.event(service.config.partnerId,null,'discovery.decided','system',{situation_id:s.id,decision_id:decisionId,revision:s.revision,decision:output.decision});
  return {disposition:'decided',situation_id:s.id,decision_id:decisionId,decision:output.decision};
}
function prepare(service) {
  automaticBoundary(service);sweepDiscovery(service);
  if(!service.config.discovery?.enabled)return {result:{disposition:'disabled'}};
  if(!service.config.opportunity.activeOffer)return {result:{disposition:'waiting_offer'}};
  collectDiscovery(service);
  let waiting='idle';
  // Complete saved results before allocating another inference. A blocked source cannot starve others.
  for(const run of service.store.all("SELECT * FROM runs WHERE partner_id=? AND runtime=? AND status='analyzed' ORDER BY created_at",service.config.partnerId,RUNTIME)) {
    const result=complete(service,run);
    if(!['waiting_source','integrity_blocked'].includes(result.disposition))return {result};
    waiting=result.disposition;
  }
  for(const s of service.store.all("SELECT * FROM discovery_situations WHERE partner_id=? AND status='active' AND not_before<=? ORDER BY updated_at,id",service.config.partnerId,now())) {
    if(service.store.get('SELECT id FROM discovery_decisions WHERE situation_id=? AND revision=?',s.id,s.revision))continue;
    const fresh=discoveryFreshness(service,s);
    if(!fresh.fresh){waiting=fresh.semantic_reasons.length?'context_unavailable':fresh.availability;continue;}
    const attempts=service.store.all(`SELECT * FROM runs WHERE partner_id=? AND runtime=? AND json_extract(context_json,'$.situation_id')=?
      AND json_extract(context_json,'$.revision')=? ORDER BY rowid DESC`,service.config.partnerId,RUNTIME,s.id,s.revision);
    if(attempts.some(r=>['running','analyzed'].includes(r.status)))continue;
    if(attempts.length>=3){waiting='attempt_limit';continue;}
    if(attempts[0] && Date.now()-Date.parse(attempts[0].finished_at??attempts[0].created_at)<service.config.scheduler.tickSeconds*1000*2**(attempts.length-1)){
      waiting='waiting_retry';continue;
    }
    const ready=runtimeReadiness(service.config,{decision:true});
    if(!ready.ready)return {result:{disposition:'waiting_model',missing:ready.missing}};
    const cfg=service.config.runtime,usage=service.store.get(`SELECT COUNT(*) AS n,COALESCE(SUM(estimated_cost_usd),0) AS cost,
      SUM(CASE WHEN cost_status='unknown' THEN 1 ELSE 0 END) AS unknown FROM runs WHERE created_at>=?`,now().slice(0,10));
    if(usage.n>=cfg.maxRunsPerDay || cfg.dailyBudgetUsd!==null && (usage.unknown>0 || usage.cost>=cfg.dailyBudgetUsd))return {result:{disposition:'budget_blocked'}};
    const context=discoveryContext(service,s),runId=id();
    service.store.run(`INSERT INTO runs(id,partner_id,status,runtime,model,context_json,created_at) VALUES(?,?,'running',?,?,?,?)`,
      runId,service.config.partnerId,RUNTIME,cfg.model,JSON.stringify({situation_id:s.id,revision:s.revision,context,model_config:cfg}),now());
    return {run:service.store.get('SELECT * FROM runs WHERE id=?',runId),context};
  }
  return {result:{disposition:waiting}};
}
export async function processDiscovery(service,runtime) {
  const prepared=await service.exclusive(()=>service.store.transaction(()=>prepare(service)));
  if(prepared.result)return prepared.result;
  let result;
  try {result=await runtime.decide(prepared.run,prepared.context);}
  catch(error){result={completed:false,failure_cause:normalizeFailureCause(error?.failure_cause)};}
  const messages=Array.isArray(result?.messages)?result.messages:[];
  const tools=result?.tool_calls?.length || result?.messages!=null && !Array.isArray(result.messages)
    || messages.some(m=>m?.role==='tool' || m?.tool_calls?.length || m?.function_call);
  const ok=result?.completed===true && !result.error && !tools && typeof result.final_response==='string' && Buffer.byteLength(result.final_response)<=90000;
  try {
    await service.exclusive(()=>service.store.transaction(()=>{
      const u=usageAccounting(JSON.parse(prepared.run.context_json).model_config,result?.usage);
      // Bill late cancelled results, but never resurrect forgotten content.
      service.store.run('UPDATE runs SET input_tokens=?,output_tokens=?,estimated_cost_usd=?,cost_status=?,finished_at=? WHERE id=?',u.input,u.output,u.cost,u.costStatus,now(),prepared.run.id);
      service.store.run("UPDATE runs SET status=?,result_json=?,error=? WHERE id=? AND status='running'",ok?'analyzed':'failed',
        JSON.stringify({final_response:ok?result.final_response:'',failure_cause:ok?null:normalizeFailureCause(result?.failure_cause)}),ok?null:'MODEL_FAILED',prepared.run.id);
    }));
  } catch(error) {
    await service.exclusive(()=>service.store.transaction(()=>service.store.run("UPDATE runs SET status='interrupted',error='RESULT_PERSIST_FAILED',finished_at=? WHERE id=? AND status='running'",now(),prepared.run.id)));
    throw error;
  }
  if(!ok)return {disposition:'model_failed'};
  return service.exclusive(()=>service.store.transaction(()=>{
    automaticBoundary(service);sweepDiscovery(service);
    const run=service.store.get('SELECT * FROM runs WHERE id=?',prepared.run.id);
    return run.status==='analyzed'?complete(service,run):{disposition:'cancelled'};
  }));
}
