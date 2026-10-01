import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutcomesView } from '../public/outcomes.js';

const hostile = '<img src=x onerror="execute()">';
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function harness({ fresh = true, enabled = true, commandError = null } = {}) {
  const reads = [], commands = [], dialogs = [];
  const saved = { id:'candidate-1', partner_id:'partner-1', conversation_id:'conversation-1', kind:'reply_observed', status:'pending',
    revision:4, detector_version:2, observed_at:'2026-03-01T01:00:00.000Z', source_message_id:'message-in', draft_id:null,
    decision_id:'candidate-decision', outcome_id:null, evidence_current:fresh,
    evidence:{ window_id:'window-1', sent_message_id:'message-out', reply_message_id:'message-in', reply_at:'2026-03-01T01:00:00.000Z',
      timing_basis:'source_timestamps', note:hostile },
    window:{ id:'window-1', outcome:'answered', opened_at:'2026-03-01T00:00:00.000Z', closes_at:'2026-03-08T00:00:00.000Z',
      time_basis:'source', coverage:'continuous', coverage_event_id:17, delivery_attempt_id:null } };
  let enabledNow = enabled, refreshes = 0;
  const api = async route => {
    reads.push(route);
    if (route.startsWith('/api/outcomes?')) return { items:[{...saved}], next_cursor:null,
      coverage:{ unknown_windows:3, unverified_windows:2, not_observed_deliveries:1, unknown_delivery_messages:4 } };
    if (route === '/api/outcomes/candidate-1') return structuredClone(saved);
    assert.fail(`Unexpected API call: ${route}`);
  };
  let view;
  const deps = { api, command:async (action,payload) => {
      commands.push({action,payload});
      if (commandError) throw commandError;
      saved.status = action === 'outcome.candidate_confirm' ? 'confirmed' : 'rejected';
      saved.outcome_id = action === 'outcome.candidate_confirm' ? (payload.outcome_id ?? 'outcome-new') : null;
      saved.actual_outcome_decision_id = action === 'outcome.candidate_confirm' ? 'canonical-decision' : null;
      saved.revision++;
      return { outcome_id:saved.outcome_id, candidate_id:saved.id, candidate_decision_id:'candidate-decision', outcome_decision_id:'canonical-decision' };
    }, esc:escapeHtml, panel:(title,body) => `<section><h2>${escapeHtml(title)}</h2>${body}</section>`,
    button:(title,action,id='',kind='') => `<button class="${kind}" data-do="${escapeHtml(action)}" data-id="${escapeHtml(id)}">${escapeHtml(title)}</button>`,
    empty:(title,text) => `<div class="empty"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(text)}</p></div>`,
    field:(name,title,type='text',value='') => `<label>${escapeHtml(title)}<input data-field="${escapeHtml(name)}" type="${escapeHtml(type)}" value="${escapeHtml(value)}"></label>`,
    modal:(title,html,submit) => dialogs.push({title,html,submit}), refresh:async()=>{ refreshes++; await view.load(); },
    isEnabled:()=>enabledNow, events:()=>[] };
  view = createOutcomesView(deps);
  return { view, reads, commands, dialogs, saved, get refreshes(){return refreshes;}, setEnabled:value=>{enabledNow=value;} };
}

test('read-only list/detail escapes evidence and displays timing, proof, and coverage uncertainty', async () => {
  const h = harness(); await h.view.load(); await h.view.act('outcome-open','candidate-1');
  const html = h.view.render();
  assert.ok(html.includes('Неизвестные окна') && html.includes('Нет окна наблюдения') && html.includes('Доставка неизвестна'));
  assert.ok(html.includes('Отметка владельца') && html.includes('не являются независимой проверкой доставки'));
  assert.ok(html.includes('&lt;img')); assert.equal(html.includes(hostile),false);
  assert.deepEqual(h.commands,[]); assert.ok(h.reads.every(route=>route.startsWith('/api/outcomes')));
});

test('confirmation freezes detail revision and requires explicit existing-outcome link input', async () => {
  const h = harness(); await h.view.load(); await h.view.act('outcome-open','candidate-1'); await h.view.act('outcome-confirm-open','candidate-1');
  const dialog = h.dialogs.at(-1); assert.match(dialog.html,/Связать с уже записанным результатом/);
  h.saved.revision = 9; // Background state may move; the open form retains the revision it displayed.
  await dialog.submit({kind:'joined',evidence:'Owner verified the result.',value:'12',outcome_id:'existing-outcome',note:'linked'});
  assert.deepEqual(h.commands[0], { action:'outcome.candidate_confirm', payload:{ candidate_id:'candidate-1',kind:'joined',
    evidence:'Owner verified the result.',expected_revision:4,value:12,outcome_id:'existing-outcome',note:'linked' } });
  assert.equal(h.refreshes,1);
  assert.match(h.view.render(),/candidate-decision/); assert.match(h.view.render(),/canonical-decision/);
});

test('stale evidence and a disabled layer suppress confirmation; rejection remains explicit only while enabled', async () => {
  const stale = harness({fresh:false}); await stale.view.load(); await stale.view.act('outcome-open','candidate-1');
  const staleHtml = stale.view.render(); assert.doesNotMatch(staleHtml,/data-do="outcome-confirm-open"/);
  assert.match(staleHtml,/data-do="outcome-reject-open"/);
  await assert.rejects(()=>stale.view.act('outcome-confirm-open','candidate-1'),/Основание устарело/);
  stale.setEnabled(false); await stale.view.load();
  assert.doesNotMatch(stale.view.render(),/data-do="outcome-reject-open"/);
  assert.match(stale.view.render(),/слой outcomes выключен/i);
  assert.equal(stale.commands.length,0);
});

test('rejection sends the loaded revision once and refreshes after command refusal', async () => {
  const h = harness({commandError:new Error('stale revision')}); await h.view.load(); await h.view.act('outcome-open','candidate-1');
  await h.view.act('outcome-reject-open','candidate-1'); const dialog = h.dialogs.at(-1);
  await assert.rejects(()=>dialog.submit({note:'Evidence is insufficient.'}),/stale revision/);
  assert.deepEqual(h.commands[0],{action:'outcome.candidate_reject',payload:{candidate_id:'candidate-1',note:'Evidence is insufficient.',expected_revision:4}});
  assert.equal(h.commands.length,1); assert.equal(h.refreshes,1);
  assert.ok(h.reads.filter(route=>route==='/api/outcomes/candidate-1').length >= 2);
});
