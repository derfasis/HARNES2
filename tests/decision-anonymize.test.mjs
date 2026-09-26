// Stage 4D anonymisation: mechanical secrets out, declared semantics applied, provenance never faked.
// proof_level=synthetic_contract_eval; live_proof=false. No model call, no network, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { convert } from '../docs/benchmarks/decision-quality-eval-v0/generation/anonymize.mjs';
import { preflight } from '../docs/benchmarks/decision-quality-eval-v0/generation/staging.mjs';

const conversation = (over = {}) => ({
  case_id: 'case-1',
  subject_author: 'Ирина Ковальчук',
  anchor_source_event_id: 'm-2',
  messages: [
    { source_event_id: 'm-1', author: 'Олег Петров', direction: 'in', channel: 'public',
      text: 'Обсуждаем партнёрство в wellness.', created_at: '2026-01-01T00:00:00.000Z', reply_to_id: null },
    { source_event_id: 'm-2', author: 'Ирина Ковальчук', direction: 'in', channel: 'public',
      text: 'Сколько стоит участие в 18 000 евро? Мой email: irina@example.com', created_at: '2026-01-01T00:05:00.000Z',
      reply_to_id: 'm-1' },
  ],
  offer: 'Synthetic offer', operator_goal: 'Assess usefulness.', known_unknowns: [], ...over });

const source = (over = {}) => ({ input_id: 'd4-generation-v0', prompt_ref: 'prompt-7',
  offer: 'Synthetic offer', operator_goal: 'Assess usefulness.', cases: [conversation()], ...over });

const real = { kind: 'real', provenance_claim_ref: 'prov_source_42' };
const synthetic = { kind: 'synthetic' };

test('4D mechanical secrets are removed and the staged case still validates', () => {
  const { input, problems, audit: record } = convert({ source: source(), provenance: real });
  assert.deepEqual(problems, [], JSON.stringify(problems));
  assert.deepEqual(preflight(input), [], 'the converted case must satisfy the staging contract');
  const text = input.cases[0].messages.map((message) => message.text).join(' ');
  assert.ok(!text.includes('irina@example.com'), 'the address is gone');
  assert.ok(text.includes('[EMAIL_1]'), 'and replaced by a placeholder');
  assert.ok(!text.includes('Ирина Ковальчук'), 'no real name survives');
  assert.ok(input.cases[0].messages[0].text.includes('wellness'), 'the signal that matters is preserved');
  assert.ok(record.applied.some((entry) => entry.endsWith(':email')));
  assert.equal(record.source_kind, 'real');
  assert.equal(record.provenance_claim_ref, 'prov_source_42');
});

test('4D the converter decides nothing: cases, subject and anchor arrive selected', () => {
  const noCase = convert({ source: source({ cases: [] }), provenance: real });
  assert.equal(noCase.input, null);
  assert.ok(noCase.problems.includes('a_source_must_carry_selected_cases'));
  const noSubject = convert({ source: source({ cases: [conversation({ subject_author: undefined })] }),
    provenance: real });
  assert.equal(noSubject.input, null);
  assert.ok(noSubject.problems.some((rule) => rule.includes('must_choose_the_subject')));
  const noAnchor = convert({ source: source({ cases: [conversation({ anchor_source_event_id: 'absent' })] }),
    provenance: real });
  assert.equal(noAnchor.input, null);
  assert.ok(noAnchor.problems.some((rule) => rule.includes('choose_exactly_one_anchor')));
  // The anchor must resolve to exactly one message, so a duplicated id is refused rather than
  // silently choosing one of them.
  const ambiguous = convert({ source: source({ cases: [conversation({
    messages: [conversation().messages[0], { ...conversation().messages[1], source_event_id: 'm-1' }] })] }),
  provenance: real });
  assert.equal(ambiguous.input, null);
  assert.ok(ambiguous.problems.some((rule) => rule.includes('choose_exactly_one_anchor')));
});

test('4D a semantic replacement is applied because it was declared, not because it was guessed', () => {
  const declared = convert({ source: source({ cases: [conversation({
    replacements: [{ match: '18 000 евро', replacement: '[HIGH_VALUE_AMOUNT]' }] })] }), provenance: real });
  assert.deepEqual(declared.problems, []);
  assert.ok(declared.input.cases[0].messages[1].text.includes('[HIGH_VALUE_AMOUNT]'));
  assert.ok(declared.audit.declared.some((entry) => entry.includes('[HIGH_VALUE_AMOUNT]')));
  // Without a declaration the amount stays: guessing would be a silent semantic decision.
  const undeclared = convert({ source: source(), provenance: real });
  assert.ok(undeclared.input.cases[0].messages[1].text.includes('18 000 евро'));
  assert.equal(undeclared.audit.declared.length, 0);
});

test('4D a real source without a provenance claim is refused, never relabelled as a fixture', () => {
  const { input, problems } = convert({ source: source(), provenance: { kind: 'real' } });
  assert.equal(input, null);
  assert.ok(problems.includes('a_real_source_without_a_provenance_claim_is_refused'));
  const syntheticCase = convert({ source: source(), provenance: synthetic });
  assert.deepEqual(syntheticCase.problems, []);
  assert.equal(syntheticCase.input.cases[0].provenance.kind, 'sanitized_fixture',
    'a synthetic source is a fixture, and says so');
  const realCase = convert({ source: source(), provenance: real });
  assert.equal(realCase.input.cases[0].provenance.kind, 'anonymized_real');
});

test('4D a placeholder is stable inside a case and different across cases', () => {
  const { input, problems } = convert({ source: source({ cases: [conversation(),
    conversation({ case_id: 'case-2' })] }), provenance: real });
  assert.deepEqual(problems, []);
  const [first, second] = input.cases;
  const firstSubject = first.messages.find((message) => message.source_event_id === 'm-2').author_id;
  assert.equal(firstSubject, first.subject.author_id, 'the same person keeps one name inside a case');
  const secondSubject = second.messages.find((message) => message.source_event_id === 'm-2').author_id;
  assert.notEqual(secondSubject, firstSubject, 'across cases the same person is a different placeholder');
  assert.equal(firstSubject, second.messages[0].author_id ? firstSubject : null,
    'the name is stable for every appearance in the case');
});

test('4D a secret that survives the conversion refuses the whole result', () => {
  // A replacement that reintroduces a literal the leak check knows about must stop the conversion.
  const leaky = convert({ source: source({ cases: [conversation({
    replacements: [{ match: 'Обсуждаем партнёрство', replacement: 'Ирина Ковальчук' }] })] }),
    provenance: real, sensitive_literals: ['Ирина Ковальчук'] });
  assert.equal(leaky.input, null, 'nothing is produced when a literal survives');
  assert.ok(leaky.problems[0].startsWith('the_anonymised_case_still_contains_source_material'));
});

test('4D the audit is a sidecar, never fields smuggled into the staging input', () => {
  const { input, audit: record } = convert({ source: source(), provenance: real });
  // The egress reference belongs to a real source and is required by the staging gate; nothing
  // else may be added.
  assert.deepEqual(Object.keys(input).sort(),
    ['cases', 'egress_authorisation_ref', 'input_id', 'live_proof', 'prompt_ref']);
  const syntheticInput = convert({ source: source(), provenance: synthetic }).input;
  assert.equal(syntheticInput.egress_authorisation_ref, undefined,
    'nothing real leaves the machine, so nothing is declared');
  assert.equal(record.rule_set, 'decision-quality-eval-v0/anonymization');
  assert.ok(Array.isArray(record.mechanical_classes));
  assert.ok(record.sensitive_literals_checked > 0, 'the check reports what it looked for');
  assert.equal(input.anonymization_audit, undefined, 'the audit never widens the staging schema');
});
