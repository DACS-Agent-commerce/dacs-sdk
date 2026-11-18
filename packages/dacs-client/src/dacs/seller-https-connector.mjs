// The client's pinned HTTPS connector for seller traffic. Internal: it is not
// exported from index.mjs and takes no resolver, CA or loopback option from a caller.
//
// One call is one attempt with one deadline that starts before DNS. Every DNS
// answer must be a public address; the request then opens one fresh connection to
// the admitted address and verifies TLS for the origin's hostname. The attempt
// state decides who may still act: after a deadline or any refusal it is dead, its
// request, response and socket are destroyed, and a late DNS, TLS or callback
// result finds it dead and does nothing.
import https from 'node:https';
import { isIP } from 'node:net';
import { isDacsPublicAddressV1, resolveDacsPublicHostV1 } from '@kynesyslabs/dacs';
import { findDacsSellerHttpRoute, isPublicEndpoint } from '@kynesyslabs/dacs/wire';

/** The most DNS answers one lookup may return; the list is checked before it is processed. */
const MAX_SELLER_DNS_ANSWERS = 64;
// Node clamps a longer timer to 1 ms, which would expire the attempt at once.
const MAX_DEADLINE_MS = 2 ** 31 - 1;
const HTTPS_PORT = 443;
const MIN_STATUS = 200;
const MAX_STATUS = 599;
const USER_AGENT = 'dacs-seller-https/v1';
const ALLOWED_REQUEST_HEADERS = new Set(['accept', 'content-type', 'x-dacs-seller-peer']);
// Before `transmit` nothing has been written, so a failure there proves nothing was sent.
const PHASES_BEFORE_TRANSMIT = new Set(['resolve', 'admit', 'connect', 'tls', 'prepare']);
const DEFAULT_DEPENDENCIES = Object.freeze({ resolveHost: resolveDacsPublicHostV1, request: https.request });
const ignoreLateError = () => {};

/**
 * A failed connector call. `causeCode` is a seller failure cause, `phase` is where the
 * attempt stood, `dispatched` is false when nothing was written and 'unknown' from the
 * first write on, and `cause` is the underlying error. `code` is seller_tls_unusable
 * for a TLS failure before any request byte and seller_https_failed otherwise.
 */
export class SellerHttpsConnectorError extends Error {
  constructor(phase, causeCode, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SellerHttpsConnectorError';
    this.code = causeCode === 'tls' ? 'seller_tls_unusable' : 'seller_https_failed';
    this.causeCode = causeCode;
    this.phase = phase;
    this.dispatched = PHASES_BEFORE_TRANSMIT.has(phase) ? false : 'unknown';
  }
}
const invalidRequest = (message) => new SellerHttpsConnectorError('admit', 'other', message);

// The authority to act: once it is dead nothing is connected, written or settled again.
class Attempt {
  phase = 'admit';
  live = true;
  settled;
  #resolve;
  #reject;
  #timer;
  #listeners = [];
  #streams = [];

  constructor() {
    this.settled = new Promise((resolve, reject) => { this.#resolve = resolve; this.#reject = reject; });
  }

  startDeadline(deadlineMs) {
    this.#timer = setTimeout(() => this.fail(new SellerHttpsConnectorError(this.phase, 'timeout', 'seller https deadline expired')), deadlineMs);
  }

  assertLive() {
    if (!this.live) throw new Error('seller https attempt is over');
  }

  listen(emitter, event, listener) {
    emitter.on(event, listener);
    this.#listeners.push(() => emitter.off(event, listener));
  }

  adopt(stream) {
    this.#streams.push(stream);
  }

  succeed(result) {
    this.#finish(() => this.#resolve(result));
  }

  fail(error) {
    this.#finish(() => this.#reject(error));
  }

  // Invalidate first, then release: the first caller wins and every later one is ignored.
  #finish(settle) {
    if (!this.live) return;
    this.live = false;
    clearTimeout(this.#timer);
    this.#listeners.forEach((remove) => remove());
    for (const stream of this.#streams) { stream.on('error', ignoreLateError); stream.destroy(); }
    settle();
  }
}

function requestHeaders(headers) {
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) throw invalidRequest('request headers must be an object');
  const checked = { 'accept-encoding': 'identity', 'user-agent': USER_AGENT };
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (!ALLOWED_REQUEST_HEADERS.has(key) || typeof value !== 'string' || Object.hasOwn(checked, key)) throw invalidRequest('request header is not allowed');
    checked[key] = value;
  }
  return checked;
}

function checkCall(options) {
  const { origin, path, method, headers, body, deadlineMs, maxResponseBytes, maxResponseHeaderBytes, prepareTransmit, beforeTransmit } = options ?? {};
  if (!isPublicEndpoint(origin)) throw new SellerHttpsConnectorError('admit', 'address', 'origin is not a public https endpoint');
  const route = findDacsSellerHttpRoute(method, path);
  if (route === null) throw invalidRequest('method and path are not a seller route');
  if (route.method === 'GET' ? body !== undefined : !(body instanceof Uint8Array)) throw invalidRequest('request body does not fit the route');
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > MAX_DEADLINE_MS) throw invalidRequest('deadlineMs is not a usable timer');
  if (![maxResponseBytes, maxResponseHeaderBytes].every((bound) => Number.isSafeInteger(bound) && bound > 0)) throw invalidRequest('response bounds must be positive integers');
  return { url: new URL(origin), path, method, headers: requestHeaders(headers), body, deadlineMs, maxResponseBytes, maxResponseHeaderBytes, prepareTransmit, beforeTransmit };
}

async function lookupAnswers(resolveHost, hostname) {
  try {
    return await resolveHost(hostname);
  } catch (error) {
    throw new SellerHttpsConnectorError('resolve', causeCodeOf(error, 'resolve'), 'DNS resolution failed', error);
  }
}

// The count is checked first, so an oversized list is never walked.
function admitAnswers(answers) {
  if (!Array.isArray(answers) || answers.length === 0 || answers.length > MAX_SELLER_DNS_ANSWERS) throw new SellerHttpsConnectorError('admit', 'address', 'DNS answer count is outside 1 to 64');
  if (!answers.every((address) => typeof address === 'string' && isDacsPublicAddressV1(address))) throw new SellerHttpsConnectorError('admit', 'address', 'a DNS answer is not a public address');
  return answers[0];
}

// Both lookup callback shapes return only the admitted address.
function pinnedLookup(address) {
  const family = isIP(address);
  return (_hostname, options, callback) => {
    if (typeof options === 'object' && options !== null && options.all === true) callback(null, [Object.freeze({ address, family })]);
    else callback(null, address, family);
  };
}

const IP_NAME_PREFIX = 'IP Address:';
const canonicalIpv6 = (address) => new URL(`https://[${address}]/`).hostname;

// Node 22's own identity check cannot match a bare IPv6 literal (it ASCII-folds the
// literal to an empty name), so an IPv6 origin compares the literal with the
// certificate's IP names itself: exact canonical equality, and refusal on any quoted name.
function ipv6IdentityCheck(literal) {
  const expected = canonicalIpv6(literal);
  return (_name, certificate) => {
    const names = String(certificate.subjectaltname ?? '');
    const listed = !names.includes('"') && names.split(', ').some((name) => name.startsWith(IP_NAME_PREFIX) && isIP(name.slice(IP_NAME_PREFIX.length)) === 6 && canonicalIpv6(name.slice(IP_NAME_PREFIX.length)) === expected);
    return listed ? undefined : Object.assign(new Error('certificate does not list the IPv6 origin'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  };
}

function requestOptions({ url, path, method, headers, maxResponseHeaderBytes }, address) {
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
  return Object.freeze({
    protocol: 'https:', hostname, port: url.port === '' ? HTTPS_PORT : Number(url.port), path, method, headers,
    agent: false, servername: isIP(hostname) === 0 ? hostname : undefined, rejectUnauthorized: true,
    maxHeaderSize: maxResponseHeaderBytes, lookup: pinnedLookup(address),
    ...(isIP(hostname) === 6 ? { checkServerIdentity: ipv6IdentityCheck(hostname) } : {}),
  });
}

function causeCodeOf(error, phase) {
  const code = error?.code;
  if (code === 'HPE_HEADER_OVERFLOW') return 'oversized';
  if (code === 'ETIMEDOUT') return 'timeout';
  if (typeof code === 'string' && code.startsWith('HPE_')) return 'other';
  return phase === 'tls' ? 'tls' : 'network';
}

// The first write. After the stop check is awaited, the liveness check, beforeTransmit and
// the write run in one synchronous turn, so nothing can intervene before the first byte.
async function transmitAfterPrepare(req, call, attempt) {
  attempt.phase = 'prepare';
  await call.prepareTransmit?.();
  attempt.assertLive();
  call.beforeTransmit?.();
  attempt.phase = 'transmit';
  req.end(call.body);
  attempt.phase = 'response-headers';
}

function headerRefusal(res, maxResponseBytes) {
  const encoding = res.headers['content-encoding'];
  if (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity') return new SellerHttpsConnectorError('response-headers', 'other', 'response content-encoding is not identity');
  const declared = res.headers['content-length'];
  if (declared === undefined) return null;
  if (!/^\d+$/.test(declared)) return new SellerHttpsConnectorError('response-headers', 'other', 'response content-length is malformed');
  return Number(declared) > maxResponseBytes ? new SellerHttpsConnectorError('response-headers', 'oversized', 'declared response length exceeds the byte limit') : null;
}

function collectBody(res, maxResponseBytes, attempt) {
  attempt.phase = 'response-body';
  const chunks = [];
  let total = 0;
  attempt.listen(res, 'data', (chunk) => {
    total += chunk.length;
    if (total > maxResponseBytes) attempt.fail(new SellerHttpsConnectorError('response-body', 'oversized', 'response body exceeds the byte limit'));
    else chunks.push(chunk);
  });
  attempt.listen(res, 'end', () => {
    if (!res.complete) attempt.fail(new SellerHttpsConnectorError('response-body', 'network', 'response ended before it was complete'));
    else attempt.succeed({ status: res.statusCode, headers: Object.freeze({ ...res.headers }), body: new Uint8Array(Buffer.concat(chunks)) });
  });
  attempt.listen(res, 'error', (error) => attempt.fail(new SellerHttpsConnectorError('response-body', causeCodeOf(error, 'response-body'), 'response failed', error)));
  attempt.listen(res, 'close', () => attempt.fail(new SellerHttpsConnectorError('response-body', 'network', 'connection closed before the response ended')));
}

// A redirect and a response refused from its headers are destroyed unread; every other
// status is read through the same bound, so a signed 409 or 503 reaches the caller whole.
function readResponse(res, call, attempt) {
  if (!attempt.live) { res.destroy(); return; }
  attempt.adopt(res);
  const { statusCode: status } = res;
  if (!(status >= MIN_STATUS && status <= MAX_STATUS)) attempt.fail(new SellerHttpsConnectorError('response-headers', 'other', 'response status is outside 200 to 599'));
  else if (status < 400 && status >= 300) attempt.succeed({ status, headers: Object.freeze({ ...res.headers }), body: new Uint8Array(0) });
  else {
    const refusal = headerRefusal(res, call.maxResponseBytes);
    if (refusal) attempt.fail(refusal); else collectBody(res, call.maxResponseBytes, attempt);
  }
}

function watchHandshake(socket, req, call, attempt) {
  attempt.adopt(socket);
  attempt.listen(socket, 'connect', () => { attempt.phase = 'tls'; });
  attempt.listen(socket, 'secureConnect', () => {
    transmitAfterPrepare(req, call, attempt).catch((error) => attempt.fail(new SellerHttpsConnectorError(attempt.phase, 'other', 'transmit step failed', error)));
  });
}

function openRequest(call, address, request, attempt) {
  attempt.assertLive();
  attempt.phase = 'connect';
  const req = request(requestOptions(call, address), (res) => readResponse(res, call, attempt));
  attempt.adopt(req);
  attempt.listen(req, 'error', (error) => attempt.fail(new SellerHttpsConnectorError(attempt.phase, causeCodeOf(error, attempt.phase), 'request failed', error)));
  attempt.listen(req, 'socket', (socket) => watchHandshake(socket, req, call, attempt));
}

async function begin(options, { resolveHost, request }, attempt) {
  const call = checkCall(options);
  attempt.startDeadline(call.deadlineMs);
  attempt.phase = 'resolve';
  const answers = await lookupAnswers(resolveHost, call.url.hostname);
  attempt.phase = 'admit';
  openRequest(call, admitAnswers(answers), request, attempt);
}

/**
 * Creates the seller HTTPS connector. `dependencies` is `{resolveHost, request}`; the
 * defaults are core's public-host resolver and Node's `https.request`, and only tests
 * inject others. `send({origin, path, method, headers, body, deadlineMs, maxResponseBytes,
 * maxResponseHeaderBytes, prepareTransmit, beforeTransmit})` returns a promise of
 * `{status, headers, body}` (the exact response bytes; a 3xx comes back with an empty
 * body) and rejects with SellerHttpsConnectorError. `prepareTransmit` may be async and is
 * awaited after TLS; `beforeTransmit` must be synchronous and runs in the same turn as the
 * first write. A rejection or throw from either, or the deadline, sends nothing.
 */
export function createSellerHttpsConnector(dependencies = DEFAULT_DEPENDENCIES) {
  const { resolveHost, request } = dependencies;
  return Object.freeze({
    send(options) {
      const attempt = new Attempt();
      begin(options, { resolveHost, request }, attempt).catch((error) => attempt.fail(error instanceof SellerHttpsConnectorError ? error : new SellerHttpsConnectorError(attempt.phase, 'other', 'seller https call failed', error)));
      return attempt.settled;
    },
  });
}
