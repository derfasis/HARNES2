import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import { ROOT, readJson, runtimeReadiness, usageAccounting } from './config.mjs';
import { id } from './store.mjs';
import { AppError, now } from './errors.mjs';
import { digest } from './source-ingestion.mjs';
const contract = readJson(path.join(ROOT, 'contracts/work-material.schema.json'));
const validate = new Ajv({ strict: true }).compile(contract);
const instructions = fs.readFileSync(path.join(ROOT, 'partner/workspace-reasoning.md'), 'utf8');
export async function processWork(service, runtime) {
  if (service.config.workspace?.enabled !== true || service.config.workspace.modelEnabled !== true) return { disposition: 'disabled' };
  if (!runtimeReadiness(service.config, { decision: true }).ready) return { disposition: 'waiting_model' };
  return service.control.run('work', 'material', async () => {
    const db = service.store;
    const prepared = await service.exclusive(() => db.transaction(() => {
      const requests = db.all("SELECT * FROM work_material_requests WHERE status='pending' AND case_id IN (SELECT id FROM work_cases WHERE partner_id=?) ORDER BY created_at,id LIMIT 20", service.config.partnerId);
      for (const request of requests) {
        const row = service.work.get(request.case_id);
        let sourcePacket;
        try {
          service.work.current(row);
          if (row.revision !== request.case_revision || row.basis_fingerprint !== request.basis_fingerprint) throw new AppError('WORK_STALE_BASIS', 409, 'WORK_STALE_BASIS');
          sourcePacket = JSON.parse(request.packet_json);
          if (digest(sourcePacket) !== digest(JSON.parse(row.packet_json))) throw new AppError('WORK_REQUEST_INVALID', 409, 'WORK_REQUEST_INVALID');
        } catch (e) {
          if (!(e instanceof AppError) && !(e instanceof SyntaxError)) throw e;
          db.run("UPDATE work_material_requests SET status='stale',reason=?,finished_at=? WHERE id=?", e.code ?? 'WORK_REQUEST_INVALID', now(), request.id); continue;
        }
        const runId = id(); const packet = { ...sourcePacket, case_id: row.id, title: row.title, capabilities: service.control.status().capabilities };
        db.run("INSERT INTO runs(id,partner_id,status,runtime,model,context_json,created_at) VALUES(?,?,'running','hermes-workspace-v1',?,?,?)", runId, service.config.partnerId, service.config.runtime.model, JSON.stringify({ case_id: row.id, request_id: request.id, model_config: service.config.runtime }), now());
        service.control.bindRun(runId); db.run("UPDATE work_material_requests SET status='running',run_id=? WHERE id=?", runId, request.id);
        return { request, row, run: db.get('SELECT * FROM runs WHERE id=?', runId), context: { packet, input: { situation_id: row.id }, output_contract: contract, router_instructions: instructions } };
      }
      return null;
    }));
    if (!prepared) return { disposition: 'idle' };
    let result; try { result = await runtime.decide(prepared.run, prepared.context); } catch { result = { completed: false }; }
    try {
      return await service.exclusive(() => db.transaction(() => {
        const row = service.work.get(prepared.row.id), request = db.get('SELECT * FROM work_material_requests WHERE id=?', prepared.request.id);
        const spent = usageAccounting(JSON.parse(prepared.run.context_json).model_config, result?.usage);
        let disposition = 'model_failed', materialId = null;
        const hasTools = result?.tool_calls != null && (!Array.isArray(result.tool_calls) || result.tool_calls.length)
          || result?.messages != null && (!Array.isArray(result.messages) || result.messages.some(m => m?.role === 'tool' || m?.tool_calls?.length || m?.function_call));
        if (request.status === 'running' && service.control.canApply(prepared.run.id) && service.config.workspace.enabled === true && service.config.workspace.modelEnabled === true
          && result?.completed === true && !result.error && !hasTools && typeof result.final_response === 'string' && Buffer.byteLength(result.final_response) <= 60000) {
          try {
            service.work.current(row); if (row.revision !== request.case_revision) throw new AppError('WORK_REVISION_CONFLICT', 409, 'WORK_REVISION_CONFLICT');
            const output = JSON.parse(result.final_response); if (!validate(output)) throw new AppError('WORK_OUTPUT_INVALID', 400, 'WORK_OUTPUT_INVALID');
            materialId = service.work.addMaterial(row, output, 'model', prepared.run.id).material_id; disposition = 'material_proposed';
          } catch (e) { if (!(e instanceof AppError) && !(e instanceof SyntaxError)) throw e; disposition = e.code ?? 'WORK_OUTPUT_INVALID'; }
        }
        db.run("UPDATE work_material_requests SET status=?,material_id=?,reason=?,finished_at=? WHERE id=? AND status='running'", disposition === 'material_proposed' ? 'completed' : 'failed', materialId, disposition, now(), request.id);
        // Historical spend survives stale completion; provider payload is never stored.
        db.run('UPDATE runs SET status=?,result_json=?,error=?,input_tokens=?,output_tokens=?,estimated_cost_usd=?,cost_status=?,finished_at=? WHERE id=?', materialId ? 'completed' : 'failed', JSON.stringify({ disposition, material_id: materialId }), materialId ? null : disposition, spent.input, spent.output, spent.cost, spent.costStatus, now(), prepared.run.id);
        return { disposition, case_id: row.id, material_id: materialId };
      }));
    } catch (e) {
      await service.exclusive(() => db.transaction(() => {
        db.run("UPDATE work_material_requests SET status='interrupted',reason='RESULT_PERSIST_FAILED',finished_at=? WHERE id=? AND status='running'", now(), prepared.request.id);
        db.run("UPDATE runs SET status='interrupted',error='RESULT_PERSIST_FAILED',finished_at=? WHERE id=? AND status='running'", now(), prepared.run.id);
      })); throw e;
    }
  });
}
