import { describe, expect, test } from "vitest";

import { canonicalize } from "../../src/canonical/index.js";
import {
  createInMemoryWalletSpendStateStore,
  createWalletSpendAuthorityV1,
  resumeWalletSpendAuthorityOperationV1,
  type WalletSpendAuthorityDependenciesV1,
  type WalletSpendPolicyV1,
  type WalletSpendReservationV1,
  type WalletSpendStateStore,
  type WalletSpendStateV1,
} from "../../src/rails/walletSpendAuthority.js";

const WALLET = `0x${"1d".repeat(32)}`;
const ABSENCE_HASH = "c".repeat(64);

const POLICY: WalletSpendPolicyV1 = {
  policyVersion: "1",
  policyId: "planned-nonce-buyer",
  wallet: WALLET,
  chainId: "demos",
  maximumConcurrentEffects: 1,
  maximumRetainedReservations: 10,
  assets: [{
    asset: "DEM",
    maximumPerOrderDebit: "120",
    maximumNetworkFeeDebit: "20",
    minimumReserve: "0",
    rollingWindowMs: 86_400_000,
    maximumRollingEffects: 10,
    maximumRollingDebit: "1000",
    maximumCumulativeDebit: "1000",
    maximumCounterpartyDebit: "1000",
  }],
};

const HOLD: WalletSpendReservationV1 = {
  reservationVersion: "1",
  reservationId: "pay-dem:planned",
  jobId: "job-planned",
  phaseIndex: 0,
  phase: "pay-dem",
  agreementHash: "a".repeat(64),
  settlementBindingHash: "b".repeat(64),
  railId: "pay-dem-native",
  railDefinitionHash: "d".repeat(64),
  wallet: WALLET,
  chainId: "demos",
  payee: "e".repeat(64),
  finality: { model: "bft-final" },
  debits: [
    { asset: "DEM", purpose: "service", expectedAmount: "100", maximumAmount: "100" },
    { asset: "DEM", purpose: "network-fee", expectedAmount: "0", maximumAmount: "10" },
  ],
};

/** An authority over a store whose state the test can read and replace, with a planned-nonce hook. */
function plannedNonceWorld(hook?: WalletSpendAuthorityDependenciesV1["bindPlannedTransferNonce"]) {
  const retained = createInMemoryWalletSpendStateStore();
  let scope = "";
  const store: WalletSpendStateStore = {
    transact(selected, operation) {
      scope = selected;
      return retained.transact(selected, operation);
    },
  };
  const clock = { now: 1_000 };
  const authority = createWalletSpendAuthorityV1(POLICY, {
    store,
    readBalance: async () => "1000",
    authenticateRecovery: async () => true,
    now: () => clock.now,
    leaseDurationMs: 100,
    owner: "planned-nonce-worker",
    ...(hook === undefined ? {} : { bindPlannedTransferNonce: hook }),
  });
  const state = () => retained.transact(scope, (current) => {
    if (current === null) throw new Error("expected a state");
    return { state: current, value: current };
  });
  const replace = (next: WalletSpendStateV1) => retained.transact(scope, () => ({ state: next, value: undefined }));
  return { authority, clock, state, replace };
}

describe("planned transfer nonce of a wallet hold", () => {
  test("binds the planned transfer nonce once when a hold is created", async () => {
    let answer: unknown = 7;
    const calls: unknown[] = [];
    const world = plannedNonceWorld(async (input) => {
      calls.push(input);
      if (answer instanceof Error) throw answer;
      return answer as number;
    });

    // (a) One call for the new row; the row and the permit carry the answer.
    const claim = await world.authority.reserve(HOLD);
    if (claim.status !== "reserved") throw new Error(`expected reserved, got ${claim.status}`);
    expect(calls).toEqual([{ reservation: HOLD, policyHash: world.authority.policyHash }]);
    expect(claim.permit.plannedTransferNonce).toBe(7);
    expect((await world.state()).reservations[0]).toMatchObject({ plannedTransferNonce: 7 });

    // (b) The same reserve finds the row: no second call, the row is unchanged.
    const before = canonicalize(await world.state());
    expect(await world.authority.reserve(HOLD)).toMatchObject({ status: "held", stage: "reserved" });
    expect(calls).toHaveLength(1);
    expect(canonicalize(await world.state())).toBe(before);

    // (f) A begin replay whose permit names another planned nonce is stale; the matching one begins.
    const permit = {
      reservationId: claim.permit.reservationId, bindingHash: claim.permit.bindingHash,
      settlementBindingHash: claim.permit.settlementBindingHash, owner: claim.permit.owner,
      generation: claim.permit.generation, reservation: HOLD,
    };
    for (const replayed of [{ ...permit, plannedTransferNonce: 8 }, permit]) {
      await expect(resumeWalletSpendAuthorityOperationV1(world.authority, { operation: "begin", permit: replayed }))
        .rejects.toThrow("wallet spend claimed operation replay is stale");
    }
    expect((await world.state()).reservations[0]?.stage).toBe("reserved");
    await resumeWalletSpendAuthorityOperationV1(world.authority, {
      operation: "begin", permit: { ...permit, plannedTransferNonce: 7 },
    });
    expect((await world.state()).reservations[0]?.stage).toBe("effect-pending");

    // (g) A released row keeps its value; reserving it again asks once more and binds the new value.
    world.clock.now = 1_101;
    await world.authority.reconcile(HOLD, { disposition: "terminal-absent", evidenceHash: ABSENCE_HASH });
    expect((await world.state()).reservations[0]).toMatchObject({ stage: "released", plannedTransferNonce: 7 });
    answer = 9;
    const again = await world.authority.reserve(HOLD);
    expect(calls).toHaveLength(2);
    expect(again.status === "reserved" && again.permit.plannedTransferNonce).toBe(9);
    expect((await world.state()).reservations[0]).toMatchObject({ stage: "reserved", plannedTransferNonce: 9 });

    // (e) A stored value that is not a non-negative safe integer refuses the state.
    const current = await world.state();
    for (const stored of ["7", -1, 1.5]) {
      await world.replace({ ...current, reservations: current.reservations.map((row) => ({
        ...row, plannedTransferNonce: stored as number,
      })) });
      await expect(world.authority.inspect()).rejects.toThrow("wallet spend state has an invalid reservation shape");
    }
  });

  test("writes no hold when the planned transfer nonce cannot be read", async () => {
    for (const answer of [new Error("node unavailable"), -1, 1.5, "7", Number.NaN, 2 ** 53]) {
      const world = plannedNonceWorld(async () => {
        if (answer instanceof Error) throw answer;
        return answer as number;
      });
      await expect(world.authority.reserve(HOLD)).rejects.toThrow("wallet spend planned transfer nonce is unavailable");
      expect((await world.authority.inspect()).retainedReservations).toBe(0);
    }
  });

  test("leaves the planned transfer nonce off holds of an authority without the hook", async () => {
    const world = plannedNonceWorld();
    const claim = await world.authority.reserve(HOLD);
    if (claim.status !== "reserved") throw new Error(`expected reserved, got ${claim.status}`);
    expect(claim.permit).not.toHaveProperty("plannedTransferNonce");
    expect((await world.state()).reservations[0]).not.toHaveProperty("plannedTransferNonce");
  });
});
