import type { OpenedEnvelope, WireRequestPayload } from "../../src/wire/index.js";
import { DACS_SELLER_HTTP_PATHS as P } from "../../src/wire/routes.js";

/** The routes that start or commit a purchase: their retained record carries `allocated`. */
const STAGE_PATHS: readonly string[] = [P.proposals, P.commitments, P.commitmentSignature];

/** Host-owned Agreement context for transport fixtures; no captured message is changed. */
export function agreementFixture(opened: OpenedEnvelope<WireRequestPayload>) {
  const p = opened.payload;
  return [{ jobId: p.jobId, listingRef: p.listingPin,
    parties: [{ role: "buyer", primaryClaim: p.buyer }, { role: "seller", primaryClaim: p.seller }],
    terms: { deadline: opened.delegation?.payload.expiresAt ?? p.expiresAt } }];
}

/**
 * The job, Agreement hash and parties a transport fixture's host retained:
 * these fixtures sign their job's own Agreement. Mismatches are tested
 * separately (test/wire/launchReview.test.ts, the request/retained-* vectors).
 * The three routes that start or commit a purchase also carry the host's
 * `allocated` flag: false here, as these fixtures' sellers are ready.
 */
export function retainedFixture(opened: OpenedEnvelope<WireRequestPayload>) {
  const p = opened.payload;
  return { jobId: p.jobId, agreementHash: p.agreementHash, buyer: p.buyer, seller: p.seller, ...stageAllocation(p.path) };
}

/** The `allocated` member a retained record carries on the routes that start or commit a purchase (false: the seller is ready), and nothing elsewhere. */
export const stageAllocation = (path: string): { allocated?: false } => STAGE_PATHS.includes(path) ? { allocated: false } : {};
