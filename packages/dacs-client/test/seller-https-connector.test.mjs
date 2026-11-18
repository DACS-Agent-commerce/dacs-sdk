// The pinned HTTPS connector against a real TLS server on loopback. A DNS stub
// returns a public address that is never contacted; the injected request
// function only maps that admitted address to the loopback server. Request
// creation, TLS verification, writes and response parsing are Node's own, so
// every byte count is measured at the server.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before, mock } from 'node:test';
import tls from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { resolveDacsPublicHostV1 } from '@kynesyslabs/dacs';
import { DACS_SELLER_DISCOVERY_PATH, DACS_SELLER_HTTP_PATHS } from '@kynesyslabs/dacs/wire';
import { sellerFailureCause } from '../src/dacs/seller-http.mjs';
import { createSellerHttpsConnector, SellerHttpsConnectorError } from '../src/dacs/seller-https-connector.mjs';
import { createLoopbackTestCa } from './helpers/loopback-test-ca.mjs';
import { createLoopbackTestTlsMaterial } from './helpers/loopback-test-tls.mjs';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const connectorPath = join(packageDir, 'src/dacs/seller-https-connector.mjs');
const HOST = 'seller.example.test';
const PUBLIC_A = '8.8.8.8';
const PUBLIC_B = '1.1.1.1';
const PUBLIC_V6 = '2606:4700:4700::1111';
const ORIGIN = `https://${HOST}:8443`;
const PATH = DACS_SELLER_HTTP_PATHS.proposals;
const BODY = new TextEncoder().encode('{"proposal":1}');
const LIMITS = { deadlineMs: 10_000, maxResponseBytes: 1024, maxResponseHeaderBytes: 2048 };
const HEADERS = { accept: 'application/json', 'content-type': 'application/json' };
const HOUR_MS = 3_600_000;

let root;
let pki;
let leaves;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'seller-https-connector-'));
  pki = createLoopbackTestCa(root);
  const now = Date.now();
  const names = `DNS:${HOST},DNS:a.example.test,DNS:b.example.test,IP:${PUBLIC_A},IP:${PUBLIC_V6}`;
  leaves = {
    valid: pki.issue(now + HOUR_MS, { san: names }),
    ipOnly: pki.issue(now + HOUR_MS, { san: `IP:${PUBLIC_A}` }),
    expired: pki.issue(now - HOUR_MS, { san: `DNS:${HOST}` }),
    notYetValid: pki.issue(now + 2 * HOUR_MS, { san: `DNS:${HOST}`, startMs: now + HOUR_MS }),
    wrongHost: pki.issue(now + HOUR_MS, { san: 'DNS:other.example.test' }),
    selfSigned: createLoopbackTestTlsMaterial({ san: `DNS:${HOST}` }),
  };
});
after(() => rmSync(root, { recursive: true, force: true }));

const requestComplete = (buffer) => {
  const end = buffer.indexOf('\r\n\r\n');
  if (end < 0) return false;
  const length = /^content-length: *(\d+)/im.exec(buffer.subarray(0, end).toString('latin1'));
  return buffer.length - end - 4 >= Number(length?.[1] ?? 0);
};
const head = (status, headers) => `HTTP/1.1 ${status} Test\r\n${Object.entries({ connection: 'close', ...headers }).map(([name, value]) => `${name}: ${value}\r\n`).join('')}\r\n`;
const reply = (socket, status, headers = {}, body = '') => {
  const payload = Buffer.from(body);
  socket.end(Buffer.concat([Buffer.from(head(status, { 'content-length': payload.length, ...headers })), payload]));
};
const CHUNK = Buffer.from(`400\r\n${'x'.repeat(1024)}\r\n`);
const endless = (socket, status, headers = {}, { stall = false } = {}) => {
  socket.write(head(status, { 'transfer-encoding': 'chunked', ...headers }));
  const pump = () => {
    while (!socket.destroyed && socket.write(CHUNK) && !stall);
    if (!socket.destroyed && !stall) socket.once('drain', pump);
  };
  pump();
};

// A raw TLS server: it counts connections and request bytes and lets each test answer.
async function startSeller(t, material, respond = () => {}) {
  const seen = { connections: 0, bytes: 0, requests: [], servernames: [], sockets: [] };
  let markConnected;
  let markRequested;
  const connected = new Promise((resolve) => { markConnected = resolve; });
  const requested = new Promise((resolve) => { markRequested = resolve; });
  const server = tls.createServer(material, (socket) => {
    seen.connections++;
    seen.sockets.push(socket);
    seen.servernames.push(socket.servername);
    markConnected();
    socket.on('error', () => {});
    let received = Buffer.alloc(0);
    let answered = false;
    socket.on('data', (chunk) => {
      seen.bytes += chunk.length;
      received = Buffer.concat([received, chunk]);
      if (answered || !requestComplete(received)) return;
      answered = true;
      seen.requests.push(received);
      markRequested();
      respond(socket, received);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { seen.sockets.forEach((socket) => socket.destroy()); server.close(); });
  return { port: server.address().port, seen, connected, requested };
}
const originOf = (seller, host = HOST) => `https://${host}:${seller.port}`;
const closed = (seller) => Promise.all(seller.seen.sockets.map((socket) => (socket.destroyed ? null : once(socket, 'close'))));
const flush = () => new Promise((resolve) => setImmediate(resolve));
const gate = () => {
  let open;
  let enter;
  const opened = new Promise((resolve) => { open = resolve; });
  const entered = new Promise((resolve) => { enter = resolve; });
  return { wait: () => { enter(); return opened; }, entered, open };
};

const counts = (emitter) => Object.fromEntries(emitter.eventNames().map((name) => [name, emitter.listenerCount(name)]));
const OWNED_EVENTS = { req: ['socket', 'error'], socket: ['connect', 'secureConnect'], res: ['data', 'end', 'error', 'aborted', 'close'] };

// The connector's own request function seam: Node's real https.request, with the
// admitted address mapped to loopback and the test CA trusted.
function rig({ ca = pki.ca, resolveHost = async () => [PUBLIC_A], lookupGate, onRequest, onResponse } = {}) {
  const seen = { resolved: [], options: [], admitted: [], traces: [] };
  const request = (options, callback) => {
    seen.options.push(options);
    const trace = {};
    const literal = net.isIP(options.hostname) !== 0;
    const mapped = literal ? { hostname: '127.0.0.1', host: '127.0.0.1', checkServerIdentity: options.checkServerIdentity ?? ((_name, cert) => tls.checkServerIdentity(options.hostname, cert)) } : {};
    const req = https.request({
      ...options, ...mapped, ca,
      lookup: (host, lookupOptions, done) => options.lookup(host, lookupOptions, (error, answer, family) => {
        seen.admitted.push(`${host}=${Array.isArray(answer) ? answer[0].address : answer}`);
        const finish = () => (Array.isArray(answer) ? done(error, [{ address: '127.0.0.1', family: 4 }]) : done(error, '127.0.0.1', family));
        if (lookupGate) lookupGate.wait().then(finish); else finish();
      }),
    }, (res) => {
      trace.res = res; trace.resBaseline = counts(res);
      onResponse?.(res);
      callback(res);
    });
    trace.req = req; trace.reqBaseline = counts(req);
    req.once('socket', (socket) => { trace.socket = socket; trace.socketBaseline = counts(socket); });
    seen.traces.push(trace);
    onRequest?.(req);
    return req;
  };
  const connector = createSellerHttpsConnector({ resolveHost: (host) => { seen.resolved.push(host); return resolveHost(host); }, request });
  return { connector, seen };
}
const send = (connector, origin, extra = {}) => connector.send({ origin, path: PATH, method: 'POST', headers: HEADERS, body: BODY, ...LIMITS, ...extra });

async function failure(promise, expected) {
  const error = await promise.then(() => assert.fail('expected the call to be refused'), (reason) => reason);
  assert.ok(error instanceof SellerHttpsConnectorError, String(error?.stack));
  assert.deepEqual({ phase: error.phase, causeCode: error.causeCode, dispatched: error.dispatched }, expected);
  assert.equal(sellerFailureCause(error.causeCode), error.causeCode);
  return error;
}
const refused = (phase, causeCode) => ({ phase, causeCode, dispatched: false });
const unknown = (phase, causeCode) => ({ phase, causeCode, dispatched: 'unknown' });

// Listeners the connector registers must be gone, its timers cleared and its socket closed.
function assertReleased(trace, liveTimers) {
  assert.equal(liveTimers.size, 0, 'a connector timer is still pending');
  for (const [key, emitter, baseline] of [['req', trace.req, trace.reqBaseline], ['socket', trace.socket, trace.socketBaseline], ['res', trace.res, trace.resBaseline]]) {
    if (!emitter) continue;
    for (const name of OWNED_EVENTS[key]) assert.ok(emitter.listenerCount(name) <= (baseline[name] ?? 0) + (name === 'error' ? 1 : 0), `${key} still has ${name} listeners`);
  }
  assert.equal(trace.socket?.destroyed ?? true, true, 'the socket is still open');
}
function trackTimers(t) {
  const live = new Set();
  const { setTimeout: set, clearTimeout: clear } = globalThis;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...rest) => {
    const timer = set(() => { live.delete(timer); callback(...rest); }, ms);
    live.add(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', (timer) => { live.delete(timer); clear(timer); });
  return live;
}

test('admits a public answer and connects to the admitted address', async (t) => {
  const seller = await startSeller(t, leaves.valid, (socket) => reply(socket, 200, {}, 'ok'));
  const { connector, seen } = rig();
  const result = await send(connector, originOf(seller));
  assert.equal(result.status, 200);
  assert.ok(result.body instanceof Uint8Array);
  assert.equal(Buffer.from(result.body).toString(), 'ok');
  assert.deepEqual(seen.resolved, [HOST]);
  assert.deepEqual(seen.admitted, [`${HOST}=${PUBLIC_A}`]);
  assert.equal(seller.seen.connections, 1);
  const [options] = seen.options;
  options.lookup('other.example.test', { all: true }, (error, answers) => assert.deepEqual([error, answers], [null, [{ address: PUBLIC_A, family: 4 }]]));
  options.lookup('other.example.test', {}, (error, address, family) => assert.deepEqual([error, address, family], [null, PUBLIC_A, 4]));
  assert.deepEqual([options.agent, options.rejectUnauthorized, options.servername, options.maxHeaderSize], [false, true, HOST, LIMITS.maxResponseHeaderBytes]);
});

test('refuses private, loopback, link-local, shared, documentation and unique-local answers before connecting with dispatched false', async () => {
  for (const address of ['10.0.0.1', '127.0.0.1', '169.254.1.1', '100.64.0.1', '192.0.2.1', '203.0.113.9', 'fc00::1', '::1', 'fe80::1', '2001:db8::1']) {
    const { connector, seen } = rig({ resolveHost: async () => [address] });
    await failure(send(connector, ORIGIN), refused('admit', 'address'));
    assert.equal(seen.traces.length, 0, address);
  }
});

test('refuses mixed public and private answers with no connection', async () => {
  for (const answers of [[PUBLIC_A, '10.0.0.1'], ['10.0.0.1', PUBLIC_A], [PUBLIC_A, 'not-an-address']]) {
    const { connector, seen } = rig({ resolveHost: async () => answers });
    await failure(send(connector, ORIGIN), refused('admit', 'address'));
    assert.equal(seen.traces.length, 0);
  }
});

test('empty DNS answer and DNS failure have distinct causes and dispatched false', async () => {
  const emptyRig = rig({ resolveHost: async () => [] });
  const empty = await failure(send(emptyRig.connector, ORIGIN), refused('admit', 'address'));
  const lookupError = Object.assign(new Error('lookup failed'), { code: 'ENOTFOUND' });
  const failedRig = rig({ resolveHost: async () => { throw lookupError; } });
  const failed = await failure(send(failedRig.connector, ORIGIN), refused('resolve', 'network'));
  assert.equal(failed.cause, lookupError);
  assert.notEqual(empty.causeCode, failed.causeCode);
  assert.equal(emptyRig.seen.traces.length + failedRig.seen.traces.length, 0);
});

test('verifies TLS for the hostname with SNI and never for the IP', async (t) => {
  const seller = await startSeller(t, leaves.valid, (socket) => reply(socket, 200));
  await send(rig().connector, originOf(seller));
  assert.deepEqual(seller.seen.servernames, [HOST]);
  const ipOnly = await startSeller(t, leaves.ipOnly);
  const error = await failure(send(rig().connector, originOf(ipOnly)), refused('tls', 'tls'));
  assert.equal(error.code, 'seller_tls_unusable');
  assert.equal(error.cause.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
  assert.equal(ipOnly.seen.bytes, 0);
});

test('a public IPv4 literal and an IPv6 literal origin connect without DNS and verify TLS against the literal with no SNI', async (t) => {
  const seller = await startSeller(t, leaves.valid, (socket) => reply(socket, 200));
  for (const origin of [`https://${PUBLIC_A}:${seller.port}`, `https://[${PUBLIC_V6}]:${seller.port}`]) {
    const { connector, seen } = rig({ resolveHost: resolveDacsPublicHostV1 });
    assert.equal((await send(connector, origin)).status, 200);
    assert.equal(seen.options[0].hostname, new URL(origin).hostname.replace(/^\[|\]$/g, ''));
    assert.equal(seen.options[0].servername, undefined);
    assert.deepEqual(seen.admitted, []);
  }
  assert.deepEqual(seller.seen.servernames.map(Boolean), [false, false]);
});

test('an IPv6 literal origin is refused when the certificate does not list that address', async (t) => {
  const seller = await startSeller(t, leaves.ipOnly, (socket) => reply(socket, 200));
  const error = await failure(send(rig({ resolveHost: resolveDacsPublicHostV1 }).connector, `https://[${PUBLIC_V6}]:${seller.port}`), refused('tls', 'tls'));
  assert.equal(error.cause.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
  assert.equal(seller.seen.bytes, 0);
});

test('65 DNS answers are refused before connecting and 64 public answers are admitted', async (t) => {
  const seller = await startSeller(t, leaves.valid, (socket) => reply(socket, 200));
  const answers = (count) => Array.from({ length: count }, (_, index) => `8.8.${index >> 8}.${index & 255}`);
  let touched = 0;
  const watched = new Proxy(answers(65), { get: (target, key, receiver) => { if (typeof key === 'string' && /^\d+$/.test(key)) touched++; return Reflect.get(target, key, receiver); } });
  const over = rig({ resolveHost: async () => watched });
  await failure(send(over.connector, originOf(seller)), refused('admit', 'address'));
  assert.deepEqual([touched, over.seen.traces.length, seller.seen.connections], [0, 0, 0]);
  const exact = rig({ resolveHost: async () => answers(64) });
  assert.equal((await send(exact.connector, originOf(seller))).status, 200);
});

test('default dependencies refuse a loopback origin and only injected test dependencies reach the loopback server', async (t) => {
  const seller = await startSeller(t, leaves.valid, (socket) => reply(socket, 200));
  await failure(send(createSellerHttpsConnector(), `https://127.0.0.1:${seller.port}`), refused('admit', 'address'));
  await failure(send(createSellerHttpsConnector(), `https://[::1]:${seller.port}`), refused('admit', 'address'));
  assert.equal(seller.seen.connections, 0);
  assert.equal((await send(rig().connector, originOf(seller))).status, 200);
  assert.equal(seller.seen.connections, 1);
});

test('the packed archive contains the connector file and neither index.mjs nor the archive exports a connector, resolver or CA option', async () => {
  const cache = join(root, 'npm-cache');
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: packageDir, encoding: 'utf8', env: { ...process.env, npm_config_cache: cache } }));
  assert.ok(packed.files.some((file) => file.path === 'src/dacs/seller-https-connector.mjs'));
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  assert.doesNotMatch(JSON.stringify(manifest.exports), /connector/);
  const exported = Object.keys(await import('../src/index.mjs'));
  assert.deepEqual(exported.filter((name) => /connector|resolve|^ca$|certificate/i.test(name)), []);
});

const CHILD = `
import https from 'node:https';
const { createSellerHttpsConnector } = await import(process.argv[1]);
const request = (options, callback) => https.request({ ...options, lookup: (host, lookupOptions, done) => (lookupOptions.all ? done(null, [{ address: '127.0.0.1', family: 4 }]) : done(null, '127.0.0.1', 4)) }, callback);
const connector = createSellerHttpsConnector({ resolveHost: async () => ['8.8.8.8'], request });
const outcome = await connector.send({ origin: process.argv[2], path: process.argv[3], method: 'POST', headers: {}, body: new Uint8Array(), deadlineMs: 10000, maxResponseBytes: 1024, maxResponseHeaderBytes: 2048 })
  .then((result) => ({ status: result.status }), (error) => ({ code: error.code, phase: error.phase }));
console.log(JSON.stringify(outcome));
`;
test('NODE_TLS_REJECT_UNAUTHORIZED, HTTPS_PROXY, HTTP_PROXY, NO_PROXY and NODE_USE_ENV_PROXY in a child process leave verification on and the connection direct', async (t) => {
  const seller = await startSeller(t, leaves.valid, (socket) => reply(socket, 200));
  let proxied = 0;
  const proxy = net.createServer((socket) => { proxied++; socket.destroy(); });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => proxy.close());
  const caFile = join(root, 'child-ca.pem');
  writeFileSync(caFile, pki.ca);
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const environment = { PATH: process.env.PATH, NODE_TLS_REJECT_UNAUTHORIZED: '0', HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, NO_PROXY: '', NODE_USE_ENV_PROXY: '1' };
  const runChild = async (extra) => JSON.parse((await promisify(execFile)(process.execPath, ['--input-type=module', '-e', CHILD, pathToFileURL(connectorPath).href, originOf(seller), PATH], { env: { ...environment, ...extra }, timeout: 30_000 })).stdout);
  assert.deepEqual(await runChild({}), { code: 'seller_tls_unusable', phase: 'tls' });
  assert.equal(seller.seen.bytes, 0);
  assert.deepEqual(await runChild({ NODE_EXTRA_CA_CERTS: caFile }), { status: 200 });
  assert.equal(seller.seen.connections, 1);
  assert.equal(proxied, 0);
});

const TLS_REFUSALS = [
  ['an expired leaf fails seller_tls_unusable with its expiry cause, dispatched false and zero request bytes', 'expired', 'CERT_HAS_EXPIRED'],
  ['a not-yet-valid leaf fails seller_tls_unusable with its not-yet-valid cause, dispatched false and zero request bytes', 'notYetValid', 'CERT_NOT_YET_VALID'],
  ['an untrusted leaf fails seller_tls_unusable with its trust cause, dispatched false and zero request bytes', 'selfSigned', 'DEPTH_ZERO_SELF_SIGNED_CERT'],
  ['a wrong-host leaf fails seller_tls_unusable with its host-mismatch cause, dispatched false and zero request bytes', 'wrongHost', 'ERR_TLS_CERT_ALTNAME_INVALID'],
];
for (const [name, leaf, nodeCode] of TLS_REFUSALS) {
  test(name, async (t) => {
    const seller = await startSeller(t, leaves[leaf], (socket) => reply(socket, 200));
    const error = await failure(send(rig().connector, originOf(seller)), refused('tls', 'tls'));
    assert.equal(error.code, 'seller_tls_unusable');
    assert.equal(error.cause.code, nodeCode);
    assert.equal(seller.seen.bytes, 0);
  });
}

test('a presently valid trusted same-host leaf from the same CA connects and the request reaches the server', async (t) => {
  const seller = await startSeller(t, leaves.valid, (socket) => reply(socket, 200, {}, 'found'));
  const { connector } = rig();
  assert.equal((await send(connector, originOf(seller))).status, 200);
  const raw = seller.seen.requests[0];
  assert.ok(raw.toString('latin1').startsWith(`POST ${PATH} `));
  assert.deepEqual([...raw.subarray(raw.length - BODY.length)], [...BODY]);
  const discovery = await connector.send({ origin: originOf(seller), path: DACS_SELLER_DISCOVERY_PATH, method: 'GET', headers: { accept: 'application/json' }, ...LIMITS });
  assert.equal(discovery.status, 200);
});

test('a connection lost after the request was written reports dispatched unknown', async (t) => {
  const seller = await startSeller(t, leaves.valid, (socket) => socket.destroy());
  const error = await failure(send(rig().connector, originOf(seller)), unknown('response-headers', 'network'));
  assert.equal(error.cause.code, 'ECONNRESET');
  assert.equal(seller.seen.requests.length, 1);
});

test('a DNS answer that turns private on the second request is refused', async (t) => {
  const seller = await startSeller(t, leaves.valid, (socket) => reply(socket, 200));
  const answers = [[PUBLIC_A], ['10.0.0.1']];
  const { connector, seen } = rig({ resolveHost: async () => answers.shift() });
  assert.equal((await send(connector, originOf(seller))).status, 200);
  await failure(send(connector, originOf(seller)), refused('admit', 'address'));
  assert.deepEqual([seen.resolved.length, seen.traces.length, seller.seen.connections], [2, 1, 1]);
});

test('two requests open two connections, each to its own admitted address', async (t) => {
  const seller = await startSeller(t, leaves.valid, (socket) => reply(socket, 200));
  const answers = [[PUBLIC_A], [PUBLIC_B]];
  const { connector, seen } = rig({ resolveHost: async () => answers.shift() });
  const results = await Promise.all([send(connector, originOf(seller)), send(connector, originOf(seller))]);
  assert.deepEqual(results.map((result) => result.status), [200, 200]);
  assert.deepEqual(seen.admitted.sort(), [`${HOST}=${PUBLIC_B}`, `${HOST}=${PUBLIC_A}`].sort());
  assert.equal(seller.seen.connections, 2);
});

test('a redirect is returned unread and its Location is never contacted', async (t) => {
  const elsewhere = await startSeller(t, leaves.valid, (socket) => reply(socket, 200));
  const seller = await startSeller(t, leaves.valid, (socket) => reply(socket, 302, { location: `${originOf(elsewhere)}/moved` }, 'moved'));
  const { connector, seen } = rig();
  const result = await send(connector, originOf(seller));
  assert.equal(result.status, 302);
  assert.equal(result.body.length, 0);
  assert.equal(result.headers.location, `${originOf(elsewhere)}/moved`);
  assert.equal(seen.traces[0].socket.destroyed, true);
  assert.equal(elsewhere.seen.connections, 0);
  assert.equal(seen.traces.length, 1);
});

test('an endless redirect body and a response refused from its headers are destroyed unread and their socket is closed', async (t) => {
  for (const [status, headers, outcome] of [[302, { location: '/moved' }, 'result'], [200, { 'content-encoding': 'gzip' }, 'refusal']]) {
    const seller = await startSeller(t, leaves.valid, (socket) => endless(socket, status, headers));
    const { connector, seen } = rig();
    const settled = send(connector, originOf(seller));
    if (outcome === 'result') assert.equal((await settled).body.length, 0);
    else await failure(settled, unknown('response-headers', 'other'));
    const [trace] = seen.traces;
    assert.equal(trace.res.destroyed, true);
    assert.equal(trace.socket.destroyed, true);
    assert.ok(trace.socket.bytesRead < 256 * 1024);
  }
});

test('an endless 4xx or 5xx body is cut at the byte bound and, separately, at the deadline, with bounded bytes read, its request, response and socket closed, no partial body returned and dispatched unknown', async (t) => {
  for (const status of [409, 503]) {
    const seller = await startSeller(t, leaves.valid, (socket) => endless(socket, status));
    const { connector, seen } = rig();
    const error = await failure(send(connector, originOf(seller)), unknown('response-body', 'oversized'));
    const [trace] = seen.traces;
    assert.deepEqual([trace.req.destroyed, trace.res.destroyed, trace.socket.destroyed], [true, true, true]);
    assert.ok(trace.socket.bytesRead < LIMITS.maxResponseBytes + 256 * 1024);
    assert.equal('body' in error, false);
  }
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const stalled = await startSeller(t, leaves.valid, (socket) => endless(socket, 503, {}, { stall: true }));
  const responded = gate();
  const { connector, seen } = rig({ onResponse: () => responded.wait() });
  const pending = send(connector, originOf(stalled), { maxResponseBytes: 1 << 20 });
  await responded.entered;
  mock.timers.tick(LIMITS.deadlineMs);
  const error = await failure(pending, unknown('response-body', 'timeout'));
  assert.equal('body' in error, false);
  assert.deepEqual([seen.traces[0].req.destroyed, seen.traces[0].res.destroyed, seen.traces[0].socket.destroyed], [true, true, true]);
});

test('finite 409 and 503 bodies within the bound are returned whole with their status and exact bytes', async (t) => {
  const exact = Buffer.from([0, 255, 10, 13, 123, 125]);
  for (const status of [409, 503]) {
    const seller = await startSeller(t, leaves.valid, (socket) => reply(socket, status, { 'content-type': 'application/json' }, exact));
    const result = await send(rig().connector, originOf(seller));
    assert.equal(result.status, status);
    assert.deepEqual([...result.body], [...exact]);
  }
});

test('each early response refusal, a parser failure and a throwing callback remove their listeners and timers and close the socket', async (t) => {
  const cases = [
    ['gzip', (socket) => reply(socket, 200, { 'content-encoding': 'gzip' }, 'x'), {}],
    ['status', (socket) => reply(socket, 600), {}],
    ['declared', (socket) => reply(socket, 200, {}, 'x'.repeat(2048)), {}],
    ['parser', (socket) => socket.end('this is not http\r\n\r\n'), {}],
    ['callback', (socket) => reply(socket, 200), { beforeTransmit: () => { throw new Error('stop'); } }],
  ];
  const live = trackTimers(t);
  for (const [label, respond, extra] of cases) {
    const seller = await startSeller(t, leaves.valid, respond);
    const { connector, seen } = rig();
    await send(connector, originOf(seller), extra).then(() => assert.fail(label), (error) => assert.ok(error instanceof SellerHttpsConnectorError, label));
    await flush();
    assertReleased(seen.traces[0], live);
  }
});

test('only allowlisted headers are sent with no cookie, authorization or proxy header', async (t) => {
  const seller = await startSeller(t, leaves.valid, (socket) => reply(socket, 200));
  const { connector, seen } = rig();
  await send(connector, originOf(seller), { headers: { ...HEADERS, 'x-dacs-seller-peer': 'peer-value' } });
  const names = seller.seen.requests[0].toString('latin1').split('\r\n\r\n')[0].split('\r\n').slice(1).map((line) => line.split(':')[0].toLowerCase());
  const allowed = ['host', 'accept', 'content-type', 'x-dacs-seller-peer', 'accept-encoding', 'user-agent', 'connection', 'content-length'];
  assert.deepEqual(names.filter((name) => !allowed.includes(name)), []);
  assert.match(seller.seen.requests[0].toString('latin1'), /^accept-encoding: identity\r$/im);
  for (const header of ['cookie', 'authorization', 'proxy-authorization', 'accept-encoding', 'host', 'Accept-Encoding']) {
    await failure(send(connector, originOf(seller), { headers: { ...HEADERS, [header]: 'x' } }), refused('admit', 'other'));
  }
  assert.equal(seen.traces.length, 1);
});

test('prepareTransmit is awaited after the TLS handshake with zero request bytes at the server, then beforeTransmit and the first byte follow in one synchronous turn', async (t) => {
  const seller = await startSeller(t, leaves.valid, (socket) => reply(socket, 200));
  const order = [];
  const held = gate();
  const { connector } = rig({ onRequest: (req) => { const end = req.end.bind(req); req.end = (...args) => { order.push('end'); return end(...args); }; } });
  const pending = send(connector, originOf(seller), {
    prepareTransmit: () => { order.push('prepare'); return held.wait(); },
    beforeTransmit: () => { order.push('before'); queueMicrotask(() => order.push('microtask')); },
  });
  await Promise.all([held.entered, seller.connected]);
  await flush(); await flush();
  assert.equal(seller.seen.bytes, 0);
  assert.deepEqual(order, ['prepare']);
  held.open();
  assert.equal((await pending).status, 200);
  assert.deepEqual(order, ['prepare', 'before', 'end', 'microtask']);
  assert.ok(seller.seen.bytes > 0);
});

test('prepareTransmit rejecting sends nothing, keeps its error as cause and reports dispatched false', async (t) => {
  const seller = await startSeller(t, leaves.valid, (socket) => reply(socket, 200));
  const cause = new Error('stop requested');
  const error = await failure(send(rig().connector, originOf(seller), { prepareTransmit: async () => { throw cause; } }), refused('prepare', 'other'));
  assert.equal(error.cause, cause);
  await closed(seller);
  assert.equal(seller.seen.bytes, 0);
});

test('the deadline expiring while prepareTransmit is pending reports timeout in phase prepare and its late resolution writes nothing', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const seller = await startSeller(t, leaves.valid, (socket) => reply(socket, 200));
  const held = gate();
  const before = mock.fn();
  const written = mock.fn();
  const { connector } = rig({ onRequest: (req) => { const end = req.end.bind(req); req.end = (...args) => { written(); return end(...args); }; } });
  const pending = send(connector, originOf(seller), { prepareTransmit: () => held.wait(), beforeTransmit: before });
  await held.entered;
  mock.timers.tick(LIMITS.deadlineMs);
  await failure(pending, refused('prepare', 'timeout'));
  held.open();
  await flush(); await flush();
  assert.deepEqual([before.mock.callCount(), written.mock.callCount(), seller.seen.bytes], [0, 0, 0]);
});

test('beforeTransmit throwing sends nothing, keeps its error as cause and reports dispatched false', async (t) => {
  const seller = await startSeller(t, leaves.valid, (socket) => reply(socket, 200));
  const cause = new Error('admission withdrawn');
  const error = await failure(send(rig().connector, originOf(seller), { beforeTransmit: () => { throw cause; } }), refused('prepare', 'other'));
  assert.equal(error.cause, cause);
  await closed(seller);
  assert.equal(seller.seen.bytes, 0);
});

test('deadline in resolve, connect, tls, response-headers and response-body each reports timeout with its phase, and releasing the blocked step afterwards opens no connection, writes no byte and leaves no unhandled rejection (mock timers)', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const unhandled = [];
  const record = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', record);
  t.after(() => process.off('unhandledRejection', record));
  const expire = async (pending) => { mock.timers.tick(LIMITS.deadlineMs); return pending; };

  const resolving = gate();
  const resolveRig = rig({ resolveHost: async () => { await resolving.wait(); return [PUBLIC_A]; } });
  const resolveSeller = await startSeller(t, leaves.valid);
  const resolvePending = send(resolveRig.connector, originOf(resolveSeller));
  await resolving.entered;
  await failure(expire(resolvePending), refused('resolve', 'timeout'));
  resolving.open();
  await flush(); await flush();
  assert.deepEqual([resolveRig.seen.traces.length, resolveSeller.seen.connections], [0, 0]);

  const connecting = gate();
  const connectSeller = await startSeller(t, leaves.valid);
  const connectRig = rig({ lookupGate: connecting });
  const connectPending = send(connectRig.connector, originOf(connectSeller));
  await connecting.entered;
  await failure(expire(connectPending), refused('connect', 'timeout'));
  connecting.open();
  await flush(); await flush();
  assert.equal(connectSeller.seen.connections, 0);

  const silentSockets = [];
  const silent = net.createServer((socket) => { socket.on('error', () => {}); silentSockets.push(socket); });
  silent.listen(0, '127.0.0.1');
  await once(silent, 'listening');
  t.after(() => { silentSockets.forEach((socket) => socket.destroy()); silent.close(); });
  const tlsRig = rig();
  const tlsPending = send(tlsRig.connector, `https://${HOST}:${silent.address().port}`);
  await once(silent, 'connection');
  while (tlsRig.seen.traces[0].socket?.connecting !== false) await flush();
  await failure(expire(tlsPending), refused('tls', 'timeout'));

  const unanswered = await startSeller(t, leaves.valid);
  const headersPending = send(rig().connector, originOf(unanswered));
  await unanswered.requested;
  await failure(expire(headersPending), unknown('response-headers', 'timeout'));
  assert.equal(unanswered.seen.requests.length, 1);

  const partial = await startSeller(t, leaves.valid, (socket) => endless(socket, 200, {}, { stall: true }));
  const responded = gate();
  const bodyPending = send(rig({ onResponse: () => responded.wait() }).connector, originOf(partial));
  await responded.entered;
  await failure(expire(bodyPending), unknown('response-body', 'timeout'));
  await flush(); await flush();
  assert.deepEqual(unhandled, []);
});

test('declared or streamed response bytes over the bound and oversized response headers are refused as oversized', async (t) => {
  const cases = [
    [(socket) => reply(socket, 200, {}, 'x'.repeat(LIMITS.maxResponseBytes + 1)), 'response-headers'],
    [(socket) => endless(socket, 200), 'response-body'],
    [(socket) => reply(socket, 200, { 'x-filler': 'a'.repeat(LIMITS.maxResponseHeaderBytes * 2) }), 'response-headers'],
  ];
  for (const [respond, phase] of cases) {
    const seller = await startSeller(t, leaves.valid, respond);
    await failure(send(rig().connector, originOf(seller)), unknown(phase, 'oversized'));
  }
  const exact = await startSeller(t, leaves.valid, (socket) => reply(socket, 200, {}, 'x'.repeat(LIMITS.maxResponseBytes)));
  assert.equal((await send(rig().connector, originOf(exact))).body.length, LIMITS.maxResponseBytes);
});

test('non-identity content-encoding and a status outside 200 to 599 are refused', async (t) => {
  const gzip = await startSeller(t, leaves.valid, (socket) => reply(socket, 200, { 'content-encoding': 'gzip' }, 'x'));
  await failure(send(rig().connector, originOf(gzip)), unknown('response-headers', 'other'));
  const outside = await startSeller(t, leaves.valid, (socket) => reply(socket, 600));
  await failure(send(rig().connector, originOf(outside)), unknown('response-headers', 'other'));
  const identity = await startSeller(t, leaves.valid, (socket) => reply(socket, 200, { 'content-encoding': 'identity' }, 'x'));
  assert.equal((await send(rig().connector, originOf(identity))).status, 200);
});

test('concurrent requests to two origins each connect only to their own admitted address', async (t) => {
  const seller = await startSeller(t, leaves.valid, (socket) => reply(socket, 200));
  const table = { 'a.example.test': PUBLIC_A, 'b.example.test': PUBLIC_B };
  const { connector, seen } = rig({ resolveHost: async (host) => [table[host]] });
  await Promise.all(Object.keys(table).map((host) => send(connector, originOf(seller, host))));
  assert.deepEqual(seen.admitted.sort(), Object.entries(table).map(([host, address]) => `${host}=${address}`));
  assert.equal(seller.seen.connections, 2);
});

test('no production module imports the connector yet', () => {
  const sources = readdirSync(join(packageDir, 'src'), { recursive: true }).filter((file) => file.endsWith('.mjs'));
  const importers = sources.filter((file) => file !== 'dacs/seller-https-connector.mjs' && /seller-https-connector/.test(readFileSync(join(packageDir, 'src', file), 'utf8')));
  assert.deepEqual(importers, []);
});

test('refuses origins that are not public endpoints and requests that are not seller routes before resolution', async () => {
  const origins = [`${ORIGIN}/path`, `${ORIGIN}?a=1`, `${ORIGIN}#f`, `https://user:pw@${HOST}`, `http://${HOST}`, `https:${HOST}`, `${ORIGIN} `, `${ORIGIN}\\`, `${ORIGIN}//`];
  const { connector, seen } = rig();
  for (const origin of origins) await failure(send(connector, origin), refused('admit', 'address'));
  const refusals = [{ path: '/dacs/v1/other' }, { path: `${PATH}?a=1` }, { method: 'GET' }, { method: 'PUT' }, { body: 'text' }, { body: undefined }, { deadlineMs: 0 }, { maxResponseBytes: Number.NaN }, { maxResponseHeaderBytes: -1 }];
  for (const extra of refusals) await failure(send(connector, ORIGIN, extra), refused('admit', 'other'));
  assert.deepEqual([seen.resolved.length, seen.traces.length], [0, 0]);
});

test('seller failure causes include address, redirect and oversized', () => {
  for (const cause of ['address', 'redirect', 'oversized', 'tls', 'network', 'timeout', 'other']) assert.equal(sellerFailureCause(cause), cause);
});
