// Stage 4B: the synthetic contract evaluation must discriminate, not always pass.
// proof_level=synthetic_contract_eval; live_proof=false. No model, network, Telegram, or scheduler.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJson } from '../business/config.mjs';

const corpus = readJson(path.join(ROOT, 'docs/benchmarks/discovery-eval-v0/corpus.json'));
const { summary, summarize, runEval, EVAL, claimFindings, authoredText, epistemicLabelFinding,
  authorityMarkerFinding } = await import('../scripts/discovery-eval-v0.mjs');

const report = summary();

test('4B the corpus covers six classes plus an explicit discriminator set', () => {
  assert.equal(corpus.cases.length, 30);
  const classes = new Set(corpus.cases.map((item) => item.class));
  assert.equal(classes.size, 7);
  for (const name of [...classes].filter((value) => value !== 'discriminator')) {
    assert.equal(corpus.cases.filter((item) => item.class === name).length, 4, name);
  }
  // The discriminator cases make the scorer's own rules fire. Two projection invariants are
  // deliberately not discriminated here — no fixture can violate what production always
  // satisfies — and the foreign-reference case proves a production refusal, not a scorer catch.
  const kinds = new Set(corpus.cases.map((item) => item.bad_kind));
  for (const kind of ['ungrounded', 'no_uncertainty', 'authority', 'urgency', 'certainty',
    'urgency_in_opening', 'authority_in_rationale', 'foreign_ref', 'policy']) {
    assert.ok(kinds.has(kind), `corpus must contain a case of kind ${kind}`);
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
  const byProduction = report.catch_reasons.filter((row) => row.caught_by === 'production');
  assert.ok(byProduction.length >= 4, `production must still catch hard-contract abuse, got ${byProduction.length}`);
});

test('4B a well-formed fixture that production refuses is a failure, never a silent pass', async () => {
  const item = corpus.cases.find((entry) => entry.class === 'discriminator');
  const broken = { ...item, good: { ...item.good, quote: 'Такого текста в источнике нет' } };
  const verdict = summarize(await runEval([broken]));
  assert.equal(verdict.good_passed, 0);
  assert.deepEqual(verdict.good_failures.map((row) => row.case_id), [broken.case_id]);
  assert.equal(verdict.good_failures[0].findings[0].code, 'CONTRACT_REJECTED');
});

test('4B the scorer reports every code it claims to check', () => {
  const codes = new Set(report.catch_reasons.flatMap((row) => row.codes));
  for (const expected of ['UNSUPPORTED_PERMISSION_INFERENCE', 'URGENCY_OVERRIDE', 'UNSUPPORTED_CERTAINTY',
    'DECISION_POLICY_INCOMPATIBLE']) {
    assert.ok(codes.has(expected), `expected the scorer to catch ${expected}`);
  }
  const byKind = new Map(corpus.cases.map((item) => [item.case_id, item.bad_kind]));
  for (const row of report.catch_reasons) {
    const kind = byKind.get(row.case_id);
    if (kind === 'ungrounded' || kind === 'no_uncertainty' || kind === 'foreign_ref') {
      assert.equal(row.caught_by, 'production', `${row.case_id} should be refused by production`);
      assert.match(row.caught_by_detail ?? '', /DISCOVERY_/, `${row.case_id} should name a production code`);
    }
  }
});

test('4B the evaluation is deterministic and offline by construction', async () => {
  assert.equal(EVAL.proof_level, 'synthetic_contract_eval');
  assert.equal(EVAL.live_proof, false);
  const source = fs.readFileSync(path.join(ROOT, 'scripts/discovery-eval-v0.mjs'), 'utf8');
  for (const forbidden of ['fetch(', 'node:https', 'node:http', 'HermesAdapter', 'TelegramChannel']) {
    assert.equal(source.includes(forbidden), false, `the scorer must not reference ${forbidden}`);
  }
  // Two independent runs over fresh stores must agree: same input, same verdict.
  const first = summarize(await runEval());
  const second = summarize(await runEval());
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(first), JSON.stringify(report));
});

test('4B every bad fixture reports an explicit catch state, never an ambiguous one', () => {
  for (const row of report.catch_reasons) {
    assert.ok(['scorer', 'production', 'missed'].includes(row.caught_by), `${row.case_id}: ${row.caught_by}`);
    if (row.caught_by === 'scorer') assert.ok(row.codes.length > 0, `${row.case_id} caught without a code`);
    if (row.caught_by === 'production') assert.ok(row.caught_by_detail, `${row.case_id} caught without a production code`);
  }
});

test('4B the CLI fails on a missed bad fixture, not only on a failing good one', async () => {
  const child = await import('node:child_process');
  const path = await import('node:path');
  const script = path.join(ROOT, 'scripts/discovery-eval-v0.mjs');
  const clean = child.spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  // A corpus whose bad fixture is indistinguishable from a good one must not report success. The
  // weakened corpus is written to a temporary file: the tracked corpus is never touched, so a
  // crash cannot leave the working tree dirty and a parallel run cannot read a swapped corpus.
  const os = await import('node:os');
  const item = corpus.cases.find((entry) => entry.class === 'discriminator');
  const weakened = { ...JSON.parse(fs.readFileSync(path.join(ROOT,
    'docs/benchmarks/discovery-eval-v0/corpus.json'), 'utf8')),
    cases: [{ ...item, bad: { ...item.bad, hypothesis: 'Возможно, полезно объяснить.',
      why_now: 'Вопрос общий.', uncertainty: ['Неясно.'], decision: item.bad.decision } }] };
  const temporary = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-eval-corpus-')), 'corpus.json');
  fs.writeFileSync(temporary, JSON.stringify(weakened, null, 2));
  const failed = child.spawnSync(process.execPath, [script, `--corpus=${temporary}`], { encoding: 'utf8' });
  assert.equal(failed.status, 1, 'a missed bad fixture must fail the run');
  assert.equal(JSON.parse(failed.stdout).bad_missed.length, 1);
  fs.rmSync(path.dirname(temporary), { recursive: true, force: true });
});

test('4B the claim scan covers every authored field, and a clean one is silent', () => {
  const clean = { hypothesis: { text: 'Возможно, нужны детали.', inferences: [{ text: 'Потребность неясна.' }],
    uncertainty: ['Неизвестно, что важно.'] }, why_now: { reason: 'Вопрос общий.' },
    opening: { text: 'Могу пояснить детали.', rationale: 'Только после разрешения.',
      constraints: ['operator review only'] } };
  assert.deepEqual(claimFindings(authoredText(clean, clean.opening)), []);
  // The promise may hide in any authored field, and each one is scanned.
  for (const hide of [
    (value) => { value.hypothesis.text = 'Пользователь разрешил связаться с ним.'; },
    (value) => { value.hypothesis.inferences[0].text = 'Ответить немедленно.'; },
    (value) => { value.hypothesis.uncertainty[0] = 'Всё точно известно.'; },
    (value) => { value.why_now.reason = 'Пользователь разрешил передать предложение.'; },
    (value) => { value.opening.text = 'Связаться немедленно.'; },
    (value) => { value.opening.rationale = 'Разрешение на связь уже получено.'; },
    (value) => { value.opening.constraints[0] = 'ответить любой ценой'; },
  ]) {
    const dirty = structuredClone(clean);
    hide(dirty);
    const codes = claimFindings(authoredText(dirty, dirty.opening)).map((finding) => finding.code);
    assert.ok(codes.length > 0, 'a hidden claim must be caught wherever it is placed');
  }
  // The source's own words are not the model's text and must never be scanned as such.
  const quoted = structuredClone(clean);
  quoted.hypothesis.attributed_claims = [{ quote: 'Пользователь разрешил связаться.' }];
  assert.deepEqual(claimFindings(authoredText(quoted, quoted.opening)), []);
});

test('4B the two standing invariants are positive regressions, and their negatives are direct', () => {
  const honest = { epistemic_status: 'unverified_proposal', executable: false, contact_permission: false,
    allowed_effects: [] };
  assert.equal(epistemicLabelFinding(honest), null);
  assert.equal(epistemicLabelFinding({ ...honest, epistemic_status: 'verified_fact' }).code, 'EPISTEMIC_LABEL_MISSING');
  assert.equal(authorityMarkerFinding(honest, null), null);
  assert.equal(authorityMarkerFinding(honest, { executable: false, sent: false, contact_permission: false }), null);
  for (const broken of [{ ...honest, executable: true }, { ...honest, contact_permission: true },
    { ...honest, allowed_effects: ['send'] }]) {
    assert.equal(authorityMarkerFinding(broken, null).code, 'AUTHORITY_LEAK_IN_PROJECTION');
  }
  assert.equal(authorityMarkerFinding(honest, { executable: true, sent: false, contact_permission: false }).code,
    'AUTHORITY_LEAK_IN_PROJECTION');
  assert.equal(authorityMarkerFinding(honest, { executable: false, sent: true, contact_permission: false }).code,
    'AUTHORITY_LEAK_IN_PROJECTION');
});
