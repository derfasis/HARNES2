// Browser v0: a read-only eye, not a browser for the agent.
//
// Every test runs against a fake transport and, where a socket is needed, a local HTTP server.
// Nothing reaches the internet, and the private-address rules are asserted on literals rather than
// by trying to connect inward — a test that genuinely reached a private address would be a test
// that genuinely left the machine.
// proof_level=synthetic_contract_eval; live_proof=false.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchPublicPage, isPrivateAddress, LIMITS } from '../business/sources/browser-fetch.mjs';
import { sanitizeHtml } from '../business/sources/browser-sanitize.mjs';
import { BrowserSourceReader, browserPolicy, pollBrowserSource, markBrowserSourceBlocked }
  from '../business/sources/browser-readonly.mjs';
import { sourceTransportKind, pollSource, pollFailureKind } from '../business/source-transport.mjs';
import { browserCheckpoint, sourceContextState } from '../business/source-ingestion.mjs';
import { Scheduler } from '../business/scheduler.mjs';
import { start } from '../business/server.mjs';
import { Store } from '../business/store.mjs';
import { BusinessService } from '../business/service.mjs';
import { loadConfig, validateBrowserSources } from '../business/config.mjs';
import { sourceRows } from '../business/source-ingestion.mjs';

const PAGE = `<!doctype html><html><head><title>Ignored</title>
<style>body{color:red}</style><script>window.steal='x';</script></head>
<body><h1>Heading</h1><p>First &amp; foremost.</p>
<form action="/x"><input name="q"><button>Send</button></form>
<!-- a comment --><noscript>enable js</noscript>
<p>Second paragraph with a link <a href="/next">here</a>.</p></body></html>`;

const PUBLIC = async () => [{ address: '93.184.216.34', family: 4 }];

// A response shaped like the one `http(s).request` produces, so the tests exercise the same path
// the real transport does rather than a stand-in that happens to satisfy the same calls.
class FakeResponse extends EventEmitter {
  constructor({ status = 200, headers = {}, body = '' } = {}) {
    super();
    this.statusCode = status;
    this.headers = headers;
    // `body: null` is a response that sends headers and then holds the connection open, which is
    // the case the deadline has to cover; anything else delivers on the next tick, as a socket would.
    this.chunks = body === null ? null : [Buffer.from(body)];
    this.destroyed = false;
    if (this.chunks) setImmediate(() => { if (!this.destroyed) this.deliver(); });
  }
  resume() { this.emit('end'); return this; }
  destroy() { this.destroyed = true; return this; }
  deliver() {
    for (const chunk of this.chunks ?? []) this.emit('data', chunk);
    this.emit('end');
  }
}

const fakeRequest = (handler) => {
  const calls = [];
  const request = async (url, address, signal) => {
    calls.push({ href: url.href, address, signal });
    const response = handler(url, address, signal, calls.length);
    // The real transport destroys the socket on abort, which the response reports. Without this the
    // fake would simply ignore the deadline, and the test would pass a hang rather than a timeout.
    if (response instanceof FakeResponse && signal) {
      if (signal.aborted) response.emit('aborted', new Error('aborted'));
      else signal.addEventListener('abort', () => { response.destroy(); response.emit('aborted', new Error('aborted')); }, { once: true });
    }
    return response;
  };
  request.calls = calls;
  return request;
};

const textResponse = (body, type = 'text/html') => new FakeResponse({ headers: { 'content-type': type }, body });
const redirectResponse = (location, status = 302) => new FakeResponse({ status, headers: { location }, body: null });

const service = (t, { url = 'https://example.com/page', sourceId = 'browser:example', maxLagSeconds = 300,
  sourceKind = 'live_snapshot' } = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-browser-'));
  const store = new Store(directory);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const loaded = loadConfig();
  const cfg = { ...loaded, opportunity: { ...loaded.opportunity, automatic: true,
    browserSources: [{ sourceId, url, maxLagSeconds, processingBasis: 'Local fixtures only', sourceKind }],
    allowedSourceRefs: [sourceId] },
  runtime: { ...loaded.runtime, enabled: false },
  telegram: { ...loaded.telegram, enabled: false, liveSending: false } };
  return { store, service: new BusinessService(store, cfg), cfg };
};

const readerFor = (svc, sourceId, handler) => {
  const request = fakeRequest(handler);
  return { reader: new BrowserSourceReader(browserPolicy(svc, sourceId), { request, lookup: PUBLIC }), request };
};

test('a page becomes bounded plain text with no markup, script, form or comment left in it', () => {
  const { text } = sanitizeHtml(PAGE, 16000);
  assert.match(text, /First & foremost\./);
  assert.match(text, /Second paragraph with a link here\./);
  for (const forbidden of ['<', '>', 'window.steal', 'color:red', '<form', 'a comment',
    'enable js', 'action=']) {
    assert.ok(!text.includes(forbidden), `page text must not contain ${forbidden}`);
  }
});

test('an oversized page is truncated and says so, rather than silently shortened', () => {
  const result = sanitizeHtml(`<p>${'a'.repeat(50000)}</p>`, 1000);
  assert.equal(result.text.length, 1000);
  assert.equal(result.truncated, true);
  assert.equal(result.originalLength > 1000, true);
});

test('an unclosed script does not turn the rest of the page into its content', () => {
  const { text } = sanitizeHtml('<p>before</p><script>var x = 1;', 16000);
  assert.match(text, /before/);
  assert.ok(!text.includes('var x'), 'code after an unclosed script must not survive as text');
});

test('every non-public address is refused, in every notation a URL parser can produce', () => {
  // `new URL` rewrites `::ffff:127.0.0.1` into the hex form `::ffff:7f00:1` before the boundary
  // sees it, so recognising only the dotted spelling classified loopback as public. The rule is
  // checked on the canonical form the parser actually produces.
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254',
    '0.0.0.0', '100.64.0.1', '224.0.0.1', '::1', '[::1]', 'fe80::1', 'fd00::1', 'fc00::1',
    '::ffff:127.0.0.1', '[::ffff:127.0.0.1]', '::ffff:7f00:1', '[::ffff:7f00:1]',
    '::ffff:169.254.169.254', '[::ffff:a9fe:a9fe]', '::ffff:0a00:1', '[::1]', '::', 'localhost',
    // The IANA special-purpose registries, which a version of this that checked only RFC1918 and
    // loopback happily called public.
    '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1', '192.0.2.1', '192.88.99.1',
    '240.1.1.1', '192.0.0.1',
    '2001:db8::1', '2001:2::1', '2001:10::1', '2001:1::1', '2002::1', '3fff::1', '100::1',
    '64:ff9b::1', '5f00::1',
    // Outside 2000::/3 there is no global unicast at all. These three were the regression: the
    // boundary used to accept anything it had not been told about, and 4000:: and 8000:: are
    // unallocated space, not addresses.
    '4000::1', '8000::1', '3ffe::1']) {
    assert.equal(isPrivateAddress(address), true, `${address} must be refused`);
  }
  for (const address of ['93.184.216.34', '8.8.8.8', '1.1.1.1',
    '172.32.0.1', '100.128.0.1', '198.20.0.1', '2606:2800:220:1:248:1893:25c8:1946',
    '::ffff:5db8:d822', '[::ffff:5db8:d822]',
    // Inside 2000::/3 and not reserved: the addresses a real page is served from.
    '2001:4860:4860::8888', '2606:4700:4700::1111', '2000::1', '2003::1', '2a00:1450:4001:80f::200e',
    '2620:fe::fe', '2a03:2880:f003:83::200e']) {
    assert.equal(isPrivateAddress(address), false, `${address} must be public`);
  }
  assert.equal(isPrivateAddress('example.com'), null, 'a name is not a verdict');
});

test('the scheme, credentials and address rules refuse before a socket is opened', async () => {
  const request = fakeRequest(() => { throw new Error('must not be reached'); });
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
    ['http://[::ffff:7f00:1]/x', 'BROWSER_ADDRESS_REFUSED'],
  ];
  for (const [url, code] of cases) {
    await assert.rejects(() => fetchPublicPage(url, { request, lookup: PUBLIC }),
      (error) => error.code === code, `${url} must be refused as ${code}`);
  }
  assert.equal(request.calls.length, 0, 'no URL above reached a socket');
});

test('a host that resolves inward is refused, and the address checked is the one connected to', async () => {
  // Rebinding: the answer says public, the connection would have gone inward. The address that
  // was checked is handed to the socket, so a second resolution cannot change where we land.
  const request = fakeRequest((url, address) => {
    if (isPrivateAddress(address) === true) throw Object.assign(new Error('connected inward'), { code: 'REBOUND' });
    return textResponse('<p>ok</p>');
  });
  await assert.rejects(() => fetchPublicPage('https://rebind.example/x', { request,
    lookup: async () => [{ address: '127.0.0.1', family: 4 }] }),
    (error) => error.code === 'BROWSER_ADDRESS_REFUSED');
  assert.equal(request.calls.length, 0, 'nothing was connected to');

  const outward = fakeRequest(() => textResponse('<p>ok</p>'));
  await fetchPublicPage('https://public.example/x', { request: outward, lookup: PUBLIC });
  assert.equal(outward.calls[0].address, '93.184.216.34',
    'the socket is given the address that was verified, not a name to resolve again');
  assert.equal(outward.calls[0].href, 'https://public.example/x',
    'and the hostname still drives the request and TLS');
});

test('a redirect is checked at every hop: public to private is refused', async () => {
  const request = fakeRequest((url) => url.hostname === 'public.example'
    ? redirectResponse('http://127.0.0.1/private')
    : textResponse('<p>secret</p>'));
  await assert.rejects(() => fetchPublicPage('https://public.example/start', { request, lookup: PUBLIC }),
    (error) => error.code === 'BROWSER_ADDRESS_REFUSED');
  assert.equal(request.calls.length, 1, 'the redirect target was refused before it was connected to');
});

test('a redirect is followed when each hop is allowed, and the chain is bounded', async () => {
  const request = fakeRequest((url) => url.pathname === '/start'
    ? redirectResponse('https://public.example/second')
    : textResponse('<p>arrived</p>', 'text/plain'));
  const result = await fetchPublicPage('https://public.example/start', { request, lookup: PUBLIC });
  assert.equal(result.body.toString(), '<p>arrived</p>');
  assert.equal(result.finalUrl, 'https://public.example/second');
  assert.equal(request.calls.length, 2, 'both hops were checked and both were connected to');

  // Each hop has to name a different URL, or the loop check fires first and the count limit is
  // never reached — the loop is found earlier, which is the better answer, but a different rule.
  let hops = 0;
  const endless = fakeRequest(() => redirectResponse(`https://public.example/hop-${hops += 1}`));
  await assert.rejects(() => fetchPublicPage('https://public.example/start',
    { request: endless, lookup: PUBLIC }), (error) => error.code === 'BROWSER_TOO_MANY_REDIRECTS');
  assert.equal(endless.calls.length, LIMITS.maxRedirects + 1);

  const looping = fakeRequest((url) => redirectResponse(url.href));
  await assert.rejects(() => fetchPublicPage('https://public.example/self',
    { request: looping, lookup: PUBLIC }), (error) => error.code === 'BROWSER_REDIRECT_LOOP');
});

test('only text content types are accepted, and a body over the ceiling is refused', async () => {
  for (const type of ['application/json', 'image/png', '']) {
    const request = fakeRequest(() => textResponse('{}', type));
    await assert.rejects(() => fetchPublicPage('https://public.example/x', { request, lookup: PUBLIC }),
      (error) => error.code === 'BROWSER_CONTENT_TYPE_REFUSED', `${type || 'absent'} must be refused`);
  }
  for (const type of ['text/html', 'text/html; charset=utf-8', 'text/plain']) {
    const request = fakeRequest(() => textResponse('ok', type));
    assert.equal((await fetchPublicPage('https://public.example/x', { request, lookup: PUBLIC })).status, 200);
  }
  const declared = fakeRequest(() => new FakeResponse({ headers: { 'content-type': 'text/plain',
    'content-length': String(LIMITS.maxBytes + 1) }, body: 'small' }));
  await assert.rejects(() => fetchPublicPage('https://public.example/x', { request: declared, lookup: PUBLIC }),
    (error) => error.code === 'BROWSER_BODY_TOO_LARGE');
});

test('the deadline covers the body, not only the headers', async () => {
  // A server may send headers immediately and then hold the connection open. Timing out at the
  // headers leaves that body open forever, so the abort has to reach the read as well.
  const stalled = new FakeResponse({ headers: { 'content-type': 'text/plain' }, body: null });
  const request = fakeRequest(() => stalled);
  const slow = fetchPublicPage('https://public.example/slow', { request, lookup: PUBLIC });
  await assert.rejects(slow, (error) => error.code === 'BROWSER_TIMEOUT');
  assert.equal(stalled.destroyed || stalled.listenerCount('data') === 0, true,
    'the stalled response was not left listening');

  // And a body that never ends is cut off rather than buffered.
  const endless = new FakeResponse({ headers: { 'content-type': 'text/plain' }, body: null });
  const producing = fakeRequest(() => endless);
  const overflow = fetchPublicPage('https://public.example/endless', { request: producing, lookup: PUBLIC });
  // The ceiling is enforced inside the read, so the overflow is raised there and observed by the
  // awaiting caller rather than thrown back out of this emit.
  setImmediate(() => {
    for (let i = 0; i < 100 && !endless.destroyed; i += 1) endless.emit('data', Buffer.alloc(64 * 1024));
  });
  await assert.rejects(overflow, (error) => error.code === 'BROWSER_BODY_TOO_LARGE');
  assert.equal(endless.destroyed, true, 'the response was destroyed once the ceiling was passed');
});

test('a page read twice unchanged creates no new version, and a changed page advances it', async (t) => {
  const { service: svc } = service(t);
  let body = '<p>First body.</p>';
  const { reader } = readerFor(svc, 'browser:example', () => textResponse(body));
  const first = await pollBrowserSource(svc, 'browser:example', reader);
  assert.equal(first.duplicate, false);
  assert.equal(sourceRows(svc, 'browser:example')[0].message.version, 1);

  const second = await pollBrowserSource(svc, 'browser:example', reader);
  assert.equal(second.duplicate, true, 'an unchanged page is a duplicate, not a new version');
  assert.equal(sourceRows(svc, 'browser:example').length, 1);

  const createdAt = sourceRows(svc, 'browser:example')[0].message.created_at;
  body = '<p>Second body, different.</p>';
  await pollBrowserSource(svc, 'browser:example', reader);
  const after = sourceRows(svc, 'browser:example')[0].message;
  assert.equal(after.version, 2);
  assert.equal(after.created_at, createdAt, 'creation time belongs to the item');
});

test('the envelope is exactly the one intake accepts, and a fixture kind is refused', async (t) => {
  const { service: svc, cfg } = service(t);
  const { reader } = readerFor(svc, 'browser:example', () => textResponse('<p>Envelope.</p>'));
  await pollBrowserSource(svc, 'browser:example', reader);
  const [row] = sourceRows(svc, 'browser:example');
  assert.deepEqual(Object.keys(row.message).sort(), ['author_id', 'created_at', 'display_name',
    'message_id', 'operation', 'reply_to_id', 'source_id', 'source_kind', 'text', 'thread_id',
    'updated_at', 'version']);
  assert.equal(row.message.source_kind, 'live_snapshot');
  assert.match(row.message.message_id, /^page:[a-f0-9]{64}$/);
  assert.match(row.message.author_id, /^site:[a-f0-9]{64}$/);

  // A configured `sanitized_fixture` would contradict the envelope the reader always emits, so the
  // policy itself is refused rather than accepted and rejected later by the pipeline.
  const withFixture = { ...cfg, opportunity: { ...cfg.opportunity,
    browserSources: [{ ...cfg.opportunity.browserSources[0], sourceKind: 'sanitized_fixture' }] } };
  assert.throws(() => validateBrowserSources(withFixture),
    (error) => error.code === 'INVALID_BROWSER_SOURCES');
});

test('the browser checkpoint is written with the intake, and a blocked source refuses the next read', async (t) => {
  const { service: svc } = service(t);
  const { reader } = readerFor(svc, 'browser:example', () => textResponse('<p>checkpointed</p>'));
  assert.equal(browserCheckpoint(svc, 'browser:example'), null, 'nothing is confirmed before a read');
  await pollBrowserSource(svc, 'browser:example', reader);
  const confirmed = browserCheckpoint(svc, 'browser:example');
  assert.equal(confirmed.phase, 'current');
  assert.equal(confirmed.reason, null);
  assert.match(confirmed.confirmed_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(confirmed.policy_hash, /^[a-f0-9]{64}$/);

  // A source whose checkpoint belongs to a different policy is not silently accepted.
  const drifted = { ...svc, config: { ...svc.config, opportunity: { ...svc.config.opportunity,
    browserSources: [{ ...svc.config.opportunity.browserSources[0], maxLagSeconds: 900 }] } } };
  await assert.rejects(() => pollBrowserSource(drifted, 'browser:example', reader),
    (error) => error.code === 'BROWSER_POLICY_CHANGED_SINCE_CONFIRMATION');

  const { reader: failing } = readerFor(svc, 'browser:example', () => { throw new Error('page gone'); });
  const recorded = markBrowserSourceBlocked(svc, 'browser:example', 'BROWSER_FETCH_FAILED');
  assert.equal(recorded, 'BROWSER_FETCH_FAILED');
  assert.equal(browserCheckpoint(svc, 'browser:example').phase, 'blocked');
  await assert.rejects(() => pollBrowserSource(svc, 'browser:example', failing),
    (error) => error.code === 'BROWSER_SOURCE_BLOCKED');
});

test('a free-form failure message never becomes the recorded reason', (t) => {
  const { service: svc } = service(t);
  assert.equal(markBrowserSourceBlocked(svc, 'browser:example', 'provider said no: sk-live-abcdef'),
    'BROWSER_READ_FAILED');
  assert.equal(markBrowserSourceBlocked(svc, 'browser:example', 'lowercase'), 'BROWSER_READ_FAILED');
  assert.ok(!JSON.stringify(browserCheckpoint(svc, 'browser:example')).includes('sk-live'));
});

test('the reader offers reading and nothing else', async (t) => {
  const { service: svc } = service(t);
  const reader = new BrowserSourceReader(browserPolicy(svc, 'browser:example'));
  assert.equal(typeof reader.readPage, 'function');
  for (const method of ['submit', 'post', 'send', 'click', 'type', 'login', 'write', 'request', 'post_'])
    assert.equal(reader[method], undefined, `the reader must not offer ${method}`);
  assert.deepEqual(Object.keys(browserPolicy(svc, 'browser:example')).sort(), ['maxLagSeconds', 'sourceId', 'url']);
});

test('the transport is chosen by configuration, and an ambiguous source is refused', (t) => {
  const { service: svc, cfg } = service(t);
  assert.equal(sourceTransportKind(svc, 'browser:example'), 'browser');
  assert.equal(pollFailureKind(svc, 'browser:example'), 'source.browser.poll.failed');
  assert.equal(sourceTransportKind(svc, 'nothing:configured'), 'fixture');
  // A source id in both lists is not a tie to break: it is a configuration that does not say.
  const both = { config: { ...cfg, opportunity: { ...cfg.opportunity, telegramSources: [
    { accountId: '1', channelId: '2', sourceId: 'browser:example', maxLagSeconds: 120,
      processingBasis: 'x', sourceKind: 'sanitized_fixture' }] } } };
  assert.throws(() => sourceTransportKind(both, 'browser:example'),
    (error) => error.code === 'SOURCE_TRANSPORT_AMBIGUOUS');
});

test('a source nobody configured has no transport to poll through', async (t) => {
  const { service: svc } = service(t);
  await assert.rejects(() => pollSource(svc, 'nothing:configured', { readPage: async () => ({}) }),
    (error) => error.code === 'SOURCE_TRANSPORT_UNAVAILABLE');
});

test('the real startup composes both transports, and Telegram cannot evict the browser', async (t) => {
  // This runs `start()` itself rather than reproducing what start() does. The previous version of
  // this test copied the composition, which meant a rewired server would leave it green — the exact
  // gap the review named.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harnes2-startup-'));
  const loaded = loadConfig();
  const config = { ...loaded,
    server: { ...loaded.server, port: 0 },
    opportunity: { ...loaded.opportunity, automatic: true,
      browserSources: [{ sourceId: 'browser:example', url: 'https://example.com/page',
        maxLagSeconds: 300, processingBasis: 'Startup fixture only', sourceKind: 'live_snapshot' }],
      allowedSourceRefs: ['browser:example'] },
    runtime: { ...loaded.runtime, enabled: false },
    telegram: { ...loaded.telegram, enabled: false, liveSending: false } };
  const app = await start({ config, directory });
  // Closed before the directory is removed, or the store still holds the files and Windows
  // refuses the delete.
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  assert.equal(app.scheduler.sourceReaders.length, 1, 'the browser reader is composed at startup');
  assert.equal(app.scheduler.sourceReaders[0].sourceId, 'browser:example');
  // The channel reporting in must not take the browser readers with it.
  app.telegram.onSourcesReady([{ sourceId: 'telegram:channel:2', transport: {} }]);
  assert.deepEqual(app.scheduler.sourceReaders.map((entry) => entry.sourceId),
    ['telegram:channel:2', 'browser:example'], 'both transports are polled after a Telegram reader arrives');
  assert.equal(app.scheduler.sourceReaders[1].transport instanceof BrowserSourceReader, true,
    'the browser entry is a reader, not a placeholder');
});

test('the context state a browser source reports is the one the pipeline reads', async (t) => {
  const { store, service: svc } = service(t);
  const { reader } = readerFor(svc, 'browser:example', () => textResponse('<p>context</p>'));
  const ingested = await pollBrowserSource(svc, 'browser:example', reader);
  // sourceContextState takes the event id, and it runs the shared transport boundary — which is
  // what proves a browser source is held to its own policy rather than refused as a Telegram one.
  const state = sourceContextState(svc, ingested.source_event_id);
  assert.ok(state, 'a confirmed browser source has context state');
  assert.match(JSON.stringify(state), /browser:example/);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM events WHERE kind=\'source.telegram.poll.failed\'').n, 0);
});
