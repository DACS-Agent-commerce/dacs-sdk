import { types as nodeTypes } from "node:util";

import type {
  AnchorReceipt,
  AttestationRef,
  BundleBinding,
  FaultAttestationBundle,
} from "../artifacts/types.js";
import {
  BUNDLE_BINDING_SEPARATOR,
  isAnchorReceipt,
  isBundleBinding,
  isCanonicalBase64Url,
  isFaultAttestationBundle,
} from "../artifacts/index.js";
import { bundleAddress, canonicalize, contentHash } from "../canonical/index.js";
import { snapshotCanonicalJsonRead } from "../canonical/snapshot.js";
import { signedBytes } from "../crypto/index.js";
import { DacsError } from "../errors.js";
import {
  isCanonicalClaimReference,
  sameCanonicalClaimIdentity,
} from "../identity/claimReference.js";
import {
  verifyBundleCopy,
  type BundleCopyDeps,
} from "../agent/bundleCopyValidity.js";
import { bundleConsistency } from "../agent/bundleConsistency.js";
import { attestationBundleHash } from "../agent/twoSidedBundle.js";
import {
  verifyBundleCore,
  type VerifyBundleDeps,
} from "../agent/verifyBundleCore.js";
import {
  combineFixedPriceX402OrderStatus,
  type FixedPriceX402CombinedOrderStatus,
  type FixedPriceX402CoordinatorRole,
  type FixedPriceX402OrderStatus,
} from "./fixedPriceX402Coordinator.js";

export type FixedPriceX402AuditVerificationDisposition =
  | { disposition: "valid" }
  | { disposition: "invalid" | "indeterminate" | "error"; reason: string };

export interface FixedPriceX402CompletedBundleCopy {
  role: FixedPriceX402CoordinatorRole;
  nativeAddress: string;
  bundle: Readonly<FaultAttestationBundle>;
  anchorReceipt: Readonly<AnchorReceipt>;
  /** Required only for a write-input SR-2 mapping. */
  binding?: Readonly<BundleBinding>;
}

export interface FixedPriceX402AuditCompletionInput {
  buyer: Readonly<FixedPriceX402OrderStatus>;
  seller: Readonly<FixedPriceX402OrderStatus>;
  mapping: "pure" | "write-input";
  copies: Readonly<{
    buyer: Readonly<FixedPriceX402CompletedBundleCopy>;
    seller: Readonly<FixedPriceX402CompletedBundleCopy>;
  }>;
}

export interface FixedPriceX402AuditCompletionDeps {
  /** Recursive DACS-5 verifier for the exact independently readable bundle. */
  verifyBundle: VerifyBundleDeps;
  /** Exact signer-set / address-role verifier for each fetched copy. */
  bundleCopyVerifier: BundleCopyDeps;
  /**
   * Resolve the finalized CORE §5.1 receipt for every reference carried by the
   * bundle. `null` is fail-closed; an artifact read is not receipt finality.
   */
  resolveFinalizedDependencyReceipt(
    ref: Readonly<AttestationRef>,
    bundle: Readonly<FaultAttestationBundle>,
    role: FixedPriceX402CoordinatorRole,
  ): Promise<Readonly<AnchorReceipt> | null> | Readonly<AnchorReceipt> | null;
  /**
   * Independently read the referenced artifact at the authenticated receipt's
   * exact native address (ST-11 step 2). Returning `null` is fail-closed.
   */
  readFinalizedDependencyArtifact(
    nativeAddress: string,
    ref: Readonly<AttestationRef>,
    bundle: Readonly<FaultAttestationBundle>,
    role: FixedPriceX402CoordinatorRole,
  ): Promise<Readonly<Record<string, unknown>> | null> |
    Readonly<Record<string, unknown>> | null;
  /** Method-native authenticity/finality gate for dependency and bundle receipts. */
  verifyAnchorReceipt(
    receipt: Readonly<AnchorReceipt>,
  ):
    | Promise<FixedPriceX402AuditVerificationDisposition>
    | FixedPriceX402AuditVerificationDisposition;
  /**
   * Required for BB-1..BB-8 on write-input mappings. It must authenticate the
   * binding's method-native publication/finality, not merely recheck its local
   * signature. Ignored on pure mappings.
   */
  verifyBundleBinding?: (
    binding: Readonly<BundleBinding>,
  ) =>
    | Promise<FixedPriceX402AuditVerificationDisposition>
    | FixedPriceX402AuditVerificationDisposition;
}

const clone = <T>(value: T): T => structuredClone(value);
const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    !nodeTypes.isProxy(value);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key)) &&
    optional.every((key) => !hasOwn(value, key) || value[key] !== undefined);
}

function verificationDisposition(
  value: unknown,
  label: string,
): FixedPriceX402AuditVerificationDisposition {
  const retained = snapshotCanonicalJsonRead(value, `${label} disposition`);
  if (!isRecord(retained)) throw new DacsError(`${label} returned a malformed disposition`);
  if (retained.disposition === "valid" && exactKeys(retained, ["disposition"])) {
    return { disposition: "valid" };
  }
  if ((retained.disposition === "invalid" || retained.disposition === "indeterminate" ||
      retained.disposition === "error") && exactKeys(retained, ["disposition", "reason"]) &&
      typeof retained.reason === "string" && retained.reason.length > 0) {
    return retained as unknown as FixedPriceX402AuditVerificationDisposition;
  }
  throw new DacsError(`${label} returned a malformed disposition`);
}

function objectBoundary(value: unknown, label: string): object {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      nodeTypes.isProxy(value)) {
    throw new DacsError(`${label} is malformed`);
  }
  return value;
}

function method<T extends (...args: never[]) => unknown>(
  source: object,
  key: string,
  label: string,
  optional = false,
): T | undefined {
  const visited = new Set<object>();
  let current: object | null = source;
  while (current !== null && !visited.has(current)) {
    if (nodeTypes.isProxy(current)) throw new DacsError(`${label}.${key} is malformed`);
    visited.add(current);
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function" ||
          nodeTypes.isProxy(descriptor.value)) {
        throw new DacsError(`${label}.${key} must be a data method`);
      }
      return descriptor.value.bind(source) as T;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  if (optional) return undefined;
  throw new DacsError(`${label}.${key} is required`);
}

function dataProperty<T>(source: object, key: string, label: string): T {
  const visited = new Set<object>();
  let current: object | null = source;
  while (current !== null && !visited.has(current)) {
    if (nodeTypes.isProxy(current)) throw new DacsError(`${label}.${key} is malformed`);
    visited.add(current);
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      if (!("value" in descriptor) || descriptor.value === undefined) {
        throw new DacsError(`${label}.${key} must be a data property`);
      }
      return descriptor.value as T;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  throw new DacsError(`${label}.${key} is required`);
}

function captureBundleVerifier(value: unknown): VerifyBundleDeps {
  const source = objectBoundary(value, "recursive bundle verifier");
  const readArtifact = method<VerifyBundleDeps["readArtifact"]>(
    source,
    "readArtifact",
    "recursive bundle verifier",
  )!;
  const resolvePublicKey = method<VerifyBundleDeps["resolvePublicKey"]>(
    source,
    "resolvePublicKey",
    "recursive bundle verifier",
  )!;
  const verify = method<VerifyBundleDeps["verify"]>(
    source,
    "verify",
    "recursive bundle verifier",
  )!;
  const resolveAttestationRef = method<NonNullable<VerifyBundleDeps["resolveAttestationRef"]>>(
    source,
    "resolveAttestationRef",
    "recursive bundle verifier",
    true,
  );
  const resolveListingRef = method<NonNullable<VerifyBundleDeps["resolveListingRef"]>>(
    source,
    "resolveListingRef",
    "recursive bundle verifier",
    true,
  );
  const resolveRef = method<NonNullable<VerifyBundleDeps["resolveRef"]>>(
    source,
    "resolveRef",
    "recursive bundle verifier",
    true,
  );
  const verifyEvidence = method<NonNullable<VerifyBundleDeps["verifyEvidence"]>>(
    source,
    "verifyEvidence",
    "recursive bundle verifier",
    true,
  );
  const verifyCompositeRecord = method<NonNullable<VerifyBundleDeps["verifyCompositeRecord"]>>(
    source,
    "verifyCompositeRecord",
    "recursive bundle verifier",
    true,
  );
  return Object.freeze({
    readArtifact,
    resolvePublicKey,
    verify,
    ...(resolveAttestationRef ? { resolveAttestationRef } : {}),
    ...(resolveListingRef ? { resolveListingRef } : {}),
    ...(resolveRef ? { resolveRef } : {}),
    ...(verifyEvidence ? { verifyEvidence } : {}),
    ...(verifyCompositeRecord ? { verifyCompositeRecord } : {}),
  });
}

function captureCopyVerifier(value: unknown): BundleCopyDeps {
  const source = objectBoundary(value, "bundle-copy verifier");
  const resolve = method<BundleCopyDeps["resolvePublicKey"]>(
    source,
    "resolvePublicKey",
    "bundle-copy verifier",
  )!;
  const verify = method<BundleCopyDeps["verify"]>(
    source,
    "verify",
    "bundle-copy verifier",
  )!;
  const captured: BundleCopyDeps = {
    resolvePublicKey: async (claim: string) => {
      const key = await resolve(claim);
      return key instanceof Uint8Array ? new Uint8Array(key) : null;
    },
    verify: async (
      message: Uint8Array,
      signature: Uint8Array,
      publicKey: Uint8Array,
    ) =>
      await verify(
        new Uint8Array(message),
        new Uint8Array(signature),
        new Uint8Array(publicKey),
      ) === true,
  };
  return Object.freeze(captured);
}

function captureInput(value: unknown): FixedPriceX402AuditCompletionInput {
  const retained = snapshotCanonicalJsonRead(value, "fixed-price x402 audit completion input");
  if (!isRecord(retained) || !exactKeys(retained, ["buyer", "seller", "mapping", "copies"]) ||
      (retained.mapping !== "pure" && retained.mapping !== "write-input") ||
      !isRecord(retained.copies) || !exactKeys(retained.copies, ["buyer", "seller"])) {
    throw new DacsError("fixed-price x402 audit completion input is malformed");
  }
  for (const role of ["buyer", "seller"] as const) {
    const copy = retained.copies[role];
    if (!isRecord(copy) || !exactKeys(
      copy,
      ["role", "nativeAddress", "bundle", "anchorReceipt"],
      ["binding"],
    ) || copy.role !== role) {
      throw new DacsError(`fixed-price x402 ${role} completion copy is malformed`);
    }
  }
  return retained as unknown as FixedPriceX402AuditCompletionInput;
}

function captureDeps(value: unknown): FixedPriceX402AuditCompletionDeps {
  const source = objectBoundary(value, "fixed-price x402 audit completion dependencies");
  const resolveReceipt = method<
    FixedPriceX402AuditCompletionDeps["resolveFinalizedDependencyReceipt"]
  >(source, "resolveFinalizedDependencyReceipt", "fixed-price x402 audit completion dependencies")!;
  const verifyReceipt = method<FixedPriceX402AuditCompletionDeps["verifyAnchorReceipt"]>(
    source,
    "verifyAnchorReceipt",
    "fixed-price x402 audit completion dependencies",
  )!;
  const readDependency = method<
    FixedPriceX402AuditCompletionDeps["readFinalizedDependencyArtifact"]
  >(source, "readFinalizedDependencyArtifact", "fixed-price x402 audit completion dependencies")!;
  const verifyBinding = method<NonNullable<FixedPriceX402AuditCompletionDeps["verifyBundleBinding"]>>(
    source,
    "verifyBundleBinding",
    "fixed-price x402 audit completion dependencies",
    true,
  );
  const verifyBundle = dataProperty<VerifyBundleDeps>(
    source,
    "verifyBundle",
    "fixed-price x402 audit completion dependencies",
  );
  const bundleCopyVerifier = dataProperty<BundleCopyDeps>(
    source,
    "bundleCopyVerifier",
    "fixed-price x402 audit completion dependencies",
  );
  const captured: FixedPriceX402AuditCompletionDeps = {
    verifyBundle: captureBundleVerifier(verifyBundle),
    bundleCopyVerifier: captureCopyVerifier(bundleCopyVerifier),
    resolveFinalizedDependencyReceipt: async (
      ref: Readonly<AttestationRef>,
      bundle: Readonly<FaultAttestationBundle>,
      role: FixedPriceX402CoordinatorRole,
    ) => {
      const receipt = await resolveReceipt(clone(ref), clone(bundle), role);
      return receipt === null
        ? null
        : snapshotCanonicalJsonRead(receipt, `${role} dependency receipt`);
    },
    readFinalizedDependencyArtifact: async (nativeAddress, ref, bundle, role) => {
      const artifact = await readDependency(
        nativeAddress,
        clone(ref),
        clone(bundle),
        role,
      );
      return artifact === null
        ? null
        : snapshotCanonicalJsonRead(artifact, `${role} native dependency artifact`);
    },
    verifyAnchorReceipt: async (receipt: Readonly<AnchorReceipt>) =>
      verifyReceipt(clone(receipt)),
    ...(verifyBinding
      ? { verifyBundleBinding: async (binding: Readonly<BundleBinding>) =>
          verifyBinding(clone(binding)) }
      : {}),
  };
  return Object.freeze(captured);
}

function exact(left: unknown, right: unknown): boolean {
  try {
    return canonicalize(left) === canonicalize(right);
  } catch {
    return false;
  }
}

function roleParty(
  bundle: Readonly<FaultAttestationBundle>,
  role: FixedPriceX402CoordinatorRole,
): string {
  const matches = bundle.parties.filter((party) => party.role === role);
  if (matches.length !== 1 || !isCanonicalClaimReference(matches[0]!.primaryClaim)) {
    throw new DacsError(`completed ${role} bundle does not identify one canonical ${role}`);
  }
  return matches[0]!.primaryClaim;
}

function referencedArtifacts(bundle: Readonly<FaultAttestationBundle>): AttestationRef[] {
  return [
    ...(bundle.agreementRef ? [bundle.agreementRef] : []),
    ...bundle.vetRecords,
    ...bundle.settlementEvidence,
    ...(bundle.amendments ?? []),
    ...(bundle.ratingRefs ?? []),
  ].map(clone);
}

async function requireValidReceipt(
  receipt: unknown,
  expected: Readonly<{
    logicalAddress: string;
    nativeAddress?: string;
    contentHash: string;
    writer?: string;
  }>,
  deps: FixedPriceX402AuditCompletionDeps,
  label: string,
): Promise<AnchorReceipt> {
  if (!isAnchorReceipt(receipt) || receipt.state !== "finalized" ||
      receipt.observationDisposition !== "established" ||
      receipt.logicalAddress !== expected.logicalAddress ||
      receipt.contentHash !== expected.contentHash ||
      (expected.nativeAddress !== undefined && receipt.nativeAddress !== expected.nativeAddress) ||
      (expected.writer !== undefined &&
        !sameCanonicalClaimIdentity(receipt.writer, expected.writer))) {
    throw new DacsError(`${label} is not the exact established finalized receipt`);
  }
  const retained = clone(receipt);
  const disposition = verificationDisposition(
    await deps.verifyAnchorReceipt(clone(retained)),
    `${label} verifier`,
  );
  if (disposition.disposition !== "valid") {
    throw new DacsError(`${label} verification is ${disposition.disposition}`);
  }
  return retained;
}

async function requireBinding(
  copy: Readonly<FixedPriceX402CompletedBundleCopy>,
  bundleHash: string,
  deps: FixedPriceX402AuditCompletionDeps,
): Promise<void> {
  const binding = copy.binding;
  const party = roleParty(copy.bundle, copy.role);
  if (!binding || !isBundleBinding(binding) || binding.jobId !== copy.bundle.jobId ||
      binding.role !== copy.role ||
      binding.logicalAddress !== bundleAddress(copy.bundle.jobId, copy.role) ||
      binding.nativeAddress !== copy.nativeAddress ||
      binding.bundleContentHash !== bundleHash ||
      !sameCanonicalClaimIdentity(binding.signer, party) ||
      !sameCanonicalClaimIdentity(binding.signature.signer, binding.signer) ||
      binding.signature.algorithm !== "ed25519" ||
      !isCanonicalBase64Url(binding.signature.value)) {
    throw new DacsError(`completed ${copy.role} bundle lacks its exact BB-1 binding`);
  }
  const signature = Uint8Array.from(Buffer.from(binding.signature.value, "base64url"));
  const key = await deps.bundleCopyVerifier.resolvePublicKey(binding.signer);
  if (!key || key.byteLength !== 32 || signature.byteLength !== 64 ||
      !(await deps.bundleCopyVerifier.verify(
        signedBytes(
          BUNDLE_BINDING_SEPARATOR,
          contentHash(binding as unknown as Record<string, unknown>),
        ),
        signature,
        new Uint8Array(key),
      ))) {
    throw new DacsError(`completed ${copy.role} BundleBinding signature is invalid`);
  }
  if (!deps.verifyBundleBinding) {
    throw new DacsError("write-input audit requires a BundleBinding verifier");
  }
  const disposition = verificationDisposition(
    await deps.verifyBundleBinding(clone(binding)),
    `${copy.role} BundleBinding verifier`,
  );
  if (disposition.disposition !== "valid") {
    throw new DacsError(
      `completed ${copy.role} BundleBinding verification is ${disposition.disposition}`,
    );
  }
}

async function verifyCopy(
  copy: Readonly<FixedPriceX402CompletedBundleCopy>,
  status: Readonly<FixedPriceX402OrderStatus>,
  mapping: "pure" | "write-input",
  deps: FixedPriceX402AuditCompletionDeps,
): Promise<Record<string, unknown>> {
  if (copy.role !== status.role || !isFaultAttestationBundle(copy.bundle) ||
      copy.bundle.faultBundleVersion !== "1" || copy.bundle.bundleVersion !== undefined ||
      copy.bundle.outcome !== "completed" || copy.bundle.faultedParty !== "none" ||
      copy.bundle.anchoredByRole !== copy.role || copy.bundle.jobId !== status.jobId ||
      typeof copy.nativeAddress !== "string" || copy.nativeAddress.length === 0) {
    throw new DacsError(`completed ${status.role} bundle has the wrong type or session binding`);
  }
  if (copy.bundle.parties.length !== 2 ||
      copy.bundle.parties.some((party) => party.role === "orchestrator")) {
    throw new DacsError(
      `completed ${status.role} bundle contradicts the seller-as-orchestrator topology`,
    );
  }
  const buyer = roleParty(copy.bundle, "buyer");
  const seller = roleParty(copy.bundle, "seller");
  if (!sameCanonicalClaimIdentity(buyer, status.buyer) ||
      !sameCanonicalClaimIdentity(seller, status.seller)) {
    throw new DacsError(`completed ${status.role} bundle changed an order party`);
  }
  const copyObject = clone(copy.bundle) as unknown as Record<string, unknown>;
  const local = await verifyBundleCopy(copyObject, copy.role, deps.bundleCopyVerifier);
  if (!local.valid || !local.fullySigned || local.abortStanding) {
    throw new DacsError(
      local.valid
        ? `completed ${copy.role} bundle is not fully signed`
        : `completed ${copy.role} bundle signature verification failed: ${local.reason}`,
    );
  }

  const recursive = await verifyBundleCore(copy.nativeAddress, deps.verifyBundle);
  if (!recursive.ok || !recursive.fullyVerified || !recursive.bundle ||
      !isFaultAttestationBundle(recursive.bundle) || !exact(recursive.bundle, copy.bundle)) {
    throw new DacsError(
      `completed ${copy.role} bundle is not independently resolvable with full recursive verification`,
    );
  }

  const bundleHash = attestationBundleHash(copy.bundle);
  await requireValidReceipt(copy.anchorReceipt, {
    logicalAddress: bundleAddress(copy.bundle.jobId, copy.role),
    nativeAddress: copy.nativeAddress,
    contentHash: bundleHash,
    writer: roleParty(copy.bundle, copy.role),
  }, deps, `${copy.role} bundle receipt`);

  for (const ref of referencedArtifacts(copy.bundle)) {
    const receipt = await deps.resolveFinalizedDependencyReceipt(
      clone(ref),
      clone(copy.bundle),
      copy.role,
    );
    if (!receipt) {
      throw new DacsError(
        `completed ${copy.role} bundle dependency ${ref.anchor.locator} has no finalized receipt`,
      );
    }
    const retainedReceipt = await requireValidReceipt(receipt, {
      logicalAddress: ref.anchor.locator,
      contentHash: ref.contentHash,
    }, deps, `${copy.role} dependency ${ref.anchor.locator}`);
    if (!copy.bundle.parties.some((party) =>
      sameCanonicalClaimIdentity(party.primaryClaim, retainedReceipt.writer))) {
      throw new DacsError(
        `completed ${copy.role} dependency ${ref.anchor.locator} has an unauthorized writer`,
      );
    }
    const artifact = await deps.readFinalizedDependencyArtifact(
      retainedReceipt.nativeAddress,
      clone(ref),
      clone(copy.bundle),
      copy.role,
    );
    if (!artifact || contentHash(artifact) !== ref.contentHash) {
      throw new DacsError(
        `completed ${copy.role} dependency ${ref.anchor.locator} is not readable at its finalized native address`,
      );
    }
  }

  if (mapping === "write-input") {
    await requireBinding(copy, bundleHash, deps);
  } else if (copy.binding !== undefined) {
    throw new DacsError(`pure ${copy.role} bundle mapping must not carry a BundleBinding`);
  }
  return copyObject;
}

/**
 * DACS-5 §10.3.1 ST-11 completion gate, checked against Standard `next`
 * 81ded2b49851d8fa17399e3fdade9e36e33a4ff7.
 *
 * The synchronous combiner is intentionally operational and can never return
 * `audit-complete`. Only this function upgrades a pair after independently
 * verifying both finalized copies, their complete recursive reference graphs,
 * every CORE §5.1 receipt, pair consistency, and applicable BB-1 publication.
 */
export async function verifyFixedPriceX402AuditCompletion(
  input: Readonly<FixedPriceX402AuditCompletionInput>,
  deps: FixedPriceX402AuditCompletionDeps,
): Promise<FixedPriceX402CombinedOrderStatus> {
  const retained = captureInput(input);
  const capturedDeps = captureDeps(deps);
  const operational = combineFixedPriceX402OrderStatus({
    buyer: retained.buyer,
    seller: retained.seller,
  });
  if (retained.buyer.tracks.audit?.state !== "final" ||
      retained.buyer.tracks.audit.outcome !== "success" ||
      retained.seller.tracks.audit?.state !== "final" ||
      retained.seller.tracks.audit.outcome !== "success" ||
      retained.buyer.tracks.audit.reference !== retained.copies.buyer.nativeAddress ||
      retained.seller.tracks.audit.reference !== retained.copies.seller.nativeAddress) {
    throw new DacsError(
      "audit completion requires both operational audit tracks to reference their exact bundle",
    );
  }
  const [buyerBundle, sellerBundle] = await Promise.all([
    verifyCopy(retained.copies.buyer, retained.buyer, retained.mapping, capturedDeps),
    verifyCopy(retained.copies.seller, retained.seller, retained.mapping, capturedDeps),
  ]);
  const consistency = await bundleConsistency({
    buyer: { disposition: "present", bundle: buyerBundle },
    seller: { disposition: "present", bundle: sellerBundle },
  }, {
    isValid: async (bundle, role) => {
      const verdict = await verifyBundleCopy(bundle, role, capturedDeps.bundleCopyVerifier);
      return verdict.valid && verdict.fullySigned && !verdict.abortStanding;
    },
  });
  if (consistency !== "unified") {
    throw new DacsError(`completed bundle pair is ${consistency}, not unified`);
  }
  return clone({ ...operational, milestone: "audit-complete" as const });
}
