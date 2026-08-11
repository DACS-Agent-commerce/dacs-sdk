import { describe, expect, it } from "vitest";

// #14: the injectable buyer-session core must be reachable from the PUBLIC
// barrel — not only via a deep `src/agent/runSessionCore.js` import past the
// package `exports` map. These imports resolving is itself the assertion.
import {
  FENCED_SESSION_STORE_VERSION,
  SESSION_STORE_VERSION,
  createInMemoryFencedSessionStore,
  createInMemorySessionStore,
  runFulfilmentCore,
  runDurableFulfilmentCore,
  verifyDurableSellerTerminalResult,
  getSellerFulfilmentStatus,
  finalizeCompletedSellerBundleCore,
  prepareCompletedSellerBundleCounterSignatureRequest,
  verifyCompletedSellerBundleCounterSignatureRequest,
  verifyFinalizedSellerBundleReadOnly,
  finalizeCompletedSellerBundleDurable,
  getSellerBundleFinalizationStatus,
  verifyFinalizedSessionSettlement,
  createCompletedBuyerBundleCounterSignature,
  finalizeCompletedBuyerBundleCore,
  createCompletedCounterpartyBundleCounterSignature,
  finalizeCompletedCounterpartyBundleCore,
  advanceCompletedBuyerBundleDurable,
  getBuyerBundleFinalizationStatus,
  isCanonicalSettlementIdentity,
  createX402Paywall,
  x402PaywallCore,
  x402PaywallSettlementKey,
  runSessionCore,
  sellerFulfilmentId,
  type SellerFulfilmentDeps,
  type DurableSellerFulfilmentDeps,
  type FencedSessionRecordV2,
  type FencedSessionStoreV2,
  type SellerFulfilmentDurability,
  type SessionRecord,
  type SessionStore,
  type CompletedSellerSessionArtifacts,
  type SellerPaymentPhaseIndexResolution,
  type BuyerBundleFinalizationDurability,
  type DurableBuyerBundleFinalizationInput,
  type AuthenticatedBundleRolePublication,
  type CounterpartyBundleRole,
  type CounterpartyBundleFinalizationProvider,
  type DurableFinalizedBuyerBundle,
  type SessionSettlementContext,
  type SessionDeps,
} from "../../src/index.js";
import {
  createCompletedCounterpartyBundleCounterSignature as agentCreateCompletedCounterpartyBundleCounterSignature,
  finalizeCompletedCounterpartyBundleCore as agentFinalizeCompletedCounterpartyBundleCore,
} from "../../src/agent/index.js";
import {
  FENCED_SESSION_STORE_VERSION as sellerFencedSessionStoreVersion,
  createInMemoryFencedSessionStore as sellerCreateInMemoryFencedSessionStore,
  finalizeCompletedSellerBundleCore as sellerFinalizeCompletedBundleCore,
  prepareCompletedSellerBundleCounterSignatureRequest as sellerPrepareCompletedBundleCounterSignatureRequest,
  verifyCompletedSellerBundleCounterSignatureRequest as sellerVerifyCompletedBundleCounterSignatureRequest,
  verifyFinalizedSellerBundleReadOnly as sellerVerifyFinalizedBundleReadOnly,
  finalizeCompletedSellerBundleDurable as sellerFinalizeCompletedBundleDurable,
  getSellerBundleFinalizationStatus as sellerGetBundleFinalizationStatus,
  getSellerFulfilmentStatus as sellerGetFulfilmentStatus,
  runFulfilmentCore as sellerRunFulfilmentCore,
  runDurableFulfilmentCore as sellerRunDurableFulfilmentCore,
  verifyDurableSellerTerminalResult as sellerVerifyDurableTerminalResult,
  sellerFulfilmentId as sellerSurfaceFulfilmentId,
  createX402Paywall as sellerCreateX402Paywall,
  x402PaywallCore as sellerX402PaywallCore,
  x402PaywallSettlementKey as sellerX402PaywallSettlementKey,
} from "../../src/seller/index.js";
import {
  createX402Paywall as railsCreateX402Paywall,
  x402PaywallCore as railsX402PaywallCore,
  x402PaywallSettlementKey as railsX402PaywallSettlementKey,
} from "../../src/rails/index.js";

describe("public core surface (#14)", () => {
  it("F1: runSessionCore is exported from the barrel", () => {
    expect(typeof runSessionCore).toBe("function");
  });

  it("#55: durable seller recovery is exported from root and seller surfaces", () => {
    expect(typeof runDurableFulfilmentCore).toBe("function");
    expect(typeof verifyDurableSellerTerminalResult).toBe("function");
    expect(typeof getSellerFulfilmentStatus).toBe("function");
    expect(sellerRunDurableFulfilmentCore).toBe(runDurableFulfilmentCore);
    expect(sellerVerifyDurableTerminalResult).toBe(verifyDurableSellerTerminalResult);
    expect(sellerGetFulfilmentStatus).toBe(getSellerFulfilmentStatus);
    const deps: Partial<DurableSellerFulfilmentDeps> = { nowMs: () => 2 };
    const durability: Partial<SellerFulfilmentDurability> = { workerId: "worker" };
    expect(deps.nowMs?.()).toBe(2);
    expect(durability.workerId).toBe("worker");
  });

  it("#55: legacy v1 and generation-fenced v2 stores have distinct public APIs", () => {
    const legacy: SessionStore = createInMemorySessionStore();
    const fenced: FencedSessionStoreV2 = createInMemoryFencedSessionStore();
    const legacyRecord: Partial<SessionRecord> = { storeVersion: SESSION_STORE_VERSION };
    const fencedRecord: Partial<FencedSessionRecordV2> = {
      storeVersion: FENCED_SESSION_STORE_VERSION,
      leaseGeneration: 0,
    };

    expect(SESSION_STORE_VERSION).toBe(1);
    expect(FENCED_SESSION_STORE_VERSION).toBe(2);
    expect("apiVersion" in legacy).toBe(false);
    expect(fenced.apiVersion).toBe(FENCED_SESSION_STORE_VERSION);
    expect(legacyRecord.storeVersion).toBe(1);
    expect(fencedRecord.storeVersion).toBe(2);
    expect(sellerFencedSessionStoreVersion).toBe(FENCED_SESSION_STORE_VERSION);
    expect(sellerCreateInMemoryFencedSessionStore).toBe(
      createInMemoryFencedSessionStore,
    );
  });

  it("F1: SessionDeps is exported (compile-time) so a custom substrate can be wired", () => {
    // Type-only use — if SessionDeps weren't exported this file wouldn't compile.
    const partial: Partial<SessionDeps> = { buyerId: "did:demos:buyer" };
    expect(partial.buyerId).toBe("did:demos:buyer");
  });

  it("#17: seller fulfilment core and dependency contract are public", () => {
    expect(typeof runFulfilmentCore).toBe("function");
    expect(typeof finalizeCompletedSellerBundleCore).toBe("function");
    expect(typeof prepareCompletedSellerBundleCounterSignatureRequest).toBe("function");
    expect(typeof verifyCompletedSellerBundleCounterSignatureRequest).toBe("function");
    expect(typeof verifyFinalizedSellerBundleReadOnly).toBe("function");
    expect(sellerFinalizeCompletedBundleCore).toBe(finalizeCompletedSellerBundleCore);
    expect(sellerPrepareCompletedBundleCounterSignatureRequest).toBe(
      prepareCompletedSellerBundleCounterSignatureRequest,
    );
    expect(sellerVerifyCompletedBundleCounterSignatureRequest).toBe(
      verifyCompletedSellerBundleCounterSignatureRequest,
    );
    expect(sellerVerifyFinalizedBundleReadOnly).toBe(
      verifyFinalizedSellerBundleReadOnly,
    );
    expect(sellerRunFulfilmentCore).toBe(runFulfilmentCore);
    expect(sellerSurfaceFulfilmentId).toBe(sellerFulfilmentId);
    const partial: Partial<SellerFulfilmentDeps> = { nowMs: () => 1 };
    expect(partial.nowMs?.()).toBe(1);
    const artifacts: Partial<CompletedSellerSessionArtifacts> = {
      settlementEvidence: [],
    };
    const paymentPhase: SellerPaymentPhaseIndexResolution = {
      disposition: "valid",
      jobId: "job-17",
      railId: "x402:default",
      phaseIndex: 2,
      resolved: false,
    };
    expect(artifacts.settlementEvidence).toEqual([]);
    expect(paymentPhase.phaseIndex).toBe(2);
  });

  it("#81: authenticated buyer finalization is public and composable", () => {
    expect(typeof verifyFinalizedSessionSettlement).toBe("function");
    expect(typeof createCompletedBuyerBundleCounterSignature).toBe("function");
    expect(typeof finalizeCompletedBuyerBundleCore).toBe("function");
    expect(typeof advanceCompletedBuyerBundleDurable).toBe("function");
    expect(typeof getBuyerBundleFinalizationStatus).toBe("function");
    expect(isCanonicalSettlementIdentity(`demos:${"1".repeat(64)}`)).toBe(true);

    const input: Partial<DurableBuyerBundleFinalizationInput> = {};
    const durability: Partial<BuyerBundleFinalizationDurability> = {
      workerId: "buyer-worker",
    };
    const context: Partial<SessionSettlementContext> = {
      contextVersion: "1",
      jobId: "job-81",
    };
    expect(input.buyer).toBeUndefined();
    expect(durability.workerId).toBe("buyer-worker");
    expect(context.jobId).toBe("job-81");
  });

  it("#81: role-owned finalization and durable publication metadata are public", () => {
    expect(typeof createCompletedCounterpartyBundleCounterSignature).toBe("function");
    expect(typeof finalizeCompletedCounterpartyBundleCore).toBe("function");
    expect(agentCreateCompletedCounterpartyBundleCounterSignature).toBe(
      createCompletedCounterpartyBundleCounterSignature,
    );
    expect(agentFinalizeCompletedCounterpartyBundleCore).toBe(
      finalizeCompletedCounterpartyBundleCore,
    );

    const role: CounterpartyBundleRole = "orchestrator";
    const provider: Partial<CounterpartyBundleFinalizationProvider> = {
      mapping: "pure",
    };
    const publication: Partial<AuthenticatedBundleRolePublication> = {
      role: "seller",
      logicalAddress: "dacs5:bundle:job-81:seller",
    };
    const durable: Partial<DurableFinalizedBuyerBundle> = {
      state: "finalised",
    };
    expect(role).toBe("orchestrator");
    expect(provider.mapping).toBe("pure");
    expect(publication.role).toBe("seller");
    expect(durable.state).toBe("finalised");
  });

  it("#55: durable seller recovery and status are public on both entrypoints", () => {
    expect(typeof runDurableFulfilmentCore).toBe("function");
    expect(typeof verifyDurableSellerTerminalResult).toBe("function");
    expect(typeof getSellerFulfilmentStatus).toBe("function");
    expect(sellerRunDurableFulfilmentCore).toBe(runDurableFulfilmentCore);
    expect(sellerVerifyDurableTerminalResult).toBe(verifyDurableSellerTerminalResult);
    expect(sellerGetFulfilmentStatus).toBe(getSellerFulfilmentStatus);
    expect(typeof finalizeCompletedSellerBundleDurable).toBe("function");
    expect(typeof getSellerBundleFinalizationStatus).toBe("function");
    expect(sellerFinalizeCompletedBundleDurable).toBe(
      finalizeCompletedSellerBundleDurable,
    );
    expect(sellerGetBundleFinalizationStatus).toBe(
      getSellerBundleFinalizationStatus,
    );
  });

  it("#24: x402 seller paywall is public on root, seller, and rails entrypoints", () => {
    expect(typeof createX402Paywall).toBe("function");
    expect(typeof x402PaywallCore).toBe("function");
    expect(sellerCreateX402Paywall).toBe(createX402Paywall);
    expect(railsCreateX402Paywall).toBe(createX402Paywall);
    expect(sellerX402PaywallCore).toBe(x402PaywallCore);
    expect(railsX402PaywallCore).toBe(x402PaywallCore);
    expect(sellerX402PaywallSettlementKey).toBe(x402PaywallSettlementKey);
    expect(railsX402PaywallSettlementKey).toBe(x402PaywallSettlementKey);
  });

  // NOTE (#48): `sessionAnchorName` is intentionally NOT part of the public
  // surface yet — its MVP address strings are not the normative §6.3.x schemes,
  // so exporting them as "the scheme a verifier reproduces" would mislead. It
  // stays internal until canonical addressing lands; no public-API test asserts
  // those strings as normative.
});
