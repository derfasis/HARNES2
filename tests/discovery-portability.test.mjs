import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawnSync} from 'node:child_process';
import {Store,id,hash} from '../business/store.mjs';
import {ROOT,readJson} from '../business/config.mjs';
import {BusinessService} from '../business/service.mjs';
import {collectDiscovery,discoveryContext,discoveryDetail} from '../business/discovery.mjs';
import {exportPartner} from '../business/export.mjs';
import {start} from '../business/server.mjs';
import {ENGAGEMENT_TABLES} from '../business/engagement-tables.mjs';
import {DISCOVERY_TABLES} from '../business/discovery-tables.mjs';
import {DISCOVERY_LINK_TABLES} from '../business/discovery-link-tables.mjs';
function setup(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'discovery-portable-')),store=new Store(directory);
  const config=readJson(path.join(ROOT,'config/default.json'));Object.assign(config.discovery,{enabled:true,batchSeconds:0});
  Object.assign(config.opportunity,{automatic:true,allowedSourceRefs:['fixture:portable'],activeOffer:{id:'fixture',version:'1',text:'Information',criteria:['Self-expressed interest'],exclusions:[]}});
  const service=new BusinessService(store,config);
  t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});return {directory,store,config,service};
}
async function seed(h) {
  const stamp=new Date(Date.now()-60000).toISOString();
  await h.service.command('source.ingest',{source_id:'fixture:portable',source_kind:'sanitized_fixture',message_id:'m',author_id:'a',display_name:null,thread_id:null,reply_to_id:null,
    version:1,operation:'upsert',text:'Question about the format',created_at:stamp,updated_at:stamp},id());
  h.store.transaction(()=>collectDiscovery(h.service));const s=h.store.get('SELECT * FROM discovery_situations'),context=discoveryContext(h.service,s),did=id();
  h.store.run("INSERT INTO discovery_decisions(id,situation_id,revision,input_json,output_json,evidence_json,created_at,status) VALUES(?,?,1,?,?,?,?,'current')",did,s.id,JSON.stringify(context),JSON.stringify({decision:'WAIT',assessment:'uncertain'}),'[]',stamp);
  h.store.run('UPDATE discovery_situations SET current_decision_id=? WHERE id=?',did,s.id);return s;
}
test('Discovery export/import preserves all five migration tables and accepts exact known older prefixes',async t=>{
  const h=setup(t),s=await seed(h),original=exportPartner(h.store);
  for(const count of [2,3,4,5]) {
    const bundle=structuredClone(original),absent=[...(count<3?ENGAGEMENT_TABLES:[]),...(count<4?DISCOVERY_TABLES:[]),...(count<5?DISCOVERY_LINK_TABLES:[])];
    for(const table of absent)delete bundle.tables[table];bundle.migrations=bundle.migrations.slice(0,count);bundle.tables_sha256=hash(JSON.stringify(bundle.tables));
    const file=path.join(h.directory,`bundle-${count}.json`);fs.writeFileSync(file,JSON.stringify(bundle));
    const dest=path.join(ROOT,'exports',`discovery-test-${id()}`);t.after(()=>fs.rmSync(dest,{recursive:true,force:true}));
    const result=spawnSync(process.execPath,['scripts/import.mjs',file,dest],{cwd:ROOT,encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);
    const restored=new Store(path.join(dest,'data'));try {
      assert.deepEqual(restored.all('PRAGMA foreign_key_check'),[]);assert.equal(restored.all('SELECT * FROM schema_migrations').length,5);
      if(count>=4){const service=new BusinessService(restored,h.config);assert.equal(discoveryDetail(service,s.id).decision,'WAIT');assert.deepEqual(restored.all('SELECT * FROM discovery_decisions'),h.store.all('SELECT * FROM discovery_decisions'));}
      else assert.equal(restored.get('SELECT COUNT(*) n FROM discovery_situations').n,0);
    }finally{restored.close();}
  }
});
test('standalone export applies expiry and never exports expired derived text',async t=>{
  const h=setup(t);await seed(h);h.store.run("UPDATE discovery_situations SET expires_at='2000-01-01T00:00:00Z'");
  const bundle=exportPartner(h.store);assert.equal(bundle.tables.discovery_situations[0].status,'expired');assert.equal(bundle.tables.discovery_decisions[0].input_json,'{}');
  assert.equal(bundle.tables.events.some(e=>e.kind==='source.message'),true); // independent durable source ledger, explicitly retained
});
test('authenticated local operator API exposes Discovery; unauthenticated and model tool routes cannot mutate it',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'discovery-http-')),config=readJson(path.join(ROOT,'config/default.json'));config.scheduler.enabled=false;
  const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));config.server.port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const app=await start({config,directory});t.after(async()=>{await app.close();fs.rmSync(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${config.server.port}`;
  assert.equal((await fetch(base+'/api/discovery')).status,403);
  const {token}=await (await fetch(base+'/api/session')).json();const headers={'x-partner-token':token,'content-type':'application/json'};
  const result=await fetch(base+'/api/discovery',{headers});assert.equal(result.status,200);assert.deepEqual(await result.json(),{enabled:false,situations:[]});
  const missing=await fetch(base+'/api/discovery/missing',{headers});assert.equal(missing.status,409);
  const unauth=await fetch(base+'/api/commands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({request_id:id(),action:'discovery.forget',payload:{}})});assert.equal(unauth.status,403);
  const mcp=JSON.parse(fs.readFileSync(path.join(directory,'runtime/mcp-connection.json'),'utf8'));
  const tools=await (await fetch(base+'/internal/tools',{headers:{authorization:`Bearer ${mcp.token}`}})).json();assert.ok(!JSON.stringify(tools).includes('discovery.engage'));
  assert.equal(app.store.get('SELECT COUNT(*) n FROM runs').n,0);assert.equal(app.store.get('SELECT COUNT(*) n FROM drafts').n,0);
});
