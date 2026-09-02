export {
  parseCciRecord,
  parseClaimRef,
  cciClaimRefs,
  cciHasClaim,
  cciClaimProof,
  cciClaimHasProof,
  type CciRecord,
  type CciClaim,
  type CciClaimKind,
  type CciWeb2Claim,
  type CciWalletClaim,
  type CciUdClaim,
  type CciPqcClaim,
  type ParsedClaimRef,
} from "./cci.js";

export {
  isCanonicalClaimReference,
  parseCanonicalClaimReference,
  requireCanonicalClaimReference,
  sameCanonicalClaimIdentity,
  type CanonicalClaimIdentity,
  type CanonicalClaimReferenceParts,
  type ClaimReferenceSchemeStatus,
} from "./claimReference.js";
export {
  canonicalizeNativeDomainHostname,
  domainClaimReferenceFromNativeHostname,
  isCanonicalDomainHostname,
} from "./domainHost.js";
export {
  readAuthenticatedDomainClaims,
  verifyDemosGcrDomainClaims,
  type AuthenticatedDomainArtifactDeps,
  type AuthenticatedDomainClaimRead,
  type DemosGcrDomainMetadata,
  type DemosGcrDomainVerification,
  type DemosGcrResolution,
  type DomainArtifactAuthentication,
  type DomainArtifactProfile,
  type DomainClaimArtifactLike,
  type DomainClaimDiagnostic,
  type ReportedDemosGcrResultTimes,
  type VerifyDemosGcrDomainDeps,
} from "./domainClaimVerification.js";
export { identityBundleHash } from "./bundle.js";
export {
  canonicalDemosAgentPublicKey,
  demosAgentClaimRef,
  demosAgentPublicKey,
  isDemosAgentClaimRef,
  parseDemosAgentClaimReference,
  type ParsedDemosAgentClaimReference,
} from "./demos.js";
