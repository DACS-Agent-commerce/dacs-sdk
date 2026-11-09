import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { expect, test } from "vitest";

// The package root's exports are a reviewed list. A name added to the root must
// be added to test/fixtures/root-exports.txt in the same change, so growth is a
// deliberate decision; a name removed from the root is removed there too.

const root = fileURLToPath(new URL("..", import.meta.url));

function rootExports(): string[] {
  const config = ts.getParsedCommandLineOfConfigFile(
    `${root}tsconfig.json`,
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
  );
  if (!config) throw new Error("tsconfig.json could not be read");
  return exportsOf(`${root}src/index.ts`, config.options);
}

function exportsOf(entry: string, options: ts.CompilerOptions): string[] {
  const program = ts.createProgram([entry], { ...options, noEmit: true });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  const module = source && checker.getSymbolAtLocation(source);
  if (!module) throw new Error(`${entry} has no module symbol`);
  refuseTypeOnlyStarExports(program);
  return checker.getExportsOfModule(module).map((symbol) => {
    const target = symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
    const value = (target.flags & ts.SymbolFlags.Value) !== 0 &&
      !typeOnlyOnTheWay(checker, symbol);
    return `${value ? "value" : "type"} ${symbol.getName()}`;
  }).sort();
}

/** True when any re-export or import on the alias chain is `type`-only. */
function typeOnlyOnTheWay(checker: ts.TypeChecker, start: ts.Symbol): boolean {
  let symbol: ts.Symbol | undefined = start;
  while (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    for (const declaration of symbol.declarations ?? []) {
      if (
        (ts.isExportSpecifier(declaration) &&
          (declaration.isTypeOnly || declaration.parent.parent.isTypeOnly)) ||
        (ts.isImportSpecifier(declaration) &&
          (declaration.isTypeOnly || declaration.parent.parent.isTypeOnly)) ||
        (ts.isImportClause(declaration) && declaration.isTypeOnly) ||
        (ts.isNamespaceImport(declaration) && declaration.parent.isTypeOnly) ||
        (ts.isNamespaceExport(declaration) && declaration.parent.isTypeOnly) ||
        (ts.isImportEqualsDeclaration(declaration) && declaration.isTypeOnly) ||
        (ts.isExportDeclaration(declaration) && declaration.isTypeOnly)
      ) {
        return true;
      }
    }
    symbol = checker.getImmediateAliasedSymbol(symbol);
  }
  return false;
}

/**
 * `export type * from` hands its names on without an alias the checker can
 * see, so a value behind it would be listed as a value. Refuse it until the
 * classifier handles it, rather than record a wrong kind.
 */
function refuseTypeOnlyStarExports(program: ts.Program): void {
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || program.isSourceFileFromExternalLibrary(file)) continue;
    for (const statement of file.statements) {
      if (ts.isExportDeclaration(statement) && statement.isTypeOnly && !statement.exportClause) {
        throw new Error(
          `${file.fileName}: \`export type * from\` is not supported by the root export list; ` +
            "re-export the names one by one",
        );
      }
    }
  }
}

test("the package root exports exactly the reviewed list", () => {
  const listed = readFileSync(`${root}test/fixtures/root-exports.txt`, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
  const actual = rootExports();
  const listedSet = new Set(listed);
  const actualSet = new Set(actual);
  expect({
    addedToRoot: actual.filter((name) => !listedSet.has(name)),
    removedFromRoot: listed.filter((name) => !actualSet.has(name)),
  }).toEqual({ addedToRoot: [], removedFromRoot: [] });
  expect(listed).toEqual([...listed].sort());
}, 120_000);

test("a type-only re-export of a class is listed as a type", () => {
  const dir = mkdtempSync(join(tmpdir(), "root-exports-"));
  try {
    writeFileSync(join(dir, "a.ts"), "export class A {}\nexport class B {}\n");
    writeFileSync(join(dir, "b.ts"), "export { type A, B } from \"./a.js\";\n");
    writeFileSync(join(dir, "index.ts"), "export { A, B } from \"./b.js\";\n");
    expect(exportsOf(join(dir, "index.ts"), {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
    })).toEqual(["type A", "value B"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const fixtureOptions: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022,
};

function exportsOfFiles(files: Record<string, string>): string[] {
  const dir = mkdtempSync(join(tmpdir(), "root-exports-"));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return exportsOf(join(dir, "index.ts"), fixtureOptions);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("type-only namespace re-exports and imports are listed as types", () => {
  expect(exportsOfFiles({
    "a.ts": "export const x = 1;\n",
    "index.ts": "export type * as ns from \"./a.js\";\n",
  })).toEqual(["type ns"]);
  expect(exportsOfFiles({
    "a.ts": "export const x = 1;\n",
    "index.ts": "import type * as ns from \"./a.js\";\nexport { ns };\n",
  })).toEqual(["type ns"]);
  expect(exportsOfFiles({
    "a.ts": "export const x = 1;\n",
    "index.ts": "export * as ns from \"./a.js\";\n",
  })).toEqual(["value ns"]);
});

test("a type-only star re-export is refused rather than listed as values", () => {
  expect(() => exportsOfFiles({
    "a.ts": "export const x = 1;\n",
    "index.ts": "export type * from \"./a.js\";\n",
  })).toThrow(/export type \* from/);
  expect(exportsOfFiles({
    "a.ts": "export const x = 1;\n",
    "index.ts": "export * from \"./a.js\";\n",
  })).toEqual(["value x"]);
});
