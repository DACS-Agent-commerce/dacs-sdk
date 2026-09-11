import { describe, expect, it } from "vitest";

import {
  createDacsNodeOfflineProtocolBinding,
  dacsLiveRailProfiles,
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

  it("deeply detaches and freezes every admitted configuration branch", () => {
    const input = {
      mode: "live-demos" as const,
      profile: DACS_NODE_LIVE_PROFILE,
      role: "seller" as const,
      dataDirectory: "/var/lib/dacs/seller",
      publicBaseUrl: "https://seller.example",
      demos: { rpcUrl: "wss://rpc.example/ws", storageReadUrl: "https://read.example" },
      rail: { registryIndexRef: "dacs-rail-index:v1", requestedNetwork: "eip155:8453" },
      limits: {
        maxServiceAmount: { asset: "USDC", amount: "1.25" },
        maxSetupSpendDem: "2",
        maxDemosNetworkFeeDem: "0.1",
        maxEvmNetworkFeeEth: "0.001",
      },
    };
    const admitted = validateDacsAgentConfig(input);

    input.demos.rpcUrl = "https://attacker.example";
    input.rail.requestedNetwork = "eip155:1";
    input.limits.maxServiceAmount.amount = "999";

    expect(admitted).toMatchObject({
      demos: { rpcUrl: "wss://rpc.example/ws" },
      rail: { requestedNetwork: "eip155:8453" },
      limits: { maxServiceAmount: { amount: "1.25" } },
    });
    expect(admitted.mode).toBe("live-demos");
    if (admitted.mode !== "live-demos") throw new Error("expected live configuration");
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.demos)).toBe(true);
    expect(Object.isFrozen(admitted.rail)).toBe(true);
    expect(Object.isFrozen(admitted.limits)).toBe(true);
    expect(Object.isFrozen(admitted.limits.maxServiceAmount)).toBe(true);
  });

  it.each([
    ["native DEM", ["pay-dem"]],
    ["x402", ["x402"]],
    ["both rails", ["pay-dem", "x402"]],
  ] as const)("admits and freezes the explicit %s profile selection", (_, enabledProfiles) => {
    const admitted = validateDacsAgentConfig({
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      dataDirectory: "./data",
      demos: { rpcUrl: "https://rpc.example" },
      rail: {
        registryIndexRef: "index",
        requestedNetwork: "network",
        enabledProfiles,
      },
      limits,
    });
    if (admitted.mode !== "live-demos") throw new Error("expected live configuration");

    expect(dacsLiveRailProfiles(admitted)).toEqual(enabledProfiles);
    expect(Object.isFrozen(admitted.rail.enabledProfiles)).toBe(true);
  });

  it("defaults pre-multirail live configurations to x402", () => {
    const admitted = validateDacsAgentConfig({
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      dataDirectory: "./data",
      demos: { rpcUrl: "https://rpc.example" },
      rail: { registryIndexRef: "index", requestedNetwork: "network" },
      limits,
    });
    if (admitted.mode !== "live-demos") throw new Error("expected live configuration");

    expect(dacsLiveRailProfiles(admitted)).toEqual(["x402"]);
    expect(Object.isFrozen(dacsLiveRailProfiles(admitted))).toBe(true);
  });

  it.each([
    { enabledProfiles: [] },
    { enabledProfiles: ["x402", "pay-dem"] },
    { enabledProfiles: ["pay-dem", "pay-dem"] },
    { enabledProfiles: ["x402", "x402"] },
    { enabledProfiles: ["unknown"] },
  ])("rejects ambiguous or unsupported live rail profile selection: $enabledProfiles", ({
    enabledProfiles,
  }) => {
    expect(() => validateDacsAgentConfig({
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      dataDirectory: "./data",
      demos: { rpcUrl: "https://rpc.example" },
      rail: { registryIndexRef: "index", requestedNetwork: "network", enabledProfiles },
      limits,
    })).toThrow();
  });

  it.each([
    "http://localhost:3000",
    "http://worker.localhost:3000",
    "http://127.0.0.1:3000",
    "http://127.42.0.9:3000",
    "http://[::1]:3000",
    "https://seller.example",
  ])("admits a live HTTPS or loopback public base URL: %s", (publicBaseUrl) => {
    expect(() => validateDacsAgentConfig({
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "seller",
      dataDirectory: "./data",
      publicBaseUrl,
      demos: { rpcUrl: "https://rpc.example" },
      rail: { registryIndexRef: "index", requestedNetwork: "network" },
      limits,
    })).not.toThrow();
  });

  it.each([
    "http://seller.example",
    "http://localhost.example",
    "http://192.168.1.10",
    "ftp://seller.example",
  ])("rejects an insecure non-loopback live public base URL: %s", (publicBaseUrl) => {
    expect(() => validateDacsAgentConfig({
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "seller",
      dataDirectory: "./data",
      publicBaseUrl,
      demos: { rpcUrl: "https://rpc.example" },
      rail: { registryIndexRef: "index", requestedNetwork: "network" },
      limits,
    })).toThrow();
  });

  it.each([
    {
      label: "remote plaintext HTTP RPC",
      demos: { rpcUrl: "http://rpc.example" },
    },
    {
      label: "remote plaintext WebSocket RPC",
      demos: { rpcUrl: "ws://rpc.example" },
    },
    {
      label: "remote plaintext storage reader",
      demos: {
        rpcUrl: "https://rpc.example",
        storageReadUrl: "http://read.example",
      },
    },
  ])("rejects a $label in live mode", ({ demos }) => {
    expect(() => validateDacsAgentConfig({
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "seller",
      dataDirectory: "./data",
      publicBaseUrl: "https://seller.example",
      demos,
      rail: { registryIndexRef: "index", requestedNetwork: "network" },
      limits,
    })).toThrow();
  });

  it.each([
    {
      label: "loopback plaintext HTTP RPC",
      demos: { rpcUrl: "http://127.0.0.1:5353" },
    },
    {
      label: "loopback plaintext WebSocket RPC",
      demos: { rpcUrl: "ws://[::1]:5353" },
    },
    {
      label: "loopback plaintext storage reader",
      demos: {
        rpcUrl: "wss://rpc.example/ws",
        storageReadUrl: "http://reader.localhost:3000",
      },
    },
  ])("admits a $label in live mode", ({ demos }) => {
    expect(() => validateDacsAgentConfig({
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "seller",
      dataDirectory: "./data",
      publicBaseUrl: "https://seller.example",
      demos,
      rail: { registryIndexRef: "index", requestedNetwork: "network" },
      limits,
    })).not.toThrow();
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
