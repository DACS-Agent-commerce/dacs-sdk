import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const notes = readFileSync(new URL("../../docs/releases/0.1.0-alpha.1.md", import.meta.url), "utf8").replace(/\s+/g, " ");

test("release notes distinguish compilation from packing direct-source packages", () => {
  assert.match(notes, /Packages with build scripts are built; every present package is packed and file-checked/);
  assert.doesNotMatch(notes, /Every present manifest is still built/);
});

test("every npm command documented in the release notes exists", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  for (const [, command] of notes.matchAll(/npm run ([\w:-]+)/g)) assert.ok(manifest.scripts[command], `unknown documented command: ${command}`);
});
