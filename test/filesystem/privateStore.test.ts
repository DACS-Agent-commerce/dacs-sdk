import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  atomicWritePrivateFile,
  exclusiveWritePrivateFile,
  preparePrivateStoreDirectory,
  readPrivateFile,
} from "../../src/filesystem/privateStore.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dacs-private-store-"));
  roots.push(root);
  return root;
}

/**
 * Starts a read under fake timers and runs the event loop until the read
 * settles or schedules its first retry delay.
 */
async function startRead(path: string) {
  const state = { settled: false };
  const reading = readPrivateFile(path);
  reading.then(() => { state.settled = true; }, () => { state.settled = true; });
  while (!state.settled && vi.getTimerCount() === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return { reading, state };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

describe("private durable filesystem boundary", () => {
  test("rejects symlinked and writable ancestors without repairing them", async () => {
    if (process.platform === "win32" || typeof process.getuid !== "function") return;
    const root = await temporaryRoot();
    const physical = join(root, "physical");
    const linked = join(root, "linked");
    await mkdir(physical, { mode: 0o700 });
    await symlink(physical, linked, "dir");
    await expect(preparePrivateStoreDirectory(join(linked, "store")))
      .rejects.toThrow(/symbolic link/);

    await chmod(root, 0o720);
    await expect(preparePrivateStoreDirectory(join(root, "store")))
      .rejects.toThrow(/group\/world writable/);
    expect((await lstat(root)).mode & 0o777).toBe(0o720);
  });

  test("refuses consumer-sync paths before creating store state", async () => {
    const root = await temporaryRoot();
    const requested = join(root, "Dropbox", "store");
    await expect(preparePrivateStoreDirectory(requested)).rejects.toThrow(/sync directory/);
    await expect(lstat(join(root, "Dropbox"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("public file primitives cannot bypass local-filesystem admission", async () => {
    const root = await temporaryRoot();
    const syncDirectory = join(root, "Dropbox");
    const path = join(syncDirectory, "state.json");
    await mkdir(syncDirectory, { mode: 0o700 });

    await expect(atomicWritePrivateFile(path, "state")).rejects.toThrow(/sync directory/);
    await expect(exclusiveWritePrivateFile(path, "state")).rejects.toThrow(/sync directory/);
    await expect(readPrivateFile(path)).rejects.toThrow(/sync directory/);
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("publishes through random exclusive temporaries without following a planted name", async () => {
    const root = await temporaryRoot();
    const store = await preparePrivateStoreDirectory(join(root, "store"));
    const path = join(store, "state.json");
    const sentinel = join(root, "sentinel.txt");
    await writeFile(sentinel, "unchanged", { mode: 0o600 });
    await symlink(sentinel, `${path}.tmp`);

    await atomicWritePrivateFile(path, "one");
    expect(await readPrivateFile(path)).toBe("one");
    expect(await readFile(sentinel, "utf8")).toBe("unchanged");

    const exclusive = join(store, "binding.json");
    await exclusiveWritePrivateFile(exclusive, "bound");
    await expect(exclusiveWritePrivateFile(exclusive, "replacement"))
      .rejects.toMatchObject({ code: "EEXIST" });
    expect(await readPrivateFile(exclusive)).toBe("bound");
  });

  test("rejects endpoint symlinks for both reads and replacements", async () => {
    const root = await temporaryRoot();
    const store = await preparePrivateStoreDirectory(join(root, "store"));
    const sentinel = join(root, "sentinel.txt");
    const path = join(store, "state.json");
    await writeFile(sentinel, "unchanged", { mode: 0o600 });
    await symlink(sentinel, path);

    await expect(readPrivateFile(path)).rejects.toThrow(/unsafe.*symbolic link/);
    await expect(atomicWritePrivateFile(path, "replacement"))
      .rejects.toThrow(/unsafe/);
    expect(await readFile(sentinel, "utf8")).toBe("unchanged");
  });

  test("rejects retained files that have another hard-link name", async () => {
    const root = await temporaryRoot();
    const store = await preparePrivateStoreDirectory(join(root, "store"));
    const path = join(store, "state.json");
    const retainedAlias = join(store, "retained-alias.json");
    await atomicWritePrivateFile(path, "admitted");
    await link(path, retainedAlias);

    await expect(readPrivateFile(path)).rejects.toThrow(/hard links/);
    await expect(atomicWritePrivateFile(path, "replacement"))
      .rejects.toThrow(/hard links/);
    expect(await readFile(path, "utf8")).toBe("admitted");
    expect(await readFile(retainedAlias, "utf8")).toBe("admitted");
  });
});

// exclusiveWritePrivateFile commits with link(temporary, path) and then removes
// the temporary name, so a complete file briefly has exactly two links.
describe("reads during an exclusive publication", () => {
  test("readPrivateFile admits concurrent publications that finish within its 315 ms retry budget", async () => {
    const root = await temporaryRoot();
    const store = await preparePrivateStoreDirectory(join(root, "store"));
    let current = { path: join(store, "publication-0.json"), text: "" };
    let publishing = true;
    let admittedReads = 0;
    const refusals: string[] = [];
    const readUntilPublished = async () => {
      while (publishing) {
        const target = current;
        try {
          const text = await readPrivateFile(target.path);
          admittedReads += 1;
          if (text !== target.text) refusals.push(`partial read of ${target.path}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") refusals.push(String(error));
        }
      }
    };
    const readers = Array.from({ length: 3 }, readUntilPublished);
    try {
      for (let index = 0; index < 100; index += 1) {
        current = { path: join(store, `publication-${index}.json`), text: `publication ${index}` };
        await exclusiveWritePrivateFile(current.path, current.text);
      }
    } finally {
      publishing = false;
      await Promise.all(readers);
    }

    expect(refusals.length, refusals[0]).toBe(0);
    expect(admittedReads).toBeGreaterThan(0);
  });

  test("re-reads a two-link file once its second name is removed during the wait", async () => {
    const root = await temporaryRoot();
    const store = await preparePrivateStoreDirectory(join(root, "store"));
    const path = join(store, "binding.json");
    const temporaryName = join(store, ".binding.json.publishing.tmp");
    await exclusiveWritePrivateFile(path, "published");
    await link(path, temporaryName);
    vi.useFakeTimers({ toFake: ["setTimeout"] });

    const { reading, state } = await startRead(path);
    expect(state.settled).toBe(false);
    await unlink(temporaryName);
    await vi.runAllTimersAsync();

    await expect(reading).resolves.toBe("published");
  });

  test("refuses a file that keeps two links after its 315 ms retry budget", async () => {
    const root = await temporaryRoot();
    const store = await preparePrivateStoreDirectory(join(root, "store"));
    const path = join(store, "binding.json");
    await exclusiveWritePrivateFile(path, "published");
    await link(path, join(store, "retained-alias.json"));
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const started = Date.now();

    const { reading, state } = await startRead(path);
    while (!state.settled) {
      if (vi.getTimerCount() > 0) await vi.runOnlyPendingTimersAsync();
      else await new Promise<void>((resolve) => setImmediate(resolve));
    }

    await expect(reading).rejects.toThrow(
      `regular file has 2 hard links; exactly one is required: ${path}`,
    );
    const waitedMs = Date.now() - started;
    expect(waitedMs).toBe(315);
  });

  test("refuses a two-link file with an unsafe mode without waiting", async () => {
    const root = await temporaryRoot();
    const store = await preparePrivateStoreDirectory(join(root, "store"));
    const path = join(store, "binding.json");
    await exclusiveWritePrivateFile(path, "published");
    await link(path, join(store, "retained-alias.json"));
    await chmod(path, 0o620);
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const started = Date.now();

    const { reading, state } = await startRead(path);

    expect(state.settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(Date.now() - started).toBe(0);
    await expect(reading).rejects.toThrow(/group\/world writable/);
  });

  test("refuses a file with three links without waiting", async () => {
    const root = await temporaryRoot();
    const store = await preparePrivateStoreDirectory(join(root, "store"));
    const path = join(store, "binding.json");
    await exclusiveWritePrivateFile(path, "published");
    await link(path, join(store, "first-alias.json"));
    await link(path, join(store, "second-alias.json"));
    vi.useFakeTimers({ toFake: ["setTimeout"] });

    const { reading, state } = await startRead(path);

    expect(state.settled).toBe(true);
    await expect(reading).rejects.toThrow(/has 3 hard links/);
  });

  test("refuses missing, symlinked, non-regular and group-writable paths without waiting", async () => {
    const root = await temporaryRoot();
    const store = await preparePrivateStoreDirectory(join(root, "store"));
    const admitted = join(store, "admitted.json");
    await exclusiveWritePrivateFile(admitted, "published");
    const symlinked = join(store, "symlinked.json");
    await symlink(admitted, symlinked);
    const directory = join(store, "directory");
    await mkdir(directory, { mode: 0o700 });
    const groupWritable = join(store, "group-writable.json");
    await writeFile(groupWritable, "published", { mode: 0o600 });
    await chmod(groupWritable, 0o620);
    vi.useFakeTimers({ toFake: ["setTimeout"] });

    for (const [path, refusal] of [
      [join(store, "missing.json"), { code: "ENOENT" }],
      [symlinked, { message: expect.stringMatching(/symbolic link/) }],
      [directory, { message: expect.stringMatching(/not a regular file/) }],
      [groupWritable, { message: expect.stringMatching(/group\/world writable/) }],
    ] as const) {
      const { reading, state } = await startRead(path);
      expect(state.settled, path).toBe(true);
      await expect(reading).rejects.toMatchObject(refusal);
    }
  });
});
