import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudienceView } from '../public/audience.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g,
  c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);

const preview = () => ({ version:1, purpose:'audience_source_renewal_preview_v1', goal_id:'goal-1',
  source_ref:'telegram:channel:123', expected_revision:7, prior_policy_hash:'old-policy-hash',
  current_source_policy_hash:'new-policy-hash', old_cursor:12, head:19, observation_floor:20,
  gap:true, source_checkpoint_sha256:'checkpoint-hash', transport_current:false,
  transport_reason:'SOURCE_TRANSPORT_STALE', preview_sha256:'preview-hash' });

function harness(status = 'revoked') {
  const commands = [], reads = [], dialogs = [];
  let renewal = preview();
  const goal = { id:'goal-1', title:'Understand onboarding questions', objective:'Find useful setup guidance',
    status:'OPEN', revision:7, watches:[{ source_ref:'telegram:channel:123', status, cursor:12, head:19,
      health:{ current:false, reason:'AUDIENCE_SOURCE_REVOKED' } }], needs:[], assessments:[] };
  const api = async route => {
    reads.push(route);
    if (route.startsWith('/api/audience?')) return { items:[{ id:goal.id }], enabled:true, model_enabled:false };
    if (route === '/api/audience/goal-1') return structuredClone(goal);
    if (route === '/api/audience/goals/goal-1/source-renewal?source_ref=telegram%3Achannel%3A123') return structuredClone(renewal);
    assert.fail(`Unexpected API read ${route}`);
  };
  let view;
  view = createAudienceView({ api, command:async (action, payload) => {
    commands.push({ action, payload });
    goal.watches[0].status = 'active';
    return { goal_id:goal.id };
  }, esc,
  panel:(title, body) => `<section><h2>${esc(title)}</h2>${body}</section>`,
  button:(title, action, id='') => `<button data-do="${esc(action)}" data-id="${esc(id)}">${esc(title)}</button>`,
  empty:(title, body='') => `<p>${esc(title)} ${esc(body)}</p>`,
  field:(name, title) => `<label>${esc(title)}<input name="${esc(name)}"></label>`,
  modal:(title, content, submit) => dialogs.push({ title, content, submit }), refresh:async () => {}, notify:() => {} });
  return { view, commands, reads, dialogs, goal, replacePreview(value) { renewal = value; } };
}

test('revoked watch shows a read-only preview and renews the same goal only after explicit gap confirmation', async () => {
  const h = harness();
  await h.view.load(); await h.view.act('audience-goal', 'goal-1');
  assert.match(h.view.render(), /Проверить возобновление: telegram:channel:123/);
  await h.view.act('audience-renew-source', 'telegram:channel:123');
  assert.equal(h.dialogs.length, 1);
  const dialog = h.dialogs[0];
  assert.match(dialog.content, /Understand onboarding questions/);
  assert.match(dialog.content, /Find useful setup guidance/);
  assert.match(dialog.content, /прежний указатель: 12 · верхняя граница: 19 · нижняя граница новых наблюдений: 20/);
  assert.match(dialog.content, /доступность не подтверждена/);
  assert.match(dialog.content, /Старые материалы и выводы по этому источнику останутся устаревшими/);
  assert.match(dialog.content, /name="acknowledge_gap"/);
  assert.match(dialog.content, /не создаёт нового разрешения, профиля модели или новой задачи/);
  assert.equal(h.commands.length, 0, 'opening the preview is an inert read');
  await assert.rejects(dialog.submit({}), /Подтвердите разрыв/);
  assert.equal(h.commands.length, 0, 'declining the required acknowledgment sends no command');

  await dialog.submit({ acknowledge_gap:'true' });
  assert.deepEqual(h.commands, [{ action:'audience.renew_source', payload:{ goal_id:'goal-1',
    source_ref:'telegram:channel:123', expected_revision:7, preview_sha256:'preview-hash', acknowledge_gap:true } }]);
  assert.equal(h.reads.filter(route => route.includes('/source-renewal?')).length, 2,
    'the exact read-only preview is refreshed before the command');
  assert.equal(h.goal.id, 'goal-1', 'renewal keeps the existing goal identity');
  assert.match(h.view.render(), /Understand onboarding questions/);
});

test('changed preview after opening the confirmation suppresses the renewal command', async () => {
  const h = harness();
  await h.view.load(); await h.view.act('audience-goal', 'goal-1');
  await h.view.act('audience-renew-source', 'telegram:channel:123');
  const changed = preview(); changed.head++;
  h.replacePreview(changed);
  await assert.rejects(h.dialogs[0].submit({ acknowledge_gap:'true' }), /Сверка изменилась/);
  assert.deepEqual(h.commands, []);
});

test('healthy watch exposes no renewal control and cannot be renewed through the view action', async () => {
  const h = harness('active');
  await h.view.load(); await h.view.act('audience-goal', 'goal-1');
  assert.doesNotMatch(h.view.render(), /audience-renew-source/);
  await assert.rejects(h.view.act('audience-renew-source', 'telegram:channel:123'), /только отозванный источник/);
  assert.equal(h.reads.some(route => route.includes('/source-renewal?')), false);
  assert.deepEqual(h.commands, []);
});
