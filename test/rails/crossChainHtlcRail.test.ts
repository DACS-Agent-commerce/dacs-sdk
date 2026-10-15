import { describe, expect, test } from "vitest";

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
  type AuthenticatedRailDefinition,
  type RailRegistryDefinitionRef,
  type RailRegistryIndexDocument,
  type RailRegistrySelectionProvider,
} from "../../src/registry/index.js";
import type { CrossChainRoute, RailDefinition } from "../../src/registry/types.js";
import { createCrossChainHtlcIntent } from "../../src/rails/crossChainHtlc.js";
import {
  crossChainHtlcAuthorityFromRail,
  type CrossChainHtlcRailSelection,
} from "../../src/rails/crossChainHtlcRail.js";

const STEWARD_SEED = Uint8Array.from(Buffer.alloc(32, 42));
const stewardPrivateKey = privateKeyFromSeed(STEWARD_SEED);
const stewardPublicKey = rawPublicKey(publicKeyFromSeed(STEWARD_SEED));
const stewardSigner = `did:demos:agent:${Buffer.from(stewardPublicKey).toString("hex")}`;
const AGREEMENT_HASH = "a".repeat(64);
const SALT = Uint8Array.from({ length: 16 }, () => 1);
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7F";

type UnsignedRailDefinition = Omit<RailDefinition, "signature">;

const SOURCE_CONTRACT = "0x1111111111111111111111111111111111111111";
const DEST_CONTRACT = "0x2222222222222222222222222222222222222222";

function htlcRoute(over: Partial<CrossChainRoute> = {}): CrossChainRoute {
  return {
    sourceChainId: 84532,
    destChainId: 80002,
    htlcContracts: { source: SOURCE_CONTRACT, dest: DEST_CONTRACT },
    ...over,
  };
}

function htlcDefinition(
  over: Partial<UnsignedRailDefinition> = {},
  routes: CrossChainRoute[] = [htlcRoute()],
): UnsignedRailDefinition {
  return {
    railVersion: 1,
    railId: "cross-chain-htlc:USDC",
    railType: "cross-chain-htlc",
    asset: { kind: "stablecoin-cross-chain", canonicalSymbol: "USDC", routes },
    network: { kind: "cross-chain", mechanism: "htlc" },
    phaseHandler: "pay-cross-chain-htlc",
    parameters: {
      timelockSourceSec: 500,
      timelockDestSec: 100,
      sourceFinalitySec: 20,
      safetyWindowSec: 10,
    },
    availability: "live",
    governance: {
      proposedBy: stewardSigner,
      acceptedAt: 1_780_000_000_000,
      anchoring: "single-signer",
    },
    ...over,
  };
}

async function authenticatedDefinition(
  definition: UnsignedRailDefinition,
): Promise<AuthenticatedRailDefinition> {
  const entry = await signComponentArtifact(definition, "dacs-rail:v1:", {
    algorithm: "ed25519",
    signer: stewardSigner,
    sign: (bytes) => ed25519Sign(bytes, stewardPrivateKey),
  });
  const definitionRef: RailRegistryDefinitionRef = {
    logicalAddress: `dacs4:rail:${definition.railId}:${definition.railVersion}`,
    anchor: { kind: "storage-program", locator: `rail:${definition.railId}` },
    contentHash: contentHash(entry as unknown as Record<string, unknown>),
  };
  const index: RailRegistryIndexDocument = {
    registryId: RAIL_REGISTRY_INDEX_ADDRESS,
    entries: [definitionRef],
  };
  const indexRef: RailRegistryDefinitionRef = {
    logicalAddress: RAIL_REGISTRY_INDEX_ADDRESS,
    anchor: { kind: "storage-program", locator: "rail:index:7" },
    contentHash: contentHash(index as unknown as Record<string, unknown>),
  };
  const receipt: AnchorReceipt = {
    receiptVersion: "1",
    substrate: "test-substrate",
    finalityProfile: "instant-finality",
    logicalAddress: RAIL_REGISTRY_INDEX_ADDRESS,
    nativeAddress: indexRef.anchor.locator,
    contentHash: indexRef.contentHash,
    transactionRef: { kind: "test", value: `tx:${indexRef.contentHash}` },
    writer: stewardSigner,
    state: "finalized",
    observationDisposition: "established",
    observedAt: 1_780_000_100_000,
    blockRef: { id: "block:7", height: "7" },
    evidence: { kind: "test-proof", value: `proof:${indexRef.contentHash}` },
  };
  const definitionReceipt: AnchorReceipt = {
    ...receipt,
    logicalAddress: definitionRef.logicalAddress,
    nativeAddress: definitionRef.anchor.locator,
    contentHash: definitionRef.contentHash,
    transactionRef: { kind: "test", value: `tx:${definitionRef.contentHash}` },
    evidence: { kind: "test-proof", value: `proof:${definitionRef.contentHash}` },
  };
  const deps: RailRegistrySelectionProvider = {
    resolveCurrentIndex: async () => ({ registryVersion: 7, indexRef, receipt }),
    authenticateCurrentIndex: () => "valid",
    readAnchoredJson: async (ref) => {
      if (ref.anchor.locator === indexRef.anchor.locator) {
        return index as unknown as Record<string, unknown>;
      }
      return ref.anchor.locator === definitionRef.anchor.locator
        ? entry as unknown as Record<string, unknown>
        : null;
    },
    resolveDefinitionReceipt: async (ref) =>
      ref.anchor.locator === definitionRef.anchor.locator ? definitionReceipt : null,
    authenticateDefinition: () => "valid",
    stewardWriter: stewardSigner,
    stewardPublicKey,
    stewardSigner,
    verify: (bytes, signature, publicKey) =>
      ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
  };
  return resolveRail(RAIL_REGISTRY_INDEX_ADDRESS, {
    railId: definition.railId,
    railVersion: definition.railVersion,
  }, deps);
}

function selection(over: Partial<CrossChainHtlcRailSelection> = {}): CrossChainHtlcRailSelection {
  return {
    sourceChainId: 84532,
    destinationChainId: 80002,
    jobId: JOB_ID,
    phaseIndex: 2,
    agreementHash: AGREEMENT_HASH,
    amount: "1.25",
    currency: "USDC",
    sourceTokenId: "source-usdc-token",
    destinationTokenId: "destination-usdc-token",
    sourceTokenDecimals: 6,
    destinationTokenDecimals: 6,
    payerSourceAddress: "payer-source",
    payerDestinationAddress: "payer-destination",
    payeeSourceAddress: "payee-source",
    payeeDestinationAddress: "payee-destination",
    destinationFinalitySec: 15,
    ...over,
  };
}

const hashlocks = {
  deriveHashlock({ chainId, preimage }: { chainId: number; preimage: Uint8Array }): string {
    return `${chainId}:${Buffer.from(preimage).toString("hex")}`;
  },
};

describe("crossChainHtlcAuthorityFromRail", () => {
  test("maps the pinned rail's Standard names and the selected route onto the authority", async () => {
    const rail = await authenticatedDefinition(htlcDefinition());
    const authority = crossChainHtlcAuthorityFromRail(rail, selection());
    expect(authority).toEqual({
      jobId: JOB_ID,
      phaseIndex: 2,
      railId: "cross-chain-htlc:USDC",
      railDescriptorHash: contentHash(rail as unknown as Record<string, unknown>),
      agreementHash: AGREEMENT_HASH,
      assetKind: "stablecoin-cross-chain",
      networkKind: "cross-chain",
      mechanism: "htlc",
      sourceChainId: 84532,
      destinationChainId: 80002,
      sourceAsset: "USDC",
      destinationAsset: "USDC",
      sourceTokenId: "source-usdc-token",
      destinationTokenId: "destination-usdc-token",
      sourceTokenDecimals: 6,
      destinationTokenDecimals: 6,
      amount: "1.25",
      currency: "USDC",
      payerSourceAddress: "payer-source",
      payerDestinationAddress: "payer-destination",
      payeeSourceAddress: "payee-source",
      payeeDestinationAddress: "payee-destination",
      sourceContractAddress: SOURCE_CONTRACT,
      destinationContractAddress: DEST_CONTRACT,
      sourceFinalitySec: 20,
      destinationFinalitySec: 15,
      safetyWindowSec: 10,
      sourceTimelockSec: 500,
      destinationTimelockSec: 100,
    });
    expect(Object.isFrozen(authority)).toBe(true);
    expect(authority.railDescriptorHash).toBe(
      getAuthenticatedRailProvenance(rail)?.definitionContentHash,
    );
    const { intent } = createCrossChainHtlcIntent(authority, SALT, hashlocks);
    expect(intent).toMatchObject({
      railId: "cross-chain-htlc:USDC",
      railDescriptorHash: authority.railDescriptorHash,
      sourceTimelockSec: 500,
      destinationTimelockSec: 100,
      sourceContractAddress: SOURCE_CONTRACT,
      destinationContractAddress: DEST_CONTRACT,
    });
  });

  test("refuses a structural copy of an authenticated rail (RAV-R5)", async () => {
    const rail = await authenticatedDefinition(htlcDefinition());
    const copy = JSON.parse(JSON.stringify(rail)) as AuthenticatedRailDefinition;
    expect(() => crossChainHtlcAuthorityFromRail(copy, selection())).toThrow(/resolveRail \(RAV-R5\)/);
  });

  test("selects exactly the route the agreement names, with no aliases", async () => {
    const other = htlcRoute({
      sourceChainId: 1,
      destChainId: 137,
      htlcContracts: { source: "0x3333333333333333333333333333333333333333", dest: "0x4444444444444444444444444444444444444444" },
    });
    const rail = await authenticatedDefinition(htlcDefinition({}, [other, htlcRoute()]));
    expect(crossChainHtlcAuthorityFromRail(rail, selection())).toMatchObject({
      sourceChainId: 84532,
      destinationChainId: 80002,
      sourceContractAddress: SOURCE_CONTRACT,
      destinationContractAddress: DEST_CONTRACT,
    });
    expect(crossChainHtlcAuthorityFromRail(rail, selection({ sourceChainId: 1, destinationChainId: 137 })))
      .toMatchObject({
        sourceContractAddress: "0x3333333333333333333333333333333333333333",
        destinationContractAddress: "0x4444444444444444444444444444444444444444",
      });
    for (const [sourceChainId, destinationChainId] of [
      ["84532", 80002],
      [84532, "80002"],
      [80002, 84532],
      [84532, 137],
    ] as const) {
      expect(() => crossChainHtlcAuthorityFromRail(rail, selection({ sourceChainId, destinationChainId })))
        .toThrow(/has no route/);
    }
  });

  test("refuses a rail with two routes for the same chain pair", async () => {
    const rail = await authenticatedDefinition(htlcDefinition({}, [
      htlcRoute(),
      htlcRoute({ htlcContracts: { source: "0x5555555555555555555555555555555555555555", dest: DEST_CONTRACT } }),
    ]));
    expect(() => crossChainHtlcAuthorityFromRail(rail, selection())).toThrow(/more than one route/);
  });

  test.each([
    ["a string destination", { sourceChainId: 11155111, destChainId: "solana-devnet" }],
    ["a string source", { sourceChainId: "solana-devnet", destChainId: 11155111 }],
    ["a numeric string", { sourceChainId: "84532", destChainId: 80002 }],
  ] as const)("refuses %s chain id outside the numeric profile instead of aliasing it", async (_label, ids) => {
    const rail = await authenticatedDefinition(htlcDefinition({}, [htlcRoute(ids)]));
    expect(() => crossChainHtlcAuthorityFromRail(rail, selection({
      sourceChainId: ids.sourceChainId,
      destinationChainId: ids.destChainId,
    }))).toThrow(/outside the core's numeric-chain profile/);
  });

  test("refuses a route without HTLC contracts", async () => {
    const rail = await authenticatedDefinition(htlcDefinition({}, [{ sourceChainId: 84532, destChainId: 80002 }]));
    expect(() => crossChainHtlcAuthorityFromRail(rail, selection())).toThrow(/has no htlcContracts/);
  });

  test.each([
    "timelockSourceSec",
    "timelockDestSec",
    "sourceFinalitySec",
    "safetyWindowSec",
  ] as const)("refuses a rail whose parameters.%s is missing or not a positive safe integer", async (name) => {
    for (const value of [undefined, 0, -1, 1.5, "500", null]) {
      const parameters: Record<string, unknown> = { ...htlcDefinition().parameters };
      if (value === undefined) delete parameters[name];
      else parameters[name] = value;
      const rail = await authenticatedDefinition(htlcDefinition({ parameters }));
      expect(() => crossChainHtlcAuthorityFromRail(rail, selection()))
        .toThrow(new RegExp(`parameters\\.${name} must be a positive safe integer`));
    }
  });

  test("reads only the Standard parameter names, never the authority's", async () => {
    const rail = await authenticatedDefinition(htlcDefinition({
      parameters: {
        sourceTimelockSec: 500,
        destinationTimelockSec: 100,
        sourceFinalitySec: 20,
        safetyWindowSec: 10,
      },
    }));
    expect(() => crossChainHtlcAuthorityFromRail(rail, selection())).toThrow(/parameters\.timelockSourceSec/);
  });

  test("refuses an agreement currency other than the rail's canonical symbol", async () => {
    const rail = await authenticatedDefinition(htlcDefinition());
    expect(() => crossChainHtlcAuthorityFromRail(rail, selection({ currency: "USDT" })))
      .toThrow(/is not the rail's "USDC"/);
  });

  test("refuses a selection field the rail owns", async () => {
    const rail = await authenticatedDefinition(htlcDefinition());
    for (const field of ["sourceTimelockSec", "safetyWindowSec", "sourceContractAddress", "railDescriptorHash"]) {
      expect(() => crossChainHtlcAuthorityFromRail(rail, {
        ...selection(),
        [field]: 1,
      } as CrossChainHtlcRailSelection)).toThrow(new RegExp(`unknown field ${field}`));
    }
  });

  test("refuses a cross-chain rail of another mechanism", async () => {
    const rail = await authenticatedDefinition(htlcDefinition({
      railId: "cross-chain-liquidity-tank:USDC",
      railType: "cross-chain-liquidity-tank",
      network: { kind: "cross-chain", mechanism: "liquidity-tank" },
      phaseHandler: "pay-cross-chain-liquidity-tank",
    }, [{ sourceChainId: 84532, destChainId: 80002, liquidityTankIds: ["tank-1"] }]));
    expect(() => crossChainHtlcAuthorityFromRail(rail, selection())).toThrow(/is not a cross-chain HTLC rail/);
  });

  test.each(["disabled", "failed"] as const)("refuses a rail whose availability is %s (RAV-R2)", async (availability) => {
    const rail = await authenticatedDefinition(htlcDefinition({ availability }));
    expect(() => crossChainHtlcAuthorityFromRail(rail, selection())).toThrow(/RAV-R2/);
  });

  test("leaves HTLC-7 to the core: a rail without the margin resolves but is refused there", async () => {
    const rail = await authenticatedDefinition(htlcDefinition({
      parameters: { timelockSourceSec: 130, timelockDestSec: 100, sourceFinalitySec: 20, safetyWindowSec: 10 },
    }));
    const authority = crossChainHtlcAuthorityFromRail(rail, selection());
    expect(() => createCrossChainHtlcIntent(authority, SALT, hashlocks)).toThrow(/HTLC-7/);
  });
});
