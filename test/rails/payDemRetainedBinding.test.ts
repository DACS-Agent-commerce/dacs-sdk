import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createIdempotencyStore,
  createInMemorySettlementLog,
  settlementKey,
  type SettlementLog,
} from "../../src/rails/idempotency.js";
import {
  createPayDemRail,
  payDemSettle,
  withRecoveredAttempts,
  type PayDemPreparedTransfer,
  type PayDemRail,
  type PayDemSettlementRecoveryContext,
} from "../../src/rails/payDem.js";
import type { SettleRequest } from "../../src/rails/settlementTypes.js";

// A retained pay-dem success (a request carrying history) is reported only when
// the job's prepared-transfer record and the SDK's own read of the node agree.
// The rail, the bridge and the settlement store are the real ones; only the
// Demos node is simulated, as in payDemRestartRecipe.test.ts. The journal, the
// settlement log and the node survive a restart; everything else is rebuilt.

const PAYER = `0x${"ab".repeat(32)}`;
const PAYEE = `0x${"cd".repeat(32)}`;
const NONCE = 7;
const BLOCK = 42;
const AMOUNT_OS = "1000000000";
const LEASE_MS = 30_000;
const CRASH_AT = 1_000;
// Short observation bounds for rows that end when the node never proves execution.
const SHORT_READS = { inclusionTimeoutMs: 40, transactionRecordTimeoutMs: 40, inclusionPollIntervalMs: 5 };

interface NodeRecord { status: "pending" | "confirmed" | "failed"; transaction: Record<string, unknown>; blockNumber: number }

const demosSdk = vi.hoisted(() => ({
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
    _doPost = vi.fn();
    readonly tx = { confirm: demosSdk.confirm };
    readonly broadcast = demosSdk.broadcast;
    readonly connect = demosSdk.connect;
    readonly connectWallet = demosSdk.connectWallet;
    readonly getNetworkInfo = demosSdk.getNetworkInfo;
    readonly getTxByHash = demosSdk.getTxByHash;
    readonly nodeCall = demosSdk.nodeCall;
    readonly transfer = demosSdk.transfer;
    readonly waitForNonce = demosSdk.waitForNonce;

    getAddress(): string {
      return PAYER;
    }
  },
}));

// The real execution authority, which also admits the rails a test registers
// here, so a rail the factory did not build can reach the binding step.
const admittedFakeRails = vi.hoisted(() => new WeakSet<object>());
vi.mock("../../src/rails/payDemExecutionAuthority.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/rails/payDemExecutionAuthority.js")>();
  return {
    createPayDemExecutionAuthority: () => {
      const authority = actual.createPayDemExecutionAuthority();
      return {
        ...authority,
        assertCapability: (value: object) => {
          if (!admittedFakeRails.has(value)) authority.assertCapability(value);
        },
      };
    },
  };
});

let node: Map<string, NodeRecord>;
let journal: PayDemPreparedTransfer[];
let log: SettlementLog;
let signed: number;
let broadcastCalls: number;
let rpcCounter = 0;

const hashOf = (ordinal: number) => ordinal.toString(16).padStart(2, "0").repeat(32);

beforeEach(() => {
  vi.clearAllMocks();
  node = new Map();
  journal = [];
  log = createInMemorySettlementLog();
  signed = 0;
  broadcastCalls = 0;
  rpcCounter += 1;

  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { params: [{ data: { hash: string } }] };
    return new Response(JSON.stringify({ result: 200, response: await demosSdk.getTxByHash(body.params[0].data.hash) }));
  }));
  demosSdk.connect.mockResolvedValue(undefined);
  demosSdk.connectWallet.mockResolvedValue(undefined);
  demosSdk.getNetworkInfo.mockResolvedValue({ forks: { osDenomination: { activated: true } } });
  demosSdk.waitForNonce.mockResolvedValue(undefined);
  demosSdk.transfer.mockImplementation(async (to: string, amountOs: bigint) => {
    signed += 1;
    return {
      hash: hashOf(signed),
      content: {
        nonce: NONCE + signed - 1, type: "native", from: PAYER, to, amount: amountOs.toString(),
        data: ["native", { nativeOperation: "send", args: [to, amountOs.toString()] }],
      },
    };
  });
  demosSdk.confirm.mockImplementation(async (input: { hash: string; content: Record<string, unknown> }) => ({
    response: { data: { transaction: { hash: input.hash, content: input.content } } },
  }));
  demosSdk.broadcast.mockImplementation(async (validity: {
    response: { data: { transaction: { hash: string; content: Record<string, unknown> } } };
  }) => {
    broadcastCalls += 1;
    const { transaction } = validity.response.data;
    node.set(transaction.hash, { status: "confirmed", transaction, blockNumber: BLOCK });
    return { response: { hash: transaction.hash } };
  });
  demosSdk.nodeCall.mockImplementation(async (_message: string, args: { hash: string }) => {
    const record = node.get(args.hash);
    return record?.status === "confirmed"
      ? { state: "included", blockNumber: record.blockNumber }
      : { state: "not_found" };
  });
  demosSdk.getTxByHash.mockImplementation(async (hash: string) => {
    const record = node.get(hash);
    if (record === undefined) return null;
    const content = record.transaction.content as Record<string, unknown>;
    return {
      ...record.transaction,
      content: { ...content, nonce: String(content.nonce) },
      status: record.status,
      blockNumber: record.blockNumber,
    };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const requestFor = (jobId: string): SettleRequest => ({
  rail: "pay-dem", phase: "pay-dem", phaseIndex: 0, jobId, amount: "1", asset: "DEM",
  payee: `did:demos:agent:${PAYEE.slice(2)}`, expectedPayee: PAYEE,
});
const keyOf = (request: SettleRequest) => settlementKey(request.rail, request.jobId, request.phaseIndex ?? 0);
const auditOf = (request: SettleRequest, ok = true): SettleRequest => ({
  ...request, recoveryOnly: true,
  priorAttempts: [{ txHash: journal[0]?.txHash ?? "", chainId: "demos", ok }],
});
const journalFor = async (key: string) => journal.filter((prepared) => prepared.recovery?.settlementKey === key);
type ReadPreparedTransfers = (key: string) => Promise<readonly PayDemPreparedTransfer[]>;

/** The documented recipe's reconciler: it reads the same journal and node the bridge reads. */
const reconcileFromJournalAndNode = async (context: Readonly<PayDemSettlementRecoveryContext>) => {
  if (context.txHash === undefined) throw new Error("no transaction hash to reconcile");
  const prepared = journal.find((entry) =>
    entry.recovery?.settlementKey === context.settlementKey && entry.txHash === context.txHash);
  if (prepared === undefined) throw new Error(`no journal entry for ${context.txHash}`);
  const record = node.get(prepared.txHash);
  if (record === undefined) return null;
  if (record.status !== "confirmed") throw new Error(`transfer is still ${record.status} at the node`);
  const content = record.transaction.content as { nonce: number; from: string; to: string; amount: string };
  if (content.nonce !== prepared.nonce) throw new Error("node record carries another nonce");
  return {
    ok: true as const, txHash: prepared.txHash, payer: content.from, payee: content.to,
    chainId: "demos", amountOs: content.amount, blockNumber: BLOCK, txRefKind: "demos",
    finality: { model: "bft-final" as const }, execution: "executed" as const,
  };
};

/**
 * A reconciler that reads neither the journal nor the node and reports the
 * unaltered payment as executed, so only the bridge's own reads can refuse it.
 */
const reconcileWithoutReading = vi.fn(async (context: Readonly<PayDemSettlementRecoveryContext>) => ({
  ok: true as const, txHash: context.txHash ?? "", payer: PAYER, payee: PAYEE, chainId: "demos",
  amountOs: AMOUNT_OS, blockNumber: BLOCK, txRefKind: "demos",
  finality: { model: "bft-final" as const }, execution: "executed" as const,
}));

async function buildRail(timing: Partial<typeof SHORT_READS> = {}) {
  return createPayDemRail({
    rpc: `https://retained-binding-${rpcCounter}.test`,
    secret: "test-secret",
    ...timing,
    journalPreparedTransfer: async (prepared: Readonly<PayDemPreparedTransfer>) => { journal.push(prepared); },
  });
}

interface AuditOptions {
  rail?: PayDemRail;
  reconcile?: typeof reconcileFromJournalAndNode;
  readPreparedTransfers?: ReadPreparedTransfers | null;
  timing?: Partial<typeof SHORT_READS>;
  restartNumber?: number;
}

/** A restarted process: a new rail, store and bridge over the surviving log, journal and node. */
async function restartedBridge(options: AuditOptions = {}) {
  const rail = options.rail ?? await buildRail(options.timing);
  const claimIntent = vi.spyOn(log, "claimIntent");
  const putOutcome = vi.spyOn(log, "putOutcome");
  const store = createIdempotencyStore(log, {
    now: () => CRASH_AT + (options.restartNumber ?? 1) * 2 * LEASE_MS, leaseDurationMs: LEASE_MS,
  });
  const once = vi.spyOn(store, "once");
  const readPreparedTransfers = options.readPreparedTransfers === undefined
    ? vi.fn(journalFor)
    : options.readPreparedTransfers;
  const bridge = payDemSettle(rail, {}, {
    store,
    reconcile: options.reconcile ?? reconcileFromJournalAndNode,
    ...(readPreparedTransfers === null ? {} : { readPreparedTransfers }),
  });
  const effects = () => ({
    claims: claimIntent.mock.calls.length, outcomes: putOutcome.mock.calls.length,
    onces: once.mock.calls.length, signed, broadcastCalls,
  });
  return { bridge, effects };
}

const NO_NEW_EFFECTS = { claims: 0, outcomes: 0, onces: 0, signed: 1, broadcastCalls: 1 };

/** Pay once through the real rail; the process dies before the outcome is recorded. */
async function payAndLoseOutcome(request: SettleRequest) {
  const rail = await buildRail();
  const store = createIdempotencyStore({
    ...log, putOutcome: async () => { throw new Error("process died before the outcome was recorded"); },
  }, { now: () => CRASH_AT, leaseDurationMs: LEASE_MS });
  await expect(payDemSettle(rail, {}, { store, reconcile: reconcileFromJournalAndNode, readPreparedTransfers: journalFor })(request))
    .rejects.toThrow(/process died/);
  expect(journal).toHaveLength(1);
  demosSdk.getTxByHash.mockClear();
  demosSdk.nodeCall.mockClear();
}

const expectPublicSuccess = (result: Awaited<ReturnType<ReturnType<typeof payDemSettle>>>) => {
  expect(result).toMatchObject({ ok: true, txHash: journal[0]?.txHash, blockNumber: BLOCK, payee: PAYEE });
  expect(result).not.toHaveProperty("execution");
  expect(result).not.toHaveProperty("amountOs");
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.finality)).toBe(true);
};

describe("a retained pay-dem success is bound to the journal record and a fresh node read", () => {
  it("reports a retained success when the journal record and a fresh node read agree, without signing or sending", async () => {
    const request = requestFor("bound-success");
    await payAndLoseOutcome(request);
    const { bridge, effects } = await restartedBridge();

    const result = await bridge(auditOf(request));
    expectPublicSuccess(result);
    expect(demosSdk.nodeCall).toHaveBeenCalledWith("getTransactionStatus", { hash: journal[0]?.txHash });
    expect(demosSdk.getTxByHash).toHaveBeenCalledWith(journal[0]?.txHash);
    expect(effects()).toEqual(NO_NEW_EFFECTS);
  });

  it("reports the same retained success after a restart that rebuilds the rail, the bridge and the store", async () => {
    const request = requestFor("bound-restart");
    await payAndLoseOutcome(request);
    const recipe = async (restartNumber: number) => {
      const { bridge, effects } = await restartedBridge({ restartNumber });
      const recoverSettlement = withRecoveredAttempts(bridge, async (req) =>
        (await journalFor(keyOf(req))).map((prepared) => ({ txHash: prepared.txHash, chainId: "demos", ok: false })));
      const result = await recoverSettlement({ ...request, recoveryOnly: true });
      expect(effects()).toEqual(NO_NEW_EFFECTS);
      return result;
    };

    const first = await recipe(1);
    expectPublicSuccess(first);
    const reads = demosSdk.getTxByHash.mock.calls.length;
    expect(reads).toBeGreaterThan(0);
    await expect(recipe(2)).resolves.toEqual(first);
    expect(demosSdk.getTxByHash.mock.calls.length).toBeGreaterThan(reads);
  });

  const entry = () => journal[0] as PayDemPreparedTransfer;
  const recovery = () => entry().recovery as PayDemSettlementRecoveryContext;
  const withoutKey = <T extends object>(value: T, key: keyof T) => {
    const copy = { ...value };
    delete copy[key];
    return copy;
  };
  it.each([
    { case: "no entry", read: () => [], error: /no prepared-transfer record for the retained transaction/ },
    { case: "an entry for another job", read: () => [{ ...entry(), recovery: {
      ...recovery(), jobId: "other-job", settlementKey: settlementKey("pay-dem", "other-job", 0) } }],
    error: /does not bind this job's recovery context/ },
    { case: "an entry for another hash", read: () => [{ ...entry(), txHash: hashOf(99) }],
      error: /no prepared-transfer record for the retained transaction/ },
    { case: "an entry with another payee", read: () => [{ ...entry(), payee: "ee".repeat(32) }],
      error: /does not bind the requested payer, payee and amount/ },
    { case: "an entry with another amount", read: () => [{ ...entry(), amountOs: "2000000000" }],
      error: /does not bind the requested payer, payee and amount/ },
    { case: "an entry with another nonce", read: () => [{ ...entry(), nonce: NONCE + 1 }],
      error: /not confirmed by the node: transaction record does not bind the signed nonce/ },
    { case: "an entry with a negative nonce", read: () => [{ ...entry(), nonce: -1 }], error: /has no valid nonce/ },
    { case: "an entry with a non-integer nonce", read: () => [{ ...entry(), nonce: 7.5 }], error: /has no valid nonce/ },
    { case: "an entry without denomination", read: () => [withoutKey(entry(), "denomination")],
      error: /has no valid denomination/ },
    { case: "an entry with an extra field", read: () => [{ ...entry(), extra: "field" }], error: /has unknown fields/ },
    { case: "an entry with no recovery", read: () => [withoutKey(entry(), "recovery")],
      error: /does not bind this job's recovery context/ },
    { case: "an entry whose recovery differs from the context in one field",
      read: () => [{ ...entry(), recovery: { ...recovery(), network: "demos:other" } }],
      error: /does not bind this job's recovery context/ },
    { case: "an entry whose recovery carries an extra key",
      read: () => [{ ...entry(), recovery: { ...recovery(), extra: "key" } }],
      error: /does not bind this job's recovery context/ },
    { case: "an entry whose recovery carries a txHash",
      read: () => [{ ...entry(), recovery: { ...recovery(), txHash: entry().txHash } }],
      error: /does not bind this job's recovery context/ },
    { case: "two entries for the hash that differ",
      read: () => [entry(), { ...entry(), maxTotalDebitOs: "5000000000" }], error: /conflicting prepared-transfer records/ },
  ])("withholds a retained success when the journal has $case", async ({ read, error }) => {
    const request = requestFor("journal-refusal");
    await payAndLoseOutcome(request);
    const readPreparedTransfers = vi.fn(async () => read() as PayDemPreparedTransfer[]);
    const { bridge, effects } = await restartedBridge({ reconcile: reconcileWithoutReading, readPreparedTransfers });

    await expect(bridge(auditOf(request))).rejects.toThrow(error);
    expect(readPreparedTransfers).toHaveBeenCalledWith(keyOf(request));
    expect(reconcileWithoutReading).toHaveBeenCalledTimes(1);
    expect(effects()).toEqual(NO_NEW_EFFECTS);
  });

  const alterRecord = (change: (record: NodeRecord) => void) => () => {
    const record = node.get(journal[0]?.txHash ?? "");
    if (record === undefined) throw new Error("the payment left no node record");
    change(record);
  };
  const statusIncluded = () => {
    demosSdk.nodeCall.mockImplementation(async (_message: string, args: { hash: string }) =>
      ({ state: "included", blockNumber: node.get(args.hash)?.blockNumber ?? BLOCK }));
  };
  it.each([
    { case: "pending", alter: alterRecord((record) => { record.status = "pending"; }),
      error: /not confirmed by the node: transaction record has no terminal execution status/ },
    { case: "failed", alter: alterRecord((record) => { record.status = "failed"; }),
      error: /node record for the retained transaction is failed, but reconciliation reported success/ },
    { case: "carrying another nonce", alter: alterRecord((record) => {
      record.transaction = { ...record.transaction, content: {
        ...(record.transaction.content as Record<string, unknown>), nonce: NONCE + 1 } };
    }), error: /not confirmed by the node: transaction record does not bind the signed nonce/ },
    { case: "carrying another block", alter: alterRecord((record) => { record.blockNumber = BLOCK + 1; }),
      error: /node record block differs from the reconciled block/ },
    { case: "missing", alter: () => { node.clear(); },
      error: /not confirmed by the node: transaction record is missing or malformed/ },
    { case: "unreadable", alter: () => {
      demosSdk.getTxByHash.mockRejectedValue(new Error("record read refused"));
    }, error: /not confirmed by the node: transaction record read failed/ },
  ])("withholds a retained success when the node record is $case", async ({ alter, error }) => {
    const request = requestFor("node-refusal");
    await payAndLoseOutcome(request);
    alter();
    statusIncluded();
    const { bridge, effects } = await restartedBridge({ reconcile: reconcileWithoutReading, timing: SHORT_READS });

    await expect(bridge(auditOf(request))).rejects.toThrow(error);
    expect(demosSdk.nodeCall).toHaveBeenCalled();
    expect(demosSdk.getTxByHash).toHaveBeenCalledWith(journal[0]?.txHash);
    expect(effects()).toEqual(NO_NEW_EFFECTS);
  });

  it.each([
    { case: "failed", status: { state: "failed" },
      error: /node record for the retained transaction is failed, but reconciliation reported success/ },
    { case: "not found", status: { state: "not_found" },
      error: /not confirmed by the node: inclusion was not observed/ },
  ])("withholds a retained success when the node status index reports $case", async ({ status, error }) => {
    const request = requestFor("status-refusal");
    await payAndLoseOutcome(request);
    demosSdk.nodeCall.mockResolvedValue(status);
    const { bridge, effects } = await restartedBridge({ reconcile: reconcileWithoutReading, timing: SHORT_READS });

    await expect(bridge(auditOf(request))).rejects.toThrow(error);
    expect(demosSdk.nodeCall).toHaveBeenCalledWith("getTransactionStatus", { hash: journal[0]?.txHash });
    expect(demosSdk.getTxByHash).not.toHaveBeenCalled();
    expect(effects()).toEqual(NO_NEW_EFFECTS);
  });

  it("does not take the binding from the history, the reconciler or the settlement store", async () => {
    const request = requestFor("binding-sources");
    const rail = await buildRail();
    const store = createIdempotencyStore(log, { now: () => CRASH_AT, leaseDurationMs: LEASE_MS });
    await expect(payDemSettle(rail, {}, { store, reconcile: reconcileFromJournalAndNode })(request))
      .resolves.toMatchObject({ ok: true });
    const recorded = await store.readOutcome!(keyOf(request), {
      bindingVersion: "1", railId: "pay-dem", jobId: request.jobId, phaseIndex: 0, phase: "pay-dem",
      amount: AMOUNT_OS, agreementAsset: "DEM", settlementAsset: "DEM", payer: PAYER.slice(2), payee: PAYEE.slice(2),
      network: "demos", finality: { model: "bft-final" },
    });
    expect(recorded).toMatchObject({ ok: true, txHash: journal[0]?.txHash });

    const readPreparedTransfers = vi.fn(async () => []);
    const { bridge, effects } = await restartedBridge({ reconcile: reconcileWithoutReading, readPreparedTransfers });
    await expect(bridge(auditOf(request, true))).rejects.toThrow(/no prepared-transfer record for the retained transaction/);
    expect(reconcileWithoutReading).toHaveBeenCalledTimes(1);
    expect(effects()).toEqual(NO_NEW_EFFECTS);
  });

  it("withholds a retained success when the bridge was built without a prepared-transfer reader", async () => {
    const request = requestFor("no-reader");
    await payAndLoseOutcome(request);
    const { bridge, effects } = await restartedBridge({ readPreparedTransfers: null });

    await expect(bridge(auditOf(request))).rejects.toThrow(
      "pay-dem retained success cannot be confirmed without a prepared-transfer reader");
    expect(effects()).toEqual(NO_NEW_EFFECTS);
  });

  it("withholds a retained success when the rail has no node-record reader", async () => {
    const request = requestFor("no-rail-reader");
    await payAndLoseOutcome(request);
    const fakeSettle = vi.fn<PayDemRail["settle"]>();
    const fakeRail: PayDemRail = { address: PAYER, settle: fakeSettle };
    admittedFakeRails.add(fakeRail);
    const { bridge, effects } = await restartedBridge({ rail: fakeRail });

    const refused = bridge(auditOf(request));
    await expect(refused).rejects.toThrow(
      "pay-dem retained success cannot be confirmed without a node-record reader on the rail");
    await expect(refused).rejects.not.toBeInstanceOf(TypeError);
    expect(fakeSettle).not.toHaveBeenCalled();
    expect(effects()).toEqual(NO_NEW_EFFECTS);
  });

  const cause = new Error("journal read refused");
  it.each([
    { case: "the reader rejects", read: async () => { throw cause; }, error: cause },
    { case: "the reply is not an array", read: async () => ({ length: 1, 0: journal[0] }),
      error: /prepared-transfer read must be an array of at most 256 entries/ },
    { case: "a proxy array", read: async () => new Proxy([...journal], {}),
      error: /prepared-transfer read must be an array of at most 256 entries/ },
    { case: "257 entries", read: async () => Array.from({ length: 257 }, () => journal[0]),
      error: /prepared-transfer read must be an array of at most 256 entries/ },
    { case: "an entry that is not a plain object", read: async () => [new Map([["txHash", journal[0]?.txHash]])],
      error: /prepared-transfer read is not stable canonical JSON/ },
  ])("refuses a malformed journal read: $case", async ({ read, error }) => {
    const request = requestFor("malformed-read");
    await payAndLoseOutcome(request);
    const { bridge, effects } = await restartedBridge({
      reconcile: reconcileWithoutReading, readPreparedTransfers: read as unknown as ReadPreparedTransfers,
    });

    const refused = expect(bridge(auditOf(request))).rejects;
    if (error instanceof Error) await refused.toBe(error);
    else await refused.toThrow(error);
    expect(demosSdk.getTxByHash).not.toHaveBeenCalled();
    expect(effects()).toEqual(NO_NEW_EFFECTS);
  });

  it("keeps withholding a retained success on a repeat call that omits history", async () => {
    const request = requestFor("repeat-without-history");
    await payAndLoseOutcome(request);
    const readPreparedTransfers = vi.fn(async () => []);
    const { bridge, effects } = await restartedBridge({ reconcile: reconcileWithoutReading, readPreparedTransfers });

    await expect(bridge(auditOf(request))).rejects.toThrow(/no prepared-transfer record/);
    await expect(bridge({ ...request, recoveryOnly: true })).rejects.toThrow(/no prepared-transfer record/);
    await expect(bridge(request)).rejects.toThrow(/no prepared-transfer record/);
    expect(readPreparedTransfers).toHaveBeenCalledTimes(3);
    expect(effects()).toEqual(NO_NEW_EFFECTS);
  });

  it("two concurrent retained audits for one job read the journal and the node once each in turn and neither sends", async () => {
    const request = requestFor("concurrent-audits");
    await payAndLoseOutcome(request);
    const reads: string[] = [];
    const readPreparedTransfers = vi.fn(async (key: string) => {
      reads.push("journal");
      return journalFor(key);
    });
    const { bridge, effects } = await restartedBridge({ readPreparedTransfers });
    const readNode = demosSdk.getTxByHash.getMockImplementation();
    demosSdk.getTxByHash.mockImplementation(async (hash: string) => {
      reads.push("node");
      return readNode?.(hash);
    });

    const [first, second] = await Promise.all([bridge(auditOf(request)), bridge(auditOf(request))]);
    expect(second).toEqual(first);
    expectPublicSuccess(first);
    expect(reads).toEqual(["journal", "node", "journal", "node"]);
    expect(effects()).toEqual(NO_NEW_EFFECTS);
  });

  it("refuses a prepared-transfer reader that is an accessor or a proxy at construction, and calls the captured reader after the source method is replaced", async () => {
    const request = requestFor("captured-reader");
    await payAndLoseOutcome(request);
    const rail = await buildRail();
    const store = createIdempotencyStore(log, { now: () => CRASH_AT + 2 * LEASE_MS, leaseDurationMs: LEASE_MS });
    const getter = vi.fn(() => journalFor);
    const accessorOptions = { store, reconcile: reconcileFromJournalAndNode };
    Object.defineProperty(accessorOptions, "readPreparedTransfers", { enumerable: true, get: getter });
    expect(() => payDemSettle(rail, {}, accessorOptions)).toThrow("pay-dem prepared-transfer reader must be stable data");
    expect(getter).not.toHaveBeenCalled();
    expect(() => payDemSettle(rail, {}, {
      store, reconcile: reconcileFromJournalAndNode, readPreparedTransfers: new Proxy(journalFor, {}),
    })).toThrow("pay-dem prepared-transfer reader must be a stable method");

    const captured = vi.fn(journalFor);
    const replacement = vi.fn(async () => { throw new Error("the replaced reader must not be called"); });
    const options: { store: typeof store; reconcile: typeof reconcileFromJournalAndNode; readPreparedTransfers: ReadPreparedTransfers } =
      { store, reconcile: reconcileFromJournalAndNode, readPreparedTransfers: captured };
    const bridge = payDemSettle(rail, {}, options);
    options.readPreparedTransfers = replacement;

    expectPublicSuccess(await bridge(auditOf(request)));
    expect(captured).toHaveBeenCalledWith(keyOf(request));
    expect(replacement).not.toHaveBeenCalled();
  });
});
