import type { SettleRequest, SettleResult } from "../agent/runSessionCore.js";
import { sha256Hex } from "../canonical/index.js";
import { CounterpartyError } from "../errors.js";
import type {
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
import {
  createIdempotencyStore,
  settlementKey,
  type SettlementBinding,
  type SettlementEffectFence,
  type SettlementIdempotencyStore,
  type SettlementReconcile,
} from "./idempotency.js";
import { deriveX402ReceiptCommitment } from "../seller/x402Receipt.js";
import {
  verifyEvmTransferFinality,
  type EvmTransferFinalityClient,
  type EvmTransferFinalityObservation,
  type EvmTransferFinalityRequest,
} from "./evmTransferFinality.js";

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
/** Peer-independent structural subset of the x402 settlement response. */
export interface X402SettlementResponse {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  amount?: string;
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
  ): X402SettlementResponse | undefined;
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
  /** Signed rail-descriptor confirmation requirement. */
  finalityBlocks: number;
  /**
   * Expected on-chain token id (the ERC-20 contract) the 402 must advertise —
   * the §4.1 asset guard compares this against the 402's `asset`. This is the
   * resolved token, not the Price.asset symbol.
   */
  asset: string;
  /** DACS session identifier bound into the EIP-3009 authorization nonce. */
  jobId?: string;
  /** Zero-based index of the pay-x402 phase in the signed pipeline. */
  phaseIndex?: number;
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

function chainIdFromCaip2(network: string): number {
  const match = /^eip155:([1-9][0-9]*)$/.exec(network);
  if (!match) {
    throw new CounterpartyError(
      `x402: unsupported network ${network} (expected eip155:<positive id>)`,
    );
  }
  const chainId = Number(match[1]);
  if (!Number.isSafeInteger(chainId)) {
    throw new CounterpartyError("x402: network chain id is outside the safe range");
  }
  return chainId;
}

function snapshotRequestInit(input: RequestInit | undefined): RequestInit | undefined {
  if (input === undefined) return undefined;
  return {
    ...input,
    ...(input.headers === undefined ? {} : { headers: new Headers(input.headers) }),
  };
}

/**
 * DACS §4.1 abort guard: the 402's offered terms MUST match the negotiated
 * agreement. Network exact, recipient case-insensitive, amount compared as
 * integer base units (DACS Price.amount is already base units — no decimal
 * conversion, so the on-chain and agreed amounts can never silently diverge).
 *
 * Asset is part of the guard: a 402 advertising the same base-unit amount to the
 * same recipient on the same chain but for a *different token* must NOT pass —
 * otherwise auto-pay would sign for the wrong asset. `expected.asset` is the
 * canonical on-chain asset identifier the rail expects (e.g. the token contract
 * / CAIP-19 id resolved for the negotiated Price.asset). When it is set, the 402
 * MUST carry a matching asset; a 402 that omits the asset is rejected because we
 * can't confirm the token.
 */
export function termsMatch(
  expected: {
    network: string;
    recipientEvm: string;
    amount: string;
    asset?: string;
  },
  offered: {
    network: string;
    payTo: string;
    amount: string;
    asset?: string;
  },
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
  const expectedAsset = expected.asset?.trim();
  if (expectedAsset) {
    const offeredAsset = offered.asset?.trim();
    if (!offeredAsset) {
      return {
        ok: false,
        reason: `asset mismatch: 402 omits asset, agreement says ${expectedAsset}`,
      };
    }
    if (offeredAsset.toLowerCase() !== expectedAsset.toLowerCase()) {
      return {
        ok: false,
        reason: `asset mismatch: 402 says ${offeredAsset}, agreement says ${expectedAsset}`,
      };
    }
  }
  return { ok: true };
}

export interface X402SettleCoreDeps {
  client: X402ClientLike;
  fetchImpl: typeof fetch;
  /** The buyer's EVM address (recorded as `payer` on the result). */
  payerAddress: string;
  /** Fail-closed RPC/chain preflight executed before payment authorization. */
  assertFinalityContext(input: Readonly<{ chainId: number }>): Promise<void>;
  /** Independent authenticated chain read; facilitator claims alone never succeed. */
  authenticateTransfer(
    request: Readonly<EvmTransferFinalityRequest>,
  ): Promise<EvmTransferFinalityObservation>;
}

/**
 * Run the buyer-side 402 dance and return DACS SettlementEvidence inputs.
 * Aborts before signing if no advertised requirement matches the agreement.
 */
export async function x402SettleCore(
  params: X402SettleParams,
  deps: X402SettleCoreDeps,
  effectFence?: Readonly<SettlementEffectFence>,
): Promise<SettleResult> {
  // Snapshot caller-owned policy and transport scalars before the first
  // callback. A callback may retain the original params object; it must not be
  // able to change the amount, endpoint, token or confirmation depth after the
  // corresponding entry checks have passed.
  const paywallUrl = params.paywallUrl;
  const network = params.network;
  const recipientEvm = params.recipientEvm;
  const requestedAmount = params.amount;
  const asset = params.asset;
  const finalityBlocks = params.finalityBlocks;
  const requestInit = snapshotRequestInit(params.requestInit);
  const {
    client,
    fetchImpl,
    payerAddress,
    assertFinalityContext,
    authenticateTransfer,
  } = deps;
  if (!Number.isSafeInteger(finalityBlocks) || finalityBlocks <= 0) {
    throw new CounterpartyError(
      "x402: finalityBlocks must be a positive safe integer",
    );
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(asset) ||
      !/^0x[0-9a-fA-F]{40}$/.test(recipientEvm) ||
      !/^0x[0-9a-fA-F]{40}$/.test(payerAddress)) {
    throw new CounterpartyError("x402: EVM token, payer, or payee address is invalid");
  }
  let amount: bigint;
  try {
    amount = BigInt(requestedAmount);
  } catch {
    throw new CounterpartyError("x402: negotiated amount is not base-unit integer");
  }
  if (amount <= 0n) {
    throw new CounterpartyError("x402: negotiated amount must be positive");
  }
  const chainId = chainIdFromCaip2(network);
  await assertFinalityContext({ chainId });

  // 1. Initial request — expect a 402 with payment requirements.
  const initial = await fetchImpl(paywallUrl, requestInit);
  if (initial.status !== 402) {
    throw new CounterpartyError(
      `x402: expected HTTP 402 from ${paywallUrl}, got ${initial.status}`,
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
        network,
        recipientEvm,
        amount: requestedAmount,
        asset,
      },
      {
        network: String(req.network),
        payTo: String(req.payTo),
        amount: String(req.amount),
        asset: req.asset != null ? String(req.asset) : undefined,
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
  const headers = new Headers(requestInit?.headers);
  for (const [k, v] of Object.entries(
    client.encodePaymentSignatureHeader(payload),
  )) {
    headers.set(k, v);
  }
  // Signing is reversible; sending the retained authorization is not. Refuse
  // a recovery generation that expired or was superseded while signing.
  await effectFence?.assertCurrent();
  const final = await fetchImpl(paywallUrl, {
    ...requestInit,
    headers,
  });

  // 5. Preserve and commit the exact raw v2 settlement response. Decoding an
  // SDK projection loses unknown members and therefore cannot establish X402-2.
  const headerValue = final.headers.get("PAYMENT-RESPONSE");
  if (!final.ok || headerValue === null) {
    throw new CounterpartyError(
      `x402: paid response returned HTTP ${final.status} ` +
        `${headerValue === null ? "without" : "with"} PAYMENT-RESPONSE`,
    );
  }
  const commitment = deriveX402ReceiptCommitment({
    protocolVersion: "2",
    responseHeader: { name: "PAYMENT-RESPONSE", value: headerValue },
  });
  if (commitment.disposition !== "pass" || !commitment.receipt ||
      !commitment.computedPaymentReceiptHash) {
    throw new CounterpartyError(
      `x402: settlement response is not conforming (${commitment.reason})`,
    );
  }
  const receipt = commitment.receipt;
  const txHash = receipt.transaction;
  const reportedNetwork = receipt.network;
  const reportedPayer = receipt.payer;
  const reportedAmount = receipt.amount;
  if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash) ||
      reportedNetwork !== network ||
      typeof reportedPayer !== "string" ||
      reportedPayer.toLowerCase() !== payerAddress.toLowerCase() ||
      (reportedAmount !== undefined &&
        (typeof reportedAmount !== "string" ||
          !sameAmount(reportedAmount, requestedAmount)))) {
    throw new CounterpartyError(
      "x402: settlement response does not match the negotiated payment",
    );
  }
  const observed = await authenticateTransfer({
    chainId,
    transactionHash: txHash,
    tokenAddress: asset,
    payerAddress,
    payeeAddress: recipientEvm,
    amount,
    minimumConfirmations: finalityBlocks,
  });

  return {
    ok: true,
    // Keep the durable outer identity byte-consistent with the independently
    // authenticated event even when a conforming receipt used upper-case hex.
    txHash: `0x${observed.transactionHash}`,
    chainId: network,
    payer: payerAddress,
    payee: recipientEvm,
    finality: { model: "block-depth", finalityBlocks },
    finalityObservedAt: observed.finalityObservedAt,
    blockNumber: observed.blockNumber,
    txRef: {
      kind: "x402-event",
      httpResource: paywallUrl,
      paymentReceiptHash: commitment.computedPaymentReceiptHash,
      settlementTxHash: observed.transactionHash,
      chainId: observed.chainId,
      logIndex: observed.logIndex,
      protocolVersion: "2",
    },
    x402Receipt: {
      protocolVersion: "2",
      headerName: "PAYMENT-RESPONSE",
      headerValue,
      paymentReceiptHash: commitment.computedPaymentReceiptHash,
    },
  };
}

export interface X402RailConfig {
  /** Buyer EVM private key (`0x…`) used to sign the EIP-3009 authorization. */
  evmPrivateKey: string;
  /** Override fetch (tests / custom transport). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Refuse to create a random-nonce authorization without DACS session binding. */
  requireSessionBinding?: boolean;
  /** Trusted EVM JSON-RPC used independently of the x402 facilitator. */
  rpcUrl: string;
  /** Signed rail-descriptor confirmation requirement. */
  finalityBlocks: number;
}

export interface X402Rail {
  /** The buyer's EVM address derived from the configured key. */
  readonly address: string;
  /** Signed descriptor finality policy retained in the idempotency binding. */
  readonly finalityBlocks: number;
  /** Settle one session's payment via the x402 402-dance. */
  settle(
    params: Omit<X402SettleParams, "finalityBlocks">,
    effectFence?: Readonly<SettlementEffectFence>,
  ): Promise<SettleResult>;
}

/** Derive the deterministic EIP-3009 nonce binding a payment to one DACS phase. */
export async function dacsX402AuthorizationNonce(input: {
  jobId: string;
  phaseIndex: number;
}): Promise<`0x${string}`> {
  if (
    typeof input.jobId !== "string" ||
    input.jobId.length === 0 ||
    !Number.isSafeInteger(input.phaseIndex) ||
    input.phaseIndex < 0 ||
    Object.is(input.phaseIndex, -0)
  ) {
    throw new Error(
      "x402 DACS binding requires a jobId and a non-negative phaseIndex",
    );
  }
  const { sha256, stringToHex } = await import("viem");
  const preimage = `dacs-sb3:v1:${input.jobId.normalize("NFC")}:${input.phaseIndex}`;
  return sha256(stringToHex(preimage));
}

export type DacsX402BindingVerdict =
  | "present-and-matches"
  | "present-and-mismatches"
  | "malformed";

/**
 * Recompute and classify the normative textual EIP-3009 nonce form. A
 * well-formed mismatch is a hard SB-3 rejection; malformed input is an error,
 * not the absent/unverifiable fallback used when no binding can be recovered.
 */
export async function verifyDacsX402AuthorizationNonce(
  input: { jobId: string; phaseIndex: number },
  presentedNonce: string,
): Promise<DacsX402BindingVerdict> {
  if (!/^0x[0-9a-f]{64}$/.test(presentedNonce)) return "malformed";
  return presentedNonce === await dacsX402AuthorizationNonce(input)
    ? "present-and-matches"
    : "present-and-mismatches";
}

/**
 * Construct an x402 rail from an EVM key. Lazily imports @x402 + viem so the
 * SDK core stays importable without the rail's chain deps installed.
 */
export async function createX402Rail(config: X402RailConfig): Promise<X402Rail> {
  const evmPrivateKey = config.evmPrivateKey;
  const configuredFetchImpl = config.fetchImpl;
  const requireSessionBinding = config.requireSessionBinding === true;
  const requestedRpcUrl = config.rpcUrl;
  const finalityBlocks = config.finalityBlocks;
  if (!Number.isSafeInteger(finalityBlocks) || finalityBlocks <= 0) {
    throw new CounterpartyError(
      "createX402Rail requires a positive finalityBlocks value",
    );
  }
  let rpcUrl: URL;
  try {
    rpcUrl = new URL(requestedRpcUrl);
  } catch {
    throw new CounterpartyError("createX402Rail requires an absolute RPC URL");
  }
  if (rpcUrl.protocol !== "https:" && rpcUrl.protocol !== "http:") {
    throw new CounterpartyError("createX402Rail RPC URL must use HTTP(S)");
  }
  const accounts = await import("viem/accounts").catch(() => {
    throw new CounterpartyError(
      "createX402Rail requires the optional peer viem",
    );
  });
  const x402Fetch = await import("@x402/fetch").catch(() => {
    throw new CounterpartyError(
      "createX402Rail requires the optional peer @x402/fetch",
    );
  });
  const x402Evm = await import("@x402/evm/exact/client").catch(() => {
    throw new CounterpartyError(
      "createX402Rail requires the optional peer @x402/evm",
    );
  });
  const { privateKeyToAccount } = accounts;
  const { x402Client, x402HTTPClient } = x402Fetch;
  const { ExactEvmScheme } = x402Evm;

  const account = privateKeyToAccount(evmPrivateKey as `0x${string}`);
  const fetchImpl = configuredFetchImpl ?? fetch;
  const chainClients = new Map<number, EvmTransferFinalityClient>();

  const finalityClient = async (chainId: number): Promise<EvmTransferFinalityClient> => {
    const existing = chainClients.get(chainId);
    if (existing) return existing;
    const viem = await import("viem").catch(() => {
      throw new CounterpartyError("createX402Rail requires the optional peer viem");
    });
    const chain = viem.defineChain({
      id: chainId,
      name: `eip155:${chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [requestedRpcUrl] } },
    });
    const publicClient = viem.createPublicClient({
      chain,
      transport: viem.http(requestedRpcUrl),
    });
    const created: EvmTransferFinalityClient = {
      getChainId: () => publicClient.getChainId(),
      waitForTransactionReceipt: ({ hash, confirmations }) =>
        publicClient.waitForTransactionReceipt({
          hash: hash as `0x${string}`,
          confirmations,
        }),
      getTransactionReceipt: ({ hash }) => publicClient.getTransactionReceipt({
        hash: hash as `0x${string}`,
      }),
      getBlock: ({ blockNumber }) => publicClient.getBlock({ blockNumber }),
    };
    chainClients.set(chainId, created);
    return created;
  };

  return {
    address: account.address,
    finalityBlocks,
    settle: async (params, effectFence) => {
      const paywallUrl = params.paywallUrl;
      const network = params.network;
      const recipientEvm = params.recipientEvm;
      const amount = params.amount;
      const asset = params.asset;
      const jobId = params.jobId;
      const phaseIndex = params.phaseIndex;
      const requestInit = snapshotRequestInit(params.requestInit);
      if (requireSessionBinding && (jobId === undefined || phaseIndex === undefined)) {
        throw new Error("pay-x402 requires the DACS jobId/phaseIndex authorization binding");
      }

      let scheme: SchemeNetworkClient = new ExactEvmScheme(account);
      if (jobId !== undefined && phaseIndex !== undefined) {
        const nonce = await dacsX402AuthorizationNonce({
          jobId,
          phaseIndex,
        });
        scheme = {
          scheme: "exact",
          async createPaymentPayload(
            version: number,
            requirements: PaymentRequirements,
          ): Promise<PaymentPayloadResult> {
            if (version !== 2) throw new Error("DACS pay-x402 requires x402 protocol version 2");
            const extra = requirements.extra as { name?: unknown; version?: unknown } | undefined;
            if (typeof extra?.name !== "string" || typeof extra.version !== "string") {
              throw new Error("x402 EIP-712 domain name/version are required");
            }
            const { getAddress } = await import("viem");
            const chainId = Number(String(requirements.network).split(":")[1]);
            if (!Number.isSafeInteger(chainId) || chainId <= 0) {
              throw new Error("x402 EVM network is invalid");
            }
            const now = Math.floor(Date.now() / 1_000);
            const authorization = {
              from: account.address,
              to: getAddress(String(requirements.payTo)),
              value: String(requirements.amount),
              validAfter: "0",
              validBefore: String(now + Number(requirements.maxTimeoutSeconds)),
              nonce,
            };
            const signature = await account.signTypedData({
              domain: {
                name: extra.name,
                version: extra.version,
                chainId,
                verifyingContract: getAddress(String(requirements.asset)),
              },
              types: {
                TransferWithAuthorization: [
                  { name: "from", type: "address" },
                  { name: "to", type: "address" },
                  { name: "value", type: "uint256" },
                  { name: "validAfter", type: "uint256" },
                  { name: "validBefore", type: "uint256" },
                  { name: "nonce", type: "bytes32" },
                ],
              },
              primaryType: "TransferWithAuthorization",
              message: {
                from: getAddress(authorization.from),
                to: getAddress(authorization.to),
                value: BigInt(authorization.value),
                validAfter: BigInt(authorization.validAfter),
                validBefore: BigInt(authorization.validBefore),
                nonce: authorization.nonce,
              },
            });
            return { x402Version: version, payload: { authorization, signature } };
          },
        };
      }

      // ExactEvmScheme handles any eip155 chain; the wildcard keeps one client
      // usable across base / base-sepolia / future EVM networks. The DACS rail
      // has already authenticated the exact network, token and amount, so
      // discard every challenge option outside that exact spending tuple.
      const core = new x402Client()
        .register("eip155:*", scheme)
        .registerPolicy((_version, candidates) => candidates.filter((candidate) =>
          candidate.network === network &&
          typeof candidate.asset === "string" &&
          candidate.asset.toLowerCase() === asset.toLowerCase() &&
          typeof candidate.amount === "string" &&
          sameAmount(candidate.amount, amount)));
      const client = new x402HTTPClient(core) as unknown as X402ClientLike;
      return x402SettleCore({
        paywallUrl,
        network,
        recipientEvm,
        amount,
        asset,
        finalityBlocks,
        ...(jobId === undefined ? {} : { jobId }),
        ...(phaseIndex === undefined ? {} : { phaseIndex }),
        ...(requestInit === undefined ? {} : { requestInit }),
      }, {
        client,
        fetchImpl,
        payerAddress: account.address,
        assertFinalityContext: async ({ chainId }) => {
          const authenticated = await finalityClient(chainId);
          if (await authenticated.getChainId() !== chainId) {
            throw new CounterpartyError(
              "x402: RPC chain id does not match the negotiated network",
            );
          }
        },
        authenticateTransfer: async (request) =>
          verifyEvmTransferFinality(request, await finalityClient(request.chainId)),
      }, effectFence);
    },
  };
}

/**
 * Bridge an X402Rail to the runSession `settle` seam. The paywall coordinates
 * (url / network / recipientEvm / token) are static for the rail — resolved
 * from the listing + the steward rail descriptor — while runSession supplies the
 * per-session amount.
 *
 * `paywall.asset` is the canonical ON-CHAIN token id (the ERC-20 contract, same
 * kind of value the 402 advertises), NOT the human Price.asset symbol. It's what
 * the §4.1 guard compares against — mixing a symbol in here would abort every
 * real payment. Like the evm-erc20 rail, the token address is rail config, so
 * the symbol→token resolution is the steward's registry entry, not runtime code.
 */
export function x402Settle(
  rail: X402Rail,
  paywall: {
    url: string;
    network: string;
    recipientEvm: string;
    asset: string;
    phaseIndex?: number;
  },
  opts: { store?: SettlementIdempotencyStore; reconcile?: SettlementReconcile } = {},
): (req: SettleRequest) => Promise<SettleResult> {
  const store = opts.store ?? createIdempotencyStore();
  const paywallUrl = paywall.url;
  const network = paywall.network;
  const recipientEvm = paywall.recipientEvm;
  const asset = paywall.asset;
  const configuredPhaseIndex = paywall.phaseIndex;
  const reconcile = opts.reconcile;
  const payerAddress = rail.address;
  const finalityBlocks = rail.finalityBlocks;
  if (!Number.isSafeInteger(finalityBlocks) || finalityBlocks <= 0) {
    throw new CounterpartyError("x402 rail must expose its positive finality policy");
  }
  return (req) => {
    const { amount, asset: agreementAsset, expectedPayee, jobId, phase, rail: railId } = req;
    if (expectedPayee !== recipientEvm) {
      throw new CounterpartyError(
        `x402 destination mismatch: request binds ${expectedPayee}, configured paywall pays ${recipientEvm}`,
      );
    }
    // phaseIndex is a property of the SETTLEMENT REQUEST, not the static paywall
    // descriptor: the SB-3 authorization nonce MUST bind the same phase the
    // idempotency key dedupes on, or the on-chain single-use nonce and the
    // (railId, jobId, phaseIndex) key describe different phases. Source it from
    // `req` (falling back to the paywall override, then 0) and use the one value
    // for BOTH. (The prior `paywall.phaseIndex`-only wiring made the production
    // `requireSessionBinding` path throw whenever the paywall omitted it, even
    // though the session carried a phase.)
    const phaseIndex = req.phaseIndex ?? configuredPhaseIndex ?? 0;
    const binding = Object.freeze({
      bindingVersion: "1",
      railId,
      jobId,
      phaseIndex,
      phase,
      amount,
      agreementAsset,
      settlementAsset: asset,
      payer: payerAddress,
      payee: recipientEvm,
      network,
      finality: Object.freeze({ model: "block-depth", finalityBlocks }),
      effectIdentity: `0x${sha256Hex(
        `dacs-sb3:v1:${jobId.normalize("NFC")}:${phaseIndex}`,
      )}`,
      resource: paywallUrl,
    }) satisfies Readonly<SettlementBinding>;
    const submit = (effectFence?: Readonly<SettlementEffectFence>) =>
      rail.settle({
        paywallUrl,
        network,
        recipientEvm,
        amount,
        asset,
        jobId,
        phaseIndex,
      }, effectFence);
    // Safe by default: at-most-once per (railId, jobId, phaseIndex) via an
    // idempotency store (in-process default; inject a durable one for cross-process
    // crash-safety). NOTE: reproducing the exact x402 authorization/session binding
    // on a reconciled resubmit is the SB-3 work in #33. A durable recovery may
    // replay only when `reconcile` returns an authorization bound to this exact
    // deterministic EIP-3009 nonce; absence alone still fails closed.
    return store.once(
      settlementKey(railId, jobId, phaseIndex),
      binding,
      submit,
      reconcile,
    );
  };
}
