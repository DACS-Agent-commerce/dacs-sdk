import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { formatDoctorText, redactRpcUrl, runDoctor } from "../../src/cli/index.js";

describe("dacs doctor", () => {
  it("runs offline without touching the network", async () => {
    const report = await runDoctor({
      offline: true,
      now: () => new Date("2026-07-16T00:00:00.000Z"),
      adapterFactory: () => {
        throw new Error("network should not be touched");
      },
    });

    expect(report.mode).toBe("offline");
    expect(report.exitCode).toBe(5);
    expect(report.checks.find((c) => c.id === "runtime.node")?.status).toBe("pass");
    expect(report.checks.find((c) => c.id === "rpc.reachable")?.status).toBe("skip");
    expect(report.checks.find((c) => c.id === "storage.binding-resolution")?.status).toBe("blocked");
  });

  it("fails unsupported Node versions", async () => {
    const report = await runDoctor({ offline: true, nodeVersion: "v20.10.0" });

    expect(report.exitCode).toBe(1);
    expect(report.checks.find((c) => c.id === "runtime.node")?.status).toBe("fail");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      engines: { node: string };
    };
    expect(report.checks.find((c) => c.id === "runtime.node")?.data?.required).toBe(packageJson.engines.node);
  });

  it("accepts the exact supported Node runtime ranges", async () => {
    expect((await runDoctor({ offline: true, nodeVersion: "v20.19.0" })).checks[0]?.status).toBe(
      "pass",
    );
    expect((await runDoctor({ offline: true, nodeVersion: "v22.12.0" })).checks[0]?.status).toBe(
      "pass",
    );
  });

  it("redacts wallet secrets in report JSON", async () => {
    const secret = "abcd-secret-material-1234";
    const report = await runDoctor({ offline: true, walletSecret: secret });
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("abcd");
    expect(serialized).not.toContain("1234");
    expect(serialized).toContain("[redacted]");
  });

  it("redacts RPC credentials and query tokens in report data", async () => {
    const rpc = "https://user:pass@node.example/rpc?token=secret#frag";
    const report = await runDoctor({
      rpc,
      adapterFactory: () => ({
        connect: async () => {},
        getAddress: () => "unused",
      }),
    });

    const rpcCheck = report.checks.find((c) => c.id === "rpc.reachable");
    expect(rpcCheck?.data?.rpc).toBe("https://node.example/[redacted]?[redacted]#[redacted]");
    expect(JSON.stringify(report)).not.toContain("user:pass");
    expect(JSON.stringify(report)).not.toContain("token=secret");
  });

  it("maps requested RPC failure to exit code 3 without leaking secrets", async () => {
    const secret = "secret-value";
    const rpcUrl = "https://user:pass@node.example/v2/path-secret?token=query-secret#frag-secret";
    const report = await runDoctor({
      rpc: rpcUrl,
      walletSecret: secret,
      adapterFactory: () => ({
        connect: async () => {
          throw new Error(`failed with ${secret} user pass path-secret query-secret frag-secret`);
        },
        getAddress: () => {
          throw new Error("getAddress should not be called after connect failure");
        },
      }),
    });

    expect(report.exitCode).toBe(3);
    const rpc = report.checks.find((c) => c.id === "rpc.reachable");
    expect(rpc?.status).toBe("fail");
    expect(rpc?.detail).toContain("[redacted]");
    expect(rpc?.detail).not.toContain(secret);
    expect(rpc?.detail).not.toContain("path-secret");
    expect(rpc?.detail).not.toContain("query-secret");
    expect(rpc?.detail).not.toContain("frag-secret");
  });

  it("lets non-RPC failures take precedence over RPC failures", async () => {
    const report = await runDoctor({
      nodeVersion: "v20.10.0",
      rpc: "https://example.invalid",
      adapterFactory: () => ({
        connect: async () => {
          throw new Error("network down");
        },
        getAddress: () => "unused",
      }),
    });

    expect(report.exitCode).toBe(1);
    expect(report.checks.find((c) => c.id === "runtime.node")?.status).toBe("fail");
    expect(report.checks.find((c) => c.id === "rpc.reachable")?.status).toBe("fail");
  });

  it("separates adapter load failures from RPC reachability failures", async () => {
    const report = await runDoctor({
      rpc: "https://node.example",
      walletSecret: "secret-value",
      adapterFactory: () => {
        throw new Error("adapter import failed with secret-value");
      },
    });

    expect(report.exitCode).toBe(1);
    const adapterLoad = report.checks.find((c) => c.id === "substrate.adapter-load");
    expect(adapterLoad?.status).toBe("fail");
    expect(adapterLoad?.detail).toContain("[redacted]");
    expect(adapterLoad?.detail).not.toContain("secret-value");
    expect(report.checks.some((c) => c.id === "rpc.reachable" && c.status === "fail")).toBe(false);
  });

  it("derives wallet identity only after RPC connection succeeds", async () => {
    const report = await runDoctor({
      rpc: "https://node.example",
      walletSecret: "secret-value",
      adapterFactory: () => ({
        connect: async () => {},
        getAddress: () => "demos-address",
      }),
    });

    expect(report.exitCode).toBe(5);
    expect(report.checks.find((c) => c.id === "wallet.identity")?.status).toBe("pass");
    expect(report.checks.find((c) => c.id === "wallet.identity")?.data?.address).toBe(
      "demos-address",
    );
  });

  it("fails unknown rails", async () => {
    const report = await runDoctor({ offline: true, rail: "mystery" });

    expect(report.exitCode).toBe(1);
    expect(report.checks.find((c) => c.id === "rail.availability")?.status).toBe("fail");
  });

  it("reports pay-d402 as experimental", async () => {
    const report = await runDoctor({ offline: true, rail: "pay-d402" });

    const rail = report.checks.find((c) => c.id === "rail.availability");
    expect(rail?.status).toBe("warn");
    expect(rail?.data?.availability).toBe("experimental");
  });

  it("formats compact human output without tables", async () => {
    const report = await runDoctor({ offline: true });
    const text = formatDoctorText(report);

    expect(text).toContain("dacs doctor\n");
    expect(text).toContain("mode: offline\n");
    expect(text).toContain("storage.binding-resolution: blocked");
    expect(text).toContain("remediation: Track dacs-sdk #58");
    expect(text).not.toContain("|");
  });

  it("redacts standalone RPC URLs", () => {
    expect(redactRpcUrl("https://user:pass@example.com/a?token=1#secret")).toBe(
      "https://example.com/[redacted]?[redacted]#[redacted]",
    );
    expect(redactRpcUrl("https://eth-mainnet.g.alchemy.com/v2/API_KEY")).toBe(
      "https://eth-mainnet.g.alchemy.com/[redacted]",
    );
    expect(redactRpcUrl("not a url secret")).toBe("[redacted-invalid-rpc-url]");
  });
});
