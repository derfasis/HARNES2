// The two holes a static pass could not see, in the layer that grants authority to act.
//
// proof_level=synthetic_contract_eval; live_proof=false. No model call, no network, no Telegram:
// the two capabilities are local files and durable tasks, and both are exercised for real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './actions.test.mjs';

import { ActionRuntime } from '../business/action-runtime.mjs';
import { LocalActionCapabilities } from '../business/action-capabilities.mjs';

// 1. A manual Verify must not be able to strangle a retry for ever.
//
// The shape: an attempt is verified as absent, the owner grants a retry, and presses Verify before
// the retry has run. `prepare` then selects on `verify_requested`, picks the finished older attempt,
// and verifies it — while the grant the owner is waiting on is never dispatched. The bit is only
// cleared when the probe's grant is still the latest, so a probe that belongs to a superseded grant
// left the bit set, and the runtime asked the same answered question for ever.
test('a verify aimed at a superseded attempt does not block the grant that is waiting', async (t) => {
  const h = harness(t);
  const thread = await h.accepted();
  const action = await h.propose(thread);
  // A runtime whose execution never lands an effect, so the independent probe answers `absent`
  // and the retry path is the one under test. The real capabilities are not what is being
  // exercised here; the state machine around them is.
  const local = new LocalActionCapabilities(h.service);
  const runtime = new ActionRuntime(h.service, { capabilities: {
    async execute() { throw new Error('no outcome'); }, verify: (row) => local.verify(row) } });
  await h.grant(action);
  await runtime.tick();                       // dispatch, no effect
  await runtime.tick();                       // independent probe: absent
  assert.equal(h.detail(action).status, 'failed', 'the absent verification failed the action');

  // The owner retries.
  await h.grant(action, 'action.retry');
  assert.equal(h.detail(action).status, 'authorized', 'a retry grant is live and waiting');

  // And presses Verify before the retry has been dispatched.
  const d = h.detail(action);
  await h.command('action.verify', { action_id: action, expected_revision: d.revision });
  assert.equal(h.store.get('SELECT verify_requested v FROM action_proposals WHERE id=?', action).v, 1,
    'the owner asked for verification');

  // The next pass answers that probe. The bit is what `grant(retry)` refuses on, so leaving it set
  // is what makes the retry permanently ungrantable.
  await runtime.tick();
  assert.equal(h.store.get('SELECT verify_requested v FROM action_proposals WHERE id=?', action).v, 0,
    'the request bit is cleared once the probe has answered, whichever attempt it looked at');
  await runtime.tick();
  assert.notEqual(h.detail(action).status, 'authorized',
    'the waiting grant is dispatched instead of being starved by the probe');
});

// The same state, observed directly.
test('an answered verify request does not make retry permanently ungrantable', async (t) => {
  const h = harness(t);
  const thread = await h.accepted();
  const action = await h.propose(thread);
  const local = new LocalActionCapabilities(h.service);
  const runtime = new ActionRuntime(h.service, { capabilities: {
    async execute() { throw new Error('no outcome'); }, verify: (row) => local.verify(row) } });
  await h.grant(action);
  await runtime.tick();
  await runtime.tick();
  assert.equal(h.detail(action).status, 'failed');

  await h.grant(action, 'action.retry');
  const d = h.detail(action);
  await h.command('action.verify', { action_id: action, expected_revision: d.revision });
  await runtime.tick();

  // The owner's grant is what was stuck. 'can_retry' is deliberately not asserted: the action
  // is 'authorized', not 'failed', because a live grant is waiting — and a waiting grant is the
  // correct state. What has to hold is that the waiting grant actually runs.
  assert.equal(h.detail(action).status, 'authorized', 'the grant is still live and waiting');
  assert.equal(h.store.get('SELECT verify_requested v FROM action_proposals WHERE id=?', action).v, 0,
    'and nothing is left asking to be verified');
  await runtime.tick();
  assert.notEqual(h.detail(action).status, 'authorized',
    'so the next pass dispatches it instead of re-probing the attempt that already answered');
});

// 2. A browser re-read must not revive a revoked action.
//
// The shape: the same page is read again and confirmed again, so `confirmed_at` moves, while the
// text and the message are the same. If the grant identity hashes the observations, the same
// action hashes differently, the duplicate check finds nothing, and an action whose grant was
// revoked can be proposed afresh and granted afresh.
// The confirmation is written straight into the stored packet, which is the state a re-read
// produces. The fixture source is not a browser one, so its evidence carries no confirmation at
// all; setting one is what makes the two moments comparable, and moving it is the re-read.
const confirmAgain = (store, actionId, at) => {
  const packet = JSON.parse(store.get('SELECT packet_json FROM action_proposals WHERE id=?', actionId).packet_json);
  assert.ok(packet.evidence.length > 0, 'the proposal rested on evidence');
  for (const e of packet.evidence) e.confirmed_at = at;
  store.run('UPDATE action_proposals SET packet_json=? WHERE id=?', JSON.stringify(packet), actionId);
};

test('a re-read of the same page does not make a revoked action look new', async (t) => {
  const h = harness(t);
  const thread = await h.accepted();
  const action = await h.propose(thread);
  const original = h.detail(action).proposal_hash;
  await h.command('action.revoke', { action_id: action, expected_revision: h.detail(action).revision, reason: 'Owner changed their mind' });
  assert.equal(h.detail(action).status, 'revoked', 'the action is terminal');

  // The world moves: the same evidence is confirmed again, at a later time.
  const evidence = JSON.parse(h.store.get('SELECT packet_json FROM action_proposals WHERE id=?', action).packet_json).evidence;
  assert.ok(evidence.length > 0, 'the proposal rested on evidence');
  confirmAgain(h.store, action, new Date(Date.now() + 60_000).toISOString());

  // Same proposal, same thread, same evidence — and it must still be recognised as the same action.
  const replay = h.service.actions;
  const row = replay.get(action);
  const sameHash = replay.proposalHash(row, replay.checkedProposal(JSON.parse(row.proposal_json)));
  assert.equal(sameHash, original,
    'a later confirmation of the same text is the same action, not a new one to be granted');
  void thread;
});

// The duplicate check is what actually stops the revival, so it is asserted directly rather than
// inferred from the hash.
test('a revoked action cannot be re-proposed after its evidence is confirmed again', async (t) => {
  const h = harness(t);
  const thread = await h.accepted();
  const action = await h.propose(thread);
  await h.command('action.revoke', { action_id: action, expected_revision: h.detail(action).revision, reason: 'Revoked' });
  confirmAgain(h.store, action, new Date(Date.now() + 60_000).toISOString());

  const again = await h.command('action.propose', { thread_id: thread,
    expected_basis_fingerprint: h.service.continuity.detail(thread).basis_fingerprint,
    reason: 'Same thing again', proposal: { capability_id: 'brief.publish_local.v1', title: 'Time briefing',
      instructions: 'Review remaining uncertainty', expected_result: 'Local evidence package for owner', due_at: null } });
  assert.equal(again.duplicate, true, 'the identical proposal is recognised as the revoked one');
  assert.equal(again.action_id, action, 'and it resolves to the action that was revoked, not a new grant');
});

test('the identity still changes when the text changes', (t) => {
  // The other half of the rule: a hash that ignored the evidence entirely would pass the duplicate
  // test and defeat this one. What identifies the action is what it says and what it rests on.
  const h = harness(t);
  const base = [{ source_event_id: '1', source_ref: 'public:x', author_id: 'a1', message_id: 'm1',
    message_version: 1, text: 'Two hours weekly.', truncated: false, confirmed_at: '2026-01-01T00:00:00Z', current: true, reasons: [] }];
  const later = [{ ...base[0], confirmed_at: '2026-06-01T00:00:00Z' }];
  const changed = [{ ...base[0], text: 'Three hours weekly.' }];
  assert.deepEqual(h.service.actions.constructor.staticEvidence(base), h.service.actions.constructor.staticEvidence(later),
    'a fresh confirmation is not a different action');
  assert.notDeepEqual(h.service.actions.constructor.staticEvidence(base), h.service.actions.constructor.staticEvidence(changed),
    'different text is a different action');
});

void LocalActionCapabilities;
