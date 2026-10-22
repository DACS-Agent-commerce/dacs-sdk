import { describe, expect, test, vi } from "vitest";

import type { SettleRequest, SettleResult } from "../../src/agent/runSessionCore.js";
import { evmErc20Settle, type EvmErc20Rail } from "../../src/rails/evmErc20.js";
import {
  createIdempotencyStore,
  createInMemorySettlementLog,
  settlementBindingHash,
  settlementKey,
  type SettlementBinding,
  type SettlementEffectFence,
  type SettlementIdempotencyStoreOptions,
  type SettlementLog,
} from "../../src/rails/idempotency.js";

const ok = (txHash: string): SettleResult => ({
  ok: true,
  txHash,
  chainId: "eip155:84532",
  payer: "0xpayer",
  payee: "0xpayee",
  finality: { model: "block-depth", finalityBlocks: 12 },
});

const binding = (
  override: Partial<SettlementBinding> = {},
): Readonly<SettlementBinding> => Object.freeze({
  bindingVersion: "1",
  railId: "evm-erc20-usdc",
  jobId: "job-1",
  phaseIndex: 0,
  phase: "pay-evm-erc20",
  amount: "1000000",
  agreementAsset: "USDC",
  settlementAsset: "0xtoken",
  payer: "0xpayer",
  payee: "0xpayee",
  network: "eip155:84532",
  finality: Object.freeze({ model: "block-depth", finalityBlocks: 12 }),
  ...override,
});
const KEY = "evm-erc20-usdc:job-1:0";

test.each([
  " padded-hash", "padded-hash ", "\thash\n", { trim() { return this; } },
])("the generic attempt recorder rejects an inexact hash before touching the log: %s", async (hash) => {
  const log = createInMemorySettlementLog();
  const putAttempt = vi.spyOn(log, "putAttempt");
  const store = createIdempotencyStore(log);
  await store.once(KEY, binding(), async (fence) => {
    await expect(fence!.recordAttempt!(hash as string)).rejects.toThrow(/non-empty exact transaction hash/);
    expect(putAttempt).not.toHaveBeenCalled();
    await fence!.recordAttempt!("exact-hash");
    expect(putAttempt).toHaveBeenCalledTimes(1);
    return ok("exact-hash");
  });
  await expect(log.readAttempt!(KEY)).resolves.toMatchObject({ txHash: "exact-hash" });
});

describe("settlement idempotency store (#43)", () => {
  test("a repeated call for the same key returns the recorded result WITHOUT resubmitting", async () => {
    const store = createIdempotencyStore();
    let calls = 0;
    const submit = async () => ((calls += 1), ok(`0x${calls}`));
    const first = await store.once(KEY, binding(), submit);
    const second = await store.once(KEY, binding(), submit);
    expect(calls).toBe(1); // submitted at most once
    expect(second).toEqual(first); // same tx, not a new one
  });

  test("concurrent calls for one key share a single submission (no double-submit)", async () => {
    const store = createIdempotencyStore();
    let calls = 0;
    const submit = async () => {
      calls += 1;
      await Promise.resolve();
      return ok(`0x${calls}`);
    };
    const [a, b] = await Promise.all([
      store.once(KEY, binding(), submit),
      store.once(KEY, binding(), submit),
    ]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
  });

  test("an explicit not-invoked result releases the attempt for same-term retry", async () => {
    const store = createIdempotencyStore();
    let calls = 0;
    const submit = async () => {
      calls += 1;
      return calls === 1
        ? ({
            disposition: "not-invoked" as const,
            result: {
              ok: false,
              txHash: "",
              chainId: "eip155:84532",
              payer: "0xpayer",
              payee: "0xpayee",
            },
          })
        : ok("0xgood");
    };
    const bad = await store.once(KEY, binding(), submit);
    expect(bad.ok).toBe(false);
    const good = await store.once(KEY, binding(), submit); // retried, since the first wasn't recorded
    expect(calls).toBe(2);
    expect(good.txHash).toBe("0xgood");
  });

  test("an empty-hash failure without explicit not-invoked proof remains held", async () => {
    const log = createInMemorySettlementLog();
    let calls = 0;
    const ambiguous = async (): Promise<SettleResult> => {
      calls += 1;
      return {
        ok: false,
        txHash: "",
        chainId: "eip155:84532",
        payer: "0xpayer",
        payee: "0xpayee",
      };
    };
    await expect(createIdempotencyStore(log).once(KEY, binding(), ambiguous))
      .resolves.toMatchObject({ ok: false, txHash: "" });
    await expect(createIdempotencyStore(log).once(KEY, binding(), ambiguous))
      .rejects.toThrow(/unresolved|double-pay/);
    expect(calls).toBe(1);
  });

  test("a durable log makes it crash-safe across runs (resume finds the recorded result)", async () => {
    const log = createInMemorySettlementLog();
    let calls = 0;
    const submit = async () => ((calls += 1), ok(`0x${calls}`));
    // Run 1 settles, then "crashes" (log already recorded the outcome).
    await createIdempotencyStore(log).once(KEY, binding(), submit);
    // Run 2 (fresh store, SAME durable log) resumes — no resubmit.
    const resumed = await createIdempotencyStore(log).once(KEY, binding(), submit);
    expect(calls).toBe(1);
    expect(resumed.txHash).toBe("0x1");
  });

  test("value moved but the response was LOST → a fresh-process retry does NOT resubmit; it fails closed", async () => {
    // The reviewer's window: submit MOVES value, then throws before the outcome is
    // recorded (lost response / crash). The write-ahead intent survives in the
    // durable log, so the next attempt must NOT pay again.
    const log = createInMemorySettlementLog();
    let sends = 0;
    const submitThatMovesValueThenLosesResponse = async (): Promise<SettleResult> => {
      sends += 1; // value moved on-chain…
      throw new Error("response lost after broadcast");
    };
    // Run 1: value moves, response lost.
    await expect(
      createIdempotencyStore(log).once(KEY, binding(), submitThatMovesValueThenLosesResponse),
    ).rejects.toThrow(/response lost/);
    expect(sends).toBe(1);

    // Run 2 (fresh process, SAME durable log): the unresolved intent is seen. With
    // NO reconcile capability the store FAILS CLOSED rather than double-paying.
    await expect(
      createIdempotencyStore(log).once(KEY, binding(), async () => ok("0xsecond")),
    ).rejects.toThrow(/unresolved prior attempt|double-pay/);
    expect(sends).toBe(1); // never sent a second transfer
  });

  test("reconcile ADOPTS a prior payment that landed (no resubmit)", async () => {
    const log = createInMemorySettlementLog();
    let now = 0;
    let sends = 0;
    // Run 1: value moved, response lost → unresolved intent.
    await expect(
      createIdempotencyStore(log, { owner: "first", leaseDurationMs: 10, now: () => now }).once(KEY, binding(), async () => {
        sends += 1;
        throw new Error("lost");
      }),
    ).rejects.toThrow();
    // Run 2: reconcile proves the prior transfer landed → adopt it, don't resubmit.
    const reconcile = async () => ok("0xlanded");
    now = 11;
    const res = await createIdempotencyStore(log, { owner: "second", leaseDurationMs: 10, now: () => now }).once(KEY, binding(), async () => {
      sends += 1;
      return ok("0xwould-be-double");
    }, reconcile);
    expect(res.txHash).toBe("0xlanded");
    expect(sends).toBe(1); // reconciled, not resubmitted
  });

  test("proof of absence alone does not permit a replay", async () => {
    const log = createInMemorySettlementLog();
    let now = 0;
    let sends = 0;
    await expect(
      createIdempotencyStore(log, { owner: "first", leaseDurationMs: 10, now: () => now }).once(KEY, binding(), async () => {
        sends += 1;
        throw new Error("failed before broadcast");
      }),
    ).rejects.toThrow();
    // The prior external call may still wake up. Absence alone cannot revoke it.
    const reconcile = async () => null;
    now = 11;
    await expect(createIdempotencyStore(log, {
      owner: "second", leaseDurationMs: 10, now: () => now,
    }).once(KEY, binding(), async () => {
      sends += 1;
      return ok("0xretry");
    }, reconcile)).rejects.toThrow(/absence alone.*operator action/);
    expect(sends).toBe(1);
  });

  test("a replay grant is rejected when the retained terms lack external effect identity", async () => {
    const log = createInMemorySettlementLog();
    let now = 0;
    await expect(createIdempotencyStore(log, {
      owner: "first", leaseDurationMs: 10, now: () => now,
    }).once(KEY, binding(), async () => {
      throw new Error("lost response");
    })).rejects.toThrow(/lost response/);
    now = 11;
    let submissions = 0;
    await expect(createIdempotencyStore(log, {
      owner: "second", leaseDurationMs: 10, now: () => now,
    }).once(KEY, binding(), async () => {
      submissions += 1;
      return ok("0xunsafe");
    }, async () => ({
      disposition: "replay-authorized",
      bindingHash: settlementBindingHash(binding()),
      effectIdentity: "invented-effect",
      protection: "prior-effect-terminal",
      assertReplaySafe: async () => undefined,
    }))).rejects.toThrow(/does not bind the retained effect identity/);
    expect(submissions).toBe(0);
  });

  test("atomic claim: two stores over ONE durable log, concurrent → exactly one submits (#52)", async () => {
    // Cross-process shape: two store instances (separate inflight maps) share one
    // durable log. Without an ATOMIC claim both would submit; the put-if-absent
    // claim lets exactly one win — the loser fails closed, never a second send.
    const log = createInMemorySettlementLog();
    let sends = 0;
    const submit = async () => {
      sends += 1;
      await Promise.resolve();
      return ok(`0x${sends}`);
    };
    const results = await Promise.allSettled([
      createIdempotencyStore(log).once(KEY, binding(), submit),
      createIdempotencyStore(log).once(KEY, binding(), submit),
    ]);
    expect(sends).toBe(1); // the atomic claim prevented a second on-chain submission
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
  });

  test("a TX-BEARING non-definitive result does NOT clear the intent → retry fails closed (#52)", async () => {
    // ok:false BUT with a txHash — a tx was broadcast, so value MAY have moved.
    // The intent must survive (unlike a no-tx result), so a retry can't resubmit.
    const log = createInMemorySettlementLog();
    let sends = 0;
    const submit = async (): Promise<SettleResult> => {
      sends += 1;
      return {
        ok: false,
        txHash: "0xbroadcast",
        chainId: "eip155:84532",
        payer: "0xpayer",
        payee: "0xpayee",
      };
    };
    const first = await createIdempotencyStore(log).once(KEY, binding(), submit);
    expect(first.ok).toBe(false);
    expect(sends).toBe(1);
    // A fresh attempt with no reconcile must FAIL CLOSED — never resubmit.
    await expect(
      createIdempotencyStore(log).once(KEY, binding(), submit),
    ).rejects.toThrow(/unresolved|in-flight|double-pay/);
    expect(sends).toBe(1); // the broadcast tx was never re-sent
  });

  test("two restarted stores race after expiry: one recovery grant and one submission", async () => {
    const log = createInMemorySettlementLog();
    const key = KEY;
    const terms = binding({ effectIdentity: "mock-effect-1" });
    let now = 0;
    await expect(createIdempotencyStore(log, {
      owner: "crashed-owner",
      leaseDurationMs: 10,
      now: () => now,
    }).once(key, terms, async () => {
      throw new Error("crash after intent");
    })).rejects.toThrow(/crash after intent/);

    now = 11;
    let reconciles = 0;
    let submissions = 0;
    const reconcile = async () => {
      reconciles += 1;
      await Promise.resolve();
      return {
        disposition: "replay-authorized" as const,
        bindingHash: settlementBindingHash(terms),
        effectIdentity: "mock-effect-1",
        protection: "deterministic-external-idempotency" as const,
        assertReplaySafe: async (fence: Readonly<SettlementEffectFence>) =>
          fence.assertCurrent(),
      };
    };
    const run = (owner: string) => createIdempotencyStore(log, {
      owner,
      leaseDurationMs: 100,
      now: () => now,
    }).once(key, terms, async (fence) => {
      await fence?.assertCurrent();
      submissions += 1;
      return ok(`0x${submissions}`);
    }, reconcile);
    const results = await Promise.allSettled([run("worker-a"), run("worker-b")]);

    expect(reconciles).toBe(1);
    expect(submissions).toBe(1);
    expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
  });

  test("same key with changed commercial terms is a conflict", async () => {
    const log = createInMemorySettlementLog();
    const first = createIdempotencyStore(log);
    await first.once(KEY, binding(), async () => ok("0xfirst"));
    let submissions = 0;
    await expect(createIdempotencyStore(log).once(
      KEY,
      binding({ amount: "999000000" }),
      async () => {
        submissions += 1;
        return ok("0xchanged");
      },
    )).rejects.toThrow(/different terms/);
    expect(submissions).toBe(0);
    expect(settlementBindingHash(binding())).not.toBe(
      settlementBindingHash(binding({ amount: "999000000" })),
    );
  });

  test("a clean retry release retains the original term binding", async () => {
    const log = createInMemorySettlementLog();
    await createIdempotencyStore(log).once(KEY, binding(), async () => ({
      disposition: "not-invoked",
      result: {
        ok: false,
        txHash: "",
        chainId: "eip155:84532",
        payer: "0xpayer",
        payee: "0xpayee",
      },
    }));
    let submissions = 0;
    await expect(createIdempotencyStore(log).once(
      KEY,
      binding({ payee: "0xattacker" }),
      async () => {
        submissions += 1;
        return ok("0xwrong-terms");
      },
    )).rejects.toThrow(/different terms/);
    expect(submissions).toBe(0);
  });

  test("the retained hash binds identity, destination, network, resource, and finality", () => {
    const original = settlementBindingHash(binding({
      effectIdentity: "effect-1",
      resource: "https://seller.example/work",
    }));
    for (const changed of [
      binding({ payer: "0xother-payer", effectIdentity: "effect-1", resource: "https://seller.example/work" }),
      binding({ payee: "0xother-payee", effectIdentity: "effect-1", resource: "https://seller.example/work" }),
      binding({ network: "eip155:1", effectIdentity: "effect-1", resource: "https://seller.example/work" }),
      binding({ finality: { model: "block-depth", finalityBlocks: 13 }, effectIdentity: "effect-1", resource: "https://seller.example/work" }),
      binding({ effectIdentity: "effect-2", resource: "https://seller.example/work" }),
      binding({ effectIdentity: "effect-1", resource: "https://seller.example/other" }),
    ]) {
      expect(settlementBindingHash(changed)).not.toBe(original);
    }
  });

  test("mutating caller-owned binding data after once starts cannot change retained terms", async () => {
    const log = createInMemorySettlementLog();
    const mutable = {
      ...binding(),
      finality: { model: "block-depth", finalityBlocks: 12 },
    } as SettlementBinding;
    const operation = createIdempotencyStore(log).once(
      KEY,
      mutable,
      async () => ok("0xoriginal"),
    );
    mutable.amount = "999";
    (mutable.finality as { finalityBlocks?: number }).finalityBlocks = 99;
    await expect(operation).resolves.toMatchObject({ txHash: "0xoriginal" });
    await expect(createIdempotencyStore(log).once(
      KEY,
      binding(),
      async () => ok("0xmust-not-run"),
    )).resolves.toMatchObject({ txHash: "0xoriginal" });
  });

  test("stored and returned outcomes are frozen independent snapshots", async () => {
    const log = createInMemorySettlementLog();
    const source = {
      ...ok("0ximmutable"),
      finality: { model: "block-depth" as const, finalityBlocks: 12 },
    };
    const first = await createIdempotencyStore(log).once(
      KEY,
      binding(),
      async () => source,
    );
    source.txHash = "0xmutated-source";
    source.finality.finalityBlocks = 99;
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.finality)).toBe(true);
    expect(() => {
      (first as { txHash: string }).txHash = "0xmutated-return";
    }).toThrow();

    const second = await createIdempotencyStore(log).once(
      KEY,
      binding(),
      async () => ok("0xmust-not-run"),
    );
    expect(second.txHash).toBe("0ximmutable");
    expect(second.finality).toEqual({ model: "block-depth", finalityBlocks: 12 });
    expect(second).not.toBe(first);
  });

  test("rejects cached outcomes that do not match the retained network, parties, or finality", async () => {
    const mismatches: readonly SettleResult[] = [
      { ...ok("0xwrong-chain"), chainId: "eip155:1" },
      { ...ok("0xwrong-payer"), payer: "0xattacker" },
      { ...ok("0xwrong-payee"), payee: "0xattacker" },
      { ...ok("0xwrong-model"), finality: { model: "provider-receipt" } },
      { ...ok("0xwrong-depth"), finality: { model: "block-depth", finalityBlocks: 13 } },
    ];
    for (const result of mismatches) {
      const base = createInMemorySettlementLog();
      const corrupt: SettlementLog = {
        ...base,
        async claimIntent(input) {
          return {
            status: "outcome",
            outcome: { bindingHash: input.bindingHash, result },
          };
        },
      };
      await expect(createIdempotencyStore(corrupt).once(
        KEY,
        binding(),
        async () => ok("0xmust-not-run"),
      )).rejects.toThrow(/retained settlement (network or parties|finality policy)/);
    }
  });

  test("rejects fresh, reconciled, and post-write results outside the retained binding", async () => {
    await expect(createIdempotencyStore().once(
      KEY,
      binding(),
      async () => ({ ...ok("0xfresh"), payer: "0xattacker" }),
    )).rejects.toThrow(/retained settlement network or parties/);

    const reconcileLog = createInMemorySettlementLog();
    let now = 0;
    await expect(createIdempotencyStore(reconcileLog, {
      owner: "first", leaseDurationMs: 10, now: () => now,
    }).once(KEY, binding(), async () => { throw new Error("lost"); }))
      .rejects.toThrow(/lost/);
    now = 11;
    await expect(createIdempotencyStore(reconcileLog, {
      owner: "second", leaseDurationMs: 10, now: () => now,
    }).once(
      KEY,
      binding(),
      async () => ok("0xmust-not-run"),
      async () => ({
        ...ok("0xreconciled"),
        finality: { model: "block-depth", finalityBlocks: 13 },
      }),
    )).rejects.toThrow(/retained settlement finality policy/);

    const base = createInMemorySettlementLog();
    const corruptWrite: SettlementLog = {
      ...base,
      async putOutcome(input) {
        const write = await base.putOutcome(input);
        if (write.status !== "recorded" && write.status !== "existing") return write;
        return {
          ...write,
          outcome: {
            ...write.outcome,
            result: { ...write.outcome.result, chainId: "eip155:1" },
          },
        };
      },
    };
    await expect(createIdempotencyStore(corruptWrite).once(
      KEY,
      binding(),
      async () => ok("0xwritten"),
    )).rejects.toThrow(/retained settlement network or parties/);
  });

  test("captures own-data options and exact log methods at construction", async () => {
    const base = createInMemorySettlementLog();
    const claims: Array<{ owner: string; leaseDurationMs: number; now: number }> = [];
    const log: SettlementLog = {
      ...base,
      async claimIntent(input) {
        claims.push({
          owner: input.owner,
          leaseDurationMs: input.leaseDurationMs,
          now: input.now,
        });
        return base.claimIntent(input);
      },
    };
    const options = {
      owner: "captured-owner",
      leaseDurationMs: 10,
      now: () => 7,
    };
    const store = createIdempotencyStore(log, options);
    options.owner = "mutated-owner";
    options.leaseDurationMs = 999;
    options.now = () => 999;
    for (const name of [
      "claimIntent", "isCurrent", "grantRecovery", "putOutcome", "releaseIntent",
    ] as const) {
      log[name] = (() => { throw new Error(`mutated ${name}`); }) as never;
    }

    await expect(store.once(KEY, binding(), async () => ok("0xcaptured")))
      .resolves.toMatchObject({ txHash: "0xcaptured" });
    expect(claims).toEqual([{ owner: "captured-owner", leaseDurationMs: 10, now: 7 }]);
  });

  test("rejects option and log accessors without invoking them", () => {
    let optionReads = 0;
    const options = Object.defineProperty({}, "owner", {
      enumerable: true,
      get() {
        optionReads += 1;
        return "getter-owner";
      },
    });
    expect(() => createIdempotencyStore(
      createInMemorySettlementLog(),
      options as SettlementIdempotencyStoreOptions,
    )).toThrow(/stable own data/);
    expect(optionReads).toBe(0);

    let logReads = 0;
    const log = {
      ...createInMemorySettlementLog(),
      get claimIntent() {
        logReads += 1;
        return createInMemorySettlementLog().claimIntent;
      },
    };
    expect(() => createIdempotencyStore(log)).toThrow(/claimIntent.*stable callable data/);
    expect(logReads).toBe(0);
  });

  test("expiry during reconciliation cannot obtain a replay grant", async () => {
    const log = createInMemorySettlementLog();
    const key = KEY;
    let now = 0;
    await expect(createIdempotencyStore(log, {
      owner: "crashed-owner", leaseDurationMs: 10, now: () => now,
    }).once(key, binding(), async () => { throw new Error("crash"); }))
      .rejects.toThrow(/crash/);
    now = 11;
    let submissions = 0;
    await expect(createIdempotencyStore(log, {
      owner: "recovering-owner", leaseDurationMs: 10, now: () => now,
    }).once(key, binding(), async () => {
      submissions += 1;
      return ok("0xstale");
    }, async () => {
      now = 22;
      return null;
    })).rejects.toThrow(/effect fence is stale|recovery grant is stale/);
    expect(submissions).toBe(0);
  });

  test("lease expiry at the irreversible-effect fence fails closed before sending", async () => {
    const log = createInMemorySettlementLog();
    let now = 0;
    let sends = 0;
    await expect(createIdempotencyStore(log, {
      owner: "effect-owner", leaseDurationMs: 10, now: () => now,
    }).once(KEY, binding(), async (fence) => {
      now = 11;
      await fence?.assertCurrent();
      sends += 1;
      return ok("0xstale");
    })).rejects.toThrow(/effect fence is stale/);
    expect(sends).toBe(0);
  });

  test("an effect finishing after its lease expires cannot publish a successful outcome", async () => {
    const log = createInMemorySettlementLog();
    let now = 0;
    let sends = 0;
    await expect(createIdempotencyStore(log, {
      owner: "effect-owner", leaseDurationMs: 10, now: () => now,
    }).once(KEY, binding(), async () => {
      sends += 1;
      now = 11;
      return ok("0xlate");
    })).rejects.toThrow(/stale generation/);
    expect(sends).toBe(1);
  });

  test("a stale owner cannot record or release through a newer generation", async () => {
    const log = createInMemorySettlementLog();
    const terms = binding();
    const bindingHash = settlementBindingHash(terms);
    const first = await log.claimIntent({
      key: "evm-erc20-usdc:job-1:0",
      bindingHash,
      owner: "first",
      now: 0,
      leaseDurationMs: 10,
    });
    const second = await log.claimIntent({
      key: "evm-erc20-usdc:job-1:0",
      bindingHash,
      owner: "second",
      now: 11,
      leaseDurationMs: 10,
    });
    if (first.status !== "acquired" || second.status !== "acquired") {
      throw new Error("expected two generations");
    }
    await expect(log.putOutcome({
      key: "evm-erc20-usdc:job-1:0",
      bindingHash,
      lease: first.lease,
      result: ok("0xstale"),
      now: 11,
    })).resolves.toEqual({ status: "stale" });
    await expect(log.releaseIntent({
      key: "evm-erc20-usdc:job-1:0",
      bindingHash,
      lease: first.lease,
      now: 11,
    })).resolves.toBe("stale");
    await expect(log.isCurrent({
      key: "evm-erc20-usdc:job-1:0",
      bindingHash,
      lease: second.lease,
      now: 11,
    })).resolves.toBe(true);
  });

  test("rejects lease arithmetic that would exceed safe integer time", async () => {
    const log = createInMemorySettlementLog();
    await expect(log.claimIntent({
      key: KEY,
      bindingHash: settlementBindingHash(binding()),
      owner: "overflow-owner",
      now: Number.MAX_SAFE_INTEGER,
      leaseDurationMs: 1,
    })).rejects.toThrow(/timestamp or duration is invalid/);
    await expect(createIdempotencyStore(log, {
      owner: "overflow-owner",
      leaseDurationMs: 2,
      now: () => Number.MAX_SAFE_INTEGER - 1,
    }).once(KEY, binding(), async () => ok("0xnever")))
      .rejects.toThrow(/clock returned an invalid timestamp/);
  });
});

describe("evmErc20Settle bridge threads the idempotency key (#43 repro)", () => {
  // The issue's repro: calling the direct ERC-20 wrapper twice with the same
  // SettleRequest produced TWO transfers. With a store it must produce one.
  function countingRail(): EvmErc20Rail & { transferCalls: number } {
    const rail = {
      address: "0xme",
      finalityBlocks: 12,
      transferCalls: 0,
      async settle() {
        rail.transferCalls += 1;
        return {
          ...ok(`0x${rail.transferCalls}`),
          payer: rail.address,
        };
      },
    };
    return rail;
  }
  const req: SettleRequest = {
    rail: "evm-erc20-usdc",
    phase: "pay-evm-erc20",
    amount: "1000000",
    asset: "USDC",
    payee: "0xpayee",
    expectedPayee: "0xpayee",
    jobId: "job-1",
    phaseIndex: 0,
  };
  const cfg = { tokenAddress: "0xtoken", network: "eip155:84532", recipientEvm: "0xpayee" };

  test.each([false, true])("optional undefined log methods work across ERC-20 bridge restarts (readOutcome undefined=%s)", async (omitOutcome) => {
    const log = {
      ...createInMemorySettlementLog(),
      putAttempt: undefined,
      readAttempt: undefined,
      ...(omitOutcome ? { readOutcome: undefined } : {}),
    };
    const rail = countingRail();
    await expect(evmErc20Settle(rail, cfg, { store: createIdempotencyStore(log) })(req))
      .resolves.toMatchObject({ ok: true, txHash: "0x1" });
    await expect(evmErc20Settle(rail, cfg, { store: createIdempotencyStore(log) })(req))
      .resolves.toMatchObject({ ok: true, txHash: "0x1" });
    expect(rail.transferCalls).toBe(1);
  });

  test.each(["putAttempt", "readAttempt", "readOutcome"] as const)("undefined optional %s shadows inherited methods", (name) => {
    const log = Object.create(createInMemorySettlementLog()) as SettlementLog;
    Object.defineProperty(log, "putAttempt", { value: undefined, configurable: true });
    Object.defineProperty(log, "readAttempt", { value: undefined, configurable: true });
    Object.defineProperty(log, name, { value: undefined });
    expect(() => createIdempotencyStore(log)).not.toThrow();
  });

  test.each(["putAttempt", "readAttempt", "readOutcome"] as const)("still rejects invalid optional %s without invoking accessors", (name) => {
    const log = createInMemorySettlementLog();
    Object.defineProperty(log, name, { value: null, configurable: true });
    expect(() => createIdempotencyStore(log)).toThrow(/stable callable data/);
    let reads = 0;
    Object.defineProperty(log, name, { get() { reads += 1; return undefined; } });
    expect(() => createIdempotencyStore(log)).toThrow(/stable callable data/);
    expect(reads).toBe(0);
  });

  test("direct EVM bridge rejects a destination mismatch before transfer", async () => {
    const rail = countingRail();
    expect(() =>
      evmErc20Settle(rail, cfg)({ ...req, expectedPayee: "0xother" }),
    ).toThrow(/destination mismatch/);
    expect(rail.transferCalls).toBe(0);
  });

  test("SAFE BY DEFAULT: twice with the same request → one transfer (no opt-in store needed)", async () => {
    const rail = countingRail();
    const settle = evmErc20Settle(rail, cfg); // no store supplied — default is safe
    const a = await settle(req);
    const b = await settle(req);
    expect(rail.transferCalls).toBe(1); // the bug (2 transfers) is gone by default
    expect(b).toEqual(a);
  });

  test("an injected durable store dedupes across bridge instances (cross-resume)", async () => {
    const rail = countingRail();
    const store = createIdempotencyStore(createInMemorySettlementLog());
    // Two SEPARATE bridge instances sharing one durable store (a fresh-process resume).
    await evmErc20Settle(rail, cfg, { store })(req);
    const b = await evmErc20Settle(rail, cfg, { store })(req);
    expect(rail.transferCalls).toBe(1);
    expect(b.txHash).toBe("0x1");
  });

  test("settlementKey is (railId, jobId, phaseIndex)", () => {
    expect(settlementKey("evm-erc20-usdc", "job-1", 0)).toBe("evm-erc20-usdc:job-1:0");
  });

  test("settlementKey rejects a non-NFC job id instead of aliasing it", () => {
    expect(() => settlementKey("evm-erc20-usdc", "cafe\u0301-job", 0)).toThrow(
      /exact NFC/,
    );
  });

  test("settlementKey rejects delimiter collisions between rail and job ids", () => {
    expect(settlementKey("x402:default", "job", 0)).toBe(
      "x402:default:job:0",
    );
    expect(() => settlementKey("x402", "default:job", 0)).toThrow(
      /colon-free job id/,
    );
  });
});

describe("read-only settlement outcome lookup", () => {
  test("absence and an unresolved intent never acquire, renew, release or write", async () => {
    const log = createInMemorySettlementLog();
    const claim = vi.spyOn(log, "claimIntent");
    const write = vi.spyOn(log, "putOutcome");
    const release = vi.spyOn(log, "releaseIntent");
    const recover = vi.spyOn(log, "grantRecovery");
    const store = createIdempotencyStore(log, { now: () => 100, leaseDurationMs: 10 });
    await expect(store.readOutcome!(KEY, binding())).resolves.toBeNull();
    expect(claim).not.toHaveBeenCalled();
    const held = await log.claimIntent({ key: KEY, bindingHash: settlementBindingHash(binding()),
      owner: "original", now: 100, leaseDurationMs: 10 });
    await expect(store.readOutcome!(KEY, binding())).resolves.toBeNull();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    if (held.status !== "acquired") throw new Error("expected initial generation");
    await expect(log.isCurrent({ key: KEY, bindingHash: held.bindingHash, lease: held.lease, now: 101 })).resolves.toBe(true);
  });

  test("returns a frozen detached outcome after restart and rejects changed binding/key", async () => {
    const log = createInMemorySettlementLog();
    const store = createIdempotencyStore(log);
    const original = ok("recorded-effect");
    await store.once(KEY, binding(), async () => original);
    const restarted = createIdempotencyStore(log);
    const read = await restarted.readOutcome!(KEY, binding());
    expect(read).toEqual(original);
    expect(read).not.toBe(original);
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(read!.finality)).toBe(true);
    await expect(restarted.readOutcome!(KEY, binding({ amount: "2000000" }))).rejects.toThrow(/binding conflicts/);
    await expect(restarted.readOutcome!("other-key", binding())).rejects.toThrow(/does not match its idempotency key/);
  });

  test("waits for the same-store submission without acquiring another generation", async () => {
    const log = createInMemorySettlementLog();
    const claim = vi.spyOn(log, "claimIntent");
    const store = createIdempotencyStore(log);
    let finish!: (result: SettleResult) => void;
    let started!: () => void;
    const submitted = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<SettleResult>((resolve) => { finish = resolve; });
    const pending = store.once(KEY, binding(), async () => { started(); return gate; });
    await submitted;
    const read = store.readOutcome!(KEY, binding());
    await expect(store.readOutcome!(KEY, binding({ amount: "2000000" }))).rejects.toThrow(/different terms/);
    finish(ok("in-flight-effect"));
    await pending;
    await expect(read).resolves.toMatchObject({ txHash: "in-flight-effect" });
    expect(claim).toHaveBeenCalledTimes(1);
  });

  test.each([undefined, {}, { bindingHash: "invalid", result: ok("effect") },
    { bindingHash: settlementBindingHash(binding()), result: { ...ok("effect"), payer: "other" } },
    { bindingHash: settlementBindingHash(binding()), result: { ...ok("effect"), finality: { model: "other" } } },
  ])("rejects malformed or unbound lookup response %#", async (raw) => {
    const log = { ...createInMemorySettlementLog(), readOutcome: async () => raw } as SettlementLog;
    await expect(createIdempotencyStore(log).readOutcome!(KEY, binding())).rejects.toThrow();
  });

  // A log without `readOutcome` refuses the lookup before touching the log: a
  // lookup never claims, leases or binds a key, whatever terms it names, and
  // `once` over such a log is unchanged.
  test("a legacy log without readOutcome refuses the lookup without touching the log, and once stays compatible", async () => {
    const memory = createInMemorySettlementLog();
    const { readOutcome: _read, putAttempt: _put, readAttempt: _attempt, ...legacy } = memory;
    const claimIntent = vi.spyOn(legacy, "claimIntent");
    const releaseIntent = vi.spyOn(legacy, "releaseIntent");
    const store = createIdempotencyStore(legacy);
    await expect(store.readOutcome!(KEY, binding({ amount: "1000000" })))
      .rejects.toThrow(/settlement log requires read-only outcome lookup for retained recovery/);
    expect(claimIntent).not.toHaveBeenCalled();
    expect(releaseIntent).not.toHaveBeenCalled();
    // The lookup bound no terms: the first submission, under other terms, runs.
    await expect(store.once(KEY, binding({ amount: "2000000" }), async () => ok("legacy-effect")))
      .resolves.toMatchObject({ txHash: "legacy-effect" });
    await expect(store.readOutcome!(KEY, binding({ amount: "2000000" })))
      .rejects.toThrow(/settlement log requires read-only outcome lookup for retained recovery/);
  });

  test("captures the lookup receiver and method before awaiting caller-controlled code", async () => {
    const log = createInMemorySettlementLog();
    await createIdempotencyStore(log).once(KEY, binding(), async () => ok("original-effect"));
    class LookupLog implements SettlementLog {
      #backing = log;
      claimIntent = log.claimIntent;
      isCurrent = log.isCurrent;
      grantRecovery = log.grantRecovery;
      putOutcome = log.putOutcome;
      releaseIntent = log.releaseIntent;
      readOutcome(key: string) { return this.#backing.readOutcome!(key); }
    }
    const lookup = new LookupLog();
    const captured = createIdempotencyStore(lookup);
    lookup.readOutcome = async () => { throw new Error("replaced receiver method"); };
    await expect(captured.readOutcome!(KEY, binding())).resolves.toMatchObject({ txHash: "original-effect" });
    const cause = new Error("lookup timed out");
    log.readOutcome = async () => { throw cause; };
    await expect(captured.readOutcome!(KEY, binding())).rejects.toBe(cause);
  });

  test("does not invoke a lookup accessor", () => {
    const log = createInMemorySettlementLog();
    let reads = 0;
    Object.defineProperty(log, "readOutcome", { get() { reads += 1; return async () => null; } });
    expect(() => createIdempotencyStore(log)).toThrow(/readOutcome must be stable callable data/);
    expect(reads).toBe(0);
  });
});

describe("pay-dem terminal-failure proof binding", () => {
  const PAYER_HEX = "ab".repeat(32);
  const PAYEE_HEX = "cd".repeat(32);
  const HASH = "85".repeat(32);
  const AMOUNT_OS = "9500000000";
  const DEM_KEY = settlementKey("pay-dem", "job-338", 0);
  const demBinding = (
    override: Partial<SettlementBinding> = {},
  ): Readonly<SettlementBinding> => Object.freeze({
    bindingVersion: "1",
    railId: "pay-dem",
    jobId: "job-338",
    phaseIndex: 0,
    phase: "pay-dem",
    amount: AMOUNT_OS,
    agreementAsset: "DEM",
    settlementAsset: "DEM",
    payer: PAYER_HEX,
    payee: PAYEE_HEX,
    network: "demos",
    finality: Object.freeze({ model: "bft-final" }),
    ...override,
  });
  const proof = (override: Record<string, unknown> = {}) => ({
    kind: "demos-failed-record",
    txHash: HASH,
    nonce: 9,
    blockNumber: 480877,
    payer: PAYER_HEX,
    payee: PAYEE_HEX,
    amountOs: AMOUNT_OS,
    ...override,
  });
  // An `undefined` override removes the key, so the result stays canonical JSON.
  const failed = (override: Record<string, unknown> = {}): SettleResult => Object.fromEntries(
    Object.entries({
      ok: false,
      txHash: HASH,
      chainId: "demos",
      payer: PAYER_HEX,
      payee: PAYEE_HEX,
      errorClass: "permanent",
      blockNumber: 480877,
      txRefKind: "demos",
      failureProof: proof(),
      ...override,
    }).filter(([, value]) => value !== undefined),
  ) as unknown as SettleResult;

  // The proof checks shape and bindings, not origin. One no node served, from
  // a caller's own submission, must keep the attempt held: never a durable
  // verdict and never a second submission. Only payDemSettle's submission
  // around createPayDemRail's own settle is record-verified; the persisted
  // case is pinned with that rail in payDemExecutedStatus.test.ts.
  test("keeps an invented, self-consistent proof from a caller's submission held", async () => {
    const log = createInMemorySettlementLog();
    const putOutcome = vi.spyOn(log, "putOutcome");
    const invented = failed({
      txHash: "ab".repeat(32),
      blockNumber: 2,
      failureProof: proof({ txHash: "ab".repeat(32), nonce: 1, blockNumber: 2 }),
    });
    const submit = vi.fn(async () => invented);
    await expect(createIdempotencyStore(log).once(DEM_KEY, demBinding(), submit))
      .resolves.toEqual(invented);
    const restarted = createIdempotencyStore(log);
    await expect(restarted.once(DEM_KEY, demBinding(), submit)).rejects.toThrow(/refusing to resubmit/);
    await expect(restarted.readOutcome!(DEM_KEY, demBinding())).resolves.toBeNull();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(putOutcome).not.toHaveBeenCalled();
  });

  test("never records a reconciled failure proof as the definitive outcome", async () => {
    let clock = 1_000;
    const log = createInMemorySettlementLog();
    const putOutcome = vi.spyOn(log, "putOutcome");
    const options = { now: () => clock, leaseDurationMs: 10 };
    const first = createIdempotencyStore(log, options);
    // An attempt whose process died after the effect: a not-ok result with a
    // hash leaves the intent held until its lease expires.
    await first.once(DEM_KEY, demBinding(), async () => failed({
      errorClass: undefined, failureProof: undefined,
    }));
    clock += 100;
    const submit = vi.fn(async () => failed());
    const reconcile = vi.fn(async () => failed());
    await expect(createIdempotencyStore(log, options).once(DEM_KEY, demBinding(), submit, reconcile))
      .rejects.toThrow(/reconciliation was not definitive/);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    expect(putOutcome).not.toHaveBeenCalled();
  });

  test.each([
    ["another amount", { failureProof: proof({ amountOs: "1" }) }],
    ["another transaction", { failureProof: proof({ txHash: "34".repeat(32) }) }],
    ["another block", { failureProof: proof({ blockNumber: 1 }) }],
    ["another payer", { failureProof: proof({ payer: "ef".repeat(32) }) }],
    ["another payee", { failureProof: proof({ payee: "ef".repeat(32) }) }],
    ["an extra proof key", { failureProof: { ...proof(), extra: 1 } }],
    ["a missing proof key", { failureProof: (({ nonce: _nonce, ...rest }) => rest)(proof()) }],
    ["another proof kind", { failureProof: proof({ kind: "demos-included" }) }],
    ["no proof", { failureProof: undefined }],
    ["a proof without a permanent class", { errorClass: undefined }],
    ["a success that carries a proof", { ok: true, finality: { model: "bft-final" } }],
    ["a result block other than the proof's", { blockNumber: 480878 }],
  ])("once() refuses a failure proof with %s and never persists it", async (_case, override) => {
    const log = createInMemorySettlementLog();
    const putOutcome = vi.spyOn(log, "putOutcome");
    const store = createIdempotencyStore(log);
    const submit = vi.fn(async () => failed(override));
    await expect(store.once(DEM_KEY, demBinding(), submit))
      .rejects.toThrow(/terminal-failure proof does not bind the payment/);
    await expect(store.once(DEM_KEY, demBinding(), submit)).rejects.toThrow(/refusing to resubmit/);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(putOutcome).not.toHaveBeenCalled();
  });

  test.each([
    ["a non-pay-dem phase", { phase: "pay-evm-erc20" }],
    ["a non-DEM agreement asset", { agreementAsset: "USDC" }],
    ["another payment amount", { amount: "9500000001" }],
  ])("once() refuses a bound-looking proof under %s", async (_case, override) => {
    const log = createInMemorySettlementLog();
    const putOutcome = vi.spyOn(log, "putOutcome");
    const store = createIdempotencyStore(log);
    await expect(store.once(DEM_KEY, demBinding(override), async () => failed()))
      .rejects.toThrow(/terminal-failure proof does not bind the payment/);
    expect(putOutcome).not.toHaveBeenCalled();
  });

  test("read-only lookup refuses a recorded proof that does not bind the payment", async () => {
    const raw = {
      bindingHash: settlementBindingHash(demBinding()),
      result: failed({ failureProof: proof({ amountOs: "1" }) }),
    };
    const log = { ...createInMemorySettlementLog(), readOutcome: async () => raw } as SettlementLog;
    await expect(createIdempotencyStore(log).readOutcome!(DEM_KEY, demBinding()))
      .rejects.toThrow(/terminal-failure proof does not bind the payment/);
  });
});
