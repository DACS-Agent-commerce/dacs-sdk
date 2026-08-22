import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  DACS_NODE_CONFIG_SCHEMA_VERSION,
  DACS_NODE_RELEASE_METADATA_V1,
  DACS_NODE_SUPPORTED_SQLITE_MIGRATION_SOURCES,
} from "../src/release.js";
import { DACS_NODE_SQLITE_SCHEMA_VERSION } from "../src/sqlite.js";

describe("DACS Node release compatibility metadata", () => {
  it("matches every public package manifest", async () => {
    const manifests = await Promise.all([
      new URL("../../../package.json", import.meta.url),
      new URL("../package.json", import.meta.url),
      new URL("../../create-dacs-agent/package.json", import.meta.url),
    ].map(async (url) => JSON.parse(await readFile(url, "utf8")) as {
      version: string;
      dacs?: unknown;
    }));
    expect(manifests.map((manifest) => manifest.version))
      .toEqual(["0.1.0-alpha.0", "0.1.0-alpha.0", "0.1.0-alpha.0"]);
    for (const manifest of manifests) {
      expect(manifest.dacs).toEqual(DACS_NODE_RELEASE_METADATA_V1);
    }
    expect(DACS_NODE_CONFIG_SCHEMA_VERSION).toBe(1);
    expect(DACS_NODE_SQLITE_SCHEMA_VERSION).toBe(6);
    expect(DACS_NODE_SUPPORTED_SQLITE_MIGRATION_SOURCES)
      .toEqual([1, 2, 3, 4, 5, 6]);
  });
});
