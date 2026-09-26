// Stage 4D transport: a thin adapter over the existing worker. Nothing here reaches a network.
// proof_level=synthetic_contract_eval; live_proof=false.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../business/config.mjs';
import { ENVELOPE_KEYS, buildEnvelope, childEnvironment, createTransport, transportProblems }
  from '../docs/benchmarks/decision-quality-eval-v0/generation/transport.mjs';

const RUNTIME = { model: 'configured-model', provider: 'configured-provider', apiMode: 'chat',
  baseUrl: 'https://example.invalid/v1', maxOutputTokens: 2000, timeoutSeconds: 30 };
const WITH_CREDENTIAL = { PARTNER_MODEL_API_KEY: 'key' };

const stagedCase = {
  case_id: 'case-1',
  situation: { situation_id: 'sit-1', goal_text: 'Assess usefulness.', allowed_channels: ['public'] },
  subject: { author_id: 'user-02' },
  messages: [{ source_event_id: 'ev-1', author_id: 'user-02', version: 1, channel: 'public',
    direction: 'in', text: 'Как устроено партнёрство?', created_at: '2026-01-01T00:00:00.000Z',
    reply_to_id: null, is_anchor: true }],
  offer: 'Synthetic offer', operator_goal: 'Assess usefulness.', known_unknowns: [],
};

// A stand-in for the Python worker: it answers from a script and never opens a socket.
const fakeSpawn = (reply) => () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  child.stdin = { end: (payload) => {
    const body = typeof reply === 'function' ? reply(JSON.parse(payload)) : reply;
    child.stdout.emit('data', body);
    child.emit('close', 0);
  } };
  return child;
};

test('4D the transport refuses to call a runtime that is not actually ready', () => {
  assert.deepEqual(transportProblems(RUNTIME, WITH_CREDENTIAL), []);
  for (const key of ['model', 'provider', 'baseUrl', 'apiMode'])
    assert.ok(transportProblems({ ...RUNTIME, [key]: '' }, WITH_CREDENTIAL)
      .includes(`runtime_config_is_missing_${key}`));
  // The worker uses these directly, so they are checked with the same bounds as the config.
  for (const [key, value] of [['maxOutputTokens', 4], ['maxOutputTokens', 999999],
    ['timeoutSeconds', 1], ['timeoutSeconds', 99999], ['maxOutputTokens', 'many']])
    assert.ok(transportProblems({ ...RUNTIME, [key]: value }, WITH_CREDENTIAL)
      .some((problem) => problem.startsWith(`runtime_${key}_must_be`)), `${key}=${value}`);
  // A runtime with no model credential would spend an attempt and answer nothing.
  assert.ok(transportProblems(RUNTIME, {}).includes('no_model_credential_is_configured'));
});

test('4D the envelope matches what the real worker actually reads', () => {
  const envelope = buildEnvelope({ prompt: 'PROMPT', staged: stagedCase, runId: 'run-1', runtime: RUNTIME });
  assert.equal(envelope.run_id, 'run-1');
  assert.deepEqual(envelope.tools, [], 'this evaluation has no business surface at all');
  assert.equal(envelope.system_prompt, 'PROMPT', 'the prompt is the worker system prompt');
  assert.equal(envelope.situation_id, 'sit-1');
  assert.equal(envelope.context.messages[0].source_event_id, 'ev-1');
  assert.equal(envelope.model.model, 'configured-model');
  assert.equal(envelope.model.maxIterations, 1);
  // A fake worker accepts any shape, so the contract is checked against the worker's own source.
  const worker = fs.readFileSync(path.join(ROOT, 'scripts', 'situation_router_worker.py'), 'utf8');
  for (const key of ['run_id', 'situation_id', 'system_prompt', 'model', 'context'])
    assert.ok(worker.includes(`envelope["${key}"]`), `the worker must read envelope["${key}"]`);
  for (const key of ENVELOPE_KEYS) assert.ok(key in envelope, `the envelope must carry ${key}`);
});

test('4D credentials are passed through explicitly, never inherited wholesale', () => {
  const env = childEnvironment({ PATH: '/bin', PARTNER_MODEL_API_KEY: 'key',
    TELEGRAM_BOT_TOKEN: 'secret', CODEX_API_KEY: 'secret', HOME: '/home' });
  assert.equal(env.PARTNER_MODEL_API_KEY, 'key');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(env.CODEX_API_KEY, undefined);
  assert.equal(env.PYTHONUTF8, '1');
});

test('4D a worker that states which model answered is passed through verbatim', async () => {
  const transport = createTransport({ runtime: RUNTIME, runId: 'run-1', environment: WITH_CREDENTIAL,
    spawnFn: fakeSpawn(() => JSON.stringify({ completed: true, final_response: '{"answer":1}',
      model_identity: { model_id: 'served-model', model_version: 'served-2026-02' } })) });
  const answer = await transport({ prompt: 'PROMPT', staged: stagedCase });
  assert.equal(answer.model_id, 'served-model');
  assert.equal(answer.model_version, 'served-2026-02');
  assert.equal(answer.raw, '{"answer":1}');
  assert.equal(answer.transport_problems, undefined);
});

test('4D a worker that cannot say which model answered is refused, not annotated', async () => {
  // This is today's worker: it reports completion and usage, but not the served identity.
  const transport = createTransport({ runtime: RUNTIME, runId: 'run-1', environment: WITH_CREDENTIAL,
    spawnFn: fakeSpawn(JSON.stringify({ completed: true, final_response: '{"answer":1}',
      model_identity: null, model_identity_reason: 'runtime_did_not_expose_a_served_model_identity',
      usage: { input_tokens: 10, output_tokens: 5 } })) });
  const answer = await transport({ prompt: 'PROMPT', staged: stagedCase });
  assert.deepEqual(answer.transport_problems, ['runtime_did_not_expose_a_served_model_identity']);
  assert.equal(answer.model_id, null);
});

test('4D a failed or unreadable worker is reported, never guessed at', async () => {
  const incomplete = createTransport({ runtime: RUNTIME, runId: 'run-1', environment: WITH_CREDENTIAL,
    spawnFn: fakeSpawn(JSON.stringify({ completed: false, error: 'rate_limit' })) });
  assert.deepEqual((await incomplete({ prompt: 'P', staged: stagedCase })).transport_problems,
    ['worker_reported_no_completed_response']);
  const noisy = createTransport({ runtime: RUNTIME, runId: 'run-1', environment: WITH_CREDENTIAL,
    spawnFn: fakeSpawn('not json at all') });
  await assert.rejects(noisy({ prompt: 'P', staged: stagedCase }), { message: 'worker_output_is_not_json' });
  const unconfigured = createTransport({ runtime: {}, environment: WITH_CREDENTIAL, spawnFn: fakeSpawn('{}') });
  const answer = await unconfigured({ prompt: 'P', staged: stagedCase });
  assert.ok(answer.transport_problems.includes('runtime_config_is_missing_model'));
  assert.equal(answer.raw, null);
});

test('4D the worker reports a served model identity and never one taken from configuration', () => {
  const worker = fs.readFileSync(path.join(ROOT, 'scripts', 'situation_router_worker.py'), 'utf8');
  assert.match(worker, /def served_identity/);
  assert.match(worker, /"model_identity": identity/);
  // The identity must be read from the result or the agent, never from the configured model name.
  const body = worker.slice(worker.indexOf('def served_identity'), worker.indexOf('def main'));
  assert.ok(!body.includes('envelope'), 'the identity may not come from the envelope configuration');
  assert.ok(!body.includes('cfg'), 'the identity may not come from cfg');
  const py = fs.readFileSync(path.join(ROOT, 'scripts', 'situation_router_worker.py'), 'utf8');
  assert.ok(!/model_identity.*envelope\["model"\]/.test(py), 'no fallback to the configured model');
});

test('4D the transport reuses the existing worker and adds no second one', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'situation_router_worker.py')),
    'the transport reuses the existing isolated worker rather than adding a second one');
  const directory = path.join(ROOT, 'docs', 'benchmarks', 'decision-quality-eval-v0', 'generation');
  const added = fs.readdirSync(directory).filter((name) => name.endsWith('.py'));
  assert.deepEqual(added, [], 'no Python is introduced by the transport');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-transport-'));
  fs.rmSync(temp, { recursive: true, force: true });
});
