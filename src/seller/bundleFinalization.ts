import type {
  AnchorReceipt,
  AttestationRef,
  BundleBinding,
  FaultAttestationBundle,
  PhaseSummaryEntry,
} from "../artifacts/types.js";
import {
  BUNDLE_BINDING_SEPARATOR,
  isAnchorReceipt,
  isAttestationRef,
  isBundleBinding,
  isFaultAttestationBundle,
  isSettlementEvidence,
  signComponentArtifact,
  type BuildComponentSignatureOptions,
} from "../artifacts/index.js";
import { bundleAddress, canonicalize, contentHash } from "../canonical/index.js";
import { DacsError, SubstrateError } from "../errors.js";
import {
  attestationBundleHash,
  buildTwoSidedBundle,
  bundleSignedScope,
  type SessionParty,
  type SigningSessionParty,
} from "../agent/twoSidedBundle.js";
import type {
  SellerFulfilmentAgreement,
  SellerFulfilmentResult,
} from "../agent/runFulfilmentCore.js";

/** DACS-5 ST-11 proof-verification result. Unknown values never pass. */
export type SellerBundleVerificationDisposition =
  | "valid"
  | "invalid"
  | "indeterminate"
  | "error";

export type SellerBundleDependencyKind =
  | "listing"
  | "agreement"
  | "phase-attestation"
  | "vet-record"
  | "settlement-evidence"
  | "amendment"
  | "rating";

/** Operational receipt input; this is not a new signed DACS artifact. */
export interface FinalizedSellerBundleDependency {
  contentHash: string;
  anchorReceipt: AnchorReceipt;
}

export interface SellerBundleDependencyRequirement {
  contentHash: string;
  kinds: SellerBundleDependencyKind[];
  refs: AttestationRef[];
}

export type SellerBundleDependencyLookup =
  | { disposition: "present"; artifact: unknown }
  | { disposition: "absent" }
  | { disposition: "indeterminate"; reason: string };

export interface AnchoredSellerBundle {
  bundle: unknown;
  nativeAddress: string;
  anchorReceipt: AnchorReceipt;
  /** DACS-5 §10.4.2 canonical SR-2 pointer, when the binding exposes one. */
  anchorTx?: string;
}

export type SellerBundleLookup =
  | { disposition: "present"; anchored: AnchoredSellerBundle }
  | { disposition: "absent" }
  | { disposition: "indeterminate"; reason: string };

export type SellerBundleBindingLookup =
  | { disposition: "present"; binding: unknown }
  | { disposition: "absent" }
  | { disposition: "indeterminate"; reason: string };

export type SellerBundleBindingPublication =
  | { disposition: "published" }
  | { disposition: "rejected"; reason: string }
  | { disposition: "indeterminate"; reason: string };

/**
 * Transport- and substrate-neutral ST-11 seams. `absent` has the exact CORE
 * §5.1 meaning: authenticated absence under the binding's declared policy.
 */
export interface SellerBundleFinalizationProvider {
  mapping: "pure" | "write-input";
  resolveDependency: (
    dependency: Readonly<FinalizedSellerBundleDependency>,
    requirement: Readonly<SellerBundleDependencyRequirement>,
  ) => Promise<SellerBundleDependencyLookup> | SellerBundleDependencyLookup;
  verifyDependencyReceipt: (
    dependency: Readonly<FinalizedSellerBundleDependency>,
    requirement: Readonly<SellerBundleDependencyRequirement>,
  ) =>
    | Promise<SellerBundleVerificationDisposition>
    | SellerBundleVerificationDisposition;
  /** Artifact-specific logical/session binding verification after hash recomputation. */
  verifyDependencyBinding: (input: {
    dependency: Readonly<FinalizedSellerBundleDependency>;
    requirement: Readonly<SellerBundleDependencyRequirement>;
    artifact: unknown;
  }) =>
    | Promise<SellerBundleVerificationDisposition>
    | SellerBundleVerificationDisposition;
  resolveSellerBundle: (
    logicalAddress: string,
  ) => Promise<SellerBundleLookup> | SellerBundleLookup;
  submitSellerBundle: (
    logicalAddress: string,
    bundle: Readonly<FaultAttestationBundle>,
  ) => Promise<void> | void;
  verifySellerBundle: (
    bundle: Readonly<FaultAttestationBundle>,
  ) =>
    | Promise<SellerBundleVerificationDisposition>
    | SellerBundleVerificationDisposition;
  verifyBundleAnchorReceipt: (
    anchored: Readonly<AnchoredSellerBundle>,
  ) =>
    | Promise<SellerBundleVerificationDisposition>
    | SellerBundleVerificationDisposition;
  resolveBundleBinding?: (
    logicalAddress: string,
    signer: string,
  ) => Promise<SellerBundleBindingLookup> | SellerBundleBindingLookup;
  publishBundleBinding?: (
    binding: Readonly<BundleBinding>,
  ) =>
    | Promise<SellerBundleBindingPublication>
    | SellerBundleBindingPublication;
  verifyBundleBinding?: (
    binding: Readonly<BundleBinding>,
  ) =>
    | Promise<SellerBundleVerificationDisposition>
    | SellerBundleVerificationDisposition;
}

type CompletedFulfilment = Extract<
  SellerFulfilmentResult,
  { decision: "completed" }
>;

export interface FinalizeCompletedSellerBundleInput {
  agreement: SellerFulfilmentAgreement;
  agreementRef: AttestationRef;
  fulfilment: CompletedFulfilment;
  /** Entries completed before the seller delivery contribution. */
  phaseSummary: PhaseSummaryEntry[];
  vetRecords: AttestationRef[];
  /** Payment evidence completed before the seller delivery contribution. */
  settlementEvidence: AttestationRef[];
  amendments?: AttestationRef[];
  ratingRefs?: AttestationRef[];
  recipeRegistryVersion: number;
  railRegistryVersion: number;
  finalisedAt: number;
  buyer: SessionParty;
  seller: SessionParty;
  orchestrator?: SigningSessionParty;
  dependencies: FinalizedSellerBundleDependency[];
  /** Required only when `provider.mapping === "write-input"`. */
  bindingSigner?: BuildComponentSignatureOptions;
}

export interface FinalizedSellerBundle {
  state: "finalised";
  logicalAddress: string;
  nativeAddress: string;
  bundleContentHash: string;
  sellerBundle: FaultAttestationBundle;
  buyerBundle: FaultAttestationBundle;
  orchestratorBundle?: FaultAttestationBundle;
  anchorReceipt: AnchorReceipt;
  anchorTx?: string;
  binding?: BundleBinding;
  resumedBundle: boolean;
  resumedBinding: boolean;
}

interface PreparedSession {
  jobId: string;
  listingRef: SellerFulfilmentAgreement["listingPin"];
  agreementRef: AttestationRef;
  phaseSummary: PhaseSummaryEntry[];
  vetRecords: AttestationRef[];
  settlementEvidence: AttestationRef[];
  amendments?: AttestationRef[];
  ratingRefs?: AttestationRef[];
  recipeRegistryVersion: number;
  railRegistryVersion: number;
  finalisedAt: number;
  buyer: SessionParty;
  seller: SessionParty;
  orchestrator?: SigningSessionParty;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isHash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

const exact = (left: unknown, right: unknown): boolean =>
  canonicalize(left) === canonicalize(right);

function validUint(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function refsContain(refs: readonly AttestationRef[], candidate: AttestationRef): boolean {
  return refs.some((ref) => exact(ref, candidate));
}

function appendExactRef(
  refs: readonly AttestationRef[],
  candidate: AttestationRef,
): AttestationRef[] {
  const sameHash = refs.filter((ref) => ref.contentHash === candidate.contentHash);
  if (sameHash.some((ref) => !exact(ref, candidate))) {
    throw new DacsError("the same content hash is carried by conflicting AttestationRefs");
  }
  return sameHash.length === 0 ? [...refs, candidate] : [...refs];
}

function validateRefs(name: string, refs: readonly AttestationRef[]): void {
  if (!Array.isArray(refs) || refs.some((ref) => !isAttestationRef(ref))) {
    throw new DacsError(`${name} contains a non-normative AttestationRef`);
  }
}

function prepareSession(input: FinalizeCompletedSellerBundleInput): PreparedSession {
  const { agreement, fulfilment } = input;
  if (
    agreement.artifactKind !== "payee-bound" ||
    !agreement.signaturesVerified ||
    agreement.commitment.status !== "finalized" ||
    !isHash(agreement.contentHash) ||
    !isHash(agreement.commitment.recordContentHash) ||
    agreement.commitment.agreementHash !== agreement.contentHash ||
    !isAttestationRef(input.agreementRef) ||
    input.agreementRef.contentHash !== agreement.contentHash
  ) {
    throw new DacsError(
      "completed bundle finalization requires the exact verified payee-bound agreement and finalized commitment",
    );
  }
  if (
    input.buyer.primaryClaim !== agreement.buyer.primaryClaim ||
    input.buyer.bundleHash !== agreement.buyer.bundleHash ||
    input.seller.primaryClaim !== agreement.seller.primaryClaim ||
    input.seller.bundleHash !== agreement.seller.bundleHash
  ) {
    throw new DacsError("bundle signing parties do not match the verified agreement parties");
  }
  if (
    !validUint(input.recipeRegistryVersion) ||
    !validUint(input.railRegistryVersion) ||
    !validUint(input.finalisedAt)
  ) {
    throw new DacsError("bundle registry versions/finalisedAt must be non-negative safe integers");
  }
  if (
    !isSettlementEvidence(fulfilment.evidence) ||
    !isHash(fulfilment.evidenceHash) ||
    contentHash(fulfilment.evidence as unknown as Record<string, unknown>) !==
      fulfilment.evidenceHash ||
    fulfilment.evidence.jobId !== agreement.jobId ||
    fulfilment.evidence.outcome !== "success" ||
    !isAttestationRef(fulfilment.evidenceRef) ||
    fulfilment.evidenceRef.contentHash !== fulfilment.evidenceHash ||
    !exact(fulfilment.bundleContribution.settlementEvidence, fulfilment.evidenceRef) ||
    !exact(
      fulfilment.bundleContribution.phaseSummary.attestationRef,
      fulfilment.evidenceRef,
    ) ||
    fulfilment.bundleContribution.phaseSummary.outcome !== "ok" ||
    fulfilment.bundleContribution.phaseSummary.kind !== fulfilment.evidence.phase
  ) {
    throw new DacsError("seller fulfilment does not carry one exact successful delivery contribution");
  }

  validateRefs("vetRecords", input.vetRecords);
  validateRefs("settlementEvidence", input.settlementEvidence);
  if (input.amendments) validateRefs("amendments", input.amendments);
  if (input.ratingRefs) validateRefs("ratingRefs", input.ratingRefs);
  if (!Array.isArray(input.phaseSummary)) {
    throw new DacsError("phaseSummary must be an array");
  }
  const indexes = new Set<number>();
  for (const phase of input.phaseSummary) {
    if (!isRecord(phase) || !validUint(phase.index) || indexes.has(phase.index)) {
      throw new DacsError("phaseSummary indexes must be unique non-negative integers");
    }
    indexes.add(phase.index);
    if (phase.outcome !== "ok") {
      throw new DacsError("a completed bundle cannot contain a failed phase");
    }
    if (phase.attestationRef !== undefined && !isAttestationRef(phase.attestationRef)) {
      throw new DacsError("phaseSummary contains a non-normative AttestationRef");
    }
    if (
      phase.kind === "vet-credentials" &&
      (!phase.attestationRef || !refsContain(input.vetRecords, phase.attestationRef))
    ) {
      throw new DacsError("successful vet phases must reference a top-level vet record");
    }
    if (
      (phase.kind.startsWith("pay-") || phase.kind.startsWith("deliver-")) &&
      (!phase.attestationRef ||
        !refsContain(input.settlementEvidence, phase.attestationRef))
    ) {
      throw new DacsError("successful payment/delivery phases must reference top-level evidence");
    }
    if (
      phase.kind === "rate" &&
      (!phase.attestationRef || !refsContain(input.ratingRefs ?? [], phase.attestationRef))
    ) {
      throw new DacsError("successful rate phases must reference a top-level rating record");
    }
  }
  const contribution = fulfilment.bundleContribution.phaseSummary;
  const conflicting = input.phaseSummary.find((phase) => phase.index === contribution.index);
  if (conflicting && !exact(conflicting, contribution)) {
    throw new DacsError("seller delivery conflicts with an existing phaseSummary index");
  }
  const phaseSummary = conflicting
    ? [...input.phaseSummary]
    : [...input.phaseSummary, contribution];
  phaseSummary.sort((left, right) => left.index - right.index);
  const settlementEvidence = appendExactRef(
    input.settlementEvidence,
    fulfilment.bundleContribution.settlementEvidence,
  );
  const commits = phaseSummary.filter(
    (phase) =>
      phase.outcome === "ok" &&
      (phase.kind === "commit-agreement" ||
        phase.kind === "commit-payee-bound-agreement"),
  );
  if (
    commits.length !== 1 ||
    !commits[0]!.attestationRef ||
    commits[0]!.attestationRef.contentHash !== agreement.commitment.recordContentHash
  ) {
    throw new DacsError("completed bundle must reference the exact finalized DACS-3 commitment");
  }

  return {
    jobId: agreement.jobId,
    listingRef: { ...agreement.listingPin },
    agreementRef: input.agreementRef,
    phaseSummary,
    vetRecords: [...input.vetRecords],
    settlementEvidence,
    ...(input.amendments ? { amendments: [...input.amendments] } : {}),
    ...(input.ratingRefs ? { ratingRefs: [...input.ratingRefs] } : {}),
    recipeRegistryVersion: input.recipeRegistryVersion,
    railRegistryVersion: input.railRegistryVersion,
    finalisedAt: input.finalisedAt,
    buyer: input.buyer,
    seller: input.seller,
    ...(input.orchestrator ? { orchestrator: input.orchestrator } : {}),
  };
}

function requirementMap(session: PreparedSession): Map<string, SellerBundleDependencyRequirement> {
  const requirements = new Map<string, SellerBundleDependencyRequirement>();
  const add = (
    kind: SellerBundleDependencyKind,
    contentHashValue: string,
    ref?: AttestationRef,
  ): void => {
    const current = requirements.get(contentHashValue);
    if (current) {
      if (!current.kinds.includes(kind)) current.kinds.push(kind);
      if (ref) {
        if (current.refs.some((candidate) => !exact(candidate, ref))) {
          throw new DacsError(
            "the same dependency content hash is carried by conflicting AttestationRefs",
          );
        }
        if (current.refs.length === 0) current.refs.push(ref);
      }
      return;
    }
    requirements.set(contentHashValue, {
      contentHash: contentHashValue,
      kinds: [kind],
      refs: ref ? [ref] : [],
    });
  };

  add("listing", session.listingRef.contentHash);
  add("agreement", session.agreementRef.contentHash, session.agreementRef);
  for (const phase of session.phaseSummary) {
    if (phase.attestationRef) add("phase-attestation", phase.attestationRef.contentHash, phase.attestationRef);
  }
  for (const ref of session.vetRecords) add("vet-record", ref.contentHash, ref);
  for (const ref of session.settlementEvidence) add("settlement-evidence", ref.contentHash, ref);
  for (const ref of session.amendments ?? []) add("amendment", ref.contentHash, ref);
  for (const ref of session.ratingRefs ?? []) add("rating", ref.contentHash, ref);
  return requirements;
}

function dispositionFailure(
  subject: string,
  disposition: SellerBundleVerificationDisposition,
): never {
  if (disposition === "indeterminate" || disposition === "error") {
    throw new SubstrateError(`${subject} is not established (${disposition})`);
  }
  throw new DacsError(`${subject} is invalid`);
}

async function verifiedDisposition(
  subject: string,
  operation: () =>
    | Promise<SellerBundleVerificationDisposition>
    | SellerBundleVerificationDisposition,
): Promise<void> {
  let disposition: SellerBundleVerificationDisposition;
  try {
    disposition = await operation();
  } catch (error) {
    throw new SubstrateError(`${subject} verification errored`, { cause: error });
  }
  if (disposition !== "valid") dispositionFailure(subject, disposition);
}

async function verifyDependencies(
  session: PreparedSession,
  supplied: readonly FinalizedSellerBundleDependency[],
  provider: SellerBundleFinalizationProvider,
): Promise<void> {
  if (!Array.isArray(supplied)) {
    throw new DacsError("bundle dependencies must be an array");
  }
  const requirements = requirementMap(session);
  const byHash = new Map<string, FinalizedSellerBundleDependency>();
  for (const dependency of supplied) {
    if (!isRecord(dependency)) {
      throw new DacsError("bundle dependency must be an object");
    }
    const candidate = dependency as unknown as FinalizedSellerBundleDependency;
    if (
      !isHash(candidate.contentHash) ||
      candidate.contentHash !== candidate.anchorReceipt?.contentHash
    ) {
      throw new DacsError("bundle dependency does not match its receipt content hash");
    }
    if (byHash.has(candidate.contentHash)) {
      throw new DacsError("bundle dependencies contain a duplicate content hash");
    }
    byHash.set(candidate.contentHash, candidate);
  }
  if (
    byHash.size !== requirements.size ||
    [...byHash.keys()].some((hash) => !requirements.has(hash))
  ) {
    throw new DacsError("bundle dependencies do not exactly cover every referenced artifact");
  }

  for (const [hash, requirement] of requirements) {
    const dependency = byHash.get(hash)!;
    const receipt = dependency.anchorReceipt;
    if (
      !isAnchorReceipt(receipt) ||
      receipt.state !== "finalized" ||
      receipt.observationDisposition !== "established"
    ) {
      throw new DacsError(`dependency ${hash} lacks an established finalized AnchorReceipt`);
    }
    await verifiedDisposition(`dependency ${hash} receipt proof`, () =>
      provider.verifyDependencyReceipt(dependency, requirement),
    );

    let lookup: SellerBundleDependencyLookup;
    try {
      lookup = await provider.resolveDependency(dependency, requirement);
    } catch (error) {
      throw new SubstrateError(`dependency ${hash} resolution errored`, { cause: error });
    }
    if (!isRecord(lookup) || !["present", "absent", "indeterminate"].includes(String(lookup.disposition))) {
      throw new SubstrateError(`dependency ${hash} resolution returned an invalid disposition`);
    }
    if (lookup.disposition === "indeterminate") {
      throw new SubstrateError(`dependency ${hash} resolution is indeterminate: ${lookup.reason}`);
    }
    if (lookup.disposition === "absent") {
      throw new DacsError(`dependency ${hash} is authoritatively absent despite its finalized receipt`);
    }
    if (!isRecord(lookup.artifact)) {
      throw new DacsError(`dependency ${hash} resolved to a non-artifact value`);
    }
    let resolvedHash: string;
    try {
      resolvedHash = contentHash(lookup.artifact);
    } catch (error) {
      throw new DacsError(`dependency ${hash} cannot be canonically hashed`, { cause: error });
    }
    if (resolvedHash !== hash) {
      throw new DacsError(`dependency ${hash} resolved with a different canonical content hash`);
    }
    await verifiedDisposition(`dependency ${hash} logical/session binding`, () =>
      provider.verifyDependencyBinding({ dependency, requirement, artifact: lookup.artifact }),
    );
  }
}

function expectedBundleScope(session: PreparedSession): Record<string, unknown> {
  const orchestrator =
    session.orchestrator &&
    session.orchestrator.primaryClaim !== session.buyer.primaryClaim &&
    session.orchestrator.primaryClaim !== session.seller.primaryClaim
      ? session.orchestrator
      : undefined;
  return {
    faultBundleVersion: "1",
    jobId: session.jobId,
    outcome: "completed",
    faultedParty: "none",
    listingRef: session.listingRef,
    agreementRef: session.agreementRef,
    parties: [
      {
        role: "buyer",
        bundleHash: session.buyer.bundleHash,
        primaryClaim: session.buyer.primaryClaim,
      },
      {
        role: "seller",
        bundleHash: session.seller.bundleHash,
        primaryClaim: session.seller.primaryClaim,
      },
      ...(orchestrator
        ? [
            {
              role: "orchestrator",
              bundleHash: orchestrator.bundleHash,
              primaryClaim: orchestrator.primaryClaim,
            },
          ]
        : []),
    ],
    phaseSummary: session.phaseSummary,
    vetRecords: session.vetRecords,
    settlementEvidence: session.settlementEvidence,
    ...(session.amendments ? { amendments: session.amendments } : {}),
    ...(session.ratingRefs ? { ratingRefs: session.ratingRefs } : {}),
    recipeRegistryVersion: session.recipeRegistryVersion,
    railRegistryVersion: session.railRegistryVersion,
    finalisedAt: session.finalisedAt,
  };
}

function assertNormativeExpectedScope(scope: Record<string, unknown>): void {
  const parties = Array.isArray(scope.parties) ? scope.parties : [];
  const signatures = parties.map((party) => ({
    party: isRecord(party) ? party.primaryClaim : "",
    algorithm: "ed25519" as const,
    value: "c2ln",
  }));
  const candidate = {
    ...scope,
    anchoredByRole: "seller",
    signatures,
  };
  if (!isFaultAttestationBundle(candidate)) {
    throw new DacsError("completed session facts do not form a normative FaultAttestationBundle");
  }
}

function validateAnchoredBundle(
  logicalAddress: string,
  expectedScope: Record<string, unknown>,
  anchored: AnchoredSellerBundle,
): FaultAttestationBundle {
  if (
    !isRecord(anchored) ||
    !isFaultAttestationBundle(anchored.bundle) ||
    anchored.bundle.anchoredByRole !== "seller" ||
    !exact(bundleSignedScope(anchored.bundle), expectedScope) ||
    typeof anchored.nativeAddress !== "string" ||
    anchored.nativeAddress.length === 0 ||
    (anchored.anchorTx !== undefined &&
      (typeof anchored.anchorTx !== "string" || anchored.anchorTx.length === 0))
  ) {
    throw new DacsError("resolved seller bundle is malformed or binds different session content");
  }
  const bundleHash = attestationBundleHash(anchored.bundle);
  const receipt = anchored.anchorReceipt;
  if (
    !isAnchorReceipt(receipt) ||
    receipt.state !== "finalized" ||
    receipt.observationDisposition !== "established" ||
    receipt.logicalAddress !== logicalAddress ||
    receipt.nativeAddress !== anchored.nativeAddress ||
    receipt.contentHash !== bundleHash
  ) {
    throw new DacsError("seller bundle lacks an exact established finalized AnchorReceipt");
  }
  return anchored.bundle;
}

async function resolveBundle(
  logicalAddress: string,
  provider: SellerBundleFinalizationProvider,
): Promise<SellerBundleLookup> {
  try {
    const lookup = await provider.resolveSellerBundle(logicalAddress);
    if (
      !isRecord(lookup) ||
      !["present", "absent", "indeterminate"].includes(String(lookup.disposition))
    ) {
      throw new SubstrateError("seller bundle lookup returned an invalid disposition");
    }
    return lookup;
  } catch (error) {
    if (error instanceof SubstrateError) throw error;
    throw new SubstrateError("seller bundle lookup errored and is indeterminate", {
      cause: error,
    });
  }
}

async function verifyAnchoredBundle(
  logicalAddress: string,
  expectedScope: Record<string, unknown>,
  anchored: AnchoredSellerBundle,
  provider: SellerBundleFinalizationProvider,
): Promise<FaultAttestationBundle> {
  const bundle = validateAnchoredBundle(logicalAddress, expectedScope, anchored);
  await verifiedDisposition("seller bundle signatures", () =>
    provider.verifySellerBundle(bundle),
  );
  await verifiedDisposition("seller bundle anchor receipt proof", () =>
    provider.verifyBundleAnchorReceipt(anchored),
  );
  return bundle;
}

function roleCopy(
  sellerBundle: FaultAttestationBundle,
  role: "buyer" | "orchestrator",
): FaultAttestationBundle {
  const copy = { ...sellerBundle, anchoredByRole: role };
  if (!isFaultAttestationBundle(copy)) {
    throw new DacsError(`verified seller bundle cannot form the ${role} role copy`);
  }
  return copy;
}

async function anchorSellerBundle(
  session: PreparedSession,
  provider: SellerBundleFinalizationProvider,
): Promise<{
  anchored: AnchoredSellerBundle;
  sellerBundle: FaultAttestationBundle;
  buyerBundle: FaultAttestationBundle;
  orchestratorBundle?: FaultAttestationBundle;
  resumed: boolean;
}> {
  const logicalAddress = bundleAddress(session.jobId, "seller");
  const expectedScope = expectedBundleScope(session);
  assertNormativeExpectedScope(expectedScope);
  let lookup = await resolveBundle(logicalAddress, provider);
  if (lookup.disposition === "indeterminate") {
    throw new SubstrateError(`seller bundle lookup is indeterminate: ${lookup.reason}`);
  }
  if (lookup.disposition === "present") {
    const sellerBundle = await verifyAnchoredBundle(
      logicalAddress,
      expectedScope,
      lookup.anchored,
      provider,
    );
    return {
      anchored: lookup.anchored,
      sellerBundle,
      buyerBundle: roleCopy(sellerBundle, "buyer"),
      ...(sellerBundle.parties.some((party) => party.role === "orchestrator")
        ? { orchestratorBundle: roleCopy(sellerBundle, "orchestrator") }
        : {}),
      resumed: true,
    };
  }

  const copies = await buildTwoSidedBundle({
    ...session,
    outcome: "completed",
  });
  if (!copies.sellerCopy || !copies.buyerCopy) {
    throw new DacsError("completed bundle construction omitted a required party copy");
  }
  if (!exact(bundleSignedScope(copies.sellerCopy), expectedScope)) {
    throw new DacsError("completed bundle constructor changed the verified session scope");
  }
  await verifiedDisposition("constructed seller bundle signatures", () =>
    provider.verifySellerBundle(copies.sellerCopy!),
  );

  try {
    await provider.submitSellerBundle(logicalAddress, copies.sellerCopy);
  } catch (error) {
    lookup = await resolveBundle(logicalAddress, provider);
    if (lookup.disposition !== "present") {
      throw new SubstrateError(
        "seller bundle submission outcome is ambiguous; resolve before any retry",
        { cause: error },
      );
    }
  }
  if (lookup.disposition !== "present") {
    lookup = await resolveBundle(logicalAddress, provider);
  }
  if (lookup.disposition !== "present") {
    throw new SubstrateError(
      lookup.disposition === "indeterminate"
        ? `seller bundle is not independently resolvable: ${lookup.reason}`
        : "seller bundle is authoritatively absent after submission",
    );
  }
  const sellerBundle = await verifyAnchoredBundle(
    logicalAddress,
    expectedScope,
    lookup.anchored,
    provider,
  );
  if (attestationBundleHash(sellerBundle) !== attestationBundleHash(copies.sellerCopy)) {
    throw new DacsError("independently resolved seller bundle differs from the submitted copy");
  }
  return {
    anchored: lookup.anchored,
    sellerBundle,
    buyerBundle: copies.buyerCopy,
    ...(copies.orchestratorCopy ? { orchestratorBundle: copies.orchestratorCopy } : {}),
    resumed: false,
  };
}

function bindingMatches(
  binding: BundleBinding,
  expected: Omit<BundleBinding, "signature">,
): boolean {
  const { signature: _signature, ...unsigned } = binding;
  return exact(unsigned, expected);
}

async function publishBinding(
  input: FinalizeCompletedSellerBundleInput,
  provider: SellerBundleFinalizationProvider,
  anchored: AnchoredSellerBundle,
  sellerBundle: FaultAttestationBundle,
): Promise<{ binding?: BundleBinding; resumed: boolean }> {
  if (provider.mapping === "pure") return { resumed: false };
  if (
    !provider.resolveBundleBinding ||
    !provider.publishBundleBinding ||
    !provider.verifyBundleBinding
  ) {
    throw new DacsError("write-input bundle mapping requires all BundleBinding provider seams");
  }
  const signer = input.agreement.seller.primaryClaim;
  const expected: Omit<BundleBinding, "signature"> = {
    bindingVersion: "1",
    jobId: input.agreement.jobId,
    role: "seller",
    logicalAddress: bundleAddress(input.agreement.jobId, "seller"),
    nativeAddress: anchored.nativeAddress,
    bundleContentHash: attestationBundleHash(sellerBundle),
    ...(anchored.anchorTx ? { anchorTx: anchored.anchorTx } : {}),
    signer,
  };

  let lookup: SellerBundleBindingLookup;
  try {
    lookup = await provider.resolveBundleBinding(expected.logicalAddress, signer);
  } catch (error) {
    throw new SubstrateError("BundleBinding lookup errored and is indeterminate", {
      cause: error,
    });
  }
  if (
    !isRecord(lookup) ||
    !["present", "absent", "indeterminate"].includes(String(lookup.disposition))
  ) {
    throw new SubstrateError("BundleBinding lookup returned an invalid disposition");
  }
  if (lookup.disposition === "indeterminate") {
    throw new SubstrateError(`BundleBinding lookup is indeterminate: ${lookup.reason}`);
  }
  if (lookup.disposition === "present") {
    if (!isBundleBinding(lookup.binding) || !bindingMatches(lookup.binding, expected)) {
      throw new DacsError("existing BundleBinding is malformed or maps different bundle content");
    }
    await verifiedDisposition("existing BundleBinding signature", () =>
      provider.verifyBundleBinding!(lookup.binding as BundleBinding),
    );
    return { binding: lookup.binding, resumed: true };
  }

  if (!input.bindingSigner || input.bindingSigner.signer !== signer) {
    throw new DacsError("BundleBinding signer must be the agreement seller (BB-1/BB-4)");
  }
  const binding = await signComponentArtifact(
    expected,
    BUNDLE_BINDING_SEPARATOR,
    input.bindingSigner,
  );
  if (!isBundleBinding(binding)) {
    throw new DacsError("signed BundleBinding is not normative");
  }
  await verifiedDisposition("constructed BundleBinding signature", () =>
    provider.verifyBundleBinding!(binding),
  );
  let publication: SellerBundleBindingPublication;
  try {
    publication = await provider.publishBundleBinding(binding);
  } catch (error) {
    throw new SubstrateError(
      "BundleBinding publication outcome is ambiguous; resolve before any retry",
      { cause: error },
    );
  }
  if (!isRecord(publication) || !["published", "rejected", "indeterminate"].includes(String(publication.disposition))) {
    throw new SubstrateError("BundleBinding publisher returned an invalid disposition");
  }
  if (publication.disposition === "indeterminate") {
    throw new SubstrateError(`BundleBinding publication is indeterminate: ${publication.reason}`);
  }
  if (publication.disposition === "rejected") {
    throw new DacsError(`BundleBinding publication was rejected: ${publication.reason}`);
  }
  return { binding, resumed: false };
}

/**
 * DACS-5 ST-11 completed-bundle gate for the seller role. This function only
 * returns `finalised` after dependency audit, required signatures, independent
 * bundle resolution, finalized anchor proof, and applicable BB-1 publication.
 */
export async function finalizeCompletedSellerBundleCore(
  input: FinalizeCompletedSellerBundleInput,
  provider: SellerBundleFinalizationProvider,
): Promise<FinalizedSellerBundle> {
  if (provider.mapping !== "pure" && provider.mapping !== "write-input") {
    throw new DacsError("unsupported bundle address mapping policy");
  }
  const session = prepareSession(input);
  assertNormativeExpectedScope(expectedBundleScope(session));
  await verifyDependencies(session, input.dependencies, provider);
  const anchored = await anchorSellerBundle(session, provider);
  const binding = await publishBinding(
    input,
    provider,
    anchored.anchored,
    anchored.sellerBundle,
  );
  return {
    state: "finalised",
    logicalAddress: bundleAddress(session.jobId, "seller"),
    nativeAddress: anchored.anchored.nativeAddress,
    bundleContentHash: attestationBundleHash(anchored.sellerBundle),
    sellerBundle: anchored.sellerBundle,
    buyerBundle: anchored.buyerBundle,
    ...(anchored.orchestratorBundle
      ? { orchestratorBundle: anchored.orchestratorBundle }
      : {}),
    anchorReceipt: anchored.anchored.anchorReceipt,
    ...(anchored.anchored.anchorTx ? { anchorTx: anchored.anchored.anchorTx } : {}),
    ...(binding.binding ? { binding: binding.binding } : {}),
    resumedBundle: anchored.resumed,
    resumedBinding: binding.resumed,
  };
}
