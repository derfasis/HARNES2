import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Ajv from 'ajv';
import { buildOpportunityContext, parseOpportunityOutput, validateOpportunityOutput } from '../business/opportunity-projection.mjs';
import { buildRouterContext, parseSituationOutput } from '../business/situation-router.mjs';

const fixture = number => JSON.parse(fs.readFileSync(new URL(`../benchmarks/opportunity-projection-v0/case-0${number}.json`, import.meta.url), 'utf8'));
const options = { allowedSourceRefs: ['fixture://opportunity-projection-v0'] };
const prepare = (number = 1, extra = {}) => buildOpportunityContext(fixture(number), { ...options, ...extra });

function result(context, decision = 'PUBLIC_REPLY') {
  const message = context.input.message;
  return {
    contract_version: 'opportunity-projection-v0', situation_id: context.input.situation_id,
    opportunity: {
      hypothesis: 'An informational introduction may answer the subject\'s own question.',
      evidence: [{ message_id: message.id, author_id: message.author_id, version: context.source_metadata.at(-1).version,
        span: message.text, kind: 'question', attribution: 'author_statement' }],
      contradictions: [], unknowns: ['The subject has not agreed to any partnership or private contact.'],
    },
    next_action: {
      schema_version: 1, situation_id: context.input.situation_id, decision, confidence: 0.9,
      strategy: 'Consider a reviewed public answer.', reason: 'The subject asked an explicit public question.',
      evidence_message_ids: [message.id], unknowns: [], risk_flags: [],
      draft: decision === 'PUBLIC_REPLY' ? { channel: 'public', action: 'reply', target_id: message.author_id,
        text: 'A draft for owner review, not a sent answer.', source_message_ids: [message.id] } : null,
      review: { required: true, status: 'pending', authorization: 'none' }, reevaluate_after: null,
    },
    authority: { contact_permission: false, allowed_effects: [] },
  };
}

test('positive snapshot -> bounded context -> one supplied Router response -> validated projection', async () => {
  const context = prepare();
  let turns = 0;
  const routerTurn = async input => { turns++; assert.equal(input.active_offer.id, fixture(1).active_offer.id); return JSON.stringify(result(input)); };
  const output = parseOpportunityOutput(await routerTurn(context), context);
  assert.equal(turns, 1);
  assert.equal(output.next_action.decision, 'PUBLIC_REPLY');
  assert.equal(output.opportunity.evidence[0].version, 2);
  assert.deepEqual(output.authority, { contact_permission: false, allowed_effects: [] });
});

test('author-aware context retains ancestry and excludes unrelated thread', () => {
  const context = prepare();
  assert.deepEqual(context.input.snapshot.messages.map(message => message.id), ['m-101', 'm-103']);
  assert.equal(context.source_metadata[0].author_id, 'user-01');
  assert.equal(context.source_metadata.at(-1).reply_to_id, 'm-101');
  assert.equal(context.coverage.incomplete, false);
});

test('source allowance is required outside model output', () => {
  assert.throws(() => buildOpportunityContext(fixture(1)), /SOURCE_NOT_ALLOWED/);
  assert.throws(() => buildOpportunityContext(fixture(1), { allowedSourceRefs: ['another-source'] }), /SOURCE_NOT_ALLOWED/);
});

test('source versions are unique latest snapshots, not a new event store', () => {
  const input = fixture(1);
  input.messages.push({ ...input.messages.at(-1), version: 3 });
  assert.throws(() => buildOpportunityContext(input, options), /DUPLICATE_MESSAGE_ID/);
});

test('future input and invalid dates are not silently read', () => {
  const input = fixture(1);
  input.messages[0].created_at = '2026-01-01T00:04:00Z';
  assert.throws(() => buildOpportunityContext(input, options), /POST_ANCHOR_MESSAGE/);
  input.messages[0].created_at = '2026-02-31T00:01:00Z';
  assert.throws(() => buildOpportunityContext(input, options), /INVALID_TIME/);
});

test('equivalent UTC timestamp forms cannot break frozen v1 lexical chronology', () => {
  const input = fixture(1);
  const anchorTime = input.messages.at(-1).created_at;
  input.messages[0].created_at = anchorTime;
  input.messages.at(-1).created_at = anchorTime.replace('Z', '.000Z');
  const context = buildOpportunityContext(input, options);
  assert.equal(context.input.snapshot.messages[0].created_at, context.input.message.created_at);
  assert.equal(context.input.message.id, input.anchor_message_id);
});

test('exact source text is preserved including outer whitespace and Unicode', () => {
  const input = fixture(1);
  input.messages.at(-1).text = '  café: question  ';
  const context = buildOpportunityContext(input, options);
  assert.equal(context.input.message.text, '  café: question  ');
  const output = result(context);
  output.opportunity.evidence[0].span = 'cafe\u0301';
  assert.throws(() => validateOpportunityOutput(output, context), /SPAN_MISMATCH/);
});

test('fabricated spans, authors and stale versions are rejected', () => {
  const context = prepare();
  for (const patch of [{ span: 'fabricated' }, { author_id: 'other' }, { version: 1 }]) {
    const output = result(context);
    Object.assign(output.opportunity.evidence[0], patch);
    assert.throws(() => validateOpportunityOutput(output, context));
  }
});

test('another author, quoted evidence, offers and vulnerability cannot support a hypothesis', () => {
  const context = prepare(2);
  const output = result(context, 'IGNORE');
  const other = context.input.snapshot.messages[0];
  output.opportunity.evidence[0] = { message_id: other.id, author_id: other.author_id, version: 1,
    span: other.text, kind: 'need', attribution: 'author_statement' };
  assert.throws(() => validateOpportunityOutput(output, context), /NOT_SUBJECT_POSITIVE_EVIDENCE/);
  for (const patch of [{ attribution: 'quoted' }, { kind: 'offer' }, { kind: 'vulnerability' }]) {
    const candidate = result(context, 'IGNORE');
    Object.assign(candidate.opportunity.evidence[0], patch);
    assert.throws(() => validateOpportunityOutput(candidate, context), /NOT_SUBJECT_POSITIVE_EVIDENCE/);
  }
});

test('adversarial quote/refusal gives no hypothesis or authority', () => {
  const context = prepare(2);
  const output = result(context, 'IGNORE');
  output.opportunity.hypothesis = null;
  output.opportunity.evidence = [];
  output.opportunity.contradictions = [{ message_id: 'm-203', author_id: 'user-02', version: 1,
    span: 'не предлагайте мне партнёрство', kind: 'refusal', attribution: 'author_statement' }];
  assert.equal(validateOpportunityOutput(output, context).opportunity.hypothesis, null);
  const forged = result(context, 'IGNORE');
  forged.opportunity.contradictions = output.opportunity.contradictions;
  assert.throws(() => validateOpportunityOutput(forged, context), /CLOSED_OPENING/);
});

test('missing or budget-omitted parents are explicit unknowns, not inferred content', () => {
  const limited = prepare(1, { maxMessages: 1 });
  assert.equal(limited.coverage.incomplete, true);
  assert.deepEqual(limited.coverage.depth_limited_parent_ids, ['m-101']);
  assert.throws(() => validateOpportunityOutput(result(limited), limited), /INCOMPLETE_CONTEXT/);
  const output = result(limited, 'WAIT');
  output.opportunity.hypothesis = null; output.opportunity.evidence = [];
  assert.doesNotThrow(() => validateOpportunityOutput(output, limited));
  output.opportunity.unknowns = [];
  assert.throws(() => validateOpportunityOutput(output, limited), /MISSING_CONTEXT_UNKNOWNS/);
  output.opportunity.unknowns = ['   '];
  assert.throws(() => validateOpportunityOutput(output, limited), /EMPTY_UNKNOWN/);
  const input = fixture(1); input.messages.at(-1).reply_to_id = 'absent';
  const missing = buildOpportunityContext(input, options);
  assert.deepEqual(missing.coverage.missing_parent_ids, ['absent']);
  assert.equal(missing.source_metadata.at(-1).reply_to_id, 'absent');
  assert.equal(missing.input.message.reply_to_id, null);
});

test('duplicate evidence and unsupported hypotheses are rejected', () => {
  const context = prepare(), output = result(context);
  output.opportunity.evidence.push(structuredClone(output.opportunity.evidence[0]));
  assert.throws(() => validateOpportunityOutput(output, context), /DUPLICATE_OR_CONTRADICTORY_SPAN/);
  output.opportunity.evidence = [];
  assert.throws(() => validateOpportunityOutput(output, context), /UNSUPPORTED_HYPOTHESIS/);
});

test('projection cannot mint permission, effects, approvals, recipients or a private draft', () => {
  const context = prepare();
  for (const mutate of [
    output => { output.authority.contact_permission = true; },
    output => { output.authority.allowed_effects = ['send']; },
    output => { output.authority.recipient = 'user-02'; },
    output => { output.next_action.review.status = 'approved'; },
    output => { output.next_action.review.authorization = 'owner'; },
    output => { output.next_action.draft.target_id = 'another-subject'; },
    output => { output.next_action.decision = 'DM'; output.next_action.draft.channel = 'dm'; },
  ]) {
    const output = result(context); mutate(output);
    assert.throws(() => validateOpportunityOutput(output, context));
  }
});

test('frozen v1 still validates its own result and rejects the new top-level extension', () => {
  const context = prepare(), output = result(context);
  const v1 = buildRouterContext(context.input);
  assert.equal(v1.contract, 'situation-router-v1');
  assert.doesNotThrow(() => parseSituationOutput(output.next_action, v1.input));
  assert.throws(() => parseSituationOutput(output, v1.input));
});

test('the model receives a self-contained output schema including unchanged v1 fields', () => {
  const context = prepare();
  const validate = new Ajv({ strict: true, allowUnionTypes: true }).compile(context.output_contract);
  assert.equal(validate(result(context)), true);
  const output = result(context); delete output.next_action.review;
  assert.equal(validate(output), false);
});

test('depth, cycles and character budgets preserve full texts and signal incompleteness', () => {
  const input = fixture(1);
  input.messages = [
    { ...input.messages[0], id: 'root', thread_id: null },
    { ...input.messages[0], id: 'parent', reply_to_id: 'root', thread_id: null },
    { ...input.messages.at(-1), reply_to_id: 'parent', thread_id: null },
  ];
  const limited = buildOpportunityContext(input, { ...options, maxParentDepth: 1 });
  assert.deepEqual(limited.coverage.depth_limited_parent_ids, ['root']);
  assert.equal(limited.coverage.incomplete, true);
  input.messages = [input.messages.at(-1)]; input.messages[0].reply_to_id = 'm-103';
  assert.equal(buildOpportunityContext(input, options).coverage.reply_cycle, true);
  const short = fixture(1); short.messages[0].text = 'x'.repeat(1000);
  const bounded = buildOpportunityContext(short, { ...options, maxCharacters: 100 });
  assert.equal(bounded.input.message.text, short.messages.at(-1).text);
  assert.equal(bounded.coverage.incomplete, true);
  short.messages.at(-1).text = 'x'.repeat(101);
  assert.throws(() => buildOpportunityContext(short, { ...options, maxCharacters: 100 }), /ANCHOR_EXCEEDS_BUDGET/);
});

test('a null hypothesis cannot retain positive evidence', () => {
  const context = prepare(), output = result(context);
  output.opportunity.hypothesis = null;
  assert.throws(() => validateOpportunityOutput(output, context), /EVIDENCE_WITHOUT_HYPOTHESIS/);
});
