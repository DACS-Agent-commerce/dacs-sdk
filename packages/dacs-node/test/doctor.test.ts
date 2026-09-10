import { describe, expect, it, vi } from "vitest";

import {
  DACS_LIVE_DOCTOR_CHECK_IDS,
  DACS_LIVE_DOCTOR_REPORT_SCHEMA,
  formatDacsLiveDoctorTextV1,
  runDacsLiveDoctorV1,
  type DacsLiveDoctorProbesV1,
} from "../src/index.js";

const BASE = Object.freeze({
  phase: "pre-start" as const,
  scope: "start" as const,
  sdkVersion: "0.1.0-alpha.0",
  standardRevision: "a".repeat(40),
  profile: "dacs-sdk:fixed-price-x402:v1",
  now: () => 1_000,
});

function passingProbes(): DacsLiveDoctorProbesV1 {
  return Object.fromEntries(DACS_LIVE_DOCTOR_CHECK_IDS.map((id) => [
    id,
    async () => ({ status: "pass" as const }),
  ])) as DacsLiveDoctorProbesV1;
}

describe("complete live doctor gate", () => {
  it("reports every check and leaves missing capabilities visibly blocked", async () => {
    const report = await runDacsLiveDoctorV1(BASE);
    expect(report.schema).toBe(DACS_LIVE_DOCTOR_REPORT_SCHEMA);
    expect(report.checks.map((item) => item.id)).toEqual(DACS_LIVE_DOCTOR_CHECK_IDS);
    expect(report.checks.every((item) =>
      item.status === "pass" || item.status === "fail" || item.status === "blocked"))
      .toBe(true);
    expect(report.gate.status).toBe("blocked");
    expect(report.exitCode).toBe(5);
    expect(report.safety).toEqual({ readOnly: true, funded: false });
  });

  it("gates only the checks required by phase and operation scope", async () => {
    const probes: DacsLiveDoctorProbesV1 = {
      ...passingProbes(),
      "demos.listing-existing": () => ({
        status: "fail",
        reasonCode: "listing-missing",
      }),
    };
    const start = await runDacsLiveDoctorV1({ ...BASE, probes });
    expect(start.checks.find((item) => item.id === "demos.listing-existing"))
      .toMatchObject({ status: "fail", required: false });
    expect(start.exitCode).toBe(0);

    const buy = await runDacsLiveDoctorV1({ ...BASE, scope: "buy", probes });
    expect(buy.checks.find((item) => item.id === "demos.listing-existing"))
      .toMatchObject({ status: "fail", required: true });
    expect(buy.exitCode).toBe(1);
  });

  it("does not require post-start probes during the pre-start start gate", async () => {
    const report = await runDacsLiveDoctorV1({ ...BASE, probes: passingProbes() });
    expect(report.exitCode).toBe(0);
    expect(report.checks.find((item) => item.id === "service.health"))
      .toMatchObject({ status: "blocked", required: false, reasonCode: "post-start-only" });
  });

  it("requires all service probes and reruns pre-start probes after start", async () => {
    const calls: string[] = [];
    const probes = Object.fromEntries(DACS_LIVE_DOCTOR_CHECK_IDS.map((id) => [
      id,
      () => {
        calls.push(id);
        return { status: "pass" as const };
      },
    ])) as DacsLiveDoctorProbesV1;
    const report = await runDacsLiveDoctorV1({
      ...BASE,
      phase: "post-start",
      probes,
    });
    expect(report.exitCode).toBe(0);
    expect(calls).toEqual(DACS_LIVE_DOCTOR_CHECK_IDS);
    expect(report.checks.find((item) => item.id === "service.readiness")?.required).toBe(true);
  });

  it("turns thrown, timed out, and malformed probes into bounded blocked results", async () => {
    let clock = 1_000;
    const report = await runDacsLiveDoctorV1({
      ...BASE,
      now: () => clock++,
      probeTimeoutMs: 5,
      probes: {
        "local.node-version": async () => { throw new Error("private provider URL"); },
        "local.package-integrity": async ({ signal }) =>
          new Promise((resolve) => signal.addEventListener("abort", () => resolve({
            status: "blocked",
            reasonCode: "cancelled",
          }), { once: true })),
        "local.version-bindings": async () => ({ status: "pass", extra: "unsafe" }) as never,
      },
    });
    expect(report.checks.find((item) => item.id === "local.node-version"))
      .toMatchObject({ status: "blocked", reasonCode: "probe-result-invalid" });
    expect(report.checks.find((item) => item.id === "local.package-integrity"))
      .toMatchObject({ status: "blocked" });
    expect(report.checks.find((item) => item.id === "local.version-bindings"))
      .toMatchObject({ status: "blocked", reasonCode: "probe-result-invalid" });
    expect(JSON.stringify(report)).not.toContain("private provider URL");
  });

  it("passes probes only a read-only context without stores or write callbacks", async () => {
    const observed = vi.fn(async (context: object) => {
      expect(Object.keys(context).sort()).toEqual(["checkId", "phase", "scope", "signal"]);
      expect(Object.isFrozen(context)).toBe(true);
      return { status: "pass" as const, facts: { chainId: "demos-testnet" } };
    });
    const report = await runDacsLiveDoctorV1({
      ...BASE,
      probes: { "demos.rpc-chain": observed },
    });
    expect(observed).toHaveBeenCalledTimes(1);
    expect(report.checks.find((item) => item.id === "demos.rpc-chain")?.facts)
      .toEqual({ chainId: "demos-testnet" });
  });

  it("produces a stable integrity projection hash and compact text", async () => {
    const first = await runDacsLiveDoctorV1({ ...BASE, probes: passingProbes() });
    const second = await runDacsLiveDoctorV1({ ...BASE, probes: passingProbes() });
    expect(first.reportHash).toBe(second.reportHash);
    expect(first.reportHash).toMatch(/^[0-9a-f]{64}$/);
    const text = formatDacsLiveDoctorTextV1(first);
    expect(text).toContain("phase: pre-start");
    expect(text).toContain(`report: ${first.reportHash}`);
    expect(text).not.toContain("|");
  });

  it("redacts credential-bearing probe facts from JSON and text projections", async () => {
    const report = await runDacsLiveDoctorV1({
      ...BASE,
      probes: {
        "demos.rpc-chain": () => ({
          status: "pass",
          facts: Object.fromEntries([
            ["rpcUrl", "https://operator:password@example.test/rpc?apiKey=private"],
            [
              ["mnem", "onic"].join(""),
              Array.from({ length: 12 }, (_, index) => String.fromCharCode(97 + index)).join(" "),
            ],
            ["chainId", "demos-testnet"],
          ]),
        }),
      },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("a b c");
    expect(serialized).toContain("[redacted]");
    expect(serialized).toContain("demos-testnet");
  });

  it("rejects unknown probe IDs and noncanonical probe results", async () => {
    await expect(runDacsLiveDoctorV1({
      ...BASE,
      probes: { "unknown.write-check": () => ({ status: "pass" }) } as never,
    })).rejects.toThrow(/probes are invalid/);
  });
});
