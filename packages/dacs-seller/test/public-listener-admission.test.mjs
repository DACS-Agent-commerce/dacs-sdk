// Raw request admission on the composed host: what each listener mode refuses before any state is touched. Every request is real HTTP text
// over loopback, so the checks run on the bytes Node's parser delivers. A refusal must leave the agent uncalled, the wire journal files as they
// were and the store's rows as they were.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { DACS_SELLER_HTTP_HEADER, DACS_SELLER_HTTP_PATHS } from '@kynesyslabs/dacs/wire';
import { createSellerHttpHandler } from '../src/dacs/seller-http.mjs';
import { contextHostFixture } from './helpers/host-context-client.mjs';
import { LISTING_AUTHORITY, captureServers, distinctHeaders, proxyListener, rawExchange, requestText, tlsListener } from './helpers/listener-host.mjs';
import { NOW } from './helpers/protocol-fixture.mjs';
import { privateModule } from './helpers/private-module.mjs';
import { FIXTURE_ENDPOINT } from './helpers/wire-buyer.mjs';
import { world as routesWorld } from './helpers/wire-routes-world.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const WINDOW_REQUESTS = 120;
const WINDOW_MS = 60_000;
const CONCURRENT_REQUESTS = 8;
const MAX_ENVELOPE_CHARS = 4096;
const MAX_HEADER_BYTES = 16 * 1024;
// The host mounts every route but the commit-on-signature one, which only a handler made with `commitOnSignature` serves.
const POST_ROUTES = Object.values(DACS_SELLER_HTTP_PATHS).filter((path) => path !== DACS_SELLER_HTTP_PATHS.commitmentSignature);
const JSON_HEADERS = [['content-type', 'application/json']];
const PAYMENTS = DACS_SELLER_HTTP_PATHS.payments;

// The host module with a counting view of the agent the handler and the wire context call.
const countingHost = await privateModule(new URL('../src/host.mjs', import.meta.url), ['setAgentObserver'], (source) => source
  .replace('const REQUIRED =', 'let observeAgent = (agent) => agent; function setAgentObserver(value) { const seen = new WeakMap(); observeAgent = (agent) => { if (!seen.has(agent)) seen.set(agent, value(agent)); return seen.get(agent); }; }\nconst REQUIRED =')
  .replace('now, agent, requireDelegation: false', 'now, agent: observeAgent(agent), requireDelegation: false')
  .replace('createSellerHttpHandler(agent,', 'createSellerHttpHandler(observeAgent(agent),'));
const agentCalls = { count: 0 };
countingHost.setAgentObserver((agent) => new Proxy(agent, { get: (target, key) => {
  const value = Reflect.get(target, key, target);
  return typeof value === 'function' ? (...args) => { agentCalls.count++; return value.apply(target, args); } : value;
} }));

/**
 * A started host in `mode` for a Listing at `publicEndpoint`. `send(text)` writes one raw request and answers `{ status, headers, body }`;
 * `state()` reads the agent call count, the wire journal's files and the store's rows; `requests` counts the requests Node handed the handler.
 */
async function admissionWorld(t, { mode = 'proxy', publicEndpoint = FIXTURE_ENDPOINT, hostChanges = {} } = {}) {
  const created = captureServers(t);
  const f = await contextHostFixture(t, { publicEndpoint, startHost: countingHost.startSellerHost });
  const certificates = await mkdtemp(join(tmpdir(), 'TEST-listener-admission-'));
  t.after(() => rm(certificates, { recursive: true, force: true }));
  const tls = mode === 'tls' ? tlsListener(certificates, { publicOrigin: publicEndpoint }) : { listener: proxyListener({ publicOrigin: publicEndpoint }), ca: undefined };
  const host = await f.start({ listener: tls.listener, ...hostChanges });
  const port = Number(new URL(host.url).port);
  const world = { f, host, port, ca: tls.ca, requests: 0 };
  created[0].server.on('request', () => { world.requests++; });
  world.buyer = await f.buyerFor(host, { ca: tls.ca });
  world.send = (text) => rawExchange({ port, text, ca: tls.ca });
  world.state = () => {
    const journal = join(f.dataDirectory, 'wire-journal');
    const db = new Database(join(f.dataDirectory, 'transport', 'transport.sqlite'), { readonly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(({ name }) => name).sort();
      return { agent: agentCalls.count, journal: readdirSync(journal).sort().map((name) => [name, statSync(join(journal, name)).size]),
        rows: Object.fromEntries(tables.map((name) => [name, db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n])) };
    } finally { db.close(); }
  };
  agentCalls.count = 0;
  world.before = world.state();
  return world;
}
const errorOf = (answer) => { try { return JSON.parse(answer.body).error; } catch { return undefined; } };

/** Sends `text`, then checks the answer's status (and error code when named) and that nothing was called or written. */
async function assertRefused(world, text, { status, error }, label) {
  const answer = await world.send(text);
  assert.equal(answer.status, status, `${label}: status (${answer.body})`);
  if (error !== undefined) assert.equal(errorOf(answer), error, `${label}: error`);
  assert.equal(answer.headers[DACS_SELLER_HTTP_HEADER], undefined, `${label}: the refusal is unsigned`);
  assert.deepEqual(world.state(), world.before, `${label}: the agent, the journal and the store are untouched`);
  return answer;
}
const post = (target, { headers = JSON_HEADERS, ...rest } = {}) => requestText({ target, headers, ...rest });
// A POST whose declared body is never sent: a handler that reads the body before it refuses would wait for it.
const unsentBody = (target, headers = JSON_HEADERS, host) => requestText({ target, headers: [...headers, ['content-length', String(MAX_BODY_BYTES + 1)]], ...(host === undefined ? {} : { host }) });

test('an unsigned request is refused before any effect in both modes', async (t) => {
  for (const mode of ['proxy', 'tls']) {
    const world = await admissionWorld(t, { mode });
    const answer = await assertRefused(world, post(PAYMENTS, { body: '{"jobId":"01J8N4YV7YVYQ4DB7M8T4C7W0A"}' }), { status: 401 }, `${mode}: no envelope`);
    assert.match(errorOf(answer), /^peer_/);
    await assertRefused(world, post(PAYMENTS, { headers: [...JSON_HEADERS, [DACS_SELLER_HTTP_HEADER, 'AAAA']], body: '{}' }), { status: 401 }, `${mode}: an envelope that is not one`);
  }
});

test('wrong, missing and duplicate Host answer 421 before the body or authentication, with a valid and an invalid signature alike', async (t) => {
  for (const mode of ['proxy', 'tls']) {
    const world = await admissionWorld(t, { mode });
    const signed = await world.buyer.signedChallenge();
    const invalid = `${signed.header.slice(0, -4)}AAAA`;
    for (const [signature, header] of [['valid', signed.header], ['invalid', invalid]]) {
      const peer = [...JSON_HEADERS, [DACS_SELLER_HTTP_HEADER, header]];
      const cases = {
        'another name': { host: 'other.example.invalid' },
        'the loopback address': { host: `127.0.0.1:${world.port}` },
        'the right name and a port': { host: `${LISTING_AUTHORITY}:8443` },
        'no Host (HTTP/1.0)': { host: null, version: 'HTTP/1.0' },
        'two Host lines': { host: null, headers: [...peer, ['Host', LISTING_AUTHORITY], ['Host', LISTING_AUTHORITY]] },
        'a forwarded host and another Host': { host: 'other.example.invalid', headers: [...peer, ['x-forwarded-host', LISTING_AUTHORITY]] },
      };
      for (const [label, { headers = peer, ...rest }] of Object.entries(cases)) {
        // A declared body over the limit is never sent: a host that read the body or answered 413 first would not answer 421.
        const text = requestText({ target: signed.path, headers: [...headers, ['content-length', String(MAX_BODY_BYTES + 1)]], ...rest });
        await assertRefused(world, text, { status: 421, error: 'host_not_served' }, `${mode}, ${signature} signature, ${label}`);
      }
    }
  }
});

test('an IP-literal or trailing-dot Host that differs from the Listing authority answers 421', async (t) => {
  const world = await admissionWorld(t);
  for (const host of ['seller.example.invalid.', '127.0.0.1', '[::1]', '192.0.2.1', 'SELLER.example.invalid.', `seller.example.invalid.:443`]) {
    await assertRefused(world, unsentBody(PAYMENTS, JSON_HEADERS, host), { status: 421, error: 'host_not_served' }, host);
  }
});

test('a Listing whose endpoint is an IP literal or ends in a dot is served under its exact matching Host', async (t) => {
  for (const [endpoint, authority, wrong] of [['https://192.0.2.10', '192.0.2.10', ['192.0.2.10.', '192.0.2.11']], ['https://seller.example.invalid.', 'seller.example.invalid.', ['seller.example.invalid']]]) {
    const world = await admissionWorld(t, { publicEndpoint: endpoint });
    const served = await world.send(requestText({ method: 'GET', target: '/nothing', host: authority }));
    assert.equal(served.status, 404, `${authority} is served`);
    for (const host of wrong) await assertRefused(world, requestText({ method: 'GET', target: '/nothing', host }), { status: 421, error: 'host_not_served' }, host);
  }
});

test('both default-port spellings are accepted when the origin names no port and other ports are refused', async (t) => {
  const bare = await admissionWorld(t);
  for (const host of [LISTING_AUTHORITY, `${LISTING_AUTHORITY}:443`, LISTING_AUTHORITY.toUpperCase()]) {
    assert.equal((await bare.send(requestText({ method: 'GET', target: '/nothing', host }))).status, 404, host);
  }
  for (const host of [`${LISTING_AUTHORITY}:80`, `${LISTING_AUTHORITY}:8443`, `${LISTING_AUTHORITY}:0443`, `${LISTING_AUTHORITY}:`, `${LISTING_AUTHORITY}:4430`]) {
    await assertRefused(bare, requestText({ method: 'GET', target: '/nothing', host }), { status: 421, error: 'host_not_served' }, host);
  }
  const ported = await admissionWorld(t, { publicEndpoint: 'https://seller.example.invalid:8443' });
  assert.equal((await ported.send(requestText({ method: 'GET', target: '/nothing', host: 'seller.example.invalid:8443' }))).status, 404);
  for (const host of [LISTING_AUTHORITY, `${LISTING_AUTHORITY}:443`]) {
    await assertRefused(ported, requestText({ method: 'GET', target: '/nothing', host }), { status: 421, error: 'host_not_served' }, host);
  }
});

test('X-Forwarded-Host, X-Forwarded-For, X-Forwarded-Proto and Forwarded never substitute for Host or authentication', async (t) => {
  const world = await admissionWorld(t);
  const forwarded = [['x-forwarded-host', LISTING_AUTHORITY], ['x-forwarded-for', '127.0.0.1'], ['x-forwarded-proto', 'https'], ['forwarded', `for=127.0.0.1;host=${LISTING_AUTHORITY};proto=https`]];
  await assertRefused(world, unsentBody(PAYMENTS, [...JSON_HEADERS, ...forwarded], 'other.example.invalid'), { status: 421, error: 'host_not_served' }, 'forwarded headers beside a wrong Host');
  await assertRefused(world, post(PAYMENTS, { headers: [...JSON_HEADERS, ...forwarded], body: '{}' }), { status: 401 }, 'forwarded headers beside the right Host and no signature');
});

test('kit sources read no forwarding header', () => {
  const scan = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? scan(path) : entry.name.endsWith('.mjs') ? [path] : [];
  });
  for (const path of scan(fileURLToPath(new URL('../src', import.meta.url)))) assert.doesNotMatch(readFileSync(path, 'utf8'), /['"`.[](?:x-)?forwarded(?:-[a-z]+)?['"`\]]/i, path);
});

test('raw route aliases (query, double slash, percent-encoding, trailing slash, absolute-form, case) answer 404 for every mounted route', async (t) => {
  const world = await admissionWorld(t);
  const aliases = (path) => [`${path}?x=1`, `${path}?`, `/${path}`, path.replace('/v1/', '/%76%31/'), `${path}%2F`, `${path}/`, `${path}/.`, `https://${LISTING_AUTHORITY}${path}`, path.toUpperCase(), path.replace('dacs', 'Dacs'), `${path}%00`];
  for (const path of POST_ROUTES) {
    for (const target of aliases(path)) await assertRefused(world, post(target, { body: '{}' }), { status: 404, error: 'not_found' }, target);
  }
});

test('GET, HEAD, PUT and OPTIONS on POST routes answer 405 and a lowercase method answers 400', async (t) => {
  const world = await admissionWorld(t);
  for (const path of POST_ROUTES) {
    for (const method of ['GET', 'HEAD', 'PUT', 'OPTIONS', 'DELETE', 'PATCH']) await assertRefused(world, requestText({ method, target: path }), { status: 405 }, `${method} ${path}`);
    const lowercase = await world.send(requestText({ method: 'post', target: path, headers: JSON_HEADERS, body: '{}' }));
    assert.equal(lowercase.status, 400, `post ${path}`);
    assert.equal(errorOf(lowercase), undefined, 'the parser answers, not the handler');
  }
  assert.equal(world.requests, POST_ROUTES.length * 6, 'only the requests the parser accepted reached the handler');
});

test('duplicate peer, content-type or content-encoding headers answer 400 duplicate_header before the body is read', async (t) => {
  const world = await admissionWorld(t);
  const signed = await world.buyer.signedChallenge();
  const peer = [DACS_SELLER_HTTP_HEADER, signed.header];
  const cases = {
    'two peer headers': [...JSON_HEADERS, peer, peer],
    'two peer headers of different values': [...JSON_HEADERS, peer, [DACS_SELLER_HTTP_HEADER, 'AAAA']],
    'two content types': [...JSON_HEADERS, ['content-type', 'application/json'], peer],
    'two content types of different values': [...JSON_HEADERS, ['content-type', 'text/plain'], peer],
    'two content encodings': [...JSON_HEADERS, ['content-encoding', 'identity'], ['content-encoding', 'identity'], peer],
  };
  for (const [label, headers] of Object.entries(cases)) await assertRefused(world, unsentBody(signed.path, headers), { status: 400, error: 'duplicate_header' }, label);
});

test('duplicate Content-Length and duplicate Transfer-Encoding get the parser\'s 400 with no handler call', async (t) => {
  const world = await admissionWorld(t);
  const before = world.requests;
  const cases = {
    'two equal Content-Length lines': [['content-length', '2'], ['content-length', '2']],
    'two different Content-Length lines': [['content-length', '2'], ['content-length', '3']],
    'two Transfer-Encoding lines': [['transfer-encoding', 'chunked'], ['transfer-encoding', 'chunked']],
  };
  for (const [label, headers] of Object.entries(cases)) {
    const answer = await world.send(requestText({ target: PAYMENTS, headers: [...JSON_HEADERS, ...headers], body: '{}' }));
    assert.equal(answer.status, 400, label);
    assert.equal(errorOf(answer), undefined, `${label}: the parser answers, not the handler`);
  }
  assert.equal(world.requests, before, 'no handler call');
  assert.deepEqual(world.state(), world.before);
});

test('unsupported content type and non-identity encoding answer 415', async (t) => {
  const world = await admissionWorld(t);
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'application/json5', 'application/jsonx']) {
    await assertRefused(world, unsentBody(PAYMENTS, [['content-type', type]]), { status: 415, error: 'json_required' }, type);
  }
  await assertRefused(world, unsentBody(PAYMENTS, []), { status: 415, error: 'json_required' }, 'no content type');
  for (const encoding of ['gzip', 'br', 'deflate']) {
    await assertRefused(world, unsentBody(PAYMENTS, [...JSON_HEADERS, ['content-encoding', encoding]]), { status: 415, error: 'encoded_body_unsupported' }, encoding);
  }
});

test('a declared body over 64 KiB answers 413 before reading', async (t) => {
  const world = await admissionWorld(t);
  await assertRefused(world, unsentBody(PAYMENTS), { status: 413, error: 'body_too_large' }, 'declared over the limit');
});

test('a chunked body over 64 KiB answers 413 with no journal file and no agent call', async (t) => {
  const world = await admissionWorld(t);
  const size = MAX_BODY_BYTES + 1;
  const body = `${size.toString(16)}\r\n${'a'.repeat(size)}\r\n0\r\n\r\n`;
  await assertRefused(world, requestText({ target: PAYMENTS, headers: [...JSON_HEADERS, ['transfer-encoding', 'chunked']], body }), { status: 413, error: 'body_too_large' }, 'chunked over the limit');
  assert.equal(world.state().journal.length, world.before.journal.length);
});

test('Content-Length with Transfer-Encoding is refused by the parser', async (t) => {
  const world = await admissionWorld(t);
  const before = world.requests;
  const answer = await world.send(requestText({ target: PAYMENTS, headers: [...JSON_HEADERS, ['transfer-encoding', 'chunked'], ['content-length', '2']], body: '2\r\n{}\r\n0\r\n\r\n' }));
  assert.equal(answer.status, 400);
  assert.equal(errorOf(answer), undefined);
  assert.equal(world.requests, before);
});

test('a body slower than the body deadline answers 408 (mock timers)', async (t) => {
  const world = await admissionWorld(t);
  const socket = netConnect({ host: '127.0.0.1', port: world.port });
  const chunks = [];
  socket.on('data', (chunk) => chunks.push(chunk));
  socket.on('error', () => {});
  await once(socket, 'connect');
  const requested = world.requests;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  socket.write(requestText({ target: PAYMENTS, headers: [...JSON_HEADERS, ['content-length', '100']], body: '' }) + '{"jobId"');
  while (world.requests === requested) await new Promise((resolve) => setImmediate(resolve));
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(5000);
  await once(socket, 'close');
  const answer = Buffer.concat(chunks).toString('utf8');
  assert.match(answer, /^HTTP\/1\.1 408 /);
  assert.match(answer, /"error":"body_timeout"/);
  assert.deepEqual(world.state(), world.before);
});

test('a 4,097-character envelope is peer_envelope_invalid 401, headers over 16 KiB answer 431, and a 4,096-character envelope passes the size check', async (t) => {
  const world = await admissionWorld(t);
  const send = (header) => world.send(post(PAYMENTS, { headers: [...JSON_HEADERS, [DACS_SELLER_HTTP_HEADER, header]], body: '{}' }));
  const tooLong = await send('A'.repeat(MAX_ENVELOPE_CHARS + 1));
  assert.equal(tooLong.status, 401);
  assert.equal(errorOf(tooLong), 'peer_envelope_invalid');
  const atLimit = await send('A'.repeat(MAX_ENVELOPE_CHARS));
  assert.equal(atLimit.status, 401);
  assert.notEqual(errorOf(atLimit), 'peer_envelope_invalid', 'the size check passed and the bytes were refused for what they are');
  const huge = await world.send(post(PAYMENTS, { headers: [...JSON_HEADERS, ['x-filler', 'a'.repeat(MAX_HEADER_BYTES + 1)]], body: '{}' }));
  assert.equal(huge.status, 431);
  assert.deepEqual(world.state(), world.before);
});

test('the 121st request in a window answers 429 and the window resets (controllable clock)', async (t) => {
  const clock = { now: NOW };
  const world = await admissionWorld(t, { hostChanges: { now: () => clock.now } });
  for (let n = 1; n <= WINDOW_REQUESTS; n++) assert.equal((await world.send(requestText({ method: 'GET', target: '/nothing' }))).status, 404, `request ${n}`);
  const limited = await world.send(requestText({ method: 'GET', target: '/nothing' }));
  assert.equal(limited.status, 429);
  assert.equal(errorOf(limited), 'seller_rate_limited');
  clock.now += WINDOW_MS - 1;
  assert.equal((await world.send(requestText({ method: 'GET', target: '/nothing' }))).status, 429, 'the window has not ended');
  clock.now += 1;
  assert.equal((await world.send(requestText({ method: 'GET', target: '/nothing' }))).status, 404, 'the window has reset');
});

test('a ninth concurrent request answers 429 while eight are in flight', async (t) => {
  const world = await admissionWorld(t);
  const held = [];
  for (let n = 0; n < CONCURRENT_REQUESTS; n++) {
    const socket = netConnect({ host: '127.0.0.1', port: world.port });
    socket.on('error', () => {});
    await once(socket, 'connect');
    const requested = world.requests;
    socket.write(requestText({ target: PAYMENTS, headers: [...JSON_HEADERS, ['content-length', '10']] }));
    while (world.requests === requested) await new Promise((resolve) => setImmediate(resolve));
    held.push(socket);
  }
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
  const ninth = await world.send(requestText({ method: 'GET', target: '/nothing' }));
  assert.equal(ninth.status, 429);
  assert.equal(errorOf(ninth), 'seller_rate_limited');
  const closed = held.map((socket) => once(socket, 'close'));
  for (const socket of held) socket.destroy();
  await Promise.all(closed);
  let answered = 429;
  for (let attempt = 0; attempt < 50 && answered === 429; attempt++) {
    answered = (await world.send(requestText({ method: 'GET', target: '/nothing' }))).status;
    if (answered === 429) await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(answered, 404, 'the slots of the ended requests are free again');
});

test('refused requests count against the window and release their concurrency slot', async (t) => {
  const clock = { now: NOW };
  const world = await admissionWorld(t, { hostChanges: { now: () => clock.now } });
  const refusals = [
    requestText({ method: 'GET', target: PAYMENTS }),
    requestText({ method: 'GET', target: '/nothing', host: 'other.example.invalid' }),
    unsentBody(PAYMENTS, [['content-type', 'text/plain']]),
    unsentBody(PAYMENTS),
  ];
  // More refusals in a row than the concurrency limit: each one gave its slot back.
  for (let n = 0; n < WINDOW_REQUESTS; n++) assert.notEqual((await world.send(refusals[n % refusals.length])).status, 429, `refusal ${n + 1}`);
  const limited = await world.send(refusals[0]);
  assert.equal(limited.status, 429, 'the refusals used the window');
  clock.now += WINDOW_MS;
  assert.equal((await world.send(refusals[0])).status, 405);
});

test('a signed request through proxy mode with the right Host reaches the wire check', async (t) => {
  const world = await admissionWorld(t);
  const answer = await world.buyer.challenge();
  assert.equal(answer.status, 200, answer.text);
  assert.equal(answer.signed, true);
  assert.match(answer.body.sessionNonce, /^[A-Za-z0-9_-]{22,86}$/);
});

test('a request from a non-loopback socket is refused in proxy mode and reaches the Host check in tls mode', async (t) => {
  const w = await routesWorld(t);
  const answerFor = async (listener) => {
    const handler = createSellerHttpHandler(w.agent, { wire: w.handle.wire, commitOnSignature: true, listener });
    const headers = { host: 'other.example.invalid', 'content-type': 'application/json' };
    const req = Object.assign(new PassThrough(), { url: PAYMENTS, method: 'POST', headers, headersDistinct: distinctHeaders(headers), socket: { remoteAddress: '203.0.113.9', localAddress: '10.0.0.5' } });
    const res = { destroyed: false, writableEnded: false, headersSent: false, writeHead(status) { this.status = status; }, end(body) { this.text = body; this.writableEnded = true; } };
    await handler(req, res);
    return { status: res.status, error: JSON.parse(res.text).error };
  };
  assert.deepEqual(await answerFor({ mode: 'proxy', expectedHost: LISTING_AUTHORITY }), { status: 403, error: 'loopback_only' });
  assert.deepEqual(await answerFor({ mode: 'tls', expectedHost: LISTING_AUTHORITY }), { status: 421, error: 'host_not_served' });
});
