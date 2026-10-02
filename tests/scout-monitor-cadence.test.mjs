import test from 'node:test';
import assert from 'node:assert/strict';
import { dueTelegramSources, TELEGRAM_MONITOR_INTERVAL_MS } from '../business/telegram-monitoring.mjs';
import { digest } from '../business/source-ingestion.mjs';
import { ACCOUNT, scoutHarness } from './scout-test-helpers.mjs';

const START=Date.now();
function policies(h, lags) {
  const refs=lags.map((_,i)=>`telegram:channel:${1000+i}`);
  h.config.opportunity.allowedSourceRefs=refs;
  h.config.opportunity.telegramSources=refs.map((sourceId,i)=>({sourceId,accountId:ACCOUNT,channelId:String(1000+i),
    sourceKind:'live_snapshot',processingBasis:`Synthetic cadence source ${i}`,maxLagSeconds:lags[i]}));
  return refs.map(sourceId=>({sourceId}));
}
function advance(t,h,milliseconds){
  while(milliseconds>0){const step=Math.min(milliseconds,20000);t.mock.timers.tick(step);h.service.control.heartbeat();milliseconds-=step;}
}

test('60-second freshness tolerance schedules a 30-second nominal polling target',t=>{
  t.mock.timers.enable({apis:['Date'],now:START});
  const h=scoutHarness(t), readers=policies(h,[60]);
  assert.deepEqual(dueTelegramSources(h.service,readers).map(x=>x.sourceId),[readers[0].sourceId]);
  assert.deepEqual(dueTelegramSources(h.service,readers),[]);
  advance(t,h,29999); assert.deepEqual(dueTelegramSources(h.service,readers),[]);
  t.mock.timers.tick(1); assert.deepEqual(dueTelegramSources(h.service,readers).map(x=>x.sourceId),[readers[0].sourceId]);
  assert.equal(TELEGRAM_MONITOR_INTERVAL_MS,120000);
});

test('default 300-second tolerance keeps the capped 120-second target and portfolio turns rotate fairly',t=>{
  t.mock.timers.enable({apis:['Date'],now:START});
  const h=scoutHarness(t), readers=policies(h,[300]);
  assert.deepEqual(dueTelegramSources(h.service,readers).map(x=>x.sourceId),[readers[0].sourceId]);
  advance(t,h,119999); assert.deepEqual(dueTelegramSources(h.service,readers),[]);
  t.mock.timers.tick(1); assert.deepEqual(dueTelegramSources(h.service,readers).map(x=>x.sourceId),[readers[0].sourceId]);

  const h2=scoutHarness(t), portfolio=policies(h2,[300,300,300]);
  const first=dueTelegramSources(h2.service,portfolio).map(x=>x.sourceId);
  assert.equal(first.length,2);
  const next=dueTelegramSources(h2.service,portfolio).map(x=>x.sourceId);
  assert.equal(next.length,1);
  assert.ok(next.some(sourceId=>!first.includes(sourceId)),'a source not selected on the previous pass gets a fair turn');
  assert.equal(new Set([...first,...next]).size,3);
});

test('waiting for exhausted read budget never advances source confirmation or records a fake fresh poll',t=>{
  t.mock.timers.enable({apis:['Date'],now:START});
  const h=scoutHarness(t), readers=policies(h,[60]), sourceId=readers[0].sourceId;
  const oldConfirmedAt=new Date(START-61000).toISOString();
  const checkpointAccount=digest([h.config.partnerId,sourceId]);
  const checkpoint={source_id:sourceId,phase:'current',confirmed_at:oldConfirmedAt,pts:22};
  h.store.run('INSERT INTO channel_offsets(channel,account_id,cursor) VALUES(?,?,?)','telegram-source-v0',checkpointAccount,JSON.stringify(checkpoint));
  const readAccount=`${h.config.partnerId}:${ACCOUNT}`;
  const readBudget={day:new Date(START).toISOString().slice(0,10),requests:h.config.scout.maxRequestsPerDay,audit_requests:0,sources:{[sourceId]:0},retry_at:null};
  h.store.run('INSERT INTO channel_offsets(channel,account_id,cursor) VALUES(?,?,?)','telegram-account-read-v1',readAccount,JSON.stringify(readBudget));

  assert.deepEqual(dueTelegramSources(h.service,readers),[]);
  advance(t,h,60000); assert.deepEqual(dueTelegramSources(h.service,readers),[]);
  const after=h.store.get("SELECT cursor FROM channel_offsets WHERE channel='telegram-source-v0' AND account_id=?",checkpointAccount).cursor;
  assert.deepEqual(JSON.parse(after),checkpoint);
  const attempts=JSON.parse(h.store.get("SELECT cursor FROM channel_offsets WHERE channel='scout-monitor-v1' AND account_id=?",readAccount).cursor);
  assert.deepEqual(attempts.attempts,{});
});
