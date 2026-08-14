# Fixed-price offline coordinator

The offline coordinator is the deterministic, non-production companion to the
live fixed-price x402 coordinator. It exposes the same role-separated scheduler
shape so a generated application can replace infrastructure adapters without
rewriting lifecycle orchestration.

It does **not** simulate a live x402 rail. Its exact profile is:

```text
dacs-sdk:fixed-price-offline:v1
```

An offline binding contains no registry reference, network, x402 phase, live
availability, or substrate receipt. It uses an explicit `mocked` disposition and
a separate binding/effect-identity domain. Live x402 validators reject offline
bindings and offline validators reject live x402 bindings. Offline records are
not resumable or upgradeable as live sessions.

```ts
import {
  createFixedPriceOfflineBuyerCoordinator,
  createInMemoryFixedPriceOfflineCoordinatorStore,
  FIXED_PRICE_OFFLINE_COMMERCE_PROFILE,
  FIXED_PRICE_OFFLINE_STANDARD_REVISION,
  type FixedPriceOfflineProtocolBinding,
} from "@kynesyslabs/dacs/commerce";

const protocol: FixedPriceOfflineProtocolBinding = {
  commerceProfile: FIXED_PRICE_OFFLINE_COMMERCE_PROFILE,
  standardRevision: FIXED_PRICE_OFFLINE_STANDARD_REVISION,
  mode: "offline",
  orchestratorTopology: "seller-as-phase-orchestrator-v1",
  orchestrator: sellerClaim,
  settlement: {
    adapter: "deterministic-offline",
    version: 1,
    disposition: "mocked",
  },
};

const buyer = createFixedPriceOfflineBuyerCoordinator({
  store: createInMemoryFixedPriceOfflineCoordinatorStore(),
  workerId: processInstanceId,
  operations: {
    agreement: runOfflineAgreement,
    payment: runDeterministicOfflineSettlement,
    "payment-evidence": publishOfflinePaymentEvidence,
    "buyer-received": retainOfflineReceipt,
    audit: finalizeOfflineBuyerBundle,
  },
});
```

The included store is a process-local reference implementation intended for the
offline quickstart and tests. Production live execution must continue to use the
live x402 factories, authenticated live protocol binding, and a durable host
store.
