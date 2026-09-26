// Stage 4D anonymisation: mechanical secrets out, declared semantics applied, provenance never faked.
// proof_level=synthetic_contract_eval; live_proof=false. No model call, no network, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { convert } from '../docs/benchmarks/decision-quality-eval-v0/generation/anonymize.mjs';
import { preflight } from '../docs/benchmarks/decision-quality-eval-v0/generation/staging.mjs';

const IRINA = ['Ирина Ковальчук', 'Ирину Ковальчук', 'Ирине Ковальчук'];
const OLEG = ['Олег Петров', 'Олега Петрова', 'Олег Петрову'];

const message = (over = {}) => ({ source_event_id: 'm-1', author: OLEG[0], author_aliases: OLEG,
  direction: 'in', channel: 'public', version: 1, text: 'Обсуждаем партнёрство.',
  created_at: '2026-01-01T00:00:00.000Z', reply_to_id: null, ...over });

const conversation = (over = {}) => ({
  case_id: 'case-1', situation_id: 'sit-1', subject_author: IRINA[0], subject_aliases: IRINA,
  anchor_source_event_id: 'm-2',
  goal_text: 'Assess usefulness of the offer for operator review only.',
  allowed_channels: ['public'], offer: 'Synthetic offer', operator_goal: 'Assess usefulness.',
  known_unknowns: ['Цена не подтверждена.'],
  messages: [
    message(),
    message({ source_event_id: 'm-2', author: IRINA[0], author_aliases: IRINA, reply_to_id: 'm-1',
      text: `${IRINA[2]}, сколько стоит участие? Мой email: irina@example.com`,
      created_at: '2026-01-01T00:05:00.000Z' }),
  ], ...over });

const source = (over = {}) => ({ input_id: 'd4-generation-v0', prompt_ref: 'prompt-7',
  cases: [conversation()], ...over });
const real = { kind: 'real', provenance_claim_ref: 'prov_source_42', egress_authorisation_ref: 'owner-note-1' };
const synthetic = { kind: 'synthetic' };
const visible = (input) => JSON.stringify(input);
test('4D names in every form, addresses, links and external ids never reach the model', () => {
  const { input, problems } = convert({ source: source(), provenance: real });
  assert.deepEqual(problems, [], JSON.stringify(problems));
  assert.deepEqual(preflight(input), []);
  const text = visible(input);
  for (const secret of [...IRINA, ...OLEG, 'irina@example.com', 'm-1', 'm-2'])
    assert.equal(text.includes(secret), false, `${secret} must not survive`);
  assert.ok(text.includes('[EMAIL_1_1]'));
  assert.ok(text.includes('[MESSAGE_1_1]'));
  const anchor = input.cases[0].messages.find((entry) => entry.is_anchor);
  const first = input.cases[0].messages.find((entry) => !entry.is_anchor);
  assert.equal(anchor.reply_to_id, first.source_event_id, 'the reply edge survives anonymisation');
});

test('4D an inflected name is replaced, not just the canonical form', () => {
  const { input, problems } = convert({ source: source({ cases: [conversation({
    messages: [message({ text: `${OLEG[1]} попросил ${IRINA[1]} перезвонить.` }),
      message({ source_event_id: 'm-2', author: IRINA[0], author_aliases: IRINA, reply_to_id: 'm-1' })] })] }),
  provenance: real });
  assert.deepEqual(problems, [], JSON.stringify(problems));
  const text = input.cases[0].messages[0].text;
  assert.ok(!text.includes(OLEG[1]), 'the inflected form is gone too');
  assert.ok(!text.includes(IRINA[1]));
  // Every form of one person is one placeholder.
  const placeholders = text.match(/\[PERSON_\d+_\d+\]/g);
  assert.equal(new Set(placeholders).size, 2, 'two people, two placeholders');
});

test('4D a secret in any model-visible field is removed, not only in message text', () => {
  const { input, problems } = convert({ source: source({ cases: [conversation({
    offer: 'Напиши owner@example.com',
    known_unknowns: ['Не понятно, звонил ли клиент +7 999 123 45 67 или нет'],
    goal_text: 'Ссылка на программу: https://example.com/program' })] }), provenance: real });
  assert.deepEqual(problems, [], JSON.stringify(problems));
  const text = visible(input);
  assert.ok(!text.includes('owner@example.com'), 'the offer is sanitised');
  assert.ok(!text.includes('https://example.com/program'), 'the goal text is sanitised');
  assert.ok(!/\+7 999 123 45 67/.test(text), 'a phone in a known unknown is sanitised');
  assert.ok(text.includes('[EMAIL_'), 'and replaced by a placeholder');
});

test('4D the converter invents nothing: every required field must arrive', () => {
  const cases = [
    ['the_source_must_choose_the_subject', { subject_author: undefined }],
    ['the_source_must_name_the_situation', { situation_id: undefined }],
    ['the_source_must_state_the_goal', { goal_text: undefined }],
    ['the_source_must_state_the_permitted_channels', { allowed_channels: [] }],
    ['the_source_must_state_the_offer', { offer: undefined }],
    ['the_source_must_state_the_operator_goal', { operator_goal: undefined }],
    ['the_source_must_state_the_known_unknowns', { known_unknowns: undefined }],
    ['the_source_must_select_and_name_each_case', { case_id: undefined }],
  ];
  for (const [rule, mutate] of cases) {
    const { input, problems } = convert({ source: source({ cases: [conversation(mutate)] }), provenance: real });
    assert.equal(input, null, rule);
    assert.ok(problems.some((entry) => entry.includes(rule)), `${rule}: ${JSON.stringify(problems)}`);
  }
  // A message without an id cannot be anonymised into a fresh one.
  const noId = convert({ source: source({ cases: [conversation({ messages: [
    message({ source_event_id: undefined }),
    message({ source_event_id: 'm-2', author: IRINA[0], author_aliases: IRINA, reply_to_id: 'm-1' })] })] }),
  provenance: real });
  assert.equal(noId.input, null);
  assert.ok(noId.problems.some((entry) => entry.includes('every_message_needs_its_source_event_id')));
  // A person without declared forms is refused: the converter cannot guess inflection.
  const noAliases = convert({ source: source({ cases: [conversation({ subject_aliases: undefined })] }),
    provenance: real });
  assert.equal(noAliases.input, null);
  assert.ok(noAliases.problems.some((entry) => entry.includes('must_list_the_forms_of_every_person')));
});

test('4D a wrong channel or direction is refused, never coerced', () => {
  for (const [mutate, hint] of [[{ allowed_channels: ['email'] }, 'channel_must_be_one_of'],
    [{ messages: [message(), message({ source_event_id: 'm-2', author: IRINA[0], author_aliases: IRINA,
      reply_to_id: 'm-1', channel: 'email' })] }, 'channel_must_be_one_of'],
    [{ messages: [message(), message({ source_event_id: 'm-2', author: IRINA[0], author_aliases: IRINA,
      reply_to_id: 'm-1', direction: 'sideways' })] }, 'direction_must_be_one_of']]) {
    const result = convert({ source: source({ cases: [conversation(mutate)] }), provenance: real });
    assert.equal(result.input, null, hint);
    assert.ok(result.problems.some((entry) => entry.includes(hint)), `${hint}: ${JSON.stringify(result.problems)}`);
  }
});

test('4D provenance is decided, never defaulted: only real or synthetic', () => {
  const { input, problems } = convert({ source: source(), provenance: { kind: 'real' } });
  assert.equal(input, null);
  assert.ok(problems.includes('a_real_source_without_a_provenance_claim_is_refused'));
  for (const kind of [undefined, 'banana', '', null, 'REal'])
    assert.ok(convert({ source: source(), provenance: kind === undefined ? {} : { kind } }).problems
      .includes('provenance_kind_must_be_real_or_synthetic'), JSON.stringify(kind));
  const fixture = convert({ source: source(), provenance: synthetic });
  assert.deepEqual(fixture.problems, []);
  assert.equal(fixture.input.cases[0].provenance.kind, 'sanitized_fixture');
  const realCase = convert({ source: source(), provenance: real });
  assert.equal(realCase.input.cases[0].provenance.kind, 'anonymized_real');
  assert.equal(realCase.input.egress_authorisation_ref, 'owner-note-1');
  assert.equal(fixture.input.egress_authorisation_ref, undefined,
    'nothing real leaves the machine, so nothing is declared');
});

test('4D a semantic replacement applies because it was declared, not because it was guessed', () => {
  const declared = convert({ source: source({ cases: [conversation({
    replacements: [{ match: 'сколько стоит участие', replacement: '[HIGH_VALUE_AMOUNT]' }] })] }),
  provenance: real });
  assert.deepEqual(declared.problems, []);
  assert.ok(declared.input.cases[0].messages[1].text.includes('[HIGH_VALUE_AMOUNT]'));
  assert.ok(declared.audit.declared.some((entry) => entry.includes('[HIGH_VALUE_AMOUNT]')));
  const undeclared = convert({ source: source(), provenance: real });
  assert.ok(undeclared.input.cases[0].messages[1].text.includes('сколько стоит участие'),
    'without a declaration the phrase stays, because guessing is a silent decision');
  assert.equal(undeclared.audit.declared.length, 0);
});

test('4D two different addresses never collapse into one placeholder', () => {
  const { input, problems } = convert({ source: source({ cases: [conversation({
    messages: [message({ text: 'Пишите на a@example.com или на b@example.com' }),
      message({ source_event_id: 'm-2', author: IRINA[0], author_aliases: IRINA, reply_to_id: 'm-1' })] })] }),
  provenance: real });
  assert.deepEqual(problems, []);
  const found = input.cases[0].messages[0].text.match(/\[EMAIL_\d+_\d+\]/g);
  assert.equal(found.length, 2);
  assert.notEqual(found[0], found[1]);
  const repeated = convert({ source: source({ cases: [conversation({
    messages: [message({ text: 'a@example.com и снова a@example.com' }),
      message({ source_event_id: 'm-2', author: IRINA[0], author_aliases: IRINA, reply_to_id: 'm-1' })] })] }),
  provenance: real });
  const again = repeated.input.cases[0].messages[0].text.match(/\[EMAIL_\d+_\d+\]/g);
  assert.equal(again[0], again[1], 'the same address keeps one placeholder');
});

test('4D a placeholder is stable inside a case and different across cases', () => {
  const { input, problems } = convert({ source: source({ cases: [conversation(),
    conversation({ case_id: 'case-2' })] }), provenance: real });
  assert.deepEqual(problems, []);
  const [first, second] = input.cases;
  const firstSubject = first.messages.find((entry) => entry.is_anchor).author_id;
  assert.equal(firstSubject, first.subject.author_id, 'stable inside the case');
  assert.notEqual(second.messages.find((entry) => entry.is_anchor).author_id, firstSubject,
    'a different name in another case');
});

test('4D a secret that survives refuses the result, and the audit stays a sidecar', () => {
  const leaky = convert({ source: source({ cases: [conversation({
    messages: [message(), message({ source_event_id: 'm-2', author: IRINA[0], author_aliases: IRINA,
      reply_to_id: 'm-1' })],
    replacements: [{ match: 'Обсуждаем партнёрство', replacement: OLEG[0] }] })] }), provenance: real });
  assert.equal(leaky.input, null);
  assert.ok(leaky.problems[0].startsWith('the_anonymised_case_still_contains_source_material'));

  const good = convert({ source: source(), provenance: real });
  assert.deepEqual(Object.keys(good.input).sort(),
    ['cases', 'egress_authorisation_ref', 'input_id', 'live_proof', 'prompt_ref']);
  assert.equal(good.input.anonymization_audit, undefined);
  assert.equal(good.audit.rule_set, 'decision-quality-eval-v0/anonymization');
  assert.ok(good.audit.sensitive_literals_checked > 0);
  for (const kind of ['EMAIL', 'PERSON', 'MESSAGE'])
    assert.ok(good.audit.applied.some((entry) => entry.endsWith(`:${kind}`)), kind);
});

test('4D every person declares their forms, not only the subject', () => {
  const missing = convert({ source: source({ cases: [conversation({
    messages: [message({ author_aliases: undefined }),
      message({ source_event_id: 'm-2', author: IRINA[0], author_aliases: IRINA, reply_to_id: 'm-1' })] })] }),
  provenance: real });
  assert.equal(missing.input, null);
  assert.ok(missing.problems.some((entry) => entry.includes('must_list_the_forms_of_every_person')));
  // The inflected form of a non-subject is gone when the source declared it.
  const declared = convert({ source: source({ cases: [conversation({
    messages: [message({ text: `${OLEG[1]} позвали` }),
      message({ source_event_id: 'm-2', author: IRINA[0], author_aliases: IRINA, reply_to_id: 'm-1' })] })] }),
  provenance: real });
  assert.deepEqual(declared.problems, []);
  assert.ok(!declared.input.cases[0].messages[0].text.includes(OLEG[1]));
});

test('4D the forms of one person are the union, and two people may not claim one form', () => {
  // Oleg speaks in both messages and the subject appears only in the second, so the subject is
  // still the anchor's author. The point of the case is the union of one person's forms.
  const split = convert({ source: source({ cases: [conversation({
    subject_author: OLEG[0], subject_aliases: OLEG, anchor_source_event_id: 'm-2',
    messages: [message({ author_aliases: [OLEG[0]] }),
      message({ source_event_id: 'm-2', author: OLEG[0], author_aliases: OLEG, reply_to_id: 'm-1', text: OLEG[1] })] })] }),
  provenance: real });
  assert.deepEqual(split.problems, [], JSON.stringify(split.problems));
  assert.ok(!split.input.cases[0].messages[1].text.includes(OLEG[1]),
    'a form declared only on a later message still applies');
  assert.equal(split.input.cases[0].messages[1].author_id, split.input.cases[0].subject.author_id);

  const collision = convert({ source: source({ cases: [conversation({
    subject_author: OLEG[0], subject_aliases: [OLEG[0], 'Саша'], anchor_source_event_id: 'm-2',
    messages: [message({ author: IRINA[0], author_aliases: [...IRINA, 'Саша'] }),
      message({ source_event_id: 'm-2', author: IRINA[0], author_aliases: IRINA, reply_to_id: 'm-1' })] })] }),
  provenance: real });
  assert.equal(collision.input, null);
  assert.ok(collision.problems.some((entry) => entry.includes('two_people_claim_the_same_form')));
});

test('4D a malformed source is refused, never an exception', () => {
  const cases = [undefined, null, {}, { source: 'broken' },
    { source: { cases: 'not a list', prompt_ref: 'p' } },
    { source: { cases: [{ case_id: 'c' }], prompt_ref: 'p' } },
    { source: { cases: [conversation({ replacements: 'nope' })], prompt_ref: 'p' } },
    { source: { cases: [conversation({ messages: [{ source_event_id: 7 }] })], prompt_ref: 'p' } },
    { source: { cases: [conversation({ messages: 'text' })], prompt_ref: 'p' } },
    { source: { cases: [conversation()], prompt_ref: 'p' }, provenance: { kind: ['real'] } },
    { source: { cases: [conversation()], prompt_ref: 'p' }, provenance: 7 }];
  for (const payload of cases) {
    let result;
    assert.doesNotThrow(() => { result = convert(payload); }, JSON.stringify(payload));
    assert.equal(result.input, null, JSON.stringify(payload));
    assert.ok(result.problems.length > 0, JSON.stringify(payload));
  }
});

test('4D a declared replacement is only reported as applied when it matched', () => {
  const matched = convert({ source: source({ cases: [conversation({
    replacements: [{ match: 'сколько стоит участие', replacement: '[HIGH_VALUE_AMOUNT]' }] })] }),
  provenance: real });
  assert.ok(matched.audit.declared.some((entry) => entry.includes('[HIGH_VALUE_AMOUNT]')));

  // The source declared one thing and the text says another. A typo there would otherwise ship a
  // case with the very amount it was asked to remove.
  const unmatched = convert({ source: source({ cases: [conversation({
    replacements: [{ match: '18 000 EUR', replacement: '[HIGH_VALUE_AMOUNT]' }] })] }), provenance: real });
  assert.equal(unmatched.input, null);
  assert.ok(unmatched.problems.some((entry) => entry.includes('a_declared_replacement_matched_nothing')));
});

test('4D a replacement that lives only in the offer is still applied and not refused', () => {
  // The rule has to be judged after every model-visible field has been through it. Checking while
  // the messages were still the last field to be read refuses an offer that matched perfectly well.
  for (const [field, value] of [['offer', 'Пакет Sigma 18 000 EUR'],
    ['operator_goal', 'Оценить пакет за 18 000 EUR'],
    ['goal_text', 'Оценить предложение на 18 000 EUR']]) {
    const { input, problems } = convert({ source: source({ cases: [conversation({
      [field]: value, replacements: [{ match: '18 000 EUR', replacement: '[HIGH_VALUE_AMOUNT]' }] })] }),
      provenance: real });
    assert.deepEqual(problems, [], `${field}: ${JSON.stringify(problems)}`);
    assert.ok(JSON.stringify(input).includes('[HIGH_VALUE_AMOUNT]'), `${field} is replaced`);
    assert.equal(input.cases[0].offer.includes('18 000 EUR'), false);
  }
  // known_unknowns travels through the same sanitiser and must behave the same way.
  const unknown = convert({ source: source({ cases: [conversation({
    known_unknowns: ['Цена 18 000 EUR не подтверждена.'],
    replacements: [{ match: '18 000 EUR', replacement: '[HIGH_VALUE_AMOUNT]' }] })] }), provenance: real });
  assert.deepEqual(unknown.problems, [], JSON.stringify(unknown.problems));
  assert.equal(unknown.input.cases[0].known_unknowns[0].includes('18 000 EUR'), false);
});

test('4D two rules sharing one replacement label are counted separately', () => {
  // Counting by label let a rule that matched nothing inherit the count of a sibling that matched,
  // so a typo in the second rule shipped the case with the text it was told to remove.
  const messages = [message({ text: 'цена 18 000 EUR' }),
    message({ source_event_id: 'm-2', author: IRINA[0], author_aliases: IRINA, reply_to_id: 'm-1' })];
  const shared = convert({ source: source({ cases: [conversation({
    messages, offer: 'Пакет Sigma без второй суммы',
    replacements: [{ match: '18 000 EUR', replacement: '[MONEY]' },
      { match: '30 000 EUR', replacement: '[MONEY]' }] })] }), provenance: real });
  assert.equal(shared.input, null, 'the second rule matched nothing and must refuse');
  assert.ok(shared.problems.some((entry) => entry.includes('a_declared_replacement_matched_nothing')));
  // Both rules matching is still a success, even though they share one label.
  const both = convert({ source: source({ cases: [conversation({
    messages, offer: 'Пакет Sigma и 30 000 EUR',
    replacements: [{ match: '18 000 EUR', replacement: '[MONEY]' },
      { match: '30 000 EUR', replacement: '[MONEY]' }] })] }), provenance: real });
  assert.deepEqual(both.problems, [], JSON.stringify(both.problems));
  assert.equal(both.input.cases[0].offer.includes('30 000 EUR'), false);
});

test('4D a short raw message id is checked structurally, not by substring', () => {
  // A real id of "1" also occurs in `version: 1` and inside its own replacement. Substring-scanning
  // the whole result refused a case whose ids were removed correctly.
  const { input, problems } = convert({ source: source({ cases: [conversation({
    anchor_source_event_id: '2',
    messages: [message({ source_event_id: '1' }),
      message({ source_event_id: '2', author: IRINA[0], author_aliases: IRINA, reply_to_id: '1',
        text: 'сколько стоит?' })] })] }), provenance: real });
  assert.deepEqual(problems, [], JSON.stringify(problems));
  const ids = input.cases[0].messages.map((entry) => entry.source_event_id);
  assert.deepEqual(ids, ['[MESSAGE_1_1]', '[MESSAGE_1_2]']);
  assert.equal(ids.includes('1'), false, 'the raw id is gone from the id fields');
  assert.equal(input.cases[0].messages[1].reply_to_id, '[MESSAGE_1_1]', 'the reply edge still points at it');
});

test('4D a raw message id is caught in prose and in the situation id, not only in the id fields', () => {
  // Checking ids structurally alone let an id that survived in the text or as a situation id ship.
  const inProse = convert({ source: source({ cases: [conversation({
    messages: [message({ text: 'в ответ на m-1 всё понятно' }),
      message({ source_event_id: 'm-2', author: IRINA[0], author_aliases: IRINA, reply_to_id: 'm-1' })] })] }),
    provenance: real });
  assert.equal(inProse.input, null, 'an id quoted in the text is still source material');
  assert.ok(inProse.problems.some((entry) => entry.startsWith('the_anonymised_case_still_contains_source_material')));

  const asSituation = convert({ source: source({ cases: [conversation({ situation_id: 'm-1' })] }),
    provenance: real });
  assert.equal(asSituation.input, null, 'an id standing where an id belongs has survived');
  assert.ok(asSituation.problems.some((entry) => entry.includes('residual_message_id')));
  // And a clean case is not refused just because its dates and times contain the id's digits.
  // "2026-01-01" contains a "1" that is not the id; only a standalone token counts.
  const clean = convert({ source: source({ cases: [conversation({
    anchor_source_event_id: '2',
    messages: [message({ source_event_id: '1', text: 'сообщение от 2026-01-01, всё в порядке' }),
      message({ source_event_id: '2', author: IRINA[0], author_aliases: IRINA, reply_to_id: '1',
        text: 'сколько стоит?' })] })] }), provenance: real });
  assert.deepEqual(clean.problems, [], JSON.stringify(clean.problems));
  assert.equal(clean.input.cases[0].messages[0].source_event_id, '[MESSAGE_1_1]');
});

test('4D one long form is never eaten by a shorter one', () => {
  // "Ann" is a form of Anna and also a prefix of the other person's name. Ordering the forms per
  // person would replace "Ann" first and leave "abel" behind; one global longest-first list cannot.
  const { input, problems } = convert({ source: source({ cases: [conversation({
    subject_author: 'Anna', subject_aliases: ['Anna', 'Ann'], anchor_source_event_id: 'm-2',
    messages: [message({ author: 'Annabel', author_aliases: ['Annabel'], text: 'Annabel и Anna вместе.' }),
      message({ source_event_id: 'm-2', author: 'Anna', author_aliases: ['Anna', 'Ann'],
        reply_to_id: 'm-1' })] })] }), provenance: real });
  assert.deepEqual(problems, [], JSON.stringify(problems));
  const text = input.cases[0].messages[0].text;
  assert.ok(!text.includes('Annabel'), 'the longest form is replaced first');
  assert.ok(!text.includes('Anna'), 'and the shorter form of the other person too');
  assert.ok(!text.includes('abel'), 'nothing survives as a fragment of a name');
  const placeholders = text.match(/\[PERSON_\d+_\d+\]/g) ?? [];
  assert.equal(placeholders.length, 2, 'two people, two placeholders');
  assert.equal(new Set(placeholders).size, 2, 'and they are not the same person');
  assert.equal(input.cases[0].subject.author_id, input.cases[0].messages[1].author_id,
    'both forms of Anna belong to the same person');
});

test('4D two people may not both claim one form', () => {
  const { input, problems } = convert({ source: source({ cases: [conversation({
    subject_author: 'Anna', subject_aliases: ['Anna', 'Ann'], anchor_source_event_id: 'm-2',
    messages: [message({ author: 'Ann', author_aliases: ['Ann', 'Anna'], text: 'Anna и Ann.' }),
      message({ source_event_id: 'm-2', author: 'Anna', author_aliases: ['Anna', 'Ann'],
        reply_to_id: 'm-1' })] })] }), provenance: real });
  assert.equal(input, null, 'a source that contradicts itself converts to nothing');
  assert.ok(problems.some((problem) => problem.includes('two_people_claim_the_same_form')));
});

test('4D sensitive literals are validated before they are used', () => {
  for (const literals of [123, [{}, 'abc'], ['ok', 7], { a: 1 }, true]) {
    const result = convert({ source: source(), provenance: real, sensitive_literals: literals });
    assert.equal(result.input, null, JSON.stringify(literals));
    assert.ok(result.problems.includes('sensitive_literals_must_be_a_list_of_strings'));
  }
  const absent = convert({ source: source(), provenance: real });
  assert.deepEqual(absent.problems, [], 'an absent list is empty, not a failure');
  const harmless = convert({ source: source(), provenance: real, sensitive_literals: ['Ирина Ковальчук'] });
  assert.deepEqual(harmless.problems, [], 'a declared literal that is gone is not a leak');
  assert.ok(!visible(harmless.input).includes('Ирина Ковальчук'));
  // A literal the converter has no rule for survives conversion, and the leak scan says so.
  const surviving = convert({ source: source({ cases: [conversation({
    offer: 'Пакет Sigma с промокодом FRIDAY42' })] }), provenance: real,
    sensitive_literals: ['промокодом FRIDAY42'] });
  assert.equal(surviving.input, null, 'a literal that survived refuses the result');
  assert.ok(surviving.problems[0].startsWith('the_anonymised_case_still_contains_source_material'));
});

// KNOWN GAP, documented and deliberately not asserted as fixed here.
//
// Real Telegram material showed that provenance_claim_ref and egress_authorisation_ref are the
// only fields the source fills in that the model can read, and nothing scanned them: a claim ref
// built from a real message id or a real chat id travels into the staged input untouched.
//
// The obvious fix, scanning those two fields as substrings, trades this for the false positive the
// rest of this file exists to prevent: a note reading "owner-note-1" collides with a real message
// id of "1". Making the pointer opaque by contract is the alternative, and it is a contract change
// with fixture churn, so it is a decision for review rather than something to slip in here.
test('4D the provenance pointer is currently an ungoverned path into the model', () => {
  const result = convert({ source: source(),
    provenance: { ...real, provenance_claim_ref: 'prov_ev_m-1' } });
  assert.notEqual(result.input, null,
    'this asserts the gap still exists; close it with a reviewed contract, not a substring scan');
  assert.equal(result.input.cases[0].provenance.provenance_claim_ref, 'prov_ev_m-1');
});
