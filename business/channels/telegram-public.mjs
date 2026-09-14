import { createRequire } from 'node:module';
import { AppError, ensure } from '../errors.mjs';
import { sourceCheckpoint, digest } from '../source-ingestion.mjs';
import { telegramSourcePolicy, disconnectTelegramSource, telegramRecoveryAuthorization } from '../sources/telegram-readonly.mjs';
import { Api, decimal, nativeCheck } from '../sources/telegram-public-mapper.mjs';
import { TelegramPublicSourceReader,telegramReadDeadline } from '../sources/telegram-public-reader.mjs';
import { MtprotoTelegramChannel } from './telegram-mtproto.mjs';
const require=createRequire(import.meta.url),{TelegramClient}=require('telegram'),{StringSession}=require('telegram/sessions');
const {Logger}=require('telegram/extensions/Logger');
const bigInt=require('big-integer');

export function fencePublicTelegramClient(client,{channelId,username,joinedPeer=false,ingress=()=>{},fault=()=>{}}) {
  const denied=()=>{throw new AppError('Public Telegram write or out-of-scope RPC forbidden',403,'PUBLIC_TELEGRAM_RPC_FORBIDDEN');};
  function allowed(r,depth=0) {
    if(depth>2)return false;
    if(r instanceof Api.InvokeWithLayer || r instanceof Api.InitConnection)return allowed(r.query,depth+1);
    if(r instanceof Api.Ping || r instanceof Api.PingDelayDisconnect || r instanceof Api.MsgsAck || r instanceof Api.MsgsStateInfo
      || r instanceof Api.help.GetConfig || r instanceof Api.updates.GetState)return true;
    if(r instanceof Api.users.GetUsers)return r.id.length===1 && r.id[0] instanceof Api.InputUserSelf;
    if(r instanceof Api.contacts.ResolveUsername)return !joinedPeer && r.username===username;
    if(r instanceof Api.channels.GetChannels)return joinedPeer===true && r.id.length===1
      && r.id[0] instanceof Api.InputChannel && decimal(r.id[0].channelId)===channelId;
    if(r instanceof Api.channels.GetFullChannel || r instanceof Api.updates.GetChannelDifference) {
      return r.channel instanceof Api.InputChannel && decimal(r.channel.channelId)===channelId
        && (!(r instanceof Api.updates.GetChannelDifference) || r.filter instanceof Api.ChannelMessagesFilterEmpty && r.limit===100 && r.force===false);
    }
    return false;
  }
  const checked=r=>{if(client._destroyed || !allowed(r))denied();};
  function wrap(object,key,check) {
    const original=object[key].bind(object);
    Object.defineProperty(object,key,{value:(...args)=>{check(...args);return original(...args);},writable:false,configurable:false});
  }
  wrap(client,'invoke',(request,dc,sender)=>{checked(request);if(dc!==undefined || sender!==undefined)denied();});
  Object.defineProperty(client,'getSender',{value:denied,writable:false,configurable:false});
  Object.defineProperty(client,'_switchDC',{value:denied,writable:false,configurable:false});
  // GramJS initialization/keepalive bypass invoke. Fence the actual sender queue
  // too, including captured RequestState bytes and reconnect retransmissions.
  let current=client._sender;
  let processing=0;
  const protect=sender=>{
    const state=s=>{if(s===undefined)return;checked(s.request);if(!Buffer.from(s.data).equals(s.request.getBytes()))denied();};
    wrap(sender._sendQueue,'append',state);
    const prepend=sender._sendQueue.prepend.bind(sender._sendQueue);
    Object.defineProperty(sender._sendQueue,'prepend',{value:states=>{const batch=[...states];batch.forEach(state);return prepend(batch);},writable:false,configurable:false});
    wrap(sender,'send',checked);wrap(sender,'addStateToQueue',state);
    const dispatch=sender._updateCallback;
    sender._updateCallback=(client,update)=>{ingress(update);return dispatch?.(client,update);};
    const decrypt=sender._state.decryptMessageData.bind(sender._state);
    sender._state.decryptMessageData=async(...args)=>{try{return await decrypt(...args);}catch(error){fault();throw error;}};
    const process=sender._processMessage.bind(sender);
    sender._processMessage=async(message)=>{
      processing++;
      try{message.obj=await message.obj;if(message.obj instanceof Api.NewSessionCreated)ingress(new Api.UpdatesTooLong());
        return await process(message);}finally{processing--;}
    };
    wrap(sender,'_connect',()=>{if(!sender.authKey?.getKey()?.length)denied();});
    return sender;
  };
  if(current)protect(current);
  Object.defineProperty(client,'_sender',{get:()=>current,set:sender=>{current=sender?protect(sender):sender;},configurable:false});
  return ()=>processing===0;
}

// Trusted bootstrap only: use the existing private adapter's credential loader
// and exclusive client slot, never its CRM listener/connect/send methods.
export function openTelegramPublicReader(service,owner,{sourceId,username}) {
  return openTelegramReader(service,owner,{sourceId,username,joinedPeer:false});
}
export function openTelegramJoinedReader(service,owner,{sourceId}) {
  return openTelegramReader(service,owner,{sourceId,username:null,joinedPeer:true});
}
async function openTelegramReader(service,owner,{sourceId,username,joinedPeer}) {
  const p=structuredClone(telegramSourcePolicy(service,sourceId));
  ensure(owner instanceof MtprotoTelegramChannel && owner.service===service && !owner.client && !owner.connected && !owner.stopped,
    'An exclusive existing MTProto connection owner is required',409,'PUBLIC_TELEGRAM_OWNER_BUSY');
  ensure(joinedPeer || typeof username==='string' && /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username),
    'Explicit approved public username required',409,'PUBLIC_TELEGRAM_PEER_REQUIRED');
  ensure(sourceCheckpoint(service,sourceId)?.reason!=='INTEGRITY_RECONCILIATION_REQUIRED' || telegramRecoveryAuthorization(service,p),
    'Source requires operator-authorized reconciliation',409,'PUBLIC_TELEGRAM_RECONCILIATION_REQUIRED');
  const c=owner.credentials();
  ensure(Number.isInteger(c.apiId)&&c.apiId>0&&c.apiHash&&c.session,'Existing MTProto credentials required',409,'PUBLIC_TELEGRAM_CREDENTIALS_REQUIRED');
  let client,listener,failure,connecting,closePromise;let connectionSettled=false;
  let cancelled=false;
  const reservation={disconnect:async()=>{cancelled=true;}};
  const lifecycle=Object.getOwnPropertyDescriptor(owner,'connect');
  const guard=()=>{throw new AppError('Public reader owns this connection',409,'PUBLIC_TELEGRAM_OWNER_BUSY');};
  owner.client=reservation;
  Object.defineProperty(owner,'connect',{value:guard,configurable:true});
  const close=()=>{
    cancelled=true;listener=failure=undefined;
    return closePromise??=(async()=>{
      const pending=connecting && !connectionSettled;
      await client?.destroy();
      // A timed-out connect may still open its socket later. Quarantine its slot
      // until it settles and a second teardown confirms the late socket is closed.
      if(pending){await connecting.catch(()=>{});await client.destroy();}
      nativeCheck(!client?.connected);
      if((owner.client===client || owner.client===reservation) && owner.connect===guard){owner.client=null;
        if(lifecycle)Object.defineProperty(owner,'connect',lifecycle);else delete owner.connect;}
    })();
  };
  const fail=()=>{failure?.().catch(()=>{});};
  const bounded=async operation=>{
    nativeCheck(!cancelled && !owner.stopped);
    const result=await telegramReadDeadline(operation,()=>{cancelled=true;fail();close().catch(()=>{});});
    nativeCheck(!cancelled && !owner.stopped);return result;
  };
  try {
    if(sourceCheckpoint(service,sourceId))await disconnectTelegramSource(service,sourceId);
    nativeCheck(!cancelled && !owner.stopped);
    client=new TelegramClient(new StringSession(c.session),c.apiId,c.apiHash,
      {connectionRetries:1,requestRetries:1,timeout:10,floodSleepThreshold:0,baseLogger:new Logger('none'),deviceModel:'HARNES2 Hermes',systemVersion:'Windows'});
    await client.session.load();
    nativeCheck(!cancelled && !owner.stopped && client.session.getAuthKey()?.getKey()?.length===256);
    owner.client=client;
    client.onError=async()=>fail();
    const settled=fencePublicTelegramClient(client,{channelId:p.channelId,username,joinedPeer,
      ingress:update=>{listener?.(update).catch(fail);},fault:fail});
    await bounded(()=>{connecting=client.connect();connecting.then(()=>{connectionSettled=true;},()=>{connectionSettled=true;});return connecting;});
    const me=await bounded(()=>client.getMe());nativeCheck(decimal(me.id)===p.accountId);
    // The joined-peer lookup returns the real access hash; zero is used only
    // for this scoped metadata query, never as provenance or a difference proof.
    const resolved=await bounded(()=>client.invoke(joinedPeer
      ? new Api.channels.GetChannels({id:[new Api.InputChannel({channelId:bigInt(p.channelId),accessHash:bigInt.zero})]})
      : new Api.contacts.ResolveUsername({username})));
    const entity=resolved.chats.find(c=>c instanceof Api.Channel && decimal(c.id)===p.channelId);
    nativeCheck(entity && !entity.min && !entity.restricted && (entity.broadcast || entity.megagroup) && entity.accessHash!=null
      && (joinedPeer ? !entity.left : resolved.peer instanceof Api.PeerChannel && decimal(resolved.peer.channelId)===p.channelId
        && (entity.username?.toLowerCase()===username.toLowerCase() || entity.usernames?.some(u=>u.active&&u.username.toLowerCase()===username.toLowerCase()))));
    const peer=new Api.InputChannel({channelId:entity.id,accessHash:entity.accessHash});
    nativeCheck(!cancelled && !owner.stopped && digest(telegramSourcePolicy(service,sourceId))===digest(p));
    const rpc=Object.freeze({invokeRead:request=>{nativeCheck(!cancelled && !owner.stopped);return client.invoke(request);},subscribe:(callback,onFault)=>{listener=callback;failure=onFault;},
      connected:()=>!cancelled&&!owner.stopped&&!!client.connected&&!client._sender?.isReconnecting&&settled(),close});
    const reader=new TelegramPublicSourceReader(service,sourceId,rpc,peer,username,{joinedPeer});
    await reader.bootstrap();nativeCheck(!cancelled && !owner.stopped);return reader;
  } catch {
    close().catch(()=>{});
    throw new AppError(`${joinedPeer?'Joined':'Public'} Telegram bootstrap failed; credentials and raw errors withheld`,409,
      joinedPeer?'JOINED_TELEGRAM_BOOTSTRAP_FAILED':'PUBLIC_TELEGRAM_BOOTSTRAP_FAILED');
  }
}
