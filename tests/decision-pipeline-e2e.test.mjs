// The whole Stage 4D pipeline, end to end, with no provider and no owner gate: a raw source becomes
// an anonymised staged input, the staged input is generated against a stubbed model, the stored
// artefacts and the call ledger become a finished corpus and a derived report, and all three
// validators accept them together.
//
// proof_level=synthetic_contract_eval; live_proof=false. Everything here is a CONTRACT TEST fixture
// marked prov_test_*, exists only inside this file, and is never benchmark material. No model
// call, no network, no database, no egress, and process.env is never read or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convert } from '../docs/benchmarks/decision-quality-eval-v0/generation/anonymize.mjs';
import { AXES, promptDigest, stagedCaseDigest } from '../docs/benchmarks/decision-quality-eval-v0/generation/staging.mjs';
import { EXIT, fileStore, readArtefacts, readLedger, runGeneration } from '../docs/benchmarks/decision-quality-eval-v0/generation/run.mjs';
import { REVIEW_PROTOCOL, assembleCorpus, deriveReport } from '../docs/benchmarks/decision-quality-eval-v0/generation/assemble.mjs';
import { validateCorpus, validateEvaluation, validateReport } from '../docs/benchmarks/decision-quality-eval-v0/validate.mjs';

// Ephemeral contract-test material. The prefix says outright that this is not a real source, so a
// corpus built from it can never be mistaken for a measurement of anything.
const IRINA = ['Ирина Ковальчук', 'Ирину Ковальчук', 'Ирине Ковальчук'];
const OLEG = ['Олег Петров', 'Олега Петрова', 'Олег Петрову'];
const CONTRACT_PROVENANCE = { kind: 'real', provenance_claim_ref: 'prov_test_contract_only' };

const rawMessage = (over = {}) => ({ source_event_id: 'm-1', author: OLEG[0], author_aliases: OLEG,
  direction: 'in', channel: 'public', version: 1, text: 'Обсуждаем партнёрство.',
  created_at: '2026-01-01T00:00:00.000Z', reply_to_id: null, ...over });

const rawCase = (over = {}) => ({ case_id: 'case-1', situation_id: 'sit-1', subject_author: IRINA[0],
  subject_aliases: IRINA, anchor_source_event_id: 'm-2',
  goal_text: 'Assess usefulness of the offer for operator review only.',
  allowed_channels: ['public'], offer: 'Synthetic offer', operator_goal: 'Assess usefulness.',
  known_unknowns: ['Цена не подтверждена.'],
  messages: [rawMessage(),
    rawMessage({ source_event_id: 'm-2', author: IRINA[0], author_aliases: IRINA, reply_to_id: 'm-1',
      text: `${IRINA[2]}, сколько стоит участие? Мой email: irina@example.com`,
      created_at: '2026-01-01T00:05:00.000Z' })],
  ...over });

const rawSource = (over = {}) => ({ input_id: 'd4-generation-v0', prompt_ref: 'prompt-7',
  cases: [rawCase()], ...over });

// The model answer is written against the anonymised ids the converter produced, which is the whole
// point: the stub can only quote what the model would actually have been shown.
const stubOutput = (staged) => {
  const anchor = staged.messages.find((entry) => entry.is_anchor);
  return {
    hypothesis: { text: 'Возможно, нужен разбор.', evidence: [
      { source_event_id: anchor.source_event_id, author_id: anchor.author_id, version: anchor.version,
        text: anchor.text, kind: 'question', attribution: 'author_statement' }],
    contradictions: [], unknowns: [] },
    next_action: { schema_version: 1, situation_id: staged.situation.situation_id, decision: 'WAIT',
      confidence: 0.4, strategy: 'Подождать.', reason: 'Нужны детали.',
      evidence_message_ids: [anchor.source_event_id], unknowns: [], risk_flags: [], draft: null,
      review: { required: true, status: 'pending', authorization: 'none' }, reevaluate_after: null },
    authority: { contact_permission: false, allowed_effects: [] } };
};

const stubResponse = (staged) => ({ raw: JSON.stringify(stubOutput(staged)),
  model_id: 'contract-stub-model', model_version: 'contract-stub-1' });

const humanReview = (reviewer, value = 2) => ({ reviewer, protocol: REVIEW_PROTOCOL,
  axes: Object.fromEntries(AXES.map((axis) => [axis, value])), failure_tags: [] });

// The gate is injected, never read from the environment, so this test cannot reach a real runtime
// even if the owner has since approved one on the machine.
const testOnlyGate = { allowed: true, reasons: [] };

async function runPipeline(directory, input) {
  const calls = [];
  const run = await runGeneration({ input, gate: testOnlyGate, directory,
    store: fileStore(directory),
    callModel: async ({ staged }) => { calls.push(staged.case_id); return stubResponse(staged); } });
  return { run, calls };
}

test('4D the whole pipeline runs from a raw source to a validated report, with no model and no gate', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-eval-e2e-'));
  try {
    // 1. A raw source with real names and an address in it.
    const { input, problems: anonymiseProblems } = convert({ source: rawSource(),
      provenance: CONTRACT_PROVENANCE });
    assert.deepEqual(anonymiseProblems, [], JSON.stringify(anonymiseProblems));
    const staged = input.cases[0];
    assert.equal(input.live_proof, false);
    assert.equal(staged.provenance.kind, 'anonymized_real', 'declared provenance is not downgraded');
    assert.equal(staged.provenance.provenance_claim_ref, 'prov_test_contract_only');
    const serialised = JSON.stringify(input);
    for (const secret of [...IRINA, ...OLEG, 'irina@example.com', 'm-1', 'm-2'])
      assert.equal(serialised.includes(secret), false, `${secret} must not reach the model`);

    // 2. Generation against a stub. One call, one ledger entry, one stored artefact.
    const { run, calls } = await runPipeline(directory, input);
    assert.equal(run.exit, EXIT.done, JSON.stringify(run.summary));
    assert.equal(calls.length, 1, 'exactly one stub call');
    assert.equal(run.summary.generated, 1);
    assert.equal(readLedger(directory).calls, 1, 'the ledger counts the call');

    const artefact = readArtefacts(directory)['case-1'];
    assert.ok(artefact, 'the artefact is stored under its case id');
    assert.equal(artefact.raw, JSON.stringify(stubOutput(staged)), 'the raw model text is kept');
    assert.equal(artefact.prompt_sha256, promptDigest(), 'the artefact is bound to the committed prompt');
    assert.equal(artefact.staged_case_sha256, stagedCaseDigest(staged), 'and to this exact staged case');
    assert.equal(artefact.model_id, 'contract-stub-model');
    assert.equal(artefact.model_version, 'contract-stub-1');

    // 3. A rerun is idempotent: the case is complete, so the stub is never asked twice.
    const again = await runPipeline(directory, input);
    assert.equal(again.run.exit, EXIT.nothing_to_do);
    assert.equal(again.calls.length, 0, 'a finished case is never regenerated');
    assert.equal(readLedger(directory).calls, 1, 'and the ledger does not grow');

    // 4. Two human reviews turn the stored artefacts into a corpus.
    const artefacts = readArtefacts(directory);
    const { corpus, problems } = assembleCorpus({ input, artefacts,
      reviews: { 'case-1': [humanReview('test-reviewer-a'), humanReview('test-reviewer-b')] } });
    assert.deepEqual(problems, [], JSON.stringify(problems));
    assert.equal(corpus.proof_level, 'offline_human_eval');
    assert.equal(corpus.live_proof, false);
    assert.equal(corpus.generation.model_id, 'contract-stub-model');
    assert.equal(corpus.generation.prompt_digest, promptDigest());
    assert.equal(corpus.cases[0].provenance.provenance_claim_ref, 'prov_test_contract_only',
      'the corpus carries the provenance it was given, not a stronger claim');

    // 5. The report is derived from that corpus alone, and all three validators accept the pair.
    const { report, problems: reportProblems } = deriveReport(corpus);
    assert.deepEqual(reportProblems, [], JSON.stringify(reportProblems));
    assert.equal(report.proof_level, 'offline_human_eval');
    assert.equal(report.live_proof, false);
    assert.equal(report.model.id, 'contract-stub-model', 'the report names the model that was actually used');
    assert.equal(report.model.prompt_digest, promptDigest());
    assert.deepEqual(validateCorpus(corpus), [], 'the corpus satisfies the finished contract');
    assert.deepEqual(validateReport(report), [], 'the report satisfies the finished contract');
    assert.deepEqual(validateEvaluation(corpus, report), [], 'corpus and report agree');
    assert.equal(report.scored_cases, 1);
    assert.equal(report.case_results[0].case_id, 'case-1');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('4D the pipeline breaks on the digest, not on the prose, when the staged case changes after generation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-eval-e2e-digest-'));
  try {
    const { input } = convert({ source: rawSource(), provenance: CONTRACT_PROVENANCE });
    await runPipeline(directory, input);
    const artefacts = readArtefacts(directory);
    const reviews = { 'case-1': [humanReview('test-reviewer-a'), humanReview('test-reviewer-b')] };

    // A staged case that is still structurally valid but no longer the one that was generated.
    const edited = structuredClone(input);
    edited.cases[0].offer = 'Другое предложение после генерации';
    const refused = assembleCorpus({ input: edited, artefacts, reviews });
    assert.equal(refused.corpus, null, 'an artefact from another staged case cannot be reused');
    assert.ok(refused.problems.includes('case-1:artefact_answers_another_case'),
      `the refusal must name the digest mismatch: ${JSON.stringify(refused.problems)}`);
    assert.ok(refused.problems.includes('a_finished_evaluation_needs_at_least_one_case'),
      'and the empty result is a refusal, not a corpus with a hole in it');

    // The untouched input still assembles, so the refusal is about the change and not the fixture.
    const intact = assembleCorpus({ input, artefacts, reviews });
    assert.deepEqual(intact.problems, [], JSON.stringify(intact.problems));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('4D an injected gate is the only thing that let this run, and the environment is never consulted', async () => {
  // The same staged input with no gate injected refuses, because the real gate reads the owner's
  // environment. This is the assertion that keeps the end-to-end test honest about its own scope.
  const { input } = convert({ source: rawSource(), provenance: CONTRACT_PROVENANCE });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-eval-e2e-gate-'));
  try {
    const refused = await runGeneration({ input, directory, store: fileStore(directory),
      callModel: async () => { throw new Error('the stub must never be reached'); } });
    assert.equal(refused.exit, EXIT.refused, 'without an injected gate the run is refused');
    assert.ok(refused.reasons.includes('owner_has_not_authorised_model_calls'),
      `the refusal must name the missing permission: ${JSON.stringify(refused.reasons)}`);
    assert.deepEqual(readArtefacts(directory), {}, 'and nothing was written');
    assert.equal(readLedger(directory).calls, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
