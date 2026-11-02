import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it.each(["absolute", "relative"])("runs the bootstrap CLI through an %s directory alias", kind => {
  const root = mkdtempSync(join(tmpdir(), "dacs-bootstrap-entry-"));
  try {
    symlinkSync(resolve("scripts"), join(root, "alias"));
    const env: NodeJS.ProcessEnv = { ...process.env, RUNNER_TEMP: root }; delete env.GITHUB_PATH;
    const script = kind === "absolute" ? join(root, "alias/acceptance-bootstrap.mjs") : "alias/acceptance-bootstrap.mjs";
    const result = spawnSync(process.execPath, [script], { cwd: root, env, encoding: "utf8", timeout: 5000 });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("GITHUB_PATH is required");
    expect(readdirSync(root).filter(name => name.startsWith("dacs-acceptance-npm-"))).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("imports the bootstrap through an alias without executing its CLI", () => {
  const root = mkdtempSync(join(tmpdir(), "dacs-bootstrap-import-"));
  try {
    symlinkSync(resolve("scripts"), join(root, "alias"));
    const result = spawnSync(process.execPath, ["--input-type=module", "-e",
      "const file = process.argv[1]; process.argv[1] = process.execPath; await import(file)", join(root, "alias/acceptance-bootstrap.mjs")],
    { env: { ...process.env, RUNNER_TEMP: root }, encoding: "utf8", timeout: 5000 });
    expect(result.status, result.stderr).toBe(0); expect(readdirSync(root)).toEqual(["alias"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
