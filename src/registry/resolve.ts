import { types as nodeTypes } from "node:util";

import { DacsError } from "../errors.js";
import { type DomainSeparator } from "../crypto/index.js";
import { verifySignedArtifact, type Verifier } from "../agent/signedArtifact.js";
import { verifyComponentSignature } from "../artifacts/signatures.js";
import type { ComponentSignature } from "../artifacts/types.js";
import {
  isSafeJsonString,
  snapshotCanonicalJsonObject,
} from "../canonical/snapshot.js";
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

interface CapturedRegistryResolveDeps {
  readRegistry: RegistryResolveDeps["readRegistry"];
  stewardPublicKey: Uint8Array;
  stewardSigner: string;
  verify: Verifier;
  legacySignatures: RegistryResolveDeps["legacySignatures"];
}

function captureRegistryResolveDeps(
  deps: RegistryResolveDeps,
): CapturedRegistryResolveDeps {
  try {
    const readRegistryCandidate: unknown = deps.readRegistry;
    const stewardPublicKeyCandidate: unknown = deps.stewardPublicKey;
    const stewardSignerCandidate: unknown = deps.stewardSigner;
    const verifyCandidate: unknown = deps.verify;
    const legacySignatures = deps.legacySignatures;
    if (typeof readRegistryCandidate !== "function") {
      throw new TypeError("readRegistry must be a function");
    }
    if (
      stewardPublicKeyCandidate === null ||
      typeof stewardPublicKeyCandidate !== "object" ||
      nodeTypes.isProxy(stewardPublicKeyCandidate) ||
      !nodeTypes.isUint8Array(stewardPublicKeyCandidate)
    ) {
      throw new TypeError("stewardPublicKey must be a 32-byte Uint8Array");
    }
    const stewardPublicKey = new Uint8Array(stewardPublicKeyCandidate);
    if (stewardPublicKey.byteLength !== 32) {
      throw new TypeError("stewardPublicKey must be a 32-byte Uint8Array");
    }
    if (
      typeof stewardSignerCandidate !== "string" ||
      stewardSignerCandidate.length === 0 ||
      stewardSignerCandidate.trim() !== stewardSignerCandidate ||
      !isSafeJsonString(stewardSignerCandidate)
    ) {
      throw new TypeError("stewardSigner must be a valid non-empty JSON string");
    }
    if (typeof verifyCandidate !== "function") {
      throw new TypeError("verify must be a function");
    }
    if (
      legacySignatures !== undefined &&
      legacySignatures !== "reject" &&
      legacySignatures !== "verify-with-pinned-key"
    ) {
      throw new TypeError("legacySignatures is not a supported policy");
    }

    return {
      readRegistry: Function.prototype.bind.call(
        readRegistryCandidate,
        deps,
      ) as RegistryResolveDeps["readRegistry"],
      stewardPublicKey,
      stewardSigner: stewardSignerCandidate.normalize("NFC"),
      verify: Function.prototype.bind.call(
        verifyCandidate,
        deps,
      ) as Verifier,
      legacySignatures,
    };
  } catch (cause) {
    throw new DacsError("invalid registry resolver dependencies", { cause });
  }
}

async function verifyWithCapturedDeps(
  verify: Verifier,
  bytes: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): Promise<boolean> {
  const result = await verify(
    Uint8Array.from(bytes),
    Uint8Array.from(signature),
    Uint8Array.from(publicKey),
  );
  return result === true;
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
  // Pin all trust-root configuration and callback implementations before the
  // registry reader is entered. A delayed read must not let the caller swap
  // the steward identity, key bytes, policy, or verifier mid-resolution.
  const captured = captureRegistryResolveDeps(deps);
  if (
    typeof anchor !== "string" ||
    anchor.length === 0 ||
    anchor.trim() !== anchor ||
    !isSafeJsonString(anchor) ||
    typeof id !== "string" ||
    id.length === 0 ||
    id.trim() !== id ||
    !isSafeJsonString(id)
  ) {
    throw new DacsError("registry anchor and entry id must be valid non-empty JSON strings");
  }
  const pinnedAnchor = anchor.normalize("NFC");
  const pinnedId = id.normalize("NFC");
  const readResult = await captured.readRegistry(pinnedAnchor);
  if (!readResult) {
    throw new DacsError(`registry not found at ${pinnedAnchor}`);
  }
  const doc = snapshotCanonicalJsonObject(
    readResult,
    `registry at ${pinnedAnchor}`,
  );
  const entries = doc["entries"];
  if (!Array.isArray(entries)) {
    throw new DacsError(`registry at ${pinnedAnchor} has no entries array`);
  }

  const entry = entries.find((e) => hasId(e) && e.id === pinnedId);
  if (!entry) {
    throw new DacsError(
      `entry "${pinnedId}" not found in registry ${pinnedAnchor}`,
    );
  }

  // Trust root: a role-bound ComponentSignature must verify against the pinned
  // steward claim and key. Legacy hex strings are rejected by default; the
  // opt-in path authenticates and normalises them before returning.
  let verifiedEntry = entry as Record<string, unknown>;
  if (typeof verifiedEntry.signature === "string") {
    if (
      captured.legacySignatures !== "verify-with-pinned-key" ||
      !(await verifySignedArtifact(
        verifiedEntry,
        separator,
        Uint8Array.from(captured.stewardPublicKey),
        (bytes, signature, publicKey) =>
          verifyWithCapturedDeps(
            captured.verify,
            bytes,
            signature,
            publicKey,
          ),
      ))
    ) {
      throw new DacsError(
        `entry "${pinnedId}" legacy signature is rejected or invalid under the steward key`,
      );
    }
    const legacyValue = verifiedEntry.signature;
    verifiedEntry = {
      ...verifiedEntry,
      signature: {
        algorithm: "ed25519",
        signer: captured.stewardSigner,
        value: Buffer.from(legacyValue, "hex").toString("base64url"),
      },
    };
  }

  const signed = await verifyComponentSignature(verifiedEntry, separator, {
    isSignerAuthorized: (_artifact, signature) =>
      signature.signer === captured.stewardSigner,
    resolvePublicKey: (signature) =>
      signature.algorithm === "ed25519"
        ? Uint8Array.from(captured.stewardPublicKey)
        : null,
    verify: ({ signedBytes, signature, publicKey }) =>
      verifyWithCapturedDeps(
        captured.verify,
        signedBytes,
        Uint8Array.from(Buffer.from(signature.value, "base64url")),
        publicKey,
      ),
  });
  if (signed.status !== "valid") {
    throw new DacsError(
      `entry "${pinnedId}" signature is not valid under the steward key`,
    );
  }

  if (!validate(verifiedEntry)) {
    throw new DacsError(`entry "${pinnedId}" has an invalid descriptor shape`);
  }
  const descriptor = verifiedEntry as T & { signature: ComponentSignature };
  if (descriptor.availability !== "live") {
    throw new DacsError(
      `entry "${pinnedId}" is not live (availability=${descriptor.availability})`,
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
