import { describe, expect, it } from "vitest";

import { canonicalize, canonicalSignedScope } from "../../src/index.js";

// §7.1 / §7.2 canonicalize vectors (DACS-Standard §14).
describe("canonicalize (§7.1)", () => {
  it("canon-key-order: object members ordered by UTF-16 code unit of key", () => {
    expect(canonicalize({ b: 1, a: 2, A: 3 })).toBe('{"A":3,"a":2,"b":1}');
  });

  it("canon-nested: nested objects sorted; array order preserved", () => {
    expect(canonicalize({ z: [3, 1, 2], a: { y: 1, x: 2 } })).toBe(
      '{"a":{"x":2,"y":1},"z":[3,1,2]}',
    );
  });

  it("canon-escaping: only JCS-required escapes are applied", () => {
    expect(canonicalize("a\"b\\c\n\t")).toBe('"a\\"b\\\\c\\n\\t"');
  });

  it("canon-no-escape-slash: forward slash and non-ASCII are not escaped", () => {
    expect(canonicalize("a/bé")).toBe('"a/bé"');
  });

  it("canon-int: safe integers serialise as plain decimals", () => {
    expect(canonicalize(9007199254740991)).toBe("9007199254740991");
  });

  it("canon-noninteger-throws: non-integer numbers are rejected", () => {
    expect(() => canonicalize(1.5)).toThrow();
    expect(() => canonicalize(9007199254740993)).toThrow(); // beyond safe-integer
  });

  it("canon-without-signature: the signed scope excludes the signature field", () => {
    expect(canonicalSignedScope({ a: 1, signature: "deadbeef" })).toBe('{"a":1}');
  });
});
