#!/usr/bin/env node
// Inert until the rehearsal calls it: the host's only way to read files that a
// container could have written. Nothing here follows a link or replaces a file.
import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { readBoundedFile } from "./acceptance-evidence-io.mjs";
import { requireDirectory } from "./acceptance-directory.mjs";

export const SEALED_CONTEXT_SCHEMA = "dacs-sealed-context/v1";

// Copies one regular file to a destination that must not exist yet, keeping its permission bits.
function copyRegularFile(source, destination, label) {
  let file, descriptor;
  try {
    requireDirectory(dirname(source));
    requireDirectory(dirname(destination));
    file = readBoundedFile(source, { noFollow: true });
    if (file === undefined) return undefined;
    descriptor = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, file.mode);
    // The creation mode above is masked by the process umask; set the exact source bits.
    fchmodSync(descriptor, file.mode);
    writeFileSync(descriptor, file.bytes);
  } catch (error) { throw new Error(`cannot copy ${label}: ${error.message}`, { cause: error }); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
  return file;
}

// Gives a directory just created under `path` the source directory's exact permission bits;
// mkdir's own mode is masked by the process umask.
function copyDirectoryMode(source, path) {
  const mode = lstatSync(source).mode & 0o777;
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_DIRECTORY ?? 0));
  try { fchmodSync(descriptor, mode); } finally { closeSync(descriptor); }
}

/** Copies each named regular file from `sourceDirectory` into `destinationDirectory`; a
 * [source, destination] pair renames it. Returns the destination names copied. Throws for a
 * link, FIFO, directory, oversized file, name with a path separator or existing destination,
 * and for a missing file unless `optional` (then it is skipped). */
export function collectEvidence(sourceDirectory, destinationDirectory, names, { optional = false } = {}) {
  requireDirectory(sourceDirectory);
  requireDirectory(destinationDirectory);
  const copied = [];
  for (const entry of names) {
    const pair = Array.isArray(entry) ? entry : [entry, entry];
    if (pair.length !== 2 || pair.some(name => typeof name !== "string")) {
      throw new Error("evidence entry must be a name or a [source, destination] pair: " + JSON.stringify(entry));
    }
    const [source, destination] = pair;
    if ([source, destination].some(name => name.includes("/") || name === "." || name === "..")) {
      throw new Error("evidence name must be a single file name: " + JSON.stringify(entry));
    }
    if (copyRegularFile(join(sourceDirectory, source), join(destinationDirectory, destination), source)) copied.push(destination);
    else if (!optional) throw new Error("missing evidence: " + source);
  }
  return copied;
}

// The ancestor directories of a project-relative file name, outermost first.
const ancestors = name => name.split("/").slice(0, -1).map((_part, index, parts) => parts.slice(0, index + 1).join("/"));

/** Copies exactly the regular files `names` (project-relative) of the generated project at
 * `project` into the new directory `context`, leaving out node_modules. Returns the digest record
 * { schema, files: { name: sha256 } }. Throws if the project root, a directory on a listed path
 * or a listed file is a link, a listed file is missing, irregular or oversized, a listed name is
 * inside node_modules, the project holds any other entry outside node_modules, or `context`
 * exists. */
export function sealProject(project, context, names) {
  const listed = new Set(names.map(name => posix.normalize(name)));
  const directories = new Set([...listed].flatMap(ancestors));
  requireDirectory(project);
  requireDirectory(dirname(context));
  // readdir reports a link as a link, so only real directories are entered.
  const visit = relative => {
    for (const entry of readdirSync(join(project, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (name === "node_modules") continue;
      if (entry.isDirectory() && directories.has(name)) visit(name);
      else if (!entry.isFile() || !listed.has(name)) throw new Error("unexpected project entry: " + name);
    }
  };
  visit("");
  const orderedDirectories = [...directories].sort();
  // Validate every listed directory, and refuse a listed entry inside node_modules, before
  // creating anything, so a link or an excluded name leaves no partial context.
  for (const directory of orderedDirectories) requireDirectory(join(project, directory));
  for (const name of listed) {
    if (name === "node_modules" || name.startsWith("node_modules/")) {
      throw new Error("evidence name must be outside node_modules: " + name);
    }
  }
  mkdirSync(context);
  try {
    for (const directory of orderedDirectories) {
      const path = join(context, directory);
      mkdirSync(path);
      copyDirectoryMode(join(project, directory), path);
    }
    const files = Object.create(null);
    for (const name of [...listed].sort()) {
      const file = copyRegularFile(join(project, name), join(context, name), name);
      if (!file) throw new Error("missing project file: " + name);
      files[name] = createHash("sha256").update(file.bytes).digest("hex");
    }
    return { schema: SEALED_CONTEXT_SCHEMA, files };
  } catch (error) {
    // `context` was created here, so a failure halfway through must not leave a
    // partial sealed tree that a retry could not replace.
    rmSync(context, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, ...args] = process.argv.slice(2);
  const optional = mode === "collect" && args[0] === "--optional";
  const [first, second, third, ...rest] = optional ? args.slice(1) : args;
  if (mode === "seal" && rest.length > 0) {
    // Refuse an existing record before sealing, so a refused run leaves no context behind.
    let recordExists = true;
    try { lstatSync(third); }
    catch (error) { if (error.code === "ENOENT") recordExists = false; else throw error; }
    if (recordExists) throw new Error("EEXIST: refusing to replace " + third);
    writeFileSync(third, JSON.stringify(sealProject(first, second, rest), null, 2) + "\n", { flag: "wx" });
  } else if (mode === "collect" && third !== undefined) {
    const names = [third, ...rest].map(name => {
      const separator = name.indexOf("=");
      if (separator < 0) return name;
      if (name.indexOf("=", separator + 1) >= 0) throw new Error("evidence rename must contain at most one '=': " + name);
      return [name.slice(0, separator), name.slice(separator + 1)];
    });
    collectEvidence(first, second, names, { optional });
  } else {
    throw new Error("usage: acceptance-seal.mjs seal <project> <context> <sealed-context.json> <name>... | " +
      "collect [--optional] <source-directory> <destination-directory> <name[=destination]>...");
  }
}
