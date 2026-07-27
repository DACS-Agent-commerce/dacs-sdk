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
   * Content hash of the record's signed scope, when the publisher knows it. A
   * consumer that reads the native address SHOULD re-hash and compare — the
   * binding is a pointer, never a substitute for verifying the content.
   */
  contentHash?: string;
  /** For versioned artifacts (listings), the version this binding pins. */
  version?: number;
  /** Marks a superseded/withdrawn entry; a revoked binding never resolves. */
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

/** Bindings that are eligible to resolve for `expectedOwner` (not revoked). */
function eligible(
  bindings: readonly AnchorBinding[],
  logicalAddress: string,
  expectedOwner: string,
): AnchorBinding[] {
  const owner = expectedOwner.trim().toLowerCase();
  return bindings.filter(
    (b) =>
      b.revoked !== true &&
      b.logicalAddress === logicalAddress &&
      b.owner.trim().toLowerCase() === owner,
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
  const matches = eligible(bindings, logicalAddress, expectedOwner);
  if (matches.length === 0) return { status: "absent" };
  const distinct = new Set(matches.map((b) => b.nativeAddress));
  if (distinct.size > 1) {
    return {
      status: "indeterminate",
      reason: `published bindings disagree on the native address for ${logicalAddress} (${distinct.size} candidates)`,
    };
  }
  return { status: "present", binding: matches[0]! };
}

/**
 * Resolve the LATEST live version of a versioned logical artifact (a listing),
 * owner-bound. Version-aware lookup is required by #29/#46: each version is
 * independently anchored and prior versions MUST remain readable, so "latest" is
 * a selection over the index — never an overwrite of a shared address.
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
  const live: AnchorBinding[] = [];
  for (const v of knownVersions) {
    const r = resolveBinding(bindings, logicalAddressForVersion(v), expectedOwner);
    // A conflicting version is fatal to "latest" — we cannot say which is newest
    // if the index is ambiguous about one of them.
    if (r.status === "indeterminate") return r;
    if (r.status === "present") live.push({ ...r.binding, version: v });
  }
  if (live.length === 0) return { status: "absent" };
  live.sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
  return { status: "present", binding: live[0]! };
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
 * An in-memory {@link BindingIndex} over a fixed set of published bindings —
 * the reference implementation, and what a consumer wraps a fetched
 * `listings.json` / catalog page in.
 */
export function createInMemoryBindingIndex(
  bindings: readonly AnchorBinding[],
): BindingIndex {
  const snapshot = [...bindings];
  return {
    async resolve(logicalAddress, expectedOwner) {
      return resolveBinding(snapshot, logicalAddress, expectedOwner);
    },
  };
}
