#!/usr/bin/env node
// Stops new private copies of small helpers that src/ should define once, in
// src/internal/. Existing copies are listed in shared-helpers-baseline.txt.
// See tools/lint/README.md.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** Helper names that belong in src/internal/ and nowhere else in src/. */
export const SHARED_HELPERS = ["deepFreeze", "exactKeys", "hasExactKeys", "isRecord", "nonEmpty", "plainObject", "plainRecord"];
const SHARED_HOME = "src/internal/";
const BASELINE_FILE = "tools/lint/shared-helpers-baseline.txt";

function listSourceFiles(repoRoot) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(path);
    }
  };
  if (existsSync(join(repoRoot, "src"))) walk("src");
  return out.sort();
}

// Looks through parentheses, `as`, `satisfies`, `<T>` and `!` to the value they wrap.
function unwrap(node) {
  let value = node;
  while (value && (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isSatisfiesExpression(value)
    || ts.isTypeAssertionExpression(value) || ts.isNonNullExpression(value))) {
    value = value.expression;
  }
  return value;
}

const isFunctionValue = (node) => {
  const value = unwrap(node);
  return Boolean(value) && (ts.isArrowFunction(value) || ts.isFunctionExpression(value));
};

/** Names of functions declared at the top level of a file, as `function f` or `const f = () => …`. */
export function topLevelFunctionNames(path, text) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false);
  const names = [];
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      names.push(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && isFunctionValue(declaration.initializer)) {
          names.push(declaration.name.text);
        }
      }
    }
  }
  return [...new Set(names)];
}

/**
 * Lists `path name` for each shared-helper name declared outside src/internal/, and for each
 * second or later declaration of the same name inside src/internal/ (the first, by path, is the shared one).
 */
export function findCopies(repoRoot) {
  const copies = [];
  const shared = new Set();
  for (const path of listSourceFiles(repoRoot)) {
    const text = readFileSync(join(repoRoot, path), "utf8");
    for (const name of topLevelFunctionNames(path, text)) {
      if (!SHARED_HELPERS.includes(name)) continue;
      if (path.startsWith(SHARED_HOME) && !shared.has(name)) shared.add(name);
      else copies.push(`${path} ${name}`);
    }
  }
  return copies.sort();
}

/** Reads the known-copy lines, skipping comments and blank lines. */
export function readBaseline(repoRoot) {
  return readFileSync(join(repoRoot, BASELINE_FILE), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function writeBaseline(repoRoot, lines) {
  const header = [
    "# Private copies of shared helpers that src/ already had when the check was added.",
    "# Remove a line when its copy is gone (--prune). Never add one to get a pass.",
  ];
  writeFileSync(join(repoRoot, BASELINE_FILE), `${[...header, ...[...lines].sort()].join("\n")}\n`);
}

/** Splits copies into ones the baseline does not list, and baseline lines that no longer occur. */
export function compareWithBaseline(copies, baseline) {
  const listed = new Set(baseline);
  const current = new Set(copies);
  return { added: copies.filter((copy) => !listed.has(copy)), stale: baseline.filter((line) => !current.has(line)) };
}

function main(argv) {
  const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const copies = findCopies(repoRoot);
  if (argv.includes("--write-baseline")) {
    writeBaseline(repoRoot, copies);
    console.log(`shared-helpers: wrote ${copies.length} known copies to ${BASELINE_FILE}`);
    return 0;
  }
  let baseline = readBaseline(repoRoot);
  const result = compareWithBaseline(copies, baseline);
  const { added } = result;
  let { stale } = result;
  if (argv.includes("--prune") && stale.length > 0) {
    baseline = baseline.filter((line) => !stale.includes(line));
    writeBaseline(repoRoot, baseline);
    console.log(`shared-helpers: removed ${stale.length} entries from ${BASELINE_FILE}`);
    stale = [];
  }
  for (const copy of added) {
    const [path, name] = copy.split(" ");
    console.error(`${path}: declares its own ${name}; import the shared one from ${SHARED_HOME}, or create it there from one copy and import it`);
  }
  for (const line of stale) {
    console.error(`${BASELINE_FILE}: "${line}" no longer occurs; run with --prune to remove it`);
  }
  const failed = added.length + stale.length;
  if (failed === 0) console.log(`shared-helpers: ok (${baseline.length} known copies left)`);
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
