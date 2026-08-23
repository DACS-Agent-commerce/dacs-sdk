import {
  captureFixedPricePayDemProtocolBinding,
  type AuthenticatedRailDefinition,
} from "@kynesyslabs/dacs";
import type { BundleRequirement } from "@kynesyslabs/dacs/artifacts";
import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import {
  fixedPricePayDemOrderLocalBindingHash,
  type FixedPricePayDemOrderInput,
  type FixedPricePayDemOrderRecord,
} from "@kynesyslabs/dacs/commerce";
import {
  canonicalDemosAgentPublicKey,
  sameCanonicalClaimIdentity,
} from "@kynesyslabs/dacs/identity";

import type { DacsSellerAgreementTransportRuntimeOptionsV1 } from
  "./agreementTransportRuntime.js";
import {
  captureDacsFixedPriceX402ApplicationV1,
  createDacsFixedPriceX402BuyerAgreementPolicyV1,
  createDacsFixedPriceX402SellerAgreementPolicyV1,
  DACS_FIXED_PRICE_X402_EMPTY_REQUIREMENT_V1,
  DacsFixedPriceX402ProfileError,
  type DacsFixedPriceX402ApplicationV1,
  type DacsFixedPriceX402BuyerAgreementPolicyV1,
  type DacsFixedPriceX402SellerAgreementPolicyV1,
} from "./fixedPriceX402Profile.js";
import {
  resolveDacsPayDemExistingListingV1,
} from "./listingDoctor.js";
import { createDacsFixedPricePayDemRoleOrderV1 } from "./liveOrder.js";
import type {
  DacsLiveOrderInputV1,
} from "./orderInput.js";
import { createDacsFixedPricePayDemProtocolBindingV1 } from "./purchaseQueue.js";
import { readDacsPublicJsonV1 } from "./publicJson.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";
import {
  DacsSellerSessionAdmissionUnavailableError,
  type DacsSellerSessionBootstrapAdmissionV1,
  type DacsSellerSessionBootstrapTransportOptionsV1,
} from "./sessionBootstrapTransportRuntime.js";

const ADMISSION_VERSION = "1" as const;
const ADMISSION_DOMAIN = "dacs-fixed-price-pay-dem-seller-admission:v1:" as const;
const HASH_RE = /^[0-9a-f]{64}$/;

export interface DacsFixedPricePayDemSellerAdmissionRecordV1 {
  admissionVersion: typeof ADMISSION_VERSION;
  jobId: string;
  localBindingHash: string;
  admittedAt: number;
  application: Readonly<DacsFixedPriceX402ApplicationV1>;
  protocol: Readonly<FixedPricePayDemOrderInput["protocol"]>;
}

export interface DacsFixedPricePayDemSellerSessionPolicyOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  rail: Readonly<AuthenticatedRailDefinition>;
  sellerPublicEndpoint: string;
  sellerPayee: string;
  maximumServiceAmount: string;
  now?(): number;
  readJson?(url: string): Promise<unknown>;
}

export interface DacsFixedPricePayDemSellerSessionPolicyV1 {
  admitInit: DacsSellerSessionBootstrapTransportOptionsV1<
    FixedPricePayDemOrderInput
  >["admitInit"];
  admitProposal: DacsSellerAgreementTransportRuntimeOptionsV1<
    FixedPricePayDemOrderInput
  >["admitProposal"];
  resolveBuyerRequirement(input: Readonly<{
    retained: Readonly<DacsLiveOrderInputV1>;
  }>): Readonly<BundleRequirement>;
  resolveSellerRequirement(): Readonly<BundleRequirement>;
}

export interface DacsFixedPricePayDemBuyerAgreementPolicyOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  now?(): number;
}

export interface DacsFixedPricePayDemSellerAgreementPolicyOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  maximumClockSkewMs?: number;
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

function copy<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function admissionId(jobId: string): string {
  return sha256Hex(`${ADMISSION_DOMAIN}${jobId}`);
}

function captureAdmission(
  value: unknown,
): Readonly<DacsFixedPricePayDemSellerAdmissionRecordV1> {
  if (!plainObject(value) || Object.keys(value).length !== 6 ||
      value.admissionVersion !== ADMISSION_VERSION || typeof value.jobId !== "string" ||
      typeof value.localBindingHash !== "string" || !HASH_RE.test(value.localBindingHash) ||
      !Number.isSafeInteger(value.admittedAt) || Number(value.admittedAt) < 0 ||
      !plainObject(value.protocol)) {
    throw new DacsFixedPriceX402ProfileError("fixed-price-pay-dem-admission-corrupt");
  }
  let protocol: FixedPricePayDemOrderInput["protocol"];
  try {
    protocol = captureFixedPricePayDemProtocolBinding(value.protocol);
  } catch {
    throw new DacsFixedPriceX402ProfileError("fixed-price-pay-dem-admission-corrupt");
  }
  return deepFreeze(copy({
    admissionVersion: ADMISSION_VERSION,
    jobId: value.jobId,
    localBindingHash: value.localBindingHash,
    admittedAt: Number(value.admittedAt),
    application: captureDacsFixedPriceX402ApplicationV1(value.application),
    protocol,
  }));
}

function retainAdmission(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  order: Readonly<FixedPricePayDemOrderInput>,
  application: Readonly<DacsFixedPriceX402ApplicationV1>,
  admittedAt: number,
): Readonly<DacsFixedPricePayDemSellerAdmissionRecordV1> {
  const id = admissionId(order.jobId);
  const record: DacsFixedPricePayDemSellerAdmissionRecordV1 = {
    admissionVersion: ADMISSION_VERSION,
    jobId: order.jobId,
    localBindingHash: fixedPricePayDemOrderLocalBindingHash(order),
    admittedAt,
    application,
    protocol: order.protocol,
  };
  const existing = context.database.loadEffectInput("session", id);
  if (existing !== undefined) {
    const captured = captureAdmission(existing);
    if (canonicalize(captured) !== canonicalize(record)) {
      throw new DacsFixedPriceX402ProfileError("fixed-price-pay-dem-admission-conflict");
    }
    return captured;
  }
  const put = context.database.putEffectIntent({
    kind: "session",
    effectId: id,
    bindingHash: record.localBindingHash,
    input: record,
    idempotencyKey: id,
    jobId: order.jobId,
  });
  if (put.status === "conflict") {
    throw new DacsFixedPriceX402ProfileError("fixed-price-pay-dem-admission-conflict");
  }
  return captureAdmission(context.database.loadEffectInput("session", id));
}

export function loadDacsFixedPricePayDemSellerAdmissionV1(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  order: Readonly<FixedPricePayDemOrderRecord>,
): Readonly<DacsFixedPricePayDemSellerAdmissionRecordV1> {
  if (context.role !== "seller" || order.role !== "seller") {
    throw new DacsFixedPriceX402ProfileError("fixed-price-pay-dem-order-mismatch");
  }
  const value = context.database.loadEffectInput("session", admissionId(order.jobId));
  if (value === undefined) {
    throw new DacsFixedPriceX402ProfileError("fixed-price-pay-dem-admission-missing");
  }
  const admission = captureAdmission(value);
  if (admission.jobId !== order.jobId ||
      admission.localBindingHash !== order.localBindingHash ||
      canonicalize(admission.protocol) !== canonicalize(order.protocol)) {
    throw new DacsFixedPriceX402ProfileError("fixed-price-pay-dem-admission-corrupt");
  }
  return admission;
}

/** Admit only an already selected, authenticated native DEM Listing. */
export function createDacsFixedPricePayDemSellerSessionPolicyV1(
  options: Readonly<DacsFixedPricePayDemSellerSessionPolicyOptionsV1>,
): Readonly<DacsFixedPricePayDemSellerSessionPolicyV1> {
  if (!plainObject(options) || !plainObject(options.context) ||
      options.context.role !== "seller" || typeof options.sellerPublicEndpoint !== "string" ||
      typeof options.sellerPayee !== "string" ||
      typeof options.maximumServiceAmount !== "string" ||
      (options.now !== undefined && typeof options.now !== "function") ||
      (options.readJson !== undefined && typeof options.readJson !== "function")) {
    throw new TypeError("fixed-price pay-dem seller session policy options are invalid");
  }
  const context = options.context;
  const sellerPublicKey = canonicalDemosAgentPublicKey(context.authority);
  if (sellerPublicKey === null || Buffer.from(sellerPublicKey).toString("hex") !==
      options.sellerPayee) {
    throw new TypeError("fixed-price pay-dem seller authority is invalid");
  }
  const admitInit: DacsSellerSessionBootstrapTransportOptionsV1<
    FixedPricePayDemOrderInput
  >["admitInit"] =
    async ({ authenticated, payload }): Promise<Readonly<
      DacsSellerSessionBootstrapAdmissionV1<FixedPricePayDemOrderInput>
    >> => {
      const application = captureDacsFixedPriceX402ApplicationV1(payload.application);
      if (payload.order.protocol.phase !== "pay-dem" ||
          payload.order.sdkJobs.role !== "buyer" ||
          !sameCanonicalClaimIdentity(payload.order.buyer, context.peerAuthority) ||
          !sameCanonicalClaimIdentity(payload.order.seller, context.authority) ||
          authenticated.envelope.sender !== context.peerAuthority ||
          authenticated.envelope.audience !== context.authority) {
        throw new DacsFixedPriceX402ProfileError("fixed-price-pay-dem-session-party-mismatch");
      }
      const admittedAt = options.now?.() ?? context.database.readTime();
      const resolved = await resolveDacsPayDemExistingListingV1({
        listingRef: application.listingRef,
        sellerAuthority: context.authority,
        sellerPublicKey,
        sellerPublicEndpoint: options.sellerPublicEndpoint,
        sellerPayee: options.sellerPayee,
        rail: options.rail,
        maximumServiceAmount: options.maximumServiceAmount,
        now: admittedAt,
        readAnchor: (locator) => context.demos.adapter.readAnchor(locator),
        async authenticateAnchor(anchor) {
          const receipt = await context.demos.adapter.resolveDemosAnchorReceipt(anchor);
          return receipt !== null &&
            await context.demos.adapter.verifyDemosAnchorReceipt(receipt) === true;
        },
        readJson: options.readJson ?? ((url) => readDacsPublicJsonV1(url)),
      });
      if (resolved.status === "blocked") {
        throw new DacsSellerSessionAdmissionUnavailableError(resolved.reasonCode);
      }
      if (resolved.status !== "verified") {
        throw new DacsFixedPriceX402ProfileError(resolved.reasonCode);
      }
      if (resolved.admission.listingRef !== application.listingRef ||
          resolved.admission.listingContentHash !== application.listingContentHash ||
          resolved.admission.logicalAddress !== application.listingLogicalAddress ||
          canonicalize(resolved.admission.listing) !== canonicalize(application.listing) ||
          canonicalize(createDacsFixedPricePayDemProtocolBindingV1(resolved.admission)) !==
            canonicalize(payload.order.protocol)) {
        throw new DacsFixedPriceX402ProfileError(
          "fixed-price-pay-dem-session-listing-not-admitted",
        );
      }
      const order = createDacsFixedPricePayDemRoleOrderV1({
        role: "seller",
        jobId: payload.order.jobId,
        buyer: payload.order.buyer,
        seller: payload.order.seller,
        protocol: payload.order.protocol,
      });
      retainAdmission(context, order, application, admittedAt);
      return Object.freeze({ order, application });
    };
  const admitProposal: DacsSellerAgreementTransportRuntimeOptionsV1<
    FixedPricePayDemOrderInput
  >["admitProposal"] = async ({ payload }) => {
      const loaded = await context.database.createPayDemCoordinatorStore("seller")
        .load("seller", payload.transportIdentity.jobId);
      if (loaded.status !== "ok") {
        throw new DacsFixedPriceX402ProfileError("fixed-price-pay-dem-order-missing");
      }
      const admission = loadDacsFixedPricePayDemSellerAdmissionV1(context, loaded.record);
      return Object.freeze({
        order: createDacsFixedPricePayDemRoleOrderV1({
          role: "seller",
          jobId: loaded.record.jobId,
          buyer: loaded.record.buyer,
          seller: loaded.record.seller,
          protocol: loaded.record.protocol,
        }),
        application: admission.application,
      });
    };
  const resolveBuyerRequirement: DacsFixedPricePayDemSellerSessionPolicyV1[
    "resolveBuyerRequirement"
  ] = ({ retained }) => {
      const application = captureDacsFixedPriceX402ApplicationV1(retained.application);
      return deepFreeze(copy(application.listing.buyerRequirement));
    };
  return Object.freeze({
    admitInit,
    admitProposal,
    resolveBuyerRequirement,
    resolveSellerRequirement() {
      return DACS_FIXED_PRICE_X402_EMPTY_REQUIREMENT_V1;
    },
  });
}

/** Use the shared Agreement anchor/signature spine with native rail selection. */
export function createDacsFixedPricePayDemBuyerAgreementPolicyV1(
  options: Readonly<DacsFixedPricePayDemBuyerAgreementPolicyOptionsV1>,
): Readonly<DacsFixedPriceX402BuyerAgreementPolicyV1> {
  return createDacsFixedPriceX402BuyerAgreementPolicyV1(options);
}

/** Select the native admission journal while retaining the shared commitment spine. */
export function createDacsFixedPricePayDemSellerAgreementPolicyV1(
  options: Readonly<DacsFixedPricePayDemSellerAgreementPolicyOptionsV1>,
): Readonly<DacsFixedPriceX402SellerAgreementPolicyV1> {
  return createDacsFixedPriceX402SellerAgreementPolicyV1({
    context: options.context,
    ...(options.maximumClockSkewMs === undefined
      ? {} : { maximumClockSkewMs: options.maximumClockSkewMs }),
    loadAdmission: (order) => loadDacsFixedPricePayDemSellerAdmissionV1(
      options.context,
      order as FixedPricePayDemOrderRecord,
    ),
  });
}
