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

// Types only — the `DemosAdapter` *value* lives on the
// "@kynesyslabs/dacs/substrate" subpath so this top-level barrel stays free of
// an eager @kynesyslabs/demosdk load (its ESM packaging breaks plain-Node-ESM
// consumers of the pure/verify surface). createAgent lazy-loads it when needed.
export type {
  DemosAdapterConfig,
  SubstrateAdapter,
  AnchorRef,
  ProxyFetchRequest,
  ProxyFetchResult,
  ResolvedIdentity,
} from "./substrate/index.js";

// CLI helpers (pure/read-only by default). The executable entry is `dacs`.
export {
  formatDoctorText,
  redactRpcUrl,
  redactSecret,
  runDoctor,
  sanitizeText,
  type DoctorAdapter,
  type DoctorCheck,
  type DoctorMode,
  type DoctorOptions,
  type DoctorReport,
  type DoctorStatus,
} from "./cli/index.js";

// Identity (DACS-1): cross-context identity resolution + claim helpers. Pure —
// no substrate import — so verifiers can parse/inspect CCI records too.
export {
  parseCciRecord,
  parseClaimRef,
  cciClaimRefs,
  cciHasClaim,
  type CciRecord,
  type CciClaim,
  type CciClaimKind,
  type CciWeb2Claim,
  type CciWalletClaim,
  type ParsedClaimRef,
} from "./identity/index.js";

// Deterministic identityTier derivation (DACS-1 §6.3.2.1, IT-1..IT-3).
export {
  deriveIdentityTier,
  claimScheme,
  claimHasStructuralProof,
  TIER1_SCHEMES,
  type IdentityTier,
  type IdentityBundleLike,
  type BundleClaimLike,
  type BundleClaimVerifiedBy,
} from "./identity/tier.js";

// Negotiate (DACS-3): the sealed-envelope (sealed-bid) core — commitment/reveal
// crypto, deadline gating, and winner selection. Pure — no substrate import.
export {
  computeBidHash,
  generateSalt,
  saltHasEnoughEntropy,
  makeCommitment,
  verifyReveal,
  validateSealedParams,
  commitsInWindow,
  revealsInWindow,
  matchRevealsToCommits,
  parseRuleRef,
  verifyRuleRefContent,
  compareDecimal,
  selectSealedWinner,
  SEALED_BID_HASH_TAG,
  MIN_SALT_BYTES,
  MIN_COMMIT_LEAD_MS,
  MIN_REVEAL_WINDOW_SECONDS,
  type SealedBid,
  type AnchoredCommit,
  type AnchoredReveal,
  type SelectionRule,
  type SealedCommitment,
  type SealedEnvelopeParams,
  type SelectionOptions,
  type SelectionResult,
  type RuleRef,
  buildCommitMessage,
  buildRevealMessage,
  buildSealedAgreement,
  runSealedEnvelopeCore,
  type SealedChannelMessage,
  type SealedWinnerContext,
  type SealedAgreementContext,
  type SealedEnvelopeDeps,
  type SealedEnvelopeInput,
  type SealedEnvelopeResult,
} from "./negotiate/index.js";

// Public agent API (T4) — the headline surface a dApp dev uses.
export {
  createAgent,
  type Agent,
  type AgentConfig,
  type PublishResult,
  type BundleVerification,
  type SignatureCheck,
  verifyBundleCore,
  type VerifyBundleDeps,
  type SignatureVerdict,
  type RefCheck,
  type RefVerdict,
  verifySettlementEvidence,
  type EvidenceDecision,
  type EvidenceVerification,
  type EvidenceContext,
  type EvidenceAgreementContext,
  type EvidenceRailContext,
  type EvidenceDeps,
  computeReputation,
  deriveReputation,
  type ReputationDerivation,
  type ReputationMetrics,
  type ReputationWindow,
  type SessionOutcome,
  type DeriveReputationDeps,
  discoverListings,
  vetCore,
  type VetDeps,
  type VetRequest,
  type VetProxyResult,
  type Reputation,
  // Injectable buyer-session core (F1 #14): run the lifecycle against any
  // SubstrateAdapter (mock/simulation/non-Demos). NOTE: `sessionAnchorName` is
  // deliberately NOT exported — its current MVP address strings are not the
  // normative §6.3.x schemes (dacs2:composite:{jobId}:{evaluatedParty},
  // dacs4:payment:{jobId}:{railId}:{phaseIndex}, role-specific bundle addr), and
  // freezing them into the public API would mislead third-party verifiers.
  // It stays internal until canonical addressing lands (tracked with #5/#48).
  runSessionCore,
  type SessionDeps,
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
  createPayD402Rail,
  payD402Settle,
  payD402SettleCore,
  termsMatchD402,
  PAY_D402_AVAILABILITY,
  type PayD402Rail,
  type PayD402RailConfig,
  type PayD402SettleParams,
  type PayD402SettleCoreDeps,
  type D402ClientLike,
  type D402PaymentRequirement,
  type D402SettlementResult,
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
  type PriceTerm,
  type PricingSpec,
  type ClaimProofRef,
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
  isPricingSpec,
  isCompositeVerificationRecord,
  isAgreementDocument,
  isSettlementEvidence,
  isAttestationBundle,
} from "./artifacts/index.js";
