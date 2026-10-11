import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const BUNDLE = 'experiments/commercial-task-fidelity-v1';
const BASELINE = 'd74329d7c027c2cf1a924788ff57fcd3370ac6a9';
const EXPECTED_FILES = [
  'benchmarks/commercial-task-fidelity-v1/cases.json',
  'benchmarks/commercial-task-fidelity-v1/gold.json',
  `${BUNDLE}/prompts/A.md`,
  `${BUNDLE}/prompts/B.md`,
  'partner/audience-reasoning.md',
  'contracts/audience-assessment.schema.json',
  'business/audience-reasoning.mjs',
  'business/runtime.mjs',
  'scripts/situation_router_worker.py',
].sort();
const MAX_MANIFEST_BYTES = 100_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_B_SUFFIX = 1200;
const check = (condition, code) => { if (!condition) throw new TypeError(code); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const normalizeLf = text => text.replace(/\r\n?/g, '\n');
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const nonempty = (value, max = 2000) => typeof value === 'string' && value.length > 0
  && value.length <= max && value.trim().length > 0;
const id = value => typeof value === 'string' && /^[A-Za-z0-9][\w.:-]{0,99}$/.test(value);
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function decodeUtf8(bytes, code) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new TypeError(code); }
}

function readBounded(repoRoot, relative, limit = MAX_FILE_BYTES) {
  check(typeof relative === 'string' && relative.length > 0 && !relative.includes('\\')
    && !path.isAbsolute(relative) && !relative.split('/').some(part => !part || part === '.' || part === '..'),
  'FROZEN_PATH_INVALID');
  const target = path.resolve(repoRoot, ...relative.split('/'));
  const relativeTarget = path.relative(repoRoot, target);
  check(relativeTarget && !relativeTarget.startsWith(`..${path.sep}`) && relativeTarget !== '..'
    && !path.isAbsolute(relativeTarget), 'FROZEN_PATH_INVALID');
  let real;
  try { real = fs.realpathSync(target); } catch { throw new TypeError('FROZEN_FILE_MISSING'); }
  const realRelative = path.relative(repoRoot, real);
  check(realRelative && !realRelative.startsWith(`..${path.sep}`) && realRelative !== '..'
    && !path.isAbsolute(realRelative), 'FROZEN_PATH_INVALID');
  let stat;
  try { stat = fs.statSync(real); } catch { throw new TypeError('FROZEN_FILE_MISSING'); }
  check(stat.isFile() && stat.size <= limit, 'FROZEN_FILE_SIZE_INVALID');
  let bytes;
  try { bytes = fs.readFileSync(real); } catch { throw new TypeError('FROZEN_FILE_MISSING'); }
  check(bytes.length <= limit, 'FROZEN_FILE_SIZE_INVALID');
  return { bytes, text: decodeUtf8(bytes, 'FROZEN_FILE_UTF8_INVALID') };
}

function parseJson(text, code) {
  try { return JSON.parse(text); } catch { throw new TypeError(code); }
}

function validateManifest(manifest) {
  check(exactKeys(manifest, ['version', 'baseline_sha', 'max_logical_attempts', 'files'])
    && manifest.version === 1 && manifest.baseline_sha === BASELINE
    && manifest.max_logical_attempts === 8, 'FIDELITY_MANIFEST_INVALID');
  check(manifest.files && typeof manifest.files === 'object' && !Array.isArray(manifest.files),
    'FIDELITY_FILE_LIST_INVALID');
  const names = Object.keys(manifest.files).sort();
  check(names.length === EXPECTED_FILES.length && names.every((name, index) => name === EXPECTED_FILES[index]),
    'FIDELITY_FILE_ALLOWLIST_INVALID');
  for (const name of names)
    check(typeof manifest.files[name] === 'string' && /^[a-f0-9]{64}$/.test(manifest.files[name]),
      'FIDELITY_FILE_HASH_INVALID');
}

function validateCases(casesDoc) {
  check(exactKeys(casesDoc, ['version', 'basis', 'cases']) && casesDoc.version === 1
    && casesDoc.basis === 'SYNTHETIC_AUTHORED_TEST_CORPUS'
    && Array.isArray(casesDoc.cases) && casesDoc.cases.length === 4, 'FIDELITY_CASES_INVALID');
  const caseIds = new Set();
  for (const item of casesDoc.cases) {
    check(exactKeys(item, ['id', 'language', 'objective', 'source_ref', 'observed_at', 'messages'])
      && id(item.id) && !caseIds.has(item.id) && ['ru', 'uk'].includes(item.language)
      && nonempty(item.objective, 2000)
      && typeof item.source_ref === 'string' && /^public:synthetic-commercial-task-fidelity-[a-z0-9-]+$/.test(item.source_ref)
      && iso(item.observed_at) && Array.isArray(item.messages)
      && item.messages.length >= 1 && item.messages.length <= 8, 'FIDELITY_CASE_INVALID');
    caseIds.add(item.id);
    const messages = new Map();
    for (const message of item.messages) {
      check(exactKeys(message, ['id', 'author_ref', 'published_at', 'text', 'reply_to'])
        && id(message.id) && !messages.has(message.id)
        && typeof message.author_ref === 'string' && /^author-[A-Za-z0-9._:-]{1,100}$/.test(message.author_ref)
        && iso(message.published_at) && Date.parse(message.published_at) <= Date.parse(item.observed_at)
        && typeof message.text === 'string' && message.text.length <= 2000
        && message.text.trim().length > 0
        && (message.reply_to === null || id(message.reply_to)), 'FIDELITY_MESSAGE_INVALID');
      messages.set(message.id, message);
    }
    for (const message of messages.values())
      check(message.reply_to === null || messages.has(message.reply_to), 'FIDELITY_REPLY_NOT_LOCAL');
  }
  return casesDoc.cases;
}

function validateGold(goldDoc, cases) {
  check(exactKeys(goldDoc, ['version', 'basis', 'cases']) && goldDoc.version === 1
    && goldDoc.basis === 'RESEARCHER_AUTHORED_SYNTHETIC_ORACLE'
    && Array.isArray(goldDoc.cases) && goldDoc.cases.length === cases.length,
  'FIDELITY_GOLD_INVALID');
  const goldById = new Map();
  for (const entry of goldDoc.cases) {
    check(exactKeys(entry, ['case_id', 'positive_control_required', 'source_facts', 'required_distinctions',
      'forbidden_claims', 'currentness_expectation', 'offer_fit', 'contact_permission', 'critical_failures'])
      && id(entry.case_id) && !goldById.has(entry.case_id)
      && typeof entry.positive_control_required === 'boolean'
      && Array.isArray(entry.source_facts) && entry.source_facts.length >= 1 && entry.source_facts.length <= 16
      && Array.isArray(entry.required_distinctions) && entry.required_distinctions.length >= 1
      && entry.required_distinctions.length <= 24
      && entry.required_distinctions.every(value => nonempty(value, 2000))
      && Array.isArray(entry.forbidden_claims) && entry.forbidden_claims.length >= 1
      && entry.forbidden_claims.length <= 24 && entry.forbidden_claims.every(value => nonempty(value, 2000))
      && nonempty(entry.currentness_expectation, 2000)
      && entry.offer_fit === 'UNKNOWN' && entry.contact_permission === false
      && Array.isArray(entry.critical_failures) && entry.critical_failures.length >= 1
      && entry.critical_failures.length <= 24 && entry.critical_failures.every(value => nonempty(value, 2000)),
    'FIDELITY_GOLD_CASE_INVALID');
    goldById.set(entry.case_id, entry);
  }
  check(cases.every(item => goldById.has(item.id)) && goldById.size === cases.length,
    'FIDELITY_GOLD_CASE_SET_INVALID');
  cases.forEach((item, index) => {
    const entry = goldById.get(item.id);
    check(entry.positive_control_required === (index < 2), 'FIDELITY_POSITIVE_CONTROLS_INVALID');
    const messageById = new Map(item.messages.map(message => [message.id, message]));
    for (const fact of entry.source_facts) {
      check(exactKeys(fact, ['message_id', 'author_ref', 'exact_quote', 'fact'])
        && id(fact.message_id) && typeof fact.author_ref === 'string'
        && nonempty(fact.exact_quote, 2000) && nonempty(fact.fact, 2000), 'FIDELITY_SOURCE_FACT_INVALID');
      const message = messageById.get(fact.message_id);
      check(message && fact.author_ref === message.author_ref && fact.exact_quote === message.text,
        'FIDELITY_QUOTE_ATTRIBUTION_INVALID');
    }
    if (entry.positive_control_required)
      check(entry.source_facts.length > 0 && entry.required_distinctions.length > 0,
        'FIDELITY_POSITIVE_CONTROL_EMPTY');
  });
  return goldDoc.cases;
}

/**
 * Load a hash-frozen synthetic fidelity bundle from a repository root.
 * `cases` are the model-facing inputs. `gold` is evaluation-only and must not
 * be included in any prompt. Validation checks structure and exact quotation
 * attribution; it does not judge semantic correctness or evaluate model output.
 */
export function loadFrozenFidelity(root) {
  check(typeof root === 'string' && root.length > 0, 'FIDELITY_ROOT_INVALID');
  let repoRoot;
  try { repoRoot = fs.realpathSync(path.resolve(root)); } catch { throw new TypeError('FIDELITY_ROOT_INVALID'); }
  let bundleDir;
  try { bundleDir = fs.realpathSync(path.join(repoRoot, BUNDLE)); }
  catch { throw new TypeError('FIDELITY_MANIFEST_MISSING'); }
  const bundleRelative = path.relative(repoRoot, bundleDir);
  check(bundleRelative === path.normalize(BUNDLE), 'FIDELITY_MANIFEST_PATH_INVALID');
  const manifestFile = readBounded(repoRoot, `${BUNDLE}/manifest.json`, MAX_MANIFEST_BYTES);
  const manifest = parseJson(manifestFile.text, 'FIDELITY_MANIFEST_JSON_INVALID');
  validateManifest(manifest);

  const frozen = new Map();
  for (const relative of EXPECTED_FILES) {
    const file = readBounded(repoRoot, relative);
    const content = normalizeLf(file.text);
    check(sha256(Buffer.from(content, 'utf8')) === manifest.files[relative], 'FIDELITY_FILE_HASH_MISMATCH');
    frozen.set(relative, content);
  }
  const casesPath = 'benchmarks/commercial-task-fidelity-v1/cases.json';
  const goldPath = 'benchmarks/commercial-task-fidelity-v1/gold.json';
  const cases = parseJson(frozen.get(casesPath), 'FIDELITY_CASES_JSON_INVALID');
  const gold = parseJson(frozen.get(goldPath), 'FIDELITY_GOLD_JSON_INVALID');
  const caseRows = validateCases(cases);
  validateGold(gold, caseRows);
  const promptA = frozen.get(`${BUNDLE}/prompts/A.md`);
  const promptB = frozen.get(`${BUNDLE}/prompts/B.md`);
  check(promptA === frozen.get('partner/audience-reasoning.md'), 'FIDELITY_PROMPT_A_NOT_CANONICAL');
  check(promptB.startsWith(`${promptA}\n`), 'FIDELITY_PROMPT_B_NOT_APPEND_ONLY');
  const suffix = promptB.slice(promptA.length + 1);
  check(suffix.trim().length > 0 && suffix.length <= MAX_PROMPT_B_SUFFIX
    && !/\n\s*\n/.test(suffix), 'FIDELITY_PROMPT_B_SUFFIX_INVALID');
  const manifestText = normalizeLf(manifestFile.text);
  return {
    manifest,
    manifest_hash: sha256(Buffer.from(manifestText, 'utf8')),
    cases,
    gold,
    prompts: { A: promptA, B: promptB },
  };
}
