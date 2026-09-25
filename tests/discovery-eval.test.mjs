// Stage 4B: the synthetic contract evaluation must discriminate, not always pass.
// proof_level=synthetic_contract_eval; live_proof=false. No model, network, Telegram, or scheduler.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJson } from '../business/config.mjs';

const corpus = readJson(path.join(ROOT, 'docs/benchmarks/discovery-eval-v0/corpus.json'));
const { summary, EVAL } = await import('../scripts/discovery-eval-v0.mjs');

const report = summary();

test('4B the corpus covers six classes, four cases each, with both fixtures present', () => {
  assert.equal(corpus.cases.length, 24);
  const classes = new Set(corpus.cases.map((item) => item.class));
  assert.equal(classes.size, 6);
  for (const name of classes) {
    assert.equal(corpus.cases.filter((item) => item.class === name).length, 4, name);
  }
  for (const item of corpus.cases) {
    assert.ok(item.good.hypothesis.length > 0, item.case_id);
    assert.ok(item.bad.hypothesis.length > 0, item.case_id);
    assert.ok(item.policy.allowed_decisions.length > 0, item.case_id);
    assert.equal(item.good.quote, item.source.text, `${item.case_id}: a good quote is the source's own words`);
  }
});

test('4B every well-formed fixture survives the real contract path', () => {
  assert.deepEqual(report.good_failures, []);
  assert.equal(report.good_passed, report.good_total);
});

test('4B every deliberately bad fixture is caught, by production or by the scorer', () => {
  assert.deepEqual(report.bad_missed, []);
  assert.equal(report.bad_caught, report.bad_total);
  // If production caught everything, the scorer itself would be untested. Some cases must be
  // caught by an assessment that production already accepted.
  const byScorer = report.catch_reasons.filter((row) => row.codes.length > 0);
  assert.ok(byScorer.length >= 8, `the scorer must carry its own weight, got ${byScorer.length}`);
  const byProduction = report.catch_reasons.filter((row) => (row.caught_by ?? '').startsWith('production:'));
  assert.ok(byProduction.length >= 4, `production must still catch hard-contract abuse, got ${byProduction.length}`);
});

test('4B the scorer reports the codes it claims to check', () => {
  const codes = new Set(report.catch_reasons.flatMap((row) => row.codes));
  for (const expected of ['UNSUPPORTED_PERMISSION_INFERENCE', 'URGENCY_OVERRIDE']) {
    assert.ok(codes.has(expected), `expected the scorer to catch ${expected}`);
  }
  const byKind = new Map(corpus.cases.map((item) => [item.case_id, item.bad_kind]));
  for (const row of report.catch_reasons) {
    const kind = byKind.get(row.case_id);
    if (kind === 'ungrounded' || kind === 'no_uncertainty') {
      assert.match(row.caught_by ?? '', /DISCOVERY_/, `${row.case_id} should be refused by production`);
    }
  }
});

test('4B the evaluation is deterministic and offline by construction', () => {
  assert.equal(EVAL.proof_level, 'synthetic_contract_eval');
  assert.equal(EVAL.live_proof, false);
  const source = fs.readFileSync(path.join(ROOT, 'scripts/discovery-eval-v0.mjs'), 'utf8');
  for (const forbidden of ['fetch(', 'node:https', 'node:http', 'HermesAdapter', 'TelegramChannel']) {
    assert.equal(source.includes(forbidden), false, `the scorer must not reference ${forbidden}`);
  }
  // Same input, same verdict: the corpus is fixed data and nothing in the scorer reads a clock.
  assert.equal(JSON.stringify(summary()), JSON.stringify(report));
});
