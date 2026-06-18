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
export {
  DacsError,
  NotImplementedError,
  TransientError,
  CounterpartyError,
  SubstrateError,
  faultCategory,
  type FaultCategory,
} from "./errors.js";

// Foundation (T2): canonical form, decimals, content hashing, domain-separated signing.
export {
  canonicalize,
  canonicalizeDecimal,
  assertPositiveAmount,
  baseUnits,
  encodeAddressSegment,
  decodeAddressSegment,
  listingAddress,
  storAddress,
  bundleAddress,
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
  type ArtifactVerification,
  verifyBundleCore,
  type VerifyBundleDeps,
  type SignatureVerdict,
  computeReputation,
  discoverListings,
  vetCore,
  type VetDeps,
  type VetRequest,
  type VetProxyResult,
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

// Settlement rails (SR-4): x402 reference rail + the runSession `settle` bridge.
export {
  createX402Rail,
  x402Settle,
  x402SettleCore,
  termsMatch,
  type X402Rail,
  type X402RailConfig,
  type X402SettleParams,
  type X402SettleCoreDeps,
  type X402ClientLike,
  type X402PaymentRequired,
  type X402PaymentRequirement,
  createEvmErc20Rail,
  evmErc20Settle,
  evmErc20SettleCore,
  type EvmErc20Rail,
  type EvmErc20RailConfig,
  type EvmErc20SettleParams,
  type EvmTransferClient,
} from "./rails/index.js";

// Steward registries (T12/T13): resolve + pin steward-signed rails/recipes,
// dispatch the money path by rail kind.
export {
  resolveRail,
  resolveRecipe,
  type RegistryResolveDeps,
  settleFromRail,
  type RailDispatchOptions,
  type Availability,
  type RailDescriptor,
  type RecipeDescriptor,
  type Registry,
} from "./registry/index.js";

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
  type AttestationRef,
  type ListingRef,
  type TxRef,
  type PaymentAmount,
  type SettlementFinality,
  type ArtifactSignature,
  type SettlementEvidence,
  type Rating,
  type BundleParty,
  type PhaseSummaryEntry,
  type BundleSignature,
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
