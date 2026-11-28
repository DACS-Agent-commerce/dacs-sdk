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
  type PayDemSettlementRecoveryContext,
} from "../../src/rails/payDem.js";
import type { SettleRequest } from "../../src/rails/settlementTypes.js";
import { nativeSendEdits } from "../support/payDemEdits.js";

// Walks the documented restart recipe (docs/pay-dem-execution.md, "Recovering a
// pay-dem purchase after a restart") through each crash point. The rail, the
// bridge and the settlement store are the real ones; only the Demos node is
// simulated. The prepared-transfer journal, the settlement log and the node
// survive a restart. Everything else is rebuilt. The node holds transaction
// records only; it models no balances. The tests show that a confirmed record
// is recovered once and that nothing is signed or broadcast again, not that
// value moved once.

const PAYER = `0x${"ab".repeat(32)}`;
const PAYEE = `0x${"cd".repeat(32)}`;
const FIRST_NONCE = 7;
const INCLUSION_BLOCK = 42;
const LEASE_MS = 30_000;
const CRASH_AT = 1_000;

interface NodeRecord { status: "pending" | "confirmed"; transaction: Record<string, unknown> }

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

/** The simulated node: transactions it received, and what the payer's account has used. */
let node: Map<string, NodeRecord>;
/** The application's durable prepared-transfer journal. */
let journal: PayDemPreparedTransfer[];
/** The durable settlement log shared by every process. */
let log: SettlementLog;
let signed: number;
let broadcastCalls: number;
let rpcCounter = 0;

const hashOf = (ordinal: number) => ordinal.toString(16).padStart(2, "0").repeat(32);
/** Confirmed records the node holds. No balances are modelled, so this counts records, not value moved. */
const executedTransfers = () =>
  [...node.values()].filter((record) => record.status === "confirmed").length;

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
        nonce: FIRST_NONCE + signed - 1, type: "native", from: PAYER, to, amount: amountOs.toString(),
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
    node.set(transaction.hash, { status: "confirmed", transaction });
    return { response: { hash: transaction.hash } };
  });
  demosSdk.nodeCall.mockImplementation(async (_message: string, args: { hash: string }) =>
    node.get(args.hash)?.status === "confirmed"
      ? { state: "included", blockNumber: INCLUSION_BLOCK }
      : { state: "not_found" });
  demosSdk.getTxByHash.mockImplementation(async (hash: string) => {
    const record = node.get(hash);
    if (record === undefined) return null;
    const content = record.transaction.content as Record<string, unknown>;
    return {
      ...record.transaction,
      content: {
        ...content, nonce: String(content.nonce),
        gcr_edits: nativeSendEdits({ payer: String(content.from), payee: String(content.to), amount: String(content.amount) }),
      },
      status: record.status,
      blockNumber: INCLUSION_BLOCK,
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

/** Hooks that decide how the first process dies; none by default. */
interface FirstProcess {
  /** Called with the prepared transfer after it is journaled and before any broadcast. */
  afterJournal?: (prepared: Readonly<PayDemPreparedTransfer>) => void;
  /** Make the settlement log lose the outcome write, as a crash right after inclusion does. */
  loseOutcome?: boolean;
  /** Build the rail without a journal hook. */
  unjournaled?: boolean;
  /** How long the rail watches for inclusion before it gives up. */
  inclusionTimeoutMs?: number;
}

/**
 * The operator's reconcile function: bind the hash the recipe supplies to the
 * journal's record, then read the node's record for that hash. It throws if the
 * record's nonce is not the journaled one, and otherwise reports the payer,
 * payee and amount the record itself carries, so the bridge compares them with
 * the request. It throws whenever it cannot prove an outcome: a call that
 * carries no hash, a hash with no journal entry, or a record still pending.
 * It returns `null` only when the node holds no record for the journaled hash.
 */
const reconcileFromJournalAndNode = async (context: Readonly<PayDemSettlementRecoveryContext>) => {
  if (context.txHash === undefined) throw new Error("no transaction hash to reconcile");
  const prepared = journal.find((entry) =>
    entry.recovery?.settlementKey === context.settlementKey && entry.txHash === context.txHash);
  if (prepared === undefined) throw new Error(`no journal entry for ${context.txHash}`);
  const record = node.get(prepared.txHash);
  if (record === undefined) return null;
  if (record.status !== "confirmed") throw new Error(`transfer is still ${record.status} at the node`);
  const content = record.transaction.content as {
    nonce: number; from: string; to: string; amount: string;
  };
  if (content.nonce !== prepared.nonce) {
    throw new Error(`node record carries nonce ${content.nonce}, the journal signed nonce ${prepared.nonce}`);
  }
  return {
    ok: true as const, txHash: prepared.txHash, payer: content.from, payee: content.to,
    chainId: "demos", amountOs: content.amount, blockNumber: INCLUSION_BLOCK, txRefKind: "demos",
    finality: { model: "bft-final" as const }, execution: "executed" as const,
  };
};

async function buildBridge(now: number, options: FirstProcess = {}) {
  const rail = await createPayDemRail({
    rpc: `https://restart-recipe-${rpcCounter}.test`,
    secret: "test-secret",
    ...(options.inclusionTimeoutMs === undefined ? {} : { inclusionTimeoutMs: options.inclusionTimeoutMs }),
    ...(options.unjournaled === true ? {} : {
      journalPreparedTransfer: async (prepared: Readonly<PayDemPreparedTransfer>) => {
        journal.push(prepared);
        options.afterJournal?.(prepared);
      },
    }),
  });
  const processLog: SettlementLog = options.loseOutcome === true
    ? { ...log, putOutcome: async () => { throw new Error("process died before the outcome was recorded"); } }
    : log;
  const store = createIdempotencyStore(processLog, { now: () => now, leaseDurationMs: LEASE_MS });
  return payDemSettle(rail, {}, {
    store,
    reconcile: reconcileFromJournalAndNode,
    readPreparedTransfers: async (key) => journal.filter((prepared) => prepared.recovery?.settlementKey === key),
    ...(options.unjournaled === true ? { allowUnjournaled: true } : {}),
  });
}

/** Run the documented recipe in a restarted process that reads its hashes from the journal. */
async function recoverAfterRestart(request: SettleRequest, restartNumber: number) {
  const bridge = await buildBridge(CRASH_AT + restartNumber * 2 * LEASE_MS);
  const recoverSettlement = withRecoveredAttempts(bridge, async (req) =>
    journal
      .filter((prepared) => prepared.recovery?.settlementKey === keyOf(req))
      .map((prepared) => ({ txHash: prepared.txHash, chainId: "demos", ok: false })));
  return recoverSettlement({ ...request, recoveryOnly: true });
}

async function crashFirstProcess(request: SettleRequest, options: FirstProcess) {
  const bridge = await buildBridge(CRASH_AT, options);
  await expect(bridge(request)).rejects.toThrow(/process died/);
}

describe("recovering a pay-dem purchase after a restart", () => {
  it("recovers the confirmed record of a transfer included before the outcome was recorded, without signing or sending again", async () => {
    const request = requestFor("restart-included");
    await crashFirstProcess(request, { loseOutcome: true });
    expect(journal).toHaveLength(1);
    expect(executedTransfers()).toBe(1);

    const recovered = await recoverAfterRestart(request, 1);
    expect(recovered).toMatchObject({ ok: true, txHash: journal[0]?.txHash, blockNumber: INCLUSION_BLOCK });
    expect(executedTransfers()).toBe(1);
    expect(signed).toBe(1);
    expect(broadcastCalls).toBe(1);
  });

  it("returns the same settlement when the recipe runs again after another restart", async () => {
    const request = requestFor("restart-repeat");
    await crashFirstProcess(request, { loseOutcome: true });

    const first = await recoverAfterRestart(request, 1);
    await expect(recoverAfterRestart(request, 2)).resolves.toEqual(first);
    expect(executedTransfers()).toBe(1);
    expect(broadcastCalls).toBe(1);
  });

  it("refuses a purchase with no journal record, sends nothing, and lets a new job id settle", async () => {
    const request = requestFor("restart-no-record");
    demosSdk.transfer.mockRejectedValueOnce(new Error("process died before signing"));
    await crashFirstProcess(request, {});
    expect(journal).toHaveLength(0);

    await expect(recoverAfterRestart(request, 1)).rejects.toThrow(/no transaction hash to reconcile/);
    expect(signed).toBe(0);
    expect(broadcastCalls).toBe(0);
    expect(executedTransfers()).toBe(0);

    await expect((await buildBridge(CRASH_AT + 4 * LEASE_MS))(requestFor("restart-no-record-new")))
      .resolves.toMatchObject({ ok: true });
    expect(executedTransfers()).toBe(1);
  });

  it("keeps a journaled but unsent purchase unfinished across restarts without signing or sending again", async () => {
    const request = requestFor("restart-journaled-unsent");
    await crashFirstProcess(request, {
      afterJournal: () => { throw new Error("process died before broadcast"); },
    });
    expect(journal).toHaveLength(1);

    for (const restartNumber of [1, 2]) {
      await expect(recoverAfterRestart(request, restartNumber)).rejects.toThrow(/proof of absence/);
    }
    expect(signed).toBe(1);
    expect(broadcastCalls).toBe(0);
    expect(executedTransfers()).toBe(0);
  });

  it("refuses while the transfer is pending at the node, then completes it once, without signing or sending again, when the node confirms it", async () => {
    const request = requestFor("restart-pending");
    // The node accepts the broadcast and holds the transfer pending, so the first
    // process never sees it included and stops watching.
    demosSdk.broadcast.mockImplementationOnce(async (validity: {
      response: { data: { transaction: { hash: string; content: Record<string, unknown> } } };
    }) => {
      broadcastCalls += 1;
      const { transaction } = validity.response.data;
      node.set(transaction.hash, { status: "pending", transaction });
      return { response: { hash: transaction.hash } };
    });
    const first = await (await buildBridge(CRASH_AT, { inclusionTimeoutMs: 50 }))(request);
    expect(first.ok).toBe(false);
    expect(broadcastCalls).toBe(1);
    expect(node.get(journal[0]?.txHash ?? "")?.status).toBe("pending");

    await expect(recoverAfterRestart(request, 1)).rejects.toThrow(/still pending at the node/);
    expect(executedTransfers()).toBe(0);
    expect(signed).toBe(1);
    expect(broadcastCalls).toBe(1);

    const pending = node.get(journal[0]?.txHash ?? "");
    if (pending !== undefined) pending.status = "confirmed";
    await expect(recoverAfterRestart(request, 2)).resolves.toMatchObject({
      ok: true, txHash: journal[0]?.txHash, blockNumber: INCLUSION_BLOCK,
    });
    expect(executedTransfers()).toBe(1);
    expect(signed).toBe(1);
    expect(broadcastCalls).toBe(1);
  });

  // The product bridge refuses this: it compares the record's payee with the request.
  it("the bridge refuses a confirmed record that names another payee, and never signs or sends again", async () => {
    const request = requestFor("restart-other-payee");
    await crashFirstProcess(request, { loseOutcome: true });
    const record = node.get(journal[0]?.txHash ?? "");
    const content = record?.transaction.content as { to: string };
    content.to = `0x${"ee".repeat(32)}`;

    await expect(recoverAfterRestart(request, 1)).rejects.toThrow(/payee/);
    expect(signed).toBe(1);
    expect(broadcastCalls).toBe(1);
  });

  // The bridge context carries no nonce, so this refusal comes from the sample reconciler above; the
  // reconciler is responsible for binding the nonce (docs/pay-dem-execution.md, lines 75-78).
  it("the sample reconciler refuses a confirmed record that carries another nonce, and nothing is signed or sent again", async () => {
    const request = requestFor("restart-other-nonce");
    await crashFirstProcess(request, { loseOutcome: true });
    const record = node.get(journal[0]?.txHash ?? "");
    const content = record?.transaction.content as { nonce: number };
    content.nonce += 1;

    await expect(recoverAfterRestart(request, 1)).rejects.toThrow(/nonce/);
    expect(signed).toBe(1);
    expect(broadcastCalls).toBe(1);
  });

  it("never finishes a purchase whose nonce was used by another transaction, and a new job id settles", async () => {
    const request = requestFor("restart-nonce-taken");
    await crashFirstProcess(request, {
      afterJournal: () => { throw new Error("process died before broadcast"); },
    });
    // Another transaction from the same payer used the journaled nonce.
    node.set(hashOf(200), { status: "confirmed", transaction: { hash: hashOf(200), content: { nonce: journal[0]?.nonce } } });
    const otherPayments = executedTransfers();

    await expect(recoverAfterRestart(request, 1)).rejects.toThrow(/proof of absence/);
    expect(executedTransfers()).toBe(otherPayments);
    expect(broadcastCalls).toBe(0);

    await expect((await buildBridge(CRASH_AT + 4 * LEASE_MS))(requestFor("restart-nonce-taken-new")))
      .resolves.toMatchObject({ ok: true });
    expect(executedTransfers()).toBe(otherPayments + 1);
  });

  it("refuses a purchase whose first attempt ran on a rail with no journal, and never pays again", async () => {
    const request = requestFor("restart-unjournaled");
    await crashFirstProcess(request, { unjournaled: true, loseOutcome: true });
    expect(journal).toHaveLength(0);
    expect(executedTransfers()).toBe(1);

    await expect(recoverAfterRestart(request, 1)).rejects.toThrow(/no transaction hash to reconcile/);
    expect(signed).toBe(1);
    expect(broadcastCalls).toBe(1);
    expect(executedTransfers()).toBe(1);
  });
});
