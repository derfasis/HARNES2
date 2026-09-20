import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function ui(detail) {
 const ctx=vm.createContext({console,Date,Map,JSON,crypto:{randomUUID:()=> 'fixture-id'},document:{querySelector:()=>({})}});
 const bootstrap=source.slice(0,source.indexOf("document.addEventListener('click'"));
 vm.runInContext(bootstrap+`\n globalThis.setup=(value)=>{detail=value;selected=value.conversation.id;state={lessons:[],runtime:{ready:false}};};globalThis.panelHtml=engagementPanel;globalThis.action=act;modal=(title,content,submit)=>{globalThis.form={title,content,submit};};command=async(action,payload)=>{globalThis.call={action,payload};return {};};refresh=async()=>{};`,ctx);
 ctx.setup(detail);return ctx;
}
const engagement={id:'e',topic:'Costs',current_need:'Need',unknowns:['Unknown'],close_condition:'Resolved',status:'WAITING',ownership:'AI_OWNED',revision:7,beliefs:[],explained:[],waiting:[{events:['operator_response'],due_at:null}],commitments:[],handoffs:[],strategies:[]};
const detail={conversation:{id:'c'},engagements:[engagement],messages:[{id:'m',text:'Costs?'}],decisions:[],contact_permissions:[]};
test('engagement UI escapes source content and exposes wait, ownership and review-first permissions',()=>{
 const ctx=ui({...detail,engagements:[{...engagement,topic:'<img src=x onerror=alert(1)>',current_need:'<script>bad()</script>'}]});const html=ctx.panelHtml();
 assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img src=x'));assert.match(html,/&lt;img/);assert.match(html,/operator_response/);assert.match(html,/AI_OWNED/);assert.match(html,/eng-permission-grant/);assert.match(html,/eng-decide/);
});
test('operator WAIT form submits revision and exact evidence, not a draft or permission',async()=>{
 const ctx=ui(detail);await ctx.action('eng-decide','e');await ctx.form.submit({kind:'WAIT',reason:'Need operator',expected_next:'Answer',message_id:'m',wait_for:'operator_response',text:'should not submit',purpose:'reply'});
 assert.equal(ctx.call.action,'decision.commit');assert.equal(ctx.call.payload.expected_revision,7);assert.deepEqual(JSON.parse(JSON.stringify(ctx.call.payload.evidence)),[{type:'message',id:'m'}]);assert.ok(!ctx.call.payload.action);
});
test('operator ACT form submits a proposal with purpose, never approval or send',async()=>{
 const ctx=ui(detail);await ctx.action('eng-decide','e');await ctx.form.submit({kind:'ACT',reason:'Answer',expected_next:'Inbound',message_id:'m',wait_for:'operator_response',text:'Proposed answer',purpose:'reply'});
 assert.equal(ctx.call.action,'decision.commit');assert.equal(ctx.call.payload.action.text,'Proposed answer');assert.equal(ctx.call.payload.action.purpose,'reply');assert.ok(!ctx.call.payload.wait_for);
});
test('closed UI cannot silently resume or create a legacy draft',()=>{
 const ctx=ui({...detail,engagements:[{...engagement,status:'STOPPED'}]});const html=ctx.panelHtml();assert.match(html,/eng-open/);assert.doesNotMatch(html,/eng-decide/);assert.match(html,/новий дозвіл/);
});

test('legacy reply and draft buttons require explicit reopening after a historical engagement',async()=>{
 const ctx=ui({...detail,engagements:[{...engagement,status:'CLOSED'}]});
 await ctx.action('reply-task');assert.match(ctx.form.title,/Відкрити постійну справу/);assert.equal(ctx.call,undefined);
 await ctx.action('draft-new');assert.match(ctx.form.title,/Відкрити постійну справу/);assert.equal(ctx.call,undefined);
});
