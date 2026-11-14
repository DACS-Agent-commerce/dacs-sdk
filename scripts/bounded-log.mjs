#!/usr/bin/env node
import { closeSync, existsSync, openSync, realpathSync, writeSync } from "node:fs";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { EVIDENCE_MAX_BYTES } from "./acceptance-evidence-io.mjs";

/** The most a build log may hold: the evidence reader refuses a larger file. */
export const BUILD_LOG_MAX_BYTES = EVIDENCE_MAX_BYTES;

/** Copies `input` to `output` and to the file at `path`, at most `maxBytes` bytes of it.
 * Returns true when the input ended within the limit, and false once a byte beyond it
 * arrived, after writing the bytes up to the limit. Throws if the file cannot be written. */
export async function copyBoundedLog(input, output, path, maxBytes = BUILD_LOG_MAX_BYTES) {
  const descriptor = openSync(path, "w");
  let written = 0;
  try {
    for await (const chunk of input) {
      const kept = chunk.subarray(0, maxBytes - written);
      writeSync(descriptor, kept);
      if (!output.write(kept)) await once(output, "drain");
      written += kept.length;
      if (kept.length < chunk.length) return false;
    }
    return true;
  } finally { closeSync(descriptor); }
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [path] = process.argv.slice(2);
  if (!path) throw new Error("usage: bounded-log.mjs <log-file>");
  if (!await copyBoundedLog(process.stdin, process.stdout, path)) {
    process.stderr.write(`${path} exceeded ${BUILD_LOG_MAX_BYTES} bytes; stopping the build\n`);
    process.exitCode = 1;
    process.stdin.destroy();
  }
}
