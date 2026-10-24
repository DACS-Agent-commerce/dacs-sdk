import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each([
  ["capture-plugin-wire-fixture.mjs", "05945798929bde349aaab31c78c4a228223990459927f7f9b6b99785ac4279c6"],
  ["fixture-helpers.mjs", "bab11ad4ad6fdbfa2e191d53c8d8c4a1573598f6c52d1fac95094443f0e4eab8"],
])("preserves the immutable historical source and valid syntax of %s", (name, digest) => {
  const path = fileURLToPath(new URL(`../../scripts/wire/${name}`, import.meta.url));
  expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(digest);
  const result = spawnSync(process.execPath, ["--check", path], { encoding: "utf8", timeout: 10_000 });
  expect(result.status, result.stderr).toBe(0);
});
