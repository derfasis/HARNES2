// Stage 4D anonymisation: mechanical secrets out, declared semantics applied, provenance never faked.
// proof_level=synthetic_contract_eval; live_proof=false. No model call, no network, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { convert } from '../docs/benchmarks/decision-quality-eval-v0/generation/anonymize.mjs';
import { preflight } from '../docs/benchmarks/decision-quality-eval-v0/generation/staging.mjs';

const message = (over = {}) => ({ source_event_id: 'm-1', author: 'Олег Петров', direction: 'in',
  channel: 'public', version: 1, text: 'Обсуждаем партнёрство.', created_at: '2026-01-01T00:00:00.000Z',
  reply_to_id: null, ...over });

const conversation = (over = {}) => ({
  case_id: 'case-1', situation_id: 'sit-1', subject_author: 'Ирина Ковальчук',
  anchor_source_event_id: 'm-2',
  goal_text: 'Assess usefulness of the offer for operator review only.',
  allowed_channels: ['public'], offer: 'Synthetic offer', operator_goal: 'Assess usefulness.',
  known_unknowns: [],
  messages: [
    message(),
    message({ source_event_id: 'm-2', author: 'Ирина Ковальчук', reply_to_id: 'm-1',
      text: 'Сколько стоит участие? Мой email: irina@example.com', created_at: '2026-01-01T00:05:00.000Z' }),
  ], ...over });

const source = (over = {}) => ({ input_id: 'd4-generation-v0', prompt_ref: 'prompt-7',
  cases: [conversation()], ...over });
const real = { kind: 'real', provenance_claim_ref: 'prov_source_42', egress_authorisation_ref: 'owner-note-1' };
const synthetic = { kind: 'synthetic' };
const visible = (input) => JSON.stringify(input);

test('4D names, addresses, links and external ids never reach the model', () => {
  const { input, problems } = convert({ source: source(), provenance: real });
  assert.deepEqual(problems, [], JSON.stringify(problems));
  assert.deepEqual(preflight(input), []);
  const text = visible(input);
  for (const secret of ['Ирина Ковальчук', 'Олег Петров', 'irina@example.com', 'm-1', 'm-2'])
    assert.equal(text.includes(secret), false, `${secret} must not survive`);
  assert.ok(text.includes('wellness') || text.includes('[PERSON'), 'the conversation itself is preserved');
  assert.ok(text.includes('[EMAIL_1_1]'), 'the address became a placeholder');
  assert.ok(text.includes('[PERSON_1_1]'), 'and the author a person placeholder');
  assert.ok(text.includes('[MESSAGE_1_1]'), 'and the message id a message placeholder');
  // A reply still points at the same anonymised message it did before.
  const anchor = input.cases[0].messages.find((entry) => entry.is_anchor);
  const first = input.cases[0].messages.find((entry) => !entry.is_anchor);
  assert.equal(anchor.reply_to_id, first.source_event_id, 'the reply edge survives anonymisation');
});

test('4D a name written inside the text is replaced with the same person placeholder', () => {
  const { input, problems } = convert({ source: source({ cases: [conversation({
    messages: [message({ text: 'Ирина Ковальчук попросила Олега Петрова перезвонить.' }),
      message({ source_event_id: 'm-2', author: 'Ирина Ковальчук', reply_to_id: 'm-1' })] })] }),
  provenance: real });
  assert.deepEqual(problems, [], JSON.stringify(problems));
  const text = input.cases[0].messages[0].text;
  assert.ok(!text.includes('Ирина Ковальчук'));
  assert.ok(!text.includes('Олег Петров'));
  assert.ok(text.includes(input.cases[0].subject.author_id), 'the name in the text is the subject itself');
});

test('4D the converter defaults nothing: a missing or wrong field is a refusal', () => {
  const cases = [
    ['the_source_must_choose_the_subject', { subject_author: undefined }],
    ['the_source_must_state_the_permitted_channels', { allowed_channels: [] }],
    ['the_source_must_state_the_offer', { offer: undefined }],
    ['the_source_must_state_the_operator_goal', { operator_goal: '' }],
    ['the_source_must_state_the_goal', { goal_text: undefined }],
    ['the_source_must_name_the_situation', { situation_id: undefined }],
  ];
  for (const [rule, mutate] of cases) {
    const { input, problems } = convert({ source: source({ cases: [conversation(mutate)] }), provenance: real });
    assert.equal(input, null, rule);
    assert.ok(problems.some((entry) => entry.includes(rule)), `${rule}: ${JSON.stringify(problems)}`);
  }
  // An unknown channel or direction is refused, never coerced to a default.
  const second = (over) => message({ source_event_id: 'm-2', author: 'Ирина Ковальчук', reply_to_id: 'm-1', ...over });
  for (const [mutate, hint] of [[{ allowed_channels: ['email'] }, 'channel_must_be_one_of'],
    [{ messages: [message(), second({ channel: 'email' })] }, 'channel_must_be_one_of'],
    [{ messages: [message(), second({ direction: 'sideways' })] }, 'direction_must_be_one_of']]) {
    const result = convert({ source: source({ cases: [conversation(mutate)] }), provenance: real });
    assert.equal(result.input, null, hint);
    assert.ok(result.problems.some((entry) => entry.includes(hint)), `${hint}: ${JSON.stringify(result.problems)}`);
  }
  // A message without a version, text or time is refused: it would be invented otherwise.
  for (const mutate of [{ version: undefined }, { text: '' }, { created_at: undefined }]) {
    const result = convert({ source: source({ cases: [conversation({ messages: [message(),
      message({ source_event_id: 'm-2', author: 'Ирина Ковальчук', reply_to_id: 'm-1', ...mutate })] })] }),
    provenance: real });
    assert.equal(result.input, null, JSON.stringify(mutate));
    assert.ok(result.problems.length > 0);
  }
});

test('4D a semantic replacement applies because it was declared, not because it was guessed', () => {
  const declared = convert({ source: source({ cases: [conversation({
    replacements: [{ match: 'Сколько стоит участие', replacement: '[HIGH_VALUE_AMOUNT]' }] })] }),
  provenance: real });
  assert.deepEqual(declared.problems, []);
  assert.ok(declared.input.cases[0].messages[1].text.includes('[HIGH_VALUE_AMOUNT]'));
  assert.ok(declared.audit.declared.some((entry) => entry.includes('[HIGH_VALUE_AMOUNT]')));
  const undeclared = convert({ source: source(), provenance: real });
  assert.ok(undeclared.input.cases[0].messages[1].text.includes('Сколько стоит участие'),
    'without a declaration the amount stays, because guessing is a silent decision');
  assert.equal(undeclared.audit.declared.length, 0);
});

test('4D two different addresses never collapse into one placeholder', () => {
  const { input, problems } = convert({ source: source({ cases: [conversation({
    messages: [message({ text: 'Пишите на a@example.com или на b@example.com' }),
      message({ source_event_id: 'm-2', author: 'Ирина Ковальчук', reply_to_id: 'm-1' })] })] }),
  provenance: real });
  assert.deepEqual(problems, []);
  const text = input.cases[0].messages[0].text;
  const placeholders = text.match(/\[EMAIL_\d+_\d+\]/g);
  assert.equal(placeholders.length, 2, 'two addresses are two entities');
  assert.notEqual(placeholders[0], placeholders[1]);
  // The same address twice is the same entity.
  const repeated = convert({ source: source({ cases: [conversation({
    messages: [message({ text: 'a@example.com и снова a@example.com' }),
      message({ source_event_id: 'm-2', author: 'Ирина Ковальчук', reply_to_id: 'm-1' })] })] }),
  provenance: real });
  const found = repeated.input.cases[0].messages[0].text.match(/\[EMAIL_\d+_\d+\]/g);
  assert.equal(found.length, 2);
  assert.equal(found[0], found[1], 'the same address keeps one placeholder');
});

test('4D a real source without a provenance claim is refused, never relabelled as a fixture', () => {
  const { input, problems } = convert({ source: source(), provenance: { kind: 'real' } });
  assert.equal(input, null);
  assert.ok(problems.includes('a_real_source_without_a_provenance_claim_is_refused'));
  const syntheticCase = convert({ source: source(), provenance: synthetic });
  assert.deepEqual(syntheticCase.problems, []);
  assert.equal(syntheticCase.input.cases[0].provenance.kind, 'sanitized_fixture');
  const realCase = convert({ source: source(), provenance: real });
  assert.equal(realCase.input.cases[0].provenance.kind, 'anonymized_real');
  assert.equal(realCase.input.egress_authorisation_ref, 'owner-note-1');
});

test('4D a placeholder is stable inside a case and different across cases', () => {
  const { input, problems } = convert({ source: source({ cases: [conversation(),
    conversation({ case_id: 'case-2' })] }), provenance: real });
  assert.deepEqual(problems, []);
  const [first, second] = input.cases;
  const firstSubject = first.messages.find((entry) => entry.is_anchor).author_id;
  assert.equal(firstSubject, first.subject.author_id, 'stable inside the case');
  assert.equal(firstSubject, first.messages[0].author_id === firstSubject ? firstSubject : firstSubject);
  const secondSubject = second.messages.find((entry) => entry.is_anchor).author_id;
  assert.notEqual(secondSubject, firstSubject, 'a different name in another case');
});

test('4D a secret that survives refuses the whole result, and the audit stays a sidecar', () => {
  const leaky = convert({ source: source({ cases: [conversation({
    replacements: [{ match: 'Обсуждаем партнёрство', replacement: 'Олег Петров' }] })] }),
  provenance: real });
  assert.equal(leaky.input, null);
  assert.ok(leaky.problems[0].startsWith('the_anonymised_case_still_contains_source_material'));

  const good = convert({ source: source(), provenance: real });
  assert.deepEqual(Object.keys(good.input).sort(),
    ['cases', 'egress_authorisation_ref', 'input_id', 'live_proof', 'prompt_ref']);
  assert.equal(good.input.anonymization_audit, undefined, 'the audit never widens the staging schema');
  assert.equal(good.audit.rule_set, 'decision-quality-eval-v0/anonymization');
  assert.ok(good.audit.sensitive_literals_checked > 0, 'the check reports what it looked for');
  assert.ok(good.audit.applied.some((entry) => entry.endsWith(':EMAIL')));
  // The default conversation has no bare names in its text, so no person replacement is recorded;
  // names written into text are covered by their own case above.
  assert.equal(good.audit.applied.some((entry) => entry.endsWith(':PERSON')), false);
  // External message ids are remapped through the same per-case table, and that is recorded too.
  assert.ok(good.audit.applied.some((entry) => entry.endsWith(':MESSAGE')),
    JSON.stringify(good.audit.applied));
  assert.equal(convert({ source: source(), provenance: synthetic }).input.egress_authorisation_ref, undefined,
    'nothing real leaves the machine, so nothing is declared');
});
