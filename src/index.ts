/**
 * dacs-sdk — reusable runtime for building DACS (Demos Agent Commerce
 * Standards) agents across the Identify → Vet → Negotiate → Settle → Verify
 * lifecycle.
 *
 * T1 scaffold: this exports the substrate seam (SubstrateAdapter + DemosAdapter)
 * and package metadata. The agent-facing public API (`createAgent`,
 * `publishListing`, `discover`, `runSession`, `verifyBundle`, `getReputation`)
 * is designed in T4 — see IMPLEMENTATION.md.
 */

export { VERSION, DACS_SPEC_VERSION } from "./version.js";
export { DacsError, NotImplementedError } from "./errors.js";

// Foundation (T2): canonical form, decimals, content hashing, domain-separated signing.
export {
  canonicalize,
  canonicalizeDecimal,
  assertPositiveAmount,
  sha256Hex,
  stripSignature,
  canonicalSignedScope,
  contentHash,
} from "./canonical/index.js";
export {
  privateKeyFromSeed,
  publicKeyFromSeed,
  publicKeyFromRaw,
  rawPublicKey,
  ed25519Sign,
  ed25519Verify,
  SIGNATURE_DOMAIN_SEPARATORS,
  type DomainSeparator,
  isRegisteredSeparator,
  dacsXSeparator,
  signedBytes,
  signArtifact,
  verifyArtifact,
} from "./crypto/index.js";

export {
  DemosAdapter,
  type DemosAdapterConfig,
  type SubstrateAdapter,
  type AnchorRef,
  type ProxyFetchRequest,
  type ProxyFetchResult,
  type ResolvedIdentity,
} from "./substrate/index.js";

// Public agent API (T4) — the headline surface a dApp dev uses.
export {
  createAgent,
  type Agent,
  type AgentConfig,
  type PublishResult,
  type BundleVerification,
  type Reputation,
  type RunSessionOptions,
  type SessionResult,
  type SessionTerms,
  type SettleRequest,
  type SettleResult,
  buildSignedArtifact,
  verifySignedArtifact,
  type SignedArtifact,
  type Signer,
  type Verifier,
} from "./agent/index.js";

// Artifact model (T3): spine artifact types, kind→separator registry, validators.
export {
  type ArtifactKind,
  type ClaimRef,
  type ClaimRequirement,
  type Price,
  type Delivery,
  type Listing,
  type VerifyResultEntry,
  type CompositeVerificationRecord,
  type AgreementDocument,
  type SettlementEvidence,
  type Rating,
  type AttestationBundle,
  ARTIFACT_SEPARATORS,
  RATING_SEPARATOR,
  separatorFor,
  isListing,
  isCompositeVerificationRecord,
  isAgreementDocument,
  isSettlementEvidence,
  isAttestationBundle,
} from "./artifacts/index.js";
