import { DOMParser } from "@xmldom/xmldom";
import fontoxpath from "fontoxpath";
import { JSONPath } from "jsonpath-plus";
import { parseHTML } from "linkedom";
import { RE2 } from "re2-wasm";

import type {
  ParserEngine,
  ParserFormat,
  ParserSelectionResult,
} from "./parserSpec.js";

const { evaluateXPathToNodes } = fontoxpath;

/** Capabilities of the optional full ParserSpec engine. */
export const standardsParserEngineCapabilities = Object.freeze({
  jsonPath: "jsonpath-plus-safe",
  cssSelector: "linkedom-query-selector",
  xPath: "fontoxpath",
  regex: "re2-wasm",
} as const);

function nodeValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const node = value as {
    nodeType?: unknown;
    nodeValue?: unknown;
    textContent?: unknown;
  };
  if (
    (node.nodeType === 2 || node.nodeType === 3) &&
    typeof node.nodeValue === "string"
  ) {
    return node.nodeValue;
  }
  return typeof node.textContent === "string" ? node.textContent : value;
}

function selectJson(expr: string, body: string): readonly unknown[] {
  // JSONPath Plus supports both filter predicates used by the normative LEI
  // example and the ordinary selector surface. Script subscripts (`[(...)]`)
  // are not ParserSpec predicates and are rejected before evaluation.
  if (/\[\s*\(/.test(expr)) throw new Error("JSONPath script subscripts are not permitted");
  const json: unknown = JSON.parse(body);
  const selected = JSONPath({
    path: expr,
    json: json as object,
    resultType: "value",
    wrap: true,
    eval: "safe",
  });
  return Array.isArray(selected) ? selected : [selected];
}

function selectHtml(expr: string, body: string): readonly unknown[] {
  const { document } = parseHTML(body);
  return Array.from(document.querySelectorAll(expr)).map(nodeValue);
}

function selectXml(expr: string, body: string): readonly unknown[] {
  // Reject DTDs/entities and external-resource XPath functions. ParserSpec is
  // selection-only and PSP-4 forbids fetching sub-resources.
  if (/<!DOCTYPE/i.test(body)) throw new Error("XML DTDs are not permitted");
  if (
    /\b(?:collection|doc|json-doc|load-xquery-module|transform|unparsed-text(?:-lines)?|uri-collection)\s*\(/i.test(
      expr,
    )
  ) {
    throw new Error("external-resource XPath functions are not permitted");
  }
  const document = new DOMParser({
    onError(level, message) {
      if (level !== "warning") throw new Error(message);
    },
  }).parseFromString(body, "application/xml");
  return evaluateXPathToNodes(expr, document).map(nodeValue);
}

function selectRaw(expr: string, body: string): readonly unknown[] {
  // re2-wasm requires Unicode mode and throws for backreferences/lookaround.
  const match = new RE2(expr, "u").exec(body);
  return match ? [match[1] ?? match[0]] : [];
}

function select(
  format: ParserFormat,
  expr: string,
  body: string,
): ParserSelectionResult {
  try {
    const values =
      format === "json"
        ? selectJson(expr, body)
        : format === "html"
          ? selectHtml(expr, body)
          : format === "xml"
            ? selectXml(expr, body)
            : selectRaw(expr, body);
    return { values };
  } catch {
    return { parseError: true };
  }
}

/**
 * Standards-capable ParserSpec engine for callers that need filtered JSONPath,
 * CSS selectors, XPath, or actual linear-time RE2 execution. It performs only
 * local selection: scripts in response bodies are not run and embedded/external
 * resources are never fetched.
 *
 * Inject with `VetDeps.parserEngine`; the lightweight default remains available
 * for consumers that only need its documented JSONPath/raw subset.
 */
export const standardsParserEngine: ParserEngine = Object.freeze({
  evalPredicate(format: ParserFormat, expr: string, body: string) {
    const selected = select(format, expr, body);
    return selected.parseError
      ? selected
      : { matched: selected.values.length > 0 };
  },
  extract(format: ParserFormat, expr: string, body: string) {
    const selected = select(format, expr, body);
    return selected.parseError ? null : (selected.values[0] ?? null);
  },
  select,
});
