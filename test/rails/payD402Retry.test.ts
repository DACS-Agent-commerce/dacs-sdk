import { describe, expect, test } from "vitest";

import type { SettleRequest } from "../../src/agent/runSessionCore.js";
import { createIdempotencyStore } from "../../src/rails/idempotency.js";
import {
  payD402Settle, payD402SettleCore,
  type PayD402Rail, type PayD402SettleCoreDeps, type PayD402SettleParams,
} from "../../src/rails/payD402.js";

const RECIPIENT = "demos1recipientaddress0000000000000000000000";
const PAYER = "demos1payeraddress00000000000000000000000000";
const URL = "https://seller.example/premium";
const paywall = { url: URL, recipient: RECIPIENT, network: "demos:testnet" };
const params = (): PayD402SettleParams => ({
  paywallUrl: URL, recipient: RECIPIENT, amount: "1500000000", network: "demos:testnet",
});
const request = (over: Partial<SettleRequest> = {}): SettleRequest => ({
  rail: "pay-d402", phase: "pay-d402", amount: "1.5", asset: "DEM",
  payee: "did:demos:seller", expectedPayee: RECIPIENT, jobId: "bridge-job", phaseIndex: 0, ...over,
});
function fetch402(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 402 })) as typeof fetch;
}
function fakeClient(): PayD402SettleCoreDeps["client"] & { paid?: { amount: string | number } } {
  const client: ReturnType<typeof fakeClient> = {
    async createPayment(requirement) { client.paid = requirement; return { tx: "unsigned" }; },
    async settle() { return { success: true, hash: "0xdemhash", blockNumber: 42 }; },
  };
  return client;
}
const railOver = (
  client: ReturnType<typeof fakeClient>,
  fetchImpl = fetch402({ recipient: RECIPIENT, amount: "1500000000", resourceId: "res-1" }),
): PayD402Rail => ({
  address: PAYER,
  settle: (p) => payD402SettleCore(p, { client, fetchImpl, payerAddress: PAYER }),
  async waitForSettlement() { throw new Error("unused"); },
});
const bridge = (rail: PayD402Rail) => payD402Settle(rail, paywall, { store: createIdempotencyStore() });

// Permanent versions of the cached-error and concurrent-waiter review probes.
describe("D402 preflight retry isolation", () => {
  test.each(["createPayment", "settle"] as const)(
    "a cached preflight cause thrown by %s retains the payment claim",
    async (stage) => {
      const cached = new Error("cached transport failure");
      const client = fakeClient();
      let fetches = 0;
      let effects = 0;
      const healthy = fetch402({ recipient: RECIPIENT, amount: "1500000000", resourceId: "res-1" });
      const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
        if (++fetches === 1) throw cached;
        return healthy(...args);
      }) as typeof fetch;
      client[stage] = async () => { effects += 1; throw cached; };
      const settle = bridge(railOver(client, fetchImpl));
      await expect(settle(request())).rejects.toBe(cached);
      await expect(settle(request())).rejects.toBe(cached);
      await expect(settle(request())).rejects.toThrow(/refusing to resubmit/);
      expect(effects).toBe(1);
      expect(fetches).toBe(2);
    },
  );

  test("a preflight exception cached by a custom rail cannot release another invocation", async () => {
    let cached: unknown;
    const client = fakeClient();
    const coreRail = railOver(client, (async () => { throw new Error("preflight"); }) as typeof fetch);
    let effects = 0;
    const rail: PayD402Rail = {
      ...coreRail,
      async settle(p) {
        if (cached === undefined) {
          try { await coreRail.settle(p); } catch (err) { cached = err; throw err; }
        }
        effects += 1;
        throw cached;
      },
    };
    const settle = bridge(rail);
    await expect(settle(request({ jobId: "first-job" }))).rejects.toThrow("preflight");
    await expect(settle(request())).rejects.toThrow("preflight");
    await expect(settle(request())).rejects.toThrow(/refusing to resubmit/);
    expect(effects).toBe(1);
  });

  test.each([false, true])(
    "all concurrent preflight waiters reject and can retry (separate bridges: %s)",
    async (separateBridges) => {
      const store = createIdempotencyStore();
      const cached = new Error("fetch failed before payment");
      let fail!: (err: unknown) => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const blocked = new Promise<Response>((_, reject) => { fail = reject; });
      const client = fakeClient();
      let fetches = 0;
      const healthy = fetch402({ recipient: RECIPIENT, amount: "1500000000", resourceId: "res-1" });
      const rail = railOver(client, (async (...args: Parameters<typeof fetch>) => {
        if (++fetches === 1) { entered(); return blocked; }
        return healthy(...args);
      }) as typeof fetch);
      const first = payD402Settle(rail, paywall, { store });
      const second = separateBridges ? payD402Settle(rail, paywall, { store }) : first;
      const submitting = first(request());
      await started;
      const following = second(request());
      const outcomes = Promise.allSettled([submitting, following]);
      fail(cached);
      expect(await outcomes).toEqual([
        { status: "rejected", reason: cached },
        { status: "rejected", reason: cached },
      ]);
      expect(client.paid).toBeUndefined();
      expect(fetches).toBe(1);
      expect(await second(request())).toMatchObject({ ok: true, txHash: "0xdemhash" });
      expect(client.paid?.amount).toBe("1500000000");
    },
  );

  test("a previous job's preflight cause cannot release a custom rail's later payment", async () => {
    const shared = new Error("shared transport error");
    let calls = 0;
    let broadcasts = 0;
    const rail: PayD402Rail = {
      address: PAYER,
      async settle() {
        calls += 1;
        if (calls === 1) {
          return payD402SettleCore(params(), {
            client: fakeClient(),
            fetchImpl: (async () => { throw shared; }) as typeof fetch,
            payerAddress: PAYER,
          });
        }
        broadcasts += 1;
        if (calls === 2) throw shared;
        return { ok: true, txHash: `0x${broadcasts}`, chainId: "demos:testnet", payer: PAYER,
          payee: RECIPIENT, blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" } };
      },
      async waitForSettlement() { throw new Error("unused"); },
    };
    const settle = bridge(rail);
    await expect(settle(request({ jobId: "unrelated" }))).rejects.toThrow("shared transport error");
    await expect(settle(request())).rejects.toBe(shared);
    await expect(settle(request())).rejects.toThrow(/refusing to resubmit/);
    expect({ calls, broadcasts }).toEqual({ calls: 2, broadcasts: 1 });
  });

});
