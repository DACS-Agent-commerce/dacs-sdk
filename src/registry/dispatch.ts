import { DacsError } from "../errors.js";
import type { SettleRequest, SettleResult } from "../agent/runSessionCore.js";
import { createX402Rail, x402Settle } from "../rails/x402.js";
import { createEvmErc20Rail, evmErc20Settle } from "../rails/evmErc20.js";
import { createPayD402Rail, payD402Settle } from "../rails/payD402.js";
import {
  createPayDemRail,
  payDemSettle,
  type PayDemPreparedTransfer,
} from "../rails/payDem.js";
import type {
  SettlementIdempotencyStore,
  SettlementReconcile,
} from "../rails/idempotency.js";
import type { RailDescriptor } from "./types.js";

/**
 * Dispatch a resolved rail descriptor to a concrete settle executor by `kind`.
 * This is what makes the money path registry-driven (T6): switching a listing's
 * rail id between already-supported kinds needs no SDK change — the resolved
 * descriptor's `kind` selects the implementation. A brand-new kind is one new
 * case here plus its registry entry.
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
  /** JSON-RPC URL — required by the direct-transfer (evm-erc20) rail. */
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
    reconcile?: SettlementReconcile;
    inclusionTimeoutMs?: number;
    inclusionPollIntervalMs?: number;
    statusRequestTimeoutMs?: number;
    nonceVisibilityTimeoutMs?: number;
  };
  /**
   * Explicit opt-in to dispatch EXPERIMENTAL / non-`live` rails (currently
   * pay-d402, which isn't node-enabled). Off by default so a registry can't wire
   * a non-live rail as a production settlement path (RAV-R1).
   */
  allowExperimentalRails?: boolean;
  /** Override fetch (tests / custom transport). */
  fetchImpl?: typeof fetch;
}

interface ResolvedPaymentCoordinates {
  url?: string;
  network?: string;
  recipient?: string;
  phaseIndex?: number;
}

function paymentCoordinates(opts: RailDispatchOptions): ResolvedPaymentCoordinates {
  if (opts.payment) return opts.payment;
  if (!opts.paywall) return {};
  return {
    url: opts.paywall.url,
    network: opts.paywall.network,
    recipient: opts.paywall.recipientEvm,
    ...(opts.paywall.phaseIndex === undefined
      ? {}
      : { phaseIndex: opts.paywall.phaseIndex }),
  };
}

function requiredCoordinate(
  value: string | undefined,
  railKind: string,
  name: string,
): string {
  if (!value) throw new DacsError(`${railKind} rail requires opts.payment.${name}`);
  return value;
}

function requiredEvmPrivateKey(
  opts: RailDispatchOptions,
  railKind: string,
): string {
  if (!opts.evmPrivateKey) {
    throw new DacsError(`${railKind} rail requires opts.evmPrivateKey`);
  }
  return opts.evmPrivateKey;
}

export async function settleFromRail(
  descriptor: RailDescriptor,
  opts: RailDispatchOptions,
): Promise<(req: SettleRequest) => Promise<SettleResult>> {
  const payment = paymentCoordinates(opts);
  switch (descriptor.kind) {
    case "x402": {
      // The expected token is rail config (steward-signed descriptor params) —
      // exactly like evm-erc20 — so the §4.1 asset guard compares the 402's
      // token against a canonical on-chain id, not the Price.asset symbol.
      const tokenAddress = descriptor.params["tokenAddress"];
      if (typeof tokenAddress !== "string") {
        throw new DacsError(
          `x402 rail "${descriptor.id}" descriptor missing params.tokenAddress`,
        );
      }
      const url = requiredCoordinate(payment.url, "x402", "url");
      const network = requiredCoordinate(payment.network, "x402", "network");
      const recipientEvm = requiredCoordinate(
        payment.recipient,
        "x402",
        "recipient",
      );
      const rail = await createX402Rail({
        evmPrivateKey: requiredEvmPrivateKey(opts, "x402"),
        fetchImpl: opts.fetchImpl,
        requireSessionBinding: true,
      });
      return x402Settle(rail, {
        url,
        network,
        recipientEvm,
        ...(payment.phaseIndex === undefined
          ? {}
          : { phaseIndex: payment.phaseIndex }),
        asset: tokenAddress,
      });
    }
    case "evm-erc20": {
      // The token contract is rail config (registry params); the recipient +
      // network are per-deal (paywall); the RPC is a caller secret.
      const tokenAddress = descriptor.params["tokenAddress"];
      if (typeof tokenAddress !== "string") {
        throw new DacsError(
          `evm-erc20 rail "${descriptor.id}" descriptor missing params.tokenAddress`,
        );
      }
      if (!opts.rpcUrl) {
        throw new DacsError("evm-erc20 rail requires opts.rpcUrl");
      }
      const network = requiredCoordinate(
        payment.network,
        "evm-erc20",
        "network",
      );
      const recipientEvm = requiredCoordinate(
        payment.recipient,
        "evm-erc20",
        "recipient",
      );
      const rail = await createEvmErc20Rail({
        evmPrivateKey: requiredEvmPrivateKey(opts, "evm-erc20"),
        rpcUrl: opts.rpcUrl,
        network,
      });
      return evmErc20Settle(rail, {
        tokenAddress,
        network,
        recipientEvm,
      });
    }
    case "d402": {
      // EXPERIMENTAL D402 rail (§9.4.4 non-`live`, not node-enabled). The
      // recipient + network are per-deal (paywall); the Demos RPC + wallet secret
      // are caller secrets. `payTo` carries the Demos recipient address (reusing
      // the paywall's recipient field). RAV-R1: refuse to dispatch it unless the
      // caller explicitly opts into experimental rails.
      if (!opts.allowExperimentalRails) {
        throw new DacsError(
          "pay-d402 is EXPERIMENTAL and not node-enabled (RAV-R1: MUST NOT be selected as a live rail); " +
            "set opts.allowExperimentalRails: true to dispatch it for preview use",
        );
      }
      if (!opts.demosRpc) {
        throw new DacsError("pay-d402 rail requires opts.demosRpc");
      }
      if (!opts.demosSecret) {
        throw new DacsError("pay-d402 rail requires opts.demosSecret");
      }
      const url = requiredCoordinate(payment.url, "pay-d402", "url");
      const network = requiredCoordinate(
        payment.network,
        "pay-d402",
        "network",
      );
      const recipient = requiredCoordinate(
        payment.recipient,
        "pay-d402",
        "recipient",
      );
      const rail = await createPayD402Rail({
        rpc: opts.demosRpc,
        secret: opts.demosSecret,
        network,
        fetchImpl: opts.fetchImpl,
        acknowledgeExperimental: true,
      });
      return payD402Settle(rail, {
        url,
        recipient,
        network,
      });
    }
    case "dem": {
      // Native DEM transfer rail (§9.5.9, live). The recipient + network are
      // derived from the agreement; the Demos RPC + wallet secret are caller
      // secrets. A supplied recipient can only cross-check that destination.
      if (!opts.demosRpc) {
        throw new DacsError("pay-dem rail requires opts.demosRpc");
      }
      if (!opts.demosSecret) {
        throw new DacsError("pay-dem rail requires opts.demosSecret");
      }
      const payDem = opts.payDem;
      // Capture every recovery authority before the first await. A caller that
      // mutates its options while the optional peer connects must not be able
      // to swap the debit cap, preparation journal, durable log, or reconciler.
      const maxTotalDebitOs = payDem?.maxTotalDebitOs;
      const journalPreparedTransfer = payDem?.journalPreparedTransfer;
      const settlementStore = payDem?.settlementStore;
      const reconcile = payDem?.reconcile;
      const inclusionTimeoutMs = payDem?.inclusionTimeoutMs;
      const inclusionPollIntervalMs = payDem?.inclusionPollIntervalMs;
      const statusRequestTimeoutMs = payDem?.statusRequestTimeoutMs;
      const nonceVisibilityTimeoutMs = payDem?.nonceVisibilityTimeoutMs;
      const demNetwork = payment.network ?? "demos";
      const demRecipient = payment.recipient;
      const rail = await createPayDemRail({
        rpc: opts.demosRpc,
        secret: opts.demosSecret,
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
      return payDemSettle(rail, {
        ...(demRecipient === undefined
          ? {}
          : { recipient: demRecipient }),
        network: demNetwork,
      }, {
        ...(settlementStore === undefined
          ? {}
          : { store: settlementStore }),
        ...(reconcile === undefined
          ? {}
          : { reconcile }),
      });
    }
    default:
      throw new DacsError(`unknown rail kind: ${descriptor.kind}`);
  }
}
