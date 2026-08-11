import { mkdtemp, writeFile, stat, mkdir, readFile, readdir, open, rm, unlink, utimes } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createFsFencedSessionStore } from "../../src/agent/fencedSessionStoreFs.js";
import {
  FENCED_SESSION_STORE_VERSION,
  type FencedSessionStoreV2,
  type SessionPaymentAuthorizationBinding,
} from "../../src/agent/fencedSessionStore.js";

let dir: string;
let store: FencedSessionStoreV2;

function authorizationBinding(
  agreementHash: string,
  discriminator: string,
  paymentPhaseIndex = 0,
): SessionPaymentAuthorizationBinding {
  return {
    authorizationHash: discriminator.repeat(64),
    fulfilmentId: "b".repeat(64),
    handoffBindingHash: "c".repeat(64),
    agreementHash,
    paymentEvidenceHash: "d".repeat(64),
    settlementId: `demos:${discriminator.repeat(64)}`,
    paymentPhaseIndex,
    deliveryPhaseIndex: paymentPhaseIndex + 1,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dacs-sessionstore-"));
  store = await createFsFencedSessionStore({ dir });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("generation-fenced filesystem FencedSessionStoreV2 v2", () => {
  test("advertises the explicit v2 runtime boundary", () => {
    expect(store.apiVersion).toBe(FENCED_SESSION_STORE_VERSION);
  });

  test("core conformance: create + CAS + lease + anti-replay + immutable receipt", async () => {
    await store.create({ jobId: "j1", agreementHash: "0xagr", now: 0 });
    // CAS: two workers at revision 0, one wins.
    const a = await store.transition({ jobId: "j1", expectedRevision: 0, phase: "settling", now: 1 });
    const b = await store.transition({ jobId: "j1", expectedRevision: 0, phase: "aborted", now: 1 });
    expect(a.ok).toBe(true);
    expect(b.ok && "reason" in b ? b : { reason: (b as { reason: string }).reason }).toMatchObject({ reason: "revision-mismatch" });
    // Lease.
    const lease = await store.acquireLease({ jobId: "j1", owner: "A", ttlMs: 1000, now: 2 });
    expect(lease.ok).toBe(true);
    expect((await store.acquireLease({ jobId: "j1", owner: "B", ttlMs: 1000, now: 3 })).ok).toBe(false);
    // Anti-replay: create bound 0xagr to j1; j2 can't reuse it.
    await store.create({ jobId: "j2" });
    expect(await store.bindHash({ hash: "0xagr", jobId: "j2", kind: "agreement" })).toEqual({ ok: false, boundTo: "j1" });
    // Immutable receipt — as the lease owner (A), since the lease is still live.
    const load = await store.load("j1");
    const rev = load.status === "ok" ? load.record.revision : 0;
    const r = await store.transition({
      jobId: "j1",
      expectedRevision: rev,
      ...(lease.ok ? { leaseToken: lease.lease } : {}),
      receipt: { kind: "bundle", ref: "0xb" },
      now: 4,
    });
    expect(r.ok).toBe(true);
    const rev2 = r.ok ? r.record.revision : 0;
    const bad = await store.transition({
      jobId: "j1",
      expectedRevision: rev2,
      ...(lease.ok ? { leaseToken: lease.lease } : {}),
      receipt: { kind: "bundle", ref: "0xEVIL" },
      now: 5,
    });
    expect(bad.ok).toBe(false);
  });

  test("DURABLE across a restart: a fresh store instance on the same dir sees the session", async () => {
    await store.create({ jobId: "j1", phase: "settled", now: 0 });
    await store.transition({ jobId: "j1", expectedRevision: 0, receipt: { kind: "settlement", ref: "0xpaid" }, now: 1 });
    // Simulate a process restart: brand-new store over the same directory.
    const reopened = await createFsFencedSessionStore({ dir });
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

  test("v1 is explicitly readable-but-unsupported rather than silently upgraded", async () => {
    await writeFile(
      join(dir, "sessions", `${encodeURIComponent("legacy")}.json`),
      JSON.stringify({
        storeVersion: 1,
        jobId: "legacy",
        phase: "seller:delivery-pending",
        revision: 1,
        checkpoints: [],
        receipts: [],
        createdAt: 0,
        updatedAt: 0,
      }),
    );
    expect(await store.load("legacy")).toEqual({ status: "unsupported", version: 1 });
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

  test("create accepts an exact agreement marker pre-bound to the same job", async () => {
    expect(await store.bindHash({
      hash: "0xprebound",
      jobId: "j1",
      kind: "agreement",
    })).toEqual({ ok: true, boundTo: "j1" });

    const created = await store.create({
      jobId: "j1",
      agreementHash: "0xprebound",
      now: 0,
    });
    expect(created.agreementHash).toBe("0xprebound");
    expect(await store.load("j1")).toEqual({ status: "ok", record: created });
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

  test("cannot reclassify a transaction marker as an agreement for the same job", async () => {
    expect(await store.bindHash({
      hash: "0xshared-kind",
      jobId: "j1",
      kind: "transaction",
    })).toEqual({ ok: true, boundTo: "j1" });

    await expect(
      store.create({ jobId: "j1", agreementHash: "0xshared-kind" }),
    ).rejects.toThrow(/anti-replay|already bound/);
    expect(await store.load("j1")).toEqual({ status: "missing" });
    expect(await store.bindHash({
      hash: "0xshared-kind",
      jobId: "j1",
      kind: "transaction",
    })).toEqual({ ok: true, boundTo: "j1" });
  });

  test("a leased session cannot admit a pre-existing second agreement marker", async () => {
    await store.bindHash({ hash: "0xagreement-b", jobId: "j1", kind: "agreement" });
    await store.create({ jobId: "j1", agreementHash: "0xagreement-a", now: 0 });
    const lease = await store.acquireLease({
      jobId: "j1",
      owner: "worker",
      ttlMs: 100,
      now: 0,
    });
    expect(lease.ok).toBe(true);
    expect(await store.bindHash({
      hash: "0xagreement-b",
      jobId: "j1",
      kind: "agreement",
    })).toEqual({ ok: false, boundTo: "j1" });
    const loaded = await store.load("j1");
    expect(loaded.status === "ok" && loaded.record.agreementHash).toBe("0xagreement-a");
  });

  test("a fenced session cannot admit its exact pre-existing agreement marker", async () => {
    expect(await store.bindHash({
      hash: "0xagreement-prebound",
      jobId: "j1",
      kind: "agreement",
    })).toEqual({ ok: true, boundTo: "j1" });
    await store.create({ jobId: "j1", now: 0 });
    const lease = await store.acquireLease({
      jobId: "j1",
      owner: "worker",
      ttlMs: 100,
      now: 0,
    });
    expect(lease.ok).toBe(true);

    expect(await store.bindHash({
      hash: "0xagreement-prebound",
      jobId: "j1",
      kind: "agreement",
    })).toEqual({ ok: false, boundTo: "j1" });
    const loaded = await store.load("j1");
    if (loaded.status !== "ok") throw new Error("session missing");
    expect(loaded.record.agreementHash).toBeUndefined();
    expect(loaded.record.leaseGeneration).toBe(1);
  });

  test("v2 runtime guards reject legacy, extra, empty, and explicit-undefined inputs", async () => {
    await store.create({ jobId: "j1", now: 0 });
    await expect(store.transition({
      jobId: "j1",
      expectedRevision: 0,
      owner: "legacy-worker",
      phase: "settling",
    } as never)).rejects.toThrow(/owner.*not a v2 field/);
    await expect(store.transition({
      jobId: "j1",
      expectedRevision: 0,
      lease: { owner: "legacy-worker", expiresAt: 10 },
    } as never)).rejects.toThrow(/accepts only null|v1 lease/);
    await expect(store.transition({
      jobId: "j1",
      expectedRevision: 0,
      checkpoint: { key: "settle:0", stage: "intent", data: undefined },
    } as never)).rejects.toThrow(/data.*omitted/);
    await expect(store.bindHash({ hash: "", jobId: "j1", kind: "agreement" }))
      .rejects.toThrow(/hash.*non-empty/);
    await expect(store.list({ limit: undefined } as never)).rejects.toThrow(/limit.*omitted/);
    await expect(readFile(join(dir, "hashes", ".json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const loaded = await store.load("j1");
    expect(loaded.status === "ok" && loaded.record.revision).toBe(0);
  });

  test("list has deterministic tie ordering and clone-isolated results", async () => {
    await store.create({ jobId: "j-b", phase: "created", now: 7 });
    await store.create({ jobId: "j-a", phase: "created", now: 7 });
    const first = await store.list();
    expect(first.map((record) => record.jobId)).toEqual(["j-a", "j-b"]);
    first[0]!.phase = "mutated";
    first.reverse();
    expect((await store.list()).map((record) => [record.jobId, record.phase])).toEqual([
      ["j-a", "created"],
      ["j-b", "created"],
    ]);
  });

  test("load, reopen, and mutation fail closed on filename/record identity mismatch", async () => {
    await writeFile(
      join(dir, "sessions", `${encodeURIComponent("alias")}.json`),
      JSON.stringify({
        storeVersion: FENCED_SESSION_STORE_VERSION,
        jobId: "actual-owner",
        phase: "created",
        revision: 0,
        leaseGeneration: 0,
        paymentAuthorizations: [],
        checkpoints: [],
        receipts: [],
        createdAt: 0,
        updatedAt: 0,
      }),
    );

    expect((await store.load("alias")).status).toBe("corrupt");
    const reopened = await createFsFencedSessionStore({ dir });
    expect((await reopened.load("alias")).status).toBe("corrupt");
    const mutation = await reopened.transition({
      jobId: "alias",
      expectedRevision: 0,
      phase: "must-not-mutate",
      now: 1,
    });
    expect(mutation).toEqual({ ok: false, reason: "corrupt" });
    expect(await reopened.load("actual-owner")).toEqual({ status: "missing" });
  });

  const opaqueListEntries = [
    {
      name: "an unreadable entry",
      write: async () => {
        await mkdir(join(dir, "sessions", "unreadable.json"));
      },
    },
    {
      name: "an unsupported entry",
      write: async () => {
        await writeFile(
          join(dir, "sessions", "future.json"),
          JSON.stringify({ storeVersion: 999, jobId: "future" }),
        );
      },
    },
    {
      name: "an invalid-shape entry",
      write: async () => {
        await writeFile(
          join(dir, "sessions", "invalid.json"),
          JSON.stringify({
            storeVersion: FENCED_SESSION_STORE_VERSION,
            jobId: "invalid",
            phase: "created",
            revision: "bad",
            leaseGeneration: 0,
            paymentAuthorizations: [],
            checkpoints: [],
            receipts: [],
            createdAt: 0,
            updatedAt: 0,
          }),
        );
      },
    },
    {
      name: "a filename/record-misbound entry",
      write: async () => {
        await writeFile(
          join(dir, "sessions", "alias.json"),
          JSON.stringify({
            storeVersion: FENCED_SESSION_STORE_VERSION,
            jobId: "actual-owner",
            phase: "created",
            revision: 0,
            leaseGeneration: 0,
            paymentAuthorizations: [],
            checkpoints: [],
            receipts: [],
            createdAt: 0,
            updatedAt: 0,
          }),
        );
      },
    },
  ] as const;

  for (const opaque of opaqueListEntries) {
    test(`list fails closed on ${opaque.name}`, async () => {
      await store.create({ jobId: "valid", now: 0 });
      await opaque.write();
      await expect(store.list()).rejects.toThrow(/session file/);
    });
  }

  test("load fails CLOSED: a field of the wrong type is `corrupt`, not `ok` (#67)", async () => {
    await store.create({ jobId: "j1", now: 0 });
    // Valid JSON + right storeVersion, but revision is a string → tampered/partial.
    await writeFile(
      join(dir, "sessions", `${encodeURIComponent("j1")}.json`),
      JSON.stringify({ storeVersion: FENCED_SESSION_STORE_VERSION, jobId: "j1", phase: "created", revision: "NaN", leaseGeneration: 0, paymentAuthorizations: [], checkpoints: [], receipts: [], createdAt: 0, updatedAt: 0 }),
    );
    expect((await store.load("j1")).status).toBe("corrupt");
  });

  test("load validates nested checkpoint, receipt, and lease entries before returning `ok`", async () => {
    const path = join(dir, "sessions", `${encodeURIComponent("j1")}.json`);
    const valid = {
      storeVersion: FENCED_SESSION_STORE_VERSION,
      jobId: "j1",
      phase: "created",
      revision: 0,
      leaseGeneration: 0,
      paymentAuthorizations: [],
      checkpoints: [],
      receipts: [],
      createdAt: 0,
      updatedAt: 0,
    };
    for (const malformed of [
      { ...valid, apiKey: "opaque-string-that-must-not-be-an-unknown-v2-field" },
      { ...valid, checkpoints: [null] },
      { ...valid, checkpoints: [{ key: "settle:0", stage: "unknown" }] },
      {
        ...valid,
        checkpoints: [{ key: "settle:0", stage: "intent", credential: "unexpected" }],
      },
      { ...valid, receipts: [{ kind: "settlement", ref: 42 }] },
      { ...valid, leaseGeneration: 1, lease: { owner: "worker", generation: 1, expiresAt: "tomorrow" } },
      { ...valid, leaseGeneration: 1, lease: { owner: "worker", generation: 1, expiresAt: 10, token: "unexpected" } },
    ]) {
      await writeFile(path, JSON.stringify(malformed));
      expect((await store.load("j1")).status).toBe("corrupt");
    }
  });

  test("a stale lock left by a crashed holder is reclaimed, not blocked forever (#67)", async () => {
    const staleStore = await createFsFencedSessionStore({ dir, lockStaleMs: 50 });
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

  test("a crash-abandoned reclamation gate is quarantined and recovered", async () => {
    const staleStore = await createFsFencedSessionStore({ dir, lockStaleMs: 1 });
    await staleStore.create({ jobId: "j1", now: 0 });
    const lp = join(dir, "locks", `${encodeURIComponent("j1")}.lock`);
    const rp = join(dir, "locks", `${encodeURIComponent("j1")}.reclaim`);
    const crashed = spawn(process.execPath, ["-e", ""]);
    if (crashed.pid === undefined) throw new Error("crashed worker pid missing");
    const deadPid = crashed.pid;
    await new Promise<void>((resolve, reject) => {
      crashed.once("error", reject);
      crashed.once("close", () => resolve());
    });
    await (await open(lp, "wx")).close();
    await writeFile(
      rp,
      JSON.stringify({ pid: deadPid, token: "dead-reclaimer" }),
      { flag: "wx" },
    );
    const old = new Date(Date.now() - 60_000);
    await utimes(lp, old, old);
    await utimes(rp, old, old);

    const result = await staleStore.transition({
      jobId: "j1",
      expectedRevision: 0,
      phase: "settling",
      now: 1,
    });
    expect(result.ok).toBe(true);
    expect(await readdir(join(dir, "locks"))).toEqual([]);
  });

  test("reclamation quarantine namespaces are isolated for prefix-colliding job ids", async () => {
    await store.create({ jobId: "a", now: 0 });
    const otherJobId = "a.reclaim.foo";
    const encodedOther = encodeURIComponent(otherJobId);
    await writeFile(
      join(
        dir,
        "locks",
        `reclaim-${encodedOther.length}-${encodedOther}.live.quarantine`,
      ),
      JSON.stringify({ pid: process.pid, token: "other-job-live-reclaimer" }),
    );

    const result = await store.transition({
      jobId: "a",
      expectedRevision: 0,
      phase: "settling",
      now: 1,
    });
    expect(result.ok).toBe(true);
  });

  test("concurrent stale-lock reclaimers cannot delete the replacement holder", async () => {
    const staleStore = await createFsFencedSessionStore({ dir, lockStaleMs: 1 });
    await staleStore.create({ jobId: "j1", now: 0 });
    const lp = join(dir, "locks", `${encodeURIComponent("j1")}.lock`);
    await (await open(lp, "wx")).close();
    const old = new Date(Date.now() - 60_000);
    await utimes(lp, old, old);
    const contenders = await Promise.all(
      Array.from({ length: 16 }, () =>
        createFsFencedSessionStore({ dir, lockStaleMs: 1 }),
      ),
    );

    const results = await Promise.all(
      contenders.map((contender, index) => contender.transition({
        jobId: "j1",
        expectedRevision: 0,
        phase: `contender-${index}`,
        now: 1,
      })),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const loaded = await staleStore.load("j1");
    if (loaded.status !== "ok") throw new Error("session missing");
    expect(loaded.record.revision).toBe(1);
  });

  test("lock age alone cannot evict a live writer", async () => {
    const guardedStore = await createFsFencedSessionStore({ dir, lockStaleMs: 1 });
    await guardedStore.create({ jobId: "j1", now: 0 });
    const lp = join(dir, "locks", `${encodeURIComponent("j1")}.lock`);
    await writeFile(
      lp,
      JSON.stringify({ pid: process.pid, token: "live-owner-token" }),
      { flag: "wx" },
    );
    const old = new Date(Date.now() - 60_000);
    await utimes(lp, old, old);
    try {
      await expect(
        guardedStore.transition({
          jobId: "j1",
          expectedRevision: 0,
          phase: "must-not-overwrite-live-owner",
          now: 1,
        }),
      ).rejects.toThrow(/lock is contended/);
    } finally {
      await unlink(lp).catch(() => {});
    }
    const loaded = await guardedStore.load("j1");
    expect(loaded.status === "ok" && loaded.record.phase).toBe("created");
  }, 10_000);

  test("a non-positive or non-finite stale-lock window is rejected", async () => {
    await expect(createFsFencedSessionStore({ dir, lockStaleMs: 0 })).rejects.toThrow(
      /lockStaleMs must be a positive finite number/,
    );
    await expect(
      createFsFencedSessionStore({ dir, lockStaleMs: Number.NaN }),
    ).rejects.toThrow(/lockStaleMs must be a positive finite number/);
  });

  test("checkpoint payload is primitive-only: nested and lossy numeric values are rejected", async () => {
    await store.create({ jobId: "j1", now: 0 });
    await expect(
      store.transition({
        jobId: "j1",
        expectedRevision: 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        checkpoint: { key: "settle:0", stage: "intent", data: { secret: { apiKey: "sk-live" } } as any },
        now: 1,
      }),
    ).rejects.toThrow(/checkpoint\.data|string.*finite number/);
    await expect(
      store.transition({
        jobId: "j1",
        expectedRevision: 0,
        checkpoint: { key: "settle:0", stage: "intent", data: { blockNumber: Number.NaN } },
        now: 1,
      }),
    ).rejects.toThrow(/finite number/);
  });

  test("checkpoint claim rejects negative zero before JSON persistence can change it", async () => {
    await store.create({ jobId: "j1", now: 0 });

    await expect(store.claimCheckpoint({
      jobId: "j1",
      key: "delivery:negative-zero",
      data: { signedZero: -0 },
      now: 1,
    })).rejects.toThrow(/finite number/);

    const loaded = await store.load("j1");
    if (loaded.status !== "ok") throw new Error("session missing");
    expect(loaded.record.revision).toBe(0);
    expect(loaded.record.checkpoints).toEqual([]);
    const reopened = await createFsFencedSessionStore({ dir });
    const durable = await reopened.load("j1");
    if (durable.status !== "ok") throw new Error("reopened session missing");
    expect(durable.record.revision).toBe(0);
    expect(durable.record.checkpoints).toEqual([]);
  });

  test("negative-zero timestamps are rejected before create, lease, or receipt persistence", async () => {
    await expect(store.create({
      jobId: "bad-created-at",
      now: -0,
    })).rejects.toThrow(/non-negative safe integer/);
    expect(await store.load("bad-created-at")).toEqual({ status: "missing" });

    const initial = await store.create({ jobId: "j1", now: 0 });
    await expect(store.acquireLease({
      jobId: "j1",
      owner: "worker",
      ttlMs: 100,
      now: -0,
    })).rejects.toThrow(/non-negative safe integer/);
    await expect(store.transition({
      jobId: "j1",
      expectedRevision: 0,
      receipt: {
        kind: "settlement",
        ref: "0xmust-not-persist",
        recordedAt: -0,
      },
      now: 1,
    })).rejects.toThrow(/finite number/);

    expect(await store.load("j1")).toEqual({ status: "ok", record: initial });
    const reopened = await createFsFencedSessionStore({ dir });
    expect(await reopened.load("j1")).toEqual({ status: "ok", record: initial });
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

  test("canonical settlement binding is cross-process unique and agreement is set-once", async () => {
    const other = await createFsFencedSessionStore({ dir });
    await store.create({ jobId: "j1" });
    await other.create({ jobId: "j2" });
    const lease1 = await store.acquireLease({ jobId: "j1", owner: "A", ttlMs: 1000 });
    const lease2 = await other.acquireLease({ jobId: "j2", owner: "B", ttlMs: 1000 });
    if (!lease1.ok || !lease2.ok) throw new Error("leases missing");
    const settlementId = `evm:8453:${"a".repeat(64)}:0`;
    const [left, right] = await Promise.all([
      store.bindSessionAuthorization({
        jobId: "j1",
        leaseToken: lease1.lease,
        binding: {
          authorizationHash: "3".repeat(64),
          fulfilmentId: "4".repeat(64),
          handoffBindingHash: "5".repeat(64),
          agreementHash: "b".repeat(64),
          paymentEvidenceHash: "c".repeat(64),
          settlementId,
          paymentPhaseIndex: 0,
          deliveryPhaseIndex: 1,
        },
      }),
      other.bindSessionAuthorization({
        jobId: "j2",
        leaseToken: lease2.lease,
        binding: {
          authorizationHash: "6".repeat(64),
          fulfilmentId: "7".repeat(64),
          handoffBindingHash: "8".repeat(64),
          agreementHash: "d".repeat(64),
          paymentEvidenceHash: "e".repeat(64),
          settlementId,
          paymentPhaseIndex: 2,
          deliveryPhaseIndex: 3,
        },
      }),
    ]);
    expect([left, right].filter((result) => result.ok)).toHaveLength(1);
    const loser = left.ok
      ? { store: other, jobId: "j2", lease: lease2.lease, agreementHash: "d".repeat(64) }
      : { store, jobId: "j1", lease: lease1.lease, agreementHash: "b".repeat(64) };
    const changedAgreement = await loser.store.bindSessionAuthorization({
      jobId: loser.jobId,
      leaseToken: loser.lease,
      binding: {
        authorizationHash: "3".repeat(64),
        fulfilmentId: "4".repeat(64),
        handoffBindingHash: "5".repeat(64),
        agreementHash: "f".repeat(64),
        paymentEvidenceHash: "1".repeat(64),
        settlementId: `evm:8453:${"2".repeat(64)}:0`,
        paymentPhaseIndex: 4,
        deliveryPhaseIndex: 5,
      },
    });
    expect(changedAgreement.ok).toBe(false);
    if (!changedAgreement.ok) expect(changedAgreement.reason).toBe("agreement-conflict");
    const loaded = await loser.store.load(loser.jobId);
    expect(loaded.status === "ok" && loaded.record.agreementHash).toBe(
      loser.agreementHash,
    );
  });

  test("snapshots the full authorization before waiting on a contended process lock", async () => {
    await store.create({ jobId: "j1" });
    const lease = await store.acquireLease({ jobId: "j1", owner: "A", ttlMs: 1000 });
    if (!lease.ok) throw new Error("lease missing");
    const lock = join(dir, "locks", "j1.lock");
    await writeFile(lock, JSON.stringify({ pid: process.pid, token: "test-lock" }));
    const binding = {
      authorizationHash: "1".repeat(64),
      fulfilmentId: "2".repeat(64),
      handoffBindingHash: "3".repeat(64),
      agreementHash: "4".repeat(64),
      paymentEvidenceHash: "5".repeat(64),
      settlementId: `demos:${"6".repeat(64)}`,
      paymentPhaseIndex: 0,
      deliveryPhaseIndex: 1,
    };
    const pending = store.bindSessionAuthorization({
      jobId: "j1",
      binding,
      leaseToken: lease.lease,
      now: 1,
    });
    binding.authorizationHash = "f".repeat(64);
    binding.deliveryPhaseIndex = 99;
    await unlink(lock);
    expect((await pending).ok).toBe(true);
    const loaded = await store.load("j1");
    if (loaded.status !== "ok") throw new Error("session missing");
    expect(loaded.record.paymentAuthorizations[0]).toMatchObject({
      authorizationHash: "1".repeat(64),
      deliveryPhaseIndex: 1,
    });
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

  test("expired filesystem lease generations fence stale and omitted-token writers", async () => {
    await store.create({ jobId: "j1", now: 0 });
    const first = await store.acquireLease({ jobId: "j1", owner: "A", ttlMs: 10, now: 0 });
    const second = await store.acquireLease({ jobId: "j1", owner: "B", ttlMs: 10, now: 11 });
    expect(first.ok && first.lease.generation).toBe(1);
    expect(second.ok && second.lease.generation).toBe(2);
    if (!first.ok || !second.ok) return;
    const released = await store.transition({
      jobId: "j1",
      expectedRevision: second.record.revision,
      leaseToken: second.lease,
      phase: "delivery-recovery",
      lease: null,
      now: 12,
    });
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    const stale = await store.transition({
      jobId: "j1",
      expectedRevision: released.record.revision,
      leaseToken: first.lease,
      phase: "evidence-recovery",
      now: 13,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe("lease-fenced");
    const omitted = await store.claimCheckpoint({
      jobId: "j1",
      key: "seller:evidence-anchor:1",
      now: 13,
    });
    expect(omitted.ok).toBe(false);
    if (!omitted.ok) expect(omitted.reason).toBe("lease-fenced");
    expect(
      await store.bindHash({
        hash: "transaction-after-release",
        jobId: "j1",
        kind: "transaction",
      }),
    ).toEqual({ ok: false, boundTo: "j1" });
  });

  test("persists monotonic seller phase scope across a store restart", async () => {
    await store.create({ jobId: "j1", now: 0 });
    const first = await store.acquireLease({
      jobId: "j1",
      owner: "A",
      ttlMs: 100,
      sellerPhaseIndex: 1,
      now: 0,
    });
    if (!first.ok) throw new Error("first scoped lease missing");
    const completed = await store.transition({
      jobId: "j1",
      expectedRevision: first.record.revision,
      leaseToken: first.lease,
      phase: "seller:delivery-completed:1",
      lease: null,
      now: 1,
    });
    if (!completed.ok) throw new Error("completion transition failed");
    const reopened = await createFsFencedSessionStore({ dir });
    const same = await reopened.acquireLease({
      jobId: "j1",
      owner: "B",
      ttlMs: 100,
      sellerPhaseIndex: 1,
      now: 2,
    });
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.reason).toBe("phase-regression");
    const later = await reopened.acquireLease({
      jobId: "j1",
      owner: "B",
      ttlMs: 100,
      sellerPhaseIndex: 3,
      now: 2,
    });
    expect(later.ok && later.lease.sellerPhaseIndex).toBe(3);
  });
});

describe("crash-window hardening (#67 round 3)", () => {
  test("create fails closed when a corrupt session entry obscures agreement ownership", async () => {
    const agreementHash = "a".repeat(64);
    await writeFile(join(dir, "sessions", "corrupt-owner.json"), "{ not json");

    await expect(store.create({
      jobId: "challenger",
      agreementHash,
      now: 0,
    })).rejects.toThrow(/cannot be safely inspected for agreement ownership/);

    expect(await store.load("challenger")).toEqual({ status: "missing" });
    await expect(readFile(
      join(dir, "hashes", `${encodeURIComponent(agreementHash)}.json`),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("authorization binding fails closed when corrupt session residue obscures ownership", async () => {
    const agreementHash = "a".repeat(64);
    await store.create({ jobId: "challenger", now: 0 });
    const lease = await store.acquireLease({
      jobId: "challenger",
      owner: "worker",
      ttlMs: 100,
      now: 0,
    });
    if (!lease.ok) throw new Error("challenger lease missing");
    await writeFile(join(dir, "sessions", "corrupt-owner.json"), "{ not json");

    await expect(store.bindSessionAuthorization({
      jobId: "challenger",
      binding: authorizationBinding(agreementHash, "1"),
      leaseToken: lease.lease,
      now: 1,
    })).rejects.toThrow(/cannot be safely inspected for agreement ownership/);

    const challenger = await store.load("challenger");
    if (challenger.status !== "ok") throw new Error("challenger session missing");
    expect(challenger.record.agreementHash).toBeUndefined();
    expect(challenger.record.paymentAuthorizations).toEqual([]);
    await expect(readFile(
      join(dir, "hashes", `${encodeURIComponent(agreementHash)}.json`),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("create fails closed when a session entry cannot be read", async () => {
    const agreementHash = "a".repeat(64);
    await mkdir(join(dir, "sessions", "unreadable-owner.json"));

    await expect(store.create({
      jobId: "challenger",
      agreementHash,
      now: 0,
    })).rejects.toThrow(/cannot be safely inspected for agreement ownership/);

    expect(await store.load("challenger")).toEqual({ status: "missing" });
    await expect(readFile(
      join(dir, "hashes", `${encodeURIComponent(agreementHash)}.json`),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  const ownershipOpaqueEntries = [
    {
      name: "an empty object",
      file: "empty-owner.json",
      value: {},
    },
    {
      name: "a malformed v2 record",
      file: "bad-v2-owner.json",
      value: {
        storeVersion: FENCED_SESSION_STORE_VERSION,
        jobId: "bad-v2-owner",
        phase: "created",
        revision: "not-a-revision",
        leaseGeneration: 0,
        paymentAuthorizations: [],
        checkpoints: [],
        receipts: [],
        createdAt: 0,
        updatedAt: 0,
      },
    },
    {
      name: "a future-version record",
      file: "future-owner.json",
      value: {
        storeVersion: FENCED_SESSION_STORE_VERSION + 1,
        jobId: "future-owner",
      },
    },
  ] as const;

  for (const opaque of ownershipOpaqueEntries) {
    test(`create fails closed when ${opaque.name} obscures ownership`, async () => {
      const agreementHash = "a".repeat(64);
      await writeFile(
        join(dir, "sessions", opaque.file),
        JSON.stringify(opaque.value),
      );

      await expect(store.create({
        jobId: "challenger",
        agreementHash,
        now: 0,
      })).rejects.toThrow(/ownership cannot be safely inspected/);

      expect(await store.load("challenger")).toEqual({ status: "missing" });
      await expect(readFile(
        join(dir, "hashes", `${encodeURIComponent(agreementHash)}.json`),
        "utf8",
      )).rejects.toMatchObject({ code: "ENOENT" });
    });

    test(`authorization binding fails closed when ${opaque.name} obscures ownership`, async () => {
      const agreementHash = "a".repeat(64);
      await store.create({ jobId: "challenger", now: 0 });
      const lease = await store.acquireLease({
        jobId: "challenger",
        owner: "worker",
        ttlMs: 100,
        now: 0,
      });
      if (!lease.ok) throw new Error("challenger lease missing");
      await writeFile(
        join(dir, "sessions", opaque.file),
        JSON.stringify(opaque.value),
      );

      await expect(store.bindSessionAuthorization({
        jobId: "challenger",
        binding: authorizationBinding(agreementHash, "1"),
        leaseToken: lease.lease,
        now: 1,
      })).rejects.toThrow(/ownership cannot be safely inspected/);

      const challenger = await store.load("challenger");
      if (challenger.status !== "ok") throw new Error("challenger session missing");
      expect(challenger.record.agreementHash).toBeUndefined();
      expect(challenger.record.paymentAuthorizations).toEqual([]);
      await expect(readFile(
        join(dir, "hashes", `${encodeURIComponent(agreementHash)}.json`),
        "utf8",
      )).rejects.toMatchObject({ code: "ENOENT" });
    });
  }

  test("the atomic agreement marker wins over conflicting session-first residue", async () => {
    const agreementHash = "a".repeat(64);
    const markerWinner = "marker-winner";
    await store.create({ jobId: markerWinner, now: 0 });
    const lease = await store.acquireLease({
      jobId: markerWinner,
      owner: "worker",
      ttlMs: 100,
      now: 0,
    });
    if (!lease.ok) throw new Error("marker winner lease missing");
    await writeFile(
      join(dir, "sessions", `${encodeURIComponent("residue-owner")}.json`),
      JSON.stringify({
        storeVersion: FENCED_SESSION_STORE_VERSION,
        jobId: "residue-owner",
        agreementHash,
        phase: "created",
        revision: 0,
        leaseGeneration: 0,
        paymentAuthorizations: [],
        checkpoints: [],
        receipts: [],
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    await writeFile(
      join(dir, "hashes", `${encodeURIComponent(agreementHash)}.json`),
      JSON.stringify({ jobId: markerWinner, kind: "agreement" }),
      { flag: "wx" },
    );
    const binding = authorizationBinding(agreementHash, "1");

    const first = await store.bindSessionAuthorization({
      jobId: markerWinner,
      binding,
      leaseToken: lease.lease,
      now: 1,
    });
    expect(first.ok).toBe(true);
    const retry = await store.bindSessionAuthorization({
      jobId: markerWinner,
      binding,
      leaseToken: lease.lease,
      now: 2,
    });
    expect(retry.ok).toBe(true);
    expect(await store.bindHash({
      hash: agreementHash,
      jobId: "residue-owner",
      kind: "agreement",
    })).toEqual({ ok: false, boundTo: markerWinner });
    await expect(store.create({
      jobId: "outsider",
      agreementHash,
      now: 3,
    })).rejects.toThrow(/already bound to session marker-winner/);
  });

  test("a lost settlement marker is repaired from the original session and cannot be stolen", async () => {
    const firstAgreement = "a".repeat(64);
    const secondAgreement = "e".repeat(64);
    await store.create({ jobId: "first", now: 0 });
    await store.create({ jobId: "second", now: 0 });
    const firstLease = await store.acquireLease({
      jobId: "first",
      owner: "worker-first",
      ttlMs: 100,
      now: 0,
    });
    const secondLease = await store.acquireLease({
      jobId: "second",
      owner: "worker-second",
      ttlMs: 100,
      now: 0,
    });
    if (!firstLease.ok || !secondLease.ok) throw new Error("leases missing");
    const original = authorizationBinding(firstAgreement, "1");
    expect((await store.bindSessionAuthorization({
      jobId: "first",
      binding: original,
      leaseToken: firstLease.lease,
      now: 1,
    })).ok).toBe(true);
    const settlementMarker = join(
      dir,
      "settlements",
      `${encodeURIComponent(original.settlementId)}.json`,
    );
    await unlink(settlementMarker);

    const replay = {
      ...authorizationBinding(secondAgreement, "2"),
      settlementId: original.settlementId,
    };
    const stolen = await store.bindSessionAuthorization({
      jobId: "second",
      binding: replay,
      leaseToken: secondLease.lease,
      now: 2,
    });
    expect(stolen).toMatchObject({
      ok: false,
      reason: "settlement-replay",
      boundTo: "first",
    });
    const second = await store.load("second");
    if (second.status !== "ok") throw new Error("second session missing");
    expect(second.record.paymentAuthorizations).toEqual([]);
    expect(JSON.parse(await readFile(settlementMarker, "utf8"))).toEqual({
      jobId: "first",
      binding: original,
    });

    await unlink(settlementMarker);
    const repaired = await store.bindSessionAuthorization({
      jobId: "first",
      binding: original,
      leaseToken: firstLease.lease,
      now: 3,
    });
    expect(repaired.ok).toBe(true);
    expect(JSON.parse(await readFile(settlementMarker, "utf8"))).toEqual({
      jobId: "first",
      binding: original,
    });
  });

  for (const opaque of [
    {
      name: "corrupt session JSON",
      file: "corrupt-settlement-owner.json",
      value: "{ not json",
    },
    {
      name: "an unsupported session version",
      file: "future-settlement-owner.json",
      value: JSON.stringify({ storeVersion: 999, jobId: "future-settlement-owner" }),
    },
  ]) {
    test(`settlement recovery fails closed on ${opaque.name}`, async () => {
      const agreementHash = "a".repeat(64);
      const binding = authorizationBinding(agreementHash, "1");
      await store.create({ jobId: "challenger", now: 0 });
      expect(await store.bindHash({
        hash: agreementHash,
        jobId: "challenger",
        kind: "agreement",
      })).toEqual({ ok: true, boundTo: "challenger" });
      const lease = await store.acquireLease({
        jobId: "challenger",
        owner: "worker",
        ttlMs: 100,
        now: 0,
      });
      if (!lease.ok) throw new Error("challenger lease missing");
      await writeFile(join(dir, "sessions", opaque.file), opaque.value);

      await expect(store.bindSessionAuthorization({
        jobId: "challenger",
        binding,
        leaseToken: lease.lease,
        now: 1,
      })).rejects.toThrow(/ownership cannot be safely inspected|cannot be safely inspected/);

      const challenger = await store.load("challenger");
      if (challenger.status !== "ok") throw new Error("challenger session missing");
      expect(challenger.record.paymentAuthorizations).toEqual([]);
      await expect(readFile(
        join(dir, "settlements", `${encodeURIComponent(binding.settlementId)}.json`),
        "utf8",
      )).rejects.toMatchObject({ code: "ENOENT" });
    });
  }

  test("authorization binding recovers a v1 agreement residue before rejecting the contender", async () => {
    const agreementHash = "a".repeat(64);
    await store.create({ jobId: "challenger", now: 0 });
    const lease = await store.acquireLease({
      jobId: "challenger",
      owner: "worker",
      ttlMs: 100,
      now: 0,
    });
    if (!lease.ok) throw new Error("challenger lease missing");
    await writeFile(
      join(dir, "sessions", `${encodeURIComponent("legacy-owner")}.json`),
      JSON.stringify({
        storeVersion: 1,
        jobId: "legacy-owner",
        agreementHash,
        phase: "settling",
        revision: 3,
        checkpoints: [],
        receipts: [],
        createdAt: 1,
        updatedAt: 2,
      }),
    );

    const result = await store.bindSessionAuthorization({
      jobId: "challenger",
      binding: authorizationBinding(agreementHash, "1"),
      leaseToken: lease.lease,
      now: 1,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "agreement-conflict",
      boundTo: "legacy-owner",
    });
    const challenger = await store.load("challenger");
    if (challenger.status !== "ok") throw new Error("challenger session missing");
    expect(challenger.record.agreementHash).toBeUndefined();
    expect(challenger.record.paymentAuthorizations).toEqual([]);
    const marker = JSON.parse(await readFile(
      join(dir, "hashes", `${encodeURIComponent(agreementHash)}.json`),
      "utf8",
    )) as unknown;
    expect(marker).toEqual({ jobId: "legacy-owner", kind: "agreement" });
  });

  test("authorization binding recovers a v2 agreement residue before rejecting the contender", async () => {
    const agreementHash = "a".repeat(64);
    await store.create({ jobId: "challenger", now: 0 });
    const lease = await store.acquireLease({
      jobId: "challenger",
      owner: "worker",
      ttlMs: 100,
      now: 0,
    });
    if (!lease.ok) throw new Error("challenger lease missing");
    await writeFile(
      join(dir, "sessions", `${encodeURIComponent("v2-owner")}.json`),
      JSON.stringify({
        storeVersion: FENCED_SESSION_STORE_VERSION,
        jobId: "v2-owner",
        agreementHash,
        phase: "created",
        revision: 0,
        leaseGeneration: 0,
        paymentAuthorizations: [],
        checkpoints: [],
        receipts: [],
        createdAt: 1,
        updatedAt: 1,
      }),
    );

    const result = await store.bindSessionAuthorization({
      jobId: "challenger",
      binding: authorizationBinding(agreementHash, "1"),
      leaseToken: lease.lease,
      now: 1,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "agreement-conflict",
      boundTo: "v2-owner",
    });
    const owner = await store.load("v2-owner");
    expect(owner.status === "ok" && owner.record.agreementHash).toBe(agreementHash);
    const challenger = await store.load("challenger");
    if (challenger.status !== "ok") throw new Error("challenger session missing");
    expect(challenger.record.agreementHash).toBeUndefined();
    expect(challenger.record.paymentAuthorizations).toEqual([]);
  });

  test("concurrent authorization contenders converge on the pre-existing residue owner", async () => {
    const agreementHash = "a".repeat(64);
    const other = await createFsFencedSessionStore({ dir });
    await store.create({ jobId: "challenger-a", now: 0 });
    await other.create({ jobId: "challenger-b", now: 0 });
    const leaseA = await store.acquireLease({
      jobId: "challenger-a",
      owner: "worker-a",
      ttlMs: 100,
      now: 0,
    });
    const leaseB = await other.acquireLease({
      jobId: "challenger-b",
      owner: "worker-b",
      ttlMs: 100,
      now: 0,
    });
    if (!leaseA.ok || !leaseB.ok) throw new Error("contender lease missing");
    await writeFile(
      join(dir, "sessions", `${encodeURIComponent("residue-owner")}.json`),
      JSON.stringify({
        storeVersion: FENCED_SESSION_STORE_VERSION,
        jobId: "residue-owner",
        agreementHash,
        phase: "created",
        revision: 0,
        leaseGeneration: 0,
        paymentAuthorizations: [],
        checkpoints: [],
        receipts: [],
        createdAt: 1,
        updatedAt: 1,
      }),
    );

    const results = await Promise.all([
      store.bindSessionAuthorization({
        jobId: "challenger-a",
        binding: authorizationBinding(agreementHash, "1", 0),
        leaseToken: leaseA.lease,
        now: 1,
      }),
      other.bindSessionAuthorization({
        jobId: "challenger-b",
        binding: authorizationBinding(agreementHash, "2", 2),
        leaseToken: leaseB.lease,
        now: 1,
      }),
    ]);
    expect(results).toEqual([
      expect.objectContaining({
        ok: false,
        reason: "agreement-conflict",
        boundTo: "residue-owner",
      }),
      expect.objectContaining({
        ok: false,
        reason: "agreement-conflict",
        boundTo: "residue-owner",
      }),
    ]);
    const marker = JSON.parse(await readFile(
      join(dir, "hashes", `${encodeURIComponent(agreementHash)}.json`),
      "utf8",
    )) as unknown;
    expect(marker).toEqual({ jobId: "residue-owner", kind: "agreement" });
  });

  test("a v1 session-first crash residue keeps agreement ownership without upgrade", async () => {
    await writeFile(
      join(dir, "sessions", `${encodeURIComponent("legacy-owner")}.json`),
      JSON.stringify({
        storeVersion: 1,
        jobId: "legacy-owner",
        agreementHash: "0xlegacy-owned",
        phase: "settling",
        revision: 3,
        checkpoints: [],
        receipts: [],
        createdAt: 1,
        updatedAt: 2,
      }),
    );

    await expect(store.create({
      jobId: "v2-thief",
      agreementHash: "0xlegacy-owned",
      now: 3,
    })).rejects.toThrow(/already bound to session legacy-owner/);
    expect(await store.load("legacy-owner")).toEqual({
      status: "unsupported",
      version: 1,
    });
    expect(await store.load("v2-thief")).toEqual({ status: "missing" });
    const marker = JSON.parse(await readFile(
      join(dir, "hashes", `${encodeURIComponent("0xlegacy-owned")}.json`),
      "utf8",
    )) as unknown;
    expect(marker).toEqual({ jobId: "legacy-owner", kind: "agreement" });
  });

  test("a session persisted before its hash commit is recovered, never stolen", async () => {
    const first = await createFsFencedSessionStore({ dir });
    const second = await createFsFencedSessionStore({ dir });
    // Simulate creator A paused/crashed in the new protocol's only open window:
    // its complete session is durable, but the hash commit has not happened yet.
    await writeFile(
      join(dir, "sessions", encodeURIComponent("j-first") + ".json"),
      JSON.stringify({
        storeVersion: FENCED_SESSION_STORE_VERSION,
        jobId: "j-first",
        agreementHash: "0xshared",
        phase: "created",
        revision: 0,
        leaseGeneration: 0,
        paymentAuthorizations: [],
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

  test("public agreement bindHash repairs a lost marker and cannot steal session ownership", async () => {
    const agreementHash = "0xlost-agreement-marker";
    await store.create({ jobId: "first", agreementHash, now: 0 });
    const marker = join(
      dir,
      "hashes",
      `${encodeURIComponent(agreementHash)}.json`,
    );
    await unlink(marker);

    expect(await store.bindHash({
      hash: agreementHash,
      jobId: "thief",
      kind: "agreement",
    })).toEqual({ ok: false, boundTo: "first" });
    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({
      jobId: "first",
      kind: "agreement",
    });

    await unlink(marker);
    expect(await store.bindHash({
      hash: agreementHash,
      jobId: "first",
      kind: "agreement",
    })).toEqual({ ok: true, boundTo: "first" });
    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({
      jobId: "first",
      kind: "agreement",
    });
  });

  test("agreement recovery fails closed when current and another session both claim it", async () => {
    const agreementHash = "0xconflicting-residue";
    await store.create({ jobId: "current", agreementHash, now: 0 });
    await unlink(join(
      dir,
      "hashes",
      `${encodeURIComponent(agreementHash)}.json`,
    ));
    await writeFile(
      join(dir, "sessions", `${encodeURIComponent("other")}.json`),
      JSON.stringify({
        storeVersion: FENCED_SESSION_STORE_VERSION,
        jobId: "other",
        agreementHash,
        phase: "created",
        revision: 0,
        leaseGeneration: 0,
        paymentAuthorizations: [],
        checkpoints: [],
        receipts: [],
        createdAt: 1,
        updatedAt: 1,
      }),
    );

    await expect(store.bindHash({
      hash: agreementHash,
      jobId: "current",
      kind: "agreement",
    })).rejects.toThrow(/conflicting session owners: current, other/);
  });

  test("two store instances racing the same agreement hash leave exactly one session", async () => {
    const a = await createFsFencedSessionStore({ dir });
    const b = await createFsFencedSessionStore({ dir });
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

test("create keeps its published session locked through marker-conflict rollback", async () => {
  const jobId = "create-race";
  const agreementHash = "a".repeat(64);
  const sessionFile = join(dir, "sessions", `${encodeURIComponent(jobId)}.json`);
  const jobLock = join(dir, "locks", `${encodeURIComponent(jobId)}.lock`);
  let signalPublished = () => {};
  let permitSessionLink = () => {};
  let signalMutationContended = () => {};
  const published = new Promise<void>((resolve) => {
    signalPublished = resolve;
  });
  const sessionLinkPermit = new Promise<void>((resolve) => {
    permitSessionLink = resolve;
  });
  const mutationContended = new Promise<void>((resolve) => {
    signalMutationContended = resolve;
  });
  let canonicalLockAttempts = 0;

  vi.resetModules();
  vi.doMock("node:fs/promises", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
    return {
      ...actual,
      link: async (
        existingPath: Parameters<typeof actual.link>[0],
        newPath: Parameters<typeof actual.link>[1],
      ) => {
        if (String(newPath) === jobLock) {
          canonicalLockAttempts += 1;
          if (canonicalLockAttempts === 2) signalMutationContended();
        }
        await actual.link(existingPath, newPath);
        if (String(newPath) === sessionFile) {
          signalPublished();
          await sessionLinkPermit;
        }
      },
    };
  });

  try {
    const isolated = await import("../../src/agent/fencedSessionStoreFs.js");
    const creator = await isolated.createFsFencedSessionStore({ dir });
    const mutator = await isolated.createFsFencedSessionStore({ dir });
    const creating = creator.create({ jobId, agreementHash, now: 0 });
    const createRejected = expect(creating).rejects.toThrow(
      /already bound to session marker-winner/,
    );
    await published;
    await writeFile(
      join(dir, "hashes", `${encodeURIComponent(agreementHash)}.json`),
      JSON.stringify({ jobId: "marker-winner", kind: "agreement" }),
      { flag: "wx" },
    );

    const mutation = mutator.acquireLease({
      jobId,
      owner: "must-not-observe-rolled-back-session",
      ttlMs: 100,
      now: 1,
    });
    await mutationContended;
    expect((await stat(sessionFile)).isFile()).toBe(true);
    permitSessionLink();

    await createRejected;
    expect(await mutation).toEqual({ ok: false, reason: "not-found" });
    await expect(readFile(sessionFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    permitSessionLink();
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  }
});
