import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  armX402FundedRun,
  recordX402FundedRunOutcome,
  X402_FUNDED_BASE_SEPOLIA_USDC,
  type X402FundedRunIntent,
  type X402FundedRunOutcome,
} from "./x402-funded-run.js";

const directories: string[] = [];
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<X402FundedRunIntent> {
  const directory = await mkdtemp(join(await realpath(repositoryRoot), ".x402-marker-"));
  directories.push(directory);
  await chmod(directory, 0o700);
  return {
    directory,
    runId: "x402-2026-08-16-a",
    jobId: "01K2D6Y7W8Q9R0S1T2V3W4X5Y6",
    network: "eip155:84532",
    paymentPhaseIndex: 2,
    authorizationNonce: `0x${"66".repeat(32)}`,
    payer: `0x${"11".repeat(20)}`,
    payee: `0x${"22".repeat(20)}`,
    asset: X402_FUNDED_BASE_SEPOLIA_USDC,
    buyerDemosAddress: `0x${"44".repeat(32)}`,
    sellerDemosAddress: `0x${"55".repeat(32)}`,
    amountBaseUnits: "1",
    maxTotalDebitBaseUnits: "1",
  };
}

function includedOutcome(
  overrides: Partial<X402FundedRunOutcome> = {},
): X402FundedRunOutcome {
  return {
    status: "included",
    jobId: "01K2D6Y7W8Q9R0S1T2V3W4X5Y6",
    network: "eip155:84532",
    paymentPhaseIndex: 2,
    authorizationNonce: `0x${"66".repeat(32)}`,
    chainId: 84_532,
    transactionHash: `0x${"ab".repeat(32)}`,
    logIndex: 7,
    blockNumber: 12_345,
    blockHash: `0x${"cd".repeat(32)}`,
    payer: `0x${"11".repeat(20)}`,
    payee: `0x${"22".repeat(20)}`,
    asset: X402_FUNDED_BASE_SEPOLIA_USDC,
    assetSymbol: "USDC",
    assetDecimals: 6,
    amountBaseUnits: "1",
    totalDebitBaseUnits: "1",
    confirmations: 3,
    includedAt: 1_750_000_000_000,
    finalityObservedAt: 1_750_000_001_000,
    ...overrides,
  };
}

describe("x402 funded-run adapter", () => {
  it("persists the exact payment and total-debit ceiling before any live write", async () => {
    const input = await fixture();
    const marker = await armX402FundedRun(input);
    const intent = JSON.parse(await readFile(marker.markerPath, "utf8"));
    expect(intent.details).toEqual({
      amountBaseUnits: "1",
      asset: X402_FUNDED_BASE_SEPOLIA_USDC.toLowerCase(),
      authorizationNonce: `0x${"66".repeat(32)}`,
      buyerDemosAddress: "44".repeat(32),
      jobId: "01K2D6Y7W8Q9R0S1T2V3W4X5Y6",
      maxTotalDebitBaseUnits: "1",
      network: "eip155:84532",
      paymentPhaseIndex: 2,
      payee: `0x${"22".repeat(20)}`,
      payer: `0x${"11".repeat(20)}`,
      sellerDemosAddress: "55".repeat(32),
    });
  });

  it("rejects every non-canonical Base Sepolia token before arming", async () => {
    const input = {
      ...(await fixture()),
      asset: `0x${"33".repeat(20)}`,
    };
    await expect(armX402FundedRun(input)).rejects.toThrow(
      /x402-asset-not-canonical-usdc/,
    );
  });

  it("rejects a cap below the payment without arming a marker", async () => {
    const input = { ...(await fixture()), amountBaseUnits: "2" };
    await expect(armX402FundedRun(input)).rejects.toThrow(
      /max-total-debit-below-amount/,
    );
  });

  it("rejects proxies and accessors without invoking their property traps", async () => {
    const input = await fixture();
    let reads = 0;
    const proxy = new Proxy(input, {
      get(target, property, receiver) {
        reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    await expect(armX402FundedRun(proxy)).rejects.toThrow(/x402-intent-invalid/);
    expect(reads).toBe(0);

    const accessor = { ...input } as Record<string, unknown>;
    delete accessor.amountBaseUnits;
    Object.defineProperty(accessor, "amountBaseUnits", {
      enumerable: true,
      get: vi.fn(() => "1"),
    });
    await expect(armX402FundedRun(
      accessor as unknown as X402FundedRunIntent,
    )).rejects.toThrow(/x402-intent-invalid/);
    expect(Object.getOwnPropertyDescriptor(accessor, "amountBaseUnits")?.get)
      .not.toHaveBeenCalled();
  });

  it("records the full exact included observation bound to the armed intent", async () => {
    const marker = await armX402FundedRun(await fixture());
    await expect(recordX402FundedRunOutcome(marker, includedOutcome({
      transactionHash: "bad",
    }))).rejects.toThrow(/transaction-hash-invalid/);
    await expect(recordX402FundedRunOutcome(marker, includedOutcome()))
      .resolves.toBeUndefined();
    expect(JSON.parse(await readFile(marker.outcomePath, "utf8"))).toMatchObject({
      state: "included",
      details: {
        amountBaseUnits: "1",
        asset: X402_FUNDED_BASE_SEPOLIA_USDC.toLowerCase(),
        assetDecimals: 6,
        assetSymbol: "USDC",
        authorizationNonce: `0x${"66".repeat(32)}`,
        blockHash: `0x${"cd".repeat(32)}`,
        blockNumber: 12_345,
        chainId: 84_532,
        confirmations: 3,
        finalityObservedAt: 1_750_000_001_000,
        includedAt: 1_750_000_000_000,
        jobId: "01K2D6Y7W8Q9R0S1T2V3W4X5Y6",
        logIndex: 7,
        network: "eip155:84532",
        payee: `0x${"22".repeat(20)}`,
        payer: `0x${"11".repeat(20)}`,
        paymentPhaseIndex: 2,
        totalDebitBaseUnits: "1",
        transactionHash: `0x${"ab".repeat(32)}`,
      },
    });
  });

  it("rejects observation rebinding and total debit above the authenticated cap", async () => {
    const marker = await armX402FundedRun(await fixture());
    await expect(recordX402FundedRunOutcome(marker, includedOutcome({
      payer: `0x${"99".repeat(20)}`,
    }))).rejects.toThrow(/x402-outcome-intent-mismatch/);
    await expect(recordX402FundedRunOutcome(marker, includedOutcome({
      totalDebitBaseUnits: "2",
    }))).rejects.toThrow(/x402-outcome-total-debit-exceeds-cap/);
    await expect(readFile(marker.outcomePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects proxy and accessor outcomes without reading caller traps", async () => {
    const marker = await armX402FundedRun(await fixture());
    const value = includedOutcome();
    let reads = 0;
    const proxy = new Proxy(value, {
      get(target, property, receiver) {
        reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    await expect(recordX402FundedRunOutcome(marker, proxy)).rejects.toThrow(
      /x402-outcome-invalid/,
    );
    expect(reads).toBe(0);

    const accessor = { ...value } as Record<string, unknown>;
    delete accessor.totalDebitBaseUnits;
    Object.defineProperty(accessor, "totalDebitBaseUnits", {
      enumerable: true,
      get: vi.fn(() => "1"),
    });
    await expect(recordX402FundedRunOutcome(
      marker,
      accessor as unknown as X402FundedRunOutcome,
    )).rejects.toThrow(/x402-outcome-invalid/);
    expect(Object.getOwnPropertyDescriptor(accessor, "totalDebitBaseUnits")?.get)
      .not.toHaveBeenCalled();
  });
});
