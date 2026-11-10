import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const modulePath = "../../tools/lint/file-size.mjs";
const { compare, countLines, listSourceFiles, MAX_LINES } = await import(modulePath);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "dacs-file-size-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe("file size check", () => {
  it("counts lines like wc -l, plus a last line without a newline", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a\n")).toBe(1);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("a\nb\n")).toBe(2);
  });

  it("lists source files in src/ and each package's src/, without declarations, tests or node_modules", () => {
    const root = repo({
      "src/a.ts": "",
      "src/types.d.ts": "",
      "src/notes.md": "",
      "packages/kit/src/b.mjs": "",
      "packages/kit/src/node_modules/dep/c.js": "",
      "packages/kit/test/d.test.mjs": "",
      "test/e.test.ts": "",
    });
    expect(listSourceFiles(root)).toEqual(["src/a.ts", "packages/kit/src/b.mjs"].sort());
  });

  it("fails a file over the limit that the baseline does not list", () => {
    const result = compare({ "src/big.ts": MAX_LINES + 1, "src/ok.ts": MAX_LINES }, {});
    expect(result).toEqual({ tooLong: [{ path: "src/big.ts", lines: MAX_LINES + 1 }], grown: [], stale: [] });
  });

  it("reports a listed file that grew, and accepts one that kept or lost lines", () => {
    const baseline = { "src/grew.ts": 900, "src/same.ts": 900, "src/shrank.ts": 900 };
    const result = compare({ "src/grew.ts": 950, "src/same.ts": 900, "src/shrank.ts": 850 }, baseline);
    expect(result).toEqual({ tooLong: [], grown: [{ path: "src/grew.ts", lines: 950, recorded: 900 }], stale: [] });
  });

  it("marks listed files that are gone or back within the limit as stale", () => {
    const baseline = { "src/gone.ts": 900, "src/fixed.ts": 900 };
    const result = compare({ "src/fixed.ts": MAX_LINES }, baseline);
    expect(result.stale).toEqual(["src/gone.ts", "src/fixed.ts"]);
  });
});
