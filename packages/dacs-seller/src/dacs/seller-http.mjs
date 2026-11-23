// Narrow HTTP transport for the seller agent (seller-agent.mjs) and the
// buyer-side client the plugin uses to reach it.
//
// The server runs behind the host's listener policy (`listener`, see host.mjs): the right `Host`, and in proxy mode a loopback socket. Without
// a policy it answers loopback sockets only and checks no `Host`. The client stays loopback-only. The server's only authenticator is the wire context (`wire`, made by
// createWireContext in seller-wire-requests.mjs): it opens each request and signs each answer through `./wire`.
// The wire journal owns the effects of the routes, the reservation coordinator accounts for them, the completion port ends each
// attempt (by the rule of the route's row in seller-effect-routes.mjs, where it has one), and read routes reserve nowhere.
// With `context`, the challenge (`context.challengeOnWire`) is on the wire too, before any Agreement and with no journal; so is the
// context step when `context.handleContext` (from `createWireSellerContextRoute`) is given, and without it that path is not found.
// On the client, supplying an authentication adapter enables signed peer requests and independently signed seller responses.
// Only an authenticated definite refusal becomes SellerRefusedError in that mode; unsigned, malformed, interrupted or
// ambiguous answers are unavailable.
import { completeWireEffect, DACS_SELLER_DISCOVERY_PATH, DACS_SELLER_HTTP_HEADER, DACS_SELLER_HTTP_LIMITS, DACS_SELLER_HTTP_PATHS, inspectWireOperation, isReadRoute, WireError } from '@kynesyslabs/dacs/wire';
import { transportOutcome, UNCERTAIN } from './seller-agent.mjs';
import { boundedCall } from './bounded-call.mjs';
import { assertKitOperationAdmitted } from '../kit-operation-guard.mjs';
import { admitRawJson, isCanonicalJobId } from '@kynesyslabs/dacs';
import { SellerTransportError } from './seller-transport-auth.mjs';
import { signedDiscovery } from './seller-wire-discovery.mjs';
import { wireAuthenticator } from './seller-wire-requests.mjs';
import { createCompletionRecords } from './seller-completion-records.mjs';
import { ownsPurchaseCapacity } from './seller-purchase-capacity.mjs';
import { createSellerEffectRoutes } from './seller-effect-routes.mjs';
import { COSIGNATURE_ANSWER } from './cosignature-answer.mjs';

const MAX_BODY = 64 * 1024;
/** How many requests one handler serves at once unless its `maxConcurrent` says otherwise; the host bounds its live bootstrap scopes by it too. */
export const SELLER_HTTP_MAX_CONCURRENT = 8;
const MAX_RESPONSE_LIST = 256;
// A refusal whose string `cause` names what the buyer can act on carries it in its answer.
const CAUSE_ANSWERED_REFUSALS = new Set(['context_challenge_failed', 'seller_stopped', 'seller_source_unavailable']);
// The longest client deadline `boundedCall` accepts (Node's timers hold at most 2^31 - 1 ms).
const MAX_CLIENT_TIMEOUT_MS = 2 ** 31 - 1;
// How long a wire route waits for the agent's settlement-credit check before it withholds a signed 200.
const SETTLEMENT_CREDIT_TIMEOUT_MS = 10000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
// A request that repeats one of these is refused before its body is read: Node joins or drops the later copies in `req.headers`.
const SINGLE_VALUE_HEADERS = Object.freeze(['content-type', 'content-encoding', DACS_SELLER_HTTP_HEADER]);
const DEFAULT_HTTPS_PORT = 443;
export const loopbackSocket = (address) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
export { SELLER_PRE_EFFECT_REFUSALS } from './seller-agent.mjs';
// Unfinished proposals (`waiting` or `indeterminate`) retain their retry
// slot and resume through the durable responder on a fresh request nonce.
// Payment answers that are not final are never cached as final. Before the
// evidence checkpoint the agent keeps nothing and answers `indeterminate`
// (for example a transfer not yet included): a no-effect answer, so the same
// claim reaches intake again. After it, the agent retains its work and its
// next call reads back first, so a `held` evidence answer or a delivery that
// is not done yet runs the route again (journal retry). The agent sends its
// evidence anchor again only when that readback proves it absent. A claim
// whose effect a thrown error or a crash left uncertain runs again through
// reconciliation, from that retained work or, when the claim ended before the
// checkpoint (nothing sent), from its start, and goes back to the retry (or,
// when that run kept nothing and answered `rejected` or `indeterminate`, is
// released as a no-effect answer). Whether a claim's effect may be released
// is the agent's retained payment work for the job (retainsPaymentWork),
// never its answer alone: once work is retained, no answer or refusal of any
// claim for the job ends its attempt with no outcome, so another claim cannot
// take it. A final answer is stored only after its sources are read again.
const PROPOSAL_PATH = '/dacs/v1/agreements/proposals';
const PAYMENT_PATH = '/dacs/v1/payments';
const COMMITMENT_PATH = '/dacs/v1/commitments';
const COMMITMENT_SIGNATURE_PATH = '/dacs/v1/commitments/signature';
const retainsPayment = (agent, jobId) => { try { return agent.retainsPaymentWork?.(jobId) !== false; } catch { return true; } };
// A proposal effect is released only on the agent's proof that it signed and kept nothing.
const retainsProposal = (agent, jobId) => { try { return agent.retainsProposalWork?.(jobId) !== false; } catch { return true; } };
const retainedBy = (agent, path, jobId) => path === PAYMENT_PATH ? retainsPayment(agent, jobId) : path === PROPOSAL_PATH && retainsProposal(agent, jobId);
// The answer pass of a completed proposal answer served from the cache, when that answer carries the Agreement
// co-signature: the one the agent names for the same proposal. A co-signature the agent no longer names is refused.
function cachedCosignature(agent, path, { status, text }, body) {
  if (path !== PROPOSAL_PATH || status !== 200 || typeof JSON.parse(text)?.contribution?.signature?.value !== 'string') return undefined;
  const cosignature = agent.agreementState(body.transportIdentity)?.[COSIGNATURE_ANSWER];
  if (cosignature === undefined) throw new SellerTransportError('cosignature_answer_unavailable', 409);
  return cosignature;
}

// What the agent holds for a table route's job, for the row's end rule. The agent settles inside its job lock, so a route
// that retains nothing has no worker either. A route the agent cannot answer for is `unknown`, never `none`.
function routeEvidence(agent, path, jobId, outcome) {
  const commitment = path === COMMITMENT_PATH || path === COMMITMENT_SIGNATURE_PATH;
  let work;
  try {
    work = path === PROPOSAL_PATH ? agent.retainsProposalWork?.(jobId) : commitment ? agent.retainsCommitmentWork?.(jobId) : agent.retainsUnfinishedWork?.({ jobId, path });
    // Any payment work of the job retains it, whatever transaction or payer this request names.
    if (path === PAYMENT_PATH && work === false) work = agent.retainsPaymentWork?.(jobId);
  } catch { work = undefined; }
  const retained = work === true ? 'work' : work === false ? 'none' : 'unknown';
  return Object.freeze({ retained, workerQuiescent: retained === 'none', signatureIntent: path === PROPOSAL_PATH && retained === 'work', createIntent: commitment && retained === 'work',
    final: outcome.status === 200 && !outcome.retry && !outcome.noEffect });
}

const ROUTES = {
  '/dacs/v1/agreements/proposals': (agent, body, options) => agent.receiveProposal(body, options),
  '/dacs/v1/agreements/state': (agent, body) => agent.agreementState(body.transportIdentity),
  '/dacs/v1/commitments': (agent, body, options) => agent.commit(body, options),
  '/dacs/v1/payments': (agent, body, options) => agent.submitPayment(body, options),
  '/dacs/v1/bundles/request': (agent, body, options) => agent.bundleRequest(body, options),
  '/dacs/v1/bundles/countersignature': (agent, body, options) => agent.countersign(body, options),
  '/dacs/v1/bundles/buyer-copy': (agent, body, options) => agent.confirmBuyerCopy(body, options),
};
// The routes whose successful answers carry publicSignedCreates (chain readback on).
// The buyer takes pointers only from these answers. It never reads the answer to
// /dacs/v1/commitments/signature (DACS_COMMIT_ON_SIGNATURE=on sends it without
// waiting); its commitment pointer comes with the ordinary commit answer that
// follows its own Agreement readback, so the early route is not pointed.
const POINTED_ROUTES = new Set(['/dacs/v1/commitments', '/dacs/v1/payments']);
// Registered only with DACS_COMMIT_ON_SIGNATURE=on; off keeps main's route table.
const SIGNATURE_ROUTES = { ...ROUTES, '/dacs/v1/commitments/signature': (agent, body, options) => agent.commitOnSignature(body, options) };

// The ordinary completion port. A port is made for one journal and store; a receipt is issued by that port for one coordinator-issued
// effect. Both are known only by these maps, so a copy or a look-alike object is not accepted.
const completionPorts = new WeakMap();
const completionReceipts = new WeakMap();
const END_CLEANUPS = new Set(['route', 'purchase-final']);

function capacityClassOf(row) {
  if (row.class === 'purchase' && typeof row.allocationId === 'string') return { class: 'purchase-stage', allocationId: row.allocationId, route: row.route };
  if (row.class === 'general') return { class: 'general' };
  throw new SellerTransportError('wire_input_invalid', 500);
}

/**
 * Creates the port that issues receipts for the coordinator's effects and takes their ends. `store` is the transport store and
 * `capacity` the purchase capacity built on it; `journal` is the wire journal the effects were issued from. Returns a frozen port whose
 * `capture({ effect, key })` binds a `new` or `recover` effect to its committed accounting row (`key` is the request's nonce key) and
 * returns the frozen receipt `{ effect, capacityClass }`, the class being the one the row persisted. Capture throws a TypeError for input
 * that is not such an effect and key, and SellerTransportError wire_input_invalid (500) when no row matches the effect.
 * Throws a TypeError when the capacity is not the one built on `store` or `journal` is missing.
 */
export function createOrdinaryCompletionPort({ journal, store, capacity }) {
  if (typeof journal !== 'object' || journal === null || !ownsPurchaseCapacity(store, capacity)) {
    throw new TypeError('a completion port needs the wire journal and the purchase capacity built on its own store');
  }
  const records = createCompletionRecords({ store, capacity });
  const port = Object.freeze({
    capture({ effect, key }) {
      if (!['new', 'recover'].includes(effect?.state) || typeof effect.operationId !== 'string' || !Number.isSafeInteger(effect.attempt) || effect.attempt < 0 || typeof key !== 'string') {
        throw new TypeError('a capture needs the new or recover effect the coordinator issued and its request key');
      }
      const row = records.reservationRow(key);
      if (row === undefined || row.operationId !== effect.operationId || row.state !== effect.state) throw new SellerTransportError('wire_input_invalid', 500);
      const capacityClass = Object.freeze(capacityClassOf(row));
      const receipt = Object.freeze({ effect, capacityClass });
      completionReceipts.set(receipt, { port, effect, operationId: row.operationId, attempt: effect.attempt, requestHash: row.requestHash, jobId: row.jobId, buyer: row.buyer, route: row.route, capacityClass });
      return receipt;
    },
  });
  completionPorts.set(port, { journal, records });
  return port;
}

/**
 * Ends the attempt a receipt stands for. `decision` is `{ kind: 'outcome', outcome, cleanup }` (`cleanup` is `route` or `purchase-final`),
 * `{ kind: 'no-effect' }` or `{ kind: 'open' }`. An outcome is published through completeWireEffect and then, in one store transaction,
 * recorded and its capacity returned: the receipt's own route slot, and for `purchase-final` what remains of its allocation. A
 * no-effect decision publishes a null end and returns nothing; it also ends progress that may still finish later, so a null end is
 * never proof of no effect. An open one does nothing. Throws a TypeError, before any write, for a port
 * or receipt it did not issue and for a malformed decision. The journal's WireErrors propagate unchanged and return nothing. A failure of
 * the store transaction propagates after the outcome is published: ending again with the same outcome finishes the cleanup once.
 */
export function endWireAttempt(completion, reservation, decision) {
  const port = completionPorts.get(completion);
  const held = completionReceipts.get(reservation);
  if (port === undefined || held === undefined || held.port !== completion) throw new TypeError('an attempt is ended with the completion port and a receipt it issued');
  const { kind } = decision ?? {};
  if (kind === 'open') return;
  if (kind === 'no-effect') { completeWireEffect(port.journal, held.effect, null); return; }
  if (kind !== 'outcome' || !END_CLEANUPS.has(decision.cleanup) || typeof decision.outcome !== 'object' || decision.outcome === null) {
    throw new TypeError('an end decision is an outcome with a cleanup, no-effect or open');
  }
  completeWireEffect(port.journal, held.effect, decision.outcome);
  port.records.complete(held, { status: decision.outcome.status, cleanup: decision.cleanup });
}

const OPERATION_BINDING = /^[0-9a-f]{64}$/;
const EFFECT_PATHS = new Set(Object.values(DACS_SELLER_HTTP_PATHS).filter((path) => !isReadRoute(path)));

/**
 * Creates the reader of completed operations that answers without a reservation. `journal` is the wire journal and `seller` the
 * seller's claim. The returned `completedOutcomeWithoutReservation({ path, jobId, binding, revalidate })` inspects the operation
 * and resolves with its stored `{ status, text }` after `revalidate` accepted a detached copy of it, with null when the operation
 * is not completed, and never reserves, records a nonce, completes, repairs or changes anything: the same signed request may be
 * answered again. Throws a TypeError for a malformed path, job, binding or callback before it reads anything,
 * SellerTransportError peer_operation_mismatch (409) for a completed operation under another binding, and
 * seller_source_unavailable (503) with the callback's own error as its cause when `revalidate` throws or rejects. The journal's own errors propagate.
 */
export function createCompletedOutcomeReader({ journal, seller }) {
  if (typeof journal !== 'object' || journal === null || typeof seller !== 'string' || seller.length === 0) throw new TypeError('a completed-outcome reader needs the wire journal and the seller claim');
  return Object.freeze({
    async completedOutcomeWithoutReservation({ path, jobId, binding, revalidate }) {
      if (!EFFECT_PATHS.has(path) || !isCanonicalJobId(jobId) || !OPERATION_BINDING.test(binding) || typeof revalidate !== 'function') {
        throw new TypeError('a completed outcome is read for an effect path, a canonical job id, a binding and a revalidation');
      }
      const view = inspectWireOperation(journal, { seller, jobId, path });
      if (view.state !== 'completed') return null;
      if (view.binding !== binding) throw new SellerTransportError('peer_operation_mismatch', 409);
      const { status, text } = view.outcome;
      try { await revalidate({ status, text }); } catch (cause) {
        throw cause instanceof SellerTransportError && cause.code === 'seller_source_unavailable' ? cause : new SellerTransportError('seller_source_unavailable', 503, { cause });
      }
      return { status, text };
    },
  });
}

function readRequest(req, timeoutMs) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    const cleanup = () => {
      clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted);
    };
    const error = (cause) => { cleanup(); reject(cause); };
    const aborted = () => error(new SellerTransportError('body_interrupted', 408));
    const data = (chunk) => {
      total += chunk.byteLength;
      if (total > MAX_BODY) { req.pause(); return error(new SellerTransportError('body_too_large', 413)); }
      chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const timer = setTimeout(() => { req.pause(); error(new SellerTransportError('body_timeout', 408)); }, timeoutMs);
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', aborted);
  });
}

// `context` (seller-context-route.mjs, seller context route) mounts the
// Vet and Agreement-context route. Without it the route table is unchanged.
// `wire` (a createWireContext context made for this `agent`) is the only authenticator. It opens each request and signs each
// answer of the routes of WIRE_ROUTE_PATHS through `./wire`, with the raw transport store as their only journal, and, when the context
// has a `publicEndpoint`, serves the signed discovery document at DACS_SELLER_DISCOVERY_PATH. Its signer names the seller
// and its `requireDelegation` the delegation rule; the listing pin is the agent's own. Throws a TypeError for the removed
// `authentication` option, and for a `wire` that createWireContext did not make for this agent.
// `listener` is the host's policy, `{ mode: 'proxy' | 'tls', expectedHost }`: `expectedHost` is the authority of the Listing's endpoint, the
// one `Host` served (with `:443` added when it names no port), and `tls` mode serves non-loopback sockets. `now` reads the clock of the rate window.
// A request is refused before its body is read, in this order: a non-loopback socket (no policy or proxy mode), the rate and concurrency
// limits, a missing, repeated or other `Host` (421), a repeated content-type, content-encoding or peer header (400), then route and method.
export function createSellerHttpHandler(agent, { authentication, bodyTimeoutMs = 5000, maxRequestsPerWindow = 120, rateWindowMs = 60000, maxConcurrent = SELLER_HTTP_MAX_CONCURRENT, commitOnSignature = false, publicSignedCreates = null, context = null, wire, listener, now = () => performance.now() } = {}) {
  assertKitOperationAdmitted('createSellerHttpHandler');
  if (authentication !== undefined) throw new TypeError('createSellerHttpHandler no longer takes `authentication`: the `wire` context is its only authenticator');
  if (listener !== undefined && (!['proxy', 'tls'].includes(listener?.mode) || typeof listener.expectedHost !== 'string')) throw new TypeError('listener is { mode: "proxy" | "tls", expectedHost }');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (['retainsPaymentWork', 'assertSettlementCredit'].some((name) => typeof agent[name] !== 'function')) throw new TypeError('the wire routes need the agent\'s retainsPaymentWork and assertSettlementCredit');
  const auth = wireAuthenticator(wire, agent);
  if (![bodyTimeoutMs, maxRequestsPerWindow, rateWindowMs, maxConcurrent].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error('seller transport limits must be positive integers');
  if (typeof commitOnSignature !== 'boolean') throw new TypeError('commitOnSignature must be boolean');
  const routes = commitOnSignature ? SIGNATURE_ROUTES : ROUTES;
  const effectRoutes = createSellerEffectRoutes({ commitOnSignature });
  if (wire.signer.claim !== agent.claim) throw new Error('seller transport identity must match the independently configured agent');
  if (wire.requireDelegation && typeof agent.transportAgreementOf !== 'function') throw new Error('delegated seller transport needs retained Agreement scope');
  if (context !== null && (context?.path !== DACS_SELLER_HTTP_PATHS.context || context?.challengePath !== DACS_SELLER_HTTP_PATHS.contextChallenge || typeof context.challengeOnWire !== 'function' || (context.handleContext !== undefined && typeof context.handleContext !== 'function'))) throw new TypeError('the seller context route needs its paths and its wire challenge (challengeOnWire), and its context step (handleContext) must be a function when given');
  if (context !== null && typeof wire.stopped !== 'function') throw new TypeError('the wire challenge route needs the host\'s stop predicate (wire.stopped)');
  if (publicSignedCreates !== null && typeof publicSignedCreates !== 'function') throw new Error('publicSignedCreates must be the seller\'s signed CREATE pointer function');
  // DACS_BUYER_CHAIN_READBACK=on: a successful commit or payment answer (the
  // only answers the buyer takes pointers from) also names the seller's
  // current verified signed CREATEs for its job, including an answer replayed
  // from the effect cache. The retained effect and its bytes are unchanged; a
  // pointer that cannot be looked up, or that would make the answer too large
  // to send, is left out, never an error. Other routes are sent as they are,
  // and never run the seller's in-answer readback.
  const pointed = async (status, text, jobId, path) => {
    if (!publicSignedCreates || status !== 200 || !POINTED_ROUTES.has(path)) return text;
    try {
      const answer = JSON.parse(text), decorated = await publicSignedCreates(jobId, answer);
      if (decorated === answer) return text;
      const pointedText = JSON.stringify(decorated);
      return Buffer.byteLength(pointedText) > DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes ? text : pointedText;
    } catch { return text; }
  };
  const servedHosts = listener === undefined ? null : new Set([listener.expectedHost, ...(new URL(`https://${listener.expectedHost}`).port === '' ? [`${listener.expectedHost}:${DEFAULT_HTTPS_PORT}`] : [])]);
  // `headersDistinct` keeps every copy of a header; `headers.host` keeps only the first.
  const hostServed = (req) => { const hosts = req.headersDistinct.host; return hosts?.length === 1 && servedHosts.has(hosts[0].toLowerCase()); };
  const repeatsSingleValueHeader = (req) => SINGLE_VALUE_HEADERS.some((name) => req.headersDistinct[name]?.length > 1);
  let windowStart = now();
  let requests = 0;
  let active = 0;
  // The headers of one answer, signed over its exact text by the wire when there is an authenticated request.
  const signedHeaders = async (status, text, request, close = false) => {
    const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', ...(close ? { connection: 'close' } : {}) };
    if (Buffer.byteLength(text) > DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes) throw new SellerTransportError('seller_response_too_large', 503);
    if (request) {
      const signature = await auth.sign(request, status, text);
      if (signature !== undefined) headers[DACS_SELLER_HTTP_HEADER] = signature;
    }
    return headers;
  };
  const write = (res, status, headers, text) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, headers);
    res.end(text);
  };
  // An answer that carries the Agreement co-signature is dispatched only to a response that can still be written: a closed
  // one refuses inside the answer pass, before anything is stored or acknowledged.
  const assertOpen = (res) => { if (res.destroyed || res.writableEnded) throw new SellerTransportError('response_closed', 503); };
  // A route sends a signed 200 only once the agent's credit check has settled within its deadline. A failure, a rejection or
  // a missed deadline throws, and a result that comes later releases nothing.
  const creditHeld = (jobId) => boundedCall(() => agent.assertSettlementCredit(jobId), { timeoutMs: SETTLEMENT_CREDIT_TIMEOUT_MS });
  // Sends one answer: signed, then for a 200 the credit check, then written. An answer that carries the Agreement
  // co-signature is written inside its answer pass (`cosignature`), right after the pass's checks; a refusal writes nothing.
  const send = async (res, status, body, request, { close = false, text = JSON.stringify(body), cosignature } = {}) => {
    const headers = await signedHeaders(status, text, request, close);
    if (status === 200 && request) await creditHeld(request.jobId);
    if (cosignature === undefined) write(res, status, headers, text);
    else await cosignature.send({ recheck: () => assertOpen(res), write: () => write(res, status, headers, text) });
  };
  // The discovery document is public, so it is signed as a document and carries no response envelope; a GET with a body is refused.
  const serveDiscovery = async (req, res) => {
    if (req.method !== 'GET') return await send(res, 405, { error: 'method_not_allowed' }, null, { close: true });
    if ((req.headers['content-length'] ?? '0') !== '0' || req.headers['transfer-encoding'] !== undefined) return await send(res, 413, { error: 'body_too_large' }, null, { close: true });
    const text = Buffer.from(await signedDiscovery(wire, agent.listingPin)).toString('utf8');
    write(res, 200, await signedHeaders(200, text, null), text);
  };
  return async (req, res) => {
    let request;
    let reservation;
    let body;
    let counted = false;
    let bootstrapScope;
    // An attempt is answered once, in this order: sign its exact bytes, await the credit check of a 200, end the attempt
    // through `end` (which first checks the attempt is still current), write. Nothing is awaited between that check and the write.
    // Only the routes the wire serves have table rows, looked up by their exact path.
    const rowOfRoute = () => effectRoutes[req.url];
    let concluded = false, delivered = false;
    // A payment's final answer is stored and signed only after its sources are read again, passively. A failure throws before anything
    // is concluded: the attempt stays open and the refusal is answered with its cause.
    const revalidateFinalPayment = async (outcome) => {
      const row = rowOfRoute();
      if (row === undefined || req.url !== PAYMENT_PATH || outcome.status !== 200) return;
      let text;
      try { text = auth.encode(JSON.stringify(outcome.value)); } catch { return; /* an answer that cannot be stored is refused below */ }
      if (row.endAfter({ ...outcome, text }, routeEvidence(agent, req.url, request.jobId, outcome)).kind === 'outcome') {
        await row.revalidate({ agent, jobId: request.jobId, outcome: { status: outcome.status, text } });
      }
    };
    // The answer pass of a stored answer that carries the Agreement co-signature, set by `conclude` and run by `transmitted`
    // once the agent's job lock is released, so the buyer's next request does not meet a job the pass still holds.
    let transmit = null, written = false;
    // A refusal that withheld an answer carrying the Agreement co-signature (the reservation check's before it is stored, or
    // the answer pass's): the refusal is answered, with its own code and status.
    const answerWithheld = (error) => send(res, Number.isSafeInteger(error.status) ? error.status : 503, { error: String(error.code ?? 'answer_withheld'), message: String(error.message) }, request);
    let withheld = null;
    // Runs that pass, whose own checks decide whether the answer goes out: it is written to the response inside the pass,
    // after the pass's checks and before its acknowledgement. A refusal withholds it: the stored answer is sent only through
    // a later pass. Once written, a lost acknowledgement record leaves the history at `dispatch-started`, which reads as unknown.
    const transmitted = async () => {
      const pass = transmit;
      if (pass === null) return;
      transmit = null;
      try { await pass(); } catch (error) { if (!written) await answerWithheld(error); }
    };
    const conclude = async (outcome, end, recheck = () => {}) => {
      if (concluded) throw new SellerTransportError('peer_reconciliation_conflict', 503);
      await revalidateFinalPayment(outcome);
      if (concluded) throw new SellerTransportError('peer_reconciliation_conflict', 503);
      concluded = true;
      const text = auth.encode(JSON.stringify(outcome.value)), sent = await pointed(outcome.status, text, request.jobId, req.url);
      const headers = await signedHeaders(outcome.status, sent, request);
      if (outcome.status === 200) await creditHeld(request.jobId);
      // An answer that carries the co-signature is that signature's transmission: it is stored here, after its reservation check,
      // and written only by its answer pass (`transmitted`), as a repeat served from the cache and a state read are.
      const cosignature = outcome.status === 200 ? outcome.value?.[COSIGNATURE_ANSWER] : undefined;
      if (cosignature === undefined) { end(text); delivered = true; write(res, outcome.status, headers, sent); return; }
      try { recheck(); } catch (error) { withheld = error; throw error; }
      end(text);
      delivered = true;
      transmit = () => cosignature.send({ recheck: () => assertOpen(res), write: () => { write(res, outcome.status, headers, sent); written = true; } });
    };
    // The options an answer is stored with: its classification and, for a route with a row, the row's end decision for the exact text.
    const endOptions = (outcome, text) => {
      const row = rowOfRoute();
      return { noEffect: outcome.noEffect, retry: outcome.retry, ...(row === undefined ? {} : { decision: row.endAfter({ ...outcome, text }, routeEvidence(agent, req.url, request.jobId, outcome)) }) };
    };
    const finishWith = (outcome) => conclude(outcome, (text) => auth.store.finish(reservation, outcome.status, text, endOptions(outcome, text)), () => auth.store.assertPending(reservation));
    try {
      if (listener?.mode !== 'tls' && (!loopbackSocket(req.socket.remoteAddress) || !loopbackSocket(req.socket.localAddress))) return await send(res, 403, { error: 'loopback_only' }, null, { close: true });
      if (now() - windowStart >= rateWindowMs) { windowStart = now(); requests = 0; }
      if (++requests > maxRequestsPerWindow || active >= maxConcurrent) return await send(res, 429, { error: 'seller_rate_limited' }, null, { close: true });
      active++; counted = true;
      if (servedHosts !== null && !hostServed(req)) return await send(res, 421, { error: 'host_not_served' }, null, { close: true });
      if (repeatsSingleValueHeader(req)) return await send(res, 400, { error: 'duplicate_header' }, null, { close: true });
      if (wire.publicEndpoint != null && req.url === DACS_SELLER_DISCOVERY_PATH) return await serveDiscovery(req, res);
      // Match the raw request target exactly: query strings, alternate paths
      // and encoded aliases cannot evade the path authenticated by the peer.
      const contextChallenge = context !== null && req.url === DACS_SELLER_HTTP_PATHS.contextChallenge;
      const contextStep = typeof context?.handleContext === 'function' && req.url === DACS_SELLER_HTTP_PATHS.context;
      const route = routes[req.url];
      if (!route && !contextChallenge && !contextStep) return await send(res, 404, { error: 'not_found' }, null, { close: true });
      if (req.method !== 'POST') return await send(res, 405, { error: 'method_not_allowed' }, null, { close: true });
      if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) return await send(res, 415, { error: 'json_required' }, null, { close: true });
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') return await send(res, 415, { error: 'encoded_body_unsupported' }, null, { close: true });
      if (req.headers['content-length'] && Number(req.headers['content-length']) > MAX_BODY) return await send(res, 413, { error: 'body_too_large' }, null, { close: true });
      const rawBody = await readRequest(req, bodyTimeoutMs);
      try { body = admitRawJson(rawBody); } catch { return await send(res, 400, { error: 'bad_json' }, null); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return await send(res, 400, { error: 'bad_request' }, null);
      // Before the wire opens the request: the buyer's own signature (refused here before any authority read), then a scope for this request only.
      bootstrapScope = wire.bootstrap?.enter(req.headers[DACS_SELLER_HTTP_HEADER]);
      // The context step answers unsigned text; it is signed here under the opened request, and a request that never opened is sent unsigned.
      if (contextStep) {
        const answer = await context.handleContext({ rawBody, header: req.headers[DACS_SELLER_HTTP_HEADER], method: req.method, path: req.url });
        return await send(res, answer.status, null, answer.request, { text: answer.text });
      }
      if (contextChallenge) {
        const answer = await context.challengeOnWire(wire, { header: req.headers[DACS_SELLER_HTTP_HEADER], method: req.method, path: req.url, rawBody, body, onOpened: (authenticated) => { request = authenticated; } });
        return await send(res, 200, answer, request, { text: auth.encode(JSON.stringify(answer)) });
      }
      const opened = await auth.open({ header: req.headers[DACS_SELLER_HTTP_HEADER], method: req.method, path: req.url, rawBody, body, onOpened: (authenticated) => { request = authenticated; } });
      body = opened.body;
      // A signed read reserves and completes nowhere: it answers from the agent's current state.
      if (opened.read) {
        const outcome = transportOutcome(req.url, { answer: await route(agent, body, {}) }, { retained: false });
        // A read that carries the Agreement co-signature transmits it too, inside its answer pass.
        return await send(res, outcome.status, outcome.value, request, { cosignature: outcome.value?.[COSIGNATURE_ANSWER] });
      }
      // Payment evidence is taken only on an assembled settlement profile.
      if (req.url === PAYMENT_PATH) agent.assertAuthenticatedPayment?.();
      reservation = await auth.store.reserve(request);
      const readbackOnly = opened.readbackOnly();
      if (reservation.disposition === 'cached') {
        // A completed answer is signed again only after its sources are read again; a refusal withholds it and rewrites nothing.
        // A payment replay is rechecked on a fresh clock first, unless an expired delegation admitted it for stored readback only.
        // A completed payment answers only the claim it was made for: another transaction or payer is refused, as the payment itself refuses it.
        if (req.url === PAYMENT_PATH) {
          if (!readbackOnly) await opened.recheck();
          if (agent.retainsPaymentWork(request.jobId) && !agent.retainsPaymentClaim(request.jobId, body)) throw new SellerTransportError('payment_already_recorded', 409);
        }
        await rowOfRoute()?.revalidate({ agent, jobId: request.jobId, outcome: { status: reservation.status, text: reservation.text } });
        return await send(res, reservation.status, null, request, { text: await pointed(reservation.status, reservation.text, request.jobId, req.url),
          cosignature: cachedCosignature(agent, req.url, reservation, body) });
      }
      if (reservation.disposition === 'uncertain') {
        // A request its expired delegation admits only for readback reconciles read only.
        const readOnly = opened.readbackOnly();
        // One fenced recovery (seller-agent.mjs reconcileTransport): the
        // agent claims this exact effect inside its job fence before it
        // restores or runs anything, and settles it there. Only an answer
        // the store settled is sent; anything else stays uncertain.
        let claimed = null;
        const reconcile = (outcome) => (text) => auth.store.reconcile(claimed, request, outcome.status, text, endOptions(outcome, text));
        const transport = Object.freeze({
          claim: () => (claimed = auth.store.claim(reservation, request, { live: !readOnly })),
          settle: (outcome) => {
            if (!claimed) throw new SellerTransportError('peer_reconciliation_conflict', 503);
            return conclude(outcome, reconcile(outcome), () => claimed.check());
          },
        });
        if (typeof agent.reconcileTransport === 'function') {
          const row = rowOfRoute();
          await (row === undefined ? agent.reconcileTransport({ request, body, rawBody, readOnly, transport }) : row.recover({ agent, request, body, rawBody, transport }));
        }
        if (delivered) return await transmitted();
        return await send(res, 503, { error: 'operation_uncertain', message: 'A retained operation needs authenticated reconciliation; its outcome is not established.' }, request);
      }
      // One classification (seller-agent.mjs transportOutcome). An agent run checks its reservation inside its job fence before
      // any work and settles there, so the attempt is answered where it is settled.
      const classified = (result) => transportOutcome(req.url, result, { retained: retainedBy(agent, req.url, request?.jobId ?? body?.jobId) });
      const transport = Object.freeze({ path: req.url, check: () => auth.store.assertPending(reservation), settle: finishWith });
      const answer = await route(agent, body, { transport });
      if (!delivered) await finishWith(classified({ answer }));
      await transmitted();
    } catch (error) {
      if (delivered) return await transmitted();
      if (withheld !== null) return await answerWithheld(withheld);
      const beforeEffect = !reservation || reservation.disposition !== 'perform';
      // A refusal keeps its code, status and cause, never `operation_uncertain`. After the effect started, only the
      // refusal to store an unsignable answer and a source that cannot confirm a final answer do; any other error leaves the effect uncertain.
      const refusal = !concluded && (error instanceof SellerTransportError || error instanceof WireError) && (beforeEffect || ['outgoing_body_rejected', 'seller_source_unavailable'].includes(error.code));
      // An attempt whose answer failed before it was written (a superseded attempt, a failed signer or credit check) never sends that
      // answer: its outcome is uncertain.
      const outcome = concluded ? { status: 503, value: UNCERTAIN } : (refusal ? { status: error.status, value: { error: error.code, message: error.message, ...(CAUSE_ANSWERED_REFUSALS.has(error.code) && typeof error.cause === 'string' ? { cause: error.cause } : {}) } }
        : transportOutcome(req.url, { error }, { retained: retainedBy(agent, req.url, request?.jobId ?? body?.jobId) }));
      let { status, value: answer } = outcome;
      if (reservation?.disposition === 'perform' && !concluded) {
        try { return await finishWith(outcome); } catch { if (delivered) return; ({ status, value: answer } = { status: 503, value: UNCERTAIN }); }
      }
      const close = status === 408 || status === 413;
      try { return await send(res, status, answer, request, { close }); } catch {
        // A refusal before any effect that cannot be signed still goes out as itself, unsigned: its cause is never lost.
        try { if (refusal && beforeEffect && request) return await send(res, status, answer, null, { close }); } catch { /* the 503 below */ }
        // A failed seller signer or journal cannot turn into a definite refusal.
        if (!res.headersSent && !res.destroyed) { res.writeHead(503, { 'content-type': 'application/json', connection: 'close' }); res.end('{"error":"operation_uncertain"}'); }
      }
    } finally {
      bootstrapScope?.end();
      if (counted) active--;
    }
  };
}

export class SellerUnavailableError extends Error {
  constructor(message, causeCode = 'other') {
    super(message);
    this.name = 'SellerUnavailableError';
    this.code = 'seller_unavailable';
    this.causeCode = sellerFailureCause(causeCode) ?? 'other';
  }
}

// A local certificate guard runs before dispatch. It cannot establish the
// outcome of an earlier seller effect, so it stays unavailable, not refused.
const preDispatchFailures = new WeakSet();
export function sellerFailureAttempt(error) {
  return { causeCode: sellerFailureCause(error?.causeCode), ...(preDispatchFailures.has(error) ? { dispatched: false } : {}) };
}

export class SellerTlsUnusableError extends SellerUnavailableError {
  constructor(message) {
    super(message, 'tls');
    this.code = 'seller_tls_unusable';
    Object.defineProperty(this, 'dispatched', { value: false, enumerable: true });
    preDispatchFailures.add(this);
  }
}

const FAILURE_CAUSES = new Set(['tls', 'network', 'response-auth', 'status-5xx', 'client-sign', 'timeout', 'other']);
export const sellerFailureCause = (value) => FAILURE_CAUSES.has(value) ? value : undefined;
const TLS_CODES = new Set(['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_REVOKED', 'CERT_SIGNATURE_FAILURE', 'CERT_UNTRUSTED', 'CERT_REJECTED', 'CERT_CHAIN_TOO_LONG', 'PATH_LENGTH_EXCEEDED', 'INVALID_PURPOSE', 'UNABLE_TO_DECRYPT_CERT_SIGNATURE', 'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY', 'ERROR_IN_CERT_NOT_BEFORE_FIELD', 'ERROR_IN_CERT_NOT_AFTER_FIELD', 'UNHANDLED_CRITICAL_EXTENSION', 'INVALID_CA']);
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_SOCKET']);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
function failureCause(error, phase, signal) {
  if (phase === 'client-sign') return 'client-sign';
  if (signal?.aborted) return 'timeout';
  // Node fetch wraps TLS/socket errors in `cause`. Inspect only bounded
  // machine codes, never error messages, peer metadata or certificate bytes.
  for (let depth = 0, current = error; current && depth < 4; depth++, current = current.cause) {
    const code = current.code;
    if (TIMEOUT_CODES.has(code) || ['TimeoutError', 'AbortError'].includes(current.name)) return 'timeout';
    if (TLS_CODES.has(code) || (typeof code === 'string' && /^(?:ERR_TLS_|ERR_SSL_)/.test(code))) return 'tls';
    if (NETWORK_CODES.has(code)) return 'network';
  }
  return phase;
}

export class SellerRefusedError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'SellerRefusedError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Waits for a response verification (an adapter's value or Promise) for at most `timeLeftMs` milliseconds (rounded up to a whole one), and returns its
 * result. Throws its rejection unchanged, or a `TimeoutError` at the deadline: a result that comes later releases nothing and is
 * never an unhandled rejection. With no time left (a response that arrived at or after the deadline) it throws that
 * `TimeoutError` without starting the verification. A synchronous adapter that throws is the same refusal as an asynchronous one.
 */
function verifiedWithin(verify, timeLeftMs) {
  if (timeLeftMs <= 0) return Promise.reject(new DOMException('the response arrived after the client deadline', 'TimeoutError'));
  return boundedCall(verify, { timeoutMs: Math.ceil(timeLeftMs) });
}

export function createSellerAgentClient({ url, fetchImpl = globalThis.fetch, timeoutMs = 15000, authentication, commitOnSignature = false }) {
  assertKitOperationAdmitted('createSellerAgentClient');
  const base = new URL(String(url).replace(/\/$/, ''));
  if (!LOOPBACK_HOSTS.has(base.hostname) || !['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('seller agent endpoint must be loopback without credentials, query or fragment');
  }
  // The deadline sizes the bounded verification wait, so it must be a duration that wait accepts.
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_CLIENT_TIMEOUT_MS) throw new TypeError('timeoutMs must be an integer from 1 to 2^31 - 1');
  const origin = base.origin;
  const prefix = base.pathname.replace(/\/$/, '');

  if (authentication && prefix) throw new Error('authenticated seller transport uses the exact /dacs/v1 paths');
  let lastFailureCause, lastFailureDispatched, hasDispatched = false;

  async function post(path, body) {
    lastFailureCause = undefined;
    lastFailureDispatched = undefined;
    let phase = 'other', signal;
    try {
      const text = JSON.stringify(body);
      if (Buffer.byteLength(text) > MAX_BODY) throw new Error('request exceeds byte limit');
      phase = 'client-sign';
      const signed = authentication ? await authentication.request(path, body, text) : null;
      phase = 'other';
      signal = AbortSignal.timeout(timeoutMs);
      const deadline = performance.now() + timeoutMs;
      hasDispatched = true;
      const response = await fetchImpl(`${origin}${prefix}${path}`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', ...(signed ? { [DACS_SELLER_HTTP_HEADER]: signed.header } : {}) }, body: text, redirect: 'manual', credentials: 'omit', cache: 'no-store', signal });
      phase = 'response-auth';
      const declared = response.headers.get('content-length');
      if (declared !== null && Number(declared) > DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes) { await response.body?.cancel().catch(() => {}); throw new Error('response exceeds byte limit'); }
      const chunks = [];
      let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes) { await reader.cancel().catch(() => {}); throw new Error('response exceeds byte limit'); }
          chunks.push(value);
        }
      }
      const responseBytes = Buffer.concat(chunks);
      const answer = admitRawJson(responseBytes);
      const pending=[answer];
      while(pending.length){
        const member=pending.pop();
        if(Array.isArray(member)&&member.length>MAX_RESPONSE_LIST)throw new Error('response collection exceeds item limit');
        if(member&&typeof member==='object')for(const value of Object.values(member))pending.push(value);
      }
      const answerText = new TextDecoder('utf-8', { fatal: true }).decode(responseBytes);
      // Unsigned 429/404/415/503 answers cannot authenticate their status.
      // Verify first: these failures stay response-auth, including signer fallback 503.
      // The verification is awaited, over the exact received bytes, within what is left of the client's deadline.
      if (authentication) await verifiedWithin(() => authentication.verifyResponse(signed.payload, { header: response.headers.get(DACS_SELLER_HTTP_HEADER), status: response.status, text: answerText, responseBytes }), deadline - performance.now());
      if (response.status >= 500 && response.status <= 599) phase = 'status-5xx';
      if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '')) throw new Error('response did not return JSON');
      if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new Error('response JSON is not an object');
      if (((response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) || (authentication && response.status === 503 && answer.error === 'peer_job_capacity')) && typeof answer.error === 'string') throw new SellerRefusedError(answer.error, typeof answer.message === 'string' ? answer.message.slice(0, 200) : answer.error, response.status);
      if (!response.ok) throw new Error('seller did not return success');
      return answer;
    } catch (error) {
      if (phase === 'client-sign' && preDispatchFailures.has(error)) { lastFailureCause = 'tls'; lastFailureDispatched = false; throw error; }
      if (error instanceof SellerRefusedError) throw error;
      lastFailureCause = failureCause(error, phase, signal);
      throw new SellerUnavailableError('seller agent response is unavailable or unauthenticated; the operation outcome may be unknown', lastFailureCause);
    }
  }

  return {
    origin,
    // The durable Agreement coordinator retains only disposition/reason.
    // Its caller records the last failed HTTP call's bounded cause separately.
    get failureCause() { return lastFailureCause; },
    // An Agreement coordinator can make several calls with this client. A
    // refusal of its last call cannot hide an earlier dispatched proposal.
    get failureDispatched() { return lastFailureDispatched === false && !hasDispatched ? false : undefined; },
    propose: (body) => post('/dacs/v1/agreements/proposals', body),
    agreementState: (transportIdentity) => post('/dacs/v1/agreements/state', { transportIdentity }),
    // The existing authentication signs the complete serialized body, including
    // this optional public CREATE. Omission preserves legacy fixture requests.
    commit: (jobId, { signedProjection } = {}) => post('/dacs/v1/commitments', { jobId, ...(signedProjection === undefined ? {} : { signedProjection }) }),
    ...(commitOnSignature ? { commitOnSignature: (jobId, agreement, signedProjection) => post('/dacs/v1/commitments/signature', { jobId, agreement, signedProjection }) } : {}),
    submitPayment: (body) => post('/dacs/v1/payments', body),
    bundleRequest: (jobId) => post('/dacs/v1/bundles/request', { jobId }),
    countersign: (jobId, buyerSignature) => post('/dacs/v1/bundles/countersignature', { jobId, buyerSignature }),
    confirmBuyerCopy: (jobId) => post('/dacs/v1/bundles/buyer-copy', { jobId }),
    // Only a seller that mounts the context route answers this (seller-context-route.mjs).
    agreementContext: (body) => post(DACS_SELLER_HTTP_PATHS.context, body),
    contextChallenge: (body) => post(DACS_SELLER_HTTP_PATHS.contextChallenge, body),
  };
}
