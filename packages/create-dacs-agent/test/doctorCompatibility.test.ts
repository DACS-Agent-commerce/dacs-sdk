import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DACS_NODE_DEMOS_RPC_COMPATIBILITY_V1,
  inspectDacsDemosNodeCompatibilityV1,
} from "../../dacs-node/src/demosCompatibility.js";
import { liveProjectTemplates } from "../src/liveTemplates.js";

afterEach(() => vi.unstubAllEnvs());

type Probe = () => Promise<{ status: string; reasonCode?: string; facts?: unknown }>;
type NodeCall = (message: string, args: Readonly<Record<string, unknown>>) => Promise<unknown>;
type Runtime = {
  adapter: { raw: { nodeCall?: NodeCall; getNetworkInfo?: () => Promise<unknown> } };
  networkInfo?: () => Promise<unknown>;
};

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

// Each probe run must ask the node itself, through the uncached raw reader.
function nodeRuntime(reply: () => Promise<unknown>) {
  const nodeCall = vi.fn(async (message: string, args: Readonly<Record<string, unknown>>) => {
    expect([message, args]).toEqual(["getNetworkInfo", {}]);
    return reply();
  });
  return { adapter: { raw: { nodeCall } } };
}

const forks = { osDenomination: { activationHeight: 0, activated: true, currentHeight: 1 } };
const clean = {
  forks,
  nodeVersion: {
    name: "demos-node-software", version: DACS_NODE_DEMOS_RPC_COMPATIBILITY_V1.nodeVersion,
    commit: DACS_NODE_DEMOS_RPC_COMPATIBILITY_V1.nodeSourceRevision, dirty: false,
  },
};

describe("generated doctor RPC compatibility probe", () => {
  it.each([undefined, "", "testnet"])("uses testnet for policy %j", async (policy) => {
    vi.stubEnv("DACS_DEMOS_DEPLOYMENT_POLICY", policy);
    const runtime = nodeRuntime(async () => structuredClone(clean));
    expect(await generatedProbe(runtime, runtime)()).toEqual({
      status: "pass", facts: compatibleFacts,
    });
    expect(runtime.adapter.raw.nodeCall).toHaveBeenCalledTimes(2);
  });

  it.each(["Testnet", "test", "testnet ", " production", "PRODUCTION", " "])(
    "reports invalid policy %j before calling the RPC", async (policy) => {
      vi.stubEnv("DACS_DEMOS_DEPLOYMENT_POLICY", policy);
      const runtime = nodeRuntime(async () => structuredClone(clean));
      expect(await generatedProbe(runtime, runtime)()).toEqual({
        status: "fail", reasonCode: "demos-deployment-policy-invalid",
      });
      expect(runtime.adapter.raw.nodeCall).not.toHaveBeenCalled();
    },
  );

  it.each([
    clean,
    { ...clean, nodeVersion: { ...clean.nodeVersion, dirty: true } },
    { ...clean, nodeVersion: { ...clean.nodeVersion, commit: "0".repeat(40) } },
  ])("blocks production without authenticated deployment provenance: %j", async (reply) => {
    vi.stubEnv("DACS_DEMOS_DEPLOYMENT_POLICY", "production");
    const runtime = nodeRuntime(async () => reply);
    expect(await generatedProbe(runtime, runtime)()).toEqual({
      status: "blocked", reasonCode: "demos-deployment-pin-unverified",
    });
    expect(runtime.adapter.raw.nodeCall).not.toHaveBeenCalled();
    vi.stubEnv("DACS_DEMOS_DEPLOYMENT_POLICY", "testnet");
    expect((await generatedProbe(runtime, runtime)()).status).toBe("pass");
  });
  const compatibleFacts = {
    actorCount: 2,
    deploymentPolicy: "testnet",
    buyerNodeBuild: "demos-node-compatible",
    sellerNodeBuild: "demos-node-compatible",
  };

  it("reports compatible clean metadata read from both actors", async () => {
    const buyer = nodeRuntime(async () => structuredClone(clean));
    const seller = nodeRuntime(async () => structuredClone(clean));
    expect(await generatedProbe(buyer, seller)()).toEqual({
      status: "pass", facts: compatibleFacts,
    });
    expect(buyer.adapter.raw.nodeCall).toHaveBeenCalledOnce();
    expect(seller.adapter.raw.nodeCall).toHaveBeenCalledOnce();
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
        buyer: nodeRuntime(async () => structuredClone(clean)),
        seller: nodeRuntime(async () => structuredClone(clean)),
      };
      runtimes[role].adapter.raw.nodeCall.mockResolvedValue({ forks, nodeVersion });
      expect(await generatedProbe(runtimes.buyer, runtimes.seller)()).toEqual({
        status: "pass", facts: { ...compatibleFacts, [`${role}NodeBuild`]: reasonCode },
      });
      expect(runtimes.buyer.adapter.raw.nodeCall).toHaveBeenCalledOnce();
      expect(runtimes.seller.adapter.raw.nodeCall).toHaveBeenCalledOnce();
    });

    // demosdk's raw nodeCall resolves a { result, response } envelope when the
    // transport fails. Node result codes are discarded, so even an explicit
    // string node error is classified as a malformed response.
    it.each([
      [null, "demos-rpc-unavailable"],
      [{ error: "STATE_NOT_READY", message: "booting" }, "demos-rpc-unavailable"],
      [{ error: "unavailable" }, "demos-rpc-unavailable"],
      [undefined, "demos-rpc-unavailable"],
      [{ result: 500, response: {}, require_reply: false, extra: null }, "demos-rpc-unavailable"],
      ["unavailable", "demos-rpc-response-malformed"],
      ["No address specified", "demos-rpc-response-malformed"],
      ["Error in nodeCall: STATE_NOT_READY", "demos-rpc-response-malformed"],
      [500, "demos-rpc-response-malformed"],
      [[], "demos-rpc-response-malformed"],
      [{ nodeVersion: clean.nodeVersion }, "demos-rpc-response-malformed"],
      [{ forks: null, nodeVersion: clean.nodeVersion }, "demos-rpc-response-malformed"],
      [{ forks: { osDenomination: { activated: "true" } } }, "demos-rpc-response-malformed"],
    ] as const)(`fails when the ${role} RPC returns %j`, async (reply, reasonCode) => {
      const runtimes = {
        buyer: nodeRuntime(async () => structuredClone(clean)),
        seller: nodeRuntime(async () => structuredClone(clean)),
      };
      runtimes[role].adapter.raw.nodeCall.mockResolvedValue(reply);
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
    const node2 = nodeRuntime(async () => structuredClone(capture.networkInfo));
    expect(await generatedProbe(node2, node2)()).toEqual({
      status: "pass",
      facts: {
        actorCount: 2,
        deploymentPolicy: "testnet",
        buyerNodeBuild: "demos-node-build-dirty",
        sellerNodeBuild: "demos-node-build-dirty",
      },
    });
  });

  it("fails when a runtime cannot read network metadata", async () => {
    const unavailable = nodeRuntime(async () => { throw new Error("unavailable"); });
    expect(await generatedProbe(unavailable, nodeRuntime(async () => clean))()).toEqual({
      status: "fail", reasonCode: "demos-rpc-unavailable",
    });
  });

  it("fails without a raw reader instead of reusing the SDK's cached answer", async () => {
    // A custom adapter without nodeCall exposes only the caching convenience reads.
    const cached = vi.fn(async () => structuredClone(clean));
    const legacy = { adapter: { raw: { getNetworkInfo: cached } }, networkInfo: cached };
    expect(await generatedProbe(legacy, nodeRuntime(async () => clean))()).toEqual({
      status: "fail", reasonCode: "demos-adapter-raw-reader-missing",
    });
    expect(cached).not.toHaveBeenCalled();
  });

  it("reports an outage after an earlier healthy read on the same runtime", async () => {
    let reachable = true;
    const transportFailure = { result: 500, response: {}, require_reply: false, extra: null };
    const buyer = nodeRuntime(async () => reachable ? structuredClone(clean) : transportFailure);
    const seller = nodeRuntime(async () => structuredClone(clean));
    const probe = generatedProbe(buyer, seller);
    expect(await probe()).toEqual({ status: "pass", facts: compatibleFacts });
    reachable = false;
    expect(await probe()).toEqual({ status: "fail", reasonCode: "demos-rpc-unavailable" });
    expect(buyer.adapter.raw.nodeCall).toHaveBeenCalledTimes(2);
  });

  it("reports a replacement node's build after an earlier read on the same runtime", async () => {
    let reply: unknown = clean;
    const buyer = nodeRuntime(async () => structuredClone(reply));
    const seller = nodeRuntime(async () => structuredClone(clean));
    const probe = generatedProbe(buyer, seller);
    expect(await probe()).toEqual({ status: "pass", facts: compatibleFacts });
    reply = { forks, nodeVersion: { ...clean.nodeVersion, dirty: true } };
    expect(await probe()).toEqual({
      status: "pass", facts: { ...compatibleFacts, buyerNodeBuild: "demos-node-build-dirty" },
    });
  });
});
