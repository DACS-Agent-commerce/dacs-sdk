import { describe, expect, it } from "vitest";

import {
  DACS_NODE_LIVE_PROFILE,
  createDacsX402BuyerEvmRuntimeV1,
  deriveDacsEvmRoleIdentityV1,
  type DacsLoadedSecretV1,
} from "../src/index.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const NETWORK = "eip155:84532" as const;
const PAYEE = `0x${"22".repeat(20)}`;
const ASSET = `0x${"33".repeat(20)}`;

function config() {
  return {
    mode: "live-demos" as const,
    profile: DACS_NODE_LIVE_PROFILE,
    role: "buyer" as const,
    dataDirectory: "/tmp/dacs-evm-runtime-test",
    demos: { rpcUrl: "http://127.0.0.1:5350" },
    rail: { registryIndexRef: "dacs4:registry:v0.1", requestedNetwork: NETWORK },
    limits: {
      maxServiceAmount: { asset: "USDC", amount: "1" },
      maxSetupSpendDem: "10",
      maxDemosNetworkFeeDem: "2",
      maxEvmNetworkFeeEth: "0.001",
    },
  };
}

function secret(value: string): Readonly<DacsLoadedSecretV1> {
  let destroyed = false;
  return {
    source: "file",
    warningCodes: [],
    get destroyed() { return destroyed; },
    bytes: () => {
      if (destroyed) throw new Error("destroyed");
      return new TextEncoder().encode(value);
    },
    text: () => {
      if (destroyed) throw new Error("destroyed");
      return value;
    },
    redact: (text) => text.replaceAll(value, "[REDACTED]"),
    destroy: () => { destroyed = true; },
    toJSON: () => ({ source: "file", warningCodes: [], redacted: true }),
  };
}

describe("buyer EVM runtime", () => {
  it("derives the payer locally, destroys source bytes and scopes every signer", async () => {
    const loaded = secret(`0x${"11".repeat(32)}\n`);
    const runtime = await createDacsX402BuyerEvmRuntimeV1({
      config: config(),
      evmPrivateKey: loaded,
      rpcUrl: "http://127.0.0.1:8545",
    });
    expect(loaded.destroyed).toBe(true);
    expect(runtime.payerAddress).toMatch(/^0x[0-9A-Fa-f]{40}$/);
    expect(runtime.chainId).toBe(84532);

    const authority = {
      jobId: JOB_ID,
      phaseIndex: 2,
      railId: "x402:default",
      railVersion: "1",
      railDescriptorHash: "a".repeat(64),
      agreementHash: "b".repeat(64),
      termsHash: "c".repeat(64),
      sessionBindingHash: "d".repeat(64),
      network: NETWORK,
      payer: runtime.payerAddress,
      payee: PAYEE,
      asset: ASSET,
      amount: "1000",
      httpResource: "https://seller.example/deliver/test",
      method: "GET" as const,
    };
    const expectedRequirements = {
      scheme: "exact",
      network: NETWORK,
      amount: "1000",
      asset: ASSET,
      payTo: PAYEE,
      maxTimeoutSeconds: 120,
      extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
    };
    const client = await runtime.createChallengeClient({
      authority,
      expectedRequirements,
    });
    expect(client.address.toLowerCase()).toBe(runtime.payerAddress.toLowerCase());

    runtime.destroy();
    expect(runtime.destroyed).toBe(true);
    await expect(runtime.createChallengeClient({ authority, expectedRequirements }))
      .rejects.toMatchObject({ reasonCode: "evm-runtime-destroyed" });
  });

  it("destroys malformed source material before rejecting it", async () => {
    const loaded = secret("not-a-private-key");
    await expect(createDacsX402BuyerEvmRuntimeV1({
      config: config(),
      evmPrivateKey: loaded,
      rpcUrl: "http://127.0.0.1:8545",
    })).rejects.toMatchObject({ reasonCode: "evm-secret-invalid" });
    expect(loaded.destroyed).toBe(true);
  });

  it("derives a seller payee identity without retaining signing authority", async () => {
    const loaded = secret(`0x${"44".repeat(32)}`);
    const identity = await deriveDacsEvmRoleIdentityV1({
      config: { ...config(), role: "seller" as const },
      role: "seller",
      evmPrivateKey: loaded,
    });
    expect(identity).toMatchObject({
      role: "seller",
      network: NETWORK,
      chainId: 84532,
    });
    expect(identity.address).toMatch(/^0x[0-9A-Fa-f]{40}$/);
    expect(loaded.destroyed).toBe(true);
    expect(JSON.stringify(identity)).not.toContain("44".repeat(32));
  });
});
