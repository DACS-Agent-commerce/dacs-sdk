#!/usr/bin/env node
import { constants, copyFileSync, writeFileSync } from "node:fs";
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

/** Creates an acceptance Dockerfile with bounded npm transport in its build stage.
 * Returns its path; throws if the generated Dockerfile lacks a build stage, if the Dockerfile or
 * .dockerignore is a link, or if either created file already exists. */
export function prepareBoundedBuild(project) {
  requireDirectory(project);
  const source = readProjectFile(project, "Dockerfile");
  const ignored = readProjectFile(project, ".dockerignore");
  if (!/^FROM .+ AS build$/m.test(source)) throw new Error("generated Dockerfile has no build stage");
  const supportName = "acceptance-npm-http.cjs";
  copyFileSync(new URL("./bounded-npm-http.cjs", import.meta.url), join(project, supportName), constants.COPYFILE_EXCL);
  const dockerfile = source.replace(/^(FROM .+ AS build)\n/m, `$1\nCOPY ${supportName} /acceptance-npm-http.cjs\n` +
    "ENV DACS_BOUNDED_NPM_HTTP=1 NODE_OPTIONS=--require=/acceptance-npm-http.cjs npm_config_fetch_timeout=15000 npm_config_fetch_retries=2 npm_config_fetch_retry_mintimeout=1000 npm_config_fetch_retry_maxtimeout=2000\n");
  const path = join(project, "Dockerfile.acceptance");
  writeFileSync(path, dockerfile, { flag: "wx" });
  // A new file renamed into place: an existing entry is replaced, never written through.
  atomicWriteFile(join(project, ".dockerignore"), ignored.trimEnd() + `\n!${supportName}\n`);
  return path;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error("usage: bounded-build.mjs <generated-project>");
  prepareBoundedBuild(process.argv[2]);
}
