import { types as nodeTypes } from "node:util";

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
  type SellerCompositeVerificationDeps,
  type SellerBundleLookup,
  type SellerBundleVerificationDisposition,
  type VerifyCompletedSellerBundleCounterSignatureRequestInput,
  type VerifyFinalizedSellerBundleInput,
} from "../seller/bundleFinalization.js";

/** A role-neutral reuse of the authenticated SR-2 bundle readback shape. */
export type AnchoredBuyerBundle = AnchoredSellerBundle;

/** Non-seller roles which must publish their own completed bundle copy. */
export type CounterpartyBundleRole = "buyer" | "orchestrator";

/** A role-neutral reuse of the authenticated SR-2 bundle readback shape. */
export type AnchoredCounterpartyBundle = AnchoredSellerBundle;

/** Buyer-address lookup with authenticated absence/indeterminacy semantics. */
export type BuyerBundleLookup = SellerBundleLookup;

/** Role-owned lookup with authenticated absence/indeterminacy semantics. */
export type CounterpartyBundleLookup = SellerBundleLookup;

/**
 * Role-neutral publication seams. Each process receives only the signer and
 * write path for its own role; no remote signing capability crosses this
 * boundary.
 */
export interface CounterpartyBundleFinalizationProvider
  extends SellerBundleFinalizationReadProvider {
  resolveCounterpartyBundle: (
    logicalAddress: string,
    role: CounterpartyBundleRole,
  ) => Promise<CounterpartyBundleLookup> | CounterpartyBundleLookup;
  submitCounterpartyBundle: (
    logicalAddress: string,
    bundle: Readonly<FaultAttestationBundle>,
    role: CounterpartyBundleRole,
  ) => Promise<void> | void;
  /** Required only when `mapping === "write-input"`. */
  publishBundleBinding?: (
    binding: Readonly<BundleBinding>,
  ) => Promise<SellerBundleBindingPublication> | SellerBundleBindingPublication;
}

/**
 * Buyer-side substrate seams. The inherited read-only seller surface is used
 * solely to authenticate the seller's signing request and finalized result;
 * it exposes no seller signer or seller write path.
 */
export interface BuyerBundleFinalizationProvider
  extends SellerBundleFinalizationReadProvider {
  /**
   * Provider and nested-verifier callbacks are captured from owned data
   * properties before the first await and invoked with a frozen inert receiver.
   * Stateful adapters should therefore close over their state rather than use
   * getters, prototype methods, or mutable `this` binding.
   */
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

export interface CounterpartySigningSessionParty extends SigningSessionParty {
  role: CounterpartyBundleRole;
}

export interface CreateCompletedCounterpartyBundleCounterSignatureInput {
  /** Counterparty-local, data-only facts used to re-derive the seller request. */
  sellerVerificationInput: VerifyCompletedSellerBundleCounterSignatureRequestInput;
  /** The only locally controlled identity and signer. */
  localParty: CounterpartySigningSessionParty;
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

export interface FinalizeCompletedCounterpartyBundleInput {
  /** Exact data-only session facts, including every detached signature. */
  sellerVerificationInput: VerifyFinalizedSellerBundleInput;
  /** Untrusted transport result returned after seller-role finalization. */
  sellerFinalization: unknown;
  /** The exact detached signature produced by this local role. */
  counterSignature: BundleSignature;
  /** The same locally controlled identity used for role-owned BB-1 signing. */
  localParty: CounterpartySigningSessionParty;
}

/**
 * Immutable buyer-role terminal publication returned by the pure core.
 *
 * The core performs read-before-write reconciliation, but deliberately owns no
 * durable lease or generation fence. Callers that may overlap, restart, or
 * retry after a process failure MUST serialize it behind a fenced durable
 * wrapper whose provider effects are idempotent for the retained invocation.
 */
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


/** Immutable terminal publication for one non-seller role. */
export interface FinalizedCounterpartyBundle {
  readonly state: "finalised";
  readonly role: CounterpartyBundleRole;
  readonly logicalAddress: string;
  readonly nativeAddress: string;
  readonly bundleContentHash: string;
  readonly bundle: Readonly<FaultAttestationBundle>;
  readonly anchorReceipt: Readonly<AnchorReceipt>;
  readonly anchorTx?: string;
  readonly binding?: Readonly<BundleBinding>;
}

interface CapturedCounterparty {
  role: CounterpartyBundleRole;
  primaryClaim: string;
  bundleHash: string;
  signer: SigningSessionParty["signer"];
}

type RetainedSellerReadProvider = Readonly<SellerBundleFinalizationReadProvider>;
type RetainedCounterpartyProvider = Readonly<CounterpartyBundleFinalizationProvider>;

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

function snapshotDataValue(
  value: unknown,
  subject: string,
  ancestors: Set<object>,
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new DacsError(`${subject} contains a non-canonical number`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new DacsError(`${subject} must contain data values only`);
  }
  if (nodeTypes.isProxy(value)) {
    throw new DacsError(`${subject} cannot contain proxies`);
  }
  if (ancestors.has(value)) {
    throw new DacsError(`${subject} must be acyclic`);
  }
  ancestors.add(value);
  try {
    if (value instanceof Uint8Array) {
      if (
        Object.getPrototypeOf(value) !== Uint8Array.prototype ||
        Object.getPrototypeOf(value.buffer) !== ArrayBuffer.prototype ||
        value.byteOffset !== 0 ||
        value.byteLength !== value.buffer.byteLength
      ) {
        throw new DacsError(`${subject} contains a non-canonical byte array`);
      }
      const keys = Reflect.ownKeys(value);
      if (
        keys.length !== value.byteLength ||
        keys.some((key, index) => key !== String(index))
      ) {
        throw new DacsError(`${subject} byte arrays cannot carry extra fields`);
      }
      return Uint8Array.from(value);
    }

    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
      throw new DacsError(`${subject} cannot contain symbol fields`);
    }
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) {
        throw new DacsError(`${subject} arrays must use the intrinsic prototype`);
      }
      const keys = Object.keys(descriptors).filter((key) => key !== "length");
      if (
        keys.length !== value.length ||
        keys.some((key, index) => key !== String(index))
      ) {
        throw new DacsError(`${subject} arrays must be dense data arrays`);
      }
      return keys.map((key) => {
        const descriptor = descriptors[key]!;
        if (descriptor.enumerable !== true || !("value" in descriptor)) {
          throw new DacsError(`${subject} cannot contain accessors`);
        }
        return snapshotDataValue(descriptor.value, subject, ancestors);
      });
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DacsError(`${subject} must contain plain records only`);
    }
    const copy = Object.create(prototype) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (
        descriptor.enumerable !== true ||
        !("value" in descriptor) ||
        descriptor.value === undefined
      ) {
        throw new DacsError(
          `${subject} cannot contain accessors or hidden fields`,
        );
      }
      Object.defineProperty(copy, key, {
        value: snapshotDataValue(descriptor.value, subject, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return copy;
  } catch (error) {
    if (error instanceof DacsError) throw error;
    throw new DacsError(`${subject} cannot be inspected safely`, { cause: error });
  } finally {
    ancestors.delete(value);
  }
}

function snapshot<T>(value: T, subject: string): T {
  try {
    return snapshotDataValue(value, subject, new Set()) as T;
  } catch (error) {
    if (error instanceof DacsError) throw error;
    throw new DacsError(`${subject} cannot be snapshotted safely`, { cause: error });
  }
}

async function callbackResult<T>(
  value: Promise<T> | T,
  subject: string,
): Promise<T> {
  if (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    nodeTypes.isProxy(value)
  ) {
    throw new DacsError(`${subject} cannot return a proxy`);
  }
  return value instanceof Promise ? await value : value;
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

function captureCounterparty(
  value: unknown,
  expectedRole?: CounterpartyBundleRole,
): CapturedCounterparty {
  const subject = expectedRole ?? "counterparty";
  if (!isRecord(value)) {
    throw new DacsError(`${subject} signer must be a plain locally controlled party`);
  }
  if (nodeTypes.isProxy(value)) {
    throw new DacsError(`${subject} signer cannot be a proxy`);
  }
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new DacsError(`${subject} signer must be a plain locally controlled party`);
    }
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    if (error instanceof DacsError) throw error;
    throw new DacsError(`${subject} signer cannot be inspected safely`, { cause: error });
  }
  const carriesRole = expectedRole === undefined;
  const expectedKeys = [
    ...(carriesRole ? ["role"] : []),
    "primaryClaim",
    "bundleHash",
    "signer",
  ];
  const descriptorKeys = Reflect.ownKeys(descriptors);
  if (
    descriptorKeys.length !== expectedKeys.length ||
    descriptorKeys.some((key) => typeof key !== "string") ||
    expectedKeys.some((key) => !descriptorKeys.includes(key)) ||
    Object.values(descriptors).some(
      (descriptor) => descriptor.enumerable !== true || !("value" in descriptor),
    )
  ) {
    throw new DacsError(`${subject} signer has a non-canonical or live shape`);
  }
  const role = carriesRole ? descriptors.role?.value : expectedRole;
  const primaryClaim = descriptors.primaryClaim?.value;
  const bundleHash = descriptors.bundleHash?.value;
  const signer = descriptors.signer?.value as SigningSessionParty["signer"] | undefined;
  if (
    (role !== "buyer" && role !== "orchestrator") ||
    typeof primaryClaim !== "string" ||
    primaryClaim.length === 0 ||
    primaryClaim.trim() !== primaryClaim ||
    !isHash(bundleHash) ||
    signer === undefined
  ) {
    throw new DacsError(`${subject} signer identity is malformed`);
  }
  return { role, primaryClaim, bundleHash, signer };
}

function captureBuyer(value: unknown): CapturedCounterparty {
  return captureCounterparty(value, "buyer");
}

const INERT_PROVIDER_RECEIVER = Object.freeze(
  Object.create(null) as Record<string, never>,
);

type DescriptorMap = Record<PropertyKey, PropertyDescriptor>;

function captureDescriptors(value: unknown, subject: string): DescriptorMap {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DacsError(`${subject} must be an object of data properties`);
  }
  if (nodeTypes.isProxy(value)) {
    throw new DacsError(`${subject} cannot be a proxy`);
  }
  try {
    return Object.getOwnPropertyDescriptors(value) as DescriptorMap;
  } catch (error) {
    throw new DacsError(`${subject} cannot be inspected safely`, { cause: error });
  }
}

function requiredDataProperty<T>(
  descriptors: DescriptorMap,
  name: string,
  subject: string,
): T {
  const descriptor = descriptors[name];
  if (!descriptor || !("value" in descriptor)) {
    throw new DacsError(`${subject}.${name} must be one owned data property`);
  }
  return descriptor.value as T;
}

function optionalDataProperty<T>(
  descriptors: DescriptorMap,
  name: string,
  subject: string,
): T | undefined {
  const descriptor = descriptors[name];
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) {
    throw new DacsError(`${subject}.${name} must be one owned data property`);
  }
  return descriptor.value as T;
}

function inertCallback<T>(value: unknown, subject: string): T {
  if (typeof value !== "function") {
    throw new DacsError(`${subject} must be callable`);
  }
  return ((...args: unknown[]) => {
    const returned = Reflect.apply(value, INERT_PROVIDER_RECEIVER, args) as
      | Promise<unknown>
      | unknown;
    return callbackResult(returned, `${subject} callback`);
  }) as T;
}

function requiredCallback<T>(
  descriptors: DescriptorMap,
  name: string,
  subject: string,
): T {
  return inertCallback<T>(
    requiredDataProperty(descriptors, name, subject),
    `${subject}.${name}`,
  );
}

function optionalCallback<T>(
  descriptors: DescriptorMap,
  name: string,
  subject: string,
): T | undefined {
  const value = optionalDataProperty<unknown>(descriptors, name, subject);
  return value === undefined
    ? undefined
    : inertCallback<T>(value, `${subject}.${name}`);
}

function retainBundleCopyVerifier(
  value: unknown,
  role: CounterpartyBundleRole,
): BundleCopyDeps {
  const subject = `${role} bundle copy verifier`;
  const descriptors = captureDescriptors(value, subject);
  return Object.freeze({
    resolvePublicKey: requiredCallback<BundleCopyDeps["resolvePublicKey"]>(
      descriptors,
      "resolvePublicKey",
      subject,
    ),
    verify: requiredCallback<BundleCopyDeps["verify"]>(
      descriptors,
      "verify",
      subject,
    ),
  });
}

function retainCompositeVerificationDeps(
  value: unknown,
  role: CounterpartyBundleRole,
): SellerCompositeVerificationDeps {
  const subject = `${role} composite verification dependencies`;
  const descriptors = captureDescriptors(value, subject);
  const verifyRequirementParameters = optionalCallback<
    NonNullable<SellerCompositeVerificationDeps["verifyRequirementParameters"]>
  >(
    descriptors,
    "verifyRequirementParameters",
    subject,
  );
  return Object.freeze({
    resolveRecipe: requiredCallback<SellerCompositeVerificationDeps["resolveRecipe"]>(
      descriptors,
      "resolveRecipe",
      subject,
    ),
    isRecipeSignerAuthorized: requiredCallback<
      SellerCompositeVerificationDeps["isRecipeSignerAuthorized"]
    >(
      descriptors,
      "isRecipeSignerAuthorized",
      subject,
    ),
    isVerifyResultSignerAuthorized: requiredCallback<
      SellerCompositeVerificationDeps["isVerifyResultSignerAuthorized"]
    >(
      descriptors,
      "isVerifyResultSignerAuthorized",
      subject,
    ),
    resolvePublicKey: requiredCallback<
      SellerCompositeVerificationDeps["resolvePublicKey"]
    >(
      descriptors,
      "resolvePublicKey",
      subject,
    ),
    verify: requiredCallback<SellerCompositeVerificationDeps["verify"]>(
      descriptors,
      "verify",
      subject,
    ),
    verifyAuthorityAttestation: requiredCallback<
      SellerCompositeVerificationDeps["verifyAuthorityAttestation"]
    >(
      descriptors,
      "verifyAuthorityAttestation",
      subject,
    ),
    ...(verifyRequirementParameters ? { verifyRequirementParameters } : {}),
  });
}

function retainedSellerReadProviderFrom(
  descriptors: DescriptorMap,
  role: CounterpartyBundleRole,
): RetainedSellerReadProvider {
  const subject = `${role} seller-verification provider`;
  const mapping = requiredDataProperty<unknown>(descriptors, "mapping", subject);
  if (mapping !== "pure" && mapping !== "write-input") {
    throw new DacsError(`unsupported ${role} bundle address mapping policy`);
  }
  const resolveBundleBinding = optionalCallback<
    NonNullable<SellerBundleFinalizationReadProvider["resolveBundleBinding"]>
  >(descriptors, "resolveBundleBinding", subject);
  const verifyBundleBinding = optionalCallback<
    NonNullable<SellerBundleFinalizationReadProvider["verifyBundleBinding"]>
  >(descriptors, "verifyBundleBinding", subject);
  if (
    mapping === "write-input" &&
    (resolveBundleBinding === undefined || verifyBundleBinding === undefined)
  ) {
    throw new DacsError(`write-input ${role} bundle mapping lacks its BB-1 read seams`);
  }
  const verifyPayloadMethodProof = optionalCallback<
    NonNullable<SellerBundleFinalizationReadProvider["verifyPayloadMethodProof"]>
  >(descriptors, "verifyPayloadMethodProof", subject);
  const verifyPayloadMethodTransaction = optionalCallback<
    NonNullable<
      SellerBundleFinalizationReadProvider["verifyPayloadMethodTransaction"]
    >
  >(descriptors, "verifyPayloadMethodTransaction", subject);
  const resolvePaymentPhaseIndex = optionalCallback<
    NonNullable<SellerBundleFinalizationReadProvider["resolvePaymentPhaseIndex"]>
  >(descriptors, "resolvePaymentPhaseIndex", subject);

  return Object.freeze({
    mapping,
    bundleCopyVerifier: retainBundleCopyVerifier(
      requiredDataProperty(descriptors, "bundleCopyVerifier", subject),
      role,
    ),
    compositeVerificationDeps: retainCompositeVerificationDeps(
      requiredDataProperty(descriptors, "compositeVerificationDeps", subject),
      role,
    ),
    resolveDependency: requiredCallback<
      SellerBundleFinalizationReadProvider["resolveDependency"]
    >(descriptors, "resolveDependency", subject),
    verifyDependencyReceipt: requiredCallback<
      SellerBundleFinalizationReadProvider["verifyDependencyReceipt"]
    >(descriptors, "verifyDependencyReceipt", subject),
    verifyDependencyBinding: requiredCallback<
      SellerBundleFinalizationReadProvider["verifyDependencyBinding"]
    >(descriptors, "verifyDependencyBinding", subject),
    verifyListingPublisherIdentityLinkage: requiredCallback<
      SellerBundleFinalizationReadProvider["verifyListingPublisherIdentityLinkage"]
    >(descriptors, "verifyListingPublisherIdentityLinkage", subject),
    verifyVetRequirementProvenance: requiredCallback<
      SellerBundleFinalizationReadProvider["verifyVetRequirementProvenance"]
    >(descriptors, "verifyVetRequirementProvenance", subject),
    ...(verifyPayloadMethodProof ? { verifyPayloadMethodProof } : {}),
    ...(verifyPayloadMethodTransaction ? { verifyPayloadMethodTransaction } : {}),
    ...(resolvePaymentPhaseIndex ? { resolvePaymentPhaseIndex } : {}),
    resolveSellerBundle: requiredCallback<
      SellerBundleFinalizationReadProvider["resolveSellerBundle"]
    >(descriptors, "resolveSellerBundle", subject),
    verifyBundleAnchorReceipt: requiredCallback<
      SellerBundleFinalizationReadProvider["verifyBundleAnchorReceipt"]
    >(descriptors, "verifyBundleAnchorReceipt", subject),
    ...(resolveBundleBinding ? { resolveBundleBinding } : {}),
    ...(verifyBundleBinding ? { verifyBundleBinding } : {}),
  });
}

function retainSellerReadProvider(
  provider: SellerBundleFinalizationReadProvider,
  role: CounterpartyBundleRole,
): RetainedSellerReadProvider {
  return retainedSellerReadProviderFrom(
    captureDescriptors(provider, `${role} seller-verification provider`),
    role,
  );
}

interface CounterpartyProviderCallbackNames {
  resolve: "resolveCounterpartyBundle" | "resolveBuyerBundle";
  submit: "submitCounterpartyBundle" | "submitBuyerBundle";
}

const COUNTERPARTY_PROVIDER_CALLBACKS: CounterpartyProviderCallbackNames = {
  resolve: "resolveCounterpartyBundle",
  submit: "submitCounterpartyBundle",
};

const BUYER_PROVIDER_CALLBACKS: CounterpartyProviderCallbackNames = {
  resolve: "resolveBuyerBundle",
  submit: "submitBuyerBundle",
};

function retainProvider(
  provider: CounterpartyBundleFinalizationProvider | BuyerBundleFinalizationProvider,
  role: CounterpartyBundleRole,
  callbackNames: CounterpartyProviderCallbackNames,
): RetainedCounterpartyProvider {
  const subject = `${role} bundle provider`;
  const descriptors = captureDescriptors(provider, subject);
  const retainedRead = retainedSellerReadProviderFrom(descriptors, role);
  const publishBundleBinding = optionalCallback<
    NonNullable<CounterpartyBundleFinalizationProvider["publishBundleBinding"]>
  >(descriptors, "publishBundleBinding", subject);
  if (retainedRead.mapping === "write-input" && !publishBundleBinding) {
    throw new DacsError(`write-input ${role} bundle mapping lacks its BB-1 write seam`);
  }
  const resolveCounterpartyBundle =
    callbackNames.resolve === "resolveBuyerBundle"
      ? (() => {
          const resolveBuyerBundle = requiredCallback<
            BuyerBundleFinalizationProvider["resolveBuyerBundle"]
          >(descriptors, callbackNames.resolve, subject);
          return (
            logicalAddress: string,
            _localRole: CounterpartyBundleRole,
          ) => resolveBuyerBundle(logicalAddress);
        })()
      : requiredCallback<
          CounterpartyBundleFinalizationProvider["resolveCounterpartyBundle"]
        >(descriptors, callbackNames.resolve, subject);
  const submitCounterpartyBundle =
    callbackNames.submit === "submitBuyerBundle"
      ? (() => {
          const submitBuyerBundle = requiredCallback<
            BuyerBundleFinalizationProvider["submitBuyerBundle"]
          >(descriptors, callbackNames.submit, subject);
          return (
            logicalAddress: string,
            bundle: Readonly<FaultAttestationBundle>,
            _localRole: CounterpartyBundleRole,
          ) => submitBuyerBundle(logicalAddress, bundle);
        })()
      : requiredCallback<
          CounterpartyBundleFinalizationProvider["submitCounterpartyBundle"]
        >(descriptors, callbackNames.submit, subject);
  return Object.freeze({
    ...retainedRead,
    resolveCounterpartyBundle,
    submitCounterpartyBundle,
    ...(publishBundleBinding ? { publishBundleBinding } : {}),
  });
}

async function signCounterpartyBytes(
  localParty: CapturedCounterparty,
  payload: Uint8Array,
  subject: string,
): Promise<Uint8Array> {
  try {
    const signer = localParty.signer;
    const raw =
      typeof signer === "function"
        ? await callbackResult(
            signer(new Uint8Array(payload)),
            `${subject} result`,
          )
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
  role: CounterpartyBundleRole,
): BundleSignature {
  const signature = snapshot(value, `${role} detached signature`) as unknown;
  if (
    !isRecord(signature) ||
    !hasExactKeys(signature, ["party", "algorithm", "value"]) ||
    signature.party !== expectedParty ||
    signature.algorithm !== "ed25519" ||
    !isCanonicalBase64Url(signature.value)
  ) {
    throw new DacsError(
      `${role} detached signature is malformed or identity-rebound`,
    );
  }
  const bytes = Uint8Array.from(Buffer.from(signature.value, "base64url"));
  if (bytes.byteLength !== 64) {
    throw new DacsError(
      `${role} detached signature is not one Ed25519 signature`,
    );
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
    key = await callbackResult(
      verifier.resolvePublicKey(signature.party),
      `${subject} signer key resolution`,
    );
  } catch (error) {
    throw new DacsError(`${subject} signer key resolution failed`, { cause: error });
  }
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
    throw new DacsError(`${subject} signer key cannot be resolved`);
  }
  const raw = Uint8Array.from(Buffer.from(signature.value, "base64url"));
  let verified: boolean;
  try {
    verified = await callbackResult(
      verifier.verify(
        new Uint8Array(payload),
        raw,
        new Uint8Array(key),
      ),
      `${subject} local verification result`,
    );
  } catch (error) {
    throw new DacsError(`${subject} local verification failed`, { cause: error });
  }
  if (verified !== true) {
    throw new DacsError(`${subject} failed local verification`);
  }
}

function authenticatedCounterparty(
  request: CompletedSellerBundleCounterSignatureRequest,
  localParty: CapturedCounterparty,
): void {
  const parties = Array.isArray(request.signedScope.parties)
    ? request.signedScope.parties
    : [];
  const roleParties = parties.filter(
    (party) => isRecord(party) && party.role === localParty.role,
  );
  if (
    roleParties.length !== 1 ||
    roleParties[0]!.primaryClaim !== localParty.primaryClaim ||
    roleParties[0]!.bundleHash !== localParty.bundleHash ||
    request.requiredCounterSigners.filter(
      (claim) => claim === localParty.primaryClaim,
    ).length !== 1
  ) {
    throw new DacsError(
      `counter-signature request is not bound to the local ${localParty.role} IdentityBundle`,
    );
  }
}

async function createCompletedCounterpartySignature(
  localParty: CapturedCounterparty,
  sellerVerificationInput: unknown,
  suppliedRequest: unknown,
  provider: SellerBundleFinalizationReadProvider,
): Promise<BundleSignature> {
  const retainedProvider = retainSellerReadProvider(provider, localParty.role);
  const localVerifier = retainedProvider.bundleCopyVerifier;
  const verificationInput = snapshot(
    sellerVerificationInput,
    `${localParty.role} counter-signature verification input`,
  ) as VerifyCompletedSellerBundleCounterSignatureRequestInput;
  const retainedRequest = snapshot(
    suppliedRequest,
    "supplied seller counter-signature request",
  );
  const request = await callbackResult(
    verifyCompletedSellerBundleCounterSignatureRequest(
      verificationInput,
      retainedRequest,
      retainedProvider,
    ),
    "seller counter-signature request verifier",
  );
  const authenticatedRequest = snapshot(
    request,
    "authenticated seller counter-signature request",
  );
  authenticatedCounterparty(authenticatedRequest, localParty);

  const raw = await signCounterpartyBytes(
    localParty,
    authenticatedRequest.signedBytes,
    `${localParty.role} bundle signer`,
  );
  const signature = validateDetachedSignature(
    {
      party: localParty.primaryClaim,
      algorithm: "ed25519",
      value: Buffer.from(raw).toString("base64url"),
    },
    localParty.primaryClaim,
    localParty.role,
  );
  await locallyVerifySignature(
    signature,
    authenticatedRequest.signedBytes,
    localVerifier,
    `${localParty.role} detached signature`,
  );
  return immutableSnapshot(
    signature,
    `verified ${localParty.role} detached signature`,
  );
}

/**
 * Produce one local role's detached signature after independently rebuilding
 * and authenticating the seller request. No seller or other-role signer is
 * accepted by this boundary.
 */
export async function createCompletedCounterpartyBundleCounterSignature(
  input: CreateCompletedCounterpartyBundleCounterSignatureInput,
  suppliedRequest: unknown,
  provider: SellerBundleFinalizationReadProvider,
): Promise<BundleSignature> {
  const descriptors = captureDescriptors(
    input,
    "counterparty counter-signature input",
  );
  const localParty = captureCounterparty(
    requiredDataProperty(descriptors, "localParty", "counterparty counter-signature input"),
  );
  const sellerVerificationInput = requiredDataProperty(
    descriptors,
    "sellerVerificationInput",
    "counterparty counter-signature input",
  );
  return createCompletedCounterpartySignature(
    localParty,
    sellerVerificationInput,
    suppliedRequest,
    provider,
  );
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
  const descriptors = captureDescriptors(input, "buyer counter-signature input");
  const buyer = captureBuyer(
    requiredDataProperty(descriptors, "buyer", "buyer counter-signature input"),
  );
  const sellerVerificationInput = requiredDataProperty(
    descriptors,
    "sellerVerificationInput",
    "buyer counter-signature input",
  );
  return createCompletedCounterpartySignature(
    buyer,
    sellerVerificationInput,
    suppliedRequest,
    provider,
  );
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
    disposition = await callbackResult(operation(), `${subject} result`);
  } catch (error) {
    throw new SubstrateError(`${subject} verification errored`, { cause: error });
  }
  if (disposition !== "valid") dispositionFailure(subject, disposition);
}

function validateBundleLookup(
  value: unknown,
  role: CounterpartyBundleRole,
): CounterpartyBundleLookup {
  const lookup = snapshot(value, `${role} bundle lookup`) as unknown;
  if (!isRecord(lookup) || typeof lookup.disposition !== "string") {
    throw new SubstrateError(
      `${role} bundle lookup returned an invalid disposition`,
    );
  }
  if (lookup.disposition === "absent" && hasExactKeys(lookup, ["disposition"])) {
    return lookup as unknown as CounterpartyBundleLookup;
  }
  if (
    lookup.disposition === "indeterminate" &&
    hasExactKeys(lookup, ["disposition", "reason"]) &&
    typeof lookup.reason === "string" &&
    lookup.reason.length > 0
  ) {
    return lookup as CounterpartyBundleLookup;
  }
  if (
    lookup.disposition === "present" &&
    hasExactKeys(lookup, ["disposition", "anchored"]) &&
    isRecord(lookup.anchored)
  ) {
    return lookup as unknown as CounterpartyBundleLookup;
  }
  throw new SubstrateError(`${role} bundle lookup returned an invalid disposition`);
}

async function resolveCounterpartyBundle(
  logicalAddress: string,
  role: CounterpartyBundleRole,
  provider: RetainedCounterpartyProvider,
): Promise<CounterpartyBundleLookup> {
  try {
    return validateBundleLookup(
      await callbackResult(
        provider.resolveCounterpartyBundle(logicalAddress, role),
        `${role} bundle lookup`,
      ),
      role,
    );
  } catch (error) {
    if (error instanceof DacsError || error instanceof SubstrateError) throw error;
    throw new SubstrateError(`${role} bundle lookup errored and is indeterminate`, {
      cause: error,
    });
  }
}

async function authenticateAnchoredCounterpartyBundle(
  logicalAddress: string,
  expectedBundle: FaultAttestationBundle,
  value: unknown,
  role: CounterpartyBundleRole,
  provider: RetainedCounterpartyProvider,
): Promise<AnchoredCounterpartyBundle> {
  const anchored = snapshot(value, `anchored ${role} bundle readback`) as unknown;
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
      `${role} bundle readback lacks the exact established finalized publication`,
    );
  }
  const bundle = anchored.bundle as FaultAttestationBundle;
  if (bundle.anchoredByRole !== role) {
    throw new DacsError(`${role} bundle readback has the wrong anchored role`);
  }
  const verdict = await verifyBundleCopy(
    snapshot(
      bundle as unknown as Record<string, unknown>,
      `${role} bundle copy verification`,
    ),
    role,
    provider.bundleCopyVerifier,
  );
  if (!verdict.valid || !verdict.fullySigned) {
    throw new DacsError(
      verdict.valid
        ? `${role} bundle readback is not fully signed`
        : `${role} bundle readback signature verification failed: ${verdict.reason}`,
    );
  }
  await verifyDisposition(`${role} bundle anchor receipt proof`, () =>
    provider.verifyBundleAnchorReceipt(
      snapshot(
        anchored as unknown as AnchoredCounterpartyBundle,
        `${role} bundle receipt verification input`,
      ),
    ),
  );
  return snapshot(
    anchored as unknown as AnchoredCounterpartyBundle,
    `authenticated ${role} bundle readback`,
  );
}

async function publishCounterpartyBundle(
  logicalAddress: string,
  expectedBundle: FaultAttestationBundle,
  role: CounterpartyBundleRole,
  provider: RetainedCounterpartyProvider,
): Promise<AnchoredCounterpartyBundle> {
  let lookup = await resolveCounterpartyBundle(logicalAddress, role, provider);
  if (lookup.disposition === "indeterminate") {
    throw new SubstrateError(
      `${role} bundle lookup is indeterminate: ${lookup.reason}`,
    );
  }
  if (lookup.disposition === "present") {
    return authenticateAnchoredCounterpartyBundle(
      logicalAddress,
      expectedBundle,
      lookup.anchored,
      role,
      provider,
    );
  }

  try {
    await callbackResult(
      provider.submitCounterpartyBundle(
        logicalAddress,
        snapshot(expectedBundle, `${role} bundle submission input`),
        role,
      ),
      `${role} bundle submission`,
    );
  } catch (error) {
    lookup = await resolveCounterpartyBundle(logicalAddress, role, provider);
    if (lookup.disposition !== "present") {
      throw new SubstrateError(
        `${role} bundle submission outcome is ambiguous; resolve before any retry`,
        { cause: error },
      );
    }
    return authenticateAnchoredCounterpartyBundle(
      logicalAddress,
      expectedBundle,
      lookup.anchored,
      role,
      provider,
    );
  }

  lookup = await resolveCounterpartyBundle(logicalAddress, role, provider);
  if (lookup.disposition !== "present") {
    throw new SubstrateError(
      lookup.disposition === "indeterminate"
        ? `${role} bundle readback is indeterminate: ${lookup.reason}`
        : `${role} bundle is authoritatively absent after submission`,
    );
  }
  return authenticateAnchoredCounterpartyBundle(
    logicalAddress,
    expectedBundle,
    lookup.anchored,
    role,
    provider,
  );
}

function expectedBinding(
  jobId: string,
  localParty: CapturedCounterparty,
  anchored: AnchoredCounterpartyBundle,
  bundleContentHash: string,
): Omit<BundleBinding, "signature"> {
  return {
    bindingVersion: "1",
    jobId,
    role: localParty.role,
    logicalAddress: bundleAddress(jobId, localParty.role),
    nativeAddress: anchored.nativeAddress,
    bundleContentHash,
    ...(anchored.anchorTx === undefined ? {} : { anchorTx: anchored.anchorTx }),
    signer: localParty.primaryClaim,
  };
}

function validateBindingLookup(
  value: unknown,
  role: CounterpartyBundleRole,
): SellerBundleBindingLookup {
  const lookup = snapshot(value, `${role} BundleBinding lookup`) as unknown;
  if (!isRecord(lookup) || typeof lookup.disposition !== "string") {
    throw new SubstrateError(
      `${role} BundleBinding lookup returned an invalid disposition`,
    );
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
  throw new SubstrateError(
    `${role} BundleBinding lookup returned an invalid disposition`,
  );
}

async function resolveBinding(
  logicalAddress: string,
  signer: string,
  role: CounterpartyBundleRole,
  provider: RetainedCounterpartyProvider,
): Promise<SellerBundleBindingLookup> {
  if (!provider.resolveBundleBinding) {
    throw new DacsError(`${role} BundleBinding lookup seam is unavailable`);
  }
  try {
    return validateBindingLookup(
      await callbackResult(
        provider.resolveBundleBinding(logicalAddress, signer),
        `${role} BundleBinding lookup`,
      ),
      role,
    );
  } catch (error) {
    if (error instanceof DacsError) throw error;
    throw new SubstrateError(`${role} BundleBinding lookup errored`, {
      cause: error,
    });
  }
}

async function authenticateBinding(
  value: unknown,
  expected: Omit<BundleBinding, "signature">,
  localParty: CapturedCounterparty,
  provider: RetainedCounterpartyProvider,
): Promise<BundleBinding> {
  const role = localParty.role;
  const binding = snapshot(value, `${role} BundleBinding readback`) as unknown;
  if (
    !isBundleBinding(binding) ||
    !exact(
      Object.fromEntries(
        Object.entries(binding).filter(([key]) => key !== "signature"),
      ),
      expected,
    ) ||
    binding.role !== role ||
    binding.signer !== expected.signer ||
    binding.signature.signer !== expected.signer ||
    binding.signature.algorithm !== "ed25519" ||
    !isCanonicalBase64Url(binding.signature.value) ||
    Buffer.from(binding.signature.value, "base64url").byteLength !== 64
  ) {
    throw new DacsError(
      `${role} BundleBinding is malformed or maps different content`,
    );
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
    `${role} BundleBinding signature`,
  );
  if (!provider.verifyBundleBinding) {
    throw new DacsError(`${role} BundleBinding verification seam is unavailable`);
  }
  await verifyDisposition(`${role} BundleBinding provider verification`, () =>
    provider.verifyBundleBinding!(
      snapshot(binding, `${role} BundleBinding provider verification input`),
    ),
  );
  return snapshot(binding, `authenticated ${role} BundleBinding`);
}

function validateBindingPublication(
  value: unknown,
  role: CounterpartyBundleRole,
): SellerBundleBindingPublication {
  const publication = snapshot(
    value,
    `${role} BundleBinding publication result`,
  ) as unknown;
  if (!isRecord(publication) || typeof publication.disposition !== "string") {
    throw new SubstrateError(
      `${role} BundleBinding publisher returned an invalid disposition`,
    );
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
  throw new SubstrateError(
    `${role} BundleBinding publisher returned an invalid disposition`,
  );
}

async function reconcilePublishedBinding(
  expectedBinding: BundleBinding,
  expected: Omit<BundleBinding, "signature">,
  localParty: CapturedCounterparty,
  provider: RetainedCounterpartyProvider,
  cause?: unknown,
): Promise<BundleBinding> {
  const role = localParty.role;
  let lookup: SellerBundleBindingLookup;
  try {
    lookup = await resolveBinding(
      expected.logicalAddress,
      expected.signer,
      role,
      provider,
    );
  } catch (error) {
    throw new SubstrateError(
      `${role} BundleBinding publication outcome is ambiguous; resolve before any retry`,
      { cause: cause ?? error },
    );
  }
  if (lookup.disposition !== "present" || !exact(lookup.binding, expectedBinding)) {
    throw new SubstrateError(
      `${role} BundleBinding publication outcome is ambiguous; resolve before any retry`,
      { cause },
    );
  }
  return authenticateBinding(lookup.binding, expected, localParty, provider);
}

async function publishBinding(
  jobId: string,
  localParty: CapturedCounterparty,
  anchored: AnchoredCounterpartyBundle,
  bundleContentHash: string,
  provider: RetainedCounterpartyProvider,
): Promise<BundleBinding | undefined> {
  const role = localParty.role;
  if (provider.mapping === "pure") return undefined;
  if (!provider.publishBundleBinding) {
    throw new DacsError(`${role} BundleBinding publication seam is unavailable`);
  }
  const expected = expectedBinding(jobId, localParty, anchored, bundleContentHash);
  const lookup = await resolveBinding(
    expected.logicalAddress,
    expected.signer,
    role,
    provider,
  );
  if (lookup.disposition === "indeterminate") {
    throw new SubstrateError(
      `${role} BundleBinding lookup is indeterminate: ${lookup.reason}`,
    );
  }
  if (lookup.disposition === "present") {
    return authenticateBinding(lookup.binding, expected, localParty, provider);
  }

  const binding = await signComponentArtifact(
    expected,
    BUNDLE_BINDING_SEPARATOR,
    {
      algorithm: "ed25519",
      signer: localParty.primaryClaim,
      sign: (bytes) =>
        signCounterpartyBytes(
          localParty,
          bytes,
          `${role} BundleBinding signer`,
        ),
    },
  );
  const authenticatedCandidate = await authenticateBinding(
    binding,
    expected,
    localParty,
    provider,
  );
  let publication: SellerBundleBindingPublication;
  try {
    publication = validateBindingPublication(
      await callbackResult(
        provider.publishBundleBinding(
          snapshot(
            authenticatedCandidate,
            `${role} BundleBinding publication input`,
          ),
        ),
        `${role} BundleBinding publication`,
      ),
      role,
    );
  } catch (error) {
    return reconcilePublishedBinding(
      authenticatedCandidate,
      expected,
      localParty,
      provider,
      error,
    );
  }
  if (publication.disposition === "rejected") {
    throw new DacsError(
      `${role} BundleBinding publication was rejected: ${publication.reason}`,
    );
  }
  if (publication.disposition === "indeterminate") {
    return reconcilePublishedBinding(
      authenticatedCandidate,
      expected,
      localParty,
      provider,
      new SubstrateError(publication.reason),
    );
  }

  const published = await resolveBinding(
    expected.logicalAddress,
    expected.signer,
    role,
    provider,
  );
  if (published.disposition !== "present" || !exact(published.binding, authenticatedCandidate)) {
    throw new SubstrateError(
      `published ${role} BundleBinding is not independently readable and exact`,
    );
  }
  return authenticateBinding(
    published.binding,
    expected,
    localParty,
    provider,
  );
}

function validateCounterpartyIdentityAndSignature(
  bundle: FaultAttestationBundle,
  localParty: CapturedCounterparty,
  suppliedCounterSignature: unknown,
  sellerVerificationInput: VerifyFinalizedSellerBundleInput,
): BundleSignature {
  const role = localParty.role;
  if (bundle.anchoredByRole !== role) {
    throw new DacsError(
      `seller finalization returned the wrong ${role} bundle role`,
    );
  }
  const parties = bundle.parties.filter((party) => party.role === role);
  if (
    parties.length !== 1 ||
    parties[0]!.primaryClaim !== localParty.primaryClaim ||
    parties[0]!.bundleHash !== localParty.bundleHash
  ) {
    throw new DacsError(`finalized ${role} bundle is identity-rebound`);
  }
  const signature = validateDetachedSignature(
    suppliedCounterSignature,
    localParty.primaryClaim,
    role,
  );
  const embedded = bundle.signatures.filter(
    (candidate) => candidate.party === localParty.primaryClaim,
  );
  const retained = sellerVerificationInput.counterSignatures?.filter(
    (candidate) => candidate.party === localParty.primaryClaim,
  );
  if (
    embedded.length !== 1 ||
    retained?.length !== 1 ||
    !exact(embedded[0], signature) ||
    !exact(retained[0], signature)
  ) {
    throw new DacsError(
      `finalized ${role} bundle substituted the reviewed detached signature`,
    );
  }
  return signature;
}

function selectCounterpartyBundle(
  sellerFinalization: Readonly<{
    buyerBundle: FaultAttestationBundle;
    orchestratorBundle?: FaultAttestationBundle;
  }>,
  role: CounterpartyBundleRole,
): FaultAttestationBundle {
  if (role === "buyer") {
    return snapshot(
      sellerFinalization.buyerBundle,
      "authenticated buyer role copy",
    );
  }
  if (!sellerFinalization.orchestratorBundle) {
    throw new DacsError(
      "seller finalization lacks the authenticated orchestrator role copy",
    );
  }
  return snapshot(
    sellerFinalization.orchestratorBundle,
    "authenticated orchestrator role copy",
  );
}

async function finalizeCompletedCounterparty(
  localParty: CapturedCounterparty,
  sellerVerificationInput: unknown,
  sellerFinalization: unknown,
  counterSignature: unknown,
  provider: CounterpartyBundleFinalizationProvider | BuyerBundleFinalizationProvider,
  callbackNames: CounterpartyProviderCallbackNames,
): Promise<FinalizedCounterpartyBundle> {
  const role = localParty.role;
  const retainedProvider = retainProvider(provider, role, callbackNames);
  const verificationInput = snapshot(
    sellerVerificationInput,
    `${role} seller-finalization verification input`,
  ) as VerifyFinalizedSellerBundleInput;
  const suppliedSellerFinalization = snapshot(
    sellerFinalization,
    "supplied seller finalization",
  );
  const suppliedCounterSignature = snapshot(
    counterSignature,
    `supplied ${role} counter-signature`,
  );

  const verifiedSellerFinalization = await callbackResult(
    verifyFinalizedSellerBundleReadOnly(
      verificationInput,
      suppliedSellerFinalization,
      retainedProvider,
    ),
    "seller finalization verifier",
  );
  const authenticated = snapshot(
    verifiedSellerFinalization,
    "authenticated seller finalization",
  );
  const roleBundle = selectCounterpartyBundle(authenticated, role);
  const signature = validateCounterpartyIdentityAndSignature(
    roleBundle,
    localParty,
    suppliedCounterSignature,
    verificationInput,
  );
  const bundleContentHash = attestationBundleHash(roleBundle);
  if (
    !isHash(bundleContentHash) ||
    bundleContentHash !== authenticated.bundleContentHash ||
    roleBundle.jobId.length === 0
  ) {
    throw new DacsError(
      `authenticated ${role} role copy changed the seller-reviewed scope`,
    );
  }
  await locallyVerifySignature(
    signature,
    signedBytes(ARTIFACT_SEPARATORS.FaultAttestationBundle, bundleContentHash),
    retainedProvider.bundleCopyVerifier,
    `retained ${role} detached signature`,
  );

  const logicalAddress = bundleAddress(roleBundle.jobId, role);
  const anchored = await publishCounterpartyBundle(
    logicalAddress,
    roleBundle,
    role,
    retainedProvider,
  );
  const binding = await publishBinding(
    roleBundle.jobId,
    localParty,
    anchored,
    bundleContentHash,
    retainedProvider,
  );
  return immutableSnapshot(
    {
      state: "finalised" as const,
      role,
      logicalAddress,
      nativeAddress: anchored.nativeAddress,
      bundleContentHash,
      bundle: roleBundle,
      anchorReceipt: anchored.anchorReceipt,
      ...(anchored.anchorTx === undefined ? {} : { anchorTx: anchored.anchorTx }),
      ...(binding === undefined ? {} : { binding }),
    },
    `finalized ${role} bundle result`,
  );
}

/**
 * Publish only the exact locally owned role copy from an independently
 * authenticated seller finalization. The pure core performs read-before-write
 * reconciliation but deliberately owns no durable lease or generation fence.
 */
export async function finalizeCompletedCounterpartyBundleCore(
  input: FinalizeCompletedCounterpartyBundleInput,
  provider: CounterpartyBundleFinalizationProvider,
): Promise<FinalizedCounterpartyBundle> {
  const descriptors = captureDescriptors(
    input,
    "counterparty seller-finalization input",
  );
  const localParty = captureCounterparty(
    requiredDataProperty(
      descriptors,
      "localParty",
      "counterparty seller-finalization input",
    ),
  );
  return finalizeCompletedCounterparty(
    localParty,
    requiredDataProperty(
      descriptors,
      "sellerVerificationInput",
      "counterparty seller-finalization input",
    ),
    requiredDataProperty(
      descriptors,
      "sellerFinalization",
      "counterparty seller-finalization input",
    ),
    requiredDataProperty(
      descriptors,
      "counterSignature",
      "counterparty seller-finalization input",
    ),
    provider,
    COUNTERPARTY_PROVIDER_CALLBACKS,
  );
}

/**
 * Publish the exact authenticated buyer role copy. Completion is withheld until
 * the finalized readback (and, for write-input mappings, buyer-signed BB-1
 * binding) is independently verified. Existing different publications are
 * never overwritten. This is the pure effect core, not a durability boundary:
 * overlapping calls and crash recovery require a serialized, generation-fenced
 * wrapper around the provider's write seams.
 */
export async function finalizeCompletedBuyerBundleCore(
  input: FinalizeCompletedBuyerBundleInput,
  provider: BuyerBundleFinalizationProvider,
): Promise<FinalizedBuyerBundle> {
  const descriptors = captureDescriptors(input, "buyer seller-finalization input");
  const buyer = captureBuyer(
    requiredDataProperty(descriptors, "buyer", "buyer seller-finalization input"),
  );
  const result = await finalizeCompletedCounterparty(
    buyer,
    requiredDataProperty(
      descriptors,
      "sellerVerificationInput",
      "buyer seller-finalization input",
    ),
    requiredDataProperty(
      descriptors,
      "sellerFinalization",
      "buyer seller-finalization input",
    ),
    requiredDataProperty(
      descriptors,
      "counterSignature",
      "buyer seller-finalization input",
    ),
    provider,
    BUYER_PROVIDER_CALLBACKS,
  );
  return immutableSnapshot(
    {
      state: "finalised" as const,
      logicalAddress: result.logicalAddress,
      nativeAddress: result.nativeAddress,
      bundleContentHash: result.bundleContentHash,
      buyerBundle: result.bundle,
      anchorReceipt: result.anchorReceipt,
      ...(result.anchorTx === undefined ? {} : { anchorTx: result.anchorTx }),
      ...(result.binding === undefined ? {} : { binding: result.binding }),
    },
    "finalized buyer bundle result",
  );
}
