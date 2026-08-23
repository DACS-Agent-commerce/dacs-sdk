import { canonicalize } from "@kynesyslabs/dacs/canonical";
import {
  fixedPricePayDemOrderBindingHash,
  fixedPricePayDemOrderLocalBindingHash,
  fixedPriceX402OrderBindingHash,
  fixedPriceX402OrderLocalBindingHash,
  type FixedPriceX402CoordinatorRole,
  type FixedPricePayDemOrderInput,
  type FixedPricePayDemProtocolBinding,
  type FixedPriceX402OrderInput,
  type FixedPriceX402ProtocolBinding,
} from "@kynesyslabs/dacs/commerce";

export interface DacsFixedPriceX402OrderIdentityV1 {
  jobId: string;
  buyer: string;
  seller: string;
  protocol: Readonly<FixedPriceX402ProtocolBinding>;
}

export interface DacsFixedPriceX402RoleOrderOptionsV1
  extends DacsFixedPriceX402OrderIdentityV1 {
  role: FixedPriceX402CoordinatorRole;
}

export interface DacsFixedPriceX402OrderPairV1 {
  readonly bindingHash: string;
  readonly buyer: Readonly<FixedPriceX402OrderInput>;
  readonly seller: Readonly<FixedPriceX402OrderInput>;
  readonly buyerLocalBindingHash: string;
  readonly sellerLocalBindingHash: string;
}

export interface DacsFixedPricePayDemOrderIdentityV1 {
  jobId: string;
  buyer: string;
  seller: string;
  protocol: Readonly<FixedPricePayDemProtocolBinding>;
}

export interface DacsFixedPricePayDemRoleOrderOptionsV1
  extends DacsFixedPricePayDemOrderIdentityV1 {
  role: FixedPriceX402CoordinatorRole;
}

export interface DacsFixedPricePayDemOrderPairV1 {
  readonly bindingHash: string;
  readonly buyer: Readonly<FixedPricePayDemOrderInput>;
  readonly seller: Readonly<FixedPricePayDemOrderInput>;
  readonly buyerLocalBindingHash: string;
  readonly sellerLocalBindingHash: string;
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

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function snapshotProtocol(
  protocol: Readonly<FixedPriceX402ProtocolBinding>,
): Readonly<FixedPriceX402ProtocolBinding> {
  try {
    return deepFreeze(JSON.parse(canonicalize(protocol)) as FixedPriceX402ProtocolBinding);
  } catch {
    throw new TypeError("fixed-price x402 order protocol is invalid");
  }
}

function snapshotPayDemProtocol(
  protocol: Readonly<FixedPricePayDemProtocolBinding>,
): Readonly<FixedPricePayDemProtocolBinding> {
  try {
    return deepFreeze(JSON.parse(canonicalize(protocol)) as FixedPricePayDemProtocolBinding);
  } catch {
    throw new TypeError("fixed-price pay-dem order protocol is invalid");
  }
}

function pointers(
  role: FixedPriceX402CoordinatorRole,
  jobId: string,
): FixedPriceX402OrderInput["sdkJobs"] {
  const id = (track: string) => `dacs-live:${role}:${track}:${jobId}`;
  return role === "buyer"
    ? Object.freeze({
        role,
        agreement: id("agreement"),
        payment: id("payment"),
        paymentEvidence: id("payment-evidence"),
        buyerReceived: id("buyer-received"),
        audit: id("audit"),
      })
    : Object.freeze({
        role,
        agreement: id("agreement"),
        payment: id("payment"),
        paymentEvidence: id("payment-evidence"),
        fulfilment: id("fulfilment"),
        deliveryEvidence: id("delivery-evidence"),
        audit: id("audit"),
      });
}

/**
 * Build one actor-local coordinator order without making the consumer invent
 * SDK job pointers. Core binding helpers re-validate the complete commercial
 * identity and role-local pointer set before the immutable view is returned.
 */
export function createDacsFixedPriceX402RoleOrderV1(
  options: Readonly<DacsFixedPriceX402RoleOrderOptionsV1>,
): Readonly<FixedPriceX402OrderInput> {
  if (!plainObject(options) || Reflect.ownKeys(options).length !== 5 ||
      (options.role !== "buyer" && options.role !== "seller") ||
      typeof options.jobId !== "string" || typeof options.buyer !== "string" ||
      typeof options.seller !== "string" || !plainObject(options.protocol)) {
    throw new TypeError("fixed-price x402 role order options are invalid");
  }
  const order: FixedPriceX402OrderInput = {
    jobId: options.jobId,
    buyer: options.buyer,
    seller: options.seller,
    protocol: snapshotProtocol(options.protocol),
    sdkJobs: pointers(options.role, options.jobId),
  };
  try {
    fixedPriceX402OrderBindingHash(order);
    fixedPriceX402OrderLocalBindingHash(order);
  } catch {
    throw new TypeError("fixed-price x402 role order is invalid");
  }
  return deepFreeze(order);
}

/** Build the two non-interchangeable actor views for one commercial order. */
export function createDacsFixedPriceX402OrderPairV1(
  options: Readonly<DacsFixedPriceX402OrderIdentityV1>,
): Readonly<DacsFixedPriceX402OrderPairV1> {
  if (!plainObject(options) || Reflect.ownKeys(options).length !== 4 ||
      typeof options.jobId !== "string" || typeof options.buyer !== "string" ||
      typeof options.seller !== "string" || !plainObject(options.protocol)) {
    throw new TypeError("fixed-price x402 order pair options are invalid");
  }
  const buyer = createDacsFixedPriceX402RoleOrderV1({ ...options, role: "buyer" });
  const seller = createDacsFixedPriceX402RoleOrderV1({ ...options, role: "seller" });
  const buyerBindingHash = fixedPriceX402OrderBindingHash(buyer);
  const sellerBindingHash = fixedPriceX402OrderBindingHash(seller);
  if (buyerBindingHash !== sellerBindingHash) {
    throw new TypeError("fixed-price x402 order pair binding differs");
  }
  const pair: DacsFixedPriceX402OrderPairV1 = {
    bindingHash: buyerBindingHash,
    buyer,
    seller,
    buyerLocalBindingHash: fixedPriceX402OrderLocalBindingHash(buyer),
    sellerLocalBindingHash: fixedPriceX402OrderLocalBindingHash(seller),
  };
  if (pair.buyerLocalBindingHash === pair.sellerLocalBindingHash) {
    throw new TypeError("fixed-price x402 role-local order bindings collide");
  }
  return deepFreeze(pair);
}

/** Build one actor-local native DEM order with SDK-owned job pointers. */
export function createDacsFixedPricePayDemRoleOrderV1(
  options: Readonly<DacsFixedPricePayDemRoleOrderOptionsV1>,
): Readonly<FixedPricePayDemOrderInput> {
  if (!plainObject(options) || Reflect.ownKeys(options).length !== 5 ||
      (options.role !== "buyer" && options.role !== "seller") ||
      typeof options.jobId !== "string" || typeof options.buyer !== "string" ||
      typeof options.seller !== "string" || !plainObject(options.protocol)) {
    throw new TypeError("fixed-price pay-dem role order options are invalid");
  }
  const order: FixedPricePayDemOrderInput = {
    jobId: options.jobId,
    buyer: options.buyer,
    seller: options.seller,
    protocol: snapshotPayDemProtocol(options.protocol),
    sdkJobs: pointers(options.role, options.jobId),
  };
  try {
    fixedPricePayDemOrderBindingHash(order);
    fixedPricePayDemOrderLocalBindingHash(order);
  } catch {
    throw new TypeError("fixed-price pay-dem role order is invalid");
  }
  return deepFreeze(order);
}

/** Build the buyer and seller native DEM views for one commercial order. */
export function createDacsFixedPricePayDemOrderPairV1(
  options: Readonly<DacsFixedPricePayDemOrderIdentityV1>,
): Readonly<DacsFixedPricePayDemOrderPairV1> {
  if (!plainObject(options) || Reflect.ownKeys(options).length !== 4 ||
      typeof options.jobId !== "string" || typeof options.buyer !== "string" ||
      typeof options.seller !== "string" || !plainObject(options.protocol)) {
    throw new TypeError("fixed-price pay-dem order pair options are invalid");
  }
  const buyer = createDacsFixedPricePayDemRoleOrderV1({ ...options, role: "buyer" });
  const seller = createDacsFixedPricePayDemRoleOrderV1({ ...options, role: "seller" });
  const buyerBindingHash = fixedPricePayDemOrderBindingHash(buyer);
  const sellerBindingHash = fixedPricePayDemOrderBindingHash(seller);
  if (buyerBindingHash !== sellerBindingHash) {
    throw new TypeError("fixed-price pay-dem order pair binding differs");
  }
  const pair: DacsFixedPricePayDemOrderPairV1 = {
    bindingHash: buyerBindingHash,
    buyer,
    seller,
    buyerLocalBindingHash: fixedPricePayDemOrderLocalBindingHash(buyer),
    sellerLocalBindingHash: fixedPricePayDemOrderLocalBindingHash(seller),
  };
  if (pair.buyerLocalBindingHash === pair.sellerLocalBindingHash) {
    throw new TypeError("fixed-price pay-dem role-local order bindings collide");
  }
  return deepFreeze(pair);
}
