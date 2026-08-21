import {
  RAIL_REGISTRY_INDEX_ADDRESS,
  ed25519Sign,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
  resolveRail,
  signComponentArtifact,
  type ProtocolAnchorReceipt,
  type RailDefinition,
  type RailRegistryDefinitionRef,
} from "@kynesyslabs/dacs";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { describe, expect, it, vi } from "vitest";

import {
  createDacsDemosRailRegistryProviderV1,
  type DacsDemosAdapterV1,
  type DacsDemosActorRuntimeV1,
} from "../src/index.js";

const SEED = Uint8Array.from(Buffer.alloc(32, 42));
const PUBLIC_KEY = rawPublicKey(publicKeyFromSeed(SEED));
const STEWARD = `did:demos:agent:${Buffer.from(PUBLIC_KEY).toString("hex")}`;
const privateKey = privateKeyFromSeed(SEED);

function receipt(
  ref: RailRegistryDefinitionRef,
  logicalAddress = ref.logicalAddress,
): ProtocolAnchorReceipt {
  return {
    receiptVersion: "1",
    substrate: "demos",
    finalityProfile: "demos-bft-confirmed-native-read",
    logicalAddress,
    nativeAddress: ref.anchor.locator,
    contentHash: ref.contentHash,
    transactionRef: { kind: "demos-storage-program", value: `tx:${ref.contentHash}` },
    writer: STEWARD,
    nonce: "1",
    state: "finalized",
    observationDisposition: "established",
    observedAt: 1_780_000_000_000,
    blockRef: { id: "block:1", height: "1", timestamp: 1_780_000_000_000 },
    evidence: { kind: "demos-bft-write-proof-v1", value: "test-proof" },
  };
}

async function fixture() {
  const unsigned: Omit<RailDefinition, "signature"> = {
    railVersion: 1,
    railId: "x402:default",
    railType: "x402",
    asset: {
      kind: "erc20",
      chainId: 84532,
      contract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      symbol: "USDC",
      decimals: 6,
    },
    network: { kind: "x402-resource", resourceBaseUrl: "https://seller.example" },
    phaseHandler: "pay-x402",
    parameters: { authorization: "eip-3009", finalityBlocks: 1 },
    availability: "live",
    governance: {
      proposedBy: STEWARD,
      acceptedAt: 1_780_000_000_000,
      anchoring: "single-signer",
    },
  };
  const definition = await signComponentArtifact(unsigned, "dacs-rail:v1:", {
    algorithm: "ed25519",
    signer: STEWARD,
    sign: (bytes) => ed25519Sign(bytes, privateKey),
  });
  const definitionRef: RailRegistryDefinitionRef = {
    logicalAddress: "dacs4:rail:x402%3Adefault:1",
    anchor: { kind: "storage-program", locator: "stor:definition" },
    contentHash: contentHash(definition),
  };
  const index = {
    registryId: RAIL_REGISTRY_INDEX_ADDRESS,
    entries: [definitionRef],
  };
  const indexRef: RailRegistryDefinitionRef = {
    logicalAddress: RAIL_REGISTRY_INDEX_ADDRESS,
    anchor: { kind: "storage-program", locator: "stor:index" },
    contentHash: contentHash(index),
  };
  let current = {
    registryVersion: 1,
    indexRef,
    receipt: receipt(indexRef, RAIL_REGISTRY_INDEX_ADDRESS),
  };
  const bindingRef: RailRegistryDefinitionRef = {
    logicalAddress: RAIL_REGISTRY_INDEX_ADDRESS,
    anchor: { kind: "storage-program", locator: "stor:binding" },
    contentHash: contentHash(current),
  };
  const verifyDemosAnchorReceipt = vi.fn(async () => true);
  const adapter: DacsDemosAdapterV1 = {
    raw: {
      getNetworkInfo: vi.fn(async () => ({})),
      getAddressNonce: vi.fn(async () => 0),
      getAddressInfo: vi.fn(async () => ({})),
    },
    connect: vi.fn(async () => undefined),
    getAddress: vi.fn(() => "buyer"),
    getPublicKey: vi.fn(async () => new Uint8Array(32)),
    sign: vi.fn(async () => new Uint8Array(64)),
    resolveIdentity: vi.fn(async (ref) => ({ ref, raw: {} })),
    resolveAnchorByName: vi.fn(async () => ({
      status: "present" as const,
      address: "stor:binding",
    })),
    readAnchor: vi.fn(async (address) => {
      if (address === "stor:binding") return structuredClone(current);
      if (address === "stor:index") return structuredClone(index);
      if (address === "stor:definition") return structuredClone(definition);
      return null;
    }),
    anchorWriteOnce: vi.fn(async () => ({ address: "unused" })),
    verifyDemosAnchorReceipt,
    resolveDemosAnchorReceipt: vi.fn(async (input) => {
      if (input.nativeAddress === "stor:binding") {
        return receipt({
          ...bindingRef,
          contentHash: input.contentHash,
        });
      }
      if (input.nativeAddress === "stor:definition") {
        return receipt(definitionRef);
      }
      return null;
    }),
  };
  const runtime = {
    role: "buyer",
    authority: `did:demos:agent:${"11".repeat(32)}`,
    walletAddress: "buyer",
    publicKey: new Uint8Array(32),
    adapter,
    signTransportEnvelope: vi.fn(async () => new Uint8Array(64)),
    networkInfo: vi.fn(async () => ({})),
    addressNonce: vi.fn(async () => 0),
    addressInfo: vi.fn(async () => ({})),
  } satisfies DacsDemosActorRuntimeV1;
  const provider = createDacsDemosRailRegistryProviderV1({
    runtime,
    stewardAuthority: STEWARD,
    stewardPublicKey: PUBLIC_KEY,
  });
  return {
    provider,
    verifyDemosAnchorReceipt,
    setCurrent(value: typeof current) { current = value; },
    current: () => structuredClone(current),
  };
}

describe("authenticated Demos rail registry provider", () => {
  it("authorizes a steward-owned current binding and definition through core resolution", async () => {
    const { provider, verifyDemosAnchorReceipt } = await fixture();
    await expect(resolveRail(
      RAIL_REGISTRY_INDEX_ADDRESS,
      "x402:default",
      provider,
    )).resolves.toMatchObject({
      railId: "x402:default",
      railVersion: 1,
      railType: "x402",
      availability: "live",
    });
    expect(verifyDemosAnchorReceipt).toHaveBeenCalledTimes(3);
  });

  it("rejects a binding changed between lookup and authority verification", async () => {
    const { provider, current, setCurrent } = await fixture();
    const selected = await provider.resolveCurrentIndex(RAIL_REGISTRY_INDEX_ADDRESS);
    expect(selected).not.toBeNull();
    setCurrent({ ...current(), registryVersion: 2 });
    await expect(provider.authenticateCurrentIndex({
      logicalAddress: RAIL_REGISTRY_INDEX_ADDRESS,
      registryVersion: selected!.registryVersion,
      indexRef: selected!.indexRef,
      receipt: selected!.receipt,
      index: {
        registryId: RAIL_REGISTRY_INDEX_ADDRESS,
        entries: [],
      },
    })).resolves.toBe("invalid");
  });

  it("fails construction when the pinned steward key does not bind its primary ClaimRef", async () => {
    const { provider: _provider } = await fixture();
    await expect(async () => createDacsDemosRailRegistryProviderV1({
      runtime: {} as DacsDemosActorRuntimeV1,
      stewardAuthority: STEWARD,
      stewardPublicKey: new Uint8Array(32).fill(9),
    })).rejects.toThrow(/steward authority is invalid/);
  });
});
