import { readFile } from "node:fs/promises";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import {
  DACS_MVP_TARGET,
  DACS_STANDARD_PIN,
  FIXED_PRICE_X402_STANDARD_REVISION,
} from "../src/index.js";

describe("public version metadata", () => {
  it("separates the SDK product target from the Standard oracle pin", () => {
    expect(DACS_MVP_TARGET).toBe("0.1");
    expect(DACS_STANDARD_PIN).toMatch(/^[0-9a-f]{40}$/);
    expect(FIXED_PRICE_X402_STANDARD_REVISION).toBe(DACS_STANDARD_PIN);
  });

  it("matches the immutable default used by the vector sync", async () => {
    const syncScript = await readFile(
      new URL("../scripts/sync-vectors.mjs", import.meta.url),
      "utf8",
    );

    expect(syncScript).toContain(
      `process.env.DACS_STANDARD_REF || "${DACS_STANDARD_PIN}"`,
    );
  });

  it("tests demosdk at the floor of its published peer range", async () => {
    // The compatibility workflow resolves its newest-in-range leg from the
    // peer range and its locked leg from package-lock.json.
    const packageJson = await import("../package.json", { with: { type: "json" } });
    const peer = packageJson.default.peerDependencies["@kynesyslabs/demosdk"];
    const lock = await import("../package-lock.json", { with: { type: "json" } });
    const floor = peer.match(/^\^(\d+\.\d+\.\d+)$/);
    expect(floor).not.toBeNull();
    expect(packageJson.default.devDependencies["@kynesyslabs/demosdk"]).toBe(peer);
    expect(lock.default.packages["node_modules/@kynesyslabs/demosdk"].version).toBe(floor?.[1]);
  });

  it("documents the published demosdk peer range in SECURITY.md", async () => {
    const packageJson = await import("../package.json", { with: { type: "json" } });
    const peer = packageJson.default.peerDependencies["@kynesyslabs/demosdk"];
    const security = await readFile(new URL("../SECURITY.md", import.meta.url), "utf8");
    expect(security).toContain(`peerDependencies: { "@kynesyslabs/demosdk": "${peer}" }`);
  });

  it("runs the demosdk compatibility workflow for every tracked compiler input", async () => {
    const workflow = parse(
      await readFile(new URL("../.github/workflows/demosdk-compat.yml", import.meta.url), "utf8"),
    ) as { on: { pull_request: { paths: string[] } } };
    expect(workflow.on.pull_request.paths).toEqual([
      ".github/workflows/demosdk-compat.yml",
      "package.json",
      "package-lock.json",
      "tsconfig*.json",
      "src/**",
      "test/**",
      "examples/**",
      "conformance/**",
      "packages/create-dacs-agent/src/**",
      "packages/dacs-client/**",
      "packages/dacs-node/**",
    ]);
  });

  it("keeps the package.json Standard revision equal to the exported Standard pin", async () => {
    const packageJson = await import("../package.json", { with: { type: "json" } });
    expect(packageJson.default.dacs.standardRevision).toBe(DACS_STANDARD_PIN);
  });
});
