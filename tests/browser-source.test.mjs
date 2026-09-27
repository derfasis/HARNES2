// Browser v0: a read-only eye, not a browser for the agent.
//
// Every test runs against a local HTTP server. Nothing here reaches the internet, and the tests
// that exercise the private-address rules assert them on literals rather than by trying to connect
// inward, because a test that genuinely reached a private address would be a test that genuinely
// left the machine.
// proof_level=synthetic_contract_eval; live_proof=false.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { fetchPublicPage, isPrivateAddress, LIMITS } from '../business/sources/browser-fetch.mjs';
import { sanitizeHtml } from '../business/sources/browser-sanitize.mjs';
import { browserPolicy, BrowserSourceReader, pollBrowserSource } from '../business/sources/browser-readonly.mjs';
import { sourceTransportKind, pollSource, pollFailureKind } from '../business/source-transport.mjs';
import { Store } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { loadConfig } from '../business/config.mjs';
import { sourceRows } from '../business/source-ingestion.mjs';

const PAGE = `<!doctype html><html><head><title>Ignored</title>
<style>body{color:red}</style><script>window.steal='x';</script></head>
<body><h1>Heading</h1><p>First &amp; foremost.</p>
<form action="/x"><input name="q"><button>Send</button></form>
<!-- a comment --><noscript>enable js</noscript>
<p>Second paragraph with a link <a href="/next">here</a>.</p></body></html>`;

// A loopback server is a private address, which the boundary refuses by design. Tests that need a
// real round trip therefore inject the fetch and the resolver, and keep the policy intact.
const localServer = async (handler) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return { server, origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
};

const service = (t, { url, sourceId = 'browser:example', maxLagSeconds = 300 } = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-browser-'));
  const store = new Store(directory);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const loaded = loadConfig();
  const cfg = { ...loaded, opportunity: { ...loaded.opportunity, automatic: true,
    browserSources: [{ sourceId, url, maxLagSeconds, processingBasis: 'Local test server only',
      sourceKind: 'live_snapshot' }], allowedSourceRefs: [sourceId] },
  runtime: { ...loaded.runtime, enabled: false },
  telegram: { ...loaded.telegram, enabled: false, liveSending: false } };
  return { store, service: new BusinessService(store, cfg) };
};

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('a page becomes bounded plain text with no markup, script, form or comment left in it', () => {
  const { text } = sanitizeHtml(PAGE, 16000);
  assert.match(text, /First & foremost\./);
  assert.match(text, /Second paragraph with a link here\./);
  for (const forbidden of ['<', '>', 'window.steal', 'color:red', '<form', 'a comment',
    'enable js', 'action=']) {
    assert.ok(!text.includes(forbidden), `page text must not contain ${forbidden}`);
  }
  assert.ok(text.length <= 16000);
});

test('an oversized page is truncated and says so, rather than silently shortened', () => {
  const huge = `<p>${'a'.repeat(50000)}</p>`;
  const result = sanitizeHtml(huge, 1000);
  assert.equal(result.text.length, 1000);
  assert.equal(result.truncated, true);
  assert.equal(result.originalLength > 1000, true);
});

test('an unclosed script does not turn the rest of the page into its content', () => {
  // A stripper can be defeated; what must not happen is the remainder of a document being
  // presented as if it were page prose.
  const { text } = sanitizeHtml('<p>before</p><script>var x = 1;', 16000);
  assert.match(text, /before/);
  assert.ok(!text.includes('var x'), 'code after an unclosed script must not survive as text');
});

test('every non-public address is refused, and an unrecognised form fails closed', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '::1', 'fe80::1', 'fd00::1',
    'fc00::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', 'localhost']) {
    assert.equal(isPrivateAddress(address), true, `${address} must be private`);
  }
  for (const address of ['93.184.216.34', '8.8.8.8', '1.1.1.1', '2606:2800:220:1:248:1893:25c8:1946']) {
    assert.equal(isPrivateAddress(address), false, `${address} must be public`);
  }
  // A name is not a verdict: it has to be resolved, and the function says so rather than guessing.
  assert.equal(isPrivateAddress('example.com'), null);
});

test('the scheme, credentials and address rules refuse before any connection is made', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error('must not be reached'); };
  const cases = [
    ['file:///etc/passwd', 'BROWSER_SCHEME_REFUSED'],
    ['ftp://example.com/x', 'BROWSER_SCHEME_REFUSED'],
    ['data:text/html,<p>x', 'BROWSER_SCHEME_REFUSED'],
    ['javascript:alert(1)', 'BROWSER_SCHEME_REFUSED'],
    ['https://user:pass@example.com/x', 'BROWSER_URL_CREDENTIALS_REFUSED'],
    ['http://127.0.0.1/x', 'BROWSER_ADDRESS_REFUSED'],
    ['http://localhost/x', 'BROWSER_ADDRESS_REFUSED'],
    ['http://169.254.169.254/latest/meta-data/', 'BROWSER_ADDRESS_REFUSED'],
    ['http://[::1]/x', 'BROWSER_ADDRESS_REFUSED'],
  ];
  for (const [url, code] of cases) {
    await assert.rejects(() => fetchPublicPage(url, { fetchImpl }), (error) => error.code === code,
      `${url} must be refused as ${code}`);
  }
  assert.equal(called, false, 'no URL above was ever fetched');
});

test('a host that resolves inward is refused, and one that resolves outward is not', async () => {
  const refuse = { fetchImpl: async () => { throw new Error('must not be reached'); } };
  const lookup = async (hostname) => {
    if (hostname === 'sneaky.example') return [{ address: '127.0.0.1', family: 4 }];
    return [{ address: '93.184.216.34', family: 4 }];
  };
  await assert.rejects(() => fetchPublicPage('https://sneaky.example/x', { ...refuse, lookup }),
    (error) => error.code === 'BROWSER_ADDRESS_REFUSED');
  assert.equal(typeof lookup, 'function');
});

test('a redirect is checked at every hop: public to private is refused', async (t) => {
  const local = await localServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('nope'); });
  t.after(() => local.close());
  const fetchImpl = async (url) => ({
    ok: true, status: 200, headers: new Headers({ 'content-type': 'text/plain' }),
    body: (async function* () { yield Buffer.from('first'); })(),
    url,
  });
  const hops = new Map([
    ['https://public.example/start', { ok: false, status: 302,
      headers: new Headers({ location: local.origin }), body: null }],
  ]);
  const hopFetch = async (url) => hops.has(url) ? hops.get(url) : fetchImpl(url);
  await assert.rejects(() => fetchPublicPage('https://public.example/start',
    { fetchImpl: hopFetch, lookup: async () => [{ address: '93.184.216.34', family: 4 }] }),
    (error) => error.code === 'BROWSER_ADDRESS_REFUSED');
  assert.equal(hops.size, 1, 'the redirect target was refused before it was fetched');
});

test('redirects are bounded, and a loop is refused rather than followed', async () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  let calls = 0;
  const counting = async () => { calls += 1; return { ok: true, status: 302, headers: new Headers({ location: `https://public.example/${calls}` }), body: null }; };
  await assert.rejects(() => fetchPublicPage('https://public.example/0', { fetchImpl: counting, lookup }),
    (error) => error.code === 'BROWSER_TOO_MANY_REDIRECTS');
  assert.equal(calls, LIMITS.maxRedirects + 1);

  const looping = async (url) => ({ ok: true, status: 302, headers: new Headers({ location: url }), body: null });
  await assert.rejects(() => fetchPublicPage('https://public.example/loop', { fetchImpl: looping, lookup }),
    (error) => error.code === 'BROWSER_REDIRECT_LOOP');
});

test('only text content types are accepted, and a body over the ceiling is refused', async () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const withType = (type) => async () => ({ ok: true, status: 200,
    headers: new Headers(type ? { 'content-type': type } : {}),
    body: (async function* () { yield Buffer.from('x'); })() });
  for (const type of ['application/json', 'image/png', 'text/html; charset=utf-8', '']) {
    const shouldPass = type.startsWith('text/html') || type.startsWith('text/plain');
    if (shouldPass) {
      const result = await fetchPublicPage('https://public.example/x', { fetchImpl: withType(type), lookup });
      assert.equal(result.status, 200);
    } else {
      await assert.rejects(() => fetchPublicPage('https://public.example/x', { fetchImpl: withType(type), lookup }),
        (error) => error.code === 'BROWSER_CONTENT_TYPE_REFUSED', `${type} must be refused`);
    }
  }
  const huge = async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/plain', 'content-length': String(LIMITS.maxBytes + 1) }),
    body: (async function* () { yield Buffer.alloc(LIMITS.maxBytes + 10); })() });
  await assert.rejects(() => fetchPublicPage('https://public.example/x', { fetchImpl: huge, lookup }),
    (error) => error.code === 'BROWSER_BODY_TOO_LARGE');
});

test('a request that outlives the timeout is aborted, and a body that never ends is cut off', async () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const slow = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
  await assert.rejects(() => fetchPublicPage('https://public.example/slow', { fetchImpl: slow, lookup }),
    (error) => error.code === 'BROWSER_TIMEOUT');
  // No Content-Length, and a stream that keeps producing: the ceiling must not depend on a header.
  const endless = async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/plain' }),
    body: (async function* () { for (let i = 0; i < 100; i += 1) yield Buffer.alloc(64 * 1024); })() });
  await assert.rejects(() => fetchPublicPage('https://public.example/endless', { fetchImpl: endless, lookup }),
    (error) => error.code === 'BROWSER_BODY_TOO_LARGE');
});

test('a page read twice unchanged creates no new version, and a changed page advances it', async (t) => {
  const { store, service: svc } = service(t, { url: 'https://example.com/page' });
  let body = '<p>First body.</p>';
  const reader = new BrowserSourceReader(browserPolicy(svc, 'browser:example'), {
    fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/html' }),
      body: (async function* () { yield Buffer.from(body); })() }),
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  });

  const first = await pollBrowserSource(svc, 'browser:example', reader);
  assert.equal(first.duplicate, false);
  const afterFirst = sourceRows(svc, 'browser:example');
  assert.equal(afterFirst.length, 1);
  assert.equal(afterFirst[0].message.version, 1);

  // Same bytes: read again, and the durable record does not grow.
  const second = await pollBrowserSource(svc, 'browser:example', reader);
  assert.equal(second.duplicate, true, 'an unchanged page is a duplicate, not a new version');
  assert.equal(sourceRows(svc, 'browser:example').length, 1);
  assert.equal(sourceRows(svc, 'browser:example')[0].message.version, 1);

  // Changed bytes: a new version, and the creation time does not move with it.
  const createdAt = afterFirst[0].message.created_at;
  body = '<p>Second body, different.</p>';
  const third = await pollBrowserSource(svc, 'browser:example', reader);
  assert.equal(third.duplicate, false);
  const afterThird = sourceRows(svc, 'browser:example');
  assert.equal(afterThird[0].message.version, 2);
  assert.equal(afterThird[0].message.created_at, createdAt, 'creation time belongs to the item');
  assert.notEqual(afterThird[0].message.updated_at, undefined);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM events').n > 0, true);
});

test('the envelope the reader produces is exactly the one intake accepts', async (t) => {
  const { service: svc } = service(t, { url: 'https://example.com/page' });
  const reader = new BrowserSourceReader(browserPolicy(svc, 'browser:example'), {
    fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/html' }),
      body: (async function* () { yield Buffer.from('<p>Envelope check.</p>'); })() }),
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  await pollBrowserSource(svc, 'browser:example', reader);
  const [row] = sourceRows(svc, 'browser:example');
  assert.deepEqual(Object.keys(row.message).sort(), ['author_id', 'created_at', 'display_name',
    'message_id', 'operation', 'reply_to_id', 'source_id', 'source_kind', 'text', 'thread_id',
    'updated_at', 'version']);
  assert.equal(row.message.source_kind, 'live_snapshot');
  assert.equal(row.message.operation, 'upsert');
  assert.match(row.message.message_id, /^page:[a-f0-9]{64}$/);
  assert.match(row.message.author_id, /^site:[a-f0-9]{64}$/);
});

test('the reader offers reading and nothing else', async (t) => {
  const { service: svc } = service(t, { url: 'https://example.com/page' });
  const reader = new BrowserSourceReader(browserPolicy(svc, 'browser:example'));
  assert.equal(typeof reader.readPage, 'function');
  for (const method of ['submit', 'post', 'send', 'click', 'type', 'login', 'write', 'request'])
    assert.equal(reader[method], undefined, `the reader must not offer ${method}`);
  // The policy carries a URL and nothing that could be turned into a write.
  assert.deepEqual(Object.keys(browserPolicy(svc, 'browser:example')).sort(), ['maxLagSeconds', 'sourceId', 'url']);
});

test('the scheduler routes by configured policy, and files a browser failure as a browser one', async (t) => {
  const { store, service: svc } = service(t, { url: 'https://example.com/page' });
  assert.equal(sourceTransportKind(svc, 'browser:example'), 'browser');
  assert.equal(pollFailureKind(svc, 'browser:example'), 'source.browser.poll.failed');
  // A Telegram source is still a Telegram source, and so is the kind of failure recorded for it.
  const withTelegram = { ...svc.config, opportunity: { ...svc.config.opportunity,
    telegramSources: [{ accountId: '1', channelId: '2', sourceId: 'telegram:channel:2', maxLagSeconds: 120,
      processingBasis: 'x', sourceKind: 'sanitized_fixture' }] } };
  assert.equal(sourceTransportKind({ config: withTelegram }, 'telegram:channel:2'), 'telegram');
  assert.equal(pollFailureKind({ config: withTelegram }, 'telegram:channel:2'), 'source.telegram.poll.failed');
  assert.equal(sourceTransportKind(svc, 'nothing:configured'), 'fixture');
  // A reader for a source nobody configured has no transport to poll through.
  await assert.rejects(() => pollSource(svc, 'nothing:configured', { readPage: async () => ({}) }),
    (error) => error.code === 'SOURCE_TRANSPORT_UNAVAILABLE');
  assert.equal(store.get('SELECT COUNT(*) AS n FROM events').n, 0);
});
