import {
  type BundleVerification,
  type DemosAdapterConfig,
  type DemosWriteJournal,
  type SubstrateAdapter,
  verifyBundleCore,
} from "@kynesyslabs/dacs";
import { canonicalize } from "@kynesyslabs/dacs/canonical";
import { runFulfilmentCore } from "@kynesyslabs/dacs/seller";

const config: DemosAdapterConfig = { rpc: "https://example.invalid" };
const verifier: typeof verifyBundleCore = verifyBundleCore;
const canonical: string = canonicalize({ b: 2, a: 1 });
const fulfilment: typeof runFulfilmentCore = runFulfilmentCore;

declare const adapter: SubstrateAdapter;
declare const journal: DemosWriteJournal;
declare const result: BundleVerification;

void config;
void verifier;
void canonical;
void fulfilment;
void adapter;
void journal;
void result;
