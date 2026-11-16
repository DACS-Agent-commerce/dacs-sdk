import type { SettleRequest, SettleResult } from "./settlementTypes.js";
import { CounterpartyError, DacsError } from "../errors.js";
import { normalizeDemosNativeAddress } from "./demosAddress.js";
import { createDemosClient } from "./demosClient.js";
import { readDemosTransactionRecord } from "./demosRpc.js";
import { canonicalDemosTxHash } from "./payDem.js";

/**
 * pay-d402 settlement rail — the D402 HTTP-402 protocol on Demos (SR-4).
 *
 * D402 is Demos's native analogue of x402: the seller's deliverable is
 * paywalled and returns an HTTP 402 advertising a payment requirement
 * (recipient + amount in native units + a resource id). Unlike x402 — where the
 * facilitator settles on-chain and hands back a tx via a response header — the
 * D402 buyer signs and broadcasts a gasless `d402_payment` transaction itself,
 * so `settle()` gets the settlement tx hash back directly. The node's
 * acknowledgement is not proof of payment: the rail reads the transaction back
 * by that hash and reports `ok` only when the node's own record is a confirmed
 * `d402_payment` debited from the buyer, with a balance credit to the advertised
 * recipient for the agreed amount.
 *
 * Per DACS §4.1 the buyer MUST abort before paying if the 402's advertised
 * terms don't match the negotiated agreement (termsMatchD402) — otherwise
 * auto-pay could settle the wrong recipient or amount.
 *
 * ⚠️ EXPERIMENTAL — preview only. With demosdk 4.0.17 and later, `D402Client.settle`
 * signs and broadcasts the payment, then polls the node for the transaction by
 * hash under a 60-second poll-loop deadline (the default). The deadline is
 * checked between calls, and a single lookup call has no timeout of its own, so
 * a stalled call can outlast it. It returns `success: true` once the
 * transaction is in a block, a failure when it was refused or included as
 * failed, and `pending: true` with the hash when the poll ends before the
 * transaction is seen. A pending payment may still land, so the rail reports it
 * as `ok: false` with `pending: true` and the hash kept; it is never `ok: true`
 * and never the not-sent answer (`ok: false` with an empty hash). Earlier
 * demosdk versions broadcast once and never report `pending`. Below demosdk
 * 4.0.17 (4.0.16 is what the lockfile pins and the peer range allows) the rail
 * cannot settle, because 4.0.16 calls a route the node does not serve. Per the RAV-R1
 * discipline ("MUST NOT treat a non-`live` rail as live") the rail is still not
 * a production settlement path. `createPayD402Rail` refuses to build unless the
 * caller passes `acknowledgeExperimental: true`, so it can't be wired as `live`
 * by accident.
 *
 * NOTE ON NAMING: this is `pay-d402` (the HTTP-402 protocol rail), distinct from
 * the spec's `pay-dem` (§9.5.9) — the plain `demos.transfer` native rail, which
 * is a separate, live-proven path (evidence `txRef` kind `demos`, `bft-final`).
 *
 * payD402SettleCore is pure over a minimal client interface, an injected fetch
 * and an injected transaction reader, so it's unit-tested without a Demos node; createPayD402Rail() is the thin
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
  /** Set by demosdk 4.0.17 and later when the payment was broadcast but not yet seen in a block. */
  pending?: boolean;
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

/** Longest `resourceId` or `description` signed into the memo, so the node's record stays under the read cap. */
const MAX_MEMO_PART_CHARS = 2048;
const BASE_UNITS = /^(?:0|[1-9][0-9]*)$/;

/** The value as a plain-keyed object, or null when it is not one. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
  // The signed payload carries the amount as sent and the record check reads it
  // back as plain digits, so anything else is refused before signing.
  if (!BASE_UNITS.test(amount)) {
    throw new CounterpartyError("d402: 402 `amount` must be plain decimal digits without leading zeros");
  }
  if (typeof resourceId !== "string" || resourceId.trim() === "") {
    throw new CounterpartyError("d402: 402 body missing a string `resourceId`");
  }
  const description = typeof b?.["description"] === "string" ? (b["description"] as string) : undefined;
  if (resourceId.length > MAX_MEMO_PART_CHARS || (description?.length ?? 0) > MAX_MEMO_PART_CHARS) {
    throw new CounterpartyError("d402: 402 `resourceId` or `description` is too long to sign");
  }
  return { recipient, amount, resourceId, ...(description ? { description } : {}) };
}

/**
 * What the rail returns. `pending: true` (always with `ok: false` and the
 * payment's hash) means the payment was broadcast but not yet seen on chain and
 * may still land: do not pay again.
 */
export interface PayD402SettleResult extends SettleResult {
  pending?: true;
}

export interface PayD402SettleCoreDeps {
  client: D402ClientLike;
  fetchImpl: typeof fetch;
  /** The buyer's Demos address (recorded as `payer` on the result). */
  payerAddress: string;
  /**
   * Reads the node's record of a transaction by hash. It must cap the reply
   * size and enforce a deadline; a rejection leaves the payment unconfirmed.
   */
  readTransaction(hash: string): Promise<unknown>;
}

/** Deadline for the one transaction-record read that follows a settle acknowledgement. */
const RECORD_READ_TIMEOUT_MS = 10_000;
const CONFIRMED_RECORD_STATUS = "confirmed";
const D402_PAYMENT_TYPE = "d402_payment";

/** True when `edits` holds a live balance credit of `amount` to `payee`. */
function creditsPayee(edits: unknown, payee: string, amount: string): boolean {
  return Array.isArray(edits) && edits.some((candidate) => {
    const edit = asRecord(candidate);
    if (edit === null || edit["type"] !== "balance" || edit["operation"] !== "add" ||
        edit["isRollback"] !== false || typeof edit["account"] !== "string" ||
        normalizeDemosNativeAddress(edit["account"]) !== payee) {
      return false;
    }
    const credited = edit["amount"];
    return typeof credited === "string" && BASE_UNITS.test(credited) &&
      BigInt(credited) === BigInt(amount);
  });
}

/**
 * True when the node's record is a confirmed `d402_payment` with this hash,
 * debited from `payer` and credited to `payee` for `amount` base units. The
 * signed payload holds `to` and `amount`, `from_ed25519_address` is the debited
 * account, and the balance edits must credit the payee; anything missing or
 * shaped differently is not a match.
 */
function recordShowsTransfer(
  record: unknown,
  expected: { txHash: string; payer: string; payee: string; amount: string },
): boolean {
  const tx = asRecord(record);
  if (tx === null || tx["status"] !== CONFIRMED_RECORD_STATUS) return false;
  const hash = canonicalDemosTxHash(tx["hash"]);
  if (hash === null || hash !== canonicalDemosTxHash(expected.txHash)) return false;
  const content = asRecord(tx["content"]);
  if (content === null || content["type"] !== D402_PAYMENT_TYPE) return false;
  const payer = normalizeDemosNativeAddress(expected.payer);
  if (payer === null || typeof content["from"] !== "string" ||
      normalizeDemosNativeAddress(content["from"]) !== payer ||
      typeof content["from_ed25519_address"] !== "string" ||
      normalizeDemosNativeAddress(content["from_ed25519_address"]) !== payer) {
    return false;
  }
  const data = content["data"];
  if (!Array.isArray(data) || data.length !== 2 || data[0] !== D402_PAYMENT_TYPE) return false;
  const payload = asRecord(data[1]);
  const payee = normalizeDemosNativeAddress(expected.payee);
  if (payload === null) return false;
  const { to, amount } = payload;
  return payee !== null && typeof to === "string" && normalizeDemosNativeAddress(to) === payee &&
    typeof amount === "string" && BASE_UNITS.test(amount) && BASE_UNITS.test(expected.amount) &&
    BigInt(amount) === BigInt(expected.amount) &&
    creditsPayee(content["gcr_edits"], payee, expected.amount);
}

/** Reads the transaction back; a failed or timed-out read is "not shown". */
async function transferIsRecorded(
  readTransaction: PayD402SettleCoreDeps["readTransaction"],
  expected: Parameters<typeof recordShowsTransfer>[1],
): Promise<boolean> {
  try {
    return recordShowsTransfer(await readTransaction(expected.txHash), expected);
  } catch {
    return false;
  }
}

/**
 * Run the buyer-side D402 flow and return DACS SettlementEvidence inputs.
 * Aborts before signing if the advertised requirement doesn't match the
 * agreement. Returns `pending: true` (with `ok: false` and the hash) when the
 * payment was broadcast but not yet seen on chain.
 * Throws when the 402 is missing, malformed or does not match the agreement,
 * and when `settle` reports a pending payment without a hash.
 */
export async function payD402SettleCore(
  params: PayD402SettleParams,
  deps: PayD402SettleCoreDeps,
): Promise<PayD402SettleResult> {
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
  //    The node's acknowledgement is not enough for success: it needs the
  //    success flag and a non-empty hash, and then the node's own record for
  //    that hash must show this payment. A `pending` result (broadcast, not
  //    yet seen on chain) is decided first, so it can never be ok:true and the
  //    record is not read for it. Every result that is not ok keeps its hash,
  //    so the caller does not mistake it for a payment never sent, and nothing
  //    is broadcast again.
  const result = await client.settle(payment);
  const txHash = (result?.hash ?? "").trim();
  const pending = result?.pending === true;
  if (pending && txHash.length === 0) {
    throw new DacsError(
      "d402: settle reported a pending payment without a hash; the payment may have been sent, so do not pay again",
    );
  }
  const acknowledged = !pending && result?.success === true && txHash.length > 0;

  return {
    ok: acknowledged && await transferIsRecorded(deps.readTransaction, {
      txHash,
      payer: payerAddress,
      payee: requirement.recipient,
      amount: String(requirement.amount),
    }),
    ...(pending ? { pending: true as const } : {}),
    txHash,
    chainId: params.network,
    payer: payerAddress,
    payee: requirement.recipient,
  };
}

/**
 * This rail's availability, in the §9.4.4 spec vocabulary (no SDK-local
 * values). D402 is quarantined pending node-side enablement — that is
 * `operator_gated`: not selectable until an operator enables it, and never
 * auto-selected (RAV-R1). Below demosdk 4.0.17 (4.0.16 is what the lockfile
 * pins and the peer range allows) the rail cannot settle, because 4.0.16 calls
 * a route the node does not serve.
 * The `acknowledgeExperimental` config flag keeps its name (API stability);
 * it is the caller-side acknowledgement this gate requires.
 */
export const PAY_D402_AVAILABILITY = "operator_gated" as const;

export interface PayD402RailConfig {
  /** Demos node RPC URL. */
  rpc: string;
  /** Buyer wallet secret — mnemonic or private key — used to sign the payment. */
  secret: string;
  /** Network label recorded on the evidence (default "demos"). */
  network?: string;
  /** Override fetch for the paywall request (tests / custom transport). Defaults to global fetch. The transaction-record read always uses global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * REQUIRED to build the rail: D402 is a preview rail (§9.4.4 non-`live`).
   * Constructing it without this explicit acknowledgement throws, so it can
   * never be wired as a `live` path by accident (RAV-R1). Set `true` only for
   * experimental / preview use.
   */
  acknowledgeExperimental: boolean;
}

export interface PayD402Rail {
  /** The buyer's Demos address. */
  readonly address: string;
  /** Settle one session's payment via the D402 402-flow. */
  settle(params: PayD402SettleParams): Promise<PayD402SettleResult>;
}

/**
 * Construct a pay-d402 rail from a Demos RPC + wallet secret. Lazily imports
 * demosdk so the SDK core stays importable without the chain deps installed.
 */
export async function createPayD402Rail(config: PayD402RailConfig): Promise<PayD402Rail> {
  if (!config?.acknowledgeExperimental) {
    throw new DacsError(
      "pay-d402 is EXPERIMENTAL preview (§9.4.4 non-`live`). " +
        "Pass acknowledgeExperimental: true to construct it for preview use — never select it as a live rail (RAV-R1).",
    );
  }
  if (!config?.rpc) throw new DacsError("pay-d402 rail requires an rpc URL");
  if (!config?.secret) throw new DacsError("pay-d402 rail requires a wallet secret to sign payments");

  const demosSdk = await import("@kynesyslabs/demosdk/websdk").catch(() => {
    throw new DacsError(
      "createPayD402Rail requires the optional peer @kynesyslabs/demosdk",
    );
  });
  const d402 = await import("@kynesyslabs/demosdk/d402/client").catch(() => {
    throw new DacsError(
      "createPayD402Rail requires the optional peer @kynesyslabs/demosdk",
    );
  });
  const { Demos } = demosSdk;
  const { D402Client } = d402;

  const demos = createDemosClient(Demos);
  await demos.connect(config.rpc);
  await demos.connectWallet(config.secret);
  const client = new D402Client(demos) as unknown as D402ClientLike;
  const fetchImpl = config.fetchImpl ?? fetch;
  const network = config.network ?? "demos";
  const readTransaction = (hash: string) =>
    readDemosTransactionRecord(config.rpc, hash, RECORD_READ_TIMEOUT_MS, fetch);

  return {
    address: demos.getAddress(),
    settle: (params) =>
      payD402SettleCore(
        { ...params, network: params.network ?? network },
        { client, fetchImpl, payerAddress: demos.getAddress(), readTransaction },
      ),
  };
}

/**
 * runSession rejects result keys it does not know. A pending payment goes to it
 * as `ok: false` with the hash kept, which it holds as unresolved and never
 * records as a failed payment.
 */
function withoutPendingMarker(result: PayD402SettleResult): SettleResult {
  const { pending: _pending, ...settleResult } = result;
  return settleResult;
}

/**
 * A payment that was sent and may still land: not `ok`, a hash, and no
 * permanent failure proof. A job with such a result must not be paid again.
 */
function isUnresolvedPayment(result: SettleResult): boolean {
  return !result.ok && result.txHash.length > 0 && result.errorClass !== "permanent";
}

/**
 * Bridge a PayD402Rail to the runSession `settle` seam: the rail carries the
 * static D402 paywall coordinates (resolved from the listing) while runSession
 * supplies the per-session amount. A pending payment reaches runSession as
 * `ok: false` with its hash and no `pending` key.
 *
 * While a call for a `jobId` and `phaseIndex` is running, and after it returns
 * a result that is not `ok` but carries a hash (and is not a permanent
 * failure), another call for the same job and phase does not call the rail: it
 * returns that call's result. The hold is dropped when the call throws, returns
 * no hash, returns a permanent failure, or returns `ok`. It lives in memory, as
 * long as the returned function: it does not cover other bridge instances or a
 * restart. The bridge cannot reconcile earlier attempts, so a request with
 * `priorAttempts` or `recoveryOnly` is refused.
 *
 * @throws DacsError when the request's `expectedPayee` differs from the paywall
 *   recipient, when the request asks for recovery, or when a job and phase
 *   that are held get a request with a different `amount`.
 */
export function payD402Settle(
  rail: PayD402Rail,
  paywall: { url: string; recipient: string; network?: string },
): (req: SettleRequest) => Promise<SettleResult> {
  const paywallUrl = paywall.url;
  const recipient = paywall.recipient;
  const network = paywall.network ?? "demos";
  const heldByJobPhase = new Map<string, { amount: string; result: Promise<SettleResult> }>();
  return (req) => {
    const { amount, expectedPayee } = req;
    if (expectedPayee !== recipient) {
      throw new DacsError(
        `pay-d402 destination mismatch: request binds ${expectedPayee}, configured paywall pays ${recipient}`,
      );
    }
    if (req.recoveryOnly === true || (req.priorAttempts?.length ?? 0) > 0) {
      throw new DacsError(
        `pay-d402 does not recover earlier attempts for ${req.jobId}; no payment is made`,
      );
    }
    const jobPhase = JSON.stringify([req.jobId, req.phaseIndex ?? 0]);
    const earlier = heldByJobPhase.get(jobPhase);
    if (earlier) {
      if (earlier.amount !== amount) {
        throw new DacsError(
          `pay-d402 already holds a payment of ${earlier.amount} for ${req.jobId}; a request for ${amount} is refused and no payment is made`,
        );
      }
      return earlier.result.then((result) => ({ ...result }));
    }
    const result = Promise.resolve()
      .then(() => rail.settle({ paywallUrl, recipient, amount, network }))
      .then(withoutPendingMarker)
      .then(
        (settled) => {
          if (!isUnresolvedPayment(settled)) heldByJobPhase.delete(jobPhase);
          return settled;
        },
        (error: unknown) => {
          heldByJobPhase.delete(jobPhase);
          throw error;
        },
      );
    heldByJobPhase.set(jobPhase, { amount, result });
    return result;
  };
}
