import {
  type BundleVerification,
  type DemosAdapterConfig,
  type SubstrateAdapter,
  verifyBundleCore,
} from "@kynesyslabs/dacs";

const config: DemosAdapterConfig = { rpc: "https://example.invalid" };
const verifier: typeof verifyBundleCore = verifyBundleCore;

declare const adapter: SubstrateAdapter;
declare const result: BundleVerification;

void config;
void verifier;
void adapter;
void result;
