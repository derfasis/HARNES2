import { GramjsSourceRpc } from './telegram-gramjs-rpc.mjs';
import { TelegramPublicSourceReader } from './telegram-public-reader.mjs';
import { digest } from '../source-ingestion.mjs';
import { telegramRead } from '../telegram-read-gate.mjs';
import { AppError, now } from '../errors.mjs';
import { TelegramScoutRpc } from './telegram-scout-rpc.mjs';
import { Api } from './telegram-gramjs-semantic.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bigInt = require('big-integer');

const START_CURSOR = 'telegram-source-start-v1';
const PEER_RESOLVE_TIMEOUT_MS = 15_000;
const cursorKey = (service, account) => `${service.config.partnerId}:${account}`;
const checkpointKey = (service, sourceId) => digest([service.config.partnerId, sourceId]);

function readCheckpoint(service, sourceId) {
  const row = service.store.get('SELECT cursor FROM channel_offsets WHERE channel=? AND account_id=?',
    'telegram-source-v0', checkpointKey(service, sourceId));
  if (!row) return null;
  let state;
  try { state = JSON.parse(row.cursor); } catch {
    throw new AppError('Telegram source checkpoint is corrupt', 409, 'SOURCE_CHECKPOINT_INVALID');
  }
  const keys = ['source_id','account_id','channel_id','policy_hash','baseline_hash','pts','phase','confirmed_at','reason'];
  if (!state || typeof state !== 'object' || Array.isArray(state)
      || Object.keys(state).length !== keys.length || Object.keys(state).some(key => !keys.includes(key))
      || typeof state.policy_hash !== 'string' || !/^[a-f0-9]{64}$/.test(state.policy_hash)
      || typeof state.baseline_hash !== 'string' || !/^[a-f0-9]{64}$/.test(state.baseline_hash)
      || !Number.isInteger(state.pts) || state.pts < 1 || state.pts > 2147483647
      || !['current','catching_up','blocked'].includes(state.phase)
      || !(state.phase === 'current' ? state.reason === null && typeof state.confirmed_at === 'string'
        && Number.isFinite(Date.parse(state.confirmed_at))
        : state.confirmed_at === null && typeof state.reason === 'string' && state.reason.length > 0))
    throw new AppError('Telegram source checkpoint is corrupt', 409, 'SOURCE_CHECKPOINT_INVALID');
  return state;
}

function readCursor(service, account) {
  const row = service.store.get('SELECT cursor FROM channel_offsets WHERE channel=? AND account_id=?',
    START_CURSOR, cursorKey(service, account));
  if (!row) return null;
  let state;
  try { state = JSON.parse(row.cursor); } catch {
    throw new AppError('Telegram source start cursor is corrupt', 409, 'SOURCE_START_CURSOR_INVALID');
  }
  if (!state || state.version !== 1 || !(state.last_source_id === null || typeof state.last_source_id === 'string'))
    throw new AppError('Telegram source start cursor is corrupt', 409, 'SOURCE_START_CURSOR_INVALID');
  return state.last_source_id;
}

async function saveCursor(service, owner, account, client, generation, sourceId) {
  await service.exclusive(() => service.store.transaction(() => {
    if (owner.stopped || !owner.connected || owner.accountId !== account || owner.client !== client
        || owner.clientGeneration !== generation || client?.connected !== true
        || service.telegramAccountId !== account || service.control.stopped || !service.control.processCurrent())
      throw new AppError('Telegram source owner changed', 409, 'SOURCE_OWNER_CHANGED');
    service.store.run(`INSERT INTO channel_offsets(channel,account_id,cursor) VALUES(?,?,?)
      ON CONFLICT(channel,account_id) DO UPDATE SET cursor=excluded.cursor`,
      START_CURSOR, cursorKey(service, account), JSON.stringify({ version: 1, last_source_id: sourceId, updated_at: now() }));
  }));
}

function afterCursor(policies, lastSourceId) {
  if (!policies.length || !lastSourceId) return policies;
  const index = policies.findIndex(policy => policy.sourceId === lastSourceId);
  if (index < 0) return policies;
  return [...policies.slice(index + 1), ...policies.slice(0, index + 1)];
}

function resolvePeerBeforeDeadline(rpc, channelId) {
  let timer;
  return Promise.race([
    rpc.resolveInputChannel(channelId),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new AppError('Telegram peer metadata read timed out', 504, 'SOURCE_PEER_RESOLVE_TIMEOUT')),
        PEER_RESOLVE_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Desired owner admissions are projected into existing reader policies. No config writes,
// session sharing across clients, joins, or alternate ingestion/checkpoint implementation.
// Each pass starts at most two readers and persists a fair cursor so a failing first source
// cannot starve every source behind it.
export async function reconcileTelegramReaders(owner) {
  if (owner.sourceReconcile) return owner.sourceReconcile;
  const service = owner.service;
  const account = owner.accountId;
  const client = owner.client;
  const generation = owner.clientGeneration;
  const current = () => !owner.stopped && owner.connected && owner.accountId === account
    && owner.client === client && owner.clientGeneration === generation && client?.connected === true
    && !service.control.stopped && service.control.processCurrent();
  if (!current() || !account) return;

  const run = async () => {
    const desired = () => [...(service.config.opportunity?.telegramSources??[]),...(service.scout?.monitorPolicies?.()??[])]
      .filter(policy => policy.accountId === account);
    if (!current()) return;
    const policies = desired();
    const known = new Map(policies.map(policy => [policy.sourceId, policy]));
    const staticSourceIds = new Set((service.config.opportunity?.telegramSources ?? []).map(policy => policy.sourceId));
    const retained = [];
    const quarantined = new Set();
    const checkedCheckpoints = new Map();
    const quarantine = sourceId => {
      quarantined.add(sourceId);
      owner.sourceRegistryFaults ??= new Map();
      owner.sourceRegistryFaults.set(sourceId, 'SOURCE_CHECKPOINT_INVALID');
      owner.lastSourceCode = 'SOURCE_CHECKPOINT_INVALID';
    };
    for (const entry of owner.sourceReaders ?? []) {
      if (!current()) return;
      const policy = known.get(entry.sourceId);
      let checkpoint = null, corrupt = false;
      try { checkpoint = readCheckpoint(service, entry.sourceId); }
      catch {
        corrupt = true;
        quarantine(entry.sourceId);
      }
      if (checkpoint && (typeof checkpoint !== 'object' || Array.isArray(checkpoint)
          || typeof checkpoint.policy_hash !== 'string' || !/^[a-f0-9]{64}$/.test(checkpoint.policy_hash))) {
        corrupt = true;
        quarantine(entry.sourceId);
      }
      checkedCheckpoints.set(entry.sourceId, checkpoint);
      if (corrupt || !policy || entry.transport.ownsSource?.() === false || entry.policyHash !== digest(policy)
          || checkpoint && checkpoint.policy_hash !== digest(policy))
        await entry.transport.close().catch(() => {});
      else retained.push(entry);
    }
    if (!current()) return;
    owner.sourceReaders = retained;

    for (const policy of policies) {
      if (checkedCheckpoints.has(policy.sourceId)) continue;
      try {
        const checkpoint = readCheckpoint(service, policy.sourceId);
        checkedCheckpoints.set(policy.sourceId, checkpoint);
        if (checkpoint && (typeof checkpoint !== 'object' || Array.isArray(checkpoint)
            || typeof checkpoint.policy_hash !== 'string' || !/^[a-f0-9]{64}$/.test(checkpoint.policy_hash)))
          quarantine(policy.sourceId);
      } catch { quarantine(policy.sourceId); }
    }

    const missing = policies.filter(policy => !quarantined.has(policy.sourceId)
      && !owner.sourceReaders.some(reader => reader.sourceId === policy.sourceId));
    const ordered = afterCursor(missing, readCursor(service, account));
    let starts = 0;
    for (const policy of ordered) {
      if (starts >= 2 || !current()) break;
      // The cursor advances before any network wait, including failure/timeout.
      await saveCursor(service, owner, account, client, generation, policy.sourceId);
      if (!current() || !desired().some(item => digest(item) === digest(policy))) break;
      starts++;
      const rpc = new GramjsSourceRpc(client, service, policy.sourceId, { owner });
      let reader = null;
      try {
        const stillDesired = () => current() && desired().some(item => digest(item) === digest(policy));
        let peer;
        if (!staticSourceIds.has(policy.sourceId)) {
          const candidate = service.store.get(`SELECT username FROM scout_candidates
            WHERE account_id=? AND channel_id=? AND joined=1 AND username IS NOT NULL
            ORDER BY updated_at DESC,rowid DESC LIMIT 1`, account, policy.channelId);
          if (!candidate?.username)
            throw new AppError('Scout admitted channel has no public username for restart resolution', 409, 'SCOUT_ACCESS_UNAVAILABLE');
          const scoutRpc = new TelegramScoutRpc(owner, { sourceId: policy.sourceId, priority: 'monitor',
            beforeRead: () => { if (!stillDesired()) throw new AppError('Telegram source admission changed', 409, 'SOURCE_ADMISSION_CHANGED'); } });
          const native = await scoutRpc.resolve({ channel_id: policy.channelId, username: candidate.username });
          if (!stillDesired() || native.channel_id !== policy.channelId || native.joined !== true
              || typeof native.access_hash !== 'string')
            throw new AppError('Scout channel resolution no longer matches its admission', 409, 'SCOUT_ACCESS_UNAVAILABLE');
          peer = new Api.InputChannel({ channelId: bigInt(native.channel_id), accessHash: bigInt(native.access_hash) });
        } else {
          // Static source metadata uses the existing narrow helper. GramJS getEntity may perform
          // network work, so gate it with current policy and owner checks immediately before use.
          peer = await telegramRead(service, { accountId: account, sourceId: policy.sourceId, priority: 'monitor' }, () => {
            if (!stillDesired()) throw new AppError('Telegram source admission changed', 409, 'SOURCE_ADMISSION_CHANGED');
            return resolvePeerBeforeDeadline(rpc, policy.channelId);
          });
        }
        if (!current() || !desired().some(item => digest(item) === digest(policy))) {
          await rpc.close().catch(() => {});
          continue;
        }
        reader = new TelegramPublicSourceReader(service, policy.sourceId, rpc, peer, null, { joinedPeer: true });
        await reader.bootstrap();
        if (!current() || !desired().some(item => digest(item) === digest(policy))) {
          await reader.close().catch(() => {});
          continue;
        }
        owner.sourceReaders.push({ sourceId: policy.sourceId, policyHash: digest(policy), transport: reader });
      } catch (error) {
        if (reader) await reader.close().catch(() => {});
        else await rpc.close().catch(() => {});
        if (current()) owner.lastSourceCode = /^[A-Z][A-Z0-9_]{1,63}$/.test(error?.code ?? '')
          ? error.code : 'SOURCE_READER_BOOTSTRAP_FAILED';
      }
    }
    if (current()) owner.onSourcesReady?.([...(owner.sourceReaders ?? [])]);
  };
  owner.sourceReconcile = run();
  try { return await owner.sourceReconcile; }
  finally { owner.sourceReconcile = null; }
}
