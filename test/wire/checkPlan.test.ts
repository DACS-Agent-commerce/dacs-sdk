import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each([true, false])("validates every named source target and vector without applying mutations or touching scratch (check first: %s)", (first) => {
  const scratch = mkdtempSync(join(tmpdir(), "wire-check-plan-"));
  const sentinel = join(scratch, "keep.txt");
  writeFileSync(sentinel, "retained scratch contents");
  try {
    const script = fileURLToPath(new URL("../../scripts/wire/mutate-wire-checks.mjs", import.meta.url));
    const run = spawnSync(process.execPath, [script, ...(first ? ["--check", "--scratch", scratch] : ["--scratch", scratch, "--check"])], { encoding: "utf8", timeout: 10_000 });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe("85 named checks have current source targets and vectors; no mutations applied\n");
    expect(readFileSync(sentinel, "utf8")).toBe("retained scratch contents");
    expect(existsSync(join(scratch, "src"))).toBe(false);
    expect(existsSync(join(scratch, "vitest.json"))).toBe(false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
