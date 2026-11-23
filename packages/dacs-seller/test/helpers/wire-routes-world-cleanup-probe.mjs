import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { world } from './wire-routes-world.mjs';

const originalPerformanceNow = Object.getOwnPropertyDescriptor(performance, 'now');
const originalRemove = fs.promises.rm;
let worldFixture;
let cleanupFailureInjected = false;

test('the real world registers owned cleanup before teardown', async (t) => {
  worldFixture = await world(t);
  const directory = worldFixture.directory;
  t.mock.method(fs.promises, 'rm', async (path, ...options) => {
    if (String(path) === directory) {
      cleanupFailureInjected = true;
      throw new Error('TEST injected owned-directory removal failure');
    }
    return originalRemove(path, ...options);
  });
  syncBuiltinESMExports();
});

test.after(async () => {
  const restored = isDeepStrictEqual(Object.getOwnPropertyDescriptor(performance, 'now'), originalPerformanceNow);
  console.log(`CLEANUP_FAILURE_INJECTED=${cleanupFailureInjected}`);
  console.log(`PERFORMANCE_RESTORED=${restored}`);
  fs.promises.rm = originalRemove;
  syncBuiltinESMExports();
  if (originalPerformanceNow) Object.defineProperty(performance, 'now', originalPerformanceNow);
  else delete performance.now;
  try { worldFixture?.handle.store.close(); } catch {}
  if (worldFixture) await originalRemove(worldFixture.directory, { recursive: true, force: true });
});
