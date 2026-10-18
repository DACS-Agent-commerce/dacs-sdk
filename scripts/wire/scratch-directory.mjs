// Own only the fresh run directory, never the caller's scratch parent.
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const contains = (parent, child) => {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
};

export function createOwnedScratch(requested, repository) {
  const checkout = realpathSync(repository);
  const absolute = resolve(requested);
  // Resolve parent aliases before comparing paths; the parent must exist.
  const scratchParent = join(realpathSync(dirname(absolute)), basename(absolute));
  if (contains(scratchParent, checkout) || contains(checkout, scratchParent)) {
    throw new Error("scratch must be outside the repository and its ancestors");
  }
  let existing;
  try { existing = lstatSync(scratchParent); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink() || readdirSync(scratchParent).length !== 0) {
      throw new Error("scratch must be an empty or new directory, not a symlink");
    }
  } else {
    mkdirSync(scratchParent);
  }
  const path = mkdtempSync(join(scratchParent, "wire-run-"));
  const owned = lstatSync(path);
  return {
    path,
    cleanup() {
      let current;
      try { current = lstatSync(path); }
      catch (error) { if (error.code === "ENOENT") return; throw error; }
      if (current.isDirectory() && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino) {
        rmSync(path, { recursive: true, force: true });
      }
    },
  };
}
