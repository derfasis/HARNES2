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

const CORPUS = readJson(path.join(ROOT, 'docs/benchmarks/discovery-eval-v0/corpus.json'));

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
    const payload = {
      situation_id: situationId, expected_revision: detail.revision,
      expected_evidence_fingerprint: detail.evidence_fingerprint, decision: fixture.decision,
      evidence_event_ids: [evidenceId],
      hypothesis: { text: fixture.hypothesis, evidence_event_ids: [evidenceId],
        attributed_claims: [{ source_event_id: evidenceId, quote: fixture.quote }],
        inferences: [{ text: fixture.hypothesis, evidence_event_ids: [evidenceId] }],
        uncertainty: fixture.uncertainty },
      why_now: { reason: fixture.why_now, evidence_event_ids: [evidenceId] },
      ...(fixture.opening ? { opening_proposal: { text: fixture.opening, rationale: 'Operator review only.',
        constraints: ['operator review only'] } } : {}),
    };

    let stored = null, rejected = null;
    try { stored = await environment.service.command('discovery.assess', payload, id(), { kind: 'operator' }); }
    catch (error) { rejected = error; }

    // A deliberately bad fixture is caught when production refuses it outright. That is a
    // successful catch, not a benchmark failure, so it is reported as the reason, not a finding.
    if (!stored) {
      return { case_id: item.case_id, class: item.class, variant, checks: [],
        findings: [], caught_by: `production:${rejected.code}` };
    }

    const projected = environment.service.discoveryPresentationDetail(situationId, { kind: 'operator' })
      .assessments.at(-1);
    const text = [projected.hypothesis.text, projected.why_now.reason].join(' ').toLowerCase();
    const claimQuote = projected.hypothesis.attributed_claims[0]?.quote ?? '';

    // Hard contract: the quote must be the source's own words.
    record('QUOTE_NOT_GROUNDED', item.source.text.includes(claimQuote), `quote: ${claimQuote}`);
    // Hard contract: every reference must exist.
    const refs = [projected.hypothesis.text && projected.id, ...projected.hypothesis.inferences
      .flatMap((inference) => inference.evidence_event_ids), ...projected.why_now.evidence_event_ids]
      .filter((value) => value !== projected.id);
    record('UNSUPPORTED_ATTRIBUTION', refs.every((value) => String(value) === String(evidenceId)),
      `refs: ${refs.join(',')}`);
    // Hard contract: uncertainty is never optional.
    record('MISSING_UNCERTAINTY', projected.hypothesis.uncertainty.length > 0, 'uncertainty is empty');
    // Hard contract: a proposal never states authority, contact, or fact the source did not give.
    const authority = AUTHORITY_CLAIMS.find((phrase) => hasPhrase(text, phrase));
    record('UNSUPPORTED_PERMISSION_INFERENCE', !authority, `authority claim: ${authority ?? ''}`);
    const urgency = URGENCY_OVERRIDE.find((phrase) => hasPhrase(text, phrase));
    record('URGENCY_OVERRIDE', !urgency, `urgency override: ${urgency ?? ''}`);
    const certainty = CERTAINTY.find((phrase) => hasPhrase(text, phrase));
    record('UNSUPPORTED_CERTAINTY', !certainty, `certainty claim: ${certainty ?? ''}`);
    // Hard contract: the projection never dresses a proposal as a fact.
    record('EPISTEMIC_LABEL_MISSING', projected.epistemic_status === 'unverified_proposal',
      `epistemic_status: ${projected.epistemic_status}`);
    const proposal = environment.service.discoveryPresentationDetail(situationId, { kind: 'operator' })
      .opening_proposals.at(-1);
    record('AUTHORITY_LEAK_IN_PROJECTION',
      projected.executable === false && projected.contact_permission === false
      && projected.allowed_effects.length === 0
      && (!proposal || (proposal.executable === false && proposal.sent === false
        && proposal.contact_permission === false)),
      'projection must carry the standing non-authority markers');

    // Policy expectation: not one gold answer, but the set of decisions this case tolerates.
    const allowed = item.policy.allowed_decisions;
    record('DECISION_POLICY_INCOMPATIBLE', allowed.includes(projected.decision),
      `decision ${projected.decision} outside ${allowed.join('|')}`);
    return { case_id: item.case_id, class: item.class, variant, findings, checks,
      caught_by: findings.length ? null : 'none' };
  } finally { environment.close(); }
}

const corpus = CORPUS.cases ?? [];
const results = [];
for (const item of corpus) {
  for (const variant of ['good', 'bad']) results.push(await runFixture(item, item[variant], variant));
}

export const EVAL = { corpus_id: CORPUS.corpus_id, proof_level: CORPUS.proof_level,
  live_proof: CORPUS.live_proof, results };

// A good fixture must survive the real command path and satisfy every hard contract and the case
// policy. A bad fixture must be caught, either by production refusing it or by a contract check.
export const summary = () => {
  const good = results.filter((row) => row.variant === 'good');
  const bad = results.filter((row) => row.variant === 'bad');
  return {
    cases: corpus.length,
    good_total: good.length,
    good_passed: good.filter((row) => row.findings.length === 0).length,
    good_failures: good.filter((row) => row.findings.length > 0)
      .map((row) => ({ case_id: row.case_id, findings: row.findings })),
    bad_total: bad.length,
    bad_caught: bad.filter((row) => row.caught_by !== 'none').length,
    bad_missed: bad.filter((row) => row.caught_by === 'none').map((row) => row.case_id),
    catch_reasons: bad.map((row) => ({ case_id: row.case_id, caught_by: row.caught_by,
      codes: row.findings.map((finding) => finding.code) })),
  };
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const report = summary();
  console.log(JSON.stringify({ corpus_id: EVAL.corpus_id, proof_level: EVAL.proof_level,
    live_proof: EVAL.live_proof, ...report }, null, 2));
  if (report.good_failures.length) process.exitCode = 1;
}
