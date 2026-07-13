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

/**
 * The pluggable predicate evaluator (PSP-1/PSP-4). MUST be deterministic and MUST
 * NOT execute scripts, fetch sub-resources, or follow redirects (PSP-4). It only
 * reports whether an expression matches — it never decides pass/fail.
 */
export interface ParserEngine {
  /** Does `expr` select ≥1 node/element/match in `body`? `parseError` if the body is malformed for `format`. */
  evalPredicate(format: ParserFormat, expr: string, body: string): PredicateResult;
  /** PSP-3 dataMap extraction (audit-only). Optional; returns null when nothing resolves. */
  extract?(format: ParserFormat, expr: string, body: string): string | null;
}

export interface ParserEvalContext {
  /** PSP-2: a match means "listed" — invert the outcome (recipe.negativeMatch). */
  negativeMatch?: boolean;
  /**
   * PSP-5 completeness floor: for a negative-match "absence in a full list" recipe,
   * a `pass` (= "not listed") is only trustworthy over a provably-complete response.
   * Pass the completeness verdict (record-count / sentinel / Content-Length checked
   * by the caller). When the recipe is completeness-gated and this is not `true`,
   * the `pass` is downgraded to `indeterminate`. Omit for non-list recipes.
   */
  requiresCompleteness?: boolean;
  listComplete?: boolean;
}

export type ParserDecision = "pass" | "fail" | "error" | "indeterminate";

export interface ParserEvaluation {
  decision: ParserDecision;
  /** PSP-3 extracted data (audit-only; never changes the decision). */
  data?: Record<string, string | null>;
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

  // PSP-2: indeterminateOn predicates are evaluated BEFORE the match predicate;
  // if any matches, the decision is `indeterminate` and the match is not applied.
  // A parse failure here is a verifier-side failure → `error` (never `fail`).
  for (const p of spec.indeterminateOn ?? []) {
    const expr = predicateExpr(format, p);
    if (expr == null) continue; // wrong predicate kind for the format — not applicable
    const r = engine.evalPredicate(format, expr, body);
    if (r.parseError) return { decision: "error", reason: "response body did not parse (PSP-2)" };
    if (r.matched) {
      return { decision: "indeterminate", reason: "an indeterminateOn predicate matched (PSP-2)" };
    }
  }

  // PSP-1: the success match predicate.
  const m = engine.evalPredicate(format, successExpr(spec), body);
  if (m.parseError) return { decision: "error", reason: "response body did not parse (PSP-2)" };

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
  if (neg && decision === "pass" && ctx.requiresCompleteness && ctx.listComplete !== true) {
    return {
      decision: "indeterminate",
      reason: "negative-match pass requires a confirmed-complete response (PSP-5)",
    };
  }

  // PSP-3: dataMap extraction is audit-only and MUST NOT change the decision.
  let data: Record<string, string | null> | undefined;
  const dataMap = "dataMap" in spec ? spec.dataMap : undefined;
  if (dataMap && engine.extract) {
    data = {};
    for (const [field, expr] of Object.entries(dataMap)) {
      data[field] = engine.extract(format, expr, body) ?? null;
    }
  }

  return data ? { decision, data } : { decision };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Resolve a minimal JSONPath (`$`, `.key`, `[n]`, `[*]`) to the set of selected
 * nodes. Deterministic (PSP-4); intentionally small — a fuller JSONPath engine
 * can be injected via {@link ParserEngine}.
 */
function resolveJsonPath(root: unknown, path: string): unknown[] {
  if (!path.startsWith("$")) return [];
  const tokens = path.slice(1).match(/\.[^.[]+|\[\d+\]|\[\*\]/g) ?? [];
  let cur: unknown[] = [root];
  for (const t of tokens) {
    const next: unknown[] = [];
    if (t.startsWith(".")) {
      const key = t.slice(1);
      for (const node of cur) if (isObj(node) && key in node) next.push(node[key]);
    } else if (t === "[*]") {
      for (const node of cur) if (Array.isArray(node)) next.push(...node);
    } else {
      const idx = Number(t.slice(1, -1));
      for (const node of cur) if (Array.isArray(node) && idx < node.length) next.push(node[idx]);
    }
    cur = next;
  }
  return cur;
}

/**
 * The built-in {@link ParserEngine} for `json` (minimal JSONPath) and `raw` (JS
 * regex; note: not strict RE2 — inject a RE2 engine for untrusted patterns).
 * `html`/`xml` need a real parser and are reported as a verifier-side failure
 * (`error`) until an engine that supports them is injected.
 */
export const defaultParserEngine: ParserEngine = {
  evalPredicate(format, expr, body) {
    if (format === "raw") {
      let re: RegExp;
      try {
        re = new RegExp(expr);
      } catch {
        // A malformed matcher is a verifier-side inability to obtain a decision.
        return { parseError: true };
      }
      return { matched: re.test(body) };
    }
    if (format === "json") {
      let root: unknown;
      try {
        root = JSON.parse(body);
      } catch {
        return { parseError: true };
      }
      return { matched: resolveJsonPath(root, expr).length > 0 };
    }
    // html / xml unsupported by the default engine → verifier-side failure.
    return { parseError: true };
  },
  extract(format, expr, body) {
    if (format === "json") {
      let root: unknown;
      try {
        root = JSON.parse(body);
      } catch {
        return null;
      }
      const v = resolveJsonPath(root, expr)[0];
      return v == null ? null : typeof v === "string" ? v : JSON.stringify(v);
    }
    if (format === "raw") {
      try {
        const mm = new RegExp(expr).exec(body);
        return mm ? (mm[1] ?? mm[0]) : null;
      } catch {
        return null;
      }
    }
    return null;
  },
};
