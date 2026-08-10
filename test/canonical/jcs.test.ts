import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";

import { canonicalize, canonicalSignedScope, DacsError } from "../../src/index.js";

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

  it("canon-number: safe fractional numbers use RFC 8785 serialization", () => {
    expect(canonicalize(1.5)).toBe("1.5");
    expect(canonicalize(1e-7)).toBe("1e-7");
    expect(canonicalize(-0)).toBe("0");
    expect(() => canonicalize(9007199254740993)).toThrow(DacsError); // beyond safe-integer
  });

  it("rejects NFC-normalized key collisions", () => {
    expect(() => canonicalize({ "e\u0301": 1, "é": 2 })).toThrow(/NFC key collision/);
  });

  it("rejects lone UTF-16 surrogates with a typed error", () => {
    expect(() => canonicalize("\ud800")).toThrow(DacsError);
    expect(() => canonicalize("\ud800")).toThrow(/lone high surrogate/);
    expect(() => canonicalize("\udc00")).toThrow(/lone low surrogate/);
  });

  it("rejects sparse arrays without dispatching through input-controlled map", () => {
    const sparse = Array(1) as unknown[];
    expect(() => canonicalize(sparse)).toThrow(/sparse array/);

    const value = [1, 2] as number[] & { map: () => never };
    value.map = () => {
      throw new Error("must not run");
    };
    expect(() => canonicalize(value)).toThrow(/extra properties/);
  });

  it("rejects non-plain objects and cycles with typed bounded errors", () => {
    expect(() => canonicalize(new Date("2020-01-01T00:00:00Z"))).toThrow(DacsError);

    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    expect(() => canonicalize(cycle)).toThrow(DacsError);
    expect(() => canonicalize(cycle)).toThrow(/cyclic/);
  });

  it("accepts plain JSON objects created in another realm", () => {
    const crossRealm = runInNewContext(`JSON.parse('{"a":1}')`) as unknown;
    expect(canonicalize(crossRealm)).toBe('{"a":1}');
  });

  it("rejects objects with a custom null-rooted prototype", () => {
    const customPrototype = Object.assign(Object.create(null) as object, {
      constructor: Object,
    });
    const value = Object.assign(Object.create(customPrototype) as object, { a: 1 });
    expect(() => canonicalize(value)).toThrow(/plain JSON objects/);
  });

  it("accepts 64 nesting levels and rejects deeper input", () => {
    expect(() => canonicalize(nestedArrays(64))).not.toThrow();
    expect(() => canonicalize(nestedArrays(65))).toThrow(DacsError);
    expect(() => canonicalize(nestedArrays(200_000))).toThrow(/nesting depth exceeds 64/);
  });

  it("canon-without-signature: the signed scope excludes the signature field", () => {
    expect(canonicalSignedScope({ a: 1, signature: "deadbeef" })).toBe('{"a":1}');
  });

  it("rejects unpaired UTF-16 surrogates instead of hashing replacement bytes", () => {
    expect(() => canonicalize("\ud800")).toThrow(/unpaired UTF-16 surrogate/);
    expect(() => canonicalize("\udc00")).toThrow(/unpaired UTF-16 surrogate/);
    expect(() =>
      canonicalize(Object.fromEntries([["\ud800", "invalid key"]])),
    ).toThrow(/unpaired UTF-16 surrogate/);
    expect(canonicalize("\ud83d\ude00")).toBe('"😀"');
  });

  it("rejects non-JSON objects, sparse arrays, and array extensions", () => {
    const sparse = new Array(1);
    const extended: unknown[] & { extra?: string } = [];
    extended.extra = "unsigned";
    const accessor = new Array(1);
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get: () => "unsigned",
    });

    expect(() => canonicalize(sparse)).toThrow(/arrays must be dense/);
    expect(() => canonicalize(extended)).toThrow(/extra properties/);
    expect(() => canonicalize(accessor)).toThrow(/enumerable data properties/);
    expect(() => canonicalize(new Map())).toThrow(/plain JSON object/);
    expect(() => canonicalize(new Date(0))).toThrow(/plain JSON object/);
    expect(canonicalize({ omittedByJson: undefined, kept: true })).toBe(
      '{"kept":true}',
    );
  });

  it("rejects object keys that collide after NFC normalization", () => {
    const colliding = Object.fromEntries([
      ["é", 1],
      ["e\u0301", 2],
    ]);
    expect(() => canonicalize(colliding)).toThrow(
      /duplicate NFC-normalized keys/,
    );
  });
});

function nestedArrays(depth: number): unknown {
  let value: unknown = null;
  for (let index = 0; index < depth; index += 1) value = [value];
  return value;
}
