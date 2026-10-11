import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadFrozenFidelity } from '../experiments/commercial-task-fidelity-v1/freeze.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = 'd74329d7c027c2cf1a924788ff57fcd3370ac6a9';
const bundle = 'experiments/commercial-task-fidelity-v1';
const filePaths = [
  'benchmarks/commercial-task-fidelity-v1/cases.json',
  'benchmarks/commercial-task-fidelity-v1/gold.json',
  `${bundle}/prompts/A.md`, `${bundle}/prompts/B.md`,
  'partner/audience-reasoning.md', 'contracts/audience-assessment.schema.json',
  'business/audience-reasoning.mjs', 'business/runtime.mjs', 'scripts/situation_router_worker.py',
].sort();
const hashText = text => createHash('sha256').update(text.replace(/\r\n?/g, '\n')).digest('hex');
const put = (root, relative, text) => {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, 'utf8');
};

function fixtureDocs() {
  const cases = [];
  const gold = [];
  for (let index = 1; index <= 4; index += 1) {
    const id = `synthetic_case_${index}`;
    const author = `author-case-${index}`;
    const message = { id: `case${index}-01`, author_ref: author,
      published_at: '2026-10-05T09:00:00.000Z', text: `Synthetic authored message ${index}.`, reply_to: null };
    cases.push({ id,
      language: index % 2 ? 'ru' : 'uk', objective: `Synthetic objective ${index}.`,
      source_ref: `public:synthetic-commercial-task-fidelity-case-${index}`,
      observed_at: '2026-10-11T12:00:00.000Z', messages: [message] });
    gold.push({ case_id: id, positive_control_required: index <= 2,
      source_facts: [{ message_id: message.id, author_ref: author, exact_quote: message.text,
        fact: `Researcher-authored fixture fact ${index}.` }],
      required_distinctions: [`Required distinction ${index}.`],
      forbidden_claims: [`Forbidden claim ${index}.`],
      currentness_expectation: `Synthetic currentness note ${index}.`,
      offer_fit: 'UNKNOWN', contact_permission: false,
      critical_failures: [`Critical failure ${index}.`] });
  }
  return {
    cases: { version: 1, basis: 'SYNTHETIC_AUTHORED_TEST_CORPUS', cases },
    gold: { version: 1, basis: 'RESEARCHER_AUTHORED_SYNTHETIC_ORACLE', cases: gold },
  };
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commercial-task-fidelity-freeze-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const production = [
    'partner/audience-reasoning.md', 'contracts/audience-assessment.schema.json',
    'business/audience-reasoning.mjs', 'business/runtime.mjs', 'scripts/situation_router_worker.py',
  ];
  for (const relative of production) put(root, relative, fs.readFileSync(path.join(REPO, relative), 'utf8'));
  const canonical = fs.readFileSync(path.join(REPO, 'partner/audience-reasoning.md'), 'utf8').replace(/\r\n?/g, '\n');
  put(root, `${bundle}/prompts/A.md`, canonical);
  put(root, `${bundle}/prompts/B.md`, `${canonical}\nFor this experiment, preserve explicit task conditions as stated.\n`);
  const docs = fixtureDocs();
  put(root, filePaths[0], `${JSON.stringify(docs.cases, null, 2)}\n`);
  put(root, filePaths[1], `${JSON.stringify(docs.gold, null, 2)}\n`);
  const manifest = { version: 1, baseline_sha: BASELINE, max_logical_attempts: 8, files: {} };
  const refresh = () => {
    manifest.files = Object.fromEntries(filePaths.map(relative => [relative,
      hashText(fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8'))]));
    put(root, `${bundle}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  };
  refresh();
  return { root, manifest, refresh };
}

test('loads an exact, hash-frozen four-case bundle and separates model-facing cases from evaluation gold', t => {
  const fixture = createFixture(t);
  const loaded = loadFrozenFidelity(fixture.root);
  assert.equal(loaded.manifest.version, 1);
  assert.equal(loaded.manifest.baseline_sha, BASELINE);
  assert.equal(loaded.manifest.max_logical_attempts, 8);
  assert.equal(loaded.cases.cases.length, 4);
  assert.equal(loaded.gold.cases.length, 4);
  assert.deepEqual(loaded.prompts, {
    A: fs.readFileSync(path.join(fixture.root, 'experiments/commercial-task-fidelity-v1/prompts/A.md'), 'utf8'),
    B: fs.readFileSync(path.join(fixture.root, 'experiments/commercial-task-fidelity-v1/prompts/B.md'), 'utf8'),
  });
  assert.equal(loaded.manifest_hash, hashText(fs.readFileSync(path.join(fixture.root, `${bundle}/manifest.json`), 'utf8')));
  assert.equal(loaded.gold.cases[0].offer_fit, 'UNKNOWN');
  assert.equal(loaded.gold.cases[0].contact_permission, false);
});

test('rejects changed bundle bytes and changed production bytes against the frozen hashes', t => {
  for (const target of [filePaths[0], 'business/runtime.mjs']) {
    const fixture = createFixture(t);
    const full = path.join(fixture.root, ...target.split('/'));
    fs.appendFileSync(full, '\nchanged\n', 'utf8');
    assert.throws(() => loadFrozenFidelity(fixture.root), /FIDELITY_FILE_HASH_MISMATCH/);
  }
});

test('rejects a gold quote attributed to the wrong speaker even when the bundle hashes are updated', t => {
  const fixture = createFixture(t);
  const goldPath = path.join(fixture.root, 'benchmarks/commercial-task-fidelity-v1/gold.json');
  const gold = JSON.parse(fs.readFileSync(goldPath, 'utf8'));
  gold.cases[0].source_facts[0].author_ref = 'author-someone-else';
  put(fixture.root, 'benchmarks/commercial-task-fidelity-v1/gold.json', `${JSON.stringify(gold, null, 2)}\n`);
  fixture.refresh();
  assert.throws(() => loadFrozenFidelity(fixture.root), /FIDELITY_QUOTE_ATTRIBUTION_INVALID/);
});

test('rejects a nonsynthetic source ref and a future case message after their hashes are refreshed', t => {
  const fixture = createFixture(t);
  const casesPath = path.join(fixture.root, 'benchmarks/commercial-task-fidelity-v1/cases.json');
  const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
  cases.cases[0].source_ref = 'public:customer-channel-42';
  put(fixture.root, 'benchmarks/commercial-task-fidelity-v1/cases.json', `${JSON.stringify(cases, null, 2)}\n`);
  fixture.refresh();
  assert.throws(() => loadFrozenFidelity(fixture.root), /FIDELITY_CASE_INVALID/);

  cases.cases[0].source_ref = 'public:synthetic-commercial-task-fidelity-case-1';
  cases.cases[0].messages[0].published_at = '2026-10-12T12:00:00.000Z';
  put(fixture.root, 'benchmarks/commercial-task-fidelity-v1/cases.json', `${JSON.stringify(cases, null, 2)}\n`);
  fixture.refresh();
  assert.throws(() => loadFrozenFidelity(fixture.root), /FIDELITY_MESSAGE_INVALID/);
});

test('rejects baseline prompt replacement, missing or extra manifest paths, and a different attempt cap', t => {
  const replaced = createFixture(t);
  put(replaced.root, `${bundle}/prompts/A.md`, 'A different prompt that omits the canonical contract.\n');
  replaced.refresh();
  assert.throws(() => loadFrozenFidelity(replaced.root), /FIDELITY_PROMPT_A_NOT_CANONICAL/);

  for (const mutation of [
    manifest => { delete manifest.files[filePaths[0]]; },
    manifest => { manifest.files['../../.env'] = 'a'.repeat(64); },
    manifest => { manifest.max_logical_attempts = 9; },
  ]) {
    const fixture = createFixture(t);
    mutation(fixture.manifest);
    put(fixture.root, `${bundle}/manifest.json`, `${JSON.stringify(fixture.manifest, null, 2)}\n`);
    assert.throws(() => loadFrozenFidelity(fixture.root), /FIDELITY_MANIFEST_INVALID|FIDELITY_FILE_ALLOWLIST_INVALID/);
  }
});

test('rejects nonlocal reply IDs and mismatched gold case sets', t => {
  const fixture = createFixture(t);
  const casesPath = path.join(fixture.root, 'benchmarks/commercial-task-fidelity-v1/cases.json');
  const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
  cases.cases[0].messages[0].reply_to = 'not-in-this-case';
  put(fixture.root, 'benchmarks/commercial-task-fidelity-v1/cases.json', `${JSON.stringify(cases, null, 2)}\n`);
  fixture.refresh();
  assert.throws(() => loadFrozenFidelity(fixture.root), /FIDELITY_REPLY_NOT_LOCAL/);

  cases.cases[0].messages[0].reply_to = null;
  put(fixture.root, 'benchmarks/commercial-task-fidelity-v1/cases.json', `${JSON.stringify(cases, null, 2)}\n`);
  const goldPath = path.join(fixture.root, 'benchmarks/commercial-task-fidelity-v1/gold.json');
  const gold = JSON.parse(fs.readFileSync(goldPath, 'utf8'));
  gold.cases[3].case_id = 'wrong_case_id';
  put(fixture.root, 'benchmarks/commercial-task-fidelity-v1/gold.json', `${JSON.stringify(gold, null, 2)}\n`);
  fixture.refresh();
  assert.throws(() => loadFrozenFidelity(fixture.root), /FIDELITY_GOLD_CASE_SET_INVALID/);
});
