import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createRecordExclusive,
  ensurePrivateDirectory,
  listRecordNames,
  readRecord,
  removeRecord,
  replaceRecord,
} from "../src/walletSpendFileRecords.js";

const LIMIT = 64;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dacs-file-records-"));
  chmodSync(root, 0o700);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeRaw(name: string, content: string | Buffer, mode = 0o600): string {
  const path = join(root, name);
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
  return path;
}

describe("private directory", () => {
  it("creates a missing directory with mode 0700", async () => {
    const path = join(root, "fresh");
    await ensurePrivateDirectory(path);
    await expect(ensurePrivateDirectory(path)).resolves.toBeUndefined();
  });

  it("refuses a directory with mode 0755, a symlink and a plain file", async () => {
    const open = join(root, "open");
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    const link = join(root, "link");
    symlinkSync(root, link);
    const file = writeRaw("plain", "x");
    for (const path of [open, link, file]) {
      await expect(ensurePrivateDirectory(path)).rejects.toThrow(
        "wallet-spend-file-directory-unsafe",
      );
    }
  });
});

describe("record files", () => {
  it("round-trips a replaced record and ignores a left-over temporary file", async () => {
    const path = join(root, "a.json");
    await replaceRecord(path, { b: 2, a: 1 });
    await replaceRecord(path, { a: 3 });
    writeRaw("a.json.1.abc.tmp", "{");
    await expect(readRecord(path, LIMIT)).resolves.toEqual({ a: 3 });
    expect(readFileSync(path, "utf8")).toBe('{"a":3}');
    await expect(listRecordNames(root)).resolves.toEqual(["a.json"]);
  });

  it("creates a record once and keeps the first content", async () => {
    const path = join(root, "b.json");
    await expect(createRecordExclusive(path, { first: true })).resolves.toBe(true);
    await expect(createRecordExclusive(path, { first: false })).resolves.toBe(false);
    await expect(readRecord(path, LIMIT)).resolves.toEqual({ first: true });
    await expect(listRecordNames(root)).resolves.toEqual(["b.json"]);
  });

  it("returns undefined for a missing record and removes a missing record quietly", async () => {
    const path = join(root, "none.json");
    await expect(readRecord(path, LIMIT)).resolves.toBeUndefined();
    await expect(removeRecord(path)).resolves.toBeUndefined();
    await replaceRecord(path, {});
    await removeRecord(path);
    await expect(readRecord(path, LIMIT)).resolves.toBeUndefined();
  });

  it("refuses an empty file, an oversized file, bad JSON, non-canonical JSON, a symlink and mode 0644", async () => {
    const target = writeRaw("target.json", '{"a":1}');
    const link = join(root, "link.json");
    symlinkSync(target, link);
    const damaged = [
      writeRaw("empty.json", ""),
      writeRaw("big.json", `"${"x".repeat(LIMIT - 1)}"`),
      writeRaw("bad.json", "{"),
      writeRaw("spaced.json", '{"a": 1}'),
      writeRaw("bad-utf8.json", Buffer.from([0x22, 0xff, 0x22])),
      link,
      writeRaw("open.json", '{"a":1}', 0o644),
    ];
    for (const path of damaged) {
      await expect(readRecord(path, LIMIT)).rejects.toThrow("wallet-spend-file-record-damaged");
    }
  });

  it("reads a record of exactly the limit", async () => {
    const path = writeRaw("edge.json", `"${"x".repeat(LIMIT - 2)}"`);
    await expect(readRecord(path, LIMIT)).resolves.toBe("x".repeat(LIMIT - 2));
  });
});
