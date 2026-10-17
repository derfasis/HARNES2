import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from '../../business/source-ingestion.mjs';
import { probeScoutDemandCandidates } from './probe.mjs';
import { buildDemandReviewPacket } from './review-packet.mjs';
import { syntheticMessages, syntheticGold } from './synthetic-corpus.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const check = (ok, code) => { if (!ok) throw new TypeError(code); };
async function readJson(filename, limit) {
  const handle = await fs.open(filename, 'r');
  try {
    const stat = await handle.stat();
    check(stat.isFile() && stat.size <= limit, 'INPUT_FILE_LIMIT');
    // A bounded read also caps files that grow after stat.
    const bytes = Buffer.alloc(limit + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const read = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (!read.bytesRead) break;
      bytesRead += read.bytesRead;
    }
    check(bytesRead <= limit, 'INPUT_FILE_LIMIT');
    try { return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')); }
    catch { throw new TypeError('INPUT_JSON_INVALID'); }
  } finally { await handle.close(); }
}

function demoSample() {
  const committed = { source_ref: 'fixture:synthetic-commercial-tasks-ru-ua', account_id: '991234567890',
    from: '2026-09-01T00:00:00.000Z', until: '2026-09-03T00:00:00.000Z',
    source_cursor: 0, messages: syntheticMessages, coverage: 'requested_window_sampled' };
  return { id: 'synthetic-commercial-tasks-v1', candidate_id: 'synthetic-community-v1', status: 'sealed',
    source_ref: committed.source_ref, account_id: committed.account_id,
    requested_from: committed.from, requested_until: committed.until, source_cursor: committed.source_cursor,
    messages_json: JSON.stringify(committed.messages), coverage: committed.coverage,
    digest: digest(committed), finished_at: '2026-09-03T00:00:01.000Z' };
}

export async function runDemandAcquisition(argv) {
  const args = {};
  const values = new Set(['--mission', '--sample', '--out', '--cursor', '--max-anchors', '--max-characters', '--exploration-slots']);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    check(key === '--demo' || values.has(key), 'CLI_ARGUMENT_INVALID');
    check(args[key] === undefined, 'CLI_ARGUMENT_DUPLICATE');
    if (key === '--demo') args[key] = true;
    else { check(typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--'), 'CLI_ARGUMENT_VALUE'); args[key] = argv[++i]; }
  }
  check(typeof args['--out'] === 'string' && Boolean(args['--demo']) !== Boolean(args['--sample']), 'CLI_INPUT_REQUIRED');
  const mission = await readJson(args['--mission'] ?? path.join(here, 'commercial-task-mission.json'), 100000);
  const sample = args['--demo'] ? demoSample() : await readJson(args['--sample'], 8_000_000);
  const probe = probeScoutDemandCandidates({ mission, sample });
  const options = { probe };
  for (const [flag, key] of [['--max-anchors', 'max_anchors'], ['--max-characters', 'max_characters'], ['--exploration-slots', 'exploration_slots']]) {
    if (args[flag] !== undefined) {
      check(/^(0|[1-9][0-9]{0,5})$/.test(args[flag]), 'CLI_BUDGET_INVALID'); options[key] = Number(args[flag]);
    }
  }
  if (args['--cursor']) {
    const previous = await readJson(args['--cursor'], 4096);
    options.cursor = previous; // Pass only the previously saved next_cursor object.
  }
  const packet = buildDemandReviewPacket(options);
  const result = { kind: 'offline_demand_acquisition_v1',
    data_basis: args['--demo'] ? 'SYNTHETIC_AUTHORED_TEST_CORPUS' : 'CALLER_SUPPLIED_SEALED_SCOUT_ROW',
    processing_authority: args['--demo'] ? 'SYNTHETIC_TEST_DATA_ONLY' : 'NOT_VERIFIED_BY_OFFLINE_TOOL',
    production_adoption: 'NOT_AUTHORIZED_BY_THIS_REPORT', probe, packet };
  if (args['--demo']) {
    const matched = new Set(probe.candidates.map(row => row.message_id));
    const anchorIds = new Set(packet.groups.map(group => group.anchor_message_id));
    result.synthetic_validation = { gold_own_task_ids: [...syntheticGold.own_task_ids],
      gold_tasks_matched: syntheticGold.own_task_ids.filter(id => matched.has(id)),
      gold_tasks_unmatched: syntheticGold.own_task_ids.filter(id => !matched.has(id)),
      gold_tasks_selected_as_anchors: syntheticGold.own_task_ids.filter(id => anchorIds.has(id)),
      matched_controls: syntheticGold.controls.filter(row => matched.has(row.message_id)),
      semantic_classification: 'NOT_TESTED', live_yield: 'NOT_TESTED', representativeness: 'NOT_PROVEN' };
  }
  const output = path.resolve(args['--out']);
  // Fail on existing files, including symlinks. No overwrite or write before validation.
  const handle = await fs.open(output, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(result, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  return { output, data_basis: result.data_basis, raw_messages: probe.counts.raw_messages,
    matched_messages: probe.counts.candidates, unmatched_messages: probe.counts.unselected,
    review_anchors: packet.groups.length, deferred_anchors: packet.deferred_count,
    semantic_classification: 'NOT_TESTED', model_calls: 0, network_calls: 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runDemandAcquisition(process.argv.slice(2)))); }
  catch (error) {
    // Neither source text nor JSON parser snippets/credentials belong in stderr.
    const code = /^[A-Z][A-Z0-9_]+$/.test(error?.message ?? '') ? error.message
      : /^[A-Z][A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'ACQUISITION_FAILED';
    console.error(code); process.exitCode = 1;
  }
}
