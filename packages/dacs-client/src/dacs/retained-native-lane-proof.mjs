// The retained proof behind a native purchase's one-time wallet guard, read back from the local stores only: the
// approved handoff, the seller commitment and Agreement it was verified against, and the guard's issuance. Nothing
// here reads the chain, the seller or the wallet journal, and nothing is refreshed or saved.
import { createHash } from 'node:crypto';
import { canonicalize, decodeDemosAnchorReceiptProof } from '@kynesyslabs/dacs';
import { OperationError } from '../client-errors.mjs';
import { payloadHash } from './wallet-transactions.mjs';
import { createNonceOf, usesNativeAgreementPayment } from './native-agreement-payment-consumer.mjs';

// Domain separator of the purchase commitment (approval-bound, not on chain).
export const COMMITMENT_DOMAIN = 'dacs-chatgpt-plugin/fixed-price-dem-purchase-commitment/v1';

// Unique per purchase (operation id), domain-separated, over the terms hash and
// the fields the transfer must match. Bound in the wallet-signed approval only:
// the native DEM transfer cannot carry it.
export function purchaseCommitment(operation) {
  const t = operation.terms;
  return createHash('sha256').update(canonicalize({
    domain: COMMITMENT_DOMAIN,
    operation: operation.id,
    termsHash: operation.termsHash,
    listing: `${t.listing.listingId}@v${t.listing.version}`,
    listingHash: t.listing.contentHash,
    payer: t.buyer.wallet,
    payee: t.seller.payee,
    amountOs: t.price.amountOs,
    network: t.network,
    rail: t.rail,
    domainMode: t.domain?.mode ?? null,
    chainIdentity: t.domain?.chainIdentity ?? null,
  })).digest('hex');
}

/** Returns the SHA-256 hex of the canonical saved seller commitment, which a native handoff event records. Throws if it cannot be canonicalized. */
export const sellerCommitmentWitness = (commitment) => createHash('sha256').update(canonicalize(commitment)).digest('hex');

const held = () => new OperationError('native_payment_lane_held', 'a normal approved, one-time native handoff is required; CREATE authority is not payment authority');
const unverified = (what, options) => new OperationError('native_payment_lane_unverified', `the retained native payment proof does not hold (${what}); it was not refreshed and nothing was signed or sent`, undefined, options);
const text = (value) => typeof value === 'string' && value.length > 0;
const instant = (value) => (text(value) ? Date.parse(value) : NaN);
const lastEvent = (history, type) => history.findLast((event) => event.type === type) ?? null;

// The purchase's declared domain and transport binding; with the protocol's own source pins, also their exact match.
function assertSourceTerms(t, sourcePins) {
  const domain = t.domain, binding = t.protocol.transportBinding;
  if (domain?.mode !== 'public-chain-read' || domain.network !== t.network || domain.rail !== t.rail || !text(domain.chainIdentity)
    || !text(binding?.network) || !text(binding.chainIdentity)) throw unverified('domain or transport binding');
  if (sourcePins && (t.network !== sourcePins.network || domain.chainIdentity !== sourcePins.chainIdentity
    || canonicalize(binding) !== canonicalize(sourcePins.transportBinding))) throw unverified('source binding');
}

// The retained Agreement CREATE receipt: its hash and its nonce, parsed once from the canonical decimal string.
function retainedCreate(operation) {
  const agreement = operation.state.protocol.agreement, receipt = agreement?.anchorReceipt;
  try { decodeDemosAnchorReceiptProof(receipt); } catch (cause) { throw unverified('Agreement receipt', { cause }); }
  const nonce = createNonceOf(receipt.nonce);
  if (!text(receipt.nativeAddress) || nonce === null || agreement.terms?.payee !== operation.terms.seller.payee
    || agreement.terms?.price?.amountOs !== operation.terms.price.amountOs) throw unverified('Agreement receipt');
  return { hash: receipt.transactionRef.value, nonce };
}

// The approved handoff: coordinates match the terms and the handoff event, which was saved after the verified commitment.
function assertHandoff(operation, coords, handoff) {
  const t = operation.terms, p = operation.state.protocol, d = handoff?.data, commitment = p.commitment;
  if (!d) throw unverified('handoff event');
  if (!text(commitment?.signer) || !text(commitment.contentHash) || Number.isNaN(instant(commitment.committedAt))
    || !(instant(commitment.verifiedAt) <= instant(handoff.at))) throw unverified('seller commitment');
  const chainMode = operation.state.preparedVerification?.evidence?.chainMode;
  if (!text(chainMode) || d.recheck !== chainMode || d.commitment !== purchaseCommitment(operation) || d.sellerCommitmentWitness !== sellerCommitmentWitness(commitment)) {
    throw unverified('handoff event');
  }
  if (coords.network !== t.network || coords.from !== t.buyer.wallet || coords.target !== t.seller.payee || coords.amountOs !== t.price.amountOs
    || coords.payloadHash !== payloadHash(coords.payload) || !Number.isSafeInteger(coords.nonceFence) || coords.nonceFence < 0 || coords.expectedNonce !== coords.nonceFence + 1
    || d.nonceFence !== coords.nonceFence || d.expectedNonce !== coords.expectedNonce || d.payloadHash !== coords.payloadHash) throw unverified('handoff coordinates');
}

/**
 * Reads the retained proof that this native purchase's one-time wallet guard was issued after an approved, verified
 * handoff: `approvalFor(id)` returns the approval row, and `ops` and `coordinates` are the purchase stores. With
 * `sourcePins` ({network, chainIdentity, transportBinding} of the protocol's own source) the terms must match them exactly.
 * Returns {operation, create: {hash, nonce}, snapshot}, where snapshot is the canonical text of every row and event read.
 * Throws not_found, the buyer access refusal, native_payment_lane_held (no approved native handoff, or no guard issued)
 * or native_payment_lane_unverified (a retained record is missing, stale or does not match).
 */
export function readRetainedNativeLaneProof({ approvalFor, ops, coordinates, assertBuyerAccess, accountId, id, sourcePins = null }) {
  const operation = ops.get(accountId, id);
  if (!operation) throw new OperationError('not_found', 'purchase not found');
  assertBuyerAccess(operation.terms.buyer.wallet, operation);
  const approval = approvalFor(id) ?? null, coords = coordinates.get(id), history = ops.history(id);
  if (!usesNativeAgreementPayment(operation) || operation.status !== 'payment_handoff' || !coords || !approval
    || approval.terms_hash !== operation.termsHash || approval.signer_address !== operation.terms.buyer.wallet) throw held();
  if (operation.state.protocol?.stage !== 'seller-committed') throw unverified('protocol stage');
  if (operation.state.protocol.nativePaymentLaneIssued !== true) throw held();
  assertSourceTerms(operation.terms, sourcePins);
  const handoff = lastEvent(history, 'payment_handoff'), issuance = lastEvent(history, 'protocol_native_wallet_guard_issued');
  const create = retainedCreate(operation);
  assertHandoff(operation, coords, handoff);
  if (!issuance || issuance.seq <= handoff.seq || issuance.data.createHash !== create.hash || issuance.data.createNonce !== create.nonce) throw unverified('guard issuance event');
  return { operation, create, snapshot: canonicalize({ operation, approval, coords, handoff, issuance }) };
}

/** Reads the proof again with `read()` and throws native_payment_lane_unverified, with any refusal as its cause, unless every row and event is unchanged since `before`. */
export function assertRetainedProofUnchanged(read, before) {
  let after;
  try { after = read(); } catch (cause) { throw unverified('changed while the wallet lane was read', { cause }); }
  if (after.snapshot !== before.snapshot) throw unverified('changed while the wallet lane was read');
}
