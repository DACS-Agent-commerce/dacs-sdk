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
} from "@kynesyslabs/dacs";
import { canonicalize } from "@kynesyslabs/dacs/canonical";
import { runFulfilmentCore } from "@kynesyslabs/dacs/seller";
import {
  advanceLiquidityTankSettlement,
  createFsLiquidityTankStore,
  createInMemoryLiquidityTankStore,
  createLiquidityTankIntent,
  LIQUIDITY_TANK_FS_STORE_VERSION,
  runLiquidityTankStoreConformance,
  type AdvanceLiquidityTankInput,
  type FsLiquidityTankStoreOptions,
  type InMemoryLiquidityTankStoreOptions,
  type LiquidityTankAdapter,
  type LiquidityTankAuthority,
  type LiquidityTankIntent,
  type LiquidityTankObservation,
  type LiquidityTankPreparedSubmission,
  type LiquidityTankRecoveryEvidence,
  type LiquidityTankSettlement,
  type LiquidityTankStore,
  type LiquidityTankStoreClaim,
  type LiquidityTankStoreConformanceOptions,
  type LiquidityTankStoreConformanceResult,
  type LiquidityTankStoreRestartSafety,
  type LiquidityTankVerifier,
  type LiquidityTankVerifierAnswer,
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
const tankAdvance: typeof advanceLiquidityTankSettlement = advanceLiquidityTankSettlement;
const tankIntent: typeof createLiquidityTankIntent = createLiquidityTankIntent;
const volatileTankOptions: InMemoryLiquidityTankStoreOptions = { acknowledgeVolatile: true };
const volatileTankStore: (options: InMemoryLiquidityTankStoreOptions) => LiquidityTankStore =
  createInMemoryLiquidityTankStore;
// The volatile store cannot be created without the acknowledgement.
// @ts-expect-error acknowledgeVolatile is required
const unacknowledgedTankStore: () => LiquidityTankStore = createInMemoryLiquidityTankStore;
// A store declares how it survives a restart; the core refuses one that does not.
const declaredTankSafety: LiquidityTankStoreRestartSafety = "conformance-tested";
const declaredTankStore: LiquidityTankStore = { ...tankStore, restartSafety: "volatile-acknowledged" };
// @ts-expect-error only the two declarations exist
const unknownTankSafety: LiquidityTankStoreRestartSafety = "durable";
// The SDK's durable store opens a private directory.
const fsTankOptions: FsLiquidityTankStoreOptions = { dir: "/var/lib/dacs/liquidity-tank" };
const fsTankStore: (options: FsLiquidityTankStoreOptions) => Promise<LiquidityTankStore> =
  createFsLiquidityTankStore;
const fsTankVersion: 1 = LIQUIDITY_TANK_FS_STORE_VERSION;
const tankVerifier: LiquidityTankVerifier = {
  authenticateObservation: async ({ observation }) => observation.authenticationHash.length === 64,
  verifySignedSubmission: ({ submission }) => submission.substrateTxHash.length > 0,
};
// A hook that cannot decide now answers "unavailable"; only the two literals and booleans type-check.
const outageTankAnswer: LiquidityTankVerifierAnswer = "unavailable";
const outageTankVerifier: LiquidityTankVerifier = {
  // An async arrow widens a bare string literal, so it needs `as const`.
  authenticateObservation: async () => "unavailable" as const,
  verifySignedSubmission: () => "unavailable",
};
// @ts-expect-error an answer is true, false or "unavailable"
const unknownTankAnswer: LiquidityTankVerifierAnswer = "maybe";
const tankConformanceOptions: LiquidityTankStoreConformanceOptions = {
  createStore: () => tankStore,
  reopenStore: reopenTankStore,
};
// The core refuses to run without the host's verifier.
// @ts-expect-error verifier is required
const unverifiedTankInput: AdvanceLiquidityTankInput = {
  authority: tankAuthority,
  owner: "consumer-worker",
  store: tankStore,
  adapter: tankAdapter,
};
// Every ordinary store write carries the core's clock reading.
const tankWriteLease = { settlementKey: "key", bindingHash: "binding", owner: "consumer-worker", generation: 1 };
// @ts-expect-error now is required
void tankStore.recordSubmission({ ...tankWriteLease, submission: tankSubmission });
// @ts-expect-error now is required
void tankStore.recordObservation({ ...tankWriteLease, observation: tankObservation });
// @ts-expect-error now is required
void tankStore.recordSettlement({ ...tankWriteLease, settlement: tankSettlement });
// A committed expiry returns the receipt kept with its submission.
const expiredTankClaim: LiquidityTankStoreClaim = {
  status: "recovery-expired",
  intent: tankIntentValue,
  submission: tankSubmission,
  submissionRecordedAt: 1_785_000_000_000,
  observation: tankExpiryEvidence,
};
// @ts-expect-error submissionRecordedAt is required on a committed expiry
const unreceiptedTankClaim: LiquidityTankStoreClaim = {
  status: "recovery-expired",
  intent: tankIntentValue,
  submission: tankSubmission,
  observation: tankExpiryEvidence,
};
const tankConformance: (
  options: LiquidityTankStoreConformanceOptions,
) => Promise<readonly LiquidityTankStoreConformanceResult[]> = runLiquidityTankStoreConformance;
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
declare const tankAdapter: LiquidityTankAdapter;
declare const tankStore: LiquidityTankStore;
declare const reopenTankStore: (store: LiquidityTankStore) => Promise<LiquidityTankStore>;
declare const tankAuthority: LiquidityTankAuthority;
declare const tankSubmission: LiquidityTankPreparedSubmission;
declare const tankObservation: Exclude<LiquidityTankObservation, { status: "indeterminate" }>;
declare const tankSettlement: LiquidityTankSettlement;
declare const tankIntentValue: LiquidityTankIntent;
declare const tankExpiryEvidence: LiquidityTankRecoveryEvidence;
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
void tankAdvance;
void tankIntent;
void tankAdapter;
void tankStore;
void volatileTankOptions;
void volatileTankStore;
void unacknowledgedTankStore;
void declaredTankSafety;
void declaredTankStore;
void unknownTankSafety;
void fsTankOptions;
void fsTankStore;
void fsTankVersion;
void tankVerifier;
void outageTankAnswer;
void outageTankVerifier;
void unknownTankAnswer;
void tankConformanceOptions;
void tankConformance;
void unverifiedTankInput;
void expiredTankClaim;
void unreceiptedTankClaim;
void solanaAdvance;
void solanaIntent;
void solanaAdapter;
void solanaStore;
void ap2Advance;
void ap2IdempotencyKey;
void ap2Store;
void ap2Verifier;
void ap2Provider;
