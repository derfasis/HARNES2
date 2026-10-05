import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start } from '../business/server.mjs';
import { ROOT, readJson } from '../business/config.mjs';
import { id } from '../business/store.mjs';
import { SOURCE } from './audience-test-helpers.mjs';

test('actual authenticated HTTP preview is read-only and explicit renewal preserves the same goal',async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'harnes2-source-renewal-http-'));
  const config = structuredClone(readJson(path.join(ROOT,'config/default.json')));
  config.server.port=0; config.scheduler.enabled=false; config.runtime.enabled=false;
  config.telegram.enabled=false; config.telegram.liveSending=false;
  config.opportunity.automatic=true; config.opportunity.allowedSourceRefs=[SOURCE];
  config.audience={...config.audience,enabled:true,modelEnabled:false,sources:[SOURCE]};
  config.controlPlane={...config.controlPlane,enabled:true};
  const app=await start({config,directory});
  t.after(async()=>{await app.close();fs.rmSync(directory,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${app.server.address().port}`;
  const {token}=await(await fetch(`${origin}/api/session`)).json();
  const headers={'x-partner-token':token,'content-type':'application/json'};
  const s=app.service;
  const goal=await s.command('audience.open',{title:'Source continuity',objective:'Observe one setup question',source_ids:[SOURCE]},id());
  const ingest=async(message,text)=>s.command('source.ingest',{source_id:SOURCE,source_kind:'sanitized_fixture',
    message_id:message,author_id:'synthetic-author',display_name:null,thread_id:null,reply_to_id:null,
    version:1,operation:'upsert',text,created_at:'2026-01-01T00:00:00.000Z',updated_at:'2026-01-01T00:00:00.000Z'},id(),{kind:'channel',sourceId:SOURCE});
  await ingest('old','How do I start?');s.audience.reconcile();
  config.opportunity.allowedSourceRefs=[];s.audience.reconcile();config.opportunity.allowedSourceRefs=[SOURCE];
  const route=`/api/audience/goals/${goal.goal_id}/source-renewal?source_ref=${encodeURIComponent(SOURCE)}`;
  assert.equal((await fetch(`${origin}${route}`)).status,403);
  const eventsBefore=s.store.get('SELECT COUNT(*) n FROM events').n;
  const response=await fetch(`${origin}${route}`,{headers});assert.equal(response.status,200);
  const preview=await response.json();assert.equal(preview.goal_id,goal.goal_id);assert.equal(preview.gap,true);
  assert.equal(s.store.get('SELECT COUNT(*) n FROM events').n,eventsBefore,'GET preview creates no event or authority');
  assert.equal(s.store.get('SELECT COUNT(*) n FROM audience_watch_epochs').n,0);
  assert.equal((await fetch(`${origin}${route}&source_ref=${encodeURIComponent(SOURCE)}`,{headers})).status,400);
  const payload={goal_id:goal.goal_id,source_ref:SOURCE,expected_revision:preview.expected_revision,
    preview_sha256:preview.preview_sha256,acknowledge_gap:true};
  const renewed=await fetch(`${origin}/api/commands`,{method:'POST',headers,body:JSON.stringify({action:'audience.renew_source',payload,request_id:id()})});
  assert.equal(renewed.status,200,await renewed.clone().text());
  assert.equal((await renewed.json()).goal_id,goal.goal_id);
  await ingest('new','What is my next step?');s.audience.reconcile();
  const detail=await(await fetch(`${origin}/api/audience/${goal.goal_id}`,{headers})).json();
  assert.equal(detail.id,goal.goal_id);assert.equal(detail.objective,'Observe one setup question');
  const current=detail.exchanges.filter(e=>e.current);
  assert.ok(current.some(e=>e.evidence.some(item=>item.text==='What is my next step?')));
  assert.ok(!current.some(e=>e.evidence.some(item=>item.text==='How do I start?')));
  for(const table of ['runs','persons','conversations','drafts','delivery_attempts','audience_attention_grants'])
    assert.equal(s.store.get(`SELECT COUNT(*) n FROM ${table}`).n,0,`no implicit ${table}`);
});
