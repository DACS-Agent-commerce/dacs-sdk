import { describe, expect, it, vi } from "vitest";

import { demosAgentClaimRef } from "@kynesyslabs/dacs/identity";
import {
  createDacsRoleServiceDoctorProbesV1,
  DacsHttpTransportError,
  DacsTransportDiagnosticError,
  runDacsLiveDoctorV1,
  runDacsRoleTransportDiagnosticV1,
} from "../src/index.js";

const AUTHORITY = demosAgentClaimRef(new Uint8Array(32).fill(1));
const PEER = demosAgentClaimRef(new Uint8Array(32).fill(2));
const PEER_ENDPOINT = "http://127.0.0.1:3102/dacs-transport/v1/messages";

function fixture(createHttpOutboxStore: () => unknown, peerEndpoint = PEER_ENDPOINT) {
  const sign = vi.fn();
  const diagnostic = () => runDacsRoleTransportDiagnosticV1({
    role: "buyer",
    database: {
      metadata: { role: "buyer", authority: AUTHORITY },
      createHttpOutboxStore,
    } as never,
    demos: {
      role: "buyer", authority: AUTHORITY, signTransportEnvelope: sign,
      adapter: { resolveIdentity: vi.fn() },
    } as never,
    peerAuthority: PEER, peerEndpoint,
    workerId: "fixture-worker",
  });
  return { sign, diagnostic };
}

function outboxWith(readTime: () => Promise<number>) {
  return {
    ...Object.fromEntries([
      "put", "load", "list", "listRunnable", "claim", "isCurrent", "recordSendFailure",
      "requireOperatorAction", "acknowledge", "extendRetention", "diagnostics", "purge",
    ].map((name) => [name, vi.fn()])),
    readTime,
  };
}

async function doctorTransportCheck(diagnostic: () => Promise<unknown>) {
  const probes = createDacsRoleServiceDoctorProbesV1({
    targets: [{ role: "buyer", endpoint: "http://127.0.0.1:3101" },
      { role: "seller", endpoint: "http://127.0.0.1:3102" }],
    sdkVersion: "sdk-v1", standardRevision: "standard-v1", profile: "profile-v1",
    transportDiagnostic: diagnostic as never,
  });
  const report = await runDacsLiveDoctorV1({
    phase: "post-start", scope: "start", sdkVersion: "sdk-v1",
    standardRevision: "standard-v1", profile: "profile-v1",
    probes: { "service.transport-roundtrip": probes["service.transport-roundtrip"]! },
  });
  return { report, check: report.checks.find((check) => check.id === "service.transport-roundtrip") };
}

describe("transport diagnostic failure reporting", () => {
  it.each([
    [new DacsHttpTransportError("outbox-lease-stale", true), "outbox-lease-stale"],
    [new Error("fixture internal outbox detail"), "unknown"],
  ] as const)("wraps a run-time failure with its bounded cause (%#)", async (cause, expected) => {
    const { sign, diagnostic } = fixture(() => outboxWith(async () => { throw cause; }));
    const failure = await diagnostic().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DacsTransportDiagnosticError);
    expect(failure).toMatchObject({ reasonCode: "transport-diagnostic-unavailable",
      causeCode: expected, message: "transport-diagnostic-unavailable" });
    expect((failure as Error).cause).toBe(cause);
    expect(sign).not.toHaveBeenCalled();
    const { report, check } = await doctorTransportCheck(diagnostic);
    expect(check).toMatchObject({ status: "fail", reasonCode: "transport-diagnostic-unavailable",
      facts: { causeCode: expected } });
    expect(JSON.stringify(report)).not.toContain("fixture internal outbox detail");
  });

  it("rethrows a coded diagnostic failure unchanged and reports its code as the cause", async () => {
    const cause = new DacsTransportDiagnosticError("transport-diagnostic-clock-invalid");
    const { diagnostic } = fixture(() => outboxWith(async () => { throw cause; }));
    await expect(diagnostic()).rejects.toBe(cause);
    const { check } = await doctorTransportCheck(diagnostic);
    expect(check).toMatchObject({ status: "fail", reasonCode: "transport-diagnostic-unavailable",
      facts: { causeCode: "transport-diagnostic-clock-invalid" } });
  });

  it("leaves a setup failure unwrapped and still reports its bounded cause", async () => {
    const cause = new DacsHttpTransportError("outbox-lease-stale", true);
    const { diagnostic } = fixture(() => { throw cause; });
    await expect(diagnostic()).rejects.toBe(cause);
    const { check } = await doctorTransportCheck(diagnostic);
    expect(check).toMatchObject({ status: "fail", reasonCode: "transport-diagnostic-unavailable",
      facts: { causeCode: "outbox-lease-stale" } });
  });

  it("keeps an invalid peer endpoint as the caller's TypeError", async () => {
    const readTime = vi.fn(async () => 1);
    const { diagnostic } = fixture(() => outboxWith(readTime), "http://127.0.0.1:3102");
    const failure = await diagnostic().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).not.toBeInstanceOf(DacsTransportDiagnosticError);
    expect(readTime).not.toHaveBeenCalled();
    const { check } = await doctorTransportCheck(diagnostic);
    expect(check).toMatchObject({ status: "fail", reasonCode: "transport-diagnostic-unavailable",
      facts: { causeCode: "unknown" } });
  });
});
