import {
  type AuthenticatedRailDefinition,
  type SellerPaymentIntakeDeps,
  type X402PaywallConfig,
  type X402SellerSpineOptions,
} from "@kynesyslabs/dacs";

import {
  createDacsFixedPriceX402SellerAuthorityV1,
  type DacsFixedPriceX402SellerAuthorityV1,
} from "./fixedPriceX402SellerAuthority.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";
import type {
  DacsSellerX402RuntimeOptionsV1,
} from "./sellerX402Runtime.js";
import {
  createDacsX402SellerEvmObserverV1,
  type DacsX402SellerEvmObserverV1,
} from "./x402SellerEvm.js";

const INTEGER_RE = /^(0|[1-9][0-9]*)$/;
const JOB_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_UINT256 = (1n << 256n) - 1n;

type SettlementSpineV1 = Pick<
  X402SellerSpineOptions,
  "reconcileSettlement" | "resolveCommittedSession" | "paymentIntakeDeps"
>;

export interface DacsFixedPriceX402SellerSettlementOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  rail: Readonly<AuthenticatedRailDefinition>;
  tokenDomain: Readonly<{ name: string; version: string }>;
  amount: string;
  facilitator: X402PaywallConfig["facilitator"];
  evmRpcUrl: string;
  authorizationSearchFromBlock: number;
  maxTimeoutSeconds?: number;
  finalityTag?: "finalized" | "safe" | "latest";
  logPageSize?: number;
  fetchImpl?: typeof fetch;
  description?: string;
  mimeType?: string;
  serviceName?: string;
}

export interface DacsFixedPriceX402SellerSettlementV1 extends Pick<
  DacsSellerX402RuntimeOptionsV1,
  "paywall" | "publicBaseUrl" | "resolveHttpRequest" |
    "resolveOrderScope" | "authorizePaymentComplete"
> {
  readonly spine: Readonly<SettlementSpineV1>;
  readonly authority: Readonly<DacsFixedPriceX402SellerAuthorityV1>;
  readonly observer: Readonly<DacsX402SellerEvmObserverV1>;
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

function resourceBase(rail: Readonly<AuthenticatedRailDefinition>): URL {
  if (rail.railType !== "x402" || rail.phaseHandler !== "pay-x402" ||
      rail.asset.kind !== "erc20" || rail.network.kind !== "x402-resource") {
    throw new TypeError("fixed-price seller settlement requires an x402 ERC-20 rail");
  }
  let parsed: URL;
  try {
    parsed = new URL(rail.network.resourceBaseUrl);
  } catch {
    throw new TypeError("fixed-price seller settlement resource URL is invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
      parsed.search || parsed.hash || parsed.pathname === "/") {
    throw new TypeError("fixed-price seller settlement resource URL is invalid");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed;
}

/**
 * Bind the paywall, canonical EVM observer and seller intake authority to one
 * authenticated rail. This prevents a host from composing settlement finality
 * for one chain/token with session authority or an HTTP route for another.
 */
export function createDacsFixedPriceX402SellerSettlementV1(
  options: Readonly<DacsFixedPriceX402SellerSettlementOptionsV1>,
): Readonly<DacsFixedPriceX402SellerSettlementV1> {
  if (!plainObject(options) || !plainObject(options.context) ||
      options.context.role !== "seller" || options.context.evm.role !== "seller" ||
      !plainObject(options.tokenDomain) ||
      typeof options.tokenDomain.name !== "string" ||
      typeof options.tokenDomain.version !== "string" ||
      typeof options.amount !== "string" || !INTEGER_RE.test(options.amount) ||
      options.amount.length > 78 || BigInt(options.amount) <= 0n ||
      BigInt(options.amount) > MAX_UINT256) {
    throw new TypeError("fixed-price seller settlement options are invalid");
  }
  const base = resourceBase(options.rail);
  const authority = createDacsFixedPriceX402SellerAuthorityV1({
    context: options.context,
    rail: options.rail,
    tokenDomain: options.tokenDomain,
  });
  const observer = createDacsX402SellerEvmObserverV1({
    rail: options.rail,
    rpcUrl: options.evmRpcUrl,
    authorizationSearchFromBlock: options.authorizationSearchFromBlock,
    ...(options.finalityTag === undefined ? {} : { finalityTag: options.finalityTag }),
    ...(options.logPageSize === undefined ? {} : { logPageSize: options.logPageSize }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  if (options.rail.asset.kind !== "erc20") {
    throw new TypeError("fixed-price seller settlement requires an ERC-20 rail");
  }
  const route = `${base.pathname}/:jobId`;
  const paywall: X402PaywallConfig = Object.freeze({
    route,
    network: observer.network,
    payTo: options.context.evm.address,
    amount: options.amount,
    asset: options.rail.asset.contract,
    eip712: Object.freeze({ ...options.tokenDomain }),
    facilitator: options.facilitator,
    ...(options.maxTimeoutSeconds === undefined
      ? {} : { maxTimeoutSeconds: options.maxTimeoutSeconds }),
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.mimeType === undefined ? {} : { mimeType: options.mimeType }),
    ...(options.serviceName === undefined ? {} : { serviceName: options.serviceName }),
  });
  const paymentIntakeDeps: Omit<SellerPaymentIntakeDeps, "receiptStore"> =
    Object.freeze({
      resolveCommittedAgreement: authority.resolveCommittedAgreement,
      resolveListingAtCommit: authority.resolveListingAtCommit,
      resolveRail: authority.resolveRail,
      resolveIdentityBundle: authority.resolveIdentityBundle,
      resolvePayerAddress: authority.resolvePayerAddress,
      resolvePayeeDestination: authority.resolvePayeeDestination,
      observeDemosTransfer: async () => Object.freeze({
        status: "unavailable" as const,
        reason: "pay-dem-observer-not-configured-for-x402-profile",
      }),
      observeX402Transfer: observer.observeX402Transfer,
      verifyX402ReceiptExtensions: observer.verifyX402ReceiptExtensions,
      classifyX402SettlementChain: observer.classifyX402SettlementChain,
    });
  const spine: SettlementSpineV1 = Object.freeze({
    reconcileSettlement: observer.reconcileSettlement,
    resolveCommittedSession: authority.resolveCommittedSession,
    paymentIntakeDeps,
  });
  const publicBaseUrl = `${base.origin}/`;
  const resolveHttpRequest: DacsSellerX402RuntimeOptionsV1["resolveHttpRequest"] =
    async (request) => {
      const prefix = `${base.pathname}/`;
      if (!request.pathname.startsWith(prefix)) return { status: "not-matched" };
      if (request.method !== "GET" || request.pathname.slice(prefix.length).includes("/")) {
        return { status: "rejected", reasonCode: "x402-resource-request-invalid" };
      }
      const jobId = request.pathname.slice(prefix.length);
      if (!JOB_ID_RE.test(jobId)) {
        return { status: "rejected", reasonCode: "x402-resource-job-invalid" };
      }
      try {
        const scope = await authority.resolveHttpScope(jobId);
        if (scope.httpResource !== request.url) {
          return { status: "rejected", reasonCode: "x402-resource-binding-mismatch" };
        }
        return {
          status: "matched",
          jobId,
          phaseIndex: scope.paymentPhaseIndex,
        };
      } catch {
        return { status: "rejected", reasonCode: "x402-resource-scope-unavailable" };
      }
    };

  return Object.freeze({
    paywall,
    publicBaseUrl,
    resolveHttpRequest,
    resolveOrderScope: authority.resolveOrderScope,
    authorizePaymentComplete: authority.authorizePaymentComplete,
    spine,
    authority,
    observer,
  });
}
