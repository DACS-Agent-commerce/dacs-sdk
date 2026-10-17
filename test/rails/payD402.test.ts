import { beforeEach, describe, expect, test, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  connect: vi.fn(),
  connectWallet: vi.fn(),
  createPayment: vi.fn(),
  settle: vi.fn(),
  waitForSettlement: vi.fn(),
  clientDemos: [] as unknown[],
}));

// Constructing the rail never reaches a real node, even if the ack gate regresses.
vi.mock("@kynesyslabs/demosdk/websdk", () => ({
  Demos: class MockDemos {
    readonly connect = sdk.connect;
    readonly connectWallet = sdk.connectWallet;

    getAddress(): string {
      return "demos1payeraddress00000000000000000000000000";
    }
  },
}));

vi.mock("@kynesyslabs/demosdk/d402/client", () => ({
  D402Client: class MockD402Client {
    readonly createPayment = sdk.createPayment;
    readonly settle = sdk.settle;
    readonly waitForSettlement = sdk.waitForSettlement;

    constructor(demos: unknown) {
      sdk.clientDemos.push(demos);
    }
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  sdk.clientDemos.length = 0;
  sdk.connect.mockResolvedValue(undefined);
  sdk.connectWallet.mockResolvedValue(undefined);
  sdk.createPayment.mockImplementation(async (requirement: unknown) => ({ tx: "unsigned", requirement }));
  sdk.settle.mockResolvedValue({ success: true, hash: "0xdemhash", blockNumber: 42 });
  sdk.waitForSettlement.mockResolvedValue({ success: true, hash: "0xdemhash", blockNumber: 42 });
});

import {
  termsMatchD402,
  payD402SettleCore,
  payD402Settle,
  payD402ResumeSettlement,
  createPayD402Rail,
  PAY_D402_AVAILABILITY,
  type D402PaymentRequirement,
  type D402SettlementResult,
  type PayD402Paywall,
  type PayD402Rail,
  type PayD402SettleCoreDeps,
  type PayD402WaitParams,
} from "../../src/rails/payD402.js";
import { createIdempotencyStore, createInMemorySettlementLog, SettlementNotInvokedError } from "../../src/rails/idempotency.js";
import type { SettleRequest, SettleResult } from "../../src/agent/runSessionCore.js";

const RECIPIENT = "demos1recipientaddress0000000000000000000000";
const PAYER = "demos1payeraddress00000000000000000000000000";
const URL = "https://seller.example/premium";

describe("termsMatchD402 (§4.1 abort guard, native DEM)", () => {
  const expected = { recipient: RECIPIENT, amount: "1500000000" };

  test("matches on equal terms (recipient case-insensitive, leading zeros ok)", () => {
    expect(
      termsMatchD402(expected, {
        recipient: RECIPIENT.toUpperCase(),
        amount: "01500000000",
      }).ok,
    ).toBe(true);
  });

  test("rejects a recipient mismatch", () => {
    const r = termsMatchD402(expected, { recipient: "demos1someoneelse", amount: "1500000000" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/recipient mismatch/);
  });

  test("rejects an amount mismatch", () => {
    const r = termsMatchD402(expected, { recipient: RECIPIENT, amount: "999" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/amount mismatch/);
  });

  // demosdk signs the offered string as written, so anything BigInt would
  // reinterpret (or cannot parse) must never pass as the agreed amount.
  test.each([
    ["fractional", "1500000000.9"],
    ["exponent", "1.5e9"],
    ["hex", `0x${(1500000000).toString(16).toUpperCase()}`],
    ["binary", `0b${(1500000000).toString(2)}`],
    ["octal", `0o${(1500000000).toString(8)}`],
    ["signed", "+1500000000"],
    ["surrounding whitespace", " 1500000000 "],
    ["empty", ""],
  ])("rejects a %s offered amount", (_label, amount) => {
    const r = termsMatchD402(expected, { recipient: RECIPIENT, amount });
    expect(r).toEqual({
      ok: false,
      reason: `amount mismatch: 402 says ${amount}, agreement says 1500000000`,
    });
  });

  test("never matches identical non-decimal amounts", () => {
    for (const amount of ["abc", "1.5", "0x10", "-0"]) {
      expect(termsMatchD402({ recipient: RECIPIENT, amount }, { recipient: RECIPIENT, amount }).ok)
        .toBe(false);
    }
  });

  test("refuses a non-decimal agreed amount even when its value matches", () => {
    expect(termsMatchD402({ recipient: RECIPIENT, amount: "0x10" }, { recipient: RECIPIENT, amount: "16" }).ok)
      .toBe(false);
  });
});

/** A fake D402 client that records what it was asked to pay. */
function fakeClient(
  over: Partial<{ result: D402SettlementResult; onCreate: (r: D402PaymentRequirement) => void }> = {},
): PayD402SettleCoreDeps["client"] & { paid?: D402PaymentRequirement } {
  const self: PayD402SettleCoreDeps["client"] & { paid?: D402PaymentRequirement } = {
    async createPayment(requirement) {
      self.paid = requirement;
      over.onCreate?.(requirement);
      return { tx: "unsigned", requirement };
    },
    async settle() {
      return over.result ?? { success: true, hash: "0xdemhash", blockNumber: 42 };
    },
  };
  return self;
}

/** A fetch stub that returns a 402 carrying the given requirement body. */
function fetch402(body: unknown, status = 402): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const params = (over: Record<string, unknown> = {}) => ({
  paywallUrl: URL,
  recipient: RECIPIENT,
  amount: "1500000000",
  network: "demos:testnet",
  ...over,
});

describe("payD402SettleCore", () => {
  test("happy path: pays the advertised requirement and returns the settlement hash", async () => {
    const client = fakeClient();
    const res = await payD402SettleCore(params(), {
      client,
      fetchImpl: fetch402({ recipient: RECIPIENT, amount: "1500000000", resourceId: "res-1" }),
      payerAddress: PAYER,
    });
    expect(res.ok).toBe(true);
    expect(res.txHash).toBe("0xdemhash");
    expect(res.payer).toBe(PAYER);
    expect(res.payee).toBe(RECIPIENT);
    // Native Demos inclusion: a `demos` txRef at the block it landed in, bft-final (§9.5.9 / §9.7).
    expect(res.blockNumber).toBe(42);
    expect(res.txRefKind).toBe("demos");
    expect(res.finality).toEqual({ model: "bft-final" });
    expect(res.chainId).toBe("demos:testnet");
    expect(client.paid).toMatchObject({ recipient: RECIPIENT, amount: "1500000000", resourceId: "res-1" });
  });

  test("§4.1 abort: a 402 advertising a different recipient is rejected BEFORE paying", async () => {
    let created = 0;
    const client = fakeClient({ onCreate: () => (created += 1) });
    await expect(
      payD402SettleCore(params(), {
        client,
        fetchImpl: fetch402({ recipient: "demos1attacker", amount: "1500000000", resourceId: "res-1" }),
        payerAddress: PAYER,
      }),
    ).rejects.toThrow(/does not match negotiated agreement/);
    expect(created).toBe(0); // never signed
  });

  test("§4.1 abort: a 402 advertising a different amount is rejected before paying", async () => {
    const client = fakeClient();
    await expect(
      payD402SettleCore(params(), {
        client,
        fetchImpl: fetch402({ recipient: RECIPIENT, amount: "999", resourceId: "res-1" }),
        payerAddress: PAYER,
      }),
    ).rejects.toThrow(/amount mismatch/);
  });

  test("a non-402 response is a counterparty fault", async () => {
    const client = fakeClient();
    await expect(
      payD402SettleCore(params(), {
        client,
        fetchImpl: fetch402({}, 200),
        payerAddress: PAYER,
      }),
    ).rejects.toThrow(/expected HTTP 402/);
  });

  test("§4.1 abort: a hex amount equal to the agreement is rejected before paying", async () => {
    const client = fakeClient();
    await expect(
      payD402SettleCore(params(), {
        client,
        fetchImpl: fetch402({ recipient: RECIPIENT, amount: "0x59682F00", resourceId: "res-1" }),
        payerAddress: PAYER,
      }),
    ).rejects.toThrow(/amount mismatch: 402 says 0x59682F00/);
    expect(client.paid).toBeUndefined();
  });

  test("a whitespace-only resourceId is rejected before paying", async () => {
    const client = fakeClient();
    await expect(
      payD402SettleCore(params(), {
        client,
        fetchImpl: fetch402({ recipient: RECIPIENT, amount: "1500000000", resourceId: " \t" }),
        payerAddress: PAYER,
      }),
    ).rejects.toThrow("d402: 402 body missing a string `resourceId`");
    expect(client.paid).toBeUndefined();
  });

  test("a malformed 402 body (no resourceId) is rejected", async () => {
    const client = fakeClient();
    await expect(
      payD402SettleCore(params(), {
        client,
        fetchImpl: fetch402({ recipient: RECIPIENT, amount: "1500000000" }),
        payerAddress: PAYER,
      }),
    ).rejects.toThrow(/resourceId/);
  });

  test("settlement success with no hash is reported ok:false (not an unverifiable success)", async () => {
    const client = fakeClient({ result: { success: true, hash: "" } });
    const res = await payD402SettleCore(params(), {
      client,
      fetchImpl: fetch402({ recipient: RECIPIENT, amount: "1500000000", resourceId: "res-1" }),
      payerAddress: PAYER,
    });
    expect(res.ok).toBe(false);
    expect(res.txHash).toBe("");
  });

  test("a failed settlement is reported ok:false with its hash preserved", async () => {
    const client = fakeClient({ result: { success: false, hash: "0xtried", message: "insufficient balance" } });
    const res = await payD402SettleCore(params(), {
      client,
      fetchImpl: fetch402({ recipient: RECIPIENT, amount: "1500000000", resourceId: "res-1" }),
      payerAddress: PAYER,
    });
    expect(res.ok).toBe(false);
    expect(res.txHash).toBe("0xtried");
  });

  // demosdk 4.0.17+ D402Client outcomes other than inclusion. Each keeps its
  // hash and is ok:false, which runSessionCore holds as indeterminate.
  test.each([
    ["pending (broadcast, wait ran out)", { success: false, pending: true, hash: "0xpending", message: "resume with waitForSettlement" }],
    ["refused by the node (4xx)", { success: false, hash: "0xrefused", message: "Broadcast refused (400): bad nonce" }],
    ["failed on chain", { success: false, hash: "0xfailed", blockNumber: 7, message: "Payment transaction failed on chain" }],
    ["success without a block number", { success: true, hash: "0xnoblock" }],
    ["success flagged pending", { success: true, pending: true, hash: "0xboth", blockNumber: 9 }],
    ["success at a negative block", { success: true, hash: "0xneg", blockNumber: -1 }],
    ["success at a fractional block", { success: true, hash: "0xfrac", blockNumber: 1.5 }],
    ["success at an unsafe block number", { success: true, hash: "0xbig", blockNumber: 2 ** 53 }],
  ] as const)("%s is ok:false with its hash and no finality", async (_label, result) => {
    const res = await payD402SettleCore(params(), {
      client: fakeClient({ result: result as D402SettlementResult }),
      fetchImpl: fetch402({ recipient: RECIPIENT, amount: "1500000000", resourceId: "res-1" }),
      payerAddress: PAYER,
    });
    expect(res).toEqual({
      ok: false,
      txHash: result.hash,
      chainId: "demos:testnet",
      payer: PAYER,
      payee: RECIPIENT,
    });
  });

  test("inclusion at block 0 is a success", async () => {
    const res = await payD402SettleCore(params(), {
      client: fakeClient({ result: { success: true, hash: "0xgenesis", blockNumber: 0 } }),
      fetchImpl: fetch402({ recipient: RECIPIENT, amount: "1500000000", resourceId: "res-1" }),
      payerAddress: PAYER,
    });
    expect(res).toMatchObject({ ok: true, txHash: "0xgenesis", blockNumber: 0 });
  });

  test("a bare-DEM number amount (pre-fork) is rejected — OS base-unit string required", async () => {
    const client = fakeClient();
    await expect(
      payD402SettleCore(params(), {
        client,
        // 402 advertises `amount: 2` (pre-fork DEM) instead of OS base units.
        fetchImpl: fetch402({ recipient: RECIPIENT, amount: 2, resourceId: "res-1" }),
        payerAddress: PAYER,
      }),
    ).rejects.toThrow(/bare number|OS base units/);
  });
});

describe("createPayD402Rail — experimental quarantine (RAV-R1)", () => {
  test("is marked non-live", () => {
    expect(PAY_D402_AVAILABILITY).toBe("operator_gated"); // §9.4.4 spec vocabulary (#5)
  });

  test("refuses to build without acknowledgeExperimental (never wired as live by accident)", async () => {
    for (const acknowledgeExperimental of [undefined, false]) {
      await expect(
        createPayD402Rail({ rpc: "https://rpc.d402.test", secret: "x", acknowledgeExperimental } as never),
      ).rejects.toThrow(
        "pay-d402 is EXPERIMENTAL and not a supported live rail (§9.4.4 non-`live`), but settling broadcasts a real " +
          "d402_payment transaction that can move real DEM. Pass acknowledgeExperimental: true only for experimental " +
          "use — never select it as a live rail (RAV-R1).",
      );
    }
    expect(sdk.connect).not.toHaveBeenCalled();
    expect(sdk.connectWallet).not.toHaveBeenCalled();
  });

  test("an acknowledged rail connects, signs through D402Client and labels evidence with its network", async () => {
    const fetchImpl = fetch402({ recipient: RECIPIENT, amount: "1500000000", resourceId: "res-1" });
    const rail = await createPayD402Rail({
      rpc: "https://rpc.d402.test",
      secret: "test mnemonic",
      network: "demos:testnet",
      fetchImpl,
      acknowledgeExperimental: true,
    });
    expect(sdk.connect).toHaveBeenCalledExactlyOnceWith("https://rpc.d402.test");
    expect(sdk.connectWallet).toHaveBeenCalledExactlyOnceWith("test mnemonic");
    expect(sdk.clientDemos).toHaveLength(1);
    expect(rail.address).toBe(PAYER);

    const res = await rail.settle({ paywallUrl: URL, recipient: RECIPIENT, amount: "1500000000" } as never);
    expect(res).toEqual({
      ok: true,
      txHash: "0xdemhash",
      chainId: "demos:testnet",
      payer: PAYER,
      payee: RECIPIENT,
      blockNumber: 42,
      txRefKind: "demos",
      finality: { model: "bft-final" },
    });
    expect(sdk.createPayment).toHaveBeenCalledExactlyOnceWith({
      recipient: RECIPIENT,
      amount: "1500000000",
      resourceId: "res-1",
    });
    expect(sdk.settle).toHaveBeenCalledOnce();

    const labelled = await rail.settle({ ...params(), network: "demos:other" });
    expect(labelled.chainId).toBe("demos:other");
  });

  test("waitForSettlement reads a broadcast payment back by hash without paying again", async () => {
    const rail = await createPayD402Rail({
      rpc: "https://rpc.d402.test",
      secret: "test mnemonic",
      fetchImpl: fetch402({ recipient: RECIPIENT, amount: "1500000000", resourceId: "res-1" }),
      acknowledgeExperimental: true,
    });
    const wait = { txHash: "0xdemhash", recipient: RECIPIENT, network: "demos:testnet" };
    expect(await rail.waitForSettlement({ ...wait, options: { timeoutMs: 5 } })).toEqual({
      ok: true,
      txHash: "0xdemhash",
      chainId: "demos:testnet",
      payer: PAYER,
      payee: RECIPIENT,
      blockNumber: 42,
      txRefKind: "demos",
      finality: { model: "bft-final" },
    });
    expect(sdk.waitForSettlement).toHaveBeenCalledExactlyOnceWith("0xdemhash", { timeoutMs: 5 });

    sdk.waitForSettlement.mockResolvedValueOnce({ success: false, pending: true, hash: "0xdemhash" });
    expect(await rail.waitForSettlement(wait)).toMatchObject({ ok: false, txHash: "0xdemhash" });
    // An included transaction under another hash does not settle this one.
    sdk.waitForSettlement.mockResolvedValueOnce({ success: true, hash: "0xother", blockNumber: 42 });
    expect(await rail.waitForSettlement(wait)).toEqual({
      ok: false,
      txHash: "0xdemhash",
      chainId: "demos:testnet",
      payer: PAYER,
      payee: RECIPIENT,
    });
    expect(sdk.createPayment).not.toHaveBeenCalled();
    expect(sdk.settle).not.toHaveBeenCalled();
  });

  test("an acknowledged rail without a network label records \"demos\"", async () => {
    const rail = await createPayD402Rail({
      rpc: "https://rpc.d402.test",
      secret: "test mnemonic",
      fetchImpl: fetch402({ recipient: RECIPIENT, amount: "1500000000", resourceId: "res-1" }),
      acknowledgeExperimental: true,
    });
    const res = await rail.settle({ paywallUrl: URL, recipient: RECIPIENT, amount: "1500000000" } as never);
    expect(res.chainId).toBe("demos");
  });
});

describe("payD402Settle bridge", () => {
  function recordingRail(results: Array<Partial<SettleResult>> = []) {
    const seen: Array<Record<string, unknown>> = [];
    const rail: PayD402Rail = {
      address: PAYER,
      settle: async (p) => {
        seen.push({ ...p });
        return {
          ok: true,
          txHash: "0xdemhash",
          chainId: p.network,
          payer: PAYER,
          payee: p.recipient,
          blockNumber: 42,
          txRefKind: "demos",
          finality: { model: "bft-final" },
          ...results.shift(),
        };
      },
      waitForSettlement: async () => {
        throw new Error("settlement never waits by hash");
      },
    };
    return { rail, seen };
  }
  const request = (over: Partial<SettleRequest> = {}): SettleRequest => ({
    rail: "pay-d402",
    phase: "pay-d402",
    amount: "1.5",
    asset: "DEM",
    payee: "did:demos:seller",
    expectedPayee: RECIPIENT,
    jobId: "bridge-job",
    phaseIndex: 0,
    ...over,
  });
  const paywall = { url: URL, recipient: RECIPIENT, network: "demos:testnet" };
  /** A bridge over its own in-memory store (one process, one bridge). */
  const bridge = (r: PayD402Rail, p: PayD402Paywall = paywall) =>
    payD402Settle(r, p, { store: createIdempotencyStore() });
  // A demosdk `pending` result as payD402SettleCore maps it.
  const pending: SettleResult = {
    ok: false,
    txHash: "0xpending",
    chainId: "demos:testnet",
    payer: PAYER,
    payee: RECIPIENT,
  };
  function pendingRail() {
    const seen: Array<Record<string, unknown>> = [];
    const rail: PayD402Rail = {
      address: PAYER,
      settle: async (p) => {
        seen.push({ ...p });
        return pending;
      },
      waitForSettlement: async () => {
        throw new Error("settlement never waits by hash");
      },
    };
    return { rail, seen };
  }

  test("converts the agreement's decimal DEM to OS and passes the paywall's network label", async () => {
    const { rail, seen } = recordingRail();
    const res = await bridge(rail)(request());
    expect(seen).toEqual([{ paywallUrl: URL, recipient: RECIPIENT, amount: "1500000000", network: "demos:testnet" }]);
    expect(res).toMatchObject({ ok: true, chainId: "demos:testnet", blockNumber: 42, finality: { model: "bft-final" } });
  });

  test("defaults the label to \"demos\" when the paywall has none", async () => {
    const { rail, seen } = recordingRail();
    await bridge(rail, { url: URL, recipient: RECIPIENT })(request());
    expect(seen[0]?.["network"]).toBe("demos");
  });

  /** A rail running the real settle flow over a fake client and paywall. */
  const railOver = (
    client: ReturnType<typeof fakeClient>,
    fetchImpl = fetch402({ recipient: RECIPIENT, amount: "1500000000", resourceId: "res-1" }),
  ): PayD402Rail => ({
    address: PAYER,
    settle: (p) => payD402SettleCore(p, { client, fetchImpl, payerAddress: PAYER }),
    waitForSettlement: async () => {
      throw new Error("not used");
    },
  });

  test("a 1.5 DEM agreement pays a 1500000000 OS paywall; the same digits as DEM do not", async () => {
    const client = fakeClient();
    expect(await bridge(railOver(client))(request())).toMatchObject({
      ok: true,
      txHash: "0xdemhash",
    });
    expect(client.paid?.amount).toBe("1500000000");

    // 1500000000 DEM is a billion times the paywall price.
    const strict = fakeClient();
    await expect(
      bridge(railOver(strict))(request({ amount: "1500000000", jobId: "digits-as-dem" })),
    ).rejects.toThrow(/amount mismatch/);
    expect(strict.paid).toBeUndefined();
  });

  test.each([
    ["a non-DEM asset", { asset: "USDC" }, /DEM only/],
    ["another rail", { rail: "pay-x402" }, /requires rail "pay-d402", got "pay-x402"/],
    ["another phase", { phase: "pay-x402" }, /requires phase "pay-d402"/],
    ["a zero amount", { amount: "0" }, /must be > 0/],
    ["sub-OS precision", { amount: "0.0000000001" }, /\S/],
    ["a non-canonical amount", { amount: "1e9" }, /\S/],
    ["a destination mismatch", { expectedPayee: "demos1wrong" }, /destination mismatch/],
  ] as const)("refuses %s before rail submission", async (_label, over, message) => {
    const { rail, seen } = recordingRail();
    await expect(bridge(rail)(request(over as Partial<SettleRequest>))).rejects.toThrow(message);
    expect(seen).toEqual([]);
  });

  test("returns the request-bound payee when the 402 spells the recipient in another case", async () => {
    const { rail } = recordingRail([{ payee: RECIPIENT.toUpperCase() }]);
    expect((await bridge(rail)(request())).payee).toBe(RECIPIENT);
  });

  test.each([
    ["another payer", { payer: "demos1someoneelse" }],
    ["another payee", { payee: "demos1someoneelse" }],
    ["another network label", { chainId: "demos:other" }],
  ] as const)("refuses a rail result for %s", async (_label, over) => {
    const { rail } = recordingRail([over]);
    await expect(bridge(rail)(request())).rejects.toThrow(
      "pay-d402 settlement does not match the paywall network or parties",
    );
  });

  test("refuses to build without a settlement store", () => {
    const { rail, seen } = recordingRail();
    for (const opts of [undefined, {}, { store: undefined }, { store: {} }]) {
      expect(() => payD402Settle(rail, paywall, opts as never)).toThrow(/requires opts\.store/);
    }
    expect(seen).toEqual([]);
  });

  test("two bridges over one shared store never pay a pending job twice", async () => {
    const store = createIdempotencyStore();
    const first = pendingRail();
    const second = recordingRail();
    expect(await payD402Settle(first.rail, paywall, { store })(request())).toEqual(pending);
    await expect(payD402Settle(second.rail, paywall, { store })(request())).rejects.toThrow(
      /refusing to resubmit/,
    );
    expect(first.seen).toHaveLength(1);
    expect(second.seen).toEqual([]);
  });

  test("a paywall fetch error before any payment can be retried", async () => {
    let calls = 0;
    const ok = fetch402({ recipient: RECIPIENT, amount: "1500000000", resourceId: "res-1" });
    const flaky = (async (...args: Parameters<typeof fetch>) => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return ok(...args);
    }) as typeof fetch;
    const client = fakeClient();
    const settle = bridge(railOver(client, flaky));
    await expect(settle(request())).rejects.toThrow("fetch failed");
    expect(client.paid).toBeUndefined();
    expect(await settle(request())).toMatchObject({ ok: true, txHash: "0xdemhash" });
    expect(client.paid?.amount).toBe("1500000000");
  });

  test("an abort-guard mismatch leaves no held intent", async () => {
    let body: Record<string, string> = { recipient: "demos1attacker", amount: "1500000000", resourceId: "res-1" };
    const paywallFetch = (async () => fetch402(body)(URL)) as typeof fetch;
    const client = fakeClient();
    const settle = bridge(railOver(client, paywallFetch));
    await expect(settle(request())).rejects.toThrow(/recipient mismatch/);
    expect(client.paid).toBeUndefined();
    body = { ...body, recipient: RECIPIENT };
    expect(await settle(request())).toMatchObject({ ok: true });
  });

  test("a throw after the payment was created still refuses a retry", async () => {
    let settles = 0;
    const client: ReturnType<typeof fakeClient> = {
      ...fakeClient(),
      async settle() {
        settles += 1;
        throw new Error("socket closed after broadcast");
      },
    };
    const settle = bridge(railOver(client));
    await expect(settle(request())).rejects.toThrow("socket closed after broadcast");
    await expect(settle(request())).rejects.toThrow(/refusing to resubmit/);
    expect(settles).toBe(1);
  });

  test("a client's store-disposition exception does not authorize a payment retry", async () => {
    const client = fakeClient();
    let effects = 0;
    client.settle = async () => {
      effects += 1;
      throw new SettlementNotInvokedError({ ok: false, txHash: "", chainId: "demos:testnet", payer: PAYER, payee: RECIPIENT }, new Error("client failure"));
    };
    const settle = bridge(railOver(client));
    await expect(settle(request())).rejects.toThrow(/without current preflight proof/);
    await expect(settle(request())).rejects.toThrow(/refusing to resubmit/);
    expect(effects).toBe(1);
  });

  test("a pending payment is never paid twice in the same process", async () => {
    const { rail, seen } = pendingRail();
    const settle = bridge(rail);
    expect(await settle(request())).toEqual(pending);
    await expect(settle(request())).rejects.toThrow(/refusing to resubmit/);
    expect(seen).toHaveLength(1);
  });

  test("after a restart, a pending payment is never paid again (durable log)", async () => {
    const log = createInMemorySettlementLog();
    let now = 1_000;
    const first = pendingRail();
    const before = payD402Settle(first.rail, paywall, {
      store: createIdempotencyStore(log, { owner: "process-a", now: () => now }),
    });
    expect(await before(request())).toEqual(pending);

    // A fresh process over the same durable log, inside and then after the lease.
    const second = recordingRail();
    const after = payD402Settle(second.rail, paywall, {
      store: createIdempotencyStore(log, { owner: "process-b", now: () => now }),
    });
    await expect(after(request())).rejects.toThrow(/refusing to resubmit/);
    now += 10 * 60_000;
    await expect(after(request())).rejects.toThrow(/refusing to resubmit/);
    expect(second.seen).toEqual([]);
  });

  test("a definitive success is reused, not paid again", async () => {
    const { rail, seen } = recordingRail();
    const settle = bridge(rail);
    const a = await settle(request());
    expect(await settle(request())).toEqual(a);
    expect(seen).toHaveLength(1);
  });
});

describe("payD402ResumeSettlement", () => {
  const paywall = { url: URL, recipient: RECIPIENT, network: "demos:testnet" };
  const included = (txHash: string) => ({
    ok: true,
    txHash,
    blockNumber: 43,
    txRefKind: "demos",
    finality: { model: "bft-final" as const },
  });
  function readRail(reads: Array<Partial<SettleResult>>) {
    const waited: string[] = [];
    const waitParams: PayD402WaitParams[] = [];
    let settled = 0;
    const rail: PayD402Rail = {
      address: PAYER,
      settle: async () => {
        settled += 1;
        throw new Error("recovery must not pay");
      },
      waitForSettlement: async (p) => {
        waited.push(p.txHash);
        waitParams.push(p);
        return { ok: false, txHash: p.txHash, chainId: p.network, payer: PAYER, payee: p.recipient, ...reads.shift() };
      },
    };
    return { rail, waited, waitParams, settled: () => settled };
  }
  const request = (priorAttempts?: SettleRequest["priorAttempts"]): SettleRequest => ({
    rail: "pay-d402",
    phase: "pay-d402",
    amount: "1.5",
    asset: "DEM",
    payee: "did:demos:seller",
    expectedPayee: RECIPIENT,
    jobId: "resume-job",
    phaseIndex: 0,
    ...(priorAttempts ? { priorAttempts } : {}),
  });
  const attempt = (txHash: string) => ({ txHash, chainId: "demos:testnet", ok: false });

  test("pending, then included: returns the definitive result for the recorded hash", async () => {
    const { rail, waited, settled } = readRail([{}, included("0xpending")]);
    const resume = payD402ResumeSettlement(rail, paywall);
    expect(await resume(request([attempt("0xpending")]))).toEqual({
      ok: false,
      txHash: "0xpending",
      chainId: "demos:testnet",
      payer: PAYER,
      payee: RECIPIENT,
    });
    expect(await resume(request([attempt("0xpending")]))).toEqual({
      chainId: "demos:testnet",
      payer: PAYER,
      payee: RECIPIENT,
      ...included("0xpending"),
    });
    expect(waited).toEqual(["0xpending", "0xpending"]);
    expect(settled()).toBe(0);
  });

  test("checks every prior hash and returns the one that landed", async () => {
    const { rail, waited } = readRail([included("0xfirst"), {}]);
    const res = await payD402ResumeSettlement(rail, paywall)(request([attempt("0xfirst"), attempt("0xsecond")]));
    expect(res).toMatchObject({ ok: true, txHash: "0xfirst" });
    expect(waited).toEqual(["0xfirst", "0xsecond"]);
  });

  test("two included payments need an operator", async () => {
    const { rail } = readRail([included("0xfirst"), included("0xsecond")]);
    await expect(
      payD402ResumeSettlement(rail, paywall)(request([attempt("0xfirst"), attempt("0xsecond")])),
    ).rejects.toThrow(/2 included payments/);
  });

  test("no recorded hash cannot rule out a broadcast payment", async () => {
    const { rail, settled } = readRail([]);
    await expect(payD402ResumeSettlement(rail, paywall)(request())).rejects.toThrow(/no recorded transaction hash/);
    expect(settled()).toBe(0);
  });

  test("refuses a read-back under a different hash", async () => {
    const { rail } = readRail([included("0xother")]);
    await expect(payD402ResumeSettlement(rail, paywall)(request([attempt("0xmine")]))).rejects.toThrow(
      /different transaction hash/,
    );
  });

  test("applies the same request checks as settlement", async () => {
    const { rail, waited } = readRail([]);
    await expect(
      payD402ResumeSettlement(rail, paywall)({ ...request([attempt("0xmine")]), asset: "USDC" }),
    ).rejects.toThrow(/DEM only/);
    await expect(
      payD402ResumeSettlement(rail, paywall)({ ...request([attempt("0xmine")]), rail: "pay-x402" }),
    ).rejects.toThrow(/requires rail "pay-d402"/);
    expect(waited).toEqual([]);
  });

  test("with several attempts and none included, returns the latest hash", async () => {
    const { rail, waited } = readRail([{}, {}, {}]);
    const res = await payD402ResumeSettlement(rail, paywall)(
      request([attempt("0xa"), attempt("0xb"), attempt("0xc")]),
    );
    expect(res).toEqual({ ok: false, txHash: "0xc", chainId: "demos:testnet", payer: PAYER, payee: RECIPIENT });
    expect(waited).toEqual(["0xa", "0xb", "0xc"]);
  });

  test("skips attempts without a hash, and refuses when none has one", async () => {
    const { rail, waited } = readRail([included("0xa")]);
    expect(await payD402ResumeSettlement(rail, paywall)(request([attempt(" "), attempt("0xa")]))).toMatchObject({
      ok: true,
      txHash: "0xa",
    });
    expect(waited).toEqual(["0xa"]);
    await expect(payD402ResumeSettlement(rail, paywall)(request([attempt(""), attempt(" \t")]))).rejects.toThrow(
      /no recorded transaction hash/,
    );
    expect(waited).toEqual(["0xa"]);
  });

  test("passes the wait options through, and none when unset", async () => {
    const { rail, waitParams } = readRail([{}, {}]);
    await payD402ResumeSettlement(rail, paywall, { wait: { timeoutMs: 7, pollIntervalMs: 1 } })(
      request([attempt("0xa")]),
    );
    await payD402ResumeSettlement(rail, paywall)(request([attempt("0xa")]));
    expect(waitParams).toEqual([
      {
        txHash: "0xa",
        recipient: RECIPIENT,
        network: "demos:testnet",
        options: { timeoutMs: 7, pollIntervalMs: 1 },
      },
      { txHash: "0xa", recipient: RECIPIENT, network: "demos:testnet" },
    ]);
  });

  test("refuses an attempt recorded under another network label before reading any", async () => {
    const { rail, waited } = readRail([included("0xa")]);
    await expect(
      payD402ResumeSettlement(rail, paywall)(
        request([attempt("0xa"), { txHash: "0xb", chainId: "demos:mainnet", ok: false }]),
      ),
    ).rejects.toThrow(/recorded under network "demos:mainnet", not the paywall's "demos:testnet"/);
    expect(waited).toEqual([]);
  });

  test.each([
    ["another network label", { chainId: "demos:other" }],
    ["another payer", { payer: "demos1someoneelse" }],
    ["another payee", { payee: "demos1someoneelse" }],
  ] as const)("refuses a read-back for %s", async (_label, over) => {
    const { rail } = readRail([{ ...included("0xa"), ...over }]);
    await expect(payD402ResumeSettlement(rail, paywall)(request([attempt("0xa")]))).rejects.toThrow(
      "pay-d402 recovery does not match the paywall network or parties",
    );
  });
});
