import type { OpenedEnvelope, WireRequestPayload } from "../../src/wire/index.js";

/** Host-owned Agreement context for transport fixtures; no captured message is changed. */
export function agreementFixture(opened: OpenedEnvelope<WireRequestPayload>) {
  const p = opened.payload;
  return [{ jobId: p.jobId, listingRef: p.listingPin,
    parties: [{ role: "buyer", primaryClaim: p.buyer }, { role: "seller", primaryClaim: p.seller }],
    terms: { deadline: opened.delegation?.payload.expiresAt ?? p.expiresAt } }];
}

/**
 * The job and Agreement hash a transport fixture's host retained: these
 * fixtures sign their job's own Agreement. Mismatches are tested separately
 * (test/wire/launchReview.test.ts, the request/retained-* vectors).
 */
export function retainedFixture(opened: OpenedEnvelope<WireRequestPayload>) {
  return { jobId: opened.payload.jobId, agreementHash: opened.payload.agreementHash };
}
