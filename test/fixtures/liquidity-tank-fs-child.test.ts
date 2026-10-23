import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { it, vi } from "vitest";

import { sha256Hex } from "../../src/canonical/index.js";
import { createLiquidityTankIntent } from "../../src/rails/liquidityTank.js";
import { createFsLiquidityTankStore } from "../../src/rails/liquidityTankFs.js";
import { CRASH_BRIDGE_ID, CRASH_T0, crashAuthority, crashSubmission } from "./liquidityTankFsCrash.js";

/**
 * Child process of the filesystem liquidity-tank store's crash test. It
 * records one submission and stops for good right after the filesystem step
 * named by `DACS_TANK_FS_STOP` returns; the parent then kills it with SIGKILL.
 */
const child = vi.hoisted(() => ({
  armed: false,
  rowPublished: false,
  stop: process.env.DACS_TANK_FS_STOP ?? "",
  ready: process.env.DACS_TANK_FS_READY ?? "",
  bridges: "",
  records: "",
  reservation: "",
  row: "",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const { writeFileSync: write } = await import("node:fs");
  const reached = async (step: string) => {
    if (!child.armed || step !== child.stop) return;
    write(child.ready, step);
    await new Promise<never>(() => {});
  };
  const isStaging = (path: unknown) =>
    child.bridges !== "" && String(path).startsWith(`${child.bridges}/.`) && String(path).endsWith(".tmp");
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const path = String(args[0]);
      const writeFile = handle.writeFile.bind(handle);
      const sync = handle.sync.bind(handle);
      if (isStaging(path)) {
        handle.writeFile = async (...rest: Parameters<typeof handle.writeFile>) => {
          await writeFile(...rest);
          await reached("staging-written");
        };
        handle.sync = async () => {
          await sync();
          await reached("staging-synced");
        };
        await reached("staging-created");
      } else if (child.bridges !== "" && (path === child.bridges || path === child.records)) {
        handle.sync = async () => {
          await sync();
          if (path === child.bridges) await reached("reservation-directory-synced");
          else if (child.rowPublished) await reached("row-directory-synced");
        };
      }
      return handle;
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      await actual.link(...args);
      if (String(args[1]) === child.reservation) await reached("linked");
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      await actual.unlink(...args);
      if (isStaging(args[0])) await reached("staging-unlinked");
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      if (child.armed && String(args[1]) === child.row) {
        child.rowPublished = true;
        await reached("row-renamed");
      }
    },
  };
});

it.skipIf(process.env.DACS_TANK_FS_CHILD !== "1")(
  "records a liquidity-tank submission until it is killed at the named step",
  async () => {
    const dir = process.env.DACS_TANK_FS_DIR;
    if (!dir || !child.ready || !child.stop) throw new Error("child store configuration is missing");
    const intent = createLiquidityTankIntent(crashAuthority());
    child.bridges = join(dir, "bridges");
    child.records = join(dir, "records");
    child.reservation = join(child.bridges, `${sha256Hex(CRASH_BRIDGE_ID)}.json`);
    child.row = join(child.records, `${sha256Hex(intent.settlementKey)}.json`);
    const store = await createFsLiquidityTankStore({ dir });
    const claimed = await store.claim({ intent, owner: "worker-1", now: CRASH_T0, leaseDurationMs: 1_000 });
    if (claimed.status !== "acquired") throw new Error(`expected acquired, got ${claimed.status}`);
    child.armed = true;
    await store.recordSubmission({
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      owner: "worker-1",
      generation: claimed.lease.generation,
      now: CRASH_T0,
      submission: crashSubmission(),
    });
    // Every step comes before this point: reaching it means the step never ran.
    writeFileSync(child.ready, "completed");
    await new Promise<never>(() => {});
  },
);
