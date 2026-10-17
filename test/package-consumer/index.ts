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
  artifactBindingHashOf,
  createScanningArtifactRepository,
  UnsupportedArtifactKindError,
  AnchorHistoryRestartRequiredError,
  type ScanningArtifactRepositoryDeps,
  type ArtifactScanState,
  type ArtifactScanPage,
  type ArtifactScanDeferredRow,
  type ArtifactRowIndeterminateCode,
  type ArtifactScanIndeterminateCode,
  type ArtifactScanRestartCode,
  type ScannedArtifactOutcome,
  type ScanPageCode,
} from "@kynesyslabs/dacs";
import { canonicalize } from "@kynesyslabs/dacs/canonical";
import {
  AnchorHistoryRestartRequiredError as DiscoveryRestartRequiredError,
  artifactBindingHashOf as discoveryBindingHashOf,
  createScanningArtifactRepository as createScanningFromDiscovery,
  scanAnchorPage,
  UnsupportedArtifactKindError as DiscoveryUnsupportedKindError,
  type AnchorHistoryPageFetcher,
  type ArtifactRowIndeterminateCode as DiscoveryRowIndeterminateCode,
  type ArtifactScanPage as DiscoveryArtifactScanPage,
  type ScanPageCode as DiscoveryScanPageCode,
} from "@kynesyslabs/dacs/discovery";
import { runFulfilmentCore } from "@kynesyslabs/dacs/seller";
import {
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

declare const scanningDeps: ScanningArtifactRepositoryDeps;
const scanningRepository = createScanningArtifactRepository({ ...scanningDeps, maxRowAttempts: 5 });
async function nextScanState(state?: ArtifactScanState): Promise<ArtifactScanState> {
  const page: ArtifactScanPage = await scanningRepository.scanPage(state, { limit: 100 });
  const deferredRows: readonly ArtifactScanDeferredRow[] = [...page.deferred, ...page.state.deferred];
  void deferredRows;
  switch (page.status) {
    case "page":
    case "conflict":
      return page.state;
    case "indeterminate": {
      const code: ArtifactScanIndeterminateCode = page.code;
      void code;
      return page.state;
    }
    case "restart-required": {
      const code: ArtifactScanRestartCode = page.code;
      void code;
      return page.state;
    }
  }
}
const scanOutcomeCode = (outcome: ScannedArtifactOutcome): string => {
  if (outcome.status === "indeterminate") {
    const code: ArtifactRowIndeterminateCode = outcome.code;
    return code;
  }
  return outcome.status === "unverifiable" ? (outcome.code ?? outcome.reason) : outcome.status;
};
const deferredRowCode = (row: ArtifactScanDeferredRow): ArtifactRowIndeterminateCode => row.code;
// Exact unions: a missing or extra member fails the type check.
const rowIndeterminateCodes = {
  "index-indeterminate": true,
  "binding-not-yet-visible": true,
  "read-indeterminate": true,
  "record-not-yet-visible": true,
  "verifier-unavailable": true,
} satisfies Record<ArtifactRowIndeterminateCode, true>;
const scanOutcomeStatuses = {
  "verified": true,
  "hash-mismatch": true,
  "signature-invalid": true,
  "binding-mismatch": true,
  "unverifiable": true,
  "indeterminate": true,
  "unclassified": true,
  "conflict": true,
} satisfies Record<ScannedArtifactOutcome["status"], true>;
const scanPageCodes = {
  "metadata-conflict": true,
  "cursor-cycle": true,
  "history-restart-required": true,
  "page-limit-exceeded": true,
  "invalid-limit": true,
} satisfies Record<ScanPageCode, true>;
const unsupportedKindCode: "unsupported-kind" = new UnsupportedArtifactKindError("unsupported").code;
const historyRestartCode: "history-restart-required" =
  new AnchorHistoryRestartRequiredError("restart from null").code;

// The same surface through the discovery subpath.
declare const historyFetcher: AnchorHistoryPageFetcher;
async function historyPageCode(): Promise<ScanPageCode | null> {
  const page = await scanAnchorPage(historyFetcher, null, { limit: 100 });
  const code: DiscoveryScanPageCode | undefined = page.status === "indeterminate" ? page.code : undefined;
  return code ?? null;
}
const discoveryScanning: typeof createScanningArtifactRepository = createScanningFromDiscovery;
async function discoveryRowCodes(): Promise<DiscoveryRowIndeterminateCode[]> {
  const page: DiscoveryArtifactScanPage = await discoveryScanning(scanningDeps).scanPage();
  return page.deferred.map(deferredRowCode);
}
const discoveryUnsupported: UnsupportedArtifactKindError = new DiscoveryUnsupportedKindError("unsupported");
const discoveryRestart: AnchorHistoryRestartRequiredError = new DiscoveryRestartRequiredError("restart");
const deliverableBindingHash: string = artifactBindingHashOf("dacs4:deliverable:01J8ME0SXKQ4T9V2RC5HJ6WX7D")({ report: "ok" });
const discoveryHashOf: typeof artifactBindingHashOf = discoveryBindingHashOf;

declare const adapter: SubstrateAdapter;
declare const journal: DemosWriteJournal;
declare const result: BundleVerification;
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
void nextScanState;
void scanOutcomeCode;
void rowIndeterminateCodes;
void scanOutcomeStatuses;
void scanPageCodes;
void unsupportedKindCode;
void historyRestartCode;
void historyPageCode;
void discoveryRowCodes;
void discoveryUnsupported;
void discoveryRestart;
void deliverableBindingHash;
void discoveryHashOf;
void adapter;
void journal;
void result;
void solanaAdvance;
void solanaIntent;
void solanaAdapter;
void solanaStore;
void ap2Advance;
void ap2IdempotencyKey;
void ap2Store;
void ap2Verifier;
void ap2Provider;
