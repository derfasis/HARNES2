// Explicit one-shot authority over a frozen fresh-event interpretation. No effect permission.
import { AppError, now } from './errors.mjs';
import path from 'node:path';
import Ajv from 'ajv';
import { id } from './store.mjs';
import { digest, sourceEvent, sourceRows } from './source-ingestion.mjs';
import { ROOT, readJson, runtimeReadiness } from './config.mjs';
import { proposalRefs } from './audience-proposals.mjs';
import { currentExchange, currentBasis } from './audience-current-events.mjs';

const AUTHORITY = Object.freeze({executable:false,contact_permission:false,allowed_effects:[]});
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9-]{36}$/;
const validator = new Ajv({strict:true});
const validateRequest=validator.compile(readJson(path.join(ROOT,'contracts/audience-followup-request.schema.json')));
const validateRevoke=validator.compile(readJson(path.join(ROOT,'contracts/audience-followup-revoke.schema.json')));
const check = (value,code,status=409) => { if (!value) throw new AppError(code,status,code); };
const exact = (p,keys) => p && typeof p === 'object' && !Array.isArray(p)
  && Object.keys(p).sort().join(',') === keys.split(',').sort().join(',');
const definitionKeys = 'version,id,partner_id,goal_id,assessment_id,need_id,need_revision,need_basis_fingerprint,context_fingerprint,model_profile_id,profile_hash,execution_bounds,expires_at,reason,created_at';
export const FOLLOWUP_TEMPORARY = new Set(['AUDIENCE_DISABLED','AUDIENCE_SCOPE_BACKLOG','SOURCE_TRANSPORT_NOT_CURRENT','SOURCE_TRANSPORT_STALE',
  'SOURCE_TRANSPORT_NOT_READY','SOURCE_TRANSPORT_DIRTY','CONTINUITY_SOURCE_UNAVAILABLE']);

export class AudienceFollowup {
  constructor(service) { this.service=service; this.db=service.store; }
  get a() { return this.service.audience; }
  get partnerId() { return this.service.config.partnerId; }
  bounds() {
    const timeout=this.service.config.runtime.timeoutSeconds;
    check(Number.isInteger(timeout)&&timeout>=10&&timeout<=1800,'AUDIENCE_FOLLOWUP_BOUNDS_INVALID');
    return {timeout_seconds:timeout,max_api_calls:2};
  }
  runtimeProjection(profile,bounds) {
    const runtime=Object.fromEntries(['provider','apiMode','baseUrl','model','maxOutputTokens','inputUsdPerMillion','outputUsdPerMillion']
      .map(k=>[k,profile.model_config[k]]));
    return {...runtime,timeoutSeconds:bounds.timeout_seconds,maxIterations:2,maxApiCalls:bounds.max_api_calls};
  }
  contextFingerprint(c) {
    return digest({version:1,purpose:'need_followup_v1',need_id:c.need_id,need_revision:c.need_revision,
      need_basis_fingerprint:c.need_basis_fingerprint,scope:c.scope,historical_memory:c.historical_memory,
      observation_heads:c.observation_heads,execution_bounds:c.execution_bounds});
  }
  history(need,goal) {
    const record = this.db.get('SELECT * FROM audience_needs WHERE id=?',need.id), basis=JSON.parse(record.basis_json);
    const prior = this.a.assessmentRecord(record.assessment_id), packet=JSON.parse(prior.packet_json);
    check(packet.id === goal.id && basis.goal_id === goal.id,'AUDIENCE_RECORD_INVALID');
    const reasons=[], metadata=[];
    for (const [ref,policy] of basis.policies) {
      const watch=this.a.watches(goal.id).find(w=>w.source_ref===ref);
      if (!watch || watch.policy_hash!==policy || !this.a.watchAuthority(watch).current) reasons.push('AUDIENCE_SOURCE_REVOKED');
      else { const health=this.a.health(watch); if(!health.current) reasons.push(health.reason); }
    }
    // Temporal expiry may become memory. Withdrawal, opacity or broken lineage may not.
    for (const ref of proposalRefs(need)) {
      try {
        const event=sourceEvent(this.service,ref), latest=sourceRows(this.service,event.message.source_id,[event.message.message_id])[0];
        if (!latest || latest.message.operation!=='upsert' || typeof latest.message.text!=='string' || !latest.message.text.trim())
          reasons.push('AUDIENCE_FOLLOWUP_HISTORY_WITHDRAWN');
        const state=this.service.continuity.evidenceStates({max_age_seconds:goal.max_age_seconds},
          this.a.watches(goal.id).map(w=>({...w,policy_hash:this.service.continuity.policyHash(w.source_ref)})),[ref]).get(ref);
        metadata.push({source_event_id:ref,source_ref:event.message.source_id,message_id:event.message.message_id,
          message_version:event.message.version,current:false,reasons:[...new Set(['historical_not_current_support',...(state?.reasons??[])])]});
      } catch(error) { if(!(error instanceof AppError)) throw error; reasons.push('AUDIENCE_FOLLOWUP_HISTORY_WITHDRAWN'); }
    }
    for (const e of basis.exchanges) {
      const row=this.db.get('SELECT * FROM audience_exchanges WHERE id=? AND goal_id=?',e.id,goal.id);
      if(!row) { reasons.push('AUDIENCE_FOLLOWUP_HISTORY_WITHDRAWN'); continue; }
      try {
        const projection=this.a.projection(row);
        reasons.push(...projection.reasons);
        const anchor=sourceRows(this.service,row.source_ref,[row.anchor_id])[0];
        if(!anchor || anchor.message.operation!=='upsert') reasons.push('AUDIENCE_FOLLOWUP_HISTORY_WITHDRAWN');
      } catch(error) { if(!(error instanceof AppError)) throw error; reasons.push(error.code); }
    }
    const heads=packet.observation_heads ?? packet.reassessment?.observation_heads ?? packet.followup?.observation_heads ?? null;
    check(heads===null && packet.proposal_contract_version!==2 || Array.isArray(heads)&&heads.length>0&&heads.length<=20
      && heads.every(h=>Array.isArray(h)&&h.length===2&&typeof h[0]==='string'&&Number.isSafeInteger(h[1])&&h[1]>=0)
      && new Set(heads.map(h=>h[0])).size===heads.length,'AUDIENCE_RECORD_INVALID');
    return {reasons:[...new Set(reasons)],metadata,heads,packet};
  }
  context(needId,{includeRequests=true,executionBounds=null}={}) {
    const need=this.a.need(needId,{includeWorkCase:false}), goal=this.a.goal(need.goal_id), historic=this.history(need,goal);
    const reasons=[...historic.reasons];
    if(!this.a.enabled()) reasons.push('AUDIENCE_DISABLED');
    if(goal.status!=='OPEN') reasons.push('AUDIENCE_GOAL_CHANGED');
    if(need.status==='rejected') reasons.push('AUDIENCE_REJECTED_NEED');
    const pools=[];
    for(const watch of this.a.watches(goal.id)) {
      const access=this.a.health(watch);
      if(!access.current) { reasons.push(access.reason); continue; }
      if(this.service.continuity.head(watch.source_ref)>watch.cursor) { reasons.push('AUDIENCE_SCOPE_BACKLOG'); continue; }
      const floor=historic.heads?.find(([ref])=>ref===watch.source_ref)?.[1];
      const known=new Set((historic.packet.exchanges??[]).flatMap(e=>(e.evidence??[]).map(s=>s.source_event_id)));
      const pool=[];
      const rows=this.db.all('SELECT * FROM audience_exchanges WHERE goal_id=? AND source_ref=? AND last_event_id>? ORDER BY last_event_id DESC LIMIT 100',
        goal.id,watch.source_ref,Number.isSafeInteger(floor)?floor:0);
      for(const row of rows) {
        try {
          const projection=this.a.projection(row);
          const candidates=projection.evidence.filter(id=>Number.isSafeInteger(floor)?Number(id)>floor:!known.has(id));
          const states=this.service.continuity.evidenceStates({max_age_seconds:goal.max_age_seconds},
            [{...watch,policy_hash:this.service.continuity.policyHash(watch.source_ref)}],candidates);
          const fresh=candidates.filter(id=>states.get(id)?.current);
          if(!fresh.length) continue;
          const projected=currentExchange(this.a,goal,row,fresh);
          if(projected.current) pool.push(projected);
        } catch(error) { if(!(error instanceof AppError)) throw error; }
      }
      pools.push(pool);
    }
    const exchanges=[];
    for(let i=0;i<8 && exchanges.length<8;i++) for(const pool of pools) {
      if(exchanges.length>=8) break;
      if(pool[i]) exchanges.push(pool[i]);
    }
    if(!exchanges.length) reasons.push('AUDIENCE_NO_NEW_CURRENT_EVIDENCE');
    // History withdrawal is a dependency boundary, even when another source is fresh.
    const admitted=historic.reasons.length?[]:exchanges;
    const context={version:1,purpose:'need_followup_v1',need_id:need.id,goal_id:goal.id,need_revision:need.revision,
      need_basis_fingerprint:need.basis_fingerprint,historical_memory:{...this.a.hypothesisMemory(need),basis_current:false},
      historical_evidence:historic.metadata,observation_heads:this.a.observationHeads(goal.id),
      baseline:historic.heads?'recorded_observation_heads':'legacy_baseline_unknown',execution_bounds:executionBounds??this.bounds(),
      exchanges:admitted,scope:currentBasis(this.a,goal,admitted),reasons:[...new Set(reasons)],...AUTHORITY};
    context.available=context.reasons.length===0;
    context.context_fingerprint=this.contextFingerprint(context);
    context.profile_options=this.service.modelProfiles.list().profiles.map(profile=>{
      const blocks=[...profile.block_reasons]; let ready=false;
      try { const p=this.service.modelProfiles.resolve(profile.id); ready=runtimeReadiness({...this.service.config,runtime:p.model_config},{decision:true}).ready; }
      catch(error) { if(!(error instanceof AppError)) throw error; blocks.push(error.code); }
      if(!ready) blocks.push('AUDIENCE_MODEL_NOT_READY');
      if(this.service.config.controlPlane?.enabled!==true) blocks.push('AUDIENCE_CONTROL_REQUIRED');
      return {...profile,profile_id:profile.id,profile_hash:profile.definition_hash,available:blocks.length===0,
        model_ready:ready,block_reasons:[...new Set(blocks)]};
    });
    if(includeRequests) {
      context.requests=this.db.all('SELECT id FROM audience_followup_requests WHERE partner_id=? AND goal_id=? ORDER BY rowid DESC LIMIT 20',this.partnerId,goal.id)
        .map(({id:requestId})=>{try{return this.detail(requestId);}catch(error){if(!(error instanceof AppError))throw error;return {request_id:requestId,state:'invalid',reasons:[error.code],...AUTHORITY};}})
        .filter(r=>!r.need_id || r.need_id===needId);
      context.pending_request=context.requests.find(r=>['captured','running'].includes(r.assessment_status) && r.status==='active')??null;
    }
    return context;
  }
  checked(requestId) {
    const row=this.db.get('SELECT * FROM audience_followup_requests WHERE id=? AND partner_id=?',requestId,this.partnerId);
    check(row,'AUDIENCE_FOLLOWUP_NOT_FOUND',404);
    let d; try{d=JSON.parse(row.definition_json);}catch{check(false,'AUDIENCE_RECORD_INVALID');}
    check(exact(d,definitionKeys)&&d.version===1&&d.id===row.id&&d.partner_id===row.partner_id&&d.goal_id===row.goal_id
      && d.assessment_id===row.assessment_id&&d.model_profile_id===row.model_profile_id&&d.expires_at===row.expires_at
      && UUID.test(d.need_id)&&Number.isInteger(d.need_revision)&&d.need_revision>=1
      && [d.need_basis_fingerprint,d.context_fingerprint,d.profile_hash,row.request_fingerprint].every(v=>typeof v==='string'&&HASH.test(v))
      && exact(d.execution_bounds,'timeout_seconds,max_api_calls')&&d.execution_bounds.max_api_calls===2
      && Number.isInteger(d.execution_bounds.timeout_seconds)&&d.execution_bounds.timeout_seconds>=10&&d.execution_bounds.timeout_seconds<=1800
      && typeof d.reason==='string'&&d.reason.trim().length>0&&d.reason.length<=500
      && Number.isFinite(Date.parse(d.created_at))&&Number.isFinite(Date.parse(d.expires_at))
      && Date.parse(d.expires_at)>Date.parse(d.created_at)&&Date.parse(d.expires_at)<=Date.parse(d.created_at)+7*86400000
      && ['active','revoked'].includes(row.status)
      && (row.status==='active'?row.revoked_at===null&&row.revocation_reason===null
        :typeof row.revoked_at==='string'&&Number.isFinite(Date.parse(row.revoked_at))
          &&typeof row.revocation_reason==='string'&&row.revocation_reason.trim().length>0)
      && digest(d)===row.request_fingerprint,'AUDIENCE_RECORD_INVALID');
    const profile=this.service.modelProfiles.resolve(d.model_profile_id,{historical:true});
    check(profile.definition_hash===d.profile_hash,'AUDIENCE_RECORD_INVALID');
    return {row,d,profile};
  }
  detail(requestId) {
    const {row,d}=this.checked(requestId), assessment=this.a.assessmentRecord(d.assessment_id);
    const attempt=this.db.get('SELECT * FROM audience_followup_attempts WHERE request_id=?',requestId);
    const run=attempt?this.db.get('SELECT status,error,result_json FROM runs WHERE id=?',attempt.run_id):null;
    let receipt=null;try{receipt=run?.result_json?JSON.parse(run.result_json):null;}catch{receipt={state:'invalid'};}
    const state=row.status==='revoked'?'revoked':Date.parse(row.expires_at)<=Date.now()?'expired'
      :attempt?(assessment.status==='running'?'running':'consumed'):assessment.status;
    return {...d,request_id:row.id,request_fingerprint:row.request_fingerprint,status:row.status,state,
      assessment_status:assessment.status,attempt:attempt?{run_id:attempt.run_id,created_at:attempt.created_at}:null,
      run_status:run?.status??null,receipt,revoked_at:row.revoked_at,revocation_reason:row.revocation_reason,...AUTHORITY};
  }
  assertRequest(p) {
    check(validateRequest(p)&&p.reason.trim().length>0,'AUDIENCE_FIELDS_INVALID',400);
    check(typeof p.expires_at==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(p.expires_at)
      && Date.parse(p.expires_at)>Date.now()&&Date.parse(p.expires_at)<=Date.now()+7*86400000,'AUDIENCE_FOLLOWUP_EXPIRY_INVALID',400);
    const c=this.context(p.need_id,{includeRequests:false});
    check(c.available&&c.need_revision===p.expected_revision&&c.need_basis_fingerprint===p.expected_basis_fingerprint
      && c.context_fingerprint===p.expected_context_fingerprint,'AUDIENCE_STALE_BASIS');
    const option=c.profile_options.find(v=>v.profile_id===p.model_profile_id);
    check(option?.available&&option.profile_hash===p.expected_profile_hash,'AUDIENCE_FOLLOWUP_PROFILE_UNAVAILABLE');
    return c;
  }
  request(p) {
    const c=this.assertRequest(p),goal=this.a.goal(c.goal_id);
    check(!this.db.get("SELECT id FROM audience_assessments WHERE goal_id=? AND status IN ('captured','running')",goal.id),'AUDIENCE_ASSESSMENT_PENDING');
    this.service.control.assertModelBudget({runtime:'hermes-audience-v1',maxRunsPerDay:this.service.config.audience.maxRunsPerDay});
    const requestId=id(),assessmentId=id(),created=now();
    const d={version:1,id:requestId,partner_id:this.partnerId,goal_id:goal.id,assessment_id:assessmentId,
      need_id:c.need_id,need_revision:c.need_revision,need_basis_fingerprint:c.need_basis_fingerprint,context_fingerprint:c.context_fingerprint,
      model_profile_id:p.model_profile_id,profile_hash:p.expected_profile_hash,execution_bounds:c.execution_bounds,
      expires_at:p.expires_at,reason:p.reason.trim(),created_at:created};
    const fp=digest(d),packet={id:goal.id,revision:goal.revision,title:goal.title,objective:goal.objective,
      assessment_id:assessmentId,proposal_contract_version:2,scope:c.scope,exchanges:c.exchanges,needs:[c.historical_memory],
      observation_heads:c.observation_heads,execution_bounds:c.execution_bounds,coverage:{baseline:c.baseline,scope:'bounded_new_events_only'},
      followup:{version:1,request_id:requestId,request_fingerprint:fp,need_id:c.need_id,need_revision:c.need_revision,
        need_basis_fingerprint:c.need_basis_fingerprint,context_fingerprint:c.context_fingerprint,observation_heads:c.observation_heads},...AUTHORITY};
    packet.basis_fingerprint=digest({scope:packet.scope,followup:packet.followup});
    check(Buffer.byteLength(JSON.stringify(packet))<=600000,'AUDIENCE_PACKET_TOO_LARGE');
    this.db.run("INSERT INTO audience_assessments VALUES(?,?,?,?,'captured','operator',NULL,NULL,?)",assessmentId,goal.id,packet.basis_fingerprint,JSON.stringify(packet),created);
    this.db.run("INSERT INTO audience_followup_requests VALUES(?,?,?,?,?,?,?,?,'active',NULL,NULL)",requestId,this.partnerId,goal.id,assessmentId,JSON.stringify(d),fp,p.model_profile_id,p.expires_at);
    this.a.record('followup_requested',{request_id:requestId,assessment_id:assessmentId,need_id:c.need_id,context_fingerprint:c.context_fingerprint,
      model_profile_id:p.model_profile_id,max_model_turns:1},'operator');
    return {request_id:requestId,request_fingerprint:fp,assessment_id:assessmentId,...AUTHORITY};
  }
  revoke(p) {
    check(validateRevoke(p)&&p.reason.trim().length>0,'AUDIENCE_FIELDS_INVALID',400);
    const {row,d}=this.checked(p.request_id);
    check(row.request_fingerprint===p.expected_request_fingerprint,'AUDIENCE_STALE_BASIS');
    if(row.status!=='revoked') this.db.run("UPDATE audience_followup_requests SET status='revoked',revoked_at=?,revocation_reason=? WHERE id=?",now(),p.reason.trim(),row.id);
    const assessment=this.a.assessmentRecord(d.assessment_id);
    this.db.run("UPDATE audience_assessments SET status='interrupted' WHERE id=? AND status IN ('captured','running')",assessment.id);
    this.a.record('followup_revoked',{request_id:row.id,assessment_id:assessment.id,reason:p.reason.trim()},'operator');
    return {request_id:row.id,assessment_id:assessment.id,run_id:assessment.run_id,...AUTHORITY};
  }
  assertPacket(row,{live=true}={}) {
    const packet=row.packet??JSON.parse(row.packet_json),focus=packet.followup;
    check(exact(focus,'version,request_id,request_fingerprint,need_id,need_revision,need_basis_fingerprint,context_fingerprint,observation_heads')
      && focus.version===1,'AUDIENCE_RECORD_INVALID');
    const {row:request,d}=this.checked(focus.request_id);
    check(row.id===d.assessment_id&&row.goal_id===d.goal_id&&packet.id===row.goal_id&&packet.assessment_id===row.id
      && packet.proposal_contract_version===2&&!packet.reassessment&&!packet.reasoning_retry
      && packet.basis_fingerprint===row.basis_fingerprint&&digest({scope:packet.scope,followup:focus})===row.basis_fingerprint
      && focus.request_fingerprint===request.request_fingerprint&&focus.need_id===d.need_id&&focus.need_revision===d.need_revision
      && focus.need_basis_fingerprint===d.need_basis_fingerprint&&focus.context_fingerprint===d.context_fingerprint
      && Array.isArray(packet.needs)&&packet.needs.length===1
      && this.contextFingerprint({need_id:focus.need_id,need_revision:focus.need_revision,need_basis_fingerprint:focus.need_basis_fingerprint,
        scope:packet.scope,historical_memory:packet.needs[0],observation_heads:focus.observation_heads,execution_bounds:d.execution_bounds})===focus.context_fingerprint
      && digest(packet.execution_bounds)===digest(d.execution_bounds)
      && digest(packet.observation_heads)===digest(focus.observation_heads),'AUDIENCE_RECORD_INVALID');
    check(Array.isArray(packet.exchanges)&&packet.exchanges.length===packet.scope.exchanges.length
      && new Set(packet.exchanges.map(e=>e?.id)).size===packet.exchanges.length,'AUDIENCE_RECORD_INVALID');
    for(const e of packet.exchanges) {
      const scope=packet.scope.exchanges.find(s=>s.id===e.id);
      check(scope&&e.source_ref===scope.source_ref&&e.fingerprint===scope.fingerprint
        && e.evidence_scope==='current_events_with_structural_ancestry_v1'
        && digest(e.current_event_ids)===digest(scope.current_event_ids)&&digest(e.structural_event_ids)===digest(scope.structural_event_ids)
        && Array.isArray(e.evidence)&&e.evidence.length===scope.current_event_ids.length
        && digest(e.evidence.map(item=>item.source_event_id).sort())===digest([...scope.current_event_ids].sort()),'AUDIENCE_RECORD_INVALID');
      const current=scope.current_event_ids.map(ref=>sourceEvent(this.service,ref));
      const structural=scope.structural_event_ids.map(ref=>sourceEvent(this.service,ref));
      check([...current,...structural].every(event=>event.message.source_id===e.source_ref&&event.message.operation==='upsert'
          &&typeof event.message.text==='string'&&event.message.text.trim().length>0)
        && digest({version:2,id:e.id,source_ref:e.source_ref,anchor_id:e.anchor_id,
          current:current.map(event=>[event.event_id,event.message]),structural:structural.map(event=>[event.event_id,event.message])})===e.fingerprint,
      'AUDIENCE_RECORD_INVALID');
      for(const item of e.evidence) {
        const event=current.find(v=>v.event_id===item.source_event_id),m=event.message;
        check(item.source_ref===m.source_id&&item.message_id===m.message_id&&item.message_version===m.version
          && item.author_id===m.author_id&&item.observed_at===event.observed_at
          && item.text===m.text.slice(0,2000)&&item.truncated===(m.text.length>2000),'AUDIENCE_RECORD_INVALID');
      }
    }
    if(live) {
      check(request.status==='active'&&Date.parse(request.expires_at)>Date.now(),'AUDIENCE_FOLLOWUP_REVOKED_OR_EXPIRED');
      this.service.modelProfiles.resolve(d.model_profile_id);
      const basisState=this.a.basisState(packet.scope);
      if(!basisState.current&&basisState.reasons.length&&basisState.reasons.every(r=>FOLLOWUP_TEMPORARY.has(r)))
        check(false,basisState.reasons[0]);
      check(basisState.current,'AUDIENCE_STALE_BASIS');
      const c=this.context(d.need_id,{includeRequests:false,executionBounds:d.execution_bounds});
      // Historical dependencies may be on a different source than the fresh packet.
      // Temporary transport unavailability waits; withdrawal or changed proof is terminal.
      if(!c.available&&c.reasons.length&&c.reasons.every(r=>FOLLOWUP_TEMPORARY.has(r)))
        check(false,c.reasons[0]);
      check(c.available&&c.need_revision===d.need_revision&&c.need_basis_fingerprint===d.need_basis_fingerprint
        && c.context_fingerprint===d.context_fingerprint,'AUDIENCE_STALE_BASIS');
      check(digest(c.exchanges)===digest(packet.exchanges),'AUDIENCE_RECORD_INVALID');
    }
    return {request,d,packet};
  }
  configurationFor(row) {
    const {d}=this.assertPacket(row);
    check(!this.db.get('SELECT run_id FROM audience_followup_attempts WHERE request_id=?',d.id),'AUDIENCE_FOLLOWUP_CONSUMED');
    return {...this.service.config,runtime:this.runtimeProjection(this.service.modelProfiles.resolve(d.model_profile_id),d.execution_bounds)};
  }
  bind(row,runId) {
    const {request,d}=this.assertPacket(row);
    check(!this.db.get('SELECT run_id FROM audience_followup_attempts WHERE request_id=?',d.id),'AUDIENCE_FOLLOWUP_CONSUMED');
    this.db.run('INSERT INTO audience_followup_attempts VALUES(?,?,?,?,?)',runId,d.id,row.id,request.request_fingerprint,now());
  }
  assertHistory(runId,row,frozenRequest) {
    const {request,d,packet}=this.assertPacket(row,{live:false});
    const attempt=this.db.get('SELECT * FROM audience_followup_attempts WHERE run_id=?',runId);
    check(attempt&&attempt.request_id===d.id&&attempt.assessment_id===row.id&&attempt.request_fingerprint===request.request_fingerprint
      && frozenRequest?.id===d.id&&frozenRequest.request_fingerprint===request.request_fingerprint,'AUDIENCE_RECORD_INVALID');
    const run=this.db.get('SELECT * FROM runs WHERE id=? AND partner_id=?',runId,this.partnerId);
    let f;try{f=JSON.parse(run?.context_json);}catch{check(false,'AUDIENCE_RECORD_INVALID');}
    const profile=this.service.modelProfiles.resolve(d.model_profile_id,{historical:true});
    check(run?.runtime==='hermes-audience-v1'&&row.run_id===run.id&&f.assessment_id===row.id&&f.goal_id===row.goal_id
      && digest(f.packet)===digest(packet)&&!f.attention_grant
      && f.model_profile?.id===d.model_profile_id&&f.model_profile?.definition_hash===d.profile_hash
      && run.model===profile.model_config.model
      && ['provider','apiMode','baseUrl','model','maxOutputTokens','inputUsdPerMillion','outputUsdPerMillion'].every(k=>f.model_config?.[k]===profile.model_config[k]),'AUDIENCE_RECORD_INVALID');
    check(digest(f.model_config)===digest(this.runtimeProjection(profile,d.execution_bounds)),'AUDIENCE_RECORD_INVALID');
    if(run.status==='completed') {
      let receipt;try{receipt=JSON.parse(run.result_json);}catch{check(false,'AUDIENCE_RECORD_INVALID');}
      check(receipt.followup_request?.id===d.id&&receipt.followup_request.request_fingerprint===request.request_fingerprint
        && digest(receipt.model_profile)===digest(f.model_profile),'AUDIENCE_RECORD_INVALID');
    }
    return {request,d,f,profile};
  }
  runtimeForRun(run) {
    const persisted=this.db.get('SELECT * FROM runs WHERE id=? AND partner_id=?',run.id,this.partnerId);
    check(persisted?.status==='running'&&persisted.context_json===run.context_json,'AUDIENCE_RECORD_INVALID');
    const f=JSON.parse(run.context_json),row=this.a.assessmentRecord(f.assessment_id);
    check(row.status==='running','AUDIENCE_RECORD_INVALID');
    this.assertPacket(row);
    const {f:frozen}=this.assertHistory(run.id,row,f.followup_request);
    check(Number.isInteger(frozen.model_config.timeoutSeconds)&&frozen.model_config.timeoutSeconds>=10&&frozen.model_config.timeoutSeconds<=1800,'AUDIENCE_RECORD_INVALID');
    return frozen.model_config;
  }
  hasPending() {
    return !!this.db.get(`SELECT r.id FROM audience_followup_requests r JOIN audience_assessments a ON a.id=r.assessment_id
      JOIN model_profiles p ON p.id=r.model_profile_id WHERE r.partner_id=? AND r.status='active' AND r.expires_at>?
      AND p.status='available' AND a.status='captured' AND NOT EXISTS(SELECT 1 FROM audience_followup_attempts t WHERE t.request_id=r.id) LIMIT 1`,this.partnerId,now());
  }
  reconcile(goalId) {
    for(const row of this.db.all("SELECT * FROM audience_assessments WHERE goal_id=? AND status='captured' ORDER BY rowid LIMIT 100",goalId)) {
      try {
        const packet=JSON.parse(row.packet_json);
        if(!packet.followup) continue;
        this.assertPacket(row);
        check(!this.db.get('SELECT run_id FROM audience_followup_attempts WHERE assessment_id=?',row.id),'AUDIENCE_FOLLOWUP_CONSUMED');
      } catch(error) {
        if(!(error instanceof AppError)&&!(error instanceof SyntaxError)) throw error;
        if(FOLLOWUP_TEMPORARY.has(error.code)) continue;
        this.db.run("UPDATE audience_assessments SET status='stale' WHERE id=? AND status='captured'",row.id);
        this.a.record('followup_withheld',{assessment_id:row.id,reason:error.code??'AUDIENCE_RECORD_INVALID'});
      }
    }
  }
}
