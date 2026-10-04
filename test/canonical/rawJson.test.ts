import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  admitRawJson,
  RawJsonAdmissionError,
  canonicalize,
  type RawJsonAdmissionOptions as RootAdmissionOptions,
} from "../../src/index.js";
import {
  admitRawJson as canonicalSubpath,
  type RawJsonAdmissionOptions as CanonicalAdmissionOptions,
} from "../../src/canonical/index.js";

interface Vector {
  name: string;
  rawUtf8Text?: string;
  rawHex?: string;
  expected: "accept" | "reject";
  expectedStage?: string;
  expectedErrorCode?: string;
  canonicalUtf8Hex?: string;
}
// Byte-exact upstream corpus, Standard b80919cd7b114499ffc3d9b5c2f3f91ca7fab3f6.
const corpus = JSON.parse(readFileSync(new URL(
  "../fixtures/standard-next/raw-json-profile-v0.1.json", import.meta.url,
), "utf8")) as { count: number; vectors: Vector[] };

describe("CORE CF-5 exact-byte admission", () => {
  it("exports the same admission function on both surfaces", () => {
    const rootOptions: RootAdmissionOptions = { maxBytes: 3 };
    const canonicalOptions: CanonicalAdmissionOptions = rootOptions;
    expect(canonicalSubpath).toBe(admitRawJson);
    expect(canonicalSubpath(Buffer.from("0"), canonicalOptions)).toBe(0);
    expect(corpus.vectors).toHaveLength(59);
  });
  for (const v of corpus.vectors) {
    it(v.name, () => {
      const bytes = v.rawHex === undefined
        ? Buffer.from(v.rawUtf8Text!, "utf8") : Buffer.from(v.rawHex, "hex");
      if (v.expected === "accept") {
        expect(Buffer.from(canonicalize(admitRawJson(bytes))).toString("hex"))
          .toBe(v.canonicalUtf8Hex);
      } else {
        expect(() => admitRawJson(bytes)).toThrow(RawJsonAdmissionError);
        try { admitRawJson(bytes); } catch (error) {
          expect(error).toMatchObject({ stage: v.expectedStage, code: v.expectedErrorCode });
        }
      }
    });
  }
  it("refuses decoded strings and pre-parsed objects", () => {
    for (const value of ['{"a":1}', { a: 1 }, null]) {
      expect(() => admitRawJson(value as unknown as Uint8Array)).toThrow(/BYTE-INPUT-REQUIRED/);
    }
  });
  it("honors byte view bounds and preserves prototype-named members", () => {
    const wrapped = Buffer.from('x{"__proto__":{"ok":true},"constructor":0}y');
    const result = admitRawJson(wrapped.subarray(1, -1)) as Record<string, unknown>;
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(canonicalize(result)).toBe('{"__proto__":{"ok":true},"constructor":0}');
  });
  it("applies the default byte budget at its exact boundary", () => {
    const atLimit = Buffer.from(`"${"a".repeat(1_048_574)}"`);
    expect(atLimit.byteLength).toBe(1_048_576);
    expect(admitRawJson(atLimit)).toBe("a".repeat(1_048_574));

    const aboveLimit = Buffer.from(`"${"a".repeat(1_048_575)}"`);
    expect(() => admitRawJson(aboveLimit)).toThrow(RawJsonAdmissionError);
    try { admitRawJson(aboveLimit); } catch (error) {
      expect(error).toMatchObject({ stage: "parse", code: "BYTE-LIMIT-EXCEEDED" });
    }
  });
  it("accepts bounded overrides and rejects invalid options or bounds", () => {
    expect(admitRawJson(Buffer.from("null"), { maxBytes: 4 })).toBeNull();
    expect(() => admitRawJson(Buffer.from("null"), { maxBytes: 3 }))
      .toThrow(/BYTE-LIMIT-EXCEEDED/);
    expect(admitRawJson(Buffer.from("null"), { maxBytes: 2_097_152 })).toBeNull();
    for (const maxBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_097_153]) {
      expect(() => admitRawJson(Buffer.from("0"), { maxBytes })).toThrow(TypeError);
    }
    for (const options of [null, "", [], { maxBytes: "1" }]) {
      expect(() => admitRawJson(
        Buffer.from("0"),
        options as unknown as Readonly<RootAdmissionOptions>,
      )).toThrow(TypeError);
    }
  });
  it("charges a Buffer subview rather than its backing allocation", () => {
    const backing = Buffer.alloc(1_048_577, 0x20);
    backing.set(Buffer.from("null"), 50);
    expect(admitRawJson(backing.subarray(50, 54), { maxBytes: 4 })).toBeNull();
  });
  it("does not let an overridden iterator expand the charged copy", () => {
    class IteratorOverride extends Uint8Array {
      override [Symbol.iterator](): ArrayIterator<number> {
        return [0x6e, 0x75, 0x6c, 0x6c].values();
      }
    }
    const input = new IteratorOverride([0x30]);
    expect(admitRawJson(input, { maxBytes: 1 })).toBe(0);
  });
  it("does not let a subclass shadow byteLength to evade the budget", () => {
    class ShadowedByteLength extends Uint8Array {}
    Object.defineProperty(ShadowedByteLength.prototype, "byteLength", { get: () => 1 });
    const input = new ShadowedByteLength(Buffer.from("null"));
    expect(input.byteLength).toBe(1);
    expect(() => admitRawJson(input, { maxBytes: 1 })).toThrow(/BYTE-LIMIT-EXCEEDED/);
  });
  it("rejects forged and proxied typed-array values as byte input", () => {
    const forged = Object.create(Uint8Array.prototype) as Uint8Array;
    const proxied = new Proxy(new Uint8Array([0x30]), {});
    for (const input of [forged, proxied, new Uint16Array([0x30]), new Uint8ClampedArray([0x30])]) {
      expect(() => admitRawJson(input as Uint8Array)).toThrow(/BYTE-INPUT-REQUIRED/);
    }
  });
  it("admits a genuine Uint8Array from another JavaScript realm", () => {
    const foreign = runInNewContext("new Uint8Array([0x30])") as Uint8Array;
    expect(foreign instanceof Uint8Array).toBe(false);
    expect(admitRawJson(foreign, { maxBytes: 1 })).toBe(0);
  });
  it("rejects hostile depth before a recursive parser sees it", () => {
    expect(() => admitRawJson(Buffer.from("[".repeat(100_000))))
      .toThrow(/JSON-NESTING-TOO-DEEP/);
  });
  it("counts containers rather than brackets in string data", () => {
    expect(admitRawJson(Buffer.from(JSON.stringify({ text: '["\\'.repeat(200) }))))
      .toEqual({ text: '["\\'.repeat(200) });
  });
});

// Exact comparisons that binary64 conversion alone cannot establish.
describe("raw decimal boundary siblings", () => {
  it("classifies binary64 overflow independently of decimal spelling", () => {
    for (const token of ["1e309", `1${"0".repeat(309)}`, "-1e309", `-1${"0".repeat(309)}`]) {
      try {
        admitRawJson(Buffer.from(token));
        throw new Error("expected admission failure");
      } catch (error) {
        expect(error).toMatchObject({ stage: "profile", code: "NUMBER-NOT-BINARY64" });
      }
    }
    expect(() => admitRawJson(Buffer.from(`1${"0".repeat(308)}`)))
      .toThrow(/NUMBER-OUTSIDE-DACS-MAGNITUDE/);
  });
  it.each(["9007199254740991.0000000000001", "-9007199254740991.0000000000001", "90071992547409910001e-4"])("rejects %s before rounding", (token) => {
    expect(() => admitRawJson(Buffer.from(token))).toThrow(/NUMBER-OUTSIDE-DACS-MAGNITUDE/);
  });
  it.each(["90071992547409910000e-4", "9007199254740990.9999999999999", "-0e999999999999999999999"])("admits %s", (token) => {
    expect(admitRawJson(Buffer.from(token))).toBe(Number(token));
  });
  it.each(["01", "[1,]", '{"x":1,}', "[true false]", "\\u0020null", "{unquoted:1}"])("refuses malformed grammar %s", (text) => {
    expect(() => admitRawJson(Buffer.from(text))).toThrow(RawJsonAdmissionError);
  });
  it.each([
    '["\\ud800",]',
    '{"a":0,"a":1,}',
    "[9007199254740992,]",
  ])("lets malformed syntax override an earlier profile error in %s", (text) => {
    try {
      admitRawJson(Buffer.from(text));
      throw new Error("expected admission failure");
    } catch (error) {
      expect(error).toMatchObject({ stage: "parse", code: "INVALID-JSON" });
    }
  });
  it("lets trailing data override an earlier profile error", () => {
    expect(() => admitRawJson(Buffer.from("9007199254740992 true")))
      .toThrow(/TRAILING-DATA/);
  });
  it("admits a wide shallow array without retaining a check per token", () => {
    const width = 50_000;
    const value = admitRawJson(Buffer.from(`[${"0,".repeat(width - 1)}0]`)) as unknown[];
    expect(value).toHaveLength(width);
    expect(value.at(-1)).toBe(0);
  });
  it("includes the admission guide in the published file allowlist", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      files?: string[];
    };
    expect(manifest.files).toContain("docs/raw-json-admission.md");
  });
});
