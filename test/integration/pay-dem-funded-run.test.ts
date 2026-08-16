import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PayDemIncludedNonceVisibilityError } from "../../src/rails/payDem.js";
import {
  executePayDemFundedRun,
  recordPayDemFundedRunOutcome,
  type PayDemFundedRunIntent,
} from "./pay-dem-funded-run.js";

const directories: string[] = [];
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<PayDemFundedRunIntent> {
  const directory = await mkdtemp(join(await realpath(repositoryRoot), ".paydem-marker-"));
  directories.push(directory);
  await chmod(directory, 0o700);
  return {
    directory,
    runId: "paydem-2026-08-16-a",
    payer: `0x${"11".repeat(32)}`,
    payee: `0x${"22".repeat(32)}`,
    amountOs: "1",
    maxTotalDebitOs: "1000000001",
    network: "demos",
  };
}

describe("pay-DEM funded-run adapter", () => {
  it("persists the transfer and maximum debit in the intent before invoking the effect", async () => {
    const input = await fixture();
    const effect = vi.fn(async () => "submitted");
    const { marker, result } = await executePayDemFundedRun(input, effect);

    expect(result).toBe("submitted");
    expect(effect).toHaveBeenCalledTimes(1);
    const intent = JSON.parse(await readFile(marker.markerPath, "utf8"));
    expect(intent.details).toMatchObject({
      amountOs: input.amountOs,
      maxTotalDebitOs: input.maxTotalDebitOs,
      network: "demos",
      payer: "11".repeat(32),
      payee: "22".repeat(32),
    });
  });

  it("rejects a ceiling below the transfer without arming or invoking the effect", async () => {
    const input = { ...(await fixture()), amountOs: "2", maxTotalDebitOs: "1" };
    const effect = vi.fn(async () => "must-not-run");

    await expect(executePayDemFundedRun(input, effect)).rejects.toThrow(
      /max-total-debit-below-amount/,
    );
    expect(effect).not.toHaveBeenCalled();
  });

  it("requires exact included reconciliation facts", async () => {
    const { marker } = await executePayDemFundedRun(await fixture(), async () => "ok");
    await expect(recordPayDemFundedRunOutcome(marker, {
      status: "included",
      txHash: "bad",
      blockNumber: 1,
    })).rejects.toThrow(/outcome-tx-hash-invalid/);
    await expect(recordPayDemFundedRunOutcome(marker, {
      status: "included",
      txHash: "ab".repeat(32),
      blockNumber: 9,
    })).resolves.toBeUndefined();
    const outcome = JSON.parse(await readFile(marker.outcomePath, "utf8"));
    expect(outcome).toMatchObject({
      state: "included",
      details: { txHash: "ab".repeat(32), blockNumber: 9 },
    });
  });

  it("persists the original included transaction when nonce visibility fails", async () => {
    let markerPath = "";
    let outcomePath = "";
    const catchUp = new PayDemIncludedNonceVisibilityError({
      txHash: "cd".repeat(32),
      blockNumber: 95563,
      nonce: 35,
      cause: new Error("nonce projection delayed"),
    });
    expect(catchUp.category).toBe("permanent");
    await expect(executePayDemFundedRun(await fixture(), async (marker) => {
      markerPath = marker.markerPath;
      outcomePath = marker.outcomePath;
      throw catchUp;
    })).rejects.toThrow(/effect-ambiguous-do-not-rerun/);

    expect(JSON.parse(await readFile(markerPath, "utf8"))).toMatchObject({
      state: "armed",
    });
    expect(JSON.parse(await readFile(outcomePath, "utf8"))).toMatchObject({
      state: "included",
      details: { txHash: "cd".repeat(32), blockNumber: 95563 },
    });
  });

  it("rejects proxies without invoking property traps", async () => {
    const input = await fixture();
    let reads = 0;
    const proxy = new Proxy(input, {
      get(target, property, receiver) {
        reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    await expect(executePayDemFundedRun(proxy, async () => "no"))
      .rejects.toThrow(/funded-intent-invalid/);
    expect(reads).toBe(0);
  });
});
