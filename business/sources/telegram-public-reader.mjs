import { AppError } from '../errors.mjs';
import { digest, sourceCheckpoint } from '../source-ingestion.mjs';
import { bootstrapTelegramSource, disconnectTelegramSource, telegramSourcePolicy, telegramUpdateReceipt, telegramUpdateKey, telegramRecoveryCoverage, telegramRecoveryAuthorization } from './telegram-readonly.mjs';
import { Api, decimal, nativeCheck, nativeInt, mapTelegramUpdate, mapChannelDifference, mapTelegramControl } from './telegram-public-mapper.mjs';
import { createRequire } from 'node:module';
const { UpdateConnectionState }=createRequire(import.meta.url)('telegram/network');
const INTEGRITY='INTEGRITY_RECONCILIATION_REQUIRED';

export async function telegramReadDeadline(operation,abandon) {
  let timer;
  try{return await Promise.race([operation(),new Promise((_,reject)=>{timer=setTimeout(()=>{
    abandon();reject(new AppError('Public Telegram read deadline exceeded',504,'PUBLIC_TELEGRAM_READ_TIMEOUT'));
  },30000);})]);}finally{clearTimeout(timer);}
}

export class TelegramPublicSourceReader {
  #service; #p; #rpc; #peer; #pending=new Map(); #baseline=null; #epoch=0; #confirmed=null; #watermark=null; #final=false; #blocked=false; #closed=false; #retryAt=0; #closing; #health; #authorization; #peerDirty=false; #ptsHint=0; #username;
  constructor(service,sourceId,rpc,peer,username=null) {
    this.#service=service;this.#p=structuredClone(telegramSourcePolicy(service,sourceId));this.#rpc=rpc;this.#peer=peer;
    nativeCheck(peer instanceof Api.InputChannel && decimal(peer.channelId)===this.#p.channelId);
    this.#username=username;this.#authorization=telegramRecoveryAuthorization(service,this.#p);
    this.#peerDirty=sourceCheckpoint(service,this.#p.sourceId)!==null;
    this.#health=()=>this.confirmCurrent();service.sourceTransportHealth??=new Map();service.sourceTransportHealth.set(sourceId,this.#health);
    rpc.subscribe(update=>this.receive(update),()=>this.fault());
  }
  #owns() {return this.#service.sourceTransportHealth.get(this.#p.sourceId)===this.#health;}
  ownsSource() {return this.#owns() && !this.#closed;}
  recoveryAuthorization() {return this.#authorization && telegramRecoveryAuthorization(this.#service,this.#p)===this.#authorization ? this.#authorization : null;}
  #control(control) {
    if(control.kind==='ignore')return false;
    if(control.kind==='refresh_peer')this.#peerDirty=true;
    this.#ptsHint=Math.max(this.#ptsHint,control.pts_hint??0);this.#epoch++;return true;
  }
  #old(u) {
    if(this.#baseline!==null && u.pts<=this.#baseline) return true; // Explicit empty-history cutover.
    const row=telegramUpdateReceipt(this.#service,this.#p,u.pts,u.pts_count===0?telegramUpdateKey(u):null);
    return !!row && JSON.parse(row.payload_json).fingerprint===digest(u);
  }
  async #invalidate(integrity=false) {
    if(!this.#owns())return;
    const state=sourceCheckpoint(this.#service,this.#p.sourceId);
    if(integrity || state?.reason===INTEGRITY && !this.recoveryAuthorization())this.#blocked=true;
    if(state && state.reason!==INTEGRITY) await disconnectTelegramSource(this.#service,this.#p.sourceId,
      integrity?INTEGRITY:'DISCONNECTED',()=>this.#owns());
  }
  async receive(update) {
    if(this.#closed || this.#blocked || !this.#owns())return;
    if(update instanceof Api.Updates || update instanceof Api.UpdatesCombined) return Promise.all(update.updates.map(u=>this.receive(u)));
    if(update instanceof Api.UpdateShort)return this.receive(update.update);
    if(update instanceof UpdateConnectionState || update instanceof Api.UpdatesTooLong) {
      this.#epoch++;await this.#invalidate();return;
    }
    try {
      const peer=update.message?.peerId ?? update.peer;
      const channel=update.channelId ?? (peer instanceof Api.PeerChannel ? peer.channelId : null);
      if(channel==null || decimal(channel)!==this.#p.channelId)return; // Other message-box sequences are unrelated.
      const control=mapTelegramControl(this.#p,update);
      if(control){if(this.#control(control))await this.#invalidate();return;}
      const u=mapTelegramUpdate(this.#p,update),state=sourceCheckpoint(this.#service,this.#p.sourceId);
      if(state && u.pts<=state.pts && this.#old(u))return;
      const key=telegramUpdateKey(u),old=this.#pending.get(key);nativeCheck(!old || digest(old)===digest(u));
      if(old)return;
      nativeCheck(this.#pending.size<100);this.#pending.set(key,u);
      this.#epoch++;await this.#invalidate();
    } catch(error){this.#epoch++;await this.#invalidate(error.code!=='TELEGRAM_CLOCK_SKEW');
      if(error.code==='TELEGRAM_CLOCK_SKEW' && sourceCheckpoint(this.#service,this.#p.sourceId))
        await disconnectTelegramSource(this.#service,this.#p.sourceId,error.code,()=>this.#owns());}
  }
  async bootstrap() {
    nativeCheck(!this.#closed && this.#owns());
    telegramSourcePolicy(this.#service,this.#p.sourceId);
    const existing=sourceCheckpoint(this.#service,this.#p.sourceId);
    if(existing) {
      const row=this.#service.store.get("SELECT payload_json FROM events WHERE partner_id=? AND kind='source.telegram.baseline' AND json_extract(payload_json,'$.source_id')=? ORDER BY id LIMIT 1",
        this.#service.config.partnerId,this.#p.sourceId);
      nativeCheck(row);this.#baseline=JSON.parse(row.payload_json).pts;nativeCheck(nativeInt(this.#baseline));
      await this.#invalidate();return {duplicate:true,pts:existing.pts};
    }
    const response=await this.#read(new Api.channels.GetFullChannel({channel:this.#peer}));
    nativeCheck(!this.#closed && digest(telegramSourcePolicy(this.#service,this.#p.sourceId))===digest(this.#p));
    nativeCheck(response.fullChat instanceof Api.ChannelFull && decimal(response.fullChat.id)===this.#p.channelId
      && nativeInt(response.fullChat.pts) && !response.fullChat.ttlPeriod);
    const result=await bootstrapTelegramSource(this.#service,this.#p.sourceId,{pts:response.fullChat.pts,history:[]},
      ()=>!this.#blocked,()=>this.ownsSource());
    nativeCheck(!this.#closed && !this.#blocked && this.#owns());
    this.#baseline=response.fullChat.pts;
    for(const [key,u] of this.#pending)if(u.pts<=this.#baseline)this.#pending.delete(key);
    return result;
  }
  async #read(request) {
    if(Date.now()<this.#retryAt)throw new AppError('Public Telegram reader is waiting for retry',409,'PUBLIC_TELEGRAM_BACKOFF');
    try{return await telegramReadDeadline(()=>this.#rpc.invokeRead(request),()=>{this.#epoch++;this.#closed=true;});}catch(error){
      if(this.#closed)this.close().catch(()=>{});
      const seconds=Number.isInteger(error?.seconds)&&error.seconds>0?error.seconds:this.#service.config.scheduler.tickSeconds;
      this.#retryAt=Date.now()+seconds*1000;
      throw new AppError('Public Telegram read failed; source remains disconnected',502,'PUBLIC_TELEGRAM_READ_FAILED');
    }
  }
  async readDifference(input) {
    try {
    const p=telegramSourcePolicy(this.#service,this.#p.sourceId),state=sourceCheckpoint(this.#service,p.sourceId);
    nativeCheck(this.#owns() && digest(p)===digest(this.#p) && !this.#closed && !this.#blocked && this.#baseline!==null && input.accountId===p.accountId
      && input.channelId===p.channelId && input.pts===state?.pts && input.limit===100);
    if(this.#peerDirty) {
      const epoch=this.#epoch,full=await this.#read(new Api.channels.GetFullChannel({channel:this.#peer}));
      nativeCheck(!this.#closed && this.#owns() && full.fullChat instanceof Api.ChannelFull
        && decimal(full.fullChat.id)===p.channelId && !full.fullChat.ttlPeriod && Array.isArray(full.chats));
      const channel=full.chats.find(c=>c instanceof Api.Channel && decimal(c.id)===p.channelId);
      nativeCheck(channel && !channel.min && !channel.restricted && (channel.broadcast || channel.megagroup)
        && (channel.username || channel.usernames?.some(u=>u.active))
        && (!this.#username || channel.username?.toLowerCase()===this.#username.toLowerCase()
          || channel.usernames?.some(u=>u.active && u.username.toLowerCase()===this.#username.toLowerCase())));
      if(epoch===this.#epoch)this.#peerDirty=false;
    }
    nativeCheck(this.#owns() && !this.#closed && !this.#blocked
      && digest(telegramSourcePolicy(this.#service,p.sourceId))===digest(this.#p)
      && sourceCheckpoint(this.#service,p.sourceId)?.pts===input.pts);
    const response=await this.#read(new Api.updates.GetChannelDifference({channel:this.#peer,
      filter:new Api.ChannelMessagesFilterEmpty(),pts:input.pts,limit:100,force:false}));
    nativeCheck(!this.#closed && !this.#blocked && digest(telegramSourcePolicy(this.#service,p.sourceId))===digest(this.#p)
      && sourceCheckpoint(this.#service,p.sourceId)?.pts===input.pts);
    const result=mapChannelDifference(p,input.pts,response,[...this.#pending.values()],u=>this.#old(u),
      u=>telegramRecoveryCoverage(this.#service,p,u.pts,u.pts_count),control=>this.#control(control));
    this.#confirmed=this.#epoch;this.#watermark=result.to_pts;this.#final=result.final===true;return result;
    } catch(error){this.#epoch++;this.#confirmed=null;
      if(['TELEGRAM_MAPPING_INTEGRITY','TELEGRAM_UNSUPPORTED_WATERMARK_ADVANCE'].includes(error.code) && !this.#closed)await this.#invalidate(true);
      throw error;
    }
  }
  confirmCurrent(pts=sourceCheckpoint(this.#service,this.#p.sourceId)?.pts) {return this.#final && this.#owns() && !this.#peerDirty && this.#watermark>=this.#ptsHint && pts===this.#watermark && !this.#closed && !this.#blocked && this.#confirmed!==null && this.#confirmed===this.#epoch
    && ![...this.#pending.values()].some(u=>u.pts>this.#watermark) && this.#rpc.connected();}
  acknowledge(pts) {
    nativeCheck(sourceCheckpoint(this.#service,this.#p.sourceId)?.pts===pts);
    for(const [key,u] of this.#pending)if(u.pts<=pts){nativeCheck(this.#old(u));this.#pending.delete(key);}
  }
  status() {return {buffered:this.#pending.size,blocked:this.#blocked,closed:this.#closed,retry_at:this.#retryAt};}
  fault() {if(this.#closed || !this.#owns())return Promise.resolve();this.#epoch++;this.#confirmed=null;return this.#invalidate(true);}
  close() {if(this.#closing)return this.#closing;this.#closed=true;
    return this.#closing=(async()=>{try{await this.#invalidate();}finally{await this.#rpc.close();}})();}
}
