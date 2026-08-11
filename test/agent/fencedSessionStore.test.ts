import { describe, expect, test } from "vitest";

import {
  assertSessionPaymentAuthorizationShape,
  createInMemoryFencedSessionStore,
  FENCED_SESSION_STORE_VERSION,
  type FencedSessionStoreV2,
  type SessionPaymentAuthorizationBinding,
} from "../../src/agent/fencedSessionStore.js";

const fresh = (): FencedSessionStoreV2 => createInMemoryFencedSessionStore();

function paymentBinding(
  discriminator = "a",
  paymentPhaseIndex = 0,
  deliveryPhaseIndex = 1,
): SessionPaymentAuthorizationBinding {
  return {
    authorizationHash: discriminator.repeat(64),
    fulfilmentId: "b".repeat(64),
    handoffBindingHash: "c".repeat(64),
    agreementHash: "d".repeat(64),
    paymentEvidenceHash: "e".repeat(64),
    settlementId: `demos:${discriminator.repeat(64)}`,
    paymentPhaseIndex,
    deliveryPhaseIndex,
  };
}

async function completeDelivery(
  store: FencedSessionStoreV2,
  jobId: string,
): Promise<SessionPaymentAuthorizationBinding> {
  const binding = paymentBinding();
  await store.create({ jobId, agreementHash: binding.agreementHash, now: 0 });
  const lease = await store.acquireLease({
    jobId,
    owner: "delivery-worker",
    ttlMs: 100,
    sellerPhaseIndex: binding.deliveryPhaseIndex,
    now: 0,
  });
  if (!lease.ok) throw new Error("delivery lease missing");
  const bound = await store.bindSessionAuthorization({
    jobId,
    binding,
    leaseToken: lease.lease,
    now: 1,
  });
  if (!bound.ok) throw new Error(`authorization binding failed: ${bound.reason}`);
  const completed = await store.transition({
    jobId,
    expectedRevision: bound.record.revision,
    leaseToken: lease.lease,
    phase: `seller:delivery-completed:${binding.deliveryPhaseIndex}`,
    lease: null,
    now: 2,
  });
  if (!completed.ok) throw new Error(`delivery completion failed: ${completed.reason}`);
  return binding;
}

describe("generation-fenced FencedSessionStoreV2 v2", () => {
  test("advertises the explicit v2 runtime boundary", () => {
    expect(fresh().apiVersion).toBe(FENCED_SESSION_STORE_VERSION);
  });

  test("accepts exact Solana SB-1 instruction identities and rejects aliases", () => {
    const canonical = {
      ...paymentBinding(),
      settlementId: `solana:devnet:${"1".repeat(64)}:7`,
    };
    expect(() => assertSessionPaymentAuthorizationShape(canonical)).not.toThrow();
    for (const settlementId of [
      `solana:localnet:${"1".repeat(64)}:7`,
      `solana:devnet:${"1".repeat(63)}:7`,
      `solana:devnet:${"1".repeat(64)}:07`,
    ]) {
      expect(() => assertSessionPaymentAuthorizationShape({
        ...canonical,
        settlementId,
      })).toThrow(/canonical SB-1 settlement identity/);
    }
  });

  test("create + load; load distinguishes missing", async () => {
    const s = fresh();
    const rec = await s.create({ jobId: "j1", agreementHash: "0xagr", now: 100 });
    expect(rec).toMatchObject({ jobId: "j1", phase: "created", revision: 0, storeVersion: FENCED_SESSION_STORE_VERSION });
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

  test("semantic checkpoint claim cannot be reacquired after the revision advances", async () => {
    const s = fresh();
    await s.create({ jobId: "j1", now: 0 });
    const first = await s.claimCheckpoint({
      jobId: "j1",
      key: "settle:0",
      data: { rail: "pay-x402" },
      phase: "settling",
      now: 1,
    });
    expect(first.ok).toBe(true);

    // This worker starts later and therefore observes the revision written by
    // the first claimant. A plain revision CAS would let it append another
    // intent; the semantic claim must still report the in-flight effect as held.
    const staggered = await s.claimCheckpoint({
      jobId: "j1",
      key: "settle:0",
      data: { rail: "pay-x402" },
      phase: "settling",
      now: 2,
    });
    expect(staggered.ok).toBe(false);
    if (!staggered.ok) expect(staggered.reason).toBe("held");

    if (first.ok) {
      await s.transition({
        jobId: "j1",
        expectedRevision: first.record.revision,
        checkpoint: {
          key: "settle:0",
          stage: "outcome",
          data: { txHash: "0xpaid", chainId: "eip155:84532", ok: true },
        },
        now: 3,
      });
    }
    const completed = await s.claimCheckpoint({
      jobId: "j1",
      key: "settle:0",
      now: 4,
    });
    expect(completed.ok).toBe(false);
    if (!completed.ok) expect(completed.reason).toBe("completed");
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
    expect(a.ok && a.lease.generation).toBe(1);
    expect(bLater.ok && bLater.lease.generation).toBe(2);
    // A live acquisition cannot be reacquired, even under the same owner label.
    expect((await s.acquireLease({ jobId: "j1", owner: "worker-B", ttlMs: 1000, now: 1500 })).ok).toBe(false);
    if (bLater.ok) {
      const renewed = await s.renewLease({
        jobId: "j1",
        leaseToken: bLater.lease,
        ttlMs: 1000,
        now: 1500,
      });
      expect(renewed.ok && renewed.lease.generation).toBe(2);
    }
  });

  test("a guarded transition requires the exact live owner+generation token", async () => {
    const s = fresh();
    await s.create({ jobId: "j1", now: 0 });
    const lease = await s.acquireLease({ jobId: "j1", owner: "A", ttlMs: 1000, now: 0 });
    expect(lease.ok).toBe(true);
    const cur = await s.load("j1");
    const rev = cur.status === "ok" ? cur.record.revision : 0;
    const b = await s.transition({ jobId: "j1", expectedRevision: rev, phase: "settling", now: 100 });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe("lease-fenced");
    const wrongGeneration = await s.transition({
      jobId: "j1",
      expectedRevision: rev,
      leaseToken: { owner: "A", generation: 99 },
      phase: "settling",
      now: 100,
    });
    expect(wrongGeneration.ok).toBe(false);
    if (!wrongGeneration.ok) expect(wrongGeneration.reason).toBe("lease-fenced");
    if (lease.ok) {
      const a = await s.transition({
        jobId: "j1",
        expectedRevision: rev,
        leaseToken: lease.lease,
        phase: "settling",
        now: 100,
      });
      expect(a.ok).toBe(true);
    }
  });

  test("an expired token is fenced and only a fresh acquisition can take over", async () => {
    const s = fresh();
    await s.create({ jobId: "j1", now: 0 });
    const first = await s.acquireLease({ jobId: "j1", owner: "A", ttlMs: 10, now: 0 });
    const cur = await s.load("j1");
    const rev = cur.status === "ok" ? cur.record.revision : 0;
    if (first.ok) {
      const stale = await s.transition({
        jobId: "j1",
        expectedRevision: rev,
        leaseToken: first.lease,
        phase: "settling",
        now: 11,
      });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.reason).toBe("lease-expired");
    }
    const second = await s.acquireLease({ jobId: "j1", owner: "B", ttlMs: 10, now: 11 });
    expect(second.ok && second.lease.generation).toBe(2);
  });

  test("release never reopens an omitted-token or stale-token mutation path", async () => {
    const s = fresh();
    await s.create({ jobId: "j1", now: 0 });
    const first = await s.acquireLease({ jobId: "j1", owner: "A", ttlMs: 100, now: 0 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const released = await s.transition({
      jobId: "j1",
      expectedRevision: first.record.revision,
      leaseToken: first.lease,
      phase: "delivery-recovery",
      lease: null,
      now: 1,
    });
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    const omitted = await s.transition({
      jobId: "j1",
      expectedRevision: released.record.revision,
      phase: "evidence-recovery",
      now: 2,
    });
    expect(omitted.ok).toBe(false);
    if (!omitted.ok) expect(omitted.reason).toBe("lease-fenced");
    const stale = await s.claimCheckpoint({
      jobId: "j1",
      key: "seller:deliver:1",
      leaseToken: first.lease,
      now: 2,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe("lease-fenced");
    expect(
      await s.bindHash({
        hash: "transaction-after-release",
        jobId: "j1",
        kind: "transaction",
      }),
    ).toEqual({ ok: false, boundTo: "j1" });
    const second = await s.acquireLease({ jobId: "j1", owner: "B", ttlMs: 100, now: 2 });
    expect(second.ok && second.lease.generation).toBe(2);
  });

  test.each([
    "seller:delivery-pending:01",
    "seller:delivery-completed:9007199254740992",
    "seller:delivery-recovery",
    "seller:bundle-signing:1",
    "seller:bundle-binding-pending",
    "seller:unknown:1",
  ])("rejects malformed reserved lifecycle phase %s", async (phase) => {
    const s = fresh();
    await expect(s.create({ jobId: "reserved", phase })).rejects.toThrow(
      /reserved seller lifecycle/,
    );
    await s.create({ jobId: "j1", now: 0 });
    const lease = await s.acquireLease({
      jobId: "j1",
      owner: "worker",
      ttlMs: 100,
      now: 0,
    });
    if (!lease.ok) throw new Error("reserved-phase test lease missing");
    const transition = await s.transition({
      jobId: "j1",
      expectedRevision: lease.record.revision,
      leaseToken: lease.lease,
      phase,
      now: 1,
    });
    expect(transition).toMatchObject({ ok: false, reason: "phase-regression" });
  });

  test.each([
    "buyer:bundle-review:1",
    "buyer:counter-signature-pending",
    "buyer:awaiting-seller-finalization",
    "buyer:bundle-binding-publication",
    "buyer:unknown",
  ])("rejects malformed reserved buyer lifecycle phase %s", async (phase) => {
    const s = fresh();
    await expect(s.create({ jobId: "reserved-buyer", phase })).rejects.toThrow(
      /reserved buyer lifecycle/,
    );
    await s.create({ jobId: "buyer-job", phase: "settled", now: 0 });
    const lease = await s.acquireLease({
      jobId: "buyer-job",
      owner: "buyer-worker",
      ttlMs: 100,
      now: 0,
    });
    if (!lease.ok) throw new Error("reserved buyer phase test lease missing");
    expect(await s.transition({
      jobId: "buyer-job",
      expectedRevision: lease.record.revision,
      leaseToken: lease.lease,
      phase,
      now: 1,
    })).toMatchObject({ ok: false, reason: "phase-regression" });
  });

  test("expired worker stays fenced after takeover and terminal completion", async () => {
    const s = fresh();
    await s.create({ jobId: "j1", now: 0 });
    const first = await s.acquireLease({
      jobId: "j1",
      owner: "A",
      ttlMs: 10,
      sellerPhaseIndex: 1,
      now: 0,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const intent = await s.claimCheckpoint({
      jobId: "j1",
      key: "seller:deliver:1",
      data: { settlementId: "evm:1:tx:0" },
      phase: "seller:delivery-pending:1",
      leaseToken: first.lease,
      now: 1,
    });
    expect(intent.ok).toBe(true);
    const second = await s.acquireLease({
      jobId: "j1",
      owner: "B",
      ttlMs: 10,
      sellerPhaseIndex: 1,
      now: 11,
    });
    expect(second.ok && second.lease.generation).toBe(2);
    if (!second.ok) return;
    const latest = await s.load("j1");
    if (latest.status !== "ok") throw new Error("session missing");
    const completed = await s.transition({
      jobId: "j1",
      expectedRevision: latest.record.revision,
      leaseToken: second.lease,
      checkpoint: {
        key: "seller:deliver:1",
        stage: "outcome",
        data: { fingerprint: "done" },
      },
      phase: "seller:delivery-completed:1",
      lease: null,
      now: 12,
    });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    const bundleLease = await s.acquireLease({
      jobId: "j1",
      owner: "bundle-finalizer",
      ttlMs: 10,
      now: 12,
    });
    expect(bundleLease.ok && bundleLease.lease.generation).toBe(3);
    if (!bundleLease.ok) return;
    const signing = await s.transition({
      jobId: "j1",
      expectedRevision: bundleLease.record.revision,
      leaseToken: bundleLease.lease,
      phase: "seller:bundle-signing",
      now: 12,
    });
    expect(signing.ok).toBe(true);
    if (!signing.ok) return;
    const finalised = await s.transition({
      jobId: "j1",
      expectedRevision: signing.record.revision,
      leaseToken: bundleLease.lease,
      phase: "seller:finalised",
      lease: null,
      now: 12,
    });
    expect(finalised.ok).toBe(true);
    if (!finalised.ok) return;
    const stale = await s.transition({
      jobId: "j1",
      expectedRevision: finalised.record.revision,
      leaseToken: first.lease,
      phase: "seller:delivery-recovery",
      now: 13,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe("terminal-state");
    const reacquire = await s.acquireLease({
      jobId: "j1",
      owner: "C",
      ttlMs: 10,
      now: 13,
    });
    expect(reacquire.ok).toBe(false);
    if (!reacquire.ok) expect(reacquire.reason).toBe("terminal-state");
  });

  test("bundle finalization is unscoped, monotonic, phase-preserving, and terminal", async () => {
    const s = fresh();
    const binding = await completeDelivery(s, "bundle-job");
    const lease = await s.acquireLease({
      jobId: "bundle-job",
      owner: "bundle-worker",
      ttlMs: 100,
      now: 3,
    });
    if (!lease.ok) throw new Error("bundle lease missing");

    const signing = await s.claimCheckpoint({
      jobId: "bundle-job",
      key: "seller:bundle-signature:seller",
      data: { messageHash: "1".repeat(64) },
      phase: "seller:bundle-signing",
      leaseToken: lease.lease,
      now: 4,
    });
    expect(signing.ok).toBe(true);
    if (!signing.ok) return;

    const signatureOutcome = await s.transition({
      jobId: "bundle-job",
      expectedRevision: signing.record.revision,
      leaseToken: lease.lease,
      checkpoint: {
        key: "seller:bundle-signature:seller",
        stage: "outcome",
        data: { signatureHash: "2".repeat(64) },
      },
      now: 5,
    });
    expect(signatureOutcome.ok && signatureOutcome.record.phase).toBe(
      "seller:bundle-signing",
    );
    if (!signatureOutcome.ok) return;

    const anchor = await s.transition({
      jobId: "bundle-job",
      expectedRevision: signatureOutcome.record.revision,
      leaseToken: lease.lease,
      phase: "seller:bundle-anchor-pending",
      now: 6,
    });
    expect(anchor.ok).toBe(true);
    if (!anchor.ok) return;

    const regression = await s.transition({
      jobId: "bundle-job",
      expectedRevision: anchor.record.revision,
      leaseToken: lease.lease,
      phase: "seller:bundle-signing",
      now: 7,
    });
    expect(regression).toMatchObject({ ok: false, reason: "phase-regression" });
    const deliveryEscape = await s.transition({
      jobId: "bundle-job",
      expectedRevision: anchor.record.revision,
      leaseToken: lease.lease,
      phase: `seller:delivery-pending:${binding.deliveryPhaseIndex + 2}`,
      now: 7,
    });
    expect(deliveryEscape).toMatchObject({ ok: false, reason: "phase-regression" });

    const newAuthorization = await s.bindSessionAuthorization({
      jobId: "bundle-job",
      binding: {
        ...paymentBinding("f", 2, 3),
        agreementHash: binding.agreementHash,
      },
      leaseToken: lease.lease,
      now: 7,
    });
    expect(newAuthorization).toMatchObject({ ok: false, reason: "phase-regression" });

    const bindingSigning = await s.transition({
      jobId: "bundle-job",
      expectedRevision: anchor.record.revision,
      leaseToken: lease.lease,
      phase: "seller:bundle-binding-signing",
      now: 8,
    });
    expect(bindingSigning.ok).toBe(true);
    if (!bindingSigning.ok) return;

    const publication = await s.transition({
      jobId: "bundle-job",
      expectedRevision: bindingSigning.record.revision,
      leaseToken: lease.lease,
      phase: "seller:bundle-binding-publication-pending",
      now: 9,
    });
    expect(publication.ok).toBe(true);
    if (!publication.ok) return;
    const finalised = await s.transition({
      jobId: "bundle-job",
      expectedRevision: publication.record.revision,
      leaseToken: lease.lease,
      phase: "seller:finalised",
      receipt: { kind: "bundle", ref: "bundle-native-address" },
      lease: null,
      now: 10,
    });
    expect(finalised.ok && finalised.record.phase).toBe("seller:finalised");
    if (!finalised.ok) return;

    const terminalMutation = await s.transition({
      jobId: "bundle-job",
      expectedRevision: finalised.record.revision,
      checkpoint: { key: "late", stage: "intent" },
      now: 11,
    });
    expect(terminalMutation).toMatchObject({ ok: false, reason: "terminal-state" });
    expect(await s.acquireLease({
      jobId: "bundle-job",
      owner: "late-worker",
      ttlMs: 100,
      now: 11,
    })).toMatchObject({ ok: false, reason: "terminal-state" });
  });

  test("terminal FAB publication reopens seller failure and seals only after binding publication", async () => {
    const s = fresh();
    await expect(s.create({
      jobId: "direct-terminal",
      phase: "terminal:seller:authority",
    })).rejects.toThrow(/cannot enter terminal bundle finalization/);
    await expect(s.create({
      jobId: "malformed-terminal",
      phase: "terminal:seller:unknown",
    })).rejects.toThrow(/malformed or unrecognized reserved terminal/i);

    await s.create({ jobId: "failed-unbound", phase: "seller:failed", now: 0 });
    expect(await s.bindHash({
      hash: "a".repeat(64),
      jobId: "failed-unbound",
      kind: "agreement",
    })).toEqual({ ok: false, boundTo: "failed-unbound" });
    const failedUnbound = await s.load("failed-unbound");
    expect(failedUnbound.status === "ok" && failedUnbound.record.agreementHash).toBeUndefined();

    await s.create({
      jobId: "failed-prebound",
      agreementHash: "b".repeat(64),
      phase: "seller:failed",
      now: 0,
    });
    expect(await s.bindHash({
      hash: "b".repeat(64),
      jobId: "failed-prebound",
      kind: "agreement",
    })).toEqual({ ok: true, boundTo: "failed-prebound" });
    expect(await s.bindHash({
      hash: "c".repeat(64),
      jobId: "failed-prebound",
      kind: "agreement",
    })).toEqual({ ok: false, boundTo: "failed-prebound" });

    await s.create({ jobId: "failed-terminal", phase: "seller:failed", now: 0 });
    expect(await s.acquireLease({
      jobId: "failed-terminal",
      owner: "scoped-worker",
      ttlMs: 100,
      sellerPhaseIndex: 1,
      now: 0,
    })).toMatchObject({ ok: false, reason: "phase-regression" });
    const lease = await s.acquireLease({
      jobId: "failed-terminal",
      owner: "terminal-worker",
      ttlMs: 100,
      now: 0,
    });
    if (!lease.ok) throw new Error("terminal lease missing");
    expect(await s.claimCheckpoint({
      jobId: "failed-terminal",
      key: "terminal:buyer:authority",
      phase: "terminal:buyer:authority",
      leaseToken: lease.lease,
      now: 1,
    })).toMatchObject({ ok: false, reason: "phase-regression" });
    expect(await s.claimCheckpoint({
      jobId: "failed-terminal",
      key: "unrelated-intent",
      leaseToken: lease.lease,
      now: 1,
    })).toMatchObject({ ok: false, reason: "phase-regression" });
    expect(await s.transition({
      jobId: "failed-terminal",
      expectedRevision: lease.record.revision,
      leaseToken: lease.lease,
      checkpoint: { key: "unrelated-intent", stage: "intent" },
      now: 1,
    })).toMatchObject({ ok: false, reason: "phase-regression" });
    expect(await s.transition({
      jobId: "failed-terminal",
      expectedRevision: lease.record.revision,
      leaseToken: lease.lease,
      phase: "terminal:seller:authority",
      checkpoint: { key: "unrelated-intent", stage: "intent" },
      now: 1,
    })).toMatchObject({ ok: false, reason: "phase-regression" });
    expect(await s.transition({
      jobId: "failed-terminal",
      expectedRevision: lease.record.revision,
      leaseToken: lease.lease,
      receipt: { kind: "bundle", ref: "premature-bundle" },
      now: 1,
    })).toMatchObject({ ok: false, reason: "phase-regression" });
    expect(await s.bindSessionAuthorization({
      jobId: "failed-terminal",
      binding: paymentBinding("e"),
      leaseToken: lease.lease,
      now: 1,
    })).toMatchObject({ ok: false, reason: "phase-regression" });
    const authority = await s.claimCheckpoint({
      jobId: "failed-terminal",
      key: "terminal:seller:authority",
      data: { planHash: "1".repeat(64) },
      phase: "terminal:seller:authority",
      leaseToken: lease.lease,
      now: 1,
    });
    expect(authority.ok).toBe(true);
    if (!authority.ok) return;
    expect(await s.transition({
      jobId: "failed-terminal",
      expectedRevision: authority.record.revision,
      leaseToken: lease.lease,
      phase: "terminal:buyer:proposal-publication-pending",
      now: 2,
    })).toMatchObject({ ok: false, reason: "phase-regression" });
    expect(await s.transition({
      jobId: "failed-terminal",
      expectedRevision: authority.record.revision,
      leaseToken: lease.lease,
      phase: "terminal:seller:finalised",
      now: 2,
    })).toMatchObject({ ok: false, reason: "phase-regression" });
    const bindingPending = await s.transition({
      jobId: "failed-terminal",
      expectedRevision: authority.record.revision,
      leaseToken: lease.lease,
      phase: "terminal:seller:bundle-binding-publication-pending",
      now: 2,
    });
    expect(bindingPending.ok).toBe(true);
    if (!bindingPending.ok) return;
    expect(await s.transition({
      jobId: "failed-terminal",
      expectedRevision: bindingPending.record.revision,
      leaseToken: lease.lease,
      phase: "terminal:seller:matrix-review",
      now: 3,
    })).toMatchObject({ ok: false, reason: "phase-regression" });
    const resultIntent = await s.transition({
      jobId: "failed-terminal",
      expectedRevision: bindingPending.record.revision,
      leaseToken: lease.lease,
      checkpoint: {
        key: "terminal:seller:result",
        stage: "intent",
        data: { resultHash: "2".repeat(64) },
      },
      now: 4,
    });
    expect(resultIntent.ok).toBe(true);
    if (!resultIntent.ok) return;
    const finalised = await s.transition({
      jobId: "failed-terminal",
      expectedRevision: resultIntent.record.revision,
      leaseToken: lease.lease,
      phase: "terminal:seller:finalised",
      checkpoint: {
        key: "terminal:seller:result",
        stage: "outcome",
        data: { resultHash: "2".repeat(64) },
      },
      receipt: { kind: "bundle", ref: "native-terminal-bundle" },
      lease: null,
      now: 5,
    });
    expect(finalised.ok).toBe(true);
    if (!finalised.ok) return;
    expect(await s.acquireLease({
      jobId: "failed-terminal",
      owner: "late-worker",
      ttlMs: 100,
      now: 6,
    })).toMatchObject({ ok: false, reason: "terminal-state" });
  });

  test("buyer bundle finalization is unscoped, monotonic, and terminal", async () => {
    const s = fresh();
    await expect(s.create({
      jobId: "created-in-buyer-bundle",
      phase: "buyer:bundle-review",
    })).rejects.toThrow(/cannot enter buyer bundle finalization/);
    await expect(s.create({
      jobId: "created-buyer-terminal",
      phase: "buyer:finalised",
    })).rejects.toThrow(/cannot enter buyer bundle finalization/);

    await s.create({ jobId: "buyer-finalization", phase: "settled", now: 0 });
    const lease = await s.acquireLease({
      jobId: "buyer-finalization",
      owner: "buyer-worker",
      ttlMs: 100,
      now: 0,
    });
    if (!lease.ok) throw new Error("buyer bundle lease missing");

    const review = await s.claimCheckpoint({
      jobId: "buyer-finalization",
      key: "buyer:bundle-review",
      data: { requestHash: "1".repeat(64) },
      phase: "buyer:bundle-review",
      leaseToken: lease.lease,
      now: 1,
    });
    expect(review.ok).toBe(true);
    if (!review.ok) return;

    const signing = await s.transition({
      jobId: "buyer-finalization",
      expectedRevision: review.record.revision,
      leaseToken: lease.lease,
      phase: "buyer:counter-signing",
      now: 2,
    });
    expect(signing.ok).toBe(true);
    if (!signing.ok) return;

    const publishing = await s.transition({
      jobId: "buyer-finalization",
      expectedRevision: signing.record.revision,
      leaseToken: lease.lease,
      phase: "buyer:counter-signature-publication-pending",
      now: 3,
    });
    expect(publishing.ok).toBe(true);
    if (!publishing.ok) return;

    const waiting = await s.transition({
      jobId: "buyer-finalization",
      expectedRevision: publishing.record.revision,
      leaseToken: lease.lease,
      phase: "buyer:awaiting-seller-finalisation",
      now: 4,
    });
    expect(waiting.ok).toBe(true);
    if (!waiting.ok) return;

    expect(await s.transition({
      jobId: "buyer-finalization",
      expectedRevision: waiting.record.revision,
      leaseToken: lease.lease,
      phase: "buyer:counter-signing",
      now: 5,
    })).toMatchObject({ ok: false, reason: "phase-regression" });
    expect(await s.transition({
      jobId: "buyer-finalization",
      expectedRevision: waiting.record.revision,
      leaseToken: lease.lease,
      phase: "seller:bundle-signing",
      now: 5,
    })).toMatchObject({ ok: false, reason: "phase-regression" });

    const anchoring = await s.transition({
      jobId: "buyer-finalization",
      expectedRevision: waiting.record.revision,
      leaseToken: lease.lease,
      phase: "buyer:bundle-anchor-pending",
      now: 6,
    });
    expect(anchoring.ok).toBe(true);
    if (!anchoring.ok) return;

    const finalised = await s.transition({
      jobId: "buyer-finalization",
      expectedRevision: anchoring.record.revision,
      leaseToken: lease.lease,
      phase: "buyer:finalised",
      receipt: { kind: "bundle", ref: "buyer-bundle-native-address" },
      lease: null,
      now: 7,
    });
    expect(finalised.ok && finalised.record.phase).toBe("buyer:finalised");
    if (!finalised.ok) return;

    expect(await s.transition({
      jobId: "buyer-finalization",
      expectedRevision: finalised.record.revision,
      checkpoint: { key: "late-buyer-write", stage: "intent" },
      now: 8,
    })).toMatchObject({ ok: false, reason: "terminal-state" });
    expect(await s.acquireLease({
      jobId: "buyer-finalization",
      owner: "late-buyer-worker",
      ttlMs: 100,
      now: 8,
    })).toMatchObject({ ok: false, reason: "terminal-state" });
  });

  test("buyer bundle lifecycle rejects scoped leases and skipped entry", async () => {
    const s = fresh();
    await s.create({ jobId: "buyer-scoped", phase: "settled", now: 0 });
    const scoped = await s.acquireLease({
      jobId: "buyer-scoped",
      owner: "seller-scoped-worker",
      ttlMs: 100,
      sellerPhaseIndex: 1,
      now: 0,
    });
    if (!scoped.ok) throw new Error("scoped lease missing");
    expect(await s.transition({
      jobId: "buyer-scoped",
      expectedRevision: scoped.record.revision,
      leaseToken: scoped.lease,
      phase: "buyer:bundle-review",
      now: 1,
    })).toMatchObject({ ok: false, reason: "phase-regression" });

    const released = await s.transition({
      jobId: "buyer-scoped",
      expectedRevision: scoped.record.revision,
      leaseToken: scoped.lease,
      lease: null,
      now: 1,
    });
    if (!released.ok) throw new Error("scoped lease release failed");
    const unscoped = await s.acquireLease({
      jobId: "buyer-scoped",
      owner: "buyer-worker",
      ttlMs: 100,
      now: 2,
    });
    if (!unscoped.ok) throw new Error("buyer unscoped lease missing");
    expect(await s.transition({
      jobId: "buyer-scoped",
      expectedRevision: unscoped.record.revision,
      leaseToken: unscoped.lease,
      phase: "buyer:awaiting-seller-finalisation",
      now: 3,
    })).toMatchObject({ ok: false, reason: "phase-regression" });
  });

  test("bundle lifecycle entry rejects missing delivery history, scoped leases, and skipped entry", async () => {
    const s = fresh();
    await expect(s.create({
      jobId: "created-in-bundle",
      phase: "seller:bundle-signing",
    })).rejects.toThrow(/cannot enter seller bundle finalization/);

    await s.create({ jobId: "not-completed", now: 0 });
    const ordinary = await s.acquireLease({
      jobId: "not-completed",
      owner: "worker",
      ttlMs: 100,
      now: 0,
    });
    if (!ordinary.ok) throw new Error("ordinary lease missing");
    expect(await s.transition({
      jobId: "not-completed",
      expectedRevision: ordinary.record.revision,
      leaseToken: ordinary.lease,
      phase: "seller:bundle-signing",
      now: 1,
    })).toMatchObject({ ok: false, reason: "phase-regression" });

    await completeDelivery(s, "completed");
    const scoped = await s.acquireLease({
      jobId: "completed",
      owner: "later-delivery",
      ttlMs: 100,
      sellerPhaseIndex: 3,
      now: 3,
    });
    if (!scoped.ok) throw new Error("later scoped lease missing");
    expect(await s.transition({
      jobId: "completed",
      expectedRevision: scoped.record.revision,
      leaseToken: scoped.lease,
      phase: "seller:bundle-signing",
      now: 4,
    })).toMatchObject({ ok: false, reason: "phase-regression" });
    const released = await s.transition({
      jobId: "completed",
      expectedRevision: scoped.record.revision,
      leaseToken: scoped.lease,
      lease: null,
      now: 4,
    });
    if (!released.ok) throw new Error("scoped lease release failed");
    const unscoped = await s.acquireLease({
      jobId: "completed",
      owner: "bundle-worker",
      ttlMs: 100,
      now: 5,
    });
    if (!unscoped.ok) throw new Error("unscoped lease missing");
    expect(await s.transition({
      jobId: "completed",
      expectedRevision: unscoped.record.revision,
      leaseToken: unscoped.lease,
      phase: "seller:bundle-anchor-pending",
      now: 6,
    })).toMatchObject({ ok: false, reason: "phase-regression" });
  });

  test("completed seller phases advance only under a strictly later scoped lease", async () => {
    const s = fresh();
    await s.create({ jobId: "j1", now: 0 });
    const first = await s.acquireLease({
      jobId: "j1",
      owner: "A",
      ttlMs: 100,
      sellerPhaseIndex: 1,
      now: 0,
    });
    if (!first.ok) throw new Error("first scoped lease missing");
    const pending = await s.transition({
      jobId: "j1",
      expectedRevision: first.record.revision,
      leaseToken: first.lease,
      phase: "seller:delivery-pending:1",
      now: 1,
    });
    if (!pending.ok) throw new Error("pending transition failed");
    const completed = await s.transition({
      jobId: "j1",
      expectedRevision: pending.record.revision,
      leaseToken: first.lease,
      phase: "seller:delivery-completed:1",
      lease: null,
      now: 2,
    });
    if (!completed.ok) throw new Error("completion transition failed");

    const unscoped = await s.acquireLease({
      jobId: "j1",
      owner: "finalizer",
      ttlMs: 100,
      now: 3,
    });
    if (!unscoped.ok) throw new Error("unscoped finalizer lease missing");
    const rewritten = await s.transition({
      jobId: "j1",
      expectedRevision: unscoped.record.revision,
      leaseToken: unscoped.lease,
      phase: "seller:delivery-recovery:1",
      now: 3,
    });
    expect(rewritten.ok).toBe(false);
    if (!rewritten.ok) expect(rewritten.reason).toBe("phase-regression");
    const released = await s.transition({
      jobId: "j1",
      expectedRevision: unscoped.record.revision,
      leaseToken: unscoped.lease,
      lease: null,
      now: 3,
    });
    if (!released.ok) throw new Error("unscoped lease release failed");

    const same = await s.acquireLease({
      jobId: "j1",
      owner: "B",
      ttlMs: 100,
      sellerPhaseIndex: 1,
      now: 3,
    });
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.reason).toBe("phase-regression");

    const second = await s.acquireLease({
      jobId: "j1",
      owner: "B",
      ttlMs: 100,
      sellerPhaseIndex: 3,
      now: 3,
    });
    if (!second.ok) throw new Error("later scoped lease missing");
    const demotion = await s.transition({
      jobId: "j1",
      expectedRevision: second.record.revision,
      leaseToken: second.lease,
      phase: "seller:delivery-recovery:1",
      now: 4,
    });
    expect(demotion.ok).toBe(false);
    if (!demotion.ok) expect(demotion.reason).toBe("phase-regression");
    const arbitrary = await s.transition({
      jobId: "j1",
      expectedRevision: second.record.revision,
      leaseToken: second.lease,
      phase: "seller:delivery-recovery",
      now: 4,
    });
    expect(arbitrary.ok).toBe(false);
    if (!arbitrary.ok) expect(arbitrary.reason).toBe("phase-regression");
    const advanced = await s.transition({
      jobId: "j1",
      expectedRevision: second.record.revision,
      leaseToken: second.lease,
      phase: "seller:delivery-pending:3",
      now: 4,
    });
    expect(advanced.ok).toBe(true);
  });

  test("failed or rejected seller delivery stops later delivery acquisition", async () => {
    for (const outcome of ["failed", "rejected"] as const) {
      const s = fresh();
      const jobId = `job-${outcome}`;
      await s.create({ jobId, now: 0 });
      const lease = await s.acquireLease({
        jobId,
        owner: "A",
        ttlMs: 100,
        sellerPhaseIndex: 1,
        now: 0,
      });
      if (!lease.ok) throw new Error("scoped lease missing");
      const terminal = await s.transition({
        jobId,
        expectedRevision: lease.record.revision,
        leaseToken: lease.lease,
        phase: `seller:delivery-${outcome}:1`,
        lease: null,
        now: 1,
      });
      if (!terminal.ok) throw new Error("terminal transition failed");
      const later = await s.acquireLease({
        jobId,
        owner: "B",
        ttlMs: 100,
        sellerPhaseIndex: 3,
        now: 2,
      });
      expect(later.ok).toBe(false);
      if (!later.ok) expect(later.reason).toBe("phase-regression");
    }
  });

  test("same-index recovery is forward-only while prior claims remain replayable", async () => {
    const s = fresh();
    await s.create({ jobId: "j-forward", now: 0 });
    const lease = await s.acquireLease({
      jobId: "j-forward",
      owner: "A",
      ttlMs: 100,
      sellerPhaseIndex: 1,
      now: 0,
    });
    if (!lease.ok) throw new Error("scoped lease missing");
    const claimed = await s.claimCheckpoint({
      jobId: "j-forward",
      key: "seller:deliver:1",
      data: { fulfilmentId: "f1" },
      phase: "seller:delivery-pending:1",
      leaseToken: lease.lease,
      now: 1,
    });
    if (!claimed.ok) throw new Error("delivery claim failed");
    const evidenceRecovery = await s.transition({
      jobId: "j-forward",
      expectedRevision: claimed.record.revision,
      leaseToken: lease.lease,
      phase: "seller:evidence-recovery:1",
      now: 2,
    });
    if (!evidenceRecovery.ok) throw new Error("evidence recovery transition failed");

    const replay = await s.claimCheckpoint({
      jobId: "j-forward",
      key: "seller:deliver:1",
      data: { fulfilmentId: "f1" },
      phase: "seller:delivery-pending:1",
      leaseToken: lease.lease,
      now: 3,
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.reason).toBe("held");
      expect(replay.record?.phase).toBe("seller:evidence-recovery:1");
    }

    const demotion = await s.transition({
      jobId: "j-forward",
      expectedRevision: evidenceRecovery.record.revision,
      leaseToken: lease.lease,
      phase: "seller:delivery-recovery:1",
      now: 3,
    });
    expect(demotion.ok).toBe(false);
    if (!demotion.ok) expect(demotion.reason).toBe("phase-regression");
  });

  test("receipt immutability is indexed per repeated pipeline invocation", async () => {
    const s = fresh();
    await s.create({ jobId: "j1", now: 0 });
    const first = await s.transition({
      jobId: "j1",
      expectedRevision: 0,
      receipt: { kind: "settlement", phaseIndex: 0, ref: "tx-a" },
      now: 1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await s.transition({
      jobId: "j1",
      expectedRevision: first.record.revision,
      receipt: { kind: "settlement", phaseIndex: 2, ref: "tx-b" },
      now: 2,
    });
    expect(second.ok).toBe(true);
    expect(second.ok && second.record.receipts).toHaveLength(2);
  });

  test("canonical settlement authorization is immutable and unique across jobs/phases", async () => {
    const s = fresh();
    await s.create({ jobId: "j1" });
    await s.create({ jobId: "j2" });
    const lease1 = await s.acquireLease({ jobId: "j1", owner: "A", ttlMs: 1000 });
    const lease2 = await s.acquireLease({ jobId: "j2", owner: "B", ttlMs: 1000 });
    if (!lease1.ok || !lease2.ok) throw new Error("leases missing");
    const binding = {
      authorizationHash: "8".repeat(64),
      fulfilmentId: "9".repeat(64),
      handoffBindingHash: "7".repeat(64),
      agreementHash: "a".repeat(64),
      paymentEvidenceHash: "b".repeat(64),
      settlementId: `evm:8453:${"c".repeat(64)}:0`,
      paymentPhaseIndex: 0,
      deliveryPhaseIndex: 1,
    };
    expect((await s.bindSessionAuthorization({ jobId: "j1", binding, leaseToken: lease1.lease })).ok).toBe(true);
    expect((await s.bindSessionAuthorization({ jobId: "j1", binding })).ok).toBe(true);
    const relabelled = await s.bindSessionAuthorization({
      jobId: "j2",
      binding: {
        ...binding,
        authorizationHash: "3".repeat(64),
        fulfilmentId: "4".repeat(64),
        handoffBindingHash: "5".repeat(64),
        agreementHash: "d".repeat(64),
        paymentPhaseIndex: 2,
        deliveryPhaseIndex: 3,
      },
      leaseToken: lease2.lease,
    });
    expect(relabelled.ok).toBe(false);
    if (!relabelled.ok) expect(relabelled.reason).toBe("settlement-replay");
    const relabelledRecord = await s.load("j2");
    expect(
      relabelledRecord.status === "ok" && relabelledRecord.record.agreementHash,
    ).toBe("d".repeat(64));
    const changedAgreement = await s.bindSessionAuthorization({
      jobId: "j2",
      binding: {
        ...binding,
        agreementHash: "f".repeat(64),
        paymentEvidenceHash: "1".repeat(64),
        settlementId: `evm:8453:${"2".repeat(64)}:0`,
        paymentPhaseIndex: 4,
        deliveryPhaseIndex: 5,
      },
      leaseToken: lease2.lease,
    });
    expect(changedAgreement.ok).toBe(false);
    if (!changedAgreement.ok) {
      expect(changedAgreement.reason).toBe("agreement-conflict");
    }
    const changedPayment = await s.bindSessionAuthorization({
      jobId: "j1",
      binding: { ...binding, paymentEvidenceHash: "e".repeat(64) },
      leaseToken: lease1.lease,
    });
    expect(changedPayment.ok).toBe(false);
    if (!changedPayment.ok) expect(changedPayment.reason).toBe("payment-conflict");
  });

  test("full consumed bindings isolate repeated payment/delivery phases and reject non-canonical ids", async () => {
    const s = fresh();
    await s.create({ jobId: "j1" });
    const lease = await s.acquireLease({ jobId: "j1", owner: "A", ttlMs: 1000 });
    if (!lease.ok) throw new Error("lease missing");
    const first = {
      authorizationHash: "1".repeat(64),
      fulfilmentId: "2".repeat(64),
      handoffBindingHash: "3".repeat(64),
      agreementHash: "4".repeat(64),
      paymentEvidenceHash: "5".repeat(64),
      settlementId: `demos:${"6".repeat(64)}`,
      paymentPhaseIndex: 0,
      deliveryPhaseIndex: 1,
    };
    expect((await s.bindSessionAuthorization({
      jobId: "j1",
      binding: first,
      leaseToken: lease.lease,
    })).ok).toBe(true);
    const second = {
      ...first,
      authorizationHash: "7".repeat(64),
      fulfilmentId: "8".repeat(64),
      handoffBindingHash: "9".repeat(64),
      paymentEvidenceHash: "a".repeat(64),
      settlementId: `evm:8453:${"b".repeat(64)}:2`,
      paymentPhaseIndex: 2,
      deliveryPhaseIndex: 3,
    };
    expect((await s.bindSessionAuthorization({
      jobId: "j1",
      binding: second,
      leaseToken: lease.lease,
    })).ok).toBe(true);
    const duplicateDelivery = await s.bindSessionAuthorization({
      jobId: "j1",
      binding: { ...second, paymentPhaseIndex: 4, settlementId: `demos:${"c".repeat(64)}` },
      leaseToken: lease.lease,
    });
    expect(duplicateDelivery).toMatchObject({ ok: false, reason: "payment-conflict" });
    expect(() => assertSessionPaymentAuthorizationShape({
      ...second,
      settlementId: `evm:${Number.MAX_SAFE_INTEGER}0:${"b".repeat(64)}:2`,
    })).toThrow(/canonical/);
    expect(() => assertSessionPaymentAuthorizationShape({
      ...second,
      authorizationHash: "A".repeat(64),
    })).toThrow(/lower-case/);
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

  test("create REJECTS a reused agreement hash instead of overwriting ownership (#67)", async () => {
    const s = fresh();
    await s.create({ jobId: "j1", agreementHash: "0xagr" });
    // Creating a second session with j1's agreement hash must be rejected…
    await expect(s.create({ jobId: "j2", agreementHash: "0xagr" })).rejects.toThrow(
      /anti-replay|already bound/,
    );
    // …and ownership must be unchanged (still j1, not silently flipped to j2).
    expect(await s.bindHash({ hash: "0xagr", jobId: "j2", kind: "agreement" })).toEqual({ ok: false, boundTo: "j1" });
    expect(await s.load("j2")).toEqual({ status: "missing" }); // j2 was NOT persisted
  });

  test("cannot reclassify a transaction marker as an agreement for the same job", async () => {
    const s = fresh();
    expect(await s.bindHash({
      hash: "0xshared-kind",
      jobId: "j1",
      kind: "transaction",
    })).toEqual({ ok: true, boundTo: "j1" });

    await expect(
      s.create({ jobId: "j1", agreementHash: "0xshared-kind" }),
    ).rejects.toThrow(/anti-replay|already bound/);
    expect(await s.load("j1")).toEqual({ status: "missing" });
    expect(await s.bindHash({
      hash: "0xshared-kind",
      jobId: "j1",
      kind: "transaction",
    })).toEqual({ ok: true, boundTo: "j1" });
  });

  test("a leased session cannot admit a pre-existing second agreement marker", async () => {
    const s = fresh();
    await s.bindHash({ hash: "0xagreement-b", jobId: "j1", kind: "agreement" });
    await s.create({ jobId: "j1", agreementHash: "0xagreement-a", now: 0 });
    const lease = await s.acquireLease({
      jobId: "j1",
      owner: "worker",
      ttlMs: 100,
      now: 0,
    });
    expect(lease.ok).toBe(true);
    expect(await s.bindHash({
      hash: "0xagreement-b",
      jobId: "j1",
      kind: "agreement",
    })).toEqual({ ok: false, boundTo: "j1" });
    const loaded = await s.load("j1");
    expect(loaded.status === "ok" && loaded.record.agreementHash).toBe("0xagreement-a");
  });

  test("v2 runtime guards reject legacy, extra, empty, and explicit-undefined inputs", async () => {
    const s = fresh();
    await s.create({ jobId: "j1", now: 0 });
    await expect(s.transition({
      jobId: "j1",
      expectedRevision: 0,
      owner: "legacy-worker",
      phase: "settling",
    } as never)).rejects.toThrow(/owner.*not a v2 field/);
    await expect(s.transition({
      jobId: "j1",
      expectedRevision: 0,
      lease: { owner: "legacy-worker", expiresAt: 10 },
    } as never)).rejects.toThrow(/accepts only null|v1 lease/);
    await expect(s.transition({
      jobId: "j1",
      expectedRevision: 0,
      receipt: { kind: "bundle", ref: "receipt", phaseIndex: undefined },
    } as never)).rejects.toThrow(/phaseIndex.*omitted/);
    await expect(s.claimCheckpoint({
      jobId: "j1",
      key: "settle:0",
      data: undefined,
    } as never)).rejects.toThrow(/data.*omitted/);
    await expect(s.bindHash({ hash: "", jobId: "j1", kind: "agreement" }))
      .rejects.toThrow(/hash.*non-empty/);
    await expect(s.bindHash({
      hash: "valid",
      jobId: "j1",
      kind: "other",
    } as never)).rejects.toThrow(/kind/);
    await expect(s.list({ phase: undefined } as never)).rejects.toThrow(/phase.*omitted/);

    const loaded = await s.load("j1");
    expect(loaded.status === "ok" && loaded.record.revision).toBe(0);
  });

  test("checkpoint payload is primitive-only: a nested/complex value is rejected", async () => {
    const s = fresh();
    await s.create({ jobId: "j1", now: 0 });
    // A nested object could smuggle a credential into durable state → rejected.
    await expect(
      s.transition({
        jobId: "j1",
        expectedRevision: 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        checkpoint: { key: "settle:0", stage: "intent", data: { secret: { apiKey: "sk-live-xyz" } } as any },
        now: 1,
      }),
    ).rejects.toThrow(/checkpoint\.data|string.*finite number/);
    // The rejected write must not have advanced the session.
    const loaded = await s.load("j1");
    expect(loaded.status === "ok" && loaded.record.revision).toBe(0);
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

  test("list has deterministic tie ordering and clone-isolated results", async () => {
    const s = fresh();
    await s.create({ jobId: "j-b", phase: "created", now: 7 });
    await s.create({ jobId: "j-a", phase: "created", now: 7 });
    const first = await s.list();
    expect(first.map((record) => record.jobId)).toEqual(["j-a", "j-b"]);
    first[0]!.phase = "mutated";
    first.reverse();
    expect((await s.list()).map((record) => [record.jobId, record.phase])).toEqual([
      ["j-a", "created"],
      ["j-b", "created"],
    ]);
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
