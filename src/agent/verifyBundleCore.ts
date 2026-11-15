import { types as nodeTypes } from "node:util";

import { contentHash, stripSignature } from "../canonical/index.js";
import {
  snapshotCanonicalJson,
  snapshotCanonicalJsonRead,
} from "../canonical/snapshot.js";
import { signedBytes, type DomainSeparator } from "../crypto/index.js";
import { DacsError } from "../errors.js";
import {
  ARTIFACT_SEPARATORS,
  RATING_SEPARATOR,
} from "../artifacts/registry.js";
import {
  isCanonicalBase64Url,
  isComponentSignature,
  verifyComponentSignature,
  type ComponentSignatureVerification,
} from "../artifacts/signatures.js";
import {
  parseCanonicalClaimReference,
  sameCanonicalClaimIdentity,
} from "../identity/claimReference.js";
import type {
  AgreementSignature,
  AnyAttestationBundle,
  AttestationRef,
  BundleParty,
  ListingPin,
  CompositeVerificationRecord,
} from "../artifacts/types.js";
import {
  isAgreementArtifact,
  isAnyAttestationBundle,
  isAttestationRef,
  isChainTxRef,
  isCompositeVerificationRecord,
  isListingDraft,
  isRatingRecord,
  isSettlementEvidence,
} from "../artifacts/validators.js";
import { type Verifier } from "./signedArtifact.js";
import {
  isAbsoluteFaultBundle,
  faultedPartyIsPermitted,
  isEvidenceBoundFaultBundle,
  isFaultBundle,
} from "./bundleSemantics.js";
import type { StrictCompositeVerification } from "./compositeVerification.js";
import type { EvidenceBoundBundleVerification } from "./evidenceBoundBundle.js";
import { deepFreeze } from "../internal/deepFreeze.js";

/**
 * Attestation-bundle verification (DACS-5). Two independent checks must BOTH
 * pass for `ok`:
 *
 *  1. Signature — the bundle's signed scope is its canonical form omitting
 *     `signatures` + `anchoredByRole` (§10.4.1); each `signatures[]` entry is an
 *     Ed25519 signature over the type-specific legacy or fault-bundle domain
 *     plus `contentHash(scope)` by a party. We resolve each party's key and check its signature. Verdicts
 *     are honestly four-stated: `valid`, `invalid` (tampering/wrong key), `error`
 *     (key resolved but malformed — §10.4.1 ERROR, not a false FAIL),
 *     `unverified` (no key resolvable).
 *
 *  2. Referenced-artifact authenticity — the bundle's refs (optional
 *     agreementRef, settlementEvidence[], vetRecords[], listingRef) are
 *     content-addressed and independently signed under artifact-specific
 *     domains.
 *     Session refs use DACS-2 §7.5.2
 *     `{anchor:{kind,locator},contentHash,signer?}`. A bundle that is not a
 *     current attestation bundle, including one that carries the earlier
 *     `{kind,id,...}` refs, is refused before any resolver runs. A valid
 *     bundle signature only binds those *hashes*; it does NOT prove the
 *     referenced artifacts exist or are authentic. We therefore dereference
 *     each normative ref, validate its unsigned scope, confirm its content hash,
 *     and authenticate its authorised signer(s). Without the required artifact
 *     or key resolver, refs fail closed and the bundle is NOT ok.
 */

export type SignatureVerdict = "valid" | "invalid" | "error" | "unverified";

export interface SignatureCheck {
  party: string;
  verdict: SignatureVerdict;
}

export type RefVerdict =
  | "ok"
  | "missing"
  | "invalid-shape"
  | "invalid-binding"
  | "hash-mismatch"
  /** Hash and shape match, but the agreement disagrees with its bundle. */
  | "incoherent"
  | "unresolved"
  | "signature-missing"
  | "signature-malformed"
  | "signature-invalid"
  | "signature-unresolved"
  /** Hash-matched, but the artifact failed its own DACS-4/§9.7 semantic verification. */
  | "invalid-evidence"
  /** Hash-matched, but its DACS-2 recursive closure did not verify. */
  | "invalid-vet-record";

export type RefSignatureVerdict =
  | "valid"
  | "missing"
  | "malformed"
  | "invalid"
  | "unresolved";

export interface RefSignatureCheck {
  verdict: RefSignatureVerdict;
  /** Stable diagnostic from envelope, policy, or crypto verification. */
  reason?: string;
  /** Authenticated signer claims when verification succeeds. */
  signers?: string[];
}

export interface RefCheck {
  kind: string;
  id: string;
  verdict: RefVerdict;
  /** Present once shape and content-hash validation reaches authentication. */
  signature?: RefSignatureCheck;
}

export interface BundleVerification {
  /** Bundle and every referenced shape/hash/signature all verified. */
  ok: boolean;
  reason?: string;
  /** Every signature verified against a resolved key. */
  fullyVerified: boolean;
  bundle?: AnyAttestationBundle;
  signatures: SignatureCheck[];
  /** Per-referenced-artifact shape, integrity, and authentication results. */
  refs: RefCheck[];
}

export interface BundleEvidenceVerificationContext {
  bundle: AnyAttestationBundle;
  evidenceRef: AttestationRef;
  agreement: Record<string, unknown> | null;
}

export interface BundleEvidenceVerificationResult {
  decision: "pass" | "fail" | "error" | "indeterminate";
  /**
   * Exact phase-orchestrator claim resolved from authenticated session state.
   * `null` means the authority could not be established. The verifier uses
   * this claim for the artifact-specific signature check; it never infers the
   * evidence signer from an AttestationRef or from arbitrary bundle parties.
   */
  authorizedSigner: string | null;
}

export interface AlternativePaymentBundleVerificationInput {
  bundle: AnyAttestationBundle;
  listing: Record<string, unknown>;
  agreement: Record<string, unknown>;
}

export interface AlternativePaymentBundleVerificationResult {
  decision: "pass" | "fail" | "error" | "indeterminate";
  reason?: string;
}

/**
 * Thrown by `resolveAttestationRef` when it refuses to dereference a reference
 * for a reason other than absence, so the ref is not reported as `missing`.
 * DACS-4 §9.5.8 SB-1: a well-formed PC-2 tuple mismatch is `fail`
 * (`invalid-binding`) and a malformed or non-canonical address is `error`
 * (`invalid-shape`). A resolution that cannot establish its CORE §5.1 receipt
 * or lifecycle gate, including an expired deadline, is `indeterminate`
 * (`unresolved`). Substrate faults are not rejections and propagate unchanged.
 */
export class AttestationRefRejection extends DacsError {
  readonly disposition: "fail" | "error" | "indeterminate";

  constructor(disposition: "fail" | "error" | "indeterminate", message: string) {
    super(message);
    this.name = "AttestationRefRejection";
    this.disposition = disposition;
  }
}

const ATTESTATION_REF_REJECTION_VERDICT: Readonly<
  Record<AttestationRefRejection["disposition"], RefVerdict>
> = Object.freeze({
  fail: "invalid-binding",
  error: "invalid-shape",
  indeterminate: "unresolved",
});

export interface VerifyBundleDeps {
  /** Read a signed artifact at a storage ref (null if absent). */
  readArtifact: (ref: string) => Promise<Record<string, unknown> | null>;
  /**
   * Resolve a referenced session artifact to its stored signed form, by ref kind
   * + the bundle's jobId. Session artifacts are anchored BY A SESSION PARTY (the
   * buyer orchestrates and anchors in this SDK), so name resolution must be
   * owner-bound to THAT party — not to whoever happens to be verifying:
   * a third-party verifier resolving under its own address finds nothing, and
   * owner-binding to the wrong party would let a name-squatter serve forged
   * artifacts. `parties` is the bundle's party list; derive the anchoring
   * party's substrate address from its primaryClaim. Returns null if
   * unresolvable. Omit only if dereferencing isn't possible — the refs then
   * report `unresolved` and the bundle cannot be `ok`. A null return is
   * reported `missing`. Throw an {@link AttestationRefRejection} to classify a
   * refused reference instead, e.g. `indeterminate` when no qualifying carrier
   * exists but absence is not established (CORE §5.1 SR2-12); any other thrown
   * error propagates. `outcome` is the bundle's outcome, for
   * outcome-dependent SR-2 lifecycle gates (DACS-5 SEB-1). It has been checked
   * against the supported outcomes but is not authenticated here: refs
   * resolve even when the bundle signatures fail, and such a bundle is never
   * `ok`. `verifyBundleCore` always passes it; it is optional so
   * three-argument callers still compile, and an implementation called
   * without it MUST apply its strictest gate (`finalized` only), never a
   * looser one.
   */
  resolveAttestationRef?: (
    ref: Readonly<AttestationRef>,
    jobId: string,
    parties: readonly BundleParty[],
    outcome?: AnyAttestationBundle["outcome"],
  ) => Promise<Record<string, unknown> | null>;
  /** Resolve the exact DACS-1 LR-1 Listing tuple carried by a normative bundle. */
  resolveListingRef?: (
    listingRef: Readonly<ListingPin>,
    parties: readonly BundleParty[],
  ) => Promise<Record<string, unknown> | null>;
  /** Resolve a signer DID/claim to its ed25519 public key (null if unknown). */
  resolvePublicKey: (did: string) => Promise<Uint8Array | null>;
  /** Verify a signature over raw bytes for a public key. */
  verify: Verifier;
  /**
   * Semantic and authority check of a hash-matched SettlementEvidence artifact
   * (DACS-4 §9.7) — wire authenticated `verifySettlementEvidence` (with the caller's
   * agreement/rail/orchestrator context) here. The second argument carries the
   * resolved agreement and exact attestation ref needed to build that context;
   * the result also returns the exact authenticated phase orchestrator used to
   * authorize the component signature. Omission fails closed whenever a bundle
   * contains settlement evidence.
   */
  verifyEvidence?: (
    evidence: Record<string, unknown>,
    context: BundleEvidenceVerificationContext,
  ) => Promise<BundleEvidenceVerificationResult>;
  /**
   * Required before evidence interpretation when the authenticated Listing
   * contains `pay-alternative`. Compose the SDK APR listing, signed projection,
   * replacement, and audit gates here; a caller-supplied projected step is not
   * sufficient authority.
   */
  verifyAlternativePaymentProjection?: (
    input: Readonly<AlternativePaymentBundleVerificationInput>,
  ) => Promise<AlternativePaymentBundleVerificationResult>;
  /**
   * Required whenever `vetRecords` is non-empty. This must run the strict
   * DACS-2 verifier with the session's exact bundle/requirement expectations.
   */
  verifyCompositeRecord?: (
    record: Readonly<CompositeVerificationRecord>,
    bundle: Readonly<AnyAttestationBundle>,
  ) => Promise<StrictCompositeVerification>;
  /**
   * Required for an EvidenceBoundFaultAttestationBundle. Compose
   * `verifyEvidenceBoundFaultBundle` with the caller's authenticated Listing,
   * execution-authority, receipt, lifecycle, and exact evidence resolvers.
   */
  verifyEvidenceBound?: (
    bundle: Readonly<Record<string, unknown>>,
  ) => Promise<EvidenceBoundBundleVerification>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function bindMethod<T>(candidate: T, owner: object): T {
  return Function.prototype.bind.call(candidate as Function, owner) as T;
}

function ownDependency(
  deps: VerifyBundleDeps,
  key: keyof VerifyBundleDeps,
  required: boolean,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(deps, key);
  if (!descriptor) {
    if (!required) return undefined;
    throw new DacsError(
      `verifyBundle ${key} dependency must be an enumerable data property`,
    );
  }
  if (!("value" in descriptor) || !descriptor.enumerable) {
    throw new DacsError(
      `verifyBundle ${key} dependency must be an enumerable data property`,
    );
  }
  return descriptor.value;
}

/** Capture every callback once before the first external await. */
function captureVerifyBundleDeps(deps: VerifyBundleDeps): VerifyBundleDeps {
  if (
    deps === null ||
    typeof deps !== "object" ||
    nodeTypes.isProxy(deps) ||
    (Object.getPrototypeOf(deps) !== Object.prototype &&
      Object.getPrototypeOf(deps) !== null)
  ) {
    throw new DacsError("verifyBundle dependencies must be a plain data object");
  }
  const readArtifact = ownDependency(deps, "readArtifact", true);
  const resolveAttestationRef = ownDependency(
    deps,
    "resolveAttestationRef",
    false,
  );
  const resolveListingRef = ownDependency(deps, "resolveListingRef", false);
  const resolvePublicKey = ownDependency(deps, "resolvePublicKey", true);
  const verify = ownDependency(deps, "verify", true);
  const verifyEvidence = ownDependency(deps, "verifyEvidence", false);
  const verifyAlternativePaymentProjection = ownDependency(
    deps,
    "verifyAlternativePaymentProjection",
    false,
  );
  const verifyCompositeRecord = ownDependency(
    deps,
    "verifyCompositeRecord",
    false,
  );
  const verifyEvidenceBound = ownDependency(deps, "verifyEvidenceBound", false);

  if (typeof readArtifact !== "function" || nodeTypes.isProxy(readArtifact)) {
    throw new DacsError(
      "verifyBundle readArtifact dependency must be a non-Proxy function",
    );
  }
  if (
    typeof resolvePublicKey !== "function" ||
    nodeTypes.isProxy(resolvePublicKey)
  ) {
    throw new DacsError(
      "verifyBundle resolvePublicKey dependency must be a non-Proxy function",
    );
  }
  if (typeof verify !== "function" || nodeTypes.isProxy(verify)) {
    throw new DacsError(
      "verifyBundle verify dependency must be a non-Proxy function",
    );
  }
  for (const [label, candidate] of [
    ["resolveAttestationRef", resolveAttestationRef],
    ["resolveListingRef", resolveListingRef],
    ["verifyEvidence", verifyEvidence],
    ["verifyAlternativePaymentProjection", verifyAlternativePaymentProjection],
    ["verifyCompositeRecord", verifyCompositeRecord],
    ["verifyEvidenceBound", verifyEvidenceBound],
  ] as const) {
    if (
      candidate !== undefined &&
      (typeof candidate !== "function" || nodeTypes.isProxy(candidate))
    ) {
      throw new DacsError(
        `verifyBundle ${label} dependency must be a non-Proxy function`,
      );
    }
  }

  return {
    readArtifact: bindMethod(
      readArtifact as VerifyBundleDeps["readArtifact"],
      deps,
    ),
    resolvePublicKey: bindMethod(
      resolvePublicKey as VerifyBundleDeps["resolvePublicKey"],
      deps,
    ),
    verify: bindMethod(verify as VerifyBundleDeps["verify"], deps),
    ...(resolveAttestationRef === undefined
      ? {}
      : {
          resolveAttestationRef: bindMethod(
            resolveAttestationRef as NonNullable<
              VerifyBundleDeps["resolveAttestationRef"]
            >,
            deps,
          ),
        }),
    ...(resolveListingRef === undefined
      ? {}
      : {
          resolveListingRef: bindMethod(
            resolveListingRef as NonNullable<
              VerifyBundleDeps["resolveListingRef"]
            >,
            deps,
          ),
        }),
    ...(verifyEvidence === undefined
      ? {}
      : {
          verifyEvidence: bindMethod(
            verifyEvidence as NonNullable<VerifyBundleDeps["verifyEvidence"]>,
            deps,
          ),
        }),
    ...(verifyAlternativePaymentProjection === undefined
      ? {}
      : {
          verifyAlternativePaymentProjection: bindMethod(
            verifyAlternativePaymentProjection as NonNullable<
              VerifyBundleDeps["verifyAlternativePaymentProjection"]
            >,
            deps,
          ),
        }),
    ...(verifyCompositeRecord === undefined
      ? {}
      : {
          verifyCompositeRecord: async (
            record: Readonly<CompositeVerificationRecord>,
            bundle: Readonly<AnyAttestationBundle>,
          ) => {
            const callback = bindMethod(
            verifyCompositeRecord as NonNullable<
              VerifyBundleDeps["verifyCompositeRecord"]
            >,
            deps,
            );
            const raw = await callback(
              deepFreeze(structuredClone(record)),
              deepFreeze(structuredClone(bundle)),
            );
            return snapshotDependencyRecord(
              raw,
              "CompositeVerificationRecord verification verdict",
            ) as unknown as StrictCompositeVerification;
          },
        }),
    ...(verifyEvidenceBound === undefined
      ? {}
      : {
          verifyEvidenceBound: bindMethod(
            verifyEvidenceBound as NonNullable<VerifyBundleDeps["verifyEvidenceBound"]>,
            deps,
          ),
        }),
  };
}

/** Convert a dependency result into owned JSON; malformed/live values fail shape. */
function snapshotDependencyRecord(
  value: unknown,
  label: string,
): Record<string, unknown> | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return {};
  try {
    return snapshotCanonicalJsonRead(
      value as Record<string, unknown>,
      label,
    );
  } catch {
    return {};
  }
}

/** Shape/hash-check one resolved artifact before attempting authentication. */
function checkArtifact(
  kind: string,
  id: string,
  expectedHash: string,
  validateScope: (v: Record<string, unknown>) => boolean,
  resolved: Record<string, unknown> | null,
): RefCheck {
  if (!resolved) return { kind, id, verdict: "missing" };
  const scope = stripSignature(resolved) as Record<string, unknown>;
  if (!validateScope(scope)) return { kind, id, verdict: "invalid-shape" };
  if (contentHash(scope) !== expectedHash)
    return { kind, id, verdict: "hash-mismatch" };
  return { kind, id, verdict: "ok" };
}

const PLACEHOLDER_SIGNATURE_VALUE = Buffer.alloc(64).toString("base64url");
const PLACEHOLDER_SIGNATURE = {
  algorithm: "ed25519",
  signer: `did:demos:agent:${"00".repeat(32)}`,
  value: PLACEHOLDER_SIGNATURE_VALUE,
} as const;

/** Adapt the shared full-record gate to checkArtifact's signature-omitted scope. */
function isRatingRecordSignedScope(scope: Record<string, unknown>): boolean {
  return typeof scope.rater === "string" && isRatingRecord({
    ...scope,
    signature: { ...PLACEHOLDER_SIGNATURE, signer: scope.rater },
  });
}

function agreementRoleClaims(
  scope: Record<string, unknown>,
): { buyer: string; seller: string } | null {
  if (!Array.isArray(scope.parties)) return null;
  const parties = scope.parties.filter(
    (party): party is Record<string, unknown> =>
      party !== null && typeof party === "object" && !Array.isArray(party),
  );
  const buyers = parties.filter((party) => party.role === "buyer");
  const sellers = parties.filter((party) => party.role === "seller");
  const buyer = buyers[0]?.primaryClaim;
  const seller = sellers[0]?.primaryClaim;
  return buyers.length === 1 && sellers.length === 1 &&
      typeof buyer === "string" && typeof seller === "string"
    ? { buyer, seller }
    : null;
}

/** Validate the current agreement body independently of its signature set. */
function isAgreementScope(v: Record<string, unknown>): boolean {
  const claims = agreementRoleClaims(v);
  if (!claims) return false;
  return isAgreementArtifact({
    ...v,
    signatures: [
      {
        party: claims.buyer,
        algorithm: "ed25519",
        value: PLACEHOLDER_SIGNATURE_VALUE,
      },
      {
        party: claims.seller,
        algorithm: "ed25519",
        value: PLACEHOLDER_SIGNATURE_VALUE,
      },
    ],
  });
}

/** Validate current single-signature records independently of the envelope. */
function isSettlementEvidenceScope(v: Record<string, unknown>): boolean {
  return isSettlementEvidence({ ...v, signature: PLACEHOLDER_SIGNATURE });
}

function isCompositeVerificationRecordScope(
  v: Record<string, unknown>,
): boolean {
  return isCompositeVerificationRecord({
    ...v,
    signature: PLACEHOLDER_SIGNATURE,
  });
}

function isSettlementAmendmentScope(v: Record<string, unknown>): boolean {
  const type = v.amendmentType;
  const amount = v.refundAmount;
  const validAmount = (value: unknown): boolean =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    typeof (value as Record<string, unknown>).amount === "string" &&
    /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/.test(
      (value as Record<string, unknown>).amount as string,
    ) &&
    !/^0(?:\.0*)?$/.test(
      (value as Record<string, unknown>).amount as string,
    ) &&
    typeof (value as Record<string, unknown>).currency === "string" &&
    ((value as Record<string, unknown>).currency as string).length > 0;
  return (
    v.amendmentVersion === "1" &&
    typeof v.jobId === "string" && v.jobId.length > 0 &&
    isAttestationRef(v.amendsEvidenceRef) &&
    (type === "refund" || type === "partial-refund" || type === "correction") &&
    (type === "correction" ? amount === undefined : validAmount(amount)) &&
    (v.refundTxRefs === undefined ||
      (Array.isArray(v.refundTxRefs) && v.refundTxRefs.every(isChainTxRef))) &&
    typeof v.reason === "string" && v.reason.length > 0 &&
    Number.isSafeInteger(v.observedAt) && (v.observedAt as number) >= 0
  );
}

function refVerdictForSignature(
  verdict: Exclude<RefSignatureVerdict, "valid">,
): RefVerdict {
  return `signature-${verdict}` as RefVerdict;
}

function attachSignatureCheck(
  check: RefCheck,
  signature: RefSignatureCheck,
): RefCheck {
  return {
    ...check,
    verdict:
      signature.verdict === "valid"
        ? check.verdict
        : refVerdictForSignature(signature.verdict),
    signature,
  };
}

function componentSignatureCheck(
  result: ComponentSignatureVerification,
): RefSignatureCheck {
  if (result.status === "valid") {
    return { verdict: "valid", signers: [result.signature.signer] };
  }
  if (result.status === "missing") return { verdict: "missing" };
  return { verdict: result.status, reason: result.reason };
}

async function authenticateComponentReference(
  artifact: Record<string, unknown>,
  separator: DomainSeparator,
  authorizedSigners: ReadonlySet<string> | null,
  deps: VerifyBundleDeps,
): Promise<RefSignatureCheck> {
  const result = await verifyComponentSignature(artifact, separator, {
    isSignerAuthorized: (_record, signature) => {
      if (!authorizedSigners) {
        throw new Error("artifact signer authorization could not be resolved");
      }
      return parseCanonicalClaimReference(signature.signer) !== null &&
        [...authorizedSigners].some((claim) =>
          sameCanonicalClaimIdentity(claim, signature.signer)
        );
    },
    resolvePublicKey: async (signature) => {
      const signer = parseCanonicalClaimReference(signature.signer);
      return signature.algorithm === "ed25519" && signer
        ? deps.resolvePublicKey(
            `${signer.identity.scheme}:${signer.identity.identifier}`,
          )
        : null;
    },
    verify: async ({ signedBytes: message, signature, publicKey }) => {
      if (signature.algorithm !== "ed25519" || publicKey.length !== 32) {
        throw new Error("unsupported algorithm or malformed resolved key");
      }
      const decoded = Uint8Array.from(
        Buffer.from(signature.value, "base64url"),
      );
      if (decoded.length !== 64) return false;
      return deps.verify(
        Uint8Array.from(message),
        Uint8Array.from(decoded),
        Uint8Array.from(publicKey),
      );
    },
  });
  const check = componentSignatureCheck(result);
  if (
    check.verdict === "unresolved" &&
    isComponentSignature(artifact.signature) &&
    artifact.signature.algorithm !== "ed25519"
  ) {
    return {
      verdict: "unresolved",
      reason: `unsupported-signature-algorithm:${artifact.signature.algorithm}`,
    };
  }
  return check;
}

function isAgreementSignatureShape(value: unknown): value is AgreementSignature {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const signature = value as Record<string, unknown>;
  if (
    Object.keys(signature).length !== 3 ||
    typeof signature.party !== "string" ||
    signature.party.length === 0 ||
    (signature.algorithm !== "ed25519" &&
      signature.algorithm !== "ecdsa-secp256k1" &&
      signature.algorithm !== "sr1-aggregate") ||
    !isCanonicalBase64Url(signature.value)
  ) {
    return false;
  }
  return (
    signature.algorithm !== "ed25519" ||
    Buffer.from(signature.value, "base64url").length === 64
  );
}

async function authenticateAgreementReference(
  artifact: Record<string, unknown>,
  deps: VerifyBundleDeps,
): Promise<RefSignatureCheck> {
  const scope = stripSignature(artifact) as Record<string, unknown>;
  const claims = agreementRoleClaims(scope);
  if (!claims || !isAgreementScope(scope)) {
    return { verdict: "malformed", reason: "invalid-agreement-scope" };
  }
  if (!Object.prototype.hasOwnProperty.call(artifact, "signatures")) {
    return { verdict: "missing", reason: "agreement-signatures-missing" };
  }
  if (!Array.isArray(artifact.signatures)) {
    return { verdict: "malformed", reason: "agreement-signatures-not-an-array" };
  }
  if (artifact.signatures.length === 0) {
    return { verdict: "missing", reason: "agreement-signatures-empty" };
  }
  if (!artifact.signatures.every(isAgreementSignatureShape)) {
    return { verdict: "malformed", reason: "malformed-agreement-signature" };
  }

  const signatures = artifact.signatures as AgreementSignature[];
  const required = [claims.buyer, claims.seller];
  const seen = new Set<string>();
  const authenticatedSigners: string[] = [];
  for (const signature of signatures) {
    const parsed = parseCanonicalClaimReference(signature.party);
    const identity = parsed
      ? `${parsed.identity.scheme}:${parsed.identity.identifier}`
      : null;
    if (
      !identity ||
      !required.some((claim) =>
        sameCanonicalClaimIdentity(claim, signature.party)
      ) ||
      seen.has(identity)
    ) {
      return { verdict: "invalid", reason: "agreement-signer-not-authorized" };
    }
    seen.add(identity);
    authenticatedSigners.push(signature.party);
  }
  const missing = required.filter((party) => {
    const parsed = parseCanonicalClaimReference(party);
    return parsed === null ||
      !seen.has(`${parsed.identity.scheme}:${parsed.identity.identifier}`);
  });
  if (missing.length > 0) {
    return {
      verdict: "missing",
      reason: `agreement-party-signature-missing:${missing.join(",")}`,
    };
  }

  const separator = Object.prototype.hasOwnProperty.call(
    scope,
    "payeeBoundAgreementVersion",
  )
    ? ARTIFACT_SEPARATORS.PayeeBoundAgreementDocument
    : ARTIFACT_SEPARATORS.AgreementDocument;
  const message = signedBytes(separator, contentHash(scope));
  for (const signature of signatures) {
    if (signature.algorithm !== "ed25519") {
      return {
        verdict: "unresolved",
        reason: `unsupported-agreement-signature-algorithm:${signature.algorithm}`,
      };
    }
    let key: Uint8Array | null;
    try {
      const parsed = parseCanonicalClaimReference(signature.party)!;
      key = await deps.resolvePublicKey(
        `${parsed.identity.scheme}:${parsed.identity.identifier}`,
      );
    } catch {
      return { verdict: "unresolved", reason: "agreement-signer-key-resolution-failed" };
    }
    if (!key || key.length !== 32) {
      return {
        verdict: "unresolved",
        reason: key
          ? "agreement-signer-key-malformed"
          : "agreement-signer-key-not-found",
      };
    }
    try {
      const signatureBytes = Uint8Array.from(
        Buffer.from(signature.value, "base64url"),
      );
      if (
        !(await deps.verify(
          Uint8Array.from(message),
          Uint8Array.from(signatureBytes),
          Uint8Array.from(key),
        ))
      ) {
        return {
          verdict: "invalid",
          reason: "agreement-cryptographic-verification-failed",
        };
      }
    } catch {
      return { verdict: "unresolved", reason: "agreement-signature-verification-error" };
    }
  }
  return { verdict: "valid", signers: authenticatedSigners };
}

function bundlePartySignerClaims(
  bundle: AnyAttestationBundle,
): ReadonlySet<string> | null {
  const claims = bundle.parties.map((party) => party.primaryClaim);
  return claims.length > 0 ? new Set(claims) : null;
}

/** DACS-1 §6.3.4 bundles pin the unsigned normative Listing scope. */
function isNormativeListingScope(v: Record<string, unknown>): boolean {
  const scope = stripSignature(v);
  return isListingDraft(scope);
}

function isAgreementCommitPhase(kind: string): boolean {
  return kind === "commit" || kind.startsWith("commit-");
}

function requiresAgreementRef(bundle: AnyAttestationBundle): boolean {
  return (
    bundle.outcome === "completed" ||
    bundle.phaseSummary.some(
      (phase) => phase.outcome === "ok" && isAgreementCommitPhase(phase.kind),
    ) ||
    bundle.settlementEvidence.length > 0 ||
    (bundle.amendments?.length ?? 0) > 0 ||
    (bundle.ratingRefs?.length ?? 0) > 0
  );
}

const CO_SIGNATURE_REQUIRED_OUTCOMES = new Set([
  "completed",
  "failed-perm",
  "failed-counterparty",
  "failed-substrate",
]);
const ABORT_OUTCOMES = new Set(["aborted-by-self", "aborted-by-other"]);

interface ValidatedBundleParties {
  byRole: Map<"buyer" | "seller" | "orchestrator", string>;
  hasRequiredRoles: boolean;
}

function validatedBundleParties(
  bundle: AnyAttestationBundle,
): ValidatedBundleParties | null {
  const byRole = new Map<"buyer" | "seller" | "orchestrator", string>();
  const seenClaims: string[] = [];
  for (const party of bundle.parties) {
    if (
      party.role !== "buyer" &&
      party.role !== "seller" &&
      party.role !== "orchestrator"
    ) {
      return null;
    }
    if (
      party.primaryClaim.length === 0 ||
      byRole.has(party.role) ||
      seenClaims.some((claim) =>
        sameCanonicalClaimIdentity(claim, party.primaryClaim) ||
        claim === party.primaryClaim
      )
    ) {
      return null;
    }
    byRole.set(party.role, party.primaryClaim);
    seenClaims.push(party.primaryClaim);
  }
  return {
    byRole,
    hasRequiredRoles: byRole.has("buyer") && byRole.has("seller"),
  };
}

function agreementClaim(agreement: Record<string, unknown> | null, role: "buyer" | "seller"): string | undefined {
  if (!agreement || !isAgreementArtifact(agreement)) return undefined;
  return agreement.parties.find((party) => party.role === role)?.primaryClaim;
}

/**
 * Hash resolution alone cannot let an agreement redefine the enclosing
 * session. This is structural coherence only; cryptographic verification of
 * AgreementSignature[] remains a separate required closure step.
 */
function agreementIsCoherentWithBundle(
  agreement: Record<string, unknown>,
  bundle: AnyAttestationBundle,
): boolean {
  const bundleParty = (role: "buyer" | "seller") =>
    bundle.parties.filter((party) => party.role === role);
  const bundleBuyers = bundleParty("buyer");
  const bundleSellers = bundleParty("seller");
  if (bundleBuyers.length !== 1 || bundleSellers.length > 1) return false;

  if (isAgreementArtifact(agreement)) {
    const agreementBuyers = agreement.parties.filter(
      (party) => party.role === "buyer",
    );
    const agreementSellers = agreement.parties.filter(
      (party) => party.role === "seller",
    );
    return (
      agreement.jobId === bundle.jobId &&
      agreementBuyers.length === 1 &&
      agreementSellers.length === 1 &&
      bundleSellers.length === 1 &&
      sameCanonicalClaimIdentity(
        agreementBuyers[0]!.primaryClaim,
        bundleBuyers[0]!.primaryClaim,
      ) &&
      agreementBuyers[0]!.bundleHash === bundleBuyers[0]!.bundleHash &&
      sameCanonicalClaimIdentity(
        agreementSellers[0]!.primaryClaim,
        bundleSellers[0]!.primaryClaim,
      ) &&
      agreementSellers[0]!.bundleHash === bundleSellers[0]!.bundleHash
    );
  }
  return false;
}

function requiredSignatureClaims(
  bundle: AnyAttestationBundle,
  agreement: Record<string, unknown> | null,
  parties: ValidatedBundleParties | null,
  signatureCount: number,
): string[] {
  if (!parties) {
    if (!CO_SIGNATURE_REQUIRED_OUTCOMES.has(bundle.outcome)) return [];
    const buyer = bundle.parties.find((party) => party.role === "buyer")
      ?.primaryClaim;
    const seller = bundle.parties.find((party) => party.role === "seller")
      ?.primaryClaim;
    const claims = [
      agreementClaim(agreement, "buyer") ?? buyer ?? "role:buyer",
      agreementClaim(agreement, "seller") ?? seller ?? "role:seller",
    ];
    const orchestrator = bundle.parties.find(
      (party) => party.role === "orchestrator",
    )?.primaryClaim;
    if (orchestrator && !sameCanonicalClaimIdentity(orchestrator, buyer) &&
        !sameCanonicalClaimIdentity(orchestrator, seller)) {
      claims.push(orchestrator);
    }
    return claims.filter((claim, index) => claims.findIndex((candidate) =>
      sameCanonicalClaimIdentity(candidate, claim)) === index);
  }

  const anchorClaim = bundle.anchoredByRole
    ? parties.byRole.get(bundle.anchoredByRole)
    : undefined;
  if (
    !CO_SIGNATURE_REQUIRED_OUTCOMES.has(bundle.outcome) &&
    signatureCount === 1
  ) {
    return anchorClaim ? [anchorClaim] : ["role:anchoring-party"];
  }
  const buyer = parties.byRole.get("buyer");
  const seller = parties.byRole.get("seller");
  const claims = [
    agreementClaim(agreement, "buyer") ?? buyer ?? "role:buyer",
    agreementClaim(agreement, "seller") ?? seller ?? "role:seller",
  ];
  const orchestrator = parties.byRole.get("orchestrator");
  if (
    orchestrator &&
    !sameCanonicalClaimIdentity(orchestrator, buyer) &&
    !sameCanonicalClaimIdentity(orchestrator, seller)
  ) {
    claims.push(orchestrator);
  }
  if (anchorClaim) claims.push(anchorClaim);
  return claims.filter(
    (claim, index) =>
      claims.findIndex((candidate) =>
        sameCanonicalClaimIdentity(candidate, claim)
      ) === index,
  );
}

function bundleClaimReferencesAreCanonical(
  bundle: Readonly<AnyAttestationBundle>,
): boolean {
  const parties: unknown = bundle.parties;
  const signatures: unknown = bundle.signatures;
  if (!Array.isArray(parties) || parties.some((party) =>
    party === null || typeof party !== "object" ||
    typeof (party as { primaryClaim?: unknown }).primaryClaim !== "string"
  ) || (signatures !== undefined &&
    (!Array.isArray(signatures) || signatures.some((signature) =>
      signature === null || typeof signature !== "object" ||
      typeof (signature as { party?: unknown }).party !== "string"
    )))) return false;
  const references = [
    ...parties.map(
      (party) => (party as { primaryClaim: string }).primaryClaim,
    ),
    ...(signatures ?? []).map(
      (signature) => (signature as { party: string }).party,
    ),
    ...[
      bundle.agreementRef,
      ...bundle.settlementEvidence,
      ...bundle.vetRecords,
      ...bundle.phaseSummary.map((phase) => phase.attestationRef),
      ...(bundle.amendments ?? []),
      ...(bundle.ratingRefs ?? []),
    ].flatMap((ref) =>
      ref && isAttestationRef(ref) && ref.signer !== undefined
        ? [ref.signer]
        : []
    ),
  ];
  return references.every(
    (reference) => parseCanonicalClaimReference(reference) !== null,
  );
}

export async function verifyBundleCore(
  bundleRef: string,
  callerDeps: VerifyBundleDeps,
): Promise<BundleVerification> {
  const deps = captureVerifyBundleDeps(callerDeps);
  const raw = snapshotDependencyRecord(
    await deps.readArtifact(bundleRef),
    "resolved attestation bundle",
  );
  if (raw && isAbsoluteFaultBundle(raw) && !faultedPartyIsPermitted(raw)) {
    return {
      ok: false,
      reason: "faultedParty is not permitted for outcome and anchoredByRole",
      fullyVerified: false,
      signatures: [],
      refs: [],
    };
  }
  const isCurrentBundle = raw !== null && isAnyAttestationBundle(raw);
  if (!raw || !isCurrentBundle) {
    return {
      ok: false,
      reason: "not an attestation bundle",
      fullyVerified: false,
      signatures: [],
      refs: [],
    };
  }
  const bundle = raw as AnyAttestationBundle;
  if (isEvidenceBoundFaultBundle(bundle as unknown as Record<string, unknown>)) {
    if (!deps.verifyEvidenceBound) {
      return {
        ok: false,
        reason: "EvidenceBoundFaultAttestationBundle requires SEB-1..SEB-6 authority verification",
        fullyVerified: false,
        signatures: [],
        refs: [],
        bundle: structuredClone(bundle),
      };
    }
    let exactSet: EvidenceBoundBundleVerification | null = null;
    try {
      const rawVerdict = await deps.verifyEvidenceBound(
        structuredClone(bundle) as unknown as Record<string, unknown>,
      );
      const captured = snapshotDependencyRecord(rawVerdict, "EBFAB verification verdict");
      if (
        captured &&
        ["verified", "rejected", "indeterminate"].includes(captured.decision as string) &&
        typeof captured.reasonCode === "string" &&
        typeof captured.reason === "string"
      ) exactSet = captured as unknown as EvidenceBoundBundleVerification;
    } catch {
      // Remains fail closed below.
    }
    if (exactSet?.decision !== "verified") {
      return {
        ok: false,
        reason: exactSet
          ? `EBFAB exact-set verification ${exactSet.decision}: ${exactSet.reason}`
          : "EBFAB exact-set verifier failed",
        fullyVerified: false,
        signatures: [],
        refs: [],
        bundle: structuredClone(bundle),
      };
    }
  }
  const canonicalBundleClaims = bundleClaimReferencesAreCanonical(bundle);
  const parties = validatedBundleParties(bundle);
  if (canonicalBundleClaims && !parties) {
    return {
      ok: false,
      reason:
        "bundle parties contain an unsupported or duplicate role or a non-distinct party claim",
      fullyVerified: false,
      signatures: [],
      refs: [],
      bundle: structuredClone(bundle),
    };
  }
  if (
    parties &&
    (!bundle.anchoredByRole || !parties.byRole.has(bundle.anchoredByRole))
  ) {
    return {
      ok: false,
      reason: "anchoredByRole must identify a validated bundle party role",
      fullyVerified: false,
      signatures: [],
      refs: [],
      bundle: structuredClone(bundle),
    };
  }
  if (!CO_SIGNATURE_REQUIRED_OUTCOMES.has(bundle.outcome) && !ABORT_OUTCOMES.has(bundle.outcome)) {
    return {
      ok: false,
      reason: `unsupported DACS-5 bundle outcome: ${bundle.outcome}`,
      fullyVerified: false,
      signatures: [],
      refs: [],
      bundle: structuredClone(bundle),
    };
  }
  // Signed scope = canonical form omitting signatures + anchoredByRole (§10.4.1).
  const scope: Record<string, unknown> = { ...raw };
  delete scope["signatures"];
  delete scope["anchoredByRole"];
  const message = signedBytes(
    isEvidenceBoundFaultBundle(bundle as unknown as Record<string, unknown>)
      ? ARTIFACT_SEPARATORS.EvidenceBoundFaultAttestationBundle
      : isFaultBundle(bundle as unknown as Record<string, unknown>)
        ? ARTIFACT_SEPARATORS.FaultAttestationBundle
        : ARTIFACT_SEPARATORS.AttestationBundle,
    contentHash(scope),
  );

  const sigs = Array.isArray(raw["signatures"])
    ? (raw["signatures"] as Array<{
        party?: unknown;
        algorithm?: unknown;
        value?: unknown;
      }>)
    : [];

  const signatures: SignatureCheck[] = [];
  const seenSignatureClaims = new Set<string>();
  for (const s of sigs) {
    const party = typeof s.party === "string" ? s.party : "";
    const parsedParty = parseCanonicalClaimReference(party);
    const canonicalParty = parsedParty !== null;
    const canonicalPartyIdentity = parsedParty
      ? `${parsedParty.identity.scheme}:${parsedParty.identity.identifier}`
      : null;
    const authorizedParty = parsedParty !== null && bundle.parties.some(
      (candidate) =>
        sameCanonicalClaimIdentity(candidate.primaryClaim, party),
    );
    const encodedSignature = typeof s.value === "string" ? s.value : "";
    const signatureBytes = isCanonicalBase64Url(encodedSignature)
      ? Uint8Array.from(Buffer.from(encodedSignature, "base64url"))
      : null;
    let verdict: SignatureVerdict;
    if (!canonicalParty) {
      verdict = "unverified";
    } else if (
      !authorizedParty ||
      s.algorithm !== "ed25519" ||
      signatureBytes === null ||
      signatureBytes.length !== 64 ||
      seenSignatureClaims.has(canonicalPartyIdentity!)
    ) {
      // §10.4.1 / CORE §B.7: every carried signature must name a session
      // party, dispatch by its declared algorithm, and use exact SIG-6 bytes.
      // Unsupported algorithms are never reinterpreted as Ed25519.
      verdict = "invalid";
    } else {
      seenSignatureClaims.add(canonicalPartyIdentity!);
      // Resolve once. The branch above deliberately avoids exposing an
      // unauthorized or algorithm-confused signature to caller callbacks.
      const resolvedKey = await deps.resolvePublicKey(canonicalPartyIdentity!);
      if (!resolvedKey) {
        verdict = "unverified";
      } else if (
        !(resolvedKey instanceof Uint8Array) ||
        resolvedKey.length !== 32
      ) {
        // Malformed resolved key — can't evaluate; ERROR, not a false FAIL.
        verdict = "error";
      } else {
        const verified = await deps.verify(
          Uint8Array.from(message),
          Uint8Array.from(signatureBytes),
          Uint8Array.from(resolvedKey),
        );
        verdict = verified === true ? "valid" : "invalid";
      }
    }
    signatures.push({ party, verdict });
  }

  // ── Referenced-artifact integrity ──────────────────────────────────────────
  const refs: RefCheck[] = [];
  let agreementArtifact: Record<string, unknown> | null = null;
  let agreementReferenceVerified = false;
  let prefetchedNormativeListing: Record<string, unknown> | null | undefined;
  if (!bundle.agreementRef && requiresAgreementRef(bundle)) {
    refs.push({ kind: "dacs-3-agreement", id: "agreementRef", verdict: "missing" });
  }
  const refLocator = (ref: AttestationRef): string => ref.anchor.locator;
  const resolveReadableRef = async (
    ref: AttestationRef,
  ): Promise<{
    supported: boolean;
    value: Record<string, unknown> | null;
    rejected?: RefVerdict;
  }> => {
    if (!deps.resolveAttestationRef) return { supported: false, value: null };
    let resolved: Record<string, unknown> | null;
    try {
      resolved = await deps.resolveAttestationRef(
        structuredClone(ref),
        bundle.jobId,
        structuredClone(bundle.parties),
        // Checked against the supported outcome sets above.
        bundle.outcome as AnyAttestationBundle["outcome"],
      );
    } catch (error) {
      if (!(error instanceof AttestationRefRejection)) throw error;
      return {
        supported: true,
        value: null,
        rejected: ATTESTATION_REF_REJECTION_VERDICT[error.disposition],
      };
    }
    return {
      supported: true,
      value: snapshotDependencyRecord(
        resolved,
        `resolved artifact ${ref.anchor.locator}`,
      ),
    };
  };
  const checkReadableRef = async (
    artifactKind: string,
    ref: AttestationRef,
    validateScope: (value: Record<string, unknown>) => boolean,
    authenticate?: (
      value: Record<string, unknown>,
    ) => Promise<RefSignatureCheck>,
  ): Promise<{ check: RefCheck; value: Record<string, unknown> | null }> => {
    const resolved = await resolveReadableRef(ref);
    if (!resolved.supported) {
      return {
        check: {
          kind: artifactKind,
          id: refLocator(ref),
          verdict: "unresolved",
        },
        value: null,
      };
    }
    if (resolved.rejected !== undefined) {
      return {
        check: { kind: artifactKind, id: refLocator(ref), verdict: resolved.rejected },
        value: null,
      };
    }
    let value: Record<string, unknown> | null = null;
    if (resolved.value !== null) {
      try {
        value = snapshotCanonicalJsonRead(
          resolved.value,
          `${artifactKind} artifact read`,
        );
      } catch {
        return {
          check: {
            kind: artifactKind,
            id: refLocator(ref),
            verdict: "invalid-shape",
          },
          value: null,
        };
      }
    }
    const check = checkArtifact(
      artifactKind,
      refLocator(ref),
      ref.contentHash,
      validateScope,
      value,
    );
    return {
      check:
        check.verdict === "ok" && value && authenticate
          ? attachSignatureCheck(check, await authenticate(value))
          : check,
      value,
    };
  };

  if (bundle.agreementRef) {
    const agreement = await checkReadableRef(
      "dacs-3-agreement",
      bundle.agreementRef,
      isAgreementScope,
      (artifact) => authenticateAgreementReference(artifact, deps),
    );
    if (
      agreement.check.verdict === "ok" &&
      agreement.value &&
      !agreementIsCoherentWithBundle(agreement.value, bundle)
    ) {
      agreement.check.verdict = "incoherent";
    }
    refs.push(agreement.check);
    agreementReferenceVerified = agreement.check.verdict === "ok";
    agreementArtifact =
      agreement.value &&
      ![
        "missing",
        "invalid-shape",
        "hash-mismatch",
        "unresolved",
      ].includes(agreement.check.verdict)
        ? agreement.value
        : null;
  }

  // APR-7 runs before any SettlementEvidence callback. Resolve and authenticate
  // the signed Listing now, then require the SDK-composed projection verifier
  // whenever that exact Listing contains the listing-only placeholder.
  if (deps.resolveListingRef) {
    prefetchedNormativeListing = snapshotDependencyRecord(
      await deps.resolveListingRef(
        structuredClone(bundle.listingRef),
        structuredClone(bundle.parties),
      ),
      `resolved Listing ${bundle.listingRef.listingId}`,
    );
    let earlyListingCheck = checkArtifact(
      "dacs-1-listing",
      String(bundle.listingRef.listingId),
      bundle.listingRef.contentHash,
      isNormativeListingScope,
      prefetchedNormativeListing,
    );
    if (earlyListingCheck.verdict === "ok" && prefetchedNormativeListing) {
      const scope = stripSignature(prefetchedNormativeListing) as Record<
        string,
        unknown
      >;
      const publisher = isListingDraft(scope)
        ? scope.seller.identity.presentedBy
        : null;
      earlyListingCheck = attachSignatureCheck(
        earlyListingCheck,
        await authenticateComponentReference(
          prefetchedNormativeListing,
          ARTIFACT_SEPARATORS.Listing,
          publisher ? new Set([publisher]) : null,
          deps,
        ),
      );
      const containsAlternative =
        earlyListingCheck.verdict === "ok" &&
        isListingDraft(scope) &&
        scope.pipeline.some((phase) => phase.kind === "pay-alternative");
      if (containsAlternative) {
        let aprDecision: AlternativePaymentBundleVerificationResult = {
          decision: "indeterminate",
          reason: "alternative-payment projection verifier unavailable",
        };
        if (
          agreementReferenceVerified &&
          agreementArtifact &&
          deps.verifyAlternativePaymentProjection
        ) {
          try {
            const rawDecision = await deps.verifyAlternativePaymentProjection(
              deepFreeze({
                bundle: structuredClone(bundle as AnyAttestationBundle),
                listing: structuredClone(prefetchedNormativeListing),
                agreement: structuredClone(agreementArtifact),
              }),
            );
            const capturedDecision = snapshotCanonicalJsonRead(
              rawDecision,
              "alternative-payment bundle verification result",
            );
            if (
              isRecord(capturedDecision) &&
              ["pass", "fail", "error", "indeterminate"].includes(
                capturedDecision.decision as string,
              ) &&
              (capturedDecision.reason === undefined ||
                typeof capturedDecision.reason === "string")
            ) {
              aprDecision = capturedDecision as AlternativePaymentBundleVerificationResult;
            }
          } catch {
            // Keep the indeterminate default. Evidence callbacks remain inert.
          }
        }
        if (aprDecision.decision !== "pass") {
          return {
            ok: false,
            reason:
              aprDecision.reason ??
              `alternative-payment projection ${aprDecision.decision}`,
            fullyVerified: false,
            signatures,
            refs: [
              ...refs,
              {
                kind: "dacs-4-alternative-projection",
                id: bundle.jobId,
                verdict:
                  aprDecision.decision === "fail"
                    ? "invalid-binding"
                    : "unresolved",
              },
            ],
            bundle: structuredClone(bundle),
          };
        }
      }
    }
  }
  for (const ev of bundle.settlementEvidence) {
    const evidence = await checkReadableRef(
      "dacs-4-evidence",
      ev,
      isSettlementEvidenceScope,
    );
    if (
      evidence.check.verdict === "ok" &&
      evidence.value &&
      (stripSignature(evidence.value) as { jobId?: unknown }).jobId !==
        bundle.jobId
    ) {
      evidence.check.verdict = "invalid-binding";
    }
    if (evidence.check.verdict === "ok" && evidence.value) {
      let decision: unknown;
      let authorizedSigner: string | null = null;
      try {
        const callbackVerdict = deps.verifyEvidence
          ? await deps.verifyEvidence(
              structuredClone(evidence.value),
              {
                bundle: structuredClone(bundle),
                evidenceRef: structuredClone(ev),
                agreement:
                  agreementArtifact === null
                    ? null
                    : structuredClone(agreementArtifact),
              },
            )
          : null;
        const verdict = snapshotCanonicalJson(
          callbackVerdict,
          "SettlementEvidence verification verdict",
        ) as { decision?: unknown; authorizedSigner?: unknown } | null;
        if (verdict) {
          decision = verdict.decision;
          authorizedSigner =
            typeof verdict.authorizedSigner === "string" &&
            verdict.authorizedSigner.length > 0
              ? verdict.authorizedSigner
              : null;
        }
      } catch {
        decision = undefined;
      }
      evidence.check = attachSignatureCheck(
        evidence.check,
        await authenticateComponentReference(
          evidence.value,
          ARTIFACT_SEPARATORS.SettlementEvidence,
          authorizedSigner === null ? null : new Set([authorizedSigner]),
          deps,
        ),
      );
      if (evidence.check.verdict === "ok" && decision !== "pass") {
        evidence.check.verdict = "invalid-evidence";
      }
    }
    refs.push(evidence.check);
  }
  for (const vr of bundle.vetRecords) {
    const composite = await checkReadableRef(
      "dacs-2-composite",
      vr,
      isCompositeVerificationRecordScope,
    );
    if (composite.check.verdict === "ok" && composite.value) {
      if (!deps.verifyCompositeRecord) {
        composite.check.verdict = "invalid-vet-record";
      } else {
        try {
          const candidate =
            composite.value as unknown as CompositeVerificationRecord;
          const boundParty = bundle.parties.find(
            (party) =>
              sameCanonicalClaimIdentity(
                party.primaryClaim,
                candidate.evaluatedParty,
              ) &&
              party.bundleHash === candidate.bundleHash,
          );
          if (candidate.jobId !== bundle.jobId || !boundParty) {
            composite.check.verdict = "invalid-vet-record";
          } else {
            const verification = await deps.verifyCompositeRecord(
              candidate,
              bundle,
            );
            if (
              verification.status !== "valid" ||
            (bundle.outcome === "completed" &&
              verification.record.overallDecision !== "pass") ||
            contentHash(
              verification.record as unknown as Record<string, unknown>,
            ) !== contentHash(candidate as unknown as Record<string, unknown>) ||
            verification.record.signature.algorithm !== candidate.signature.algorithm ||
            verification.record.signature.signer !== candidate.signature.signer ||
            verification.record.signature.value !== candidate.signature.value
            ) {
              composite.check.verdict = "invalid-vet-record";
            } else {
              composite.check = attachSignatureCheck(composite.check, {
                verdict: "valid",
                signers: [candidate.signature.signer],
              });
            }
          }
        } catch {
          composite.check.verdict = "invalid-vet-record";
        }
      }
    }
    refs.push(composite.check);
  }
  for (const amendment of bundle.amendments ?? []) {
    refs.push(
      (
        await checkReadableRef(
          "dacs-4-amendment",
          amendment,
          isSettlementAmendmentScope,
          (artifact) =>
            authenticateComponentReference(
              artifact,
              "dacs-amendment:v1:",
              bundlePartySignerClaims(bundle),
              deps,
            ),
        )
      ).check,
    );
  }
  for (const rating of bundle.ratingRefs ?? []) {
    const checked = await checkReadableRef(
      "dacs-5-rating",
      rating,
      isRatingRecordSignedScope,
      (artifact) => {
        const scope = stripSignature(artifact) as Record<string, unknown>;
        const signers =
          typeof scope.rater === "string" ? new Set([scope.rater]) : null;
        return authenticateComponentReference(
          artifact,
          RATING_SEPARATOR,
          signers,
          deps,
        );
      },
    );
    if (checked.check.verdict === "ok" && checked.value) {
      const scope = stripSignature(checked.value) as Record<string, unknown>;
      const rater = bundle.parties.find(
        (party) => sameCanonicalClaimIdentity(party.primaryClaim, scope.rater),
      );
      const target = bundle.parties.find(
        (party) => sameCanonicalClaimIdentity(party.primaryClaim, scope.target),
      );
      if (
        scope.jobId !== bundle.jobId ||
        !rater ||
        !target ||
        sameCanonicalClaimIdentity(rater.primaryClaim, target.primaryClaim) ||
        target.role !== scope.targetRole ||
        (target.role !== "buyer" && target.role !== "seller")
      ) {
        checked.check.verdict = "invalid-binding";
      }
    }
    refs.push(checked.check);
  }

  // A bundle always resolves its exact signed ListingPin through the LR-1
  // resolver, including a pre-commit abort with no Agreement.
  const listingId = String(bundle.listingRef.listingId);
  const agreementListingPin =
    agreementArtifact && isAgreementArtifact(agreementArtifact)
      ? agreementArtifact.listingRef
      : null;
  const listingPinCoherent =
    !agreementListingPin ||
    (agreementListingPin.listingId === bundle.listingRef.listingId &&
      agreementListingPin.version === bundle.listingRef.version &&
      agreementListingPin.contentHash === bundle.listingRef.contentHash);
  let listing: Record<string, unknown> | null = null;
  if (listingPinCoherent && deps.resolveListingRef) {
    listing =
      prefetchedNormativeListing !== undefined
        ? prefetchedNormativeListing
        : snapshotDependencyRecord(
            await deps.resolveListingRef(
              structuredClone(bundle.listingRef),
              structuredClone(bundle.parties),
            ),
            `resolved Listing ${bundle.listingRef.listingId}`,
          );
  }
  let listingCheck: RefCheck;
  if (!listingPinCoherent) {
    listingCheck = {
      kind: "dacs-1-listing",
      id: listingId,
      verdict: "hash-mismatch",
    };
  } else if (!deps.resolveListingRef) {
    listingCheck = {
      kind: "dacs-1-listing",
      id: listingId,
      verdict: "unresolved",
    };
  } else {
    listingCheck = checkArtifact(
      "dacs-1-listing",
      listingId,
      bundle.listingRef.contentHash,
      isNormativeListingScope,
      listing,
    );
    if (listingCheck.verdict === "ok" && listing) {
      const listingScope = stripSignature(listing) as {
        listingId?: unknown;
        seller?: { identity?: { presentedBy?: unknown } };
      };
      const sellerClaim = bundle.parties.find(
        (party) => party.role === "seller",
      )?.primaryClaim;
      if (
        listingScope.listingId !== listingId ||
        (sellerClaim !== undefined &&
          !sameCanonicalClaimIdentity(
            listingScope.seller?.identity?.presentedBy,
            sellerClaim,
          ))
      ) {
        listingCheck.verdict = "invalid-binding";
      }
    }
    if (listingCheck.verdict === "ok" && listing) {
      const listingScope = stripSignature(listing) as Record<string, unknown>;
      const publisher = isListingDraft(listingScope)
        ? listingScope.seller.identity.presentedBy
        : null;
      listingCheck = attachSignatureCheck(
        listingCheck,
        await authenticateComponentReference(
          listing,
          ARTIFACT_SEPARATORS.Listing,
          publisher ? new Set([publisher]) : null,
          deps,
        ),
      );
    }
  }
  refs.push(listingCheck);

  const anyInvalid = signatures.some((c) => c.verdict === "invalid");
  const anyError = signatures.some((c) => c.verdict === "error");
  const anyValid = signatures.some((c) => c.verdict === "valid");
  const validSignatureClaims = signatures
    .filter((c) => c.verdict === "valid")
    .map((c) => c.party);
  const missingRequiredSignatures = requiredSignatureClaims(
    bundle,
    agreementArtifact,
    parties,
    signatures.length,
  ).filter((claim) =>
    !validSignatureClaims.some((candidate) =>
      sameCanonicalClaimIdentity(candidate, claim)
    )
  );
  const sigOk = canonicalBundleClaims && anyValid && !anyInvalid && !anyError;
  const fullyVerified =
    canonicalBundleClaims &&
    signatures.length > 0 &&
    signatures.every((c) => c.verdict === "valid") &&
    missingRequiredSignatures.length === 0 &&
    (!parties || parties.hasRequiredRoles);
  const badRef = refs.find((r) => r.verdict !== "ok");
  const refsOk = !badRef;

  return {
    ok:
      sigOk &&
      missingRequiredSignatures.length === 0 &&
      (!parties || parties.hasRequiredRoles) &&
      refsOk,
    reason:
      signatures.length === 0
        ? "bundle has no signatures"
        : !canonicalBundleClaims
          ? "bundle contains a non-canonical ClaimReference"
        : anyInvalid
          ? "one or more signatures failed verification"
          : anyError
            ? "one or more signer keys were malformed (could not verify)"
            : missingRequiredSignatures.length > 0
              ? `missing required signature(s): ${missingRequiredSignatures.join(", ")}`
              : parties && !parties.hasRequiredRoles
                ? "bundle parties must identify both buyer and seller roles"
                : !anyValid
                  ? "no signer key could be resolved"
                  : badRef
                    ? `referenced artifact ${badRef.kind}/${badRef.id} ${badRef.verdict}`
                    : undefined,
    fullyVerified,
    bundle: structuredClone(bundle),
    signatures,
    refs,
  };
}
