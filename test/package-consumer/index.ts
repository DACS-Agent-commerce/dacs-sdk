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
  type SubstrateAdapter,
  createBuyerRatingRecord,
  createSellerRatingRecord,
  isRatingRecord,
  publishRatingRecordDurably,
  deriveReputationWithValidation,
  lookupBundleCopies,
  negotiablePriceBand,
  isNegotiablePriceWithinBand,
  verifyBundleCore,
} from "@kynesyslabs/dacs";
import { canonicalize } from "@kynesyslabs/dacs/canonical";
import { runFulfilmentCore } from "@kynesyslabs/dacs/seller";
import {
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
const validatedReputationDeriver: typeof deriveReputationWithValidation =
  deriveReputationWithValidation;
declare const authenticatedRatingResolution: AuthenticatedRatingResolution;
const validatedReputationDeps: DeriveReputationValidationDeps = {
  validate: async () => true,
  trustBundlePartyRoles: true,
  resolveAndAuthenticateRating: async () => authenticatedRatingResolution,
};
declare const ratingEffectStore: RatingPublicationEffectStore;
const ap2Advance: typeof advanceAp2Settlement = advanceAp2Settlement;
const ap2IdempotencyKey: string = deriveAp2IdempotencyKey("consumer-job", 0);

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
void ratingValidator;
void buyerRatingProducer;
void sellerRatingProducer;
void durableRatingPublisher;
void validatedReputationDeriver;
void validatedReputationDeps;
void ratingEffectStore;
void adapter;
void journal;
void result;
void ap2Advance;
void ap2IdempotencyKey;
void ap2Store;
void ap2Verifier;
void ap2Provider;
