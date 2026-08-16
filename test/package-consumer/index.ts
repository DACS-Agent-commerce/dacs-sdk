import {
  type BundleVerification,
  type DemosAdapterConfig,
  type DemosWriteJournal,
  type PayDemSettlementRecoveryContext,
  type PayDemSettlementReconcile,
  type AuthenticatedRailDefinition,
  type RailDefinition,
  type RailDispatchOptions,
  type RailSelector,
  type SubstrateAdapter,
  resolveRail,
  settleFromRail,
  verifyBundleCore,
} from "@kynesyslabs/dacs";
import { canonicalize } from "@kynesyslabs/dacs/canonical";
import { runFulfilmentCore } from "@kynesyslabs/dacs/seller";
import type {
  PayDemSettlementRecoveryContext as RailsPayDemSettlementRecoveryContext,
} from "@kynesyslabs/dacs/rails";

const config: DemosAdapterConfig = { rpc: "https://example.invalid" };
const verifier: typeof verifyBundleCore = verifyBundleCore;
const canonical: string = canonicalize({ b: 2, a: 1 });
const fulfilment: typeof runFulfilmentCore = runFulfilmentCore;
const railResolver: typeof resolveRail = resolveRail;
const railDispatch: (
  rail: AuthenticatedRailDefinition,
  options: RailDispatchOptions,
) => ReturnType<typeof settleFromRail> = settleFromRail;
const railSelector: RailSelector = {
  railId: "demos-native:DEM",
  railVersion: 1,
};

declare const adapter: SubstrateAdapter;
declare const journal: DemosWriteJournal;
declare const result: BundleVerification;
declare const recovery: PayDemSettlementRecoveryContext;
declare const railsRecovery: RailsPayDemSettlementRecoveryContext;
declare const reconcile: PayDemSettlementReconcile;
declare const structuralRail: RailDefinition;
// Resolver provenance is intentionally nominal: a signed structural copy is
// not sufficient payment authority under DACS-4 RAV-R5.
// @ts-expect-error RailDefinition lacks the private authenticated brand.
const untrustedDispatchAuthority: AuthenticatedRailDefinition = structuralRail;

void config;
void verifier;
void canonical;
void fulfilment;
void railResolver;
void railDispatch;
void railSelector;
void adapter;
void journal;
void result;
void recovery;
void railsRecovery;
void reconcile;
void untrustedDispatchAuthority;
