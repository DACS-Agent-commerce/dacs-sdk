import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import {
  isFixedPriceAgreementProposalEnvelope,
  type FixedPriceAgreementEffectFence,
  type FixedPriceAgreementEffectSubmission,
  type FixedPriceAgreementProposal,
  type FixedPriceAgreementProposalEnvelope,
  type FixedPriceAgreementResolution,
  type FixedPriceAgreementSignatureContribution,
  type FixedPriceAgreementTransport,
  type FixedPriceAgreementTransportIdentity,
} from "@kynesyslabs/dacs/negotiate";
import type {
  FixedPriceX402OrderInput,
  FixedPriceX402OrderRecord,
  FixedPriceX402TrackOperationInput,
} from "@kynesyslabs/dacs/commerce";
import {
  isDurableSellerFixedPriceAgreementResponse,
  type DurableSellerFixedPriceAgreementResponse,
  type SellerFixedPriceAgreementContributionTransport,
} from "@kynesyslabs/dacs/seller";

import { putDacsLiveOrderInputV1 } from "./orderInput.js";
import type {
  DacsLiveRoleInboundOperationContextV1,
  DacsLiveRoleOperationContextV1,
} from "./roleRuntime.js";
import type { DacsLiveRoleSendInputV1 } from "./service.js";
import type {
  DacsAgreementProposalPayloadV1,
  DacsHttpAuthenticatedEnvelopeV1,
  DacsHttpPayloadValidationV1,
  DacsHttpPayloadValidatorV1,
} from "./transport/envelope.js";
import type { DacsHttpInboundDispositionV1 } from "./transport/http.js";

const AGREEMENT_BINDING_VERSION = "1" as const;
const AGREEMENT_BINDING_ID_DOMAIN = "dacs-live-agreement-transport-binding:v1:" as const;
const HASH_RE = /^[0-9a-f]{64}$/;

type AgreementBindingKind = "proposal" | "response";

interface DacsAgreementProposalBindingV1 {
  bindingVersion: typeof AGREEMENT_BINDING_VERSION;
  localBindingHash: string;
  payloadHash: string;
  payload: Readonly<DacsAgreementProposalPayloadV1>;
  transportAuthentication?: Readonly<DacsAgreementTransportAuthenticationV1>;
}

interface DacsAgreementResponseBindingV1 {
  bindingVersion: typeof AGREEMENT_BINDING_VERSION;
  localBindingHash: string;
  payloadHash: string;
  payload: Readonly<DurableSellerFixedPriceAgreementResponse>;
  transportAuthentication?: Readonly<DacsAgreementTransportAuthenticationV1>;
}

interface DacsAgreementTransportAuthenticationV1 {
  envelopeId: string;
  authenticationHash: string;
  identityEvidenceHash: string;
  sender: string;
  audience: string;
  payloadHash: string;
}

export interface DacsBuyerAgreementTransportRuntimeV1 {
  readonly transport: Readonly<FixedPriceAgreementTransport>;
  readonly validatePayload: DacsHttpPayloadValidatorV1;
  handleMessage(
    authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
    context: Readonly<DacsLiveRoleInboundOperationContextV1>,
  ): Promise<DacsHttpInboundDispositionV1>;
}

export interface DacsSellerAgreementAdmissionV1 {
  order: Readonly<FixedPriceX402OrderInput>;
  /** Public, durable application facts required by the seller's later tracks. */
  application: Readonly<Record<string, unknown>>;
}

export interface DacsSellerAgreementTransportRuntimeOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  admitProposal(input: Readonly<{
    authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>;
    payload: Readonly<DacsAgreementProposalPayloadV1>;
  }>): Promise<Readonly<DacsSellerAgreementAdmissionV1>> |
    Readonly<DacsSellerAgreementAdmissionV1>;
}

export interface DacsSellerAgreementTransportRuntimeV1 {
  readonly transport: Readonly<SellerFixedPriceAgreementContributionTransport>;
  readonly validatePayload: DacsHttpPayloadValidatorV1;
  resolveProposal(
    input: Readonly<{
      operation: Readonly<FixedPriceX402TrackOperationInput>;
    }>,
  ): Promise<Readonly<FixedPriceAgreementProposalEnvelope>>;
  handleMessage(
    authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
    context: Readonly<DacsLiveRoleInboundOperationContextV1>,
  ): Promise<DacsHttpInboundDispositionV1>;
}

export class DacsAgreementTransportRuntimeError extends Error {
  override readonly name = "DacsAgreementTransportRuntimeError";

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
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => keys.includes(key)) &&
    keys.every((key) => allowed.has(key));
}

function payloadResult(valid: boolean, reasonCode: string): DacsHttpPayloadValidationV1 {
  return valid
    ? Object.freeze({ status: "valid" as const })
    : Object.freeze({ status: "invalid" as const, reasonCode });
}

function acceptedAcknowledgement(
  acknowledgement: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
): "accepted" | "existing" | "rejected" {
  return acknowledgement.envelope.type === "acknowledgement"
    ? acknowledgement.envelope.payload.disposition
    : "rejected";
}

function bindingId(
  role: "buyer" | "seller",
  kind: AgreementBindingKind,
  input: Readonly<{ jobId: string; buyer: string; seller: string }>,
): string {
  return sha256Hex(`${AGREEMENT_BINDING_ID_DOMAIN}${canonicalize({
    role,
    kind,
    jobId: input.jobId,
    buyer: input.buyer,
    seller: input.seller,
  })}`);
}

async function loadOrder(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  jobId: string,
): Promise<Readonly<FixedPriceX402OrderRecord> | undefined> {
  const loaded = await context.database.createLiveCoordinatorStore(context.role)
    .load(context.role, jobId);
  if (loaded.status === "missing") return undefined;
  if (loaded.status !== "ok") {
    throw new DacsAgreementTransportRuntimeError("agreement-order-state-invalid");
  }
  return loaded.record;
}

function identityMatchesOrder(
  identity: Readonly<FixedPriceAgreementTransportIdentity>,
  order: Readonly<FixedPriceX402OrderRecord> | Readonly<FixedPriceX402OrderInput>,
  role: "buyer" | "seller",
): boolean {
  return order.sdkJobs.role === role && identity.jobId === order.jobId &&
    identity.buyer === order.buyer && identity.seller === order.seller;
}

function agreementPayloadHash(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

function captureTransportAuthentication(
  value: unknown,
): Readonly<DacsAgreementTransportAuthenticationV1> {
  if (!plainObject(value) || Reflect.ownKeys(value).length !== 6 ||
      typeof value.envelopeId !== "string" || !HASH_RE.test(value.envelopeId) ||
      typeof value.authenticationHash !== "string" || !HASH_RE.test(value.authenticationHash) ||
      typeof value.identityEvidenceHash !== "string" ||
        !HASH_RE.test(value.identityEvidenceHash) ||
      typeof value.sender !== "string" || value.sender.length === 0 ||
      typeof value.audience !== "string" || value.audience.length === 0 ||
      typeof value.payloadHash !== "string" || !HASH_RE.test(value.payloadHash)) {
    throw new DacsAgreementTransportRuntimeError("agreement-transport-authentication-corrupt");
  }
  return value as unknown as Readonly<DacsAgreementTransportAuthenticationV1>;
}

function transportAuthentication(
  authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
): Readonly<DacsAgreementTransportAuthenticationV1> {
  return captureTransportAuthentication({
    envelopeId: authenticated.envelope.envelopeId,
    authenticationHash: authenticated.authenticationHash,
    identityEvidenceHash: authenticated.identityEvidenceHash,
    sender: authenticated.envelope.sender,
    audience: authenticated.envelope.audience,
    payloadHash: authenticated.envelope.payloadHash,
  });
}

function captureProposalBinding(value: unknown): Readonly<DacsAgreementProposalBindingV1> {
  if (!plainObject(value) || !exactFields(value, [
    "bindingVersion", "localBindingHash", "payloadHash", "payload",
  ], ["transportAuthentication"]) ||
      value.bindingVersion !== AGREEMENT_BINDING_VERSION ||
      typeof value.localBindingHash !== "string" || !HASH_RE.test(value.localBindingHash) ||
      typeof value.payloadHash !== "string" || !HASH_RE.test(value.payloadHash) ||
      !isFixedPriceAgreementProposalEnvelope(value.payload) ||
      agreementPayloadHash(value.payload) !== value.payloadHash ||
      (value.transportAuthentication !== undefined &&
        (captureTransportAuthentication(value.transportAuthentication).payloadHash !==
          value.payloadHash))) {
    throw new DacsAgreementTransportRuntimeError("agreement-proposal-binding-corrupt");
  }
  return value as unknown as Readonly<DacsAgreementProposalBindingV1>;
}

function captureResponseBinding(value: unknown): Readonly<DacsAgreementResponseBindingV1> {
  if (!plainObject(value) || !exactFields(value, [
    "bindingVersion", "localBindingHash", "payloadHash", "payload",
  ], ["transportAuthentication"]) ||
      value.bindingVersion !== AGREEMENT_BINDING_VERSION ||
      typeof value.localBindingHash !== "string" || !HASH_RE.test(value.localBindingHash) ||
      typeof value.payloadHash !== "string" || !HASH_RE.test(value.payloadHash) ||
      !isDurableSellerFixedPriceAgreementResponse(value.payload) ||
      agreementPayloadHash(value.payload) !== value.payloadHash ||
      (value.transportAuthentication !== undefined &&
        (captureTransportAuthentication(value.transportAuthentication).payloadHash !==
          value.payloadHash))) {
    throw new DacsAgreementTransportRuntimeError("agreement-response-binding-corrupt");
  }
  return value as unknown as Readonly<DacsAgreementResponseBindingV1>;
}

function retainProposal(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  order: Readonly<FixedPriceX402OrderRecord>,
  payload: Readonly<DacsAgreementProposalPayloadV1>,
  authenticated?: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
): Readonly<DacsAgreementProposalBindingV1> {
  if (!isFixedPriceAgreementProposalEnvelope(payload) ||
      !identityMatchesOrder(payload.transportIdentity, order, context.role)) {
    throw new DacsAgreementTransportRuntimeError("agreement-proposal-order-mismatch");
  }
  const id = bindingId(context.role, "proposal", order);
  const existing = context.database.loadEffectInput("session", id);
  if (existing !== undefined) {
    const captured = captureProposalBinding(existing);
    if (captured.localBindingHash !== order.localBindingHash ||
        captured.payloadHash !== agreementPayloadHash(payload) ||
        canonicalize(captured.payload) !== canonicalize(payload)) {
      throw new DacsAgreementTransportRuntimeError("agreement-proposal-binding-conflict");
    }
    return captured;
  }
  const binding: DacsAgreementProposalBindingV1 = {
    bindingVersion: AGREEMENT_BINDING_VERSION,
    localBindingHash: order.localBindingHash,
    payloadHash: agreementPayloadHash(payload),
    payload,
    ...(authenticated === undefined
      ? {} : { transportAuthentication: transportAuthentication(authenticated) }),
  };
  const put = context.database.putEffectIntent({
    kind: "session",
    effectId: id,
    bindingHash: binding.localBindingHash,
    input: binding,
    idempotencyKey: id,
    jobId: order.jobId,
  });
  if (put.status === "conflict") {
    throw new DacsAgreementTransportRuntimeError("agreement-proposal-binding-conflict");
  }
  return captureProposalBinding(context.database.loadEffectInput("session", id));
}

function retainResponse(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  order: Readonly<FixedPriceX402OrderRecord>,
  payload: Readonly<DurableSellerFixedPriceAgreementResponse>,
  authenticated?: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
): Readonly<DacsAgreementResponseBindingV1> {
  if (!isDurableSellerFixedPriceAgreementResponse(payload) ||
      !identityMatchesOrder(payload.transportIdentity, order, context.role)) {
    throw new DacsAgreementTransportRuntimeError("agreement-response-order-mismatch");
  }
  const proposal = loadProposalBinding(context, order);
  if (proposal === undefined || canonicalize(proposal.payload.transportIdentity) !==
      canonicalize(payload.transportIdentity)) {
    throw new DacsAgreementTransportRuntimeError("agreement-response-proposal-mismatch");
  }
  const id = bindingId(context.role, "response", order);
  const existing = context.database.loadEffectInput("session", id);
  if (existing !== undefined) {
    const captured = captureResponseBinding(existing);
    if (captured.localBindingHash !== order.localBindingHash ||
        captured.payloadHash !== agreementPayloadHash(payload) ||
        canonicalize(captured.payload) !== canonicalize(payload)) {
      throw new DacsAgreementTransportRuntimeError("agreement-response-binding-conflict");
    }
    return captured;
  }
  const binding: DacsAgreementResponseBindingV1 = {
    bindingVersion: AGREEMENT_BINDING_VERSION,
    localBindingHash: order.localBindingHash,
    payloadHash: agreementPayloadHash(payload),
    payload,
    ...(authenticated === undefined
      ? {} : { transportAuthentication: transportAuthentication(authenticated) }),
  };
  const put = context.database.putEffectIntent({
    kind: "session",
    effectId: id,
    bindingHash: order.localBindingHash,
    input: binding,
    idempotencyKey: id,
    jobId: order.jobId,
  });
  if (put.status === "conflict") {
    throw new DacsAgreementTransportRuntimeError("agreement-response-binding-conflict");
  }
  return captureResponseBinding(context.database.loadEffectInput("session", id));
}

function loadProposalBinding(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  order: Readonly<FixedPriceX402OrderRecord>,
): Readonly<DacsAgreementProposalBindingV1> | undefined {
  const value = context.database.loadEffectInput(
    "session",
    bindingId(context.role, "proposal", order),
  );
  if (value === undefined) return undefined;
  const binding = captureProposalBinding(value);
  if (binding.localBindingHash !== order.localBindingHash ||
      !identityMatchesOrder(binding.payload.transportIdentity, order, context.role)) {
    throw new DacsAgreementTransportRuntimeError("agreement-proposal-binding-corrupt");
  }
  return binding;
}

function loadResponseBinding(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  order: Readonly<FixedPriceX402OrderRecord>,
): Readonly<DacsAgreementResponseBindingV1> | undefined {
  const value = context.database.loadEffectInput(
    "session",
    bindingId(context.role, "response", order),
  );
  if (value === undefined) return undefined;
  const binding = captureResponseBinding(value);
  if (binding.localBindingHash !== order.localBindingHash ||
      !identityMatchesOrder(binding.payload.transportIdentity, order, context.role)) {
    throw new DacsAgreementTransportRuntimeError("agreement-response-binding-corrupt");
  }
  return binding;
}

async function sendProposal(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  binding: Readonly<DacsAgreementProposalBindingV1>,
): Promise<FixedPriceAgreementEffectSubmission> {
  try {
    const acknowledgement = await context.sendMessage({
      type: "agreement-proposal",
      jobId: binding.payload.transportIdentity.jobId,
      payload: binding.payload,
    } satisfies DacsLiveRoleSendInputV1<"agreement-proposal">);
    const disposition = acceptedAcknowledgement(acknowledgement);
    return disposition === "accepted" || disposition === "existing"
      ? Object.freeze({ disposition: "submitted" as const })
      : Object.freeze({ disposition: "rejected" as const, reason: "peer-rejected-proposal" });
  } catch {
    return Object.freeze({
      disposition: "indeterminate" as const,
      reason: "agreement-proposal-transport-ambiguous",
    });
  }
}

async function sendResponse(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  binding: Readonly<DacsAgreementResponseBindingV1>,
): Promise<FixedPriceAgreementEffectSubmission> {
  try {
    const acknowledgement = await context.sendMessage({
      type: "agreement-response",
      jobId: binding.payload.transportIdentity.jobId,
      payload: binding.payload,
    } satisfies DacsLiveRoleSendInputV1<"agreement-response">);
    const disposition = acceptedAcknowledgement(acknowledgement);
    return disposition === "accepted" || disposition === "existing"
      ? Object.freeze({ disposition: "submitted" as const })
      : Object.freeze({ disposition: "rejected" as const, reason: "peer-rejected-response" });
  } catch {
    return Object.freeze({
      disposition: "indeterminate" as const,
      reason: "agreement-response-transport-ambiguous",
    });
  }
}

export function createDacsBuyerAgreementTransportRuntimeV1(
  context: Readonly<DacsLiveRoleOperationContextV1>,
): Readonly<DacsBuyerAgreementTransportRuntimeV1> {
  if (!plainObject(context) || context.role !== "buyer") {
    throw new TypeError("buyer agreement transport runtime context is invalid");
  }

  const validatePayload: DacsHttpPayloadValidatorV1 = async (input) => {
    if (input.type !== "agreement-response" ||
        !isDurableSellerFixedPriceAgreementResponse(input.payload) ||
        input.sender !== context.peerAuthority || input.audience !== context.authority ||
        input.payload.transportIdentity.jobId !== input.jobId ||
        input.payload.transportIdentity.buyer !== context.authority ||
        input.payload.transportIdentity.seller !== context.peerAuthority) {
      return payloadResult(false, "agreement-response-invalid");
    }
    try {
      const order = await loadOrder(context, input.jobId);
      const proposal = order === undefined ? undefined : loadProposalBinding(context, order);
      return payloadResult(order !== undefined && proposal !== undefined &&
        canonicalize(proposal.payload.transportIdentity) ===
          canonicalize(input.payload.transportIdentity),
      "agreement-response-unbound");
    } catch {
      return Object.freeze({
        status: "authentication-failure" as const,
        reasonCode: "agreement-response-validation-unavailable",
      });
    }
  };

  const transport: FixedPriceAgreementTransport = {
    async publishProposal(
      proposal: Readonly<FixedPriceAgreementProposal>,
      identity: Readonly<FixedPriceAgreementTransportIdentity>,
      _fence: Readonly<FixedPriceAgreementEffectFence>,
    ): Promise<FixedPriceAgreementEffectSubmission> {
      const order = await loadOrder(context, identity.jobId);
      if (order === undefined) {
        return { disposition: "rejected" as const, reason: "buyer-order-missing" };
      }
      try {
        const binding = retainProposal(context, order, {
          proposal,
          transportIdentity: identity,
        });
        return sendProposal(context, binding);
      } catch {
        return { disposition: "rejected" as const, reason: "agreement-proposal-invalid" };
      }
    },
    async reconcileProposalPublication(
      identity: Readonly<FixedPriceAgreementTransportIdentity>,
    ): Promise<FixedPriceAgreementResolution<unknown>> {
      try {
        const order = await loadOrder(context, identity.jobId);
        const binding = order === undefined ? undefined : loadProposalBinding(context, order);
        if (binding === undefined) {
          return { disposition: "absent", reason: "agreement-proposal-not-attempted" };
        }
        if (canonicalize(binding.payload.transportIdentity) !== canonicalize(identity)) {
          return { disposition: "rejected", reason: "agreement-proposal-identity-conflict" };
        }
        const sent = await sendProposal(context, binding);
        return sent.disposition === "submitted"
          ? { disposition: "present", value: binding.payload }
          : sent.disposition === "rejected"
            ? { disposition: "rejected", reason: sent.reason }
            : { disposition: "indeterminate", reason: sent.reason };
      } catch {
        return { disposition: "indeterminate", reason: "agreement-proposal-reconciliation-failed" };
      }
    },
    async resolveSellerContributions(
      identity: Readonly<FixedPriceAgreementTransportIdentity>,
    ): Promise<FixedPriceAgreementResolution<unknown>> {
      try {
        const order = await loadOrder(context, identity.jobId);
        const binding = order === undefined ? undefined : loadResponseBinding(context, order);
        if (binding === undefined) {
          return { disposition: "absent", reason: "agreement-response-pending" };
        }
        if (canonicalize(binding.payload.transportIdentity) !== canonicalize(identity)) {
          return { disposition: "rejected", reason: "agreement-response-identity-conflict" };
        }
        return { disposition: "present", value: [binding.payload.sellerContribution] };
      } catch {
        return { disposition: "indeterminate", reason: "agreement-response-resolution-failed" };
      }
    },
  };
  Object.freeze(transport);

  const runtime: DacsBuyerAgreementTransportRuntimeV1 = {
    transport,
    validatePayload,
    async handleMessage(
      authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
      inboundContext: Readonly<DacsLiveRoleInboundOperationContextV1>,
    ) {
      const envelope = authenticated.envelope;
      if (inboundContext.role !== "buyer" || envelope.type !== "agreement-response") {
        return Object.freeze({
          disposition: "rejected" as const,
          reasonCode: "agreement-response-role-incompatible",
        });
      }
      const validation = await validatePayload({
        type: envelope.type,
        payload: envelope.payload,
        jobId: envelope.jobId,
        sender: envelope.sender,
        audience: envelope.audience,
      });
      if (validation.status !== "valid") {
        return Object.freeze({ disposition: "rejected" as const, reasonCode: validation.reasonCode });
      }
      try {
        const order = await loadOrder(context, envelope.jobId);
        if (order === undefined) throw new Error();
        retainResponse(context, order, envelope.payload, authenticated);
        return Object.freeze({ disposition: "accepted" as const });
      } catch {
        return Object.freeze({
          disposition: "rejected" as const,
          reasonCode: "agreement-response-retention-failed",
        });
      }
    },
  };
  return Object.freeze(runtime);
}

export function createDacsSellerAgreementTransportRuntimeV1(
  options: Readonly<DacsSellerAgreementTransportRuntimeOptionsV1>,
): Readonly<DacsSellerAgreementTransportRuntimeV1> {
  if (!plainObject(options) || !plainObject(options.context) ||
      options.context.role !== "seller" || typeof options.admitProposal !== "function") {
    throw new TypeError("seller agreement transport runtime options are invalid");
  }
  const context = options.context;

  const validatePayload: DacsHttpPayloadValidatorV1 = (input) => payloadResult(
    input.type === "agreement-proposal" &&
      isFixedPriceAgreementProposalEnvelope(input.payload) &&
      input.sender === context.peerAuthority && input.audience === context.authority &&
      input.payload.transportIdentity.jobId === input.jobId &&
      input.payload.transportIdentity.buyer === context.peerAuthority &&
      input.payload.transportIdentity.seller === context.authority,
    "agreement-proposal-invalid",
  );

  const transport: SellerFixedPriceAgreementContributionTransport = {
    async publishSellerContribution(
      contribution: Readonly<FixedPriceAgreementSignatureContribution>,
      identity: Readonly<FixedPriceAgreementTransportIdentity>,
    ): Promise<FixedPriceAgreementEffectSubmission> {
      try {
        const order = await loadOrder(context, identity.jobId);
        const proposal = order === undefined ? undefined : loadProposalBinding(context, order);
        if (order === undefined || proposal === undefined ||
            canonicalize(proposal.payload.transportIdentity) !== canonicalize(identity)) {
          return {
            disposition: "rejected" as const,
            reason: "agreement-proposal-binding-missing",
          };
        }
        const binding = retainResponse(context, order, {
          responseVersion: "1",
          transportIdentity: identity,
          sellerContribution: contribution,
        });
        return sendResponse(context, binding);
      } catch {
        return { disposition: "rejected" as const, reason: "agreement-response-invalid" };
      }
    },
    async reconcileSellerContributionPublication(
      identity: Readonly<FixedPriceAgreementTransportIdentity>,
    ): Promise<FixedPriceAgreementResolution<unknown>> {
      try {
        const order = await loadOrder(context, identity.jobId);
        const binding = order === undefined ? undefined : loadResponseBinding(context, order);
        if (binding === undefined) {
          return { disposition: "absent", reason: "agreement-response-not-attempted" };
        }
        if (canonicalize(binding.payload.transportIdentity) !== canonicalize(identity)) {
          return { disposition: "rejected", reason: "agreement-response-identity-conflict" };
        }
        const sent = await sendResponse(context, binding);
        return sent.disposition === "submitted"
          ? { disposition: "present", value: binding.payload }
          : sent.disposition === "rejected"
            ? { disposition: "rejected", reason: sent.reason }
            : { disposition: "indeterminate", reason: sent.reason };
      } catch {
        return { disposition: "indeterminate", reason: "agreement-response-reconciliation-failed" };
      }
    },
  };
  Object.freeze(transport);

  const runtime: DacsSellerAgreementTransportRuntimeV1 = {
    transport,
    validatePayload,
    async resolveProposal(
      { operation }: Readonly<{ operation: Readonly<FixedPriceX402TrackOperationInput> }>,
    ) {
      if (operation.fence.role !== "seller" || operation.fence.track !== "agreement") {
        throw new DacsAgreementTransportRuntimeError("agreement-proposal-track-mismatch");
      }
      const order = await loadOrder(context, operation.order.jobId);
      const binding = order === undefined ? undefined : loadProposalBinding(context, order);
      if (binding === undefined) {
        throw new DacsAgreementTransportRuntimeError("agreement-proposal-pending");
      }
      return Object.freeze(structuredClone(binding.payload));
    },
    async handleMessage(
      authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
      inboundContext: Readonly<DacsLiveRoleInboundOperationContextV1>,
    ) {
      const envelope = authenticated.envelope;
      if (inboundContext.role !== "seller" || envelope.type !== "agreement-proposal") {
        return Object.freeze({
          disposition: "rejected" as const,
          reasonCode: "agreement-proposal-role-incompatible",
        });
      }
      const validation = await validatePayload({
        type: envelope.type,
        payload: envelope.payload,
        jobId: envelope.jobId,
        sender: envelope.sender,
        audience: envelope.audience,
      });
      if (validation.status !== "valid") {
        return Object.freeze({ disposition: "rejected" as const, reasonCode: validation.reasonCode });
      }
      try {
        const admitted = await options.admitProposal({
          authenticated,
          payload: envelope.payload,
        });
        if (!plainObject(admitted) || !plainObject(admitted.order) ||
            !plainObject(admitted.application) ||
            !identityMatchesOrder(envelope.payload.transportIdentity, admitted.order, "seller")) {
          throw new Error();
        }
        const retained = putDacsLiveOrderInputV1({
          database: context.database,
          order: admitted.order,
          application: admitted.application,
        });
        if (retained.status === "conflict") throw new Error();
        await inboundContext.coordinator.startOrder(admitted.order);
        const order = await loadOrder(context, admitted.order.jobId);
        if (order === undefined) throw new Error();
        retainProposal(context, order, envelope.payload, authenticated);
        return Object.freeze({ disposition: "accepted" as const });
      } catch {
        return Object.freeze({
          disposition: "rejected" as const,
          reasonCode: "agreement-proposal-admission-failed",
        });
      }
    },
  };
  return Object.freeze(runtime);
}
