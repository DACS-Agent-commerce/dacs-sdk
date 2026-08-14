import { describe, expect, test } from "vitest";

import {
  payDemSettleCore,
  payDemSettle,
  type DemosNativeClient,
  type DemosTransferResult,
  type PayDemRail,
} from "../../src/rails/payDem.js";
import {
  createIdempotencyStore,
  createInMemorySettlementLog,
} from "../../src/rails/idempotency.js";

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

describe("payDemSettle (runSession seam bridge — §9.5.9 DEM→OS conversion, PB-2 destination)", () => {
  // A Demos primary claim intrinsically embeds the ed25519 pubkey hex.
  const SELLER_HEX = "a1".repeat(32);
  const PAYEE_CLAIM = `did:demos:agent:${SELLER_HEX}`;
  const OTHER_HEX = "b2".repeat(32);

  const settleWith = (
    client: ReturnType<typeof fakeClient>,
    cfg: { recipient?: string; network?: string } = { recipient: PAYEE_CLAIM, network: "demos" },
  ) => {
    const rail: PayDemRail = { address: PAYER, settle: (p) => payDemSettleCore(p, client) };
    return payDemSettle(rail, cfg);
  };
  const req = (over: Record<string, unknown> = {}) => ({
    rail: "pay-dem",
    phase: "pay-dem",
    amount: "5",
    asset: "DEM",
    payee: PAYEE_CLAIM,
    expectedPayee: SELLER_HEX,
    jobId: "j1",
    ...over,
  });

  test("converts the agreement's DECIMAL DEM to integer OS base units (×10^9)", async () => {
    const client = fakeClient();
    const res = await settleWith(client)(req({ amount: "5" }));
    expect(res.ok).toBe(true);
    // "5" DEM must move 5 × 10^9 OS — NOT 5 OS (the pre-fix silent 10^-9 bug).
    expect(client.sent!.amountOs).toBe(5_000_000_000n);
    expect(res.finality).toEqual({ model: "bft-final" });
  });

  test("handles fractional DEM within the 9-decimal precision", async () => {
    const client = fakeClient();
    await settleWith(client)(req({ amount: "5.1" }));
    expect(client.sent!.amountOs).toBe(5_100_000_000n);
  });

  test("SAFE BY DEFAULT: repeated settlement for one session phase submits once", async () => {
    const client = fakeClient();
    let transfers = 0;
    const rail: PayDemRail = {
      address: PAYER,
      settle: async (params) => {
        transfers += 1;
        return payDemSettleCore(params, client);
      },
    };
    const settle = payDemSettle(rail, { network: "demos" });
    const first = await settle(req());
    const second = await settle(req());
    expect(transfers).toBe(1);
    expect(second).toEqual(first);
  });

  test("an injected durable store dedupes across bridge instances after restart", async () => {
    const client = fakeClient();
    let transfers = 0;
    const rail: PayDemRail = {
      address: PAYER,
      settle: async (params) => {
        transfers += 1;
        return payDemSettleCore(params, client);
      },
    };
    const store = createIdempotencyStore(createInMemorySettlementLog());
    await payDemSettle(rail, { network: "demos" }, { store })(req());
    const resumed = await payDemSettle(rail, { network: "demos" }, { store })(req());
    expect(transfers).toBe(1);
    expect(resumed.txHash).toBe("demos:0xabc");
  });

  test("rejects a non-DEM asset (pay-dem settles DEM only)", async () => {
    await expect(settleWith(fakeClient())(req({ asset: "USDC" }))).rejects.toThrow(
      /settles DEM only/,
    );
  });

  test("rejects sub-OS precision (> 9 fractional digits)", async () => {
    await expect(
      settleWith(fakeClient())(req({ amount: "5.0000000001" })),
    ).rejects.toThrow(/precision/);
  });

  // ── PB-2 Tier 1: the destination comes from the AGREEMENT, not from config ──

  test("transfers to the agreement's payee (derived intrinsically from the claim)", async () => {
    const client = fakeClient();
    await settleWith(client)(req());
    expect(client.sent!.to).toBe(SELLER_HEX);
  });

  test("the request payee determines the destination with NO configured recipient", async () => {
    const client = fakeClient();
    await settleWith(client, { network: "demos" })(req());
    expect(client.sent!.to).toBe(SELLER_HEX);
  });

  test("normalizes a same-address Demos DID request binding and returns it verbatim", async () => {
    const client = fakeClient();
    const result = await settleWith(client, { network: "demos" })(
      req({ expectedPayee: PAYEE_CLAIM }),
    );
    expect(client.sent!.to).toBe(SELLER_HEX);
    expect(result.payee).toBe(PAYEE_CLAIM);
  });

  test("rejects an expected destination mismatch before transfer", async () => {
    const client = fakeClient();
    await expect(
      settleWith(client, { network: "demos" })(
        req({ expectedPayee: OTHER_HEX }),
      ),
    ).rejects.toThrow(/destination mismatch/);
    expect(client.sent).toBeUndefined();
  });

  test("a configured recipient that is NOT the agreement payee ABORTS — and performs NO transfer", async () => {
    const client = fakeClient();
    await expect(
      settleWith(client, { recipient: OTHER_HEX, network: "demos" })(req()),
    ).rejects.toThrow(/destination mismatch|PB-2/);
    // The money-safety assertion: nothing was sent.
    expect(client.sent).toBeUndefined();
  });

  test("a payee that does not intrinsically resolve to an address is rejected with NO transfer", async () => {
    const client = fakeClient();
    await expect(
      settleWith(client, { network: "demos" })(req({ payee: "did:example:alias-only" })),
    ).rejects.toThrow(/does not intrinsically resolve/);
    expect(client.sent).toBeUndefined();
  });

  test("STRICT: a non-Demos scheme ending in 64 hex is NOT Demos-bound → no transfer (#32)", async () => {
    const client = fakeClient();
    // did:ethr:…<64hex> ends in 64 hex but is a foreign scheme; must be rejected.
    await expect(
      settleWith(client, { network: "demos" })(req({ payee: `did:ethr:${SELLER_HEX}` })),
    ).rejects.toThrow(/does not intrinsically resolve/);
    expect(client.sent).toBeUndefined();
    // A CCI cross-chain claim carrying an 0x address is likewise not intrinsically Demos.
    await expect(
      settleWith(client, { network: "demos" })(req({ payee: `cci-xm:evm:mainnet:0x${SELLER_HEX}` })),
    ).rejects.toThrow(/does not intrinsically resolve/);
    expect(client.sent).toBeUndefined();
  });

  test("an equivalent claim form (0x / bare hex) matches the same address", async () => {
    const client = fakeClient();
    await settleWith(client, { recipient: `0x${SELLER_HEX}` })(req());
    expect(client.sent!.to).toBe(SELLER_HEX);
  });

  test("the DACS-1 Demos cci-xm profile resolves intrinsically", async () => {
    const client = fakeClient();
    const claim = `cci-xm:demos:testnet:0x${SELLER_HEX}?region=uk`;
    await settleWith(client, { recipient: `0x${SELLER_HEX}` })(req({ payee: claim }));
    expect(client.sent!.to).toBe(SELLER_HEX);
  });

  test.each([
    `cci-xm:demos::0x${SELLER_HEX}`,
    `cci-xm:demos:testnet:${SELLER_HEX}`,
    `cci-xm:demos:testnet:0x${SELLER_HEX.slice(2)}`,
    `cci-xm:evm:testnet:0x${SELLER_HEX}`,
    `cci-xm:demos:testnet:0x${SELLER_HEX}?`,
    `cci-xm:demos:testnet:0x${SELLER_HEX}?region`,
    `did:demos:${SELLER_HEX}`,
    `did:demos:evil:${SELLER_HEX}`,
    `did:demos:agent:0x${SELLER_HEX}`,
    `did:demos:agent:${SELLER_HEX.toUpperCase()}`,
  ])("rejects a malformed or foreign cci-xm Demos lookalike: %s", async (payee) => {
    const client = fakeClient();
    await expect(
      settleWith(client, { network: "demos" })(req({ payee })),
    ).rejects.toThrow(/does not intrinsically resolve/);
    expect(client.sent).toBeUndefined();
  });
});
