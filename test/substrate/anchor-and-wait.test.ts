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

const WALLET = `0x${"ab".repeat(32)}`;
let fixtureId = 0;
const writeJournal = createInMemoryDemosWriteJournal();

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
  let lastObservedTxRef = "";

  raw.connect = vi.fn().mockResolvedValue(undefined);
  raw.getAddress = vi.fn(() => wallet);
  vi.spyOn(adapter, "resolveAnchorByName").mockResolvedValue({
    status: "absent",
  });
  raw.getAddressNonce = vi.fn(async () => signedCount);
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
    lastObservedTxRef = txRef;
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
  raw.getBlockByNumber = vi.fn(async (blockNumber: number) => ({
    number: blockNumber,
    hash: `block-${blockNumber}`,
    status: "confirmed",
    content: {
      timestamp: 120,
      ordered_transactions: [
        (adapter as unknown as {
          activeWriteRecord?: { txRef?: string };
        }).activeWriteRecord?.txRef ?? lastObservedTxRef,
      ],
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

  it("distinguishes genuine 404 absence from transient read failures", async () => {
    const { adapter, raw } = await makeAdapter();

    await expect(adapter.readAnchor("missing")).resolves.toBeNull();
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
    await expect(
      adapter.verifyDemosWriteEvidence(anchored.demosEvidence!),
    ).resolves.toBe(true);
    const portableReceipt = demosWriteEvidenceToAnchorReceipt({
      logicalAddress: name,
      contentHash: contentHash(value),
      writer: `did:demos:agent:${wallet.replace(/^0x/, "")}`,
      evidence: anchored.demosEvidence!,
    });
    await expect(
      adapter.verifyDemosAnchorReceipt(portableReceipt),
    ).resolves.toBe(true);
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
    const historyTransaction = await raw.getTxByHash(anchored.txRef);
    raw.storagePrograms.read.mockResolvedValue({
      success: true,
      storageAddress: address,
      owner: wallet,
      programName: name,
      data: value,
    });
    raw.getTransactionHistory = vi.fn(async (
      _owner: string,
      _type: string,
      options: { start: number; limit: number },
    ) => options.start === 0 ? [historyTransaction] : []);
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
      wallet,
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
