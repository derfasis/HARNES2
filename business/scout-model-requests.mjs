// Explicit, finite model-call authority for one sealed historical Scout sample.
// The separate Scout audit grant remains the sole authority for Telegram reads.
import { id } from './store.mjs';
import { AppError, now, requiredText } from './errors.mjs';
import { digest } from './source-ingestion.mjs';

const HASH = /^[a-f0-9]{64}$/;
const DEF_KEYS = 'version,id,partner_id,job_id,campaign_id,campaign_revision,topic_hash,audit_grant_id,account_id,candidate_id,channel_id,sample_id,sample_digest,sample_source_ref,sample_cursor,sample_finished_at,evaluator_version,model_profile_id,profile_hash,purpose,execution_bounds,model_config,expires_at,created_at';
const PROFILE_CONFIG_KEYS = ['provider','apiMode','baseUrl','model','maxOutputTokens','inputUsdPerMillion','outputUsdPerMillion'];
const check = (ok, code, status = 409) => { if (!ok) throw new AppError(code,status,code); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
const parse = value => { try { return JSON.parse(value); } catch { check(false,'SCOUT_MODEL_REQUEST_INVALID'); } };
const isUuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);

function expiry(raw) {
  check(typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(raw), 'SCOUT_MODEL_REQUEST_EXPIRY_INVALID', 400);
  const ms = Date.parse(raw), at = Date.now();
  check(Number.isFinite(ms) && ms > at && ms <= at + 7 * 86400000, 'SCOUT_MODEL_REQUEST_EXPIRY_INVALID', 400);
  return new Date(ms).toISOString();
}

export class ScoutModelRequests {
  constructor(service) { this.service=service; this.db=service.store; }
  get partnerId() { return this.service.config.partnerId; }

  managedActivation() {
    if (!this.service.deployment) return;
    const activation=this.service.deployment.summary?.();
    check(activation?.phase === 'active'
      && this.service.deployment.mode === 'scoped_reasoning', 'CONTROL_ACTIVATION_MODELS_OFF');
    this.service.deployment.assertModelAllowed();
  }

  profile(profileId, expectedHash) {
    check(isUuid(profileId) && HASH.test(expectedHash ?? ''), 'SCOUT_MODEL_PROFILE_REQUIRED', 400);
    const profile=this.service.modelProfiles.resolve(profileId);
    check(profile.definition_hash===expectedHash, 'SCOUT_MODEL_PROFILE_STALE');
    const record=this.service.modelProfiles.get(profileId);
    check(record.state==='available' && record.block_reasons.length===0, record.block_reasons[0]??'SCOUT_MODEL_PROFILE_UNAVAILABLE');
    const timeoutSeconds=this.service.config.runtime?.timeoutSeconds;
    check(Number.isInteger(timeoutSeconds)&&timeoutSeconds>=10&&timeoutSeconds<=1800,'SCOUT_MODEL_REQUEST_BOUNDS_INVALID');
    const execution_bounds={timeout_seconds:timeoutSeconds,max_api_calls:1,max_iterations:2,max_output_tokens:profile.model_config.maxOutputTokens};
    const model_config=Object.fromEntries(PROFILE_CONFIG_KEYS.map(k=>[k,profile.model_config[k]]));
    Object.assign(model_config,{timeoutSeconds:execution_bounds.timeout_seconds,maxApiCalls:execution_bounds.max_api_calls,
      maxIterations:execution_bounds.max_iterations});
    return {profile,model_config,execution_bounds};
  }

  validateDefinition(row) {
    check(row&&row.partner_id===this.partnerId&&isUuid(row.id)&&isUuid(row.job_id)
      && isUuid(row.model_profile_id)&&HASH.test(row.request_fingerprint??''), 'SCOUT_MODEL_REQUEST_INVALID');
    const d=parse(row.definition_json);
    if(d?.version===2)return this.service.scout.queries.validateModelDefinition(row,d);
    check(exact(d,DEF_KEYS)&&d.version===1&&d.id===row.id&&d.partner_id===row.partner_id&&d.job_id===row.job_id
      &&d.model_profile_id===row.model_profile_id&&d.expires_at===row.expires_at
      &&Number.isInteger(d.campaign_revision)&&d.campaign_revision>0&&HASH.test(d.topic_hash??'')
      &&isUuid(d.audit_grant_id)&&/^[1-9][0-9]{0,18}$/.test(d.account_id??'')&&isUuid(d.candidate_id)
      &&/^[1-9][0-9]{0,18}$/.test(d.channel_id??'')&&isUuid(d.sample_id)&&HASH.test(d.sample_digest??'')
      &&d.sample_source_ref===`telegram:channel:${d.channel_id}`&&Number.isSafeInteger(d.sample_cursor)&&d.sample_cursor>=0
      &&Number.isFinite(Date.parse(d.sample_finished_at))&&typeof d.evaluator_version==='string'&&d.evaluator_version.length>0
      &&d.evaluator_version===this.service.scout.evaluatorVersion
      &&HASH.test(d.profile_hash??'')&&typeof d.purpose==='string'&&d.purpose.trim().length>0&&d.purpose.length<=500
      &&exact(d.execution_bounds,'timeout_seconds,max_api_calls,max_iterations,max_output_tokens')
      &&Number.isInteger(d.execution_bounds.timeout_seconds)&&d.execution_bounds.timeout_seconds>=10&&d.execution_bounds.timeout_seconds<=1800
      &&d.execution_bounds.max_api_calls===1&&d.execution_bounds.max_iterations===2
      &&Number.isInteger(d.execution_bounds.max_output_tokens)&&d.execution_bounds.max_output_tokens>=1
      &&exact(d.model_config,'provider,apiMode,baseUrl,model,maxOutputTokens,inputUsdPerMillion,outputUsdPerMillion,timeoutSeconds,maxApiCalls,maxIterations')
      &&d.model_config.timeoutSeconds===d.execution_bounds.timeout_seconds&&d.model_config.maxApiCalls===1
      &&d.model_config.maxIterations===2&&d.model_config.maxOutputTokens===d.execution_bounds.max_output_tokens
      &&Number.isFinite(Date.parse(d.created_at))&&Number.isFinite(Date.parse(d.expires_at))
      &&Date.parse(d.expires_at)>Date.parse(d.created_at)&&Date.parse(d.expires_at)<=Date.parse(d.created_at)+7*86400000
      &&(row.run_id===null||isUuid(row.run_id))&&['active','revoked'].includes(row.status)
      &&(row.status==='active'?row.revoked_at===null&&row.revocation_reason===null
        :typeof row.revoked_at==='string'&&Number.isFinite(Date.parse(row.revoked_at))
          &&typeof row.revocation_reason==='string'&&row.revocation_reason.trim().length>0)
      &&digest(d)===row.request_fingerprint, 'SCOUT_MODEL_REQUEST_INVALID');
    return d;
  }

  rowForJob(jobId) {
    const row=this.db.get('SELECT * FROM scout_model_requests WHERE job_id=? AND partner_id=?',jobId,this.partnerId);
    if (!row) return null;
    this.validateDefinition(row);
    return row;
  }

  create(p,c,grant,candidate,sample) {
    this.managedActivation();
    const scout=this.service.scout;
    scout.current(c);scout.sampleFresh(sample);
    check(scout.grantCurrent(grant,c,'audit')&&grant.id&&grant.account_id===this.service.telegramAccountId
      &&candidate.campaign_id===c.id&&candidate.account_id===grant.account_id
      &&sample.id&&sample.account_id===candidate.account_id
      &&sample.source_ref===`telegram:channel:${candidate.channel_id}`,'SCOUT_AUDIT_AUTHORITY_REQUIRED');
    const currentSample=scout.sample(sample.id,candidate);scout.sampleFresh(currentSample);
    check(currentSample.digest===sample.digest&&currentSample.status==='sealed','SCOUT_SAMPLE_STALE');
    const {profile,model_config,execution_bounds}=this.profile(p.model_profile_id,p.expected_model_profile_hash);
    const expires_at=expiry(p.expires_at),purpose=requiredText(p.purpose,'purpose',500);
    const requestId=id(),jobId=id(),created_at=now();
    const cursor={sample_digest:currentSample.digest,topic_hash:c.topic_hash,evaluator_version:scout.evaluatorVersion};
    const d={version:1,id:requestId,partner_id:this.partnerId,job_id:jobId,campaign_id:c.id,campaign_revision:c.revision,
      topic_hash:c.topic_hash,audit_grant_id:grant.id,account_id:candidate.account_id,candidate_id:candidate.id,
      channel_id:candidate.channel_id,sample_id:currentSample.id,sample_digest:currentSample.digest,
      sample_source_ref:currentSample.source_ref,sample_cursor:currentSample.source_cursor,sample_finished_at:currentSample.finished_at,
      evaluator_version:scout.evaluatorVersion,model_profile_id:profile.profile_id,
      profile_hash:profile.definition_hash,purpose,execution_bounds,model_config,expires_at,created_at};
    const fingerprint=digest(d);
    const exactPrior=this.db.get(`SELECT * FROM scout_model_requests WHERE partner_id=? AND
      json_extract(definition_json,'$.campaign_id')=? AND json_extract(definition_json,'$.campaign_revision')=?
      AND json_extract(definition_json,'$.topic_hash')=? AND json_extract(definition_json,'$.audit_grant_id')=?
      AND json_extract(definition_json,'$.account_id')=? AND json_extract(definition_json,'$.candidate_id')=?
      AND json_extract(definition_json,'$.sample_id')=? AND json_extract(definition_json,'$.sample_digest')=?
      AND json_extract(definition_json,'$.model_profile_id')=? AND json_extract(definition_json,'$.profile_hash')=?
      AND json_extract(definition_json,'$.expires_at')=? AND json_extract(definition_json,'$.purpose')=? LIMIT 1`,
    this.partnerId,d.campaign_id,d.campaign_revision,d.topic_hash,d.audit_grant_id,d.account_id,d.candidate_id,d.sample_id,
    d.sample_digest,d.model_profile_id,d.profile_hash,d.expires_at,d.purpose);
    if(exactPrior){
      const previous=this.validateDefinition(exactPrior),priorJob=this.db.get('SELECT id,status FROM scout_jobs WHERE id=?',previous.job_id);
      return {job_id:priorJob.id,request_id:exactPrior.id,fingerprint:exactPrior.request_fingerprint,status:priorJob.status,reused:true};
    }
    const pending=this.db.get(`SELECT r.* FROM scout_model_requests r JOIN scout_jobs j ON j.id=r.job_id
      WHERE r.partner_id=? AND r.status='active' AND r.expires_at>? AND j.status IN ('queued','running') AND j.kind='assessment'
      AND json_extract(r.definition_json,'$.campaign_id')=? AND json_extract(r.definition_json,'$.campaign_revision')=?
      AND json_extract(r.definition_json,'$.audit_grant_id')=? AND json_extract(r.definition_json,'$.candidate_id')=?
      AND json_extract(r.definition_json,'$.sample_id')=? LIMIT 1`,this.partnerId,now(),d.campaign_id,d.campaign_revision,d.audit_grant_id,d.candidate_id,d.sample_id);
    check(!pending,'SCOUT_MODEL_REQUEST_PENDING');
    check(this.db.get('SELECT COUNT(*) n FROM scout_jobs WHERE campaign_id=?',c.id).n<300,'SCOUT_JOB_HISTORY_CAPACITY');
    // BusinessService.execute owns the command receipt transaction. Keep the job,
    // request authority and audit event in that transaction without nesting BEGIN.
    this.db.run("INSERT INTO scout_jobs(id,campaign_id,campaign_revision,grant_id,candidate_id,kind,status,cursor_json,sample_id,next_at,created_at,updated_at) VALUES(?,?,?,?,?,'assessment','queued',?,?,?,?,?)",
      jobId,c.id,c.revision,grant.id,candidate.id,JSON.stringify({sample_digest:currentSample.digest,topic_hash:c.topic_hash,evaluator_version:d.evaluator_version}),
      currentSample.id,now(),created_at,created_at);
    this.db.run("INSERT INTO scout_model_requests(id,partner_id,job_id,run_id,model_profile_id,definition_json,request_fingerprint,expires_at,status,revoked_at,revocation_reason) VALUES(?,?,?,NULL,?,?,?,?,'active',NULL,NULL)",
      requestId,this.partnerId,jobId,profile.profile_id,JSON.stringify(d),fingerprint,expires_at);
    this.db.event(this.partnerId,null,'scout.assessment_request_created','operator',{request_id:requestId,request_fingerprint:fingerprint,
      job_id:jobId,campaign_id:c.id,candidate_id:candidate.id,sample_id:currentSample.id,model_profile_id:profile.profile_id,expires_at});
    return {job_id:jobId,request_id:requestId,fingerprint,status:'queued',reused:false};
  }

  liveBindings(row,d,job,{runtime=true,allowSpent=false}={}) {
    check(row.status==='active'&&Date.parse(row.expires_at)>Date.now(),'SCOUT_MODEL_REQUEST_REVOKED_OR_EXPIRED');
    const scout=this.service.scout;
    if(runtime){scout.ready();this.managedActivation();}
    const {campaign,grant}=scout.jobAuthority(job,{runtime:false});
    check(job.id===d.job_id&&job.kind==='assessment'&&job.campaign_id===d.campaign_id
      &&job.campaign_revision===d.campaign_revision&&job.grant_id===d.audit_grant_id
      &&job.candidate_id===d.candidate_id&&(d.version===2?job.sample_id===null:job.sample_id===d.sample_id)
      &&campaign.revision===d.campaign_revision&&campaign.topic_hash===d.topic_hash
      &&grant.id===d.audit_grant_id&&grant.account_id===d.account_id
      &&scout.grantCurrent(grant,campaign,'audit'),'SCOUT_MODEL_REQUEST_STALE');
    if(runtime) check(grant.account_id===this.service.telegramAccountId,'SCOUT_MODEL_REQUEST_STALE');
    const candidate=scout.candidate(d.candidate_id,campaign.id);
    check(candidate.account_id===d.account_id&&candidate.channel_id===d.channel_id,'SCOUT_MODEL_REQUEST_STALE');
    let basis;
    if(d.version===2)basis=scout.queries.modelBasis(d,job,{runtime});
    else{
      const sample=scout.sample(d.sample_id,candidate);scout.sampleFresh(sample);
      check(sample.digest===d.sample_digest&&sample.source_ref===d.sample_source_ref&&sample.source_cursor===d.sample_cursor
        &&sample.finished_at===d.sample_finished_at,'SCOUT_MODEL_REQUEST_STALE');
      const cursor=parse(job.cursor_json);
      check(cursor.sample_digest===d.sample_digest&&cursor.topic_hash===d.topic_hash
        &&cursor.evaluator_version===d.evaluator_version,'SCOUT_MODEL_REQUEST_STALE');
      basis={sample};
    }
    check(row.run_id===null&&job.attempts===0&&job.run_id===null
      ? !allowSpent&&job.status==='queued'
      : allowSpent&&isUuid(row.run_id)&&row.run_id===job.run_id&&job.attempts===1&&['running','completed','failed','interrupted'].includes(job.status),
    'SCOUT_MODEL_REQUEST_SPENT');
    const profile=this.service.modelProfiles.resolve(d.model_profile_id);
    check(profile.definition_hash===d.profile_hash,'SCOUT_MODEL_PROFILE_STALE');
    const resolved=Object.fromEntries(PROFILE_CONFIG_KEYS.map(k=>[k,profile.model_config[k]]));
    Object.assign(resolved,{timeoutSeconds:d.execution_bounds.timeout_seconds,maxApiCalls:d.execution_bounds.max_api_calls,
      maxIterations:d.execution_bounds.max_iterations});
    check(digest(resolved)===digest(d.model_config),'SCOUT_MODEL_PROFILE_STALE');
    return {request:row,definition:d,model_config:resolved,model_profile:{id:d.model_profile_id,definition_hash:d.profile_hash},fingerprint:row.request_fingerprint,job,campaign,grant,...basis};
  }

  forJob(job,{allowSpent=false,runtime=true}={}) {
    const row=this.rowForJob(job?.id);check(row,'SCOUT_MODEL_REQUEST_REQUIRED');
    const d=this.validateDefinition(row);
    return this.liveBindings(row,d,job,{allowSpent,runtime});
  }

  bindRun(jobId,runId) {
    check(isUuid(jobId)&&isUuid(runId),'SCOUT_MODEL_REQUEST_RUN_INVALID');
    const row=this.rowForJob(jobId);check(row,'SCOUT_MODEL_REQUEST_REQUIRED');
    const d=this.validateDefinition(row),job=this.db.get('SELECT * FROM scout_jobs WHERE id=?',jobId);
    const updatedForRun=job.run_id===runId&&job.attempts===1&&job.status==='running'&&job.owner_id===this.service.control.ownerId;
    const originalQueued=job.run_id===null&&job.attempts===0&&job.status==='queued';
    check(originalQueued||updatedForRun,'SCOUT_MODEL_REQUEST_SPENT');
    const validationJob=originalQueued?job:{...job,status:'queued',attempts:0,run_id:null};
    this.liveBindings(row,d,validationJob,{runtime:true,allowSpent:false});
    const changed=this.db.run('UPDATE scout_model_requests SET run_id=? WHERE id=? AND status=\'active\' AND run_id IS NULL',runId,row.id);
    check(changed.changes===1,'SCOUT_MODEL_REQUEST_SPENT');
    return {request_id:row.id,run_id:runId,fingerprint:row.request_fingerprint};
  }

  hasPending() {
    try {
      const rows=this.db.all(`SELECT j.* FROM scout_model_requests r JOIN scout_jobs j ON j.id=r.job_id
        WHERE r.partner_id=? AND r.status='active' AND r.expires_at>? AND j.kind='assessment'
        AND j.status='queued' AND j.attempts=0 AND j.run_id IS NULL AND r.run_id IS NULL ORDER BY j.created_at LIMIT 50`,this.partnerId,now());
      return rows.some(row=>{try{this.forJob(row,{runtime:false});return true;}catch{return false;}});
    } catch { return false; }
  }

  assertForRun(run) {
    check(run&&run.runtime==='hermes-scout-v1'&&run.partner_id===this.partnerId&&isUuid(run.id)
      &&run.status==='running','SCOUT_MODEL_REQUEST_RUN_INVALID');
    const persisted=this.db.get('SELECT * FROM runs WHERE id=? AND partner_id=?',run.id,this.partnerId);
    check(persisted?.status==='running'&&persisted.runtime===run.runtime&&persisted.model===run.model
      &&persisted.context_json===run.context_json,'SCOUT_MODEL_REQUEST_RUN_INVALID');
    const frozen=parse(run.context_json),binding=frozen.scout_assessment_request;
    check(exact(binding,'id,fingerprint')&&isUuid(binding.id)&&HASH.test(binding.fingerprint??''), 'SCOUT_MODEL_REQUEST_RUN_INVALID');
    const row=this.db.get('SELECT * FROM scout_model_requests WHERE id=? AND partner_id=?',binding.id,this.partnerId);
    check(row,'SCOUT_MODEL_REQUEST_REQUIRED');
    const d=this.validateDefinition(row),job=this.db.get('SELECT * FROM scout_jobs WHERE id=?',d.job_id);
    check(job?.status==='running'&&job?.run_id===run.id&&job.owner_id===this.service.control.ownerId&&row.run_id===run.id,
      'SCOUT_MODEL_REQUEST_RUN_OWNER');
    const live=this.liveBindings(row,d,job,{runtime:true,allowSpent:true});
    check(binding.fingerprint===row.request_fingerprint&&frozen.job_id===job.id&&frozen.campaign_id===d.campaign_id
      &&frozen.campaign_revision===d.campaign_revision&&(d.version===2||frozen.sample_id===d.sample_id&&frozen.sample_digest===d.sample_digest)
      &&frozen.evaluator_version===d.evaluator_version&&digest(frozen.campaign_config)===digest(JSON.parse(live.campaign.config_json))
      &&frozen.model_profile?.id===d.model_profile_id&&frozen.model_profile?.definition_hash===d.profile_hash
      &&digest(frozen.model_config)===digest(d.model_config)&&run.model===d.model_config.model,
    'SCOUT_MODEL_REQUEST_RUN_BINDING');
    if(d.version===2)this.service.scout.queries.assertRunBasis(frozen,d);
    return live;
  }

  assertCurrentForAssessment(assessment) {
    check(assessment&&assessment.run_id&&isUuid(assessment.run_id),'SCOUT_MODEL_REQUEST_ASSESSMENT_INVALID');
    const run=this.db.get('SELECT * FROM runs WHERE id=? AND partner_id=?',assessment.run_id,this.partnerId);
    check(run?.runtime==='hermes-scout-v1','SCOUT_MODEL_REQUEST_ASSESSMENT_INVALID');
    const frozen=parse(run.context_json),binding=frozen.scout_assessment_request;
    check(exact(binding,'id,fingerprint')&&HASH.test(binding.fingerprint??''),'SCOUT_MODEL_REQUEST_ASSESSMENT_INVALID');
    const row=this.db.get('SELECT * FROM scout_model_requests WHERE id=? AND partner_id=?',binding.id,this.partnerId);
    check(row&&row.request_fingerprint===binding.fingerprint,'SCOUT_MODEL_REQUEST_ASSESSMENT_INVALID');
    const d=this.validateDefinition(row),job=this.db.get('SELECT * FROM scout_jobs WHERE id=?',d.job_id);
    check(job?.run_id===run.id&&row.run_id===run.id&&assessment.campaign_id===d.campaign_id
      &&assessment.campaign_revision===d.campaign_revision&&assessment.candidate_id===d.candidate_id
      &&assessment.sample_id===d.sample_id&&assessment.sample_digest===d.sample_digest
      &&assessment.topic_hash===d.topic_hash&&assessment.evaluator_version===d.evaluator_version,
    'SCOUT_MODEL_REQUEST_ASSESSMENT_INVALID');
    const live=this.liveBindings(row,d,job,{runtime:false,allowSpent:true});
    check(frozen.job_id===job.id&&frozen.campaign_id===d.campaign_id&&frozen.campaign_revision===d.campaign_revision
      &&frozen.sample_id===d.sample_id&&frozen.sample_digest===d.sample_digest
      &&frozen.model_profile?.id===d.model_profile_id&&frozen.model_profile?.definition_hash===d.profile_hash
      &&digest(frozen.model_config)===digest(d.model_config)&&run.model===d.model_config.model,
    'SCOUT_MODEL_REQUEST_ASSESSMENT_INVALID');
    return live;
  }

  runtimeForRun(run) { return this.assertForRun(run).model_config; }

  isRunScoped(run) {
    return Boolean(run&&isUuid(run.id)&&this.db.get('SELECT id FROM scout_model_requests WHERE run_id=? AND partner_id=?',run.id,this.partnerId));
  }

  presentation(jobId) {
    let row,d,job;
    try{row=this.rowForJob(jobId);if(!row)return null;d=this.validateDefinition(row);job=this.db.get('SELECT status,attempts,run_id FROM scout_jobs WHERE id=?',jobId);}
    catch(error){return {status:'invalid',current:false,reason:error instanceof AppError?error.code:'SCOUT_MODEL_REQUEST_INVALID',contact_permission:false,allowed_effects:[]};}
    const spent=!!row.run_id||(job?.attempts??0)>0||!!job?.run_id;
    const durableRunId=row.run_id??job?.run_id??null;
    const state=row.status==='revoked'?'revoked':Date.parse(row.expires_at)<=Date.now()?'expired'
      :spent?'consumed':job?.status??'stale';
    let profileState='invalid',profileRevocationReason=null;
    try{const profile=this.service.modelProfiles.get(d.model_profile_id);profileState=profile.state;profileRevocationReason=profile.revocation_reason??null;}catch{}
    let current=false,reason=null;
    try{this.forJob(this.db.get('SELECT * FROM scout_jobs WHERE id=?',jobId),{runtime:false,allowSpent:(job?.attempts??0)>0});current=true;}
    catch(error){reason=error instanceof AppError?error.code:'SCOUT_MODEL_REQUEST_INVALID';}
    const profile={id:d.model_profile_id,definition_hash:d.profile_hash};
    return {id:row.id,fingerprint:row.request_fingerprint,status:row.status,request_id:row.id,request_fingerprint:row.request_fingerprint,purpose:d.purpose,
      profile,spent,current,reason,
      model_profile_id:d.model_profile_id,profile_hash:d.profile_hash,expires_at:d.expires_at,state,
      request_status:row.status,revoked_at:row.revoked_at,revocation_reason:row.revocation_reason,model_profile_state:profileState,
      model_profile_revocation_reason:profileRevocationReason,execution_bounds:d.execution_bounds,
      attempts:spent?Math.max(1,job?.attempts??0):job?.attempts??null,run_id:durableRunId,contact_permission:false,allowed_effects:[]};
  }

  scopedAvailability() {
    const deployment=this.service.deployment?.summary?.();
    const activationAvailable=this.service.scout.enabled&&this.service.control.processCurrent()&&!this.service.control.stopped
      &&(!this.service.deployment||(deployment?.phase==='active'&&deployment?.mode==='scoped_reasoning'));
    const profiles=this.service.modelProfiles.list().profiles.map(p=>({...p,available:p.state==='available'&&p.block_reasons.length===0}));
    return {model_scoped_available:activationAvailable&&profiles.some(p=>p.available),activation_available:activationAvailable,
      deployment_mode:deployment?.mode??null,model_profiles:profiles,profiles};
  }

  revoke(payload) {
    check(payload&&typeof payload==='object'&&!Array.isArray(payload)
      &&Object.keys(payload).sort().join(',')==='expected_fingerprint,reason,request_id','SCOUT_FIELDS_INVALID',400);
    check(isUuid(payload.request_id)&&HASH.test(payload.expected_fingerprint??''),'SCOUT_MODEL_REQUEST_INVALID',400);
    const reason=requiredText(payload.reason,'reason',500),row=this.db.get('SELECT * FROM scout_model_requests WHERE id=? AND partner_id=?',payload.request_id,this.partnerId);
    check(row,'SCOUT_MODEL_REQUEST_NOT_FOUND',404);this.validateDefinition(row);
    check(row.request_fingerprint===payload.expected_fingerprint,'SCOUT_MODEL_REQUEST_STALE');
    if(row.status!=='revoked') this.db.run("UPDATE scout_model_requests SET status='revoked',revoked_at=?,revocation_reason=? WHERE id=? AND status='active'",now(),reason,row.id);
    const job=this.db.get('SELECT * FROM scout_jobs WHERE id=?',row.job_id);
    if(job&&['queued','running','interrupted'].includes(job.status))
      this.db.run("UPDATE scout_jobs SET status='stale',reason='SCOUT_MODEL_REQUEST_REVOKED',updated_at=? WHERE id=? AND status IN ('queued','running','interrupted')",now(),job.id);
    this.db.event(this.partnerId,null,'scout.assessment_request_revoked','operator',{request_id:row.id,request_fingerprint:row.request_fingerprint,reason});
    return {request_id:row.id,request_fingerprint:row.request_fingerprint,status:'revoked',contact_permission:false,allowed_effects:[]};
  }
}
