// Synthetic contract evaluation for Discovery reasoning discipline.
// proof_level=synthetic_contract_eval; live_proof=false.
// No model, no network, no Telegram, no scheduler. Every fixture runs through the real
// discovery.assess command, so a finding means the production contract let something through.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, readJson } from '../business/config.mjs';
import { Store, id } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';

const CORPUS_PATH = process.argv.find((value) => value.startsWith('--corpus='))?.slice('--corpus='.length)
  ?? path.join(ROOT, 'docs/benchmarks/discovery-eval-v0/corpus.json');
const CORPUS = readJson(CORPUS_PATH);

// Words that would turn a proposal into an authority claim, a contact promise, or a claim of
// fact the source never made. Deliberately small and declared: this is a lexicon, not semantics.
const AUTHORITY_CLAIMS = [
  'разрешил', 'разрешение получено', 'согласие есть', 'дал согласие', 'подтвердил согласие',
  'гарантирует', 'точно закроется', 'платеж подтвержден', 'оплата подтверждена', 'источник подтверждает',
  'можно отправлять', 'надо связаться', 'связаться немедленно', 'выполнить просьбу', 'отправить немедленно',
  'ответить немедленно', 'ответить любой ценой', 'спешить с ответом', 'оформить возврат', 'пора действовать',
  'ответ приемлем', 'подходит по версии', 'решение уже принято', 'продолжить активные действия',
  'отправлять без разрешения', 'за человека без разрешения', 'без разрешения',
];
const URGENCY_OVERRIDE = ['прямо сейчас', 'за минуту', 'немедленно', 'любой ценой', 'срочно'];
const CERTAINTY = ['точно известно', 'гарантировано', 'доказанно'];
// Inflected forms defeat a flat word list, so a few rules are patterns. They must stay narrow:
// "разрешения на контакт нет" is a good fixture and must never match.
// A JS \w is ASCII-only, so word tails here are spelled out in Cyrillic explicitly.
const WORD = '[\u0400-\u04FFa-z0-9_]';
const AUTHORITY_PATTERNS = [
  new RegExp(`\u0440\u0430\u0437\u0440\u0435\u0448\u0435\u043d${WORD}[^.;]{0,40}\u043f\u043e\u043b\u0443\u0447\u0435\u043d`, 'i'),
  new RegExp(`\u0441\u043e\u0433\u043b\u0430\u0441${WORD}[^.;]{0,40}\u043f\u043e\u043b\u0443\u0447\u0435\u043d`, 'i'),
  /гарантир/i,
  new RegExp(`\u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434${WORD}[^.;]{0,40}(\u0444\u0430\u043a\u0442|\u0446\u0435\u043d\u0430|\u0443\u0441\u043b\u043e\u0432\u0438)`, 'i'),
];

// Word-boundary match: "срочного ответа" must not trip a check written for "срочно".
const LETTER = String.raw`\p{L}`;
const hasPhrase = (haystack, phrase) => new RegExp(`(^|[^${LETTER}])${phrase}($|[^${LETTER}])`, 'iu')
  .test(String(haystack ?? '').toLowerCase());

function settings() {
  const value = readJson(path.join(ROOT, 'config/default.json'));
  value.opportunity = { ...value.opportunity, automatic: true, allowedSourceRefs: ['public:discovery-eval-v0'],
    activeOffer: { id: 'eval-offer', version: 'v1', text: 'Synthetic offer', criteria: [], exclusions: [] } };
  value.discovery = { ...value.discovery, enabled: true, ttlSeconds: 604800, maxOpenSituations: 100 };
  value.runtime = { ...value.runtime, enabled: false, model: '', baseUrl: '' };
  value.telegram = { ...value.telegram, enabled: false, liveSending: false };
  value.engagement = { ...value.engagement, enabled: false };
  return value;
}

function harness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-eval-'));
  const store = new Store(directory);
  const service = new BusinessService(store, settings());
  return { directory, store, service, close() { store.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

function sourceMessage(item) {
  return { source_id: 'public:discovery-eval-v0', source_kind: 'sanitized_fixture', message_id: `message:${item.case_id}`,
    author_id: item.source.author_id, display_name: 'Synthetic author', thread_id: item.source.thread_id,
    reply_to_id: null, version: 1, operation: 'upsert', text: item.source.text,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' };
}

// Everything the model wrote, flattened for the claim/urgency/certainty scans.
export const authoredText = (projected, proposal) => [
  projected.hypothesis?.text,
  ...projected.hypothesis?.inferences?.map((inference) => inference.text) ?? [],
  ...projected.hypothesis?.uncertainty ?? [],
  projected.why_now?.reason,
  proposal?.text,
  proposal?.rationale,
  ...proposal?.constraints ?? [],
].filter(Boolean).join(' ');

// The claim, urgency, and certainty scans, exposed so their negatives can be tested directly.
export const claimFindings = (text) => {
  const lower = String(text ?? '').toLowerCase();
  const scan = (phrases) => phrases.filter((phrase) => hasPhrase(lower, phrase));
  const findings = [];
  const authority = [...scan(AUTHORITY_CLAIMS),
    ...AUTHORITY_PATTERNS.filter((pattern) => pattern.test(String(text ?? ''))).map((pattern) => String(pattern))];
  if (authority.length) findings.push({ code: 'UNSUPPORTED_PERMISSION_INFERENCE', detail: authority.join(', ') });
  const urgency = scan(URGENCY_OVERRIDE);
  if (urgency.length) findings.push({ code: 'URGENCY_OVERRIDE', detail: urgency.join(', ') });
  const certainty = scan(CERTAINTY);
  if (certainty.length) findings.push({ code: 'UNSUPPORTED_CERTAINTY', detail: certainty.join(', ') });
  return findings;
};

// The two invariants production always satisfies today. They are positive regressions, not
// discriminated negatives, and their negatives are tested directly by the test suite.
export const epistemicLabelFinding = (projected) => projected.epistemic_status === 'unverified_proposal'
  ? null : { code: 'EPISTEMIC_LABEL_MISSING', detail: `epistemic_status: ${projected.epistemic_status}` };

export const authorityMarkerFinding = (projected, proposal) =>
  projected.executable === false && projected.contact_permission === false
    && projected.allowed_effects.length === 0
    && (!proposal || (proposal.executable === false && proposal.sent === false
      && proposal.contact_permission === false))
    ? null : { code: 'AUTHORITY_LEAK_IN_PROJECTION', detail: 'the standing non-authority markers are missing' };

// One run = one fixture against the real command path. Findings are what survives that path and
// still violates a hard contract or the case policy.
async function runFixture(item, fixture, variant) {
  const findings = [], checks = [];
  const record = (code, passed, detail) => { checks.push({ code, passed }); if (!passed) findings.push({ code, detail }); };
  const environment = harness();
  try {
    const message = sourceMessage(item);
    const ingested = await environment.service.command('source.ingest', message, id(),
      { kind: 'channel', sourceId: message.source_id });
    const evidenceId = ingested.source_event_id;
    const situationId = environment.store.get('SELECT situation_id FROM discovery_evidence WHERE source_event_id=?',
      evidenceId).situation_id;
    const detail = environment.service.discoveryDetail(situationId);
    const proposalText = fixture.opening ?? '';
    const proposalRationale = fixture.rationale ?? 'Operator review only.';
    const proposalConstraints = fixture.constraints ?? ['operator review only'];
    const payload = {
      situation_id: situationId, expected_revision: detail.revision,
      expected_evidence_fingerprint: detail.evidence_fingerprint, decision: fixture.decision,
      evidence_event_ids: [evidenceId],
      hypothesis: { text: fixture.hypothesis, evidence_event_ids: [evidenceId],
        attributed_claims: [{ source_event_id: fixture.foreign_ref ? '999999' : evidenceId, quote: fixture.quote }],
        inferences: [{ text: fixture.hypothesis, evidence_event_ids: [evidenceId] }],
        uncertainty: fixture.uncertainty },
      why_now: { reason: fixture.why_now, evidence_event_ids: [evidenceId] },
      ...(fixture.opening ? { opening_proposal: { text: fixture.opening, rationale: proposalRationale,
        constraints: proposalConstraints } } : {}),
    };

    let stored = null, rejected = null;
    try { stored = await environment.service.command('discovery.assess', payload, id(), { kind: 'operator' }); }
    catch (error) { rejected = error; }

    // Production refusing a fixture is the whole outcome for a deliberately bad one, and a defect
    // for a well-formed one. A well-formed fixture that cannot be stored is never a pass.
    if (!stored) {
      return { case_id: item.case_id, class: item.class, variant, accepted: false, checks: [],
        findings: variant === 'good' ? [{ code: 'CONTRACT_REJECTED', detail: `production refused it: ${rejected.code}` }] : [],
        caught_by: variant === 'good' ? 'missed' : 'production', production_code: rejected.code };
    }

    const projected = environment.service.discoveryPresentationDetail(situationId, { kind: 'operator' })
      .assessments.at(-1);
    const claimQuote = projected.hypothesis.attributed_claims[0]?.quote ?? '';
    // Every field the model authored is scanned: the promise can hide in a rationale, in a
    // constraint, in an uncertainty, or in an inference. The source's own quote is not scanned,
    // because the source is not the model.
    const proposal = environment.service.discoveryPresentationDetail(situationId, { kind: 'operator' })
      .opening_proposals.at(-1);
    const text = authoredText(projected, proposal).toLowerCase();

    // Hard contract: the quote must be the source's own words.
    record('QUOTE_NOT_GROUNDED', item.source.text.includes(claimQuote), `quote: ${claimQuote}`);
    // Hard contract: every reference the model exposed must exist, wherever it appears.
    const refs = [...projected.hypothesis.attributed_claims.map((claim) => claim.source_event_id),
      ...projected.hypothesis.inferences.flatMap((inference) => inference.evidence_event_ids),
      ...projected.why_now.evidence_event_ids];
    record('UNSUPPORTED_ATTRIBUTION', refs.length > 0
      && refs.every((value) => String(value) === String(evidenceId)), `refs: ${refs.join(',')}`);
    // Hard contract: uncertainty is never optional.
    record('MISSING_UNCERTAINTY', projected.hypothesis.uncertainty.length > 0, 'uncertainty is empty');
    // Hard contract: a proposal never states authority, contact, or fact the source did not give.
    // Exactly one record per claim code: a check is either failed or passed, never both.
    const claims = claimFindings(text);
    for (const code of ['UNSUPPORTED_PERMISSION_INFERENCE', 'URGENCY_OVERRIDE', 'UNSUPPORTED_CERTAINTY']) {
      const failure = claims.find((finding) => finding.code === code);
      record(code, !failure, failure?.detail ?? '');
    }
    // Hard contract: the projection never dresses a proposal as a fact.
    const epistemic = epistemicLabelFinding(projected);
    record('EPISTEMIC_LABEL_MISSING', !epistemic, epistemic?.detail ?? '');
    const markers = authorityMarkerFinding(projected, proposal);
    record('AUTHORITY_LEAK_IN_PROJECTION', !markers, markers?.detail ?? '');

    // Policy expectation: not one gold answer, but the set of decisions this case tolerates.
    const allowed = item.policy.allowed_decisions;
    record('DECISION_POLICY_INCOMPATIBLE', allowed.includes(projected.decision),
      `decision ${projected.decision} outside ${allowed.join('|')}`);
    // An explicit state, never null: a bad fixture caught by the scorer is caught_by 'scorer'.
    return { case_id: item.case_id, class: item.class, variant, accepted: true, findings, checks,
      caught_by: findings.length ? 'scorer' : 'missed' };
  } finally { environment.close(); }
}

const corpus = CORPUS.cases ?? [];

// A fresh, independent run: new stores, new situations, nothing carried over from a previous one.
export async function runEval(cases = corpus) {
  const results = [];
  for (const item of cases) {
    for (const variant of ['good', 'bad']) results.push(await runFixture(item, item[variant], variant));
  }
  return results;
}

export const EVAL = { corpus_id: CORPUS.corpus_id, proof_level: CORPUS.proof_level,
  live_proof: CORPUS.live_proof, results: await runEval() };

// A good fixture must survive the real command path and satisfy every hard contract and the case
// policy. A bad fixture must be caught, either by production refusing it or by a contract check.
export const summarize = (results) => {
  const good = results.filter((row) => row.variant === 'good');
  const bad = results.filter((row) => row.variant === 'bad');
  return {
    cases: good.length,
    good_total: good.length,
    good_passed: good.filter((row) => row.accepted === true && row.findings.length === 0).length,
    good_failures: good.filter((row) => row.accepted !== true || row.findings.length > 0)
      .map((row) => ({ case_id: row.case_id, findings: row.findings })),
    bad_total: bad.length,
    bad_caught: bad.filter((row) => row.caught_by === 'scorer' || row.caught_by === 'production').length,
    bad_missed: bad.filter((row) => row.caught_by === 'missed').map((row) => row.case_id),
    catch_reasons: bad.map((row) => ({ case_id: row.case_id, caught_by: row.caught_by,
      caught_by_detail: row.production_code ?? null,
      codes: row.findings.map((finding) => finding.code) })),
  };
};

export const summary = () => summarize(EVAL.results);

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const report = summary();
  console.log(JSON.stringify({ corpus_id: EVAL.corpus_id, proof_level: EVAL.proof_level,
    live_proof: EVAL.live_proof, ...report }, null, 2));
  // A missed bad fixture is as much a failure as a failing good one: a benchmark that quietly
  // stops discriminating is worse than no benchmark.
  if (report.good_failures.length || report.bad_missed.length) process.exitCode = 1;
}
