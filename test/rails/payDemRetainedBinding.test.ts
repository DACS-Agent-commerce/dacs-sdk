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
  type PayDemSettlementReconcile,
  type PayDemSettlementRecoveryContext,
} from "../../src/rails/payDem.js";
import type { SettleRequest, SettleResult } from "../../src/rails/settlementTypes.js";
import { nativeSendEdits, type NativeSendEdit } from "../support/payDemEdits.js";

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
// The fee the confirmation declares; when set, the confirmation also carries
// the send's edits, so the rail journals a confirmed debit and declared fee.
let confirmedFee: Record<string, string> | undefined;
// Changes the balance edits the node's record of a send shows.
let editRecord: (edits: NativeSendEdit[]) => NativeSendEdit[];
let rpcCounter = 0;

const hashOf = (ordinal: number) => ordinal.toString(16).padStart(2, "0").repeat(32);
const sendEdits = (content: Record<string, unknown>) =>
  nativeSendEdits({ payer: String(content.from), payee: String(content.to), amount: String(content.amount) });

beforeEach(() => {
  vi.clearAllMocks();
  node = new Map();
  journal = [];
  log = createInMemorySettlementLog();
  signed = 0;
  broadcastCalls = 0;
  confirmedFee = undefined;
  editRecord = (edits) => edits;
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
    response: { data: { transaction: { hash: input.hash, content: confirmedFee === undefined ? input.content : {
      ...input.content, transaction_fee: confirmedFee, gcr_edits: sendEdits(input.content),
    } } } },
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
      content: { ...content, nonce: String(content.nonce), gcr_edits: editRecord(sendEdits(content)) },
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

interface RailOptions {
  timing?: Partial<typeof SHORT_READS> & { nonceVisibilityTimeoutMs?: number };
  network?: string;
  maxTotalDebitOs?: bigint;
  journaled?: boolean;
}

async function buildRail(options: RailOptions = {}) {
  return createPayDemRail({
    rpc: `https://retained-binding-${rpcCounter}.test`,
    secret: "test-secret",
    ...options.timing,
    ...(options.network === undefined ? {} : { network: options.network }),
    ...(options.maxTotalDebitOs === undefined ? {} : { maxTotalDebitOs: options.maxTotalDebitOs }),
    ...(options.journaled === false ? {} : {
      journalPreparedTransfer: async (prepared: Readonly<PayDemPreparedTransfer>) => { journal.push(prepared); },
    }),
  });
}

interface AuditOptions {
  rail?: PayDemRail;
  reconcile?: PayDemSettlementReconcile;
  readPreparedTransfers?: ReadPreparedTransfers | null;
  timing?: Partial<typeof SHORT_READS>;
  restartNumber?: number;
  network?: string;
  allowUnjournaled?: boolean;
}

/** A restarted process: a new rail, store and bridge over the surviving log, journal and node. */
async function restartedBridge(options: AuditOptions = {}) {
  const rail = options.rail ?? await buildRail({ timing: options.timing });
  const claimIntent = vi.spyOn(log, "claimIntent");
  const putOutcome = vi.spyOn(log, "putOutcome");
  const store = createIdempotencyStore(log, {
    now: () => CRASH_AT + (options.restartNumber ?? 1) * 2 * LEASE_MS, leaseDurationMs: LEASE_MS,
  });
  const once = vi.spyOn(store, "once");
  const readPreparedTransfers = options.readPreparedTransfers === undefined
    ? vi.fn(journalFor)
    : options.readPreparedTransfers;
  const bridge = payDemSettle(rail, options.network === undefined ? {} : { network: options.network }, {
    store,
    reconcile: options.reconcile ?? reconcileFromJournalAndNode,
    ...(readPreparedTransfers === null ? {} : { readPreparedTransfers }),
    ...(options.allowUnjournaled === true ? { allowUnjournaled: true } : {}),
  });
  const effects = () => ({
    claims: claimIntent.mock.calls.length, outcomes: putOutcome.mock.calls.length,
    onces: once.mock.calls.length, signed, broadcastCalls,
  });
  return { bridge, effects, readPreparedTransfers };
}

const NO_NEW_EFFECTS = { claims: 0, outcomes: 0, onces: 0, signed: 1, broadcastCalls: 1 };

/** Pay once through the real rail; the process dies before the outcome is recorded. */
async function payAndLoseOutcome(request: SettleRequest, railOptions: RailOptions = {}) {
  const rail = await buildRail(railOptions);
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

/** The status index reports every stored record as included, failed ones too, as the node does. */
const statusIncluded = () => {
  demosSdk.nodeCall.mockImplementation(async (_message: string, args: { hash: string }) =>
    ({ state: "included", blockNumber: node.get(args.hash)?.blockNumber ?? BLOCK }));
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

  it("keeps a payment journaled but never broadcast unfinished after a restart, even when reconciliation reports a success", async () => {
    const request = requestFor("journaled-unsent");
    const rail = await createPayDemRail({
      rpc: `https://retained-binding-${rpcCounter}.test`,
      secret: "test-secret",
      journalPreparedTransfer: async (prepared: Readonly<PayDemPreparedTransfer>) => {
        journal.push(prepared);
        throw new Error("process died before broadcast");
      },
    });
    const store = createIdempotencyStore(log, { now: () => CRASH_AT, leaseDurationMs: LEASE_MS });
    await expect(payDemSettle(rail, {}, { store, reconcile: reconcileFromJournalAndNode, readPreparedTransfers: journalFor })(request))
      .rejects.toThrow(/process died before broadcast/);
    expect(journal).toHaveLength(1);

    const recipe = await restartedBridge();
    await expect(recipe.bridge(auditOf(request))).rejects.toThrow(/proof of absence/);
    const misreporting = await restartedBridge({ reconcile: reconcileWithoutReading, timing: SHORT_READS, restartNumber: 2 });
    await expect(misreporting.bridge(auditOf(request))).rejects.toThrow(/not confirmed by the node: inclusion was not observed/);
    expect(misreporting.effects()).toEqual({ claims: 0, outcomes: 0, onces: 0, signed: 1, broadcastCalls: 0 });
    expect(node.size).toBe(0);
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

// The confirmation declares network + rpc fees of 2 DEM; the node's edits
// remove the amount and a 1 DEM gas burn unless a test changes the burn.
const DECLARED_FEE = { network_fee: "1000000000", rpc_fee: "1000000000", additional_fee: "0" };
const FEES = { networkFeeOs: "1000000000", recordFeeOs: "2000000000" };
const withGas = (gas: string) => (edits: NativeSendEdit[]) =>
  edits.map((edit, index) => (index === 2 ? { ...edit, amount: gas } : edit));
const withoutPayerDebit = (edits: NativeSendEdit[]) => edits.filter((edit) => edit.operation !== "remove");
const NO_PAYER_DEBIT = "the confirmed record's balance edits do not show the payer's debit";
const settleDirect = (rail: PayDemRail, maxTotalDebitOs?: string) =>
  rail.settle({ recipient: PAYEE.slice(2), amount: AMOUNT_OS, ...(maxTotalDebitOs === undefined ? {} : { maxTotalDebitOs }) });
const reconcileReporting = (fees: { networkFeeOs?: string; recordFeeOs?: string }) =>
  vi.fn<PayDemSettlementReconcile>(async (context) => ({ ...(await reconcileWithoutReading(context)), ...fees }));
const readsOfNode = () => demosSdk.getTxByHash.mock.calls.length;

const proofOf = (result: SettleResult) => {
  if (result.failureProof === undefined) throw new Error("the result carries no failure proof");
  return result.failureProof;
};
/** A reconciler's reply agreeing with a permanent failure the rail reported. */
const failureReply = (failure: SettleResult) => ({
  ...failure, ok: false as const, errorClass: "permanent" as const, failureProof: { ...proofOf(failure) }, amountOs: AMOUNT_OS,
});
/** The node records every later send as failed while its status index reports it included. */
const recordFailedSends = () => {
  demosSdk.broadcast.mockImplementation(async (validity: {
    response: { data: { transaction: { hash: string; content: Record<string, unknown> } } };
  }) => {
    broadcastCalls += 1;
    const { transaction } = validity.response.data;
    node.set(transaction.hash, { status: "failed", transaction, blockNumber: BLOCK });
    return { response: { hash: transaction.hash } };
  });
  statusIncluded();
};
/** Checks the returned proof is frozen, then tries a silent edit a caller could make. */
const expectFrozenProof = (result: SettleResult) => {
  const proof = proofOf(result);
  expect(Object.isFrozen(proof)).toBe(true);
  expect(() => Object.assign(proof, { amountOs: "1" })).toThrow(TypeError);
  Reflect.set(proof, "blockNumber", BLOCK + 1);
};
const outcomeOf = (request: SettleRequest) =>
  createIdempotencyStore(log, { now: () => CRASH_AT, leaseDurationMs: LEASE_MS }).readOutcome!(keyOf(request), {
    bindingVersion: "1", railId: "pay-dem", jobId: request.jobId, phaseIndex: 0, phase: "pay-dem",
    amount: AMOUNT_OS, agreementAsset: "DEM", settlementAsset: "DEM", payer: PAYER.slice(2), payee: PAYEE.slice(2),
    network: "demos", finality: { model: "bft-final" },
  });

describe("a remembered pay-dem success is checked again before it is repeated", () => {
  it("a repeated settlement reads the job's record and the node again before it repeats a success", async () => {
    const reconcile = vi.fn<PayDemSettlementReconcile>(reconcileFromJournalAndNode);
    const withReader = await restartedBridge({ reconcile, timing: SHORT_READS });
    const withoutReader = await restartedBridge({ readPreparedTransfers: null });
    const unjournaled = await restartedBridge({
      rail: await buildRail({ journaled: false }), readPreparedTransfers: null, allowUnjournaled: true,
    });
    const request = requestFor("repeat-with-reader");

    // A fresh payment is never checked again, whatever readers the bridge has.
    const first = await withReader.bridge(request);
    expect(first).toMatchObject({ ok: true });
    for (const [arm, jobId] of [[withoutReader, "repeat-no-reader"], [unjournaled, "repeat-unjournaled"]] as const) {
      const reads = readsOfNode();
      await expect(arm.bridge(requestFor(jobId))).resolves.toMatchObject({ ok: true });
      expect(readsOfNode()).toBe(reads + 1);
    }
    expect(withReader.readPreparedTransfers).not.toHaveBeenCalled();
    expect(readsOfNode()).toBe(3);

    await expect(withReader.bridge(request)).resolves.toEqual(first);
    expect(withReader.readPreparedTransfers).toHaveBeenCalledTimes(1);
    expect(readsOfNode()).toBe(4);

    const readNode = demosSdk.getTxByHash.getMockImplementation();
    if (readNode === undefined) throw new Error("the node stand-in has no record reader");
    demosSdk.getTxByHash.mockRejectedValue(new Error("record read refused"));
    await expect(withReader.bridge(request)).rejects.toThrow(/not confirmed by the node: transaction record read failed/);
    // The remembered success is kept: the next repeat checks it again without reconciling.
    demosSdk.getTxByHash.mockImplementation(readNode);
    await expect(withReader.bridge(request)).resolves.toEqual(first);
    expect(reconcile).not.toHaveBeenCalled();
    expect({ signed, broadcastCalls }).toEqual({ signed: 3, broadcastCalls: 3 });
  });

  it("two calls for one new payment on one bridge send once, and the second repeats the success only after checking it", async () => {
    const { bridge, effects, readPreparedTransfers } = await restartedBridge();
    const request = requestFor("two-callers");

    const [first, second] = await Promise.all([bridge(request), bridge(request)]);
    expect(first).toMatchObject({ ok: true });
    expect(second).toEqual(first);
    expect(readPreparedTransfers).toHaveBeenCalledTimes(1);
    expect(readsOfNode()).toBe(2);
    expect(effects()).toMatchObject({ signed: 1, broadcastCalls: 1 });
  });

  it("a repeated settlement on a bridge with no reader does not repeat a success unchecked", async () => {
    const reconcile = vi.fn<PayDemSettlementReconcile>(reconcileFromJournalAndNode);
    const { bridge, effects } = await restartedBridge({ reconcile, readPreparedTransfers: null });
    const request = requestFor("repeat-without-reader");

    await expect(bridge(request)).resolves.toMatchObject({ ok: true });
    for (let repeat = 0; repeat < 2; repeat += 1) {
      await expect(bridge(request)).rejects.toThrow(
        "pay-dem retained success cannot be confirmed without a prepared-transfer reader");
    }
    // Neither repeat dropped the remembered success, so neither reconciled.
    expect(reconcile).not.toHaveBeenCalled();
    expect(effects()).toMatchObject({ outcomes: 1, signed: 1, broadcastCalls: 1 });
  });
});

describe("authenticated pay-dem fees and labels are kept", () => {
  it("an audit keeps the fee the rail authenticated when the reconciler omits it", async () => {
    confirmedFee = DECLARED_FEE;
    const reconcile = vi.fn<PayDemSettlementReconcile>(reconcileFromJournalAndNode);
    const { bridge, effects } = await restartedBridge({ reconcile });
    const request = requestFor("audit-fees");

    const first = await bridge(request);
    expect(first).toMatchObject({ ok: true, ...FEES });
    expect(journal[0]).toMatchObject({ confirmedTotalDebitOs: "2000000000", confirmedRecordFeeOs: "2000000000" });
    await expect(bridge(auditOf(request))).resolves.toEqual(first);

    reconcile.mockImplementationOnce(async (context) => {
      const reply = await reconcileFromJournalAndNode(context);
      return reply === null ? null : { ...reply, networkFeeOs: "5" };
    });
    await expect(bridge(auditOf(request))).rejects.toThrow("pay-dem: the reported fee differs from the debit the node record shows");
    await expect(bridge(auditOf(request))).resolves.toEqual(first);
    expect(effects()).toMatchObject({ signed: 1, broadcastCalls: 1 });
  });

  it("the journalled transfer carries the payment's network label", async () => {
    const labelled = await restartedBridge({ rail: await buildRail({ network: "TEST-A" }), network: "TEST-B" });
    await expect(labelled.bridge(requestFor("label-differs"))).resolves.toMatchObject({ ok: true, chainId: "TEST-B" });
    expect(journal[0]).toMatchObject({ network: "TEST-B", recovery: { network: "TEST-B" } });

    const defaults = await restartedBridge();
    await expect(defaults.bridge(requestFor("label-default"))).resolves.toMatchObject({ ok: true, chainId: "demos" });
    expect(journal[1]).toMatchObject({ network: "demos", recovery: { network: "demos" } });

    // With no recovery context the rail's own label is what it has.
    await expect(settleDirect(await buildRail({ network: "TEST-A" }))).resolves.toMatchObject({ ok: true });
    expect(journal[2]?.network).toBe("TEST-A");
    expect(journal[2]).not.toHaveProperty("recovery");
  });

  it("a returned failure proof cannot change the retained outcome after an audit", async () => {
    recordFailedSends();
    const reconcile = vi.fn<PayDemSettlementReconcile>();
    const { bridge, effects } = await restartedBridge({ reconcile });
    const request = requestFor("proof-audit");
    const first = await bridge(request);
    expect(first).toMatchObject({ ok: false, errorClass: "permanent" });
    reconcile.mockImplementation(async () => failureReply(first));

    const audited = await bridge(auditOf(request, false));
    expect(audited).toEqual(first);
    expectFrozenProof(audited);
    await expect(bridge(auditOf(request, false))).resolves.toEqual(first);
    expect(effects()).toMatchObject({ signed: 1, broadcastCalls: 1 });
  });

  it("a returned failure proof cannot change the retained outcome after a restart", async () => {
    recordFailedSends();
    const reconcile = vi.fn<PayDemSettlementReconcile>();
    const request = requestFor("proof-restart");
    const first = await (await restartedBridge({ reconcile })).bridge(request);
    expect(first).toMatchObject({ ok: false, errorClass: "permanent" });
    reconcile.mockImplementation(async () => failureReply(first));

    const { bridge, effects } = await restartedBridge({ reconcile, restartNumber: 2 });
    const restarted = await bridge(request);
    expect(restarted).toEqual(first);
    expectFrozenProof(restarted);
    await expect(bridge(request)).resolves.toEqual(first);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(effects()).toMatchObject({ signed: 1, broadcastCalls: 1 });
  });
});

describe("a live pay-dem settlement needs the payer's debit in the node's record", () => {
  it("a confirmed record whose balance edits show no debit is not a settlement", async () => {
    confirmedFee = DECLARED_FEE;
    editRecord = withoutPayerDebit;
    const rail = await buildRail();

    const held = await settleDirect(rail);
    expect(held).toMatchObject({ ok: false, message: `pay-dem execution was not established: ${NO_PAYER_DEBIT}` });
    expect(held).not.toHaveProperty("execution");
    expect(broadcastCalls).toBe(1);

    editRecord = (edits) => edits;
    const settled = await settleDirect(rail);
    expect(settled).toMatchObject({ ok: true, execution: "executed", ...FEES });
    expect(settled).not.toHaveProperty("message");
    expect(broadcastCalls).toBe(2);
  });

  it("a confirmed record with no payer debit is not recorded as a settlement through the bridge", async () => {
    editRecord = withoutPayerDebit;
    const { bridge, effects } = await restartedBridge();
    const request = requestFor("bridge-no-debit");

    const held = await bridge(request);
    expect(held).toMatchObject({ ok: false });
    expect(held).not.toHaveProperty("finality");
    expect(await outcomeOf(request)).not.toMatchObject({ ok: true });
    expect(effects()).toMatchObject({ signed: 1, broadcastCalls: 1 });
  });

  it("a payment with no fee read before the broadcast settles with the debit the node record shows", async () => {
    const settled = await settleDirect(await buildRail());
    expect(settled).toMatchObject({ ok: true, execution: "executed", networkFeeOs: FEES.networkFeeOs });
    expect(settled).not.toHaveProperty("recordFeeOs");
  });

  it("a node debit that differs from the confirmed one within the maximum settles with the node's figure and names both", async () => {
    confirmedFee = DECLARED_FEE;
    editRecord = withGas("1500000000");
    const differing = "pay-dem: settled with the executed debit 2500000000 OS; the debit confirmed before the broadcast was 2000000000 OS";

    const settled = await settleDirect(await buildRail({ maxTotalDebitOs: 3000000000n }));
    expect(settled).toMatchObject({ ok: true, networkFeeOs: "1500000000", recordFeeOs: "2000000000", message: differing });

    demosSdk.waitForNonce.mockImplementationOnce(() => new Promise(() => undefined));
    const lateNonce = await settleDirect(
      await buildRail({ maxTotalDebitOs: 3000000000n, timing: { nonceVisibilityTimeoutMs: 5 } }));
    expect(lateNonce.message).toBe(`${differing}; pay-dem: account nonce read did not reach ${NONCE + 1} ` +
      "before nonceVisibilityTimeoutMs; payment is final");
  });

  it("a node debit above the maximum is not settled, names every figure and keeps the executed nonce", async () => {
    confirmedFee = DECLARED_FEE;
    editRecord = withGas("2000000000");
    demosSdk.waitForNonce.mockImplementationOnce(() => new Promise(() => undefined));
    const rail = await buildRail({ maxTotalDebitOs: 2500000000n, timing: { nonceVisibilityTimeoutMs: 5 } });

    const held = await settleDirect(rail);
    expect(held).toEqual({
      ok: false, txHash: hashOf(1), chainId: "demos", payer: PAYER, payee: PAYEE.slice(2),
      message: "pay-dem execution was not established: the executed debit 3000000000 OS exceeds the authorised " +
        "maximum 2500000000 OS; the debit confirmed before the broadcast was 2000000000 OS",
    });
    expect(broadcastCalls).toBe(1);

    // The transfer executed, so the payer's next payment first waits for its nonce.
    demosSdk.waitForNonce.mockClear();
    editRecord = (edits) => edits;
    await expect(settleDirect(rail)).resolves.toMatchObject({ ok: true });
    expect(demosSdk.waitForNonce.mock.calls[0]).toEqual([PAYER, NONCE]);
    expect(broadcastCalls).toBe(2);
  });

  it("through the bridge a differing debit within the maximum settles with no message and one above it stays unresolved", async () => {
    confirmedFee = DECLARED_FEE;
    const { bridge, effects } = await restartedBridge({ rail: await buildRail({ maxTotalDebitOs: 2600000000n }) });

    editRecord = withGas("1500000000");
    const settled = await bridge(requestFor("bridge-within"));
    expect(settled).toMatchObject({ ok: true, networkFeeOs: "1500000000", recordFeeOs: "2000000000" });
    expect(settled).not.toHaveProperty("message");

    editRecord = withGas("2000000000");
    const above = requestFor("bridge-above");
    const held = await bridge(above);
    expect(held).toMatchObject({ ok: false });
    expect(held).not.toHaveProperty("message");
    expect(await outcomeOf(above)).not.toMatchObject({ ok: true });
    expect(effects()).toMatchObject({ signed: 2, broadcastCalls: 2 });
  });
});

describe("a recovered pay-dem success needs the node record's debit", () => {
  const ABOVE_MAXIMUM = "pay-dem: the executed debit 3500000000 OS exceeds the authorised maximum 3000000000 OS; " +
    "the debit confirmed before the broadcast was 2000000000 OS; the payment stays unresolved";
  const payWithConfirmedFee = async (request: SettleRequest) => {
    confirmedFee = DECLARED_FEE;
    await payAndLoseOutcome(request, { maxTotalDebitOs: 3000000000n });
  };

  it("a recovered success needs the node record's debit, within the authorised maximum", async () => {
    const request = requestFor("recovered-debit");
    await payWithConfirmedFee(request);

    editRecord = withoutPayerDebit;
    const noDebit = await restartedBridge({ reconcile: reconcileWithoutReading });
    await expect(noDebit.bridge(auditOf(request))).rejects.toThrow(
      `pay-dem retained success is not confirmed by the node: ${NO_PAYER_DEBIT}`);
    expect(noDebit.effects()).toEqual(NO_NEW_EFFECTS);

    editRecord = withGas("1500000000");
    const within = await (await restartedBridge({ reconcile: reconcileWithoutReading, restartNumber: 2 })).bridge(auditOf(request));
    expectPublicSuccess(within);
    expect(within).toMatchObject({ networkFeeOs: "1500000000", recordFeeOs: "2000000000" });
    expect(within).not.toHaveProperty("message");
    expect(journal[0]).toMatchObject({ maxTotalDebitOs: "3000000000", confirmedTotalDebitOs: "2000000000" });

    editRecord = withGas("2500000000");
    for (const restartNumber of [3, 4]) {
      const above = await restartedBridge({ reconcile: reconcileWithoutReading, restartNumber });
      await expect(above.bridge(auditOf(request))).rejects.toThrow(ABOVE_MAXIMUM);
      expect(above.effects()).toEqual(NO_NEW_EFFECTS);
    }

    editRecord = (edits) => edits;
    const equal = await (await restartedBridge({ reconcile: reconcileWithoutReading, restartNumber: 5 })).bridge(auditOf(request));
    expect(equal).toMatchObject({ ok: true, ...FEES });
  });

  it("a recovered success checks the fees a reconciler reports against the node's debit and the journalled fee", async () => {
    const request = requestFor("recovered-fees");
    await payWithConfirmedFee(request);
    let restartNumber = 0;
    const freshBridge = async (fees: { networkFeeOs?: string; recordFeeOs?: string }) =>
      (await restartedBridge({ reconcile: reconcileReporting(fees), restartNumber: ++restartNumber })).bridge;

    await expect((await freshBridge({ networkFeeOs: "5" }))(auditOf(request))).rejects.toThrow(
      "pay-dem: the reported fee differs from the debit the node record shows");
    await expect((await freshBridge({ networkFeeOs: FEES.networkFeeOs, recordFeeOs: "7" }))(auditOf(request))).rejects.toThrow(
      "pay-dem: the reported declared fee differs from the one journalled with the prepared transfer");
    for (const fees of [{}, { networkFeeOs: FEES.networkFeeOs }, FEES]) {
      await expect((await freshBridge(fees))(auditOf(request))).resolves.toMatchObject({ ok: true, ...FEES });
    }
    expect({ signed, broadcastCalls }).toEqual({ signed: 1, broadcastCalls: 1 });
  });

  it("a recovered success drops a declared fee when none was journalled before the broadcast", async () => {
    const request = requestFor("recovered-unjournalled-fee");
    await payAndLoseOutcome(request);
    expect(journal[0]).not.toHaveProperty("confirmedRecordFeeOs");
    const { bridge } = await restartedBridge({ reconcile: reconcileReporting({ ...FEES, recordFeeOs: "7" }) });

    const recovered = await bridge(auditOf(request));
    expect(recovered).toMatchObject({ ok: true, networkFeeOs: FEES.networkFeeOs });
    expect(recovered).not.toHaveProperty("recordFeeOs");
  });

  it.each([
    { case: "a hex debit", change: { confirmedTotalDebitOs: "0x10" } },
    { case: "a debit with a leading space", change: { confirmedTotalDebitOs: " 10" } },
    { case: "a debit below the amount", change: { confirmedTotalDebitOs: "10" } },
    { case: "a maximum with a leading zero", change: { maxTotalDebitOs: "03000000000" } },
    { case: "a declared fee without a debit", change: { confirmedRecordFeeOs: "10" } },
  ])("a recovered success refuses a journalled entry with $case", async ({ change }) => {
    const request = requestFor("recovered-malformed-entry");
    await payAndLoseOutcome(request);
    const readPreparedTransfers = vi.fn(async () => [{ ...journal[0], ...change }] as PayDemPreparedTransfer[]);
    const { bridge, effects } = await restartedBridge({ reconcile: reconcileWithoutReading, readPreparedTransfers });

    await expect(bridge(auditOf(request))).rejects.toThrow(
      "pay-dem: the journalled prepared transfer carries a malformed debit or fee field");
    expect(effects()).toEqual(NO_NEW_EFFECTS);
  });
});

describe("a durable pay-dem success found after a restart is checked before it is returned", () => {
  const payAndRecord = async (request: SettleRequest) => (await restartedBridge()).bridge(request);
  // The store path passes no hash; this reconciler reports the paid one and reads nothing else.
  const reconcileUnread = (fees: { networkFeeOs?: string } = {}) => vi.fn<PayDemSettlementReconcile>(async (context) =>
    ({ ...(await reconcileWithoutReading({ ...context, txHash: journal[0]?.txHash })), ...fees }));

  it("after a restart a durable success is returned only after the job's record and the node confirm it", async () => {
    confirmedFee = DECLARED_FEE;
    const request = requestFor("durable-success");
    const first = await payAndRecord(request);
    expect(first).toMatchObject({ ok: true, ...FEES });
    const reads = readsOfNode();

    const { bridge, effects, readPreparedTransfers } = await restartedBridge({ reconcile: reconcileUnread(), restartNumber: 2 });
    await expect(bridge(request)).resolves.toEqual(first);
    expect(readPreparedTransfers).toHaveBeenCalledTimes(1);
    expect(readsOfNode()).toBe(reads + 1);
    expect(effects()).toMatchObject({ signed: 1, broadcastCalls: 1 });

    const misreporting = await restartedBridge({ reconcile: reconcileUnread({ networkFeeOs: "5" }), restartNumber: 3 });
    await expect(misreporting.bridge(request)).rejects.toThrow("pay-dem: the reported fee differs from the debit the node record shows");
  });

  it.each([
    { case: "shows no payer debit", alter: () => { editRecord = withoutPayerDebit; }, error: NO_PAYER_DEBIT },
    { case: "is unreadable", alter: () => { demosSdk.getTxByHash.mockRejectedValue(new Error("record read refused")); },
      error: "transaction record read failed" },
  ])("after a restart a durable success is withheld when the node record $case", async ({ alter, error }) => {
    const request = requestFor("durable-refused");
    await payAndRecord(request);
    alter();
    const reconcile = reconcileUnread();
    const { bridge, effects } = await restartedBridge({ reconcile, timing: SHORT_READS, restartNumber: 2 });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(bridge(request)).rejects.toThrow(`pay-dem retained success is not confirmed by the node: ${error}`);
    }
    // Nothing was remembered, so the second attempt reconciled again.
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(effects()).toMatchObject({ signed: 1, broadcastCalls: 1 });
  });

  it("after a restart a bridge with no prepared-transfer reader withholds a durable success", async () => {
    const request = requestFor("durable-no-reader");
    await payAndRecord(request);
    const { bridge, effects } = await restartedBridge({
      reconcile: reconcileUnread(), readPreparedTransfers: null, restartNumber: 2,
    });

    await expect(bridge(request)).rejects.toThrow(
      "pay-dem retained success cannot be confirmed without a prepared-transfer reader");
    expect(effects()).toMatchObject({ signed: 1, broadcastCalls: 1 });
  });

  it("after a restart a durable permanent failure is returned without reading the job's record or the node", async () => {
    recordFailedSends();
    const request = requestFor("durable-failure");
    const first = await payAndRecord(request);
    expect(first).toMatchObject({ ok: false, errorClass: "permanent" });
    const reads = readsOfNode();

    const { bridge, readPreparedTransfers } = await restartedBridge({
      reconcile: vi.fn<PayDemSettlementReconcile>(async () => failureReply(first)), restartNumber: 2,
    });
    await expect(bridge(request)).resolves.toEqual(first);
    expect(readPreparedTransfers).not.toHaveBeenCalled();
    expect(readsOfNode()).toBe(reads);
  });
});
