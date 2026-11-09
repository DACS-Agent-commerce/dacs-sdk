import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// Evaluates the build-test job's `runs-on` expression from .github/workflows/ci.yml against event contexts, so the
// routing rules are tested as written. The evaluator covers only the subset of GitHub's expression language that
// expression uses (&&, ||, !, ==, parentheses, property paths with `.*.`, string literals, contains, format,
// fromJSON), with GitHub's semantics: && and || return an operand, string comparison ignores case, a missing
// property is null, and contains() on a string is a case-insensitive substring test.

const repoRoot = resolve(import.meta.dirname, "../..");
type Job = { "runs-on"?: string };
const workflow = parse(readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, Job> };
const RUNS_ON = workflow.jobs["build-test"]?.["runs-on"] ?? "";
const POOL = ["self-hosted", "linux", "x64", "dacs-pool"];
const BLACKSMITH = "blacksmith-2vcpu-ubuntu-2404";

type Value = unknown;
type Token = { kind: "op" | "str" | "num" | "id"; text: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source.charAt(i);
    if (/\s/.test(c)) { i += 1; continue; }
    const two = source.slice(i, i + 2);
    if (["&&", "||", "==", "!="].includes(two)) { tokens.push({ kind: "op", text: two }); i += 2; continue; }
    if ("!(),".includes(c)) { tokens.push({ kind: "op", text: c }); i += 1; continue; }
    if (c === "'") {
      let text = "";
      i += 1;
      for (;;) {
        if (i >= source.length) throw new Error("unterminated string");
        if (source[i] === "'" && source[i + 1] === "'") { text += "'"; i += 2; continue; }
        if (source[i] === "'") { i += 1; break; }
        text += source[i]; i += 1;
      }
      tokens.push({ kind: "str", text });
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.(?:\*|[A-Za-z_][A-Za-z0-9_-]*))*/.exec(source.slice(i));
    if (id) { tokens.push({ kind: "id", text: id[0] }); i += id[0].length; continue; }
    const num = /^\d+/.exec(source.slice(i));
    if (num) { tokens.push({ kind: "num", text: num[0] }); i += num[0].length; continue; }
    throw new Error(`unexpected ${JSON.stringify(c)} at ${i}`);
  }
  return tokens;
}

const truthy = (v: Value) => !(v === null || v === undefined || v === false || v === 0 || v === "");
const eq = (a: Value, b: Value) =>
  typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b;

function lookup(path: string, context: Record<string, Value>): Value {
  let values: Value[] = [context];
  let spread = false;
  for (const part of path.split(".")) {
    if (part === "*") {
      values = values.flatMap((v) => (Array.isArray(v) ? v : []));
      spread = true;
      continue;
    }
    values = values.map((v) => (v !== null && typeof v === "object" ? (v as Record<string, Value>)[part] ?? null : null));
  }
  return spread ? values : values[0];
}

function evaluate(source: string, context: Record<string, Value>): Value {
  const tokens = tokenize(source);
  let at = 0;
  const peek = () => tokens[at];
  const take = (text?: string) => {
    const t = tokens[at];
    if (!t || (text !== undefined && t.text !== text)) throw new Error(`expected ${text ?? "token"} at ${at}`);
    at += 1;
    return t;
  };
  const functions: Record<string, (...args: Value[]) => Value> = {
    contains: (haystack, needle) => Array.isArray(haystack)
      ? haystack.some((item) => eq(item, needle))
      : String(haystack ?? "").toLowerCase().includes(String(needle ?? "").toLowerCase()),
    format: (template, ...args) => String(template).replace(/\{(\d+)\}/g, (_, n) => String(args[Number(n)] ?? "")),
    fromJSON: (text) => JSON.parse(String(text)),
  };
  function primary(): Value {
    const t = take();
    if (t.kind === "str") return t.text;
    if (t.kind === "num") return Number(t.text);
    if (t.text === "(") { const v = or(); take(")"); return v; }
    if (t.text === "!") return !truthy(primary());
    if (t.kind === "id") {
      if (peek()?.text === "(") {
        take("(");
        const args: Value[] = [];
        while (peek()?.text !== ")") { args.push(or()); if (peek()?.text === ",") take(","); }
        take(")");
        const fn = functions[t.text];
        if (!fn) throw new Error(`unknown function ${t.text}`);
        return fn(...args);
      }
      if (t.text === "true") return true;
      if (t.text === "false") return false;
      if (t.text === "null") return null;
      return lookup(t.text, context);
    }
    throw new Error(`unexpected ${t.text}`);
  }
  function comparison(): Value {
    let left = primary();
    while (peek()?.text === "==" || peek()?.text === "!=") {
      const op = take().text;
      const right = primary();
      left = op === "==" ? eq(left, right) : !eq(left, right);
    }
    return left;
  }
  function and(): Value {
    let left = comparison();
    while (peek()?.text === "&&") { take(); const right = comparison(); left = truthy(left) ? right : left; }
    return left;
  }
  function or(): Value {
    let left = and();
    while (peek()?.text === "||") { take(); const right = and(); left = truthy(left) ? left : right; }
    return left;
  }
  const value = or();
  if (at !== tokens.length) throw new Error(`trailing tokens at ${at}`);
  return value;
}

function route(over: {
  enabled?: string; authors?: string; blacksmith?: string; node?: string; event?: string; headRepo?: string;
  author?: string; actor?: string; triggering?: string; labels?: string[]; prPayload?: boolean;
}) {
  const match = /^\$\{\{([\s\S]*)\}\}$/.exec(RUNS_ON.trim());
  if (!match) throw new Error("runs-on is not a single expression");
  const event = over.event ?? "pull_request";
  return evaluate(match[1] ?? "", {
    vars: {
      SDK_SELF_HOSTED: over.enabled ?? "on",
      SDK_SELF_HOSTED_AUTHORS: over.authors ?? "owner,second",
      // Off by default, so the cases above test the project-runner rules alone.
      SDK_BLACKSMITH: over.blacksmith ?? "off",
    },
    matrix: { "node-version": over.node ?? "22" },
    github: {
      event_name: event,
      repository: "org/repo",
      actor: over.actor ?? "owner",
      triggering_actor: over.triggering ?? "owner",
      event: event === "pull_request" || over.prPayload
        ? { pull_request: {
          head: { repo: { full_name: over.headRepo ?? "org/repo" } },
          user: { login: over.author ?? "owner" },
          labels: (over.labels ?? []).map((name) => ({ name })),
        } }
        : {},
    },
  });
}

describe("build-test runs-on routing (.github/workflows/ci.yml)", () => {
  it("is a single expression the evaluator reads", () => {
    expect(RUNS_ON).toMatch(/^\$\{\{[\s\S]*\}\}$/);
  });

  it("sends a listed author's own same-repository pull request run to the project runners", () => {
    expect(route({})).toEqual(POOL);
    expect(route({ author: "second", actor: "second", triggering: "owner" })).toEqual(POOL);
  });

  it("keeps the node 20 leg on hosted runners", () => {
    expect(route({ node: "20.19.0" })).toBe("ubuntu-latest");
  });

  it("stays on hosted runners unless the switch is exactly on", () => {
    for (const enabled of ["off", "", "yes", "ON "]) expect(route({ enabled })).toBe("ubuntu-latest");
  });

  it("refuses pushes, merge-queue runs and fork pull requests", () => {
    expect(route({ event: "push" })).toBe("ubuntu-latest");
    expect(route({ event: "merge_group" })).toBe("ubuntu-latest");
    expect(route({ headRepo: "someone/fork" })).toBe("ubuntu-latest");
  });

  it("refuses an unlisted pull request author", () => {
    expect(route({ author: "outsider" })).toBe("ubuntu-latest");
  });

  it("refuses a run started by an unlisted account", () => {
    expect(route({ actor: "outsider", triggering: "outsider" })).toBe("ubuntu-latest");
  });

  it("refuses a listed account re-running an unlisted account's push (github.actor stays the pusher)", () => {
    expect(route({ actor: "outsider", triggering: "owner" })).toBe("ubuntu-latest");
  });

  it("refuses an unlisted account re-running a listed author's run", () => {
    expect(route({ actor: "owner", triggering: "outsider" })).toBe("ubuntu-latest");
  });

  it("matches whole logins, not parts of the list", () => {
    expect(route({ authors: "owner2,xowner", author: "owner", actor: "owner", triggering: "owner" })).toBe("ubuntu-latest");
    expect(route({ authors: "", author: "owner" })).toBe("ubuntu-latest");
  });

  it("keeps a pull request labelled ci-hosted on hosted runners", () => {
    expect(route({ labels: ["ci-hosted"] })).toBe("ubuntu-latest");
    expect(route({ labels: ["bug", "ci-hosted"] })).toBe("ubuntu-latest");
    expect(route({ labels: ["bug"] })).toEqual(POOL);
  });

  describe("Blacksmith", () => {
    it("sends both legs of every same-repository pull request to Blacksmith when the switch is on", () => {
      expect(route({ blacksmith: "on" })).toBe(BLACKSMITH);
      expect(route({ blacksmith: "on", node: "20.19.0" })).toBe(BLACKSMITH);
      expect(route({ blacksmith: "on", enabled: "off" })).toBe(BLACKSMITH);
    });

    it("takes precedence over ci-hosted and the project-runner author rules", () => {
      expect(route({ blacksmith: "on", labels: ["ci-hosted"] })).toBe(BLACKSMITH);
      expect(route({ blacksmith: "on", author: "outsider", actor: "outsider", triggering: "outsider" })).toBe(BLACKSMITH);
    });

    it("treats the switch as on in any letter case, as GitHub's == does", () => {
      for (const blacksmith of ["ON", "On", "oN"]) expect(route({ blacksmith })).toBe(BLACKSMITH);
    });

    it("leaves routing unchanged unless the switch is on", () => {
      for (const blacksmith of ["off", "", "yes", "ON "]) {
        expect(route({ blacksmith })).toEqual(POOL);
        expect(route({ blacksmith, node: "20.19.0" })).toBe("ubuntu-latest");
        expect(route({ blacksmith, enabled: "off" })).toBe("ubuntu-latest");
      }
    });

    it("never takes pushes, merge-queue runs or fork pull requests", () => {
      for (const node of ["22", "20.19.0"]) {
        expect(route({ blacksmith: "on", event: "push", node })).toBe("ubuntu-latest");
        expect(route({ blacksmith: "on", event: "merge_group", node })).toBe("ubuntu-latest");
        expect(route({ blacksmith: "on", headRepo: "someone/fork", node })).toBe("ubuntu-latest");
        // An event that carries a pull request payload but is not pull_request (not a trigger of this workflow today).
        expect(route({ blacksmith: "on", event: "pull_request_target", prPayload: true, node })).toBe("ubuntu-latest");
      }
    });
  });
});
