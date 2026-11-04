// What a signed request on `./wire` is checked against, and what an answer must pass before it is stored.
// The retained Agreement or draft, its parties and the kept TP-1 tuple are the host's own records: nothing here
// takes them from the request, except the one exchange-only record for a job the host holds nothing for.
// The operator's network, store, clock and agent reach the signed routes only through one wire context (createWireContext).
import { contentHash, createFixedPriceAgreementSigningPlan } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_PATHS, WireError, admitWireResponseBody, authorizeWireRequest, checkWireRequest, isReadRoute, openWireEnvelope, signWireResponse } from '@kynesyslabs/dacs/wire';
import { isSmallOrderPublicKey } from './demos-claims.mjs';
import { SellerTransportError, validateBody } from './seller-transport-auth.mjs';

/**
 * The routes the wire opens and signs. `commitments/signature` is one only where the handler mounts it (`commitOnSignature`);
 * every other route keeps the old server auth.
 */
export const WIRE_ROUTE_PATHS = Object.freeze([DACS_SELLER_HTTP_PATHS.proposals, DACS_SELLER_HTTP_PATHS.state, DACS_SELLER_HTTP_PATHS.commitments, DACS_SELLER_HTTP_PATHS.commitmentSignature]);
// The routes that start or commit a purchase carry the host's own `allocated` flag (false until the purchase allocation exists).
const STAGE_PATHS = new Set([DACS_SELLER_HTTP_PATHS.proposals, DACS_SELLER_HTTP_PATHS.commitments, DACS_SELLER_HTTP_PATHS.commitmentSignature]);
// The contexts createWireContext made: the handler takes no other.
const wireContexts = new WeakSet();

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
 * and `retainedFor` the agent's retained records; `binding` (whose authority reader carries its own deadline), `signer`,
 * `journal`, `store` (the raw transport store, the routes' only journal) and `requireDelegation` are values. Returns the frozen
 * context, the only `wire` option `createSellerHttpHandler` takes. Throws a TypeError for a member of the wrong kind.
 */
export function createWireContext({ binding, tp1Network, signer, store, journal, ready, now, agent, requireDelegation }) {
  const callables = [tp1Network?.connection, signer?.sign, store?.purchaseProfile, store?.reserve, ready, now, agent?.transportAgreementOf];
  if (callables.some((member) => typeof member !== 'function') || typeof signer.claim !== 'string' || typeof requireDelegation !== 'boolean' ||
      [binding, journal].some((value) => value === null || typeof value !== 'object')) throw new TypeError('the wire context needs a binding, journal, signer, transport store, readiness, clock, retained Agreement scope and connection() of the right kinds');
  const context = Object.freeze({ binding, signer, journal, store, requireDelegation,
    local: () => tp1Network.connection(), tuple: (jobId) => store.purchaseProfile(jobId), now: () => now(), ready: () => ready(),
    retainedFor: (input) => retainedFor(agent, input) });
  wireContexts.add(context);
  return context;
}

/**
 * Open and admit one signed request on a wire route, in the wire's order: the envelope, the job's kept tuple, the exchange
 * and the retained parties and, on an effect route, the wire's recheck of current authority and expiry, which is the last
 * asynchronous step: the tuple gate and the seller's own body checks that follow are synchronous, so the caller's reservation
 * follows the recheck at once. Nothing is reserved here and the wire journal is never written. Calls `onOpened(request)` as soon
 * as the envelope is verified, so a refusal after it can be signed.
 * Returns `{ body, readbackOnly, profile }`: the admitted body, whether only an expired delegation authenticated the request,
 * and the request's own tuple, which a reservation keeps or compares.
 * Throws the wire's own refusal with its code, status and cause, `peer_unknown_job` 404 for a job the host holds nothing for
 * (only after the exchange checks pass), `tp1_purchase_profile_mismatch` 500 (cause `missing`) for a held job with no kept
 * tuple, or the seller's body refusal.
 */
async function admitWireRoute(wire, agent, { header, method, path, rawBody, body, onOpened }) {
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
  const check = { binding: wire.binding, local: wire.local(), purchaseProfile: kept, seller: wire.signer.claim, listingPin: agent.listingPin,
    method, path, rawBody, now: wire.now(), requireDelegation: wire.requireDelegation, ready: wire.ready(), requestJournal: wire.journal, retained, artifacts };
  // Both calls leave the journal alone; `authorizeWireRequest` also runs the recheck an old-store reservation needs.
  const admit = isReadRoute(path) || records === null ? checkWireRequest : authorizeWireRequest;
  const checked = await admit(opened, check);
  if (invalidDraft !== null) throw invalidDraft;
  if (records === null) throw new SellerTransportError('peer_unknown_job', 404);
  // The one tuple gate of every wire route: a job the agent holds with no kept tuple (one retained before tuples were kept, or
  // whose store row is gone) is never answered, and never reserved, where a new reservation would adopt the request's tuple.
  if (held && kept === null) throw new SellerTransportError('tp1_purchase_profile_mismatch', 500, { cause: 'missing' });
  validateBody(request, checked.body);
  return { body: structuredClone(checked.body), readbackOnly: checked.readbackOnly, profile: request.profile };
}

/**
 * The authenticator of the wire routes, in the shape the handler takes from either auth: `open` admits a request
 * (`{ body, read, readbackOnly(), reserveOptions }`; a read route reserves nowhere, an effect route reserves with the request's
 * tuple), `sign` signs an answer under the tuple kept for the job (`undefined` for a request that names another seller, which
 * cannot be signed for: its refusal goes out unsigned), `encode` admits the text a stored answer keeps, and `store` is the raw
 * transport store. Throws for a `wire` that createWireContext did not make, or whose seller or delegation rule differs from
 * `authentication`'s.
 */
export function wireAuthenticator(wire, agent, authentication) {
  if (!wireContexts.has(wire)) throw new TypeError('the wire option must be a createWireContext context');
  if (wire.signer.claim !== authentication?.seller || wire.requireDelegation !== authentication.requireDelegation) throw new Error('the wire context and the old authentication must name the same seller and delegation rule');
  return Object.freeze({
    store: wire.store,
    encode: admitAnswerText,
    open: async (input) => {
      const { body, readbackOnly, profile } = await admitWireRoute(wire, agent, input);
      return { body, read: isReadRoute(input.path), readbackOnly: () => readbackOnly, reserveOptions: { journaledOnly: readbackOnly, keepProfile: profile } };
    },
    sign: (request, status, text) => (request.seller !== wire.signer.claim ? undefined
      : signWireResponse(request, status, text, { signer: wire.signer, binding: wire.binding, local: wire.local(), purchaseProfile: wire.tuple(request.jobId), now: wire.now() })),
  });
}
