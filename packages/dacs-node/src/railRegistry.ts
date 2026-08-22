import {
  RAIL_REGISTRY_INDEX_ADDRESS,
  ed25519Verify,
  publicKeyFromRaw,
  resolveRail,
  signComponentArtifact,
  type AuthenticatedRailDefinition,
  type CurrentRailRegistryIndex,
  type ProtocolAnchorReceipt,
  type RailDefinition,
  type RailRegistryAuthorityInput,
  type RailRegistryAuthorityVerification,
  type RailRegistryDefinitionAuthorityInput,
  type RailRegistryDefinitionRef,
  type RailRegistryIndexDocument,
  type RailRegistrySelectionProvider,
} from "@kynesyslabs/dacs";
import { canonicalize, contentHash } from "@kynesyslabs/dacs/canonical";
import {
  canonicalDemosAgentPublicKey,
  sameCanonicalClaimIdentity,
} from "@kynesyslabs/dacs/identity";

import type { DacsDemosActorRuntimeV1 } from "./demosRuntime.js";

/**
 * Demos-specific mutable/currentness binding for the normative immutable
 * `dacs4:registry:v0.1` index snapshot. Keeping this companion slot separate
 * lets the canonical index remain exact readable registry JSON while its
 * authenticated head can advance independently.
 */
export const DACS_DEMOS_RAIL_REGISTRY_CURRENT_BINDING_ADDRESS_V1 =
  `${RAIL_REGISTRY_INDEX_ADDRESS}:current` as const;

export interface DacsDemosRailRegistryProviderOptionsV1 {
  runtime: Readonly<DacsDemosActorRuntimeV1>;
  /** Canonical primary Demos ClaimRef controlling both SR-2 writes and RD-1. */
  stewardAuthority: string;
  stewardPublicKey: Uint8Array;
}

export class DacsDemosRailRegistryError extends Error {
  override readonly name = "DacsDemosRailRegistryError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

export interface BootstrapDacsDemosX402RailRegistryOptionsV1 {
  runtime: Readonly<DacsDemosActorRuntimeV1>;
  resourceBaseUrl: string;
  assetContract: string;
  acceptedAt: number;
  /** V1 is deliberately one exact Base Sepolia USDC registry bootstrap. */
  chainId?: 84532;
  finalityBlocks?: number;
}

export interface BootstrapDacsDemosX402RailRegistryResultV1 {
  rail: Readonly<AuthenticatedRailDefinition>;
  definitionRef: Readonly<RailRegistryDefinitionRef>;
  definitionReceipt: Readonly<ProtocolAnchorReceipt>;
  indexRef: Readonly<RailRegistryDefinitionRef>;
  indexReceipt: Readonly<ProtocolAnchorReceipt>;
  currentBindingAddress: typeof DACS_DEMOS_RAIL_REGISTRY_CURRENT_BINDING_ADDRESS_V1;
}

function canonicalCopy<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function nativeOwner(publicKey: Uint8Array): string {
  return Buffer.from(publicKey).toString("hex");
}

function exactHttpsBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username !== "" ||
        parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

async function authenticatedPublicationReceipt(
  runtime: Readonly<DacsDemosActorRuntimeV1>,
  logicalAddress: string,
  nativeAddress: string,
  value: Readonly<Record<string, unknown>>,
): Promise<Readonly<ProtocolAnchorReceipt>> {
  const expectedHash = contentHash(value);
  const receipt = await runtime.adapter.resolveDemosAnchorReceipt({
    logicalAddress,
    nativeAddress,
    contentHash: expectedHash,
    writer: runtime.authority,
  });
  if (receipt === null || receipt.logicalAddress !== logicalAddress ||
      receipt.nativeAddress !== nativeAddress || receipt.contentHash !== expectedHash ||
      !sameCanonicalClaimIdentity(receipt.writer, runtime.authority) ||
      receipt.state !== "finalized" ||
      receipt.observationDisposition !== "established" ||
      await runtime.adapter.verifyDemosAnchorReceipt(receipt) !== true) {
    throw new DacsDemosRailRegistryError("rail-registry-publication-proof-invalid");
  }
  return canonicalCopy(receipt);
}

/**
 * Bootstrap the first PA-2 x402 registry under one explicitly configured
 * Demos steward. This is intentionally initial-version-only: registry updates
 * require a separately reviewed supersession/update protocol, not another
 * immutable bootstrap call.
 */
export async function bootstrapDacsDemosX402RailRegistryV1(
  rawOptions: Readonly<BootstrapDacsDemosX402RailRegistryOptionsV1>,
): Promise<Readonly<BootstrapDacsDemosX402RailRegistryResultV1>> {
  if (rawOptions === null || typeof rawOptions !== "object" ||
      rawOptions.runtime === null || typeof rawOptions.runtime !== "object") {
    throw new TypeError("Demos x402 rail registry bootstrap options are invalid");
  }
  const runtime = rawOptions.runtime;
  const resourceBaseUrl = exactHttpsBaseUrl(rawOptions.resourceBaseUrl);
  const chainId = rawOptions.chainId ?? 84532;
  const finalityBlocks = rawOptions.finalityBlocks ?? 1;
  const assetContract = rawOptions.assetContract;
  const acceptedAt = rawOptions.acceptedAt;
  if (resourceBaseUrl === null || chainId !== 84532 ||
      typeof assetContract !== "string" ||
      !/^0x[0-9A-Fa-f]{40}$/.test(assetContract) ||
      !Number.isSafeInteger(acceptedAt) || acceptedAt <= 0 ||
      !Number.isSafeInteger(finalityBlocks) || finalityBlocks <= 0) {
    throw new TypeError("Demos x402 rail registry bootstrap options are invalid");
  }
  if (runtime.role !== "seller" ||
      canonicalDemosAgentPublicKey(runtime.authority) === null ||
      typeof runtime.adapter?.anchorWriteOnce !== "function" ||
      typeof runtime.signComponent !== "function") {
    throw new TypeError("Demos x402 rail registry bootstrap steward is invalid");
  }

  const unsignedDefinition: Omit<RailDefinition, "signature"> = {
    railVersion: 1,
    railId: "x402:default",
    railType: "x402",
    asset: {
      kind: "erc20",
      chainId,
      contract: assetContract,
      symbol: "USDC",
      decimals: 6,
    },
    network: { kind: "x402-resource", resourceBaseUrl },
    phaseHandler: "pay-x402",
    parameters: { authorization: "eip-3009", finalityBlocks },
    availability: "live",
    governance: {
      proposedBy: runtime.authority,
      acceptedAt,
      anchoring: "single-signer",
    },
  };
  const definition = await signComponentArtifact(
    unsignedDefinition,
    "dacs-rail:v1:",
    {
      algorithm: "ed25519",
      signer: runtime.authority,
      sign: runtime.signComponent,
    },
  );
  const definitionLogicalAddress = "dacs4:rail:x402%3Adefault:1";
  const definitionAnchor = await runtime.adapter.anchorWriteOnce(
    definitionLogicalAddress,
    definition,
  );
  const definitionRef: RailRegistryDefinitionRef = {
    logicalAddress: definitionLogicalAddress,
    anchor: { kind: "storage-program", locator: definitionAnchor.address },
    contentHash: contentHash(definition),
  };
  const definitionReceipt = await authenticatedPublicationReceipt(
    runtime,
    definitionLogicalAddress,
    definitionAnchor.address,
    definition,
  );

  const index: RailRegistryIndexDocument = {
    registryId: RAIL_REGISTRY_INDEX_ADDRESS,
    entries: [definitionRef],
  };
  const indexAnchor = await runtime.adapter.anchorWriteOnce(
    RAIL_REGISTRY_INDEX_ADDRESS,
    index,
  );
  const indexRef: RailRegistryDefinitionRef = {
    logicalAddress: RAIL_REGISTRY_INDEX_ADDRESS,
    anchor: { kind: "storage-program", locator: indexAnchor.address },
    contentHash: contentHash(index as unknown as Record<string, unknown>),
  };
  const indexReceipt = await authenticatedPublicationReceipt(
    runtime,
    RAIL_REGISTRY_INDEX_ADDRESS,
    indexAnchor.address,
    index as unknown as Record<string, unknown>,
  );
  const current: CurrentRailRegistryIndex = {
    registryVersion: 1,
    indexRef,
    receipt: indexReceipt,
  };
  const bindingAnchor = await runtime.adapter.anchorWriteOnce(
    DACS_DEMOS_RAIL_REGISTRY_CURRENT_BINDING_ADDRESS_V1,
    current,
  );
  await authenticatedPublicationReceipt(
    runtime,
    DACS_DEMOS_RAIL_REGISTRY_CURRENT_BINDING_ADDRESS_V1,
    bindingAnchor.address,
    current as unknown as Record<string, unknown>,
  );
  const provider = createDacsDemosRailRegistryProviderV1({
    runtime,
    stewardAuthority: runtime.authority,
    stewardPublicKey: runtime.publicKey,
  });
  const rail = await resolveRail(
    RAIL_REGISTRY_INDEX_ADDRESS,
    { railId: "x402:default", railVersion: 1 },
    provider,
  );
  return Object.freeze({
    rail,
    definitionRef: canonicalCopy(definitionRef),
    definitionReceipt,
    indexRef: canonicalCopy(indexRef),
    indexReceipt,
    currentBindingAddress: DACS_DEMOS_RAIL_REGISTRY_CURRENT_BINDING_ADDRESS_V1,
  });
}

function exactCurrentBinding(
  value: Record<string, unknown>,
): CurrentRailRegistryIndex | null {
  try {
    const captured = canonicalCopy(value) as Partial<CurrentRailRegistryIndex>;
    if (typeof captured.registryVersion !== "number" ||
        !Number.isSafeInteger(captured.registryVersion) || captured.registryVersion <= 0 ||
        captured.indexRef === null || typeof captured.indexRef !== "object" ||
        captured.receipt === null || typeof captured.receipt !== "object") {
      return null;
    }
    return captured as CurrentRailRegistryIndex;
  } catch {
    return null;
  }
}

/**
 * Adapt one authenticated Demos role runtime to DACS-4's fail-closed RAV-R5
 * provider. Every authority decision re-reads the canonical current binding,
 * reconstructs its portable receipt from chain history, and authenticates the
 * independently supplied index/definition receipt. Shape, hash, graph and RD-1
 * signature checks remain owned by the core `resolveRail` implementation.
 */
export function createDacsDemosRailRegistryProviderV1(
  options: Readonly<DacsDemosRailRegistryProviderOptionsV1>,
): Readonly<RailRegistrySelectionProvider> {
  if (options === null || typeof options !== "object" ||
      options.runtime === null || typeof options.runtime !== "object" ||
      typeof options.stewardAuthority !== "string" ||
      !(options.stewardPublicKey instanceof Uint8Array) ||
      options.stewardPublicKey.byteLength !== 32) {
    throw new TypeError("Demos rail registry provider options are invalid");
  }
  const authorityKey = canonicalDemosAgentPublicKey(options.stewardAuthority);
  if (authorityKey === null ||
      options.stewardAuthority !==
        `did:demos:agent:${Buffer.from(authorityKey).toString("hex")}` ||
      !bytesEqual(authorityKey, options.stewardPublicKey)) {
    throw new TypeError("Demos rail registry steward authority is invalid");
  }
  const runtime = options.runtime;
  const adapter = runtime.adapter;
  const stewardAuthority = options.stewardAuthority;
  const stewardPublicKey = Uint8Array.from(options.stewardPublicKey);
  const expectedNativeOwner = nativeOwner(stewardPublicKey);

  async function currentBinding(): Promise<Readonly<{
    address: string;
    value: CurrentRailRegistryIndex;
  }> | null> {
    const resolution = await adapter.resolveAnchorByName(
      DACS_DEMOS_RAIL_REGISTRY_CURRENT_BINDING_ADDRESS_V1,
      expectedNativeOwner,
    );
    if (resolution.status === "absent") return null;
    if (resolution.status !== "present") {
      throw new DacsDemosRailRegistryError("rail-registry-currentness-indeterminate");
    }
    const raw = await adapter.readAnchor(resolution.address);
    if (raw === null) {
      throw new DacsDemosRailRegistryError("rail-registry-binding-read-unresolved");
    }
    const value = exactCurrentBinding(raw);
    if (value === null) {
      throw new DacsDemosRailRegistryError("rail-registry-binding-malformed");
    }
    return Object.freeze({ address: resolution.address, value });
  }

  async function authenticateReceipt(
    receipt: RailRegistryAuthorityInput["receipt"],
  ): Promise<RailRegistryAuthorityVerification> {
    try {
      return await adapter.verifyDemosAnchorReceipt(receipt)
        ? "valid" : "invalid";
    } catch {
      return "indeterminate";
    }
  }

  const provider: RailRegistrySelectionProvider = {
    async resolveCurrentIndex(logicalAddress) {
      if (logicalAddress !== RAIL_REGISTRY_INDEX_ADDRESS) return null;
      const binding = await currentBinding();
      return binding === null ? null : canonicalCopy(binding.value);
    },

    async authenticateCurrentIndex(input) {
      try {
        if (input.logicalAddress !== RAIL_REGISTRY_INDEX_ADDRESS) return "invalid";
        const binding = await currentBinding();
        if (binding === null || canonicalize(binding.value) !== canonicalize({
          registryVersion: input.registryVersion,
          indexRef: input.indexRef,
          receipt: input.receipt,
        })) return "invalid";
        const bindingReceipt = await adapter.resolveDemosAnchorReceipt({
          logicalAddress: DACS_DEMOS_RAIL_REGISTRY_CURRENT_BINDING_ADDRESS_V1,
          nativeAddress: binding.address,
          contentHash: contentHash(binding.value as unknown as Record<string, unknown>),
          writer: stewardAuthority,
        });
        if (bindingReceipt === null) return "indeterminate";
        const [bindingAuthority, indexAuthority] = await Promise.all([
          authenticateReceipt(bindingReceipt),
          authenticateReceipt(input.receipt),
        ]);
        if (bindingAuthority === "indeterminate" || indexAuthority === "indeterminate") {
          return "indeterminate";
        }
        return bindingAuthority === "valid" && indexAuthority === "valid"
          ? "valid" : "invalid";
      } catch {
        return "indeterminate";
      }
    },

    async readAnchoredJson(ref: Readonly<RailRegistryDefinitionRef>) {
      return adapter.readAnchor(ref.anchor.locator);
    },

    async resolveDefinitionReceipt(ref: Readonly<RailRegistryDefinitionRef>) {
      return adapter.resolveDemosAnchorReceipt({
        logicalAddress: ref.logicalAddress,
        nativeAddress: ref.anchor.locator,
        contentHash: ref.contentHash,
        writer: stewardAuthority,
      });
    },

    async authenticateDefinition(input: Readonly<RailRegistryDefinitionAuthorityInput>) {
      if (input.registryAddress !== RAIL_REGISTRY_INDEX_ADDRESS ||
          !sameCanonicalClaimIdentity(input.receipt.writer, stewardAuthority)) {
        return "invalid";
      }
      return authenticateReceipt(input.receipt);
    },

    stewardWriter: stewardAuthority,
    stewardSigner: stewardAuthority,
    stewardPublicKey: Uint8Array.from(stewardPublicKey),
    verify: (bytes, signature, publicKey) =>
      ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
    legacySignatures: "reject" as const,
  };
  return Object.freeze(provider);
}
