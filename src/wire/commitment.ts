// The finalized commitment a payment or delivery request continues (new).
//
// A committed purchase continues after its seller drains or its Listing ends
// only on evidence the wire checks itself each time: the Agreement both
// parties signed (DACS-3 §8.6 CA-7), the job's finality commitment record for
// exactly that Agreement, signed by the TP-1 orchestrator (the seller, G3,
// CA-6), and its finalized SR-2 receipt, authenticated by the actor's own
// receipt reader. The commitment and Agreement are plain data: the result
// commitFixedPriceAgreement returned, the copy a seller sends its buyer, or one
// read again after a restart are checked the same way. Nothing marks a value
// as verified, so there is nothing to forge.
import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import { isAgreementDocument } from "../artifacts/validators.js";
import { contentHash } from "../canonical/hash.js";
import { isCanonicalJobId } from "../negotiate/jobId.js";
import { DACS_SELLER_HTTP_LIMITS } from "./routes.js";
import {
  cloneJson, deepFreeze, fail, hasKeys, isClaim, isHash, isListingPin, isRecord, isUint, ownedArtifact, sameCanonical, verifyEd25519, claimKey,
  type JsonRecord, type ListingPin,
} from "./validate.js";

/** CORE §B.7 `dacs-finality-commitment:v1:` (src/negotiate/commitment.ts FINALITY_COMMITMENT_SEPARATOR; test/wire/continuation.test.ts pins it). */
export const FINALITY_COMMITMENT_DOMAIN = "dacs-finality-commitment:v1:";

/** The anchored commitment a receipt reader authenticates (the gate's AnchoredFinalityCommitment). */
export interface WireAnchoredCommitment {
  readonly record: JsonRecord;
  readonly nativeAddress: string;
  readonly anchorTxRef: JsonRecord;
  readonly anchorReceipt: JsonRecord;
}

/**
 * Trusted integration, the SR-2 boundary (the gate's
 * FinalityCommitmentReader.verifyAnchorReceipt, answered synchronously):
 * authenticate the receipt's evidence and its transaction, writer and nonce
 * bindings against the chain, now. Return "valid", "invalid", "indeterminate"
 * or "error"; throw to keep a lookup's real cause. The wire performs no I/O
 * and calls it for every request it checks, so a cached answer is never
 * authoritative. Without one, a continuation is refused.
 */
export type CommitmentReceiptReader = (anchored: Readonly<WireAnchoredCommitment>) => unknown;

/** What a continuation is checked against; the request's own facts, when there is one. */
export interface CommitmentScope {
  seller: string;
  listingPin: ListingPin;
  now: number;
  /** The job, Agreement hash and buyer a request names; omitted, the record's own are taken and checked at signing. */
  request?: { jobId: string; agreementHash: string; buyer: string };
}

const ANCHORED = ["record", "nativeAddress", "anchorTxRef", "anchorReceipt"];
const RESULT = [...ANCHORED, "recordKind", "logicalAddress", "agreementHash", "committedAt", "resumed"];
const RECORD = ["finalityCommitmentVersion", "jobId", "agreementHash", "listingRef", "parties", "pattern", "createdAt", "signature"];
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

const invalid = (): never => fail("continuation_commitment_invalid", 500);
const agreementInvalid = (): never => fail("continuation_agreement_invalid", 500);

/**
 * CA-7: the Agreement the record commits is one both parties signed. It must
 * be an exact DACS-3 §8.5 AgreementDocument derived from fixed price (TP-1
 * commits no payee-bound or other Agreement type). Its recomputed content hash
 * must be the record's `agreementHash`, and its job and Listing pin the
 * record's. Its buyer and seller (by role) must be the record's parties, in
 * that order. Its two signatures, one by each party, must verify under
 * `dacs-agreement:v1:` against each party's own key.
 */
function assertCommittedAgreement(value: unknown, record: JsonRecord): void {
  const agreement = ownedArtifact(value, "continuation_agreement_invalid", 500) as JsonRecord;
  if (!isAgreementDocument(agreement) || agreement.derivedFromPattern !== "fixed-price") agreementInvalid();
  const hash = contentHash(agreement);
  if (hash !== record.agreementHash || agreement.jobId !== record.jobId || !sameCanonical(agreement.listingRef, record.listingRef)) agreementInvalid();
  const parties = agreement.parties as JsonRecord[];
  const claims = [parties.find((p) => p.role === "buyer")?.primaryClaim, parties.find((p) => p.role === "seller")?.primaryClaim];
  const recordParties = record.parties as unknown[];
  if (claims[0] !== recordParties[0] || claims[1] !== recordParties[1]) agreementInvalid();
  const signed = Buffer.from(`${ARTIFACT_SEPARATORS.AgreementDocument}${hash}`, "utf8");
  const signatures = agreement.signatures as JsonRecord[];
  for (const claim of claims as string[]) {
    const found = signatures.filter((s) => s.party === claim);
    if (found.length !== 1 || found[0]!.algorithm !== "ed25519") agreementInvalid();
    if (!verifyEd25519(signed, Buffer.from(found[0]!.value as string, "base64url"), claimKey(claim))) agreementInvalid();
  }
}

/**
 * The receipt time (`committedAt`, DACS-3 §8.6 CA-8) of the job's finalized
 * commitment, from the evidence itself. Accepted: exactly the anchored members,
 * or a finality result as commitFixedPriceAgreement returns it, whose stated
 * address, Agreement hash and time must equal what the evidence gives. A
 * legacy record, a pending or unestablished receipt, a record for another job,
 * Agreement, Listing or party pair, a signer other than the seller, or a
 * receipt time more than the tolerated clock skew ahead is refused
 * (`continuation_commitment_invalid`). `agreement` is the signed Agreement
 * the record commits (CA-7, assertCommittedAgreement): absent, malformed,
 * another Agreement, or a party signature that does not verify is
 * `continuation_agreement_invalid`. The reader runs last, on an owned
 * frozen copy: "invalid" is refused the same way; "indeterminate" or "error"
 * is `commitment_unverified` (503: never final); any other answer, a promise
 * included, is `commitment_reader_invalid`.
 */
export function commitmentReceiptTime(value: unknown, agreement: unknown, reader: unknown, scope: CommitmentScope): number {
  if (typeof reader !== "function") fail("commitment_reader_required", 500);
  const c = ownedArtifact(value, "continuation_commitment_invalid", 500) as JsonRecord;
  const stated = hasKeys(c, RESULT);
  if (!stated && !hasKeys(c, ANCHORED)) invalid();
  const record = c.record as JsonRecord;
  if (!hasKeys(record, RECORD) || record.finalityCommitmentVersion !== "1" || record.pattern !== "fixed-price" || !isUint(record.createdAt) ||
      !isCanonicalJobId(record.jobId) || !isHash(record.agreementHash) || !isListingPin(record.listingRef) ||
      !Array.isArray(record.parties) || record.parties.length !== 2 || !isClaim(record.parties[0])) invalid();
  const jobId = record.jobId as string;
  const want = scope.request ?? { jobId, agreementHash: record.agreementHash as string, buyer: (record.parties as string[])[0]! };
  if (jobId !== want.jobId || record.agreementHash !== want.agreementHash || !sameCanonical(record.listingRef, scope.listingPin) ||
      (record.parties as unknown[])[0] !== want.buyer || (record.parties as unknown[])[1] !== scope.seller) invalid();
  // TP-1's orchestrator is the seller (G3): only its key signs the job's commitment.
  const signature = record.signature as JsonRecord;
  if (!hasKeys(signature, ["algorithm", "signer", "value"]) || signature.algorithm !== "ed25519" || signature.signer !== scope.seller ||
      typeof signature.value !== "string" || !SIGNATURE.test(signature.value) ||
      Buffer.from(signature.value, "base64url").toString("base64url") !== signature.value) invalid();
  const signed = Buffer.from(`${FINALITY_COMMITMENT_DOMAIN}${contentHash(record)}`, "utf8");
  if (!verifyEd25519(signed, Buffer.from(signature.value as string, "base64url"), claimKey(scope.seller))) invalid();
  // CA-6 says who committed; CA-7 that both parties agreed to what was committed.
  assertCommittedAgreement(agreement, record);
  const receipt = c.anchorReceipt as JsonRecord;
  const blockRef = isRecord(receipt) ? receipt.blockRef : undefined;
  const logicalAddress = `dacs3:commit:${jobId}`;
  if (!isRecord(c.anchorTxRef) || typeof c.nativeAddress !== "string" || c.nativeAddress.length === 0 || !isRecord(receipt) ||
      receipt.state !== "finalized" || receipt.observationDisposition !== "established" || receipt.logicalAddress !== logicalAddress ||
      receipt.nativeAddress !== c.nativeAddress || receipt.contentHash !== contentHash(record) ||
      !isRecord(blockRef) || !isUint(blockRef.timestamp)) invalid();
  const committedAt = (blockRef as JsonRecord).timestamp as number;
  // A stated result is the gate's own: its derived members must be what the evidence gives. A party never supplies the time.
  if (stated && (c.recordKind !== "finality" || c.logicalAddress !== logicalAddress || c.agreementHash !== record.agreementHash ||
      c.committedAt !== committedAt || typeof c.resumed !== "boolean")) invalid();
  if (!isUint(scope.now) || committedAt > scope.now + DACS_SELLER_HTTP_LIMITS.maxClockSkewMs) invalid();
  const anchored = deepFreeze(cloneJson({ record, nativeAddress: c.nativeAddress, anchorTxRef: c.anchorTxRef, anchorReceipt: receipt })) as WireAnchoredCommitment;
  const verdict = (reader as CommitmentReceiptReader)(anchored);
  if (verdict === "valid") return committedAt;
  if (verdict === "invalid") invalid();
  if (verdict === "indeterminate" || verdict === "error") fail("commitment_unverified", 503);
  return fail("commitment_reader_invalid", 500);
}
