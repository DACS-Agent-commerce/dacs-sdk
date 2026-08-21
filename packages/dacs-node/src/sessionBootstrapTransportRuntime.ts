import {
  fixedPriceX402OrderBindingHash,
  fixedPriceX402OrderLocalBindingHash,
  type FixedPriceX402OrderInput,
  type FixedPriceX402OrderRecord,
  type FixedPriceX402TrackOperationInput,
} from "@kynesyslabs/dacs/commerce";
import { compositeVerificationAddress } from "@kynesyslabs/dacs";
import { ARTIFACT_SEPARATORS } from "@kynesyslabs/dacs/artifacts";
import { canonicalize, contentHash, sha256Hex } from "@kynesyslabs/dacs/canonical";
import { ed25519Verify, publicKeyFromRaw, signedBytes } from "@kynesyslabs/dacs/crypto";
import {
  canonicalDemosAgentPublicKey,
  identityBundleHash,
  sameCanonicalClaimIdentity,
} from "@kynesyslabs/dacs/identity";

import {
  loadDacsLiveOrderInputForTrackV1,
  putDacsLiveOrderInputV1,
} from "./orderInput.js";
import type {
  DacsLiveRoleInboundOperationContextV1,
  DacsLiveRoleOperationContextV1,
} from "./roleRuntime.js";
import type {
  DacsSessionAdmissionPayloadV1,
  DacsSessionChallengePayloadV1,
  DacsSessionInitPayloadV1,
  DacsSessionPresentationPayloadV1,
  DacsHttpAuthenticatedEnvelopeV1,
  DacsHttpPayloadValidationV1,
  DacsHttpPayloadValidatorV1,
} from "./transport/envelope.js";
import {
  dacsHttpPayloadHashV1,
  validateDacsHttpSessionAdmissionPayloadV1,
  validateDacsHttpSessionChallengePayloadV1,
  validateDacsHttpSessionInitPayloadV1,
  validateDacsHttpSessionPresentationPayloadV1,
} from "./transport/envelope.js";
import type { DacsHttpInboundDispositionV1 } from "./transport/http.js";

const BINDING_VERSION = "1" as const;
const BINDING_DOMAIN = "dacs-live-session-bootstrap-binding:v1:" as const;
const HASH_RE = /^[0-9a-f]{64}$/;

type BootstrapKind = "init" | "challenge" | "presentation" | "admission";
type BootstrapPayload = DacsSessionInitPayloadV1 | DacsSessionChallengePayloadV1 |
  DacsSessionPresentationPayloadV1 | DacsSessionAdmissionPayloadV1;

interface BootstrapBindingV1 {
  bindingVersion: typeof BINDING_VERSION;
  localBindingHash: string;
  payloadHash: string;
  payload: Readonly<BootstrapPayload>;
  authentication?: Readonly<{
    envelopeId: string;
    authenticationHash: string;
    identityEvidenceHash: string;
    sender: string;
    audience: string;
  }>;
}

export interface DacsSellerSessionBootstrapAdmissionV1 {
  order: Readonly<FixedPriceX402OrderInput>;
  application: Readonly<Record<string, unknown>>;
}

export interface DacsSellerSessionBootstrapTransportOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  admitInit(input: Readonly<{
    authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>;
    payload: Readonly<DacsSessionInitPayloadV1>;
  }>): Promise<Readonly<DacsSellerSessionBootstrapAdmissionV1>> |
    Readonly<DacsSellerSessionBootstrapAdmissionV1>;
}

export interface DacsBuyerSessionBootstrapTransportRuntimeV1 {
  readonly validatePayload: DacsHttpPayloadValidatorV1;
  resolveInit(
    operation: Readonly<FixedPriceX402TrackOperationInput>,
  ): Readonly<DacsSessionInitPayloadV1> | undefined;
  publishInit(
    operation: Readonly<FixedPriceX402TrackOperationInput>,
    payload: Readonly<DacsSessionInitPayloadV1>,
  ): Promise<"acknowledged" | "pending" | "rejected">;
  resolveChallenge(
    operation: Readonly<FixedPriceX402TrackOperationInput>,
  ): Readonly<DacsSessionChallengePayloadV1> | undefined;
  publishPresentation(
    operation: Readonly<FixedPriceX402TrackOperationInput>,
    payload: Readonly<DacsSessionPresentationPayloadV1>,
  ): Promise<"acknowledged" | "pending" | "rejected">;
  resolvePresentation(
    operation: Readonly<FixedPriceX402TrackOperationInput>,
  ): Readonly<DacsSessionPresentationPayloadV1> | undefined;
  resolveAdmission(
    operation: Readonly<FixedPriceX402TrackOperationInput>,
  ): Readonly<DacsSessionAdmissionPayloadV1> | undefined;
  handleMessage(
    authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
    context: Readonly<DacsLiveRoleInboundOperationContextV1>,
  ): Promise<DacsHttpInboundDispositionV1>;
}

export interface DacsSellerSessionBootstrapTransportRuntimeV1 {
  readonly validatePayload: DacsHttpPayloadValidatorV1;
  resolveInit(
    operation: Readonly<FixedPriceX402TrackOperationInput>,
  ): Readonly<DacsSessionInitPayloadV1> | undefined;
  publishChallenge(
    operation: Readonly<FixedPriceX402TrackOperationInput>,
    payload: Readonly<DacsSessionChallengePayloadV1>,
  ): Promise<"acknowledged" | "pending" | "rejected">;
  resolveChallenge(
    operation: Readonly<FixedPriceX402TrackOperationInput>,
  ): Readonly<DacsSessionChallengePayloadV1> | undefined;
  resolvePresentation(
    operation: Readonly<FixedPriceX402TrackOperationInput>,
  ): Readonly<DacsSessionPresentationPayloadV1> | undefined;
  publishAdmission(
    operation: Readonly<FixedPriceX402TrackOperationInput>,
    payload: Readonly<DacsSessionAdmissionPayloadV1>,
  ): Promise<"acknowledged" | "pending" | "rejected">;
  resolveAdmission(
    operation: Readonly<FixedPriceX402TrackOperationInput>,
  ): Readonly<DacsSessionAdmissionPayloadV1> | undefined;
  handleMessage(
    authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
    context: Readonly<DacsLiveRoleInboundOperationContextV1>,
  ): Promise<DacsHttpInboundDispositionV1>;
}

export class DacsSessionBootstrapTransportError extends Error {
  override readonly name = "DacsSessionBootstrapTransportError";

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

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === required.length &&
    required.every((key) => Object.hasOwn(value, key));
}

function bindingId(role: "buyer" | "seller", kind: BootstrapKind, jobId: string): string {
  return sha256Hex(`${BINDING_DOMAIN}${canonicalize({ role, kind, jobId })}`);
}

function orderLocalBindingHash(
  order: Readonly<FixedPriceX402OrderInput | FixedPriceX402OrderRecord>,
): string {
  return "localBindingHash" in order
    ? order.localBindingHash
    : fixedPriceX402OrderLocalBindingHash(order);
}

function loadOrder(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  jobId: string,
): Promise<Readonly<FixedPriceX402OrderRecord> | undefined> {
  return context.database.createLiveCoordinatorStore(context.role)
    .load(context.role, jobId).then((loaded) => {
      if (loaded.status === "missing") return undefined;
      if (loaded.status !== "ok") {
        throw new DacsSessionBootstrapTransportError("session-order-state-invalid");
      }
      return loaded.record;
    });
}

function operationBound(
  operation: Readonly<FixedPriceX402TrackOperationInput>,
  role: "buyer" | "seller",
): boolean {
  return operation.fence.role === role && operation.fence.track === "agreement" &&
    operation.order.role === role && operation.order.jobId === operation.fence.jobId &&
    operation.order.bindingHash === operation.fence.bindingHash &&
    operation.order.localBindingHash === operation.fence.localBindingHash;
}

function captureBinding(value: unknown): Readonly<BootstrapBindingV1> {
  if (!plainObject(value) || !exactKeys(value, value.authentication === undefined
      ? ["bindingVersion", "localBindingHash", "payloadHash", "payload"]
      : ["bindingVersion", "localBindingHash", "payloadHash", "payload", "authentication"]) ||
      value.bindingVersion !== BINDING_VERSION ||
      typeof value.localBindingHash !== "string" || !HASH_RE.test(value.localBindingHash) ||
      typeof value.payloadHash !== "string" || !HASH_RE.test(value.payloadHash) ||
      !plainObject(value.payload) || dacsHttpPayloadHashV1(value.payload) !== value.payloadHash ||
      (value.authentication !== undefined && (!plainObject(value.authentication) ||
        !exactKeys(value.authentication, [
          "envelopeId", "authenticationHash", "identityEvidenceHash", "sender", "audience",
        ]) ||
        !["envelopeId", "authenticationHash", "identityEvidenceHash"].every((key) =>
          typeof (value.authentication as Record<string, unknown>)[key] === "string" &&
          HASH_RE.test((value.authentication as Record<string, unknown>)[key] as string)) ||
        typeof value.authentication.sender !== "string" ||
        typeof value.authentication.audience !== "string"))) {
    throw new DacsSessionBootstrapTransportError("session-bootstrap-binding-corrupt");
  }
  return value as unknown as Readonly<BootstrapBindingV1>;
}

function retain(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  order: Readonly<FixedPriceX402OrderInput | FixedPriceX402OrderRecord>,
  kind: BootstrapKind,
  payload: Readonly<BootstrapPayload>,
  authenticated?: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
): Readonly<{ status: "created" | "existing"; binding: Readonly<BootstrapBindingV1> }> {
  const id = bindingId(context.role, kind, order.jobId);
  const payloadHash = dacsHttpPayloadHashV1(payload);
  const binding: BootstrapBindingV1 = {
    bindingVersion: BINDING_VERSION,
    localBindingHash: orderLocalBindingHash(order),
    payloadHash,
    payload,
    ...(authenticated === undefined ? {} : {
      authentication: {
        envelopeId: authenticated.envelope.envelopeId,
        authenticationHash: authenticated.authenticationHash,
        identityEvidenceHash: authenticated.identityEvidenceHash,
        sender: authenticated.envelope.sender,
        audience: authenticated.envelope.audience,
      },
    }),
  };
  const existing = context.database.loadEffectInput("session", id);
  if (existing !== undefined) {
    const captured = captureBinding(existing);
    if (captured.localBindingHash !== binding.localBindingHash ||
        captured.payloadHash !== payloadHash ||
        canonicalize(captured.payload) !== canonicalize(payload) ||
        canonicalize(captured.authentication ?? null) !==
          canonicalize(binding.authentication ?? null)) {
      throw new DacsSessionBootstrapTransportError("session-bootstrap-binding-conflict");
    }
    return Object.freeze({ status: "existing", binding: captured });
  }
  const result = context.database.putEffectIntent({
    kind: "session",
    effectId: id,
    bindingHash: binding.localBindingHash,
    input: binding,
    idempotencyKey: id,
    jobId: order.jobId,
  });
  if (result.status === "conflict") {
    throw new DacsSessionBootstrapTransportError("session-bootstrap-binding-conflict");
  }
  return Object.freeze({
    status: result.status,
    binding: captureBinding(context.database.loadEffectInput("session", id)),
  });
}

function resolvePayload<T extends BootstrapPayload>(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  operation: Readonly<FixedPriceX402TrackOperationInput>,
  kind: BootstrapKind,
  validate: (value: unknown) => value is T,
): Readonly<T> | undefined {
  if (!operationBound(operation, context.role)) {
    throw new DacsSessionBootstrapTransportError("session-operation-binding-mismatch");
  }
  const value = context.database.loadEffectInput(
    "session",
    bindingId(context.role, kind, operation.order.jobId),
  );
  if (value === undefined) return undefined;
  const binding = captureBinding(value);
  if (binding.localBindingHash !== operation.order.localBindingHash ||
      !validate(binding.payload)) {
    throw new DacsSessionBootstrapTransportError("session-bootstrap-binding-corrupt");
  }
  return Object.freeze(structuredClone(binding.payload));
}

function payloadValidation(
  role: "buyer" | "seller",
  input: Parameters<DacsHttpPayloadValidatorV1>[0],
): DacsHttpPayloadValidationV1 {
  const valid = role === "buyer"
    ? input.type === "session-challenge"
      ? validateDacsHttpSessionChallengePayloadV1(input.payload)
      : input.type === "session-admission" &&
        validateDacsHttpSessionAdmissionPayloadV1(input.payload)
    : input.type === "session-init"
      ? validateDacsHttpSessionInitPayloadV1(input.payload)
      : input.type === "session-presentation" &&
        validateDacsHttpSessionPresentationPayloadV1(input.payload);
  return valid
    ? Object.freeze({ status: "valid" as const })
    : Object.freeze({ status: "invalid" as const,
        reasonCode: "session-bootstrap-payload-invalid" });
}

function acknowledgement(
  value: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
): "acknowledged" | "pending" | "rejected" {
  if (value.envelope.type !== "acknowledgement") return "rejected";
  return value.envelope.payload.disposition === "rejected"
    ? "rejected" : "acknowledged";
}

function reserveChallenge(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  order: Readonly<FixedPriceX402OrderInput | FixedPriceX402OrderRecord>,
  challenge: string,
): void {
  const localBindingHash = orderLocalBindingHash(order);
  const reserved = context.database.reserveIdentity({
    kind: "session",
    identity: `session-nonce:${challenge}`,
    bindingHash: localBindingHash,
    payloadHash: sha256Hex(challenge),
    jobId: order.jobId,
  });
  if (reserved.status === "conflict") {
    throw new DacsSessionBootstrapTransportError("session-challenge-reused");
  }
}

function signatureBytes(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(value)) return undefined;
  try {
    const decoded = Uint8Array.from(Buffer.from(value, "base64url"));
    return decoded.byteLength === 64 && Buffer.from(decoded).toString("base64url") === value
      ? decoded : undefined;
  } catch {
    return undefined;
  }
}

async function sessionIdentityValid(
  value: DacsSessionChallengePayloadV1["sellerIdentity"] |
    DacsSessionPresentationPayloadV1["buyerIdentity"],
  authority: string,
  challenge: string,
  partyRole: "buyer" | "seller",
  network: string,
): Promise<boolean> {
  const key = canonicalDemosAgentPublicKey(authority);
  if (key === null || value.sessionNonce !== challenge ||
      !sameCanonicalClaimIdentity(value.presentedBy, authority) ||
      value.claims.length !== (partyRole === "buyer" ? 2 : 1) ||
      !sameCanonicalClaimIdentity(value.claims[0]?.ref, authority) ||
      value.presentation.kind !== "per-claim" ||
      value.presentation.signatures.length !== value.claims.length ||
      !sameCanonicalClaimIdentity(value.presentation.signatures[0]?.ref, authority)) return false;
  const signature = signatureBytes(value.presentation.signatures[0]?.signature);
  const bytes = signedBytes("dacs-bundle-presentation:v1:", identityBundleHash(value));
  if (signature === undefined || !ed25519Verify(
    bytes,
    signature,
    publicKeyFromRaw(key),
  )) return false;
  if (partyRole === "seller") return true;
  const chain = /^eip155:([1-9][0-9]*)$/.exec(network)?.[1];
  const claim = value.claims[1]?.ref;
  const proof = value.presentation.signatures[1];
  const match = typeof claim === "string"
    ? /^cci-xm:evm:([1-9][0-9]*):(0x[0-9a-fA-F]{40})$/.exec(claim)
    : null;
  if (chain === undefined || match === null || match[1] !== chain ||
      proof === undefined || proof.ref !== claim ||
      !/^0x[0-9a-fA-F]{130}$/.test(proof.signature)) return false;
  try {
    const { verifyMessage } = await import("viem");
    return await verifyMessage({
      address: match[2] as `0x${string}`,
      message: { raw: bytes },
      signature: proof.signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}

function vetSignatureValid(
  admission: Readonly<DacsSessionAdmissionPayloadV1>,
  authority: string,
): boolean {
  const key = canonicalDemosAgentPublicKey(authority);
  const record = admission.buyerVetRecord;
  const signature = signatureBytes(record.signature.value);
  if (key === null || signature === undefined || record.signature.algorithm !== "ed25519" ||
      !sameCanonicalClaimIdentity(record.signature.signer, authority)) return false;
  const { signature: _signature, ...unsigned } = record;
  return ed25519Verify(
    signedBytes(ARTIFACT_SEPARATORS.CompositeVerificationRecord, contentHash(unsigned)),
    signature,
    publicKeyFromRaw(key),
  );
}

async function outboundSemantics(
  kind: BootstrapKind,
  payload: Readonly<BootstrapPayload>,
  context: Readonly<DacsLiveRoleOperationContextV1>,
  operation: Readonly<FixedPriceX402TrackOperationInput>,
): Promise<void> {
  const order = operation.order;
  if (kind === "init") {
    const init = payload as DacsSessionInitPayloadV1;
    const retained = loadDacsLiveOrderInputForTrackV1(operation, context.database);
    if (!validateDacsHttpSessionInitPayloadV1(init) ||
        fixedPriceX402OrderBindingHash(init.order) !== order.bindingHash ||
        fixedPriceX402OrderLocalBindingHash(init.order) !== order.localBindingHash ||
        canonicalize(init.application) !== canonicalize(retained.application)) {
      throw new DacsSessionBootstrapTransportError("session-init-binding-mismatch");
    }
    reserveChallenge(context, order, init.sellerChallenge);
    return;
  }
  if (kind === "challenge") {
    const challenge = payload as DacsSessionChallengePayloadV1;
    const init = resolvePayload(context, operation, "init", validateDacsHttpSessionInitPayloadV1);
    if (init === undefined || !validateDacsHttpSessionChallengePayloadV1(challenge) ||
        challenge.initPayloadHash !== dacsHttpPayloadHashV1(init) ||
        challenge.sellerChallenge !== init.sellerChallenge ||
        !await sessionIdentityValid(challenge.sellerIdentity, order.seller,
          challenge.sellerChallenge, "seller", order.protocol.rail.network)) {
      throw new DacsSessionBootstrapTransportError("session-challenge-binding-mismatch");
    }
    reserveChallenge(context, order, challenge.buyerChallenge);
    return;
  }
  if (kind === "presentation") {
    const presentation = payload as DacsSessionPresentationPayloadV1;
    const challenge = resolvePayload(context, operation, "challenge",
      validateDacsHttpSessionChallengePayloadV1);
    if (challenge === undefined || !validateDacsHttpSessionPresentationPayloadV1(presentation) ||
        presentation.challengePayloadHash !== dacsHttpPayloadHashV1(challenge) ||
        presentation.buyerChallenge !== challenge.buyerChallenge ||
        !await sessionIdentityValid(presentation.buyerIdentity, order.buyer,
          presentation.buyerChallenge, "buyer", order.protocol.rail.network)) {
      throw new DacsSessionBootstrapTransportError("session-presentation-binding-mismatch");
    }
    return;
  }
  const admission = payload as DacsSessionAdmissionPayloadV1;
  const presentation = resolvePayload(context, operation, "presentation",
    validateDacsHttpSessionPresentationPayloadV1);
  const challenge = resolvePayload(context, operation, "challenge",
    validateDacsHttpSessionChallengePayloadV1);
  if (presentation === undefined || challenge === undefined ||
      !validateDacsHttpSessionAdmissionPayloadV1(admission) ||
      admission.presentationPayloadHash !== dacsHttpPayloadHashV1(presentation) ||
      admission.buyerIdentityHash !== identityBundleHash(presentation.buyerIdentity) ||
      admission.sellerIdentityHash !== identityBundleHash(challenge.sellerIdentity) ||
      admission.buyerVetRecord.jobId !== order.jobId ||
      !sameCanonicalClaimIdentity(admission.buyerVetRecord.evaluatedParty, order.buyer) ||
      admission.buyerVetRecord.bundleHash !== admission.buyerIdentityHash ||
      admission.buyerVetRecord.overallDecision !== "pass" ||
      admission.buyerVetRef.contentHash !== contentHash(
        admission.buyerVetRecord as unknown as Record<string, unknown>) ||
      admission.buyerVetRef.anchor.kind !== "storage-program" ||
      admission.buyerVetRef.anchor.locator !==
        compositeVerificationAddress(order.jobId, order.buyer) ||
      !sameCanonicalClaimIdentity(admission.buyerVetRef.signer, order.seller) ||
      admission.buyerVetReceipt.logicalAddress !== admission.buyerVetRef.anchor.locator ||
      admission.buyerVetReceipt.contentHash !== admission.buyerVetRef.contentHash ||
      !sameCanonicalClaimIdentity(admission.buyerVetReceipt.writer, order.seller) ||
      !vetSignatureValid(admission, order.seller)) {
    throw new DacsSessionBootstrapTransportError("session-admission-binding-mismatch");
  }
}

async function publish(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  operation: Readonly<FixedPriceX402TrackOperationInput>,
  kind: BootstrapKind,
  type: "session-init" | "session-challenge" | "session-presentation" | "session-admission",
  payload: Readonly<BootstrapPayload>,
): Promise<"acknowledged" | "pending" | "rejected"> {
  if (!operationBound(operation, context.role)) {
    throw new DacsSessionBootstrapTransportError("session-operation-binding-mismatch");
  }
  await outboundSemantics(kind, payload, context, operation);
  retain(context, operation.order, kind, payload);
  await operation.fence.assertCurrent();
  try {
    return acknowledgement(await context.sendMessage({
      type,
      jobId: operation.order.jobId,
      payload: payload as never,
      idempotencyKey: `${operation.fence.idempotencyKey}:session-${kind}`,
    }));
  } catch {
    return "pending";
  }
}

export function createDacsBuyerSessionBootstrapTransportRuntimeV1(
  context: Readonly<DacsLiveRoleOperationContextV1>,
): Readonly<DacsBuyerSessionBootstrapTransportRuntimeV1> {
  if (!plainObject(context) || context.role !== "buyer") {
    throw new TypeError("buyer session bootstrap context is invalid");
  }
  const runtime: DacsBuyerSessionBootstrapTransportRuntimeV1 = {
    validatePayload: (input: Parameters<DacsHttpPayloadValidatorV1>[0]) =>
      payloadValidation("buyer", input),
    resolveInit: (operation: Readonly<FixedPriceX402TrackOperationInput>) =>
      resolvePayload(context, operation, "init", validateDacsHttpSessionInitPayloadV1),
    publishInit: (operation: Readonly<FixedPriceX402TrackOperationInput>,
      payload: Readonly<DacsSessionInitPayloadV1>) =>
      publish(context, operation, "init", "session-init", payload),
    resolveChallenge: (operation: Readonly<FixedPriceX402TrackOperationInput>) =>
      resolvePayload(context, operation, "challenge",
      validateDacsHttpSessionChallengePayloadV1),
    publishPresentation: (operation: Readonly<FixedPriceX402TrackOperationInput>,
      payload: Readonly<DacsSessionPresentationPayloadV1>) =>
      publish(context, operation, "presentation",
      "session-presentation", payload),
    resolvePresentation: (operation: Readonly<FixedPriceX402TrackOperationInput>) =>
      resolvePayload(context, operation, "presentation",
      validateDacsHttpSessionPresentationPayloadV1),
    resolveAdmission: (operation: Readonly<FixedPriceX402TrackOperationInput>) =>
      resolvePayload(context, operation, "admission",
      validateDacsHttpSessionAdmissionPayloadV1),
    async handleMessage(authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
      inbound: Readonly<DacsLiveRoleInboundOperationContextV1>) {
      if (authenticated.envelope.type !== "session-challenge" &&
          authenticated.envelope.type !== "session-admission") {
        return Object.freeze({ disposition: "rejected" as const,
          reasonCode: "session-message-role-incompatible" });
      }
      const order = await loadOrder(context, authenticated.envelope.jobId);
      if (order === undefined || order.role !== "buyer" || inbound.role !== "buyer" ||
          authenticated.envelope.sender !== order.seller ||
          authenticated.envelope.audience !== order.buyer) {
        return Object.freeze({ disposition: "rejected" as const,
          reasonCode: "session-message-order-mismatch" });
      }
      const kind = authenticated.envelope.type === "session-challenge"
        ? "challenge" : "admission";
      const operation = Object.freeze({ order, fence: Object.freeze({
        role: "buyer" as const, track: "agreement" as const, jobId: order.jobId,
        bindingHash: order.bindingHash, localBindingHash: order.localBindingHash,
      }) }) as unknown as FixedPriceX402TrackOperationInput;
      try {
        await outboundSemantics(kind, authenticated.envelope.payload, context, operation);
        const retained = retain(context, order, kind, authenticated.envelope.payload,
          authenticated);
        return Object.freeze({ disposition: "accepted" as const });
      } catch {
        return Object.freeze({ disposition: "rejected" as const,
          reasonCode: "session-message-binding-invalid" });
      }
    },
  };
  return Object.freeze(runtime);
}

export function createDacsSellerSessionBootstrapTransportRuntimeV1(
  options: Readonly<DacsSellerSessionBootstrapTransportOptionsV1>,
): Readonly<DacsSellerSessionBootstrapTransportRuntimeV1> {
  if (!plainObject(options) || !plainObject(options.context) ||
      options.context.role !== "seller" || typeof options.admitInit !== "function") {
    throw new TypeError("seller session bootstrap options are invalid");
  }
  const context = options.context;
  const runtime: DacsSellerSessionBootstrapTransportRuntimeV1 = {
    validatePayload: (input: Parameters<DacsHttpPayloadValidatorV1>[0]) =>
      payloadValidation("seller", input),
    resolveInit: (operation: Readonly<FixedPriceX402TrackOperationInput>) =>
      resolvePayload(context, operation, "init",
      validateDacsHttpSessionInitPayloadV1),
    publishChallenge: (operation: Readonly<FixedPriceX402TrackOperationInput>,
      payload: Readonly<DacsSessionChallengePayloadV1>) =>
      publish(context, operation, "challenge",
      "session-challenge", payload),
    resolveChallenge: (operation: Readonly<FixedPriceX402TrackOperationInput>) =>
      resolvePayload(context, operation, "challenge",
      validateDacsHttpSessionChallengePayloadV1),
    resolvePresentation: (operation: Readonly<FixedPriceX402TrackOperationInput>) =>
      resolvePayload(context, operation, "presentation",
      validateDacsHttpSessionPresentationPayloadV1),
    publishAdmission: (operation: Readonly<FixedPriceX402TrackOperationInput>,
      payload: Readonly<DacsSessionAdmissionPayloadV1>) =>
      publish(context, operation, "admission",
      "session-admission", payload),
    resolveAdmission: (operation: Readonly<FixedPriceX402TrackOperationInput>) =>
      resolvePayload(context, operation, "admission",
      validateDacsHttpSessionAdmissionPayloadV1),
    async handleMessage(authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
      inbound: Readonly<DacsLiveRoleInboundOperationContextV1>) {
      if (authenticated.envelope.type === "session-init") {
        if (inbound.role !== "seller" ||
            !validateDacsHttpSessionInitPayloadV1(authenticated.envelope.payload) ||
            authenticated.envelope.jobId !== authenticated.envelope.payload.order.jobId ||
            authenticated.envelope.payload.order.sdkJobs.role !== "buyer" ||
            authenticated.envelope.sender !== authenticated.envelope.payload.order.buyer ||
            authenticated.envelope.audience !== authenticated.envelope.payload.order.seller) {
          return Object.freeze({ disposition: "rejected" as const,
            reasonCode: "session-init-envelope-invalid" });
        }
        let admission: Readonly<DacsSellerSessionBootstrapAdmissionV1>;
        try {
          admission = await options.admitInit({
            authenticated,
            payload: authenticated.envelope.payload,
          });
        } catch {
          return Object.freeze({ disposition: "rejected" as const,
            reasonCode: "session-init-not-admitted" });
        }
        const input = authenticated.envelope.payload;
        if (!plainObject(admission) || !plainObject(admission.order) ||
            !plainObject(admission.application) || admission.order.sdkJobs.role !== "seller" ||
            admission.order.jobId !== authenticated.envelope.jobId ||
            fixedPriceX402OrderBindingHash(admission.order) !==
              fixedPriceX402OrderBindingHash(input.order) ||
            canonicalize(admission.application) !== canonicalize(input.application) ||
            authenticated.envelope.sender !== admission.order.buyer ||
            authenticated.envelope.audience !== admission.order.seller) {
          return Object.freeze({ disposition: "rejected" as const,
            reasonCode: "session-init-admission-invalid" });
        }
        try {
          const stored = putDacsLiveOrderInputV1({
            database: context.database,
            order: admission.order,
            application: admission.application,
          });
          if (stored.status === "conflict") throw new Error();
          reserveChallenge(context, admission.order, input.sellerChallenge);
          retain(context, admission.order, "init", input, authenticated);
          await inbound.coordinator.startOrder(admission.order);
          return Object.freeze({ disposition: "accepted" as const });
        } catch {
          return Object.freeze({ disposition: "rejected" as const,
            reasonCode: "session-init-retention-failed" });
        }
      }
      if (authenticated.envelope.type !== "session-presentation") {
        return Object.freeze({ disposition: "rejected" as const,
          reasonCode: "session-message-role-incompatible" });
      }
      const order = await loadOrder(context, authenticated.envelope.jobId);
      if (order === undefined || order.role !== "seller" || inbound.role !== "seller" ||
          authenticated.envelope.sender !== order.buyer ||
          authenticated.envelope.audience !== order.seller) {
        return Object.freeze({ disposition: "rejected" as const,
          reasonCode: "session-message-order-mismatch" });
      }
      const operation = Object.freeze({ order, fence: Object.freeze({
        role: "seller" as const, track: "agreement" as const, jobId: order.jobId,
        bindingHash: order.bindingHash, localBindingHash: order.localBindingHash,
      }) }) as unknown as FixedPriceX402TrackOperationInput;
      try {
        await outboundSemantics("presentation", authenticated.envelope.payload, context, operation);
        const retained = retain(context, order, "presentation",
          authenticated.envelope.payload, authenticated);
        return Object.freeze({ disposition: "accepted" as const });
      } catch {
        return Object.freeze({ disposition: "rejected" as const,
          reasonCode: "session-message-binding-invalid" });
      }
    },
  };
  return Object.freeze(runtime);
}
