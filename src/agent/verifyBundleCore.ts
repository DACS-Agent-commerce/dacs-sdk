import { contentHash, stripSignature } from "../canonical/index.js";
import { signedBytes } from "../crypto/index.js";
import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import type {
  AnyAttestationBundle,
  AttestationRef,
  BundleParty,
} from "../artifacts/types.js";
import {
  type LegacyMvpAnyAttestationBundle,
  type LegacyMvpAttestationRef,
  isLegacyMvpAnyAttestationBundle,
  isLegacyMvpAttestationRef,
  isLegacyMvpSettlementEvidence,
} from "../artifacts/legacyMvp.js";
import {
  isAgreementDocument,
  isAnyAttestationBundle,
  isAttestationRef,
  isCompositeVerificationRecord,
  isListing,
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
  const scope = stripSignature(agreement);
  if (!isAgreementDocument(scope)) return undefined;
  return scope[role];
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
  deps: VerifyBundleDeps,
): Promise<BundleVerification> {
  const raw = await deps.readArtifact(bundleRef);
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
    const key = await deps.resolvePublicKey(party);
    let verdict: SignatureVerdict;
    if (!key) {
      verdict = "unverified";
    } else if (key.length !== 32) {
      // Malformed resolved key — can't evaluate; ERROR, not a false FAIL.
      verdict = "error";
    } else {
      const sigBytes = Uint8Array.from(
        Buffer.from(typeof s.value === "string" ? s.value : "", "base64url"),
      );
      verdict = (await deps.verify(message, sigBytes, key)) ? "valid" : "invalid";
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
      return {
        supported: true,
        value: await deps.resolveAttestationRef(ref, bundle.jobId, bundle.parties),
      };
    }
    if (!deps.resolveRef) return { supported: false, value: null };
    return {
      supported: true,
      value: await deps.resolveRef(ref.kind, bundle.jobId, bundle.parties),
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
    return {
      check: checkArtifact(
        artifactKind,
        refLocator(ref),
        ref.contentHash,
        validate,
        resolved.value,
      ),
      value: resolved.value,
    };
  };

  if (bundle.agreementRef) {
    const agreement = await checkReadableRef(
      "dacs-3-agreement",
      bundle.agreementRef,
      isAgreementDocument,
    );
    refs.push(agreement.check);
    agreementArtifact = agreement.value;
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
      const verdict = await deps.verifyEvidence(evidence.value);
      if (verdict.decision !== "pass") {
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
  const listingAddr =
    agreementArtifact &&
    typeof (stripSignature(agreementArtifact) as { listingRef?: unknown })
      .listingRef === "string"
      ? (stripSignature(agreementArtifact) as { listingRef: string }).listingRef
      : null;
  const canResolveListing = Boolean(listingAddr || deps.resolveRef);
  const listing = listingAddr
    ? await deps.readArtifact(listingAddr)
    : deps.resolveRef
      ? await deps.resolveRef("dacs-1-listing", bundle.jobId, bundle.parties)
      : null;
  refs.push(
    canResolveListing
      ? checkArtifact(
          "dacs-1-listing",
          listingId,
          bundle.listingRef.contentHash,
          isListing,
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
