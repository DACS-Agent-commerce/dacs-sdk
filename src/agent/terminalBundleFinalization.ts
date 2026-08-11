/**
 * Pure DACS-5 terminal FaultAttestationBundle planning.
 *
 * This module deliberately has no signer, transport, storage, or clock callback. It turns an
 * already-authenticated terminal authority into exact role-relative signed scopes, accepts one
 * detached-signature row from each locally controlled role, verifies the complete Ed25519
 * signer/copy matrix, and assembles only the caller's own role copy. Durable orchestration owns
 * WAL/fencing and all external effects around these data-only operations.
 */
import { types as nodeTypes } from "node:util";

import type {
  AttestationRef,
  BundleParty,
  BundlePartyRole,
  BundlePhaseErrorClass,
  BundleSignature,
  CancellationMarker,
  FaultAttestationBundle,
  FaultedParty,
  IdentityBundle,
  ListingRef,
  PhaseSummaryEntry,
  PhaseType,
} from "../artifacts/types.js";
import {
  isCanonicalBase64Url,
  isFaultAttestationBundle,
  isIdentityBundle,
} from "../artifacts/index.js";
import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import { canonicalize, sha256Hex } from "../canonical/index.js";
import { ed25519Verify, publicKeyFromRaw, signedBytes } from "../crypto/index.js";
import { DacsError } from "../errors.js";
import { identityBundleHash } from "../identity/bundle.js";
import {
  roleRelativeOutcome,
  type BundleOutcome,
  type BundleOutcomeClass,
} from "./bundleSemantics.js";

const ROLE_ORDER = Object.freeze([
  "buyer",
  "seller",
  "orchestrator",
] as const satisfies readonly BundlePartyRole[]);

const PHASE_TYPES = new Set<PhaseType>([
  "vet-credentials",
  "negotiate-fixed-price",
  "negotiate-rfq",
  "negotiate-sealed-envelope",
  "negotiate-sealed-envelope-procurement",
  "commit-agreement",
  "commit-payee-bound-agreement",
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
  "rate",
]);

const ERROR_CLASSES = new Set<BundlePhaseErrorClass>([
  "permanent",
  "transient",
  "counterparty",
  "substrate",
  "settlement-atomicity",
]);

const HASH = /^[0-9a-f]{64}$/;

export type TerminalBundleClass = "failure" | "abort" | "failed-substrate";

export interface TerminalPhaseAuthority {
  index: number;
  kind: PhaseType;
  state: "failed" | "pending";
  errorClass?: BundlePhaseErrorClass;
}

/**
 * An upstream verifier's disposition for one potentially irreversible effect.
 * Only `not-reached` in a pre-settlement phase, or `authoritatively-absent` while settlement is
 * pending, can support ST-3/ST-9 abort publication. `final` and `indeterminate` are represented so
 * a caller cannot collapse either into absence; authority construction rejects both.
 */
export type TerminalIrreversibleEffectObservation =
  | { disposition: "not-reached" }
  | {
      disposition: "authoritatively-absent";
      observationHash: string;
      observedAt: number;
    }
  | { disposition: "final"; evidenceHash: string; observedAt: number }
  | { disposition: "indeterminate"; reason: string; observedAt: number };

export interface TerminalAbortEligibility {
  trigger: "declined" | "withdrawn" | "timeout";
  triggeredBy: BundlePartyRole;
  triggerEvidenceHash: string;
  observedAt: number;
  payment: TerminalIrreversibleEffectObservation;
  delivery: TerminalIrreversibleEffectObservation;
}

/**
 * The IdentityBundle value supplied here MUST already have passed the caller's identity and
 * presentation verification. The core intentionally accepts no resolver callback. It derives
 * `BundleParty.bundleHash` itself with the normative DACS-1 omission rule, so a caller cannot
 * substitute an agent-id hash or a presentation-inclusive hash.
 */
export interface VerifiedTerminalBundleParty {
  role: BundlePartyRole;
  identityBundle: IdentityBundle;
}

export interface TerminalBundleAuthorityInput {
  jobId: string;
  terminalClass: TerminalBundleClass;
  faultedParty: FaultedParty;
  terminalPhase: TerminalPhaseAuthority;
  /** Hash of the canonical, authenticated session record from which terminal authority arose. */
  sessionRecordHash: string;
  /** Hash of the authenticated observation/decision that establishes class and absolute fault. */
  terminalEvidenceHash: string;
  /** Hash of the independently verified recursive ST-11 dependency closure. */
  dependencySetHash: string;
  listingRef: ListingRef;
  agreementRef?: AttestationRef;
  cancellation?: CancellationMarker;
  parties: readonly VerifiedTerminalBundleParty[];
  phaseSummary: readonly PhaseSummaryEntry[];
  vetRecords: readonly AttestationRef[];
  settlementEvidence: readonly AttestationRef[];
  amendments?: readonly AttestationRef[];
  ratingRefs?: readonly AttestationRef[];
  recipeRegistryVersion: number;
  railRegistryVersion: number;
  finalisedAt: number;
  abortEligibility?: TerminalAbortEligibility;
}

export interface TerminalBundleAuthority {
  authorityVersion: "1";
  jobId: string;
  terminalClass: TerminalBundleClass;
  faultedParty: FaultedParty;
  terminalPhase: Readonly<TerminalPhaseAuthority>;
  sessionRecordHash: string;
  terminalEvidenceHash: string;
  dependencySetHash: string;
  referenceSetHash: string;
  listingRef: Readonly<ListingRef>;
  agreementRef?: Readonly<AttestationRef>;
  cancellation?: Readonly<CancellationMarker>;
  parties: readonly Readonly<BundleParty>[];
  phaseSummary: readonly Readonly<PhaseSummaryEntry>[];
  vetRecords: readonly Readonly<AttestationRef>[];
  settlementEvidence: readonly Readonly<AttestationRef>[];
  amendments?: readonly Readonly<AttestationRef>[];
  ratingRefs?: readonly Readonly<AttestationRef>[];
  recipeRegistryVersion: number;
  railRegistryVersion: number;
  finalisedAt: number;
  abortEligibility?: Readonly<TerminalAbortEligibility>;
  abortEligibilityHash?: string;
}

export type TerminalBundleSigningMode =
  | { kind: "co-signed" }
  | { kind: "single-signed-abort"; signerRole: BundlePartyRole };

export interface TerminalBundleRequiredSigner {
  role: BundlePartyRole;
  primaryClaim: string;
}

export interface TerminalBundleRolePlan {
  role: BundlePartyRole;
  outcome: BundleOutcome;
  signedScope: Readonly<Record<string, unknown>>;
  bundleContentHash: string;
  /** Frozen byte values; obtain a fresh Uint8Array with `terminalBundleSignedBytes`. */
  signedBytes: readonly number[];
}

export interface TerminalBundlePlan {
  planVersion: "1";
  authority: Readonly<TerminalBundleAuthority>;
  authorityHash: string;
  signingMode: Readonly<TerminalBundleSigningMode>;
  requiredSigners: readonly Readonly<TerminalBundleRequiredSigner>[];
  copies: readonly Readonly<TerminalBundleRolePlan>[];
  planHash: string;
}

export interface TerminalBundleContributionSignature {
  copyRole: BundlePartyRole;
  bundleContentHash: string;
  signature: Readonly<BundleSignature>;
}

export interface TerminalBundleSignatureContribution {
  contributionVersion: "1";
  authorityHash: string;
  planHash: string;
  signerRole: BundlePartyRole;
  signer: string;
  signatures: readonly Readonly<TerminalBundleContributionSignature>[];
  contributionHash: string;
}

export interface TerminalBundleSignatureValue {
  copyRole: BundlePartyRole;
  value: string;
}

export interface TerminalBundleSignerPublicKey {
  role: BundlePartyRole;
  primaryClaim: string;
  algorithm: "ed25519";
  publicKey: Uint8Array;
}

export interface TerminalBundleMatrixCopy {
  copyRole: BundlePartyRole;
  bundleContentHash: string;
  signatures: readonly Readonly<BundleSignature>[];
}

export interface TerminalBundleSignatureMatrix {
  matrixVersion: "1";
  authorityHash: string;
  planHash: string;
  copies: readonly Readonly<TerminalBundleMatrixCopy>[];
  matrixHash: string;
}

export interface TerminalBundleOwnRole {
  role: BundlePartyRole;
  primaryClaim: string;
}

type DataRecord = Record<string, unknown>;

function isRecord(value: unknown): value is DataRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

function isCanonicalString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    value.normalize("NFC") === value
  );
}

function isSafeUint(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function exactKeys(
  value: DataRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => keys.includes(key)) && keys.every((key) => allowed.has(key));
}

function captureCanonicalArray<T>(
  value: unknown,
  subject: string,
  captureEntry: (entry: unknown, index: number) => T,
): T[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw new DacsError(`${subject} must be a canonical array`);
  }
  let prototype: object | null;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
      PropertyKey,
      PropertyDescriptor
    >;
  } catch (error) {
    throw new DacsError(`${subject} cannot be inspected safely`, { cause: error });
  }
  if (prototype !== Array.prototype) {
    throw new DacsError(`${subject} must use the intrinsic array prototype`);
  }
  const keys = Reflect.ownKeys(value);
  const expected = new Set<PropertyKey>([
    "length",
    ...Array.from({ length: value.length }, (_, index) => String(index)),
  ]);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new DacsError(`${subject} cannot be sparse or carry extra fields`);
  }
  const out: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new DacsError(`${subject}[${index}] must be an enumerable data property`);
    }
    out.push(captureEntry(descriptor.value, index));
  }
  return out;
}

function captureData(value: unknown, subject: string, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      Math.abs(value) > Number.MAX_SAFE_INTEGER ||
      Object.is(value, -0)
    ) {
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
    if (Array.isArray(value)) {
      return captureCanonicalArray(value, subject, (entry, index) =>
        captureData(entry, `${subject}[${index}]`, ancestors),
      );
    }
    let prototype: object | null;
    let descriptors: Record<PropertyKey, PropertyDescriptor>;
    try {
      prototype = Object.getPrototypeOf(value) as object | null;
      descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
        PropertyKey,
        PropertyDescriptor
      >;
    } catch (error) {
      throw new DacsError(`${subject} cannot be inspected safely`, { cause: error });
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DacsError(`${subject} objects must use a plain prototype`);
    }
    const out: DataRecord = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new DacsError(`${subject} cannot contain symbol fields`);
      }
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
        throw new DacsError(`${subject}.${key} must be an enumerable data property`);
      }
      if (descriptor.value === undefined) {
        throw new DacsError(`${subject}.${key} cannot be undefined`);
      }
      out[key] = captureData(descriptor.value, `${subject}.${key}`, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

function immutableDataSnapshot<T>(value: T, subject: string): T {
  return deepFreeze(captureData(value, subject, new Set<object>()) as T);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as DataRecord)) deepFreeze(child);
  return Object.freeze(value);
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}

function phaseOutcomeClass(terminalClass: TerminalBundleClass): BundleOutcomeClass {
  return terminalClass === "failure"
    ? "failure"
    : terminalClass === "abort"
      ? "abort"
      : "failed-substrate";
}

function phaseIsPreSettlement(kind: PhaseType): boolean {
  return (
    kind === "vet-credentials" ||
    kind.startsWith("negotiate-") ||
    kind.startsWith("commit-")
  );
}

function phaseIsSettlement(kind: PhaseType): boolean {
  return kind.startsWith("pay-") || kind.startsWith("deliver-");
}

function assertEffectObservation(
  value: unknown,
  subject: string,
  finalisedAt: number,
): asserts value is TerminalIrreversibleEffectObservation {
  if (!isRecord(value) || typeof value.disposition !== "string") {
    throw new DacsError(`${subject} is malformed`);
  }
  if (value.disposition === "not-reached") {
    if (!exactKeys(value, ["disposition"])) throw new DacsError(`${subject} is malformed`);
    return;
  }
  if (value.disposition === "authoritatively-absent") {
    if (
      !exactKeys(value, ["disposition", "observationHash", "observedAt"]) ||
      !isHash(value.observationHash) ||
      !isSafeUint(value.observedAt) ||
      value.observedAt > finalisedAt
    ) {
      throw new DacsError(`${subject} authoritative-absence observation is malformed`);
    }
    return;
  }
  if (value.disposition === "final") {
    if (
      !exactKeys(value, ["disposition", "evidenceHash", "observedAt"]) ||
      !isHash(value.evidenceHash) ||
      !isSafeUint(value.observedAt) ||
      value.observedAt > finalisedAt
    ) {
      throw new DacsError(`${subject} final observation is malformed`);
    }
    return;
  }
  if (value.disposition === "indeterminate") {
    if (
      !exactKeys(value, ["disposition", "reason", "observedAt"]) ||
      !isCanonicalString(value.reason) ||
      !isSafeUint(value.observedAt) ||
      value.observedAt > finalisedAt
    ) {
      throw new DacsError(`${subject} indeterminate observation is malformed`);
    }
    return;
  }
  throw new DacsError(`${subject} has an unsupported disposition`);
}

function assertAbortEligibility(
  value: unknown,
  terminalPhase: Readonly<TerminalPhaseAuthority>,
  faultedParty: FaultedParty,
  finalisedAt: number,
): asserts value is TerminalAbortEligibility {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "trigger",
      "triggeredBy",
      "triggerEvidenceHash",
      "observedAt",
      "payment",
      "delivery",
    ]) ||
    (value.trigger !== "declined" &&
      value.trigger !== "withdrawn" &&
      value.trigger !== "timeout") ||
    value.triggeredBy !== faultedParty ||
    !isHash(value.triggerEvidenceHash) ||
    !isSafeUint(value.observedAt) ||
    value.observedAt > finalisedAt
  ) {
    throw new DacsError("abort eligibility does not bind the terminal fault authority");
  }
  assertEffectObservation(value.payment, "abort payment effect", finalisedAt);
  assertEffectObservation(value.delivery, "abort delivery effect", finalisedAt);
  const payment = value.payment as TerminalIrreversibleEffectObservation;
  const delivery = value.delivery as TerminalIrreversibleEffectObservation;
  if (phaseIsPreSettlement(terminalPhase.kind)) {
    if (payment.disposition !== "not-reached" || delivery.disposition !== "not-reached") {
      throw new DacsError(
        "pre-settlement abort requires payment and delivery to be not reached (ST-3/ST-9)",
      );
    }
    return;
  }
  if (phaseIsSettlement(terminalPhase.kind)) {
    if (
      payment.disposition !== "authoritatively-absent" ||
      delivery.disposition !== "authoritatively-absent"
    ) {
      throw new DacsError(
        "settlement-pending abort requires authoritative absence of every irreversible effect; final or ambiguous observations cannot be relabelled as abort (ST-3/ST-9)",
      );
    }
    return;
  }
  throw new DacsError(
    `phase "${terminalPhase.kind}" is post-irreversibility and cannot be published as abort (ST-3/ST-9)`,
  );
}

function referenceSetMaterial(authority: {
  listingRef: Readonly<ListingRef>;
  agreementRef?: Readonly<AttestationRef>;
  phaseSummary: readonly Readonly<PhaseSummaryEntry>[];
  vetRecords: readonly Readonly<AttestationRef>[];
  settlementEvidence: readonly Readonly<AttestationRef>[];
  amendments?: readonly Readonly<AttestationRef>[];
  ratingRefs?: readonly Readonly<AttestationRef>[];
}): DataRecord {
  return {
    listingRef: authority.listingRef,
    ...(authority.agreementRef ? { agreementRef: authority.agreementRef } : {}),
    phaseAttestations: authority.phaseSummary.flatMap((phase) =>
      phase.attestationRef ? [{ index: phase.index, ref: phase.attestationRef }] : [],
    ),
    vetRecords: authority.vetRecords,
    settlementEvidence: authority.settlementEvidence,
    ...(authority.amendments ? { amendments: authority.amendments } : {}),
    ...(authority.ratingRefs ? { ratingRefs: authority.ratingRefs } : {}),
  };
}

function computedReferenceSetHash(
  authority: Parameters<typeof referenceSetMaterial>[0],
): string {
  return sha256Hex(canonicalize(referenceSetMaterial(authority)));
}

function buildSignedScope(
  authority: Readonly<TerminalBundleAuthority>,
  role: BundlePartyRole,
): Record<string, unknown> {
  return {
    faultBundleVersion: "1",
    jobId: authority.jobId,
    outcome: roleRelativeOutcome(
      phaseOutcomeClass(authority.terminalClass),
      authority.faultedParty,
      role,
    ),
    faultedParty: authority.faultedParty,
    listingRef: authority.listingRef,
    ...(authority.agreementRef ? { agreementRef: authority.agreementRef } : {}),
    ...(authority.cancellation ? { cancellation: authority.cancellation } : {}),
    parties: authority.parties,
    phaseSummary: authority.phaseSummary,
    vetRecords: authority.vetRecords,
    settlementEvidence: authority.settlementEvidence,
    ...(authority.amendments ? { amendments: authority.amendments } : {}),
    ...(authority.ratingRefs ? { ratingRefs: authority.ratingRefs } : {}),
    recipeRegistryVersion: authority.recipeRegistryVersion,
    railRegistryVersion: authority.railRegistryVersion,
    finalisedAt: authority.finalisedAt,
  };
}

function placeholderSignatures(parties: readonly Readonly<BundleParty>[]): BundleSignature[] {
  return parties.map((party) => ({
    party: party.primaryClaim,
    algorithm: "ed25519",
    value: "AA",
  }));
}

function assertAuthoritySemantics(authority: Readonly<TerminalBundleAuthority>): void {
  if (
    authority.authorityVersion !== "1" ||
    !isCanonicalString(authority.jobId) ||
    (authority.terminalClass !== "failure" &&
      authority.terminalClass !== "abort" &&
      authority.terminalClass !== "failed-substrate") ||
    !isHash(authority.sessionRecordHash) ||
    !isHash(authority.terminalEvidenceHash) ||
    !isHash(authority.dependencySetHash) ||
    !isHash(authority.referenceSetHash) ||
    !isSafeUint(authority.recipeRegistryVersion) ||
    !isSafeUint(authority.railRegistryVersion) ||
    !isSafeUint(authority.finalisedAt)
  ) {
    throw new DacsError("terminal bundle authority is malformed");
  }
  if (
    !isRecord(authority.terminalPhase) ||
    !exactKeys(authority.terminalPhase as unknown as DataRecord, ["index", "kind", "state"], [
      "errorClass",
    ]) ||
    !isSafeUint(authority.terminalPhase.index) ||
    !PHASE_TYPES.has(authority.terminalPhase.kind) ||
    (authority.terminalPhase.state !== "failed" && authority.terminalPhase.state !== "pending") ||
    (authority.terminalPhase.errorClass !== undefined &&
      !ERROR_CLASSES.has(authority.terminalPhase.errorClass))
  ) {
    throw new DacsError("terminal phase authority is malformed");
  }
  const roles = authority.parties.map((party) => party.role as BundlePartyRole);
  const claims = authority.parties.map((party) => party.primaryClaim);
  if (
    authority.parties.length < 2 ||
    authority.parties.length > 3 ||
    roles[0] !== "buyer" ||
    roles[1] !== "seller" ||
    (roles.length === 3 && roles[2] !== "orchestrator") ||
    new Set(roles).size !== roles.length ||
    new Set(claims).size !== claims.length ||
    authority.parties.some(
      (party) =>
        !isCanonicalString(party.primaryClaim) ||
        !isHash(party.bundleHash),
    )
  ) {
    throw new DacsError("terminal authority must carry the exact canonical session party roster");
  }
  if (
    authority.faultedParty !== "none" &&
    authority.faultedParty !== "buyer" &&
    authority.faultedParty !== "seller" &&
    authority.faultedParty !== "orchestrator"
  ) {
    throw new DacsError("terminal authority has an invalid absolute faultedParty");
  }
  if (
    authority.terminalClass === "failed-substrate"
      ? authority.faultedParty !== "none"
      : authority.faultedParty === "none" || !roles.includes(authority.faultedParty)
  ) {
    throw new DacsError("terminal class and absolute faultedParty do not agree");
  }
  if (
    computedReferenceSetHash(authority) !== authority.referenceSetHash
  ) {
    throw new DacsError("terminal authority reference set hash does not match its exact refs");
  }

  const terminalEntry = authority.phaseSummary.find(
    (entry) => entry.index === authority.terminalPhase.index,
  );
  if (authority.terminalClass === "abort") {
    if (authority.terminalPhase.state !== "pending") {
      throw new DacsError("abort authority must terminate a pending phase");
    }
    if (
      authority.phaseSummary.some((entry) => entry.index >= authority.terminalPhase.index)
    ) {
      throw new DacsError("abort authority cannot relabel an already-recorded terminal phase");
    }
    assertAbortEligibility(
      authority.abortEligibility,
      authority.terminalPhase,
      authority.faultedParty,
      authority.finalisedAt,
    );
    const expectedAbortHash = sha256Hex(canonicalize(authority.abortEligibility));
    if (authority.abortEligibilityHash !== expectedAbortHash) {
      throw new DacsError("abort eligibility hash does not match its exact observations");
    }
  } else {
    if (
      authority.terminalPhase.state !== "failed" ||
      !terminalEntry ||
      terminalEntry.kind !== authority.terminalPhase.kind ||
      terminalEntry.outcome !== "fail" ||
      terminalEntry.errorClass !== authority.terminalPhase.errorClass ||
      authority.phaseSummary.some((entry) => entry.index > authority.terminalPhase.index) ||
      authority.abortEligibility !== undefined ||
      authority.abortEligibilityHash !== undefined
    ) {
      throw new DacsError("failure authority must exactly match its terminal failed phase");
    }
    if (
      authority.terminalClass === "failed-substrate" &&
      authority.terminalPhase.errorClass !== "substrate" &&
      authority.terminalPhase.errorClass !== "settlement-atomicity"
    ) {
      throw new DacsError("failed-substrate authority requires substrate-class terminal evidence");
    }
    if (
      authority.terminalClass === "failure" &&
      (authority.terminalPhase.errorClass === "substrate" ||
        authority.terminalPhase.errorClass === "settlement-atomicity")
    ) {
      throw new DacsError(
        "substrate and settlement-atomicity terminal evidence must be published as blameless failed-substrate",
      );
    }
  }

  const hasCommittedAgreement = authority.phaseSummary.some(
    (phase) => phase.outcome === "ok" && phase.kind.startsWith("commit-"),
  );
  const postCommit =
    hasCommittedAgreement ||
    phaseIsSettlement(authority.terminalPhase.kind) ||
    authority.terminalPhase.kind === "rate" ||
    authority.settlementEvidence.length > 0 ||
    (authority.amendments?.length ?? 0) > 0 ||
    (authority.ratingRefs?.length ?? 0) > 0;
  if (postCommit && authority.agreementRef === undefined) {
    throw new DacsError("terminal authority requires agreementRef at commitment or later");
  }
  if (
    authority.cancellation &&
    (authority.terminalClass !== "abort" ||
      authority.cancellation.claimedPolicy !== "pre-commit" ||
      authority.agreementRef !== undefined ||
      hasCommittedAgreement)
  ) {
    throw new DacsError("cancellation is valid only for an abort before agreement commitment");
  }

  for (const role of roles) {
    const scope = buildSignedScope(authority, role);
    const candidate = {
      ...scope,
      anchoredByRole: role,
      signatures: placeholderSignatures(authority.parties),
    };
    if (!isFaultAttestationBundle(candidate)) {
      throw new DacsError(`terminal authority does not form a normative ${role} bundle scope`);
    }
  }
}

function captureAuthority(value: unknown): TerminalBundleAuthority {
  const authority = immutableDataSnapshot(value, "terminal bundle authority") as unknown;
  if (
    !isRecord(authority) ||
    !exactKeys(
      authority,
      [
        "authorityVersion",
        "jobId",
        "terminalClass",
        "faultedParty",
        "terminalPhase",
        "sessionRecordHash",
        "terminalEvidenceHash",
        "dependencySetHash",
        "referenceSetHash",
        "listingRef",
        "parties",
        "phaseSummary",
        "vetRecords",
        "settlementEvidence",
        "recipeRegistryVersion",
        "railRegistryVersion",
        "finalisedAt",
      ],
      [
        "agreementRef",
        "cancellation",
        "amendments",
        "ratingRefs",
        "abortEligibility",
        "abortEligibilityHash",
      ],
    )
  ) {
    throw new DacsError("terminal bundle authority has a non-canonical shape");
  }
  assertAuthoritySemantics(authority as unknown as TerminalBundleAuthority);
  return authority as unknown as TerminalBundleAuthority;
}

/** Build and immutably capture the exact authority from verified session data. */
export function createTerminalBundleAuthority(
  input: Readonly<TerminalBundleAuthorityInput>,
): Readonly<TerminalBundleAuthority> {
  const captured = immutableDataSnapshot(input, "terminal bundle authority input") as unknown;
  if (
    !isRecord(captured) ||
    !exactKeys(
      captured,
      [
        "jobId",
        "terminalClass",
        "faultedParty",
        "terminalPhase",
        "sessionRecordHash",
        "terminalEvidenceHash",
        "dependencySetHash",
        "listingRef",
        "parties",
        "phaseSummary",
        "vetRecords",
        "settlementEvidence",
        "recipeRegistryVersion",
        "railRegistryVersion",
        "finalisedAt",
      ],
      [
        "agreementRef",
        "cancellation",
        "amendments",
        "ratingRefs",
        "abortEligibility",
      ],
    ) ||
    !Array.isArray(captured.parties)
  ) {
    throw new DacsError("terminal bundle authority input has a non-canonical shape");
  }

  const partiesByRole = new Map<BundlePartyRole, BundleParty>();
  const claims = new Set<string>();
  for (const value of captured.parties) {
    if (
      !isRecord(value) ||
      !exactKeys(value, ["role", "identityBundle"]) ||
      (value.role !== "buyer" && value.role !== "seller" && value.role !== "orchestrator") ||
      !isIdentityBundle(value.identityBundle)
    ) {
      throw new DacsError("terminal party must carry one role and one verified IdentityBundle");
    }
    if (partiesByRole.has(value.role)) {
      throw new DacsError(`terminal party role "${value.role}" is duplicated`);
    }
    if (claims.has(value.identityBundle.presentedBy)) {
      throw new DacsError("terminal party primary claims must be distinct by role");
    }
    claims.add(value.identityBundle.presentedBy);
    partiesByRole.set(value.role, {
      role: value.role,
      primaryClaim: value.identityBundle.presentedBy,
      bundleHash: identityBundleHash(value.identityBundle),
    });
  }
  if (!partiesByRole.has("buyer") || !partiesByRole.has("seller")) {
    throw new DacsError("terminal authority requires verified buyer and seller identities");
  }
  const parties = ROLE_ORDER.flatMap((role) => {
    const party = partiesByRole.get(role);
    return party ? [party] : [];
  });

  const base = {
    authorityVersion: "1" as const,
    jobId: captured.jobId,
    terminalClass: captured.terminalClass,
    faultedParty: captured.faultedParty,
    terminalPhase: captured.terminalPhase,
    sessionRecordHash: captured.sessionRecordHash,
    terminalEvidenceHash: captured.terminalEvidenceHash,
    dependencySetHash: captured.dependencySetHash,
    listingRef: captured.listingRef,
    ...(captured.agreementRef ? { agreementRef: captured.agreementRef } : {}),
    ...(captured.cancellation ? { cancellation: captured.cancellation } : {}),
    parties,
    phaseSummary: captured.phaseSummary,
    vetRecords: captured.vetRecords,
    settlementEvidence: captured.settlementEvidence,
    ...(captured.amendments ? { amendments: captured.amendments } : {}),
    ...(captured.ratingRefs ? { ratingRefs: captured.ratingRefs } : {}),
    recipeRegistryVersion: captured.recipeRegistryVersion,
    railRegistryVersion: captured.railRegistryVersion,
    finalisedAt: captured.finalisedAt,
    ...(captured.abortEligibility
      ? {
          abortEligibility: captured.abortEligibility,
          abortEligibilityHash: sha256Hex(canonicalize(captured.abortEligibility)),
        }
      : {}),
  } as unknown as Omit<TerminalBundleAuthority, "referenceSetHash">;
  const authority = {
    ...base,
    referenceSetHash: computedReferenceSetHash(base),
  } as TerminalBundleAuthority;
  assertAuthoritySemantics(authority);
  return deepFreeze(authority);
}

/** Canonical hash carried by every plan and detached contribution. */
export function terminalBundleAuthorityHash(
  authority: Readonly<TerminalBundleAuthority>,
): string {
  const captured = captureAuthority(authority);
  return sha256Hex(canonicalize(captured));
}

function planHashMaterial(plan: Omit<TerminalBundlePlan, "planHash">): DataRecord {
  return {
    planVersion: plan.planVersion,
    authorityHash: plan.authorityHash,
    signingMode: plan.signingMode,
    requiredSigners: plan.requiredSigners,
    copies: plan.copies.map((copy) => ({
      role: copy.role,
      outcome: copy.outcome,
      bundleContentHash: copy.bundleContentHash,
    })),
  };
}

function derivePlan(
  authority: Readonly<TerminalBundleAuthority>,
  signingMode: Readonly<TerminalBundleSigningMode>,
): TerminalBundlePlan {
  const roles = authority.parties.map((party) => party.role as BundlePartyRole);
  let signerRoles: BundlePartyRole[];
  if (signingMode.kind === "co-signed") {
    signerRoles = roles;
  } else {
    if (authority.terminalClass !== "abort") {
      throw new DacsError("only an abort authority may use the single-signed suppression path");
    }
    if (!roles.includes(signingMode.signerRole)) {
      throw new DacsError("single-signed abort signer is not a role in the session roster");
    }
    if (signingMode.signerRole === authority.faultedParty) {
      throw new DacsError("single-signed abort signer must own its role and must not be faulted");
    }
    signerRoles = [signingMode.signerRole];
  }
  const requiredSigners = signerRoles.map((role) => {
    const party = authority.parties.find((candidate) => candidate.role === role)!;
    return { role, primaryClaim: party.primaryClaim };
  });
  const copies = signerRoles.map((role): TerminalBundleRolePlan => {
    const signedScope = buildSignedScope(authority, role);
    const bundleContentHash = sha256Hex(canonicalize(signedScope));
    return {
      role,
      outcome: signedScope.outcome as BundleOutcome,
      signedScope,
      bundleContentHash,
      signedBytes: [...signedBytes(ARTIFACT_SEPARATORS.FaultAttestationBundle, bundleContentHash)],
    };
  });
  const withoutHash: Omit<TerminalBundlePlan, "planHash"> = {
    planVersion: "1",
    authority,
    authorityHash: sha256Hex(canonicalize(authority)),
    signingMode,
    requiredSigners,
    copies,
  };
  return {
    ...withoutHash,
    planHash: sha256Hex(canonicalize(planHashMaterial(withoutHash))),
  };
}

function captureSigningMode(value: unknown): TerminalBundleSigningMode {
  const mode = immutableDataSnapshot(value, "terminal bundle signing mode") as unknown;
  if (!isRecord(mode) || typeof mode.kind !== "string") {
    throw new DacsError("terminal bundle signing mode is malformed");
  }
  if (mode.kind === "co-signed" && exactKeys(mode, ["kind"])) {
    return mode as unknown as TerminalBundleSigningMode;
  }
  if (
    mode.kind === "single-signed-abort" &&
    exactKeys(mode, ["kind", "signerRole"]) &&
    (mode.signerRole === "buyer" ||
      mode.signerRole === "seller" ||
      mode.signerRole === "orchestrator")
  ) {
    return mode as unknown as TerminalBundleSigningMode;
  }
  throw new DacsError("terminal bundle signing mode is malformed");
}

/** Derive every exact role scope and its domain-separated signing bytes. */
export function createTerminalBundlePlan(
  authority: Readonly<TerminalBundleAuthority>,
  signingMode: Readonly<TerminalBundleSigningMode>,
): Readonly<TerminalBundlePlan> {
  const capturedAuthority = captureAuthority(authority);
  const capturedMode = captureSigningMode(signingMode);
  return deepFreeze(derivePlan(capturedAuthority, capturedMode));
}

function capturePlan(value: unknown): TerminalBundlePlan {
  const plan = immutableDataSnapshot(value, "terminal bundle plan") as unknown;
  if (
    !isRecord(plan) ||
    !exactKeys(plan, [
      "planVersion",
      "authority",
      "authorityHash",
      "signingMode",
      "requiredSigners",
      "copies",
      "planHash",
    ])
  ) {
    throw new DacsError("terminal bundle plan has a non-canonical shape");
  }
  const authority = captureAuthority(plan.authority);
  const mode = captureSigningMode(plan.signingMode);
  const expected = deepFreeze(derivePlan(authority, mode));
  if (!sameCanonicalValue(plan, expected)) {
    throw new DacsError("terminal bundle plan does not match its exact authority");
  }
  return plan as unknown as TerminalBundlePlan;
}

/** Return fresh bytes so no caller can mutate the immutable role plan. */
export function terminalBundleSignedBytes(
  copy: Readonly<TerminalBundleRolePlan>,
): Uint8Array {
  const captured = immutableDataSnapshot(copy, "terminal bundle role plan") as unknown;
  if (
    !isRecord(captured) ||
    !exactKeys(captured, [
      "role",
      "outcome",
      "signedScope",
      "bundleContentHash",
      "signedBytes",
    ]) ||
    !isHash(captured.bundleContentHash) ||
    !isRecord(captured.signedScope) ||
    sha256Hex(canonicalize(captured.signedScope)) !== captured.bundleContentHash ||
    !Array.isArray(captured.signedBytes)
  ) {
    throw new DacsError("terminal bundle role plan is malformed");
  }
  const expected = signedBytes(
    ARTIFACT_SEPARATORS.FaultAttestationBundle,
    captured.bundleContentHash,
  );
  if (
    captured.signedBytes.length !== expected.byteLength ||
    captured.signedBytes.some(
      (byte, index) => !Number.isInteger(byte) || byte !== expected[index],
    )
  ) {
    throw new DacsError("terminal bundle signed bytes do not match its content hash");
  }
  return new Uint8Array(expected);
}

function contributionHashMaterial(
  contribution: Omit<TerminalBundleSignatureContribution, "contributionHash">,
): DataRecord {
  return {
    contributionVersion: contribution.contributionVersion,
    authorityHash: contribution.authorityHash,
    planHash: contribution.planHash,
    signerRole: contribution.signerRole,
    signer: contribution.signer,
    signatures: contribution.signatures,
  };
}

/**
 * Package one local role's signatures over every planned copy. Signature production happens
 * outside this module; accepting values instead of a callback prevents it becoming a remote
 * signing oracle.
 */
export function createTerminalBundleSignatureContribution(
  plan: Readonly<TerminalBundlePlan>,
  signerRole: BundlePartyRole,
  values: readonly Readonly<TerminalBundleSignatureValue>[],
): Readonly<TerminalBundleSignatureContribution> {
  const capturedPlan = capturePlan(plan);
  const signer = capturedPlan.requiredSigners.find((entry) => entry.role === signerRole);
  if (!signer) {
    throw new DacsError(`role "${signerRole}" is not a required signer for this plan`);
  }
  const capturedValues = immutableDataSnapshot(values, "terminal signature values") as unknown;
  if (!Array.isArray(capturedValues)) {
    throw new DacsError("terminal signature values must be an array");
  }
  const byRole = new Map<BundlePartyRole, string>();
  for (const entry of capturedValues) {
    if (
      !isRecord(entry) ||
      !exactKeys(entry, ["copyRole", "value"]) ||
      (entry.copyRole !== "buyer" &&
        entry.copyRole !== "seller" &&
        entry.copyRole !== "orchestrator") ||
      !isCanonicalBase64Url(entry.value) ||
      Buffer.from(entry.value, "base64url").byteLength !== 64
    ) {
      throw new DacsError("terminal contribution carries a malformed Ed25519 signature value");
    }
    if (byRole.has(entry.copyRole)) {
      throw new DacsError(`terminal contribution duplicates copy role "${entry.copyRole}"`);
    }
    byRole.set(entry.copyRole, entry.value);
  }
  if (
    byRole.size !== capturedPlan.copies.length ||
    capturedPlan.copies.some((copy) => !byRole.has(copy.role))
  ) {
    throw new DacsError("terminal contribution must sign every planned role copy exactly once");
  }
  const signatures = capturedPlan.copies.map(
    (copy): TerminalBundleContributionSignature => ({
      copyRole: copy.role,
      bundleContentHash: copy.bundleContentHash,
      signature: {
        party: signer.primaryClaim,
        algorithm: "ed25519",
        value: byRole.get(copy.role)!,
      },
    }),
  );
  const withoutHash: Omit<TerminalBundleSignatureContribution, "contributionHash"> = {
    contributionVersion: "1",
    authorityHash: capturedPlan.authorityHash,
    planHash: capturedPlan.planHash,
    signerRole,
    signer: signer.primaryClaim,
    signatures,
  };
  return deepFreeze({
    ...withoutHash,
    contributionHash: sha256Hex(canonicalize(contributionHashMaterial(withoutHash))),
  });
}

function captureContribution(
  plan: Readonly<TerminalBundlePlan>,
  value: unknown,
): TerminalBundleSignatureContribution {
  const contribution = immutableDataSnapshot(value, "terminal signature contribution") as unknown;
  if (
    !isRecord(contribution) ||
    !exactKeys(contribution, [
      "contributionVersion",
      "authorityHash",
      "planHash",
      "signerRole",
      "signer",
      "signatures",
      "contributionHash",
    ]) ||
    contribution.contributionVersion !== "1" ||
    contribution.authorityHash !== plan.authorityHash ||
    contribution.planHash !== plan.planHash ||
    !Array.isArray(contribution.signatures)
  ) {
    throw new DacsError("terminal signature contribution is malformed or rebound");
  }
  const expectedSigner = plan.requiredSigners.find(
    (entry) => entry.role === contribution.signerRole,
  );
  if (!expectedSigner || contribution.signer !== expectedSigner.primaryClaim) {
    throw new DacsError("terminal signature contribution substitutes a signer role or claim");
  }
  if (contribution.signatures.length !== plan.copies.length) {
    throw new DacsError("terminal signature contribution is missing a planned copy signature");
  }
  const seen = new Set<BundlePartyRole>();
  for (const entry of contribution.signatures) {
    if (
      !isRecord(entry) ||
      !exactKeys(entry, ["copyRole", "bundleContentHash", "signature"]) ||
      !isRecord(entry.signature) ||
      !exactKeys(entry.signature, ["party", "algorithm", "value"]) ||
      entry.signature.party !== expectedSigner.primaryClaim ||
      entry.signature.algorithm !== "ed25519" ||
      !isCanonicalBase64Url(entry.signature.value) ||
      Buffer.from(entry.signature.value, "base64url").byteLength !== 64
    ) {
      throw new DacsError("terminal contribution signature envelope is malformed or substituted");
    }
    const expectedCopy = plan.copies.find((copy) => copy.role === entry.copyRole);
    if (
      !expectedCopy ||
      entry.bundleContentHash !== expectedCopy.bundleContentHash ||
      seen.has(expectedCopy.role)
    ) {
      throw new DacsError("terminal contribution substitutes or duplicates a planned copy");
    }
    seen.add(expectedCopy.role);
  }
  const expectedHash = sha256Hex(
    canonicalize(
      contributionHashMaterial(
        contribution as unknown as TerminalBundleSignatureContribution,
      ),
    ),
  );
  if (contribution.contributionHash !== expectedHash) {
    throw new DacsError("terminal contribution hash does not match its exact signature row");
  }
  return contribution as unknown as TerminalBundleSignatureContribution;
}

interface CapturedSignerKey {
  role: BundlePartyRole;
  primaryClaim: string;
  publicKey: Uint8Array;
}

function captureSignerKey(value: unknown, index: number): CapturedSignerKey {
  const subject = `terminal signer keys[${index}]`;
  if (!isRecord(value) || nodeTypes.isProxy(value)) {
    throw new DacsError(`${subject} must be a plain data record`);
  }
  let prototype: object | null;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
      PropertyKey,
      PropertyDescriptor
    >;
  } catch (error) {
    throw new DacsError(`${subject} cannot be inspected safely`, { cause: error });
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new DacsError(`${subject} must use a plain prototype`);
  }
  const keys = Reflect.ownKeys(value);
  const expectedKeys = ["role", "primaryClaim", "algorithm", "publicKey"];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key)) ||
    expectedKeys.some((key) => {
      const descriptor = descriptors[key];
      return !descriptor || descriptor.enumerable !== true || !("value" in descriptor);
    })
  ) {
    throw new DacsError(`${subject} has a non-canonical data-only shape`);
  }
  const role = descriptors.role!.value as unknown;
  const primaryClaim = descriptors.primaryClaim!.value as unknown;
  const algorithm = descriptors.algorithm!.value as unknown;
  const publicKey = descriptors.publicKey!.value as unknown;
  if (
    (role !== "buyer" && role !== "seller" && role !== "orchestrator") ||
    !isCanonicalString(primaryClaim) ||
    algorithm !== "ed25519" ||
    !(publicKey instanceof Uint8Array) ||
    nodeTypes.isProxy(publicKey) ||
    Object.getPrototypeOf(publicKey) !== Uint8Array.prototype ||
    Object.getPrototypeOf(publicKey.buffer) !== ArrayBuffer.prototype ||
    publicKey.byteOffset !== 0 ||
    publicKey.byteLength !== 32 ||
    publicKey.byteLength !== publicKey.buffer.byteLength ||
    Reflect.ownKeys(publicKey).some((key, keyIndex) => key !== String(keyIndex))
  ) {
    throw new DacsError(`${subject} must carry one canonical raw Ed25519 public key`);
  }
  return { role, primaryClaim, publicKey: new Uint8Array(publicKey) };
}

function captureSignerKeys(value: unknown): CapturedSignerKey[] {
  return captureCanonicalArray(value, "terminal signer keys", captureSignerKey);
}

function assertExactSignerKeys(
  plan: Readonly<TerminalBundlePlan>,
  values: unknown,
): Map<BundlePartyRole, CapturedSignerKey> {
  const keys = captureSignerKeys(values);
  const byRole = new Map<BundlePartyRole, CapturedSignerKey>();
  for (const key of keys) {
    if (byRole.has(key.role)) throw new DacsError(`terminal signer key role "${key.role}" is duplicated`);
    byRole.set(key.role, key);
  }
  if (keys.length !== plan.requiredSigners.length) {
    throw new DacsError("terminal signer key set does not exactly match the required signer set");
  }
  for (const signer of plan.requiredSigners) {
    const key = byRole.get(signer.role);
    if (!key || key.primaryClaim !== signer.primaryClaim) {
      throw new DacsError("terminal signer key substitutes or omits a required signer");
    }
  }
  return byRole;
}

function verifySignature(
  copy: Readonly<TerminalBundleRolePlan>,
  signature: Readonly<BundleSignature>,
  publicKey: Uint8Array,
): void {
  const bytes = Uint8Array.from(Buffer.from(signature.value, "base64url"));
  if (
    bytes.byteLength !== 64 ||
    !ed25519Verify(terminalBundleSignedBytes(copy), bytes, publicKeyFromRaw(publicKey))
  ) {
    throw new DacsError(
      `terminal signature by "${signature.party}" does not verify for ${copy.role} copy`,
    );
  }
}

function matrixHashMaterial(
  matrix: Omit<TerminalBundleSignatureMatrix, "matrixHash">,
): DataRecord {
  return {
    matrixVersion: matrix.matrixVersion,
    authorityHash: matrix.authorityHash,
    planHash: matrix.planHash,
    copies: matrix.copies,
  };
}

/**
 * Verify and transpose the exact `[signerRole][copyRole]` contribution rows into canonical copy
 * columns. No bundle can be assembled until every required cell verifies.
 */
export function createTerminalBundleSignatureMatrix(
  plan: Readonly<TerminalBundlePlan>,
  contributions: readonly unknown[],
  signerKeys: readonly Readonly<TerminalBundleSignerPublicKey>[],
): Readonly<TerminalBundleSignatureMatrix> {
  const capturedPlan = capturePlan(plan);
  const capturedContributions = captureCanonicalArray(
    contributions,
    "terminal signature contributions",
    (entry) => captureContribution(capturedPlan, entry),
  );
  if (capturedContributions.length !== capturedPlan.requiredSigners.length) {
    throw new DacsError("terminal signature matrix is missing a required signer contribution");
  }
  const contributionsByRole = new Map<BundlePartyRole, TerminalBundleSignatureContribution>();
  for (const contribution of capturedContributions) {
    if (contributionsByRole.has(contribution.signerRole)) {
      throw new DacsError(
        `terminal signature matrix duplicates signer role "${contribution.signerRole}"`,
      );
    }
    contributionsByRole.set(contribution.signerRole, contribution);
  }
  for (const signer of capturedPlan.requiredSigners) {
    if (!contributionsByRole.has(signer.role)) {
      throw new DacsError(`terminal signature matrix omits signer role "${signer.role}"`);
    }
  }
  const keysByRole = assertExactSignerKeys(capturedPlan, signerKeys);
  const copies = capturedPlan.copies.map((copy): TerminalBundleMatrixCopy => {
    const signatures = capturedPlan.requiredSigners.map((signer) => {
      const contribution = contributionsByRole.get(signer.role)!;
      const entry = contribution.signatures.find((candidate) => candidate.copyRole === copy.role)!;
      const key = keysByRole.get(signer.role)!;
      verifySignature(copy, entry.signature, key.publicKey);
      return {
        party: entry.signature.party,
        algorithm: entry.signature.algorithm,
        value: entry.signature.value,
      };
    });
    return {
      copyRole: copy.role,
      bundleContentHash: copy.bundleContentHash,
      signatures,
    };
  });
  const withoutHash: Omit<TerminalBundleSignatureMatrix, "matrixHash"> = {
    matrixVersion: "1",
    authorityHash: capturedPlan.authorityHash,
    planHash: capturedPlan.planHash,
    copies,
  };
  return deepFreeze({
    ...withoutHash,
    matrixHash: sha256Hex(canonicalize(matrixHashMaterial(withoutHash))),
  });
}

function captureAndVerifyMatrix(
  plan: Readonly<TerminalBundlePlan>,
  value: unknown,
  signerKeys: readonly Readonly<TerminalBundleSignerPublicKey>[],
): TerminalBundleSignatureMatrix {
  const matrix = immutableDataSnapshot(value, "terminal signature matrix") as unknown;
  if (
    !isRecord(matrix) ||
    !exactKeys(matrix, [
      "matrixVersion",
      "authorityHash",
      "planHash",
      "copies",
      "matrixHash",
    ]) ||
    matrix.matrixVersion !== "1" ||
    matrix.authorityHash !== plan.authorityHash ||
    matrix.planHash !== plan.planHash ||
    !Array.isArray(matrix.copies) ||
    matrix.copies.length !== plan.copies.length
  ) {
    throw new DacsError("terminal signature matrix is malformed or rebound");
  }
  const keysByRole = assertExactSignerKeys(plan, signerKeys);
  for (let copyIndex = 0; copyIndex < plan.copies.length; copyIndex += 1) {
    const expectedCopy = plan.copies[copyIndex]!;
    const copy = matrix.copies[copyIndex];
    if (
      !isRecord(copy) ||
      !exactKeys(copy, ["copyRole", "bundleContentHash", "signatures"]) ||
      copy.copyRole !== expectedCopy.role ||
      copy.bundleContentHash !== expectedCopy.bundleContentHash ||
      !Array.isArray(copy.signatures) ||
      copy.signatures.length !== plan.requiredSigners.length
    ) {
      throw new DacsError("terminal signature matrix substitutes or omits a planned copy");
    }
    for (let signerIndex = 0; signerIndex < plan.requiredSigners.length; signerIndex += 1) {
      const expectedSigner = plan.requiredSigners[signerIndex]!;
      const signature = copy.signatures[signerIndex];
      if (
        !isRecord(signature) ||
        !exactKeys(signature, ["party", "algorithm", "value"]) ||
        signature.party !== expectedSigner.primaryClaim ||
        signature.algorithm !== "ed25519" ||
        !isCanonicalBase64Url(signature.value) ||
        Buffer.from(signature.value, "base64url").byteLength !== 64
      ) {
        throw new DacsError("terminal signature matrix substitutes a required signer");
      }
      verifySignature(
        expectedCopy,
        signature as unknown as BundleSignature,
        keysByRole.get(expectedSigner.role)!.publicKey,
      );
    }
  }
  const expectedHash = sha256Hex(
    canonicalize(
      matrixHashMaterial(matrix as unknown as TerminalBundleSignatureMatrix),
    ),
  );
  if (matrix.matrixHash !== expectedHash) {
    throw new DacsError("terminal signature matrix hash does not match its exact cells");
  }
  return matrix as unknown as TerminalBundleSignatureMatrix;
}

/**
 * Assemble exactly one locally identified role copy after re-verifying the full matrix. The
 * function never returns or constructs another role's publication request as a side effect.
 */
export function assembleTerminalBundleForOwnRole(
  plan: Readonly<TerminalBundlePlan>,
  matrix: Readonly<TerminalBundleSignatureMatrix>,
  ownRole: Readonly<TerminalBundleOwnRole>,
  signerKeys: readonly Readonly<TerminalBundleSignerPublicKey>[],
): Readonly<FaultAttestationBundle> {
  const capturedPlan = capturePlan(plan);
  const capturedOwnRole = immutableDataSnapshot(ownRole, "terminal bundle own role") as unknown;
  if (
    !isRecord(capturedOwnRole) ||
    !exactKeys(capturedOwnRole, ["role", "primaryClaim"]) ||
    (capturedOwnRole.role !== "buyer" &&
      capturedOwnRole.role !== "seller" &&
      capturedOwnRole.role !== "orchestrator") ||
    !isCanonicalString(capturedOwnRole.primaryClaim)
  ) {
    throw new DacsError("terminal bundle own-role identity is malformed");
  }
  const expectedOwner = capturedPlan.requiredSigners.find(
    (signer) => signer.role === capturedOwnRole.role,
  );
  if (!expectedOwner || expectedOwner.primaryClaim !== capturedOwnRole.primaryClaim) {
    throw new DacsError("terminal bundle may be assembled only for the exact locally owned role");
  }
  const capturedMatrix = captureAndVerifyMatrix(capturedPlan, matrix, signerKeys);
  const copy = capturedPlan.copies.find((candidate) => candidate.role === capturedOwnRole.role)!;
  const matrixCopy = capturedMatrix.copies.find(
    (candidate) => candidate.copyRole === capturedOwnRole.role,
  )!;
  const bundle = {
    ...copy.signedScope,
    anchoredByRole: capturedOwnRole.role,
    signatures: matrixCopy.signatures.map((signature) => ({ ...signature })),
  };
  if (!isFaultAttestationBundle(bundle)) {
    throw new DacsError("terminal signature matrix does not assemble a normative own-role bundle");
  }
  return deepFreeze(bundle);
}
