import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import { isCanonicalJobId } from "@kynesyslabs/dacs/negotiate";

import type { DacsLiveEffectFenceV1 } from "./liveEffects.js";
import {
  isDacsPayDemPaymentNoticeV1,
  type DacsPayDemPaymentNoticeV1,
} from "./payDemPayment.js";
import type { DacsNodeSqliteDatabase } from "./sqlite.js";
import type {
  DacsLiveRoleOperationContextV1,
  DacsLiveRoleInboundOperationContextV1,
} from "./roleRuntime.js";
import type { DacsLiveRoleSendInputV1 } from "./service.js";
import type {
  DacsHttpAuthenticatedEnvelopeV1,
  DacsHttpPayloadValidationV1,
  DacsHttpPayloadValidatorV1,
} from "./transport/envelope.js";
import type { DacsHttpInboundDispositionV1 } from "./transport/http.js";

const NOTICE_BINDING_VERSION = "1" as const;
const NOTICE_BINDING_ID_DOMAIN = "dacs-pay-dem-payment-notice-binding:v1:" as const;
const HASH_RE = /^[0-9a-f]{64}$/;

export interface DacsPayDemPaymentNoticeAuthenticationV1 {
  envelopeId: string;
  authenticationHash: string;
  identityEvidenceHash: string;
  sender: string;
  audience: string;
  payloadHash: string;
}

export interface DacsRetainedPayDemPaymentNoticeV1 {
  bindingVersion: typeof NOTICE_BINDING_VERSION;
  noticeHash: string;
  notice: Readonly<DacsPayDemPaymentNoticeV1>;
  transportAuthentication: Readonly<DacsPayDemPaymentNoticeAuthenticationV1>;
}

type BuyerNoticeContext = Pick<
  DacsLiveRoleOperationContextV1,
  "role" | "authority" | "peerAuthority" | "queueMessage"
>;

type SellerNoticeContext = Pick<
  DacsLiveRoleOperationContextV1,
  "role" | "authority" | "peerAuthority" | "database"
>;

export interface DacsPayDemSellerPaymentNoticeRuntimeV1 {
  readonly validatePayload: DacsHttpPayloadValidatorV1;
  load(jobId: string): Readonly<DacsRetainedPayDemPaymentNoticeV1> | undefined;
  handleMessage(
    authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
    context: Readonly<DacsLiveRoleInboundOperationContextV1>,
  ): Promise<DacsHttpInboundDispositionV1>;
}

export class DacsPayDemPaymentNoticeRuntimeError extends Error {
  override readonly name = "DacsPayDemPaymentNoticeRuntimeError";

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
  fields: readonly string[],
): boolean {
  return Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field));
}

function noticeHash(notice: Readonly<DacsPayDemPaymentNoticeV1>): string {
  return sha256Hex(canonicalize(notice));
}

function noticeBindingId(
  jobId: string,
  buyer: string,
  seller: string,
): string {
  return sha256Hex(`${NOTICE_BINDING_ID_DOMAIN}${canonicalize({
    jobId,
    buyer,
    seller,
  })}`);
}

function captureAuthentication(
  value: unknown,
): Readonly<DacsPayDemPaymentNoticeAuthenticationV1> {
  if (!plainObject(value) || !exactFields(value, [
    "envelopeId", "authenticationHash", "identityEvidenceHash", "sender",
    "audience", "payloadHash",
  ]) || typeof value.envelopeId !== "string" || !HASH_RE.test(value.envelopeId) ||
      typeof value.authenticationHash !== "string" ||
      !HASH_RE.test(value.authenticationHash) ||
      typeof value.identityEvidenceHash !== "string" ||
      !HASH_RE.test(value.identityEvidenceHash) ||
      typeof value.sender !== "string" || value.sender.length === 0 ||
      typeof value.audience !== "string" || value.audience.length === 0 ||
      typeof value.payloadHash !== "string" || !HASH_RE.test(value.payloadHash)) {
    throw new DacsPayDemPaymentNoticeRuntimeError(
      "pay-dem-payment-notice-authentication-invalid",
    );
  }
  return Object.freeze(JSON.parse(canonicalize(value)) as
    DacsPayDemPaymentNoticeAuthenticationV1);
}

export function captureDacsRetainedPayDemPaymentNoticeV1(
  value: unknown,
): Readonly<DacsRetainedPayDemPaymentNoticeV1> {
  if (!plainObject(value) || !exactFields(value, [
    "bindingVersion", "noticeHash", "notice", "transportAuthentication",
  ]) || value.bindingVersion !== NOTICE_BINDING_VERSION ||
      typeof value.noticeHash !== "string" || !HASH_RE.test(value.noticeHash) ||
      !isDacsPayDemPaymentNoticeV1(value.notice)) {
    throw new DacsPayDemPaymentNoticeRuntimeError(
      "pay-dem-payment-notice-binding-corrupt",
    );
  }
  const authentication = captureAuthentication(value.transportAuthentication);
  if (value.noticeHash !== noticeHash(value.notice) ||
      authentication.payloadHash !== value.noticeHash) {
    throw new DacsPayDemPaymentNoticeRuntimeError(
      "pay-dem-payment-notice-binding-corrupt",
    );
  }
  return Object.freeze(JSON.parse(canonicalize({
    bindingVersion: NOTICE_BINDING_VERSION,
    noticeHash: value.noticeHash,
    notice: value.notice,
    transportAuthentication: authentication,
  })) as DacsRetainedPayDemPaymentNoticeV1);
}

function loadRetained(
  database: DacsNodeSqliteDatabase,
  effectId: string,
): Readonly<DacsRetainedPayDemPaymentNoticeV1> | undefined {
  const value = database.loadEffectInput("session", effectId);
  return value === undefined
    ? undefined
    : captureDacsRetainedPayDemPaymentNoticeV1(value);
}

function payloadResult(valid: boolean): DacsHttpPayloadValidationV1 {
  return valid
    ? Object.freeze({ status: "valid" as const })
    : Object.freeze({
        status: "invalid" as const,
        reasonCode: "pay-dem-payment-notice-invalid",
      });
}

/** Queue the exact signed buyer notice without placing peer uptime on payment. */
export function createDacsPayDemBuyerPaymentNoticePublisherV1(
  context: Readonly<BuyerNoticeContext>,
): (input: Readonly<{
  notice: Readonly<DacsPayDemPaymentNoticeV1>;
  fence: Readonly<DacsLiveEffectFenceV1>;
}>) => Promise<void> {
  if (!plainObject(context) || context.role !== "buyer" ||
      typeof context.authority !== "string" || context.authority.length === 0 ||
      typeof context.peerAuthority !== "string" || context.peerAuthority.length === 0 ||
      typeof context.queueMessage !== "function") {
    throw new TypeError("pay-DEM buyer payment notice context is invalid");
  }
  return async ({ notice, fence }) => {
    if (!isDacsPayDemPaymentNoticeV1(notice) ||
        fence.role !== "buyer" || fence.track !== "payment" ||
        fence.jobId !== notice.payment.jobId) {
      throw new DacsPayDemPaymentNoticeRuntimeError(
        "pay-dem-payment-notice-fence-mismatch",
      );
    }
    await fence.assertCurrent();
    await context.queueMessage({
      type: "pay-dem-payment-notice",
      jobId: notice.payment.jobId,
      payload: notice,
      idempotencyKey:
        `pay-dem-payment-notice:${notice.payment.jobId}:${noticeHash(notice)}`,
    } satisfies DacsLiveRoleSendInputV1<"pay-dem-payment-notice">);
  };
}

/** Retain one authenticated buyer notice per fixed-price native DEM job. */
export function createDacsPayDemSellerPaymentNoticeRuntimeV1(
  context: Readonly<SellerNoticeContext>,
): Readonly<DacsPayDemSellerPaymentNoticeRuntimeV1> {
  if (!plainObject(context) || context.role !== "seller" ||
      typeof context.authority !== "string" || context.authority.length === 0 ||
      typeof context.peerAuthority !== "string" || context.peerAuthority.length === 0 ||
      context.database === null || typeof context.database !== "object" ||
      context.database.metadata.role !== "seller" ||
      context.database.metadata.mode !== "live-demos") {
    throw new TypeError("pay-DEM seller payment notice context is invalid");
  }
  const database = context.database;
  const buyer = context.peerAuthority;
  const seller = context.authority;
  const validatePayload: DacsHttpPayloadValidatorV1 = (input) => payloadResult(
    input.type === "pay-dem-payment-notice" &&
      input.sender === buyer && input.audience === seller &&
      isDacsPayDemPaymentNoticeV1(input.payload) &&
      input.payload.payment.jobId === input.jobId,
  );

  const runtime: DacsPayDemSellerPaymentNoticeRuntimeV1 = {
    validatePayload,
    load(jobId) {
      if (!isCanonicalJobId(jobId)) {
        throw new DacsPayDemPaymentNoticeRuntimeError(
          "pay-dem-payment-notice-job-id-invalid",
        );
      }
      return loadRetained(database, noticeBindingId(jobId, buyer, seller));
    },
    async handleMessage(authenticated, inboundContext) {
      const envelope = authenticated.envelope;
      if (inboundContext.role !== "seller" ||
          inboundContext.authority !== seller ||
          inboundContext.peerAuthority !== buyer ||
          envelope.type !== "pay-dem-payment-notice") {
        return Object.freeze({
          disposition: "rejected" as const,
          reasonCode: "pay-dem-payment-notice-role-incompatible",
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
        return Object.freeze({
          disposition: "rejected" as const,
          reasonCode: validation.reasonCode,
        });
      }
      const id = noticeBindingId(envelope.jobId, buyer, seller);
      const hash = noticeHash(envelope.payload);
      try {
        const existing = loadRetained(database, id);
        if (existing !== undefined) {
          return canonicalize(existing.notice) === canonicalize(envelope.payload)
            ? Object.freeze({ disposition: "accepted" as const })
            : Object.freeze({
                disposition: "rejected" as const,
                reasonCode: "pay-dem-payment-notice-conflict",
              });
        }
        const retained: DacsRetainedPayDemPaymentNoticeV1 = {
          bindingVersion: NOTICE_BINDING_VERSION,
          noticeHash: hash,
          notice: envelope.payload,
          transportAuthentication: captureAuthentication({
            envelopeId: envelope.envelopeId,
            authenticationHash: authenticated.authenticationHash,
            identityEvidenceHash: authenticated.identityEvidenceHash,
            sender: envelope.sender,
            audience: envelope.audience,
            payloadHash: envelope.payloadHash,
          }),
        };
        const put = database.putEffectIntent({
          kind: "session",
          effectId: id,
          bindingHash: hash,
          input: retained,
          idempotencyKey: id,
          jobId: envelope.jobId,
        });
        if (put.status === "conflict") throw new Error("conflict");
        captureDacsRetainedPayDemPaymentNoticeV1(
          database.loadEffectInput("session", id),
        );
        return Object.freeze({ disposition: "accepted" as const });
      } catch {
        return Object.freeze({
          disposition: "rejected" as const,
          reasonCode: "pay-dem-payment-notice-retention-failed",
        });
      }
    },
  };
  return Object.freeze(runtime);
}
