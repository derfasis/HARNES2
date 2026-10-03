// Associations and immutable ready materials. Domain truth remains in its existing owners.
import { id, hash } from './store.mjs';
import { ensure, requiredText, dateTime, now, AppError } from './errors.mjs';
import { digest, sourceRows, sourceAccessReadiness, sourceEvent } from './source-ingestion.mjs';
import { ActionLoop } from './actions.mjs';
import { effectiveSourceConfig } from './scout-policy.mjs';

const check = (ok, code, status = 409) => ensure(ok, code, status, code);
const fields = (p, keys) => check(p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).every(k => keys.includes(k)), 'WORK_FIELDS_INVALID', 400);
const EFFECTS = Object.freeze({ contact_permission: false, external_write: false, causal_credit: false });
const CURSOR = 'workspace-reconcile-v1';
export class WorkCore {
  constructor(service) { this.service = service; this.db = service.store; }
  get partnerId() { return this.service.config.partnerId; }
  enabled() { check(this.service.config.workspace?.enabled === true && this.service.config.controlPlane?.enabled === true, 'WORKSPACE_DISABLED'); }
  get(caseId) { const row = this.db.get('SELECT * FROM work_cases WHERE id=? AND partner_id=?', caseId, this.partnerId); check(row, 'WORK_NOT_FOUND', 404); return row; }
  record(kind, data, actor = 'operator') { this.db.event(this.partnerId, null, `work.${kind}`, actor, data); }
  update(row, patch) { this.db.run(`UPDATE work_cases SET ${Object.keys(patch).map(k => `${k}=?`).join(',')},revision=revision+1,updated_at=? WHERE id=?`, ...Object.values(patch), now(), row.id); }
  basis(threadId) { try { return this.service.actions.basis(threadId); } catch (e) { if (!(e instanceof AppError)) throw e; throw new AppError('WORK_STALE_BASIS', 409, 'WORK_STALE_BASIS'); } }
  current(row) {
    check(row.status === 'open', 'WORK_STALE_BASIS'); const d = this.basis(row.thread_id);
    check(d.basis_fingerprint === row.basis_fingerprint && d.memory.turn_id === row.turn_id, 'WORK_STALE_BASIS');
    const packet = this.packet(row), c = this.service.continuity;
    const states = c.evidenceStates(c.thread(row.thread_id), c.watches(row.thread_id), packet.evidence.map(e => e.source_event_id));
    check(packet.evidence.every(e => states.get(e.source_event_id)?.current), 'WORK_STALE_BASIS');
    const fresh = this.service.actions.packet(d);
    check(digest(ActionLoop.staticEvidence(packet.evidence)) === digest(ActionLoop.staticEvidence(fresh.evidence))
      && digest(packet.interpretation) === digest(fresh.interpretation), 'WORK_RECORD_INVALID');
    return d;
  }
  packet(row) {
    const packet = JSON.parse(row.packet_json);
    check(packet?.thread_id === row.thread_id && packet.turn_id === row.turn_id && packet.basis_fingerprint === row.basis_fingerprint
      && Array.isArray(packet.evidence) && packet.evidence.length > 0 && packet.evidence.every(e => e && typeof e.source_event_id === 'string'), 'WORK_RECORD_INVALID');
    return packet;
  }
  material(idValue) {
    const m = this.db.get('SELECT m.* FROM work_materials m JOIN work_cases w ON w.id=m.case_id WHERE m.id=? AND w.partner_id=?', idValue, this.partnerId);
    check(m, 'WORK_MATERIAL_NOT_FOUND', 404);
    const { evidence_json, ...rest } = m; return { ...rest, evidence_event_ids: JSON.parse(evidence_json) };
  }
  materialPacket(ref, threadId, basisFingerprint) {
    fields(ref, ['id','sha256']); const m = this.material(ref.id), row = this.get(m.case_id); this.enabled(); this.current(row);
    check(row.thread_id === threadId && row.basis_fingerprint === basisFingerprint && m.basis_fingerprint === basisFingerprint, 'WORK_STALE_BASIS');
    check(row.material_id === m.id, 'WORK_MATERIAL_SUPERSEDED'); check(m.status === 'approved', 'WORK_MATERIAL_REVIEW_REQUIRED');
    check(m.sha256 === ref.sha256 && hash(Buffer.from(m.content, 'utf8')) === m.sha256, 'WORK_MATERIAL_HASH_MISMATCH');
    return { id: m.id, case_id: m.case_id, version: m.version, title: m.title, format: m.format, content: m.content, sha256: m.sha256,
      evidence_event_ids: m.evidence_event_ids, thread_id: row.thread_id, basis_fingerprint: m.basis_fingerprint, turn_id: m.turn_id };
  }
  assertMaterial(packet, threadId, basisFingerprint) {
    check(packet && digest(packet) === digest(this.materialPacket({ id: packet.id, sha256: packet.sha256 }, threadId, basisFingerprint)), 'WORK_MATERIAL_CHANGED');
  }
  detail(caseId) {
    const row = this.get(caseId), packet = this.packet(row); let current = false, reason = row.reason;
    try { this.current(row); current = true; } catch (e) { if (!(e instanceof AppError)) throw e; reason = e.code; }
    const materials = this.db.all('SELECT id FROM work_materials WHERE case_id=? ORDER BY version DESC LIMIT 50', row.id).map(m => this.material(m.id));
    const material = materials.find(m => m.id === row.material_id) ?? null;
    const request = this.db.get('SELECT id,status,reason,run_id,material_id,created_at,finished_at FROM work_material_requests WHERE case_id=? AND basis_fingerprint=? ORDER BY created_at DESC LIMIT 1', row.id, row.basis_fingerprint) ?? null;
    const action = row.action_id ? this.service.actions.detail(row.action_id) : null;
    const er = this.db.get('SELECT * FROM work_expectations WHERE case_id=? ORDER BY rowid DESC LIMIT 1', row.id);
    const expectation = er ? { ...er, observations: JSON.parse(er.observations_json), ...EFFECTS, coverage: 'bounded_observations_not_complete_history' } : null;
    let next_move = 'prepare_material';
    if (row.status === 'closed') next_move = 'closed'; else if (!current) next_move = 'review_new_evidence';
    else if (material?.status === 'proposed') next_move = 'review_material';
    else if (material?.status === 'approved') next_move = !action ? 'prepare_local_action' : action.status === 'proposed' ? 'owner_grant_required'
      : ['authorized','verifying'].includes(action.status) ? 'execute_or_verify' : action.status === 'completed' ? expectation?.action_id === action.id ? 'observe_and_continue' : 'define_expectation' : 'owner_recovery_required';
    else if (!material && request) next_move = ['pending','running'].includes(request.status) ? 'wait_material' : 'owner_recovery_required';
    const { packet_json, ...rest } = row;
    let currentBasis = null; try { currentBasis = this.basis(row.thread_id).basis_fingerprint; } catch (e) { if (!(e instanceof AppError)) throw e; }
    return { ...rest, current, reason, evidence_event_ids: packet.evidence.map(e => e.source_event_id), material, materials, request, action, expectation,
      current_basis_fingerprint: currentBasis, observations: expectation?.observations ?? [], next_move, ...EFFECTS };
  }
  presentation(caseId) {
    try { return this.detail(caseId); }
    catch (e) {
      if (!(e instanceof SyntaxError) && !(e instanceof AppError)) throw e;
      const row = this.get(caseId);
      return { id: row.id, thread_id: row.thread_id, title: row.title, revision: row.revision, status: 'quarantined', current: false,
        reason: 'WORK_RECORD_INVALID', material: null, materials: [], action: null, expectation: null, observations: [], next_move: 'owner_recovery_required', ...EFFECTS };
    }
  }
  snapshot({ limit = 20, cursor = '' } = {}) {
    check(Number.isInteger(limit) && limit >= 1 && limit <= 50 && typeof cursor === 'string' && (cursor === '' || /^[0-9a-f-]{36}$/i.test(cursor)), 'WORK_PAGE_INVALID', 400);
    const rows = this.db.all('SELECT id FROM work_cases WHERE partner_id=? AND id>? ORDER BY id LIMIT ?', this.partnerId, cursor, limit + 1);
    return { enabled: this.service.config.workspace?.enabled === true, model_enabled: this.service.config.workspace?.modelEnabled === true,
      source_refs: (effectiveSourceConfig(this.service).opportunity?.allowedSourceRefs ?? []).slice(0, 100), goals: this.service.continuity.list({ limit: 50 }).items.map(g => this.service.continuity.detail(g.id)),
      cases: rows.slice(0, limit).map(r => this.presentation(r.id)), next_cursor: rows.length > limit ? rows[limit - 1].id : null, control: this.service.control.status(), ...EFFECTS };
  }
  addMaterial(row, p, producer = 'operator', runId = null) {
    this.current(row); const title = requiredText(p.title, 'title', 200);
    // Preserve exact content bytes; validation must not trim the ready material.
    check(typeof p.content === 'string' && p.content.trim() && Buffer.byteLength(p.content, 'utf8') <= 32000, 'WORK_CONTENT_INVALID', 400);
    const ids = p.evidence_event_ids, packet = JSON.parse(row.packet_json);
    check(Array.isArray(ids) && ids.length >= 1 && ids.length <= 32 && new Set(ids).size === ids.length
      && ids.every(ref => typeof ref === 'string' && packet.evidence.some(e => e.source_event_id === ref)), 'WORK_EVIDENCE_INVALID', 400);
    const version = this.db.get('SELECT COALESCE(MAX(version),0)+1 n FROM work_materials WHERE case_id=?', row.id).n;
    check(version <= 50, 'WORK_MATERIAL_LIMIT'); const materialId = id(), sha256 = hash(Buffer.from(p.content, 'utf8'));
    this.db.run("UPDATE work_materials SET status='superseded' WHERE case_id=? AND status IN ('approved','proposed')", row.id);
    if (row.action_id) this.service.actions.invalidate(this.service.actions.get(row.action_id), 'WORK_MATERIAL_SUPERSEDED');
    this.db.run(`INSERT INTO work_materials(id,case_id,version,title,format,content,sha256,evidence_json,turn_id,basis_fingerprint,status,producer,run_id,created_at)
      VALUES(?,?,?,?,'text/markdown',?,?,?,?,?,'proposed',?,?,?)`, materialId, row.id, version, title, p.content, sha256, JSON.stringify(ids), row.turn_id, row.basis_fingerprint, producer, runId, now());
    this.update(row, { material_id: materialId, action_id: null }); this.record('material_proposed', { case_id: row.id, material_id: materialId, version, sha256, producer }, producer);
    return { case_id: row.id, material_id: materialId, sha256, ...EFFECTS };
  }
  command(action, p, actor) {
    check(actor?.kind === 'operator', 'WORK_OPERATOR_REQUIRED', 403); this.enabled();
    if (action === 'work.goal') { fields(p, ['title','objective','success_condition','source_ids','max_age_seconds']); return this.service.continuity.open(p); }
    if (action === 'work.open') {
      fields(p, ['thread_id','expected_basis_fingerprint','title']); const d = this.basis(p.thread_id);
      check(d.basis_fingerprint === p.expected_basis_fingerprint, 'WORK_STALE_BASIS');
      const old = this.db.get('SELECT id FROM work_cases WHERE thread_id=? AND turn_id=?', d.id, d.memory.turn_id);
      if (old) return { case_id: old.id, duplicate: true, ...EFFECTS };
      check(this.db.get("SELECT COUNT(*) n FROM work_cases WHERE partner_id=? AND status<>'closed'", this.partnerId).n < 200, 'WORK_CAPACITY');
      const caseId = id(); this.db.run(`INSERT INTO work_cases(id,partner_id,thread_id,title,turn_id,basis_fingerprint,packet_json,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'open',?,?)`, caseId, this.partnerId, d.id, requiredText(p.title, 'title', 200), d.memory.turn_id, d.basis_fingerprint, JSON.stringify(this.service.actions.packet(d)), now(), now());
      this.record('opened', { case_id: caseId, thread_id: d.id, turn_id: d.memory.turn_id }); return { case_id: caseId, ...EFFECTS };
    }
    const row = this.get(p.case_id); check(row.revision === p.expected_revision, 'WORK_REVISION_CONFLICT');
    if (action === 'work.close') {
      fields(p, ['case_id','expected_revision','reason']); check(row.status !== 'closed', 'WORK_CLOSED');
      if (row.action_id) this.service.actions.invalidate(this.service.actions.get(row.action_id), 'WORK_CLOSED');
      this.db.run("UPDATE work_materials SET status='stale' WHERE case_id=? AND status IN ('approved','proposed')", row.id);
      this.db.run("UPDATE work_material_requests SET status='stale' WHERE case_id=? AND status IN ('pending','running')", row.id);
      this.db.run("UPDATE work_expectations SET status='revoked',reason='WORK_CLOSED' WHERE case_id=? AND status IN ('pending','evidence_observed')", row.id);
      this.update(row, { status: 'closed', reason: requiredText(p.reason, 'reason', 2000) });
    } else if (action === 'work.refresh') {
      fields(p, ['case_id','expected_revision','expected_basis_fingerprint']); check(row.status !== 'closed', 'WORK_CLOSED');
      const d = this.basis(row.thread_id); check(d.basis_fingerprint === p.expected_basis_fingerprint, 'WORK_STALE_BASIS');
      check(d.basis_fingerprint !== row.basis_fingerprint, 'WORK_UNCHANGED');
      if (row.action_id) this.service.actions.invalidate(this.service.actions.get(row.action_id), 'WORK_BASIS_CHANGED');
      this.db.run("UPDATE work_materials SET status='stale' WHERE case_id=? AND status IN ('approved','proposed')", row.id);
      this.db.run("UPDATE work_material_requests SET status='stale' WHERE case_id=? AND status IN ('pending','running')", row.id);
      this.update(row, { status: 'open', turn_id: d.memory.turn_id, basis_fingerprint: d.basis_fingerprint, packet_json: JSON.stringify(this.service.actions.packet(d)), material_id: null, action_id: null, reason: null });
    } else {
      this.current(row);
      if (action === 'work.material') { fields(p, ['case_id','expected_revision','title','content','evidence_event_ids']); return this.addMaterial(row, p); }
      if (action === 'work.request_material') {
        fields(p, ['case_id','expected_revision']); check(this.service.config.workspace.modelEnabled === true, 'WORK_MODEL_DISABLED');
        const old = this.db.get('SELECT id FROM work_material_requests WHERE case_id=? AND basis_fingerprint=?', row.id, row.basis_fingerprint);
        if (old) return { request_id: old.id, duplicate: true, ...EFFECTS };
        const requestId = id(); this.db.run("INSERT INTO work_material_requests(id,case_id,basis_fingerprint,case_revision,packet_json,status,created_at) VALUES(?,?,?,?,?,'pending',?)", requestId, row.id, row.basis_fingerprint, row.revision, row.packet_json, now());
        this.record('material_requested', { case_id: row.id, request_id: requestId }); return { request_id: requestId, ...EFFECTS };
      }
      if (action === 'work.review') {
        fields(p, ['case_id','expected_revision','material_id','sha256','decision','note']); const m = this.material(p.material_id);
        check(row.material_id === m.id && m.case_id === row.id && m.status === 'proposed', 'WORK_MATERIAL_SUPERSEDED');
        check(m.sha256 === p.sha256 && m.sha256 === hash(Buffer.from(m.content, 'utf8')), 'WORK_MATERIAL_HASH_MISMATCH');
        check(['approve','reject'].includes(p.decision), 'WORK_REVIEW_INVALID', 400);
        this.db.run('UPDATE work_materials SET status=?,review_note=?,reviewed_at=? WHERE id=?', p.decision === 'approve' ? 'approved' : 'rejected', requiredText(p.note, 'note', 2000), now(), m.id);
        this.update(row, { reason: null }); this.record('material_reviewed', { case_id: row.id, material_id: m.id, sha256: m.sha256, decision: p.decision });
      } else if (action === 'work.prepare_action') {
        fields(p, ['case_id','expected_revision','material_id','capability_id']);
        const m = this.material(p.material_id); this.materialPacket({ id: m.id, sha256: m.sha256 }, row.thread_id, row.basis_fingerprint);
        check(['material.export_local.v1','owner_handoff.create.v1'].includes(p.capability_id), 'WORK_CAPABILITY_DENIED', 403);
        const proposal = { capability_id: p.capability_id, title: m.title, instructions: p.capability_id === 'material.export_local.v1' ? 'Export the exact reviewed ready material for owner inspection.' : `Review ready material ${m.id} (SHA256 ${m.sha256}) in Workspace; any external publication requires your own separate authority.`, expected_result: 'Local result only; external publication and response are not verified.', due_at: null,
          ...(p.capability_id === 'material.export_local.v1' ? { material: { id: m.id, sha256: m.sha256 } } : {}) };
        const a = this.service.actions.create({ thread_id: row.thread_id, expected_basis_fingerprint: row.basis_fingerprint, reason: 'Owner prepared scoped Workspace material', proposal });
        this.update(row, { action_id: a.action_id }); this.record('action_proposed', { case_id: row.id, action_id: a.action_id, material_id: m.id }); return { case_id: row.id, action_id: a.action_id, ...EFFECTS };
      } else if (action === 'work.expect') {
        fields(p, ['case_id','expected_revision','question','deadline']); const a = row.action_id && this.service.actions.detail(row.action_id);
        check(a?.status === 'completed' && !a.verify_requested && this.service.actions.latest(this.service.actions.get(a.id))?.verification_state === 'present' && a.current, 'WORK_VERIFIED_ACTION_REQUIRED');
        const deadline = dateTime(p.deadline), delta = Date.parse(deadline) - Date.now(); check(delta >= 1000 && delta <= 2592000000, 'WORK_DEADLINE_INVALID', 400);
        const sources = [...new Set(JSON.parse(row.packet_json).evidence.map(e => e.source_ref))]; check(sources.length === 1, 'WORK_EXPECT_SINGLE_SOURCE');
        check(!this.db.get('SELECT id FROM work_expectations WHERE case_id=? AND action_id=?', row.id, a.id), 'WORK_EXPECT_DUPLICATE');
        this.db.run("UPDATE work_expectations SET status='revoked',reason='EXPECTATION_REPLACED' WHERE case_id=? AND status IN ('pending','evidence_observed')", row.id);
        this.db.run("INSERT INTO work_expectations(id,case_id,action_id,source_ref,question,opened_at,deadline,cursor,status,updated_at) VALUES(?,?,?,?,?,?,?,?,'pending',?)", id(), row.id, a.id, sources[0], requiredText(p.question, 'question', 2000), now(), deadline, this.service.continuity.head(sources[0]), now());
        this.update(row, { reason: null });
      } else check(false, 'WORK_COMMAND_UNKNOWN', 400);
    }
    return { case_id: row.id, ...EFFECTS };
  }
  reconcile(limit = 20, eventLimit = 20) {
    check(Number.isInteger(limit) && limit >= 1 && limit <= 50 && Number.isInteger(eventLimit) && eventLimit >= 1 && eventLimit <= 50, 'WORK_RECONCILE_INVALID');
    return this.db.transaction(() => {
      const cursor = this.db.get('SELECT cursor FROM channel_offsets WHERE channel=? AND account_id=?', CURSOR, this.partnerId)?.cursor ?? '';
      const page = (after, take, before = null) => this.db.all(`SELECT * FROM work_cases WHERE partner_id=? AND status<>'closed' AND id>? ${before ? 'AND id<=?' : ''} ORDER BY id LIMIT ?`, this.partnerId, after, ...(before ? [before] : []), take);
      let rows = page(cursor, limit); if (cursor && rows.length < limit) rows = rows.concat(page('', limit - rows.length, cursor));
      for (const row of rows) {
        try {
          const e = this.db.get("SELECT * FROM work_expectations WHERE case_id=? AND status IN ('pending','evidence_observed') ORDER BY rowid DESC LIMIT 1", row.id);
          if (e) {
            check(Number.isFinite(Date.parse(e.opened_at)) && Number.isFinite(Date.parse(e.deadline)) && Date.parse(e.deadline) > Date.parse(e.opened_at)
              && Number.isSafeInteger(e.cursor) && e.cursor >= 0, 'WORK_RECORD_INVALID');
            const access = sourceAccessReadiness(this.service, e.source_ref);
            let status = e.status, reason = e.reason, nextCursor = e.cursor, reachedDeadline = false, observations = JSON.parse(e.observations_json);
            check(Array.isArray(observations) && observations.length <= 20, 'WORK_RECORD_INVALID');
            if (!access.current && access.reason === 'SOURCE_NOT_ALLOWED') { status = 'revoked'; reason = 'SOURCE_NOT_ALLOWED'; }
            else if (access.current && !(e.status === 'evidence_observed' && Date.parse(e.deadline) <= Date.now())) {
              const incoming = this.db.all("SELECT id FROM events WHERE partner_id=? AND kind='source.message' AND actor='system' AND payload_json->>'$.source_id'=? AND id>? ORDER BY id LIMIT ?", this.partnerId, e.source_ref, e.cursor, eventLimit);
              for (const item of incoming) {
                const src = sourceEvent(this.service, String(item.id)), latest = sourceRows(this.service, e.source_ref, [src.message.message_id])[0];
                if (Date.parse(src.observed_at) > Date.parse(e.deadline)) reachedDeadline = true;
                if (latest?.event_id === String(item.id) && src.message.operation === 'upsert' && src.message.text?.trim()
                  && Date.parse(src.observed_at) >= Date.parse(e.opened_at) && Date.parse(src.observed_at) <= Date.parse(e.deadline)) {
                  observations.push({ source_event_id: String(item.id), observed_at: src.observed_at, association: 'source_change_after_local_action', causal_credit: false }); status = 'evidence_observed';
                }
                nextCursor = item.id;
              }
            }
            if (status === 'pending' && Date.parse(e.deadline) <= Date.now()
              && (!access.current || reachedDeadline || nextCursor >= this.service.continuity.head(e.source_ref))) {
              status = 'unknown'; reason = 'COVERAGE_NOT_ESTABLISHED';
            }
            this.db.run('UPDATE work_expectations SET status=?,reason=?,cursor=?,observations_json=?,updated_at=? WHERE id=?', status, reason, nextCursor, JSON.stringify(observations.slice(-20)), now(), e.id);
          }
          if (row.status === 'open') {
            // Scoped audience backlog/outage withholds use now; it does not permanently
            // destroy an unchanged approved material. current() still blocks every effect.
            if (this.service.audience?.temporaryWorkBlock(row.thread_id)) continue;
            try { this.current(row); } catch (error) {
              if (!(error instanceof AppError)) throw error;
              this.db.run("UPDATE work_materials SET status='stale' WHERE case_id=? AND status IN ('approved','proposed')", row.id);
              this.db.run("UPDATE work_material_requests SET status='stale' WHERE case_id=? AND status IN ('pending','running')", row.id);
              if (row.action_id) this.service.actions.invalidate(this.service.actions.get(row.action_id), error.code);
              this.update(row, { status: 'stale', reason: error.code }); this.record('stale', { case_id: row.id, reason: error.code }, 'system');
            }
          }
        } catch (error) {
          if (!(error instanceof SyntaxError) && !(error instanceof AppError)) throw error;
          this.db.run("UPDATE work_materials SET status='stale' WHERE case_id=? AND status IN ('approved','proposed')", row.id);
          this.db.run("UPDATE work_material_requests SET status='stale',reason='WORK_RECORD_INVALID' WHERE case_id=? AND status IN ('pending','running')", row.id);
          this.db.run("UPDATE work_expectations SET status='unknown',reason='WORK_RECORD_INVALID' WHERE case_id=? AND status IN ('pending','evidence_observed')", row.id);
          if (row.action_id) this.service.actions.invalidate(this.service.actions.get(row.action_id), 'WORK_RECORD_INVALID');
          this.update(row, { status: 'stale', reason: 'WORK_RECORD_INVALID' }); this.record('quarantined', { case_id: row.id, reason: 'WORK_RECORD_INVALID' }, 'system');
        }
      }
      if (rows.length) this.db.run('INSERT INTO channel_offsets VALUES(?,?,?) ON CONFLICT(channel,account_id) DO UPDATE SET cursor=excluded.cursor', CURSOR, this.partnerId, rows.at(-1).id);
      return { cases: rows.length };
    });
  }
}
