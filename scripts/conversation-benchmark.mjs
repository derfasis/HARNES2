import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { BusinessService } from '../business/service.mjs';
import { contextFor } from '../business/context.mjs';
import { loadConfig, DATA, ROOT, readJson, runtimeReadiness } from '../business/config.mjs';
import { hash } from '../business/store.mjs';
import { toolDefinitions } from '../business/tools.mjs';

const cfg = loadConfig();
const benchmarkLabel = process.env.CONVERSATION_BENCHMARK_LABEL ?? 'conversation-brain-v1';
const readiness = runtimeReadiness(cfg);
if (!readiness.ready) throw new Error(`Модель не готова: ${readiness.missing.join(', ')}`);
if (cfg.telegram.enabled || cfg.telegram.liveSending) throw new Error('Для офлайн-бенчмарка Telegram должен быть выключен.');

const scenarioFile = path.join(ROOT, 'benchmarks/conversation-brain-v1.scenarios.json');
const allScenarios = readJson(scenarioFile);
if (!Array.isArray(allScenarios) || allScenarios.length !== 20) throw new Error('Нужно ровно 20 benchmark-сценариев.');
const requestedScenarioIds = (process.env.CONVERSATION_BENCHMARK_SCENARIOS ?? '')
  .split(',').map(id => id.trim()).filter(Boolean);
if (new Set(requestedScenarioIds).size !== requestedScenarioIds.length) throw new Error('Benchmark-сценарии не должны повторяться.');
const scenarioRows = requestedScenarioIds.length
  ? requestedScenarioIds.map(id => {
    const sourceIndex = allScenarios.findIndex(scenario => scenario.id === id);
    if (sourceIndex < 0) throw new Error(`Неизвестный benchmark-сценарий: ${id}`);
    return { scenario: allScenarios[sourceIndex], sourceIndex };
  })
  : allScenarios.map((scenario, sourceIndex) => ({ scenario, sourceIndex }));
const benchmarkMaxOutputTokens = Number(process.env.CONVERSATION_BENCHMARK_MAX_OUTPUT_TOKENS ?? 400);
if (!Number.isInteger(benchmarkMaxOutputTokens) || benchmarkMaxOutputTokens < 300 || benchmarkMaxOutputTokens > 500) {
  throw new Error('Offline benchmark maxOutputTokens должен быть от 300 до 500.');
}
const stopOn402 = process.env.CONVERSATION_BENCHMARK_STOP_ON_402 === '1';

const dbPath = path.join(DATA, 'partner.sqlite');
if (!fs.existsSync(dbPath)) throw new Error('Нет текущей базы партнёра: сначала запусти приложение и создай её.');
const db = new DatabaseSync(dbPath, { readOnly: true });
db.exec('PRAGMA query_only=ON');
const readStore = {
  get: (sql, ...params) => db.prepare(sql).get(...params),
  all: (sql, ...params) => db.prepare(sql).all(...params),
};
const service = new BusinessService(readStore, cfg);
const tools = toolDefinitions({ kind: 'agent', runId: 'offline-benchmark', conversationId: 'benchmark-conversation' });
const python = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const worker = path.join(ROOT, 'scripts', 'conversation_benchmark_worker.py');
const timeoutMs = (cfg.runtime.timeoutSeconds * 1000) + 15000;

function scenarioContext(scenario, index) {
  const task = {
    id: `benchmark-task-${String(index + 1).padStart(2, '0')}`,
    conversation_id: 'benchmark-conversation',
    kind: 'reply',
    title: `Offline benchmark: ${scenario.title}`,
    instructions: 'Разбери последнее входящее сообщение и выбери естественный следующий шаг. Сформулируй адресованный ответ без корпоративной презентации. Если уместен ответ адресату, предложи его через partner_propose_draft; офлайн-бенчмарк не сохраняет предложения.',
    due_at: '2026-09-10T00:00:00.000Z',
    status: 'running',
    evidence: `benchmark:${scenario.id}`,
  };
  const base = contextFor(service, null, task);
  const recruitingSkill = fs.readFileSync(path.join(ROOT, 'partner/skills/recruiting/SKILL.md'), 'utf8');
  base.skills = [{ name: 'recruiting', content: recruitingSkill, sha256: hash(recruitingSkill) }, ...base.skills.slice(1)];
  delete base.work;
  delete base.contacts;
  const messages = scenario.messages.map((text, messageIndex) => ({
    id: `benchmark-message-${String(index + 1).padStart(2, '0')}-${messageIndex + 1}`,
    direction: 'in', author: 'person', text, source: 'offline_benchmark',
    created_at: `2026-09-10T00:${String(index).padStart(2, '0')}:00.000Z`,
  }));
  return {
    ...base,
    generated_at: '2026-09-10T00:00:00.000Z',
    task,
    conversation: {
      id: 'benchmark-conversation', person_id: 'benchmark-person', channel: 'telegram',
      ownership: 'AI_OWNED', mode: 'REVIEW', stage: 'new', revision: 1,
    },
    person: {
      id: 'benchmark-person', name: 'Алексей (benchmark)', source: 'offline benchmark fixture',
      permission: 'offline benchmark only; no contact permission', suppressed: 0,
    },
    messages,
    facts: [],
    tasks: [task],
    lessons: [],
  };
}

function runWorker(envelope) {
  return new Promise((resolve) => {
    const child = spawn(python, [worker], {
      cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    });
    let stdout = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('error', error => resolve({ scenario_id: envelope.scenario_id, completed: false, error: error.message }));
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return resolve({ scenario_id: envelope.scenario_id, completed: false, error: 'Benchmark worker timeout' });
      try {
        const result = JSON.parse(stdout);
        if (code !== 0 && !result.error) result.error = `Benchmark worker exited with code ${code}`;
        resolve(result);
      } catch {
        resolve({ scenario_id: envelope.scenario_id, completed: false, error: 'Benchmark worker returned invalid JSON' });
      }
    });
    child.stdin.end(JSON.stringify(envelope));
  });
}

const startedAt = new Date().toISOString();
const results = [];
for (const [index, { scenario, sourceIndex }] of scenarioRows.entries()) {
  process.stdout.write(`Сценарий ${index + 1}/${scenarioRows.length}: ${scenario.title}\n`);
  const envelope = {
    run_id: randomUUID(), scenario_id: scenario.id, include_prompt: index === 0,
    context: scenarioContext(scenario, sourceIndex),
    model: { ...cfg.runtime, maxOutputTokens: benchmarkMaxOutputTokens }, tools,
  };
  const result = await runWorker(envelope);
  results.push(result);
  if (stopOn402 && /HTTP 402/.test(result.error ?? '')) {
    process.stdout.write('Остановка после HTTP 402 по запросу benchmark.\n');
    break;
  }
}
db.close();

const prompt = results.find(result => result.prompt)?.prompt ?? null;
const size = value => ({ chars: value?.length ?? 0, utf8_bytes: Buffer.byteLength(value ?? '', 'utf8') });
const output = {
  schema_version: 1,
  benchmark: benchmarkLabel,
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  requested_scenario_count: scenarioRows.length,
  scenario_count: results.length,
  scenario_ids: results.map(result => result.scenario_id),
  model: { provider: cfg.runtime.provider, model: cfg.runtime.model, api_mode: cfg.runtime.apiMode, base_url: cfg.runtime.baseUrl, max_output_tokens: benchmarkMaxOutputTokens },
  safety: { telegram_enabled: cfg.telegram.enabled, telegram_live_sending: cfg.telegram.liveSending, business_db_mutations: false, tool_effects: false },
  prompt_sizes: prompt ? {
    hermes_base_system: size(prompt.hermes_base_system),
    partner_ephemeral_system: size(prompt.partner_ephemeral_system),
    effective_system: size(prompt.effective_system),
    user_context: size(prompt.user_context),
    tool_schemas: size(JSON.stringify(prompt.tool_schemas)),
  } : null,
  prompt,
  results,
};
const outputDir = path.join(DATA, 'benchmarks');
fs.mkdirSync(outputDir, { recursive: true });
const outputFile = path.join(outputDir, `${benchmarkLabel}-${startedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}.json`);
fs.writeFileSync(outputFile, JSON.stringify(output, null, 2), 'utf8');
console.log(`Результаты сохранены: ${outputFile}`);
