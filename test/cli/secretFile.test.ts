import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDoctorCredentialStdin, readDoctorSecretFile } from "../../src/cli/secretFile.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync), openSync: vi.fn(actual.openSync),
    fstatSync: vi.fn(actual.fstatSync), readSync: vi.fn(actual.readSync),
    readFileSync: vi.fn(actual.readFileSync), closeSync: vi.fn(actual.closeSync) };
});

const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
const limit = 65_536;
const directories: string[] = [];
function fixture(bytes = randomBytes(32)): string {
  const directory = fs.mkdtempSync(join(tmpdir(), "dacs-admission-"));
  directories.push(directory);
  const path = join(directory, randomBytes(16).toString("hex"));
  fs.writeFileSync(path, bytes, { mode: 0o600 });
  return path;
}
afterEach(() => {
  vi.mocked(fs.lstatSync).mockImplementation(actual.lstatSync);
  vi.mocked(fs.openSync).mockImplementation(actual.openSync);
  vi.mocked(fs.fstatSync).mockImplementation(actual.fstatSync);
  vi.mocked(fs.readSync).mockImplementation(actual.readSync);
  vi.mocked(fs.readFileSync).mockImplementation(actual.readFileSync);
  vi.mocked(fs.closeSync).mockImplementation(actual.closeSync);
  vi.clearAllMocks();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function expectNoRead(): void {
  expect(fs.readSync).not.toHaveBeenCalled();
  expect(fs.readFileSync).not.toHaveBeenCalled();
}

describe("doctor credential descriptor admission", () => {
  it("accepts exactly 65,536 bytes", () => {
    const secret = randomBytes(limit / 2).toString("hex");
    expect(readDoctorSecretFile(fixture(Buffer.from(secret)), "wallet").value).toBe(secret);
  });

  // Oversized pathnames are refused before opening; descriptor size is covered by the growth tests.
  it.each([limit + 1, 1_048_576])("rejects a %i-byte credential before reading", (size) => {
    const path = fixture(randomBytes(size));
    expect(() => readDoctorSecretFile(path, "wallet")).toThrow("Could not read wallet credential file");
    expect(fs.openSync).not.toHaveBeenCalled();
    expectNoRead();
  });

  it("rejects a sparse oversized descriptor before reading", () => {
    const path = fixture();
    fs.truncateSync(path, 64 * 1024 * 1024);
    expect(() => readDoctorSecretFile(path, "rpc")).toThrow("Could not read rpc credential file");
    expect(fs.openSync).not.toHaveBeenCalled();
    expectNoRead();
  });

  it("rejects descriptor growth between lstat and open before reading", () => {
    const path = fixture();
    vi.mocked(fs.lstatSync).mockImplementationOnce((...args) => {
      const initial = actual.lstatSync(...args);
      fs.truncateSync(path, limit + 1);
      return initial;
    });
    expect(() => readDoctorSecretFile(path, "wallet")).toThrow("Could not read wallet credential file");
    expectNoRead();
    expect(fs.closeSync).toHaveBeenCalledOnce();
  });

  it("bounds growth during partial reads to limit plus one byte", () => {
    const path = fixture(Buffer.from(randomBytes(8).toString("hex")));
    // The old unbounded reader must see the same adversarial growth.
    vi.mocked(fs.readFileSync).mockImplementationOnce((...args) => {
      fs.appendFileSync(path, randomBytes(1_048_576));
      return actual.readFileSync(...args);
    });
    let requested = 0;
    let calls = 0;
    const readSync = vi.mocked(fs.readSync as (
      fd: number, buffer: Buffer, offset: number, length: number, position: number | null,
    ) => number);
    readSync.mockImplementation((fd, buffer, offset, length, position) => {
      requested += length;
      const read = actual.readSync(fd, buffer, offset, calls++ === 0 ? Math.min(length, 7) : length, position);
      if (calls === 1) fs.appendFileSync(path, randomBytes(1_048_576));
      return read;
    });
    expect(() => readDoctorSecretFile(path, "wallet")).toThrow("Could not read wallet credential file");
    // Each request is bounded by the remaining capacity, even on short reads.
    expect(fs.readFileSync).not.toHaveBeenCalled();
    const readCalls = readSync.mock.calls;
    expect(readCalls.length).toBeGreaterThan(1);
    expect(readCalls[0]?.[3]).toBe(limit + 1);
    expect(readCalls[1]?.[3]).toBe(limit + 1 - 7);
    expect(requested).toBeLessThanOrEqual(2 * (limit + 1));
    expect(fs.closeSync).toHaveBeenCalledOnce();
  });

  it("rejects an initial symlink without opening or reading it", () => {
    const path = fixture();
    const link = `${path}-link`;
    fs.symlinkSync(path, link);
    expect(readDoctorSecretFile(link, "wallet").value).toBeUndefined();
    expect(fs.openSync).not.toHaveBeenCalled();
    expectNoRead();
  });

  it.skipIf(process.platform === "win32").each([0o644, 0o640, 0o400, 0o700])(
    "rejects mode %i without reading the descriptor", (mode) => {
      const path = fixture();
      fs.chmodSync(path, mode);
      expect(readDoctorSecretFile(path, "wallet").value).toBeUndefined();
      expect(fs.openSync).not.toHaveBeenCalled();
      expectNoRead();
    },
  );

  it.skipIf(process.platform === "win32" || typeof process.getuid !== "function")(
    "rejects a descriptor owner mismatch without reading", () => {
      const path = fixture();
      vi.mocked(fs.fstatSync).mockImplementationOnce((...args) => {
        const stat = actual.fstatSync(...args);
        stat.uid = process.getuid!() + 1;
        return stat;
      });
      expect(readDoctorSecretFile(path, "wallet").value).toBeUndefined();
      expectNoRead();
      expect(fs.closeSync).toHaveBeenCalledOnce();
    },
  );

  it("applies the host's mode rule on Windows without reading", () => {
    const path = fixture();
    fs.chmodSync(path, 0o666);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
      const result = readDoctorSecretFile(path, "wallet");
      expect(result.value).toBeUndefined();
      expect(result.file).toMatchObject({ platform: "win32", symlink: false });
      expect((result.file.mode ?? 0) & 0o777).toBe(0o666);
      expect(fs.openSync).not.toHaveBeenCalled();
      expectNoRead();
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it.skipIf(!fs.constants.O_NOFOLLOW || !fs.constants.O_NONBLOCK)("opens without following links or blocking", () => {
    const secret = randomBytes(32).toString("hex");
    const path = fixture(Buffer.from(secret));
    expect(readDoctorSecretFile(path, "wallet").value).toBe(secret);
    expect(fs.openSync).toHaveBeenCalledWith(path,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  });

  it("reports a symlink swapped in after lstat as a symlink", () => {
    const path = fixture();
    vi.mocked(fs.openSync).mockImplementationOnce(() => {
      throw Object.assign(new Error(`ELOOP: too many symbolic links, open '${path}'`), { code: "ELOOP" });
    });
    const result = readDoctorSecretFile(path, "wallet");
    expect(result.value).toBeUndefined();
    expect(result.file).toMatchObject({ symlink: true });
    expect(result.file.mode).toBeUndefined();
    expectNoRead();
  });

  it.each([
    ["device", (stat: fs.Stats) => { stat.dev += 1; }],
    ["inode", (stat: fs.Stats) => { stat.ino += 1; }],
    ["type", (stat: fs.Stats) => { stat.isFile = () => false; }],
  ])("rejects a descriptor whose %s differs from the inspected path", (_label, change) => {
    const path = fixture();
    vi.mocked(fs.fstatSync).mockImplementationOnce((...args) => {
      const stat = actual.fstatSync(...args);
      change(stat as fs.Stats);
      return stat;
    });
    expect(() => readDoctorSecretFile(path, "wallet")).toThrow("Could not read wallet credential file");
    expectNoRead();
    expect(fs.closeSync).toHaveBeenCalledOnce();
  });

  it("rejects growth past the limit from a file of exactly the limit", () => {
    const path = fixture(Buffer.alloc(limit, 0x61));
    vi.mocked(fs.fstatSync).mockImplementationOnce((...args) => {
      const admitted = actual.fstatSync(...args);
      fs.appendFileSync(path, "a");
      return admitted;
    });
    // A short first read stops at the limit, so only a further read sees the growth.
    vi.mocked(fs.readSync as (fd: number, buffer: Buffer, offset: number, length: number,
      position: number | null) => number).mockImplementationOnce((fd, buffer, offset, length, position) =>
      actual.readSync(fd, buffer, offset, Math.min(length, limit), position));
    expect(() => readDoctorSecretFile(path, "wallet")).toThrow("Could not read wallet credential file");
    expect(fs.readSync).toHaveBeenCalledTimes(2);
  });

  it("trims surrounding whitespace like the host consumer", () => {
    const secret = randomBytes(32).toString("hex");
    expect(readDoctorSecretFile(fixture(Buffer.from(` \t${secret}\r\n\n`)), "wallet").value).toBe(secret);
  });

  it("decodes valid multibyte UTF-8 filling the limit exactly", () => {
    const secret = "é".repeat(limit / 2);
    expect(Buffer.byteLength(secret)).toBe(limit);
    expect(readDoctorSecretFile(fixture(Buffer.from(secret)), "wallet").value).toBe(secret);
  });

  it.each([
    ["whitespace only", Buffer.from("\n\n  \t\r\n")],
    ["an invalid byte", Buffer.from([0xff])],
    ["an encoded surrogate", Buffer.from([0x61, 0xed, 0xa0, 0x80])],
    ["an overlong encoding", Buffer.from([0xc0, 0xaf])],
    ["a multibyte sequence cut at the limit", Buffer.concat([Buffer.alloc(limit - 1, 0x61), Buffer.from([0xc3])])],
    // The host's demosRuntime text() refuses NUL, so admitting it would be a false pass.
    ["a NUL byte", Buffer.from("abc\0def\n")],
  ])("refuses credential content with %s", (_label, bytes) => {
    const path = fixture(bytes);
    expect(() => readDoctorSecretFile(path, "rpc"))
      .toThrow("Could not use rpc credential file; it must contain non-empty UTF-8 text without NUL");
    expect(fs.closeSync).toHaveBeenCalledOnce();
  });

  it("refuses a directory as not regular before opening it", () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "dacs-admission-dir-"));
    directories.push(directory);
    expect(() => readDoctorSecretFile(directory, "rpc"))
      .toThrow("Could not read rpc credential file; check that it is a readable regular file");
    expect(fs.openSync).not.toHaveBeenCalled();
    expectNoRead();
  });

  it.each(["EACCES", "ENOENT"])("reports %s from open after lstat as unreadable, not as a symlink", (code) => {
    const path = fixture();
    vi.mocked(fs.openSync).mockImplementationOnce(() => {
      throw Object.assign(new Error(`${code}: open '${path}'`), { code });
    });
    let message = "";
    try {
      readDoctorSecretFile(path, "wallet");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("Could not read wallet credential file; check that it is a readable regular file");
    expectNoRead();
  });

  it("reports the admitted descriptor's metadata, not the pathname's", () => {
    const secret = randomBytes(32).toString("hex");
    const path = fixture(Buffer.from(secret));
    let admittedMode = 0;
    vi.mocked(fs.fstatSync).mockImplementationOnce((...args) => {
      const stat = actual.fstatSync(...args) as fs.Stats;
      // Still exactly 0600 in the permission bits, but distinguishable from lstat.
      stat.mode |= 0o4000;
      admittedMode = stat.mode;
      return stat;
    });
    const result = readDoctorSecretFile(path, "wallet");
    expect(result.value).toBe(secret);
    expect(result.file).toEqual({
      source: "wallet",
      symlink: false,
      mode: admittedMode,
      ownerUid: actual.statSync(path).uid,
      currentUid: typeof process.getuid === "function" ? process.getuid() : undefined,
      platform: process.platform,
    });
    expect(result.file.mode).not.toBe(actual.statSync(path).mode);
  });

  it.each([
    ["accepted", Buffer.from(randomBytes(32).toString("hex"))],
    ["refused", Buffer.from([0xff, 0xfe])],
  ])("zeroes the read buffer when content is %s", (_label, content) => {
    const path = fixture(content);
    const buffers: Buffer[] = [];
    vi.mocked(fs.readSync as (fd: number, buffer: Buffer, offset: number, length: number,
      position: number | null) => number).mockImplementation((fd, buffer, offset, length, position) => {
      buffers.push(buffer);
      return actual.readSync(fd, buffer, offset, length, position);
    });
    try {
      readDoctorSecretFile(path, "wallet");
    } catch {
      // Refused content is covered above; only the wipe matters here.
    }
    expect(buffers.length).toBeGreaterThan(0);
    for (const buffer of buffers) expect(buffer.every((byte) => byte === 0)).toBe(true);
  });

  it("keeps owner assessment unavailable when getuid is absent", () => {
    const secret = randomBytes(32).toString("hex");
    const path = fixture(Buffer.from(secret));
    const getuid = Object.getOwnPropertyDescriptor(process, "getuid");
    try {
      Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
      const result = readDoctorSecretFile(path, "wallet");
      expect(result.value).toBe(secret);
      expect(result.file.currentUid).toBeUndefined();
    } finally {
      if (getuid) Object.defineProperty(process, "getuid", getuid);
      else Reflect.deleteProperty(process, "getuid");
    }
  });

  it("reads the inspected descriptor after its pathname is replaced following fstat", () => {
    const secret = randomBytes(32).toString("hex");
    const path = fixture(Buffer.from(secret));
    const replacement = randomBytes(32).toString("hex");
    vi.mocked(fs.fstatSync).mockImplementationOnce((...args) => {
      const admitted = actual.fstatSync(...args);
      fs.renameSync(path, `${path}-original`);
      fs.writeFileSync(path, replacement, { mode: 0o600 });
      return admitted;
    });
    expect(readDoctorSecretFile(path, "wallet").value).toBe(secret);
    expect(fs.closeSync).toHaveBeenCalledOnce();
  });

  it.skipIf(process.platform === "win32")("reports descriptor mode after chmod between lstat and open", () => {
    const path = fixture();
    vi.mocked(fs.lstatSync).mockImplementationOnce((...args) => {
      const initial = actual.lstatSync(...args);
      fs.chmodSync(path, 0o644);
      return initial;
    });
    const result = readDoctorSecretFile(path, "wallet");
    expect((result.file.mode ?? 0) & 0o777).toBe(0o644);
    expect(result.value).toBeUndefined();
    expectNoRead();
  });

  it.skipIf(process.platform === "win32")("rejects an unsafe initial mode made safe before open", () => {
    const path = fixture();
    fs.chmodSync(path, 0o644);
    vi.mocked(fs.lstatSync).mockImplementationOnce((...args) => {
      const initial = actual.lstatSync(...args);
      fs.chmodSync(path, 0o600);
      return initial;
    });
    const result = readDoctorSecretFile(path, "wallet");
    expect(result.value).toBeUndefined();
    expect((result.file.mode ?? 0) & 0o777).toBe(0o644);
    expect(fs.openSync).not.toHaveBeenCalled();
    expectNoRead();
  });

  it.skipIf(process.platform === "win32" || typeof process.getuid !== "function")(
    "rejects an initial owner mismatch fixed before open", () => {
      const path = fixture();
      vi.mocked(fs.lstatSync).mockImplementationOnce((...args) => {
        const initial = actual.lstatSync(...args);
        initial!.uid = process.getuid!() + 1;
        return initial;
      });
      const result = readDoctorSecretFile(path, "wallet");
      expect(result.value).toBeUndefined();
      expect(result.file.ownerUid).toBe(process.getuid!() + 1);
      expect(fs.openSync).not.toHaveBeenCalled();
      expectNoRead();
    },
  );

  it("rejects an empty credential file before opening", () => {
    const path = fixture(Buffer.alloc(0));
    expect(() => readDoctorSecretFile(path, "wallet")).toThrow("Could not read wallet credential file");
    expect(fs.openSync).not.toHaveBeenCalled();
    expectNoRead();
  });

  it("rejects a file empty at lstat and filled before open", () => {
    const path = fixture(Buffer.alloc(0));
    vi.mocked(fs.lstatSync).mockImplementationOnce((...args) => {
      const initial = actual.lstatSync(...args);
      fs.appendFileSync(path, randomBytes(32).toString("hex"));
      return initial;
    });
    expect(() => readDoctorSecretFile(path, "rpc")).toThrow("Could not read rpc credential file");
    expect(fs.openSync).not.toHaveBeenCalled();
    expectNoRead();
  });

  it("rejects a descriptor truncated to empty between lstat and open before reading", () => {
    const path = fixture();
    vi.mocked(fs.lstatSync).mockImplementationOnce((...args) => {
      const initial = actual.lstatSync(...args);
      fs.truncateSync(path, 0);
      return initial;
    });
    expect(() => readDoctorSecretFile(path, "wallet")).toThrow("Could not read wallet credential file");
    expectNoRead();
    expect(fs.closeSync).toHaveBeenCalledOnce();
  });

  it("rejects a credential truncated to empty after descriptor inspection", () => {
    const path = fixture();
    vi.mocked(fs.fstatSync).mockImplementationOnce((...args) => {
      const admitted = actual.fstatSync(...args);
      fs.truncateSync(path, 0);
      return admitted;
    });
    expect(() => readDoctorSecretFile(path, "wallet")).toThrow("Could not read wallet credential file");
    expect(fs.readSync).toHaveBeenCalled();
    expect(fs.closeSync).toHaveBeenCalledOnce();
  });
});

describe("doctor credential stdin", () => {
  type ReadSync = (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => number;

  /** Serve fd 0 from memory in short chunks; return every buffer doctor read into. */
  function serveStdin(input: Buffer, chunk = 4_096): Buffer[] {
    const buffers: Buffer[] = [];
    let served = 0;
    vi.mocked(fs.readSync as ReadSync).mockImplementation((fd, buffer, offset, length) => {
      expect(fd).toBe(0);
      buffers.push(buffer);
      const count = Math.min(length, chunk, input.length - served);
      input.copy(buffer, offset, served, served + count);
      served += count;
      return count;
    });
    return buffers;
  }

  it("accepts exactly 65,536 bytes", () => {
    const secret = randomBytes(limit / 2).toString("hex");
    serveStdin(Buffer.from(secret));
    expect(readDoctorCredentialStdin("wallet")).toBe(secret);
  });

  it.each(["rpc", "wallet"] as const)("refuses %s stdin one byte over the limit, reading no further", (source) => {
    serveStdin(Buffer.alloc(limit + 4_096, 0x61));
    expect(() => readDoctorCredentialStdin(source))
      .toThrow(`Could not use ${source} credential from stdin; it must be at most 65536 bytes`);
    const consumed = vi.mocked(fs.readSync as ReadSync).mock.results
      .reduce((sum, result) => sum + (result.value as number), 0);
    expect(consumed).toBe(limit + 1);
  });

  it.each([
    ["empty", Buffer.alloc(0)],
    ["whitespace only", Buffer.from(" \n\t")],
    ["an invalid byte", Buffer.from([0xff])],
    ["a NUL byte", Buffer.from("abc\0def")],
  ])("refuses stdin content that is %s", (_label, input) => {
    serveStdin(input);
    expect(() => readDoctorCredentialStdin("rpc"))
      .toThrow("Could not use rpc credential from stdin; it must be non-empty UTF-8 text without NUL");
  });

  it("reports a stdin read failure without detail", () => {
    vi.mocked(fs.readSync).mockImplementation(() => {
      throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
    });
    let message = "";
    try {
      readDoctorCredentialStdin("wallet");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("Could not read wallet credential from stdin");
  });

  it.each([
    ["accepted", Buffer.from(randomBytes(32).toString("hex"))],
    ["refused", Buffer.from([0xff, 0xfe])],
    ["oversized", Buffer.alloc(limit + 1, 0x62)],
  ])("zeroes the stdin buffer when content is %s", (_label, input) => {
    const buffers = serveStdin(input);
    try {
      readDoctorCredentialStdin("wallet");
    } catch {
      // Refusals are covered above; only the wipe matters here.
    }
    expect(buffers.length).toBeGreaterThan(0);
    for (const buffer of buffers) expect(buffer.every((byte) => byte === 0)).toBe(true);
  });
});
