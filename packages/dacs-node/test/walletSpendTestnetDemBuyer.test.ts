import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPayDemSellerObserver,
  settlementKey,
  type PayDemRail,
  type WalletSpendReservationV1,
} from "@kynesyslabs/dacs";
import {
  createFixedPricePayDemBuyerCoordinator,
  FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
  FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
  FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
  type FixedPricePayDemOrderInput,
  type FixedPricePayDemTrackOperation,
} from "@kynesyslabs/dacs/commerce";
import { TP1_APPROVED_IDENTITY_RECORD } from "@kynesyslabs/dacs/wire";

import { DACS_NODE_LIVE_PROFILE } from "../src/config.js";
import { createDacsFixedPricePayDemBuyerReconciliationV1 } from "../src/fixedPricePayDemBuyerPayment.js";
import { putDacsLiveOrderInputV1 } from "../src/orderInput.js";
import { createDacsPayDemBuyerPaymentTrackV1, type DacsPayDemBuyerPaymentAuthorityV1 } from "../src/payDemPayment.js";
import { markDacsSdkPreparedPayDemRailV1 } from "../src/payDemRailCapabilities.js";
import { openDacsNodeSqliteDatabase, type DacsNodeSqliteDatabase } from "../src/sqlite.js";
import { createDacsWalletSpendDemosReaderV1 } from "../src/walletSpendDemosReader.js";
import { startDacsWalletSpendTestnetAuthorityV1 } from "../src/walletSpendTestnetService.js";
import {
  CONFIRMED_AMOUNT,
  CONFIRMED_BLOCK,
  CONFIRMED_FEE,
  CONFIRMED_HASH,
  CONFIRMED_NONCE,
  DEMOS_FEE_CEILING,
  DEMOS_NODE_URL,
  DEMOS_PAYEE,
  DEMOS_PAYER,
  closeDemosNodeStubs,
  demosAuthorityClient,
  demosLaneSettings,
  demosNodeStub,
  demosHold,
  fetchRoutingDemosNodeTo,
  recordedDemosState,
  selfTransferRecord,
  withoutX402Lane,
} from "./helpers/walletSpendDemosNode.js";
import { headStateFile } from "./helpers/walletSpendFileAuthorityStores.js";
import { serviceSettings } from "./helpers/walletSpendTestnetChain.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = "did:example:pay-dem-buyer";
const SELLER = "did:example:pay-dem-seller";
const RAIL = {
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
} as const;

const ORDER: FixedPricePayDemOrderInput = {
  jobId: JOB_ID,
  buyer: BUYER,
  seller: SELLER,
  protocol: {
    commerceProfile: FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
    standardRevision: FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
    phase: "pay-dem",
    orchestratorTopology: "seller-as-phase-orchestrator-v1",
    orchestrator: SELLER,
    rail: RAIL,
  },
  sdkJobs: {
    role: "buyer",
    agreement: `buyer:agreement:${JOB_ID}`,
    payment: `buyer:payment:${JOB_ID}`,
    paymentEvidence: `buyer:payment-evidence:${JOB_ID}`,
    buyerReceived: `buyer:received:${JOB_ID}`,
    audit: `buyer:audit:${JOB_ID}`,
  },
};

/** The recorded transfer's payer, payee and amount, with the buyer's 2 DEM fee ceiling. */
const AUTHORITY: DacsPayDemBuyerPaymentAuthorityV1 = {
  authorityVersion: "1",
  jobId: JOB_ID,
  phaseIndex: 2,
  railId: RAIL.railId,
  railVersion: RAIL.railVersion,
  railDescriptorHash: RAIL.railDefinitionHash,
  network: "demos",
  payer: DEMOS_PAYER,
  payee: DEMOS_PAYEE,
  amountOs: CONFIRMED_AMOUNT,
  maxTotalDebitOs: (BigInt(CONFIRMED_AMOUNT) + BigInt(DEMOS_FEE_CEILING)).toString(),
  agreementHash: "6".repeat(64),
  termsHash: "7".repeat(64),
  payoutBindingHash: "8".repeat(64),
};
const PAID_TOTAL = (BigInt(CONFIRMED_AMOUNT) + BigInt(CONFIRMED_FEE)).toString();

const success: FixedPricePayDemTrackOperation = async ({ fence }) => {
  await fence.assertCurrent();
  return { status: "final", outcome: "success", reference: fence.track };
};

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await closeDemosNodeStubs();
});

async function buyerDatabase(events: string[]): Promise<DacsNodeSqliteDatabase> {
  const root = mkdtempSync(join(tmpdir(), "dacs-testnet-dem-buyer-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const database = await openDacsNodeSqliteDatabase({
    databasePath: join(root, "buyer.sqlite"), mode: "live-demos", profile: DACS_NODE_LIVE_PROFILE,
    role: "buyer", authority: BUYER,
  });
  cleanups.push(() => database.close());
  putDacsLiveOrderInputV1({ database, order: ORDER, application: {} });
  const recordEffectCheckpoint = database.recordEffectCheckpoint.bind(database);
  Object.defineProperty(database, "recordEffectCheckpoint", {
    configurable: true,
    value: (...args: Parameters<DacsNodeSqliteDatabase["recordEffectCheckpoint"]>) => {
      const recorded = recordEffectCheckpoint(...args);
      if (args[0].name === "pay-dem-prepared-transfer") events.push("prepared-checkpoint");
      return recorded;
    },
  });
  return database;
}

/** A prepared-transfer rail for the recorded confirmed transfer, reporting fee F as executed. */
function recordedTransferRail(events: string[]): PayDemRail {
  return markDacsSdkPreparedPayDemRailV1<PayDemRail>({
    address: DEMOS_PAYER,
    async settle(input) {
      if (input.journalPreparedTransfer === undefined || input.assertCurrentBeforeBroadcast === undefined ||
          input.recovery === undefined) {
        throw new Error("expected the SDK's prepared-transfer hooks");
      }
      await input.journalPreparedTransfer({
        txHash: CONFIRMED_HASH, nonce: CONFIRMED_NONCE, payer: DEMOS_PAYER, payee: DEMOS_PAYEE,
        amountOs: CONFIRMED_AMOUNT, denomination: "os", network: "demos",
        maxTotalDebitOs: AUTHORITY.maxTotalDebitOs, confirmedTotalDebitOs: PAID_TOTAL, recovery: input.recovery,
      });
      await input.assertCurrentBeforeBroadcast();
      events.push("broadcast");
      return {
        ok: true, execution: "executed", txHash: CONFIRMED_HASH, chainId: "demos", payer: DEMOS_PAYER,
        payee: DEMOS_PAYEE, finality: { model: "bft-final" }, blockNumber: CONFIRMED_BLOCK, txRefKind: "demos",
        networkFeeOs: CONFIRMED_FEE,
      };
    },
  });
}

/** Runs one pay-dem purchase through the track against a DEM-only service. */
async function purchase(chainFee: string) {
  const node = await demosNodeStub(recordedDemosState(TP1_APPROVED_IDENTITY_RECORD.chainIdentity));
  const record = node.state.records.get(CONFIRMED_HASH) as { content: { gcr_edits: { amount: unknown }[] } };
  const [, , feeEdit] = record.content.gcr_edits;
  if (feeEdit === undefined) throw new Error("expected the recorded fee edit");
  feeEdit.amount = chainFee;

  vi.stubGlobal("fetch", fetchRoutingDemosNodeTo(node.url));

  const settings = await serviceSettings({ rpcUrl: "https://base-sepolia.unused.example/" });
  cleanups.push(() => settings.remove());
  const lane = await demosLaneSettings({ root: settings.root, rpcUrl: DEMOS_NODE_URL });
  const authority = await startDacsWalletSpendTestnetAuthorityV1({
    environment: { ...withoutX402Lane(settings.environment), ...lane.environment },
  });
  cleanups.push(() => authority.stop());

  const events: string[] = [];
  const reserveRequests: { reservation: WalletSpendReservationV1; options: unknown }[] = [];
  const walletSpendAuthority = await demosAuthorityClient({
    authority, tokenFile: settings.tokenFile,
    fetch: async (input, init) => {
      if (init?.method === "POST" && typeof init.body === "string") {
        const body = JSON.parse(init.body) as { operation: string; payload: Record<string, unknown> };
        if (["reserve", "begin", "settle"].includes(body.operation)) events.push(`service-${body.operation}`);
        if (body.operation === "reserve") {
          reserveRequests.push(body.payload as { reservation: WalletSpendReservationV1; options: unknown });
        }
      }
      return fetch(input, init);
    },
  });
  const database = await buyerDatabase(events);
  const payment = createDacsPayDemBuyerPaymentTrackV1({
    walletSpendAuthority,
    database,
    workerId: "buyer-dem-worker",
    rail: recordedTransferRail(events),
    resolveAuthority: () => AUTHORITY,
    reconcile: () => ({ status: "indeterminate", reasonCode: "not-required" }),
    publishNotice: () => undefined,
  });
  const coordinator = createFixedPricePayDemBuyerCoordinator({
    store: database.createPayDemCoordinatorStore("buyer"),
    workerId: "buyer-coordinator",
    operations: { agreement: success, payment, "payment-evidence": success, "buyer-received": success, audit: success },
  });
  await coordinator.startOrder(ORDER);
  await coordinator.runPending({ limit: 2 });
  return {
    events,
    reserveRequests,
    paymentTrack: (await coordinator.getOrderStatus(JOB_ID))?.tracks.payment,
    hold: headStateFile(lane.dataDirectory).reservations[0],
  };
}

/** A transfer the buyer prepares and never broadcasts; the node does not know it. */
const PREPARED_HASH = "9".repeat(64);
/** The service's hold lease (5 minutes), with room. */
const PAST_HOLD_LEASE_MS = 6 * 60_000;

/** A rail that journals the next prepared transfer, passes the pre-broadcast hook, then stops: nothing is broadcast. */
function stoppingRail(transfers: readonly Readonly<{ txHash: string; nonce: number }>[]): PayDemRail {
  let attempt = 0;
  return markDacsSdkPreparedPayDemRailV1<PayDemRail>({
    address: DEMOS_PAYER,
    async settle(input) {
      const transfer = transfers[attempt];
      attempt += 1;
      if (transfer === undefined || input.journalPreparedTransfer === undefined ||
          input.assertCurrentBeforeBroadcast === undefined || input.recovery === undefined) {
        throw new Error("expected a planned transfer and the SDK's prepared-transfer hooks");
      }
      await input.journalPreparedTransfer({
        txHash: transfer.txHash, nonce: transfer.nonce, payer: DEMOS_PAYER, payee: DEMOS_PAYEE,
        amountOs: CONFIRMED_AMOUNT, denomination: "os", network: "demos",
        maxTotalDebitOs: AUTHORITY.maxTotalDebitOs, confirmedTotalDebitOs: PAID_TOTAL, recovery: input.recovery,
      });
      await input.assertCurrentBeforeBroadcast();
      throw new Error("buyer stopped before broadcast");
    },
  });
}

/**
 * Starts one pay-dem purchase against a DEM-only service whose rail stops before broadcast. The track
 * reconciles as the live buyer graph builds it: the SDK observer and the service's bounded reader.
 */
async function interruptedPurchase(transfers: Parameters<typeof stoppingRail>[0]) {
  const node = await demosNodeStub(recordedDemosState(TP1_APPROVED_IDENTITY_RECORD.chainIdentity));
  const routed = fetchRoutingDemosNodeTo(node.url);
  vi.stubGlobal("fetch", routed);
  const settings = await serviceSettings({ rpcUrl: "https://base-sepolia.unused.example/" });
  cleanups.push(() => settings.remove());
  const lane = await demosLaneSettings({ root: settings.root, rpcUrl: DEMOS_NODE_URL });
  const authority = await startDacsWalletSpendTestnetAuthorityV1({
    environment: { ...withoutX402Lane(settings.environment), ...lane.environment },
  });
  cleanups.push(() => authority.stop());
  const walletSpendAuthority = await demosAuthorityClient({ authority, tokenFile: settings.tokenFile });
  const reader = createDacsWalletSpendDemosReaderV1({
    rpcUrl: DEMOS_NODE_URL, policy: walletSpendAuthority.policy, fetch: routed,
  });
  const observer = createPayDemSellerObserver({ rpc: DEMOS_NODE_URL, fetchImpl: routed });
  const database = await buyerDatabase([]);
  const payment = createDacsPayDemBuyerPaymentTrackV1({
    walletSpendAuthority,
    database,
    workerId: "buyer-dem-interrupted",
    rail: stoppingRail(transfers),
    resolveAuthority: () => AUTHORITY,
    reconcile: createDacsFixedPricePayDemBuyerReconciliationV1(observer.observeDemosTransfer, reader.readAccountNonce),
    publishNotice: () => undefined,
    retryDelayMs: 1,
  });
  const coordinator = createFixedPricePayDemBuyerCoordinator({
    store: database.createPayDemCoordinatorStore("buyer"),
    workerId: "buyer-coordinator-interrupted",
    operations: { agreement: success, payment, "payment-evidence": success, "buyer-received": success, audit: success },
  });
  await coordinator.startOrder(ORDER);
  await coordinator.runPending({ limit: 2 });
  const hold = () => {
    const row = headStateFile(lane.dataDirectory).reservations[0];
    if (row === undefined) throw new Error("expected the purchase's hold");
    return row;
  };
  return { node, coordinator, walletSpendAuthority, hold };
}

describe("pay-dem buyer against the testnet wallet-spend authority", { timeout: 30_000 }, () => {
  it("an interrupted DEM purchase is released through the service once the chain proves its nonce used", async () => {
    const planned = CONFIRMED_NONCE;
    const purchase = await interruptedPurchase([
      { txHash: PREPARED_HASH, nonce: planned },
      { txHash: "8".repeat(64), nonce: planned + 2 },
    ]);
    // (a) The hold planned the nonce the transfer was signed with; nothing reached the chain.
    expect(purchase.hold()).toMatchObject({ stage: "effect-pending", plannedTransferNonce: planned });
    await expect(purchase.walletSpendAuthority.reserve(demosHold("job-two")))
      .resolves.toEqual({ status: "denied", reason: "concurrency-limit" });
    await purchase.coordinator.runPending({ limit: 1 });
    expect(purchase.hold()).toMatchObject({ stage: "effect-pending", plannedTransferNonce: planned });

    // (b) The operator's two self-transfers take the planned nonce and move the wallet past it.
    const selfAtPlanned = selfTransferRecord("5".repeat(64), planned);
    const selfAfterPlanned = selfTransferRecord("6".repeat(64), planned + 1);
    purchase.node.state.records.set(String(selfAtPlanned.hash), selfAtPlanned);
    purchase.node.state.records.set(String(selfAfterPlanned.hash), selfAfterPlanned);
    purchase.node.state.history = [selfAfterPlanned, selfAtPlanned];
    purchase.node.state.accountNonce = planned + 1;
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    vi.setSystemTime(Date.now() + PAST_HOLD_LEASE_MS);
    await purchase.coordinator.runPending({ limit: 1 });
    const released = purchase.hold();
    expect(released).toMatchObject({ stage: "released", evidenceHash: PREPARED_HASH, plannedTransferNonce: planned });

    // A buyer that restarts before recording the release asks again and changes nothing.
    await expect(purchase.walletSpendAuthority.reconcile(released.reservation, {
      disposition: "terminal-absent", evidenceHash: PREPARED_HASH,
    })).resolves.toBe("existing");

    // The retried payment takes a fresh hold planned at the wallet's next nonce.
    await purchase.coordinator.runPending({ limit: 1 });
    expect(purchase.hold()).toMatchObject({ stage: "effect-pending", plannedTransferNonce: planned + 2 });
  });

  it("an interrupted DEM purchase whose transfer landed at its planned nonce is settled once through the service", async () => {
    const purchase = await interruptedPurchase([{ txHash: CONFIRMED_HASH, nonce: CONFIRMED_NONCE }]);
    expect(purchase.hold()).toMatchObject({ stage: "effect-pending", plannedTransferNonce: CONFIRMED_NONCE });
    await purchase.coordinator.runPending({ limit: 1 });
    expect(purchase.hold()).toMatchObject({
      stage: "settled",
      evidenceHash: CONFIRMED_HASH,
      actualDebits: [
        { asset: "DEM", purpose: "service", amount: CONFIRMED_AMOUNT },
        { asset: "DEM", purpose: "network-fee", amount: CONFIRMED_FEE },
      ],
    });
    await purchase.coordinator.runPending({ limit: 4 });
    expect((await purchase.walletSpendAuthority.inspect()).assets[0]?.cumulativeSettledDebit).toBe(PAID_TOTAL);
  });

  it("the generated pay-dem buyer reserves, begins and settles on the service", async () => {
    const paid = await purchase(CONFIRMED_FEE);
    expect(paid.events).toEqual([
      "prepared-checkpoint", "service-reserve", "service-begin", "broadcast", "service-settle",
    ]);
    expect(paid.reserveRequests).toHaveLength(1);
    expect(paid.reserveRequests[0]?.options).toEqual({});
    expect(paid.reserveRequests[0]?.reservation.reservationId)
      .toBe(`pay-dem:${settlementKey(RAIL.railId, JOB_ID, AUTHORITY.phaseIndex)}`);
    expect(paid.paymentTrack).toMatchObject({ state: "final", outcome: "success" });
    expect(paid.hold).toMatchObject({
      stage: "settled",
      evidenceHash: CONFIRMED_HASH,
      actualDebits: [
        { asset: "DEM", purpose: "service", amount: CONFIRMED_AMOUNT },
        { asset: "DEM", purpose: "network-fee", amount: CONFIRMED_FEE },
      ],
    });

    const overCharged = await purchase((BigInt(CONFIRMED_FEE) + 1n).toString());
    expect(overCharged.events.filter((event) => event === "service-settle")).toHaveLength(1);
    expect(overCharged.paymentTrack).toMatchObject({
      state: "indeterminate", reasonCode: "pay-dem-settlement-ambiguous",
    });
    expect(overCharged.hold).toMatchObject({ stage: "effect-pending" });
  });
});
