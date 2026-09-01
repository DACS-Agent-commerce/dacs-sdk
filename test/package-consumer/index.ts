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
  advanceCrossChainHtlc,
  deriveHtlcPreimage,
  type CrossChainHtlcAdapter,
  type CrossChainHtlcStore,
} from "@kynesyslabs/dacs/rails";

const config: DemosAdapterConfig = { rpc: "https://example.invalid" };
const verifier: typeof verifyBundleCore = verifyBundleCore;
const canonical: string = canonicalize({ b: 2, a: 1 });
const fulfilment: typeof runFulfilmentCore = runFulfilmentCore;
const htlcAdvance: typeof advanceCrossChainHtlc = advanceCrossChainHtlc;
const htlcPreimage: typeof deriveHtlcPreimage = deriveHtlcPreimage;

declare const adapter: SubstrateAdapter;
declare const journal: DemosWriteJournal;
declare const result: BundleVerification;
declare const htlcAdapter: CrossChainHtlcAdapter;
declare const htlcStore: CrossChainHtlcStore;

void config;
void verifier;
void canonical;
void fulfilment;
void adapter;
void journal;
void result;
void htlcAdvance;
void htlcPreimage;
void htlcAdapter;
void htlcStore;
