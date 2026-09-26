import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { admitRawJson, RawJsonAdmissionError, canonicalize } from "../../src/index.js";
import { admitRawJson as canonicalSubpath } from "../../src/canonical/index.js";

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
    expect(canonicalSubpath).toBe(admitRawJson);
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
  it.each(["9007199254740991.0000000000001", "-9007199254740991.0000000000001", "90071992547409910001e-4"])("rejects %s before rounding", (token) => {
    expect(() => admitRawJson(Buffer.from(token))).toThrow(/NUMBER-OUTSIDE-DACS-MAGNITUDE/);
  });
  it.each(["90071992547409910000e-4", "9007199254740990.9999999999999", "-0e999999999999999999999"])("admits %s", (token) => {
    expect(admitRawJson(Buffer.from(token))).toBe(Number(token));
  });
  it.each(["01", "[1,]", '{"x":1,}', "[true false]", "\\u0020null", "{unquoted:1}"])("refuses malformed grammar %s", (text) => {
    expect(() => admitRawJson(Buffer.from(text))).toThrow(RawJsonAdmissionError);
  });
});
