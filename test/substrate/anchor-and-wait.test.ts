import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AnchorWaitError,
  DemosAdapter,
  type AnchorAttemptReceipt,
} from "../../src/substrate/index.js";

const WALLET = `0x${"ab".repeat(32)}`;
let fixtureId = 0;

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

async function makeAdapter(options?: { rpc?: string; wallet?: string }) {
  fixtureId += 1;
  const id = fixtureId;
  const rpc = options?.rpc ?? `https://node-${id}.test`;
  const wallet =
    options?.wallet ??
    `${WALLET.slice(0, -4)}${id.toString(16).padStart(4, "0")}`;
  const adapter = new DemosAdapter({ rpc });
  const raw = adapter.raw as any;
  let signedCount = 0;

  raw.connect = vi.fn().mockResolvedValue(undefined);
  raw.getAddress = vi.fn(() => wallet);
  vi.spyOn(adapter, "resolveAnchorByName").mockResolvedValue({
    status: "absent",
  });
  vi.spyOn(
    adapter as unknown as { nextAnchorNonce(): Promise<number> },
    "nextAnchorNonce",
  ).mockResolvedValue(1);
  raw.getAddressNonce = vi.fn(async () => signedCount);
  raw.storagePrograms.read = vi.fn().mockRejectedValue(notFound());
  raw.storagePrograms.sign = vi.fn(
    async (_payload: unknown, options?: { nonce?: number }) => {
      const nonce =
        options?.nonce ?? (await raw.getAddressNonce(wallet)) + 1;
      signedCount += 1;
      return { hash: `tx-${id}-${signedCount}`, content: { nonce } };
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
  await adapter.connect();

  return { adapter, raw, rpc, wallet };
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

  it("releases the nonce queue after nonce advancement, before slow read visibility", async () => {
    const { adapter, raw } = await makeAdapter();
    const firstValue = { value: "first" };
    const secondValue = { value: "second" };
    const firstAddress = await adapter.anchorAddress("first");
    const secondAddress = await adapter.anchorAddress("second");
    let firstVisible = false;

    raw.storagePrograms.read.mockImplementation(async (address: string) => {
      if (address === firstAddress) {
        return {
          success: true,
          data: firstVisible ? firstValue : { value: "stale" },
        };
      }
      if (address === secondAddress) {
        return { success: true, data: secondValue };
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

    const second = await adapter.anchorAndWait("second", secondValue, {
      completion: "included",
      timeoutMs: 1_000,
      pollMs: 1,
    });
    expect(second.state).toBe("included");

    firstVisible = true;
    await expect(first).resolves.toMatchObject({ state: "read-visible" });
    expect(raw.tx.broadcast).toHaveBeenCalledTimes(2);
  });

  it("holds the wallet queue until the authoritative account nonce catches up", async () => {
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
      vi.mocked(
        (
          fixture.adapter as unknown as {
            nextAnchorNonce(): Promise<number>;
          }
        ).nextAnchorNonce,
      ).mockImplementation(async () => accountNonce + 1);
      fixture.raw.storagePrograms.sign.mockImplementation(
        async (_payload: unknown, options?: { nonce?: number }) => {
          const nonce =
            options?.nonce ??
            (await fixture.raw.getAddressNonce(wallet)) + 1;
          signedNonces.push(nonce);
          return {
            hash: `tx-nonce-lag-${signedNonces.length}`,
            content: { nonce },
          };
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
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(second.raw.storagePrograms.sign).not.toHaveBeenCalled();
    expect(signedNonces).toEqual([1]);

    accountNonce = 1;
    await expect(queued).resolves.toMatchObject({ state: "included" });
    expect(signedNonces).toEqual([1, 2]);
    accountNonce = 2;
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
      vi.mocked(
        (
          fixture.adapter as unknown as {
            nextAnchorNonce(): Promise<number>;
          }
        ).nextAnchorNonce,
      ).mockImplementation(async () => accountNonce + 1);
      fixture.raw.storagePrograms.sign.mockImplementation(
        async (_payload: unknown, options?: { nonce?: number }) => {
          const nonce =
            options?.nonce ??
            (await fixture.raw.getAddressNonce(wallet)) + 1;
          signedNonces.push(nonce);
          return {
            hash: `tx-cross-surface-${signedNonces.length}`,
            content: { nonce },
          };
        },
      );
    }
    vi.mocked(immutable.adapter.resolveAnchorByName)
      .mockResolvedValueOnce({ status: "absent" })
      .mockResolvedValueOnce({ status: "present", address });
    immutable.raw.storagePrograms.read.mockResolvedValue({
      success: true,
      data: value,
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
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mutable.raw.storagePrograms.sign).not.toHaveBeenCalled();
    expect(signedNonces).toEqual([1]);

    accountNonce = 1;
    await expect(queued).resolves.toMatchObject({ state: "included" });
    expect(signedNonces).toEqual([1, 2]);
    accountNonce = 2;
  });

  it("binds an immutable create to the nonce used to derive its address", async () => {
    const { adapter, raw } = await makeAdapter();
    const name = "immutable-nonce-bound";
    const value = { value: 1 };
    const address = await adapter.anchorAddress(name);
    vi.mocked(adapter.resolveAnchorByName)
      .mockResolvedValueOnce({ status: "absent" })
      .mockResolvedValue({ status: "present", address });
    raw.storagePrograms.read.mockResolvedValue({ success: true, data: value });

    await expect(
      adapter.anchorWriteOnce(name, value, {
        timeoutMs: 1_000,
        pollMs: 1,
      }),
    ).resolves.toEqual({ address, txRef: expect.stringMatching(/^tx-/) });

    expect(raw.storagePrograms.sign).toHaveBeenCalledWith(
      expect.anything(),
      { nonce: 1 },
    );
  });

  it("completes an immutable write by hash while its broadcast response hangs", async () => {
    const { adapter, raw } = await makeAdapter();
    const name = "hung-immutable";
    const value = { value: 1 };
    const address = await adapter.anchorAddress(name);
    vi.mocked(adapter.resolveAnchorByName)
      .mockResolvedValueOnce({ status: "absent" })
      .mockResolvedValueOnce({ status: "present", address });
    raw.storagePrograms.read.mockResolvedValue({ success: true, data: value });
    raw.tx.broadcast.mockImplementation(() => deferred<never>().promise);

    await expect(
      adapter.anchorWriteOnce(name, value, {
        timeoutMs: 1_000,
        pollMs: 1,
      }),
    ).resolves.toEqual({ address, txRef: expect.stringMatching(/^tx-/) });
    expect(raw.nodeCall).toHaveBeenCalledWith(
      "getTransactionStatus",
      expect.objectContaining({ hash: expect.stringMatching(/^tx-/) }),
    );
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

  it("preserves accepted state and tx hash on total-operation timeout", async () => {
    const { adapter, raw } = await makeAdapter();
    let recover = false;
    raw.nodeCall.mockImplementation(async () =>
      recover ? { state: "included", blockNumber: 9 } : { state: "pending" },
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
