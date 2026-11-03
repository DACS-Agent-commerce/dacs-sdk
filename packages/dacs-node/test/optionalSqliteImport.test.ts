import { expect, it, vi } from "vitest";

// Simulate a consumer installed with --omit=optional. Any eager native load
// breaks collection, even when the caller uses only host compatibility APIs.
const backendLoads = vi.hoisted(() => ({ count: 0 }));
vi.mock("better-sqlite3", () => {
  backendLoads.count += 1;
  throw new Error("optional SQLite backend unavailable");
});
import { DACS_NODE_RELEASE_METADATA_V1, inspectDacsDemosNodeCompatibilityV1 } from "../src/index.js";

it("imports the public host API without the optional SQLite backend", () => {
  expect(backendLoads.count).toBe(0);
  expect(DACS_NODE_RELEASE_METADATA_V1.sqliteSchemaVersion).toBe(8);
  expect(inspectDacsDemosNodeCompatibilityV1({}).reasonCode).toBe("demos-node-build-unidentified");
});

it("loads the optional backend only when the SQLite entry is selected", async () => {
  await expect(import("../src/sqlite.js")).rejects.toThrow();
  expect(backendLoads.count).toBe(1);
});
