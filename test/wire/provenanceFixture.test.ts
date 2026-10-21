import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { sha256ProvenanceFile } from "./provenanceFixture.js";

const root = new URL("../../", import.meta.url);
const original = JSON.parse(readFileSync(new URL("test/wire/fixtures/plugin-wire-82bf8c4.original.json", root), "utf8"));
const adapted = JSON.parse(readFileSync(new URL("test/wire/fixtures/plugin-wire-82bf8c4.tp1-revision-adapted.json", root), "utf8"));
const scripts = [original.provenance.generator, adapted.generator] as { path: string; sha256: string }[];
const preamble = "#!/usr/bin/env node\n";
const annotation = "// @ts-nocheck\n";

it.each(scripts)("retains the publication pin for $path in a copied, annotated sandbox", ({ path, sha256 }) => {
  const scratch = mkdtempSync(join(tmpdir(), "dacs provenance #"));
  try {
    const source = readFileSync(new URL(path, root), "utf8");
    expect(source.startsWith(preamble)).toBe(true);
    // The input may itself be a Stryker copy. Add the annotation only once.
    const annotated = source.startsWith(preamble + annotation) ? source
      : preamble + annotation + source.slice(preamble.length);
    const copied = join(scratch, path);
    mkdirSync(dirname(copied), { recursive: true });
    writeFileSync(copied, annotated);
    expect(createHash("sha256").update(readFileSync(copied)).digest("hex")).not.toBe(sha256);
    expect(sha256ProvenanceFile(pathToFileURL(copied))).toBe(sha256);

    // Removing the tool's preamble must not hide any other changed byte.
    for (const changed of [
      annotated + "// changed publication text\n",
      annotated.replace("import {", "import  {"),
      preamble + annotation + annotated.slice(preamble.length),
    ]) {
      writeFileSync(copied, changed);
      expect(sha256ProvenanceFile(pathToFileURL(copied))).not.toBe(sha256);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
