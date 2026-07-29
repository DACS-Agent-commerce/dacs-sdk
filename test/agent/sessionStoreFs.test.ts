import { mkdtemp, writeFile, stat, mkdir, readFile, open, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createFsSessionStore } from "../../src/agent/sessionStoreFs.js";
import type { SessionStore } from "../../src/agent/sessionStore.js";

let dir: string;
let store: SessionStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dacs-sessionstore-"));
  store = await createFsSessionStore({ dir });
});

describe("createFsSessionStore (durable conformance #55)", () => {
  test("core conformance: create + CAS + lease + anti-replay + immutable receipt", async () => {
    await store.create({ jobId: "j1", agreementHash: "0xagr", now: 0 });
    // CAS: two workers at revision 0, one wins.
    const a = await store.transition({ jobId: "j1", expectedRevision: 0, phase: "settling", now: 1 });
    const b = await store.transition({ jobId: "j1", expectedRevision: 0, phase: "aborted", now: 1 });
    expect(a.ok).toBe(true);
    expect(b.ok && "reason" in b ? b : { reason: (b as { reason: string }).reason }).toMatchObject({ reason: "revision-mismatch" });
    // Lease.
    expect((await store.acquireLease({ jobId: "j1", owner: "A", ttlMs: 1000, now: 2 })).ok).toBe(true);
    expect((await store.acquireLease({ jobId: "j1", owner: "B", ttlMs: 1000, now: 3 })).ok).toBe(false);
    // Anti-replay: create bound 0xagr to j1; j2 can't reuse it.
    await store.create({ jobId: "j2" });
    expect(await store.bindHash({ hash: "0xagr", jobId: "j2", kind: "agreement" })).toEqual({ ok: false, boundTo: "j1" });
    // Immutable receipt — as the lease owner (A), since the lease is still live.
    const load = await store.load("j1");
    const rev = load.status === "ok" ? load.record.revision : 0;
    const r = await store.transition({ jobId: "j1", expectedRevision: rev, owner: "A", receipt: { kind: "bundle", ref: "0xb" }, now: 4 });
    expect(r.ok).toBe(true);
    const rev2 = r.ok ? r.record.revision : 0;
    const bad = await store.transition({ jobId: "j1", expectedRevision: rev2, owner: "A", receipt: { kind: "bundle", ref: "0xEVIL" }, now: 5 });
    expect(bad.ok).toBe(false);
  });

  test("DURABLE across a restart: a fresh store instance on the same dir sees the session", async () => {
    await store.create({ jobId: "j1", phase: "settled", now: 0 });
    await store.transition({ jobId: "j1", expectedRevision: 0, receipt: { kind: "settlement", ref: "0xpaid" }, now: 1 });
    // Simulate a process restart: brand-new store over the same directory.
    const reopened = await createFsSessionStore({ dir });
    const loaded = await reopened.load("j1");
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") {
      expect(loaded.record.phase).toBe("settled");
      expect(loaded.record.receipts).toEqual([{ kind: "settlement", ref: "0xpaid", recordedAt: 1 }]);
    }
  });

  test("load fails CLOSED: a corrupt session file is `corrupt`, not `missing`", async () => {
    await store.create({ jobId: "j1", now: 0 });
    await writeFile(join(dir, "sessions", `${encodeURIComponent("j1")}.json`), "{ not json");
    const loaded = await store.load("j1");
    expect(loaded.status).toBe("corrupt");
  });

  test("load fails CLOSED: a newer schema version is `unsupported`", async () => {
    await writeFile(
      join(dir, "sessions", `${encodeURIComponent("future")}.json`),
      JSON.stringify({ storeVersion: 999, jobId: "future", phase: "x", revision: 0, checkpoints: [], receipts: [], createdAt: 0, updatedAt: 0 }),
    );
    const loaded = await store.load("future");
    expect(loaded).toEqual({ status: "unsupported", version: 999 });
  });

  test("session files are written with restrictive 0600 permissions", async () => {
    await store.create({ jobId: "j1", now: 0 });
    const st = await stat(join(dir, "sessions", `${encodeURIComponent("j1")}.json`));
    expect(st.mode & 0o777).toBe(0o600);
  });

  test("missing session is `missing`; create rejects a duplicate", async () => {
    expect(await store.load("nope")).toEqual({ status: "missing" });
    await store.create({ jobId: "j1" });
    await expect(store.create({ jobId: "j1" })).rejects.toThrow(/already exists/);
  });

  test("create REJECTS a reused agreement hash and does NOT persist the session (#67)", async () => {
    await store.create({ jobId: "j1", agreementHash: "0xagr" });
    await expect(store.create({ jobId: "j2", agreementHash: "0xagr" })).rejects.toThrow(
      /anti-replay|already bound/,
    );
    // The conflicting session must NOT have been persisted, and ownership stays j1.
    expect(await store.load("j2")).toEqual({ status: "missing" });
    expect(await store.bindHash({ hash: "0xagr", jobId: "j2", kind: "agreement" })).toEqual({ ok: false, boundTo: "j1" });
  });

  test("load fails CLOSED: a field of the wrong type is `corrupt`, not `ok` (#67)", async () => {
    await store.create({ jobId: "j1", now: 0 });
    // Valid JSON + right storeVersion, but revision is a string → tampered/partial.
    await writeFile(
      join(dir, "sessions", `${encodeURIComponent("j1")}.json`),
      JSON.stringify({ storeVersion: 1, jobId: "j1", phase: "created", revision: "NaN", checkpoints: [], receipts: [], createdAt: 0, updatedAt: 0 }),
    );
    expect((await store.load("j1")).status).toBe("corrupt");
  });

  test("a stale lock left by a crashed holder is reclaimed, not blocked forever (#67)", async () => {
    const staleStore = await createFsSessionStore({ dir, lockStaleMs: 50 });
    await staleStore.create({ jobId: "j1", now: 0 });
    // Simulate a crashed holder: plant a lock file and backdate it past the stale window.
    const lp = join(dir, "locks", `${encodeURIComponent("j1")}.lock`);
    await (await open(lp, "wx")).close();
    const old = new Date(Date.now() - 60_000);
    await utimes(lp, old, old);
    // The transition must reclaim the stale lock and succeed rather than time out.
    const r = await staleStore.transition({ jobId: "j1", expectedRevision: 0, phase: "settling", now: 1 });
    expect(r.ok).toBe(true);
  });

  test("checkpoint payload is secret-free: a nested value is rejected (#67)", async () => {
    await store.create({ jobId: "j1", now: 0 });
    await expect(
      store.transition({
        jobId: "j1",
        expectedRevision: 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        checkpoint: { key: "settle:0", stage: "intent", data: { secret: { apiKey: "sk-live" } } as any },
        now: 1,
      }),
    ).rejects.toThrow(/primitive|secret/);
  });

  test("concurrent CAS transitions: only ONE of many racing writers advances", async () => {
    await store.create({ jobId: "j1", now: 0 });
    // 8 workers all read revision 0 and race to advance it.
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.transition({ jobId: "j1", expectedRevision: 0, phase: `p${i}`, now: 1 }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1); // exactly one winner
  });

  test("staggered semantic checkpoint claims cannot both win", async () => {
    await store.create({ jobId: "j1", now: 0 });
    const first = await store.claimCheckpoint({
      jobId: "j1",
      key: "settle:0",
      data: { rail: "pay-x402" },
      phase: "settling",
      now: 1,
    });
    expect(first.ok).toBe(true);
    const later = await store.claimCheckpoint({
      jobId: "j1",
      key: "settle:0",
      data: { rail: "pay-x402" },
      phase: "settling",
      now: 2,
    });
    expect(later.ok).toBe(false);
    if (!later.ok) expect(later.reason).toBe("held");
  });
});

describe("crash-window hardening (#67 round 3)", () => {
  test("a session persisted before its hash commit is recovered, never stolen", async () => {
    const first = await createFsSessionStore({ dir });
    const second = await createFsSessionStore({ dir });
    // Simulate creator A paused/crashed in the new protocol's only open window:
    // its complete session is durable, but the hash commit has not happened yet.
    await writeFile(
      join(dir, "sessions", encodeURIComponent("j-first") + ".json"),
      JSON.stringify({
        storeVersion: 1,
        jobId: "j-first",
        agreementHash: "0xshared",
        phase: "created",
        revision: 0,
        checkpoints: [],
        receipts: [],
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    expect((await first.load("j-first")).status).toBe("ok");

    // Creator B must finalize A's ownership and reject its own create. It must
    // never infer "missing binding" means the live/persisted candidate is stale.
    await expect(
      second.create({ jobId: "j-second", agreementHash: "0xshared" }),
    ).rejects.toThrow(/already bound to session j-first/);
    expect(await second.load("j-second")).toEqual({ status: "missing" });
    expect(
      await first.bindHash({
        hash: "0xshared",
        jobId: "j-first",
        kind: "agreement",
      }),
    ).toEqual({ ok: true, boundTo: "j-first" });
  });

  test("two store instances racing the same agreement hash leave exactly one session", async () => {
    const a = await createFsSessionStore({ dir });
    const b = await createFsSessionStore({ dir });
    const results = await Promise.allSettled([
      a.create({ jobId: "j-a", agreementHash: "0xraced", now: 1 }),
      b.create({ jobId: "j-b", agreementHash: "0xraced", now: 1 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const aLoad = await a.load("j-a");
    const bLoad = await b.load("j-b");
    const liveIds = [
      ...(aLoad.status === "ok" ? ["j-a"] : []),
      ...(bLoad.status === "ok" ? ["j-b"] : []),
    ];
    expect(liveIds).toHaveLength(1);
    const loser = liveIds[0] === "j-a" ? "j-b" : "j-a";
    expect(
      await a.bindHash({
        hash: "0xraced",
        jobId: loser,
        kind: "agreement",
      }),
    ).toEqual({ ok: false, boundTo: liveIds[0] });
  });

  test("a binding bound to a LIVE session is never reclaimed", async () => {
    await store.create({ jobId: "j1", agreementHash: "0xheld" });
    await expect(store.create({ jobId: "j2", agreementHash: "0xheld" })).rejects.toThrow(
      /already bound to session j1/,
    );
  });

  test("a failed duplicate create does not leak its hash reservation", async () => {
    await store.create({ jobId: "j1" });
    // Duplicate jobId with a FRESH hash: the create must fail without leaving
    // 0xfresh permanently bound to the never-created duplicate.
    await expect(store.create({ jobId: "j1", agreementHash: "0xfresh" })).rejects.toThrow(
      /already exists/,
    );
    await store.create({ jobId: "j2", agreementHash: "0xfresh" }); // reservation was released
    const bound = await store.bindHash({ hash: "0xfresh", jobId: "j2", kind: "agreement" });
    expect(bound).toEqual({ ok: true, boundTo: "j2" });
  });

  test("acquireLease rejects a non-positive ttl instead of minting a dead lease", async () => {
    await store.create({ jobId: "j1" });
    await expect(store.acquireLease({ jobId: "j1", owner: "A", ttlMs: 0 })).rejects.toThrow(
      /positive/,
    );
    await expect(store.acquireLease({ jobId: "j1", owner: "A", ttlMs: -5 })).rejects.toThrow(
      /positive/,
    );
  });
});
