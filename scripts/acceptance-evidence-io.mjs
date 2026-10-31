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

// A byte order mark stays in the text, as Buffer decoding kept it.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// Decodes evidence bytes; throws for invalid UTF-8 rather than substituting characters.
function decodeEvidence(bytes) {
  try { return strictUtf8.decode(bytes); } catch { throw new Error("evidence is not valid UTF-8"); }
}

/** Reads at most the evidence budget before decoding; returns undefined only for a missing file.
 * Throws for a file that is not regular, over the budget or not valid UTF-8. */
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
    return decodeEvidence(bytes.subarray(0, length));
  } finally { closeSync(descriptor); }
}

/** Reads evidence a step cannot go without, as readEvidence does; a missing file throws an
 * ENOENT error that names its path. */
export function readRequiredEvidence(path) {
  const text = readEvidence(path);
  if (text === undefined) throw Object.assign(new Error(`ENOENT: evidence file missing: ${path}`), { code: "ENOENT" });
  return text;
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
