#!/usr/bin/env node
// Inert until the rehearsal calls it: the host's only way to read files that a
// container could have written. Nothing here follows a link or replaces a file.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { readBoundedFile } from "./acceptance-evidence-io.mjs";
import { requireDirectory } from "./acceptance-directory.mjs";

export const SEALED_CONTEXT_SCHEMA = "dacs-sealed-context/v1";

// Copies one regular file to a destination that must not exist yet, keeping its permission bits.
function copyRegularFile(source, destination, label) {
  let file;
  try {
    requireDirectory(dirname(source));
    requireDirectory(dirname(destination));
    file = readBoundedFile(source, { noFollow: true });
    if (file !== undefined) writeFileSync(destination, file.bytes, { flag: "wx", mode: file.mode });
  } catch (error) { throw new Error(`cannot copy ${label}: ${error.message}`, { cause: error }); }
  return file;
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
    const [source, destination] = Array.isArray(entry) ? entry : [entry, entry];
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
 * or a listed file is a link, a listed file is missing, irregular or oversized, the project holds
 * any other entry outside node_modules, or `context` exists. */
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
  mkdirSync(context);
  for (const directory of [...directories].sort()) {
    requireDirectory(join(project, directory));
    mkdirSync(join(context, directory), { mode: lstatSync(join(project, directory)).mode & 0o777 });
  }
  const files = {};
  for (const name of [...listed].sort()) {
    const file = copyRegularFile(join(project, name), join(context, name), name);
    if (!file) throw new Error("missing project file: " + name);
    files[name] = createHash("sha256").update(file.bytes).digest("hex");
  }
  return { schema: SEALED_CONTEXT_SCHEMA, files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, ...args] = process.argv.slice(2);
  const optional = mode === "collect" && args[0] === "--optional";
  const [first, second, third, ...rest] = optional ? args.slice(1) : args;
  if (mode === "seal" && rest.length > 0) {
    writeFileSync(third, JSON.stringify(sealProject(first, second, rest), null, 2) + "\n", { flag: "wx" });
  } else if (mode === "collect" && third !== undefined) {
    const names = [third, ...rest].map(name => name.includes("=") ? name.split("=") : name);
    collectEvidence(first, second, names, { optional });
  } else {
    throw new Error("usage: acceptance-seal.mjs seal <project> <context> <sealed-context.json> <name>... | " +
      "collect [--optional] <source-directory> <destination-directory> <name[=destination]>...");
  }
}
