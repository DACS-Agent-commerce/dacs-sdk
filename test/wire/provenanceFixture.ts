import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const shebang = Buffer.from("#!/usr/bin/env node\n");
const sandboxPreamble = Buffer.from("#!/usr/bin/env node\n// @ts-nocheck\n");

export function sha256ProvenanceFile(url: URL): string {
  const bytes = readFileSync(url);
  // Stryker prepends this one type-check directive even to JavaScript files
  // outside its mutation targets. Recover the pinned publication bytes, keeping
  // the shebang and every other byte (including any further directive) intact.
  const source = bytes.subarray(0, sandboxPreamble.length).equals(sandboxPreamble)
    ? Buffer.concat([shebang, bytes.subarray(sandboxPreamble.length)]) : bytes;
  return createHash("sha256").update(source).digest("hex");
}
