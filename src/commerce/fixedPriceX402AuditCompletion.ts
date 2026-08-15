import { types as nodeTypes } from "node:util";

import type {
  AnchorReceipt,
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
import {
  attestationBundleHash,
  bundleSignedScope,
} from "../agent/twoSidedBundle.js";
import {
  verifyFinalizedSellerBundleReadOnly,
  type FinalizedSellerBundle,
  type SellerBundleFinalizationReadProvider,
  type VerifyFinalizedSellerBundleInput,
} from "../seller/bundleFinalization.js";
import {
  combineFixedPriceX402OrderStatus,
  type FixedPriceX402CombinedOrderStatus,
  type FixedPriceX402CoordinatorRole,
  type FixedPriceX402OrderStatus,
} from "./fixedPriceX402Coordinator.js";

export type FixedPriceX402AuditVerificationDisposition =
  | { disposition: "valid" }
  | { disposition: "invalid" | "indeterminate" | "error"; reason: string };

/**
 * Authenticated CORE §6.2 mapping classification for one independently read
 * role-owned bundle copy. `valid` means the adapter has also authenticated the
 * supplied receipt and, for a pure mapping, re-derived `nativeAddress` from
 * `logicalAddress`. Demos is always the write-input case (DEMOS-MAPPING §A.2).
 */
export type FixedPriceX402BundleAnchorVerificationDisposition =
  | { disposition: "valid"; mapping: "pure" | "write-input" }
  | { disposition: "invalid" | "indeterminate" | "error"; reason: string };

export interface FixedPriceX402CompletedBundleCopy {
  role: FixedPriceX402CoordinatorRole;
  nativeAddress: string;
  bundle: Readonly<FaultAttestationBundle>;
  anchorReceipt: Readonly<AnchorReceipt>;
  /** Required only when this copy's authenticated substrate mapping is write-input. */
  binding?: Readonly<BundleBinding>;
}

/**
 * The exact durable `audit-pending` session closure and retained seller
 * finalization result. The SDK re-authenticates both with the existing strict
 * seller ST-11 verifier; this is not a caller-selected expected-ref list.
 */
export interface FixedPriceX402SellerCompletionClosure {
  verificationInput: Readonly<VerifyFinalizedSellerBundleInput>;
  result: Readonly<FinalizedSellerBundle>;
}

export interface FixedPriceX402AuditCompletionInput {
  buyer: Readonly<FixedPriceX402OrderStatus>;
  seller: Readonly<FixedPriceX402OrderStatus>;
  sellerClosure: Readonly<FixedPriceX402SellerCompletionClosure>;
  copies: Readonly<{
    buyer: Readonly<FixedPriceX402CompletedBundleCopy>;
    seller: Readonly<FixedPriceX402CompletedBundleCopy>;
  }>;
}

export interface FixedPriceX402AuditCompletionDeps {
  /**
   * Existing strict seller finalization provider. Its dependency graph is the
   * authoritative completed-session manifest: Listing, DACS-2 composites,
   * AgreementArtifact, DACS-3 commitment, every executed DACS-4 evidence
   * record, and the complete transitive DPA closure are all verified here.
   */
  sellerFinalizationProvider: SellerBundleFinalizationReadProvider;
  /** Independently read an exact role-owned bundle at its native address. */
  readBundleCopy(
    nativeAddress: string,
    role: FixedPriceX402CoordinatorRole,
  ):
    | Promise<Readonly<Record<string, unknown>> | null>
    | Readonly<Record<string, unknown>>
    | null;
  /**
   * Authenticate this exact bundle receipt and establish its mapping class.
   * For a pure mapping the adapter MUST re-derive the native address. For a
   * write-input mapping it MUST authenticate the receipt's native publication;
   * BB-1..BB-8 verification is additionally required below.
   */
  verifyBundleAnchor(
    copy: Readonly<FixedPriceX402CompletedBundleCopy>,
  ):
    | Promise<FixedPriceX402BundleAnchorVerificationDisposition>
    | FixedPriceX402BundleAnchorVerificationDisposition;
  /**
   * Required for each write-input copy. The adapter must apply BB-4..BB-8,
   * including candidate authorization, multiplicity, fetch bounds, and
   * suppression diligence, before returning one resolved binding.
   */
  resolveBundleBinding?: (
    logicalAddress: string,
    signer: string,
    role: FixedPriceX402CoordinatorRole,
  ) =>
    | Promise<
      | { disposition: "present"; binding: unknown }
      | { disposition: "absent" }
      | { disposition: "indeterminate"; reason: string }
    >
    | { disposition: "present"; binding: unknown }
    | { disposition: "absent" }
    | { disposition: "indeterminate"; reason: string };
  /**
   * Required for each write-input copy. It authenticates method-native
   * publication/finality after the SDK's local checks and exact resolver
   * readback comparison.
   */
  verifyBundleBinding?: (
    binding: Readonly<BundleBinding>,
  ) =>
    | Promise<FixedPriceX402AuditVerificationDisposition>
    | FixedPriceX402AuditVerificationDisposition;
}

interface CapturedAuditCompletionDeps {
  sellerFinalizationProvider: SellerBundleFinalizationReadProvider;
  sellerMapping: "pure" | "write-input";
  bundleCopyVerifier: BundleCopyDeps;
  readBundleCopy: FixedPriceX402AuditCompletionDeps["readBundleCopy"];
  verifyBundleAnchor: FixedPriceX402AuditCompletionDeps["verifyBundleAnchor"];
  resolveBundleBinding?: NonNullable<
    FixedPriceX402AuditCompletionDeps["resolveBundleBinding"]
  >;
  verifyBundleBinding?: NonNullable<
    FixedPriceX402AuditCompletionDeps["verifyBundleBinding"]
  >;
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

function anchorVerificationDisposition(
  value: unknown,
  label: string,
): FixedPriceX402BundleAnchorVerificationDisposition {
  const retained = snapshotCanonicalJsonRead(value, `${label} disposition`);
  if (!isRecord(retained)) throw new DacsError(`${label} returned a malformed disposition`);
  if (retained.disposition === "valid" &&
      exactKeys(retained, ["disposition", "mapping"]) &&
      (retained.mapping === "pure" || retained.mapping === "write-input")) {
    return retained as unknown as FixedPriceX402BundleAnchorVerificationDisposition;
  }
  if ((retained.disposition === "invalid" || retained.disposition === "indeterminate" ||
      retained.disposition === "error") && exactKeys(retained, ["disposition", "reason"]) &&
      typeof retained.reason === "string" && retained.reason.length > 0) {
    return retained as unknown as FixedPriceX402BundleAnchorVerificationDisposition;
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
  return Object.freeze({
    resolvePublicKey: async (claim: string) => {
      const key = await resolve(claim);
      return key instanceof Uint8Array ? new Uint8Array(key) : null;
    },
    verify: async (
      message: Uint8Array,
      signature: Uint8Array,
      publicKey: Uint8Array,
    ) => await verify(
      new Uint8Array(message),
      new Uint8Array(signature),
      new Uint8Array(publicKey),
    ) === true,
  });
}

function captureInput(value: unknown): FixedPriceX402AuditCompletionInput {
  const retained = snapshotCanonicalJsonRead(value, "fixed-price x402 audit completion input");
  if (!isRecord(retained) ||
      !exactKeys(retained, ["buyer", "seller", "sellerClosure", "copies"]) ||
      !isRecord(retained.sellerClosure) ||
      !exactKeys(retained.sellerClosure, ["verificationInput", "result"]) ||
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

function captureDeps(value: unknown): CapturedAuditCompletionDeps {
  const source = objectBoundary(value, "fixed-price x402 audit completion dependencies");
  const readBundleCopy = method<FixedPriceX402AuditCompletionDeps["readBundleCopy"]>(
    source,
    "readBundleCopy",
    "fixed-price x402 audit completion dependencies",
  )!;
  const verifyBundleAnchor = method<FixedPriceX402AuditCompletionDeps["verifyBundleAnchor"]>(
    source,
    "verifyBundleAnchor",
    "fixed-price x402 audit completion dependencies",
  )!;
  const verifyBundleBinding = method<
    NonNullable<FixedPriceX402AuditCompletionDeps["verifyBundleBinding"]>
  >(
    source,
    "verifyBundleBinding",
    "fixed-price x402 audit completion dependencies",
    true,
  );
  const resolveBundleBinding = method<
    NonNullable<FixedPriceX402AuditCompletionDeps["resolveBundleBinding"]>
  >(
    source,
    "resolveBundleBinding",
    "fixed-price x402 audit completion dependencies",
    true,
  );
  const sellerFinalizationProvider = dataProperty<SellerBundleFinalizationReadProvider>(
    source,
    "sellerFinalizationProvider",
    "fixed-price x402 audit completion dependencies",
  );
  const provider = objectBoundary(
    sellerFinalizationProvider,
    "seller finalization provider",
  ) as SellerBundleFinalizationReadProvider;
  const sellerMapping = dataProperty<unknown>(
    provider,
    "mapping",
    "seller finalization provider",
  );
  if (sellerMapping !== "pure" && sellerMapping !== "write-input") {
    throw new DacsError("seller finalization provider.mapping is malformed");
  }
  const bundleCopyVerifier = captureCopyVerifier(dataProperty<BundleCopyDeps>(
    provider,
    "bundleCopyVerifier",
    "seller finalization provider",
  ));
  return Object.freeze({
    sellerFinalizationProvider: provider,
    sellerMapping,
    bundleCopyVerifier,
    readBundleCopy: async (
      nativeAddress: string,
      role: FixedPriceX402CoordinatorRole,
    ) => {
      const bundle = await readBundleCopy(nativeAddress, role);
      return bundle === null
        ? null
        : snapshotCanonicalJsonRead(bundle, `${role} native bundle readback`);
    },
    verifyBundleAnchor: async (
      copy: Readonly<FixedPriceX402CompletedBundleCopy>,
    ) => verifyBundleAnchor(clone(copy)),
    ...(resolveBundleBinding
      ? { resolveBundleBinding: async (
          logicalAddress: string,
          signer: string,
          role: FixedPriceX402CoordinatorRole,
        ) => snapshotCanonicalJsonRead(
          await resolveBundleBinding(logicalAddress, signer, role),
          `${role} BundleBinding resolution`,
        ) }
      : {}),
    ...(verifyBundleBinding
      ? { verifyBundleBinding: async (binding: Readonly<BundleBinding>) =>
          verifyBundleBinding(clone(binding)) }
      : {}),
  });
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

function requireExactReceipt(
  copy: Readonly<FixedPriceX402CompletedBundleCopy>,
  bundleHash: string,
): AnchorReceipt {
  const receipt = copy.anchorReceipt;
  const writer = roleParty(copy.bundle, copy.role);
  if (!isAnchorReceipt(receipt) || receipt.state !== "finalized" ||
      receipt.observationDisposition !== "established" ||
      receipt.logicalAddress !== bundleAddress(copy.bundle.jobId, copy.role) ||
      receipt.nativeAddress !== copy.nativeAddress ||
      receipt.contentHash !== bundleHash ||
      !sameCanonicalClaimIdentity(receipt.writer, writer)) {
    throw new DacsError(
      `${copy.role} bundle receipt is not the exact established finalized receipt`,
    );
  }
  return clone(receipt);
}

async function requireBinding(
  copy: Readonly<FixedPriceX402CompletedBundleCopy>,
  bundleHash: string,
  deps: CapturedAuditCompletionDeps,
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
  if (!deps.resolveBundleBinding) {
    throw new DacsError("write-input audit requires a BundleBinding resolver");
  }
  const lookup = await deps.resolveBundleBinding(
    binding.logicalAddress,
    binding.signer,
    copy.role,
  );
  if (!isRecord(lookup) || !(
    (lookup.disposition === "present" && exactKeys(lookup, ["disposition", "binding"])) ||
    (lookup.disposition === "absent" && exactKeys(lookup, ["disposition"])) ||
    (lookup.disposition === "indeterminate" &&
      exactKeys(lookup, ["disposition", "reason"]) &&
      typeof lookup.reason === "string" && lookup.reason.length > 0)
  )) {
    throw new DacsError(`${copy.role} BundleBinding resolver returned a malformed result`);
  }
  if (lookup.disposition !== "present" || !isBundleBinding(lookup.binding) ||
      !exact(lookup.binding, binding)) {
    throw new DacsError(
      lookup.disposition === "indeterminate"
        ? `completed ${copy.role} BundleBinding resolution is indeterminate`
        : `completed ${copy.role} BundleBinding is not independently resolvable and exact`,
    );
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
  deps: CapturedAuditCompletionDeps,
): Promise<{
  bundle: Record<string, unknown>;
  mapping: "pure" | "write-input";
}> {
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

  const readback = await deps.readBundleCopy(copy.nativeAddress, copy.role);
  if (!readback || !exact(readback, copy.bundle)) {
    throw new DacsError(
      `completed ${copy.role} bundle is not independently readable at its exact native address`,
    );
  }

  const bundleHash = attestationBundleHash(copy.bundle);
  const receipt = requireExactReceipt(copy, bundleHash);
  const anchorDisposition = anchorVerificationDisposition(
    await deps.verifyBundleAnchor(clone(copy)),
    `${copy.role} bundle anchor verifier`,
  );
  if (anchorDisposition.disposition !== "valid") {
    throw new DacsError(
      `completed ${copy.role} bundle anchor verification is ${anchorDisposition.disposition}`,
    );
  }
  const mapping = anchorDisposition.mapping;
  if (receipt.substrate === "demos" && mapping !== "write-input") {
    throw new DacsError("Demos bundle anchors must use the write-input mapping");
  }
  if (copy.role === "seller" && mapping !== deps.sellerMapping) {
    throw new DacsError(
      "seller bundle anchor mapping contradicts its authenticated finalization provider",
    );
  }
  if (mapping === "write-input") {
    await requireBinding(copy, bundleHash, deps);
  } else if (copy.binding !== undefined) {
    throw new DacsError(`pure ${copy.role} bundle mapping must not carry a BundleBinding`);
  }
  return { bundle: copyObject, mapping };
}

/**
 * DACS-5 §10.3.1 ST-11 completion gate, checked against Standard `next`
 * 81ded2b49851d8fa17399e3fdade9e36e33a4ff7.
 *
 * The synchronous combiner is intentionally operational and can never return
 * `audit-complete`. This function first re-authenticates the exact durable
 * seller session with the SDK's strict finalization verifier, including its
 * complete transitive dependency closure. It then independently reads and
 * authenticates each role-owned bundle receipt/mapping/binding and requires
 * both copies to carry the byte-identical signed production scope.
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

  const verifiedClosure = await verifyFinalizedSellerBundleReadOnly(
    clone(retained.sellerClosure.verificationInput),
    clone(retained.sellerClosure.result),
    capturedDeps.sellerFinalizationProvider,
  );
  if (verifiedClosure.state !== "finalised" ||
      verifiedClosure.nativeAddress !== retained.copies.seller.nativeAddress ||
      !exact(verifiedClosure.anchorReceipt, retained.copies.seller.anchorReceipt) ||
      !exact(verifiedClosure.sellerBundle, retained.copies.seller.bundle) ||
      !exact(verifiedClosure.buyerBundle, retained.copies.buyer.bundle) ||
      ((verifiedClosure.binding !== undefined ||
        retained.copies.seller.binding !== undefined) &&
        !exact(verifiedClosure.binding, retained.copies.seller.binding)) ||
      verifiedClosure.bundleContentHash !==
        attestationBundleHash(retained.copies.seller.bundle)) {
    throw new DacsError(
      "completed bundle copies do not match the authenticated durable session closure",
    );
  }

  const [buyerCopy, sellerCopy] = await Promise.all([
    verifyCopy(retained.copies.buyer, retained.buyer, capturedDeps),
    verifyCopy(retained.copies.seller, retained.seller, capturedDeps),
  ]);
  if (!exact(
    bundleSignedScope(retained.copies.buyer.bundle),
    bundleSignedScope(retained.copies.seller.bundle),
  )) {
    throw new DacsError("completed buyer and seller bundles carry different signed scopes");
  }
  const consistency = await bundleConsistency({
    buyer: { disposition: "present", bundle: buyerCopy.bundle },
    seller: { disposition: "present", bundle: sellerCopy.bundle },
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
