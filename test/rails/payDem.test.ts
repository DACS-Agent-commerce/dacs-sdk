import { beforeEach, describe, expect, test, vi } from "vitest";

import type { SettleResult } from "../../src/agent/runSessionCore.js";
import {
  TERMINAL_INCLUDED,
  createPayDemRail,
  isPayDemRecordVerifyingRail,
  isRecordVerifiedSource,
  payDemSettleCore,
  payDemSettle,
  type DemosNativeClient,
  type DemosTransferResult,
  type PayDemPreparedTransfer,
  type PayDemRail,
  type PayDemSettlementReconcile,
  type PayDemSettlementRecoveryContext,
} from "../../src/rails/payDem.js";
import {
  createIdempotencyStore,
  createInMemorySettlementLog,
  settlementBindingHash,
  settlementKey,
  type SettlementBinding,
  type SettlementIdempotencyStore,
  type SettlementLog,
} from "../../src/rails/idempotency.js";
import { baseUnits } from "../../src/canonical/index.js";

const RECIPIENT = "d4".repeat(32);
const PAYER = "c3".repeat(32);
const TX_HASH = "12".repeat(32);
const OTHER_TX_HASH = "34".repeat(32);

const sdk = vi.hoisted(() => ({
  broadcast: vi.fn(),
  confirm: vi.fn(),
  connect: vi.fn(),
  connectWallet: vi.fn(),
  getNetworkInfo: vi.fn(),
  getTxByHash: vi.fn(),
  nodeCall: vi.fn(),
  transfer: vi.fn(),
  waitForNonce: vi.fn(),
}));

vi.mock("@kynesyslabs/demosdk/websdk", () => ({
  Demos: class MockDemos {
    readonly tx = { confirm: sdk.confirm };
    readonly broadcast = sdk.broadcast;
    readonly connect = sdk.connect;
    readonly connectWallet = sdk.connectWallet;
    readonly getNetworkInfo = sdk.getNetworkInfo;
    readonly getTxByHash = sdk.getTxByHash;
    readonly nodeCall = sdk.nodeCall;
    readonly transfer = sdk.transfer;
    readonly waitForNonce = sdk.waitForNonce;

    getAddress(): string {
      return `0x${PAYER}`;
    }
  },
}));

// The node signs TX_HASH at nonce 9, includes it at block 4242, and records the
// broadcast transaction with the status `recordStatus` sets (default confirmed).
let recordStatus = "confirmed";
beforeEach(async () => {
  for (const method of Object.values(sdk)) method.mockReset();
  recordStatus = "confirmed";
  sdk.connect.mockResolvedValue(undefined);
  sdk.connectWallet.mockResolvedValue(undefined);
  sdk.getNetworkInfo.mockResolvedValue({ forks: { osDenomination: { activated: true } } });
  sdk.transfer.mockImplementation(async (to: string, amountOs: bigint) => ({
    hash: TX_HASH,
    content: {
      type: "native",
      from: `0x${PAYER}`,
      to,
      amount: amountOs.toString(),
      nonce: 9,
      data: ["native", { nativeOperation: "send", args: [to, amountOs.toString()] }],
    },
  }));
  sdk.confirm.mockImplementation(async (signed: { hash: string; content: object }) => ({
    response: { data: { transaction: { hash: signed.hash, content: { ...signed.content } } } },
  }));
  sdk.broadcast.mockResolvedValue({ result: 200, response: { hash: TX_HASH } });
  // The payer had used nonce 8 before each call, so a transfer signs nonce 9.
  sdk.nodeCall.mockImplementation(async (message: string) =>
    message === "getAddressNonce" ? 8 : { state: "included", blockNumber: 4242 });
  sdk.getTxByHash.mockImplementation(async () => {
    const transaction = (sdk.broadcast.mock.calls.at(-1)?.[0] as {
      response: { data: { transaction: { content: { nonce: number } } } };
    }).response.data.transaction;
    return {
      ...transaction,
      content: {
        ...transaction.content,
        nonce: String(transaction.content.nonce),
      },
      status: recordStatus,
      blockNumber: 4242,
    };
  });
  sdk.waitForNonce.mockResolvedValue(undefined);
});

/**
 * The SDK's own rail over the mocked node: the only rail whose verdicts are
 * final, because it reads and binds the transaction record itself (#338).
 */
const sdkRail = (
  over: Partial<Parameters<typeof createPayDemRail>[0]> = {},
) => createPayDemRail({
  rpc: "https://node.test",
  secret: "test-secret",
  inclusionPollIntervalMs: 1,
  statusRequestTimeoutMs: 50,
  transactionRecordTimeoutMs: 200,
  ...over,
});
/** Native transfers the SDK rail signed over the mocked node. */
const sdkTransfers = () => sdk.transfer.mock.calls.length;

/**
 * A fake native client the SDK did not build. It records the transfer it was
 * asked to submit, journals it (hash and nonce 9) through the journal it is
 * handed, and returns its result. `payDemSettleCore` refuses it before its
 * transfer (#338).
 */
function fakeClient(
  over: Partial<{ result: DemosTransferResult }> = {},
): DemosNativeClient & { sent?: Parameters<DemosNativeClient["transfer"]>[0] } {
  const self: DemosNativeClient & {
    sent?: Parameters<DemosNativeClient["transfer"]>[0];
  } = {
    address: PAYER,
    async transfer(args) {
      self.sent = args;
      const result = over.result ?? {
        ok: true,
        state: "included",
        execution: "executed",
        hash: TX_HASH,
        blockNumber: 4242,
      };
      // A malformed hash is refused by the SDK's journal; the result below
      // then shows how the SDK treats it.
      await args.journalPreparedTransfer?.({
        txHash: typeof result.hash === "string" ? result.hash : "",
        nonce: 9,
        payer: PAYER,
        payee: args.to,
        amountOs: args.amountOs.toString(),
        network: args.recovery?.network ?? "demos",
        ...(args.recovery === undefined ? {} : { recovery: args.recovery }),
      }).catch(() => undefined);
      return result;
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

/** The SDK rail's held result: the hash is kept so the intent stays held; nothing is final. */
const HELD = {
  ok: false,
  txHash: TX_HASH,
  chainId: "demos:testnet",
  // The SDK rail's payer is its wallet's address.
  payer: `0x${PAYER}`,
  payee: RECIPIENT,
};

describe("payDemSettleCore (§9.5.9 native DEM)", () => {
  // #338: only the client createPayDemRail builds signs, journals, fences and
  // broadcasts the transfer and reads the node's transaction record itself. Any
  // other client is refused before its transfer, whatever it would return, so
  // its statement never costs the buyer a transfer (payDemExecutedStatus.test.ts
  // pins the SDK client's executed, failed and indeterminate verdicts).
  test.each<[string, Partial<DemosTransferResult>]>([
    ["an executed statement", {}],
    ["a bound failure proof", {
      ok: false,
      state: "failed",
      execution: undefined,
      blockNumber: 7,
      failureProof: {
        kind: "demos-failed-record",
        txHash: TX_HASH,
        nonce: 9,
        blockNumber: 7,
        payer: PAYER,
        payee: RECIPIENT,
        amountOs: "1500000000",
      },
    }],
    ["a timeout", { ok: false, state: "timeout", execution: undefined }],
    ["a rejected broadcast", {
      ok: false, state: "failed", execution: undefined, hash: OTHER_TX_HASH, message: "rejected",
    }],
    ["a malformed hash", { hash: "not-a-hash" }],
    ["a 0x-prefixed uppercase hash", { hash: `0x${TX_HASH.toUpperCase()}` }],
    ["acceptance without inclusion", { state: undefined }],
    ["inclusion without a block", { blockNumber: undefined }],
    ["inclusion without an execution attestation", { execution: undefined }],
    ["a non-normative terminal state", { state: "confirmed" }],
  ])("refuses a custom client before its transfer, whatever it would return: %s", async (_label, over) => {
    const transfer = vi.fn(async (): Promise<DemosTransferResult> => ({
      ok: true, state: "included", execution: "executed", hash: TX_HASH,
      blockNumber: 4242, ...over,
    }));
    await expect(payDemSettleCore(params(), { address: PAYER, transfer }))
      .rejects.toThrow(/not the one createPayDemRail built.*refusing transfer/);
    expect(transfer).not.toHaveBeenCalled();
  });

  test("checks the recovery generation immediately before native transfer", async () => {
    const rail = await sdkRail();
    let fenceChecks = 0;
    await expect(rail.settle(params(), {
      owner: "worker",
      generation: 2,
      settlementKey: "demos-native:DEM:job:0",
      bindingHash: "a".repeat(64),
      async assertCurrent() {
        fenceChecks += 1;
        throw new Error("stale effect generation");
      },
    })).rejects.toThrow(/stale effect generation/);
    expect(fenceChecks).toBe(1);
    expect(sdkTransfers()).toBe(0);
  });

  test("amount is parsed as an integer OS bigint (no floats)", async () => {
    const rail = await sdkRail();
    await expect(rail.settle(params({ amount: "1000000000" })))
      .resolves.toMatchObject({ ok: true });
    expect(sdk.transfer.mock.calls[0]![1]).toBe(1_000_000_000n);
  });

  test("rejects a malformed or underfunded per-payment debit ceiling before transfer", async () => {
    const client = fakeClient();
    await expect(payDemSettleCore(
      params({ maxTotalDebitOs: "1499999999" }),
      client,
    )).rejects.toThrow(/cannot be less than the amount/);
    await expect(payDemSettleCore(
      params({ maxTotalDebitOs: "1.5" }),
      client,
    )).rejects.toThrow(/positive integer OS text/);
    expect(client.sent).toBeUndefined();
  });

  const recovery = (over: Record<string, unknown> = {}) => ({
    railId: "demos-native:DEM",
    jobId: "job-recovery",
    phaseIndex: 2,
    settlementKey: "demos-native:DEM:job-recovery:2",
    network: "demos:testnet",
    payer: PAYER,
    payee: RECIPIENT,
    amountOs: "1500000000",
    ...over,
  });

  test("journals the exact recovery context with the prepared transfer", async () => {
    const rail = await sdkRail();
    const journaled: unknown[] = [];
    await expect(rail.settle(params({
      recovery: recovery(),
      journalPreparedTransfer: async (prepared: unknown) => {
        journaled.push(prepared);
      },
    }))).resolves.toMatchObject({ ok: true, txHash: TX_HASH });
    expect(journaled).toEqual([
      expect.objectContaining({ txHash: TX_HASH, recovery: recovery() }),
    ]);
  });

  test.each([
    ["a null context", null, /recovery context must be stable data/],
    ["an array context", [], /recovery context must be stable data/],
    ["a negative phase index", recovery({ phaseIndex: -1 }),
      /recovery phaseIndex must be a non-negative safe integer/],
    ["a fractional phase index", recovery({ phaseIndex: 1.5 }),
      /recovery phaseIndex must be a non-negative safe integer/],
    ["a key for another job", recovery({ jobId: "job-other" }),
      /settlementKey does not match railId, jobId, and phaseIndex/],
    ["a key for another phase", recovery({ phaseIndex: 3 }),
      /settlementKey does not match railId, jobId, and phaseIndex/],
    ["a non-canonical payer", recovery({ payer: `0x${PAYER}` }),
      /recovery payer must be a canonical native Demos address/],
    ["a non-canonical payee", recovery({ payee: RECIPIENT.toUpperCase() }),
      /recovery payee must be a canonical native Demos address/],
    ["a zero amount", recovery({ amountOs: "0" }),
      /recovery amountOs must be a canonical positive OS integer/],
    ["a leading-zero amount", recovery({ amountOs: "01500000000" }),
      /recovery amountOs must be a canonical positive OS integer/],
    ["another payer", recovery({ payer: "e5".repeat(32) }),
      /does not bind the exact payer, payee, network, and OS amount/],
    ["another payee", recovery({ payee: "e5".repeat(32) }),
      /does not bind the exact payer, payee, network, and OS amount/],
    ["another network", recovery({ network: "demos" }),
      /does not bind the exact payer, payee, network, and OS amount/],
    ["another amount", recovery({ amountOs: "1500000001" }),
      /does not bind the exact payer, payee, network, and OS amount/],
  ])("rejects %s as the recovery context before transfer", async (
    _case,
    context,
    message,
  ) => {
    const client = fakeClient();
    await expect(payDemSettleCore(params({ recovery: context }), client))
      .rejects.toThrow(message);
    expect(client.sent).toBeUndefined();
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

  test("a record that never executes holds the hash with no evidence", async () => {
    recordStatus = "pending";
    const rail = await sdkRail();
    const res = await rail.settle(params());
    expect(res).toEqual(HELD);
    expect(res.finality).toBeUndefined();
    expect(res.blockNumber).toBeUndefined();
  });

  // The SDK client's acceptance of `included` is pinned in payDem-adapter and
  // payDemExecutedStatus; any other status-index token never observes inclusion.
  test("pins the exact DACS-4 §9.5.9 terminal included state", () => {
    expect([...TERMINAL_INCLUDED]).toEqual(["included"]);
  });

  const statusIndexReports = (state: string) => {
    sdk.nodeCall.mockImplementation(async (message: string) =>
      message === "getAddressNonce" ? 8 : { state, blockNumber: 4242 });
  };

  test.each(["confirmed", "finalized", "INCLUDED", "accepted"])(
    "fails closed for non-normative terminal state %s",
    async (state) => {
      statusIndexReports(state);
      const rail = await sdkRail({ inclusionTimeoutMs: 20 });
      const res = await rail.settle(params());
      expect(res).toEqual(HELD);
      expect(sdk.getTxByHash).not.toHaveBeenCalled();
    },
  );

  test("does not let the compatibility set widen normative acceptance", async () => {
    TERMINAL_INCLUDED.add("confirmed");
    try {
      statusIndexReports("confirmed");
      const rail = await sdkRail({ inclusionTimeoutMs: 20 });
      const res = await rail.settle(params());
      expect(res).toEqual(HELD);
      expect(res.finality).toBeUndefined();
    } finally {
      TERMINAL_INCLUDED.delete("confirmed");
    }
  });

  test("pins payee and network before the effect await", async () => {
    const signed = deferred<void>();
    const rail = await sdkRail();
    const transfer = sdk.transfer.getMockImplementation()!;
    sdk.transfer.mockImplementation(async (to: string, amountOs: bigint) => {
      await signed.promise;
      return transfer(to, amountOs);
    });
    const input = params();
    const settlement = rail.settle(input);

    input.recipient = "substituted-payee";
    input.network = "substituted-network";
    signed.resolve();

    await expect(settlement).resolves.toMatchObject({
      ok: true,
      payee: RECIPIENT,
      chainId: "demos:testnet",
      txHash: TX_HASH,
    });
  });

  test("ignores a poisoned transfer bind on a client it refuses", async () => {
    class ReceiverClient implements DemosNativeClient {
      readonly address = PAYER;
      readonly calls: bigint[] = [];

      async transfer(args: { to: string; amountOs: bigint }) {
        this.calls.push(args.amountOs);
        return {
          ok: true,
          state: "included",
          execution: "executed" as const,
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

    await expect(payDemSettleCore(params(), client)).rejects.toThrow(/refusing transfer/);
    expect(poison).not.toHaveBeenCalled();
    expect(client.calls).toEqual([]);
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

  test("refuses a custom client without reading its accessor transfer result", async () => {
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
      /refusing transfer/,
    );
    expect(reads).toBe(0);
  });
});

describe("payDemSettle (runSession seam bridge — §9.5.9 DEM→OS conversion, PB-2 destination)", () => {
  // A Demos primary claim intrinsically embeds the ed25519 pubkey hex.
  const SELLER_HEX = "a1".repeat(32);
  const PAYEE_CLAIM = `did:demos:agent:${SELLER_HEX}`;
  const OTHER_HEX = "b2".repeat(32);

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
  const bindingFor = (
    request: ReturnType<typeof req>,
  ): Readonly<SettlementBinding> => Object.freeze({
    bindingVersion: "1",
    railId: request.rail as string,
    jobId: request.jobId as string,
    phaseIndex: request.phaseIndex as number,
    phase: request.phase as string,
    amount: baseUnits(request.amount as string, 9),
    agreementAsset: request.asset as string,
    settlementAsset: "DEM",
    payer: PAYER,
    payee: SELLER_HEX,
    network: "demos",
    finality: Object.freeze({ model: "bft-final" }),
  });
  /**
   * The SDK rail, whose transfer must not run: tests of a refusal, or of a
   * reconciliation without rebroadcast, check that `transfer` stays uncalled.
   */
  const unusedRail = async () => {
    const rail = await sdkRail();
    sdk.transfer.mockRejectedValue(new Error("must not rebroadcast"));
    return { rail, transfer: sdk.transfer };
  };
  const seedExpiredIntent = async (
    log: SettlementLog,
    request: ReturnType<typeof req>,
  ) => log.claimIntent({
    key: settlementKey(
      request.rail as string,
      request.jobId as string,
      request.phaseIndex as number,
    ),
    bindingHash: settlementBindingHash(bindingFor(request)),
    owner: "crashed-test-owner",
    now: 0,
    leaseDurationMs: 1,
  });

  test("keeps only the transaction identity on a non-final result", async () => {
    recordStatus = "pending";
    await expect(payDemSettle(await sdkRail(), { recipient: PAYEE_CLAIM, network: "demos" })(req()))
      .resolves.toStrictEqual({
        ok: false,
        txHash: TX_HASH,
        chainId: "demos",
        payer: PAYER,
        payee: SELLER_HEX,
      });
  });

  // #338: a rail whose result the SDK could never make final is refused before
  // its settle runs, so it cannot debit the buyer and then leave the payment
  // held. Only createPayDemRail's settle is called, also when a caller places
  // it on its own object.
  test.each<[string, (sdkOwned: PayDemRail) => PayDemRail]>([
    ["a custom rail around a custom client", () => ({
      address: PAYER,
      settle: (params) => payDemSettleCore(params, fakeClient()),
    })],
    ["a custom rail's non-final result", () => ({
      address: PAYER,
      settle: async () => ({
        ok: false, txHash: TX_HASH, chainId: "demos", payer: PAYER, payee: SELLER_HEX,
      }),
    })],
    ["a custom rail's executed success", () => ({
      address: PAYER,
      settle: async () => ({
        ok: true,
        execution: "executed",
        txHash: TX_HASH,
        chainId: "demos",
        payer: PAYER,
        payee: SELLER_HEX,
        finality: { model: "bft-final" },
        blockNumber: 4242,
        txRefKind: "demos",
      }),
    })],
    ["a legacy rail's success without execution", () => ({
      address: PAYER,
      settle: async () => ({
        ok: true, txHash: TX_HASH, chainId: "demos", payer: PAYER, payee: SELLER_HEX,
        finality: { model: "bft-final" }, blockNumber: 42, txRefKind: "demos",
      }) as unknown as Awaited<ReturnType<PayDemRail["settle"]>>,
    })],
    ["a wrapper relaying the SDK rail's genuine success", (sdkOwned) => ({
      address: PAYER,
      settle: (params, fence) => sdkOwned.settle(params, fence),
    })],
    ["a wrapper relaying a copy of the SDK rail's success", (sdkOwned) => ({
      address: PAYER,
      settle: async (params, fence) => ({ ...await sdkOwned.settle(params, fence) }),
    })],
  ])("refuses %s before its settle runs", async (_case, build) => {
    const rail = build(await sdkRail());
    const settle = vi.spyOn(rail, "settle");
    expect(isPayDemRecordVerifyingRail(rail)).toBe(false);
    await expect(payDemSettle(rail, { network: "demos" })(req()))
      .rejects.toThrow(/createPayDemRail returned.*refusing/);
    expect(settle).not.toHaveBeenCalled();
    expect(sdkTransfers()).toBe(0);
  });

  // The refusal is of a fresh attempt only: nothing ran, so the store releases
  // the key instead of holding it as an ambiguous attempt.
  test("refuses a custom rail's fresh attempt without holding the key", async () => {
    const log = createInMemorySettlementLog();
    const putOutcome = vi.spyOn(log, "putOutcome");
    const store = createIdempotencyStore(log);
    const settle = vi.fn<PayDemRail["settle"]>();
    const request = req({ jobId: "job-refused-custom" });

    await expect(payDemSettle({ address: PAYER, settle }, { network: "demos" }, { store })(request))
      .rejects.toThrow(/createPayDemRail returned.*refusing/);
    expect(settle).not.toHaveBeenCalled();
    expect(putOutcome).not.toHaveBeenCalled();

    await expect(payDemSettle(await sdkRail(), { network: "demos" }, {
      store,
    })(request)).resolves.toMatchObject({ ok: true, txHash: TX_HASH });
    expect(sdkTransfers()).toBe(1);
  });

  test("refuses both of two overlapping fresh attempts through a custom rail", async () => {
    const settle = vi.fn<PayDemRail["settle"]>();
    const bridge = payDemSettle({ address: PAYER, settle }, { network: "demos" });
    const refused = {
      status: "rejected",
      reason: expect.objectContaining({
        message: expect.stringMatching(/createPayDemRail returned.*refusing/),
      }),
    };

    await expect(Promise.allSettled([bridge(req()), bridge(req())]))
      .resolves.toEqual([refused, refused]);
    expect(settle).not.toHaveBeenCalled();
  });

  // A payment a custom rail made before the upgrade must still reconcile:
  // the bridge is built for any rail, and recovery never calls its settle.
  test("reconciles a custom rail's retained attempt without calling the rail", async () => {
    const log = createInMemorySettlementLog();
    const request = req({ jobId: "job-retained-custom" });
    await seedExpiredIntent(log, request);
    const settle = vi.fn<PayDemRail["settle"]>();
    const rail: PayDemRail = { address: PAYER, settle };
    const reconcile = vi.fn(async (context: PayDemSettlementRecoveryContext) => ({
      ok: true as const,
      txHash: TX_HASH,
      chainId: context.network,
      payer: context.payer,
      payee: context.payee,
      finality: { model: "bft-final" as const },
      blockNumber: 4242,
      txRefKind: "demos" as const,
      amountOs: context.amountOs,
      execution: "executed" as const,
    }));
    const bridge = () => payDemSettle(rail, { network: "demos" }, {
      store: createIdempotencyStore(log),
      reconcile,
    });

    await expect(bridge()(request)).resolves.toMatchObject({
      ok: true,
      txHash: TX_HASH,
      blockNumber: 4242,
      payee: SELLER_HEX,
    });
    // After another restart the recorded outcome is re-authenticated, again
    // without calling the rail.
    await expect(bridge()(request)).resolves.toMatchObject({ ok: true, txHash: TX_HASH });
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(settle).not.toHaveBeenCalled();
    expect(sdkTransfers()).toBe(0);
  });

  test("calls only the SDK's own rail and a caller's object carrying its settle", async () => {
    const owned = await sdkRail();
    for (const rail of [owned, { address: owned.address, settle: owned.settle }]) {
      expect(isPayDemRecordVerifyingRail(rail)).toBe(true);
      expect(() => payDemSettle(rail, { network: "demos" })).not.toThrow();
    }
    expect(isPayDemRecordVerifyingRail({
      address: PAYER,
      settle: (params: Parameters<PayDemRail["settle"]>[0]) => payDemSettleCore(params, fakeClient()),
    })).toBe(false);
    expect(isPayDemRecordVerifyingRail({ address: PAYER })).toBe(false);
    expect(isPayDemRecordVerifyingRail(null)).toBe(false);
  });

  // The store sees the bridge's submission; only one around createPayDemRail's
  // own settle may have its failure proof recorded as definitive.
  test.each([
    ["createPayDemRail's settle", true],
    ["a custom rail", false],
  ])("lets the store treat a submission around %s as record-verified: %s", async (
    _source,
    expected,
  ) => {
    const rail: PayDemRail = expected
      ? await sdkRail()
      : { address: PAYER, settle: vi.fn<PayDemRail["settle"]>() };
    let submitted: unknown;
    const store = {
      async once(_key: string, _binding: unknown, submit: () => Promise<SettleResult>) {
        submitted = submit;
        return submit();
      },
    } as unknown as SettlementIdempotencyStore;
    const settled = payDemSettle(rail, { recipient: PAYEE_CLAIM, network: "demos" }, { store })(req());
    // This store does not release a submission that never ran, so the bridge
    // refuses its result; either way the custom rail's settle never ran.
    await (expected
      ? expect(settled).resolves.toMatchObject({ ok: true })
      : expect(settled).rejects.toThrow());
    if (!expected) expect(rail.settle).not.toHaveBeenCalled();
    expect(typeof submitted).toBe("function");
    expect(isRecordVerifiedSource(submitted)).toBe(expected);
  });

  test("converts the agreement's DECIMAL DEM to integer OS base units (×10^9)", async () => {
    const res = await payDemSettle(await sdkRail(), {
      recipient: PAYEE_CLAIM,
      network: "demos",
    })(req({ amount: "5" }));
    expect(res.ok).toBe(true);
    // "5" DEM must move 5 × 10^9 OS — NOT 5 OS (the pre-fix silent 10^-9 bug).
    expect(sdk.transfer.mock.calls[0]![1]).toBe(5_000_000_000n);
    expect(res.finality).toEqual({ model: "bft-final" });
  });

  // #338: the bridge reports a final verdict only from the SDK's own record
  // read. A transfer with no bound confirmed record is held: never final,
  // never persisted, never paid twice.
  test("holds a transfer without a bound confirmed record: no final verdict, no second payment", async () => {
    recordStatus = "pending";
    const log = createInMemorySettlementLog();
    const putOutcome = vi.spyOn(log, "putOutcome");
    const settle = payDemSettle(await sdkRail(), { network: "demos" }, {
      store: createIdempotencyStore(log),
    });
    const held = await settle(req());
    expect(held).toEqual({
      ok: false,
      txHash: TX_HASH,
      chainId: "demos",
      payer: PAYER,
      payee: SELLER_HEX,
    });
    await expect(settle(req())).rejects.toThrow(/refusing to resubmit/);
    expect(putOutcome).not.toHaveBeenCalled();
    expect(sdkTransfers()).toBe(1);
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
  });

  test("keeps the SDK rail's settle final when a caller reuses it on its own object", async () => {
    const owned = await sdkRail();
    const res = await payDemSettle({ address: owned.address, settle: owned.settle }, {
      network: "demos",
    })(req());
    expect(res).toMatchObject({ ok: true, txHash: TX_HASH, finality: { model: "bft-final" } });
  });

  test("handles fractional DEM within the 9-decimal precision", async () => {
    await payDemSettle(await sdkRail(), { recipient: PAYEE_CLAIM, network: "demos" })(
      req({ amount: "5.1" }),
    );
    expect(sdk.transfer.mock.calls[0]![1]).toBe(5_100_000_000n);
  });

  test("SAFE BY DEFAULT: repeated settlement for one session phase submits once", async () => {
    const settle = payDemSettle(await sdkRail(), { network: "demos" });
    const first = await settle(req());
    expect(first.ok).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.finality)).toBe(true);
    expect(() => {
      (first.finality as { model: string }).model = "mutated";
    }).toThrow();
    const second = await settle(req());
    expect(sdkTransfers()).toBe(1);
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(first).not.toHaveProperty("execution");
  });

  test("a tx-bearing timeout holds the intent and never submits a second payment", async () => {
    sdk.nodeCall.mockImplementation(async (message: string) =>
      message === "getAddressNonce" ? 8 : { state: "pending" });
    const settle = payDemSettle(await sdkRail({ inclusionTimeoutMs: 20 }), { network: "demos" });

    await expect(settle(req())).resolves.toMatchObject({
      ok: false,
      txHash: TX_HASH,
    });
    await expect(settle(req())).rejects.toThrow(/refusing to resubmit/);
    expect(sdkTransfers()).toBe(1);
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
  });

  test("an injected durable store dedupes across bridge instances after restart", async () => {
    const rail = await sdkRail();
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
      execution: "executed" as const,
    }));
    const resumed = await payDemSettle(rail, { network: "demos" }, {
      store,
      reconcile,
    })(req());
    expect(sdkTransfers()).toBe(1);
    expect(resumed).toMatchObject({ ok: true, txHash: TX_HASH });
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["without reconciliation", undefined,
      /cannot be authenticated after restart without reconciliation/],
    ["when reconciliation proves absence", async () => null,
      /contradicts reconciliation proof of absence/],
    ["when reconciliation returns another transaction", { txHash: OTHER_TX_HASH },
      /does not match the authoritative reconciled transaction/],
    ["when reconciliation returns another block", { blockNumber: 4243 },
      /does not match the authoritative reconciled transaction/],
    ["when reconciliation does not attest execution (#338)",
      async (context: PayDemSettlementRecoveryContext) => ({
        ok: true,
        txHash: TX_HASH,
        chainId: context.network,
        payer: context.payer,
        payee: context.payee,
        finality: { model: "bft-final" as const },
        blockNumber: 4242,
        txRefKind: "demos",
        amountOs: context.amountOs,
      }),
      /does not attest that the transaction record shows the transfer executed/],
    ["when reconciliation attests inclusion instead of execution (#338)",
      { execution: "included" },
      /does not attest that the transaction record shows the transfer executed/],
  ])("refuses a restarted durable outcome %s", async (_case, reconciled, message) => {
    const rail = await sdkRail();
    const store = createIdempotencyStore(createInMemorySettlementLog());
    await expect(payDemSettle(rail, { network: "demos" }, { store })(req()))
      .resolves.toMatchObject({ ok: true });
    const reconcile = typeof reconciled === "function"
      ? reconciled
      : reconciled === undefined
        ? undefined
        : vi.fn(async (context: PayDemSettlementRecoveryContext) => ({
            ok: true,
            txHash: TX_HASH,
            chainId: context.network,
            payer: context.payer,
            payee: context.payee,
            finality: { model: "bft-final" as const },
            blockNumber: 4242,
            txRefKind: "demos",
            amountOs: context.amountOs,
            execution: "executed" as const,
            ...reconciled,
          }));

    await expect(payDemSettle(rail, { network: "demos" }, {
      store,
      ...(reconcile === undefined
        ? {}
        : { reconcile: reconcile as unknown as PayDemSettlementReconcile }),
    })(req())).rejects.toThrow(message);
    expect(sdkTransfers()).toBe(1);
  });

  test("refuses a request for another phase or rail before transferring", async () => {
    const { rail, transfer: railTransfer } = await unusedRail();

    await expect(payDemSettle(rail, { network: "demos" })(req({ phase: "deliver" })))
      .rejects.toThrow(/requires phase "pay-dem", got "deliver"/);
    await expect(payDemSettle(rail, {
      network: "demos",
      railId: "demos-native:DEM",
    })(req({ rail: "pay-dem" })))
      .rejects.toThrow(/request rail "pay-dem" does not match authenticated descriptor/);
    expect(railTransfer).not.toHaveBeenCalled();
  });

  test("durably recovers intent → journal → ambiguity → restart under the same exact tuple", async () => {
    const backing = createInMemorySettlementLog();
    const lifecycle: string[] = [];
    const log: SettlementLog = {
      async claimIntent(input) {
        lifecycle.push(`intent:${input.key}`);
        return backing.claimIntent(input);
      },
      isCurrent(input) {
        return backing.isCurrent(input);
      },
      grantRecovery(input) {
        lifecycle.push(`grant:${input.key}`);
        return backing.grantRecovery(input);
      },
      async putOutcome(input) {
        lifecycle.push(`outcome:${input.key}`);
        return backing.putOutcome(input);
      },
      async releaseIntent(input) {
        lifecycle.push(`release:${input.key}`);
        return backing.releaseIntent(input);
      },
    };
    const contexts: unknown[] = [];
    // The first process journals its signed transfer, broadcasts it and never
    // observes an executed record.
    recordStatus = "pending";
    const firstRail = await sdkRail({
      journalPreparedTransfer: async (prepared) => {
        lifecycle.push(`journal:${prepared.recovery?.settlementKey}`);
        contexts.push(prepared.recovery);
      },
    });
    const request = req({
      rail: "demos-native:DEM",
      jobId: "job-restart",
      phaseIndex: 3,
      amount: "1.25",
    });
    let now = 0;
    const firstStore = createIdempotencyStore(log, {
      owner: "first-process",
      leaseDurationMs: 10,
      now: () => now,
    });
    await expect(payDemSettle(firstRail, { network: "demos" }, {
      store: firstStore,
    })(request)).resolves.toMatchObject({ ok: false, txHash: TX_HASH });

    const { rail: restartedRail, transfer: restartedTransfer } = await unusedRail();
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
      execution: "executed" as const,
    }));
    now = 11;
    const restartedStore = createIdempotencyStore(log, {
      owner: "restarted-process",
      leaseDurationMs: 10_000,
      now: () => now,
    });
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
    expect(recovered).not.toHaveProperty("execution");
    expect(restartedTransfer).toHaveBeenCalledTimes(1);
    expect(sdk.broadcast).toHaveBeenCalledTimes(1);
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
    const request = req({
      rail: "demos-native:DEM",
      jobId: "job-ambiguous",
      phaseIndex: 1,
    });
    await seedExpiredIntent(log, request);
    const { rail, transfer: railTransfer } = await unusedRail();
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
    })(request)).rejects.toThrow(/definitive finalized result/);
    expect(railTransfer).not.toHaveBeenCalled();
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
    ["fractional block", { blockNumber: 1.5 }, /invalid Demos block number/],
    ["extra field", { memo: "paid" }, /malformed pay-dem settlement shape/],
    ["non-boolean ok", { ok: "true" }, /malformed pay-dem settlement shape/],
    ["numeric amount", { amountOs: 5_000_000_000 }, /exact requested OS amount/],
    ["empty hash", { txHash: "" }, /success lacks canonical tx identity/],
    ["null finality", { finality: null }, /success lacks canonical tx identity/],
    ["finality with depth", { finality: { model: "bft-final", finalityBlocks: 1 } },
      /exact Demos bft-final finality/],
    ["fee with a leading zero", { networkFeeOs: "01" }, /network-fee accounting/],
    ["numeric fee", { networkFeeOs: 1 }, /network-fee accounting/],
    ["indeterminate with finality", { ok: false },
      /failure must not claim settlement finality/],
    ["missing block", { omit: "blockNumber" }, /success lacks canonical tx identity/],
    ["missing tx ref", { omit: "txRefKind" }, /success lacks canonical tx identity/],
    ["missing finality", { omit: "finality" }, /success lacks canonical tx identity/],
  ])("rejects malicious %s reconciliation without rebroadcast", async (
    _label,
    { omit, ...override }: Record<string, unknown>,
    pattern,
  ) => {
    const key = "demos-native:DEM:job-malicious:2";
    const log = createInMemorySettlementLog();
    const request = req({
      rail: "demos-native:DEM",
      jobId: "job-malicious",
      phaseIndex: 2,
    });
    await seedExpiredIntent(log, request);
    const { rail, transfer: railTransfer } = await unusedRail();
    const reconcile = vi.fn(async (context) => {
      const reconciled: Record<string, unknown> = {
        ok: true,
        txHash: TX_HASH,
        chainId: context.network,
        payer: context.payer,
        payee: context.payee,
        finality: { model: "bft-final" as const },
        blockNumber: 9,
        txRefKind: "demos",
        amountOs: context.amountOs,
        execution: "executed" as const,
        ...override,
      };
      if (typeof omit === "string") delete reconciled[omit];
      return reconciled;
    });
    const putOutcome = vi.spyOn(log, "putOutcome");

    await expect(payDemSettle(rail, { network: "demos" }, {
      store: createIdempotencyStore(log),
      reconcile: reconcile as unknown as PayDemSettlementReconcile,
    })(request)).rejects.toThrow(pattern);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(railTransfer).not.toHaveBeenCalled();
    expect(putOutcome).not.toHaveBeenCalled();
  });

  test.each([
    ["an array", []],
    ["a string", "settled"],
  ])("rejects a held intent's reconciliation that returns %s, without rebroadcast", async (
    _case,
    reconciled,
  ) => {
    const log = createInMemorySettlementLog();
    const request = req({
      rail: "demos-native:DEM",
      jobId: "job-not-object",
      phaseIndex: 6,
    });
    await seedExpiredIntent(log, request);
    const { rail, transfer: railTransfer } = await unusedRail();
    const putOutcome = vi.spyOn(log, "putOutcome");

    await expect(payDemSettle(rail, { network: "demos" }, {
      store: createIdempotencyStore(log),
      reconcile: (async () => reconciled) as unknown as PayDemSettlementReconcile,
    })(request)).rejects.toThrow(/must return a settlement object or null/);
    expect(railTransfer).not.toHaveBeenCalled();
    expect(putOutcome).not.toHaveBeenCalled();
  });

  test.each([
    ["no execution attestation", {}],
    ["an execution attestation other than executed", { execution: "included" }],
    ["a boolean execution attestation", { execution: true }],
  ])("refuses a held intent's reconciliation with %s, without rebroadcast (#338)", async (
    _case,
    execution,
  ) => {
    // A reconciler written when `included` alone meant success must not turn
    // an included-but-failed transfer into a settlement on recovery.
    const log = createInMemorySettlementLog();
    const request = req({
      rail: "demos-native:DEM",
      jobId: "job-unattested",
      phaseIndex: 4,
    });
    await seedExpiredIntent(log, request);
    const { rail, transfer: railTransfer } = await unusedRail();
    const reconcile = vi.fn(async (context: PayDemSettlementRecoveryContext) => ({
      ok: true,
      txHash: TX_HASH,
      chainId: context.network,
      payer: context.payer,
      payee: context.payee,
      finality: { model: "bft-final" as const },
      blockNumber: 9,
      txRefKind: "demos",
      amountOs: context.amountOs,
      ...execution,
    }));
    const putOutcome = vi.spyOn(log, "putOutcome");

    await expect(payDemSettle(rail, { network: "demos" }, {
      store: createIdempotencyStore(log),
      reconcile: reconcile as unknown as PayDemSettlementReconcile,
    })(request)).rejects.toThrow(
      /does not attest that the transaction record shows the transfer executed/,
    );
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(railTransfer).not.toHaveBeenCalled();
    expect(putOutcome).not.toHaveBeenCalled();
  });

  describe("terminal-failure proof binding (#338)", () => {
    const AMOUNT_OS = "5000000000";
    const failureProof = (override: Record<string, unknown> = {}) => ({
      kind: "demos-failed-record",
      txHash: TX_HASH,
      nonce: 9,
      blockNumber: 4242,
      payer: PAYER,
      payee: SELLER_HEX,
      amountOs: AMOUNT_OS,
      ...override,
    });
    const failure = (override: Record<string, unknown> = {}) => ({
      ok: false,
      txHash: TX_HASH,
      chainId: "demos",
      payer: PAYER,
      payee: SELLER_HEX,
      errorClass: "permanent",
      failureProof: failureProof(),
      blockNumber: 4242,
      txRefKind: "demos",
      ...override,
    });
    const success = (context: PayDemSettlementRecoveryContext) => ({
      ok: true,
      txHash: TX_HASH,
      chainId: context.network,
      payer: context.payer,
      payee: context.payee,
      finality: { model: "bft-final" as const },
      blockNumber: 4242,
      txRefKind: "demos",
      amountOs: context.amountOs,
      execution: "executed" as const,
    });
    const NON_BINDING: Array<[string, Record<string, unknown>]> = [
      ["another amount", { failureProof: failureProof({ amountOs: "1" }) }],
      ["another transaction", { failureProof: failureProof({ txHash: OTHER_TX_HASH }) }],
      ["another block", { failureProof: failureProof({ blockNumber: 1 }) }],
      ["another payee", { failureProof: failureProof({ payee: OTHER_HEX }) }],
      ["an extra proof key", { failureProof: { ...failureProof(), extra: 1 } }],
      ["a permanent class without proof", { failureProof: undefined }],
      ["a proof without a permanent class", { errorClass: undefined }],
    ];
    const withoutUndefined = (value: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
    // createPayDemRail over a node that records the signed transfer `failed`:
    // its settle reads and binds that record itself, so its proof is the only
    // one the store may keep (payDemExecutedStatus.test.ts varies the record).
    const recordVerifiedRail = () => {
      recordStatus = "failed";
      return sdkRail();
    };
    const HELD_FAILURE = {
      ok: false,
      txHash: TX_HASH,
      chainId: "demos",
      payer: PAYER,
      payee: SELLER_HEX,
    };

    test("persists a record-verified rail's bound failed record and reuses it without a second transfer", async () => {
      const log = createInMemorySettlementLog();
      const putOutcome = vi.spyOn(log, "putOutcome");
      const settle = payDemSettle(await recordVerifiedRail(), { network: "demos" }, {
        store: createIdempotencyStore(log),
      });
      const first = await settle(req());
      expect(first).toEqual({ ...failure(), payee: SELLER_HEX });
      await expect(settle(req())).resolves.toEqual(first);
      expect(sdkTransfers()).toBe(1);
      expect(putOutcome).toHaveBeenCalledTimes(1);
    });

    // A custom rail's proof is its statement, even one relaying the SDK rail's
    // genuine proof: such a rail is refused before its settle runs, so its
    // failure can neither cost a transfer nor be persisted.
    test("refuses a wrapper around a record-verified settle before it fails", async () => {
      const verified = await recordVerifiedRail();
      const settle = vi.fn((params: Parameters<PayDemRail["settle"]>[0], fence?: Parameters<PayDemRail["settle"]>[1]) =>
        verified.settle(params, fence));
      await expect(payDemSettle({ address: PAYER, settle }, { network: "demos" })(req()))
        .rejects.toThrow(/refusing/);
      expect(settle).not.toHaveBeenCalled();
      expect(sdkTransfers()).toBe(0);
    });

    // A reconciler is the caller's statement, even for a record-verified rail,
    // so its bound failure never becomes the definitive outcome.
    test("keeps a held intent held when reconciliation reports a bound failure", async () => {
      const log = createInMemorySettlementLog();
      const request = req({ rail: "demos-native:DEM", jobId: "job-failed", phaseIndex: 7 });
      await seedExpiredIntent(log, request);
      const rail = await recordVerifiedRail();
      const reconcile = vi.fn(async (context: PayDemSettlementRecoveryContext) => ({
        ...failure(),
        amountOs: context.amountOs,
      }));
      const putOutcome = vi.spyOn(log, "putOutcome");
      const settle = payDemSettle(rail, { network: "demos" }, {
        store: createIdempotencyStore(log),
        reconcile: reconcile as unknown as PayDemSettlementReconcile,
      });
      await expect(settle(request)).rejects.toThrow(/reconciliation was not definitive/);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(putOutcome).not.toHaveBeenCalled();
      expect(sdkTransfers()).toBe(0);
    });

    test.each([
      ...NON_BINDING.map(([name, override]): [string, Record<string, unknown>, RegExp] =>
        [name, override, /invalid terminal-failure proof/]),
      ["an execution attestation", { execution: "executed" },
        /permanent failure must not attest successful execution/],
      ["an inclusion attestation", { execution: "included" },
        /permanent failure must not attest successful execution/],
    ])("refuses a held intent's reconciled failure with %s, without rebroadcast", async (
      _case,
      override,
      pattern,
    ) => {
      const log = createInMemorySettlementLog();
      const request = req({ rail: "demos-native:DEM", jobId: "job-failed-bad", phaseIndex: 8 });
      await seedExpiredIntent(log, request);
      const { rail, transfer: railTransfer } = await unusedRail();
      const reconcile = vi.fn(async (context: PayDemSettlementRecoveryContext) =>
        withoutUndefined({ ...failure(override), amountOs: context.amountOs }));
      const putOutcome = vi.spyOn(log, "putOutcome");
      await expect(payDemSettle(rail, { network: "demos" }, {
        store: createIdempotencyStore(log),
        reconcile: reconcile as unknown as PayDemSettlementReconcile,
      })(request)).rejects.toThrow(pattern);
      expect(railTransfer).not.toHaveBeenCalled();
      expect(putOutcome).not.toHaveBeenCalled();
    });

    test("refuses a restarted durable success that reconciliation reports failed", async () => {
      const store = createIdempotencyStore(createInMemorySettlementLog());
      const rail = await sdkRail();
      await expect(payDemSettle(rail, { network: "demos" }, { store })(req()))
        .resolves.toMatchObject({ ok: true, txHash: TX_HASH, blockNumber: 4242 });
      const reconcile = vi.fn(async (context: PayDemSettlementRecoveryContext) => ({
        ...failure(),
        amountOs: context.amountOs,
      }));
      await expect(payDemSettle(rail, { network: "demos" }, {
        store,
        reconcile: reconcile as unknown as PayDemSettlementReconcile,
      })(req())).rejects.toThrow(/contradicts the authoritative reconciled outcome/);
      expect(sdkTransfers()).toBe(1);
    });

    test("refuses a restarted durable failure that reconciliation reports executed", async () => {
      const store = createIdempotencyStore(createInMemorySettlementLog());
      const rail = await recordVerifiedRail();
      await expect(payDemSettle(rail, { network: "demos" }, { store })(req()))
        .resolves.toMatchObject({ ok: false, errorClass: "permanent" });
      await expect(payDemSettle(rail, { network: "demos" }, {
        store,
        reconcile: vi.fn(async (context: PayDemSettlementRecoveryContext) => success(context)),
      })(req())).rejects.toThrow(/contradicts the authoritative reconciled outcome/);
      expect(sdkTransfers()).toBe(1);
    });

    test("refuses a restarted durable failure whose reconciled proof names another nonce", async () => {
      const store = createIdempotencyStore(createInMemorySettlementLog());
      const rail = await recordVerifiedRail();
      await expect(payDemSettle(rail, { network: "demos" }, { store })(req()))
        .resolves.toMatchObject({ ok: false, errorClass: "permanent" });
      const reconcile = vi.fn(async (context: PayDemSettlementRecoveryContext) => ({
        ...failure({ failureProof: failureProof({ nonce: 10 }) }),
        amountOs: context.amountOs,
      }));
      await expect(payDemSettle(rail, { network: "demos" }, {
        store,
        reconcile: reconcile as unknown as PayDemSettlementReconcile,
      })(req())).rejects.toThrow(/contradicts the authoritative reconciled outcome/);
    });

    test("reuses a restarted durable failure that reconciliation confirms", async () => {
      const store = createIdempotencyStore(createInMemorySettlementLog());
      const rail = await recordVerifiedRail();
      const first = await payDemSettle(rail, { network: "demos" }, { store })(req());
      expect(first).toMatchObject({ ok: false, errorClass: "permanent" });
      const reconcile = vi.fn(async (context: PayDemSettlementRecoveryContext) => ({
        ...failure(),
        amountOs: context.amountOs,
      }));
      await expect(payDemSettle(rail, { network: "demos" }, {
        store,
        reconcile: reconcile as unknown as PayDemSettlementReconcile,
      })(req())).resolves.toEqual(first);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(sdkTransfers()).toBe(1);
    });
  });

  test("a cached success cannot be reused under changed amount terms", async () => {
    const log = createInMemorySettlementLog();
    const key = "demos-native:DEM:job-cached:5";
    const originalRequest = req({
      rail: "demos-native:DEM",
      jobId: "job-cached",
      phaseIndex: 5,
      amount: "1",
    });
    await createIdempotencyStore(log).once(key, bindingFor(originalRequest), async () => ({
        ok: true,
        txHash: TX_HASH,
        chainId: "demos",
        payer: PAYER,
        payee: SELLER_HEX,
        finality: { model: "bft-final" },
        blockNumber: 7,
        txRefKind: "demos",
      }));
    const { rail, transfer: railTransfer } = await unusedRail();
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
      execution: "executed" as const,
    }));

    await expect(payDemSettle(rail, { network: "demos" }, {
      store: createIdempotencyStore(log),
      reconcile,
    })(req({
      rail: "demos-native:DEM",
      jobId: "job-cached",
      phaseIndex: 5,
      amount: "2",
    }))).rejects.toThrow(/different terms/);
    expect(reconcile).not.toHaveBeenCalled();
    expect(railTransfer).not.toHaveBeenCalled();
  });

  test("rejects an invalid cached success without invoking submit or reconciliation", async () => {
    const { rail, transfer: railTransfer } = await unusedRail();
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
    expect(railTransfer).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  test("accepts a structurally valid class-based settlement store", async () => {
    class ClassStore {
      async once(
        _key: string,
        _binding: Readonly<SettlementBinding>,
        submit: () => Promise<SettleResult>,
      ): Promise<SettleResult> {
        return submit();
      }
    }
    const rail = await sdkRail();

    await expect(payDemSettle(rail, { network: "demos" }, {
      store: new ClassStore(),
    })(req({ jobId: "job-class-store" }))).resolves.toMatchObject({
      ok: true,
      txHash: TX_HASH,
    });
  });

  test("cross-checks a configured phaseIndex and never silently supplies it", async () => {
    const { rail, transfer: railTransfer } = await unusedRail();
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
    expect(railTransfer).not.toHaveBeenCalled();
  });

  test("rejects a zero DEM amount at the bridge before invoking an injected rail", async () => {
    const { rail, transfer: railTransfer } = await unusedRail();

    await expect(payDemSettle(rail)(req({ amount: "0" })))
      .rejects.toThrow(/amount must be > 0/);
    expect(railTransfer).not.toHaveBeenCalled();
  });

  test("binds the prepared transfer to the exact PC-7 rail/session/phase key", async () => {
    const journaled: Array<PayDemPreparedTransfer["recovery"]> = [];
    const settle = payDemSettle(await sdkRail({
      journalPreparedTransfer: async (prepared) => {
        journaled.push(prepared.recovery);
      },
    }), { network: "demos" });

    await settle(req({ rail: "demos-native:DEM", jobId: "job-7", phaseIndex: 2 }));

    expect(journaled).toHaveLength(1);
    expect(journaled[0]).toEqual({
      railId: "demos-native:DEM",
      jobId: "job-7",
      phaseIndex: 2,
      settlementKey: "demos-native:DEM:job-7:2",
      network: "demos",
      payer: PAYER,
      payee: SELLER_HEX,
      amountOs: "5000000000",
    });
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

  /**
   * The bridge over the SDK rail. `sent()` is the transfer that rail asked
   * demosdk to sign, or undefined when it made none.
   */
  const settleWith = (
    cfg: { recipient?: string; network?: string } = { recipient: PAYEE_CLAIM, network: "demos" },
  ) => async (request: ReturnType<typeof req>) => payDemSettle(await sdkRail(), cfg)(request);
  const sent = () => {
    const call = sdk.transfer.mock.calls[0];
    return call === undefined ? undefined : { to: call[0] as string, amountOs: call[1] as bigint };
  };

  test("rejects a non-DEM asset (pay-dem settles DEM only)", async () => {
    await expect(settleWith()(req({ asset: "USDC" }))).rejects.toThrow(
      /settles DEM only/,
    );
  });

  test("rejects sub-OS precision (> 9 fractional digits)", async () => {
    await expect(
      settleWith()(req({ amount: "5.0000000001" })),
    ).rejects.toThrow(/precision/);
  });

  // ── PB-2 Tier 1: the destination comes from the AGREEMENT, not from config ──

  test("transfers to the agreement's payee (derived intrinsically from the claim)", async () => {
    await settleWith()(req());
    expect(sent()!.to).toBe(SELLER_HEX);
  });

  test("the request payee determines the destination with NO configured recipient", async () => {
    await settleWith({ network: "demos" })(req());
    expect(sent()!.to).toBe(SELLER_HEX);
  });

  test("normalizes a same-address Demos DID request binding and returns it verbatim", async () => {
    const result = await settleWith({ network: "demos" })(
      req({ expectedPayee: PAYEE_CLAIM }),
    );
    expect(sent()!.to).toBe(SELLER_HEX);
    expect(result.payee).toBe(PAYEE_CLAIM);
  });

  test("rejects an expected destination mismatch before transfer", async () => {
    await expect(
      settleWith({ network: "demos" })(
        req({ expectedPayee: OTHER_HEX }),
      ),
    ).rejects.toThrow(/destination mismatch/);
    expect(sent()).toBeUndefined();
  });

  test("a configured recipient that is NOT the agreement payee ABORTS — and performs NO transfer", async () => {
    await expect(
      settleWith({ recipient: OTHER_HEX, network: "demos" })(req()),
    ).rejects.toThrow(/destination mismatch|PB-2/);
    // The money-safety assertion: nothing was sent.
    expect(sent()).toBeUndefined();
  });

  test("a payee that does not intrinsically resolve to an address is rejected with NO transfer", async () => {
    await expect(
      settleWith({ network: "demos" })(req({ payee: "did:example:alias-only" })),
    ).rejects.toThrow(/does not intrinsically resolve/);
    expect(sent()).toBeUndefined();
  });

  test("STRICT: a non-Demos scheme ending in 64 hex is NOT Demos-bound → no transfer (#32)", async () => {
    // did:ethr:…<64hex> ends in 64 hex but is a foreign scheme; must be rejected.
    await expect(
      settleWith({ network: "demos" })(req({ payee: `did:ethr:${SELLER_HEX}` })),
    ).rejects.toThrow(/does not intrinsically resolve/);
    expect(sent()).toBeUndefined();
    // A CCI cross-chain claim carrying an 0x address is likewise not intrinsically Demos.
    await expect(
      settleWith({ network: "demos" })(req({ payee: `cci-xm:evm:mainnet:0x${SELLER_HEX}` })),
    ).rejects.toThrow(/does not intrinsically resolve/);
    expect(sent()).toBeUndefined();
  });

  test("an equivalent claim form (0x / bare hex) matches the same address", async () => {
    await settleWith({ recipient: `0x${SELLER_HEX}` })(req());
    expect(sent()!.to).toBe(SELLER_HEX);
  });

  test("the DACS-1 Demos cci-xm profile resolves intrinsically", async () => {
    const claim = `cci-xm:demos:testnet:0x${SELLER_HEX}?region=uk`;
    await settleWith({ recipient: `0x${SELLER_HEX}` })(req({ payee: claim }));
    expect(sent()!.to).toBe(SELLER_HEX);
  });

  test("canonical Demos DID parameters do not change the settlement identity", async () => {
    const claim = `${PAYEE_CLAIM}?a=left%3Aright&unknown=value`;
    await settleWith({ recipient: `0x${SELLER_HEX}` })(
      req({ payee: claim }),
    );
    expect(sent()!.to).toBe(SELLER_HEX);
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
    `DID:demos:agent:${SELLER_HEX}`,
    `did:demos:agent:${SELLER_HEX}?z=last&a=first`,
    `did:demos:agent:${SELLER_HEX}?a=left%3aright`,
    ` ${PAYEE_CLAIM}`,
    `${PAYEE_CLAIM} `,
  ])("rejects a malformed or foreign cci-xm Demos lookalike: %s", async (payee) => {
    await expect(
      settleWith({ network: "demos" })(req({ payee })),
    ).rejects.toThrow(/does not intrinsically resolve/);
    expect(sent()).toBeUndefined();
  });
});
