import { describe, expect, test } from "vitest";

import {
  termsMatchD402,
  payD402SettleCore,
  payD402Settle,
  createPayD402Rail,
  PAY_D402_AVAILABILITY,
  type D402ClientLike,
  type D402PaymentRequirement,
  type D402SettlementResult,
  type PayD402Rail,
} from "../../src/rails/payD402.js";

import { CounterpartyError } from "../../src/errors.js";

const RECIPIENT = `0x${"cd".repeat(32)}`;
const PAYER = "ab".repeat(32);
const TX_HASH = "ef".repeat(32);
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
      return over.result ?? { success: true, hash: `0x${TX_HASH}`, blockNumber: 42 };
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

/** The node's record of a confirmed d402 payment for the happy-path terms. */
function recordedPayment(over: { status?: string; hash?: string; content?: Record<string, unknown> } = {}) {
  return {
    status: "confirmed",
    hash: `0x${TX_HASH}`,
    ...over,
    content: {
      type: "d402_payment",
      from: `0x${PAYER}`,
      from_ed25519_address: `0x${PAYER}`,
      data: ["d402_payment", { to: RECIPIENT, amount: "1500000000", memo: "resourceId:res-1" }],
      gcr_edits: [
        { type: "balance", operation: "remove", isRollback: false, account: `0x${PAYER}`, txhash: `0x${TX_HASH}`, amount: "1500000000" },
        { type: "balance", operation: "add", isRollback: false, account: RECIPIENT, txhash: `0x${TX_HASH}`, amount: "1500000000" },
      ],
      ...over.content,
    },
  };
}

const confirmingRead = async () => recordedPayment();

/** A reader that shows the payment as confirmed and counts how often it is called. */
function countingRead() {
  const reader = {
    calls: 0,
    read: async () => {
      reader.calls += 1;
      return recordedPayment();
    },
  };
  return reader;
}

const ADVERTISED_REQUIREMENT = { recipient: RECIPIENT, amount: "1500000000", resourceId: "res-1" };

async function settleWithRecord(readTransaction: (hash: string) => Promise<unknown>) {
  return payD402SettleCore(params(), {
    client: fakeClient(),
    fetchImpl: fetch402(ADVERTISED_REQUIREMENT),
    payerAddress: PAYER,
    readTransaction,
  });
}

describe("payD402SettleCore", () => {
  test("happy path: pays the advertised requirement and returns the settlement hash", async () => {
    const client = fakeClient();
    const res = await payD402SettleCore(params(), {
      client,
      fetchImpl: fetch402({ recipient: RECIPIENT, amount: "1500000000", resourceId: "res-1" }),
      payerAddress: PAYER,
      readTransaction: confirmingRead,
    });
    expect(res.ok).toBe(true);
    expect(res.txHash).toBe(`0x${TX_HASH}`);
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
        readTransaction: confirmingRead,
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
        readTransaction: confirmingRead,
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
        readTransaction: confirmingRead,
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
        readTransaction: confirmingRead,
      }),
    ).rejects.toThrow(/resourceId/);
  });

  test("settlement success with no hash is reported ok:false (not an unverifiable success)", async () => {
    const client = fakeClient({ result: { success: true, hash: "" } });
    const res = await payD402SettleCore(params(), {
      client,
      fetchImpl: fetch402({ recipient: RECIPIENT, amount: "1500000000", resourceId: "res-1" }),
      payerAddress: PAYER,
      readTransaction: confirmingRead,
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
      readTransaction: confirmingRead,
    });
    expect(res.ok).toBe(false);
    expect(res.txHash).toBe("0xtried");
  });

  test("a settle still pending after its poll is reported pending, not ok, with its hash kept", async () => {
    const client = fakeClient({
      result: { success: false, pending: true, hash: "0xpendinghash", message: "not yet included" },
    });
    const res = await payD402SettleCore(params(), {
      client,
      fetchImpl: fetch402({ recipient: RECIPIENT, amount: "1500000000", resourceId: "res-1" }),
      payerAddress: PAYER,
      readTransaction: confirmingRead,
    });
    expect(res).toEqual({
      ok: false,
      pending: true,
      txHash: "0xpendinghash",
      chainId: "demos:testnet",
      payer: PAYER,
      payee: RECIPIENT,
    });
    expect(res.errorClass).toBeUndefined();
  });

  test("a pending settle with no hash throws instead of reporting not sent", async () => {
    const client = fakeClient({ result: { success: false, pending: true, hash: "" } });
    await expect(
      payD402SettleCore(params(), {
        client,
        fetchImpl: fetch402({ recipient: RECIPIENT, amount: "1500000000", resourceId: "res-1" }),
        payerAddress: PAYER,
        readTransaction: confirmingRead,
      }),
    ).rejects.toThrow(/pending.*without a hash/);
  });

  test("a settle reporting success and pending is never ok, even when the record shows the payment", async () => {
    const client = fakeClient({ result: { success: true, pending: true, hash: `0x${TX_HASH}` } });
    const reader = countingRead();
    const res = await payD402SettleCore(params(), {
      client,
      fetchImpl: fetch402({ recipient: RECIPIENT, amount: "1500000000", resourceId: "res-1" }),
      payerAddress: PAYER,
      readTransaction: reader.read,
    });
    expect(res.ok).toBe(false);
    expect(res.pending).toBe(true);
    expect(res.txHash).toBe(`0x${TX_HASH}`);
    expect(reader.calls).toBe(0);
  });

  test("an acknowledged settle whose record is not yet seen is not ok and keeps its hash", async () => {
    const res = await settleWithRecord(async () => {
      throw new Error("Demos transaction record not found");
    });
    expect(res).toEqual({
      ok: false,
      txHash: `0x${TX_HASH}`,
      chainId: "demos:testnet",
      payer: PAYER,
      payee: RECIPIENT,
    });
  });

  test("a settle that is not acknowledged is not read back", async () => {
    let reads = 0;
    const client = fakeClient({ result: { success: false, hash: "0xtried" } });
    await payD402SettleCore(params(), {
      client,
      fetchImpl: fetch402(ADVERTISED_REQUIREMENT),
      payerAddress: PAYER,
      readTransaction: async () => {
        reads += 1;
        return recordedPayment();
      },
    });
    expect(reads).toBe(0);
  });

  test("a matching confirmed record is read back by the acknowledged hash", async () => {
    const hashes: string[] = [];
    const res = await settleWithRecord(async (hash) => {
      hashes.push(hash);
      return recordedPayment();
    });
    expect(res.ok).toBe(true);
    expect(hashes).toEqual([`0x${TX_HASH}`]);
  });

  test("a node that acknowledges a settle but records no transfer is not reported ok", async () => {
    const res = await settleWithRecord(async () => ({}));
    expect(res.ok).toBe(false);
    expect(res.txHash).toBe(`0x${TX_HASH}`);
    expect(res.payee).toBe(RECIPIENT);
  });

  test("a recorded transfer from another payer is not reported ok", async () => {
    const res = await settleWithRecord(async () =>
      recordedPayment({ content: { from: `0x${"11".repeat(32)}` } }));
    expect(res.ok).toBe(false);
  });

  test("a record that debits another account is not reported ok", async () => {
    const res = await settleWithRecord(async () =>
      recordedPayment({ content: { from_ed25519_address: `0x${"11".repeat(32)}` } }));
    expect(res.ok).toBe(false);
  });

  test("a record with no debit account is not reported ok", async () => {
    const res = await settleWithRecord(async () =>
      recordedPayment({ content: { from_ed25519_address: undefined } }));
    expect(res.ok).toBe(false);
  });

  test("a confirmed record with no balance credit to the payee is not reported ok", async () => {
    const credit = (over: Record<string, unknown>) => ({
      type: "balance", operation: "add", isRollback: false, account: RECIPIENT,
      txhash: `0x${TX_HASH}`, amount: "1500000000", ...over,
    });
    for (const gcr_edits of [
      undefined,
      [],
      [credit({ account: `0x${"22".repeat(32)}` })],
      [credit({ amount: "1" })],
      [credit({ operation: "remove" })],
      [credit({ isRollback: true })],
    ]) {
      const res = await settleWithRecord(async () => recordedPayment({ content: { gcr_edits } }));
      expect(res.ok).toBe(false);
    }
  });

  test("a recorded transfer to another payee is not reported ok", async () => {
    const res = await settleWithRecord(async () =>
      recordedPayment({
        content: { data: ["d402_payment", { to: `0x${"22".repeat(32)}`, amount: "1500000000" }] },
      }));
    expect(res.ok).toBe(false);
  });

  test("a recorded transfer of another amount is not reported ok", async () => {
    const res = await settleWithRecord(async () =>
      recordedPayment({ content: { data: ["d402_payment", { to: RECIPIENT, amount: "1" }] } }));
    expect(res.ok).toBe(false);
  });

  test("a record for a different hash is not reported ok", async () => {
    const res = await settleWithRecord(async () =>
      recordedPayment({ hash: `0x${"33".repeat(32)}` }));
    expect(res.ok).toBe(false);
  });

  test("a record that is not confirmed is not reported ok", async () => {
    const res = await settleWithRecord(async () => recordedPayment({ status: "pending" }));
    expect(res.ok).toBe(false);
  });

  test("a record that is not a d402 payment is not reported ok", async () => {
    const res = await settleWithRecord(async () => recordedPayment({ content: { type: "native" } }));
    expect(res.ok).toBe(false);
  });

  test("a failed record read is not reported ok", async () => {
    const res = await settleWithRecord(async () => {
      throw new Error("Demos transaction record read timed out");
    });
    expect(res.ok).toBe(false);
    expect(res.txHash).toBe(`0x${TX_HASH}`);
  });

  test("a 402 whose payment the record check could not confirm is refused before paying", async () => {
    for (const body of [
      { ...ADVERTISED_REQUIREMENT, amount: "01500000000" },
      { ...ADVERTISED_REQUIREMENT, amount: "0x59682F00" },
      { ...ADVERTISED_REQUIREMENT, description: "x".repeat(70_000) },
      { ...ADVERTISED_REQUIREMENT, resourceId: "r".repeat(70_000) },
    ]) {
      let created = 0;
      const client = fakeClient({ onCreate: () => (created += 1) });
      await expect(
        payD402SettleCore(params(), {
          client,
          fetchImpl: fetch402(body),
          payerAddress: PAYER,
          readTransaction: confirmingRead,
        }),
      ).rejects.toThrow(CounterpartyError);
      expect(created).toBe(0);
    }
  });

  test("a bare-DEM number amount (pre-fork) is rejected — OS base-unit string required", async () => {
    const client = fakeClient();
    await expect(
      payD402SettleCore(params(), {
        client,
        // 402 advertises `amount: 2` (pre-fork DEM) instead of OS base units.
        fetchImpl: fetch402({ recipient: RECIPIENT, amount: 2, resourceId: "res-1" }),
        payerAddress: PAYER,
        readTransaction: confirmingRead,
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

describe("payD402Settle bridge destination binding", () => {
  test("rejects a request/config destination mismatch before rail submission", async () => {
    let calls = 0;
    const rail: PayD402Rail = {
      address: PAYER,
      settle: async () => {
        calls += 1;
        throw new Error("must not submit");
      },
    };
    const settle = payD402Settle(rail, {
      url: URL,
      recipient: RECIPIENT,
      network: "demos:testnet",
    });
    expect(() =>
      settle({
        rail: "pay-d402",
        phase: "pay-d402",
        amount: "1",
        asset: "DEM",
        payee: "did:demos:seller",
        expectedPayee: "demos1wrong",
        jobId: "destination-mismatch",
      }),
    ).toThrow(/destination mismatch/);
    expect(calls).toBe(0);
  });

  test("the runSession bridge hands over a pending payment as ok:false with its hash and no pending key", async () => {
    const rail: PayD402Rail = {
      address: PAYER,
      settle: async () => ({
        ok: false,
        pending: true,
        txHash: "0xpendinghash",
        chainId: "demos:testnet",
        payer: PAYER,
        payee: RECIPIENT,
      }),
    };
    const settle = payD402Settle(rail, { url: URL, recipient: RECIPIENT, network: "demos:testnet" });
    const res = await settle({
      rail: "pay-d402",
      phase: "pay-d402",
      amount: "1500000000",
      asset: "DEM",
      payee: "did:demos:seller",
      expectedPayee: RECIPIENT,
      jobId: "pending-bridge",
    });
    expect(res).toEqual({
      ok: false,
      txHash: "0xpendinghash",
      chainId: "demos:testnet",
      payer: PAYER,
      payee: RECIPIENT,
    });
  });
});
