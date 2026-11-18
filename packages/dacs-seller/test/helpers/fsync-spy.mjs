import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';

/** Replaces `fs.openSync`, `fs.closeSync` and `fs.fsyncSync` so each `fsyncSync` call is reported with the
 * absolute path its descriptor was opened with. The path comes from the `openSync` call, not from the
 * operating system, so it works wherever Node runs. Only descriptors opened by `openSync` with a string
 * path are named; a sync of any other descriptor passes through unreported.
 * `onSync(path)` runs before the real sync and may throw to make the sync fail. `path` is `undefined`
 * for a descriptor that was not named.
 * Returns `{ synced, restore }`: `synced` lists the reported paths in order, and `restore()` puts the
 * original functions back. `restore()` can run twice, and leaves alone any function a later patch has
 * replaced again. When two patches of the same functions are active, restore them in the reverse of the
 * order they were installed: restoring the earlier one first leaves its wrapper in place. */
export function spyOnFsync({ onSync } = {}) {
  const { openSync, closeSync, fsyncSync } = fs;
  const pathsByDescriptor = new Map();
  const synced = [];
  const spies = {
    openSync: (path, ...rest) => {
      const descriptor = openSync(path, ...rest);
      if (typeof path === 'string') pathsByDescriptor.set(descriptor, resolve(path));
      return descriptor;
    },
    closeSync: (descriptor) => {
      pathsByDescriptor.delete(descriptor);
      return closeSync(descriptor);
    },
    fsyncSync: (descriptor) => {
      const path = pathsByDescriptor.get(descriptor);
      if (path !== undefined) synced.push(path);
      if (onSync) onSync(path);
      return fsyncSync(descriptor);
    },
  };
  const originals = { openSync, closeSync, fsyncSync };
  Object.assign(fs, spies);
  syncBuiltinESMExports();
  const restore = () => {
    for (const name of Object.keys(spies)) if (fs[name] === spies[name]) fs[name] = originals[name];
    syncBuiltinESMExports();
  };
  return { synced, restore };
}
