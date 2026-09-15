import { AppError } from '../errors.mjs';
import { digest } from '../source-ingestion.mjs';
import { normalizeTelegramMessage, TELEGRAM_RECONCILIATION, TELEGRAM_COUNTERLESS, telegramUpdateKey } from './telegram-readonly.mjs';
import { Api, mappingError, nativeCheck, nativeInt, decimal, mapTelegramMessage,
  projectTelegramDelta, sdkContentFingerprint } from './telegram-gramjs-semantic.mjs';
export { Api, mappingError, nativeCheck, nativeInt, decimal, mapTelegramMessage };

// Source/recovery envelope only. Semantic projection lives in the pure SDK bridge;
// strict allowlists below this boundary validate OUR contract, never raw TL fields.
export function mapTelegramControl(p,u) {
  const refresh=u instanceof Api.UpdateChannel || u instanceof Api.UpdateChannelParticipant;
  const hint=u instanceof Api.UpdateChannelTooLong;
  const views=u instanceof Api.UpdateChannelMessageViews,forwards=u instanceof Api.UpdateChannelMessageForwards;
  const typing=u instanceof Api.UpdateChannelUserTyping,read=u instanceof Api.UpdateChannelReadMessagesContents;
  const reactions=u instanceof Api.UpdateMessageReactions;
  if(!refresh && !hint && !views && !forwards && !typing && !read && !reactions)return null;
  nativeCheck(!reactions || u.peer instanceof Api.PeerChannel);
  nativeCheck(decimal(reactions?u.peer.channelId:u.channelId)===p.channelId);
  // PTS is provenance, not an ignorable extension field on a counterless control.
  nativeCheck(u.ptsCount==null && (hint || u.pts==null));
  if(hint)nativeCheck(u.pts==null || nativeInt(u.pts));
  if(views || forwards)nativeCheck(nativeInt(u.id) && Number.isInteger(u.views??u.forwards)
    && (u.views??u.forwards)>=0 && (u.views??u.forwards)<=2147483647);
  if(typing || read)nativeCheck(u.topMsgId==null || nativeInt(u.topMsgId));
  if(typing) {
    nativeCheck(u.fromId instanceof Api.PeerUser || u.fromId instanceof Api.PeerChannel);
    decimal(u.fromId.userId??u.fromId.channelId);
    const Type=Api[u.action?.className];
    nativeCheck(typeof Type==='function' && u.action instanceof Type && /^(SendMessage|SpeakingInGroupCall)/.test(u.action.className));
  }
  if(read)nativeCheck(Array.isArray(u.messages) && u.messages.length<=100 && u.messages.every(nativeInt));
  if(u instanceof Api.UpdateChannelParticipant){decimal(u.actorId);decimal(u.userId);nativeCheck(nativeInt(u.date)
    && Number.isInteger(u.qts) && u.qts>=0 && u.qts<=2147483647);}
  return {kind:hint?'catch_up':refresh?'refresh_peer':'ignore',pts_hint:hint?u.pts??null:null};
}
function normalizationError(error) {return error.code==='TELEGRAM_CLOCK_SKEW' ? error : mappingError();}
export function mapTelegramUpdate(p,u) {
  if(u instanceof Api.UpdateChannelWebPage) {
    nativeCheck(decimal(u.channelId)===p.channelId && nativeInt(u.pts) && nativeInt(u.ptsCount) && u.ptsCount<=u.pts);
    nativeCheck([Api.WebPageEmpty,Api.WebPagePending,Api.WebPage,Api.WebPageNotModified].some(Type=>u.webpage instanceof Type));
    return {kind:'metadata',channel_id:p.channelId,pts:u.pts,pts_count:u.ptsCount,
      metadata_type:'webpage',metadata_fingerprint:sdkContentFingerprint(u.webpage)};
  }
  const kind=u instanceof Api.UpdateNewChannelMessage?'new':u instanceof Api.UpdateEditChannelMessage?'edit'
    :u instanceof Api.UpdateDeleteChannelMessages?'delete':null;
  nativeCheck(kind && nativeInt(u.pts) && (nativeInt(u.ptsCount) || kind!=='new' && u.ptsCount===0) && u.ptsCount<=u.pts);
  if(kind==='delete') {
    nativeCheck(decimal(u.channelId)===p.channelId && Array.isArray(u.messages) && u.messages.length>0
      && u.messages.length<=100 && u.messages.every(nativeInt) && new Set(u.messages).size===u.messages.length);
    return {kind,channel_id:p.channelId,pts:u.pts,pts_count:u.ptsCount,...projectTelegramDelta(kind,u)};
  }
  const projected=projectTelegramDelta(kind,u);
  const message=mapTelegramMessage(p,projected.message);
  nativeCheck(u.ptsCount!==0 || message.edit_date!=null);
  try { normalizeTelegramMessage(p,message,u.pts); } catch(error) {throw normalizationError(error);}
  return {kind,channel_id:p.channelId,pts:u.pts,pts_count:u.ptsCount,message};
}
export function mapChannelDifference(p,fromPts,response,native=[],verifiedOld=()=>false,coveredOld=()=>false,onControl=()=>{}) {
  if(response instanceof Api.updates.ChannelDifferenceTooLong) return {kind:'too_long'};
  nativeCheck(response instanceof Api.updates.ChannelDifference || response instanceof Api.updates.ChannelDifferenceEmpty);
  nativeCheck(nativeInt(fromPts) && nativeInt(response.pts) && response.pts>=fromPts && native.length<=100);
  const messages=response instanceof Api.updates.ChannelDifference ? response.newMessages : [];
  const others=response instanceof Api.updates.ChannelDifference ? response.otherUpdates : [];
  nativeCheck(Array.isArray(messages) && messages.length<=100 && Array.isArray(others) && others.length<=100);
  const byPts=new Map();
  const serverUpdates=[],recovered=[],controls=[];
  for(const u of others) {
    const control=mapTelegramControl(p,u);
    if(control){controls.push(control);onControl(control);}else {
      const mapped=mapTelegramUpdate(p,u);(mapped.pts_count===0?recovered:serverUpdates).push(mapped);
    }
  }
  nativeCheck([...serverUpdates,...recovered].every(u=>u.pts<=response.pts));
  const counterless=new Map();
  for(const u of recovered) {
    const key=telegramUpdateKey(u),old=counterless.get(key);nativeCheck(!old || digest(old)===digest(u));counterless.set(key,u);
  }
  for(const u of native.filter(u=>u.pts_count===0 && u.pts<=response.pts)) {
    const server=counterless.get(telegramUpdateKey(u));nativeCheck(verifiedOld(u) || server && digest(server)===digest(u));
  }
  for(const u of [...native.filter(u=>u.pts_count!==0 && u.pts<=response.pts),...serverUpdates]) {
    if(u.pts<=fromPts) {if(verifiedOld(u))continue;nativeCheck(coveredOld(u));}
    const old=byPts.get(u.pts); nativeCheck(!old || digest(old)===digest(u)); byPts.set(u.pts,u);
  }
  const updates=[...byPts.values()].sort((a,b)=>a.pts-b.pts);
  nativeCheck(updates.length+counterless.size<=100);
  const recoveredCoverage=[...counterless.values()].some(u=>u.pts>fromPts);
  let cursor=fromPts;
  for(const u of updates.filter(u=>u.pts>fromPts)) {
    nativeCheck(u.pts-u.pts_count>=cursor);
    if(!messages.length && !recoveredCoverage)nativeCheck(u.pts-u.pts_count===cursor);cursor=u.pts;
  }
  // An Empty response whose pts exceeds the cursor is the server's attestation
  // that the interval carries no supported content; its pts becomes the cursor.
  const emptyAdvance=response instanceof Api.updates.ChannelDifferenceEmpty && response.pts>fromPts;
  if(!messages.length && cursor!==response.pts && !emptyAdvance
    && ![...counterless.values()].some(u=>u.pts===response.pts && u.pts>fromPts))
    throw new AppError('Unaccounted channel watermark advance',409,'TELEGRAM_UNSUPPORTED_WATERMARK_ADVANCE');
  const snapshots=[],ids=new Set();
  // Telegram supplies one channel watermark for Message snapshots. Never assign
  // that watermark (or guessed increments) as an individual event's PTS.
  for(const m of messages) {
    const wire=mapTelegramMessage(p,m),latest=[...updates,...counterless.values()].sort((a,b)=>a.pts-b.pts)
      .filter(u=>u.message?.id===wire.id || u.message_ids?.includes(wire.id)).at(-1);
    try{normalizeTelegramMessage(p,wire,1);}catch(error){throw normalizationError(error);}
    nativeCheck(!ids.has(wire.id));ids.add(wire.id);
    nativeCheck(!latest || latest.pts<=fromPts || latest.message && digest(latest.message)===digest(wire));
    snapshots.push(wire);
  }
  return {contract_version:counterless.size?TELEGRAM_COUNTERLESS:TELEGRAM_RECONCILIATION,kind:response instanceof Api.updates.ChannelDifference?'difference':'empty',
    account_id:p.accountId,channel_id:p.channelId,from_pts:fromPts,to_pts:response.pts,updates,snapshots,
    ...(counterless.size?{recovered_updates:[...counterless.values()].sort((a,b)=>telegramUpdateKey(a).localeCompare(telegramUpdateKey(b)))}:{}),
    response_fingerprint:digest({constructor:response.className,pts:response.pts,final:response.final===true,
      ...(counterless.size?{recovered_updates:[...counterless.values()].sort((a,b)=>telegramUpdateKey(a).localeCompare(telegramUpdateKey(b)))}:{}),
      snapshots:[...snapshots].sort((a,b)=>a.id-b.id),updates:[...new Map(serverUpdates.map(u=>[u.pts,u])).values()].sort((a,b)=>a.pts-b.pts),controls}),final:response.final===true};
}
