import { types as nodeTypes } from "node:util";

import { DacsError } from "../errors.js";
import { snapshotCanonicalJsonRead } from "../canonical/snapshot.js";
import type { SettleRequest, SettleResult } from "../agent/runSessionCore.js";
import { createX402Rail, x402Settle } from "../rails/x402.js";
import { createEvmErc20Rail, evmErc20Settle } from "../rails/evmErc20.js";
import {
  createPayDemRail,
  payDemSettle,
  type PayDemPreparedTransfer,
  type PayDemSettlementReconcile,
} from "../rails/payDem.js";
import type {
  SettlementIdempotencyStore,
} from "../rails/idempotency.js";
import {
  isAuthenticatedRailDefinition,
  type AuthenticatedRailDefinition,
} from "./resolve.js";

/**
 * Dispatch an authenticated DACS-4 RailDefinition to a concrete executor by
 * `railType`. This makes the money path registry-driven (T6) while RAV-R5's
 * private resolver provenance prevents a caller-created structural object from
 * becoming payment authority.
 */

export interface RailDispatchOptions {
  /** Buyer EVM private key used only by EVM-backed rails. */
  evmPrivateKey?: string;
  /**
   * Rail-neutral per-deal payment coordinates from the committed agreement.
   * `url` is required only for HTTP payment protocols; pay-DEM derives its
   * authoritative destination from the agreement and treats `recipient` only
   * as an optional PB-2 cross-check.
   */
  payment?: {
    url?: string;
    network?: string;
    recipient?: string;
    phaseIndex?: number;
  };
  /**
   * @deprecated Compatibility alias for pre-pay-DEM callers. New callers
   * should use `payment`; this EVM-shaped projection is not required by DEM.
   */
  paywall?: { url: string; network: string; recipientEvm: string; phaseIndex?: number };
  /** Trusted EVM JSON-RPC URL — required by x402 and evm-erc20 finality. */
  rpcUrl?: string;
  /** Demos node RPC URL — required by pay-dem and pay-d402. */
  demosRpc?: string;
  /** Demos wallet secret used by pay-dem and pay-d402 to sign payments. */
  demosSecret?: string;
  /**
   * Native pay-DEM operator-safety and PC-7 recovery dependencies. Production
   * restart recovery should supply all three of `settlementStore`,
   * `reconcile`, and `journalPreparedTransfer`; omitting them preserves the
   * low-level process-local compatibility behavior but is not restart-safe.
   */
  payDem?: {
    /** Maximum transfer amount plus confirmed Demos fees, in OS base units. */
    maxTotalDebitOs?: bigint;
    /** Durable pre-broadcast record of the signed hash and exact phase key. */
    journalPreparedTransfer?: (
      transfer: Readonly<PayDemPreparedTransfer>,
    ) => Promise<void>;
    /** Durable atomic settlement intent/outcome store. */
    settlementStore?: SettlementIdempotencyStore;
    /** Authoritative reconciliation for an unresolved retained intent. */
    reconcile?: PayDemSettlementReconcile;
    inclusionTimeoutMs?: number;
    inclusionPollIntervalMs?: number;
    statusRequestTimeoutMs?: number;
    nonceVisibilityTimeoutMs?: number;
  };
  /**
   * Trusted local RAV-R3 preflight. Required for operator_gated, closed_data,
   * bilateral, and mocked definitions. Mocked rails additionally require an
   * explicit non-production environment and can never run in production.
   */
  availabilityPolicy?: {
    environment: "production" | "non-production";
    authorize: (
      rail: Readonly<{
        railId: string;
        railVersion: number;
        railType: string;
        availability: string;
      }>,
    ) => boolean | Promise<boolean>;
  };
  /** Override fetch (tests / custom transport). */
  fetchImpl?: typeof fetch;
}

function bindDescriptorRequest(
  descriptor: Readonly<
    Pick<AuthenticatedRailDefinition, "railId" | "railType" | "phaseHandler">
  >,
  executor: (req: SettleRequest) => Promise<SettleResult>,
): (req: SettleRequest) => Promise<SettleResult> {
  const expectedPhase = descriptor.phaseHandler;
  return async (req) => {
    // Capture the two authority-bearing request fields once, then overwrite any
    // accessor/proxy values copied by the compatibility spread below. The rail
    // executor must receive the same descriptor id and phase that this gate
    // checked, even if a hostile request view changes between reads.
    const requestRail = req.rail;
    const requestPhase = req.phase;
    if (requestRail !== descriptor.railId) {
      throw new DacsError(
        `settlement request rail "${requestRail}" does not match authenticated definition "${descriptor.railId}"`,
      );
    }
    if (requestPhase !== expectedPhase) {
      throw new DacsError(
        `settlement request phase "${requestPhase}" does not match definition railType "${descriptor.railType}" (${expectedPhase})`,
      );
    }
    return executor({
      ...req,
      rail: requestRail,
      phase: requestPhase,
    });
  };
}

async function enforceAvailability(
  descriptor: Readonly<AuthenticatedRailDefinition>,
  policy: CapturedAvailabilityPolicy | undefined,
): Promise<void> {
  const availability = descriptor.availability;
  if (availability === "live") return;
  if (availability === "disabled" || availability === "failed") {
    throw new DacsError(
      `rail "${descriptor.railId}" availability=${availability}; RAV-R2 forbids settlement dispatch`,
    );
  }

  const environment = policy?.environment;
  const authorize = policy?.authorize;
  if (
    (environment !== "production" && environment !== "non-production") ||
    authorize === undefined
  ) {
    throw new DacsError(
      `rail "${descriptor.railId}" availability=${availability} requires a trusted local RAV-R3 preflight`,
    );
  }
  if (availability === "mocked" && environment !== "non-production") {
    throw new DacsError(
      `mocked rail "${descriptor.railId}" is forbidden in production`,
    );
  }

  const input = Object.freeze({
    railId: descriptor.railId,
    railVersion: descriptor.railVersion,
    railType: descriptor.railType,
    availability,
  });
  let approved: unknown;
  try {
    approved = await authorize(input);
  } catch (cause) {
    throw new DacsError(
      `rail "${descriptor.railId}" local availability preflight failed`,
      { cause },
    );
  }
  if (approved !== true) {
    throw new DacsError(
      `rail "${descriptor.railId}" local availability preflight did not authorize ${availability}`,
    );
  }
}

interface ResolvedPaymentCoordinates {
  url?: string;
  network?: string;
  recipient?: string;
  phaseIndex?: number;
}

type AvailabilityAuthorize = NonNullable<
  RailDispatchOptions["availabilityPolicy"]
>["authorize"];

interface CapturedAvailabilityPolicy {
  environment: "production" | "non-production";
  authorize?: AvailabilityAuthorize;
}

interface CapturedPayDemOptions {
  maxTotalDebitOs?: bigint;
  journalPreparedTransfer?: (
    transfer: Readonly<PayDemPreparedTransfer>,
  ) => Promise<void>;
  settlementStore?: SettlementIdempotencyStore;
  reconcile?: PayDemSettlementReconcile;
  inclusionTimeoutMs?: number;
  inclusionPollIntervalMs?: number;
  statusRequestTimeoutMs?: number;
  nonceVisibilityTimeoutMs?: number;
}

interface CapturedRailDispatchOptions {
  availabilityPolicy?: CapturedAvailabilityPolicy;
  payment: Readonly<ResolvedPaymentCoordinates>;
  evmPrivateKey?: string;
  rpcUrl?: string;
  demosRpc?: string;
  demosSecret?: string;
  payDem?: Readonly<CapturedPayDemOptions>;
  fetchImpl?: typeof fetch;
}

type DispatchMethod = (...args: never[]) => unknown;

function stableDispatchProperty(
  source: unknown,
  key: string,
  label: string,
): { found: boolean; value?: unknown } {
  if (
    (typeof source !== "object" && typeof source !== "function") ||
    source === null ||
    nodeTypes.isProxy(source)
  ) {
    throw new DacsError(`${label} must be stable data`);
  }
  let cursor: object | null = source;
  while (cursor !== null) {
    if (nodeTypes.isProxy(cursor)) {
      throw new DacsError(`${label} must be stable data`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
    if (descriptor !== undefined) {
      if (!("value" in descriptor)) {
        throw new DacsError(`${label} must be stable data`);
      }
      return { found: true, value: descriptor.value };
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  return { found: false };
}

function stableDispatchMethod<T extends DispatchMethod>(
  source: unknown,
  key: string,
  label: string,
): T {
  const property = stableDispatchProperty(source, key, label);
  if (
    !property.found ||
    typeof property.value !== "function" ||
    nodeTypes.isProxy(property.value)
  ) {
    throw new DacsError(`${label} must be a stable method`);
  }
  return Function.prototype.bind.call(property.value, source) as T;
}

function optionalDispatchMethod<T extends DispatchMethod>(
  source: unknown,
  key: string,
  label: string,
): T | undefined {
  const property = stableDispatchProperty(source, key, label);
  if (!property.found || property.value === undefined) return undefined;
  if (typeof property.value !== "function" || nodeTypes.isProxy(property.value)) {
    throw new DacsError(`${label} must be a stable method`);
  }
  return Function.prototype.bind.call(property.value, source) as T;
}

function optionalDispatchValue<T>(
  source: unknown,
  key: string,
  label: string,
): T | undefined {
  const property = stableDispatchProperty(source, key, label);
  return !property.found || property.value === undefined
    ? undefined
    : property.value as T;
}

function captureSettlementStore(
  source: SettlementIdempotencyStore | undefined,
): SettlementIdempotencyStore | undefined {
  if (source === undefined) return undefined;
  // Bind the selected operation to its original receiver now. Passing only
  // this frozen wrapper onward means an await-time mutation of `source.once`
  // cannot replace the write-ahead authority, while class private state keeps
  // working because the captured method still receives `source` as `this`.
  const once = stableDispatchMethod<SettlementIdempotencyStore["once"]>(
    source,
    "once",
    "pay-dem settlement store once",
  );
  const wrapper: SettlementIdempotencyStore = {
    once: (key, submit, reconcile) => once(key, submit, reconcile),
  };
  return Object.freeze(wrapper);
}

function capturePaymentCoordinates(
  opts: RailDispatchOptions,
): Readonly<ResolvedPaymentCoordinates> {
  const payment = optionalDispatchValue<NonNullable<RailDispatchOptions["payment"]>>(
    opts,
    "payment",
    "rail payment coordinates",
  );
  if (payment !== undefined) {
    return Object.freeze({
      url: optionalDispatchValue<string>(payment, "url", "rail payment url"),
      network: optionalDispatchValue<string>(
        payment,
        "network",
        "rail payment network",
      ),
      recipient: optionalDispatchValue<string>(
        payment,
        "recipient",
        "rail payment recipient",
      ),
      phaseIndex: optionalDispatchValue<number>(
        payment,
        "phaseIndex",
        "rail payment phaseIndex",
      ),
    });
  }
  const paywall = optionalDispatchValue<NonNullable<RailDispatchOptions["paywall"]>>(
    opts,
    "paywall",
    "legacy rail paywall coordinates",
  );
  if (paywall === undefined) return Object.freeze({});
  const phaseIndex = optionalDispatchValue<number>(
    paywall,
    "phaseIndex",
    "legacy rail paywall phaseIndex",
  );
  return Object.freeze({
    url: optionalDispatchValue<string>(paywall, "url", "legacy rail paywall url"),
    network: optionalDispatchValue<string>(
      paywall,
      "network",
      "legacy rail paywall network",
    ),
    recipient: optionalDispatchValue<string>(
      paywall,
      "recipientEvm",
      "legacy rail paywall recipient",
    ),
    ...(phaseIndex === undefined ? {} : { phaseIndex }),
  });
}

function captureAvailabilityPolicy(
  opts: RailDispatchOptions,
): CapturedAvailabilityPolicy | undefined {
  const policy = optionalDispatchValue<
    NonNullable<RailDispatchOptions["availabilityPolicy"]>
  >(
    opts,
    "availabilityPolicy",
    "rail availability policy",
  );
  if (policy === undefined) return undefined;
  const authorizeCandidate = optionalDispatchMethod<AvailabilityAuthorize>(
    policy,
    "authorize",
    "rail availability policy authorize",
  );
  return Object.freeze({
    environment: optionalDispatchValue<"production" | "non-production">(
      policy,
      "environment",
      "rail availability policy environment",
    ) as "production" | "non-production",
    ...(authorizeCandidate === undefined
      ? {}
      : { authorize: authorizeCandidate }),
  });
}

/**
 * Capture every caller-controlled authority needed by the selected rail before
 * the first asynchronous boundary. Optional peer loading and RAV-R3 callbacks
 * must not let a caller swap a destination, key, debit cap, or recovery store
 * after dispatch has begun.
 */
function captureDispatchOptions(
  opts: RailDispatchOptions,
  railType: string,
): Readonly<CapturedRailDispatchOptions> {
  const availabilityPolicy = captureAvailabilityPolicy(opts);
  const payment = capturePaymentCoordinates(opts);
  const common = {
    ...(availabilityPolicy === undefined ? {} : { availabilityPolicy }),
    payment,
  };

  if (railType === "x402") {
    const fetchImpl = optionalDispatchMethod<typeof fetch>(
      opts,
      "fetchImpl",
      "x402 fetch implementation",
    );
    return Object.freeze({
      ...common,
      evmPrivateKey: optionalDispatchValue<string>(
        opts,
        "evmPrivateKey",
        "x402 EVM private key",
      ),
      rpcUrl: optionalDispatchValue<string>(
        opts,
        "rpcUrl",
        "x402 EVM RPC URL",
      ),
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
  }
  if (railType === "evm-erc20") {
    return Object.freeze({
      ...common,
      evmPrivateKey: optionalDispatchValue<string>(
        opts,
        "evmPrivateKey",
        "EVM rail private key",
      ),
      rpcUrl: optionalDispatchValue<string>(
        opts,
        "rpcUrl",
        "EVM rail RPC URL",
      ),
    });
  }
  if (railType === "demos-native") {
    const payDem = optionalDispatchValue<NonNullable<RailDispatchOptions["payDem"]>>(
      opts,
      "payDem",
      "pay-dem dispatch options",
    );
    const capturedPayDem = payDem === undefined
      ? undefined
      : Object.freeze({
        maxTotalDebitOs: optionalDispatchValue<bigint>(
          payDem,
          "maxTotalDebitOs",
          "pay-dem maximum total debit",
        ),
        journalPreparedTransfer: optionalDispatchMethod<
          NonNullable<CapturedPayDemOptions["journalPreparedTransfer"]>
        >(
          payDem,
          "journalPreparedTransfer",
          "pay-dem prepared-transfer journal",
        ),
        settlementStore: captureSettlementStore(
          optionalDispatchValue<SettlementIdempotencyStore>(
            payDem,
            "settlementStore",
            "pay-dem settlement store",
          ),
        ),
        reconcile: optionalDispatchMethod<
          NonNullable<CapturedPayDemOptions["reconcile"]>
        >(payDem, "reconcile", "pay-dem reconciliation"),
        inclusionTimeoutMs: optionalDispatchValue<number>(
          payDem,
          "inclusionTimeoutMs",
          "pay-dem inclusion timeout",
        ),
        inclusionPollIntervalMs: optionalDispatchValue<number>(
          payDem,
          "inclusionPollIntervalMs",
          "pay-dem inclusion poll interval",
        ),
        statusRequestTimeoutMs: optionalDispatchValue<number>(
          payDem,
          "statusRequestTimeoutMs",
          "pay-dem status request timeout",
        ),
        nonceVisibilityTimeoutMs: optionalDispatchValue<number>(
          payDem,
          "nonceVisibilityTimeoutMs",
          "pay-dem nonce visibility timeout",
        ),
      });
    return Object.freeze({
      ...common,
      demosRpc: optionalDispatchValue<string>(
        opts,
        "demosRpc",
        "pay-dem Demos RPC URL",
      ),
      demosSecret: optionalDispatchValue<string>(
        opts,
        "demosSecret",
        "pay-dem Demos wallet secret",
      ),
      ...(capturedPayDem === undefined ? {} : { payDem: capturedPayDem }),
    });
  }
  return Object.freeze(common);
}

function requiredCoordinate(
  value: string | undefined,
  railKind: string,
  name: string,
): string {
  if (!value) throw new DacsError(`${railKind} rail requires opts.payment.${name}`);
  return value;
}

function requireMatchingNetwork(
  configured: string | undefined,
  expected: string,
  railType: string,
): string {
  if (configured !== undefined && configured !== expected) {
    throw new DacsError(
      `${railType} payment network "${configured}" does not match authenticated rail network "${expected}"`,
    );
  }
  return expected;
}

function resourceIsWithinBase(resource: string, base: string): boolean {
  try {
    const actual = new URL(resource);
    const allowed = new URL(base);
    if (actual.origin !== allowed.origin) return false;
    const prefix = allowed.pathname.endsWith("/")
      ? allowed.pathname
      : `${allowed.pathname}/`;
    return actual.pathname === allowed.pathname || actual.pathname.startsWith(prefix);
  } catch {
    return false;
  }
}

function requiredEvmPrivateKey(
  value: string | undefined,
  railKind: string,
): string {
  if (!value) {
    throw new DacsError(`${railKind} rail requires opts.evmPrivateKey`);
  }
  return value;
}

function requiredFinalityBlocks(
  descriptor: AuthenticatedRailDefinition,
): number {
  const value = descriptor.parameters["finalityBlocks"];
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new DacsError(
      `${descriptor.railType} rail "${descriptor.railId}" definition requires a positive parameters.finalityBlocks`,
    );
  }
  return value as number;
}

export async function settleFromRail(
  descriptor: AuthenticatedRailDefinition,
  opts: RailDispatchOptions,
): Promise<(req: SettleRequest) => Promise<SettleResult>> {
  if (!isAuthenticatedRailDefinition(descriptor)) {
    throw new DacsError(
      "settlement dispatch requires a rail returned by resolveRail (RAV-R5)",
    );
  }
  const capturedDescriptor = snapshotCanonicalJsonRead(
    descriptor,
    "authenticated rail descriptor",
  );
  if (
    typeof capturedDescriptor.railId !== "string" ||
    typeof capturedDescriptor.railVersion !== "number" ||
    typeof capturedDescriptor.railType !== "string" ||
    typeof capturedDescriptor.phaseHandler !== "string" ||
    capturedDescriptor.parameters === null ||
    typeof capturedDescriptor.parameters !== "object" ||
    Array.isArray(capturedDescriptor.parameters) ||
    capturedDescriptor.asset === null ||
    typeof capturedDescriptor.asset !== "object" ||
    Array.isArray(capturedDescriptor.asset) ||
    capturedDescriptor.network === null ||
    typeof capturedDescriptor.network !== "object" ||
    Array.isArray(capturedDescriptor.network)
  ) {
    throw new DacsError("authenticated rail descriptor has an invalid shape");
  }
  const capturedOptions = captureDispatchOptions(
    opts,
    capturedDescriptor.railType,
  );
  await enforceAvailability(
    descriptor,
    capturedOptions.availabilityPolicy,
  );
  const descriptorIdentity = Object.freeze({
    railId: capturedDescriptor.railId,
    railType: capturedDescriptor.railType,
    phaseHandler: capturedDescriptor.phaseHandler,
  });
  const payment = capturedOptions.payment;
  switch (capturedDescriptor.railType) {
    case "x402": {
      if (
        capturedDescriptor.asset.kind !== "erc20" ||
        capturedDescriptor.network.kind !== "x402-resource"
      ) {
        throw new DacsError(
          `x402 rail "${capturedDescriptor.railId}" is not an implemented ERC-20 x402 definition`,
        );
      }
      const url = requiredCoordinate(payment.url, "x402", "url");
      if (!resourceIsWithinBase(
        url,
        capturedDescriptor.network.resourceBaseUrl,
      )) {
        throw new DacsError(
          `x402 resource "${url}" is outside authenticated base "${capturedDescriptor.network.resourceBaseUrl}"`,
        );
      }
      const network = requireMatchingNetwork(
        payment.network,
        `eip155:${capturedDescriptor.asset.chainId}`,
        "x402",
      );
      const recipientEvm = requiredCoordinate(
        payment.recipient,
        "x402",
        "recipient",
      );
      if (!capturedOptions.rpcUrl) {
        throw new DacsError("x402 rail requires opts.rpcUrl for independent finality");
      }
      const rail = await createX402Rail({
        evmPrivateKey: requiredEvmPrivateKey(
          capturedOptions.evmPrivateKey,
          "x402",
        ),
        fetchImpl: capturedOptions.fetchImpl,
        requireSessionBinding: true,
        rpcUrl: capturedOptions.rpcUrl,
        finalityBlocks: requiredFinalityBlocks(capturedDescriptor),
      });
      return bindDescriptorRequest(descriptorIdentity, x402Settle(rail, {
        url,
        network,
        recipientEvm,
        ...(payment.phaseIndex === undefined
          ? {}
          : { phaseIndex: payment.phaseIndex }),
        asset: capturedDescriptor.asset.contract,
      }));
    }
    case "evm-erc20": {
      if (
        capturedDescriptor.asset.kind !== "erc20" ||
        capturedDescriptor.network.kind !== "evm"
      ) {
        throw new DacsError(
          `evm-erc20 rail "${capturedDescriptor.railId}" has incompatible asset or network`,
        );
      }
      if (!capturedOptions.rpcUrl) {
        throw new DacsError("evm-erc20 rail requires opts.rpcUrl");
      }
      const network = requireMatchingNetwork(
        payment.network,
        `eip155:${capturedDescriptor.network.chainId}`,
        "evm-erc20",
      );
      const recipientEvm = requiredCoordinate(
        payment.recipient,
        "evm-erc20",
        "recipient",
      );
      const rail = await createEvmErc20Rail({
        evmPrivateKey: requiredEvmPrivateKey(
          capturedOptions.evmPrivateKey,
          "evm-erc20",
        ),
        rpcUrl: capturedOptions.rpcUrl,
        network,
        finalityBlocks: requiredFinalityBlocks(descriptor),
      });
      return bindDescriptorRequest(descriptorIdentity, evmErc20Settle(rail, {
        tokenAddress: capturedDescriptor.asset.contract,
        network,
        recipientEvm,
      }));
    }
    case "demos-native": {
      if (
        capturedDescriptor.asset.kind !== "native-dem" ||
        capturedDescriptor.network.kind !== "demos" ||
        capturedDescriptor.phaseHandler !== "pay-dem"
      ) {
        throw new DacsError(
          `pay-dem rail "${capturedDescriptor.railId}" must bind native-dem, demos, and pay-dem (§9.5.9 step 1)`,
        );
      }
      // Native DEM transfer rail (§9.5.9, live). The recipient + network are
      // derived from the agreement; the Demos RPC + wallet secret are caller
      // secrets. A supplied recipient can only cross-check that destination.
      if (!capturedOptions.demosRpc) {
        throw new DacsError("pay-dem rail requires opts.demosRpc");
      }
      if (!capturedOptions.demosSecret) {
        throw new DacsError("pay-dem rail requires opts.demosSecret");
      }
      const payDem = capturedOptions.payDem;
      const maxTotalDebitOs = payDem?.maxTotalDebitOs;
      const journalPreparedTransfer = payDem?.journalPreparedTransfer;
      const settlementStore = payDem?.settlementStore;
      const reconcile = payDem?.reconcile;
      const inclusionTimeoutMs = payDem?.inclusionTimeoutMs;
      const inclusionPollIntervalMs = payDem?.inclusionPollIntervalMs;
      const statusRequestTimeoutMs = payDem?.statusRequestTimeoutMs;
      const nonceVisibilityTimeoutMs = payDem?.nonceVisibilityTimeoutMs;
      const demNetwork = requireMatchingNetwork(
        payment.network,
        "demos",
        "pay-dem",
      );
      const demRecipient = payment.recipient;
      const demPhaseIndex = payment.phaseIndex;
      const rail = await createPayDemRail({
        rpc: capturedOptions.demosRpc,
        secret: capturedOptions.demosSecret,
        network: demNetwork,
        ...(maxTotalDebitOs === undefined
          ? {}
          : { maxTotalDebitOs }),
        ...(journalPreparedTransfer === undefined
          ? {}
          : { journalPreparedTransfer }),
        ...(inclusionTimeoutMs === undefined
          ? {}
          : { inclusionTimeoutMs }),
        ...(inclusionPollIntervalMs === undefined
          ? {}
          : { inclusionPollIntervalMs }),
        ...(statusRequestTimeoutMs === undefined
          ? {}
          : { statusRequestTimeoutMs }),
        ...(nonceVisibilityTimeoutMs === undefined
          ? {}
          : { nonceVisibilityTimeoutMs }),
      });
      return bindDescriptorRequest(descriptorIdentity, payDemSettle(rail, {
        ...(demRecipient === undefined
          ? {}
          : { recipient: demRecipient }),
        network: demNetwork,
        railId: descriptorIdentity.railId,
        ...(demPhaseIndex === undefined
          ? {}
          : { phaseIndex: demPhaseIndex }),
      }, {
        ...(settlementStore === undefined
          ? {}
          : { store: settlementStore }),
        ...(reconcile === undefined
          ? {}
          : { reconcile }),
      }));
    }
    default:
      throw new DacsError(
        `rail type "${capturedDescriptor.railType}" is valid but not implemented by this SDK dispatch surface`,
      );
  }
}
