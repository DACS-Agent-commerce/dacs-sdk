#!/usr/bin/env node
// Keeps source files short. A new source file may not pass MAX_LINES; files
// that were already longer are listed in file-size-baseline.json with their
// length at the time. See tools/lint/README.md.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Longest source file allowed without a baseline entry. */
export const MAX_LINES = 800;
const SOURCE_FILE = /\.(ts|mjs|js)$/;
const BASELINE_FILE = "tools/lint/file-size-baseline.json";

function packageSourceRoots(repoRoot) {
  const packages = join(repoRoot, "packages");
  if (!existsSync(packages)) return [];
  return readdirSync(packages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}/src`);
}

/** Lists source files under src/ and packages/<name>/src/, without type declarations. */
export function listSourceFiles(repoRoot) {
  const roots = ["src", ...packageSourceRoots(repoRoot)];
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(path);
      } else if (SOURCE_FILE.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        out.push(path);
      }
    }
  };
  for (const root of roots) if (existsSync(join(repoRoot, root))) walk(root);
  return out.sort();
}

/** Counts lines the way `wc -l` does, plus a last line with no newline. */
export function countLines(text) {
  if (text.length === 0) return 0;
  const newlines = text.split("\n").length - 1;
  return text.endsWith("\n") ? newlines : newlines + 1;
}

export function measure(repoRoot) {
  return Object.fromEntries(
    listSourceFiles(repoRoot).map((path) => [path, countLines(readFileSync(join(repoRoot, path), "utf8"))]),
  );
}

/**
 * Compares current lengths with the baseline.
 * `tooLong`: a file over the limit that the baseline does not list (fails).
 * `grown`: a listed file now longer than its recorded length (warning).
 * `stale`: a listed file that is gone or back within the limit (fails until pruned).
 */
export function compare(sizes, baseline, limit = MAX_LINES) {
  const tooLong = [];
  const grown = [];
  for (const [path, lines] of Object.entries(sizes)) {
    if (lines <= limit) continue;
    const recorded = baseline[path];
    if (recorded === undefined) tooLong.push({ path, lines });
    else if (lines > recorded) grown.push({ path, lines, recorded });
  }
  const stale = Object.keys(baseline).filter((path) => !(path in sizes) || sizes[path] <= limit);
  return { tooLong, grown, stale };
}

function readBaseline(repoRoot) {
  return JSON.parse(readFileSync(join(repoRoot, BASELINE_FILE), "utf8"));
}

function writeBaseline(repoRoot, baseline) {
  const sorted = Object.fromEntries(Object.entries(baseline).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(join(repoRoot, BASELINE_FILE), `${JSON.stringify(sorted, null, 2)}\n`);
}

function main(argv) {
  const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const sizes = measure(repoRoot);
  if (argv.includes("--write-baseline")) {
    const over = Object.fromEntries(Object.entries(sizes).filter(([, lines]) => lines > MAX_LINES));
    writeBaseline(repoRoot, over);
    console.log(`file-size: wrote ${Object.keys(over).length} files to ${BASELINE_FILE}`);
    return 0;
  }
  const baseline = readBaseline(repoRoot);
  const result = compare(sizes, baseline);
  const { tooLong, grown } = result;
  let { stale } = result;
  if (argv.includes("--prune") && stale.length > 0) {
    writeBaseline(repoRoot, Object.fromEntries(Object.entries(baseline).filter(([path]) => !stale.includes(path))));
    console.log(`file-size: removed ${stale.length} entries from ${BASELINE_FILE}`);
    stale = [];
  }
  for (const { path, lines } of tooLong) {
    console.error(`${path}: ${lines} lines, over the ${MAX_LINES}-line limit; split it into smaller modules`);
  }
  for (const { path, lines, recorded } of grown) {
    // GitHub Actions shows this as a warning on the file without failing the run.
    console.log(`::warning file=${path}::${path} grew from ${recorded} to ${lines} lines; it is already over the ${MAX_LINES}-line limit`);
  }
  for (const path of stale) {
    console.error(`${BASELINE_FILE}: "${path}" is gone or within ${MAX_LINES} lines; run with --prune to remove it`);
  }
  const failed = tooLong.length + stale.length;
  if (failed === 0) {
    console.log(`file-size: ok (${Object.keys(baseline).length} files listed over ${MAX_LINES} lines)`);
  }
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
