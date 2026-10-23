import { types as nodeTypes } from "node:util";
import { snapshotCanonicalJsonRead } from "../canonical/snapshot.js";
/**
 * DACS-5 §10.4.2 BB-5..BB-7 candidate-set resolution for one `(jobId, role)`
 * on a write-input-mapping substrate.
 *
 * The caller supplies every signed `BundleBinding` it discovered, from all the
 * surfaces it consulted (its §6.3.5 well-known index, §6.3.6 catalogs, the
 * binding a counterparty carried, a substrate-side binding program). This
 * module applies, in order:
 *
 * - BB-5 checks 1-5 and BB-4: check the wire shape and supported version,
 *   admit the exact session/profile/role map from verifier-owned authority,
 *   select the requested logical address and admitted role holder, authenticate, then check the signed `jobId` and logical address
 *   derived from the binding's own signed `jobId` and `role`. Failing bindings
 *   are discarded.
 * - BB-6: candidates grouped by authenticated `signer`, pruned before any fetch
 *   to the independently admitted role holder; each signer's
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
 *
 * Every party join (the role-holder hint, the binding signer, the copy's role
 * holder, the copy's verified signers, and the BB-6 per-signer grouping) is a
 * CORE B.1 CF-3 identity comparison: scheme and identifier, never advisory
 * parameters. Signatures are still checked over each binding's exact bytes.
 */

import type { BundleBinding } from "../artifacts/types.js";
import { hasBundleBindingEnvelope, isBundleBinding } from "../artifacts/validators.js";
import { bundleAddress, canonicalize } from "../canonical/index.js";
import { DacsError, IndeterminateSubstrateError, SubstrateError } from "../errors.js";
import { parseCanonicalClaimReference, sameCanonicalClaimIdentity } from "../identity/claimReference.js";
import { requireCanonicalJobId } from "../negotiate/jobId.js";
import type { BundleCopyRole, CopyValidity } from "../agent/bundleCopyValidity.js";
import { attestationBundleHash } from "../agent/twoSidedBundle.js";
import { authenticateSessionProfile, type AuthenticateSessionProfile } from "./sessionProfileAdmission.js";

/**
 * BB-6: N, the fetch budget per authenticated signer per `(jobId, role)`.
 * Every distinct native address of the admitted signer counts, including one
 * whose copy later proves inert. That reading is more conservative than
 * counting only authorized candidates: it is `indeterminate` more often and
 * never yields a wrong `present`.
 */
export const BUNDLE_BINDING_FETCH_BUDGET = 8;

export interface ResolveBundleBindingCandidatesInput {
  /** Required independent session/role/release/module admission before resolution. */
  authenticateSessionProfile: AuthenticateSessionProfile;
  jobId: string;
  role: BundleCopyRole;
  /** Raw records from every consulted discovery surface; untrusted. */
  candidates: readonly unknown[];
  /**
   * Optional assertion about the expected holder. Independent profile admission
   * must establish this same participant (CF-3 identity); caller input never
   * supplies authority.
   * Only the admitted holder's bindings are authenticated or fetched.
   */
  roleHolder?: string;
  /**
   * BB-4: verify the exact domain-separated payload against the signer's key.
   * The wire envelope is checked; jobId semantics are checked after this hook.
   */
  verifyBindingSignature(
    binding: Readonly<Omit<BundleBinding, "jobId"> & { jobId: unknown }>,
  ): Promise<boolean> | boolean;
  /**
   * BB-5 step 6: the copy at an exact native address. Return null when nothing
   * is readable there yet. Throw a `DacsError` that is not a `SubstrateError`
   * for content or a receipt that is invalid (the candidate is then inert);
   * any other throw is an unanswered read.
   */
  fetchCopy(
    nativeAddress: string,
  ): Promise<Readonly<Record<string, unknown>> | null> | Readonly<Record<string, unknown>> | null;
  /** Substrate-specific binding/receipt consistency, checked before BB-6 collapse. */
  verifyBindingCopy?(binding: Readonly<BundleBinding>, copy: Readonly<Record<string, unknown>>):
    Promise<boolean> | boolean;
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

/** CORE B.1 CF-3 party key: parameters never split one signer's BB-6 budget. */
function claimIdentityKey(claim: string): string {
  const parsed = parseCanonicalClaimReference(claim)!;
  return `${parsed.identity.scheme}:${parsed.identity.identifier}`;
}

/** Resolve one side's read disposition from its discovered bindings (BB-5..BB-7). */
export async function resolveBundleBindingCandidates(
  input: Readonly<ResolveBundleBindingCandidatesInput>,
): Promise<BundleBindingCandidateResolution> {
  requireCanonicalJobId(input.jobId, "BundleBinding requested jobId");
  // Capture the request and candidate bytes before invoking application code.
  if (!Array.isArray(input.candidates) || nodeTypes.isProxy(input.candidates)) {
    throw new IndeterminateSubstrateError("BundleBinding candidate list exceeds its admission limit");
  }
  const candidates = Array.from({ length: input.candidates.length }, (_, index) => {
    const entry = Object.getOwnPropertyDescriptor(input.candidates, String(index));
    if (entry === undefined || !("value" in entry)) return null;
    try { return snapshotCanonicalJsonRead(entry.value, "BundleBinding candidate"); }
    catch { return null; }
  });
  input = { ...input, candidates };
  const admitted = await authenticateSessionProfile(input.authenticateSessionProfile, { jobId: input.jobId }, input.role);
  const roleHolder = admitted[input.role]!;
  if (input.roleHolder !== undefined && !sameCanonicalClaimIdentity(input.roleHolder, roleHolder)) {
    throw new DacsError("requested role holder differs from authenticated profile authority");
  }
  const logicalAddress = bundleAddress(input.jobId, input.role);
  // Select this request's scope before authenticating a captured envelope or
  // interpreting its signed jobId. Neither unrelated signed records nor
  // unsigned catalog noise can supply a validation answer for this request.
  const scoped = new Map<string, unknown>();
  for (const candidate of input.candidates) {
    if (!hasBundleBindingEnvelope(candidate) || candidate.logicalAddress !== logicalAddress ||
        candidate.role !== input.role || !sameCanonicalClaimIdentity(candidate.signer, roleHolder)) continue;
    scoped.set(canonicalize(candidate), candidate);
  }
  // Bound authentication work only after unrelated records and repeated
  // discoveries of the same envelope have been removed.
  if (scoped.size > 1024) {
    return { disposition: "indeterminate", reason: "bundle-binding-budget-exhausted" };
  }
  const unique = new Map<string, BundleBinding>();
  for (const raw of scoped.values()) {
    let candidate: unknown;
    try {
      candidate = clone(raw);
    } catch {
      continue;
    }
    if (!hasBundleBindingEnvelope(candidate)) continue;
    if (candidate.logicalAddress !== logicalAddress || candidate.role !== input.role ||
        !sameCanonicalClaimIdentity(candidate.signer, roleHolder)) continue;
    let signed = false;
    try {
      // The hook sees the actual signed payload, including an unchecked
      // jobId, and gets its own copy so it cannot change the retained bytes.
      signed = await input.verifyBindingSignature(clone(candidate));
    } catch {
      signed = false;
    }
    if (signed !== true) continue;
    requireCanonicalJobId(candidate.jobId, "BundleBinding signed jobId");
    if (!isBundleBinding(candidate) || candidate.jobId !== input.jobId ||
        candidate.role !== input.role) continue;
    unique.set(canonicalize(candidate), candidate);
  }
  const bindings = [...unique.values()];
  if (bindings.length === 0) {
    return { disposition: "indeterminate", reason: "bundle-binding-undiscovered" };
  }

  const bySigner = new Map<string, BundleBinding[]>();
  for (const binding of bindings) {
    const signer = claimIdentityKey(binding.signer);
    const group = bySigner.get(signer) ?? [];
    group.push(binding);
    bySigner.set(signer, group);
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
        copy = await input.fetchCopy(address) as Record<string, unknown> | null;
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
        copy = clone(copy);
        hash = attestationBundleHash(copy as never);
      } catch {
        // Bytes were fetched; noncanonical/unhashable content is invalid,
        // not an unavailable read, and cannot suppress another valid copy.
        continue;
      }
      try {
        validity = await input.verifyCopy(clone(copy), input.role);
      } catch (error) {
        if (!(error instanceof DacsError) || error instanceof SubstrateError) unfetched = true;
        continue;
      }
      const holder = roleHolderOf(copy, input.role);
      for (const binding of ordered.filter((entry) => entry.nativeAddress === address)) {
        // BB-5 checks 7-9; a copy failing them is inert (BB-6).
        if (copy["jobId"] !== binding.jobId || hash !== binding.bundleContentHash ||
            !validity.valid || !sameCanonicalClaimIdentity(holder, binding.signer) ||
            !validity.signers.some((signer) => sameCanonicalClaimIdentity(signer, binding.signer))) continue;
        if (input.verifyBindingCopy) {
          try {
            if (await input.verifyBindingCopy(clone(binding), clone(copy)) !== true) continue;
          } catch (error) {
            if (!(error instanceof DacsError) || error instanceof SubstrateError) unfetched = true;
            continue;
          }
        }
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
