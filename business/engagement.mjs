// Business state only. No model, transport, timer loop, or authority in this module.
// Public methods execute inside BusinessService's existing serialized transaction.
import { id } from './store.mjs';
import { ensure, requiredText, dateTime, now } from './errors.mjs';

export { ENGAGEMENT_TABLES } from './engagement-tables.mjs';
export const ENGAGEMENT_ACTIONS = new Set(['engagement.open','engagement.update','engagement.close','engagement.wake','belief.record','belief.reject','decision.commit','permission.grant','permission.revoke','handoff.accept','handoff.resolve','commitment.record','commitment.resolve','explanation.record','learning.propose','learning.review']);
export const ENGAGEMENT_AGENT_ACTIONS = ['belief.record','decision.commit','learning.propose'];
const LIVE = "status NOT IN ('CLOSED','STOPPED')";
const WAIT_EVENTS = ['inbound','operator_response','permission_changed','commitment_due','outcome'];
const list = (x, max = 20) => { ensure(Array.isArray(x) && x.length <= max, 'Expected bounded array'); return x; };
const texts = x => list(x ?? []).map(t => requiredText(t,'text',2000));
const parse = x => JSON.parse(x);
const operator = a => ensure(a.kind === 'operator', 'Operator review required', 403);

export class EngagementLoop {
  constructor(service) { this.s = service; this.db = service.store; }
  current(cid) { return this.db.get(`SELECT * FROM engagements WHERE conversation_id=? AND ${LIVE}`,cid); }
  managed(cid) { return !!this.db.get('SELECT id FROM engagements WHERE conversation_id=? LIMIT 1',cid); }
  get(eid) {
    const e = this.db.get('SELECT * FROM engagements WHERE id=? AND partner_id=?',eid,this.s.config.partnerId);
    ensure(e,'Engagement not found',404); this.s.conversation(e.conversation_id); return e;
  }
  decision(did) { const d = this.db.get('SELECT * FROM engagement_decisions WHERE id=?',did); ensure(d,'Decision not found',404); this.get(d.engagement_id); return d; }
  evidence(e, refs, { nonempty = true } = {}) {
    list(refs); ensure(!nonempty || refs.length,'Evidence required');
    return refs.map(ref => {
      ensure(ref && typeof ref === 'object' && ['message','fact','outcome'].includes(ref.type), 'Unsupported evidence type');
      requiredText(ref.id,'evidence id',100);
      let row;
      if (ref.type === 'message') row = this.db.get('SELECT * FROM messages WHERE id=? AND conversation_id=?',ref.id,e.conversation_id);
      if (ref.type === 'fact') row = this.db.get("SELECT f.* FROM facts f JOIN conversations c ON c.person_id=f.person_id WHERE f.id=? AND c.id=? AND f.status='confirmed'",ref.id,e.conversation_id);
      if (ref.type === 'outcome') row = this.db.get('SELECT * FROM outcome_events WHERE id=? AND conversation_id=?',ref.id,e.conversation_id);
      ensure(row,'Evidence missing or outside engagement scope',409,'invalid_evidence');
      return {type:ref.type,id:ref.id};
    });
  }
  snapshot(eid) {
    const e = this.get(eid), c = this.s.conversation(e.conversation_id);
    return {...e, unknowns:parse(e.unknowns_json), ownership:c.ownership,
      beliefs:this.db.all("SELECT * FROM engagement_beliefs WHERE engagement_id=? AND status='current' AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at,rowid",eid,now()).map(b=>({...b,evidence:parse(b.evidence_json),counterevidence:parse(b.counterevidence_json)})),
      commitments:this.db.all("SELECT * FROM engagement_commitments WHERE engagement_id=? AND status IN ('open','proposed') ORDER BY created_at,rowid",eid),
      explained:this.db.all('SELECT * FROM engagement_explanations WHERE engagement_id=? ORDER BY created_at,rowid',eid),
      waiting:this.db.all("SELECT * FROM engagement_waits WHERE engagement_id=? AND status='waiting'",eid).map(w=>({...w,events:parse(w.events_json)})),
      handoffs:this.db.all("SELECT * FROM engagement_handoffs WHERE engagement_id=? AND status IN ('requested','accepted')",eid),
      last_decision:this.db.get('SELECT id,kind,reason,expected_next,status,created_at FROM engagement_decisions WHERE engagement_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',eid) ?? null,
      strategies:this.db.all("SELECT * FROM engagement_strategies WHERE conversation_id=? AND partner_id=? AND status='active' ORDER BY created_at",c.id,e.partner_id),
      boundary:'Claims are attributed statements, hypotheses are not facts, and none of these objects grants permission. Proposed commitments are not promises already made.'};
  }
  assertFresh(e,p,a) {
    ensure(!['CLOSED','STOPPED'].includes(e.status),'Engagement closed',409);
    ensure(p.expected_revision === e.revision,'Engagement changed',409,'stale_engagement');
    if (a.kind === 'agent') {
      ensure(a.runId && a.conversationId === e.conversation_id,'Scoped run required',403);
      this.s.assertRunFresh(a,e.conversation_id);
      const run = this.db.get('SELECT * FROM runs WHERE id=?',a.runId), ctx=parse(run.context_json);
      ensure(ctx.engagement?.id === e.id && ctx.engagement.revision === e.revision,'Run has no current engagement snapshot',409,'stale_engagement');
    }
  }
  cancelTasks(cid) { this.db.run("UPDATE tasks SET status='cancelled' WHERE conversation_id=? AND status IN ('pending','proposed','running','interrupted','blocked')",cid); }
  onChange(cid,reason) {
    const c=this.s.conversation(cid),p=this.s.person(c.person_id);
    if(p.suppressed)this.db.run('UPDATE contact_permissions SET revoked_at=COALESCE(revoked_at,?) WHERE person_id=?',now(),p.id);
    const e=this.current(cid); if(!e)return;
    this.db.run('UPDATE engagements SET revision=revision+1,updated_at=? WHERE id=?',now(),e.id);
    this.db.run("UPDATE engagement_decisions SET status='stale' WHERE engagement_id=? AND status='current'",e.id);
    this.db.run("UPDATE engagement_commitments SET status='cancelled',resolution_evidence=? WHERE engagement_id=? AND status='proposed' AND draft_id IN (SELECT id FROM drafts WHERE status IN ('stale','rejected'))",reason,e.id);
    this.db.run("UPDATE tasks SET status='cancelled' WHERE id IN (SELECT task_id FROM engagement_tasks WHERE engagement_id=?) AND status='running'",e.id);
    // Known changed fact evidence invalidates dependent beliefs, rather than promoting them.
    if (reason === 'fact_reviewed') this.db.run("UPDATE engagement_beliefs SET status='stale' WHERE engagement_id=? AND status='current' AND EXISTS (SELECT 1 FROM json_each(evidence_json) j WHERE json_extract(j.value,'$.type')='fact')",e.id);
    if(p.suppressed) {
      this.db.run("UPDATE engagements SET status='STOPPED' WHERE id=?",e.id);
      this.db.run("UPDATE contact_permissions SET revoked_at=? WHERE person_id=? AND revoked_at IS NULL",now(),p.id);
      this.db.run("UPDATE engagement_commitments SET status='cancelled',resolution_evidence=? WHERE engagement_id=? AND status IN ('open','proposed')",reason,e.id);
      this.db.run("UPDATE engagement_waits SET status='cancelled' WHERE engagement_id=? AND status='waiting'",e.id);
      this.db.run("UPDATE engagement_handoffs SET status='cancelled',resolved_at=?,resolution=? WHERE engagement_id=? AND status IN ('requested','accepted')",now(),reason,e.id);
      this.cancelTasks(cid);
    } else if(c.ownership==='HUMAN_OWNED') {
      this.db.run("UPDATE engagements SET status='HUMAN' WHERE id=?",e.id); this.cancelTasks(cid);
    }
  }
  enqueue(e,trigger) {
    e=this.get(e.id); const c=this.s.conversation(e.conversation_id),p=this.s.person(c.person_id);
    if(['CLOSED','STOPPED'].includes(e.status)||p.suppressed||c.ownership!=='AI_OWNED')return {queued:false};
    const existing=this.db.get("SELECT t.id FROM tasks t JOIN engagement_tasks et ON et.task_id=t.id WHERE et.engagement_id=? AND t.status='pending'",e.id);
    if(existing) { this.db.run('UPDATE engagement_tasks SET trigger_json=? WHERE task_id=?',JSON.stringify(trigger),existing.id); return {task_id:existing.id,coalesced:true}; }
    const task=this.s.addTask({conversation_id:e.conversation_id,kind:'engagement_evaluate',title:'Переглянути поточну справу',instructions:'Read durable engagement state. Commit exactly one ACT / WAIT / IGNORE / HANDOFF / STOP decision. Do not assume a reply is needed.',evidence:JSON.stringify(trigger),due_at:now()},'system','pending');
    this.db.run('INSERT INTO engagement_tasks VALUES(?,?,?)',task.task_id,e.id,JSON.stringify(trigger)); return task;
  }
  signal(e,type,detail={}) {
    const waits=this.db.all("SELECT * FROM engagement_waits WHERE engagement_id=? AND status='waiting'",e.id);
    const matching=waits.filter(w=>parse(w.events_json).includes(type));
    for(const w of matching)this.db.run("UPDATE engagement_waits SET status='satisfied',satisfied_by=? WHERE decision_id=?",type,w.decision_id);
    if(waits.length && !matching.length)return {queued:false,waiting:true};
    if(e.status==='WAITING')this.db.run("UPDATE engagements SET status='OPEN',updated_at=? WHERE id=?",now(),e.id);
    return this.enqueue(e,{type,...detail});
  }
  inbound(cid,messageId) {
    let e=this.current(cid);
    const c=this.s.conversation(cid),p=this.s.person(c.person_id);
    if(!e && this.s.config.engagement?.enabled===true && !p.suppressed && c.ownership==='AI_OWNED') {
      // Do not silently resurrect a previously closed/stopped matter.
      if(this.db.get('SELECT id FROM engagements WHERE conversation_id=?',cid))return true;
      e=this.open({conversation_id:cid,topic:'Вхідне звернення',current_need:'Потребує уточнення за повідомленням',close_condition:'Питання вирішено або людина відмовилася'}, {kind:'operator'},false);
      e=this.get(e.engagement_id);
    }
    if(!e)return this.managed(cid);
    this.signal(e,'inbound',{message_id:messageId});return true;
  }
  open(p,a,enqueue=true) {
    operator(a); const {conversation:c}=this.s.active(p.conversation_id);
    ensure(!this.current(c.id),'A live engagement already exists',409);
    ensure(!this.db.get("SELECT id FROM drafts WHERE conversation_id=? AND status IN ('sending','delivery_unknown')",c.id),'Reconcile existing delivery before enabling engagement',409);
    this.s.invalidate(c.id,'engagement_opened'); this.cancelTasks(c.id);
    const eid=id();this.db.run('INSERT INTO engagements(id,partner_id,conversation_id,topic,current_need,unknowns_json,close_condition,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',eid,this.s.config.partnerId,c.id,requiredText(p.topic,'topic',500),requiredText(p.current_need,'current need',2000),JSON.stringify(texts(p.unknowns)),requiredText(p.close_condition,'close condition',2000),now(),now());
    if(enqueue)this.enqueue(this.get(eid),{type:'operator_open'});
    return {engagement_id:eid};
  }
  permission(e,purpose) {
    const c=this.s.conversation(e.conversation_id), person=this.s.person(c.person_id);
    ensure(!person.suppressed&&c.ownership==='AI_OWNED'&&!['CLOSED','STOPPED'].includes(e.status),'Work is not AI owned',409);
    const permission=this.db.get('SELECT * FROM contact_permissions WHERE partner_id=? AND person_id=? AND conversation_id=? AND channel=? AND purpose=? AND revoked_at IS NULL AND valid_from<=? AND expires_at>? ORDER BY created_at DESC,rowid DESC LIMIT 1',e.partner_id,c.person_id,c.id,c.channel,purpose,now(),now());
    ensure(permission,'A current typed permission is required',409,'typed_permission_required');
    const account=c.channel_identity_id?this.db.get('SELECT account_id FROM channel_identities WHERE id=?',c.channel_identity_id)?.account_id:null;
    ensure(permission.account_id===(account??null),'Permission account changed',409,'typed_permission_required');return permission;
  }
  assertDraft(d,{execution=false}={}) {
    // Historical managed drafts stay managed even after the matter is closed.
    const action=this.db.get('SELECT * FROM engagement_actions WHERE draft_id=?',d.id);
    const e=action?this.get(this.decision(action.decision_id).engagement_id):this.current(d.conversation_id);
    if(!e){ensure(!this.managed(d.conversation_id),'Managed matter is closed',409);return;}
    ensure(action,'Managed drafts require an ACT decision',409,'decision_required');
    const decision=this.decision(action.decision_id),c=this.s.conversation(e.conversation_id);
    ensure(decision.status==='current'&&decision.conversation_revision===c.revision,'Decision is stale',409,'stale_decision');
    const beliefs=parse(decision.snapshot_json).engagement.beliefs;
    ensure(!beliefs.some(b=>b.expires_at&&b.expires_at<=now()),'Decision contains expired belief evidence',409,'stale_decision');
    // Recheck the exact grant recorded in the decision; a new grant never revives it.
    const grant=this.db.get('SELECT * FROM contact_permissions WHERE id=?',action.permission_id);
    ensure(grant && !grant.revoked_at && grant.valid_from<=now()&&grant.expires_at>now(),'Permission expired or revoked',409,'typed_permission_required');
    this.permission(e,action.purpose);
    if(execution)ensure(this.db.get("SELECT id FROM approvals WHERE draft_id=? AND draft_version=? AND approved_by='operator'",d.id,d.current_version),'Managed execution requires human approval',409);
  }
  draftProposal(p,a) {
    const e=this.current(p.conversation_id);if(!e){ensure(!this.managed(p.conversation_id),'Open a new engagement explicitly',409);return;}
    ensure(p.decision_id,'Commit an ACT decision before creating a managed draft',409,'decision_required');
    const d=this.decision(p.decision_id);
    ensure(d.engagement_id===e.id&&d.kind==='ACT'&&d.status==='current'&&d.run_id===(a.runId??null),'Invalid ACT decision',409);
    ensure(!this.db.get('SELECT draft_id FROM engagement_actions WHERE decision_id=?',d.id),'Decision already has an action',409);
    this.permission(e,p.purpose??'reply');
  }
  commit(p,a) {
    const e=this.get(p.engagement_id);this.assertFresh(e,p,a);this.s.active(e.conversation_id);
    ensure(['ACT','WAIT','IGNORE','HANDOFF','STOP'].includes(p.kind),'Invalid decision');
    const ev=this.evidence(e,p.evidence),reason=requiredText(p.reason,'reason',4000),expected=requiredText(p.expected_next,'expected next',2000);
    const c=this.s.conversation(e.conversation_id),snapshot=this.snapshot(e.id);
    const evidenceSnapshot=ev.map(ref=>({reference:ref,record:this.db.get(`SELECT * FROM ${{message:'messages',fact:'facts',outcome:'outcome_events'}[ref.type]} WHERE id=?`,ref.id)}));
    const state=p.state?{current_need:requiredText(p.state.current_need??e.current_need,'current need',2000),unknowns:texts(p.state.unknowns??parse(e.unknowns_json))}:null;
    const run=a.runId?this.db.get('SELECT context_json FROM runs WHERE id=?',a.runId):null;
    const attention=this.db.get("SELECT et.trigger_json FROM engagement_tasks et JOIN tasks t ON t.id=et.task_id WHERE et.engagement_id=? AND t.status IN ('pending','running') ORDER BY t.created_at DESC,t.rowid DESC LIMIT 1",e.id);
    const trigger=attention?parse(attention.trigger_json):{type:'operator_decision'};
    let permission=null;
    if(p.kind==='ACT') {
      ensure(p.wait_for===undefined&&p.wake_at===undefined,'Only WAIT can declare wait conditions');
      ensure(p.action && ['reply','follow_up'].includes(p.action.purpose),'Explicit action purpose required');
      permission=this.permission(e,p.action.purpose);
      const text=requiredText(p.action.text,'action text',4096);
      ensure(texts(p.action.explained).every(x=>text.includes(x)),'Explained items must quote the proposed text');
      ensure(list(p.action.commitments??[]).every(x=>typeof x.text==='string'&&text.includes(x.text)),'Commitments must quote the proposed text');
      ensure(!this.db.get("SELECT d.id FROM drafts d JOIN engagement_actions ea ON ea.draft_id=d.id JOIN engagement_decisions ed ON ed.id=ea.decision_id WHERE ed.engagement_id=? AND d.status IN ('sending','delivery_unknown')",e.id),'Reconcile unresolved delivery before another action',409,'delivery_unresolved');
    } else ensure(!p.action,'Only ACT can propose a draft');
    const waits=p.kind==='WAIT'?list(p.wait_for??[]):[];
    if(p.kind==='WAIT')ensure(waits.every(x=>WAIT_EVENTS.includes(x))&&(waits.length||p.wake_at),'WAIT needs typed events or a deadline');
    else ensure(p.wait_for===undefined&&p.wake_at===undefined,'Only WAIT can declare wait conditions');
    const wake=p.wake_at?dateTime(p.wake_at):null;
    if(wake)ensure(p.kind==='WAIT'&&wake>now(),'Wake time must be in the future');
    const prior=this.db.get("SELECT id FROM engagement_decisions WHERE engagement_id=? AND status='current'",e.id);
    ensure(!prior,'Current decision must first be invalidated by a new event',409,'decision_already_current');
    const did=id(),strategy=snapshot.strategies.at(-1)?.id??null;
    this.db.run('INSERT INTO engagement_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',did,e.id,a.runId??null,e.revision,c.revision,p.kind,reason,JSON.stringify(ev),expected,JSON.stringify({trigger,engagement:snapshot,run_context:run?parse(run.context_json):null,evidence:ev,evidence_snapshot:evidenceSnapshot,proposed_state:state,conversation_revision:c.revision,permission}),strategy,'current',a.kind,now());
    this.db.run("UPDATE engagement_waits SET status='cancelled' WHERE engagement_id=? AND status='waiting'",e.id);
    this.db.run("UPDATE engagements SET status='OPEN',updated_at=? WHERE id=?",now(),e.id);
    if(state)this.db.run('UPDATE engagements SET current_need=?,unknowns_json=? WHERE id=?',state.current_need,JSON.stringify(state.unknowns),e.id);
    // Consume pending attention in the same transaction, not by a later tick.
    this.db.run("UPDATE tasks SET status='done' WHERE id IN (SELECT task_id FROM engagement_tasks WHERE engagement_id=?) AND status='pending'",e.id);
    let result={decision_id:did,kind:p.kind};
    if(p.kind==='ACT') {
      const action=p.action;
      const draft=this.s.execute('draft.create',{conversation_id:c.id,decision_id:did,purpose:action.purpose,text:action.text,action:'reply',reason},`engagement-draft:${did}`,a);
      this.db.run('INSERT INTO engagement_actions VALUES(?,?,?,?,?,?)',draft.draft_id,did,permission.id,action.purpose,JSON.stringify(texts(action.explained)),now());
      for(const item of list(action.commitments??[])) {
        ensure(['AI','HUMAN'].includes(item.owner),'Commitment owner required');
        this.db.run('INSERT INTO engagement_commitments(id,engagement_id,decision_id,draft_id,text,owner,status,due_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)',id(),e.id,did,draft.draft_id,requiredText(item.text,'commitment',2000),item.owner,'proposed',item.due_at?dateTime(item.due_at):null,now());
      }
      result={...result,...draft};
    }
    if(p.kind==='WAIT') {
      this.db.run('INSERT INTO engagement_waits VALUES(?,?,?,?,?,?,?)',did,e.id,JSON.stringify(waits),wake,'waiting',null,now());
      this.db.run("UPDATE engagements SET status='WAITING' WHERE id=?",e.id);
    }
    if(p.kind==='HANDOFF') {
      this.db.run("UPDATE conversations SET ownership='HUMAN_OWNED' WHERE id=?",c.id);
      this.s.invalidate(c.id,'engagement_handoff');
      const hid=id();this.db.run('INSERT INTO engagement_handoffs(id,engagement_id,decision_id,status,owner,reason,packet_json,created_at) VALUES(?,?,?,?,?,?,?,?)',hid,e.id,did,'requested','operator',reason,JSON.stringify(snapshot),now());
      result.handoff_id=hid;
    }
    if(p.kind==='STOP') {
      this.db.run('UPDATE persons SET suppressed=1 WHERE id=?',c.person_id);
      for(const conversation of this.db.all('SELECT id FROM conversations WHERE person_id=?',c.person_id)) {
        this.s.invalidate(conversation.id,'decision_stop');this.cancelTasks(conversation.id);
      }
      result.stopped=true;
    }
    // HANDOFF/STOP invalidate authority, but their historical decision remains recorded as stale.
    return result;
  }
  onDelivered(draft,messageId) {
    const a=this.db.get('SELECT * FROM engagement_actions WHERE draft_id=?',draft.id);if(!a)return;
    const d=this.decision(a.decision_id);
    // Never attribute model promises/explanations to an operator rewrite.
    if(draft.current_version===1) {
      this.db.run("UPDATE engagement_commitments SET status='open',source_message_id=? WHERE draft_id=? AND status='proposed'",messageId,draft.id);
      for(const text of parse(a.explained_json))this.db.run('INSERT INTO engagement_explanations VALUES(?,?,?,?,?,?)',id(),d.engagement_id,messageId,text,'delivered_quote',now());
    }
  }
  outcome(p,result) {
    let did=p.decision_id;
    if(p.draft_id) {
      const action=this.db.get('SELECT * FROM engagement_actions WHERE draft_id=?',p.draft_id);
      if(action){ensure(!did||did===action.decision_id,'Outcome/draft decision mismatch',409);did=action.decision_id;}
    }
    if(!did)return;
    const d=this.decision(did),e=this.get(d.engagement_id);ensure(e.conversation_id===p.conversation_id,'Outcome scope mismatch',409);
    const action=this.db.get('SELECT * FROM engagement_actions WHERE decision_id=?',did);
    // Association, not causal credit. Delivery truth is always queried separately.
    const attribution=action&&this.s.draft(action.draft_id).current_version>1?'human_assisted':'observed_association';
    this.db.run('INSERT INTO decision_outcomes VALUES(?,?,?,?)',result.outcome_id,did,attribution,now());
  }
  sweep(at=now()) {
    // Deterministic due transitions. No LLM is called by this function.
    for(const b of this.db.all("SELECT * FROM engagement_beliefs WHERE status='current' AND expires_at IS NOT NULL AND expires_at<=?",at)) {
      this.db.run("UPDATE engagement_beliefs SET status='stale' WHERE id=?",b.id);
      const e=this.get(b.engagement_id);if(!['CLOSED','STOPPED'].includes(e.status))this.s.invalidate(e.conversation_id,'belief_expired');
    }
    for(const w of this.db.all("SELECT * FROM engagement_waits WHERE status='waiting' AND due_at IS NOT NULL AND due_at<=?",at)) {
      this.db.run("UPDATE engagement_waits SET status='satisfied',satisfied_by='deadline' WHERE decision_id=?",w.decision_id);
      const e=this.get(w.engagement_id);this.s.invalidate(e.conversation_id,'wait_deadline');
      if(e.status==='WAITING')this.db.run("UPDATE engagements SET status='OPEN' WHERE id=?",e.id);
      this.enqueue(this.get(e.id),{type:'deadline',decision_id:w.decision_id});
    }
    for(const c of this.db.all("SELECT * FROM engagement_commitments WHERE status='open' AND due_at<=? AND due_fired_at IS NULL",at)) {
      this.db.run('UPDATE engagement_commitments SET due_fired_at=? WHERE id=?',at,c.id);
      const e=this.get(c.engagement_id);this.db.event(e.partner_id,e.conversation_id,'commitment.due','system',{commitment_id:c.id,owner:c.owner});
      if(c.owner==='AI') {this.s.invalidate(e.conversation_id,'commitment_due');this.signal(this.get(e.id),'commitment_due',{commitment_id:c.id});}
    }
  }
  episode(did) {
    const decision=this.decision(did),action=this.db.get('SELECT * FROM engagement_actions WHERE decision_id=?',did);
    const draft=action?this.s.draft(action.draft_id):null;
    return {decision,snapshot:parse(decision.snapshot_json),action:action??null,draft,
      versions:draft?this.db.all('SELECT * FROM draft_versions WHERE draft_id=? ORDER BY version',draft.id):[],
      approvals:draft?this.db.all('SELECT * FROM approvals WHERE draft_id=? ORDER BY created_at',draft.id):[],
      attempts:draft?this.db.all('SELECT * FROM delivery_attempts WHERE draft_id=? ORDER BY created_at',draft.id):[],
      actual_messages:draft?this.db.all('SELECT * FROM messages WHERE draft_id=?',draft.id):[],
      outcomes:this.db.all('SELECT o.*,d.attribution FROM outcome_events o JOIN decision_outcomes d ON d.outcome_id=o.id WHERE d.decision_id=?',did),
      causal_credit:'not_established'};
  }
  execute(action,p,a) {
    if(action==='engagement.open')return this.open(p,a);
    if(action.startsWith('permission.'))return this.permissionCommand(action,p,a);
    if(action.startsWith('learning.'))return this.learning(action,p,a);
    if(action==='decision.commit')return this.commit(p,a);
    const e=this.get(p.engagement_id);this.s.assertScope(a,e.conversation_id);
    ensure(!['CLOSED','STOPPED'].includes(e.status),'Historical engagement is read-only',409);
    if(action==='belief.record') {
      this.assertFresh(e,p,a);if(a.kind==='agent')ensure(!this.db.get("SELECT id FROM engagement_decisions WHERE engagement_id=? AND status='current'",e.id),'Beliefs must precede the decision',409);ensure(['CLAIM','HYPOTHESIS','VERIFIED_FACT'].includes(p.kind),'Invalid belief kind');
      if(p.kind==='VERIFIED_FACT')operator(a);
      const ev=this.evidence(e,p.evidence),counter=this.evidence(e,p.counterevidence??[],{nonempty:false}),text=requiredText(p.text,'belief',4000);
      if(p.kind==='CLAIM') {
        ensure(ev.some(r=>r.type==='message'&&this.db.get("SELECT id FROM messages WHERE id=? AND direction='in' AND instr(text,?)>0",r.id,text)),'CLAIM must quote an inbound message exactly');
      }
      if(p.supersedes_id) {const old=this.db.get('SELECT * FROM engagement_beliefs WHERE id=? AND engagement_id=?',p.supersedes_id,e.id);ensure(old?.status==='current','Belief not current');this.db.run("UPDATE engagement_beliefs SET status='superseded' WHERE id=?",old.id);}
      const bid=id();this.db.run('INSERT INTO engagement_beliefs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',bid,e.id,p.kind,text,JSON.stringify(ev),JSON.stringify(counter),p.kind==='VERIFIED_FACT'?requiredText(p.verification,'verification method and independent source',4000):null,'current',p.supersedes_id??null,p.expires_at?dateTime(p.expires_at):null,a.kind,now());
      // Beliefs proposed in the same run do not advance the input revision; decisions snapshot them.
      if(a.kind==='operator')this.s.invalidate(e.conversation_id,'belief_recorded');
      return {belief_id:bid};
    }
    operator(a);
    if(action==='belief.reject') {ensure(this.db.get('SELECT id FROM engagement_beliefs WHERE id=? AND engagement_id=?',p.belief_id,e.id),'Belief outside scope');this.db.run("UPDATE engagement_beliefs SET status='rejected' WHERE id=?",p.belief_id);this.s.invalidate(e.conversation_id,'belief_rejected');return {rejected:true};}
    if(action==='engagement.update') {
      this.assertFresh(e,p,a);this.db.run('UPDATE engagements SET topic=?,current_need=?,unknowns_json=?,close_condition=? WHERE id=?',requiredText(p.topic??e.topic,'topic',500),requiredText(p.current_need??e.current_need,'need',2000),JSON.stringify(texts(p.unknowns??parse(e.unknowns_json))),requiredText(p.close_condition??e.close_condition,'close condition',2000),e.id);
      this.s.invalidate(e.conversation_id,'engagement_updated');return {updated:true};
    }
    if(action==='engagement.wake') {ensure(!['CLOSED','STOPPED'].includes(e.status),'Closed engagement',409);ensure(WAIT_EVENTS.includes(p.event),'Unknown wake event');requiredText(p.evidence,'wake evidence',4000);this.s.invalidate(e.conversation_id,p.event);return this.signal(this.get(e.id),p.event,{evidence:p.evidence});}
    if(action==='engagement.close') {
      ensure(!this.db.get("SELECT d.id FROM drafts d JOIN engagement_actions a ON a.draft_id=d.id JOIN engagement_decisions ed ON ed.id=a.decision_id WHERE ed.engagement_id=? AND d.status IN ('sending','delivery_unknown')",e.id),'Reconcile delivery before closing',409);
      requiredText(p.evidence,'close evidence',4000);this.s.invalidate(e.conversation_id,'engagement_closed');this.cancelTasks(e.conversation_id);
      this.db.run("UPDATE engagements SET status='CLOSED' WHERE id=?",e.id);
      this.db.run("UPDATE engagement_waits SET status='cancelled' WHERE engagement_id=? AND status='waiting'",e.id);
      this.db.run("UPDATE engagement_commitments SET status='cancelled',resolution_evidence=? WHERE engagement_id=? AND status IN ('open','proposed')",p.evidence,e.id);
      this.db.run("UPDATE engagement_handoffs SET status='resolved',resolution=?,resolved_at=? WHERE engagement_id=? AND status IN ('requested','accepted')",p.evidence,now(),e.id);return {closed:true};
    }
    if(action.startsWith('handoff.')) {
      const h=this.db.get('SELECT * FROM engagement_handoffs WHERE id=? AND engagement_id=?',p.handoff_id,e.id);ensure(h,'Handoff not found',404);
      if(action==='handoff.accept'){ensure(h.status==='requested','Handoff not requested',409);this.db.run("UPDATE engagement_handoffs SET status='accepted',accepted_at=? WHERE id=?",now(),h.id);return {accepted:true};}
      ensure(h.status==='accepted','Accept responsibility before resolving',409);ensure(['return','close'].includes(p.resolution),'Resolution must be return or close');const evidence=requiredText(p.evidence,'resolution evidence',4000);
      this.db.run('UPDATE engagement_handoffs SET status=?,resolution=?,resolved_at=? WHERE id=?',p.resolution==='return'?'returned':'resolved',evidence,now(),h.id);
      if(p.resolution==='close')return this.execute('engagement.close',{engagement_id:e.id,evidence},a);
      ensure(!this.s.person(this.s.conversation(e.conversation_id).person_id).suppressed,'STOP dominates handoff return',409);
      this.db.run("UPDATE conversations SET ownership='AI_OWNED' WHERE id=?",e.conversation_id);
      this.db.run("UPDATE engagements SET status='OPEN' WHERE id=?",e.id);this.s.invalidate(e.conversation_id,'handoff_returned');
      this.db.run("UPDATE engagement_waits SET status='satisfied',satisfied_by='handoff_returned' WHERE engagement_id=? AND status='waiting'",e.id);
      return this.enqueue(this.get(e.id),{type:'operator_response',handoff_id:h.id,evidence});
    }
    if(action==='commitment.record'||action==='explanation.record') {
      const m=this.db.get("SELECT * FROM messages WHERE id=? AND conversation_id=? AND direction='out'",p.source_message_id,e.conversation_id);ensure(m,'A real outbound message is required');
      const text=requiredText(p.text,'statement',2000);ensure(m.text.includes(text),'Quote must occur in the delivered message');
      if(action==='explanation.record'){this.db.run('INSERT INTO engagement_explanations VALUES(?,?,?,?,?,?)',id(),e.id,m.id,text,'operator',now());}
      else {ensure(['AI','HUMAN'].includes(p.owner),'Commitment owner required');this.db.run('INSERT INTO engagement_commitments(id,engagement_id,text,owner,status,due_at,source_message_id,created_at) VALUES(?,?,?,?,?,?,?,?)',id(),e.id,text,p.owner,'open',p.due_at?dateTime(p.due_at):null,m.id,now());}
      this.s.invalidate(e.conversation_id,action);return {recorded:true};
    }
    if(action==='commitment.resolve') {
      ensure(['fulfilled','cancelled'].includes(p.status),'Invalid resolution');const evidence=requiredText(p.evidence,'resolution evidence',4000);
      const c=this.db.get('SELECT * FROM engagement_commitments WHERE id=? AND engagement_id=?',p.commitment_id,e.id);ensure(c&&['open','proposed'].includes(c.status),'Commitment not open',409);
      ensure(c.status==='open'||p.status==='cancelled','A proposed promise cannot be fulfilled',409);
      this.db.run('UPDATE engagement_commitments SET status=?,resolution_evidence=? WHERE id=?',p.status,evidence,c.id);this.s.invalidate(e.conversation_id,'commitment_resolved');return {status:p.status};
    }
    throw new Error('Unhandled engagement command');
  }
  permissionCommand(action,p,a) {
    operator(a);const c=this.s.conversation(p.conversation_id),person=this.s.person(c.person_id);
    if(action==='permission.grant') {
      ensure(!person.suppressed,'Resume contact explicitly before granting permission',409);
      ensure(['reply','follow_up'].includes(p.purpose),'Permission purpose required');
      const from=dateTime(p.valid_from),to=dateTime(p.expires_at);ensure(to>from&&to>now(),'Permission interval invalid');
      const grant=id(),identity=c.channel_identity_id?this.db.get('SELECT * FROM channel_identities WHERE id=?',c.channel_identity_id):null;
      this.db.run('INSERT INTO contact_permissions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',grant,this.s.config.partnerId,person.id,c.id,c.channel,identity?.account_id??null,p.purpose,requiredText(p.granted_by,'grantor',500),requiredText(p.evidence,'permission evidence',4000),from,to,null,now());
      this.s.invalidate(c.id,'typed_permission_granted');this.permissionSignal(c.id);return {permission_id:grant};
    }
    const grant=this.db.get('SELECT * FROM contact_permissions WHERE id=? AND conversation_id=?',p.permission_id,c.id);ensure(grant,'Permission not found',404);requiredText(p.evidence,'revocation evidence',4000);
    this.db.run('UPDATE contact_permissions SET revoked_at=COALESCE(revoked_at,?) WHERE id=?',now(),grant.id);this.s.invalidate(c.id,'typed_permission_revoked');this.permissionSignal(c.id);return {revoked:true};
  }
  permissionSignal(cid) {
    const e=this.current(cid);
    if(e&&this.db.get("SELECT decision_id FROM engagement_waits WHERE engagement_id=? AND status='waiting' AND EXISTS (SELECT 1 FROM json_each(events_json) WHERE value='permission_changed')",e.id))this.signal(e,'permission_changed');
  }
  learning(action,p,a) {
    if(action==='learning.propose') {
      const e=this.get(p.engagement_id);this.s.assertScope(a,e.conversation_id);
      if(a.kind==='agent')this.assertFresh(e,p,a);
      const outcomes=list(p.outcome_ids??[]);ensure(outcomes.length,'Observed linked outcomes are required');
      for(const oid of outcomes)ensure(this.db.get('SELECT o.id FROM outcome_events o JOIN decision_outcomes d ON d.outcome_id=o.id JOIN engagement_decisions ed ON ed.id=d.decision_id WHERE o.id=? AND ed.engagement_id=?',oid,e.id),'Outcome not linked to this engagement');
      const lid=id();this.db.run('INSERT INTO lessons(id,partner_id,conversation_id,title,text,applicability,evidence,author,run_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',lid,e.partner_id,e.conversation_id,requiredText(p.title,'title',200),requiredText(p.text,'candidate guidance',8000),requiredText(p.applicability,'applicability',2000),JSON.stringify(outcomes),a.kind,a.runId??null,now());
      for(const oid of new Set(outcomes))this.db.run('INSERT INTO learning_episodes VALUES(?,?,?)',lid,oid,'evidence');return {lesson_id:lid,status:'candidate'};
    }
    operator(a);const lesson=this.db.get('SELECT * FROM lessons WHERE id=? AND partner_id=?',p.lesson_id,this.s.config.partnerId);
    ensure(lesson&&this.db.get('SELECT lesson_id FROM learning_episodes WHERE lesson_id=?',lesson.id),'Not a controlled-learning candidate');
    ensure(['activate','reject','retire'].includes(p.decision),'Invalid learning review');
    const evaluation=requiredText(p.evaluation,'evaluation',6000),limitations=requiredText(p.limitations,'limitations and uncertainty',4000);
    for(const oid of list(p.counterexample_ids??[])) {
      ensure(this.db.get('SELECT o.id FROM outcome_events o JOIN decision_outcomes d ON d.outcome_id=o.id WHERE o.id=? AND o.conversation_id=?',oid,lesson.conversation_id),'Counterexample must be a linked local outcome');
      ensure(!this.db.get('SELECT lesson_id FROM learning_episodes WHERE lesson_id=? AND outcome_id=?',lesson.id,oid),'Outcome already used');
      this.db.run('INSERT INTO learning_episodes VALUES(?,?,?)',lesson.id,oid,'counterexample');
    }
    const review=id();this.db.run('INSERT INTO learning_reviews VALUES(?,?,?,?,?,?,?)',review,lesson.id,p.decision,evaluation,limitations,'operator',now());
    this.db.run("UPDATE engagement_strategies SET status='retired' WHERE lesson_id=? AND status='active'",lesson.id);
    this.db.run('UPDATE lessons SET status=?,reviewed_at=? WHERE id=?',p.decision==='activate'?'active':p.decision==='reject'?'rejected':'retired',now(),lesson.id);
    let sid=null;
    if(p.decision==='activate') {
      const version=this.db.get('SELECT COALESCE(MAX(version),0)+1 AS n FROM engagement_strategies WHERE lesson_id=?',lesson.id).n;sid=id();
      this.db.run('INSERT INTO engagement_strategies VALUES(?,?,?,?,?,?,?,?,?,?)',sid,lesson.id,review,this.s.config.partnerId,lesson.conversation_id,version,lesson.text,lesson.applicability,'active',now());
    }
    this.s.invalidate(lesson.conversation_id,'strategy_reviewed');return {review_id:review,strategy_version_id:sid,scope:'conversation_only',permissions_changed:false};
  }
}
