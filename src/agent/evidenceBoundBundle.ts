import { types as nodeTypes } from "node:util";

import { contentHash, paymentEvidenceAddress, stripSignature } from "../canonical/index.js";
import { canonicalize } from "../canonical/jcs.js";
import { snapshotCanonicalJsonRead } from "../canonical/snapshot.js";
import {
  ARTIFACT_SEPARATORS,
  BUNDLE_BINDING_SEPARATOR,
  EVIDENCE_BOUND_FAULT_BUNDLE_POINTER_SEPARATOR,
  FAULT_BUNDLE_POINTER_SEPARATOR,
} from "../artifacts/registry.js";
import {
  isCanonicalBase64Url,
  isComponentSignature,
} from "../artifacts/signatures.js";
import type {
  AttestationRef,
  BundleBinding,
  BundlePartyRole,
  EvidenceBoundFaultAttestationBundle,
  EvidenceBoundFaultBundleExtendedPointer,
  FaultAttestationBundle,
  FaultBundleExtendedPointer,
  PhaseStep,
  SettlementEvidence,
} from "../artifacts/types.js";
import {
  faultedPartyIsPermitted,
  isAttestationRef,
  isBundleBinding,
  isEvidenceBoundFaultAttestationBundle,
  isEvidenceBoundFaultBundleExtendedPointer,
  isFaultAttestationBundle,
  isFaultBundleExtendedPointer,
  isListingDraft,
  isSettlementEvidence,
} from "../artifacts/validators.js";
import { signedBytes } from "../crypto/signing.js";
import { DacsError } from "../errors.js";
import {
  parseCanonicalClaimReference,
  sameCanonicalClaimIdentity,
} from "../identity/claimReference.js";
import { attestationBundleHash, bundleSignedScope } from "./twoSidedBundle.js";
import type { Verifier } from "./signedArtifact.js";
import {
  authenticatedAlternativePaymentEffectivePipeline,
  type AlternativePaymentProjection,
} from "../rails/payAlternative.js";

const EVIDENCE_PHASES = new Set([
  "pay-evm-erc20",
  "pay-solana-spl",
  "pay-cross-chain-htlc",
  "pay-cross-chain-liquidity-tank",
  "pay-ap2",
  "pay-x402",
  "pay-dem",
  "deliver-storage-program",
  "deliver-entitlement",
  "deliver-attested-payload",
]);
const SUPPORTED_PHASES = new Set([
  "vet-credentials",
  "negotiate-fixed-price",
  "negotiate-rfq",
  "negotiate-sealed-envelope",
  "negotiate-sealed-envelope-procurement",
  "commit-agreement",
  "commit-payee-bound-agreement",
  "pay-alternative",
  "rate",
  ...EVIDENCE_PHASES,
]);
const CROSS_CHAIN_REASONS = Object.freeze({
  "pay-cross-chain-htlc": "dest-revealed-source-unclaimed",
  "pay-cross-chain-liquidity-tank": "tank-locked-unreleased",
} as const);

export type EvidenceBoundReasonCode =
  | "ok"
  | "execution-authority"
  | "raw-multiplicity"
  | "st8-raw-admissibility"
  | "exact-phase-mapping"
  | "lifecycle-gate"
  | "exact-cardinality"
  | "exact-bijection"
  | "pointer-agreement"
  | "unrelated-authority-indeterminate";

export interface EvidenceLifecycle {
  state: "submitted" | "accepted" | "included" | "finalized";
  independentlyResolvable?: boolean;
}

export interface EvidencePhaseExecutionAuthority {
  jobId: string;
  phaseIndex: number;
  phaseKind: string;
  phaseOrchestrator: string;
  railId?: string;
  evidenceLogicalAddress?: string;
}

export interface EvidenceAnchorReceiptAuthority {
  logicalAddress: string;
  nativeAddress: string;
  contentHash: string;
  transaction: string;
  writer: string;
  nonce: number;
}

export interface ResolvedEvidenceAuthority {
  record: SettlementEvidence;
  lifecycle: EvidenceLifecycle;
}

export interface EvidenceBoundBundleAuthority {
  bundle: EvidenceBoundFaultAttestationBundle;
  listing: Record<string, unknown>;
  /** Canonical AttestationRef JSON -> exact signed record plus lifecycle. */
  referenceValidationByCanonicalRef: Record<string, ResolvedEvidenceAuthority>;
  bundleLifecycle: EvidenceLifecycle;
  /** `${phaseIndex}:${phaseKind}` -> independently authenticated SB-1 authority. */
  sessionExecutionAuthorityByPhaseKey: Record<string, EvidencePhaseExecutionAuthority>;
  /** Canonical AttestationRef JSON -> independently verified SR-2 receipt. */
  verifiedReceiptByCanonicalRef: Record<string, EvidenceAnchorReceiptAuthority>;
  /**
   * Required when the signed Listing contains `pay-alternative`. The object
   * must be the authenticated, Agreement-bound projection minted by the SDK's
   * APR gate; a caller-created effective pipeline has no authority.
   */
  alternativePaymentProjection?: AlternativePaymentProjection;
}

export interface EvidenceBoundBundleVerifierDeps {
  resolvePublicKey: (claim: string) => Promise<Uint8Array | null>;
  verify: Verifier;
}

export interface EvidenceBoundBundleVerification {
  decision: "verified" | "rejected" | "indeterminate";
  reasonCode: EvidenceBoundReasonCode;
  reason: string;
  expectedPhaseKeys?: readonly string[];
}

export interface CompactEvidenceRecord {
  jobId: string;
  phaseKey: string;
  outcome: "success" | "failure";
  reason?: string;
  supersedesEvidenceRef?: string;
}

export interface EvidenceBoundExactSetInput {
  topLevelRefs: string[];
  authenticatedRecordByRef: Record<string, CompactEvidenceRecord>;
  pointerMap: Record<string, string>;
  unrelatedAuthorityDisposition: "verified" | "indeterminate";
  referenceLifecycleByRef?: Record<string, EvidenceLifecycle>;
}

export interface VerifiedEvidenceBoundExecutionAuthority {
  readonly bundle: EvidenceBoundFaultAttestationBundle;
  readonly expectedPhaseKeys: readonly string[];
  readonly expectedOutcomeByPhaseKey: Readonly<Record<string, "success" | "failure">>;
  readonly expectedErrorClassByPhaseKey: Readonly<Record<string, string | undefined>>;
  readonly defaultReferenceLifecycle: EvidenceLifecycle;
}

const VERIFIED_AUTHORITIES = new WeakSet<object>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const safeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function canonicalRef(ref: AttestationRef): string {
  return canonicalize(ref as unknown as Record<string, unknown>);
}

function claimIdentityKey(value: unknown): string | null {
  const parsed = parseCanonicalClaimReference(value);
  return parsed === null
    ? null
    : `${parsed.identity.scheme}:${parsed.identity.identifier}`;
}

function reject(
  reasonCode: EvidenceBoundReasonCode,
  reason: string,
): EvidenceBoundBundleVerification {
  return { decision: "rejected", reasonCode, reason };
}

function snapshotWire<T>(value: T, label: string): T {
  const snapshot = snapshotCanonicalJsonRead(value, label);
  if (snapshot === null || typeof snapshot !== "object") {
    throw new DacsError(`${label} must be canonical JSON`);
  }
  return snapshot as T;
}

function captureDeps(deps: EvidenceBoundBundleVerifierDeps): EvidenceBoundBundleVerifierDeps {
  if (
    !isRecord(deps) ||
    nodeTypes.isProxy(deps) ||
    (Object.getPrototypeOf(deps) !== Object.prototype &&
      Object.getPrototypeOf(deps) !== null)
  ) {
    throw new DacsError("evidence-bound verifier dependencies must be a plain data object");
  }
  const resolveDescriptor = Object.getOwnPropertyDescriptor(deps, "resolvePublicKey");
  const verifyDescriptor = Object.getOwnPropertyDescriptor(deps, "verify");
  if (
    !resolveDescriptor ||
    !("value" in resolveDescriptor) ||
    typeof resolveDescriptor.value !== "function" ||
    nodeTypes.isProxy(resolveDescriptor.value) ||
    !verifyDescriptor ||
    !("value" in verifyDescriptor) ||
    typeof verifyDescriptor.value !== "function" ||
    nodeTypes.isProxy(verifyDescriptor.value)
  ) {
    throw new DacsError("evidence-bound verifier callbacks must be own non-Proxy functions");
  }
  const resolve = resolveDescriptor.value.bind(deps) as EvidenceBoundBundleVerifierDeps["resolvePublicKey"];
  const verify = verifyDescriptor.value.bind(deps) as Verifier;
  return Object.freeze({
    resolvePublicKey: async (claim: string) => {
      const key = await resolve(claim);
      return key === null ? null : Uint8Array.from(key);
    },
    verify: async (
      bytes: Uint8Array,
      signature: Uint8Array,
      publicKey: Uint8Array,
    ) =>
      (await verify(
        Uint8Array.from(bytes),
        Uint8Array.from(signature),
        Uint8Array.from(publicKey),
      )) === true,
  });
}

async function verifyEd25519(
  signer: string,
  encoded: string,
  message: Uint8Array,
  deps: EvidenceBoundBundleVerifierDeps,
): Promise<"valid" | "invalid" | "indeterminate"> {
  const signerIdentity = claimIdentityKey(signer);
  if (signerIdentity === null) return "invalid";
  if (!isCanonicalBase64Url(encoded)) return "invalid";
  const signature = Uint8Array.from(Buffer.from(encoded, "base64url"));
  if (signature.length !== 64) return "invalid";
  let publicKey: Uint8Array | null;
  try {
    publicKey = await deps.resolvePublicKey(signerIdentity);
  } catch {
    return "indeterminate";
  }
  if (publicKey === null) return "indeterminate";
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) return "invalid";
  try {
    return (await deps.verify(message, signature, publicKey)) ? "valid" : "invalid";
  } catch {
    return "indeterminate";
  }
}

function bundleSignerAuthority(
  bundle: EvidenceBoundFaultAttestationBundle | FaultAttestationBundle,
): {
  required: string[];
  parties: Set<string>;
  anchor: string;
} | null {
  const byRole = new Map<string, string>();
  const parties = new Set<string>();
  for (const party of bundle.parties) {
    const identity = claimIdentityKey(party.primaryClaim);
    if (identity === null || parties.has(identity)) return null;
    parties.add(identity);
    byRole.set(party.role, identity);
  }
  const buyer = byRole.get("buyer");
  const seller = byRole.get("seller");
  const anchor = byRole.get(bundle.anchoredByRole);
  if (!buyer || !seller || !anchor) return null;
  const orchestrator = byRole.get("orchestrator");
  return {
    required: orchestrator ? [buyer, seller, orchestrator] : [buyer, seller],
    parties,
    anchor,
  };
}

async function verifyBundleSignatures(
  bundle: EvidenceBoundFaultAttestationBundle | FaultAttestationBundle,
  deps: EvidenceBoundBundleVerifierDeps,
): Promise<"valid" | "invalid" | "indeterminate"> {
  const authority = bundleSignerAuthority(bundle);
  if (!authority) return "invalid";
  const signerIdentities: string[] = [];
  for (const signature of bundle.signatures) {
    const identity = claimIdentityKey(signature.party);
    if (identity === null) return "invalid";
    signerIdentities.push(identity);
  }
  const signerSet = new Set(signerIdentities);
  const fullSet =
    bundle.signatures.length === authority.required.length &&
    signerSet.size === authority.required.length &&
    authority.required.every((signer) => signerSet.has(signer));
  const singleSignedAbort =
    (bundle.outcome === "aborted-by-self" || bundle.outcome === "aborted-by-other") &&
    bundle.signatures.length === 1 &&
    signerSet.size === 1 &&
    signerSet.has(authority.anchor);
  if (!fullSet && !singleSignedAbort) return "invalid";
  const seen = new Set<string>();
  const message = signedBytes(
    "evidenceBoundFaultBundleVersion" in bundle
      ? ARTIFACT_SEPARATORS.EvidenceBoundFaultAttestationBundle
      : ARTIFACT_SEPARATORS.FaultAttestationBundle,
    attestationBundleHash(bundle),
  );
  let uncertain = false;
  for (let index = 0; index < bundle.signatures.length; index += 1) {
    const signature = bundle.signatures[index]!;
    const identity = signerIdentities[index]!;
    if (
      signature.algorithm !== "ed25519" ||
      !authority.parties.has(identity) ||
      seen.has(identity)
    ) return "invalid";
    seen.add(identity);
    const verdict = await verifyEd25519(signature.party, signature.value, message, deps);
    if (verdict === "invalid") return "invalid";
    if (verdict === "indeterminate") uncertain = true;
  }
  return uncertain ? "indeterminate" : "valid";
}

function listingScopeAndSigner(listing: Record<string, unknown>): {
  scope: Record<string, unknown>;
  signer: string;
  signatureValue: string;
  pipeline: Array<Record<string, unknown> & { kind: string }>;
} | null {
  const signature = listing.signature;
  const pipeline = listing.pipeline;
  const scope = stripSignature(listing);
  const normativeSeller = isListingDraft(scope)
    ? scope.seller.identity.presentedBy
    : null;
  const compactSeller = typeof listing.sellerPrimaryClaim === "string"
    ? listing.sellerPrimaryClaim
    : null;
  const seller = normativeSeller ?? compactSeller;
  const sellerIdentity = claimIdentityKey(seller);
  const signerIdentity = isComponentSignature(signature)
    ? claimIdentityKey(signature.signer)
    : null;
  if (
    !isComponentSignature(signature) ||
    signature.algorithm !== "ed25519" ||
    typeof listing.listingId !== "string" ||
    !safeInteger(listing.listingVersion) ||
    listing.listingVersion < 1 ||
    sellerIdentity === null ||
    signerIdentity !== sellerIdentity ||
    !Array.isArray(pipeline) ||
    pipeline.some(
      (step) =>
        !isRecord(step) ||
        typeof step.kind !== "string" ||
        !SUPPORTED_PHASES.has(step.kind),
    )
  ) return null;
  return {
    scope,
    signer: signature.signer,
    signatureValue: signature.value,
    pipeline: pipeline as Array<Record<string, unknown> & { kind: string }>,
  };
}

function deriveTrace(bundle: EvidenceBoundFaultAttestationBundle, pipeline: readonly { kind: string }[]): {
  expected: string[];
  outcomeByKey: Record<string, "success" | "failure">;
  errorByKey: Record<string, string | undefined>;
} | null {
  const summary = bundle.phaseSummary;
  const seen = new Set<number>();
  for (let position = 0; position < summary.length; position += 1) {
    const entry = summary[position]!;
    if (
      entry.index !== position ||
      seen.has(entry.index) ||
      entry.index >= pipeline.length ||
      pipeline[entry.index]?.kind !== entry.kind
    ) return null;
    seen.add(entry.index);
  }
  const retryPositions = summary
    .map((entry, index) => ("retryExhausted" in entry ? index : -1))
    .filter((index) => index >= 0);
  const terminal = summary.at(-1);
  const retryExpected =
    bundle.outcome === "failed-perm" &&
    terminal?.outcome === "fail" &&
    terminal.errorClass === "transient";
  if (
    (retryExpected &&
      (retryPositions.length !== 1 ||
        retryPositions[0] !== summary.length - 1 ||
        terminal?.retryExhausted !== true)) ||
    (!retryExpected && retryPositions.length > 0)
  ) return null;

  const okPrefixThen = (classes: readonly string[]) =>
    terminal?.outcome === "fail" &&
    classes.includes(terminal.errorClass ?? "") &&
    summary.slice(0, -1).every((entry) => entry.outcome === "ok");
  if (bundle.outcome === "completed") {
    if (
      summary.length !== pipeline.length ||
      summary.some((entry) => entry.outcome === "fail" && entry.kind !== "rate")
    ) return null;
  } else if (bundle.outcome === "failed-perm") {
    if (!okPrefixThen(["permanent", "transient"])) return null;
  } else if (bundle.outcome === "failed-counterparty") {
    if (!okPrefixThen(["counterparty", "settlement-atomicity"])) return null;
  } else if (bundle.outcome === "failed-substrate") {
    const phaseFailure = okPrefixThen(["substrate"]);
    const auditFailure =
      summary.length === pipeline.length &&
      summary.every((entry) => entry.outcome === "ok" || (entry.kind === "rate" && entry.outcome === "fail"));
    if (!phaseFailure && !auditFailure) return null;
  } else if (
    bundle.outcome === "aborted-by-self" ||
    bundle.outcome === "aborted-by-other"
  ) {
    if (summary.length >= pipeline.length || summary.some((entry) => entry.outcome !== "ok")) {
      return null;
    }
  } else return null;

  const expected: string[] = [];
  const outcomeByKey: Record<string, "success" | "failure"> = {};
  const errorByKey: Record<string, string | undefined> = {};
  for (const entry of summary) {
    if (!EVIDENCE_PHASES.has(entry.kind)) continue;
    const key = `${entry.index}:${entry.kind}`;
    expected.push(key);
    outcomeByKey[key] = entry.outcome === "ok" ? "success" : "failure";
    errorByKey[key] = entry.errorClass;
  }
  return { expected, outcomeByKey, errorByKey };
}

function lifecyclePasses(lifecycle: unknown, completed: boolean): boolean {
  if (
    !isRecord(lifecycle) ||
    !["submitted", "accepted", "included", "finalized"].includes(
      lifecycle.state as string,
    ) ||
    (lifecycle.independentlyResolvable !== undefined &&
      typeof lifecycle.independentlyResolvable !== "boolean")
  ) return false;
  return completed
    ? lifecycle.state === "finalized" && lifecycle.independentlyResolvable === true
    : lifecycle.state === "included" || lifecycle.state === "finalized";
}

function receiptMatches(
  ref: AttestationRef,
  receipt: EvidenceAnchorReceiptAuthority,
  execution: EvidencePhaseExecutionAuthority,
  record: SettlementEvidence,
  bundle: EvidenceBoundFaultAttestationBundle,
  resolved: boolean,
): boolean {
  if (
    execution.jobId !== bundle.jobId ||
    execution.phaseKind !== record.phase ||
    !sameCanonicalClaimIdentity(
      execution.phaseOrchestrator,
      record.signature.signer,
    ) ||
    !safeInteger(execution.phaseIndex) ||
    receipt.nativeAddress !== ref.anchor.locator ||
    receipt.contentHash !== ref.contentHash ||
    typeof receipt.transaction !== "string" ||
    receipt.transaction.length === 0 ||
    !sameCanonicalClaimIdentity(receipt.writer, record.signature.signer) ||
    !safeInteger(receipt.nonce)
  ) return false;
  let expectedAddress: string;
  if (record.phase.startsWith("pay-")) {
    if (typeof execution.railId !== "string" || execution.railId.length === 0) return false;
    try {
      expectedAddress = paymentEvidenceAddress(
        bundle.jobId,
        execution.railId,
        execution.phaseIndex,
        resolved,
      );
    } catch {
      return false;
    }
  } else {
    if (resolved || typeof execution.evidenceLogicalAddress !== "string" ||
      execution.evidenceLogicalAddress.length === 0) return false;
    expectedAddress = execution.evidenceLogicalAddress;
  }
  return receipt.logicalAddress === expectedAddress;
}

function resolvePhaseBinding(
  ref: AttestationRef,
  record: SettlementEvidence,
  bundle: EvidenceBoundFaultAttestationBundle,
  executions: Readonly<Record<string, EvidencePhaseExecutionAuthority>>,
  receipts: Readonly<Record<string, EvidenceAnchorReceiptAuthority>>,
): { phaseKey: string; resolved: boolean } | null {
  const receipt = receipts[canonicalRef(ref)];
  if (!receipt) return null;
  const matches: Array<{ phaseKey: string; resolved: boolean }> = [];
  for (const [phaseKey, execution] of Object.entries(executions)) {
    if (
      !isRecord(execution) ||
      !safeInteger(execution.phaseIndex) ||
      phaseKey !== `${execution.phaseIndex}:${execution.phaseKind}` ||
      execution.jobId !== bundle.jobId ||
      execution.phaseKind !== record.phase ||
      !sameCanonicalClaimIdentity(
        execution.phaseOrchestrator,
        record.signature.signer,
      )
    ) continue;
    const classes =
      (record.phase === "pay-cross-chain-htlc" ||
        record.phase === "pay-cross-chain-liquidity-tank") &&
      record.outcome === "success"
        ? [false, true]
        : [false];
    for (const resolved of classes) {
      if (receiptMatches(ref, receipt, execution, record, bundle, resolved)) {
        matches.push({ phaseKey, resolved });
      }
    }
  }
  return matches.length === 1 ? matches[0]! : null;
}

async function verifyEvidenceRecord(
  ref: AttestationRef,
  record: SettlementEvidence,
  bundle: EvidenceBoundFaultAttestationBundle,
  deps: EvidenceBoundBundleVerifierDeps,
): Promise<"valid" | "invalid" | "indeterminate"> {
  if (
    !isSettlementEvidence(record) ||
    record.jobId !== bundle.jobId ||
    contentHash(stripSignature(record as unknown as Record<string, unknown>)) !== ref.contentHash ||
    record.signature.algorithm !== "ed25519"
  ) return "invalid";
  return verifyEd25519(
    record.signature.signer,
    record.signature.value,
    signedBytes(
      ARTIFACT_SEPARATORS.SettlementEvidence,
      ref.contentHash,
    ),
    deps,
  );
}

async function knownAuthenticatedSuccessor(
  interimRef: AttestationRef,
  interim: SettlementEvidence,
  phaseKey: string,
  authority: EvidenceBoundBundleAuthority,
  deps: EvidenceBoundBundleVerifierDeps,
): Promise<"known" | "absent" | "indeterminate"> {
  const interimCanonical = canonicalRef(interimRef);
  let uncertain = false;
  for (const [candidateRefJson, resolution] of Object.entries(
    authority.referenceValidationByCanonicalRef,
  )) {
    if (!isRecord(resolution)) continue;
    let candidateRef: unknown;
    try {
      candidateRef = JSON.parse(candidateRefJson);
    } catch {
      continue;
    }
    if (!isAttestationRef(candidateRef) || !isRecord(resolution.record)) continue;
    const candidate = resolution.record as unknown as SettlementEvidence;
    if (
      !isSettlementEvidence(candidate) ||
      candidate.jobId !== interim.jobId ||
      candidate.phase !== interim.phase ||
      candidate.outcome !== "success" ||
      !candidate.supersedesEvidenceRef ||
      canonicalRef(candidate.supersedesEvidenceRef) !== interimCanonical
    ) continue;
    const signature = await verifyEvidenceRecord(
      candidateRef,
      candidate,
      authority.bundle,
      deps,
    );
    if (signature === "indeterminate") {
      uncertain = true;
      continue;
    }
    if (signature === "invalid") continue;
    const binding = resolvePhaseBinding(
      candidateRef,
      candidate,
      authority.bundle,
      authority.sessionExecutionAuthorityByPhaseKey,
      authority.verifiedReceiptByCanonicalRef,
    );
    if (
      binding?.phaseKey === phaseKey &&
      binding.resolved &&
      lifecyclePasses(resolution.lifecycle as EvidenceLifecycle, false)
    ) return "known";
  }
  return uncertain ? "indeterminate" : "absent";
}

/**
 * Validate one complete DACS-5 v0.4 authority graph. The expected phase set is
 * derived only after the EBFAB and Listing signatures verify; callers cannot
 * provide it, phase labels, or ST-8 classification as trusted inputs.
 */
export async function verifyEvidenceBoundFaultBundle(
  input: EvidenceBoundBundleAuthority,
  callerDeps: EvidenceBoundBundleVerifierDeps,
): Promise<EvidenceBoundBundleVerification & { authority?: VerifiedEvidenceBoundExecutionAuthority }> {
  const deps = captureDeps(callerDeps);
  let authority: EvidenceBoundBundleAuthority;
  let alternativePaymentProjection: AlternativePaymentProjection | undefined;
  try {
    if (!isRecord(input) || nodeTypes.isProxy(input)) {
      throw new DacsError("authority must be a plain data object");
    }
    const projectionDescriptor = Object.getOwnPropertyDescriptor(
      input,
      "alternativePaymentProjection",
    );
    if (projectionDescriptor && !("value" in projectionDescriptor)) {
      throw new DacsError("alternative-payment projection must be stable data");
    }
    alternativePaymentProjection = projectionDescriptor?.value as
      | AlternativePaymentProjection
      | undefined;
    authority = snapshotWire(input, "evidence-bound bundle authority");
  } catch {
    return reject("execution-authority", "authority is not inert canonical JSON");
  }
  const bundle = authority.bundle;
  if (
    !isEvidenceBoundFaultAttestationBundle(bundle) ||
    !faultedPartyIsPermitted(bundle as unknown as Record<string, unknown>) ||
    !isRecord(authority.listing) ||
    !isRecord(authority.referenceValidationByCanonicalRef) ||
    !isRecord(authority.sessionExecutionAuthorityByPhaseKey) ||
    !isRecord(authority.verifiedReceiptByCanonicalRef)
  ) {
    return reject("execution-authority", "malformed or non-exclusive EBFAB");
  }
  const bundleSignatures = await verifyBundleSignatures(bundle, deps);
  if (bundleSignatures === "invalid") {
    return reject("execution-authority", "EBFAB signature set is invalid");
  }
  if (bundleSignatures === "indeterminate") {
    return {
      decision: "indeterminate",
      reasonCode: "unrelated-authority-indeterminate",
      reason: "an EBFAB signer key is unavailable",
    };
  }
  const listing = listingScopeAndSigner(authority.listing);
  if (!listing) {
    return reject("execution-authority", "signed Listing authority is malformed or unsupported");
  }
  const listingHash = contentHash(listing.scope);
  if (
    bundle.listingRef.listingId !== authority.listing.listingId ||
    bundle.listingRef.version !== authority.listing.listingVersion ||
    bundle.listingRef.contentHash !== listingHash
  ) return reject("execution-authority", "listingRef does not bind the signed Listing");
  const listingSignature = await verifyEd25519(
    listing.signer,
    listing.signatureValue,
    signedBytes(ARTIFACT_SEPARATORS.Listing, listingHash),
    deps,
  );
  if (listingSignature === "invalid") {
    return reject("execution-authority", "Listing signature is invalid");
  }
  if (listingSignature === "indeterminate") {
    return {
      decision: "indeterminate",
      reasonCode: "unrelated-authority-indeterminate",
      reason: "Listing signer key is unavailable",
    };
  }
  let effectivePipeline: readonly { kind: string }[] = listing.pipeline;
  if (listing.pipeline.some((phase) => phase.kind === "pay-alternative")) {
    if (alternativePaymentProjection === undefined) {
      return {
        decision: "indeterminate",
        reasonCode: "unrelated-authority-indeterminate",
        reason: "authenticated alternative-payment projection is unavailable",
      };
    }
    const projected = authenticatedAlternativePaymentEffectivePipeline(
      alternativePaymentProjection,
      bundle.listingRef,
    );
    if (!projected) {
      return reject(
        "execution-authority",
        "alternative-payment projection is not SDK-authenticated or does not bind this Listing",
      );
    }
    if (
      projected.length !== listing.pipeline.length ||
      projected.some((phase, index) => {
        const listed = listing.pipeline[index];
        return (
          !listed ||
          (listed.kind === "pay-alternative"
            ? !phase.kind.startsWith("pay-") || phase.kind === "pay-alternative"
            : canonicalize(phase as unknown as Record<string, unknown>) !==
              canonicalize(listed))
        );
      })
    ) {
      return reject(
        "execution-authority",
        "authenticated effective pipeline changes a non-alternative Listing step",
      );
    }
    effectivePipeline = projected as readonly PhaseStep[];
  }
  const trace = deriveTrace(bundle, effectivePipeline);
  if (!trace) return reject("execution-authority", "phaseSummary is not an outcome-consistent signed pipeline trace");

  const rawRefs = bundle.settlementEvidence;
  const rawIds = rawRefs.map(canonicalRef);
  if (new Set(rawIds).size !== rawIds.length) {
    return reject("raw-multiplicity", "settlementEvidence contains a raw duplicate");
  }
  const pointerIds = bundle.phaseSummary
    .filter((entry) => EVIDENCE_PHASES.has(entry.kind) && entry.attestationRef)
    .map((entry) => canonicalRef(entry.attestationRef!));
  const rawPointerContradiction =
    new Set(pointerIds).size !== pointerIds.length ||
    pointerIds.some((pointer) => !rawIds.includes(pointer));

  const authenticated: Array<{
    ref: AttestationRef;
    record: SettlementEvidence;
    lifecycle: EvidenceLifecycle;
    phaseKey: string;
    resolved: boolean;
  }> = [];
  let referenceUncertainty = false;
  for (let index = 0; index < rawRefs.length; index += 1) {
    const ref = rawRefs[index]!;
    const resolution = authority.referenceValidationByCanonicalRef[rawIds[index]!];
    if (!resolution || !isRecord(resolution) || !isRecord(resolution.record)) {
      referenceUncertainty = true;
      continue;
    }
    const record = resolution.record as unknown as SettlementEvidence;
    const signature = await verifyEvidenceRecord(ref, record, bundle, deps);
    if (signature === "invalid") {
      return reject("exact-phase-mapping", "SettlementEvidence shape, hash, job, or signature is invalid");
    }
    if (signature === "indeterminate") {
      referenceUncertainty = true;
      continue;
    }
    const binding = resolvePhaseBinding(
      ref,
      record,
      bundle,
      authority.sessionExecutionAuthorityByPhaseKey,
      authority.verifiedReceiptByCanonicalRef,
    );
    if (!binding || !trace.expected.includes(binding.phaseKey)) {
      return reject("exact-phase-mapping", "evidence does not resolve to exactly one expected authenticated phase");
    }
    if (record.outcome !== trace.outcomeByKey[binding.phaseKey]) {
      return reject("st8-raw-admissibility", "evidence outcome contradicts the signed phase result");
    }
    authenticated.push({
      ref,
      record,
      lifecycle: resolution.lifecycle as EvidenceLifecycle,
      phaseKey: binding.phaseKey,
      resolved: binding.resolved,
    });
  }

  const topLevelIds = new Set(rawIds);
  const allSt8Reasons = new Set<string>(Object.values(CROSS_CHAIN_REASONS));
  for (const member of authenticated) {
    const expectedReason = CROSS_CHAIN_REASONS[
      member.record.phase as keyof typeof CROSS_CHAIN_REASONS
    ];
    const errorClass = trace.errorByKey[member.phaseKey];
    const expired =
      (member.record.phase === "pay-cross-chain-htlc" &&
        errorClass === "settlement-atomicity") ||
      (member.record.phase === "pay-cross-chain-liquidity-tank" &&
        errorClass === "substrate" &&
        member.record.reason === expectedReason);
    if (expired) {
      if (
        member.record.outcome !== "failure" ||
        member.record.reason !== expectedReason ||
        member.record.supersedesEvidenceRef !== undefined ||
        member.resolved
      ) return reject("st8-raw-admissibility", "expired ST-8 record has the wrong terminal form");
      const successor = await knownAuthenticatedSuccessor(
        member.ref,
        member.record,
        member.phaseKey,
        authority,
        deps,
      );
      if (successor === "known") {
        return reject("st8-raw-admissibility", "expired ST-8 record suppresses a known authenticated successor");
      }
      if (successor === "indeterminate") referenceUncertainty = true;
    } else if (member.record.reason && allSt8Reasons.has(member.record.reason)) {
      return reject("st8-raw-admissibility", "ST-8 interim reason contradicts the signed phase result");
    }
    const supersedes = member.record.supersedesEvidenceRef;
    if (
      member.resolved &&
      (member.record.outcome !== "success" || !expectedReason || !supersedes)
    ) return reject("st8-raw-admissibility", "resolved ST-8 record lacks its signed supersession edge");
    if (supersedes && !member.resolved) {
      return reject("st8-raw-admissibility", "supersession edge is not bound at the exact resolved address");
    }
    if (!supersedes) continue;
    const interimId = canonicalRef(supersedes);
    if (topLevelIds.has(interimId)) {
      return reject("st8-raw-admissibility", "superseded interim evidence is also top-level");
    }
    const interimResolution = authority.referenceValidationByCanonicalRef[interimId];
    if (!interimResolution || !isRecord(interimResolution.record)) {
      referenceUncertainty = true;
      continue;
    }
    const interim = interimResolution.record as unknown as SettlementEvidence;
    const interimSignature = await verifyEvidenceRecord(
      supersedes,
      interim,
      bundle,
      deps,
    );
    if (
      !isSettlementEvidence(interim) ||
      interim.jobId !== bundle.jobId ||
      interim.phase !== member.record.phase ||
      interim.outcome !== "failure" ||
      interim.reason !== expectedReason ||
      interimSignature === "invalid"
    ) return reject("st8-raw-admissibility", "ST-8 interim dependency does not authenticate");
    if (interimSignature === "indeterminate") {
      referenceUncertainty = true;
      continue;
    }
    const interimBinding = resolvePhaseBinding(
      supersedes,
      interim,
      bundle,
      authority.sessionExecutionAuthorityByPhaseKey,
      authority.verifiedReceiptByCanonicalRef,
    );
    if (interimBinding?.phaseKey !== member.phaseKey || interimBinding.resolved) {
      return reject("st8-raw-admissibility", "ST-8 interim binds a different phase or address class");
    }
    if (!lifecyclePasses(interimResolution.lifecycle, bundle.outcome === "completed")) {
      return reject("lifecycle-gate", "ST-8 interim dependency fails its lifecycle gate");
    }
  }

  const completed = bundle.outcome === "completed";
  if (authenticated.some((member) => !lifecyclePasses(member.lifecycle, completed))) {
    return reject("lifecycle-gate", "SettlementEvidence fails its included/finalized lifecycle gate");
  }
  if (!lifecyclePasses(authority.bundleLifecycle, completed)) {
    return reject("lifecycle-gate", "EBFAB fails its included/finalized lifecycle gate");
  }
  if (rawRefs.length !== trace.expected.length) {
    return reject("exact-cardinality", "settlementEvidence cardinality differs from the derived phase set");
  }
  const actualKeys = authenticated.map((member) => member.phaseKey);
  if (
    actualKeys.length !== rawRefs.length ||
    new Set(actualKeys).size !== actualKeys.length ||
    trace.expected.some((key) => !actualKeys.includes(key))
  ) {
    if (referenceUncertainty) {
      if (rawPointerContradiction) {
        return reject(
          "pointer-agreement",
          "an optional phase pointer deterministically contradicts the signed raw array",
        );
      }
      return {
        decision: "indeterminate",
        reasonCode: "unrelated-authority-indeterminate",
        reason: "a required exact evidence resolution or signer key is unavailable",
      };
    }
    return reject("exact-bijection", "settlementEvidence is not a duplicate-free exact phase bijection");
  }
  const refByKey = new Map(authenticated.map((member) => [member.phaseKey, canonicalRef(member.ref)]));
  for (const entry of bundle.phaseSummary) {
    if (!EVIDENCE_PHASES.has(entry.kind) || !entry.attestationRef) continue;
    const key = `${entry.index}:${entry.kind}`;
    if (canonicalRef(entry.attestationRef) !== refByKey.get(key)) {
      return reject("pointer-agreement", "optional phase pointer contradicts the top-level exact member");
    }
  }
  if (referenceUncertainty) {
    return {
      decision: "indeterminate",
      reasonCode: "unrelated-authority-indeterminate",
      reason: "otherwise-consistent required authority is unavailable",
    };
  }
  const verifiedAuthority = Object.freeze({
    bundle: structuredClone(bundle),
    expectedPhaseKeys: Object.freeze([...trace.expected]),
    expectedOutcomeByPhaseKey: Object.freeze({ ...trace.outcomeByKey }),
    expectedErrorClassByPhaseKey: Object.freeze({ ...trace.errorByKey }),
    defaultReferenceLifecycle: Object.freeze({
      state: completed ? "finalized" as const : "included" as const,
      independentlyResolvable: completed,
    }),
  });
  VERIFIED_AUTHORITIES.add(verifiedAuthority);
  return {
    decision: "verified",
    reasonCode: "ok",
    reason: "EBFAB signatures, authority, evidence bijection, ST-8, and lifecycle verified",
    expectedPhaseKeys: verifiedAuthority.expectedPhaseKeys,
    authority: verifiedAuthority,
  };
}

/**
 * Candidate-vector projection of SEB-2..SEB-6. It accepts only an authority
 * object produced by {@link verifyEvidenceBoundFaultBundle}; a caller-created
 * object containing plausible phase keys has no standing.
 */
export function evaluateEvidenceBoundSettlementSet(
  authority: VerifiedEvidenceBoundExecutionAuthority,
  rawInput: EvidenceBoundExactSetInput,
): EvidenceBoundBundleVerification {
  if (!VERIFIED_AUTHORITIES.has(authority as object)) {
    return reject("execution-authority", "execution authority was not produced by the SDK verifier");
  }
  let input: EvidenceBoundExactSetInput;
  try {
    input = snapshotWire(rawInput, "evidence-bound exact-set input");
  } catch {
    return reject("exact-phase-mapping", "exact-set input is not inert canonical JSON");
  }
  const refs = input.topLevelRefs;
  const records = input.authenticatedRecordByRef;
  const pointers = input.pointerMap;
  if (
    !Array.isArray(refs) || refs.some((ref) => typeof ref !== "string") ||
    !isRecord(records) || !isRecord(pointers)
  ) return reject("exact-phase-mapping", "exact-set projection has an invalid shape");
  if (refs.length !== new Set(refs).size) {
    return reject("raw-multiplicity", "raw top-level references are not duplicate-free");
  }
  const st8Reasons = CROSS_CHAIN_REASONS as Readonly<Record<string, string>>;
  for (const successor of refs) {
    const record = records[successor];
    if (!isRecord(record)) continue;
    const interimId = record.supersedesEvidenceRef;
    if (typeof interimId !== "string") continue;
    const interim = records[interimId];
    const phase = typeof record.phaseKey === "string"
      ? record.phaseKey.slice(record.phaseKey.indexOf(":") + 1)
      : "";
    if (
      refs.includes(interimId) ||
      record.outcome !== "success" ||
      !isRecord(interim) ||
      interim.jobId !== record.jobId ||
      interim.phaseKey !== record.phaseKey ||
      interim.outcome !== "failure" ||
      interim.reason !== st8Reasons[phase]
    ) return reject("st8-raw-admissibility", "invalid ST-8 raw successor/interim representation");
  }
  for (const ref of refs) {
    const record = records[ref];
    if (!isRecord(record) || typeof record.phaseKey !== "string") continue;
    const expectedOutcome = authority.expectedOutcomeByPhaseKey[record.phaseKey];
    if (expectedOutcome === undefined) continue;
    if (record.outcome !== expectedOutcome) {
      return reject("st8-raw-admissibility", "record outcome contradicts signed phase outcome");
    }
    const phase = record.phaseKey.slice(record.phaseKey.indexOf(":") + 1);
    const expectedReason = st8Reasons[phase];
    const error = authority.expectedErrorClassByPhaseKey[record.phaseKey];
    const expired =
      error === "settlement-atomicity" ||
      (phase === "pay-cross-chain-liquidity-tank" &&
        error === "substrate" && record.reason === expectedReason);
    if (
      (expired && record.reason !== expectedReason) ||
      (!expired && record.reason !== undefined && Object.values(st8Reasons).includes(record.reason))
    ) return reject("st8-raw-admissibility", "record has an inadmissible ST-8 terminal reason");
  }
  if (refs.some((ref) => {
    const record = records[ref];
    return !isRecord(record) ||
      record.jobId !== authority.bundle.jobId ||
      typeof record.phaseKey !== "string" ||
      !authority.expectedPhaseKeys.includes(record.phaseKey);
  })) return reject("exact-phase-mapping", "a raw member is outside the authenticated phase authority");

  const completed = authority.bundle.outcome === "completed";
  for (const ref of refs) {
    const lifecycle = input.referenceLifecycleByRef?.[ref] ?? authority.defaultReferenceLifecycle;
    if (!isRecord(lifecycle) || !lifecyclePasses(lifecycle as unknown as EvidenceLifecycle, completed)) {
      return reject("lifecycle-gate", "a raw member fails the applicable lifecycle threshold");
    }
  }
  if (refs.length !== authority.expectedPhaseKeys.length) {
    return reject("exact-cardinality", "raw member count differs from authenticated phase count");
  }
  const mapped = refs.map((ref) => records[ref]!.phaseKey);
  if (
    new Set(mapped).size !== mapped.length ||
    authority.expectedPhaseKeys.some((key) => !mapped.includes(key))
  ) return reject("exact-bijection", "raw members are not a bijection over authenticated phase keys");
  const pointerValues = Object.values(pointers);
  if (new Set(pointerValues).size !== pointerValues.length) {
    return reject("pointer-agreement", "two optional pointers reuse one member");
  }
  for (const [phaseKey, ref] of Object.entries(pointers)) {
    if (
      typeof ref !== "string" ||
      !refs.includes(ref) ||
      records[ref]?.phaseKey !== phaseKey
    ) return reject("pointer-agreement", "an optional pointer disagrees with the exact member");
  }
  if (input.unrelatedAuthorityDisposition === "indeterminate") {
    return {
      decision: "indeterminate",
      reasonCode: "unrelated-authority-indeterminate",
      reason: "exact set is consistent but unrelated required authority is unavailable",
    };
  }
  return {
    decision: "verified",
    reasonCode: "ok",
    reason: "settlement evidence is the exact authenticated phase-result set",
    expectedPhaseKeys: authority.expectedPhaseKeys,
  };
}

export interface BundlePointerVerification {
  ok: boolean;
  reason: string;
  bundleContentHash?: string;
}

/**
 * DACS-5 E7 direct/pointer triple-identity and type-domain verifier. A valid
 * EBFAB pointer additionally requires the full bundle's SEB verification token.
 * Network fetch/redirect/DNS policy is deliberately outside this pure gate.
 */
export async function verifyFaultBundleExtendedPointer(
  pointerInput: FaultBundleExtendedPointer | EvidenceBoundFaultBundleExtendedPointer,
  bundleInput: Record<string, unknown>,
  bindingInput: BundleBinding | undefined,
  callerDeps: EvidenceBoundBundleVerifierDeps,
  evidenceBoundAuthority?: VerifiedEvidenceBoundExecutionAuthority,
): Promise<BundlePointerVerification> {
  const deps = captureDeps(callerDeps);
  let pointer: Record<string, unknown>;
  let bundle: Record<string, unknown>;
  let binding: BundleBinding | undefined;
  try {
    pointer = snapshotWire(pointerInput, "fault bundle extended pointer") as unknown as Record<string, unknown>;
    bundle = snapshotWire(bundleInput, "dereferenced fault bundle");
    binding = bindingInput === undefined
      ? undefined
      : snapshotWire(bindingInput, "bundle binding");
  } catch {
    return { ok: false, reason: "pointer, bundle, and binding must be inert canonical JSON" };
  }
  const ebfabPointer = isEvidenceBoundFaultBundleExtendedPointer(pointer);
  const fabPointer = isFaultBundleExtendedPointer(pointer);
  if (!ebfabPointer && !fabPointer) return { ok: false, reason: "malformed or unsupported extended pointer" };
  if (binding !== undefined && !isBundleBinding(binding)) {
    return { ok: false, reason: "BundleBinding is malformed or self-inconsistent" };
  }
  if (
    (ebfabPointer && !isEvidenceBoundFaultAttestationBundle(bundle)) ||
    (fabPointer && !isFaultAttestationBundle(bundle))
  ) return { ok: false, reason: "pointer discriminator does not match dereferenced bundle type" };
  const dereferencedSignatures = await verifyBundleSignatures(
    bundle as unknown as EvidenceBoundFaultAttestationBundle | FaultAttestationBundle,
    deps,
  );
  if (dereferencedSignatures !== "valid") {
    return {
      ok: false,
      reason:
        dereferencedSignatures === "invalid"
          ? "dereferenced bundle signature set is invalid"
          : "dereferenced bundle signer key is unavailable",
    };
  }
  if (
    ebfabPointer &&
    (!evidenceBoundAuthority ||
      !VERIFIED_AUTHORITIES.has(evidenceBoundAuthority as object) ||
      attestationBundleHash(evidenceBoundAuthority.bundle) !==
        attestationBundleHash(bundle as unknown as EvidenceBoundFaultAttestationBundle))
  ) return { ok: false, reason: "dereferenced EBFAB lacks matching SEB-verified authority" };

  const recomputed = attestationBundleHash(bundle as never);
  if (
    pointer.fullBundleContentHash !== recomputed ||
    (binding !== undefined && binding.bundleContentHash !== recomputed)
  ) return { ok: false, reason: "pointer, binding, and dereferenced bundle hashes differ" };
  if (binding !== undefined && binding.jobId !== bundle.jobId) {
    return { ok: false, reason: "BundleBinding job does not match dereferenced bundle" };
  }
  const anchoredRole = bundle.anchoredByRole as BundlePartyRole;
  const parties = bundle.parties;
  if (!Array.isArray(parties)) return { ok: false, reason: "dereferenced bundle roster is malformed" };
  const roleClaims = parties
    .filter((party): party is Record<string, unknown> =>
      isRecord(party) && party.role === anchoredRole && typeof party.primaryClaim === "string")
    .map((party) => party.primaryClaim as string);
  const signature = pointer.signature;
  const roleIdentity = roleClaims.length === 1
    ? claimIdentityKey(roleClaims[0])
    : null;
  const pointerSignerIdentity = isComponentSignature(signature)
    ? claimIdentityKey(signature.signer)
    : null;
  if (
    roleClaims.length !== 1 ||
    !isComponentSignature(signature) ||
    signature.algorithm !== "ed25519" ||
    roleIdentity === null ||
    pointerSignerIdentity !== roleIdentity
  ) return { ok: false, reason: "pointer signer is not the unique anchoring-role holder" };
  if (binding !== undefined) {
    const bindingSignerIdentity = claimIdentityKey(binding.signer);
    const bindingSignatureIdentity = claimIdentityKey(binding.signature.signer);
    if (
      binding.role !== anchoredRole ||
      bindingSignerIdentity !== roleIdentity ||
      bindingSignatureIdentity !== roleIdentity ||
      binding.signature.algorithm !== "ed25519"
    ) return { ok: false, reason: "BundleBinding role or signer is unauthorized" };
    const bindingVerdict = await verifyEd25519(
      binding.signature.signer,
      binding.signature.value,
      signedBytes(
        BUNDLE_BINDING_SEPARATOR,
        contentHash(stripSignature(binding as unknown as Record<string, unknown>)),
      ),
      deps,
    );
    if (bindingVerdict !== "valid") {
      return {
        ok: false,
        reason:
          bindingVerdict === "invalid"
            ? "BundleBinding signature is invalid"
            : "BundleBinding signer key is unavailable",
      };
    }
  }
  const scope = stripSignature(pointer);
  const separator = ebfabPointer
    ? EVIDENCE_BOUND_FAULT_BUNDLE_POINTER_SEPARATOR
    : FAULT_BUNDLE_POINTER_SEPARATOR;
  const verdict = await verifyEd25519(
    signature.signer,
    signature.value,
    signedBytes(separator, contentHash(scope)),
    deps,
  );
  if (verdict !== "valid") {
    return { ok: false, reason: verdict === "invalid" ? "pointer signature is invalid" : "pointer signer key is unavailable" };
  }
  return { ok: true, reason: "pointer type, signature, role, and triple identity verified", bundleContentHash: recomputed };
}

/** Explicitly expose the signed scopes so producers cannot drift on omission. */
export function evidenceBoundBundleSignedScope(
  bundle: EvidenceBoundFaultAttestationBundle,
): Record<string, unknown> {
  return bundleSignedScope(bundle);
}
