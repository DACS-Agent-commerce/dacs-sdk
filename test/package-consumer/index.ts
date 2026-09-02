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
const canonical: string = canonicalize({ b: 2, a: 1 });
const fulfilment: typeof runFulfilmentCore = runFulfilmentCore;
const htlcAdvance: typeof advanceCrossChainHtlc = advanceCrossChainHtlc;
const htlcPreimage: typeof deriveHtlcPreimage = deriveHtlcPreimage;
const solanaAdvance: typeof advanceSolanaSplSettlement = advanceSolanaSplSettlement;
const solanaIntent: typeof createSolanaSplSettlementIntent = createSolanaSplSettlementIntent;
const ap2Advance: typeof advanceAp2Settlement = advanceAp2Settlement;
const ap2IdempotencyKey: string = deriveAp2IdempotencyKey("consumer-job", 0);

declare const adapter: SubstrateAdapter;
declare const journal: DemosWriteJournal;
declare const result: BundleVerification;
declare const htlcAdapter: CrossChainHtlcAdapter;
declare const htlcStore: CrossChainHtlcStore;
declare const solanaAdapter: SolanaSplAdapter;
declare const solanaStore: SolanaSplSettlementStore;
declare const ap2Store: Ap2BindingStore;
declare const ap2Verifier: Ap2MandateVerifier;
declare const ap2Provider: Ap2ProviderAdapter;

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
void solanaAdvance;
void solanaIntent;
void solanaAdapter;
void solanaStore;
void ap2Advance;
void ap2IdempotencyKey;
void ap2Store;
void ap2Verifier;
void ap2Provider;
