import { describe, expect, test } from "vitest";

import {
  createInMemorySessionStore,
  SESSION_STORE_VERSION,
  type SessionStore,
} from "../../src/agent/sessionStore.js";

const fresh = (): SessionStore => createInMemorySessionStore();

describe("SessionStore in-memory conformance (#55)", () => {
  test("create + load; load distinguishes missing", async () => {
    const s = fresh();
    const rec = await s.create({ jobId: "j1", agreementHash: "0xagr", now: 100 });
    expect(rec).toMatchObject({ jobId: "j1", phase: "created", revision: 0, storeVersion: SESSION_STORE_VERSION });
    const loaded = await s.load("j1");
    expect(loaded.status).toBe("ok");
    expect(await s.load("nope")).toEqual({ status: "missing" });
  });

  test("create rejects a duplicate jobId", async () => {
    const s = fresh();
    await s.create({ jobId: "j1" });
    await expect(s.create({ jobId: "j1" })).rejects.toThrow(/already exists/);
  });

  test("compare-and-set: two workers cannot both advance the same phase", async () => {
    const s = fresh();
    await s.create({ jobId: "j1", now: 0 });
    // Both read revision 0 and try to advance.
    const a = await s.transition({ jobId: "j1", expectedRevision: 0, phase: "settling", now: 1 });
    const b = await s.transition({ jobId: "j1", expectedRevision: 0, phase: "aborted", now: 1 });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe("revision-mismatch");
    const loaded = await s.load("j1");
    expect(loaded.status === "ok" && loaded.record.phase).toBe("settling"); // A won, B rejected
  });

  test("checkpoint intent→outcome is durable for restart replay", async () => {
    const s = fresh();
    await s.create({ jobId: "j1", now: 0 });
    // Write-ahead intent BEFORE the side effect…
    let r = await s.transition({ jobId: "j1", expectedRevision: 0, checkpoint: { key: "settle:0", stage: "intent", data: { rail: "pay-x402" } }, now: 1 });
    expect(r.ok).toBe(true);
    // …then the outcome AFTER it completes.
    if (r.ok) r = await s.transition({ jobId: "j1", expectedRevision: r.record.revision, checkpoint: { key: "settle:0", stage: "outcome", data: { txHash: "0xpaid" } }, receipt: { kind: "settlement", ref: "0xpaid" }, now: 2 });
    const loaded = await s.load("j1");
    if (loaded.status === "ok") {
      expect(loaded.record.checkpoints.map((c) => c.stage)).toEqual(["intent", "outcome"]);
      expect(loaded.record.receipts).toEqual([{ kind: "settlement", ref: "0xpaid", recordedAt: 2 }]);
    }
  });

  test("receipts are immutable: a different ref for a recorded kind is rejected; same ref is idempotent", async () => {
    const s = fresh();
    await s.create({ jobId: "j1", now: 0 });
    const r1 = await s.transition({ jobId: "j1", expectedRevision: 0, receipt: { kind: "bundle", ref: "0xbundle" }, now: 1 });
    expect(r1.ok).toBe(true);
    const rev = r1.ok ? r1.record.revision : 0;
    // Same ref again → idempotent (no duplicate).
    const same = await s.transition({ jobId: "j1", expectedRevision: rev, receipt: { kind: "bundle", ref: "0xbundle" }, now: 2 });
    expect(same.ok).toBe(true);
    expect(same.ok && same.record.receipts).toHaveLength(1);
    // Different ref for the same kind → rejected.
    const diff = await s.transition({ jobId: "j1", expectedRevision: same.ok ? same.record.revision : 0, receipt: { kind: "bundle", ref: "0xEVIL" }, now: 3 });
    expect(diff.ok).toBe(false);
    if (!diff.ok) expect(diff.reason).toBe("immutable-receipt");
  });

  test("worker lease: only one owner holds it until it expires", async () => {
    const s = fresh();
    await s.create({ jobId: "j1", now: 0 });
    const a = await s.acquireLease({ jobId: "j1", owner: "worker-A", ttlMs: 1000, now: 0 });
    const b = await s.acquireLease({ jobId: "j1", owner: "worker-B", ttlMs: 1000, now: 500 }); // still live
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    // After A's lease expires, B can take it.
    const bLater = await s.acquireLease({ jobId: "j1", owner: "worker-B", ttlMs: 1000, now: 1001 });
    expect(bLater.ok).toBe(true);
    // The same owner re-acquiring (renewal) always succeeds.
    expect((await s.acquireLease({ jobId: "j1", owner: "worker-B", ttlMs: 1000, now: 1500 })).ok).toBe(true);
  });

  test("anti-replay: an agreement/tx hash cannot be reused across sessions", async () => {
    const s = fresh();
    await s.create({ jobId: "j1" });
    await s.create({ jobId: "j2" });
    expect(await s.bindHash({ hash: "0xagr", jobId: "j1", kind: "agreement" })).toEqual({ ok: true, boundTo: "j1" });
    // Same hash, same session → idempotent.
    expect(await s.bindHash({ hash: "0xagr", jobId: "j1", kind: "agreement" })).toEqual({ ok: true, boundTo: "j1" });
    // Same hash, DIFFERENT session → replay, rejected.
    expect(await s.bindHash({ hash: "0xagr", jobId: "j2", kind: "agreement" })).toEqual({ ok: false, boundTo: "j1" });
  });

  test("create binds the agreement hash for anti-replay", async () => {
    const s = fresh();
    await s.create({ jobId: "j1", agreementHash: "0xagr" });
    await s.create({ jobId: "j2" });
    // j2 can't reuse j1's agreement hash.
    expect(await s.bindHash({ hash: "0xagr", jobId: "j2", kind: "agreement" })).toEqual({ ok: false, boundTo: "j1" });
  });

  test("list enumerates sessions for status APIs (newest first, phase filter, limit)", async () => {
    const s = fresh();
    await s.create({ jobId: "j1", phase: "completed", now: 1 });
    await s.create({ jobId: "j2", phase: "settling", now: 2 });
    await s.create({ jobId: "j3", phase: "settling", now: 3 });
    expect((await s.list()).map((r) => r.jobId)).toEqual(["j3", "j2", "j1"]);
    expect((await s.list({ phase: "settling" })).map((r) => r.jobId)).toEqual(["j3", "j2"]);
    expect((await s.list({ limit: 1 })).map((r) => r.jobId)).toEqual(["j3"]);
  });

  test("stored records are isolated: mutating a returned record doesn't corrupt the store", async () => {
    const s = fresh();
    const rec = await s.create({ jobId: "j1" });
    rec.phase = "hacked";
    rec.receipts.push({ kind: "bundle", ref: "0xEVIL" });
    const loaded = await s.load("j1");
    expect(loaded.status === "ok" && loaded.record.phase).toBe("created");
    expect(loaded.status === "ok" && loaded.record.receipts).toEqual([]);
  });
});
