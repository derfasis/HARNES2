import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderActivationCard } from '../public/readiness.js';
import { createScoutView } from '../public/scout.js';
import { createAudienceView } from '../public/audience.js';
import { start } from '../business/server.mjs';
import { ROOT, readJson } from '../business/config.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g,
  c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const sourceRef = 'telegram:channel:123456';
const campaignId = '11111111-1111-4111-8111-111111111111';
const candidateId = '22222222-2222-4222-8222-222222222222';
const future = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

function documentedState(overrides = {}) {
  return {
    release: { code_sha:'a'.repeat(40), dirty:false, verified:true, mode:'managed', instance_id:'instance-1', pid:4200, port:8790, deployment_id:'deploy-1' },
    activation: { version:1, id:'activation-1', label:'Read-only pilot', mode:'read_only', expires_at:future(), phase:'active',
      model_capability_available:false, explicit_authority_required:true, contact_permission:false, allowed_effects:[] },
    runtime: { enabled:false, ready:false, missing:['runtime_disabled'] },
    telegram: { enabled:false, configured:true, connected:true, live_sending:false, allowed_chats:0 },
    scheduler: { enabled:true, source_readers:{ configured_sources:1, active_readers:1, missing_readers:0 },
      control:{ enabled:true, owned:true, stopped:false } },
    configuration: { runtime_enabled:false, audience_enabled:true, scout_enabled:true, control_plane_enabled:true,
      opportunity_automatic:true, model_endpoint_allowlisted:true, public_source_configured:true },
    ...overrides,
  };
}

function scoutHarness({ current = true, status = 'active', expiresAt = future(), latestCurrent = current } = {}) {
  const reads = [], commands = [], handoffs = [];
  const data = { enabled:true, model_enabled:false, campaigns:[{ id:campaignId, title:'Public source', topic:'How-to support', revision:2, status:'active', candidate_count:1 }] };
  const candidate = { id:candidateId, channel_id:'123456', username:'public_channel', title:'Public channel', kind:'channel', joined:true,
    sample:{ id:'sample-1', finished_at:future(), coverage:'bounded' },
    monitor_grant:{ id:'monitor-1', campaign_id:campaignId, candidate_id:candidateId, campaign_revision:2,
      status, current, expires_at:expiresAt, purpose:'Observe public updates' } };
  const detail = { id:campaignId, title:'Public source', topic:'How-to support', revision:2, status:'active',
    config:{ topic:'How-to support' }, authority:{ scout:{ id:'audit-1', current:true, status:'active' } }, candidates:[candidate], jobs:[], unknown:[] };
  const api = async route => {
    reads.push(route);
    if (route === '/api/scout') return structuredClone(data);
    if (route === `/api/scout/campaigns/${campaignId}`) {
      const fresh = structuredClone(detail);
      if (!latestCurrent) fresh.candidates[0].monitor_grant.current = false;
      return fresh;
    }
    throw new Error(`Unexpected read ${route}`);
  };
  const view = createScoutView({ api, command:async (action,payload) => { commands.push({action,payload}); return {}; }, esc,
    modal:() => {}, refresh:async () => {}, openAudienceGoal:async handoff => { handoffs.push(structuredClone(handoff)); } });
  return { view, reads, commands, handoffs, detail, candidate };
}

function audienceHarness({ refs = [sourceRef], refsOnSave = refs, latestCurrent = true } = {}) {
  const reads = [], commands = [], dialogs = [];
  const listing = { items:[], next_cursor:null, enabled:true, model_enabled:false, source_refs:refs };
  const monitorExpiry = future();
  let monitorCurrent = latestCurrent;
  const api = async route => {
    reads.push(route);
    if (route === '/api/audience?limit=50') {
      const result = { ...listing, source_refs:reads.filter(x=>x==='/api/audience?limit=50').length === 1 ? refs : refsOnSave };
      return structuredClone(result);
    }
    if (route === `/api/scout/campaigns/${campaignId}`) {
      return { id:campaignId, status:'active', revision:2, candidates:[{
        id:candidateId, channel_id:'123456', joined:true,
        monitor_grant:{ id:'monitor-1', status:'active', current:monitorCurrent, campaign_id:campaignId,
          candidate_id:candidateId, campaign_revision:2, expires_at:monitorExpiry },
      }] };
    }
    throw new Error(`Unexpected read ${route}`);
  };
  let view;
  view = createAudienceView({ api, command:async (action,payload) => { commands.push({action,payload}); return { goal_id:'goal-created' }; }, esc,
    panel:(title,body,action='') => `<section><h2>${esc(title)}</h2>${body}${action}</section>`,
    button:(title,action,id='') => `<button data-do="${esc(action)}" data-id="${esc(id)}">${esc(title)}</button>`,
    empty:(title,body='') => `<p>${esc(title)} ${esc(body)}</p>`,
    field:(name,title,type='text',value='',options=[]) => type === 'textarea'
      ? `<label>${esc(title)}<textarea name="${esc(name)}"></textarea></label>`
      : `<label>${esc(title)}<input name="${esc(name)}" value="${esc(value)}"></label>`,
    modal:(title,content,submit) => dialogs.push({title,content,submit}), refresh:async () => {}, notify:() => {} });
  return { view, reads, commands, dialogs, listing, monitorExpiry, setMonitorCurrent:value => { monitorCurrent = value; } };
}

test('readiness distinguishes release identity, read-only capability and explicit authority without offering mutations', () => {
  const state = documentedState({ activation:{ ...documentedState().activation, mode:'read_only', model_capability_available:true } });
  const html = renderActivationCard(state, esc);
  assert.match(html, /a{40}/);
  assert.match(html, /PID 4200/);
  assert.match(html, /Read-only pilot/);
  assert.match(html, /read.only|только чтение|модельные вызовы закрыты/i);
  assert.match(html, /отдельное явное разрешение/i);
  assert.match(html, /1 активных читателя из 1/i);
  assert.match(html, /не подтверждает свежесть.*проверяется отдельно для каждого источника и цели/i);
  assert.doesNotMatch(html, /data-do=/);
  assert.doesNotMatch(html, /API key|credential value|secret/i);
});

test('cold defaults report exact missing prerequisites and never claim source, model capability or authority', () => {
  const state = documentedState({
    release:{ code_sha:'b'.repeat(40), dirty:true, verified:false, mode:'unmanaged', instance_id:'legacy-1', pid:12, port:8790 },
    activation:null,
    configuration:{ runtime_enabled:false, audience_enabled:false, scout_enabled:false, control_plane_enabled:false,
      opportunity_automatic:false, model_endpoint_allowlisted:false, public_source_configured:false },
    telegram:{ enabled:false, configured:false, connected:false, live_sending:false },
    scheduler:{ enabled:false, source_readers:{configured_sources:0,active_readers:0,missing_readers:0}, control:{enabled:false,owned:false,stopped:true} },
  });
  const html = renderActivationCard(state, esc);
  assert.match(html, /выпуска не подтверждён/i);
  for (const missing of ['Audience','Scout','Control Plane','автоматический публичный контур','разрешённый модельный endpoint','разрешённый публичный источник']) assert.match(html, new RegExp(missing, 'i'));
  assert.match(html, /модельная возможность закрыта/i);
  assert.match(html, /нет активации/i);
  assert.doesNotMatch(html, /готово к наблюдению|модель доступна/i);
  assert.doesNotMatch(html, /data-do=/);
});

test('readiness escapes identity metadata and an expired scoped activation is not current', () => {
  const hostile = '<img src=x onerror="bad()">';
  const state = documentedState({
    release:{ ...documentedState().release, code_root:hostile },
    activation:{ ...documentedState().activation, label:hostile, mode:'scoped_reasoning', expires_at:'2000-01-01T00:00:00.000Z' },
  });
  const html = renderActivationCard(state,esc);
  assert.equal(html.includes(hostile),false); assert.match(html,/&lt;img src=x onerror=/);
  assert.match(html,/активация не действует/);
  assert.match(html,/Модельная возможность закрыта или не подтверждена/);
  assert.doesNotMatch(html,/Модельная возможность доступна/);
});

test('active monitor authority offers a handoff only after re-reading its exact campaign and opens without a command', async () => {
  const h = scoutHarness(); await h.view.load();
  assert.match(h.view.render(), /Добавить цель Audience/);
  await h.view.act('scout-audience-handoff', candidateId);
  assert.deepEqual(h.handoffs, [{source_ref:sourceRef, grant_id:'monitor-1', expires_at:h.candidate.monitor_grant.expires_at, campaign_id:campaignId, campaign_revision:2, candidate_id:candidateId}]);
  assert.ok(h.reads.filter(route => route === `/api/scout/campaigns/${campaignId}`).length >= 2, 'click performs an authenticated fresh detail read');
  assert.deepEqual(h.commands, []);
});

test('expired or revoked source cannot be handed off, including an authority change after the Scout panel was loaded', async () => {
  for (const options of [
    {current:false},
    {status:'revoked'},
    {expiresAt:new Date(Date.now() - 60_000).toISOString()},
    {current:true, latestCurrent:false},
  ]) {
    const h = scoutHarness(options); await h.view.load();
    assert.doesNotMatch(h.view.render(), /data-do="scout-audience-handoff"/);
    await assert.rejects(h.view.act('scout-audience-handoff',candidateId), /monitor|истёк|отозван|недоступен/i);
    assert.deepEqual(h.handoffs, []); assert.deepEqual(h.commands, []);
  }
});

test('handoff opens the ordinary goal form with one frozen source and saves only after fresh source revalidation', async () => {
  const h = audienceHarness(); await h.view.load();
  await h.view.openGoalForSource({source_ref:sourceRef, grant_id:'monitor-1', expires_at:h.monitorExpiry, campaign_id:campaignId, campaign_revision:2, candidate_id:candidateId});
  const form = h.dialogs.at(-1);
  assert.match(form.content, /telegram:channel:123456/);
  assert.match(form.content, /Сохранение создаст только цель/i);
  assert.equal(h.commands.length,0);
  await form.submit({title:'Public audience need',objective:'Understand questions about the public guide'});
  assert.deepEqual(h.commands,[{action:'audience.open',payload:{title:'Public audience need',objective:'Understand questions about the public guide',source_ids:[sourceRef]}}]);
  assert.ok(h.reads.includes('/api/audience?limit=50'), 'save re-reads current allowed source refs');
  assert.ok(!h.commands.some(call=>call.action.includes('grant')||call.action.includes('profile')));
});

test('handoff form cannot save when source authority expired or was revoked while it was open', async () => {
  const h = audienceHarness({refs:[sourceRef],refsOnSave:[]}); await h.view.load();
  await h.view.openGoalForSource({source_ref:sourceRef, grant_id:'monitor-1', expires_at:h.monitorExpiry, campaign_id:campaignId, campaign_revision:2, candidate_id:candidateId});
  const form = h.dialogs.at(-1);
  await assert.rejects(form.submit({title:'Public audience need',objective:'Understand the public guide'}), /источник|разрешение|обновите/i);
  assert.deepEqual(h.commands,[]);
});

test('handoff save fails closed if the exact monitor grant changes while the form is open', async () => {
  const h = audienceHarness(); await h.view.load();
  await h.view.openGoalForSource({source_ref:sourceRef, grant_id:'monitor-1', expires_at:h.monitorExpiry,
    campaign_id:campaignId, campaign_revision:2, candidate_id:candidateId});
  const form = h.dialogs.at(-1);
  h.setMonitorCurrent(false);
  await assert.rejects(form.submit({title:'Public audience need',objective:'Understand the public guide'}), /разрешение источника|источник.*действует/i);
  assert.equal(h.reads.filter(route=>route===`/api/scout/campaigns/${campaignId}`).length,2);
  assert.deepEqual(h.commands,[]);
});

test('actual cold server serves readiness module and reports matching unverified release identity without creating authority', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'harnes2-activation-ui-'));
  const config = readJson(path.join(ROOT,'config/default.json'));
  config.server.port = 0; config.scheduler.enabled = false; config.telegram.enabled = false; config.telegram.liveSending = false;
  config.audience = { ...(config.audience ?? {}), enabled:false, modelEnabled:false };
  config.scout = { ...(config.scout ?? {}), enabled:false, modelEnabled:false };
  config.runtime = { ...config.runtime, enabled:false };
  config.controlPlane = { ...(config.controlPlane ?? {}), enabled:false };
  const app = await start({ config, directory });
  t.after(async () => { await app.close(); fs.rmSync(directory,{recursive:true,force:true}); });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const module = await fetch(`${origin}/readiness.js`);
  const moduleBody = await module.text(); assert.equal(module.status,200,moduleBody); assert.match(moduleBody,/renderActivationCard/);
  const health = await (await fetch(`${origin}/health`)).json();
  const token = (await (await fetch(`${origin}/api/session`)).json()).token;
  const response = await fetch(`${origin}/api/state`,{headers:{'x-partner-token':token}});
  assert.equal(response.status,200);
  const state = await response.json();
  assert.equal(state.release.verified,false); assert.equal(state.activation,null);
  for (const key of ['instance_id','pid','port','code_sha','dirty','mode']) assert.equal(typeof state.release[key] !== 'undefined',true,key);
  assert.deepEqual(health.release,state.release);
  assert.equal(state.configuration.audience_enabled,false);
  assert.equal(state.configuration.scout_enabled,false);
  assert.equal(state.configuration.control_plane_enabled,false);
  assert.equal(state.configuration.public_source_configured,false);
  assert.equal(state.configuration.runtime_enabled,false);
  assert.equal(state.telegram.live_sending,false);
  assert.equal(app.store.get('SELECT COUNT(*) n FROM audience_goals').n,0);
  assert.equal(app.store.get('SELECT COUNT(*) n FROM audience_attention_grants').n,0);
  assert.equal(app.store.get('SELECT COUNT(*) n FROM scout_grants').n,0);
  assert.equal(app.store.get('SELECT COUNT(*) n FROM runs').n,0);
});
