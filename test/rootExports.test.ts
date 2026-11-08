import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { expect, test } from "vitest";

// The package root's exports are a reviewed list. A name added to the root must
// be added to test/fixtures/root-exports.txt in the same change, so growth is a
// deliberate decision; a name removed from the root is removed there too.

const root = fileURLToPath(new URL("..", import.meta.url));

function rootExports(): string[] {
  const entry = `${root}src/index.ts`;
  const config = ts.getParsedCommandLineOfConfigFile(
    `${root}tsconfig.json`,
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
  );
  if (!config) throw new Error("tsconfig.json could not be read");
  const program = ts.createProgram([entry], { ...config.options, noEmit: true });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  const module = source && checker.getSymbolAtLocation(source);
  if (!module) throw new Error("src/index.ts has no module symbol");
  return checker.getExportsOfModule(module).map((symbol) => {
    const target = symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
    const kind = target.flags & ts.SymbolFlags.Value ? "value" : "type";
    return `${kind} ${symbol.getName()}`;
  }).sort();
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
