import { describe, expect, test } from "vitest";

import {
  evaluateParserSpec,
  type CompleteParserSpec,
  type ParserSpec,
} from "../../src/agent/parserSpec.js";
import {
  standardsParserEngine,
  standardsParserEngineCapabilities,
} from "../../src/agent/standardsParserEngine.js";

const evaluate = (spec: ParserSpec, body: string) =>
  evaluateParserSpec(spec, body, standardsParserEngine);

describe("standardsParserEngine (DACS-2 PSP-1..5)", () => {
  test("executes the normative filtered JSONPath example", () => {
    const spec: ParserSpec = {
      format: "json",
      successJsonPath:
        "$.data[?(@.attributes.registration.status=='ISSUED')]",
      indeterminateOn: [
        {
          jsonPath:
            "$.data[?(@.attributes.registration.status=='LAPSED' || @.attributes.registration.status=='RETIRED')]",
        },
      ],
      dataMap: {
        status: "$.data[0].attributes.registration.status",
      },
    };
    const issued = JSON.stringify({
      data: [{ attributes: { registration: { status: "ISSUED" } } }],
    });
    const lapsed = JSON.stringify({
      data: [{ attributes: { registration: { status: "LAPSED" } } }],
    });
    expect(evaluate(spec, issued)).toMatchObject({
      decision: "pass",
      data: { status: "ISSUED" },
    });
    expect(evaluate(spec, lapsed)).toMatchObject({
      decision: "indeterminate",
      data: { status: "LAPSED" },
    });
  });

  test("supports CSS selectors without executing response scripts", () => {
    const spec: ParserSpec = {
      format: "html",
      successSelector: "main article[data-status='issued'] .identifier",
      dataMap: { name: "main article .name" },
    };
    const body = [
      "<main><article data-status='issued'>",
      "<span class='identifier'>ABC</span><span class='name'>Acme</span>",
      "<script>globalThis.parserSpecScriptRan = true</script>",
      "</article></main>",
    ].join("");
    expect(evaluate(spec, body)).toMatchObject({
      decision: "pass",
      data: { name: "Acme" },
    });
    expect(
      (globalThis as { parserSpecScriptRan?: boolean }).parserSpecScriptRan,
    ).toBeUndefined();
  });

  test("supports XPath and a recipe-declared end-of-list sentinel", () => {
    const spec: CompleteParserSpec = {
      format: "xml",
      successXPath: "//sdnEntry[idNumber='blocked']",
      completeness: {
        kind: "sentinel",
        expression: "/sdnList/publishInformation/publishDate",
      },
    };
    const complete = [
      "<sdnList><sdnEntry><idNumber>someone-else</idNumber></sdnEntry>",
      "<publishInformation><publishDate>2026-08-10</publishDate></publishInformation>",
      "</sdnList>",
    ].join("");
    const partial =
      "<sdnList><sdnEntry><idNumber>someone-else</idNumber></sdnEntry></sdnList>";
    expect(
      evaluateParserSpec(spec, complete, standardsParserEngine, {
        negativeMatch: true,
      }).decision,
    ).toBe("pass");
    expect(
      evaluateParserSpec(spec, partial, standardsParserEngine, {
        negativeMatch: true,
      }).decision,
    ).toBe("indeterminate");
  });

  test("uses actual RE2 execution and rejects non-RE2 expressions", () => {
    expect(
      evaluate({ format: "raw", matcher: "status\\s+ISSUED" }, "status ISSUED")
        .decision,
    ).toBe("pass");
    expect(evaluate({ format: "raw", matcher: "(a+)\\1" }, "aa").decision).toBe(
      "error",
    );
    expect(
      evaluate({ format: "raw", matcher: "foo(?=bar)" }, "foobar").decision,
    ).toBe("error");
    expect(standardsParserEngineCapabilities.regex).toBe("re2-wasm");
  });

  test("rejects JSONPath script subscripts and XPath external-resource functions", () => {
    expect(
      evaluate(
        { format: "json", successJsonPath: "$.items[(@.length-1)]" },
        JSON.stringify({ items: [1] }),
      ).decision,
    ).toBe("error");
    expect(
      evaluate(
        { format: "xml", successXPath: "doc('https://example.com/list.xml')" },
        "<root/>",
      ).decision,
    ).toBe("error");
  });
});
