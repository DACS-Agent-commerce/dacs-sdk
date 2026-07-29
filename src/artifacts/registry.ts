import { type DomainSeparator } from "../crypto/signing.js";

import type { ArtifactKind } from "./types.js";

/**
 * Maps each spine artifact kind to the §7.7 domain separator its signature is
 * computed under. `satisfies` keeps every value inside the closed signature
 * registry — a typo or an unregistered separator fails to compile.
 */
export const ARTIFACT_SEPARATORS = {
  Listing: "dacs-listing:v1:",
  CompositeVerificationRecord: "dacs-composite:v1:",
  AgreementDocument: "dacs-agreement:v1:",
  SettlementEvidence: "dacs-evidence:v1:",
  AttestationBundle: "dacs-bundle:v1:",
  FaultAttestationBundle: "dacs-fault-bundle:v1:",
} as const satisfies Record<ArtifactKind, DomainSeparator>;

/** Domain separator for a bundle rating record (DACS-5 §10.6). */
export const RATING_SEPARATOR: DomainSeparator = "dacs-rating:v1:";

export function separatorFor(kind: ArtifactKind): DomainSeparator {
  return ARTIFACT_SEPARATORS[kind];
}
