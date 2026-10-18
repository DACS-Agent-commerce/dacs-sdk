/**
 * DACS-5 §10.4.2 BB-5..BB-7 candidate-set resolution for one `(jobId, role)`
 * on a write-input-mapping substrate.
 *
 * The caller supplies every signed `BundleBinding` it discovered, from all the
 * surfaces it consulted (its §6.3.5 well-known index, §6.3.6 catalogs, the
 * binding a counterparty carried, a substrate-side binding program). This
 * module applies, in order:
 *
 * - BB-5 checks 1-5 and BB-4: shape, supported version, signature, requested
 *   `(jobId, role)` and the logical address derived from the binding's own
 *   signed `jobId` and `role`. Failing bindings are discarded.
 * - BB-6: candidates grouped by authenticated `signer`, pruned before any fetch
 *   to the role holder when a co-signed role map supplies one; each signer's
 *   distinct native addresses fetched in ascending `(bundleContentHash,
 *   nativeAddress)` order, at most {@link BUNDLE_BINDING_FETCH_BUDGET} per
 *   signer; BB-5 checks 7-9 after the fetch; collapse of canonically equal
 *   authorized copies; precedence of a fully signed copy; equivocation at equal
 *   signature standing.
 * - BB-7: every case that is not one resolved authorized copy is
 *   `indeterminate`. Nothing here ever reports `absent`: non-discovery is not
 *   absence evidence (BB-8), and rejected content is not absence either.
 *
 * The native address is never recomputed and no storage-program name is an
 * input (BB-5, BB-7).
 */

import type { BundleBinding } from "../artifacts/types.js";
import { isBundleBinding } from "../artifacts/validators.js";
import { canonicalize } from "../canonical/index.js";
import { DacsError, SubstrateError } from "../errors.js";
import type { BundleCopyRole, CopyValidity } from "../agent/bundleCopyValidity.js";
import { attestationBundleHash } from "../agent/twoSidedBundle.js";

/** BB-6: N, the fetch budget per authenticated signer per `(jobId, role)`. */
export const BUNDLE_BINDING_FETCH_BUDGET = 8;

export interface ResolveBundleBindingCandidatesInput {
  jobId: string;
  role: BundleCopyRole;
  /** Raw records from every consulted discovery surface; untrusted. */
  candidates: readonly unknown[];
  /**
   * BB-6 pre-fetch prune: the primary claim holding `role` in an
   * already-fetched copy of this job that carries every §10.4.1 required
   * signature. When given, only that signer's bindings are fetched.
   */
  roleHolder?: string;
  /** BB-4: the domain-separated signature verifies against the signer's key. */
  verifyBindingSignature(binding: Readonly<BundleBinding>): Promise<boolean> | boolean;
  /**
   * BB-5 step 6: the copy at an exact native address. Return null when nothing
   * is readable there yet. Throw a `DacsError` that is not a `SubstrateError`
   * for content or a receipt that is invalid (the candidate is then inert);
   * any other throw is an unanswered read.
   */
  fetchCopy(
    nativeAddress: string,
  ): Promise<Readonly<Record<string, unknown>> | null> | Readonly<Record<string, unknown>> | null;
  /** §10.4.1/§10.4.2 copy validity for `role`, e.g. core `verifyBundleCopy`. */
  verifyCopy(
    copy: Readonly<Record<string, unknown>>,
    role: BundleCopyRole,
  ): Promise<CopyValidity> | CopyValidity;
}

export type BundleBindingCandidateResolution =
  | {
      disposition: "present";
      binding: BundleBinding;
      copy: Record<string, unknown>;
      fullySigned: boolean;
    }
  | {
      disposition: "indeterminate";
      reason:
        | "bundle-binding-undiscovered"
        | "bundle-binding-candidates-unfetched"
        | "bundle-binding-budget-exhausted"
        | "bundle-binding-candidates-rejected"
        | "bundle-binding-equivocation";
    };

/**
 * The `indeterminate` reasons that are no evidence either way (BB-8): every
 * consulted surface answered and none showed a signed binding
 * (`bundle-binding-undiscovered`), or a surface did not answer
 * (`bundle-binding-unanswered`). A BundleBinding resolver reports
 * non-observation with exactly one of these.
 */
export const BUNDLE_BINDING_NON_OBSERVATION_REASONS = Object.freeze([
  "bundle-binding-undiscovered",
  "bundle-binding-unanswered",
] as const);

export type BundleBindingNonObservationReason =
  (typeof BUNDLE_BINDING_NON_OBSERVATION_REASONS)[number];

/** True only for a {@link BUNDLE_BINDING_NON_OBSERVATION_REASONS} reason. */
export function isBundleBindingNonObservation(
  reason: unknown,
): reason is BundleBindingNonObservationReason {
  return (BUNDLE_BINDING_NON_OBSERVATION_REASONS as readonly unknown[]).includes(reason);
}

/**
 * True for every BB-6/BB-7 `indeterminate` that is not non-observation: the
 * side's candidate set did not resolve to one authorized copy (equivocation,
 * an exhausted budget, an unfetched or rejected candidate, or any other reason
 * a resolver gives). That keeps the side's read disposition indeterminate, so
 * it holds a completion back. Fail-closed: only the non-observation reasons
 * are no evidence either way (BB-8).
 */
export function isUnresolvedBundleBindingCandidateSet(reason: unknown): boolean {
  return !isBundleBindingNonObservation(reason);
}

interface Authorized {
  binding: BundleBinding;
  copy: Record<string, unknown>;
  hash: string;
  fullySigned: boolean;
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}

function byHashThenAddress(a: BundleBinding, b: BundleBinding): number {
  return a.bundleContentHash < b.bundleContentHash ? -1
    : a.bundleContentHash > b.bundleContentHash ? 1
      : a.nativeAddress < b.nativeAddress ? -1
        : a.nativeAddress > b.nativeAddress ? 1 : 0;
}

function shapeValid(value: unknown): value is BundleBinding {
  try {
    return isBundleBinding(value);
  } catch {
    // A malformed jobId makes the logical-address derivation throw.
    return false;
  }
}

function roleHolderOf(
  copy: Readonly<Record<string, unknown>>,
  role: BundleCopyRole,
): string | undefined {
  const parties = copy["parties"];
  if (!Array.isArray(parties)) return undefined;
  const holders = parties.filter((party) =>
    party !== null && typeof party === "object" &&
    (party as Record<string, unknown>)["role"] === role);
  if (holders.length !== 1) return undefined;
  const claim = (holders[0] as Record<string, unknown>)["primaryClaim"];
  return typeof claim === "string" ? claim : undefined;
}

/** Resolve one side's read disposition from its discovered bindings (BB-5..BB-7). */
export async function resolveBundleBindingCandidates(
  input: Readonly<ResolveBundleBindingCandidatesInput>,
): Promise<BundleBindingCandidateResolution> {
  // BB-5 checks 1-5 and BB-4, then exact duplicates from several surfaces.
  const unique = new Map<string, BundleBinding>();
  for (const raw of input.candidates) {
    if (!shapeValid(raw) || raw.jobId !== input.jobId || raw.role !== input.role) continue;
    let signed = false;
    try {
      signed = await input.verifyBindingSignature(clone(raw));
    } catch {
      signed = false;
    }
    if (!signed) continue;
    unique.set(canonicalize(raw), clone(raw));
  }
  let bindings = [...unique.values()];
  if (input.roleHolder !== undefined) {
    bindings = bindings.filter((binding) => binding.signer === input.roleHolder);
  }
  if (bindings.length === 0) {
    return { disposition: "indeterminate", reason: "bundle-binding-undiscovered" };
  }

  const bySigner = new Map<string, BundleBinding[]>();
  for (const binding of bindings) {
    const group = bySigner.get(binding.signer) ?? [];
    group.push(binding);
    bySigner.set(binding.signer, group);
  }

  const authorized: Authorized[] = [];
  let unfetched = false;
  let exhausted = false;
  for (const signer of [...bySigner.keys()].sort()) {
    const ordered = bySigner.get(signer)!.sort(byHashThenAddress);
    const addresses: string[] = [];
    for (const binding of ordered) {
      if (!addresses.includes(binding.nativeAddress)) addresses.push(binding.nativeAddress);
    }
    if (addresses.length > BUNDLE_BINDING_FETCH_BUDGET) exhausted = true;
    for (const address of addresses.slice(0, BUNDLE_BINDING_FETCH_BUDGET)) {
      let copy: Record<string, unknown> | null;
      try {
        const fetched = await input.fetchCopy(address);
        copy = fetched === null ? null : clone(fetched);
      } catch (error) {
        // Invalid content or receipt is rejected and inert; anything else
        // left this candidate unfetched.
        if (!(error instanceof DacsError) || error instanceof SubstrateError) unfetched = true;
        continue;
      }
      if (copy === null) {
        unfetched = true;
        continue;
      }
      let hash: string;
      let validity: CopyValidity;
      try {
        hash = attestationBundleHash(copy as never);
        validity = await input.verifyCopy(clone(copy), input.role);
      } catch {
        unfetched = true;
        continue;
      }
      const holder = roleHolderOf(copy, input.role);
      for (const binding of ordered.filter((entry) => entry.nativeAddress === address)) {
        // BB-5 checks 7-9; a copy failing them is inert (BB-6).
        if (copy["jobId"] !== binding.jobId || hash !== binding.bundleContentHash ||
            !validity.valid || holder !== binding.signer ||
            !validity.signers.includes(binding.signer)) continue;
        authorized.push({ binding, copy, hash, fullySigned: validity.fullySigned });
      }
    }
  }
  if (unfetched) {
    return { disposition: "indeterminate", reason: "bundle-binding-candidates-unfetched" };
  }
  if (exhausted) {
    return { disposition: "indeterminate", reason: "bundle-binding-budget-exhausted" };
  }
  if (authorized.length === 0) {
    return { disposition: "indeterminate", reason: "bundle-binding-candidates-rejected" };
  }

  // Collapse canonically equal copies; a fully signed copy takes precedence.
  const groups = new Map<string, Authorized[]>();
  for (const entry of authorized) {
    groups.set(entry.hash, [...(groups.get(entry.hash) ?? []), entry]);
  }
  const standing = (group: Authorized[]) => group.some((entry) => entry.fullySigned);
  const all = [...groups.values()];
  const fullySigned = all.filter(standing);
  const chosen = all.length === 1 ? all[0] : fullySigned.length === 1 ? fullySigned[0] : undefined;
  if (chosen === undefined) {
    return { disposition: "indeterminate", reason: "bundle-binding-equivocation" };
  }
  const pick = chosen.find((entry) => entry.fullySigned) ?? chosen[0]!;
  return {
    disposition: "present",
    binding: clone(pick.binding),
    copy: clone(pick.copy),
    fullySigned: pick.fullySigned,
  };
}
