import test from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../business/server.mjs';
import { id } from '../business/store.mjs';
import { workspaceHarness } from './helpers/workspace-harness.mjs';

test('native operator API authenticates references, pins exact question and withholds changed source without a scheduler',async t=>{
  const h=workspaceHarness(t); h.config.engagement.enabled=true;
  h.config.server.port=0; h.config.scheduler.enabled=false;
  const caseId=await h.ready(), proposed=await h.material(caseId);
  await h.approve(caseId,proposed.material_id);
  const person=await h.command('person.create',{name:'API test recipient',source:'offline API fixture'});
  const question=await h.command('message.record',{conversation_id:person.conversation_id,text:'Explain the stated time requirement for Germany.',source:'fixture'});
  const engagement=h.service.engagement.current(person.conversation_id);
  const native=await start({config:h.config,directory:h.directory});
  h.beforeCleanup.push(()=>native.close('reference_api_test_finished'));
  const origin=`http://127.0.0.1:${native.server.address().port}`;
  const endpoint=`${origin}/api/engagement/references?engagement_id=${engagement.id}`;
  assert.equal((await fetch(endpoint)).status,403);
  const session=await(await fetch(`${origin}/api/session`)).json();
  const headers={'x-partner-token':session.token,'content-type':'application/json'};
  const materials=await(await fetch(`${origin}/api/engagement/reference-materials?engagement_id=${engagement.id}`,{headers})).json();
  assert.equal(materials.question_message_id,question.message_id);
  assert.equal(materials.contact_permission,false); assert.equal(materials.external_write,false);
  assert.equal(materials.items.length,1);
  const attach=await fetch(`${origin}/api/commands`,{method:'POST',headers,body:JSON.stringify({request_id:id(),action:'reference.attach',payload:{
    engagement_id:engagement.id,expected_revision:engagement.revision,material_id:proposed.material_id,
    material_sha256:materials.items[0].sha256,question_message_id:question.message_id,offer_id:materials.offer_id,
    market:'DE',excerpt:'The source states two hours weekly.',expires_at:new Date(Date.now()+3600000).toISOString(),note:'Exact API fixture admission'
  }})});
  assert.equal(attach.status,200,await attach.clone().text());
  const reference=await attach.json();
  const usable=await(await fetch(endpoint,{headers})).json();
  assert.equal(usable.items[0].reference_id,reference.reference_id);
  assert.equal(usable.items[0].epistemic_status,'reviewed_interpretation_not_verified_fact');
  assert.equal(usable.items[0].sources[0].text,'Two hours weekly.');
  assert.equal((await fetch(endpoint+'&engagement_id='+engagement.id,{headers})).status,400);
  assert.equal((await fetch(endpoint+'&other=1',{headers})).status,400);
  await h.ingest({version:2,text:'The time requirement was corrected.'});
  const unavailable=await(await fetch(endpoint,{headers})).json();
  assert.equal(unavailable.items.length,0);
  assert.ok(unavailable.unavailable.some(row=>row.id===reference.reference_id));
  assert.equal(JSON.stringify(unavailable).includes('The source states two hours weekly.'),false);
  assert.equal(native.store.get('SELECT COUNT(*) n FROM contact_permissions').n,0);
  assert.equal(native.store.get('SELECT COUNT(*) n FROM drafts').n,0);
  assert.equal(native.store.get('SELECT COUNT(*) n FROM delivery_attempts').n,0);
});
