import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function ui({detail:conversationDetail, references={items:[],unavailable:[]},materials={items:[],question_message_id:'m',offer_id:'offer-1'}}={}){
  const ctx=vm.createContext({console,Date,Map,JSON,Promise,URL,crypto:{randomUUID:()=> 'fixture-request'},document:{querySelector:()=>({}),querySelectorAll:()=>[]}});
  const bootstrap=source.slice(0,source.indexOf("document.addEventListener('click'"));
  vm.runInContext(bootstrap+`
    globalThis.setup=(value)=>{detail=value;selected=value.conversation.id;state={lessons:[],runtime:{ready:false}};};
    globalThis.panelHtml=engagementPanel;globalThis.action=act;globalThis.loadRefs=loadEngagementReferences;
    globalThis.setReferenceView=(value)=>{referenceView=value;};
    modal=(title,content,submit)=>{globalThis.form={title,content,submit};};
    command=async(action,payload)=>{globalThis.call={action,payload};return {};};
    refresh=async()=>{};
  `,ctx);
  ctx.setup(conversationDetail??detailFixture());
  ctx.setReferenceView({engagementId:'eng-1',items:references.items??[],unavailable:references.unavailable??[],materials:materials.items??[],
    questionMessageId:materials.question_message_id??null,offerId:materials.offer_id??null,error:''});
  return ctx;
}
const engagement={id:'eng-1',topic:'Germany costs',current_need:'Need reviewed material',unknowns:['Owner market unknown'],close_condition:'Question resolved',
  status:'WAITING',ownership:'AI_OWNED',revision:12,beliefs:[],explained:[],waiting:[],commitments:[],handoffs:[],strategies:[]};
function detailFixture(){return {conversation:{id:'conversation-1'},engagements:[engagement],messages:[{id:'m',direction:'in',text:'What are the costs?'}],decisions:[],contact_permissions:[]};}
const approvedMaterial={material_id:'material-1',sha256:'sha-fixture',title:'Germany reviewed material',content:'Exact reviewed excerpt. More context follows.',evidence_event_ids:['event-1']};
const sourceObservation={source_event_id:'event-1',source_ref:'fixture-source',message_id:'source-message',message_version:2,text:'Observed source text <img src=x onerror=alert(1)>',observed_at:'2026-10-14T10:00:00Z'};
const activeReference={id:'reference-1',reference_id:'reference-1',market:'DE',offer_id:'offer-1',question_message_id:'m',material_id:'material-1',material_sha256:'sha-fixture',title:'Germany reviewed material',excerpt:'Exact reviewed excerpt.',expires_at:'2026-10-15T10:00:00Z',epistemic_status:'reviewed_interpretation_not_verified_fact',sources:[sourceObservation]};

test('current references render provenance, safely link primary sources, and escape displayed content',()=>{
  const ctx=ui({references:{items:[{...activeReference,excerpt:'<script>bad()</script>',sources:[
    {...sourceObservation,url:'https://example.test/report?a=1&b=2',published_at:'2026-10-13T08:00:00Z'},
    {...sourceObservation,source_event_id:'event-2',url:'javascript:alert(1)'}
  ]}],unavailable:[]}});
  const html=ctx.panelHtml();
  assert.match(html,/reviewed_interpretation_not_verified_fact/);
  assert.match(html,/fixture-source/);
  assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html,/&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(html,/href="https:\/\/example\.test\/report\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(html,/href="javascript:/i);
  assert.match(html,/зафиксировано/);
  assert.match(html,/дата публикации по источнику/);
  assert.match(html,/не подтверждают цену/);
  assert.match(html,/data-do="eng-reference-revoke" data-id="reference-1"/);
  assert.match(html,/лише читати вибраний уривок/);
  const referenceSection=html.slice(html.indexOf('Дослідницькі посилання для цього питання'));
  assert.doesNotMatch(referenceSection,/data-do="(?:delivery-send|eng-permission-grant|eng-permission-revoke)"/);
});

test('unavailable references show only escaped status and reason, never prior excerpt text',()=>{
  const ctx=ui({references:{items:[],unavailable:[{id:'reference-1',status:'stale',reason:'REFERENCE_BASIS_CHANGED <script>x</script>'}]}});
  const html=ctx.panelHtml();
  assert.match(html,/stale/);
  assert.match(html,/REFERENCE_BASIS_CHANGED &lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(html,/Exact reviewed excerpt\./);
});

test('loading references calls only the exact engagement scoped read endpoints and clears stale content on failure',async()=>{
  const ctx=ui({references:{items:[activeReference],unavailable:[]}});
  vm.runInContext(`api=async route=>{globalThis.requested.push(route);if(route.includes('reference-materials'))throw new Error('references unavailable');return {items:[${JSON.stringify(activeReference)}],unavailable:[]};};globalThis.requested=[];`,ctx);
  await ctx.loadRefs('eng-1');
  const requested=JSON.parse(JSON.stringify(ctx.requested));
  assert.deepEqual(requested,[
    '/api/engagement/references?engagement_id=eng-1',
    '/api/engagement/reference-materials?engagement_id=eng-1'
  ]);
  assert.match(ctx.panelHtml(),/references unavailable/);
  assert.doesNotMatch(ctx.panelHtml(),/Exact reviewed excerpt\./);
  assert.equal(ctx.call,undefined);
});

test('attach form requires explicit question, country, exact excerpt, bounded expiry and note, then submits all current pins',async()=>{
  const ctx=ui({materials:{items:[approvedMaterial],question_message_id:'m',offer_id:'offer-1'}});
  await ctx.action('eng-reference-attach','eng-1');
  assert.match(ctx.form.content,/Явно виберіть поточне питання/);
  assert.match(ctx.form.content,/Країна, для якої застосовне посилання/);
  assert.match(ctx.form.content,/не вказує країну людини або власника/);
  assert.match(ctx.form.content,/точний схвалений текст/);
  const base={question_message_id:'m',material_id:'material-1',market:'DE',excerpt:'Exact reviewed excerpt.',expires_at:new Date(Date.now()+86400000).toISOString().slice(0,16),note:'Relevant to the current question'};
  assert.throws(()=>ctx.form.submit({...base,market:''}),/двома великими літерами/);
  assert.equal(ctx.call,undefined);
  assert.throws(()=>ctx.form.submit({...base,excerpt:'Invented text'}),/точним непорожнім фрагментом/);
  assert.equal(ctx.call,undefined);
  assert.throws(()=>ctx.form.submit({...base,expires_at:new Date(Date.now()+8*86400000).toISOString().slice(0,16)}),/не більше ніж на сім днів/);
  assert.equal(ctx.call,undefined);
  await ctx.form.submit(base);
  assert.equal(ctx.call.action,'reference.attach');
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.call.payload)),{
    engagement_id:'eng-1',expected_revision:12,material_id:'material-1',material_sha256:'sha-fixture',question_message_id:'m',
    offer_id:'offer-1',market:'DE',excerpt:'Exact reviewed excerpt.',expires_at:new Date(base.expires_at).toISOString(),note:'Relevant to the current question'
  });
});

test('revoke pins current engagement revision and reference id with a required reason',async()=>{
  const ctx=ui({references:{items:[activeReference],unavailable:[]}});
  await ctx.action('eng-reference-revoke','reference-1');
  assert.match(ctx.form.title,/Відкликати/);
  assert.throws(()=>ctx.form.submit({reason:' '}),/Укажіть причину/);
  assert.equal(ctx.call,undefined);
  await ctx.form.submit({reason:'The excerpt is no longer needed'});
  assert.equal(ctx.call.action,'reference.revoke');
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.call.payload)),{engagement_id:'eng-1',expected_revision:12,reference_id:'reference-1',reason:'The excerpt is no longer needed'});
});
