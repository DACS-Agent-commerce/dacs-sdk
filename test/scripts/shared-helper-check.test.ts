import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const modulePath = "../../tools/lint/shared-helpers.mjs";
const { compareWithBaseline, findCopies, topLevelFunctionNames } = await import(modulePath);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "dacs-helpers-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe("shared helper check", () => {
  it("finds top-level function declarations and const functions, not nested ones or other values", () => {
    const names = topLevelFunctionNames("a.ts", [
      "function isRecord(v: unknown) { return true; }",
      "export const exactKeys = (v: object) => Object.keys(v);",
      "const nonEmpty = function (v: string) { return v.length > 0; };",
      "const plainRecord = { kind: 'not a function' };",
      "function outer() { function deepFreeze() {} }",
      "const hasExactKeys = ((v: object) => true) as (v: object) => boolean;",
      "const plainObject = (function (v: unknown) { return v; }) satisfies (v: unknown) => unknown;",
    ].join("\n"));
    expect(names).toEqual(["isRecord", "exactKeys", "nonEmpty", "outer", "hasExactKeys", "plainObject"]);
  });

  it("reports shared-helper names declared outside src/internal/ or twice inside it, and ignores other names", () => {
    const root = repo({
      "src/internal/isRecord.ts": "export function isRecord(v: unknown) { return true; }",
      "src/internal/other.ts": "export const isRecord = (v: unknown) => true;",
      "src/rails/a.ts": "function isRecord(v: unknown) { return true; }\nfunction parseAmount() {}",
      "src/seller/b.ts": "const hasExactKeys = () => true;",
    });
    expect(findCopies(root)).toEqual(["src/internal/other.ts isRecord", "src/rails/a.ts isRecord", "src/seller/b.ts hasExactKeys"]);
  });

  it("splits copies into new ones and baseline lines that no longer occur", () => {
    const result = compareWithBaseline(
      ["src/a.ts isRecord", "src/b.ts exactKeys"],
      ["src/a.ts isRecord", "src/c.ts nonEmpty"],
    );
    expect(result).toEqual({ added: ["src/b.ts exactKeys"], stale: ["src/c.ts nonEmpty"] });
  });
});
