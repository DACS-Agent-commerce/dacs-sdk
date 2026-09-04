import {
  type BundleVerification,
  type DemosAdapterConfig,
  type DemosWriteJournal,
  type SubstrateAdapter,
  lookupBundleCopies,
  verifyBundleCore,
} from "@kynesyslabs/dacs";
import { canonicalize } from "@kynesyslabs/dacs/canonical";
import { runFulfilmentCore } from "@kynesyslabs/dacs/seller";
import {
  advanceLiquidityTankSettlement,
  createLiquidityTankIntent,
  type LiquidityTankAdapter,
  type LiquidityTankStore,
} from "@kynesyslabs/dacs/rails";

const config: DemosAdapterConfig = { rpc: "https://example.invalid" };
const verifier: typeof verifyBundleCore = verifyBundleCore;
const bundleLookup: typeof lookupBundleCopies = lookupBundleCopies;
const canonical: string = canonicalize({ b: 2, a: 1 });
const fulfilment: typeof runFulfilmentCore = runFulfilmentCore;
const tankAdvance: typeof advanceLiquidityTankSettlement = advanceLiquidityTankSettlement;
const tankIntent: typeof createLiquidityTankIntent = createLiquidityTankIntent;

declare const adapter: SubstrateAdapter;
declare const journal: DemosWriteJournal;
declare const result: BundleVerification;
declare const tankAdapter: LiquidityTankAdapter;
declare const tankStore: LiquidityTankStore;

void config;
void verifier;
void bundleLookup;
void canonical;
void fulfilment;
void adapter;
void journal;
void result;
void tankAdvance;
void tankIntent;
void tankAdapter;
void tankStore;
