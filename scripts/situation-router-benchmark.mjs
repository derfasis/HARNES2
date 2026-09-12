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
import { buildOpportunityContext, parseOpportunityOutput, PROJECTION_INSTRUCTIONS } from '../business/opportunity-projection.mjs';

if (process.env.SITUATION_ROUTER_MODEL_RUN !== '1') {
  throw new Error('Model run disabled. Set SITUATION_ROUTER_MODEL_RUN=1 only after explicit approval.');
}

const cfg = loadConfig();
const readiness = runtimeReadiness(cfg);
if (!readiness.ready) throw new Error(`Модель не готова: ${readiness.missing.join(', ')}`);
if (cfg.telegram.enabled || cfg.telegram.liveSending) throw new Error('Telegram должен быть выключен для Situation Router benchmark.');

const args = process.argv.slice(2);
function optionValue(name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} требует путь.`);
  return value;
}

const fixtureArg = optionValue('--fixtures');
const manifestArg = optionValue('--manifest');
const projectionMode = args.includes('--opportunity-v0');
const allowedSource = optionValue('--allowed-source');
if (projectionMode && (manifestArg || !allowedSource)) throw new Error('Opportunity v0 requires --allowed-source and does not use the frozen v1 manifest.');
if (!projectionMode && allowedSource) throw new Error('--allowed-source requires --opportunity-v0.');
if (fixtureArg && manifestArg) throw new Error('Используйте только один из --fixtures или --manifest.');

let fixtureDir = null;
let manifestPath = null;
let controlManifest = null;
let fixtureSpecs;
if (manifestArg) {
  manifestPath = path.resolve(manifestArg);
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) throw new Error(`Manifest не найден: ${manifestPath}`);
  controlManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (controlManifest.schema_version !== 1 || typeof controlManifest.control_id !== 'string' || !controlManifest.frozen) {
    throw new Error('Control manifest должен иметь schema_version=1, control_id и frozen=true.');
  }
  if (!Array.isArray(controlManifest.cases) || !controlManifest.cases.length) throw new Error('Control manifest не содержит cases.');
  const decisions = new Set(['IGNORE', 'WAIT', 'PUBLIC_REPLY', 'DM', 'HANDOFF']);
  fixtureSpecs = controlManifest.cases.map(entry => {
    if (!entry || typeof entry !== 'object' || typeof entry.case_id !== 'string' || typeof entry.fixture !== 'string') {
      throw new Error('Каждый control case должен содержать case_id и fixture.');
    }
    if (path.isAbsolute(entry.fixture)) throw new Error(`Control fixture должен быть ROOT-relative: ${entry.fixture}`);
    if (!Array.isArray(entry.expected_decisions) || !entry.expected_decisions.length || entry.expected_decisions.some(decision => !decisions.has(decision))) {
      throw new Error(`Некорректные expected_decisions для ${entry.case_id}.`);
    }
    const fullPath = path.resolve(ROOT, entry.fixture);
    const relative = path.relative(ROOT, fullPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Control fixture выходит за пределы workspace: ${entry.fixture}`);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) throw new Error(`Control fixture не найден: ${entry.fixture}`);
    return {
      file: entry.fixture.replaceAll('\\', '/'),
      fullPath,
      control: {
        case_id: entry.case_id,
        expected_decisions: [...entry.expected_decisions],
        purpose: typeof entry.purpose === 'string' ? entry.purpose : '',
      },
    };
  });
  if (new Set(fixtureSpecs.map(spec => spec.control.case_id)).size !== fixtureSpecs.length) throw new Error('case_id в control manifest должны быть уникальны.');
} else {
  const defaultFixtures = projectionMode ? 'benchmarks/opportunity-projection-v0' : 'benchmarks/situation-router/synthetic';
  fixtureDir = path.resolve(fixtureArg ?? process.env.SITUATION_ROUTER_FIXTURES ?? path.join(ROOT, defaultFixtures));
  if (!fs.existsSync(fixtureDir) || !fs.statSync(fixtureDir).isDirectory()) throw new Error(`Каталог fixtures не найден: ${fixtureDir}`);
  const fixtureFiles = fs.readdirSync(fixtureDir).filter(file => file.endsWith('.json')).sort();
  if (!fixtureFiles.length) throw new Error('Каталог fixtures пуст.');
  fixtureSpecs = fixtureFiles.map(file => ({ file, fullPath: path.join(fixtureDir, file), control: null }));
}

const fixtures = fixtureSpecs.map(({ file, fullPath, control }) => {
  const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  if (projectionMode) {
    const context = buildOpportunityContext(parsed, { allowedSourceRefs: [allowedSource] });
    return { file, control, input: context.input, context };
  }
  const input = normalizeSituationInput(parsed, { maxMessageCharacters: cfg.context.maxMessageCharacters });
  return { file, control, input, context: buildRouterContext(input, { maxMessageCharacters: cfg.context.maxMessageCharacters }) };
});
if (new Set(fixtures.map(fixture => fixture.input.situation_id)).size !== fixtures.length) throw new Error('situation_id должен быть уникальным.');

const python = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const worker = path.join(ROOT, 'scripts/situation_router_worker.py');
const timeoutMs = cfg.runtime.timeoutSeconds * 1000 + 15000;
const maxOutputTokens = Number(process.env.SITUATION_ROUTER_MAX_OUTPUT_TOKENS ?? (projectionMode ? 1400 : 700));
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
    system_prompt: projectionMode ? `${ROUTER_INSTRUCTIONS} ${PROJECTION_INSTRUCTIONS}` : ROUTER_INSTRUCTIONS,
    context: fixture.context,
    model: { ...cfg.runtime, ...(projectionMode ? { maxIterations: 1 } : {}), maxOutputTokens },
    tools: [],
  });
  const record = {
    file: fixture.file,
    ...(fixture.control ? { control: fixture.control } : {}),
    input: fixture.input,
    ...(projectionMode ? { projection_context: fixture.context } : {}),
    ...result,
  };
  if (result.completed && !result.error) {
    try {
      if (projectionMode) {
        record.opportunity_projection = parseOpportunityOutput(result.final_response, fixture.context);
        record.router_output = record.opportunity_projection.next_action;
      } else record.router_output = parseSituationOutput(result.final_response, fixture.input);
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
  benchmark: projectionMode ? 'opportunity-projection-v0' : 'situation-router-v1',
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  fixture_dir: fixtureDir,
  fixture_manifest: manifestPath,
  control_id: controlManifest?.control_id ?? null,
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
