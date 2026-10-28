// Worker-thread fixture for test/rails/liquidityTankFs.test.ts: opens the
// filesystem liquidity-tank store from src/ in this thread and stops for good
// inside one lock window, holding that lock as a worker terminated there would
// leave it; or, with `stopIn: "corrupt registry"`, fails to open it. Needs
// Node's `module.registerHooks` and `--experimental-transform-types`.
import fsPromises from "node:fs/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";

// The sources import `./x.js` for `./x.ts`.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && specifier.endsWith(".js")) {
        return next(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  },
});

const { repo, dir, stopIn, intent, submission, now } = workerData;
/**
 * Reports the lock held and never settles; the timer keeps this thread
 * running, so only termination ends it.
 */
const hold = () => {
  setInterval(() => {}, 60_000);
  parentPort.postMessage("holding");
  return new Promise(() => {});
};
const { link, rename } = fsPromises;
if (stopIn === "phase lock") {
  // Inside the phase lock, before the row is written.
  fsPromises.rename = async (from, to) => {
    if (String(to).startsWith(`${join(dir, "records")}/`)) await hold();
    return rename(from, to);
  };
} else if (stopIn === "bridge-ID lock") {
  // Inside the phase lock and the bridge ID's lock, before the reservation's link.
  fsPromises.link = async (from, to) => {
    if (String(to).startsWith(`${join(dir, "bridges")}/`)) await hold();
    return link(from, to);
  };
} else if (stopIn === "reclaim gate") {
  // Right after the store-wide reclaim gate is published.
  fsPromises.link = async (from, to) => {
    await link(from, to);
    if (String(to) === join(dir, "locks", ".reclaim")) await hold();
  };
} else if (stopIn === "corrupt registry") {
  // Something else left on this thread's `process` under the registry's key:
  // opening the store must throw, so this thread fails with that error.
  Object.defineProperty(process, Symbol.for("@kynesyslabs/dacs/liquidity-tank-fs/lock-registry/v1"), {
    value: { threadToken: "planted", held: [], tid: null, pidScope: null },
  });
}
syncBuiltinESMExports();

const { createFsLiquidityTankStore } = await import(pathToFileURL(join(repo, "src/rails/liquidityTankFs.ts")).href);
const store = await createFsLiquidityTankStore({ dir, lockTimeoutMs: 60_000 });
const claimed = await store.claim({ intent, owner: "worker-thread", now, leaseDurationMs: 600_000 });
await store.recordSubmission({
  settlementKey: intent.settlementKey,
  bindingHash: intent.bindingHash,
  owner: "worker-thread",
  generation: claimed.lease.generation,
  now,
  submission,
});
parentPort.postMessage("finished without stopping");
