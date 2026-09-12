import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DATA = path.join(ROOT, 'data');
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const merge = (a, b) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(key => [key,
  b[key] && typeof b[key] === 'object' && !Array.isArray(b[key]) && a[key] && typeof a[key] === 'object'
    ? merge(a[key], b[key]) : b[key] === undefined ? a[key] : b[key]]));
export function loadConfig() {
  const file = path.join(ROOT, 'config/local.json');
  const cfg = merge(readJson(path.join(ROOT, 'config/default.json')), fs.existsSync(file) ? readJson(file) : {});
  if (cfg.server.host !== '127.0.0.1') throw new Error('This local release binds only to 127.0.0.1.');
  for (const [name, value, min, max] of [
    ['port', cfg.server.port, 1024, 65535], ['tickSeconds', cfg.scheduler.tickSeconds, 5, 3600],
    ['maxIterations', cfg.runtime.maxIterations, 1, 50], ['timeoutSeconds', cfg.runtime.timeoutSeconds, 10, 1800],
    ['maxOutputTokens', cfg.runtime.maxOutputTokens, 128, 16000], ['maxRunsPerDay', cfg.runtime.maxRunsPerDay, 1, 1000],
    ['maxRecentMessages', cfg.context.maxRecentMessages, 1, 200], ['maxLessons', cfg.context.maxLessons, 0, 20],
    ['maxMessageCharacters', cfg.context.maxMessageCharacters, 100, 16000],
    ['planningHour', cfg.scheduler.planningHour, 0, 23], ['pollSeconds', cfg.telegram.pollSeconds, 1, 50]
  ]) if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  new Intl.DateTimeFormat('en', { timeZone: cfg.scheduler.timezone }).format();
  for (const name of ['dailyBudgetUsd', 'inputUsdPerMillion', 'outputUsdPerMillion']) {
    const value = cfg.runtime[name];
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new Error(`Invalid ${name}`);
  }
  if (!Array.isArray(cfg.telegram.allowedChatIds) || cfg.telegram.allowedChatIds.some(id => !/^-?\d+$/.test(String(id)))) throw new Error('Invalid allowedChatIds');
  if (!['bot_api', 'mtproto'].includes(cfg.telegram.transport)) throw new Error('Invalid Telegram transport');
  if (cfg.runtime.adapter !== 'hermes') throw new Error('Only the Hermes adapter is implemented.');
  if (cfg.runtime.baseUrl) {
    const url = new URL(cfg.runtime.baseUrl);
    if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Model URL must use HTTPS, or local HTTP, without credentials/query.');
  }
  if (typeof cfg.opportunity?.automatic !== 'boolean') throw new Error('Invalid opportunity.automatic');
  if (cfg.opportunity.automatic && (cfg.runtime.enabled !== false || cfg.telegram.enabled !== false || cfg.telegram.liveSending !== false))
    throw new Error('Automatic opportunity prerequisite requires runtime and Telegram disabled.');
  return cfg;
}
export function runtimeReadiness(cfg, { decision = false } = {}) {
  const missing = [];
  if (decision ? !cfg.opportunity?.automatic : !cfg.runtime.enabled) missing.push(decision ? 'opportunity.automatic' : 'runtime.enabled');
  if (!cfg.runtime.model) missing.push('runtime.model');
  if (!cfg.runtime.baseUrl) missing.push('runtime.baseUrl');
  if (!process.env.PARTNER_MODEL_API_KEY) missing.push('PARTNER_MODEL_API_KEY');
  if (!fs.existsSync(path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'))) missing.push('Python environment');
  return { ready: missing.length === 0, missing };
}

// Shared accounting for ordinary and no-tool runs; unknown is never treated as free.
export function usageAccounting(runtime, usage = {}) {
  usage = usage ?? {};
  const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const input = numeric(usage.input_tokens), output = numeric(usage.output_tokens);
  let cost = null, costStatus = 'unknown';
  if (usage.cost_status && usage.cost_status !== 'unknown' && numeric(usage.estimated_cost_usd) !== null) {
    cost = usage.estimated_cost_usd; costStatus = 'runtime_estimate';
  } else if (input !== null && output !== null && numeric(runtime.inputUsdPerMillion) !== null && numeric(runtime.outputUsdPerMillion) !== null) {
    cost = (input * runtime.inputUsdPerMillion + output * runtime.outputUsdPerMillion) / 1e6; costStatus = 'configured_estimate';
  }
  return { input, output, cost, costStatus };
}
