// The finalized commitment a payment or delivery request continues (new).
//
// A committed purchase continues after its seller drains or its Listing ends
// only on evidence the wire checks itself each time: the Listing the purchase
// pins, the Agreement both parties signed (DACS-3 §8.6 CA-7), the job's
// finality commitment record for exactly that Agreement, signed by the TP-1
// orchestrator (the seller, G3, CA-6), and its finalized SR-2 receipt,
// authenticated by the actor's own receipt reader. Every Listing fact the
// continuation needs (its TP-1 phases and deliverable, validity window and
// deadline) is read from the Listing itself, never from a host's statement of
// it, and the Agreement's terms are checked against it by the SDK's own
// DACS-3 §8.5.2 verifier (validateFixedPriceAgreementBinding). The three are
// external DACS documents (CORE CF-5): each is given as its exact received
// bytes, admitted here, or as a value the wire's own admission returned
// (admitWireArtifact, or part of an admitted request or response body). The
// result commitFixedPriceAgreement returned, the copy a seller sends its
// buyer, or one read again after a restart are checked the same way, from
// bytes. Nothing marks a value as verified, so there is nothing to forge.
import { types } from "node:util";

import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import type { AgreementArtifact, Listing } from "../artifacts/types.js";
import { isPayeeBoundAgreementDocument, isChainTxRef, isListing, isReadableAnchorReceipt, isReadableFinalityCommitmentRecord } from "../artifacts/validators.js";
import { contentHash } from "../canonical/hash.js";
import { DacsError } from "../errors.js";
import { canonicalDemosAgentPublicKey } from "../identity/demos.js";
import { sameCanonicalClaimIdentity } from "../identity/claimReference.js";
import { validateFixedPriceAgreementBinding, type AnchoredFinalityCommitment } from "../negotiate/commitment.js";
import { isCanonicalJobId } from "../negotiate/jobId.js";
import { assertTp1Binding, type Tp1Binding } from "./profile.js";
import { DACS_SELLER_HTTP_LIMITS } from "./routes.js";
import {
  admitWireJson, cloneJson, deepFreeze, fail, hasKeys, isAdmittedValue, isClaim, isHash, isListingPin, isRecord, isUint, ownedArtifact, ownedBytes,
  sameCanonical, verifyEd25519, type JsonRecord, type ListingPin,
} from "./validate.js";

/** The most bytes one commitment or Agreement document may have (the response body bound). */
export const MAX_WIRE_ARTIFACT_BYTES = DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes;

/**
 * CF-5 admission of one external DACS document (a commitment, an Agreement)
 * from its exact received bytes: UTF-8, duplicate members, the number profile,
 * nesting depth, before CF-1 normalizes values during canonicalization. Returns it frozen
 * and recorded, so the continuation checks accept it as admitted. A refusal is
 * `wire_artifact_rejected` (500) with the admission's own code as its detail.
 */
export function admitWireArtifact(bytes: Uint8Array): unknown {
  const owned = ownedBytes(bytes, "wire_input_invalid", 500, { maxBytes: MAX_WIRE_ARTIFACT_BYTES, code: "wire_artifact_rejected", status: 500 });
  return admitWireJson(owned, MAX_WIRE_ARTIFACT_BYTES, "wire_artifact_rejected", 500);
}

/** The admitted value of a continuation input: exact bytes, admitted now, or a value the wire admitted. Anything else is refused as `code`. */
function admittedInput(value: unknown, code: string): unknown {
  if (types.isUint8Array(value)) {
    return admitWireJson(ownedBytes(value, code, 500, { maxBytes: MAX_WIRE_ARTIFACT_BYTES, code, status: 500 }), MAX_WIRE_ARTIFACT_BYTES, code, 500);
  }
  return isAdmittedValue(value) ? value : fail(code, 500, "ARTIFACT-NOT-ADMITTED");
}

/** DACS-3 §8.5.2 check 9: the only commit phase TP-1 continues, and the Agreement type it requires. */
export const TP1_COMMIT_PHASE = "commit-payee-bound-agreement";

/** CORE §B.7 `dacs-finality-commitment:v1:` (src/negotiate/commitment.ts FINALITY_COMMITMENT_SEPARATOR; test/wire/continuation.test.ts pins it). */
export const FINALITY_COMMITMENT_DOMAIN = "dacs-finality-commitment:v1:";

/** The anchored commitment a receipt reader authenticates (the gate's AnchoredFinalityCommitment). */
export type WireAnchoredCommitment = AnchoredFinalityCommitment;

/** The SDK Demos receipt substrate; its network is authenticated by the approved chain identity. */
export const TP1_RECEIPT_SUBSTRATE = "demos";

/**
 * Trusted integration, the SR-2 boundary (the gate's
 * FinalityCommitmentReader.verifyAnchorReceipt, synchronous or asynchronous):
 * authenticate the receipt's evidence and its transaction, writer and nonce
 * bindings against the supplied approved chain. `chainIdentity` must be an own
 * data property naming the reader's independently authenticated chain. Bound
 * every network reply and list and apply a deadline. Return "valid", "invalid", "indeterminate" or
 * "error"; throw to keep a lookup's real cause. The commitment checks do no
 * I/O of their own and call it for every request they check, so the answer
 * must come from evidence the host verified itself; a cached "valid" is
 * never authoritative. Without one, a continuation is refused.
 */
export interface CommitmentReceiptReader {
  readonly chainIdentity: string;
  (anchored: Readonly<WireAnchoredCommitment>, chain: Readonly<{ chainIdentity: string; substrate: typeof TP1_RECEIPT_SUBSTRATE }>): unknown;
}

/** The approved local binding and authenticated request facts every continuation requires. */
export interface CommitmentScope {
  seller: string;
  listingPin: ListingPin;
  now: number;
  binding: Tp1Binding;
  /** The job, Agreement hash and buyer from the authenticated request, never derived from the record. */
  request: { jobId: string; agreementHash: string; buyer: string };
}

const ANCHORED = ["record", "nativeAddress", "anchorTxRef", "anchorReceipt"];
const RESULT = [...ANCHORED, "recordKind", "logicalAddress", "agreementHash", "committedAt", "resumed"];
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
/** The Agreement discriminators other than the payee-bound one the commit phase selects (DACS-3 §8.5). */
const OTHER_DISCRIMINATORS = ["agreementVersion", "identityBoundAgreementVersion", "identityBoundPayeeAgreementVersion"];

const invalid = (): never => fail("continuation_commitment_invalid", 500);
const agreementInvalid = (): never => fail("continuation_agreement_invalid", 500);
const listingInvalid = (): never => fail("continuation_listing_invalid", 500);

/** The Listing facts a continuation is checked against (the SDK gate's AgreementBinding and Listing validity). */
interface CommittedListing {
  /** The admitted Listing itself, for the SDK's DACS-3 §8.5.2 verifier. */
  listing: Listing;
  notBefore: number;
  notAfter: number | undefined;
  /** `terms.deadlineSecAfterCommit`, in ms. */
  deadlineMs: number;
}

/** TP-1's only pay and delivery phases (FP-DEM; DACS-4 §9.5.9 and §9.6.1), and the DeliverableSpec kind its delivery requires. */
const TP1_PAY_PHASE = "pay-dem";
const TP1_DELIVERY_PHASE = "deliver-storage-program";
const TP1_DELIVERABLE_KIND = "storage-program";
const TP1_PHASE_SEQUENCE = ["negotiate-fixed-price", TP1_COMMIT_PHASE, TP1_PAY_PHASE, TP1_DELIVERY_PHASE];

/**
 * DACS-1 §6.3.4: a Listing verifier reconstructs `dacs-listing:v1:` followed
 * by the Listing's content hash and verifies `signature.value` against it
 * (DACS-3 §8.5.2: the complete signed Listing is validated before any
 * Agreement check). The content hash omits the signature, so the pin cannot
 * vouch for it. DACS-1 §6.3.4 permits any signer in seller.identity.claims.
 * Resolve the named Ed25519 claim and verify its own signature; presentedBy
 * identifies the seller, but does not restrict which of its claims signs.
 * The authenticated Listing/eligibility boundary supplies the seller bundle.
 * Refused as continuation_listing_invalid, detail LISTING-SIGNATURE.
 */
function assertListingSignature(listing: Listing): void {
  const signature = listing.signature as unknown as JsonRecord;
  const key = canonicalDemosAgentPublicKey(signature.signer);
  if (signature.algorithm !== "ed25519" || key === null ||
      !listing.seller.identity.claims.some((claim) => sameCanonicalClaimIdentity(claim.ref, signature.signer)) || typeof signature.value !== "string" || !SIGNATURE.test(signature.value) ||
      Buffer.from(signature.value, "base64url").toString("base64url") !== signature.value) fail("continuation_listing_invalid", 500, "LISTING-SIGNATURE");
  const signed = Buffer.from(`${ARTIFACT_SEPARATORS.Listing}${contentHash(listing as unknown as JsonRecord)}`, "utf8");
  if (!verifyEd25519(signed, Buffer.from(signature.value, "base64url"), Buffer.from(key).toString("hex"))) fail("continuation_listing_invalid", 500, "LISTING-SIGNATURE");
}

/**
 * The Listing the purchase pins (DACS-1 §6.3.4), from its own bytes: an exact
 * Listing whose recomputed content hash, id and version are `listingPin`, the
 * pin the request, the commitment record and the Agreement all name. The
 * content hash omits the Listing's signature, so its content is authenticated
 * by the Agreement both parties signed and the record the seller signed over
 * that hash, and its own signature is verified (assertListingSignature). Its
 * seller must be `seller`. Its pipeline must select one
 * fixed-price commitment, as the SDK gate's does: exactly one negotiate phase,
 * `negotiate-fixed-price`, directly followed by the only commit phase. That
 * phase selects the Agreement type before any signature is read (DACS-3
 * §8.5.2 check 9, CA-5, CA-7): TP-1 continues only `commit-payee-bound-agreement`
 * (`continuation_phase_unsupported` otherwise). Its other phases must be
 * TP-1's: exactly one pay phase, `pay-dem` (`continuation_phase_unsupported`,
 * detail `PAY-PHASE`), and exactly one delivery phase,
 * `deliver-storage-program` (detail `DELIVERY-PHASE`), in precisely that four-phase
 * order with no additional phases (detail `PIPELINE`). That delivery
 * validates a `storage-program` deliverable (DACS-4 §9.6.1 step 1), so the
 * Listing's DeliverableSpec must be one (`continuation_listing_invalid`,
 * detail `DELIVERABLE-KIND`); its pricing must be fixed, in DEM (detail
 * `TP1-PRICING`). It must carry a positive `deadlineSecAfterCommit` and not
 * be auto-accept, as the gate requires. Anything else is
 * `continuation_listing_invalid`.
 */
function committedListing(value: unknown, scope: CommitmentScope): CommittedListing {
  const listing = ownedArtifact(admittedInput(value, "continuation_listing_invalid"), "continuation_listing_invalid", 500) as JsonRecord;
  if (!isListing(listing) || !isListingPin(scope.listingPin)) return listingInvalid();
  const pin = scope.listingPin;
  if (listing.listingId !== pin.listingId || listing.listingVersion !== pin.version || contentHash(listing) !== pin.contentHash) listingInvalid();
  if (!sameCanonicalClaimIdentity(listing.seller.identity.presentedBy, scope.seller)) listingInvalid();
  assertListingSignature(listing);
  const kinds = listing.pipeline.map((phase) => phase.kind as string);
  const negotiate = kinds.flatMap((kind, i) => (kind.startsWith("negotiate-") ? [i] : []));
  const commits = kinds.flatMap((kind, i) => (kind.startsWith("commit-") ? [i] : []));
  if (negotiate.length !== 1 || kinds[negotiate[0]!] !== "negotiate-fixed-price" || commits.length !== 1 || commits[0] !== negotiate[0]! + 1 ||
      kinds[commits[0]!] !== TP1_COMMIT_PHASE) fail("continuation_phase_unsupported", 500);
  const pays = kinds.filter((kind) => kind.startsWith("pay-")), deliveries = kinds.filter((kind) => kind.startsWith("deliver-"));
  if (pays.length !== 1 || pays[0] !== TP1_PAY_PHASE) fail("continuation_phase_unsupported", 500, "PAY-PHASE");
  if (deliveries.length !== 1 || deliveries[0] !== TP1_DELIVERY_PHASE) fail("continuation_phase_unsupported", 500, "DELIVERY-PHASE");
  if (kinds.length !== TP1_PHASE_SEQUENCE.length || kinds.some((kind, i) => kind !== TP1_PHASE_SEQUENCE[i])) fail("continuation_phase_unsupported", 500, "PIPELINE");
  if (listing.offering.deliverable.kind !== TP1_DELIVERABLE_KIND) fail("continuation_listing_invalid", 500, "DELIVERABLE-KIND");
  if (listing.pricing.kind !== "fixed" || listing.pricing.price.currency !== "DEM") fail("continuation_listing_invalid", 500, "TP1-PRICING");
  const seconds = listing.terms.deadlineSecAfterCommit;
  if (!isUint(seconds) || seconds <= 0 || !Number.isSafeInteger(seconds * 1000) || listing.terms.acceptanceModel === "auto-accept") listingInvalid();
  const { notBefore, notAfter } = listing.validity;
  if (!isUint(notBefore) || (notAfter !== undefined && !isUint(notAfter))) listingInvalid();
  return { listing, notBefore, notAfter, deadlineMs: (seconds as number) * 1000 };
}

/**
 * DACS-3 §8.5.2 checks 1-9 for the committed Agreement against the pinned
 * Listing, at the receipt time: the SDK's own post-finality verifier
 * (validateFixedPriceAgreementBinding, the one seller payment intake runs).
 * It checks currency, the exact listed price, a recognized pricing kind, the
 * rail as a complete `acceptedRails` reference bound by the pay phase, the
 * deliverable's type, hash and schemaUrl, the pattern, the Agreement type
 * the commit phase selects, the parties against the Listing seller, and
 * checks 5 and 6. CA-7 already verified both signatures, so a mismatch
 * means the parties signed terms the Listing does not offer, and a
 * finalized record for them does not make them right. It is refused as
 * `continuation_agreement_invalid`, detail `LISTING-TERMS`, with the
 * verifier's own error as its cause.
 */
function assertListingTerms(agreement: JsonRecord, listing: Listing, committedAt: number): void {
  const pin = { listingId: listing.listingId, version: listing.listingVersion, contentHash: contentHash(listing as unknown as JsonRecord) };
  try {
    validateFixedPriceAgreementBinding({
      agreement: cloneJson(agreement) as unknown as AgreementArtifact, verifiedListing: { disposition: "verified", listing: cloneJson(listing), pin }, committedAt,
    });
  } catch (error) {
    if (error instanceof DacsError) fail("continuation_agreement_invalid", 500, "LISTING-TERMS", error);
    throw error;
  }
}

/**
 * CA-7: the Agreement the record commits is one both parties signed. The
 * Listing's `commit-payee-bound-agreement` phase (checked first) requires an exact DACS-3
 * §8.5 PayeeBoundAgreementDocument, here derived from fixed price, carrying
 * that one discriminator (detail `DISCRIMINATOR` for another beside it); a plain or
 * identity-bound document is the off-diagonal pairing and is refused. TP-1 has no
 * `pay-alternative` phase, so `terms.priorPaymentDispositionRef` is refused (detail
 * `PRIOR-DISPOSITION`, §8.5.2 check 10). Its
 * recomputed content hash must be the record's `agreementHash`, and its job
 * and Listing pin the record's. Its buyer and seller (by role) must be the
 * record's parties, in that order. Its two signatures, one by each party,
 * must verify under `dacs-payee-bound-agreement:v1:` against each party's own key.
 * Returns the Agreement, its `generatedAt` and `terms.deadline`; its terms are
 * checked against the Listing once the receipt time is known
 * (assertListingTerms).
 */
function assertCommittedAgreement(value: unknown, record: JsonRecord): { agreement: JsonRecord; generatedAt: unknown; deadline: unknown } {
  const agreement = ownedArtifact(admittedInput(value, "continuation_agreement_invalid"), "continuation_agreement_invalid", 500) as JsonRecord;
  if (!isPayeeBoundAgreementDocument(agreement) || agreement.derivedFromPattern !== "fixed-price") agreementInvalid();
  // DACS-3 §8.5: exactly one supported discriminator; the validator rules out only the plain one. §8.5.2 check 10:
  // no `priorPaymentDispositionRef` unless the Listing has a `pay-alternative` phase, and TP-1 has none.
  if (OTHER_DISCRIMINATORS.some((name) => name in agreement)) fail("continuation_agreement_invalid", 500, "DISCRIMINATOR");
  if ("priorPaymentDispositionRef" in (agreement.terms as JsonRecord)) fail("continuation_agreement_invalid", 500, "PRIOR-DISPOSITION");
  const hash = contentHash(agreement);
  if (hash !== record.agreementHash || agreement.jobId !== record.jobId || !sameCanonical(agreement.listingRef, record.listingRef)) agreementInvalid();
  const parties = agreement.parties as JsonRecord[];
  const claims = [parties.find((p) => p.role === "buyer")?.primaryClaim, parties.find((p) => p.role === "seller")?.primaryClaim];
  const recordParties = record.parties as unknown[];
  if (!sameCanonicalClaimIdentity(claims[0], recordParties[0]) || !sameCanonicalClaimIdentity(claims[1], recordParties[1])) agreementInvalid();
  const signed = Buffer.from(`${ARTIFACT_SEPARATORS.PayeeBoundAgreementDocument}${hash}`, "utf8");
  const signatures = agreement.signatures as JsonRecord[];
  for (const claim of claims as string[]) {
    const found = signatures.filter((s) => sameCanonicalClaimIdentity(s.party, claim));
    const key = canonicalDemosAgentPublicKey(claim);
    if (found.length !== 1 || found[0]!.algorithm !== "ed25519" || key === null) return agreementInvalid();
    if (!verifyEd25519(signed, Buffer.from(found[0]!.value as string, "base64url"), Buffer.from(key).toString("hex"))) agreementInvalid();
  }
  return { agreement, generatedAt: agreement.generatedAt, deadline: (agreement.terms as JsonRecord).deadline };
}

/**
 * The receipt time (`committedAt`, DACS-3 §8.6 CA-8) of the job's finalized
 * commitment, from the evidence itself. First, `listing` must be the Listing
 * the purchase pins, and its own commit phase `commit-payee-bound-agreement`
 * (committedListing: `continuation_listing_invalid`, or
 * `continuation_phase_unsupported`), before any signature is read. `value`,
 * `agreement` and `listing` are admitted (CF-5) before they are read: exact
 * bytes, or a value the wire admitted; anything else, or bytes admission
 * refuses, is the code below with the admission's detail.
 * Accepted: exactly the anchored members, or a finality result as
 * commitFixedPriceAgreement returns it, whose stated address, Agreement hash
 * and time must equal what the evidence gives. A legacy record, a receipt that
 * is not a CORE §5.1 AnchorReceipt or a transaction reference that is not a
 * ChainTxRef, a pending or unestablished receipt, a record for another job,
 * Agreement, Listing or party pair, a signer other than the seller, a receipt
 * time before the Agreement's `generatedAt` or more than the tolerated clock
 * skew ahead is refused (`continuation_commitment_invalid`). So is a
 * commitment the Standard's post-finality checks make invalid (DACS-3 §8.5.2,
 * checks 5 and 6 re-evaluated at `committedAt`, as the SDK gate does): a
 * receipt time before the Listing's `notBefore` or after its `notAfter`, or
 * an Agreement deadline past `committedAt + deadlineSecAfterCommit`. A
 * receipt time after the Agreement's own deadline is refused too.
 * `agreement` is the signed Agreement the record commits (CA-7,
 * assertCommittedAgreement): absent, malformed, another Agreement, or a party
 * signature that does not verify is `continuation_agreement_invalid`; so are
 * terms (price, currency, rail, deliverable) that are not the pinned
 * Listing's (DACS-3 §8.5.2 checks 1-4, assertListingTerms: detail
 * `LISTING-TERMS`). The reader runs last, on an owned frozen copy: "invalid" is refused the same
 * way; "indeterminate" or "error" is `commitment_unverified` (503: never
 * final); any other resolved answer is `commitment_reader_invalid`. Thrown or
 * rejected reader errors retain their original cause. Reader and receipt must
 * match the approved TP-1 chain; no request identity is inferred from evidence.
 */
export async function commitmentReceiptTime(value: unknown, agreement: unknown, listing: unknown, reader: unknown, scope: CommitmentScope): Promise<number> {
  if (typeof reader !== "function" || types.isProxy(reader)) fail("commitment_reader_required", 500);
  const binding = scope.binding;
  await assertTp1Binding(binding, binding?.local);
  const chainIdentity = binding.profile.chainIdentity;
  const readerChain = Object.getOwnPropertyDescriptor(reader, "chainIdentity");
  if (!readerChain || !("value" in readerChain) || readerChain.value !== chainIdentity) fail("commitment_reader_chain_mismatch", 500);
  // DACS-3 §8.5.2 check 9 and CA-5/CA-7: the pinned Listing's own phase selects the Agreement type before any
  // signature is read. TP-1 continues only `commit-payee-bound-agreement`; another phase, or none, is refused.
  const terms = committedListing(listing, scope);
  const c = ownedArtifact(admittedInput(value, "continuation_commitment_invalid"), "continuation_commitment_invalid", 500) as JsonRecord;
  const stated = hasKeys(c, RESULT);
  if (!stated && !hasKeys(c, ANCHORED)) invalid();
  const record = c.record as JsonRecord;
  if (!isReadableFinalityCommitmentRecord(record) || record.pattern !== "fixed-price" || !isUint(record.createdAt) ||
      !isCanonicalJobId(record.jobId) || !isHash(record.agreementHash) || !isListingPin(record.listingRef) ||
      !Array.isArray(record.parties) || record.parties.length !== 2) invalid();
  const jobId = record.jobId as string;
  const want = scope.request;
  if (!want || !isCanonicalJobId(want.jobId) || !isHash(want.agreementHash) || !isClaim(want.buyer) ||
      jobId !== want.jobId || record.agreementHash !== want.agreementHash || !sameCanonical(record.listingRef, scope.listingPin) ||
      !sameCanonicalClaimIdentity((record.parties as unknown[])[0], want.buyer) || !sameCanonicalClaimIdentity((record.parties as unknown[])[1], scope.seller)) invalid();
  // TP-1's orchestrator is the seller (G3): only its key signs the job's commitment.
  const signature = record.signature as JsonRecord;
  if (!hasKeys(signature, ["algorithm", "signer", "value"]) || signature.algorithm !== "ed25519" || !sameCanonicalClaimIdentity(signature.signer, scope.seller) ||
      typeof signature.value !== "string" || !SIGNATURE.test(signature.value) ||
      Buffer.from(signature.value, "base64url").toString("base64url") !== signature.value) invalid();
  const signed = Buffer.from(`${FINALITY_COMMITMENT_DOMAIN}${contentHash(record)}`, "utf8");
  const sellerKey = canonicalDemosAgentPublicKey(scope.seller);
  if (sellerKey === null || !verifyEd25519(signed, Buffer.from(signature.value as string, "base64url"), Buffer.from(sellerKey).toString("hex"))) invalid();
  // CA-6 says who committed; CA-7 that both parties agreed to what was committed.
  const { agreement: committed, generatedAt, deadline } = assertCommittedAgreement(agreement, record);
  const receipt = c.anchorReceipt as JsonRecord;
  const blockRef = isRecord(receipt) ? receipt.blockRef : undefined;
  const logicalAddress = `dacs3:commit:${jobId}`;
  // The commitment gate's own structural checks (CORE §5.1 receipt, DACS-4 §9.3 transaction reference) come first.
  if (!isReadableAnchorReceipt(receipt) || !isChainTxRef(c.anchorTxRef)) return invalid();
  if (!isRecord(c.anchorTxRef) || typeof c.nativeAddress !== "string" || c.nativeAddress.length === 0 || !isRecord(receipt) ||
      receipt.substrate !== TP1_RECEIPT_SUBSTRATE || receipt.state !== "finalized" || receipt.observationDisposition !== "established" || receipt.logicalAddress !== logicalAddress ||
      receipt.nativeAddress !== c.nativeAddress || receipt.contentHash !== contentHash(record) ||
      !isRecord(blockRef) || !isUint(blockRef.timestamp)) return invalid();
  const committedAt = (blockRef as JsonRecord).timestamp as number;
  // A stated result is the gate's own: its derived members must be what the evidence gives. A party never supplies the time.
  if (stated && (c.recordKind !== "finality" || c.logicalAddress !== logicalAddress || c.agreementHash !== record.agreementHash ||
      c.committedAt !== committedAt || typeof c.resumed !== "boolean")) invalid();
  // A purchase is committed after its Agreement exists (the gate's generatedAt <= committedAt).
  if (!isUint(generatedAt) || committedAt < generatedAt) invalid();
  if (!isUint(scope.now) || committedAt > scope.now + DACS_SELLER_HTTP_LIMITS.maxClockSkewMs) invalid();
  // DACS-3 §8.5.2 :659-661: checks 5 and 6 re-evaluated at the receipt time (the gate's validateAuthoritativeTime).
  // The deadline is the Agreement's settle-by time: one committed after it is refused, as seller payment intake refuses it.
  const limit = committedAt + terms.deadlineMs;
  if (committedAt < terms.notBefore || (terms.notAfter !== undefined && terms.notAfter < committedAt) ||
      !isUint(deadline) || !Number.isSafeInteger(limit) || deadline > limit || committedAt > deadline) invalid();
  // DACS-3 §8.5.2 checks 1-9: the terms both parties signed must be the pinned Listing's, by the SDK's own verifier.
  assertListingTerms(committed, terms.listing, committedAt);
  const anchored: WireAnchoredCommitment = deepFreeze(cloneJson({ record, nativeAddress: c.nativeAddress, anchorTxRef: c.anchorTxRef, anchorReceipt: receipt }));
  const verdict = await (reader as CommitmentReceiptReader)(anchored, Object.freeze({ chainIdentity, substrate: TP1_RECEIPT_SUBSTRATE }));
  if (verdict === "valid") return committedAt;
  if (verdict === "invalid") invalid();
  if (verdict === "indeterminate" || verdict === "error") fail("commitment_unverified", 503);
  return fail("commitment_reader_invalid", 500);
}
