import {
  type BundleVerification,
  type DemosAdapterConfig,
  type DemosWriteJournal,
  type SubstrateAdapter,
  verifyBundleCore,
} from "@kynesyslabs/dacs";
import { canonicalize } from "@kynesyslabs/dacs/canonical";
import { runFulfilmentCore } from "@kynesyslabs/dacs/seller";
import {
  advanceSolanaSplSettlement,
  createSolanaSplSettlementIntent,
  type SolanaSplAdapter,
  type SolanaSplSettlementStore,
} from "@kynesyslabs/dacs/rails";

const config: DemosAdapterConfig = { rpc: "https://example.invalid" };
const verifier: typeof verifyBundleCore = verifyBundleCore;
const canonical: string = canonicalize({ b: 2, a: 1 });
const fulfilment: typeof runFulfilmentCore = runFulfilmentCore;
const solanaAdvance: typeof advanceSolanaSplSettlement = advanceSolanaSplSettlement;
const solanaIntent: typeof createSolanaSplSettlementIntent = createSolanaSplSettlementIntent;

declare const adapter: SubstrateAdapter;
declare const journal: DemosWriteJournal;
declare const result: BundleVerification;
declare const solanaAdapter: SolanaSplAdapter;
declare const solanaStore: SolanaSplSettlementStore;

void config;
void verifier;
void canonical;
void fulfilment;
void adapter;
void journal;
void result;
void solanaAdvance;
void solanaIntent;
void solanaAdapter;
void solanaStore;
