import {
  advanceX402BuyerSettlement,
  assertX402BuyerSettlementIntent,
  createX402BuyerEvmAuthorizationProvider,
  createX402BuyerRetainedDisclosureRecovery,
  type WalletSpendAuthorityDependenciesV1,
  type WalletSpendAuthorityV1,
  type WalletSpendPermitV1,
  type WalletSpendRecoveryObservationV1,
  type WalletSpendReservationV1,
  type WalletSpendSettlementObservationV1,
  type FixedPriceX402TrackOperation,
  type FixedPriceX402TrackOperationInput,
  type X402BuyerAuthorizationProvider,
  type X402BuyerCapturedSettlement,
  type X402BuyerEvmDisclosureRecovery,
  type X402BuyerEvmReadClient,
  type X402BuyerEvmSignatureVerifier,
  type X402BuyerEvmUnusedConfirmer,
  type X402BuyerEffectFence,
  type X402BuyerPaidRequestTransport,
  type X402BuyerSettlementDisclosure,
  type X402BuyerSettlementIntent,
  type X402BuyerSettlementStore,
} from "@kynesyslabs/dacs";
import { canonicalize } from "@kynesyslabs/dacs/canonical";

import {
  createDacsLiveEffectTrackV1,
  type DacsLiveEffectExecutionControlV1,
  type DacsLiveEffectFenceV1,
  type DacsLiveEffectReconciliationV1,
} from "./liveEffects.js";
import type { DacsNodeSqliteDatabase } from "./sqlite.js";

const HASH_RE = /^[0-9a-f]{64}$/;

export interface DacsX402BuyerPaymentInputV1 {
  paymentInputVersion: "1";
  orderBindingHash: string;
  orderLocalBindingHash: string;
  intent: Readonly<X402BuyerSettlementIntent>;
}

export interface DacsX402BuyerPaymentResultV1 {
  paymentResultVersion: "1";
  settlement: Readonly<X402BuyerCapturedSettlement>;
}

export interface DacsX402BuyerPaymentTrackOptionsV1<TObservation = unknown> {
  database: DacsNodeSqliteDatabase;
  workerId: string;
  settlementStore: X402BuyerSettlementStore;
  authorizationProvider: X402BuyerAuthorizationProvider<TObservation>;
  transport: X402BuyerPaidRequestTransport;
  /** Mandatory wallet/chain-wide authority for this unattended buyer. */
  walletSpendAuthority: Readonly<WalletSpendAuthorityV1>;
  /** Authenticated rail finality depth bound into the wallet reservation. */
  finalityBlocks: number;
  /**
   * Prepare and sign the exact x402 bearer. It runs only when no authenticated
   * SQLite effect intent exists; restart recovery reuses those exact bytes.
   */
  prepareIntent(
    input: Readonly<FixedPriceX402TrackOperationInput>,
  ): Promise<Readonly<X402BuyerSettlementIntent>> |
    Readonly<X402BuyerSettlementIntent>;
  /** Application-owned agreement/rail/session authority for the prepared intent. */
  authorizePreparedIntent(input: Readonly<{
    order: Readonly<FixedPriceX402TrackOperationInput["order"]>;
    intent: Readonly<X402BuyerSettlementIntent>;
  }>): Promise<boolean> | boolean;
  effectLeaseDurationMs?: number;
  settlementLeaseDurationMs?: number;
  retryDelayMs?: number;
}

export interface DacsX402WalletSpendRecoveryAuthenticatorOptionsV1 {
  /** Integrity-checked x402 store retaining the exact signed bearer. */
  settlementStore: X402BuyerSettlementStore;
  /** Process-specific owner used to fence recovery against paid-request workers. */
  owner: string;
  chainId: number;
  minimumConfirmations: number;
  authorizationSearchFromBlock: number;
  client: X402BuyerEvmReadClient;
  /** Defaults to the SDK's production viem EIP-712 verifier. */
  verifySignature?: X402BuyerEvmSignatureVerifier;
  /** Required before a live authorization can be authenticated as unused. */
  confirmUnused?: X402BuyerEvmUnusedConfirmer;
  /** Defaults to the SDK's locked-down retained disclosure recovery. */
  recoverDisclosure?: X402BuyerEvmDisclosureRecovery;
}

export class DacsX402BuyerPaymentError extends Error {
  override readonly name = "DacsX402BuyerPaymentError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function safeReasonCode(prefix: string, value: unknown): string {
  const reason = typeof value === "string" ? value.toLowerCase() : "unavailable";
  const normalized = reason.replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "");
  return `${prefix}-${normalized || "unavailable"}`.slice(0, 80).replace(/-+$/g, "");
}

function control(
  status: "indeterminate" | "operator-action",
  reasonCode: string,
): DacsLiveEffectExecutionControlV1 {
  return Object.freeze({ effectControlVersion: "1", status, reasonCode });
}

function capturePaymentInput(value: unknown): Readonly<DacsX402BuyerPaymentInputV1> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DacsX402BuyerPaymentError("x402-payment-input-invalid");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 4 || record.paymentInputVersion !== "1" ||
      typeof record.orderBindingHash !== "string" || !HASH_RE.test(record.orderBindingHash) ||
      typeof record.orderLocalBindingHash !== "string" ||
      !HASH_RE.test(record.orderLocalBindingHash)) {
    throw new DacsX402BuyerPaymentError("x402-payment-input-invalid");
  }
  assertX402BuyerSettlementIntent(record.intent);
  return record as unknown as Readonly<DacsX402BuyerPaymentInputV1>;
}

function resultFromSettlement(
  settlement: Readonly<X402BuyerCapturedSettlement>,
): Readonly<DacsX402BuyerPaymentResultV1> {
  return Object.freeze({
    paymentResultVersion: "1",
    settlement,
  });
}

function disclosureFromSettlement(
  settlement: Readonly<X402BuyerCapturedSettlement>,
): Readonly<X402BuyerSettlementDisclosure> {
  return Object.freeze({
    protocolVersion: settlement.protocolVersion,
    headerName: settlement.headerName,
    encodedSettlementHeader: settlement.encodedSettlementHeader,
    httpResource: settlement.httpResource,
  });
}

function referenceFromSettlement(settlement: Readonly<X402BuyerCapturedSettlement>): string {
  return `x402:${settlement.signedEvent.chainId}:` +
    `${settlement.signedEvent.settlementTxHash}:${settlement.signedEvent.logIndex}`;
}

function walletReservation(
  payment: Readonly<DacsX402BuyerPaymentInputV1>,
  finalityBlocks: number,
): Readonly<WalletSpendReservationV1> {
  return walletReservationForIntent(payment.intent, finalityBlocks);
}

function walletReservationForIntent(
  intent: Readonly<X402BuyerSettlementIntent>,
  finalityBlocks: number,
): Readonly<WalletSpendReservationV1> {
  return Object.freeze({
    reservationVersion: "1",
    reservationId: `x402:${intent.settlementKey}`,
    jobId: intent.jobId,
    phaseIndex: intent.phaseIndex,
    phase: "pay-x402",
    agreementHash: intent.agreementHash,
    settlementBindingHash: intent.bindingHash,
    railId: intent.railId,
    railDefinitionHash: intent.railDescriptorHash,
    wallet: intent.payer.toLowerCase(),
    chainId: intent.network,
    payee: intent.payee.toLowerCase(),
    finality: Object.freeze({ model: "confirmation-depth", finalityBlocks }),
    debits: Object.freeze([Object.freeze({
      asset: intent.asset.toLowerCase(),
      purpose: "service" as const,
      expectedAmount: intent.amount,
      maximumAmount: intent.amount,
    })]),
  });
}

function walletSettlement(
  payment: Readonly<DacsX402BuyerPaymentInputV1>,
  settlement: Readonly<X402BuyerCapturedSettlement>,
): Readonly<WalletSpendSettlementObservationV1> {
  return walletSettlementForIntent(payment.intent, settlement);
}

function walletSettlementForIntent(
  intent: Readonly<X402BuyerSettlementIntent>,
  settlement: Readonly<X402BuyerCapturedSettlement>,
): Readonly<WalletSpendSettlementObservationV1> {
  return Object.freeze({
    disposition: "settled",
    evidenceHash: settlement.authenticationHash,
    debits: Object.freeze([Object.freeze({
      asset: intent.asset.toLowerCase(),
      purpose: "service" as const,
      amount: intent.amount,
    })]),
  });
}

/**
 * Re-authenticate generated x402 wallet recovery from the retained exact intent
 * through the SDK's EIP-3009 event, receipt, ancestry, and unused-state checks.
 * Local settlement records are candidates only; they never become proof alone.
 */
export function createDacsX402WalletSpendRecoveryAuthenticatorV1(
  options: Readonly<DacsX402WalletSpendRecoveryAuthenticatorOptionsV1>,
): WalletSpendAuthorityDependenciesV1["authenticateRecovery"] {
  if (options === null || typeof options !== "object" ||
      !options.settlementStore || typeof options.settlementStore.load !== "function" ||
      typeof options.settlementStore.claim !== "function" ||
      typeof options.settlementStore.isCurrent !== "function" ||
      typeof options.owner !== "string" || options.owner.length === 0 ||
      !Number.isSafeInteger(options.chainId) || options.chainId <= 0 ||
      !Number.isSafeInteger(options.minimumConfirmations) ||
      options.minimumConfirmations <= 0 ||
      !Number.isSafeInteger(options.authorizationSearchFromBlock) ||
      options.authorizationSearchFromBlock < 0 || !options.client ||
      (options.verifySignature !== undefined &&
        typeof options.verifySignature !== "function") ||
      (options.confirmUnused !== undefined &&
        typeof options.confirmUnused !== "function") ||
      (options.recoverDisclosure !== undefined &&
        typeof options.recoverDisclosure !== "function")) {
    throw new TypeError("x402 wallet recovery authenticator options are invalid");
  }
  const settlementStore = options.settlementStore;
  const owner = options.owner;
  const chainId = options.chainId;
  const minimumConfirmations = options.minimumConfirmations;
  const authorizationSearchFromBlock = options.authorizationSearchFromBlock;
  const client = options.client;
  const verifySignature = options.verifySignature;
  const confirmUnused = options.confirmUnused;
  const recoverDisclosure = options.recoverDisclosure ??
    createX402BuyerRetainedDisclosureRecovery({});

  return async (
    reservation: Readonly<WalletSpendReservationV1>,
    observation: Readonly<WalletSpendRecoveryObservationV1>,
  ): Promise<boolean> => {
    try {
      if (!reservation.reservationId.startsWith("x402:")) return false;
      const settlementKey = reservation.reservationId.slice("x402:".length);
      if (settlementKey.length === 0) return false;
      let candidate: Readonly<X402BuyerSettlementDisclosure> | undefined;
      const loaded = await settlementStore.load(settlementKey);
      if (loaded.status === "absent" || loaded.status === "unsupported" ||
          loaded.status === "corrupt") {
        return false;
      }
      if (loaded.intent.settlementKey !== settlementKey ||
          canonicalize(walletReservationForIntent(loaded.intent, minimumConfirmations)) !==
            canonicalize(reservation)) {
        return false;
      }
      const claimed = await settlementStore.claim({
        intent: loaded.intent,
        owner,
        now: Date.now(),
        leaseDurationMs: 30_000,
      });
      if ((claimed.status === "waiting" && claimed.lease.owner !== owner) ||
          claimed.status === "conflict" ||
          claimed.status === "unsupported" || claimed.status === "corrupt") {
        return false;
      }
      const intent = claimed.intent;
      if (intent.settlementKey !== settlementKey ||
          canonicalize(walletReservationForIntent(intent, minimumConfirmations)) !==
            canonicalize(reservation)) {
        return false;
      }
      let fence: Readonly<X402BuyerEffectFence>;
      if (claimed.status === "acquired" || claimed.status === "waiting") {
        candidate = claimed.pendingDisclosure;
        fence = Object.freeze({
          owner: claimed.lease.owner,
          generation: claimed.lease.generation,
          settlementKey: intent.settlementKey,
          bindingHash: intent.bindingHash,
          idempotencyKey: intent.settlementKey,
          async assertCurrent() {
            if (!await settlementStore.isCurrent({
              settlementKey: intent.settlementKey,
              bindingHash: intent.bindingHash,
              lease: claimed.lease,
              now: Date.now(),
            })) {
              throw new DacsX402BuyerPaymentError("x402-wallet-recovery-stale");
            }
          },
        });
      } else {
        if (claimed.status === "captured") {
          if (claimed.outcome.status !== "captured") return false;
          candidate = disclosureFromSettlement(claimed.outcome.settlement);
        } else if (claimed.outcome.status !== "failed") {
          return false;
        }
        const terminalSnapshot = canonicalize(claimed);
        fence = Object.freeze({
          owner,
          generation: 1,
          settlementKey: intent.settlementKey,
          bindingHash: intent.bindingHash,
          idempotencyKey: intent.settlementKey,
          async assertCurrent() {
            if (canonicalize(await settlementStore.load(intent.settlementKey)) !==
                terminalSnapshot) {
              throw new DacsX402BuyerPaymentError("x402-wallet-recovery-stale");
            }
          },
        });
      }

      const provider = createX402BuyerEvmAuthorizationProvider({
        chainId,
        minimumConfirmations,
        authorizationSearchFromBlock,
        client,
        authorizeIntent: async ({ intent: candidateIntent }) =>
          canonicalize(candidateIntent) === canonicalize(intent)
          ? { disposition: "authorized" as const, bindingHash: candidateIntent.bindingHash }
          : { disposition: "rejected" as const, reason: "wallet-reservation-mismatch" },
        ...(verifySignature === undefined ? {} : { verifySignature }),
        ...(confirmUnused === undefined ? {} : { confirmUnused }),
        recoverDisclosure,
      });
      const lookup = await provider.lookup(intent, candidate, fence);
      if (lookup.disposition !== "observed") return false;
      const recovered = await provider.authenticate(
        intent,
        lookup,
        candidate,
        fence,
      );
      if (observation.disposition === "settled") {
        return recovered.disposition === "settled-same" &&
          canonicalize(walletSettlementForIntent(intent, recovered.settlement)) ===
            canonicalize(observation);
      }
      return recovered.disposition === "unused" &&
        recovered.authenticationHash === observation.evidenceHash;
    } catch {
      return false;
    }
  };
}

function combinedFence(
  inner: Readonly<X402BuyerEffectFence>,
  outer: Readonly<DacsLiveEffectFenceV1>,
  wallet?: Readonly<WalletSpendPermitV1>,
): Readonly<X402BuyerEffectFence> {
  return Object.freeze({
    owner: inner.owner,
    generation: inner.generation,
    settlementKey: inner.settlementKey,
    bindingHash: inner.bindingHash,
    idempotencyKey: inner.idempotencyKey,
    async assertCurrent() {
      await outer.assertCurrent();
      await inner.assertCurrent();
      await wallet?.assertCurrent();
    },
  });
}

function reconciliationFence(
  intent: Readonly<X402BuyerSettlementIntent>,
  outer: Readonly<DacsLiveEffectFenceV1>,
  owner: string,
): Readonly<X402BuyerEffectFence> {
  return Object.freeze({
    owner,
    generation: outer.generation,
    settlementKey: intent.settlementKey,
    bindingHash: intent.bindingHash,
    idempotencyKey: intent.settlementKey,
    assertCurrent: () => outer.assertCurrent(),
  });
}

/**
 * Compose the core durable buyer settlement state machine into the buyer's
 * payment track. The outer keyed SQLite fence is the only replay grant; the
 * inner x402 store retains the exact paid response for chain reconciliation.
 */
export function createDacsX402BuyerPaymentTrackV1<TObservation = unknown>(
  options: Readonly<DacsX402BuyerPaymentTrackOptionsV1<TObservation>>,
): FixedPriceX402TrackOperation {
  if (options === null || typeof options !== "object" ||
      typeof options.workerId !== "string" || options.workerId.length === 0 ||
      !options.settlementStore || typeof options.settlementStore.load !== "function" ||
      !options.authorizationProvider ||
      typeof options.authorizationProvider.authorizeIntent !== "function" ||
      typeof options.authorizationProvider.lookup !== "function" ||
      typeof options.authorizationProvider.authenticate !== "function" ||
      !options.transport || typeof options.transport.submitRetained !== "function" ||
      !options.walletSpendAuthority ||
      typeof options.walletSpendAuthority.reserve !== "function" ||
      typeof options.walletSpendAuthority.reconcile !== "function" ||
      !Number.isSafeInteger(options.finalityBlocks) || options.finalityBlocks <= 0 ||
      typeof options.prepareIntent !== "function" ||
      typeof options.authorizePreparedIntent !== "function") {
    throw new TypeError("x402 buyer payment track options are invalid");
  }
  if (options.database.metadata.mode !== "live-demos" ||
      options.database.metadata.role !== "buyer") {
    throw new TypeError("x402 buyer payment track requires a live buyer database");
  }
  const database = options.database;
  const workerId = options.workerId;
  const settlementStore = options.settlementStore;
  const provider = options.authorizationProvider;
  const transport = options.transport;
  const walletSpendAuthority = options.walletSpendAuthority;
  const finalityBlocks = options.finalityBlocks;
  const settlementLeaseDurationMs = options.settlementLeaseDurationMs ?? 30_000;
  if (!Number.isSafeInteger(settlementLeaseDurationMs) ||
      settlementLeaseDurationMs <= 0 || settlementLeaseDurationMs > 600_000) {
    throw new TypeError("x402 buyer settlement lease duration is invalid");
  }

  function sameSettlement(
    left: Readonly<X402BuyerCapturedSettlement>,
    right: Readonly<X402BuyerCapturedSettlement>,
  ): boolean {
    try {
      return canonicalize(left) === canonicalize(right);
    } catch {
      return false;
    }
  }

  async function persistAuthenticatedSettlement(
    paymentInput: Readonly<DacsX402BuyerPaymentInputV1>,
    settlement: Readonly<X402BuyerCapturedSettlement>,
    outerFence: Readonly<DacsLiveEffectFenceV1>,
  ): Promise<Readonly<DacsLiveEffectReconciliationV1<DacsX402BuyerPaymentResultV1>>> {
    const owner = `${workerId}-reconcile-${outerFence.generation}`;
    const inheritedExecutionOwner = (candidate: string): boolean => {
      const prefix = `${workerId}-`;
      if (!candidate.startsWith(prefix)) return false;
      const suffix = candidate.slice(prefix.length);
      if (!/^[1-9][0-9]*$/.test(suffix)) return false;
      const generation = Number(suffix);
      return Number.isSafeInteger(generation) && generation < outerFence.generation;
    };
    try {
      await outerFence.assertCurrent();
      const claimed = await settlementStore.claim({
        intent: paymentInput.intent,
        owner,
        now: database.readTime(),
        leaseDurationMs: settlementLeaseDurationMs,
      });
      await outerFence.assertCurrent();
      if (claimed.status === "captured") {
        return claimed.outcome.status === "captured" &&
            sameSettlement(claimed.outcome.settlement, settlement)
          ? { status: "completed", result: resultFromSettlement(settlement) }
          : { status: "operator-action", reasonCode: "x402-store-settlement-conflict" };
      }
      if (claimed.status === "failed") {
        return { status: "operator-action", reasonCode: "x402-store-terminal-failure" };
      }
      if (claimed.status === "conflict") {
        return { status: "operator-action", reasonCode: "x402-store-intent-conflict" };
      }
      if (claimed.status === "unsupported" || claimed.status === "corrupt") {
        return {
          status: "indeterminate",
          reasonCode: claimed.status === "unsupported"
            ? "x402-store-version-unsupported" : "x402-store-corrupt",
        };
      }
      if (claimed.status === "waiting" &&
          !inheritedExecutionOwner(claimed.lease.owner)) {
        // Never record through an unrelated worker's live lease. The one
        // exception below is a lease created by an earlier generation of this
        // exact outer effect: the current keyed outer fence proves that prior
        // execution has been superseded, while chain authentication proves the
        // terminal settlement being retained.
        return { status: "indeterminate", reasonCode: "x402-store-lease-held" };
      }
      if ((claimed.status !== "acquired" && claimed.status !== "waiting") ||
          claimed.intent.bindingHash !== paymentInput.intent.bindingHash ||
          (claimed.status === "acquired" && claimed.lease.owner !== owner) ||
          !Number.isSafeInteger(claimed.lease.generation) ||
          claimed.lease.generation <= 0) {
        return { status: "indeterminate", reasonCode: "x402-store-claim-invalid" };
      }
      const innerFence: X402BuyerEffectFence = Object.freeze({
        owner: claimed.lease.owner,
        generation: claimed.lease.generation,
        settlementKey: paymentInput.intent.settlementKey,
        bindingHash: paymentInput.intent.bindingHash,
        idempotencyKey: paymentInput.intent.settlementKey,
        async assertCurrent() {
          if (!await settlementStore.isCurrent({
            settlementKey: paymentInput.intent.settlementKey,
            bindingHash: paymentInput.intent.bindingHash,
            lease: claimed.lease,
            now: database.readTime(),
          })) {
            throw new DacsX402BuyerPaymentError("x402-store-generation-stale");
          }
        },
      });
      const fence = combinedFence(innerFence, outerFence);
      await fence.assertCurrent();
      const written = await settlementStore.recordOutcome({
        settlementKey: paymentInput.intent.settlementKey,
        bindingHash: paymentInput.intent.bindingHash,
        lease: claimed.lease,
        outcome: {
          outcomeVersion: "1",
          status: "captured",
          settlement,
        },
        now: database.readTime(),
      });
      await outerFence.assertCurrent();
      if (written.status === "recorded" || written.status === "existing") {
        return written.outcome.status === "captured" &&
            sameSettlement(written.outcome.settlement, settlement)
          ? { status: "completed", result: resultFromSettlement(settlement) }
          : { status: "operator-action", reasonCode: "x402-store-settlement-conflict" };
      }
      if (written.status === "conflict") {
        return { status: "operator-action", reasonCode: "x402-store-settlement-conflict" };
      }
      return {
        status: "indeterminate",
        reasonCode: written.status === "unsupported"
          ? "x402-store-version-unsupported" : written.status === "corrupt"
            ? "x402-store-corrupt" : "x402-store-generation-stale",
      };
    } catch {
      // The authenticated terminal write may have committed before its local
      // acknowledgement. Resolve that ambiguity from the exact retained key.
      try {
        const loaded = await settlementStore.load(paymentInput.intent.settlementKey);
        if (loaded.status === "captured" && loaded.outcome.status === "captured" &&
            sameSettlement(loaded.outcome.settlement, settlement)) {
          await outerFence.assertCurrent();
          return { status: "completed", result: resultFromSettlement(settlement) };
        }
      } catch {
        // A failed read cannot establish that the terminal write committed.
      }
      return { status: "indeterminate", reasonCode: "x402-store-outcome-write-indeterminate" };
    }
  }

  async function reconcileFromChain(
    paymentInput: Readonly<DacsX402BuyerPaymentInputV1>,
    outerFence: Readonly<DacsLiveEffectFenceV1>,
    candidate?: Readonly<X402BuyerSettlementDisclosure>,
  ): Promise<Readonly<DacsLiveEffectReconciliationV1<DacsX402BuyerPaymentResultV1>>> {
    const fence = reconciliationFence(paymentInput.intent, outerFence, workerId);
    try {
      await fence.assertCurrent();
      const lookup = await provider.lookup(paymentInput.intent, candidate, fence);
      await fence.assertCurrent();
      if (lookup.disposition !== "observed") {
        return {
          status: "indeterminate",
          reasonCode: safeReasonCode("x402", lookup.reason),
        };
      }
      const recovered = await provider.authenticate(
        paymentInput.intent,
        lookup,
        candidate,
        fence,
      );
      await fence.assertCurrent();
      if (recovered.disposition === "settled-same") {
        const persisted = await persistAuthenticatedSettlement(
          paymentInput,
          recovered.settlement,
          outerFence,
        );
        if (persisted.status === "completed") {
          await walletSpendAuthority.reconcile(
            walletReservation(paymentInput, finalityBlocks),
            walletSettlement(paymentInput, recovered.settlement),
          );
        }
        return persisted;
      }
      if (recovered.disposition === "unused") {
        if (!HASH_RE.test(recovered.authenticationHash)) {
          return { status: "indeterminate", reasonCode: "x402-absence-proof-invalid" };
        }
        await walletSpendAuthority.reconcile(
          walletReservation(paymentInput, finalityBlocks),
          Object.freeze({
            disposition: "terminal-absent",
            evidenceHash: recovered.authenticationHash,
          }),
        );
        return { status: "absent", absenceProofHash: recovered.authenticationHash };
      }
      if (recovered.disposition === "used-different" ||
          recovered.disposition === "cancelled" ||
          recovered.disposition === "expired-unused") {
        return {
          status: "operator-action",
          reasonCode: `x402-terminal-${recovered.disposition}`,
        };
      }
      return {
        status: "indeterminate",
        reasonCode: safeReasonCode("x402", recovered.reason),
      };
    } catch {
      return {
        status: "indeterminate",
        reasonCode: "x402-authorization-reconciliation-unavailable",
      };
    }
  }

  const adapter = {
    async execute(invocation: Readonly<{
      input: Readonly<DacsX402BuyerPaymentInputV1>;
      fence: Readonly<DacsLiveEffectFenceV1>;
    }>) {
      const paymentInput = capturePaymentInput(invocation.input);
      if (paymentInput.orderLocalBindingHash !== invocation.fence.bindingHash ||
          paymentInput.intent.jobId !== invocation.fence.jobId) {
        return control("operator-action", "x402-payment-binding-mismatch");
      }
      const reservation = walletReservation(paymentInput, finalityBlocks);
      const claim = await walletSpendAuthority.reserve(reservation);
      if (claim.status !== "reserved") {
        return control(
          claim.status === "held" || claim.status === "settled"
            ? "indeterminate" : "operator-action",
          claim.status === "denied"
            ? `wallet-spend-${claim.reason}`
            : `wallet-spend-${claim.status}`,
        );
      }
      const wrap = (fence: Readonly<X402BuyerEffectFence>) =>
        combinedFence(fence, invocation.fence, claim.permit);
      const progress = await advanceX402BuyerSettlement({
        intent: paymentInput.intent,
        owner: `${workerId}-${invocation.fence.generation}`,
        store: settlementStore,
        authorizationProvider: {
          authorizeIntent: (intent, fence) =>
            provider.authorizeIntent(intent, wrap(fence)),
          lookup: (intent, candidate, fence) =>
            provider.lookup(intent, candidate, wrap(fence)),
          authenticate: (intent, lookup, candidate, fence) =>
            provider.authenticate(intent, lookup, candidate, wrap(fence)),
        },
        transport: {
          submitRetained: async (intent, fence) => {
            await claim.permit.beginEffect();
            return transport.submitRetained(intent, wrap(fence));
          },
        },
        now: () => database.readTime(),
        leaseDurationMs: settlementLeaseDurationMs,
      });
      if (progress.status === "captured") {
        // The inner store is a recovery checkpoint, not the keyed authority.
        // Re-authenticate even a retained terminal result before the outer
        // SQLite effect can become complete.
        const recovered = await reconcileFromChain(
          paymentInput,
          invocation.fence,
          disclosureFromSettlement(progress.outcome.settlement),
        );
        if (recovered.status === "completed") return recovered.result;
        if (recovered.status === "operator-action") {
          return control("operator-action", recovered.reasonCode);
        }
        return control(
          "indeterminate",
          recovered.status === "absent"
            ? "x402-paid-response-not-chain-final"
            : recovered.reasonCode,
        );
      }
      if (progress.status === "failed") {
        return control("operator-action", `x402-terminal-${progress.outcome.failure}`);
      }
      return control(
        "indeterminate",
        safeReasonCode("x402", progress.reason),
      );
    },

    async reconcile(invocation: Readonly<{
      input: Readonly<DacsX402BuyerPaymentInputV1>;
      fence: Readonly<DacsLiveEffectFenceV1>;
    }>): Promise<Readonly<DacsLiveEffectReconciliationV1<DacsX402BuyerPaymentResultV1>>> {
      const paymentInput = capturePaymentInput(invocation.input);
      if (paymentInput.orderLocalBindingHash !== invocation.fence.bindingHash ||
          paymentInput.intent.jobId !== invocation.fence.jobId) {
        return { status: "operator-action", reasonCode: "x402-payment-binding-mismatch" };
      }
      let candidate: Readonly<X402BuyerSettlementDisclosure> | undefined;
      try {
        const stored = await settlementStore.load(paymentInput.intent.settlementKey);
        if (stored.status === "captured") {
          if (stored.outcome.status !== "captured") {
            return { status: "indeterminate", reasonCode: "x402-store-terminal-invalid" };
          }
          candidate = disclosureFromSettlement(stored.outcome.settlement);
        } else if (stored.status === "failed") {
          if (stored.outcome.status !== "failed") {
            return { status: "indeterminate", reasonCode: "x402-store-terminal-invalid" };
          }
          // The inner filesystem store is deliberately not a terminal trust
          // root. Reconcile its retained intent against chain state below.
        } else if (stored.status === "held") candidate = stored.pendingDisclosure;
        else if (stored.status === "corrupt" || stored.status === "unsupported") {
          return {
            status: "indeterminate",
            reasonCode: stored.status === "corrupt"
              ? "x402-store-corrupt" : "x402-store-version-unsupported",
          };
        }
      } catch {
        return { status: "indeterminate", reasonCode: "x402-store-unavailable" };
      }
      return reconcileFromChain(paymentInput, invocation.fence, candidate);
    },
  };

  return createDacsLiveEffectTrackV1({
    database,
    kind: "payment",
    role: "buyer",
    track: "payment",
    workerId,
    ...(options.effectLeaseDurationMs === undefined
      ? {} : { leaseDurationMs: options.effectLeaseDurationMs }),
    ...(options.retryDelayMs === undefined
      ? {} : { retryDelayMs: options.retryDelayMs }),
    async buildInput(operationInput) {
      const intent = await options.prepareIntent(operationInput);
      assertX402BuyerSettlementIntent(intent);
      if (intent.jobId !== operationInput.order.jobId ||
          await options.authorizePreparedIntent({
            order: operationInput.order,
            intent,
          }) !== true) {
        throw new DacsX402BuyerPaymentError("x402-prepared-intent-unauthorized");
      }
      return {
        paymentInputVersion: "1" as const,
        orderBindingHash: operationInput.order.bindingHash,
        orderLocalBindingHash: operationInput.order.localBindingHash,
        intent,
      };
    },
    adapter,
    projectResult: (result) => ({
      reference: referenceFromSettlement(result.settlement),
      authenticationHash: result.settlement.authenticationHash,
    }),
  });
}
