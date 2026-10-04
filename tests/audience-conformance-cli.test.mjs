import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeSandbox(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'audience-conformance-cli-'));
  const root = path.join(sandbox, 'copy');
  fs.mkdirSync(root);
  for (const directory of ['business','contracts','partner','public'])
    fs.cpSync(path.join(sourceRoot, directory), path.join(root, directory), { recursive:true });
  fs.mkdirSync(path.join(root, 'config'));
  fs.copyFileSync(path.join(sourceRoot, 'config', 'default.json'), path.join(root, 'config', 'default.json'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(sourceRoot, 'scripts', 'audience-conformance.mjs'), path.join(root, 'scripts', 'audience-conformance.mjs'));
  const modules = path.join(sourceRoot, 'node_modules');
  assert.ok(fs.existsSync(modules), 'workspace dependencies are present');
  fs.symlinkSync(modules, path.join(root, 'node_modules'), 'junction');
  const pythonStub = process.platform === 'win32' ? ['.venv','Scripts','python.exe'] : ['.venv','bin','python'];
  const pythonPath = path.join(root, ...pythonStub);
  fs.mkdirSync(path.dirname(pythonPath), { recursive:true });
  fs.writeFileSync(pythonPath, 'offline fixture readiness marker; never executable\n');
  const fixtureLoader = path.join(sandbox, 'offline-fixture-loader.mjs');
  const callMarker = path.join(sandbox, 'fake-model-calls.txt');
  fs.writeFileSync(callMarker, '');
  const runtimeUrl = pathToFileURL(path.join(root, 'business', 'runtime.mjs')).href;
  fs.writeFileSync(fixtureLoader, `
    import fs from 'node:fs';
    import { HermesAdapter } from ${JSON.stringify(runtimeUrl)};
    HermesAdapter.prototype.decide = async function (_run, context) {
      fs.appendFileSync(process.env.OFFLINE_MODEL_CALL_MARKER, 'call\\n', 'utf8');
      const exchanges = context.packet.exchanges;
      const review = {
        version: 1, scope: 'supplied_packet_only', disposition: 'no_need_proposed',
        summary: 'This bounded fixture records that no separate need was proposed.',
        unknowns: ['The fixture cannot establish source completeness or final audience resolution.'],
        exchange_reviews: exchanges.map(exchange => ({
          exchange_id: exchange.id, judgment: 'uncertain',
          reason: 'The bounded fixture keeps interpretation uncertain.',
          evidence_event_ids: exchange.evidence.map(item => item.source_event_id),
          support_quotes: exchange.evidence.map(item => ({ source_event_id: item.source_event_id, quote: item.text }))
        }))
      };
      return { completed: true, final_response: JSON.stringify({ needs: [], decision_review: review }),
        api_calls: 1, tool_calls: [], usage: {}, model_identity: { model_id: 'offline-cli-fixture', model_version: '1' } };
    };
  `);
  const relative = path.relative(fs.realpathSync(os.tmpdir()), path.resolve(sandbox));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'sandbox is contained by OS temp directory');
  t.after(() => fs.rmSync(path.resolve(sandbox), { recursive:true, force:true }));
  return { sandbox, root, fixtureLoader, callMarker };
}

function childEnvironment(callMarker) {
  const env = {};
  for (const key of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','HOME',
    'LOCALAPPDATA','APPDATA','PROGRAMFILES','ProgramFiles','PATHEXT']) if (process.env[key]) env[key] = process.env[key];
  env.PARTNER_MODEL_API_KEY = 'offline-cli-sentinel-never-sent';
  env.OFFLINE_MODEL_CALL_MARKER = callMarker;
  return env;
}

function invoke({ root, fixtureLoader, callMarker }) {
  return spawnSync(process.execPath, ['--import', pathToFileURL(fixtureLoader).href, path.join(root, 'scripts', 'audience-conformance.mjs'),
    '--model','offline-cli-fixture','--base-url','http://127.0.0.1:1/v1','--provider','custom'], {
    cwd:root, env:childEnvironment(callMarker), encoding:'utf8', timeout:30_000, maxBuffer:2 * 1024 * 1024,
  });
}

function inspectStore(report) {
  assert.equal(typeof report.evidence_store, 'string');
  const dbPath = path.resolve(report.evidence_store, 'partner.sqlite');
  const sandboxPath = path.resolve(path.dirname(path.dirname(report.evidence_store)));
  assert.ok(dbPath.startsWith(sandboxPath + path.sep), 'reported SQLite store remains under the copied test root');
  assert.ok(fs.existsSync(dbPath), 'CLI retains its SQLite store');
  return new DatabaseSync(dbPath, { readOnly:true });
}

test('copied conformance CLI runs one granted offline empty assessment, persists receipts, and closes its grant', t => {
  const isolated = makeSandbox(t);
  const child = invoke(isolated);
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.synthetic, true);
  assert.equal(report.disposition, 'no_need_proposed');
  assert.equal(report.output_contract_valid, true);
  assert.equal(report.assessment.status, 'proposed');
  assert.equal(report.need_count, 0);
  assert.equal(report.run.status, 'completed');
  assert.equal(report.run.cost_status, 'unknown');
  assert.equal(report.run.input_tokens, null);
  assert.equal(report.run.output_tokens, null);
  assert.equal(report.runtime_observation.api_calls, 1);
  assert.equal(report.runtime_observation.tool_call_count, 0);
  assert.equal(report.effective_test_config.max_runs_per_day, 1);
  assert.equal(report.effective_test_config.max_provider_attempts, 3);
  assert.equal(fs.readFileSync(isolated.callMarker, 'utf8').trim().split(/\r?\n/).length, 1,
    'the copied Hermes adapter fake was invoked exactly once');

  const db = inspectStore(report);
  try {
    const scalar = sql => db.prepare(sql).get().n;
    const grant = db.prepare('SELECT id,status,max_attempts,revocation_reason FROM audience_attention_grants').get();
    assert.deepEqual(grant && { status:grant.status, max_attempts:grant.max_attempts, revocation_reason:grant.revocation_reason },
      { status:'revoked', max_attempts:1, revocation_reason:'Finite conformance ended.' });
    assert.equal(scalar('SELECT COUNT(*) AS n FROM audience_attention_attempts'), 1);
    assert.equal(scalar("SELECT COUNT(*) AS n FROM runs WHERE runtime='hermes-audience-v1' AND status='completed'"), 1);
    assert.equal(scalar("SELECT COUNT(*) AS n FROM audience_assessments WHERE status='proposed'"), 1);
    assert.equal(scalar('SELECT COUNT(*) AS n FROM audience_needs'), 0);
    for (const table of ['persons','contact_permissions','drafts','delivery_attempts','audience_work_links','action_proposals'])
      assert.equal(scalar(`SELECT COUNT(*) AS n FROM ${table}`), 0, `${table} has no side effects`);
    const receipt = JSON.parse(db.prepare("SELECT result_json FROM runs WHERE runtime='hermes-audience-v1'").get().result_json);
    assert.equal(receipt.model_api_calls, 1);
    assert.equal(receipt.model_identity.model_id, 'offline-cli-fixture');
    assert.equal(receipt.failure_cause, null);
  } finally { db.close(); }

  const summaryPath = path.join(isolated.root, '.cache', 'audience-conformance', 'summary.json');
  const history = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  assert.equal(history.provider_attempt_count, 1);
  assert.equal(history.attempts.length, 1);
  assert.equal(history.attempts[0].status, 'no_need_proposed');
  assert.equal(history.attempts[0].cost_status, 'unknown');
});

test('copied CLI refuses a history already at its provider cap before invoking the fake or adding a run', t => {
  const isolated = makeSandbox(t);
  const first = invoke(isolated);
  assert.equal(first.status, 0, first.stderr);
  const initialReport = JSON.parse(first.stdout);
  const db = inspectStore(initialReport);
  const countRuns = () => db.prepare("SELECT COUNT(*) AS n FROM runs WHERE runtime='hermes-audience-v1'").get().n;
  assert.equal(countRuns(), 1);
  const summaryPath = path.join(isolated.root, '.cache', 'audience-conformance', 'summary.json');
  const beforeCap = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const atCap = { ...beforeCap, provider_attempt_count:beforeCap.provider_attempt_cap };
  fs.writeFileSync(summaryPath, `${JSON.stringify(atCap, null, 2)}\n`);
  fs.writeFileSync(isolated.callMarker, '');

  const second = invoke(isolated);
  assert.equal(second.error, undefined, second.error?.message);
  assert.notEqual(second.status, 0);
  assert.equal(fs.readFileSync(isolated.callMarker, 'utf8'), '', 'provider cap rejects before the fake model call');
  assert.equal(countRuns(), 1, 'provider-cap refusal does not create another durable run');
  assert.deepEqual(JSON.parse(fs.readFileSync(summaryPath, 'utf8')), atCap, 'blocked retry does not reset or consume durable history');
  db.close();
});
