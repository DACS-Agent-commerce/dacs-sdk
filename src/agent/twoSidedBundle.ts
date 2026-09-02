/**
 * DACS-5 §10.4.1/§10.4.2 — v0.3 FaultAttestationBundle production.
 *
 * Each signing party anchors a role-specific copy. `faultedParty` is absolute and hashed;
 * `outcome` is spelled from that copy's role. Fault pairs therefore share one fault and outcome
 * class while using the required perspective-partner outcome spellings.
 *
 * Why this module owns the omission set: `canonical/hash.ts` strips only
 * `signature`/`signatures`, so `contentHash()` — and therefore `signArtifact()` — computes
 * the WRONG scope for a bundle: it leaves `anchoredByRole` in. Every producer that hand-deletes
 * the field at its own call site duplicates that knowledge and can drift. `BUNDLE_SIGNED_SCOPE_OMIT`
 * below is the single source; signer and verifier MUST both go through it or signatures will not
 * round-trip across the two copies.
 */
import type { KeyObject } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { canonicalize } from "../canonical/jcs.js";
import { sha256Hex } from "../canonical/hash.js";
import { snapshotCanonicalJsonRead } from "../canonical/snapshot.js";
import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import {
  isEvidenceBoundFaultAttestationBundle,
  isFaultAttestationBundle,
} from "../artifacts/validators.js";
import { ed25519Sign } from "../crypto/ed25519.js";
import { signedBytes, type DomainSeparator } from "../crypto/signing.js";
import { DacsError } from "../errors.js";
import { sameCanonicalClaimIdentity } from "../identity/claimReference.js";
import type {
  AnyAttestationBundle,
  BundleParty,
  BundlePartyRole,
  BundleSignature,
  EvidenceBoundFaultAttestationBundle,
  EvidenceBoundPhaseSummaryEntry,
  FaultAttestationBundle,
  FaultedParty,
} from "../artifacts/types.js";
import {
  BUNDLE_OUTCOMES,
  bundleOutcomeClass,
  isBundleOutcome,
  roleRelativeOutcome,
  type BundleOutcome,
} from "./bundleSemantics.js";

/**
 * The bundle's hash-excluded fields (§10.4.1). SINGLE SOURCE — a producer and a verifier that
 * disagree on this set produce signatures that do not verify.
 */
export const BUNDLE_SIGNED_SCOPE_OMIT = Object.freeze(["signatures", "anchoredByRole"] as const);

/**
 * The ONLY outcomes a single-signed bundle may carry (§10.4.1): "A bundle whose outcome is
 * `aborted-by-self` or `aborted-by-other` MAY carry a single signature".
 *
 * This is an ALLOWLIST on purpose. The inverse — a denylist of outcomes that require both
 * signatures — fails OPEN: any outcome not on the list (a typo, an outcome added by a future
 * minor version) silently yields a single-signed bundle, which is precisely the artifact
 * §10.4.1 orders consumers to drop. The spec's own structure is an allowlist; mirror it.
 */
const SINGLE_SIGNATURE_PERMITTED = new Set<string>(["aborted-by-self", "aborted-by-other"]);
export { BUNDLE_OUTCOMES, type BundleOutcome } from "./bundleSemantics.js";

/** The roles that can anchor a copy of a bundle (§10.4.2). */
export type BundleAnchorRole = BundlePartyRole;

/**
 * A session-scoped signer never contains raw private-key bytes. Convert a seed
 * to a `KeyObject` before constructing the session, then wipe the caller-owned
 * seed, or supply a remote/HSM-backed callback.
 */
export type SessionSigner =
  | KeyObject
  | ((bytes: Uint8Array) => Promise<Uint8Array> | Uint8Array);

/** @internal Runtime guard for JavaScript and type-erased callers. */
export function assertNoRawSessionSeed(signer: unknown, subject: string): void {
  if (signer instanceof Uint8Array) {
    throw new DacsError(
      `${subject} must not retain a raw Ed25519 seed; use a prepared KeyObject or signing callback`,
    );
  }
}

/** The §B.2 canonical form of a bundle: the document minus `signatures` and `anchoredByRole`. */
export function bundleSignedScope(bundle: AnyAttestationBundle): Record<string, unknown> {
  const snapshot = snapshotCanonicalJsonRead(
    bundle as unknown as Record<string, unknown>,
    "attestation bundle",
  );
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new DacsError("attestation bundle must be a canonical JSON object");
  }
  // Object.fromEntries creates own data properties even for `__proto__`.
  // Unknown minor-version fields therefore stay hash-bound; only the two
  // normative bundle envelope fields are omitted.
  return Object.fromEntries(
    Object.entries(snapshot).filter(
      ([key]) =>
        !(BUNDLE_SIGNED_SCOPE_OMIT as readonly string[]).includes(key),
    ),
  );
}

/**
 * `attestation_bundle_hash` (§10.4.1): sha256 of the JCS canonical form of the signed scope.
 * Distinct from `BundleParty.bundleHash`, which hashes a party's IdentityBundle.
 */
export function attestationBundleHash(bundle: AnyAttestationBundle): string {
  return sha256Hex(canonicalize(bundleSignedScope(bundle)));
}

/** A party to the session, with whatever can sign on its behalf. */
export interface SessionParty {
  primaryClaim: string;
  /**
   * §10.4.1 `SessionParty.bundleHash`: "sha256 of the verified IdentityBundle". It is NOT a hash
   * of the agent id, and NOT the `attestation_bundle_hash`.
   *
   * Caller-supplied on purpose — this module cannot verify an IdentityBundle, and inventing a
   * value here would bake a wrong one into every bundle. NOTE for whoever wires this up:
   * `runSessionCore.ts:387` currently passes `sha256Hex(deps.buyerId)`, which is a hash of the
   * agent id, not of an IdentityBundle. That is a conformance gap in the caller, and it survives
   * this constructor because a 64-hex string is indistinguishable from the right one.
   */
  bundleHash: string;
  /** A prepared KeyObject or remote/HSM-backed signing function. */
  signer?: SessionSigner;
}

export interface SigningSessionParty extends SessionParty {
  signer: SessionSigner;
}

/** The facts of one completed (or aborted) session, from which both copies are derived. */
export interface TwoSidedSession {
  jobId: string;
  /**
   * The closed set (§10.4.1). Typed for TS callers; the runtime guard in `buildTwoSidedBundle`
   * still fires, because a JS caller or an `as any` erases the type and the spec's constraint is
   * on the artifact, not on the type system.
   */
  outcome: BundleOutcome;
  /** Required for fault/abort classes; omitted for completed/failed-substrate. */
  faultedParty?: Exclude<FaultedParty, "none">;
  listingRef: AnyAttestationBundle["listingRef"];
  agreementRef?: AnyAttestationBundle["agreementRef"];
  cancellation?: AnyAttestationBundle["cancellation"];
  phaseSummary: AnyAttestationBundle["phaseSummary"];
  vetRecords: AnyAttestationBundle["vetRecords"];
  settlementEvidence: AnyAttestationBundle["settlementEvidence"];
  amendments?: AnyAttestationBundle["amendments"];
  ratingRefs?: AnyAttestationBundle["ratingRefs"];
  recipeRegistryVersion: number;
  railRegistryVersion: number;
  finalisedAt: number;
  buyer: SessionParty;
  /**
   * The seller identity is required even for a single-signed abort bundle. §10.4.1 permits an
   * abort bundle to miss the seller signature, not to erase the seller from `parties[]`.
   */
  seller: SessionParty;
  /**
   * The orchestrator, when it is a party DISTINCT from buyer and seller. §10.4.1: "If the
   * orchestrator is a distinct party (not buyer or seller), the orchestrator signature is also
   * REQUIRED" for a fully signed copy. Its identity may be retained without a signer only for
   * the exact single-role abort-suppression path; no unsigned role is erased from `parties[]`.
   * Omit it for the ordinary two-party session, where no third role exists.
   */
  orchestrator?: SessionParty;
  faultBundleVersion?: "1";
}

export interface TwoSidedBundles {
  buyerCopy?: FaultAttestationBundle;
  sellerCopy?: FaultAttestationBundle;
  orchestratorCopy?: FaultAttestationBundle;
}

/** Party identity is the primary claim (§10.4.1 `parties[].primaryClaim` = `bundle.presentedBy`). */
function sameParty(a: SessionParty, b: SessionParty): boolean {
  return sameCanonicalClaimIdentity(a.primaryClaim, b.primaryClaim);
}

function canSign(party: SessionParty): party is SigningSessionParty {
  return party.signer !== undefined;
}

function isAgreementCommitPhase(kind: string): boolean {
  return kind === "commit" || kind.startsWith("commit-");
}

async function signOver(
  party: SigningSessionParty,
  hash: string,
  separator: DomainSeparator = ARTIFACT_SEPARATORS.FaultAttestationBundle,
): Promise<BundleSignature> {
  const payload = signedBytes(separator, hash);
  assertNoRawSessionSeed(party.signer, `session signer ${party.primaryClaim}`);
  const raw =
    typeof party.signer === "function"
      ? await party.signer(payload)
      : ed25519Sign(payload, party.signer);
  return {
    party: party.primaryClaim,
    algorithm: "ed25519",
    value: Buffer.from(raw).toString("base64url"),
  };
}

/**
 * Build the applicable anchored copies of a session's FaultAttestationBundle.
 *
 * Completed/failed-substrate copies are canonically equal. Fault/abort copies carry the same
 * absolute `faultedParty` and class, with role-relative outcomes per §10.4.1.
 *
 * A single-signed bundle is valid ONLY for an abort outcome (§10.4.1): a single-signed
 * `completed`/`failed-*` MUST be dropped by every consumer, so this refuses to produce one. In
 * that suppression path, the emitted copy is anchored by the actual signer and records
 * `aborted-by-other`; consumers classify the absent non-signer as `aborted-by-self` (§10.11).
 */
export async function buildTwoSidedBundle(
  session: TwoSidedSession,
): Promise<TwoSidedBundles> {
  const { buyer, seller, outcome } = session;

  // Gate 1 — the outcome is in the spec's CLOSED set. Without this, a plausible-looking but
  // non-existent outcome (`failed-buyer`, a typo, a future version's) rides through as a fully
  // co-signed bundle: every signature verifies, and the artifact is still not a DACS-5 bundle.
  // The missing-seller guard below cannot catch that, because nothing is missing.
  if (!isBundleOutcome(outcome)) {
    throw new DacsError(
      `outcome "${outcome}" is not a DACS-5 bundle outcome (§10.4.1). ` +
        `Expected one of: ${BUNDLE_OUTCOMES.join(", ")}.`,
    );
  }

  if (session.faultBundleVersion !== undefined && session.faultBundleVersion !== "1") {
    throw new DacsError(
      `faultBundleVersion "${session.faultBundleVersion}" is not supported by this v1 bundle signer. ` +
        "Use faultBundleVersion \"1\" or omit it.",
    );
  }

  const outcomeClass = bundleOutcomeClass(outcome)!;
  const suppliedFault = session.faultedParty as unknown;
  if (
    (outcomeClass === "completed" || outcomeClass === "failed-substrate") &&
    suppliedFault !== undefined
  ) {
    throw new DacsError(`outcome "${outcome}" must not declare faultedParty.`);
  }
  if (
    (outcomeClass === "failure" || outcomeClass === "abort") &&
    suppliedFault !== "buyer" &&
    suppliedFault !== "seller" &&
    suppliedFault !== "orchestrator"
  ) {
    throw new DacsError(
      `outcome "${outcome}" requires absolute faultedParty buyer, seller, or orchestrator for FaultAttestationBundle production.`,
    );
  }
  const faultedParty: FaultedParty =
    outcomeClass === "completed" || outcomeClass === "failed-substrate"
      ? "none"
      : (suppliedFault as BundlePartyRole);

  if (!seller) {
    throw new DacsError(
      `outcome "${outcome}" requires the seller party in parties[] (§10.4.1): a ` +
        "single-signed abort bundle may omit the seller signature, but not the seller identity.",
    );
  }

  const hasCommitCompleted = session.phaseSummary.some(
    (phase) => phase.outcome === "ok" && isAgreementCommitPhase(phase.kind),
  );
  const hasPostCommitRefs =
    session.outcome === "completed" ||
    hasCommitCompleted ||
    session.settlementEvidence.length > 0 ||
    (session.amendments?.length ?? 0) > 0 ||
    (session.ratingRefs?.length ?? 0) > 0;
  if (!session.agreementRef && hasPostCommitRefs) {
    throw new DacsError(
      "agreementRef is required once the session reaches agreement commitment or later (§10.4.3). " +
        "Only pre-commit terminal bundles may omit it.",
    );
  }

  if (session.cancellation) {
    if (!SINGLE_SIGNATURE_PERMITTED.has(outcome)) {
      throw new DacsError(
        "cancellation is only supported on aborted-by-self/aborted-by-other bundles (§10.3.1 ST-10).",
      );
    }
    if (session.cancellation.claimedPolicy !== "pre-commit") {
      throw new DacsError(
        `cancellation claimedPolicy "${session.cancellation.claimedPolicy}" is not supported; only "pre-commit" is defined.`,
      );
    }
    if (session.agreementRef) {
      throw new DacsError(
        "pre-commit cancellation cannot carry agreementRef: the session already reached agreement commitment.",
      );
    }
  }

  // Gate 2 — §10.4.1: the orchestrator signature is REQUIRED only when the orchestrator is a
  // "distinct party (not buyer or seller)". When the orchestrator IS the buyer or the seller, it
  // is already a party and already a signer; adding it again produces a duplicate signature and a
  // phantom third role. Not distinct means not a separate party — so drop it.
  const orchestrator =
    session.orchestrator &&
    !sameParty(session.orchestrator, buyer) &&
    !(seller && sameParty(session.orchestrator, seller))
      ? session.orchestrator
      : undefined;

  const buyerSigner = canSign(buyer) ? buyer : undefined;
  const sellerSigner = canSign(seller) ? seller : undefined;
  const orchestratorSigner = orchestrator && canSign(orchestrator)
    ? orchestrator
    : undefined;
  if (!buyerSigner && !SINGLE_SIGNATURE_PERMITTED.has(outcome)) {
    throw new DacsError(
      `outcome "${outcome}" requires the buyer's signature (§10.4.1): only ${[
        ...SINGLE_SIGNATURE_PERMITTED,
      ]
        .map((o) => `"${o}"`)
        .join(" or ")} may be single-signed.`,
    );
  }
  if (!sellerSigner && !SINGLE_SIGNATURE_PERMITTED.has(outcome)) {
    throw new DacsError(
      `outcome "${outcome}" requires the seller's signature (§10.4.1): a bundle missing a ` +
        `required signature MUST be rejected by consumers. Only ${[...SINGLE_SIGNATURE_PERMITTED]
          .map((o) => `"${o}"`)
          .join(" or ")} may be single-signed.`,
    );
  }
  if (orchestrator && !orchestratorSigner && !SINGLE_SIGNATURE_PERMITTED.has(outcome)) {
    throw new DacsError(
      `outcome "${outcome}" requires the distinct orchestrator's signature (§10.4.1).`,
    );
  }
  const availableSigners: Array<{
    role: BundleAnchorRole;
    party: SigningSessionParty;
  }> = [
    ...(buyerSigner ? [{ role: "buyer" as const, party: buyerSigner }] : []),
    ...(sellerSigner ? [{ role: "seller" as const, party: sellerSigner }] : []),
    ...(orchestratorSigner
      ? [{ role: "orchestrator" as const, party: orchestratorSigner }]
      : []),
  ];
  if (availableSigners.length === 0) {
    throw new DacsError(
      "a DACS-5 abort bundle requires at least one session-role signature (§10.11).",
    );
  }
  const parties: BundleParty[] = [
    { role: "buyer", bundleHash: buyer.bundleHash, primaryClaim: buyer.primaryClaim },
    { role: "seller", bundleHash: seller.bundleHash, primaryClaim: seller.primaryClaim },
    ...(orchestrator
      ? [
          {
            role: "orchestrator",
            bundleHash: orchestrator.bundleHash,
            primaryClaim: orchestrator.primaryClaim,
          },
        ]
      : []),
  ];

  const sessionRoles = new Set(parties.map((party) => party.role));
  if (faultedParty !== "none" && !sessionRoles.has(faultedParty)) {
    throw new DacsError(
      `faultedParty "${faultedParty}" is not a role in this session's parties[].`,
    );
  }

  const fullySigned =
    buyerSigner !== undefined &&
    sellerSigner !== undefined &&
    (!orchestrator || orchestratorSigner !== undefined);
  const singlePartyAbort =
    SINGLE_SIGNATURE_PERMITTED.has(outcome) && availableSigners.length === 1;
  if (!fullySigned && !singlePartyAbort) {
    throw new DacsError(
      `outcome "${outcome}" has an incomplete signer set: terminal copies must be fully signed, ` +
        "or carry exactly one role-owner signature for an abort (§10.4.1/§10.11).",
    );
  }
  const singleSignerRole = singlePartyAbort
    ? availableSigners[0]!.role
    : undefined;
  if (singleSignerRole && faultedParty === singleSignerRole) {
    throw new DacsError(
      "single-signed abort must name a non-signer as faultedParty (§10.11 suppression).",
    );
  }
  const bodyFor = (role: BundleAnchorRole) => ({
    faultBundleVersion: session.faultBundleVersion ?? "1",
    jobId: session.jobId,
    outcome: roleRelativeOutcome(outcomeClass, faultedParty, role),
    faultedParty,
    listingRef: session.listingRef,
    ...(session.agreementRef ? { agreementRef: session.agreementRef } : {}),
    ...(session.cancellation ? { cancellation: session.cancellation } : {}),
    parties,
    phaseSummary: session.phaseSummary,
    vetRecords: session.vetRecords,
    settlementEvidence: session.settlementEvidence,
    ...(session.amendments ? { amendments: session.amendments } : {}),
    ...(session.ratingRefs ? { ratingRefs: session.ratingRefs } : {}),
    recipeRegistryVersion: session.recipeRegistryVersion,
    railRegistryVersion: session.railRegistryVersion,
    finalisedAt: session.finalisedAt,
  }) as unknown as FaultAttestationBundle;

  const signers = availableSigners.map(({ party }) => party);
  const roles: BundleAnchorRole[] = singlePartyAbort
    ? [singleSignerRole!]
    : [
        "buyer",
        "seller",
        ...(orchestrator ? (["orchestrator"] as const) : []),
      ];

  const copy = async (role: BundleAnchorRole): Promise<FaultAttestationBundle> => {
    const body = bodyFor(role);
    // This is an in-memory signing draft, not a protocol artifact: §10.4.1
    // requires signatures on the published FaultAttestationBundle. Hash the
    // exact unsigned scope, attach signatures, then validate the final record.
    const candidate = { ...body, anchoredByRole: role } as FaultAttestationBundle;
    const hash = attestationBundleHash(candidate);
    const signatures: BundleSignature[] = [];
    for (const signer of signers) signatures.push(await signOver(signer, hash));
    const signed = { ...candidate, signatures };
    if (!isFaultAttestationBundle(signed)) {
      throw new DacsError("session facts do not form a valid FaultAttestationBundle");
    }
    return signed;
  };

  const out: TwoSidedBundles = {};
  for (const role of roles) {
    const bundle = await copy(role);
    if (role === "buyer") out.buyerCopy = bundle;
    if (role === "seller") out.sellerCopy = bundle;
    if (role === "orchestrator") out.orchestratorCopy = bundle;
  }
  return out;
}

export interface EvidenceBoundTwoSidedSession
  extends Omit<TwoSidedSession, "faultBundleVersion" | "phaseSummary"> {
  evidenceBoundFaultBundleVersion?: "1";
  phaseSummary: EvidenceBoundPhaseSummaryEntry[];
}

export interface EvidenceBoundTwoSidedBundles {
  buyerCopy?: EvidenceBoundFaultAttestationBundle;
  sellerCopy?: EvidenceBoundFaultAttestationBundle;
  orchestratorCopy?: EvidenceBoundFaultAttestationBundle;
}

export interface EvidenceBoundBundleProducerDeps {
  /**
   * Validate the signed candidate against independently authenticated SEB
   * inputs supplied by the producer's closure. Returning anything other than
   * verified refuses production. Publication still remains in `audit-pending`
   * until the completed bundle itself passes ST-11 finality/resolvability.
   */
  validateEvidenceSet: (
    bundle: Readonly<EvidenceBoundFaultAttestationBundle>,
  ) => Promise<{ decision: "verified" | "rejected" | "indeterminate"; reason?: string }>;
}

/**
 * Produce v0.4 EBFAB perspective copies through the established v0.3 session
 * guards, then re-domain-sign the structurally distinct artifact and require
 * the producer's complete SEB gate. No FAB signature or discriminator is
 * retained, so cross-type replay is impossible.
 */
export async function buildEvidenceBoundTwoSidedBundle(
  session: EvidenceBoundTwoSidedSession,
  deps: EvidenceBoundBundleProducerDeps,
): Promise<EvidenceBoundTwoSidedBundles> {
  if (
    session.evidenceBoundFaultBundleVersion !== undefined &&
    session.evidenceBoundFaultBundleVersion !== "1"
  ) {
    throw new DacsError("only evidenceBoundFaultBundleVersion \"1\" is supported");
  }
  if (!deps || typeof deps !== "object" || nodeTypes.isProxy(deps)) {
    throw new DacsError("EBFAB production requires stable producer dependencies");
  }
  const validatorDescriptor = Object.getOwnPropertyDescriptor(
    deps,
    "validateEvidenceSet",
  );
  if (
    !validatorDescriptor ||
    !("value" in validatorDescriptor) ||
    typeof validatorDescriptor.value !== "function" ||
    nodeTypes.isProxy(validatorDescriptor.value)
  ) {
    throw new DacsError("EBFAB production requires validateEvidenceSet");
  }
  const validateEvidenceSet = validatorDescriptor.value.bind(deps) as
    EvidenceBoundBundleProducerDeps["validateEvidenceSet"];
  const fabCopies = await buildTwoSidedBundle({
    ...session,
    faultBundleVersion: "1",
  });
  const partyByClaim = new Map<string, SigningSessionParty>();
  for (const party of [session.buyer, session.seller, session.orchestrator]) {
    if (party && canSign(party)) partyByClaim.set(party.primaryClaim, party);
  }
  const convert = async (
    fab: FaultAttestationBundle | undefined,
  ): Promise<EvidenceBoundFaultAttestationBundle | undefined> => {
    if (!fab) return undefined;
    const {
      faultBundleVersion: _discardVersion,
      signatures: oldSignatures,
      ...fields
    } = fab;
    const candidate = {
      evidenceBoundFaultBundleVersion: "1",
      ...fields,
      signatures: [] as BundleSignature[],
    } as EvidenceBoundFaultAttestationBundle;
    const hash = attestationBundleHash(candidate);
    const signatures: BundleSignature[] = [];
    for (const old of oldSignatures) {
      const party = partyByClaim.get(old.party);
      if (!party) throw new DacsError(`no EBFAB signer is available for ${old.party}`);
      signatures.push(
        await signOver(
          party,
          hash,
          ARTIFACT_SEPARATORS.EvidenceBoundFaultAttestationBundle,
        ),
      );
    }
    const signed = { ...candidate, signatures };
    if (!isEvidenceBoundFaultAttestationBundle(signed)) {
      throw new DacsError("session facts do not form a valid EvidenceBoundFaultAttestationBundle");
    }
    let verdict: { decision: "verified" | "rejected" | "indeterminate"; reason?: string };
    try {
      verdict = snapshotCanonicalJsonRead(
        await validateEvidenceSet(structuredClone(signed)),
        "EBFAB producer exact-set verdict",
      ) as typeof verdict;
    } catch {
      throw new DacsError("EBFAB producer exact-set validation failed");
    }
    if (verdict?.decision !== "verified") {
      throw new DacsError(
        `EBFAB producer exact-set validation ${verdict?.decision ?? "failed"}: ${verdict?.reason ?? "no reason"}`,
      );
    }
    return signed;
  };
  return {
    buyerCopy: await convert(fabCopies.buyerCopy),
    sellerCopy: await convert(fabCopies.sellerCopy),
    orchestratorCopy: await convert(fabCopies.orchestratorCopy),
  };
}
