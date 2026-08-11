import type {
  AnchorReceipt,
  BundleBinding,
  BundleSignature,
  FaultAttestationBundle,
} from "../artifacts/types.js";
import {
  ARTIFACT_SEPARATORS,
  BUNDLE_BINDING_SEPARATOR,
  isAnchorReceipt,
  isBundleBinding,
  isCanonicalBase64Url,
  signComponentArtifact,
} from "../artifacts/index.js";
import { bundleAddress, canonicalize, contentHash } from "../canonical/index.js";
import { ed25519Sign, privateKeyFromSeed, signedBytes } from "../crypto/index.js";
import { DacsError, SubstrateError } from "../errors.js";
import {
  attestationBundleHash,
  type SigningSessionParty,
} from "./twoSidedBundle.js";
import {
  verifyBundleCopy,
  type BundleCopyDeps,
} from "./bundleCopyValidity.js";
import {
  verifyCompletedSellerBundleCounterSignatureRequest,
  verifyFinalizedSellerBundleReadOnly,
  type AnchoredSellerBundle,
  type CompletedSellerBundleCounterSignatureRequest,
  type SellerBundleBindingLookup,
  type SellerBundleBindingPublication,
  type SellerBundleFinalizationReadProvider,
  type SellerBundleLookup,
  type SellerBundleVerificationDisposition,
  type VerifyCompletedSellerBundleCounterSignatureRequestInput,
  type VerifyFinalizedSellerBundleInput,
} from "../seller/bundleFinalization.js";

/** A role-neutral reuse of the authenticated SR-2 bundle readback shape. */
export type AnchoredBuyerBundle = AnchoredSellerBundle;

/** Buyer-address lookup with authenticated absence/indeterminacy semantics. */
export type BuyerBundleLookup = SellerBundleLookup;

/**
 * Buyer-side substrate seams. The inherited read-only seller surface is used
 * solely to authenticate the seller's signing request and finalized result;
 * it exposes no seller signer or seller write path.
 */
export interface BuyerBundleFinalizationProvider
  extends SellerBundleFinalizationReadProvider {
  resolveBuyerBundle: (
    logicalAddress: string,
  ) => Promise<BuyerBundleLookup> | BuyerBundleLookup;
  submitBuyerBundle: (
    logicalAddress: string,
    bundle: Readonly<FaultAttestationBundle>,
  ) => Promise<void> | void;
  /** Required only when `mapping === "write-input"`. */
  publishBundleBinding?: (
    binding: Readonly<BundleBinding>,
  ) => Promise<SellerBundleBindingPublication> | SellerBundleBindingPublication;
}

export interface CreateCompletedBuyerBundleCounterSignatureInput {
  /** Buyer-local, data-only facts used to re-derive and audit the request. */
  sellerVerificationInput: VerifyCompletedSellerBundleCounterSignatureRequestInput;
  /** The locally controlled buyer identity and signer. */
  buyer: SigningSessionParty;
}

export interface FinalizeCompletedBuyerBundleInput {
  /** Exact data-only session facts, including the detached counter-signature. */
  sellerVerificationInput: VerifyFinalizedSellerBundleInput;
  /** Untrusted transport result returned after seller-role finalization. */
  sellerFinalization: unknown;
  /** The exact detached signature produced after buyer review. */
  counterSignature: BundleSignature;
  /** The same locally controlled buyer identity; reused for BB-1 signing. */
  buyer: SigningSessionParty;
}

/** Immutable, idempotent buyer-role terminal publication. */
export interface FinalizedBuyerBundle {
  readonly state: "finalised";
  readonly logicalAddress: string;
  readonly nativeAddress: string;
  readonly bundleContentHash: string;
  readonly buyerBundle: Readonly<FaultAttestationBundle>;
  readonly anchorReceipt: Readonly<AnchorReceipt>;
  readonly anchorTx?: string;
  readonly binding?: Readonly<BundleBinding>;
}

interface CapturedBuyer {
  primaryClaim: string;
  bundleHash: string;
  signer: SigningSessionParty["signer"];
}

interface RetainedBuyerProvider {
  mapping: "pure" | "write-input";
  bundleCopyVerifier: BundleCopyDeps;
  resolveBuyerBundle: BuyerBundleFinalizationProvider["resolveBuyerBundle"];
  submitBuyerBundle: BuyerBundleFinalizationProvider["submitBuyerBundle"];
  verifyBundleAnchorReceipt: SellerBundleFinalizationReadProvider["verifyBundleAnchorReceipt"];
  resolveBundleBinding?: NonNullable<
    SellerBundleFinalizationReadProvider["resolveBundleBinding"]
  >;
  publishBundleBinding?: NonNullable<
    BuyerBundleFinalizationProvider["publishBundleBinding"]
  >;
  verifyBundleBinding?: NonNullable<
    SellerBundleFinalizationReadProvider["verifyBundleBinding"]
  >;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isHash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

function exact(left: unknown, right: unknown): boolean {
  try {
    return canonicalize(left) === canonicalize(right);
  } catch {
    return false;
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function snapshot<T>(value: T, subject: string): T {
  try {
    return structuredClone(value);
  } catch (error) {
    throw new DacsError(`${subject} cannot be snapshotted safely`, { cause: error });
  }
}

function deepFreeze<T>(value: T): T {
  if (
    value === null ||
    typeof value !== "object" ||
    value instanceof Uint8Array ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function immutableSnapshot<T>(value: T, subject: string): T {
  return deepFreeze(snapshot(value, subject));
}

function captureBuyer(value: SigningSessionParty): CapturedBuyer {
  if (!isRecord(value)) {
    throw new DacsError("buyer signer must be a plain locally controlled party");
  }
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new DacsError("buyer signer must be a plain locally controlled party");
    }
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    if (error instanceof DacsError) throw error;
    throw new DacsError("buyer signer cannot be inspected safely", { cause: error });
  }
  if (
    !hasExactKeys(descriptors as unknown as Record<string, unknown>, [
      "primaryClaim",
      "bundleHash",
      "signer",
    ]) ||
    Object.values(descriptors).some(
      (descriptor) => descriptor.enumerable !== true || !("value" in descriptor),
    )
  ) {
    throw new DacsError("buyer signer has a non-canonical or live shape");
  }
  const primaryClaim = descriptors.primaryClaim?.value;
  const bundleHash = descriptors.bundleHash?.value;
  const signer = descriptors.signer?.value as SigningSessionParty["signer"] | undefined;
  if (
    typeof primaryClaim !== "string" ||
    primaryClaim.length === 0 ||
    primaryClaim.trim() !== primaryClaim ||
    !isHash(bundleHash) ||
    signer === undefined
  ) {
    throw new DacsError("buyer signer identity is malformed");
  }
  return { primaryClaim, bundleHash, signer };
}

function retainProvider(provider: BuyerBundleFinalizationProvider): RetainedBuyerProvider {
  const mapping = provider.mapping;
  const verifierOwner = provider.bundleCopyVerifier;
  const resolvePublicKey = verifierOwner?.resolvePublicKey;
  const verify = verifierOwner?.verify;
  const resolveBuyerBundle = provider.resolveBuyerBundle;
  const submitBuyerBundle = provider.submitBuyerBundle;
  const verifyBundleAnchorReceipt = provider.verifyBundleAnchorReceipt;
  const resolveBundleBinding = provider.resolveBundleBinding;
  const publishBundleBinding = provider.publishBundleBinding;
  const verifyBundleBinding = provider.verifyBundleBinding;

  if (mapping !== "pure" && mapping !== "write-input") {
    throw new DacsError("unsupported buyer bundle address mapping policy");
  }
  if (
    typeof resolvePublicKey !== "function" ||
    typeof verify !== "function" ||
    typeof resolveBuyerBundle !== "function" ||
    typeof submitBuyerBundle !== "function" ||
    typeof verifyBundleAnchorReceipt !== "function"
  ) {
    throw new DacsError("buyer bundle provider is incomplete or non-callable");
  }
  if (
    [resolveBundleBinding, publishBundleBinding, verifyBundleBinding].some(
      (candidate) => candidate !== undefined && typeof candidate !== "function",
    ) ||
    (mapping === "write-input" &&
      (typeof resolveBundleBinding !== "function" ||
        typeof publishBundleBinding !== "function" ||
        typeof verifyBundleBinding !== "function"))
  ) {
    throw new DacsError("write-input buyer bundle mapping lacks its BB-1 seams");
  }

  return {
    mapping,
    bundleCopyVerifier: {
      resolvePublicKey: (claim) => resolvePublicKey.call(verifierOwner, claim),
      verify: (bytes, signature, publicKey) =>
        verify.call(verifierOwner, bytes, signature, publicKey),
    },
    resolveBuyerBundle: (logicalAddress) =>
      resolveBuyerBundle.call(provider, logicalAddress),
    submitBuyerBundle: (logicalAddress, bundle) =>
      submitBuyerBundle.call(provider, logicalAddress, bundle),
    verifyBundleAnchorReceipt: (anchored) =>
      verifyBundleAnchorReceipt.call(provider, anchored),
    ...(resolveBundleBinding
      ? {
          resolveBundleBinding: (logicalAddress: string, signer: string) =>
            resolveBundleBinding.call(provider, logicalAddress, signer),
        }
      : {}),
    ...(publishBundleBinding
      ? {
          publishBundleBinding: (binding: Readonly<BundleBinding>) =>
            publishBundleBinding.call(provider, binding),
        }
      : {}),
    ...(verifyBundleBinding
      ? {
          verifyBundleBinding: (binding: Readonly<BundleBinding>) =>
            verifyBundleBinding.call(provider, binding),
        }
      : {}),
  };
}

async function signBuyerBytes(
  buyer: CapturedBuyer,
  payload: Uint8Array,
  subject: string,
): Promise<Uint8Array> {
  try {
    const signer = buyer.signer;
    const raw =
      typeof signer === "function"
        ? await signer(new Uint8Array(payload))
        : ed25519Sign(
            payload,
            signer instanceof Uint8Array ? privateKeyFromSeed(signer) : signer,
          );
    if (!(raw instanceof Uint8Array) || raw.byteLength !== 64) {
      throw new DacsError(`${subject} did not return one Ed25519 signature`);
    }
    return new Uint8Array(raw);
  } catch (error) {
    if (error instanceof DacsError) throw error;
    throw new DacsError(`${subject} failed`, { cause: error });
  }
}

function validateDetachedSignature(
  value: unknown,
  expectedParty: string,
): BundleSignature {
  const signature = snapshot(value, "buyer detached signature") as unknown;
  if (
    !isRecord(signature) ||
    !hasExactKeys(signature, ["party", "algorithm", "value"]) ||
    signature.party !== expectedParty ||
    signature.algorithm !== "ed25519" ||
    !isCanonicalBase64Url(signature.value)
  ) {
    throw new DacsError("buyer detached signature is malformed or identity-rebound");
  }
  const bytes = Uint8Array.from(Buffer.from(signature.value, "base64url"));
  if (bytes.byteLength !== 64) {
    throw new DacsError("buyer detached signature is not one Ed25519 signature");
  }
  return signature as unknown as BundleSignature;
}

async function locallyVerifySignature(
  signature: BundleSignature,
  payload: Uint8Array,
  verifier: BundleCopyDeps,
  subject: string,
): Promise<void> {
  let key: Uint8Array | null;
  try {
    key = await verifier.resolvePublicKey(signature.party);
  } catch (error) {
    throw new DacsError(`${subject} signer key resolution failed`, { cause: error });
  }
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
    throw new DacsError(`${subject} signer key cannot be resolved`);
  }
  const raw = Uint8Array.from(Buffer.from(signature.value, "base64url"));
  let verified: boolean;
  try {
    verified = await verifier.verify(
      new Uint8Array(payload),
      raw,
      new Uint8Array(key),
    );
  } catch (error) {
    throw new DacsError(`${subject} local verification failed`, { cause: error });
  }
  if (verified !== true) {
    throw new DacsError(`${subject} failed local verification`);
  }
}

function authenticatedBuyerParty(
  request: CompletedSellerBundleCounterSignatureRequest,
  buyer: CapturedBuyer,
): void {
  const parties = Array.isArray(request.signedScope.parties)
    ? request.signedScope.parties
    : [];
  const buyerParties = parties.filter(
    (party) => isRecord(party) && party.role === "buyer",
  );
  if (
    buyerParties.length !== 1 ||
    buyerParties[0]!.primaryClaim !== buyer.primaryClaim ||
    buyerParties[0]!.bundleHash !== buyer.bundleHash ||
    request.requiredCounterSigners.filter(
      (claim) => claim === buyer.primaryClaim,
    ).length !== 1
  ) {
    throw new DacsError(
      "counter-signature request is not bound to the local buyer IdentityBundle",
    );
  }
}

/**
 * Produce the buyer's detached bundle signature only after independently
 * rebuilding the seller request, auditing its full closure, and binding it to
 * the local buyer identity and key. No seller signing callback is accepted.
 */
export async function createCompletedBuyerBundleCounterSignature(
  input: CreateCompletedBuyerBundleCounterSignatureInput,
  suppliedRequest: unknown,
  provider: SellerBundleFinalizationReadProvider,
): Promise<BundleSignature> {
  const buyer = captureBuyer(input.buyer);
  const verifierOwner = provider.bundleCopyVerifier;
  const resolvePublicKey = verifierOwner?.resolvePublicKey;
  const verify = verifierOwner?.verify;
  if (typeof resolvePublicKey !== "function" || typeof verify !== "function") {
    throw new DacsError("local buyer bundle signature verifier is unavailable");
  }
  const localVerifier: BundleCopyDeps = {
    resolvePublicKey: (claim) => resolvePublicKey.call(verifierOwner, claim),
    verify: (bytes, signature, publicKey) =>
      verify.call(verifierOwner, bytes, signature, publicKey),
  };
  const verificationInput = snapshot(
    input.sellerVerificationInput,
    "buyer counter-signature verification input",
  );
  const request = await verifyCompletedSellerBundleCounterSignatureRequest(
    verificationInput,
    snapshot(suppliedRequest, "supplied seller counter-signature request"),
    provider,
  );
  const authenticatedRequest = snapshot(
    request,
    "authenticated seller counter-signature request",
  );
  authenticatedBuyerParty(authenticatedRequest, buyer);

  const raw = await signBuyerBytes(
    buyer,
    authenticatedRequest.signedBytes,
    "buyer bundle signer",
  );
  const signature = validateDetachedSignature(
    {
      party: buyer.primaryClaim,
      algorithm: "ed25519",
      value: Buffer.from(raw).toString("base64url"),
    },
    buyer.primaryClaim,
  );
  await locallyVerifySignature(
    signature,
    authenticatedRequest.signedBytes,
    localVerifier,
    "buyer detached signature",
  );
  return immutableSnapshot(signature, "verified buyer detached signature");
}

function dispositionFailure(
  subject: string,
  disposition: SellerBundleVerificationDisposition,
): never {
  if (disposition === "indeterminate" || disposition === "error") {
    throw new SubstrateError(`${subject} is not established (${disposition})`);
  }
  throw new DacsError(`${subject} is invalid`);
}

async function verifyDisposition(
  subject: string,
  operation: () =>
    | Promise<SellerBundleVerificationDisposition>
    | SellerBundleVerificationDisposition,
): Promise<void> {
  let disposition: SellerBundleVerificationDisposition;
  try {
    disposition = await operation();
  } catch (error) {
    throw new SubstrateError(`${subject} verification errored`, { cause: error });
  }
  if (disposition !== "valid") dispositionFailure(subject, disposition);
}

function validateBundleLookup(value: unknown): BuyerBundleLookup {
  const lookup = snapshot(value, "buyer bundle lookup") as unknown;
  if (!isRecord(lookup) || typeof lookup.disposition !== "string") {
    throw new SubstrateError("buyer bundle lookup returned an invalid disposition");
  }
  if (lookup.disposition === "absent" && hasExactKeys(lookup, ["disposition"])) {
    return lookup as unknown as BuyerBundleLookup;
  }
  if (
    lookup.disposition === "indeterminate" &&
    hasExactKeys(lookup, ["disposition", "reason"]) &&
    typeof lookup.reason === "string" &&
    lookup.reason.length > 0
  ) {
    return lookup as BuyerBundleLookup;
  }
  if (
    lookup.disposition === "present" &&
    hasExactKeys(lookup, ["disposition", "anchored"]) &&
    isRecord(lookup.anchored)
  ) {
    return lookup as unknown as BuyerBundleLookup;
  }
  throw new SubstrateError("buyer bundle lookup returned an invalid disposition");
}

async function resolveBuyerBundle(
  logicalAddress: string,
  provider: RetainedBuyerProvider,
): Promise<BuyerBundleLookup> {
  try {
    return validateBundleLookup(await provider.resolveBuyerBundle(logicalAddress));
  } catch (error) {
    if (error instanceof SubstrateError) throw error;
    throw new SubstrateError("buyer bundle lookup errored and is indeterminate", {
      cause: error,
    });
  }
}

async function authenticateAnchoredBuyerBundle(
  logicalAddress: string,
  expectedBundle: FaultAttestationBundle,
  value: unknown,
  provider: RetainedBuyerProvider,
): Promise<AnchoredBuyerBundle> {
  const anchored = snapshot(value, "anchored buyer bundle readback") as unknown;
  if (
    !isRecord(anchored) ||
    !hasExactKeys(anchored, [
      "bundle",
      "nativeAddress",
      "anchorReceipt",
      ...(anchored.anchorTx === undefined ? [] : ["anchorTx"]),
    ]) ||
    typeof anchored.nativeAddress !== "string" ||
    anchored.nativeAddress.length === 0 ||
    (anchored.anchorTx !== undefined &&
      (typeof anchored.anchorTx !== "string" || anchored.anchorTx.length === 0)) ||
    !isAnchorReceipt(anchored.anchorReceipt) ||
    anchored.anchorReceipt.state !== "finalized" ||
    anchored.anchorReceipt.observationDisposition !== "established" ||
    anchored.anchorReceipt.logicalAddress !== logicalAddress ||
    anchored.anchorReceipt.nativeAddress !== anchored.nativeAddress ||
    anchored.anchorReceipt.contentHash !== attestationBundleHash(expectedBundle) ||
    !exact(anchored.bundle, expectedBundle)
  ) {
    throw new DacsError(
      "buyer bundle readback lacks the exact established finalized publication",
    );
  }
  const bundle = anchored.bundle as FaultAttestationBundle;
  if (bundle.anchoredByRole !== "buyer") {
    throw new DacsError("buyer bundle readback has the wrong anchored role");
  }
  const verdict = await verifyBundleCopy(
    snapshot(bundle as unknown as Record<string, unknown>, "buyer bundle copy verification"),
    "buyer",
    provider.bundleCopyVerifier,
  );
  if (!verdict.valid || !verdict.fullySigned) {
    throw new DacsError(
      verdict.valid
        ? "buyer bundle readback is not fully signed"
        : `buyer bundle readback signature verification failed: ${verdict.reason}`,
    );
  }
  await verifyDisposition("buyer bundle anchor receipt proof", () =>
    provider.verifyBundleAnchorReceipt(
      snapshot(
        anchored as unknown as AnchoredBuyerBundle,
        "buyer bundle receipt verification input",
      ),
    ),
  );
  return snapshot(
    anchored as unknown as AnchoredBuyerBundle,
    "authenticated buyer bundle readback",
  );
}

async function publishBuyerBundle(
  logicalAddress: string,
  expectedBundle: FaultAttestationBundle,
  provider: RetainedBuyerProvider,
): Promise<AnchoredBuyerBundle> {
  let lookup = await resolveBuyerBundle(logicalAddress, provider);
  if (lookup.disposition === "indeterminate") {
    throw new SubstrateError(`buyer bundle lookup is indeterminate: ${lookup.reason}`);
  }
  if (lookup.disposition === "present") {
    return authenticateAnchoredBuyerBundle(
      logicalAddress,
      expectedBundle,
      lookup.anchored,
      provider,
    );
  }

  try {
    await provider.submitBuyerBundle(
      logicalAddress,
      snapshot(expectedBundle, "buyer bundle submission input"),
    );
  } catch (error) {
    lookup = await resolveBuyerBundle(logicalAddress, provider);
    if (lookup.disposition !== "present") {
      throw new SubstrateError(
        "buyer bundle submission outcome is ambiguous; resolve before any retry",
        { cause: error },
      );
    }
    return authenticateAnchoredBuyerBundle(
      logicalAddress,
      expectedBundle,
      lookup.anchored,
      provider,
    );
  }

  lookup = await resolveBuyerBundle(logicalAddress, provider);
  if (lookup.disposition !== "present") {
    throw new SubstrateError(
      lookup.disposition === "indeterminate"
        ? `buyer bundle readback is indeterminate: ${lookup.reason}`
        : "buyer bundle is authoritatively absent after submission",
    );
  }
  return authenticateAnchoredBuyerBundle(
    logicalAddress,
    expectedBundle,
    lookup.anchored,
    provider,
  );
}

function expectedBinding(
  jobId: string,
  buyer: CapturedBuyer,
  anchored: AnchoredBuyerBundle,
  bundleContentHash: string,
): Omit<BundleBinding, "signature"> {
  return {
    bindingVersion: "1",
    jobId,
    role: "buyer",
    logicalAddress: bundleAddress(jobId, "buyer"),
    nativeAddress: anchored.nativeAddress,
    bundleContentHash,
    ...(anchored.anchorTx === undefined ? {} : { anchorTx: anchored.anchorTx }),
    signer: buyer.primaryClaim,
  };
}

function validateBindingLookup(value: unknown): SellerBundleBindingLookup {
  const lookup = snapshot(value, "buyer BundleBinding lookup") as unknown;
  if (!isRecord(lookup) || typeof lookup.disposition !== "string") {
    throw new SubstrateError("buyer BundleBinding lookup returned an invalid disposition");
  }
  if (lookup.disposition === "absent" && hasExactKeys(lookup, ["disposition"])) {
    return lookup as unknown as SellerBundleBindingLookup;
  }
  if (
    lookup.disposition === "indeterminate" &&
    hasExactKeys(lookup, ["disposition", "reason"]) &&
    typeof lookup.reason === "string" &&
    lookup.reason.length > 0
  ) {
    return lookup as SellerBundleBindingLookup;
  }
  if (
    lookup.disposition === "present" &&
    hasExactKeys(lookup, ["disposition", "binding"])
  ) {
    return lookup as SellerBundleBindingLookup;
  }
  throw new SubstrateError("buyer BundleBinding lookup returned an invalid disposition");
}

async function resolveBinding(
  logicalAddress: string,
  signer: string,
  provider: RetainedBuyerProvider,
): Promise<SellerBundleBindingLookup> {
  if (!provider.resolveBundleBinding) {
    throw new DacsError("buyer BundleBinding lookup seam is unavailable");
  }
  try {
    return validateBindingLookup(
      await provider.resolveBundleBinding(logicalAddress, signer),
    );
  } catch (error) {
    if (error instanceof DacsError) throw error;
    throw new SubstrateError("buyer BundleBinding lookup errored", { cause: error });
  }
}

async function authenticateBinding(
  value: unknown,
  expected: Omit<BundleBinding, "signature">,
  provider: RetainedBuyerProvider,
): Promise<BundleBinding> {
  const binding = snapshot(value, "buyer BundleBinding readback") as unknown;
  if (
    !isBundleBinding(binding) ||
    !exact(
      Object.fromEntries(
        Object.entries(binding).filter(([key]) => key !== "signature"),
      ),
      expected,
    ) ||
    binding.role !== "buyer" ||
    binding.signer !== expected.signer ||
    binding.signature.signer !== expected.signer ||
    binding.signature.algorithm !== "ed25519" ||
    !isCanonicalBase64Url(binding.signature.value) ||
    Buffer.from(binding.signature.value, "base64url").byteLength !== 64
  ) {
    throw new DacsError("buyer BundleBinding is malformed or maps different content");
  }
  const signature: BundleSignature = {
    party: binding.signature.signer,
    algorithm: "ed25519",
    value: binding.signature.value,
  };
  await locallyVerifySignature(
    signature,
    signedBytes(
      BUNDLE_BINDING_SEPARATOR,
      contentHash(binding as unknown as Record<string, unknown>),
    ),
    provider.bundleCopyVerifier,
    "buyer BundleBinding signature",
  );
  if (!provider.verifyBundleBinding) {
    throw new DacsError("buyer BundleBinding verification seam is unavailable");
  }
  await verifyDisposition("buyer BundleBinding provider verification", () =>
    provider.verifyBundleBinding!(
      snapshot(binding, "buyer BundleBinding provider verification input"),
    ),
  );
  return snapshot(binding, "authenticated buyer BundleBinding");
}

function validateBindingPublication(value: unknown): SellerBundleBindingPublication {
  const publication = snapshot(value, "buyer BundleBinding publication result") as unknown;
  if (!isRecord(publication) || typeof publication.disposition !== "string") {
    throw new SubstrateError("buyer BundleBinding publisher returned an invalid disposition");
  }
  if (
    publication.disposition === "published" &&
    hasExactKeys(publication, ["disposition"])
  ) {
    return publication as unknown as SellerBundleBindingPublication;
  }
  if (
    (publication.disposition === "rejected" ||
      publication.disposition === "indeterminate") &&
    hasExactKeys(publication, ["disposition", "reason"]) &&
    typeof publication.reason === "string" &&
    publication.reason.length > 0
  ) {
    return publication as SellerBundleBindingPublication;
  }
  throw new SubstrateError("buyer BundleBinding publisher returned an invalid disposition");
}

async function reconcilePublishedBinding(
  expectedBinding: BundleBinding,
  expected: Omit<BundleBinding, "signature">,
  provider: RetainedBuyerProvider,
  cause?: unknown,
): Promise<BundleBinding> {
  let lookup: SellerBundleBindingLookup;
  try {
    lookup = await resolveBinding(expected.logicalAddress, expected.signer, provider);
  } catch (error) {
    throw new SubstrateError(
      "buyer BundleBinding publication outcome is ambiguous; resolve before any retry",
      { cause: cause ?? error },
    );
  }
  if (lookup.disposition !== "present" || !exact(lookup.binding, expectedBinding)) {
    throw new SubstrateError(
      "buyer BundleBinding publication outcome is ambiguous; resolve before any retry",
      { cause },
    );
  }
  return authenticateBinding(lookup.binding, expected, provider);
}

async function publishBinding(
  jobId: string,
  buyer: CapturedBuyer,
  anchored: AnchoredBuyerBundle,
  bundleContentHash: string,
  provider: RetainedBuyerProvider,
): Promise<BundleBinding | undefined> {
  if (provider.mapping === "pure") return undefined;
  if (!provider.publishBundleBinding) {
    throw new DacsError("buyer BundleBinding publication seam is unavailable");
  }
  const expected = expectedBinding(jobId, buyer, anchored, bundleContentHash);
  const lookup = await resolveBinding(expected.logicalAddress, expected.signer, provider);
  if (lookup.disposition === "indeterminate") {
    throw new SubstrateError(
      `buyer BundleBinding lookup is indeterminate: ${lookup.reason}`,
    );
  }
  if (lookup.disposition === "present") {
    return authenticateBinding(lookup.binding, expected, provider);
  }

  const binding = await signComponentArtifact(
    expected,
    BUNDLE_BINDING_SEPARATOR,
    {
      algorithm: "ed25519",
      signer: buyer.primaryClaim,
      sign: (bytes) => signBuyerBytes(buyer, bytes, "buyer BundleBinding signer"),
    },
  );
  const authenticatedCandidate = await authenticateBinding(binding, expected, provider);
  let publication: SellerBundleBindingPublication;
  try {
    publication = validateBindingPublication(
      await provider.publishBundleBinding(
        snapshot(authenticatedCandidate, "buyer BundleBinding publication input"),
      ),
    );
  } catch (error) {
    return reconcilePublishedBinding(
      authenticatedCandidate,
      expected,
      provider,
      error,
    );
  }
  if (publication.disposition === "rejected") {
    throw new DacsError(`buyer BundleBinding publication was rejected: ${publication.reason}`);
  }
  if (publication.disposition === "indeterminate") {
    return reconcilePublishedBinding(
      authenticatedCandidate,
      expected,
      provider,
      new SubstrateError(publication.reason),
    );
  }

  const published = await resolveBinding(
    expected.logicalAddress,
    expected.signer,
    provider,
  );
  if (published.disposition !== "present" || !exact(published.binding, authenticatedCandidate)) {
    throw new SubstrateError(
      "published buyer BundleBinding is not independently readable and exact",
    );
  }
  return authenticateBinding(published.binding, expected, provider);
}

function validateBuyerIdentityAndSignature(
  bundle: FaultAttestationBundle,
  buyer: CapturedBuyer,
  suppliedCounterSignature: unknown,
  sellerVerificationInput: VerifyFinalizedSellerBundleInput,
): BundleSignature {
  if (bundle.anchoredByRole !== "buyer") {
    throw new DacsError("seller finalization returned the wrong buyer bundle role");
  }
  const parties = bundle.parties.filter((party) => party.role === "buyer");
  if (
    parties.length !== 1 ||
    parties[0]!.primaryClaim !== buyer.primaryClaim ||
    parties[0]!.bundleHash !== buyer.bundleHash
  ) {
    throw new DacsError("finalized buyer bundle is identity-rebound");
  }
  const signature = validateDetachedSignature(
    suppliedCounterSignature,
    buyer.primaryClaim,
  );
  const embedded = bundle.signatures.filter(
    (candidate) => candidate.party === buyer.primaryClaim,
  );
  const retained = sellerVerificationInput.counterSignatures?.filter(
    (candidate) => candidate.party === buyer.primaryClaim,
  );
  if (
    embedded.length !== 1 ||
    retained?.length !== 1 ||
    !exact(embedded[0], signature) ||
    !exact(retained[0], signature)
  ) {
    throw new DacsError(
      "finalized buyer bundle substituted the reviewed detached signature",
    );
  }
  return signature;
}

/**
 * Publish the exact authenticated buyer role copy. Completion is withheld until
 * the finalized readback (and, for write-input mappings, buyer-signed BB-1
 * binding) is independently verified. Repeated calls return the same frozen
 * result and never overwrite an existing different publication.
 */
export async function finalizeCompletedBuyerBundleCore(
  input: FinalizeCompletedBuyerBundleInput,
  provider: BuyerBundleFinalizationProvider,
): Promise<FinalizedBuyerBundle> {
  const buyer = captureBuyer(input.buyer);
  const retainedProvider = retainProvider(provider);
  const verificationInput = snapshot(
    input.sellerVerificationInput,
    "buyer seller-finalization verification input",
  );
  const suppliedSellerFinalization = snapshot(
    input.sellerFinalization,
    "supplied seller finalization",
  );
  const suppliedCounterSignature = snapshot(
    input.counterSignature,
    "supplied buyer counter-signature",
  );

  const sellerFinalization = await verifyFinalizedSellerBundleReadOnly(
    verificationInput,
    suppliedSellerFinalization,
    provider,
  );
  const authenticated = snapshot(
    sellerFinalization,
    "authenticated seller finalization",
  );
  const buyerBundle = snapshot(
    authenticated.buyerBundle,
    "authenticated buyer role copy",
  );
  const signature = validateBuyerIdentityAndSignature(
    buyerBundle,
    buyer,
    suppliedCounterSignature,
    verificationInput,
  );
  const bundleContentHash = attestationBundleHash(buyerBundle);
  if (
    !isHash(bundleContentHash) ||
    bundleContentHash !== authenticated.bundleContentHash ||
    buyerBundle.jobId.length === 0
  ) {
    throw new DacsError("authenticated buyer role copy changed the seller-reviewed scope");
  }
  await locallyVerifySignature(
    signature,
    signedBytes(ARTIFACT_SEPARATORS.FaultAttestationBundle, bundleContentHash),
    retainedProvider.bundleCopyVerifier,
    "retained buyer detached signature",
  );

  const logicalAddress = bundleAddress(buyerBundle.jobId, "buyer");
  const anchored = await publishBuyerBundle(
    logicalAddress,
    buyerBundle,
    retainedProvider,
  );
  const binding = await publishBinding(
    buyerBundle.jobId,
    buyer,
    anchored,
    bundleContentHash,
    retainedProvider,
  );
  return immutableSnapshot(
    {
      state: "finalised" as const,
      logicalAddress,
      nativeAddress: anchored.nativeAddress,
      bundleContentHash,
      buyerBundle,
      anchorReceipt: anchored.anchorReceipt,
      ...(anchored.anchorTx === undefined ? {} : { anchorTx: anchored.anchorTx }),
      ...(binding === undefined ? {} : { binding }),
    },
    "finalized buyer bundle result",
  );
}
