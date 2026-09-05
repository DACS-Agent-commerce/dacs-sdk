import { types as nodeTypes } from "node:util";

import {
  advanceTerminalBundleDurable,
  attestationBundleHash,
  createTerminalBundlePlan,
  createTerminalBundleSignatureContribution,
  prepareVetTerminalBundle,
  terminalBundleSignedBytes,
  type PrepareVetTerminalBundleDeps,
  type PrepareVetTerminalBundleInput,
  type PreparedVetTerminalBundle,
  type DurableTerminalBundleProgress,
  type DurableTerminalBundleProvider,
  type TerminalBundleAnchorPublication,
  type TerminalBundlePlan,
  type TerminalBundleResolution,
  type TerminalBundleSignatureContribution,
  type TerminalBundleTransport,
  type TerminalBundleTransportIdentity,
} from "@kynesyslabs/dacs";
import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import { ed25519Verify, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";
import { canonicalDemosAgentPublicKey, sameCanonicalClaimIdentity } from
  "@kynesyslabs/dacs/identity";

import { createDacsDemosBundlePublicationV1 } from "./demosBundlePublication.js";
import type {
  DacsLiveRoleInboundOperationContextV1,
  DacsLiveRoleOperationContextV1,
} from "./roleRuntime.js";
import type { DacsLiveRoleSendInputV1 } from "./service.js";
import type {
  DacsHttpAuthenticatedEnvelopeV1,
  DacsHttpPayloadValidationV1,
  DacsHttpPayloadValidatorV1,
  DacsVetTerminalBundleProposalV1,
} from "./transport/envelope.js";
import type { DacsHttpInboundDispositionV1 } from "./transport/http.js";

const BINDING_VERSION = "1" as const;
const TRANSPORT_ID_DOMAIN = "dacs-live-vet-terminal-transport:v1:" as const;
const HASH_RE = /^[0-9a-f]{64}$/;

type Role = "buyer" | "seller";
type BindingKind = "material" | "proposal" | "contribution";

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

export interface DacsVetTerminalBundleTransportOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
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
  handleMessage(
    authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
    context: Readonly<DacsLiveRoleInboundOperationContextV1>,
  ): Promise<DacsHttpInboundDispositionV1>;
}

export class DacsVetTerminalBundleTransportError extends Error {
  override readonly name = "DacsVetTerminalBundleTransportError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
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
  paymentPhase: "pay-x402" | "pay-dem";
}>> {
  const [x402, payDem] = await Promise.all([
    context.database.createLiveCoordinatorStore(context.role).load(context.role, jobId),
    context.database.createPayDemCoordinatorStore(context.role).load(context.role, jobId),
  ]);
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
  return Object.freeze({
    jobId: record.jobId,
    buyer: record.buyer,
    seller: record.seller,
    localBindingHash: record.localBindingHash,
    paymentPhase: record.protocol.phase,
  });
}

function transportId(
  role: Role,
  kind: BindingKind,
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
  | Readonly<{ disposition: "rejected"; reasonCode: string }>
  | Readonly<{ disposition: "indeterminate"; reasonCode: string }>;

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
      !exactFields(options, ["context", "authenticateProduction"]) ||
      (options.context.role !== "buyer" && options.context.role !== "seller") ||
      typeof options.authenticateProduction !== "function") {
    throw new TypeError("Vet terminal bundle transport options are invalid");
  }
  const context = options.context;
  const role = context.role;
  const peerRole = otherRole(role);
  const authenticateProduction = options.authenticateProduction;

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
          exactFields(value, ["status"])) {
        return Object.freeze({ status: "valid" as const });
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
  ): Promise<void> => {
    const order = await loadOrder(context, proposal.terminalInput.jobId);
    const paymentSteps = proposal.terminalInput.pipeline.filter((step) =>
      step.kind === "pay-x402" || step.kind === "pay-dem");
    if (paymentSteps.length !== 1 || paymentSteps[0]?.kind !== order.paymentPhase) {
      throw new DacsVetTerminalBundleTransportError(
        "vet-terminal-proposal-rail-mismatch",
      );
    }
  };

  const assessProposal = async (value: unknown): Promise<ProposalAssessment> => {
    let proposal: Readonly<DacsVetTerminalBundleProposalV1>;
    let prepared: PreparedVetTerminalBundle;
    try {
      proposal = captureProposal(value);
      prepared = await prepareVetTerminalBundle(proposal.terminalInput, {
        authenticateProduction: safeAuthenticator,
      });
    } catch {
      return Object.freeze({
        disposition: "rejected" as const,
        reasonCode: "vet-terminal-proposal-invalid",
      });
    }
    if (prepared.status === "indeterminate" || prepared.status === "retry") {
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
      await assertProposalOrder(proposal);
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

  const loadRegistered = async (
    jobId: string,
  ): Promise<Extract<ProposalAssessment, { disposition: "authorized" }>> => {
    const binding = await loadBinding(context, "material", jobId) ??
      await loadBinding(context, "proposal", jobId);
    if (binding === undefined) {
      throw new DacsVetTerminalBundleTransportError("vet-terminal-material-unavailable");
    }
    const assessment = await assessProposal(binding.payload);
    if (assessment.disposition !== "authorized") {
      throw new DacsVetTerminalBundleTransportError(assessment.reasonCode);
    }
    return assessment;
  };

  const terminalProvider = (
    proposal: Readonly<DacsVetTerminalBundleProposalV1>,
  ): Readonly<DurableTerminalBundleProvider> => {
    const buyer = proposal.plan.authority.parties.find((party) => party.role === "buyer");
    const seller = proposal.plan.authority.parties.find((party) => party.role === "seller");
    if (buyer === undefined || seller === undefined) {
      throw new DacsVetTerminalBundleTransportError("vet-terminal-plan-party-mismatch");
    }
    const publication = createDacsDemosBundlePublicationV1({
      context,
      jobId: proposal.plan.authority.jobId,
      buyer: buyer.primaryClaim,
      seller: seller.primaryClaim,
    });
    const verify = (
      result: "valid" | "invalid" | "indeterminate" | "error",
      invalidReason: string,
      indeterminateReason: string,
    ) => result === "valid"
      ? Object.freeze({ disposition: "valid" as const })
      : result === "invalid"
        ? Object.freeze({ disposition: "invalid" as const, reason: invalidReason })
        : Object.freeze({
            disposition: "indeterminate" as const,
            reason: indeterminateReason,
          });
    const provider: DurableTerminalBundleProvider = {
      async resolveOwnBundle(input) {
        if (input.role !== role) {
          return { disposition: "rejected" as const,
            reason: "vet-terminal-bundle-role-mismatch" };
        }
        try {
          const anchored = await publication.resolveRoleBundle(role);
          if (anchored === null) {
            return { disposition: "authoritatively-absent" as const,
              reason: "vet-terminal-bundle-absent" };
          }
          if (anchored.anchorReceipt.state !== "finalized") {
            return { disposition: "indeterminate" as const,
              reason: "vet-terminal-bundle-finality-pending" };
          }
          const bundleContentHash = attestationBundleHash(anchored.bundle);
          if (anchored.anchorReceipt.logicalAddress !== input.logicalAddress ||
              bundleContentHash !== input.bundleContentHash) {
            return { disposition: "rejected" as const,
              reason: "vet-terminal-bundle-conflict" };
          }
          const value: TerminalBundleAnchorPublication = {
            role,
            logicalAddress: input.logicalAddress,
            nativeAddress: anchored.nativeAddress,
            bundleContentHash,
            bundle: anchored.bundle,
            anchorReceipt: anchored.anchorReceipt,
            ...(anchored.anchorTx === undefined ? {} : { anchorTx: anchored.anchorTx }),
          };
          return { disposition: "present" as const, value: Object.freeze(value) };
        } catch {
          return { disposition: "indeterminate" as const,
            reason: "vet-terminal-bundle-resolution-unavailable" };
        }
      },
      async submitOwnBundle(input) {
        if (input.role !== role) {
          throw new DacsVetTerminalBundleTransportError(
            "vet-terminal-bundle-role-mismatch",
          );
        }
        await publication.submitRoleBundle(role, input.logicalAddress, input.bundle);
      },
      async verifyOwnBundlePublication(input) {
        if (input.role !== role) {
          return { disposition: "invalid" as const,
            reason: "vet-terminal-bundle-role-mismatch" };
        }
        return verify(
          await publication.verifyBundleAnchorReceipt({
            bundle: input.bundle,
            nativeAddress: input.nativeAddress,
            anchorReceipt: input.anchorReceipt,
            ...(input.anchorTx === undefined ? {} : { anchorTx: input.anchorTx }),
          }),
          "vet-terminal-bundle-publication-invalid",
          "vet-terminal-bundle-publication-indeterminate",
        );
      },
      async resolveOwnBundleBinding(input) {
        if (input.role !== role) {
          return { disposition: "rejected" as const,
            reason: "vet-terminal-binding-role-mismatch" };
        }
        const resolved = await publication.resolveBundleBinding(
          input.logicalAddress,
          input.signer,
        );
        return resolved.disposition === "present"
          ? { disposition: "present" as const, value: resolved.binding }
          : resolved.disposition === "absent"
            ? { disposition: "authoritatively-absent" as const,
                reason: "vet-terminal-binding-absent" }
            : resolved;
      },
      async publishOwnBundleBinding(binding) {
        const result = await publication.publishRoleBundleBinding(role, binding);
        if (result.disposition !== "published") {
          throw new DacsVetTerminalBundleTransportError(result.reason);
        }
      },
      async verifyOwnBundleBinding(binding) {
        return verify(
          await publication.verifyBundleBinding(binding),
          "vet-terminal-binding-invalid",
          "vet-terminal-binding-indeterminate",
        );
      },
    };
    return Object.freeze(provider);
  };

  const validatePayload: DacsHttpPayloadValidatorV1 = async (input) => {
    const proposalType = `terminal-bundle-proposal-${peerRole}`;
    const contributionType = `terminal-bundle-contribution-${peerRole}`;
    if (input.sender !== context.peerAuthority || input.audience !== context.authority ||
        (input.type !== proposalType && input.type !== contributionType)) {
      return payloadValidation(false, "vet-terminal-message-role-incompatible");
    }
    try {
      if (input.type === proposalType) {
        await loadOrder(context, input.jobId);
        const assessment = await assessProposal(input.payload);
        if (assessment.disposition === "indeterminate") {
          return Object.freeze({
            status: "authentication-failure" as const,
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
          status: "authentication-failure" as const,
          reasonCode: "vet-terminal-proposal-pending",
        });
      }
      const assessment = await assessProposal(proposal.payload);
      if (assessment.disposition !== "authorized") {
        return Object.freeze({
          status: "authentication-failure" as const,
          reasonCode: assessment.reasonCode,
        });
      }
      const contribution = captureContribution(assessment.proposal.plan, input.payload);
      return payloadValidation(
        contribution.signerRole === peerRole,
        "vet-terminal-contribution-invalid",
      );
    } catch (error) {
      return payloadValidation(false, error instanceof DacsVetTerminalBundleTransportError
        ? error.reasonCode : "vet-terminal-message-invalid");
    }
  };

  const transport: TerminalBundleTransport = Object.freeze({
    async resolveProposal(
      identity: Readonly<TerminalBundleTransportIdentity>,
    ): Promise<TerminalBundleResolution<unknown>> {
      try {
        const binding = await loadBinding(context, "proposal", identity.jobId);
        if (binding === undefined) {
          return { disposition: "authoritatively-absent",
            reason: "vet-terminal-proposal-absent" };
        }
        const assessment = await assessProposal(binding.payload);
        if (assessment.disposition !== "authorized") {
          return { disposition: "indeterminate", reason: assessment.reasonCode };
        }
        return identityMatchesPlan(identity, assessment.proposal.plan)
          ? { disposition: "present", value: assessment.proposal.plan }
          : { disposition: "rejected", reason: "vet-terminal-proposal-conflict" };
      } catch {
        return { disposition: "indeterminate", reason: "vet-terminal-proposal-unavailable" };
      }
    },
    async publishProposal(
      input: Parameters<TerminalBundleTransport["publishProposal"]>[0],
    ) {
      const plan = capturePlan(input.plan);
      assertPlanParties(context, plan);
      if (!identityMatchesPlan(input.identity, plan)) {
        throw new DacsVetTerminalBundleTransportError("vet-terminal-proposal-identity-mismatch");
      }
      const material = await loadBinding(context, "material", input.identity.jobId);
      if (material === undefined) {
        throw new DacsVetTerminalBundleTransportError("vet-terminal-material-unavailable");
      }
      const assessment = await assessProposal(material.payload);
      if (assessment.disposition !== "authorized") {
        throw new DacsVetTerminalBundleTransportError(assessment.reasonCode);
      }
      if (!canonicalEqual(assessment.proposal.plan, plan)) {
        throw new DacsVetTerminalBundleTransportError("vet-terminal-proposal-conflict");
      }
      const message = role === "buyer"
        ? await context.sendMessage({
            type: "terminal-bundle-proposal-buyer",
            jobId: input.identity.jobId,
            payload: assessment.proposal,
            idempotencyKey: `vet-terminal-proposal:v1:${plan.planHash}`,
          } satisfies DacsLiveRoleSendInputV1<"terminal-bundle-proposal-buyer">)
        : await context.sendMessage({
            type: "terminal-bundle-proposal-seller",
            jobId: input.identity.jobId,
            payload: assessment.proposal,
            idempotencyKey: `vet-terminal-proposal:v1:${plan.planHash}`,
          } satisfies DacsLiveRoleSendInputV1<"terminal-bundle-proposal-seller">);
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
        const proposal = await loadBinding(context, "proposal", input.identity.jobId);
        if (proposal === undefined) {
          return { disposition: "indeterminate", reason: "vet-terminal-proposal-pending" };
        }
        const assessment = await assessProposal(proposal.payload);
        if (assessment.disposition !== "authorized") {
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
      } catch {
        return { disposition: "indeterminate",
          reason: "vet-terminal-contribution-unavailable" };
      }
    },
    async publishContribution(
      input: Parameters<TerminalBundleTransport["publishContribution"]>[0],
    ) {
      const proposal = await loadBinding(context, "proposal", input.identity.jobId);
      if (proposal === undefined) {
        throw new DacsVetTerminalBundleTransportError("vet-terminal-proposal-pending");
      }
      const assessment = await assessProposal(proposal.payload);
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
        ? await context.sendMessage({
            type: "terminal-bundle-contribution-buyer",
            jobId: input.identity.jobId,
            payload: contribution,
            idempotencyKey: `vet-terminal-contribution:v1:${contribution.contributionHash}`,
          } satisfies DacsLiveRoleSendInputV1<"terminal-bundle-contribution-buyer">)
        : await context.sendMessage({
            type: "terminal-bundle-contribution-seller",
            jobId: input.identity.jobId,
            payload: contribution,
            idempotencyKey: `vet-terminal-contribution:v1:${contribution.contributionHash}`,
          } satisfies DacsLiveRoleSendInputV1<"terminal-bundle-contribution-seller">);
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
    async registerLocalTerminal(input) {
      const terminalInput = frozenJsonSnapshot(input, "vet-terminal-input") as
        Readonly<PrepareVetTerminalBundleInput>;
      let prepared: PreparedVetTerminalBundle;
      try {
        prepared = await prepareVetTerminalBundle(terminalInput, {
          authenticateProduction: safeAuthenticator,
        });
      } catch {
        throw new DacsVetTerminalBundleTransportError("vet-terminal-input-invalid");
      }
      if (prepared.status === "indeterminate" || prepared.status === "retry") {
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
      await assertProposalOrder(proposal);
      await putBinding(context, "material", input.jobId, proposal);
      return Object.freeze({ prepared, proposal });
    },
    async advanceRegisteredTerminal(jobId) {
      if (typeof jobId !== "string" || jobId.length === 0) {
        throw new DacsVetTerminalBundleTransportError("vet-terminal-job-invalid");
      }
      const assessment = await loadRegistered(jobId);
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
          signer: async (bytes) => await context.demos.signComponent(
            Uint8Array.from(bytes),
            { algorithm: "ed25519", signer: context.authority },
          ),
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
      if (validation.status === "authentication-failure") {
        throw new DacsVetTerminalBundleTransportError(validation.reasonCode);
      }
      if (validation.status !== "valid") return rejected(validation.reasonCode);
      try {
        if (envelope.type === `terminal-bundle-proposal-${peerRole}`) {
          const assessment = await assessProposal(envelope.payload);
          if (assessment.disposition === "indeterminate") {
            throw new DacsVetTerminalBundleTransportError(assessment.reasonCode);
          }
          if (assessment.disposition === "rejected") {
            return rejected(assessment.reasonCode);
          }
          await putBinding(context, "proposal", envelope.jobId, assessment.proposal, {
            authenticationHash: authenticated.authenticationHash,
            identityEvidenceHash: authenticated.identityEvidenceHash,
          });
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
            error.reasonCode.endsWith("-conflict")) {
          return rejected(error.reasonCode);
        }
        throw error;
      }
    },
  };
  return Object.freeze(runtime);
}
