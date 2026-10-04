import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudienceView } from '../public/audience.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g,
  c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const future = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

function fixture({ attention, modelEnabled = false } = {}) {
  const goalId = 'goal-1';
  const goal = { id:goalId, title:'Ограниченная цель', objective:'Понять вопрос аудитории',
    revision:4, status:'OPEN', ready:false, watches:[], needs:[], assessments:[], attention };
  const commands = [], modals = [];
  const api = async route => route === '/api/audience?limit=50'
    ? { items:[{ id:goalId, title:goal.title }], enabled:true, model_enabled:modelEnabled }
    : route === `/api/audience/${goalId}` ? structuredClone(goal) : null;
  const command = async (action,payload) => { commands.push({ action,payload }); return { id:'profile-new' }; };
  const view = createAudienceView({ api, command, esc,
    panel:(title,body) => `<section><h2>${esc(title)}</h2>${body}</section>`,
    button:(title,action,id='') => `<button data-do="${esc(action)}" data-id="${esc(id)}">${esc(title)}</button>`,
    empty:(title,body='') => `<p>${esc(title)} ${esc(body)}</p>`,
    field:(name,title,type='text',value='',options=[]) => {
      const choices = type === 'select' ? options.map(([v,label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('') : '';
      return `<label>${esc(title)}${type === 'textarea' ? `<textarea name="${esc(name)}"></textarea>` : type === 'select'
        ? `<select name="${esc(name)}">${choices}</select>` : `<input name="${esc(name)}" value="${esc(value)}">`}</label>`;
    },
    modal:(title,content,submit) => { modals.push({ title,content,submit }); },
    refresh:async () => {}, notify:() => {} });
  return { goalId, view, commands, modals, goal };
}

const profile = (overrides={}) => ({ profile_id:'profile-A', label:'Scoped profile', definition_hash:'a'.repeat(64),
  state:'available', model_config:{ provider:'custom', model:'offline-model', baseUrl:'https://proxy.example/v1',
    api_mode:'responses', max_output_tokens:2048 }, scope_fingerprint:'scope-profile-A', can_grant:true,
  model_ready:true, block_reasons:[], ...overrides });

test('profile creation uses only the frozen allowlist, escapes metadata and stores metadata without enabling inference', async () => {
  const ui = fixture({ attention:{ can_grant:false, model_configured:false, model_ready:false, credential_ready:true,
    allowed_base_urls:['https://proxy.example/v1','http://127.0.0.1:1234/v1'], profile_options:[], grants:[], block_reasons:[] } });
  await ui.view.load(); await ui.view.act('audience-goal', ui.goalId);
  const html = ui.view.render();
  assert.match(html, /Создать профиль модели/);
  await ui.view.act('audience-attention-profile-create', ui.goalId);
  const modal = ui.modals.at(-1);
  assert.match(modal.content, /не запускает модель/);
  assert.match(modal.content, /credential|учётные данные/i);
  assert.doesNotMatch(modal.content, /password|api.key|secret/i);
  assert.match(modal.content, /https:\/\/proxy\.example\/v1/);
  assert.match(modal.content, /http:\/\/127\.0\.0\.1:1234\/v1/);
  await modal.submit({ label:'  Local verification  ', provider:'custom', api_mode:'responses',
    base_url:'https://proxy.example/v1', model:'bounded-model', max_output_tokens:'1500',
    input_usd_per_million:'', output_usd_per_million:'' });
  assert.deepEqual(ui.commands, [{ action:'model.profile_create', payload:{ label:'Local verification', provider:'custom',
    api_mode:'responses', base_url:'https://proxy.example/v1', model:'bounded-model', max_output_tokens:1500,
    input_usd_per_million:null, output_usd_per_million:null } }]);
  await ui.view.act('audience-attention-profile-create', ui.goalId);
  await assert.rejects(ui.modals.at(-1).submit({ label:'Bad endpoint', provider:'custom', api_mode:'responses',
    base_url:'https://attacker.invalid/v1', model:'x', max_output_tokens:'500', input_usd_per_million:'', output_usd_per_million:'' }), /endpoint/i);
  assert.equal(ui.commands.length, 1, 'client never submits an endpoint outside the captured server allowlist');
});

test('scoped grant remains visibly billed authority with global model off and displays its canonical binding', async () => {
  const boundHash = 'c'.repeat(64);
  const ui = fixture({ attention:{ can_grant:false, ready:true, model_ready:true, model_configured:true,
    source_current:true, credential_ready:true, allowed_base_urls:['https://proxy.example/v1'],
    profile_options:[profile()], block_reasons:[], grants:[{ id:'grant-scoped', state:'active', status:'active',
      model_profile:{ id:'profile-A', definition_hash:boundHash }, attempts_used:0, max_attempts:1,
      remaining_attempts:1, expires_at:future() }] } });
  await ui.view.load(); await ui.view.act('audience-goal', ui.goalId);
  const html = ui.view.render();
  assert.match(html, /Глобальные модельные вызовы выключены/);
  assert.match(html, /Обычная Audience-оценка может выполняться/);
  assert.match(html, /может повлечь оплату/);
  assert.match(html, new RegExp(`Привязка модели: профиль profile-A · отпечаток ${boundHash}`));
  assert.doesNotMatch(html, /глобальная legacy-модель/);
  assert.equal(ui.commands.length, 0, 'displaying active scoped authority never grants or triggers a turn');
});

test('grant binds selected immutable profile and exact goal scope; unsafe or blocked profiles are not selectable', async () => {
  const active = profile({ label:'<img src=x onerror=alert(1)>', definition_hash:'b'.repeat(64) });
  const blocked = profile({ profile_id:'revoked-profile', state:'revoked', can_grant:true, model_ready:true,
    scope_fingerprint:'scope-revoked' });
  const ui = fixture({ attention:{ can_grant:false, scope_fingerprint:'legacy-scope', model_configured:false,
    model_ready:false, credential_ready:false, allowed_base_urls:['https://proxy.example/v1'],
    profile_options:[active,blocked], grants:[], block_reasons:['GLOBAL_MODEL_DISABLED'] } });
  await ui.view.load(); await ui.view.act('audience-goal', ui.goalId);
  const html = ui.view.render();
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /profile-A/);
  assert.match(html, new RegExp('b'.repeat(64)));
  assert.match(html, /GLOBAL_MODEL_DISABLED/);
  assert.match(html, /data-do="audience-attention-grant"/);
  await ui.view.act('audience-attention-grant', ui.goalId);
  const modal = ui.modals.at(-1);
  assert.match(modal.content, /может повлечь оплату/);
  assert.match(modal.content, /не принимает гипотезу/);
  assert.match(modal.content, /profile-A/);
  assert.match(modal.content, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(modal.content, /revoked-profile/);
  const expires = future();
  await modal.submit({ model_profile_id:'profile-A', max_attempts:'3', expires_at:expires,
    reason:'  One bounded goal-specific review.  ' });
  assert.deepEqual(ui.commands[0], { action:'audience.attention_grant', payload:{ goal_id:'goal-1',
    expected_revision:4, expected_scope_fingerprint:'scope-profile-A', model_profile_id:'profile-A',
    max_attempts:3, expires_at:expires, reason:'One bounded goal-specific review.' } });
  assert.equal(ui.commands.length, 1);
  assert.equal(ui.goal.attention.model_enabled, undefined, 'scoped grant does not edit global model configuration');
});

test('legacy global grant remains available when configured; profile revocation uses frozen definition hash', async () => {
  const p = profile({ can_grant:false, model_ready:false, scope_fingerprint:null });
  const ui = fixture({ modelEnabled:false, attention:{ can_grant:true, scope_fingerprint:'legacy-scope',
    model_configured:true, model_ready:true, credential_ready:true,
    allowed_base_urls:['https://proxy.example/v1'], profile_options:[p], grants:[], block_reasons:[] } });
  await ui.view.load(); await ui.view.act('audience-goal', ui.goalId);
  await ui.view.act('audience-attention-grant', ui.goalId);
  await ui.modals.at(-1).submit({ model_profile_id:'legacy', max_attempts:'1', expires_at:future(), reason:'Legacy bounded reason' });
  assert.equal(ui.commands[0].action, 'audience.attention_grant');
  assert.equal(ui.commands[0].payload.expected_scope_fingerprint, 'legacy-scope');
  assert.equal('model_profile_id' in ui.commands[0].payload, false);
  await ui.view.act('audience-attention-profile-revoke', 'profile-A');
  assert.match(ui.modals.at(-1).content, /Исторические записи сохранятся/);
  await ui.modals.at(-1).submit({ reason:'  Retire this immutable profile.  ' });
  assert.deepEqual(ui.commands[1], { action:'model.profile_revoke', payload:{ profile_id:'profile-A',
    expected_definition_hash:'a'.repeat(64), reason:'Retire this immutable profile.' } });
});
