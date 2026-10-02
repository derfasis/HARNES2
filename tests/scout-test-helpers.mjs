import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store, id } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { ROOT, readJson } from '../business/config.mjs';
import { ScoutRuntime } from '../business/scout-runtime.mjs';
import { effectiveSourceConfig } from '../business/scout-policy.mjs';

export const ACCOUNT='991234567890';
export const channel=(extra={})=>({channel_id:'123456789',username:'sample_channel',title:'Synthetic Sample Channel',kind:'channel',joined:true,access_hash:'fixture-secret-shaped-native-field',...extra});
export const message=(message_id='1',extra={})=>{
  const text='A bounded synthetic source statement for operator review.';
  const result={message_id,author_ref:'visible-author-1',date:new Date(Date.now()-60000).toISOString(),text,reply_to:null,unsupported:false,
    link:`https://t.me/sample_channel/${message_id}`,...extra};
  result.content_hash=extra.content_hash??createHash('sha256').update(result.text??'').digest('hex');
  return result;
};
export const noHistory=async(input={})=>({empty:true,requested_count:input.limit??100,received_count:0,oldest_id:null,messages:[]});

export function scoutHarness(t,{history=noHistory,search=async()=>({candidates:[]}),resolve=async()=>channel(),discussions=async()=>null,modelEnabled=false}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'harnes2-scout-'));
  let store=new Store(directory),config=readJson(path.join(ROOT,'config/default.json'));
  config=structuredClone(config);
  config.scheduler.enabled=false;config.runtime.enabled=false;config.telegram.enabled=false;config.telegram.transport='mtproto';config.telegram.liveSending=false;
  config.controlPlane.enabled=true;config.opportunity.automatic=true;
  config.scout.enabled=true;config.scout.modelEnabled=modelEnabled;
  let service=new BusinessService(store,config);service.control.acquireProcess();service.setTelegramAccount(ACCOUNT);
  const owner={connected:true,stopped:false};
  const rpcFactory=()=>({accountId:ACCOUNT,connected:()=>owner.connected,
    search,resolve,discussions,history});
  let runtime=new ScoutRuntime(service,owner,{rpcFactory});
  t.after(()=>{try{service.control.close();service.control.releaseProcess();}catch{}try{store.close();}catch{}fs.rmSync(directory,{recursive:true,force:true});});
  const h={
    get store(){return store;},get config(){return config;},get service(){return service;},get runtime(){return runtime;},owner,
    command:(action,p,actor={kind:'operator'})=>service.command(action,p,id(),actor),
    effective:()=>effectiveSourceConfig(service),
    async campaign(topic='Synthetic market topic'){
      const result=await h.command('scout.create',{title:`Campaign ${topic}`,topic,audience:'Synthetic audience',language:'en',geography:'global',queries:[topic]});
      return {id:result.campaign_id,revision:result.revision};
    },
    async authorize(c,purpose='Bounded synthetic test read'){
      const result=await h.command('scout.authorize',{campaign_id:c.id,revision:c.revision,purpose,expires_at:new Date(Date.now()+86400000).toISOString()});
      return result.grant_id;
    },
    async seed(c,reference='@sample_channel'){
      await h.command('scout.seed',{campaign_id:c.id,revision:c.revision,reference});
      await runtime.tick();
      return store.get('SELECT * FROM scout_candidates WHERE campaign_id=? ORDER BY created_at LIMIT 1',c.id);
    },
    async auditAndSeal(c,candidate){
      const before=store.get('SELECT COUNT(*) n FROM scout_jobs WHERE campaign_id=? AND kind=\'history\' AND status IN (\'queued\',\'running\')',c.id).n;
      if(!before) await h.command('scout.audit',{campaign_id:c.id,revision:c.revision,candidate_id:candidate.id});
      const job=store.get("SELECT * FROM scout_jobs WHERE campaign_id=? AND kind='history' AND status='queued' ORDER BY created_at LIMIT 1",c.id);
      if(!job) throw new Error('Synthetic fixture did not produce a history job');
      for(let page=0;page<8;page++){
        await runtime.tick();
        const sample=store.get('SELECT * FROM scout_samples WHERE id=?',job.sample_id);
        if(sample?.status==='sealed')return sample;
        store.run('UPDATE scout_jobs SET next_at=? WHERE id=?',new Date(Date.now()-1000).toISOString(),job.id);
      }
      throw new Error('Synthetic history fixture did not terminate with an explicit empty page');
    },
    restart(){
      service.control.close();service.control.releaseProcess();store.close();
      store=new Store(directory);store.recover();service=new BusinessService(store,config);service.control.acquireProcess();service.setTelegramAccount(ACCOUNT);
      runtime=new ScoutRuntime(service,owner,{rpcFactory});
    }
  };
  return h;
}
