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

  it("PSP-2/5 negative-match fails on a hit and passes only complete absence", () => {
    const spec: ParserSpec = { format: "raw", matcher: "SANCTIONED" };
    expect(evalSpec(spec, "SANCTIONED", { negativeMatch: true })).toBe("fail");
    expect(evalSpec(spec, "clean", { negativeMatch: true })).toBe("indeterminate");
    expect(
      evalSpec(spec, "clean", { negativeMatch: true, listComplete: true }),
    ).toBe("pass");
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

  it("PSP-5 cannot be bypassed by disabling the legacy completeness flag", () => {
    const spec: ParserSpec = { format: "json", successJsonPath: "$.hit" };
    expect(
      evalSpec(spec, JSON.stringify({ records: [] }), {
        negativeMatch: true,
        requiresCompleteness: false,
        listComplete: false,
      }),
    ).toBe("indeterminate");
    expect(
      evalSpec(spec, JSON.stringify({ records: [] }), {
        negativeMatch: true,
        requiresCompleteness: false,
        listComplete: true,
      }),
    ).toBe("pass");
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

  it("PSP-3 preserves structured selected values", () => {
    const spec: ParserSpec = {
      format: "json",
      successJsonPath: "$.ok",
      dataMap: {
        active: "$.active",
        count: "$.count",
        details: "$.details",
        tags: "$.tags",
      },
    };
    const r = evaluateParserSpec(
      spec,
      JSON.stringify({
        ok: true,
        active: true,
        count: 3,
        details: { status: "ISSUED" },
        tags: ["lei", "active"],
      }),
      defaultParserEngine,
    );
    expect(r.data).toEqual({
      active: true,
      count: 3,
      details: { status: "ISSUED" },
      tags: ["lei", "active"],
    });
  });

  it("PSP-3 dataMap is retained when indeterminateOn decides early", () => {
    const spec: ParserSpec = {
      format: "json",
      successJsonPath: "$.issued",
      indeterminateOn: [{ jsonPath: "$.lapsed" }],
      dataMap: { status: "$.status" },
    };
    const r = evaluateParserSpec(
      spec,
      JSON.stringify({ issued: true, lapsed: true, status: "LAPSED" }),
      defaultParserEngine,
    );
    expect(r.decision).toBe("indeterminate");
    expect(r.data).toEqual({ status: "LAPSED" });
  });

  it("PSP-4 deterministic: same spec + body ⇒ same decision", () => {
    const spec: ParserSpec = { format: "json", successJsonPath: "$.a" };
    const body = JSON.stringify({ a: 1 });
    expect(evalSpec(spec, body)).toBe(evalSpec(spec, body));
  });

  // ── Review counterexamples (second-round #49) ──

  it("an UNSUPPORTED JSONPath filter is rejected as error, never silently partial-parsed to fail", () => {
    const spec: ParserSpec = {
      format: "json",
      successJsonPath: '$.data[?(@.attributes.registration.status=="ISSUED")]',
    };
    // A body that a full JSONPath engine WOULD match must not come back `fail`;
    // the default engine can't evaluate the filter, so it is `error`.
    const body = JSON.stringify({ data: [{ attributes: { registration: { status: "ISSUED" } } }] });
    expect(evalSpec(spec, body)).toBe("error");
  });

  it("a non-RE2 matcher (backreference) is rejected as error, not run through JS RegExp", () => {
    // (a+)\1 is a backreference — accepted by JS RegExp, forbidden by RE2.
    const spec: ParserSpec = { format: "raw", matcher: "(a+)\\1" };
    expect(evalSpec(spec, "aa")).toBe("error");
    // Lookahead is likewise non-RE2.
    expect(evalSpec({ format: "raw", matcher: "foo(?=bar)" }, "foobar")).toBe("error");
  });

  it("a THROWING parser engine maps to error, it does not escape", () => {
    const throwingEngine = {
      evalPredicate() {
        throw new Error("engine blew up");
      },
    };
    const spec: ParserSpec = { format: "json", successJsonPath: "$.a" };
    expect(() =>
      evaluateParserSpec(spec, JSON.stringify({ a: 1 }), throwingEngine),
    ).not.toThrow();
    expect(evaluateParserSpec(spec, JSON.stringify({ a: 1 }), throwingEngine).decision).toBe("error");
  });

  it("an indeterminateOn predicate of the WRONG kind is malformed ⇒ error (never silently skipped/fail-open)", () => {
    const spec: ParserSpec = {
      format: "json",
      successJsonPath: "$.ok",
      // A selector predicate on a json spec — wrong kind for the format.
      indeterminateOn: [{ selector: ".pending" }],
    };
    expect(evalSpec(spec, JSON.stringify({ ok: true }))).toBe("error");
  });
});
