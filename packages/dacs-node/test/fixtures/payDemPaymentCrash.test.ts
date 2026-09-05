import { writeFile } from "node:fs/promises";

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
import { describe, it } from "vitest";

import { DACS_NODE_LIVE_PROFILE } from "../../src/config.js";
import { putDacsLiveOrderInputV1 } from "../../src/orderInput.js";
import {
  createDacsPayDemBuyerPaymentTrackV1,
  type DacsPayDemBuyerPaymentAuthorityV1,
} from "../../src/payDemPayment.js";
import { openDacsNodeSqliteDatabase } from "../../src/sqlite.js";

const databasePath = process.env.DACS_PAY_DEM_CRASH_DATABASE;
const readyPath = process.env.DACS_PAY_DEM_CRASH_READY;
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

describe("native DEM payment crash fixture", () => {
  if (!databasePath || !readyPath) {
    it.skip("runs only as the isolated child of the process recovery test", () => undefined);
    return;
  }

  it("blocks after the prepared checkpoint until its process is killed", async () => {
    const database = await openDacsNodeSqliteDatabase({
      databasePath,
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      authority: BUYER,
    });
    putDacsLiveOrderInputV1({ database, order: ORDER, application: {} });
    const rail: PayDemRail = {
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
          recovery: input.recovery!,
        });
        await writeFile(readyPath, "prepared", {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        // A nested Vitest controller may terminate a worker whose only active
        // handle is a timer. Block the worker synchronously so the process group
        // can exit only when the parent deliberately sends SIGKILL.
        const lock = new Int32Array(new SharedArrayBuffer(4));
        while (true) Atomics.wait(lock, 0, 0, 1_000);
      },
    };
    const bootstrap = createFixedPricePayDemBuyerCoordinator({
      store: database.createPayDemCoordinatorStore("buyer"),
      workerId: "buyer-coordinator-bootstrap",
      operations: { agreement: success },
      leaseDurationMs: 5_000,
    });
    await bootstrap.startOrder(ORDER);
    await bootstrap.runPending({ limit: 1 });
    const bootstrapped = await bootstrap.getOrderStatus(JOB_ID);
    if (bootstrapped?.tracks.agreement?.state !== "final" ||
        bootstrapped.tracks.agreement.outcome !== "success") {
      throw new Error("crash fixture could not finalize its agreement prerequisite");
    }

    const payment = createDacsPayDemBuyerPaymentTrackV1({
      database,
      workerId: "buyer-payment-before-kill",
      rail,
      resolveAuthority: () => AUTHORITY,
      reconcile: () => ({ status: "indeterminate", reasonCode: "not-yet" }),
      publishNotice: () => undefined,
      effectLeaseDurationMs: 2_000,
      retryDelayMs: 1,
    });
    const coordinator = createFixedPricePayDemBuyerCoordinator({
      store: database.createPayDemCoordinatorStore("buyer"),
      workerId: "buyer-coordinator-before-kill",
      operations: { payment },
      leaseDurationMs: 2_000,
    });
    await coordinator.runPending({ limit: 1 });
    throw new Error("crash fixture returned without reaching its prepared checkpoint");
  }, 30_000);
});
