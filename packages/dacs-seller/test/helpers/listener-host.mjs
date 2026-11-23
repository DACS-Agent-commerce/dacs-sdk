// Unshipped fixture: listener options for the composed host, and clients that reach it the way a reverse proxy or a buyer does, with
// the public `Host` the host serves. `fetch` cannot set `Host`, so these use node:http, node:https and raw sockets.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http, { request as httpRequest } from 'node:http';
import https, { request as httpsRequest } from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { connect as netConnect } from 'node:net';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { FIXTURE_ENDPOINT } from './wire-buyer.mjs';

/** The authority the fixture Listing's endpoint names: the `Host` the host serves. */
export const LISTING_AUTHORITY = new URL(FIXTURE_ENDPOINT).host;
const OPENSSL_TIMEOUT_MS = 15_000;

/** A proxy-mode listener on an ephemeral loopback port for the fixture Listing's endpoint; `changes` replace members. */
export const proxyListener = (changes = {}) => ({ mode: 'proxy', host: '127.0.0.1', port: 0, publicOrigin: FIXTURE_ENDPOINT, ...changes });

/**
 * A tls-mode listener whose certificate is made at test time with `openssl`: self-signed, naming the Listing's authority, with its files
 * kept in `directory`. Returns `{ listener, ca }`: `ca` is what a client trusts (the certificate itself).
 */
export function tlsListener(directory, changes = {}) {
  const files = { key: join(directory, 'listener-key.pem'), cert: join(directory, 'listener-cert.pem') };
  const made = spawnSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=TEST-listener',
    '-addext', `subjectAltName=DNS:${LISTING_AUTHORITY.split(':')[0]}`, '-keyout', files.key, '-out', files.cert], { encoding: 'utf8', timeout: OPENSSL_TIMEOUT_MS });
  if (made.error || made.status !== 0) throw new Error('TEST certificate generation failed');
  const cert = readFileSync(files.cert, 'utf8');
  return { listener: { mode: 'tls', host: '127.0.0.1', port: 0, publicOrigin: FIXTURE_ENDPOINT, tls: { cert, key: readFileSync(files.key, 'utf8') }, ...changes }, ca: cert };
}

/**
 * Records every server the host creates, as `{ args, server }` with the arguments it was created with, until the test `t` ends. Call it
 * before the host starts.
 */
export function captureServers(t) {
  const created = [];
  for (const module of [http, https]) {
    const original = module.createServer;
    t.mock.method(module, 'createServer', (...args) => { const server = original(...args); created.push({ args, server }); return server; });
  }
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return created;
}

/** The `headersDistinct` that Node adds to a request, for a request double built from a `headers` object. */
export const distinctHeaders = (headers) => Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), [value].flat()]));

const headerValue = (value) => (Array.isArray(value) ? value.join(', ') : value);

/**
 * A `fetch` for one started host that sends `Host: authority` (the Listing's by default). A host in tls mode needs `ca`, the CA its
 * certificate was issued under. Supports the request methods, headers, string bodies and `signal` the seller clients use.
 */
export function fetchAsHost({ authority = LISTING_AUTHORITY, ca } = {}) {
  return (input, init = {}) => new Promise((resolve, reject) => {
    const url = new URL(input);
    const secure = url.protocol === 'https:';
    const tls = secure ? { ca, servername: authority.split(':')[0] } : {};
    const request = (secure ? httpsRequest : httpRequest)(url, { method: init.method ?? 'GET', headers: { host: authority, ...init.headers }, signal: init.signal, ...tls }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: Object.entries(res.headers).map(([name, value]) => [name, headerValue(value)]) })));
      res.on('error', reject);
    });
    request.on('error', reject);
    request.end(init.body);
  });
}

function dechunked(body) {
  const parts = [];
  let rest = body;
  for (;;) {
    const lineEnd = rest.indexOf('\r\n');
    const size = lineEnd < 0 ? 0 : parseInt(rest.slice(0, lineEnd), 16);
    if (!size) return parts.join('');
    parts.push(rest.slice(lineEnd + 2, lineEnd + 2 + size));
    rest = rest.slice(lineEnd + 2 + size + 2);
  }
}

/**
 * Sends `text` (a complete HTTP request that asks for `connection: close`) to `port` as it is written and returns what the host answers
 * once it closes the connection: `{ status, headers, body }`, or `{ status: null }` when it closes with no answer. `ca` makes the
 * connection TLS under that trust.
 */
export function rawExchange({ port, text, ca }) {
  return new Promise((resolve, reject) => {
    const socket = ca === undefined ? netConnect({ host: '127.0.0.1', port }) : tlsConnect({ host: '127.0.0.1', port, ca, servername: LISTING_AUTHORITY.split(':')[0] });
    const chunks = [];
    socket.on(ca === undefined ? 'connect' : 'secureConnect', () => socket.write(text));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', (error) => { if (error.code !== 'ECONNRESET') reject(error); });
    socket.on('close', () => {
      const answer = Buffer.concat(chunks).toString('utf8');
      const split = answer.indexOf('\r\n\r\n');
      if (split < 0) { resolve({ status: null, headers: {}, body: '' }); return; }
      const [statusLine, ...lines] = answer.slice(0, split).split('\r\n');
      const headers = Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()]));
      const body = answer.slice(split + 4);
      resolve({ status: Number(statusLine.split(' ')[1]), headers, body: headers['transfer-encoding'] === 'chunked' ? dechunked(body) : body });
    });
  });
}

/** The text of a POST: `headers` are `[name, value]` pairs (a name may repeat), and the `Host` and `connection: close` lines are added unless named. */
export function requestText({ method = 'POST', target, headers = [], body = '', host = LISTING_AUTHORITY, version = 'HTTP/1.1' }) {
  const lines = headers.map(([name, value]) => `${name}: ${value}`);
  const named = (wanted) => headers.some(([name]) => name.toLowerCase() === wanted);
  if (host !== null && !named('host')) lines.unshift(`Host: ${host}`);
  if (!named('connection')) lines.push('connection: close');
  if (body !== '' && !named('content-length') && !named('transfer-encoding')) lines.push(`content-length: ${Buffer.byteLength(body)}`);
  return `${method} ${target} ${version}\r\n${lines.join('\r\n')}\r\n\r\n${body}`;
}
