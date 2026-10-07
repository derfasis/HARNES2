// Schema-15 follow-up transfer keeps durable history while retiring all authority.
// All model results are injected synthetic responses; import runs against fresh staging dirs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../business/config.mjs';
import { Store, hash, id } from '../business/store.mjs';
import { exportPartner } from '../business/export.mjs';
import { BusinessService } from '../business/service.mjs';
import { processAudienceAssessment } from '../business/audience-reasoning.mjs';
import { audienceHarness, SOURCE, EVENT_TIME, proposalFrom, modelOutputFrom } from './audience-test-helpers.mjs';

const PROFILE_URL = 'https://followup-transfer.example.test/v1';
const FIXED_NOW = '2026-01-01T00:30:00.000Z';

function setup(t) {
  t.mock.timers.enable({ apis:['Date'], now:new Date(FIXED_NOW) });
  const previous=process.env.PARTNER_MODEL_API_KEY;
  process.env.PARTNER_MODEL_API_KEY='offline-followup-transfer-sentinel';
  t.after(()=>previous===undefined?delete process.env.PARTNER_MODEL_API_KEY:process.env.PARTNER_MODEL_API_KEY=previous);
  const h=audienceHarness(t);
  Object.assign(h.config.runtime,{enabled:false,baseUrl:'',model:'',dailyBudgetUsd:5,inputUsdPerMillion:null,outputUsdPerMillion:null,maxRunsPerDay:50});
  h.config.audience.modelEnabled=false;
  h.config.audience.maxRunsPerDay=20;
  h.config.modelProfiles={allowedBaseUrls:[PROFILE_URL]};
  h.config.controlPlane.enabled=true;
  return h;
}

async function profile(h) {
  return h.command('model.profile_create',{label:'Synthetic transfer profile',provider:'custom',api_mode:'chat_completions',
    base_url:PROFILE_URL,model:'offline-followup-transfer-model',max_output_tokens:900,
    input_usd_per_million:2,output_usd_per_million:3});
}

async function seedNeed(h,label) {
  const goal=await h.open({title:`Synthetic transfer ${label}`,objective:'Continue one synthetic evidence-backed need.',source_ids:[SOURCE]});
  await h.command('source.ingest',{source_id:SOURCE,source_kind:'sanitized_fixture',message_id:`${label}-anchor`,
    author_id:'synthetic-author',display_name:null,thread_id:`${label}-thread`,reply_to_id:null,version:1,operation:'upsert',
    text:`The original synthetic question for ${label}.`,created_at:EVENT_TIME,updated_at:EVENT_TIME},undefined,{kind:'channel',sourceId:SOURCE});
  h.service.audience.reconcile({limit:10});
  const detail=h.service.audience.detail(goal.goal_id);
  assert.equal(detail.ready,true);
  const captured=await h.command('audience.capture',{goal_id:goal.goal_id,expected_revision:detail.revision,
    expected_basis_fingerprint:detail.basis_fingerprint});
  const packet=h.service.audience.assessment(captured.assessment_id).packet;
  const proposed=await h.command('audience.propose',{assessment_id:captured.assessment_id,output:proposalFrom(packet)});
  let need=h.service.audience.need(proposed.need_ids[0]);
  await h.command('audience.review',{need_id:need.id,expected_revision:need.revision,
    expected_basis_fingerprint:need.basis_fingerprint,decision:'accept',note:'Accept the synthetic baseline.'});
  need=h.service.audience.need(need.id);
  assert.equal(need.status,'accepted');
  return {goal,need};
}

async function addFreshEvent(h,label) {
  const at=new Date().toISOString();
  await h.command('source.ingest',{source_id:SOURCE,source_kind:'sanitized_fixture',message_id:`${label}-fresh`,
    author_id:'synthetic-author',display_name:null,thread_id:`${label}-fresh-thread`,reply_to_id:null,version:1,operation:'upsert',
    text:`A newly observed synthetic event supports a narrow follow-up for ${label}.`,created_at:at,updated_at:at},undefined,
  {kind:'channel',sourceId:SOURCE});
  h.service.audience.reconcile({limit:10});
}

async function request(h,need,selected) {
  const context=h.service.followup.context(need.id);
  assert.equal(context.available,true);
  const result=await h.command('audience.followup_request',{need_id:need.id,expected_revision:context.need_revision,
    expected_basis_fingerprint:context.need_basis_fingerprint,expected_context_fingerprint:context.context_fingerprint,
    model_profile_id:selected.profile_id??selected.id,expected_profile_hash:selected.definition_hash,
    expires_at:new Date(Date.now()+60*60*1000).toISOString(),reason:'One synthetic transfer verification.'});
  return result;
}

function runtimeFor(targetNeedId) {
  return {decide:async(_run,context)=>({completed:true,final_response:JSON.stringify(modelOutputFrom(context.packet,
    proposalFrom(context.packet,{need_id:targetNeedId,title:'Synthetic transferred follow-up',
      hypothesis:'New synthetic evidence supports a narrow revision.',why_now:'Only the fresh packet supports this revision.'}))),
    usage:{input_tokens:29,output_tokens:11},model_identity:{model_id:'offline-followup-transfer-model',model_version:'fixture-v1'},api_calls:1})};
}

function importBundle(t,h,bundle,label) {
  const file=path.join(h.directory,`followup-transfer-${label}-${id()}.json`);
  fs.writeFileSync(file,JSON.stringify(bundle),{flag:'wx'});
  const destination=path.join(ROOT,'exports',`followup-transfer-${label}-${id()}`);
  t.after(()=>fs.rmSync(destination,{recursive:true,force:true}));
  return {file,destination,result:spawnSync(process.execPath,['scripts/import.mjs',file,destination],
    {cwd:ROOT,encoding:'utf8',windowsHide:true})};
}

test('schema-18 transfer preserves request, attempt and receipt history while revoking pending authority',async t=>{
  const h=setup(t),selected=await profile(h);
  const completed=await seedNeed(h,'completed');
  await addFreshEvent(h,'completed');
  const completedRequest=await request(h,completed.need,selected);
  const runResult=await processAudienceAssessment(h.service,runtimeFor(completed.need.id));
  assert.equal(runResult.disposition,'proposal_created');
  const pending=await seedNeed(h,'pending');
  await addFreshEvent(h,'pending');
  const pendingRequest=await request(h,pending.need,selected);

  const bundle=exportPartner(h.store);
  assert.equal(bundle.migrations.length,18);
  assert.equal(bundle.tables.audience_followup_requests.length,2);
  assert.equal(bundle.tables.audience_followup_attempts.length,1);
  const consumedSource=bundle.tables.audience_followup_attempts.find(row=>row.request_id===completedRequest.request_id);
  assert.ok(consumedSource);
  assert.equal(bundle.tables.audience_followup_attempts.some(row=>row.request_id===pendingRequest.request_id),false);

  const {result,destination}=importBundle(t,h,bundle,'schema15');
  assert.equal(result.status,0,result.stderr);
  const restored=new Store(path.join(destination,'data'));
  try {
    const service=new BusinessService(restored,h.config);
    const pendingDetail=service.followup.detail(pendingRequest.request_id);
    assert.equal(pendingDetail.status,'revoked');
    assert.equal(pendingDetail.state,'revoked');
    assert.equal(pendingDetail.assessment_status,'stale');
    assert.equal(pendingDetail.attempt,null);

    const consumedDetail=service.followup.detail(completedRequest.request_id);
    assert.equal(consumedDetail.status,'revoked');
    assert.equal(consumedDetail.state,'revoked');
    assert.equal(consumedDetail.attempt.run_id,consumedSource.run_id);
    const run=restored.get('SELECT * FROM runs WHERE id=?',consumedSource.run_id);
    assert.equal(run.status,'completed');
    const receipt=JSON.parse(run.result_json);
    assert.equal(receipt.followup_request.id,completedRequest.request_id);
    assert.equal(receipt.followup_request.request_fingerprint,consumedSource.request_fingerprint);
    assert.equal(restored.get('SELECT COUNT(*) n FROM audience_followup_requests').n,2);
    assert.equal(restored.get('SELECT COUNT(*) n FROM audience_followup_attempts').n,1);
    assert.equal(service.followup.hasPending(),false);
    assert.equal(restored.get("SELECT COUNT(*) n FROM audience_followup_requests WHERE status='active'").n,0);
    assert.deepEqual(restored.all('PRAGMA foreign_key_check'),[]);
  } finally { restored.close(); }
});

test('actual schema-14 catalogue imports without follow-up or epoch tables and upgrades to 18',async t=>{
  const h=setup(t),bundle=exportPartner(h.store);
  bundle.migrations=bundle.migrations.slice(0,14);
  delete bundle.tables.source_observation_epochs;
  delete bundle.tables.audience_watch_epochs;
  delete bundle.tables.audience_followup_requests;
  delete bundle.tables.audience_followup_attempts;
  delete bundle.tables.audience_first_contact_heads;
  bundle.tables_sha256=hash(JSON.stringify(bundle.tables));
  assert.equal(Object.hasOwn(bundle.tables,'audience_followup_requests'),false);
  assert.equal(Object.hasOwn(bundle.tables,'audience_followup_attempts'),false);
  const {result,destination}=importBundle(t,h,bundle,'schema14');
  assert.equal(result.status,0,result.stderr);
  const restored=new Store(path.join(destination,'data'));
  try {
    assert.equal(restored.get('SELECT COUNT(*) n FROM schema_migrations').n,18);
    assert.equal(restored.get('SELECT COUNT(*) n FROM audience_followup_requests').n,0);
    assert.equal(restored.get('SELECT COUNT(*) n FROM audience_followup_attempts').n,0);
    assert.deepEqual(restored.all('PRAGMA foreign_key_check'),[]);
  } finally { restored.close(); }
});

test('schema-18 catalogue and follow-up row shape are exact on import',async t=>{
  const h=setup(t),base=exportPartner(h.store);
  const malformedBundles=[];
  const missingTable=structuredClone(base);
  delete missingTable.tables.audience_followup_attempts;
  missingTable.tables_sha256=hash(JSON.stringify(missingTable.tables));
  malformedBundles.push({label:'missing-followup-table',bundle:missingTable,pattern:/Bundle table list differs/});

  const misplacedTables=structuredClone(base);
  misplacedTables.migrations=misplacedTables.migrations.slice(0,14);
  delete misplacedTables.tables.source_observation_epochs;
  delete misplacedTables.tables.audience_first_contact_heads;
  misplacedTables.tables_sha256=hash(JSON.stringify(misplacedTables.tables));
  malformedBundles.push({label:'schema14-with-schema15-tables',bundle:misplacedTables,pattern:/Bundle table list differs/});

  const malformedRow=structuredClone(base);
  malformedRow.tables.audience_followup_requests.push({unexpected_column:'not a valid row'});
  malformedRow.tables_sha256=hash(JSON.stringify(malformedRow.tables));
  malformedBundles.push({label:'unexpected-followup-row-shape',bundle:malformedRow,pattern:/Unexpected columns in audience_followup_requests/});

  for(const {label,bundle,pattern} of malformedBundles) {
    const {result,destination}=importBundle(t,h,bundle,label);
    assert.notEqual(result.status,0,`${label} must be rejected`);
    assert.match(result.stderr,pattern);
  }
});
