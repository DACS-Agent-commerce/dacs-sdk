import {
  type BundleVerification,
  type DemosAdapterConfig,
  type DemosWriteJournal,
  evaluateClaimRequirementQualification,
  evaluateRailAvailabilitySelection,
  verifyEvidenceBoundFaultBundle,
  evaluateEvidenceBoundSettlementSet,
  verifyFaultBundleExtendedPointer,
  buildEvidenceBoundTwoSidedBundle,
  deriveSettlementVerifiedReputation,
  deriveReplayableSettlementVerifiedReputation,
  replaySettlementVerifiedReputation,
  type EvidenceBoundBundleAuthority,
  type EvidenceBoundBundleVerifierDeps,
  type ClaimQualificationDeps,
  type ClaimQualificationRequirement,
  type ClaimQualificationBundleRequirement,
  type ClaimQualificationInput,
  type RailAvailabilityAuthority,
  type DeriveReputationDeps,
  type DeriveReputationValidationDeps,
  type AuthenticatedRatingResolution,
  type RatingRecord,
  type RatingPublicationEffectStore,
  type RatingPhasePlan,
  type RatingPhaseReadyHandoff,
  type FencedSessionStoreV2,
  type HtlcRefundLegState as RootHtlcRefundLegState,
  type SubstrateAdapter,
  createBuyerRatingRecord,
  createSellerRatingRecord,
  isRatingRecord,
  publishRatingRecordDurably,
  createRatingPhasePlan,
  completeRatingPhase,
  captureRatingPhaseReadyHandoff,
  persistRatingPhaseHandoffDurably,
  recoverRatingPhaseHandoff,
  deriveReputationWithValidation,
  lookupBundleCopies,
  negotiablePriceBand,
  isNegotiablePriceWithinBand,
  verifyBundleCore,
} from "@kynesyslabs/dacs";
import { canonicalize } from "@kynesyslabs/dacs/canonical";
import { runFulfilmentCore } from "@kynesyslabs/dacs/seller";
import {
  advanceCrossChainHtlc,
  deriveHtlcPreimage,
  type CrossChainHtlcAdapter,
  type CrossChainHtlcAuthority,
  type CrossChainHtlcProgress,
  type CrossChainHtlcStore,
  type HtlcDestinationClaimReplacementContext,
  type HtlcLockTerms,
  type HtlcRefundLegState,
  advanceSolanaSplSettlement,
  createSolanaSplSettlementIntent,
  type SolanaSplAdapter,
  type SolanaSplSettlementStore,
  advanceAp2Settlement,
  deriveAp2IdempotencyKey,
  type Ap2BindingStore,
  type Ap2MandateVerifier,
  type Ap2ProviderAdapter,
} from "@kynesyslabs/dacs/rails";

const config: DemosAdapterConfig = { rpc: "https://example.invalid" };
const verifier: typeof verifyBundleCore = verifyBundleCore;
const bundleLookup: typeof lookupBundleCopies = lookupBundleCopies;
const reputationDeps: DeriveReputationDeps = {
  trustBundles: true,
  resolvePartyRole: ({ jobId, partyPrimaryClaim }) =>
    jobId.length > 0 && partyPrimaryClaim.length > 0 ? "buyer" : undefined,
};
const priceBand = negotiablePriceBand({
  kind: "negotiable",
  bandCenter: { amount: "100", currency: "USDC" },
  minPct: 10,
  maxPct: 10,
});
const priceAccepted: boolean = isNegotiablePriceWithinBand("95", {
  kind: "negotiable",
  bandCenter: { amount: "100", currency: "USDC" },
  minPct: 10,
  maxPct: 10,
});
const canonical: string = canonicalize({ b: 2, a: 1 });
const fulfilment: typeof runFulfilmentCore = runFulfilmentCore;
const htlcAdvance: typeof advanceCrossChainHtlc = advanceCrossChainHtlc;
const htlcPreimage: typeof deriveHtlcPreimage = deriveHtlcPreimage;
const htlcLegState: HtlcRefundLegState = "failed";
const rootHtlcLegState: RootHtlcRefundLegState = htlcLegState;
const htlcLockTerms: HtlcLockTerms = {
  token: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
  amountBaseUnits: "1250000",
  hashlock: `0x${"0".repeat(64)}`,
  sender: "0x0000000000000000000000000000000000000001",
  recipient: "0x0000000000000000000000000000000000000002",
};
const htlcTokenIds: Pick<CrossChainHtlcAuthority, "sourceTokenId" | "destinationTokenId"> = {
  sourceTokenId: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
  destinationTokenId: "0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582",
};
declare const htlcRevealReplacement: HtlcDestinationClaimReplacementContext;
/** A host pages an operator on these statuses and keeps advancing the session. */
function htlcNeedsOperator(progress: CrossChainHtlcProgress): boolean {
  switch (progress.status) {
    case "refund-stalled":
      return Object.values(progress.refunds).includes("failed");
    case "operator-alert":
      return progress.reason === "htlc-source-claim-missed-after-reveal" ||
        progress.reason === "htlc-destination-claim-failed-preimage-public";
    case "waiting":
    case "indeterminate":
    case "failed":
    case "settle-asymmetric":
    case "refund-pending":
    case "refunded":
    case "settled":
      return false;
    default: {
      const unhandled: never = progress;
      return unhandled;
    }
  }
}
const qualify: typeof evaluateClaimRequirementQualification =
  evaluateClaimRequirementQualification;
const selectRail: typeof evaluateRailAvailabilitySelection =
  evaluateRailAvailabilitySelection;
const verifyEvidenceBound: typeof verifyEvidenceBoundFaultBundle =
  verifyEvidenceBoundFaultBundle;
const evaluateExactSet: typeof evaluateEvidenceBoundSettlementSet =
  evaluateEvidenceBoundSettlementSet;
const verifyBundlePointer: typeof verifyFaultBundleExtendedPointer =
  verifyFaultBundleExtendedPointer;
const buildEvidenceBound: typeof buildEvidenceBoundTwoSidedBundle =
  buildEvidenceBoundTwoSidedBundle;
const deriveSettlementVerified: typeof deriveSettlementVerifiedReputation =
  deriveSettlementVerifiedReputation;
const deriveReplayableSettlementVerified:
  typeof deriveReplayableSettlementVerifiedReputation =
    deriveReplayableSettlementVerifiedReputation;
const replaySettlementVerified: typeof replaySettlementVerifiedReputation =
  replaySettlementVerifiedReputation;
const ratingValidator: (value: unknown) => value is RatingRecord = isRatingRecord;
const buyerRatingProducer: typeof createBuyerRatingRecord = createBuyerRatingRecord;
const sellerRatingProducer: typeof createSellerRatingRecord = createSellerRatingRecord;
const durableRatingPublisher: typeof publishRatingRecordDurably =
  publishRatingRecordDurably;
const ratingPhasePlanner: typeof createRatingPhasePlan = createRatingPhasePlan;
const ratingPhaseCompleter: typeof completeRatingPhase = completeRatingPhase;
const ratingHandoffCapturer: typeof captureRatingPhaseReadyHandoff =
  captureRatingPhaseReadyHandoff;
const durableRatingHandoffWriter: typeof persistRatingPhaseHandoffDurably =
  persistRatingPhaseHandoffDurably;
const durableRatingHandoffReader: typeof recoverRatingPhaseHandoff =
  recoverRatingPhaseHandoff;
declare const ratingPhasePlan: RatingPhasePlan;
declare const ratingPhaseHandoff: RatingPhaseReadyHandoff;
declare const fencedSessionStore: FencedSessionStoreV2;
const validatedReputationDeriver: typeof deriveReputationWithValidation =
  deriveReputationWithValidation;
declare const authenticatedRatingResolution: AuthenticatedRatingResolution;
const validatedReputationDeps: DeriveReputationValidationDeps = {
  validate: async () => true,
  trustBundlePartyRoles: true,
  resolveAndAuthenticateRating: async () => authenticatedRatingResolution,
};
declare const ratingEffectStore: RatingPublicationEffectStore;
const solanaAdvance: typeof advanceSolanaSplSettlement = advanceSolanaSplSettlement;
const solanaIntent: typeof createSolanaSplSettlementIntent = createSolanaSplSettlementIntent;
const ap2Advance: typeof advanceAp2Settlement = advanceAp2Settlement;
const ap2IdempotencyKey: string = deriveAp2IdempotencyKey("consumer-job", 0);

declare const adapter: SubstrateAdapter;
declare const journal: DemosWriteJournal;
declare const result: BundleVerification;
declare const htlcAdapter: CrossChainHtlcAdapter;
declare const htlcStore: CrossChainHtlcStore;
declare const qualificationInput: ClaimQualificationInput;
declare const qualificationDeps: ClaimQualificationDeps;
declare const qualificationMember: ClaimQualificationRequirement;
declare const qualificationRequirement: ClaimQualificationBundleRequirement;
declare const railAuthority: RailAvailabilityAuthority;
declare const ebfabAuthority: EvidenceBoundBundleAuthority;
declare const ebfabDeps: EvidenceBoundBundleVerifierDeps;
declare const solanaAdapter: SolanaSplAdapter;
declare const solanaStore: SolanaSplSettlementStore;
declare const ap2Store: Ap2BindingStore;
declare const ap2Verifier: Ap2MandateVerifier;
declare const ap2Provider: Ap2ProviderAdapter;

void config;
void verifier;
void bundleLookup;
void reputationDeps;
void priceBand;
void priceAccepted;
void canonical;
void fulfilment;
void ratingValidator;
void buyerRatingProducer;
void sellerRatingProducer;
void durableRatingPublisher;
void ratingPhasePlanner;
void ratingPhaseCompleter;
void ratingHandoffCapturer;
void durableRatingHandoffWriter;
void durableRatingHandoffReader;
void ratingPhasePlan;
void ratingPhaseHandoff;
void fencedSessionStore;
void validatedReputationDeriver;
void validatedReputationDeps;
void ratingEffectStore;
void qualify(qualificationInput, qualificationDeps);
void qualificationMember;
void qualificationRequirement;
void selectRail({}, railAuthority);
void verifyEvidenceBound(ebfabAuthority, ebfabDeps);
void evaluateExactSet;
void verifyBundlePointer;
void buildEvidenceBound;
void deriveSettlementVerified;
void deriveReplayableSettlementVerified;
void replaySettlementVerified;
void adapter;
void journal;
void result;
void htlcAdvance;
void htlcPreimage;
void rootHtlcLegState;
void htlcLockTerms;
void htlcTokenIds;
void htlcRevealReplacement;
void htlcNeedsOperator;
void htlcAdapter;
void htlcStore;
void solanaAdvance;
void solanaIntent;
void solanaAdapter;
void solanaStore;
void ap2Advance;
void ap2IdempotencyKey;
void ap2Store;
void ap2Verifier;
void ap2Provider;
