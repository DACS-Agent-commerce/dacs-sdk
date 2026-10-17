import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

test("the scoped npm rebuild overrides script suppression and opens native SQLite", async () => {
  const root = await mkdtemp(join(tmpdir(), "dacs-npm-rebuild-"));
  const adapter = join(root, "node_modules", "better-sqlite3");
  const other = join(root, "node_modules", "unrelated-dependency");
  try {
    await mkdir(adapter, { recursive: true });
    await mkdir(other, { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true,
      dependencies: { "better-sqlite3": "1.0.0", "unrelated-dependency": "1.0.0" } }));
    await writeFile(join(adapter, "package.json"), JSON.stringify({ name: "better-sqlite3",
      version: "1.0.0", scripts: { install: "node install.cjs" } }));
    await writeFile(join(other, "package.json"), JSON.stringify({ name: "unrelated-dependency",
      version: "1.0.0", scripts: { install: "node install.cjs" } }));
    await writeFile(join(other, "install.cjs"), 'require("node:fs").writeFileSync("ran", "unexpected");');
    // The lifecycle fixture exercises the real, already installed native binding.
    const sqlite = createRequire(import.meta.url).resolve("better-sqlite3");
    await writeFile(join(adapter, "install.cjs"), `
const Database = require(${JSON.stringify(sqlite)});
const database = new Database(":memory:");
try {
  require("node:fs").writeFileSync("opened.json", JSON.stringify(database.prepare("SELECT 42 AS answer").get()));
} finally { database.close(); }
`);
    const rebuild = (flags: string[]) => spawnSync(process.platform === "win32" ? "npm.cmd" : "npm",
      ["rebuild", "better-sqlite3", ...flags, "--offline", "--no-audit", "--no-fund"], {
        cwd: root, encoding: "utf8", timeout: 20_000,
        env: { ...process.env, npm_config_ignore_scripts: "true" },
      });
    const suppressed = rebuild([]);
    expect(suppressed.error).toBeUndefined();
    expect(suppressed.status, suppressed.stderr).toBe(0);
    await expect(readFile(join(adapter, "opened.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const enabled = rebuild(["--ignore-scripts=false"]);
    expect(enabled.error).toBeUndefined();
    expect(enabled.status, enabled.stderr).toBe(0);
    expect(JSON.parse(await readFile(join(adapter, "opened.json"), "utf8"))).toEqual({ answer: 42 });
    await expect(readFile(join(other, "ran"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);
