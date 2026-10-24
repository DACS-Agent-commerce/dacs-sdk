import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const directories = ["test/wire/fixtures/", "conformance/tp1-node-observations/"];
const files = [
  "scripts/wire/capture-plugin-wire-fixture.mjs",
  "scripts/wire/adapt-tp1-revision-fixture.mjs",
  ...directories.flatMap((directory) => readdirSync(new URL(directory, root))
    .filter((name) => name.endsWith(".json")).map((name) => directory + name)),
];
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

it("preserves byte-pinned wire fixtures and provenance under a CRLF checkout configuration", () => {
  const scratch = mkdtempSync(join(tmpdir(), "dacs-wire-checkout-"));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  env.GIT_CONFIG_GLOBAL = join(scratch, "empty-global-config");
  env.GIT_CONFIG_NOSYSTEM = "1";
  const git = (...args: string[]) => execFileSync("git", args, { cwd: scratch, env, stdio: "pipe" });
  try {
    writeFileSync(env.GIT_CONFIG_GLOBAL, "");
    const expected = Object.fromEntries(files.map((file) => {
      const bytes = readFileSync(new URL(file, root));
      mkdirSync(dirname(join(scratch, file)), { recursive: true });
      writeFileSync(join(scratch, file), bytes);
      return [file, hash(bytes)];
    }));
    if (existsSync(new URL(".gitattributes", root))) {
      writeFileSync(join(scratch, ".gitattributes"), readFileSync(new URL(".gitattributes", root)));
    }
    git("-c", "core.autocrlf=false", "init", "--quiet");
    git("-c", "core.autocrlf=false", "add", ...files, ...(existsSync(join(scratch, ".gitattributes")) ? [".gitattributes"] : []));
    // Removing the files forces actual checkout conversion, regardless of stat caches.
    for (const file of files) unlinkSync(join(scratch, file));
    git("-c", "core.autocrlf=true", "checkout-index", "--all", "--force");
    expect(Object.fromEntries(files.map((file) => [file, hash(readFileSync(join(scratch, file)))]))).toEqual(expected);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
