import { contentHash } from "../canonical/index.js";
import { snapshotCanonicalJson } from "../canonical/snapshot.js";
import {
  type DomainSeparator,
  isCompositeSeparator,
  isRegisteredSeparator,
  signedBytes,
} from "../crypto/index.js";
import { DacsError } from "../errors.js";

import type {
  ComponentSignature,
  ComponentSignatureAlgorithm,
} from "./types.js";

/** Closed algorithm set used by ComponentSignature in the DACS v0.x line. */
export const COMPONENT_SIGNATURE_ALGORITHMS = [
  "ed25519",
  "ecdsa-secp256k1",
  "sr1-aggregate",
] as const satisfies readonly ComponentSignatureAlgorithm[];

const ALGORITHM_SET: ReadonlySet<string> = new Set(
  COMPONENT_SIGNATURE_ALGORITHMS,
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;

/** True only for the canonical, unpadded RFC 4648 base64url spelling. */
function isCanonicalBase64Url(value: unknown): value is string {
  if (!isNonEmptyString(value) || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    return Buffer.from(value, "base64url").toString("base64url") === value;
  } catch {
    return false;
  }
}

export function isComponentSignature(
  value: unknown,
): value is ComponentSignature {
  return (
    isRecord(value) &&
    typeof value.algorithm === "string" &&
    ALGORITHM_SET.has(value.algorithm) &&
    isNonEmptyString(value.signer) &&
    isCanonicalBase64Url(value.value)
  );
}

/** A standalone artifact carrying one normative ComponentSignature envelope. */
export type ComponentSignedArtifact<T extends object> = Omit<T, "signature"> & {
  signature: ComponentSignature;
};

/**
 * Signs the already-domain-separated bytes. Returning bytes uses the SDK's
 * unpadded base64url encoding. String-returning wallets must already return
 * that canonical wire encoding; alternate encodings are rejected.
 */
export type ComponentSigner = (
  bytes: Uint8Array,
  context: Pick<ComponentSignature, "algorithm" | "signer">,
) => Promise<Uint8Array | string> | Uint8Array | string;

export interface BuildComponentSignatureOptions {
  algorithm: ComponentSignatureAlgorithm;
  signer: string;
  sign: ComponentSigner;
}

interface CapturedComponentSignatureOptions {
  algorithm: ComponentSignatureAlgorithm;
  signer: string;
  sign: ComponentSigner;
}

export type ComponentSignatureStatus =
  | "missing"
  | "malformed"
  | "unresolved"
  | "invalid"
  | "valid";

export type ComponentSignatureMalformedReason =
  | "signature-not-an-object"
  | "unsupported-algorithm"
  | "invalid-signer"
  | "invalid-value"
  | "ambiguous-signature-fields"
  | "unregistered-domain-separator"
  | "composite-domain-separator"
  | "signed-scope-not-canonicalizable";

export type ComponentSignatureUnresolvedReason =
  | "authorization-unresolved"
  | "signer-key-not-found"
  | "signer-key-resolution-failed"
  | "verification-error";

export type ComponentSignatureInvalidReason =
  | "signer-not-authorized"
  | "cryptographic-verification-failed";

/**
 * Explicit verification result. `unresolved` is intentionally distinct from
 * `invalid`: inability to resolve trust material is not proof of a bad signature.
 */
export type ComponentSignatureVerification =
  | { status: "missing" }
  | { status: "malformed"; reason: ComponentSignatureMalformedReason }
  | {
      status: "unresolved";
      reason: ComponentSignatureUnresolvedReason;
      signature: ComponentSignature;
    }
  | {
      status: "invalid";
      reason: ComponentSignatureInvalidReason;
      signature: ComponentSignature;
    }
  | { status: "valid"; signature: ComponentSignature };

export interface VerifyComponentSignatureInput<TKey> {
  signedBytes: Uint8Array;
  signature: ComponentSignature;
  publicKey: TKey;
}

export interface VerifyComponentSignatureDeps<TKey> {
  /**
   * Artifact-specific role policy. This is required so a cryptographically
   * valid outsider signature cannot be mistaken for an authorised signature.
   * It runs before cryptographic verification and MUST be a pure comparison:
   * policy code MUST NOT perform side effects based on the as-yet-unverified
   * artifact fields.
   */
  isSignerAuthorized: (
    artifact: Readonly<Record<string, unknown>>,
    signature: Readonly<ComponentSignature>,
  ) => Promise<boolean> | boolean;
  /** Resolve the key appropriate for both the signer claim and algorithm. */
  resolvePublicKey: (
    signature: Readonly<ComponentSignature>,
  ) => Promise<TKey | null> | TKey | null;
  /**
   * Verify the envelope value using the injected algorithm implementation.
   * Return false for a cryptographic mismatch; throw only when verification
   * cannot be evaluated, which is reported as `unresolved` rather than invalid.
   */
  verify: (
    input: VerifyComponentSignatureInput<TKey>,
  ) => Promise<boolean> | boolean;
}

function signatureShapeReason(
  value: unknown,
): ComponentSignatureMalformedReason | null {
  if (!isRecord(value)) return "signature-not-an-object";
  if (
    typeof value.algorithm !== "string" ||
    !ALGORITHM_SET.has(value.algorithm)
  ) {
    return "unsupported-algorithm";
  }
  if (!isNonEmptyString(value.signer)) return "invalid-signer";
  if (!isCanonicalBase64Url(value.value)) return "invalid-value";
  return null;
}

function asRecord(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/** Take an exact JSON ownership boundary before any user-supplied callback. */
function snapshotArtifact<T extends object>(artifact: T): T {
  return snapshotCanonicalJson(artifact, "component signature artifact");
}

function assertUnsignedComponentArtifact(artifact: object): void {
  const record = asRecord(artifact);
  if (
    Object.prototype.hasOwnProperty.call(record, "signature") ||
    Object.prototype.hasOwnProperty.call(record, "signatures")
  ) {
    throw new DacsError(
      "component-signature signing requires an unsigned artifact with no signature field",
    );
  }
}

function encodedSignatureValue(value: unknown): string {
  if (typeof value !== "string" && !(value instanceof Uint8Array)) {
    throw new DacsError(
      "component signer must return signature bytes or a canonical unpadded base64url string",
    );
  }
  const encoded =
    typeof value === "string"
      ? value
      : Buffer.from(value).toString("base64url");
  if (!isCanonicalBase64Url(encoded)) {
    throw new DacsError(
      "component signer must return a canonical unpadded base64url signature value",
    );
  }
  return encoded;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function captureComponentSignatureOptions(
  options: BuildComponentSignatureOptions,
): CapturedComponentSignatureOptions {
  // Read each caller-owned option exactly once and preserve method-style
  // callback binding before inspecting the artifact. Artifact accessors must
  // not be able to switch the signer configuration selected at API entry.
  const algorithm = options.algorithm;
  const signer = options.signer;
  const signCandidate = options.sign;
  if (!ALGORITHM_SET.has(algorithm)) {
    throw new DacsError(`unsupported signature algorithm: ${algorithm}`);
  }
  if (!isNonEmptyString(signer)) {
    throw new DacsError("component signature signer must be a non-empty string");
  }
  if (typeof signCandidate !== "function") {
    throw new DacsError("component signature signer callback must be a function");
  }

  return {
    algorithm,
    signer,
    sign: Function.prototype.bind.call(
      signCandidate,
      options,
    ) as ComponentSigner,
  };
}

async function buildComponentSignatureFromSnapshot(
  artifact: object,
  separator: DomainSeparator,
  options: CapturedComponentSignatureOptions,
): Promise<ComponentSignature> {
  assertUnsignedComponentArtifact(artifact);
  if (!isRegisteredSeparator(separator)) {
    throw new DacsError(`unregistered domain separator: ${separator}`);
  }
  if (isCompositeSeparator(separator)) {
    // A ComponentSignature is a single-hash envelope; a composite-payload
    // separator (§B.7) must use its recipe-specific signer, not this path.
    throw new DacsError(
      `composite-payload separator ${separator} is not a single-hash ` +
        `ComponentSignature recipe (§B.7)`,
    );
  }

  // These values were captured before any caller-owned artifact property was
  // read. A wallet callback (or another task running while it is pending)
  // therefore cannot switch the advertised algorithm, signer, or
  // implementation after the operation begins.
  const algorithm = options.algorithm;
  const signer = options.signer;
  const sign = options.sign;

  const context = { algorithm, signer };
  const expectedBytes = signedBytes(separator, contentHash(asRecord(artifact)));
  const callbackBytes = Uint8Array.from(expectedBytes);
  const callbackContext = { ...context };
  const rawValue = await sign(callbackBytes, callbackContext);

  // The callback receives isolated inputs. Reject visible mutation as a wallet
  // contract violation rather than accidentally accepting a signature over
  // bytes or identity metadata other than the values selected above.
  if (
    !sameBytes(callbackBytes, expectedBytes) ||
    callbackContext.algorithm !== algorithm ||
    callbackContext.signer !== signer ||
    Object.keys(callbackContext).length !== 2
  ) {
    throw new DacsError("component signer must not mutate its signing inputs");
  }

  return { ...context, value: encodedSignatureValue(rawValue) };
}

/**
 * Construct a ComponentSignature over `separator || contentHash(artifact)`.
 * The input must be unsigned; this prevents accidentally replacing or nesting
 * an existing signature while producing a new envelope. This foundation
 * accepts only the closed v0.x separator registry; SIG-4 `dacs-x-*` extension
 * signing remains on the lower-level signing surface until it has a typed API.
 */
export async function buildComponentSignature(
  artifact: object,
  separator: DomainSeparator,
  options: BuildComponentSignatureOptions,
): Promise<ComponentSignature> {
  const capturedOptions = captureComponentSignatureOptions(options);
  const artifactSnapshot = snapshotArtifact(artifact);
  return buildComponentSignatureFromSnapshot(
    artifactSnapshot,
    separator,
    capturedOptions,
  );
}

/** Build and attach a ComponentSignature without mutating the input artifact. */
export async function signComponentArtifact<T extends object>(
  artifact: T,
  separator: DomainSeparator,
  options: BuildComponentSignatureOptions,
): Promise<ComponentSignedArtifact<T>> {
  const capturedOptions = captureComponentSignatureOptions(options);
  const artifactSnapshot = snapshotArtifact(artifact);
  const signature = await buildComponentSignatureFromSnapshot(
    artifactSnapshot,
    separator,
    capturedOptions,
  );
  return { ...artifactSnapshot, signature } as ComponentSignedArtifact<T>;
}

/**
 * Verify one standalone ComponentSignature. The signed scope is reconstructed
 * from the complete artifact as received, omitting only signature field(s), so
 * unknown artifact fields remain hash-bound as required by SIG-5. As a
 * deliberate SDK fail-closed rule, an object carrying both singular `signature`
 * and plural `signatures` fields is rejected as ambiguous and must use its
 * artifact-specific multi-signature verifier instead.
 */
export async function verifyComponentSignature<TKey>(
  artifact: Record<string, unknown>,
  separator: DomainSeparator,
  deps: VerifyComponentSignatureDeps<TKey>,
): Promise<ComponentSignatureVerification> {
  if (!isRegisteredSeparator(separator)) {
    return { status: "malformed", reason: "unregistered-domain-separator" };
  }
  if (isCompositeSeparator(separator)) {
    return { status: "malformed", reason: "composite-domain-separator" };
  }

  // Snapshot the complete received artifact and dependency functions before
  // crossing an async trust boundary. Caller mutation while authorisation or
  // key resolution is pending must never change the scope ultimately verified.
  let artifactSnapshot: Record<string, unknown>;
  try {
    if (!isRecord(artifact)) throw new TypeError();
    artifactSnapshot = snapshotArtifact(artifact);
  } catch {
    return {
      status: "malformed",
      reason: "signed-scope-not-canonicalizable",
    };
  }
  if (!Object.prototype.hasOwnProperty.call(artifactSnapshot, "signature")) {
    return { status: "missing" };
  }
  if (Object.prototype.hasOwnProperty.call(artifactSnapshot, "signatures")) {
    return { status: "malformed", reason: "ambiguous-signature-fields" };
  }

  const rawSignature = artifactSnapshot.signature;
  const malformedReason = signatureShapeReason(rawSignature);
  if (malformedReason) {
    return { status: "malformed", reason: malformedReason };
  }
  const signature = rawSignature as ComponentSignature;

  // Preserve method-style callback `this` semantics while preventing a later
  // property replacement on the dependency object from switching policy or
  // crypto implementations mid-verification. Capture all three before the
  // first await; invalid JavaScript inputs fail into their explicit unresolved
  // category rather than escaping as an unhandled TypeError.
  let isSignerAuthorized: VerifyComponentSignatureDeps<TKey>["isSignerAuthorized"];
  try {
    const candidate: unknown = deps.isSignerAuthorized;
    if (typeof candidate !== "function") throw new TypeError();
    isSignerAuthorized = Function.prototype.bind.call(
      candidate,
      deps,
    ) as VerifyComponentSignatureDeps<TKey>["isSignerAuthorized"];
  } catch {
    return {
      status: "unresolved",
      reason: "authorization-unresolved",
      signature,
    };
  }
  let resolvePublicKey: VerifyComponentSignatureDeps<TKey>["resolvePublicKey"];
  try {
    const candidate: unknown = deps.resolvePublicKey;
    if (typeof candidate !== "function") throw new TypeError();
    resolvePublicKey = Function.prototype.bind.call(
      candidate,
      deps,
    ) as VerifyComponentSignatureDeps<TKey>["resolvePublicKey"];
  } catch {
    return {
      status: "unresolved",
      reason: "signer-key-resolution-failed",
      signature,
    };
  }
  let verify: VerifyComponentSignatureDeps<TKey>["verify"];
  try {
    const candidate: unknown = deps.verify;
    if (typeof candidate !== "function") throw new TypeError();
    verify = Function.prototype.bind.call(
      candidate,
      deps,
    ) as VerifyComponentSignatureDeps<TKey>["verify"];
  } catch {
    return {
      status: "unresolved",
      reason: "verification-error",
      signature,
    };
  }

  let authorized: boolean;
  try {
    authorized = await isSignerAuthorized(
      snapshotArtifact(artifactSnapshot),
      snapshotArtifact(signature),
    );
  } catch {
    return {
      status: "unresolved",
      reason: "authorization-unresolved",
      signature,
    };
  }
  if (authorized !== true && authorized !== false) {
    return {
      status: "unresolved",
      reason: "authorization-unresolved",
      signature,
    };
  }
  if (!authorized) {
    return { status: "invalid", reason: "signer-not-authorized", signature };
  }

  let publicKey: TKey | null;
  try {
    publicKey = await resolvePublicKey(snapshotArtifact(signature));
  } catch {
    return {
      status: "unresolved",
      reason: "signer-key-resolution-failed",
      signature,
    };
  }
  if (publicKey === null) {
    return {
      status: "unresolved",
      reason: "signer-key-not-found",
      signature,
    };
  }

  let payload: Uint8Array;
  try {
    // contentHash omits the signature field(s) but preserves every unknown
    // artifact field, which is the SIG-5 signed scope required here.
    payload = signedBytes(separator, contentHash(artifactSnapshot));
  } catch {
    return {
      status: "malformed",
      reason: "signed-scope-not-canonicalizable",
    };
  }

  try {
    const valid = await verify({
      signedBytes: Uint8Array.from(payload),
      signature: snapshotArtifact(signature),
      publicKey,
    });
    if (valid !== true && valid !== false) {
      return {
        status: "unresolved",
        reason: "verification-error",
        signature,
      };
    }
    return valid
      ? { status: "valid", signature }
      : {
          status: "invalid",
          reason: "cryptographic-verification-failed",
          signature,
        };
  } catch {
    return {
      status: "unresolved",
      reason: "verification-error",
      signature,
    };
  }
}
