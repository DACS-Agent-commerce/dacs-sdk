/**
 * Published logical→native anchor binding (#54, DACS-1 §6.3.4 point (c)).
 *
 * On a WRITE-INPUT-MAPPING substrate — Demos, where the native StorageProgram
 * address folds in the deployer address and the per-write transaction nonce — the
 * native address is NOT recomputable from the logical address. §6.3.4 therefore
 * requires an implementation to (a) anchor at the native address, (b) carry the
 * logical address as record metadata, and (c) PUBLISH the logical→native binding
 * (listings index §6.3.5 / catalog §6.3.6) with consumers resolving through it.
 *
 * This module is (c): the published binding and its resolution. It is
 * SUBSTRATE-NEUTRAL and pure — the binding is data, resolution is a lookup — so
 * the same surface serves an in-memory index, a `/.well-known` listings index, or
 * a catalog API. (Point (b), the on-record logical-address metadata, is the
 * writer's job at anchor time, not this module's.)
 *
 * WHY NOT RESOLVE BY PROGRAM NAME: the spec is explicit that the native program
 * name is an implementation-defined OPAQUE write input and MUST NOT be used as a
 * canonical identifier or a consumer resolution key — different conforming
 * producers may pick different names for the same logical address. Name lookup is
 * therefore not an interoperable resolution mechanism; the published binding is.
 *
 * ⚠ RESOLUTION IS DISCOVERY, NOT TRUST. An index entry is untrusted data — anyone
 * can publish one, and `owner` is a self-asserted field INSIDE that same untrusted
 * entry. Owner-binding here only filters out entries that don't even *claim* the
 * expected writer; a forger who copies the real owner into a forged entry WILL
 * resolve, pointing the consumer at attacker-chosen bytes. So the binding is a
 * POINTER, never a trust boundary. A consumer MUST, after dereferencing the
 * resolved native address, verify the record itself — its domain-separated
 * signature by the expected signer AND its content hash — before trusting it.
 * That post-read verification is the actual security boundary; this resolution is
 * a hint that survives a wrong hint only because the read is verified.
 */

import { normalizedBindingOwner } from "./owner.js";

/** A published logical→native binding entry (§6.3.4 (c)). */
export interface AnchorBinding {
  /** The colon-bearing §6.3.4 LOGICAL address — the stable discovery key. */
  logicalAddress: string;
  /** The substrate-native address the record actually lives at (e.g. `stor-…`). */
  nativeAddress: string;
  /**
   * The writer that anchored it, as SELF-ASSERTED by the entry. Resolution
   * filters on this, but it is not a trust signal (a forger can copy it) — trust
   * comes from verifying the dereferenced record, not from this field.
   */
  owner: string;
  /**
   * Content hash of the record's signed scope. Optional only so raw discovery
   * candidates can be represented; {@link resolveAndRead} will never return a
   * hashless binding as `verified`. Supported publication paths populate it and
   * consumers re-hash before signature/context verification.
   */
  contentHash?: string;
  /** For versioned artifacts (listings), the version this binding pins. */
  version?: number;
  /**
   * Generic index tombstone only; a tombstoned binding never resolves. This is
   * not DACS-1 RevocationBinding evidence and must not be used to decide the
   * protocol revocation check without its signed marker validation.
   */
  revoked?: boolean;
}

/**
 * Outcome of resolving a logical address through the published binding. Mirrors
 * the fail-closed shape used elsewhere in the SDK: `indeterminate` (the index
 * could not be consulted) is DISTINCT from `absent` (it was consulted and holds
 * no matching binding), so a transient index failure is never read as "no such
 * artifact" — which, on a write path, would create a duplicate.
 */
export type BindingResolution =
  | { status: "present"; binding: AnchorBinding }
  | { status: "absent" }
  | { status: "indeterminate"; reason: string };

/** Bindings claiming the requested logical address and owner, in any state. */
function matchingBindings(
  bindings: readonly AnchorBinding[],
  logicalAddress: string,
  expectedOwner: string,
): AnchorBinding[] {
  const owner = normalizedBindingOwner(expectedOwner);
  return bindings.filter(
    (b) =>
      b.logicalAddress === logicalAddress &&
      normalizedBindingOwner(b.owner) === owner,
  );
}

/**
 * Resolve one logical address against a set of published bindings, filtered to
 * entries claiming `expectedOwner`. This is DISCOVERY, not trust: `owner` is
 * self-asserted, so a forged entry copying the real owner resolves too — the
 * caller MUST verify the dereferenced record's signature + content hash (see the
 * module header). This step only narrows which native address to read.
 *
 * A CONFLICT — two live bindings for the same (logicalAddress, owner) pointing at
 * different native addresses — resolves `indeterminate`, never "pick one". The
 * index is ambiguous about which record is authoritative, and silently choosing
 * could hand the consumer the wrong artifact.
 */
export function resolveBinding(
  bindings: readonly AnchorBinding[],
  logicalAddress: string,
  expectedOwner: string,
): BindingResolution {
  const matches = matchingBindings(bindings, logicalAddress, expectedOwner);
  if (matches.length === 0) return { status: "absent" };
  const first = matches[0]!;
  if (matches.some((candidate) => !sameBinding(first, candidate))) {
    return {
      status: "indeterminate",
      reason: `published bindings disagree on the native address, content hash, version, or state for ${logicalAddress}`,
    };
  }
  if (first.revoked === true) return { status: "absent" };
  return { status: "present", binding: first };
}

/**
 * Resolve the LATEST published version slot of a versioned logical artifact (a
 * listing), owner-bound. Version-aware lookup is required by #29/#46: each
 * version is independently anchored and prior versions MUST remain readable, so
 * "latest" is a selection over the index — never an overwrite of a shared
 * address. If the newest known published slot is tombstoned, this fails closed
 * instead of silently reactivating an older superseded listing.
 *
 * Entries without a `version` are ignored here (they are unversioned artifacts);
 * use {@link resolveBinding} for those.
 */
export function resolveLatestVersion(
  bindings: readonly AnchorBinding[],
  logicalAddressForVersion: (version: number) => string,
  expectedOwner: string,
  knownVersions: readonly number[],
): BindingResolution {
  const versions = [...new Set(knownVersions)].sort((a, b) => b - a);
  for (const v of versions) {
    const logicalAddress = logicalAddressForVersion(v);
    const candidates = matchingBindings(
      bindings,
      logicalAddress,
      expectedOwner,
    );
    if (candidates.length === 0) continue;

    const r = resolveBinding(bindings, logicalAddress, expectedOwner);
    // A conflict in the newest published slot is fatal. Likewise, a tombstone
    // withdraws that newest version; it never reactivates an older superseded
    // listing for new sessions.
    if (r.status === "indeterminate") return r;
    if (r.status === "absent") {
      return {
        status: "indeterminate",
        reason: `newest published binding ${logicalAddress} is tombstoned`,
      };
    }
    if (r.binding.version !== v) {
      return {
        status: "indeterminate",
        reason:
          `published binding for ${logicalAddress} carries ` +
          `version ${String(r.binding.version)} instead of ${v}`,
      };
    }
    return r;
  }
  return { status: "absent" };
}

/**
 * A published binding index (the §6.3.5 well-known listings index / §6.3.6
 * catalog, or any consumer-side cache of them). Async so a real implementation
 * can fetch; `indeterminate` is how it reports "I could not consult the index".
 */
export interface BindingIndex {
  resolve(logicalAddress: string, expectedOwner: string): Promise<BindingResolution>;
}

/**
 * Outcome of publishing a logical→native binding. Publication is deliberately
 * separate from anchoring: on a real deployment it may update a well-known index
 * or catalog after the substrate write has already succeeded. `indeterminate`
 * therefore means callers MUST retain the anchored native address and retry the
 * same publication; it never means the anchor should be recreated.
 */
export type BindingPublication =
  | { status: "published"; binding: AnchorBinding }
  | { status: "already-published"; binding: AnchorBinding }
  | { status: "conflict"; reason: string; existing?: AnchorBinding }
  | { status: "indeterminate"; reason: string };

/**
 * A target that can publish the binding produced by an anchor write. Its
 * acknowledgement alone is not consumer visibility: BoundArtifactRepository
 * independently resolves the exact tuple through its configured index before
 * reporting `published`/`already-published`.
 */
export interface BindingPublisher {
  publish(binding: AnchorBinding): Promise<BindingPublication>;
}

/** Combined read/write binding surface used by the reference repository. */
export interface BindingStore extends BindingIndex, BindingPublisher {
  /** Immutable snapshot for persistence, inspection, or test hand-off. */
  snapshot(): readonly AnchorBinding[];
}

function cloneBinding(binding: AnchorBinding): AnchorBinding {
  return { ...binding };
}

function cloneResolution(resolution: BindingResolution): BindingResolution {
  return resolution.status === "present"
    ? { status: "present", binding: cloneBinding(resolution.binding) }
    : { ...resolution };
}

function sameOwner(left: string, right: string): boolean {
  return normalizedBindingOwner(left) === normalizedBindingOwner(right);
}

function sameBinding(left: AnchorBinding, right: AnchorBinding): boolean {
  return (
    left.logicalAddress === right.logicalAddress &&
    left.nativeAddress === right.nativeAddress &&
    sameOwner(left.owner, right.owner) &&
    left.contentHash === right.contentHash &&
    left.version === right.version &&
    (left.revoked === true) === (right.revoked === true)
  );
}

/**
 * An in-memory {@link BindingIndex} over a fixed set of published bindings —
 * the reference implementation, and what a consumer wraps a fetched
 * `listings.json` / catalog page in.
 */
export function createInMemoryBindingIndex(
  bindings: readonly AnchorBinding[],
): BindingIndex {
  const snapshot = bindings.map(cloneBinding);
  return {
    async resolve(logicalAddress, expectedOwner) {
      return cloneResolution(
        resolveBinding(snapshot, logicalAddress, expectedOwner),
      );
    },
  };
}

/**
 * Mutable in-memory reference store for the complete publish→resolve lifecycle.
 * It models a shared well-known index/catalog without pretending that an SDK can
 * autonomously update either one: production users provide a {@link BindingStore}
 * backed by their actual publication authority.
 *
 * Exact re-publication is idempotent. A second live entry for the same
 * `(logicalAddress, owner)` that changes the native address, hash, version, or
 * revocation state is a conflict and is NOT inserted.
 */
export function createInMemoryBindingStore(
  initial: readonly AnchorBinding[] = [],
): BindingStore {
  const bindings = initial.map(cloneBinding);

  return {
    async resolve(logicalAddress, expectedOwner) {
      return cloneResolution(
        resolveBinding(bindings, logicalAddress, expectedOwner),
      );
    },

    async publish(binding) {
      const existing = bindings.filter(
        (candidate) =>
          candidate.logicalAddress === binding.logicalAddress &&
          sameOwner(candidate.owner, binding.owner),
      );
      if (existing.length > 0) {
        if (existing.every((candidate) => sameBinding(candidate, binding))) {
          return {
            status: "already-published",
            binding: cloneBinding(existing[0]!),
          };
        }
        return {
          status: "conflict",
          reason: `a different binding is already published for ${binding.logicalAddress} and owner ${binding.owner}`,
          existing: cloneBinding(existing[0]!),
        };
      }

      const published = cloneBinding(binding);
      bindings.push(published);
      return { status: "published", binding: cloneBinding(published) };
    },

    snapshot() {
      return bindings.map(cloneBinding);
    },
  };
}
