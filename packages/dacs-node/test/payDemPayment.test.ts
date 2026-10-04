import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createInMemoryWalletSpendStateStore,
  createWalletSpendAuthorityV1,
  settlementKey,
  type DemosTransferObservation,
  type PayDemRail,
  type WalletSpendAuthorityV1,
  type WalletSpendReservationV1,
} from "@kynesyslabs/dacs";
import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import {
  createFixedPricePayDemBuyerCoordinator,
  FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
  FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
  FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
  type FixedPricePayDemOrderInput,
  type FixedPricePayDemProtocolBinding,
  type FixedPricePayDemTrackOperation,
} from "@kynesyslabs/dacs/commerce";

import { DACS_NODE_LIVE_PROFILE } from "../src/config.js";
import {
  createDacsFixedPricePayDemBuyerReconciliationV1,
} from "../src/fixedPricePayDemBuyerPayment.js";
import {
  createDacsPayDemBuyerPaymentTrackV1,
  createDacsPayDemWalletSpendRecoveryAuthenticatorV1,
  type DacsPayDemBuyerPaymentAuthorityV1,
  type DacsPayDemBuyerPaymentInputV1,
} from "../src/payDemPayment.js";
import { putDacsLiveOrderInputV1 } from "../src/orderInput.js";
import { markDacsSdkPreparedPayDemRailV1 } from
  "../src/payDemRailCapabilities.js";
import {
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";
import {
  createAccountingTestWalletSpendAuthorityV1,
  createPermissiveTestWalletSpendAuthorityV1,
} from "./helpers/walletSpend.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = "did:example:pay-dem-buyer";
const SELLER = "did:example:pay-dem-seller";
const PAYER = "1".repeat(64);
const PAYEE = "2".repeat(64);
const TX_HASH = "3".repeat(64);

const PROTOCOL: FixedPricePayDemProtocolBinding = {
  commerceProfile: FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
  standardRevision: FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
  phase: "pay-dem",
  orchestratorTopology: "seller-as-phase-orchestrator-v1",
  orchestrator: SELLER,
  rail: {
    registryIndexRef: FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
    registryIndexHash: "4".repeat(64),
    railDefinitionRef: "dacs4:rail:demos-native%3ADEM:1",
    railDefinitionHash: "5".repeat(64),
    railId: "demos-native:DEM",
    railVersion: 1,
    railType: "demos-native",
    phaseHandler: "pay-dem",
    network: "demos",
    availability: "live",
  },
};

const ORDER: FixedPricePayDemOrderInput = {
  jobId: JOB_ID,
  buyer: BUYER,
  seller: SELLER,
  protocol: PROTOCOL,
  sdkJobs: {
    role: "buyer",
    agreement: `buyer:agreement:${JOB_ID}`,
    payment: `buyer:payment:${JOB_ID}`,
    paymentEvidence: `buyer:payment-evidence:${JOB_ID}`,
    buyerReceived: `buyer:received:${JOB_ID}`,
    audit: `buyer:audit:${JOB_ID}`,
  },
};

const AUTHORITY: DacsPayDemBuyerPaymentAuthorityV1 = {
  authorityVersion: "1",
  jobId: JOB_ID,
  phaseIndex: 2,
  railId: PROTOCOL.rail.railId,
  railVersion: PROTOCOL.rail.railVersion,
  railDescriptorHash: PROTOCOL.rail.railDefinitionHash,
  network: "demos",
  payer: PAYER,
  payee: PAYEE,
  amountOs: "1000000000",
  maxTotalDebitOs: "2000000000",
  agreementHash: "6".repeat(64),
  termsHash: "7".repeat(64),
  payoutBindingHash: "8".repeat(64),
};

const success: FixedPricePayDemTrackOperation = async ({ fence }) => {
  await fence.assertCurrent();
  return { status: "final", outcome: "success", reference: fence.track };
};

function recoveryPayment(): Readonly<DacsPayDemBuyerPaymentInputV1> {
  return Object.freeze({
    ...AUTHORITY,
    paymentInputVersion: "1" as const,
    orderBindingHash: "9".repeat(64),
    orderLocalBindingHash: "a".repeat(64),
    settlementKey: settlementKey(
      AUTHORITY.railId,
      AUTHORITY.jobId,
      AUTHORITY.phaseIndex,
    ),
  });
}

function recoveryReservation(
  payment = recoveryPayment(),
): WalletSpendReservationV1 {
  return {
    reservationVersion: "1",
    reservationId: `pay-dem:${payment.settlementKey}`,
    jobId: payment.jobId,
    phaseIndex: payment.phaseIndex,
    phase: "pay-dem",
    agreementHash: payment.agreementHash,
    settlementBindingHash: payment.orderLocalBindingHash,
    railId: payment.railId,
    railDefinitionHash: payment.railDescriptorHash,
    wallet: payment.payer,
    chainId: payment.network,
    payee: payment.payee,
    finality: { model: "bft-final" },
    debits: [
      {
        asset: "DEM",
        purpose: "service",
        expectedAmount: payment.amountOs,
        maximumAmount: payment.amountOs,
      },
      {
        asset: "DEM",
        purpose: "network-fee",
        expectedAmount: "0",
        maximumAmount: (
          BigInt(payment.maxTotalDebitOs) - BigInt(payment.amountOs)
        ).toString(),
      },
    ],
  };
}

function recoveryEffectId(payment = recoveryPayment()): string {
  return sha256Hex(canonicalize({
    localBindingHash: payment.orderLocalBindingHash,
    role: "buyer",
    track: "payment",
    roleLocalJob: `dacs-live:buyer:payment:${payment.jobId}`,
  }));
}

function recoveryEvidenceDatabase(
  payment: Readonly<DacsPayDemBuyerPaymentInputV1>,
  withPreparedCheckpoint: boolean,
): DacsNodeSqliteDatabase {
  const effectId = recoveryEffectId(payment);
  const checkpoint = {
    value: {
      txHash: TX_HASH,
      nonce: 7,
      payer: payment.payer,
      payee: payment.payee,
      amountOs: payment.amountOs,
      denomination: "os",
      network: payment.network,
      maxTotalDebitOs: payment.maxTotalDebitOs,
      confirmedTotalDebitOs: payment.maxTotalDebitOs,
      recovery: {
        railId: payment.railId,
        jobId: payment.jobId,
        phaseIndex: payment.phaseIndex,
        settlementKey: payment.settlementKey,
        network: payment.network,
        payer: payment.payer,
        payee: payment.payee,
        amountOs: payment.amountOs,
      },
    },
  };
  return {
    loadEffectInput: vi.fn((kind: string, candidateEffectId: string) =>
      kind === "payment" && candidateEffectId === effectId ? payment : undefined),
    loadEffectCheckpoint: vi.fn((
      kind: string,
      candidateEffectId: string,
      name: string,
    ) => kind === "payment" && candidateEffectId === effectId &&
        name === "pay-dem-prepared-transfer" && withPreparedCheckpoint
      ? checkpoint : undefined),
  } as unknown as DacsNodeSqliteDatabase;
}

function recoveryWalletAuthority(
  authenticateRecovery: ReturnType<
    typeof createDacsPayDemWalletSpendRecoveryAuthenticatorV1
  >,
  now: { value: number },
) {
  const ceiling = "999999999999999999999999";
  return createWalletSpendAuthorityV1({
    policyVersion: "1",
    policyId: "pay-dem-recovery-test",
    wallet: PAYER,
    chainId: "demos",
    maximumConcurrentEffects: 1,
    maximumRetainedReservations: 10,
    assets: [{
      asset: "DEM",
      maximumPerOrderDebit: ceiling,
      maximumNetworkFeeDebit: ceiling,
      minimumReserve: "0",
      rollingWindowMs: 86_400_000,
      maximumRollingEffects: 10,
      maximumRollingDebit: ceiling,
      maximumCumulativeDebit: ceiling,
      maximumCounterpartyDebit: ceiling,
    }],
  }, {
    store: createInMemoryWalletSpendStateStore(),
    readBalance: async () => ceiling,
    authenticateRecovery,
    now: () => now.value,
    owner: "pay-dem-wallet-recovery-test",
    leaseDurationMs: 100,
  });
}

function observeWalletEffectBegin(
  authority: Readonly<WalletSpendAuthorityV1>,
  events: string[],
): WalletSpendAuthorityV1 {
  return Object.freeze({
    policy: authority.policy,
    policyHash: authority.policyHash,
    async reserve(...args: Parameters<WalletSpendAuthorityV1["reserve"]>) {
      const claim = await authority.reserve(...args);
      if (claim.status !== "reserved") return claim;
      events.push("wallet-reserved");
      return Object.freeze({
        status: "reserved" as const,
        permit: Object.freeze({
          ...claim.permit,
          async beginEffect(): Promise<void> {
            events.push("wallet-effect-begun");
            await claim.permit.beginEffect();
          },
        }),
      });
    },
    reconcile: (...args: Parameters<WalletSpendAuthorityV1["reconcile"]>) =>
      authority.reconcile(...args),
    inspect: () => authority.inspect(),
  });
}

describe("native DEM buyer payment track", () => {
  const roots: string[] = [];
  const databases: DacsNodeSqliteDatabase[] = [];

  function root(): string {
    const value = mkdtempSync(join(tmpdir(), "dacs-node-pay-dem-"));
    roots.push(value);
    return value;
  }

  async function open(path: string): Promise<DacsNodeSqliteDatabase> {
    const database = await openDacsNodeSqliteDatabase({
      databasePath: path,
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      authority: BUYER,
    });
    databases.push(database);
    return database;
  }

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
    for (const directory of roots.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("commits the signed hash and rechecks its fence before broadcast", async () => {
    const database = await open(join(root(), "buyer.sqlite"));
    putDacsLiveOrderInputV1({ database, order: ORDER, application: {} });
    const events: string[] = [];
    const rail = markDacsSdkPreparedPayDemRailV1<PayDemRail>({
      address: PAYER,
      async settle(input, effectFence) {
        expect(input.maxTotalDebitOs).toBe(AUTHORITY.maxTotalDebitOs);
        const prepared = {
          txHash: TX_HASH,
          nonce: 7,
          payer: PAYER,
          payee: PAYEE,
          amountOs: AUTHORITY.amountOs,
          denomination: "os",
          network: "demos",
          maxTotalDebitOs: AUTHORITY.maxTotalDebitOs,
          recovery: input.recovery!,
        } as const;
        await input.journalPreparedTransfer!(prepared);
        events.push("journal-committed");
        await input.assertCurrentBeforeBroadcast!();
        await effectFence!.assertCurrent();
        events.push("broadcast");
        return {
          ok: true,
          txHash: TX_HASH,
          chainId: "demos",
          payer: PAYER,
          payee: PAYEE,
          finality: { model: "bft-final" },
          blockNumber: 42,
          txRefKind: "demos",
          networkFeeOs: "1000000000",
        };
      },
    });
    const walletSpendAuthority = observeWalletEffectBegin(
      createAccountingTestWalletSpendAuthorityV1({
        wallet: PAYER,
        chainId: "demos",
        asset: "DEM",
        maximumConcurrentEffects: 1,
      }),
      events,
    );
    const payment = createDacsPayDemBuyerPaymentTrackV1({
      walletSpendAuthority,
      database,
      workerId: "buyer-dem-worker",
      rail,
      resolveAuthority: () => AUTHORITY,
      reconcile: () => ({ status: "indeterminate", reasonCode: "not-required" }),
      publishNotice: ({ notice }) => {
        expect(notice).toMatchObject({
          paymentNoticeVersion: "1",
          payment: { jobId: JOB_ID, amountOs: AUTHORITY.amountOs },
          settlement: { txHash: TX_HASH, blockNumber: 42 },
        });
        events.push("notice-queued");
      },
    });
    const coordinator = createFixedPricePayDemBuyerCoordinator({
      store: database.createPayDemCoordinatorStore("buyer"),
      workerId: "buyer-coordinator",
      operations: {
        agreement: success,
        payment,
        "payment-evidence": success,
        "buyer-received": success,
        audit: success,
      },
    });
    await coordinator.startOrder(ORDER);
    await coordinator.runPending({ limit: 2 });

    expect(events).toEqual([
      "journal-committed",
      "wallet-reserved",
      "wallet-effect-begun",
      "broadcast",
      "notice-queued",
    ]);
    expect((await coordinator.getOrderStatus(JOB_ID))?.tracks.payment)
      .toMatchObject({ state: "final", outcome: "success" });
    expect(await walletSpendAuthority.inspect()).toMatchObject({
      activeEffects: 0,
      retainedReservations: 1,
      assets: [{ cumulativeSettledDebit: AUTHORITY.maxTotalDebitOs }],
    });
  });

  it.each([
    {
      name: "generated SDK rail leaves no wallet reservation when preparation fails",
      sdkDefaultRail: true,
      expectedRevision: 0,
      expectedActiveEffects: 0,
      expectedPreparationCalls: 2,
      expectedSecondState: "indeterminate",
    },
    {
      name: "custom rail retains wallet ambiguity when preparation fails",
      sdkDefaultRail: false,
      expectedRevision: 1,
      expectedActiveEffects: 1,
      expectedPreparationCalls: 1,
      expectedSecondState: "operator-action",
    },
  ])("$name", async ({
    sdkDefaultRail,
    expectedRevision,
    expectedActiveEffects,
    expectedPreparationCalls,
    expectedSecondState,
  }) => {
    const database = await open(join(root(), "buyer.sqlite"));
    const secondJobId = "01J8ME0SXKQ4T9V2RC5HJ6WX7E";
    const secondOrder: FixedPricePayDemOrderInput = {
      ...ORDER,
      jobId: secondJobId,
      sdkJobs: {
        role: "buyer",
        agreement: `buyer:agreement:${secondJobId}`,
        payment: `buyer:payment:${secondJobId}`,
        paymentEvidence: `buyer:payment-evidence:${secondJobId}`,
        buyerReceived: `buyer:received:${secondJobId}`,
        audit: `buyer:audit:${secondJobId}`,
      },
    };
    putDacsLiveOrderInputV1({ database, order: ORDER, application: {} });
    putDacsLiveOrderInputV1({ database, order: secondOrder, application: {} });
    const events: string[] = [];
    let broadcasts = 0;
    const prepareTransfer = vi.fn(async () => {
      throw new Error("signing failed before a transfer was prepared");
    });
    const publishNotice = vi.fn();
    const walletSpendAuthority = observeWalletEffectBegin(
      createAccountingTestWalletSpendAuthorityV1({
        wallet: PAYER,
        chainId: "demos",
        asset: "DEM",
        maximumConcurrentEffects: 1,
      }),
      events,
    );
    const rawRail: PayDemRail = {
      address: PAYER,
      async settle() {
        events.push("rail-preparation-started");
        await prepareTransfer();
        broadcasts += 1;
        return {
          ok: true,
          txHash: TX_HASH,
          chainId: "demos",
          payer: PAYER,
          payee: PAYEE,
          finality: { model: "bft-final" },
          blockNumber: 42,
          txRefKind: "demos",
          networkFeeOs: "1000000000",
        };
      },
    };
    const rail = sdkDefaultRail
      ? markDacsSdkPreparedPayDemRailV1(rawRail)
      : rawRail;
    const payment = createDacsPayDemBuyerPaymentTrackV1({
      walletSpendAuthority,
      database,
      workerId: "buyer-dem-preparation-failure",
      rail,
      // A caller-supplied lookalike cannot activate the private capability.
      ...(sdkDefaultRail ? {} : { deferWalletReservationUntilPrepared: true }),
      resolveAuthority: ({ operation }) => ({
        ...AUTHORITY,
        jobId: operation.order.jobId,
      }),
      reconcile: () => ({ status: "indeterminate", reasonCode: "not-required" }),
      publishNotice,
    });
    const coordinator = createFixedPricePayDemBuyerCoordinator({
      store: database.createPayDemCoordinatorStore("buyer"),
      workerId: "buyer-coordinator-preparation-failure",
      operations: { agreement: success, payment },
    });

    await coordinator.startOrder(ORDER);
    await coordinator.runPending({ limit: 2 });

    expect(events).toEqual(sdkDefaultRail
      ? ["rail-preparation-started"]
      : ["wallet-reserved", "rail-preparation-started"]);
    expect(prepareTransfer).toHaveBeenCalledOnce();
    expect(broadcasts).toBe(0);
    expect(publishNotice).not.toHaveBeenCalled();
    expect((await coordinator.getOrderStatus(JOB_ID))?.tracks.payment)
      .toMatchObject({ state: "indeterminate" });
    expect(await walletSpendAuthority.inspect()).toMatchObject({
      revision: expectedRevision,
      activeEffects: expectedActiveEffects,
      assets: [{ cumulativeSettledDebit: "0" }],
    });
    await coordinator.startOrder(secondOrder);
    await coordinator.runPending({ limit: 2 });

    expect(prepareTransfer).toHaveBeenCalledTimes(expectedPreparationCalls);
    expect(broadcasts).toBe(0);
    expect((await coordinator.getOrderStatus(secondJobId))?.tracks.payment)
      .toMatchObject({ state: expectedSecondState });
  });

  it("rejects custom rail success that never invokes the pre-broadcast fence", async () => {
    const database = await open(join(root(), "buyer.sqlite"));
    putDacsLiveOrderInputV1({ database, order: ORDER, application: {} });
    const events: string[] = [];
    const publishNotice = vi.fn();
    const walletSpendAuthority = observeWalletEffectBegin(
      createAccountingTestWalletSpendAuthorityV1({
        wallet: PAYER,
        chainId: "demos",
        asset: "DEM",
      }),
      events,
    );
    const payment = createDacsPayDemBuyerPaymentTrackV1({
      walletSpendAuthority,
      database,
      workerId: "buyer-dem-missing-pre-broadcast-fence",
      rail: {
        address: PAYER,
        async settle() {
          return {
            ok: true,
            txHash: TX_HASH,
            chainId: "demos",
            payer: PAYER,
            payee: PAYEE,
            finality: { model: "bft-final" },
            blockNumber: 42,
            txRefKind: "demos",
            networkFeeOs: "1000000000",
          };
        },
      },
      resolveAuthority: () => AUTHORITY,
      reconcile: () => ({ status: "indeterminate", reasonCode: "not-required" }),
      publishNotice,
    });
    const coordinator = createFixedPricePayDemBuyerCoordinator({
      store: database.createPayDemCoordinatorStore("buyer"),
      workerId: "buyer-coordinator-missing-pre-broadcast-fence",
      operations: { agreement: success, payment },
    });

    await coordinator.startOrder(ORDER);
    await coordinator.runPending({ limit: 2 });

    expect(events).toEqual(["wallet-reserved"]);
    expect(publishNotice).not.toHaveBeenCalled();
    expect((await coordinator.getOrderStatus(JOB_ID))?.tracks.payment)
      .toMatchObject({ state: "indeterminate" });
    expect(await walletSpendAuthority.inspect()).toMatchObject({
      revision: 1,
      assets: [{ cumulativeSettledDebit: "0" }],
    });
  });

  it("reconciles after notice queue failure without settling again", async () => {
    const databasePath = join(root(), "buyer.sqlite");
    const first = await open(databasePath);
    putDacsLiveOrderInputV1({ database: first, order: ORDER, application: {} });
    const firstRail: PayDemRail = {
      address: PAYER,
      async settle(input) {
        await input.journalPreparedTransfer!({
          txHash: TX_HASH,
          nonce: 9,
          payer: PAYER,
          payee: PAYEE,
          amountOs: AUTHORITY.amountOs,
          network: "demos",
          maxTotalDebitOs: AUTHORITY.maxTotalDebitOs,
          recovery: input.recovery!,
        });
        await input.assertCurrentBeforeBroadcast!();
        return {
          ok: true,
          txHash: TX_HASH,
          chainId: "demos",
          payer: PAYER,
          payee: PAYEE,
          finality: { model: "bft-final" },
          blockNumber: 43,
          txRefKind: "demos",
          networkFeeOs: "1000000000",
        };
      },
    };
    const firstPayment = createDacsPayDemBuyerPaymentTrackV1({
      walletSpendAuthority: createPermissiveTestWalletSpendAuthorityV1(),
      database: first,
      workerId: "buyer-dem-before-restart",
      rail: firstRail,
      resolveAuthority: () => AUTHORITY,
      reconcile: () => ({ status: "indeterminate", reasonCode: "not-yet" }),
      publishNotice: async () => {
        throw new Error("notice queue unavailable");
      },
      retryDelayMs: 1,
    });
    const initial = createFixedPricePayDemBuyerCoordinator({
      store: first.createPayDemCoordinatorStore("buyer"),
      workerId: "buyer-coordinator-before-restart",
      operations: { agreement: success, payment: firstPayment },
    });
    await initial.startOrder(ORDER);
    await initial.runPending({ limit: 2 });
    expect((await initial.getOrderStatus(JOB_ID))?.tracks.payment?.state)
      .toBe("indeterminate");
    first.checkpoint();
    first.close();
    databases.splice(databases.indexOf(first), 1);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const restarted = await open(databasePath);
    const settle: PayDemRail["settle"] = vi.fn(async () => {
      throw new Error("settle must not run during reconciliation");
    });
    const reconcile = vi.fn(async ({ prepared }) => ({
      status: "completed" as const,
      settlement: {
        ok: true,
        txHash: prepared!.txHash,
        chainId: "demos",
        payer: PAYER,
        payee: PAYEE,
        finality: { model: "bft-final" as const },
        blockNumber: 43,
        txRefKind: "demos" as const,
        amountOs: AUTHORITY.amountOs,
        networkFeeOs: "1000000000",
      },
    }));
    const publishNotice = vi.fn();
    const resumedPayment = createDacsPayDemBuyerPaymentTrackV1({
      walletSpendAuthority: createPermissiveTestWalletSpendAuthorityV1(),
      database: restarted,
      workerId: "buyer-dem-after-restart",
      rail: { address: PAYER, settle },
      resolveAuthority: () => AUTHORITY,
      reconcile,
      publishNotice,
      retryDelayMs: 1,
    });
    const resumed = createFixedPricePayDemBuyerCoordinator({
      store: restarted.createPayDemCoordinatorStore("buyer"),
      workerId: "buyer-coordinator-after-restart",
      operations: { payment: resumedPayment },
    });
    await resumed.runPending({ limit: 1 });

    expect(settle).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      prepared: expect.objectContaining({
        txHash: TX_HASH,
        nonce: 9,
      }),
    }));
    expect(vi.mocked(reconcile).mock.calls[0]?.[0].prepared)
      .not.toHaveProperty("denomination");
    expect(publishNotice).toHaveBeenCalledWith(expect.objectContaining({
      notice: expect.objectContaining({ settlement: {
        ok: true,
        txHash: TX_HASH,
        chainId: "demos",
        payer: PAYER,
        payee: PAYEE,
        finality: { model: "bft-final" },
        blockNumber: 43,
        txRefKind: "demos",
      } }),
    }));
    expect(vi.mocked(publishNotice).mock.calls[0]?.[0].notice.settlement)
      .not.toHaveProperty("networkFeeOs");
    expect((await resumed.getOrderStatus(JOB_ID))?.tracks.payment)
      .toMatchObject({ state: "final", outcome: "success" });
  });

  it("holds wallet budget when an older actor checkpoint is restored after transfer", async () => {
    const directory = root();
    const databasePath = join(directory, "buyer.sqlite");
    const first = await open(databasePath);
    putDacsLiveOrderInputV1({ database: first, order: ORDER, application: {} });
    let actorDatabase = first;
    const recoveryDatabase = {
      loadEffectInput(...args: Parameters<DacsNodeSqliteDatabase["loadEffectInput"]>) {
        return actorDatabase.loadEffectInput(...args);
      },
      loadEffectCheckpoint(
        ...args: Parameters<DacsNodeSqliteDatabase["loadEffectCheckpoint"]>
      ) {
        return actorDatabase.loadEffectCheckpoint(...args);
      },
    } as unknown as DacsNodeSqliteDatabase;
    const observeDemosTransfer = vi.fn(async () => ({
      status: "included" as const,
      txHash: TX_HASH,
      payer: PAYER,
      payee: PAYEE,
      amountOs: AUTHORITY.amountOs,
      blockNumber: 44,
      includedAt: 1_780_000_000_000,
    }));
    const authenticateRecovery =
      createDacsPayDemWalletSpendRecoveryAuthenticatorV1({
        database: recoveryDatabase,
        observeDemosTransfer,
      });
    const walletNow = { value: 1_000 };
    const walletSpendAuthority = recoveryWalletAuthority(authenticateRecovery, walletNow);
    let transfers = 0;
    const firstPayment = createDacsPayDemBuyerPaymentTrackV1({
      walletSpendAuthority,
      database: first,
      workerId: "buyer-before-actor-restore",
      rail: {
        address: PAYER,
        async settle(input) {
          await input.journalPreparedTransfer!({
            txHash: TX_HASH,
            nonce: 11,
            payer: PAYER,
            payee: PAYEE,
            amountOs: AUTHORITY.amountOs,
            network: "demos",
            maxTotalDebitOs: AUTHORITY.maxTotalDebitOs,
            confirmedTotalDebitOs: AUTHORITY.maxTotalDebitOs,
            recovery: input.recovery!,
          });
          await input.assertCurrentBeforeBroadcast!();
          transfers += 1;
          throw new Error("transfer completed but response was lost");
        },
      },
      resolveAuthority: () => AUTHORITY,
      reconcile: createDacsFixedPricePayDemBuyerReconciliationV1(
        observeDemosTransfer,
      ),
      publishNotice: vi.fn(),
      effectLeaseDurationMs: 500,
      retryDelayMs: 1,
    });
    const initial = createFixedPricePayDemBuyerCoordinator({
      store: first.createPayDemCoordinatorStore("buyer"),
      workerId: "buyer-coordinator-before-actor-restore",
      operations: { agreement: success, payment: firstPayment },
    });
    await initial.startOrder(ORDER);
    await initial.runPending({ limit: 2 });
    expect(transfers).toBe(1);
    expect((await initial.getOrderStatus(JOB_ID))?.tracks.payment?.state)
      .toBe("indeterminate");
    Object.defineProperty(first, "loadEffectCheckpoint", {
      configurable: true,
      value: () => undefined,
    });

    await new Promise((resolve) => setTimeout(resolve, 510));
    actorDatabase = first;
    walletNow.value = 1_101;
    const settle = vi.fn(async () => {
      throw new Error("restored actor must not rebroadcast");
    });
    const resumedPayment = createDacsPayDemBuyerPaymentTrackV1({
      walletSpendAuthority,
      database: first,
      workerId: "buyer-after-actor-restore",
      rail: { address: PAYER, settle },
      resolveAuthority: () => AUTHORITY,
      reconcile: createDacsFixedPricePayDemBuyerReconciliationV1(
        observeDemosTransfer,
      ),
      publishNotice: vi.fn(),
      effectLeaseDurationMs: 500,
      retryDelayMs: 1,
    });
    const resumed = createFixedPricePayDemBuyerCoordinator({
      store: first.createPayDemCoordinatorStore("buyer"),
      workerId: "buyer-coordinator-after-actor-restore",
      operations: { payment: resumedPayment },
    });
    await resumed.runPending({ limit: 1 });

    expect(settle).not.toHaveBeenCalled();
    expect(observeDemosTransfer).not.toHaveBeenCalled();
    expect((await resumed.getOrderStatus(JOB_ID))?.tracks.payment).toMatchObject({
      state: "operator-action",
    });
    expect(await walletSpendAuthority.inspect()).toMatchObject({
      activeEffects: 1,
      assets: [{ reservedWorstCaseDebit: AUTHORITY.maxTotalDebitOs }],
    });
  });

  it("authenticates the complete DEM service and confirmed fee debit", async () => {
    const payment = recoveryPayment();
    const reservation = recoveryReservation(payment);
    const database = recoveryEvidenceDatabase(payment, true);
    let chain: DemosTransferObservation = {
      status: "unavailable",
      reason: "temporary RPC failure",
    };
    const authenticateRecovery =
      createDacsPayDemWalletSpendRecoveryAuthenticatorV1({
        database,
        observeDemosTransfer: async () => chain,
      });
    const now = { value: 1_000 };
    const wallet = recoveryWalletAuthority(authenticateRecovery, now);
    const claim = await wallet.reserve(reservation);
    expect(claim.status).toBe("reserved");
    if (claim.status !== "reserved") throw new Error("expected wallet permit");
    await claim.permit.beginEffect();
    const exact = {
      disposition: "settled" as const,
      evidenceHash: TX_HASH,
      debits: [
        { asset: "DEM", purpose: "service" as const, amount: payment.amountOs },
        { asset: "DEM", purpose: "network-fee" as const,
          amount: (BigInt(payment.maxTotalDebitOs) - BigInt(payment.amountOs)).toString() },
      ],
    };

    await expect(claim.permit.settle(exact)).rejects.toThrow(/authentication failed/);
    expect((await wallet.inspect()).activeEffects).toBe(1);

    chain = {
      status: "included",
      txHash: TX_HASH,
      payer: PAYER,
      payee: PAYEE,
      amountOs: payment.amountOs,
      blockNumber: 42,
      includedAt: 1_780_000_000_000,
    };
    await expect(claim.permit.settle({
      ...exact,
      debits: [exact.debits[0]!, { ...exact.debits[1]!, amount: "0" }],
    })).rejects.toThrow(/authentication failed/);
    expect((await wallet.inspect()).activeEffects).toBe(1);

    await expect(claim.permit.settle(exact)).resolves.toBeUndefined();
    expect(await wallet.inspect()).toMatchObject({
      activeEffects: 0,
      assets: [{ cumulativeSettledDebit: payment.maxTotalDebitOs }],
    });
  });

  it("captures DEM recovery capabilities once with their original receivers", async () => {
    const payment = recoveryPayment();
    const retained = recoveryEvidenceDatabase(payment, true);
    const database = {
      loadEffectInput(...args: Parameters<DacsNodeSqliteDatabase["loadEffectInput"]>) {
        expect(this).toBe(database);
        return retained.loadEffectInput(...args);
      },
      loadEffectCheckpoint(
        ...args: Parameters<DacsNodeSqliteDatabase["loadEffectCheckpoint"]>
      ) {
        expect(this).toBe(database);
        return retained.loadEffectCheckpoint(...args);
      },
    } as unknown as DacsNodeSqliteDatabase;
    const chain: DemosTransferObservation = {
      status: "included",
      txHash: TX_HASH,
      payer: PAYER,
      payee: PAYEE,
      amountOs: payment.amountOs,
      blockNumber: 42,
      includedAt: 1_780_000_000_000,
    };
    const options = {
      database,
      async observeDemosTransfer() {
        expect(this).toBe(options);
        return chain;
      },
    };
    const metadataGetter = vi.fn(() => "swapped");
    Object.defineProperty(options.observeDemosTransfer, "name", {
      configurable: true,
      get: metadataGetter,
    });
    const authenticateRecovery =
      createDacsPayDemWalletSpendRecoveryAuthenticatorV1(options);
    expect(Object.isFrozen(authenticateRecovery)).toBe(true);
    expect(metadataGetter).not.toHaveBeenCalled();
    Object.assign(database, {
      loadEffectInput: vi.fn(() => undefined),
      loadEffectCheckpoint: vi.fn(() => undefined),
    });
    Object.assign(options, {
      observeDemosTransfer: vi.fn(async () => ({
        status: "unavailable" as const,
        reason: "swapped",
      })),
    });
    const exact = {
      disposition: "settled" as const,
      evidenceHash: TX_HASH,
      debits: [
        { asset: "DEM", purpose: "service" as const, amount: payment.amountOs },
        { asset: "DEM", purpose: "network-fee" as const,
          amount: (BigInt(payment.maxTotalDebitOs) - BigInt(payment.amountOs)).toString() },
      ],
    };

    await expect(authenticateRecovery(recoveryReservation(payment), exact))
      .resolves.toBe(true);
    expect(metadataGetter).not.toHaveBeenCalled();
  });

  it("rejects DEM recovery option accessors and proxies without invoking them", () => {
    const getter = vi.fn(() => recoveryEvidenceDatabase(recoveryPayment(), true));
    const accessorOptions = {
      observeDemosTransfer: vi.fn(),
    } as Record<string, unknown>;
    Object.defineProperty(accessorOptions, "database", {
      enumerable: true,
      get: getter,
    });
    expect(() => createDacsPayDemWalletSpendRecoveryAuthenticatorV1(
      accessorOptions as unknown as Parameters<
        typeof createDacsPayDemWalletSpendRecoveryAuthenticatorV1
      >[0],
    )).toThrow(/options are invalid/);
    expect(getter).not.toHaveBeenCalled();
    expect(() => createDacsPayDemWalletSpendRecoveryAuthenticatorV1(
      new Proxy(accessorOptions, {}) as unknown as Parameters<
        typeof createDacsPayDemWalletSpendRecoveryAuthenticatorV1
      >[0],
    )).toThrow(/options are invalid/);
  });

  it("retains wallet budget after an actor restore omits the prepared checkpoint", async () => {
    const payment = recoveryPayment();
    const reservation = recoveryReservation(payment);
    const current = recoveryEvidenceDatabase(payment, true);
    const restored = recoveryEvidenceDatabase(payment, false);
    let actorDatabase = current;
    const database = {
      loadEffectInput(...args: Parameters<DacsNodeSqliteDatabase["loadEffectInput"]>) {
        return actorDatabase.loadEffectInput(...args);
      },
      loadEffectCheckpoint(
        ...args: Parameters<DacsNodeSqliteDatabase["loadEffectCheckpoint"]>
      ) {
        return actorDatabase.loadEffectCheckpoint(...args);
      },
    } as unknown as DacsNodeSqliteDatabase;
    const observeDemosTransfer = vi.fn(async () => ({
      status: "included" as const,
      txHash: TX_HASH,
      payer: PAYER,
      payee: PAYEE,
      amountOs: payment.amountOs,
      blockNumber: 42,
      includedAt: 1_780_000_000_000,
    }));
    const authenticateRecovery =
      createDacsPayDemWalletSpendRecoveryAuthenticatorV1({
        database,
        observeDemosTransfer,
      });
    const now = { value: 1_000 };
    const wallet = recoveryWalletAuthority(authenticateRecovery, now);
    const claim = await wallet.reserve(reservation);
    if (claim.status !== "reserved") throw new Error("expected wallet permit");
    await claim.permit.beginEffect();

    // The actor database is restored to an older authenticated backup while
    // the independent wallet authority retains the ambiguous effect.
    actorDatabase = restored;
    now.value = 1_101;

    await expect(wallet.reconcile(reservation, {
      disposition: "terminal-absent",
      evidenceHash: "f".repeat(64),
    })).rejects.toThrow(/authentication failed/);

    const absenceProofHash = sha256Hex(canonicalize({
      disposition: "no-prepared-transfer",
      settlementKey: payment.settlementKey,
      orderLocalBindingHash: payment.orderLocalBindingHash,
    }));
    await expect(wallet.reconcile(reservation, {
      disposition: "terminal-absent",
      evidenceHash: absenceProofHash,
    })).rejects.toThrow(/authentication failed/);
    expect(observeDemosTransfer).not.toHaveBeenCalled();
    expect(await wallet.inspect()).toMatchObject({
      activeEffects: 1,
      assets: [{ reservedWorstCaseDebit: payment.maxTotalDebitOs }],
    });
    await expect(wallet.reserve(reservation)).resolves.toMatchObject({
      status: "held",
      stage: "effect-pending",
    });
  });
});
