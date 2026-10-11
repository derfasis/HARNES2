import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { digest } from '../business/source-ingestion.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const casesDoc = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'benchmarks/commercial-task-fidelity-v1/cases.json'), 'utf8'));
const goldDoc = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'benchmarks/commercial-task-fidelity-v1/gold.json'), 'utf8'));
const goldById = new Map(goldDoc.cases.map(row => [row.case_id, row]));
const cliRelative = path.join('experiments', 'commercial-task-fidelity-v1', 'run.mjs');

function makeSandbox(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'commercial-task-fidelity-cli-'));
  const root = path.join(sandbox, 'copy');
  fs.mkdirSync(root);
  for (const directory of ['business', 'contracts', 'partner', 'public', 'config', 'scripts'])
    fs.cpSync(path.join(sourceRoot, directory), path.join(root, directory), { recursive: true });
  for (const relative of ['experiments/commercial-task-fidelity-v1', 'benchmarks/commercial-task-fidelity-v1'])
    fs.cpSync(path.join(sourceRoot, relative), path.join(root, relative), { recursive: true });
  const modules = path.join(sourceRoot, 'node_modules');
  assert.ok(fs.existsSync(modules), 'workspace dependencies are present');
  fs.symlinkSync(modules, path.join(root, 'node_modules'), 'junction');
  const pythonParts = process.platform === 'win32' ? ['.venv', 'Scripts', 'python.exe'] : ['.venv', 'bin', 'python'];
  const pythonPath = path.join(root, ...pythonParts);
  fs.mkdirSync(path.dirname(pythonPath), { recursive: true });
  fs.writeFileSync(pythonPath, 'offline fixture readiness marker; never executable\n');

  const fixtureLoader = path.join(sandbox, 'offline-fidelity-loader.mjs');
  const callMarker = path.join(sandbox, 'fake-model-calls.txt');
  const inputMarker = path.join(sandbox, 'fake-model-input.json');
  fs.writeFileSync(callMarker, '');
  const runtimeUrl = pathToFileURL(path.join(root, 'business', 'runtime.mjs')).href;
  fs.writeFileSync(fixtureLoader, `
    import fs from 'node:fs';
    import { HermesAdapter } from ${JSON.stringify(runtimeUrl)};
    HermesAdapter.prototype.decide = async function (_run, context) {
      fs.appendFileSync(process.env.FIDELITY_CALL_MARKER, 'call\\n', 'utf8');
      fs.writeFileSync(process.env.FIDELITY_INPUT_MARKER, JSON.stringify(context.packet), 'utf8');
      if (process.env.FIDELITY_FAKE_MODE === 'throw') throw new Error('offline unknown completion');
      if (process.env.FIDELITY_FAKE_MODE === 'crash') process.exit(73);
      const exchanges = context.packet.exchanges;
      const review = {
        version: 1, scope: 'supplied_packet_only', disposition: 'no_need_proposed',
        summary: 'Offline fixture: no separate need proposed; interpretation is not evaluated.',
        unknowns: ['The offline fixture does not judge semantic quality or task correctness.'],
        exchange_reviews: exchanges.map(exchange => ({
          exchange_id: exchange.id, judgment: 'uncertain',
          reason: 'Offline fixture preserves the supplied evidence without making a semantic finding.',
          evidence_event_ids: exchange.evidence.map(item => item.source_event_id),
          support_quotes: exchange.evidence.map(item => ({ source_event_id: item.source_event_id, quote: item.text }))
        }))
      };
      return { completed: true, final_response: JSON.stringify({ needs: [], decision_review: review }),
        api_calls: 1, tool_calls: process.env.FIDELITY_FAKE_MODE === 'forged' ? [{ id: 'forged-tool' }] : [],
        usage: {}, model_identity: { model_id: process.env.FIDELITY_FAKE_MODEL_ID || 'offline-cli-fixture', model_version: '1' } };
    };
  `);
  const relative = path.relative(fs.realpathSync(os.tmpdir()), path.resolve(sandbox));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'sandbox is under the OS temp directory');
  t.after(() => fs.rmSync(path.resolve(sandbox), { recursive: true, force: true }));
  return { sandbox, root, fixtureLoader, callMarker, inputMarker };
}

function childEnvironment(isolated, extra = {}) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME',
    'LOCALAPPDATA', 'APPDATA', 'PROGRAMFILES', 'ProgramFiles', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
  env.PARTNER_MODEL_API_KEY = 'offline-fidelity-sentinel-never-sent';
  env.FIDELITY_CALL_MARKER = isolated.callMarker;
  env.FIDELITY_INPUT_MARKER = isolated.inputMarker;
  Object.assign(env, extra);
  return env;
}

function invoke(isolated, args, extraEnv = {}) {
  return spawnSync(process.execPath, ['--import', pathToFileURL(isolated.fixtureLoader).href,
    path.join(isolated.root, cliRelative), ...args], {
    cwd: isolated.root, env: childEnvironment(isolated, extraEnv), encoding: 'utf8', timeout: 45_000,
    maxBuffer: 3 * 1024 * 1024,
  });
}

function runCell(isolated, cell = '1A', model = 'offline-cli-fixture', extraEnv = {}) {
  return invoke(isolated, ['--run', cell, '--model', model, '--base-url', 'http://127.0.0.1:1/v1'], extraEnv);
}

function cachePath(isolated) { return path.join(isolated.root, '.cache', 'commercial-task-fidelity-stage0-v1'); }
function readHistory(isolated) { return JSON.parse(fs.readFileSync(path.join(cachePath(isolated), 'history.json'), 'utf8')); }
function callCount(isolated) { return fs.readFileSync(isolated.callMarker, 'utf8').trim().split(/\r?\n/).filter(Boolean).length; }
function dbForAttempt(isolated, attempt) {
  assert.ok(attempt.directory.startsWith(isolated.root + path.sep), 'attempt database remains inside copied root');
  const dbFile = path.join(attempt.directory, 'partner.sqlite');
  assert.ok(fs.existsSync(dbFile), 'attempt database is retained for offline inspection');
  return new DatabaseSync(dbFile, { readOnly: true });
}

function writeReview(isolated, attempt, { verdict = 'FAIL', positive = 'FAIL', omit = null, bind = {} } = {}) {
  const gold = goldById.get(attempt.case_id);
  const rows = items => items.map((_, index) => ({ index, result: 'PASS', reason: `Offline fixture review item ${index} recorded.` }));
  const review = {
    version: 1, cell_id: attempt.cell_id, case_id: attempt.case_id,
    output_hash: bind.output_hash ?? attempt.output_hash,
    gold_case_hash: bind.gold_case_hash ?? digest(gold),
    reviewer: 'offline-test-reviewer', verdict,
    source_facts: rows(gold.source_facts),
    required_distinctions: rows(gold.required_distinctions),
    forbidden_claims: rows(gold.forbidden_claims),
    critical_failures: rows(gold.critical_failures),
    currentness: { result: 'PASS', reason: 'Status was recorded for the offline gate test.' },
    positive_control: { result: positive, reason: 'Positive-control judgment is explicit in this fixture review.' },
    offer_fit: { result: 'PASS', reason: 'Fit remains UNKNOWN as required by the oracle.' },
    contact_permission: { result: 'PASS', reason: 'Contact permission remains false as required by the oracle.' },
  };
  if (omit) delete review[omit];
  const filename = path.join(isolated.sandbox, 'review.json');
  fs.writeFileSync(filename, JSON.stringify(review, null, 2) + '\n', 'utf8');
  return filename;
}

function reviewCell(isolated, filename) { return invoke(isolated, ['--review', filename]); }
function requireCode(child, code) { assert.notEqual(child.status, 0); assert.match(child.stderr, new RegExp(`^${code}\\s*$`)); }

test('copied CLI preserves native source identity and dates, binds the actual prompt receipt, and closes one attempt grant', t => {
  const isolated = makeSandbox(t);
  const child = runCell(isolated);
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  const attempt = readHistory(isolated).attempts[0];
  const report = JSON.parse(fs.readFileSync(attempt.report_path, 'utf8'));
  const fixture = casesDoc.cases[0];
  assert.equal(report.synthetic, true);
  assert.equal(report.cell_id, '1A');
  const manifestText = fs.readFileSync(path.join(isolated.root, 'experiments/commercial-task-fidelity-v1/manifest.json'), 'utf8').replace(/\r\n?/g, '\n');
  assert.equal(report.manifest_hash, createHash('sha256').update(manifestText).digest('hex'));
  const promptA = fs.readFileSync(path.join(isolated.root, 'experiments/commercial-task-fidelity-v1/prompts/A.md'), 'utf8').replace(/\r\n?/g, '\n');
  assert.equal(report.prompt_hash, digest(promptA));
  assert.equal(report.checks.receipt_matches_actual_prompt, true);
  assert.equal(report.test_authority_closed, true);
  assert.equal(report.checks.all_fixture_messages_preserved, true);
  assert.equal(report.checks.tools_empty, true);
  assert.equal(report.checks.no_contact_artifacts, true);
  assert.equal(report.checks.production_runtime_disabled, true);
  assert.equal(report.checks.telegram_disabled, true);
  assert.equal(report.checks.scheduler_disabled, true);
  assert.equal(report.semantic_verdict, 'NOT_REVIEWED');
  assert.equal(report.comparative_attribution, 'INCONCLUSIVE_NONIDENTICAL_MODEL_INPUTS');
  assert.equal(report.experiment_type, 'UNPAIRED_NATIVE_FIDELITY_OBSERVATIONS');
  assert.equal(report.causal_comparison, false);
  assert.equal(report.packet.title, `Synthetic fidelity ${report.case_id}`);
  assert.match(report.controlled_source_task_hash, /^[a-f0-9]{64}$/);
  assert.equal(callCount(isolated), 1, 'only the local HermesAdapter fake ran');

  const received = JSON.parse(fs.readFileSync(isolated.inputMarker, 'utf8'));
  const allEvidence = received.exchanges.flatMap(exchange => exchange.evidence);
  assert.equal(allEvidence.length, fixture.messages.length);
  for (const message of fixture.messages) {
    const evidence = allEvidence.find(row => row.message_id === message.id);
    assert.ok(evidence, `source message ${message.id} reached the native model packet`);
    assert.equal(evidence.author_id, message.author_ref);
    assert.equal(evidence.text, message.text);
    assert.equal(evidence.published_at, message.published_at);
  }

  const db = dbForAttempt(isolated, attempt);
  try {
    const scalar = sql => db.prepare(sql).get().n;
    const grant = db.prepare('SELECT status,max_attempts,revocation_reason FROM audience_attention_grants').get();
    assert.deepEqual({ ...grant }, { status: 'revoked', max_attempts: 1, revocation_reason: 'Finite synthetic Stage0 cell ended.' });
    assert.equal(scalar('SELECT COUNT(*) AS n FROM audience_attention_attempts'), 1);
    for (const table of ['persons', 'contact_permissions', 'conversations', 'drafts', 'delivery_attempts', 'action_proposals'])
      assert.equal(scalar(`SELECT COUNT(*) AS n FROM ${table}`), 0, `${table} remains empty`);
    const run = db.prepare("SELECT context_json,result_json FROM runs WHERE runtime='hermes-audience-v1'").get();
    const context = JSON.parse(run.context_json), receipt = JSON.parse(run.result_json);
    assert.equal(context.prompt_fingerprint, report.prompt_hash);
    assert.equal(context.model_input_fingerprint, report.model_input_hash);
    assert.equal(receipt.model_input_fingerprint, report.model_input_hash);
    assert.equal(receipt.model_api_calls, 1);
  } finally { db.close(); }
});

test('B cannot dispatch until A has a bound review; an empty positive control cannot receive PASS', t => {
  const isolated = makeSandbox(t);
  const first = runCell(isolated, '1A');
  assert.equal(first.status, 0, first.stderr);
  const before = callCount(isolated);
  requireCode(runCell(isolated, '1B'), 'FIDELITY_REVIEW_REQUIRED');
  assert.equal(callCount(isolated), before, 'B is refused before the model adapter runs');
  const attempt = readHistory(isolated).attempts[0];
  const reviewFile = writeReview(isolated, attempt, { verdict: 'PASS', positive: 'PASS' });
  requireCode(reviewCell(isolated, reviewFile), 'FIDELITY_POSITIVE_CONTROL_EMPTY');
  assert.equal(readHistory(isolated).attempts[0].review, null, 'rejected PASS is not recorded');
  assert.equal(callCount(isolated), before);
});

test('complete explicit A FAIL and B FAIL reviews are recordable and then stop the sequence', t => {
  const isolated = makeSandbox(t);
  const first = runCell(isolated, '1A');
  assert.equal(first.status, 0, first.stderr);
  let attempt = readHistory(isolated).attempts[0];
  let reviewed = reviewCell(isolated, writeReview(isolated, attempt, { verdict: 'FAIL', positive: 'FAIL' }));
  assert.equal(reviewed.status, 0, reviewed.stderr);
  assert.equal(JSON.parse(reviewed.stdout).semantic_verdict, 'FAIL');
  assert.equal(JSON.parse(reviewed.stdout).stop_reason, null);

  const second = runCell(isolated, '1B');
  assert.equal(second.status, 0, second.stderr);
  attempt = readHistory(isolated).attempts[1];
  const reportB = JSON.parse(fs.readFileSync(attempt.report_path, 'utf8'));
  const promptB = fs.readFileSync(path.join(isolated.root, 'experiments/commercial-task-fidelity-v1/prompts/B.md'), 'utf8').replace(/\r\n?/g, '\n');
  assert.equal(reportB.prompt_hash, digest(promptB), 'B receipt binds the actual frozen B prompt');
  assert.equal(reportB.checks.receipt_matches_actual_prompt, true);
  reviewed = reviewCell(isolated, writeReview(isolated, attempt, { verdict: 'FAIL', positive: 'FAIL' }));
  assert.equal(reviewed.status, 0, reviewed.stderr);
  assert.equal(JSON.parse(reviewed.stdout).stop_reason, 'SEMANTIC_REVIEW_STOP');
  assert.equal(readHistory(isolated).stop_reason, 'SEMANTIC_REVIEW_STOP');
  const before = callCount(isolated);
  requireCode(runCell(isolated, '2A'), 'FIDELITY_STOPPED');
  assert.equal(callCount(isolated), before, 'semantic failure prevents later dispatch');
});

test('review requires every distinction and counterclaim row and binds output plus frozen gold', t => {
  const isolated = makeSandbox(t);
  assert.equal(runCell(isolated).status, 0);
  const attempt = readHistory(isolated).attempts[0];
  requireCode(reviewCell(isolated, writeReview(isolated, attempt, { omit: 'required_distinctions' })), 'FIDELITY_REVIEW_INCOMPLETE');
  requireCode(reviewCell(isolated, writeReview(isolated, attempt, { omit: 'critical_failures' })), 'FIDELITY_REVIEW_INCOMPLETE');
  requireCode(reviewCell(isolated, writeReview(isolated, attempt, { bind: { output_hash: '0'.repeat(64) } })), 'FIDELITY_REVIEW_BINDING_INVALID');
  requireCode(reviewCell(isolated, writeReview(isolated, attempt, { bind: { gold_case_hash: '0'.repeat(64) } })), 'FIDELITY_REVIEW_BINDING_INVALID');
  assert.equal(readHistory(isolated).attempts[0].review, null);
});

test('tampering with a retained report prevents its otherwise complete review from being recorded', t => {
  const isolated = makeSandbox(t);
  assert.equal(runCell(isolated).status, 0);
  const attempt = readHistory(isolated).attempts[0];
  const report = JSON.parse(fs.readFileSync(attempt.report_path, 'utf8'));
  report.disposition = 'fabricated-after-run';
  fs.writeFileSync(attempt.report_path, JSON.stringify(report, null, 2) + '\n');
  requireCode(reviewCell(isolated, writeReview(isolated, attempt, { verdict: 'FAIL', positive: 'FAIL' })), 'FIDELITY_REPORT_CHANGED');
  assert.equal(readHistory(isolated).attempts[0].review, null);
});

test('reserved and cap-corrupt durable histories block dispatch after process restart', t => {
  const isolated = makeSandbox(t);
  assert.equal(runCell(isolated).status, 0);
  const historyFile = path.join(cachePath(isolated), 'history.json');
  const history = readHistory(isolated);
  history.attempts[0].status = 'reserved';
  history.attempts[0].review = null;
  fs.writeFileSync(historyFile, JSON.stringify(history, null, 2) + '\n');
  const before = callCount(isolated);
  requireCode(runCell(isolated, '1B'), 'FIDELITY_REVIEW_REQUIRED');
  assert.equal(callCount(isolated), before);

  history.attempts[0].status = 'completed';
  history.attempts[0].review = { verdict: 'PASS' };
  history.attempts[0].cell_id = '8B';
  fs.writeFileSync(historyFile, JSON.stringify(history, null, 2) + '\n');
  requireCode(runCell(isolated, '1B'), 'FIDELITY_HISTORY_INVALID');
  assert.equal(callCount(isolated), before, 'invalid or reserved state cannot purchase a fresh call');
});

test('abrupt unknown native completion leaves a reserved slot that blocks retry after restart', t => {
  const isolated = makeSandbox(t);
  const child = runCell(isolated, '1A', 'offline-cli-fixture', { FIDELITY_FAKE_MODE: 'crash' });
  assert.equal(child.status, 73, child.stderr);
  const history = readHistory(isolated);
  assert.equal(history.logical_attempts, 1);
  assert.equal(history.attempts[0].status, 'reserved');
  assert.equal(history.stop_reason, null);
  assert.equal(callCount(isolated), 1, 'process exited after native adapter entry and durable reservation');
  // Model a process-lock reaper after confirming the old child is gone. The durable
  // reservation itself must still prevent a repeat dispatch.
  fs.rmSync(path.join(cachePath(isolated), 'history.lock'));
  requireCode(runCell(isolated, '1B'), 'FIDELITY_REVIEW_REQUIRED');
  assert.equal(callCount(isolated), 1);
});

test('lock contention, changed model identity, and forged tool calls all block further or unsafe dispatch', t => {
  const locked = makeSandbox(t);
  const lockedCache = cachePath(locked);
  fs.mkdirSync(lockedCache, { recursive: true });
  fs.writeFileSync(path.join(lockedCache, 'history.lock'), JSON.stringify({ lock_id: 'other-process' }));
  const lockResult = runCell(locked);
  assert.notEqual(lockResult.status, 0);
  assert.equal(callCount(locked), 0, 'lock contention refuses before model call');
  assert.equal(fs.existsSync(path.join(lockedCache, 'history.json')), false);

  const changed = makeSandbox(t);
  assert.equal(runCell(changed, '1A').status, 0);
  let attempt = readHistory(changed).attempts[0];
  const aReview = writeReview(changed, attempt, { verdict: 'FAIL', positive: 'FAIL' });
  assert.equal(reviewCell(changed, aReview).status, 0);
  const beforeChangedModel = callCount(changed);
  requireCode(runCell(changed, '1B', 'different-offline-model'), 'FIDELITY_MODEL_CHANGED');
  assert.equal(callCount(changed), beforeChangedModel);

  const forged = makeSandbox(t);
  const forgedResult = runCell(forged, '1A', 'offline-cli-fixture', { FIDELITY_FAKE_MODE: 'forged' });
  assert.equal(forgedResult.status, 2, forgedResult.stderr);
  const forgedHistory = readHistory(forged);
  assert.equal(forgedHistory.attempts[0].status, 'blocked');
  assert.equal(forgedHistory.stop_reason, 'RUNTIME_OR_CONTRACT_OR_SAFETY_FAILURE');
  const report = JSON.parse(fs.readFileSync(forgedHistory.attempts[0].report_path, 'utf8'));
  assert.equal(report.checks.tools_empty, false);
  assert.equal(report.test_authority_closed, true);
  assert.equal(callCount(forged), 1);
  requireCode(runCell(forged), 'FIDELITY_STOPPED');
  assert.equal(callCount(forged), 1);
});
