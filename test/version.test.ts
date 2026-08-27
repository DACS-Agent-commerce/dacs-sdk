import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import {
  DACS_MVP_TARGET,
  DACS_STANDARD_PIN,
  FIXED_PRICE_X402_STANDARD_REVISION,
} from "../src/index.js";

describe("published version metadata", () => {
  test("distinguishes the SDK milestone from the pinned conformance oracle", () => {
    expect(DACS_MVP_TARGET).toBe("0.1");
    expect(DACS_STANDARD_PIN).toMatch(/^[0-9a-f]{40}$/);
    expect(FIXED_PRICE_X402_STANDARD_REVISION).toBe(DACS_STANDARD_PIN);
  });

  test("keeps the vector synchronizer on the published Standard pin", async () => {
    const synchronizer = await readFile(
      new URL("../scripts/sync-vectors.mjs", import.meta.url),
      "utf8",
    );
    expect(synchronizer).toContain(`process.env.DACS_STANDARD_REF || "${DACS_STANDARD_PIN}"`);
  });
});
