// Pure bridge over the pinned GramJS SDK. No client, IO, TL schema clone or
// inspection of originalArgs: GramJS owns decoding and custom Message accessors.
import { createRequire } from 'node:module';
import { AppError } from '../errors.mjs';
import { digest } from '../source-ingestion.mjs';
import { hash } from '../store.mjs';

const require = createRequire(import.meta.url);
export const { Api } = require('telegram');
const { NewMessage } = require('telegram/events/NewMessage');
const { EditedMessage } = require('telegram/events/EditedMessage');
const { DeletedMessage } = require('telegram/events/DeletedMessage');
const builders = { new: new NewMessage({}), edit: new EditedMessage({}), delete: new DeletedMessage({}) };
export const mappingError = () => new AppError('Telegram delta lacks valid scope or recovery evidence',409,'TELEGRAM_MAPPING_INTEGRITY');
export const nativeCheck = ok => { if(!ok) throw mappingError(); };
export const nativeInt = n => Number.isInteger(n) && n>0 && n<=2147483647;
export function decimal(value) {
  nativeCheck(value!=null && typeof value!=='number');
  const id=value.toString(); nativeCheck(/^[1-9][0-9]{0,18}$/.test(id)); return id;
}
export function sdkContentFingerprint(value) {
  // Existing webpage-only transport receipt; its bytes never become evidence.
  let bytes;try { bytes=value.getBytes(); } catch { throw mappingError(); }
  nativeCheck(bytes.length<=1000000);return hash(bytes);
}
export function projectTelegramDelta(kind, update) {
  let event;try { event=builders[kind].build(update); } catch { throw mappingError(); }
  if(kind==='delete') {nativeCheck(event);return {message_ids:[...event.deletedIds]};}
  // GramJS intentionally excludes service messages from New/EditedMessage.
  const message=event?.message ?? (update.message instanceof Api.MessageService ? update.message : null);
  nativeCheck(message);return {message};
}
export function mapTelegramMessage(p,m) {
  nativeCheck((m instanceof Api.Message || m instanceof Api.MessageService)
    && m.peerId instanceof Api.PeerChannel && decimal(m.peerId.channelId)===p.channelId);
  let author=null;
  if(m.fromId!=null) {
    nativeCheck(m.fromId instanceof Api.PeerUser || m.fromId instanceof Api.PeerChannel);
    author=m.fromId instanceof Api.PeerUser ? {kind:'user',id:decimal(m.fromId.userId)} : {kind:'channel',id:decimal(m.fromId.channelId)};
  }
  const r=m.replyTo, text=m.rawText;
  nativeCheck(typeof text==='string' && text.length<=16000);
  // These actions invalidate more than this message. Keep the source blocked
  // until there is an explicit retention/migration recovery implementation.
  nativeCheck(![Api.MessageActionHistoryClear,Api.MessageActionChannelMigrateFrom,
    Api.MessageActionChatMigrateTo,Api.MessageActionSetMessagesTTL].some(Type=>m.action instanceof Type));
  const ordinaryReply=r==null || r instanceof Api.MessageReplyHeader
    && (r.replyToPeerId==null || r.replyToPeerId instanceof Api.PeerChannel)
    && (!r.forumTopic || nativeInt(r.replyToTopId));
  const quoted=r && (r.quote || r.quoteText!=null || r.quoteEntities?.length || r.replyFrom || r.replyMedia || r.replyToScheduled);
  const reason=m instanceof Api.MessageService ? 'service'
    :m.out ? 'outgoing'
    :m.ttlPeriod || m.noforwards || m.restrictionReason?.length ? 'restricted'
    :m.fwdFrom || m.viaBotId || m.post && author && (author.kind!=='channel' || author.id!==p.channelId) ? 'attribution'
    :!ordinaryReply || quoted || m.entities?.some(e=>e instanceof Api.MessageEntityBlockquote) ? 'reply_or_quote'
    :m.media && !(m.media instanceof Api.MessageMediaEmpty || m.media instanceof Api.MessageMediaWebPage) ? 'media'
    :m.replyMarkup ? 'interactive'
    :!text.trim() ? 'empty' : null;
  const message={id:m.id,channel_id:p.channelId,from_id:author,post:m.post===true,text:reason?null:text,
    date:m.date,edit_date:m.editDate??null,reply_to_msg_id:ordinaryReply?m.replyToMsgId??null:null,
    reply_to_top_id:ordinaryReply?r?.replyToTopId??null:null,
    reply_to_channel_id:ordinaryReply && r?.replyToPeerId ? decimal(r.replyToPeerId.channelId) : null};
  // Identity of the opaque PROJECTION, not a promise to retain/interpret binary
  // content. SDK photo/document getters provide stable asset identity without
  // traversing TL internals. File references, views and reactions may change
  // without a material edit and must not poison dedupe or snapshot reconciliation.
  if(reason)message.unsupported={reason,fingerprint:digest({text,message_type:m.className,
    media_type:m.media?.className??null,action_type:m.action?.className??null,
    asset_id:reason==='media'?(m.photo?.id??m.document?.id)?.toString()??null:null,
    forwarded:!!m.fwdFrom,quoted:!!quoted,interactive:!!m.replyMarkup,
    out:m.out===true,via_bot_id:m.viaBotId?.toString()??null,ttl_period:m.ttlPeriod??null,
    protected:m.noforwards===true,restricted:!!m.restrictionReason?.length})};
  return message;
}
