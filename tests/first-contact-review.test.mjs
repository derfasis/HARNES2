// First-contact approval is a separate, evidence-bound owner decision. These
// acceptance tests use synthetic source events and the real Audience commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { audienceHarness, SOURCE, proposalFrom, modelOutputFrom } from './audience-test-helpers.mjs';
import { ROOT } from '../business/config.mjs';
import { Store, id } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { exportPartner } from '../business/export.mjs';
import { processAudienceAssessment } from '../business/audience-reasoning.mjs';

async function ingestPublished(h, { message_id, text, version = 1, operation = 'upsert', source_id = SOURCE,
  thread_id = null, reply_to_id = null, author_id = `author:${source_id}`, published_at = new Date().toISOString() }) {
  return h.command('source.ingest', { source_id, source_kind:'sanitized_fixture', message_id, author_id,
    display_name:null, thread_id, reply_to_id, version, operation, text, created_at:published_at, updated_at:published_at },
  id(), { kind:'channel', sourceId:source_id });
}

async function proposed(t, { channel = 'public_reply', firstContact = {}, withReply = false, max_age_seconds = 3600,
  targetPublishedAt = new Date().toISOString(), corruptPublishedAt = undefined } = {}) {
  const h = audienceHarness(t);
  const goal = await h.open({ source_ids: [SOURCE], objective: 'Understand whether this public request needs a response.', max_age_seconds });
  const root = await ingestPublished(h, { message_id:'first-contact-target',
    text:'Could someone explain how to get started with the volunteer rota?', published_at:targetPublishedAt });
  if (corruptPublishedAt !== undefined) {
    const row = h.store.get('SELECT payload_json FROM events WHERE id=?', Number(root.source_event_id));
    const message = JSON.parse(row.payload_json);
    if (corruptPublishedAt === 'missing') delete message.created_at;
    else message.created_at = corruptPublishedAt;
    h.store.run('UPDATE events SET payload_json=? WHERE id=?', JSON.stringify(message), Number(root.source_event_id));
  }
  let reply;
  if (withReply) reply = await ingestPublished(h, { message_id:'first-contact-reply', reply_to_id:'first-contact-target',
    text:'The rota is still open for Saturday.' });
  h.service.audience.reconcile({ limit: 20 });
  const capture = await h.capture(goal.goal_id);
  const assessment = h.service.audience.assessment(capture.assessment_id);
  const target = assessment.packet.exchanges.flatMap(exchange => exchange.evidence)
    .find(evidence => evidence.source_event_id === String(root.source_event_id));
  assert.ok(target, 'positive target event is in the captured packet');
  const output = proposalFrom(assessment.packet, { next_step: 'prepare_material' });
  output.needs[0].material_preview.evidence_event_ids = [target.source_event_id];
  output.needs[0].first_contact = {
    version: 1, target_event_id: target.source_event_id, target_quote: target.text,
    channel, help: 'Offer a concise answer to the question and ask whether more detail would help.',
    channel_reason: 'The author asked a direct public question; a bounded public reply may help.' ,
    ...firstContact
  };
  const result = await h.command('audience.propose', { assessment_id: assessment.id, output });
  const need = h.service.audience.need(result.need_ids[0]);
  return { h, goal, root, reply, assessment, output, need, targetPublishedAt };
}

async function acceptNeed(h, need) {
  await h.command('audience.review', { need_id: need.id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint, decision: 'accept', note: 'Reviewed the evidence-backed need.' });
  return h.service.audience.need(need.id);
}

function firstContactReviewPayload(need, decision = 'approve') {
  return { need_id: need.id, expected_revision: need.revision,
    expected_basis_fingerprint: need.basis_fingerprint,
    expected_proposal_sha256: need.first_contact_state?.proposal_sha256,
    decision, note: `Owner reviewed the proposed first-contact response: ${decision}.` };
}

function assertCurrentTargetFreshness(need, publishedAt, maxAgeSeconds) {
  assert.deepEqual(need.first_contact_state.target_freshness, {
    state:'current', published_at:new Date(publishedAt).toISOString(),
    fresh_until:new Date(Date.parse(publishedAt) + maxAgeSeconds * 1000).toISOString(), max_age_seconds:maxAgeSeconds
  });
}

function assertNoContactEffects(h) {
  for (const table of ['persons', 'conversations', 'drafts', 'contact_permissions', 'delivery_attempts'])
    assert.equal(h.store.get(`SELECT COUNT(*) n FROM ${table}`).n, 0, `${table} remains empty`);
}

test('public first-contact approval is separate from need acceptance and remains a review-only receipt', async t => {
  const { h, need: proposedNeed, output, targetPublishedAt } = await proposed(t);
  assert.equal(proposedNeed.first_contact_state.state, 'pending');
  assert.equal(proposedNeed.first_contact_state.fit, 'unknown');
  assert.equal(proposedNeed.first_contact_state.outcome, 'not_observed');
  assert.match(proposedNeed.first_contact_state.proposal_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(proposedNeed.first_contact_state.target, {
    source_ref: SOURCE, source_event_id: output.needs[0].first_contact.target_event_id,
    message_id: 'first-contact-target', author_ref: `author:${SOURCE}`
  });
  assertCurrentTargetFreshness(proposedNeed, targetPublishedAt, 3600);

  const accepted = await acceptNeed(h, proposedNeed);
  assert.equal(accepted.first_contact_state.state, 'pending', 'accepting a need does not approve contact');
  const before = h.store.get('SELECT COUNT(*) n FROM events').n;
  await h.command('audience.review_first_contact', firstContactReviewPayload(accepted));
  const reviewed = h.service.audience.need(accepted.id);
  assert.equal(reviewed.first_contact_state.state, 'approved');
  assert.equal(reviewed.first_contact_state.review.decision, 'approve');
  assert.equal(reviewed.first_contact_state.fit, 'unknown');
  assert.equal(reviewed.first_contact_state.outcome, 'not_observed');
  assert.equal(reviewed.first_contact_state.executable, false);
  assert.equal(reviewed.first_contact_state.contact_permission, false);
  assert.deepEqual(reviewed.first_contact_state.allowed_effects, []);
  assert.equal(reviewed.hypothesis, output.needs[0].hypothesis);
  assert.ok(h.store.get('SELECT id FROM events WHERE id>? AND actor=\'operator\' AND json_extract(payload_json,\'$.need_id\')=? AND json_extract(payload_json,\'$.decision\')=\'approve\' LIMIT 1', before, accepted.id),
    'the review is an event receipt rather than a new authority table');
  assertNoContactEffects(h);
  h.restart();
  assert.equal(h.service.audience.need(accepted.id).first_contact_state.state, 'approved');
  assertNoContactEffects(h);
});

for (const mutation of ['edit', 'delete', 'source revoke']) test(`approved first-contact review becomes stale after ${mutation} and restart`, async t => {
  const { h, need, targetPublishedAt } = await proposed(t);
  const accepted = await acceptNeed(h, need);
  await h.command('audience.review_first_contact', firstContactReviewPayload(accepted));
  assert.equal(h.service.audience.need(accepted.id).first_contact_state.state, 'approved', 'positive approval exists before the source changes');
  if (mutation === 'edit') await ingestPublished(h, { message_id:'first-contact-target', version:2,
    text:'The volunteer rota is closed; no help is needed.', published_at:targetPublishedAt });
  else if (mutation === 'delete') await ingestPublished(h, { message_id:'first-contact-target', version:2, operation:'delete', text:null,
    published_at:targetPublishedAt });
  else h.config.opportunity.allowedSourceRefs = [];
  h.service.audience.reconcile({ limit: 20 });
  assert.notEqual(h.service.audience.need(accepted.id).first_contact_state.state, 'approved');
  h.restart();
  const current = h.service.audience.need(accepted.id).first_contact_state;
  assert.notEqual(current.state, 'approved');
  assert.ok(['stale', 'invalid'].includes(current.state), JSON.stringify(current));
  assertNoContactEffects(h);
});

test('tampering with the review event fails closed', async t => {
  const { h, need } = await proposed(t);
  const accepted = await acceptNeed(h, need);
  await h.command('audience.review_first_contact', firstContactReviewPayload(accepted));
  assert.equal(h.service.audience.need(accepted.id).first_contact_state.state, 'approved', 'tamper test starts from a verified approval');
  const receipt = h.store.get(`SELECT id,payload_json FROM events WHERE actor='operator'
    AND json_extract(payload_json,'$.need_id')=? AND json_extract(payload_json,'$.decision')='approve'
    ORDER BY id DESC LIMIT 1`, accepted.id);
  assert.ok(receipt, 'an approval event exists');
  h.store.run("UPDATE events SET payload_json=json_set(payload_json,'$.decision','reject') WHERE id=?", receipt.id);
  assert.equal(h.service.audience.need(accepted.id).first_contact_state.state, 'invalid');
  h.restart();
  assert.equal(h.service.audience.need(accepted.id).first_contact_state.state, 'invalid');
  assertNoContactEffects(h);
});

test('missing review command receipt cannot authorize a first-contact approval', async t => {
  const { h, need } = await proposed(t);
  const accepted = await acceptNeed(h, need), payload = firstContactReviewPayload(accepted);
  const request = id();
  await h.command('audience.review_first_contact', payload, request);
  assert.equal(h.service.audience.need(accepted.id).first_contact_state.state, 'approved');
  h.store.run('DELETE FROM command_receipts WHERE id=?', request);
  assert.equal(h.service.audience.need(accepted.id).first_contact_state.state, 'invalid');
  h.restart();
  assert.equal(h.service.audience.need(accepted.id).first_contact_state.state, 'invalid');
  assertNoContactEffects(h);
});

test('stored goal evidence expiration withdraws first-contact approval across restart', async t => {
  const { h, need } = await proposed(t, { max_age_seconds: 60 });
  const accepted = await acceptNeed(h, need);
  await h.command('audience.review_first_contact', firstContactReviewPayload(accepted));
  assert.equal(h.service.audience.need(accepted.id).first_contact_state.state, 'approved');
  const eventId = accepted.first_contact.target_event_id;
  h.store.run("UPDATE events SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?", Number(eventId));
  h.service.audience.reconcile({ limit: 20 });
  assert.notEqual(h.service.audience.need(accepted.id).first_contact_state.state, 'approved');
  h.restart();
  const state = h.service.audience.need(accepted.id).first_contact_state;
  assert.equal(state.state, 'stale');
  assert.equal(state.fit, 'unknown');
  assert.equal(state.outcome, 'not_observed');
  assertNoContactEffects(h);
});

test('a recently observed but old published question stays a current need while first contact is stale', async t => {
  const publishedAt = new Date(Date.now() - 120_000).toISOString();
  const { h, goal, need } = await proposed(t, { max_age_seconds:60, targetPublishedAt:publishedAt });
  assert.equal(need.current,true, 'recent ingestion keeps the underlying evidence-backed need current');
  assert.equal(need.first_contact_state.state,'stale');
  assert.deepEqual(need.first_contact_state.target_freshness, { state:'expired', published_at:publishedAt,
    fresh_until:new Date(Date.parse(publishedAt) + 60_000).toISOString(), max_age_seconds:60 });
  assert.equal(need.first_contact_state.target.message_id,'first-contact-target',
    'freshness is a separate projection and does not change target identity binding');
  const accepted = await acceptNeed(h, need);
  assert.equal(accepted.status,'accepted', 'ordinary need review remains available despite the stale response target');
  assert.equal(accepted.current,true);
  const payload = firstContactReviewPayload(accepted), request = id();
  const before = h.store.get('SELECT COUNT(*) n FROM command_receipts').n;
  await assert.rejects(h.command('audience.review_first_contact',payload,request),
    error => error?.code === 'FIRST_CONTACT_TARGET_STALE');
  assert.equal(h.store.get('SELECT id FROM command_receipts WHERE id=?',request),undefined);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM command_receipts').n,before);
  assert.equal(h.service.audience.need(accepted.id).first_contact_state.state,'stale');
  assert.equal(h.service.audience.need(accepted.id).current,true);
  assertNoContactEffects(h);
});

for (const [label, corruptPublishedAt, expectedFreshness] of [
  ['missing', 'missing', 'unknown'], ['invalid', 'not-a-publication-time', 'invalid']
]) test(`${label} canonical publication timestamp cannot authorize public first contact`, async t => {
  const { h, need, output } = await proposed(t, { max_age_seconds:60, corruptPublishedAt });
  assert.equal(need.current,true, 'the source observation is recent even though its publication timestamp is unusable');
  assert.equal(need.first_contact_state.state, expectedFreshness === 'unknown' ? 'stale' : 'invalid');
  assert.equal(need.first_contact_state.target_freshness.state,expectedFreshness);
  assert.deepEqual(need.first_contact_state.target, {
    source_ref:SOURCE, source_event_id:output.needs[0].first_contact.target_event_id,
    message_id:'first-contact-target', author_ref:`author:${SOURCE}`
  }, 'publication freshness does not change the exact target identity binding');
  const accepted = await acceptNeed(h,need), payload = firstContactReviewPayload(accepted), request = id();
  await assert.rejects(h.command('audience.review_first_contact',payload,request),
    error => error?.code === 'FIRST_CONTACT_TARGET_STALE');
  assert.equal(h.store.get('SELECT id FROM command_receipts WHERE id=?',request),undefined);
  assert.equal(h.service.audience.need(accepted.id).first_contact_state.state,expectedFreshness === 'unknown' ? 'stale' : 'invalid');
  assertNoContactEffects(h);
});

test('the canonical source-ingest boundary still rejects future publication timestamps', async t => {
  const h = audienceHarness(t);
  const before = h.store.get('SELECT COUNT(*) n FROM events').n;
  await assert.rejects(ingestPublished(h, { message_id:'future-publication', text:'A future dated public question.',
    published_at:new Date(Date.now()+60_000).toISOString() }), error => error?.code === 'FUTURE_OR_REVERSED_SOURCE_TIME');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM events').n,before,
    'invalid future timestamps are refused before they can enter a source packet');
  assertNoContactEffects(h);
});

test('a current approval expires from publication age after material import, restart and old-request replay', async t => {
  // Freeze the whole Date API so source intake, audit timestamps and freshness
  // agree. Fixture setup must not race a one-second real-clock deadline on CI.
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-07T12:00:00.000Z')});
  const publishedAt = new Date(Date.now() - 59_000).toISOString();
  const { h, need } = await proposed(t, { max_age_seconds:60, targetPublishedAt:publishedAt });
  assert.equal(need.current,true);
  assertCurrentTargetFreshness(need,publishedAt,60);
  const accepted = await acceptNeed(h,need), work = await readyWork(h,accepted);
  const approvalPayload = firstContactReviewPayload(accepted), approvalRequest = id();
  await h.command('audience.review_first_contact',approvalPayload,approvalRequest);
  assert.equal(h.service.audience.need(accepted.id).first_contact_state.state,'approved');
  const current = h.service.audience.need(accepted.id);
  const imported = await h.command('audience.import_preview', { need_id:current.id,
    expected_revision:current.revision, expected_basis_fingerprint:current.basis_fingerprint,
    case_id:work.case_id, expected_case_revision:work.expected_case_revision,
    expected_preview_sha256:current.preview_sha256 }, id());
  assert.ok(imported.material_id);
  t.mock.timers.tick(1000);
  assert.equal(Date.now(),Date.parse(current.first_contact_state.target_freshness.fresh_until),
    'expiry is enforced at the exact publication deadline');
  const expired = h.service.audience.need(accepted.id);
  assert.equal(expired.current,true, 'source observation is still recent under the goal evidence window');
  assert.equal(expired.first_contact_state.state,'stale');
  assert.equal(expired.first_contact_state.target_freshness.state,'expired');
  assert.equal(h.service.audience.workScope(work.thread_id).current,false,
    'publication expiry blocks already imported response material and dependent Work');
  const receipts = h.store.get('SELECT COUNT(*) n FROM command_receipts').n;
  await assert.rejects(h.command('audience.review_first_contact',approvalPayload,approvalRequest),
    error => error?.code === 'FIRST_CONTACT_TARGET_STALE');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM command_receipts').n,receipts);
  await assert.rejects(h.command('audience.import_preview', { need_id:current.id,
    expected_revision:current.revision, expected_basis_fingerprint:current.basis_fingerprint,
    case_id:work.case_id, expected_case_revision:work.expected_case_revision,
    expected_preview_sha256:current.preview_sha256 }, id()),
  error => error?.code === 'FIRST_CONTACT_REVIEW_NOT_APPROVED');
  h.restart();
  const restored = h.service.audience.need(accepted.id);
  assert.equal(restored.current,true);
  assert.equal(restored.first_contact_state.state,'stale');
  assert.equal(restored.first_contact_state.target_freshness.state,'expired');
  assert.equal(h.service.audience.workScope(work.thread_id).current,false);
  await assert.rejects(h.command('audience.review_first_contact',approvalPayload,approvalRequest),
    error => error?.code === 'FIRST_CONTACT_TARGET_STALE');
  assertNoContactEffects(h);
});

test('first-contact review rejects non-operator, stale basis, and changed proposal before recording a receipt', async t => {
  const { h, need, targetPublishedAt } = await proposed(t);
  const accepted = await acceptNeed(h, need);
  const payload = firstContactReviewPayload(accepted), actorRequest = id();
  const receiptCount = () => h.store.get('SELECT COUNT(*) n FROM command_receipts').n;
  const before = receiptCount();
  await assert.rejects(h.command('audience.review_first_contact', payload, actorRequest, { kind: 'agent' }));
  assert.equal(h.store.get('SELECT id FROM command_receipts WHERE id=?', actorRequest), undefined);
  assert.equal(receiptCount(), before);

  await ingestPublished(h, { message_id:'first-contact-target', version:2, text:'A changed request.', published_at:targetPublishedAt });
  const staleRequest = id(), staleCount = receiptCount();
  await assert.rejects(h.command('audience.review_first_contact', payload, staleRequest));
  assert.equal(h.store.get('SELECT id FROM command_receipts WHERE id=?', staleRequest), undefined);
  assert.equal(receiptCount(), staleCount);

  const revokedSeed = await proposed(t), revoked = revokedSeed.h;
  const revokedNeed = await acceptNeed(revoked, revokedSeed.need);
  const revokedPayload = firstContactReviewPayload(revokedNeed), revokedRequest = id();
  const revokedCount = revoked.store.get('SELECT COUNT(*) n FROM command_receipts').n;
  revoked.config.opportunity.allowedSourceRefs = [];
  await assert.rejects(revoked.command('audience.review_first_contact', revokedPayload, revokedRequest));
  assert.equal(revoked.store.get('SELECT id FROM command_receipts WHERE id=?', revokedRequest), undefined);
  assert.equal(revoked.store.get('SELECT COUNT(*) n FROM command_receipts').n, revokedCount);
});

test('first-contact review cannot cross partner scope even with a current receipt payload', async t => {
  const { h, need } = await proposed(t), accepted = await acceptNeed(h, need);
  const payload = firstContactReviewPayload(accepted), request = id();
  const before = h.store.get('SELECT COUNT(*) n FROM command_receipts').n;
  const foreign = new BusinessService(h.store, { ...h.config, partnerId: id() });
  await assert.rejects(foreign.command('audience.review_first_contact', payload, request));
  assert.equal(h.store.get('SELECT id FROM command_receipts WHERE id=?', request), undefined);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM command_receipts').n, before);
  assert.equal(h.service.audience.need(accepted.id).first_contact_state.state, 'pending');
  assertNoContactEffects(h);
});

test('a no-contact proposal cannot be approved', async t => {
  const { h, need } = await proposed(t, { channel: 'none', firstContact: {
    channel_reason: 'The evidence does not support contacting the author.'
  } });
  const accepted = await acceptNeed(h, need);
  assert.equal(accepted.first_contact_state.state, 'not_proposed');
  await assert.rejects(h.command('audience.review_first_contact', firstContactReviewPayload(accepted)));
  assert.equal(h.service.audience.need(accepted.id).first_contact_state.state, 'not_proposed');
  assertNoContactEffects(h);
});

test('first-contact proposal requires positive exact evidence, known author, and a cited public-reply preview', async t => {
  for (const [label, options, mutate] of [
    ['exact quote', {}, output => { output.needs[0].first_contact.target_quote = 'A quote not present in the source.'; }],
    ['public reply next step', {}, output => { output.needs[0].next_step = 'observe'; }],
    ['material citation', {}, output => { output.needs[0].material_preview.evidence_event_ids = []; }],
    ['preview cites another event', { withReply: true }, (output, context) => {
      const reply = context.assessment.packet.exchanges.flatMap(exchange => exchange.evidence)
        .find(evidence => evidence.message_id === 'first-contact-reply');
      output.needs[0].material_preview.evidence_event_ids = [reply.source_event_id];
    }],
    ['source author claim', {}, output => { output.needs[0].first_contact.author_ref = 'author:someone-else'; }],
    ['target in counterevidence', { withReply: true }, (output, context) => {
      const reply = context.assessment.packet.exchanges.flatMap(exchange => exchange.evidence)
        .find(evidence => evidence.message_id === 'first-contact-reply');
      output.needs[0].first_contact.target_event_id = reply.source_event_id;
      output.needs[0].first_contact.target_quote = reply.text;
      output.needs[0].counterevidence_event_ids = [reply.source_event_id];
      output.needs[0].support_quotes.push({ source_event_id: reply.source_event_id, quote: reply.text });
    }],
    ['target in context', { withReply: true }, (output, context) => {
      const reply = context.assessment.packet.exchanges.flatMap(exchange => exchange.evidence)
        .find(evidence => evidence.message_id === 'first-contact-reply');
      output.needs[0].first_contact.target_event_id = reply.source_event_id;
      output.needs[0].first_contact.target_quote = reply.text;
      output.needs[0].context_event_ids = [reply.source_event_id];
      output.needs[0].support_quotes.push({ source_event_id: reply.source_event_id, quote: reply.text });
    }],
    ['unknown author', {}, (_output, context) => {
      const row = context.h.store.get('SELECT payload_json FROM events WHERE id=?', context.root.source_event_id);
      const message = JSON.parse(row.payload_json); message.author_id = null;
      context.h.store.run('UPDATE events SET payload_json=? WHERE id=?', JSON.stringify(message), context.root.source_event_id);
    }],
  ]) {
    const h = audienceHarness(t);
    const goal = await h.open({ source_ids: [SOURCE] });
    const root = await ingestPublished(h, { message_id:'first-contact-target',
      author_id:label === 'unknown author' ? null : `author:${SOURCE}`,
      text:'Could someone explain how to get started with the volunteer rota?' });
    if (options.withReply) await ingestPublished(h, { message_id:'first-contact-reply', reply_to_id:'first-contact-target',
      text:'The rota is still open for Saturday.' });
    h.service.audience.reconcile({ limit: 20 });
    const capture = await h.capture(goal.goal_id), assessment = h.service.audience.assessment(capture.assessment_id);
    const target = assessment.packet.exchanges.flatMap(exchange => exchange.evidence)
      .find(evidence => evidence.source_event_id === String(root.source_event_id));
    const output = proposalFrom(assessment.packet, { next_step: 'prepare_material' });
    output.needs[0].material_preview.evidence_event_ids = [target.source_event_id];
    output.needs[0].first_contact = { version: 1, target_event_id: target.source_event_id,
      target_quote: target.text, channel: 'public_reply', help: 'Give a short answer.',
      channel_reason: 'The author asked a direct public question.' };
    const before = h.store.get('SELECT COUNT(*) n FROM audience_needs').n;
    mutate(output, { h, root, assessment });
    await assert.rejects(h.command('audience.propose', { assessment_id: assessment.id, output }), undefined, label);
    assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n, before, `${label} failure is atomic`);
    assert.equal(h.store.get('SELECT COUNT(*) n FROM work_materials').n, 0);
  }
});

test('a peer counterclaim cannot be selected as the contact target even with valid quotes, author and preview citations', async t => {
  const h=audienceHarness(t),goal=await h.open();
  const own=await h.ingest({message_id:'target-own',text:'Where can I buy the worksheet?'});
  const peer=await h.ingest({message_id:'target-peer',reply_to_id:'target-own',text:'I already posted the link. It is resolved.'});
  h.service.audience.reconcile({limit:20});
  const capture=await h.capture(goal.goal_id),packet=h.service.audience.assessment(capture.assessment_id).packet;
  const root=packet.exchanges[0].evidence.find(e=>e.source_event_id===own.source_event_id);
  const reply=packet.exchanges[0].evidence.find(e=>e.source_event_id===peer.source_event_id);
  const output=proposalFrom(packet,{next_step:'prepare_material',evidence_event_ids:[root.source_event_id],
    counterevidence_event_ids:[reply.source_event_id],
    support_quotes:[{source_event_id:root.source_event_id,quote:root.text},{source_event_id:reply.source_event_id,quote:reply.text}],
    material_preview:{title:'A response attributed to the wrong source',content:'Which link do you mean?',evidence_event_ids:[reply.source_event_id]},
    first_contact:{version:1,target_event_id:reply.source_event_id,target_quote:reply.text,channel:'public_reply',
      help:'Clarify the link.',channel_reason:'This is an inert public reply suggestion.'}});
  await assert.rejects(h.command('audience.propose',{assessment_id:capture.assessment_id,output}),
    {code:'FIRST_CONTACT_TARGET_INVALID'});
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n,0);
  assertNoContactEffects(h);
});

test('rejecting a first-contact proposal changes only its review state', async t => {
  const { h, need } = await proposed(t);
  const accepted = await acceptNeed(h, need), originalHypothesis = accepted.hypothesis;
  const rejection = firstContactReviewPayload(accepted, 'reject'), rejectRequest = id();
  await h.command('audience.review_first_contact', rejection, rejectRequest);
  const rejected = h.service.audience.need(accepted.id);
  assert.equal(rejected.status, 'accepted', 'first-contact rejection does not reject the underlying need');
  assert.equal(rejected.hypothesis, originalHypothesis);
  assert.equal(rejected.first_contact_state.state, 'rejected');
  assert.equal(rejected.first_contact_state.review.decision, 'reject');
  assert.equal(rejected.first_contact_state.executable, false);
  assert.equal(rejected.first_contact_state.contact_permission, false);
  assert.deepEqual(rejected.first_contact_state.allowed_effects, []);
  const receipts = h.store.get('SELECT COUNT(*) n FROM command_receipts').n;
  await assert.rejects(h.command('audience.review_first_contact', firstContactReviewPayload(rejected), id()),
    error => error?.code === 'FIRST_CONTACT_REVIEW_RESOLVED');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM command_receipts').n, receipts,
    'a rejected first-contact proposal cannot be silently resurrected by a fresh approval request');
  assert.equal(h.service.audience.need(accepted.id).first_contact_state.state, 'rejected');
  assertNoContactEffects(h);
});

test('an approved first-contact decision is resolved; only its exact latest command receipt can replay', async t => {
  const { h, need } = await proposed(t), accepted = await acceptNeed(h, need);
  const approval = firstContactReviewPayload(accepted), request = id();
  const receiptCount = () => h.store.get('SELECT COUNT(*) n FROM command_receipts').n;
  const eventCount = () => h.store.get(`SELECT COUNT(*) n FROM events WHERE actor='operator'
    AND json_extract(payload_json,'$.need_id')=? AND json_extract(payload_json,'$.decision')='approve'`, accepted.id).n;
  const beforeReceipts = receiptCount(), beforeEvents = eventCount();
  const original = await h.command('audience.review_first_contact', approval, request);
  assert.equal(h.service.audience.need(accepted.id).first_contact_state.state, 'approved');
  assert.deepEqual(await h.command('audience.review_first_contact', approval, request), original,
    'the exact current idempotency receipt remains replayable');
  assert.equal(eventCount(), beforeEvents + 1, 'exact replay does not append another approval event');
  assert.equal(receiptCount(), beforeReceipts + 1, 'exact replay does not create another command receipt');
  await assert.rejects(h.command('audience.review_first_contact', approval, id()),
    error => error?.code === 'FIRST_CONTACT_REVIEW_RESOLVED');
  assert.equal(eventCount(), beforeEvents + 1);
  assert.equal(receiptCount(), beforeReceipts + 1, 'a fresh approval request cannot reopen an approved decision');
  assert.equal(h.service.audience.need(accepted.id).first_contact_state.state, 'approved');
  assertNoContactEffects(h);
});

async function importedRejectedFirstContact(t) {
  const { h, need } = await proposed(t), accepted = await acceptNeed(h,need), work = await readyWork(h,accepted);
  const approvalPayload = firstContactReviewPayload(accepted), approvalRequest = id();
  await h.command('audience.review_first_contact',approvalPayload,approvalRequest);
  const approved = h.service.audience.need(accepted.id);
  const importPayload = { need_id:approved.id, expected_revision:approved.revision,
    expected_basis_fingerprint:approved.basis_fingerprint, case_id:work.case_id,
    expected_case_revision:work.expected_case_revision, expected_preview_sha256:approved.preview_sha256 };
  const importRequest = id();
  await h.command('audience.import_preview',importPayload,importRequest);
  const rejectionPayload = firstContactReviewPayload(h.service.audience.need(accepted.id),'reject'), rejectionRequest = id();
  await h.command('audience.review_first_contact',rejectionPayload,rejectionRequest);
  assert.equal(h.service.audience.need(accepted.id).first_contact_state.state,'rejected');
  assert.equal(h.service.audience.workScope(work.thread_id).current,false);
  const head = h.store.get('SELECT * FROM audience_first_contact_heads WHERE need_id=?',accepted.id);
  assert.equal(head.request_id,rejectionRequest,'the latest review head points to rejection, never the older approval');
  assert.equal(head.event_id,h.store.get(`SELECT id FROM events WHERE id=? AND
    json_extract(payload_json,'$.request_id')=?`,head.event_id,rejectionRequest).id);
  assert.equal(head.review_id,h.service.audience.need(accepted.id).first_contact_state.review.id);
  return { h, accepted, work, approvalPayload, approvalRequest, importPayload, importRequest, head };
}

for (const damage of ['malformed latest JSON','remove need_id from latest rejection','delete latest rejection event','remove latest-review head'])
  test(`${damage} cannot resurrect an imported-and-rejected first-contact approval`, async t => {
    const { h, accepted, work, approvalPayload, approvalRequest, importPayload, importRequest, head } =
      await importedRejectedFirstContact(t);
    if (damage === 'malformed latest JSON')
      h.store.run("UPDATE events SET payload_json='not-json' WHERE id=?",head.event_id);
    else if (damage === 'remove need_id from latest rejection')
      h.store.run("UPDATE events SET payload_json=json_remove(payload_json,'$.need_id') WHERE id=?",head.event_id);
    else if (damage === 'delete latest rejection event') h.store.run('DELETE FROM events WHERE id=?',head.event_id);
    else h.store.run('DELETE FROM audience_first_contact_heads WHERE need_id=?',accepted.id);

    h.restart();
    const projected = h.service.audience.need(accepted.id);
    assert.notEqual(projected.first_contact_state.state,'approved');
    assert.ok(['invalid','rejected','stale'].includes(projected.first_contact_state.state),
      JSON.stringify(projected.first_contact_state));
    assert.equal(h.service.audience.workScope(work.thread_id).current,false);
    const receipts = h.store.get('SELECT COUNT(*) n FROM command_receipts').n;
    await assert.rejects(h.command('audience.review_first_contact',approvalPayload,approvalRequest),
      'the older approval receipt cannot supersede a damaged or missing latest-review head');
    assert.equal(h.store.get('SELECT COUNT(*) n FROM command_receipts').n,receipts);
    await assert.rejects(h.command('audience.import_preview',importPayload,importRequest),
      'the old import receipt cannot restore a response after the latest review head is damaged');
    assert.equal(h.store.get('SELECT COUNT(*) n FROM command_receipts').n,receipts);
    const freshImport = { ...importPayload, expected_case_revision:h.service.work.detail(work.case_id).revision };
    await assert.rejects(h.command('audience.import_preview',freshImport,id()));
    assert.equal(h.service.audience.need(accepted.id).first_contact_state.state,'invalid');
    assert.equal(h.service.audience.workScope(work.thread_id).current,false);
    assertNoContactEffects(h);
  });

test('a failed first-contact command receipt rolls back its review event and latest-review head', async t => {
  const { h, need } = await proposed(t), accepted = await acceptNeed(h,need);
  const payload = firstContactReviewPayload(accepted), request = id();
  const headBefore = h.store.get('SELECT * FROM audience_first_contact_heads WHERE need_id=?',accepted.id);
  assert.ok(headBefore);
  assert.equal(headBefore.request_id,null);
  assert.equal(headBefore.event_id,null);
  assert.equal(headBefore.review_id,null);
  h.store.db.exec(`CREATE TRIGGER fail_first_contact_receipt BEFORE INSERT ON command_receipts
    WHEN NEW.id='${request}' BEGIN SELECT RAISE(ABORT,'forced first-contact receipt failure'); END`);
  const eventCount = h.store.get(`SELECT COUNT(*) n FROM events WHERE kind='audience.review_first_contact'
    AND json_extract(payload_json,'$.need_id')=?`,accepted.id).n;
  await assert.rejects(h.command('audience.review_first_contact',payload,request));
  assert.equal(h.store.get(`SELECT COUNT(*) n FROM events WHERE kind='audience.review_first_contact'
    AND json_extract(payload_json,'$.need_id')=?`,accepted.id).n,eventCount,
  'the audit event rolls back with the failed command receipt');
  assert.deepEqual(h.store.get('SELECT * FROM audience_first_contact_heads WHERE need_id=?',accepted.id),headBefore,
    'the pre-existing pending review head remains all-null; no review head is committed');
  assert.equal(h.store.get('SELECT id FROM command_receipts WHERE id=?',request),undefined);
  h.store.db.exec('DROP TRIGGER fail_first_contact_receipt');
  assert.equal(h.service.audience.need(accepted.id).first_contact_state.state,'pending');
  assertNoContactEffects(h);
});

test('a valid model no-need result creates no first-contact position or positive contact credit', async t => {
  const previousKey = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'offline-first-contact-review-sentinel-never-sent';
  t.after(() => { if (previousKey === undefined) delete process.env.PARTNER_MODEL_API_KEY; else process.env.PARTNER_MODEL_API_KEY = previousKey; });
  const h = audienceHarness(t);
  h.config.audience.modelEnabled = true; h.config.audience.maxRunsPerDay = 5;
  Object.assign(h.config.runtime, { enabled:true, maxRunsPerDay:20, baseUrl:'https://unused-first-contact.invalid/v1',
    model:'offline-first-contact-review', dailyBudgetUsd:null, inputUsdPerMillion:null, outputUsdPerMillion:null });
  const goal = await h.open({ source_ids:[SOURCE] });
  await h.ingest({ message_id:'no-contact-request', text:'Is there a public guide for the Saturday rota?' });
  h.service.audience.reconcile({ limit:20 });
  const detail = h.service.audience.detail(goal.goal_id);
  await h.command('audience.attention_grant', { goal_id:goal.goal_id, expected_revision:detail.revision,
    expected_scope_fingerprint:detail.attention.scope_fingerprint, max_attempts:1,
    expires_at:new Date(Date.now()+60*60*1000).toISOString(), reason:'One bounded offline no-need check.' });
  let calls = 0;
  const result = await processAudienceAssessment(h.service, { decide:async (_run,context) => {
    calls++;
    return { completed:true, final_response:JSON.stringify(modelOutputFrom(context.packet,{ needs:[] })),
      usage:{ input_tokens:23, output_tokens:11 } };
  } });
  assert.equal(calls,1);
  assert.equal(result.disposition,'no_need_proposed');
  assert.equal(h.service.audience.assessment(result.assessment_id).decision_review.review.disposition,'no_need_proposed');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs').n,0);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM events WHERE kind='audience.review_first_contact'").n,0);
  assertNoContactEffects(h);
});

test('export and staging import keep an approval as history but cannot revive it as current', async t => {
  const { h, need } = await proposed(t), accepted = await acceptNeed(h, need);
  await h.command('audience.review_first_contact', firstContactReviewPayload(accepted));
  const before = h.service.audience.need(accepted.id).first_contact_state;
  assert.equal(before.state, 'approved');
  const reviewEvent = h.store.get(`SELECT id,payload_json FROM events WHERE actor='operator'
    AND json_extract(payload_json,'$.need_id')=? AND json_extract(payload_json,'$.decision')='approve' ORDER BY id DESC LIMIT 1`, accepted.id);
  assert.ok(reviewEvent);
  const file = path.join(h.directory, `first-contact-transfer-${id()}.json`);
  const bundle = exportPartner(h.store);
  fs.writeFileSync(file, JSON.stringify(bundle), { flag: 'wx' });
  const destination = path.join(ROOT, 'exports', `first-contact-transfer-${id()}`);
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  const imported = spawnSync(process.execPath, ['scripts/import.mjs', file, destination],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.equal(imported.status, 0, imported.stderr);
  const restored = new Store(path.join(destination, 'data'));
  try {
    const service = new BusinessService(restored, h.config);
    const historical = service.audience.need(accepted.id).first_contact_state;
    assert.notEqual(historical.state, 'approved');
    assert.ok(['stale', 'invalid'].includes(historical.state), JSON.stringify(historical));
    const transferredEvent = restored.get('SELECT id,payload_json FROM events WHERE id=?', reviewEvent.id);
    assert.deepEqual(transferredEvent, reviewEvent, 'the old decision remains in the immutable audit history');
    assert.ok(bundle.tables.events.some(row => row.id === reviewEvent.id));
    const replayRequest = id(), replay = firstContactReviewPayload(service.audience.need(accepted.id));
    replay.expected_proposal_sha256 = before.proposal_sha256;
    await assert.rejects(service.command('audience.review_first_contact', replay, replayRequest),
      'imported history cannot be replayed into fresh first-contact authority');
    assert.equal(restored.get('SELECT id FROM command_receipts WHERE id=?', replayRequest), undefined);
    assert.equal(service.audience.need(accepted.id).first_contact_state.state, historical.state);
    assert.deepEqual(restored.all('PRAGMA foreign_key_check'), []);
    for (const table of ['persons', 'conversations', 'drafts', 'contact_permissions', 'delivery_attempts'])
      assert.equal(restored.get(`SELECT COUNT(*) n FROM ${table}`).n, 0);
  } finally { restored.close(); }
});

test('the model proposal path preserves exact first-contact field bindings and usage without granting authority', async t => {
  const previousKey = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'offline-first-contact-positive-sentinel-never-sent';
  t.after(() => { if (previousKey === undefined) delete process.env.PARTNER_MODEL_API_KEY; else process.env.PARTNER_MODEL_API_KEY = previousKey; });
  const h = audienceHarness(t);
  h.config.audience.modelEnabled = true; h.config.audience.maxRunsPerDay = 5;
  Object.assign(h.config.runtime, { enabled:true, maxRunsPerDay:20, baseUrl:'https://unused-first-contact.invalid/v1',
    model:'offline-first-contact-review', dailyBudgetUsd:null, inputUsdPerMillion:null, outputUsdPerMillion:null });
  const goal = await h.open({ source_ids:[SOURCE] });
  const source = await ingestPublished(h, { message_id:'model-first-contact-target',
    text:'Could someone explain how to get started with the volunteer rota?' });
  h.service.audience.reconcile({ limit:20 });
  const detail = h.service.audience.detail(goal.goal_id);
  await h.command('audience.attention_grant', { goal_id:goal.goal_id, expected_revision:detail.revision,
    expected_scope_fingerprint:detail.attention.scope_fingerprint, max_attempts:1,
    expires_at:new Date(Date.now()+60*60*1000).toISOString(), reason:'One bounded offline proposal check.' });
  let calls = 0;
  const result = await processAudienceAssessment(h.service, { decide:async (_run, context) => {
    calls++;
    const evidence = context.packet.exchanges.flatMap(exchange => exchange.evidence)
      .find(item => item.source_event_id === String(source.source_event_id));
    assert.ok(evidence, 'the target is present in the model input packet');
    const proposal = proposalFrom(context.packet, { next_step:'prepare_material' });
    proposal.needs[0].material_preview.evidence_event_ids = [evidence.source_event_id];
    proposal.needs[0].first_contact = { version:1, target_event_id:evidence.source_event_id,
      target_quote:evidence.text, channel:'public_reply', help:'Offer a concise answer to the question.',
      channel_reason:'The author asked a direct public question.' };
    return { completed:true, final_response:JSON.stringify(modelOutputFrom(context.packet, proposal)),
      usage:{ input_tokens:31, output_tokens:17 }, model_identity:{ model_id:'offline-first-contact', model_version:'1' } };
  } });
  assert.equal(calls,1);
  assert.equal(result.disposition,'proposal_created');
  const assessment = h.service.audience.assessment(result.assessment_id);
  const needId = h.store.get('SELECT id FROM audience_needs WHERE assessment_id=?', assessment.id)?.id;
  assert.ok(needId, 'the accepted model output created one linked need');
  const need = h.service.audience.need(needId);
  assert.equal(assessment.current,true);
  assert.equal(assessment.decision_review.state,'current');
  assert.equal(need.first_contact.target_event_id,String(source.source_event_id));
  assert.equal(need.first_contact.target_quote,'Could someone explain how to get started with the volunteer rota?');
  assert.equal(need.first_contact_state.target.source_ref,SOURCE);
  assert.equal(need.first_contact_state.target.source_event_id,String(source.source_event_id));
  assert.equal(need.first_contact_state.target.message_id,'model-first-contact-target');
  assert.equal(need.first_contact_state.target.author_ref,`author:${SOURCE}`);
  assert.equal(need.first_contact_state.state,'pending');
  assert.equal(need.first_contact_state.executable,false);
  assert.equal(need.first_contact_state.contact_permission,false);
  const run = h.store.get('SELECT * FROM runs WHERE id=?', assessment.run_id);
  assert.equal(run.status,'completed');
  assert.equal(run.input_tokens,31); assert.equal(run.output_tokens,17);
  assert.equal(JSON.parse(run.result_json).model_identity.model_id,'offline-first-contact');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM audience_needs WHERE assessment_id=?', assessment.id).n,1);
  assertNoContactEffects(h);
});

async function readyWork(h, need) {
  const linked = await h.command('audience.open_work', { need_id: need.id,
    expected_revision: need.revision, expected_basis_fingerprint: need.basis_fingerprint });
  const turn = h.service.continuity.turn(linked.turn_id);
  await h.command('continuity.review', { turn_id: turn.id,
    expected_basis_fingerprint: turn.basis_fingerprint, decision: 'accept', note: 'Reviewed current interpretation.' });
  const current = h.service.continuity.detail(linked.thread_id);
  const opened = await h.command('work.open', { thread_id: linked.thread_id,
    expected_basis_fingerprint: current.basis_fingerprint, title: 'Prepare the proposed public answer' });
  const work = h.service.work.detail(opened.case_id);
  return { case_id: opened.case_id, thread_id: linked.thread_id, expected_case_revision: work.revision };
}

test('public-reply material import requires its separate first-contact approval; generic preview remains unchanged', async t => {
  const { h, need } = await proposed(t);
  const accepted = await acceptNeed(h, need), work = await readyWork(h, accepted);
  assert.equal(h.service.audience.workScope(work.thread_id).current, true,
    'internal evidence review can proceed before the response proposal is approved');
  const payloadFor = current => ({ need_id: current.id, expected_revision: current.revision,
    expected_basis_fingerprint: current.basis_fingerprint, case_id:work.case_id,
    expected_case_revision:work.expected_case_revision,
    expected_preview_sha256: current.preview_sha256 });
  await assert.rejects(h.command('audience.import_preview', payloadFor(h.service.audience.need(accepted.id))));
  const latest = h.service.audience.need(accepted.id);
  const approvalPayload = firstContactReviewPayload(latest), approvalRequest = id();
  await h.command('audience.review_first_contact', approvalPayload, approvalRequest);
  assert.equal(h.service.audience.need(accepted.id).first_contact_state.state, 'approved');
  const importPayload = payloadFor(h.service.audience.need(accepted.id)), importRequest = id();
  const imported = await h.command('audience.import_preview', importPayload, importRequest);
  assert.ok(imported.material_id);
  await h.command('audience.review_first_contact', firstContactReviewPayload(h.service.audience.need(accepted.id), 'reject'));
  assert.equal(h.service.audience.need(accepted.id).first_contact_state.state, 'rejected');
  assert.equal(h.service.audience.workScope(work.thread_id).current, false,
    'withdrawing approval after preview import blocks dependent Work');
  assert.notEqual(h.service.work.detail(work.case_id).current, true, 'the imported material cannot remain current');
  const blockedWork = h.service.work.detail(work.case_id);
  await assert.rejects(h.command('work.review', { case_id:work.case_id, expected_revision:blockedWork.revision,
    material_id:blockedWork.material.id, sha256:blockedWork.material.sha256, decision:'approve',
    note:'This must fail after first-contact approval is withdrawn.' }));
  await assert.rejects(h.command('work.prepare_action', { case_id:work.case_id,
    expected_revision:blockedWork.revision, material_id:blockedWork.material.id,
    capability_id:'owner_handoff.create.v1' }));
  const countAfterReject = h.store.get('SELECT COUNT(*) n FROM command_receipts').n;
  await assert.rejects(h.command('audience.review_first_contact', approvalPayload, approvalRequest),
    undefined, 'an old approval request cannot replay after a later rejection');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM command_receipts').n, countAfterReject);
  await assert.rejects(h.command('audience.import_preview', importPayload, importRequest),
    undefined, 'an old import request cannot replay after approval is withdrawn');
  assert.equal(h.store.get('SELECT COUNT(*) n FROM command_receipts').n, countAfterReject);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM action_proposals').n, 0);
  assertNoContactEffects(h);

  const generic = audienceHarness(t), goal = await generic.open({ source_ids: [SOURCE] });
  await generic.ingest({ message_id: 'generic-preview', text: 'The volunteer rota has an open Saturday shift.' });
  generic.service.audience.reconcile({ limit: 10 });
  const capture = await generic.capture(goal.goal_id), assessment = generic.service.audience.assessment(capture.assessment_id);
  const result = await generic.command('audience.propose', { assessment_id: assessment.id, output: proposalFrom(assessment.packet, {
    next_step: 'prepare_material', material_preview: { title: 'Generic bounded preview',
      content: 'A source reports an open Saturday shift.\nPlease confirm the rota details.',
      evidence_event_ids: [assessment.packet.exchanges[0].evidence[0].source_event_id] }
  }) });
  let genericNeed = generic.service.audience.need(result.need_ids[0]);
  assert.deepEqual(genericNeed.first_contact_state, { version:1, state:'not_proposed', proposal_sha256:null,
    target:null, review:null, fit:'unknown', executable:false, contact_permission:false,
    allowed_effects:[], outcome:'not_observed' });
  await generic.command('audience.review', { need_id: genericNeed.id, expected_revision: genericNeed.revision,
    expected_basis_fingerprint: genericNeed.basis_fingerprint, decision: 'accept', note: 'Generic preview review.' });
  genericNeed = generic.service.audience.need(genericNeed.id);
  const genericWork = await readyWork(generic, genericNeed);
  const genericImport = await generic.command('audience.import_preview', { need_id: genericNeed.id,
    expected_revision: genericNeed.revision, expected_basis_fingerprint: genericNeed.basis_fingerprint,
    case_id:genericWork.case_id, expected_case_revision:genericWork.expected_case_revision,
    expected_preview_sha256: genericNeed.preview_sha256 });
  assert.ok(genericImport.material_id, 'ordinary material previews retain the existing review path');
});
