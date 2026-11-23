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
export function spyOnFsync({ onSync, aroundSync } = {}) {
  const { openSync, closeSync, fsyncSync } = fs;
  const open = fs.promises.open;
  const pathsByDescriptor = new Map();
  const synced = [];
  const handleSyncs = new Map();
  const syncPath = (path, sync, wrap = false) => {
    if (path !== undefined) synced.push(path);
    if (onSync) onSync(path);
    return wrap && aroundSync ? aroundSync(path, sync) : sync();
  };
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
      return syncPath(path, () => fsyncSync(descriptor));
    },
    promiseOpen: async (path, ...rest) => {
      const handle = await open(path, ...rest);
      if (typeof path === 'string') {
        const descriptor = handle.fd;
        pathsByDescriptor.set(descriptor, resolve(path));
        const originalSync = handle.sync;
        const ownSync = Object.getOwnPropertyDescriptor(handle, 'sync');
        const wrappedSync = function (...args) {
          const openedPath = pathsByDescriptor.get(this.fd);
          return syncPath(openedPath, () => originalSync.apply(this, args), true);
        };
        Object.defineProperty(handle, 'sync', {
          configurable: true,
          enumerable: ownSync?.enumerable ?? false,
          value: wrappedSync,
          writable: true,
        });
        handleSyncs.set(handle, { ownSync, wrappedSync });
        handle.once('close', () => pathsByDescriptor.delete(descriptor));
      }
      return handle;
    },
  };
  const originals = { openSync, closeSync, fsyncSync, promiseOpen: open };
  Object.assign(fs, { openSync: spies.openSync, closeSync: spies.closeSync, fsyncSync: spies.fsyncSync });
  fs.promises.open = spies.promiseOpen;
  syncBuiltinESMExports();
  const restore = () => {
    for (const name of ['openSync', 'closeSync', 'fsyncSync']) if (fs[name] === spies[name]) fs[name] = originals[name];
    if (fs.promises.open === spies.promiseOpen) fs.promises.open = originals.promiseOpen;
    for (const [handle, { ownSync, wrappedSync }] of handleSyncs) {
      if (handle.sync !== wrappedSync) continue;
      if (ownSync) Object.defineProperty(handle, 'sync', ownSync);
      else delete handle.sync;
    }
    handleSyncs.clear();
    syncBuiltinESMExports();
  };
  return { synced, restore };
}
