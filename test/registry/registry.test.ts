import { describe, expect, test, vi } from "vitest";
import { keccak256, stringToHex } from "viem";

import { buildSignedArtifact, type Signer } from "../../src/agent/signedArtifact.js";
import { signComponentArtifact } from "../../src/artifacts/signatures.js";
import type { AnchorReceipt } from "../../src/artifacts/types.js";
import { contentHash } from "../../src/canonical/index.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
} from "../../src/crypto/index.js";
import {
  RAIL_REGISTRY_INDEX_ADDRESS,
  getAuthenticatedRailProvenance,
  resolveRail,
  resolveRecipe,
  settleFromRail,
  type RailDefinition,
  type RailRegistryDefinitionRef,
  type RailRegistryIndexDocument,
  type RailRegistrySelectionProvider,
  type RecipeDescriptor,
  type RegistryResolveDeps,
} from "../../src/registry/index.js";

const STEWARD_SEED = Uint8Array.from(Buffer.alloc(32, 42));
const IMPOSTOR_SEED = Uint8Array.from(Buffer.alloc(32, 99));
const TEST_EVM_KEY = keccak256(stringToHex("dacs-sdk:test:registry-rail"));
const USDC_CONTRACT = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function signerFor(seed: Uint8Array): Signer {
  const priv = privateKeyFromSeed(seed);
  return (bytes) => ed25519Sign(bytes, priv);
}
const stewardPublicKey = rawPublicKey(publicKeyFromSeed(STEWARD_SEED));
const stewardSigner = `did:demos:agent:${Buffer.from(stewardPublicKey).toString("hex")}`;
const verify = (b: Uint8Array, s: Uint8Array, p: Uint8Array) =>
  ed25519Verify(b, s, publicKeyFromRaw(p));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function railRegistry() {
  const x402 = await signedRail(x402Definition());
  const deprecated = await signedRail(x402Definition({
    railId: "x402:old",
    availability: "disabled",
  }));
  return {
    registryId: RAIL_REGISTRY_INDEX_ADDRESS,
    version: "0.1",
    entries: [x402, deprecated],
  } as Record<string, unknown>;
}

type UnsignedRailDefinition = Omit<RailDefinition, "signature">;

const RAIL_GOVERNANCE = {
  proposedBy: stewardSigner,
  acceptedAt: 1_780_000_000_000,
  anchoring: "single-signer" as const,
};

function x402Definition(
  over: Partial<UnsignedRailDefinition> = {},
): UnsignedRailDefinition {
  return {
    railVersion: 1,
    railId: "x402:default",
    railType: "x402",
    asset: {
      kind: "erc20",
      chainId: 84532,
      contract: USDC_CONTRACT,
      symbol: "USDC",
      decimals: 6,
    },
    network: {
      kind: "x402-resource",
      resourceBaseUrl: "https://seller.example",
    },
    phaseHandler: "pay-x402",
    parameters: { authorization: "eip-3009" },
    availability: "live",
    governance: RAIL_GOVERNANCE,
    ...over,
  };
}

function evmDefinition(
  over: Partial<UnsignedRailDefinition> = {},
): UnsignedRailDefinition {
  return {
    railVersion: 1,
    railId: "evm-erc20:84532:USDC",
    railType: "evm-erc20",
    asset: {
      kind: "erc20",
      chainId: 84532,
      contract: USDC_CONTRACT,
      symbol: "USDC",
      decimals: 6,
    },
    network: {
      kind: "evm",
      chainId: 84532,
      rpcAttestation: "evm-rpc",
    },
    phaseHandler: "pay-evm-erc20",
    parameters: { finalityBlocks: 1 },
    availability: "live",
    governance: RAIL_GOVERNANCE,
    ...over,
  };
}

function demosDefinition(
  over: Partial<UnsignedRailDefinition> = {},
): UnsignedRailDefinition {
  return {
    railVersion: 1,
    railId: "demos-native:DEM",
    railType: "demos-native",
    asset: { kind: "native-dem", symbol: "DEM", decimals: 9 },
    network: { kind: "demos" },
    phaseHandler: "pay-dem",
    parameters: {},
    availability: "live",
    governance: RAIL_GOVERNANCE,
    ...over,
  };
}

function solanaDefinition(
  over: Partial<UnsignedRailDefinition> = {},
): UnsignedRailDefinition {
  return {
    railVersion: 1,
    railId: "solana-spl:devnet:USDC",
    railType: "solana-spl",
    asset: {
      kind: "spl",
      cluster: "devnet",
      mint: "USDC-devnet-mint",
      symbol: "USDC",
      decimals: 6,
    },
    network: { kind: "solana", cluster: "devnet" },
    phaseHandler: "pay-solana-spl",
    parameters: { commitmentLevel: "confirmed" },
    availability: "live",
    governance: RAIL_GOVERNANCE,
    ...over,
  };
}

function ap2Definition(
  over: Partial<UnsignedRailDefinition> = {},
): UnsignedRailDefinition {
  return {
    railVersion: 1,
    railId: "ap2:stripe-paymentintents",
    railType: "ap2",
    asset: {
      kind: "fiat-via-ap2",
      isoCurrency: "USD",
      provider: "stripe",
    },
    network: {
      kind: "ap2-provider",
      providerEndpoint: "https://payments.example/ap2",
    },
    phaseHandler: "pay-ap2",
    parameters: {},
    availability: "operator_gated",
    governance: RAIL_GOVERNANCE,
    ...over,
  };
}

function crossChainDefinition(
  mechanism: "htlc" | "liquidity-tank" | "substrate-native",
  over: Partial<UnsignedRailDefinition> = {},
): UnsignedRailDefinition {
  const liquidity = mechanism !== "htlc";
  return {
    railVersion: 1,
    railId: liquidity
      ? "cross-chain-liquidity-tank:USDC"
      : "cross-chain-htlc:USDC",
    railType: liquidity
      ? "cross-chain-liquidity-tank"
      : "cross-chain-htlc",
    asset: {
      kind: "stablecoin-cross-chain",
      canonicalSymbol: "USDC",
      routes: [{
        sourceChainId: 11155111,
        destChainId: "solana-devnet",
        ...(liquidity
          ? { liquidityTankIds: ["tank-1"] }
          : {
            htlcContracts: {
              source: "0x1111111111111111111111111111111111111111",
              dest: "program-1",
            },
          }),
      }],
    },
    network: { kind: "cross-chain", mechanism },
    phaseHandler: liquidity
      ? "pay-cross-chain-liquidity-tank"
      : "pay-cross-chain-htlc",
    parameters: {},
    availability: "live",
    governance: RAIL_GOVERNANCE,
    ...over,
  };
}

async function signedRail(
  descriptor: UnsignedRailDefinition,
  seed = STEWARD_SEED,
) {
  return signComponentArtifact(descriptor, "dacs-rail:v1:", {
    algorithm: "ed25519",
    signer: stewardSigner,
    sign: signerFor(seed),
  });
}

async function expectRailDefinitionRejected(
  descriptor: object,
  railId = "x402:default",
) {
  const entry = await signComponentArtifact(
    descriptor,
    "dacs-rail:v1:",
    {
      algorithm: "ed25519",
      signer: stewardSigner,
      sign: signerFor(STEWARD_SEED),
    },
  );
  await expect(
    resolveRail(RAIL_REGISTRY_INDEX_ADDRESS, railId, depsFor({ entries: [entry] })),
  ).rejects.toThrow();
}

async function authenticatedRail(descriptor: UnsignedRailDefinition) {
  const entry = await signedRail(descriptor);
  return resolveRail(RAIL_REGISTRY_INDEX_ADDRESS, {
    railId: descriptor.railId,
    railVersion: descriptor.railVersion,
  }, depsFor({ entries: [entry] }));
}

function railRef(
  locator: string,
  value: Record<string, unknown>,
  logicalAddress = locator,
): RailRegistryDefinitionRef {
  return {
    logicalAddress,
    anchor: { kind: "storage-program", locator },
    contentHash: contentHash(value),
  };
}

function railReceipt(
  ref: RailRegistryDefinitionRef,
  patch: Partial<AnchorReceipt> = {},
): AnchorReceipt {
  return {
    receiptVersion: "1",
    substrate: "test-substrate",
    finalityProfile: "instant-finality",
    logicalAddress: RAIL_REGISTRY_INDEX_ADDRESS,
    nativeAddress: ref.anchor.locator,
    contentHash: ref.contentHash,
    transactionRef: { kind: "test", value: `tx:${ref.contentHash}` },
    writer: stewardSigner,
    state: "finalized",
    observationDisposition: "established",
    observedAt: 1_780_000_100_000,
    blockRef: { id: "block:1", height: "1" },
    evidence: { kind: "test-proof", value: `proof:${ref.contentHash}` },
    ...patch,
  };
}

interface RailProviderFixture {
  provider: RailRegistrySelectionProvider;
  index: RailRegistryIndexDocument;
  indexRef: RailRegistryDefinitionRef;
  current: {
    registryVersion: number;
    indexRef: RailRegistryDefinitionRef;
    receipt: AnchorReceipt;
  };
  documents: Map<string, Record<string, unknown>>;
  definitionReceipts: Map<string, AnchorReceipt>;
}

function railProviderFixture(
  doc: Record<string, unknown> | null,
): RailProviderFixture {
  const entries = doc?.entries;
  const definitions = Array.isArray(entries)
    ? entries as Record<string, unknown>[]
    : [];
  const documents = new Map<string, Record<string, unknown>>();
  const definitionReceipts = new Map<string, AnchorReceipt>();
  const refs = definitions.map((definition, index) => {
    const logicalAddress = `dacs4:rail:${index}`;
    const ref = railRef(
      `rail:${index}:${contentHash(definition)}`,
      definition,
      logicalAddress,
    );
    documents.set(ref.anchor.locator, definition);
    definitionReceipts.set(ref.anchor.locator, railReceipt(ref, {
      logicalAddress,
    }));
    return ref;
  });
  const index: RailRegistryIndexDocument = {
    registryId: RAIL_REGISTRY_INDEX_ADDRESS,
    entries: refs,
  };
  const indexRef = railRef(
    `rail:index:${contentHash(index as unknown as Record<string, unknown>)}`,
    index as unknown as Record<string, unknown>,
    RAIL_REGISTRY_INDEX_ADDRESS,
  );
  documents.set(indexRef.anchor.locator, index as unknown as Record<string, unknown>);
  const current = {
    registryVersion: 7,
    indexRef,
    receipt: railReceipt(indexRef),
  };
  return {
    index,
    indexRef,
    current,
    documents,
    definitionReceipts,
    provider: {
      resolveCurrentIndex: async () => doc === null ? null : current,
      authenticateCurrentIndex: () => "valid",
      readAnchoredJson: async (ref) =>
        documents.get(ref.anchor.locator) ?? null,
      resolveDefinitionReceipt: async (ref) =>
        definitionReceipts.get(ref.anchor.locator) ?? null,
      authenticateDefinition: () => "valid",
      stewardWriter: stewardSigner,
      stewardPublicKey,
      stewardSigner,
      verify,
    },
  };
}

function depsFor(
  doc: Record<string, unknown> | null,
): RegistryResolveDeps & RailRegistrySelectionProvider {
  let railFixture: RailProviderFixture | undefined;
  const currentRailFixture = () =>
    railFixture ??= railProviderFixture(doc);
  return {
    resolveCurrentIndex: (address) =>
      currentRailFixture().provider.resolveCurrentIndex(address),
    authenticateCurrentIndex: (input) =>
      currentRailFixture().provider.authenticateCurrentIndex(input),
    readAnchoredJson: (ref) =>
      currentRailFixture().provider.readAnchoredJson(ref),
    resolveDefinitionReceipt: (ref) =>
      currentRailFixture().provider.resolveDefinitionReceipt(ref),
    authenticateDefinition: (input) =>
      currentRailFixture().provider.authenticateDefinition(input),
    stewardWriter: stewardSigner,
    readRegistry: async () => doc,
    stewardPublicKey,
    stewardSigner,
    verify,
  };
}

function normativeRecipe(
  over: Partial<RecipeDescriptor> = {},
): RecipeDescriptor {
  return {
    recipeVersion: 1,
    scheme: "key",
    defaultMethod: { kind: "self-signed" },
    defaultMaxAgeSec: 3_600,
    parserRules: { format: "raw", matcher: "present" },
    retryClass: "permanent",
    availability: "live",
    governance: {
      proposedBy: stewardSigner,
      acceptedAt: 1_780_000_000_000,
      anchoring: "single-signer",
    },
    ...over,
  };
}

async function signedRecipe(
  descriptor: object,
  seed = STEWARD_SEED,
) {
  return signComponentArtifact(descriptor, "dacs-recipe:v1:", {
    algorithm: "ed25519",
    signer: stewardSigner,
    sign: signerFor(seed),
  });
}

async function expectRecipeEntryRejected(
  entry: object,
  method: Parameters<typeof resolveRecipe>[1]["method"] = "self-signed",
) {
  const doc = {
    registryId: "dacs2:registry:v0.1",
    version: "0.1",
    entries: [entry],
  } as Record<string, unknown>;
  await expect(
    resolveRecipe(
      "anchor",
      { scheme: "key", method, recipeVersion: 1 },
      depsFor(doc),
    ),
  ).rejects.toThrow();
}

describe("registry resolution (T12/T13)", () => {
  test("resolves a live, steward-signed rail by id", async () => {
    const desc = await resolveRail(RAIL_REGISTRY_INDEX_ADDRESS, "x402:default", depsFor(await railRegistry()));
    expect(desc).toMatchObject({
      railId: "x402:default",
      railType: "x402",
      railVersion: 1,
      availability: "live",
    });
    expect(desc.parameters).toEqual({ authorization: "eip-3009" });
  });

  test("retains exact canonical index and definition provenance out of band", async () => {
    const entry = await signedRail(x402Definition());
    const fixture = railProviderFixture({ entries: [entry] });
    let authorityInput: Parameters<
      RailRegistrySelectionProvider["authenticateCurrentIndex"]
    >[0] | undefined;
    fixture.provider.authenticateCurrentIndex = (input) => {
      authorityInput = input;
      return "valid";
    };
    const descriptor = await resolveRail(
      RAIL_REGISTRY_INDEX_ADDRESS,
      "x402:default",
      fixture.provider,
    );
    const provenance = getAuthenticatedRailProvenance(descriptor);

    expect(provenance).toMatchObject({
      logicalAddress: RAIL_REGISTRY_INDEX_ADDRESS,
      registryVersion: fixture.current.registryVersion,
      indexRef: fixture.indexRef,
      indexContentHash: fixture.indexRef.contentHash,
      definitionRef: fixture.index.entries[0],
      definitionContentHash: fixture.index.entries[0]!.contentHash,
      writer: stewardSigner,
      indexReceipt: {
        state: "finalized",
        observationDisposition: "established",
      },
      definitionReceipt: {
        state: "finalized",
        observationDisposition: "established",
      },
    });
    expect(Object.isFrozen(provenance)).toBe(true);
    expect(Object.isFrozen(provenance!.indexReceipt)).toBe(true);
    expect(Object.isFrozen(provenance!.definitionReceipt)).toBe(true);
    expect(authorityInput).toMatchObject({
      logicalAddress: RAIL_REGISTRY_INDEX_ADDRESS,
      registryVersion: fixture.current.registryVersion,
      indexRef: fixture.indexRef,
      receipt: fixture.current.receipt,
      index: fixture.index,
    });
    expect(Object.isFrozen(authorityInput)).toBe(true);
    expect(Object.isFrozen(authorityInput!.index)).toBe(true);
    expect(getAuthenticatedRailProvenance(structuredClone(descriptor))).toBeNull();
  });

  test("rejects a validly signed finalized stale cache as non-current authority", async () => {
    const staleEntry = await signedRail(x402Definition());
    const currentV2 = await signedRail(x402Definition({
      railVersion: 2,
      governance: {
        ...RAIL_GOVERNANCE,
        acceptedAt: RAIL_GOVERNANCE.acceptedAt + 1,
        supersedes: 1,
      },
    }));
    const stale = railProviderFixture({ entries: [staleEntry] });
    const authoritative = railProviderFixture({
      entries: [staleEntry, currentV2],
    });
    stale.provider.authenticateCurrentIndex = (input) =>
      input.registryVersion === authoritative.current.registryVersion &&
      input.indexRef.contentHash === authoritative.indexRef.contentHash
        ? "valid"
        : "invalid";

    await expect(resolveRail(
      RAIL_REGISTRY_INDEX_ADDRESS,
      "x402:default",
      stale.provider,
    )).rejects.toThrow(/authority is invalid or unauthenticated/);
  });

  test("requires an exact finalized established SR-2 index receipt", async () => {
    const entry = await signedRail(x402Definition());
    const included = railProviderFixture({ entries: [entry] });
    included.current.receipt.state = "included";
    await expect(resolveRail(
      RAIL_REGISTRY_INDEX_ADDRESS,
      "x402:default",
      included.provider,
    )).rejects.toMatchObject({
      category: "substrate",
      message: expect.stringMatching(/does not yet have an established finalized/),
    });

    const indeterminate = railProviderFixture({ entries: [entry] });
    indeterminate.provider.authenticateCurrentIndex = () => "indeterminate";
    await expect(resolveRail(
      RAIL_REGISTRY_INDEX_ADDRESS,
      "x402:default",
      indeterminate.provider,
    )).rejects.toThrow(/authority is indeterminate/);
  });

  test("requires independently resolved finalized definition anchoring", async () => {
    const entry = await signedRail(x402Definition());

    for (const state of ["included", "reorged"] as const) {
      const fixture = railProviderFixture({ entries: [entry] });
      fixture.definitionReceipts.get(
        fixture.index.entries[0]!.anchor.locator,
      )!.state = state;
      await expect(resolveRail(
        RAIL_REGISTRY_INDEX_ADDRESS,
        "x402:default",
        fixture.provider,
      )).rejects.toMatchObject({
        category: "substrate",
        message: expect.stringMatching(/does not yet have an established finalized/),
      });
    }

    const indeterminate = railProviderFixture({ entries: [entry] });
    const indeterminateReceipt = indeterminate.definitionReceipts.get(
      indeterminate.index.entries[0]!.anchor.locator,
    )!;
    indeterminateReceipt.observationDisposition = "indeterminate";
    indeterminateReceipt.preservedReceiptHash = "ab".repeat(32);
    await expect(resolveRail(
      RAIL_REGISTRY_INDEX_ADDRESS,
      "x402:default",
      indeterminate.provider,
    )).rejects.toMatchObject({
      category: "substrate",
      message: expect.stringMatching(/does not yet have an established finalized/),
    });

    const cacheOnly = railProviderFixture({ entries: [entry] });
    cacheOnly.definitionReceipts.clear();
    await expect(resolveRail(
      RAIL_REGISTRY_INDEX_ADDRESS,
      "x402:default",
      cacheOnly.provider,
    )).rejects.toThrow(/receipt resolution is unresolved/);
  });

  test("rejects mismatched or unauthenticated definition receipt bindings", async () => {
    const entry = await signedRail(x402Definition());
    const mutations: Array<(receipt: AnchorReceipt) => void> = [
      (receipt) => { receipt.logicalAddress = "dacs4:rail:attacker"; },
      (receipt) => { receipt.nativeAddress = "rail:attacker"; },
      (receipt) => { receipt.contentHash = "cd".repeat(32); },
      (receipt) => {
        receipt.writer = `did:demos:agent:${"dd".repeat(32)}`;
      },
    ];
    for (const mutate of mutations) {
      const fixture = railProviderFixture({ entries: [entry] });
      mutate(fixture.definitionReceipts.get(
        fixture.index.entries[0]!.anchor.locator,
      )!);
      await expect(resolveRail(
        RAIL_REGISTRY_INDEX_ADDRESS,
        "x402:default",
        fixture.provider,
      )).rejects.toMatchObject({
        category: "permanent",
        message: expect.stringMatching(/contradicts its canonical/),
      });
    }

    const unauthenticated = railProviderFixture({ entries: [entry] });
    unauthenticated.provider.authenticateDefinition = () => "invalid";
    await expect(resolveRail(
      RAIL_REGISTRY_INDEX_ADDRESS,
      "x402:default",
      unauthenticated.provider,
    )).rejects.toThrow(/definition authority is invalid or unauthenticated/);

    const unavailableProof = railProviderFixture({ entries: [entry] });
    unavailableProof.provider.authenticateDefinition = () => "indeterminate";
    await expect(resolveRail(
      RAIL_REGISTRY_INDEX_ADDRESS,
      "x402:default",
      unavailableProof.provider,
    )).rejects.toThrow(/definition authority is indeterminate/);

    for (const mutate of [
      (receipt: AnchorReceipt) => {
        receipt.transactionRef = { kind: "test", value: "tx:attacker" };
      },
      (receipt: AnchorReceipt) => { receipt.nonce = "attacker-nonce"; },
    ]) {
      const authenticatedTuple = railProviderFixture({ entries: [entry] });
      const receipt = authenticatedTuple.definitionReceipts.get(
        authenticatedTuple.index.entries[0]!.anchor.locator,
      )!;
      const expectedTransaction = structuredClone(receipt.transactionRef);
      const expectedNonce = receipt.nonce;
      authenticatedTuple.provider.authenticateDefinition = (input) =>
        input.receipt.transactionRef.kind === expectedTransaction.kind &&
        input.receipt.transactionRef.value === expectedTransaction.value &&
        input.receipt.nonce === expectedNonce
          ? "valid"
          : "invalid";
      mutate(receipt);
      await expect(resolveRail(
        RAIL_REGISTRY_INDEX_ADDRESS,
        "x402:default",
        authenticatedTuple.provider,
      )).rejects.toThrow(/definition authority is invalid or unauthenticated/);
    }
  });

  test("retains authenticated additive v0.x definition receipt fields", async () => {
    const entry = await signedRail(x402Definition());
    const fixture = railProviderFixture({ entries: [entry] });
    const receipt = fixture.definitionReceipts.get(
      fixture.index.entries[0]!.anchor.locator,
    )! as AnchorReceipt & { bindingExtension?: { quorum: number } };
    receipt.bindingExtension = { quorum: 3 };

    const descriptor = await resolveRail(
      RAIL_REGISTRY_INDEX_ADDRESS,
      "x402:default",
      fixture.provider,
    );
    expect(getAuthenticatedRailProvenance(descriptor)?.definitionReceipt)
      .toMatchObject({ bindingExtension: { quorum: 3 } });
  });

  test("refuses non-canonical registry addresses before invoking the provider", async () => {
    const entry = await signedRail(x402Definition());
    const fixture = railProviderFixture({ entries: [entry] });
    const resolveCurrentIndex = vi.spyOn(
      fixture.provider,
      "resolveCurrentIndex",
    );
    await expect(resolveRail(
      "cache:dacs4:registry:v0.1",
      "x402:default",
      fixture.provider,
    )).rejects.toThrow(/requires canonical index dacs4:registry:v0.1/);
    expect(resolveCurrentIndex).not.toHaveBeenCalled();
  });

  test("ignores poisoned bind properties on registry authority callbacks", async () => {
    const entry = await signedRail(x402Definition());
    const fixture = railProviderFixture({ entries: [entry] });
    const poisons = [
      fixture.provider.resolveCurrentIndex,
      fixture.provider.authenticateCurrentIndex,
      fixture.provider.readAnchoredJson,
      fixture.provider.resolveDefinitionReceipt,
      fixture.provider.authenticateDefinition,
      fixture.provider.verify,
    ].map((callback) => {
      const poison = vi.fn(() => vi.fn(() => {
        throw new Error("poisoned bind callback executed");
      }));
      Object.defineProperty(callback, "bind", {
        configurable: true,
        value: poison,
      });
      return poison;
    });

    await expect(resolveRail(
      RAIL_REGISTRY_INDEX_ADDRESS,
      "x402:default",
      fixture.provider,
    )).resolves.toMatchObject({ railId: "x402:default" });
    for (const poison of poisons) expect(poison).not.toHaveBeenCalled();
  });

  test("authenticates non-live entries so RAV policy can run at point of use", async () => {
    await expect(
      resolveRail(RAIL_REGISTRY_INDEX_ADDRESS, "x402:old", depsFor(await railRegistry())),
    ).resolves.toMatchObject({
      railId: "x402:old",
      availability: "disabled",
    });
  });

  test("rejects an entry not signed by the steward (recipe-poisoning)", async () => {
    const forged = await signedRail(evmDefinition(), IMPOSTOR_SEED);
    await expect(
      resolveRail(
        RAIL_REGISTRY_INDEX_ADDRESS,
        "evm-erc20:84532:USDC",
        depsFor({ entries: [forged] }),
      ),
    ).rejects.toThrow(/steward key/);
  });

  test("rejects an unknown id", async () => {
    await expect(
      resolveRail(RAIL_REGISTRY_INDEX_ADDRESS, "nope", depsFor(await railRegistry())),
    ).rejects.toThrow(/not found in canonical rail registry/);
  });

  test("rejects a missing registry", async () => {
    await expect(resolveRail(RAIL_REGISTRY_INDEX_ADDRESS, "x402:default", depsFor(null))).rejects.toThrow(
      /current-index lookup is unresolved/,
    );
  });

  test("tampered entry params fail steward verification", async () => {
    const doc = await railRegistry();
    const entries = doc["entries"] as Array<Record<string, unknown>>;
    entries[0]!.parameters = { authorization: "tampered" }; // mutate after signing
    await expect(resolveRail(RAIL_REGISTRY_INDEX_ADDRESS, "x402:default", depsFor(doc))).rejects.toThrow(
      /steward key/,
    );
  });

  test("selects the latest authenticated rail version and honours an exact pin", async () => {
    const v1 = await signedRail(x402Definition());
    const v2 = await signedRail(x402Definition({
      railVersion: 2,
      parameters: { authorization: "permit2" },
      governance: {
        ...RAIL_GOVERNANCE,
        acceptedAt: RAIL_GOVERNANCE.acceptedAt + 1,
        supersedes: 1,
      },
    }));
    const doc = { entries: [v2, v1] } as Record<string, unknown>;

    await expect(
      resolveRail(RAIL_REGISTRY_INDEX_ADDRESS, "x402:default", depsFor(doc)),
    ).resolves.toMatchObject({
      railVersion: 2,
      parameters: { authorization: "permit2" },
    });
    await expect(
      resolveRail(
        RAIL_REGISTRY_INDEX_ADDRESS,
        { railId: "x402:default", railVersion: 1 },
        depsFor(doc),
      ),
    ).resolves.toMatchObject({
      railVersion: 1,
      parameters: { authorization: "eip-3009" },
    });
    await expect(
      resolveRail(
        RAIL_REGISTRY_INDEX_ADDRESS,
        { railId: "x402:default", railVersion: 3 },
        depsFor(doc),
      ),
    ).rejects.toThrow(/resolved 0 definitions at version 3/);
  });

  test("authenticates the complete version family before resolving an exact pin", async () => {
    const v1 = await signedRail(x402Definition());
    const forgedV2 = await signedRail(x402Definition({
      railVersion: 2,
      governance: {
        ...RAIL_GOVERNANCE,
        acceptedAt: RAIL_GOVERNANCE.acceptedAt + 1,
        supersedes: 1,
      },
    }), IMPOSTOR_SEED);
    const doc = { entries: [v1, forgedV2] } as Record<string, unknown>;

    await expect(
      resolveRail(
        RAIL_REGISTRY_INDEX_ADDRESS,
        { railId: "x402:default", railVersion: 1 },
        depsFor(doc),
      ),
    ).rejects.toThrow(/signature is not valid under the steward key/);
  });

  test("rejects non-canonical rail selectors without invoking proxy traps", async () => {
    const entry = await signedRail(x402Definition());
    const doc = { entries: [entry] } as Record<string, unknown>;
    const getPrototypeOf = vi.fn(() => Object.prototype);
    const selector = new Proxy(
      { railId: "x402:default", railVersion: 1 },
      { getPrototypeOf },
    );

    await expect(
      resolveRail(RAIL_REGISTRY_INDEX_ADDRESS, selector, depsFor(doc)),
    ).rejects.toThrow(/selector must carry an exact canonical railId/);
    expect(getPrototypeOf).not.toHaveBeenCalled();
    await expect(
      resolveRail(
        RAIL_REGISTRY_INDEX_ADDRESS,
        { railId: "x402:default", railVersion: 1, trusted: true } as never,
        depsFor(doc),
      ),
    ).rejects.toThrow(/selector must carry an exact canonical railId/);
  });

  test.each([
    {
      label: "duplicate version",
      entries: async () => [
        await signedRail(x402Definition()),
        await signedRail(x402Definition({
          parameters: { authorization: "permit2" },
        })),
      ],
      pattern: /duplicate version/,
    },
    {
      label: "missing supersedes link",
      entries: async () => [
        await signedRail(x402Definition()),
        await signedRail(x402Definition({
          railVersion: 2,
          governance: {
            ...RAIL_GOVERNANCE,
            acceptedAt: RAIL_GOVERNANCE.acceptedAt + 1,
          },
        })),
      ],
      pattern: /supersession chain/,
    },
    {
      label: "phase-handler change",
      entries: async () => [
        await signedRail(x402Definition()),
        await signedRail(evmDefinition({
          railId: "x402:default",
          railVersion: 2,
          governance: {
            ...RAIL_GOVERNANCE,
            acceptedAt: RAIL_GOVERNANCE.acceptedAt + 1,
            supersedes: 1,
          },
        })),
      ],
      pattern: /changes phaseHandler.*RD-6/,
    },
    {
      label: "reversed signed publication order",
      entries: async () => [
        await signedRail(x402Definition()),
        await signedRail(x402Definition({
          railVersion: 2,
          governance: {
            ...RAIL_GOVERNANCE,
            acceptedAt: RAIL_GOVERNANCE.acceptedAt - 1,
            supersedes: 1,
          },
        })),
      ],
      pattern: /reverses signed acceptedAt ordering/,
    },
  ])("rejects a rail family with $label", async ({ entries, pattern }) => {
    await expect(
      resolveRail(
        RAIL_REGISTRY_INDEX_ADDRESS,
        "x402:default",
        depsFor({ entries: await entries() }),
      ),
    ).rejects.toThrow(pattern);
  });

  test.each([
    ["evm-erc20", evmDefinition()],
    ["solana-spl", solanaDefinition()],
    ["demos-native", demosDefinition()],
    ["ap2", ap2Definition()],
    ["cross-chain-htlc", crossChainDefinition("htlc")],
    ["cross-chain-liquidity-tank", crossChainDefinition("liquidity-tank")],
    ["cross-chain-substrate-native", crossChainDefinition("substrate-native")],
  ])("accepts an exact coherent %s definition", async (_label, definition) => {
    await expect(authenticatedRail(definition)).resolves.toMatchObject({
      railId: definition.railId,
      railType: definition.railType,
      phaseHandler: definition.phaseHandler,
    });
  });

  test("rejects validly signed malformed normative rail fields", async () => {
    const base = x402Definition();
    const malformed: object[] = [
      { ...base, unexpected: true },
      { ...base, railVersion: 0 },
      { ...base, railVersion: 1.5 },
      { ...base, railId: " x402:default" },
      { ...base, railId: "x402:é" },
      { ...base, railId: "x".repeat(65) },
      { ...base, railType: "invented" },
      { ...base, phaseHandler: "pay-evm-erc20" },
      { ...base, availability: "planned" },
      { ...base, asset: { ...base.asset, unexpected: true } },
      { ...base, asset: { kind: "native-dem", symbol: "DEM", decimals: 9 } },
      { ...base, network: { ...base.network, unexpected: true } },
      { ...base, network: { kind: "demos" } },
      { ...base, parameters: [] },
      { ...base, parameters: null },
      { ...base, governance: { ...base.governance, unexpected: true } },
      { ...base, governance: { ...base.governance, proposedBy: "not-a-claim" } },
      { ...base, governance: { ...base.governance, acceptedAt: -1 } },
      { ...base, governance: { ...base.governance, anchoring: "self-asserted" } },
      { ...base, governance: { ...base.governance, anchoring: "in-code" } },
      { ...base, governance: { ...base.governance, anchoring: "multisig" } },
      {
        ...base,
        governance: {
          ...base.governance,
          emergency: { isEmergency: false, failureObservation: "incident-1" },
        },
      },
      { ...base, governance: { ...base.governance, deprecated: true } },
      {
        ...base,
        governance: {
          ...base.governance,
          deprecated: true,
          deprecationReason: "",
        },
      },
    ];

    for (const definition of malformed) {
      const candidateRailId = (definition as { railId?: unknown }).railId;
      const railId = typeof candidateRailId === "string"
        ? candidateRailId
        : base.railId;
      await expectRailDefinitionRejected(definition, railId);
    }
  });

  test("rejects rail-specific asset/network incoherence under RD-5", async () => {
    const malformed: object[] = [
      evmDefinition({
        network: { kind: "evm", chainId: 1, rpcAttestation: "evm-rpc" },
      }),
      solanaDefinition({
        network: { kind: "solana", cluster: "mainnet" },
      }),
      demosDefinition({
        asset: { kind: "native-dem", symbol: "DEM", decimals: 8 } as never,
      }),
      demosDefinition({
        asset: { kind: "native-dem", symbol: "OS", decimals: 9 } as never,
      }),
      ap2Definition({ network: { kind: "demos" } }),
      crossChainDefinition("htlc", {
        network: { kind: "cross-chain", mechanism: "liquidity-tank" },
      }),
    ];
    for (const definition of malformed) {
      await expectRailDefinitionRejected(
        definition,
        (definition as { railId: string }).railId,
      );
    }
  });

  test("resolveRecipe verifies and pins the exact normative family", async () => {
    const recipe = await signedRecipe(normativeRecipe());
    const doc = {
      registryId: "dacs2:registry:v0.1",
      version: "0.1",
      entries: [recipe],
    } as Record<string, unknown>;
    const desc = await resolveRecipe(
      "anchor",
      { scheme: "key", method: "self-signed", recipeVersion: 1 },
      depsFor(doc),
    );
    expect(desc).toMatchObject({
      scheme: "key",
      recipeVersion: 1,
      defaultMethod: { kind: "self-signed" },
      availability: "live",
    });
    expect(Object.isFrozen(desc)).toBe(true);
  });

  test("resolveRecipe requires the session-start version pin", async () => {
    const v1 = await signedRecipe(normativeRecipe());
    const v2 = await signedRecipe(normativeRecipe({
      recipeVersion: 2,
      governance: {
        proposedBy: stewardSigner,
        acceptedAt: 1_780_000_001_000,
        anchoring: "single-signer",
        supersedes: 1,
      },
    }));
    const doc = {
      registryId: "dacs2:registry:v0.1",
      version: "0.1",
      entries: [v1, v2],
    } as Record<string, unknown>;

    await expect(
      resolveRecipe(
        "anchor",
        { scheme: "key", method: "self-signed" } as never,
        depsFor(doc),
      ),
    ).rejects.toThrow(/exact canonical scheme, method and version/);
    const pinned = await resolveRecipe(
      "anchor",
      { scheme: "key", method: "self-signed", recipeVersion: 1 },
      depsFor(doc),
    );
    expect(pinned.recipeVersion).toBe(1);
  });

  test("resolveRecipe accepts every exact VerificationMethod variant", async () => {
    const methods: RecipeDescriptor["defaultMethod"][] = [
      {
        kind: "verifiable-credential",
        issuerAllowList: ["did:demos:issuer"],
        schemaUrl: "https://schemas.example/credential",
      },
      {
        kind: "tlsnotary",
        endpoint: "https://authority.example/status",
        sessionTemplate: "authority-v1",
      },
      { kind: "zktls", provider: "reclaim", programId: "program-1" },
      {
        kind: "consensus-backed-proxy",
        endpoint: {
          method: "POST",
          urlTemplate: "https://authority.example/{identifier}",
          headers: { accept: "application/json" },
          body: "{\"id\":\"{identifier}\"}",
        },
      },
      {
        kind: "oauth-attested",
        provider: "stripe",
        scopes: ["read_profile"],
        maxTokenAgeSec: 300,
      },
      {
        kind: "evm-rpc",
        chainId: 1,
        contract: "0x1111111111111111111111111111111111111111",
        method: "ownerOf",
        args: [1, { blockTag: "latest", proof: [true, null] }],
      },
      { kind: "domain-tls-control", challengeType: "dns-01" },
      { kind: "self-signed" },
      { kind: "demos-gcr-domain" },
    ];

    for (const defaultMethod of methods) {
      const recipe = await signedRecipe(normativeRecipe({ defaultMethod }));
      const resolved = await resolveRecipe(
        "anchor",
        {
          scheme: "key",
          method: defaultMethod.kind,
          recipeVersion: 1,
        },
        depsFor({ entries: [recipe] }),
      );
      expect(resolved.defaultMethod).toEqual(defaultMethod);
    }
  });

  test("resolveRecipe accepts exact ParserSpec variants and non-live recipes for RAV audit", async () => {
    const parserRules: RecipeDescriptor["parserRules"][] = [
      {
        format: "json",
        successJsonPath: "$.data[0]",
        indeterminateOn: [{ jsonPath: "$.pending" }],
        dataMap: { name: "$.data[0].name" },
      },
      {
        format: "html",
        successSelector: ".active",
        indeterminateOn: [{ selector: ".pending" }],
        dataMap: { name: "h1" },
      },
      {
        format: "xml",
        successXPath: "/record/active",
        indeterminateOn: [{ xPath: "/record/pending" }],
        dataMap: { name: "/record/name" },
      },
      {
        format: "raw",
        matcher: "active",
        indeterminateOn: [{ matcher: "pending" }],
      },
    ];

    for (const parser of parserRules) {
      const recipe = await signedRecipe(
        normativeRecipe({ parserRules: parser, availability: "mocked" }),
      );
      const resolved = await resolveRecipe(
        "anchor",
        { scheme: "key", method: "self-signed", recipeVersion: 1 },
        depsFor({ entries: [recipe] }),
      );
      expect(resolved.parserRules).toEqual(parser);
      expect(resolved.availability).toBe("mocked");
    }
  });

  test("resolveRecipe rejects the auditor's combined validly-signed malformed recipe", async () => {
    const recipe = await signedRecipe({
      ...normativeRecipe(),
      defaultMethod: { kind: "self-signed", unexpected: "signed-extra" },
      parserRules: {
        format: "raw",
        matcher: "present",
        dataMap: { illegal: "$.x" },
        indeterminateOn: [null],
      },
      governance: {
        proposedBy: stewardSigner,
        acceptedAt: 1_780_000_000_000,
        anchoring: "single-signer",
        emergency: "malformed",
      },
    });

    await expectRecipeEntryRejected(recipe);
  });

  test("resolveRecipe rejects signed extras on every VerificationMethod variant", async () => {
    const methods: Array<
      [Parameters<typeof resolveRecipe>[1]["method"], Record<string, unknown>]
    > = [
      ["verifiable-credential", { kind: "verifiable-credential", unexpected: true }],
      ["tlsnotary", { kind: "tlsnotary", endpoint: "https://example", unexpected: true }],
      ["zktls", { kind: "zktls", provider: "reclaim", programId: "p", unexpected: true }],
      [
        "consensus-backed-proxy",
        {
          kind: "consensus-backed-proxy",
          endpoint: { method: "GET", urlTemplate: "https://example" },
          unexpected: true,
        },
      ],
      [
        "oauth-attested",
        {
          kind: "oauth-attested",
          provider: "p",
          scopes: [],
          maxTokenAgeSec: 1,
          unexpected: true,
        },
      ],
      [
        "evm-rpc",
        {
          kind: "evm-rpc",
          chainId: 1,
          contract: "0x1",
          method: "ownerOf",
          unexpected: true,
        },
      ],
      [
        "domain-tls-control",
        {
          kind: "domain-tls-control",
          challengeType: "http-01",
          unexpected: true,
        },
      ],
      ["self-signed", { kind: "self-signed", unexpected: true }],
      ["demos-gcr-domain", { kind: "demos-gcr-domain", unexpected: true }],
    ];

    for (const [method, defaultMethod] of methods) {
      const recipe = await signedRecipe({
        ...normativeRecipe(),
        defaultMethod,
      });
      await expectRecipeEntryRejected(recipe, method);
    }
  });

  test("resolveRecipe rejects wrong signed field types on every configured method", async () => {
    const methods: Array<
      [Parameters<typeof resolveRecipe>[1]["method"], Record<string, unknown>]
    > = [
      [
        "verifiable-credential",
        { kind: "verifiable-credential", issuerAllowList: [42] },
      ],
      ["tlsnotary", { kind: "tlsnotary", endpoint: 42 }],
      ["zktls", { kind: "zktls", provider: "reclaim", programId: 42 }],
      [
        "consensus-backed-proxy",
        {
          kind: "consensus-backed-proxy",
          endpoint: { method: "PUT", urlTemplate: "https://example" },
        },
      ],
      [
        "oauth-attested",
        {
          kind: "oauth-attested",
          provider: "p",
          scopes: [42],
          maxTokenAgeSec: 1,
        },
      ],
      [
        "evm-rpc",
        {
          kind: "evm-rpc",
          chainId: 1,
          contract: 42,
          method: "ownerOf",
        },
      ],
      [
        "domain-tls-control",
        { kind: "domain-tls-control", challengeType: "email-01" },
      ],
    ];

    for (const [method, defaultMethod] of methods) {
      const recipe = await signedRecipe({
        ...normativeRecipe(),
        defaultMethod,
      });
      await expectRecipeEntryRejected(recipe, method);
    }
  });

  test("resolveRecipe rejects malformed signed parser, retry and governance fields", async () => {
    const malformed: object[] = [
      { ...normativeRecipe(), unexpected: "signed-extra" },
      { ...normativeRecipe(), parserRules: { format: "raw", matcher: "ok", dataMap: {} } },
      {
        ...normativeRecipe(),
        parserRules: {
          format: "json",
          successJsonPath: "$.ok",
          indeterminateOn: [{ selector: ".wrong-kind" }],
        },
      },
      {
        ...normativeRecipe(),
        parserRules: {
          format: "html",
          successSelector: ".ok",
          indeterminateOn: [{ selector: ".pending", extra: true }],
        },
      },
      {
        ...normativeRecipe(),
        backoff: { strategy: "fixed", baseMs: 1, extra: true },
      },
      {
        ...normativeRecipe(),
        defaultMethod: {
          kind: "consensus-backed-proxy",
          endpoint: {
            method: "GET",
            urlTemplate: "https://example",
            extra: true,
          },
        },
      },
      { ...normativeRecipe(), retryBudget: -1 },
      { ...normativeRecipe(), scheme: "Key" },
      {
        ...normativeRecipe(),
        governance: {
          proposedBy: "not-a-claim-reference",
          acceptedAt: 1_780_000_000_000,
          anchoring: "single-signer",
        },
      },
      {
        ...normativeRecipe(),
        governance: {
          proposedBy: stewardSigner,
          acceptedAt: 1_780_000_000_000,
          anchoring: "single-signer",
          emergency: { isEmergency: false, failureObservation: "https://example" },
        },
      },
      {
        ...normativeRecipe(),
        governance: {
          proposedBy: stewardSigner,
          acceptedAt: 1_780_000_000_000,
          anchoring: "single-signer",
          extra: true,
        },
      },
      {
        ...normativeRecipe(),
        governance: {
          proposedBy: stewardSigner,
          acceptedAt: 1_780_000_000_000,
          anchoring: "single-signer",
          deprecated: true,
        },
      },
      {
        ...normativeRecipe(),
        governance: {
          proposedBy: stewardSigner,
          acceptedAt: 1_780_000_000_000,
          anchoring: "single-signer",
          deprecated: true,
          deprecationReason: "",
        },
      },
      {
        ...normativeRecipe(),
        governance: {
          proposedBy: stewardSigner,
          acceptedAt: 1_780_000_000_000,
          anchoring: "single-signer",
          supersedes: 1,
        },
      },
      {
        ...normativeRecipe(),
        alternatives: [{ kind: "self-signed" }],
      },
    ];

    for (const descriptor of malformed) {
      await expectRecipeEntryRejected(await signedRecipe(descriptor));
    }
  });

  test("resolveRecipe rejects wire-shape smuggling before snapshot normalisation", async () => {
    const mutations: Array<(entry: Record<string | symbol, unknown>) => void> = [
      (entry) => Object.setPrototypeOf(entry, { inherited: "poison" }),
      (entry) =>
        Object.defineProperty(entry, "scheme", {
          configurable: true,
          enumerable: true,
          get: () => "key",
        }),
      (entry) => {
        entry[Symbol("hidden")] = "poison";
      },
      (entry) =>
        Object.defineProperty(entry, "hidden", {
          configurable: true,
          enumerable: false,
          value: "poison",
        }),
      (entry) => {
        entry.alternatives = undefined;
      },
      (entry) => {
        entry.alternatives = new Array(1);
      },
      (entry) => {
        const method = entry.defaultMethod as Record<string, unknown>;
        Object.setPrototypeOf(method, { inherited: "poison" });
      },
      (entry) => {
        const signature = entry.signature as Record<string, unknown>;
        signature.unexpected = "signed-extra";
      },
    ];

    for (const mutate of mutations) {
      const recipe = (await signedRecipe(normativeRecipe())) as Record<
        string | symbol,
        unknown
      >;
      mutate(recipe);
      await expectRecipeEntryRejected(recipe);
    }
  });

  test("resolveRecipe rejects a hostile selector without invoking accessors", async () => {
    const recipe = await signedRecipe(normativeRecipe());
    const doc = {
      registryId: "dacs2:registry:v0.1",
      version: "0.1",
      entries: [recipe],
    } as Record<string, unknown>;
    let methodReads = 0;
    const selector: Record<string, unknown> = {
      scheme: "key",
      recipeVersion: 1,
    };
    Object.defineProperty(selector, "method", {
      enumerable: true,
      get: () => {
        methodReads += 1;
        return "self-signed";
      },
    });

    await expect(
      resolveRecipe(
        "anchor",
        selector as never,
        depsFor(doc),
      ),
    ).rejects.toThrow(/selector must be an exact canonical/);
    expect(methodReads).toBe(0);
    await expect(
      resolveRecipe(
        "anchor",
        {
          scheme: "key",
          method: "self-signed",
          recipeVersion: 1,
          trusted: true,
        } as never,
        depsFor(doc),
      ),
    ).rejects.toThrow(/selector must be an exact canonical/);
  });

  test("resolveRecipe rejects a selector pinned to another version", async () => {
    const recipe = await signedRecipe(normativeRecipe());
    const doc = {
      registryId: "dacs2:registry:v0.1",
      version: "0.1",
      entries: [recipe],
    } as Record<string, unknown>;

    await expect(
      resolveRecipe(
        "anchor",
        { scheme: "key", method: "self-signed", recipeVersion: 2 },
        depsFor(doc),
      ),
    ).rejects.toThrow(/resolved 0 exact entries; unambiguous family required/);
  });

  test("resolveRecipe rejects an entry not authenticated by the steward", async () => {
    const forged = await signedRecipe(normativeRecipe(), IMPOSTOR_SEED);
    const doc = {
      registryId: "dacs2:registry:v0.1",
      version: "0.1",
      entries: [forged],
    } as Record<string, unknown>;

    await expect(
      resolveRecipe(
        "anchor",
        { scheme: "key", method: "self-signed", recipeVersion: 1 },
        depsFor(doc),
      ),
    ).rejects.toThrow(/signature is not valid under the steward key/);
  });

  test("legacy registry signatures require an explicit policy and are normalised", async () => {
    const legacy = await buildSignedArtifact(
      x402Definition({ railId: "legacy" }),
      "dacs-rail:v1:",
      signerFor(STEWARD_SEED),
    );
    const doc = { entries: [legacy] } as Record<string, unknown>;

    await expect(resolveRail(RAIL_REGISTRY_INDEX_ADDRESS, "legacy", depsFor(doc))).rejects.toThrow(
      /legacy signature is rejected/,
    );
    const resolved = await resolveRail(RAIL_REGISTRY_INDEX_ADDRESS, "legacy", {
      ...depsFor(doc),
      legacySignatures: "verify-with-pinned-key",
    });
    expect(resolved.signature).toMatchObject({
      algorithm: "ed25519",
      signer: stewardSigner,
    });
    expect(resolved.signature.value).not.toMatch(/=/);
  });

  test("authenticates and returns one owned registry snapshot across async verification", async () => {
    const doc = await railRegistry();
    const entries = doc["entries"] as Array<Record<string, unknown>>;
    const sourceEntry = entries[0]!;
    const sourceParameters = sourceEntry["parameters"] as Record<string, unknown>;
    const resolutionDeps = depsFor(doc);
    resolutionDeps.verify = async (bytes, signature, key) => {
      sourceParameters["authorization"] = "caller-mutated";
      return verify(bytes, signature, key);
    };

    const resolved = await resolveRail(
      RAIL_REGISTRY_INDEX_ADDRESS,
      "x402:default",
      resolutionDeps,
    );
    expect(resolved.parameters).toEqual({ authorization: "eip-3009" });
    expect(resolved).not.toBe(sourceEntry);
    expect(resolved.parameters).not.toBe(sourceParameters);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.parameters)).toBe(true);
    expect(() => {
      resolved.parameters["authorization"] = "consumer-mutated";
    }).toThrow(TypeError);
    expect(sourceParameters["authorization"]).toBe("caller-mutated");
  });

  test("pins trust-root dependencies and key bytes before a delayed registry read", async () => {
    const doc = await railRegistry();
    const gate = deferred();
    const resolutionDeps = depsFor(doc);
    resolutionDeps.stewardPublicKey = Uint8Array.from(stewardPublicKey);
    const resolveCurrentIndex = resolutionDeps.resolveCurrentIndex;
    resolutionDeps.resolveCurrentIndex = async (address) => {
      await gate.promise;
      return resolveCurrentIndex(address);
    };
    const pending = resolveRail(RAIL_REGISTRY_INDEX_ADDRESS, "x402:default", resolutionDeps);

    resolutionDeps.stewardPublicKey.fill(0);
    resolutionDeps.stewardSigner = "did:demos:attacker";
    resolutionDeps.verify = () => false;
    resolutionDeps.authenticateCurrentIndex = () => "invalid";
    resolutionDeps.readAnchoredJson = async () => ({ attacker: true });
    resolutionDeps.resolveDefinitionReceipt = async () => null;
    resolutionDeps.authenticateDefinition = () => "invalid";
    resolutionDeps.legacySignatures = "reject";
    gate.resolve();

    await expect(pending).resolves.toMatchObject({ railId: "x402:default" });
  });

  test("uses the shared CF-3 identity comparator for steward authority", async () => {
    const signerWithRole = `${stewardSigner}?role=rail-steward`;
    const entry = await signComponentArtifact(
      x402Definition({ railId: "x402:parameterized-steward" }),
      "dacs-rail:v1:",
      {
        algorithm: "ed25519",
        signer: signerWithRole,
        sign: signerFor(STEWARD_SEED),
      },
    );
    const doc = { entries: [entry] } as Record<string, unknown>;

    await expect(
      resolveRail(RAIL_REGISTRY_INDEX_ADDRESS, "x402:parameterized-steward", {
        ...depsFor(doc),
        stewardSigner,
      }),
    ).resolves.toMatchObject({ railId: "x402:parameterized-steward" });
  });

  test("rejects non-canonical steward ClaimReferences through the shared parser", async () => {
    const entry = await signedRail(x402Definition());
    await expect(resolveRail(
      RAIL_REGISTRY_INDEX_ADDRESS,
      "x402:default",
      {
        ...depsFor({ entries: [entry] }),
        stewardSigner: `did:demos:steward:${"11".repeat(32)}`,
      },
    )).rejects.toThrow(/trust material is malformed/);
  });

  test("rejects a non-ASCII rail id even when the requested id normalises under CF-1", async () => {
    const nfdId = "x402:cafe\u0301";
    const nfcId = "x402:caf\u00e9";
    const entry = await signComponentArtifact(
      x402Definition({ railId: nfcId }),
      "dacs-rail:v1:",
      {
        algorithm: "ed25519",
        signer: stewardSigner,
        sign: signerFor(STEWARD_SEED),
      },
    );
    const doc = { entries: [entry] } as Record<string, unknown>;

    await expect(
      resolveRail(RAIL_REGISTRY_INDEX_ADDRESS, nfdId, depsFor(doc)),
    ).rejects.toThrow(/canonical non-empty railId/);
  });

  test("rejects accessor and proxy registry views without invoking their traps", async () => {
    const entry = await signedRail(x402Definition());
    const accessor = vi.fn(() => []);
    const accessorDoc = {} as Record<string, unknown>;
    Object.defineProperty(accessorDoc, "entries", {
      configurable: true,
      enumerable: true,
      get: accessor,
    });
    const accessorFixture = railProviderFixture({ entries: [entry] });
    const accessorRead = accessorFixture.provider.readAnchoredJson;
    accessorFixture.provider.readAnchoredJson = async (ref) =>
      ref.anchor.locator === accessorFixture.indexRef.anchor.locator
        ? accessorDoc
        : accessorRead(ref);
    await expect(resolveRail(
      RAIL_REGISTRY_INDEX_ADDRESS,
      "x402:default",
      accessorFixture.provider,
    )).rejects.toThrow(/not exact canonical JSON/);
    expect(accessor).not.toHaveBeenCalled();

    const ownKeys = vi.fn(() => ["entries"]);
    const proxyDoc = new Proxy({ entries: [] }, { ownKeys });
    const proxyFixture = railProviderFixture({ entries: [entry] });
    const proxyRead = proxyFixture.provider.readAnchoredJson;
    proxyFixture.provider.readAnchoredJson = async (ref) =>
      ref.anchor.locator === proxyFixture.indexRef.anchor.locator
        ? proxyDoc
        : proxyRead(ref);
    await expect(resolveRail(
      RAIL_REGISTRY_INDEX_ADDRESS,
      "x402:default",
      proxyFixture.provider,
    )).rejects.toThrow(/not exact canonical JSON/);
    expect(ownKeys).not.toHaveBeenCalled();
  });
});

describe("authenticated normative rail dispatch (T6 / RAV-R5)", () => {
  const paywall = {
    url: "https://seller.example/deliver",
    network: "eip155:84532",
    recipientEvm: "0x1111111111111111111111111111111111111111",
  };

  test("x402 dispatches only from an authenticated normative definition", async () => {
    const descriptor = await authenticatedRail(x402Definition());
    const settle = await settleFromRail(descriptor, {
      evmPrivateKey: TEST_EVM_KEY,
      paywall,
    });
    expect(typeof settle).toBe("function");
  });

  test("rejects an unbranded structural copy before constructing a rail", async () => {
    const entry = await signedRail(x402Definition());
    await expect(
      settleFromRail(entry as never, { evmPrivateKey: TEST_EVM_KEY, paywall }),
    ).rejects.toThrow(/resolveRail \(RAV-R5\)/);
  });

  test("x402 refuses a resource outside the authenticated network base", async () => {
    const descriptor = await authenticatedRail(x402Definition());
    await expect(
      settleFromRail(descriptor, {
        evmPrivateKey: TEST_EVM_KEY,
        paywall: { ...paywall, url: "https://attacker.example/deliver" },
      }),
    ).rejects.toThrow(/outside authenticated base/);
  });

  test("evm-erc20 derives token and network from the signed definition", async () => {
    const descriptor = await authenticatedRail(evmDefinition());
    const settle = await settleFromRail(descriptor, {
      evmPrivateKey: TEST_EVM_KEY,
      paywall,
      rpcUrl: "https://sepolia.base.org",
    });
    expect(typeof settle).toBe("function");
  });

  test("evm-erc20 rejects a caller network that conflicts with the definition", async () => {
    const descriptor = await authenticatedRail(evmDefinition());
    await expect(
      settleFromRail(descriptor, {
        evmPrivateKey: TEST_EVM_KEY,
        payment: {
          network: "eip155:1",
          recipient: paywall.recipientEvm,
        },
        rpcUrl: "https://sepolia.base.org",
      }),
    ).rejects.toThrow(/does not match authenticated rail network/);
  });

  test("evm-erc20 without an rpc url is rejected", async () => {
    const descriptor = await authenticatedRail(evmDefinition());
    await expect(
      settleFromRail(descriptor, { evmPrivateKey: TEST_EVM_KEY, paywall }),
    ).rejects.toThrow(/rpcUrl/);
  });

  test("pay-DEM needs only Demos credentials, not EVM or HTTP coordinates", async () => {
    const descriptor = await authenticatedRail(demosDefinition());
    await expect(settleFromRail(descriptor, {})).rejects.toThrow(/demosRpc/);
    await expect(
      settleFromRail(descriptor, { demosRpc: "https://node.example" }),
    ).rejects.toThrow(/demosSecret/);
  });

  test("a valid but unimplemented normative rail fails closed", async () => {
    const descriptor = await authenticatedRail(solanaDefinition());
    await expect(settleFromRail(descriptor, {})).rejects.toThrow(
      /valid but not implemented/,
    );
  });
});
