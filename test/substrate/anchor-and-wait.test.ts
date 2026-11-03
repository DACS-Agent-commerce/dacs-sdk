import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AnchorWaitError,
  DemosAdapter,
  createInMemoryDemosWriteJournal,
  demosSignedTransactionProofHash,
  demosWriteEvidenceToAnchorReceipt,
  type AnchorAttemptReceipt,
  type DemosWriteJournalRecord,
} from "../../src/substrate/index.js";
import {
  canonicalize,
  contentHash,
  logicalToStorageProgramName,
  sha256Hex,
} from "../../src/canonical/index.js";
import { DacsError, SubstrateError } from "../../src/errors.js";

const WALLET = `0x${"ab".repeat(32)}`;
let fixtureId = 0;
const writeJournal = createInMemoryDemosWriteJournal();

/** The rejection of a verification that must not resolve. */
async function refusal(verdict: Promise<boolean>): Promise<unknown> {
  return verdict.then(
    (value) => { throw new Error(`verification resolved ${String(value)}`); },
    (reason: unknown) => reason,
  );
}

/**
 * SR2-5: a proof whose signed transaction does not bind its claimed write is
 * invalid outright (a permanent DacsError), never indeterminate.
 */
function expectBindingRefusal(error: unknown): void {
  expect(error).toBeInstanceOf(DacsError);
  expect(error).not.toBeInstanceOf(SubstrateError);
  expect((error as DacsError).message)
    .toBe("Demos signed transaction does not bind its native write");
}

function notFound(): Error {
  return Object.assign(new Error("not found"), { response: { status: 404 } });
}

function rpcFailure(): Error {
  return Object.assign(new Error("service unavailable"), {
    response: { status: 503 },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function signedStorageTransaction(
  wallet: string,
  hash: string,
  payload: Record<string, unknown>,
  nonce: number,
) {
  return {
    hash,
    content: {
      type: "storageProgram",
      from: wallet,
      to: payload.storageAddress,
      nonce,
      data: ["storageProgram", payload],
    },
  };
}

function pendingNativeTransfer(
  generation: number,
  payer: string,
  payee: string,
  txRef: string,
  nonce: number,
): DemosWriteJournalRecord {
  return {
    writeId: `pay-dem-${txRef}`,
    generation,
    kind: "native-transfer",
    operation: "transfer",
    stage: "broadcast-intent",
    logicalName: "pay-dem:pay-dem:job:0",
    programName: "native-dem-transfer",
    owner: payer,
    nativeAddress: payee,
    valueHash: "34".repeat(32),
    nonce,
    txRef,
    transfer: {
      payer,
      payee,
      amountOs: "1000000000",
      denomination: "os",
      network: "demos",
      maxTotalDebitOs: "2000000000",
      settlementKey: "pay-dem:job:0",
    },
    updatedAt: Date.now(),
  };
}

function pendingAnchorWrite(
  generation: number,
  wallet: string,
  txRef: string,
  nonce: number,
  logicalName: string,
  nativeAddress: string,
  data: Record<string, unknown>,
): { record: DemosWriteJournalRecord; payload: Record<string, unknown> } {
  const programName = logicalToStorageProgramName(logicalName);
  const payload = {
    operation: "CREATE_STORAGE_PROGRAM",
    programName,
    storageAddress: nativeAddress,
    encoding: "json",
    data,
  };
  const signed = signedStorageTransaction(wallet, txRef, payload, nonce);
  const signedTransaction = canonicalize(signed);
  return {
    payload,
    record: {
      writeId: `write-${txRef}`,
      generation,
      kind: "mutable",
      operation: "create",
      stage: "broadcast-intent",
      logicalName,
      programName,
      owner: wallet,
      nativeAddress,
      valueHash: sha256Hex(canonicalize(data)),
      nonce,
      txRef,
      signedTransaction,
      signedTransactionHash: demosSignedTransactionProofHash(signed),
      updatedAt: Date.now(),
    },
  };
}

async function makeAdapter(options?: {
  rpc?: string;
  wallet?: string;
  maximumFeeOs?: bigint;
}) {
  fixtureId += 1;
  const id = fixtureId;
  const rpc = options?.rpc ?? `https://node-${id}.test`;
  const wallet =
    options?.wallet ??
    `${WALLET.slice(0, -4)}${id.toString(16).padStart(4, "0")}`;
  const adapter = new DemosAdapter({
    rpc,
    chainIdentity: "test-chain",
    writeJournal,
    ...(options?.maximumFeeOs === undefined
      ? {} : { maximumFeeOs: options.maximumFeeOs }),
  });
  const raw = adapter.raw as any;
  let signedCount = 0;
  const signedPayloads = new Map<
    string,
    { payload: Record<string, unknown>; nonce?: number }
  >();

  raw.connect = vi.fn().mockResolvedValue(undefined);
  raw.getAddress = vi.fn(() => wallet);
  vi.spyOn(adapter, "resolveAnchorByName").mockResolvedValue({
    status: "absent",
  });
  raw.getAddressNonce = vi.fn(async () => signedCount);
  raw.getTransactionHistory = vi.fn(async () => { throw rpcFailure(); });
  (adapter as any).resolveAnchorByIndex = vi.fn(async () => ({ status: "absent" }));
  raw.storagePrograms.read = vi.fn(async (address: string) => {
    const entry = [...signedPayloads.entries()]
      .reverse()
      .find(([, item]) => item.payload.storageAddress === address);
    if (!entry) throw notFound();
    const [txRef, { payload }] = entry;
    return {
      success: true,
      storageAddress: address,
      owner: wallet,
      programName: payload.programName,
      data: payload.data,
      metadata: payload.metadata,
      createdByTx: txRef,
      lastModifiedByTx: txRef,
      interactionTxs: [txRef],
    };
  });
  raw.storagePrograms.sign = vi.fn(
    async (payload: Record<string, unknown>, options?: { nonce?: number }) => {
      const nonce =
        options?.nonce ?? (await raw.getAddressNonce(wallet)) + 1;
      signedCount += 1;
      const hash = `tx-${id}-${signedCount}`;
      signedPayloads.set(hash, { payload, nonce });
      return signedStorageTransaction(wallet, hash, payload, nonce);
    },
  );
  raw.tx.confirm = vi.fn(async (signed: { hash: string }) => ({
    response: { data: { transaction: { hash: signed.hash } } },
  }));
  raw.tx.broadcast = vi.fn(async (validity: any) => ({
    result: 200,
    response: { hash: validity.response.data.transaction.hash },
  }));
  raw.nodeCall = vi
    .fn()
    .mockResolvedValue({ state: "included", blockNumber: 42 });
  raw.getTxByHash = vi.fn(async (txRef: string) => {
    const signed = signedPayloads.get(txRef);
    return {
      hash: txRef,
      status: "confirmed",
      blockNumber: 42,
      ...(signed?.nonce === undefined
        ? {}
        : {
            content: {
              type: "storageProgram",
              from: wallet,
              to: signed.payload.storageAddress,
              nonce: signed.nonce,
              data: ["storageProgram", signed.payload],
            },
          }),
    };
  });
  raw.getLastBlockNumber = vi.fn(async () => 42);
  raw.getBlockByNumber = vi.fn(async (blockNumber: number) => ({
    number: blockNumber,
    hash: `block-${blockNumber}`,
    status: "confirmed",
    content: {
      timestamp: 120,
      ordered_transactions: [...new Set([
        ...(blockNumber === 42 ? [...signedPayloads.keys()] : []),
        ...(raw.testHistoryRows ?? []).filter((row: any) => row.blockNumber === blockNumber)
          .map((row: any) => row.hash).reverse(),
        ...((adapter as unknown as { activeWriteRecord?: { txRef?: string } })
          .activeWriteRecord?.txRef ? [(adapter as any).activeWriteRecord.txRef] : []),
      ])],
    },
    validation_data: { signatures: ["validator-test-signature"] },
  }));
  await adapter.connect();

  return {
    adapter,
    raw,
    rpc,
    wallet,
    recordSignedPayload: (
      txRef: string,
      payload: Record<string, unknown>,
      nonce?: number,
    ) => signedPayloads.set(txRef, { payload, nonce }),
  };
}

/** History is newest first; the fake block independently exposes execution order. */
function serveStorageHistory(raw: any, rows: any[]): void {
  raw.testHistoryRows = rows;
  raw.getTransactionHistory = vi.fn(async (
    address: string, _type: string, options: { start: number; limit: number },
  ) => rows.filter((row) => row.content.to === address)
    .slice(options.start, options.start + options.limit));
}

function asAnchorError(error: unknown): AnchorWaitError {
  expect(error).toBeInstanceOf(AnchorWaitError);
  return error as AnchorWaitError;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DemosAdapter.anchorAndWait", () => {
  it("refuses an over-ceiling mutable anchor fee before broadcast", async () => {
    const { adapter, raw } = await makeAdapter({ maximumFeeOs: 2n });
    raw.getNetworkInfo = vi.fn(async () => ({
      forks: { osDenomination: { activated: true } },
    }));
    raw.tx.confirm.mockImplementation(async (signed: { hash: string }) => ({
      response: {
        data: {
          transaction: { hash: signed.hash },
          gas_operation: {
            fees: {
              network_fee: "3",
              rpc_fee: "0",
              additional_fee: "0",
            },
          },
        },
      },
    }));

    const error = await adapter.anchorAndWait(
      "mutable-over-fee-ceiling",
      { value: 1 },
      { completion: "included", timeoutMs: 1_000, pollMs: 1 },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AnchorWaitError);
    expect((error as Error & { cause?: unknown }).cause).toMatchObject({
      message: expect.stringMatching(/exceeds maximumFeeOs/),
    });
    expect(raw.tx.broadcast).not.toHaveBeenCalled();
  });

  it("authenticates a pending native transfer and advances the next anchor nonce", async () => {
    const { adapter, raw, wallet } = await makeAdapter();
    const payer = wallet.replace(/^0x/, "").toLowerCase();
    const payee = "cd".repeat(32);
    const txRef = "12".repeat(32);
    const lease = await writeJournal.acquire({
      chainIdentity: "test-chain",
      wallet: wallet.toLowerCase(),
    });
    await lease.put(pendingNativeTransfer(
      lease.generation,
      payer,
      payee,
      txRef,
      9,
    ));
    raw.nodeCall.mockResolvedValue({ state: "included", blockNumber: 44 });
    raw.getTxByHash.mockResolvedValue({
      hash: txRef,
      status: "confirmed",
      blockNumber: 44,
      content: {
        type: "native",
        from: payer,
        from_ed25519_address: `0x${payer}`,
        to: payee,
        nonce: 9,
        amount: "1000000000",
        data: [
          "native",
          { nativeOperation: "send", args: [payee, "1000000000"] },
        ],
      },
    });
    raw.getBlockByNumber.mockResolvedValue({
      number: 44,
      hash: "block-44",
      status: "confirmed",
      content: { timestamp: 120, ordered_transactions: [txRef] },
      validation_data: { signatures: ["validator-test-signature"] },
    });
    raw.getAddressNonce.mockResolvedValue(9);

    await adapter.reconcileNativeTransferJournal(lease, 1_000);
    expect(lease.snapshot.records).toMatchObject([
      {
        txRef,
        stage: "canonical-confirmed",
        blockNumber: 44,
        blockHash: "block-44",
        finalityProofHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    await lease.release();

    raw.getAddressNonce.mockResolvedValue(0);
    raw.nodeCall.mockResolvedValue({ state: "failed" });
    await adapter.anchorAndWait(
      "after-native-transfer",
      { value: 1 },
      { completion: "included", timeoutMs: 1_000, pollMs: 1 },
    ).catch(() => undefined);
    expect(raw.storagePrograms.sign).toHaveBeenCalledWith(
      expect.anything(),
      { nonce: 10 },
    );
  });

  it("authenticates a pending anchor before a native transfer can reuse its nonce", async () => {
    const { adapter, raw, wallet, recordSignedPayload } = await makeAdapter();
    const txRef = "78".repeat(32);
    const logicalName = "dacs4:payment-evidence:nonce-fence";
    const nativeAddress = "storage:pending-anchor";
    const data = { evidenceVersion: "1", value: "pending" };
    const lease = await writeJournal.acquire({
      chainIdentity: "test-chain",
      wallet: wallet.toLowerCase(),
    });
    const pending = pendingAnchorWrite(
      lease.generation,
      wallet,
      txRef,
      8,
      logicalName,
      nativeAddress,
      data,
    );
    await lease.put(pending.record);
    recordSignedPayload(txRef, pending.payload, 8);
    raw.nodeCall.mockResolvedValue({ state: "included", blockNumber: 46 });
    raw.getTxByHash.mockResolvedValue({
      ...signedStorageTransaction(wallet, txRef, pending.payload, 8),
      status: "confirmed",
      blockNumber: 46,
    });
    raw.getBlockByNumber.mockResolvedValue({
      number: 46,
      hash: "block-46",
      status: "confirmed",
      content: { timestamp: 120, ordered_transactions: [txRef] },
      validation_data: { signatures: ["validator-test-signature"] },
    });
    raw.getAddressNonce
      .mockResolvedValueOnce(7)
      .mockResolvedValue(8);

    await adapter.reconcileWalletJournal(lease, 1_000);

    expect(lease.snapshot.records).toMatchObject([{
      txRef,
      nonce: 8,
      stage: "native-visible",
      blockNumber: 46,
      blockHash: "block-46",
      nativeRead: {
        owner: wallet,
        programName: pending.record.programName,
        valueHash: pending.record.valueHash,
      },
    }]);
    expect(raw.getAddressNonce).toHaveBeenCalledTimes(2);
    await lease.release();
  });

  it("refuses to close a native transfer whose canonical amount changed", async () => {
    const { adapter, raw, wallet } = await makeAdapter();
    const payer = wallet.replace(/^0x/, "").toLowerCase();
    const payee = "cd".repeat(32);
    const txRef = "56".repeat(32);
    const lease = await writeJournal.acquire({
      chainIdentity: "test-chain",
      wallet: wallet.toLowerCase(),
    });
    await lease.put(pendingNativeTransfer(
      lease.generation,
      payer,
      payee,
      txRef,
      4,
    ));
    raw.nodeCall.mockResolvedValue({ state: "included", blockNumber: 45 });
    raw.getTxByHash.mockResolvedValue({
      hash: txRef,
      status: "confirmed",
      blockNumber: 45,
      content: {
        type: "native",
        from: payer,
        to: payee,
        nonce: 4,
        amount: "2",
        data: ["native", { nativeOperation: "send", args: [payee, "2"] }],
      },
    });
    raw.getBlockByNumber.mockResolvedValue({
      number: 45,
      hash: "block-45",
      status: "confirmed",
      content: { timestamp: 120, ordered_transactions: [txRef] },
      validation_data: { signatures: ["validator-test-signature"] },
    });
    await expect(adapter.reconcileNativeTransferJournal(lease, 1_000))
      .rejects.toMatchObject({ code: "inclusion-failed" });
    expect(lease.snapshot.records[0]?.stage).toBe("broadcast-intent");
    await lease.release();
  });

  it("binds a mutable create to the nonce used to derive its address", async () => {
    const { adapter, raw } = await makeAdapter();

    await expect(
      adapter.anchorAndWait(
        "nonce-bound",
        { value: 1 },
        { completion: "included", timeoutMs: 1_000, pollMs: 1 },
      ),
    ).resolves.toMatchObject({ state: "included" });

    expect(raw.storagePrograms.sign).toHaveBeenCalledWith(
      expect.anything(),
      { nonce: 1 },
    );
  });

  it("accepts canonical confirmed execution while the status index still lags", async () => {
    const { adapter, raw } = await makeAdapter();
    raw.nodeCall.mockResolvedValue({ state: "pending" });
    raw.getTxByHash.mockResolvedValue({
      status: "confirmed",
      blockNumber: 43,
    });

    await expect(
      adapter.anchorAndWait(
        "canonical-confirmed-before-index",
        { value: 1 },
        { completion: "included", timeoutMs: 1_000, pollMs: 1 },
      ),
    ).resolves.toMatchObject({
      state: "included",
      blockNumber: 43,
      attempts: { inclusionPolls: 1 },
    });
    expect(raw.nodeCall).toHaveBeenCalledTimes(1);
    expect(raw.getTxByHash).toHaveBeenCalledTimes(1);
  });

  it("accepts only the live node's equivalent integer wire projection", async () => {
    const { adapter, raw } = await makeAdapter();
    const sign = raw.storagePrograms.sign.getMockImplementation()!;
    raw.storagePrograms.sign.mockImplementation(async (...args: any[]) => {
      const signed = await sign(...args);
      Object.assign(signed.content, {
        nonce: 1,
        timestamp: 123,
        amount: "0",
        transaction_fee: {
          network_fee: "1000",
          rpc_fee: "1000",
          additional_fee: "0",
          rpc_address: null,
        },
        gcr_edits: [
          { type: "balance", amount: "1000", txhash: "" },
          { type: "nonce", amount: 1, txhash: "" },
        ],
      });
      return signed;
    });
    const canonical = raw.getTxByHash.getMockImplementation()!;
    raw.getTxByHash.mockImplementation(async (txRef: string) => {
      const transaction = await canonical(txRef);
      return {
        ...transaction,
        content: {
          ...transaction.content,
          nonce: "1",
          timestamp: "123",
          amount: 0,
          transaction_fee: {
            network_fee: 1000,
            rpc_fee: 1000,
            additional_fee: 0,
            rpc_address: null,
          },
          gcr_edits: [
            { type: "balance", amount: 1000, txhash: txRef },
            { type: "nonce", amount: "1", txhash: txRef },
          ],
        },
      };
    });

    await expect(
      adapter.anchorAndWait(
        "live-wire-integer-projection",
        { value: 1 },
        { completion: "included", timeoutMs: 1_000, pollMs: 1 },
      ),
    ).resolves.toMatchObject({ state: "included" });
  });

  it("refuses a mutable create signed with a different nonce", async () => {
    const { adapter, raw } = await makeAdapter();
    raw.storagePrograms.sign.mockResolvedValue({
      hash: "tx-wrong-nonce",
      content: { nonce: 2 },
    });

    const error = asAnchorError(
      await adapter
        .anchorAndWait(
          "wrong-nonce",
          { value: 1 },
          { completion: "included", timeoutMs: 1_000, pollMs: 1 },
        )
        .catch((caught: unknown) => caught),
    );

    expect(error).toMatchObject({
      code: "prepare-failed",
      receipt: { state: "not-broadcast" },
    });
    expect(error.message).toMatch(/used nonce 2; expected 1/);
    expect(raw.tx.broadcast).not.toHaveBeenCalled();
  });

  it("fails closed when an accepted response changes the signed transaction hash", async () => {
    const { adapter, raw } = await makeAdapter();
    raw.tx.broadcast.mockResolvedValue({
      result: 200,
      response: { hash: "tx-conflicting-response" },
    });

    const error = asAnchorError(
      await adapter.anchor("hash-bound", { value: 1 }).catch(
        (caught: unknown) => caught,
      ),
    );

    expect(error).toMatchObject({
      code: "broadcast-failed",
      receipt: { state: "broadcast-unknown" },
    });
    expect(error.receipt.txRef).toMatch(/^tx-/);
    expect(error.receipt.txRef).not.toBe("tx-conflicting-response");
    await vi.waitFor(() =>
      expect(raw.nodeCall).toHaveBeenCalledWith(
        "getTransactionStatus",
        expect.objectContaining({ hash: error.receipt.txRef }),
      ),
    );
  });

  it("refuses confirmation for a different transaction before broadcast", async () => {
    const { adapter, raw } = await makeAdapter();
    raw.tx.confirm.mockResolvedValue({
      response: { data: { transaction: { hash: "tx-confirmed-other" } } },
    });

    await expect(
      adapter.anchorAndWait(
        "confirmation-hash-bound",
        { value: 1 },
        { completion: "included", timeoutMs: 1_000, pollMs: 1 },
      ),
    ).rejects.toThrow(/confirmation returned transaction hash|confirmed anchor.*returned transaction hash/);
    expect(raw.tx.broadcast).not.toHaveBeenCalled();
  });

  it("rejects canonical transaction content that differs from the signed write", async () => {
    const { adapter, raw } = await makeAdapter();
    const canonical = raw.getTxByHash.getMockImplementation()!;
    raw.getTxByHash.mockImplementation(async (txRef: string) => {
      const transaction = await canonical(txRef);
      return {
        ...transaction,
        content: {
          ...transaction.content,
          to: "stor-attacker",
        },
      };
    });

    await expect(
      adapter.anchorAndWait(
        "canonical-content-bound",
        { value: 1 },
        { completion: "included", timeoutMs: 1_000, pollMs: 1 },
      ),
    ).rejects.toThrow(/changed its signed content/);
  });

  it("rejects invalid completion and timing options before any write", async () => {
    const { adapter, raw } = await makeAdapter();

    await expect(
      adapter.anchorAndWait("bad-timeout", {}, { timeoutMs: 0 }),
    ).rejects.toThrow(/timeoutMs/);
    await expect(
      adapter.anchorAndWait("bad-poll", {}, { pollMs: Number.NaN }),
    ).rejects.toThrow(/pollMs/);
    await expect(
      adapter.anchorAndWait(
        "bad-completion",
        {},
        {
          // @ts-expect-error runtime guard for JS callers
          completion: "finalized",
        },
      ),
    ).rejects.toThrow(/completion/);
    expect(raw.storagePrograms.sign).not.toHaveBeenCalled();
  });

  it("does not turn an indeterminate owner-bound lookup into a create", async () => {
    const { adapter, raw } = await makeAdapter();
    vi.mocked(adapter.resolveAnchorByName).mockResolvedValue({
      status: "indeterminate",
      reason: "HTTP 503",
    });

    const error = await adapter
      .anchorAndWait(
        "probe",
        { value: 1 },
        { completion: "included", pollMs: 1 },
      )
      .catch((caught: unknown) => caught);

    const anchorError = asAnchorError(error);
    expect(anchorError.code).toBe("read-failed");
    expect(anchorError.receipt).toMatchObject({
      state: "not-broadcast",
      name: "probe",
    });
    expect(anchorError.receipt.address).toBeUndefined();
    expect(raw.storagePrograms.sign).not.toHaveBeenCalled();
    expect(raw.tx.broadcast).not.toHaveBeenCalled();
  });

  it("refuses to broadcast a transaction that cannot be hash-reconciled", async () => {
    const { adapter, raw } = await makeAdapter();
    raw.storagePrograms.sign.mockResolvedValue({ content: { nonce: 1 } });
    raw.tx.confirm.mockResolvedValue({
      response: { data: { transaction: {} } },
    });

    const error = asAnchorError(
      await adapter
        .anchorAndWait(
          "missing-hash",
          { value: 1 },
          { completion: "included", timeoutMs: 1_000, pollMs: 1 },
        )
        .catch((caught: unknown) => caught),
    );
    expect(error).toMatchObject({
      code: "prepare-failed",
      receipt: { state: "not-broadcast" },
    });
    expect(error.receipt.txRef).toBeUndefined();
    expect(raw.tx.broadcast).not.toHaveBeenCalled();
  });

  it("keeps ordinary 404 and NOT_FOUND reads indeterminate and permits retry", async () => {
    const { adapter, raw } = await makeAdapter();

    await expect(adapter.readAnchor("missing")).rejects.toBeInstanceOf(SubstrateError);
    raw.storagePrograms.read.mockResolvedValueOnce({ success: false, errorCode: "NOT_FOUND" });
    await expect(adapter.readAnchor("missing")).rejects.toBeInstanceOf(SubstrateError);
    raw.storagePrograms.read.mockResolvedValueOnce({ success: true, data: { recovered: true } });
    await expect(adapter.readAnchor("missing")).resolves.toEqual({ recovered: true });
    raw.storagePrograms.read.mockRejectedValue(rpcFailure());
    await expect(adapter.readAnchor("uncertain")).rejects.toThrow(
      /read anchor uncertain failed/,
    );
  });

  it("waits through stale content and returns exact-canonical progress evidence", async () => {
    const { adapter, raw } = await makeAdapter();
    const expected = {
      payload: "same",
      signatures: [{ signer: "seller", value: "new" }],
    };
    const stale = {
      payload: "same",
      signatures: [{ signer: "seller", value: "old" }],
    };
    raw.storagePrograms.read
      .mockResolvedValueOnce({ success: true, data: stale })
      .mockRejectedValueOnce(rpcFailure())
      .mockResolvedValueOnce({ success: true, data: expected });
    const progress: AnchorAttemptReceipt[] = [];

    const receipt = await adapter.anchorAndWait("visible", expected, {
      completion: "read-visible",
      pollMs: 1,
      onProgress: (event) => progress.push(event),
    });

    expect(receipt).toMatchObject({
      name: "visible",
      state: "read-visible",
      completion: "read-visible",
      blockNumber: 42,
      attempts: { inclusionPolls: 1, visibilityReads: 3 },
    });
    expect(receipt.address).toMatch(/^stor-[0-9a-f]{40}$/);
    expect(receipt.txRef).toMatch(/^tx-/);
    expect(receipt.timings.acceptedAt).toBeTypeOf("number");
    expect(receipt.timings.includedAt).toBeTypeOf("number");
    expect(receipt.timings.readVisibleAt).toBeTypeOf("number");
    expect(progress.map((event) => event.state)).toEqual(
      expect.arrayContaining([
        "broadcast-unknown",
        "accepted",
        "included",
        "read-visible",
      ]),
    );
    expect(raw.tx.broadcast).toHaveBeenCalledTimes(1);
  });

  it("holds the nonce queue until authenticated native readback", async () => {
    const { adapter, raw, wallet } = await makeAdapter();
    const firstValue = { value: "first" };
    const secondValue = { value: "second" };
    const firstAddress = await adapter.anchorAddress("first");
    const secondAddress = await adapter.anchorAddress("second");
    let firstVisible = false;

    raw.storagePrograms.read.mockImplementation(async (address: string) => {
      if (address === firstAddress) {
        return {
          success: true,
          storageAddress: firstAddress,
          owner: wallet,
          programName: "first",
          data: firstVisible ? firstValue : { value: "stale" },
        };
      }
      if (address === secondAddress) {
        return {
          success: true,
          storageAddress: secondAddress,
          owner: wallet,
          programName: "second",
          data: secondValue,
        };
      }
      throw new Error(`unexpected address ${address}`);
    });

    const first = adapter.anchorAndWait("first", firstValue, {
      completion: "read-visible",
      timeoutMs: 1_000,
      pollMs: 1,
    });
    await vi.waitFor(() => {
      expect(raw.storagePrograms.read).toHaveBeenCalledWith(firstAddress);
      expect(raw.nodeCall).toHaveBeenCalled();
    });

    const second = adapter.anchorAndWait("second", secondValue, {
      completion: "included",
      timeoutMs: 1_000,
      pollMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(raw.storagePrograms.sign).toHaveBeenCalledTimes(1);

    firstVisible = true;
    await expect(first).resolves.toMatchObject({ state: "read-visible" });
    await expect(second).resolves.toMatchObject({ state: "included" });
    expect(raw.tx.broadcast).toHaveBeenCalledTimes(2);
  });

  it("continues from canonical confirmed nonce while the account index lags", async () => {
    fixtureId += 1;
    const rpc = `https://nonce-lag-${fixtureId}.test`;
    const wallet = `${WALLET.slice(0, -4)}${fixtureId
      .toString(16)
      .padStart(4, "0")}`;
    const first = await makeAdapter({ rpc, wallet });
    const second = await makeAdapter({ rpc, wallet });
    let accountNonce = 0;
    const signedNonces: number[] = [];

    for (const fixture of [first, second]) {
      fixture.raw.getAddressNonce.mockImplementation(async () => accountNonce);
      fixture.raw.storagePrograms.sign.mockImplementation(
        async (payload: Record<string, unknown>, options?: { nonce?: number }) => {
          const nonce =
            options?.nonce ??
            (await fixture.raw.getAddressNonce(wallet)) + 1;
          signedNonces.push(nonce);
          const hash = `tx-nonce-lag-${signedNonces.length}`;
          fixture.recordSignedPayload(hash, payload, nonce);
          return signedStorageTransaction(wallet, hash, payload, nonce);
        },
      );
    }

    await expect(
      first.adapter.anchorAndWait(
        "one",
        { value: 1 },
        { completion: "included", timeoutMs: 1_000, pollMs: 1 },
      ),
    ).resolves.toMatchObject({ state: "included" });

    const queued = second.adapter.anchorAndWait(
      "two",
      { value: 2 },
      { completion: "included", timeoutMs: 1_000, pollMs: 1 },
    );
    await expect(queued).resolves.toMatchObject({ state: "included" });
    expect(signedNonces).toEqual([1, 2]);
    accountNonce = 2;
  });

  it("updates the durable native slot when the name index is unavailable", async () => {
    fixtureId += 1;
    const wallet = `${WALLET.slice(0, -4)}${fixtureId
      .toString(16)
      .padStart(4, "0")}`;
    const first = await makeAdapter({
      rpc: `https://binding-first-${fixtureId}.test`,
      wallet,
    });
    const restarted = await makeAdapter({
      rpc: `https://binding-restarted-${fixtureId}.test`,
      wallet,
    });
    const name = "durable-mutable-binding";
    const initial = await first.adapter.anchorAndWait(
      name,
      { value: 1 },
      { completion: "read-visible", timeoutMs: 1_000, pollMs: 1 },
    );
    restarted.raw.storagePrograms.read.mockResolvedValue({
      success: true,
      storageAddress: initial.address,
      owner: wallet,
      programName: name,
      data: { value: 2 },
    });
    vi.mocked(restarted.adapter.resolveAnchorByName).mockResolvedValue({
      status: "indeterminate",
      reason: "secondary index unavailable",
    });

    const updated = await restarted.adapter.anchorAndWait(
      name,
      { value: 2 },
      { completion: "read-visible", timeoutMs: 1_000, pollMs: 1 },
    );
    expect(updated.address).toBe(initial.address);
    expect(restarted.raw.storagePrograms.sign).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "WRITE_STORAGE",
        storageAddress: initial.address,
      }),
      { nonce: 2 },
    );

    const conflicting = await makeAdapter({
      rpc: `https://binding-conflict-${fixtureId}.test`,
      wallet,
    });
    vi.mocked(conflicting.adapter.resolveAnchorByName).mockResolvedValue({
      status: "present",
      address: "different-native-address",
    });
    const conflict = await conflicting.adapter.anchorAndWait(
      name,
      { value: 3 },
      { completion: "included", timeoutMs: 1_000, pollMs: 1 },
    ).catch((error: unknown) => error) as Error & { cause?: Error };
    expect(conflict.message).toMatch(/anchor lookup failed/);
    expect(conflict.cause?.message).toMatch(
      /index conflicts with its durable native binding/,
    );
    expect(conflicting.raw.storagePrograms.sign).not.toHaveBeenCalled();
  });

  it("does not release the wallet lane from secondary included status alone", async () => {
    fixtureId += 1;
    const rpc = `https://secondary-included-${fixtureId}.test`;
    const wallet = `${WALLET.slice(0, -4)}${fixtureId
      .toString(16)
      .padStart(4, "0")}`;
    const first = await makeAdapter({ rpc, wallet });
    const second = await makeAdapter({ rpc, wallet });
    let canonicalConfirmed = false;

    for (const fixture of [first, second]) {
      fixture.raw.getAddressNonce.mockResolvedValue(0);
    }
    first.raw.nodeCall.mockResolvedValue({
      state: "included",
      blockNumber: 9,
    });
    first.raw.getTxByHash.mockImplementation(async () =>
      canonicalConfirmed
        ? { status: "confirmed", blockNumber: 9 }
        : { status: "pending", blockNumber: null },
    );

    const timedOut = asAnchorError(
      await first.adapter
        .anchorAndWait(
          "secondary-included",
          { value: 1 },
          { completion: "included", timeoutMs: 20, pollMs: 1 },
        )
        .catch((caught: unknown) => caught),
    );
    expect(timedOut).toMatchObject({
      code: "timeout",
      receipt: {
        state: "included",
        lastObservedState: "included-execution-pending",
      },
    });

    const queued = second.adapter.anchorAndWait(
      "after-secondary-included",
      { value: 2 },
      { completion: "included", timeoutMs: 1_000, pollMs: 1 },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(second.raw.storagePrograms.sign).not.toHaveBeenCalled();

    canonicalConfirmed = true;
    await expect(queued).resolves.toMatchObject({ state: "included" });
    expect(second.raw.storagePrograms.sign).toHaveBeenCalledWith(
      expect.anything(),
      { nonce: 2 },
    );
  });

  it("coordinates accepted writes across adapter instances sharing a wallet", async () => {
    fixtureId += 1;
    const rpc = `https://shared-${fixtureId}.test`;
    const wallet = `${WALLET.slice(0, -4)}${fixtureId
      .toString(16)
      .padStart(4, "0")}`;
    const first = await makeAdapter({ rpc, wallet });
    const second = await makeAdapter({ rpc, wallet });
    let firstIncluded = false;
    first.raw.nodeCall.mockImplementation(async () =>
      firstIncluded
        ? { state: "included", blockNumber: 1 }
        : { state: "pending" },
    );
    first.raw.getTxByHash.mockImplementation(async () =>
      firstIncluded
        ? { status: "confirmed", blockNumber: 1 }
        : { status: "pending", blockNumber: null },
    );

    await expect(
      first.adapter.anchorAndWait(
        "one",
        { value: 1 },
        { completion: "accepted", timeoutMs: 1_000, pollMs: 1 },
      ),
    ).resolves.toMatchObject({ state: "accepted" });

    const queued = second.adapter.anchorAndWait(
      "two",
      { value: 2 },
      { completion: "included", timeoutMs: 1_000, pollMs: 1 },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(second.raw.storagePrograms.sign).not.toHaveBeenCalled();

    firstIncluded = true;
    await expect(queued).resolves.toMatchObject({ state: "included" });
    expect(second.raw.storagePrograms.sign).toHaveBeenCalledTimes(1);
  });

  it("coordinates equivalent spellings of the same RPC endpoint", async () => {
    fixtureId += 1;
    const endpointId = fixtureId;
    const wallet = `${WALLET.slice(0, -4)}${fixtureId
      .toString(16)
      .padStart(4, "0")}`;
    const first = await makeAdapter({
      rpc: `HTTPS://EQUIVALENT-${endpointId}.TEST:443/`,
      wallet,
    });
    const second = await makeAdapter({
      rpc: `https://equivalent-${endpointId}.test`,
      wallet,
    });
    let firstIncluded = false;
    first.raw.nodeCall.mockImplementation(async () =>
      firstIncluded ? { state: "included" } : { state: "pending" },
    );
    first.raw.getTxByHash.mockImplementation(async () =>
      firstIncluded
        ? { status: "confirmed", blockNumber: 1 }
        : { status: "pending", blockNumber: null },
    );

    await first.adapter.anchorAndWait(
      "one",
      { value: 1 },
      { completion: "accepted", timeoutMs: 1_000, pollMs: 1 },
    );
    const queued = second.adapter.anchorAndWait(
      "two",
      { value: 2 },
      { completion: "included", timeoutMs: 1_000, pollMs: 1 },
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(second.raw.storagePrograms.sign).not.toHaveBeenCalled();
    firstIncluded = true;
    await expect(queued).resolves.toMatchObject({ state: "included" });
  });

  it("coordinates distinct RPC endpoints for the same chain and wallet", async () => {
    fixtureId += 1;
    const wallet = `${WALLET.slice(0, -4)}${fixtureId
      .toString(16)
      .padStart(4, "0")}`;
    const first = await makeAdapter({
      rpc: `https://primary-${fixtureId}.test`,
      wallet,
    });
    const second = await makeAdapter({
      rpc: `https://secondary-${fixtureId}.test`,
      wallet,
    });
    let firstConfirmed = false;
    first.raw.nodeCall.mockResolvedValue({ state: "included" });
    first.raw.getTxByHash.mockImplementation(async () =>
      firstConfirmed
        ? { status: "confirmed", blockNumber: 5 }
        : { status: "pending", blockNumber: null },
    );

    await first.adapter.anchorAndWait(
      "primary-write",
      { value: 1 },
      { completion: "accepted", timeoutMs: 1_000, pollMs: 1 },
    );
    const queued = second.adapter.anchorAndWait(
      "secondary-write",
      { value: 2 },
      { completion: "included", timeoutMs: 1_000, pollMs: 1 },
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(second.raw.storagePrograms.sign).not.toHaveBeenCalled();
    firstConfirmed = true;
    await expect(queued).resolves.toMatchObject({ state: "included" });
    expect(second.raw.storagePrograms.sign).toHaveBeenCalledTimes(1);
  });

  it("keeps anchorWriteOnce and anchorAndWait serialized through nonce advancement", async () => {
    fixtureId += 1;
    const rpc = `https://cross-surface-${fixtureId}.test`;
    const wallet = `${WALLET.slice(0, -4)}${fixtureId
      .toString(16)
      .padStart(4, "0")}`;
    const immutable = await makeAdapter({ rpc, wallet });
    const mutable = await makeAdapter({ rpc, wallet });
    const name = "immutable";
    const value = { value: 1 };
    const address = await immutable.adapter.anchorAddress(name);
    let accountNonce = 0;
    const signedNonces: number[] = [];

    for (const fixture of [immutable, mutable]) {
      fixture.raw.getAddressNonce.mockImplementation(async () => accountNonce);
      fixture.raw.storagePrograms.sign.mockImplementation(
        async (payload: Record<string, unknown>, options?: { nonce?: number }) => {
          const nonce =
            options?.nonce ??
            (await fixture.raw.getAddressNonce(wallet)) + 1;
          signedNonces.push(nonce);
          const hash = `tx-cross-surface-${signedNonces.length}`;
          fixture.recordSignedPayload(hash, payload, nonce);
          return signedStorageTransaction(wallet, hash, payload, nonce);
        },
      );
    }
    vi.mocked(immutable.adapter.resolveAnchorByName)
      .mockResolvedValueOnce({ status: "absent" })
      .mockResolvedValueOnce({ status: "present", address });
    immutable.raw.storagePrograms.read.mockResolvedValue({
      success: true,
      storageAddress: address,
      owner: wallet,
      programName: name,
      data: value,
      createdByTx: "tx-cross-surface-1",
      interactionTxs: ["tx-cross-surface-1"],
    });
    immutable.raw.broadcastAndWait = vi.fn(async () => ({
      broadcast: { response: { hash: "tx-cross-surface-1" } },
      status: { state: "included" },
    }));

    await expect(
      immutable.adapter.anchorWriteOnce(name, value, {
        timeoutMs: 1_000,
        pollMs: 1,
      }),
    ).resolves.toMatchObject({ address });

    const queued = mutable.adapter.anchorAndWait(
      "mutable",
      { value: 2 },
      { completion: "included", timeoutMs: 1_000, pollMs: 1 },
    );
    await expect(queued).resolves.toMatchObject({ state: "included" });
    expect(signedNonces).toEqual([1, 2]);
    accountNonce = 2;
  });

  it("binds an immutable create to the nonce used to derive its address", async () => {
    const { adapter, raw, wallet } = await makeAdapter();
    const name = "immutable-nonce-bound";
    const value = { value: 1 };
    const address = await adapter.anchorAddress(name);
    vi.mocked(adapter.resolveAnchorByName)
      .mockResolvedValueOnce({ status: "absent" })
      .mockResolvedValue({ status: "present", address });
    raw.storagePrograms.read.mockResolvedValue({
      success: true,
      storageAddress: address,
      owner: wallet,
      programName: name,
      data: value,
    });

    const anchored = await adapter.anchorWriteOnce(name, value, {
      timeoutMs: 1_000,
      pollMs: 1,
    });
    expect(anchored).toMatchObject({
      address,
      txRef: expect.stringMatching(/^tx-/),
      demosEvidence: {
        transactionRef: expect.stringMatching(/^tx-/),
        nativeAddress: address,
        operation: "create",
        nonce: 1,
      },
    });
    const portableReceipt = demosWriteEvidenceToAnchorReceipt({
      logicalAddress: name,
      contentHash: contentHash(value),
      writer: `did:demos:agent:${wallet.replace(/^0x/, "")}`,
      evidence: anchored.demosEvidence!,
    });
    // This read has node2's shape: no createdByTx/lastModifiedByTx/
    // interactionTxs. Nothing binds it to this write until the owner's
    // history does, so both verifiers stay indeterminate (DEMOS-MAPPING §A.2).
    await expect(
      adapter.verifyDemosWriteEvidence(anchored.demosEvidence!),
    ).rejects.toBeInstanceOf(SubstrateError);
    await expect(
      adapter.verifyDemosAnchorReceipt(portableReceipt),
    ).rejects.toBeInstanceOf(SubstrateError);
    const historyTransaction = await raw.getTxByHash(anchored.txRef);
    serveStorageHistory(raw, [historyTransaction]);
    await expect(
      adapter.verifyDemosWriteEvidence(anchored.demosEvidence!),
    ).resolves.toBe(true);
    await expect(
      adapter.verifyDemosAnchorReceipt(portableReceipt),
    ).resolves.toBe(true);
    // History that attributes the value to another create contradicts the proof.
    serveStorageHistory(raw, [{ ...historyTransaction, hash: "tx-other-create" }]);
    await expect(
      adapter.verifyDemosWriteEvidence(anchored.demosEvidence!),
    ).resolves.toBe(false);
    await expect(
      adapter.verifyDemosAnchorReceipt(portableReceipt),
    ).resolves.toBe(false);
    raw.storagePrograms.read.mockResolvedValue({
      success: true,
      storageAddress: address,
      owner: wallet,
      programName: name,
      data: value,
      createdByTx: anchored.txRef,
      lastModifiedByTx: anchored.txRef,
      interactionTxs: [anchored.txRef],
    });
    await expect(adapter.resolveDemosAnchorReceipt({
      logicalAddress: name,
      nativeAddress: anchored.address,
      contentHash: contentHash(value),
      writer: `did:demos:agent:${wallet.replace(/^0x/, "")}`,
    })).resolves.toMatchObject({
      logicalAddress: name,
      nativeAddress: anchored.address,
      transactionRef: { value: anchored.txRef },
      state: "finalized",
      observationDisposition: "established",
    });
    raw.storagePrograms.read.mockResolvedValue({
      success: true,
      storageAddress: address,
      owner: wallet,
      programName: name,
      data: value,
    });
    serveStorageHistory(raw, [historyTransaction]);
    await expect(adapter.resolveDemosAnchorReceipt({
      logicalAddress: name,
      nativeAddress: anchored.address,
      contentHash: contentHash(value),
      writer: `did:demos:agent:${wallet.replace(/^0x/, "")}`,
    })).resolves.toMatchObject({
      logicalAddress: name,
      nativeAddress: anchored.address,
      transactionRef: { value: anchored.txRef },
      state: "finalized",
    });
    expect(raw.getTransactionHistory).toHaveBeenCalledWith(
      address,
      "storageProgram",
      { start: 0, limit: 100 },
    );
    raw.getTxByHash.mockClear();
    raw.storagePrograms.read.mockResolvedValue({
      success: true,
      storageAddress: address,
      owner: wallet,
      programName: name,
      data: value,
      createdByTx: anchored.txRef,
      lastModifiedByTx: "tx-untrusted-latest",
      interactionTxs: [anchored.txRef, "tx-untrusted-latest"],
    });
    await expect(adapter.resolveDemosAnchorReceipt({
      logicalAddress: name,
      nativeAddress: anchored.address,
      contentHash: contentHash(value),
      writer: `did:demos:agent:${wallet.replace(/^0x/, "")}`,
    })).rejects.toThrow(/provenance could not be authenticated/);
    expect(raw.getTxByHash).toHaveBeenCalledTimes(1);
    expect(raw.getTxByHash).toHaveBeenCalledWith("tx-untrusted-latest");
    await expect(
      adapter.verifyDemosAnchorReceipt({
        ...portableReceipt,
        blockRef: {
          ...portableReceipt.blockRef,
          id: "tampered-block",
        },
      }),
    ).resolves.toBe(false);
    await expect(
      adapter.verifyDemosWriteEvidence({
        ...anchored.demosEvidence!,
        blockHash: "tampered-block",
      }),
    ).resolves.toBe(false);

    expect(raw.storagePrograms.sign).toHaveBeenCalledWith(
      expect.anything(),
      { nonce: 1 },
    );
  });

  it("re-authenticates a metadata-bound normative content hash", async () => {
    const { adapter, wallet } = await makeAdapter();
    const name = "immutable-normative-hash";
    const value = { signedScope: { value: 1 }, signatures: ["sig"] };
    const envelopeHash = sha256Hex(canonicalize(value));
    const normativeHash = "56".repeat(32);
    const anchored = await adapter.anchorWriteOnce(name, value, {
      timeoutMs: 1_000,
      pollMs: 1,
      metadata: {
        logicalAddress: name,
        contentHash: normativeHash,
        envelopeHash,
      },
    });
    const receipt = demosWriteEvidenceToAnchorReceipt({
      logicalAddress: name,
      contentHash: normativeHash,
      writer: `did:demos:agent:${wallet.replace(/^0x/, "")}`,
      evidence: anchored.demosEvidence!,
    });

    await expect(adapter.verifyDemosAnchorReceipt(receipt)).resolves.toBe(true);
    await expect(adapter.verifyDemosAnchorReceipt({
      ...receipt,
      contentHash: "78".repeat(32),
    })).resolves.toBe(false);
  });

  async function anchoredProof() {
    const fixture = await makeAdapter();
    const name = "immutable-proof-read";
    const value = { value: 1 };
    const anchored = await fixture.adapter.anchorWriteOnce(name, value, {
      timeoutMs: 1_000,
      pollMs: 1,
    });
    const evidence = anchored.demosEvidence!;
    const receipt = demosWriteEvidenceToAnchorReceipt({
      logicalAddress: name,
      contentHash: contentHash(value),
      writer: `did:demos:agent:${fixture.wallet.replace(/^0x/, "")}`,
      evidence,
    });
    return { ...fixture, evidence, receipt };
  }

  // CORE §5.1 and DEMOS-MAPPING §A.2: a Demos not-found or a transport failure
  // is indeterminate, never an invalid receipt. The first six arrangements are
  // the exact shapes demosdk 4.0.16 surfaces for those conditions on
  // kynesyslabs/node ac8f45f (nodeCall not-found answers `response: "error"`;
  // a storage not-found is HTTP 404, which its Storage Program read throws).
  // The last is a resolved body that does not report success.
  const transportFailure = () => ({
    result: 500,
    response: new Error("socket hang up"),
    require_reply: false,
    extra: null,
  });
  it.each<[string, (raw: any) => void]>([
    ["transaction not found", (raw) => raw.getTxByHash.mockResolvedValueOnce("error")],
    ["block not found", (raw) => raw.getBlockByNumber.mockResolvedValueOnce("error")],
    ["transaction transport failure",
      (raw) => raw.getTxByHash.mockResolvedValueOnce(transportFailure())],
    ["block transport failure",
      (raw) => raw.getBlockByNumber.mockResolvedValueOnce(transportFailure())],
    ["storage 404", (raw) => raw.storagePrograms.read.mockRejectedValueOnce(notFound())],
    ["storage 503", (raw) => raw.storagePrograms.read.mockRejectedValueOnce(rpcFailure())],
    ["storage body without success", (raw) => raw.storagePrograms.read.mockResolvedValueOnce({
      success: false,
      errorCode: "NOT_FOUND",
      error: "Storage program not found",
    })],
  ])("keeps an unanswered proof read (%s) indeterminate instead of invalid", async (
    _condition,
    arrange,
  ) => {
    const { adapter, raw, evidence, receipt } = await anchoredProof();
    arrange(raw);
    await expect(adapter.verifyDemosAnchorReceipt(receipt))
      .rejects.toBeInstanceOf(SubstrateError);
    arrange(raw);
    await expect(adapter.verifyDemosWriteEvidence(evidence))
      .rejects.toBeInstanceOf(SubstrateError);
    // The same proof verifies once the node answers.
    await expect(adapter.verifyDemosAnchorReceipt(receipt)).resolves.toBe(true);
    await expect(adapter.verifyDemosWriteEvidence(evidence)).resolves.toBe(true);
  });

  // The supported node read contract (docs/demos-node-compatibility.md), as
  // recorded from node2 on 2026-10-15. demosdk 4.0.16 hands the adapter
  // body.response for a nodeCall and throws on a non-2xx Storage Program read.
  it("keeps the recorded node2 not-found reads indeterminate", async () => {
    const contract = JSON.parse(readFileSync(
      "test/fixtures/demos-node/node2-read-contract-2026-10-15.json",
      "utf8",
    ));
    expect(contract.deployment.commit).toBe("61b8e75aa8db5e408c49e1c3a89db4d673f45578");
    // The shapes are demosdk's: the recorded version is the one installed, and
    // the record ships with the package.
    expect(contract.demosdk).toBe(JSON.parse(readFileSync(
      "node_modules/@kynesyslabs/demosdk/package.json",
      "utf8",
    )).version);
    expect(JSON.parse(readFileSync("package.json", "utf8")).files)
      .toContain("docs/demos-node-compatibility.md");
    const { reads } = contract;
    const arrangements: Array<[string, (raw: any) => void]> = [
      ["transaction", (raw) => raw.getTxByHash.mockResolvedValueOnce(reads.txMissing.body.response)],
      ["block beyond head",
        (raw) => raw.getBlockByNumber.mockResolvedValueOnce(reads.blockBeyondHead.body.response)],
      ["block zero", (raw) => raw.getBlockByNumber.mockResolvedValueOnce(reads.blockZero.body.response)],
      ["storage program", (raw) => raw.storagePrograms.read.mockRejectedValueOnce(Object.assign(
        new Error("Request failed with status code 404"),
        { response: { status: reads.storageMissing.httpStatus, data: reads.storageMissing.body } },
      ))],
    ];
    for (const [read, arrange] of arrangements) {
      const { adapter, raw, evidence, receipt } = await anchoredProof();
      arrange(raw);
      await expect(adapter.verifyDemosAnchorReceipt(receipt), read)
        .rejects.toBeInstanceOf(SubstrateError);
      arrange(raw);
      await expect(adapter.verifyDemosWriteEvidence(evidence), read)
        .rejects.toBeInstanceOf(SubstrateError);
    }
    // The found shapes carry every member the proof comparison reads, and the
    // Storage Program read carries no provenance (so history must bind it).
    expect(reads.txFound.body.response).toMatchObject({
      status: "confirmed",
      blockNumber: expect.any(Number),
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(reads.txFound.body.response.contentKeys).toEqual(
      expect.arrayContaining(["type", "from", "to", "nonce", "data"]),
    );
    expect(reads.blockFound.body.response).toMatchObject({
      status: "confirmed",
      orderedTransactionsIncludesTx: true,
      validationDataKeys: ["signatures"],
    });
    expect(reads.blockFound.body.response.timestamp).toBeLessThan(1e11);
    expect(reads.storageFound.keys).not.toEqual(expect.arrayContaining(["createdByTx"]));
    expect(reads.storageFound.keys).not.toEqual(expect.arrayContaining(["lastModifiedByTx"]));
    expect(reads.storageFound.keys).not.toEqual(expect.arrayContaining(["interactionTxs"]));
  });

  it("still refuses a proof that the node's own records contradict", async () => {
    const { adapter, raw, evidence, receipt } = await anchoredProof();
    await expect(adapter.verifyDemosAnchorReceipt({
      ...receipt,
      blockRef: { ...receipt.blockRef!, id: "another-block" },
    })).resolves.toBe(false);
    const observed = await raw.getTxByHash(evidence.transactionRef);
    raw.getTxByHash.mockResolvedValueOnce({
      ...observed,
      blockNumber: evidence.blockNumber + 1,
    });
    await expect(adapter.verifyDemosAnchorReceipt(receipt)).resolves.toBe(false);
    raw.storagePrograms.read.mockResolvedValueOnce({
      ...await raw.storagePrograms.read(evidence.nativeAddress),
      data: { value: 2 },
    });
    await expect(adapter.verifyDemosWriteEvidence(evidence)).resolves.toBe(false);
  });

  // CORE SR2-5: a mismatch in any available binding makes the receipt invalid.
  // Both verifiers must still refuse when the node read, like node2's, carries
  // no provenance and the native-address history is served.
  it("refuses a receipt for one write that cites another write's transaction", async () => {
    const fixture = await makeAdapter();
    const a = await fixture.adapter.anchorWriteOnce("proof-cross-a", { value: "a" }, {
      timeoutMs: 1_000, pollMs: 1,
    });
    const b = await fixture.adapter.anchorWriteOnce("proof-cross-b", { value: "b" }, {
      timeoutMs: 1_000, pollMs: 1,
    });
    const receiptA = demosWriteEvidenceToAnchorReceipt({
      logicalAddress: "proof-cross-a",
      contentHash: contentHash({ value: "a" }),
      writer: `did:demos:agent:${fixture.wallet.replace(/^0x/, "")}`,
      evidence: a.demosEvidence!,
    });
    const { raw } = fixture;
    const read = raw.storagePrograms.read.getMockImplementation();
    raw.storagePrograms.read = vi.fn(async (address: string) => {
      const { createdByTx: _c, lastModifiedByTx: _l, interactionTxs: _i, ...rest } =
        await read(address);
      return rest;
    });
    const txA = await raw.getTxByHash(a.txRef);
    const txB = await raw.getTxByHash(b.txRef);
    serveStorageHistory(raw, [txB, txA]);
    const proof = JSON.parse(Buffer.from(receiptA.evidence.value, "base64url").toString("utf8"));
    proof.signedTransactionHash = demosSignedTransactionProofHash(txB);
    const forged = {
      ...receiptA,
      transactionRef: { ...receiptA.transactionRef, value: b.txRef! },
      nonce: String(b.demosEvidence!.nonce),
      evidence: {
        ...receiptA.evidence,
        value: Buffer.from(canonicalize(proof), "utf8").toString("base64url"),
      },
    };
    expectBindingRefusal(await refusal(fixture.adapter.verifyDemosAnchorReceipt(forged)));
    const forgedEvidence = {
      ...a.demosEvidence!,
      transactionRef: b.txRef!,
      nonce: b.demosEvidence!.nonce,
      signedTransaction: b.demosEvidence!.signedTransaction,
      signedTransactionHash: b.demosEvidence!.signedTransactionHash,
      blockNumber: b.demosEvidence!.blockNumber,
      blockHash: b.demosEvidence!.blockHash,
      blockTimestamp: b.demosEvidence!.blockTimestamp,
      finalityProof: b.demosEvidence!.finalityProof,
      finalityProofHash: b.demosEvidence!.finalityProofHash,
    };
    expectBindingRefusal(await refusal(
      fixture.adapter.verifyDemosWriteEvidence(forgedEvidence),
    ));
    await expect(fixture.adapter.verifyDemosAnchorReceipt(receiptA)).resolves.toBe(true);
    await expect(fixture.adapter.verifyDemosWriteEvidence(a.demosEvidence!))
      .resolves.toBe(true);
  });

  it("refuses a proof whose nonce is not the signed transaction's (SR2-5)", async () => {
    const { adapter, evidence, receipt } = await anchoredProof();
    expectBindingRefusal(await refusal(adapter.verifyDemosAnchorReceipt({
      ...receipt,
      nonce: String(evidence.nonce + 1),
    })));
    expectBindingRefusal(await refusal(adapter.verifyDemosWriteEvidence({
      ...evidence,
      nonce: evidence.nonce + 1,
    })));
    await expect(adapter.verifyDemosAnchorReceipt(receipt)).resolves.toBe(true);
  });

  /** Anchor a create, then an identical-content update of the same program. */
  async function createThenIdenticalUpdate(name: string) {
    const fixture = await makeAdapter();
    const { adapter, raw } = fixture;
    const value = { value: 1 };
    const created = await adapter.anchorWriteOnce(name, value, { timeoutMs: 1_000, pollMs: 1 });
    expect(created.demosEvidence?.operation).toBe("create");
    vi.mocked(adapter.resolveAnchorByName).mockResolvedValue({
      status: "present", address: created.address,
    });
    // The fixture node serves the update's payload; keep the program's name
    // and its create provenance, as a node does.
    const baseRead = raw.storagePrograms.read.getMockImplementation();
    const programName = (await baseRead(created.address)).programName;
    raw.storagePrograms.read = vi.fn(async (address: string) => {
      const current = await baseRead(address);
      return {
        ...current,
        programName: current.programName ?? programName,
        createdByTx: created.txRef,
        interactionTxs: [created.txRef, current.lastModifiedByTx],
      };
    });
    const updated = await adapter.anchorAndWait(name, value, {
      completion: "read-visible", timeoutMs: 1_000, pollMs: 1,
    });
    expect(updated.demosEvidence?.operation).toBe("update");
    const receipt = (evidence: NonNullable<typeof created.demosEvidence>) =>
      demosWriteEvidenceToAnchorReceipt({
        logicalAddress: name,
        contentHash: contentHash(value),
        writer: `did:demos:agent:${fixture.wallet.replace(/^0x/, "")}`,
        evidence,
      });
    return { ...fixture, created, updated, receipt };
  }

  // DEMOS-MAPPING §A.2 binds a write to its operation's createdByTx or
  // lastModifiedByTx. When the node serves that member it is authoritative:
  // `interactionTxs` naming the write does not override a contradiction.
  it.each([
    ["create", "createdByTx"],
    ["update", "lastModifiedByTx"],
  ] as const)("refuses a %s proof whose served %s names another write", async (
    operation,
    member,
  ) => {
    const { adapter, raw, created, updated, receipt: receiptFor } =
      await createThenIdenticalUpdate(`proof-contradicted-${operation}`);
    const evidence = (operation === "create" ? created : updated).demosEvidence!;
    const receipt = receiptFor(evidence);
    await expect(adapter.verifyDemosWriteEvidence(evidence)).resolves.toBe(true);
    await expect(adapter.verifyDemosAnchorReceipt(receipt)).resolves.toBe(true);
    const read = raw.storagePrograms.read.getMockImplementation();
    raw.storagePrograms.read = vi.fn(async (address: string) => ({
      ...await read(address),
      [member]: "tx-another-write",
      interactionTxs: [created.txRef, updated.txRef, "tx-another-write"],
    }));
    raw.getTransactionHistory = vi.fn(async () => {
      throw new Error("a served provenance member needs no history");
    });
    await expect(adapter.verifyDemosWriteEvidence(evidence)).resolves.toBe(false);
    await expect(adapter.verifyDemosAnchorReceipt(receipt)).resolves.toBe(false);
    expect(raw.getTransactionHistory).not.toHaveBeenCalled();
  });

  // On a provenance-free (node2-shaped) read, a create proof binds to the
  // history's single create and an update proof to the latest mutation.
  it("binds create and update proofs to native-address history by operation", async () => {
    const { adapter, raw, created, updated, receipt } =
      await createThenIdenticalUpdate("proof-history-ops");
    const read = raw.storagePrograms.read.getMockImplementation();
    raw.storagePrograms.read = vi.fn(async (address: string) => {
      const { createdByTx: _c, lastModifiedByTx: _l, interactionTxs: _i, ...rest } =
        await read(address);
      return rest;
    });
    const txCreate = await raw.getTxByHash(created.txRef);
    const txUpdate = await raw.getTxByHash(updated.txRef);
    const serveHistory = (rows: unknown[]) => {
      serveStorageHistory(raw, rows);
    };
    serveHistory([txUpdate, txCreate]);
    // The create stays verified after a later identical-content update.
    await expect(adapter.verifyDemosWriteEvidence(created.demosEvidence!)).resolves.toBe(true);
    await expect(adapter.verifyDemosAnchorReceipt(receipt(created.demosEvidence!)))
      .resolves.toBe(true);
    await expect(adapter.verifyDemosWriteEvidence(updated.demosEvidence!)).resolves.toBe(true);
    await expect(adapter.verifyDemosAnchorReceipt(receipt(updated.demosEvidence!)))
      .resolves.toBe(true);
    // A member served as null is not served: history still binds the read.
    raw.storagePrograms.read = vi.fn(async (address: string) => {
      const { createdByTx: _c, lastModifiedByTx: _l, interactionTxs: _i, ...rest } =
        await read(address);
      return { ...rest, createdByTx: null, lastModifiedByTx: null };
    });
    await expect(adapter.verifyDemosWriteEvidence(created.demosEvidence!)).resolves.toBe(true);
    await expect(adapter.verifyDemosAnchorReceipt(receipt(updated.demosEvidence!)))
      .resolves.toBe(true);
    // An update that a later write superseded no longer binds the read.
    serveHistory([{ ...txUpdate, hash: "tx-later-update" }, txUpdate, txCreate]);
    await expect(adapter.verifyDemosWriteEvidence(updated.demosEvidence!)).resolves.toBe(false);
    await expect(adapter.verifyDemosAnchorReceipt(receipt(updated.demosEvidence!)))
      .resolves.toBe(false);
    await expect(adapter.verifyDemosWriteEvidence(created.demosEvidence!)).resolves.toBe(true);
  });

  // The history names the address's create only when it holds exactly one.
  it("binds a create proof only to a single create in native-address history", async () => {
    const { adapter, raw, created, updated, receipt } =
      await createThenIdenticalUpdate("proof-history-single-create");
    const read = raw.storagePrograms.read.getMockImplementation();
    raw.storagePrograms.read = vi.fn(async (address: string) => {
      const { createdByTx: _c, lastModifiedByTx: _l, interactionTxs: _i, ...rest } =
        await read(address);
      return rest;
    });
    const txCreate = await raw.getTxByHash(created.txRef);
    const txUpdate = await raw.getTxByHash(updated.txRef);
    const earlierCreate = { ...txCreate, hash: "tx-earlier-create", blockNumber: 41 };
    for (const rows of [[txUpdate], [txUpdate, txCreate, earlierCreate]]) {
      serveStorageHistory(raw, rows);
      await expect(adapter.verifyDemosWriteEvidence(created.demosEvidence!))
        .resolves.toBe(false);
      await expect(adapter.verifyDemosAnchorReceipt(receipt(created.demosEvidence!)))
        .resolves.toBe(false);
      await expect(adapter.verifyDemosWriteEvidence(updated.demosEvidence!))
        .resolves.toBe(true);
    }
  });

  // kynesyslabs/node sets lastModifiedByTx on an ACL change but keeps the
  // value and createdByTx: an update proof is superseded, a create is not,
  // whether the node serves the members or only the native-address history.
  it("gives a later ACL change the same verdicts on both provenance paths", async () => {
    const { adapter, raw, created, updated, receipt } =
      await createThenIdenticalUpdate("proof-acl-change");
    const read = raw.storagePrograms.read.getMockImplementation();
    const verdicts = async () => [
      await adapter.verifyDemosWriteEvidence(created.demosEvidence!),
      await adapter.verifyDemosAnchorReceipt(receipt(created.demosEvidence!)),
      await adapter.verifyDemosWriteEvidence(updated.demosEvidence!),
      await adapter.verifyDemosAnchorReceipt(receipt(updated.demosEvidence!)),
    ];
    raw.storagePrograms.read = vi.fn(async (address: string) => ({
      ...await read(address),
      lastModifiedByTx: "tx-acl-change",
      interactionTxs: [created.txRef, updated.txRef, "tx-acl-change"],
    }));
    await expect(verdicts()).resolves.toEqual([true, true, false, false]);

    raw.storagePrograms.read = vi.fn(async (address: string) => {
      const { createdByTx: _c, lastModifiedByTx: _l, interactionTxs: _i, ...rest } =
        await read(address);
      return rest;
    });
    const txCreate = await raw.getTxByHash(created.txRef);
    const txUpdate = await raw.getTxByHash(updated.txRef);
    const later = (hash: string, payload: Record<string, unknown>) => ({
      ...txUpdate,
      hash,
      content: {
        ...txUpdate.content,
        nonce: txUpdate.content.nonce + 1,
        data: ["storageProgram", {
          storageAddress: created.address,
          ...payload,
        }],
      },
    });
    const serveHistory = (rows: unknown[]) => {
      serveStorageHistory(raw, rows);
    };
    serveHistory([
      later("tx-acl-change", { operation: "UPDATE_ACCESS_CONTROL", acl: { mode: "owner" } }),
      txUpdate,
      txCreate,
    ]);
    await expect(verdicts()).resolves.toEqual([true, true, false, false]);
    // A later partial edit leaves the value unattributable: indeterminate.
    serveHistory([
      later("tx-set-field", { operation: "SET_FIELD", field: "value", value: 1 }),
      txUpdate,
      txCreate,
    ]);
    await expect(adapter.verifyDemosWriteEvidence(created.demosEvidence!))
      .rejects.toBeInstanceOf(SubstrateError);
  });

  it.each([false, true])("refuses an obsolete update after a delegated identical write (served=%s)", async (served) => {
    const { adapter, raw, created, updated, receipt } =
      await createThenIdenticalUpdate("proof-delegated-write");
    const read = raw.storagePrograms.read.getMockImplementation();
    const txCreate = await raw.getTxByHash(created.txRef);
    const txUpdate = await raw.getTxByHash(updated.txRef);
    const delegated = {
      ...txUpdate, hash: "tx-delegated-write",
      content: { ...txUpdate.content, from: `0x${"cd".repeat(32)}`, nonce: 0 },
    };
    serveStorageHistory(raw, [delegated, txUpdate, txCreate]);
    // Querying the owner omits this permitted writer. Only the native address
    // returns every mutation. The delegate's lower nonce must not sort first.
    const history = raw.getTransactionHistory.getMockImplementation();
    raw.getTransactionHistory = vi.fn(async (address: string, type: string, options: any) =>
      address === created.address ? history(address, type, options)
        : [txUpdate, txCreate].slice(options.start, options.start + options.limit));
    raw.storagePrograms.read = vi.fn(async (address: string) => {
      const { createdByTx: _c, lastModifiedByTx: _l, interactionTxs: _i, ...rest } = await read(address);
      return served ? { ...rest, createdByTx: created.txRef, lastModifiedByTx: delegated.hash } : rest;
    });
    for (const verify of [
      () => adapter.verifyDemosWriteEvidence(updated.demosEvidence!),
      () => adapter.verifyDemosAnchorReceipt(receipt(updated.demosEvidence!)),
    ]) await expect(verify()).resolves.toBe(false);
    await expect(adapter.verifyDemosWriteEvidence(created.demosEvidence!)).resolves.toBe(true);
    await expect(adapter.verifyDemosAnchorReceipt(receipt(created.demosEvidence!))).resolves.toBe(true);
    if (!served) expect(raw.getTransactionHistory).toHaveBeenCalledWith(
      created.address, "storageProgram", { start: 0, limit: 100 });
    // Retrying against a recovered current view succeeds; no stale rejection is cached.
    serveStorageHistory(raw, [txUpdate, txCreate]);
    raw.storagePrograms.read = vi.fn(async (address: string) => {
      const { createdByTx: _c, lastModifiedByTx: _l, interactionTxs: _i, ...rest } = await read(address);
      return rest;
    });
    await expect(adapter.verifyDemosWriteEvidence(updated.demosEvidence!)).resolves.toBe(true);
    await expect(adapter.verifyDemosAnchorReceipt(receipt(updated.demosEvidence!))).resolves.toBe(true);
    raw.getBlockByNumber.mockResolvedValue({ number: 42, hash: "block-42", status: "confirmed",
      content: { timestamp: 120, ordered_transactions: [updated.txRef] },
      validation_data: { signatures: ["validator-test-signature"] } });
    // The history's create has no canonical inclusion: both public paths are indeterminate.
    await expect(adapter.verifyDemosWriteEvidence(updated.demosEvidence!)).rejects.toBeInstanceOf(SubstrateError);
    await expect(adapter.verifyDemosAnchorReceipt(receipt(updated.demosEvidence!))).rejects.toBeInstanceOf(SubstrateError);
  });

  // The history fallback's rules, one node reply each, on a provenance-free
  // (node2-shaped) read. Every case changes its verdict when its rule is removed.
  async function provenanceFreeHistory(name: string) {
    const fixture = await createThenIdenticalUpdate(name);
    const { adapter, raw, created, updated, receipt } = fixture;
    const read = raw.storagePrograms.read.getMockImplementation();
    raw.storagePrograms.read = vi.fn(async (address: string) => {
      const { createdByTx: _c, lastModifiedByTx: _l, interactionTxs: _i, ...rest } =
        await read(address);
      return rest;
    });
    const txCreate = await raw.getTxByHash(created.txRef);
    const txUpdate = await raw.getTxByHash(updated.txRef);
    const verifiers = [
      () => adapter.verifyDemosWriteEvidence(created.demosEvidence!),
      () => adapter.verifyDemosAnchorReceipt(receipt(created.demosEvidence!)),
      () => adapter.verifyDemosWriteEvidence(updated.demosEvidence!),
      () => adapter.verifyDemosAnchorReceipt(receipt(updated.demosEvidence!)),
    ];
    const lookup = {
      logicalAddress: updated.demosEvidence!.logicalName,
      nativeAddress: created.address,
      contentHash: updated.demosEvidence!.nativeRead.valueHash,
      writer: `did:demos:agent:${fixture.wallet.replace(/^0x/, "")}`,
    };
    /** [create write proof, create receipt, update write proof, update receipt] */
    const verdicts = async () => {
      const results: boolean[] = [];
      for (const verify of verifiers) results.push(await verify());
      return results;
    };
    /** Every public read path, the receipt resolver included, refuses with `message`. */
    const expectIndeterminate = async (message: string) => {
      for (const verify of [...verifiers, () => adapter.resolveDemosAnchorReceipt(lookup)]) {
        await expect(verify()).rejects.toMatchObject({ name: "SubstrateError", message });
      }
    };
    const withPayload = (row: any, hash: string, payload: Record<string, unknown>) => ({
      ...row, hash,
      content: { ...row.content, data: ["storageProgram", { ...row.content.data[1], ...payload }] },
    });
    const delegatedWrite = (hash: string) => ({
      ...txUpdate, hash,
      content: { ...txUpdate.content, from: `0x${"cd".repeat(32)}`, nonce: 0 },
    });
    return {
      ...fixture, lookup, txCreate, txUpdate, verifiers, verdicts, expectIndeterminate, withPayload, delegatedWrite,
    };
  }

  it("takes the latest native mutation from block order, not history order", async () => {
    const { raw, created, updated, txCreate, txUpdate, verdicts, delegatedWrite } =
      await provenanceFreeHistory("proof-history-block-order");
    const delegated = delegatedWrite("tx-block-order-delegated");
    // Timestamp order puts the owner's update first; only the block says which ran last.
    serveStorageHistory(raw, [txUpdate, delegated, txCreate]);
    const block = raw.getBlockByNumber.getMockImplementation();
    const executeInOrder = (order: string[]) =>
      raw.getBlockByNumber.mockImplementation(async (blockNumber: number) => {
        const served = await block(blockNumber);
        return blockNumber !== 42 ? served
          : { ...served, content: { ...served.content, ordered_transactions: order } };
      });
    executeInOrder([created.txRef, updated.txRef, delegated.hash]);
    await expect(verdicts()).resolves.toEqual([true, true, false, false]);
    executeInOrder([created.txRef, delegated.hash, updated.txRef]);
    await expect(verdicts()).resolves.toEqual([true, true, true, true]);
  });

  it.each(["create", "update"])("keeps a history that repeats the %s row indeterminate", async (repeated) => {
    const { raw, txCreate, txUpdate, expectIndeterminate } =
      await provenanceFreeHistory(`proof-history-repeated-${repeated}`);
    serveStorageHistory(raw, [txUpdate, txCreate, repeated === "create" ? txCreate : txUpdate]);
    await expectIndeterminate("Demos receipt history has inconsistent create or duplicate provenance");
  });

  it.each(["in place of", "beside"])("keeps a create row another sender signed %s the owner's indeterminate", async (placement) => {
    const { raw, txCreate, txUpdate, expectIndeterminate } =
      await provenanceFreeHistory(`proof-history-foreign-create-${placement.replace(/ /g, "-")}`);
    const foreign = { ...txCreate, content: { ...txCreate.content, from: `0x${"ef".repeat(32)}` } };
    serveStorageHistory(raw, placement === "in place of" ? [txUpdate, foreign]
      : [txUpdate, txCreate, { ...foreign, hash: "tx-foreign-create" }]);
    await expectIndeterminate("Demos receipt history has inconsistent create or duplicate provenance");
  });

  it.each<[string, Record<string, unknown>]>([
    ["data", { data: { value: 2 } }],
    ["metadata", { metadata: { note: "not the native metadata" } }],
    ["non-object data", { data: "value" }],
  ])("keeps a history whose newest write does not bind the native %s indeterminate", async (_kind, payload) => {
    const { raw, txCreate, txUpdate, expectIndeterminate, withPayload, verdicts } =
      await provenanceFreeHistory("proof-history-unbound-value");
    // The native read lags this newer write (or the history lags the read).
    serveStorageHistory(raw, [withPayload(txUpdate, "tx-unbound-write", payload), txUpdate, txCreate]);
    await expectIndeterminate("Demos receipt history does not bind the native value");
    serveStorageHistory(raw, [txUpdate, txCreate]);
    await expect(verdicts()).resolves.toEqual([true, true, true, true]);
  });

  // History pages are 100 rows with a one-row lookahead after a short page.
  // Failed rows sit inside canonical history on node2 and are skipped.
  const failedHistoryRow = (row: any, index: number) => ({
    ...row, hash: `tx-failed-${index}`, status: "failed",
    content: { ...row.content, nonce: 1_000 + index },
  });

  it("pages a long native-address history without skipping a row", async () => {
    const { raw, txCreate, txUpdate, verdicts, delegatedWrite } =
      await provenanceFreeHistory("proof-history-pages");
    const delegated = delegatedWrite("tx-paged-delegated");
    const failed = (from: number, count: number) =>
      Array.from({ length: count }, (_, offset) => failedHistoryRow(txUpdate, from + offset));
    // The superseding write is the first row of the second page.
    const rows = [...failed(0, 100), delegated, ...failed(100, 47), txUpdate, txCreate];
    expect(rows).toHaveLength(150);
    serveStorageHistory(raw, rows);
    await expect(verdicts()).resolves.toEqual([true, true, false, false]);
    expect(raw.getTransactionHistory.mock.calls.slice(0, 3).map((call: any[]) => call[2]))
      .toEqual([{ start: 0, limit: 100 }, { start: 100, limit: 100 }, { start: 150, limit: 1 }]);
    serveStorageHistory(raw, rows.filter((row) => row !== delegated));
    await expect(verdicts()).resolves.toEqual([true, true, true, true]);
  });

  it.each<[string, string, (rows: any[]) => (start: number, limit: number) => any[]]>([
    ["caps its pages below the requested limit", "Demos receipt history page is incomplete",
      (rows) => (start, limit) => rows.slice(start, start + Math.min(limit, 60))],
    ["ignores the requested limit", "Demos receipt history page is malformed",
      (rows) => (start) => rows.slice(start)],
  ])("keeps a history from a node that %s indeterminate", async (_node, message, serve) => {
    const { raw, txCreate, txUpdate, expectIndeterminate } =
      await provenanceFreeHistory("proof-history-page-shape");
    const rows = [
      ...Array.from({ length: 148 }, (_, index) => failedHistoryRow(txUpdate, index)),
      txUpdate,
      txCreate,
    ];
    serveStorageHistory(raw, rows);
    const page = serve(rows);
    raw.getTransactionHistory = vi.fn(async (
      _address: string, _type: string, options: { start: number; limit: number },
    ) => page(options.start, options.limit));
    await expectIndeterminate(message);
  });

  it("keeps a history past the verification cap indeterminate", async () => {
    const { raw, txCreate, txUpdate, expectIndeterminate } =
      await provenanceFreeHistory("proof-history-cap");
    // 100 pages of 100 rows, and one more row behind them.
    const rows = [
      txUpdate,
      txCreate,
      ...Array.from({ length: 9_999 }, (_, index) => failedHistoryRow(txUpdate, index)),
    ];
    serveStorageHistory(raw, rows);
    await expectIndeterminate("Demos receipt history exceeds the verification cap");
    expect(raw.getTransactionHistory).not.toHaveBeenCalledWith(
      expect.anything(), "storageProgram", { start: 10_000, limit: 100 });
  });

  it("keeps a same-value write arriving during native readback indeterminate", async () => {
    const { adapter, raw, created, updated, receipt } =
      await createThenIdenticalUpdate("proof-history-race");
    const read = raw.storagePrograms.read.getMockImplementation();
    const txCreate = await raw.getTxByHash(created.txRef);
    const txUpdate = await raw.getTxByHash(updated.txRef);
    const delegated = { ...txUpdate, hash: "tx-arriving-delegated-write",
      content: { ...txUpdate.content, from: `0x${"cd".repeat(32)}`, nonce: 0 } };
    for (const verify of [
      () => adapter.verifyDemosWriteEvidence(updated.demosEvidence!),
      () => adapter.verifyDemosAnchorReceipt(receipt(updated.demosEvidence!)),
    ]) {
      serveStorageHistory(raw, [txUpdate, txCreate]);
      let reads = 0;
      raw.storagePrograms.read = vi.fn(async (address: string) => {
        const { createdByTx: _c, lastModifiedByTx: _l, interactionTxs: _i, ...rest } = await read(address);
        if (++reads === 2) serveStorageHistory(raw, [delegated, txUpdate, txCreate]);
        return rest;
      });
      await expect(verify()).rejects.toMatchObject({
        name: "SubstrateError", message: "Demos receipt history changed during verification",
      });
    }
  });

  it.each(["readback", "pagination"])("refuses a behind-head write arriving during %s", async (arrival) => {
    const { adapter, raw, created, updated, receipt } =
      await createThenIdenticalUpdate("proof-history-behind-head");
    const read = raw.storagePrograms.read.getMockImplementation();
    const txCreate = await raw.getTxByHash(created.txRef);
    const txUpdate = await raw.getTxByHash(updated.txRef);
    // The later block's signed timestamp is older; node history sorts by that
    // timestamp, so its first row does not change when this write arrives.
    const delegated = { ...txUpdate, hash: "tx-behind-head-delegated", blockNumber: 43,
      content: { ...txUpdate.content, timestamp: 1, from: `0x${"cd".repeat(32)}`, nonce: 0 } };
    for (const verify of [
      () => adapter.verifyDemosWriteEvidence(updated.demosEvidence!),
      () => adapter.verifyDemosAnchorReceipt(receipt(updated.demosEvidence!)),
    ]) {
      serveStorageHistory(raw, [txUpdate, txCreate]);
      // Keep the reported tip stable to also model delayed history indexing.
      raw.getLastBlockNumber.mockResolvedValue(43);
      const history = raw.getTransactionHistory.getMockImplementation();
      raw.getTransactionHistory.mockImplementation(async (address: string, type: string, options: any) => {
        const rows = await history(address, type, options);
        if (arrival === "pagination" && options.start > 0) {
          serveStorageHistory(raw, [txUpdate, delegated, txCreate]);
        }
        return rows;
      });
      let reads = 0;
      raw.storagePrograms.read = vi.fn(async (address: string) => {
        const { createdByTx: _c, lastModifiedByTx: _l, interactionTxs: _i, ...rest } = await read(address);
        if (arrival === "readback" && ++reads === 2) {
          serveStorageHistory(raw, [txUpdate, delegated, txCreate]);
        }
        return rest;
      });
      await expect(verify()).rejects.toMatchObject({
        name: "SubstrateError", message: "Demos receipt history changed during verification",
      });
      // A stable retry sees the later canonical mutation and rejects the stale proof.
      await expect(verify()).resolves.toBe(false);
    }
  });

  it.each(["hash", "unavailable"])("refuses a changing or unavailable canonical snapshot (%s)", async (change) => {
    const { adapter, raw, created, updated, receipt } =
      await createThenIdenticalUpdate("proof-history-snapshot");
    const read = raw.storagePrograms.read.getMockImplementation();
    const txCreate = await raw.getTxByHash(created.txRef);
    const txUpdate = await raw.getTxByHash(updated.txRef);
    const block = raw.getBlockByNumber.getMockImplementation();
    serveStorageHistory(raw, [txUpdate, txCreate]);
    for (const verify of [
      () => adapter.verifyDemosWriteEvidence(updated.demosEvidence!),
      () => adapter.verifyDemosAnchorReceipt(receipt(updated.demosEvidence!)),
    ]) {
      let reads = 0;
      raw.getLastBlockNumber.mockResolvedValue(change === "unavailable" ? { result: 500 } : 42);
      raw.getBlockByNumber.mockImplementation(block);
      raw.storagePrograms.read = vi.fn(async (address: string) => {
        const { createdByTx: _c, lastModifiedByTx: _l, interactionTxs: _i, ...rest } = await read(address);
        if (++reads === 2) {
          if (change === "hash") raw.getBlockByNumber.mockImplementation(async (height: number) =>
            ({ ...await block(height), hash: "changed-canonical-block" }));
        }
        return rest;
      });
      await expect(verify()).rejects.toBeInstanceOf(SubstrateError);
    }
  });

  it("verifies unchanged native history while the chain tip advances", async () => {
    const { raw, adapter, lookup, txCreate, txUpdate, verifiers } =
      await provenanceFreeHistory("proof-history-moving-tip");
    serveStorageHistory(raw, [txUpdate, txCreate]);
    // Only the first call may choose a tip. Re-reading the tip would observe
    // height 43, while the pinned canonical block 42 remains unchanged.
    for (const verify of [...verifiers, () => adapter.resolveDemosAnchorReceipt(lookup)]) {
      raw.getLastBlockNumber.mockClear().mockResolvedValueOnce(42).mockResolvedValue(43);
      const result = await verify();
      if (typeof result === "boolean") expect(result).toBe(true);
      else expect(result).toMatchObject({ state: "finalized" });
      expect(raw.getLastBlockNumber).toHaveBeenCalledTimes(1);
    }
  });

  it.each(["404", "NOT_FOUND"])("keeps receipt recovery indeterminate on %s and succeeds after recovery", async (failure) => {
    const { adapter, raw, evidence } = await anchoredProof();
    const input = { logicalAddress: evidence.logicalName, nativeAddress: evidence.nativeAddress,
      contentHash: evidence.nativeRead.valueHash, writer: `did:demos:agent:${evidence.writer.replace(/^0x/, "")}` };
    if (failure === "404") raw.storagePrograms.read.mockRejectedValueOnce(notFound());
    else raw.storagePrograms.read.mockResolvedValueOnce({ success: false, errorCode: "NOT_FOUND" });
    await expect(adapter.resolveDemosAnchorReceipt(input)).rejects.toBeInstanceOf(SubstrateError);
    await expect(adapter.resolveDemosAnchorReceipt(input)).resolves.toMatchObject({ state: "finalized" });
  });

  // An off-contract 2xx read that reports no success is unanswered, not a
  // contradiction (docs/demos-node-compatibility.md), even beside a value
  // that would otherwise verify.
  it("keeps a Storage Program read reporting failure beside its value indeterminate", async () => {
    const { adapter, raw, evidence, receipt } = await anchoredProof();
    const read = raw.storagePrograms.read.getMockImplementation();
    raw.storagePrograms.read = vi.fn(async (address: string) =>
      ({ ...await read(address), success: false }));
    for (const verify of [
      () => adapter.verifyDemosAnchorReceipt(receipt),
      () => adapter.verifyDemosWriteEvidence(evidence),
    ]) {
      const error = await verify().then(() => undefined, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(SubstrateError);
      expect((error as SubstrateError).message)
        .toBe("Demos write proof observations are unavailable from this node");
    }
  });

  it("surfaces a failed history read as SubstrateError, not a raw transport error", async () => {
    const { adapter, raw, evidence, receipt } = await anchoredProof();
    const read = raw.storagePrograms.read.getMockImplementation();
    const failure = rpcFailure();
    let calls = 0;
    raw.storagePrograms.read = vi.fn(async (address: string) => {
      calls += 1;
      // The second read is the history path's post-scan freshness read.
      if (calls % 2 === 0) throw failure;
      const { createdByTx: _c, lastModifiedByTx: _l, interactionTxs: _i, ...rest } =
        await read(address);
      return rest;
    });
    const tx = await raw.getTxByHash(evidence.transactionRef);
    serveStorageHistory(raw, [tx]);
    for (const verify of [
      () => adapter.verifyDemosAnchorReceipt(receipt),
      () => adapter.verifyDemosWriteEvidence(evidence),
    ]) {
      const error = await verify().then(() => undefined, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(SubstrateError);
      expect((error as SubstrateError).cause).toBe(failure);
    }
  });

  it("refuses a contradicted proof without reading the native-address history", async () => {
    const { adapter, raw, evidence, receipt } = await anchoredProof();
    const read = raw.storagePrograms.read.getMockImplementation();
    raw.storagePrograms.read = vi.fn(async (address: string) => {
      const { createdByTx: _c, lastModifiedByTx: _l, interactionTxs: _i, ...rest } =
        await read(address);
      return rest;
    });
    raw.getTransactionHistory = vi.fn(async () => {
      throw rpcFailure();
    });
    await expect(adapter.verifyDemosAnchorReceipt({
      ...receipt,
      blockRef: { ...receipt.blockRef!, id: "another-block" },
    })).resolves.toBe(false);
    await expect(adapter.verifyDemosWriteEvidence({
      ...evidence,
      blockHash: "another-block",
    })).resolves.toBe(false);
    expect(raw.getTransactionHistory).not.toHaveBeenCalled();
    // The uncontradicted proof still needs the history, so it stays unanswered.
    await expect(adapter.verifyDemosAnchorReceipt(receipt))
      .rejects.toBeInstanceOf(SubstrateError);
  });

  it("keeps a block without finality data indeterminate instead of invalid", async () => {
    const { adapter, raw, evidence, receipt } = await anchoredProof();
    const withoutFinality = async () => {
      const { validation_data: _v, ...block } = await raw.getBlockByNumber(evidence.blockNumber);
      raw.getBlockByNumber.mockResolvedValueOnce(block);
    };
    await withoutFinality();
    await expect(adapter.verifyDemosAnchorReceipt(receipt))
      .rejects.toBeInstanceOf(SubstrateError);
    await withoutFinality();
    await expect(adapter.verifyDemosWriteEvidence(evidence))
      .rejects.toBeInstanceOf(SubstrateError);
  });

  it("retains a signed logical address behind its encoded native program name", async () => {
    const { adapter, wallet } = await makeAdapter();
    const logicalAddress = "dacs1:did%3Ademos%3Aagent%3Aseller:listing:v1";
    const storageName = logicalToStorageProgramName(logicalAddress);
    const value = { listingId: "listing", listingVersion: 1 };
    const anchored = await adapter.anchorWriteOnce(storageName, value, {
      timeoutMs: 1_000,
      pollMs: 1,
      metadata: { logicalAddress },
    });

    expect(anchored.demosEvidence?.logicalName).toBe(logicalAddress);
    expect(() => demosWriteEvidenceToAnchorReceipt({
      logicalAddress,
      contentHash: contentHash(value),
      writer: `did:demos:agent:${wallet.replace(/^0x/, "")}`,
      evidence: anchored.demosEvidence!,
    })).not.toThrow();
  });

  it("refuses an over-ceiling confirmed Storage Program fee before broadcast", async () => {
    const { adapter, raw } = await makeAdapter({ maximumFeeOs: 2n });
    raw.getNetworkInfo = vi.fn(async () => ({
      forks: { osDenomination: { activated: true } },
    }));
    raw.tx.confirm.mockImplementation(async (signed: { hash: string }) => ({
      response: {
        data: {
          transaction: { hash: signed.hash },
          gas_operation: {
            fees: {
              network_fee: "1",
              rpc_fee: "1",
              additional_fee: "1",
            },
          },
        },
      },
    }));

    await expect(adapter.anchorWriteOnce(
      "immutable-over-fee-ceiling",
      { value: 1 },
      { timeoutMs: 1_000, pollMs: 1 },
    )).rejects.toThrow(/exceeds maximumFeeOs/);
    expect(raw.tx.broadcast).not.toHaveBeenCalled();
  });

  it("refuses a capped Storage Program write when confirmed fees are absent", async () => {
    const { adapter, raw } = await makeAdapter({ maximumFeeOs: 2n });
    raw.getNetworkInfo = vi.fn(async () => ({
      forks: { osDenomination: { activated: true } },
    }));

    await expect(adapter.anchorWriteOnce(
      "immutable-missing-confirmed-fee",
      { value: 1 },
      { timeoutMs: 1_000, pollMs: 1 },
    )).rejects.toThrow(/requires authoritative confirmed transaction fees/);
    expect(raw.tx.broadcast).not.toHaveBeenCalled();
  });

  it("broadcasts a Storage Program write at the exact confirmed fee ceiling", async () => {
    const { adapter, raw } = await makeAdapter({ maximumFeeOs: 3n });
    raw.getNetworkInfo = vi.fn(async () => ({
      forks: { osDenomination: { activated: true } },
    }));
    raw.tx.confirm.mockImplementation(async (signed: { hash: string }) => ({
      response: {
        data: {
          transaction: { hash: signed.hash },
          gas_operation: {
            fees: {
              network_fee: "1",
              rpc_fee: "1",
              additional_fee: "1",
            },
          },
        },
      },
    }));

    await expect(adapter.anchorWriteOnce(
      "immutable-at-fee-ceiling",
      { value: 1 },
      { timeoutMs: 1_000, pollMs: 1 },
    )).resolves.toMatchObject({ txRef: expect.stringMatching(/^tx-/) });
    expect(raw.tx.broadcast).toHaveBeenCalledTimes(1);
  });

  it("normalizes legacy confirmed DEM fee numbers before applying an OS ceiling", async () => {
    const { adapter, raw } = await makeAdapter({ maximumFeeOs: 3_000_000_000n });
    raw.getNetworkInfo = vi.fn(async () => ({
      forks: { osDenomination: { activated: false } },
    }));
    raw.tx.confirm.mockImplementation(async (signed: { hash: string }) => ({
      response: {
        data: {
          transaction: { hash: signed.hash },
          gas_operation: {
            fees: {
              network_fee: 1,
              rpc_fee: 1,
              additional_fee: 1,
            },
          },
        },
      },
    }));

    await expect(adapter.anchorWriteOnce(
      "immutable-at-legacy-dem-fee-ceiling",
      { value: 1 },
      { timeoutMs: 1_000, pollMs: 1 },
    )).resolves.toMatchObject({ txRef: expect.stringMatching(/^tx-/) });
    expect(raw.tx.broadcast).toHaveBeenCalledTimes(1);
  });

  it("retains failed-attempt fees and blocks aggregate-budget overspend before rebroadcast", async () => {
    const { adapter, raw } = await makeAdapter({ maximumFeeOs: 3n });
    raw.getNetworkInfo = vi.fn(async () => ({
      forks: { osDenomination: { activated: true } },
    }));
    raw.tx.confirm.mockImplementation(async (signed: { hash: string }) => ({
      response: {
        data: {
          transaction: { hash: signed.hash },
          gas_operation: {
            fees: { network_fee: "1", rpc_fee: "1", additional_fee: "1" },
          },
        },
      },
    }));
    raw.nodeCall.mockResolvedValue({ state: "failed" });
    const feeBudget = {
      budgetId: "fixed-price:test-job:buyer",
      maximumPerWriteFeeOs: 3n,
      maximumTotalFeeOs: 3n,
    };

    await expect(adapter.anchorWriteOnce(
      "budgeted-failed-immutable",
      { value: 1 },
      { timeoutMs: 20, pollMs: 1, feeBudget },
    )).rejects.toThrow(/terminal state failed/);
    await expect(adapter.anchorWriteOnce(
      "budgeted-failed-immutable",
      { value: 1 },
      { timeoutMs: 1_000, pollMs: 1, feeBudget },
    )).rejects.toThrow(/aggregate confirmed fee exceeds purchase budget/);
    expect(raw.tx.broadcast).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed aggregate fee budgets before confirmation or broadcast", async () => {
    const { adapter, raw } = await makeAdapter({ maximumFeeOs: 3n });
    await expect(adapter.anchorWriteOnce(
      "invalid-aggregate-budget",
      { value: 1 },
      { feeBudget: {
        budgetId: "bad budget",
        maximumPerWriteFeeOs: 1n,
        maximumTotalFeeOs: -1n,
      } },
    )).rejects.toThrow(/aggregate fee budget is invalid/);
    expect(raw.tx.confirm).not.toHaveBeenCalled();
    expect(raw.tx.broadcast).not.toHaveBeenCalled();
  });

  it("enforces the retained per-write budget when the adapter ceiling is higher", async () => {
    const { adapter, raw } = await makeAdapter({ maximumFeeOs: 10n });
    raw.getNetworkInfo = vi.fn(async () => ({
      forks: { osDenomination: { activated: true } },
    }));
    raw.tx.confirm.mockImplementation(async (signed: { hash: string }) => ({
      response: {
        data: {
          transaction: { hash: signed.hash },
          gas_operation: {
            fees: { network_fee: "2", rpc_fee: "2", additional_fee: "2" },
          },
        },
      },
    }));
    await expect(adapter.anchorWriteOnce(
      "per-write-budgeted-immutable",
      { value: 1 },
      { feeBudget: {
        budgetId: "fixed-price:test-job:buyer",
        maximumPerWriteFeeOs: 5n,
        maximumTotalFeeOs: 20n,
      } },
    )).rejects.toThrow(/confirmed fee exceeds per-write purchase budget/);
    expect(raw.tx.broadcast).not.toHaveBeenCalled();
  });

  it("uses the confirmed transaction fee only when gas-operation fees are absent", async () => {
    const { adapter, raw } = await makeAdapter({ maximumFeeOs: 3n });
    raw.getNetworkInfo = vi.fn(async () => ({
      forks: { osDenomination: { activated: true } },
    }));
    raw.tx.confirm.mockImplementation(async (signed: { hash: string }) => ({
      response: {
        data: {
          transaction: {
            hash: signed.hash,
            content: {
              transaction_fee: {
                network_fee: "1",
                rpc_fee: "1",
                additional_fee: "1",
              },
            },
          },
        },
      },
    }));

    await expect(adapter.anchorWriteOnce(
      "immutable-at-fallback-fee-ceiling",
      { value: 1 },
      { timeoutMs: 1_000, pollMs: 1 },
    )).resolves.toMatchObject({ txRef: expect.stringMatching(/^tx-/) });
    expect(raw.tx.broadcast).toHaveBeenCalledTimes(1);
  });

  it("does not fall back from a malformed gas-operation fee to transaction content", async () => {
    const { adapter, raw } = await makeAdapter({ maximumFeeOs: 3n });
    raw.getNetworkInfo = vi.fn(async () => ({
      forks: { osDenomination: { activated: true } },
    }));
    raw.tx.confirm.mockImplementation(async (signed: { hash: string }) => ({
      response: {
        data: {
          transaction: {
            hash: signed.hash,
            content: {
              transaction_fee: {
                network_fee: "1",
                rpc_fee: "1",
                additional_fee: "1",
              },
            },
          },
          gas_operation: { fees: { network_fee: "1" } },
        },
      },
    }));

    await expect(adapter.anchorWriteOnce(
      "immutable-malformed-authoritative-fee",
      { value: 1 },
      { timeoutMs: 1_000, pollMs: 1 },
    )).rejects.toThrow(/requires authoritative confirmed transaction fees/);
    expect(raw.tx.broadcast).not.toHaveBeenCalled();
  });

  it("refuses an immutable create signed with a different nonce", async () => {
    const { adapter, raw, wallet } = await makeAdapter();
    raw.storagePrograms.sign.mockResolvedValue({
      hash: "tx-wrong-immutable-nonce",
      content: { nonce: 2 },
    });

    await expect(
      adapter.anchorWriteOnce(
        "immutable-wrong-nonce",
        { value: 1 },
        { timeoutMs: 1_000, pollMs: 1 },
      ),
    ).rejects.toThrow(/signed with nonce 2; expected 1/);
    expect(raw.tx.broadcast).not.toHaveBeenCalled();
  });

  it("completes an immutable write by hash while its broadcast response hangs", async () => {
    const { adapter, raw, wallet } = await makeAdapter();
    const name = "hung-immutable";
    const value = { value: 1 };
    const address = await adapter.anchorAddress(name);
    vi.mocked(adapter.resolveAnchorByName)
      .mockResolvedValueOnce({ status: "absent" })
      .mockResolvedValueOnce({ status: "present", address });
    raw.storagePrograms.read.mockResolvedValue({
      success: true,
      storageAddress: address,
      owner: wallet,
      programName: name,
      data: value,
    });
    raw.tx.broadcast.mockImplementation(() => deferred<never>().promise);

    await expect(
      adapter.anchorWriteOnce(name, value, {
        timeoutMs: 1_000,
        pollMs: 1,
      }),
    ).resolves.toMatchObject({
      address,
      txRef: expect.stringMatching(/^tx-/),
      demosEvidence: { nativeAddress: address },
    });
    expect(raw.nodeCall).toHaveBeenCalledWith(
      "getTransactionStatus",
      expect.objectContaining({ hash: expect.stringMatching(/^tx-/) }),
    );
  });

  it("preserves immutable terminal-failure evidence after winner reconciliation", async () => {
    const { adapter, raw } = await makeAdapter();
    raw.nodeCall.mockResolvedValue({ state: "failed" });

    const error = asAnchorError(
      await adapter
        .anchorWriteOnce(
          "failed-immutable",
          { value: 1 },
          { timeoutMs: 20, pollMs: 1 },
        )
        .catch((caught: unknown) => caught),
    );

    expect(error).toMatchObject({
      code: "inclusion-failed",
      receipt: {
        name: "failed-immutable",
        state: "failed",
        lastObservedState: "failed",
        txRef: expect.stringMatching(/^tx-/),
      },
    });
    expect(error.message).toMatch(/terminal state failed/);
    const preservedCause = (error as Error & { cause?: unknown }).cause;
    expect(preservedCause).toMatchObject({
      code: "inclusion-failed",
      receipt: {
        state: "failed",
        lastObservedState: "failed",
        txRef: error.receipt.txRef,
      },
    });
    expect((preservedCause as Error & { cause?: unknown }).cause).toMatchObject(
      { message: "terminal state=failed" },
    );
    expect(raw.tx.broadcast).toHaveBeenCalledTimes(1);
  });

  it("does not promote included status to success when execution failed", async () => {
    const { adapter, raw } = await makeAdapter();
    raw.getTxByHash.mockResolvedValue({
      status: "failed",
      blockNumber: 42,
    });

    const error = asAnchorError(
      await adapter
        .anchorWriteOnce(
          "failed-after-inclusion",
          { value: 1 },
          { timeoutMs: 20, pollMs: 1 },
        )
        .catch((caught: unknown) => caught),
    );

    expect(error).toMatchObject({
      code: "inclusion-failed",
      receipt: {
        name: "failed-after-inclusion",
        state: "failed",
        lastObservedState: "failed",
        txRef: expect.stringMatching(/^tx-/),
        blockNumber: 42,
      },
    });
    expect(raw.getTxByHash).toHaveBeenCalledWith(error.receipt.txRef);
    expect(error.message).toMatch(/terminal state failed/);
  });

  it("preserves immutable inclusion-timeout evidence at the shared completion deadline", async () => {
    const { adapter, raw } = await makeAdapter();
    raw.getTxByHash.mockResolvedValue({ status: "pending", blockNumber: null });
    raw.nodeCall
      .mockResolvedValueOnce({ state: "pending" })
      .mockImplementation(() => deferred<never>().promise);

    const error = asAnchorError(
      await adapter
        .anchorWriteOnce(
          "pending-immutable",
          { value: 1 },
          { timeoutMs: 20, pollMs: 1 },
        )
        .catch((caught: unknown) => caught),
    );

    expect(error).toMatchObject({
      code: "timeout",
      receipt: {
        name: "pending-immutable",
        state: "accepted",
        lastObservedState: "pending",
        txRef: expect.stringMatching(/^tx-/),
      },
    });
    expect(error.message).toMatch(/timed out during inclusion/);
    expect(error.message).not.toMatch(/immutable completion/);
    const inclusionCause = (error as Error & { cause?: unknown }).cause;
    if (inclusionCause !== undefined) {
      expect(inclusionCause).toMatchObject({
        code: "timeout",
        receipt: {
          state: "accepted",
          lastObservedState: "pending",
          txRef: error.receipt.txRef,
        },
      });
    }
    expect(raw.tx.broadcast).toHaveBeenCalledTimes(1);
  });

  it("preserves immutable visibility-timeout evidence at the shared completion deadline", async () => {
    const { adapter, raw } = await makeAdapter();
    raw.storagePrograms.read.mockImplementation(
      () => deferred<never>().promise,
    );

    const error = asAnchorError(
      await adapter
        .anchorWriteOnce(
          "invisible-immutable",
          { value: 1 },
          // Leave enough wall-clock budget for the synchronous mocked finality
          // stages even when Vitest is running the full suite under load. The
          // deliberately unresolved native read remains the timeout subject.
          { timeoutMs: 100, pollMs: 1 },
        )
        .catch((caught: unknown) => caught),
    );

    expect(error).toMatchObject({
      code: "timeout",
      receipt: {
        name: "invisible-immutable",
        state: "included",
        completion: "included",
        lastObservedState: "included",
        blockNumber: 42,
        txRef: expect.stringMatching(/^tx-/),
      },
    });
    expect(error.message).toMatch(
      /authenticated native readback did not complete/,
    );
    expect(error.message).not.toMatch(/immutable completion/);
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(raw.storagePrograms.read).toHaveBeenCalledTimes(2);
    expect(raw.tx.broadcast).toHaveBeenCalledTimes(1);
  });

  it("never recreates a canonically confirmed immutable slot while its name index lags", async () => {
    const { adapter, raw, wallet } = await makeAdapter();
    const first = await adapter.anchorWriteOnce(
      "confirmed-before-name-index",
      { value: 1 },
      { timeoutMs: 1_000, pollMs: 1 },
    );
    expect(first).toMatchObject({
      address: expect.any(String),
      txRef: expect.any(String),
      demosEvidence: {
        nativeRead: { valueHash: expect.any(String) },
      },
    });
    vi.mocked(adapter.resolveAnchorByName).mockRestore();
    await expect(
      adapter.resolveAnchorByName("confirmed-before-name-index", wallet),
    ).resolves.toEqual({ status: "present", address: first.address });

    await expect(
      adapter.anchorWriteOnce(
        "confirmed-before-name-index",
        { value: 1 },
        { timeoutMs: 20, pollMs: 1 },
      ),
    ).resolves.toMatchObject({
      address: first.address,
      txRef: first.txRef,
    });
    await expect(
      adapter.anchorWriteOnce(
        "confirmed-before-name-index",
        { value: 2 },
        { timeoutMs: 20, pollMs: 1 },
      ),
    ).rejects.toThrow(/different exact content or metadata/);
    expect(raw.storagePrograms.sign).toHaveBeenCalledTimes(1);
    expect(raw.tx.broadcast).toHaveBeenCalledTimes(1);

    await expect(
      adapter.anchorWriteOnce(
        "confirmed-before-name-index",
        { value: 1 },
        { timeoutMs: 1_000, pollMs: 1 },
      ),
    ).resolves.toMatchObject({
      address: first.address,
      txRef: first.txRef,
      demosEvidence: {
        transactionRef: first.txRef,
        nativeAddress: first.address,
      },
    });
    expect(raw.storagePrograms.sign).toHaveBeenCalledTimes(1);
    expect(raw.tx.broadcast).toHaveBeenCalledTimes(1);
  });

  it("bounds hung anchorWriteOnce preparation without poisoning the shared queue", async () => {
    fixtureId += 1;
    const rpc = `https://hung-immutable-sign-${fixtureId}.test`;
    const wallet = `${WALLET.slice(0, -4)}${fixtureId
      .toString(16)
      .padStart(4, "0")}`;
    const immutable = await makeAdapter({ rpc, wallet });
    const mutable = await makeAdapter({ rpc, wallet });
    immutable.raw.storagePrograms.sign.mockImplementation(
      () => deferred<never>().promise,
    );

    const first = immutable.adapter.anchorWriteOnce(
      "hung-immutable-sign",
      { value: 1 },
      { timeoutMs: 20, pollMs: 1 },
    );
    const queued = mutable.adapter.anchorAndWait(
      "after-hung-immutable-sign",
      { value: 2 },
      { completion: "included", timeoutMs: 1_000, pollMs: 1 },
    );

    await expect(first).rejects.toMatchObject({
      code: "timeout",
      receipt: { state: "not-broadcast" },
    });
    await expect(queued).resolves.toMatchObject({ state: "included" });
    expect(mutable.raw.storagePrograms.sign).toHaveBeenCalledTimes(1);
  });

  it("includes queueing in the total timeout and never signs a timed-out write", async () => {
    fixtureId += 1;
    const rpc = `https://queue-timeout-${fixtureId}.test`;
    const wallet = `${WALLET.slice(0, -4)}${fixtureId
      .toString(16)
      .padStart(4, "0")}`;
    const first = await makeAdapter({ rpc, wallet });
    const second = await makeAdapter({ rpc, wallet });
    let recover = false;
    first.raw.nodeCall.mockImplementation(async () =>
      recover ? { state: "included" } : { state: "pending" },
    );
    first.raw.getTxByHash.mockImplementation(async () =>
      recover
        ? { status: "confirmed", blockNumber: 1 }
        : { status: "pending", blockNumber: null },
    );
    await first.adapter.anchorAndWait(
      "one",
      { value: 1 },
      { completion: "accepted", timeoutMs: 1_000, pollMs: 1 },
    );

    const error = await second.adapter
      .anchorAndWait(
        "two",
        { value: 2 },
        { completion: "included", timeoutMs: 20, pollMs: 1 },
      )
      .catch((caught: unknown) => caught);
    expect(asAnchorError(error)).toMatchObject({
      code: "timeout",
      receipt: { state: "not-broadcast" },
    });
    expect(second.raw.storagePrograms.sign).not.toHaveBeenCalled();

    recover = true;
    await vi.waitFor(() =>
      expect(first.raw.nodeCall).toHaveBeenCalledWith(
        "getTransactionStatus",
        expect.anything(),
      ),
    );
  });

  it("releases the queue after a terminal failure so a retry can proceed", async () => {
    const { adapter, raw } = await makeAdapter();
    raw.nodeCall
      .mockResolvedValueOnce({ state: "failed" })
      .mockResolvedValue({ state: "included", blockNumber: 7 });
    raw.getTxByHash.mockImplementation(async (txRef: string) =>
      txRef.endsWith("-1")
        ? { status: "failed", blockNumber: 6 }
        : { status: "confirmed", blockNumber: 7 },
    );

    const failed = await adapter
      .anchorAndWait(
        "retry",
        { attempt: 1 },
        { completion: "included", timeoutMs: 1_000, pollMs: 1 },
      )
      .catch((caught: unknown) => caught);
    expect(asAnchorError(failed)).toMatchObject({
      code: "inclusion-failed",
      receipt: { state: "failed", name: "retry" },
    });

    await expect(
      adapter.anchorAndWait(
        "retry",
        { attempt: 2 },
        { completion: "included", timeoutMs: 1_000, pollMs: 1 },
      ),
    ).resolves.toMatchObject({ state: "included", blockNumber: 7 });
    expect(raw.tx.broadcast).toHaveBeenCalledTimes(2);
  });

  it("does not advance the confirmed nonce floor after terminal failure", async () => {
    const { adapter, raw } = await makeAdapter();
    const signedNonces: number[] = [];
    let signedCount = 0;
    raw.getAddressNonce.mockResolvedValue(0);
    raw.storagePrograms.sign.mockImplementation(
      async (payload: Record<string, unknown>, options?: { nonce?: number }) => {
        signedCount += 1;
        const nonce = options?.nonce as number;
        signedNonces.push(nonce);
        return signedStorageTransaction(
          (adapter.raw as any).getAddress(),
          `failed-nonce-floor-${signedCount}`,
          payload,
          nonce,
        );
      },
    );
    raw.nodeCall.mockImplementation(
      async (_method: string, params: { hash: string }) =>
        params.hash.endsWith("-1")
          ? { state: "failed", blockNumber: 6 }
          : { state: "included", blockNumber: 7 },
    );
    raw.getTxByHash.mockImplementation(async (txRef: string) =>
      txRef.endsWith("-1")
        ? { status: "failed", blockNumber: 6 }
        : { status: "confirmed", blockNumber: 7 },
    );

    await expect(
      adapter.anchorAndWait(
        "failed-nonce-floor",
        { attempt: 1 },
        { completion: "included", timeoutMs: 1_000, pollMs: 1 },
      ),
    ).rejects.toMatchObject({
      code: "inclusion-failed",
      receipt: { state: "failed" },
    });
    await expect(
      adapter.anchorAndWait(
        "failed-nonce-floor",
        { attempt: 2 },
        { completion: "included", timeoutMs: 1_000, pollMs: 1 },
      ),
    ).resolves.toMatchObject({ state: "included", blockNumber: 7 });

    expect(signedNonces).toEqual([1, 1]);
  });

  it("preserves accepted state and tx hash on total-operation timeout", async () => {
    const { adapter, raw } = await makeAdapter();
    let recover = false;
    raw.nodeCall.mockImplementation(async () =>
      recover ? { state: "included", blockNumber: 9 } : { state: "pending" },
    );
    raw.getTxByHash.mockImplementation(async () =>
      recover
        ? { status: "confirmed", blockNumber: 9 }
        : { status: "pending", blockNumber: null },
    );

    const timedOut = await adapter
      .anchorAndWait(
        "timeout",
        { value: 1 },
        { completion: "included", timeoutMs: 20, pollMs: 1 },
      )
      .catch((caught: unknown) => caught);
    const error = asAnchorError(timedOut);
    expect(error).toMatchObject({
      code: "timeout",
      receipt: { state: "accepted" },
    });
    expect(error.receipt.txRef).toMatch(/^tx-/);
    expect(error.receipt.attempts.inclusionPolls).toBeGreaterThan(0);

    recover = true;
    await vi.waitFor(() => {
      expect(raw.nodeCall.mock.calls.length).toBeGreaterThan(
        error.receipt.attempts.inclusionPolls,
      );
    });
    expect(raw.tx.broadcast).toHaveBeenCalledTimes(1);
  });

  it("returns included when the hash lands while the broadcast response hangs", async () => {
    const { adapter, raw } = await makeAdapter();
    const broadcast = deferred<unknown>();
    raw.tx.broadcast.mockImplementation(() => broadcast.promise);

    const operation = adapter.anchorAndWait(
      "broadcast-cancel",
      { value: 1 },
      {
        completion: "included",
        timeoutMs: 1_000,
        pollMs: 1,
      },
    );
    await vi.waitFor(() => expect(raw.tx.broadcast).toHaveBeenCalled());

    await expect(operation).resolves.toMatchObject({
      state: "included",
      completion: "included",
    });
    broadcast.resolve({ result: 200, response: { hash: "late-response" } });
    expect(raw.nodeCall).toHaveBeenCalled();
    expect(raw.tx.broadcast).toHaveBeenCalledTimes(1);
  });

  it("uses hash inclusion despite a never-settling broadcast response", async () => {
    fixtureId += 1;
    const rpc = `https://hung-broadcast-${fixtureId}.test`;
    const wallet = `${WALLET.slice(0, -4)}${fixtureId
      .toString(16)
      .padStart(4, "0")}`;
    const first = await makeAdapter({ rpc, wallet });
    const second = await makeAdapter({ rpc, wallet });
    first.raw.tx.broadcast.mockImplementation(() => deferred<unknown>().promise);

    await expect(
      first.adapter.anchorAndWait(
        "hung",
        { value: 1 },
        { completion: "included", timeoutMs: 20, pollMs: 1 },
      ),
    ).resolves.toMatchObject({
      state: "included",
      completion: "included",
    });

    await expect(
      second.adapter.anchorAndWait(
        "after-hung",
        { value: 2 },
        { completion: "included", timeoutMs: 1_000, pollMs: 1 },
      ),
    ).resolves.toMatchObject({ state: "included" });
    expect(second.raw.storagePrograms.sign).toHaveBeenCalledTimes(1);
  });

  it.each([500, 503])(
    "accepts authoritative inclusion despite an ambiguous result-%i response",
    async (result) => {
      const { adapter, raw } = await makeAdapter();
      raw.tx.broadcast.mockImplementation(async (validity: any) => ({
        result,
        response: { hash: validity.response.data.transaction.hash },
      }));

      await expect(
        adapter.anchorAndWait(
          `ambiguous-${result}`,
          { value: 1 },
          { completion: "included", timeoutMs: 1_000, pollMs: 1 },
        ),
      ).resolves.toMatchObject({
        state: "included",
        completion: "included",
      });
      expect(raw.nodeCall).toHaveBeenCalled();
    },
  );

  it("fails promptly when broadcast is definitively rejected and the hash is absent", async () => {
    const { adapter, raw } = await makeAdapter();
    raw.tx.broadcast.mockResolvedValue({ result: 400, response: "invalid tx" });
    raw.nodeCall.mockResolvedValue({ state: "unknown" });
    raw.getTxByHash.mockResolvedValue({ status: "pending", blockNumber: null });

    const error = asAnchorError(
      await adapter
        .anchorAndWait(
          "definitive-rejection",
          { value: 1 },
          { completion: "included", timeoutMs: 1_000, pollMs: 1 },
        )
        .catch((caught: unknown) => caught),
    );
    expect(error).toMatchObject({
      code: "broadcast-failed",
      receipt: { state: "failed" },
    });
    expect(error.receipt.attempts.inclusionPolls).toBeGreaterThan(0);
  });

  it("treats a thrown transport timeout as ambiguous until hash reconciliation", async () => {
    fixtureId += 1;
    const rpc = `https://transport-timeout-${fixtureId}.test`;
    const wallet = `${WALLET.slice(0, -4)}${fixtureId
      .toString(16)
      .padStart(4, "0")}`;
    const first = await makeAdapter({ rpc, wallet });
    const second = await makeAdapter({ rpc, wallet });
    let firstIncluded = false;
    first.raw.tx.broadcast.mockRejectedValue(
      Object.assign(new Error("socket timed out"), { code: "ETIMEDOUT" }),
    );
    first.raw.nodeCall.mockImplementation(async () =>
      firstIncluded ? { state: "included" } : { state: "pending" },
    );
    first.raw.getTxByHash.mockImplementation(async () =>
      firstIncluded
        ? { status: "confirmed", blockNumber: 1 }
        : { status: "pending", blockNumber: null },
    );

    const error = asAnchorError(
      await first.adapter
        .anchorAndWait(
          "transport-timeout",
          { value: 1 },
          { completion: "included", timeoutMs: 1_000, pollMs: 1 },
        )
        .catch((caught: unknown) => caught),
    );
    expect(error).toMatchObject({
      code: "timeout",
      receipt: { state: "broadcast-unknown" },
    });

    const queued = second.adapter.anchorAndWait(
      "after-transport-timeout",
      { value: 2 },
      { completion: "included", timeoutMs: 1_000, pollMs: 1 },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(second.raw.storagePrograms.sign).not.toHaveBeenCalled();

    firstIncluded = true;
    await expect(queued).resolves.toMatchObject({ state: "included" });
    expect(second.raw.storagePrograms.sign).toHaveBeenCalledTimes(1);
  });

  it("cancels during inclusion with a receipt and reconciles safely", async () => {
    const { adapter, raw } = await makeAdapter();
    const controller = new AbortController();
    let recover = false;
    raw.nodeCall.mockImplementation(async () =>
      recover ? { state: "included", blockNumber: 10 } : { state: "pending" },
    );
    raw.getTxByHash.mockImplementation(async () =>
      recover
        ? { status: "confirmed", blockNumber: 10 }
        : { status: "pending", blockNumber: null },
    );

    const operation = adapter.anchorAndWait(
      "cancel",
      { value: 1 },
      {
        completion: "included",
        timeoutMs: 1_000,
        pollMs: 2,
        signal: controller.signal,
      },
    );
    await vi.waitFor(() => expect(raw.nodeCall).toHaveBeenCalled());
    controller.abort();

    const error = asAnchorError(
      await operation.catch((caught: unknown) => caught),
    );
    expect(error).toMatchObject({
      code: "cancelled",
      receipt: { state: "accepted" },
    });
    expect(error.receipt.txRef).toMatch(/^tx-/);

    recover = true;
    await vi.waitFor(() => {
      expect(raw.nodeCall.mock.calls.length).toBeGreaterThan(
        error.receipt.attempts.inclusionPolls,
      );
    });
    expect(raw.tx.broadcast).toHaveBeenCalledTimes(1);
  });
});
