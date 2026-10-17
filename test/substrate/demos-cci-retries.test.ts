import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Demos } from "@kynesyslabs/demosdk/websdk";
import { DacsError, SubstrateError, TransientError, faultCategory } from "../../src/errors.js";
import { DemosAdapter, type DemosAdapterConfig } from "../../src/substrate/index.js";
import { DEMOS_CCI_MAX_RESPONSE_BYTES, readDemosCciResponse } from "../../src/substrate/demosCciTransport.js";

const GCR = { result: 200, response: { xm: {}, web2: {}, ud: [], pqc: {} } };
const TIMEOUT = "Demos GCR identity read timed out";
const FAILED = "Demos GCR identity read failed after transient transport errors";
const READ_FAILED = "Demos GCR identity read failed";
const success = () => new Response(JSON.stringify(GCR));

function setup(timeoutMs = 5_000, totalTimeoutMs?: number) {
  vi.useFakeTimers();
  const transport = vi.fn<typeof fetch>();
  const adapter = new DemosAdapter({
    rpc: "https://node.example/rpc", identityFetch: transport, identityTimeoutMs: timeoutMs,
    ...(totalTimeoutMs === undefined ? {} : { identityTotalTimeoutMs: totalTimeoutMs }),
  });
  Object.assign(adapter, { connected: true });
  return { adapter, transport };
}

function stalledBody() {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
  return { response, cancel };
}

async function recover503() {
  const { adapter, transport } = setup();
  transport.mockResolvedValueOnce(new Response("discarded", { status: 503 }))
    .mockImplementationOnce(async () => success());
  const result = adapter.resolveIdentity("subject").catch(error => error);
  await vi.advanceTimersByTimeAsync(250);
  await expect(result).resolves.toHaveProperty("raw", GCR);
  expect(transport).toHaveBeenCalledTimes(2);
}

describe("Demos identity transient retries", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each([502, 503, 504])("recovers from HTTP %s with exactly one 250 ms backoff", async (status) => {
    const { adapter, transport } = setup();
    const failed = stalledBody();
    transport.mockResolvedValueOnce(new Response(failed.response.body, { status }))
      .mockImplementationOnce(async () => success());
    const start = Date.now();
    const result = adapter.resolveIdentity("subject").catch(error => error);
    await vi.advanceTimersByTimeAsync(249);
    expect(transport).toHaveBeenCalledOnce();
    expect(failed.cancel).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toHaveProperty("raw", GCR);
    expect(Date.now() - start).toBe(250);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers from a timeout using a fresh, live AbortController", async () => {
    const { adapter, transport } = setup(100);
    const failed = stalledBody();
    transport.mockResolvedValueOnce(failed.response).mockImplementationOnce(async (_url, init) => {
      expect(init?.signal?.aborted).toBe(false);
      init?.signal?.throwIfAborted();
      return success();
    });
    const result = adapter.resolveIdentity("subject").catch(error => error);
    await vi.advanceTimersByTimeAsync(349);
    expect(transport).toHaveBeenCalledOnce();
    expect(failed.cancel).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toHaveProperty("raw", GCR);
    const signals = transport.mock.calls.map(([, init]) => init?.signal);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(signals[0]).not.toBe(signals[1]);
  });

  it.each([
    ...["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND"].flatMap(code => [
      { code, fetchCause: false }, { code, fetchCause: true },
    ]),
    // Fetch-only codes: a socket closed before any response, and connect timeout.
    { code: "UND_ERR_SOCKET", fetchCause: true },
    { code: "UND_ERR_CONNECT_TIMEOUT", fetchCause: true },
  ])("recovers from $code (Fetch cause: $fetchCause)", async ({ code, fetchCause }) => {
    const { adapter, transport } = setup();
    const cause = Object.assign(new Error("discarded transport details"), { code });
    transport.mockRejectedValueOnce(fetchCause ? new TypeError("fetch failed", { cause }) : cause)
      .mockImplementationOnce(async () => success());
    const result = adapter.resolveIdentity("subject").catch(error => error);
    await vi.advanceTimersByTimeAsync(249);
    expect(transport).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(transport).toHaveBeenCalledTimes(2);
    await expect(result).resolves.toHaveProperty("raw", GCR);
  });

  it("exhausts three timeouts within 3 × timeout + 2,750 ms and cancels every body", async () => {
    const { adapter, transport } = setup(100);
    const bodies = Array.from({ length: 3 }, stalledBody);
    bodies.forEach(body => transport.mockResolvedValueOnce(body.response));
    const start = Date.now();
    const result = adapter.resolveIdentity("subject").catch(error => error);
    await vi.advanceTimersByTimeAsync(1_049);
    expect(transport).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    const error = await result;
    expect(Date.now() - start).toBe(3 * 100 + 250 + 500);
    expect(Date.now() - start).toBeLessThan(3 * 100 + 2_750);
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ message: TIMEOUT, category: "transient" });
    expect(faultCategory(error)).toBe("transient");
    expect(error).not.toHaveProperty("cause");
    bodies.forEach(({ cancel, response }) => {
      expect(cancel).toHaveBeenCalledOnce();
      expect(response.body?.locked).toBe(false);
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "60",
    // RFC 9110 §5.6.7: IMF-fixdate, then the obsolete asctime and RFC 850 forms.
    "Thu, 01 Jan 2099 00:00:00 GMT", "Fri Nov  6 08:49:37 2099", "Fri Nov 06 08:49:37 2099",
    "Thursday, 06-Nov-70 08:49:37 GMT", "Saturday, 01-Jan-50 00:00:00 GMT",
    // On 14 Oct 2026, a two-digit year names this century up to exactly 50 years ahead.
    "Tuesday, 13-Oct-76 00:00:00 GMT", "Wednesday, 14-Oct-76 00:00:00 GMT",
    // Second 60 is a leap second.
    "Thu, 31 Dec 2099 23:59:60 GMT", "Thu Dec 31 23:59:60 2099",
  ])("caps Retry-After %s at 2 seconds", async (retryAfter) => {
    const { adapter, transport } = setup();
    vi.setSystemTime(Date.UTC(2026, 9, 14));
    transport.mockResolvedValueOnce(new Response("discarded", {
      status: 503, headers: { "Retry-After": retryAfter },
    })).mockImplementationOnce(async () => success());
    const result = adapter.resolveIdentity("subject").catch(error => error);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(transport).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toHaveProperty("raw", GCR);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("enforces the overall deadline when two Retry-After waits consume the budget", async () => {
    // A large total leaves 3 × timeout + 2,750 ms as the binding bound.
    const { adapter, transport } = setup(5_000, 90_000);
    const bodies = Array.from({ length: 3 }, stalledBody);
    transport.mockImplementation((_url, init) => new Promise(resolve => {
      const index = transport.mock.calls.length - 1;
      if (index < 2) {
        setTimeout(() => resolve(new Response(bodies[index]!.response.body, {
          status: 503, headers: { "Retry-After": "60" },
        })), 4_999);
      } else {
        expect(init?.signal?.aborted).toBe(false);
        resolve(bodies[index]!.response);
      }
    }));
    const start = Date.now();
    let settled = false;
    const result = adapter.resolveIdentity("subject").catch(error => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(17_749);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await result;
    expect(Date.now() - start).toBe(3 * 5_000 + 2_750);
    expect(error).toBeInstanceOf(TransientError);
    expect(error.message).toBe(TIMEOUT);
    expect(transport).toHaveBeenCalledTimes(3);
    bodies.forEach(({ cancel }) => expect(cancel).toHaveBeenCalledOnce());
    expect(transport.mock.calls[2]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    // Date.parse accepts these leniently; most become past dates.
    "-1", "5, 5", "foo 2", "1.2.3",
    // Not delay-seconds or an HTTP-date.
    "", "junk", "1.5", "+5",
    // Future dates in the wrong format: they would cap at 2 s if accepted.
    "Sat, 06 Nov 2099 08:49:37 GMT", "Fri, 6 Nov 2099 08:49:37 GMT", "fri, 06 Nov 2099 08:49:37 GMT",
    "Sat Nov  6 08:49:37 2099", "Fri Nov 6 08:49:37 2099", "Fri Nov  6 08:49:37 2099 GMT",
    "Friday, 06 Nov 2099 08:49:37 GMT", "Fri, 06-Nov-70 08:49:37 GMT", "Wednesday, 06-Nov-70 08:49:37 GMT",
    "Thursday, 06-Nov-2070 08:49:37 GMT", "Thursday, 06-Nov-70 08:49:37 UTC", "Thursday, 31-Feb-70 08:49:37 GMT",
    "Fri Nov  6 24:49:37 2099", "Thu, 31 Dec 2099 24:00:00 GMT", "Thu, 31 Dec 2099 23:60:00 GMT",
    "Thu, 31 Dec 2099 23:59:61 GMT", "Thu, 01 Jan 2099 0:00:00 GMT",
    // Days that don't exist, named by the weekday of the date they roll over to
    // (2 Mar 2099 is a Monday, 1 May 2099 a Friday).
    "Mon, 30 Feb 2099 00:00:00 GMT", "Fri, 31 Apr 2099 00:00:00 GMT",
    // Each form is anchored at both ends.
    "xThu, 01 Jan 2099 00:00:00 GMT", "Thu, 01 Jan 2099 00:00:00 GMTx",
    "xThursday, 06-Nov-70 08:49:37 GMT", "Thursday, 06-Nov-70 08:49:37 GMTx",
    "xFri Nov  6 08:49:37 2099", "Fri Nov  6 08:49:37 20990",
    // 6 Nov 2077 is a Saturday, but 77 is more than 50 years ahead, so this names 1977, a Sunday.
    "Saturday, 06-Nov-77 08:49:37 GMT",
    // Ahead of 14 Oct 2076 by a day or weeks, so these name 1976, when those dates were a
    // Friday and a Saturday.
    "Thursday, 15-Oct-76 00:00:00 GMT", "Friday, 06-Nov-76 08:49:37 GMT",
    // One second past the limit names 1976, a Thursday (14 Oct 2076 is a Wednesday);
    // a date past the limit is never moved a century ahead (15 Oct 2176 is a Tuesday).
    "Wednesday, 14-Oct-76 00:00:01 GMT", "Tuesday, 15-Oct-76 00:00:00 GMT",
    // Valid, but shorter than the backoff. A two-digit year more than 50 years ahead is in the past.
    "0", "Sun, 06 Nov 1994 08:49:37 GMT", "Sun Nov  6 08:49:37 1994", "Sunday, 06-Nov-77 08:49:37 GMT",
    "Friday, 15-Oct-76 00:00:00 GMT", "Saturday, 06-Nov-76 08:49:37 GMT",
  ])("never waits less or more than the 250 ms backoff for Retry-After %j", async (retryAfter) => {
    const { adapter, transport } = setup();
    vi.setSystemTime(Date.UTC(2026, 9, 14));
    transport.mockResolvedValueOnce(new Response("discarded", {
      status: 503, headers: { "Retry-After": retryAfter },
    })).mockImplementationOnce(async () => success());
    const result = adapter.resolveIdentity("subject").catch(error => error);
    await vi.advanceTimersByTimeAsync(249);
    expect(transport).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(transport).toHaveBeenCalledTimes(2);
    await expect(result).resolves.toHaveProperty("raw", GCR);
  });

  it.each([
    { retryAfter: ["1", "0"], calls: [1_000, 1_500] },
    { retryAfter: ["Sun, 06 Nov 1994 08:49:38 GMT", "1"], calls: [1_000, 2_000] },
    { retryAfter: ["Sunday, 06-Nov-94 08:49:38 GMT", "Sun Nov  6 08:49:39 1994"], calls: [1_000, 2_000] },
  ])("waits max(backoff, Retry-After) for $retryAfter", async ({ retryAfter, calls }) => {
    await expectRetryCalls("1994-11-06T08:49:37Z", retryAfter, calls);
  });

  // Positive witnesses span every month/weekday and all three wire grammars,
  // including valid February dates in leap and non-leap years.
  it.each([
    { now: "2026-01-01T00:00:00Z", dates: ["Thu, 01 Jan 2026 00:00:01 GMT", "Thursday, 01-Jan-26 00:00:01 GMT", "Thu Jan  1 00:00:01 2026"] },
    { now: "2026-02-01T00:00:00Z", dates: ["Sun, 01 Feb 2026 00:00:01 GMT", "Sunday, 01-Feb-26 00:00:01 GMT", "Sun Feb  1 00:00:01 2026"] },
    { now: "2026-03-01T00:00:00Z", dates: ["Sun, 01 Mar 2026 00:00:01 GMT", "Sunday, 01-Mar-26 00:00:01 GMT", "Sun Mar  1 00:00:01 2026"] },
    { now: "2026-04-01T00:00:00Z", dates: ["Wed, 01 Apr 2026 00:00:01 GMT", "Wednesday, 01-Apr-26 00:00:01 GMT", "Wed Apr  1 00:00:01 2026"] },
    { now: "2026-05-01T00:00:00Z", dates: ["Fri, 01 May 2026 00:00:01 GMT", "Friday, 01-May-26 00:00:01 GMT", "Fri May  1 00:00:01 2026"] },
    { now: "2026-06-01T00:00:00Z", dates: ["Mon, 01 Jun 2026 00:00:01 GMT", "Monday, 01-Jun-26 00:00:01 GMT", "Mon Jun  1 00:00:01 2026"] },
    { now: "2026-07-01T00:00:00Z", dates: ["Wed, 01 Jul 2026 00:00:01 GMT", "Wednesday, 01-Jul-26 00:00:01 GMT", "Wed Jul  1 00:00:01 2026"] },
    { now: "2026-08-01T00:00:00Z", dates: ["Sat, 01 Aug 2026 00:00:01 GMT", "Saturday, 01-Aug-26 00:00:01 GMT", "Sat Aug  1 00:00:01 2026"] },
    { now: "2026-09-01T00:00:00Z", dates: ["Tue, 01 Sep 2026 00:00:01 GMT", "Tuesday, 01-Sep-26 00:00:01 GMT", "Tue Sep  1 00:00:01 2026"] },
    { now: "2026-10-01T00:00:00Z", dates: ["Thu, 01 Oct 2026 00:00:01 GMT", "Thursday, 01-Oct-26 00:00:01 GMT", "Thu Oct  1 00:00:01 2026"] },
    { now: "2026-11-01T00:00:00Z", dates: ["Sun, 01 Nov 2026 00:00:01 GMT", "Sunday, 01-Nov-26 00:00:01 GMT", "Sun Nov  1 00:00:01 2026"] },
    { now: "2026-12-01T00:00:00Z", dates: ["Tue, 01 Dec 2026 00:00:01 GMT", "Tuesday, 01-Dec-26 00:00:01 GMT", "Tue Dec  1 00:00:01 2026"] },
    { now: "2024-02-29T00:00:00Z", dates: ["Thu, 29 Feb 2024 00:00:01 GMT", "Thursday, 29-Feb-24 00:00:01 GMT", "Thu Feb 29 00:00:01 2024"] },
    { now: "2026-02-28T00:00:00Z", dates: ["Sat, 28 Feb 2026 00:00:01 GMT", "Saturday, 28-Feb-26 00:00:01 GMT", "Sat Feb 28 00:00:01 2026"] },
  ].flatMap(({ now, dates }) => dates.map(retryAfter => ({ now, retryAfter }))))(
    "waits exactly one second for valid HTTP-date $retryAfter",
    async ({ now, retryAfter }) => {
      await expectRetryCalls(now, [retryAfter], [1_000]);
    },
  );

  // Each month name maps to its own month: June's last second, then 1 July.
  it("waits until 1 July from the last second of June", async () => {
    await expectRetryCalls("2026-06-30T23:59:59Z", ["Wed, 01 Jul 2026 00:00:00 GMT"], [1_000]);
  });

  // RFC 9110 §5.6.7 allows second 60; it is the instant after :59.
  it.each([
    "Sat, 31 Dec 2016 23:59:60 GMT", "Saturday, 31-Dec-16 23:59:60 GMT", "Sat Dec 31 23:59:60 2016",
  ])("waits until the leap second %s", async (retryAfter) => {
    await expectRetryCalls("2016-12-31T23:59:59Z", [retryAfter], [1_000]);
  });

  async function expectRetryCalls(now: string, retryAfter: string[], calls: number[]) {
    const { adapter, transport } = setup();
    vi.setSystemTime(Date.parse(now));
    for (const value of retryAfter) {
      transport.mockResolvedValueOnce(new Response("discarded", {
        status: 503, headers: { "Retry-After": value },
      }));
    }
    transport.mockImplementationOnce(async () => success());
    const result = adapter.resolveIdentity("subject").catch(error => error);
    for (const [index, at] of calls.entries()) {
      await vi.advanceTimersByTimeAsync(at - 1 - (index === 0 ? 0 : calls[index - 1]!));
      expect(transport).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(transport).toHaveBeenCalledTimes(index + 2);
    }
    await expect(result).resolves.toHaveProperty("raw", GCR);
  }

  it.each([
    { timeoutMs: 5_000, totalTimeoutMs: undefined, endMs: 12_000, attempts: 3 },
    { timeoutMs: 8_000, totalTimeoutMs: undefined, endMs: 12_000, attempts: 2 },
    { timeoutMs: 100, totalTimeoutMs: undefined, endMs: 1_050, attempts: 3 },
    { timeoutMs: 5_000, totalTimeoutMs: 4_000, endMs: 4_000, attempts: 1 },
    { timeoutMs: 5_000, totalTimeoutMs: 90_000, endMs: 15_750, attempts: 3 },
    { timeoutMs: 30_000, totalTimeoutMs: 90_000, endMs: 90_000, attempts: 3 },
  ])("ends a silent lookup at $endMs ms (timeout $timeoutMs, total $totalTimeoutMs)", async ({
    timeoutMs, totalTimeoutMs, endMs, attempts,
  }) => {
    const { adapter, transport } = setup(timeoutMs, totalTimeoutMs);
    transport.mockImplementation(() => new Promise<Response>(() => {}));
    const start = Date.now();
    let settled = false;
    const result = adapter.resolveIdentity("subject").catch(error => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(endMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    const error = await result;
    expect(Date.now() - start).toBe(endMs);
    // The documented bound: min(3 × identityTimeoutMs + 2.75 s, identityTotalTimeoutMs).
    expect(endMs).toBeLessThanOrEqual(Math.min(3 * timeoutMs + 2_750, totalTimeoutMs ?? 12_000));
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ message: TIMEOUT, category: "transient" });
    expect(error).not.toHaveProperty("cause");
    expect(transport).toHaveBeenCalledTimes(attempts);
    transport.mock.calls.forEach(([, init]) => expect(init?.signal?.aborted).toBe(true));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts no wait the overall deadline would cut short, ending inside dacs-node's 15 s", async () => {
    const { adapter, transport } = setup();
    const bodies = Array.from({ length: 2 }, stalledBody);
    transport.mockImplementation(() => new Promise(resolve => {
      const body = bodies[transport.mock.calls.length - 1]!;
      setTimeout(() => resolve(new Response(body.response.body, {
        status: 503, headers: { "Retry-After": "60" },
      })), 4_999);
    }));
    const start = Date.now();
    let settled = false;
    const result = adapter.resolveIdentity("subject").catch(error => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(11_997);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    const error = await result;
    // 503 at 4,999 ms, 2 s wait, 503 at 11,998 ms: a second 2 s wait would pass 12 s.
    expect(Date.now() - start).toBe(11_998);
    expect(Date.now() - start).toBeLessThan(15_000);
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ message: FAILED, category: "transient" });
    expect(error).not.toHaveProperty("cause");
    expect(transport).toHaveBeenCalledTimes(2);
    bodies.forEach(({ cancel }) => expect(cancel).toHaveBeenCalledOnce());
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    // 503 at 99 ms, 2 s wait, 503 at 2,198 ms: another 2 s wait would pass 3 × 100 + 2,750 ms,
    // the binding term here, though it fits the 12 s total.
    { timeoutMs: 100, replyMs: 99, endMs: 2_198 },
    // 503 at 4 s, 2 s wait, 503 at 10 s: another 2 s wait would end exactly at the 12 s deadline.
    { timeoutMs: 5_000, replyMs: 4_000, endMs: 10_000 },
  ])("starts no wait that reaches the deadline (timeout $timeoutMs, 503 after $replyMs ms)", async ({
    timeoutMs, replyMs, endMs,
  }) => {
    const { adapter, transport } = setup(timeoutMs);
    transport.mockImplementation(() => new Promise(resolve => {
      setTimeout(() => resolve(new Response("discarded", {
        status: 503, headers: { "Retry-After": "2" },
      })), replyMs);
    }));
    const start = Date.now();
    let settledAt: number | undefined;
    const result = adapter.resolveIdentity("subject").catch(error => { settledAt = Date.now(); return error; });
    await vi.advanceTimersByTimeAsync(15_000);
    const error = await result;
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ message: FAILED, category: "transient" });
    expect(settledAt! - start).toBe(endMs);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { timeoutMs: 100, totalTimeoutMs: undefined, signMs: 150, endMs: 1_050 },
    { timeoutMs: 5_000, totalTimeoutMs: 1_000, signMs: 1_500, endMs: 1_000 },
  ])("sends no request once signing outlasts its deadline (timeout $timeoutMs, total $totalTimeoutMs)", async ({
    timeoutMs, totalTimeoutMs, signMs, endMs,
  }) => {
    const { adapter, transport } = setup(timeoutMs, totalTimeoutMs);
    const demos = adapter.raw as unknown as Demos;
    vi.spyOn(demos, "walletConnected", "get").mockReturnValue(true);
    vi.spyOn(demos, "keypair", "get").mockReturnValue({
      publicKey: Buffer.alloc(32, 0xab), privateKey: Buffer.alloc(64),
    });
    const sign = vi.spyOn(demos.crypto, "sign").mockImplementation((() => new Promise(resolve => {
      setTimeout(() => resolve({ signature: Uint8Array.of(1) }), signMs);
    })) as never);
    const start = Date.now();
    let settledAt: number | undefined;
    const result = adapter.resolveIdentity("subject").catch(error => { settledAt = Date.now(); return error; });
    await vi.advanceTimersByTimeAsync(endMs + signMs);
    expect(await result).toMatchObject({ message: TIMEOUT, category: "transient" });
    expect(settledAt! - start).toBe(endMs);
    expect(sign).toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { kind: "plain Error with cause ECONNRESET", error: new Error("x", { cause: { code: "ECONNRESET" } }) },
    { kind: "plain Error with cause UND_ERR_SOCKET", error: new Error("x", { cause: { code: "UND_ERR_SOCKET" } }) },
    { kind: "direct UND_ERR_SOCKET code", error: Object.assign(new Error("x"), { code: "UND_ERR_SOCKET" }) },
    { kind: "TypeError with an unlisted cause code", error: new TypeError("x", { cause: { code: "EPROTO" } }) },
  ])("neither retries nor surfaces a $kind", async ({ error }) => {
    const { adapter, transport } = setup();
    transport.mockRejectedValue(error);
    const result = adapter.resolveIdentity("subject").catch(caught => caught);
    await vi.advanceTimersByTimeAsync(12_000);
    const caught = await result;
    expect(caught).toBeInstanceOf(SubstrateError);
    expect(caught).toMatchObject({ message: READ_FAILED, category: "substrate" });
    expect(caught).not.toHaveProperty("cause");
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each([null, undefined, "fetch failed", 0, false])(
    "replaces a non-object transport rejection %j with SubstrateError, without retrying", async (thrown) => {
      const { adapter, transport } = setup();
      transport.mockImplementation(() => Promise.reject(thrown));
      const result = adapter.resolveIdentity("subject").catch(caught => caught);
      await vi.advanceTimersByTimeAsync(12_000);
      const caught = await result;
      expect(caught).toBeInstanceOf(SubstrateError);
      expect(caught).toMatchObject({ message: READ_FAILED, category: "substrate" });
      expect(transport).toHaveBeenCalledOnce();
    },
  );

  it("retries a bodyless 503 and reports a bodyless 500 by status", async () => {
    const { adapter, transport } = setup();
    transport.mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }));
    const result = adapter.resolveIdentity("subject").catch(error => error);
    await vi.advanceTimersByTimeAsync(250);
    const error = await result;
    expect(error).toBeInstanceOf(SubstrateError);
    expect(error.message).toBe("Demos GCR identity read failed with HTTP 500");
    expect(transport).toHaveBeenCalledTimes(2);
  });

  // Unrecognised Fetch failures: their causes carry socket addresses (and parser errors the node's bytes).
  it.each([
    "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "UND_ERR_HEADERS_TIMEOUT", "HPE_INVALID_CONSTANT",
  ].flatMap(code => [{ code, phase: "transport" }, { code, phase: "body" }]))(
    "replaces a $phase $code failure with a fresh, final SubstrateError", async ({ code, phase }) => {
      const { adapter, transport } = setup();
      const cause = Object.assign(new Error(`connect ${code} 10.0.0.7:45678 NODE-SECRET-TEXT`), {
        code, address: "10.0.0.7", port: 45_678, data: "NODE-SECRET-TEXT",
      });
      const failure = new TypeError(phase === "body" ? "terminated" : "fetch failed", { cause });
      if (phase === "body") {
        transport.mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
          pull(controller) { controller.error(failure); },
        })));
      } else {
        transport.mockRejectedValue(failure);
      }
      const result = adapter.resolveIdentity("subject").catch(error => error);
      await vi.advanceTimersByTimeAsync(12_000);
      const error = await result;
      expect(error).toBeInstanceOf(SubstrateError);
      expect(error).toMatchObject({ message: READ_FAILED, category: "substrate" });
      expect(error).not.toHaveProperty("cause");
      expect(inspect(error, { depth: 10 })).not.toMatch(
        new RegExp(`10\\.0\\.0\\.7|45678|NODE-SECRET-TEXT|${code}|fetch failed|terminated`),
      );
      expect(transport).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { kind: "programmer error", error: new Error("signer bug") },
    { kind: "TypeError with a connection cause", error: new TypeError("x", { cause: { code: "ECONNRESET" } }) },
  ])("passes a signing $kind through unchanged, without a request or retry", async ({ error }) => {
    const { adapter, transport } = setup();
    const demos = adapter.raw as unknown as Demos;
    vi.spyOn(demos, "walletConnected", "get").mockReturnValue(true);
    vi.spyOn(demos, "keypair", "get").mockReturnValue({
      publicKey: Buffer.alloc(32, 0xab), privateKey: Buffer.alloc(64),
    });
    const sign = vi.spyOn(demos.crypto, "sign").mockRejectedValue(error);
    const result = adapter.resolveIdentity("subject").catch(caught => caught);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await result).toBe(error);
    expect(sign).toHaveBeenCalledOnce();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT",
  ].flatMap(code => [{ code, fetchCause: false }, { code, fetchCause: true }]))(
    "does not retry $code raised after the response started (Fetch cause: $fetchCause)", async ({ code, fetchCause }) => {
      const { adapter, transport } = setup();
      const cause = Object.assign(new Error("connect 10.0.0.7:45678"), { code, address: "10.0.0.7", port: 45_678 });
      const failure = fetchCause ? new TypeError("terminated", { cause }) : cause;
      transport.mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"res')); },
        pull(controller) { controller.error(failure); },
      })));
      const result = adapter.resolveIdentity("subject").catch(error => error);
      await vi.advanceTimersByTimeAsync(12_000);
      const error = await result;
      expect(error).toBeInstanceOf(TransientError);
      expect(error).toMatchObject({ message: FAILED, category: "transient" });
      expect(error).not.toHaveProperty("cause");
      expect(inspect(error)).not.toMatch(/10\.0\.0\.7|45678|terminated/);
      expect(transport).toHaveBeenCalledOnce();
    },
  );

  it.each([502, 503, 504, "ECONNRESET"])("sanitizes exhausted transient failure %s", async (failure) => {
    const { adapter, transport } = setup();
    const cancellations = [vi.fn(), vi.fn(), vi.fn()];
    transport.mockImplementation(async () => {
      if (typeof failure === "string") {
        throw new TypeError("response-sentinel", { cause: { code: failure } });
      }
      return new Response(new ReadableStream({ cancel: cancellations[transport.mock.calls.length - 1] }), {
        status: failure,
      });
    });
    const result = adapter.resolveIdentity("subject").catch(error => error);
    await vi.advanceTimersByTimeAsync(750);
    const error = await result;
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ message: FAILED, category: "transient" });
    expect(error).not.toHaveProperty("cause");
    expect(transport).toHaveBeenCalledTimes(3);
    if (typeof failure === "number") cancellations.forEach(cancel => expect(cancel).toHaveBeenCalledOnce());
  });

  it.each([
    { kind: "overflow", response: () => new Response("discarded", { headers: { "Content-Length": "2097153" } }), message: "exceeds maxResponseBytes", errorClass: DacsError },
    { kind: "redirect", response: () => new Response("discarded", { status: 302 }), message: "redirect refused", errorClass: DacsError },
    { kind: "JSON", response: () => new Response("invalid-json-sentinel"), message: "not valid UTF-8 JSON", errorClass: DacsError },
    { kind: "UTF-8", response: () => new Response(Uint8Array.of(255)), message: "not valid UTF-8 JSON", errorClass: DacsError },
    { kind: "400", response: () => new Response("discarded", { status: 400 }), message: "HTTP 400", errorClass: SubstrateError },
    { kind: "429", response: () => new Response("discarded", { status: 429, headers: { "Retry-After": "1" } }), message: "HTTP 429", errorClass: SubstrateError },
    { kind: "500", response: () => new Response("discarded", { status: 500 }), message: "HTTP 500", errorClass: SubstrateError },
  ])("retries 503 but never retries $kind", async ({ response, message, errorClass }) => {
    // Positive control makes each regression case fail on the no-retry PR.
    await recover503();
    const { adapter, transport } = setup();
    transport.mockImplementation(async () => response());
    const result = adapter.resolveIdentity("subject").catch(error => error);
    await vi.advanceTimersByTimeAsync(17_750);
    const error = await result;
    expect(error).toBeInstanceOf(errorClass);
    expect(error.message).toContain(message);
    expect(error).not.toHaveProperty("cause");
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each([0, -1, 1.5, 30_001, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, "8000"])(
    "rejects unsafe identityTimeoutMs %s", value => {
      expect(() => new DemosAdapter({ rpc: "https://node.example/rpc", identityTimeoutMs: value } as DemosAdapterConfig))
        .toThrow(/identityTimeoutMs must be a positive safe integer at most 30000/);
    },
  );

  it("accepts 1 ms per-attempt and total identity deadlines", () => {
    expect(() => new DemosAdapter({ rpc: "https://node.example/rpc", identityTimeoutMs: 1 })).not.toThrow();
    expect(() => new DemosAdapter({ rpc: "https://node.example/rpc", identityTotalTimeoutMs: 1 })).not.toThrow();
  });

  it("accepts 30,000 ms and lets a six-second reply succeed within a configured eight seconds", async () => {
    expect(() => new DemosAdapter({ rpc: "https://node.example/rpc", identityTimeoutMs: 30_000 })).not.toThrow();
    const { adapter, transport } = setup(8_000);
    transport.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(success()), 6_000)));
    const result = adapter.resolveIdentity("subject").catch(error => error);
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(result).resolves.toHaveProperty("raw", GCR);
    expect(transport).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("captures the timeout as stable data at construction", async () => {
    vi.useFakeTimers();
    const transport = vi.fn<typeof fetch>().mockImplementation(() =>
      new Promise(resolve => setTimeout(() => resolve(success()), 6_000)));
    const config = { rpc: "https://node.example/rpc", identityFetch: transport, identityTimeoutMs: 8_000 };
    const adapter = new DemosAdapter(config);
    config.identityTimeoutMs = 1;
    Object.assign(adapter, { connected: true });
    const result = adapter.resolveIdentity("subject").catch(error => error);
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(result).resolves.toHaveProperty("raw", GCR);
    expect(transport).toHaveBeenCalledOnce();
    const getter = vi.fn(() => 8_000);
    const accessor = { rpc: config.rpc };
    Object.defineProperty(accessor, "identityTimeoutMs", { get: getter });
    expect(() => new DemosAdapter(accessor)).toThrow(/identityTimeoutMs.*stable data/);
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, 90_001, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, "12000"])(
    "rejects unsafe identityTotalTimeoutMs %s", value => {
      expect(() => new DemosAdapter({ rpc: "https://node.example/rpc", identityTotalTimeoutMs: value } as DemosAdapterConfig))
        .toThrow(/identityTotalTimeoutMs must be a positive safe integer at most 90000/);
    },
  );

  it("accepts 90,000 ms and captures identityTotalTimeoutMs as stable data at construction", async () => {
    expect(() => new DemosAdapter({ rpc: "https://node.example/rpc", identityTotalTimeoutMs: 90_000 })).not.toThrow();
    vi.useFakeTimers();
    const transport = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => {}));
    const config = { rpc: "https://node.example/rpc", identityFetch: transport, identityTotalTimeoutMs: 1_000 };
    const adapter = new DemosAdapter(config);
    config.identityTotalTimeoutMs = 90_000;
    Object.assign(adapter, { connected: true });
    let settled = false;
    const result = adapter.resolveIdentity("subject").catch(error => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(true);
    expect(await result).toMatchObject({ message: TIMEOUT, category: "transient" });
    expect(transport).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    const getter = vi.fn(() => 12_000);
    const accessor = { rpc: config.rpc };
    Object.defineProperty(accessor, "identityTotalTimeoutMs", { get: getter });
    expect(() => new DemosAdapter(accessor)).toThrow(/identityTotalTimeoutMs.*stable data/);
    expect(getter).not.toHaveBeenCalled();
  });
});

// Real timers: occupying the event loop past the deadline lets an older timer
// (backoff, signing, response) run before the overall abort timer.
describe("Demos identity deadline under a delayed event loop", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  const busyUntil = (ms: number) => {
    while (performance.now() < ms) { /* occupy the event loop */ }
  };

  function realSetup() {
    const transport = vi.fn<typeof fetch>();
    const adapter = new DemosAdapter({
      rpc: "https://node.example/rpc", identityFetch: transport, identityTotalTimeoutMs: 300,
    });
    Object.assign(adapter, { connected: true });
    return { adapter, transport };
  }

  it("checks the attempt deadline before sending when synchronous headers delay its timer", async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => success());
    const buildHeaders = vi.fn(async () => {
      busyUntil(performance.now() + 40);
      return {};
    });
    const error = await readDemosCciResponse(
      "https://node.example/rpc", "subject", buildHeaders, transport,
      DEMOS_CCI_MAX_RESPONSE_BYTES, 5, 200,
    ).catch(caught => caught);
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ message: TIMEOUT, category: "transient" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("disposes a response delivered after its attempt deadline inside the overall budget", async () => {
    const bodies: ReturnType<typeof stalledBody>[] = [];
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => {
      const body = stalledBody();
      bodies.push(body);
      busyUntil(performance.now() + 40);
      return body.response;
    });
    const error = await readDemosCciResponse(
      "https://node.example/rpc", "subject", async () => ({}), transport,
      DEMOS_CCI_MAX_RESPONSE_BYTES, 5, 200,
    ).catch(caught => caught);
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ message: TIMEOUT, category: "transient" });
    expect(transport).toHaveBeenCalledOnce();
    expect(bodies[0]!.cancel).toHaveBeenCalledOnce();
    expect(bodies[0]!.response.body?.locked).toBe(false);
  });

  it("starts no second request when a 503 backoff callback runs after the deadline", async () => {
    const { adapter, transport } = realSetup();
    const start = performance.now();
    transport.mockImplementationOnce(async () => {
      setTimeout(() => busyUntil(start + 350), 1);
      return new Response("discarded", { status: 503 });
    }).mockImplementation(async () => success());
    const error = await adapter.resolveIdentity("subject").catch(caught => caught);
    expect(performance.now() - start).toBeGreaterThanOrEqual(350);
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ message: TIMEOUT, category: "transient" });
    expect(error).not.toHaveProperty("cause");
    expect(transport).toHaveBeenCalledOnce();
  });

  it("sends no request when slow signing resolves after the deadline", async () => {
    const { adapter, transport } = realSetup();
    transport.mockImplementation(async () => success());
    const demos = adapter.raw as unknown as Demos;
    vi.spyOn(demos, "walletConnected", "get").mockReturnValue(true);
    vi.spyOn(demos, "keypair", "get").mockReturnValue({
      publicKey: Buffer.alloc(32, 0xab), privateKey: Buffer.alloc(64),
    });
    const start = performance.now();
    const sign = vi.spyOn(demos.crypto, "sign").mockImplementation((() => new Promise(resolve => {
      setTimeout(() => resolve({ signature: Uint8Array.of(1) }), 250);
      setTimeout(() => busyUntil(start + 350), 1);
    })) as never);
    const error = await adapter.resolveIdentity("subject").catch(caught => caught);
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ message: TIMEOUT, category: "transient" });
    expect(sign).toHaveBeenCalledOnce();
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not accept a response delivered after the deadline", async () => {
    const { adapter, transport } = realSetup();
    const start = performance.now();
    transport.mockImplementation(() => new Promise(resolve => {
      setTimeout(() => resolve(success()), 250);
      setTimeout(() => busyUntil(start + 350), 1);
    }));
    const error = await adapter.resolveIdentity("subject").catch(caught => caught);
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ message: TIMEOUT, category: "transient" });
    expect(transport).toHaveBeenCalledOnce();
  });
});

// The clock is injected, so each expiry check is exercised without real delays.
describe("Demos identity monotonic expiry checks", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  function read(transport: typeof fetch, buildHeaders: () => Promise<Record<string, string>>, now: () => number) {
    return readDemosCciResponse(
      "https://node.example/rpc", "subject", buildHeaders, transport,
      DEMOS_CCI_MAX_RESPONSE_BYTES, 5_000, 300, now,
    ).catch(error => error);
  }

  it("signs and sends nothing for the next attempt once the clock passes expiry during a wait", async () => {
    vi.useFakeTimers();
    let clock = 0;
    const headers = vi.fn(async () => ({}));
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => {
      setTimeout(() => { clock = 300; }, 100);
      return new Response("discarded", { status: 503 });
    });
    const result = read(transport, headers, () => clock);
    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toMatchObject({ message: TIMEOUT, category: "transient" });
    expect(headers).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends nothing when the clock passes expiry during signing", async () => {
    vi.useFakeTimers();
    let clock = 0;
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => success());
    const error = await read(transport, async () => { clock = 300; return {}; }, () => clock);
    expect(error).toMatchObject({ message: TIMEOUT, category: "transient" });
    expect(transport).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { kind: "a successful response", response: success },
    { kind: "a 503", response: () => new Response("discarded", { status: 503 }) },
  ])("reports a timeout, not $kind, once the clock passes expiry during the read", async ({ response }) => {
    vi.useFakeTimers();
    let clock = 0;
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => { clock = 300; return response(); });
    const error = await read(transport, async () => ({}), () => clock);
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ message: TIMEOUT, category: "transient" });
    expect(transport).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["headers", "response", "body", "decode"] as const)(
    "checks the attempt clock after %s even when timers have not fired",
    async (phase) => {
      vi.useFakeTimers();
      let clock = 0;
      const cancel = vi.fn(async () => undefined);
      const response = phase === "body"
        ? new Response(new ReadableStream<Uint8Array>({
            pull(controller) {
              clock = 5;
              controller.enqueue(new TextEncoder().encode(JSON.stringify(GCR)));
              controller.close();
            },
          }, { highWaterMark: 0 }))
        : new Response(JSON.stringify(GCR));
      if (phase === "decode") {
        const decode = TextDecoder.prototype.decode;
        vi.spyOn(TextDecoder.prototype, "decode").mockImplementation(function (this: TextDecoder, ...args) {
          clock = 5;
          return decode.apply(this, args);
        });
      }
      if (phase === "response") vi.spyOn(response.body!, "cancel").mockImplementation(cancel);
      const transport = vi.fn<typeof fetch>().mockImplementation(async () => {
        if (phase === "response") clock = 5;
        return response;
      });
      const result = readDemosCciResponse(
        "https://node.example/rpc", "subject", async () => {
          if (phase === "headers") clock = 5;
          return {};
        }, transport, DEMOS_CCI_MAX_RESPONSE_BYTES, 5, 200, () => clock,
      ).catch(error => error);
      // A 250 ms backoff cannot fit, so no timers or retries are needed.
      expect(await result).toMatchObject({ message: TIMEOUT, category: "transient" });
      expect(transport).toHaveBeenCalledTimes(phase === "headers" ? 0 : 1);
      if (phase === "response") expect(cancel).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("accepts a response read just before expiry", async () => {
    vi.useFakeTimers();
    let clock = 0;
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => { clock = 299; return success(); });
    await expect(read(transport, async () => ({}), () => clock)).resolves.toEqual(GCR);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends a retry wait when the overall timer fires inside it", async () => {
    vi.useFakeTimers();
    // A timer can fire before the monotonic clock reads expiry (Node timers start from
    // cached loop time). Here the clock never advances: the 250 ms wait after a 503 at
    // 100 ms fits, but the 300 ms overall timer lands inside it.
    const transport = vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => {
      setTimeout(() => resolve(new Response("discarded", { status: 503 })), 100);
    }));
    let settled = false;
    const result = read(transport, async () => ({}), () => 0).then(error => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(299);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await result).toMatchObject({ message: TIMEOUT, category: "transient" });
    expect(transport).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("checks expiry on a monotonic clock: a wall-clock jump does not expire the lookup", async () => {
    // Real timers: only the wall clock jumps; performance.now() does not.
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => {
      const wall = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(wall + 3_600_000);
      return success();
    });
    await expect(readDemosCciResponse(
      "https://node.example/rpc", "subject", async () => ({}), transport,
      DEMOS_CCI_MAX_RESPONSE_BYTES, 5_000, 12_000,
    )).resolves.toEqual(GCR);
  });
});

// Node's own fetch against a real socket: these are the errors a restarting node produces.
describe("Demos identity reads against a real local HTTP server", () => {
  let server: Server | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    server?.closeAllConnections();
    await new Promise(resolve => (server ? server.close(resolve) : resolve(undefined)));
    server = undefined;
  });

  async function serve(handler: (request: IncomingMessage, response: ServerResponse, connection: number) => void) {
    // Global fetch is injected: the default transport refuses to read if the
    // run started with Node's proxy switch. NO_PROXY must name the local node
    // rather than be blank: Node's proxy agent re-reads NO_PROXY per request.
    for (const name of ["http_proxy", "https_proxy", "all_proxy"]) {
      vi.stubEnv(name, "");
      vi.stubEnv(name.toUpperCase(), "");
    }
    vi.stubEnv("no_proxy", "127.0.0.1,localhost");
    vi.stubEnv("NO_PROXY", "127.0.0.1,localhost");
    let connections = 0;
    let requests = 0;
    server = createServer((request, response) => {
      requests++;
      handler(request, response, connections);
    });
    server.on("connection", () => { connections++; });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const adapter = new DemosAdapter({ rpc: `http://127.0.0.1:${port}/`, identityFetch: fetch });
    Object.assign(adapter, { connected: true });
    return { adapter, port, counts: () => ({ connections, requests }) };
  }

  // Read the whole request first so the close is a clean FIN, not a reset.
  const closeCleanly = (request: IncomingMessage) => {
    request.resume().on("end", () => request.socket.destroy());
  };

  it("retries a connection the node closes before responding", async () => {
    const { adapter, counts } = await serve((request, response, connection) => {
      if (connection === 1) return closeCleanly(request);
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(GCR));
    });
    await expect(adapter.resolveIdentity("subject")).resolves.toHaveProperty("raw", GCR);
    expect(counts()).toEqual({ connections: 2, requests: 2 });
  });

  it("ends repeated closes in the stable TransientError, without the Fetch error or its cause", async () => {
    const { adapter, counts } = await serve(request => closeCleanly(request));
    const error = await adapter.resolveIdentity("subject").catch(caught => caught);
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ message: FAILED, category: "transient" });
    expect(error).not.toHaveProperty("cause");
    expect(inspect(error)).not.toMatch(/127\.0\.0\.1|UND_ERR_SOCKET|fetch failed/);
    expect(counts()).toEqual({ connections: 3, requests: 3 });
  });

  it("does not retry a connection closed mid-body, and drops the Fetch error", async () => {
    const { adapter, counts } = await serve((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": "4096" });
      response.write(JSON.stringify(GCR).slice(0, 10), () => response.socket?.destroy());
    });
    const error = await adapter.resolveIdentity("subject").catch(caught => caught);
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ message: FAILED, category: "transient" });
    expect(error).not.toHaveProperty("cause");
    expect(inspect(error)).not.toMatch(/127\.0\.0\.1|UND_ERR_SOCKET|terminated/);
    expect(counts()).toEqual({ connections: 1, requests: 1 });
  });

  it("does not retry a connection reset mid-body, and drops the Fetch error", async () => {
    const { adapter, counts } = await serve((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": "4096" });
      // Reset after the client has read the partial body, so Fetch reports ECONNRESET
      // rather than UND_ERR_SOCKET ("other side closed").
      response.write(JSON.stringify(GCR).slice(0, 10), () => {
        setTimeout(() => response.socket?.resetAndDestroy(), 20);
      });
    });
    const error = await adapter.resolveIdentity("subject").catch(caught => caught);
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ message: FAILED, category: "transient" });
    expect(error).not.toHaveProperty("cause");
    expect(inspect(error)).not.toMatch(/127\.0\.0\.1|ECONNRESET|terminated/);
    expect(counts()).toEqual({ connections: 1, requests: 1 });
  });

  // Fetch's parser errors keep the node's raw bytes in HTTPParserError.data.
  it.each([
    { kind: "an invalid status line", reply: "XYZZY NODE-SECRET-TEXT injected\r\n\r\n" },
    {
      kind: "a bad chunk size mid-body",
      reply: 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n{"res\r\nzzNODE-SECRET-TEXT\r\n',
    },
  ])("replaces the Fetch parser error for $kind, without a retry", async ({ reply }) => {
    const { adapter, port, counts } = await serve(request => {
      request.resume().on("end", () => request.socket.end(reply));
    });
    const error = await adapter.resolveIdentity("subject").catch(caught => caught);
    expect(error).toBeInstanceOf(SubstrateError);
    expect(error).toMatchObject({ message: READ_FAILED, category: "substrate" });
    expect(error).not.toHaveProperty("cause");
    expect(inspect(error, { depth: 10 })).not.toMatch(
      new RegExp(`NODE-SECRET-TEXT|XYZZY|HPE_|127\\.0\\.0\\.1|\\b${port}\\b|fetch failed|terminated`),
    );
    expect(counts()).toEqual({ connections: 1, requests: 1 });
  });
});
