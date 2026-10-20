// What the DACS-3 §8.6 commitment gate (commitment.ts) verified for each
// result it returned. This module imports nothing, so a consumer that takes a
// finalized commitment as authority (the wire's continuation of a committed
// purchase) reads it without loading the gate, its rails or its substrate.

/** What the commitment gate verified for one result it returned. */
export interface VerifiedAgreementCommitment {
  readonly jobId: string;
  readonly agreementHash: string;
  readonly listingRef: Readonly<{ listingId: string; version: number; contentHash: string }>;
  /** The authenticated roster's buyer and seller primary claims, by role. */
  readonly buyer: string;
  readonly seller: string;
  /** From the verified finalized receipt (CA-8), never a party's time. */
  readonly committedAt: number;
}

// Each result, with a frozen copy of what was verified for it. A copy of a
// result, or a value built to look like one, has no entry. Methods are taken
// at module load: a later patch of WeakMap.prototype does not change them.
const verified = new WeakMap<object, VerifiedAgreementCommitment>();
const call = Function.prototype.call;
const has = call.bind(WeakMap.prototype.has) as (map: typeof verified, key: object) => boolean;
const get = call.bind(WeakMap.prototype.get) as (map: typeof verified, key: object) => VerifiedAgreementCommitment | undefined;
const set = call.bind(WeakMap.prototype.set) as (map: typeof verified, key: object, value: VerifiedAgreementCommitment) => unknown;

/**
 * Called only by commitment.ts, for the exact result it is about to return;
 * no package entry point exports it. A result is recorded once.
 */
export function recordVerifiedAgreementCommitment(result: object, facts: VerifiedAgreementCommitment): void {
  if (has(verified, result)) throw new TypeError("commitment result already recorded");
  set(verified, result, Object.freeze({ ...facts, listingRef: Object.freeze({ ...facts.listingRef }) }));
}

/**
 * What `commitFixedPriceAgreement`, `commitRfqAgreement` or
 * `readLegacyFixedPriceAgreementCommitment` verified for the exact result it
 * returned (both Agreement signatures, the commitment record's binding and
 * signature, and the finalized receipt), or null for any other value.
 */
export function verifiedAgreementCommitment(value: unknown): VerifiedAgreementCommitment | null {
  return typeof value === "object" && value !== null ? get(verified, value) ?? null : null;
}
