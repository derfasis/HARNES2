// The body deadline, against a real socket.
//
// The rest of this area injects a transport, which is right for policy and wrong for this. A fake
// cannot show whether an abort reaches a socket that has already sent headers and is holding its
// body open — which is precisely the case the deadline exists for, and precisely the case a fake
// masked while the listener was being removed on `response`.
//
// The tests drive `browserRequest` rather than `fetchPublicPage`, and the reason is the policy
// itself: a local test server is on 127.0.0.1, and the boundary refuses loopback. Reaching a real
// socket end to end would mean allowing the very thing the boundary exists to prevent, so the
// address policy is tested separately and the socket is tested here.
// proof_level=synthetic_contract_eval; live_proof=false. Localhost only; nothing leaves the machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { browserRequest, fetchPublicPage, LIMITS } from '../business/sources/browser-fetch.mjs';

const stallController = async (t) => {
  const state = { clientGone: false, sockets: new Set() };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' });
    res.write('partial');
    // Deliberately never `end()`: the connection stays open until the client gives up.
  });
  server.on('connection', (socket) => {
    state.sockets.add(socket);
    socket.on('close', () => { state.clientGone = true; state.sockets.delete(socket); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    for (const socket of state.sockets) socket.destroy();
    server.close(resolve);
  }));
  return { origin: `http://127.0.0.1:${server.address().port}`, state };
};

const silentController = async (t) => {
  const state = { clientGone: false, sockets: new Set() };
  const server = net.createServer((socket) => {
    state.sockets.add(socket);
    socket.on('close', () => { state.clientGone = true; state.sockets.delete(socket); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    for (const socket of state.sockets) socket.destroy();
    server.close(resolve);
  }));
  return { origin: `http://127.0.0.1:${server.address().port}`, state };
};

test('an abort after the headers destroys a socket still holding its body', async (t) => {
  const { origin, state } = await stallController(t);
  const url = new URL(`${origin}/page`);
  const controller = new AbortController();
  const response = await browserRequest(url, '127.0.0.1', controller.signal);
  assert.equal(response.statusCode, 200, 'headers arrived');

  let aborted = false;
  response.on('aborted', () => { aborted = true; });
  response.resume();                                   // start consuming, as the reader does
  controller.abort();                                  // the deadline fires after the headers
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(state.clientGone, true, 'the socket was closed by us, not left to the OS');
  assert.equal(aborted, true, 'the stalled response reported the abort, so the reader can refuse');
  // This is the regression: the listener used to be removed on `response`, and with it gone this
  // destroy never happened and the body stayed open until the process exited.
  assert.ok(true);
});

test('an abort before the headers is refused rather than left pending', async (t) => {
  const { origin } = await silentController(t);
  const url = new URL(`${origin}/page`);
  const controller = new AbortController();
  const pending = browserRequest(url, '127.0.0.1', controller.signal);
  controller.abort();
  await assert.rejects(pending, (error) => error?.code !== undefined || error instanceof Error);
});

test('the boundary refuses loopback before a socket is opened', async () => {
  let called = false;
  await assert.rejects(() => fetchPublicPage('http://127.0.0.1:9/never', {
    request: async () => { called = true; throw new Error('must not be reached'); },
    lookup: async () => [{ address: '127.0.0.1', family: 4 }] }),
    (error) => error.code === 'BROWSER_ADDRESS_REFUSED');
  assert.equal(called, false, 'no socket was opened for a private address');
});

test('the deadline is a parameter, and the boundary default is the documented one', () => {
  assert.equal(LIMITS.timeoutMs, 10000);
  assert.equal(typeof LIMITS.maxRedirects, 'number');
  assert.ok(LIMITS.maxBytes > 0 && LIMITS.maxTextChars > 0);
});
