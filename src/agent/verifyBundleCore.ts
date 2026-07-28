import { contentHash, stripSignature } from "../canonical/index.js";
import { signedBytes } from "../crypto/index.js";
import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import type { AttestationBundle, BundleParty } from "../artifacts/types.js";
import {
  isAgreementDocument,
  isAttestationBundle,
  isCompositeVerificationRecord,
  isListing,
  isSettlementEvidence,
} from "../artifacts/validators.js";
import { type Verifier } from "./signedArtifact.js";

/**
 * Attestation-bundle verification (DACS-5). Two independent checks must BOTH
 * pass for `ok`:
 *
 *  1. Signature — the bundle's signed scope is its canonical form omitting
 *     `signatures` + `anchoredByRole` (§10.4.1); each `signatures[]` entry is an
 *     Ed25519 signature over `signedBytes("dacs-bundle:v1:", contentHash(scope))`
 *     by a party. We resolve each party's key and check its signature. Verdicts
 *     are honestly four-stated: `valid`, `invalid` (tampering/wrong key), `error`
 *     (key resolved but malformed — §10.4.1 ERROR, not a false FAIL),
 *     `unverified` (no key resolvable).
 *
 *  2. Referenced-artifact integrity — the bundle's refs (agreementRef,
 *     settlementEvidence[], vetRecords[], listingRef) are content-addressed
 *     `{kind,id,contentHash}`. A valid bundle signature only binds those *hashes*;
 *     it does NOT prove the referenced artifacts exist or are untampered. So we
 *     dereference each (via `resolveRef`, keyed by the bundle's jobId), validate
 *     its shape, and confirm its signed-scope content hash equals the ref. Without
 *     this a correctly-signed bundle could point at missing/tampered evidence and
 *     still report verified. If no `resolveRef` is supplied we cannot attest the
 *     refs, so they are reported `unresolved` and the bundle is NOT ok.
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
  bundle?: AttestationBundle;
  signatures: SignatureCheck[];
  /** Per-referenced-artifact integrity results. */
  refs: RefCheck[];
}

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
   * that hash-matches but whose evidence does NOT verify (`fail`/`error`) is
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
  if (!validate(scope)) return { kind, id, verdict: "invalid-shape" };
  if (contentHash(scope) !== expectedHash)
    return { kind, id, verdict: "hash-mismatch" };
  return { kind, id, verdict: "ok" };
}

export async function verifyBundleCore(
  bundleRef: string,
  deps: VerifyBundleDeps,
): Promise<BundleVerification> {
  const raw = await deps.readArtifact(bundleRef);
  if (!raw || !isAttestationBundle(stripSignature(raw))) {
    return {
      ok: false,
      reason: "not an attestation bundle",
      fullyVerified: false,
      signatures: [],
      refs: [],
    };
  }
  const bundle = stripSignature(raw) as unknown as AttestationBundle;

  // Signed scope = canonical form omitting signatures + anchoredByRole (§10.4.1).
  const scope = { ...raw };
  delete scope["signatures"];
  delete scope["anchoredByRole"];
  const message = signedBytes(
    ARTIFACT_SEPARATORS.AttestationBundle,
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
  if (!deps.resolveRef) {
    const note = (kind: string, id: string) =>
      refs.push({ kind, id, verdict: "unresolved" as const });
    note(bundle.agreementRef.kind, bundle.agreementRef.id);
    for (const ev of bundle.settlementEvidence) note(ev.kind, ev.id);
    for (const vr of bundle.vetRecords) note(vr.kind, vr.id);
    note("dacs-1-listing", String(bundle.listingRef.listingId));
  } else {
    const agr = await deps.resolveRef(
      bundle.agreementRef.kind,
      bundle.jobId,
      bundle.parties,
    );
    refs.push(
      checkArtifact(
        bundle.agreementRef.kind,
        bundle.agreementRef.id,
        bundle.agreementRef.contentHash,
        isAgreementDocument,
        agr,
      ),
    );
    for (const ev of bundle.settlementEvidence) {
      const r = await deps.resolveRef(ev.kind, bundle.jobId, bundle.parties);
      const check = checkArtifact(
        ev.kind,
        ev.id,
        ev.contentHash,
        isSettlementEvidence,
        r,
      );
      // Optional §9.7 semantics: a hash-matched evidence record can still be
      // internally invalid (wrong finality model, non-canonical amount, bad
      // signer, …). If the caller wired a verifier, run it and downgrade a
      // non-passing record — a signature over the bundle only binds the hash.
      if (check.verdict === "ok" && deps.verifyEvidence && r) {
        const verdict = await deps.verifyEvidence(stripSignature(r));
        if (verdict.decision === "fail" || verdict.decision === "error") {
          check.verdict = "invalid-evidence";
        }
      }
      refs.push(check);
    }
    for (const vr of bundle.vetRecords) {
      const r = await deps.resolveRef(vr.kind, bundle.jobId, bundle.parties);
      refs.push(
        checkArtifact(
          vr.kind,
          vr.id,
          vr.contentHash,
          isCompositeVerificationRecord,
          r,
        ),
      );
    }
    // The listing isn't a jobId-keyed session artifact; resolve it through the
    // agreement's listingRef (its storage address) and hash-check the bundle's
    // ListingRef against it.
    const listingId = String(bundle.listingRef.listingId);
    const listingAddr =
      agr &&
      typeof (stripSignature(agr) as { listingRef?: unknown }).listingRef ===
        "string"
        ? ((stripSignature(agr) as { listingRef: string }).listingRef)
        : null;
    const listing = listingAddr
      ? await deps.readArtifact(listingAddr)
      : null;
    refs.push(
      checkArtifact(
        "dacs-1-listing",
        listingId,
        bundle.listingRef.contentHash,
        isListing,
        listing,
      ),
    );
  }

  const anyInvalid = signatures.some((c) => c.verdict === "invalid");
  const anyError = signatures.some((c) => c.verdict === "error");
  const anyValid = signatures.some((c) => c.verdict === "valid");
  const sigOk = anyValid && !anyInvalid && !anyError;
  const fullyVerified =
    signatures.length > 0 && signatures.every((c) => c.verdict === "valid");
  const badRef = refs.find((r) => r.verdict !== "ok");
  const refsOk = !badRef;

  return {
    ok: sigOk && refsOk,
    reason:
      signatures.length === 0
        ? "bundle has no signatures"
        : anyInvalid
          ? "one or more signatures failed verification"
          : anyError
            ? "one or more signer keys were malformed (could not verify)"
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
