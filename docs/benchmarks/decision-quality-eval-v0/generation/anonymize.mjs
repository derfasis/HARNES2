// Source-agnostic anonymisation: a permitted conversation in, a staged case out.
//
// The pipeline is strict on purpose, and in this order:
//   1. validate the raw source completely — nothing is invented or defaulted
//   2. build the person/alias and message-id maps for the case
//   3. sanitise *every* model-visible string, not only message text
//   4. apply the semantic replacements the source declared
//   5. scan the whole result for anything that survived
//   6. run the generation preflight
//   7. only then call it a success
//
// A name is not one string. Russian, Ukrainian and Croatian inflect it, and a converter that only
// matches the exact form leaves "Олега Петрова" sitting in the text. Morphology is not this
// program's job, so the source declares the aliases and every alias maps to the same placeholder.
import { preflight } from './staging.mjs';

const MECHANICAL = [
  { kind: 'EMAIL', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: 'URL', pattern: /\bhttps?:\/\/\S+/g },
  { kind: 'PHONE', pattern: /(?:\+\d[\d\s().-]{7,}\d)/g },
  { kind: 'HANDLE', pattern: /(?<=^|\s)@[\w]{4,}/g },
];

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const label = (kind, salt, index) => `[${kind}_${salt}_${index}]`;
const isText = (value) => typeof value === 'string' && value.length > 0;
const oneOf = (value, allowed) => allowed.includes(value) ? null : `must_be_one_of_${allowed.join('_')}`;

function table(kind, salt) {
  const seen = new Map();
  let next = 1;
  return {
    apply(literal) {
      if (!literal) return null;
      if (!seen.has(literal)) seen.set(literal, label(kind, salt, next++));
      return seen.get(literal);
    },
  };
}

export const audit = (record) => ({
  rule_set: 'decision-quality-eval-v0/anonymization',
  mechanical_classes: MECHANICAL.map((entry) => entry.kind),
  applied: [...new Set(record.applied ?? [])],
  declared: [...new Set(record.declared ?? [])],
  source_kind: record.source_kind,
  provenance_claim_ref: record.provenance_claim_ref ?? null,
  sensitive_literals_checked: record.sensitive_literals_checked ?? 0,
});

const refused = (problems) => ({ input: null, audit: null, problems: [...new Set(problems)] });

// 1. Everything the converter needs, validated before a single placeholder exists.
function validate({ source, provenance }) {
  const problems = [];
  if (!source || typeof source !== 'object') return ['a_source_is_required'];
  if (!isText(source.prompt_ref)) problems.push('the_source_must_name_its_prompt');
  if (!Array.isArray(source.cases) || source.cases.length === 0) problems.push('a_source_must_carry_selected_cases');
  // Provenance is decided here, not later: only two kinds exist, and anything else is unknown.
  const kind = provenance?.kind;
  if (kind === 'real') {
    if (!/^prov_[A-Za-z0-9._-]+$/.test(provenance.provenance_claim_ref ?? ''))
      problems.push('a_real_source_without_a_provenance_claim_is_refused');
  } else if (kind !== 'synthetic') {
    problems.push('provenance_kind_must_be_real_or_synthetic');
  }
  source.cases?.forEach((item, index) => {
    const at = isText(item?.case_id) ? item.case_id : `position_${index}`;
    if (!isText(item?.case_id)) problems.push(`${at}:the_source_must_select_and_name_each_case`);
    if (!isText(item?.situation_id)) problems.push(`${at}:the_source_must_name_the_situation`);
    if (!isText(item?.goal_text)) problems.push(`${at}:the_source_must_state_the_goal`);
    if (!Array.isArray(item?.allowed_channels) || item.allowed_channels.length === 0)
      problems.push(`${at}:the_source_must_state_the_permitted_channels`);
    for (const channel of item?.allowed_channels ?? [])
      if (oneOf(channel, ['public', 'dm'])) problems.push(`${at}:channel_${oneOf(channel, ['public', 'dm'])}`);
    if (!isText(item?.offer)) problems.push(`${at}:the_source_must_state_the_offer`);
    if (!isText(item?.operator_goal)) problems.push(`${at}:the_source_must_state_the_operator_goal`);
    if (!Array.isArray(item?.known_unknowns)) problems.push(`${at}:the_source_must_state_the_known_unknowns`);
    for (const entry of item?.known_unknowns ?? [])
      if (!isText(entry)) problems.push(`${at}:a_known_unknown_must_be_text`);
    if (item?.replacements !== undefined && !Array.isArray(item.replacements))
      problems.push(`${at}:replacements_must_be_a_list`);
    for (const rule of item?.replacements ?? [])
      if (!isText(rule?.match) || !isText(rule?.replacement))
        problems.push(`${at}:a_declared_replacement_needs_a_match_and_a_replacement`);
    if (!Array.isArray(item?.messages) || item.messages.length === 0) {
      problems.push(`${at}:the_source_must_carry_the_messages`);
      return;
    }
    const anchors = item.messages.filter((message) => message.source_event_id === item.anchor_source_event_id);
    if (anchors.length !== 1) problems.push(`${at}:the_source_must_choose_exactly_one_anchor`);
    for (const message of item.messages) {
      if (!isText(message?.source_event_id)) problems.push(`${at}:every_message_needs_its_source_event_id`);
      if (!isText(message?.author)) problems.push(`${at}:every_message_needs_its_author`);
      if (oneOf(message?.direction, ['in', 'out'])) problems.push(`${at}:direction_${oneOf(message?.direction, ['in', 'out'])}`);
      if (oneOf(message?.channel, ['public', 'dm'])) problems.push(`${at}:channel_${oneOf(message?.channel, ['public', 'dm'])}`);
      if (!Number.isInteger(message?.version) || message.version < 1) problems.push(`${at}:every_message_needs_its_version`);
      if (!isText(message?.text)) problems.push(`${at}:every_message_needs_text`);
      if (!isText(message?.created_at)) problems.push(`${at}:every_message_needs_a_time`);
      if (message?.reply_to_id !== undefined && message?.reply_to_id !== null
        && !isText(message.reply_to_id)) problems.push(`${at}:a_reply_id_must_be_text_or_absent`);
    }
    // People, with every form the source says they appear in. This is required of the subject and
    // of every other author: "the canonical form is enough" is exactly the guess that lets a
    // declined case of a name survive.
    if (!isText(item?.subject_author)) { problems.push(`${at}:the_source_must_choose_the_subject`); return; }
    if (!Array.isArray(item.subject_aliases)) { problems.push(`${at}:the_source_must_list_the_forms_of_every_person`); return; }
    const people = new Map();
    const declare = (author, aliases) => {
      if (!isText(author)) { problems.push(`${at}:every_message_needs_its_author`); return; }
      if (!Array.isArray(aliases)) { problems.push(`${at}:the_source_must_list_the_forms_of_every_person`); return; }
      for (const alias of aliases) if (!isText(alias)) problems.push(`${at}:a_person_alias_must_be_text`);
      // One person may appear many times; the forms are the union, not whoever spoke first.
      people.set(author, [...new Set([...(people.get(author) ?? []), author, ...aliases])]);
    };
    declare(item.subject_author, item.subject_aliases);
    for (const message of item.messages) declare(message.author, message.author_aliases);
    // One word claimed by two people is a contradiction in the source, not a choice to make here.
    const owner = new Map();
    for (const [author, forms] of people) for (const form of forms) {
      if (owner.has(form) && owner.get(form) !== author) {
        problems.push(`${at}:two_people_claim_the_same_form:${form}`);
      }
      owner.set(form, author);
    }
  });
  return problems;
}

export function convert(input = {}) {
  // A validator that can crash on the shape it is meant to judge is not a validator. Every entry
  // point here is guarded, so a broken source produces findings rather than an exception.
  let source, provenance, sensitive_literals = [];
  try {
    ({ source, provenance } = input ?? {});
    if (input && 'sensitive_literals' in input) sensitive_literals = input.sensitive_literals;
  } catch { return refused(['a_source_is_required']); }
  if (sensitive_literals === undefined) sensitive_literals = [];
  if (!Array.isArray(sensitive_literals) || sensitive_literals.some((value) => !isText(value)))
    return refused(['sensitive_literals_must_be_a_list_of_strings']);
  let problems;
  try { problems = validate({ source, provenance }); }
  catch (error) { return refused([`the_source_is_not_something_we_can_read:${error?.name ?? 'error'}`]); }
  if (problems.length) return refused(problems);

  const applied = [], declared = [], removed = [];
  const declaredReplacements = new Set();
  const staged = [];
  const kind = provenance.kind;

  source.cases.forEach((item, index) => {
    const at = item.case_id, salt = index + 1;
    const people = table('PERSON', salt), messages = table('MESSAGE', salt);
    const secrets = Object.fromEntries(MECHANICAL.map((entry) => [entry.kind, table(entry.kind, salt)]));
    // Every literal that identifies a person, in every form the source says it takes.
    // The union of every form of every person, rebuilt from the source that validation approved.
    const identities = new Map();
    const remember = (author, aliases) =>
      identities.set(author, [...new Set([...(identities.get(author) ?? []), author, ...aliases])]);
    remember(item.subject_author, item.subject_aliases);
    for (const message of item.messages) remember(message.author, message.author_aliases);
    for (const forms of identities.values()) for (const form of forms) removed.push(form);

    // 3. One sanitiser for every string the model will see, wherever it lives.
    // One order for every form of every person, longest first. Sorting per person would let a
    // short form consume part of a longer one: "Ann" turning "Anna" into "[PERSON_A]a".
    const orderedForms = [...identities.entries()]
      .flatMap(([author, forms]) => forms.map((form) => ({ form, author })))
      .sort((a, b) => b.form.length - a.form.length);
    const sanitize = (value) => {
      if (!isText(value)) return value;
      let text = value;
      for (const { form, author } of orderedForms) {
        if (!text.includes(form)) continue;
        text = text.split(form).join(people.apply(author));
        applied.push(`${at}:PERSON`);
      }
      for (const entry of MECHANICAL) {
        for (const match of text.match(entry.pattern) ?? []) {
          text = text.split(match).join(secrets[entry.kind].apply(match));
          applied.push(`${at}:${entry.kind}`); removed.push(match);
        }
      }
      return text;
    };
    // 4. Declared semantic replacements, applied to text that was already sanitised.
    const replacements = item.replacements ?? [];
    // Counted per rule, never per replacement label: two rules may share one label, and a rule
    // that matched nothing must not inherit its sibling's count.
    const matches = new Map();
    const withReplacements = (value) => {
      let text = sanitize(value);
      for (const [index, rule] of replacements.entries()) {
        const pattern = new RegExp(escapeRegExp(rule.match), 'g');
        const found = text.match(pattern) ?? [];
        matches.set(index, (matches.get(index) ?? 0) + found.length);
        if (!found.length) continue;
        text = text.replace(pattern, rule.replacement);
      }
      return text;
    };

    const converted = item.messages.map((message) => ({
      source_event_id: messages.apply(String(message.source_event_id)),
      author_id: people.apply(message.author),
      version: message.version,
      channel: message.channel,
      direction: message.direction,
      text: withReplacements(message.text),
      created_at: withReplacements(message.created_at),
      reply_to_id: message.reply_to_id === undefined || message.reply_to_id === null
        ? null : messages.apply(String(message.reply_to_id)),
      is_anchor: message.source_event_id === item.anchor_source_event_id,
    }));
    applied.push(`${at}:MESSAGE`);

    staged.push({ case_id: at,
      provenance: kind === 'real'
        ? { kind: 'anonymized_real', provenance_claim_ref: provenance.provenance_claim_ref }
        : { kind: 'sanitized_fixture' },
      situation: { situation_id: item.situation_id, goal_text: withReplacements(item.goal_text),
        allowed_channels: [...item.allowed_channels] },
      subject: { author_id: people.apply(item.subject_author) },
      messages: converted,
      offer: withReplacements(item.offer),
      operator_goal: withReplacements(item.operator_goal),
      known_unknowns: item.known_unknowns.map((entry) => withReplacements(entry)) });

    // A source that declared a replacement and then spelled it differently meant something to be
    // removed. Silently shipping the original text would undo the instruction it just gave. This
    // runs only after every model-visible field above has been through withReplacements, or a
    // replacement that lives in the offer alone would be reported as having matched nothing.
    for (const [index, rule] of replacements.entries()) {
      if (!(matches.get(index) > 0)) {
        problems.push(`${at}:a_declared_replacement_matched_nothing:${rule.replacement}`);
        return;
      }
      declaredReplacements.add(`${at}:${rule.replacement}`);
    }
  });

  // A case that failed while being converted is not a case, and an empty result is not a success.
  if (problems.length) return refused(problems);

  const staged_input = { input_id: isText(source.input_id) ? source.input_id : 'd4-generation-v0',
    live_proof: false, prompt_ref: source.prompt_ref, cases: staged };
  if (kind === 'real' && isText(provenance.egress_authorisation_ref))
    staged_input.egress_authorisation_ref = provenance.egress_authorisation_ref;

  // 5. Nothing the source handed us may still be visible, in any form it declared.
  // Prose is scanned as substring, because a name can appear anywhere inside a sentence. Structural
  // ids are compared field by field instead: a real message id of "1" also occurs in `version: 1`
  // and in its own replacement, and substring-scanning those would refuse a case that is clean.
  const visible = JSON.stringify(staged_input);
  const rawIds = [...new Set(source.cases.flatMap((item) => item.messages.flatMap((message) => [
    String(message.source_event_id),
    message.reply_to_id ? String(message.reply_to_id) : null])))]
    .filter((literal) => isText(literal));
  const outIds = new Set(staged_input.cases.flatMap((item) => item.messages.flatMap((message) => [
    message.source_event_id, message.reply_to_id])));
  const candidates = [...new Set([...sensitive_literals, ...removed,
    ...source.cases.flatMap((item) => [item.subject_author,
      ...item.messages.map((message) => message.author)]),
    ...source.cases.flatMap((item) => [...(item.subject_aliases ?? []),
      ...item.messages.flatMap((message) => message.author_aliases ?? [])])])]
    .filter((literal) => isText(literal));
  const leaked = candidates.filter((literal) => visible.includes(literal));
  for (const id of rawIds) {
    if (outIds.has(id)) leaked.push(`residual_message_id:${id}`);
  }
  for (const item of staged_input.cases) {
    const strings = [item.offer, item.operator_goal, item.situation.goal_text, ...item.known_unknowns,
      ...item.messages.map((message) => message.text), ...item.messages.map((message) => message.created_at)];
    for (const value of strings) for (const entry of MECHANICAL)
      if (new RegExp(entry.pattern.source, entry.pattern.flags.replace('g', '')).test(String(value ?? '')))
        leaked.push(`residual_${entry.kind}`);
  }
  if (leaked.length) return refused([`the_anonymised_case_still_contains_source_material:${[...new Set(leaked)].join('|')}`]);

  // 6. The staging contract decides whether this is a case at all.
  let checks;
  try { checks = preflight(staged_input); }
  catch (error) { return refused([`the_staged_case_could_not_be_validated:${error?.name ?? 'error'}`]); }
  if (checks.length) return refused(checks);

  declared.push(...declaredReplacements);
  return { input: staged_input, problems: [], audit: audit({ applied, declared, source_kind: kind,
    provenance_claim_ref: provenance.provenance_claim_ref ?? null, sensitive_literals_checked: candidates.length }) };
}
