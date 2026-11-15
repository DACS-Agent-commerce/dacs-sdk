import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type Manifest = { name: string; exports: Record<string, { import?: unknown }> };
type ImportResult = { specifier: string; ok: boolean; code?: string; message?: string };
type Check = {
  lowestAllowedVersion(range: string): string;
  entryPointSpecifiers(manifest: Manifest): string[];
  importEntryPoints(options: { projectDir: string; specifiers: string[] }): ImportResult[];
};

const modulePath = "../../scripts/verify-packed-entry-imports.mjs";
const check = (await import(modulePath)) as Check;

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function writePackage(projectDir: string, name: string, files: Record<string, string>) {
  const root = join(projectDir, "node_modules", name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, type: "module", exports: "./index.js" }));
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), source);
  }
}

describe("packed entry point import check", () => {
  it("takes the lowest allowed demosdk from the peer range", () => {
    expect(check.lowestAllowedVersion("^4.0.17")).toBe("4.0.17");
    expect(check.lowestAllowedVersion("^4.0.16")).toBe("4.0.16");
  });

  it("imports every entry point named in the exports map", () => {
    const manifest = { name: "pkg", exports: { ".": { import: "./a.js" }, "./sub": { import: "./b.js" } } };
    expect(check.entryPointSpecifiers(manifest)).toEqual(["pkg", "pkg/sub"]);
  });

  it("refuses an exports entry with no import target", () => {
    const manifest = { name: "pkg", exports: { ".": { import: "./a.js" }, "./sub": {} } };
    expect(() => check.entryPointSpecifiers(manifest)).toThrow("export ./sub has no import target");
  });

  it("reports an entry point whose import fails, with its error code", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "packed-entry-"));
    directories.push(projectDir);
    writePackage(projectDir, "loads-fine", { "index.js": "export const loaded = true;\n" });
    // The failure demosdk 4.0.16 has: an ES module importing a directory.
    writePackage(projectDir, "imports-a-directory", {
      "index.js": 'import { inner } from "./operations";\nexport { inner };\n',
      "operations/index.js": "export const inner = 1;\n",
    });

    const results = check.importEntryPoints({ projectDir, specifiers: ["loads-fine", "imports-a-directory"] });

    expect(results[0]).toEqual({ specifier: "loads-fine", ok: true });
    expect(results[1]).toMatchObject({ specifier: "imports-a-directory", ok: false, code: "ERR_UNSUPPORTED_DIR_IMPORT" });
  });
});
