import {
  type BundleVerification,
  type DemosAdapterConfig,
  type DemosWriteJournal,
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

declare const adapter: SubstrateAdapter;
declare const journal: DemosWriteJournal;
declare const result: BundleVerification;

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
void adapter;
void journal;
void result;
