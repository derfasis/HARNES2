// Source-agnostic anonymisation: a permitted conversation in, a staged case out.
//
// The converter decides nothing. It does not choose cases, does not decide who the subject is,
// does not pick the anchor, and does not judge whether a conversation is interesting. All of that
// arrives selected in the input, because guessing it here would build a second router with none of
// the review the first one gets.
//
// What it does is mechanical and deterministic: it removes secrets it can recognise, applies the
// semantic replacements the source declared, refuses when a known secret survived, and refuses to
// relabel real material as a fixture.
import { preflight } from './staging.mjs';

// Literals that are a secret wherever they appear, recognised without being told.
const MECHANICAL = [
  { kind: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, placeholder: 'EMAIL' },
  { kind: 'url', pattern: /\bhttps?:\/\/\S+/g, placeholder: 'URL' },
  { kind: 'phone', pattern: /(?:\+\d[\d\s().-]{7,}\d)/g, placeholder: 'PHONE' },
  { kind: 'telegram_id', pattern: /\b@[\w]{4,}\b/g, placeholder: 'HANDLE' },
];

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const placeholder = (kind, n) => `[${kind}_${n}]`;

export const audit = (rules) => ({
  rule_set: 'decision-quality-eval-v0/anonymization',
  mechanical_classes: MECHANICAL.map((entry) => entry.kind),
  applied: rules.applied ?? [],
  declared: rules.declared ?? [],
  source_kind: rules.source_kind,
  provenance_claim_ref: rules.provenance_claim_ref ?? null,
  sensitive_literals_checked: rules.sensitive_literals_checked ?? 0,
});

// One stable name per person inside a single case, and a different one in every other case:
// reusing a placeholder across cases would let a model learn that one placeholder means two people.
function authorMap(caseSalt) {
  const seen = new Map();
  let next = 1;
  return {
    name(author) {
      if (!seen.has(author)) seen.set(author, placeholder(`PERSON_${caseSalt}_${next++}`));
      return seen.get(author);
    },
  };
}

export function convert({ source, provenance, sensitive_literals = [] } = {}) {
  const problems = [];
  if (!source || typeof source !== 'object') return { input: null, audit: null, problems: ['a_source_is_required'] };
  const { cases = [], prompt_ref, situation_goal, offer, operator_goal, known_unknowns = [] } = source;
  if (!Array.isArray(cases) || cases.length === 0) return { input: null, audit: null, problems: ['a_source_must_carry_selected_cases'] };
  if (typeof prompt_ref !== 'string' || !prompt_ref) return { input: null, audit: null, problems: ['the_source_must_name_its_prompt'] };

  // A real conversation may not be quietly relabelled as a fixture when nobody recorded where it
  // came from. It is refused instead.
  if (provenance?.kind === 'real' && !/^prov_[A-Za-z0-9._-]+$/.test(provenance.provenance_claim_ref ?? ''))
    return { input: null, audit: null, problems: ['a_real_source_without_a_provenance_claim_is_refused'] };

  const applied = [], declared = [], removed = [];
  const stagedCases = cases.map((item, index) => {
    if (typeof item.case_id !== 'string' || !item.case_id)
      return { problem: `case_${index}:the_source_must_select_and_name_each_case` };
    if (typeof item.subject_author !== 'string' || !item.subject_author)
      return { problem: `${item.case_id}:the_source_must_choose_the_subject` };
    if (!Array.isArray(item.messages) || item.messages.length === 0)
      return { problem: `${item.case_id}:the_source_must_carry_the_messages` };
    const anchor = item.messages.filter((message) => message.source_event_id === item.anchor_source_event_id);
    if (anchor.length !== 1)
      return { problem: `${item.case_id}:the_source_must_choose_exactly_one_anchor` };

    // Semantic replacements are declared by whoever holds the material. Nothing here guesses
    // whether a sum is decision-relevant; it only applies what it was told to apply.
    const replacements = Array.isArray(item.replacements) ? item.replacements : [];
    // One name map per case: a placeholder must not mean one person in every case of the corpus.
    const people = authorMap(index + 1);
    const messages = item.messages.map((message) => {
      let text = String(message.text ?? '');
      for (const rule of replacements) {
        if (typeof rule.match !== 'string' || !rule.match || typeof rule.replacement !== 'string' || !rule.replacement)
          continue;
        const pattern = new RegExp(escapeRegExp(rule.match), 'g');
        if (pattern.test(text)) { text = text.replace(pattern, rule.replacement); declared.push(`${item.case_id}:${rule.replacement}`); }
      }
      for (const entry of MECHANICAL) {
        if (entry.pattern.test(text)) {
          applied.push(`${item.case_id}:${entry.kind}`);
          // The removed literal is what the leak check must look for afterwards.
          for (const match of text.match(entry.pattern) ?? []) removed.push(match);
          text = text.replace(entry.pattern, placeholder(entry.placeholder, 1));
        }
        entry.pattern.lastIndex = 0;
      }
      return { source_event_id: String(message.source_event_id),
        author_id: people.name(message.author ?? message.author_id),
        version: 1, channel: message.channel === 'dm' ? 'dm' : 'public',
        direction: message.direction === 'out' ? 'out' : 'in', text,
        created_at: message.created_at,
        // A reply points at a message, not at a person, so it keeps the opaque source id.
        reply_to_id: message.reply_to_id === undefined || message.reply_to_id === null
          ? null : String(message.reply_to_id),
        is_anchor: message.source_event_id === item.anchor_source_event_id };
    });
    return { case_id: item.case_id,
      provenance: { kind: provenance?.kind === 'real' ? 'anonymized_real' : 'sanitized_fixture',
        ...(provenance?.kind === 'real' ? { provenance_claim_ref: provenance.provenance_claim_ref } : {}) },
      situation: { situation_id: item.situation_id ?? item.case_id,
        goal_text: item.goal_text ?? situation_goal ?? 'Assess usefulness for operator review only.',
        allowed_channels: Array.isArray(item.allowed_channels) && item.allowed_channels.length
          ? item.allowed_channels : ['public'] },
      subject: { author_id: people.name(item.subject_author) },
      messages, offer: item.offer ?? offer ?? 'Unknown offer', operator_goal: item.operator_goal ?? operator_goal ?? 'Assess usefulness.',
      known_unknowns: item.known_unknowns ?? known_unknowns };
  });

  const problemsFromCases = stagedCases.filter((item) => item.problem).map((item) => item.problem);
  if (problemsFromCases.length) return { input: null, audit: null, problems: problemsFromCases };

  const input = { corpus_id_free: true, input_id: source.input_id ?? 'd4-generation-v0',
    live_proof: false, prompt_ref, cases: stagedCases.map(({ _people, ...rest }) => rest) };
  delete input.corpus_id_free;
  if (provenance?.kind === 'real') input.egress_authorisation_ref = provenance.egress_authorisation_ref;

  // The leak check runs over exactly what the model will see.
  const visible = JSON.stringify(input);
  const literals = [...sensitive_literals, ...removed];
  const leaked = literals.filter((literal) => literal && visible.includes(literal));
  if (leaked.length)
    return { input: null, audit: null,
      problems: [`the_anonymised_case_still_contains_source_material:${leaked.length}`] };

  // Only now may the result be called a staged case, and only if it also satisfies the contract.
  const checks = preflight(input);
  if (checks.length) return { input: null, audit: null, problems: checks };

  return { input, audit: audit({ applied: [...new Set(applied)], declared: [...new Set(declared)],
    source_kind: provenance?.kind ?? 'synthetic', provenance_claim_ref: provenance?.provenance_claim_ref ?? null,
    sensitive_literals_checked: literals.length }), problems: [] };
}

