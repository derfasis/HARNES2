import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { BusinessService } from '../business/service.mjs';
import { contextFor } from '../business/context.mjs';
import { DATA, ROOT, loadConfig, readJson } from '../business/config.mjs';
import { hash } from '../business/store.mjs';
import { toolDefinitions } from '../business/tools.mjs';

const fixtureFile = path.join(ROOT, 'benchmarks/conversation-brain-multiturn.fixture.json');
const workerFile = path.join(ROOT, 'scripts/conversation_benchmark_worker.py');
const python = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const maxOutputTokens = 400;

function validateFixture(fixture) {
  if (fixture?.schema_version !== 1 || typeof fixture.id !== 'string' || !fixture.id) {
    throw new Error('Invalid multi-turn benchmark fixture metadata.');
  }
  if (!fixture.conversation || !fixture.person || fixture.conversation.person_id !== fixture.person.id) {
    throw new Error('Fixture conversation and person do not match.');
  }
  if (!Array.isArray(fixture.turns) || fixture.turns.length !== 6
    || fixture.turns.some(turn => typeof turn?.inbound !== 'string' || !turn.inbound.trim())) {
    throw new Error('The multi-turn fixture must contain exactly six non-empty inbound turns.');
  }
  if (!Number.isFinite(Date.parse(fixture.started_at))) throw new Error('Fixture started_at must be an ISO timestamp.');
}

function assertOfflineModelRun(cfg) {
  if (process.env.CONVERSATION_MULTITURN_ALLOW_MODEL !== '1') {
    throw new Error('Set CONVERSATION_MULTITURN_ALLOW_MODEL=1 only for an explicitly approved model run.');
  }
  if (cfg.runtime.enabled) throw new Error('Product runtime must remain disabled for the multi-turn benchmark.');
  if (cfg.telegram.enabled || cfg.telegram.liveSending) throw new Error('Telegram must remain disabled for the multi-turn benchmark.');
  if (!cfg.runtime.model || !cfg.runtime.baseUrl || !process.env.PARTNER_MODEL_API_KEY) {
    throw new Error('Offline model configuration is incomplete.');
  }
  if (!fs.existsSync(python)) throw new Error('Python environment is missing.');
}

function stateSnapshot(conversation, messages) {
  return {
    messages_count: messages.length,
    inbound_count: messages.filter(message => message.direction === 'in').length,
    outbound_count: messages.filter(message => message.direction === 'out').length,
    stage: conversation.stage,
    ownership: conversation.ownership,
    mode: conversation.mode,
    revision: conversation.revision,
    last_message: messages.length ? {
      id: messages.at(-1).id,
      direction: messages.at(-1).direction,
      author: messages.at(-1).author,
    } : null,
  };
}

function timestampAt(startedAt, turnIndex, offsetMinutes) {
  return new Date(Date.parse(startedAt) + ((turnIndex * 5) + offsetMinutes) * 60_000).toISOString();
}

function parseDraft(result) {
  const draftCalls = (result.tool_calls ?? [])
    .filter(call => call?.function?.name === 'partner_propose_draft');
  if (draftCalls.length !== 1) {
    throw new Error(`Expected exactly one partner_propose_draft call, received ${draftCalls.length}.`);
  }
  const rawArguments = draftCalls[0].function.arguments;
  const draft = typeof rawArguments === 'string' ? JSON.parse(rawArguments) : rawArguments;
  if (!draft || typeof draft.text !== 'string' || !draft.text.trim()) {
    throw new Error('partner_propose_draft did not contain usable text.');
  }
  return { ...draft, text: draft.text.trim() };
}

function runWorker(envelope, timeoutMs) {
  return new Promise(resolve => {
    const child = spawn(python, [workerFile], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    });
    let stdout = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('error', error => resolve({ completed: false, error: error.message }));
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return resolve({ completed: false, error: 'Benchmark worker timeout' });
      try {
        const result = JSON.parse(stdout);
        if (code !== 0 && !result.error) result.error = `Benchmark worker exited with code ${code}`;
        resolve(result);
      } catch {
        resolve({ completed: false, error: 'Benchmark worker returned invalid JSON' });
      }
    });
    child.stdin.end(JSON.stringify(envelope));
  });
}

function buildContext(service, fixture, task, transcript, recruitingSkill) {
  const base = contextFor(service, null, task);
  base.skills = [
    { name: 'recruiting', content: recruitingSkill, sha256: hash(recruitingSkill) },
    ...base.skills.slice(1),
  ];
  delete base.work;
  delete base.contacts;
  return {
    ...base,
    generated_at: fixture.started_at,
    task,
    conversation: { ...fixture.conversation },
    person: { ...fixture.person },
    messages: transcript.map(message => ({ ...message })),
    facts: [],
    tasks: [task],
    lessons: [],
  };
}

function promptSizes(prompt) {
  if (!prompt) return null;
  const size = value => ({ chars: value?.length ?? 0, utf8_bytes: Buffer.byteLength(value ?? '', 'utf8') });
  return {
    hermes_base_system: size(prompt.hermes_base_system),
    partner_ephemeral_system: size(prompt.partner_ephemeral_system),
    effective_system: size(prompt.effective_system),
    user_context: size(prompt.user_context),
    tool_schemas: size(JSON.stringify(prompt.tool_schemas)),
  };
}

function totalUsage(turns, key) {
  const values = turns.map(turn => turn.raw_result?.usage?.[key]).filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

const cfg = loadConfig();
const fixture = readJson(fixtureFile);
validateFixture(fixture);
assertOfflineModelRun(cfg);

const dbFile = path.join(DATA, 'partner.sqlite');
if (!fs.existsSync(dbFile)) throw new Error('Partner database is missing.');
const db = new DatabaseSync(dbFile, { readOnly: true });
db.exec('PRAGMA query_only=ON');
const readStore = {
  get: (sql, ...params) => db.prepare(sql).get(...params),
  all: (sql, ...params) => db.prepare(sql).all(...params),
};
const service = new BusinessService(readStore, cfg);
const recruitingSkill = fs.readFileSync(path.join(ROOT, 'partner/skills/recruiting/SKILL.md'), 'utf8');
const tools = toolDefinitions({
  kind: 'agent',
  runId: 'offline-multiturn-benchmark',
  conversationId: fixture.conversation.id,
});
const timeoutMs = (cfg.runtime.timeoutSeconds * 1000) + 15_000;
const startedAt = new Date().toISOString();
const transcript = [];
const turns = [];
let failure = null;

try {
  for (const [turnIndex, fixtureTurn] of fixture.turns.entries()) {
    const turnNumber = turnIndex + 1;
    const inbound = {
      id: `benchmark-in-${String(turnNumber).padStart(2, '0')}`,
      direction: 'in',
      author: 'person',
      text: fixtureTurn.inbound.trim(),
      source: 'offline_benchmark',
      created_at: timestampAt(fixture.started_at, turnIndex, 0),
    };
    transcript.push(inbound);
    const stateBefore = stateSnapshot(fixture.conversation, transcript);
    const task = {
      id: `benchmark-task-${String(turnNumber).padStart(2, '0')}`,
      conversation_id: fixture.conversation.id,
      kind: 'reply',
      title: 'Offline multi-turn conversation review',
      instructions: 'Review the latest inbound message in the full conversation and choose the natural next step. If an addressed response is appropriate, propose it with partner_propose_draft. The offline benchmark does not save or send proposals.',
      due_at: timestampAt(fixture.started_at, turnIndex, 0),
      status: 'running',
      evidence: 'offline_benchmark_fixture',
    };
    const envelope = {
      run_id: randomUUID(),
      scenario_id: `multiturn-${String(turnNumber).padStart(2, '0')}`,
      include_prompt: turnIndex === 0,
      context: buildContext(service, fixture, task, transcript, recruitingSkill),
      model: { ...cfg.runtime, maxOutputTokens },
      tools,
    };

    process.stdout.write(`Turn ${turnNumber}/${fixture.turns.length}\n`);
    const rawResult = await runWorker(envelope, timeoutMs);
    const turn = {
      turn: turnNumber,
      inbound: fixtureTurn.inbound.trim(),
      state_before: stateBefore,
      draft: null,
      partial_draft_observed: false,
      partial_draft: null,
      state_after: stateSnapshot(fixture.conversation, transcript),
      raw_result: rawResult,
    };
    turns.push(turn);

    if (!rawResult.completed) {
      try {
        turn.partial_draft = parseDraft(rawResult);
        turn.partial_draft_observed = true;
      } catch {}
      failure = { turn: turnNumber, error: rawResult.error ?? 'Worker did not complete.' };
      break;
    }

    try {
      turn.draft = parseDraft(rawResult);
    } catch (error) {
      failure = { turn: turnNumber, error: error.message };
      break;
    }

    transcript.push({
      id: `benchmark-out-${String(turnNumber).padStart(2, '0')}`,
      direction: 'out',
      author: 'agent_assisted',
      text: turn.draft.text,
      source: 'offline_benchmark_draft',
      created_at: timestampAt(fixture.started_at, turnIndex, 1),
    });
    turn.state_after = stateSnapshot(fixture.conversation, transcript);
  }
} finally {
  db.close();
}

const firstPrompt = turns.find(turn => turn.raw_result?.prompt)?.raw_result.prompt ?? null;
const finishedAt = new Date().toISOString();
const report = {
  schema_version: 1,
  benchmark: 'conversation-brain-multiturn',
  fixture: { file: path.relative(ROOT, fixtureFile), id: fixture.id, title: fixture.title },
  started_at: startedAt,
  finished_at: finishedAt,
  completed: !failure && turns.length === fixture.turns.length,
  completed_turn_count: turns.filter(turn => turn.draft).length,
  requested_turn_count: fixture.turns.length,
  partial_draft_observed: turns.some(turn => turn.partial_draft_observed),
  failure,
  model: {
    provider: cfg.runtime.provider,
    model: cfg.runtime.model,
    api_mode: cfg.runtime.apiMode,
    base_url: cfg.runtime.baseUrl,
    max_output_tokens: maxOutputTokens,
  },
  safety: {
    product_runtime_enabled: cfg.runtime.enabled,
    product_runtime_modified: false,
    telegram_enabled: cfg.telegram.enabled,
    telegram_live_sending: cfg.telegram.liveSending,
    business_database_mode: 'read_only',
    business_database_mutations: false,
    tool_effects: false,
    transport_calls: false,
    harness_retries: 0,
  },
  usage: {
    input_tokens: totalUsage(turns, 'input_tokens'),
    output_tokens: totalUsage(turns, 'output_tokens'),
    estimated_cost_usd: totalUsage(turns, 'estimated_cost_usd'),
  },
  prompt_sizes: promptSizes(firstPrompt),
  transcript,
  turns,
};

const outputDir = path.join(DATA, 'benchmarks');
fs.mkdirSync(outputDir, { recursive: true });
const outputFile = path.join(outputDir, `conversation-brain-multiturn-${startedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}.json`);
fs.writeFileSync(outputFile, JSON.stringify(report, null, 2), 'utf8');
console.log(`Report saved: ${outputFile}`);
if (failure) process.exitCode = 1;
