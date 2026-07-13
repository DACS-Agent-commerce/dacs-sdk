export {
  createAgent,
  type Agent,
  type AgentConfig,
  type PublishResult,
  type BundleVerification,
  type SignatureCheck,
  type Reputation,
  type RunSessionOptions,
} from "./Agent.js";
export {
  verifyBundleCore,
  type VerifyBundleDeps,
  type SignatureVerdict,
  type RefCheck,
  type RefVerdict,
} from "./verifyBundleCore.js";
export { computeReputation } from "./reputation.js";
export {
  deriveReputation,
  type ReputationDerivation,
  type ReputationMetrics,
  type ReputationWindow,
  type SessionOutcome,
  type DeriveReputationDeps,
} from "./reputationDerivation.js";
export { discoverListings } from "./discover.js";
export {
  vetCore,
  type VetDeps,
  type VetRequest,
  type VetProxyResult,
} from "./vetCore.js";
export {
  runSessionCore,
  // sessionAnchorName intentionally NOT re-exported — MVP address strings are
  // non-normative (see the note in the top-level barrel / #48). Kept internal to
  // runSessionCore until canonical §6.3.x addressing lands.
  type SessionDeps,
  type SessionResult,
  type SessionTerms,
  type SettleRequest,
  type SettleResult,
} from "./runSessionCore.js";
export {
  buildSignedArtifact,
  verifySignedArtifact,
  type SignedArtifact,
  type Signer,
  type Verifier,
} from "./signedArtifact.js";
