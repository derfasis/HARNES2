import { AppError } from './errors.mjs';
import { sourceTransportKind } from './source-ingestion.mjs';
import { telegramReadState } from './telegram-read-gate.mjs';
import { effectiveSourceConfig } from './scout-policy.mjs';

const CHANNEL='scout-monitor-v1';
export const TELEGRAM_MONITOR_INTERVAL_MS=120000;

// Scout adds a portfolio cadence, not a second source loop. Native readers keep
// their PTS/reconciliation contracts; selection merely grants two reads per pass.
export function dueTelegramSources(service,readers){
 const telegram=readers.filter(r=>sourceTransportKind(service,r.sourceId)==='telegram');
 if(!service.scout.enabled)return telegram;
 service.scout.ready();
 // maxLagSeconds is a freshness tolerance, never a delivery/availability SLA. The nominal
 // polling target is half that tolerance (capped by the portfolio default); actual freshness
 // still depends on a completed, valid transport checkpoint and resource availability.
 const policies=new Map((effectiveSourceConfig(service).opportunity?.telegramSources??[]).map(p=>[p.sourceId,p]));
 const account=service.telegramAccountId,key=`${service.config.partnerId}:${account}`;
 const row=service.store.get('SELECT cursor FROM channel_offsets WHERE channel=? AND account_id=?',CHANNEL,key);
 let state={version:1,attempts:{}};
 try{if(row)state=JSON.parse(row.cursor);}catch{throw new AppError('Monitor cadence is corrupt',409,'SCOUT_MONITOR_CURSOR_INVALID');}
 if(state.version!==1||!state.attempts||typeof state.attempts!=='object'||Array.isArray(state.attempts)||Object.values(state.attempts).some(n=>!Number.isFinite(n)||n<0||n>Date.now()+30000))throw new AppError('Monitor cadence is corrupt',409,'SCOUT_MONITOR_CURSOR_INVALID');
 const known=new Set(telegram.map(r=>r.sourceId));
 state.attempts=Object.fromEntries(Object.entries(state.attempts).filter(([source])=>known.has(source)));
 const selected=telegram.filter(r=>{
   const policy=policies.get(r.sourceId);
   const interval=Number.isInteger(policy?.maxLagSeconds)&&policy.maxLagSeconds>0
     ?Math.min(TELEGRAM_MONITOR_INTERVAL_MS,policy.maxLagSeconds*500):TELEGRAM_MONITOR_INTERVAL_MS;
   return Date.now()-(state.attempts[r.sourceId]??0)>=interval
     &&telegramReadState(service,account,{sourceId:r.sourceId}).ready;
 })
   .sort((a,b)=>(state.attempts[a.sourceId]??0)-(state.attempts[b.sourceId]??0)||a.sourceId.localeCompare(b.sourceId)).slice(0,2);
 for(const r of selected)state.attempts[r.sourceId]=Date.now();
 service.store.run('INSERT INTO channel_offsets(channel,account_id,cursor) VALUES(?,?,?) ON CONFLICT(channel,account_id) DO UPDATE SET cursor=excluded.cursor',CHANNEL,key,JSON.stringify(state));
 return selected;
}
