import { createRequire } from 'node:module';
import { AppError } from '../errors.mjs';
import { digest } from '../source-ingestion.mjs';
import { normalizeTelegramMessage } from './telegram-readonly.mjs';

export const { Api } = createRequire(import.meta.url)('telegram');
export const mappingError = () => new AppError('Raw Telegram delta lacks supported native evidence',409,'TELEGRAM_MAPPING_INTEGRITY');
export const nativeCheck = ok => { if(!ok) throw mappingError(); };
export const nativeInt = n => Number.isInteger(n) && n>0 && n<=2147483647;
export function decimal(value) {
  nativeCheck(value!=null && typeof value!=='number');
  const id=value.toString(); nativeCheck(/^[1-9][0-9]{0,18}$/.test(id)); return id;
}
function noExtra(value, allowed) {
  // Inspect hydrated TL fields as well as constructor args: never strip unsupported
  // semantic content, including quotes/forwards/TTL, to make a page appear supported.
  for(const key of new Set([...Object.keys(value),...Object.keys(value.originalArgs??{})])) {
    if(key.startsWith('_') || ['CONSTRUCTOR_ID','SUBCLASS_OF_ID','className','classType','originalArgs','flags','flags2'].includes(key)) continue;
    const content=value[key]??value.originalArgs?.[key];
    nativeCheck(allowed.includes(key) || content==null || content===false);
  }
}
export function mapTelegramMessage(p,m) {
  nativeCheck(m instanceof Api.Message && m.peerId instanceof Api.PeerChannel && decimal(m.peerId.channelId)===p.channelId);
  noExtra(m,['id','peerId','fromId','post','message','date','editDate','replyTo','out',
    'mentioned','mediaUnread','silent','legacy','editHide','pinned','views','forwards','replies','reactions','entities']);
  nativeCheck(!m.out && (m.entities==null || Array.isArray(m.entities)&&m.entities.length===0));
  let author=null;
  if(m.fromId!=null) {
    nativeCheck(m.fromId instanceof Api.PeerUser || m.fromId instanceof Api.PeerChannel);
    author=m.fromId instanceof Api.PeerUser ? {kind:'user',id:decimal(m.fromId.userId)} : {kind:'channel',id:decimal(m.fromId.channelId)};
  }
  const r=m.replyTo;
  if(r!=null) {
    nativeCheck(r instanceof Api.MessageReplyHeader);
    noExtra(r,['replyToMsgId','replyToTopId','replyToPeerId','forumTopic']);
    nativeCheck(!r.forumTopic || nativeInt(r.replyToTopId));
    nativeCheck(r.replyToPeerId==null || r.replyToPeerId instanceof Api.PeerChannel);
  }
  return {id:m.id,channel_id:p.channelId,from_id:author,post:m.post===true,text:m.message,
    date:m.date,edit_date:m.editDate??null,reply_to_msg_id:r?.replyToMsgId??null,
    reply_to_top_id:r?.replyToTopId??null,reply_to_channel_id:r?.replyToPeerId ? decimal(r.replyToPeerId.channelId) : null};
}
export function mapTelegramUpdate(p,u) {
  const kind=u instanceof Api.UpdateNewChannelMessage?'new':u instanceof Api.UpdateEditChannelMessage?'edit'
    :u instanceof Api.UpdateDeleteChannelMessages?'delete':null;
  nativeCheck(kind && nativeInt(u.pts) && nativeInt(u.ptsCount));
  noExtra(u,kind==='delete'?['channelId','pts','ptsCount','messages']:['message','pts','ptsCount']);
  if(kind==='delete') {
    nativeCheck(decimal(u.channelId)===p.channelId && Array.isArray(u.messages) && u.messages.length>0
      && u.messages.length<=100 && u.messages.every(nativeInt) && new Set(u.messages).size===u.messages.length);
    return {kind,channel_id:p.channelId,pts:u.pts,pts_count:u.ptsCount,message_ids:[...u.messages]};
  }
  const message=mapTelegramMessage(p,u.message);
  try { normalizeTelegramMessage(p,message,u.pts); } catch {throw mappingError();}
  return {kind,channel_id:p.channelId,pts:u.pts,pts_count:u.ptsCount,message};
}
export function mapChannelDifference(p,fromPts,response,native=[],verifiedOld=()=>false) {
  if(response instanceof Api.updates.ChannelDifferenceTooLong) return {kind:'too_long'};
  nativeCheck(response instanceof Api.updates.ChannelDifference || response instanceof Api.updates.ChannelDifferenceEmpty);
  nativeCheck(nativeInt(fromPts) && nativeInt(response.pts) && response.pts>=fromPts && native.length<=100);
  const messages=response instanceof Api.updates.ChannelDifference ? response.newMessages : [];
  const others=response instanceof Api.updates.ChannelDifference ? response.otherUpdates : [];
  nativeCheck(Array.isArray(messages) && messages.length<=100 && Array.isArray(others) && others.length<=100);
  const byPts=new Map();
  for(const u of [...native.filter(u=>u.pts<=response.pts),...others.map(u=>mapTelegramUpdate(p,u))]) {
    if(u.pts<=fromPts) {nativeCheck(verifiedOld(u));continue;}
    const old=byPts.get(u.pts); nativeCheck(!old || digest(old)===digest(u)); byPts.set(u.pts,u);
  }
  const updates=[...byPts.values()].sort((a,b)=>a.pts-b.pts);
  nativeCheck(updates.length<=100);
  let cursor=fromPts;
  for(const u of updates) {nativeCheck(u.pts-u.pts_count===cursor);cursor=u.pts;}
  nativeCheck(cursor===response.pts);
  // newMessages are snapshots with NO per-message pts. Accept only exact current
  // snapshots backed by actual native upserts in this fully accounted pts interval.
  for(const m of messages) {
    const wire=mapTelegramMessage(p,m),latest=updates.filter(u=>u.message?.id===wire.id || u.message_ids?.includes(wire.id)).at(-1);
    nativeCheck(latest?.message && digest(latest.message)===digest(wire));
  }
  return {kind:updates.length?'difference':'empty',account_id:p.accountId,channel_id:p.channelId,
    from_pts:fromPts,to_pts:cursor,updates,final:response.final===true && !native.some(u=>u.pts>cursor)};
}
