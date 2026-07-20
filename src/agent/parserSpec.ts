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
      return {
        decision: "error",
        reason: `indeterminateOn predicate kind does not match format "${format}" (malformed recipe)`,
      };
    }
    const r = evalPredicate(expr);
    if (r.parseError) return { decision: "error", reason: "response body did not parse (PSP-2)" };
    if (r.matched) {
      return { decision: "indeterminate", reason: "an indeterminateOn predicate matched (PSP-2)" };
    }
  }

  // PSP-1: the success match predicate.
  const m = evalPredicate(successExpr(spec));
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
    const extract = engine.extract;
    data = {};
    for (const [field, expr] of Object.entries(dataMap)) {
      try {
        data[field] = extract(format, expr, body) ?? null;
      } catch {
        data[field] = null; // audit-only: a throwing extractor never affects the decision
      }
    }
  }

  return data ? { decision, data } : { decision };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

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

/**
 * Reject a regex that uses features outside RE2's guarantees — backreferences
 * (`\1`, `\k<name>`) and lookaround (`(?=)`, `(?!)`, `(?<=)`, `(?<!)`). The spec
 * mandates RE2 semantics (linear-time, no catastrophic backtracking) for an
 * untrusted signed matcher, so a non-RE2 pattern is a malformed matcher rather
 * than something to run through JS `RegExp` (whose backtracking differs).
 */
function isRe2Compatible(src: string): boolean {
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      const n = src[i + 1];
      if (n !== undefined && n >= "1" && n <= "9") return false; // numeric backreference
      if (n === "k") return false; // named backreference \k<name>
      i++; // skip the escaped char
      continue;
    }
    if (c === "(" && src[i + 1] === "?") {
      const n2 = src[i + 2];
      if (n2 === "=" || n2 === "!") return false; // lookahead
      if (n2 === "<" && (src[i + 3] === "=" || src[i + 3] === "!")) return false; // lookbehind
    }
  }
  return true;
}

/**
 * The built-in {@link ParserEngine} for `json` (the supported JSONPath subset)
 * and `raw` (RE2-compatible regex only — a pattern using backreferences/lookaround
 * is rejected as a parse error, NOT run through JS `RegExp`). An unsupported
 * JSONPath construct is likewise a parse error, never a silent no-match.
 * `html`/`xml` need a real parser and are reported as a verifier-side failure
 * (`error`) until an engine that supports them is injected.
 */
export const defaultParserEngine: ParserEngine = {
  evalPredicate(format, expr, body) {
    if (format === "raw") {
      if (!isRe2Compatible(expr)) return { parseError: true }; // non-RE2 matcher
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
      const nodes = resolveJsonPath(root, expr);
      if (nodes === null) return { parseError: true }; // unsupported JSONPath — reject, don't guess
      return { matched: nodes.length > 0 };
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
      const nodes = resolveJsonPath(root, expr);
      if (nodes === null) return null; // unsupported expression extracts nothing
      const v = nodes[0];
      return v == null ? null : typeof v === "string" ? v : JSON.stringify(v);
    }
    if (format === "raw") {
      if (!isRe2Compatible(expr)) return null;
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
