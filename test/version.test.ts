import { readFile } from "node:fs/promises";

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
});
