import test from 'node:test';
import assert from 'node:assert/strict';
import { createActionsView } from '../public/actions.js';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
function harness({ current = true } = {}) {
  const calls = [], reads = [], dialogs = [], hostile = '<img src=x onerror="execute()">';
  const detail = { id:'a1', revision:7, title:hostile, status:'proposed', current, can_grant:current, can_revoke:true,
    proposal_hash:'exact-reviewed-hash', proposal:{ capability_id:'brief.publish_local.v1', title:hostile, instructions:hostile, expected_result:hostile },
    packet:{ thread_id:'t1', interpretation:{ summary:{ text:hostile } }, evidence:[{ source_ref:hostile, text:hostile }] }, attempts:[], grants:[] };
  const api = async (route, body) => {
    reads.push({route,body});
    if (route.startsWith('/api/actions?')) return { items:[detail], enabled:true, model_enabled:false, capabilities:[], next_cursor:null };
    if (route === '/api/actions/a1') return structuredClone(detail);
    if (route.startsWith('/api/continuity/threads?')) return {items:[{id:'t1',status:'OPEN',title:'Question'}]};
    if (route === '/api/continuity/threads/t1') return { id:'t1', basis_fingerprint:'live-basis', memory:{ current:true } };
    if (route === '/api/actions/a1/artifact') return { artifact:{ text:hostile }, current };
    if (route === '/api/actions/wake') return { disposition:'idle' };
    assert.fail(`Unexpected request ${route}`);
  };
  let view;
  view = createActionsView({ api, command:async (action,payload) => { calls.push({action,payload}); return {action_id:'a1'}; }, esc,
    panel:(title,body,action='') => `<section><h2>${esc(title)}</h2>${body}${action}</section>`, empty:()=>'',
    button:(title,action) => `<button data-do="${esc(action)}">${esc(title)}</button>`,
    field:(name,title,type,value='') => `<div data-field="${esc(name)}" data-value="${esc(value)}">${esc(title)}</div>`,
    modal:(title,html,submit) => dialogs.push({title,html,submit}), refresh:() => view.load() });
  return {view,calls,reads,dialogs,detail,hostile};
}
test('render escapes source and proposed instructions; loading never grants or executes', async () => {
  const h=harness(); await h.view.load(); await h.view.act('action-open','a1');
  assert.ok(h.view.render().includes('&lt;img')); assert.equal(h.view.render().includes(h.hostile),false);
  assert.deepEqual(h.calls,[]); assert.ok(h.reads.every(r=>r.body===undefined));
});
test('exact preview defaults to refusal and freezes reviewed revision/hash across background reload', async () => {
  const h=harness(); await h.view.load(); await h.view.act('action-open','a1'); await h.view.act('action-grant','a1');
  const dialog=h.dialogs.at(-1); assert.match(dialog.html,/data-field="confirm" data-value="no"/);
  assert.equal(dialog.html.includes(h.hostile),false); assert.ok(dialog.html.includes('exact-reviewed-hash'));
  await dialog.submit({confirm:'no'}); assert.equal(h.calls.length,0);
  h.detail.revision=8;h.detail.proposal_hash='new-hash';await h.view.load();
  await dialog.submit({confirm:'yes'});
  assert.equal(h.calls[0].action,'action.grant'); assert.equal(h.calls[0].payload.expected_revision,7);
  assert.equal(h.calls[0].payload.proposal_hash,'exact-reviewed-hash'); assert.ok(Date.parse(h.calls[0].payload.expires_at)>Date.now());
});
test('stale work keeps revoke and probe available, hides grant and retry', async () => {
  const h=harness({current:false});h.detail.attempts=[{id:'attempt',status:'unknown',verification_state:'unavailable'}];
  await h.view.load();await h.view.act('action-open','a1');const html=h.view.render();
  assert.doesNotMatch(html,/data-do="action-(grant|retry)"/);assert.match(html,/data-do="action-revoke"/);assert.match(html,/data-do="action-verify"/);
  await h.view.act('action-revoke','a1');await h.dialogs.at(-1).submit({note:'Stop'});
  assert.deepEqual(h.calls[0].payload,{action_id:'a1',expected_revision:7,reason:'Stop'});
});
test('new proposal uses the current continuity fingerprint, never an invented memory fingerprint', async () => {
  const h=harness();await h.view.load();await h.view.act('action-new');
  await h.dialogs.at(-1).submit({thread_id:'t1',capability_id:'brief.publish_local.v1',title:'Title',instructions:'Read',expected_result:'File'});
  assert.equal(h.calls[0].payload.expected_basis_fingerprint,'live-basis');assert.equal(h.calls[0].action,'action.propose');
  assert.equal(h.calls.length,1);
});
test('artifact uses authenticated API wrapper and escapes returned historical content', async () => {
  const h=harness();await h.view.load();await h.view.act('action-open','a1');await h.view.act('action-artifact','a1');
  assert.equal(h.dialogs.at(-1).html.includes(h.hostile),false);assert.equal(h.calls.length,0);
  assert.equal(h.reads.at(-1).route,'/api/actions/a1/artifact');
});
