import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest } from '../business/source-ingestion.mjs';
import { runDemandAcquisition } from '../experiments/demand-radar-v0/run.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'experiments/demand-radar-v0/run.mjs');
async function sandbox(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnes-demand-offline-'));
  t.after(async () => { for (const name of await fs.readdir(dir)) await fs.unlink(path.join(dir, name)); await fs.rmdir(dir); });
  return dir;
}

test('executable demo routes RU/UA tasks, discloses controls and keyword misses without semantic claims', async t => {
  const dir = await sandbox(t), output = path.join(dir, 'report.json');
  const child = spawnSync(process.execPath, [script, '--demo', '--out', output], { encoding: 'utf8', cwd: root, windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  const summary = JSON.parse(child.stdout), report = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.equal(summary.model_calls, 0); assert.equal(summary.network_calls, 0);
  assert.equal(report.data_basis, 'SYNTHETIC_AUTHORED_TEST_CORPUS');
  assert.equal(report.probe.sample.digest_checked, true);
  assert.equal(report.probe.sample.currentness, 'NOT_CHECKED');
  assert(report.synthetic_validation.gold_tasks_matched.includes('5004')); // UA with explicit no MLM.
  assert(report.synthetic_validation.gold_tasks_unmatched.includes('5016')); // Unanticipated wording.
  assert.equal(report.synthetic_validation.semantic_classification, 'NOT_TESTED');
  assert.equal(report.synthetic_validation.live_yield, 'NOT_TESTED');
  assert(report.synthetic_validation.matched_controls.some(c => c.message_id === '5007')); // Vendor != own intent.
  const selected = report.packet.groups.flatMap(g => g.messages);
  assert(selected.find(m => m.message_id === '5010')?.text.includes('передумала')); // Same-author later cancellation.
  assert.equal(report.probe.verdict.offer_fit, 'UNKNOWN');
  assert.equal(report.probe.verdict.contact_permission, false);
  const { packet_fingerprint, ...packetContent } = report.packet;
  assert.equal(packet_fingerprint, digest(packetContent));
  assert.equal(selected.reduce((sum, m) => sum + m.text.length, 0), report.packet.characters);
});

test('demo continuation visits unmatched tasks and never repeats anchors after restart', async t => {
  const dir = await sandbox(t), cursorFile = path.join(dir, 'cursor.json');
  const seen = new Set();
  let cursor = null, pages = 0;
  do {
    const output = path.join(dir, `page-${pages}.json`);
    const args = ['--demo', '--out', output, '--max-anchors', '3', '--exploration-slots', '1'];
    if (cursor) { await fs.writeFile(cursorFile, JSON.stringify(cursor)); args.push('--cursor', cursorFile); }
    const child = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: root, windowsHide: true });
    assert.equal(child.status, 0, child.stderr); // Actual process restart; only saved files persist.
    const report = JSON.parse(await fs.readFile(output, 'utf8'));
    for (const group of report.packet.groups) {
      assert(!seen.has(group.anchor_message_id)); seen.add(group.anchor_message_id);
    }
    cursor = report.packet.next_cursor;
    assert(++pages <= 22, 'frozen bounded input must finish');
  } while (cursor);
  assert(seen.has('5016'), 'keywordless own-task control is eventually explored');
  assert(!seen.has('5015'), 'duplicate does not become another independent anchor');
  assert(!seen.has('5012')); assert(!seen.has('5013')); // Opaque/missing ancestry cannot become model anchors.
});

test('does not overwrite artifacts and creates no output for invalid arguments or JSON', async t => {
  const dir = await sandbox(t), output = path.join(dir, 'kept.json'), invalid = path.join(dir, 'bad.json');
  await fs.writeFile(output, 'preserve-this-file');
  await assert.rejects(runDemandAcquisition(['--demo', '--out', output]), error => error.code === 'EEXIST');
  assert.equal(await fs.readFile(output, 'utf8'), 'preserve-this-file');
  const absent = path.join(dir, 'absent.json');
  for (const args of [ ['--demo', '--out', absent, '--send'], ['--demo', '--out', absent, '--max-anchors', '-1'],
    ['--demo', '--out', absent, '--sample', invalid], ['--demo', '--demo', '--out', absent] ]) {
    await assert.rejects(runDemandAcquisition(args));
    await assert.rejects(fs.stat(absent), error => error.code === 'ENOENT');
  }
  await fs.writeFile(invalid, '{"private_marker":"TEST_ONLY_SECRET_SNIPPET"');
  const child = spawnSync(process.execPath, [script, '--sample', invalid, '--out', absent], { encoding: 'utf8', cwd: root, windowsHide: true });
  assert.equal(child.status, 1); assert.equal(child.stderr.trim(), 'INPUT_JSON_INVALID');
  assert(!child.stderr.includes('TEST_ONLY_SECRET_SNIPPET'));
  await assert.rejects(fs.stat(absent), error => error.code === 'ENOENT');
});

test('input file budget and forged sealed commitment fail before output', async t => {
  const dir = await sandbox(t), sampleFile = path.join(dir, 'sample.json'), output = path.join(dir, 'output.json');
  const oversized = await fs.open(sampleFile, 'w'); await oversized.truncate(8_000_001); await oversized.close();
  await assert.rejects(runDemandAcquisition(['--sample', sampleFile, '--out', output]), /INPUT_FILE_LIMIT/);
  await runDemandAcquisition(['--demo', '--out', output]);
  const report = JSON.parse(await fs.readFile(output, 'utf8'));
  const row = { status: 'sealed', id: report.probe.sample.sample_id, candidate_id: report.probe.sample.candidate_id,
    source_ref: report.probe.sample.source_ref, account_id: report.probe.sample.account_id,
    requested_from: report.probe.sample.requested_from, requested_until: report.probe.sample.requested_until,
    source_cursor: report.probe.sample.source_cursor, finished_at: report.probe.sample.declared_finished_at,
    messages_json: '[]', coverage: report.probe.sample.declared_coverage, digest: report.probe.sample.declared_digest };
  await fs.writeFile(sampleFile, JSON.stringify(row));
  const absent = path.join(dir, 'not-created.json');
  await assert.rejects(runDemandAcquisition(['--sample', sampleFile, '--out', absent]), /SAMPLE_DIGEST_MISMATCH/);
  await assert.rejects(fs.stat(absent), error => error.code === 'ENOENT');
});
