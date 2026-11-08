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
        (ts.isExportDeclaration(declaration) && declaration.isTypeOnly)
      ) {
        return true;
      }
    }
    symbol = checker.getImmediateAliasedSymbol(symbol);
  }
  return false;
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
