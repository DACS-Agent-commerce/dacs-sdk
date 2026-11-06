// What a signed request on `./wire` is checked against, and what an answer must pass before it is stored.
// The retained Agreement or draft, its parties and the kept TP-1 tuple are the host's own records: nothing here
// takes them from the request, except the one exchange-only record for a job the host holds nothing for.
// The operator's network, store, clock and agent reach the signed routes only through one wire context (createWireContext).
import { types } from 'node:util';
import { contentHash, createFixedPriceAgreementSigningPlan } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_PATHS, WireError, admitWireArtifact, admitWireResponseBody, authorizeWireRequest, checkWireRequest, isReadRoute, openWireEnvelope, signWireResponse } from '@kynesyslabs/dacs/wire';
import { boundedCall } from './bounded-call.mjs';
import { isSmallOrderPublicKey } from './demos-claims.mjs';
import { SellerTransportError, transportStoreOf, validateBody } from './seller-transport-auth.mjs';

// The routes that continue a committed purchase: the wire admits them only on the purchase's commitment, Agreement and Listing.
const CONTINUING_PATHS = Object.freeze([DACS_SELLER_HTTP_PATHS.payments, DACS_SELLER_HTTP_PATHS.bundleRequest, DACS_SELLER_HTTP_PATHS.bundleCountersignature, DACS_SELLER_HTTP_PATHS.bundleBuyerCopy]);
const COMMITMENT_RECEIPT_TIMEOUT_MS = 10000;

/**
 * The routes the wire opens and signs. `commitments/signature` is one only where the handler mounts it (`commitOnSignature`);
 * only the challenge and the context step keep the old server auth.
 */
export const WIRE_ROUTE_PATHS = Object.freeze([DACS_SELLER_HTTP_PATHS.proposals, DACS_SELLER_HTTP_PATHS.state, DACS_SELLER_HTTP_PATHS.commitments, DACS_SELLER_HTTP_PATHS.commitmentSignature, ...CONTINUING_PATHS]);
// The routes that start or commit a purchase carry the host's own `allocated` flag (false until the purchase allocation exists).
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
 * (never for a proposal). Throws `peer_proposal_invalid` for an initial proposal whose draft cannot be derived.
 */
function retainedFor(agent, { path, request, body }) {
  const known = agent.transportAgreementOf(request.jobId);
  if (known !== null) return { ...retainedByArtifact(path, known), held: true };
  return path === DACS_SELLER_HTTP_PATHS.proposals ? { ...retainedByArtifact(path, initialDraft(body)), held: false } : null;
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
 * store, the routes' only journal), `readCommitmentReceipt` and `requireDelegation` are values. Returns the frozen context, the
 * only `wire` option `createSellerHttpHandler` takes. Throws a TypeError for a member of the wrong kind.
 */
export function createWireContext({ binding, tp1Network, signer, store, journal, ready, now, agent, requireDelegation, signedListing, readCommitmentReceipt }) {
  const callables = [tp1Network?.connection, signer?.sign, store?.purchaseProfile, store?.reserve, ready, now, agent?.transportAgreementOf, agent?.continuationEvidenceOf, readCommitmentReceipt];
  if (callables.some((member) => typeof member !== 'function') || typeof signer.claim !== 'string' || typeof requireDelegation !== 'boolean' ||
      [binding, journal].some((value) => value === null || typeof value !== 'object')) throw new TypeError('the wire context needs a binding, journal, signer, transport store, readiness, clock, retained Agreement scope, continuation evidence, commitment receipt reader and connection() of the right kinds');
  const context = Object.freeze({ binding, signer, journal, store, requireDelegation, readCommitmentReceipt,
    local: () => tp1Network.connection(), tuple: (jobId) => store.purchaseProfile(jobId), now: () => now(), ready: () => ready(),
    retainedFor: (input) => retainedFor(agent, input), continuationFor: (input) => continuationFor(agent, input, signedListing) });
  wireContexts.set(context, { agent, store });
  return context;
}

/**
 * Open and admit one signed request on a wire route, in the wire's order: the envelope, the job's kept tuple, the exchange
 * and the retained parties and, on an effect route, the wire's recheck of current authority and expiry, which is the last
 * asynchronous step: the tuple gate and the seller's own body checks that follow are synchronous, so the caller's reservation
 * follows the recheck at once. Nothing is reserved here and the wire journal is never written. Calls `onOpened(request)` as soon
 * as the envelope is verified, so a refusal after it can be signed.
 * Returns `{ body, readbackOnly, profile, recheck }`: the admitted body, whether only an expired delegation authenticated the
 * request, the request's own tuple, which a reservation keeps or compares, and `recheck()`, which admits the same request again
 * on a fresh clock for work that follows without a reservation (a cached refresh). Records in `limits` the times the admitted
 * request and its delegation expire, for the store calls that follow admission.
 * Throws the wire's own refusal with its code, status and cause, `peer_unknown_job` 404 for a job the host holds nothing for
 * (only after the exchange checks pass), `tp1_purchase_profile_mismatch` 500 (cause `missing`) for a held job with no kept
 * tuple, or the seller's body refusal.
 */
async function admitWireRoute(wire, agent, limits, { header, method, path, rawBody, body, onOpened }) {
  const opened = await openWireEnvelope(header, 'request', { binding: wire.binding, local: wire.local(), purchaseProfile: null, requireDelegation: wire.requireDelegation });
  assertNoSmallOrderSigner(opened);
  const request = opened.payload;
  onOpened(request);
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
  // Both calls leave the journal alone; `authorizeWireRequest` also runs the recheck an old-store reservation needs.
  const admit = isReadRoute(path) || records === null ? checkWireRequest : authorizeWireRequest;
  const checked = await admit(opened, check());
  if (invalidDraft !== null) throw invalidDraft;
  if (records === null) throw new SellerTransportError('peer_unknown_job', 404);
  // The one tuple gate of every wire route: a job the agent holds with no kept tuple (one retained before tuples were kept, or
  // whose store row is gone) is never answered, and never reserved, where a new reservation would adopt the request's tuple.
  if (held && kept === null) throw new SellerTransportError('tp1_purchase_profile_mismatch', 500, { cause: 'missing' });
  validateBody(request, checked.body);
  limits.set(request, { request: request.expiresAt, delegation: opened.delegation?.payload.expiresAt ?? Infinity });
  return { body: structuredClone(checked.body), readbackOnly: checked.readbackOnly, profile: request.profile, recheck: () => authorizeWireRequest(opened, check()) };
}

/**
 * The authenticator of the wire routes, in the shape the handler takes from either auth: `open` admits a request
 * (`{ body, read, readbackOnly(), reserveOptions, recheck() }`; a read route reserves nowhere, an effect route reserves with the
 * request's tuple), `sign` signs an answer under the tuple kept for the job (`undefined` for a request that names another seller,
 * which cannot be signed for: its refusal goes out unsigned), `encode` admits the text a stored answer keeps, and `store` is the
 * raw transport store with the admitted request's expiry applied at each call (an expired request reserves and claims read-only
 * and settles no retry or removal). `readbackOnly()` reads the clock each time too. Throws for a `wire` that createWireContext
 * did not make, whose seller or delegation rule differs from
 * `authentication`'s, or that was made for another agent than `agent` or another transport store than `authentication`'s:
 * its checks would read one agent's and one store's records while the other serves and journals the request.
 */
export function wireAuthenticator(wire, agent, authentication) {
  const owner = wireContexts.get(wire);
  if (owner === undefined) throw new TypeError('the wire option must be a createWireContext context');
  if (wire.signer.claim !== authentication?.seller || wire.requireDelegation !== authentication.requireDelegation) throw new Error('the wire context and the old authentication must name the same seller and delegation rule');
  if (owner.agent !== agent || owner.store !== transportStoreOf(authentication)) throw new Error('the wire context must be made for the handler\'s agent and the old authentication\'s transport store');
  // The store is called again after admission (a retained effect is claimed and settled inside the agent's job fence, after
  // asynchronous waits), so a request is read-only from the moment it or its delegation expires, as the old guarded store
  // decided on every call. A request this authenticator did not admit is expired.
  const limits = new WeakMap();
  const lapse = (request) => {
    const at = wire.now(), admittedLimits = limits.get(request);
    if (admittedLimits === undefined || !Number.isSafeInteger(at) || at < 0) return 'peer_expired';
    if (admittedLimits.delegation <= at) return 'peer_delegation_expired';
    return admittedLimits.request <= at ? 'peer_expired' : null;
  };
  const expired = (request) => lapse(request) !== null;
  const store = Object.freeze({
    reserve: (request, body, options = {}) => wire.store.reserve(request, body, expired(request) ? { ...options, journaledOnly: true } : options),
    // An expired request may still take an effect to read it back, never to run it again.
    claim: (reservation, request, options = {}) => wire.store.claim(reservation, request, expired(request) ? { ...options, live: false } : options),
    // Settle against the claim's granted mode: a read-only claim never leaves an effect to run again or deletes it.
    reconcile: (reservation, request, status, text, options = {}) => {
      if (reservation?.live === false && (options.retry || options.noEffect)) throw new SellerTransportError(lapse(request) ?? 'peer_expired', 408);
      return wire.store.reconcile(reservation, request, status, text, options);
    },
    finish: (...args) => wire.store.finish(...args),
    assertPending: (reservation) => wire.store.assertPending(reservation),
  });
  return Object.freeze({
    store,
    encode: admitAnswerText,
    open: async (input) => {
      let opened = null;
      const { body, readbackOnly, profile, recheck } = await admitWireRoute(wire, agent, limits, { ...input, onOpened: (request) => { opened = request; input.onOpened(request); } });
      return { body, read: isReadRoute(input.path), readbackOnly: () => readbackOnly || expired(opened), reserveOptions: { journaledOnly: readbackOnly, keepProfile: profile }, recheck };
    },
    sign: (request, status, text) => (request.seller !== wire.signer.claim ? undefined
      : signWireResponse(request, status, text, { signer: wire.signer, binding: wire.binding, local: wire.local(), purchaseProfile: wire.tuple(request.jobId), now: wire.now() })),
  });
}
