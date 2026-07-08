import type { SettleRequest, SettleResult } from "../agent/runSessionCore.js";
import { DacsError } from "../errors.js";

/**
 * pay-dem settlement rail — native DEM transfer (DACS-4 §9.5.9, SR-4).
 *
 * The plain native path: the buyer submits a `demos.transfer` of the agreed DEM
 * amount straight to the seller's address; the cosigned agreement + the on-chain
 * transfer ARE the settlement (no HTTP 402 flow — that's the separate,
 * experimental pay-d402). This is the live-settleable native rail: Demos reaches
 * BFT finality on inclusion, so the evidence carries `settlementFinality.model:
 * "bft-final"` and a `demos` txRef (hash + block height).
 *
 * Amounts are integer OS base units (matching DACS Price.amount) — never floats.
 * payDemSettleCore is pure over an injected native client, so it's tested
 * without a Demos node; createPayDemRail is the thin demosdk wiring
 * (transfer → confirm → broadcast).
 */

export interface PayDemSettleParams {
  /** Recipient Demos address (payee). */
  recipient: string;
  /** Amount in integer OS base units (string). */
  amount: string;
  /** Network label recorded on the evidence (default "demos"). */
  network?: string;
}

/** The result of submitting a native transfer (sign → confirm → broadcast). */
export interface DemosTransferResult {
  ok: boolean;
  hash: string;
  blockNumber?: number;
  message?: string;
}

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

  return {
    // Money-safe: a success needs a verifiable on-chain tx id, not just an ok flag.
    ok: res?.ok === true && txHash.length > 0,
    txHash,
    chainId: params.network ?? "demos",
    payer: client.address,
    payee: params.recipient,
    // §9.5.9: native DEM reaches BFT finality on inclusion; the tx is a `demos`
    // ref carrying the block height.
    finality: { model: "bft-final" },
    ...(res?.blockNumber !== undefined ? { blockNumber: res.blockNumber } : {}),
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
      const broadcast = (await demos.tx.broadcast(validity, demos)) as {
        result?: number;
        response?: { hash?: string; blockNumber?: number; message?: string };
      };
      const ok = broadcast?.result === 200;
      return {
        ok,
        hash: broadcast?.response?.hash ?? (signed as { hash?: string }).hash ?? "",
        blockNumber: broadcast?.response?.blockNumber,
        message: broadcast?.response?.message,
      };
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
