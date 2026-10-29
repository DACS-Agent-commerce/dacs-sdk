#!/usr/bin/env node
// Inert until the rehearsal calls it: the host's only way to read files that a
// container could have written. Nothing here follows a link or replaces a file.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, chmodSync, constants, existsSync, fchmodSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { readBoundedFile } from "./acceptance-evidence-io.mjs";
import { requireDirectory } from "./acceptance-directory.mjs";

export const SEALED_CONTEXT_SCHEMA = "dacs-sealed-context/v1";

// Returns true when `bytes` is already published at `path`; throws for a link, a non-regular
// entry or different bytes, so a retry of a completed copy is accepted while a planted or
// conflicting destination is refused and never written through.
function publishedExactly(path, bytes) {
  let existing;
  try { existing = lstatSync(path); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  if (!existing.isFile()) throw new Error(`EEXIST: refusing to replace ${path}`);
  const current = readBoundedFile(path, { noFollow: true });
  if (current === undefined || !current.bytes.equals(bytes)) {
    throw new Error(`EEXIST: refusing to replace a different ${path}`);
  }
  return true;
}

// Writes `bytes` to a fresh sibling, flushes it, then hard-links it to `path`. The link is
// exclusive, so an existing entry (a link included) is never replaced; a writer that loses a
// race accepts only an identical file, and an interrupted write leaves no partial destination.
function publishFile(path, bytes, { mode } = {}) {
  if (publishedExactly(path, bytes)) return;
  requireDirectory(dirname(path));
  const temporary = `${path}.tmp-${randomUUID()}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    if (mode !== undefined) fchmodSync(descriptor, mode);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    try { linkSync(temporary, path); }
    catch (error) { if (error.code !== "EEXIST" || !publishedExactly(path, bytes)) throw error; }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

// Copies one regular file to a destination that must not exist yet, keeping its permission bits.
// Publishing through a temporary sibling makes a retry after an interruption reuse the complete
// copy instead of failing on a partially written destination.
function copyRegularFile(source, destination, label) {
  try {
    requireDirectory(dirname(source));
    requireDirectory(dirname(destination));
    const file = readBoundedFile(source, { noFollow: true });
    if (file === undefined) return undefined;
    publishFile(destination, file.bytes, { mode: file.mode });
    return file;
  } catch (error) { throw new Error(`cannot copy ${label}: ${error.message}`, { cause: error }); }
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
 * link, FIFO, directory, oversized file, name with a path separator or conflicting destination,
 * and for a missing file unless `optional` (then it is skipped). A destination already holding
 * the identical bytes is accepted, so an interrupted collection can be retried. */
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
 * exists. The tree is built in a staging sibling and renamed into place when complete, so an
 * interrupted seal never leaves a partial `context`. */
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
  let existing;
  try { existing = lstatSync(context); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing) throw new Error(`EEXIST: refusing to replace ${context}`);
  const staging = `${context}.staging-${randomUUID()}`;
  mkdirSync(staging);
  try {
    for (const directory of orderedDirectories) mkdirSync(join(staging, directory));
    const files = Object.create(null);
    for (const name of [...listed].sort()) {
      const file = copyRegularFile(join(project, name), join(staging, name), name);
      if (!file) throw new Error("missing project file: " + name);
      files[name] = createHash("sha256").update(file.bytes).digest("hex");
    }
    // Apply the source directory modes only once their contents exist, deepest first, so a
    // read-only source directory cannot block writing its own children.
    for (const directory of [...orderedDirectories].sort((a, b) => b.split("/").length - a.split("/").length)) {
      copyDirectoryMode(join(project, directory), join(staging, directory));
    }
    renameSync(staging, context);
    return { schema: SEALED_CONTEXT_SCHEMA, files };
  } catch (error) {
    // `staging` was created here, and the published `context` never holds a partial tree.
    try { rmSync(staging, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

// Resolves the CLI's name arguments. A bare name containing "=" is a rename only when no file
// of that exact literal name exists; when both readings name an existing file the request is
// ambiguous and refused instead of silently copying a different file.
function evidenceEntries(sourceDirectory, names) {
  return names.map(name => {
    const separator = name.indexOf("=");
    if (separator < 0) return name;
    if (name.indexOf("=", separator + 1) >= 0) throw new Error("evidence rename must contain at most one '=': " + name);
    const literalExists = existsSync(join(sourceDirectory, name));
    if (literalExists) {
      if (existsSync(join(sourceDirectory, name.slice(0, separator)))) {
        throw new Error("refusing an ambiguous evidence name: " + name);
      }
      return name;
    }
    return [name.slice(0, separator), name.slice(separator + 1)];
  });
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2);
  const optional = mode === "collect" && args[0] === "--optional";
  const [first, second, third, ...rest] = optional ? args.slice(1) : args;
  if (mode === "seal" && rest.length > 0) {
    // Refuse an existing record before sealing, so a refused run leaves no context behind.
    let recordExists = true;
    try { lstatSync(third); }
    catch (error) { if (error.code === "ENOENT") recordExists = false; else throw error; }
    if (recordExists) throw new Error("EEXIST: refusing to replace " + third);
    const sealed = sealProject(first, second, rest);
    try {
      publishFile(third, Buffer.from(JSON.stringify(sealed, null, 2) + "\n"));
    } catch (error) {
      // The record could not be published, so remove the context this run created rather than
      // leaving a sealed tree that a retry would refuse. Directories copied from a read-only
      // source get their owner-write bit back so their contents can be removed.
      for (const name of rest) {
        for (const directory of ancestors(name)) {
          try { chmodSync(join(second, directory), 0o700); } catch {}
        }
      }
      rmSync(second, { recursive: true, force: true });
      throw error;
    }
  } else if (mode === "collect" && third !== undefined) {
    collectEvidence(first, second, evidenceEntries(first, [third, ...rest]), { optional });
  } else {
    throw new Error("usage: acceptance-seal.mjs seal <project> <context> <sealed-context.json> <name>... | " +
      "collect [--optional] <source-directory> <destination-directory> <name[=destination]>...");
  }
}
