import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const script = join(repoRoot, "scripts/registry-container-disposition.mjs");
const dependencies = Object.fromEntries([
  "@kynesyslabs/dacs", "@kynesyslabs/dacs-node", "@kynesyslabs/demosdk",
  "@x402/core", "@x402/evm", "@x402/fetch", "better-sqlite3", "viem",
].map(name => [name, "1.0.0"]));
// Enter the real CLI branch, catching its exception before Node formats it.
const run = (project: string, releaseSet: string) => spawnSync(process.execPath, ["--input-type=module", "-e", `
  import { pathToFileURL } from "node:url";
  const [script, project, releaseSet] = process.argv.slice(1);
  process.argv = [process.execPath, script, "--dependency-policy", project,
    "http://127.0.0.1:4873", project + "/report.json", releaseSet, "1.0.0"];
  try { await import(pathToFileURL(script).href); process.exitCode = 2; }
  catch (error) {
    console.log(JSON.stringify({ message: error.message,
      cause: error.cause && { name: error.cause.name, message: error.cause.message },
      syntaxCause: error.cause instanceof SyntaxError }));
  }
`, script, project, releaseSet], { cwd: repoRoot, encoding: "utf8" });

describe("release input parse diagnostics", () => {
  it.each(["release-provenance.json", "package.json", "package-lock.json"])(
    "names a truncated %s and preserves its parse cause", file => {
      const root = mkdtempSync(join(tmpdir(), "dacs-input-errors-"));
      try {
        const project = join(root, "project");
        const releaseSet = join(root, "release-set");
        mkdirSync(project);
        mkdirSync(releaseSet);
        writeFileSync(join(project, "package.json"), JSON.stringify({ name: "consumer", version: "1.0.0", dependencies }));
        writeFileSync(join(project, "package-lock.json"), "{}");
        writeFileSync(join(releaseSet, "release-provenance.json"), JSON.stringify({ version: "1.0.0" }));
        const path = join(file === "release-provenance.json" ? releaseSet : project, file);
        writeFileSync(path, "{");
        const result = run(project, releaseSet);
        expect(result.status, result.stderr).toBe(0);
        const error = JSON.parse(result.stdout);
        expect(error.message).toContain(join(file === "release-provenance.json" ? releaseSet : realpathSync(project), file));
        expect(error.syntaxCause).toBe(true);
        expect(error.cause).toMatchObject({ name: "SyntaxError", message: expect.any(String) });
        expect(error.message).toContain(error.cause.message);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
});
