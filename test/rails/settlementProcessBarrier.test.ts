import { symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { waitForFiles } from "../fixtures/settlementProcess.js";

// fs.watch can lose events: inotify drops them once its queue overflows. Model a
// lost event exactly: the barrier name starts to resolve with no event in the
// watched directory, because only its symlink target, elsewhere, is created.
test.skipIf(process.platform === "win32")("a restart barrier whose watch event never arrives is still seen", async () => {
  const root = await mkdtemp(join(tmpdir(), "dacs-barrier-"));
  try {
    const watched = join(root, "watched");
    const elsewhere = join(root, "elsewhere");
    await mkdir(watched);
    await mkdir(elsewhere);
    symlinkSync(join(elsewhere, "target"), join(watched, "barrier"));
    const waiting = waitForFiles(watched, ["barrier"], 2_000);
    // existsSync follows the link, so the barrier is absent until its target exists.
    setTimeout(() => writeFileSync(join(elsewhere, "target"), "ready"), 50);
    await expect(waiting).resolves.toBe("barrier");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
