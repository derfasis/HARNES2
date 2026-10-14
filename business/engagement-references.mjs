// Reviewed source-backed Work material can inform one private question. It remains
// an interpretation: data admission never creates contact or execution authority.
import { id } from './store.mjs';
import { ensure, requiredText, dateTime, now, AppError } from './errors.mjs';
import { digest } from './source-ingestion.mjs';
import { ActionLoop } from './actions.mjs';
import { effectiveSourceConfig } from './scout-policy.mjs';

const EFFECTS = Object.freeze({ contact_permission: false, external_write: false, causal_credit: false });
const CURSOR = 'engagement-reference-maintenance-v1';
const check = (ok, code, status = 409) => ensure(ok, code, status, code);
const fields = (p, names) => check(p && typeof p === 'object' && !Array.isArray(p)
  && Object.keys(p).every(k => names.includes(k)), 'REFERENCE_FIELDS_INVALID', 400);
const failureCode = e => e instanceof SyntaxError ? 'REFERENCE_RECORD_INVALID'
  : e instanceof AppError ? e.code : null;
export class EngagementReferences {
  constructor(service) { this.s = service; this.db = service.store; }
  get partnerId() { return this.s.config.partnerId; }
  enabled() { check(this.s.config.engagement?.enabled === true && this.s.config.workspace?.enabled === true
    && this.s.config.controlPlane?.enabled === true, 'REFERENCE_DISABLED'); }
  offerId() { return effectiveSourceConfig(this.s).opportunity?.activeOffer?.id ?? null; }
  question(e) { return this.db.get("SELECT id FROM messages WHERE conversation_id=? AND direction='in' ORDER BY created_at DESC,rowid DESC LIMIT 1", e.conversation_id)?.id ?? null; }
  get(referenceId) {
    const row = this.db.get('SELECT * FROM engagement_references WHERE id=? AND partner_id=?', referenceId, this.partnerId);
    check(row, 'REFERENCE_NOT_FOUND', 404); this.s.engagement.get(row.engagement_id); return row;
  }
  materialBasis(materialId, sha256) {
    const m = this.s.work.material(materialId), work = this.s.work.get(m.case_id);
    const material = this.s.work.materialPacket({ id: materialId, sha256 }, work.thread_id, work.basis_fingerprint);
    const packet = this.s.work.packet(work);
    const { content, ...pin } = material;
    return { material: pin, observations: ActionLoop.staticEvidence(packet.evidence),
      observed_at: packet.evidence.map(e => ({ source_event_id: e.source_event_id, observed_at: e.observed_at, published_at: e.published_at })),
      content };
  }
  checkedPacket(row) {
    const packet = JSON.parse(row.packet_json);
    check(packet && packet.schema === 'reviewed-reference-v1' && digest(packet) === row.packet_sha256
      && packet.engagement_id === row.engagement_id && packet.question_message_id === row.question_message_id
      && packet.offer_id === row.offer_id && packet.market === row.market && packet.excerpt === row.excerpt
      && packet.expires_at === row.expires_at && packet.material?.id === row.material_id
      && packet.material.sha256 === row.material_sha256 && Array.isArray(packet.observations)
      && packet.observations.length >= 1 && packet.observations.length <= 32
      && Array.isArray(packet.observed_at) && packet.observed_at.length === packet.observations.length
      && packet.observed_at.every(entry => entry && typeof entry.source_event_id==='string')
      && packet.observations.every(entry => entry && typeof entry.source_event_id==='string')
      && new Set(packet.observations.map(entry=>entry.source_event_id)).size===packet.observations.length
      && packet.observations.every(entry=>packet.observed_at.some(time=>time.source_event_id===entry.source_event_id)), 'REFERENCE_RECORD_INVALID');
    return packet;
  }
  current(row) {
    this.enabled(); check(row.status === 'active', 'REFERENCE_WITHDRAWN');
    const e = this.s.engagement.get(row.engagement_id);
    check(!['CLOSED','STOPPED'].includes(e.status), 'REFERENCE_ENGAGEMENT_CLOSED');
    check(this.question(e) === row.question_message_id, 'REFERENCE_QUESTION_CHANGED');
    check(row.offer_id === this.offerId(), 'REFERENCE_OFFER_CHANGED');
    check(Number.isFinite(Date.parse(row.expires_at)) && Date.parse(row.expires_at) > Date.now(), 'REFERENCE_EXPIRED');
    const packet = this.checkedPacket(row), fresh = this.materialBasis(row.material_id, row.material_sha256);
    check(fresh.content.includes(row.excerpt), 'REFERENCE_EXCERPT_CHANGED');
    check(digest(fresh.material) === digest(packet.material)
      && digest(fresh.observations) === digest(packet.observations)
      && digest(fresh.observed_at) === digest(packet.observed_at), 'REFERENCE_BASIS_CHANGED');
    return packet;
  }
  item(row) {
    const packet = this.current(row), policies = effectiveSourceConfig(this.s).opportunity?.browserSources ?? [];
    return { id: row.id, reference_id: row.id, engagement_id: row.engagement_id,
      material_id: row.material_id, material_sha256: row.material_sha256, title: packet.material.title,
      question_message_id: row.question_message_id, offer_id: row.offer_id, market: row.market,
      excerpt: row.excerpt, expires_at: row.expires_at, packet_sha256: row.packet_sha256,
      epistemic_status: 'reviewed_interpretation_not_verified_fact',
      sources: packet.observations.map(observation => ({ ...observation,
        ...packet.observed_at.find(e => e.source_event_id === observation.source_event_id),
        url: policies.find(policy => policy.sourceId === observation.source_ref)?.url ?? null,
        epistemic_status: 'source_observation_not_independent_verification' })), ...EFFECTS };
  }
  context(engagementId) {
    this.s.engagement.get(engagementId);
    const active = this.db.all("SELECT * FROM engagement_references WHERE partner_id=? AND engagement_id=? AND status='active' ORDER BY created_at DESC,rowid DESC LIMIT 5", this.partnerId, engagementId);
    check(active.length<=4,'REFERENCE_CAPACITY');
    const history = this.db.all("SELECT * FROM engagement_references WHERE partner_id=? AND engagement_id=? AND status<>'active' ORDER BY created_at DESC,rowid DESC LIMIT 16", this.partnerId, engagementId);
    const rows = [...active,...history];
    const items = [], unavailable = [];
    for (const row of rows) {
      if (row.status !== 'active') { unavailable.push({ id:row.id,status:row.status,reason:row.reason ?? 'REFERENCE_WITHDRAWN' }); continue; }
      try { items.push(this.item(row)); }
      catch (e) { const code = failureCode(e); if (!code) throw e; unavailable.push({ id:row.id,status:'unavailable',reason:code }); }
    }
    check(items.length <= 4, 'REFERENCE_CAPACITY');
    return { items, unavailable, basis_fingerprint: digest(items.map(item => [item.id,item.packet_sha256])), ...EFFECTS };
  }
  assertFrozen(engagementId, frozen) {
    if (!frozen) return; // Legacy runs have no referenced research dependency.
    check(frozen && Array.isArray(frozen.items) && frozen.items.length <= 4
      && frozen.basis_fingerprint === digest(frozen.items.map(item => [item.id,item.packet_sha256])), 'REFERENCE_SNAPSHOT_INVALID');
    for (const item of frozen.items) {
      const row = this.get(item.id); check(row.engagement_id === engagementId, 'REFERENCE_SCOPE_MISMATCH');
      check(digest(this.item(row)) === digest(item), 'REFERENCE_BASIS_CHANGED');
    }
  }
  evidence(e, referenceId) { const row = this.get(referenceId); check(row.engagement_id === e.id, 'REFERENCE_SCOPE_MISMATCH'); return this.item(row); }
  beliefCurrent(engagementId,refs) {
    for(const ref of refs.filter(ref=>ref.type==='reference')) {
      try { const row=this.get(ref.id); check(row.engagement_id===engagementId,'REFERENCE_SCOPE_MISMATCH'); this.current(row); }
      catch(error) { if(!failureCode(error))throw error; return false; }
    }
    return true;
  }
  retire(row,status,reason) {
    this.db.run('UPDATE engagement_references SET status=?,reason=?,retired_at=? WHERE id=?',status,reason,now(),row.id);
    this.db.run(`UPDATE engagement_beliefs SET status='stale' WHERE engagement_id=? AND status='current' AND
      (EXISTS(SELECT 1 FROM json_each(evidence_json) j WHERE j.value->>'$.type'='reference' AND j.value->>'$.id'=?)
      OR EXISTS(SELECT 1 FROM json_each(counterevidence_json) j WHERE j.value->>'$.type'='reference' AND j.value->>'$.id'=?))`,row.engagement_id,row.id,row.id);
  }
  materials(engagementId) {
    this.enabled(); const e = this.s.engagement.get(engagementId), items = [];
    const rows = this.db.all(`SELECT m.id FROM work_materials m JOIN work_cases w ON w.id=m.case_id
      WHERE w.partner_id=? AND w.status='open' AND m.status='approved' AND w.material_id=m.id
      ORDER BY m.created_at DESC,m.id LIMIT 20`, this.partnerId);
    for (const row of rows) {
      try { const m = this.s.work.material(row.id); this.materialBasis(m.id,m.sha256);
        items.push({ material_id:m.id,sha256:m.sha256,title:m.title,content:m.content,evidence_event_ids:m.evidence_event_ids }); }
      catch(error) { if (!failureCode(error)) throw error; }
    }
    return { items, question_message_id: this.question(e), offer_id: this.offerId(), ...EFFECTS };
  }
  command(action, p, actor) {
    check(actor?.kind === 'operator', 'REFERENCE_OPERATOR_REQUIRED', 403); this.enabled();
    const e = this.s.engagement.get(p.engagement_id);
    this.s.active(e.conversation_id); check(!['CLOSED','STOPPED'].includes(e.status), 'REFERENCE_ENGAGEMENT_CLOSED');
    check(Number.isInteger(p.expected_revision) && p.expected_revision === e.revision, 'REFERENCE_REVISION_CONFLICT');
    if (action === 'reference.revoke') {
      fields(p,['engagement_id','expected_revision','reference_id','reason']); const row = this.get(p.reference_id);
      check(row.engagement_id === e.id && row.status === 'active', 'REFERENCE_SCOPE_MISMATCH');
      const reason = requiredText(p.reason,'revocation reason',2000);
      this.retire(row,'revoked',reason);
      this.changed(e,'reference_revoked'); return { reference_id:row.id,status:'revoked', ...EFFECTS };
    }
    fields(p,['engagement_id','expected_revision','material_id','material_sha256','question_message_id','offer_id','market','excerpt','expires_at','note']);
    check(typeof p.offer_id === 'string' && p.offer_id === this.offerId(), 'REFERENCE_OFFER_CHANGED');
    check(typeof p.market === 'string' && /^[A-Z]{2}$/.test(p.market), 'REFERENCE_MARKET_INVALID',400);
    check(typeof p.excerpt === 'string' && p.excerpt.trim() && p.excerpt.length <= 8000, 'REFERENCE_EXCERPT_INVALID',400);
    const deadline = dateTime(p.expires_at), delta = Date.parse(deadline)-Date.now();
    check(delta > 0 && delta <= 7*86400000, 'REFERENCE_DEADLINE_INVALID',400);
    check(p.question_message_id === this.question(e), 'REFERENCE_QUESTION_CHANGED');
    check(typeof p.question_message_id==='string' && p.question_message_id.length>0,'REFERENCE_QUESTION_CHANGED');
    // A bounded grant catalogue, distinct from presentation history. Expired/changed
    // questions are withdrawn before admitting another reference; no resurrection.
    const prior = this.db.all("SELECT * FROM engagement_references WHERE partner_id=? AND engagement_id=? AND status='active' LIMIT 5",this.partnerId,e.id);
    check(prior.length<=4,'REFERENCE_CAPACITY');
    for(const row of prior) {
      try { this.current(row); }
      catch(error) { const code=failureCode(error); if(!code)throw error;
        this.retire(row,code==='REFERENCE_RECORD_INVALID'?'quarantined':'stale',code);
      }
    }
    const current = this.context(e.id).items;
    check(current.length < 4, 'REFERENCE_CAPACITY');
    check(current.every(row => row.market === p.market && row.offer_id === p.offer_id), 'REFERENCE_SCOPE_CONFLICT');
    check(!current.some(row => row.material_id === p.material_id && row.excerpt === p.excerpt), 'REFERENCE_DUPLICATE');
    const basis = this.materialBasis(p.material_id,p.material_sha256);
    check(basis.content.includes(p.excerpt), 'REFERENCE_EXCERPT_INVALID',400);
    const note = requiredText(p.note,'reference admission note',2000), referenceId = id();
    const { content, ...provenance } = basis;
    const packet = { schema:'reviewed-reference-v1',engagement_id:e.id,question_message_id:p.question_message_id,
      offer_id:p.offer_id,market:p.market,excerpt:p.excerpt,expires_at:deadline,...provenance };
    this.db.run(`INSERT INTO engagement_references(id,partner_id,engagement_id,material_id,material_sha256,
      question_message_id,offer_id,market,excerpt,expires_at,note,packet_json,packet_sha256,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?)`,referenceId,this.partnerId,e.id,p.material_id,p.material_sha256,
      p.question_message_id,p.offer_id,p.market,p.excerpt,deadline,note,JSON.stringify(packet),digest(packet),now());
    this.changed(e,'reference_attached'); return { reference_id:referenceId,status:'active', ...EFFECTS };
  }
  changed(e,reason) { this.s.invalidate(e.conversation_id,reason); this.s.engagement.signal(this.s.engagement.get(e.id),'operator_response',{reason}); }
  reconcile({ limit=20 }={}) {
    check(Number.isInteger(limit) && limit>=1 && limit<=50,'REFERENCE_LIMIT_INVALID',400);
    const cursor = this.db.get('SELECT cursor FROM channel_offsets WHERE channel=? AND account_id=?',CURSOR,this.partnerId)?.cursor ?? '';
    const page = (after,take,before=null) => this.db.all(`SELECT * FROM engagement_references WHERE partner_id=? AND status='active' AND id>?
      ${before ? 'AND id<=?' : ''} ORDER BY id LIMIT ?`,this.partnerId,after,...(before?[before]:[]),take);
    let rows = page(cursor,limit); if(cursor && rows.length<limit) rows=rows.concat(page('',limit-rows.length,cursor));
    const changed = new Map(); let retired=0;
    for (const row of rows) {
      try { this.current(row); }
      catch(error) { const code=failureCode(error); if(!code)throw error;
        // Disabled features merely withhold content. Startup/configuration is not source evidence.
        if(code==='REFERENCE_DISABLED')continue;
        this.retire(row,code==='REFERENCE_RECORD_INVALID'?'quarantined':'stale',code);
        const e=this.db.get('SELECT * FROM engagements WHERE id=? AND partner_id=?',row.engagement_id,this.partnerId);
        if(e && !['CLOSED','STOPPED'].includes(e.status)) changed.set(e.id,e); retired++;
      }
    }
    for(const e of changed.values())this.changed(e,'reference_basis_stale');
    if(rows.length)this.db.run('INSERT INTO channel_offsets VALUES(?,?,?) ON CONFLICT(channel,account_id) DO UPDATE SET cursor=excluded.cursor',CURSOR,this.partnerId,rows.at(-1).id);
    return {checked:rows.length,retired};
  }
}
