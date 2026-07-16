import { describe, expect, it } from "vitest";

import { parseDoctorArgs, runCli } from "../../src/bin/dacs.js";

describe("dacs bin", () => {
  it("parses doctor flags", () => {
    expect(
      parseDoctorArgs([
        "--offline",
        "--json",
        "--rpc",
        "https://node.example",
        "--wallet-secret",
        "secret",
        "--rail",
        "x402",
      ]),
    ).toEqual({
      offline: true,
      json: true,
      rpc: "https://node.example",
      walletSecret: "secret",
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

    expect(code).toBe(0);
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout) as { tool: string; mode: string };
    expect(parsed.tool).toBe("dacs-doctor");
    expect(parsed.mode).toBe("offline");
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
});
