import { describe, expect, it } from "vitest";
import { isExactJsonRecord } from "../../src/artifacts/validators.js";
import { canonicalize, MAX_NESTING_DEPTH } from "../../src/canonical/jcs.js";

describe("shared CF-5 container bound", () => {
  it.each([1, 64, 65, 127, 128, 129])("validator and canonicalizer agree at depth %s", (depth) => {
    let value: unknown = null;
    for (let index = 0; index < depth; index += 1) value = { value };
    expect(isExactJsonRecord(value)).toBe(depth <= MAX_NESTING_DEPTH);
    if (depth <= MAX_NESTING_DEPTH) expect(() => canonicalize(value)).not.toThrow();
    else expect(() => canonicalize(value)).toThrow(/nesting depth/);
  });
});
