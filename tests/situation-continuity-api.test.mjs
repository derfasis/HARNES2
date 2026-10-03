import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start } from '../business/server.mjs';
import { ROOT, readJson } from '../business/config.mjs';
import { id } from '../business/store.mjs';
import { proposalFrom, SOURCE } from './audience-test-helpers.mjs';
import { createAudienceView } from '../public/audience.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);

async function serverHarness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-situation-api-'));
  const config = readJson(path.join(ROOT, 'config/default.json'));
  config.server.port = 0;
  config.scheduler.enabled = false;
  config.runtime.enabled = false;
  config.telegram.enabled = false;
  config.telegram.liveSending = false;
  config.audience = { ...config.audience, enabled:true, modelEnabled:false, sources:[SOURCE] };
  config.opportunity.allowedSourceRefs = [SOURCE];
  config.opportunity.automatic = true;
  config.continuity = { ...config.continuity, enabled:true, modelEnabled:false };
  config.workspace = { ...config.workspace, enabled:true, modelEnabled:false };
  config.actions = { ...config.actions, enabled:true, modelEnabled:false };
  config.controlPlane = { ...config.controlPlane, enabled:true };
  const app = await start({ config, directory });
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive:true, force:true }); });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const session = await (await fetch(`${origin}/api/session`)).json();
  const headers = { 'x-partner-token':session.token, 'content-type':'application/json' };
  const post = (action,payload) => fetch(`${origin}/api/commands`, { method:'POST', headers,
    body:JSON.stringify({ action, payload, request_id:id() }) });
  return { app, origin, headers, post };
}

async function prepareAcceptedNeed(app) {
  const service = app.service;
  const goal = await service.command('audience.open', { title:'API fixture', objective:'Understand a setup question', source_ids:[SOURCE] }, id());
  const ingest = (message_id,text,version=1) => service.command('source.ingest', { source_id:SOURCE,
    source_kind:'sanitized_fixture', message_id, author_id:`author:${SOURCE}`, display_name:null,
    thread_id:null, reply_to_id:null, version, operation:'upsert', text,
    created_at:'2026-01-01T00:00:00.000Z', updated_at:'2026-01-01T00:00:00.000Z' }, id(), { kind:'channel', sourceId:SOURCE });
  await ingest('api-root-1','How can I get started with the setup?');
  service.audience.reconcile({ limit:10 });
  let detail = service.audience.detail(goal.goal_id);
  const captured = await service.command('audience.capture', { goal_id:goal.goal_id,
    expected_revision:detail.revision, expected_basis_fingerprint:detail.basis_fingerprint }, id());
  const manual = service.audience.assessment(captured.assessment_id);
  const proposal = await service.command('audience.propose', { assessment_id:manual.id,
    output:proposalFrom(manual.packet) }, id());
  let need = service.audience.need(proposal.need_ids[0]);
  await service.command('audience.review', { need_id:need.id, expected_revision:need.revision,
    expected_basis_fingerprint:need.basis_fingerprint, decision:'accept', note:'API test acceptance only.' }, id());
  need = service.audience.need(need.id);
  await ingest('api-root-2','Where is the first setup step?');
  service.audience.reconcile({ limit:10 });
  return need;
}

function commandPayload(context) {
  return { need_id:context.need_id, expected_revision:context.need_revision,
    expected_basis_fingerprint:context.need_basis_fingerprint,
    expected_context_fingerprint:context.context_fingerprint };
}

test('authenticated reassessment context GET is pure, query-strict, and model-disabled requests do not enqueue', async t => {
  const { app, origin, headers, post } = await serverHarness(t);
  const need = await prepareAcceptedNeed(app);
  const before = {
    events:app.store.get('SELECT COUNT(*) n FROM events').n,
    assessments:app.store.get('SELECT COUNT(*) n FROM audience_assessments').n,
    offsets:app.store.get('SELECT COUNT(*) n FROM channel_offsets').n,
    runs:app.store.get('SELECT COUNT(*) n FROM runs').n,
  };
  const route = `/api/audience/needs/${need.id}/context`;
  assert.equal((await fetch(`${origin}${route}`)).status, 403, 'context reads require the operator session token');
  assert.equal((await fetch(`${origin}${route}?extra=1`, { headers })).status, 400);
  assert.equal((await fetch(`${origin}${route}?extra=1&extra=2`, { headers })).status, 400);
  const response = await fetch(`${origin}${route}`, { headers });
  assert.equal(response.status, 200);
  const context = await response.json();
  assert.equal(context.need_id, need.id);
  assert.equal(context.available, true);
  assert.equal(context.model_enabled, false);
  assert.equal(context.executable, false);
  assert.equal(context.contact_permission, false);
  assert.deepEqual(context.allowed_effects, []);
  assert.equal(context.hypothesis_memory.semantic_role, 'hypothesis_memory_not_source_evidence');
  assert.ok(context.prior_exchange_ids.length);
  assert.ok(context.new_exchange_ids.length);
  assert.ok(context.coverage);
  assert.deepEqual({
    events:app.store.get('SELECT COUNT(*) n FROM events').n,
    assessments:app.store.get('SELECT COUNT(*) n FROM audience_assessments').n,
    offsets:app.store.get('SELECT COUNT(*) n FROM channel_offsets').n,
    runs:app.store.get('SELECT COUNT(*) n FROM runs').n,
  }, before, 'authorized and rejected context GETs do not persist work or advance cursors');

  const disabled = await post('audience.reassess', commandPayload(context));
  assert.equal(disabled.status, 409, await disabled.clone().text());
  assert.equal((await disabled.json()).code, 'AUDIENCE_MODEL_DISABLED');
  assert.equal(app.store.get('SELECT COUNT(*) n FROM audience_assessments').n, before.assessments);
  assert.equal(app.store.get('SELECT COUNT(*) n FROM runs').n, 0);
});

test('a fresh authenticated context and explicit request capture a focused assessment without activating runtime or Telegram', async t => {
  const { app, origin, headers, post } = await serverHarness(t);
  const need = await prepareAcceptedNeed(app);
  app.service.config.audience.modelEnabled = true;
  const route = `/api/audience/needs/${need.id}/context`;
  const contextResponse = await fetch(`${origin}${route}`, { headers });
  assert.equal(contextResponse.status, 200);
  const context = await contextResponse.json();
  assert.equal(context.model_enabled, true);
  const requested = await post('audience.reassess', commandPayload(context));
  assert.equal(requested.status, 200, await requested.clone().text());
  const result = await requested.json();
  const captured = app.service.audience.assessment(result.assessment_id);
  assert.equal(captured.status, 'captured');
  assert.deepEqual(captured.packet.reassessment, { version:1, model_requested:true, need_id:need.id,
    need_revision:context.need_revision, need_basis_fingerprint:context.need_basis_fingerprint,
    context_fingerprint:context.context_fingerprint, observation_heads:context.observation_heads });
  assert.equal(captured.packet.executable, false);
  assert.equal(captured.packet.contact_permission, false);
  assert.deepEqual(captured.packet.allowed_effects, []);
  assert.equal(app.service.config.runtime.enabled, false);
  assert.equal(app.service.config.telegram.enabled, false);
  assert.equal(app.service.config.telegram.liveSending, false);
  assert.equal(app.store.get('SELECT COUNT(*) n FROM runs').n, 0, 'capture does not run a model or create a runtime invocation');
});

test('the real UI cancel button uses the captured assessment fingerprint after source context advances', async t => {
  const { app, origin, headers, post } = await serverHarness(t);
  const need = await prepareAcceptedNeed(app);
  const effects = () => Object.fromEntries(['persons','conversations','drafts','contact_permissions',
    'delivery_attempts','approvals','audience_work_links','work_cases','work_materials','action_proposals']
    .map(table => [table, app.store.get(`SELECT COUNT(*) n FROM ${table}`).n]));
  const beforeEffects = effects();
  app.service.config.audience.modelEnabled = true;
  const api = async route => {
    const response = await fetch(`${origin}${route}`, { headers });
    assert.equal(response.status, 200, `${route}: ${await response.clone().text()}`);
    return response.json();
  };
  const commands = [];
  let assessmentId = null;
  const command = async (action, payload) => {
    commands.push({ action, payload });
    const response = await post(action, payload);
    assert.equal(response.status, 200, `${action}: ${await response.clone().text()}`);
    const result = await response.json();
    if (action === 'audience.reassess') assessmentId = result.assessment_id;
    return result;
  };
  const view = createAudienceView({ api, command, esc,
    panel:(title, body) => `<section><h2>${esc(title)}</h2>${body}</section>`,
    button:(title, action, buttonId='') => `<button data-do="${esc(action)}" data-id="${esc(buttonId)}">${esc(title)}</button>`,
    empty:(title, body='') => `<p>${esc(title)} ${esc(body)}</p>`,
    field:(name, title) => `<div data-field="${esc(name)}">${esc(title)}</div>`,
    modal:() => {}, refresh:() => {}, notify:() => {} });

  await view.load();
  await view.act('audience-goal', need.goal_id);
  await view.act('audience-need', need.id);
  await view.act('audience-reassessment-context', need.id);
  await view.act('audience-reassess', need.id);
  const reassessRequest = commands.find(call => call.action === 'audience.reassess');
  assert.ok(reassessRequest);
  assert.ok(assessmentId, 'UI loaded a focused assessment from the real server');
  const captured = app.service.audience.assessment(assessmentId);
  assert.equal(captured.status, 'captured');
  assert.equal(captured.basis_fingerprint, captured.packet.reassessment.context_fingerprint);
  assert.notEqual(captured.basis_fingerprint, captured.packet.reassessment.need_basis_fingerprint,
    'the captured context fingerprint differs from the need basis');
  app.service.config.audience.modelEnabled = false;

  await app.service.command('source.ingest', { source_id:SOURCE, source_kind:'sanitized_fixture',
    message_id:'api-root-after-capture', author_id:`author:${SOURCE}`, display_name:null,
    thread_id:null, reply_to_id:null, version:1, operation:'upsert', text:'The source changed after this assessment was captured.',
    created_at:'2026-01-01T00:00:00.000Z', updated_at:'2026-01-01T00:00:00.000Z' }, id(), { kind:'channel', sourceId:SOURCE });
  const latestContext = await api(`/api/audience/needs/${need.id}/context`);
  assert.notEqual(latestContext.context_fingerprint, captured.basis_fingerprint,
    'the source update advanced the live context beyond the captured assessment');

  await view.load();
  assert.equal(app.service.audience.assessment(assessmentId).status, 'captured',
    'an advanced live source head does not rewrite the pending capture before cancellation');
  assert.match(view.render(), new RegExp(`data-do="audience-cancel-reassessment" data-id="${assessmentId}"`));
  await view.act('audience-cancel-reassessment', assessmentId);
  const cancel = commands.at(-1);
  assert.deepEqual(cancel, { action:'audience.cancel_reassessment', payload:{
    assessment_id:assessmentId, expected_basis_fingerprint:captured.basis_fingerprint } });
  assert.equal(app.service.audience.assessment(assessmentId).status, 'interrupted');
  assert.equal(app.store.get('SELECT COUNT(*) n FROM runs').n, 0,
    'cancellation records the explicit operator action without invoking a model/runtime run');
  assert.equal(app.service.config.audience.modelEnabled, false,
    'cancel authority remains available after model execution is disabled');
  assert.equal(app.service.config.telegram.enabled, false);
  assert.equal(app.service.config.telegram.liveSending, false);
  assert.deepEqual(effects(), beforeEffects, 'request and cancel create no owner approval, contact or execution');
});
