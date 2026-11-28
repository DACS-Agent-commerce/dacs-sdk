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

/** Names the file in a read error and keeps the original error as its cause. */
export function namingFile(path, error, message = error.message) {
  return new Error(`${message}: ${path}`, { cause: error });
}

/** Reads a regular file of at most the evidence budget; `noFollow` refuses a link at its last
 * component (ELOOP). Returns its bytes and permission bits, or undefined only for a missing file.
 * A file refused after opening (not regular, over the budget) throws an error that names `path` and
 * carries the original error as its cause; a named open error reports the display name without
 * leaking the source path. An unnamed open error is thrown as the system reported it. */
export function readBoundedFile(path, { noFollow = false, name = path } = {}) {
  let descriptor;
  try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (noFollow ? constants.O_NOFOLLOW : 0)); }
  catch (error) {
    if (error.code === "ENOENT") return undefined;
    if (name !== path) throw namingFile(name, error, "evidence could not be opened");
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("evidence must be a regular file");
    const bytes = Buffer.alloc(EVIDENCE_MAX_BYTES + 1);
    let length = 0, count;
    while (length < bytes.length && (count = readSync(descriptor, bytes, length, bytes.length - length, null)) > 0) length += count;
    if (length > EVIDENCE_MAX_BYTES) throw new Error("evidence byte limit exceeded");
    return { bytes: bytes.subarray(0, length), mode: stat.mode & 0o777 };
  } catch (error) { throw namingFile(name, error); }
  finally { closeSync(descriptor); }
}

// A byte order mark stays in the text, as Buffer decoding kept it.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// Decodes the bytes of the file named `name`; throws for invalid UTF-8 rather than substituting characters.
function decodeEvidence(bytes, name) {
  try { return strictUtf8.decode(bytes); } catch (error) { throw namingFile(name, error, "evidence is not valid UTF-8"); }
}

/** Reads at most the evidence budget before decoding; returns undefined only for a missing file.
 * Throws for a file that is not regular, over the budget or not valid UTF-8; the error names `name`
 * (default `path`). */
export function readEvidence(path, { name = path } = {}) {
  const file = readBoundedFile(path, { name });
  return file === undefined ? undefined : decodeEvidence(file.bytes, name);
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

/** Replaces `path` by sibling rename, so an existing entry (a link included) is never written
 * through; flushes the new file to storage before publishing and removes the temporary file even
 * on failure. */
export function atomicWriteFile(path, contents, { write = writeFileSync } = {}) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    write(temporary, contents, { flag: "wx", flush: true });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

/** Replaces a JSON result by sibling rename, removing temporary files even on failure. Throws
 * before writing, and keeps the existing file, when the result is over the evidence byte budget
 * that a later read admits. */
export function atomicWriteJson(path, value) {
  const contents = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(contents) > EVIDENCE_MAX_BYTES) throw new Error(`evidence byte limit exceeded: ${path}`);
  atomicWriteFile(path, contents);
}
