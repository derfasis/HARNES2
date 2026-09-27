// The network boundary for the read-only browser.
//
// This is the security boundary, and it is the fetch policy rather than the HTML handling: what
// matters is where we are willing to connect. The URL is not an argument the model supplies — it
// comes from the operator's configuration — but "configured" is not a defence on its own, because
// a configured page can redirect, and a redirect target is chosen by the page, not by us.
//
// Every hop is therefore checked with the same rules, and the answers to "private" include the
// ranges a public page uses to reach a machine on the network it sits on: loopback, RFC1918,
// link-local, and the cloud metadata address, which is a credential store reachable without
// authentication.
//
// One honest limit. Name resolution happens before the connection, so an attacker who controls
// DNS for a configured hostname could in principle answer a public address here and a private one
// to the connection that follows. Closing that needs a pinned-address connection, which v0 does
// not have. The boundary is therefore strong against redirects, literals and ordinary names, and
// stated rather than overstated.
import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

// One hop, over a socket pointed at the address that was already checked. The `lookup` we hand
// Node is the pinned one: the socket is told to connect to the address we verified, while the
// hostname still drives TLS and the Host header, so nothing about the request is spoofed. This is
// the whole reason the module does not use `fetch`, which would resolve the name again and connect
// to whatever that second answer happened to be.
const nodeRequest = (url, address, signal) => new Promise((resolve, reject) => {
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
    lookup: (hostname, options, callback) => callback(null, address, address.includes(':') ? 6 : 4),
    headers: {
      // A plain read: no cookies, no authorization, no ambient state of any kind. The request says
      // who it is by being a GET on a public page and nothing else.
      accept: 'text/html, text/plain',
      'accept-language': 'en',
      'user-agent': 'digital-ai-partner/0.1 read-only source reader',
    },
  }, resolve);
  const onAbort = () => { request.destroy(signal.reason ?? new Error('aborted')); };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  request.on('error', (error) => { signal.removeEventListener('abort', onAbort); reject(error); });
  request.on('response', (response) => signal.removeEventListener('abort', onAbort));
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

export class BrowserFetchError extends Error {
  constructor(code, message) { super(message ?? code); this.code = code; }
}

const refuse = (code, message) => { throw new BrowserFetchError(code, message); };

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

// True for any address that is not routable on the public internet. Anything not confidently
// public is treated as private: an unrecognised form must fail closed, not be assumed safe.
export const isPrivateAddress = (address) => {
  const value = String(address).trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!value) return true;
  if (FORBIDDEN_LITERALS.has(value)) return true;
  if (net.isIP(value) === 4) {
    const [a, b] = value.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;                       // this network, this network, loopback
    if (a === 169 && b === 254) return true;                                 // link-local, includes the metadata address
    if (a === 172 && b >= 16 && b <= 31) return true;                        // RFC1918
    if (a === 192 && b === 168) return true;                                 // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true;                       // RFC6598 carrier NAT
    if (a === 192 && b === 0) return true;                                   // RFC6890, including 192.0.0.170/171
    if (a >= 224) return true;                                                // multicast and reserved
    return false;
  }
  if (value.includes(':')) {
    const groups = expandIpv6(value);
    // An address we cannot parse is not an address we are willing to connect to.
    if (!groups) return true;
    const embedded = mappedIpv4(groups);
    if (embedded) return isPrivateAddress(embedded);
    if (groups.every((g) => g === 0)) return true;                           // ::
    if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1
    const first = groups[0];
    if ((first & 0xffc0) === 0xfe80) return true;                            // fe80::/10 link-local
    if ((first & 0xfe00) === 0xfc00) return true;                            // fc00::/7 unique local
    if ((first & 0xff00) === 0xff00) return true;                            // ff00::/8 multicast
    return false;
  }
  // Not an address at all: a name. It is checked by resolution instead, so this is not a verdict,
  // it is a signal that the caller has something else to do.
  return null;
};

export const assertUrlAllowed = (raw) => {
  let url;
  try { url = new URL(String(raw)); } catch { refuse('BROWSER_URL_INVALID'); }
  if (!ALLOWED_SCHEMES.has(url.protocol)) refuse('BROWSER_SCHEME_REFUSED', `scheme ${url.protocol} is not read-only`);
  if (url.username || url.password) refuse('BROWSER_URL_CREDENTIALS_REFUSED');
  if (!url.hostname) refuse('BROWSER_URL_INVALID');
  const literal = isPrivateAddress(url.hostname);
  if (literal === true) refuse('BROWSER_ADDRESS_REFUSED', 'the URL names a non-public address');
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
  if (!addresses.length) refuse('BROWSER_DNS_EMPTY');
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address) === true)
      refuse('BROWSER_ADDRESS_REFUSED', 'the host resolves to a non-public address');
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
export async function fetchPublicPage(rawUrl, { request = nodeRequest, lookup = dns.lookup } = {}) {
  let current = assertUrlAllowed(rawUrl);
  const seen = new Set();
  for (let hop = 0; hop <= LIMITS.maxRedirects; hop += 1) {
    if (seen.has(current.href)) refuse('BROWSER_REDIRECT_LOOP');
    seen.add(current.href);
    const address = await resolvePublic(current.hostname, lookup);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new BrowserFetchError('BROWSER_TIMEOUT')), LIMITS.timeoutMs);
    let response;
    try {
      response = await request(current, address, controller.signal);
    } catch (error) {
      clearTimeout(timer);
      if (error?.code === 'BROWSER_TIMEOUT') refuse('BROWSER_TIMEOUT');
      refuse('BROWSER_FETCH_FAILED');
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
        refuse('BROWSER_STATUS_REFUSED', `status ${response.statusCode}`);
      }
      if (!ALLOWED_CONTENT_TYPES.includes(contentTypeOf(response.headers))) {
        response.resume();
        refuse('BROWSER_CONTENT_TYPE_REFUSED', `content type ${contentTypeOf(response.headers) || 'absent'} is not text`);
      }
      // The deadline is still running here, and covers the body as well as the headers.
      const body = await readBounded(response, { aborted: controller.signal.aborted, reason: new BrowserFetchError('BROWSER_TIMEOUT') });
      clearTimeout(timer);
      return { url: current.href, finalUrl: current.href, status: response.statusCode, body };
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof BrowserFetchError) throw error;
      if (controller.signal.aborted) refuse('BROWSER_TIMEOUT');
      refuse('BROWSER_BODY_FAILED');
    }
  }
  refuse('BROWSER_TOO_MANY_REDIRECTS');
}
