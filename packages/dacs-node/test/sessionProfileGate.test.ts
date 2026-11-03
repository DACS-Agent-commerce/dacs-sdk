import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DACS_STANDARD_PIN, authenticateSessionProfile } from "@kynesyslabs/dacs";
import { COMPLETED_SESSION_MODULE_VERSIONS } from "@kynesyslabs/dacs/commerce";
import { demosAgentClaimRef } from "@kynesyslabs/dacs/identity";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DACS_SESSION_PROFILE_ADMISSION_FILE_MAX_BYTES,
  createDacsFileSessionProfileAdmissionV1,
  createDacsFixedPriceMultirailBuyerLiveV1,
  createDacsFixedPriceMultirailSellerLiveV1,
  createDacsFixedPricePayDemBuyerLiveV1,
  createDacsFixedPricePayDemOperationSetV1,
  createDacsFixedPricePayDemSellerLiveV1,
  createDacsFixedPriceX402BuyerLiveV1,
  createDacsFixedPriceX402OperationSetV1,
  createDacsFixedPriceX402SellerLiveV1,
  createDacsSessionProfileGatedCommerceGraphV1,
  dacsLiveSessionProfileAvailabilityV1,
} from "../src/index.js";

const BUYER = demosAgentClaimRef(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
const SELLER = demosAgentClaimRef(Uint8Array.from({ length: 32 }, (_, index) => 64 + index));
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";

describe("session profile admission gate", () => {
  const roots: string[] = [];
  const root = () => {
    const directory = mkdtempSync(join(tmpdir(), "dacs-profile-gate-"));
    roots.push(directory);
    return directory;
  };
  afterEach(() => {
    vi.doUnmock("@kynesyslabs/dacs/commerce");
    vi.resetModules();
    for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("reports the unreleased pinned profile whatever authority the host holds", () => {
    for (const authority of [undefined, null, "authority", () => ({ status: "valid" })]) {
      expect(dacsLiveSessionProfileAvailabilityV1(authority)).toEqual({
        status: "blocked", reasonCode: "session-profile-unreleased",
      });
    }
  });

  it("after a release, blocks a host without authority and builds the live graph with one", async () => {
    vi.resetModules();
    vi.doMock("@kynesyslabs/dacs/commerce", async (importOriginal) => ({
      ...await importOriginal<Record<string, unknown>>(),
      DACS_STANDARD_PROFILE_STATUS: "released",
    }));
    const gate = await import("../src/sessionProfileGate.js");
    expect(gate.dacsLiveSessionProfileAvailabilityV1(undefined)).toEqual({
      status: "blocked", reasonCode: "session-profile-admission-unconfigured",
    });
    expect(gate.dacsLiveSessionProfileAvailabilityV1({})).toEqual({
      status: "blocked", reasonCode: "session-profile-admission-unconfigured",
    });
    expect(gate.dacsLiveSessionProfileAvailabilityV1(() => undefined))
      .toEqual({ status: "configured" });

    const live = Object.freeze({ role: "buyer" });
    const build = vi.fn(() => live);
    const graph = gate.createDacsSessionProfileGatedCommerceGraphV1(build as never);
    const context = {
      role: "buyer",
      config: { rail: { enabledProfiles: ["pay-dem"] } },
    };
    const unconfigured = await graph(context as never);
    expect(build).not.toHaveBeenCalled();
    expect(unconfigured.availability).toEqual({
      status: "blocked", reasonCode: "session-profile-admission-unconfigured",
    });
    expect(Object.keys(unconfigured.payDemOperations!).sort()).toEqual(
      ["agreement", "audit", "buyer-received", "payment", "payment-evidence"]);
    expect(unconfigured.operations).toBeUndefined();
    await expect(unconfigured.payDemOperations!.payment!({} as never)).resolves.toEqual({
      status: "operator-action", reasonCode: "session-profile-admission-unconfigured",
    });

    const independentAuthority = vi.fn((jobId: string) => ({
      status: "valid", releasePin: DACS_STANDARD_PIN, profileStatus: "released",
      moduleVersions: { ...COMPLETED_SESSION_MODULE_VERSIONS },
      roles: [{ jobId, participant: BUYER, role: "buyer" },
        { jobId, participant: SELLER, role: "seller" }],
    }));
    const admitted = { ...context, authenticateSessionProfile: independentAuthority };
    await expect(graph(admitted as never)).resolves.toBe(live);
    expect(build).toHaveBeenCalledWith(admitted);
    expect(admitted.authenticateSessionProfile(JOB_ID)).toMatchObject({
      status: "valid", roles: [
        { jobId: JOB_ID, participant: BUYER, role: "buyer" },
        { jobId: JOB_ID, participant: SELLER, role: "seller" },
      ],
    });
  });

  for (const role of ["buyer", "seller"] as const) {
    for (const rails of [["x402"], ["pay-dem"], ["pay-dem", "x402"]] as const) {
      it(`gives a ${role} ${rails.join("+")} host a complete blocked graph without building it`, async () => {
        // The generated service's factories refuse to build without admission.
        const build = vi.fn((context: { role: string }): Promise<unknown> => {
          const options = { context } as never;
          return context.role === "buyer"
            ? rails.length === 2
              ? createDacsFixedPriceMultirailBuyerLiveV1({ x402: options, payDem: options })
              : rails[0] === "x402" ? createDacsFixedPriceX402BuyerLiveV1(options)
              : createDacsFixedPricePayDemBuyerLiveV1(options)
            : rails.length === 2
              ? createDacsFixedPriceMultirailSellerLiveV1({ x402: options, payDem: options })
              : rails[0] === "x402" ? createDacsFixedPriceX402SellerLiveV1(options)
              : createDacsFixedPricePayDemSellerLiveV1(options);
        });
        const context = { role, config: { rail: { enabledProfiles: rails } } };
        await expect(Promise.resolve().then(() => build(context))).rejects.toThrow(TypeError);
        build.mockClear();
        for (const admission of [{}, { authenticateSessionProfile: vi.fn() }]) {
          const graph = await createDacsSessionProfileGatedCommerceGraphV1(build as never)(
            { ...context, ...admission } as never);
          expect(build).not.toHaveBeenCalled();
          expect(Object.getPrototypeOf(graph)).toBe(Object.prototype);
          expect(graph.role).toBe(role);
          expect(graph.availability).toEqual({
            status: "blocked", reasonCode: "session-profile-unreleased",
          });
          // The role runtime's own completeness checks for each enabled rail.
          const enabled: readonly string[] = rails;
          expect(graph.operations === undefined).toBe(!enabled.includes("x402"));
          expect(graph.payDemOperations === undefined).toBe(!enabled.includes("pay-dem"));
          if (graph.operations !== undefined) {
            expect(() => createDacsFixedPriceX402OperationSetV1({
              role, operations: graph.operations as never,
            })).not.toThrow();
          }
          if (graph.payDemOperations !== undefined) {
            expect(() => createDacsFixedPricePayDemOperationSetV1({
              role, operations: graph.payDemOperations as never,
            })).not.toThrow();
          }
          expect(typeof graph.validatePayload).toBe("function");
          expect(typeof graph.handleMessage).toBe("function");
          if (role === "seller") expect(typeof graph.handleApplicationRequest).toBe("function");
          await expect(Promise.resolve(graph.validatePayload({} as never))).resolves.toMatchObject({
            status: "invalid",
          });
          const tracks = (graph.operations ?? graph.payDemOperations)!;
          await expect(tracks.agreement!({} as never)).resolves.toEqual({
            status: "operator-action", reasonCode: "session-profile-unreleased",
          });
        }
      });
    }
  }

  it.each(["buyer", "seller"] as const)("keeps %s file-only admission blocked after release without authenticated peer/session evidence", async (role) => {
    vi.resetModules();
    vi.doMock("@kynesyslabs/dacs/commerce", async (original) => ({
      ...await original<Record<string, unknown>>(), DACS_STANDARD_PROFILE_STATUS: "released",
    }));
    const gate = await import("../src/sessionProfileGate.js");
    const filePath = join(root(), "admission.json");
    writeFileSync(filePath, JSON.stringify({ releasePin: DACS_STANDARD_PIN,
      profileStatus: "released", moduleVersions: COMPLETED_SESSION_MODULE_VERSIONS }));
    const admit = gate.createDacsFileSessionProfileAdmissionV1({ filePath,
      buyerAuthority: BUYER, sellerAuthority: SELLER });
    expect(gate.dacsLiveSessionProfileAvailabilityV1(admit)).toEqual({
      status: "blocked", reasonCode: "session-profile-peer-evidence-unconfigured",
    });
    for (const jobId of [JOB_ID, "01J8ME0SXKQ4T9V2RC5HJ6WX7E"]) {
      expect(() => admit(jobId)).toThrow(/authenticated peer.*session evidence/);
    }
    const build = vi.fn();
    const graph = await gate.createDacsSessionProfileGatedCommerceGraphV1(build)({
      role, authenticateSessionProfile: admit,
      config: { rail: { enabledProfiles: ["pay-dem", "x402"] } },
    } as never);
    expect(build).not.toHaveBeenCalled();
    expect(graph.availability).toEqual({
      status: "blocked", reasonCode: "session-profile-peer-evidence-unconfigured",
    });
    for (const operations of [graph.operations, graph.payDemOperations]) {
      await expect(operations!.agreement!({} as never)).resolves.toMatchObject({
        status: "operator-action", reasonCode: "session-profile-peer-evidence-unconfigured",
      });
    }
  });

  it("after release keeps restored local statements blocked until a verifier is configured", async () => {
    vi.resetModules();
    vi.doMock("@kynesyslabs/dacs/commerce", async (original) => ({
      ...await original<Record<string, unknown>>(), DACS_STANDARD_PROFILE_STATUS: "released",
    }));
    const gate = await import("../src/sessionProfileGate.js");
    const filePath = join(root(), "admission.json");
    const admit = gate.createDacsFileSessionProfileAdmissionV1({ filePath,
      buyerAuthority: BUYER, sellerAuthority: SELLER });
    expect(gate.dacsLiveSessionProfileAvailabilityV1(admit)).toMatchObject({
      status: "blocked", reasonCode: "session-profile-admission-unavailable" });
    let error: unknown;
    try { admit(JOB_ID); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ name: "IndeterminateSubstrateError", category: "substrate" });
    const create = vi.fn();
    const graph = await gate.createDacsSessionProfileGatedCommerceGraphV1(create)({
      role: "buyer", authenticateSessionProfile: admit,
      config: { rail: { enabledProfiles: ["pay-dem"] } },
    } as never);
    expect(create).not.toHaveBeenCalled();
    await expect(Promise.resolve(graph.validatePayload({ jobId: JOB_ID, type: "session-challenge" } as never))).resolves.toMatchObject({
      status: "invalid", reasonCode: "session-profile-admission-unavailable" });
    await expect(graph.payDemOperations!.payment!({} as never)).resolves.toMatchObject({
      status: "operator-action", reasonCode: "session-profile-admission-unavailable" });
    writeFileSync(filePath, JSON.stringify({ releasePin: DACS_STANDARD_PIN,
      profileStatus: "released", moduleVersions: COMPLETED_SESSION_MODULE_VERSIONS }));
    expect(gate.dacsLiveSessionProfileAvailabilityV1(admit)).toEqual({
      status: "blocked", reasonCode: "session-profile-peer-evidence-unconfigured" });
    expect(() => admit(JOB_ID)).toThrow(/authenticated peer.*session evidence/);
    await expect(graph.payDemOperations!.payment!({} as never)).resolves.toMatchObject({
      status: "operator-action", reasonCode: "session-profile-admission-unavailable" });
    create.mockReturnValue(graph);
    await gate.createDacsSessionProfileGatedCommerceGraphV1(create)({
      role: "buyer", authenticateSessionProfile: admit,
      config: { rail: { enabledProfiles: ["pay-dem"] } },
    } as never);
    expect(create).not.toHaveBeenCalled();
    writeFileSync(filePath, "{");
    expect(gate.dacsLiveSessionProfileAvailabilityV1(admit)).toEqual({
      status: "blocked", reasonCode: "session-profile-admission-invalid" });
    rmSync(filePath);
    expect(gate.dacsLiveSessionProfileAvailabilityV1(admit).status).toBe("blocked");
  });

  it("refuses standalone terminal actions at the real unreleased pin before any effect", async () => {
    const { createDacsVetTerminalBundleTransportRuntimeV1 } = await import("../src/terminalBundleTransportRuntime.js");
    const authenticateProduction = vi.fn();
    const sendMessage = vi.fn();
    const signComponent = vi.fn();
    const runtime = createDacsVetTerminalBundleTransportRuntimeV1({
      context: { role: "buyer", authority: BUYER, peerAuthority: SELLER,
        authenticateSessionProfile: vi.fn(), sendMessage, demos: { signComponent } } as never,
      authenticateProduction,
    });
    await expect(runtime.registerLocalTerminal({ jobId: JOB_ID } as never)).rejects.toThrow(/unreleased candidate/);
    await expect(runtime.advanceRegisteredTerminal(JOB_ID)).rejects.toThrow(/unreleased candidate/);
    await expect(runtime.transport.resolveProposal({ jobId: JOB_ID } as never)).rejects.toThrow(/unreleased candidate/);
    expect(authenticateProduction).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(signComponent).not.toHaveBeenCalled();
  });

  it("refuses a missing graph factory", () => {
    expect(() => createDacsSessionProfileGatedCommerceGraphV1(undefined as never))
      .toThrow(TypeError);
  });

  it("re-reads local statements without promoting them to peer or session authority", async () => {
    const filePath = join(root(), "admission.json");
    const statement = {
      releasePin: DACS_STANDARD_PIN,
      profileStatus: "released",
      moduleVersions: COMPLETED_SESSION_MODULE_VERSIONS,
    };
    writeFileSync(filePath, JSON.stringify(statement));
    const admit = createDacsFileSessionProfileAdmissionV1({
      filePath, buyerAuthority: BUYER, sellerAuthority: SELLER,
    });
    expect(() => admit(JOB_ID)).toThrow(/authenticated peer.*session evidence/);
    writeFileSync(filePath, JSON.stringify({ ...statement, profileStatus: "withdrawn" }));
    expect(() => admit(JOB_ID)).toThrow(/authenticated peer.*session evidence/);
    rmSync(filePath);
    expect(() => admit(JOB_ID)).toThrow("session profile admission file is absent");
  });

  it("is still refused by the SDK while the pinned profile is unreleased", async () => {
    const filePath = join(root(), "admission.json");
    writeFileSync(filePath, JSON.stringify({
      releasePin: DACS_STANDARD_PIN,
      profileStatus: "released",
      moduleVersions: COMPLETED_SESSION_MODULE_VERSIONS,
    }));
    const admit = createDacsFileSessionProfileAdmissionV1({
      filePath, buyerAuthority: BUYER, sellerAuthority: SELLER,
    });
    await expect(authenticateSessionProfile(() => admit(JOB_ID), {
      jobId: JOB_ID, buyer: BUYER, seller: SELLER,
    })).rejects.toThrow("unreleased candidate");
  });

  it("refuses an oversized, malformed or incomplete statement", () => {
    const directory = root();
    const cases: Array<[string, string]> = [
      [" ".repeat(DACS_SESSION_PROFILE_ADMISSION_FILE_MAX_BYTES + 1), "exceeds"],
      ["{", "is not JSON"],
      ["[]", "must state exactly"],
      [JSON.stringify({ releasePin: "x", profileStatus: "released" }), "must state exactly"],
      [JSON.stringify({ releasePin: "x", profileStatus: "released", moduleVersions: {},
        roles: [] }), "must state exactly"],
      [JSON.stringify({ releasePin: 1, profileStatus: "released", moduleVersions: {} }),
        "is malformed"],
      [JSON.stringify({ releasePin: "x", profileStatus: "released", moduleVersions: [] }),
        "is malformed"],
    ];
    cases.forEach(([content, message], index) => {
      const filePath = join(directory, `admission-${index}.json`);
      writeFileSync(filePath, content);
      const admit = createDacsFileSessionProfileAdmissionV1({
        filePath, buyerAuthority: BUYER, sellerAuthority: SELLER,
      });
      expect(() => admit(JOB_ID)).toThrow(message);
    });
    expect(() => createDacsFileSessionProfileAdmissionV1({
      filePath: directory, buyerAuthority: BUYER, sellerAuthority: SELLER,
    })(JOB_ID)).toThrow("not readable");
    expect(() => createDacsFileSessionProfileAdmissionV1({
      filePath: "", buyerAuthority: BUYER, sellerAuthority: SELLER,
    })).toThrow(TypeError);
  });
});
