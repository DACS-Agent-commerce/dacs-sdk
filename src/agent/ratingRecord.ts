import type {
  ComponentSignatureAlgorithm,
  RatingRecord,
} from "../artifacts/types.js";
import {
  isRatingRecord,
  RATING_SEPARATOR,
  signComponentArtifact,
  type ComponentSigner,
} from "../artifacts/index.js";
import { snapshotCanonicalJson } from "../canonical/snapshot.js";
import { DacsError } from "../errors.js";
import { isCanonicalClaimReference } from "../identity/claimReference.js";
import { requireCanonicalJobId } from "../negotiate/jobId.js";

const INPUT_KEYS = Object.freeze([
  "jobId",
  "buyer",
  "seller",
  "value",
  "freeText",
  "dimensions",
  "ratedAt",
] as const);

export interface CreateRatingRecordInput {
  jobId: string;
  /** Exact buyer primary ClaimReference retained by authenticated session state. */
  buyer: string;
  /** Exact seller primary ClaimReference retained by authenticated session state. */
  seller: string;
  /** RT-1 integer score in the inclusive range 1..5. */
  value: number;
  /** Optional free text, limited to 1,000 JavaScript string code units. */
  freeText?: string;
  /** Opaque, finite-number per-dimension metadata. */
  dimensions?: Record<string, number>;
  ratedAt: number;
}

/**
 * Locally controlled signing capability. The producer supplies the signer
 * ClaimReference from its authenticated role rather than accepting one from
 * this object, so a wallet adapter cannot relabel the rater.
 */
export interface RatingRecordSigner {
  algorithm: ComponentSignatureAlgorithm;
  sign: ComponentSigner;
}

function exactInputKeys(input: Record<string, unknown>): boolean {
  const keys = Object.keys(input);
  const allowed = INPUT_KEYS as readonly string[];
  return keys.every((key) => allowed.includes(key)) &&
    ["jobId", "buyer", "seller", "value", "ratedAt"].every((key) =>
      keys.includes(key)
    );
}

function validateInput(input: CreateRatingRecordInput): void {
  const record = input as unknown as Record<string, unknown>;
  if (!exactInputKeys(record)) {
    throw new DacsError("RatingRecord input contains missing or unexpected fields");
  }
  requireCanonicalJobId(input.jobId, "RatingRecord jobId");
  if (!isCanonicalClaimReference(input.buyer)) {
    throw new DacsError("RatingRecord buyer must be a canonical ClaimReference");
  }
  if (!isCanonicalClaimReference(input.seller)) {
    throw new DacsError("RatingRecord seller must be a canonical ClaimReference");
  }
  if (input.buyer === input.seller) {
    throw new DacsError("RatingRecord cannot rate the same session party");
  }
  if (!Number.isInteger(input.value) || input.value < 1 || input.value > 5) {
    throw new DacsError("RatingRecord value must be an integer from 1 through 5");
  }
  if (
    input.freeText !== undefined &&
    (typeof input.freeText !== "string" || input.freeText.length > 1_000)
  ) {
    throw new DacsError("RatingRecord freeText must not exceed 1000 characters");
  }
  if (!Number.isSafeInteger(input.ratedAt) || input.ratedAt < 0) {
    throw new DacsError("RatingRecord ratedAt must be a non-negative safe integer");
  }
  if (
    input.dimensions !== undefined &&
    (input.dimensions === null ||
      typeof input.dimensions !== "object" ||
      Array.isArray(input.dimensions) ||
      Object.values(input.dimensions).some(
        (value) => typeof value !== "number" || !Number.isFinite(value),
      ))
  ) {
    throw new DacsError("RatingRecord dimensions must contain finite numbers");
  }
}

async function createRoleRatingRecord(
  input: CreateRatingRecordInput,
  role: "buyer" | "seller",
  signer: RatingRecordSigner,
): Promise<RatingRecord> {
  const captured = snapshotCanonicalJson(input, "RatingRecord input");
  if (
    input.jobId !== captured.jobId ||
    input.buyer !== captured.buyer ||
    input.seller !== captured.seller
  ) {
    throw new DacsError(
      "RatingRecord identifiers must already use their exact canonical bytes",
    );
  }
  validateInput(captured);
  const rater = role === "buyer" ? captured.buyer : captured.seller;
  const target = role === "buyer" ? captured.seller : captured.buyer;
  const targetRole = role === "buyer" ? "seller" as const : "buyer" as const;
  const unsigned = {
    ratingVersion: "1" as const,
    jobId: captured.jobId,
    rater,
    target,
    targetRole,
    value: captured.value,
    ...(captured.freeText !== undefined ? { freeText: captured.freeText } : {}),
    ...(captured.dimensions !== undefined
      ? { dimensions: captured.dimensions }
      : {}),
    ratedAt: captured.ratedAt,
  };
  const signed = await signComponentArtifact(unsigned, RATING_SEPARATOR, {
    algorithm: signer.algorithm,
    signer: rater,
    sign: signer.sign,
  });
  if (!isRatingRecord(signed)) {
    throw new DacsError("signed RatingRecord failed its strict wire validator");
  }
  return signed;
}

/** Produce the only buyer-authorised direction: buyer rates seller. */
export function createBuyerRatingRecord(
  input: CreateRatingRecordInput,
  signer: RatingRecordSigner,
): Promise<RatingRecord> {
  return createRoleRatingRecord(input, "buyer", signer);
}

/** Produce the only seller-authorised direction: seller rates buyer. */
export function createSellerRatingRecord(
  input: CreateRatingRecordInput,
  signer: RatingRecordSigner,
): Promise<RatingRecord> {
  return createRoleRatingRecord(input, "seller", signer);
}
