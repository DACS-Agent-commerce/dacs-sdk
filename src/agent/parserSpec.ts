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

/** Result of evaluating ONE predicate expression against a body. */
export type PredicateResult = { parseError: true } | { parseError?: false; matched: boolean };

/** Declared, inspectable behavior of a parser engine implementation. */
export interface ParserEngineCapabilities {
  readonly engine: string;
  readonly formats: readonly ParserFormat[];
  readonly jsonPath: "rfc9535" | "bounded-subset" | "unsupported";
  readonly htmlSelector: "css-select" | "unsupported";
  readonly xmlXPath: "xpath-1.0" | "unsupported";
  readonly rawMatcher: "re2" | "screened-js-regexp" | "unsupported";
  readonly executesScripts: false;
  readonly fetchesSubresources: false;
  readonly followsRedirects: false;
}

/**
 * The pluggable predicate evaluator (PSP-1/PSP-4). MUST be deterministic and MUST
 * NOT execute scripts, fetch sub-resources, or follow redirects (PSP-4). It only
 * reports whether an expression matches — it never decides pass/fail.
 */
export interface ParserEngine {
  /** Optional capability declaration for diagnostics and recipe preflight. */
  readonly capabilities?: ParserEngineCapabilities;
  /** Does `expr` select ≥1 node/element/match in `body`? `parseError` if the body is malformed for `format`. */
  evalPredicate(format: ParserFormat, expr: string, body: string): PredicateResult;
  /**
   * PSP-3 dataMap extraction (audit-only). Preserve the selected value's JSON
   * shape; return null when nothing resolves.
   */
  extract?(format: ParserFormat, expr: string, body: string): unknown;
}

export interface ParserEvalContext {
  /** PSP-2: a match means "listed" — invert the outcome (recipe.negativeMatch). */
  negativeMatch?: boolean;
  /**
   * PSP-5 completeness floor: for a negative-match "absence in a full list" recipe,
   * a `pass` (= "not listed") is only trustworthy over a provably-complete response.
   * Pass the completeness verdict (record-count / sentinel / Content-Length checked
   * by the caller). Every negative-match absence is completeness-gated by
   * construction; callers cannot opt out of PSP-5.
   *
   * @deprecated PSP-5 is derived from `negativeMatch`; this flag is ignored.
   */
  requiresCompleteness?: boolean;
  listComplete?: boolean;
}

export type ParserDecision = "pass" | "fail" | "error" | "indeterminate";

export interface ParserEvaluation {
  decision: ParserDecision;
  /** PSP-3 extracted data (audit-only; never changes the decision). */
  data?: Record<string, unknown>;
  reason?: string;
}

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

  // PSP-5: a negative-match `pass` that rests on ABSENCE from a full list is only
  // trustworthy over a provably-complete response — else `indeterminate`.
  if (neg && decision === "pass" && ctx.listComplete !== true) {
    return result(
      "indeterminate",
      "negative-match pass requires a confirmed-complete response (PSP-5)",
    );
  }

  return result(decision);
}

export {
  defaultParserEngine,
  defaultParserEngineCapabilities,
} from "./conformantParserEngine.js";
