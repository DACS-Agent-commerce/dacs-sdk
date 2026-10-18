import type { OpenedEnvelope, WireRequestPayload } from "../../src/wire/index.js";

/** Host-owned Agreement context for transport fixtures; no captured message is changed. */
export function agreementFixture(opened: OpenedEnvelope<WireRequestPayload>) {
  const p = opened.payload;
  return [{ jobId: p.jobId, listingRef: p.listingPin,
    parties: [{ role: "buyer", primaryClaim: p.buyer }, { role: "seller", primaryClaim: p.seller }],
    terms: { deadline: opened.delegation?.payload.expiresAt ?? p.expiresAt } }];
}
