// What a signed request on `./wire` is checked against, and what an answer must pass before it is stored.
// The retained Agreement or draft, its parties and the kept TP-1 tuple are the host's own records: nothing here
// takes them from the request, except the one exchange-only record for a job the host holds nothing for.
// The operator's network, store, clock and agent reach the signed routes only through one wire context (createWireContext).
import { types } from 'node:util';
import { contentHash, createFixedPriceAgreementSigningPlan } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_PATHS, WireError, admitWireArtifact, admitWireResponseBody, authorizeWireRequest, checkWireRequest, completeWireEffect, inspectWireOperation, isReadRoute, openWireEnvelope, signWireResponse, wireOperationBinding, wireOperationId, wireRequestHash } from '@kynesyslabs/dacs/wire';
import { boundedCall } from './bounded-call.mjs';
import { isSmallOrderPublicKey } from './demos-claims.mjs';
import { SellerTransportError, sellerStoreInternals, transportStoreOf, validateBody } from './seller-transport-auth.mjs';

// The routes that continue a committed purchase: the wire admits them only on the purchase's commitment, Agreement and Listing.
const CONTINUING_PATHS = Object.freeze([DACS_SELLER_HTTP_PATHS.payments, DACS_SELLER_HTTP_PATHS.bundleRequest, DACS_SELLER_HTTP_PATHS.bundleCountersignature, DACS_SELLER_HTTP_PATHS.bundleBuyerCopy]);
const COMMITMENT_RECEIPT_TIMEOUT_MS = 10000;

/**
 * The routes the wire opens and signs. `commitments/signature` is one only where the handler mounts it (`commitOnSignature`);
 * the context step keeps the old server auth, and the challenge is opened by `challengeOnWire` (it has no Agreement and no
 * journal), not through this list.
 */
export const WIRE_ROUTE_PATHS = Object.freeze([DACS_SELLER_HTTP_PATHS.proposals, DACS_SELLER_HTTP_PATHS.state, DACS_SELLER_HTTP_PATHS.commitments, DACS_SELLER_HTTP_PATHS.commitmentSignature, ...CONTINUING_PATHS]);
// The routes that start or commit a purchase carry the host's own `allocated` flag (false unless the purchase holds a live allocation).
const STAGE_PATHS = new Set([DACS_SELLER_HTTP_PATHS.proposals, DACS_SELLER_HTTP_PATHS.commitments, DACS_SELLER_HTTP_PATHS.commitmentSignature]);
// The contexts createWireContext made, each with the agent and raw store it was made over: the handler takes no other, and
// only a pair it serves with the same agent and the same store.
const wireContexts = new WeakMap();

const partyClaim = (artifact, role) => artifact.parties?.find((party) => party?.role === role)?.primaryClaim;
const retainedRecord = (path, { jobId, agreementHash, buyer, seller }) => ({ jobId, agreementHash, buyer, seller, ...(STAGE_PATHS.has(path) ? { allocated: false } : {}) });
const retainedByArtifact = (path, artifact) => ({ retained: retainedRecord(path, { jobId: artifact.jobId, agreementHash: contentHash(artifact), buyer: partyClaim(artifact, 'buyer'), seller: partyClaim(artifact, 'seller') }), artifacts: [artifact] });

const CLAIM_PREFIX = 'did:demos:agent:';
const isSmallOrderClaim = (claim) => isSmallOrderPublicKey(Buffer.from(claim.slice(CLAIM_PREFIX.length), 'hex'));

/**
 * The wire verifies a signature by any key, and a small-order key verifies a constant signature for every message: such a
 * key never authenticates a request or a delegation. Throws `peer_signature_invalid` 401 (or its delegation form) for an
 * opened request whose buyer key signed a delegation, or whose signing key signed the request, is one.
 */
function assertNoSmallOrderSigner({ payload, delegation }) {
  if (delegation !== null && isSmallOrderClaim(payload.buyer)) throw new SellerTransportError('peer_delegation_signature_invalid', 401);
  if (isSmallOrderClaim(delegation === null ? payload.buyer : `${CLAIM_PREFIX}${delegation.payload.sessionPublicKey}`)) throw new SellerTransportError('peer_signature_invalid', 401);
}

/** The draft an initial proposal carries, derived as its signing plan does. Throws `peer_proposal_invalid` 422 for a draft the plan refuses. */
function initialDraft(body) {
  try { return createFixedPriceAgreementSigningPlan(body?.proposal?.plan?.draft).draft; } catch (cause) { throw new SellerTransportError('peer_proposal_invalid', 422, { cause }); }
}

/**
 * What the host retained for the request's job, for `checkWireRequest`: `{ retained, artifacts, held }` from the agent's retained
 * plan or Agreement (`held`), or from the draft an initial proposal itself carries. `null` when the host holds nothing for the job
 * (never for a proposal). With capacity, `allocated` requires a live allocation and a successful settled context.
 * Throws `peer_proposal_invalid` for an initial proposal whose draft cannot be derived.
 */
function retainedFor(agent, { path, request, body }, { store, capacity } = {}) {
  const known = agent.transportAgreementOf(request.jobId);
  const records = known !== null ? { ...retainedByArtifact(path, known), held: true }
    : path === DACS_SELLER_HTTP_PATHS.proposals ? { ...retainedByArtifact(path, initialDraft(body)), held: false } : null;
  if (records !== null && capacity !== undefined && STAGE_PATHS.has(path)) {
    const { buyer, seller } = records.retained;
    records.retained.allocated = capacity.retainedAllocated({ jobId: request.jobId, buyer, seller, listingPin: agent.listingPin,
      route: path, stageAuthorized: contextSettledAsSuccess(store, request.jobId) });
  }
  return records;
}

// The host's accepted context settled with a validated result.
function contextSettledAsSuccess(store, jobId) {
  const found = sellerStoreInternals(store).db.prepare('SELECT record FROM kit_context_admissions WHERE jobId = ?').get(jobId);
  const row = found ? JSON.parse(found.record) : null;
  return row?.state === 'settled' && row.contextOutcome === 'success';
}

/**
 * The continuation inputs `checkWireRequest` takes on a continuing route: the job's durable commitment and Agreement texts,
 * each admitted anew by the wire (an admission mark is never saved, so a restart admits again), and `signedListing`, the
 * host's own Listing as its admission returned it. Values are passed on uncloned. Returns a null commitment, which the wire
 * refuses, when the agent retains none. Throws the wire's artifact refusal for a missing or malformed retained text.
 */
function continuationFor(agent, { request }, signedListing) {
  const evidence = agent.continuationEvidenceOf(request.jobId);
  if (evidence === null) return { commitment: null, agreement: null, signedListing };
  return { commitment: admitWireArtifact(Buffer.from(evidence.commitmentText ?? '', 'utf8')), agreement: admitWireArtifact(Buffer.from(evidence.agreementText ?? '', 'utf8')), signedListing };
}

/**
 * `reader` with a deadline: a thrown error or a missed deadline is `commitment_unverified` 503 with its real cause. The wrapper
 * names the reader's own `chainIdentity`, so the wire still refuses a reader whose chain is not an own data property or that is a
 * Proxy: those are returned as given.
 */
function boundedReceiptReader(reader) {
  const chain = typeof reader === 'function' && !types.isProxy(reader) ? Object.getOwnPropertyDescriptor(reader, 'chainIdentity') : undefined;
  if (chain === undefined || !Object.hasOwn(chain, 'value')) return reader;
  const bounded = async (...args) => {
    try { return await boundedCall(() => reader(...args), { timeoutMs: COMMITMENT_RECEIPT_TIMEOUT_MS }); } catch (cause) { throw new WireError('commitment_unverified', 503, undefined, cause); }
  };
  return Object.assign(bounded, { chainIdentity: chain.value });
}

/**
 * Admit the exact text of an answer before it is stored: valid UTF-8, and a JSON object the wire will sign.
 * Returns the same text. Throws `outgoing_body_rejected` 500 with the wire's own error as its cause.
 */
function admitAnswerText(text) {
  try {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.toString('utf8') !== text) throw new TypeError('the answer text is not valid UTF-8');
    admitWireResponseBody(bytes);
  } catch (cause) { throw new WireError('outgoing_body_rejected', 500, undefined, cause); }
  return text;
}

/**
 * The one wire context of a seller, and the only place operator code becomes callable for the signed routes: `local()` is
 * `tp1Network.connection()` called on `tp1Network`, `tuple(jobId)` the tuple the store keeps for a job, `now()`, `ready()`
 * and `retainedFor` the agent's retained records, `continuationFor` a continuing route's commitment, Agreement and
 * `signedListing`; `binding` (whose authority reader carries its own deadline), `signer`, `journal`, `store` (the raw transport
 * store for durable reservation accounting), `readCommitmentReceipt` and `requireDelegation` are values. `stopped()` is the host's stop
 * check, which the challenge route (`context` with `wire`) requires: it is `null` when none is given. Returns the frozen context,
 * the only `wire` option `createSellerHttpHandler` takes. Throws a TypeError for a member of the wrong kind.
 */
export function createWireContext({ binding, tp1Network, signer, store, journal, ready, now, agent, requireDelegation, signedListing, readCommitmentReceipt, capacity, reservations, stopped = null }) {
  const callables = [tp1Network?.connection, signer?.sign, store?.purchaseProfile, store?.sessionTerminal, store?.reservationAccounting?.reserveAccounted, ready, now, agent?.transportAgreementOf, agent?.continuationEvidenceOf, readCommitmentReceipt];
  if (callables.some((member) => typeof member !== 'function') || typeof signer.claim !== 'string' || typeof requireDelegation !== 'boolean' ||
      [binding, journal].some((value) => value === null || typeof value !== 'object')) throw new TypeError('the wire context needs a binding, journal, signer, transport store, readiness, clock, retained Agreement scope, continuation evidence, commitment receipt reader and connection() of the right kinds');
  if (stopped !== null && typeof stopped !== 'function') throw new TypeError('the wire context\'s stop check must be a function');
  const context = Object.freeze({ binding, signer, journal, store, reservations, requireDelegation, readCommitmentReceipt,
    local: () => tp1Network.connection(), tuple: (jobId) => store.purchaseProfile(jobId), now: () => now(), ready: () => ready(),
    stopped: stopped === null ? null : () => stopped(),
    retainedFor: (input) => retainedFor(agent, input, { store, capacity }), continuationFor: (input) => continuationFor(agent, input, signedListing) });
  wireContexts.set(context, { agent, store });
  return context;
}

/**
 * Open the signed request envelope under the host's binding, carrying no kept tuple, and refuse a small-order signer. Calls
 * `onOpened(request)` as soon as the envelope is verified, so a refusal after it can be signed. Returns the opened envelope.
 * Throws the wire's own refusal for the envelope, or `peer_signature_invalid` / `peer_delegation_signature_invalid` (401).
 */
export async function openWireRequest(wire, header, onOpened) {
  const opened = await openWireEnvelope(header, 'request', { binding: wire.binding, local: wire.local(), purchaseProfile: null, requireDelegation: wire.requireDelegation });
  assertNoSmallOrderSigner(opened);
  onOpened(opened.payload);
  return opened;
}

/**
 * Open and admit one signed request on a wire route, in the wire's order: the envelope, the job's kept tuple, the exchange
 * and the retained parties, then the tuple gate and the seller's body checks. The checked request's deferred reserve
 * rechecks current authority and expiry after accounting commits. Nothing is reserved here and the wire journal is never
 * written. Calls `onOpened(request)` as soon
 * as the envelope is verified, so a refusal after it can be signed.
 * Returns `{ body, readbackOnly, profile, recheck }`: the admitted body, whether only an expired delegation authenticated the
 * request, the request's own tuple, which a reservation keeps or compares, and `recheck()`, which admits the same request again
 * on a fresh clock for work that follows without a reservation (a cached refresh). Records in `limits` the times the admitted
 * request and its delegation expire, for the store calls that follow admission.
 * Throws the wire's own refusal with its code, status and cause, `peer_unknown_job` 404 for a job the host holds nothing for
 * (only after the exchange checks pass), `tp1_purchase_profile_mismatch` 500 (cause `missing`) for a held job with neither
 * a kept tuple nor a bound completed operation after retirement, or the seller's body refusal.
 */
async function admitWireRoute(wire, agent, limits, { header, method, path, rawBody, body, onOpened }) {
  const opened = await openWireRequest(wire, header, onOpened);
  const request = opened.payload;
  // An initial proposal whose draft cannot be derived is refused after the exchange checks, so that a prefix refusal keeps its own code.
  let records = null, invalidDraft = null;
  try { records = wire.retainedFor({ path, request, body }); } catch (error) {
    if (error?.code !== 'peer_proposal_invalid') throw error;
    invalidDraft = error;
  }
  // A job the host holds nothing for has no record to compare the request with. This one lets the exchange checks run and
  // grants nothing: the answer is the refusal or the 404 below, and it is never passed on to a route.
  const { retained, artifacts, held } = records ?? { retained: retainedRecord(path, request), artifacts: [], held: false };
  const kept = wire.tuple(request.jobId);
  // Each check reads the clock, readiness, kept tuple and continuation texts anew, so a later recheck is never a stale one.
  const check = () => ({ binding: wire.binding, local: wire.local(), purchaseProfile: wire.tuple(request.jobId), seller: wire.signer.claim, listingPin: agent.listingPin,
    method, path, rawBody, now: wire.now(), requireDelegation: wire.requireDelegation, ready: wire.ready(), requestJournal: wire.journal, retained, artifacts,
    ...(CONTINUING_PATHS.includes(path) ? { ...wire.continuationFor({ path, request }), readCommitmentReceipt: boundedReceiptReader(wire.readCommitmentReceipt) } : {}) });
  // Admission never publishes. Effect requests keep the wire's deferred reservation for accounting's step 7.
  const checked = await checkWireRequest(opened, check());
  if (invalidDraft !== null) throw invalidDraft;
  if (records === null) throw new SellerTransportError('peer_unknown_job', 404);
  // Retirement removes the active purchase tuple. Only a completed operation whose journal
  // binds this request can replay without it; other held jobs still need their kept tuple.
  if (held && kept === null) {
    const view = wire.store.jobSlotReleased(request.jobId) && !isReadRoute(path)
      ? inspectWireOperation(wire.journal, request) : null;
    if (view?.state !== 'completed' || view.binding !== wireOperationBinding(request)) {
      throw new SellerTransportError('tp1_purchase_profile_mismatch', 500, { cause: 'missing' });
    }
  }
  validateBody(request, checked.body);
  limits.set(request, { request: request.expiresAt, delegation: opened.delegation?.payload.expiresAt ?? Infinity });
  return { checked, body: structuredClone(checked.body), readbackOnly: checked.readbackOnly, profile: request.profile, recheck: () => authorizeWireRequest(opened, check()) };
}

/**
 * The authenticator of the wire routes, in the shape the handler takes from either auth: `open` admits a request
 * (`{ body, read, readbackOnly(), reserveOptions, recheck() }`; a read route reserves nowhere, an effect route reserves with the
 * request's tuple), `sign` signs an answer under the tuple kept for the job (`undefined` for a request that names another seller,
 * which cannot be signed for: its refusal goes out unsigned), `encode` admits the text a stored answer keeps, and `store` is the
 * accounting and wire-effect adapter. Deferred reserve rechecks expiry; an expired recovery claim grants read-only work
 * and settles no retry or null end. `readbackOnly()` reads the clock each time too. Throws for a `wire` that createWireContext
 * did not make, whose seller or delegation rule differs from
 * `authentication`'s, or that was made for another agent than `agent` or another transport store than `authentication`'s:
 * its checks would read one agent's and one store's records while the other serves and journals the request.
 */
export function wireAuthenticator(wire, agent, authentication) {
  const owner = wireContexts.get(wire);
  if (owner === undefined) throw new TypeError('the wire option must be a createWireContext context');
  if (wire.signer.claim !== authentication?.seller || wire.requireDelegation !== authentication.requireDelegation) throw new Error('the wire context and the old authentication must name the same seller and delegation rule');
  if (owner.agent !== agent || owner.store !== transportStoreOf(authentication)) throw new Error('the wire context must be made for the handler\'s agent and the old authentication\'s transport store');
  // A retained effect is claimed and settled inside the agent's job fence after asynchronous waits. Recovery is
  // read-only once the request or delegation expires. A request this authenticator did not admit is expired.
  // An expiry once seen is kept, as the old guard's read-back set kept it: a clock that later reads earlier (a correction)
  // never makes the request live again.
  const limits = new WeakMap(), lapsed = new WeakMap(), admitted = new WeakMap();
  const reservations = new WeakMap(), claimed = new WeakSet();
  const lapse = (request) => {
    if (lapsed.has(request)) return lapsed.get(request);
    const at = wire.now(), admittedLimits = limits.get(request);
    if (admittedLimits === undefined || !Number.isSafeInteger(at) || at < 0) return 'peer_expired';
    const code = admittedLimits.delegation <= at ? 'peer_delegation_expired' : admittedLimits.request <= at ? 'peer_expired' : null;
    if (code !== null) lapsed.set(request, code);
    return code;
  };
  const expired = (request) => lapse(request) !== null;
  const refuse = (code = 'peer_reconciliation_conflict', status = 503) => { throw new SellerTransportError(code, status); };
  // As the old store's guards did, proposal work ends with its context session; the session is read at each check, after the
  // agent's own waits, because accounting's start check cannot cover work that follows it. Other routes are not fenced by it.
  const sessionEnded = (request) => request.path === DACS_SELLER_HTTP_PATHS.proposals && wire.store.sessionTerminal(request.jobId);
  // Inspection fences a capability already issued by reserve(); it never grants permission to recover.
  const owned = (reservation) => {
    const kept = reservations.get(reservation);
    if (kept === undefined) return refuse();
    const view = inspectWireOperation(wire.journal, kept.request);
    const at = wire.now();
    if (view.state !== 'pending' || view.attempt !== kept.effect.attempt || view.requestHash !== wireRequestHash(kept.request) ||
        view.binding !== wireOperationBinding(kept.request) || !Number.isSafeInteger(at) || at < 0 || at >= kept.effect.leaseUntil) return refuse();
    return kept;
  };
  const finish = (reservation, status, text, { noEffect = false, retry = false } = {}) => {
    const { effect } = owned(reservation);
    if (!Number.isSafeInteger(status) || status < 200 || status > 599) return refuse('peer_response_invalid');
    if (noEffect && retry) return refuse('peer_store_conflict');
    // An uncertain error keeps the lease open: only the lease ends an attempt whose process may have died, and it spends one
    // of the journal's crash attempts. A retained nonterminal answer is a normal answer, not a crash: it ends the attempt
    // with no outcome, which spends none, so the next request recovers at once and the agent reconciles it by read-back.
    if (!retry && !noEffect && status >= 500) return;
    completeWireEffect(wire.journal, effect, retry || noEffect ? null : { status, text });
  };
  const store = Object.freeze({
    reserve: async (request) => {
      const checked = admitted.get(request);
      if (checked === undefined || typeof checked.reserve !== 'function') return refuse('peer_expired', 408);
      const current = { body: checked.body, reserve: () => {
        const code = lapse(request);
        if (code !== null) return refuse(code, 408);
        return checked.reserve();
      } };
      const effect = await wire.store.reservationAccounting.reserveAccounted({ checked: current, payload: request, route: request.path,
        operationId: wireOperationId(request), keepProfile: request.profile,
        paymentTx: request.path === DACS_SELLER_HTTP_PATHS.payments ? checked.body.txHash : null });
      if (effect.state === 'completed') return Object.freeze({ disposition: 'cached', ...effect.outcome });
      const reservation = Object.freeze({ disposition: effect.state === 'new' ? 'perform' : 'uncertain', effectKey: effect.operationId });
      reservations.set(reservation, { effect, request });
      return reservation;
    },
    // The wire's reserve issued this recovery capability; claim it once inside the agent's job fence.
    claim: (reservation, request, { live = true } = {}) => {
      const kept = owned(reservation);
      if (kept.request !== request || reservation.disposition !== 'uncertain' || claimed.has(reservation)) return refuse();
      const canAct = live && !expired(request);
      // Read-only recovery is not fenced: it settles nothing and signs nothing.
      if (canAct && sessionEnded(request)) return refuse('seller_unavailable', 503);
      claimed.add(reservation);
      const check = () => {
        owned(reservation);
        if (canAct && expired(request)) return refuse(lapse(request), 408);
        if (canAct && sessionEnded(request)) return refuse('context_session_terminal', 409);
      };
      const claim = Object.freeze({ ...reservation, live: canAct, check });
      reservations.set(claim, kept);
      claimed.add(claim);
      return claim;
    },
    reconcile: (reservation, request, status, text, options = {}) => {
      if (!claimed.has(reservation) || reservations.get(reservation)?.request !== request) return refuse();
      if (reservation.live === false && (options.retry || options.noEffect)) return refuse(lapse(request) ?? 'peer_expired', 408);
      finish(reservation, status, text, options);
    },
    finish,
    assertPending: (reservation) => {
      const { request } = owned(reservation);
      if (expired(request)) return refuse(lapse(request), 408);
      if (sessionEnded(request)) return refuse('context_session_terminal', 409);
    },
  });
  return Object.freeze({
    store,
    encode: admitAnswerText,
    open: async (input) => {
      let opened = null;
      const { checked, body, readbackOnly, profile, recheck } = await admitWireRoute(wire, agent, limits, { ...input, onOpened: (request) => { opened = request; input.onOpened(request); } });
      admitted.set(opened, checked);
      return { body, read: isReadRoute(input.path), readbackOnly: () => readbackOnly || expired(opened), reserveOptions: { journaledOnly: readbackOnly, keepProfile: profile }, recheck };
    },
    sign: (request, status, text) => (request.seller !== wire.signer.claim ? undefined
      : signWireResponse(request, status, text, { signer: wire.signer, binding: wire.binding, local: wire.local(), purchaseProfile: wire.tuple(request.jobId), now: wire.now() })),
  });
}
