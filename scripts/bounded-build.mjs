#!/usr/bin/env node
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { requireDirectory } from "./acceptance-directory.mjs";

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
 * Returns its path; throws if the generated Dockerfile lacks a build stage. */
export function prepareBoundedBuild(project) {
  requireDirectory(project);
  const source = readFileSync(join(project, "Dockerfile"), "utf8");
  const ignorePath = join(project, ".dockerignore");
  const ignore = readFileSync(ignorePath, "utf8").trimEnd();
  // An empty ignore file admits the whole project into the Docker context; a
  // damaged one must fail closed instead of being extended with an exception.
  if (!ignore) throw new Error("refusing an empty .dockerignore");
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
  replaceFile(join(project, supportName), readFileSync(new URL("./bounded-npm-http.cjs", import.meta.url)));
  // Repeating preparation must not stack identical ignore exceptions.
  if (!ignore.split(/\r?\n/).includes(`!${supportName}`)) replaceFile(ignorePath, ignore + `\n!${supportName}\n`);
  const path = join(project, "Dockerfile.acceptance");
  replaceFile(path, dockerfile);
  return path;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error("usage: bounded-build.mjs <generated-project>");
  prepareBoundedBuild(process.argv[2]);
}
