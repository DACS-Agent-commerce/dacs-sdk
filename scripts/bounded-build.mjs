#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireDirectory } from "./acceptance-directory.mjs";
import { atomicWriteFile, readBoundedFile } from "./acceptance-evidence-io.mjs";

// Reads a generated file without following a link to anything outside the project.
function readProjectFile(project, name) {
  const file = readBoundedFile(join(project, name), { noFollow: true });
  if (file === undefined) throw new Error("generated project has no " + name);
  return file.bytes.toString("utf8");
}

// Returns true when `bytes` is already published at `path`. Throws for a link, a non-regular
// entry or different bytes, so a repeat of a completed preparation is accepted while a planted
// or conflicting entry is refused and never written through.
function publishedExactly(path, bytes) {
  let existing;
  try { existing = lstatSync(path); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  if (!existing.isFile()) throw new Error(`EEXIST: refusing to replace ${basename(path)}`);
  const current = readBoundedFile(path, { noFollow: true });
  if (current === undefined || !current.bytes.equals(bytes)) {
    throw new Error(`EEXIST: refusing to replace a different ${basename(path)}`);
  }
  return true;
}

// Publishes `bytes` as a new link to a fully written temporary file, so a repeat or a restart
// after an interruption verifies the identical file instead of failing, and a concurrent writer
// sees either no file or the complete one.
function publishPreparedFile(path, bytes) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const temporary = `${path}.tmp-${randomUUID()}`;
    try {
      writeFileSync(temporary, bytes, { flag: "wx", flush: true });
      try { linkSync(temporary, path); return; }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    } finally { rmSync(temporary, { force: true }); }
    if (publishedExactly(path, bytes)) return;
  }
  throw new Error(`EEXIST: could not publish ${basename(path)}`);
}

/** Publishes a complete file by flushing it to storage, then renaming it over
 * its target, so an interrupted preparation or power loss cannot expose a
 * truncated version to a reader. */
export function replaceFile(path, contents, { write = writeFileSync, rename = renameSync,
  unlink = unlinkSync } = {}) {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    write(temporary, contents, { flush: true });
    rename(temporary, path);
  } catch (error) {
    try { unlink(temporary); } catch {}
    throw error;
  }
}

/** Creates an acceptance Dockerfile with bounded npm transport in its build stage.
 * Returns its path; throws if the generated Dockerfile lacks a build stage, if the Dockerfile or
 * .dockerignore is a link, or if either created file already holds other bytes. A repeat of a
 * completed preparation, or a run restarted after an interruption, returns the identical state. */
export function prepareBoundedBuild(project) {
  requireDirectory(project);
  const source = readProjectFile(project, "Dockerfile");
  const ignored = readProjectFile(project, ".dockerignore").trimEnd();
  // An empty ignore file admits the whole project into the Docker context; a
  // damaged one must fail closed instead of being extended with an exception.
  if (!ignored) throw new Error("refusing an empty .dockerignore");
  // Accept both LF and CRLF generated Dockerfiles, and insert with the file's
  // own line ending so validation and rewriting cannot disagree.
  const stage = /^(FROM .+ AS build)(\r?\n)/m.exec(source);
  if (!stage) throw new Error("generated Dockerfile has no build stage");
  const supportName = "acceptance-npm-http.cjs";
  const eol = stage[2];
  const insertion = `COPY ${supportName} /acceptance-npm-http.cjs${eol}` +
    `ENV DACS_BOUNDED_NPM_HTTP=1 NODE_OPTIONS=--require=/acceptance-npm-http.cjs npm_config_fetch_timeout=15000 npm_config_fetch_retries=2 npm_config_fetch_retry_mintimeout=1000 npm_config_fetch_retry_maxtimeout=2000${eol}`;
  const at = stage.index + stage[0].length;
  const dockerfile = source.slice(0, at) + insertion + source.slice(at);
  const support = readFileSync(new URL("./bounded-npm-http.cjs", import.meta.url));
  const dockerfileBytes = Buffer.from(dockerfile);
  const path = join(project, "Dockerfile.acceptance");
  // Refuse a conflicting existing output before any write, so a refused
  // preparation leaves the project unchanged.
  publishedExactly(join(project, supportName), support);
  publishedExactly(path, dockerfileBytes);
  // Publish the support file, then the ignore exception, then the Dockerfile
  // that consumes them, so a concurrent build sees either the old state or a
  // complete new one.
  publishPreparedFile(join(project, supportName), support);
  // A new file renamed into place: an existing entry is replaced, never written through.
  // Repeating preparation must not stack identical ignore exceptions.
  if (!ignored.split(/\r?\n/).includes(`!${supportName}`)) atomicWriteFile(join(project, ".dockerignore"), ignored + `\n!${supportName}\n`);
  publishPreparedFile(path, dockerfileBytes);
  return path;
}
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("usage: bounded-build.mjs <generated-project>");
  prepareBoundedBuild(process.argv[2]);
}
