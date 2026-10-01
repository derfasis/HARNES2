// The guards, each proved by the test that fails when the guard is removed.
//
// A check no test can reach is indistinguishable from a check that is not there: the file reads as
// protected and nothing exercises the refusal. Every case below was verified by removing the
// guard, watching this suite stay green, and putting it back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store, id } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { readJson, ROOT } from '../business/config.mjs';

const OPEN = '2026-01-01T00:00:00.000Z';
const REPLY = '2026-01-01T00:00:20.000Z';
const AFTER = Date.parse('2026-01-02T00:00:00.000Z');
const operator = { kind: 'operator' };

const harness = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-guard-'));
  const config = readJson(path.join(ROOT, 'config/default.json'));
  config.engagement.enabled = true;
  config.outcomes = { enabled: true, responseWindowSeconds: 3600 };
  const store = new Store(directory);
  t.after(() => { try { store.close(); } catch { /* a case closed it */ } fs.rmSync(directory, { recursive: true, force: true }); });
  const service = new BusinessService(store, config);
  const command = (action, payload, request = id(), actor = operator) => service.command(action, payload, request, actor);
  const h = {
    directory, store, service, command, operator,
    person: () => command('person.create', { name: 'Guard', source: 'offline fixture' }),
    inbound: (cid, text = 'Reply', at = REPLY) =>
      command('message.record', { conversation_id: cid, text, source: 'offline owner attestation', occurred_at: at }),
    async delivered(cid = null, at = OPEN) {
      if (!cid) cid = (await h.person()).conversation_id;
      const incoming = await h.inbound(cid, 'Please answer', OPEN);
      const engagement = service.engagement.current(cid);
      if (!store.get('SELECT id FROM contact_permissions WHERE conversation_id=? AND revoked_at IS NULL', cid)) {
        await command('permission.grant', { conversation_id: cid, purpose: 'reply', granted_by: 'owner',
          evidence: 'Explicit synthetic permission', valid_from: '2020-01-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' });
      }
      const decision = await command('decision.commit', { engagement_id: engagement.id,
        expected_revision: service.engagement.get(engagement.id).revision, kind: 'ACT',
        reason: 'Answer explicit request', expected_next: 'An observed reply',
        evidence: [{ type: 'message', id: incoming.message_id }],
        action: { purpose: 'reply', text: 'Synthetic answer.' } });
      await command('draft.approve', { draft_id: decision.draft_id });
      await command('delivery.manual', { draft_id: decision.draft_id, evidence: 'Owner verified offline delivery', occurred_at: at });
      const sent = store.get('SELECT * FROM messages WHERE draft_id=?', decision.draft_id);
      const window = store.get('SELECT * FROM outcome_observation_windows WHERE message_id=?', sent.id);
      assert.ok(window, 'positive control: actual delivery reached the observer');
      return { cid, sent, window };
    },
  };
  return h;
};

// 1. Coverage is proved, never declared. Letting a caller assert `continuous` at window creation is
// exactly how a silence nobody vouched for becomes a fact about a conversation.
test('a window cannot declare its own coverage', async t => {
  const h = harness(t), d = await h.delivered();
  assert.equal(d.window.coverage, 'unverified', 'a window starts unverified, because nobody has said otherwise yet');
  assert.throws(() => h.service.outcomes.observeSent(d.cid, d.sent.id, OPEN, 'continuous'),
    (e) => e.code === 'OUTCOME_COVERAGE_PROOF_REQUIRED',
    'the coverage flag cannot be asserted at opening; it is proved separately or not at all');
});

// 2. A window whose deadline precedes its opening cannot exist. Reached through a stray message
// rather than by re-opening an existing window, because re-opening returns the existing window and
// never gets this far — which is the same reason this guard was invisible to the suite before.
test('a window cannot be opened with a deadline before it opened', async t => {
  const h = harness(t), d = await h.delivered();
  const stray = id();
  h.store.run('INSERT INTO messages(id,conversation_id,direction,author,text,external_id,source,created_at) VALUES(?,?,?,?,?,?,?,?)',
    stray, d.cid, 'out', 'operator', 'stray', id(), 'offline fixture', OPEN);
  assert.throws(() => h.service.outcomes.observeSent(d.cid, stray, OPEN, 'unverified', '2025-12-31T00:00:00.000Z'),
    (e) => e.code === 'OUTCOME_WINDOW_TIME_INVALID',
    'a window that closes before it opens is refused');
});

// 3. A settled window keeps the answer it already has. Rescanning adds nothing, so one reply cannot
// become two claims however many passes run afterwards.
test('a settled window keeps its single answer under rescanning', async t => {
  const h = harness(t), d = await h.delivered();
  await h.inbound(d.cid, 'An answer', REPLY);
  await h.service.outcomes.reconcile({ now: AFTER });
  assert.equal(h.store.all('SELECT id FROM outcome_candidates WHERE window_id=?', d.window.id).length, 1,
    'the reply settled the window once');
  await h.service.outcomes.reconcile({ now: AFTER });
  await h.service.outcomes.reconcile({ now: AFTER });
  assert.equal(h.store.all('SELECT id FROM outcome_candidates WHERE window_id=?', d.window.id).length, 1,
    'and rescanning it repeatedly leaves exactly one answer');
});

// 4. The pre-release migration is pinned by content, not by where it once lived. Reading it from git
// history made this suite pass locally and fail on a runner with the default shallow checkout — and
// would fail again behind any archive or squashed history. The bytes are the contract.
test('the legacy migration fixture is the real pre-release migration', async () => {
  const sql = fs.readFileSync(new URL('./fixtures/pre-release-008-outcome-candidates.sql', import.meta.url), 'utf8');
  assert.equal(createHash('sha256').update(Buffer.from(sql, 'utf8')).digest('hex'),
    '9bf883d940a6a174c88a1e68ecde384966b14632813f616322beafbae154498e',
    'the fixture is byte-for-byte the published pre-release migration, not a reconstruction of it');
  assert.match(sql, /CREATE TABLE outcome_candidates/);
  assert.match(sql, /CREATE TABLE outcome_observation_windows/);
});