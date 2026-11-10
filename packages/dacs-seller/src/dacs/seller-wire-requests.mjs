// What a signed request on `./wire` is checked against, and what an answer must pass before it is stored.
// The retained Agreement or draft, its parties and the kept TP-1 tuple are the host's own records: nothing here
// takes them from the request, except the one exchange-only record for a job the host holds nothing for.
import { types } from 'node:util';
import { contentHash, createFixedPriceAgreementSigningPlan } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_PATHS, WireError, admitWireArtifact, admitWireResponseBody, authorizeWireRequest, checkWireRequest, isReadRoute, openWireEnvelope } from '@kynesyslabs/dacs/wire';
import { boundedCall } from './bounded-call.mjs';
import { isSmallOrderPublicKey } from './demos-claims.mjs';
import { SellerTransportError, sellerStoreInternals, validateBody } from './seller-transport-auth.mjs';

// The routes that continue a committed purchase: the wire admits them only on the purchase's commitment, Agreement and Listing.
const CONTINUING_PATHS = Object.freeze([DACS_SELLER_HTTP_PATHS.payments, DACS_SELLER_HTTP_PATHS.bundleRequest, DACS_SELLER_HTTP_PATHS.bundleCountersignature, DACS_SELLER_HTTP_PATHS.bundleBuyerCopy]);
const COMMITMENT_RECEIPT_TIMEOUT_MS = 10000;

/** The routes this module answers through the wire; only the challenge and the context step keep the old server auth. */
export const WIRE_ROUTE_PATHS = Object.freeze([DACS_SELLER_HTTP_PATHS.proposals, DACS_SELLER_HTTP_PATHS.state, DACS_SELLER_HTTP_PATHS.commitments, DACS_SELLER_HTTP_PATHS.commitmentSignature, ...CONTINUING_PATHS]);
// The routes that start or commit a purchase carry the host's own `allocated` flag (false unless the purchase holds a live allocation).
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
 * (never for a proposal). On the routes that start or commit a purchase, `allocated` is the capacity's `retainedAllocated`: the
 * purchase holds a live allocation for the route and the host's own K1 start for the job settled with a validated context
 * (a request never sets it); it stays false when no `{ store, capacity }` is given. Throws `peer_proposal_invalid` for an
 * initial proposal whose draft cannot be derived, or a TypeError for retained parties that are not strings.
 */
export function retainedFor(agent, { path, request, body }, { store, capacity } = {}) {
  const known = agent.transportAgreementOf(request.jobId);
  const records = known !== null ? retainedByArtifact(path, known) : path === DACS_SELLER_HTTP_PATHS.proposals ? retainedByArtifact(path, initialDraft(body)) : null;
  if (records !== null && capacity !== undefined && STAGE_PATHS.has(path)) {
    const { buyer, seller } = records.retained;
    records.retained.allocated = capacity.retainedAllocated({ jobId: request.jobId, buyer, seller, listingPin: agent.listingPin, route: path, stageAuthorized: contextSettledAsSuccess(store, request.jobId) });
  }
  return records;
}

// The host's verified accepted context for a job: its K1 start settled with a validated `present` context.
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
export function continuationFor(agent, { request }, signedListing) {
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
 * and the retained parties. Nothing is reserved here and the wire journal is never written. Calls `onOpened(request)` as soon as
 * the envelope is verified, so a refusal after it can be signed.
 * Returns `{ body, readbackOnly, recheck, reserve, retainedWork }`: the admitted body, whether only an expired delegation authenticated
 * the request, `recheck()`, which admits the same request again on a fresh clock for work that follows without a reservation (a
 * cached refresh), `reserve`, the wire's journal reservation of an effect route (null on a read route), which re-checks current
 * authority and expiry first, and `retainedWork`, whether the host retains a purchase stage of this route for the job.
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
  // Each check reads the clock, readiness, kept tuple and continuation texts anew, so a later recheck is never a stale one.
  const check = () => ({ binding: wire.binding, local: wire.connection(), purchaseProfile: wire.store.purchaseProfile(request.jobId), seller: wire.signer.claim, listingPin: agent.listingPin,
    method, path, rawBody, now: wire.now(), requireDelegation: wire.requireDelegation, ready: wire.ready(), requestJournal: wire.journal, ...checkedAgainst,
    ...(CONTINUING_PATHS.includes(path) ? { ...wire.continuationFor({ path, request }), readCommitmentReceipt: boundedReceiptReader(wire.readCommitmentReceipt) } : {}) });
  // Neither call writes the journal: only `checked.reserve()` does.
  const checked = await checkWireRequest(opened, check());
  if (invalidDraft !== null) throw invalidDraft;
  if (records === null) throw new SellerTransportError('peer_unknown_job', 404);
  // A read reserves nothing, so the store's refusal of an absent tuple never meets it: a job the agent holds without a kept
  // tuple (one retained before tuples were kept) is not answered, as the effect routes refuse it at their reservation.
  if (isReadRoute(path) && wire.store.purchaseProfile(request.jobId) === null) throw new SellerTransportError('tp1_purchase_profile_mismatch', 500, { cause: 'missing' });
  validateBody(request, checked.body);
  return { body: structuredClone(checked.body), readbackOnly: checked.readbackOnly, recheck: () => authorizeWireRequest(opened, check()), reserve: checked.reserve, retainedWork: checkedAgainst.retained.allocated === true };
}
