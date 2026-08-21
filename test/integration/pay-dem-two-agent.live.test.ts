import { describe, expect, it } from "vitest";

import {
  createPayDemRail,
  createPayDemSellerObserver,
} from "../../src/index.js";
import { DemosAdapter } from "../../src/substrate/index.js";
import {
  executePayDemFundedRun,
  recordPayDemFundedRunOutcome,
} from "./pay-dem-funded-run.js";

/**
 * Guarded funded proof for the native DACS-4 §9.5.9 boundary.
 *
 * This test performs exactly one buyer-to-seller native transfer. It remains
 * skipped unless two independent wallets, their expected DIDs, an explicit OS
 * amount and total-debit ceiling, a fresh run id, a durable private marker
 * directory, and LIVE_PAY_DEM_CONFIRM=1 are all supplied. CI never supplies
 * that confirmation and therefore cannot spend funds.
 */
const REQUIRED_ENV = [
  "DEMOS_RPC",
  "BUYER_WALLET",
  "BUYER_DID",
  "SELLER_WALLET",
  "SELLER_DID",
  "PAY_DEM_AMOUNT_OS",
  "PAY_DEM_MAX_TOTAL_DEBIT_OS",
  "LIVE_PAY_DEM_RUN_ID",
  "LIVE_PAY_DEM_MARKER_DIR",
  "LIVE_PAY_DEM_CONFIRM",
] as const;

type RequiredEnvKey = typeof REQUIRED_ENV[number];
const LIVE_ENV = Object.freeze(REQUIRED_ENV.reduce<Record<
  RequiredEnvKey,
  string | undefined
>>((snapshot, key) => {
  snapshot[key] = process.env[key];
  return snapshot;
}, {} as Record<RequiredEnvKey, string | undefined>));
const missing = REQUIRED_ENV.filter((key) => !LIVE_ENV[key]);
const MAX_TEST_TRANSFER_OS = 1_000_000_000n;
const MAX_TEST_TOTAL_DEBIT_OS = 3_000_000_000n;

function requireCondition(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(`pay-dem-live:${code}`);
}

function didForAddress(address: string): string {
  return `did:demos:agent:${address.replace(/^0x/i, "")}`.toLowerCase();
}

async function balanceOs(adapter: DemosAdapter): Promise<bigint> {
  const network = await adapter.raw.getNetworkInfo();
  requireCondition(
    network?.forks?.osDenomination?.activated === true,
    "os-denomination-fork-not-active",
  );
  const account = await adapter.raw.getAddressInfo(adapter.getAddress());
  requireCondition(account && typeof account.balance === "bigint", "balance-unavailable");
  // After the denomination fork the raw node balance is already OS. Never
  // display or compare it as DEM (1 DEM = 1,000,000,000 OS).
  return account.balance;
}

describe("guarded funded two-agent pay-DEM settlement", () => {
  if (missing.length > 0 || LIVE_ENV.LIVE_PAY_DEM_CONFIRM !== "1") {
    it.skip(
      `requires ${missing.length > 0 ? missing.join(", ") : "LIVE_PAY_DEM_CONFIRM=1"}`,
      () => undefined,
    );
    return;
  }

  it("transfers once and resolves the same confirmed facts at the seller", async () => {
    const rpc = LIVE_ENV.DEMOS_RPC!;
    const buyerSecret = LIVE_ENV.BUYER_WALLET!;
    const sellerSecret = LIVE_ENV.SELLER_WALLET!;
    const buyer = new DemosAdapter({ rpc, secret: buyerSecret });
    const seller = new DemosAdapter({ rpc, secret: sellerSecret });
    await Promise.all([buyer.connect(), seller.connect()]);

    const buyerAddress = buyer.getAddress();
    const sellerAddress = seller.getAddress();
    requireCondition(buyerAddress !== sellerAddress, "wallets-must-be-independent");
    requireCondition(
      didForAddress(buyerAddress) === LIVE_ENV.BUYER_DID!.toLowerCase(),
      "buyer-wallet-did-mismatch",
    );
    requireCondition(
      didForAddress(sellerAddress) === LIVE_ENV.SELLER_DID!.toLowerCase(),
      "seller-wallet-did-mismatch",
    );

    const amountText = LIVE_ENV.PAY_DEM_AMOUNT_OS!;
    requireCondition(/^[1-9][0-9]*$/.test(amountText), "amount-not-canonical-os");
    const amountOs = BigInt(amountText);
    requireCondition(amountOs <= MAX_TEST_TRANSFER_OS, "amount-exceeds-test-cap");
    const maxTotalDebitText = LIVE_ENV.PAY_DEM_MAX_TOTAL_DEBIT_OS!;
    requireCondition(
      /^(?:0|[1-9][0-9]*)$/.test(maxTotalDebitText),
      "max-total-debit-not-canonical-os",
    );
    const maxTotalDebitOs = BigInt(maxTotalDebitText);
    requireCondition(maxTotalDebitOs >= amountOs, "max-total-debit-below-amount");
    requireCondition(
      maxTotalDebitOs <= MAX_TEST_TOTAL_DEBIT_OS,
      "max-total-debit-exceeds-test-cap",
    );
    const buyerBalance = await balanceOs(buyer);
    requireCondition(
      buyerBalance >= maxTotalDebitOs,
      "buyer-balance-below-max-total-debit",
    );

    // Explicit confirmation and the durable one-shot marker are checked and
    // armed before constructing the write-capable rail. The rail's preparation
    // hook then fsyncs the canonical signed hash, nonce and immutable transfer
    // facts immediately before its only broadcast. Neither record is removed,
    // including when settlement is ambiguous.
    requireCondition(LIVE_ENV.LIVE_PAY_DEM_CONFIRM === "1", "spend-not-confirmed");
    const { marker, result: settlement } = await executePayDemFundedRun(
      {
        directory: LIVE_ENV.LIVE_PAY_DEM_MARKER_DIR!,
        runId: LIVE_ENV.LIVE_PAY_DEM_RUN_ID!,
        payer: buyerAddress,
        payee: sellerAddress,
        amountOs: amountText,
        maxTotalDebitOs: maxTotalDebitText,
        network: "demos",
      },
      async (_marker, journalPreparedTransfer) => {
        const rail = await createPayDemRail({
          rpc,
          secret: buyerSecret,
          network: "demos",
          maxTotalDebitOs,
          journalPreparedTransfer,
        });
        requireCondition(
          rail.address.replace(/^0x/i, "").toLowerCase() ===
            buyerAddress.replace(/^0x/i, "").toLowerCase(),
          "rail-payer-mismatch",
        );
        return rail.settle({
          recipient: sellerAddress,
          amount: amountText,
          network: "demos",
        });
      },
    );

    // `ok:false` means only that inclusion was not observed. A hash-first
    // observation timeout can still hide an included transfer, so preserve the
    // signed hash for read-only reconciliation and never claim payment did not land.
    if (!settlement.ok || !settlement.txHash || settlement.blockNumber === undefined) {
      await recordPayDemFundedRunOutcome(marker, {
        status: "unresolved",
        reason: "inclusion-not-observed",
        ...(settlement.txHash ? { txHash: settlement.txHash } : {}),
      });
      throw new Error(
        `pay-dem-live:settlement-unresolved-do-not-rerun:${marker.markerId}`,
      );
    }
    await recordPayDemFundedRunOutcome(marker, {
      status: "included",
      txHash: settlement.txHash,
      blockNumber: settlement.blockNumber,
    });

    const observer = createPayDemSellerObserver({ rpc });
    const first = await observer.observeDemosTransfer(settlement.txHash);
    expect(first).toMatchObject({
      status: "included",
      payer: buyerAddress.replace(/^0x/i, "").toLowerCase(),
      payee: sellerAddress.replace(/^0x/i, "").toLowerCase(),
      amountOs: amountText,
      blockNumber: settlement.blockNumber,
    });

    // Observation is read-only and replay-stable; it never resubmits payment.
    await expect(
      observer.observeDemosTransfer(settlement.txHash),
    ).resolves.toEqual(first);
  }, 180_000);
});
