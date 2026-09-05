import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

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

afterEach(async () => {
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
