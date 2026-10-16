import { describe, expect, test } from "vitest";

import {
  createInMemoryCrossChainHtlcStore,
  type CrossChainHtlcStore,
  type HtlcStoreWrite,
} from "../../src/rails/crossChainHtlc.js";
import { checkCrossChainHtlcStore } from "../../src/rails/crossChainHtlcStoreConformance.js";

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

async function failingCases(makeStore: () => CrossChainHtlcStore): Promise<string[]> {
  return (await checkCrossChainHtlcStore(makeStore)).filter((check) => !check.ok).map((check) => check.name);
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
  test("the in-memory store meets every case of the store contract", async () => {
    const checks = await checkCrossChainHtlcStore(memory);
    expect(checks.length).toBeGreaterThanOrEqual(16);
    expect(checks.filter((check) => !check.ok)).toEqual([]);
  });

  test("runs the restart case only with a reopen hook", async () => {
    const without = await checkCrossChainHtlcStore(memory);
    expect(without.some((check) => RESTART_CASE.test(check.name))).toBe(false);
    const { makeStore, reopen } = durable();
    const withReopen = await checkCrossChainHtlcStore(makeStore, { reopen });
    expect(withReopen.map((check) => check.name)).toEqual([
      ...without.map((check) => check.name),
      expect.stringMatching(RESTART_CASE),
    ]);
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
  ] as const)("catches a store that %s on restart, in the restart case only", async (_label, restarted, detail) => {
    const { makeStore, reopen } = durable(restarted);
    const failing = (await checkCrossChainHtlcStore(makeStore, { reopen })).filter((check) => !check.ok);
    expect(failing).toEqual([{ name: expect.stringMatching(RESTART_CASE), ok: false, detail: expect.stringMatching(detail) }]);
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
