import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFsDemosWriteJournal,
  type DemosWriteJournalRecord,
} from "../../src/substrate/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dacs-demos-journal-"));
  temporaryDirectories.push(dir);
  return dir;
}

function record(generation: number): DemosWriteJournalRecord {
  return {
    writeId: "write-1",
    generation,
    kind: "immutable",
    operation: "create",
    stage: "broadcast-intent",
    logicalName: "dacs:test:v1",
    programName: "dacs-test-v1",
    owner: "0xabc",
    nativeAddress: "stor-abc",
    valueHash: "value-hash",
    metadataHash: "metadata-hash",
    nonce: 7,
    txRef: "tx-abc",
    signedTransaction: '{"hash":"tx-abc"}',
    signedTransactionHash: "signed-hash",
    updatedAt: 1,
  };
}

function walletLockDigest(chainIdentity: string, wallet: string): string {
  return createHash("sha256")
    .update(chainIdentity)
    .update("\0")
    .update(wallet)
    .digest("hex");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true })
    ),
  );
});

describe("filesystem Demos write journal", () => {
  it("recovers an unresolved signed write in a fresh journal instance", async () => {
    const dir = await temporaryDirectory();
    const key = { chainIdentity: "genesis-a", wallet: "0xabc" };
    const firstJournal = await createFsDemosWriteJournal({ dir });
    const first = await firstJournal.acquire(key);
    await first.put(record(first.generation));
    await first.release();

    const restartedJournal = await createFsDemosWriteJournal({ dir });
    const restarted = await restartedJournal.acquire(key);
    expect(restarted.generation).toBe(2);
    expect(restarted.snapshot.records).toEqual([
      record(first.generation),
    ]);
    await restarted.release();
  });

  it("keys authority by chain identity and wallet, not endpoint spelling", async () => {
    const dir = await temporaryDirectory();
    const journal = await createFsDemosWriteJournal({ dir });
    const first = await journal.acquire({
      chainIdentity: "genesis-a",
      wallet: "0xabc",
    });
    await first.put(record(first.generation));
    await first.release();

    const sameAuthority = await journal.acquire({
      chainIdentity: "genesis-a",
      wallet: "0xabc",
    });
    expect(sameAuthority.snapshot.records).toHaveLength(1);
    await sameAuthority.release();

    const otherChain = await journal.acquire({
      chainIdentity: "genesis-b",
      wallet: "0xabc",
    });
    expect(otherChain.snapshot.records).toHaveLength(0);
    await otherChain.release();
  });

  it("fences a released worker and persists mode 0600 state", async () => {
    const dir = await temporaryDirectory();
    const journal = await createFsDemosWriteJournal({ dir });
    const lease = await journal.acquire({
      chainIdentity: "genesis-a",
      wallet: "0xabc",
    });
    await lease.release();
    await expect(lease.assertCurrent()).rejects.toThrow(/released/);
    await expect(lease.put(record(lease.generation))).rejects.toThrow(/released/);

    const walletsDir = join(dir, "wallets");
    const files = await readdir(walletsDir);
    expect(files).toHaveLength(1);
    const state = JSON.parse(
      await readFile(join(walletsDir, files[0]!), "utf8"),
    ) as { generation: number };
    expect(state.generation).toBe(1);
    expect((await stat(join(walletsDir, files[0]!))).mode & 0o777).toBe(0o600);
  });

  it("rejects a record owned by a different wallet before persisting it", async () => {
    const dir = await temporaryDirectory();
    const journal = await createFsDemosWriteJournal({ dir });
    const lease = await journal.acquire({
      chainIdentity: "genesis-a",
      wallet: "0xabc",
    });
    await expect(lease.put({
      ...record(lease.generation),
      owner: "0xattacker",
    })).rejects.toThrow(/invalid fields/);
    expect(lease.snapshot.records).toHaveLength(0);
    await lease.release();
  });

  it("fails closed when durable record fields are corrupted", async () => {
    const dir = await temporaryDirectory();
    const key = { chainIdentity: "genesis-a", wallet: "0xabc" };
    const journal = await createFsDemosWriteJournal({ dir });
    const lease = await journal.acquire(key);
    await lease.put(record(lease.generation));
    await lease.release();

    const walletsDir = join(dir, "wallets");
    const [file] = await readdir(walletsDir);
    const statePath = join(walletsDir, file!);
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      records: Array<Record<string, unknown>>;
    };
    state.records[0]!.nonce = -1;
    await writeFile(statePath, JSON.stringify(state));

    await expect(journal.acquire(key)).rejects.toThrow(/record 0.*invalid fields/);
  });

  it("never steals a stale-looking lease owned by another host", async () => {
    const dir = await temporaryDirectory();
    const journal = await createFsDemosWriteJournal({
      dir,
      lockStaleMs: 1,
      lockTimeoutMs: 40,
    });
    const key = { chainIdentity: "genesis-a", wallet: "0xabc" };
    const lease = await journal.acquire(key);
    const locksDir = join(dir, "locks");
    const [lockName] = await readdir(locksDir);
    const lockPath = join(locksDir, lockName!);
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({
      token: "foreign-token",
      pid: 1,
      hostname: "different-host",
      createdAt: 1,
    }));
    await utimes(lockPath, new Date(0), new Date(0));

    await expect(journal.acquire(key)).rejects.toThrow(/timed out acquiring/);
    await lease.release();
  });

  it("serializes competing stale-lock reclaimers without displacing a successor", async () => {
    const key = { chainIdentity: "genesis-race", wallet: "0xrace" };
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const dir = await temporaryDirectory();
      const journals = await Promise.all(Array.from({ length: 8 }, () =>
        createFsDemosWriteJournal({
          dir,
          lockStaleMs: 1,
          lockTimeoutMs: 10_000,
        })));
      const locksDir = join(dir, "locks");
      const staleLock = join(
        locksDir,
        `${walletLockDigest(key.chainIdentity, key.wallet)}.lock`,
      );
      await mkdir(staleLock, { mode: 0o700 });
      await writeFile(join(staleLock, "owner.json"), "not-json", { mode: 0o600 });
      const old = new Date(Date.now() - 10_000);
      await utimes(staleLock, old, old);

      let active = 0;
      let maximumActive = 0;
      const generations = await Promise.all(journals.map(async (journal) => {
        const lease = await journal.acquire(key);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          await lease.assertCurrent();
          await new Promise((resolve) => setTimeout(resolve, 2));
          await lease.assertCurrent();
          return lease.generation;
        } finally {
          active -= 1;
          await lease.release();
        }
      }));

      expect(maximumActive).toBe(1);
      expect(generations.sort((left, right) => left - right)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
      expect(await readdir(locksDir)).toEqual([]);
    }
  }, 90_000);

  it("recovers an unresolved write after a real child process is hard-killed", async () => {
    const dir = await temporaryDirectory();
    const ready = join(dir, "child-ready");
    const child = spawn(
      process.execPath,
      [
        "./node_modules/vitest/vitest.mjs",
        "run",
        "test/fixtures/demos-write-journal-child.test.ts",
        "--pool=forks",
        "--maxWorkers=1",
        "--reporter=dot",
      ],
      {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          DACS_DEMOS_JOURNAL_CHILD: "1",
          DACS_DEMOS_JOURNAL_DIR: dir,
          DACS_DEMOS_JOURNAL_READY: ready,
        },
      },
    );
    if (child.pid === undefined) throw new Error("child process has no pid");
    try {
      const deadline = Date.now() + 10_000;
      for (;;) {
        try {
          await readFile(ready, "utf8");
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          if (Date.now() >= deadline) {
            throw new Error("child journal process did not become ready");
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      process.kill(-child.pid, "SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));

      const restarted = await createFsDemosWriteJournal({
        dir,
        lockTimeoutMs: 5_000,
      });
      const lease = await restarted.acquire({
        chainIdentity: "genesis-child",
        wallet: "0xchild",
      });
      expect(lease.generation).toBe(2);
      expect(lease.snapshot.records).toMatchObject([
        {
          writeId: "child-write",
          stage: "broadcast-intent",
          nonce: 1,
          txRef: "tx-child",
        },
      ]);
      await lease.release();
    } finally {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }, 20_000);
});
