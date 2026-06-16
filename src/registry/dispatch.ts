import { DacsError, NotImplementedError } from "../errors.js";
import type { SettleRequest, SettleResult } from "../agent/runSessionCore.js";
import { createX402Rail, x402Settle } from "../rails/x402.js";
import type { RailDescriptor } from "./types.js";

/**
 * Dispatch a resolved rail descriptor to a concrete settle executor by `kind`.
 * This is what makes the money path registry-driven (T6): switching a listing's
 * rail id between already-supported kinds needs no SDK change — the resolved
 * descriptor's `kind` selects the implementation. A brand-new kind is one new
 * case here plus its registry entry.
 */

export interface RailDispatchOptions {
  /** Buyer EVM private key used by EVM rails to sign payment. */
  evmPrivateKey: string;
  /** Per-deal paywall coordinates (from the listing/agreement, not the registry). */
  paywall: { url: string; network: string; recipientEvm: string };
  /** Override fetch (tests / custom transport). */
  fetchImpl?: typeof fetch;
}

export async function settleFromRail(
  descriptor: RailDescriptor,
  opts: RailDispatchOptions,
): Promise<(req: SettleRequest) => Promise<SettleResult>> {
  switch (descriptor.kind) {
    case "x402": {
      const rail = await createX402Rail({
        evmPrivateKey: opts.evmPrivateKey,
        fetchImpl: opts.fetchImpl,
      });
      return x402Settle(rail, opts.paywall);
    }
    case "evm-erc20":
      // Second reference rail (direct USDC transfer) — slot reserved; the
      // registry/dispatch model already supports it, the executor lands next.
      throw new NotImplementedError(
        "evm-erc20 rail",
        "T6 — direct ERC-20 transfer rail",
      );
    default:
      throw new DacsError(`unknown rail kind: ${descriptor.kind}`);
  }
}
