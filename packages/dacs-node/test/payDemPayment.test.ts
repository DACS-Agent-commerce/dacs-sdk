import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PayDemRail } from "@kynesyslabs/dacs";
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
  createDacsPayDemBuyerPaymentTrackV1,
  type DacsPayDemBuyerPaymentAuthorityV1,
} from "../src/payDemPayment.js";
import { putDacsLiveOrderInputV1 } from "../src/orderInput.js";
import {
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";

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
    const rail: PayDemRail = {
      address: PAYER,
      async settle(input) {
        const prepared = {
          txHash: TX_HASH,
          nonce: 7,
          payer: PAYER,
          payee: PAYEE,
          amountOs: AUTHORITY.amountOs,
          network: "demos",
          maxTotalDebitOs: AUTHORITY.maxTotalDebitOs,
          recovery: input.recovery!,
        } as const;
        await input.journalPreparedTransfer!(prepared);
        events.push("journal-committed");
        await input.assertCurrentBeforeBroadcast!();
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
        };
      },
    };
    const payment = createDacsPayDemBuyerPaymentTrackV1({
      database,
      workerId: "buyer-dem-worker",
      rail,
      resolveAuthority: () => AUTHORITY,
      reconcile: () => ({ status: "indeterminate", reasonCode: "not-required" }),
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

    expect(events).toEqual(["journal-committed", "broadcast"]);
    expect((await coordinator.getOrderStatus(JOB_ID))?.tracks.payment)
      .toMatchObject({ state: "final", outcome: "success" });
  });

  it("reconciles the original checkpoint after restart without settling again", async () => {
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
        throw new Error("broadcast response lost");
      },
    };
    const firstPayment = createDacsPayDemBuyerPaymentTrackV1({
      database: first,
      workerId: "buyer-dem-before-restart",
      rail: firstRail,
      resolveAuthority: () => AUTHORITY,
      reconcile: () => ({ status: "indeterminate", reasonCode: "not-yet" }),
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
      },
    }));
    const resumedPayment = createDacsPayDemBuyerPaymentTrackV1({
      database: restarted,
      workerId: "buyer-dem-after-restart",
      rail: { address: PAYER, settle },
      resolveAuthority: () => AUTHORITY,
      reconcile,
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
      prepared: expect.objectContaining({ txHash: TX_HASH, nonce: 9 }),
    }));
    expect((await resumed.getOrderStatus(JOB_ID))?.tracks.payment)
      .toMatchObject({ state: "final", outcome: "success" });
  });
});
