import { DacsError } from "../errors.js";
import { type DomainSeparator } from "../crypto/index.js";
import { verifySignedArtifact, type Verifier } from "../agent/signedArtifact.js";
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
  /** Verify a signature over raw bytes for a public key. */
  verify: Verifier;
}

function hasId(e: unknown): e is { id: string; availability: string; signature: string } {
  if (typeof e !== "object" || e === null) return false;
  const r = e as Record<string, unknown>;
  return (
    typeof r["id"] === "string" &&
    typeof r["availability"] === "string" &&
    typeof r["signature"] === "string"
  );
}

async function resolveEntry<T extends { id: string; availability: Availability }>(
  anchor: string,
  id: string,
  separator: DomainSeparator,
  deps: RegistryResolveDeps,
  validate: (e: Record<string, unknown>) => boolean,
): Promise<T> {
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

  // Trust root: the steward signature (over the entry's content hash) must
  // verify against the pinned steward key.
  const signed = await verifySignedArtifact(
    entry as Record<string, unknown>,
    separator,
    deps.stewardPublicKey,
    deps.verify,
  );
  if (!signed) {
    throw new DacsError(
      `entry "${id}" signature is not valid under the steward key`,
    );
  }

  if (!validate(entry as Record<string, unknown>)) {
    throw new DacsError(`entry "${id}" has an invalid descriptor shape`);
  }
  const descriptor = entry as T;
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

function isCompletenessCheck(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const check = value as Record<string, unknown>;
  if (check["kind"] === "content-length") return true;
  if (check["kind"] === "sentinel") {
    return typeof check["expression"] === "string" && check["expression"].length > 0;
  }
  return (
    check["kind"] === "record-count" &&
    typeof check["declaredCountExpression"] === "string" &&
    check["declaredCountExpression"].length > 0 &&
    typeof check["recordsExpression"] === "string" &&
    check["recordsExpression"].length > 0
  );
}

function isRecipeDescriptor(e: Record<string, unknown>): boolean {
  const negativeMatch = e["negativeMatch"];
  if (
    (negativeMatch !== undefined && typeof negativeMatch !== "boolean") ||
    "requiresListCompleteness" in e
  ) {
    return false;
  }
  if (negativeMatch === true) {
    const parserRules = e["parserRules"];
    if (
      typeof parserRules !== "object" ||
      parserRules === null ||
      Array.isArray(parserRules) ||
      !isCompletenessCheck(
        (parserRules as Record<string, unknown>)["completeness"],
      )
    ) {
      return false;
    }
  }
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
): Promise<RailDescriptor & { signature: string }> {
  return resolveEntry(anchor, id, "dacs-rail:v1:", deps, isRailDescriptor);
}

/** Resolve + pin a live, steward-signed recipe descriptor from the recipe registry. */
export function resolveRecipe(
  anchor: string,
  id: string,
  deps: RegistryResolveDeps,
): Promise<RecipeDescriptor & { signature: string }> {
  return resolveEntry(anchor, id, "dacs-recipe:v1:", deps, isRecipeDescriptor);
}
