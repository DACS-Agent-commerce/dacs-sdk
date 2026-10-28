import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createInMemoryWalletSpendStateStore,
  createPayDemRail,
  createWalletSpendAuthorityV1,
  payDemSettleCore,
  settlementKey,
  type DemosNativeClient,
  type DemosTransferObservation,
  type PayDemRail,
  type PayDemSettlementRecoveryContext,
  type WalletSpendAuthorityV1,
  type WalletSpendReservationV1,
} from "@kynesyslabs/dacs";
import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import { demosAgentClaimRef } from "@kynesyslabs/dacs/identity";
import type {
  DemosWriteJournal,
  DemosWriteJournalLease,
  DemosWriteJournalRecord,
} from "@kynesyslabs/dacs/substrate";
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
  createDacsDemosActorRuntimeV1,
  type DacsDemosAdapterV1,
} from "../src/demosRuntime.js";
import { loadDacsSecretV1 } from "../src/secrets.js";
import {
  createDacsFixedPricePayDemBuyerReconciliationV1,
} from "../src/fixedPricePayDemBuyerPayment.js";
import {
  createDacsPayDemBuyerPaymentTrackV1,
  createDacsPayDemWalletSpendRecoveryAuthenticatorV1,
  type DacsPayDemBuyerPaymentAuthorityV1,
  type DacsPayDemBuyerPaymentInputV1,
  type DacsPayDemBuyerPaymentTrackOptionsV1,
} from "../src/payDemPayment.js";
import { putDacsLiveOrderInputV1 } from "../src/orderInput.js";
import {
  markDacsRecordVerifyingPayDemRailV1,
  markDacsSdkPreparedPayDemRailV1,
} from "../src/payDemRailCapabilities.js";
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
const PAYER_PUBLIC_KEY = Uint8Array.from({ length: 32 }, () => 0x11);

const demosSdk = vi.hoisted(() => ({
  broadcast: vi.fn(),
  confirm: vi.fn(),
  connect: vi.fn(),
  connectWallet: vi.fn(),
  getNetworkInfo: vi.fn(),
  getTxByHash: vi.fn(),
  nodeCall: vi.fn(),
  transfer: vi.fn(),
  waitForNonce: vi.fn(),
}));

vi.mock("@kynesyslabs/demosdk/websdk", () => ({
  Demos: class MockDemos {
    readonly tx = { confirm: demosSdk.confirm };
    readonly broadcast = demosSdk.broadcast;
    readonly connect = demosSdk.connect;
    readonly connectWallet = demosSdk.connectWallet;
    readonly getNetworkInfo = demosSdk.getNetworkInfo;
    readonly getTxByHash = demosSdk.getTxByHash;
    readonly nodeCall = demosSdk.nodeCall;
    readonly transfer = demosSdk.transfer;
    readonly waitForNonce = demosSdk.waitForNonce;

    getAddress(): string {
      return `0x${"1".repeat(64)}`;
    }
  },
}));

// The mocked node signs TX_HASH at nonce 7, confirms a 1 DEM fee, includes the
// transaction at block 42 and records the broadcast transfer as `confirmed`.
// The payer's account nonce before any transfer is 6.
beforeEach(() => {
  for (const method of Object.values(demosSdk)) method.mockReset();
  demosSdk.connect.mockResolvedValue(undefined);
  demosSdk.connectWallet.mockResolvedValue(undefined);
  demosSdk.getNetworkInfo.mockResolvedValue({
    forks: { osDenomination: { activated: true } },
  });
  demosSdk.transfer.mockImplementation(async (to: string, amountOs: bigint) => ({
    hash: TX_HASH,
    content: {
      type: "native",
      from: `0x${PAYER}`,
      to,
      amount: amountOs.toString(),
      nonce: 7,
      data: ["native", { nativeOperation: "send", args: [to, amountOs.toString()] }],
    },
  }));
  demosSdk.confirm.mockImplementation(async (signed: {
    hash: string;
    content: Record<string, unknown>;
  }) => ({
    response: {
      data: {
        transaction: {
          hash: signed.hash,
          content: {
            ...signed.content,
            transaction_fee: {
              network_fee: "400000000",
              rpc_fee: "500000000",
              additional_fee: "100000000",
            },
          },
        },
      },
    },
  }));
  demosSdk.broadcast.mockResolvedValue({ result: 200, response: { hash: TX_HASH } });
  demosSdk.nodeCall.mockImplementation(async (message: string) =>
    message === "getAddressNonce" ? 6 : { state: "included", blockNumber: 42 });
  demosSdk.getTxByHash.mockImplementation(async () => {
    const validity = demosSdk.broadcast.mock.calls.at(-1)?.[0] as {
      response: { data: { transaction: { content: Record<string, unknown> } } };
    };
    const transaction = validity.response.data.transaction;
    return {
      ...transaction,
      content: {
        ...transaction.content,
        nonce: String(transaction.content.nonce),
      },
      status: "confirmed",
      blockNumber: 42,
    };
  });
  demosSdk.waitForNonce.mockResolvedValue(undefined);
});

/**
 * The SDK's own rail over the mocked node: the only rail whose success the
 * buyer track settles, because it reads and binds the executed record (#338).
 */
const sdkPayDemRail = () => createPayDemRail({
  rpc: "https://node.test",
  secret: "test-only-secret",
  inclusionPollIntervalMs: 1,
  statusRequestTimeoutMs: 50,
  transactionRecordTimeoutMs: 200,
});
/**
 * The SDK's own rail over the mocked node, signing `txHash` at `nonce`.
 * `onSign` runs as demosdk signs, before the journal, the fence and the
 * broadcast; `onBroadcast` replaces the node's answer to the one broadcast.
 */
const sdkPayDemRailSigning = (
  txHash: string,
  nonce: number,
  hooks: {
    onSign?: () => Promise<void>;
    onBroadcast?: () => Promise<unknown>;
  } = {},
): Promise<PayDemRail> => {
  demosSdk.transfer.mockImplementation(async (to: string, amountOs: bigint) => {
    await hooks.onSign?.();
    return {
      hash: txHash,
      content: {
        type: "native",
        from: `0x${PAYER}`,
        to,
        amount: amountOs.toString(),
        nonce,
        data: ["native", { nativeOperation: "send", args: [to, amountOs.toString()] }],
      },
    };
  });
  demosSdk.broadcast.mockImplementation(hooks.onBroadcast ??
    (async () => ({ result: 200, response: { hash: txHash } })));
  return sdkPayDemRail();
};
const PAYER_AUTHORITY = demosAgentClaimRef(PAYER_PUBLIC_KEY);

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

/**
 * The retained effect state of this payment, with no SQLite file: the live
 * track claims it in `mode`, reads the retained input and prepared checkpoint,
 * and `writes` lists what it recorded. Without `checkpoints`, a reconcile
 * reads the fixture checkpoint; with them, the ones an earlier attempt wrote.
 */
function retainedEffectDatabase(
  mode: "fresh" | "reconcile",
  checkpoints?: Map<string, unknown>,
) {
  const payment = recoveryPayment();
  const evidence = recoveryEvidenceDatabase(
    payment,
    mode === "reconcile" && checkpoints === undefined,
  );
  const writes: string[] = [];
  const database = {
    metadata: { mode: "live-demos", role: "buyer" },
    readTime: () => 1_000,
    loadEffectInput: evidence.loadEffectInput,
    loadEffectCheckpoint: (
      ...args: Parameters<DacsNodeSqliteDatabase["loadEffectCheckpoint"]>
    ) => checkpoints?.has(args[2]) === true
      ? { value: checkpoints.get(args[2]) }
      : evidence.loadEffectCheckpoint(...args),
    recordEffectCheckpoint: (write: { name: string; value: unknown }) => {
      writes.push(`checkpoint:${write.name}`);
      checkpoints?.set(write.name, write.value);
      return { status: "recorded" };
    },
    putEffectIntent: () => ({ status: "existing" }),
    claimEffect: () => ({
      status: "acquired",
      mode,
      lease: { owner: "buyer-dem-retained", generation: 2, mode, expiresAt: 2_000 },
    }),
    isCurrentEffect: () => true,
    recordEffectReconciliation: (write: { result: { disposition: string } }) => {
      writes.push(`reconciliation:${write.result.disposition}`);
      return { status: "recorded" };
    },
    requireEffectOperatorAction: (write: { reasonCode: string }) => {
      writes.push(`operator-action:${write.reasonCode}`);
    },
    recordEffectAmbiguous: (write: { reasonCode: string }) => {
      writes.push(`ambiguous:${write.reasonCode}`);
    },
    recordEffectCompleted: () => {
      writes.push("completed");
      return { status: "recorded" };
    },
  } as unknown as DacsNodeSqliteDatabase;
  const operation = {
    fence: {
      role: "buyer",
      track: "payment",
      jobId: JOB_ID,
      idempotencyKey: recoveryEffectId(payment),
      localBindingHash: payment.orderLocalBindingHash,
      assertCurrent: async () => undefined,
    },
    order: { role: "buyer", jobId: JOB_ID },
  } as unknown as Parameters<FixedPricePayDemTrackOperation>[0];
  return { database, operation, writes };
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

function payDemRuntimeConfig(directory: string) {
  return {
    mode: "live-demos" as const,
    profile: DACS_NODE_LIVE_PROFILE,
    role: "buyer" as const,
    dataDirectory: directory,
    demos: { rpcUrl: "http://127.0.0.1:5350" },
    rail: {
      registryIndexRef: "dacs4:registry:v0.1",
      requestedNetwork: "demos",
      enabledProfiles: ["pay-dem"] as const,
    },
    limits: {
      maxServiceAmount: { asset: "DEM", amount: "1" },
      maxSetupSpendDem: "10",
      maxDemosNetworkFeeDem: "2",
      maxEvmNetworkFeeEth: "0",
    },
  };
}

function generatedDemosAdapter(
  wallet: string,
  overrides: Partial<DacsDemosAdapterV1> = {},
): DacsDemosAdapterV1 {
  return {
    raw: {
      getNetworkInfo: vi.fn(async () => ({ chain: "test" })),
      getAddressNonce: vi.fn(async () => 7),
      getAddressInfo: vi.fn(async () => ({ balance: "10" })),
    },
    connect: vi.fn(async () => undefined),
    getChainIdentity: vi.fn(async () => "pay-dem-composition-chain"),
    getAddress: vi.fn(() => wallet),
    getPublicKey: vi.fn(async () => Uint8Array.from(PAYER_PUBLIC_KEY)),
    sign: vi.fn(async () => new Uint8Array(64).fill(7)),
    resolveIdentity: vi.fn(async (ref) => ({
      ref,
      boundTo: ref,
      raw: { identity: "authenticated-test-fixture" },
    })),
    readAnchor: vi.fn(async () => null),
    resolveAnchorByName: vi.fn(async () => ({ status: "absent" as const })),
    scanOwnAnchorsByNamePrefix: vi.fn(async () => ({
      status: "ok" as const,
      anchors: [],
    })),
    anchorWriteOnce: vi.fn(async () => ({ address: "stor:test" })),
    verifyDemosAnchorReceipt: vi.fn(async () => true),
    resolveDemosAnchorReceipt: vi.fn(async () => null),
    reconcileWalletJournal: vi.fn(async () => undefined),
    reconcileNativeTransferJournal: vi.fn(async () => undefined),
    ...overrides,
  };
}

function instrumentJournal(
  journal: DemosWriteJournal,
  events: string[],
): void {
  const acquire = journal.acquire.bind(journal);
  Object.defineProperty(journal, "acquire", {
    configurable: true,
    value: async (...args: Parameters<DemosWriteJournal["acquire"]>) => {
      const lease = await acquire(...args);
      return {
        key: lease.key,
        generation: lease.generation,
        get snapshot() {
          return lease.snapshot;
        },
        async put(record: DemosWriteJournalRecord) {
          if (record.stage === "prepared") events.push("demos-prepared");
          if (record.stage === "broadcast-intent") events.push("broadcast-intent");
          if (record.stage === "canonical-confirmed") events.push("canonical-confirmed");
          await lease.put(record);
        },
        async assertCurrent() {
          events.push("demos-authority-guard");
          await lease.assertCurrent();
        },
        release: () => lease.release(),
      } satisfies DemosWriteJournalLease;
    },
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

  async function composedGeneratedRail(
    directory: string,
    innerRail: Readonly<PayDemRail>,
    events: string[],
  ): Promise<Readonly<{
    rail: Readonly<PayDemRail>;
    journal: DemosWriteJournal;
  }>> {
    const secretPath = join(directory, "demos.secret");
    writeFileSync(secretPath, "test-only-secret\n", { mode: 0o600 });
    const secret = await loadDacsSecretV1({
      name: "buyer-demos-identity",
      mode: "live-demos",
      filePath: secretPath,
    });
    let journal!: DemosWriteJournal;
    const adapter = generatedDemosAdapter(PAYER, {
      async reconcileWalletJournal(lease) {
        const intent = lease.snapshot.records.find((record) =>
          record.kind === "native-transfer" && record.stage === "broadcast-intent");
        if (intent === undefined) return;
        await lease.put({
          ...intent,
          stage: "canonical-confirmed",
          blockNumber: 42,
          blockHash: "a".repeat(64),
          blockTimestamp: 1_780_000_000_000,
          finalityProof: "test-only-finality-proof",
          finalityProofHash: "b".repeat(64),
          updatedAt: Date.now(),
        });
      },
    });
    const runtime = await createDacsDemosActorRuntimeV1({
      config: payDemRuntimeConfig(directory),
      role: "buyer",
      authority: PAYER_AUTHORITY,
      demosIdentity: secret,
      createAdapter: async (input) => {
        journal = input.writeJournal;
        instrumentJournal(journal, events);
        return adapter;
      },
      createPayDemRail: async () => innerRail,
    });
    if (runtime.payDem === undefined) throw new Error("expected native DEM rail");
    // T1 independently proves the default factory marks this exact frozen
    // wrapper. Marking here composes that capability with a deterministic
    // inner-rail fixture without replacing the real wrapper or journal.
    return Object.freeze({
      rail: markDacsSdkPreparedPayDemRailV1(runtime.payDem.rail),
      journal,
    });
  }

  function instrumentPaymentDatabase(
    database: DacsNodeSqliteDatabase,
    events: string[],
    staleAfterBroadcastIntent = false,
  ): void {
    const recordEffectCheckpoint = database.recordEffectCheckpoint.bind(database);
    Object.defineProperty(database, "recordEffectCheckpoint", {
      configurable: true,
      value: (...args: Parameters<DacsNodeSqliteDatabase["recordEffectCheckpoint"]>) => {
        const result = recordEffectCheckpoint(...args);
        if (args[0].name === "pay-dem-prepared-transfer") events.push("checkpoint");
        return result;
      },
    });
    const isCurrentEffect = database.isCurrentEffect.bind(database);
    Object.defineProperty(database, "isCurrentEffect", {
      configurable: true,
      value: (...args: Parameters<DacsNodeSqliteDatabase["isCurrentEffect"]>) => {
        if (staleAfterBroadcastIntent && events.includes("broadcast-intent")) {
          return false;
        }
        const result = isCurrentEffect(...args);
        if (events.at(-1) === "wallet-effect-begun") {
          events.push("outer-authority-guard");
        }
        return result;
      },
    });
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
    const sdkRail = await sdkPayDemRail();
    demosSdk.broadcast.mockImplementation(async () => {
      events.push("broadcast");
      return { result: 200, response: { hash: TX_HASH } };
    });
    // Observes the SDK rail's seams and relays its own result object unchanged.
    const rail = markDacsSdkPreparedPayDemRailV1<PayDemRail>({
      address: PAYER,
      async settle(input, effectFence) {
        expect(input.maxTotalDebitOs).toBe(AUTHORITY.maxTotalDebitOs);
        return sdkRail.settle({
          ...input,
          journalPreparedTransfer: async (prepared) => {
            await input.journalPreparedTransfer!(prepared);
            events.push("journal-committed");
          },
        }, effectFence);
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

  // #338: the buyer track settles the wallet and publishes the notice only for
  // the SDK rail's own success, read from the node record for this payment's
  // exact transfer and the hash this invocation journaled.
  const PREPARED = (recovery: PayDemSettlementRecoveryContext, txHash = TX_HASH) => ({
    txHash,
    nonce: 7,
    payer: PAYER,
    payee: PAYEE,
    amountOs: AUTHORITY.amountOs,
    denomination: "os" as const,
    network: "demos",
    maxTotalDebitOs: AUTHORITY.maxTotalDebitOs,
    confirmedTotalDebitOs: AUTHORITY.maxTotalDebitOs,
    recovery,
  });
  it.each([
    ["an injected rail's executed statement with no record read", (
      _sdkRail: PayDemRail,
    ): PayDemRail["settle"] => async (input) => {
      await input.journalPreparedTransfer!(PREPARED(input.recovery!));
      await input.assertCurrentBeforeBroadcast!();
      return {
        ok: true,
        execution: "executed",
        txHash: TX_HASH,
        chainId: "demos",
        payer: PAYER,
        payee: PAYEE,
        finality: { model: "bft-final" },
        blockNumber: 42,
        txRefKind: "demos",
        networkFeeOs: "1000000000",
      };
    }],
    ["a copy of the SDK rail's genuine success", (
      sdkRail: PayDemRail,
    ): PayDemRail["settle"] => async (input, effectFence) => ({
      ...await sdkRail.settle(input, effectFence),
    })],
    ["the SDK rail's success for another amount", (
      sdkRail: PayDemRail,
    ): PayDemRail["settle"] => async (input) => {
      await input.journalPreparedTransfer!(PREPARED(input.recovery!));
      await input.assertCurrentBeforeBroadcast!();
      return sdkRail.settle({ recipient: PAYEE, amount: "1", network: "demos" });
    }],
    ["the SDK rail's success for another amount with the same hash, parties, network and settlement key", (
      sdkRail: PayDemRail,
    ): PayDemRail["settle"] => async (input) => {
      // Only the amount differs from this payment: the hash is the journaled
      // one, and the payer, payee, network and settlement key are this
      // order's. The rail binds the recovery context's amount to its own.
      await input.journalPreparedTransfer!(PREPARED(input.recovery!));
      await input.assertCurrentBeforeBroadcast!();
      return sdkRail.settle({
        recipient: input.recipient,
        amount: "1",
        network: input.network,
        maxTotalDebitOs: input.maxTotalDebitOs,
        recovery: { ...input.recovery!, amountOs: "1" },
      });
    }],
    ["the SDK rail's success for a hash this payment never journaled", (
      sdkRail: PayDemRail,
    ): PayDemRail["settle"] => async (input) => {
      await input.journalPreparedTransfer!(PREPARED(input.recovery!, "4".repeat(64)));
      await input.assertCurrentBeforeBroadcast!();
      return sdkRail.settle({
        recipient: input.recipient,
        amount: input.amount,
        network: input.network,
        maxTotalDebitOs: input.maxTotalDebitOs,
        recovery: input.recovery,
      });
    }],
    ["the SDK rail's success for another settlement key with identical terms", (
      sdkRail: PayDemRail,
    ): PayDemRail["settle"] => async (input) => {
      // Journaled under the very hash that success carries: only the
      // settlement-key binding tells this order's payment from the other's.
      await input.journalPreparedTransfer!(PREPARED(input.recovery!));
      await input.assertCurrentBeforeBroadcast!();
      const otherJob = `${AUTHORITY.jobId}-other`;
      return sdkRail.settle({
        recipient: input.recipient,
        amount: input.amount,
        network: input.network,
        maxTotalDebitOs: input.maxTotalDebitOs,
        recovery: {
          ...input.recovery!,
          jobId: otherJob,
          settlementKey: settlementKey(AUTHORITY.railId, otherJob, AUTHORITY.phaseIndex),
        },
      });
    }],
  ])("holds %s without settling the wallet or a notice (#338)", async (
    _case,
    settleWith,
  ) => {
    const database = await open(join(root(), "buyer.sqlite"));
    putDacsLiveOrderInputV1({ database, order: ORDER, application: {} });
    const publishNotice = vi.fn();
    const walletSpendAuthority = createAccountingTestWalletSpendAuthorityV1({
      wallet: PAYER,
      chainId: "demos",
      asset: "DEM",
      maximumConcurrentEffects: 1,
    });
    const rail = markDacsSdkPreparedPayDemRailV1<PayDemRail>({
      address: PAYER,
      settle: settleWith(await sdkPayDemRail()),
    });
    const payment = createDacsPayDemBuyerPaymentTrackV1({
      walletSpendAuthority,
      database,
      workerId: "buyer-dem-unverified",
      rail,
      resolveAuthority: () => AUTHORITY,
      reconcile: () => ({ status: "indeterminate", reasonCode: "not-yet" }),
      publishNotice,
    });
    const coordinator = createFixedPricePayDemBuyerCoordinator({
      store: database.createPayDemCoordinatorStore("buyer"),
      workerId: "buyer-coordinator-unverified",
      operations: { agreement: success, payment },
    });

    await coordinator.startOrder(ORDER);
    await coordinator.runPending({ limit: 2 });

    expect((await coordinator.getOrderStatus(JOB_ID))?.tracks.payment)
      .toMatchObject({ state: "indeterminate" });
    expect(publishNotice).not.toHaveBeenCalled();
    expect(await walletSpendAuthority.inspect()).toMatchObject({
      activeEffects: 1,
      assets: [{ cumulativeSettledDebit: "0" }],
    });
  });

  // #338: a custom client that signs and broadcasts itself could never make
  // its payment final: a record the SDK read afterwards cannot show the
  // transfer was this payment's, came after its journal and fence, or paid the
  // fee it claims. The SDK refuses it before its transfer runs, so the track
  // neither debits the buyer nor settles the wallet or publishes a notice.
  it("refuses a custom client that signs and broadcasts itself before any transfer", async () => {
    const transfer = vi.fn<DemosNativeClient["transfer"]>(async ({
      recovery,
      journalPreparedTransfer,
      assertCurrentBeforeBroadcast,
    }) => {
      await journalPreparedTransfer!(PREPARED(recovery!, TX_HASH));
      await assertCurrentBeforeBroadcast!();
      return { ok: true, state: "included", execution: "executed", hash: TX_HASH,
        blockNumber: 42, totalDebitOs: AUTHORITY.amountOs };
    });
    const client: DemosNativeClient = { address: PAYER, transfer };
    const database = await open(join(root(), "buyer.sqlite"));
    putDacsLiveOrderInputV1({ database, order: ORDER, application: {} });
    const publishNotice = vi.fn();
    const walletSpendAuthority = createAccountingTestWalletSpendAuthorityV1({
      wallet: PAYER,
      chainId: "demos",
      asset: "DEM",
      maximumConcurrentEffects: 1,
    });
    const rail = markDacsSdkPreparedPayDemRailV1<PayDemRail>({
      address: PAYER,
      settle: (params, effectFence) => payDemSettleCore(params, client, effectFence),
    });
    const payment = createDacsPayDemBuyerPaymentTrackV1({
      walletSpendAuthority,
      database,
      workerId: "buyer-dem-custom-client",
      rail,
      resolveAuthority: () => AUTHORITY,
      reconcile: () => ({ status: "indeterminate", reasonCode: "not-required" }),
      publishNotice,
    });
    const coordinator = createFixedPricePayDemBuyerCoordinator({
      store: database.createPayDemCoordinatorStore("buyer"),
      workerId: "buyer-coordinator-custom-client",
      operations: { agreement: success, payment },
    });

    await coordinator.startOrder(ORDER);
    await coordinator.runPending({ limit: 2 });

    expect(transfer).not.toHaveBeenCalled();
    expect(demosSdk.nodeCall).not.toHaveBeenCalled();
    expect(demosSdk.getTxByHash).not.toHaveBeenCalled();
    expect(publishNotice).not.toHaveBeenCalled();
    expect((await coordinator.getOrderStatus(JOB_ID))?.tracks.payment?.state)
      .not.toBe("final");
    expect(await walletSpendAuthority.inspect()).toMatchObject({
      assets: [{ cumulativeSettledDebit: "0" }],
    });
  });

  it("keeps funded wallet settlement indeterminate without an accounted network fee", async () => {
    const database = await open(join(root(), "buyer.sqlite"));
    putDacsLiveOrderInputV1({ database, order: ORDER, application: {} });
    const publishNotice = vi.fn();
    const walletSpendAuthority = createAccountingTestWalletSpendAuthorityV1({
      wallet: PAYER,
      chainId: "demos",
      asset: "DEM",
      maximumConcurrentEffects: 1,
    });
    const rail = markDacsSdkPreparedPayDemRailV1<PayDemRail>({
      address: PAYER,
      async settle(input) {
        await input.journalPreparedTransfer!({
          txHash: TX_HASH,
          nonce: 7,
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
          execution: "executed",
          txHash: TX_HASH,
          chainId: "demos",
          payer: PAYER,
          payee: PAYEE,
          finality: { model: "bft-final" },
          blockNumber: 42,
          txRefKind: "demos",
        };
      },
    });
    const payment = createDacsPayDemBuyerPaymentTrackV1({
      walletSpendAuthority,
      database,
      workerId: "buyer-dem-missing-fee",
      rail,
      resolveAuthority: () => AUTHORITY,
      reconcile: () => ({ status: "indeterminate", reasonCode: "not-required" }),
      publishNotice,
    });
    const coordinator = createFixedPricePayDemBuyerCoordinator({
      store: database.createPayDemCoordinatorStore("buyer"),
      workerId: "buyer-coordinator-missing-fee",
      operations: { agreement: success, payment },
    });

    await coordinator.startOrder(ORDER);
    await coordinator.runPending({ limit: 2 });

    expect((await coordinator.getOrderStatus(JOB_ID))?.tracks.payment)
      .toMatchObject({ state: "indeterminate" });
    expect(publishNotice).not.toHaveBeenCalled();
    expect(await walletSpendAuthority.inspect()).toMatchObject({
      activeEffects: 1,
      assets: [{ cumulativeSettledDebit: "0" }],
    });
  });

  it.each([
    ["no execution attestation", {}],
    ["an inclusion attestation", { execution: "included" }],
    ["a boolean execution attestation", { execution: true }],
  ])("holds a fresh rail success with %s without settling or notice (#338)", async (
    _case,
    execution,
  ) => {
    const database = await open(join(root(), "buyer.sqlite"));
    putDacsLiveOrderInputV1({ database, order: ORDER, application: {} });
    const publishNotice = vi.fn();
    const walletSpendAuthority = createAccountingTestWalletSpendAuthorityV1({
      wallet: PAYER,
      chainId: "demos",
      asset: "DEM",
      maximumConcurrentEffects: 1,
    });
    let broadcasts = 0;
    const rail = markDacsSdkPreparedPayDemRailV1<PayDemRail>({
      address: PAYER,
      async settle(input) {
        await input.journalPreparedTransfer!({
          txHash: TX_HASH,
          nonce: 7,
          payer: PAYER,
          payee: PAYEE,
          amountOs: AUTHORITY.amountOs,
          network: "demos",
          maxTotalDebitOs: AUTHORITY.maxTotalDebitOs,
          recovery: input.recovery!,
        });
        await input.assertCurrentBeforeBroadcast!();
        broadcasts += 1;
        // An otherwise valid success from a rail that observed inclusion only.
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
          ...execution,
        } as unknown as Awaited<ReturnType<PayDemRail["settle"]>>;
      },
    });
    const reconcile = vi.fn(() => ({
      status: "indeterminate" as const,
      reasonCode: "not-yet",
    }));
    const payment = createDacsPayDemBuyerPaymentTrackV1({
      walletSpendAuthority,
      database,
      workerId: "buyer-dem-unexecuted",
      rail,
      resolveAuthority: () => AUTHORITY,
      reconcile,
      publishNotice,
    });
    const coordinator = createFixedPricePayDemBuyerCoordinator({
      store: database.createPayDemCoordinatorStore("buyer"),
      workerId: "buyer-coordinator-unexecuted",
      operations: { agreement: success, payment },
    });

    await coordinator.startOrder(ORDER);
    await coordinator.runPending({ limit: 2 });

    expect((await coordinator.getOrderStatus(JOB_ID))?.tracks.payment)
      .toMatchObject({
        state: "indeterminate",
        reasonCode: "pay-dem-settlement-ambiguous",
      });
    expect(broadcasts).toBe(1);
    expect(publishNotice).not.toHaveBeenCalled();
    expect(await walletSpendAuthority.inspect()).toMatchObject({
      activeEffects: 1,
      assets: [{ cumulativeSettledDebit: "0" }],
    });

    // A later pass reconciles the retained effect; it never broadcasts again.
    await coordinator.runPending({ limit: 2 });
    expect(broadcasts).toBe(1);
    expect(publishNotice).not.toHaveBeenCalled();
    expect(await walletSpendAuthority.inspect()).toMatchObject({
      assets: [{ cumulativeSettledDebit: "0" }],
    });
  });

  it("composes the generated Demos wrapper through the wallet pre-broadcast boundary", async () => {
    const directory = root();
    const database = await open(join(directory, "buyer.sqlite"));
    putDacsLiveOrderInputV1({ database, order: ORDER, application: {} });
    const events: string[] = [];
    instrumentPaymentDatabase(database, events);
    const sdkRail = await sdkPayDemRail();
    demosSdk.broadcast.mockImplementation(async () => {
      events.push("broadcast");
      return { result: 200, response: { hash: TX_HASH } };
    });
    const innerRail: PayDemRail = {
      address: PAYER,
      async settle(input, effectFence) {
        expect(effectFence).toBeDefined();
        return sdkRail.settle({
          ...input,
          assertCurrentBeforeBroadcast: async () => {
            await input.assertCurrentBeforeBroadcast!();
            events.push("rail-effect-guard");
          },
        }, effectFence);
      },
    };
    const generated = await composedGeneratedRail(directory, innerRail, events);
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
      workerId: "buyer-dem-generated-composition",
      rail: generated.rail,
      resolveAuthority: () => AUTHORITY,
      reconcile: () => ({ status: "indeterminate", reasonCode: "not-required" }),
      publishNotice: () => { events.push("notice-queued"); },
    });
    const coordinator = createFixedPricePayDemBuyerCoordinator({
      store: database.createPayDemCoordinatorStore("buyer"),
      workerId: "buyer-coordinator-generated-composition",
      operations: { agreement: success, payment },
    });

    await coordinator.startOrder(ORDER);
    await coordinator.runPending({ limit: 2 });

    expect(events).toEqual([
      "checkpoint",
      "demos-prepared",
      "wallet-reserved",
      "wallet-effect-begun",
      "outer-authority-guard",
      "demos-authority-guard",
      "broadcast-intent",
      "rail-effect-guard",
      "broadcast",
      "canonical-confirmed",
      "notice-queued",
    ]);
    expect((await coordinator.getOrderStatus(JOB_ID))?.tracks.payment)
      .toMatchObject({ state: "final", outcome: "success" });
    expect(await walletSpendAuthority.inspect()).toMatchObject({
      activeEffects: 0,
      assets: [{ cumulativeSettledDebit: AUTHORITY.maxTotalDebitOs }],
    });
    const retained = await generated.journal.acquire({
      chainIdentity: "pay-dem-composition-chain",
      wallet: PAYER,
    });
    expect(retained.snapshot.records).toMatchObject([{
      stage: "canonical-confirmed",
      txRef: TX_HASH,
    }]);
    await retained.release();
  });

  it.each(["actor", "wallet"] as const)(
    "does not broadcast when the %s fence goes stale during the Demos intent journal",
    async (staleFence) => {
      const directory = root();
      const database = await open(join(directory, "buyer.sqlite"));
      putDacsLiveOrderInputV1({ database, order: ORDER, application: {} });
      const events: string[] = [];
      instrumentPaymentDatabase(database, events, staleFence === "actor");
      let broadcasts = 0;
      const publishNotice = vi.fn();
      const innerRail: PayDemRail = {
        address: PAYER,
        async settle(input, effectFence) {
          await effectFence?.assertCurrent();
          await input.journalPreparedTransfer!({
            txHash: TX_HASH,
            nonce: 7,
            payer: PAYER,
            payee: PAYEE,
            amountOs: AUTHORITY.amountOs,
            denomination: "os",
            network: "demos",
            maxTotalDebitOs: AUTHORITY.maxTotalDebitOs,
            confirmedTotalDebitOs: AUTHORITY.maxTotalDebitOs,
            recovery: input.recovery!,
          });
          await input.assertCurrentBeforeBroadcast!();
          events.push("rail-effect-guard");
          await effectFence?.assertCurrent();
          broadcasts += 1;
          return {
            ok: true,
            execution: "executed",
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
      const generated = await composedGeneratedRail(directory, innerRail, events);
      const authority = createAccountingTestWalletSpendAuthorityV1({
        wallet: PAYER,
        chainId: "demos",
        asset: "DEM",
        maximumConcurrentEffects: 1,
      });
      const walletSpendAuthority: WalletSpendAuthorityV1 = staleFence === "actor"
        ? authority
        : Object.freeze({
            policy: authority.policy,
            policyHash: authority.policyHash,
            async reserve(...args: Parameters<WalletSpendAuthorityV1["reserve"]>) {
              const claim = await authority.reserve(...args);
              if (claim.status !== "reserved") return claim;
              return Object.freeze({
                status: "reserved" as const,
                permit: Object.freeze({
                  ...claim.permit,
                  async assertCurrent(): Promise<void> {
                    if (events.includes("broadcast-intent")) {
                      throw new Error("wallet fence became stale after intent journal");
                    }
                    await claim.permit.assertCurrent();
                  },
                }),
              });
            },
            reconcile: (...args: Parameters<WalletSpendAuthorityV1["reconcile"]>) =>
              authority.reconcile(...args),
            inspect: () => authority.inspect(),
          });
      const payment = createDacsPayDemBuyerPaymentTrackV1({
        walletSpendAuthority,
        database,
        workerId: "buyer-dem-stale-after-intent",
        rail: generated.rail,
        resolveAuthority: () => AUTHORITY,
        reconcile: () => ({ status: "indeterminate", reasonCode: "not-required" }),
        publishNotice,
      });
      const coordinator = createFixedPricePayDemBuyerCoordinator({
        store: database.createPayDemCoordinatorStore("buyer"),
        workerId: "buyer-coordinator-stale-after-intent",
        operations: { agreement: success, payment },
      });

      await coordinator.startOrder(ORDER);
      await coordinator.runPending({ limit: 2 });

      expect(events).toContain("broadcast-intent");
      expect(events).toContain("rail-effect-guard");
      expect(broadcasts).toBe(0);
      expect(publishNotice).not.toHaveBeenCalled();
      expect((await coordinator.getOrderStatus(JOB_ID))?.tracks.payment)
        .toMatchObject({ state: "indeterminate" });
      expect(await walletSpendAuthority.inspect()).toMatchObject({ activeEffects: 1 });
      const retained = await generated.journal.acquire({
        chainIdentity: "pay-dem-composition-chain",
        wallet: PAYER,
      });
      expect(retained.snapshot.records).toMatchObject([{ stage: "broadcast-intent" }]);
      await retained.release();
    },
  );

  it("keeps the generated Demos record prepared when wallet reserve is denied", async () => {
    const directory = root();
    const database = await open(join(directory, "buyer.sqlite"));
    putDacsLiveOrderInputV1({ database, order: ORDER, application: {} });
    const events: string[] = [];
    instrumentPaymentDatabase(database, events);
    let broadcasts = 0;
    const innerRail: PayDemRail = {
      address: PAYER,
      async settle(input) {
        await input.journalPreparedTransfer!({
          txHash: TX_HASH,
          nonce: 8,
          payer: PAYER,
          payee: PAYEE,
          amountOs: AUTHORITY.amountOs,
          denomination: "os",
          network: "demos",
          maxTotalDebitOs: AUTHORITY.maxTotalDebitOs,
          confirmedTotalDebitOs: AUTHORITY.maxTotalDebitOs,
          recovery: input.recovery!,
        });
        await input.assertCurrentBeforeBroadcast!();
        broadcasts += 1;
        throw new Error("unreachable broadcast fixture");
      },
    };
    const generated = await composedGeneratedRail(directory, innerRail, events);
    const authority = createAccountingTestWalletSpendAuthorityV1({
      wallet: PAYER,
      chainId: "demos",
      asset: "DEM",
      maximumConcurrentEffects: 1,
    });
    const blocker = await authority.reserve({
      ...recoveryReservation(),
      reservationId: "pay-dem:existing-wallet-effect",
      jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7F",
    });
    expect(blocker.status).toBe("reserved");
    const walletSpendAuthority = observeWalletEffectBegin(authority, events);
    const payment = createDacsPayDemBuyerPaymentTrackV1({
      walletSpendAuthority,
      database,
      workerId: "buyer-dem-generated-denial",
      rail: generated.rail,
      resolveAuthority: () => AUTHORITY,
      reconcile: () => ({ status: "indeterminate", reasonCode: "not-required" }),
      publishNotice: vi.fn(),
    });
    const coordinator = createFixedPricePayDemBuyerCoordinator({
      store: database.createPayDemCoordinatorStore("buyer"),
      workerId: "buyer-coordinator-generated-denial",
      operations: { agreement: success, payment },
    });

    await coordinator.startOrder(ORDER);
    await coordinator.runPending({ limit: 2 });

    expect(events).toEqual(["checkpoint", "demos-prepared"]);
    expect(broadcasts).toBe(0);
    expect((await coordinator.getOrderStatus(JOB_ID))?.tracks.payment).toMatchObject({
      state: "operator-action",
      reasonCode: "wallet-spend-concurrency-limit",
    });
    expect(await authority.inspect()).toMatchObject({ activeEffects: 1, revision: 1 });
    const retained = await generated.journal.acquire({
      chainIdentity: "pay-dem-composition-chain",
      wallet: PAYER,
    });
    expect(retained.snapshot.records).toMatchObject([{
      stage: "prepared",
      txRef: TX_HASH,
    }]);
    await retained.release();
  });

  it("keeps a reserved row fail-closed when beginEffect acknowledgement fails", async () => {
    const database = await open(join(root(), "buyer.sqlite"));
    const secondJobId = "01J8ME0SXKQ4T9V2RC5HJ6WX7G";
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
    const now = { value: 1_000 };
    const authenticateRecovery = vi.fn(async () => true);
    const authority = recoveryWalletAuthority(authenticateRecovery, now);
    const events: string[] = [];
    const walletSpendAuthority: WalletSpendAuthorityV1 = Object.freeze({
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
              events.push("wallet-begin-ack-unknown");
              throw new Error("simulated remote begin acknowledgement failure");
            },
          }),
        });
      },
      reconcile: (...args: Parameters<WalletSpendAuthorityV1["reconcile"]>) =>
        authority.reconcile(...args),
      inspect: () => authority.inspect(),
    });
    let broadcasts = 0;
    const rail = markDacsSdkPreparedPayDemRailV1<PayDemRail>({
      address: PAYER,
      async settle(input) {
        await input.journalPreparedTransfer!({
          txHash: TX_HASH,
          nonce: 9,
          payer: PAYER,
          payee: PAYEE,
          amountOs: AUTHORITY.amountOs,
          denomination: "os",
          network: "demos",
          maxTotalDebitOs: AUTHORITY.maxTotalDebitOs,
          confirmedTotalDebitOs: AUTHORITY.maxTotalDebitOs,
          recovery: input.recovery!,
        });
        await input.assertCurrentBeforeBroadcast!();
        broadcasts += 1;
        throw new Error("unreachable broadcast fixture");
      },
    });
    const payment = createDacsPayDemBuyerPaymentTrackV1({
      walletSpendAuthority,
      database,
      workerId: "buyer-dem-begin-ack-unknown",
      rail,
      resolveAuthority: ({ operation }) => ({
        ...AUTHORITY,
        jobId: operation.order.jobId,
      }),
      reconcile: () => ({ status: "operator-action",
        reasonCode: "pay-dem-prepared-transfer-checkpoint-missing" }),
      publishNotice: vi.fn(),
    });
    const coordinator = createFixedPricePayDemBuyerCoordinator({
      store: database.createPayDemCoordinatorStore("buyer"),
      workerId: "buyer-coordinator-begin-ack-unknown",
      operations: { agreement: success, payment },
    });

    await coordinator.startOrder(ORDER);
    await coordinator.runPending({ limit: 2 });
    expect(events).toEqual(["wallet-reserved", "wallet-begin-ack-unknown"]);
    expect((await coordinator.getOrderStatus(JOB_ID))?.tracks.payment)
      .toMatchObject({ state: "indeterminate" });
    // The remote acknowledgement is uncertain and no independent terminal
    // chain observation proves non-invocation. Expiry therefore escalates the
    // exact reservation for operator action; it never authorizes release.
    now.value = 1_101;
    expect(await authority.inspect()).toMatchObject({
      activeEffects: 1,
      operatorActionReservations: [expect.any(String)],
    });

    await coordinator.startOrder(secondOrder);
    await coordinator.runPending({ limit: 2 });
    expect(broadcasts).toBe(0);
    expect((await coordinator.getOrderStatus(secondJobId))?.tracks.payment).toMatchObject({
      state: "operator-action",
      reasonCode: "wallet-spend-concurrency-limit",
    });
    expect(authenticateRecovery).not.toHaveBeenCalled();
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
      name: "custom client rail retains wallet ambiguity when preparation fails",
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
    const rail = sdkDefaultRail
      ? markDacsSdkPreparedPayDemRailV1<PayDemRail>({
          address: PAYER,
          async settle() {
            events.push("rail-preparation-started");
            await prepareTransfer();
            broadcasts += 1;
            return {
              ok: true,
              execution: "executed",
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
        })
      : await sdkPayDemRailSigning(TX_HASH, 7, {
          onSign: async () => {
            events.push("rail-preparation-started");
            await prepareTransfer();
          },
          onBroadcast: async () => {
            broadcasts += 1;
            return { result: 200, response: { hash: TX_HASH } };
          },
        });
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

  // #338: a rail whose success the SDK could never make final never runs a
  // fresh payment, so it can neither reserve the wallet nor debit it.
  it("refuses an unmarked custom rail's fresh payment before any wallet reservation or settle", async () => {
    const settle = vi.fn<PayDemRail["settle"]>();
    const reserve = vi.fn<WalletSpendAuthorityV1["reserve"]>();
    const { database, operation, writes } = retainedEffectDatabase("fresh");
    const payment = createDacsPayDemBuyerPaymentTrackV1({
      walletSpendAuthority: { ...createPermissiveTestWalletSpendAuthorityV1(), reserve },
      database,
      workerId: "buyer-dem-unmarked-rail",
      rail: { address: PAYER, settle },
      resolveAuthority: () => AUTHORITY,
      reconcile: () => ({ status: "indeterminate", reasonCode: "not-required" }),
      publishNotice: vi.fn(),
    });

    await expect(payment(operation)).resolves.toEqual({
      status: "operator-action",
      reasonCode: "pay-dem-rail-not-record-verifying",
    });
    expect(writes).toEqual(["operator-action:pay-dem-rail-not-record-verifying"]);
    expect(reserve).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  // Refusing the rail when the track is built would strand a payment it made
  // before the upgrade. Recovery settles the wallet and publishes the notice
  // from the reconciliation without calling the rail.
  it("reconciles an unmarked custom rail's retained payment without calling the rail", async () => {
    const settle = vi.fn<PayDemRail["settle"]>();
    const authority = createPermissiveTestWalletSpendAuthorityV1();
    const reserve = vi.fn<WalletSpendAuthorityV1["reserve"]>();
    const walletReconcile = vi.fn<WalletSpendAuthorityV1["reconcile"]>(
      (...args) => authority.reconcile(...args),
    );
    const reconcile = vi.fn<DacsPayDemBuyerPaymentTrackOptionsV1["reconcile"]>(
      ({ prepared }) => ({
        status: "completed",
        settlement: {
          ok: true,
          txHash: prepared!.txHash,
          chainId: "demos",
          payer: PAYER,
          payee: PAYEE,
          finality: { model: "bft-final" },
          blockNumber: 43,
          txRefKind: "demos",
          amountOs: AUTHORITY.amountOs,
          networkFeeOs: "1000000000",
        },
      }),
    );
    const publishNotice = vi.fn();
    const { database, operation, writes } = retainedEffectDatabase("reconcile");
    const payment = createDacsPayDemBuyerPaymentTrackV1({
      walletSpendAuthority: { ...authority, reserve, reconcile: walletReconcile },
      database,
      workerId: "buyer-dem-unmarked-rail-recovery",
      rail: { address: PAYER, settle },
      resolveAuthority: () => AUTHORITY,
      reconcile,
      publishNotice,
    });

    await expect(payment(operation)).resolves.toMatchObject({
      status: "final",
      outcome: "success",
      authenticationHash: TX_HASH,
    });
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      prepared: expect.objectContaining({ txHash: TX_HASH, nonce: 7 }),
    }));
    expect(walletReconcile).toHaveBeenCalledOnce();
    expect(publishNotice).toHaveBeenCalledOnce();
    expect(writes).toEqual(["reconciliation:performed"]);
    expect(reserve).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  // The crash point between settling the wallet and queueing the notice: the
  // SDK verified the payment, the wallet settled, then the notice failed. The
  // restart reconciles and queues the notice without a second transfer.
  it("reconciles after the notice queue fails behind a settled wallet without paying again", async () => {
    // A hash no other test settles, so the SDK reads and binds its record.
    const txHash = "d".repeat(64);
    demosSdk.getTxByHash.mockImplementation(async () => ({
      hash: txHash,
      status: "confirmed",
      blockNumber: 42,
      content: {
        type: "native",
        from: PAYER,
        to: PAYEE,
        amount: Number(AUTHORITY.amountOs),
        nonce: "9",
        data: ["native", { nativeOperation: "send", args: [PAYEE, AUTHORITY.amountOs] }],
      },
    }));
    const rail = await sdkPayDemRailSigning(txHash, 9);
    const authority = createPermissiveTestWalletSpendAuthorityV1();
    const permitSettles: string[] = [];
    const walletSpendAuthority: WalletSpendAuthorityV1 = {
      ...authority,
      async reserve(reservation) {
        const claim = await authority.reserve(reservation);
        if (claim.status !== "reserved") return claim;
        return {
          status: "reserved",
          permit: {
            ...claim.permit,
            async settle(settlement) {
              permitSettles.push(settlement.evidenceHash);
              await claim.permit.settle(settlement);
            },
          },
        };
      },
    };
    const checkpoints = new Map<string, unknown>();
    const first = retainedEffectDatabase("fresh", checkpoints);
    const failingNotice = vi.fn(async () => {
      throw new Error("notice queue unavailable");
    });
    const firstPayment = createDacsPayDemBuyerPaymentTrackV1({
      walletSpendAuthority,
      database: first.database,
      workerId: "buyer-dem-before-notice-failure",
      rail,
      resolveAuthority: () => AUTHORITY,
      reconcile: () => ({ status: "indeterminate", reasonCode: "not-yet" }),
      publishNotice: failingNotice,
    });

    await expect(firstPayment(first.operation)).resolves.toMatchObject({
      status: "indeterminate",
      reasonCode: "pay-dem-settlement-ambiguous",
    });
    expect(demosSdk.broadcast).toHaveBeenCalledOnce();
    expect(permitSettles).toEqual([txHash]);
    expect(failingNotice).toHaveBeenCalledOnce();
    expect(first.writes).toEqual([
      "checkpoint:pay-dem-prepared-transfer",
      "ambiguous:pay-dem-settlement-ambiguous",
    ]);

    const restarted = retainedEffectDatabase("reconcile", checkpoints);
    const reconcile = vi.fn<DacsPayDemBuyerPaymentTrackOptionsV1["reconcile"]>(
      ({ prepared }) => ({
        status: "completed",
        settlement: {
          ok: true,
          txHash: prepared!.txHash,
          chainId: "demos",
          payer: PAYER,
          payee: PAYEE,
          finality: { model: "bft-final" },
          blockNumber: 42,
          txRefKind: "demos",
          amountOs: AUTHORITY.amountOs,
          networkFeeOs: "1000000000",
        },
      }),
    );
    const publishNotice = vi.fn();
    const resumedPayment = createDacsPayDemBuyerPaymentTrackV1({
      walletSpendAuthority: createPermissiveTestWalletSpendAuthorityV1(),
      database: restarted.database,
      workerId: "buyer-dem-after-notice-failure",
      rail,
      resolveAuthority: () => AUTHORITY,
      reconcile,
      publishNotice,
    });

    await expect(resumedPayment(restarted.operation)).resolves.toMatchObject({
      status: "final",
      outcome: "success",
      authenticationHash: txHash,
    });
    expect(demosSdk.transfer).toHaveBeenCalledOnce();
    expect(demosSdk.broadcast).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      prepared: expect.objectContaining({ txHash, nonce: 9 }),
    }));
    expect(publishNotice).toHaveBeenCalledOnce();
    expect(vi.mocked(publishNotice).mock.calls[0]?.[0].notice.settlement)
      .toMatchObject({ txHash, blockNumber: 42 });
    expect(restarted.writes).toEqual(["reconciliation:performed"]);
  });

  it("holds an SDK-verified success whose broadcast never passed the pre-broadcast fence", async () => {
    const txHash = "c".repeat(64);
    demosSdk.getTxByHash.mockImplementation(async () => ({
      hash: txHash,
      status: "confirmed",
      blockNumber: 42,
      content: {
        type: "native",
        from: PAYER,
        to: PAYEE,
        amount: Number(AUTHORITY.amountOs),
        nonce: "7",
        data: ["native", { nativeOperation: "send", args: [PAYEE, AUTHORITY.amountOs] }],
      },
    }));
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
    const inner = await sdkPayDemRailSigning(txHash, 7);
    const payment = createDacsPayDemBuyerPaymentTrackV1({
      walletSpendAuthority,
      database,
      workerId: "buyer-dem-missing-pre-broadcast-fence",
      // A record-verifying wrapper that relays the SDK rail's genuine success
      // but drops the track's pre-broadcast fence on the way in.
      rail: markDacsRecordVerifyingPayDemRailV1<PayDemRail>({
        address: inner.address,
        settle: ({ assertCurrentBeforeBroadcast: _dropped, ...params }, effectFence) =>
          inner.settle(params, effectFence),
      }),
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

    // The SDK read the record; the track still holds a success whose
    // broadcast never passed the pre-broadcast fence.
    expect(demosSdk.getTxByHash).toHaveBeenCalledWith(txHash);
    expect(events).toEqual(["wallet-reserved"]);
    expect(publishNotice).not.toHaveBeenCalled();
    expect((await coordinator.getOrderStatus(JOB_ID))?.tracks.payment)
      .toMatchObject({ state: "indeterminate" });
    expect(await walletSpendAuthority.inspect()).toMatchObject({
      revision: 1,
      assets: [{ cumulativeSettledDebit: "0" }],
    });
  });

  // A payment held after its broadcast reconciles after a restart, also when
  // the host has since replaced the rail with one the track would never run.
  it("reconciles a held payment after restart through an unmarked rail without settling again", async () => {
    const databasePath = join(root(), "buyer.sqlite");
    const first = await open(databasePath);
    putDacsLiveOrderInputV1({ database: first, order: ORDER, application: {} });
    // The node does not serve the record yet, so the SDK holds this attempt.
    demosSdk.getTxByHash.mockRejectedValue(new Error("record not served yet"));
    const heldNotice = vi.fn();
    // A record-verifying wrapper whose transfer journals a legacy prepared
    // record, with no denomination, and is held after its broadcast.
    const firstRail = markDacsRecordVerifyingPayDemRailV1<PayDemRail>({
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
          confirmedTotalDebitOs: AUTHORITY.maxTotalDebitOs,
          recovery: input.recovery!,
        });
        await input.assertCurrentBeforeBroadcast!();
        return { ok: false, txHash: TX_HASH, chainId: "demos", payer: PAYER, payee: PAYEE };
      },
    });
    const firstPayment = createDacsPayDemBuyerPaymentTrackV1({
      walletSpendAuthority: createPermissiveTestWalletSpendAuthorityV1(),
      database: first,
      workerId: "buyer-dem-before-restart",
      rail: firstRail,
      resolveAuthority: () => AUTHORITY,
      reconcile: () => ({ status: "indeterminate", reasonCode: "not-yet" }),
      publishNotice: heldNotice,
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
    expect(heldNotice).not.toHaveBeenCalled();
    first.checkpoint();
    first.close();
    databases.splice(databases.indexOf(first), 1);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const restarted = await open(databasePath);
    // A rail that is not the SDK's: its settle never runs, before or after.
    const settle = vi.fn<PayDemRail["settle"]>(async () => {
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
      rail: await sdkPayDemRailSigning(TX_HASH, 11, {
        onBroadcast: async () => {
          transfers += 1;
          throw new Error("transfer completed but response was lost");
        },
      }),
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
    const resumedRail = await sdkPayDemRail();
    demosSdk.transfer.mockClear();
    demosSdk.transfer.mockRejectedValue(new Error("restored actor must not rebroadcast"));
    const resumedPayment = createDacsPayDemBuyerPaymentTrackV1({
      walletSpendAuthority,
      database: first,
      workerId: "buyer-after-actor-restore",
      rail: resumedRail,
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

    expect(demosSdk.transfer).not.toHaveBeenCalled();
    expect(transfers).toBe(1);
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
