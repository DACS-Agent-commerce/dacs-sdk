import { DacsError } from "../errors.js";
import type { SettleRequest, SettleResult } from "../agent/runSessionCore.js";
import { createX402Rail, x402Settle } from "../rails/x402.js";
import { createEvmErc20Rail, evmErc20Settle } from "../rails/evmErc20.js";
import { createPayD402Rail, payD402Settle } from "../rails/payD402.js";
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
  paywall: { url: string; network: string; recipientEvm: string; phaseIndex?: number };
  /** JSON-RPC URL — required by the direct-transfer (evm-erc20) rail. */
  rpcUrl?: string;
  /** Demos node RPC URL — required by the D402 (pay-d402) rail. */
  demosRpc?: string;
  /** Demos wallet secret (mnemonic/private key) — required by the pay-d402 rail to sign payments. */
  demosSecret?: string;
  /**
   * Explicit opt-in to dispatch EXPERIMENTAL / non-`live` rails (currently
   * pay-d402, which isn't node-enabled). Off by default so a registry can't wire
   * a non-live rail as a production settlement path (RAV-R1).
   */
  allowExperimentalRails?: boolean;
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
        requireSessionBinding: true,
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
      const rail = await createPayD402Rail({
        rpc: opts.demosRpc,
        secret: opts.demosSecret,
        network: opts.paywall.network,
        fetchImpl: opts.fetchImpl,
        acknowledgeExperimental: true,
      });
      return payD402Settle(rail, {
        url: opts.paywall.url,
        recipient: opts.paywall.recipientEvm,
        network: opts.paywall.network,
      });
    }
    default:
      throw new DacsError(`unknown rail kind: ${descriptor.kind}`);
  }
}
