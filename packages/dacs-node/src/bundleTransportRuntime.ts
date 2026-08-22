import type { BundleSignature } from "@kynesyslabs/dacs/artifacts";
import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import {
  ed25519Verify,
  publicKeyFromRaw,
} from "@kynesyslabs/dacs/crypto";
import { canonicalDemosAgentPublicKey } from "@kynesyslabs/dacs/identity";
import type {
  BuyerBundleEffectFence,
  BuyerBundleTransport,
  BuyerBundleTransportIdentity,
  CompletedSellerBundleCounterSignatureRequest,
  SellerBundleFinalizationReadProvider,
  VerifyCompletedSellerBundleCounterSignatureRequestInput,
} from "@kynesyslabs/dacs";
import { verifyCompletedSellerBundleCounterSignatureRequest } from
  "@kynesyslabs/dacs/seller";

import type {
  DacsLiveRoleInboundOperationContextV1,
  DacsLiveRoleOperationContextV1,
} from "./roleRuntime.js";
import type { DacsLiveRoleSendInputV1 } from "./service.js";
import type {
  DacsBundleSignatureRequestV1,
  DacsHttpAuthenticatedEnvelopeV1,
  DacsHttpPayloadValidationV1,
  DacsHttpPayloadValidatorV1,
} from "./transport/envelope.js";
import type { DacsHttpInboundDispositionV1 } from "./transport/http.js";

const BUNDLE_REQUEST_BINDING_VERSION = "1" as const;
const BUNDLE_SIGNATURE_BINDING_VERSION = "1" as const;
const BUNDLE_TRANSPORT_ID_DOMAIN = "dacs-live-bundle-transport:v1:" as const;
const HASH_RE = /^[0-9a-f]{64}$/;

interface DacsBundleRequestBindingV1 {
  bindingVersion: typeof BUNDLE_REQUEST_BINDING_VERSION;
  localBindingHash: string;
  requestHash: string;
  payload: Readonly<DacsBundleSignatureRequestV1>;
  authenticationHash?: string;
  identityEvidenceHash?: string;
}

interface DacsBundleSignatureBindingV1 {
  bindingVersion: typeof BUNDLE_SIGNATURE_BINDING_VERSION;
  localBindingHash: string;
  requestHash: string;
  signatureHash: string;
  signature: Readonly<BundleSignature>;
  authenticationHash?: string;
  identityEvidenceHash?: string;
}

export interface DacsBuyerBundleRequestVerificationV1 {
  input: Readonly<VerifyCompletedSellerBundleCounterSignatureRequestInput>;
  provider: Readonly<SellerBundleFinalizationReadProvider>;
}

export interface DacsBuyerBundleTransportRuntimeOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  resolveVerification(input: Readonly<{
    authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>;
    request: Readonly<CompletedSellerBundleCounterSignatureRequest>;
  }>): Promise<Readonly<DacsBuyerBundleRequestVerificationV1>> |
    Readonly<DacsBuyerBundleRequestVerificationV1>;
  resolveSellerFinalization: BuyerBundleTransport["resolveSellerFinalization"];
}

export interface DacsBuyerBundleTransportRuntimeV1 {
  readonly transport: Readonly<BuyerBundleTransport>;
  readonly validatePayload: DacsHttpPayloadValidatorV1;
  handleMessage(
    authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
    context: Readonly<DacsLiveRoleInboundOperationContextV1>,
  ): Promise<DacsHttpInboundDispositionV1>;
}

export interface DacsSellerBundleTransportRuntimeV1 {
  readonly validatePayload: DacsHttpPayloadValidatorV1;
  publishRequest(input: Readonly<{
    jobId: string;
    request: Readonly<CompletedSellerBundleCounterSignatureRequest>;
  }>): Promise<Readonly<{ status: "acknowledged" | "pending" | "rejected"; requestHash: string }>>;
  resolveCounterSignatures(jobId: string): Promise<readonly Readonly<BundleSignature>[]>;
  handleMessage(
    authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
    context: Readonly<DacsLiveRoleInboundOperationContextV1>,
  ): Promise<DacsHttpInboundDispositionV1>;
}

export class DacsBundleTransportRuntimeError extends Error {
  override readonly name = "DacsBundleTransportRuntimeError";

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

function canonicalBase64Url(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 ||
      !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  return Buffer.from(value, "base64url").toString("base64url") === value;
}

function bundleSignature(value: unknown): value is Readonly<BundleSignature> {
  return plainObject(value) && exactFields(value, ["party", "algorithm", "value"]) &&
    typeof value.party === "string" && value.party.length > 0 &&
    value.algorithm === "ed25519" && canonicalBase64Url(value.value) &&
    Buffer.from(value.value, "base64url").byteLength === 64;
}

function bundleRequestPayload(value: unknown): value is Readonly<DacsBundleSignatureRequestV1> {
  if (!plainObject(value) || !exactFields(value, [
    "bundleContentHash", "signedScope", "signedBytes", "requiredCounterSigners",
  ]) || typeof value.bundleContentHash !== "string" ||
      !HASH_RE.test(value.bundleContentHash) || !plainObject(value.signedScope) ||
      !canonicalBase64Url(value.signedBytes) || !Array.isArray(value.requiredCounterSigners) ||
      value.requiredCounterSigners.length === 0 ||
      value.requiredCounterSigners.some((entry) =>
        typeof entry !== "string" || entry.length === 0)) return false;
  return new Set(value.requiredCounterSigners).size === value.requiredCounterSigners.length;
}

function requestFromPayload(
  payload: Readonly<DacsBundleSignatureRequestV1>,
): Readonly<CompletedSellerBundleCounterSignatureRequest> {
  return Object.freeze({
    bundleContentHash: payload.bundleContentHash,
    signedScope: structuredClone(payload.signedScope),
    signedBytes: Uint8Array.from(Buffer.from(payload.signedBytes, "base64url")),
    requiredCounterSigners: [...payload.requiredCounterSigners],
  });
}

function payloadFromRequest(
  request: Readonly<CompletedSellerBundleCounterSignatureRequest>,
): Readonly<DacsBundleSignatureRequestV1> {
  const payload: DacsBundleSignatureRequestV1 = {
    bundleContentHash: request.bundleContentHash,
    signedScope: structuredClone(request.signedScope),
    signedBytes: Buffer.from(request.signedBytes).toString("base64url"),
    requiredCounterSigners: Object.freeze([...request.requiredCounterSigners]),
  };
  if (!bundleRequestPayload(payload)) {
    throw new DacsBundleTransportRuntimeError("bundle-signature-request-invalid");
  }
  return Object.freeze(payload);
}

function transportId(role: "buyer" | "seller", kind: "request" | "signature", jobId: string): string {
  return sha256Hex(`${BUNDLE_TRANSPORT_ID_DOMAIN}${canonicalize({ role, kind, jobId })}`);
}

async function loadOrder(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  jobId: string,
) {
  const loaded = await context.database.createLiveCoordinatorStore(context.role)
    .load(context.role, jobId);
  if (loaded.status !== "ok") {
    throw new DacsBundleTransportRuntimeError("bundle-transport-order-state-invalid");
  }
  return loaded.record;
}

function captureRequestBinding(value: unknown): Readonly<DacsBundleRequestBindingV1> {
  if (!plainObject(value) || !exactFields(value, [
    "bindingVersion", "localBindingHash", "requestHash", "payload",
  ], ["authenticationHash", "identityEvidenceHash"]) ||
      value.bindingVersion !== BUNDLE_REQUEST_BINDING_VERSION ||
      typeof value.localBindingHash !== "string" || !HASH_RE.test(value.localBindingHash) ||
      typeof value.requestHash !== "string" || !HASH_RE.test(value.requestHash) ||
      !bundleRequestPayload(value.payload) ||
      sha256Hex(canonicalize(value.payload)) !== value.requestHash ||
      (value.authenticationHash !== undefined &&
        (typeof value.authenticationHash !== "string" || !HASH_RE.test(value.authenticationHash))) ||
      (value.identityEvidenceHash !== undefined &&
        (typeof value.identityEvidenceHash !== "string" ||
          !HASH_RE.test(value.identityEvidenceHash)))) {
    throw new DacsBundleTransportRuntimeError("bundle-signature-request-binding-corrupt");
  }
  return value as unknown as Readonly<DacsBundleRequestBindingV1>;
}

function captureSignatureBinding(value: unknown): Readonly<DacsBundleSignatureBindingV1> {
  if (!plainObject(value) || !exactFields(value, [
    "bindingVersion", "localBindingHash", "requestHash", "signatureHash", "signature",
  ], ["authenticationHash", "identityEvidenceHash"]) ||
      value.bindingVersion !== BUNDLE_SIGNATURE_BINDING_VERSION ||
      typeof value.localBindingHash !== "string" || !HASH_RE.test(value.localBindingHash) ||
      typeof value.requestHash !== "string" || !HASH_RE.test(value.requestHash) ||
      typeof value.signatureHash !== "string" || !HASH_RE.test(value.signatureHash) ||
      !bundleSignature(value.signature) ||
      sha256Hex(canonicalize(value.signature)) !== value.signatureHash ||
      (value.authenticationHash !== undefined &&
        (typeof value.authenticationHash !== "string" || !HASH_RE.test(value.authenticationHash))) ||
      (value.identityEvidenceHash !== undefined &&
        (typeof value.identityEvidenceHash !== "string" ||
          !HASH_RE.test(value.identityEvidenceHash)))) {
    throw new DacsBundleTransportRuntimeError("bundle-signature-binding-corrupt");
  }
  return value as unknown as Readonly<DacsBundleSignatureBindingV1>;
}

async function putRequest(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  jobId: string,
  payload: Readonly<DacsBundleSignatureRequestV1>,
  authentication?: Readonly<{ authenticationHash: string; identityEvidenceHash: string }>,
): Promise<Readonly<DacsBundleRequestBindingV1>> {
  const order = await loadOrder(context, jobId);
  const id = transportId(context.role, "request", jobId);
  const requestHash = sha256Hex(canonicalize(payload));
  const existing = context.database.loadEffectInput("session", id);
  if (existing !== undefined) {
    const captured = captureRequestBinding(existing);
    if (captured.localBindingHash !== order.localBindingHash ||
        captured.requestHash !== requestHash ||
        canonicalize(captured.payload) !== canonicalize(payload)) {
      throw new DacsBundleTransportRuntimeError("bundle-signature-request-conflict");
    }
    return captured;
  }
  const binding: DacsBundleRequestBindingV1 = {
    bindingVersion: BUNDLE_REQUEST_BINDING_VERSION,
    localBindingHash: order.localBindingHash,
    requestHash,
    payload,
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
    throw new DacsBundleTransportRuntimeError("bundle-signature-request-conflict");
  }
  return captureRequestBinding(context.database.loadEffectInput("session", id));
}

async function loadRequest(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  jobId: string,
): Promise<Readonly<DacsBundleRequestBindingV1> | undefined> {
  const order = await loadOrder(context, jobId);
  const value = context.database.loadEffectInput(
    "session",
    transportId(context.role, "request", jobId),
  );
  if (value === undefined) return undefined;
  const binding = captureRequestBinding(value);
  if (binding.localBindingHash !== order.localBindingHash) {
    throw new DacsBundleTransportRuntimeError("bundle-signature-request-binding-corrupt");
  }
  return binding;
}

/**
 * Recover the exact seller review request retained after authenticated HTTP
 * admission. Buyer audit recovery uses this data-only view; it carries no
 * signing or publication authority.
 */
export async function loadDacsBuyerBundleSignatureRequestForOrderV1(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  order: Readonly<{ jobId: string; buyer: string; seller: string; localBindingHash: string }>,
): Promise<Readonly<CompletedSellerBundleCounterSignatureRequest> | undefined> {
  if (context.role !== "buyer" || order.buyer !== context.authority ||
      order.seller !== context.peerAuthority) {
    throw new DacsBundleTransportRuntimeError("bundle-request-order-mismatch");
  }
  const binding = await loadRequest(context, order.jobId);
  if (binding === undefined) return undefined;
  if (binding.localBindingHash !== order.localBindingHash) {
    throw new DacsBundleTransportRuntimeError("bundle-request-binding-corrupt");
  }
  return requestFromPayload(binding.payload);
}

async function putSignature(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  jobId: string,
  requestHash: string,
  signature: Readonly<BundleSignature>,
  authentication?: Readonly<{ authenticationHash: string; identityEvidenceHash: string }>,
): Promise<Readonly<DacsBundleSignatureBindingV1>> {
  if (!HASH_RE.test(requestHash) || !bundleSignature(signature)) {
    throw new DacsBundleTransportRuntimeError("bundle-signature-invalid");
  }
  const order = await loadOrder(context, jobId);
  const id = transportId(context.role, "signature", jobId);
  const signatureHash = sha256Hex(canonicalize(signature));
  const existing = context.database.loadEffectInput("session", id);
  if (existing !== undefined) {
    const captured = captureSignatureBinding(existing);
    if (captured.localBindingHash !== order.localBindingHash ||
        captured.requestHash !== requestHash || captured.signatureHash !== signatureHash ||
        canonicalize(captured.signature) !== canonicalize(signature)) {
      throw new DacsBundleTransportRuntimeError("bundle-signature-conflict");
    }
    return captured;
  }
  const binding: DacsBundleSignatureBindingV1 = {
    bindingVersion: BUNDLE_SIGNATURE_BINDING_VERSION,
    localBindingHash: order.localBindingHash,
    requestHash,
    signatureHash,
    signature,
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
    throw new DacsBundleTransportRuntimeError("bundle-signature-conflict");
  }
  return captureSignatureBinding(context.database.loadEffectInput("session", id));
}

async function loadSignature(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  jobId: string,
): Promise<Readonly<DacsBundleSignatureBindingV1> | undefined> {
  const order = await loadOrder(context, jobId);
  const value = context.database.loadEffectInput(
    "session",
    transportId(context.role, "signature", jobId),
  );
  if (value === undefined) return undefined;
  const binding = captureSignatureBinding(value);
  if (binding.localBindingHash !== order.localBindingHash) {
    throw new DacsBundleTransportRuntimeError("bundle-signature-binding-corrupt");
  }
  return binding;
}

/**
 * Recover the exact buyer counter-signature retained before authenticated HTTP
 * publication. The durable finalizer uses this read-only view after a crash.
 */
export async function loadDacsBuyerBundleSignatureForOrderV1(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  order: Readonly<{ jobId: string; buyer: string; seller: string; localBindingHash: string }>,
): Promise<Readonly<{
  requestHash: string;
  signature: Readonly<BundleSignature>;
}> | undefined> {
  if (context.role !== "buyer" || order.buyer !== context.authority ||
      order.seller !== context.peerAuthority) {
    throw new DacsBundleTransportRuntimeError("bundle-signature-order-mismatch");
  }
  const binding = await loadSignature(context, order.jobId);
  if (binding === undefined) return undefined;
  if (binding.localBindingHash !== order.localBindingHash) {
    throw new DacsBundleTransportRuntimeError("bundle-signature-binding-corrupt");
  }
  return Object.freeze({
    requestHash: binding.requestHash,
    signature: structuredClone(binding.signature),
  });
}

function acknowledgementDisposition(
  value: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
): "accepted" | "existing" | "rejected" {
  return value.envelope.type === "acknowledgement"
    ? value.envelope.payload.disposition : "rejected";
}

function payloadResult(valid: boolean, reasonCode: string): DacsHttpPayloadValidationV1 {
  return valid ? { status: "valid" } : { status: "invalid", reasonCode };
}

function identityMatchesOrder(identity: Readonly<BuyerBundleTransportIdentity>, order: Readonly<{
  jobId: string;
  buyer: string;
  seller: string;
}>): boolean {
  return identity.jobId === order.jobId && identity.buyer === order.buyer &&
    identity.seller === order.seller;
}

export function createDacsBuyerBundleTransportRuntimeV1(
  options: Readonly<DacsBuyerBundleTransportRuntimeOptionsV1>,
): Readonly<DacsBuyerBundleTransportRuntimeV1> {
  if (!plainObject(options) || !plainObject(options.context) ||
      options.context.role !== "buyer" || typeof options.resolveVerification !== "function" ||
      typeof options.resolveSellerFinalization !== "function") {
    throw new TypeError("buyer bundle transport runtime options are invalid");
  }
  const context = options.context;
  const validatePayload: DacsHttpPayloadValidatorV1 = (input) => payloadResult(
    input.type === "bundle-signature-request" && bundleRequestPayload(input.payload) &&
      input.sender === context.peerAuthority && input.audience === context.authority &&
      input.payload.requiredCounterSigners.length === 1 &&
      input.payload.requiredCounterSigners[0] === context.authority,
    "bundle-signature-request-invalid",
  );

  const transport: BuyerBundleTransport = {
    async resolveSellerRequest(identity) {
      try {
        const order = await loadOrder(context, identity.jobId);
        if (!identityMatchesOrder(identity, order)) {
          return { disposition: "rejected", reason: "bundle-transport-identity-mismatch" };
        }
        const binding = await loadRequest(context, identity.jobId);
        return binding === undefined
          ? { disposition: "absent", reason: "seller-bundle-request-pending" }
          : { disposition: "present", value: requestFromPayload(binding.payload) };
      } catch {
        return { disposition: "indeterminate", reason: "seller-bundle-request-unavailable" };
      }
    },
    async publishCounterSignature(input, _fence: Readonly<BuyerBundleEffectFence>) {
      try {
        const request = await loadRequest(context, input.identity.jobId);
        if (request === undefined || request.requestHash !== input.requestHash) {
          return { disposition: "rejected", reason: "bundle-signature-request-mismatch" };
        }
        const binding = await putSignature(
          context,
          input.identity.jobId,
          input.requestHash,
          input.signature,
        );
        const acknowledgement = await context.sendMessage({
          type: "bundle-signature-response",
          jobId: input.identity.jobId,
          payload: binding.signature,
          idempotencyKey: `bundle-signature-response:${input.identity.jobId}:${input.requestHash}`,
        } satisfies DacsLiveRoleSendInputV1<"bundle-signature-response">);
        const disposition = acknowledgementDisposition(acknowledgement);
        return disposition === "accepted" || disposition === "existing"
          ? { disposition: "published" as const }
          : { disposition: "rejected" as const, reason: "peer-rejected-bundle-signature" };
      } catch {
        return { disposition: "indeterminate", reason: "bundle-signature-publication-ambiguous" };
      }
    },
    async resolveCounterSignatures(input) {
      try {
        const request = await loadRequest(context, input.identity.jobId);
        const signature = await loadSignature(context, input.identity.jobId);
        if (request === undefined || signature === undefined ||
            request.requestHash !== input.requestHash ||
            signature.requestHash !== input.requestHash ||
            sha256Hex(canonicalize(request.payload.requiredCounterSigners)) !==
              input.requiredCounterSignersHash ||
            canonicalize(signature.signature) !== canonicalize(input.buyerSignature)) {
          return { disposition: "absent", reason: "bundle-counter-signature-set-pending" };
        }
        return { disposition: "present", value: [signature.signature] };
      } catch {
        return { disposition: "indeterminate", reason: "bundle-counter-signature-set-unavailable" };
      }
    },
    resolveSellerFinalization: (input) => options.resolveSellerFinalization(input),
  };
  Object.freeze(transport);

  const runtime: DacsBuyerBundleTransportRuntimeV1 = {
    transport,
    validatePayload,
    async handleMessage(authenticated, inboundContext) {
      const envelope = authenticated.envelope;
      if (inboundContext.role !== "buyer" || envelope.type !== "bundle-signature-request") {
        return { disposition: "rejected", reasonCode: "bundle-request-role-incompatible" };
      }
      const validation = await validatePayload({
        type: envelope.type,
        payload: envelope.payload,
        jobId: envelope.jobId,
        sender: envelope.sender,
        audience: envelope.audience,
      });
      if (validation.status !== "valid") {
        return { disposition: "rejected", reasonCode: validation.reasonCode };
      }
      try {
        const request = requestFromPayload(envelope.payload);
        const verification = await options.resolveVerification({ authenticated, request });
        if (!plainObject(verification) || !plainObject(verification.input) ||
            !plainObject(verification.provider)) throw new Error();
        const verified = await verifyCompletedSellerBundleCounterSignatureRequest(
          verification.input,
          request,
          verification.provider,
        );
        if (canonicalize(payloadFromRequest(verified)) !== canonicalize(envelope.payload)) {
          throw new Error();
        }
        await putRequest(
          context,
          envelope.jobId,
          envelope.payload,
          {
            authenticationHash: authenticated.authenticationHash,
            identityEvidenceHash: authenticated.identityEvidenceHash,
          },
        );
        return { disposition: "accepted" };
      } catch {
        return { disposition: "rejected", reasonCode: "bundle-signature-request-unverified" };
      }
    },
  };
  return Object.freeze(runtime);
}

export function createDacsSellerBundleTransportRuntimeV1(
  context: Readonly<DacsLiveRoleOperationContextV1>,
): Readonly<DacsSellerBundleTransportRuntimeV1> {
  if (!plainObject(context) || context.role !== "seller") {
    throw new TypeError("seller bundle transport runtime context is invalid");
  }
  const validatePayload: DacsHttpPayloadValidatorV1 = async (input) => {
    if (input.type !== "bundle-signature-response" || !bundleSignature(input.payload) ||
        input.sender !== context.peerAuthority || input.audience !== context.authority ||
        input.payload.party !== context.peerAuthority) {
      return payloadResult(false, "bundle-signature-response-invalid");
    }
    try {
      const request = await loadRequest(context, input.jobId);
      if (request === undefined || request.payload.requiredCounterSigners.length !== 1 ||
          request.payload.requiredCounterSigners[0] !== input.sender) {
        return payloadResult(false, "bundle-signature-response-unbound");
      }
      const publicKey = canonicalDemosAgentPublicKey(input.sender);
      return payloadResult(publicKey !== null && ed25519Verify(
        Buffer.from(request.payload.signedBytes, "base64url"),
        Buffer.from(input.payload.value, "base64url"),
        publicKeyFromRaw(publicKey),
      ), "bundle-signature-response-unverified");
    } catch {
      return { status: "authentication-failure", reasonCode: "bundle-signature-verification-unavailable" };
    }
  };

  const runtime: DacsSellerBundleTransportRuntimeV1 = {
    validatePayload,
    async publishRequest({ jobId, request }) {
      let requestHash = "0".repeat(64);
      try {
        if (request.requiredCounterSigners.length !== 1 ||
            request.requiredCounterSigners[0] !== context.peerAuthority) {
          throw new DacsBundleTransportRuntimeError("bundle-counter-signer-set-unsupported");
        }
        const payload = payloadFromRequest(request);
        requestHash = sha256Hex(canonicalize(payload));
        const binding = await putRequest(context, jobId, payload);
        const acknowledgement = await context.sendMessage({
          type: "bundle-signature-request",
          jobId,
          payload: binding.payload,
          idempotencyKey: `bundle-signature-request:${jobId}:${binding.requestHash}`,
        } satisfies DacsLiveRoleSendInputV1<"bundle-signature-request">);
        const disposition = acknowledgementDisposition(acknowledgement);
        return {
          status: disposition === "accepted" || disposition === "existing"
            ? "acknowledged" as const : "rejected" as const,
          requestHash: binding.requestHash,
        };
      } catch (error) {
        return {
          status: error instanceof DacsBundleTransportRuntimeError &&
              error.reasonCode === "bundle-counter-signer-set-unsupported"
            ? "rejected" as const : "pending" as const,
          requestHash,
        };
      }
    },
    async resolveCounterSignatures(jobId) {
      const request = await loadRequest(context, jobId);
      const signature = await loadSignature(context, jobId);
      if (request === undefined || signature === undefined ||
          signature.requestHash !== request.requestHash) return Object.freeze([]);
      return Object.freeze([structuredClone(signature.signature)]);
    },
    async handleMessage(authenticated, inboundContext) {
      const envelope = authenticated.envelope;
      if (inboundContext.role !== "seller" || envelope.type !== "bundle-signature-response") {
        return { disposition: "rejected", reasonCode: "bundle-signature-role-incompatible" };
      }
      const validation = await validatePayload({
        type: envelope.type,
        payload: envelope.payload,
        jobId: envelope.jobId,
        sender: envelope.sender,
        audience: envelope.audience,
      });
      if (validation.status !== "valid") {
        return { disposition: "rejected", reasonCode: validation.reasonCode };
      }
      try {
        const request = await loadRequest(context, envelope.jobId);
        if (request === undefined) throw new Error();
        await putSignature(
          context,
          envelope.jobId,
          request.requestHash,
          envelope.payload,
          {
            authenticationHash: authenticated.authenticationHash,
            identityEvidenceHash: authenticated.identityEvidenceHash,
          },
        );
        return { disposition: "accepted" };
      } catch {
        return { disposition: "rejected", reasonCode: "bundle-signature-retention-failed" };
      }
    },
  };
  return Object.freeze(runtime);
}
