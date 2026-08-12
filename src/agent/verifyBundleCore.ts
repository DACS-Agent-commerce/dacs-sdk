import { contentHash, stripSignature } from "../canonical/index.js";
import { snapshotCanonicalJsonRead } from "../canonical/snapshot.js";
import { signedBytes } from "../crypto/index.js";
import { DacsError } from "../errors.js";
import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import type {
  AnyAttestationBundle,
  AttestationRef,
  BundleParty,
  ListingPin,
} from "../artifacts/types.js";
import {
  type LegacyMvpAnyAttestationBundle,
  type LegacyMvpAttestationRef,
  isLegacyMvpAnyAttestationBundle,
  isLegacyMvpAgreementDocument,
  isLegacyMvpAttestationRef,
  isLegacyMvpSettlementEvidence,
} from "../artifacts/legacyMvp.js";
import {
  isAgreementArtifact,
  isAnyAttestationBundle,
  isAttestationRef,
  isCompositeVerificationRecord,
  isLegacyMvpListing,
  isListingDraft,
  isSettlementEvidence,
} from "../artifacts/validators.js";
import { type Verifier } from "./signedArtifact.js";
import { faultedPartyIsPermitted, isFaultBundle } from "./bundleSemantics.js";

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
 *  2. Referenced-artifact integrity — the bundle's refs (optional agreementRef,
 *     settlementEvidence[], vetRecords[], listingRef) are content-addressed.
 *     Normative session refs use DACS-2 §7.5.2
 *     `{anchor:{kind,locator},contentHash,signer?}`; the pre-#308 `{kind,id,...}`
 *     record is accepted only by the explicit legacy-MVP read path. A valid
 *     bundle signature only binds those *hashes*; it does NOT prove the referenced
 *     artifacts exist or are untampered. We therefore dereference each normative
 *     ref through `resolveAttestationRef`, validate the artifact, and confirm its
 *     signed-scope content hash. Without the appropriate resolver, refs report
 *     `unresolved` and the bundle is NOT ok.
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
  | "hash-mismatch"
  /** Hash and shape match, but the agreement disagrees with its bundle. */
  | "incoherent"
  | "unresolved"
  /** Hash-matched, but the artifact failed its own DACS-4/§9.7 semantic verification. */
  | "invalid-evidence";

export interface RefCheck {
  kind: string;
  id: string;
  verdict: RefVerdict;
}

export interface BundleVerification {
  /** Signature(s) verified AND every referenced artifact resolved + hash-matched. */
  ok: boolean;
  reason?: string;
  /** Every signature verified against a resolved key. */
  fullyVerified: boolean;
  bundle?: AnyAttestationBundle | LegacyMvpAnyAttestationBundle;
  signatures: SignatureCheck[];
  /** Per-referenced-artifact integrity results. */
  refs: RefCheck[];
}

type ReadableAttestationBundle =
  | AnyAttestationBundle
  | LegacyMvpAnyAttestationBundle;
type ReadableAttestationRef = AttestationRef | LegacyMvpAttestationRef;

export interface VerifyBundleDeps {
  /** Read a signed artifact at a storage ref (null if absent). */
  readArtifact: (ref: string) => Promise<Record<string, unknown> | null>;
  /**
   * Resolve a referenced session artifact to its stored signed form, by ref kind
   * + the bundle's jobId. Session artifacts are anchored BY A SESSION PARTY (the
   * buyer orchestrates and anchors in this SDK), so name resolution must be
   * owner-bound to THAT party — not to whoever happens to be verifying (#70):
   * a third-party verifier resolving under its own address finds nothing, and
   * owner-binding to the wrong party would let a name-squatter serve forged
   * artifacts. `parties` is the bundle's party list; derive the anchoring
   * party's substrate address from its primaryClaim. Returns null if
   * unresolvable. Omit only if dereferencing isn't possible — the refs then
   * report `unresolved` and the bundle cannot be `ok`.
   */
  resolveAttestationRef?: (
    ref: Readonly<AttestationRef>,
    jobId: string,
    parties: readonly BundleParty[],
  ) => Promise<Record<string, unknown> | null>;
  /** Resolve the exact DACS-1 LR-1 Listing tuple carried by a normative bundle. */
  resolveListingRef?: (
    listingRef: Readonly<ListingPin>,
    parties: readonly BundleParty[],
  ) => Promise<Record<string, unknown> | null>;
  /**
   * @deprecated Pre-#308 MVP resolver keyed by SDK-only artifact kind. It is
   * retained solely for explicit legacy reads and the pre-commit listing
   * fallback; normative AttestationRef resolution uses `resolveAttestationRef`
   * and MUST follow `ref.anchor` (DACS-2 §7.5.2).
   */
  resolveRef?: (
    kind: string,
    jobId: string,
    parties: readonly BundleParty[],
  ) => Promise<Record<string, unknown> | null>;
  /** Resolve a signer DID/claim to its ed25519 public key (null if unknown). */
  resolvePublicKey: (did: string) => Promise<Uint8Array | null>;
  /** Verify a signature over raw bytes for a public key. */
  verify: Verifier;
  /**
   * OPTIONAL semantic check of a hash-matched SettlementEvidence artifact
   * (DACS-4 §9.7) — wire `verifySettlementEvidence` (with the caller's
   * agreement/rail/orchestrator context) here. When supplied, a settlement ref
   * that hash-matches but whose evidence does NOT verify is
   * downgraded to `invalid-evidence` and the bundle is not `ok`. Omitted by
   * default — hash + shape integrity only, unchanged behaviour.
   */
  verifyEvidence?: (
    evidence: Record<string, unknown>,
  ) => Promise<{ decision: "pass" | "fail" | "error" | "indeterminate" }>;
}

function bindMethod<T>(candidate: T, owner: object): T {
  return Function.prototype.bind.call(candidate as Function, owner) as T;
}

/** Capture every callback once before the first external await. */
function captureVerifyBundleDeps(deps: VerifyBundleDeps): VerifyBundleDeps {
  const readArtifact = deps.readArtifact;
  const resolveAttestationRef = deps.resolveAttestationRef;
  const resolveListingRef = deps.resolveListingRef;
  const resolveRef = deps.resolveRef;
  const resolvePublicKey = deps.resolvePublicKey;
  const verify = deps.verify;
  const verifyEvidence = deps.verifyEvidence;

  if (typeof readArtifact !== "function") {
    throw new DacsError("verifyBundle readArtifact dependency must be a function");
  }
  if (typeof resolvePublicKey !== "function") {
    throw new DacsError("verifyBundle resolvePublicKey dependency must be a function");
  }
  if (typeof verify !== "function") {
    throw new DacsError("verifyBundle verify dependency must be a function");
  }
  for (const [label, candidate] of [
    ["resolveAttestationRef", resolveAttestationRef],
    ["resolveListingRef", resolveListingRef],
    ["resolveRef", resolveRef],
    ["verifyEvidence", verifyEvidence],
  ] as const) {
    if (candidate !== undefined && typeof candidate !== "function") {
      throw new DacsError(`verifyBundle ${label} dependency must be a function`);
    }
  }

  return {
    readArtifact: bindMethod(readArtifact, deps),
    resolvePublicKey: bindMethod(resolvePublicKey, deps),
    verify: bindMethod(verify, deps),
    ...(resolveAttestationRef === undefined
      ? {}
      : {
          resolveAttestationRef: bindMethod(resolveAttestationRef, deps),
        }),
    ...(resolveListingRef === undefined
      ? {}
      : { resolveListingRef: bindMethod(resolveListingRef, deps) }),
    ...(resolveRef === undefined
      ? {}
      : { resolveRef: bindMethod(resolveRef, deps) }),
    ...(verifyEvidence === undefined
      ? {}
      : { verifyEvidence: bindMethod(verifyEvidence, deps) }),
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

/** Hash-check one resolved artifact against the ref that points at it. */
function checkArtifact(
  kind: string,
  id: string,
  expectedHash: string,
  validate: (v: Record<string, unknown>) => boolean,
  resolved: Record<string, unknown> | null,
): RefCheck {
  if (!resolved) return { kind, id, verdict: "missing" };
  const scope = stripSignature(resolved);
  if (!validate(resolved)) return { kind, id, verdict: "invalid-shape" };
  if (contentHash(scope) !== expectedHash)
    return { kind, id, verdict: "hash-mismatch" };
  return { kind, id, verdict: "ok" };
}

function isAnyRecord(v: Record<string, unknown>): boolean {
  return typeof v === "object" && v !== null;
}

/**
 * Bundle refs hash and validate the unsigned Listing scope. DACS-1 §6.3.4
 * Listings therefore use `isListingDraft` here, while historical SDK bundles
 * remain readable only through the explicit MVP compatibility validator.
 */
function isReadableListingScope(v: Record<string, unknown>): boolean {
  const scope = stripSignature(v);
  return isListingDraft(scope) || isLegacyMvpListing(scope);
}

function isAgreementCommitPhase(kind: string): boolean {
  return kind === "commit" || kind.startsWith("commit-");
}

function requiresAgreementRef(bundle: ReadableAttestationBundle): boolean {
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

function agreementClaim(agreement: Record<string, unknown> | null, role: "buyer" | "seller"): string | undefined {
  if (!agreement) return undefined;
  if (isAgreementArtifact(agreement)) {
    return agreement.parties.find((party) => party.role === role)?.primaryClaim;
  }
  const scope = stripSignature(agreement);
  if (isLegacyMvpAgreementDocument(scope)) return scope[role];
  return undefined;
}

/**
 * Hash resolution alone cannot let an agreement redefine the enclosing
 * session. This is structural coherence only; cryptographic verification of
 * AgreementSignature[] remains a separate required closure step.
 */
function agreementIsCoherentWithBundle(
  agreement: Record<string, unknown>,
  bundle: ReadableAttestationBundle,
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
      agreementBuyers[0]!.primaryClaim === bundleBuyers[0]!.primaryClaim &&
      agreementBuyers[0]!.bundleHash === bundleBuyers[0]!.bundleHash &&
      agreementSellers[0]!.primaryClaim === bundleSellers[0]!.primaryClaim &&
      agreementSellers[0]!.bundleHash === bundleSellers[0]!.bundleHash
    );
  }

  const scope = stripSignature(agreement);
  // Historical runSessionCore bundles are explicitly buyer-only. Keep reading
  // their legacy agreement when the buyer and job match; the absent seller
  // party is already surfaced by the required-signature check and must not be
  // upgraded into a second, misleading ref-integrity failure.
  if (bundleSellers.length === 0) {
    return (
      isLegacyMvpAgreementDocument(scope) &&
      scope.jobId === bundle.jobId &&
      scope.buyer === bundleBuyers[0]!.primaryClaim
    );
  }
  return (
    isLegacyMvpAgreementDocument(scope) &&
    scope.jobId === bundle.jobId &&
    scope.buyer === bundleBuyers[0]!.primaryClaim &&
    scope.seller === bundleSellers[0]!.primaryClaim
  );
}

function requiredSignatureClaims(
  bundle: ReadableAttestationBundle,
  agreement: Record<string, unknown> | null,
): string[] {
  if (!CO_SIGNATURE_REQUIRED_OUTCOMES.has(bundle.outcome)) return [];
  const buyer = bundle.parties.find((party) => party.role === "buyer")?.primaryClaim;
  const seller = bundle.parties.find((party) => party.role === "seller")?.primaryClaim;
  const claims = [
    agreementClaim(agreement, "buyer") ?? buyer ?? "role:buyer",
    agreementClaim(agreement, "seller") ?? seller ?? "role:seller",
  ];
  const orchestrator = bundle.parties.find((party) => party.role === "orchestrator")?.primaryClaim;
  if (orchestrator && orchestrator !== buyer && orchestrator !== seller) claims.push(orchestrator);
  return [...new Set(claims)];
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
  if (raw && isFaultBundle(raw) && !faultedPartyIsPermitted(raw)) {
    return {
      ok: false,
      reason: "faultedParty is not permitted for outcome and anchoredByRole",
      fullyVerified: false,
      signatures: [],
      refs: [],
    };
  }
  if (
    !raw ||
    (!isAnyAttestationBundle(raw) && !isLegacyMvpAnyAttestationBundle(raw))
  ) {
    return {
      ok: false,
      reason: "not an attestation bundle",
      fullyVerified: false,
      signatures: [],
      refs: [],
    };
  }
  const bundle = raw as ReadableAttestationBundle;
  if (!CO_SIGNATURE_REQUIRED_OUTCOMES.has(bundle.outcome) && !ABORT_OUTCOMES.has(bundle.outcome)) {
    return {
      ok: false,
      reason: `unsupported DACS-5 bundle outcome: ${bundle.outcome}`,
      fullyVerified: false,
      signatures: [],
      refs: [],
      bundle,
    };
  }
  // Signed scope = canonical form omitting signatures + anchoredByRole (§10.4.1).
  const scope = { ...raw };
  delete scope["signatures"];
  delete scope["anchoredByRole"];
  const message = signedBytes(
    isFaultBundle(bundle as unknown as Record<string, unknown>)
      ? ARTIFACT_SEPARATORS.FaultAttestationBundle
      : ARTIFACT_SEPARATORS.AttestationBundle,
    contentHash(scope),
  );

  const sigs = Array.isArray(raw["signatures"])
    ? (raw["signatures"] as Array<{ party?: unknown; value?: unknown }>)
    : [];

  const signatures: SignatureCheck[] = [];
  for (const s of sigs) {
    const party = typeof s.party === "string" ? s.party : "";
    const resolvedKey = await deps.resolvePublicKey(party);
    let verdict: SignatureVerdict;
    if (!resolvedKey) {
      verdict = "unverified";
    } else if (
      !(resolvedKey instanceof Uint8Array) ||
      resolvedKey.length !== 32
    ) {
      // Malformed resolved key — can't evaluate; ERROR, not a false FAIL.
      verdict = "error";
    } else {
      const key = Uint8Array.from(resolvedKey);
      const sigBytes = Uint8Array.from(
        Buffer.from(typeof s.value === "string" ? s.value : "", "base64url"),
      );
      const verified = await deps.verify(
        Uint8Array.from(message),
        Uint8Array.from(sigBytes),
        Uint8Array.from(key),
      );
      verdict = verified === true ? "valid" : "invalid";
    }
    signatures.push({ party, verdict });
  }

  // ── Referenced-artifact integrity ──────────────────────────────────────────
  const refs: RefCheck[] = [];
  let agreementArtifact: Record<string, unknown> | null = null;
  if (!bundle.agreementRef && requiresAgreementRef(bundle)) {
    refs.push({ kind: "dacs-3-agreement", id: "agreementRef", verdict: "missing" });
  }
  const refLocator = (ref: ReadableAttestationRef): string =>
    isAttestationRef(ref) ? ref.anchor.locator : ref.id;
  const resolveReadableRef = async (
    ref: ReadableAttestationRef,
  ): Promise<{ supported: boolean; value: Record<string, unknown> | null }> => {
    if (isAttestationRef(ref)) {
      if (!deps.resolveAttestationRef) return { supported: false, value: null };
      const resolved = await deps.resolveAttestationRef(
        structuredClone(ref),
        bundle.jobId,
        structuredClone(bundle.parties),
      );
      return {
        supported: true,
        value: snapshotDependencyRecord(
          resolved,
          `resolved artifact ${ref.anchor.locator}`,
        ),
      };
    }
    if (!deps.resolveRef) return { supported: false, value: null };
    const resolved = await deps.resolveRef(
      ref.kind,
      bundle.jobId,
      structuredClone(bundle.parties),
    );
    return {
      supported: true,
      value: snapshotDependencyRecord(
        resolved,
        `resolved legacy artifact ${ref.kind}`,
      ),
    };
  };
  const checkReadableRef = async (
    artifactKind: string,
    ref: ReadableAttestationRef,
    validate: (value: Record<string, unknown>) => boolean,
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
    return {
      check: checkArtifact(
        artifactKind,
        refLocator(ref),
        ref.contentHash,
        validate,
        value,
      ),
      value,
    };
  };

  if (bundle.agreementRef) {
    const agreement = await checkReadableRef(
      "dacs-3-agreement",
      bundle.agreementRef,
      isLegacyMvpAttestationRef(bundle.agreementRef)
        ? isLegacyMvpAgreementDocument
        : isAgreementArtifact,
    );
    if (
      agreement.check.verdict === "ok" &&
      agreement.value &&
      !agreementIsCoherentWithBundle(agreement.value, bundle)
    ) {
      agreement.check.verdict = "incoherent";
    }
    refs.push(agreement.check);
    agreementArtifact =
      agreement.check.verdict === "ok" ||
      agreement.check.verdict === "incoherent"
        ? agreement.value
        : null;
  }
  for (const ev of bundle.settlementEvidence) {
    const evidence = await checkReadableRef(
      "dacs-4-evidence",
      ev,
      isLegacyMvpAttestationRef(ev)
        ? isLegacyMvpSettlementEvidence
        : isSettlementEvidence,
    );
    if (
      evidence.check.verdict === "ok" &&
      deps.verifyEvidence &&
      evidence.value
    ) {
      const callbackVerdict = await deps.verifyEvidence(
        structuredClone(evidence.value),
      );
      let decision: unknown;
      try {
        const verdict = snapshotCanonicalJson(
          callbackVerdict,
          "SettlementEvidence verification verdict",
        ) as { decision?: unknown };
        decision = verdict.decision;
      } catch {
        decision = undefined;
      }
      if (decision !== "pass") {
        evidence.check.verdict = "invalid-evidence";
      }
    }
    refs.push(evidence.check);
  }
  for (const vr of bundle.vetRecords) {
    refs.push(
      (
        await checkReadableRef(
          "dacs-2-verifyresult",
          vr,
          isCompositeVerificationRecord,
        )
      ).check,
    );
  }
  for (const amendment of bundle.amendments ?? []) {
    refs.push(
      (await checkReadableRef("dacs-4-amendment", amendment, isAnyRecord))
        .check,
    );
  }
  for (const rating of bundle.ratingRefs ?? []) {
    refs.push(
      (await checkReadableRef("dacs-5-rating", rating, isAnyRecord)).check,
    );
  }

  // The listing is not a session AttestationRef. Follow the agreement's signed
  // listing address, or use the explicit legacy resolver for pre-commit reads.
  const listingId = String(bundle.listingRef.listingId);
  const agreementListingPin =
    agreementArtifact && isAgreementArtifact(agreementArtifact)
      ? agreementArtifact.listingRef
      : null;
  const listingAddr =
    agreementArtifact &&
    typeof (stripSignature(agreementArtifact) as { listingRef?: unknown })
      .listingRef === "string"
      ? (stripSignature(agreementArtifact) as { listingRef: string }).listingRef
      : null;
  const canResolveListing = Boolean(
    (agreementListingPin && deps.resolveListingRef) ||
      listingAddr ||
      deps.resolveRef,
  );
  let listing: Record<string, unknown> | null = null;
  if (agreementListingPin && deps.resolveListingRef) {
    listing = snapshotDependencyRecord(
      await deps.resolveListingRef(
        structuredClone(agreementListingPin),
        structuredClone(bundle.parties),
      ),
      `resolved Listing ${agreementListingPin.listingId}`,
    );
  } else if (listingAddr) {
    listing = snapshotDependencyRecord(
      await deps.readArtifact(listingAddr),
      `resolved legacy Listing ${listingAddr}`,
    );
  } else if (deps.resolveRef) {
    listing = snapshotDependencyRecord(
      await deps.resolveRef(
        "dacs-1-listing",
        bundle.jobId,
        structuredClone(bundle.parties),
      ),
      "resolved legacy Listing",
    );
  }
  const listingPinCoherent =
    !agreementListingPin ||
    (agreementListingPin.listingId === bundle.listingRef.listingId &&
      agreementListingPin.version === bundle.listingRef.version &&
      agreementListingPin.contentHash === bundle.listingRef.contentHash);
  refs.push(
    !listingPinCoherent
      ? {
          kind: "dacs-1-listing",
          id: listingId,
          verdict: "hash-mismatch",
        }
      : canResolveListing
        ? checkArtifact(
            "dacs-1-listing",
            listingId,
            bundle.listingRef.contentHash,
            isReadableListingScope,
            listing,
          )
      : {
          kind: "dacs-1-listing",
          id: listingId,
          verdict: "unresolved",
        },
  );

  const anyInvalid = signatures.some((c) => c.verdict === "invalid");
  const anyError = signatures.some((c) => c.verdict === "error");
  const anyValid = signatures.some((c) => c.verdict === "valid");
  const validSignatureClaims = new Set(
    signatures.filter((c) => c.verdict === "valid").map((c) => c.party),
  );
  const missingRequiredSignatures = requiredSignatureClaims(bundle, agreementArtifact).filter(
    (claim) => !validSignatureClaims.has(claim),
  );
  const sigOk = anyValid && !anyInvalid && !anyError;
  const fullyVerified =
    signatures.length > 0 &&
    signatures.every((c) => c.verdict === "valid") &&
    missingRequiredSignatures.length === 0;
  const badRef = refs.find((r) => r.verdict !== "ok");
  const refsOk = !badRef;

  return {
    ok: sigOk && missingRequiredSignatures.length === 0 && refsOk,
    reason:
      signatures.length === 0
        ? "bundle has no signatures"
        : anyInvalid
          ? "one or more signatures failed verification"
          : anyError
            ? "one or more signer keys were malformed (could not verify)"
            : missingRequiredSignatures.length > 0
              ? `missing required signature(s): ${missingRequiredSignatures.join(", ")}`
            : !anyValid
              ? "no signer key could be resolved"
              : badRef
                ? `referenced artifact ${badRef.kind}/${badRef.id} ${badRef.verdict}`
                : undefined,
    fullyVerified,
    bundle,
    signatures,
    refs,
  };
}
