import { DacsError } from "../errors.js";
import { type DomainSeparator } from "../crypto/index.js";
import { verifySignedArtifact, type Verifier } from "../agent/signedArtifact.js";
import { verifyComponentSignature } from "../artifacts/signatures.js";
import type { ComponentSignature } from "../artifacts/types.js";
import type { Availability, RailDescriptor, RecipeDescriptor } from "./types.js";

/**
 * Resolve + pin a single registry entry by id. Per T12/T13 the SDK reads the
 * anchored registry, verifies the entry's steward signature (which is over its
 * content hash — so tampering or a non-steward signer fails), confirms it is
 * `live`, and returns the pinned descriptor. Anything off → throw, never a
 * silently-trusted entry.
 */

export interface RegistryResolveDeps {
  /** Read the anchored registry document at its address/name. */
  readRegistry: (anchor: string) => Promise<Record<string, unknown> | null>;
  /** The pinned steward (PA-2) public key — the registry's trust root. */
  stewardPublicKey: Uint8Array;
  /** The pinned steward claim that the ComponentSignature signer must name. */
  stewardSigner: string;
  /** Verify a signature over raw bytes for a public key. */
  verify: Verifier;
  /** Explicit opt-in for reading and normalising pre-ComponentSignature entries. */
  legacySignatures?: "reject" | "verify-with-pinned-key";
}

function hasId(e: unknown): e is { id: string; availability: string } {
  if (typeof e !== "object" || e === null) return false;
  const r = e as Record<string, unknown>;
  return (
    typeof r["id"] === "string" &&
    typeof r["availability"] === "string"
  );
}

async function resolveEntry<T extends { id: string; availability: Availability }>(
  anchor: string,
  id: string,
  separator: DomainSeparator,
  deps: RegistryResolveDeps,
  validate: (e: Record<string, unknown>) => boolean,
): Promise<T & { signature: ComponentSignature }> {
  const doc = await deps.readRegistry(anchor);
  if (!doc) {
    throw new DacsError(`registry not found at ${anchor}`);
  }
  const entries = doc["entries"];
  if (!Array.isArray(entries)) {
    throw new DacsError(`registry at ${anchor} has no entries array`);
  }

  const entry = entries.find((e) => hasId(e) && e.id === id);
  if (!entry) {
    throw new DacsError(`entry "${id}" not found in registry ${anchor}`);
  }

  // Trust root: a role-bound ComponentSignature must verify against the pinned
  // steward claim and key. Legacy hex strings are rejected by default; the
  // opt-in path authenticates and normalises them before returning.
  let verifiedEntry = entry as Record<string, unknown>;
  if (typeof verifiedEntry.signature === "string") {
    if (
      deps.legacySignatures !== "verify-with-pinned-key" ||
      !(await verifySignedArtifact(
        verifiedEntry,
        separator,
        deps.stewardPublicKey,
        deps.verify,
      ))
    ) {
      throw new DacsError(
        `entry "${id}" legacy signature is rejected or invalid under the steward key`,
      );
    }
    const legacyValue = verifiedEntry.signature;
    verifiedEntry = {
      ...verifiedEntry,
      signature: {
        algorithm: "ed25519",
        signer: deps.stewardSigner,
        value: Buffer.from(legacyValue, "hex").toString("base64url"),
      },
    };
  }

  const signed = await verifyComponentSignature(verifiedEntry, separator, {
    isSignerAuthorized: (_artifact, signature) =>
      signature.signer === deps.stewardSigner,
    resolvePublicKey: (signature) =>
      signature.algorithm === "ed25519" ? deps.stewardPublicKey : null,
    verify: ({ signedBytes, signature, publicKey }) =>
      deps.verify(
        signedBytes,
        Uint8Array.from(Buffer.from(signature.value, "base64url")),
        publicKey,
      ),
  });
  if (signed.status !== "valid") {
    throw new DacsError(
      `entry "${id}" signature is not valid under the steward key`,
    );
  }

  if (!validate(verifiedEntry)) {
    throw new DacsError(`entry "${id}" has an invalid descriptor shape`);
  }
  const descriptor = verifiedEntry as T & { signature: ComponentSignature };
  if (descriptor.availability !== "live") {
    throw new DacsError(
      `entry "${id}" is not live (availability=${descriptor.availability})`,
    );
  }
  return descriptor;
}

function isRailDescriptor(e: Record<string, unknown>): boolean {
  return (
    typeof e["id"] === "string" &&
    typeof e["kind"] === "string" &&
    typeof e["availability"] === "string" &&
    typeof e["params"] === "object" &&
    e["params"] !== null
  );
}

function isRecipeDescriptor(e: Record<string, unknown>): boolean {
  return (
    typeof e["id"] === "string" &&
    typeof e["method"] === "string" &&
    typeof e["availability"] === "string" &&
    typeof e["params"] === "object" &&
    e["params"] !== null
  );
}

/** Resolve + pin a live, steward-signed rail descriptor from the rail registry. */
export function resolveRail(
  anchor: string,
  id: string,
  deps: RegistryResolveDeps,
): Promise<RailDescriptor & { signature: ComponentSignature }> {
  return resolveEntry(anchor, id, "dacs-rail:v1:", deps, isRailDescriptor);
}

/** Resolve + pin a live, steward-signed recipe descriptor from the recipe registry. */
export function resolveRecipe(
  anchor: string,
  id: string,
  deps: RegistryResolveDeps,
): Promise<RecipeDescriptor & { signature: ComponentSignature }> {
  return resolveEntry(anchor, id, "dacs-recipe:v1:", deps, isRecipeDescriptor);
}
