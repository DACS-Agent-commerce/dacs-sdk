// The host's two public listener modes, on the composed host (`startSellerHost`): proxy mode (loopback behind a reverse proxy) and tls mode
// (a public address with the operator's certificate). Requests are real HTTP over loopback; TLS material is made at test time.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { chmodSync, readFileSync, readdirSync } from 'node:fs';
import { connect as netConnect, createServer as createNetServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect as tlsConnect } from 'node:tls';
import { createSellerHttpHandler } from '../src/dacs/seller-http.mjs';
import { contextHostFixture } from './helpers/host-context-client.mjs';
import { LISTING_AUTHORITY, captureServers, fetchAsHost, proxyListener, rawExchange, requestText, tlsListener } from './helpers/listener-host.mjs';
import { FIXTURE_ENDPOINT } from './helpers/wire-buyer.mjs';

const HEADER_DEADLINE_MS = 10_000;
const REQUEST_DEADLINE_MS = 15_000;
const KEEP_ALIVE_MS = 5_000;
const MAX_HEADER_BYTES = 16_384;
const MAX_HEADERS = 64;
const CONNECTION_CHECK_MS = 1_000;
const STATE_LOCK = 'seller-state.lock';
const lockExists = (directory) => access(join(directory, STATE_LOCK)).then(() => true, () => false);
const temporaryDirectory = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'TEST-listener-modes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};
const portOf = (host) => Number(new URL(host.url).port);
const refused = (code) => ({ name: 'TypeError', code });
const without = (record, key) => Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));

const freePort = () => new Promise((resolve, reject) => {
  const probe = createNetServer();
  probe.once('error', reject);
  probe.listen({ host: '127.0.0.1', port: 0 }, () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const bindable = (port) => new Promise((resolve) => {
  const probe = createNetServer();
  probe.once('error', () => resolve(false));
  probe.listen({ host: '127.0.0.1', port }, () => probe.close(() => resolve(true)));
});

test('start refuses without listener and with an unknown mode or extra member before the state lock', async (t) => {
  const f = await contextHostFixture(t);
  const { listener: tlsOnly } = tlsListener(await temporaryDirectory(t));
  const withoutPort = without(proxyListener(), 'port');
  const withoutMode = without(proxyListener(), 'mode');
  const cases = [
    ['no listener', undefined, /requires listener/],
    ['a string', 'proxy', refused('listener_invalid')],
    ['an array', [proxyListener()], refused('listener_invalid')],
    ['an unknown mode', proxyListener({ mode: 'plain' }), refused('listener_invalid')],
    ['no mode', withoutMode, refused('listener_invalid')],
    ['no port', withoutPort, refused('listener_invalid')],
    ['an extra member', proxyListener({ keepAlive: true }), refused('listener_invalid')],
    ['proxy with tls material', proxyListener({ tls: tlsOnly.tls }), refused('listener_invalid')],
    ['tls with an extra member', { ...tlsOnly, extra: 1 }, refused('listener_invalid')],
  ];
  for (const [label, listener, expected] of cases) {
    await assert.rejects(f.start({ listener }), expected, label);
    assert.equal(await lockExists(f.dataDirectory), false, `${label}: the state lock was taken`);
  }
});

test('proxy mode refuses every bind host except literal loopback', async (t) => {
  const f = await contextHostFixture(t);
  for (const host of ['0.0.0.0', '::', 'localhost', '192.0.2.1', '127.0.0.2', '[::1]', '::ffff:127.0.0.1', '', 127]) {
    await assert.rejects(f.start({ listener: proxyListener({ host }) }), refused('listener_invalid'), String(host));
  }
  for (const port of [-1, 65536, 1.5, '80', null]) await assert.rejects(f.start({ listener: proxyListener({ port }) }), refused('listener_invalid'), `port ${port}`);
  assert.equal(await lockExists(f.dataDirectory), false);
});

test('tls mode refuses to start without certificate and key', async (t) => {
  const f = await contextHostFixture(t);
  const { listener } = tlsListener(await temporaryDirectory(t));
  const { listener: other } = tlsListener(await temporaryDirectory(t));
  const withoutTls = without(listener, 'tls');
  const cases = [
    ['no tls member', withoutTls],
    ['tls not an object', { ...listener, tls: 'cert' }],
    ['no key', { ...listener, tls: { cert: listener.tls.cert } }],
    ['no certificate', { ...listener, tls: { key: listener.tls.key } }],
    ['an empty key', { ...listener, tls: { cert: listener.tls.cert, key: '' } }],
    ['an extra tls member', { ...listener, tls: { ...listener.tls, ca: listener.tls.cert } }],
    ['text that is not a certificate', { ...listener, tls: { cert: 'not a certificate', key: listener.tls.key } }],
    ['a key of another certificate', { ...listener, tls: { cert: listener.tls.cert, key: other.tls.key } }],
    ['a host that is not an IP literal', { ...listener, host: 'localhost' }],
  ];
  for (const [label, changed] of cases) {
    await assert.rejects(f.start({ listener: changed }), refused('listener_invalid'), label);
    assert.equal(await lockExists(f.dataDirectory), false, `${label}: the state lock was taken`);
  }
});

test('proxy mode serves on loopback and returns publicOrigin and the local url', async (t) => {
  const f = await contextHostFixture(t);
  const host = await f.start();
  assert.match(host.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(host.publicOrigin, FIXTURE_ENDPOINT);
  const answer = await fetchAsHost()(`${host.url}/nothing`);
  assert.equal(answer.status, 404);
  assert.deepEqual(await answer.json(), { error: 'not_found' });
});

test('tls mode serves HTTPS with the configured certificate and refuses plain HTTP on its port', async (t) => {
  const f = await contextHostFixture(t);
  const { listener, ca } = tlsListener(await temporaryDirectory(t));
  const host = await f.start({ listener });
  assert.match(host.url, /^https:\/\/127\.0\.0.1:\d+$/);
  assert.equal(host.publicOrigin, FIXTURE_ENDPOINT);
  const answer = await fetchAsHost({ ca })(`${host.url}/nothing`);
  assert.equal(answer.status, 404);
  const socket = tlsConnect({ host: '127.0.0.1', port: portOf(host), ca, servername: LISTING_AUTHORITY });
  await once(socket, 'secureConnect');
  assert.equal(socket.getPeerCertificate().raw.toString('base64'), Buffer.from(listener.tls.cert.match(/-----BEGIN CERTIFICATE-----([^-]+)-----END/)[1].replace(/\s/g, ''), 'base64').toString('base64'));
  socket.destroy();
  const plain = await rawExchange({ port: portOf(host), text: requestText({ target: '/nothing' }) });
  assert.equal(plain.status, null);
  await assert.rejects(fetchAsHost()(`${host.url}/nothing`), /./, 'a client that does not trust the certificate cannot connect');
});

test('publicOrigin refused by the wire endpoint rule refuses start', async (t) => {
  const rejected = ['https://seller.example.invalid/path', 'https://seller.example.invalid?a=1', 'https://seller.example.invalid#f', 'https://user:pw@seller.example.invalid',
    'http://seller.example.invalid', 'https:seller.example.invalid', 'https://seller.example.invalid ', 'https://seller.example.invalid\\', 'https://seller.example.invalid//'];
  for (const origin of rejected) {
    // The Listing names the same origin, so only the wire's endpoint rule can refuse it.
    const f = await contextHostFixture(t, { publicEndpoint: origin });
    await assert.rejects(f.start({ listener: proxyListener({ publicOrigin: origin }) }), { ...refused('listener_origin_mismatch'), message: /not a public endpoint/ }, JSON.stringify(origin));
    assert.equal(await lockExists(f.dataDirectory), false, JSON.stringify(origin));
  }
});

test('publicOrigin that differs from the Listing endpoint byte for byte refuses start', async (t) => {
  const listed = 'https://seller.example.invalid/';
  const f = await contextHostFixture(t, { publicEndpoint: listed });
  for (const origin of ['https://seller.example.invalid', 'https://SELLER.example.invalid/', 'https://seller.example.invalid:443/', FIXTURE_ENDPOINT]) {
    await assert.rejects(f.start({ listener: proxyListener({ publicOrigin: origin }) }), { ...refused('listener_origin_mismatch'), message: /differs from the Listing/ }, origin);
  }
  assert.equal(await lockExists(f.dataDirectory), false);
  const host = await f.start({ listener: proxyListener({ publicOrigin: listed }) });
  assert.equal(host.publicOrigin, listed);
});

test('no environment variable changes the mode and kit sources read only DACS_TEST_TRACE', async (t) => {
  const names = new Set();
  const scan = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { scan(path); continue; }
      if (!entry.name.endsWith('.mjs')) continue;
      for (const [, name] of readFileSync(path, 'utf8').matchAll(/process\.env\.([A-Za-z0-9_]+)/g)) names.add(name);
      assert.doesNotMatch(readFileSync(path, 'utf8'), /process\.env\[|process\.env\s*[,)}]|\{[^}]*\}\s*=\s*process\.env/, `${path} reads the environment by a computed name`);
    }
  };
  scan(fileURLToPath(new URL('../src', import.meta.url)));
  assert.deepEqual([...names].filter((name) => name !== 'DACS_TEST_TRACE'), []);
  const hostile = { DACS_LISTENER_MODE: 'tls', DACS_MODE: 'tls', LISTENER_MODE: 'tls', DACS_PUBLIC_ORIGIN: 'https://other.example.invalid', HOST: '0.0.0.0', PORT: '1', HTTPS_PROXY: 'http://127.0.0.1:9', NODE_ENV: 'production' };
  const previous = Object.fromEntries(Object.keys(hostile).map((name) => [name, process.env[name]]));
  Object.assign(process.env, hostile);
  t.after(() => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const f = await contextHostFixture(t);
  const host = await f.start();
  assert.match(host.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(host.publicOrigin, FIXTURE_ENDPOINT);
});

test('every listener refusal leaves no lock file and no bound port', async (t) => {
  const f = await contextHostFixture(t);
  const { listener } = tlsListener(await temporaryDirectory(t));
  const port = await freePort();
  const refusals = [
    proxyListener({ port, publicOrigin: 'https://other.example.invalid' }),
    proxyListener({ port, mode: 'plain' }),
    proxyListener({ port, host: '0.0.0.0' }),
    { ...listener, port, tls: { cert: listener.tls.cert, key: 'not a key' } },
    { ...listener, port, publicOrigin: 'http://seller.example.invalid' },
  ];
  for (const refusal of refusals) {
    await assert.rejects(f.start({ listener: refusal }), (error) => error instanceof TypeError && /^listener_/.test(error.code));
    assert.equal(await lockExists(f.dataDirectory), false);
    assert.deepEqual(await readdir(f.dataDirectory), []);
    assert.equal(await bindable(port), true);
  }
});

test('close then start again on the same port in each mode', async (t) => {
  const f = await contextHostFixture(t);
  const { listener: tlsMode } = tlsListener(await temporaryDirectory(t));
  for (const listener of [proxyListener(), tlsMode]) {
    const first = await f.start({ listener });
    const port = portOf(first);
    await first.close();
    assert.equal(await lockExists(f.dataDirectory), false);
    const second = await f.start({ listener: { ...listener, port } });
    assert.equal(portOf(second), port);
    await assert.rejects(f.start({ listener: { ...listener, port: 0 } }), { code: 'seller_state_locked' });
    await second.close();
  }
});

test('the handler cannot be built without the authentication adapter', () => {
  const agent = { claim: 'did:demos:agent:TEST', retainsPaymentWork: () => false, assertSettlementCredit: async () => {} };
  assert.throws(() => createSellerHttpHandler(agent, {}), { name: 'TypeError', message: /createWireContext/ });
  assert.throws(() => createSellerHttpHandler(agent), { name: 'TypeError', message: /createWireContext/ });
  assert.throws(() => createSellerHttpHandler(agent, { wire: {} }), { name: 'TypeError', message: /createWireContext/ });
  assert.throws(() => createSellerHttpHandler(agent, { authentication: {} }), { name: 'TypeError', message: /no longer takes `authentication`/ });
});

test('both modes set headersTimeout 10,000, requestTimeout 15,000, keepAliveTimeout 5,000, maxHeaderSize 16,384, maxHeadersCount 64 and connectionsCheckingInterval 1,000', async (t) => {
  const created = captureServers(t);
  const f = await contextHostFixture(t);
  const { listener: tlsMode } = tlsListener(await temporaryDirectory(t));
  for (const [listener, creator] of [[proxyListener(), http.createServer], [tlsMode, https.createServer]]) {
    created.length = 0;
    const host = await f.start({ listener });
    assert.equal(created.length, 1);
    const [{ args: [options], server }] = created;
    assert.equal(server.headersTimeout, HEADER_DEADLINE_MS);
    assert.equal(server.requestTimeout, REQUEST_DEADLINE_MS);
    assert.equal(server.keepAliveTimeout, KEEP_ALIVE_MS);
    assert.equal(server.maxHeaderSize, MAX_HEADER_BYTES);
    assert.equal(server.maxHeadersCount, MAX_HEADERS);
    assert.equal(server.connectionsCheckingInterval, CONNECTION_CHECK_MS);
    assert.equal(options.maxHeaderSize, MAX_HEADER_BYTES);
    assert.equal(options.connectionsCheckingInterval, CONNECTION_CHECK_MS);
    if (listener.mode === 'tls') assert.equal(options.handshakeTimeout, HEADER_DEADLINE_MS);
    assert.deepEqual(host.timeouts, { headersTimeout: HEADER_DEADLINE_MS, requestTimeout: REQUEST_DEADLINE_MS, keepAliveTimeout: KEEP_ALIVE_MS });
    assert.equal(typeof creator, 'function');
    await host.close();
  }
});

// A client socket that holds the connection without finishing what the server waits for: in proxy mode the request line and part of a
// header, in tls mode nothing at all, so the handshake never finishes.
async function heldSocket({ host, mode }) {
  const socket = netConnect({ host: '127.0.0.1', port: portOf(host) });
  socket.on('error', () => {});
  await once(socket, 'connect');
  if (mode === 'proxy') socket.write(`POST /dacs/v1/payments HTTP/1.1\r\nHost: ${LISTING_AUTHORITY}\r\nx-unfinished: `);
  return socket;
}

// Closing the host while two clients hold unfinished connections and one request is dispatched: the held sockets are destroyed, the dispatched
// request is answered, close completes and the port starts again.
async function closeWithHeldSockets(t, mode) {
  const created = captureServers(t);
  const f = await contextHostFixture(t);
  const tls = mode === 'tls' ? tlsListener(await temporaryDirectory(t)) : { listener: proxyListener(), ca: undefined };
  const host = await f.start({ listener: tls.listener });
  const port = portOf(host);
  const [{ server }] = created;
  const dispatched = new Promise((resolve) => server.prependListener('request', resolve));
  const held = [await heldSocket({ host, mode }), await heldSocket({ host, mode })];
  // A valid signed request whose body is half sent: the host has dispatched it, and it ends only when the rest arrives.
  const buyer = await f.buyerFor(host, { ca: tls.ca });
  const signed = await buyer.signedChallenge();
  const text = requestText({ target: signed.path, headers: [['content-type', 'application/json'], ['x-dacs-seller-peer', signed.header]], body: signed.text });
  const cut = text.length - 10;
  const inflight = mode === 'tls' ? tlsConnect({ host: '127.0.0.1', port, ca: tls.ca, servername: LISTING_AUTHORITY }) : netConnect({ host: '127.0.0.1', port });
  const chunks = [];
  inflight.on('data', (chunk) => chunks.push(chunk));
  inflight.on('error', () => {});
  await once(inflight, mode === 'tls' ? 'secureConnect' : 'connect');
  inflight.write(text.slice(0, cut));
  await dispatched;
  const heldClosed = held.map((socket) => once(socket, 'close'));
  const closing = host.close();
  await Promise.all(heldClosed);
  inflight.write(text.slice(cut));
  await once(inflight, 'close');
  const answer = Buffer.concat(chunks).toString('utf8');
  assert.match(answer, /^HTTP\/1\.1 (200|503) /, 'the request dispatched before close was answered');
  await closing;
  assert.equal(await lockExists(f.dataDirectory), false);
  const again = await f.start({ listener: { ...tls.listener, port } });
  assert.equal(portOf(again), port);
}

test('close completes while a client holds an incomplete header (proxy mode), destroys that socket, lets an already dispatched request finish, and the same port starts again', (t) => closeWithHeldSockets(t, 'proxy'));
test('close completes while a client holds an unfinished TLS handshake (tls mode), destroys that socket, lets an already dispatched request finish, and the same port starts again', (t) => closeWithHeldSockets(t, 'tls'));

test('with the operation guard off each listener mode refuses kit_operation_guard_off before any socket or file', async (t) => {
  const directory = await temporaryDirectory(t);
  chmodSync(directory, 0o700);
  const script = `
    import { readdirSync } from 'node:fs';
    import { startSellerHost } from ${JSON.stringify(new URL('../src/host.mjs', import.meta.url).href)};
    const listeners = [
      { mode: 'proxy', host: '127.0.0.1', port: 0, publicOrigin: ${JSON.stringify(FIXTURE_ENDPOINT)} },
      { mode: 'tls', host: '127.0.0.1', port: 0, publicOrigin: ${JSON.stringify(FIXTURE_ENDPOINT)}, tls: { cert: 'cert', key: 'key' } },
    ];
    const codes = [];
    for (const listener of listeners) { try { await startSellerHost({ dataDirectory: ${JSON.stringify(directory)}, listener }); codes.push(null); } catch (error) { codes.push(error.code); } }
    console.log(JSON.stringify({ codes, entries: readdirSync(${JSON.stringify(directory)}), servers: process.getActiveResourcesInfo().filter((name) => name === 'TCPServerWrap') }));`;
  const options = (process.env.NODE_OPTIONS ?? '').split(' ').filter((option) => option !== '' && !option.includes('kit-guard-fixture.mjs')).join(' ');
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: options } });
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  assert.deepEqual(JSON.parse(child.stdout.trim().split('\n').at(-1)), { codes: ['kit_operation_guard_off', 'kit_operation_guard_off'], entries: [], servers: [] });
});
