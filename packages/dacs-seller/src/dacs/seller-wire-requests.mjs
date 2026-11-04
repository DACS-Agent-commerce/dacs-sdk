// What a signed request on `./wire` is checked against, and what an answer must pass before it is stored.
// The retained Agreement or draft, its parties and the kept TP-1 tuple are the host's own records: nothing here
// takes them from the request, except the one exchange-only record for a job the host holds nothing for.
import { contentHash, createFixedPriceAgreementSigningPlan } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_PATHS, WireError, admitWireResponseBody, authorizeWireRequest, checkWireRequest, isReadRoute, openWireEnvelope } from '@kynesyslabs/dacs/wire';
import { isSmallOrderPublicKey } from './demos-claims.mjs';
import { SellerTransportError, validateBody } from './seller-transport-auth.mjs';

/** The routes this module answers through the wire; every other route keeps the old server auth until P11a1b. */
export const WIRE_ROUTE_PATHS = Object.freeze([DACS_SELLER_HTTP_PATHS.proposals, DACS_SELLER_HTTP_PATHS.state, DACS_SELLER_HTTP_PATHS.commitments, DACS_SELLER_HTTP_PATHS.commitmentSignature]);
// The routes that start or commit a purchase carry the host's own `allocated` flag (false until the purchase allocation exists).
const STAGE_PATHS = new Set([DACS_SELLER_HTTP_PATHS.proposals, DACS_SELLER_HTTP_PATHS.commitments, DACS_SELLER_HTTP_PATHS.commitmentSignature]);

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
 * What the host retained for the request's job, for `checkWireRequest`: `{ retained, artifacts }` from the agent's retained
 * plan or Agreement, or from the draft an initial proposal itself carries. `null` when the host holds nothing for the job
 * (never for a proposal). Throws `peer_proposal_invalid` for an initial proposal whose draft cannot be derived.
 */
export function retainedFor(agent, { path, request, body }) {
  const known = agent.transportAgreementOf(request.jobId);
  if (known !== null) return retainedByArtifact(path, known);
  return path === DACS_SELLER_HTTP_PATHS.proposals ? retainedByArtifact(path, initialDraft(body)) : null;
}

/**
 * Admit the exact text of an answer before it is stored: valid UTF-8, and a JSON object the wire will sign.
 * Returns the same text. Throws `outgoing_body_rejected` 500 with the wire's own error as its cause.
 */
export function admitAnswerText(text) {
  try {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.toString('utf8') !== text) throw new TypeError('the answer text is not valid UTF-8');
    admitWireResponseBody(bytes);
  } catch (cause) { throw new WireError('outgoing_body_rejected', 500, undefined, cause); }
  return text;
}

/**
 * Open and admit one signed request on a wire route, in the wire's order: the envelope, the job's kept tuple, the exchange
 * and the retained parties and, on an effect route, the wire's recheck of current authority and expiry, which is the last
 * asynchronous step: the seller's own body checks that follow are synchronous, so the caller's reservation follows the recheck
 * at once. Nothing is reserved here and the wire journal is never written. Calls `onOpened(request)` as soon as the envelope
 * is verified, so a refusal after it can be signed.
 * Returns `{ body, readbackOnly }`: the admitted body and whether only an expired delegation authenticated the request.
 * Throws the wire's own refusal with its code, status and cause, `peer_unknown_job` 404 for a job the host holds nothing for
 * (only after the exchange checks pass), or the seller's body refusal.
 */
export async function admitWireRoute(wire, agent, { header, method, path, rawBody, body, onOpened }) {
  const opened = await openWireEnvelope(header, 'request', { binding: wire.binding, local: wire.connection(), purchaseProfile: null, requireDelegation: wire.requireDelegation });
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
  const checkedAgainst = records ?? { retained: retainedRecord(path, request), artifacts: [] };
  const check = { binding: wire.binding, local: wire.connection(), purchaseProfile: wire.store.purchaseProfile(request.jobId), seller: wire.signer.claim, listingPin: agent.listingPin,
    method, path, rawBody, now: wire.now(), requireDelegation: wire.requireDelegation, ready: wire.ready(), requestJournal: wire.journal, ...checkedAgainst };
  // Both calls leave the journal alone; `authorizeWireRequest` also runs the recheck an old-store reservation needs.
  const admit = isReadRoute(path) || records === null ? checkWireRequest : authorizeWireRequest;
  const checked = await admit(opened, check);
  if (invalidDraft !== null) throw invalidDraft;
  if (records === null) throw new SellerTransportError('peer_unknown_job', 404);
  // A read reserves nothing, so the store's refusal of an absent tuple never meets it: a job the agent holds without a kept
  // tuple (one retained before tuples were kept) is not answered, as the effect routes refuse it at their reservation.
  if (isReadRoute(path) && check.purchaseProfile === null) throw new SellerTransportError('tp1_purchase_profile_mismatch', 500, { cause: 'missing' });
  validateBody(request, checked.body);
  return { body: structuredClone(checked.body), readbackOnly: checked.readbackOnly };
}
