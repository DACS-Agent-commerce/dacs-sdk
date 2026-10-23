import { closeSync, constants, fstatSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export const EVIDENCE_MAX_BYTES = 16 * 1024 * 1024;
export const EVIDENCE_MAX_LINE_BYTES = 4096;
export const EVIDENCE_MAX_LINES = 100_000;

/** Checks an injected evidence string's encoded budget; throws on oversized input. */
export function boundedEvidenceText(text) {
  if (text !== undefined && (typeof text !== "string" || Buffer.byteLength(text) > EVIDENCE_MAX_BYTES)) {
    throw new Error("evidence byte limit exceeded");
  }
  return text;
}

/** Reads at most the evidence budget before decoding; returns undefined only for a missing file. */
export function readEvidence(path) {
  let descriptor;
  try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error("evidence must be a regular file");
    const bytes = Buffer.alloc(EVIDENCE_MAX_BYTES + 1);
    let length = 0, count;
    while (length < bytes.length && (count = readSync(descriptor, bytes, length, bytes.length - length, null)) > 0) length += count;
    if (length > EVIDENCE_MAX_BYTES) throw new Error("evidence byte limit exceeded");
    return bytes.subarray(0, length).toString("utf8");
  } finally { closeSync(descriptor); }
}

/** Iterates bounded diagnostic lines; throws before admitting an oversized line or list. */
export function* evidenceLines(text = "") {
  boundedEvidenceText(text);
  let start = 0, count = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start), end = newline < 0 ? text.length : newline;
    if (++count > EVIDENCE_MAX_LINES || end - start > EVIDENCE_MAX_LINE_BYTES ||
        Buffer.byteLength(text.slice(start, end)) > EVIDENCE_MAX_LINE_BYTES) throw new Error("evidence line limit exceeded");
    yield text.slice(start, end);
    if (newline < 0) break;
    start = end + 1;
  }
}

/** Replaces a JSON result by sibling rename, removing temporary files even on failure. */
export function atomicWriteJson(path, value) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
