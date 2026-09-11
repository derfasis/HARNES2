import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { loadConfig, DATA, ROOT, runtimeReadiness } from '../business/config.mjs';
import {
  buildRouterContext,
  normalizeSituationInput,
  parseSituationOutput,
  ROUTER_INSTRUCTIONS,
} from '../business/situation-router.mjs';

if (process.env.SITUATION_ROUTER_MODEL_RUN !== '1') {
  throw new Error('Model run disabled. Set SITUATION_ROUTER_MODEL_RUN=1 only after explicit approval.');
}

const cfg = loadConfig();
const readiness = runtimeReadiness(cfg);
if (!readiness.ready) throw new Error(`Модель не готова: ${readiness.missing.join(', ')}`);
if (cfg.telegram.enabled || cfg.telegram.liveSending) throw new Error('Telegram должен быть выключен для Situation Router benchmark.');

const args = process.argv.slice(2);
const fixtureArgIndex = args.indexOf('--fixtures');
const fixtureDir = path.resolve(fixtureArgIndex >= 0 ? args[fixtureArgIndex + 1] : process.env.SITUATION_ROUTER_FIXTURES ?? path.join(ROOT, 'benchmarks/situation-router/synthetic'));
if (!fixtureDir || !fs.existsSync(fixtureDir) || !fs.statSync(fixtureDir).isDirectory()) throw new Error(`Каталог fixtures не найден: ${fixtureDir}`);

const fixtureFiles = fs.readdirSync(fixtureDir).filter(file => file.endsWith('.json')).sort();
if (!fixtureFiles.length) throw new Error('Каталог fixtures пуст.');
const fixtures = fixtureFiles.map(file => {
  const fullPath = path.join(fixtureDir, file);
  const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  const input = normalizeSituationInput(parsed, { maxMessageCharacters: cfg.context.maxMessageCharacters });
  return { file, input, context: buildRouterContext(input, { maxMessageCharacters: cfg.context.maxMessageCharacters }) };
});
if (new Set(fixtures.map(fixture => fixture.input.situation_id)).size !== fixtures.length) throw new Error('situation_id должен быть уникальным.');

const python = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const worker = path.join(ROOT, 'scripts/situation_router_worker.py');
const timeoutMs = cfg.runtime.timeoutSeconds * 1000 + 15000;
const maxOutputTokens = Number(process.env.SITUATION_ROUTER_MAX_OUTPUT_TOKENS ?? 700);
if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 300 || maxOutputTokens > 4000) throw new Error('SITUATION_ROUTER_MAX_OUTPUT_TOKENS должен быть от 300 до 4000.');

function runWorker(envelope) {
  return new Promise(resolve => {
    const child = spawn(python, [worker], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    });
    let stdout = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('error', error => resolve({ situation_id: envelope.situation_id, completed: false, error: error.message }));
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return resolve({ situation_id: envelope.situation_id, completed: false, error: 'Situation Router worker timeout' });
      try {
        const result = JSON.parse(stdout);
        if (code !== 0 && !result.error) result.error = `Situation Router worker exited with code ${code}`;
        resolve(result);
      } catch {
        resolve({ situation_id: envelope.situation_id, completed: false, error: 'Situation Router worker returned invalid JSON' });
      }
    });
    child.stdin.end(JSON.stringify(envelope));
  });
}

const startedAt = new Date().toISOString();
const results = [];
for (const [index, fixture] of fixtures.entries()) {
  process.stdout.write(`Situation ${index + 1}/${fixtures.length}: ${fixture.input.situation_id}\n`);
  const runId = randomUUID();
  const result = await runWorker({
    run_id: runId,
    situation_id: fixture.input.situation_id,
    include_prompt: index === 0,
    system_prompt: ROUTER_INSTRUCTIONS,
    context: fixture.context,
    model: { ...cfg.runtime, maxOutputTokens },
    tools: [],
  });
  const record = { file: fixture.file, input: fixture.input, ...result };
  if (result.completed && !result.error) {
    try {
      record.router_output = parseSituationOutput(result.final_response, fixture.input);
    } catch (error) {
      record.completed = false;
      record.error = `Invalid router output: ${error.message}`;
    }
  }
  if (result.tool_calls?.length) {
    record.completed = false;
    record.error = 'Router worker advertised or called an effect tool';
  }
  results.push(record);
}

const output = {
  schema_version: 1,
  benchmark: 'situation-router-v1',
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  fixture_dir: fixtureDir,
  fixture_count: fixtures.length,
  model: { provider: cfg.runtime.provider, model: cfg.runtime.model, api_mode: cfg.runtime.apiMode, base_url: cfg.runtime.baseUrl, max_output_tokens: maxOutputTokens },
  safety: {
    model_run_gate: true,
    telegram_enabled: cfg.telegram.enabled,
    telegram_live_sending: cfg.telegram.liveSending,
    business_db_mutations: false,
    effect_tools: false,
    retries: 0,
  },
  prompt: results.find(result => result.prompt)?.prompt ?? null,
  results,
};
const outputDir = path.join(DATA, 'benchmarks', 'situation-router');
fs.mkdirSync(outputDir, { recursive: true });
const outputFile = path.join(outputDir, `situation-router-${startedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}.json`);
fs.writeFileSync(outputFile, JSON.stringify(output, null, 2), 'utf8');
console.log(`Результаты сохранены: ${outputFile}`);
