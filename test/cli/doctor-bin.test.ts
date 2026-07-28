import { beforeAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { isMainModule, parseDoctorArgs, runCli } from "../../src/bin/dacs.js";

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
    process.env.DACS_DOCTOR_TEST_SECRET = "secret-value";
    try {
      let stdout = "";
      const code = await runCli(["doctor", "--offline", "--json", "--wallet-secret-env", "DACS_DOCTOR_TEST_SECRET"], {
        stdout: (chunk) => {
          stdout += chunk;
        },
        stderr: () => {},
      });

      expect(code).toBe(5);
      expect(stdout).toContain("[redacted]");
      expect(stdout).not.toContain("secret-value");
    } finally {
      delete process.env.DACS_DOCTOR_TEST_SECRET;
    }
  });

  it("reads wallet secrets from a file without echoing contents", async () => {
    const temp = mkdtempSync(join(tmpdir(), "dacs-secret-"));
    try {
      const secretFile = join(temp, "wallet-secret");
      writeFileSync(secretFile, "file-secret-value\n");
      let stdout = "";
      const code = await runCli(["doctor", "--offline", "--json", "--wallet-secret-file", secretFile], {
        stdout: (chunk) => {
          stdout += chunk;
        },
        stderr: () => {},
      });

      expect(code).toBe(5);
      expect(stdout).toContain("[redacted]");
      expect(stdout).not.toContain("file-secret-value");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("reads wallet secrets from stdin when file is dash", () => {
    const builtBin = join(process.cwd(), "dist", "bin", "dacs.js");
    expect(existsSync(builtBin)).toBe(true);
    const result = spawnSync(
      "node",
      [builtBin, "doctor", "--offline", "--json", "--wallet-secret-file", "-"],
      {
        encoding: "utf8",
        input: "stdin-secret-value\n",
      },
    );

    expect(result.status).toBe(5);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("[redacted]");
    expect(result.stdout).not.toContain("stdin-secret-value");
  });

  it("reads RPC URLs from stdin when file is dash and redacts path tokens", () => {
    const builtBin = join(process.cwd(), "dist", "bin", "dacs.js");
    expect(existsSync(builtBin)).toBe(true);
    const result = spawnSync(
      "node",
      [builtBin, "doctor", "--offline", "--json", "--rpc-file", "-"],
      {
        encoding: "utf8",
        input: "https://eth-mainnet.g.alchemy.com/v2/stdin-api-key\n",
      },
    );

    expect(result.status).toBe(5);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("stdin-api-key");
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
