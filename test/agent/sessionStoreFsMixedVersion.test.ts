import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

const gateRace = vi.hoisted(() => ({
  armed: false,
  target: "",
  quarantineName: "",
  legacyToken: "",
  observedRenames: [] as string[],
  moved: undefined as (() => void) | undefined,
  resume: undefined as Promise<void> | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (
      oldPath: Parameters<typeof actual.rename>[0],
      newPath: Parameters<typeof actual.rename>[1],
    ) => {
      gateRace.observedRenames.push(`${String(oldPath)} -> ${String(newPath)}`);
      await actual.rename(oldPath, newPath);
      if (!gateRace.armed || !String(newPath).endsWith(gateRace.target) ||
          !String(oldPath).endsWith(".candidate")) return;

      gateRace.armed = false;
      const publishedPath = String(newPath);
      const quarantine = `${publishedPath.slice(0, publishedPath.lastIndexOf("/") + 1)}` +
        gateRace.quarantineName;
      await actual.rename(newPath, quarantine);
      await actual.writeFile(
        newPath,
        JSON.stringify({ pid: process.pid, token: gateRace.legacyToken }),
        { flag: "wx", mode: 0o600 },
      );
      gateRace.moved?.();
      await gateRace.resume;
    },
  };
});

import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";

import { createFsFencedSessionStore } from "../../src/agent/fencedSessionStoreFs.js";
import { createFsSessionStore } from "../../src/agent/sessionStoreFs.js";

const roots: string[] = [];

afterEach(async () => {
  gateRace.armed = false;
  gateRace.observedRenames = [];
  gateRace.moved = undefined;
  gateRace.resume = undefined;
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

async function exerciseLegacyGateDisplacement(
  kind: "plain" | "fenced",
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), `dacs-${kind}-mixed-version-`));
  roots.push(dir);
  const jobId = `${kind}-legacy-gate-race`;
  const encoded = encodeURIComponent(jobId);
  const gatePath = join(dir, "locks", `${encoded}.reclaim`);
  const store = kind === "plain"
    ? await createFsSessionStore({ dir, lockStaleMs: 60_000 })
    : await createFsFencedSessionStore({ dir, lockStaleMs: 60_000 });
  await store.create({ jobId, now: 0 });

  let movedResolve!: () => void;
  const moved = new Promise<void>((resolve) => { movedResolve = resolve; });
  let resumeResolve!: () => void;
  const resume = new Promise<void>((resolve) => { resumeResolve = resolve; });
  gateRace.target = `/locks/${encoded}.reclaim`;
  gateRace.quarantineName =
    `reclaim-${encoded.length}-${encoded}.legacy.quarantine`;
  gateRace.legacyToken = `${kind}-legacy-owner`;
  gateRace.moved = movedResolve;
  gateRace.resume = resume;
  gateRace.armed = true;

  const transition = store.transition({
    jobId,
    expectedRevision: 0,
    phase: "new-version-contender",
    now: 1,
  });
  try {
    await Promise.race([
      moved,
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error(
          `gate publication hook did not fire: ${gateRace.observedRenames.join(" | ")}`,
        )),
        1_000,
      )),
    ]);
    resumeResolve();

    // The legacy holder owns the canonical regular-file gate while the new
    // contender's directory-form gate is quarantined. A new-version process
    // must detect that post-publication displacement before mutating state.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await store.load(jobId)).toMatchObject({
      status: "ok",
      record: { phase: "created", revision: 0 },
    });

    await unlink(gatePath);
    const result = await transition;
    expect(result).toMatchObject({
      ok: true,
      record: { phase: "new-version-contender", revision: 1 },
    });
  } finally {
    resumeResolve();
    await unlink(gatePath).catch(() => {});
    await transition.catch(() => {});
  }
}

describe("mixed-version session mutation gates", () => {
  test("the fenced store detects a legacy reclaimer that displaces its published gate", async () => {
    await exerciseLegacyGateDisplacement("fenced");
  });

  test("the plain store applies the same defensive post-publication check", async () => {
    await exerciseLegacyGateDisplacement("plain");
  });
});
