import { types as nodeTypes } from "node:util";
import { admitDacsSessionProfile } from "./sessionProfileAdmission.js";

import {
  advanceTerminalBundleDurable,
  faultCategory,
  createTerminalBundlePlan,
  createTerminalBundleSignatureContribution,
  prepareVetTerminalBundle,
  terminalBundleSignedBytes,
  type PrepareVetTerminalBundleDeps,
  type PrepareVetTerminalBundleInput,
  type PreparedVetTerminalBundle,
  type DurableTerminalBundleProgress,
  type DurableTerminalBundleProvider,
  type TerminalBundlePlan,
  type TerminalBundleResolution,
  type TerminalBundleSignatureContribution,
  type TerminalBundleTransport,
  type TerminalBundleTransportIdentity,
} from "@kynesyslabs/dacs";
import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import type {
  FixedPricePayDemOrderInput,
  FixedPriceX402OrderInput,
} from "@kynesyslabs/dacs/commerce";
import { ed25519Verify, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";
import { canonicalDemosAgentPublicKey, sameCanonicalClaimIdentity } from
  "@kynesyslabs/dacs/identity";

import { loadDacsAgreementTerminalBoundaryForOrderV1 } from "./agreementTransportRuntime.js";
import {
  claimDacsPreAgreementPhaseV1,
  claimDacsSellerVetOutcomeV1,
  DACS_PRE_AGREEMENT_PHASE_CONFLICT,
  DacsPreAgreementPhaseError,
  loadDacsPreAgreementPhaseV1,
  type DacsPreAgreementPhaseV1,
} from "./preAgreementPhase.js";
import { createDacsDemosBundlePublicationV1 } from "./demosBundlePublication.js";
import { createVetTerminalBundleProvider } from "./vetTerminalBundleProvider.js";
import { captureDacsFixedPriceX402ApplicationV1 } from
  "./fixedPriceX402Profile.js";
import { loadDacsLiveOrderInputV1 } from "./orderInput.js";
import { isDacsNodeSqliteBusyError } from "./sqlite.js";
import type {
  DacsLiveRoleInboundOperationContextV1,
  DacsLiveRoleOperationContextV1,
} from "./roleRuntime.js";
import type { DacsLiveRoleSendInputV1 } from "./service.js";
import { dacsSessionAgreementFactsIdV1 } from "./sessionAgreementFactsId.js";
import type {
  DacsHttpAuthenticatedEnvelopeV1,
  DacsHttpPayloadValidationV1,
  DacsHttpPayloadValidatorV1,
  DacsVetTerminalBundleProposalV1,
  DacsVetTerminalEvidenceV1,
} from "./transport/envelope.js";
import type { DacsHttpInboundDispositionV1 } from "./transport/http.js";

const BINDING_VERSION = "1" as const;
const CONFLICT_VERSION = "1" as const;
const TRANSPORT_ID_DOMAIN = "dacs-live-vet-terminal-transport:v1:" as const;
const HASH_RE = /^[0-9a-f]{64}$/;
// Serialize only the process-local callback-start boundary. The callback promise
// is deliberately outside this section; the durable marker is rechecked after it
// settles and remains the cross-process source of truth.
const PLAN_CONFLICT_SEQUENCES = new WeakMap<
  object,
  Map<string, Promise<void>>
>();

type Role = "buyer" | "seller";
type BindingKind = "material" | "proposal" | "contribution";
type TransportRecordKind =
  BindingKind | "conflict" | "equivocation" | "selection" | "disagreement" | "local-vet" | "local-evidence" | "peer-evidence";

/**
 * Operator-action reason when this role's own Vet failure and the peer's first
 * plan name different terminals. DACS-2 defers mutual-Vet composition and
 * DACS-5 §10.4.3(d) leaves which party failed to adjudication, so neither
 * plan is signed.
 */
export const DACS_VET_TERMINAL_PLAN_DISAGREEMENT = "vet-terminal-plan-disagreement";
/** Pending reason while this role's disagreement notice awaits the peer. */
export const DACS_VET_TERMINAL_PLAN_DISAGREEMENT_NOTICE_PENDING =
  "vet-terminal-plan-disagreement-notice-pending";
/**
 * The peer's plan waits for this role's own Vet result: it is neither accepted
 * nor signed until this role's own failure is that plan, or this role's Vet of
 * the peer passed and the plan is the peer's failure of this role.
 */
export const DACS_VET_TERMINAL_LOCAL_VET_PENDING = "vet-terminal-local-vet-pending";
const LOCAL_VET_CONFLICT = "vet-terminal-local-vet-conflict";

interface DacsVetTerminalTransportBindingV1 {
  bindingVersion: typeof BINDING_VERSION;
  localBindingHash: string;
  kind: BindingKind;
  payloadHash: string;
  payload: Readonly<
    DacsVetTerminalBundleProposalV1 | TerminalBundleSignatureContribution
  >;
  authenticationHash?: string;
  identityEvidenceHash?: string;
}

interface DacsVetTerminalTransportConflictV1 {
  conflictVersion: typeof CONFLICT_VERSION;
  localBindingHash: string;
  kind: "plan-conflict";
  planHashes: readonly [string, string];
}

// The job's one terminal plan for this role: the first plan written, from this
// role's own Vet failure or from the peer's proposal. Local registration and
// inbound proposals, in any process, share this insert-once row.
interface DacsVetTerminalPlanSelectionV1 {
  selectionVersion: "1";
  localBindingHash: string;
  kind: "plan-selection";
  source: "material" | "peer";
  planHash: string;
  payloadHash: string;
  payload: Readonly<DacsVetTerminalBundleProposalV1>;
  authenticationHash?: string;
  identityEvidenceHash?: string;
}

// This role's own Vet result, in one insert-once row that a pass and a
// failure, in any process, both claim before acting on it: either this role's
// Vet of the peer passed, or it failed with the plan it registers.
interface DacsVetTerminalLocalVetPassV1 {
  resultVersion: "1";
  localBindingHash: string;
  kind: "local-vet-pass";
  evaluatedRole: Role;
}

interface DacsVetTerminalLocalVetFailureV1 {
  resultVersion: "1";
  localBindingHash: string;
  kind: "local-vet-failure";
  planHash: string;
}

type DacsVetTerminalLocalVetResultV1 =
  | DacsVetTerminalLocalVetPassV1
  | DacsVetTerminalLocalVetFailureV1;

export interface DacsVetTerminalBundleTransportOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  /** Trusted local registry snapshot selected by the live factory. */
  expectedRegistryVersions?: Readonly<{
    recipeRegistryVersion: number;
    railRegistryVersion: number;
  }>;
  /**
   * Recursively authenticate the CVR, VerifyResults, recipe provenance and
   * finalized readback. The runtime feeds this only the exact proposal input
   * and independently re-derives the terminal plan on both roles.
   */
  authenticateProduction: PrepareVetTerminalBundleDeps["authenticateProduction"];
}

export interface DacsVetTerminalBundleTransportRuntimeV1 {
  readonly transport: Readonly<TerminalBundleTransport>;
  readonly validatePayload: DacsHttpPayloadValidatorV1;
  registerLocalTerminal(
    input: Readonly<PrepareVetTerminalBundleInput>,
  ): Promise<Readonly<{
    prepared: Extract<PreparedVetTerminalBundle, { status: "terminal" }>;
    proposal: Readonly<DacsVetTerminalBundleProposalV1>;
  }>>;
  advanceRegisteredTerminal(jobId: string): Promise<DurableTerminalBundleProgress>;
  /**
   * Durably records that this role's own Vet of the peer passed. A peer's plan
   * is accepted and signed only once this role's own Vet result is recorded,
   * by this or by `registerLocalTerminal`, and agrees with it; until then it
   * waits (`vet-terminal-local-vet-pending`). Optional, so existing
   * implementations of this interface still conform.
   */
  registerLocalVetPass?(
    order: Readonly<{ jobId: string; localBindingHash: string }>,
    input?: Readonly<PrepareVetTerminalBundleInput>,
  ): Promise<void>;
  handleMessage(
    authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
    context: Readonly<DacsLiveRoleInboundOperationContextV1>,
  ): Promise<DacsHttpInboundDispositionV1>;
  /**
   * Evidence of the peer offering a second, authentic plan for a job after
   * this role retained one from it: the first one refused before this role
   * committed to its plan, and the first one refused after it (an operator
   * alert). Neither stops the job. Optional, so existing implementations of
   * this interface still conform.
   */
  loadPeerEquivocationEvidence?(jobId: string): Promise<Readonly<{
    beforeCommit?: Readonly<DacsVetTerminalPeerEquivocationEvidenceV1>;
    afterCommit?: Readonly<DacsVetTerminalPeerEquivocationEvidenceV1>;
  }>>;
  /**
   * Evidence of a two-sided disagreement: this role's own Vet failure and the
   * peer's first plan name different terminals. The job stops at operator
   * action on both roles and nothing is signed. Optional, like the above.
   */
  loadPlanDisagreementEvidence?(jobId: string): Promise<
    Readonly<DacsVetTerminalPlanDisagreementEvidenceV1> | undefined
  >;
}

export interface DacsVetTerminalPlanDisagreementEvidenceV1 {
  evidenceVersion: "1";
  kind: "plan-disagreement";
  localBindingHash: string;
  /** This role's own Vet-failure plan. */
  localPlanHash: string;
  /** The peer's first plan. */
  peerPlanHash: string;
  /** Which plan this role selected first; the other is kept below. */
  selected: "local" | "peer";
  losingPayloadHash: string;
  losingPayload: Readonly<DacsVetTerminalBundleProposalV1>;
  /** Set when the losing plan is the peer's authenticated proposal. */
  authenticationHash?: string;
  identityEvidenceHash?: string;
  operatorAlert: true;
}

export interface DacsVetTerminalPeerEquivocationEvidenceV1 {
  evidenceVersion: "1";
  kind: "peer-equivocation";
  localBindingHash: string;
  /** The plan this role retained first and continues with. */
  retainedPlanHash: string;
  /** The conflicting plan the peer offered, which was refused. */
  offeredPlanHash: string;
  payloadHash: string;
  authenticationHash: string;
  identityEvidenceHash: string;
  /** True once this role had sent, accepted or signed the retained plan. */
  operatorAlert: boolean;
}

export class DacsVetTerminalBundleTransportError extends Error {
  override readonly name = "DacsVetTerminalBundleTransportError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

// An authentic proposal whose plan differs from the plan this role retained
// from the peer.
class PeerPlanEquivocation extends DacsVetTerminalBundleTransportError {
  constructor(readonly retainedPlanHash: string, readonly offeredPlanHash: string) {
    super("vet-terminal-proposal-equivocation");
  }
}

// The peer's first plan differs from this role's own Vet-failure plan.
class PeerPlanDisagreement extends DacsVetTerminalBundleTransportError {
  constructor(readonly localPlanHash: string, readonly peerPlanHash: string) {
    super(DACS_VET_TERMINAL_PLAN_DISAGREEMENT);
  }
}

function plainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return (prototype === Object.prototype || prototype === null) &&
      Reflect.ownKeys(value).every((key) => {
        if (typeof key !== "string") return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
      });
  } catch {
    return false;
  }
}

function exactFields(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) &&
    keys.every((key) => allowed.has(key));
}

function otherRole(role: Role): Role {
  return role === "buyer" ? "seller" : "buyer";
}

function isPendingValidationPrerequisite(error: unknown): error is DacsVetTerminalBundleTransportError {
  return error instanceof DacsVetTerminalBundleTransportError && (
    error.reasonCode === "vet-terminal-production-indeterminate" ||
    error.reasonCode === "vet-terminal-order-pending" ||
    error.reasonCode === "vet-terminal-order-input-pending" ||
    error.reasonCode === "vet-terminal-proposal-version-authority-unavailable"
  );
}

function payloadValidation(
  valid: boolean,
  reasonCode: string,
): DacsHttpPayloadValidationV1 {
  return valid
    ? Object.freeze({ status: "valid" as const })
    : Object.freeze({ status: "invalid" as const, reasonCode });
}

function acknowledgementDisposition(
  value: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
): "accepted" | "existing" | "rejected" {
  return value.envelope.type === "acknowledgement"
    ? value.envelope.payload.disposition : "rejected";
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  try {
    return canonicalize(left) === canonicalize(right);
  } catch {
    return false;
  }
}

function snapshotJson(
  value: unknown,
  label: string,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value !== "object") {
    if (value === undefined || typeof value === "function" || typeof value === "symbol" ||
        typeof value === "bigint" ||
        (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0)))) {
      throw new DacsVetTerminalBundleTransportError(`${label}-invalid`);
    }
    return value;
  }
  if (nodeTypes.isProxy(value) || seen.has(value)) {
    throw new DacsVetTerminalBundleTransportError(`${label}-invalid`);
  }
  seen.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw new DacsVetTerminalBundleTransportError(`${label}-invalid`);
    }
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) {
        throw new DacsVetTerminalBundleTransportError(`${label}-invalid`);
      }
      const keys = Object.keys(descriptors).filter((key) => key !== "length");
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
        throw new DacsVetTerminalBundleTransportError(`${label}-invalid`);
      }
      return keys.map((key) => {
        const descriptor = descriptors[key]!;
        if (!descriptor.enumerable || !("value" in descriptor)) {
          throw new DacsVetTerminalBundleTransportError(`${label}-invalid`);
        }
        return snapshotJson(descriptor.value, label, seen);
      });
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DacsVetTerminalBundleTransportError(`${label}-invalid`);
    }
    const result: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || !("value" in descriptor) ||
          descriptor.value === undefined) {
        throw new DacsVetTerminalBundleTransportError(`${label}-invalid`);
      }
      result[key] = snapshotJson(descriptor.value, label, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function frozenJsonSnapshot<T>(value: T, label: string): Readonly<T> {
  const snapshot = JSON.parse(canonicalize(snapshotJson(value, label))) as T;
  const freeze = (entry: unknown): void => {
    if (entry !== null && typeof entry === "object" && !Object.isFrozen(entry)) {
      for (const child of Object.values(entry)) freeze(child);
      Object.freeze(entry);
    }
  };
  freeze(snapshot);
  return snapshot;
}

function capturePlan(value: unknown): Readonly<TerminalBundlePlan> {
  if (!plainObject(value) || !plainObject(value.authority) ||
      !plainObject(value.signingMode)) {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-plan-invalid");
  }
  let derived: Readonly<TerminalBundlePlan>;
  try {
    derived = createTerminalBundlePlan(
      value.authority as unknown as TerminalBundlePlan["authority"],
      value.signingMode as unknown as TerminalBundlePlan["signingMode"],
    );
  } catch {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-plan-invalid");
  }
  if (!canonicalEqual(derived, value) || derived.authority.terminalClass !== "failure" ||
      derived.authority.terminalPhase.kind !== "vet-credentials" ||
      derived.authority.terminalPhase.state !== "failed" ||
      derived.signingMode.kind !== "co-signed" ||
      (derived.authority.faultedParty !== "buyer" &&
        derived.authority.faultedParty !== "seller")) {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-plan-invalid");
  }
  return Object.freeze(structuredClone(derived));
}

function assertPlanParties(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  plan: Readonly<TerminalBundlePlan>,
): void {
  const parties = plan.authority.parties;
  const buyer = parties.find((party) => party.role === "buyer");
  const seller = parties.find((party) => party.role === "seller");
  const expectedLocal = context.authority;
  const expectedPeer = context.peerAuthority;
  const local = context.role === "buyer" ? buyer : seller;
  const peer = context.role === "buyer" ? seller : buyer;
  if (parties.length !== 2 || buyer === undefined || seller === undefined ||
      local === undefined || peer === undefined ||
      !sameCanonicalClaimIdentity(local.primaryClaim, expectedLocal) ||
      !sameCanonicalClaimIdentity(peer.primaryClaim, expectedPeer) ||
      plan.requiredSigners.length !== 2 ||
      !plan.requiredSigners.some((entry) => entry.role === "buyer" &&
        sameCanonicalClaimIdentity(entry.primaryClaim, buyer.primaryClaim)) ||
      !plan.requiredSigners.some((entry) => entry.role === "seller" &&
        sameCanonicalClaimIdentity(entry.primaryClaim, seller.primaryClaim))) {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-plan-party-mismatch");
  }
}

function captureContribution(
  plan: Readonly<TerminalBundlePlan>,
  value: unknown,
): Readonly<TerminalBundleSignatureContribution> {
  if (!plainObject(value) ||
      (value.signerRole !== "buyer" && value.signerRole !== "seller") ||
      !Array.isArray(value.signatures)) {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-contribution-invalid");
  }
  let derived: Readonly<TerminalBundleSignatureContribution>;
  try {
    derived = createTerminalBundleSignatureContribution(
      plan,
      value.signerRole,
      value.signatures.map((entry) => {
        if (!plainObject(entry) || !plainObject(entry.signature)) throw new Error();
        return {
          copyRole: entry.copyRole as "buyer" | "seller",
          value: entry.signature.value as string,
        };
      }),
    );
  } catch {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-contribution-invalid");
  }
  if (!canonicalEqual(derived, value)) {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-contribution-invalid");
  }
  const publicKey = canonicalDemosAgentPublicKey(derived.signer);
  if (publicKey === null) {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-contribution-unverified");
  }
  for (const signature of derived.signatures) {
    const copy = plan.copies.find((candidate) => candidate.role === signature.copyRole);
    if (copy === undefined) {
      throw new DacsVetTerminalBundleTransportError("vet-terminal-contribution-unverified");
    }
    try {
      const bytes = Buffer.from(signature.signature.value, "base64url");
      if (bytes.byteLength !== 64 ||
          !ed25519Verify(
            terminalBundleSignedBytes(copy),
            Uint8Array.from(bytes),
            publicKeyFromRaw(publicKey),
          )) {
        throw new Error();
      }
    } catch {
      throw new DacsVetTerminalBundleTransportError(
        "vet-terminal-contribution-unverified",
      );
    }
  }
  return Object.freeze(structuredClone(derived));
}

async function loadOrder(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  jobId: string,
): Promise<Readonly<{
  jobId: string;
  buyer: string;
  seller: string;
  localBindingHash: string;
  rail: Readonly<{
    registryIndexRef: string;
    registryIndexHash: string;
    railDefinitionRef: string;
    railDefinitionHash: string;
    railId: string;
    railVersion: number;
    railType: "x402" | "demos-native";
    phaseHandler: "pay-x402" | "pay-dem";
    network: string;
    availability: "live";
  }>;
  listingRef: Readonly<{
    listingId: string;
    version: number;
    contentHash: string;
  }>;
  pipeline: Readonly<PrepareVetTerminalBundleInput["pipeline"]>;
  agreementConcluded: boolean;
  sellerPassRetained: boolean;
  sellerResponseRetained: boolean;
  phase: DacsPreAgreementPhaseV1 | undefined;
}>> {
  const [x402, payDem] = await Promise.all([
    context.database.createLiveCoordinatorStore(context.role).load(context.role, jobId),
    context.database.createPayDemCoordinatorStore(context.role).load(context.role, jobId),
  ]);
  if (x402.status === "missing" && payDem.status === "missing") {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-order-pending");
  }
  const x402Owned = x402.status === "ok";
  const payDemOwned = payDem.status === "ok";
  if ((x402.status !== "ok" && x402.status !== "missing") ||
      (payDem.status !== "ok" && payDem.status !== "missing") ||
      x402Owned === payDemOwned) {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-order-unavailable");
  }
  const record = x402Owned ? x402.record : payDem.status === "ok" ? payDem.record : undefined;
  if (record === undefined || record.jobId !== jobId ||
      record.role !== context.role ||
      !sameCanonicalClaimIdentity(
        context.role === "buyer" ? record.buyer : record.seller,
        context.authority,
      ) ||
      !sameCanonicalClaimIdentity(
        context.role === "buyer" ? record.seller : record.buyer,
        context.peerAuthority,
      )) {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-order-mismatch");
  }
  const retainedOrder = {
    jobId: record.jobId,
    buyer: record.buyer,
    seller: record.seller,
    protocol: record.protocol,
    sdkJobs: record.sdkJobs,
  };
  const retained = (() => {
    try {
      return record.protocol.phase === "pay-dem"
        ? loadDacsLiveOrderInputV1({
            database: context.database,
            order: retainedOrder as FixedPricePayDemOrderInput,
          })
        : loadDacsLiveOrderInputV1({
            database: context.database,
            order: retainedOrder as FixedPriceX402OrderInput,
          });
    } catch (error) {
      throw busyOr(error, "vet-terminal-order-mismatch");
    }
  })();
  if (retained === undefined) {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-order-input-pending");
  }
  if (retained.localBindingHash !== record.localBindingHash) {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-order-mismatch");
  }
  let application: ReturnType<typeof captureDacsFixedPriceX402ApplicationV1>;
  try {
    application = captureDacsFixedPriceX402ApplicationV1(retained.application);
  } catch {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-order-mismatch");
  }
  const listingPaymentSteps = application.listing.pipeline.filter((step) =>
    step.kind === "pay-x402" || step.kind === "pay-dem");
  const listingRails = application.listing.acceptedRails?.filter((rail) =>
    rail.railId === record.protocol.rail.railId) ?? [];
  if (listingPaymentSteps.length !== 1 ||
      listingPaymentSteps[0]?.kind !== record.protocol.phase ||
      listingPaymentSteps[0].parameters?.rail !== record.protocol.rail.railId ||
      listingRails.length !== 1 ||
      listingRails[0]?.railVersion !== record.protocol.rail.railVersion ||
      listingRails[0]?.parameters?.network !== record.protocol.rail.network) {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-order-mismatch");
  }
  return Object.freeze({
    jobId: record.jobId,
    buyer: record.buyer,
    seller: record.seller,
    localBindingHash: record.localBindingHash,
    rail: Object.freeze(structuredClone(record.protocol.rail)),
    listingRef: Object.freeze({
      listingId: application.listing.listingId,
      version: application.listing.listingVersion,
      contentHash: application.listingContentHash,
    }),
    pipeline: application.listing.pipeline,
    ...loadDacsAgreementTerminalBoundaryForOrderV1(context, record),
    agreementConcluded: record.tracks.agreement?.state === "final" &&
      record.tracks.agreement.outcome === "success",
    phase: loadPhase(context, record),
  });
}

function loadPhase(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  order: Readonly<{ jobId: string; localBindingHash: string }>,
): DacsPreAgreementPhaseV1 | undefined {
  try {
    return loadDacsPreAgreementPhaseV1(context, order);
  } catch (error) {
    throw busyOr(error, "vet-terminal-binding-corrupt");
  }
}

// A read the database could not serve under lock contention stays a raw
// SQLite error, which the tracks retry; anything else is `reasonCode`.
function busyOr(error: unknown, reasonCode: string): unknown {
  return isDacsNodeSqliteBusyError(error) ? error : new DacsVetTerminalBundleTransportError(reasonCode);
}

// A catch that answers for a proposal or message lets lock contention through
// unchanged: a busy read is no answer, and the caller retries.
function rethrowBusy(error: unknown): void {
  if (isDacsNodeSqliteBusyError(error)) throw error;
}

// Commit the job to the terminal for this role before retaining or signing
// terminal material. Fails if this role already committed to the agreement.
function claimTerminalPhase(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  order: Readonly<{ jobId: string; localBindingHash: string }>,
): void {
  try {
    claimDacsPreAgreementPhaseV1(context, order, "vet-terminal");
  } catch (error) {
    throw error instanceof DacsPreAgreementPhaseError
      ? new DacsVetTerminalBundleTransportError(error.reasonCode)
      : busyOr(error, "vet-terminal-binding-corrupt");
  }
}

// Authenticated proposal/response bindings are durable commitments even before
// the coordinator records agreement success. A seller-pass proposal contradicts
// seller failure; a retained seller response excludes every pre-agreement terminal.
// A role that committed the job to the agreement refuses every terminal.
function assertPreAgreementTerminal(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  order: Readonly<{ jobId: string; agreementConcluded: boolean;
    sellerPassRetained: boolean; sellerResponseRetained: boolean;
    phase: DacsPreAgreementPhaseV1 | undefined }>,
  evaluatedRole: unknown,
): void {
  const factsRetained = context.database.loadEffectInput(
    "session",
    dacsSessionAgreementFactsIdV1(context.role, order.jobId),
  ) !== undefined;
  const passedVets: readonly unknown[] = !factsRetained ? []
    : context.role === "buyer" ? ["buyer", "seller"] : ["buyer"];
  if (order.agreementConcluded || order.sellerResponseRetained ||
      (order.sellerPassRetained && evaluatedRole === "seller") ||
      passedVets.includes(evaluatedRole)) {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-not-pre-agreement");
  }
  if (order.phase === "agreement") {
    throw new DacsVetTerminalBundleTransportError(DACS_PRE_AGREEMENT_PHASE_CONFLICT);
  }
}

function transportId(
  role: Role,
  kind: TransportRecordKind,
  jobId: string,
  signerRole?: Role,
): string {
  return sha256Hex(`${TRANSPORT_ID_DOMAIN}${canonicalize({
    role,
    kind,
    jobId,
    ...(signerRole === undefined ? {} : { signerRole }),
  })}`);
}

function captureConflict(value: unknown): Readonly<DacsVetTerminalTransportConflictV1> {
  if (!plainObject(value) || !exactFields(value, [
    "conflictVersion", "localBindingHash", "kind", "planHashes",
  ]) || value.conflictVersion !== CONFLICT_VERSION || value.kind !== "plan-conflict" ||
      typeof value.localBindingHash !== "string" || !HASH_RE.test(value.localBindingHash) ||
      !Array.isArray(value.planHashes) || value.planHashes.length !== 2 ||
      typeof value.planHashes[0] !== "string" || !HASH_RE.test(value.planHashes[0]) ||
      typeof value.planHashes[1] !== "string" || !HASH_RE.test(value.planHashes[1]) ||
      value.planHashes[0] >= value.planHashes[1]) {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-binding-corrupt");
  }
  return value as unknown as Readonly<DacsVetTerminalTransportConflictV1>;
}

async function loadPlanConflict(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  jobId: string,
): Promise<Readonly<DacsVetTerminalTransportConflictV1> | undefined> {
  const order = await loadOrder(context, jobId);
  return loadPlanConflictForOrder(context, jobId, order.localBindingHash);
}

function loadPlanConflictForOrder(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  jobId: string,
  localBindingHash: string,
): Readonly<DacsVetTerminalTransportConflictV1> | undefined {
  const value = context.database.loadEffectInput(
    "session",
    transportId(context.role, "conflict", jobId),
  );
  if (value === undefined) return undefined;
  const conflict = captureConflict(value);
  if (conflict.localBindingHash !== localBindingHash) {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-binding-corrupt");
  }
  return conflict;
}

async function withPlanConflictSequence<T>(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  jobId: string,
  critical: () => T,
): Promise<T> {
  const database = context.database as object;
  let sequences = PLAN_CONFLICT_SEQUENCES.get(database);
  if (sequences === undefined) {
    sequences = new Map();
    PLAN_CONFLICT_SEQUENCES.set(database, sequences);
  }
  const key = `${context.role}:${jobId}`;
  const previous = sequences.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => turn);
  sequences.set(key, tail);
  await previous;
  try {
    return critical();
  } finally {
    release();
    if (sequences.get(key) === tail) {
      sequences.delete(key);
      if (sequences.size === 0) PLAN_CONFLICT_SEQUENCES.delete(database);
    }
  }
}

// A plan-conflict seal or a two-sided disagreement ends the job's terminal.
function stopsTerminal(reasonCode: string): boolean {
  return reasonCode === "vet-terminal-binding-conflict" ||
    reasonCode === DACS_VET_TERMINAL_PLAN_DISAGREEMENT;
}

// A recorded two-sided disagreement stops the job like a plan conflict:
// nothing more is retained, published or signed for it.
function assertNoPlanDisagreement(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  jobId: string,
): void {
  if (context.database.loadEffectInput("session", transportId(context.role, "disagreement", jobId)) !==
      undefined) {
    throw new DacsVetTerminalBundleTransportError(DACS_VET_TERMINAL_PLAN_DISAGREEMENT);
  }
}

async function assertNoPlanConflict(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  jobId: string,
): Promise<void> {
  if (await loadPlanConflict(context, jobId) !== undefined) {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-binding-conflict");
  }
  assertNoPlanDisagreement(context, jobId);
}

async function putPlanConflict(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  jobId: string,
  leftPlanHash: string,
  rightPlanHash: string,
): Promise<Readonly<DacsVetTerminalTransportConflictV1>> {
  const order = await loadOrder(context, jobId);
  const planHashes = [leftPlanHash, rightPlanHash].sort() as [string, string];
  if (!HASH_RE.test(planHashes[0]) || !HASH_RE.test(planHashes[1]) ||
      planHashes[0] === planHashes[1]) {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-binding-corrupt");
  }
  return await withPlanConflictSequence(context, jobId, () => {
    const id = transportId(context.role, "conflict", jobId);
    const existing = context.database.loadEffectInput("session", id);
    if (existing !== undefined) {
      const retained = captureConflict(existing);
      if (retained.localBindingHash !== order.localBindingHash ||
          !canonicalEqual(retained.planHashes, planHashes)) {
        throw new DacsVetTerminalBundleTransportError(
          "vet-terminal-binding-conflict",
        );
      }
      return retained;
    }
    const conflict: DacsVetTerminalTransportConflictV1 = Object.freeze({
      conflictVersion: CONFLICT_VERSION,
      localBindingHash: order.localBindingHash,
      kind: "plan-conflict",
      planHashes: Object.freeze(planHashes),
    });
    const put = context.database.putEffectIntent({
      kind: "session",
      effectId: id,
      bindingHash: order.localBindingHash,
      input: conflict,
      idempotencyKey: id,
      jobId,
    });
    if (put.status === "conflict") {
      throw new DacsVetTerminalBundleTransportError("vet-terminal-binding-conflict");
    }
    return captureConflict(context.database.loadEffectInput("session", id));
  });
}

async function invokeConflictFenced<T>(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  jobId: string,
  callback: () => Promise<T> | T,
): Promise<T> {
  const order = await loadOrder(context, jobId);
  const started = await withPlanConflictSequence(context, jobId, () => {
    if (loadPlanConflictForOrder(
      context,
      jobId,
      order.localBindingHash,
    ) !== undefined) {
      throw new DacsVetTerminalBundleTransportError(
        "vet-terminal-binding-conflict",
      );
    }
    assertNoPlanDisagreement(context, jobId);
    try {
      const value = callback();
      return {
        settled: Promise.resolve(value).then(
          (result) => ({ status: "fulfilled" as const, result }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        ),
      };
    } catch (error) {
      return {
        settled: Promise.resolve({ status: "rejected" as const, error }),
      };
    }
  });
  const settled = await started.settled;
  await assertNoPlanConflict(context, jobId);
  if (settled.status === "rejected") throw settled.error;
  return settled.result;
}

function captureBinding(value: unknown): Readonly<DacsVetTerminalTransportBindingV1> {
  if (!plainObject(value) || !exactFields(value, [
    "bindingVersion", "localBindingHash", "kind", "payloadHash", "payload",
  ], ["authenticationHash", "identityEvidenceHash"]) ||
      value.bindingVersion !== BINDING_VERSION ||
      typeof value.localBindingHash !== "string" || !HASH_RE.test(value.localBindingHash) ||
      (value.kind !== "material" && value.kind !== "proposal" &&
        value.kind !== "contribution") ||
      typeof value.payloadHash !== "string" || !HASH_RE.test(value.payloadHash) ||
      sha256Hex(canonicalize(value.payload)) !== value.payloadHash ||
      (value.authenticationHash !== undefined &&
        (typeof value.authenticationHash !== "string" ||
          !HASH_RE.test(value.authenticationHash))) ||
      (value.identityEvidenceHash !== undefined &&
        (typeof value.identityEvidenceHash !== "string" ||
          !HASH_RE.test(value.identityEvidenceHash)))) {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-binding-corrupt");
  }
  return value as unknown as Readonly<DacsVetTerminalTransportBindingV1>;
}

async function putBinding(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  kind: BindingKind,
  jobId: string,
  payload: Readonly<
    DacsVetTerminalBundleProposalV1 | TerminalBundleSignatureContribution
  >,
  authentication?: Readonly<{ authenticationHash: string; identityEvidenceHash: string }>,
): Promise<Readonly<DacsVetTerminalTransportBindingV1>> {
  const order = await loadOrder(context, jobId);
  if (loadPlanConflictForOrder(
    context,
    jobId,
    order.localBindingHash,
  ) !== undefined) {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-binding-conflict");
  }
  assertNoPlanDisagreement(context, jobId);
  if (kind !== "contribution" &&
      (payload as DacsVetTerminalBundleProposalV1).terminalInput.evaluatedRole === "seller") {
    try {
      claimDacsSellerVetOutcomeV1(context, order, "seller-failure");
    } catch (error) {
      throw error instanceof DacsPreAgreementPhaseError
        ? new DacsVetTerminalBundleTransportError(error.reasonCode)
        : busyOr(error, "vet-terminal-binding-corrupt");
    }
  }
  claimTerminalPhase(context, order);
  const signerRole = kind === "contribution"
    ? (payload as TerminalBundleSignatureContribution).signerRole as Role
    : undefined;
  const id = transportId(context.role, kind, jobId, signerRole);
  const payloadHash = sha256Hex(canonicalize(payload));
  const existing = context.database.loadEffectInput("session", id);
  if (existing !== undefined) {
    const retained = captureBinding(existing);
    if (retained.localBindingHash !== order.localBindingHash ||
        retained.kind !== kind || retained.payloadHash !== payloadHash ||
        !canonicalEqual(retained.payload, payload)) {
      throw new DacsVetTerminalBundleTransportError("vet-terminal-binding-conflict");
    }
    return retained;
  }
  const binding: DacsVetTerminalTransportBindingV1 = {
    bindingVersion: BINDING_VERSION,
    localBindingHash: order.localBindingHash,
    kind,
    payloadHash,
    payload: Object.freeze(structuredClone(payload)),
    ...(authentication === undefined ? {} : authentication),
  };
  const put = context.database.putEffectIntent({
    kind: "session",
    effectId: id,
    bindingHash: order.localBindingHash,
    input: binding,
    idempotencyKey: id,
    jobId,
  });
  if (put.status === "conflict") {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-binding-conflict");
  }
  return captureBinding(context.database.loadEffectInput("session", id));
}

async function loadBinding(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  kind: BindingKind,
  jobId: string,
  signerRole?: Role,
): Promise<Readonly<DacsVetTerminalTransportBindingV1> | undefined> {
  const order = await loadOrder(context, jobId);
  const value = context.database.loadEffectInput(
    "session",
    transportId(context.role, kind, jobId, signerRole),
  );
  if (value === undefined) return undefined;
  const binding = captureBinding(value);
  if (binding.localBindingHash !== order.localBindingHash || binding.kind !== kind) {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-binding-corrupt");
  }
  return binding;
}

function identityMatchesPlan(
  identity: Readonly<TerminalBundleTransportIdentity>,
  plan: Readonly<TerminalBundlePlan>,
): boolean {
  return identity.jobId === plan.authority.jobId &&
    identity.authorityHash === plan.authorityHash &&
    identity.planHash === plan.planHash;
}

function rejected(reasonCode: string): DacsHttpInboundDispositionV1 {
  return Object.freeze({ disposition: "rejected" as const, reasonCode });
}

function captureProposal(value: unknown): Readonly<DacsVetTerminalBundleProposalV1> {
  const snapshot = frozenJsonSnapshot(value, "vet-terminal-proposal");
  if (!plainObject(snapshot) ||
      !exactFields(snapshot, ["proposalVersion", "terminalInput", "plan"]) ||
      snapshot.proposalVersion !== "1") {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-proposal-invalid");
  }
  return Object.freeze({
    proposalVersion: "1",
    terminalInput: snapshot.terminalInput as unknown as
      Readonly<PrepareVetTerminalBundleInput>,
    plan: capturePlan(snapshot.plan),
  });
}

type ProposalAssessment =
  | Readonly<{
      disposition: "authorized";
      proposal: Readonly<DacsVetTerminalBundleProposalV1>;
      prepared: Extract<PreparedVetTerminalBundle, { status: "terminal" }>;
    }>
  | Readonly<{
      disposition: "rejected";
      reasonCode: string;
      equivocation?: Readonly<{ jobId: string; retainedPlanHash: string; offeredPlanHash: string }>;
      disagreement?: Readonly<{ jobId: string; localPlanHash: string; peerPlanHash: string }>;
      proposal?: Readonly<DacsVetTerminalBundleProposalV1>;
    }>
  | Readonly<{ disposition: "indeterminate"; reasonCode: string }>;

const optionalHash = (value: unknown): boolean =>
  value === undefined || (typeof value === "string" && HASH_RE.test(value));

function captureSelection(value: unknown): Readonly<DacsVetTerminalPlanSelectionV1> {
  if (!plainObject(value) || !exactFields(value, [
    "selectionVersion", "localBindingHash", "kind", "source", "planHash", "payloadHash", "payload",
  ], ["authenticationHash", "identityEvidenceHash"]) || value.selectionVersion !== "1" ||
      value.kind !== "plan-selection" || (value.source !== "material" && value.source !== "peer") ||
      !["localBindingHash", "planHash", "payloadHash"].every((field) =>
        typeof value[field] === "string" && HASH_RE.test(value[field] as string)) ||
      sha256Hex(canonicalize(value.payload)) !== value.payloadHash ||
      !optionalHash(value.authenticationHash) || !optionalHash(value.identityEvidenceHash) ||
      (value.authenticationHash === undefined) !== (value.identityEvidenceHash === undefined)) {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-binding-corrupt");
  }
  let payload: Readonly<DacsVetTerminalBundleProposalV1>;
  try {
    payload = captureProposal(value.payload);
  } catch {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-binding-corrupt");
  }
  if (payload.plan.planHash !== value.planHash) {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-binding-corrupt");
  }
  return Object.freeze({ ...value, payload }) as unknown as Readonly<DacsVetTerminalPlanSelectionV1>;
}

function captureDisagreement(value: unknown): Readonly<DacsVetTerminalPlanDisagreementEvidenceV1> {
  if (!plainObject(value) || !exactFields(value, [
    "evidenceVersion", "kind", "localBindingHash", "localPlanHash", "peerPlanHash", "selected",
    "losingPayloadHash", "losingPayload", "operatorAlert",
  ], ["authenticationHash", "identityEvidenceHash"]) || value.evidenceVersion !== "1" ||
      value.kind !== "plan-disagreement" || value.operatorAlert !== true ||
      (value.selected !== "local" && value.selected !== "peer") ||
      !["localBindingHash", "localPlanHash", "peerPlanHash", "losingPayloadHash"].every((field) =>
        typeof value[field] === "string" && HASH_RE.test(value[field] as string)) ||
      value.localPlanHash === value.peerPlanHash ||
      sha256Hex(canonicalize(value.losingPayload)) !== value.losingPayloadHash ||
      !optionalHash(value.authenticationHash) || !optionalHash(value.identityEvidenceHash)) {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-binding-corrupt");
  }
  return Object.freeze({ ...value }) as unknown as Readonly<DacsVetTerminalPlanDisagreementEvidenceV1>;
}

function captureEquivocation(
  value: unknown,
): Readonly<DacsVetTerminalPeerEquivocationEvidenceV1> {
  if (!plainObject(value) || !exactFields(value, [
    "evidenceVersion", "kind", "localBindingHash", "retainedPlanHash", "offeredPlanHash",
    "payloadHash", "authenticationHash", "identityEvidenceHash", "operatorAlert",
  ]) || value.evidenceVersion !== "1" || value.kind !== "peer-equivocation" ||
      typeof value.operatorAlert !== "boolean" ||
      !["localBindingHash", "retainedPlanHash", "offeredPlanHash", "payloadHash",
        "authenticationHash", "identityEvidenceHash"].every((field) =>
        typeof value[field] === "string" && HASH_RE.test(value[field] as string))) {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-binding-corrupt");
  }
  return Object.freeze({ ...value }) as Readonly<DacsVetTerminalPeerEquivocationEvidenceV1>;
}

function captureLocalVetResult(
  value: unknown,
  role: Role,
): Readonly<DacsVetTerminalLocalVetResultV1> {
  if (!plainObject(value) || value.resultVersion !== "1" ||
      typeof value.localBindingHash !== "string" || !HASH_RE.test(value.localBindingHash) ||
      !(value.kind === "local-vet-pass"
        ? exactFields(value, ["resultVersion", "localBindingHash", "kind", "evaluatedRole"]) &&
          value.evaluatedRole === otherRole(role)
        : value.kind === "local-vet-failure" &&
          exactFields(value, ["resultVersion", "localBindingHash", "kind", "planHash"]) &&
          typeof value.planHash === "string" && HASH_RE.test(value.planHash))) {
    throw new DacsVetTerminalBundleTransportError("vet-terminal-binding-corrupt");
  }
  return Object.freeze({ ...value }) as unknown as Readonly<DacsVetTerminalLocalVetResultV1>;
}

function equivocationId(role: Role, jobId: string, afterCommit: boolean): string {
  return sha256Hex(`${transportId(role, "equivocation", jobId)}:${afterCommit ? "after" : "before"}-commit`);
}

/**
 * Symmetric, authority-separated transport for pre-agreement Vet failure
 * bundles. Either role may propose, but each role independently authenticates
 * the exact Vet production, re-derives the plan, and contributes only its own
 * signature row.
 */
export function createDacsVetTerminalBundleTransportRuntimeV1(
  options: Readonly<DacsVetTerminalBundleTransportOptionsV1>,
): Readonly<DacsVetTerminalBundleTransportRuntimeV1> {
  if (!plainObject(options) || !plainObject(options.context) ||
      !exactFields(options, ["context", "authenticateProduction"], [
        "expectedRegistryVersions",
      ]) ||
      (options.context.role !== "buyer" && options.context.role !== "seller") ||
      typeof options.authenticateProduction !== "function" ||
      (options.expectedRegistryVersions !== undefined &&
        (!plainObject(options.expectedRegistryVersions) ||
          !exactFields(options.expectedRegistryVersions, [
            "recipeRegistryVersion", "railRegistryVersion",
          ]) ||
          !Number.isSafeInteger(
            options.expectedRegistryVersions.recipeRegistryVersion,
          ) || options.expectedRegistryVersions.recipeRegistryVersion <= 0 ||
          !Number.isSafeInteger(
            options.expectedRegistryVersions.railRegistryVersion,
          ) || options.expectedRegistryVersions.railRegistryVersion <= 0))) {
    throw new TypeError("Vet terminal bundle transport options are invalid");
  }
  const context = options.context;
  const role = context.role;
  const peerRole = otherRole(role);
  const authenticateProduction = options.authenticateProduction;
  const expectedRegistryVersions = options.expectedRegistryVersions === undefined
    ? undefined : Object.freeze({
        recipeRegistryVersion: options.expectedRegistryVersions.recipeRegistryVersion,
        railRegistryVersion: options.expectedRegistryVersions.railRegistryVersion,
      });

  const safeAuthenticator: PrepareVetTerminalBundleDeps["authenticateProduction"] =
    async (input) => {
      let value: unknown;
      try {
        value = await Reflect.apply(authenticateProduction, undefined, [input]);
      } catch {
        return Object.freeze({
          status: "indeterminate" as const,
          reason: "Vet production authentication unavailable",
        });
      }
      if (plainObject(value) && value.status === "valid" &&
          exactFields(value, ["status"], ["cause"])) {
        // The core bridge validates cause shape and session/record binding.
        return Object.freeze(snapshotJson(value, "vet-production-authentication")) as Awaited<
          ReturnType<PrepareVetTerminalBundleDeps["authenticateProduction"]>>;
      }
      if (plainObject(value) &&
          (value.status === "invalid" || value.status === "indeterminate") &&
          exactFields(value, ["status", "reason"]) &&
          typeof value.reason === "string" && value.reason.length > 0) {
        return Object.freeze({ status: value.status, reason: value.reason });
      }
      return Object.freeze({
        status: "indeterminate" as const,
        reason: "Vet production authenticator returned an invalid result",
      });
    };

  const assertProposalOrder = async (
    proposal: Readonly<DacsVetTerminalBundleProposalV1>,
    requireRegistryAuthority: boolean,
  ): Promise<void> => {
    const order = await loadOrder(context, proposal.terminalInput.jobId);
    assertPreAgreementTerminal(context, order, proposal.terminalInput.evaluatedRole);
    const paymentSteps = proposal.terminalInput.pipeline.filter((step) =>
      step.kind === "pay-x402" || step.kind === "pay-dem");
    if (paymentSteps.length !== 1 ||
        paymentSteps[0]?.kind !== order.rail.phaseHandler ||
        paymentSteps[0].parameters?.rail !== order.rail.railId) {
      throw new DacsVetTerminalBundleTransportError(
        "vet-terminal-proposal-rail-mismatch",
      );
    }
    if (proposal.terminalInput.listingRef.version !== order.listingRef.version) {
      throw new DacsVetTerminalBundleTransportError(
        "vet-terminal-proposal-version-mismatch",
      );
    }
    if (proposal.terminalInput.listingRef.listingId !== order.listingRef.listingId ||
        proposal.terminalInput.listingRef.contentHash !== order.listingRef.contentHash ||
        !canonicalEqual(proposal.terminalInput.pipeline, order.pipeline)) {
      throw new DacsVetTerminalBundleTransportError(
        "vet-terminal-proposal-listing-mismatch",
      );
    }
    let registryVersions = expectedRegistryVersions;
    if (registryVersions === undefined) {
      const localMaterial = context.database.loadEffectInput(
        "session",
        transportId(context.role, "material", proposal.terminalInput.jobId),
      );
      if (localMaterial === undefined) {
        if (requireRegistryAuthority) {
          throw new DacsVetTerminalBundleTransportError(
            "vet-terminal-proposal-version-authority-unavailable",
          );
        }
        return;
      }
      const binding = captureBinding(localMaterial);
      const retained = captureProposal(binding.payload);
      if (binding.localBindingHash !== order.localBindingHash ||
          binding.kind !== "material") {
        throw new DacsVetTerminalBundleTransportError("vet-terminal-binding-corrupt");
      }
      registryVersions = retained.terminalInput;
    }
    if (proposal.terminalInput.recipeRegistryVersion !==
          registryVersions.recipeRegistryVersion ||
        proposal.terminalInput.railRegistryVersion !==
          registryVersions.railRegistryVersion) {
      throw new DacsVetTerminalBundleTransportError(
        "vet-terminal-proposal-version-mismatch",
      );
    }
  };

  const evidenceAt = (kind: "local-evidence" | "peer-evidence", jobId: string) =>
    context.database.loadEffectInput("session", transportId(role, kind, jobId)) as
      Readonly<DacsVetTerminalEvidenceV1> | undefined;

  // Receipt observations are immutable snapshots, not CVR identity (CORE
  // SR2-7). Both receipts are authenticated separately; compare signed record
  // bytes and their exact reference, so a newer observation is still allowed.
  const sameProduction = (left: PrepareVetTerminalBundleInput["production"] | undefined,
    right: PrepareVetTerminalBundleInput["production"] | undefined) =>
    left !== undefined && right !== undefined && canonicalEqual(
      { record: left.record, recordRef: left.recordRef },
      { record: right.record, recordRef: right.recordRef });

  const storeEvidence = async (kind: "local-evidence" | "peer-evidence",
    evidence: Readonly<DacsVetTerminalEvidenceV1>, localBindingHash?: string) => {
    const jobId = evidence.terminalInput.jobId;
    const bindingHash = localBindingHash ?? (await loadOrder(context, jobId)).localBindingHash;
    // Evidence and full proposals share one immutable production per direction.
    // An evidence message arriving after selection cannot replace that CVR.
    for (const retainedKind of ["material", "proposal"] as const) {
      const value = context.database.loadEffectInput("session", transportId(role, retainedKind, jobId));
      if (value === undefined) continue;
      const binding = captureBinding(value);
      if (binding.localBindingHash !== bindingHash || binding.kind !== retainedKind) {
        throw new DacsVetTerminalBundleTransportError("vet-terminal-binding-corrupt");
      }
      const retained = captureProposal(binding.payload).terminalInput;
      const evaluated = kind === "local-evidence" ? peerRole : role;
      const production = retained.evaluatedRole === evaluated
        ? retained.production : retained.complementaryProduction;
      if (!sameProduction(production, evidence.terminalInput.production)) {
        throw new DacsVetTerminalBundleTransportError(LOCAL_VET_CONFLICT);
      }
    }
    const id = transportId(role, kind, jobId);
    const put = context.database.putEffectIntent({ kind: "session", effectId: id,
      bindingHash, input: evidence, idempotencyKey: id, jobId });
    if (put.status === "conflict") {
      const retained = evidenceAt(kind, jobId);
      if (retained === undefined || !canonicalEqual(
        { ...retained.terminalInput, production: { ...retained.terminalInput.production, anchorReceipt: null } },
        { ...evidence.terminalInput, production: { ...evidence.terminalInput.production, anchorReceipt: null } })) {
        throw new DacsVetTerminalBundleTransportError(LOCAL_VET_CONFLICT);
      }
    }
  };

  const captureEvidence = async (value: unknown, jobId: string) => {
    const evidence = frozenJsonSnapshot(value, "vet-terminal-evidence") as unknown as
      Readonly<DacsVetTerminalEvidenceV1>;
    if (!plainObject(evidence) || !exactFields(evidence, ["vetEvidenceVersion", "terminalInput"]) ||
        evidence.vetEvidenceVersion !== "1" || evidence.terminalInput?.jobId !== jobId ||
        evidence.terminalInput.evaluatedRole !== role ||
        evidence.terminalInput.complementaryProduction !== undefined) {
      throw new DacsVetTerminalBundleTransportError("vet-terminal-evidence-invalid");
    }
    await assertProposalOrder({ terminalInput: evidence.terminalInput } as DacsVetTerminalBundleProposalV1, true);
    const parties = evidence.terminalInput.parties;
    if (parties.find((party) => party.role === role)?.identityBundle.presentedBy !== context.authority ||
        parties.find((party) => party.role === peerRole)?.identityBundle.presentedBy !== context.peerAuthority) {
      throw new DacsVetTerminalBundleTransportError("vet-terminal-evidence-invalid");
    }
    const prepared = await prepareVetTerminalBundle(evidence.terminalInput, { authenticateProduction: safeAuthenticator });
    if (prepared.status === "indeterminate") throw new DacsVetTerminalBundleTransportError("vet-terminal-production-indeterminate");
    if (prepared.status !== "pass" && prepared.status !== "terminal") {
      throw new DacsVetTerminalBundleTransportError("vet-terminal-evidence-invalid");
    }
    return evidence;
  };

  const sendEvidence = async (evidence: Readonly<DacsVetTerminalEvidenceV1>) => {
    const message = { jobId: evidence.terminalInput.jobId, payload: evidence,
      idempotencyKey: `vet-terminal-evidence:v1:${sha256Hex(canonicalize(evidence))}` };
    try {
      await context.sendMessage(role === "buyer"
        ? { ...message, type: "terminal-bundle-proposal-buyer" }
        : { ...message, type: "terminal-bundle-proposal-seller" });
    } catch {
      throw new DacsVetTerminalBundleTransportError("vet-terminal-production-indeterminate");
    }
  };

  const retainedLocalInput = (input: Readonly<PrepareVetTerminalBundleInput>) => {
    const materialValue = context.database.loadEffectInput("session", transportId(role, "material", input.jobId));
    const material = materialValue === undefined ? undefined : captureBinding(materialValue);
    if (material !== undefined && material.kind !== "material") {
      throw new DacsVetTerminalBundleTransportError("vet-terminal-binding-corrupt");
    }
    const complete = material === undefined ? undefined : captureProposal(material.payload).terminalInput;
    const evidence = evidenceAt("local-evidence", input.jobId)?.terminalInput;
    const retained = evidence ?? complete;
    if (retained === undefined) return input;
    const scope = (value: Readonly<PrepareVetTerminalBundleInput>) => {
      const { anchorReceipt: _receipt, ...production } = value.production;
      const { complementaryProduction: _peer, ...rest } = value;
      return { ...rest, production };
    };
    if (!canonicalEqual(scope(retained), scope(input))) {
      if (evidence !== undefined) throw new DacsVetTerminalBundleTransportError(LOCAL_VET_CONFLICT);
      // A different complete plan follows the existing durable conflict path.
      return input;
    }
    if (complete !== undefined && input.complementaryProduction !== undefined &&
        !sameProduction(complete.complementaryProduction, input.complementaryProduction)) return input;
    return frozenJsonSnapshot({ ...input, production: retained.production,
      ...(complete?.complementaryProduction === undefined ? {} : {
        complementaryProduction: complete.complementaryProduction,
      }),
    }, "vet-terminal-retained-input") as Readonly<PrepareVetTerminalBundleInput>;
  };

  const assertRetainedEvidence = (input: Readonly<PrepareVetTerminalBundleInput>,
    kinds: readonly ("local-evidence" | "peer-evidence")[] = ["local-evidence", "peer-evidence"]) => {
    for (const kind of kinds) {
      const retained = evidenceAt(kind, input.jobId);
      if (retained === undefined) continue;
      const evaluated = kind === "local-evidence" ? peerRole : role;
      const production = input.evaluatedRole === evaluated
        ? input.production : input.complementaryProduction;
      if (!sameProduction(retained.terminalInput.production, production)) {
        throw new DacsVetTerminalBundleTransportError(LOCAL_VET_CONFLICT);
      }
    }
  };

  const assessProposalCandidate = async (
    value: unknown,
  ): Promise<ProposalAssessment> => {
    let proposal: Readonly<DacsVetTerminalBundleProposalV1>;
    let prepared: PreparedVetTerminalBundle;
    try {
      proposal = captureProposal(value);
      if (proposal.terminalInput.complementaryProduction === undefined) {
        throw new DacsVetTerminalBundleTransportError("vet-terminal-evidence-incomplete");
      }
    } catch {
      return Object.freeze({
        disposition: "rejected" as const,
        reasonCode: "vet-terminal-proposal-invalid",
      });
    }
    try {
      await assertProposalOrder(proposal, true);
      assertRetainedEvidence(proposal.terminalInput, ["peer-evidence"]);
    } catch (error) {
      rethrowBusy(error);
      if (isPendingValidationPrerequisite(error)) {
        return Object.freeze({ disposition: "indeterminate" as const, reasonCode: error.reasonCode });
      }
      return Object.freeze({
        disposition: "rejected" as const,
        reasonCode: error instanceof DacsVetTerminalBundleTransportError
          ? error.reasonCode : "vet-terminal-proposal-invalid",
      });
    }
    try {
      prepared = await prepareVetTerminalBundle(proposal.terminalInput, {
        authenticateProduction: safeAuthenticator,
      });
    } catch {
      return Object.freeze({
        disposition: "rejected" as const,
        reasonCode: "vet-terminal-proposal-invalid",
      });
    }
    if (prepared.status === "indeterminate") {
      return Object.freeze({
        disposition: "indeterminate" as const,
        reasonCode: "vet-terminal-production-indeterminate",
      });
    }
    if (prepared.status !== "terminal") {
      return Object.freeze({
        disposition: "rejected" as const,
        reasonCode: prepared.status === "pass"
          ? "vet-terminal-production-passed"
          : "vet-terminal-production-invalid",
      });
    }
    try {
      const derivedPlan = createTerminalBundlePlan(prepared.authority, {
        kind: "co-signed",
      });
      if (!canonicalEqual(proposal.plan, derivedPlan) ||
          proposal.terminalInput.jobId !== proposal.plan.authority.jobId) {
        throw new DacsVetTerminalBundleTransportError("vet-terminal-proposal-mismatch");
      }
      assertPlanParties(context, derivedPlan);
      return Object.freeze({
        disposition: "authorized" as const,
        proposal: Object.freeze({
          proposalVersion: "1" as const,
          terminalInput: frozenJsonSnapshot(
            proposal.terminalInput,
            "vet-terminal-input",
          ),
          plan: Object.freeze(structuredClone(derivedPlan)),
        }),
        prepared,
      });
    } catch (error) {
      return Object.freeze({
        disposition: "rejected" as const,
        reasonCode: error instanceof DacsVetTerminalBundleTransportError
          ? error.reasonCode : "vet-terminal-proposal-invalid",
      });
    }
  };

  // `seal` records a conflict between plans this role itself retained. A
  // peer's message ("peer") never writes here: a plan that differs from the
  // selected one is classified against it (disagreement or equivocation).
  const detectPlanConflict = async (
    proposal: Readonly<DacsVetTerminalBundleProposalV1>,
    seal: boolean | "peer",
  ): Promise<void> => {
    const jobId = proposal.plan.authority.jobId;
    await assertNoPlanConflict(context, jobId);
    if (seal === "peer") {
      const choice = await classifyPlan(proposal, "peer", await loadSelection(jobId));
      if (choice.disposition === "equivocation") {
        throw new PeerPlanEquivocation(choice.retainedPlanHash, choice.offeredPlanHash);
      }
      if (choice.disposition === "disagreement") {
        throw new PeerPlanDisagreement(choice.localPlanHash, choice.peerPlanHash);
      }
    }
    const bindings = await Promise.all([
      loadBinding(context, "material", jobId),
      loadBinding(context, "proposal", jobId),
    ]);
    for (const binding of bindings) {
      if (binding === undefined) continue;
      const retained = captureProposal(binding.payload);
      if (retained.plan.planHash === proposal.plan.planHash) continue;
      if (seal === "peer") {
        throw new PeerPlanEquivocation(retained.plan.planHash, proposal.plan.planHash);
      }
      if (seal) {
        await putPlanConflict(
          context,
          jobId,
          proposal.plan.planHash,
          retained.plan.planHash,
        );
      }
      throw new DacsVetTerminalBundleTransportError(
        "vet-terminal-binding-conflict",
      );
    }
  };

  const assessProposal = async (
    value: unknown,
    sealConflict: boolean | "peer" = false,
  ): Promise<ProposalAssessment> => {
    let captured: Readonly<DacsVetTerminalBundleProposalV1>;
    try {
      captured = captureProposal(value);
      await assertNoPlanConflict(context, captured.terminalInput.jobId);
    } catch (error) {
      rethrowBusy(error);
      return Object.freeze({
        disposition: "rejected" as const,
        reasonCode: error instanceof DacsVetTerminalBundleTransportError
          ? error.reasonCode : "vet-terminal-proposal-invalid",
      });
    }
    const assessment = await assessProposalCandidate(captured);
    if (assessment.disposition !== "authorized") return assessment;
    try {
      await detectPlanConflict(assessment.proposal, sealConflict);
      return assessment;
    } catch (error) {
      rethrowBusy(error);
      if (error instanceof PeerPlanEquivocation) {
        return Object.freeze({
          disposition: "rejected" as const,
          reasonCode: error.reasonCode,
          equivocation: Object.freeze({
            jobId: assessment.proposal.plan.authority.jobId,
            retainedPlanHash: error.retainedPlanHash,
            offeredPlanHash: error.offeredPlanHash,
          }),
        });
      }
      if (error instanceof PeerPlanDisagreement) {
        return Object.freeze({
          disposition: "rejected" as const,
          reasonCode: error.reasonCode,
          disagreement: Object.freeze({
            jobId: assessment.proposal.plan.authority.jobId,
            localPlanHash: error.localPlanHash,
            peerPlanHash: error.peerPlanHash,
          }),
          proposal: assessment.proposal,
        });
      }
      return Object.freeze({
        disposition: "rejected" as const,
        reasonCode: error instanceof DacsVetTerminalBundleTransportError
          ? error.reasonCode : "vet-terminal-proposal-invalid",
      });
    }
  };

  // Keeps the first refused equivocation before and after this role committed
  // to its retained plan. Insert-once, so a peer can add at most two records
  // per job, and nothing reads them to gate the job.
  const recordEquivocation = async (
    jobId: string,
    equivocation: Readonly<{ retainedPlanHash: string; offeredPlanHash: string }>,
    payload: unknown,
    authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
  ): Promise<void> => {
    const order = await loadOrder(context, jobId);
    const committed = await loadBinding(context, "proposal", jobId) !== undefined ||
      await loadBinding(context, "contribution", jobId, role) !== undefined;
    const id = equivocationId(role, jobId, committed);
    const evidence = captureEquivocation({
      evidenceVersion: "1",
      kind: "peer-equivocation",
      localBindingHash: order.localBindingHash,
      retainedPlanHash: equivocation.retainedPlanHash,
      offeredPlanHash: equivocation.offeredPlanHash,
      payloadHash: sha256Hex(canonicalize(payload)),
      authenticationHash: authenticated.authenticationHash,
      identityEvidenceHash: authenticated.identityEvidenceHash,
      operatorAlert: committed,
    });
    context.database.putEffectIntent({
      kind: "session",
      effectId: id,
      bindingHash: order.localBindingHash,
      input: evidence,
      idempotencyKey: id,
      jobId,
    });
  };

  const loadSelection = async (
    jobId: string,
  ): Promise<Readonly<DacsVetTerminalPlanSelectionV1> | undefined> => {
    const order = await loadOrder(context, jobId);
    const value = context.database.loadEffectInput("session", transportId(role, "selection", jobId));
    if (value === undefined) return undefined;
    const selection = captureSelection(value);
    if (selection.localBindingHash !== order.localBindingHash) {
      throw new DacsVetTerminalBundleTransportError("vet-terminal-binding-corrupt");
    }
    return selection;
  };

  // Selects `proposal` as the job's plan unless one is already selected, and
  // returns the selected plan. It is one insert-once write before the phase
  // claim and the binding, so local registration and an inbound proposal racing
  // in two processes agree on the first plan, and a crash after it leaves a
  // selection that the next tick completes rather than a stranded phase.
  const selectPlan = async (
    proposal: Readonly<DacsVetTerminalBundleProposalV1>,
    source: "material" | "peer",
    authentication?: Readonly<{ authenticationHash: string; identityEvidenceHash: string }>,
  ): Promise<Readonly<DacsVetTerminalPlanSelectionV1>> => {
    const jobId = proposal.plan.authority.jobId;
    const order = await loadOrder(context, jobId);
    const id = transportId(role, "selection", jobId);
    context.database.putEffectIntent({
      kind: "session",
      effectId: id,
      bindingHash: order.localBindingHash,
      input: {
        selectionVersion: "1",
        localBindingHash: order.localBindingHash,
        kind: "plan-selection",
        source,
        planHash: proposal.plan.planHash,
        payloadHash: sha256Hex(canonicalize(proposal)),
        payload: proposal,
        ...(authentication ?? {}),
      },
      idempotencyKey: id,
      jobId,
    });
    const selection = await loadSelection(jobId);
    if (selection === undefined) {
      throw new DacsVetTerminalBundleTransportError("vet-terminal-binding-corrupt");
    }
    return selection;
  };

  // How a plan relates to the selected one. This role's own Vet failure and
  // the peer's first plan disagree in either arrival order; a peer plan after
  // one this role retained from the peer is equivocation; two plans of this
  // role's own are a plan conflict.
  const classifyPlan = async (
    proposal: Readonly<DacsVetTerminalBundleProposalV1>,
    source: "material" | "peer",
    selection: Readonly<DacsVetTerminalPlanSelectionV1> | undefined,
  ): Promise<
    | Readonly<{ disposition: "selected" }>
    | Readonly<{ disposition: "disagreement"; localPlanHash: string; peerPlanHash: string }>
    | Readonly<{ disposition: "equivocation"; retainedPlanHash: string; offeredPlanHash: string }>
    | Readonly<{ disposition: "own-conflict"; retainedPlanHash: string }>
  > => {
    const planHash = proposal.plan.planHash;
    if (selection === undefined || selection.planHash === planHash) {
      return { disposition: "selected" };
    }
    if (source === "material") {
      return selection.source === "peer"
        ? { disposition: "disagreement", localPlanHash: planHash, peerPlanHash: selection.planHash }
        : { disposition: "own-conflict", retainedPlanHash: selection.planHash };
    }
    const peerPlanRetained = selection.source === "peer" ||
      (await loadBinding(context, "proposal", proposal.plan.authority.jobId))
        ?.authenticationHash !== undefined;
    return peerPlanRetained
      ? { disposition: "equivocation", retainedPlanHash: selection.planHash, offeredPlanHash: planHash }
      : { disposition: "disagreement", localPlanHash: selection.planHash, peerPlanHash: planHash };
  };

  // Keeps the losing plan as evidence and stops the job for this role.
  // Insert-once: the first disagreement recorded stays.
  const recordDisagreement = async (
    jobId: string,
    disagreement: Readonly<{ localPlanHash: string; peerPlanHash: string }>,
    losing: Readonly<DacsVetTerminalBundleProposalV1>,
    authentication?: Readonly<{ authenticationHash: string; identityEvidenceHash: string }>,
  ): Promise<void> => {
    const order = await loadOrder(context, jobId);
    const id = transportId(role, "disagreement", jobId);
    const evidence = captureDisagreement({
      evidenceVersion: "1",
      kind: "plan-disagreement",
      localBindingHash: order.localBindingHash,
      localPlanHash: disagreement.localPlanHash,
      peerPlanHash: disagreement.peerPlanHash,
      selected: losing.plan.planHash === disagreement.localPlanHash ? "peer" : "local",
      losingPayloadHash: sha256Hex(canonicalize(losing)),
      losingPayload: losing,
      ...(authentication ?? {}),
      operatorAlert: true,
    });
    context.database.putEffectIntent({
      kind: "session",
      effectId: id,
      bindingHash: order.localBindingHash,
      input: evidence,
      idempotencyKey: id,
      jobId,
    });
  };

  const loadDisagreement = async (
    jobId: string,
  ): Promise<Readonly<DacsVetTerminalPlanDisagreementEvidenceV1> | undefined> => {
    const order = await loadOrder(context, jobId);
    const value = context.database.loadEffectInput("session", transportId(role, "disagreement", jobId));
    if (value === undefined) return undefined;
    const evidence = captureDisagreement(value);
    if (evidence.localBindingHash !== order.localBindingHash) {
      throw new DacsVetTerminalBundleTransportError("vet-terminal-binding-corrupt");
    }
    return evidence;
  };

  // This role's own Vet result, from durable state only: its recorded pass or
  // failure, the plan of a failure registered before that record existed
  // (registered, selected, or kept as a disagreement's evidence), or a pass
  // implied by retained agreement facts. Undefined while this role's own Vet
  // has not decided.
  const loadLocalVetResult = async (jobId: string): Promise<
    Readonly<{ status: "failed"; planHash: string }> | Readonly<{ status: "passed" }> | undefined
  > => {
    const order = await loadOrder(context, jobId);
    const value = context.database.loadEffectInput("session", transportId(role, "local-vet", jobId));
    const recorded = value === undefined ? undefined : captureLocalVetResult(value, role);
    if (recorded !== undefined && recorded.localBindingHash !== order.localBindingHash) {
      throw new DacsVetTerminalBundleTransportError("vet-terminal-binding-corrupt");
    }
    let failedPlanHash = (await loadDisagreement(jobId))?.localPlanHash;
    if (failedPlanHash === undefined) {
      const material = await loadBinding(context, "material", jobId);
      if (material !== undefined) failedPlanHash = captureProposal(material.payload).plan.planHash;
    }
    if (failedPlanHash === undefined) {
      const selection = await loadSelection(jobId);
      if (selection?.source === "material") failedPlanHash = selection.planHash;
    }
    if (recorded?.kind === "local-vet-pass") {
      // A pass beside a failure's plan: the same Vet was recorded both ways,
      // so neither result stands and an operator decides.
      if (failedPlanHash !== undefined) {
        throw new DacsVetTerminalBundleTransportError(LOCAL_VET_CONFLICT);
      }
      return { status: "passed" };
    }
    if (recorded?.kind === "local-vet-failure") {
      if (failedPlanHash !== undefined && failedPlanHash !== recorded.planHash) {
        throw new DacsVetTerminalBundleTransportError("vet-terminal-binding-corrupt");
      }
      return { status: "failed", planHash: recorded.planHash };
    }
    if (failedPlanHash !== undefined) return { status: "failed", planHash: failedPlanHash };
    return context.database.loadEffectInput("session", dacsSessionAgreementFactsIdV1(role, jobId)) ===
      undefined ? undefined : { status: "passed" };
  };

  // Records this role's own Vet result in its one insert-once row, or throws
  // if the row already holds a different result: a pass against a failure is
  // a conflict for an operator, and a second, different failure seals the
  // job's plans as an own-plan conflict. Either way nothing else is written.
  const claimLocalVetResult = async (
    jobId: string,
    result: Readonly<DacsVetTerminalLocalVetResultV1>,
  ): Promise<void> => {
    const id = transportId(role, "local-vet", jobId);
    const put = context.database.putEffectIntent({
      kind: "session",
      effectId: id,
      bindingHash: result.localBindingHash,
      input: result,
      idempotencyKey: id,
      jobId,
    });
    if (put.status !== "conflict") return;
    const value = context.database.loadEffectInput("session", id);
    const retained = value === undefined ? undefined : captureLocalVetResult(value, role);
    if (retained === undefined || retained.localBindingHash !== result.localBindingHash) {
      throw new DacsVetTerminalBundleTransportError("vet-terminal-binding-corrupt");
    }
    if (retained.kind === "local-vet-failure" && result.kind === "local-vet-failure") {
      await putPlanConflict(context, jobId, result.planHash, retained.planHash);
      throw new DacsVetTerminalBundleTransportError("vet-terminal-binding-conflict");
    }
    throw new DacsVetTerminalBundleTransportError(LOCAL_VET_CONFLICT);
  };

  // A plan is accepted from the peer, and signed, only once this role's own
  // Vet result is durable and agrees with it: this role's own failure is that
  // plan, or this role's Vet of the peer passed and the plan is the peer's
  // failure of this role. The peer signs only after that acceptance, so a
  // later, different local failure finds nothing signed on either role.
  const assertLocalVetAgrees = async (
    proposal: Readonly<DacsVetTerminalBundleProposalV1>,
  ): Promise<void> => {
    const local = await loadLocalVetResult(proposal.plan.authority.jobId);
    if (local === undefined) {
      throw new DacsVetTerminalBundleTransportError(DACS_VET_TERMINAL_LOCAL_VET_PENDING);
    }
    if (local.status === "failed"
      ? local.planHash !== proposal.plan.planHash
      : proposal.terminalInput.evaluatedRole !== role) {
      throw new DacsVetTerminalBundleTransportError(LOCAL_VET_CONFLICT);
    }
    assertRetainedEvidence(proposal.terminalInput);
    if (local.status === "passed") {
      const evidence = evidenceAt("local-evidence", proposal.terminalInput.jobId);
      if (evidence === undefined) throw new DacsVetTerminalBundleTransportError(DACS_VET_TERMINAL_LOCAL_VET_PENDING);
      if (!sameProduction(evidence.terminalInput.production, proposal.terminalInput.complementaryProduction)) {
        throw new DacsVetTerminalBundleTransportError(LOCAL_VET_CONFLICT);
      }
    }
  };

  // The peer stops only once it sees this role's own plan, so the notice is
  // that plan as a proposal, with the same idempotency key a publication of it
  // uses. Any acknowledgement, including a refusal, delivers it.
  const deliverDisagreementNotice = async (jobId: string): Promise<boolean> => {
    const disagreement = await loadDisagreement(jobId);
    const own = disagreement?.selected === "peer"
      ? disagreement.losingPayload : (await loadSelection(jobId))?.payload;
    if (disagreement === undefined || own === undefined ||
        own.plan.planHash !== disagreement.localPlanHash) {
      throw new DacsVetTerminalBundleTransportError("vet-terminal-binding-corrupt");
    }
    try {
      const idempotencyKey = `vet-terminal-proposal:v1:${own.plan.planHash}`;
      const message = role === "buyer"
        ? await context.sendMessage({ type: "terminal-bundle-proposal-buyer", jobId, payload: own,
            idempotencyKey } satisfies DacsLiveRoleSendInputV1<"terminal-bundle-proposal-buyer">)
        : await context.sendMessage({ type: "terminal-bundle-proposal-seller", jobId, payload: own,
            idempotencyKey } satisfies DacsLiveRoleSendInputV1<"terminal-bundle-proposal-seller">);
      return message.envelope.type === "acknowledgement";
    } catch {
      return false;
    }
  };

  const loadRegistered = async (
    jobId: string,
  ): Promise<Extract<ProposalAssessment, { disposition: "authorized" }>> => {
    // A job that never retained terminal state has no Vet failure to finalize.
    // Answer that before the full order lookup so an order lookup failure on a
    // healthy job cannot block its agreement and audit tracks.
    if ((["material", "proposal", "conflict", "selection", "disagreement"] as const).every((kind) =>
      context.database.loadEffectInput("session", transportId(role, kind, jobId)) ===
        undefined)) {
      throw new DacsVetTerminalBundleTransportError("vet-terminal-material-unavailable");
    }
    // A disagreement stops this role once the peer has this role's own plan,
    // so that the peer stops too.
    if (await loadDisagreement(jobId) !== undefined) {
      throw new DacsVetTerminalBundleTransportError(await deliverDisagreementNotice(jobId)
        ? DACS_VET_TERMINAL_PLAN_DISAGREEMENT : DACS_VET_TERMINAL_PLAN_DISAGREEMENT_NOTICE_PENDING);
    }
    await assertNoPlanConflict(context, jobId);
    const material = await loadBinding(context, "material", jobId);
    let binding = material ?? await loadBinding(context, "proposal", jobId);
    const selection = binding === undefined ? await loadSelection(jobId) : undefined;
    if (binding === undefined) {
      // A crash came after the plan was selected and before its binding, or
      // the peer's plan is selected and waits for this role's own Vet result.
      if (selection === undefined) {
        throw new DacsVetTerminalBundleTransportError("vet-terminal-material-unavailable");
      }
      // Or the agreement took the phase in between, in another process: the
      // peer's plan was refused there and never bound, exactly as if it had
      // arrived after the agreement, so the agreement track decides the job.
      if (selection.source === "peer" && (await loadOrder(context, jobId)).phase === "agreement") {
        throw new DacsVetTerminalBundleTransportError("vet-terminal-material-unavailable");
      }
    }
    // Without material of its own, the plan is the peer's: it is bound,
    // the phase claimed and anything signed only once this role's own Vet
    // result agrees with it.
    const peerPlan = material !== undefined ? undefined
      : binding?.payload ?? (selection?.source === "peer" ? selection.payload : undefined);
    if (peerPlan !== undefined) {
      await assertLocalVetAgrees(captureProposal(peerPlan));
    } else {
      // This role's own plan is signed only while no pass of the same Vet is
      // recorded beside it.
      await loadLocalVetResult(jobId);
    }
    if (binding === undefined) {
      const selected = selection as Readonly<DacsVetTerminalPlanSelectionV1>;
      binding = await putBinding(
        context,
        selected.source === "material" ? "material" : "proposal",
        jobId,
        selected.payload,
        selected.authenticationHash === undefined || selected.identityEvidenceHash === undefined
          ? undefined : {
              authenticationHash: selected.authenticationHash,
              identityEvidenceHash: selected.identityEvidenceHash,
            },
      );
    }
    assertRetainedEvidence(captureProposal(binding.payload).terminalInput);
    const assessment = await assessProposal(binding.payload, true);
    if (assessment.disposition !== "authorized") {
      throw new DacsVetTerminalBundleTransportError(assessment.reasonCode);
    }
    return assessment;
  };

  const terminalProvider = (
    proposal: Readonly<DacsVetTerminalBundleProposalV1>,
  ): Readonly<DurableTerminalBundleProvider> => {
    const jobId = proposal.plan.authority.jobId;
    const buyer = proposal.plan.authority.parties.find((party) => party.role === "buyer");
    const seller = proposal.plan.authority.parties.find((party) => party.role === "seller");
    if (buyer === undefined || seller === undefined) {
      throw new DacsVetTerminalBundleTransportError("vet-terminal-plan-party-mismatch");
    }
    return createVetTerminalBundleProvider({
      role,
      publication: createDacsDemosBundlePublicationV1({
        context,
        jobId,
        buyer: buyer.primaryClaim,
        seller: seller.primaryClaim,
      }),
      assertNoPlanConflict: () => assertNoPlanConflict(context, jobId),
      conflictFenced: (callback) => invokeConflictFenced(context, jobId, callback),
      refuse: (reason) => new DacsVetTerminalBundleTransportError(reason),
    });
  };

  const validatePayload: DacsHttpPayloadValidatorV1 = async (input) => {
    const proposalType = `terminal-bundle-proposal-${peerRole}`;
    const contributionType = `terminal-bundle-contribution-${peerRole}`;
    if (input.sender !== context.peerAuthority || input.audience !== context.authority ||
        (input.type !== proposalType && input.type !== contributionType)) {
      return payloadValidation(false, "vet-terminal-message-role-incompatible");
    }
    try {
      await assertNoPlanConflict(context, input.jobId);
      if (input.type === proposalType) {
        if (plainObject(input.payload) && input.payload.vetEvidenceVersion === "1") {
          await captureEvidence(input.payload, input.jobId);
          return payloadValidation(true, "vet-terminal-evidence-invalid");
        }
        await loadOrder(context, input.jobId);
        // Validation never writes. An authentic plan that conflicts with the
        // selected one passes transport validation so the inbox keeps the
        // authenticated envelope as evidence; handleMessage refuses it.
        const assessment = await assessProposal(input.payload, "peer");
        const differing = assessment.disposition === "rejected"
          ? assessment.equivocation ?? assessment.disagreement : undefined;
        if (differing !== undefined) {
          return differing.jobId === input.jobId
            ? payloadValidation(true, "vet-terminal-proposal-invalid")
            : payloadValidation(false, "vet-terminal-proposal-job-mismatch");
        }
        if (assessment.disposition === "indeterminate") {
          return Object.freeze({
            status: "unavailable" as const,
            reasonCode: assessment.reasonCode,
          });
        }
        if (assessment.disposition === "rejected" ||
            assessment.proposal.plan.authority.jobId !== input.jobId) {
          return payloadValidation(false, assessment.disposition === "rejected"
            ? assessment.reasonCode : "vet-terminal-proposal-job-mismatch");
        }
        return payloadValidation(true, "vet-terminal-proposal-invalid");
      }
      const proposal = await loadBinding(context, "proposal", input.jobId);
      if (proposal === undefined) {
        return Object.freeze({
          status: "unavailable" as const,
          reasonCode: "vet-terminal-proposal-pending",
        });
      }
      const assessment = await assessProposal(proposal.payload);
      if (assessment.disposition === "indeterminate") {
        return Object.freeze({ status: "unavailable" as const, reasonCode: assessment.reasonCode });
      }
      if (assessment.disposition === "rejected") {
        return payloadValidation(false, assessment.reasonCode);
      }
      const contribution = captureContribution(assessment.proposal.plan, input.payload);
      return payloadValidation(
        contribution.signerRole === peerRole,
        "vet-terminal-contribution-invalid",
      );
    } catch (error) {
      if (isPendingValidationPrerequisite(error)) {
        return Object.freeze({ status: "unavailable" as const, reasonCode: error.reasonCode });
      }
      // The store was locked, so nothing was decided: the sender retries.
      if (isDacsNodeSqliteBusyError(error)) {
        return Object.freeze({ status: "unavailable" as const, reasonCode: "vet-terminal-store-busy" });
      }
      return payloadValidation(false, error instanceof DacsVetTerminalBundleTransportError
        ? error.reasonCode : "vet-terminal-message-invalid");
    }
  };

  const transport: TerminalBundleTransport = Object.freeze({
    async resolveProposal(
      identity: Readonly<TerminalBundleTransportIdentity>,
    ): Promise<TerminalBundleResolution<unknown>> {
      try {
        await assertNoPlanConflict(context, identity.jobId);
        const binding = await loadBinding(context, "proposal", identity.jobId);
        if (binding === undefined) {
          return { disposition: "authoritatively-absent",
            reason: "vet-terminal-proposal-absent" };
        }
        assertRetainedEvidence(captureProposal(binding.payload).terminalInput);
        const assessment = await assessProposal(binding.payload);
        if (assessment.disposition === "rejected") {
          return stopsTerminal(assessment.reasonCode)
            ? { disposition: "rejected", reason: assessment.reasonCode }
            : { disposition: "indeterminate", reason: assessment.reasonCode };
        }
        if (assessment.disposition === "indeterminate") {
          return { disposition: "indeterminate", reason: assessment.reasonCode };
        }
        return identityMatchesPlan(identity, assessment.proposal.plan)
          ? { disposition: "present", value: assessment.proposal.plan }
          : { disposition: "rejected", reason: "vet-terminal-proposal-conflict" };
      } catch (error) {
        return error instanceof DacsVetTerminalBundleTransportError &&
            stopsTerminal(error.reasonCode)
          ? { disposition: "rejected", reason: error.reasonCode }
          : { disposition: "indeterminate", reason: "vet-terminal-proposal-unavailable" };
      }
    },
    async publishProposal(
      input: Parameters<TerminalBundleTransport["publishProposal"]>[0],
    ) {
      await assertNoPlanConflict(context, input.identity.jobId);
      const plan = capturePlan(input.plan);
      assertPlanParties(context, plan);
      if (!identityMatchesPlan(input.identity, plan)) {
        throw new DacsVetTerminalBundleTransportError("vet-terminal-proposal-identity-mismatch");
      }
      const material = await loadBinding(context, "material", input.identity.jobId);
      if (material === undefined) {
        throw new DacsVetTerminalBundleTransportError("vet-terminal-material-unavailable");
      }
      const assessment = await assessProposal(material.payload, true);
      if (assessment.disposition !== "authorized") {
        throw new DacsVetTerminalBundleTransportError(assessment.reasonCode);
      }
      if (!canonicalEqual(assessment.proposal.plan, plan)) {
        throw new DacsVetTerminalBundleTransportError("vet-terminal-proposal-conflict");
      }
      const message = role === "buyer"
        ? await invokeConflictFenced(context, input.identity.jobId, () =>
            context.sendMessage({
              type: "terminal-bundle-proposal-buyer",
              jobId: input.identity.jobId,
              payload: assessment.proposal,
              idempotencyKey: `vet-terminal-proposal:v1:${plan.planHash}`,
            } satisfies DacsLiveRoleSendInputV1<"terminal-bundle-proposal-buyer">))
        : await invokeConflictFenced(context, input.identity.jobId, () =>
            context.sendMessage({
              type: "terminal-bundle-proposal-seller",
              jobId: input.identity.jobId,
              payload: assessment.proposal,
              idempotencyKey: `vet-terminal-proposal:v1:${plan.planHash}`,
            } satisfies DacsLiveRoleSendInputV1<"terminal-bundle-proposal-seller">));
      const disposition = acknowledgementDisposition(message);
      if (disposition !== "accepted" && disposition !== "existing") {
        throw new DacsVetTerminalBundleTransportError("vet-terminal-proposal-rejected");
      }
      await putBinding(context, "proposal", input.identity.jobId, assessment.proposal);
    },
    async resolveContribution(
      input: Parameters<TerminalBundleTransport["resolveContribution"]>[0],
    ): Promise<TerminalBundleResolution<unknown>> {
      try {
        await assertNoPlanConflict(context, input.identity.jobId);
        const proposal = await loadBinding(context, "proposal", input.identity.jobId);
        if (proposal === undefined) {
          return { disposition: "indeterminate", reason: "vet-terminal-proposal-pending" };
        }
        const assessment = await assessProposal(proposal.payload);
        if (assessment.disposition === "rejected") {
          return stopsTerminal(assessment.reasonCode)
            ? { disposition: "rejected", reason: assessment.reasonCode }
            : { disposition: "indeterminate", reason: assessment.reasonCode };
        }
        if (assessment.disposition === "indeterminate") {
          return { disposition: "indeterminate", reason: assessment.reasonCode };
        }
        const plan = assessment.proposal.plan;
        if (!identityMatchesPlan(input.identity, plan) ||
            (input.signerRole !== "buyer" && input.signerRole !== "seller")) {
          return { disposition: "rejected", reason: "vet-terminal-contribution-identity-mismatch" };
        }
        const binding = await loadBinding(
          context,
          "contribution",
          input.identity.jobId,
          input.signerRole,
        );
        return binding === undefined
          ? { disposition: "authoritatively-absent",
              reason: "vet-terminal-contribution-absent" }
          : { disposition: "present", value: captureContribution(plan, binding.payload) };
      } catch (error) {
        return error instanceof DacsVetTerminalBundleTransportError &&
            stopsTerminal(error.reasonCode)
          ? { disposition: "rejected", reason: error.reasonCode }
          : { disposition: "indeterminate",
              reason: "vet-terminal-contribution-unavailable" };
      }
    },
    async publishContribution(
      input: Parameters<TerminalBundleTransport["publishContribution"]>[0],
    ) {
      await assertNoPlanConflict(context, input.identity.jobId);
      const proposal = await loadBinding(context, "proposal", input.identity.jobId);
      if (proposal === undefined) {
        throw new DacsVetTerminalBundleTransportError("vet-terminal-proposal-pending");
      }
      const assessment = await assessProposal(proposal.payload, true);
      if (assessment.disposition !== "authorized") {
        throw new DacsVetTerminalBundleTransportError(assessment.reasonCode);
      }
      const plan = assessment.proposal.plan;
      if (!identityMatchesPlan(input.identity, plan)) {
        throw new DacsVetTerminalBundleTransportError(
          "vet-terminal-contribution-identity-mismatch",
        );
      }
      const contribution = captureContribution(plan, input.contribution);
      if (contribution.signerRole !== role) {
        throw new DacsVetTerminalBundleTransportError(
          "vet-terminal-contribution-role-mismatch",
        );
      }
      const message = role === "buyer"
        ? await invokeConflictFenced(context, input.identity.jobId, () =>
            context.sendMessage({
              type: "terminal-bundle-contribution-buyer",
              jobId: input.identity.jobId,
              payload: contribution,
              idempotencyKey: `vet-terminal-contribution:v1:${contribution.contributionHash}`,
            } satisfies DacsLiveRoleSendInputV1<"terminal-bundle-contribution-buyer">))
        : await invokeConflictFenced(context, input.identity.jobId, () =>
            context.sendMessage({
              type: "terminal-bundle-contribution-seller",
              jobId: input.identity.jobId,
              payload: contribution,
              idempotencyKey: `vet-terminal-contribution:v1:${contribution.contributionHash}`,
            } satisfies DacsLiveRoleSendInputV1<"terminal-bundle-contribution-seller">));
      const disposition = acknowledgementDisposition(message);
      if (disposition !== "accepted" && disposition !== "existing") {
        throw new DacsVetTerminalBundleTransportError("vet-terminal-contribution-rejected");
      }
      await putBinding(context, "contribution", input.identity.jobId, contribution);
    },
  });

  const runtime: DacsVetTerminalBundleTransportRuntimeV1 = {
    transport,
    validatePayload,
    async loadPeerEquivocationEvidence(jobId) {
      const order = await loadOrder(context, jobId);
      const load = (afterCommit: boolean) => {
        const value = context.database.loadEffectInput("session", equivocationId(role, jobId, afterCommit));
        if (value === undefined) return undefined;
        const evidence = captureEquivocation(value);
        if (evidence.localBindingHash !== order.localBindingHash) {
          throw new DacsVetTerminalBundleTransportError("vet-terminal-binding-corrupt");
        }
        return evidence;
      };
      const beforeCommit = load(false);
      const afterCommit = load(true);
      return Object.freeze({
        ...(beforeCommit === undefined ? {} : { beforeCommit }),
        ...(afterCommit === undefined ? {} : { afterCommit }),
      });
    },
    loadPlanDisagreementEvidence: loadDisagreement,
    async registerLocalTerminal(input) {
      let terminalInput = retainedLocalInput(frozenJsonSnapshot(input, "vet-terminal-input") as
        Readonly<PrepareVetTerminalBundleInput>);
      if (terminalInput.complementaryProduction === undefined) {
        const evidence = Object.freeze({ vetEvidenceVersion: "1" as const, terminalInput });
        // Exact bytes survive a crash before the peer answers or a plan is selected.
        let prepared: PreparedVetTerminalBundle;
        try { prepared = await prepareVetTerminalBundle(terminalInput, { authenticateProduction: safeAuthenticator }); }
        catch { throw new DacsVetTerminalBundleTransportError("vet-terminal-input-invalid"); }
        if (prepared.status !== "terminal") throw new DacsVetTerminalBundleTransportError(
          prepared.status === "pass" ? "vet-terminal-production-passed" :
            prepared.status === "invalid" ? "vet-terminal-production-invalid" : "vet-terminal-production-indeterminate");
        await storeEvidence("local-evidence", evidence);
        await sendEvidence(evidence);
        const peer = evidenceAt("peer-evidence", terminalInput.jobId);
        if (peer === undefined) throw new DacsVetTerminalBundleTransportError("vet-terminal-production-indeterminate");
        const authenticated = await captureEvidence(peer, terminalInput.jobId);
        terminalInput = frozenJsonSnapshot({ ...terminalInput,
          complementaryProduction: authenticated.terminalInput.production }, "vet-terminal-input") as PrepareVetTerminalBundleInput;
      }
      assertRetainedEvidence(terminalInput);
      await assertNoPlanConflict(context, terminalInput.jobId);
      let prepared: PreparedVetTerminalBundle;
      try {
        prepared = await prepareVetTerminalBundle(terminalInput, {
          authenticateProduction: safeAuthenticator,
        });
      } catch {
        throw new DacsVetTerminalBundleTransportError("vet-terminal-input-invalid");
      }
      if (prepared.status === "indeterminate") {
        throw new DacsVetTerminalBundleTransportError(
          "vet-terminal-production-indeterminate",
        );
      }
      if (prepared.status !== "terminal") {
        throw new DacsVetTerminalBundleTransportError(
          prepared.status === "pass"
            ? "vet-terminal-production-passed"
            : "vet-terminal-production-invalid",
        );
      }
      const proposal = Object.freeze({
        proposalVersion: "1" as const,
        terminalInput,
        plan: createTerminalBundlePlan(prepared.authority, { kind: "co-signed" }),
      });
      assertPlanParties(context, proposal.plan);
      await assertProposalOrder(proposal, false);
      if ((await loadLocalVetResult(input.jobId))?.status === "passed") {
        throw new DacsVetTerminalBundleTransportError(LOCAL_VET_CONFLICT);
      }
      // Claimed before the plan is selected or bound, so a pass recorded
      // concurrently, in any process, either finds this failure or wins and
      // stops it here.
      await claimLocalVetResult(input.jobId, Object.freeze({
        resultVersion: "1" as const,
        localBindingHash: (await loadOrder(context, input.jobId)).localBindingHash,
        kind: "local-vet-failure" as const,
        planHash: proposal.plan.planHash,
      }));
      const choice = await classifyPlan(proposal, "material", await selectPlan(proposal, "material"));
      if (choice.disposition === "disagreement") {
        await recordDisagreement(input.jobId, choice, proposal);
        throw new DacsVetTerminalBundleTransportError(DACS_VET_TERMINAL_PLAN_DISAGREEMENT);
      }
      if (choice.disposition === "own-conflict") {
        await putPlanConflict(context, input.jobId, proposal.plan.planHash, choice.retainedPlanHash);
        throw new DacsVetTerminalBundleTransportError("vet-terminal-binding-conflict");
      }
      await detectPlanConflict(proposal, true);
      await putBinding(context, "material", input.jobId, proposal);
      return Object.freeze({ prepared, proposal });
    },
    // Needs no order lookup, so a healthy job whose order the terminal cannot
    // project is not blocked here; the pass is checked against the order
    // where a peer's plan is decided.
    async registerLocalVetPass(order, input) {
      if (!plainObject(order) || !exactFields(order, ["jobId", "localBindingHash"]) ||
          typeof order.jobId !== "string" || order.jobId.length === 0 ||
          typeof order.localBindingHash !== "string" || !HASH_RE.test(order.localBindingHash)) {
        throw new DacsVetTerminalBundleTransportError("vet-terminal-job-invalid");
      }
      const { jobId, localBindingHash } = order;
      const selection = context.database.loadEffectInput("session", transportId(role, "selection", jobId));
      if (context.database.loadEffectInput("session", transportId(role, "material", jobId)) !== undefined ||
          context.database.loadEffectInput("session", transportId(role, "disagreement", jobId)) !== undefined ||
          (selection !== undefined && captureSelection(selection).source === "material")) {
        throw new DacsVetTerminalBundleTransportError(LOCAL_VET_CONFLICT);
      }
      // Claim the caller's already authenticated result before any asynchronous work.
      // A crash here leaves no signing authority: the full production must still
      // be retained and independently rechecked before the plan can be co-signed.
      // A failure registered concurrently claims the same row first or finds
      // this pass there.
      await claimLocalVetResult(jobId, Object.freeze({
        resultVersion: "1" as const,
        localBindingHash,
        kind: "local-vet-pass" as const,
        evaluatedRole: peerRole,
      }));
      let evidence: Readonly<DacsVetTerminalEvidenceV1> | undefined;
      if (input !== undefined) {
        const terminalInput = retainedLocalInput(frozenJsonSnapshot(input, "vet-terminal-pass-input") as PrepareVetTerminalBundleInput);
        if (terminalInput.jobId !== jobId || terminalInput.evaluatedRole !== peerRole ||
            terminalInput.complementaryProduction !== undefined) {
          throw new DacsVetTerminalBundleTransportError("vet-terminal-evidence-invalid");
        }
        const prepared = await prepareVetTerminalBundle(terminalInput, { authenticateProduction: safeAuthenticator });
        if (prepared.status !== "pass") throw new DacsVetTerminalBundleTransportError("vet-terminal-production-indeterminate");
        evidence = Object.freeze({ vetEvidenceVersion: "1", terminalInput });
        await storeEvidence("local-evidence", evidence, localBindingHash);
      }
      if (evidence !== undefined) await sendEvidence(evidence);
    },
    async advanceRegisteredTerminal(jobId) {
      if (typeof jobId !== "string" || jobId.length === 0) {
        throw new DacsVetTerminalBundleTransportError("vet-terminal-job-invalid");
      }
      let assessment: Awaited<ReturnType<typeof loadRegistered>>;
      try {
        assessment = await loadRegistered(jobId);
      } catch (error) {
        // Once this role committed the job to the terminal (or contributed its
        // own signature), a gate that now fails is a contradiction for an
        // operator. It must never hand the job to the agreement.
        if (error instanceof DacsVetTerminalBundleTransportError &&
            error.reasonCode === "vet-terminal-not-pre-agreement") {
          const order = await loadOrder(context, jobId);
          if (order.phase === "vet-terminal" ||
              await loadBinding(context, "contribution", jobId, role) !== undefined) {
            throw new DacsVetTerminalBundleTransportError(DACS_PRE_AGREEMENT_PHASE_CONFLICT);
          }
        }
        throw error;
      }
      claimTerminalPhase(context, await loadOrder(context, jobId));
      const loaded = await context.sessionStore.load(jobId);
      if (loaded.status === "missing") {
        await context.sessionStore.create({
          jobId,
          now: context.database.readTime(),
        });
      } else if (loaded.status !== "ok") {
        throw new DacsVetTerminalBundleTransportError(
          "vet-terminal-session-store-unavailable",
        );
      }
      const signerKeys = assessment.proposal.plan.requiredSigners.map((signer) => {
        const publicKey = canonicalDemosAgentPublicKey(signer.primaryClaim);
        if (publicKey === null) {
          throw new DacsVetTerminalBundleTransportError(
            "vet-terminal-signer-key-unavailable",
          );
        }
        return Object.freeze({
          role: signer.role,
          primaryClaim: signer.primaryClaim,
          algorithm: "ed25519" as const,
          publicKey: Uint8Array.from(publicKey),
        });
      });
      return await advanceTerminalBundleDurable({
        authority: assessment.prepared.authority,
        signingMode: { kind: "co-signed" },
        local: {
          role,
          primaryClaim: context.authority,
          signer: async (bytes) => {
            await admitDacsSessionProfile(context, jobId);
            assertRetainedEvidence(assessment.proposal.terminalInput);
            return await invokeConflictFenced(context, jobId, () => context.demos.signComponent(
              Uint8Array.from(bytes), { algorithm: "ed25519", signer: context.authority }));
          },
        },
        signerKeys,
      }, terminalProvider(assessment.proposal), {
        store: context.sessionStore,
        workerId: `dacs-node-vet-terminal-${role}`,
        leaseTtlMs: 120_000,
        leaseNowMs: () => context.database.readTime(),
        transport,
        reconcileSignature: () => Object.freeze({
          disposition: "authoritatively-absent" as const,
          reason: "vet-terminal-deterministic-signature-absent",
        }),
      });
    },
    async handleMessage(
      authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
      inboundContext: Readonly<DacsLiveRoleInboundOperationContextV1>,
    ) {
      const envelope = authenticated.envelope;
      if (envelope.type === "acknowledgement" || inboundContext.role !== role ||
          (envelope.type !== `terminal-bundle-proposal-${peerRole}` &&
            envelope.type !== `terminal-bundle-contribution-${peerRole}`)) {
        return rejected("vet-terminal-message-role-incompatible");
      }
      const validation = await validatePayload({
        type: envelope.type as Exclude<typeof envelope.type, "acknowledgement">,
        payload: envelope.payload,
        jobId: envelope.jobId,
        sender: envelope.sender,
        audience: envelope.audience,
      });
      if (validation.status === "authentication-failure" || validation.status === "unavailable") {
        throw new DacsVetTerminalBundleTransportError(validation.reasonCode);
      }
      if (validation.status !== "valid") return rejected(validation.reasonCode);
      try {
        if (envelope.type === `terminal-bundle-proposal-${peerRole}`) {
          if (plainObject(envelope.payload) && "vetEvidenceVersion" in envelope.payload && envelope.payload.vetEvidenceVersion === "1") {
            const evidence = await captureEvidence(envelope.payload, envelope.jobId);
            await storeEvidence("peer-evidence", evidence);
            return Object.freeze({ disposition: "accepted" as const });
          }
          const assessment = await assessProposal(envelope.payload, "peer");
          if (assessment.disposition === "indeterminate") {
            throw new DacsVetTerminalBundleTransportError(assessment.reasonCode);
          }
          const authentication = {
            authenticationHash: authenticated.authenticationHash,
            identityEvidenceHash: authenticated.identityEvidenceHash,
          };
          if (assessment.disposition === "rejected") {
            // A second authentic plan from the peer is refused and kept as
            // evidence. The job continues with the retained plan: this role
            // only ever signs that plan, so nothing contradictory can be signed.
            if (assessment.equivocation !== undefined) {
              await recordEquivocation(envelope.jobId, assessment.equivocation,
                envelope.payload, authenticated);
            }
            // The peer's first plan against this role's own Vet failure: both
            // roles stop for an operator, and the peer's plan is kept.
            if (assessment.disagreement !== undefined && assessment.proposal !== undefined) {
              await recordDisagreement(envelope.jobId, assessment.disagreement,
                assessment.proposal, authentication);
            }
            return rejected(assessment.reasonCode);
          }
          // The same choice again on the one selection row: a local Vet
          // failure registered meanwhile, in any process, may have won it.
          const choice = await classifyPlan(assessment.proposal, "peer",
            await selectPlan(assessment.proposal, "peer", authentication));
          if (choice.disposition === "equivocation") {
            await recordEquivocation(envelope.jobId, choice, envelope.payload, authenticated);
            return rejected("vet-terminal-proposal-equivocation");
          }
          if (choice.disposition === "disagreement") {
            await recordDisagreement(envelope.jobId, choice, assessment.proposal, authentication);
            return rejected(DACS_VET_TERMINAL_PLAN_DISAGREEMENT);
          }
          // This role's own failure of another plan was claimed before that
          // plan was selected, so the peer's plan won the selection: that is
          // the disagreement, which the resumed local failure records.
          const local = await loadLocalVetResult(envelope.jobId);
          if (local?.status === "failed" && local.planHash !== assessment.proposal.plan.planHash) {
            return rejected(DACS_VET_TERMINAL_PLAN_DISAGREEMENT);
          }
          // The peer signs its plan only after this acceptance. Until this
          // role's own Vet result agrees with the plan, it stays selected and
          // the message stays pending in the inbox, to be decided again.
          await assertLocalVetAgrees(assessment.proposal);
          await putBinding(context, "proposal", envelope.jobId, assessment.proposal, authentication);
          return Object.freeze({ disposition: "accepted" as const });
        }
        const proposal = await loadBinding(context, "proposal", envelope.jobId);
        if (proposal === undefined) {
          throw new DacsVetTerminalBundleTransportError("vet-terminal-proposal-pending");
        }
        const assessment = await assessProposal(proposal.payload);
        if (assessment.disposition !== "authorized") {
          throw new DacsVetTerminalBundleTransportError(assessment.reasonCode);
        }
        const contribution = captureContribution(
          assessment.proposal.plan,
          envelope.payload,
        );
        await putBinding(context, "contribution", envelope.jobId, contribution, {
          authenticationHash: authenticated.authenticationHash,
          identityEvidenceHash: authenticated.identityEvidenceHash,
        });
        return Object.freeze({ disposition: "accepted" as const });
      } catch (error) {
        if (error instanceof DacsVetTerminalBundleTransportError &&
            (error.reasonCode.endsWith("-conflict") ||
              error.reasonCode === DACS_VET_TERMINAL_PLAN_DISAGREEMENT)) {
          return rejected(error.reasonCode);
        }
        throw error;
      }
    },
  };
  const guard = <T extends (...args: any[]) => any>(action: T, job: (...args: Parameters<T>) => string): T =>
    (async (...args: Parameters<T>) => {
      await admitDacsSessionProfile(context, job(...args));
      return action(...args);
    }) as T;
  const guardedTransport = Object.freeze(Object.fromEntries(Object.entries(runtime.transport).map(([name, action]) =>
    [name, guard(action as (...args: any[]) => any, (input: { jobId?: string; identity?: { jobId: string } }) =>
      input.identity?.jobId ?? input.jobId!)])) as unknown as TerminalBundleTransport);
  return Object.freeze({
    ...Object.fromEntries(Object.entries(runtime).filter(([, action]) => typeof action === "function")
      .map(([name, action]) => [name,
        name === "loadPeerEquivocationEvidence" || name === "loadPlanDisagreementEvidence"
          ? action : guard(action, (input: any) =>
            typeof input === "string" ? input : input.envelope?.jobId ?? input.jobId)])),
    transport: guardedTransport,
    validatePayload: async (input: Parameters<typeof runtime.validatePayload>[0]) => {
      try { await admitDacsSessionProfile(context, input.jobId); }
      catch (error) {
        const category = faultCategory(error);
        if (category === "substrate" || category === "transient") {
          return { status: "unavailable" as const, reasonCode: "session-profile-admission-unavailable" };
        }
        throw error;
      }
      return runtime.validatePayload(input);
    },
  }) as unknown as Readonly<DacsVetTerminalBundleTransportRuntimeV1>;
}
