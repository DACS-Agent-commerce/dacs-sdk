import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  DACS_LIVE_DOCTOR_CHECK_IDS,
  establishDacsRoleServiceReadinessV1,
  installDacsRoleServiceProcessHooksV1,
  type DacsLiveDoctorProbesV1,
  type DacsProcessSignalTargetV1,
  type DacsRoleReadinessLatchV1,
} from "../src/index.js";

class Signals extends EventEmitter implements DacsProcessSignalTargetV1 {
  override on(event: "SIGINT" | "SIGTERM", listener: () => void): this {
    return super.on(event, listener);
  }

  override off(event: "SIGINT" | "SIGTERM", listener: () => void): this {
    return super.off(event, listener);
  }
}

describe("role service process supervision", () => {
  it("stops exactly once on the first process signal and publishes a bounded result", async () => {
    const target = new Signals();
    const stop = vi.fn(async () => undefined);
    const observed = vi.fn(async () => undefined);
    const hooks = installDacsRoleServiceProcessHooksV1({ stop }, {
      signalTarget: target,
      onShutdown: observed,
    });

    target.emit("SIGTERM");
    target.emit("SIGINT");
    const result = await hooks.waitForShutdown();
    expect(result).toEqual({ reason: "SIGTERM", status: "stopped" });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(observed).toHaveBeenCalledWith(result);
    expect(target.listenerCount("SIGTERM")).toBe(0);
    expect(target.listenerCount("SIGINT")).toBe(0);
    await expect(hooks.shutdown()).resolves.toBe(result);
  });

  it("does not expose thrown shutdown details and ignores observer failure", async () => {
    const privateFailure = new Error("provider URL and secret must stay private");
    const hooks = installDacsRoleServiceProcessHooksV1({
      stop: async () => { throw privateFailure; },
    }, {
      signalTarget: new Signals(),
      onShutdown: () => { throw new Error("logging offline"); },
    });
    await expect(hooks.shutdown("manual")).resolves.toEqual({
      reason: "manual",
      status: "failed",
      reasonCode: "service-stop-failed",
    });
  });

  it("can remove hooks without stopping the service", () => {
    const target = new Signals();
    const stop = vi.fn(async () => undefined);
    const hooks = installDacsRoleServiceProcessHooksV1({ stop }, {
      signalTarget: target,
    });
    hooks.dispose();
    target.emit("SIGTERM");
    expect(stop).not.toHaveBeenCalled();
  });
});

describe("role service readiness supervision", () => {
  function probes(
    readiness: () => boolean,
    overrides: DacsLiveDoctorProbesV1 = {},
  ): DacsLiveDoctorProbesV1 {
    return {
      ...Object.fromEntries(DACS_LIVE_DOCTOR_CHECK_IDS.map((id) => [
        id,
        () => ({ status: "pass" as const }),
      ])),
      "service.readiness": () => readiness()
        ? { status: "pass" as const }
        : { status: "fail" as const, reasonCode: "role-service-not-ready" },
      ...overrides,
    } as DacsLiveDoctorProbesV1;
  }

  function actor(role: "buyer" | "seller", ready: Set<string>) {
    const commit = vi.fn(async () => {
      ready.add(role);
      return { ready: true, checkedAt: 1, reasonCodes: [] } as const;
    });
    const revoke = vi.fn(async () => {
      ready.delete(role);
    });
    const latch = {
      filePath: `/${role}/readiness-latch.v1.json`,
      role,
      authority: `did:demos:agent:${role === "buyer" ? "1" : "2".repeat(64)}`,
      configHash: "a".repeat(64),
      readiness: async () => ({
        ready: ready.has(role),
        checkedAt: 1,
        reasonCodes: ready.has(role) ? [] : ["readiness-latch-missing"],
      }),
      commit,
      revoke,
    } satisfies DacsRoleReadinessLatchV1;
    return {
      role,
      latch,
      sign: async () => new Uint8Array(64),
      commit,
      revoke,
    };
  }

  function doctor(checks: DacsLiveDoctorProbesV1) {
    return {
      sdkVersion: "sdk-v1",
      standardRevision: "standard-v1",
      profile: "profile-v1",
      probes: checks,
      now: () => 1_000,
    };
  }

  it("signs the same prerequisite report for both roles and verifies the final gate", async () => {
    const ready = new Set<string>();
    const buyer = actor("buyer", ready);
    const seller = actor("seller", ready);
    const result = await establishDacsRoleServiceReadinessV1({
      actors: [buyer, seller],
      doctor: doctor(probes(() => ready.size === 2)),
    });

    expect(result.status).toBe("ready");
    expect(result.prerequisiteReport.checks.find((check) => check.id === "service.readiness"))
      .toMatchObject({ status: "fail" });
    expect(result.report.checks.find((check) => check.id === "service.readiness"))
      .toMatchObject({ status: "pass" });
    expect(buyer.commit).toHaveBeenCalledWith(
      result.prerequisiteReport.reportHash,
      buyer.sign,
    );
    expect(seller.commit).toHaveBeenCalledWith(
      result.prerequisiteReport.reportHash,
      seller.sign,
    );
    expect(buyer.revoke).not.toHaveBeenCalled();
  });

  it("revokes both roles and never commits when a prerequisite is blocked", async () => {
    const ready = new Set<string>(["buyer", "seller"]);
    const buyer = actor("buyer", ready);
    const seller = actor("seller", ready);
    const result = await establishDacsRoleServiceReadinessV1({
      actors: [buyer, seller],
      doctor: doctor(probes(() => ready.size === 2, {
        "service.transport-roundtrip": () => ({
          status: "blocked",
          reasonCode: "transport-diagnostic-unavailable",
        }),
      })),
    });

    expect(result).toMatchObject({
      status: "not-ready",
      reasonCode: "readiness-prerequisites-not-passed",
    });
    expect(buyer.commit).not.toHaveBeenCalled();
    expect(seller.commit).not.toHaveBeenCalled();
    expect(buyer.revoke).toHaveBeenCalledTimes(1);
    expect(seller.revoke).toHaveBeenCalledTimes(1);
    expect(ready.size).toBe(0);
  });

  it("revokes a partially committed pair when either role cannot commit", async () => {
    const ready = new Set<string>();
    const buyer = actor("buyer", ready);
    const seller = actor("seller", ready);
    seller.commit.mockRejectedValueOnce(new Error("private signer unavailable"));
    const result = await establishDacsRoleServiceReadinessV1({
      actors: [buyer, seller],
      doctor: doctor(probes(() => ready.size === 2)),
    });
    expect(result).toMatchObject({
      status: "not-ready",
      reasonCode: "readiness-latch-commit-failed",
    });
    expect(ready.size).toBe(0);
    expect(buyer.revoke).toHaveBeenCalledTimes(1);
    expect(seller.revoke).toHaveBeenCalledTimes(1);
  });

  it("waits for a late successful commit before revoking a failed pair", async () => {
    const ready = new Set<string>();
    const buyer = actor("buyer", ready);
    const seller = actor("seller", ready);
    buyer.commit.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      ready.add("buyer");
      return { ready: true, checkedAt: 1, reasonCodes: [] };
    });
    seller.commit.mockRejectedValueOnce(new Error("private signer unavailable"));
    const result = await establishDacsRoleServiceReadinessV1({
      actors: [buyer, seller],
      doctor: doctor(probes(() => ready.size === 2)),
    });
    expect(result.status).toBe("not-ready");
    expect(ready.size).toBe(0);
    expect(buyer.revoke).toHaveBeenCalledTimes(1);
  });

  it("revokes both roles if the complete post-commit doctor does not pass", async () => {
    const ready = new Set<string>();
    const buyer = actor("buyer", ready);
    const seller = actor("seller", ready);
    let healthCalls = 0;
    const result = await establishDacsRoleServiceReadinessV1({
      actors: [buyer, seller],
      doctor: doctor(probes(() => ready.size === 2, {
        "service.health": () => ++healthCalls === 1
          ? { status: "pass" }
          : { status: "fail", reasonCode: "role-service-unhealthy" },
      })),
    });
    expect(result).toMatchObject({
      status: "not-ready",
      reasonCode: "readiness-verification-failed",
    });
    expect(ready.size).toBe(0);
  });
});
