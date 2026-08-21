import { describe, expect, test, vi } from "vitest";

import type { SettleResult } from "../../src/agent/runSessionCore.js";
import {
  TERMINAL_INCLUDED,
  payDemSettleCore,
  payDemSettle,
  type DemosNativeClient,
  type DemosTransferResult,
  type PayDemRail,
  type PayDemSettlementReconcile,
} from "../../src/rails/payDem.js";
import {
  createIdempotencyStore,
  createInMemorySettlementLog,
  type SettlementLog,
} from "../../src/rails/idempotency.js";

const RECIPIENT = "d4".repeat(32);
const PAYER = "c3".repeat(32);
const TX_HASH = "12".repeat(32);
const OTHER_TX_HASH = "34".repeat(32);

/** A fake native client recording the transfer it was asked to submit. */
function fakeClient(
  over: Partial<{ result: DemosTransferResult }> = {},
): DemosNativeClient & { sent?: Parameters<DemosNativeClient["transfer"]>[0] } {
  const self: DemosNativeClient & {
    sent?: Parameters<DemosNativeClient["transfer"]>[0];
  } = {
    address: PAYER,
    async transfer(args) {
      self.sent = args;
      return (
        over.result ?? { ok: true, state: "included", hash: TX_HASH, blockNumber: 4242 }
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("payDemSettleCore (§9.5.9 native DEM)", () => {
  test("happy path: transfers OS base units and reports a bft-final demos txRef", async () => {
    const client = fakeClient();
    const res = await payDemSettleCore(params(), client);
    expect(res.ok).toBe(true);
    expect(res.txHash).toBe(TX_HASH);
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
      result: { ok: false, state: "failed", hash: OTHER_TX_HASH, message: "rejected" },
    });
    const res = await payDemSettleCore(params(), client);
    expect(res.ok).toBe(false);
    expect(res.txHash).toBe(OTHER_TX_HASH);
    expect(res.finality).toBeUndefined();
  });

  test("rejects a malformed tx-bearing result so its intent remains held", async () => {
    const client = fakeClient({
      result: { ok: true, state: "included", hash: "not-a-hash", blockNumber: 1 },
    });
    await expect(payDemSettleCore(params(), client)).rejects.toThrow(
      /hash must be a 32-byte hex value/,
    );
  });

  test.each(["", undefined])(
    "rejects a missing/empty transfer identity (%s) so it cannot authorize retry",
    async (hash) => {
      const result = {
        ok: false,
        state: "failed",
        ...(hash === undefined ? {} : { hash }),
      } as DemosTransferResult;
      await expect(
        payDemSettleCore(params(), fakeClient({ result })),
      ).rejects.toThrow(/hash must be a 32-byte hex value/);
    },
  );

  test("canonicalizes an optional 0x-prefixed uppercase Demos hash", async () => {
    const client = fakeClient({
      result: {
        ok: true,
        state: "included",
        hash: `0x${TX_HASH.toUpperCase()}`,
        blockNumber: 1,
      },
    });
    await expect(payDemSettleCore(params(), client)).resolves.toMatchObject({
      ok: true,
      txHash: TX_HASH,
    });
  });

  test("broadcast ACCEPTANCE without observed inclusion → ok:false, no bft-final (steward finding)", async () => {
    // ok:true + a hash but NO terminal inclusion state: the node accepted the tx
    // for submission, it hasn't been observed to land. Must not mint bft-final.
    const client = fakeClient({ result: { ok: true, hash: TX_HASH, blockNumber: 9 } });
    const res = await payDemSettleCore(params(), client);
    expect(res.ok).toBe(false);
    expect(res.finality).toBeUndefined();
    expect(res.blockNumber).toBeUndefined();
  });

  test("terminal inclusion state but NO block height → ok:false (finality witness missing)", async () => {
    const client = fakeClient({ result: { ok: true, state: "included", hash: TX_HASH } });
    const res = await payDemSettleCore(params(), client);
    expect(res.ok).toBe(false);
    expect(res.finality).toBeUndefined();
  });

  test("a poll that timed out (nonterminal) → ok:false, no evidence", async () => {
    const client = fakeClient({ result: { ok: false, state: "timeout", hash: TX_HASH } });
    const res = await payDemSettleCore(params(), client);
    expect(res.ok).toBe(false);
    expect(res.finality).toBeUndefined();
  });

  test("accepts the exact DACS-4 §9.5.9 terminal included state", async () => {
    expect([...TERMINAL_INCLUDED]).toEqual(["included"]);
    const client = fakeClient({
      result: { ok: true, state: "included", hash: TX_HASH, blockNumber: 7 },
    });
    await expect(payDemSettleCore(params(), client)).resolves.toMatchObject({
      ok: true,
      finality: { model: "bft-final" },
      blockNumber: 7,
    });
  });

  test.each(["confirmed", "finalized", "INCLUDED", "accepted"])(
    "fails closed for non-normative terminal state %s",
    async (state) => {
      const client = fakeClient({
        result: { ok: true, state, hash: TX_HASH, blockNumber: 7 },
      });
      const res = await payDemSettleCore(params(), client);
      expect(res.ok).toBe(false);
      expect(res.finality).toBeUndefined();
      expect(res.blockNumber).toBeUndefined();
    },
  );

  test("does not let the compatibility set widen normative acceptance", async () => {
    TERMINAL_INCLUDED.add("confirmed");
    try {
      const client = fakeClient({
        result: { ok: true, state: "confirmed", hash: TX_HASH, blockNumber: 7 },
      });
      const res = await payDemSettleCore(params(), client);
      expect(res.ok).toBe(false);
      expect(res.finality).toBeUndefined();
    } finally {
      TERMINAL_INCLUDED.delete("confirmed");
    }
  });

  test("pins payer, payee, network and transfer method before the effect await", async () => {
    const response = deferred<DemosTransferResult>();
    const originalTransfer = async (_args: { to: string; amountOs: bigint }) =>
      response.promise;
    const client: DemosNativeClient = {
      address: PAYER,
      transfer: originalTransfer,
    };
    const input = params();
    const settlement = payDemSettleCore(input, client);

    input.recipient = "substituted-payee";
    input.network = "substituted-network";
    client.address = "substituted-payer";
    client.transfer = async () => ({
      ok: true,
      state: "included",
      hash: "substituted-hash",
      blockNumber: 99,
    });
    response.resolve({
      ok: true,
      state: "included",
      hash: TX_HASH,
      blockNumber: 12,
    });

    await expect(settlement).resolves.toMatchObject({
      payer: PAYER,
      payee: RECIPIENT,
      chainId: "demos:testnet",
      txHash: TX_HASH,
    });
  });

  test("ignores a poisoned transfer bind while preserving its receiver", async () => {
    class ReceiverClient implements DemosNativeClient {
      readonly address = PAYER;
      readonly calls: bigint[] = [];

      async transfer(args: { to: string; amountOs: bigint }) {
        this.calls.push(args.amountOs);
        return {
          ok: true,
          state: "included",
          hash: TX_HASH,
          blockNumber: 12,
        };
      }
    }
    const client = new ReceiverClient();
    const poison = vi.fn(() => vi.fn(async () => {
      throw new Error("poisoned bind callback executed");
    }));
    Object.defineProperty(client.transfer, "bind", {
      configurable: true,
      value: poison,
    });

    await expect(payDemSettleCore(params(), client)).resolves.toMatchObject({
      ok: true,
      txHash: TX_HASH,
    });
    expect(poison).not.toHaveBeenCalled();
    expect(client.calls).toEqual([1_500_000_000n]);
  });

  test("rejects accessor/proxy parameters without invoking caller traps", async () => {
    let reads = 0;
    const accessorParams = {
      get recipient() {
        reads += 1;
        return RECIPIENT;
      },
      amount: "1",
      network: "demos",
    } as unknown as Parameters<typeof payDemSettleCore>[0];
    await expect(payDemSettleCore(accessorParams, fakeClient())).rejects.toThrow(
      /must be stable data/,
    );
    expect(reads).toBe(0);

    const proxiedClient = new Proxy(fakeClient(), {
      get(target, property, receiver) {
        reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    await expect(payDemSettleCore(params(), proxiedClient)).rejects.toThrow(
      /must be stable data/,
    );
    expect(reads).toBe(0);
  });

  test("rejects an accessor transfer result without invoking its getters", async () => {
    let reads = 0;
    const client: DemosNativeClient = {
      address: PAYER,
      async transfer() {
        return {
          get ok() {
            reads += 1;
            return true;
          },
          hash: "demos:0xunsafe",
          state: "included",
          blockNumber: 1,
        } as DemosTransferResult;
      },
    };
    await expect(payDemSettleCore(params(), client)).rejects.toThrow(
      /must be stable data/,
    );
    expect(reads).toBe(0);
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
    phaseIndex: 0,
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

  test("a tx-bearing timeout holds the intent and never submits a second payment", async () => {
    let transfers = 0;
    const client = fakeClient({
      result: { ok: false, state: "timeout", hash: TX_HASH },
    });
    const rail: PayDemRail = {
      address: PAYER,
      settle: async (params) => {
        transfers += 1;
        return payDemSettleCore(params, client);
      },
    };
    const settle = payDemSettle(rail, { network: "demos" });

    await expect(settle(req())).resolves.toMatchObject({
      ok: false,
      txHash: TX_HASH,
    });
    await expect(settle(req())).rejects.toThrow(/refusing to resubmit/);
    expect(transfers).toBe(1);
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
    const reconcile = vi.fn(async (context) => ({
      ok: true,
      txHash: TX_HASH,
      chainId: context.network,
      payer: context.payer,
      payee: context.payee,
      finality: { model: "bft-final" as const },
      blockNumber: 4242,
      txRefKind: "demos",
      amountOs: context.amountOs,
    }));
    const resumed = await payDemSettle(rail, { network: "demos" }, {
      store,
      reconcile,
    })(req());
    expect(transfers).toBe(1);
    expect(resumed.txHash).toBe(TX_HASH);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  test("durably recovers intent → journal → ambiguity → restart under the same exact tuple", async () => {
    const outcomes = new Map<string, SettleResult>();
    const intents = new Set<string>();
    const lifecycle: string[] = [];
    const log: SettlementLog = {
      async getOutcome(key) {
        lifecycle.push(`load:${key}`);
        return outcomes.get(key);
      },
      async putOutcome(key, result) {
        lifecycle.push(`outcome:${key}`);
        outcomes.set(key, result);
      },
      async claimIntent(key) {
        lifecycle.push(`intent:${key}`);
        if (intents.has(key)) return "held";
        intents.add(key);
        return "claimed";
      },
      async releaseIntent(key) {
        lifecycle.push(`release:${key}`);
        intents.delete(key);
      },
    };
    const contexts: unknown[] = [];
    let transfers = 0;
    const firstRail: PayDemRail = {
      address: PAYER,
      async settle(input) {
        transfers += 1;
        lifecycle.push(`journal:${input.recovery?.settlementKey}`);
        contexts.push(input.recovery);
        return {
          ok: false,
          txHash: TX_HASH,
          chainId: "demos",
          payer: PAYER,
          payee: SELLER_HEX,
        };
      },
    };
    const request = req({
      rail: "demos-native:DEM",
      jobId: "job-restart",
      phaseIndex: 3,
      amount: "1.25",
    });
    const firstStore = createIdempotencyStore(log);
    await expect(payDemSettle(firstRail, { network: "demos" }, {
      store: firstStore,
    })(request)).resolves.toMatchObject({ ok: false, txHash: TX_HASH });

    const restartedRail: PayDemRail = {
      address: PAYER,
      settle: vi.fn(async () => {
        throw new Error("must not rebroadcast");
      }),
    };
    const reconcile = vi.fn(async (context) => ({
      ok: true,
      txHash: TX_HASH,
      chainId: context.network,
      payer: context.payer,
      payee: context.payee,
      finality: { model: "bft-final" as const },
      blockNumber: 95563,
      txRefKind: "demos",
      amountOs: context.amountOs,
    }));
    const restartedStore = createIdempotencyStore(log);
    const recovered = await payDemSettle(restartedRail, { network: "demos" }, {
      store: restartedStore,
      reconcile,
    })(request);

    const key = "demos-native:DEM:job-restart:3";
    expect(recovered).toMatchObject({
      ok: true,
      txHash: TX_HASH,
      blockNumber: 95563,
      txRefKind: "demos",
    });
    expect(transfers).toBe(1);
    expect(restartedRail.settle).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith({
      railId: "demos-native:DEM",
      jobId: "job-restart",
      phaseIndex: 3,
      settlementKey: key,
      network: "demos",
      payer: PAYER,
      payee: SELLER_HEX,
      amountOs: "1250000000",
    });
    expect(contexts).toEqual([expect.objectContaining({
      settlementKey: key,
      amountOs: "1250000000",
    })]);
    expect(lifecycle.indexOf(`intent:${key}`)).toBeLessThan(
      lifecycle.indexOf(`journal:${key}`),
    );
    expect(lifecycle).toContain(`outcome:${key}`);
  });

  test("a non-final reconciliation cannot authorize rebroadcast", async () => {
    const log = createInMemorySettlementLog();
    await log.claimIntent("demos-native:DEM:job-ambiguous:1");
    const rail: PayDemRail = {
      address: PAYER,
      settle: vi.fn(async () => {
        throw new Error("must not rebroadcast");
      }),
    };
    const reconcile = vi.fn(async (context) => ({
      ok: false,
      txHash: TX_HASH,
      chainId: context.network,
      payer: context.payer,
      payee: context.payee,
      amountOs: context.amountOs,
    }));

    await expect(payDemSettle(rail, { network: "demos" }, {
      store: createIdempotencyStore(log),
      reconcile: reconcile as unknown as PayDemSettlementReconcile,
    })(req({
      rail: "demos-native:DEM",
      jobId: "job-ambiguous",
      phaseIndex: 1,
    }))).rejects.toThrow(/only null proof-of-absence may authorize resubmission/);
    expect(rail.settle).not.toHaveBeenCalled();
  });

  test.each([
    ["amount", { amountOs: "1" }, /exact requested OS amount/],
    ["network", { chainId: "demos:other" }, /network, payer, and payee/],
    ["payer", { payer: OTHER_HEX }, /network, payer, and payee/],
    ["payee", { payee: OTHER_HEX }, /network, payer, and payee/],
    ["hash", { txHash: "not-a-hash" }, /transaction hash/],
    ["tx ref", { txRefKind: "payment" }, /non-Demos transaction reference/],
    ["finality", { finality: { model: "provider-receipt" } }, /bft-final finality/],
    ["block", { blockNumber: -1 }, /block number/],
  ])("rejects malicious %s reconciliation without rebroadcast", async (
    _label,
    override,
    pattern,
  ) => {
    const key = "demos-native:DEM:job-malicious:2";
    const log = createInMemorySettlementLog();
    await log.claimIntent(key);
    const rail: PayDemRail = {
      address: PAYER,
      settle: vi.fn(async () => {
        throw new Error("must not rebroadcast");
      }),
    };
    const reconcile = vi.fn(async (context) => ({
      ok: true,
      txHash: TX_HASH,
      chainId: context.network,
      payer: context.payer,
      payee: context.payee,
      finality: { model: "bft-final" as const },
      blockNumber: 9,
      txRefKind: "demos",
      amountOs: context.amountOs,
      ...override,
    }));

    await expect(payDemSettle(rail, { network: "demos" }, {
      store: createIdempotencyStore(log),
      reconcile: reconcile as unknown as PayDemSettlementReconcile,
    })(req({
      rail: "demos-native:DEM",
      jobId: "job-malicious",
      phaseIndex: 2,
    }))).rejects.toThrow(pattern);
    expect(rail.settle).not.toHaveBeenCalled();
  });

  test("a cached success is reauthenticated after restart against amount and tx identity", async () => {
    const log = createInMemorySettlementLog();
    const key = "demos-native:DEM:job-cached:5";
    await log.putOutcome(key, {
      ok: true,
      txHash: TX_HASH,
      chainId: "demos",
      payer: PAYER,
      payee: SELLER_HEX,
      finality: { model: "bft-final" },
      blockNumber: 7,
      txRefKind: "demos",
    });
    const rail: PayDemRail = {
      address: PAYER,
      settle: vi.fn(async () => {
        throw new Error("must not rebroadcast");
      }),
    };
    const reconcile = vi.fn(async (context) => ({
      ok: true,
      txHash: OTHER_TX_HASH,
      chainId: context.network,
      payer: context.payer,
      payee: context.payee,
      finality: { model: "bft-final" as const },
      blockNumber: 7,
      txRefKind: "demos",
      amountOs: context.amountOs,
    }));

    await expect(payDemSettle(rail, { network: "demos" }, {
      store: createIdempotencyStore(log),
      reconcile,
    })(req({
      rail: "demos-native:DEM",
      jobId: "job-cached",
      phaseIndex: 5,
      amount: "2",
    }))).rejects.toThrow(/does not match the authoritative reconciled transaction/);
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      amountOs: "2000000000",
    }));
    expect(rail.settle).not.toHaveBeenCalled();
  });

  test("rejects a malformed fresh success before the durable store persists it", async () => {
    const backing = createInMemorySettlementLog();
    const putOutcome = vi.spyOn(backing, "putOutcome");
    const rail: PayDemRail = {
      address: PAYER,
      settle: vi.fn(async (input) => ({
        ok: true,
        txHash: TX_HASH,
        chainId: input.network ?? "demos",
        payer: PAYER,
        payee: input.recipient,
        finality: { model: "provider-receipt" },
        blockNumber: 1,
        txRefKind: "demos",
      })),
    } as unknown as PayDemRail;

    await expect(payDemSettle(rail, { network: "demos" }, {
      store: createIdempotencyStore(backing),
    })(req({
      rail: "demos-native:DEM",
      jobId: "job-fresh-invalid",
      phaseIndex: 1,
    }))).rejects.toThrow(/bft-final finality/);
    expect(putOutcome).not.toHaveBeenCalled();
  });

  test("rejects an invalid cached success without invoking submit or reconciliation", async () => {
    const rail: PayDemRail = {
      address: PAYER,
      settle: vi.fn(async () => {
        throw new Error("must not rebroadcast");
      }),
    };
    const cached = {
      ok: true,
      txHash: TX_HASH,
      chainId: "demos",
      payer: PAYER,
      payee: SELLER_HEX,
      finality: { model: "provider-receipt" as const },
      blockNumber: 1,
      txRefKind: "demos",
    };
    const store = {
      once: vi.fn(async () => cached as unknown as SettleResult),
    };
    const reconcile = vi.fn(async () => {
      throw new Error("invalid cache must fail before reconciliation");
    });

    await expect(payDemSettle(rail, { network: "demos" }, {
      store,
      reconcile: reconcile as unknown as PayDemSettlementReconcile,
    })(req({
      rail: "demos-native:DEM",
      jobId: "job-cached-invalid",
      phaseIndex: 1,
    }))).rejects.toThrow(/bft-final finality/);
    expect(rail.settle).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  test("accepts a structurally valid class-based settlement store", async () => {
    class ClassStore {
      async once(
        _key: string,
        submit: () => Promise<SettleResult>,
      ): Promise<SettleResult> {
        return submit();
      }
    }
    const rail: PayDemRail = {
      address: PAYER,
      async settle(input) {
        return {
          ok: true,
          txHash: TX_HASH,
          chainId: input.network ?? "demos",
          payer: PAYER,
          payee: input.recipient,
          finality: { model: "bft-final" },
          blockNumber: 1,
          txRefKind: "demos",
        };
      },
    };

    await expect(payDemSettle(rail, { network: "demos" }, {
      store: new ClassStore(),
    })(req({ jobId: "job-class-store" }))).resolves.toMatchObject({
      ok: true,
      txHash: TX_HASH,
    });
  });

  test("cross-checks a configured phaseIndex and never silently supplies it", async () => {
    const rail: PayDemRail = {
      address: PAYER,
      settle: vi.fn(),
    };
    const settle = payDemSettle(rail, {
      network: "demos",
      railId: "demos-native:DEM",
      phaseIndex: 6,
    });

    await expect(settle(req({
      rail: "demos-native:DEM",
      phaseIndex: undefined,
    }))).rejects.toThrow(/must carry the exact phaseIndex/);
    await expect(settle(req({
      rail: "demos-native:DEM",
      phaseIndex: 7,
    }))).rejects.toThrow(/does not match configured phaseIndex/);
    expect(rail.settle).not.toHaveBeenCalled();
  });

  test("rejects a zero DEM amount at the bridge before invoking an injected rail", async () => {
    const rail: PayDemRail = {
      address: PAYER,
      settle: vi.fn(),
    };

    await expect(payDemSettle(rail)(req({ amount: "0" })))
      .rejects.toThrow(/amount must be > 0/);
    expect(rail.settle).not.toHaveBeenCalled();
  });

  test("binds the prepared transfer to the exact PC-7 rail/session/phase key", async () => {
    const client = fakeClient();
    let captured: Parameters<PayDemRail["settle"]>[0] | undefined;
    const rail: PayDemRail = {
      address: PAYER,
      settle: async (input) => {
        captured = input;
        return payDemSettleCore(input, client);
      },
    };
    const settle = payDemSettle(rail, { network: "demos" });

    await settle(req({ rail: "demos-native:DEM", jobId: "job-7", phaseIndex: 2 }));

    expect(captured?.recovery).toEqual({
      railId: "demos-native:DEM",
      jobId: "job-7",
      phaseIndex: 2,
      settlementKey: "demos-native:DEM:job-7:2",
      network: "demos",
      payer: PAYER,
      payee: SELLER_HEX,
      amountOs: "5000000000",
    });
    expect(client.sent?.recovery).toEqual(captured?.recovery);
  });

  test("rejects a contradictory recovery key before submitting", async () => {
    const client = fakeClient();
    await expect(payDemSettleCore(params({
      recovery: {
        railId: "demos-native:DEM",
        jobId: "job-7",
        phaseIndex: 2,
        settlementKey: "demos-native:DEM:job-7:3",
        network: "demos:testnet",
        payer: PAYER,
        payee: RECIPIENT,
        amountOs: "1500000000",
      },
    }), client)).rejects.toThrow(/settlementKey does not match/);
    expect(client.sent).toBeUndefined();
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
