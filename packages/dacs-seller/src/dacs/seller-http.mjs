// Narrow HTTP transport for the seller agent (seller-agent.mjs) and the
// buyer-side client the plugin uses to reach it.
//
// Server/client stay loopback-only. Existing unauthenticated fixture callers
// remain supported. Supplying an authentication adapter enables signed peer
// requests and independently signed seller responses.
// Only an authenticated definite refusal becomes SellerRefusedError in that
// mode; unsigned, malformed, interrupted or ambiguous answers are unavailable.
// With the `wire` option, every route but the challenge and the context step opens
// each request and signs each answer through `./wire` (seller-wire-requests.mjs). Each
// effect route reserves its operation in the wire request journal and ends every attempt
// with endWireAttempt; the read routes reserve nowhere. The challenge and the context step
// keep the old server auth and the transport store's journal.
import { completeWireEffect, inspectWireOperation, WireError, wireOperationBinding, wireOperationId } from '@kynesyslabs/dacs/wire';
import { UNCERTAIN, paymentTxHash, transportOutcome } from './seller-agent.mjs';
import { boundedCall } from './bounded-call.mjs';
import { assertKitOperationAdmitted } from '../kit-operation-guard.mjs';
import { admitRawJson, canonicalize } from '@kynesyslabs/dacs';
import { SELLER_CONTEXT_PATH, SELLER_CONTEXT_CHALLENGE_PATH, SELLER_TRANSPORT_HEADER, SELLER_TRANSPORT_MAX_RESPONSE, SellerTransportError } from './seller-transport-auth.mjs';
import { WIRE_ROUTE_PATHS, wireAuthenticator } from './seller-wire-requests.mjs';
import { createCompletionRecords } from './seller-completion-records.mjs';
import { ownsPurchaseCapacity } from './seller-purchase-capacity.mjs';
import { requestNonceKey } from './seller-reservation-accounting.mjs';

const MAX_BODY = 64 * 1024;
const MAX_RESPONSE_LIST = 256;
const SETTLEMENT_CREDIT_TIMEOUT_MS = 10000;
// The longest client deadline `boundedCall` accepts (Node's timers hold at most 2^31 - 1 ms).
const MAX_CLIENT_TIMEOUT_MS = 2 ** 31 - 1;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
export const loopbackSocket = (address) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
export { SELLER_PRE_EFFECT_REFUSALS } from './seller-agent.mjs';
// An attempt of the wire journal ends only with a final answer or with proof that
// nothing was done. Unfinished proposals (`waiting` or `indeterminate`) and payment
// answers that are not final leave the attempt open: the next request is pending until
// the lease ends, then recovers by asking the agent to reconcile first. Before the
// evidence checkpoint the agent keeps nothing and answers `indeterminate` (for example a
// transfer not yet included): a no-effect answer, so the attempt ends with null and the
// same claim reaches intake again. Whether a claim's attempt may end with null is the
// agent's retained work for exactly that claim (retainsPaymentClaim), never its answer
// alone: once work is retained, no answer or refusal of the claim ends its attempt.
const PROPOSAL_PATH = '/dacs/v1/agreements/proposals';
const PAYMENT_PATH = '/dacs/v1/payments';
const retainsClaim = (agent, jobId, body) => { try { return agent.retainsPaymentClaim?.(jobId, body) !== false; } catch { return true; } };
const reportsDeliveryReady = (text) => {
  try { const answer = JSON.parse(text); return answer?.status === 'payment-evidenced' && ['delivery-ready','delivered'].includes(answer.delivery?.status); } catch { return false; }
};
// A proposal effect is released only on the agent's proof that it signed and kept nothing.
const retainsProposal = (agent, jobId) => { try { return agent.retainsProposalWork?.(jobId) !== false; } catch { return true; } };
const retainedBy = (agent, path, jobId, body) => path === PAYMENT_PATH ? retainsClaim(agent, jobId, body) : path === PROPOSAL_PATH && retainsProposal(agent, jobId);

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
 * no-effect decision publishes a null end and returns nothing; an open one does nothing. Throws a TypeError, before any write, for a port
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
// `wire` (a createWireContext context) moves the mounted routes of WIRE_ROUTE_PATHS onto `./wire`; its `store` backs
// accounting and retained purchases, and its `journal` holds request attempts and outcomes. It needs `authentication`, naming
// the same seller and delegation rule and made over the context's store, for the challenge and the context step; the context
// must be made for this `agent`.
export function createSellerHttpHandler(agent, { authentication, bodyTimeoutMs = 5000, maxRequestsPerWindow = 120, rateWindowMs = 60000, maxConcurrent = 8, commitOnSignature = false, publicSignedCreates = null, context = null, wire = null } = {}) {
  assertKitOperationAdmitted('createSellerHttpHandler');
  if (wire !== null && !authentication) throw new Error('the wire routes need the old authentication of the routes still on it');
  if (wire !== null && ['retainsPaymentClaim', 'assertSettlementCredit'].some((name) => typeof agent[name] !== 'function')) throw new TypeError('the wire routes need the agent\'s retainsPaymentClaim and assertSettlementCredit');
  if (![bodyTimeoutMs, maxRequestsPerWindow, rateWindowMs, maxConcurrent].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error('seller transport limits must be positive integers');
  if (typeof commitOnSignature !== 'boolean') throw new TypeError('commitOnSignature must be boolean');
  const routes = commitOnSignature ? SIGNATURE_ROUTES : ROUTES;
  if (authentication && (authentication.seller !== agent.claim || canonicalize(authentication.listingPin) !== canonicalize(agent.listingPin))) throw new Error('seller transport identity must match the independently configured agent');
  if (authentication?.requireDelegation && typeof agent.transportAgreementOf !== 'function') throw new Error('delegated seller transport needs retained Agreement scope');
  if (context !== null && (!authentication || context?.path !== SELLER_CONTEXT_PATH || context?.challengePath !== SELLER_CONTEXT_CHALLENGE_PATH || typeof authentication.store?.classify !== 'function' || !['challenge', 'reserve', 'perform', 'settled', 'reconcile'].every((name) => typeof context[name] === 'function'))) throw new Error('the seller context route needs the authenticated transport and its admission');
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
      return Buffer.byteLength(pointedText) > SELLER_TRANSPORT_MAX_RESPONSE ? text : pointedText;
    } catch { return text; }
  };
  let windowStart = Date.now();
  let requests = 0;
  let active = 0;
  // The wire's authenticator, made only for a context created for this agent and this transport store. The requests it opened
  // are signed by the wire, under the tuple kept for the job; a request that names another seller cannot be signed for
  // (`peer_signer_wrong`) and its refusal goes out unsigned.
  const wireAuth = wire === null ? null : wireAuthenticator(wire, agent, authentication);
  const wiredRequests = new WeakSet();
  const responseHeader = (request, status, text) => wiredRequests.has(request) ? wireAuth.sign(request, status, text) : authentication.responseHeader(request, status, text);
  // The headers of an answer, signed over its exact text.
  const signedHeaders = async (status, text, request, close = false) => {
    const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', ...(close ? { connection: 'close' } : {}) };
    if (Buffer.byteLength(text) > SELLER_TRANSPORT_MAX_RESPONSE) throw new SellerTransportError('seller_response_too_large', 503);
    if (authentication && request) {
      const signature = await responseHeader(request, status, text);
      if (signature !== undefined) headers[SELLER_TRANSPORT_HEADER] = signature;
    }
    return headers;
  };
  const write = (res, status, headers, text) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, headers);
    res.end(text);
  };
  // A failed seller signer or journal cannot turn into a definite refusal.
  const sendUnsignedUncertain = (res) => {
    if (!res.headersSent && !res.destroyed) { res.writeHead(503, { 'content-type': 'application/json', connection: 'close' }); res.end('{"error":"operation_uncertain"}'); }
  };
  const send = async (res, status, body, request, { close = false, text = JSON.stringify(body) } = {}) => {
    const headers = await signedHeaders(status, text, request, close);
    if (status === 200 && request && !wiredRequests.has(request)) agent.assertSettlementCredit?.(request.jobId);
    write(res, status, headers, text);
  };
  // A wire route discloses a signed 200 only after the agent's credit check has settled, within a deadline. The check runs at most once
  // per answer; a failure, a rejection or a missed deadline throws, and a result that comes later releases nothing.
  const assertCreditHeld = (jobId) => boundedCall(() => agent.assertSettlementCredit(jobId), { timeoutMs: SETTLEMENT_CREDIT_TIMEOUT_MS });
  // A completed operation is answered from its stored outcome, run through nothing.
  async function answerCompleted(res, request, { status, text }) {
    const sent = await pointed(status, text, request.jobId, request.path);
    const headers = await signedHeaders(status, sent, request);
    if (status === 200) await assertCreditHeld(request.jobId);
    write(res, status, headers, sent);
  }
  // The attempt is the journal's current one for this request: pending, under its binding and inside its lease.
  function assertAttemptCurrent(request, effect) {
    const view = inspectWireOperation(wire.journal, { seller: request.seller, jobId: request.jobId, path: request.path });
    const time = wire.now();
    if (view.state !== 'pending' || view.attempt !== effect.attempt || view.binding !== wireOperationBinding(request) || view.leaseUntil <= time) throw new WireError('seller_effect_superseded', 500);
    // Recheck the admitted request's expiry after waits inside the agent.
    if (request.expiresAt <= time) throw new WireError('peer_expired', 408);
  }
  // An answer ends its attempt only as its disposition says: a final 200 answer is the outcome, a proven no-effect answer ends with
  // null, anything else (progress, a retained-work refusal, uncertainty) leaves the attempt open.
  const endDecisionFor = (outcome, text) => outcome.disposition === 'no-effect' ? { kind: 'no-effect' }
    : outcome.disposition === 'present' && outcome.status === 200 ? { kind: 'outcome', outcome: { status: 200, text }, cleanup: 'route' } : { kind: 'open' };
  // The attempt of a `new` or `recover` effect: the agent runs (or reconciles) with a frame whose settle ends the attempt and answers.
  // The answer is signed before the attempt ends; nothing awaits between the last check, the end and handing the bytes to `res`.
  async function runWireAttempt(res, request, body, rawBody, effect, route) {
    const url = request.path, receipt = wire.completion.capture({ effect, key: requestNonceKey(request) });
    let concluded = false, delivered = false;
    const check = () => assertAttemptCurrent(request, effect);
    const conclude = async (outcome) => {
      if (concluded) throw new SellerTransportError('peer_reconciliation_conflict', 503);
      concluded = true;
      const text = wireAuth.encode(JSON.stringify(outcome.value));
      const sent = await pointed(outcome.status, text, request.jobId, url);
      const headers = await signedHeaders(outcome.status, sent, request);
      if (outcome.status === 200) await assertCreditHeld(request.jobId);
      check();
      endWireAttempt(wire.completion, receipt, endDecisionFor(outcome, text));
      write(res, outcome.status, headers, sent);
      delivered = true;
    };
    const frame = Object.freeze({ path: url, check, claim: () => { check(); return Object.freeze({ check }); }, settle: conclude });
    let result;
    try {
      result = effect.state === 'recover' ? { answer: await agent.reconcileTransport?.({ request, body, rawBody, readOnly: false, transport: frame }) } : { answer: await route(agent, body, { transport: frame }) };
    } catch (error) { result = { error }; }
    if (delivered) return;
    if (concluded) throw result.error ?? new SellerTransportError('peer_reconciliation_conflict', 503);
    if (effect.state === 'recover') return send(res, 503, UNCERTAIN, request);
    await conclude(transportOutcome(url, result, { retained: retainedBy(agent, url, request.jobId, body) }));
  }
  // One effect route: the coordinator's accounting and journal reservation first (its refusals are definite and unsigned work-free),
  // then the attempt. Once an attempt exists, any failure leaves its effect uncertain, never a refusal.
  async function serveWireEffect(res, request, body, rawBody, admitted, route) {
    const url = request.path;
    const effect = await wire.reservations.reserveCoordinated({ checked: { body: admitted.body, reserve: admitted.reserve }, payload: request, route: url, operationId: wireOperationId(request),
      paymentTx: url === PAYMENT_PATH ? paymentTxHash(body.txHash) : null, keepProfile: request.profile, retainedWork: admitted.retainedWork });
    if (effect.state === 'completed') return answerCompleted(res, request, effect.outcome);
    try { await runWireAttempt(res, request, body, rawBody, effect, route); } catch {
      // An answer that cannot be signed (a changed connection, a failed signer) is no refusal either.
      try { await send(res, 503, UNCERTAIN, request); } catch { sendUnsignedUncertain(res); }
    }
  }
  return async (req, res) => {
    let request;
    let reservation;
    let body;
    let settled = null;
    let fenced = null;
    let counted = false;
    let wired = false;
    const store = authentication?.store;
    const answerText = (outcome) => JSON.stringify(outcome.value);
    try {
      if (!loopbackSocket(req.socket.remoteAddress) || !loopbackSocket(req.socket.localAddress)) return await send(res, 403, { error: 'loopback_only' }, null, { close: true });
      if (Date.now() - windowStart >= rateWindowMs) { windowStart = Date.now(); requests = 0; }
      if (++requests > maxRequestsPerWindow || active >= maxConcurrent) return await send(res, 429, { error: 'seller_rate_limited' }, null, { close: true });
      active++; counted = true;
      // Match the raw request target exactly: query strings, alternate paths
      // and encoded aliases cannot evade the path authenticated by the peer.
      const contextChallenge = context !== null && req.url === SELLER_CONTEXT_CHALLENGE_PATH;
      const contextStep = context !== null && req.url === SELLER_CONTEXT_PATH;
      const route = contextChallenge ? () => {} : contextStep ? (_agent, body) => context.perform(body) : routes[req.url];
      if (!route) return await send(res, 404, { error: 'not_found' }, null, { close: true });
      wired = wire !== null && WIRE_ROUTE_PATHS.includes(req.url);
      if (req.method !== 'POST') return await send(res, 405, { error: 'method_not_allowed' }, null, { close: true });
      if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) return await send(res, 415, { error: 'json_required' }, null, { close: true });
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') return await send(res, 415, { error: 'encoded_body_unsupported' }, null, { close: true });
      if (req.headers['content-length'] && Number(req.headers['content-length']) > MAX_BODY) return await send(res, 413, { error: 'body_too_large' }, null, { close: true });
      const rawBody = await readRequest(req, bodyTimeoutMs);
      try { body = admitRawJson(rawBody); } catch { return await send(res, 400, { error: 'bad_json' }, null); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return await send(res, 400, { error: 'bad_request' }, null);
      let admitted;
      if (authentication) {
        if (wired) {
          admitted = await wireAuth.open({ header: req.headers[SELLER_TRANSPORT_HEADER], method: req.method, path: req.url, rawBody, body, onOpened: (opened) => { request = opened; wiredRequests.add(opened); } });
          ({ body } = admitted);
          // A signed read reserves and completes nowhere: it answers from the agent's current state.
          if (admitted.read) {
            const outcome = transportOutcome(req.url, { answer: await route(agent, body, {}) }, { retained: false });
            if (outcome.status === 200) await assertCreditHeld(request.jobId);
            return await send(res, outcome.status, outcome.value, request);
          }
        } else {
          request = authentication.readRequest(req.headers[SELLER_TRANSPORT_HEADER]);
          try {
            authentication.validate(request, { method: req.method, path: req.url, rawBody, body, agreement: agent.transportAgreementOf?.(request.jobId), ...(contextStep && context.onRejectedBody ? {onRejectedBody:()=>context.onRejectedBody(request,body,authentication.store)} : {}) });
          } catch (error) { if (contextStep) context.attemptRefused?.(request, error?.code); throw error; }
          if (contextChallenge) return await send(res, 200, await context.challenge(request, body, authentication.store), request);
        }
        // Payment evidence is taken only on an assembled settlement profile, whichever auth opened the request.
        if (req.url === PAYMENT_PATH) agent.assertAuthenticatedPayment?.();
        if (wired) return await serveWireEffect(res, request, body, rawBody, admitted, route);
        // The context step reads the journal first and runs its admission only
        // for new work, recording the start in the reserve transaction.
        reservation = contextStep ? await context.reserve(request, body, authentication.store) : store.reserve(request, body);
        if (reservation.disposition === 'cached') agent.assertSettlementCredit?.(request.jobId);
        if (reservation.disposition === 'cached' && reservation.status === 200 && ['/dacs/v1/commitments','/dacs/v1/commitments/signature'].includes(req.url)) {
          // The commitment is already anchored: a failed readback (closed buyer access, an Agreement
          // not readable now) cannot refuse it, so it answers retryable, never as a definite refusal.
          let answer;
          try { answer = await agent.readCommitment({jobId:request.jobId,signedProjection:body.signedProjection,
            signatureAgreement:req.url==='/dacs/v1/commitments/signature'?body.agreement:undefined}); }
          catch (cause) { throw new SellerTransportError('commitment_readback_required',503,{cause}); }
          if (!['committed','commitment-held'].includes(answer?.status)) throw new SellerTransportError('commitment_readback_required',503);
          return await send(res,200,answer,request,{text:await pointed(200,JSON.stringify(answer),request.jobId,req.url)});
        }
        const readbackOnly = authentication.readbackOnly?.(request) === true;
        if (reservation.disposition === 'cached' && req.url === PAYMENT_PATH && reportsDeliveryReady(reservation.text)) {
          // A cached completed answer is only a record of it. Under a live
          // delegation the agent authenticates the payment evidence and reads
          // the Deliverable again, and what it answers now is sent, never the
          // saved success. An expired delegation admits journaled readback
          // only, so that refresh (which may publish new delivery evidence)
          // never runs; the saved answer alone authenticates nothing, so the
          // claim is held instead of replayed as delivered.
          if (readbackOnly) {
            const answer = { status: 'held', reason: 'peer_delegation_expired: a completed delivery answer is authenticated only under a live session delegation' };
            return await send(res, 200, answer, request, { text: await pointed(200, JSON.stringify(answer), request.jobId, req.url) });
          }
          // A cached refresh owns no pending reservation. Recheck its live
          // authority inside the agent's job fence, including after restore.
          const transport = Object.freeze({ check: () => authentication.assertLive(request) });
          const answer = await route(agent, body, { transport }), text = JSON.stringify(answer);
          return await send(res, 200, answer, request, { text: await pointed(200, text, request.jobId, req.url) });
        }
        if (reservation.disposition === 'cached') return await send(res, reservation.status, null, request, { text: await pointed(reservation.status, reservation.text, request.jobId, req.url) });
        if (reservation.disposition === 'uncertain') {
          // A request its expired delegation admits only for readback reconciles read only.
          const readOnly = readbackOnly;
          if (!contextStep) {
            // One fenced recovery (seller-agent.mjs reconcileTransport): the
            // agent claims this exact effect inside its job fence before it
            // restores or runs anything, and settles it there. Only an answer
            // the store settled is sent; anything else stays uncertain.
            let claimed = null;
            const transport = Object.freeze({
              claim: () => (claimed = store.claim(reservation, request, { live: !readOnly })),
              settle: (outcome) => {
                if (!claimed || settled) throw new SellerTransportError('peer_reconciliation_conflict', 503);
                store.reconcile(claimed, request, outcome.status, answerText(outcome), { retry: outcome.retry, noEffect: outcome.noEffect });
                settled = outcome;
              },
            });
            if (typeof agent.reconcileTransport === 'function' && typeof store.claim === 'function') await agent.reconcileTransport({ request, body, rawBody, readOnly, transport });
            if (!settled) return await send(res, 503, { error: 'operation_uncertain', message: 'A retained operation needs authenticated reconciliation; its outcome is not established.' }, request);
            return await send(res, settled.status, settled.value, request, { text: await pointed(settled.status, JSON.stringify(settled.value), request.jobId, req.url) });
          }
          if (authentication.store.contextHoldState?.({ jobId: request.jobId, effect: reservation.effectKey }) === 'pending') return await send(res, 503, { error: 'operation_uncertain', message: 'The retained context still has a pending owner.' }, request);
          const proof = typeof authentication.store.reconcile === 'function' ? await context.reconcile({ request, body, rawBody, ...(readOnly ? { readOnly } : {}) }) : null;
          if (proof?.disposition === 'present') {
            const text = JSON.stringify(proof.value);
            authentication.store.reconcile(reservation, request, 200, text);
            await context.settled({ jobId: request.jobId, hold: reservation.effectKey });
            return await send(res, 200, proof.value, request, { text: await pointed(200, text, request.jobId, req.url) });
          }
          // The second exception: the context route proved a shutdown cut its step
          // before anything of it was signed or sent; the same effect runs
          // again below under the reservation the journal hands back.
          const resumed = !readOnly && contextStep && proof?.disposition === 'resume' && typeof context.resume === 'function' ? await context.resume(reservation, request, authentication.store, proof) : null;
          if (resumed?.disposition !== 'perform') return await send(res, 503, { error: 'operation_uncertain', message: 'A retained operation needs authenticated reconciliation; it was not performed again.' }, request);
          reservation = resumed;
        }
      }
      // One classification (seller-agent.mjs transportOutcome). An agent run
      // checks its reservation inside its job fence before any work and
      // settles there; a route without the fence is classified here when it
      // returns. A resumed context step has written before: no answer of it deletes its records.
      const finishWith = (outcome) => {
        if (authentication) store.finish(reservation, outcome.status, answerText(outcome), { noEffect: outcome.noEffect, retry: outcome.retry });
        return (settled = outcome);
      };
      const classified = (result) => transportOutcome(req.url, result, { retained: retainedBy(agent, req.url, request?.jobId ?? body?.jobId, body), resumed: reservation?.resumed === true });
      const transport = authentication && !contextStep ? Object.freeze({ path: req.url, check: () => store.assertPending(reservation), settle: (outcome) => { fenced = finishWith(outcome); } }) : undefined;
      const answer = await route(agent, body, { transport });
      const outcome = settled ?? finishWith(classified({ answer }));
      if (contextStep) await context.settled(reservation.contextHold);
      return await send(res, outcome.status, outcome.value, request, { text: await pointed(outcome.status, JSON.stringify(outcome.value), request?.jobId ?? body.jobId, req.url) });
    } catch (error) {
      const beforeEffect = !reservation || reservation.disposition !== 'perform';
      // A wire refusal keeps its code, status and cause, never `operation_uncertain`. After the effect started, only the
      // refusal to store an unsignable answer does; any other error leaves the effect uncertain.
      const refusal = (error instanceof SellerTransportError || error instanceof WireError) && (beforeEffect || error.code === 'outgoing_body_rejected');
      // A refusal the agent settled inside its fence is answered as settled.
      const outcome = fenced ?? (refusal ? { status: error.status, value: { error: error.code, message: error.message, ...(error.code === 'context_challenge_failed' && typeof error.cause === 'string' ? { cause: error.cause } : {}) } }
        : transportOutcome(req.url, { error }, { retained: retainedBy(agent, req.url, request?.jobId ?? body?.jobId, body), resumed: reservation?.resumed === true }));
      const { status, value: answer } = outcome;
      if (authentication && reservation?.disposition === 'perform' && !settled) {
        try { store.finish(reservation, status, answerText(outcome), { noEffect: outcome.noEffect, retry: outcome.retry }); } catch { /* durable intent remains uncertain */ }
        // The context step has ended either way: its unused write reservation
        // is released (its writes keep their own rows; it runs again only as a resume).
        if (context !== null && req.url === SELLER_CONTEXT_PATH) try { await context.settled(reservation.contextHold); } catch { /* retain the uncertain hold; still answer below */ }
      }
      const close = status === 408 || status === 413;
      try { return await send(res, status, answer, request, { close }); } catch {
        // A wire refusal before any effect that cannot be signed still goes out as itself, unsigned: its cause is never lost.
        try { if (refusal && beforeEffect && wiredRequests.has(request)) return await send(res, status, answer, null, { close }); } catch { /* the 503 below */ }
        sendUnsignedUncertain(res);
      }
    } finally {
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
 * Waits for a response verification (an adapter's value or Promise) for at most `timeLeftMs` whole milliseconds, and returns its
 * result. Throws its rejection unchanged, or a `TimeoutError` at the deadline: a result that comes later releases nothing and is
 * never an unhandled rejection. With no time left (a response that arrived at or after the deadline) it throws that
 * `TimeoutError` without starting the verification. A synchronous adapter that throws is the same refusal as an asynchronous one.
 */
function verifiedWithin(verify, timeLeftMs) {
  if (timeLeftMs <= 0) return Promise.reject(new DOMException('the response arrived after the client deadline', 'TimeoutError'));
  return boundedCall(verify, { timeoutMs: timeLeftMs });
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
      const deadline = Date.now() + timeoutMs;
      hasDispatched = true;
      const response = await fetchImpl(`${origin}${prefix}${path}`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', ...(signed ? { [SELLER_TRANSPORT_HEADER]: signed.header } : {}) }, body: text, redirect: 'manual', credentials: 'omit', cache: 'no-store', signal });
      phase = 'response-auth';
      const declared = response.headers.get('content-length');
      if (declared !== null && Number(declared) > SELLER_TRANSPORT_MAX_RESPONSE) { await response.body?.cancel().catch(() => {}); throw new Error('response exceeds byte limit'); }
      const chunks = [];
      let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > SELLER_TRANSPORT_MAX_RESPONSE) { await reader.cancel().catch(() => {}); throw new Error('response exceeds byte limit'); }
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
      if (authentication) await verifiedWithin(() => authentication.verifyResponse(signed.payload, { header: response.headers.get(SELLER_TRANSPORT_HEADER), status: response.status, text: answerText, responseBytes }), deadline - Date.now());
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
    agreementContext: (body) => post(SELLER_CONTEXT_PATH, body),
    contextChallenge: (body) => post(SELLER_CONTEXT_CHALLENGE_PATH, body),
  };
}
