import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chmodSync, constants, existsSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import { isMainModule, parseDoctorArgs, runCli } from "../../src/bin/dacs.js";
import type { DoctorReport } from "../../src/cli/index.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync), fstatSync: vi.fn(actual.fstatSync) };
});

const adapterCalls = vi.hoisted(() => ({ factory: vi.fn(), connect: vi.fn(), address: vi.fn() }));
vi.mock("../../src/substrate/index.js", () => ({
  DemosAdapter: class {
    constructor(config: unknown) { adapterCalls.factory(config); }
    async connect() { adapterCalls.connect(); }
    getAddress() { adapterCalls.address(); return "unused"; }
  },
}));

afterEach(() => {
  vi.mocked(fs.fstatSync).mockReset();
  vi.clearAllMocks();
});

describe("dacs bin", () => {
  beforeAll(() => {
    const tscBin = join(process.cwd(), "node_modules", "typescript", "bin", "tsc");
    const runner = "bun" in process.versions ? "bun" : process.execPath;
    const result = spawnSync(runner, [tscBin, "-p", "tsconfig.build.json"], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`failed to build CLI before bin tests\n${result.stdout}\n${result.stderr}`);
    }
  // The suite runs this redundant package build alongside CPU-heavy worker
  // pools; the dedicated CI build step remains the correctness gate.
  }, 60_000);

  it.skipIf(process.platform === "win32").each(
    (["rpc", "wallet"] as const).flatMap((source) =>
      (["symlink", "mode", "owner", "initial-mode", "initial-owner"] as const)
        .map((problem) => ({ source, problem }))),
  )("blocks adapter creation after $source file $problem admission fails", async ({ source, problem }) => {
    const temp = mkdtempSync(join(tmpdir(), "dacs-adapter-admission-"));
    const secret = randomBytes(32).toString("hex");
    const path = join(temp, secret);
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    try {
      writeFileSync(path, source === "rpc" ? `https://node.example/${secret}` : secret, { mode: 0o600 });
      let input = path;
      if (problem === "symlink") { input = `${path}-link`; symlinkSync(path, input); }
      if (problem === "mode") chmodSync(path, 0o644);
      if (problem === "owner") {
        vi.mocked(fs.fstatSync).mockImplementationOnce((...args) => {
          const stat = actual.fstatSync(...args);
          stat.uid = process.getuid!() + 1;
          return stat;
        });
      }
      // Unsafe at lstat, safe by open: both snapshots must be admissible.
      if (problem === "initial-mode") {
        chmodSync(path, 0o644);
        vi.mocked(fs.lstatSync).mockImplementationOnce((...args) => {
          const initial = actual.lstatSync(...args);
          chmodSync(path, 0o600);
          return initial;
        });
      }
      if (problem === "initial-owner") {
        vi.mocked(fs.lstatSync).mockImplementationOnce((...args) => {
          const initial = actual.lstatSync(...args);
          initial!.uid = process.getuid!() + 1;
          return initial;
        });
      }
      const checkId = `config.${source}-file.${problem.replace("initial-", "")}`;
      let output = "";
      const code = await runCli(["doctor", "--json",
        ...(source === "wallet" ? ["--rpc", "https://node.example", "--wallet-secret-file", input] : ["--rpc-file", input]),
      ], { stdout: (chunk) => { output += chunk; }, stderr: (chunk) => { output += chunk; } });
      expect(code).toBe(1);
      const report = JSON.parse(output) as DoctorReport;
      expect(report.checks.find((c) => c.id === checkId)?.status).toBe("fail");
      expect(report.checks.find((c) => c.id === "rpc.reachable")?.status).toBe("skip");
      expect(adapterCalls.factory).not.toHaveBeenCalled();
      expect(adapterCalls.connect).not.toHaveBeenCalled();
      expect(adapterCalls.address).not.toHaveBeenCalled();
      expect(output).not.toContain(secret);
      expect(output).not.toContain(temp);
    } finally {
      vi.mocked(fs.lstatSync).mockReset();
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it.each(["rpc", "wallet"] as const)("refuses an empty %s credential file before adapter use", async (source) => {
    const temp = mkdtempSync(join(tmpdir(), "dacs-empty-"));
    const path = join(temp, randomBytes(16).toString("hex"));
    try {
      writeFileSync(path, "", { mode: 0o600 });
      let stdout = "";
      let stderr = "";
      const code = await runCli(["doctor", "--json",
        ...(source === "wallet" ? ["--rpc", "https://node.example", "--wallet-secret-file", path] : ["--rpc-file", path]),
      ], { stdout: (chunk) => { stdout += chunk; }, stderr: (chunk) => { stderr += chunk; } });
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toContain(`Could not read ${source} credential file`);
      expect(stderr).not.toContain(temp);
      expect(adapterCalls.factory).not.toHaveBeenCalled();
      expect(adapterCalls.connect).not.toHaveBeenCalled();
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it.each(["rpc", "wallet"] as const)("reports safe and unsafe %s file modes without credential or path leakage", async (source) => {
    const temp = mkdtempSync(join(tmpdir(), "dacs-mode-"));
    const secret = randomBytes(32).toString("hex");
    const path = join(temp, secret);
    const flag = source === "rpc" ? "--rpc-file" : "--wallet-secret-file";
    try {
      writeFileSync(path, source === "rpc" ? `https://node.example/${secret}\n` : `${secret}\n`);
      for (const mode of [0o600, 0o644, 0o640, 0o400, 0o700]) {
        chmodSync(path, mode);
        let stdout = "";
        let stderr = "";
        const code = await runCli(["doctor", "--offline", "--json", flag, path, "--rail", "pay-dem"], {
          stdout: (chunk) => { stdout += chunk; }, stderr: (chunk) => { stderr += chunk; },
        });
        expect(code).toBe(process.platform !== "win32" && mode !== 0o600 ? 1 : 5);
        expect(stderr).toBe("");
        expect(stdout).not.toContain(path);
        expect(stdout).not.toContain(temp);
        expect(stdout).not.toContain(secret);
        const report = JSON.parse(stdout) as DoctorReport;
        expect(report.checks.find((c) => c.id === `config.${source}-file.symlink`)?.status).toBe("pass");
        if (process.platform === "win32") {
          expect(report.checks.find((c) => c.id === `config.${source}-file.mode`)?.status).toBe("skip");
        } else {
          expect(report.checks.find((c) => c.id === `config.${source}-file.mode`)).toMatchObject({
            status: mode === 0o600 ? "pass" : "fail", data: { mode: mode.toString(8).padStart(4, "0") },
          });
          expect(report.checks.find((c) => c.id === `config.${source}-file.owner`)).toMatchObject({
            status: typeof process.getuid === "function" ? "pass" : "skip",
            ...(typeof process.getuid === "function" ? { data: { ownerUid: statSync(path).uid, currentUid: process.getuid() } } : {}),
          });
        }
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects symlinked credential files in JSON and text without exposing either path", async () => {
    const temp = mkdtempSync(join(tmpdir(), "dacs-link-"));
    const secret = randomBytes(32).toString("hex");
    const target = join(temp, secret);
    const link = join(temp, `${secret}-link`);
    try {
      writeFileSync(target, secret, { mode: 0o600 });
      symlinkSync(target, link);
      for (const json of [true, false]) {
        let output = "";
        const code = await runCli(["doctor", "--offline", ...(json ? ["--json"] : []), "--wallet-secret-file", link], {
          stdout: (chunk) => { output += chunk; }, stderr: (chunk) => { output += chunk; },
        });
        expect(code).toBe(1);
        expect(output).not.toContain(secret);
        expect(output).not.toContain(temp);
        expect(output).toContain("Credential file is a symbolic link");
        if (json) {
          const report = JSON.parse(output) as DoctorReport;
          expect(report.checks.find((c) => c.id === "config.wallet-file.symlink")?.status).toBe("fail");
        } else {
          expect(output).toContain("config.wallet-file.symlink: fail");
        }
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("reports path-free failures for missing, dangling, and nonregular credential files", async () => {
    const temp = mkdtempSync(join(tmpdir(), "dacs-error-"));
    const secret = randomBytes(32).toString("hex");
    const missing = join(temp, secret);
    const link = join(temp, `${secret}-link`);
    const directoryLink = join(temp, `${secret}-directory-link`);
    try {
      symlinkSync(missing, link);
      symlinkSync(temp, directoryLink);
      for (const flag of ["--rpc-file", "--wallet-secret-file"]) {
        for (const [path, expectedCode] of [[missing, 2], [link, 1], [temp, 2], [directoryLink, 1]] as const) {
          let stdout = "";
          let stderr = "";
          const code = await runCli(["doctor", "--offline", "--json", flag, path], {
            stdout: (chunk) => { stdout += chunk; }, stderr: (chunk) => { stderr += chunk; },
          });
          expect(code).toBe(expectedCode);
          if (expectedCode === 2) {
            expect(stdout).toBe("");
            expect(stderr).toContain("credential file");
          } else {
            expect(stderr).toBe("");
            const report = JSON.parse(stdout) as DoctorReport;
            expect(report.checks.some((c) => c.id.endsWith("-file.symlink") && c.status === "fail")).toBe(true);
          }
          expect(stdout + stderr).not.toContain(temp);
          expect(stdout + stderr).not.toContain(secret);
        }
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it.skipIf(!constants.O_NOFOLLOW).each(["file", "symlink"])("refuses a regular credential file replaced by a %s between inspection and open", async (replacement) => {
    const temp = mkdtempSync(join(tmpdir(), "dacs-replace-"));
    const secret = randomBytes(32).toString("hex");
    const path = join(temp, secret);
    const originalLstat = (await vi.importActual<typeof import("node:fs")>("node:fs")).lstatSync;
    writeFileSync(path, secret, { mode: 0o600 });
    const spy = vi.mocked(fs.lstatSync).mockImplementationOnce((...args) => {
      const initial = originalLstat(...args);
      renameSync(path, `${path}-original`);
      if (replacement === "symlink") symlinkSync(`${path}-original`, path);
      else writeFileSync(path, randomBytes(32).toString("hex"), { mode: 0o644 });
      return initial;
    });
    try {
      let output = "";
      const code = await runCli(["doctor", "--offline", "--json", "--wallet-secret-file", path], {
        stdout: (chunk) => { output += chunk; }, stderr: (chunk) => { output += chunk; },
      });
      expect(code).toBe(2);
      expect(output).toContain("Could not read wallet credential file");
      expect(output).not.toContain(secret);
      expect(output).not.toContain(temp);
    } finally {
      spy.mockReset();
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects a credential symlink to a FIFO without blocking", () => {
    const temp = mkdtempSync(join(tmpdir(), "dacs-fifo-"));
    const secret = randomBytes(32).toString("hex");
    const target = join(temp, secret);
    const link = `${target}-link`;
    try {
      expect(spawnSync("mkfifo", [target]).status).toBe(0);
      symlinkSync(target, link);
      const builtBin = join(process.cwd(), "dist", "bin", "dacs.js");
      const result = spawnSync(process.execPath, [builtBin, "doctor", "--offline", "--wallet-secret-file", link], {
        encoding: "utf8", timeout: 2000,
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("config.wallet-file.symlink: fail");
      expect(result.stderr).toBe("");
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain(temp);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("refuses a regular credential file replaced by a FIFO between inspection and open without blocking", () => {
    const temp = mkdtempSync(join(tmpdir(), "dacs-fifo-swap-"));
    const secret = randomBytes(32).toString("hex");
    const target = join(temp, secret);
    const preload = join(temp, "swap-to-fifo.mjs");
    try {
      writeFileSync(target, secret, { mode: 0o600 });
      // The built CLI imports fs bindings, so swap after its first lstat in-process.
      writeFileSync(preload, [
        'import fs from "node:fs";',
        'import { execFileSync } from "node:child_process";',
        'import { syncBuiltinESMExports } from "node:module";',
        `const target = ${JSON.stringify(target)};`,
        "const lstatSync = fs.lstatSync;",
        "let swapped = false;",
        "fs.lstatSync = (path, ...rest) => {",
        "  const initial = lstatSync(path, ...rest);",
        "  if (path === target && !swapped) {",
        "    swapped = true;",
        '    fs.renameSync(target, `${target}-original`);',
        '    execFileSync("mkfifo", [target]);',
        "  }",
        "  return initial;",
        "};",
        "syncBuiltinESMExports();",
      ].join("\n"));
      const builtBin = join(process.cwd(), "dist", "bin", "dacs.js");
      // A blocking open waits for a FIFO writer forever; the timeout turns that into a failure.
      const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, builtBin,
        "doctor", "--offline", "--wallet-secret-file", target], {
        encoding: "utf8", timeout: 10_000, env: { ...process.env, NODE_NO_WARNINGS: "1" },
      });
      expect(result.signal).toBeNull();
      expect(result.status).toBe(2);
      expect(statSync(target).isFIFO()).toBe(true);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Could not read wallet credential file");
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain(temp);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }, 30_000);

  it("parses doctor flags", () => {
    expect(
      parseDoctorArgs([
        "--offline",
        "--json",
        "--rpc",
        "https://node.example",
        "--rail",
        "x402",
      ]),
    ).toEqual({
      offline: true,
      json: true,
      rpc: "https://node.example",
      rail: "x402",
    });
  });

  it("parses RPC indirection flags", () => {
    expect(
      parseDoctorArgs([
        "--offline",
        "--rpc-env",
        "DACS_RPC_URL",
        "--wallet-secret-env",
        "DACS_WALLET_SECRET",
      ]),
    ).toEqual({
      offline: true,
      rpcEnv: "DACS_RPC_URL",
      walletSecretEnv: "DACS_WALLET_SECRET",
    });
  });

  it("parses wallet secret file input", () => {
    expect(
      parseDoctorArgs([
        "--offline",
        "--wallet-secret-file",
        "/run/secrets/dacs-wallet",
        "--rail",
        "x402",
      ]),
    ).toEqual({
      offline: true,
      walletSecretFile: "/run/secrets/dacs-wallet",
      rail: "x402",
    });
  });

  it("prints offline JSON", async () => {
    let stdout = "";
    let stderr = "";
    const code = await runCli(["doctor", "--offline", "--json"], {
      stdout: (chunk) => {
        stdout += chunk;
      },
      stderr: (chunk) => {
        stderr += chunk;
      },
    });

    expect(code).toBe(5);
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout) as { exitCode: number; mode: string; tool: string };
    expect(parsed.tool).toBe("dacs-doctor");
    expect(parsed.mode).toBe("offline");
    expect(parsed.exitCode).toBe(5);
  });

  it("reads wallet secrets from env indirection, not argv", async () => {
    const secret = randomBytes(32).toString("hex");
    process.env.DACS_DOCTOR_TEST_SECRET = secret;
    process.env.DACS_DOCTOR_TEST_RPC = `https://node.example/${secret}`;
    try {
      let stdout = "";
      const code = await runCli(["doctor", "--offline", "--json", "--wallet-secret-env", "DACS_DOCTOR_TEST_SECRET", "--rpc-env", "DACS_DOCTOR_TEST_RPC"], {
        stdout: (chunk) => {
          stdout += chunk;
        },
        stderr: () => {},
      });

      expect(code).toBe(5);
      expect(stdout).toContain("[redacted]");
      expect(stdout).not.toContain(secret);
      expect(stdout).not.toContain("config.wallet-file");
      expect(stdout).not.toContain("config.rpc-file");
    } finally {
      delete process.env.DACS_DOCTOR_TEST_SECRET;
      delete process.env.DACS_DOCTOR_TEST_RPC;
    }
  });

  it("reads wallet secrets from a file without echoing contents", async () => {
    const temp = mkdtempSync(join(tmpdir(), "dacs-secret-"));
    try {
      const secretFile = join(temp, "wallet-secret");
      const secret = randomBytes(32).toString("hex");
      writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 });
      let stdout = "";
      const code = await runCli(["doctor", "--offline", "--json", "--wallet-secret-file", secretFile], {
        stdout: (chunk) => {
          stdout += chunk;
        },
        stderr: () => {},
      });

      expect(code).toBe(5);
      expect(stdout).toContain("[redacted]");
      expect(stdout).not.toContain(secret);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("reads wallet secrets from stdin when file is dash", () => {
    const secret = randomBytes(32).toString("hex");
    const builtBin = join(process.cwd(), "dist", "bin", "dacs.js");
    expect(existsSync(builtBin)).toBe(true);
    const result = spawnSync(
      "node",
      [builtBin, "doctor", "--offline", "--json", "--wallet-secret-file", "-"],
      {
        encoding: "utf8",
        input: `${secret}\n`,
      },
    );

    expect(result.status).toBe(5);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("[redacted]");
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).not.toContain("config.wallet-file");
  });

  it("reads RPC URLs from stdin when file is dash and redacts path tokens", () => {
    const secret = randomBytes(32).toString("hex");
    const builtBin = join(process.cwd(), "dist", "bin", "dacs.js");
    expect(existsSync(builtBin)).toBe(true);
    const result = spawnSync(
      "node",
      [builtBin, "doctor", "--offline", "--json", "--rpc-file", "-"],
      {
        encoding: "utf8",
        input: `https://node.example/${secret}\n`,
      },
    );

    expect(result.status).toBe(5);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).not.toContain("config.rpc-file");
    expect(result.stdout).toContain("Offline mode skips RPC reachability");
  });

  it("prints help for doctor help", async () => {
    let stdout = "";
    const code = await runCli(["doctor", "--help"], {
      stdout: (chunk) => {
        stdout += chunk;
      },
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(stdout).toContain("dacs doctor");
  });

  it("prints help regardless of other doctor flags", async () => {
    let stdout = "";
    const code = await runCli(["doctor", "--offline", "--help"], {
      stdout: (chunk) => {
        stdout += chunk;
      },
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(stdout).toContain("dacs doctor");
  });

  it("returns usage error for invalid options", async () => {
    let stderr = "";
    const code = await runCli(["doctor", "--wat"], {
      stdout: () => {},
      stderr: (chunk) => {
        stderr += chunk;
      },
    });

    expect(code).toBe(2);
    expect(stderr).toContain("unknown option");
  });

  it("returns usage error for missing option values", async () => {
    let stderr = "";
    const code = await runCli(["doctor", "--rpc"], {
      stdout: () => {},
      stderr: (chunk) => {
        stderr += chunk;
      },
    });

    expect(code).toBe(2);
    expect(stderr).toContain("--rpc requires a value");
  });

  it("rejects credential-bearing direct RPC URLs", async () => {
    for (const rpc of [
      "https://user:pass@node.example",
      "https://eth-mainnet.g.alchemy.com/v2/api-key",
      "https://node.example?token=secret",
    ]) {
      let stderr = "";
      const code = await runCli(["doctor", "--rpc", rpc], {
        stdout: () => {},
        stderr: (chunk) => {
          stderr += chunk;
        },
      });

      expect(code).toBe(2);
      expect(stderr).toContain("--rpc accepts origin-only URLs");
    }
  });

  it("returns usage error for missing secret env", async () => {
    let stderr = "";
    const code = await runCli(["doctor", "--offline", "--wallet-secret-env", "DACS_DOCTOR_MISSING"], {
      stdout: () => {},
      stderr: (chunk) => {
        stderr += chunk;
      },
    });

    expect(code).toBe(2);
    expect(stderr).toContain("DACS_DOCTOR_MISSING is not set");
  });

  it("returns usage error for missing RPC env", async () => {
    let stderr = "";
    const code = await runCli(["doctor", "--rpc-env", "DACS_RPC_MISSING"], {
      stdout: () => {},
      stderr: (chunk) => {
        stderr += chunk;
      },
    });

    expect(code).toBe(2);
    expect(stderr).toContain("DACS_RPC_MISSING is not set");
  });

  it("rejects reading both RPC and wallet secret from stdin", async () => {
    let stderr = "";
    const code = await runCli(["doctor", "--rpc-file", "-", "--wallet-secret-file", "-"], {
      stdout: () => {},
      stderr: (chunk) => {
        stderr += chunk;
      },
    });

    expect(code).toBe(2);
    expect(stderr).toContain("only one secret source can read from stdin");
  });

  it("detects main module through installed-style symlink paths", () => {
    const temp = mkdtempSync(join(tmpdir(), "dacs-main-"));
    try {
      const target = join(temp, "target.js");
      const link = join(temp, "dacs");
      writeFileSync(target, "");
      symlinkSync(target, link);
      expect(isMainModule(`file://${target}`, link)).toBe(true);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("runs the built bin through an installed-style symlink", () => {
    const builtBin = join(process.cwd(), "dist", "bin", "dacs.js");
    expect(existsSync(builtBin)).toBe(true);
    chmodSync(builtBin, 0o755);
    const temp = mkdtempSync(join(tmpdir(), "dacs-bin-"));
    try {
      const link = join(temp, "dacs");
      symlinkSync(builtBin, link);
      const result = spawnSync(link, ["doctor", "--offline", "--json"], {
        encoding: "utf8",
      });

      expect(result.status).toBe(5);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout) as { mode: string; tool: string };
      expect(parsed.tool).toBe("dacs-doctor");
      expect(parsed.mode).toBe("offline");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
