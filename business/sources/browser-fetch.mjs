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

// True for any address that is not routable on the public internet. Anything not confidently
// public is treated as private: an unrecognised form must fail closed, not be assumed safe.
export const isPrivateAddress = (address) => {
  const value = String(address).trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!value) return true;
  if (FORBIDDEN_LITERALS.has(value)) return true;
  const ip = net.isIP(value);
  if (ip === 4) {
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
  if (ip === 6) {
    if (value === '::' || value === '::1') return true;
    if (value.startsWith('fe80') || value.startsWith('fc') || value.startsWith('fd')) return true;
    if (value.startsWith('ff')) return true;                                 // multicast
    // An IPv4-mapped or -compatible address is an IPv4 address wearing a hat.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    if (mapped) return isPrivateAddress(mapped[1]);
    const embedded = /(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    if (embedded) return isPrivateAddress(embedded[1]);
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
// resolves to instead of reaching for a name it does not control.
const assertResolvesPublic = async (hostname, resolve) => {
  const literal = isPrivateAddress(hostname);
  if (literal === false) return;
  let addresses;
  try { addresses = await resolve(hostname, { all: true, verbatim: true }); }
  catch { refuse('BROWSER_DNS_FAILED'); }
  if (!addresses.length) refuse('BROWSER_DNS_EMPTY');
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address) === true)
      refuse('BROWSER_ADDRESS_REFUSED', 'the host resolves to a non-public address');
  }
};

// Read the body with a hard ceiling. A page that streams without end is refused rather than
// buffered, because the ceiling exists to bound memory and a body that ignores Content-Length
// would otherwise decide how much we allocate.
const readBounded = async (response) => {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > LIMITS.maxBytes) refuse('BROWSER_BODY_TOO_LARGE');
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body ?? []) {
    total += chunk.length;
    if (total > LIMITS.maxBytes) { try { await response.body?.cancel(); } catch { /* already refused */ } refuse('BROWSER_BODY_TOO_LARGE'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const assertContentType = (response) => {
  const raw = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.includes(raw))
    refuse('BROWSER_CONTENT_TYPE_REFUSED', `content type ${raw || 'absent'} is not text`);
};

// Fetch one URL, following redirects by hand so that every hop meets the same policy. `redirect:
// manual` plus our own loop is the only way a hop can be checked; letting the runtime follow them
// would check the first URL and trust the rest.
export async function fetchPublicPage(rawUrl, { fetchImpl = fetch, lookup = dns.lookup } = {}) {
  let current = assertUrlAllowed(rawUrl);
  const seen = new Set();
  for (let hop = 0; hop <= LIMITS.maxRedirects; hop += 1) {
    if (seen.has(current.href)) refuse('BROWSER_REDIRECT_LOOP');
    seen.add(current.href);
    await assertResolvesPublic(current.hostname, lookup);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIMITS.timeoutMs);
    let response;
    try {
      response = await fetchImpl(current.href, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        // No cookies, no auth, no ambient state of any kind: the request says who it is by being
        // a GET and nothing else.
        credentials: 'omit',
        headers: { accept: 'text/html, text/plain' },
      });
    } catch (error) {
      clearTimeout(timer);
      if (error?.name === 'AbortError') refuse('BROWSER_TIMEOUT');
      refuse('BROWSER_FETCH_FAILED');
    }
    clearTimeout(timer);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      try { await response.body?.cancel(); } catch { /* nothing to release */ }
      if (!location) refuse('BROWSER_REDIRECT_WITHOUT_LOCATION');
      if (hop === LIMITS.maxRedirects) refuse('BROWSER_TOO_MANY_REDIRECTS');
      // Checked on the next iteration, by the same rules, before any connection is made to it.
      current = assertUrlAllowed(new URL(location, current.href).href);
      continue;
    }
    if (!response.ok) { try { await response.body?.cancel(); } catch { /* nothing to release */ } refuse('BROWSER_STATUS_REFUSED', `status ${response.status}`); }
    assertContentType(response);
    const body = await readBounded(response);
    return { url: current.href, finalUrl: current.href, status: response.status, body };
  }
  refuse('BROWSER_TOO_MANY_REDIRECTS');
}
