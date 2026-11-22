import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, id } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { readJson, ROOT, loadConfig, validateChannelCycle } from '../business/config.mjs';
import { TelegramChannel } from '../business/channels/telegram.mjs';
import { channelPostLink, channelPostPayload, parseStartPayload } from '../business/telegram-attribution.mjs';
import { exportPartner } from '../business/export.mjs';
import { spawnSync } from 'node:child_process';
import { start } from '../business/server.mjs';
import { callTool, toolDefinitions } from '../business/tools.mjs';

function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-cycle-'));
  const config = readJson(path.join(ROOT, 'config/default.json'));
  Object.assign(config.telegram, { enabled: true, liveSending: true, allowedChatIds: ['42'], pollSeconds: 1 });
  Object.assign(config.telegram.channelCycle, { enabled: true, channelChatId: '-100123', botUsername: 'ExampleBot' });
  const store = new Store(directory), service = new BusinessService(store, config), client = new TelegramChannel(service);
  const before = process.env.PARTNER_TELEGRAM_BOT_TOKEN;
  process.env.PARTNER_TELEGRAM_BOT_TOKEN = '123:invented_offline_token';
  service.setTelegramAccount('123');
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true });
    if (before === undefined) delete process.env.PARTNER_TELEGRAM_BOT_TOKEN; else process.env.PARTNER_TELEGRAM_BOT_TOKEN = before; });
  const command = (action, payload, actor) => service.command(action, payload, id(), actor);
  const create = async (actor) => {
    const postId = id();
    return command('channel_post.create', { post_id: postId, text: `Reviewed question: ${channelPostLink('ExampleBot', postId)}` }, actor);
  };
  const approve = row => command('channel_post.approve', { post_id: row.id, version: row.current_version });
  return { directory, config, store, service, client, command, create, approve };
}

test('deep links and addressed start commands have bounded exact payloads', () => {
  const postId = id(), payload = channelPostPayload(postId);
  assert.equal(channelPostLink('ExampleBot', postId), `https://t.me/ExampleBot?start=${payload}`);
  assert.equal(parseStartPayload(`/start ${payload}`), payload);
  assert.equal(parseStartPayload(`/start@examplebot ${payload}`, 'ExampleBot'), payload);
  for (const text of ['', '/start', '/start ', '/starter abc', '/start abc extra', '/start a+b', '/start ' + 'a'.repeat(65), '/start@OtherBot abc', null])
    assert.equal(parseStartPayload(text, 'ExampleBot'), null);
  assert.throws(() => channelPostLink('@ExampleBot', postId));
  assert.throws(() => channelPostPayload('a'.repeat(65)));
});

test('configuration rejects usernames as destinations, positive ids and invalid caps', () => {
  const cfg = loadConfig({ bytes: '{}' });
  assert.equal(cfg.telegram.channelCycle.enabled, false);
  for (const change of [{ channelChatId: '@channel' }, { channelChatId: '100' }, { channelChatId: '-0' },
    { maxPostsPerDay: 0 }, { maxPostsPerDay: 4 }, { maxPostsPerDay: 1.5 }, { botUsername: '@ExampleBot' }, { enabled: 'true' }]) {
    const invalid = structuredClone(cfg); Object.assign(invalid.telegram.channelCycle, change);
    assert.throws(() => validateChannelCycle(invalid));
    assert.throws(() => loadConfig({ bytes: JSON.stringify(invalid) }));
  }
});

test('the planning agent can propose a channel draft but private agents have no channel tool', async t => {
  const h = harness(t), postId = id();
  assert.ok(toolDefinitions({}).some(tool => tool.name === 'partner_propose_channel_post'));
  assert.equal(toolDefinitions({ conversationId: 'private' }).some(tool => tool.name === 'partner_propose_channel_post'), false);
  const row = await callTool(h.service, {}, 'partner_propose_channel_post',
    { post_id: postId, text: `Question: ${channelPostLink('ExampleBot', postId)}` }, id());
  assert.equal(row.status, 'pending'); assert.equal(row.approved_version, null);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM channel_post_attempts').n, 0);
});

test('draft validation, agent authority and version-bound operator approval', async t => {
  const h = harness(t), row = await h.create({ kind: 'agent' });
  await assert.rejects(h.command('channel_post.approve', { post_id: row.id, version: 1 }, { kind: 'agent' }));
  await assert.rejects(h.command('channel_post.create', { post_id: id(), text: '' }));
  await assert.rejects(h.command('channel_post.create', { post_id: id(), text: 'No link' }));
  await assert.rejects(h.command('channel_post.create', { post_id: id(), text: 'a'.repeat(4097) }));
  await assert.rejects(h.service.channelCycle.send(row.id, h.client));
  await h.approve(row);
  const edited = await h.command('channel_post.edit', { post_id: row.id, version: 1, text: row.text + ' updated' });
  assert.equal(edited.status, 'pending'); assert.equal(edited.approved_version, null);
  await assert.rejects(h.approve(row));
  await assert.rejects(h.service.channelCycle.send(row.id, h.client));
  await h.approve(edited);
  assert.equal(h.service.channelCycle.get(row.id).approved_version, 2);
});

test('every publication gate refuses without a network request or attempt', async t => {
  const h = harness(t), row = await h.create(); await h.approve(row);
  t.mock.method(globalThis, 'fetch', () => { throw Error('Network forbidden'); });
  for (const mutate of [cfg => { cfg.telegram.enabled = false; }, cfg => { cfg.telegram.liveSending = false; },
    cfg => { cfg.telegram.channelCycle.enabled = false; }, cfg => { cfg.telegram.channelCycle.channelChatId = ''; },
    cfg => { cfg.telegram.channelCycle.channelChatId = '-100999'; }, cfg => { cfg.telegram.transport = 'mtproto'; },
    cfg => { cfg.telegram.channelCycle.botUsername = 'OtherBot'; }]) {
    const original = structuredClone(h.config.telegram); mutate(h.config);
    await assert.rejects(h.service.channelCycle.send(row.id, h.client)); h.config.telegram = original;
  }
  h.service.setTelegramAccount('456'); await assert.rejects(h.service.channelCycle.send(row.id, h.client));
  h.service.setTelegramAccount('123');
  h.config.telegram = readJson(path.join(ROOT, 'config/default.json')).telegram;
  await assert.rejects(h.service.channelCycle.send(row.id, h.client));
  assert.equal(h.store.get('SELECT COUNT(*) n FROM channel_post_attempts').n, 0);
});

test('send commits attempt first, enforces cap and never resends a sent post', async t => {
  const h = harness(t), first = await h.create(), second = await h.create();
  await h.approve(first); await h.approve(second);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++; assert.equal(h.store.get("SELECT COUNT(*) n FROM channel_post_attempts WHERE status='sending'").n, 1);
    assert.deepEqual(JSON.parse(options.body), { chat_id: '-100123', text: first.text });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 99 } }) };
  });
  assert.equal((await h.service.channelCycle.send(first.id, h.client)).status, 'sent');
  await assert.rejects(h.service.channelCycle.send(first.id, h.client));
  await assert.rejects(h.service.channelCycle.send(second.id, h.client));
  assert.equal(calls, 1);
  h.store.run("UPDATE channel_post_attempts SET created_at='2026-01-01T00:00:00Z'");
  t.mock.method(h.client, 'api', async () => ({ message_id: 100 }));
  assert.equal((await h.service.channelCycle.send(second.id, h.client)).status, 'sent');
});

test('network ambiguity blocks retry and counts against cap; restart preserves unknown', async t => {
  const h = harness(t), row = await h.create(); await h.approve(row);
  t.mock.method(globalThis, 'fetch', async () => { throw Error('offline network failure'); });
  assert.equal((await h.service.channelCycle.send(row.id, h.client)).status, 'delivery_unknown');
  await assert.rejects(h.service.channelCycle.send(row.id, h.client));
  const next = await h.create(); await h.approve(next);
  await assert.rejects(h.service.channelCycle.send(next.id, h.client));
  h.store.run("UPDATE channel_posts SET status='sending' WHERE id=?", row.id);
  h.store.run("UPDATE channel_post_attempts SET status='sending' WHERE post_id=?", row.id);
  h.store.recover();
  assert.equal(h.service.channelCycle.get(row.id).status, 'delivery_unknown');
  assert.equal(h.store.get('SELECT status FROM channel_post_attempts').status, 'delivery_unknown');
});

test('explicit rejection is failed and needs fresh approval before retry', async t => {
  const h = harness(t), row = await h.create(); await h.approve(row);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, json: async () => ({ ok: false, error_code: 403 }) }));
  assert.equal((await h.service.channelCycle.send(row.id, h.client)).status, 'failed');
  await assert.rejects(h.service.channelCycle.send(row.id, h.client));
  await h.approve(row);
  t.mock.method(h.client, 'api', async () => ({ message_id: 101 }));
  assert.equal((await h.service.channelCycle.send(row.id, h.client)).status, 'sent');
});

test('private allowlist precedes attribution and repeated starts count once', async t => {
  const h = harness(t), post = await h.create();
  const message = (update_id, chatId, text) => ({ update_id, message: { message_id: update_id, date: Math.floor(Date.now()/1000),
    chat: { id: chatId, type: 'private' }, from: { first_name: 'Offline fixture' }, text } });
  const text = `/start ${post.payload}`;
  t.mock.method(h.client, 'api', async () => [message(1, 77, text), message(2, 42, text),
    message(3, 42, `/start@ExampleBot ${post.payload}`), message(4, 42, '/start unknown')]);
  await h.client.poll(); await h.client.poll();
  assert.equal(h.client.lastError, null);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM persons').n, 1);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM messages').n, 3);
  assert.equal(h.store.get('SELECT COUNT(*) n FROM channel_post_starts').n, 1);
  assert.equal(h.service.channelCycle.list()[0].starts, 1);
  assert.equal(h.store.get("SELECT COUNT(*) n FROM channel_identities WHERE external_id='77'").n, 0);
});

test('export/import retains starts and versions but not unsent approval authority', async t => {
  const h = harness(t), post = await h.create(); await h.approve(post);
  const file = path.join(h.directory, 'bundle.json'), destination = path.join(ROOT, `data/channel-cycle-import-${id()}`);
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  fs.writeFileSync(file, JSON.stringify(exportPartner(h.store)));
  const result = spawnSync(process.execPath, ['scripts/import.mjs', file, destination], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const imported = new Store(path.join(destination, 'data'));
  try { assert.equal(imported.get('SELECT status FROM channel_posts').status, 'pending');
    assert.equal(imported.get('SELECT approved_version FROM channel_posts').approved_version, null);
    assert.equal(imported.get('SELECT COUNT(*) n FROM channel_post_versions').n, 1);
  } finally { imported.close(); }
});

test('channel post routes require operator authentication', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-cycle-http-'));
  const config = readJson(path.join(ROOT, 'config/default.json'));
  config.server.port = 0; config.scheduler.enabled = false;
  const app = await start({ config, directory });
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  for (const route of ['create', 'edit', 'approve', 'deliver'])
    assert.equal((await fetch(`${origin}/api/channel-posts/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${origin}/api/channel-posts`)).status, 403);
  const session = await (await fetch(`${origin}/api/session`)).json();
  const response = await fetch(`${origin}/api/channel-posts`, { headers: { 'x-partner-token': session.token } });
  assert.deepEqual(await response.json(), { posts: [] });
});
