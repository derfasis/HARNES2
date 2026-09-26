// Source-agnostic anonymisation: a permitted conversation in, a staged case out.
//
// The converter decides nothing and defaults nothing. Which cases, who the subject is, which
// message is the anchor, the channel, the direction, the permitted channels, the offer, the goal —
// all of it arrives selected in the input. A missing or malformed field is refused rather than
// quietly filled in, because a default is a decision this code has no standing to make: a wrong
// `allowed_channels` would widen what the model may ever propose.
//
// What it does is mechanical: replace what it can recognise, apply the semantic replacements the
// source declared, refuse when anything known survived, and refuse to relabel real material as a
// fixture.
import { preflight } from './staging.mjs';

const MECHANICAL = [
  { kind: 'EMAIL', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: 'URL', pattern: /\bhttps?:\/\/\S+/g },
  { kind: 'PHONE', pattern: /(?:\+\d[\d\s().-]{7,}\d)/g },
  { kind: 'HANDLE', pattern: /(?<=^|\s)@[\w]{4,}/g },
];

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const name = (kind, salt, index) => `[${kind}_${salt}_${index}]`;

// One map per kind, per case: the same literal keeps one placeholder, two different literals never
// collapse into one, and nothing carries across cases.
function literalMap(kind, salt) {
  const seen = new Map();
  let next = 1;
  return {
    apply(literal) {
      if (!literal) return null;
      if (!seen.has(literal)) seen.set(literal, name(kind, salt, next++));
      return seen.get(literal);
    },
    get size() { return seen.size; },
  };
}

export const audit = (record) => ({
  rule_set: 'decision-quality-eval-v0/anonymization',
  mechanical_classes: MECHANICAL.map((entry) => entry.kind),
  applied: record.applied ?? [],
  declared: record.declared ?? [],
  source_kind: record.source_kind,
  provenance_claim_ref: record.provenance_claim_ref ?? null,
  sensitive_literals_checked: record.sensitive_literals_checked ?? 0,
});

const refused = (problems) => ({ input: null, audit: null, problems });
const oneOf = (value, allowed, what, at) => (allowed.includes(value) ? null : `${at}:${what}_must_be_one_of_${allowed.join('_')}`);

export function convert({ source, provenance, sensitive_literals = [] } = {}) {
  if (!source || typeof source !== 'object') return refused(['a_source_is_required']);
  const { cases, prompt_ref } = source;
  if (typeof prompt_ref !== 'string' || !prompt_ref) return refused(['the_source_must_name_its_prompt']);
  if (!Array.isArray(cases) || cases.length === 0) return refused(['a_source_must_carry_selected_cases']);
  // Real material may not be relabelled as a fixture when nobody recorded where it came from.
  if (provenance?.kind === 'real' && !/^prov_[A-Za-z0-9._-]+$/.test(provenance.provenance_claim_ref ?? ''))
    return refused(['a_real_source_without_a_provenance_claim_is_refused']);

  const applied = [], declared = [], removed = [];
  const staged = [];
  const problems = [];

  cases.forEach((item, index) => {
    const at = item?.case_id ?? `case_${index}`;
    const salt = index + 1;
    const people = literalMap('PERSON', salt);
    const messages = literalMap('MESSAGE', salt);
    const secrets = Object.fromEntries(MECHANICAL.map((entry) => [entry.kind, literalMap(entry.kind, salt)]));

    if (typeof at !== 'string' || !at) { problems.push(`${at}:the_source_must_select_and_name_each_case`); return; }
    if (typeof item.subject_author !== 'string' || !item.subject_author) {
      problems.push(`${at}:the_source_must_choose_the_subject`); return;
    }
    if (!item.situation_id || typeof item.situation_id !== 'string') { problems.push(`${at}:the_source_must_name_the_situation`); return; }
    if (typeof item.goal_text !== 'string' || !item.goal_text) { problems.push(`${at}:the_source_must_state_the_goal`); return; }
    if (!Array.isArray(item.allowed_channels) || item.allowed_channels.length === 0) {
      problems.push(`${at}:the_source_must_state_the_permitted_channels`); return;
    }
    const badChannel = item.allowed_channels.map((channel) => oneOf(channel, ['public', 'dm'], 'channel', at)).find(Boolean);
    if (badChannel) { problems.push(badChannel); return; }
    if (typeof item.offer !== 'string' || !item.offer) { problems.push(`${at}:the_source_must_state_the_offer`); return; }
    if (typeof item.operator_goal !== 'string' || !item.operator_goal) { problems.push(`${at}:the_source_must_state_the_operator_goal`); return; }
    if (!Array.isArray(item.messages) || item.messages.length === 0) { problems.push(`${at}:the_source_must_carry_the_messages`); return; }

    const anchors = item.messages.filter((message) => message.source_event_id === item.anchor_source_event_id);
    if (anchors.length !== 1) { problems.push(`${at}:the_source_must_choose_exactly_one_anchor`); return; }

    // Every author the source named is a secret wherever it appears, including inside message text.
    const authors = new Set([item.subject_author, ...item.messages.map((message) => message.author)]);
    for (const person of authors) { if (typeof person !== 'string' || !person) { problems.push(`${at}:every_message_needs_its_author`); return; } }

    const replacements = Array.isArray(item.replacements) ? item.replacements : [];
    for (const rule of replacements) {
      if (typeof rule?.match !== 'string' || !rule.match || typeof rule?.replacement !== 'string' || !rule.replacement)
        problems.push(`${at}:a_declared_replacement_needs_a_match_and_a_replacement`);
    }
    if (problems.length) return;

    const converted = item.messages.map((message) => {
      const badDirection = oneOf(message.direction, ['in', 'out'], 'direction', at);
      const badMessageChannel = oneOf(message.channel, ['public', 'dm'], 'channel', at);
      if (badDirection || badMessageChannel) { problems.push(badDirection ?? badMessageChannel); return null; }
      if (typeof message.text !== 'string' || !message.text) { problems.push(`${at}:every_message_needs_text`); return null; }
      if (typeof message.created_at !== 'string' || !message.created_at) { problems.push(`${at}:every_message_needs_a_time`); return null; }
      if (!Number.isInteger(message.version) || message.version < 1) { problems.push(`${at}:every_message_needs_its_version`); return null; }

      let text = message.text;
      // People first: a name written inside the text is still the person.
      for (const person of authors) {
        if (!text.includes(person)) continue;
        const stand_in = people.apply(person);
        text = text.split(person).join(stand_in);
        applied.push(`${at}:PERSON`); removed.push(person);
      }
      // Then the declared semantic replacements, in the order the source gave them.
      for (const rule of replacements) {
        const pattern = new RegExp(escapeRegExp(rule.match), 'g');
        if (pattern.test(text)) { text = text.replace(pattern, rule.replacement); declared.push(`${at}:${rule.replacement}`); }
      }
      // Then the mechanical secrets, one stable placeholder per distinct literal.
      for (const entry of MECHANICAL) {
        for (const match of text.match(entry.pattern) ?? []) {
          text = text.split(match).join(secrets[entry.kind].apply(match));
          applied.push(`${at}:${entry.kind}`); removed.push(match);
        }
      }
      // External ids are remapped through the same per-case table, and that is recorded as work.
      const eventId = messages.apply(String(message.source_event_id));
      const authorId = people.apply(message.author);
      applied.push(`${at}:MESSAGE`);
      return { source_event_id: eventId, author_id: authorId, version: message.version,
        channel: message.channel, direction: message.direction, text,
        created_at: message.created_at,
        reply_to_id: message.reply_to_id === undefined || message.reply_to_id === null
          ? null : messages.apply(String(message.reply_to_id)),
        is_anchor: message.source_event_id === item.anchor_source_event_id };
    });
    if (problems.length) return;
    if (converted.some((message) => message === null)) return;

    staged.push({ case_id: at,
      provenance: { kind: provenance?.kind === 'real' ? 'anonymized_real' : 'sanitized_fixture',
        ...(provenance?.kind === 'real' ? { provenance_claim_ref: provenance.provenance_claim_ref } : {}) },
      situation: { situation_id: item.situation_id, goal_text: item.goal_text,
        allowed_channels: [...item.allowed_channels] },
      subject: { author_id: people.apply(item.subject_author) },
      messages: converted, offer: item.offer, operator_goal: item.operator_goal,
      known_unknowns: Array.isArray(item.known_unknowns) ? item.known_unknowns : [] });
  });

  if (problems.length) return refused(problems);

  const input = { input_id: source.input_id ?? 'd4-generation-v0', live_proof: false, prompt_ref, cases: staged };
  if (provenance?.kind === 'real' && provenance.egress_authorisation_ref)
    input.egress_authorisation_ref = provenance.egress_authorisation_ref;

  // The leak check compares what the model will see against everything the source handed us.
  const visible = JSON.stringify(input);
  const rawAuthors = cases.flatMap((item) => [item.subject_author,
    ...(item.messages ?? []).map((message) => message.author)]);
  const rawEventIds = cases.flatMap((item) => (item.messages ?? []).map((message) => String(message.source_event_id)));
  const rawReplies = cases.flatMap((item) => (item.messages ?? [])
    .map((message) => message.reply_to_id).filter((value) => value !== null && value !== undefined).map(String));
  const candidates = [...new Set([...sensitive_literals, ...removed, ...rawAuthors, ...rawEventIds, ...rawReplies])]
    .filter((literal) => typeof literal === 'string' && literal.length > 0);
  const leaked = candidates.filter((literal) => visible.includes(literal));
  // A residual secret is one the mechanical rules should have caught and did not.
  for (const item of input.cases)
    for (const message of item.messages)
      for (const entry of MECHANICAL)
        if (new RegExp(entry.pattern.source, entry.pattern.flags.replace('g', '')).test(message.text))
          leaked.push(`residual_${entry.kind}`);
  if (leaked.length)
    return refused([`the_anonymised_case_still_contains_source_material:${leaked.length}:${[...new Set(leaked)].join('|')}`]);

  // Only a case that also satisfies the staging contract is a success.
  const checks = preflight(input);
  if (checks.length) return refused(checks);

  return { input, problems: [],
    audit: audit({ applied: [...new Set(applied)], declared: [...new Set(declared)],
      source_kind: provenance?.kind ?? 'synthetic', provenance_claim_ref: provenance?.provenance_claim_ref ?? null,
      sensitive_literals_checked: candidates.length }) };
}
