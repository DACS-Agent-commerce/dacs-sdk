import { rename } from "node:fs/promises";

/**
 * Publish one already-complete staging tree with a single filesystem rename.
 *
 * The caller must control the parent directory against hostile concurrent
 * replacement. POSIX rename semantics can replace an empty target directory
 * created after preflight; the operation never merges with or traverses that
 * directory. A non-empty target fails closed.
 *
 * `beforeRename` is an internal deterministic race seam used only by tests.
 */
export async function publishCompleteStagingDirectory(
  stagingDirectory: string,
  targetDirectory: string,
  beforeRename?: () => Promise<void>,
): Promise<void> {
  await beforeRename?.();
  await rename(stagingDirectory, targetDirectory);
}
