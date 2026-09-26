// Stage 4D: the staging layer, the graph invariants, the output contract, and the gated run.
// proof_level=synthetic_contract_eval; live_proof=false. The model call is stubbed in tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BINDINGS, MAX_CALLS, checkCaseGraph, checkPromptInputAgreement, generationGate, loadInput,
  outputProblems, plan, preflight, promptDigest, INPUT_PATH, PROMPT_PATH }
  from '../docs/benchmarks/decision-quality-eval-v0/generation/staging.mjs';
import { EXIT, runGeneration } from '../docs/benchmarks/decision-quality-eval-v0/generation/run.mjs';

const GENERATION = fileURLToPath(new URL('../docs/benchmarks/decision-quality-eval-v0/generation/', import.meta.url));

const message = (over = {}) => ({ source_event_id: 'ev-1', author_id: 'user-02', version: 1,
  channel: 'public', direction: 'in', text: 'Как устроено партнёрство?', created_at: '2026-01-01T00:01:00.000Z',
  reply_to_id: null, is_anchor: true, ...over });

const stagedCase = (over = {}) => ({
  case_id: 'case-1',
  provenance: { kind: 'sanitized_fixture' },
  situation: { situation_id: 'sit-1', goal_text: 'Assess usefulness for operator review only.',
    allowed_channels: ['public'] },
  subject: { author_id: 'user-02' },
  messages: [message({ source_event_id: 'ev-1', author_id: 'user-01', text: 'Обсуждаем партнёрство.',
    is_anchor: false }),
    message({ source_event_id: 'ev-2' })],
  offer: 'Synthetic offer', operator_goal: 'Assess usefulness.', known_unknowns: ['Цена не подтверждена.'],
  ...over });

const stagedInput = (cases = [stagedCase()], mutate = {}) => ({
  input_id: 'd4-generation-v0', live_proof: false, cases, ...mutate });

const validOutput = (over = {}) => ({
  hypothesis: { text: 'Возможно, нужен разбор.', evidence: [
    { source_event_id: 'ev-2', author_id: 'user-02', version: 1, text: 'Как устроено партнёрство?',
      kind: 'question', attribution: 'author_statement' }], contradictions: [], unknowns: ['Цена?'] },
  next_action: { schema_version: 1, situation_id: 'sit-1', decision: 'PUBLIC_REPLY', confidence: 0.5,
    strategy: 'Ответить.', reason: 'Прямой вопрос.', evidence_message_ids: ['ev-2'], unknowns: [],
    risk_flags: [], draft: { channel: 'public', action: 'reply', target_id: 'user-02',
      text: 'Коротко о главном.', source_message_ids: ['ev-2'] },
    review: { required: true, status: 'pending', authorization: 'none' }, reevaluate_after: null },
  authority: { contact_permission: false, allowed_effects: [] }, ...over });

const OPEN = { HARNES_OWNER_APPROVED_MODEL_CALLS: 'yes' };

test('4D the prompt is a committed file with a real SHA-256', () => {
  const text = fs.readFileSync(PROMPT_PATH, 'utf8');
  assert.ok(text.length > 800);
  assert.match(promptDigest(), /^[0-9a-f]{64}$/);
  assert.equal(promptDigest(), promptDigest());
});

test('4D the staged input carries no review state: reviews come after generation', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(GENERATION, 'input.schema.json'), 'utf8'));
  const properties = Object.keys(schema.$defs.staged_case.properties);
  for (const forbidden of ['scores', 'reviews', 'adjudication', 'final_axes', 'failure_tags', 'failed'])
    assert.equal(properties.includes(forbidden), false, `${forbidden} cannot exist before review`);
  assert.equal(properties.includes('model_output'), true);
  const shipped = loadInput();
  assert.deepEqual(shipped.cases, []);
  assert.equal(shipped.live_proof, false);
  assert.deepEqual(preflight(shipped), []);
  assert.deepEqual(plan(shipped), []);
});

test('4D the prompt binds only to identifiers the input contract carries', () => {
  assert.deepEqual(checkPromptInputAgreement(), []);
  for (const binding of BINDINGS) {
    const prompt = fs.readFileSync(PROMPT_PATH, 'utf8');
    assert.ok(prompt.includes(binding.token), `the prompt must bind ${binding.name}`);
  }
  // The check must actually fail on the defect it exists for.
  // Every occurrence, because the output contract repeats the same token: a binding check that
  // only looks at the first mention would pass a prompt that never binds it.
  const broken = fs.readFileSync(PROMPT_PATH, 'utf8')
    .replaceAll('messages[].source_event_id', 'messages[].source_reference_id');
  assert.ok(checkPromptInputAgreement(broken)
    .some((rule) => rule.includes('unknown_input_identifier') || rule.includes('does_not_bind')));
  // An identifier the contract cannot provide must be caught, in the input section specifically.
  const invented = fs.readFileSync(PROMPT_PATH, 'utf8')
    .replace('- `offer`, `operator_goal`, `known_unknowns`.', '- `offer`, `operator_goal`, `subject.person_handle`.');
  assert.ok(checkPromptInputAgreement(invented)
    .includes('prompt_names_unknown_input_identifier:subject.person_handle'));
  // Legitimate input fields are not defects.
  assert.ok(!checkPromptInputAgreement().some((rule) => rule.startsWith('prompt_names_unknown')));
});

test('4D the staged graph must hold: unique ids, one anchor, resolvable replies', () => {
  assert.deepEqual(checkCaseGraph(stagedInput()), []);
  assert.ok(checkCaseGraph(stagedInput([stagedCase(), stagedCase()]))
    .includes('case:case-1:duplicate_case_id'));
  const twoAnchors = stagedCase({ messages: [message({ source_event_id: 'ev-1', is_anchor: true }),
    message({ source_event_id: 'ev-2' })] });
  assert.ok(checkCaseGraph(stagedInput([twoAnchors])).includes('case:case-1:expected_exactly_one_anchor'));
  const noAnchor = stagedCase({ messages: [message({ source_event_id: 'ev-1', is_anchor: false }),
    message({ source_event_id: 'ev-2', is_anchor: false })] });
  assert.ok(checkCaseGraph(stagedInput([noAnchor])).includes('case:case-1:expected_exactly_one_anchor'));
  const dangling = stagedCase({ messages: [message({ reply_to_id: 'ev-99' }), message({ source_event_id: 'ev-2' })] });
  assert.ok(checkCaseGraph(stagedInput([dangling])).some((rule) => rule.includes('reply_to_does_not_resolve')));
  const duplicateEvent = stagedCase({ messages: [message(), message()] });
  assert.ok(checkCaseGraph(stagedInput([duplicateEvent])).includes('case:case-1:duplicate_source_event_id'));
  const ghostSubject = stagedCase({ subject: { author_id: 'user-99' } });
  assert.ok(checkCaseGraph(stagedInput([ghostSubject])).some((rule) => rule.includes('subject_never_appears')));
  assert.ok(preflight(stagedInput([ghostSubject])).length > 0, 'preflight surfaces graph defects too');
});

test('4D a model output is only generated when it satisfies the contract and quotes the input', () => {
  const staged = stagedCase();
  assert.deepEqual(outputProblems(validOutput(), staged), []);
  const invented = structuredClone(validOutput());
  invented.next_action.evidence_message_ids = ['ev-999'];
  assert.ok(outputProblems(invented, staged).some((rule) => rule.includes('output_invents_source_event_id')));
  const ungrounded = structuredClone(validOutput());
  ungrounded.hypothesis.evidence[0].text = 'Текст, которого нет в источнике.';
  assert.ok(outputProblems(ungrounded, staged).some((rule) => rule.includes('span_text_is_not_grounded')));
  const wrongSubject = structuredClone(validOutput());
  wrongSubject.next_action.draft.target_id = 'user-99';
  assert.ok(outputProblems(wrongSubject, staged).includes('draft_target_must_be_the_subject'));
  const waitWithDraft = structuredClone(validOutput());
  waitWithDraft.next_action.decision = 'WAIT';
  assert.ok(outputProblems(waitWithDraft, staged).some((rule) => rule.includes('WAIT_must_not_carry_a_draft')));
  const dmNotPermitted = structuredClone(validOutput());
  dmNotPermitted.next_action.decision = 'DM';
  dmNotPermitted.next_action.draft.channel = 'dm';
  assert.ok(outputProblems(dmNotPermitted, staged).includes('draft_channel_is_not_permitted_for_this_situation'));
  const wrongSituation = structuredClone(validOutput());
  wrongSituation.next_action.situation_id = 'sit-99';
  assert.ok(outputProblems(wrongSituation, staged).includes('output_invents_situation_id'));
  assert.ok(outputProblems({ foo: 'bar' }, staged).some((rule) => rule.startsWith('output_schema:')));
  assert.deepEqual(outputProblems('not json at all', staged), ['output_is_not_json']);
  const unsupported = structuredClone(validOutput());
  unsupported.hypothesis.text = null;
  assert.ok(outputProblems(unsupported, staged).includes('evidence_without_hypothesis'));
});

test('4D calling a model and sending real words out are two different permissions', () => {
  const real = stagedCase({ provenance: { kind: 'anonymized_real', provenance_claim_ref: 'prov_x' } });
  const pointerOnly = generationGate(OPEN, stagedInput([real], { egress_authorisation_ref: 'owner-note-2026-01' }));
  assert.equal(pointerOnly.allowed, false, 'a pointer inside the file is not a permission');
  assert.ok(pointerOnly.reasons.includes('owner_has_not_authorised_real_text_egress'));
  const flagOnly = generationGate({ ...OPEN, HARNES_OWNER_APPROVED_REAL_TEXT_EGRESS: 'yes' }, stagedInput([real]));
  assert.equal(flagOnly.allowed, false, 'the flag alone is not an audit pointer');
  assert.ok(flagOnly.reasons.includes('real_text_requires_an_egress_audit_pointer'));
  const both = generationGate({ ...OPEN, HARNES_OWNER_APPROVED_REAL_TEXT_EGRESS: 'yes' },
    stagedInput([real], { egress_authorisation_ref: 'owner-note-2026-01' }));
  assert.equal(both.allowed, true, JSON.stringify(both.reasons));
  for (const value of ['YES', 'true', '1', undefined]) {
    assert.equal(generationGate({ ...OPEN, HARNES_OWNER_APPROVED_REAL_TEXT_EGRESS: value },
      stagedInput([real], { egress_authorisation_ref: 'owner-note-2026-01' })).allowed, false,
    `egress ${value} is not explicit`);
    assert.equal(generationGate({ HARNES_OWNER_APPROVED_MODEL_CALLS: value }, stagedInput()).allowed, false,
      `model calls ${value} is not explicit`);
  }
  // A fixture corpus needs no egress: nothing real leaves the machine.
  assert.equal(generationGate(OPEN, stagedInput()).allowed, true);
});

test('4D one staged case runs end to end on a stubbed call, and a rerun has nothing left', async () => {
  const input = stagedInput();
  const stored = new Map();
  const store = (caseId, payload) => stored.set(caseId, payload);
  const first = await runGeneration({ input, environment: OPEN, store, callModel: async () => validOutput() });
  assert.equal(first.exit, EXIT.done, JSON.stringify(first.summary));
  assert.equal(first.summary.planned, 1);
  assert.equal(first.summary.generated, 1);
  assert.equal(stored.size, 1);
  assert.equal(stored.get('case-1').prompt_sha256, first.summary.prompt_sha256);
  assert.equal(stored.get('case-1').raw, JSON.stringify(validOutput()), 'the raw model text is kept');

  const refused = await runGeneration({ input, environment: OPEN, store, callModel: async () => ({ foo: 'bar' }) });
  assert.equal(refused.exit, EXIT.nothing_to_do);
  assert.equal(refused.summary.refused, 1);
  assert.equal(stored.size, 1, 'a refused output is written nowhere');

  const done = { ...input, cases: [{ ...stagedCase(), model_output: validOutput() }] };
  const rerun = await runGeneration({ input: done, environment: OPEN, store, callModel: async () => validOutput() });
  assert.equal(rerun.exit, EXIT.nothing_to_do);
  assert.equal(rerun.summary.planned, 0);

  // No transport means the run refuses rather than guessing a provider.
  const noTransport = await runGeneration({ input, environment: OPEN, store });
  assert.equal(noTransport.exit, EXIT.refused);
  assert.ok(noTransport.reasons.some((reason) => reason.includes('no_model_transport_supplied')));
  // And an invalid corpus never reaches a call at all.
  let called = false;
  const invalid = await runGeneration({ input: stagedInput([stagedCase({ subject: { author_id: 'user-99' } })]),
    environment: OPEN, store, callModel: async () => { called = true; return validOutput(); } });
  assert.equal(invalid.exit, EXIT.invalid);
  assert.equal(called, false, 'a graph defect stops the run before any call');
});

test('4D the call ceiling is hard and not a budget the operator can raise here', () => {
  assert.equal(MAX_CALLS, 24);
  const many = stagedInput(Array.from({ length: MAX_CALLS + 1 }, (_, index) =>
    stagedCase({ case_id: `case-${index}` })));
  assert.ok(preflight(many).length > 0, 'a corpus beyond the ceiling is refused by shape');
  assert.ok(generationGate(OPEN, many).reasons.includes('corpus_exceeds_the_hard_call_ceiling'));
  const exact = stagedInput(Array.from({ length: MAX_CALLS }, (_, index) =>
    stagedCase({ case_id: `case-${index}` })));
  assert.deepEqual(preflight(exact), []);
});

test('4D the run refuses at the gate, and the finished-corpus contract is untouched', () => {
  const result = childProcess.spawnSync(process.execPath, [path.join(GENERATION, 'run.mjs')],
    { encoding: 'utf8' });
  assert.equal(result.status, EXIT.refused, 'refusing is its own exit code');
  const report = JSON.parse(result.stdout);
  assert.equal(report.exit, EXIT.refused);
  assert.equal(report.live_proof, false);
  assert.deepEqual(report.reasons, ['owner_has_not_authorised_model_calls']);

  assert.equal(fs.readdirSync(GENERATION).includes('outputs'), false, 'nothing is invented');
  for (const name of ['input.json', 'input.schema.json', 'output.schema.json', 'prompt.md', 'staging.mjs', 'run.mjs'])
    assert.ok(fs.existsSync(path.join(GENERATION, name)), name);
  assert.equal(fs.existsSync(path.join(GENERATION, 'corpus.json')), false,
    'the stale staging corpus is gone: input.json replaces it');
  const validate = fs.readFileSync(path.join(GENERATION, '..', 'validate.mjs'), 'utf8');
  assert.match(validate, /exactly_two_reviews_required/);
  assert.match(validate, /offline_human_eval/);
  assert.ok(fs.existsSync(INPUT_PATH));
});
