import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const modulePath = "../../tools/lint/layers.mjs";
const { collectImports, compareWithBaseline, findProblems, loadRules, readBaseline, unitOf } = await import(modulePath);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const RULES = {
  units: [
    { name: "core", layer: "kernel", folders: ["src/core/"] },
    { name: "port", layer: "ports", files: ["src/proto/Port.ts"] },
    { name: "proto", layer: "protocol", folders: ["src/proto/"] },
    { name: "stores", layer: "adapters", suffix: "Fs.ts" },
    { name: "proto-deep", layer: "adapters", folders: ["src/proto/deep/"] },
    { name: "api", layer: "api", files: ["src/index.ts"] },
  ],
};

function repo(files: Record<string, string>, baseline = ""): string {
  const root = mkdtempSync(join(tmpdir(), "dacs-layers-"));
  roots.push(root);
  const all: Record<string, string> = {
    "tools/lint/layers.json": JSON.stringify(RULES),
    "tools/lint/layers-baseline.txt": baseline,
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function problemsIn(files: Record<string, string>) {
  const root = repo(files);
  return findProblems(loadRules(root), collectImports(root));
}

describe("layer check", () => {
  it("allows imports down the order and inside a unit", () => {
    const problems = problemsIn({
      "src/core/a.ts": `export const a = 1;`,
      "src/core/b.ts": `import { a } from "./a.js"; export const b = a;`,
      "src/proto/flow.ts": `import { b } from "../core/b.js"; export const flow = b;`,
      "src/index.ts": `export { flow } from "./proto/flow.js";`,
    });
    expect(problems).toEqual({ unassigned: [], unresolved: [], violations: [] });
  });

  it("reports an import up the order once per file pair, naming both units", () => {
    const problems = problemsIn({
      "src/core/a.ts": `import { flow } from "../proto/flow.js";\nimport { other } from "../proto/flow.js";\nexport const a = flow + other;`,
      "src/proto/flow.ts": `export const flow = 1; export const other = 2;`,
    });
    expect(problems.violations).toHaveLength(1);
    expect(problems.violations[0]).toMatchObject({
      key: "src/core/a.ts -> src/proto/flow.ts",
      fromUnit: "core",
      toUnit: "proto",
      line: 1,
    });
  });

  it("counts type-only imports, re-exports, dynamic imports and import types", () => {
    const problems = problemsIn({
      "src/core/typeOnly.ts": `import type { Flow } from "../proto/flow.js"; export type T = Flow;`,
      "src/core/reexport.ts": `export { flow } from "../proto/flow.js";`,
      "src/core/dynamic.ts": `export const load = () => import("../proto/flow.js");`,
      "src/core/importType.ts": `export type T = import("../proto/flow.js").Flow;`,
      "src/proto/flow.ts": `export type Flow = number; export const flow = 1;`,
    });
    const found = problems.violations.map((violation: { from: string; typeOnly: boolean }) => [violation.from, violation.typeOnly]);
    expect(found).toEqual([
      ["src/core/dynamic.ts", false],
      ["src/core/importType.ts", true],
      ["src/core/reexport.ts", false],
      ["src/core/typeOnly.ts", true],
    ]);
  });

  it("counts template-string paths, require forms, declaration files and .mts files", () => {
    const problems = problemsIn({
      "src/core/template.ts": "export const load = () => import(`../proto/flow.js`);",
      "src/core/equals.ts": `import flow = require("../proto/flow.js"); export const a = flow;`,
      "src/core/required.ts": `const flow = require("../proto/flow.js"); export const a = flow;`,
      "src/core/types.d.ts": `export type T = import("../proto/flow.js").Flow;`,
      "src/core/module.mts": `import { flow } from "../proto/flow.js"; export const a = flow;`,
      "src/proto/flow.ts": `export type Flow = number; export const flow = 1;`,
    });
    expect(problems.violations.map((violation: { from: string }) => violation.from)).toEqual([
      "src/core/equals.ts",
      "src/core/module.mts",
      "src/core/required.ts",
      "src/core/template.ts",
      "src/core/types.d.ts",
    ]);
  });

  it("reports an import() or require() with a computed path as unresolved", () => {
    const problems = problemsIn({
      "src/core/a.ts": "const name = \"flow\";\nexport const load = () => import(`../proto/${name}.js`);\nexport const b = require(name);",
      "src/proto/flow.ts": `export const flow = 1;`,
    });
    expect(problems.unresolved).toMatchObject([
      { from: "src/core/a.ts", line: 2, to: "`../proto/${name}.js` (computed path)" },
      { from: "src/core/a.ts", line: 3, to: "name (computed path)" },
    ]);
  });

  it("resolves .js, .mjs and .cjs paths to their TypeScript and declaration files", () => {
    const root = repo({
      "src/proto/a.ts": "",
      "src/proto/b.d.ts": "",
      "src/proto/c.mts": "",
      "src/proto/d.d.mts": "",
      "src/proto/e.cts": "",
      "src/proto/f.d.cts": "",
      "src/index.ts": ["a.js", "b.js", "c.mjs", "d.mjs", "e.cjs", "f.cjs"]
        .map((name) => `import type {} from "./proto/${name}";`).join("\n"),
    });
    const { imports } = collectImports(root);
    expect(imports.map((entry: { to: string }) => entry.to)).toEqual([
      "src/proto/a.ts",
      "src/proto/b.d.ts",
      "src/proto/c.mts",
      "src/proto/d.d.mts",
      "src/proto/e.cts",
      "src/proto/f.d.cts",
    ]);
  });

  it("resolves folder imports to index.ts and data imports to the data file", () => {
    const root = repo({
      "src/proto/index.ts": `export const proto = 1;`,
      "src/proto/data.json": `{}`,
      "src/proto/flow.ts": `import "./data.json";`,
      "src/index.ts": `export * from "./proto";`,
    });
    const { imports } = collectImports(root);
    expect(imports.map((entry: { from: string; to: string }) => [entry.from, entry.to])).toEqual([
      ["src/index.ts", "src/proto/index.ts"],
      ["src/proto/flow.ts", "src/proto/data.json"],
    ]);
  });

  it("matches exact files before suffixes, suffixes before folders, and the longest folder", () => {
    const rules = loadRules(repo({}));
    expect(unitOf(rules, "src/proto/Port.ts").name).toBe("port");
    expect(unitOf(rules, "src/proto/deep/journalFs.ts").name).toBe("stores");
    expect(unitOf(rules, "src/proto/deep/step.ts").name).toBe("proto-deep");
    expect(unitOf(rules, "src/proto/step.ts").name).toBe("proto");
    expect(unitOf(rules, "src/elsewhere/step.ts")).toBeUndefined();
  });

  it("reports files no unit covers and imports that resolve to nothing", () => {
    const problems = problemsIn({
      "src/stray/file.ts": `export const stray = 1;`,
      "src/core/a.ts": `import { gone } from "./missing.js"; export const a = gone;`,
    });
    expect(problems.unassigned).toEqual(["src/stray/file.ts"]);
    expect(problems.unresolved).toMatchObject([{ from: "src/core/a.ts", to: "./missing.js (unresolved)" }]);
  });

  it("splits violations into new ones and baseline lines that no longer occur", () => {
    const violations = [{ key: "src/a.ts -> src/b.ts" }, { key: "src/c.ts -> src/d.ts" }];
    const result = compareWithBaseline(violations, ["src/a.ts -> src/b.ts", "src/e.ts -> src/f.ts"]);
    expect(result.added).toEqual([{ key: "src/c.ts -> src/d.ts" }]);
    expect(result.stale).toEqual(["src/e.ts -> src/f.ts"]);
  });

  it("reads the baseline without comments or blank lines", () => {
    const root = repo({}, "# header\n\nsrc/a.ts -> src/b.ts\n  \n");
    expect(readBaseline(root)).toEqual(["src/a.ts -> src/b.ts"]);
  });
});
