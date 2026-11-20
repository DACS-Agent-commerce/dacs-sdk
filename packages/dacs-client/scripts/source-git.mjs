// The one way the step-1 scripts read the frontend source repository, shared
// by the copy script, the import-cut map and the provenance checker.
//
// Git runs with replace objects off (--no-replace-objects; `git clone
// --mirror` copies refs/replace) and without inherited GIT_* variables
// (GIT_DIR, GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES, …), so
// only the repository named with -C and its own object store decide what is
// read. System and global Git configuration are disabled (Git >= 2.32); the
// repository's own configuration still applies. Git does not re-hash objects
// when it reads them, so that object store is trusted as it is; see
// check-provenance.mjs.
import { execFileSync } from "node:child_process";
import { devNull } from "node:os";

const GIT_ENV = Object.freeze({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: devNull,
});

export function sourceGit(args, options = {}) {
  return execFileSync("git", ["--no-replace-objects", ...args], { ...options, env: GIT_ENV });
}
