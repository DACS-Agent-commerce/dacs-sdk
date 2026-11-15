import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const dir = new URL("../../conformance/tp1-node-observations-2026-11-08/", import.meta.url);
const manifest: typeof import("../../conformance/tp1-node-observations-2026-11-08/manifest.json") = JSON.parse(readFileSync(new URL("manifest.json", dir), "utf8"));

describe("pinned read-only node observation of TP-1 block two",() => {
  it("pins the manifest and records both endpoints and the unrecorded node build", () => {
    expect(createHash("sha256").update(readFileSync(new URL("manifest.json", dir))).digest("hex"))
      .toBe("5afa85ca50bcf96c6a82994d19825ce3428c31de724d9b7de7804eac7c3f9df5");
    expect(manifest).toMatchObject({
      format: "dacs-node-read-observations/v1",
      capturedAt: "2026-11-08T11:35:27Z",
      endpoint: "https://node2.demos.sh/",
      confirmedEqualFrom: "https://demosnode.discus.sh/",
      network: "TP-1",
      blockNumber: 2,
      nodeBuild: null,
    });
    expect(manifest.provenance).toContain("Read-only RPC read");
    expect(manifest.provenance).toContain("The node build was not recorded");
  });

  it("pins the sole observation's bytes, timestamp and read-only RPC request", () => {
    expect(Object.keys(manifest.sha256)).toEqual(["block2-2026-11-08.json"]);
    expect(readdirSync(dir).filter(name => name.endsWith(".json")).sort())
      .toEqual(["block2-2026-11-08.json", "manifest.json"]);
    for (const [name, digest] of Object.entries(manifest.sha256)) {
      const bytes = readFileSync(new URL(name, dir));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(digest);
      const observation = JSON.parse(bytes.toString("utf8"));
      expect(observation.time).toMatch(/^2026-11-08T11:35:27[.]/);
      expect(observation.http).toBe(200);
      expect(observation.request).toEqual({
        method: "nodeCall",
        params: [{ type: "nodeCall", message: "getBlockByNumber", data: { blockNumber: 2 } }],
      });
    }
  });
});
