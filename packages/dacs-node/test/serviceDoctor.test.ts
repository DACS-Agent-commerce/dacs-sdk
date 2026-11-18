import { describe, expect, it, vi } from "vitest";

import {
  createDacsRoleServiceDoctorProbesV1,
  DacsTransportDiagnosticError,
  formatDacsLiveDoctorTextV1,
  readDacsRoleServiceStatusesV1,
  runDacsLiveDoctorV1,
} from "../src/index.js";

const TARGETS = [
  { role: "buyer" as const, endpoint: "http://127.0.0.1:3101/dacs-transport/v1/messages" },
  { role: "seller" as const, endpoint: "http://127.0.0.1:3102/dacs-transport/v1/messages" },
];

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("role service doctor probes", () => {
  it.each(["buyer", "seller"] as const)("keeps %s diagnostic causes in the final JSON and text reports", async (failedRole) => {
    const cause = Object.assign(new Error("fixture internal transport detail"), {
      reasonCode: "outbox-lease-stale",
    });
    const diagnostic = vi.fn(async (role: "buyer" | "seller") => {
      if (role === failedRole) {
        throw new DacsTransportDiagnosticError("transport-diagnostic-unavailable", { cause });
      }
      return { authenticated: true, durable: true, acknowledged: true, noAction: true };
    });
    const report = await runDacsLiveDoctorV1({
      phase: "post-start", scope: "start", sdkVersion: "sdk-v1",
      standardRevision: "standard-v1", profile: "profile-v1",
      probes: createDacsRoleServiceDoctorProbesV1({
        targets: TARGETS, sdkVersion: "sdk-v1", standardRevision: "standard-v1",
        profile: "profile-v1", fetch: vi.fn(async () => response({})),
        transportDiagnostic: diagnostic,
      }),
    });
    expect(diagnostic).toHaveBeenCalledTimes(2);
    expect(JSON.parse(JSON.stringify(report)).checks.find((check: { id: string }) =>
      check.id === "service.transport-roundtrip")).toMatchObject({
      status: "fail", reasonCode: "transport-diagnostic-unavailable",
      facts: { causeCode: "outbox-lease-stale" },
    });
    expect(formatDacsLiveDoctorTextV1(report)).toContain("cause: outbox-lease-stale");
    expect(JSON.stringify(report)).not.toContain(cause.message);
    expect(report.gate.failed).toBeGreaterThan(0);
  });

  it.each([
    [new Error("fixture internal detail"), "unknown"],
    ["outbox-lease-stale", "unknown"],
    [null, "unknown"],
    [{ reasonCode: "x".repeat(81) }, "unknown"],
    [{ reasonCode: "database-path/fixture" }, "unknown"],
    [{ reasonCode: " padded " }, "unknown"],
    [{ reasonCode: "bad\ncode" }, "unknown"],
    [{ reasonCode: "code\n" }, "unknown"],
    [{ reasonCode: 1 }, "unknown"],
    [Object.create({ reasonCode: "inherited-code" }), "unknown"],
    [new DacsTransportDiagnosticError("transport-diagnostic-not-retained"), "transport-diagnostic-not-retained"],
    [{ reasonCode: "a" }, "a"],
    [{ reasonCode: "a".repeat(80) }, "a".repeat(80)],
  ])("bounds a diagnostic cause %#", async (error, expected) => {
    const probes = createDacsRoleServiceDoctorProbesV1({
      targets: TARGETS, sdkVersion: "sdk-v1", standardRevision: "standard-v1", profile: "profile-v1",
      transportDiagnostic: () => { throw error; },
    });
    const report = await runDacsLiveDoctorV1({
      phase: "post-start", scope: "start", sdkVersion: "sdk-v1",
      standardRevision: "standard-v1", profile: "profile-v1",
      probes: { "service.transport-roundtrip": probes["service.transport-roundtrip"]! },
    });
    expect(report.checks.find((check) => check.id === "service.transport-roundtrip"))
      .toMatchObject({ status: "fail", reasonCode: "transport-diagnostic-unavailable",
        facts: { causeCode: expected } });
  });

  it("does not invoke diagnostic code accessors or leak inspection failures", async () => {
    const getter = vi.fn(() => { throw new Error("fixture accessor detail"); });
    const descriptorTrap = vi.fn(() => { throw new Error("fixture descriptor detail"); });
    const accessor = Object.defineProperty({}, "reasonCode", { get: getter });
    const proxy = new Proxy({}, { getOwnPropertyDescriptor: descriptorTrap });
    for (const error of [accessor, proxy]) {
      const probes = createDacsRoleServiceDoctorProbesV1({
        targets: TARGETS, sdkVersion: "sdk-v1", standardRevision: "standard-v1", profile: "profile-v1",
        transportDiagnostic: () => { throw error; },
      });
      await expect(probes["service.transport-roundtrip"]!({ signal: new AbortController().signal } as never))
        .resolves.toEqual({ status: "fail", reasonCode: "transport-diagnostic-unavailable",
          facts: { causeCode: "unknown" } });
    }
    expect(getter).not.toHaveBeenCalled();
    expect(descriptorTrap).toHaveBeenCalledTimes(1);
  });

  it("verifies health, readiness, versions, and both no-effect transport directions", async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      const role = url.port === "3101" ? "buyer" : "seller";
      if (url.pathname === "/health") return response({ status: "healthy" });
      if (url.pathname === "/ready") return response({ ready: true, reasonCodes: [] });
      return response({
        version: 1,
        role,
        lifecycle: "running",
        sdkVersion: "sdk-v1",
        standardRevision: "standard-v1",
        profile: "profile-v1",
        commerce: { status: "configured" },
      });
    });
    const diagnostic = vi.fn(async () => ({
      authenticated: true,
      durable: true,
      acknowledged: true,
      noAction: true,
    }));
    const probes = createDacsRoleServiceDoctorProbesV1({
      targets: TARGETS,
      sdkVersion: "sdk-v1",
      standardRevision: "standard-v1",
      profile: "profile-v1",
      fetch: fetcher as typeof fetch,
      transportDiagnostic: diagnostic,
    });
    const report = await runDacsLiveDoctorV1({
      phase: "post-start",
      scope: "start",
      sdkVersion: "sdk-v1",
      standardRevision: "standard-v1",
      profile: "profile-v1",
      probes,
    });
    for (const item of report.checks.filter((check) => check.id.startsWith("service."))) {
      expect(item.status, item.id).toBe("pass");
    }
    expect(diagnostic).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(8);
  });

  it("blocks public checks without an independent probe and rejects version drift", async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/status") return response({
        version: 1,
        role: url.port === "3101" ? "buyer" : "seller",
        lifecycle: "running",
        sdkVersion: "wrong-version",
        standardRevision: "standard-v1",
        profile: "profile-v1",
      });
      return response(url.pathname === "/ready"
        ? { ready: false, reasonCodes: ["not-latched"] }
        : { status: "healthy" }, url.pathname === "/ready" ? 503 : 200);
    });
    const probes = createDacsRoleServiceDoctorProbesV1({
      targets: TARGETS.map((target) => ({
        ...target,
        publicEndpoint: `https://${target.role}.example/dacs-transport/v1/messages`,
      })),
      sdkVersion: "sdk-v1",
      standardRevision: "standard-v1",
      profile: "profile-v1",
      fetch: fetcher as typeof fetch,
    });
    await expect(probes["service.public-reachability"]!({ signal: new AbortController().signal } as never))
      .resolves.toMatchObject({ status: "blocked", reasonCode: "independent-probe-not-configured" });
    await expect(probes["service.version-agreement"]!({ signal: new AbortController().signal } as never))
      .resolves.toMatchObject({ status: "fail", reasonCode: "role-service-version-mismatch" });
  });

  it("uses GET-only bounded fetches", async () => {
    const fetcher = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      return new Response("x".repeat(65_537), {
        status: 200,
        headers: { "content-length": "65537" },
      });
    });
    const probes = createDacsRoleServiceDoctorProbesV1({
      targets: TARGETS,
      sdkVersion: "sdk-v1",
      standardRevision: "standard-v1",
      profile: "profile-v1",
      fetch: fetcher as typeof fetch,
    });
    await expect(probes["service.health"]!({ signal: new AbortController().signal } as never))
      .resolves.toMatchObject({ status: "fail", reasonCode: "role-service-unhealthy" });
  });
});

describe("role service status projection", () => {
  function status(role: "buyer" | "seller") {
    return {
      version: 1,
      sdkVersion: "sdk-v1",
      standardRevision: "standard-v1",
      profile: "profile-v1",
      role,
      lifecycle: "running",
      checkedAt: 50,
      queues: { inboxPending: false, outboxPending: true, outboxOperatorAction: false },
      sessions: { runnable: 2, truncated: false },
      worker: { running: true, lastCycleAt: 49, lastSuccessAt: 48 },
      commerce: { status: "configured" },
    };
  }

  it("returns a bounded two-role operational status", async () => {
    const fetcher = vi.fn(async (input: string | URL) =>
      response(status(new URL(input).port === "3101" ? "buyer" : "seller")));
    await expect(readDacsRoleServiceStatusesV1({
      targets: TARGETS,
      sdkVersion: "sdk-v1",
      standardRevision: "standard-v1",
      profile: "profile-v1",
      fetch: fetcher as typeof fetch,
      now: () => 100,
    })).resolves.toMatchObject({
      schema: "dacs-role-service-status-report/v1",
      observedAt: 100,
      status: "available",
      roles: [
        { role: "buyer", commerce: { status: "configured" }, queues: { outboxPending: true }, sessions: { runnable: 2 } },
        { role: "seller", commerce: { status: "configured" }, queues: { outboxPending: true }, sessions: { runnable: 2 } },
      ],
    });
  });

  it("blocks version drift, malformed bodies, and unavailable roles", async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      const role = new URL(input).port === "3101" ? "buyer" : "seller";
      return role === "buyer" ? response(status(role)) : response({ ...status(role), sdkVersion: "old" });
    });
    await expect(readDacsRoleServiceStatusesV1({
      targets: TARGETS,
      sdkVersion: "sdk-v1",
      standardRevision: "standard-v1",
      profile: "profile-v1",
      fetch: fetcher as typeof fetch,
      now: () => 100,
    })).resolves.toEqual({
      schema: "dacs-role-service-status-report/v1",
      observedAt: 100,
      status: "blocked",
      reasonCode: "role-service-status-unavailable",
    });
  });
});
