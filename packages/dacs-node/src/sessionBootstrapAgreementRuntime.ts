import { randomBytes } from "node:crypto";

import {
  isBundleRequirement,
  isCompositeVerificationRecord,
  isIdentityBundle,
  isReadableAnchorReceipt,
  type AttestationRef,
  type BundleRequirement,
  type CompositeVerificationRecord,
  type IdentityBundle,
} from "@kynesyslabs/dacs/artifacts";
import { canonicalize, contentHash, sha256Hex } from "@kynesyslabs/dacs/canonical";
import type {
  FixedPricePayDemOrderInput,
  FixedPricePayDemOrderRecord,
  FixedPricePayDemTrackOperation,
  FixedPricePayDemTrackOperationInput,
  FixedPriceX402OrderRecord,
  FixedPriceX402TrackOperation,
  FixedPriceX402TrackOperationInput,
  FixedPriceX402TrackOperationResult,
} from "@kynesyslabs/dacs/commerce";
import type {
  PrepareVetTerminalBundleInput,
} from "@kynesyslabs/dacs";
import { identityBundleHash, sameCanonicalClaimIdentity } from "@kynesyslabs/dacs/identity";
import type { ProtocolAnchorReceipt } from "@kynesyslabs/dacs";

import {
  loadDacsLiveOrderInputForTrackV1,
  type DacsLiveOrderInputV1,
} from "./orderInput.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";
import {
  authenticateDacsSessionVetProductionV1,
  createDacsLiveSessionIdentityV1,
  produceDacsEmptyRequirementSessionVetV1,
  type DacsSessionVetProductionOutcomeV1,
  type DacsSessionVetProductionV1,
  type DacsSessionVetRuntimeV1,
} from "./sessionIdentityVetRuntime.js";
import type {
  DacsBuyerSessionBootstrapTransportRuntimeV1,
  DacsSellerSessionBootstrapTransportRuntimeV1,
} from "./sessionBootstrapTransportRuntime.js";
import { dacsHttpPayloadHashV1 } from "./transport/envelope.js";
import {
  DacsVetTerminalBundleTransportError,
  type DacsVetTerminalBundleTransportRuntimeV1,
} from "./terminalBundleTransportRuntime.js";

const FACTS_VERSION = "1" as const;
const FACTS_DOMAIN = "dacs-live-session-agreement-facts:v1:" as const;
const VET_INVOCATION_VERSION = "1" as const;
const VET_INVOCATION_DOMAIN = "dacs-live-session-vet-invocation:v1:" as const;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const HASH_RE = /^[0-9a-f]{64}$/;

interface DacsSessionVetInvocationV1 {
  invocationVersion: typeof VET_INVOCATION_VERSION;
  localBindingHash: string;
  evaluatedRole: "buyer" | "seller";
  evaluatedParty: string;
  invokedAt: number;
}

interface CommonFactsV1 {
  factsVersion: typeof FACTS_VERSION;
  role: "buyer" | "seller";
  jobId: string;
  localBindingHash: string;
  buyerIdentity: Readonly<IdentityBundle>;
  sellerIdentity: Readonly<IdentityBundle>;
  buyerRequirementHash: string;
  buyerVetRecord: Readonly<CompositeVerificationRecord>;
  buyerVetRef: Readonly<AttestationRef>;
  buyerVetReceipt: Readonly<ProtocolAnchorReceipt>;
}

export interface DacsBuyerSessionAgreementFactsV1 extends CommonFactsV1 {
  role: "buyer";
  sellerRequirementHash: string;
  sellerVetRecord: Readonly<CompositeVerificationRecord>;
  sellerVetRef: Readonly<AttestationRef>;
  sellerVetReceipt: Readonly<ProtocolAnchorReceipt>;
}

export interface DacsSellerSessionAgreementFactsV1 extends CommonFactsV1 {
  role: "seller";
}

export interface DacsSessionBootstrapRequirementsV1 {
  buyer: Readonly<BundleRequirement>;
  seller: Readonly<BundleRequirement>;
}

export interface DacsSessionVetTerminalTrackV1 {
  runtime: Readonly<DacsVetTerminalBundleTransportRuntimeV1>;
  createInput(input: Readonly<{
    operation: Readonly<
      FixedPriceX402TrackOperationInput | FixedPricePayDemTrackOperationInput
    >;
    retained: Readonly<DacsLiveOrderInputV1>;
    buyerIdentity: Readonly<IdentityBundle>;
    sellerIdentity: Readonly<IdentityBundle>;
    evaluatedRole: "buyer" | "seller";
    production: Readonly<DacsSessionVetProductionV1>;
    vetInvokedAt: number;
  }>): Readonly<PrepareVetTerminalBundleInput>;
}

interface CommonOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  agreement: FixedPriceX402TrackOperation;
  retryDelayMs?: number;
  /**
   * Optional non-empty DACS-2 producer/authenticator. When absent, the narrow
   * built-in empty-requirement producer remains the only admitted Vet path.
   */
  vet?: Readonly<DacsSessionVetRuntimeV1>;
  /**
   * Optional DACS-5 failure finalizer. The factory supplies the exact
   * Listing/pipeline/registry projection while this track owns durable phase
   * invocation and coordinator termination.
   */
  terminalBundle?: Readonly<DacsSessionVetTerminalTrackV1>;
}

export interface DacsBuyerSessionBootstrapAgreementTrackOptionsV1
  extends CommonOptionsV1 {
  sessionBootstrap: Readonly<DacsBuyerSessionBootstrapTransportRuntimeV1>;
  resolveRequirements(input: Readonly<{
    operation: Readonly<FixedPriceX402TrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1>;
  }>): Promise<Readonly<DacsSessionBootstrapRequirementsV1>> |
    Readonly<DacsSessionBootstrapRequirementsV1>;
}

export interface DacsSellerSessionBootstrapAgreementTrackOptionsV1
  extends CommonOptionsV1 {
  sessionBootstrap: Readonly<DacsSellerSessionBootstrapTransportRuntimeV1>;
  resolveBuyerRequirement(input: Readonly<{
    operation: Readonly<FixedPriceX402TrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1>;
  }>): Promise<Readonly<BundleRequirement>> | Readonly<BundleRequirement>;
  agreementProposalReady(input: Readonly<{
    operation: Readonly<FixedPriceX402TrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1>;
  }>): Promise<boolean> | boolean;
}

export interface DacsPayDemBuyerSessionBootstrapAgreementTrackOptionsV1
  extends Omit<DacsBuyerSessionBootstrapAgreementTrackOptionsV1,
    "agreement" | "resolveRequirements"> {
  agreement: FixedPricePayDemTrackOperation;
  resolveRequirements(input: Readonly<{
    operation: Readonly<FixedPricePayDemTrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1<FixedPricePayDemOrderInput>>;
  }>): Promise<Readonly<DacsSessionBootstrapRequirementsV1>> |
    Readonly<DacsSessionBootstrapRequirementsV1>;
}

export interface DacsPayDemSellerSessionBootstrapAgreementTrackOptionsV1
  extends Omit<DacsSellerSessionBootstrapAgreementTrackOptionsV1,
    "agreement" | "resolveBuyerRequirement" | "agreementProposalReady"> {
  agreement: FixedPricePayDemTrackOperation;
  resolveBuyerRequirement(input: Readonly<{
    operation: Readonly<FixedPricePayDemTrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1<FixedPricePayDemOrderInput>>;
  }>): Promise<Readonly<BundleRequirement>> | Readonly<BundleRequirement>;
  agreementProposalReady(input: Readonly<{
    operation: Readonly<FixedPricePayDemTrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1<FixedPricePayDemOrderInput>>;
  }>): Promise<boolean> | boolean;
}

export class DacsSessionBootstrapAgreementRuntimeError extends Error {
  override readonly name = "DacsSessionBootstrapAgreementRuntimeError";

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

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function retryDelay(value: unknown): number {
  const captured = value ?? DEFAULT_RETRY_DELAY_MS;
  if (typeof captured !== "number" || !Number.isSafeInteger(captured) ||
      captured <= 0 || captured > 60_000) {
    throw new TypeError("session bootstrap retry delay is invalid");
  }
  return captured;
}

function retryAt(context: Readonly<DacsLiveRoleOperationContextV1>, delay: number): number {
  const value = context.database.readTime() + delay;
  if (!Number.isSafeInteger(value)) {
    throw new DacsSessionBootstrapAgreementRuntimeError("session-bootstrap-retry-overflow");
  }
  return value;
}

function pending(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  delay: number,
  reasonCode: string,
  status: "pending-retry" | "indeterminate" = "pending-retry",
): Readonly<FixedPriceX402TrackOperationResult> {
  return Object.freeze({ status, reasonCode, retryAt: retryAt(context, delay) });
}

function operator(reasonCode: string): Readonly<FixedPriceX402TrackOperationResult> {
  return Object.freeze({ status: "operator-action", reasonCode });
}

function operationBound(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  operation: Readonly<FixedPriceX402TrackOperationInput>,
): boolean {
  return operation.fence.role === context.role && operation.fence.track === "agreement" &&
    operation.order.role === context.role && operation.order.jobId === operation.fence.jobId &&
    operation.order.localBindingHash === operation.fence.localBindingHash &&
    operation.order.bindingHash === operation.fence.bindingHash;
}

function sessionVetRuntime(
  value: Readonly<DacsSessionVetRuntimeV1> | undefined,
): Readonly<DacsSessionVetRuntimeV1> {
  if (value === undefined) {
    return Object.freeze({
      produce: produceDacsEmptyRequirementSessionVetV1,
      authenticate: authenticateDacsSessionVetProductionV1,
    });
  }
  if (!plainObject(value) || typeof value.produce !== "function" ||
      typeof value.authenticate !== "function") {
    throw new TypeError("session Vet runtime is invalid");
  }
  return value;
}

function invocationId(
  role: "buyer" | "seller",
  jobId: string,
  evaluatedRole: "buyer" | "seller",
): string {
  return sha256Hex(`${VET_INVOCATION_DOMAIN}${canonicalize({
    role,
    jobId,
    evaluatedRole,
  })}`);
}

function captureVetInvocation(value: unknown): Readonly<DacsSessionVetInvocationV1> {
  if (!plainObject(value) || !exactKeys(value, [
    "invocationVersion", "localBindingHash", "evaluatedRole", "evaluatedParty",
    "invokedAt",
  ]) || value.invocationVersion !== VET_INVOCATION_VERSION ||
      typeof value.localBindingHash !== "string" || !HASH_RE.test(value.localBindingHash) ||
      (value.evaluatedRole !== "buyer" && value.evaluatedRole !== "seller") ||
      typeof value.evaluatedParty !== "string" || value.evaluatedParty.length === 0 ||
      typeof value.invokedAt !== "number" || !Number.isSafeInteger(value.invokedAt) ||
      value.invokedAt < 0) {
    throw new DacsSessionBootstrapAgreementRuntimeError("session-vet-invocation-corrupt");
  }
  return value as unknown as Readonly<DacsSessionVetInvocationV1>;
}

function retainVetInvocation(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  operation: Readonly<
    FixedPriceX402TrackOperationInput | FixedPricePayDemTrackOperationInput
  >,
  evaluatedRole: "buyer" | "seller",
  evaluatedParty: string,
): number {
  const id = invocationId(context.role, operation.order.jobId, evaluatedRole);
  const existing = context.database.loadEffectInput("session", id);
  if (existing !== undefined) {
    const retained = captureVetInvocation(existing);
    if (retained.localBindingHash !== operation.order.localBindingHash ||
        retained.evaluatedRole !== evaluatedRole ||
        !sameCanonicalClaimIdentity(retained.evaluatedParty, evaluatedParty)) {
      throw new DacsSessionBootstrapAgreementRuntimeError(
        "session-vet-invocation-conflict",
      );
    }
    return retained.invokedAt;
  }
  const invocation: DacsSessionVetInvocationV1 = {
    invocationVersion: VET_INVOCATION_VERSION,
    localBindingHash: operation.order.localBindingHash,
    evaluatedRole,
    evaluatedParty,
    invokedAt: context.database.readTime(),
  };
  const put = context.database.putEffectIntent({
    kind: "session",
    effectId: id,
    bindingHash: operation.order.localBindingHash,
    input: invocation,
    idempotencyKey: id,
    jobId: operation.order.jobId,
  });
  if (put.status === "conflict") {
    throw new DacsSessionBootstrapAgreementRuntimeError(
      "session-vet-invocation-conflict",
    );
  }
  return captureVetInvocation(
    context.database.loadEffectInput("session", id),
  ).invokedAt;
}

export async function advanceDacsVetTerminalTrackV1(
  runtime: Readonly<DacsVetTerminalBundleTransportRuntimeV1>,
  context: Readonly<DacsLiveRoleOperationContextV1>,
  delay: number,
  jobId: string,
): Promise<Readonly<FixedPriceX402TrackOperationResult> | undefined> {
  let progress: Awaited<ReturnType<
    DacsVetTerminalBundleTransportRuntimeV1["advanceRegisteredTerminal"]
  >>;
  try {
    progress = await runtime.advanceRegisteredTerminal(jobId);
  } catch (error) {
    if (error instanceof DacsVetTerminalBundleTransportError &&
        error.reasonCode === "vet-terminal-material-unavailable") return undefined;
    return operator(error instanceof DacsVetTerminalBundleTransportError &&
        error.reasonCode.endsWith("-conflict")
      ? "vet-terminal-finalization-conflict"
      : "vet-terminal-finalization-unavailable");
  }
  if (progress.disposition === "finalised") {
    const faultedParty = progress.result.bundle.faultedParty;
    if ((faultedParty !== "buyer" && faultedParty !== "seller") ||
        !HASH_RE.test(progress.result.planHash) ||
        typeof progress.result.publication.nativeAddress !== "string" ||
        progress.result.publication.nativeAddress.length === 0) {
      return operator("vet-terminal-finalization-invalid");
    }
    return Object.freeze({
      status: "final" as const,
      outcome: "failure" as const,
      errorClass: "counterparty" as const,
      faultedParty,
      reference: progress.result.publication.nativeAddress,
      authenticationHash: progress.result.planHash,
    });
  }
  if (progress.disposition === "waiting") {
    return pending(context, delay, "vet-terminal-finalization-pending");
  }
  if (progress.disposition === "indeterminate") {
    return pending(
      context,
      delay,
      "vet-terminal-finalization-indeterminate",
      "indeterminate",
    );
  }
  return operator("vet-terminal-finalization-rejected");
}

async function finalizeLocalVetFailure(
  terminalBundle: CommonOptionsV1["terminalBundle"],
  context: Readonly<DacsLiveRoleOperationContextV1>,
  delay: number,
  input: Parameters<
    NonNullable<CommonOptionsV1["terminalBundle"]>["createInput"]
  >[0],
): Promise<Readonly<FixedPriceX402TrackOperationResult>> {
  if (terminalBundle === undefined) return operator("vet-terminal-runtime-unavailable");
  try {
    const terminalInput = terminalBundle.createInput(input);
    await terminalBundle.runtime.registerLocalTerminal(terminalInput);
  } catch (error) {
    if (error instanceof DacsVetTerminalBundleTransportError &&
        error.reasonCode === "vet-terminal-production-indeterminate") {
      return pending(
        context,
        delay,
        "vet-terminal-production-indeterminate",
        "indeterminate",
      );
    }
    return operator(error instanceof DacsVetTerminalBundleTransportError &&
        error.reasonCode.endsWith("-conflict")
      ? "vet-terminal-registration-conflict"
      : "vet-terminal-registration-invalid");
  }
  return await advanceDacsVetTerminalTrackV1(
    terminalBundle.runtime,
    context,
    delay,
    input.operation.order.jobId,
  ) ?? operator("vet-terminal-registration-missing");
}

function factsId(role: "buyer" | "seller", jobId: string): string {
  return sha256Hex(`${FACTS_DOMAIN}${canonicalize({ role, jobId })}`);
}

function productionFieldsValid(input: Readonly<{
  record: unknown;
  ref: unknown;
  receipt: unknown;
}>): boolean {
  if (!isCompositeVerificationRecord(input.record) ||
      input.ref === null || typeof input.ref !== "object" ||
      !isReadableAnchorReceipt(input.receipt)) return false;
  const ref = input.ref as AttestationRef;
  return ref.anchor?.kind === "storage-program" &&
    ref.contentHash === contentHash(input.record as unknown as Record<string, unknown>) &&
    input.receipt.nativeAddress === ref.anchor.locator &&
    input.receipt.contentHash === ref.contentHash;
}

function captureFacts(value: unknown): Readonly<
  DacsBuyerSessionAgreementFactsV1 | DacsSellerSessionAgreementFactsV1
> {
  if (!plainObject(value) || (value.role !== "buyer" && value.role !== "seller")) {
    throw new DacsSessionBootstrapAgreementRuntimeError("session-agreement-facts-corrupt");
  }
  const commonKeys = [
    "factsVersion", "role", "jobId", "localBindingHash", "buyerIdentity",
    "sellerIdentity", "buyerRequirementHash", "buyerVetRecord", "buyerVetRef",
    "buyerVetReceipt",
  ];
  const keys = value.role === "buyer" ? [...commonKeys,
    "sellerRequirementHash", "sellerVetRecord", "sellerVetRef", "sellerVetReceipt"]
    : commonKeys;
  if (!exactKeys(value, keys) || value.factsVersion !== FACTS_VERSION ||
      typeof value.jobId !== "string" || typeof value.localBindingHash !== "string" ||
      !HASH_RE.test(value.localBindingHash) ||
      !isIdentityBundle(value.buyerIdentity) || !isIdentityBundle(value.sellerIdentity) ||
      typeof value.buyerRequirementHash !== "string" ||
      !HASH_RE.test(value.buyerRequirementHash) ||
      !productionFieldsValid({ record: value.buyerVetRecord, ref: value.buyerVetRef,
        receipt: value.buyerVetReceipt }) ||
      (value.role === "buyer" &&
        (typeof value.sellerRequirementHash !== "string" ||
          !HASH_RE.test(value.sellerRequirementHash) ||
          !productionFieldsValid({ record: value.sellerVetRecord, ref: value.sellerVetRef,
            receipt: value.sellerVetReceipt })))) {
    throw new DacsSessionBootstrapAgreementRuntimeError("session-agreement-facts-corrupt");
  }
  return value as unknown as Readonly<
    DacsBuyerSessionAgreementFactsV1 | DacsSellerSessionAgreementFactsV1
  >;
}

function retainFacts(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  operation: Readonly<FixedPriceX402TrackOperationInput>,
  facts: Readonly<DacsBuyerSessionAgreementFactsV1 | DacsSellerSessionAgreementFactsV1>,
): void {
  const id = factsId(context.role, operation.order.jobId);
  const existing = context.database.loadEffectInput("session", id);
  if (existing !== undefined) {
    const captured = captureFacts(existing);
    if (captured.localBindingHash !== operation.order.localBindingHash ||
        canonicalize(captured) !== canonicalize(facts)) {
      throw new DacsSessionBootstrapAgreementRuntimeError(
        "session-agreement-facts-conflict",
      );
    }
    return;
  }
  const put = context.database.putEffectIntent({
    kind: "session",
    effectId: id,
    bindingHash: operation.order.localBindingHash,
    input: facts,
    idempotencyKey: id,
    jobId: operation.order.jobId,
  });
  if (put.status === "conflict") {
    throw new DacsSessionBootstrapAgreementRuntimeError("session-agreement-facts-conflict");
  }
  captureFacts(context.database.loadEffectInput("session", id));
}

function loadFacts(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  order: Readonly<FixedPriceX402OrderRecord>,
): Readonly<DacsBuyerSessionAgreementFactsV1 | DacsSellerSessionAgreementFactsV1> {
  const value = context.database.loadEffectInput(
    "session",
    factsId(context.role, order.jobId),
  );
  if (value === undefined) {
    throw new DacsSessionBootstrapAgreementRuntimeError("session-agreement-facts-missing");
  }
  const facts = captureFacts(value);
  if (facts.role !== context.role || facts.jobId !== order.jobId ||
      facts.localBindingHash !== order.localBindingHash ||
      !sameCanonicalClaimIdentity(facts.buyerIdentity.presentedBy, order.buyer) ||
      !sameCanonicalClaimIdentity(facts.sellerIdentity.presentedBy, order.seller)) {
    throw new DacsSessionBootstrapAgreementRuntimeError("session-agreement-facts-corrupt");
  }
  return Object.freeze(structuredClone(facts));
}

export function loadDacsBuyerSessionAgreementFactsV1(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  operation: Readonly<FixedPriceX402TrackOperationInput>,
): Readonly<DacsBuyerSessionAgreementFactsV1> {
  if (!operationBound(context, operation)) {
    throw new DacsSessionBootstrapAgreementRuntimeError("session-agreement-track-mismatch");
  }
  const facts = loadFacts(context, operation.order);
  if (facts.role !== "buyer") {
    throw new DacsSessionBootstrapAgreementRuntimeError("buyer-session-facts-missing");
  }
  return facts;
}

export function loadDacsSellerSessionAgreementFactsV1(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  operation: Readonly<FixedPriceX402TrackOperationInput>,
): Readonly<DacsSellerSessionAgreementFactsV1> {
  if (!operationBound(context, operation)) {
    throw new DacsSessionBootstrapAgreementRuntimeError("session-agreement-track-mismatch");
  }
  const facts = loadFacts(context, operation.order);
  if (facts.role !== "seller") {
    throw new DacsSessionBootstrapAgreementRuntimeError("seller-session-facts-missing");
  }
  return facts;
}

/** Resolve the buyer's immutable bootstrap facts from a loaded coordinator order. */
export function loadDacsBuyerSessionAgreementFactsForOrderV1(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  order: Readonly<FixedPriceX402OrderRecord>,
): Readonly<DacsBuyerSessionAgreementFactsV1> {
  if (context.role !== "buyer" || order.role !== "buyer") {
    throw new DacsSessionBootstrapAgreementRuntimeError("buyer-session-order-mismatch");
  }
  const facts = loadFacts(context, order);
  if (facts.role !== "buyer") {
    throw new DacsSessionBootstrapAgreementRuntimeError("buyer-session-facts-missing");
  }
  return facts;
}

/** Resolve the seller's immutable bootstrap facts from a loaded coordinator order. */
export function loadDacsSellerSessionAgreementFactsForOrderV1(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  order: Readonly<FixedPriceX402OrderRecord>,
): Readonly<DacsSellerSessionAgreementFactsV1> {
  if (context.role !== "seller" || order.role !== "seller") {
    throw new DacsSessionBootstrapAgreementRuntimeError("seller-session-order-mismatch");
  }
  const facts = loadFacts(context, order);
  if (facts.role !== "seller") {
    throw new DacsSessionBootstrapAgreementRuntimeError("seller-session-facts-missing");
  }
  return facts;
}

export function loadDacsPayDemBuyerSessionAgreementFactsV1(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  operation: Readonly<FixedPricePayDemTrackOperationInput>,
): Readonly<DacsBuyerSessionAgreementFactsV1> {
  return loadDacsBuyerSessionAgreementFactsV1(
    context,
    operation as unknown as FixedPriceX402TrackOperationInput,
  );
}

export function loadDacsPayDemSellerSessionAgreementFactsV1(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  operation: Readonly<FixedPricePayDemTrackOperationInput>,
): Readonly<DacsSellerSessionAgreementFactsV1> {
  return loadDacsSellerSessionAgreementFactsV1(
    context,
    operation as unknown as FixedPriceX402TrackOperationInput,
  );
}

export function loadDacsPayDemBuyerSessionAgreementFactsForOrderV1(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  order: Readonly<FixedPricePayDemOrderRecord>,
): Readonly<DacsBuyerSessionAgreementFactsV1> {
  return loadDacsBuyerSessionAgreementFactsForOrderV1(
    context,
    order as unknown as FixedPriceX402OrderRecord,
  );
}

export function loadDacsPayDemSellerSessionAgreementFactsForOrderV1(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  order: Readonly<FixedPricePayDemOrderRecord>,
): Readonly<DacsSellerSessionAgreementFactsV1> {
  return loadDacsSellerSessionAgreementFactsForOrderV1(
    context,
    order as unknown as FixedPriceX402OrderRecord,
  );
}

function requirements(value: unknown): value is Readonly<DacsSessionBootstrapRequirementsV1> {
  return plainObject(value) && exactKeys(value, ["buyer", "seller"]) &&
    isBundleRequirement(value.buyer) && isBundleRequirement(value.seller);
}

function vetProgress(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  delay: number,
  outcome: Readonly<DacsSessionVetProductionOutcomeV1>,
): Readonly<FixedPriceX402TrackOperationResult> | undefined {
  if (outcome.status === "operator-action") return operator(outcome.reasonCode);
  if (outcome.status === "indeterminate") {
    return pending(context, delay, outcome.reasonCode, "indeterminate");
  }
  return undefined;
}

async function authenticateProducedVet(
  vet: Readonly<DacsSessionVetRuntimeV1>,
  input: Readonly<{
    context: Readonly<DacsLiveRoleOperationContextV1>;
    jobId: string;
    evaluatedIdentity: Readonly<IdentityBundle>;
    requirement: Readonly<BundleRequirement>;
    verifier: string;
    production: Readonly<DacsSessionVetProductionV1>;
  }>,
): Promise<"valid" | "invalid" | "indeterminate"> {
  try {
    const result = await vet.authenticate(input);
    return result === "valid" || result === "invalid" || result === "indeterminate"
      ? result : "indeterminate";
  } catch {
    return "indeterminate";
  }
}

function nonTerminalVetDecision(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  delay: number,
  decision: CompositeVerificationRecord["overallDecision"],
): Readonly<FixedPriceX402TrackOperationResult> | undefined {
  if (decision === "pass" || decision === "fail") return undefined;
  return pending(
    context,
    delay,
    decision === "error" ? "session-vet-decision-error" :
      "session-vet-decision-indeterminate",
    "indeterminate",
  );
}

export function createDacsBuyerSessionBootstrapAgreementTrackV1(
  options: Readonly<DacsBuyerSessionBootstrapAgreementTrackOptionsV1>,
): FixedPriceX402TrackOperation {
  if (!plainObject(options) || !plainObject(options.context) ||
      options.context.role !== "buyer" || !plainObject(options.sessionBootstrap) ||
      typeof options.resolveRequirements !== "function" ||
      typeof options.agreement !== "function") {
    throw new TypeError("buyer session bootstrap agreement options are invalid");
  }
  const context = options.context;
  const delay = retryDelay(options.retryDelayMs);
  const vet = sessionVetRuntime(options.vet);
  return async (operation) => {
    if (!operationBound(context, operation)) {
      return operator("buyer-session-bootstrap-track-mismatch");
    }
    if (options.terminalBundle !== undefined) {
      const terminal = await advanceDacsVetTerminalTrackV1(
        options.terminalBundle.runtime,
        context,
        delay,
        operation.order.jobId,
      );
      if (terminal !== undefined) return terminal;
    }
    let retained: Readonly<DacsLiveOrderInputV1>;
    let resolvedRequirements: Readonly<DacsSessionBootstrapRequirementsV1>;
    try {
      retained = loadDacsLiveOrderInputForTrackV1(operation, context.database);
      resolvedRequirements = await options.resolveRequirements({ operation, retained });
      if (!requirements(resolvedRequirements) ||
          (options.vet === undefined &&
            (resolvedRequirements.buyer.required.length !== 0 ||
              (resolvedRequirements.buyer.oneOf?.length ?? 0) !== 0 ||
              resolvedRequirements.seller.required.length !== 0 ||
              (resolvedRequirements.seller.oneOf?.length ?? 0) !== 0))) throw new Error();
    } catch {
      return operator("buyer-session-requirements-invalid");
    }
    let init = options.sessionBootstrap.resolveInit(operation);
    if (init === undefined) {
      init = Object.freeze({
        bootstrapVersion: "1" as const,
        order: retained.order,
        application: retained.application,
        sellerChallenge: randomBytes(32).toString("hex"),
      });
    }
    const challenge = options.sessionBootstrap.resolveChallenge(operation);
    if (challenge === undefined) {
      const sent = await options.sessionBootstrap.publishInit(operation, init);
      return sent === "rejected"
        ? operator("buyer-session-init-rejected")
        : pending(context, delay, "buyer-session-challenge-pending");
    }
    let presentation = options.sessionBootstrap.resolvePresentation(operation);
    try {
      if (presentation === undefined) {
        presentation = Object.freeze({
          bootstrapVersion: "1" as const,
          challengePayloadHash: dacsHttpPayloadHashV1(challenge),
          buyerChallenge: challenge.buyerChallenge,
          buyerIdentity: await createDacsLiveSessionIdentityV1({
            context,
            operation,
            challenge: challenge.buyerChallenge,
          }),
        });
      }
    } catch {
      return operator("buyer-session-identity-invalid");
    }
    let sellerVetInvokedAt: number;
    try {
      sellerVetInvokedAt = retainVetInvocation(
        context,
        operation,
        "seller",
        challenge.sellerIdentity.presentedBy,
      );
    } catch {
      return operator("buyer-session-seller-vet-invocation-invalid");
    }
    let sent: Awaited<ReturnType<
      DacsBuyerSessionBootstrapTransportRuntimeV1["publishPresentation"]
    >>;
    let sellerVet: Readonly<DacsSessionVetProductionOutcomeV1>;
    try {
      [sent, sellerVet] = await Promise.all([
        options.sessionBootstrap.publishPresentation(operation, presentation),
        vet.produce({
          context,
          operation,
          evaluatedIdentity: challenge.sellerIdentity,
          requirement: resolvedRequirements.seller,
        }),
      ]);
    } catch {
      return pending(
        context,
        delay,
        "buyer-session-seller-vet-producer-unavailable",
        "indeterminate",
      );
    }
    if (sent === "rejected") return operator("buyer-session-presentation-rejected");
    const vetResult = vetProgress(context, delay, sellerVet);
    if (vetResult !== undefined) return vetResult;
    if (sellerVet.status !== "ready") return operator("buyer-session-seller-vet-invalid");
    const sellerAuthentication = await authenticateProducedVet(vet, {
      context,
      jobId: operation.order.jobId,
      evaluatedIdentity: challenge.sellerIdentity,
      requirement: resolvedRequirements.seller,
      verifier: context.authority,
      production: sellerVet.production,
    });
    if (sellerAuthentication === "invalid") {
      return operator("buyer-session-seller-vet-invalid");
    }
    if (sellerAuthentication === "indeterminate") {
      return pending(
        context,
        delay,
        "buyer-session-seller-vet-pending",
        "indeterminate",
      );
    }
    const sellerDecision = nonTerminalVetDecision(
      context,
      delay,
      sellerVet.production.record.overallDecision,
    );
    if (sellerDecision !== undefined) return sellerDecision;
    if (sellerVet.production.record.overallDecision === "fail") {
      return await finalizeLocalVetFailure(
        options.terminalBundle,
        context,
        delay,
        {
          operation,
          retained,
          buyerIdentity: presentation.buyerIdentity,
          sellerIdentity: challenge.sellerIdentity,
          evaluatedRole: "seller",
          production: sellerVet.production,
          vetInvokedAt: sellerVetInvokedAt,
        },
      );
    }
    const admission = options.sessionBootstrap.resolveAdmission(operation);
    if (admission === undefined) {
      return pending(context, delay, "buyer-session-admission-pending");
    }
    const buyerProduction: DacsSessionVetProductionV1 = {
      record: admission.buyerVetRecord,
      recordRef: admission.buyerVetRef,
      anchorReceipt: admission.buyerVetReceipt,
    };
    const buyerVet = await authenticateProducedVet(vet, {
      context,
      jobId: operation.order.jobId,
      evaluatedIdentity: presentation.buyerIdentity,
      requirement: resolvedRequirements.buyer,
      verifier: operation.order.seller,
      production: buyerProduction,
    });
    if (buyerVet === "invalid") return operator("buyer-session-admission-vet-invalid");
    if (buyerVet === "indeterminate") {
      return pending(context, delay, "buyer-session-admission-vet-pending", "indeterminate");
    }
    if (buyerProduction.record.overallDecision !== "pass") {
      const remoteDecision = nonTerminalVetDecision(
        context,
        delay,
        buyerProduction.record.overallDecision,
      );
      return remoteDecision ?? pending(
        context,
        delay,
        "buyer-session-admission-terminal-pending",
      );
    }
    try {
      retainFacts(context, operation, {
        factsVersion: FACTS_VERSION,
        role: "buyer",
        jobId: operation.order.jobId,
        localBindingHash: operation.order.localBindingHash,
        buyerIdentity: presentation.buyerIdentity,
        sellerIdentity: challenge.sellerIdentity,
        buyerRequirementHash: sha256Hex(canonicalize(resolvedRequirements.buyer)),
        sellerRequirementHash: sha256Hex(canonicalize(resolvedRequirements.seller)),
        buyerVetRecord: buyerProduction.record,
        buyerVetRef: buyerProduction.recordRef,
        buyerVetReceipt: buyerProduction.anchorReceipt,
        sellerVetRecord: sellerVet.production.record,
        sellerVetRef: sellerVet.production.recordRef,
        sellerVetReceipt: sellerVet.production.anchorReceipt,
      });
      await operation.fence.assertCurrent();
      return await options.agreement(operation);
    } catch {
      return operator("buyer-session-agreement-handoff-invalid");
    }
  };
}

export function createDacsSellerSessionBootstrapAgreementTrackV1(
  options: Readonly<DacsSellerSessionBootstrapAgreementTrackOptionsV1>,
): FixedPriceX402TrackOperation {
  if (!plainObject(options) || !plainObject(options.context) ||
      options.context.role !== "seller" || !plainObject(options.sessionBootstrap) ||
      typeof options.resolveBuyerRequirement !== "function" ||
      typeof options.agreementProposalReady !== "function" ||
      typeof options.agreement !== "function") {
    throw new TypeError("seller session bootstrap agreement options are invalid");
  }
  const context = options.context;
  const delay = retryDelay(options.retryDelayMs);
  const vet = sessionVetRuntime(options.vet);
  return async (operation) => {
    if (!operationBound(context, operation)) {
      return operator("seller-session-bootstrap-track-mismatch");
    }
    if (options.terminalBundle !== undefined) {
      const terminal = await advanceDacsVetTerminalTrackV1(
        options.terminalBundle.runtime,
        context,
        delay,
        operation.order.jobId,
      );
      if (terminal !== undefined) return terminal;
    }
    let retained: Readonly<DacsLiveOrderInputV1>;
    let buyerRequirement: Readonly<BundleRequirement>;
    try {
      retained = loadDacsLiveOrderInputForTrackV1(operation, context.database);
      buyerRequirement = await options.resolveBuyerRequirement({ operation, retained });
      if (!isBundleRequirement(buyerRequirement) ||
          (options.vet === undefined &&
            (buyerRequirement.required.length !== 0 ||
              (buyerRequirement.oneOf?.length ?? 0) !== 0))) {
        throw new Error();
      }
    } catch {
      return operator("seller-session-requirement-invalid");
    }
    const init = options.sessionBootstrap.resolveInit(operation);
    if (init === undefined) {
      return pending(context, delay, "seller-session-init-pending");
    }
    let challenge = options.sessionBootstrap.resolveChallenge(operation);
    try {
      if (challenge === undefined) {
        challenge = Object.freeze({
          bootstrapVersion: "1" as const,
          initPayloadHash: dacsHttpPayloadHashV1(init),
          sellerChallenge: init.sellerChallenge,
          buyerChallenge: randomBytes(32).toString("hex"),
          sellerIdentity: await createDacsLiveSessionIdentityV1({
            context,
            operation,
            challenge: init.sellerChallenge,
          }),
        });
      }
    } catch {
      return operator("seller-session-identity-invalid");
    }
    const presentation = options.sessionBootstrap.resolvePresentation(operation);
    if (presentation === undefined) {
      const sent = await options.sessionBootstrap.publishChallenge(operation, challenge);
      return sent === "rejected"
        ? operator("seller-session-challenge-rejected")
        : pending(context, delay, "seller-session-presentation-pending");
    }
    let buyerVetInvokedAt: number;
    try {
      buyerVetInvokedAt = retainVetInvocation(
        context,
        operation,
        "buyer",
        presentation.buyerIdentity.presentedBy,
      );
    } catch {
      return operator("seller-session-buyer-vet-invocation-invalid");
    }
    let buyerVet: Readonly<DacsSessionVetProductionOutcomeV1>;
    try {
      buyerVet = await vet.produce({
        context,
        operation,
        evaluatedIdentity: presentation.buyerIdentity,
        requirement: buyerRequirement,
      });
    } catch {
      return pending(
        context,
        delay,
        "seller-session-buyer-vet-producer-unavailable",
        "indeterminate",
      );
    }
    const vetResult = vetProgress(context, delay, buyerVet);
    if (vetResult !== undefined) return vetResult;
    if (buyerVet.status !== "ready") return operator("seller-session-buyer-vet-invalid");
    const buyerAuthentication = await authenticateProducedVet(vet, {
      context,
      jobId: operation.order.jobId,
      evaluatedIdentity: presentation.buyerIdentity,
      requirement: buyerRequirement,
      verifier: context.authority,
      production: buyerVet.production,
    });
    if (buyerAuthentication === "invalid") {
      return operator("seller-session-buyer-vet-invalid");
    }
    if (buyerAuthentication === "indeterminate") {
      return pending(
        context,
        delay,
        "seller-session-buyer-vet-pending",
        "indeterminate",
      );
    }
    const buyerDecision = nonTerminalVetDecision(
      context,
      delay,
      buyerVet.production.record.overallDecision,
    );
    if (buyerDecision !== undefined) return buyerDecision;
    if (buyerVet.production.record.overallDecision === "fail") {
      return await finalizeLocalVetFailure(
        options.terminalBundle,
        context,
        delay,
        {
          operation,
          retained,
          buyerIdentity: presentation.buyerIdentity,
          sellerIdentity: challenge.sellerIdentity,
          evaluatedRole: "buyer",
          production: buyerVet.production,
          vetInvokedAt: buyerVetInvokedAt,
        },
      );
    }
    let admission = options.sessionBootstrap.resolveAdmission(operation);
    if (admission === undefined) {
      admission = Object.freeze({
        bootstrapVersion: "1" as const,
        presentationPayloadHash: dacsHttpPayloadHashV1(presentation),
        buyerIdentityHash: identityBundleHash(presentation.buyerIdentity),
        sellerIdentityHash: identityBundleHash(challenge.sellerIdentity),
        buyerVetRecord: buyerVet.production.record,
        buyerVetRef: buyerVet.production.recordRef,
        buyerVetReceipt: buyerVet.production.anchorReceipt,
      });
    }
    const sent = await options.sessionBootstrap.publishAdmission(operation, admission);
    if (sent === "rejected") return operator("seller-session-admission-rejected");
    try {
      retainFacts(context, operation, {
        factsVersion: FACTS_VERSION,
        role: "seller",
        jobId: operation.order.jobId,
        localBindingHash: operation.order.localBindingHash,
        buyerIdentity: presentation.buyerIdentity,
        sellerIdentity: challenge.sellerIdentity,
        buyerRequirementHash: sha256Hex(canonicalize(buyerRequirement)),
        buyerVetRecord: buyerVet.production.record,
        buyerVetRef: buyerVet.production.recordRef,
        buyerVetReceipt: buyerVet.production.anchorReceipt,
      });
    } catch {
      return operator("seller-session-agreement-handoff-invalid");
    }
    try {
      await operation.fence.assertCurrent();
      if (await options.agreementProposalReady({ operation, retained }) !== true) {
        return pending(context, delay, "seller-agreement-proposal-pending");
      }
    } catch {
      return pending(context, delay, "seller-agreement-proposal-pending");
    }
    try {
      return await options.agreement(operation);
    } catch {
      return operator("seller-agreement-runtime-failed");
    }
  };
}

export function createDacsPayDemBuyerSessionBootstrapAgreementTrackV1(
  options: Readonly<DacsPayDemBuyerSessionBootstrapAgreementTrackOptionsV1>,
): FixedPricePayDemTrackOperation {
  const x402 = createDacsBuyerSessionBootstrapAgreementTrackV1(
    options as unknown as DacsBuyerSessionBootstrapAgreementTrackOptionsV1,
  );
  return async (operation) => {
    if (operation.order.protocol.phase !== "pay-dem") {
      return operator("buyer-session-bootstrap-rail-mismatch");
    }
    return x402(operation as unknown as FixedPriceX402TrackOperationInput);
  };
}

export function createDacsPayDemSellerSessionBootstrapAgreementTrackV1(
  options: Readonly<DacsPayDemSellerSessionBootstrapAgreementTrackOptionsV1>,
): FixedPricePayDemTrackOperation {
  const x402 = createDacsSellerSessionBootstrapAgreementTrackV1(
    options as unknown as DacsSellerSessionBootstrapAgreementTrackOptionsV1,
  );
  return async (operation) => {
    if (operation.order.protocol.phase !== "pay-dem") {
      return operator("seller-session-bootstrap-rail-mismatch");
    }
    return x402(operation as unknown as FixedPriceX402TrackOperationInput);
  };
}
