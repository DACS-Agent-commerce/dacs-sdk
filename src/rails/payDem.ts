import type { SettleRequest, SettleResult } from "../agent/runSessionCore.js";
import { DacsError } from "../errors.js";

/**
 * pay-dem settlement rail — native DEM transfer (DACS-4 §9.5.9, SR-4).
 *
 * The plain native path: the buyer submits a `demos.transfer` of the agreed DEM
 * amount straight to the seller's address; the cosigned agreement + the on-chain
 * transfer ARE the settlement (no HTTP 402 flow — that's the separate,
 * experimental pay-d402). This is the live-settleable native rail: for Demos,
 * BFT *inclusion IS finality*, so the evidence carries `settlementFinality.model:
 * "bft-final"` and a `demos` txRef (hash + block height).
 *
 * INCLUSION-GATED (§9.5.9): `bft-final` is emitted ONLY on observed inclusion —
 * a terminal `included`/`confirmed`/`finalized` state AND the finality-witness
 * block height. Broadcast *acceptance* (the node took the tx for submission) is
 * NOT finality: a merely-accepted tx can still be rejected in consensus, dropped,
 * or never included, so minting evidence on acceptance would attest an unobserved
 * payment. A transfer that doesn't reach observed inclusion settles `ok: false`
 * and no finality is stamped — evidence is never minted for a payment we didn't
 * see land.
 *
 * Amounts are integer OS base units (matching DACS Price.amount) — never floats.
 * payDemSettleCore is pure over an injected native client, so it's tested
 * without a Demos node; createPayDemRail is the thin demosdk wiring
 * (transfer → confirm → broadcastAndWait, gated on the terminal inclusion state).
 */

export interface PayDemSettleParams {
  /** Recipient Demos address (payee). */
  recipient: string;
  /** Amount in integer OS base units (string). */
  amount: string;
  /** Network label recorded on the evidence (default "demos"). */
  network?: string;
}

/** The result of submitting a native transfer (sign → confirm → broadcastAndWait). */
export interface DemosTransferResult {
  ok: boolean;
  hash: string;
  /**
   * The terminal transaction state the client observed. `bft-final` is emitted
   * only for an inclusion state ({@link TERMINAL_INCLUDED}); any other state
   * (`failed`, `timeout`, a nonterminal poll, …) is not observed finality.
   */
  state?: string;
  /** The block height the tx landed at — the §9.5.9 finality witness. */
  blockNumber?: number;
  message?: string;
}

/**
 * Terminal states that count as observed inclusion for `bft-final`. The Demos
 * node reports `included`; `confirmed`/`finalized` are accepted for forward
 * compatibility with substrates that name the terminal inclusion state differently.
 */
export const TERMINAL_INCLUDED = new Set(["included", "confirmed", "finalized"]);

/** Minimal structural view of the native-transfer client this rail depends on. */
export interface DemosNativeClient {
  /** The payer's Demos address. */
  address: string;
  /** Sign, confirm, and broadcast a native DEM transfer; resolve its receipt. */
  transfer(args: { to: string; amountOs: bigint }): Promise<DemosTransferResult>;
}

export async function payDemSettleCore(
  params: PayDemSettleParams,
  client: DemosNativeClient,
): Promise<SettleResult> {
  let amountOs: bigint;
  try {
    amountOs = BigInt(params.amount);
  } catch {
    throw new DacsError(`pay-dem: invalid OS base-unit amount ${params.amount}`);
  }
  if (amountOs <= 0n) {
    throw new DacsError(`pay-dem: amount must be > 0 (got ${params.amount})`);
  }

  const res = await client.transfer({ to: params.recipient, amountOs });
  const txHash = (res?.hash ?? "").trim();
  const chainId = params.network ?? "demos";

  // Observed inclusion (§9.5.9): a verifiable tx id AND a terminal inclusion
  // state AND the finality-witness block height. Broadcast acceptance alone is
  // NOT finality — without these three, we do not stamp bft-final, because the
  // tx may never have landed.
  const observedFinal =
    res?.ok === true &&
    txHash.length > 0 &&
    res?.state !== undefined &&
    TERMINAL_INCLUDED.has(res.state) &&
    typeof res?.blockNumber === "number";

  if (!observedFinal) {
    return {
      ok: false,
      txHash,
      chainId,
      payer: client.address,
      payee: params.recipient,
      // No finality / blockNumber: inclusion was not observed, so no bft-final
      // evidence is minted for a possibly-unincluded payment.
    };
  }

  return {
    ok: true,
    txHash,
    chainId,
    payer: client.address,
    payee: params.recipient,
    // §9.5.9: inclusion IS finality on Demos; the tx is a `demos` ref carrying
    // the block height that witnesses it.
    finality: { model: "bft-final" },
    blockNumber: res.blockNumber,
    txRefKind: "demos",
  };
}

export interface PayDemRailConfig {
  /** Demos node RPC URL. */
  rpc: string;
  /** Buyer wallet secret — mnemonic or private key — used to sign the transfer. */
  secret: string;
  /** Network label recorded on the evidence (default "demos"). */
  network?: string;
}

export interface PayDemRail {
  /** The buyer's Demos address. */
  readonly address: string;
  /** Settle one session's payment via a native DEM transfer. */
  settle(params: PayDemSettleParams): Promise<SettleResult>;
}

/**
 * Construct a pay-dem rail from a Demos RPC + wallet secret. Lazily imports
 * demosdk so the SDK core stays importable without the chain deps installed.
 * Submits via the proven sign → confirm → broadcast flow.
 */
export async function createPayDemRail(config: PayDemRailConfig): Promise<PayDemRail> {
  if (!config?.rpc) throw new DacsError("pay-dem rail requires an rpc URL");
  if (!config?.secret) throw new DacsError("pay-dem rail requires a wallet secret to sign transfers");

  const { Demos } = await import("@kynesyslabs/demosdk/websdk");
  const demos = new Demos();
  await demos.connect(config.rpc);
  await demos.connectWallet(config.secret);

  const client: DemosNativeClient = {
    address: demos.getAddress(),
    transfer: async ({ to, amountOs }) => {
      const signed = await demos.transfer(to, amountOs);
      const validity = await demos.tx.confirm(signed, demos);
      const fallbackHash = (signed as { hash?: string }).hash ?? "";
      try {
        // broadcastAndWait POLLS to a terminal state (included|failed) instead
        // of returning on broadcast acceptance — so `ok`/`bft-final` reflect
        // observed inclusion, and `status.blockNumber` gives the finality witness.
        const { broadcast, status } = (await demos.broadcastAndWait(validity)) as {
          broadcast: { response?: { hash?: string; message?: string } };
          status: { state: "included" | "failed"; blockNumber?: number };
        };
        return {
          ok: status.state === "included",
          state: status.state,
          hash: broadcast?.response?.hash ?? fallbackHash,
          blockNumber: status.blockNumber,
          message: broadcast?.response?.message,
        };
      } catch (err) {
        // Timeout / broadcast failure → no terminal inclusion observed. Report a
        // non-final result (ok:false) rather than throwing, so the settle seam
        // records a failed payment and never mints bft-final for an unseen tx.
        return {
          ok: false,
          state: "timeout",
          hash: fallbackHash,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };

  return {
    address: client.address,
    settle: (params) =>
      payDemSettleCore({ ...params, network: params.network ?? config.network ?? "demos" }, client),
  };
}

/** Bridge a PayDemRail to the runSession `settle` seam. */
export function payDemSettle(
  rail: PayDemRail,
  cfg: { recipient: string; network?: string },
): (req: SettleRequest) => Promise<SettleResult> {
  return (req) =>
    rail.settle({
      recipient: cfg.recipient,
      amount: req.amount,
      network: cfg.network ?? "demos",
    });
}
