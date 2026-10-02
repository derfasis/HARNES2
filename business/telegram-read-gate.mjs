import { AppError, now } from './errors.mjs';
const CHANNEL='telegram-account-read-v1';
const key=(service,account)=>`${service.config.partnerId}:${account}`;
function record(service,account){
 const raw=service.store.get('SELECT cursor FROM channel_offsets WHERE channel=? AND account_id=?',CHANNEL,key(service,account));
 if(!raw)return {day:now().slice(0,10),requests:0,audit_requests:0,sources:{},retry_at:null};
 let state;try{state=JSON.parse(raw.cursor);}catch{throw new AppError('Telegram read budget is corrupt',409,'SCOUT_READ_GATE_INVALID');}
 if(!state||typeof state!=='object'||Array.isArray(state)||!/^\d{4}-\d{2}-\d{2}$/.test(state.day)||!Number.isInteger(state.requests)||state.requests<0||!Number.isInteger(state.audit_requests)||state.audit_requests<0||state.audit_requests>state.requests||!state.sources||typeof state.sources!=='object'||Array.isArray(state.sources)||Object.keys(state.sources).length>1000||Object.values(state.sources).some(n=>!Number.isInteger(n)||n<0)||(state.retry_at!==null&&(!Number.isFinite(Date.parse(state.retry_at))||typeof state.retry_at!=='string')))throw new AppError('Telegram read budget is corrupt',409,'SCOUT_READ_GATE_INVALID');
 if(state.day!==now().slice(0,10))state={day:now().slice(0,10),requests:0,audit_requests:0,sources:{},retry_at:state.retry_at};
 return state;
}
function save(service,account,state){service.store.run('INSERT INTO channel_offsets(channel,account_id,cursor) VALUES(?,?,?) ON CONFLICT(channel,account_id) DO UPDATE SET cursor=excluded.cursor',CHANNEL,key(service,account),JSON.stringify(state));}
export function telegramReadState(service,account,{sourceId=null,priority='monitor'}={}){
 if(service.config.scout?.enabled!==true)return {ready:true};
 if(service.telegramReadFault)return {ready:false,reason:'SCOUT_READ_GATE_UNPROVEN'};
 if(!account||!service.control.processOwned||!service.control.processCurrent()||service.control.stopped)return {ready:false,reason:'SCOUT_OWNERSHIP_UNAVAILABLE'};
 const state=record(service,account),cfg=service.config.scout;
 if(state.retry_at&&Date.parse(state.retry_at)>Date.now())return {...state,ready:false,reason:'SCOUT_ACCOUNT_BACKOFF'};
 // Search/audit can use 20%; monitoring retains the remaining account capacity.
 const reserve=Math.max(1,Math.ceil(cfg.maxRequestsPerDay*.8)),auditLimit=Math.max(0,cfg.maxRequestsPerDay-reserve);
 if(state.requests>=cfg.maxRequestsPerDay||priority!=='monitor'&&state.audit_requests>=auditLimit||sourceId&&(state.sources[sourceId]??0)>=cfg.maxRequestsPerSourceDay)return {...state,ready:false,reason:'SCOUT_READ_BUDGET',retry_at:new Date(Date.parse(`${state.day}T00:00:00.000Z`)+86400000).toISOString()};
 return {...state,ready:true};
}
// Small authority/resource gate, not a second protocol/queue engine. One shared account
// serializes reads and always selects a waiting monitor before audit and search work.
export function telegramRead(service,{accountId,sourceId=null,priority='monitor'},fn){
 if(service.config.scout?.enabled!==true)return fn();
 if(!['monitor','audit','search'].includes(priority)||typeof fn!=='function')return Promise.reject(new AppError('Invalid read admission',409,'SCOUT_READ_GATE_INVALID'));
 service.telegramReadQueues??=new Map();
 let queue=service.telegramReadQueues.get(accountId);if(!queue){queue={active:false,pending:[]};service.telegramReadQueues.set(accountId,queue);}
 if(queue.pending.length>=32)return Promise.reject(new AppError('Telegram read queue is bounded',409,'SCOUT_READ_QUEUE_FULL'));
 return new Promise((resolve,reject)=>{
   queue.pending.push({sourceId,priority,fn,resolve,reject});void pump();
 });
 async function pump(){
   if(queue.active)return;queue.active=true;
   try{
     while(queue.pending.length){
       const rank={monitor:0,audit:1,search:2};queue.pending.sort((a,b)=>rank[a.priority]-rank[b.priority]);
       const job=queue.pending.shift();
       try{
         await service.exclusive(()=>service.store.transaction(()=>{
           if(service.telegramAccountId!==accountId)throw new AppError('Telegram account changed',409,'SCOUT_ACCOUNT_MISMATCH');
           const state=telegramReadState(service,accountId,job);if(!state.ready)throw new AppError(state.reason,429,state.reason);
           state.requests++;if(job.priority!=='monitor')state.audit_requests++;if(job.sourceId)state.sources[job.sourceId]=(state.sources[job.sourceId]??0)+1;
           delete state.ready;save(service,accountId,state);
         }));
         if(service.telegramAccountId!==accountId||!service.control.processCurrent()||service.control.stopped)throw new AppError('Read owner retired',409,'SCOUT_OWNERSHIP_UNAVAILABLE');
         // Source/grant checks live inside this queued operation immediately before invoke.
         const result=await job.fn();job.resolve(result);
       }catch(error){
         const text=String(error?.errorMessage??error?.message??'');
         const seconds=Number(error?.retrySeconds??error?.seconds??text.match(/FLOOD_WAIT_?(\d+)/)?.[1]);
         if((['SCOUT_FLOOD_WAIT','SCOUT_FLOOD_WAIT_MANUAL'].includes(error.code)||/FLOOD_WAIT/.test(text))&&Number.isSafeInteger(seconds)&&seconds>0&&service.control.processCurrent()){
           try{await service.exclusive(()=>service.store.transaction(()=>{
             if(!service.control.processCurrent())return;
             const state=record(service,accountId),until=new Date(Date.now()+seconds*1000).toISOString();
             if(!state.retry_at||Date.parse(until)>Date.parse(state.retry_at))state.retry_at=until;
             save(service,accountId,state);
           }));}catch{service.telegramReadFault=true;}
         }
         job.reject(error);
       }
     }
   }finally{queue.active=false;}
 }
}
