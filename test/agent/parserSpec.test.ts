import { describe, expect, it } from "vitest";

import {
  defaultParserEngine,
  evaluateParserSpec,
  type ParserSpec,
} from "../../src/agent/parserSpec.js";

const evalSpec = (spec: ParserSpec, body: string, ctx = {}) =>
  evaluateParserSpec(spec, body, defaultParserEngine, ctx).decision;

describe("evaluateParserSpec (DACS-2 PSP-1..5)", () => {
  it("PSP-1/2 json positive-match: match ⇒ pass, none ⇒ fail", () => {
    const spec: ParserSpec = { format: "json", successJsonPath: "$.a.b" };
    expect(evalSpec(spec, JSON.stringify({ a: { b: 1 } }))).toBe("pass");
    expect(evalSpec(spec, JSON.stringify({ a: { c: 1 } }))).toBe("fail");
  });

  it("PSP-1 raw matcher uses a regex over the body", () => {
    const spec: ParserSpec = { format: "raw", matcher: "OK-\\d+" };
    expect(evalSpec(spec, "status OK-200")).toBe("pass");
    expect(evalSpec(spec, "status ERR")).toBe("fail");
  });

  it("PSP-2 negative-match inverts: match ⇒ fail, none ⇒ pass", () => {
    const spec: ParserSpec = { format: "raw", matcher: "SANCTIONED" };
    expect(evalSpec(spec, "SANCTIONED", { negativeMatch: true })).toBe("fail");
    expect(evalSpec(spec, "clean", { negativeMatch: true })).toBe("pass");
  });

  it("PSP-2 indeterminateOn precedes the match ⇒ indeterminate", () => {
    const spec: ParserSpec = {
      format: "json",
      successJsonPath: "$.ok",
      indeterminateOn: [{ jsonPath: "$.pending" }],
    };
    // Would be pass on the match, but the pending predicate fires first.
    expect(evalSpec(spec, JSON.stringify({ ok: true, pending: true }))).toBe("indeterminate");
  });

  it("PSP-2 malformed body ⇒ error (never fail)", () => {
    expect(evalSpec({ format: "json", successJsonPath: "$.a" }, "{bad")).toBe("error");
  });

  it("PSP-4/engine: html and xml are unsupported by the default engine ⇒ error", () => {
    expect(evalSpec({ format: "html", successSelector: ".x" }, "<div class=x/>")).toBe("error");
    expect(evalSpec({ format: "xml", successXPath: "//x" }, "<x/>")).toBe("error");
  });

  it("PSP-5 negative-match absence requires a complete response", () => {
    const spec: ParserSpec = { format: "json", successJsonPath: "$.hit" };
    const ctx = (listComplete: boolean) => ({
      negativeMatch: true,
      requiresCompleteness: true,
      listComplete,
    });
    expect(evalSpec(spec, JSON.stringify({ records: [] }), ctx(false))).toBe("indeterminate");
    expect(evalSpec(spec, JSON.stringify({ records: [] }), ctx(true))).toBe("pass");
  });

  it("PSP-3 dataMap is extracted for audit but never changes the decision", () => {
    const spec: ParserSpec = {
      format: "json",
      successJsonPath: "$.ok",
      dataMap: { name: "$.name", missing: "$.nope" },
    };
    const r = evaluateParserSpec(
      spec,
      JSON.stringify({ ok: true, name: "acme" }),
      defaultParserEngine,
    );
    expect(r.decision).toBe("pass");
    expect(r.data).toEqual({ name: "acme", missing: null });
  });

  it("PSP-4 deterministic: same spec + body ⇒ same decision", () => {
    const spec: ParserSpec = { format: "json", successJsonPath: "$.a" };
    const body = JSON.stringify({ a: 1 });
    expect(evalSpec(spec, body)).toBe(evalSpec(spec, body));
  });
});
