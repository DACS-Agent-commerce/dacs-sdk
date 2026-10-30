import { types as nodeTypes } from "node:util";

import type {
  AnchorReceipt,
  AttestationRef,
  BundleRequirement,
  ChainTxRef,
  ClaimRequirement,
  ListingRef,
  PhaseStep,
  VerificationMethod,
  VerifyResultRef,
} from "../artifacts/types.js";
import {
  isAnchorReceipt,
  isAttestationRef,
  isBundleRequirement,
  isChainTxRef,
  isPhaseStep,
} from "../artifacts/index.js";
import { canonicalize, encodeAddressSegment, sha256Hex } from "../canonical/index.js";
import { presenceRequirementPreflight } from "../agent/compositeVerification.js";

/** CORE SIG-4 SDK-operational extension; deliberately outside the closed registry. */
export const SELLER_FULFILMENT_AUDIT_SOURCE_COMMITMENT_SEPARATOR =
  "dacs-x-seller-fulfilment-audit-source:v1:" as const;

export interface SellerSessionPhaseHandlerResult {
  ok: boolean;
  reason?: string;
  txRefs?: ChainTxRef[];
  explorerUrls?: string[];
  contextDelta?: Record<string, unknown>;
  attestationRef?: AttestationRef;
  anchorReceipt?: AnchorReceipt;
  errorClass?:
    | "permanent"
    | "transient"
    | "counterparty"
    | "substrate"
    | "settlement-atomicity";
}

export interface SellerSessionPhaseEntry {
  index: number;
  step: PhaseStep;
  invokedAt: number;
  result: SellerSessionPhaseHandlerResult;
  contextDelta: Record<string, unknown>;
}

/** Exact authenticated pre-delivery DACS-5 SessionRecord snapshot. */
export interface SellerFulfilmentSessionRecord {
  recordVersion: "1";
  jobId: string;
  state: string;
  listingRef: ListingRef;
  parties: Array<{
    role: "buyer" | "seller" | "orchestrator";
    bundleHash: string;
    primaryClaim: string;
    vetRecordRef?: AttestationRef;
  }>;
  pipeline: PhaseStep[];
  phaseResults: SellerSessionPhaseEntry[];
  startedAt: number;
  lastUpdatedAt: number;
  endedAt?: number;
  recipeRegistryVersion: number;
  railRegistryVersion: number;
  amendments?: AttestationRef[];
}

/** Exact claim/result provenance needed to re-authenticate a VPC-2 vet record. */
export interface SellerFulfilmentExpectedVerifyResult {
  ref: VerifyResultRef;
  /** Job that originally produced this VerifyResult logical address. */
  sourceJobId: string;
  scheme: string;
  identifier: string;
  method: VerificationMethod["kind"];
  requirement: ClaimRequirement;
}

/**
 * Off-chain VPC-2 invocation facts retained beside the SessionRecord.
 *
 * A `verified` V2 audit-source resolver MUST authenticate the exact
 * complementary requirement body's supplier/acceptance for this job. The
 * fulfilment core binds `verifier` to the authenticated session orchestrator,
 * and rebinds the Listing-owned buyer requirement directly. This operational
 * seam is not normative provenance while DACS-Standard #331 remains open.
 */
export interface SellerFulfilmentVetRequirementInvocation {
  vetRecordRef: AttestationRef;
  evaluatedParty: string;
  requirement: BundleRequirement;
  verifier: string;
  freshness: SellerFulfilmentExpectedVerifyResult[];
  dealSpecific: SellerFulfilmentExpectedVerifyResult[];
}

export interface SellerFulfilmentAuditArtifactsV1 {
  agreementCommitment: AttestationRef;
  vetRecords: AttestationRef[];
  vetRequirements: SellerFulfilmentVetRequirementInvocation[];
  settlementEvidence: AttestationRef[];
  ratingRecords?: AttestationRef[];
}

/**
 * Lossless authenticated source retained before the first delivery effect.
 *
 * This is operational provenance, not a DACS wire artifact. Later durable
 * lifecycle layers can append terminal delivery facts and derive one exact
 * `audit-pending` SessionRecord without an application-owned job database.
 */
export interface SellerFulfilmentAuditSourceV1 {
  sourceVersion: "1";
  session: SellerFulfilmentSessionRecord;
  artifacts: SellerFulfilmentAuditArtifactsV1;
  provenanceProfile: "dacs-sdk-operational-v1";
}

const HASH_RE = /^[0-9a-f]{64}$/;
const METHOD_KINDS: ReadonlySet<string> = new Set([
  "verifiable-credential",
  "tlsnotary",
  "zktls",
  "consensus-backed-proxy",
  "oauth-attested",
  "evm-rpc",
  "domain-tls-control",
  "self-signed",
  "demos-gcr-domain",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isNonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;
const isSafeUint = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 &&
  !Object.is(value, -0);
const isPositiveSafeInt = (value: unknown): value is number =>
  isSafeUint(value) && value > 0;
const hasExactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
};

function isCanonicalJsonString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return value.normalize("NFC") === value;
}

/** Reject every JavaScript view that exact JSON/JCS would omit or alias. */
export function hasExactJcsView(
  value: unknown,
  ancestors = new WeakSet<object>(),
): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return isCanonicalJsonString(value);
  if (typeof value === "number") {
    return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER &&
      !Object.is(value, -0);
  }
  if (typeof value !== "object" || nodeTypes.isProxy(value) || ancestors.has(value)) {
    return false;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return false;
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== "string") ||
          keys.length !== value.length + 1 || !keys.includes("length")) return false;
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (!lengthDescriptor || !("value" in lengthDescriptor) ||
          lengthDescriptor.value !== value.length) return false;
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor) ||
            !hasExactJcsView(descriptor.value, ancestors)) return false;
      }
      return true;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return false;
    for (const key of keys as string[]) {
      if (!isCanonicalJsonString(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor) ||
          descriptor.value === undefined ||
          !hasExactJcsView(descriptor.value, ancestors)) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    ancestors.delete(value);
  }
}

function isListingRef(value: unknown): value is ListingRef {
  return isRecord(value) && hasExactKeys(value, [
    "listingId", "version", "contentHash",
  ]) && isNonEmpty(value.listingId) && isPositiveSafeInt(value.version) &&
    typeof value.contentHash === "string" && HASH_RE.test(value.contentHash);
}

function isClaimRequirement(value: unknown): value is ClaimRequirement {
  return isRecord(value) && isNonEmpty(value.scheme) &&
    /^[a-z][a-z0-9-]*$/.test(value.scheme) &&
    typeof value.verificationRequired === "boolean" &&
    (value.maxAge === undefined || isSafeUint(value.maxAge)) &&
    (value.recipeVersion === undefined || isPositiveSafeInt(value.recipeVersion)) &&
    (value.parameters === undefined || isRecord(value.parameters));
}

function isStrictBundleRequirement(value: unknown): value is BundleRequirement {
  if (!isRecord(value) || !isBundleRequirement(value) || !Array.isArray(value.required) ||
      !value.required.every(isClaimRequirement)) return false;
  return value.oneOf === undefined ||
    (Array.isArray(value.oneOf) && value.oneOf.every(
      (group) => Array.isArray(group) && group.every(isClaimRequirement),
    ));
}

function isVerifyResultRef(value: unknown): value is VerifyResultRef {
  return isRecord(value) && isRecord(value.anchor) &&
    ["storage-program", "ipfs", "https"].includes(String(value.anchor.kind)) &&
    isNonEmpty(value.anchor.locator) && typeof value.contentHash === "string" &&
    HASH_RE.test(value.contentHash) && isPositiveSafeInt(value.recipeVersion);
}

function isExpectedVerifyResult(
  value: unknown,
): value is SellerFulfilmentExpectedVerifyResult {
  return isRecord(value) && hasExactKeys(value, [
    "ref", "sourceJobId", "scheme", "identifier", "method", "requirement",
  ]) && isVerifyResultRef(value.ref) && isNonEmpty(value.sourceJobId) &&
    !/[%:?&=]/u.test(value.sourceJobId) && isNonEmpty(value.scheme) &&
    isNonEmpty(value.identifier) && typeof value.method === "string" &&
    METHOD_KINDS.has(value.method) && isClaimRequirement(value.requirement);
}

function isVetRequirementInvocation(
  value: unknown,
): value is SellerFulfilmentVetRequirementInvocation {
  return isRecord(value) && hasExactKeys(value, [
    "vetRecordRef", "evaluatedParty", "requirement", "verifier",
    "freshness", "dealSpecific",
  ]) && isAttestationRef(value.vetRecordRef) && isNonEmpty(value.evaluatedParty) &&
    isStrictBundleRequirement(value.requirement) && isNonEmpty(value.verifier) &&
    Array.isArray(value.freshness) && value.freshness.every(isExpectedVerifyResult) &&
    Array.isArray(value.dealSpecific) && value.dealSpecific.every(isExpectedVerifyResult);
}

function isSessionResult(value: unknown): value is SellerSessionPhaseHandlerResult {
  return isRecord(value) && hasExactKeys(
    value,
    ["ok"],
    [
      "reason", "txRefs", "explorerUrls", "contextDelta", "attestationRef",
      "anchorReceipt", "errorClass",
    ],
  ) && typeof value.ok === "boolean" &&
    (value.reason === undefined || isNonEmpty(value.reason)) &&
    (value.txRefs === undefined ||
      (Array.isArray(value.txRefs) && value.txRefs.every(isChainTxRef))) &&
    (value.explorerUrls === undefined ||
      (Array.isArray(value.explorerUrls) && value.explorerUrls.every(isNonEmpty))) &&
    (value.contextDelta === undefined || isRecord(value.contextDelta)) &&
    (value.attestationRef === undefined || isAttestationRef(value.attestationRef)) &&
    (value.anchorReceipt === undefined || isAnchorReceipt(value.anchorReceipt)) &&
    (value.errorClass === undefined || [
      "permanent", "transient", "counterparty", "substrate", "settlement-atomicity",
    ].includes(String(value.errorClass)));
}

function isSessionPhaseEntry(value: unknown): value is SellerSessionPhaseEntry {
  return isRecord(value) && hasExactKeys(value, [
    "index", "step", "invokedAt", "result", "contextDelta",
  ]) && isSafeUint(value.index) && isPhaseStep(value.step) &&
    isSafeUint(value.invokedAt) && isSessionResult(value.result) &&
    isRecord(value.contextDelta);
}

/** Strict structural guard for an authenticated pre-delivery SessionRecord. */
export function isSellerFulfilmentSessionRecord(
  value: unknown,
): value is SellerFulfilmentSessionRecord {
  if (!hasExactJcsView(value) || !isRecord(value) || !hasExactKeys(
    value,
    [
      "recordVersion", "jobId", "state", "listingRef", "parties", "pipeline",
      "phaseResults", "startedAt", "lastUpdatedAt", "recipeRegistryVersion",
      "railRegistryVersion",
    ],
    ["endedAt", "amendments"],
  ) || value.recordVersion !== "1" || !isNonEmpty(value.jobId) ||
      !isNonEmpty(value.state) || !isListingRef(value.listingRef) ||
      !Array.isArray(value.parties) || !Array.isArray(value.pipeline) ||
      !value.pipeline.every(isPhaseStep) || !Array.isArray(value.phaseResults) ||
      !value.phaseResults.every(isSessionPhaseEntry) || !isSafeUint(value.startedAt) ||
      !isSafeUint(value.lastUpdatedAt) || value.lastUpdatedAt < value.startedAt ||
      (value.endedAt !== undefined &&
        (!isSafeUint(value.endedAt) || value.endedAt < value.lastUpdatedAt)) ||
      !isPositiveSafeInt(value.recipeRegistryVersion) ||
      !isPositiveSafeInt(value.railRegistryVersion) ||
      (value.amendments !== undefined &&
        (!Array.isArray(value.amendments) || !value.amendments.every(isAttestationRef)))) {
    return false;
  }
  const roles = new Set<string>();
  for (const party of value.parties) {
    if (!isRecord(party) || !hasExactKeys(
      party,
      ["role", "bundleHash", "primaryClaim"],
      ["vetRecordRef"],
    ) || !["buyer", "seller", "orchestrator"].includes(String(party.role)) ||
        roles.has(String(party.role)) || typeof party.bundleHash !== "string" ||
        !HASH_RE.test(party.bundleHash) || !isNonEmpty(party.primaryClaim) ||
        (party.vetRecordRef !== undefined && !isAttestationRef(party.vetRecordRef))) {
      return false;
    }
    roles.add(String(party.role));
  }
  try {
    canonicalize(value);
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

function hasNoDuplicateRefs(values: readonly AttestationRef[]): boolean {
  const keys = values.map((value) => canonicalize(value));
  return new Set(keys).size === keys.length;
}

function hasNoDuplicateContentHashes(values: readonly AttestationRef[]): boolean {
  return new Set(values.map((value) => value.contentHash)).size === values.length;
}

/** Strict runtime guard for the versioned lossless audit-source envelope. */
export function isSellerFulfilmentAuditSource(
  value: unknown,
): value is SellerFulfilmentAuditSourceV1 {
  if (!hasExactJcsView(value) || !isRecord(value) || !hasExactKeys(value, [
    "sourceVersion", "session", "artifacts", "provenanceProfile",
  ]) || value.sourceVersion !== "1" ||
      value.provenanceProfile !== "dacs-sdk-operational-v1" ||
      !isSellerFulfilmentSessionRecord(value.session) || !isRecord(value.artifacts) ||
      !hasExactKeys(
        value.artifacts,
        ["agreementCommitment", "vetRecords", "vetRequirements", "settlementEvidence"],
        ["ratingRecords"],
      )) return false;
  const artifacts = value.artifacts;
  if (!isAttestationRef(artifacts.agreementCommitment) ||
      !Array.isArray(artifacts.vetRecords) || !artifacts.vetRecords.every(isAttestationRef) ||
      !Array.isArray(artifacts.vetRequirements) ||
      !artifacts.vetRequirements.every(isVetRequirementInvocation) ||
      !Array.isArray(artifacts.settlementEvidence) ||
      !artifacts.settlementEvidence.every(isAttestationRef) ||
      (artifacts.ratingRecords !== undefined &&
        (!Array.isArray(artifacts.ratingRecords) ||
          !artifacts.ratingRecords.every(isAttestationRef)))) return false;
  try {
    const vetRecords = artifacts.vetRecords as AttestationRef[];
    const settlementEvidence = artifacts.settlementEvidence as AttestationRef[];
    const ratingRecords = artifacts.ratingRecords as AttestationRef[] | undefined;
    const vetRequirements = artifacts.vetRequirements as SellerFulfilmentVetRequirementInvocation[];
    const allArtifactRefs = [
      artifacts.agreementCommitment as AttestationRef,
      ...vetRecords,
      ...settlementEvidence,
      ...(ratingRecords ?? []),
    ];
    if (!hasNoDuplicateRefs(vetRecords) || !hasNoDuplicateContentHashes(vetRecords) ||
        !hasNoDuplicateRefs(settlementEvidence) ||
        !hasNoDuplicateContentHashes(settlementEvidence) ||
        (ratingRecords !== undefined &&
          (!hasNoDuplicateRefs(ratingRecords) ||
            !hasNoDuplicateContentHashes(ratingRecords))) ||
        !hasNoDuplicateContentHashes(allArtifactRefs) ||
        vetRequirements.length !== vetRecords.length ||
        !hasNoDuplicateRefs(vetRequirements.map((entry) => entry.vetRecordRef))) return false;
    const vetKeys = new Set(vetRecords.map((entry) => canonicalize(entry)));
    if (!vetRequirements.every((entry) => vetKeys.has(canonicalize(entry.vetRecordRef)))) {
      return false;
    }
    canonicalize(value);
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

/** One distinct party Vet reference of the authenticated SessionRecord roster. */
export interface SellerFulfilmentVetBinding {
  primaryClaim: string;
  roles: ReadonlySet<string>;
}

const sameJcs = (left: unknown, right: unknown): boolean => {
  try {
    return canonicalize(left) === canonicalize(right);
  } catch {
    return false;
  }
};

/**
 * True when one Vet requirement invocation is not the one the fulfilment core
 * accepts for its party's record: the evaluated party, the counterparty
 * verifier, the composite address, the Listing-owned buyer requirement, the
 * coverage of every required/oneOf member, this job's deal-specific results
 * and each result's address. The fulfilment core runs it over the audit
 * source at delivery.
 *
 * A presence-only member (`verificationRequired: false`) needs no result and
 * may have none: DACS-2 forbids a synthetic VerifyResult for it. It is only
 * counted as covered when the strict verifier's presence preflight (DACS-1
 * PCR-1/PCR-2) accepts it. Its presence is counted by the strict replay of the
 * Vet record over the authenticated bundle, which this structural check does
 * not repeat.
 */
export function isSellerFulfilmentVetInvocationMismatch(
  invocation: unknown,
  context: {
    jobId: string;
    buyerClaim: string;
    sellerClaim: string;
    buyerRequirement: unknown;
    bindings: ReadonlyMap<string, SellerFulfilmentVetBinding>;
  },
): boolean {
  try {
    if (!hasExactJcsView(invocation) || !isVetRequirementInvocation(invocation)) return true;
    const presenceOnlyMembers = [
      ...invocation.requirement.required,
      ...(invocation.requirement.oneOf ?? []).flat(),
    ].filter((member) => member.verificationRequired === false);
    // DACS-1 PCR-1/PCR-2: a presence-only member is only covered when the
    // strict verifier would accept it — a registered scheme that selects no
    // freshness or recipe field. Counting any other member as covered would
    // carry a requirement the party Vet refuses into delivery.
    if (presenceOnlyMembers.length > 0 && presenceRequirementPreflight({
      ...invocation.requirement, required: presenceOnlyMembers, oneOf: [],
    }) !== null) return true;
    const key = canonicalize(invocation.vetRecordRef);
    const binding = context.bindings.get(key);
    const expectedResults = [...invocation.freshness, ...invocation.dealSpecific];
    const requirementCandidates = [
      ...invocation.requirement.required,
      ...(invocation.requirement.oneOf ?? []).flat(),
    ];
    const seenResultRefs = new Set<string>();
    const seenResultHashes = new Set<string>();
    const listingOwned = binding?.roles.has("buyer") === true;
    const expectedVerifier = listingOwned
      ? context.sellerClaim
      : binding?.roles.has("seller") === true
        ? context.buyerClaim
        : undefined;
    const expectedCompositeAddress =
      `dacs2:composite:${context.jobId}:${encodeAddressSegment(invocation.evaluatedParty)}`;
    const isCovered = (claim: ClaimRequirement): boolean =>
      !claim.verificationRequired || expectedResults.some((result) =>
        result.scheme === claim.scheme && sameJcs(result.requirement, claim));
    const uncoveredRequired = !invocation.requirement.required.every(isCovered);
    const uncoveredOneOf = (invocation.requirement.oneOf ?? []).some(
      (group) => group.length === 0 || !group.some(isCovered),
    );
    return !binding || expectedVerifier === undefined ||
      invocation.evaluatedParty !== binding.primaryClaim ||
      invocation.verifier !== expectedVerifier ||
      invocation.vetRecordRef.anchor.kind !== "storage-program" ||
      invocation.vetRecordRef.anchor.locator !== expectedCompositeAddress ||
      (invocation.vetRecordRef.signer !== undefined &&
        invocation.vetRecordRef.signer !== invocation.verifier) ||
      (listingOwned && !sameJcs(invocation.requirement, context.buyerRequirement)) ||
      invocation.dealSpecific.some((result) => result.sourceJobId !== context.jobId) ||
      uncoveredRequired || uncoveredOneOf ||
      expectedResults.some((result) => {
        const refKey = canonicalize(result.ref);
        const expectedResultAddress =
          `dacs2:${result.sourceJobId}:${result.scheme}:` +
          `${encodeAddressSegment(result.identifier)}:v${result.ref.recipeVersion}`;
        const duplicate = seenResultRefs.has(refKey) ||
          seenResultHashes.has(result.ref.contentHash);
        seenResultRefs.add(refKey);
        seenResultHashes.add(result.ref.contentHash);
        return duplicate || !result.requirement.verificationRequired ||
          result.scheme !== result.requirement.scheme ||
          result.ref.anchor.kind !== "storage-program" ||
          result.ref.anchor.locator !== expectedResultAddress ||
          !requirementCandidates.some((candidate) => sameJcs(candidate, result.requirement)) ||
          (result.requirement.recipeVersion !== undefined &&
            result.ref.recipeVersion !== result.requirement.recipeVersion);
      });
  } catch {
    return true;
  }
}

const MAX_PARTY_VET_INVOCATIONS = 2;
const MAX_VET_REQUIREMENT_MEMBERS = 64;
const MAX_VET_INVOCATION_RESULTS = 64;

/**
 * Why the Vet requirement invocations a seller would carry into its delivery
 * audit source are not ones the fulfilment core accepts, or null: the strict
 * invocation shape, exactly one invocation per distinct party Vet record, and
 * `isSellerFulfilmentVetInvocationMismatch` for each. Returns a refusal for
 * malformed or over-limit invocation sets; never throws.
 * Authenticate the SessionRecord roster separately; supply its bundle hashes
 * when parties share a Vet record, and validate the orchestrator role. This checks invocation
 * coverage before signing, not every delivery precondition.
 */
export function sellerFulfilmentVetRequirementsViolation(
  vetRequirements: unknown,
  input: {
    jobId: string;
    buyer: { primaryClaim: string; vetRecordRef: AttestationRef; bundleHash?: string };
    seller: { primaryClaim: string; vetRecordRef: AttestationRef; bundleHash?: string };
    buyerRequirement: unknown;
  },
): string | null {
  try {
    if (!Array.isArray(vetRequirements) || vetRequirements.length > MAX_PARTY_VET_INVOCATIONS ||
        !hasExactJcsView(vetRequirements) || !vetRequirements.every(isVetRequirementInvocation)) {
      return "the Vet requirement invocations are not the strict audit-source shape";
    }
    for (const entry of vetRequirements) {
      const groups = entry.requirement.oneOf ?? [];
      const members = entry.requirement.required.length +
        groups.reduce((count, group) => count + group.length, 0);
      if (groups.length > MAX_VET_REQUIREMENT_MEMBERS || members > MAX_VET_REQUIREMENT_MEMBERS ||
          entry.freshness.length + entry.dealSpecific.length > MAX_VET_INVOCATION_RESULTS) {
        return "the Vet requirement invocations exceed the requirement or result limit";
      }
    }
    canonicalize({ artifacts: { vetRequirements } });
    const bindings = new Map<string, { primaryClaim: string; bundleHash?: string; roles: Set<string> }>();
    for (const [role, party] of [["buyer", input.buyer], ["seller", input.seller]] as const) {
      if (!hasExactJcsView(party.vetRecordRef) ||
          !isAttestationRef(party.vetRecordRef) || !isNonEmpty(party.primaryClaim)) {
        return `the ${role} Vet reference or claim is malformed`;
      }
      const key = canonicalize(party.vetRecordRef);
      const existing = bindings.get(key);
      if (existing && (existing.primaryClaim !== party.primaryClaim ||
          typeof existing.bundleHash !== "string" || !HASH_RE.test(existing.bundleHash) ||
          existing.bundleHash !== party.bundleHash)) {
        return "one Vet record cannot represent different authenticated party identities";
      }
      if (existing) existing.roles.add(role);
      else bindings.set(key, { primaryClaim: party.primaryClaim, bundleHash: party.bundleHash, roles: new Set([role]) });
    }
    const partyRefs = [...new Map([input.buyer, input.seller].map((party) =>
      [canonicalize(party.vetRecordRef), party.vetRecordRef])).values()];
    if (!hasNoDuplicateContentHashes(partyRefs)) {
      return "distinct party Vet references share one content hash";
    }
    const invocationRefs = vetRequirements.map((entry) => entry.vetRecordRef);
    if (vetRequirements.length !== bindings.size || !hasNoDuplicateRefs(invocationRefs) ||
        !invocationRefs.every((ref) => bindings.has(canonicalize(ref)))) {
      return "the Vet requirement invocations are not exactly one per party Vet record";
    }
    const context = {
      jobId: input.jobId,
      buyerClaim: input.buyer.primaryClaim,
      sellerClaim: input.seller.primaryClaim,
      buyerRequirement: input.buyerRequirement,
      bindings,
    };
    if (vetRequirements.some((entry) => isSellerFulfilmentVetInvocationMismatch(entry, context))) {
      return "a Vet requirement invocation differs from its party, counterparty verifier, " +
        "address, requirement or covered results";
    }
    return null;
  } catch {
    return "the Vet requirement invocations are not canonicalizable";
  }
}

/** Hash of every canonical audit-source byte retained in a V2 handoff. */
export function sellerFulfilmentAuditSourceHash(
  source: Readonly<SellerFulfilmentAuditSourceV1>,
): string {
  if (!isSellerFulfilmentAuditSource(source)) {
    throw new TypeError("seller fulfilment audit source is malformed");
  }
  return sha256Hex(canonicalize(source));
}
