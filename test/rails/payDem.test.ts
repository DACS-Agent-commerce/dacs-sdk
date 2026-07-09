import { describe, expect, test } from "vitest";

import {
  payDemSettleCore,
  payDemSettle,
  type DemosNativeClient,
  type DemosTransferResult,
  type PayDemRail,
} from "../../src/rails/payDem.js";

const RECIPIENT = "demos1recipientaddress0000000000000000000000";
const PAYER = "demos1payeraddress00000000000000000000000000";

/** A fake native client recording the transfer it was asked to submit. */
function fakeClient(
  over: Partial<{ result: DemosTransferResult }> = {},
): DemosNativeClient & { sent?: { to: string; amountOs: bigint } } {
  const self: DemosNativeClient & { sent?: { to: string; amountOs: bigint } } = {
    address: PAYER,
    async transfer(args) {
      self.sent = args;
      return (
        over.result ?? { ok: true, state: "included", hash: "demos:0xabc", blockNumber: 4242 }
      );
    },
  };
  return self;
}

const params = (over: Record<string, unknown> = {}) => ({
  recipient: RECIPIENT,
  amount: "1500000000", // 1.5 DEM in OS base units
  network: "demos:testnet",
  ...over,
});

describe("payDemSettleCore (§9.5.9 native DEM)", () => {
  test("happy path: transfers OS base units and reports a bft-final demos txRef", async () => {
    const client = fakeClient();
    const res = await payDemSettleCore(params(), client);
    expect(res.ok).toBe(true);
    expect(res.txHash).toBe("demos:0xabc");
    expect(res.payer).toBe(PAYER);
    expect(res.payee).toBe(RECIPIENT);
    expect(res.chainId).toBe("demos:testnet");
    // §9.5.9 evidence shape: bft-final finality, demos txRef kind, block height.
    expect(res.finality).toEqual({ model: "bft-final" });
    expect(res.txRefKind).toBe("demos");
    expect(res.blockNumber).toBe(4242);
    expect(client.sent).toEqual({ to: RECIPIENT, amountOs: 1_500_000_000n });
  });

  test("amount is parsed as an integer OS bigint (no floats)", async () => {
    const client = fakeClient();
    await payDemSettleCore(params({ amount: "1000000000" }), client);
    expect(client.sent!.amountOs).toBe(1_000_000_000n);
  });

  test("rejects a non-integer / invalid base-unit amount", async () => {
    await expect(payDemSettleCore(params({ amount: "1.5" }), fakeClient())).rejects.toThrow(
      /invalid OS base-unit amount/,
    );
  });

  test("rejects a non-positive amount", async () => {
    await expect(payDemSettleCore(params({ amount: "0" }), fakeClient())).rejects.toThrow(
      /amount must be > 0/,
    );
  });

  test("a broadcast that fails is reported ok:false (hash preserved)", async () => {
    const client = fakeClient({
      result: { ok: false, state: "failed", hash: "demos:0xtried", message: "rejected" },
    });
    const res = await payDemSettleCore(params(), client);
    expect(res.ok).toBe(false);
    expect(res.txHash).toBe("demos:0xtried");
    expect(res.finality).toBeUndefined();
  });

  test("ok:true but no hash → ok:false (no unverifiable receipt)", async () => {
    const client = fakeClient({ result: { ok: true, state: "included", hash: "", blockNumber: 1 } });
    const res = await payDemSettleCore(params(), client);
    expect(res.ok).toBe(false);
  });

  test("broadcast ACCEPTANCE without observed inclusion → ok:false, no bft-final (steward finding)", async () => {
    // ok:true + a hash but NO terminal inclusion state: the node accepted the tx
    // for submission, it hasn't been observed to land. Must not mint bft-final.
    const client = fakeClient({ result: { ok: true, hash: "demos:0xaccepted", blockNumber: 9 } });
    const res = await payDemSettleCore(params(), client);
    expect(res.ok).toBe(false);
    expect(res.finality).toBeUndefined();
    expect(res.blockNumber).toBeUndefined();
  });

  test("terminal inclusion state but NO block height → ok:false (finality witness missing)", async () => {
    const client = fakeClient({ result: { ok: true, state: "included", hash: "demos:0xabc" } });
    const res = await payDemSettleCore(params(), client);
    expect(res.ok).toBe(false);
    expect(res.finality).toBeUndefined();
  });

  test("a poll that timed out (nonterminal) → ok:false, no evidence", async () => {
    const client = fakeClient({ result: { ok: false, state: "timeout", hash: "demos:0xpending" } });
    const res = await payDemSettleCore(params(), client);
    expect(res.ok).toBe(false);
    expect(res.finality).toBeUndefined();
  });

  test("confirmed/finalized also count as observed inclusion", async () => {
    for (const state of ["confirmed", "finalized"]) {
      const client = fakeClient({ result: { ok: true, state, hash: "demos:0xok", blockNumber: 7 } });
      const res = await payDemSettleCore(params(), client);
      expect(res.ok).toBe(true);
      expect(res.finality).toEqual({ model: "bft-final" });
      expect(res.blockNumber).toBe(7);
    }
  });
});

describe("payDemSettle (runSession seam bridge)", () => {
  test("threads the per-session amount through to the rail", async () => {
    const client = fakeClient();
    const rail: PayDemRail = {
      address: PAYER,
      settle: (p) => payDemSettleCore(p, client),
    };
    const settle = payDemSettle(rail, { recipient: RECIPIENT, network: "demos" });
    const res = await settle({ rail: "pay-dem", amount: "2000000000", asset: "DEM", payee: RECIPIENT, jobId: "j1" });
    expect(res.ok).toBe(true);
    expect(client.sent!.amountOs).toBe(2_000_000_000n);
    expect(res.finality).toEqual({ model: "bft-final" });
  });
});
