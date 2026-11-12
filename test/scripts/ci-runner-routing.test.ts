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
type Step = { name?: string; if?: string; run?: string; env?: Record<string, string> };
type Job = {
  "runs-on"?: string;
  name?: string;
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  strategy?: { matrix?: string | { "node-version"?: (string | number)[] } };
  steps?: Step[];
};
const workflow = parse(readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8")) as {
  jobs: Record<string, Job>;
  concurrency?: { group?: string; "cancel-in-progress"?: unknown };
};
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
  author?: string; actor?: string; triggering?: string; labels?: string[]; prPayload?: boolean; draft?: boolean;
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
          draft: over.draft ?? false,
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

  it("keeps the node 24 leg on hosted runners", () => {
    expect(route({ node: "24" })).toBe("ubuntu-latest");
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
      expect(route({ blacksmith: "on", node: "24" })).toBe(BLACKSMITH);
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
        expect(route({ blacksmith, node: "24" })).toBe("ubuntu-latest");
        expect(route({ blacksmith, enabled: "off" })).toBe("ubuntu-latest");
      }
    });

    it("never takes draft pull requests", () => {
      for (const node of ["22", "24"]) {
        expect(route({ blacksmith: "on", draft: true, node, enabled: "off" })).toBe("ubuntu-latest");
        expect(route({ blacksmith: "on", draft: false, node })).toBe(BLACKSMITH);
      }
      // A draft falls through to the rules above, which still route it like any other pull request.
      expect(route({ blacksmith: "on", draft: true })).toEqual(POOL);
    });

    it("never takes pushes, merge-queue runs or fork pull requests", () => {
      for (const node of ["22", "24"]) {
        expect(route({ blacksmith: "on", event: "push", node })).toBe("ubuntu-latest");
        expect(route({ blacksmith: "on", event: "merge_group", node })).toBe("ubuntu-latest");
        expect(route({ blacksmith: "on", headRepo: "someone/fork", node })).toBe("ubuntu-latest");
        // An event that carries a pull request payload but is not pull_request (not a trigger of this workflow today).
        expect(route({ blacksmith: "on", event: "pull_request_target", prPayload: true, node })).toBe("ubuntu-latest");
      }
    });
  });
});

// The seller and client suites run in build-test, one job per shard as `scripts/ci-shards.mjs plan` lists them for the
// event; every other build-test step runs in build-test-main, once per Node leg. build-test-result carries the
// required check names and passes a leg only when that leg's main job and each of its planned shards succeeded.
const shardsPath = "../../scripts/ci-shards.mjs";
const shards = await import(shardsPath);
type Entry = { "node-version": string; part: string; suite: string; shard: string };
const MAIN = workflow.jobs["build-test-main"] ?? {};
const SHARD = workflow.jobs["build-test"] ?? {};
const RESULT = workflow.jobs["build-test-result"] ?? {};
const mainMatrix = MAIN.strategy?.matrix;
const MAIN_LEGS = (typeof mainMatrix === "object" ? mainMatrix["node-version"] ?? [] : []).map(String);
const holds = (condition: string | undefined, context: Record<string, Value>) =>
  condition === undefined || truthy(evaluate(condition.replace(/^\$\{\{([\s\S]*)\}\}$/, "$1"), context));
const EVENTS = ["pull_request", "push", "merge_group"];

/** The Node legs on which the named build-test step runs for an event (from either job). */
function legsRunning(name: string, event: string): string[] {
  const main = (MAIN.steps ?? []).find((s) => s.name === name);
  const shard = (SHARD.steps ?? []).find((s) => s.name === name);
  if (!main === !shard) throw new Error(`step ${name} is in ${main ? "both jobs" : "neither job"}`);
  if (main) return MAIN_LEGS.filter((node) => holds(main.if, { matrix: { "node-version": node }, github: { event_name: event } }));
  const entries = (shards.plan(event) as Entry[]).filter((entry) => holds(shard?.if, { matrix: entry, github: { event_name: event } }));
  return [...new Set(entries.map((entry) => entry["node-version"]))].sort();
}

describe("build-test long suites (.github/workflows/ci.yml)", () => {
  const suites = [
    "Test seller internal primitives and journals",
    "Test (unit + conformance harness)",
    "Test durable RFQ filesystem record-size boundaries",
  ];

  // Pull requests run these on node 24 too, so a node 24 failure shows before the merge.
  it("runs the long suites on both legs for every event, pull requests included", () => {
    for (const name of suites) {
      for (const event of EVENTS) expect(legsRunning(name, event), `${name} ${event}`).toEqual(["22", "24"]);
    }
  });

  // The legs come from the matrix itself, so pinning a leg (say "22" to "22.22.2") can't leave a suite running on no
  // pull request leg while the literal cases above still pass.
  it("runs each long suite on every matrix leg", () => {
    expect(MAIN_LEGS.length).toBeGreaterThan(1);
    expect(shards.NODE_LEGS).toEqual(MAIN_LEGS);
    for (const name of suites) {
      for (const event of EVENTS) expect(legsRunning(name, event)).toEqual([...MAIN_LEGS].sort());
    }
  });

  // The demosdk 4.0.18 checks moved to the daily demosdk-compat workflow (test/scripts/demosdk-pin-drift.test.ts).
  it("installs no other demosdk version in any build-test job", () => {
    for (const job of [MAIN, SHARD]) {
      expect((job.steps ?? []).some((s) => (s.run ?? "").includes("@kynesyslabs/demosdk@"))).toBe(false);
    }
  });

  // The typechecks read the locked TypeScript and @types/node, not the running Node, so one leg is enough.
  it("typechecks on the node 22 leg only, for every event", () => {
    for (const name of ["Typecheck", "Typecheck Node host kit", "Typecheck project generator"]) {
      for (const event of EVENTS) expect(legsRunning(name, event), `${name} ${event}`).toEqual(["22"]);
    }
  });
});

describe("build-test shards (.github/workflows/ci.yml, scripts/ci-shards.mjs)", () => {
  // Before the split every leg prepared the locked seller consumer. The seller shards now prepare it, and since seller
  // shards run on every leg of every event, build-test-main no longer needs its own copy of the step.
  it("prepares the locked seller consumer on every leg of every event, in the seller shards only", () => {
    const name = "Prepare locked seller consumer";
    const shard = (SHARD.steps ?? []).find((s) => s.name === name);
    expect((MAIN.steps ?? []).find((s) => s.name === name)).toBeUndefined();
    expect(shard).toBeDefined();
    for (const event of EVENTS) {
      const sellerLegs = (shards.plan(event) as Entry[]).filter((entry) => holds(shard?.if, { matrix: entry, github: { event_name: event } }))
        .map((entry) => entry["node-version"]);
      expect([...new Set(sellerLegs)].sort(), event).toEqual([...MAIN_LEGS].sort());
    }
  });

  it("routes build-test-main exactly like build-test", () => {
    expect(MAIN["runs-on"]).toBe(RUNS_ON);
  });

  it("takes the shard job's matrix from build-test-plan, which runs the shard plan for the event", () => {
    expect(SHARD.needs).toBe("build-test-plan");
    expect(SHARD.strategy?.matrix).toBe("${{ fromJSON(needs.build-test-plan.outputs.matrix) }}");
    const planStep = (workflow.jobs["build-test-plan"]?.steps ?? []).find((s) => s.run?.includes("ci-shards.mjs plan"));
    // The plan is assigned first, so a failing plan command fails the step (bash -e) rather than writing an empty matrix.
    expect(planStep?.run).toBe('matrix=$(node scripts/ci-shards.mjs plan --event "$EVENT_NAME")\necho "matrix=$matrix" >> "$GITHUB_OUTPUT"\n');
    expect(planStep?.env?.EVENT_NAME).toBe("${{ github.event_name }}");
  });

  it("gives each suite step its shard from the matrix and runs it only in that suite's shards", () => {
    const seller = (SHARD.steps ?? []).find((s) => s.run === "npm run seller:test");
    const client = (SHARD.steps ?? []).find((s) => s.run === "node scripts/run-client-tests.mjs");
    expect(seller?.env?.DACS_SELLER_TEST_SHARD).toBe("${{ matrix.shard }}");
    expect(client?.env?.DACS_CLIENT_TEST_SHARD).toBe("${{ matrix.shard }}");
    for (const event of EVENTS) {
      for (const entry of shards.plan(event) as Entry[]) {
        expect(holds(seller?.if, { matrix: entry })).toBe(entry.suite === "seller");
        expect(holds(client?.if, { matrix: entry })).toBe(entry.suite === "client");
      }
    }
    // Neither suite runs in build-test-main.
    expect((MAIN.steps ?? []).filter((s) => /seller:test|run-client-tests|dacs-client$/.test(s.run ?? ""))).toEqual([]);
  });

  it("plans every shard of each suite wherever the suite runs, and only there", () => {
    expect(shards.checkPlan()).toEqual([]);
    expect(shards.plan("pull_request").map((e: Entry) => `${e["node-version"]} ${e.part}`)).toEqual([
      "22 seller-1", "22 seller-2", "22 client-1", "22 client-2", "22 client-3", "22 client-4", "24 seller-1", "24 seller-2",
    ]);
    for (const event of EVENTS) expect(shards.plan(event)).toHaveLength(8);
  });

  it("keeps the required check names on build-test-result only, one job per leg that needs every build-test job", () => {
    expect(RESULT.name).toBe("build-test (node ${{ matrix.node-version }})");
    // The required checks are "build-test (node 22)" and "build-test (node 24)", one per supported Node line.
    expect(MAIN_LEGS).toEqual(["22", "24"]);
    const resultMatrix = RESULT.strategy?.matrix;
    expect(typeof resultMatrix === "object" ? resultMatrix["node-version"] : undefined).toEqual(MAIN_LEGS);
    expect(RESULT.needs).toEqual(["build-test-plan", "build-test-main", "build-test"]);
    // always(): a failed or cancelled job it needs must fail the required check, not skip it (a skipped check passes).
    expect(RESULT.if).toBe("${{ always() }}");
    expect(RESULT.permissions).toEqual({ contents: "read", actions: "read" });
    const named = Object.entries(workflow.jobs).filter(([, job]) => /^build-test \(node /.test(job.name ?? "")).map(([key]) => key);
    expect(named).toEqual(["build-test-result"]);
    expect(MAIN.name).toBe("build-test main (node ${{ matrix.node-version }})");
    expect(SHARD.name).toBe("build-test shard (node ${{ matrix.node-version }}, ${{ matrix.part }})");
    expect(shards.mainJobName("22")).toBe("build-test main (node 22)");
    expect(shards.shardJobName("22", "seller-1")).toBe("build-test shard (node 22, seller-1)");
  });

  // A required check that never reports blocks every merge, and a skipped one counts as passing. So the result job must
  // run whatever happened to the jobs it needs, and decide from their outcomes itself.
  it("reports a result for every outcome of the jobs it needs, failing on a failed plan or any unsuccessful job", () => {
    const step = (RESULT.steps ?? []).find((s) => s.run?.includes("ci-shards.mjs verify"));
    expect(step?.env?.PLAN_RESULT).toBe("${{ needs.build-test-plan.result }}");
    const lines = (step?.run ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
    // The plan check comes first: a failed or cancelled plan leaves the shard job skipped with no shard jobs to read.
    expect(lines[0]).toBe('test "$PLAN_RESULT" = success || { echo "build-test plan: $PLAN_RESULT"; exit 1; }');
    expect(lines.at(-1)).toBe('node scripts/ci-shards.mjs verify --node "$NODE_VERSION" --event "$EVENT_NAME" --jobs "$RUNNER_TEMP/jobs.jsonl"');
    expect(step?.env?.NODE_VERSION).toBe("${{ matrix.node-version }}");
    // No step of the result job is conditional, and the job itself is not gated on the needed jobs' results.
    expect((RESULT.steps ?? []).filter((s) => s.if !== undefined)).toEqual([]);
    expect(RESULT.if).toBe("${{ always() }}");
    for (const event of EVENTS) {
      for (const node of MAIN_LEGS) {
        // Every shard cancelled: the leg fails once per shard. No jobs at all (as when the run is cancelled before
        // they start): the leg fails, it does not pass on an empty list.
        const planned = (shards.plan(event) as Entry[]).filter((e) => e["node-version"] === node);
        const jobs = [{ name: shards.mainJobName(node), status: "completed", conclusion: "success" },
          ...planned.map((e) => ({ name: shards.shardJobName(node, e.part), status: "completed", conclusion: "cancelled" }))];
        expect(shards.verify(node, event, jobs).failures).toHaveLength(planned.length);
        expect(shards.verify(node, event, []).failures.length).toBeGreaterThan(0);
      }
    }
  });

  describe("verify", () => {
    const passing = (event: string) => [
      ...MAIN_LEGS.map((node) => ({ name: shards.mainJobName(node), status: "completed", conclusion: "success" })),
      ...(shards.plan(event) as Entry[]).map((e) => ({ name: shards.shardJobName(e["node-version"], e.part), status: "completed", conclusion: "success" })),
      { name: "build-test (node 22)", status: "in_progress", conclusion: null },
    ];

    it("passes a leg whose main job and planned shards all succeeded", () => {
      for (const event of EVENTS) for (const node of MAIN_LEGS) expect(shards.verify(node, event, passing(event)).failures).toEqual([]);
    });

    it("fails a leg with a failed, cancelled, skipped or still-running shard", () => {
      for (const [status, conclusion] of [["completed", "failure"], ["completed", "cancelled"], ["completed", "skipped"], ["in_progress", null]]) {
        const jobs = passing("push").map((job) => job.name === shards.shardJobName("22", "client-2") ? { ...job, status, conclusion } : job);
        expect(shards.verify("22", "push", jobs).failures).toEqual([`build-test shard (node 22, client-2): ${status}/${conclusion}`]);
        expect(shards.verify("24", "push", jobs).failures).toEqual([]);
      }
    });

    it("fails a leg whose main job or a planned shard is missing or listed twice", () => {
      const missing = passing("push").filter((job) => job.name !== shards.shardJobName("24", "seller-2"));
      expect(shards.verify("24", "push", missing).failures).toEqual(["build-test shard (node 24, seller-2): 0 jobs in this run, expected 1"]);
      const noMain = passing("pull_request").filter((job) => job.name !== shards.mainJobName("24"));
      expect(shards.verify("24", "pull_request", noMain).failures).toHaveLength(1);
      const twice = [...passing("push"), { name: shards.mainJobName("22"), status: "completed", conclusion: "success" }];
      expect(shards.verify("22", "push", twice).failures).toEqual(["build-test main (node 22): 2 jobs in this run, expected 1"]);
    });
  });

  describe("file assignment", () => {
    it("puts every file in exactly one shard, including files with no recorded weight", () => {
      const files = ["a.test.mjs", "b.test.mjs", "new-1.test.mjs", "new-2.test.mjs", "new-3.test.mjs", ...Object.keys(shards.WEIGHTS.client)];
      for (const suite of ["seller", "client"]) {
        // checkPartition also requires each of the suite's SPLIT_FILES to be present (here unsplit: a whole file).
        const all = [...files, ...shards.SPLIT_FILES[suite].filter((file: string) => !files.includes(file))];
        const parts: string[][] = shards.assign(suite, all);
        expect(parts).toHaveLength(shards.SHARDS[suite]);
        expect(parts.flat().sort()).toEqual([...all].sort());
        expect(shards.checkPartition(suite, all).failures).toEqual([]);
        parts.forEach((list, index) => expect(shards.shardFiles(suite, all, index + 1)).toEqual(list));
      }
    });

    it("does not depend on the order the files are listed in", () => {
      const files = Object.keys(shards.WEIGHTS.client);
      expect(shards.assign("client", [...files].reverse())).toEqual(shards.assign("client", files));
    });

    it("refuses a shard count that differs from the suite's", () => {
      expect(shards.parseShard("2/2", "seller")).toEqual({ index: 2, count: 2 });
      for (const text of ["1/3", "3/2", "0/2", "2", "", undefined, " 1/2x"]) expect(() => shards.parseShard(text, "seller")).toThrow();
    });
  });
});

describe("run concurrency (.github/workflows/ci.yml)", () => {
  const group = (event: string, ref: string, runId = 7) => {
    const match = /^\$\{\{([\s\S]*)\}\}$/.exec(String(workflow.concurrency?.group ?? "").trim());
    if (!match) throw new Error("concurrency group is not a single expression");
    return evaluate(match[1] ?? "", { github: { event_name: event, ref, run_id: runId } });
  };

  it("never cancels a running run, so a phase0-completion push run always finishes", () => {
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  it("puts phase0-completion push runs in one shared group and every other run in its own", () => {
    expect(group("push", "refs/heads/phase0-completion", 1)).toBe(group("push", "refs/heads/phase0-completion", 2));
    expect(group("push", "refs/heads/main", 3)).toBe("ci-3");
    expect(group("pull_request", "refs/pull/9/merge", 4)).toBe("ci-4");
    expect(group("merge_group", "refs/heads/gh-readonly-queue/main/x", 5)).toBe("ci-5");
  });
});
