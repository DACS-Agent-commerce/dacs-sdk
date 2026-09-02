import { types as nodeTypes } from "node:util";

import {
  canonicalize,
  canonicalizeDecimal,
  contentHash,
  stripSignature,
} from "../canonical/index.js";
import { snapshotCanonicalJsonRead } from "../canonical/snapshot.js";
import { DacsError } from "../errors.js";
import type {
  AgreementArtifact,
  AnyAttestationBundle,
  AttestationRef,
  BundleBinding,
  ComponentSignature,
  PaymentPhaseType,
  SettlementEvidence,
} from "../artifacts/types.js";
import {
  isAgreementArtifact,
  isAttestationRef,
  isBundleBinding,
  isSettlementEvidence,
} from "../artifacts/validators.js";
import { isComponentSignature } from "../artifacts/signatures.js";
import {
  parseCanonicalClaimReference,
  requireCanonicalClaimReference,
  sameCanonicalClaimIdentity,
} from "../identity/claimReference.js";
import { bundlesDiverge } from "./bundleDivergence.js";
import { isCanonicalSettlementIdentity } from "./settlementIdentity.js";
import {
  bundleArtifactType,
  bundleArtifactTypeRank,
  isAbsoluteFaultBundle,
  legacyImpliedFaultSet,
  scoredBundleOutcome,
} from "./bundleSemantics.js";
import type {
  ReputationMetrics,
  ReputationWindow,
} from "./reputationDerivation.js";

/** DACS-4 §9.7's closed payment-phase set. Prefix matching is forbidden. */
export const DACS4_PAYMENT_PHASE_TYPES = Object.freeze([
  "pay-evm-erc20",
  "pay-solana-spl",
  "pay-cross-chain-htlc",
  "pay-cross-chain-liquidity-tank",
  "pay-ap2",
  "pay-x402",
  "pay-dem",
] as const satisfies readonly PaymentPhaseType[]);

const PAYMENT_PHASE_SET = new Set<string>(DACS4_PAYMENT_PHASE_TYPES);
const DERIVATION_DISCRIMINATORS = Object.freeze([
  "derivationVersion",
  "replayableDerivationVersion",
  "jobBoundReplayableDerivationVersion",
  "settlementVerifiedDerivationVersion",
  "replayableSettlementVerifiedDerivationVersion",
] as const);

export type SettlementVerificationDisposition =
  | "verified"
  | "rejected"
  | "indeterminate";

export type ReputationRoleEvidence =
  | { kind: "binding"; binding: BundleBinding }
  | { kind: "address"; resolvedAddress: string };

export interface ReputationBb6Context {
  candidateBindings: BundleBinding[];
  partyMap: object | null;
  budget: number;
}

export interface ReputationAbsenceEvidenceRef {
  kind: string;
  locator: string;
  contentHash: string;
}

/** DACS-5 §10.5.1 replay context with trusted requested-session binding. */
export interface JobBoundResolutionContextEntry {
  contentHash: string;
  resolvedRole: "buyer" | "seller";
  resolvedJobId: string;
  roleEvidence: ReputationRoleEvidence;
  bb6Context?: ReputationBb6Context;
  counterpartyDisposition: "present" | "absent";
  counterpartyRef?: AttestationRef;
  counterpartyRoleEvidence?: ReputationRoleEvidence;
  absenceEvidenceRef?: ReputationAbsenceEvidenceRef;
  absenceBinding?: BundleBinding;
}

/** One untrusted copy and the authenticated lookup facts required to admit it. */
export interface SettlementVerifiedBundleInput {
  bundle: AnyAttestationBundle;
  bundleRef: AttestationRef;
  resolutionContext: JobBoundResolutionContextEntry;
  /** REQUIRED when the derivation window uses `sr2-anchor-timestamp`. */
  anchorTimestamp?: number;
}

export type AuthenticatedSettlementBundle =
  | {
      disposition: "verified";
      /** Independently authenticated role of the scored primary claim. */
      partyRole: "buyer" | "seller";
      /** Whether this copy carries the complete §10.4.1 required signer set. */
      fullySigned: boolean;
    }
  | { disposition: "rejected" | "indeterminate"; reason: string };

export type AuthenticatedPresentedSettlement =
  | {
      disposition: "verified";
      evidence: SettlementEvidence;
      /** SB-1 canonical transaction identity; required for successful payment. */
      settlementTxId?: string;
      /** Independently authenticated executed phase index. */
      phaseIndex?: number;
    }
  | { disposition: "rejected" | "indeterminate"; reason: string };

export type AuthenticatedReputationAgreement =
  | { disposition: "verified"; agreement: AgreementArtifact }
  | { disposition: "rejected" | "indeterminate"; reason: string };

/**
 * The exact DACS-5 §10.6 shape. This local name keeps the additive RSV API
 * stackable on the pending public RatingRecord PR without changing its bytes.
 */
export interface SettlementVerifiedRatingRecord {
  ratingVersion: "1";
  jobId: string;
  rater: string;
  target: string;
  targetRole: "buyer" | "seller";
  value: number;
  freeText?: string;
  dimensions?: Record<string, number>;
  ratedAt: number;
  signature: ComponentSignature;
}

export type AuthenticatedReputationRating =
  | { disposition: "verified"; record: SettlementVerifiedRatingRecord }
  | { disposition: "rejected" | "indeterminate"; reason: string };

export type CancellationAuthorityDisposition =
  | "established"
  | "refuted"
  | "indeterminate";

export interface SettlementVerifiedReputationDeps {
  /**
   * Authenticate the copy, its type/domain/signatures, role/binding context,
   * BB-6 inputs, and SEB-1..SEB-6 when the copy is EBFAB. Merely parsing the
   * outer bundle is not sufficient.
   */
  authenticateBundle: (
    input: Readonly<SettlementVerifiedBundleInput>,
    scoredPartyPrimaryClaim: string,
  ) => AuthenticatedSettlementBundle | Promise<AuthenticatedSettlementBundle>;
  /**
   * Resolve one exact ref and independently verify RSV-1/RSV-2, including the
   * Agreement/session, executed phase, rail/asset/network, transaction parties,
   * amount, finality and SB-1..SB-3. `verified` is a strong authority verdict.
   */
  verifyPresentedSettlement: (input: Readonly<{
    ref: AttestationRef;
    bundle: AnyAttestationBundle;
    resolvedJobId: string;
    evidenceIndex: number;
  }>) =>
    | AuthenticatedPresentedSettlement
    | Promise<AuthenticatedPresentedSettlement>;
  /** Resolve and authenticate a DACS-3 AgreementArtifact for volume. */
  resolveAgreement: (input: Readonly<{
    ref: AttestationRef;
    bundle: AnyAttestationBundle;
    resolvedJobId: string;
  }>) =>
    | AuthenticatedReputationAgreement
    | Promise<AuthenticatedReputationAgreement>;
  /** Optional authenticated RatingRecord resolution; absent means null ratings. */
  resolveRating?: (input: Readonly<{
    ref: AttestationRef;
    bundle: AnyAttestationBundle;
    resolvedJobId: string;
  }>) => AuthenticatedReputationRating | Promise<AuthenticatedReputationRating>;
  /** Required when either non-divergent copy carries an ST-10 marker. */
  verifyCancellation?: (input: Readonly<{
    authoritative: AnyAttestationBundle;
    selfCopy?: AnyAttestationBundle;
    counterpartyCopy?: AnyAttestationBundle;
    resolvedJobId: string;
  }>) =>
    | CancellationAuthorityDisposition
    | Promise<CancellationAuthorityDisposition>;
}

export interface SettlementVerifiedReputationDerivation {
  settlementVerifiedDerivationVersion: "1";
  partyPrimaryClaim: string;
  windowStart: number;
  windowEnd: number;
  bundleCount: number;
  metrics: ReputationMetrics;
  computedAt: number;
  windowingBasis: "finalisedAt" | "sr2-anchor-timestamp";
  bundleRefs: AttestationRef[];
}

export interface ReplayableSettlementVerifiedReputationDerivation
  extends Omit<
    SettlementVerifiedReputationDerivation,
    "settlementVerifiedDerivationVersion"
  > {
  replayableSettlementVerifiedDerivationVersion: "1";
  resolutionContext: JobBoundResolutionContextEntry[];
}

export type SettlementVerifiedReputationReplayResult =
  | {
      decision: "verified";
      derivation: ReplayableSettlementVerifiedReputationDerivation;
    }
  | { decision: "rejected"; reason: string };

interface AcceptedCopy {
  input: SettlementVerifiedBundleInput;
  partyRole: "buyer" | "seller";
  fullySigned: boolean;
  canonicalBundle: string;
}

interface VerifiedEvidenceEntry {
  ref: AttestationRef;
  evidence: SettlementEvidence;
  settlementTxId?: string;
  phaseIndex?: number;
}

interface ReconciledJob {
  authoritative: AcceptedCopy;
  selfCopy?: AcceptedCopy;
  counterpartyCopy?: AcceptedCopy;
  outcome: NonNullable<ReturnType<typeof scoredBundleOutcome>>;
  evidence: VerifiedEvidenceEntry[];
  cancellation: "none" | "established";
  orchestratorFault: boolean;
  price?: { amount: string; currency: string };
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function isSettlementVerifiedRatingRecord(
  value: unknown,
): value is SettlementVerifiedRatingRecord {
  if (!isRecord(value) || !exactKeys(value, [
    "ratingVersion", "jobId", "rater", "target", "targetRole", "value",
    "ratedAt", "signature",
  ], ["freeText", "dimensions"])) return false;
  if (value.ratingVersion !== "1" || typeof value.jobId !== "string" ||
    value.jobId.length === 0 || value.jobId !== value.jobId.trim() ||
    value.jobId.normalize("NFC") !== value.jobId ||
    /[\u0000-\u001f\u007f]/.test(value.jobId) ||
    typeof value.rater !== "string" ||
    parseCanonicalClaimReference(value.rater) === null ||
    typeof value.target !== "string" ||
    parseCanonicalClaimReference(value.target) === null ||
    value.rater === value.target ||
    (value.targetRole !== "buyer" && value.targetRole !== "seller") ||
    !Number.isInteger(value.value) || (value.value as number) < 1 ||
    (value.value as number) > 5 || !isSafeUint(value.ratedAt) ||
    !isComponentSignature(value.signature) ||
    value.signature.signer !== value.rater) return false;
  if (value.freeText !== undefined &&
    (typeof value.freeText !== "string" || value.freeText.length > 1_000)) {
    return false;
  }
  return value.dimensions === undefined ||
    (isRecord(value.dimensions) && Object.values(value.dimensions).every(
      (dimension) => typeof dimension === "number" && Number.isFinite(dimension),
    ));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function isSafeUint(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function snapshot<T>(value: T, label: string): T | null {
  try {
    return snapshotCanonicalJsonRead(value, label);
  } catch {
    return null;
  }
}

function captureDeps(value: unknown): SettlementVerifiedReputationDeps | null {
  if (!isRecord(value) || nodeTypes.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    !exactKeys(value, [
      "authenticateBundle", "verifyPresentedSettlement", "resolveAgreement",
    ], ["resolveRating", "verifyCancellation"])) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const takeFunction = (name: string, required: boolean): Function | null => {
    const descriptor = descriptors[name];
    if (!descriptor) return required ? null : (() => undefined);
    if (!("value" in descriptor) || typeof descriptor.value !== "function" ||
      nodeTypes.isProxy(descriptor.value)) return null;
    return descriptor.value;
  };
  const authenticateBundle = takeFunction("authenticateBundle", true);
  const verifyPresentedSettlement = takeFunction(
    "verifyPresentedSettlement",
    true,
  );
  const resolveAgreement = takeFunction("resolveAgreement", true);
  if (!authenticateBundle || !verifyPresentedSettlement || !resolveAgreement) {
    return null;
  }
  const resolveRating = descriptors.resolveRating
    ? takeFunction("resolveRating", false)
    : undefined;
  const verifyCancellation = descriptors.verifyCancellation
    ? takeFunction("verifyCancellation", false)
    : undefined;
  if (resolveRating === null || verifyCancellation === null) return null;
  return Object.freeze({
    authenticateBundle: authenticateBundle as SettlementVerifiedReputationDeps["authenticateBundle"],
    verifyPresentedSettlement:
      verifyPresentedSettlement as SettlementVerifiedReputationDeps["verifyPresentedSettlement"],
    resolveAgreement: resolveAgreement as SettlementVerifiedReputationDeps["resolveAgreement"],
    ...(resolveRating
      ? { resolveRating: resolveRating as NonNullable<SettlementVerifiedReputationDeps["resolveRating"]> }
      : {}),
    ...(verifyCancellation
      ? {
        verifyCancellation:
          verifyCancellation as NonNullable<SettlementVerifiedReputationDeps["verifyCancellation"]>,
      }
      : {}),
  });
}

function bundleContentHash(bundle: AnyAttestationBundle): string {
  const scope = {
    ...stripSignature(bundle as unknown as Record<string, unknown>),
  };
  delete scope["anchoredByRole"];
  return contentHash(scope);
}

function exactRefMultiset(refs: readonly unknown[]): string[] | null {
  try {
    return refs.map((ref) => canonicalize(ref)).sort();
  } catch {
    return null;
  }
}

/**
 * Full canonical AttestationRef multiset equality. Order is immaterial, while
 * multiplicity, anchor, contentHash and signer remain significant.
 */
export function settlementEvidenceReferenceMultisetsEqual(
  left: readonly unknown[],
  right: readonly unknown[],
): boolean {
  const a = exactRefMultiset(left);
  const b = exactRefMultiset(right);
  return a !== null && b !== null && a.length === b.length &&
    a.every((value, index) => value === b[index]);
}

/** Exact closed-set payment test used by RSV's volume rule. */
export function isSuccessfulDacs4PaymentProjection(value: Readonly<{
  phase: unknown;
  outcome: unknown;
}>): boolean {
  return value.outcome === "success" && typeof value.phase === "string" &&
    PAYMENT_PHASE_SET.has(value.phase);
}

function isValidRoleEvidence(value: unknown): value is ReputationRoleEvidence {
  if (!isRecord(value)) return false;
  if (value["kind"] === "address") {
    return Object.keys(value).length === 2 &&
      typeof value["resolvedAddress"] === "string" &&
      value["resolvedAddress"].length > 0;
  }
  return value["kind"] === "binding" && Object.keys(value).length === 2 &&
    isBundleBinding(value["binding"]);
}

function contextShapeValid(value: JobBoundResolutionContextEntry): boolean {
  if (
    !isRecord(value) || typeof value.contentHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.contentHash) ||
    (value.resolvedRole !== "buyer" && value.resolvedRole !== "seller") ||
    typeof value.resolvedJobId !== "string" || value.resolvedJobId.length === 0 ||
    !isValidRoleEvidence(value.roleEvidence) ||
    (value.counterpartyDisposition !== "present" &&
      value.counterpartyDisposition !== "absent")
  ) return false;
  if (!exactKeys(value, [
    "contentHash", "resolvedRole", "resolvedJobId", "roleEvidence",
    "counterpartyDisposition",
  ], [
    "bb6Context", "counterpartyRef", "counterpartyRoleEvidence",
    "absenceEvidenceRef", "absenceBinding",
  ])) return false;
  if (value.roleEvidence.kind === "binding") {
    if (!value.bb6Context || !exactKeys(
      value.bb6Context as unknown as Record<string, unknown>, [
      "candidateBindings", "partyMap", "budget",
    ]) || !isSafeUint(value.bb6Context.budget) ||
      !Array.isArray(value.bb6Context.candidateBindings) ||
      !value.bb6Context.candidateBindings.every(isBundleBinding) ||
      (value.bb6Context.partyMap !== null &&
        !isRecord(value.bb6Context.partyMap))) return false;
  } else if (value.bb6Context !== undefined) return false;
  if (value.counterpartyDisposition === "present") {
    return isAttestationRef(value.counterpartyRef) &&
      isValidRoleEvidence(value.counterpartyRoleEvidence) &&
      value.absenceEvidenceRef === undefined && value.absenceBinding === undefined;
  }
  const absence = value.absenceEvidenceRef;
  if (value.counterpartyRef !== undefined ||
    value.counterpartyRoleEvidence !== undefined ||
    !isRecord(absence) || !exactKeys(absence, [
      "kind", "locator", "contentHash",
    ]) ||
    typeof absence.kind !== "string" || absence.kind.length === 0 ||
    typeof absence.locator !== "string" || absence.locator.length === 0 ||
    typeof absence.contentHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(absence.contentHash)) return false;
  if (value.roleEvidence.kind === "binding") {
    return isBundleBinding(value.absenceBinding);
  }
  return value.absenceBinding === undefined;
}

function contextRelationsValid(value: JobBoundResolutionContextEntry): boolean {
  const ownBinding = value.roleEvidence.kind === "binding"
    ? value.roleEvidence.binding
    : undefined;
  if (ownBinding &&
    (ownBinding.jobId !== value.resolvedJobId ||
      ownBinding.role !== value.resolvedRole ||
      ownBinding.bundleContentHash !== value.contentHash)) return false;
  const otherRole = value.resolvedRole === "buyer" ? "seller" : "buyer";
  if (value.counterpartyDisposition === "present") {
    const otherBinding = value.counterpartyRoleEvidence?.kind === "binding"
      ? value.counterpartyRoleEvidence.binding
      : undefined;
    return !otherBinding || (otherBinding.jobId === value.resolvedJobId &&
      otherBinding.role === otherRole &&
      otherBinding.bundleContentHash === value.counterpartyRef?.contentHash);
  }
  if (ownBinding) {
    return value.absenceBinding?.jobId === value.resolvedJobId &&
      value.absenceBinding.role === otherRole;
  }
  return true;
}

function captureBundleAuth(value: unknown): AuthenticatedSettlementBundle | null {
  const captured = snapshot(value, "settlement-verified bundle authority");
  if (!isRecord(captured)) return null;
  if (captured.disposition === "verified") {
    if (!exactKeys(captured, ["disposition", "partyRole", "fullySigned"]) ||
      (captured.partyRole !== "buyer" && captured.partyRole !== "seller") ||
      typeof captured.fullySigned !== "boolean") return null;
    return captured as unknown as AuthenticatedSettlementBundle;
  }
  if ((captured.disposition === "rejected" ||
      captured.disposition === "indeterminate") &&
    exactKeys(captured, ["disposition", "reason"]) &&
    typeof captured.reason === "string") {
    return captured as unknown as AuthenticatedSettlementBundle;
  }
  return null;
}

function captureEvidenceAuth(
  value: unknown,
  ref: AttestationRef,
  jobId: string,
): AuthenticatedPresentedSettlement | null {
  const captured = snapshot(value, "settlement-verified evidence authority");
  if (!isRecord(captured)) return null;
  if (captured.disposition === "verified") {
    if (!exactKeys(captured, ["disposition", "evidence"], [
      "settlementTxId", "phaseIndex",
    ]) || !isSettlementEvidence(captured.evidence) ||
      captured.evidence.jobId !== jobId ||
      contentHash(stripSignature(captured.evidence as unknown as Record<string, unknown>)) !==
        ref.contentHash) return null;
    if (captured.settlementTxId !== undefined &&
      (typeof captured.settlementTxId !== "string" ||
        captured.settlementTxId.length === 0)) return null;
    if (captured.phaseIndex !== undefined && !isSafeUint(captured.phaseIndex)) {
      return null;
    }
    if (isSuccessfulDacs4PaymentProjection(captured.evidence) &&
      (typeof captured.settlementTxId !== "string" ||
        !isCanonicalSettlementIdentity(captured.settlementTxId) ||
        !isSafeUint(captured.phaseIndex))) return null;
    return captured as unknown as AuthenticatedPresentedSettlement;
  }
  if ((captured.disposition === "rejected" ||
      captured.disposition === "indeterminate") &&
    exactKeys(captured, ["disposition", "reason"]) &&
    typeof captured.reason === "string") {
    return captured as unknown as AuthenticatedPresentedSettlement;
  }
  return null;
}

function captureAgreementAuth(
  value: unknown,
  ref: AttestationRef,
  jobId: string,
): AgreementArtifact | null {
  const captured = snapshot(value, "settlement-verified Agreement authority");
  if (!isRecord(captured) ||
    !exactKeys(captured, ["disposition", "agreement"]) ||
    captured.disposition !== "verified" ||
    !isAgreementArtifact(captured.agreement)) return null;
  const agreement = captured.agreement;
  if (agreement.jobId !== jobId ||
    contentHash(stripSignature(agreement as unknown as Record<string, unknown>)) !==
      ref.contentHash) return null;
  try {
    if (canonicalizeDecimal(agreement.terms.price.amount) !==
      agreement.terms.price.amount || agreement.terms.price.amount === "0") return null;
  } catch {
    return null;
  }
  return agreement;
}

function addCanonicalDecimals(left: string, right: string): string {
  const a = canonicalizeDecimal(left);
  const b = canonicalizeDecimal(right);
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  const scale = Math.max(af.length, bf.length);
  const av = BigInt(`${ai}${af.padEnd(scale, "0")}`);
  const bv = BigInt(`${bi}${bf.padEnd(scale, "0")}`);
  const digits = (av + bv).toString().padStart(scale + 1, "0");
  return scale === 0
    ? canonicalizeDecimal(digits)
    : canonicalizeDecimal(
      `${digits.slice(0, -scale)}.${digits.slice(-scale)}`,
    );
}

function pickSameRole(copies: AcceptedCopy[]): AcceptedCopy | null {
  if (copies.length === 0) return null;
  const forms = new Map<string, AcceptedCopy[]>();
  for (const copy of copies) {
    const group = forms.get(copy.canonicalBundle) ?? [];
    group.push(copy);
    forms.set(copy.canonicalBundle, group);
  }
  if (forms.size === 1) {
    return [...copies].sort((a, b) =>
      canonicalize(a.input.resolutionContext).localeCompare(
        canonicalize(b.input.resolutionContext),
      ))[0]!;
  }
  const fullySignedForms = [...forms.values()].filter((group) =>
    group.some((copy) => copy.fullySigned)
  );
  if (fullySignedForms.length !== 1) return null;
  return fullySignedForms[0]!.filter((copy) => copy.fullySigned)
    .sort((a, b) => a.canonicalBundle.localeCompare(b.canonicalBundle))[0]!;
}

function pairHasOrchestratorFault(
  authoritative: AnyAttestationBundle,
  selfCopy?: AnyAttestationBundle,
  counterpartyCopy?: AnyAttestationBundle,
): boolean {
  if (isAbsoluteFaultBundle(authoritative) &&
    authoritative.faultedParty === "orchestrator") return true;
  if (!selfCopy || !counterpartyCopy || isAbsoluteFaultBundle(selfCopy) ||
    isAbsoluteFaultBundle(counterpartyCopy)) return false;
  const left = legacyImpliedFaultSet(selfCopy);
  const right = legacyImpliedFaultSet(counterpartyCopy);
  const common = [...left].filter((role) => right.has(role));
  return common.length === 1 && common[0] === "orchestrator";
}

function canonicalBundleRefCompare(a: AttestationRef, b: AttestationRef): number {
  return a.contentHash.localeCompare(b.contentHash) ||
    canonicalize(a).localeCompare(canonicalize(b));
}

function emptyMetrics(): ReputationMetrics {
  return {
    completionRate: null,
    counterpartyFaultRate: null,
    counterpartyAdjustedCompletionRate: null,
    averageBuyerRating: null,
    averageSellerRating: null,
    observedTransactionalVolume: [],
    transactionCountByCurrency: [],
  };
}

async function authenticateInputs(
  party: string,
  inputs: readonly SettlementVerifiedBundleInput[],
  window: ReputationWindow,
  authenticate: SettlementVerifiedReputationDeps["authenticateBundle"],
): Promise<AcceptedCopy[]> {
  const accepted: AcceptedCopy[] = [];
  for (const raw of inputs) {
    const input = snapshot(raw, "settlement-verified reputation input");
    if (!input || !isAttestationRef(input.bundleRef) ||
      !contextShapeValid(input.resolutionContext) ||
      !contextRelationsValid(input.resolutionContext)) continue;
    const context = input.resolutionContext;
    const hash = bundleContentHash(input.bundle);
    if (context.resolvedJobId !== input.bundle.jobId ||
      context.resolvedRole !== input.bundle.anchoredByRole ||
      context.contentHash !== hash || input.bundleRef.contentHash !== hash ||
      (context.resolvedRole !== "buyer" && context.resolvedRole !== "seller")) {
      continue;
    }
    const clock = window.windowingBasis === "sr2-anchor-timestamp"
      ? input.anchorTimestamp
      : input.bundle.finalisedAt;
    if (!isSafeUint(clock) || clock < window.windowStart ||
      clock > window.windowEnd) continue;
    let result: AuthenticatedSettlementBundle | null = null;
    try {
      result = captureBundleAuth(await authenticate(
        snapshotCanonicalJsonRead(
          input,
          "settlement-verified bundle authority request",
        ),
        party,
      ));
    } catch {
      // Authority failure is indeterminate and therefore excluded.
    }
    if (!result || result.disposition !== "verified") continue;
    const claimedRole = input.bundle.parties.find((candidate) =>
      sameCanonicalClaimIdentity(candidate.primaryClaim, party)
    )?.role;
    if (claimedRole !== result.partyRole ||
      (claimedRole !== "buyer" && claimedRole !== "seller")) continue;
    accepted.push({
      input,
      partyRole: result.partyRole,
      fullySigned: result.fullySigned,
      canonicalBundle: canonicalize(input.bundle),
    });
  }
  return accepted;
}

async function verifyPresentedSet(
  copy: AcceptedCopy,
  verify: SettlementVerifiedReputationDeps["verifyPresentedSettlement"],
): Promise<VerifiedEvidenceEntry[] | null> {
  const entries: VerifiedEvidenceEntry[] = [];
  for (let index = 0; index < copy.input.bundle.settlementEvidence.length; index += 1) {
    const ref = copy.input.bundle.settlementEvidence[index]!;
    let result: AuthenticatedPresentedSettlement | null = null;
    try {
      result = captureEvidenceAuth(await verify(snapshotCanonicalJsonRead({
        ref,
        bundle: copy.input.bundle,
        resolvedJobId: copy.input.resolutionContext.resolvedJobId,
        evidenceIndex: index,
      }, "settlement-verified evidence request")), ref,
      copy.input.resolutionContext.resolvedJobId);
    } catch {
      // Any rejected/unavailable member excludes the whole job under RSV-3.
    }
    if (!result || result.disposition !== "verified") return null;
    entries.push({
      ref,
      evidence: result.evidence,
      ...(result.settlementTxId === undefined
        ? {}
        : { settlementTxId: result.settlementTxId }),
      ...(result.phaseIndex === undefined ? {} : { phaseIndex: result.phaseIndex }),
    });
  }
  return entries;
}

async function resolvePrice(
  copy: AcceptedCopy,
  resolve: SettlementVerifiedReputationDeps["resolveAgreement"],
): Promise<{ amount: string; currency: string } | null> {
  const ref = copy.input.bundle.agreementRef;
  if (!ref) return null;
  let agreement: AgreementArtifact | null = null;
  try {
    agreement = captureAgreementAuth(await resolve(snapshotCanonicalJsonRead({
      ref,
      bundle: copy.input.bundle,
      resolvedJobId: copy.input.resolutionContext.resolvedJobId,
    }, "settlement-verified Agreement request")), ref,
    copy.input.resolutionContext.resolvedJobId);
  } catch {
    // A failed exact Agreement resolution excludes the job rather than volume only.
  }
  if (!agreement) return null;
  return {
    amount: agreement.terms.price.amount,
    currency: agreement.terms.price.currency,
  };
}

async function reconcile(
  party: string,
  accepted: AcceptedCopy[],
  deps: SettlementVerifiedReputationDeps,
): Promise<ReconciledJob[]> {
  const byJob = new Map<string, AcceptedCopy[]>();
  for (const copy of accepted) {
    const jobId = copy.input.resolutionContext.resolvedJobId;
    const group = byJob.get(jobId) ?? [];
    group.push(copy);
    byJob.set(jobId, group);
  }
  const jobs: ReconciledJob[] = [];
  for (const jobId of [...byJob.keys()].sort()) {
    const candidates = byJob.get(jobId)!;
    const buyer = pickSameRole(candidates.filter((copy) =>
      copy.input.resolutionContext.resolvedRole === "buyer"));
    const seller = pickSameRole(candidates.filter((copy) =>
      copy.input.resolutionContext.resolvedRole === "seller"));
    if (!buyer && !seller) continue;
    const copies = [buyer, seller].filter((copy): copy is AcceptedCopy => !!copy);
    if (copies.some((copy) => copy.partyRole !== copies[0]!.partyRole)) continue;
    const roleOfParty = copies[0]!.partyRole;
    const selfCopy = copies.find((copy) =>
      copy.input.resolutionContext.resolvedRole === roleOfParty);
    const counterpartyCopy = copies.find((copy) =>
      copy.input.resolutionContext.resolvedRole !== roleOfParty);
    if (buyer && seller) {
      if (buyer.input.resolutionContext.counterpartyDisposition !== "present" ||
        seller.input.resolutionContext.counterpartyDisposition !== "present") continue;
      const buyerCounterparty = buyer.input.resolutionContext.counterpartyRef;
      const sellerCounterparty = seller.input.resolutionContext.counterpartyRef;
      if (!buyerCounterparty || !sellerCounterparty ||
        canonicalize(buyerCounterparty) !== canonicalize(seller.input.bundleRef) ||
        canonicalize(sellerCounterparty) !== canonicalize(buyer.input.bundleRef)) {
        continue;
      }
      if (bundlesDiverge(buyer.input.bundle, seller.input.bundle) ||
        !settlementEvidenceReferenceMultisetsEqual(
          buyer.input.bundle.settlementEvidence,
          seller.input.bundle.settlementEvidence,
        )) continue;
    } else {
      const only = copies[0]!;
      if (only.input.resolutionContext.counterpartyDisposition !== "absent" ||
        !only.input.resolutionContext.absenceEvidenceRef) continue;
    }
    let authoritative = selfCopy ?? counterpartyCopy;
    if (!authoritative) continue;
    if (selfCopy && counterpartyCopy) {
      const selfRank = bundleArtifactTypeRank(selfCopy.input.bundle);
      const cpRank = bundleArtifactTypeRank(counterpartyCopy.input.bundle);
      if (selfRank < 0 || cpRank < 0) continue;
      if (cpRank > selfRank) authoritative = counterpartyCopy;
    }
    if (!bundleArtifactType(authoritative.input.bundle)) continue;
    const evidence = await verifyPresentedSet(
      authoritative,
      deps.verifyPresentedSettlement,
    );
    if (!evidence) continue;
    const outcome = scoredBundleOutcome(authoritative.input.bundle, roleOfParty);
    if (!outcome) continue;
    let cancellation: ReconciledJob["cancellation"] = "none";
    if (selfCopy?.input.bundle.cancellation ||
      counterpartyCopy?.input.bundle.cancellation) {
      if (!deps.verifyCancellation) continue;
      let disposition: CancellationAuthorityDisposition = "indeterminate";
      try {
        const result: unknown = await deps.verifyCancellation(
          snapshotCanonicalJsonRead({
            authoritative: authoritative.input.bundle,
            ...(selfCopy ? { selfCopy: selfCopy.input.bundle } : {}),
            ...(counterpartyCopy
              ? { counterpartyCopy: counterpartyCopy.input.bundle }
              : {}),
            resolvedJobId: jobId,
          }, "settlement-verified cancellation request"),
        );
        if (result === "established" || result === "refuted" ||
          result === "indeterminate") disposition = result;
      } catch {
        // Indeterminate excludes the job.
      }
      if (disposition === "indeterminate") continue;
      if (disposition === "established") cancellation = "established";
    }
    const successfulPayment = evidence.some(({ evidence: record }) =>
      isSuccessfulDacs4PaymentProjection(record)
    );
    let price: ReconciledJob["price"];
    if (outcome === "completed" && successfulPayment) {
      if (!authoritative.input.bundle.agreementRef) continue;
      price = await resolvePrice(authoritative, deps.resolveAgreement) ?? undefined;
      if (!price) continue;
    }
    jobs.push({
      authoritative,
      ...(selfCopy ? { selfCopy } : {}),
      ...(counterpartyCopy ? { counterpartyCopy } : {}),
      outcome,
      evidence,
      cancellation,
      orchestratorFault: pairHasOrchestratorFault(
        authoritative.input.bundle,
        selfCopy?.input.bundle,
        counterpartyCopy?.input.bundle,
      ),
      ...(price ? { price } : {}),
    });
  }
  return suppressReusedSettlements(jobs);
}

function suppressReusedSettlements(jobs: ReconciledJob[]): ReconciledJob[] {
  const claims = new Map<string, Array<{
    job: ReconciledJob;
    observedAt: number;
    phaseIndex: number;
  }>>();
  for (const job of jobs) {
    for (const entry of job.evidence) {
      if (!isSuccessfulDacs4PaymentProjection(entry.evidence) ||
        !entry.settlementTxId || entry.phaseIndex === undefined) continue;
      const bucket = claims.get(entry.settlementTxId) ?? [];
      bucket.push({
        job,
        observedAt: entry.evidence.observedAt,
        phaseIndex: entry.phaseIndex,
      });
      claims.set(entry.settlementTxId, bucket);
    }
  }
  const excluded = new Set<ReconciledJob>();
  for (const bucket of claims.values()) {
    const distinct = new Map<string, typeof bucket[number]>();
    for (const claim of bucket) {
      const key = `${claim.job.authoritative.input.resolutionContext.resolvedJobId}\u0000${claim.phaseIndex}`;
      const current = distinct.get(key);
      if (!current || claim.observedAt < current.observedAt) distinct.set(key, claim);
    }
    if (distinct.size <= 1) continue;
    const ordered = [...distinct.values()].sort((a, b) =>
      a.observedAt - b.observedAt ||
      a.job.authoritative.input.resolutionContext.resolvedJobId.localeCompare(
        b.job.authoritative.input.resolutionContext.resolvedJobId,
      ) || a.phaseIndex - b.phaseIndex);
    const winner = ordered[0]!;
    for (const loser of ordered.slice(1)) {
      // Multiple phase claims inside the retained earliest job still count as
      // that one job. A later distinct job is excluded so the transaction can
      // inflate neither completion nor volume across sessions.
      if (loser.job !== winner.job) excluded.add(loser.job);
    }
  }
  return jobs.filter((job) => !excluded.has(job));
}

async function ratingAverages(
  party: string,
  jobs: readonly ReconciledJob[],
  resolve: SettlementVerifiedReputationDeps["resolveRating"],
): Promise<Pick<ReputationMetrics, "averageBuyerRating" | "averageSellerRating">> {
  if (!resolve) return { averageBuyerRating: null, averageSellerRating: null };
  const retained = new Map<string, SettlementVerifiedRatingRecord>();
  for (const job of jobs) {
    const bundle = job.authoritative.input.bundle;
    for (const ref of bundle.ratingRefs ?? []) {
      let record: SettlementVerifiedRatingRecord | null = null;
      try {
        const captured = snapshot(await resolve(snapshotCanonicalJsonRead({
          ref,
          bundle,
          resolvedJobId: job.authoritative.input.resolutionContext.resolvedJobId,
        }, "settlement-verified rating request")),
        "settlement-verified rating authority");
        if (isRecord(captured) &&
          exactKeys(captured, ["disposition", "record"]) &&
          captured.disposition === "verified" &&
          isSettlementVerifiedRatingRecord(captured.record)) record = captured.record;
      } catch {
        // Invalid or unavailable ratings are excluded, not treated as zero.
      }
      if (!record || record.jobId !== bundle.jobId ||
        !sameCanonicalClaimIdentity(record.target, party) ||
        sameCanonicalClaimIdentity(record.rater, party) ||
        record.targetRole !== job.authoritative.partyRole ||
        contentHash(stripSignature(record as unknown as Record<string, unknown>)) !==
          ref.contentHash) continue;
      const rater = bundle.parties.find((candidate) =>
        sameCanonicalClaimIdentity(candidate.primaryClaim, record!.rater));
      if (!rater || rater.role === job.authoritative.partyRole) continue;
      const tuple = canonicalize([record.rater, record.jobId, record.targetRole]);
      const current = retained.get(tuple);
      if (!current || record.ratedAt > current.ratedAt ||
        (record.ratedAt === current.ratedAt &&
          contentHash(stripSignature(record as unknown as Record<string, unknown>)) >
          contentHash(stripSignature(current as unknown as Record<string, unknown>)))) {
        retained.set(tuple, record);
      }
    }
  }
  const buyer: number[] = [];
  const seller: number[] = [];
  for (const record of retained.values()) {
    (record.targetRole === "buyer" ? buyer : seller).push(record.value);
  }
  const mean = (values: number[]): number | null => values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
  return { averageBuyerRating: mean(buyer), averageSellerRating: mean(seller) };
}

function discriminatorCount(value: Record<string, unknown>): number {
  return DERIVATION_DISCRIMINATORS.filter((key) =>
    Object.prototype.hasOwnProperty.call(value, key)).length;
}

function hasUnknownDerivationDiscriminator(value: Record<string, unknown>): boolean {
  const known = new Set<string>(DERIVATION_DISCRIMINATORS);
  return Object.keys(value).some((key) =>
    /derivationVersion$/i.test(key) && !known.has(key));
}

function metricsShapeValid(value: unknown): value is ReputationMetrics {
  if (!isRecord(value)) return false;
  const bounded = (entry: unknown, minimum: number, maximum: number) =>
    entry === null || (typeof entry === "number" && Number.isFinite(entry) &&
      entry >= minimum && entry <= maximum);
  if (!exactKeys(value, [
    "completionRate", "counterpartyFaultRate",
    "counterpartyAdjustedCompletionRate", "averageBuyerRating",
    "averageSellerRating", "observedTransactionalVolume",
    "transactionCountByCurrency",
  ])) return false;
  const rate = (entry: unknown) => bounded(entry, 0, 1);
  const rating = (entry: unknown) => bounded(entry, 1, 5);
  return rate(value.completionRate) && rate(value.counterpartyFaultRate) &&
    rate(value.counterpartyAdjustedCompletionRate) &&
    rating(value.averageBuyerRating) && rating(value.averageSellerRating) &&
    Array.isArray(value.observedTransactionalVolume) &&
    value.observedTransactionalVolume.every((entry) => isRecord(entry) &&
      exactKeys(entry, ["amount", "currency"]) &&
      typeof entry.amount === "string" && typeof entry.currency === "string" &&
      entry.currency.length > 0 && (() => {
        try {
          return canonicalizeDecimal(entry.amount as string) === entry.amount &&
            entry.amount !== "0";
        } catch {
          return false;
        }
      })()) &&
    Array.isArray(value.transactionCountByCurrency) &&
    value.transactionCountByCurrency.every((entry) => isRecord(entry) &&
      exactKeys(entry, ["currency", "count"]) &&
      typeof entry.currency === "string" && entry.currency.length > 0 &&
      isSafeUint(entry.count) && entry.count > 0);
}

function commonDerivationShape(value: Record<string, unknown>): boolean {
  if (typeof value.partyPrimaryClaim !== "string" ||
    parseCanonicalClaimReference(value.partyPrimaryClaim) === null ||
    !isSafeUint(value.windowStart) || !isSafeUint(value.windowEnd) ||
    value.windowStart > value.windowEnd ||
    !isSafeUint(value.bundleCount) || !isSafeUint(value.computedAt) ||
    (value.windowingBasis !== "finalisedAt" &&
      value.windowingBasis !== "sr2-anchor-timestamp") ||
    !metricsShapeValid(value.metrics) || !Array.isArray(value.bundleRefs) ||
    !value.bundleRefs.every(isAttestationRef) ||
    value.bundleRefs.length !== value.bundleCount) return false;
  const refs = value.bundleRefs as AttestationRef[];
  return refs.every((ref, index) => index === 0 ||
    canonicalBundleRefCompare(refs[index - 1]!, ref) < 0);
}

/** Refuses stripped, relabelled, unknown and multi-discriminator derivations. */
export function isSettlementVerifiedReputationDerivation(
  value: unknown,
): value is SettlementVerifiedReputationDerivation {
  return isRecord(value) && !hasUnknownDerivationDiscriminator(value) &&
    exactKeys(value, [
      "settlementVerifiedDerivationVersion", "partyPrimaryClaim",
      "windowStart", "windowEnd", "bundleCount", "metrics", "computedAt",
      "windowingBasis", "bundleRefs",
    ]) && discriminatorCount(value) === 1 &&
    value.settlementVerifiedDerivationVersion === "1" &&
    value.resolutionContext === undefined && commonDerivationShape(value);
}

/** Strict structural gate for the replayable settlement-verified type. */
export function isReplayableSettlementVerifiedReputationDerivation(
  value: unknown,
): value is ReplayableSettlementVerifiedReputationDerivation {
  return isRecord(value) && !hasUnknownDerivationDiscriminator(value) &&
    exactKeys(value, [
      "replayableSettlementVerifiedDerivationVersion", "partyPrimaryClaim",
      "windowStart", "windowEnd", "bundleCount", "metrics", "computedAt",
      "windowingBasis", "bundleRefs", "resolutionContext",
    ]) && discriminatorCount(value) === 1 &&
    value.replayableSettlementVerifiedDerivationVersion === "1" &&
    commonDerivationShape(value) && Array.isArray(value.resolutionContext) &&
    value.resolutionContext.length === value.bundleCount &&
    value.resolutionContext.every((entry, index) =>
      contextShapeValid(entry) &&
      entry.contentHash === (value.bundleRefs as AttestationRef[])[index]?.contentHash);
}

async function deriveInternal(
  party: string,
  rawInputs: readonly SettlementVerifiedBundleInput[],
  rawWindow: ReputationWindow,
  deps: SettlementVerifiedReputationDeps,
  replayable: boolean,
): Promise<
  | SettlementVerifiedReputationDerivation
  | ReplayableSettlementVerifiedReputationDerivation
> {
  const capturedDeps = captureDeps(deps);
  if (!capturedDeps) {
    throw new DacsError(
      "settlement-verified reputation requires authenticateBundle, " +
        "verifyPresentedSettlement and resolveAgreement authority callbacks",
    );
  }
  const parsedParty = requireCanonicalClaimReference(
    party,
    "SettlementVerifiedReputationDerivation partyPrimaryClaim",
  );
  const canonicalParty =
    `${parsedParty.identity.scheme}:${parsedParty.identity.identifier}`;
  const inputs = snapshot(rawInputs,
    "settlement-verified reputation candidates");
  const window = snapshot(rawWindow, "settlement-verified reputation window");
  if (!inputs || !window || !isSafeUint(window.windowStart) ||
    !isSafeUint(window.windowEnd) || !isSafeUint(window.computedAt) ||
    window.windowStart > window.windowEnd ||
    (window.windowingBasis !== undefined &&
      window.windowingBasis !== "finalisedAt" &&
      window.windowingBasis !== "sr2-anchor-timestamp")) {
    throw new DacsError("invalid settlement-verified reputation input/window");
  }
  const basis = window.windowingBasis ?? "finalisedAt";
  const accepted = await authenticateInputs(
    canonicalParty,
    inputs,
    { ...window, windowingBasis: basis },
    capturedDeps.authenticateBundle,
  );
  const jobs = await reconcile(canonicalParty, accepted, capturedDeps);
  const refs = jobs.map((job) => job.authoritative.input.bundleRef)
    .sort(canonicalBundleRefCompare);
  const contexts = jobs.map((job) => ({
    ref: job.authoritative.input.bundleRef,
    context: job.authoritative.input.resolutionContext,
  })).sort((a, b) => canonicalBundleRefCompare(a.ref, b.ref))
    .map(({ context }) => context);

  const outcomes = jobs.map((job) => job.outcome);
  const completed = outcomes.filter((outcome) => outcome === "completed").length;
  const failedSubstrate = outcomes.filter((outcome) =>
    outcome === "failed-substrate").length;
  const cancelled = jobs.filter((job) =>
    job.cancellation === "established").length;
  const orchestratorFault = jobs.filter((job) => job.orchestratorFault).length;
  const counterpartyFault = jobs.filter((job) => !job.orchestratorFault &&
    job.cancellation !== "established" &&
    (job.outcome === "failed-counterparty" ||
      job.outcome === "aborted-by-other")).length;
  const denominator = jobs.length - failedSubstrate - cancelled - orchestratorFault;
  const blameDenominator = denominator - counterpartyFault;
  const ratings = await ratingAverages(
    canonicalParty,
    jobs,
    capturedDeps.resolveRating,
  );
  const volume = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const job of jobs) {
    if (job.outcome !== "completed" || !job.price) continue;
    volume.set(
      job.price.currency,
      addCanonicalDecimals(volume.get(job.price.currency) ?? "0", job.price.amount),
    );
    counts.set(job.price.currency, (counts.get(job.price.currency) ?? 0) + 1);
  }
  const metrics: ReputationMetrics = jobs.length === 0
    ? emptyMetrics()
    : {
      completionRate: denominator > 0 ? completed / denominator : null,
      counterpartyFaultRate: denominator > 0
        ? counterpartyFault / denominator
        : null,
      counterpartyAdjustedCompletionRate: blameDenominator > 0
        ? completed / blameDenominator
        : null,
      ...ratings,
      observedTransactionalVolume: [...volume.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, amount]) => ({ amount, currency })),
      transactionCountByCurrency: [...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, count]) => ({ currency, count })),
    };
  const common = {
    partyPrimaryClaim: canonicalParty,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    bundleCount: jobs.length,
    metrics,
    computedAt: window.computedAt,
    windowingBasis: basis,
    bundleRefs: refs,
  };
  return replayable
    ? {
      replayableSettlementVerifiedDerivationVersion: "1",
      ...common,
      resolutionContext: contexts,
    }
    : { settlementVerifiedDerivationVersion: "1", ...common };
}

/** Derive the distinct RSV-enforced DACS-5 reputation type. */
export async function deriveSettlementVerifiedReputation(
  party: string,
  inputs: readonly SettlementVerifiedBundleInput[],
  window: ReputationWindow,
  deps: SettlementVerifiedReputationDeps,
): Promise<SettlementVerifiedReputationDerivation> {
  return deriveInternal(party, inputs, window, deps, false) as Promise<
    SettlementVerifiedReputationDerivation
  >;
}

/** Produce a job-bound replay receipt; one context entry is emitted per ref. */
export async function deriveReplayableSettlementVerifiedReputation(
  party: string,
  inputs: readonly SettlementVerifiedBundleInput[],
  window: ReputationWindow,
  deps: SettlementVerifiedReputationDeps,
): Promise<ReplayableSettlementVerifiedReputationDerivation> {
  return deriveInternal(party, inputs, window, deps, true) as Promise<
    ReplayableSettlementVerifiedReputationDerivation
  >;
}

/**
 * Consumer-side replay: re-runs bundle authority, reconciliation, RSV, ratings,
 * Agreement resolution and transaction uniqueness before byte comparison.
 */
export async function replaySettlementVerifiedReputation(
  receipt: unknown,
  inputs: readonly SettlementVerifiedBundleInput[],
  deps: SettlementVerifiedReputationDeps,
): Promise<SettlementVerifiedReputationReplayResult> {
  if (!isReplayableSettlementVerifiedReputationDerivation(receipt)) {
    return { decision: "rejected", reason: "invalid or unsupported replay receipt" };
  }
  let replayed: ReplayableSettlementVerifiedReputationDerivation;
  try {
    replayed = await deriveReplayableSettlementVerifiedReputation(
      receipt.partyPrimaryClaim,
      inputs,
      {
        windowStart: receipt.windowStart,
        windowEnd: receipt.windowEnd,
        computedAt: receipt.computedAt,
        windowingBasis: receipt.windowingBasis,
      },
      deps,
    );
  } catch {
    return { decision: "rejected", reason: "replay authority or derivation failed" };
  }
  if (canonicalize(replayed) !== canonicalize(receipt)) {
    return {
      decision: "rejected",
      reason: "re-derived receipt is not byte-equivalent to the supplied receipt",
    };
  }
  return { decision: "verified", derivation: replayed };
}
