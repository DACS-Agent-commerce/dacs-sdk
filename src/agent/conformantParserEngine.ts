import {
  evaluate as evaluateJsonPath,
  functions as jsonPathFunctions,
  type EvaluationRealmInterface,
} from "@swaggerexpert/jsonpath";
import { DOMParser, onErrorStopParsing } from "@xmldom/xmldom";
import { selectAll } from "css-select";
import { DomUtils, parseDocument } from "htmlparser2";
import { RE2 } from "re2-wasm";
import { select as selectXPath } from "xpath";

import type {
  ParserEngine,
  ParserEngineCapabilities,
  ParserFormat,
  PredicateResult,
} from "./parserSpec.js";

type JsonPathFunction = (
  realm: EvaluationRealmInterface,
  ...args: unknown[]
) => unknown;

const isMarkedNodeList = (value: unknown): value is unknown[] & {
  _isNodelist: true;
} =>
  Array.isArray(value) &&
  (value as unknown as { _isNodelist?: unknown })._isNodelist === true;

const coerceJsonPathValue = (value: unknown): unknown => {
  if (!isMarkedNodeList(value)) return value;
  return value.length === 1 ? value[0] : undefined;
};

/**
 * Convert the I-Regexp subset used by RFC 9535 match()/search() to a pattern
 * that preserves its dot semantics and is then executed by RE2, never the JS
 * backtracking engine.
 */
function toIRegexpPattern(pattern: string): string | null {
  let result = "";
  let inCharacterClass = false;

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) return null;
      if (next >= "1" && next <= "9") return null;
      if (!inCharacterClass && (next === "b" || next === "B")) return null;
      result += char + next;
      i++;
      continue;
    }
    if (char === "[" && !inCharacterClass) {
      inCharacterClass = true;
      result += char;
      continue;
    }
    if (char === "]" && inCharacterClass) {
      inCharacterClass = false;
      result += char;
      continue;
    }
    if (char === "(" && pattern[i + 1] === "?") {
      const marker = pattern[i + 2];
      if (marker === "=" || marker === "!") return null;
      if (marker === "<") return null;
    }
    result += char === "." && !inCharacterClass ? "[^\\n\\r]" : char;
  }

  return inCharacterClass ? null : result;
}

function createIRegexpFunction(anchored: boolean): JsonPathFunction {
  return (realm, value, pattern) => {
    const stringValue = realm.getString(coerceJsonPathValue(value));
    const stringPattern = realm.getString(coerceJsonPathValue(pattern));
    if (stringValue === undefined || stringPattern === undefined) return false;
    const transformed = toIRegexpPattern(stringPattern);
    if (transformed === null) return false;
    try {
      const source = anchored ? `^(?:${transformed})$` : transformed;
      return new RE2(source, "u").test(stringValue);
    } catch {
      return false;
    }
  };
}

const safeJsonPathFunctions: Record<string, JsonPathFunction> = {
  ...(jsonPathFunctions as Record<string, JsonPathFunction>),
  match: createIRegexpFunction(true),
  search: createIRegexpFunction(false),
};

function queryJson(body: string, expression: string): unknown[] {
  const parsed: unknown = JSON.parse(body);
  return evaluateJsonPath(parsed, expression, {
    functions: safeJsonPathFunctions,
    trace: false,
  });
}

function queryHtml(body: string, expression: string) {
  // htmlparser2 builds a detached DOM only. It does not execute scripts, fetch
  // resources, or navigate; css-select evaluates solely over that local tree.
  const document = parseDocument(body, { decodeEntities: true });
  return selectAll(expression, document.children);
}

function parseXml(body: string) {
  // Stop at every xmldom parser diagnostic. Recovering a malformed XML body
  // and then producing a verdict would violate PSP-2's fail-closed rule.
  return new DOMParser({ onError: onErrorStopParsing }).parseFromString(
    body,
    "application/xml",
  );
}

function xmlNodeValue(node: Node): unknown {
  if (
    node.nodeType === node.ATTRIBUTE_NODE ||
    node.nodeType === node.TEXT_NODE ||
    node.nodeType === node.CDATA_SECTION_NODE ||
    node.nodeType === node.COMMENT_NODE ||
    node.nodeType === node.PROCESSING_INSTRUCTION_NODE
  ) {
    return node.nodeValue;
  }
  return node.textContent;
}

function extractXPathValue(body: string, expression: string): unknown {
  const selected = selectXPath(
    expression,
    parseXml(body) as unknown as Node,
  );
  if (Array.isArray(selected)) {
    const first = selected[0];
    return first === undefined ? null : xmlNodeValue(first);
  }
  return selected;
}

function evalPredicate(
  format: ParserFormat,
  expression: string,
  body: string,
): PredicateResult {
  try {
    switch (format) {
      case "json":
        return { matched: queryJson(body, expression).length > 0 };
      case "html":
        return { matched: queryHtml(body, expression).length > 0 };
      case "xml": {
        const selected = selectXPath(
          expression,
          parseXml(body) as unknown as Node,
        );
        // PSP-1 requires the XPath predicate to select at least one node. An
        // XPath scalar/boolean expression is a malformed predicate, not a match.
        return Array.isArray(selected)
          ? { matched: selected.length > 0 }
          : { parseError: true };
      }
      case "raw":
        return { matched: new RE2(expression, "u").test(body) };
    }
  } catch {
    return { parseError: true };
  }
}

function extract(
  format: ParserFormat,
  expression: string,
  body: string,
): unknown {
  try {
    switch (format) {
      case "json":
        return queryJson(body, expression)[0] ?? null;
      case "html": {
        const node = queryHtml(body, expression)[0];
        return node === undefined ? null : DomUtils.textContent(node);
      }
      case "xml":
        return extractXPathValue(body, expression);
      case "raw": {
        const match = new RE2(expression, "u").exec(body);
        return match === null ? null : (match[1] ?? match[0] ?? null);
      }
    }
  } catch {
    return null;
  }
}

export const defaultParserEngineCapabilities: ParserEngineCapabilities =
  Object.freeze({
    engine: "dacs-conformant-v1",
    formats: Object.freeze(["json", "html", "xml", "raw"] as const),
    jsonPath: "rfc9535",
    htmlSelector: "css-select",
    xmlXPath: "xpath-1.0",
    rawMatcher: "re2",
    executesScripts: false,
    fetchesSubresources: false,
    followsRedirects: false,
  });

/**
 * The SDK's full PSP-1..4 predicate engine. Verdict mapping, negative-match
 * polarity, indeterminate precedence, and PSP-5 remain in evaluateParserSpec.
 */
export const defaultParserEngine: ParserEngine = Object.freeze({
  capabilities: defaultParserEngineCapabilities,
  evalPredicate,
  extract,
});
