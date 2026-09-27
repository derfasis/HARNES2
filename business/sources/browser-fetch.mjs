// The network boundary for the read-only browser.
//
// This is the security boundary, and it is the fetch policy rather than the HTML handling: what
// matters is where we are willing to connect. The URL is not an argument the model supplies — it
// comes from the operator's configuration — but "configured" is not a defence on its own, because
// a configured page can redirect, and a redirect target is chosen by the page, not by us.
//
// Every hop is therefore checked with the same rules, against the IANA special-purpose registries
// rather than against the few ranges that come to mind: loopback, RFC1918, link-local, the cloud
// metadata address that hands out credentials without authentication, and the benchmarking,
// documentation, translation and transition ranges that are not routable either.
//
// What "checked" means for a name, precisely: the name is resolved, every answer is checked, and
// the address that was checked is the one the socket is given. A second, different answer from
// DNS has nothing left to influence, because there is no second resolution. That is a guarantee
// about the address the connection reaches, not about the name, and it is not a claim about DNSSEC.
import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

// One hop, over a socket pointed at the address that was already checked. The `lookup` we hand
// Node is the pinned one: the socket is told to connect to the address we verified, while the
// hostname still drives TLS and the Host header, so nothing about the request is spoofed. This is
// the whole reason the module does not use `fetch`, which would resolve the name again and connect
// to whatever that second answer happened to be.
export const browserRequest = (url, address, signal) => new Promise((resolve, reject) => {
  const transport = url.protocol === 'https:' ? https : http;
  const request = transport.request({
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    // The pinned address, and the host the certificate is checked against: they are different
    // things and Node supports having both.
    servername: url.hostname,
    // Node asks for one address or for a list, depending on `options.all` (address
    // auto-selection sets it). Answering with a scalar when it wants a list makes it read
    // `.address` off a string and fail with ERR_INVALID_IP_ADDRESS — so every real hostname
    // was unreadable, while every test passed, because a test that connects to an IP literal
    // never calls this at all. Both shapes are answered, from the one address already checked.
    lookup: (hostname, options, callback) => {
      const family = address.includes(':') ? 6 : 4;
      if (options?.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
      return undefined;
    },
    headers: {
      // A plain read: no cookies, no authorization, no ambient state of any kind. The request says
      // who it is by being a GET on a public page and nothing else.
      accept: 'text/html, text/plain',
      'accept-language': 'en',
      'user-agent': 'digital-ai-partner/0.1 read-only source reader',
    },
  }, resolve);
  // The abort stays wired until the body has been read. Removing it on `response` — the natural
  // place, since that is when the promise resolves — leaves a server that sent headers and then
  // held the connection open holding it for ever, which is exactly the case the deadline exists
  // for. Destroying the request is what makes the stalled response emit, and the reader turns that
  // into BROWSER_TIMEOUT.
  const onAbort = () => { request.destroy(signal.reason ?? new Error('aborted')); };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  request.on('error', (error) => { signal.removeEventListener('abort', onAbort); reject(error); });
  request.on('close', () => signal.removeEventListener('abort', onAbort));
  request.end();
});

export const LIMITS = Object.freeze({
  maxRedirects: 3,
  timeoutMs: 10000,
  maxBytes: 2 * 1024 * 1024,
  maxTextChars: 16000,
});

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);
const ALLOWED_CONTENT_TYPES = ['text/html', 'text/plain'];

// The address a public page reaches a nearby machine on, and the address that hands out cloud
// credentials to whoever asks. Both are refused by the same rule as any private range.
const FORBIDDEN_LITERALS = new Set(['localhost', '::1', '0.0.0.0', '169.254.169.254', 'fd00:ec2::254']);

// The classes a caller may see. This list is the whole vocabulary: a refusal that is not one of
// these is a programming error, caught below rather than passed on. The reason it is closed is
// that the alternative is a message, and a message from a fetch carries the host, the address, the
// status line and whatever the TLS stack felt like saying — none of which belongs in a record
// that an operator will read and a log might keep.
export const SAFE_CLASSES = Object.freeze([
  'BROWSER_DNS_FAILED',
  'BROWSER_TLS_FAILED',
  'BROWSER_CONNECTION_REFUSED',
  'BROWSER_CONNECTION_FAILED',
  'BROWSER_TIMEOUT',
  'BROWSER_BODY_TOO_LARGE',
  'BROWSER_CONTENT_TYPE_REFUSED',
  'BROWSER_STATUS_REFUSED',
  'BROWSER_SCHEME_REFUSED',
  'BROWSER_ADDRESS_REFUSED',
  'BROWSER_URL_REFUSED',
  'BROWSER_REDIRECT_LOOP',
  'BROWSER_REDIRECT_WITHOUT_LOCATION',
  'BROWSER_TOO_MANY_REDIRECTS',
  'BROWSER_FETCH_FAILED',
]);

// Node's own error codes, mapped to the class an operator can act on. Only the code is read, never
// the message: `connect ECONNREFUSED 93.184.216.34:443` tells the operator where to look, and it
// also tells anyone reading the record which host the partner was configured to reach.
const NODE_CODE_CLASSES = new Map(Object.entries({
  ENOTFOUND: 'BROWSER_DNS_FAILED', EAI_AGAIN: 'BROWSER_DNS_FAILED', EAI_NODATA: 'BROWSER_DNS_FAILED',
  ECONNREFUSED: 'BROWSER_CONNECTION_REFUSED',
  ECONNRESET: 'BROWSER_CONNECTION_FAILED', EPIPE: 'BROWSER_CONNECTION_FAILED',
  EHOSTUNREACH: 'BROWSER_CONNECTION_FAILED', ENETUNREACH: 'BROWSER_CONNECTION_FAILED',
  EHOSTDOWN: 'BROWSER_CONNECTION_FAILED', ERR_SOCKET_CONNECTION_TIMEOUT: 'BROWSER_TIMEOUT',
  EPROTO: 'BROWSER_TLS_FAILED', CERT_HAS_EXPIRED: 'BROWSER_TLS_FAILED',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'BROWSER_TLS_FAILED', SELF_SIGNED_CERT_IN_CHAIN: 'BROWSER_TLS_FAILED',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'BROWSER_TLS_FAILED', UNABLE_TO_GET_ISSUER_CERT: 'BROWSER_TLS_FAILED',
  ERR_TLS_CERT_ALTNAME_INVALID: 'BROWSER_TLS_FAILED', ERR_SSL_WRONG_VERSION_NUMBER: 'BROWSER_TLS_FAILED',
}));

// Anything not in the table becomes the fallback. A refusal that names itself after a library
// error we did not anticipate would be a new channel out, and the fallback loses nothing an
// operator needed: it says the read failed, and the class above says why when we know.
export const classifyTransportError = (error) => {
  if (error?.code === 'BROWSER_TIMEOUT' || error?.name === 'AbortError') return 'BROWSER_TIMEOUT';
  return NODE_CODE_CLASSES.get(String(error?.code ?? '')) ?? 'BROWSER_FETCH_FAILED';
};

export class BrowserFetchError extends Error {
  constructor(code) {
    // The message is the code. Not a convenience: it is what makes it impossible for a detail to
    // reach a caller, a log or a record through the one field every error has.
    super(SAFE_CLASSES.includes(code) ? code : 'BROWSER_FETCH_FAILED');
    this.code = this.message;
  }
}

const refuse = (code) => { throw new BrowserFetchError(code); };

// Expand an IPv6 address to its eight groups, so classification is done on numbers rather than on
// the notation. A URL parser rewrites `::ffff:127.0.0.1` into `::ffff:7f00:1` before we ever see
// it, and a classifier that only recognises the dotted spelling calls that public — which is a
// live way to reach loopback. Working from groups makes the notation irrelevant.
const expandIpv6 = (value) => {
  let text = value;
  const embedded = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (embedded) {
    // Rewrite a trailing dotted quad as two hex groups so the rest is plain IPv6.
    const [a, b, c, d] = embedded[1].split('.').map(Number);
    text = text.slice(0, embedded.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null;
  const groups = halves.length === 1
    ? head
    : [...head, ...Array(fill).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const numbers = groups.map((group) => (/^[0-9a-f]{1,4}$/i.test(group) ? Number.parseInt(group, 16) : NaN));
  return numbers.some((n) => !Number.isFinite(n)) ? null : numbers;
};

// The IPv4 address an IPv6 address carries, when it carries one.
const mappedIpv4 = (groups) => {
  const isMapped = groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0);
  const isCompatible = groups.slice(0, 6).every((g) => g === 0) && groups[6] !== 0;
  if (!isMapped && !isCompatible) return null;
  const high = groups[6] ?? 0, low = groups[7] ?? 0;
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
};

// The ranges IANA registers as special-purpose, as [network, prefix length]. Listing the
// registries rather than testing the few ranges that come to mind is the point: a version of this
// that checked only RFC1918 and loopback called the benchmarking range, the documentation ranges
// and Teredo public, and each of those is somewhere a page could be sent that should not be
// reachable. When a registry grows, the answer is to add it here — the default stays "not public".
const IPV4_SPECIAL = [
  [['0', '0', '0', '0'], 8, 'this network'],
  [['10', '0', '0', '0'], 8, 'private'],
  [['100', '64', '0', '0'], 10, 'carrier NAT'],
  [['127', '0', '0', '0'], 8, 'loopback'],
  [['169', '254', '0', '0'], 16, 'link-local, includes the cloud metadata address'],
  [['172', '16', '0', '0'], 12, 'private'],
  [['192', '0', '0', '0'], 24, 'IETF protocol assignments'],
  [['192', '0', '2', '0'], 24, 'documentation TEST-NET-1'],
  [['192', '88', '99', '0'], 24, 'deprecated 6to4 relay anycast'],
  [['192', '168', '0', '0'], 16, 'private'],
  [['198', '18', '0', '0'], 15, 'benchmarking'],
  [['198', '51', '100', '0'], 24, 'documentation TEST-NET-2'],
  [['203', '0', '113', '0'], 24, 'documentation TEST-NET-3'],
  [['240', '0', '0', '0'], 4, 'reserved'],
];

const inIpv4Range = (octets, network, bits) => {
  let remaining = bits;
  for (let index = 0; index < 4; index += 1) {
    if (remaining <= 0) return true;
    const take = Math.min(8, remaining);
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if ((octets[index] & mask) !== (Number(network[index]) & mask)) return false;
    remaining -= take;
  }
  return true;
};
// Global unicast for IPv6 is 2000::/3 and nothing else. Requiring it first turns the whole
// question "is this reserved?" into "is this inside the one range that is public, minus the parts
// reserved inside it" — which is a question with an answer, rather than a list of things to
// remember. The entries below are therefore only the reservations *inside* 2000::/3; everything
// else, including the translation and discard prefixes, is refused by the outer rule.
const IPV6_GLOBAL_UNICAST = 0x2000;
const IPV6_GLOBAL_MASK = 0xe000;
const IPV6_SPECIAL = [
  [[0x2001, 0x0000, 0, 0, 0, 0, 0, 0], 23, 'IETF protocol assignments'],
  [[0x2001, 0x0002, 0, 0, 0, 0, 0, 0], 48, 'benchmarking'],
  [[0x2001, 0x0010, 0, 0, 0, 0, 0, 0], 28, 'ORCHID'],
  [[0x2001, 0x0db8, 0, 0, 0, 0, 0, 0], 32, 'documentation'],
  [[0x2001, 0x0020, 0, 0, 0, 0, 0, 0], 28, 'ORCHIDv2'],
  [[0x2002, 0, 0, 0, 0, 0, 0, 0], 16, '6to4'],
  [[0x3ffe, 0, 0, 0, 0, 0, 0, 0], 16, 'reserved, formerly 6bone'],
  [[0x3fff, 0, 0, 0, 0, 0, 0, 0], 20, 'documentation'],
];

// True when the first `bits` of both group arrays agree.
const sharesPrefix = (groups, network, bits) => {
  let remaining = bits;
  for (let index = 0; index < 8 && remaining > 0; index += 1) {
    const take = Math.min(16, remaining);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    if ((groups[index] & mask) !== (network[index] & mask)) return false;
    remaining -= take;
  }
  return true;
};

// True for any address that is not routable on the public internet. Anything not confidently
// public is treated as private: an unrecognised form must fail closed, not be assumed safe.
export const isPrivateAddress = (address) => {
  const value = String(address).trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!value) return true;
  if (FORBIDDEN_LITERALS.has(value)) return true;
  if (net.isIP(value) === 4) {
    const octets = value.split('.').map(Number);
    for (const [network, bits] of IPV4_SPECIAL) if (inIpv4Range(octets, network, bits)) return true;
    return octets[0] >= 224;                                                 // multicast
  }
  if (value.includes(':')) {
    const groups = expandIpv6(value);
    // An address we cannot parse is not an address we are willing to connect to.
    if (!groups) return true;
    const embedded = mappedIpv4(groups);
    if (embedded) return isPrivateAddress(embedded);
    // Outside 2000::/3 there is no global unicast at all: loopback, unspecified, link-local,
    // unique local, multicast, the translation and discard prefixes, and everything unallocated.
    // Refusing the whole outside is what makes the answer to "is this reserved?" checkable —
    // enumerating the exceptions is how 4000:: and 8000:: came to be treated as public.
    if ((groups[0] & IPV6_GLOBAL_MASK) !== IPV6_GLOBAL_UNICAST) return true;
    for (const [network, bits] of IPV6_SPECIAL) if (sharesPrefix(groups, network, bits)) return true;
    return false;
  }
  // Not an address at all: a name. It is checked by resolution instead, so this is not a verdict,
  // it is a signal that the caller has something else to do.
  return null;
};

export const assertUrlAllowed = (raw) => {
  let url;
  try { url = new URL(String(raw)); } catch { refuse('BROWSER_URL_REFUSED'); }
  if (!ALLOWED_SCHEMES.has(url.protocol)) refuse('BROWSER_SCHEME_REFUSED');
  if (url.username || url.password) refuse('BROWSER_URL_REFUSED');
  if (!url.hostname) refuse('BROWSER_URL_REFUSED');
  const literal = isPrivateAddress(url.hostname);
  if (literal === true) refuse('BROWSER_ADDRESS_REFUSED');
  return url;
};

// Resolve and check, because a name is only as public as what it resolves to. `null` from the
// literal check means "this is a name, resolve it"; `false` means it is already a public address.
// The resolver is a parameter rather than the module's own, so a test can state what a host
// Resolve and check, and return the address to connect to. Returning it is the point: an address
// that was checked and then thrown away is not an address that was checked, and a name is
// re-resolved by whatever opens the connection. The returned address is handed to the socket.
const resolvePublic = async (hostname, resolve) => {
  const literal = isPrivateAddress(hostname);
  if (literal === false) return hostname;
  let addresses;
  try { addresses = await resolve(hostname, { all: true, verbatim: true }); }
  catch { refuse('BROWSER_DNS_FAILED'); }
  if (!addresses.length) refuse('BROWSER_DNS_FAILED');
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address) === true)
      refuse('BROWSER_ADDRESS_REFUSED');
  }
  // The first checked address is the one the socket is given, so the address that was verified is
  // the address that is used. One connection attempt only: retrying on a second answer would
  // reintroduce exactly the gap this closes.
  return addresses[0].address;
};

// Read the body with a hard ceiling, under the same deadline as the headers. A page that streams
// without end is refused rather than buffered: the ceiling exists to bound memory, and a body that
// ignores Content-Length would otherwise decide how much we allocate. The deadline covers this
// read too, because a server may send headers and then hold the connection open indefinitely.
const readBounded = (response, abort) => new Promise((resolve, reject) => {
  const declared = Number(response.headers['content-length']);
  if (Number.isFinite(declared) && declared > LIMITS.maxBytes) {
    response.resume();
    return reject(new BrowserFetchError('BROWSER_BODY_TOO_LARGE'));
  }
  const chunks = [];
  let total = 0;
  // Refusing rejects rather than throws. This runs inside the socket's own event handler, and a
  // throw from there is an uncaught exception rather than the refusal the caller is waiting for.
  const onData = (chunk) => {
    total += chunk.length;
    if (total > LIMITS.maxBytes) {
      cleanup();
      response.destroy();
      reject(new BrowserFetchError('BROWSER_BODY_TOO_LARGE'));
      return;
    }
    chunks.push(chunk);
  };
  const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
  const onError = (error) => { cleanup(); reject(abort.aborted ? abort.reason : error); };
  const cleanup = () => {
    response.off('data', onData); response.off('end', onEnd); response.off('error', onError);
    response.off('aborted', onError);
  };
  response.on('data', onData);
  response.on('end', onEnd);
  response.on('error', onError);
  response.on('aborted', onError);
});

const contentTypeOf = (headers) => String(headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();

// Fetch one URL, following redirects by hand so that every hop meets the same policy.
//
// The connection is opened through `http(s).request` with a `lookup` that returns the address
// already checked, rather than through `fetch`, which would resolve the name a second time and
// connect to whatever the second answer said. The hostname is still what TLS validates and what
// the `Host` header carries, so pinning the address costs nothing in correctness.
export async function fetchPublicPage(rawUrl, { request = browserRequest, lookup = dns.lookup,
  timeoutMs = LIMITS.timeoutMs } = {}) {
  let current = assertUrlAllowed(rawUrl);
  const seen = new Set();
  for (let hop = 0; hop <= LIMITS.maxRedirects; hop += 1) {
    if (seen.has(current.href)) refuse('BROWSER_REDIRECT_LOOP');
    seen.add(current.href);
    const address = await resolvePublic(current.hostname, lookup);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new BrowserFetchError('BROWSER_TIMEOUT')), timeoutMs);
    let response;
    try {
      response = await request(current, address, controller.signal);
    } catch (error) {
      clearTimeout(timer);
      refuse(classifyTransportError(error));
    }

    try {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        const location = response.headers.location;
        response.resume();
        if (!location) refuse('BROWSER_REDIRECT_WITHOUT_LOCATION');
        if (hop === LIMITS.maxRedirects) refuse('BROWSER_TOO_MANY_REDIRECTS');
        // Checked on the next iteration, by the same rules, before any connection is made to it.
        current = assertUrlAllowed(new URL(location, current.href).href);
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        refuse('BROWSER_STATUS_REFUSED');
      }
      if (!ALLOWED_CONTENT_TYPES.includes(contentTypeOf(response.headers))) {
        response.resume();
        refuse('BROWSER_CONTENT_TYPE_REFUSED');
      }
      // The deadline is still running here, and covers the body as well as the headers.
      const body = await readBounded(response, { aborted: controller.signal.aborted, reason: new BrowserFetchError('BROWSER_TIMEOUT') });
      clearTimeout(timer);
      return { url: current.href, finalUrl: current.href, status: response.statusCode, body };
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof BrowserFetchError) throw error;
      refuse(controller.signal.aborted ? 'BROWSER_TIMEOUT' : classifyTransportError(error));
    }
  }
  refuse('BROWSER_TOO_MANY_REDIRECTS');
}
