import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import {
  createInMemoryAp2BindingStore,
  deriveAp2IdempotencyKey,
  type Ap2BindingStore,
  type Ap2SettlementIntent,
} from "../../src/rails/ap2.js";
import { createFsAp2BindingStore } from "../../src/rails/ap2SettlementFs.js";
import { writeMainFormatAp2Record } from "../fixtures/ap2LegacyRecord.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const result = await mkdtemp(join(tmpdir(), "dacs-ap2-"));
  dirs.push(result);
  return result;
}

const TX = "M-_9dPIbMk7OgNvy87SmOf0bWlrKktiUkMKVtAYwajo";
const JOB = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

function intent(jobId = JOB, transactionId = TX): Ap2SettlementIntent {
  const unsigned = {
    intentVersion: "2" as const,
    operationJson: "{}",
    operationHash: sha256Hex("{}"),
    transactionId,
    jobId,
    phaseIndex: 2,
    agreementHash: "a".repeat(64),
    idempotencyKey: deriveAp2IdempotencyKey(jobId, 2),
    mandateId: "mandate-1",
    payee: "merchant",
    amount: "1.5",
    currency: "USD",
    protocolVersion: "0.2",
    paymentInstrumentId: "pm_card_visa",
  };
  return { ...unsigned, bindingHash: sha256Hex(canonicalize(unsigned)) };
}

function gateFile(directory: string): string {
  return join(directory, "locks", `${sha256Hex(TX)}.gate`);
}

describe("filesystem AP2-7 binding store", () => {
  test("rejects option accessors without invoking them", async () => {
    let getterCalls = 0;
    const options = Object.defineProperty({}, "dir", {
      enumerable: true,
      get() { getterCalls += 1; return "unreachable"; },
    });
    await expect(createFsAp2BindingStore(options as never)).rejects.toThrow(/exact data properties/);
    expect(getterCalls).toBe(0);
  });

  test("persists an exact generation-fenced binding across instances", async () => {
    const dir = await directory();
    const first = await createFsAp2BindingStore({ dir });
    const acquired = await first.claim({
      intent: intent(), owner: "worker-a", now: 1, leaseDurationMs: 10,
    });
    expect(acquired).toMatchObject({ status: "acquired", lease: { generation: 1 } });

    const second = await createFsAp2BindingStore({ dir });
    await expect(second.claim({
      intent: intent(), owner: "worker-b", now: 2, leaseDurationMs: 10,
    })).resolves.toMatchObject({ status: "waiting", lease: { generation: 1 } });
    await expect(second.claim({
      intent: intent(), owner: "worker-b", now: 12, leaseDurationMs: 10,
    })).resolves.toMatchObject({ status: "acquired", lease: { generation: 2 } });

    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    const files = await readdir(join(dir, "records"));
    expect(files).toHaveLength(1);
    expect((await stat(join(dir, "records", files[0]!))).mode & 0o777).toBe(0o600);
  });

  test("retains the original replay deadline across reopen, waiting and takeover", async () => {
    const dir = await directory();
    const first = await createFsAp2BindingStore({ dir });
    expect(await first.claim({ intent: intent(), owner: "first", now: 100, leaseDurationMs: 10,
      noReferenceReplayWindowMs: 1000,
    })).toMatchObject({ status: "acquired", createdAt: 100, replayDeadline: 1100 });
    const reopened = await createFsAp2BindingStore({ dir });
    expect(await reopened.claim({ intent: intent(), owner: "second", now: 101, leaseDurationMs: 10,
      noReferenceReplayWindowMs: 5000,
    })).toMatchObject({ status: "waiting", createdAt: 100, replayDeadline: 1100 });
    expect(await reopened.claim({ intent: intent(), owner: "second", now: 111, leaseDurationMs: 10,
      noReferenceReplayWindowMs: 5000,
    })).toMatchObject({ status: "acquired", createdAt: 100, replayDeadline: 1100 });
    const [file] = await readdir(join(dir, "records"));
    expect(JSON.parse(await readFile(join(dir, "records", file!), "utf8"))).toMatchObject({ createdAt: 100, replayDeadline: 1100 });
  });

  test("concurrent first presentations install one binding and reject the other job", async () => {
    const dir = await directory();
    const a = await createFsAp2BindingStore({ dir });
    const b = await createFsAp2BindingStore({ dir });
    const [one, two] = await Promise.all([
      a.claim({ intent: intent(JOB), owner: "a", now: 1, leaseDurationMs: 10 }),
      b.claim({
        intent: intent("01ARZ3NDEKTSV4RRFFQ69G5FAW"),
        owner: "b",
        now: 1,
        leaseDurationMs: 10,
      }),
    ]);
    expect([one.status, two.status].sort()).toEqual(["acquired", "conflict"]);
  });

  test("a durable provider reference resumes after restart without a new submission authority", async () => {
    const dir = await directory();
    const value = intent();
    const first = await createFsAp2BindingStore({ dir });
    const claim = await first.claim({
      intent: value, owner: "worker-a", now: 1, leaseDurationMs: 10,
    });
    expect(claim.status).toBe("acquired");
    if (claim.status !== "acquired") throw new Error("claim failed");
    await expect(first.recordProviderRef({
      transactionId: value.transactionId,
      bindingHash: value.bindingHash,
      owner: claim.lease.owner,
      generation: claim.lease.generation,
      providerRef: "pi_restart123",
    })).resolves.toEqual({ status: "recorded" });

    const restarted = await createFsAp2BindingStore({ dir });
    await expect(restarted.claim({
      intent: value, owner: "worker-restarted", now: 12, leaseDurationMs: 10,
    })).resolves.toMatchObject({
      status: "acquired",
      providerRef: "pi_restart123",
      lease: { generation: 2 },
    });
  });

  test("corrupt durable bytes fail closed", async () => {
    const dir = await directory();
    const store = await createFsAp2BindingStore({ dir });
    await store.claim({ intent: intent(), owner: "a", now: 1, leaseDurationMs: 10 });
    const [record] = await readdir(join(dir, "records"));
    await writeFile(join(dir, "records", record!), "{not-json", { mode: 0o600 });
    await expect(store.claim({
      intent: intent(), owner: "b", now: 12, leaseDurationMs: 10,
    })).resolves.toMatchObject({ status: "corrupt" });
  });

  test("never reclaims an aged lock still owned by a live process", async () => {
    const dir = await directory();
    await createFsAp2BindingStore({ dir });
    const lock = join(dir, "locks", `${sha256Hex(TX)}.lock`);
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, "owner"), JSON.stringify({
      token: "00000000-0000-4000-8000-000000000000",
      pid: process.pid,
    }), { mode: 0o600 });
    await utimes(lock, 0, 0);
    const contender = await createFsAp2BindingStore({
      dir, lockTimeoutMs: 25, lockStaleMs: 5, lockPollMs: 1,
    });
    await expect(contender.claim({
      intent: intent(), owner: "a", now: 1, leaseDurationMs: 10,
    })).rejects.toThrow(/timed out waiting/);
  });

  test("reuses one prepared lock candidate across occupied retries and cleans it", async () => {
    const dir = await directory();
    await createFsAp2BindingStore({ dir });
    const locksDir = join(dir, "locks");
    const lockName = `${sha256Hex(TX)}.lock`;
    const lock = join(locksDir, lockName);
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, "owner"), JSON.stringify({
      token: "00000000-0000-4000-8000-000000000010",
      pid: process.pid,
    }), { mode: 0o600 });
    await utimes(lock, 0, 0);
    const contender = await createFsAp2BindingStore({
      dir, lockTimeoutMs: 150, lockStaleMs: 5, lockPollMs: 10,
    });
    const pending = contender.claim({
      intent: intent(), owner: "a", now: 1, leaseDurationMs: 10,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    let settled = false;
    void pending.finally(() => { settled = true; });
    const observed = new Set<string>();
    while (!settled) {
      for (const name of await readdir(locksDir)) {
        if (name.startsWith(`${lockName}.`) && name.endsWith(".candidate")) {
          observed.add(name);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    expect(String(await pending)).toMatch(/timed out waiting/);
    expect([...observed]).toHaveLength(1);
    expect((await readdir(locksDir)).filter((name) =>
      name.startsWith(`${lockName}.`) && name.endsWith(".candidate")
    )).toEqual([]);
  });

  test("reclaims an aged lock whose owner process no longer exists", async () => {
    const dir = await directory();
    await createFsAp2BindingStore({ dir });
    const lock = join(dir, "locks", `${sha256Hex(TX)}.lock`);
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, "owner"), JSON.stringify({
      token: "00000000-0000-4000-8000-000000000001",
      pid: 2_000_000_000,
    }), { mode: 0o600 });
    await utimes(lock, 0, 0);
    const contender = await createFsAp2BindingStore({
      dir, lockTimeoutMs: 100, lockStaleMs: 5, lockPollMs: 1,
    });
    await expect(contender.claim({
      intent: intent(), owner: "a", now: 1, leaseDurationMs: 10,
    })).resolves.toMatchObject({ status: "acquired" });
  });

  test("does not publish while a live reclaim gate owns the transition", async () => {
    const dir = await directory();
    await createFsAp2BindingStore({ dir });
    const gate = gateFile(dir);
    await writeFile(gate, JSON.stringify({
      token: "00000000-0000-4000-8000-000000000002",
      pid: process.pid,
    }), { mode: 0o600 });
    await utimes(gate, 0, 0);

    const contender = await createFsAp2BindingStore({
      dir, lockTimeoutMs: 25, lockStaleMs: 5, lockPollMs: 1,
    });
    await expect(contender.claim({
      intent: intent(), owner: "a", now: 1, leaseDurationMs: 10,
    })).rejects.toThrow(/timed out waiting/);
    expect(await readdir(join(dir, "records"))).toEqual([]);
  });

  test("recovers a dead stale reclaim gate before publishing", async () => {
    const dir = await directory();
    await createFsAp2BindingStore({ dir });
    const gate = gateFile(dir);
    await writeFile(gate, JSON.stringify({
      token: "00000000-0000-4000-8000-000000000003",
      pid: 2_000_000_000,
    }), { mode: 0o600 });
    await utimes(gate, 0, 0);

    const contender = await createFsAp2BindingStore({
      dir, lockTimeoutMs: 1_000, lockStaleMs: 5, lockPollMs: 1,
    });
    await expect(contender.claim({
      intent: intent(), owner: "a", now: 1, leaseDurationMs: 10,
    })).resolves.toMatchObject({ status: "acquired" });
    expect((await readdir(join(dir, "locks"))).filter((name) =>
      name.includes(".gate.") || name.endsWith(".candidate") ||
      name.endsWith(".quarantine") || name.endsWith(".release")
    )).toEqual([]);
  });

  test("serializes competing stale-lock reclaimers without losing the binding", async () => {
    const dir = await directory();
    const stores = await Promise.all(Array.from({ length: 8 }, () =>
      createFsAp2BindingStore({
        dir, lockTimeoutMs: 5_000, lockStaleMs: 5, lockPollMs: 1,
      })));
    const lock = join(dir, "locks", `${sha256Hex(TX)}.lock`);
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, "owner"), "not-json", { mode: 0o600 });
    await utimes(lock, 0, 0);

    const results = await Promise.all(stores.map((store, index) => store.claim({
      intent: intent(), owner: `worker-${index}`, now: 1, leaseDurationMs: 10,
    })));
    expect(results.filter((result) => result.status === "acquired")).toHaveLength(1);
    expect(results.filter((result) => result.status === "waiting")).toHaveLength(7);
    for (const store of stores) {
      await expect(store.claim({
        intent: intent(), owner: "reader", now: 2, leaseDurationMs: 10,
      })).resolves.toMatchObject({ status: "waiting" });
    }
    expect((await readdir(join(dir, "locks"))).filter((name) =>
      name.includes(".gate.") || name.endsWith(".candidate") ||
      name.endsWith(".quarantine") || name.endsWith(".release")
    )).toEqual([]);
  });
});


test("legacy incomplete AP2 records remain refused after reopen even with a valid old hash", async () => {
  const dir = await directory();
  const store = await createFsAp2BindingStore({ dir });
  await store.claim({ intent: intent(), owner: "before", now: 1, leaseDurationMs: 10 });
  const [name] = await readdir(join(dir, "records"));
  const path = join(dir, "records", name!);
  const record = JSON.parse(await readFile(path, "utf8"));
  record.intent.intentVersion = "1";
  delete record.intent.operationJson;
  delete record.intent.operationHash;
  const { bindingHash: _old, ...unsigned } = record.intent;
  record.intent.bindingHash = sha256Hex(canonicalize(unsigned));
  await writeFile(path, JSON.stringify(record));
  const reopened = await createFsAp2BindingStore({ dir });
  expect(await reopened.claim({ intent: intent(), owner: "after", now: 20, leaseDurationMs: 10 }))
    .toEqual({ status: "corrupt", reason: "ap2-legacy-record-requires-reconciliation" });
});

// AP2-7: the store binds a (jobId, phaseIndex), through its AP2-6 key, to the
// first transaction_id. A second checkout for that phase gets no record and no
// replay deadline of its own, in any state of the first binding.
const TX2 = "N-_9dPIbMk7OgNvy87SmOf0bWlrKktiUkMKVtAYwajo";
const OTHER_JOB = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const PHASE_TAKEN = { status: "conflict", reason: "ap2-phase-bound-to-another-transaction" };

describe.each([
  ["in-memory", async (): Promise<Ap2BindingStore> => createInMemoryAp2BindingStore()],
  ["filesystem", async (): Promise<Ap2BindingStore> => createFsAp2BindingStore({ dir: await directory() })],
])("%s AP2-7 store binds a phase to its first transaction_id", (_name, make) => {
  test("a second transaction_id for an occupied phase is refused while held, after expiry and after failure", async () => {
    const store = await make();
    expect(await store.claim({
      intent: intent(), owner: "a", now: 1, leaseDurationMs: 10, noReferenceReplayWindowMs: 100,
    })).toMatchObject({ status: "acquired", createdAt: 1, replayDeadline: 101 });
    const other = { intent: intent(JOB, TX2), owner: "b", leaseDurationMs: 10, noReferenceReplayWindowMs: 100 };
    expect(await store.claim({ ...other, now: 2 })).toEqual(PHASE_TAKEN);
    expect(await store.claim({ ...other, now: 1000 })).toEqual(PHASE_TAKEN);
    expect(await store.recordFailure({
      transactionId: TX, bindingHash: intent().bindingHash, owner: "a", generation: 1, reason: "declined",
    })).toEqual({ status: "recorded" });
    expect(await store.claim({ ...other, now: 2000 })).toEqual(PHASE_TAKEN);
    expect(await store.claim({ intent: intent(), owner: "c", now: 3000, leaseDurationMs: 10 }))
      .toMatchObject({ status: "failed", reason: "declined" });
  });

  test("a settled phase refuses a second transaction_id and still resumes the first", async () => {
    const store = await make();
    await store.claim({ intent: intent(), owner: "a", now: 1, leaseDurationMs: 10 });
    const fence = { transactionId: TX, bindingHash: intent().bindingHash, owner: "a", generation: 1 };
    expect(await store.recordProviderRef({ ...fence, providerRef: "pi_1" })).toEqual({ status: "recorded" });
    expect(await store.recordSettlement({ ...fence, settlement: {
      providerRef: "pi_1", mandateId: "mandate-1", protocolVersion: "0.2", payee: "merchant", amount: "1.5",
      currency: "USD", capturedAt: 5,
      receiptAttestation: { anchor: { kind: "https", locator: "https://provider.example/pi_1" }, contentHash: "b".repeat(64) },
    } })).toEqual({ status: "recorded" });
    expect(await store.claim({ intent: intent(JOB, TX2), owner: "b", now: 20, leaseDurationMs: 10 })).toEqual(PHASE_TAKEN);
    expect(await store.claim({ intent: intent(), owner: "b", now: 20, leaseDurationMs: 10 }))
      .toMatchObject({ status: "settled", settlement: { providerRef: "pi_1" } });
  });

  test("the second transaction_id still binds its own phase", async () => {
    const store = await make();
    await store.claim({ intent: intent(), owner: "a", now: 1, leaseDurationMs: 10 });
    expect(await store.claim({ intent: intent(OTHER_JOB, TX2), owner: "b", now: 2, leaseDurationMs: 10 }))
      .toMatchObject({ status: "acquired", lease: { generation: 1 } });
  });

  test("a claim whose AP2-6 key does not derive from its phase is refused before any binding", async () => {
    const store = await make();
    const forged = { ...intent(JOB, TX2), idempotencyKey: deriveAp2IdempotencyKey(OTHER_JOB, 2) };
    expect(await store.claim({ intent: forged, owner: "a", now: 1, leaseDurationMs: 10 }))
      .toEqual({ status: "corrupt", reason: "ap2-binding-claim-input-invalid" });
    expect(await store.claim({ intent: intent(), owner: "a", now: 1, leaseDurationMs: 10 }))
      .toMatchObject({ status: "acquired" });
  });

  test("a changed operation for the same transaction_id and phase is an operation conflict, not a replay", async () => {
    const store = await make();
    await store.claim({ intent: intent(), owner: "a", now: 1, leaseDurationMs: 10 });
    const { bindingHash: _hash, ...unsigned } = { ...intent(), operationJson: "{\"changed\":true}",
      operationHash: sha256Hex("{\"changed\":true}") };
    const changed = { ...unsigned, bindingHash: sha256Hex(canonicalize(unsigned)) };
    expect(await store.claim({ intent: changed, owner: "b", now: 20, leaseDurationMs: 10 }))
      .toEqual({ status: "conflict", reason: "ap2-retained-operation-conflict" });
    expect(await store.claim({ intent: intent(OTHER_JOB), owner: "b", now: 20, leaseDurationMs: 10 }))
      .toEqual({ status: "conflict", reason: "ap2-transaction-id-replay" });
  });
});

describe("filesystem AP2-7 phase binding across processes and upgrades", () => {
  const claim = (store: Ap2BindingStore, transactionId: string, now = 1) =>
    store.claim({ intent: intent(JOB, transactionId), owner: transactionId, now, leaseDurationMs: 10 });

  test("concurrent checkouts for one phase from two store instances bind exactly one", async () => {
    const dir = await directory();
    const [a, b] = await Promise.all([createFsAp2BindingStore({ dir }), createFsAp2BindingStore({ dir })]);
    const results = await Promise.all([claim(a, TX), claim(b, TX2)]);
    expect(results.map(({ status }) => status).sort()).toEqual(["acquired", "conflict"]);
    expect(results.find(({ status }) => status === "conflict")).toEqual(PHASE_TAKEN);
    expect(await readdir(join(dir, "records"))).toHaveLength(1);
    expect(await readdir(join(dir, "phases"))).toHaveLength(1);
  });

  test("a binding whose record was never written still reserves the phase for its transaction_id", async () => {
    const dir = await directory();
    const store = await createFsAp2BindingStore({ dir });
    await claim(store, TX);
    // A crash after the phase binding and before the record write.
    await rm(join(dir, "records", `${sha256Hex(TX)}.json`));
    const reopened = await createFsAp2BindingStore({ dir });
    expect(await claim(reopened, TX2, 2)).toEqual(PHASE_TAKEN);
    expect(await claim(reopened, TX, 3)).toMatchObject({ status: "acquired", createdAt: 3, lease: { generation: 1 } });
  });

  test("opening a store binds the phase of a record written before phase bindings", async () => {
    const dir = await directory();
    await claim(await createFsAp2BindingStore({ dir }), TX);
    await rm(join(dir, "phases"), { recursive: true });
    const reopened = await createFsAp2BindingStore({ dir });
    expect(await claim(reopened, TX2, 20)).toEqual(PHASE_TAKEN);
    expect(await readdir(join(dir, "records"))).toHaveLength(1);
    expect(await claim(reopened, TX, 20)).toMatchObject({ status: "acquired", createdAt: 1, lease: { generation: 2 } });
  });

  test("two earlier records for one phase make that phase fail closed for both", async () => {
    const dir = await directory();
    const elsewhere = await directory();
    await claim(await createFsAp2BindingStore({ dir }), TX);
    await claim(await createFsAp2BindingStore({ dir: elsewhere }), TX2);
    const name = `${sha256Hex(TX2)}.json`;
    await writeFile(join(dir, "records", name), await readFile(join(elsewhere, "records", name)));
    await rm(join(dir, "phases"), { recursive: true });
    const reopened = await createFsAp2BindingStore({ dir });
    const conflict = { status: "corrupt", reason: "ap2-phase-binding-conflict" };
    expect(await claim(reopened, TX, 20)).toEqual(conflict);
    expect(await claim(reopened, TX2, 20)).toEqual(conflict);
  });

  test("a malformed phase binding fails closed", async () => {
    const dir = await directory();
    await claim(await createFsAp2BindingStore({ dir }), TX);
    const [file] = await readdir(join(dir, "phases"));
    await writeFile(join(dir, "phases", file!), JSON.stringify({ phaseVersion: 1, transactionIds: [] }));
    const reopened = await createFsAp2BindingStore({ dir });
    expect(await claim(reopened, TX, 20)).toEqual({ status: "corrupt", reason: "ap2-phase-binding-malformed" });
    expect(await claim(reopened, TX2, 20)).toEqual({ status: "corrupt", reason: "ap2-phase-binding-malformed" });
  });
});

// Upgrade from the previous release: its store wrote intent version "1"
// records and no phases/ directory. Opening this store must account for each
// of them before any claim, so a second checkout cannot take their phase.
describe("filesystem AP2 store opened over the previous release's records", () => {
  const claim = (store: Ap2BindingStore, transactionId: string, jobId = JOB) =>
    store.claim({ intent: intent(jobId, transactionId), owner: transactionId, now: 200, leaseDurationMs: 10,
      noReferenceReplayWindowMs: 1000 });
  const LEGACY = { status: "corrupt", reason: "ap2-legacy-record-requires-reconciliation" };
  const UNBOUND = { status: "corrupt", reason: "ap2-store-has-unbound-records" };

  test.each(["in-flight", "settled", "failed"] as const)(
    "a main-format %s record binds its phase: a second transaction_id gets no record", async (state) => {
      const dir = await directory();
      await writeMainFormatAp2Record(dir, { transactionId: TX, jobId: JOB, phaseIndex: 2, state });
      const store = await createFsAp2BindingStore({ dir });
      expect(await readdir(join(dir, "phases"))).toHaveLength(1);
      expect(await claim(store, TX2)).toEqual(PHASE_TAKEN);
      expect(await claim(store, TX)).toEqual(LEGACY);
      expect(await readdir(join(dir, "records"))).toEqual([`${sha256Hex(TX)}.json`]);
      // A second open is unaffected, and so is an unrelated phase.
      expect(await claim(await createFsAp2BindingStore({ dir }), TX2)).toEqual(PHASE_TAKEN);
      expect(await claim(store, TX2, OTHER_JOB)).toMatchObject({ status: "acquired" });
    },
  );

  test("a main-format record and a current record for one phase fail closed for both", async () => {
    const dir = await directory();
    await claim(await createFsAp2BindingStore({ dir }), TX2);
    await writeMainFormatAp2Record(dir, { transactionId: TX, jobId: JOB, phaseIndex: 2 });
    const reopened = await createFsAp2BindingStore({ dir });
    const conflict = { status: "corrupt", reason: "ap2-phase-binding-conflict" };
    expect(await claim(reopened, TX)).toEqual(conflict);
    expect(await claim(reopened, TX2)).toEqual(conflict);
  });

  test("a main-format record with a non-canonical job id binds the key that release derived", async () => {
    const dir = await directory();
    await writeMainFormatAp2Record(dir, { transactionId: TX, jobId: JOB.toLowerCase(), phaseIndex: 2 });
    const store = await createFsAp2BindingStore({ dir });
    const legacyKey = sha256Hex(`dacs-ap2-idem:v1:${JOB.toLowerCase()}:2`);
    expect(await readdir(join(dir, "phases"))).toEqual([`${sha256Hex(legacyKey)}.json`]);
    // JID-1 refuses that id, so no current claim can reach its key; others proceed.
    expect(await claim(store, TX2)).toMatchObject({ status: "acquired" });
  });

  test.each(["a tampered main-format record", "a record of undecodable bytes", "a record under another transaction's name", "an oversized record"])(
    "%s that no phase lists makes the store refuse every new transaction_id until reconciled", async (kind) => {
      const dir = await directory();
      const path = await writeMainFormatAp2Record(dir, { transactionId: TX, jobId: JOB, phaseIndex: 2 });
      if (kind === "a tampered main-format record") {
        const record = JSON.parse(await readFile(path, "utf8"));
        record.intent.amount = "1";
        await writeFile(path, JSON.stringify(record));
      }
      if (kind === "a record of undecodable bytes") await writeFile(path, "{\"storeVersion\":1,");
      if (kind === "a record under another transaction's name") {
        await writeFile(join(dir, "records", `${sha256Hex("other-transaction")}.json`), await readFile(path));
        await rm(path);
      }
      if (kind === "an oversized record") await writeFile(path, " ".repeat(1_048_577));
      const store = await createFsAp2BindingStore({ dir });
      expect(await claim(store, TX2)).toEqual(UNBOUND);
      expect(await claim(store, TX2, OTHER_JOB)).toEqual(UNBOUND);
      expect(await readdir(join(dir, "phases"))).toEqual([]);
      expect(await readdir(join(dir, "records"))).toHaveLength(1);

      // The operator reconciles the record and moves it out of records/.
      const [name] = await readdir(join(dir, "records"));
      await rm(join(dir, "records", name!));
      expect(await claim(await createFsAp2BindingStore({ dir }), TX2, OTHER_JOB)).toMatchObject({ status: "acquired" });
    },
  );

  test("a corrupt current record that its phase binding lists blocks only its own phase", async () => {
    const dir = await directory();
    await claim(await createFsAp2BindingStore({ dir }), TX);
    await writeFile(join(dir, "records", `${sha256Hex(TX)}.json`), "not-json");
    const reopened = await createFsAp2BindingStore({ dir });
    expect(await claim(reopened, TX2)).toEqual(PHASE_TAKEN);
    expect(await claim(reopened, TX)).toMatchObject({ status: "corrupt" });
    expect(await claim(reopened, TX2, OTHER_JOB)).toMatchObject({ status: "acquired" });
  });

  test("an oversized phase binding does not account for an undecodable record", async () => {
    const dir = await directory();
    await claim(await createFsAp2BindingStore({ dir }), TX);
    await writeFile(join(dir, "records", `${sha256Hex(TX)}.json`), "not-json");
    const [phase] = await readdir(join(dir, "phases"));
    const listed = JSON.parse(await readFile(join(dir, "phases", phase!), "utf8"));
    await writeFile(join(dir, "phases", phase!), JSON.stringify(listed) + " ".repeat(16_385));
    const reopened = await createFsAp2BindingStore({ dir });
    expect(await claim(reopened, TX2, OTHER_JOB)).toEqual(UNBOUND);
  });

  test("bound transactions still resume while an unbound record blocks new ones", async () => {
    const dir = await directory();
    await claim(await createFsAp2BindingStore({ dir }), TX);
    await writeFile(join(dir, "records", `${sha256Hex("stray")}.json`), "not-json");
    const reopened = await createFsAp2BindingStore({ dir });
    expect(await reopened.claim({ intent: intent(), owner: "resume", now: 300, leaseDurationMs: 10 }))
      .toMatchObject({ status: "acquired", createdAt: 200, lease: { generation: 2 } });
    expect(await claim(reopened, TX2, OTHER_JOB)).toEqual(UNBOUND);
  });
});
