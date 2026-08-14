import {
  captureFixedPriceOfflineProtocolBinding,
  FIXED_PRICE_OFFLINE_COMMERCE_PROFILE,
  FIXED_PRICE_OFFLINE_STANDARD_REVISION,
  type FixedPriceOfflineProtocolBinding,
} from "@kynesyslabs/dacs/commerce";

/** Construct the one-click host's exact non-production protocol binding. */
export function createDacsNodeOfflineProtocolBinding(
  orchestrator: string,
): Readonly<FixedPriceOfflineProtocolBinding> {
  return captureFixedPriceOfflineProtocolBinding({
    commerceProfile: FIXED_PRICE_OFFLINE_COMMERCE_PROFILE,
    standardRevision: FIXED_PRICE_OFFLINE_STANDARD_REVISION,
    mode: "offline",
    orchestratorTopology: "seller-as-phase-orchestrator-v1",
    orchestrator,
    settlement: {
      adapter: "deterministic-offline",
      version: 1,
      disposition: "mocked",
    },
  });
}
