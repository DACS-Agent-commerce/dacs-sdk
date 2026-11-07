// The kit's one private-directory rule, shared by the host and seller key custody.
import { lstatSync, realpathSync } from 'node:fs';

/**
 * True only for an existing directory (not a symbolic link) owned by this user
 * with mode exactly 0700, whose given path is its own canonical real path.
 * Any failure to inspect it answers false.
 */
export function isPrivateDirectory(path) {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o700 && stat.uid === process.getuid?.() && realpathSync(path) === path;
  } catch {
    return false;
  }
}
