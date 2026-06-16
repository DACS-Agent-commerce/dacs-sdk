import type { SettleRequest, SettleResult } from "../agent/runSessionCore.js";
import { CounterpartyError } from "../errors.js";

/**
 * x402 settlement rail (DACS SR-4 / the reference-backed payment rail).
 *
 * x402 couples settlement with delivery: the seller's deliverable URL is
 * paywalled, so the buyer fetches it, receives an HTTP 402 advertising payment
 * requirements, signs an EIP-3009 / Permit2 authorization, and retries — the
 * facilitator settles on-chain and returns the settlement tx hash. Per DACS
 * §4.1 the buyer MUST abort if the 402's requirements don't match the
 * negotiated agreement (termsMatch) — otherwise auto-pay could settle wrong
 * terms.
 *
 * The orchestration (x402SettleCore) is pure over a minimal client interface +
 * an injected fetch, so it's unit-tested without a chain. createX402Rail() is
 * the thin wiring that constructs the real @x402 client from an EVM key.
 */

/** Minimal structural view of the @x402 HTTP client this rail depends on. */
export interface X402PaymentRequirement {
  network: string | number;
  payTo: string;
  amount: string | number | bigint;
  asset?: string;
}
export interface X402PaymentRequired {
  accepts?: X402PaymentRequirement[];
}
export interface X402ClientLike {
  getPaymentRequiredResponse(
    getHeader: (name: string) => string | null,
    body: unknown,
  ): X402PaymentRequired;
  createPaymentPayload(pr: X402PaymentRequired): Promise<unknown>;
  encodePaymentSignatureHeader(payload: unknown): Record<string, string>;
  getPaymentSettleResponse(
    getHeader: (name: string) => string | null,
  ): { transaction?: string } | undefined;
}

/** Per-session settlement inputs, derived from the negotiated agreement. */
export interface X402SettleParams {
  /** Seller's paywalled delivery URL (returns HTTP 402). */
  paywallUrl: string;
  /** Negotiated CAIP-2 network, e.g. "eip155:84532" (Base Sepolia). */
  network: string;
  /** Negotiated recipient EVM address (the expected payTo). */
  recipientEvm: string;
  /** Negotiated price in integer base units (matching DACS Price.amount). */
  amount: string;
  /** Asset id/symbol (informational; the on-chain asset is the token contract). */
  asset: string;
  requestInit?: RequestInit;
}

/** Numeric equality over integer base-unit strings (tolerant of leading zeros). */
function sameAmount(a: string, b: string): boolean {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return a === b;
  }
}

/**
 * DACS §4.1 abort guard: the 402's offered terms MUST match the negotiated
 * agreement. Network exact, recipient case-insensitive, amount compared as
 * integer base units (DACS Price.amount is already base units — no decimal
 * conversion, so the on-chain and agreed amounts can never silently diverge).
 */
export function termsMatch(
  expected: { network: string; recipientEvm: string; amount: string },
  offered: { network: string; payTo: string; amount: string },
): { ok: boolean; reason?: string } {
  if (offered.network !== expected.network) {
    return {
      ok: false,
      reason: `network mismatch: 402 says ${offered.network}, agreement says ${expected.network}`,
    };
  }
  if (offered.payTo.toLowerCase() !== expected.recipientEvm.toLowerCase()) {
    return {
      ok: false,
      reason: `recipient mismatch: 402 says ${offered.payTo}, agreement says ${expected.recipientEvm}`,
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

export interface X402SettleCoreDeps {
  client: X402ClientLike;
  fetchImpl: typeof fetch;
  /** The buyer's EVM address (recorded as `payer` on the result). */
  payerAddress: string;
}

/**
 * Run the buyer-side 402 dance and return DACS SettlementEvidence inputs.
 * Aborts before signing if no advertised requirement matches the agreement.
 */
export async function x402SettleCore(
  params: X402SettleParams,
  deps: X402SettleCoreDeps,
): Promise<SettleResult> {
  const { client, fetchImpl, payerAddress } = deps;

  // 1. Initial request — expect a 402 with payment requirements.
  const initial = await fetchImpl(params.paywallUrl, params.requestInit);
  if (initial.status !== 402) {
    throw new CounterpartyError(
      `x402: expected HTTP 402 from ${params.paywallUrl}, got ${initial.status}`,
    );
  }
  const body = await initial.json();
  const paymentRequired = client.getPaymentRequiredResponse(
    (name) => initial.headers.get(name),
    body,
  );

  // 2. Abort guard (§4.1): pick the first advertised requirement matching the
  //    negotiated agreement; reject if none do.
  const candidates = paymentRequired.accepts ?? [];
  if (candidates.length === 0) {
    throw new CounterpartyError(
      "x402: 402 response has no `accepts` payment requirements",
    );
  }
  let chosen: X402PaymentRequirement | null = null;
  let lastReason = "no acceptable payment requirement";
  for (const req of candidates) {
    const m = termsMatch(
      {
        network: params.network,
        recipientEvm: params.recipientEvm,
        amount: params.amount,
      },
      {
        network: String(req.network),
        payTo: String(req.payTo),
        amount: String(req.amount),
      },
    );
    if (m.ok) {
      chosen = req;
      break;
    }
    lastReason = m.reason ?? lastReason;
  }
  if (!chosen) {
    throw new CounterpartyError(
      `x402: 402 payment requirement does not match negotiated agreement: ${lastReason}`,
    );
  }

  // 3. Sign the payment authorization (does not submit on-chain yet).
  const payload = await client.createPaymentPayload({
    ...paymentRequired,
    accepts: [chosen],
  });

  // 4. Retry with the X-PAYMENT header; the seller verifies + settles.
  const headers = new Headers(params.requestInit?.headers);
  for (const [k, v] of Object.entries(
    client.encodePaymentSignatureHeader(payload),
  )) {
    headers.set(k, v);
  }
  const final = await fetchImpl(params.paywallUrl, {
    ...params.requestInit,
    headers,
  });

  // 5. Read the settlement tx hash from X-PAYMENT-RESPONSE. Some middleware
  //    versions omit it on a 200 — payment clearly succeeded to pass the gate,
  //    so accept with an empty hash rather than failing the settled session.
  let txHash = "";
  try {
    txHash =
      client.getPaymentSettleResponse((name) => final.headers.get(name))
        ?.transaction ?? "";
  } catch (err) {
    if (!final.ok) throw err;
  }

  return {
    ok: final.ok,
    txHash,
    chainId: params.network,
    payer: payerAddress,
    payee: params.recipientEvm,
  };
}

export interface X402RailConfig {
  /** Buyer EVM private key (`0x…`) used to sign the EIP-3009 authorization. */
  evmPrivateKey: string;
  /** Override fetch (tests / custom transport). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface X402Rail {
  /** The buyer's EVM address derived from the configured key. */
  readonly address: string;
  /** Settle one session's payment via the x402 402-dance. */
  settle(params: X402SettleParams): Promise<SettleResult>;
}

/**
 * Construct an x402 rail from an EVM key. Lazily imports @x402 + viem so the
 * SDK core stays importable without the rail's chain deps installed.
 */
export async function createX402Rail(config: X402RailConfig): Promise<X402Rail> {
  const { privateKeyToAccount } = await import("viem/accounts");
  const { x402Client, x402HTTPClient } = await import("@x402/fetch");
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");

  const account = privateKeyToAccount(config.evmPrivateKey as `0x${string}`);
  // ExactEvmScheme handles any eip155 chain; the wildcard keeps one client
  // usable across base / base-sepolia / future EVM networks.
  const core = new x402Client().register("eip155:*", new ExactEvmScheme(account));
  const client = new x402HTTPClient(core) as unknown as X402ClientLike;
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    address: account.address,
    settle: (params) =>
      x402SettleCore(params, { client, fetchImpl, payerAddress: account.address }),
  };
}

/**
 * Bridge an X402Rail to the runSession `settle` seam: the rail carries the
 * static x402 paywall coordinates (resolved from the listing) while runSession
 * supplies the per-session amount/asset.
 */
export function x402Settle(
  rail: X402Rail,
  paywall: { url: string; network: string; recipientEvm: string },
): (req: SettleRequest) => Promise<SettleResult> {
  return (req) =>
    rail.settle({
      paywallUrl: paywall.url,
      network: paywall.network,
      recipientEvm: paywall.recipientEvm,
      amount: req.amount,
      asset: req.asset,
    });
}
