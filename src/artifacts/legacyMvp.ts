/**
 * Agreement shape from early SDK releases. The sealed-envelope commit checks in
 * `../negotiate/sealedEnvelope.ts` are typed on it. Agreements the SDK produces
 * are `AgreementDocument` or `PayeeBoundAgreementDocument` from `./types.ts`
 * (DACS-3 §8.5).
 */
import type { Delivery, Price } from "./types.js";

/** Pre-normative buyer-only agreement shape. */
export interface LegacyMvpAgreementDocument {
  jobId: string;
  pattern: string;
  buyer: string;
  seller: string;
  listingRef: string;
  price: Price;
  delivery: Delivery;
  expiresAt: string;
  signature?: unknown;
}
