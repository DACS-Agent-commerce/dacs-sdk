import {
  RAIL_REGISTRY_INDEX_ADDRESS,
  ed25519Verify,
  publicKeyFromRaw,
  type CurrentRailRegistryIndex,
  type RailRegistryAuthorityInput,
  type RailRegistryAuthorityVerification,
  type RailRegistryDefinitionAuthorityInput,
  type RailRegistryDefinitionRef,
  type RailRegistrySelectionProvider,
} from "@kynesyslabs/dacs";
import { canonicalize, contentHash } from "@kynesyslabs/dacs/canonical";
import {
  canonicalDemosAgentPublicKey,
  sameCanonicalClaimIdentity,
} from "@kynesyslabs/dacs/identity";

import type { DacsDemosActorRuntimeV1 } from "./demosRuntime.js";

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
      RAIL_REGISTRY_INDEX_ADDRESS,
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
          logicalAddress: RAIL_REGISTRY_INDEX_ADDRESS,
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
