import { describe, expect, test } from "vitest";

import {
  termsMatchD402,
  payD402SettleCore,
  createPayD402Rail,
  PAY_D402_AVAILABILITY,
  type D402ClientLike,
  type D402PaymentRequirement,
  type D402SettlementResult,
} from "../../src/rails/payD402.js";

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
});

/** A fake D402 client that records what it was asked to pay. */
function fakeClient(
  over: Partial<{ result: D402SettlementResult; onCreate: (r: D402PaymentRequirement) => void }> = {},
): D402ClientLike & { paid?: D402PaymentRequirement } {
  const self: D402ClientLike & { paid?: D402PaymentRequirement } = {
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
    await expect(
      createPayD402Rail({ rpc: "https://node.demos.sh", secret: "x" } as never),
    ).rejects.toThrow(/EXPERIMENTAL|acknowledgeExperimental/);
  });
});
