import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

const lockRace = vi.hoisted(() => ({
  mode: null as "pause" | "replace" | null,
  target: "",
  replacementToken: "",
  entered: undefined as (() => void) | undefined,
  resume: undefined as Promise<void> | undefined,
  replacements: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (
      oldPath: Parameters<typeof actual.rename>[0],
      newPath: Parameters<typeof actual.rename>[1],
    ) => {
      const oldName = String(oldPath);
      const newName = String(newPath);
      if (oldName !== lockRace.target || !newName.endsWith(".stale") ||
          lockRace.mode === null) {
        return actual.rename(oldPath, newPath);
      }

      const mode = lockRace.mode;
      lockRace.mode = null;
      lockRace.entered?.();
      if (mode === "pause") {
        await lockRace.resume;
        return actual.rename(oldPath, newPath);
      }

      // Model a legacy reclaimer that moved the observed stale directory, then
      // let a live successor publish at the canonical path before this caller's
      // already-authorized rename resumed.
      const displaced = `${oldName}.test-observed-stale`;
      await actual.rename(oldName, displaced);
      await actual.mkdir(oldName, { mode: 0o700 });
      await actual.writeFile(`${oldName}/owner.json`, JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        token: lockRace.replacementToken,
        createdAt: Date.now(),
      }), { flag: "wx", mode: 0o600 });
      await actual.rename(oldName, newName);
      await actual.rm(displaced, { recursive: true, force: true });
      lockRace.replacements.push(newName);
    },
  };
});

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

import type { WalletSpendStateV1 } from "../../src/rails/walletSpendAuthority.js";
import { createFsWalletSpendStateStoreV1 } from "../../src/rails/walletSpendAuthorityFs.js";

const KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const roots: string[] = [];

afterEach(async () => {
  lockRace.mode = null;
  lockRace.target = "";
  lockRace.replacementToken = "";
  lockRace.entered = undefined;
  lockRace.resume = undefined;
  lockRace.replacements = [];
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dacs-wallet-lock-race-"));
  roots.push(dir);
  return dir;
}

async function staleLock(dir: string, scope: string): Promise<string> {
  const path = join(dir, "locks", `${scope}.lock`);
  await mkdir(path, { mode: 0o700 });
  await writeFile(join(path, "owner.json"), JSON.stringify({
    pid: 2_147_483_647,
    hostname: hostname(),
    token: `dead-${scope.slice(-4)}`,
    createdAt: 0,
  }), { flag: "wx", mode: 0o600 });
  await utimes(path, new Date(0), new Date(0));
  return path;
}

function advance(
  current: Readonly<WalletSpendStateV1> | null,
  value: string,
): Readonly<{ state: Readonly<WalletSpendStateV1>; value: string }> {
  const generation = current === null ? 1 : current.generation + 1;
  return {
    state: { ...(current ?? {}), generation } as WalletSpendStateV1,
    value,
  };
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("wallet spend filesystem lock mutation races", () => {
  test("serializes repeated competing stale reclaimers before successor publication", async () => {
    const dir = await fixture();
    const firstStore = await createFsWalletSpendStateStoreV1({
      dir,
      integrityKey: KEY,
      lockStaleMs: 1,
      lockPollMs: 1,
      lockTimeoutMs: 2_000,
    });
    const secondStore = await createFsWalletSpendStateStoreV1({
      dir,
      integrityKey: KEY,
      lockStaleMs: 1,
      lockPollMs: 1,
      lockTimeoutMs: 2_000,
    });

    for (let iteration = 1; iteration <= 8; iteration += 1) {
      const scope = iteration.toString(16).padStart(64, "0");
      const path = await staleLock(dir, scope);
      let enteredResolve!: () => void;
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
      let resumeResolve!: () => void;
      const resume = new Promise<void>((resolve) => { resumeResolve = resolve; });
      lockRace.mode = "pause";
      lockRace.target = path;
      lockRace.entered = enteredResolve;
      lockRace.resume = resume;

      let firstSettled = false;
      let secondSettled = false;
      const first = firstStore.transact(scope, (current) =>
        advance(current, `first-${iteration}`)).finally(() => { firstSettled = true; });
      await Promise.race([
        entered,
        wait(1_000).then(() => { throw new Error("stale rename hook did not fire"); }),
      ]);
      const second = secondStore.transact(scope, (current) =>
        advance(current, `second-${iteration}`)).finally(() => { secondSettled = true; });

      let outcomes: PromiseSettledResult<string>[];
      try {
        await wait(25);
        expect(firstSettled).toBe(false);
        expect(secondSettled).toBe(false);
        expect(JSON.parse(await readFile(join(path, "owner.json"), "utf8"))).toMatchObject({
          token: `dead-${scope.slice(-4)}`,
        });
      } finally {
        resumeResolve();
        outcomes = await Promise.allSettled([first, second]);
      }
      expect(outcomes).toEqual([
        { status: "fulfilled", value: `first-${iteration}` },
        { status: "fulfilled", value: `second-${iteration}` },
      ]);
      await expect(firstStore.read!(scope)).resolves.toMatchObject({ generation: 2 });
    }
  }, 30_000);

  test("preserves every live successor interposed at the stale rename boundary", async () => {
    const dir = await fixture();
    const store = await createFsWalletSpendStateStoreV1({
      dir,
      integrityKey: KEY,
      lockStaleMs: 1,
      lockPollMs: 1,
      lockTimeoutMs: 2_000,
    });

    for (let iteration = 1; iteration <= 12; iteration += 1) {
      const scope = (iteration + 32).toString(16).padStart(64, "0");
      const path = await staleLock(dir, scope);
      const replacementToken = `live-successor-${iteration}`;
      lockRace.mode = "replace";
      lockRace.target = path;
      lockRace.replacementToken = replacementToken;

      await expect(store.transact(scope, (current) =>
        advance(current, `unexpected-${iteration}`))).rejects.toThrow(
        /lock changed during stale recovery/,
      );
      expect(lockRace.replacements).toHaveLength(iteration);
      const quarantine = lockRace.replacements.at(-1)!;
      expect(JSON.parse(await readFile(join(quarantine, "owner.json"), "utf8"))).toMatchObject({
        pid: process.pid,
        token: replacementToken,
      });
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(join(dir, "locks"))).some((name) =>
        name === quarantine.slice(quarantine.lastIndexOf("/") + 1))).toBe(true);
      await rm(quarantine, { recursive: true });
      await expect(store.read!(scope)).resolves.toBeNull();
    }
  }, 30_000);
});
