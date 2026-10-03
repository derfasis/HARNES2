import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start } from '../business/server.mjs';
import { ROOT, readJson } from '../business/config.mjs';
import { id } from '../business/store.mjs';
import { processAudienceAssessment } from '../business/audience-reasoning.mjs';
import { proposalFrom, SOURCE } from './audience-test-helpers.mjs';
import { createAudienceView } from '../public/audience.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);

async function serverHarness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-audience-recovery-ui-'));
  const config = structuredClone(readJson(path.join(ROOT, 'config/default.json')));
  config.server.port = 0;
  config.scheduler.enabled = false;
  config.runtime.enabled = false;
  config.runtime.baseUrl = 'https://offline-recovery-test.invalid/v1';
  config.runtime.model = 'offline-recovery-test';
  config.runtime.dailyBudgetUsd = null;
  config.runtime.maxRunsPerDay = 20;
  config.audience = { ...config.audience, enabled:true, modelEnabled:false, sources:[SOURCE], maxRunsPerDay:10 };
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

async function prepareFailedFocusedParent(app, t) {
  const service = app.service;
  const goal = await service.command('audience.open', { title:'Retry UI fixture',
    objective:'Understand a setup question', source_ids:[SOURCE] }, id());
  const ingest = (message_id,text) => service.command('source.ingest', { source_id:SOURCE,
    source_kind:'sanitized_fixture', message_id, author_id:`author:${SOURCE}`, display_name:null,
    thread_id:null, reply_to_id:null, version:1, operation:'upsert', text,
    created_at:'2026-01-01T00:00:00.000Z', updated_at:'2026-01-01T00:00:00.000Z' }, id(),
  { kind:'channel', sourceId:SOURCE });
  await ingest('retry-ui-root-1', 'How can I get started with setup?');
  service.audience.reconcile({ limit:10 });
  let detail = service.audience.detail(goal.goal_id);
  const captured = await service.command('audience.capture', { goal_id:goal.goal_id,
    expected_revision:detail.revision, expected_basis_fingerprint:detail.basis_fingerprint }, id());
  const manual = service.audience.assessment(captured.assessment_id);
  const proposal = await service.command('audience.propose', { assessment_id:manual.id,
    output:proposalFrom(manual.packet) }, id());
  let need = service.audience.need(proposal.need_ids[0]);
  await service.command('audience.review', { need_id:need.id, expected_revision:need.revision,
    expected_basis_fingerprint:need.basis_fingerprint, decision:'accept', note:'Synthetic UI fixture.' }, id());
  need = service.audience.need(need.id);
  await ingest('retry-ui-root-2', 'Where is the first setup step?');
  service.audience.reconcile({ limit:10 });

  const previousKey = process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY = 'offline-recovery-ui-test-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.PARTNER_MODEL_API_KEY;
    else process.env.PARTNER_MODEL_API_KEY = previousKey;
  });
  service.config.audience.modelEnabled = true;
  const context = service.audience.reassessmentContext(need.id);
  const requested = await service.command('audience.reassess', { need_id:need.id,
    expected_revision:context.need_revision,
    expected_basis_fingerprint:context.need_basis_fingerprint,
    expected_context_fingerprint:context.context_fingerprint }, id());
  const parentId = requested.assessment_id;
  const runtimeStub = { decide:async () => ({ completed:false, failure_cause:{ kind:'timeout',
    provider_error_type:'timeout', timed_out:true, retryable:true, attempt_count:1 } }) };
  await processAudienceAssessment(service, runtimeStub);
  assert.ok(['interrupted','invalid','stale'].includes(service.audience.assessment(parentId).status),
    'the provider stub produced a durable failed focused parent');
  return { goalId:goal.goal_id, need, parentId };
}

function createView(api, command, modalState) {
  return createAudienceView({ api, command, esc,
    panel:(title,body) => `<section><h2>${esc(title)}</h2>${body}</section>`,
    button:(title,action,buttonId='') => `<button data-do="${esc(action)}" data-id="${esc(buttonId)}">${esc(title)}</button>`,
    empty:(title,body='') => `<p>${esc(title)} ${esc(body)}</p>`,
    field:(name,title,type='text') => `<label>${esc(title)}<${type === 'textarea' ? 'textarea' : 'input'} name="${esc(name)}"></${type === 'textarea' ? 'textarea' : 'input'}></label>`,
    modal:(title,content,submit) => Object.assign(modalState, { title, content, submit }),
    refresh:async () => {}, notify:() => {} });
}

test('the real authenticated recovery UI creates one retry child and can cancel it after the source and model state change', async t => {
  const { app, api, command } = await serverHarness(t);
  const { goalId, need, parentId } = await prepareFailedFocusedParent(app, t);
  const modelConfig = app.service.config.audience.modelEnabled;
  assert.equal(modelConfig, true);
  const parentBefore = app.service.audience.assessment(parentId);
  assert.ok(parentBefore.attempt_receipt, 'the server exposes a closed failed-attempt receipt');
  const beforeEffects = Object.fromEntries(['persons','conversations','drafts','contact_permissions',
    'delivery_attempts','approvals','audience_work_links','work_cases','work_materials','action_proposals']
    .map(table => [table, app.store.get(`SELECT COUNT(*) n FROM ${table}`).n]));
  const modalState = {};
  const commands = [];
  const trackedCommand = async (action,payload) => {
    commands.push({ action, payload });
    return command(action,payload);
  };
  const view = createView(api, trackedCommand, modalState);

  await view.load();
  await view.act('audience-goal', goalId);
  await view.act('audience-assessment', parentId);
  let html = view.render();
  assert.match(html, /Повторить оценку/);
  assert.match(html, /Стоимость этой попытки неизвестна/);
  assert.match(html, /инертным|без отправки/);
  assert.doesNotMatch(html, /data-do="audience-(?:accept|propose|open-work|refresh-work|review)/);
  await view.act('audience-retry-reassessment', parentId);
  assert.match(modalState.content, /может повлечь дополнительную оплату/);
  assert.match(modalState.content, /ровно одного HTTP-вызова/);
  await modalState.submit({ reason:'  Explicitly retry this failed bounded review.  ' });
  assert.deepEqual(commands[0], { action:'audience.retry_reassessment', payload:{
    assessment_id:parentId,
    expected_basis_fingerprint:parentBefore.basis_fingerprint,
    expected_context_fingerprint:parentBefore.packet.reassessment.context_fingerprint,
    reason:'Explicitly retry this failed bounded review.' } });

  const child = app.service.audience.assessment(/* view selects the returned ID; inspect retry lineage */
    app.service.audience.assessment(parentId).retry.child_assessment.id);
  assert.equal(child.status, 'captured');
  assert.deepEqual(child.packet.reassessment.retry_of, { assessment_id:parentId,
    basis_fingerprint:parentBefore.basis_fingerprint });
  assert.equal(app.service.audience.assessment(parentId).status, parentBefore.status,
    'acceptance leaves the failed parent history unchanged');
  assert.deepEqual(app.service.audience.assessment(parentId).attempt_receipt, parentBefore.attempt_receipt);
  assert.match(view.render(), new RegExp(`<button data-do="audience-cancel-reassessment" data-id="${child.id}"`));

  await app.service.command('source.ingest', { source_id:SOURCE, source_kind:'sanitized_fixture',
    message_id:'retry-ui-after-child', author_id:`author:${SOURCE}`, display_name:null,
    thread_id:null, reply_to_id:null, version:1, operation:'upsert',
    text:'The source changed after the retry child was captured.',
    created_at:'2026-01-01T00:00:00.000Z', updated_at:'2026-01-01T00:00:00.000Z' }, id(),
  { kind:'channel', sourceId:SOURCE });
  app.service.config.audience.modelEnabled = false;
  await view.load();
  html = view.render();
  assert.match(html, new RegExp(`data-do="audience-cancel-reassessment" data-id="${child.id}"`));
  const cancelled = await view.act('audience-cancel-reassessment', child.id);
  assert.equal(cancelled, undefined);
  assert.deepEqual(commands.at(-1), { action:'audience.cancel_reassessment', payload:{
    assessment_id:child.id, expected_basis_fingerprint:child.basis_fingerprint } });
  assert.equal(app.service.audience.assessment(child.id).status, 'interrupted');
  assert.equal(app.service.config.audience.modelEnabled, false);
  assert.equal(app.service.config.runtime.enabled, false);
  assert.equal(app.service.config.telegram.enabled, false);
  assert.equal(app.service.config.telegram.liveSending, false);
  assert.deepEqual(Object.fromEntries(Object.keys(beforeEffects).map(table => [table,
    app.store.get(`SELECT COUNT(*) n FROM ${table}`).n])), beforeEffects,
  'retry acceptance and cancellation do not create approval, work, contact, or delivery effects');
  assert.equal(app.store.get('SELECT COUNT(*) n FROM runs').n, 1,
    'the failed parent run remains the only run until the captured child is explicitly processed');
  assert.equal(need.id, parentBefore.packet.reassessment.need_id);
});

test('retry controls are withheld when unavailable and closed receipt metadata is escaped', async () => {
  const parent = { id:'<parent>', status:'interrupted', current:true, basis_fingerprint:'attempt-fp',
    packet:{ reassessment:{ version:1, need_id:'n1', context_fingerprint:'context-fp' }, exchanges:[] },
    attempt_receipt:{ run_id:'<run>', status:'failed', model_api_calls:null, input_tokens:null,
      output_tokens:null, usage_status:'unknown', cost_status:'unknown', estimated_cost_usd:null,
      failure_cause:{ kind:'<img src=x onerror=execute()>', provider_error_type:'<script>x</script>' } },
    retry:{ eligible:true, available:false, reasons:['<img src=x onerror=execute()>'], child_assessment:null } };
  const api = async route => route.startsWith('/api/audience?')
    ? { items:[{ id:'g1' }], enabled:true, model_enabled:true }
    : route === '/api/audience/g1' ? { id:'g1', status:'OPEN', revision:1, needs:[], assessments:[] }
      : route === '/api/audience/assessments/%3Cparent%3E' ? structuredClone(parent)
        : assert.fail(`Unexpected API read ${route}`);
  const view = createView(api, async () => assert.fail('unavailable retry must not call the server'), {});
  await view.load(); await view.act('audience-goal','g1'); await view.act('audience-assessment','<parent>');
  const html = view.render();
  assert.match(html, /Стоимость этой попытки неизвестна/);
  assert.match(html, /Повтор недоступен/);
  assert.doesNotMatch(html, /data-do="audience-retry-reassessment"/);
  assert.ok(html.includes('&lt;img src=x onerror=execute()&gt;'));
  assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt;'));
  assert.equal(html.includes('<img src=x'), false);
  assert.equal(html.includes('<script>x'), false);
});
