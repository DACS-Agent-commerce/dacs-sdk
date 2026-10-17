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
  htlcNeedsOperator as rootHtlcNeedsOperator,
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
  createInMemoryCrossChainHtlcStore,
  deriveHtlcPreimage,
  htlcNeedsOperator,
  type CrossChainHtlcAdapter,
  type CrossChainHtlcAuthority,
  type CrossChainHtlcProgress,
  type CrossChainHtlcStore,
  type HtlcDestinationClaimReplacementContext,
  type HtlcFailedObservation,
  type HtlcLockTerms,
  type HtlcObservedAction,
  type HtlcRefundLegState,
  type HtlcTxRef,
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
// Type fixture only: Circle's testnet USDC on Ethereum Sepolia, Base Sepolia
// and Polygon Amoy (https://developers.circle.com/stablecoins/usdc-contract-addresses,
// lowercased; matched that table on 2026-10-17). No verdict depends on them.
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
/**
 * A host pages an operator on every result the SDK's `htlcNeedsOperator`
 * accepts (the docs' host recovery checklist) and keeps advancing the session.
 */
function htlcPage(progress: CrossChainHtlcProgress): string | undefined {
  if (!htlcNeedsOperator(progress)) return undefined;
  switch (progress.status) {
    case "operator-alert":
      switch (progress.reason) {
        case "htlc-refund-absent":
          return `${progress.reason}: ${Object.entries(progress.refunds).join(" ")}`;
        // Past the source expiry; ST-8 is terminal once no claim can still land
        // and the source lock is authenticated unclaimed.
        case "htlc-source-claim-missed-after-reveal":
          return `${progress.reason}: source claim pending ${progress.sourceClaimPending}`;
        // The payee claimed outside the core: anchor `:resolved` on that claim.
        case "htlc-source-claimed-outside-core":
          return `${progress.reason}: ${progress.sourceClaimTxRef.claimTxHash}`;
        case "htlc-source-claim-replacement-limit-reached":
        case "htlc-destination-claim-failed-preimage-public":
        case "htlc-destination-claim-absent-preimage-broadcast":
          return progress.reason;
        // A host error found before anything is read: supply the original salt, keep it.
        case "htlc-salt-missing":
        case "htlc-salt-mismatch":
          return `${progress.reason}: keep the salt`;
        default: {
          const unhandled: never = progress;
          return unhandled;
        }
      }
    case "refund-stalled":
    case "waiting":
    case "indeterminate":
    case "failed":
    case "settle-asymmetric":
    case "refund-pending":
    case "refunded":
    case "settled":
      return progress.status;
    default: {
      const unhandled: never = progress;
      return unhandled;
    }
  }
}
const rootHtlcPage: typeof htlcNeedsOperator = rootHtlcNeedsOperator;
const htlcAbsentLeg: HtlcRefundLegState = "absent";
/** A claim's `absent` names the attempt it is about; one before any attempt names none. */
const htlcRevealRef: HtlcTxRef = {
  kind: "htlc-reveal",
  chainId: 80002,
  contractAddress: "0x0000000000000000000000000000000000000003",
  revealTxHash: `0x${"1".repeat(64)}`,
};
const htlcAbsentReveal: HtlcObservedAction = {
  state: "absent",
  txRef: htlcRevealRef,
  authenticationHash: "c".repeat(64),
};
const htlcNothingOnChain: HtlcObservedAction = { state: "absent", authenticationHash: "c".repeat(64) };
/** A replaced attempt's history records the `absent` with that attempt's reference. */
const htlcAbsentAttempt: HtlcFailedObservation = {
  state: "absent",
  txRef: htlcRevealRef,
  authenticationHash: "c".repeat(64),
};
/** Every refund reason, handled exhaustively. */
function htlcRefundReason(progress: CrossChainHtlcProgress): string | undefined {
  if (progress.status !== "refund-pending" && progress.status !== "refunded" &&
      progress.status !== "refund-stalled") {
    return undefined;
  }
  const reason = progress.reason;
  switch (reason) {
    case "destination-timeout":
    case "destination-lock-missing":
    case "destination-lock-unresolved":
    case "destination-lock-failed":
    case "destination-lock-window-closed":
    case "destination-expiry-margin-insufficient":
    case "destination-lock-expiry-invalid":
    case "source-lock-terms-missing":
    case "source-lock-terms-mismatch":
    case "destination-lock-terms-missing":
    case "destination-lock-terms-mismatch":
    case "destination-claim-unlanded":
      return reason;
    default: {
      const unhandled: never = reason;
      return unhandled;
    }
  }
}
/** The volatile store is a test double and must be acknowledged as one. */
function volatileHtlcStoreForTests(): CrossChainHtlcStore {
  // @ts-expect-error the in-memory store requires { acknowledgeVolatile: true }
  void (() => createInMemoryCrossChainHtlcStore());
  return createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
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
void htlcPage;
void rootHtlcPage;
void htlcAbsentLeg;
void htlcAbsentReveal;
void htlcNothingOnChain;
void htlcAbsentAttempt;
void htlcRefundReason;
void volatileHtlcStoreForTests;
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
