import test from 'node:test';
import assert from 'node:assert/strict';
import { createScoutView } from '../public/scout.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const campaignId='11111111-1111-4111-8111-111111111111';
const sourceId='22222222-2222-4222-8222-222222222222';
const now=()=>Date.now();
const campaignRoute='/api/scout/campaigns/'+campaignId;

function harness({eligible=true,pending=null,epoch=null,checkpointPhase='blocked',integrityLatched=true,fingerprint='checkpoint-fp-1',refreshFingerprint=fingerprint,joined=true,grantCurrent=true,campaignStatus='active'}={}) {
  const calls=[],dialogs=[];
  const makeDetail=fp=>({id:campaignId,status:campaignStatus,revision:4,config:{topic:'Topic'},
    candidates:[{id:sourceId,source_ref:'telegram:channel:123456789',channel_id:'123456789',username:'safe_channel',title:'Safe channel',joined,
      sample:{id:'sample-1',finished_at:'2026-10-01T00:00:00.000Z',coverage:'partial',metrics:{messages:2,authors:1,active_days:1,replies:0}},
      checkpoint:{pts:731,phase:checkpointPhase,reason:integrityLatched?'INTEGRITY_RECONCILIATION_REQUIRED':'OTHER'},checkpoint_fingerprint:fp,
      monitor_grant:{id:'monitor-1',current:grantCurrent,status:'active',expires_at:new Date(now()+86400000).toISOString()},
      observation_recovery:{epoch,pending,eligible}}]});
  const initial=makeDetail(fingerprint),fresh=makeDetail(refreshFingerprint);
  const campaigns=[{id:campaignId,status:'active',revision:4,title:'Topic',candidate_count:1}];
  const api=async route=>{calls.push({method:'GET',route});if(route==='/api/scout')return {enabled:true,model_enabled:false,campaigns};if(route===campaignRoute)return structuredClone(calls.filter(x=>x.method==='GET'&&x.route===campaignRoute).length>1?fresh:initial);throw new Error('Unexpected GET '+route);};
  const command=async(action,payload)=>{calls.push({method:'POST',action,payload:structuredClone(payload)});return {ok:true,authorization_id:'rebaseline-auth-1'};};
  const modal=(title,html,submit)=>dialogs.push({title,html,submit});
  const view=createScoutView({api,command,esc,modal,refresh:async()=>{}});
  return {view,calls,dialogs};
}

test('observation recovery is visible only for an eligible active joined source with latched checkpoint',async()=>{
  const ok=harness();await ok.view.load();let html=ok.view.render();
  assert.match(html,/Продолжить с нового наблюдения/);
  for(const opts of [{eligible:false},{integrityLatched:false},{joined:false},{grantCurrent:false},{campaignStatus:'paused'},{pending:{id:'pending-1',expires_at:new Date(now()+60000).toISOString()}}]){
    const h=harness(opts);await h.view.load();html=h.view.render();
    assert.doesNotMatch(html,/Продолжить с нового наблюдения/);
  }
  assert.deepEqual(ok.calls.filter(x=>x.method==='POST'),[]);
});

test('committed observation epoch remains visible after recovery is no longer eligible',async()=>{
  const h=harness({eligible:false,integrityLatched:false,epoch:{id:'epoch-2',generation:2,baseline_pts:900,history_complete:false},checkpointPhase:'current'});
  await h.view.load();const html=h.view.render();
  assert.match(html,/Поколение: 2/);
  assert.match(html,/базовый PTS: 900/);
  assert.match(html,/история неполная/);
  assert.match(html,/успешный опрос вперёд подтвердил текущее наблюдение/i);
  assert.doesNotMatch(html,/data-do="scout-observation-rebaseline"/);
});

test('recovery refreshes the source before consent and binds bounded authorization to refreshed fingerprint',async()=>{
  const h=harness();await h.view.load();await h.view.act('scout-observation-rebaseline',sourceId);
  const reads=h.calls.filter(x=>x.method==='GET'&&x.route===campaignRoute);
  assert.equal(reads.length,2,'fresh campaign must be loaded before showing consent');
  const form=h.dialogs.at(-1);
  assert.match(form.title,/нового наблюдения/i);
  assert.match(form.html,/исторический пробел неизвестен/i);
  assert.match(form.html,/старые факты и evidence.*устар/i);
  assert.match(form.html,/name="acknowledge_gap"/);
  assert.match(form.html,/30 минут/);
  assert.throws(()=>form.submit({reason:'Continue'}),/подтвердите.*пробел/i);
  assert.throws(()=>form.submit({acknowledge_gap:'yes',expires_at:new Date(now()+2*60*60*1000).toISOString(),reason:'Continue'}),/не более чем на 1 час/i);
  assert.equal(h.calls.filter(x=>x.method==='POST').length,0);
  const expiresAt=new Date(now()+30*60*1000).toISOString();
  await form.submit({acknowledge_gap:'yes',expires_at:expiresAt,reason:'Operator reviewed the unknown gap and stale evidence'});
  const call=h.calls.filter(x=>x.method==='POST').at(-1);
  assert.equal(call.action,'source.rebaseline');
  assert.deepEqual(call.payload,{source_id:'telegram:channel:123456789',checkpoint_fingerprint:'checkpoint-fp-1',acknowledge_gap:true,expires_at:expiresAt,reason:'Operator reviewed the unknown gap and stale evidence'});
});

test('stale checkpoint after refresh blocks the modal and pending recovery can be cancelled explicitly',async()=>{
  const stale=harness({fingerprint:'old-fingerprint',refreshFingerprint:'new-fingerprint'});
  await stale.view.load();
  await assert.rejects(()=>stale.view.act('scout-observation-rebaseline',sourceId),/checkpoint изменился|обновите/i);
  assert.equal(stale.dialogs.length,0);
  assert.equal(stale.calls.filter(x=>x.method==='POST').length,0);

  const cancel=harness({eligible:false,pending:{id:'authorization-7',expires_at:new Date(now()+30*60*1000).toISOString()}});
  await cancel.view.load();
  assert.match(cancel.view.render(),/Отменить продолжение наблюдения/);
  await cancel.view.act('scout-observation-rebaseline-cancel',sourceId);
  const form=cancel.dialogs.at(-1);
  assert.match(form.html,/отменить ожидающее разрешение/i);
  await form.submit({reason:'Source checkpoint was re-reviewed'});
  const call=cancel.calls.filter(x=>x.method==='POST').at(-1);
  assert.equal(call.action,'source.rebaseline_cancel');
  assert.deepEqual(call.payload,{authorization_id:'authorization-7',reason:'Source checkpoint was re-reviewed'});
});
