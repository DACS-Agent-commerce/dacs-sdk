import type { SettleRequest, SettleResult } from "../agent/runSessionCore.js";
import { baseUnits } from "../canonical/index.js";
import { CounterpartyError, DacsError, faultCategory } from "../errors.js";
import {
  settlementKey,
  SettlementNotInvokedError,
  type SettlementBinding,
  type SettlementIdempotencyStore,
} from "./idempotency.js";
import { DEM_CURRENCY, DEM_DECIMALS } from "./payDem.js";

/**
 * pay-d402 settlement rail — the D402 HTTP-402 protocol on Demos (SR-4).
 *
 * D402 is Demos's native analogue of x402: the seller's deliverable is
 * paywalled and returns an HTTP 402 advertising a payment requirement
 * (recipient + amount in OS base units + a resource id). Unlike x402 — where the
 * facilitator settles on-chain and hands back a tx via a response header — the
 * D402 buyer signs and broadcasts a gasless `d402_payment` transaction itself,
 * so `settle()` returns the settlement tx hash directly (that hash IS the
 * payment proof).
 *
 * The buyer MUST abort before paying if the 402's advertised terms don't match
 * the negotiated agreement (termsMatchD402) — otherwise auto-pay could settle
 * the wrong recipient or amount. This is an SDK-local rule: DACS-4 registers no
 * pay-d402 rail, and the D402 wire contract comes from the versioned demosdk
 * `d402/client` source.
 *
 * ⚠️ EXPERIMENTAL — not a registered DACS-4 rail and not a supported live one.
 * The SDK classifies it `operator_gated` (§9.4.4 / RAV-R1, RAV-R3). It is NOT
 * inert: demosdk 4.0.17 and later sign, confirm and broadcast a real
 * `d402_payment` transaction, and Demos node 61b8e75 applies it as a DEM
 * transfer from buyer to seller through its bundled demosdk 4.0.12
 * `HandleD402Operations`. A "preview" settlement can therefore spend real
 * funds. Per §9.4.2 an orchestrator MUST NOT treat a non-`live` rail as live,
 * so it must not be selected as a production settlement path.
 * `createPayD402Rail` refuses to build unless the caller passes
 * `acknowledgeExperimental: true`, so it can't be wired as `live` by accident.
 * It graduates once d402 settlement is verified end to end on production nodes.
 *
 * SETTLEMENT STATES. A result is `ok: true` only when demosdk saw the payment in
 * a block (hash + block number); it then carries a `demos` txRef and
 * `bft-final`, as for pay-dem (§9.5.9 / §9.7). Inclusion is the node's
 * `getTxByHash` answer, not a canonical-block authentication like pay-dem's.
 * Every other outcome that has a hash — demosdk's `pending` (broadcast, not yet
 * seen), a node refusal, an on-chain failure — is `ok: false` WITH that hash,
 * which runSessionCore treats as indeterminate and never as terminal failure.
 * Reconcile it with `PayD402Rail.waitForSettlement` / `payD402ResumeSettlement`;
 * paying again signs a fresh nonce and is a second, distinct transfer.
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
  /**
   * demosdk 4.0.17+: broadcast but not seen in a block before the wait ran out.
   * It may still land; resume with `waitForSettlement(hash)`, never pay again.
   */
  pending?: boolean;
}

/** demosdk `waitForSettlement` polling options. */
export interface D402WaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/** Minimal structural view of the demosdk D402Client this rail depends on. */
export interface D402ClientLike {
  createPayment(requirement: D402PaymentRequirement): Promise<unknown>;
  settle(payment: unknown): Promise<D402SettlementResult>;
  /** Read a broadcast payment back by hash (demosdk 4.0.17+); never broadcasts. */
  waitForSettlement(hash: string, options?: D402WaitOptions): Promise<D402SettlementResult>;
}

/** Per-session settlement inputs, derived from the negotiated agreement. */
export interface PayD402SettleParams {
  /** Seller's paywalled delivery URL (returns HTTP 402). */
  paywallUrl: string;
  /** Negotiated recipient Demos address (the expected payTo). */
  recipient: string;
  /**
   * Negotiated price in integer OS base units (1 DEM = 10^9 OS). `payD402Settle`
   * converts the agreement's decimal DEM `Price.amount` before calling the rail.
   */
  amount: string;
  /**
   * Network label recorded on the evidence (e.g. "demos:mainnet"). It is the
   * caller's label and is not checked against the node, which reports no chain
   * id at the verified revision.
   */
  network: string;
  requestInit?: RequestInit;
}

/** Inputs for reading back a previously broadcast payment by its hash. */
export interface PayD402WaitParams {
  txHash: string;
  /** The recipient the payment was made to (recorded as `payee`). */
  recipient: string;
  /** Network label recorded on the evidence. */
  network: string;
  options?: D402WaitOptions;
}

/**
 * Numeric equality over integer base-unit amounts (tolerant of leading zeros).
 * Both sides must be plain decimal digits: demosdk signs the offered string as
 * written, and `BigInt` alone would also accept hex, binary, octal, a sign or
 * surrounding whitespace, so "0x3B9ACA00" or " 1000000000" would match.
 */
function sameAmount(a: string, b: string): boolean {
  return /^[0-9]+$/.test(a) && /^[0-9]+$/.test(b) && BigInt(a) === BigInt(b);
}

/**
 * SDK-local abort guard for D402: the 402's offered terms MUST match the
 * negotiated agreement. Recipient compared case-insensitively; amount compared
 * as integer OS base units on both sides (`payD402Settle` converts the
 * agreement's decimal DEM first, so "1.5" DEM matches "1500000000" OS).
 * D402 is native-DEM only; `payD402Settle` refuses any other agreement asset.
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
  // Unit safety (fork boundary): the abort guard compares the 402 amount against
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
  /** The settle flow never reads back by hash, so `waitForSettlement` is not needed. */
  client: Pick<D402ClientLike, "createPayment" | "settle">;
  fetchImpl: typeof fetch;
  /** The buyer's Demos address (recorded as `payer` on the result). */
  payerAddress: string;
}

/** A fresh failure bound to exactly one call's parameters, never the cause's identity. */
class D402PreflightError extends DacsError {
  constructor(readonly invocation: PayD402SettleParams, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), {
      cause,
      category: faultCategory(cause),
    });
    Object.freeze(this);
  }
}

async function beforePayment<T>(
  invocation: PayD402SettleParams,
  step: () => Promise<T>,
): Promise<T> {
  try {
    return await step();
  } catch (err) {
    throw new D402PreflightError(invocation, err);
  }
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

  const requirement = await beforePayment(params, async () => {
    // 1. Initial request — expect a 402 with a payment requirement.
    const initial = await fetchImpl(params.paywallUrl, params.requestInit);
    if (initial.status !== 402) {
      throw new CounterpartyError(
        `d402: expected HTTP 402 from ${params.paywallUrl}, got ${initial.status}`,
      );
    }
    const offered = parseRequirement(await initial.json());

    // 2. Abort guard: the advertised terms MUST match the agreement.
    const m = termsMatchD402(
      { recipient: params.recipient, amount: params.amount },
      { recipient: offered.recipient, amount: String(offered.amount) },
    );
    if (!m.ok) {
      throw new CounterpartyError(
        `d402: 402 payment requirement does not match negotiated agreement: ${m.reason}`,
      );
    }
    return offered;
  });

  // 3. Build the gasless d402_payment tx (does not broadcast yet).
  const payment = await client.createPayment(requirement);

  // 4. Sign + broadcast; the buyer gets the settlement tx hash back directly.
  const result = await client.settle(payment);
  return settleResultFromD402(result, {
    network: params.network,
    payer: payerAddress,
    payee: requirement.recipient,
  });
}

/**
 * Map a demosdk settlement result onto the runSession seam. A money-safe
 * receipt needs a verifiable on-chain tx id and the block it landed in, so
 * success REQUIRES the success flag, a non-empty hash and a block number;
 * anything less (including demosdk's `pending`) is `ok: false` and keeps the
 * hash, so the session stays indeterminate instead of recording failure.
 */
function settleResultFromD402(
  result: D402SettlementResult | undefined,
  parties: { network: string; payer: string; payee: string },
  expectedHash?: string,
): SettleResult {
  const txHash = (typeof result?.hash === "string" ? result.hash : "").trim();
  const base = {
    txHash: expectedHash ?? txHash,
    chainId: parties.network,
    payer: parties.payer,
    payee: parties.payee,
  };
  const blockNumber = result?.blockNumber;
  const included =
    result?.success === true &&
    result.pending !== true &&
    txHash.length > 0 &&
    (expectedHash === undefined || sameHash(txHash, expectedHash)) &&
    typeof blockNumber === "number" &&
    Number.isSafeInteger(blockNumber) &&
    blockNumber >= 0;
  if (!included) return { ok: false, ...base };
  return {
    ok: true,
    ...base,
    blockNumber,
    txRefKind: "demos",
    finality: { model: "bft-final" },
  };
}

function sameHash(a: string, b: string): boolean {
  return a.replace(/^0x/i, "").toLowerCase() === b.replace(/^0x/i, "").toLowerCase();
}

/**
 * This rail's availability, in the §9.4.4 spec vocabulary (issue #5: the
 * previous `"experimental"` was a fourth, SDK-local vocabulary). D402 is not a
 * supported live rail, although its settlement can move real DEM — that is
 * `operator_gated`: not selectable until an operator explicitly acknowledges
 * it (RAV-R3), and never auto-selected (RAV-R1). The classification is
 * SDK-local: DACS-4 registers no pay-d402 rail.
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
  /** Override fetch (tests / custom transport). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * REQUIRED to build the rail: D402 is not a supported live rail (§9.4.4
   * non-`live`). Constructing it without this explicit acknowledgement throws,
   * so it can never be wired as a `live` path by accident (RAV-R1). Set `true`
   * only for experimental use, knowing that settlement broadcasts a real
   * `d402_payment` transaction that can move real DEM.
   */
  acknowledgeExperimental: boolean;
}

export interface PayD402Rail {
  /** The buyer's Demos address. */
  readonly address: string;
  /** Settle one session's payment via the D402 402-flow. */
  settle(params: PayD402SettleParams): Promise<SettleResult>;
  /**
   * Read back a payment this wallet already broadcast, by hash. `ok: true` only
   * once it is in a block; otherwise `ok: false` with the same hash. It never
   * signs or broadcasts, so it is the safe way to resolve an indeterminate
   * `settle` result.
   */
  waitForSettlement(params: PayD402WaitParams): Promise<SettleResult>;
}

/**
 * Construct a pay-d402 rail from a Demos RPC + wallet secret. Lazily imports
 * demosdk so the SDK core stays importable without the chain deps installed.
 */
export async function createPayD402Rail(config: PayD402RailConfig): Promise<PayD402Rail> {
  if (!config?.acknowledgeExperimental) {
    throw new DacsError(
      "pay-d402 is EXPERIMENTAL and not a supported live rail (§9.4.4 non-`live`), but settling broadcasts a real " +
        "d402_payment transaction that can move real DEM. Pass acknowledgeExperimental: true only for experimental " +
        "use — never select it as a live rail (RAV-R1).",
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
        params.network === undefined ? { ...params, network } : params,
        { client, fetchImpl, payerAddress: demos.getAddress() },
      ),
    waitForSettlement: async ({ txHash, recipient, network: label, options }) =>
      settleResultFromD402(
        await client.waitForSettlement(txHash, options),
        { network: label ?? network, payer: demos.getAddress(), payee: recipient },
        txHash,
      ),
  };
}

/** The D402 paywall coordinates a session settles against. */
export interface PayD402Paywall {
  url: string;
  recipient: string;
  network?: string;
}

/**
 * Check a runSession request against the paywall and convert its decimal DEM
 * `Price.amount` to integer OS base units (§9.5.9 step 2, as for pay-dem).
 */
function d402Request(
  req: SettleRequest,
  recipient: string,
): { amountOs: string; phaseIndex: number } {
  const { amount, asset, expectedPayee, phase, rail } = req;
  if (rail !== "pay-d402") {
    throw new DacsError(`pay-d402 executor requires rail "pay-d402", got "${rail}"`);
  }
  if (phase !== "pay-d402") {
    throw new DacsError(`pay-d402 executor requires phase "pay-d402", got "${phase}"`);
  }
  if (asset !== DEM_CURRENCY) {
    throw new DacsError(`pay-d402 settles ${DEM_CURRENCY} only, got asset "${asset}"`);
  }
  if (expectedPayee !== recipient) {
    throw new DacsError(
      `pay-d402 destination mismatch: request binds ${expectedPayee}, configured paywall pays ${recipient}`,
    );
  }
  // Decimal DEM → integer OS (string math; rejects sub-OS precision).
  const amountOs = baseUnits(amount, DEM_DECIMALS);
  if (amountOs === "0") {
    throw new DacsError(`pay-d402: amount must be > 0 (got ${amount})`);
  }
  return { amountOs, phaseIndex: req.phaseIndex ?? 0 };
}

/** Return a rail result under the request-bound identifiers, after checking them. */
function boundD402Result(
  result: SettleResult,
  expected: { network: string; payer: string; recipient: string },
  label: string,
): SettleResult {
  if (
    result.chainId !== expected.network ||
    result.payer !== expected.payer ||
    result.payee.trim().toLowerCase() !== expected.recipient.trim().toLowerCase()
  ) {
    throw new DacsError(`${label} does not match the paywall network or parties`);
  }
  // The rail reports the 402's spelling of the payee; the seam must return the
  // request-bound identifier verbatim (case is the only allowed difference).
  return { ...result, payee: expected.recipient };
}

/**
 * Bridge a PayD402Rail to the runSession `settle` seam: the rail carries the
 * static D402 paywall coordinates (resolved from the listing) while runSession
 * supplies the per-session amount, converted from decimal DEM to OS here.
 *
 * Submission is at most once per `(rail, jobId, phaseIndex)`: a result that is
 * not a definitive success keeps its idempotency intent, so a retry refuses to
 * pay again instead of signing a second transfer. Only a failure before any
 * payment was created (402 fetch, body, abort guard) releases the intent.
 *
 * `opts.store` is REQUIRED and there is no per-bridge default: two bridges
 * with private stores would each pay the same pending job. Pass one store,
 * shared by every bridge for this wallet and durable across restarts (a
 * `SettlementLog` adapter); the in-memory log covers one process only.
 * Wire `payD402ResumeSettlement` as runSession's `resumeSettlement`.
 */
export function payD402Settle(
  rail: PayD402Rail,
  paywall: PayD402Paywall,
  opts: { store: SettlementIdempotencyStore },
): (req: SettleRequest) => Promise<SettleResult> {
  const store = opts?.store;
  if (typeof store?.once !== "function") {
    throw new DacsError(
      "pay-d402 settlement requires opts.store: one SettlementIdempotencyStore shared by every bridge for " +
        "this wallet and durable across restarts; refusing to settle without it (double-pay risk)",
    );
  }
  const paywallUrl = paywall.url;
  const recipient = paywall.recipient;
  const network = paywall.network ?? "demos";
  return async (req) => {
    const { amountOs, phaseIndex } = d402Request(req, recipient);
    const payer = rail.address;
    const binding = {
      bindingVersion: "1",
      railId: req.rail,
      jobId: req.jobId,
      phaseIndex,
      phase: req.phase,
      amount: amountOs,
      agreementAsset: req.asset,
      settlementAsset: DEM_CURRENCY,
      payer,
      payee: recipient,
      network,
      finality: { model: "bft-final" },
      resource: paywallUrl,
    } satisfies SettlementBinding;
    return store.once(
      settlementKey(req.rail, req.jobId, phaseIndex),
      binding,
      async () => {
        const invocation = { paywallUrl, recipient, amount: amountOs, network };
        let settled: SettleResult;
        try {
          settled = await rail.settle(invocation);
        } catch (err) {
          if (!(err instanceof D402PreflightError) || err.invocation !== invocation) {
            // A rail/client cannot supply the store's clean-release signal.
            if (err instanceof SettlementNotInvokedError) {
              throw new DacsError("pay-d402 rail failed without current preflight proof", { cause: err });
            }
            throw err;
          }
          throw new SettlementNotInvokedError(
            { ok: false, txHash: "", chainId: network, payer, payee: recipient },
            err.cause,
          );
        }
        return boundD402Result(settled, { network, payer, recipient }, "pay-d402 settlement");
      },
    );
  };
}

/**
 * runSession `resumeSettlement` for pay-d402: reconcile the durable attempt
 * history by hash and never submit a new payment. Each prior hash is read back
 * with `waitForSettlement`; one included payment is returned as the definitive
 * result. Two included payments, or no recorded hash at all, need an operator.
 * If none has landed yet, the latest hash is returned as `ok: false`, which
 * keeps the session indeterminate for another reconciliation.
 */
export function payD402ResumeSettlement(
  rail: PayD402Rail,
  paywall: PayD402Paywall,
  opts: { wait?: D402WaitOptions } = {},
): (req: SettleRequest) => Promise<SettleResult> {
  const recipient = paywall.recipient;
  const network = paywall.network ?? "demos";
  return async (req) => {
    d402Request(req, recipient);
    const attempts = (req.priorAttempts ?? []).filter((a) => a.txHash.trim().length > 0);
    if (attempts.length === 0) {
      throw new DacsError(
        `pay-d402 recovery for ${req.jobId} has no recorded transaction hash, so it cannot rule out a ` +
          "broadcast payment; refusing to pay again (operator action required)",
      );
    }
    const payer = rail.address;
    const included: SettleResult[] = [];
    for (const attempt of attempts) {
      if (attempt.chainId !== network) {
        throw new DacsError(
          `pay-d402 recovery attempt ${attempt.txHash} was recorded under network "${attempt.chainId}", ` +
            `not the paywall's "${network}"; operator action required`,
        );
      }
    }
    for (const attempt of attempts) {
      const read = boundD402Result(
        await rail.waitForSettlement({
          txHash: attempt.txHash,
          recipient,
          network,
          ...(opts.wait ? { options: opts.wait } : {}),
        }),
        { network, payer, recipient },
        "pay-d402 recovery",
      );
      if (read.ok) {
        if (!sameHash(read.txHash, attempt.txHash)) {
          throw new DacsError("pay-d402 recovery read back a different transaction hash");
        }
        included.push(read);
      }
    }
    if (included.length > 1) {
      throw new DacsError(
        `pay-d402 recovery for ${req.jobId} found ${included.length} included payments ` +
          `(${included.map((r) => r.txHash).join(", ")}); operator action required`,
      );
    }
    if (included.length === 1) return included[0]!;
    const latest = attempts[attempts.length - 1]!;
    return { ok: false, txHash: latest.txHash, chainId: network, payer, payee: recipient };
  };
}
