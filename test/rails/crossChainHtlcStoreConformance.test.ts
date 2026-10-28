import { describe, expect, test } from "vitest";

import {
  createInMemoryCrossChainHtlcStore,
  type CrossChainHtlcStore,
  type HtlcStoreClaim,
  type HtlcStoreWrite,
  type HtlcSourceFinalityCheckpoint,
} from "../../src/rails/crossChainHtlc.js";
import { sha256Hex } from "../../src/canonical/index.js";
import { checkCrossChainHtlcStore } from "../../src/rails/crossChainHtlcStoreConformance.js";

type SettledClaim = Extract<HtlcStoreClaim, { status: "settled" }>;

const memory = () => createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });

/** An in-memory store with one method wrapped to break one rule of the contract. */
function broken(patch: (inner: CrossChainHtlcStore) => Partial<CrossChainHtlcStore>): () => CrossChainHtlcStore {
  return () => {
    const inner = memory();
    return { ...inner, ...patch(inner) };
  };
}

const answer = (status: HtlcStoreWrite["status"]): HtlcStoreWrite =>
  status === "recorded" || status === "existing" ? { status } : { status, reason: "broken" };

/** The failing cases other than restart, which fails for any store checked without `reopen`. */
async function failingCases(makeStore: () => CrossChainHtlcStore): Promise<string[]> {
  return (await checkCrossChainHtlcStore(makeStore))
    .filter((check) => !check.ok && !RESTART_CASE.test(check.name))
    .map((check) => check.name);
}

/**
 * Handles over one in-memory store per `makeStore` call, so a reopen keeps the
 * state as a durable store would. Reopening closes the old handle, and
 * `restarted` may wrap the state the new handle serves.
 */
function durable(restarted: (inner: CrossChainHtlcStore) => CrossChainHtlcStore = (inner) => inner) {
  const backing = new WeakMap<CrossChainHtlcStore, { inner: CrossChainHtlcStore; closed: boolean }>();
  const open = (inner: CrossChainHtlcStore): CrossChainHtlcStore => {
    const state = { inner, closed: false };
    const store = Object.fromEntries(Object.entries(inner).map(([name, method]) => [
      name,
      (...args: unknown[]) => {
        if (state.closed) throw new Error(`${name} on a closed store`);
        return (method as (...input: unknown[]) => unknown)(...args);
      },
    ])) as unknown as CrossChainHtlcStore;
    backing.set(store, state);
    return store;
  };
  return {
    makeStore: () => open(memory()),
    reopen: (store: CrossChainHtlcStore) => {
      const state = backing.get(store);
      if (!state || state.closed) throw new Error("reopened a store that is not open");
      state.closed = true;
      return open(restarted(state.inner));
    },
  };
}

const RESTART_CASE = /^restart: /;

describe("checkCrossChainHtlcStore", () => {
  test("accepts a store requiring every reveal checkpoint to match retained source finality", async () => {
    const makeStore = broken((inner) => {
      const checkpoints = new Map<string, Readonly<HtlcSourceFinalityCheckpoint>>();
      return {
        async recordSourceFinality(input) {
          const result = await inner.recordSourceFinality(input);
          if (result.status === "recorded" || result.status === "existing") {
            checkpoints.set(input.settlementKey, input.checkpoint);
          }
          return result;
        },
        async recordRevealFinal(input) {
          if (!await inner.isCurrent({ ...input, now: 0 })) return inner.recordRevealFinal(input);
          const source = checkpoints.get(input.settlementKey);
          if (!source || source.sourceExpiry !== input.checkpoint.sourceExpiry) {
            return { status: "conflict", reason: "source-reveal-expiry-mismatch" };
          }
          return inner.recordRevealFinal(input);
        },
      };
    });
    expect(await failingCases(makeStore)).toEqual([]);
  });

  // The volatile store loses every row on a restart, so a host CI that checks
  // every case `ok` must not pass it.
  test("fails the restart case, and only it, for a store checked without a reopen hook", async () => {
    const checks = await checkCrossChainHtlcStore(memory);
    expect(checks.length).toBeGreaterThanOrEqual(17);
    expect(checks.every((check) => check.ok)).toBe(false);
    expect(checks.filter((check) => !check.ok)).toEqual([
      { name: expect.stringMatching(RESTART_CASE), ok: false, detail: "not checked: no reopen hook" },
    ]);
  });

  test("passes every case, restart included, for a store that keeps its state across a reopen", async () => {
    const without = await checkCrossChainHtlcStore(memory);
    const { makeStore, reopen } = durable();
    const withReopen = await checkCrossChainHtlcStore(makeStore, { reopen });
    expect(withReopen.map((check) => check.name)).toEqual(without.map((check) => check.name));
    expect(withReopen.filter((check) => RESTART_CASE.test(check.name))).toHaveLength(1);
    expect(withReopen.filter((check) => !check.ok)).toEqual([]);
  });

  test.each([
    ["loses all its state", () => memory(), /^claim during the live lease after reopening: expected waiting, got acquired/],
    ["drops the claim histories", (inner: CrossChainHtlcStore): CrossChainHtlcStore => ({
      ...inner,
      async claim(input) {
        const result = await inner.claim(input);
        return result.status === "waiting" || result.status === "acquired"
          ? { ...result, sourceClaimAttemptHistory: [], destinationClaimAttemptHistory: [] }
          : result;
      },
    }), /^the intent, rows, checkpoints and claim histories survive unchanged$/],
    ["restarts the lease generations", (inner: CrossChainHtlcStore): CrossChainHtlcStore => ({
      ...inner,
      async claim(input) {
        const result = await inner.claim(input);
        return result.status === "acquired" ? { ...result, lease: { ...result.lease, generation: 1 } } : result;
      },
    }), /^a takeover after reopening gets a higher generation$/],
    ["forgets the session's secrets", (inner: CrossChainHtlcStore): CrossChainHtlcStore => ({
      ...inner,
      async claim(input) {
        const result = await inner.claim(input);
        return result.status === "conflict"
          ? {
            status: "acquired",
            intent: input.intent,
            lease: { owner: input.owner, generation: 9, expiresAt: input.now + input.leaseDurationMs },
            prepared: [],
            sourceClaimAttemptHistory: [],
            destinationClaimAttemptHistory: [],
          }
          : result;
      },
    }), /^claim with another salt after reopening: expected conflict, got acquired/],
    ["accepts a write from the generation before the restart", (inner: CrossChainHtlcStore): CrossChainHtlcStore => ({
      ...inner,
      async recordPrepared(input) {
        const result = await inner.recordPrepared(input);
        return result.status === "stale" ? answer("recorded") : result;
      },
    }), /^a write from the generation before the restart: expected stale, got recorded/],
    ["forgets the other sessions' transactions", (inner: CrossChainHtlcStore): CrossChainHtlcStore => ({
      ...inner,
      async recordPrepared(input) {
        const result = await inner.recordPrepared(input);
        return result.status === "conflict" && result.reason.endsWith("cross-settlement-reuse")
          ? answer("recorded")
          : result;
      },
    }), /^another session's row with a retained transaction: expected conflict or corrupt, got recorded/],
    ["loses a settlement", (inner: CrossChainHtlcStore): CrossChainHtlcStore => ({
      ...inner,
      async claim(input) {
        const result = await inner.claim(input);
        return result.status === "settled"
          ? {
            status: "acquired",
            intent: input.intent,
            lease: { owner: input.owner, generation: 9, expiresAt: input.now + input.leaseDurationMs },
            prepared: [],
            sourceClaimAttemptHistory: [],
            destinationClaimAttemptHistory: [],
          }
          : result;
      },
    }), /^claim of the settled session after reopening: expected settled, got acquired/],
    ["drops a settled session's checkpoints", (inner: CrossChainHtlcStore): CrossChainHtlcStore => ({
      ...inner,
      async claim(input) {
        const result = await inner.claim(input);
        if (result.status !== "settled") return result;
        const { revealCheckpoint: _dropped, ...rest } = result;
        return rest;
      },
    }), /^the settled session's rows and checkpoints survive unchanged$/],
    ["drops a settled session's source-finality checkpoint", (inner: CrossChainHtlcStore): CrossChainHtlcStore => ({
      ...inner,
      async claim(input) {
        const result = await inner.claim(input);
        if (result.status !== "settled") return result;
        const { sourceFinalityCheckpoint: _dropped, ...rest } = result;
        return rest;
      },
    }), /^the settled session's rows and checkpoints survive unchanged$/],
    ["drops a settled session's source-lock and source-claim rows", (inner: CrossChainHtlcStore): CrossChainHtlcStore => ({
      ...inner,
      async claim(input) {
        const result = await inner.claim(input);
        return result.status === "settled"
          ? { ...result, prepared: result.prepared.filter((row) => row.action !== "source-lock" && row.action !== "source-claim") }
          : result;
      },
    }), /^the settled session's rows and checkpoints survive unchanged$/],
    ["drops a settled session's source-claim history", (inner: CrossChainHtlcStore): CrossChainHtlcStore => ({
      ...inner,
      async claim(input) {
        const result = await inner.claim(input);
        return result.status === "settled" ? { ...result, sourceClaimAttemptHistory: [] } : result;
      },
    }), /^the settled session's rows and checkpoints survive unchanged$/],
  ] as const)("catches a store that %s on restart, in the restart case only", async (_label, restarted, detail) => {
    const { makeStore, reopen } = durable(restarted);
    const failing = (await checkCrossChainHtlcStore(makeStore, { reopen })).filter((check) => !check.ok);
    expect(failing).toEqual([{ name: expect.stringMatching(RESTART_CASE), ok: false, detail: expect.stringMatching(detail) }]);
  });

  // The core replays a settlement only against every row and checkpoint it
  // names, so a settled claim that drops any one of them must fail the kit.
  test.each([
    ["its rows", (claimed: SettledClaim): HtlcStoreClaim => ({ ...claimed, prepared: [] })],
    ["its destination-lock row", (claimed: SettledClaim): HtlcStoreClaim => ({
      ...claimed,
      prepared: claimed.prepared.filter((row) => row.action !== "destination-lock"),
    })],
    ["its source-finality checkpoint", (claimed: SettledClaim): HtlcStoreClaim => {
      const { sourceFinalityCheckpoint: _dropped, ...rest } = claimed;
      return rest;
    }],
    ["its source-claim history", (claimed: SettledClaim): HtlcStoreClaim => ({ ...claimed, sourceClaimAttemptHistory: [] })],
  ] as const)("fails the settlement case, and only it, for a store that claims a settlement without %s", async (_label, drop) => {
    const makeStore = broken((inner) => ({
      async claim(input) {
        const result = await inner.claim(input);
        return result.status === "settled" ? drop(result) : result;
      },
    }));
    const failing = (await checkCrossChainHtlcStore(makeStore)).filter((check) => !check.ok && !RESTART_CASE.test(check.name));
    expect(failing).toEqual([{
      name: expect.stringMatching(/^settlement: /),
      ok: false,
      detail: "claim returns the retained rows and checkpoints with the settlement",
    }]);
  });

  test.each([
    [
      "answers existing for a different prepared row",
      broken((inner) => ({
        async recordPrepared(input) {
          const result = await inner.recordPrepared(input);
          return result.status === "conflict" ? answer("existing") : result;
        },
      })),
      /^prepared: the same row is existing/,
    ],
    [
      "reports a superseded generation as current",
      broken(() => ({ async isCurrent() { return true; } })),
      /^lease: isCurrent holds only/,
    ],
    [
      "accepts a write from a superseded generation",
      broken((inner) => ({
        async recordRevealFinal(input) {
          const result = await inner.recordRevealFinal(input);
          return result.status === "stale" ? answer("recorded") : result;
        },
      })),
      /^stale: every write/,
    ],
    [
      "hands out a second lease while one is live",
      broken((inner) => ({
        async claim(input) {
          const result = await inner.claim(input);
          return result.status === "waiting" ? { ...result, status: "acquired" } : result;
        },
      })),
      /^lease: concurrent first claims/,
    ],
    [
      "accepts another salt for a session or a reused salt",
      broken((inner) => ({
        async claim(input) {
          const result = await inner.claim(input);
          return result.status === "conflict"
            ? {
              status: "acquired",
              intent: input.intent,
              lease: { owner: input.owner, generation: 1, expiresAt: input.now + input.leaseDurationMs },
              prepared: [],
              sourceClaimAttemptHistory: [],
              destinationClaimAttemptHistory: [],
            }
            : result;
        },
      })),
      /^(binding|salt):/,
    ],
    [
      "records a source refund after the reveal checkpoint",
      broken((inner) => {
        const revealed = new Set<string>();
        return {
          async recordRevealFinal(input) {
            const result = await inner.recordRevealFinal(input);
            if (result.status === "recorded") revealed.add(input.settlementKey);
            return result;
          },
          async recordPrepared(input) {
            return input.prepared.action === "source-refund" && revealed.has(input.settlementKey)
              ? answer("recorded")
              : inner.recordPrepared(input);
          },
        };
      }),
      /^reveal:/,
    ],
    [
      "overwrites a recorded settlement",
      broken((inner) => ({
        async recordSettlement(input) {
          const result = await inner.recordSettlement(input);
          return result.status === "conflict" && result.reason === "htlc-settlement-conflict"
            ? answer("recorded")
            : result;
        },
      })),
      /^settlement:/,
    ],
    [
      "replays a source-claim CAS on a replaced prior",
      broken((inner) => ({
        async replacePreparedSourceClaim(input) {
          const result = await inner.replacePreparedSourceClaim(input);
          return result.status === "conflict" && result.reason.endsWith("prior-mismatch")
            ? answer("recorded")
            : result;
        },
      })),
      /^source-claim CAS: only the named prior/,
    ],
    [
      "replaces a source claim after the source expiry",
      broken((inner) => ({
        async replacePreparedSourceClaim(input) {
          const result = await inner.replacePreparedSourceClaim(input);
          return result.status === "conflict" && result.reason.endsWith("expired") ? answer("recorded") : result;
        },
      })),
      /^source-claim CAS: no replacement at or after/,
    ],
    [
      "replaces a reveal after the reveal checkpoint",
      broken((inner) => ({
        async replacePreparedDestinationClaim(input) {
          const result = await inner.replacePreparedDestinationClaim(input);
          return result.status === "conflict" && result.reason.endsWith("after-reveal") ? answer("recorded") : result;
        },
      })),
      /^destination-claim CAS:/,
    ],
    [
      "binds a destination lock to no source-finality checkpoint",
      broken((inner) => ({
        async recordPrepared(input) {
          const result = await inner.recordPrepared(input);
          return result.status === "conflict" && result.reason === "htlc-destination-lock-without-source-finality"
            ? answer("recorded")
            : result;
        },
      })),
      /^source finality:/,
    ],
    [
      "accepts an effect or transaction of another session",
      broken((inner) => ({
        async recordPrepared(input) {
          const result = await inner.recordPrepared(input);
          return result.status === "conflict" && result.reason.endsWith("cross-settlement-reuse")
            ? answer("recorded")
            : result;
        },
      })),
      /^prepared: an effect or transaction/,
    ],
    [
      "aliases the caller's row",
      broken((inner) => {
        const rows = new Map<string, object>();
        return {
          async recordPrepared(input) {
            const result = await inner.recordPrepared(input);
            if (result.status === "recorded") rows.set(input.prepared.effectHash, input.prepared);
            return result;
          },
          async claim(input) {
            const result = await inner.claim(input);
            return result.status === "waiting"
              ? { ...result, prepared: result.prepared.map((row) => (rows.get(row.effectHash) ?? row) as typeof row) }
              : result;
          },
        };
      }),
      /^prepared: a retained row does not change/,
    ],
  ] as const)("catches a store that %s", async (_label, makeStore, expected) => {
    const failing = await failingCases(makeStore);
    expect(failing.length).toBeGreaterThan(0);
    expect(failing.some((name) => expected.test(name))).toBe(true);
  });

  test.each([
    ["reuses a salt only across sessions", broken((inner) => ({
      claim: (input) => inner.claim({ ...input, secrets: {
        ...input.secrets, buyerSaltHash: sha256Hex(input.secrets.buyerSaltHash + input.intent.settlementKey),
      } }),
    })), /^salt: /, "second session with the same salt: expected conflict, got acquired"],
    ["names the waiting caller as holder", broken((inner) => ({
      async claim(input) {
        const result = await inner.claim(input);
        return result.status === "waiting" ? { ...result, lease: { ...result.lease, owner: input.owner } } : result;
      },
    })), /^lease: a live lease/, "waiting names the lease holder"],
    ["reuses a takeover generation", broken((inner) => ({
      async claim(input) {
        const result = await inner.claim(input);
        return result.status === "acquired" ? { ...result, lease: { ...result.lease, generation: 1 } } : result;
      },
    })), /^lease: a live lease/, "takeover gives the new owner a higher generation"],
    ["calls a conflicting second row existing", broken((inner) => ({
      async recordPrepared(input) {
        const result = await inner.recordPrepared(input);
        return result.status === "conflict" && result.reason === "htlc-action-replacement-forbidden" ? answer("existing") : result;
      },
    })), /^prepared: the same row/, "another row for the action: expected conflict or corrupt, got existing"],
    ["replaces the first row while refusing the second", broken((inner) => {
      const overwritten = new Map<string, Parameters<CrossChainHtlcStore["recordPrepared"]>[0]["prepared"]>();
      return {
        async recordPrepared(input) {
          const result = await inner.recordPrepared(input);
          if (result.status === "conflict" && input.prepared.txRef.kind === "htlc-lock" &&
              input.prepared.txRef.lockTxHash === "lock-other") overwritten.set(input.settlementKey, input.prepared);
          return result;
        },
        async claim(input) {
          const result = await inner.claim(input);
          const row = overwritten.get(input.intent.settlementKey);
          return row && (result.status === "waiting" || result.status === "acquired") ? { ...result, prepared: [row] } : result;
        },
      };
    }), /^prepared: the same row/, "the first row is retained unchanged"],
    ["records both concurrent rows", broken((inner) => {
      const extra = new Map<string, Parameters<CrossChainHtlcStore["recordPrepared"]>[0]["prepared"]>();
      return {
        async recordPrepared(input) {
          const result = await inner.recordPrepared(input);
          if (result.status === "conflict" && input.prepared.txRef.kind === "htlc-lock" &&
              ["lock-x", "lock-y"].includes(input.prepared.txRef.lockTxHash)) {
            extra.set(input.settlementKey, input.prepared);
            return answer("recorded");
          }
          return result;
        },
        async claim(input) {
          const result = await inner.claim(input);
          const row = extra.get(input.intent.settlementKey);
          return row && (result.status === "waiting" || result.status === "acquired")
            ? { ...result, prepared: [...result.prepared, row] } : result;
        },
      };
    }), /^concurrency: /, "one recorded and one refused, got recorded, recorded"],
    ["changes the returned settled amount", broken((inner) => ({
      async claim(input) {
        const result = await inner.claim(input);
        return result.status === "settled" ? { ...result, settlement: {
          ...result.settlement, paymentAmount: { ...result.settlement.paymentAmount, amount: "999" },
        } } : result;
      },
    })), /^settlement: /, "claim returns the recorded settlement"],
  ] as const)("pins the conformance sub-check for a store that %s", async (_name, makeStore, name, detail) => {
    const checks = await checkCrossChainHtlcStore(makeStore);
    expect(checks.find((check) => name.test(check.name))).toEqual({
      name: expect.stringMatching(name), ok: false, detail,
    });
  });

  test.each([
    "recordPrepared", "recordSourceFinality", "recordRevealFinal", "recordSettlement",
    "replacePreparedSourceClaim", "replacePreparedDestinationClaim",
  ] as const)("pins the stale %s write sub-check", async (method) => {
    const makeStore = broken((inner) => ({
      [method]: async (input: never) => {
        const result = await inner[method](input);
        return result.status === "stale" ? answer("recorded") : result;
      },
    }));
    const checks = await checkCrossChainHtlcStore(makeStore);
    expect(checks.find((check) => check.name.startsWith("stale: "))).toEqual({
      name: expect.stringMatching(/^stale: /), ok: false, detail: `${method}: expected stale, got recorded`,
    });
  });

  test("reports a throwing store as a failed case, not a thrown check", async () => {
    const checks = await checkCrossChainHtlcStore(broken(() => ({
      async isCurrent() { throw new Error("store offline"); },
    })));
    expect(checks.find((check) => check.name.startsWith("lease: isCurrent"))).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/store offline/),
    });
  });
});
