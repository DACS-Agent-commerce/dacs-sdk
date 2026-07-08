import type { SettleRequest, SettleResult } from "../agent/runSessionCore.js";
import { CounterpartyError, DacsError } from "../errors.js";

/**
 * pay-d402 settlement rail — the D402 HTTP-402 protocol on Demos (SR-4).
 *
 * D402 is Demos's native analogue of x402: the seller's deliverable is
 * paywalled and returns an HTTP 402 advertising a payment requirement
 * (recipient + amount in native units + a resource id). Unlike x402 — where the
 * facilitator settles on-chain and hands back a tx via a response header — the
 * D402 buyer signs and broadcasts a gasless `d402_payment` transaction itself,
 * so `settle()` returns the settlement tx hash directly (that hash IS the
 * payment proof).
 *
 * Per DACS §4.1 the buyer MUST abort before paying if the 402's advertised
 * terms don't match the negotiated agreement (termsMatchD402) — otherwise
 * auto-pay could settle the wrong recipient or amount.
 *
 * ⚠️ EXPERIMENTAL — NOT node-enabled. D402 processing (`d402_payment`) is not
 * live on production Demos nodes yet: the client half exists, the node side does
 * not process the tx. This rail therefore CANNOT settle live today, and per the
 * RAV-R1 discipline ("MUST NOT treat a non-`live` rail as live") it must not be
 * selected as a production settlement path. `createPayD402Rail` refuses to build
 * unless the caller passes `acknowledgeExperimental: true`, so it can't be wired
 * as `live` by accident. It graduates when the node ships d402 processing.
 *
 * NOTE ON NAMING: this is `pay-d402` (the HTTP-402 protocol rail), distinct from
 * the spec's `pay-dem` (§9.5.9) — the plain `demos.transfer` native rail, which
 * is a separate, live-proven path (evidence `txRef` kind `demos`, `bft-final`).
 *
 * payD402SettleCore is pure over a minimal client interface + an injected fetch,
 * so it's unit-tested without a Demos node; createPayD402Rail() is the thin
 * wiring that constructs the real demosdk D402Client from a connected wallet.
 */

/** The 402-advertised payment requirement (demosdk D402PaymentRequirement shape). */
export interface D402PaymentRequirement {
  /** Payment amount: pre-fork `number` DEM or post-fork `string` OS base units. */
  amount: string | number;
  /** Recipient Demos address (payee). */
  recipient: string;
  /** Resource identifier the payment unlocks. */
  resourceId: string;
  /** Optional human description (folded into the tx memo). */
  description?: string;
}

/** Settlement result from a broadcast d402_payment (demosdk D402SettlementResult). */
export interface D402SettlementResult {
  success: boolean;
  hash: string;
  blockNumber?: number;
  message?: string;
}

/** Minimal structural view of the demosdk D402Client this rail depends on. */
export interface D402ClientLike {
  createPayment(requirement: D402PaymentRequirement): Promise<unknown>;
  settle(payment: unknown): Promise<D402SettlementResult>;
}

/** Per-session settlement inputs, derived from the negotiated agreement. */
export interface PayD402SettleParams {
  /** Seller's paywalled delivery URL (returns HTTP 402). */
  paywallUrl: string;
  /** Negotiated recipient Demos address (the expected payTo). */
  recipient: string;
  /** Negotiated price in integer base units (matching DACS Price.amount). */
  amount: string;
  /** Network label recorded on the evidence (e.g. "demos:mainnet"). */
  network: string;
  requestInit?: RequestInit;
}

/** Numeric equality over integer base-unit amounts (tolerant of leading zeros / dual number|string shape). */
function sameAmount(a: string, b: string): boolean {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return a === b;
  }
}

/**
 * DACS §4.1 abort guard for D402: the 402's offered terms MUST match the
 * negotiated agreement. Recipient compared case-insensitively; amount compared
 * as integer base units (DACS Price.amount is already base units — no decimal
 * conversion, so the on-chain and agreed amounts can never silently diverge).
 * D402 is native-DEM only, so there is no network/asset to reconcile.
 */
export function termsMatchD402(
  expected: { recipient: string; amount: string },
  offered: { recipient: string; amount: string },
): { ok: boolean; reason?: string } {
  if (offered.recipient.trim().toLowerCase() !== expected.recipient.trim().toLowerCase()) {
    return {
      ok: false,
      reason: `recipient mismatch: 402 says ${offered.recipient}, agreement says ${expected.recipient}`,
    };
  }
  if (!sameAmount(offered.amount, expected.amount)) {
    return {
      ok: false,
      reason: `amount mismatch: 402 says ${offered.amount}, agreement says ${expected.amount}`,
    };
  }
  return { ok: true };
}

/** Parse + validate a 402 JSON body into a D402PaymentRequirement. */
function parseRequirement(body: unknown): D402PaymentRequirement {
  const b = body as Record<string, unknown> | null;
  const recipient = b?.["recipient"];
  const amount = b?.["amount"];
  const resourceId = b?.["resourceId"];
  if (typeof recipient !== "string" || recipient.trim() === "") {
    throw new CounterpartyError("d402: 402 body missing a string `recipient`");
  }
  // Unit safety (fork boundary): the §4.1 guard compares the 402 amount against
  // the agreement's OS base-unit amount as BigInt. A pre-fork node advertising a
  // bare-DEM `number` (e.g. 1 = 1 DEM) would then mismatch a base-unit agreement
  // (1e9 OS) and abort a legitimate payment — a silent interop gap. So require
  // the 402 to advertise OS base units as a string and reject a bare-DEM number
  // explicitly, rather than guess the unit. (Post-fork public nodes send string
  // OS; this only rejects the ambiguous pre-fork number path.)
  if (typeof amount === "number") {
    throw new CounterpartyError(
      "d402: 402 `amount` is a bare number (pre-fork DEM); D402 settlement requires OS base units as a string",
    );
  }
  if (typeof amount !== "string" || amount.trim() === "") {
    throw new CounterpartyError("d402: 402 body missing a string `amount` (OS base units)");
  }
  if (typeof resourceId !== "string" || resourceId.trim() === "") {
    throw new CounterpartyError("d402: 402 body missing a string `resourceId`");
  }
  const description = typeof b?.["description"] === "string" ? (b["description"] as string) : undefined;
  return { recipient, amount, resourceId, ...(description ? { description } : {}) };
}

export interface PayD402SettleCoreDeps {
  client: D402ClientLike;
  fetchImpl: typeof fetch;
  /** The buyer's Demos address (recorded as `payer` on the result). */
  payerAddress: string;
}

/**
 * Run the buyer-side D402 flow and return DACS SettlementEvidence inputs.
 * Aborts before signing if the advertised requirement doesn't match the
 * agreement.
 */
export async function payD402SettleCore(
  params: PayD402SettleParams,
  deps: PayD402SettleCoreDeps,
): Promise<SettleResult> {
  const { client, fetchImpl, payerAddress } = deps;

  // 1. Initial request — expect a 402 with a payment requirement.
  const initial = await fetchImpl(params.paywallUrl, params.requestInit);
  if (initial.status !== 402) {
    throw new CounterpartyError(
      `d402: expected HTTP 402 from ${params.paywallUrl}, got ${initial.status}`,
    );
  }
  const requirement = parseRequirement(await initial.json());

  // 2. Abort guard (§4.1): the advertised terms MUST match the agreement.
  const m = termsMatchD402(
    { recipient: params.recipient, amount: params.amount },
    { recipient: requirement.recipient, amount: String(requirement.amount) },
  );
  if (!m.ok) {
    throw new CounterpartyError(
      `d402: 402 payment requirement does not match negotiated agreement: ${m.reason}`,
    );
  }

  // 3. Build the gasless d402_payment tx (does not broadcast yet).
  const payment = await client.createPayment(requirement);

  // 4. Sign + broadcast; the buyer gets the settlement tx hash back directly.
  //    A money-safe receipt needs a verifiable on-chain tx id, so success
  //    REQUIRES both the node's success flag and a non-empty hash — a settle
  //    that reports success without a parseable hash is reported ok:false
  //    rather than an unverifiable "success".
  const result = await client.settle(payment);
  const txHash = (result?.hash ?? "").trim();

  return {
    ok: result?.success === true && txHash.length > 0,
    txHash,
    chainId: params.network,
    payer: payerAddress,
    payee: requirement.recipient,
  };
}

/** This rail's availability (§9.4.4). NOT `live` — D402 isn't node-enabled. */
export const PAY_D402_AVAILABILITY = "experimental" as const;

export interface PayD402RailConfig {
  /** Demos node RPC URL. */
  rpc: string;
  /** Buyer wallet secret — mnemonic or private key — used to sign the payment. */
  secret: string;
  /** Network label recorded on the evidence (default "demos"). */
  network?: string;
  /** Override fetch (tests / custom transport). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * REQUIRED to build the rail: D402 is not node-enabled (§9.4.4 non-`live`), so
   * this rail cannot settle live. Constructing it without this explicit
   * acknowledgement throws, so it can never be wired as a `live` path by
   * accident (RAV-R1). Set `true` only for experimental / preview use.
   */
  acknowledgeExperimental: boolean;
}

export interface PayD402Rail {
  /** The buyer's Demos address. */
  readonly address: string;
  /** Settle one session's payment via the D402 402-flow. */
  settle(params: PayD402SettleParams): Promise<SettleResult>;
}

/**
 * Construct a pay-d402 rail from a Demos RPC + wallet secret. Lazily imports
 * demosdk so the SDK core stays importable without the chain deps installed.
 */
export async function createPayD402Rail(config: PayD402RailConfig): Promise<PayD402Rail> {
  if (!config?.acknowledgeExperimental) {
    throw new DacsError(
      "pay-d402 is EXPERIMENTAL and not node-enabled (§9.4.4 non-`live`): it cannot settle live. " +
        "Pass acknowledgeExperimental: true to construct it for preview use — never select it as a live rail (RAV-R1).",
    );
  }
  if (!config?.rpc) throw new DacsError("pay-d402 rail requires an rpc URL");
  if (!config?.secret) throw new DacsError("pay-d402 rail requires a wallet secret to sign payments");

  const { Demos } = await import("@kynesyslabs/demosdk/websdk");
  const { D402Client } = await import("@kynesyslabs/demosdk/d402/client");

  const demos = new Demos();
  await demos.connect(config.rpc);
  await demos.connectWallet(config.secret);
  const client = new D402Client(demos) as unknown as D402ClientLike;
  const fetchImpl = config.fetchImpl ?? fetch;
  const network = config.network ?? "demos";

  return {
    address: demos.getAddress(),
    settle: (params) =>
      payD402SettleCore(
        { ...params, network: params.network ?? network },
        { client, fetchImpl, payerAddress: demos.getAddress() },
      ),
  };
}

/**
 * Bridge a PayD402Rail to the runSession `settle` seam: the rail carries the
 * static D402 paywall coordinates (resolved from the listing) while runSession
 * supplies the per-session amount.
 */
export function payD402Settle(
  rail: PayD402Rail,
  paywall: { url: string; recipient: string; network?: string },
): (req: SettleRequest) => Promise<SettleResult> {
  return (req) =>
    rail.settle({
      paywallUrl: paywall.url,
      recipient: paywall.recipient,
      amount: req.amount,
      network: paywall.network ?? "demos",
    });
}
