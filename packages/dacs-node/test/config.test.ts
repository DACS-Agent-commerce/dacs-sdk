import { describe, expect, it } from "vitest";

import {
  createDacsNodeOfflineProtocolBinding,
  DACS_NODE_LIVE_PROFILE,
  DACS_NODE_OFFLINE_PROFILE,
  validateDacsAgentConfig,
} from "../src/index.js";

const limits = Object.freeze({
  maxServiceAmount: Object.freeze({ asset: "USDC", amount: "1.25" }),
  maxSetupSpendDem: "2",
  maxDemosNetworkFeeDem: "0.1",
  maxEvmNetworkFeeEth: "0.001",
});

describe("DACS node configuration", () => {
  it("admits detached, closed offline and live variants", () => {
    const offline = {
      mode: "offline",
      profile: DACS_NODE_OFFLINE_PROFILE,
      role: "demo-all",
      dataDirectory: "./data",
      limits,
    };
    const admitted = validateDacsAgentConfig(offline);
    offline.dataDirectory = "./changed";
    expect(admitted).toMatchObject({ mode: "offline", dataDirectory: "./data" });

    expect(validateDacsAgentConfig({
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      dataDirectory: "/var/lib/dacs/buyer",
      publicBaseUrl: "https://buyer.example",
      demos: { rpcUrl: "wss://rpc.example/ws", storageReadUrl: "https://read.example" },
      rail: { registryIndexRef: "dacs-rail-index:v1", requestedNetwork: "eip155:8453" },
      limits,
    })).toMatchObject({ mode: "live-demos", role: "buyer" });
  });

  it.each([
    {
      mode: "offline",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "demo-all",
      dataDirectory: "./data",
      limits,
    },
    {
      mode: "offline",
      profile: DACS_NODE_OFFLINE_PROFILE,
      role: "demo-all",
      dataDirectory: "./data",
      demos: { rpcUrl: "https://rpc.example" },
      limits,
    },
    {
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "demo-all",
      dataDirectory: "./data",
      demos: { rpcUrl: "https://rpc.example" },
      rail: { registryIndexRef: "index", requestedNetwork: "network" },
      limits,
    },
    {
      mode: "offline",
      profile: DACS_NODE_OFFLINE_PROFILE,
      role: "demo-all",
      dataDirectory: "./data",
      limits: { ...limits, maxSetupSpendDem: "01.0" },
    },
  ])("rejects crossed profiles, live fields, roles, and non-canonical limits", (input) => {
    expect(() => validateDacsAgentConfig(input)).toThrow();
  });

  it("constructs only the explicit offline binding", () => {
    expect(createDacsNodeOfflineProtocolBinding("seller:primary")).toEqual({
      commerceProfile: DACS_NODE_OFFLINE_PROFILE,
      standardRevision: expect.any(String),
      mode: "offline",
      orchestratorTopology: "seller-as-phase-orchestrator-v1",
      orchestrator: "seller:primary",
      settlement: {
        adapter: "deterministic-offline",
        version: 1,
        disposition: "mocked",
      },
    });
  });
});
