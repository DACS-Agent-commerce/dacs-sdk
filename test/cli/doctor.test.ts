import { describe, expect, it } from "vitest";

import { formatDoctorText, runDoctor } from "../../src/cli/index.js";

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
    expect(report.exitCode).toBe(0);
    expect(report.checks.find((c) => c.id === "runtime.node")?.status).toBe("pass");
    expect(report.checks.find((c) => c.id === "rpc.reachable")?.status).toBe("skip");
    expect(report.checks.find((c) => c.id === "storage.binding-resolution")?.status).toBe("blocked");
  });

  it("fails unsupported Node versions", async () => {
    const report = await runDoctor({ offline: true, nodeVersion: "v18.20.0" });

    expect(report.exitCode).toBe(1);
    expect(report.checks.find((c) => c.id === "runtime.node")?.status).toBe("fail");
  });

  it("redacts wallet secrets in report JSON", async () => {
    const secret = "abcd-secret-material-1234";
    const report = await runDoctor({ offline: true, walletSecret: secret });
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("abcd...[redacted]...1234");
  });

  it("maps requested RPC failure to exit code 3 without leaking secrets", async () => {
    const secret = "secret-value";
    const report = await runDoctor({
      rpc: "https://example.invalid",
      walletSecret: secret,
      adapterFactory: () => ({
        connect: async () => {
          throw new Error(`failed with ${secret}`);
        },
        getAddress: () => "unused",
      }),
    });

    expect(report.exitCode).toBe(3);
    const rpc = report.checks.find((c) => c.id === "rpc.reachable");
    expect(rpc?.status).toBe("fail");
    expect(rpc?.detail).toContain("[redacted]");
    expect(rpc?.detail).not.toContain(secret);
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
    expect(text).not.toContain("|");
  });
});
