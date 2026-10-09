import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDoctorSecretFile } from "../../src/cli/secretFile.js";

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

  it("keeps Windows permission and owner assessment unavailable during admission", () => {
    const secret = randomBytes(32).toString("hex");
    const path = fixture(Buffer.from(secret));
    fs.chmodSync(path, 0o644);
    vi.mocked(fs.fstatSync).mockImplementationOnce((...args) => {
      const stat = actual.fstatSync(...args);
      stat.uid = (process.getuid?.() ?? 0) + 1;
      return stat;
    });
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
      const result = readDoctorSecretFile(path, "wallet");
      expect(result.value).toBe(secret);
      expect(result.file.platform).toBe("win32");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
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
