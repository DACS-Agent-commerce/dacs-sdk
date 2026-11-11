import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AnchorWaitError,
  DemosAdapter,
  createInMemoryDemosWriteJournal,
  type DemosWriteJournalLease,
} from "../../src/substrate/index.js";

// Recorded testnet answers from node2 (demosdk 4.0.16). Each value is what the
// SDK method returned to its caller; rows keep only the fields the adapter reads.
const FIXTURES = new URL(
  "./fixtures/demos-node-replies/write-lifecycle/",
  import.meta.url,
);
const RPC = "https://node2.demos.sh";
const CHAIN = "test-chain";
const RECONCILE_MS = 1_000;

interface RecordedWrite { hash: string; nonce: number; amountOs: string }
interface RecordedRead { getTransactionStatus: unknown; getTxByHash: unknown }
interface PendingRecording {
  sender: string;
  write: RecordedWrite;
  rounds: {
    A: { getAddressNonce: number };
    B1: RecordedRead;
    B36: RecordedRead & { getAddressNonce: number; getLastBlockNumber: number };
    C: RecordedRead & { getAddressNonce: number };
  };
  neverSeen: { B1: RecordedRead };
}
interface SameBlockRecording {
  sender: string;
  writes: { A: RecordedWrite; B: RecordedWrite };
  rounds: {
    B1: { A: RecordedRead; B: RecordedRead };
    B40: { A: RecordedRead; B: RecordedRead; getAddressNonce: number };
  };
  block74933: unknown;
  unknownMessage: unknown;
}
interface LateRecording {
  sender: string;
  writes: { L: RecordedWrite };
  rounds: {
    B1: { L: RecordedRead; getAddressNonce: number; getLastBlockNumber: number };
  };
}
interface ReadOnlyErrors {
  returned: {
    getTransactionStatusEmptyHash: unknown;
    getTxByHashEmptyHash: unknown;
    getAddressInfoMalformedAddress: unknown;
    getAddressNonceMalformedAddress: unknown;
  };
}

function recorded<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8")) as T;
}

const pending = recorded<PendingRecording>("pending");
const sameBlock = recorded<SameBlockRecording>("same-nonce-same-block");
const late = recorded<LateRecording>("same-nonce-late");
const readOnly = recorded<ReadOnlyErrors>("read-only-errors");
const SENDER = pending.sender;

interface NodeScript {
  /** Status and row answers, one pair per poll; the last pair repeats. */
  reads: RecordedRead[];
  /** `nodeCall("getAddressNonce")` answers in order; the last repeats. */
  nonces?: unknown[];
  lastBlock?: unknown;
  block?: unknown;
  /** `demos.getAddressNonce` for the wallet-nonce step after finality. */
  accountNonce?: number;
}

function answerAt<T>(answers: readonly T[], index: number): T | undefined {
  return answers[Math.min(index, answers.length - 1)];
}

/** An adapter whose node answers from `script` and records the order of reads. */
function scriptedAdapter(script: NodeScript) {
  const adapter = new DemosAdapter({ rpc: RPC, chainIdentity: CHAIN });
  Object.assign(adapter, { connected: true });
  const reads: string[] = [];
  let statusReads = 0;
  let rowReads = 0;
  let nonceReads = 0;
  vi.spyOn(adapter.raw, "getAddress").mockReturnValue(SENDER);
  vi.spyOn(adapter.raw, "nodeCall").mockImplementation(async (message: unknown) => {
    reads.push(String(message));
    if (message === "getTransactionStatus") {
      return answerAt(script.reads, statusReads++)?.getTransactionStatus;
    }
    if (message === "getAddressNonce") return answerAt(script.nonces ?? [], nonceReads++);
    if (message === "getLastBlockNumber") return script.lastBlock;
    throw new Error(`no recorded answer for nodeCall ${message}`);
  });
  vi.spyOn(adapter.raw, "getTxByHash").mockImplementation(async () => {
    reads.push("getTxByHash");
    return answerAt(script.reads, rowReads++)?.getTxByHash;
  });
  vi.spyOn(adapter.raw, "getBlockByNumber").mockResolvedValue(script.block);
  vi.spyOn(adapter.raw, "getAddressNonce").mockResolvedValue(script.accountNonce ?? 0);
  const broadcast = vi.spyOn(adapter.raw.tx, "broadcast")
    .mockRejectedValue(new Error("nothing is broadcast while reconciling"));
  return { adapter, reads, broadcast };
}

/** A wallet journal holding one broadcast native self-transfer, as recorded. */
async function journalledTransfer(write: RecordedWrite): Promise<DemosWriteJournalLease> {
  const journal = createInMemoryDemosWriteJournal();
  const lease = await journal.acquire({ chainIdentity: CHAIN, wallet: SENDER });
  const payer = SENDER.replace(/^0x/, "");
  await lease.put({
    writeId: `pay-dem-${write.hash}`,
    generation: lease.generation,
    kind: "native-transfer",
    operation: "transfer",
    stage: "broadcast-intent",
    logicalName: "pay-dem:pay-dem:job:0",
    programName: "native-dem-transfer",
    owner: payer,
    nativeAddress: payer,
    valueHash: "34".repeat(32),
    nonce: write.nonce,
    txRef: write.hash,
    transfer: {
      payer,
      payee: payer,
      amountOs: write.amountOs,
      denomination: "os",
      network: "demos",
      maxTotalDebitOs: (BigInt(write.amountOs) + 2_000_000_000n).toString(),
      settlementKey: "pay-dem:job:0",
    },
    updatedAt: Date.now(),
  });
  return lease;
}

// Block 74920 was not read in the pending run. This block only lets the step
// after the wait authenticate the row; the wait itself never reads it.
function blockListing(number: number, hash: string) {
  return {
    number,
    hash: "block-listing",
    status: "confirmed",
    content: { ordered_transactions: [hash], timestamp: 1_794_331_326 },
    validation_data: { signatures: {} },
  };
}

async function reconcile(
  adapter: DemosAdapter,
  lease: DemosWriteJournalLease,
): Promise<unknown> {
  return adapter.reconcileWalletJournal(lease, RECONCILE_MS, { pollMs: 1 })
    .then(() => undefined, (error: unknown) => error);
}

function stages(lease: DemosWriteJournalLease): string[] {
  return lease.snapshot.records.map((record) => record.stage);
}

/** The value demosdk's `call()` returns when its HTTP post throws. */
async function sdkTransportFailure(): Promise<unknown> {
  const adapter = new DemosAdapter({ rpc: RPC, chainIdentity: CHAIN });
  Object.assign(adapter.raw, {
    _doPost: async () => {
      throw new Error("socket hang up");
    },
  });
  return adapter.raw.nodeCall("getTransactionStatus", { hash: pending.write.hash });
}

function expectUnresolved(error: unknown, write: RecordedWrite): AnchorWaitError {
  expect(error).toBeInstanceOf(AnchorWaitError);
  const unresolved = error as AnchorWaitError;
  expect(unresolved.code).toBe("demos-write-unresolved");
  expect(unresolved.message).toContain(write.hash);
  expect(unresolved.message).toContain(`signed nonce ${write.nonce}`);
  return unresolved;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Demos write outcome from recorded testnet answers", () => {
  it("keeps polling a pending write until its row reads confirmed", async () => {
    const { write, rounds } = pending;
    const { adapter, reads } = scriptedAdapter({
      reads: [rounds.B1, rounds.B36, rounds.C],
      block: blockListing(74_920, write.hash),
      accountNonce: rounds.C.getAddressNonce,
    });
    const lease = await journalledTransfer(write);

    expect(await reconcile(adapter, lease)).toBeUndefined();

    expect(stages(lease)).toEqual(["canonical-confirmed"]);
    expect(lease.snapshot.records[0]?.blockNumber).toBe(74_920);
    expect(reads.filter((read) => read === "getTransactionStatus")).toHaveLength(3);
    await lease.release();
  });

  it("decides nothing from a null row while the status already reads included", async () => {
    const { write, rounds } = pending;
    const { adapter, reads } = scriptedAdapter({
      // The status index and the row can advance in either order; this pairs
      // round C's status with the null row every earlier round returned.
      reads: [
        { getTransactionStatus: rounds.C.getTransactionStatus, getTxByHash: rounds.B36.getTxByHash },
        rounds.C,
      ],
      block: blockListing(74_920, write.hash),
      accountNonce: rounds.C.getAddressNonce,
    });
    const lease = await journalledTransfer(write);

    expect(await reconcile(adapter, lease)).toBeUndefined();

    expect(stages(lease)).toEqual(["canonical-confirmed"]);
    expect(reads.filter((read) => read === "getTxByHash")).toHaveLength(2);
    await lease.release();
  });

  it("reads the hash again after the nonce before stopping an unknown write", async () => {
    const { write, rounds } = pending;
    const { adapter, reads } = scriptedAdapter({
      // Round B36 showed the nonce moving before any hash read showed the
      // write. This keeps that order: the first hash read answers as for a
      // hash the node does not hold, then the nonce moves, then round C.
      reads: [pending.neverSeen.B1, rounds.C],
      nonces: [rounds.B36.getAddressNonce],
      lastBlock: rounds.B36.getLastBlockNumber,
      block: blockListing(74_920, write.hash),
      accountNonce: rounds.C.getAddressNonce,
    });
    const lease = await journalledTransfer(write);

    expect(await reconcile(adapter, lease)).toBeUndefined();

    expect(stages(lease)).toEqual(["canonical-confirmed"]);
    const nonceRead = reads.indexOf("getAddressNonce");
    expect(nonceRead).toBeGreaterThan(-1);
    expect(reads.indexOf("getTransactionStatus", nonceRead)).toBeGreaterThan(nonceRead);
    expect(reads.indexOf("getTxByHash", nonceRead)).toBeGreaterThan(nonceRead);
    await lease.release();
  });

  it("stops a journalled write the node does not know and keeps the wallet blocked", async () => {
    const { writes, rounds } = late;
    const { adapter, broadcast } = scriptedAdapter({
      reads: [rounds.B1.L],
      nonces: [rounds.B1.getAddressNonce],
      lastBlock: rounds.B1.getLastBlockNumber,
    });
    const lease = await journalledTransfer(writes.L);

    const first = expectUnresolved(await reconcile(adapter, lease), writes.L);
    expect(first.message).toContain(`account nonce ${rounds.B1.getAddressNonce}`);
    expect(first.message).toContain(`last block ${rounds.B1.getLastBlockNumber}`);
    expect(stages(lease)).toEqual(["broadcast-intent"]);

    expectUnresolved(await reconcile(adapter, lease), writes.L);
    expect(stages(lease)).toEqual(["broadcast-intent"]);
    expect(broadcast).not.toHaveBeenCalled();
    await lease.release();
  });

  it("reads a zero account nonce as a real nonce, not as a failed read", async () => {
    const { write, rounds } = pending;
    const { adapter } = scriptedAdapter({
      reads: [pending.neverSeen.B1],
      nonces: [readOnly.returned.getAddressNonceMalformedAddress],
      lastBlock: rounds.B36.getLastBlockNumber,
    });
    const lease = await journalledTransfer(write);

    const error = expectUnresolved(await reconcile(adapter, lease), write);
    expect(error.message).toContain("account nonce 0");
    expect(stages(lease)).toEqual(["broadcast-intent"]);
    await lease.release();
  });

  it.each([
    ["a bare string", () => readOnly.returned.getAddressInfoMalformedAddress],
    ["an unknown-message object", () => sameBlock.unknownMessage],
  ])("fails closed on %s as the account nonce", async (_label, nonceAnswer) => {
    const { write, rounds } = pending;
    const { adapter } = scriptedAdapter({
      reads: [pending.neverSeen.B1],
      nonces: [await nonceAnswer()],
      lastBlock: rounds.B36.getLastBlockNumber,
      accountNonce: rounds.A.getAddressNonce,
    });
    const lease = await journalledTransfer(write);

    const error = expectUnresolved(await reconcile(adapter, lease), write);
    expect(error.message).toContain("account nonce answer is not a non-negative integer");
    expect(stages(lease)).toEqual(["broadcast-intent"]);
    await lease.release();
  });

  it.each([
    ["a bare string", () => readOnly.returned.getTxByHashEmptyHash],
    ["an error object without a state", () => readOnly.returned.getTransactionStatusEmptyHash],
    ["an unknown-message object", () => sameBlock.unknownMessage],
  ])("fails closed on %s as the status, even beside a confirmed row", async (_label, status) => {
    const { write, rounds } = pending;
    const { adapter } = scriptedAdapter({
      reads: [{ getTransactionStatus: await status(), getTxByHash: rounds.C.getTxByHash }],
      lastBlock: rounds.B36.getLastBlockNumber,
      block: blockListing(74_920, write.hash),
      accountNonce: rounds.C.getAddressNonce,
    });
    const lease = await journalledTransfer(write);

    const error = expectUnresolved(await reconcile(adapter, lease), write);
    expect(error.message).toContain("status answer");
    expect(stages(lease)).toEqual(["broadcast-intent"]);
    await lease.release();
  });

  it.each([
    ["a bare string", () => readOnly.returned.getTxByHashEmptyHash],
    ["an unknown-message object", () => sameBlock.unknownMessage],
  ])("fails closed on %s as the transaction row", async (_label, row) => {
    const { write, rounds } = pending;
    const { adapter } = scriptedAdapter({
      reads: [{ getTransactionStatus: rounds.C.getTransactionStatus, getTxByHash: await row() }],
      lastBlock: rounds.B36.getLastBlockNumber,
    });
    const lease = await journalledTransfer(write);

    const error = expectUnresolved(await reconcile(adapter, lease), write);
    expect(error.message).toContain("transaction row");
    expect(stages(lease)).toEqual(["broadcast-intent"]);
    await lease.release();
  });

  it("returns included once the status reads included and the row reads confirmed", async () => {
    const { writes, rounds, block74933 } = sameBlock;
    const { adapter } = scriptedAdapter({
      reads: [rounds.B40.B],
      block: block74933,
      accountNonce: rounds.B40.getAddressNonce,
    });
    const lease = await journalledTransfer(writes.B);

    expect(await reconcile(adapter, lease)).toBeUndefined();

    expect(lease.snapshot.records).toMatchObject([{
      stage: "canonical-confirmed",
      blockNumber: 74_933,
      blockHash: "e31332491c741997202d26548cda1d67ac0550d9907ee371431bae729b773ebd",
    }]);
    await lease.release();
  });

  it("ends the same-block loser failed although its status reads included", async () => {
    const { writes, rounds } = sameBlock;
    const { adapter, broadcast } = scriptedAdapter({ reads: [rounds.B1.A, rounds.B40.A] });
    const lease = await journalledTransfer(writes.A);

    expect(await reconcile(adapter, lease)).toBeUndefined();

    expect(stages(lease)).toEqual(["canonical-failed"]);
    expect(broadcast).not.toHaveBeenCalled();
    await lease.release();
  });

  it("never returns success for an included write whose row then reads failed", async () => {
    const { writes, rounds } = sameBlock;
    const { adapter, reads } = scriptedAdapter({
      // Included before the row is readable, as the nonce and status can lead
      // the row; then the loser's recorded failed row.
      reads: [
        { getTransactionStatus: rounds.B40.A.getTransactionStatus, getTxByHash: rounds.B1.A.getTxByHash },
        rounds.B40.A,
      ],
    });
    const lease = await journalledTransfer(writes.A);

    expect(await reconcile(adapter, lease)).toBeUndefined();

    expect(stages(lease)).toEqual(["canonical-failed"]);
    expect(reads.filter((read) => read === "getTxByHash")).toHaveLength(2);
    await lease.release();
  });

  it("a transport failure then a confirmed row ends confirmed", async () => {
    const { write, rounds } = pending;
    const { adapter, broadcast } = scriptedAdapter({
      reads: [
        { getTransactionStatus: await sdkTransportFailure(), getTxByHash: rounds.B1.getTxByHash },
        rounds.C,
      ],
      block: blockListing(74_920, write.hash),
      accountNonce: rounds.C.getAddressNonce,
    });
    const lease = await journalledTransfer(write);

    expect(await reconcile(adapter, lease)).toBeUndefined();

    expect(stages(lease)).toEqual(["canonical-confirmed"]);
    expect(broadcast).not.toHaveBeenCalled();
    await lease.release();
  });

  it("a transport failure then a failed row ends failed", async () => {
    const { writes, rounds } = sameBlock;
    const { adapter, broadcast } = scriptedAdapter({
      reads: [
        { getTransactionStatus: rounds.B1.A.getTransactionStatus, getTxByHash: await sdkTransportFailure() },
        rounds.B40.A,
      ],
    });
    const lease = await journalledTransfer(writes.A);

    expect(await reconcile(adapter, lease)).toBeUndefined();

    expect(stages(lease)).toEqual(["canonical-failed"]);
    expect(broadcast).not.toHaveBeenCalled();
    await lease.release();
  });

  it("a transport failure on the nonce read then a confirmed row ends confirmed", async () => {
    const { write, rounds } = pending;
    const { adapter, reads, broadcast } = scriptedAdapter({
      reads: [pending.neverSeen.B1, rounds.C],
      nonces: [await sdkTransportFailure()],
      lastBlock: rounds.B36.getLastBlockNumber,
      block: blockListing(74_920, write.hash),
      accountNonce: rounds.C.getAddressNonce,
    });
    const lease = await journalledTransfer(write);

    expect(await reconcile(adapter, lease)).toBeUndefined();

    expect(stages(lease)).toEqual(["canonical-confirmed"]);
    expect(reads.filter((read) => read === "getAddressNonce")).toHaveLength(1);
    expect(broadcast).not.toHaveBeenCalled();
    await lease.release();
  });

  it("reads a decimal-string account nonce as the nonce", async () => {
    const { writes, rounds } = late;
    const { adapter } = scriptedAdapter({
      reads: [rounds.B1.L],
      nonces: [String(rounds.B1.getAddressNonce)],
      lastBlock: rounds.B1.getLastBlockNumber,
    });
    const lease = await journalledTransfer(writes.L);

    const error = expectUnresolved(await reconcile(adapter, lease), writes.L);
    expect(error.message).toContain(`account nonce ${rounds.B1.getAddressNonce}, so nonce`);
    expect(stages(lease)).toEqual(["broadcast-intent"]);
    await lease.release();
  });

  it("a nonce-read transport failure then pending answers until the deadline is a plain timeout", async () => {
    const { write, rounds } = pending;
    const { adapter, broadcast } = scriptedAdapter({
      reads: [pending.neverSeen.B1, rounds.B1],
      nonces: [await sdkTransportFailure()],
      lastBlock: rounds.B36.getLastBlockNumber,
    });
    const lease = await journalledTransfer(write);

    const error = await reconcile(adapter, lease);
    expect(error).toBeInstanceOf(AnchorWaitError);
    expect((error as AnchorWaitError).code).toBe("timeout");
    expect(stages(lease)).toEqual(["broadcast-intent"]);
    expect(broadcast).not.toHaveBeenCalled();
    await lease.release();
  });

  it("transport failures on the nonce read until the deadline end demos-write-unresolved", async () => {
    const { write, rounds } = pending;
    const { adapter, reads, broadcast } = scriptedAdapter({
      reads: [pending.neverSeen.B1],
      nonces: [await sdkTransportFailure()],
      lastBlock: rounds.B36.getLastBlockNumber,
    });
    const lease = await journalledTransfer(write);

    const error = expectUnresolved(await reconcile(adapter, lease), write);
    expect(error.message).toContain("account nonce could not be read");
    expect(error.message).toContain("account nonce not readable");
    expect(error.message).toContain(`last block ${rounds.B36.getLastBlockNumber}`);
    const failures = Number(/only transport failures: (\d+)/.exec(error.message)?.[1]);
    expect(failures).toBeGreaterThan(1);
    expect(failures).toBe(reads.filter((read) => read === "getAddressNonce").length);
    expect(stages(lease)).toEqual(["broadcast-intent"]);
    expect(broadcast).not.toHaveBeenCalled();
    await lease.release();
  });

  it("transport failures until the deadline end demos-write-unresolved with their count", async () => {
    const { write, rounds } = pending;
    const transportFailure = await sdkTransportFailure();
    const { adapter, reads, broadcast } = scriptedAdapter({
      reads: [{ getTransactionStatus: transportFailure, getTxByHash: transportFailure }],
      nonces: [rounds.B36.getAddressNonce],
      lastBlock: rounds.B36.getLastBlockNumber,
    });
    const lease = await journalledTransfer(write);

    const error = expectUnresolved(await reconcile(adapter, lease), write);
    expect(error.message).toContain(`account nonce ${rounds.B36.getAddressNonce}`);
    expect(error.message).toContain(`last block ${rounds.B36.getLastBlockNumber}`);
    const failures = Number(/only transport failures: (\d+)/.exec(error.message)?.[1]);
    // Each round answered by two transport failures then reads the account
    // nonce once; a round cut off by the deadline is neither counted nor read.
    expect(failures).toBeGreaterThan(2);
    expect(failures).toBe(2 * reads.filter((read) => read === "getAddressNonce").length);
    expect(stages(lease)).toEqual(["broadcast-intent"]);
    expect(broadcast).not.toHaveBeenCalled();
    await lease.release();
  });
});
