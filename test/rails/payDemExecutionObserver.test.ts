import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { observeDemosExecutionByHash } from "../../src/rails/payDem.js";

const WALLET = `0x${"ab".repeat(32)}`;
const PAYEE_HEX = "cd".repeat(32);
const RECIPIENT = `0x${PAYEE_HEX}`;
const TX_HASH = "85".repeat(32);
const NONCE = 9;
const BLOCK = 480_877;
const AMOUNT_OS = "9500000000";

interface BroadcastTransaction {
  hash: string;
  content: {
    from: string;
    to: string;
    amount: string | number;
    nonce: number | string;
    data: [string, { nativeOperation: string; args: [string, string] }];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface TransactionRecord extends BroadcastTransaction {
  status: string;
  blockNumber: unknown;
}

const FAST = {
  inclusionPollIntervalMs: 1,
  statusRequestTimeoutMs: 5,
  transactionRecordTimeoutMs: 30,
};

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000); });
afterEach(() => { vi.useRealTimers(); });

async function advanceObservation<T>(pending: Promise<T>, budgetMs = FAST.transactionRecordTimeoutMs): Promise<T> {
  await vi.advanceTimersByTimeAsync(budgetMs);
  return pending;
}

describe("the execution observer tells failed from indeterminate (#338)", () => {
  // `settle()` maps both outcomes to the same not-ok result, so this asserts
  // the observer's own state and reason.
  const expected = {
    blockNumber: BLOCK,
    transfer: {
      payer: WALLET,
      payee: RECIPIENT,
      amountOs: BigInt(AMOUNT_OS),
      nonce: NONCE,
      postFork: true,
    },
  };

  /** An executed record in the node's projection (see `broadcastRecord`). */
  function executedRecord(): TransactionRecord {
    return {
      hash: TX_HASH,
      status: "confirmed",
      blockNumber: BLOCK,
      content: {
        type: "native",
        from: WALLET,
        from_ed25519_address: WALLET,
        to: RECIPIENT,
        amount: Number(AMOUNT_OS),
        nonce: String(NONCE),
        data: [
          "native",
          { nativeOperation: "send", args: [PAYEE_HEX, AMOUNT_OS] },
        ],
      },
      attrs: { reference_block: BLOCK - 1 },
    };
  }

  function observe(read: (hash: string) => Promise<unknown>, budgetMs = 1_000) {
    return advanceObservation(observeDemosExecutionByHash(TX_HASH, read, expected, {
      ...FAST,
      transactionRecordTimeoutMs: budgetMs,
    }), budgetMs);
  }

  it("reports an executed record that matches the prepared transfer", async () => {
    const read = vi.fn(async () => executedRecord());

    await expect(observe(read)).resolves.toEqual({ state: "executed" });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(TX_HASH);
  });

  it("reports a failed record as failed", async () => {
    const read = vi.fn(async () => ({ ...executedRecord(), status: "failed" }));

    await expect(observe(read)).resolves.toEqual({ state: "failed" });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a stalled read", "transaction record read timed out",
      () => new Promise<never>(() => undefined)],
    ["a mismatched amount", "transaction record does not match the prepared transfer",
      async () => {
        const record = executedRecord();
        record.content.amount = 1;
        record.content.data[1].args[1] = "1";
        return record;
      }],
    ["a mismatched nonce", "transaction record does not bind the signed nonce",
      async () => {
        const record = executedRecord();
        record.content.nonce = String(NONCE + 1);
        return record;
      }],
    ["another inclusion block",
      "transaction record block does not match the observed inclusion",
      async () => ({ ...executedRecord(), blockNumber: BLOCK + 1 })],
    // A failed status is only a statement about this transfer when the record
    // binds it; otherwise it is malformed.
    ["a failed record without a nonce",
      "transaction record does not bind the signed nonce",
      async () => {
        const record: Record<string, unknown> = {
          ...executedRecord(),
          status: "failed",
        };
        delete (record.content as Record<string, unknown>).nonce;
        return record;
      }],
    ["a failed record with another nonce",
      "transaction record does not bind the signed nonce",
      async () => {
        const record = { ...executedRecord(), status: "failed" };
        record.content.nonce = String(NONCE + 1);
        return record;
      }],
    ["a failed record without a body",
      "transaction record does not bind the signed nonce",
      async () => {
        const record: Record<string, unknown> = {
          ...executedRecord(),
          status: "failed",
        };
        delete record.content;
        return record;
      }],
    ["a failed record for another amount",
      "transaction record does not match the prepared transfer",
      async () => {
        const record = { ...executedRecord(), status: "failed" };
        record.content.amount = 1;
        record.content.data[1].args[1] = "1";
        return record;
      }],
    ["a failed record at another block",
      "transaction record block does not match the observed inclusion",
      async () => ({ ...executedRecord(), status: "failed", blockNumber: BLOCK + 1 })],
  ])("is indeterminate at once for %s", async (_case, reason, read) => {
    const spy = vi.fn(read);

    await expect(observe(spy)).resolves.toEqual({ state: "indeterminate", reason });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a malformed record", "transaction record is missing or malformed",
      async () => "Transaction not found"],
    ["a pending record", "transaction record has no terminal execution status",
      async () => ({ ...executedRecord(), status: "pending" })],
    ["a rejected read", "transaction record read failed",
      async () => {
        throw new Error("socket hang up");
      }],
  ])("is indeterminate when the budget ends with %s", async (_case, reason, read) => {
    const spy = vi.fn(read);

    await expect(observe(spy, FAST.transactionRecordTimeoutMs)).resolves.toMatchObject({
      state: "indeterminate",
      reason,
    });
    expect(spy.mock.calls.length).toBeGreaterThan(1);
  });


  it.each(["confirmed", "failed"])("polls a terminal %s record with another hash until a matching record arrives", async (status) => {
    const read = vi.fn()
      .mockResolvedValueOnce({ ...executedRecord(), hash: "86".repeat(32), status })
      .mockResolvedValueOnce(executedRecord());
    await expect(observe(read)).resolves.toEqual({ state: "executed" });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["large string", "x".repeat(100_000)],
    ["long array", Array.from({ length: 257 }, () => "entry")],
    ["wide object", Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`field${i}`, 1]))],
    ["deep tree", Array.from({ length: 17 }).reduce<unknown>((child) => ({ child }), null)],
    ["many nodes", Array.from({ length: 16 }, () => Array.from({ length: 256 }, () => 1))],
    ["total bytes", Array.from({ length: 128 }, () => "x".repeat(600))],
  ])("refuses a record with %s before canonicalization", async (_case, extra) => {
    const read = vi.fn(async () => ({ ...executedRecord(), extra }));
    await expect(observe(read)).resolves.toMatchObject({
      state: "indeterminate", reason: "transaction record exceeds observation limits",
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each(["ETIMEDOUT", "ECONNREFUSED"])("retains the %s transport cause", async (code) => {
    const cause = Object.assign(new Error(code), { code });
    const outcome = await observe(async () => { throw cause; }, FAST.transactionRecordTimeoutMs);
    expect(outcome).toMatchObject({ state: "indeterminate", reason: "transaction record read failed", cause });
    if (outcome.state !== "indeterminate") throw new Error("expected indeterminate");
    expect(outcome.cause).toBe(cause);
  });

  it("waits the poll interval between record reads", async () => {
    const read = vi.fn(async () => null);

    const pending = observeDemosExecutionByHash(TX_HASH, read, expected, {
      ...FAST,
      inclusionPollIntervalMs: 10,
      transactionRecordTimeoutMs: 50,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(40);
    await expect(pending).resolves.toEqual({
      state: "indeterminate",
      reason: "transaction record is missing or malformed",
    });
    expect(read).toHaveBeenCalledTimes(5);
  });
});

describe("the execution observer reads recorded node2 records (#338)", () => {
  // Raw `getTxByHash` envelopes read from node2 (kynesyslabs/node
  // stabilisation@61b8e75). demosdk's `getTxByHash` resolves the envelope's
  // `response` member, so that is what the observer is given.
  const node2 = JSON.parse(readFileSync(
    new URL("../fixtures/demos-node2-records.json", import.meta.url),
    "utf8",
  )) as { getTxByHash: Record<string, { response: Record<string, unknown> }> };
  const PAYER = "0xc0a58599ceaeba18f9c450133631cce4c45f4dc7a59c8026331504da3a913c2a";
  const PAYEE = "0x706b89f5e2d56498a90bc3a209842b0bd0e22ce06bb4df7c27805e655614e5f1";
  const CONFIRMED_HASH = "330dcf1dac0839ebc138d5e2a0db6db7b9567d769c8d4bd987b0d72d7d905918";
  const FAILED_HASH = "85b8fcdcee48822742a39e1b9877f5e2f8dde36430e8e486e3a8b0c9a7744cbd";

  function served(hash: string) {
    return vi.fn(async () => structuredClone(node2.getTxByHash[hash]!.response));
  }

  function transfer(nonce: number) {
    return {
      payer: PAYER,
      payee: PAYEE,
      amountOs: 9_500_000_000n,
      nonce,
      postFork: true,
    };
  }

  it("serves the nonce as a decimal string", () => {
    for (const envelope of Object.values(node2.getTxByHash)) {
      expect(typeof (envelope.response.content as { nonce: unknown }).nonce)
        .toBe("string");
    }
  });

  it("reports node2's confirmed native send as executed", async () => {
    const read = served(CONFIRMED_HASH);

    await expect(advanceObservation(observeDemosExecutionByHash(
      CONFIRMED_HASH,
      read,
      { blockNumber: 498_447, transfer: transfer(28) },
      FAST,
    ))).resolves.toEqual({ state: "executed" });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(CONFIRMED_HASH);
  });

  it("reports node2's TX_NONCE_INVALID_LOW record as failed", async () => {
    const read = served(FAILED_HASH);

    await expect(advanceObservation(observeDemosExecutionByHash(
      FAILED_HASH,
      read,
      { blockNumber: 480_877, transfer: transfer(9) },
      FAST,
    ))).resolves.toEqual({ state: "failed" });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["another nonce", CONFIRMED_HASH, 498_447, 29,
      "transaction record does not bind the signed nonce"],
    ["another inclusion block", CONFIRMED_HASH, 498_448, 28,
      "transaction record block does not match the observed inclusion"],
    ["a failed record under another nonce", FAILED_HASH, 480_877, 10,
      "transaction record does not bind the signed nonce"],
  ])("is indeterminate for a recorded record with %s", async (
    _case,
    hash,
    blockNumber,
    nonce,
    reason,
  ) => {
    await expect(advanceObservation(observeDemosExecutionByHash(
      hash,
      served(hash),
      { blockNumber, transfer: transfer(nonce) },
      FAST,
    ))).resolves.toEqual({ state: "indeterminate", reason });
  });

  it.each([
    // node2 (61b8e75) serves not-found as {result: 400, response: "error"};
    // stabilisation HEAD (52e2e569) serves {result: 404, response: null}.
    ["node2's not-found response", "error"],
    ["stabilisation HEAD's not-found response", null],
  ])("polls %s until the budget ends", async (_case, response) => {
    const read = vi.fn(async () => response);

    await expect(advanceObservation(observeDemosExecutionByHash(
      CONFIRMED_HASH,
      read,
      { blockNumber: 498_447, transfer: transfer(28) },
      FAST,
    ))).resolves.toEqual({
      state: "indeterminate",
      reason: "transaction record is missing or malformed",
    });
    expect(read.mock.calls.length).toBeGreaterThan(1);
  });
});
