#!/usr/bin/env node
// Checks that imports between parts of src/ only point down the order set in
// layers.json. How to run it and what to do when it fails: ARCHITECTURE.md.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SOURCE_DIR = "src";
const RULES_FILE = "tools/lint/layers.json";
const BASELINE_FILE = "tools/lint/layers-baseline.txt";

/** Reads the ordered unit list. A unit may import only units listed before it. */
export function loadRules(repoRoot) {
  const rules = JSON.parse(readFileSync(join(repoRoot, RULES_FILE), "utf8"));
  rules.units.forEach((unit, rank) => {
    unit.rank = rank;
  });
  return rules;
}

/** Returns the unit a repo-relative source path belongs to, or undefined. */
export function unitOf(rules, path) {
  const exact = rules.units.find((unit) => unit.files?.includes(path));
  if (exact) return exact;
  const bySuffix = rules.units.find((unit) => unit.suffix && path.endsWith(unit.suffix));
  if (bySuffix) return bySuffix;
  let best;
  for (const unit of rules.units) {
    for (const folder of unit.folders ?? []) {
      if (path.startsWith(folder) && (!best || folder.length > best.length)) {
        best = { unit, length: folder.length };
      }
    }
  }
  return best?.unit;
}

function listFiles(repoRoot) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk(SOURCE_DIR);
  return out.sort();
}

// TypeScript in any form, declaration files included: a .d.ts can import too.
const isSourceFile = (path) => /\.[cm]?tsx?$/.test(path);

// "./x.js" names x.ts (or x.d.ts), ".mjs" and ".cjs" name ".mts" and ".cts", "./dir" names
// dir/index.ts, and data files ("./x.json") name themselves.
function resolveSpecifier(fromPath, specifier, known) {
  const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".d.ts"),
    base.replace(/\.mjs$/, ".mts"),
    base.replace(/\.cjs$/, ".cts"),
    `${base}.ts`,
    `${base}.d.ts`,
    `${base}/index.ts`,
    base,
  ];
  return candidates.find((candidate) => known.has(candidate));
}

/**
 * Lists every relative import in src/: `import`, `export … from`, `import x = require()`, `require()`,
 * `import()` and `import("…")` types, with plain or template-string paths. An `import()` or `require()`
 * whose path is computed cannot be checked, so it is listed as unresolved.
 */
export function collectImports(repoRoot) {
  const all = listFiles(repoRoot);
  const known = new Set(all);
  const files = all.filter(isSourceFile);
  const imports = [];
  for (const from of files) {
    const text = readFileSync(join(repoRoot, from), "utf8");
    const source = ts.createSourceFile(from, text, ts.ScriptTarget.Latest, true);
    const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const record = (node, typeOnly) => {
      const specifier = node.text;
      if (!specifier.startsWith(".")) return;
      const to = resolveSpecifier(from, specifier, known);
      imports.push({ from, to: to ?? `${specifier} (unresolved)`, line: lineOf(node), typeOnly, resolved: Boolean(to) });
    };
    const isPath = (node) => Boolean(node) && ts.isStringLiteralLike(node);
    const isLoadCall = (node) => ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"));
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && isPath(node.moduleSpecifier)) {
        const typeOnly = ts.isImportDeclaration(node)
          ? Boolean(node.importClause?.isTypeOnly)
          : node.isTypeOnly;
        record(node.moduleSpecifier, typeOnly);
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
        && isPath(node.moduleReference.expression)) {
        record(node.moduleReference.expression, node.isTypeOnly);
      } else if (isLoadCall(node)) {
        const [argument] = node.arguments;
        if (isPath(argument)) record(argument, false);
        else if (argument) {
          imports.push({ from, to: `${argument.getText(source)} (computed path)`, line: lineOf(node), typeOnly: false, resolved: false });
        }
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
        && isPath(node.argument.literal)) {
        record(node.argument.literal, true);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { files, imports };
}

/** Finds files with no unit, unresolved imports, and imports that point up the order. */
export function findProblems(rules, { files, imports }) {
  const unassigned = files.filter((file) => !unitOf(rules, file));
  const unresolved = imports.filter((entry) => !entry.resolved);
  const violations = new Map();
  for (const entry of imports) {
    if (!entry.resolved) continue;
    const fromUnit = unitOf(rules, entry.from);
    const toUnit = unitOf(rules, entry.to);
    if (!fromUnit || !toUnit || fromUnit === toUnit || toUnit.rank < fromUnit.rank) continue;
    const key = `${entry.from} -> ${entry.to}`;
    if (!violations.has(key)) {
      violations.set(key, { key, ...entry, fromUnit: fromUnit.name, toUnit: toUnit.name });
    }
  }
  return { unassigned, unresolved, violations: [...violations.values()] };
}

/** Reads the known-violation lines, skipping comments and blank lines. */
export function readBaseline(repoRoot) {
  return readFileSync(join(repoRoot, BASELINE_FILE), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function writeBaseline(repoRoot, keys) {
  const header = [
    "# Imports in src/ that broke the layer order when the check was added.",
    "# Remove a line when its import is gone (--prune). Never add one to get a pass.",
  ];
  writeFileSync(join(repoRoot, BASELINE_FILE), `${[...header, ...[...keys].sort()].join("\n")}\n`);
}

/** Splits violations into ones the baseline does not list, and baseline lines that no longer occur. */
export function compareWithBaseline(violations, baseline) {
  const listed = new Set(baseline);
  const current = new Set(violations.map((violation) => violation.key));
  return {
    added: violations.filter((violation) => !listed.has(violation.key)),
    stale: baseline.filter((key) => !current.has(key)),
  };
}

function main(argv) {
  const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const rules = loadRules(repoRoot);
  const problems = findProblems(rules, collectImports(repoRoot));
  if (argv.includes("--write-baseline")) {
    writeBaseline(repoRoot, problems.violations.map((violation) => violation.key));
    console.log(`layers: wrote ${problems.violations.length} known violations to ${BASELINE_FILE}`);
    return 0;
  }
  const baseline = readBaseline(repoRoot);
  const { added, stale: found } = compareWithBaseline(problems.violations, baseline);
  let stale = found;
  if (argv.includes("--prune") && stale.length > 0) {
    writeBaseline(repoRoot, baseline.filter((key) => !stale.includes(key)));
    console.log(`layers: removed ${stale.length} fixed entries from ${BASELINE_FILE}`);
    stale = [];
  }
  for (const file of problems.unassigned) {
    console.error(`${file}: no unit in ${RULES_FILE} covers this file`);
  }
  for (const entry of problems.unresolved) {
    console.error(`${entry.from}:${entry.line}: cannot resolve import ${entry.to}`);
  }
  for (const violation of added) {
    console.error(`${violation.from}:${violation.line}: ${violation.fromUnit} must not import ${violation.toUnit} (${violation.to})`);
  }
  for (const key of stale) {
    console.error(`${BASELINE_FILE}: "${key}" no longer occurs; run with --prune to remove it`);
  }
  const failed = problems.unassigned.length + problems.unresolved.length + added.length + stale.length;
  if (failed === 0) {
    console.log(`layers: ok (${problems.violations.length} known violations left)`);
  }
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
