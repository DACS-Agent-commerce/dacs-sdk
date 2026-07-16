import { contentHash, stripSignature } from "../canonical/index.js";
import { type DomainSeparator, signedBytes } from "../crypto/index.js";
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

export function isComponentSignature(
  value: unknown,
): value is ComponentSignature {
  return (
    isRecord(value) &&
    typeof value.algorithm === "string" &&
    ALGORITHM_SET.has(value.algorithm) &&
    isNonEmptyString(value.signer) &&
    isNonEmptyString(value.value)
  );
}

/** A standalone artifact carrying one normative ComponentSignature envelope. */
export type ComponentSignedArtifact<T extends object> = Omit<T, "signature"> & {
  signature: ComponentSignature;
};

/**
 * Signs the already-domain-separated bytes. Returning bytes uses the SDK's
 * unpadded standard-base64 encoding; returning a string preserves a wallet's
 * native wire encoding.
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
  | "signed-scope-not-canonicalizable";

export type ComponentSignatureUnresolvedReason =
  | "authorization-unresolved"
  | "signer-key-not-found"
  | "signer-key-resolution-failed";

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
   */
  isSignerAuthorized: (
    artifact: Readonly<Record<string, unknown>>,
    signature: Readonly<ComponentSignature>,
  ) => Promise<boolean> | boolean;
  /** Resolve the key appropriate for both the signer claim and algorithm. */
  resolvePublicKey: (
    signature: Readonly<ComponentSignature>,
  ) => Promise<TKey | null> | TKey | null;
  /** Verify the envelope value using the injected algorithm implementation. */
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
  if (!isNonEmptyString(value.value)) return "invalid-value";
  return null;
}

function asRecord(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
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

function encodedSignatureValue(value: Uint8Array | string): string {
  const encoded =
    typeof value === "string"
      ? value
      : Buffer.from(value).toString("base64").replace(/=+$/, "");
  if (!isNonEmptyString(encoded)) {
    throw new DacsError("component signer returned an empty signature value");
  }
  return encoded;
}

/**
 * Construct a ComponentSignature over `separator || contentHash(artifact)`.
 * The input must be unsigned; this prevents accidentally replacing or nesting
 * an existing signature while producing a new envelope.
 */
export async function buildComponentSignature(
  artifact: object,
  separator: DomainSeparator,
  options: BuildComponentSignatureOptions,
): Promise<ComponentSignature> {
  assertUnsignedComponentArtifact(artifact);
  if (!ALGORITHM_SET.has(options.algorithm)) {
    throw new DacsError(`unsupported signature algorithm: ${options.algorithm}`);
  }
  if (!isNonEmptyString(options.signer)) {
    throw new DacsError("component signature signer must be a non-empty string");
  }

  const context = { algorithm: options.algorithm, signer: options.signer };
  const bytes = signedBytes(separator, contentHash(asRecord(artifact)));
  const value = encodedSignatureValue(await options.sign(bytes, context));
  return { ...context, value };
}

/** Build and attach a ComponentSignature without mutating the input artifact. */
export async function signComponentArtifact<T extends object>(
  artifact: T,
  separator: DomainSeparator,
  options: BuildComponentSignatureOptions,
): Promise<ComponentSignedArtifact<T>> {
  const signature = await buildComponentSignature(artifact, separator, options);
  return { ...artifact, signature } as ComponentSignedArtifact<T>;
}

/**
 * Verify one standalone ComponentSignature. The signed scope is reconstructed
 * from the complete artifact as received, omitting only signature field(s), so
 * unknown artifact fields remain hash-bound as required by SIG-5.
 */
export async function verifyComponentSignature<TKey>(
  artifact: Record<string, unknown>,
  separator: DomainSeparator,
  deps: VerifyComponentSignatureDeps<TKey>,
): Promise<ComponentSignatureVerification> {
  if (!Object.prototype.hasOwnProperty.call(artifact, "signature")) {
    return { status: "missing" };
  }
  if (Object.prototype.hasOwnProperty.call(artifact, "signatures")) {
    return { status: "malformed", reason: "ambiguous-signature-fields" };
  }

  const rawSignature = artifact.signature;
  const malformedReason = signatureShapeReason(rawSignature);
  if (malformedReason) {
    return { status: "malformed", reason: malformedReason };
  }
  const signature = rawSignature as ComponentSignature;

  let authorized: boolean;
  try {
    authorized = await deps.isSignerAuthorized(artifact, signature);
  } catch {
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
    publicKey = await deps.resolvePublicKey(signature);
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
    payload = signedBytes(separator, contentHash(stripSignature(artifact)));
  } catch {
    return {
      status: "malformed",
      reason: "signed-scope-not-canonicalizable",
    };
  }

  try {
    const valid = await deps.verify({ signedBytes: payload, signature, publicKey });
    return valid
      ? { status: "valid", signature }
      : {
          status: "invalid",
          reason: "cryptographic-verification-failed",
          signature,
        };
  } catch {
    return {
      status: "invalid",
      reason: "cryptographic-verification-failed",
      signature,
    };
  }
}
