// Thin adapters over Node fs and the existing task table, not a general tool executor.
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { id, hash } from './store.mjs';
import { now } from './errors.mjs';
import { actionCheck as check } from './actions.mjs';
import { HUMAN_ACTION_TASK } from './action-tables.mjs';

export function actionArtifact(row) {
  const proposal = JSON.parse(row.proposal_json), packet = JSON.parse(row.packet_json);
  if (proposal.capability_id === 'material.export_local.v1') {
    check(packet.material && packet.material.id === proposal.material?.id && packet.material.sha256 === proposal.material?.sha256,
      'ACTION_MATERIAL_MISMATCH');
    return { format: 'harnes2-owner-material-v1', action_id: row.id, proposal_hash: row.proposal_hash,
      proposal, packet, material: packet.material,
      contact_permission: false, external_write: false, business_outcome: 'not_verified' };
  }
  return { format: 'harnes2-owner-brief-v1', action_id: row.id, proposal_hash: row.proposal_hash,
    proposal, packet, contact_permission: false, external_write: false, business_outcome: 'not_verified' };
}
export const artifactBytes = row => Buffer.from(JSON.stringify(actionArtifact(row), null, 2) + '\n');
const taskValues = row => {
  const p = JSON.parse(row.proposal_json);
  return { title: p.title, instructions: `${p.instructions}\n\nExpected result (not observed): ${p.expected_result}`,
    due_at: p.due_at ?? row.created_at, evidence: JSON.stringify({ action_id: row.id, proposal_hash: row.proposal_hash,
      thread_id: row.thread_id, turn_id: row.turn_id, basis_fingerprint: row.basis_fingerprint, epistemic_status: 'unverified_interpretation' }) };
};
export class LocalActionCapabilities {
  constructor(service) { this.service = service; this.directory = service.store.directory; }
  async vault(create = false) {
    // This deployment requires an owner-controlled directory. Refuse symlinks/junctions
    // in the path we own; checking only the final file would miss a replaced vault.
    //
    // The check is identity, not spelling. Comparing the resolved path to the path we asked for
    // refuses the same directory twice under two names: Windows reports a temporary directory as
    // `RUNNER~1` and resolves it to the long account name, so the strings differ while the
    // directory is the one we created and own. That is a false refusal of a safe directory, and
    // it is what a hosted Windows runner produced. `dev` and `ino` answer the question the check
    // is actually asking — is this the same directory, or has something been put in its place —
    // and a substituted or junctioned directory has different ones.
    const root = path.resolve(this.directory), vault = path.join(root, 'action-artifacts');
    const sameDirectory = async (target) => {
      const [wanted, resolved] = await Promise.all([fs.stat(target), fs.stat(await fs.realpath(target))]);
      return wanted.dev === resolved.dev && wanted.ino === resolved.ino;
    };
    const rootStat = await fs.lstat(root);
    check(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'ACTION_VAULT_UNSAFE');
    check(await sameDirectory(root), 'ACTION_VAULT_UNSAFE');
    let st;
    try { st = await fs.lstat(vault); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      if (!create) return null;
      // Inspect before creating; never traverse an existing junction with mkdir.
      try { await fs.mkdir(vault, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      st = await fs.lstat(vault);
    }
    check(st.isDirectory() && !st.isSymbolicLink() && await sameDirectory(vault), 'ACTION_VAULT_UNSAFE');
    return vault;
  }
  file(vault, row) {
    check(/^[0-9a-f-]{36}$/i.test(row.id), 'ACTION_ID_INVALID');
    return path.join(vault, `${row.id}.json`);
  }
  async read(row) {
    const vault = await this.vault(); if (!vault) return null;
    const file = this.file(vault, row); let st;
    try { st = await fs.lstat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    check(st.isFile() && !st.isSymbolicLink() && st.size <= 600000, 'ACTION_ARTIFACT_UNSAFE');
    const fd = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await fd.stat();
      check(opened.isFile() && opened.size <= 600000 && opened.ino === st.ino && opened.dev === st.dev, 'ACTION_ARTIFACT_UNSAFE');
      const data = await fd.readFile(); check(data.length <= 600000, 'ACTION_ARTIFACT_UNSAFE');
      await this.vault(); return data;
    } finally { await fd.close(); }
  }
  async execute(row, attempt, beforeEffect) {
    const p = JSON.parse(row.proposal_json);
    if (p.capability_id === 'owner_handoff.create.v1') {
      return this.service.exclusive(() => this.service.store.transaction(() => {
        beforeEffect(); const db = this.service.store, v = taskValues(row), taskId = row.id;
        check(!db.get('SELECT id FROM tasks WHERE id=? OR dedupe_key=?', taskId, `action:${row.id}`), 'ACTION_EFFECT_EXISTS');
        db.run(`INSERT INTO tasks(id,partner_id,conversation_id,kind,title,instructions,due_at,status,evidence,dedupe_key,author,created_at)
          VALUES(?,?,NULL,?,?,?,?,'proposed',?,?,?,?)`, taskId, row.partner_id, HUMAN_ACTION_TASK, v.title, v.instructions, v.due_at, v.evidence, `action:${row.id}`, 'operator', now());
        db.run('UPDATE action_proposals SET task_id=? WHERE id=?', taskId, row.id);
        return { outcome: 'local_task_created', task_id: taskId };
      }));
    }
    check(['brief.publish_local.v1','material.export_local.v1'].includes(p.capability_id), 'ACTION_CAPABILITY_UNAVAILABLE');
    const vault = await this.vault(true), file = this.file(vault, row);
    const staged = path.join(vault, `.${row.id}.${id()}.tmp`);
    const data = artifactBytes(row); check(data.length <= 600000, 'ACTION_ARTIFACT_TOO_LARGE');
    // Which step failed — a fixed word, never the message. A thrown error carries the path, the
    // filename and whatever the OS felt like saying, and this receipt is durable and read by an
    // operator. Naming the step is what turns "something went wrong" into "the publish link did".
    let stage = 'stage_open', opened = false, failure = null;
    try {
      const fd = await fs.open(staged, 'wx', 0o600);
      opened = true;
      try { stage = 'stage_write'; await fd.writeFile(data);
        stage = 'stage_sync'; await fd.sync(); }
      finally { await fd.close(); }
      stage = 'vault_recheck'; await this.vault();
      // Final authorization check and dispatch are adjacent; an already in-flight
      // OS operation cannot be rolled back by a later revoke. Record that truth.
      stage = 'publish_link';
      await this.service.exclusive(() => { beforeEffect(); return fs.link(staged, file); });
      // No overwrite fallback: an existing name or unsupported hard links fail closed.
      return { outcome: p.capability_id === 'material.export_local.v1' ? 'local_material_published' : 'local_file_published',
        artifact_id: row.id, sha256: hash(data), bytes: data.length };
    } catch (error) { failure = error; if (!error.failure_stage) error.failure_stage = stage; throw error; }
    finally {
      if (opened) { try { await this.vault(); await fs.unlink(staged).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
        catch (error) { if (!failure) { failure = error; stage = 'stage_cleanup'; } throw error; } }
    }
  }
  async verify(row) {
    const p = JSON.parse(row.proposal_json);
    try {
      if (p.capability_id === 'owner_handoff.create.v1') {
        const db = this.service.store, task = db.get('SELECT * FROM tasks WHERE id=? OR dedupe_key=?', row.id, `action:${row.id}`);
        if (!task) return { state: 'absent', method: 'durable_task_read' };
        const v = taskValues(row), linked = db.get('SELECT task_id FROM action_proposals WHERE id=?', row.id)?.task_id;
        const match = task.id === row.id && linked === task.id && task.partner_id === row.partner_id && task.conversation_id === null
          && task.kind === HUMAN_ACTION_TASK && task.author === 'operator' && task.dedupe_key === `action:${row.id}`
          && task.title === v.title && task.instructions === v.instructions && task.evidence === v.evidence && task.due_at === v.due_at
          && ['proposed','pending','done','cancelled'].includes(task.status);
        return { state: match ? 'present' : 'mismatch', method: 'durable_task_read', task_id: task.id, business_outcome: 'not_verified' };
      }
      check(['brief.publish_local.v1','material.export_local.v1'].includes(p.capability_id), 'ACTION_CAPABILITY_UNAVAILABLE');
      const data = await this.read(row);
      if (data === null) return { state: 'absent', method: 'independent_file_read' };
      const expected = artifactBytes(row), match = data.equals(expected);
      return { state: match ? 'present' : 'mismatch', method: 'independent_file_read', sha256: hash(data), expected_sha256: hash(expected), bytes: data.length };
    } catch { return { state: 'unavailable', method: 'independent_read', reason: 'ACTION_VERIFICATION_UNAVAILABLE' }; }
  }
  async artifact(row) {
    check(['brief.publish_local.v1','material.export_local.v1'].includes(JSON.parse(row.proposal_json ?? 'null')?.capability_id), 'ACTION_NO_ARTIFACT', 404);
    const bytes = await this.read(row);
    check(bytes && bytes.equals(artifactBytes(row)), 'ACTION_ARTIFACT_NOT_VERIFIED');
    return JSON.parse(bytes.toString('utf8'));
  }
}
