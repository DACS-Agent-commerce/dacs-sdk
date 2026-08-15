import { describe, expect, it } from "vitest";

import {
  createPayDemRail,
  createPayDemSellerObserver,
} from "../../src/index.js";
import { DemosAdapter } from "../../src/substrate/index.js";

/**
 * Guarded funded proof for the native DACS-4 §9.5.9 boundary.
 *
 * This test performs exactly one buyer-to-seller native transfer. It remains
 * skipped unless two independent wallets, their expected DIDs, an explicit OS
 * amount, and LIVE_PAY_DEM_CONFIRM=1 are all supplied. CI never supplies that
 * confirmation and therefore cannot spend funds.
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

const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
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
  if (missing.length > 0 || process.env.LIVE_PAY_DEM_CONFIRM !== "1") {
    it.skip(
      `requires ${missing.length > 0 ? missing.join(", ") : "LIVE_PAY_DEM_CONFIRM=1"}`,
      () => undefined,
    );
    return;
  }

  it("transfers once and resolves the same confirmed facts at the seller", async () => {
    const rpc = process.env.DEMOS_RPC!;
    const buyer = new DemosAdapter({ rpc, secret: process.env.BUYER_WALLET! });
    const seller = new DemosAdapter({ rpc, secret: process.env.SELLER_WALLET! });
    await Promise.all([buyer.connect(), seller.connect()]);

    const buyerAddress = buyer.getAddress();
    const sellerAddress = seller.getAddress();
    requireCondition(buyerAddress !== sellerAddress, "wallets-must-be-independent");
    requireCondition(
      didForAddress(buyerAddress) === process.env.BUYER_DID!.toLowerCase(),
      "buyer-wallet-did-mismatch",
    );
    requireCondition(
      didForAddress(sellerAddress) === process.env.SELLER_DID!.toLowerCase(),
      "seller-wallet-did-mismatch",
    );

    const amountText = process.env.PAY_DEM_AMOUNT_OS!;
    requireCondition(/^[1-9][0-9]*$/.test(amountText), "amount-not-canonical-os");
    const amountOs = BigInt(amountText);
    requireCondition(amountOs <= MAX_TEST_TRANSFER_OS, "amount-exceeds-test-cap");
    const maxTotalDebitText = process.env.PAY_DEM_MAX_TOTAL_DEBIT_OS!;
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

    // Explicit confirmation is checked immediately before the only write.
    requireCondition(process.env.LIVE_PAY_DEM_CONFIRM === "1", "spend-not-confirmed");
    const rail = await createPayDemRail({
      rpc,
      secret: process.env.BUYER_WALLET!,
      network: "demos",
      maxTotalDebitOs,
    });
    const settlement = await rail.settle({
      recipient: sellerAddress,
      amount: amountText,
      network: "demos",
    });
    requireCondition(settlement.ok, "transfer-not-included");
    requireCondition(!!settlement.txHash, "transfer-hash-missing");

    const observer = createPayDemSellerObserver({ rpc });
    const first = await observer.observeDemosTransfer(settlement.txHash!);
    expect(first).toMatchObject({
      status: "included",
      payer: buyerAddress.replace(/^0x/i, "").toLowerCase(),
      payee: sellerAddress.replace(/^0x/i, "").toLowerCase(),
      amountOs: amountText,
      blockNumber: settlement.blockNumber,
    });

    // Observation is read-only and replay-stable; it never resubmits payment.
    await expect(
      observer.observeDemosTransfer(settlement.txHash!),
    ).resolves.toEqual(first);
  }, 180_000);
});
