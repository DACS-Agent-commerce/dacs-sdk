import {
  type BundleVerification,
  type DemosAdapterConfig,
  type DemosWriteJournal,
  type PayDemSettlementRecoveryContext,
  type PayDemSettlementReconcile,
  type SubstrateAdapter,
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

declare const adapter: SubstrateAdapter;
declare const journal: DemosWriteJournal;
declare const result: BundleVerification;
declare const recovery: PayDemSettlementRecoveryContext;
declare const railsRecovery: RailsPayDemSettlementRecoveryContext;
declare const reconcile: PayDemSettlementReconcile;

void config;
void verifier;
void canonical;
void fulfilment;
void adapter;
void journal;
void result;
void recovery;
void railsRecovery;
void reconcile;
