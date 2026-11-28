import { readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PayDemIncludedNonceVisibilityError } from "../../src/rails/payDem.js";
import {
  executePayDemFundedRun,
  readPayDemFundedPreparedTransfer,
  recordPayDemFundedRunOutcome,
  reopenPayDemFundedRun,
  type PayDemFundedPreparedTransfer,
  type PayDemFundedRunIntent,
} from "./pay-dem-funded-run.js";

// A confirmed native send read from node2: nine and a half DEM from PAYER to PAYEE,
// one DEM of gas on top, so the payer's real debit is 10,500,000,000 OS.
const node2 = JSON.parse(readFileSync(
  new URL("../fixtures/demos-node2-records.json", import.meta.url),
  "utf8",
)) as { getTxByHash: Record<string, { response: Record<string, any> }> };
const RECORD_HASH = "330dcf1dac0839ebc138d5e2a0db6db7b9567d769c8d4bd987b0d72d7d905918";
const RECORD_PAYER = "c0a58599ceaeba18f9c450133631cce4c45f4dc7a59c8026331504da3a913c2a";
const RECORD_PAYEE = "706b89f5e2d56498a90bc3a209842b0bd0e22ce06bb4df7c27805e655614e5f1";
const RECORD_BLOCK = 498_447;

function nodeRecord(change?: (record: Record<string, any>) => void): Record<string, any> {
  const record = structuredClone(node2.getTxByHash[RECORD_HASH]!.response);
  change?.(record);
  return record;
}

/** A funded run whose journalled transfer is the node2 record's send. */
async function journalledRun(maxTotalDebitOs = "10500000000") {
  const input: PayDemFundedRunIntent = {
    ...(await fixture()),
    payer: RECORD_PAYER,
    payee: RECORD_PAYEE,
    amountOs: "9500000000",
    maxTotalDebitOs,
  };
  const { marker } = await executePayDemFundedRun(input, async (_armed, journal) => {
    await journal(preparedTransfer(input, {
      txHash: RECORD_HASH,
      nonce: 28,
      confirmedTotalDebitOs: maxTotalDebitOs,
      confirmedRecordFeeOs: "1000000000",
    }));
  });
  return { input, marker };
}

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

function preparedTransfer(
  input: Readonly<PayDemFundedRunIntent>,
  overrides: Partial<PayDemFundedPreparedTransfer> = {},
): PayDemFundedPreparedTransfer {
  return {
    txHash: "ab".repeat(32),
    nonce: 35,
    payer: input.payer.replace(/^0x/i, "").toLowerCase(),
    payee: input.payee.replace(/^0x/i, "").toLowerCase(),
    amountOs: input.amountOs,
    denomination: "os",
    maxTotalDebitOs: input.maxTotalDebitOs,
    confirmedTotalDebitOs: input.maxTotalDebitOs,
    confirmedRecordFeeOs: "1000000000",
    network: "demos",
    ...overrides,
  };
}

describe("pay-DEM funded-run adapter", () => {
  it.each([
    { total: "1", fee: "0" },
    { total: "1000000001", fee: "2000000000" },
  ])("retains total debit $total and independent declared fee $fee", async ({ total, fee }) => {
    const input = await fixture();
    const prepared = Object.assign(preparedTransfer(input), {
      confirmedTotalDebitOs: total,
      confirmedRecordFeeOs: fee,
    });
    const { marker } = await executePayDemFundedRun(input, async (_armed, journal) => {
      await journal(prepared);
    });
    await expect(readPayDemFundedPreparedTransfer(marker)).resolves.toEqual(prepared);
  });

  it.each([
    { confirmedTotalDebitOs: "0" },
    { confirmedTotalDebitOs: "-1" },
    { confirmedTotalDebitOs: "01" },
    { confirmedTotalDebitOs: "1.5" },
    { confirmedTotalDebitOs: 1 },
    { confirmedTotalDebitOs: "1000000002" },
    { confirmedRecordFeeOs: "-1" },
    { confirmedRecordFeeOs: "01" },
    { confirmedRecordFeeOs: "1.5" },
    { confirmedRecordFeeOs: 0 },
    { unexpected: "field" },
  ])("rejects invalid prepared debit fields %j before submission", async (changes) => {
    const input = { ...(await fixture()), amountOs: "2" };
    const submitted = vi.fn();
    await expect(executePayDemFundedRun(input, async (_armed, journal) => {
      await journal(Object.assign(preparedTransfer(input), changes));
      submitted();
    })).rejects.toMatchObject({
      message: expect.stringMatching(/effect-ambiguous-do-not-rerun/),
      cause: expect.objectContaining({ message: "pay-dem-live:prepared-transfer-invalid" }),
    });
    expect(submitted).not.toHaveBeenCalled();
  });

  it("rejects a confirmed total below the transfer amount before submission", async () => {
    const input = { ...(await fixture()), amountOs: "2" };
    const submitted = vi.fn();
    await expect(executePayDemFundedRun(input, async (_armed, journal) => {
      await journal(Object.assign(preparedTransfer(input), { confirmedTotalDebitOs: "1" }));
      submitted();
    })).rejects.toThrow(/effect-ambiguous-do-not-rerun/);
    expect(submitted).not.toHaveBeenCalled();
  });

  it.each(["confirmedTotalDebitOs", "confirmedRecordFeeOs"])(
    "rejects a missing %s before submission",
    async (field) => {
      const input = await fixture();
      const prepared = preparedTransfer(input);
      Reflect.deleteProperty(prepared, field);
      const submitted = vi.fn();
      await expect(executePayDemFundedRun(input, async (_armed, journal) => {
        await journal(prepared);
        submitted();
      })).rejects.toThrow(/effect-ambiguous-do-not-rerun/);
      expect(submitted).not.toHaveBeenCalled();
    },
  );

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

  it("durably records canonical prepared facts before the simulated broadcast", async () => {
    const input = await fixture();
    const order: string[] = [];
    const { marker } = await executePayDemFundedRun(
      input,
      async (_marker, journalPreparedTransfer) => {
        await journalPreparedTransfer(preparedTransfer(input));
        order.push("journal-returned");
        order.push("broadcast");
        return "submitted";
      },
    );

    expect(order).toEqual(["journal-returned", "broadcast"]);
    await expect(readPayDemFundedPreparedTransfer(marker)).resolves.toEqual(
      preparedTransfer(input),
    );
  });

  it("fails closed after a journalled crash before broadcast and never retries that run", async () => {
    const input = await fixture();
    let submissions = 0;
    await expect(executePayDemFundedRun(
      input,
      async (_armed, journalPreparedTransfer) => {
        await journalPreparedTransfer(preparedTransfer(input));
        throw new Error("crash-before-broadcast");
      },
    )).rejects.toThrow(/effect-ambiguous-do-not-rerun/);

    const reopened = await reopenPayDemFundedRun(input);
    expect(reopened.prepared).toEqual(preparedTransfer(input));
    await expect(executePayDemFundedRun(input, async () => {
      submissions += 1;
      return "must-not-submit";
    })).rejects.toThrow(/run-already-armed/);
    expect(submissions).toBe(0);
  });

  it("recovers the same immutable facts after an ambiguous submission and never resubmits", async () => {
    const input = await fixture();
    let submissions = 0;
    await expect(executePayDemFundedRun(
      input,
      async (_armed, journalPreparedTransfer) => {
        await journalPreparedTransfer(preparedTransfer(input));
        submissions += 1;
        throw new Error("broadcast-response-lost");
      },
    )).rejects.toThrow(/effect-ambiguous-do-not-rerun/);

    const reopened = await reopenPayDemFundedRun(input);
    expect(reopened.prepared).toEqual(preparedTransfer(input));
    await expect(executePayDemFundedRun(input, async () => {
      submissions += 1;
      return "must-not-submit";
    })).rejects.toThrow(/run-already-armed/);
    expect(submissions).toBe(1);
  });

  it("rejects prepared facts that disagree with the funded intent before submission", async () => {
    const cases: Array<Partial<PayDemFundedPreparedTransfer>> = [
      { txHash: "malformed" },
      { nonce: -1 },
      { payer: "33".repeat(32) },
      { payee: "44".repeat(32) },
      { amountOs: "2" },
      { maxTotalDebitOs: "1000000002" },
    ];
    for (const [index, overrides] of cases.entries()) {
      const input = { ...(await fixture()), runId: `paydem-invalid-${index}` };
      let submissions = 0;
      await expect(executePayDemFundedRun(
        input,
        async (_marker, journalPreparedTransfer) => {
          await journalPreparedTransfer(preparedTransfer(input, overrides));
          submissions += 1;
        },
      )).rejects.toThrow(/effect-ambiguous-do-not-rerun/);
      expect(submissions).toBe(0);
    }
  });

  it("allows only one prepared checkpoint for a funded attempt", async () => {
    const input = await fixture();
    let submissions = 0;
    await expect(executePayDemFundedRun(
      input,
      async (_marker, journalPreparedTransfer) => {
        await journalPreparedTransfer(preparedTransfer(input));
        await journalPreparedTransfer(preparedTransfer(input));
        submissions += 1;
      },
    )).rejects.toThrow(/effect-ambiguous-do-not-rerun/);
    expect(submissions).toBe(0);
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
    const { marker } = await journalledRun();
    const readNodeRecord = vi.fn(async () => nodeRecord());
    await expect(recordPayDemFundedRunOutcome(marker, {
      status: "included",
      txHash: "bad",
      blockNumber: 1,
    }, readNodeRecord)).rejects.toThrow(/outcome-tx-hash-invalid/);
    expect(readNodeRecord).not.toHaveBeenCalled();
    await expect(recordPayDemFundedRunOutcome(marker, {
      status: "included",
      txHash: RECORD_HASH,
      blockNumber: RECORD_BLOCK,
    }, readNodeRecord)).resolves.toBeUndefined();
    expect(readNodeRecord).toHaveBeenCalledWith(RECORD_HASH);
    const outcome = JSON.parse(await readFile(marker.outcomePath, "utf8"));
    expect(outcome).toMatchObject({
      state: "included",
      details: { txHash: RECORD_HASH, blockNumber: RECORD_BLOCK },
    });
  });

  it.each([
    {
      name: "a record whose balance edits show no payer debit",
      change: (record: Record<string, any>) => {
        record.content.gcr_edits = record.content.gcr_edits
          .filter((edit: Record<string, any>) => edit.account !== `0x${RECORD_PAYER}` ||
            edit.type === "nonce");
      },
      block: RECORD_BLOCK,
    },
    {
      name: "a record for another block",
      change: () => undefined,
      block: RECORD_BLOCK + 1,
    },
    {
      name: "a record that is not confirmed",
      change: (record: Record<string, any>) => { record.status = "failed"; },
      block: RECORD_BLOCK,
    },
  ])("does not record included for $name", async ({ change, block }) => {
    const { marker } = await journalledRun();
    await expect(recordPayDemFundedRunOutcome(marker, {
      status: "included",
      txHash: RECORD_HASH,
      blockNumber: block,
    }, async () => nodeRecord(change))).rejects.toThrow(/included-node-debit-missing/);
    await expect(readFile(marker.outcomePath, "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("does not record included when the node debit is above the authorised maximum", async () => {
    const { marker } = await journalledRun("10499999999");
    await expect(recordPayDemFundedRunOutcome(marker, {
      status: "included",
      txHash: RECORD_HASH,
      blockNumber: RECORD_BLOCK,
    }, async () => nodeRecord())).rejects.toThrow(/included-node-debit-missing/);
    await expect(readFile(marker.outcomePath, "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("does not record included for a hash other than the journalled transfer", async () => {
    const { marker } = await journalledRun();
    const readNodeRecord = vi.fn(async () => nodeRecord());
    await expect(recordPayDemFundedRunOutcome(marker, {
      status: "included",
      txHash: "ab".repeat(32),
      blockNumber: RECORD_BLOCK,
    }, readNodeRecord)).rejects.toThrow(/included-tx-hash-mismatch/);
    expect(readNodeRecord).not.toHaveBeenCalled();
  });

  it("does not record included when the node record cannot be read", async () => {
    const { marker } = await journalledRun();
    await expect(recordPayDemFundedRunOutcome(marker, {
      status: "included",
      txHash: RECORD_HASH,
      blockNumber: RECORD_BLOCK,
    }, async () => { throw new Error("node unreachable"); })).rejects.toThrow(/node unreachable/);
    await expect(readFile(marker.outcomePath, "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("persists the original included transaction when nonce visibility fails", async () => {
    const input: PayDemFundedRunIntent = {
      ...(await fixture()),
      payer: RECORD_PAYER,
      payee: RECORD_PAYEE,
      amountOs: "9500000000",
      maxTotalDebitOs: "10500000000",
    };
    let markerPath = "";
    let outcomePath = "";
    const catchUp = new PayDemIncludedNonceVisibilityError({
      txHash: RECORD_HASH,
      blockNumber: RECORD_BLOCK,
      nonce: 28,
      cause: new Error("nonce projection delayed"),
    });
    expect(catchUp.category).toBe("permanent");
    await expect(executePayDemFundedRun(input, async (marker, journal) => {
      markerPath = marker.markerPath;
      outcomePath = marker.outcomePath;
      await journal(preparedTransfer(input, {
        txHash: RECORD_HASH,
        nonce: 28,
        confirmedTotalDebitOs: "10500000000",
        confirmedRecordFeeOs: "1000000000",
      }));
      throw catchUp;
    }, async () => nodeRecord())).rejects.toThrow(/effect-ambiguous-do-not-rerun/);

    expect(JSON.parse(await readFile(markerPath, "utf8"))).toMatchObject({
      state: "armed",
    });
    expect(JSON.parse(await readFile(outcomePath, "utf8"))).toMatchObject({
      state: "included",
      details: { txHash: RECORD_HASH, blockNumber: RECORD_BLOCK },
    });
  });

  it("keeps a nonce-visibility transfer unresolved when no node debit can be read", async () => {
    let outcomePath = "";
    const catchUp = new PayDemIncludedNonceVisibilityError({
      txHash: "cd".repeat(32),
      blockNumber: 95563,
      nonce: 35,
    });
    await expect(executePayDemFundedRun(await fixture(), async (marker) => {
      outcomePath = marker.outcomePath;
      throw catchUp;
    })).rejects.toThrow(/effect-ambiguous-do-not-rerun/);
    expect(JSON.parse(await readFile(outcomePath, "utf8"))).toMatchObject({
      state: "unresolved",
      details: { reason: "inclusion-not-observed", txHash: "cd".repeat(32) },
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
