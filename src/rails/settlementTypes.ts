import type { ChainTxRef, SettlementFinalityParameters } from "../artifacts/types.js";

export interface SettleRequest {
  rail: string;
  /** Exact payment PhaseStep kind whose invocation is being settled. */
  phase: string;
  amount: string;
  asset: string;
  /** The seller claim bound by the Listing/Agreement. */
  payee: string;
  /**
   * Runtime rail destination selected by the buyer. This is separate from
   * `payee`: an EVM/x402 destination and a seller DID are different namespaces.
   * On the legacy path it is retained in a buyer-signed extension, not negotiated
   * with seller authority. A rail MUST pay this destination and return this exact
   * identifier as `SettleResult.payee`.
   */
  expectedPayee: string;
  jobId: string;
  /**
   * The settlement phase index — part of the `(railId, jobId, phaseIndex)`
   * idempotency key a rail dedupes on. Defaults to 0 (the single MVP
   * settle phase) when the caller omits it.
   */
  phaseIndex?: number;
  /**
   * Ordered durable transaction attempts supplied only to `resumeSettlement`.
   * A fresh process uses this history to reconcile every ambiguous attempt and
   * prove a replacement submission supersedes the latest one. Ordinary fresh
   * settlement requests omit it.
   */
  priorAttempts?: readonly SettlementRecoveryAttempt[];
  /**
   * Set by `runSession` on every `resumeSettlement` request. A bridge honours it
   * by never taking a fresh claim: it settles through its store's `recover`,
   * whose own atomic claim returns a recorded outcome or reconciles an
   * unresolved intent (adopting a payment it proves landed), and refuses when
   * the store holds no unresolved intent for the key. A store without `recover`
   * is refused.
   */
  recoveryOnly?: boolean;
}

export interface SettlementRecoveryAttempt {
  txHash: string;
  chainId: string;
  ok: boolean;
}

export interface SettleResult {
  ok: boolean;
  /** Permanent only with a bound terminal-failure proof; never permits rebroadcast. */
  errorClass?: "permanent";
  failureProof?: DemosFailedRecordProof;
  txHash: string;
  chainId: string;
  payer: string;
  payee: string;
  /**
   * Rail-specific finality (§9.5.x / PC-6). When a rail knows the finality model
   * it settled under, it reports it here and runSessionCore records it on the
   * evidence instead of the default provider-receipt. E.g. §9.5.9 pay-dem →
   * `{ model: "bft-final" }`. Omit for a receipt-confirmed rail.
   */
  finality?: SettlementFinalityParameters;
  /** Block/ledger height the settlement landed at, when the rail reports it (§9.5.9 `demos`). */
  blockNumber?: number;
  /** The txRef kind the rail's tx is (e.g. §9.5.9 `demos`); defaults to `payment`. */
  txRefKind?: string;
  /** Exact DACS-4 transaction/event reference for current rail producers. */
  txRef?: ChainTxRef;
  /** Authoritative rail finality observation time, not local wall-clock time. */
  finalityObservedAt?: number;
  /** Authenticated native DEM network fee the chain debited from the payer, in integer OS. */
  networkFeeOs?: string;
  /**
   * The fee the native DEM transaction record declares, in integer OS; sent
   * only with `networkFeeOs`. It can differ from what the chain debits.
   */
  recordFeeOs?: string;
  /** Durable raw x402 settlement-response input used to re-derive its receipt hash. */
  x402Receipt?: {
    protocolVersion: "2";
    headerName: "PAYMENT-RESPONSE";
    headerValue: string;
    paymentReceiptHash: string;
  };
}

/**
 * A rail's projection of a terminal failed Demos record. The rail must build it
 * from the node's `getTxByHash` record only after matching the signed
 * hash/nonce, inclusion block and native body. It describes failure of this
 * attempt; it never authorizes a replacement debit.
 *
 * Fields are projections of the node's `getTxByHash` record, in canonical form:
 * `txHash`, `payer` and `payee` are 64 lower-case hex without `0x` (the node
 * serves `0x`-prefixed keys); `nonce` is the record's decimal nonce string
 * converted to a safe integer; `amountOs` is the decimal OS amount. The public
 * result carries this projection; the SDK rail authenticates fresh results
 * with a separate private record verdict.
 */
export interface DemosFailedRecordProof {
  kind: "demos-failed-record";
  txHash: string;
  nonce: number;
  blockNumber: number;
  payer: string;
  payee: string;
  amountOs: string;
}
