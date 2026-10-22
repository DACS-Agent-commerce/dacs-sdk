import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { observePayDemTransferCore } from "@kynesyslabs/dacs/seller";
import {
  DACS_NODE_DEMOS_RPC_COMPATIBILITY_V1,
  inspectDacsDemosNodeCompatibilityV1,
} from "../src/demosCompatibility.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/demos-rpc-v1.json", import.meta.url), "utf8"));
const cleanBuild = () => ({ ...fixture.networkInfo,
  nodeVersion: { ...fixture.networkInfo.nodeVersion, dirty: false } });

describe("pinned Demos RPC compatibility", () => {
  it.each([null, undefined, false, 42, "node", []])("rejects non-object metadata %j without throwing", (metadata) => {
    expect(() => inspectDacsDemosNodeCompatibilityV1(metadata)).not.toThrow();
    expect(inspectDacsDemosNodeCompatibilityV1(metadata)).toEqual({
      compatible: false, reasonCode: "demos-node-build-unidentified",
    });
  });

  it.each(["commit", "version"])("distinguishes unidentified %s from an unsupported revision", (field) => {
    const info = cleanBuild();
    info.nodeVersion[field] = 42;
    expect(inspectDacsDemosNodeCompatibilityV1(info)).toEqual({
      compatible: false, reasonCode: "demos-node-build-unidentified",
    });
    info.nodeVersion[field] = "unsupported";
    expect(inspectDacsDemosNodeCompatibilityV1(info)).toEqual({
      compatible: false, reasonCode: "demos-node-revision-unsupported",
    });
  });

  it("rejects foreign software with otherwise pinned metadata", () => {
    const info = cleanBuild();
    info.nodeVersion.name = "foreign-node-software";
    expect(inspectDacsDemosNodeCompatibilityV1(info)).toEqual({
      compatible: false, reasonCode: "demos-node-build-unidentified",
    });
  });

  it("rejects the captured dirty deployment and admits only the identified clean reference build", () => {
    expect(fixture.networkInfo.nodeVersion.commit).toBe(DACS_NODE_DEMOS_RPC_COMPATIBILITY_V1.nodeSourceRevision);
    expect(inspectDacsDemosNodeCompatibilityV1(fixture.networkInfo)).toEqual({
      compatible: false, reasonCode: "demos-node-build-dirty",
    });
    // Synthetic clean metadata tests the policy; it is not a deployment claim.
    expect(inspectDacsDemosNodeCompatibilityV1(cleanBuild())).toEqual({
      compatible: true, reasonCode: "demos-node-compatible",
    });
    for (const version of [undefined, {}, { ...cleanBuild().nodeVersion, dirty: undefined },
      { ...cleanBuild().nodeVersion, commit: "0".repeat(40) },
      { ...cleanBuild().nodeVersion, version: "0.9.9" }]) {
      expect(inspectDacsDemosNodeCompatibilityV1({ nodeVersion: version }).compatible).toBe(false);
    }
    expect(inspectDacsDemosNodeCompatibilityV1({ result: 200, response: cleanBuild() }).compatible).toBe(false);
  });

  it("does not invoke accessors while inspecting node metadata", () => {
    const getter = vi.fn(() => cleanBuild().nodeVersion);
    expect(inspectDacsDemosNodeCompatibilityV1(Object.defineProperty({}, "nodeVersion", { get: getter })).compatible).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });

  it("replays captured native inclusion, OS denomination and block timestamp through the production observer", async () => {
    const txHash = fixture.transaction.response.hash;
    const getTxByHash = vi.fn(async () => fixture.transaction);
    const getBlockByNumber = vi.fn(async () => fixture.block);
    const client = {
      getTransactionStatus: async () => fixture.statusIncluded,
      getTxByHash, getBlockByNumber,
    };
    await expect(observePayDemTransferCore(txHash, client)).resolves.toMatchObject({
      status: "included", txHash, amountOs: "2400000000000",
      blockNumber: 26341, includedAt: 1785719206000,
    });
    getTxByHash.mockClear();
    getBlockByNumber.mockClear();
    await expect(observePayDemTransferCore(txHash, {
      ...client, getTransactionStatus: async () => fixture.statusUnknown,
    })).resolves.toMatchObject({ status: "not-found" });
    expect(getTxByHash).not.toHaveBeenCalled();
    expect(getBlockByNumber).not.toHaveBeenCalled();
  });
});
