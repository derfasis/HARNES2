// Black-box tests for the bounded per-peer messages.Search adapter. SDK objects
// are constructed locally; these tests never open a Telegram connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { TelegramScoutRpc } from '../business/sources/telegram-scout-rpc.mjs';
import { Api } from '../business/sources/telegram-gramjs-semantic.mjs';
import { ACCOUNT, scoutHarness } from './scout-test-helpers.mjs';

const require=createRequire(import.meta.url),bigInt=require('big-integer');
const CHANNEL='123456789',HASH='998877665544',USERNAME='sample_channel';
const FROM='2026-10-01T00:00:00.000Z',UNTIL='2026-10-15T00:00:00.000Z';
const peer=id=>new Api.PeerChannel({channelId:bigInt(id)});
const native=(id,text,date,extra={})=>new Api.Message({id,peerId:peer(CHANNEL),fromId:new Api.PeerUser({userId:bigInt(41)}),
  message:text,date:Math.floor(Date.parse(date)/1000),media:new Api.MessageMediaEmpty(),...extra});
function owner(invoke,extra={}){
  const client={connected:true,invoke,get addEventHandler(){return undefined;}};
  return {client,accountId:ACCOUNT,connected:true,stopped:false,clientGeneration:1,...extra};
}

test('messageSearch issues one exact per-peer Api.messages.Search and projects a bounded native page',async()=>{
  const requests=[],inside=native(20,'A bounded literal supplier request.', '2026-10-12T10:00:00.000Z',{
    futureOrdinaryField:{ignored:true},replyTo:new Api.MessageReplyHeader({replyToMsgId:8}),
  });
  const outside=native(19,'Outside requested window.','2026-09-30T23:59:59.000Z');
  const sdk=owner(async request=>{requests.push(request);return new Api.messages.Messages({messages:[inside,outside],chats:[],users:[]});});
  const rpc=new TelegramScoutRpc(sdk);
  const result=await rpc.messageSearch({channel_id:CHANNEL,access_hash:HASH,username:USERNAME,query:'поставщика',from_date:FROM,until_date:UNTIL,limit:10});
  assert.equal(requests.length,1);assert.ok(requests[0] instanceof Api.messages.Search);
  assert.ok(requests[0].peer instanceof Api.InputPeerChannel);assert.equal(requests[0].peer.channelId.toString(),CHANNEL);
  assert.equal(requests[0].peer.accessHash.toString(),HASH);assert.equal(requests[0].q,'поставщика');
  assert.ok(requests[0].filter instanceof Api.InputMessagesFilterEmpty);
  assert.equal(requests[0].minDate,Math.floor(Date.parse(FROM)/1000));assert.equal(requests[0].maxDate,Math.floor(Date.parse(UNTIL)/1000));
  assert.equal(requests[0].limit,10);assert.equal(requests[0].offsetId,0);assert.equal(requests[0].hash.toString(),'0');
  assert.deepEqual(result,{messages:[{message_id:'20',author_ref:'user:41',date:'2026-10-12T10:00:00.000Z',
    edit_date:null,text:'A bounded literal supplier request.',reply_to:'8',reply_to_source:null,unsupported:null,
    content_hash:result.messages[0].content_hash,link:'https://t.me/sample_channel/20'}],requested_count:10,received_count:2,
    omitted_count:1,truncated:false,selection_kind:'message_query_v1',exhaustive:false});
  assert.match(result.messages[0].content_hash,/^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes(HASH),false);
  assert.equal(JSON.stringify(result).includes('futureOrdinaryField'),false);
});

test('messageSearch rejects unpinned peer/query/window/limit and malformed native responses before accepting hits',async()=>{
  let calls=0;const rpc=new TelegramScoutRpc(owner(async request=>{calls++;return new Api.messages.Messages({messages:[],chats:[],users:[]});}));
  const valid={channel_id:CHANNEL,access_hash:HASH,username:USERNAME,query:' supplier ',from_date:FROM,until_date:UNTIL,limit:10};
  for(const patch of [
    {channel_id:null},{access_hash:null},{username:null},{username:'bad-name'},{query:'   '},{query:'x'.repeat(201)},
    {from_date:'2026-09-01T00:00:00.000Z'},{from_date:'not-a-date'},
    {from_date:new Date(Date.now()-86400000).toISOString(),until_date:new Date(Date.now()+86400000).toISOString()},
    {until_date:FROM},{limit:0},{limit:101},
  ]) await assert.rejects(rpc.messageSearch({...valid,...patch}));
  assert.equal(calls,0);
  const wrongPeer=new Api.Message({id:1,peerId:peer('987654321'),message:'wrong peer',date:1791302400});
  const wrongRpc=new TelegramScoutRpc(owner(async()=>new Api.messages.Messages({messages:[wrongPeer],chats:[],users:[]})));
  await assert.rejects(wrongRpc.messageSearch(valid));
  const overflowRpc=new TelegramScoutRpc(owner(async()=>new Api.messages.Messages({messages:Array.from({length:11},(_,i)=>native(i+1,'x','2026-10-12T00:00:00.000Z')),chats:[],users:[]})));
  await assert.rejects(overflowRpc.messageSearch({...valid,limit:10}));
  const malformedDate=native(3,'missing date','2026-10-12T00:00:00.000Z');malformedDate.date=null;
  const malformedRpc=new TelegramScoutRpc(owner(async()=>new Api.messages.Messages({messages:[malformedDate],chats:[],users:[]})));
  await assert.rejects(malformedRpc.messageSearch(valid));
});

test('messageSearch keeps unsupported messages opaque and marks a full page as capped',async()=>{
  const quote=native(21,'quoted text is not an attributable request','2026-10-12T10:00:00.000Z',{
    replyTo:new Api.MessageReplyHeader({replyToMsgId:7,quote:true,quoteText:'quoted text'}),
    entities:[new Api.MessageEntityBlockquote({offset:0,length:6})],
  });
  const sdk=owner(async()=>new Api.messages.Messages({messages:[quote],chats:[],users:[]}));
  const rpc=new TelegramScoutRpc(sdk);
  const result=await rpc.messageSearch({channel_id:CHANNEL,access_hash:HASH,username:USERNAME,query:'request',from_date:FROM,until_date:UNTIL,limit:1});
  assert.equal(result.messages[0].text,null);assert.equal(result.messages[0].unsupported,'reply_or_quote');
  assert.equal(result.received_count,1);assert.equal(result.truncated,true);assert.equal(result.exhaustive,false);
});

test('messageSearch preserves edit clocks and cross-peer reply provenance without treating reply text as body',async()=>{
  const reply=native(22,'reply body','2026-10-13T10:00:00.000Z',{
    editDate:Math.floor(Date.parse('2026-10-14T10:00:00.000Z')/1000),
    replyTo:new Api.MessageReplyHeader({replyToMsgId:4,replyToPeerId:new Api.PeerChannel({channelId:bigInt('987654321')})}),
  });
  const rpc=new TelegramScoutRpc(owner(async()=>new Api.messages.Messages({messages:[reply],chats:[],users:[]})));
  const result=await rpc.messageSearch({channel_id:CHANNEL,access_hash:HASH,username:USERNAME,query:'reply',from_date:FROM,until_date:UNTIL});
  assert.deepEqual({date:result.messages[0].date,edit_date:result.messages[0].edit_date,reply_to:result.messages[0].reply_to,
    reply_to_source:result.messages[0].reply_to_source,text:result.messages[0].text},
  {date:'2026-10-13T10:00:00.000Z',edit_date:'2026-10-14T10:00:00.000Z',reply_to:'4',
    reply_to_source:'telegram:channel:987654321',text:'reply body'});
});

test('messageSearch inherits account FLOOD_WAIT persistence and refuses a replaced client generation',async t=>{
  const h=scoutHarness(t);let count=0;
  const serviceOwner=Object.assign(h.owner,{service:h.service,accountId:ACCOUNT,clientGeneration:1,client:{connected:true,invoke:async()=>{
    count++;throw Object.assign(new Error('FLOOD_WAIT_90'),{seconds:90});
  }}});
  const rpc=new TelegramScoutRpc(serviceOwner);
  await assert.rejects(rpc.messageSearch({channel_id:CHANNEL,access_hash:HASH,username:USERNAME,query:'need',from_date:FROM,until_date:UNTIL}),{code:'SCOUT_FLOOD_WAIT'});
  const accountKey=`${h.config.partnerId}:${ACCOUNT}`,row=h.store.get('SELECT cursor FROM channel_offsets WHERE channel=? AND account_id=?','telegram-account-read-v1',accountKey);
  assert.ok(Date.parse(JSON.parse(row.cursor).retry_at)>=Date.now()+89000);assert.equal(count,1);

  let release,entered;const pending=new Promise(resolve=>{release=resolve;}),inside=new Promise(resolve=>{entered=resolve;});
  const mutable=owner(async()=>{entered();await pending;return new Api.messages.Messages({messages:[],chats:[],users:[]});});
  const generationRpc=new TelegramScoutRpc(mutable),request=generationRpc.messageSearch({channel_id:CHANNEL,access_hash:HASH,username:USERNAME,query:'need',from_date:FROM,until_date:UNTIL});
  await inside;mutable.client={connected:true,invoke:async()=>new Api.messages.Messages({messages:[],chats:[],users:[]})};mutable.clientGeneration++;
  release();await assert.rejects(request,{code:'SCOUT_DISCONNECTED'});
});
