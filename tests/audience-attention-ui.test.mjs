import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start } from '../business/server.mjs';
import { ROOT, readJson } from '../business/config.mjs';
import { id } from '../business/store.mjs';
import { processAudienceAssessment } from '../business/audience-reasoning.mjs';
import { SOURCE } from './audience-test-helpers.mjs';
import { createAudienceView } from '../public/audience.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g,
  c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);

async function serverHarness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-audience-attention-ui-'));
  const config = structuredClone(readJson(path.join(ROOT, 'config/default.json')));
  config.server.port = 0;
  config.scheduler.enabled = false;
  config.runtime.enabled = false;
  config.runtime.baseUrl = 'https://offline-attention-ui.invalid/v1';
  config.runtime.model = 'offline-attention-ui';
  config.runtime.dailyBudgetUsd = null;
  config.runtime.maxRunsPerDay = 20;
  config.audience = { ...config.audience, enabled:true, modelEnabled:false,
    sources:[SOURCE], maxRunsPerDay:10 };
  config.opportunity.allowedSourceRefs = [SOURCE];
  config.opportunity.automatic = true;
  config.controlPlane = { ...config.controlPlane, enabled:true, maxConcurrent:3, reservationUsd:0.25 };
  config.telegram.enabled = false;
  config.telegram.liveSending = false;
  const app = await start({ config, directory });
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive:true, force:true }); });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const session = await (await fetch(`${origin}/api/session`)).json();
  const headers = { 'x-partner-token':session.token, 'content-type':'application/json' };
  const api = async route => {
    const response = await fetch(`${origin}${route}`, { headers });
    assert.equal(response.status, 200, `${route}: ${await response.clone().text()}`);
    return response.json();
  };
  const command = async (action,payload) => {
    const response = await fetch(`${origin}/api/commands`, { method:'POST', headers,
      body:JSON.stringify({ action, payload, request_id:id() }) });
    assert.equal(response.status, 200, `${action}: ${await response.clone().text()}`);
    return response.json();
  };
  return { app, api, command };
}

async function createReadyGoal(service, prefix='attention-ui') {
  const created = await service.command('audience.open', { title:'Attention UI fixture',
    objective:'Understand a public setup question', source_ids:[SOURCE] }, id());
  const ingest = (messageId,text) => service.command('source.ingest', { source_id:SOURCE,
    source_kind:'sanitized_fixture', message_id:messageId, author_id:`author:${SOURCE}`,
    display_name:null, thread_id:null, reply_to_id:null, version:1, operation:'upsert', text,
    created_at:'2026-01-01T00:00:00.000Z', updated_at:'2026-01-01T00:00:00.000Z' }, id(),
  { kind:'channel', sourceId:SOURCE });
  await ingest(`${prefix}-root-1`, 'How can I begin setting up this tool?');
  service.audience.reconcile({ limit:10 });
  return { goalId:created.goal_id, ingest };
}

function makeView(api, command, modalState) {
  return createAudienceView({ api, command, esc,
    panel:(title,body) => `<section><h2>${esc(title)}</h2>${body}</section>`,
    button:(title,action,buttonId='') => `<button data-do="${esc(action)}" data-id="${esc(buttonId)}">${esc(title)}</button>`,
    empty:(title,body='') => `<p>${esc(title)} ${esc(body)}</p>`,
    field:(name,title,type='text',value='') => `<label>${esc(title)}<${type === 'textarea' ? 'textarea' : 'input'} name="${esc(name)}">${esc(value)}</${type === 'textarea' ? 'textarea' : 'input'}></label>`,
    modal:(title,content,submit) => Object.assign(modalState, { title, content, submit }),
    refresh:async () => {}, notify:() => {} });
}

test('authenticated goal attention UI grants then revokes its frozen grant without enabling model execution', async t => {
  const previousKey = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'offline-attention-grant-ui-test-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.PARTNER_MODEL_API_KEY;
    else process.env.PARTNER_MODEL_API_KEY = previousKey;
  });
  const { app, api, command } = await serverHarness(t);
  const { goalId, ingest } = await createReadyGoal(app.service);
  const effects = () => Object.fromEntries(['persons','conversations','drafts','contact_permissions',
    'delivery_attempts','approvals','audience_work_links','work_cases','work_materials','action_proposals']
    .map(table => [table, app.store.get(`SELECT COUNT(*) n FROM ${table}`).n]));
  const effectsBefore = effects();
  const modalState = {}, commands = [];
  const trackedCommand = async (action,payload) => {
    commands.push({ action,payload });
    return command(action,payload);
  };
  const view = makeView(api, trackedCommand, modalState);
  await view.load();
  await view.act('audience-goal', goalId);
  const goal = await api(`/api/audience/${goalId}`);
  assert.ok(goal.attention?.scope_fingerprint, 'the server returns the exact goal attention scope');
  assert.equal(app.service.config.audience.modelEnabled, false);
  assert.match(view.render(), /Глобальные модельные вызовы выключены/i);
  assert.match(view.render(), /data-do="audience-attention-grant"/);

  await view.act('audience-attention-grant', goalId);
  assert.match(modalState.content, /1–50|1-50|1 до 50/);
  assert.match(modalState.content, /семи дней|7 дней/);
  const grantExpiry = new Date(Date.now()+24*60*60*1000).toISOString();
  await modalState.submit({ max_attempts:'2', expires_at:grantExpiry,
    reason:'  Authorize only two bounded attempts for this goal.  ' });
  const grantRequest = commands[0];
  assert.deepEqual(grantRequest.action, 'audience.attention_grant');
  assert.deepEqual(grantRequest.payload, { goal_id:goalId, expected_revision:goal.revision,
    expected_scope_fingerprint:goal.attention.scope_fingerprint, max_attempts:2,
    expires_at:grantExpiry, reason:'Authorize only two bounded attempts for this goal.' });
  assert.ok(Date.parse(grantRequest.payload.expires_at) > Date.now());
  const afterGrant = await api(`/api/audience/${goalId}`);
  const grant = afterGrant.attention.grants.find(row => row.status === 'active') ?? afterGrant.attention.grants.at(-1);
  assert.ok(grant?.id && grant.grant_fingerprint);
  assert.equal(grant.max_attempts, 2);
  assert.equal(grant.attempts_used, 0);
  assert.equal(grant.remaining_attempts, 2);
  assert.equal(app.service.config.audience.modelEnabled, false,
    'granting a goal mandate does not enable the independent global model switch');

  await ingest('attention-ui-root-after-grant', 'A later source observation changed the public evidence.');
  app.service.config.audience.modelEnabled = false;
  await view.load();
  const staleGoal = await api(`/api/audience/${goalId}`);
  assert.match(view.render(), new RegExp(`data-do="audience-attention-revoke" data-id="${grant.id}"`));
  await view.act('audience-attention-revoke', grant.id);
  await modalState.submit({ reason:'The evidence changed; withdraw this mandate.' });
  assert.deepEqual(commands.at(-1), { action:'audience.attention_revoke', payload:{
    grant_id:grant.id, expected_grant_fingerprint:grant.grant_fingerprint,
    reason:'The evidence changed; withdraw this mandate.' } });
  const afterRevoke = await api(`/api/audience/${goalId}`);
  assert.ok(afterRevoke.attention.grants.some(row => row.id === grant.id && row.status === 'revoked'));
  assert.equal(staleGoal.attention.scope_fingerprint, goal.attention.scope_fingerprint,
    'the UI submits the originally captured scope and the source observation does not silently rewrite it');
  assert.equal(app.service.config.audience.modelEnabled, false);
  assert.equal(app.service.config.runtime.enabled, false);
  assert.equal(app.service.config.telegram.liveSending, false);
  assert.deepEqual(effects(), effectsBefore);
});

test('authenticated ordinary failed-assessment retry uses its declared route and cancellation binds the child basis', async t => {
  const { app, api, command } = await serverHarness(t);
  const { goalId, ingest } = await createReadyGoal(app.service, 'ordinary-retry-ui');
  const effectTables = ['persons','conversations','drafts','contact_permissions','delivery_attempts',
    'approvals','audience_work_links','work_cases','work_materials','action_proposals'];
  const effects = () => Object.fromEntries(effectTables.map(table => [table,
    app.store.get(`SELECT COUNT(*) n FROM ${table}`).n]));
  const effectsBefore = effects();
  const previousKey = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'offline-attention-retry-test-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.PARTNER_MODEL_API_KEY;
    else process.env.PARTNER_MODEL_API_KEY = previousKey;
  });
  const grantGoal = await api(`/api/audience/${goalId}`);
  assert.ok(grantGoal.attention?.scope_fingerprint);
  await command('audience.attention_grant', { goal_id:goalId, expected_revision:grantGoal.revision,
    expected_scope_fingerprint:grantGoal.attention.scope_fingerprint, max_attempts:2,
    expires_at:new Date(Date.now()+24*60*60*1000).toISOString(),
    reason:'Synthetic one-goal UI verification for the initial failure and one explicit retry.' });
  app.service.config.audience.modelEnabled = true;
  const failed = await processAudienceAssessment(app.service, { decide:async () => ({ completed:false,
    api_calls:1, usage:{ input_tokens:200, output_tokens:0 },
    failure_cause:{ kind:'timeout', provider_error_type:'timeout', timed_out:true,
      retryable:true, attempt_count:1 } }) });
  const parentId = failed.assessment_id;
  const parent = app.service.audience.assessment(parentId);
  assert.ok(parent.attempt_receipt);
  assert.equal(parent.retry?.kind, 'ordinary');
  assert.equal(parent.retry?.available, true);
  const parentRunBefore = app.store.get('SELECT * FROM runs WHERE id=?', parent.run_id);
  const modalState = {}, commands = [];
  const trackedCommand = async (action,payload) => {
    commands.push({ action,payload });
    return command(action,payload);
  };
  const view = makeView(api, trackedCommand, modalState);
  await view.load();
  await view.act('audience-goal', goalId);
  await view.act('audience-assessment', parentId);
  assert.match(view.render(), /Повторить оценку|Повторить модельную попытку/);
  assert.match(view.render(), /Стоимость этой попытки неизвестна|Стоимость/i);
  await view.act('audience-retry-assessment', parentId);
  assert.match(modalState.content, /может повлечь дополнительную оплату/);
  await modalState.submit({ reason:'  Retry this ordinary failed assessment once.  ' });
  const retry = commands[0];
  assert.equal(retry.action, 'audience.retry_assessment');
  assert.deepEqual(retry.payload, { assessment_id:parentId,
    expected_basis_fingerprint:parent.basis_fingerprint,
    expected_context_fingerprint:parent.retry.context_fingerprint,
    reason:'Retry this ordinary failed assessment once.' });
  const child = app.service.audience.assessment(app.service.audience.assessment(parentId).retry.child_assessment.id);
  assert.equal(child.status, 'captured');
  assert.equal(child.packet.executable, false);
  assert.deepEqual(child.packet.allowed_effects, []);
  assert.deepEqual(child.packet.reasoning_retry, { version:1, model_requested:true,
    retry_of:{ assessment_id:parentId, basis_fingerprint:parent.basis_fingerprint },
    context_fingerprint:parent.retry.context_fingerprint });
  assert.equal(app.service.audience.assessment(parentId).status, parent.status);
  assert.deepEqual(app.store.get('SELECT * FROM runs WHERE id=?', parent.run_id), parentRunBefore,
    'retry acceptance leaves the parent run receipt unchanged');
  assert.match(view.render(), new RegExp(`data-do="audience-cancel-assessment" data-id="${child.id}"`));

  await ingest('ordinary-retry-ui-root-after-child', 'A source head advanced after retry capture.');
  app.service.config.audience.modelEnabled = false;
  await view.load();
  assert.match(view.render(), new RegExp(`data-do="audience-cancel-assessment" data-id="${child.id}"`));
  await view.act('audience-cancel-assessment', child.id);
  assert.deepEqual(commands.at(-1), { action:'audience.cancel_assessment', payload:{
    assessment_id:child.id, expected_basis_fingerprint:child.basis_fingerprint } });
  assert.equal(app.service.audience.assessment(child.id).status, 'interrupted');
  assert.equal(app.service.config.audience.modelEnabled, false);
  assert.equal(app.service.config.runtime.enabled, false);
  assert.equal(app.service.config.telegram.liveSending, false);
  assert.equal(app.store.get('SELECT COUNT(*) n FROM runs').n, 1,
    'the explicit retry is captured and cancellation does not buy a second run');
  assert.deepEqual(effects(), effectsBefore,
    'ordinary retry and cancellation create no review, work, contact, or delivery effects');
});
