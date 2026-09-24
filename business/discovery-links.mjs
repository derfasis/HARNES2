// Business transitions only: called inside BusinessService's serialized transaction.
// No source text is copied into private messages, Engagement beliefs or runtime guidance.
import { id } from './store.mjs';
import { ensure, requiredText, now } from './errors.mjs';
import { digest, sourceEvent, sourceRows } from './source-ingestion.mjs';
import { requireDiscoveryReview, suppressDiscovery } from './discovery.mjs';

export { DISCOVERY_LINK_TABLES } from './discovery-link-tables.mjs';
export const DISCOVERY_LINK_ACTIONS = ['discovery.engage','discovery.assess','discovery.lesson.review'];
const check = (condition, code) => ensure(condition, `Discovery linkage: ${code}`, 409, code);
const parse = value => JSON.parse(value);
function fields(p, names) {
  check(p && typeof p==='object' && !Array.isArray(p) && Object.keys(p).every(k=>names.includes(k)), 'DISCOVERY_LINK_FIELDS');
}
function identifiers(value) {
  check(Array.isArray(value) && value.length<=20 && value.every(v=>typeof v==='string' && v.length>0 && v.length<=150)
    && new Set(value).size===value.length, 'DISCOVERY_LINK_REFERENCES');
  return value;
}
function situationFor(service, situationId) {
  const situation=service.store.get('SELECT * FROM discovery_situations WHERE id=? AND partner_id=?',situationId,service.config.partnerId);
  check(situation, 'DISCOVERY_SITUATION_NOT_FOUND');
  check(!['expired','forgotten'].includes(situation.status) && situation.expires_at>now(), 'DISCOVERY_LINK_EXPIRED');
  return situation;
}
function engage(service,p) {
  fields(p,['situation_id','decision_id','expected_revision','conversation_id','inbound_message_id','permission_id']);
  const {situation,decision,context}=requireDiscoveryReview(service,{situation_id:p.situation_id,decision_id:p.decision_id,expected_revision:p.expected_revision});
  check(situation.status==='active', 'DISCOVERY_ALREADY_TRANSFERRED');
  const bindings=service.config.opportunity?.authorBindings;
  check(Array.isArray(bindings), 'DISCOVERY_BINDING_REQUIRED');
  const matches=bindings.filter(b=>b?.source_id===situation.source_id && b.author_id===situation.subject_id);
  check(matches.length===1 && typeof matches[0].conversation_id==='string' && !situation.subject_id.startsWith('channel:'), 'DISCOVERY_BINDING_REQUIRED');
  const cid=matches[0].conversation_id;
  check(p.conversation_id===undefined || p.conversation_id===cid, 'DISCOVERY_BINDING_MISMATCH');
  const {conversation,person}=service.active(cid);
  const inbound=service.store.get("SELECT * FROM messages WHERE id=? AND conversation_id=? AND direction='in'",requiredText(p.inbound_message_id,'inbound_message_id',150),cid);
  check(inbound, 'DISCOVERY_INBOUND_REQUIRED');
  // The grant is independently operator-recorded; approving Discovery never writes one.
  const grant=service.store.get(`SELECT * FROM contact_permissions WHERE id=? AND partner_id=? AND person_id=?
    AND conversation_id=? AND channel=? AND purpose='reply' AND revoked_at IS NULL AND valid_from<=? AND expires_at>?`,
  requiredText(p.permission_id,'permission_id',150),service.config.partnerId,person.id,cid,conversation.channel,now(),now());
  check(grant, 'DISCOVERY_REPLY_PERMISSION_REQUIRED');
  const account=conversation.channel_identity_id
    ?service.store.get('SELECT account_id FROM channel_identities WHERE id=?',conversation.channel_identity_id)?.account_id:null;
  check(grant.account_id===(account??null), 'DISCOVERY_PERMISSION_ACCOUNT_MISMATCH');
  check(!service.store.get("SELECT id FROM drafts WHERE conversation_id=? AND status IN ('sending','delivery_unknown')",cid), 'DISCOVERY_DELIVERY_UNRESOLVED');
  let engagement=service.engagement.current(cid);
  if(!engagement) {
    // Discovery cannot silently resurrect an explicitly closed/stopped matter.
    check(!service.engagement.managed(cid), 'DISCOVERY_EXPLICIT_ENGAGEMENT_REOPEN_REQUIRED');
    const opened=service.engagement.open({conversation_id:cid,topic:'Вхідне звернення після Discovery',
      current_need:'Уточнити актуальну потребу за реальним вхідним повідомленням.',
      unknowns:['Discovery hypothesis is background, not a confirmed need or permission.'],
      close_condition:'Потребу з вхідного звернення вирішено або людина відмовилася.'},{kind:'operator'});
    engagement=service.engagement.get(opened.engagement_id);
  }
  const originId=id();
  service.store.run(`INSERT INTO discovery_origins VALUES(?,?,?,?,?,?,?,?,?)`,originId,situation.id,decision.id,cid,engagement.id,
    inbound.id,grant.id,digest(context),now());
  // Revision fences late inference. The existing Engagement remains the only work owner.
  service.store.run("UPDATE discovery_situations SET status='transferred',revision=revision+1,engagement_id=?,updated_at=? WHERE id=?",engagement.id,now(),situation.id);
  suppressDiscovery(service,situation,'transferred');
  return {origin_id:originId,situation_id:situation.id,decision_id:decision.id,engagement_id:engagement.id,
    conversation_id:cid,status:'transferred',contact_permission_created:false,allowed_effects:[],runtime_started:false};
}
function assess(service,p) {
  fields(p,['situation_id','decision_id','classification','reason','source_event_ids','outcome_ids','lesson_text','limitations']);
  const situation=situationFor(service,p.situation_id);
  const decision=service.store.get('SELECT * FROM discovery_decisions WHERE id=? AND situation_id=?',p.decision_id,situation.id);
  check(decision, 'DISCOVERY_DECISION_NOT_FOUND');
  const context=parse(decision.input_json), output=parse(decision.output_json), input=context.input;
  check(input && Array.isArray(input.observations) && Number.isFinite(Date.parse(input.cutoff_at)), 'DISCOVERY_DECISION_EVIDENCE_EXPIRED');
  check(['supported','refuted','missed_existing_evidence','later_need_only','unknown'].includes(p.classification), 'DISCOVERY_ASSESSMENT_CLASSIFICATION');
  const sourceIds=identifiers(p.source_event_ids??[]), outcomeIds=identifiers(p.outcome_ids??[]);
  check(sourceIds.length+outcomeIds.length>0, 'DISCOVERY_ASSESSMENT_EVIDENCE_REQUIRED');
  const original=new Map(input.observations.map(o=>[o.source_event_id,o]));
  const sources=sourceIds.map(sourceId=> {
    const source=sourceEvent(service,sourceId), message=source.message;
    check(message.source_id===situation.source_id && (message.author_id===situation.subject_id || original.has(sourceId)), 'DISCOVERY_ASSESSMENT_SOURCE_SCOPE');
    check(message.operation==='upsert', 'DISCOVERY_ASSESSMENT_SOURCE_UNSUPPORTED');
    if(p.classification!=='missed_existing_evidence')check(sourceRows(service,message.source_id).some(r=>r.event_id===sourceId), 'DISCOVERY_ASSESSMENT_SOURCE_SUPERSEDED');
    return source;
  });
  if(p.classification==='missed_existing_evidence') {
    check(['WAIT','IGNORE'].includes(output.decision), 'DISCOVERY_FALSE_NEGATIVE_DECISION');
    check(sources.length>0 && sources.every(s=>original.has(s.event_id)
      && Date.parse(s.observed_at)<=Date.parse(input.cutoff_at)
      && Date.parse(s.message.created_at)<=Date.parse(input.cutoff_at)), 'DISCOVERY_HINDSIGHT_EVIDENCE');
  }
  if(p.classification==='later_need_only') {
    check(sources.length>0 && sources.every(s=>!original.has(s.event_id)
      && Date.parse(s.observed_at)>Date.parse(input.cutoff_at)), 'DISCOVERY_NOT_LATER_EVIDENCE');
  }
  const origin=service.store.get('SELECT * FROM discovery_origins WHERE situation_id=?',situation.id);
  const outcomes=outcomeIds.map(outcomeId=> {
    check(origin, 'DISCOVERY_ENGAGEMENT_ORIGIN_REQUIRED');
    const outcome=service.store.get(`SELECT o.*,d.attribution FROM outcome_events o
      JOIN decision_outcomes d ON d.outcome_id=o.id JOIN engagement_decisions ed ON ed.id=d.decision_id
      WHERE o.id=? AND o.conversation_id=? AND ed.engagement_id=?`,outcomeId,origin.conversation_id,origin.engagement_id);
    check(outcome && outcome.created_at>=origin.created_at, 'DISCOVERY_ASSESSMENT_OUTCOME_SCOPE');
    return outcome;
  });
  const attribution=outcomes.some(o=>o.attribution==='human_assisted')?'human_assisted'
    :outcomes.length && outcomes.every(o=>o.attribution==='observed_association')?'observed_association':'unknown';
  const assessmentId=id(),lessonId=id(),created=now();
  service.store.run('INSERT INTO discovery_assessments VALUES(?,?,?,?,?,?,?,?,?,?,NULL)',assessmentId,situation.id,decision.id,
    p.classification,requiredText(p.reason,'assessment reason',4000),JSON.stringify(sourceIds),JSON.stringify(outcomeIds),attribution,'operator',created);
  service.store.run(`INSERT INTO discovery_lessons(id,assessment_id,situation_id,text,limitations,created_at) VALUES(?,?,?,?,?,?)`,
    lessonId,assessmentId,situation.id,requiredText(p.lesson_text,'candidate lesson',6000),requiredText(p.limitations,'limitations',4000),created);
  return {assessment_id:assessmentId,lesson_id:lessonId,situation_id:situation.id,classification:p.classification,
    attribution,status:'candidate',causal_credit:'not_established',runtime_use:false,permissions_changed:false};
}
function reviewLesson(service,p) {
  fields(p,['lesson_id','decision','expected_revision','evaluation','limitations']);
  const lesson=service.store.get(`SELECT l.* FROM discovery_lessons l JOIN discovery_situations s ON s.id=l.situation_id
    WHERE l.id=? AND s.partner_id=?`,p.lesson_id,service.config.partnerId);
  check(lesson, 'DISCOVERY_LESSON_NOT_FOUND');situationFor(service,lesson.situation_id);
  check(lesson.status!=='forgotten', 'DISCOVERY_LINK_EXPIRED');
  check(Number.isSafeInteger(p.expected_revision) && p.expected_revision===lesson.revision, 'DISCOVERY_LESSON_REVISION_CONFLICT');
  check(['approve','reject'].includes(p.decision), 'DISCOVERY_LESSON_REVIEW_DECISION');
  const reviewId=id(),revision=lesson.revision+1,status=p.decision==='approve'?'reviewed':'rejected';
  const evaluation=requiredText(p.evaluation,'review evaluation',6000),limitations=requiredText(p.limitations,'limitations',4000);
  service.store.run('INSERT INTO discovery_lesson_reviews VALUES(?,?,?,?,?,?,?,?)',reviewId,lesson.id,revision,p.decision,evaluation,limitations,'operator',now());
  service.store.run('UPDATE discovery_lessons SET status=?,revision=?,reviewed_at=? WHERE id=?',status,revision,now(),lesson.id);
  return {review_id:reviewId,lesson_id:lesson.id,situation_id:lesson.situation_id,status,revision,runtime_use:false,
    strategy_created:false,permissions_changed:false};
}
export function discoveryLinkCommand(service,action,p,actor) {
  ensure(actor?.kind==='operator','Discovery linkage requires operator review',403);
  check(DISCOVERY_LINK_ACTIONS.includes(action), 'DISCOVERY_LINK_ACTION');
  if(action==='discovery.engage')return engage(service,p);
  if(action==='discovery.assess')return assess(service,p);
  return reviewLesson(service,p);
}
export function discoveryLinks(service,situationId) {
  check(service.store.get('SELECT id FROM discovery_situations WHERE id=? AND partner_id=?',situationId,service.config.partnerId), 'DISCOVERY_SITUATION_NOT_FOUND');
  const assessments=service.store.all('SELECT * FROM discovery_assessments WHERE situation_id=? ORDER BY created_at,rowid',situationId)
    .map(a=>({...a,source_event_ids:parse(a.source_event_ids_json),outcome_ids:parse(a.outcome_ids_json)}));
  const lessons=service.store.all('SELECT * FROM discovery_lessons WHERE situation_id=? ORDER BY created_at,rowid',situationId)
    .map(l=>({...l,runtime_use:false,reviews:service.store.all('SELECT * FROM discovery_lesson_reviews WHERE lesson_id=? ORDER BY revision',l.id)}));
  return {origin:service.store.get('SELECT * FROM discovery_origins WHERE situation_id=?',situationId)??null,
    assessments,lessons,causal_credit:'not_established',runtime_use:false};
}
export function forgetDiscoveryLinks(service,situationId) {
  // Preserve identifiers/association for audit, remove derived person-related prose.
  check(service.store.get('SELECT id FROM discovery_situations WHERE id=? AND partner_id=?',situationId,service.config.partnerId), 'DISCOVERY_SITUATION_NOT_FOUND');
  const lessonIds=service.store.all('SELECT id FROM discovery_lessons WHERE situation_id=?',situationId).map(l=>l.id);
  service.store.run("UPDATE discovery_assessments SET reason='',forgotten_at=COALESCE(forgotten_at,?) WHERE situation_id=?",now(),situationId);
  service.store.run("UPDATE discovery_lessons SET text='',limitations='',status='forgotten',revision=revision+1 WHERE situation_id=? AND status<>'forgotten'",situationId);
  for(const lessonId of lessonIds)service.store.run("UPDATE discovery_lesson_reviews SET evaluation='',limitations='' WHERE lesson_id=?",lessonId);
  const commands=service.store.all(`SELECT id,payload_json FROM events WHERE partner_id=? AND kind IN ('discovery.assess','discovery.lesson.review')`,service.config.partnerId);
  for(const command of commands) {
    const payload=parse(command.payload_json);
    if(payload.situation_id!==situationId && !lessonIds.includes(payload.lesson_id))continue;
    service.store.run('UPDATE events SET payload_json=? WHERE id=?',JSON.stringify({situation_id:situationId,
      decision_id:payload.decision_id??null,lesson_id:payload.lesson_id??null,result:payload.result??null,forgotten:true}),command.id);
  }
}
