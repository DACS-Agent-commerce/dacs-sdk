import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { DEMOS_TRANSACTION_RECORD_MAX_BYTES, readDemosTransactionRecord } from "../../src/rails/demosRpc.js";

const RPC = "https://node.test";
const HASH = "ab".repeat(32);
const TIMEOUT_MS = 10;

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000); });
afterEach(() => vi.useRealTimers());

it("sends one read-only record request and clears its deadline on success", async () => {
  const record = { hash: HASH, status: "confirmed" };
  const fetchRecord = vi.fn<typeof fetch>(async () =>
    new Response(JSON.stringify({ result: 200, response: record })));
  await expect(readDemosTransactionRecord(RPC, HASH, TIMEOUT_MS, fetchRecord)).resolves.toEqual(record);
  expect(fetchRecord).toHaveBeenCalledExactlyOnceWith(RPC, expect.objectContaining({
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "nodeCall", params: [{ message: "getTxByHash", data: { hash: HASH } }] }),
  }));
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels a declared oversized body before acquiring its reader", async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }), {
    headers: { "content-length": String(DEMOS_TRANSACTION_RECORD_MAX_BYTES + 1) },
  });
  const fetchRecord = vi.fn<typeof fetch>(async () => response);
  await expect(readDemosTransactionRecord(RPC, HASH, TIMEOUT_MS, fetchRecord))
    .rejects.toThrow(/exceeds maxResponseBytes/);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels a late body even when fetch ignores the expired abort signal", async () => {
  let finishFetch: (response: Response) => void = () => { throw new Error("fetch not started"); };
  const fetchRecord = vi.fn<typeof fetch>(() => new Promise((resolve) => { finishFetch = resolve; }));
  const pending = readDemosTransactionRecord(RPC, HASH, TIMEOUT_MS, fetchRecord);
  const rejected = expect(pending).rejects.toThrow(/timed out/);
  await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
  await rejected;
  const cancel = vi.fn();
  finishFetch(new Response(new ReadableStream({ cancel })));
  await vi.advanceTimersByTimeAsync(0);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(fetchRecord).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  [404, null],
  [403, "refused"],
  [500, "connection refused"],
] as const)("preserves RPC failure %s and its bounded response", async (result, response) => {
  const fetchRecord = vi.fn<typeof fetch>(async () =>
    new Response(JSON.stringify({ result, response })));
  await expect(readDemosTransactionRecord(RPC, HASH, TIMEOUT_MS, fetchRecord))
    .rejects.toMatchObject({
      message: `Demos transaction record RPC returned ${result}`,
      cause: { result, response },
    });
  expect(fetchRecord).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([{}, { result: "404", response: null }, { result: 200 }, []].map((payload) => ({ payload })))(
  "distinguishes a malformed RPC envelope $payload from a remote failure", async ({ payload }) => {
    const fetchRecord = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload)));
    await expect(readDemosTransactionRecord(RPC, HASH, TIMEOUT_MS, fetchRecord))
      .rejects.toMatchObject({
        message: "Demos transaction record RPC envelope is malformed",
        cause: payload,
      });
  },
);
