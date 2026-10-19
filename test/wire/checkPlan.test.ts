import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    expect(run.stdout).toBe("103 named checks have current source targets and vectors; no mutations applied\n");
    expect(readFileSync(sentinel, "utf8")).toBe("retained scratch contents");
    expect(existsSync(join(scratch, "src"))).toBe(false);
    expect(existsSync(join(scratch, "vitest.json"))).toBe(false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// A minimal source tree stops at the copy step on an unfixed helper: no test
// runner or source exists here, so this regression never executes a mutation.
it("refuses a nonempty scratch directory before deleting or starting work", () => {
  const fixture = mkdtempSync(join(tmpdir(), "wire-scratch-guard-"));
  const script = join(fixture, "scripts/wire/mutate-wire-checks.mjs");
  const scratch = join(fixture, "retained");
  mkdirSync(join(fixture, "scripts/wire"), { recursive: true });
  mkdirSync(scratch);
  copyFileSync(fileURLToPath(new URL("../../scripts/wire/mutate-wire-checks.mjs", import.meta.url)), script);
  copyFileSync(fileURLToPath(new URL("../../scripts/wire/scratch-directory.mjs", import.meta.url)), join(fixture, "scripts/wire/scratch-directory.mjs"));
  const sentinel = join(scratch, "keep.txt");
  writeFileSync(sentinel, "retained caller data");
  try {
    const run = spawnSync(process.execPath, [script, "--scratch", scratch], { encoding: "utf8", timeout: 10_000 });
    expect(run.status).not.toBe(0);
    expect(existsSync(sentinel), run.stderr).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe("retained caller data");
    expect(run.stderr).toContain("scratch");
    expect(existsSync(join(scratch, "src"))).toBe(false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

it("allocates and cleans only a fresh child of an empty or new scratch parent", async () => {
  const { createOwnedScratch } = await import(new URL("../../scripts/wire/scratch-directory.mjs", import.meta.url).href);
  const fixture = mkdtempSync(join(tmpdir(), "wire-scratch-owner-"));
  const checkout = join(fixture, "checkout");
  mkdirSync(checkout);
  try {
    for (const exists of [true, false]) {
      const parent = join(fixture, exists ? "empty" : "new");
      if (exists) mkdirSync(parent);
      const owned = createOwnedScratch(parent, checkout);
      expect(owned.path.startsWith(join(parent, "wire-run-"))).toBe(true);
      writeFileSync(join(owned.path, "work.txt"), "owned run data");
      const sentinel = join(parent, "arrived-later.txt");
      writeFileSync(sentinel, "caller data");
      owned.cleanup();
      expect(existsSync(owned.path)).toBe(false);
      expect(readFileSync(sentinel, "utf8")).toBe("caller data");
      owned.cleanup();
    }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

it("refuses checkout paths, ancestors, nonempty directories, files and aliases", async () => {
  const { createOwnedScratch } = await import(new URL("../../scripts/wire/scratch-directory.mjs", import.meta.url).href);
  const { symlinkSync } = await import("node:fs");
  const fixture = mkdtempSync(join(tmpdir(), "wire-scratch-paths-"));
  const checkout = join(fixture, "checkout");
  mkdirSync(checkout);
  const retained = join(fixture, "retained");
  mkdirSync(retained);
  writeFileSync(join(retained, "sentinel"), "kept");
  const file = join(fixture, "file");
  writeFileSync(file, "kept");
  symlinkSync(checkout, join(fixture, "checkout-alias"), "dir");
  symlinkSync(retained, join(fixture, "scratch-alias"), "dir");
  try {
    for (const path of [checkout, fixture, join(checkout, "scratch"), retained, file,
      join(fixture, "checkout-alias"), join(fixture, "checkout-alias/scratch"), join(fixture, "scratch-alias")]) {
      expect(() => createOwnedScratch(path, checkout), path).toThrow(/scratch/);
    }
    expect(readFileSync(join(retained, "sentinel"), "utf8")).toBe("kept");
    expect(readFileSync(file, "utf8")).toBe("kept");
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
