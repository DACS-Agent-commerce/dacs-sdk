/**
 * DACS-2 §7.4.1 ParserSpec — the steward-signed, per-scheme rules a verifier
 * applies to an attested response body to produce a decision (PSP-1..5). The
 * decision is DETERMINISTIC from the signed recipe: two conformant verifiers
 * running the same pinned recipe over the same body MUST agree.
 *
 * The low-level predicate matching (does this JSONPath select ≥1 node? does this
 * selector match?) is delegated to an injected {@link ParserEngine}, but the
 * engine returns predicate RESULTS (matched / parse-error), never a verdict —
 * the PSP-2 decision mapping (polarity, indeterminateOn precedence, error
 * mapping, PSP-5 completeness floor) lives here, driven by the signed recipe.
 * This replaces the earlier free-form `checkBody` callback, which let two impls
 * reach different verdicts from the same recipe.
 */

import { RE2 } from "re2-wasm";

export type ParserFormat = "json" | "html" | "xml" | "raw";

export type IndeterminatePredicate =
  | { jsonPath: string }
  | { selector: string }
  | { xPath: string }
  | { matcher: string };

export type ParserSpec =
  | { format: "json"; successJsonPath: string; indeterminateOn?: IndeterminatePredicate[]; dataMap?: Record<string, string> }
  | { format: "html"; successSelector: string; indeterminateOn?: IndeterminatePredicate[]; dataMap?: Record<string, string> }
  | { format: "xml"; successXPath: string; indeterminateOn?: IndeterminatePredicate[]; dataMap?: Record<string, string> }
  | { format: "raw"; matcher: string; indeterminateOn?: IndeterminatePredicate[] };

/**
 * PSP-5 completeness proof declared inside a steward-signed negative-match
 * recipe. The verifier evaluates the selected signal itself; callers cannot
 * substitute a precomputed "complete" Boolean.
 */
export type CompletenessCheck =
  | {
      kind: "record-count";
      /** Select exactly one non-negative integer declared by the authority. */
      declaredCountExpression: string;
      /** Select every downloaded record; the selection cardinality is compared. */
      recordsExpression: string;
    }
  | {
      kind: "sentinel";
      /** Select the authority-documented end-of-list sentinel. */
      expression: string;
    }
  | {
      kind: "content-length";
    };

/** A ParserSpec that is completeness-gated by construction for PSP-5. */
export type CompleteParserSpec = ParserSpec & {
  completeness: CompletenessCheck;
};

/** Result of evaluating ONE predicate expression against a body. */
export type PredicateResult = { parseError: true } | { parseError?: false; matched: boolean };

/** Nodes/values selected by one expression, used for PSP-3 and record counts. */
export type ParserSelectionResult =
  | { parseError: true }
  | { parseError?: false; values: readonly unknown[] };

/**
 * The pluggable predicate evaluator (PSP-1/PSP-4). MUST be deterministic and MUST
 * NOT execute scripts, fetch sub-resources, or follow redirects (PSP-4). It only
 * reports whether an expression matches — it never decides pass/fail.
 */
export interface ParserEngine {
  /** Does `expr` select ≥1 node/element/match in `body`? `parseError` if the body is malformed for `format`. */
  evalPredicate(format: ParserFormat, expr: string, body: string): PredicateResult;
  /**
   * PSP-3 dataMap extraction (audit-only). Preserve the selected value's JSON
   * shape; return null when nothing resolves.
   */
  extract?(format: ParserFormat, expr: string, body: string): unknown;
  /**
   * Select every matching node/value. Required only for PSP-5 record-count
   * checks; engines without it fail closed for that completeness mode.
   */
  select?(format: ParserFormat, expr: string, body: string): ParserSelectionResult;
}

export interface ParserEvalContext {
  /** PSP-2: a match means "listed" — invert the outcome (recipe.negativeMatch). */
  negativeMatch?: boolean;
  /**
   * PSP-5 Content-Length declared by the authority for the attested response.
   * The evaluator compares it with the UTF-8 byte length of `body` itself.
   */
  declaredContentLength?: number;
}

export type ParserDecision = "pass" | "fail" | "error" | "indeterminate";

export interface ParserEvaluation {
  decision: ParserDecision;
  /** PSP-3 extracted data (audit-only; never changes the decision). */
  data?: Record<string, unknown>;
  reason?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** The success match-predicate expression for a spec (PSP-1). */
export function successExpr(spec: ParserSpec): string {
  switch (spec.format) {
    case "json":
      return spec.successJsonPath;
    case "html":
      return spec.successSelector;
    case "xml":
      return spec.successXPath;
    case "raw":
      return spec.matcher;
  }
}

/** The expression of an indeterminateOn predicate appropriate to `format`, or null if the kind mismatches. */
export function predicateExpr(format: ParserFormat, p: IndeterminatePredicate): string | null {
  if (format === "json" && "jsonPath" in p) return p.jsonPath;
  if (format === "html" && "selector" in p) return p.selector;
  if (format === "xml" && "xPath" in p) return p.xPath;
  if (format === "raw" && "matcher" in p) return p.matcher;
  return null;
}

type CompletenessEvaluation =
  | { decision: "complete" }
  | { decision: "indeterminate"; reason: string }
  | { decision: "error"; reason: string };

function declaredRecordCount(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)) {
    const count = Number(value);
    return Number.isSafeInteger(count) ? count : null;
  }
  return null;
}

function evaluateCompleteness(
  spec: ParserSpec,
  body: string,
  engine: ParserEngine,
  ctx: ParserEvalContext,
): CompletenessEvaluation {
  const raw = (spec as ParserSpec & { completeness?: unknown }).completeness;
  if (!isObj(raw) || typeof raw["kind"] !== "string") {
    return {
      decision: "error",
      reason: "negative-match recipe is missing a signed PSP-5 completeness check",
    };
  }

  if (raw["kind"] === "content-length") {
    const declared = ctx.declaredContentLength;
    const received = Buffer.byteLength(body, "utf8");
    if (
      !Number.isSafeInteger(declared) ||
      (declared ?? -1) < 0 ||
      declared !== received
    ) {
      return {
        decision: "indeterminate",
        reason: "declared Content-Length did not confirm the received byte count (PSP-5)",
      };
    }
    return { decision: "complete" };
  }

  if (raw["kind"] === "sentinel") {
    const expression = raw["expression"];
    if (typeof expression !== "string" || expression.length === 0) {
      return {
        decision: "error",
        reason: "PSP-5 sentinel completeness check is malformed",
      };
    }
    let sentinel: PredicateResult;
    try {
      sentinel = engine.evalPredicate(spec.format, expression, body);
    } catch {
      sentinel = { parseError: true };
    }
    if (sentinel.parseError) {
      return {
        decision: "error",
        reason: "PSP-5 sentinel could not be evaluated",
      };
    }
    return sentinel.matched
      ? { decision: "complete" }
      : {
          decision: "indeterminate",
          reason: "documented end-of-list sentinel was not present (PSP-5)",
        };
  }

  if (raw["kind"] === "record-count") {
    const declaredExpression = raw["declaredCountExpression"];
    const recordsExpression = raw["recordsExpression"];
    if (
      typeof declaredExpression !== "string" ||
      declaredExpression.length === 0 ||
      typeof recordsExpression !== "string" ||
      recordsExpression.length === 0
    ) {
      return {
        decision: "error",
        reason: "PSP-5 record-count completeness check is malformed",
      };
    }
    if (!engine.select) {
      return {
        decision: "error",
        reason: "parser engine cannot evaluate PSP-5 record-count completeness",
      };
    }
    let declared: ParserSelectionResult;
    let records: ParserSelectionResult;
    try {
      declared = engine.select(spec.format, declaredExpression, body);
      records = engine.select(spec.format, recordsExpression, body);
    } catch {
      return {
        decision: "error",
        reason: "PSP-5 record-count expressions could not be evaluated",
      };
    }
    if (declared.parseError || records.parseError) {
      return {
        decision: "error",
        reason: "PSP-5 record-count expressions could not be evaluated",
      };
    }
    const expected =
      declared.values.length === 1
        ? declaredRecordCount(declared.values[0])
        : null;
    if (expected === null || expected !== records.values.length) {
      return {
        decision: "indeterminate",
        reason: "declared record count did not match downloaded records (PSP-5)",
      };
    }
    return { decision: "complete" };
  }

  return {
    decision: "error",
    reason: "PSP-5 completeness check has an unsupported kind",
  };
}

/**
 * Evaluate a ParserSpec against an attested body per PSP-1..5. See the module doc.
 */
export function evaluateParserSpec(
  spec: ParserSpec,
  body: string,
  engine: ParserEngine,
  ctx: ParserEvalContext = {},
): ParserEvaluation {
  const format = spec.format;

  // PSP-3 dataMap extraction is audit-only and MUST be retained for every
  // decision reached over the body, including an early `indeterminateOn`
  // decision. A throwing extractor records null and never changes the verdict.
  let data: Record<string, unknown> | undefined;
  const dataMap = "dataMap" in spec ? spec.dataMap : undefined;
  if (dataMap && engine.extract) {
    const extract = engine.extract;
    data = {};
    for (const [field, expr] of Object.entries(dataMap)) {
      try {
        data[field] = extract(format, expr, body) ?? null;
      } catch {
        data[field] = null;
      }
    }
  }
  const result = (
    decision: ParserDecision,
    reason?: string,
  ): ParserEvaluation => ({
    decision,
    ...(data ? { data } : {}),
    ...(reason ? { reason } : {}),
  });

  // A thrown parser engine is a verifier-side inability to obtain a decision, NOT
  // a claim `fail` — map it to a parse error so it becomes `error`, never escaping.
  const evalPredicate = (expr: string): PredicateResult => {
    try {
      return engine.evalPredicate(format, expr, body);
    } catch {
      return { parseError: true };
    }
  };

  // PSP-2: indeterminateOn predicates are evaluated BEFORE the match predicate;
  // if any matches, the decision is `indeterminate` and the match is not applied.
  // A parse failure here is a verifier-side failure → `error` (never `fail`).
  for (const p of spec.indeterminateOn ?? []) {
    const expr = predicateExpr(format, p);
    if (expr == null) {
      // A predicate whose kind doesn't match the spec format is a MALFORMED signed
      // recipe. Skipping it would fail open (a guard silently not evaluated); a
      // malformed rule must be `error`, never ignored.
      return result(
        "error",
        `indeterminateOn predicate kind does not match format "${format}" (malformed recipe)`,
      );
    }
    const r = evalPredicate(expr);
    if (r.parseError) return result("error", "response body did not parse (PSP-2)");
    if (r.matched) {
      return result(
        "indeterminate",
        "an indeterminateOn predicate matched (PSP-2)",
      );
    }
  }

  // PSP-1: the success match predicate.
  const m = evalPredicate(successExpr(spec));
  if (m.parseError) return result("error", "response body did not parse (PSP-2)");

  // PSP-2 decision mapping (polarity).
  const neg = ctx.negativeMatch === true;
  let decision: ParserDecision = neg
    ? m.matched
      ? "fail" // match = "listed"
      : "pass" // no match = "not listed"
    : m.matched
      ? "pass"
      : "fail";

  // PSP-5: every signed negative-match recipe carries its completeness basis.
  // The evaluator verifies that basis itself before allowing absence => pass.
  if (neg && decision === "pass") {
    const completeness = evaluateCompleteness(spec, body, engine, ctx);
    if (completeness.decision !== "complete") {
      return result(completeness.decision, completeness.reason);
    }
  }

  return result(decision);
}

type JsonPathToken = { key: string } | { index: number } | { wildcard: true };

/**
 * STRICTLY parse the supported JSONPath subset (`$`, `.key`, `[n]`, `[*]`).
 * Returns null if the expression contains ANY unsupported construct — a filter
 * (`[?(…)]`), quoted/union/slice selector, recursive descent, etc. — so the
 * caller can reject it (→ `error`) rather than silently partial-interpreting it
 * and returning a wrong match/no-match (PSP-4 determinism).
 */
function parseJsonPath(path: string): JsonPathToken[] | null {
  if (!path.startsWith("$")) return null;
  const tokens: JsonPathToken[] = [];
  let i = 1;
  while (i < path.length) {
    const c = path[i];
    if (c === ".") {
      let j = i + 1;
      while (j < path.length && path[j] !== "." && path[j] !== "[") j++;
      const key = path.slice(i + 1, j);
      if (!key || key === "*" || key.includes("*")) return null; // recursive/wildcard descent unsupported
      tokens.push({ key });
      i = j;
    } else if (c === "[") {
      const close = path.indexOf("]", i);
      if (close === -1) return null;
      const inner = path.slice(i + 1, close);
      if (inner === "*") tokens.push({ wildcard: true });
      else if (/^\d+$/.test(inner)) tokens.push({ index: Number(inner) });
      else return null; // filters, quoted keys, unions, slices — unsupported
      i = close + 1;
    } else {
      return null;
    }
  }
  return tokens;
}

/**
 * Resolve the supported JSONPath subset to the selected nodes, or null if the
 * expression uses an unsupported construct (a fuller engine can be injected via
 * {@link ParserEngine}). Deterministic (PSP-4).
 */
function resolveJsonPath(root: unknown, path: string): unknown[] | null {
  const tokens = parseJsonPath(path);
  if (tokens === null) return null;
  let cur: unknown[] = [root];
  for (const t of tokens) {
    const next: unknown[] = [];
    if ("key" in t) {
      for (const node of cur) if (isObj(node) && t.key in node) next.push(node[t.key]);
    } else if ("wildcard" in t) {
      for (const node of cur) if (Array.isArray(node)) next.push(...node);
    } else {
      for (const node of cur) if (Array.isArray(node) && t.index < node.length) next.push(node[t.index]);
    }
    cur = next;
  }
  return cur;
}

function defaultSelect(
  format: ParserFormat,
  expr: string,
  body: string,
): ParserSelectionResult {
  if (format === "raw") {
    try {
      const match = new RE2(expr, "u").exec(body);
      return {
        values: match ? [match[1] ?? match[0]] : [],
      };
    } catch {
      return { parseError: true };
    }
  }
  if (format === "json") {
    let root: unknown;
    try {
      root = JSON.parse(body);
    } catch {
      return { parseError: true };
    }
    const nodes = resolveJsonPath(root, expr);
    return nodes === null ? { parseError: true } : { values: nodes };
  }
  return { parseError: true };
}

/**
 * Lightweight, fail-closed built-in engine. It supports JSONPath `$`, `.key`,
 * `[n]`, and `[*]`, plus actual linear-time RE2 raw expressions. It deliberately
 * reports filters, CSS, XPath, and other constructs as parse errors. Use
 * `standardsParserEngine` for the full ParserSpec selector examples.
 */
export const defaultParserEngine: ParserEngine = {
  evalPredicate(format, expr, body) {
    const selected = defaultSelect(format, expr, body);
    return selected.parseError
      ? selected
      : { matched: selected.values.length > 0 };
  },
  extract(format, expr, body) {
    const selected = defaultSelect(format, expr, body);
    return selected.parseError ? null : (selected.values[0] ?? null);
  },
  select: defaultSelect,
};
