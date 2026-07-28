import { describe, expect, test } from "vitest";

import {
  listingAddress,
  logicalToStorageProgramName,
} from "../../src/canonical/index.js";

describe("logicalToStorageProgramName (DACS-1 §6.3.4 Demos binding)", () => {
  test("percent-encodes every colon → the program name is colon-free", () => {
    const logical = listingAddress("cci-xm:evm:mainnet:0x1234", "my-listing", 3);
    // logical is colon-bearing (structural separators); the program name is not.
    expect(logical).toContain(":");
    const name = logicalToStorageProgramName(logical);
    expect(name).not.toContain(":");
    expect(name).toContain("%3A"); // colons encoded, not dropped
  });

  test("session artifact names become colon-free too", () => {
    expect(logicalToStorageProgramName("dacs3:agreement:job-1")).toBe(
      "dacs3%3Aagreement%3Ajob-1",
    );
  });

  test("deterministic and injective for distinct logical names", () => {
    const a = logicalToStorageProgramName("dacs4:evidence:jobA");
    const b = logicalToStorageProgramName("dacs4:evidence:jobB");
    expect(a).toBe(logicalToStorageProgramName("dacs4:evidence:jobA")); // stable
    expect(a).not.toBe(b);
  });

  test("a name with no colons is unchanged", () => {
    expect(logicalToStorageProgramName("plain-name")).toBe("plain-name");
  });
});
