import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import {
  DACS_NODE_DEMOS_RPC_COMPATIBILITY_V1,
  inspectDacsDemosNodeCompatibilityV1,
} from "../../dacs-node/src/demosCompatibility.js";
import { liveProjectTemplates } from "../src/liveTemplates.js";

type Probe = () => Promise<{ status: string; reasonCode?: string; facts?: unknown }>;
type Runtime = { networkInfo: () => Promise<unknown> };

function generatedProbe(buyer: Runtime, seller: Runtime): Probe {
  const source = liveProjectTemplates({
    packageName: "doctor-contract", deployment: "docker", role: "buyer",
    rails: "pay-dem", runtimeUid: 10001, runtimeGid: 10001,
  })["src/doctor.ts"]!;
  // Compile the complete generated module. Expose its existing private factory
  // only in this test, and inject dependencies at the package/config boundary.
  const compiled = ts.transpileModule(
    source.replaceAll("import.meta.url", JSON.stringify(import.meta.url)) +
      "\nexport { baseProbes };\n",
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText;
  const nativeRequire = createRequire(import.meta.url);
  const dependencies = (name: string) => {
    if (name.startsWith("node:")) return nativeRequire(name);
    if (name === "@kynesyslabs/dacs-node") return {
      inspectDacsDemosNodeCompatibilityV1,
      dacsLiveRailProfiles: () => ["pay-dem"],
    };
    if (name === "./config.js") return {
      configuredRailStewardAuthority: () => undefined,
      loadRoleConfig: () => ({}),
    };
    return {};
  };
  const api = {} as { baseProbes: (
    actors: { buyer: { runtime: Runtime }; seller: { runtime: Runtime } },
    operation: undefined,
  ) => Record<string, Probe> };
  new Function("require", "exports", compiled)(dependencies, api);
  return api.baseProbes({ buyer: { runtime: buyer }, seller: { runtime: seller } }, undefined)[
    "demos.rpc-chain"
  ]!;
}

const clean = {
  nodeVersion: {
    name: "demos-node-software", version: DACS_NODE_DEMOS_RPC_COMPATIBILITY_V1.nodeVersion,
    commit: DACS_NODE_DEMOS_RPC_COMPATIBILITY_V1.nodeSourceRevision, dirty: false,
  },
};

describe("generated doctor RPC compatibility probe", () => {
  const compatibleFacts = {
    actorCount: 2,
    buyerNodeBuild: "demos-node-compatible",
    sellerNodeBuild: "demos-node-compatible",
  };

  it("reports compatible clean metadata read from both actors", async () => {
    const buyer = { networkInfo: vi.fn(async () => structuredClone(clean)) };
    const seller = { networkInfo: vi.fn(async () => structuredClone(clean)) };
    expect(await generatedProbe(buyer, seller)()).toEqual({
      status: "pass", facts: compatibleFacts,
    });
    expect(buyer.networkInfo).toHaveBeenCalledOnce();
    expect(seller.networkInfo).toHaveBeenCalledOnce();
  });

  // Build metadata is self-reported by the node, so it is advisory: the
  // default public RPC reports a dirty build and must not block start.
  const incompatible = [
    [{ ...clean.nodeVersion, dirty: true }, "demos-node-build-dirty"],
    [{ ...clean.nodeVersion, name: "foreign-node" }, "demos-node-build-unidentified"],
    [{ ...clean.nodeVersion, version: "0.0.0" }, "demos-node-revision-unsupported"],
    [{ ...clean.nodeVersion, commit: "0".repeat(40) }, "demos-node-revision-unsupported"],
    [{ name: "demos-node-software" }, "demos-node-build-unidentified"],
  ] as const;
  for (const role of ["buyer", "seller"] as const) {
    it.each(incompatible)(`reports incompatible ${role} metadata %j without blocking`, async (nodeVersion, reasonCode) => {
      const runtimes = {
        buyer: { networkInfo: vi.fn(async (): Promise<unknown> => structuredClone(clean)) },
        seller: { networkInfo: vi.fn(async (): Promise<unknown> => structuredClone(clean)) },
      };
      runtimes[role].networkInfo.mockResolvedValue({ nodeVersion });
      expect(await generatedProbe(runtimes.buyer, runtimes.seller)()).toEqual({
        status: "pass", facts: { ...compatibleFacts, [`${role}NodeBuild`]: reasonCode },
      });
      expect(runtimes.buyer.networkInfo).toHaveBeenCalledOnce();
      expect(runtimes.seller.networkInfo).toHaveBeenCalledOnce();
    });

    // demosdk's getNetworkInfo() resolves null on a transport failure; any
    // other non-object reply is a malformed response, not a build verdict.
    it.each([
      [null, "demos-rpc-unavailable"],
      [undefined, "demos-rpc-unavailable"],
      ["unavailable", "demos-rpc-response-malformed"],
      [500, "demos-rpc-response-malformed"],
      [[], "demos-rpc-response-malformed"],
    ] as const)(`fails when the ${role} RPC returns %j`, async (reply, reasonCode) => {
      const runtimes = {
        buyer: { networkInfo: vi.fn(async (): Promise<unknown> => structuredClone(clean)) },
        seller: { networkInfo: vi.fn(async (): Promise<unknown> => structuredClone(clean)) },
      };
      runtimes[role].networkInfo.mockResolvedValue(reply);
      expect(await generatedProbe(runtimes.buyer, runtimes.seller)()).toEqual({
        status: "fail", reasonCode,
      });
    });
  }

  it("does not block start on the default node2 RPC's captured dirty build", async () => {
    const capture = JSON.parse(readFileSync(new URL(
      "../../dacs-node/test/fixtures/demos-rpc-v1.json", import.meta.url,
    ), "utf8")) as { endpoint: string; networkInfo: unknown };
    expect(capture.endpoint).toContain("node2.demos.sh");
    const node2 = { networkInfo: async () => structuredClone(capture.networkInfo) };
    expect(await generatedProbe(node2, node2)()).toEqual({
      status: "pass",
      facts: {
        actorCount: 2,
        buyerNodeBuild: "demos-node-build-dirty",
        sellerNodeBuild: "demos-node-build-dirty",
      },
    });
  });

  it("fails when a runtime cannot read network metadata", async () => {
    const unavailable = { networkInfo: vi.fn(async () => { throw new Error("unavailable"); }) };
    expect(await generatedProbe(unavailable, { networkInfo: async () => clean })()).toEqual({
      status: "fail", reasonCode: "demos-rpc-unavailable",
    });
  });
});
