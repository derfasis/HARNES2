import { id } from './store.mjs';
import { now, ensure, requiredText } from './errors.mjs';
import { digest, sourceRows, sourceCheckpoint, sourceTransportBoundary } from './source-ingestion.mjs';
import { discoverySchema, discoveryInstructions, discoveryEvidence } from './discovery-projection.mjs';
import { discoveryLinks, forgetDiscoveryLinks } from './discovery-links.mjs';

export const DISCOVERY_ACTIONS=['discovery.review','discovery.forget'];
const check=(ok,code)=>ensure(ok,`Discovery: ${code}`,409,code);
const json=JSON.parse;
export function discoveryPolicy(service) {
  const d=service.config.discovery;
  check(d && typeof d.enabled==='boolean','DISCOVERY_CONFIG');
  check(d.purpose && ['id','version','text'].every(k=>typeof d.purpose[k]==='string' && d.purpose[k].trim()
    && d.purpose[k].length<=2000),'DISCOVERY_PURPOSE');
  for(const [key,min,max] of [['windowDays',1,90],['ttlDays',1,90],['maxMessages',1,100],['maxCharacters',100,60000],['batchSeconds',0,3600]])
    check(Number.isInteger(d[key]) && d[key]>=min && d[key]<=max,'DISCOVERY_BOUNDS');
  const offer=service.config.opportunity.activeOffer;
  check(offer && typeof offer.version==='string' && offer.version.trim(),'DISCOVERY_OFFER_REQUIRED');
  return {reasoning_version:'discovery-v1',purpose:d.purpose,offer,windowDays:d.windowDays,ttlDays:d.ttlDays,maxMessages:d.maxMessages,maxCharacters:d.maxCharacters};
}
const scopeHash=(service,source,subject,purpose)=>digest([service.config.partnerId,source,subject,purpose]);
export function suppressDiscovery(service,s,reason) {
  service.store.run('INSERT OR IGNORE INTO discovery_suppressions VALUES(?,?,?,?)',scopeHash(service,s.source_id,s.subject_id,s.purpose_id),service.config.partnerId,reason,now());
}
export function discoveryTransport(service,source) {
  try {sourceTransportBoundary(service,source);return {availability:'current',reasons:[]};}
  catch(error) {
    const checkpoint=sourceCheckpoint(service,source);
    const integrity=checkpoint?.phase==='blocked' || error.code==='SOURCE_TRANSPORT_CORRUPT_CHECKPOINT'
      || error.code==='SOURCE_TRANSPORT_POLICY_UNAVAILABLE';
    return {availability:integrity?'integrity_blocked':'waiting_source',reasons:[error.code??'SOURCE_TRANSPORT_UNAVAILABLE']};
  }
}
// Selection is mechanical, scoped and bounded. The LLM interprets the situation.
export function discoveryObservations(service,source,subject,policy) {
  const rows=sourceRows(service,source), byId=new Map(rows.map(r=>[r.message.message_id,r]));
  const floor=Date.now()-policy.windowDays*86400000;
  const own=rows.filter(r=>r.message.author_id===subject && Date.parse(r.message.created_at)>=floor);
  const anchor=own.find(r=>r.message.operation==='upsert'), selected=new Map(), reasons=[];
  const ownMessages=new Set(own.map(r=>r.message.message_id)),threads=new Set(own.map(r=>r.message.thread_id).filter(Boolean));
  const related=rows.filter(r=>Date.parse(r.message.created_at)>=floor && (r.message.author_id===subject
    || ownMessages.has(r.message.reply_to_id) || threads.has(r.message.thread_id)));
  let chars=0,omitted=0;
  function branch(row) {
    const chain=[],seen=new Set();
    for(let current=row;current;) {
      const m=current.message;
      if(seen.has(m.message_id))return {chain,reason:'REPLY_CYCLE'};
      seen.add(m.message_id);
      if(m.operation!=='upsert')return {chain,reason:'REQUIRED_'+m.operation.toUpperCase()};
      if(!m.author_id)return {chain,reason:'UNKNOWN_ANCESTOR_AUTHOR'};
      if(Date.parse(m.created_at)<floor)return {chain,reason:'ANCESTOR_OUTSIDE_WINDOW'};
      chain.push(current);
      if(!m.reply_to_id)return {chain};
      current=byId.get(m.reply_to_id);
      if(!current)return {chain,reason:'MISSING_ANCESTOR'};
    }
    return {chain};
  }
  for(const row of [anchor,...related.filter(r=>r!==anchor)].filter(Boolean)) {
    if(row.message.operation!=='upsert')continue;
    const b=branch(row);
    if(b.reason) {if(row===anchor)reasons.push(b.reason);else omitted++;continue;}
    const added=b.chain.filter(r=>!selected.has(r.event_id));
    const size=added.reduce((n,r)=>n+r.message.text.length,0);
    if(selected.size+added.length>policy.maxMessages || chars+size>policy.maxCharacters) {
      if(row===anchor)reasons.push('WINDOW_CAPACITY');else omitted++;continue;
    }
    chars+=size;for(const r of added)selected.set(r.event_id,r);
  }
  const observations=[...selected.values()].sort((a,b)=>Number(a.event_id)-Number(b.event_id)).map(r=>({
    ...r.message,source_event_id:r.event_id,observed_at:r.observed_at}));
  const coverage={incomplete:reasons.length>0,reasons:[...new Set(reasons)],omitted_optional_count:omitted,
    history_complete:false,window_days:policy.windowDays};
  // Include opaque/deleted versions in the fingerprint; never present them as quoted text.
  const version_ids=[...new Set([...own.map(r=>r.event_id),...selected.keys()])].sort((a,b)=>Number(a)-Number(b));
  return {observations,version_ids,coverage,hash:digest({version_ids,coverage})};
}
function getSituation(service,situationId) {
  const s=service.store.get('SELECT * FROM discovery_situations WHERE id=? AND partner_id=?',situationId,service.config.partnerId);
  check(s,'DISCOVERY_NOT_FOUND');return s;
}
function bindingReasons(service,s) {
  const matches=(service.config.opportunity.authorBindings??[]).filter(b=>b.source_id===s.source_id && b.author_id===s.subject_id);
  if(matches.length>1)return ['DISCOVERY_AMBIGUOUS_BINDING'];
  if(matches.length)try {service.active(matches[0].conversation_id);}catch{return ['DISCOVERY_SUBJECT_UNAVAILABLE'];}
  return [];
}
export function discoveryFreshness(service,s) {
  const reasons=[];
  if(s.status!=='active')reasons.push('DISCOVERY_'+s.status.toUpperCase());
  if(s.expires_at<=now())reasons.push('DISCOVERY_EXPIRED');
  if(!service.config.discovery?.enabled)reasons.push('DISCOVERY_DISABLED');
  if(service.store.get('SELECT 1 FROM discovery_suppressions WHERE scope_hash=?',scopeHash(service,s.source_id,s.subject_id,s.purpose_id)))reasons.push('DISCOVERY_SCOPE_CLOSED');
  if(!service.config.opportunity.allowedSourceRefs.includes(s.source_id))reasons.push('SOURCE_NOT_ALLOWED');
  reasons.push(...bindingReasons(service,s));
  try {
    const policy=discoveryPolicy(service);
    if(digest(policy)!==s.policy_hash)reasons.push('DISCOVERY_POLICY_CHANGED');
    if(discoveryObservations(service,s.source_id,s.subject_id,policy).hash!==s.observation_hash)reasons.push('DISCOVERY_EVIDENCE_CHANGED');
  } catch(error) {reasons.push(error.code??'DISCOVERY_POLICY_UNAVAILABLE');}
  const transport=discoveryTransport(service,s.source_id);
  return {fresh:reasons.length===0 && transport.reasons.length===0,reasons:[...new Set([...reasons,...transport.reasons])],
    semantic_reasons:[...new Set(reasons)],availability:transport.availability};
}
export function collectDiscovery(service) {
  const policy=discoveryPolicy(service), policyHash=digest(policy), stamp=now();
  for(const source of service.config.opportunity.allowedSourceRefs) {
    const rows=sourceRows(service,source);
    const subjects=new Set(rows.filter(r=>r.message.operation==='upsert' && r.message.author_id
      && !r.message.author_id.startsWith('channel:') && Date.parse(r.message.created_at)>=Date.now()-policy.windowDays*86400000).map(r=>r.message.author_id));
    for(const s of service.store.all("SELECT * FROM discovery_situations WHERE partner_id=? AND source_id=? AND status='active'",service.config.partnerId,source))subjects.add(s.subject_id);
    for(const subject of subjects) {
      // A new offer/policy version cannot reacquire work already transferred or stopped.
      if(service.store.get("SELECT id FROM discovery_situations WHERE partner_id=? AND source_id=? AND subject_id=? AND purpose_id=? AND status IN ('transferred','stopped')",
        service.config.partnerId,source,subject,policy.purpose.id))continue;
      const suppression=scopeHash(service,source,subject,policy.purpose.id);
      if(service.store.get('SELECT 1 FROM discovery_suppressions WHERE scope_hash=?',suppression))continue;
      const key=digest([suppression,policyHash]), view=discoveryObservations(service,source,subject,policy);
      const old=service.store.get('SELECT * FROM discovery_situations WHERE scope_key=?',key);
      if(old && old.status!=='active')continue;
      if(old?.observation_hash===view.hash)continue;
      if(old) {
        const decided=old.current_decision_id && service.store.get('SELECT revision FROM discovery_decisions WHERE id=?',old.current_decision_id)?.revision===old.revision;
        const due=decided?new Date(Date.now()+service.config.discovery.batchSeconds*1000).toISOString():old.not_before;
        service.store.run("UPDATE discovery_decisions SET status='superseded' WHERE situation_id=? AND status='current'",old.id);
        // Keep the old decision pointer for a backed prior hypothesis, but approvals are revision-bound.
        service.store.run('UPDATE discovery_situations SET revision=revision+1,observation_ids_json=?,observation_hash=?,updated_at=?,not_before=? WHERE id=?',
          JSON.stringify(view.version_ids),view.hash,stamp,due,old.id);
      } else service.store.run(`INSERT INTO discovery_situations(id,partner_id,source_id,subject_id,purpose_id,scope_key,policy_hash,purpose_json,status,
        revision,observation_ids_json,observation_hash,first_seen_at,updated_at,expires_at,not_before) VALUES(?,?,?,?,?,?,?,?,'active',1,?,?,?,?,?,?)`,
      id(),service.config.partnerId,source,subject,policy.purpose.id,key,policyHash,JSON.stringify(policy.purpose),JSON.stringify(view.version_ids),view.hash,
      stamp,stamp,new Date(Date.now()+policy.ttlDays*86400000).toISOString(),new Date(Date.now()+service.config.discovery.batchSeconds*1000).toISOString());
    }
  }
}
export function discoveryContext(service,s) {
  const policy=discoveryPolicy(service),view=discoveryObservations(service,s.source_id,s.subject_id,policy);
  const prior=s.current_decision_id?service.store.get('SELECT * FROM discovery_decisions WHERE id=?',s.current_decision_id):null;
  const previous=prior?json(prior.input_json):null, output=prior?json(prior.output_json):null;
  const ids=view.observations.map(o=>o.source_event_id), oldIds=previous?.input?.observation_event_ids??[];
  const priorValid=output?.hypothesis && discoveryEvidence(output).every(r=>ids.includes(r.source_event_id));
  return {contract:'discovery-v1',reasoning_version:policy.reasoning_version,input:{situation_id:s.id,revision:s.revision,source_id:s.source_id,subject_id:s.subject_id,
    purpose:policy.purpose,offer:policy.offer,observations:view.observations,observation_event_ids:ids,
    trigger_event_ids:ids.filter(x=>!oldIds.includes(x)),cutoff_at:now(),expires_at:s.expires_at,coverage:view.coverage},
    prior_hypothesis:priorValid?output.hypothesis:null,router_instructions:discoveryInstructions,output_contract:discoverySchema,
    authority:{contact_permission:false,allowed_effects:[]}};
}
function purge(service,s,status) {
  forgetDiscoveryLinks(service,s.id);
  service.store.run("UPDATE discovery_decisions SET input_json='{}',output_json='{}',evidence_json='[]',status='expired' WHERE situation_id=?",s.id);
  service.store.run("UPDATE discovery_reviews SET reason='' WHERE situation_id=?",s.id);
  service.store.run(`UPDATE runs SET context_json=?,result_json=NULL,status=CASE WHEN status IN ('running','analyzed') THEN 'cancelled' ELSE status END
    WHERE partner_id=? AND runtime='hermes-discovery' AND json_extract(context_json,'$.situation_id')=?`,JSON.stringify({situation_id:s.id,purged:true}),service.config.partnerId,s.id);
  service.store.run(`UPDATE discovery_situations SET status=?,revision=revision+1,observation_ids_json='[]',current_decision_id=NULL,
    purpose_json='{}',closed_reason=?,purged_at=?,updated_at=? WHERE id=?`,status,status,now(),now(),s.id);
}
export function sweepDiscovery(service) {
  for(const s of service.store.all('SELECT * FROM discovery_situations WHERE partner_id=? AND purged_at IS NULL AND expires_at<=?',service.config.partnerId,now()))purge(service,s,'expired');
}
export function requireDiscoveryReview(service,p,{approved=true}={}) {
  const s=getSituation(service,p.situation_id);
  check(Number.isSafeInteger(p.expected_revision) && p.expected_revision===s.revision,'DISCOVERY_REVISION_CONFLICT');
  const d=service.store.get('SELECT * FROM discovery_decisions WHERE id=? AND situation_id=?',p.decision_id,s.id);
  check(d && d.id===s.current_decision_id && d.revision===s.revision && d.status==='current','DISCOVERY_DECISION_STALE');
  check(discoveryFreshness(service,s).fresh,'DISCOVERY_NOT_FRESH');
  const output=json(d.output_json);
  check(output.decision==='REVIEW' && (!approved || d.review_status==='approved'),'DISCOVERY_REVIEW_REQUIRED');
  return {situation:s,decision:d,output,context:json(d.input_json)};
}
export function discoveryCommand(service,action,p,actor) {
  check(actor.kind==='operator','DISCOVERY_OPERATOR_REQUIRED');
  check(Object.keys(p).every(k=>(action==='discovery.review'?['situation_id','expected_revision','decision_id','verdict','reason']:['situation_id','expected_revision','reason']).includes(k)),'DISCOVERY_COMMAND_FIELDS');
  const s=getSituation(service,p.situation_id);
  check(p.expected_revision===s.revision,'DISCOVERY_REVISION_CONFLICT');
  const reason=requiredText(p.reason,'reason',4000);
  if(action==='discovery.forget') {
    suppressDiscovery(service,s,'forgotten');
    // A policy update may have left historical cases for this same bounded purpose.
    const siblings=service.store.all('SELECT * FROM discovery_situations WHERE partner_id=? AND source_id=? AND subject_id=? AND purpose_id=? AND status<>?',
      service.config.partnerId,s.source_id,s.subject_id,s.purpose_id,'forgotten');
    for(const sibling of siblings)purge(service,sibling,'forgotten');
    return {situation_id:s.id,status:'forgotten',source_ledger_deleted:false};
  }
  check(['approve','reject'].includes(p.verdict),'DISCOVERY_REVIEW_VERDICT');
  const {decision}=requireDiscoveryReview(service,p,{approved:false});
  check(decision.review_status==='pending','DISCOVERY_ALREADY_REVIEWED');
  const reviewId=id(),status=p.verdict==='approve'?'approved':'rejected';
  service.store.run('INSERT INTO discovery_reviews VALUES(?,?,?,?,?,?,?,?)',reviewId,s.id,decision.id,s.revision,p.verdict,reason,'operator',now());
  service.store.run('UPDATE discovery_decisions SET review_status=? WHERE id=?',status,decision.id);
  return {situation_id:s.id,decision_id:decision.id,review_id:reviewId,review_status:status,contact_permission_created:false,allowed_effects:[]};
}
export function discoveryDetail(service,situationId) {
  const s=getSituation(service,situationId),freshness=discoveryFreshness(service,s);
  const decisions=service.store.all('SELECT * FROM discovery_decisions WHERE situation_id=? ORDER BY revision DESC',s.id)
    .map(d=>({...d,output:json(d.output_json),input:json(d.input_json)}));
  const current=decisions.find(d=>d.id===s.current_decision_id)??null;
  if(current && (current.revision!==s.revision || current.status!=='current')) {
    freshness.fresh=false;freshness.reasons.push('DISCOVERY_DECISION_STALE');
  }
  const links=discoveryLinks(service,s.id);
  return {...s,current_decision:current,decisions,observations:s.purged_at?[]:(current?.input?.input?.observations??[]),links:links.origin?[links.origin]:[],
    decision:current?.output?.decision??null,assessment:current?.output?.assessment??null,
    availability:freshness.availability,freshness,...links};
}
export function discoveryList(service) {
  return {enabled:service.config.discovery?.enabled===true,situations:service.store.all('SELECT id FROM discovery_situations WHERE partner_id=? ORDER BY updated_at DESC LIMIT 200',service.config.partnerId)
    .map(s=>{const d=discoveryDetail(service,s.id);const {decisions,current_decision,observations,input_json,...row}=d;return row;})};
}
