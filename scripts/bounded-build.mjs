#!/usr/bin/env node
import { constants, copyFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { requireDirectory } from "./acceptance-directory.mjs";
import { atomicWriteFile, readBoundedFile } from "./acceptance-evidence-io.mjs";

// Reads a generated file without following a link to anything outside the project.
function readProjectFile(project, name) {
  const file = readBoundedFile(join(project, name), { noFollow: true });
  if (file === undefined) throw new Error("generated project has no " + name);
  return file.bytes.toString("utf8");
}

/** Publishes a complete file by renaming it over its target, so an interrupted
 * or overlapping preparation can never expose a truncated version to a reader. */
export function replaceFile(path, contents, { write = writeFileSync, rename = renameSync,
  unlink = unlinkSync } = {}) {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    write(temporary, contents);
    rename(temporary, path);
  } catch (error) {
    try { unlink(temporary); } catch {}
    throw error;
  }
}

/** Creates an acceptance Dockerfile with bounded npm transport in its build stage.
 * Returns its path; throws if the generated Dockerfile lacks a build stage, if the Dockerfile or
 * .dockerignore is a link, or if either created file already exists. */
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
  // Publish the support file, then the ignore exception, then the Dockerfile
  // that consumes them, so a concurrent build sees either the old state or a
  // complete new one.
  copyFileSync(new URL("./bounded-npm-http.cjs", import.meta.url), join(project, supportName), constants.COPYFILE_EXCL);
  // A new file renamed into place: an existing entry is replaced, never written through.
  atomicWriteFile(join(project, ".dockerignore"), ignored + `\n!${supportName}\n`);
  const path = join(project, "Dockerfile.acceptance");
  writeFileSync(path, dockerfile, { flag: "wx" });
  return path;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error("usage: bounded-build.mjs <generated-project>");
  prepareBoundedBuild(process.argv[2]);
}
