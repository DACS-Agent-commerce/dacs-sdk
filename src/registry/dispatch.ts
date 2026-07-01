import { DacsError } from "../errors.js";
import type { SettleRequest, SettleResult } from "../agent/runSessionCore.js";
import { createX402Rail, x402Settle } from "../rails/x402.js";
import { createEvmErc20Rail, evmErc20Settle } from "../rails/evmErc20.js";
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
  /** JSON-RPC URL — required by the direct-transfer (evm-erc20) rail. */
  rpcUrl?: string;
  /** Override fetch (tests / custom transport). */
  fetchImpl?: typeof fetch;
}

export async function settleFromRail(
  descriptor: RailDescriptor,
  opts: RailDispatchOptions,
): Promise<(req: SettleRequest) => Promise<SettleResult>> {
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
      const rail = await createX402Rail({
        evmPrivateKey: opts.evmPrivateKey,
        fetchImpl: opts.fetchImpl,
      });
      return x402Settle(rail, { ...opts.paywall, asset: tokenAddress });
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
      const rail = await createEvmErc20Rail({
        evmPrivateKey: opts.evmPrivateKey,
        rpcUrl: opts.rpcUrl,
        network: opts.paywall.network,
      });
      return evmErc20Settle(rail, {
        tokenAddress,
        network: opts.paywall.network,
        recipientEvm: opts.paywall.recipientEvm,
      });
    }
    default:
      throw new DacsError(`unknown rail kind: ${descriptor.kind}`);
  }
}
