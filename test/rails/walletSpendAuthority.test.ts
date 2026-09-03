import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  combineWalletSpendEffectFenceV1,
  createInMemoryWalletSpendStateStore,
  createWalletSpendAuthorityV1,
  executeWalletSpendEffectV1,
  type WalletSpendPolicyV1,
  type WalletSpendAuthorityDependenciesV1,
  type WalletSpendRecoveryObservationV1,
  type WalletSpendReservationV1,
} from "../../src/rails/walletSpendAuthority.js";
import { createFsWalletSpendStateStoreV1 } from "../../src/rails/walletSpendAuthorityFs.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true })));
});

function policy(
  override: Partial<WalletSpendPolicyV1> = {},
): WalletSpendPolicyV1 {
  return {
    policyVersion: "1",
    policyId: "buyer-production-v1",
    wallet: "wallet-1",
    chainId: "demos:testnet",
    maximumConcurrentEffects: 1,
    maximumRetainedReservations: 100,
    assets: [{
      asset: "DEM-OS",
      maximumPerOrderDebit: "120",
      maximumNetworkFeeDebit: "20",
      minimumReserve: "100",
      rollingWindowMs: 86_400_000,
      maximumRollingEffects: 10,
      maximumRollingDebit: "300",
      maximumCumulativeDebit: "1000",
      maximumCounterpartyDebit: "250",
    }],
    ...override,
  };
}

function reservation(
  id: string,
  override: Partial<WalletSpendReservationV1> = {},
): WalletSpendReservationV1 {
  return {
    reservationVersion: "1",
    reservationId: id,
    jobId: `job-${id}`,
    phaseIndex: 2,
    phase: "pay-dem",
    agreementHash: HASH_A,
    settlementBindingHash: HASH_C,
    railId: "pay-dem-main",
    railDefinitionHash: HASH_B,
    wallet: "wallet-1",
    chainId: "demos:testnet",
    payee: "seller-1",
    finality: { model: "bft-final" },
    debits: [
      {
        asset: "DEM-OS",
        purpose: "service",
        expectedAmount: "100",
        maximumAmount: "100",
      },
      {
        asset: "DEM-OS",
        purpose: "network-fee",
        expectedAmount: "5",
        maximumAmount: "10",
      },
    ],
    ...override,
  };
}

const settled = (
  evidenceHash = HASH_C,
  networkFee = "7",
): WalletSpendRecoveryObservationV1 => ({
  disposition: "settled",
  evidenceHash,
  debits: [
    { asset: "DEM-OS", purpose: "service", amount: "100" },
    { asset: "DEM-OS", purpose: "network-fee", amount: networkFee },
  ],
});

function authority(input: {
  store?: ReturnType<typeof createInMemoryWalletSpendStateStore>;
  currentTime?: { value: number };
  balance?: string;
  authenticate?: (
    observation: Readonly<WalletSpendRecoveryObservationV1>,
  ) => boolean;
  selectedPolicy?: WalletSpendPolicyV1;
  owner?: string;
}) {
  const clock = input.currentTime ?? { value: 1_000 };
  return createWalletSpendAuthorityV1(input.selectedPolicy ?? policy(), {
    store: input.store ?? createInMemoryWalletSpendStateStore(),
    readBalance: async () => input.balance ?? "1000",
    authenticateRecovery: async (_reservation, observation) =>
      input.authenticate?.(observation) ?? true,
    now: () => clock.value,
    owner: input.owner ?? "worker-1",
    leaseDurationMs: 100,
  });
}

describe("wallet-wide spend authority (#291)", () => {
  test("reserves before effect, authenticates actual debit, and exposes headroom", async () => {
    const wallet = authority({});
    const claim = await wallet.reserve(reservation("one"));
    expect(claim.status).toBe("reserved");
    if (claim.status !== "reserved") throw new Error("expected reservation");

    await claim.permit.beginEffect();
    await claim.permit.assertCurrent();
    await claim.permit.settle(settled() as Extract<
      WalletSpendRecoveryObservationV1,
      { disposition: "settled" }
    >);

    expect(await wallet.inspect()).toEqual({
      policyId: "buyer-production-v1",
      policyHash: wallet.policyHash,
      wallet: "wallet-1",
      chainId: "demos:testnet",
      maximumConcurrentEffects: 1,
      activeEffects: 0,
      retainedReservations: 1,
      maximumRetainedReservations: 100,
      operatorActionReservations: [],
      assets: [{
        asset: "DEM-OS",
        maximumPerOrderDebit: "120",
        maximumNetworkFeeDebit: "20",
        minimumReserve: "100",
        rollingWindowMs: 86_400_000,
        maximumRollingEffects: 10,
        maximumRollingDebit: "300",
        maximumCumulativeDebit: "1000",
        maximumCounterpartyDebit: "250",
        balance: "1000",
        reservedWorstCaseDebit: "0",
        rollingSettledDebit: "107",
        cumulativeSettledDebit: "107",
        availableHeadroom: "193",
      }],
    });
  });

  test("serializes independent authorities and retains ambiguous effects", async () => {
    const store = createInMemoryWalletSpendStateStore();
    const first = authority({ store, owner: "worker-a" });
    const second = authority({ store, owner: "worker-b" });
    const [a, b] = await Promise.all([
      first.reserve(reservation("one")),
      second.reserve(reservation("two")),
    ]);
    expect([a.status, b.status].sort()).toEqual(["denied", "reserved"]);
    expect([a, b].find(({ status }) => status === "denied")).toMatchObject({
      reason: "concurrency-limit",
    });
    const accepted = a.status === "reserved" ? a : b;
    if (accepted.status !== "reserved") throw new Error("expected reservation");
    await accepted.permit.beginEffect();

    expect(await second.reserve(reservation("three"))).toEqual({
      status: "denied",
      reason: "concurrency-limit",
    });
  });

  test("an expired pre-effect lease cannot act or silently free budget", async () => {
    const clock = { value: 1_000 };
    const wallet = authority({ currentTime: clock });
    const claim = await wallet.reserve(reservation("one"));
    if (claim.status !== "reserved") throw new Error("expected reservation");
    clock.value = 1_101;
    await expect(claim.permit.beginEffect()).rejects.toThrow(/cannot begin an effect/);
    await expect(claim.permit.assertCurrent()).rejects.toThrow(/no longer current/);
    expect(await wallet.reserve(reservation("two"))).toMatchObject({
      status: "denied",
      reason: "concurrency-limit",
    });
    expect((await wallet.inspect()).operatorActionReservations).toEqual(["one"]);
  });

  test("changed agreement, rail definition, payee, finality, or run terms conflict", async () => {
    const wallet = authority({});
    expect((await wallet.reserve(reservation("one"))).status).toBe("reserved");
    for (const changed of [
      { agreementHash: HASH_C },
      { railDefinitionHash: HASH_C },
      { payee: "seller-2" },
      { phaseIndex: 3 },
      { finality: { model: "bft-final", finalityBlocks: 2 } },
    ]) {
      expect(await wallet.reserve(reservation("one", changed))).toMatchObject({
        status: "conflict",
      });
    }
  });

  test("replays a terminal decision without depending on a live balance RPC", async () => {
    const store = createInMemoryWalletSpendStateStore();
    const first = authority({ store });
    const item = reservation("one");
    const claim = await first.reserve(item);
    if (claim.status !== "reserved") throw new Error("expected reservation");
    await claim.permit.beginEffect();
    await claim.permit.settle(settled() as Extract<
      WalletSpendRecoveryObservationV1,
      { disposition: "settled" }
    >);

    const restarted = createWalletSpendAuthorityV1(policy(), {
      store,
      readBalance: async () => { throw new Error("RPC offline"); },
      authenticateRecovery: async () => true,
      owner: "restarted",
      now: () => 2_000,
    });
    expect(await restarted.reserve(item)).toMatchObject({
      status: "settled",
      evidenceHash: HASH_C,
    });
    expect(await restarted.reserve(reservation("one", {
      agreementHash: HASH_B,
    }))).toMatchObject({ status: "conflict" });
  });

  test("enforces per-order, fee, reserve, rolling, cumulative and counterparty limits", async () => {
    const cases: readonly [
      Partial<WalletSpendPolicyV1>,
      Partial<WalletSpendReservationV1>,
      string,
      string,
    ][] = [
      [{}, { debits: [{
        asset: "DEM-OS",
        purpose: "service",
        expectedAmount: "121",
        maximumAmount: "121",
      }] }, "1000", "per-order-limit"],
      [{}, { debits: [
        {
          asset: "DEM-OS",
          purpose: "service",
          expectedAmount: "90",
          maximumAmount: "90",
        },
        {
          asset: "DEM-OS",
          purpose: "network-fee",
          expectedAmount: "5",
          maximumAmount: "21",
        },
      ] }, "1000", "network-fee-limit"],
      [{}, {}, "209", "insufficient-reserve"],
    ];
    for (const [policyOverride, reservationOverride, balance, reason] of cases) {
      const wallet = authority({ selectedPolicy: policy(policyOverride), balance });
      expect(await wallet.reserve(reservation("one", reservationOverride))).toEqual({
        status: "denied",
        reason,
      });
    }

    const store = createInMemoryWalletSpendStateStore();
    const wallet = authority({ store, selectedPolicy: policy({ maximumConcurrentEffects: 2 }) });
    const first = await wallet.reserve(reservation("one"));
    if (first.status !== "reserved") throw new Error("expected reservation");
    await first.permit.beginEffect();
    await first.permit.settle(settled() as Extract<
      WalletSpendRecoveryObservationV1,
      { disposition: "settled" }
    >);
    const second = await wallet.reserve(reservation("two"));
    if (second.status !== "reserved") throw new Error("expected second reservation");
    await second.permit.beginEffect();
    await second.permit.settle(settled(HASH_B) as Extract<
      WalletSpendRecoveryObservationV1,
      { disposition: "settled" }
    >);
    expect(await wallet.reserve(reservation("three"))).toEqual({
      status: "denied",
      reason: "rolling-limit",
    });
  });

  test("rate, cumulative, and per-counterparty limits survive new run identifiers", async () => {
    const settleFirst = async (
      selectedPolicy: WalletSpendPolicyV1,
      clock = { value: 1_000 },
    ) => {
      const store = createInMemoryWalletSpendStateStore();
      const wallet = authority({ store, selectedPolicy, currentTime: clock });
      const claim = await wallet.reserve(reservation("first"));
      if (claim.status !== "reserved") throw new Error("expected first reservation");
      await claim.permit.beginEffect();
      await claim.permit.settle(settled() as Extract<
        WalletSpendRecoveryObservationV1,
        { disposition: "settled" }
      >);
      return wallet;
    };

    const ratePolicy = policy({
      assets: [{
        ...policy().assets[0]!,
        maximumRollingDebit: "1000",
        maximumRollingEffects: 1,
      }],
    });
    expect(await (await settleFirst(ratePolicy)).reserve(reservation("new-run")))
      .toEqual({ status: "denied", reason: "rolling-limit" });

    const cumulativePolicy = policy({
      assets: [{
        ...policy().assets[0]!,
        maximumRollingDebit: "1000",
        maximumCumulativeDebit: "210",
      }],
    });
    expect(await (await settleFirst(cumulativePolicy)).reserve(reservation("new-run")))
      .toEqual({ status: "denied", reason: "cumulative-limit" });

    const counterpartyPolicy = policy({
      assets: [{
        ...policy().assets[0]!,
        maximumRollingDebit: "1000",
        maximumCumulativeDebit: "1000",
        maximumCounterpartyDebit: "210",
      }],
    });
    const counterparty = await settleFirst(counterpartyPolicy);
    expect(await counterparty.reserve(reservation("new-run"))).toEqual({
      status: "denied",
      reason: "counterparty-limit",
    });
    expect((await counterparty.reserve(reservation("other-payee", {
      payee: "seller-2",
    }))).status).toBe("reserved");

    const clock = { value: 1_000 };
    const expiryPolicy = policy({
      assets: [{
        ...policy().assets[0]!,
        rollingWindowMs: 100,
        maximumRollingDebit: "110",
        maximumCumulativeDebit: "1000",
        maximumCounterpartyDebit: "1000",
      }],
    });
    const afterWindow = await settleFirst(expiryPolicy, clock);
    expect(await afterWindow.reserve(reservation("inside"))).toEqual({
      status: "denied",
      reason: "rolling-limit",
    });
    clock.value = 1_101;
    expect((await afterWindow.reserve(reservation("outside"))).status).toBe("reserved");
  });

  test("requires and authenticates operator approval at the configured threshold", async () => {
    const selectedPolicy = policy({
      assets: [{ ...policy().assets[0]!, operatorApprovalThreshold: "100" }],
    });
    const wallet = createWalletSpendAuthorityV1(selectedPolicy, {
      store: createInMemoryWalletSpendStateStore(),
      readBalance: async () => "1000",
      authenticateRecovery: async () => true,
      verifyOperatorApproval: async (approval, context) =>
        approval === `approve:${context.bindingHash}`,
      owner: "worker",
      now: () => 1_000,
    });
    expect(await wallet.reserve(reservation("one"))).toEqual({
      status: "denied",
      reason: "operator-approval-required",
    });
    expect(await wallet.reserve(reservation("one"), {
      operatorApproval: "bad",
    })).toEqual({ status: "denied", reason: "operator-approval-invalid" });
    let boundApproval = "";
    const approving = createWalletSpendAuthorityV1(selectedPolicy, {
      store: createInMemoryWalletSpendStateStore(),
      readBalance: async () => "1000",
      authenticateRecovery: async () => true,
      verifyOperatorApproval: async (approval, context) => {
        boundApproval = context.bindingHash;
        return approval === "approved";
      },
      owner: "worker",
      now: () => 1_000,
    });
    expect((await approving.reserve(reservation("one"), {
      operatorApproval: "approved",
    })).status).toBe("reserved");
    expect(boundApproval).toMatch(/^[0-9a-f]{64}$/);
  });

  test("never releases ambiguity without rail-authenticated absence", async () => {
    let authentic = false;
    const clock = { value: 1_000 };
    const wallet = authority({ authenticate: () => authentic, currentTime: clock });
    const item = reservation("one");
    const claim = await wallet.reserve(item);
    if (claim.status !== "reserved") throw new Error("expected reservation");
    await claim.permit.beginEffect();
    const absence = { disposition: "terminal-absent" as const, evidenceHash: HASH_C };
    await expect(wallet.reconcile(item, absence)).rejects.toThrow(/authentication failed/);
    expect((await wallet.inspect()).activeEffects).toBe(1);
    authentic = true;
    await expect(wallet.reconcile(item, absence)).rejects.toThrow(/live worker/);
    clock.value = 1_101;
    expect(await wallet.reconcile(item, absence)).toBe("released");
    expect((await wallet.inspect()).activeEffects).toBe(0);
  });

  test("effect-pending recovery requires terminal protection, not bare absence", async () => {
    const clock = { value: 1_000 };
    const wallet = authority({ currentTime: clock });
    const item = reservation("one");
    const claim = await wallet.reserve(item);
    if (claim.status !== "reserved") throw new Error("expected reservation");
    await claim.permit.beginEffect();
    clock.value = 1_101;
    await expect(claim.permit.assertCurrent()).rejects.toThrow(/no longer current/);
    await expect(wallet.reconcile(item, {
      disposition: "not-invoked",
      evidenceHash: HASH_C,
    })).rejects.toThrow(/terminal absence/);
    expect(await wallet.reconcile(item, {
      disposition: "terminal-absent",
      evidenceHash: HASH_C,
    })).toBe("released");
  });

  test("the execution adapter fences the rail and retains a thrown effect as ambiguous", async () => {
    const first = authority({});
    const calls: string[] = [];
    const completed = await executeWalletSpendEffectV1({
      authority: first,
      reservation: reservation("one"),
      async effect(fence) {
        await fence.assertCurrent();
        calls.push("effect");
        return "rail-finality";
      },
      async settlement(result) {
        expect(result).toBe("rail-finality");
        return settled() as Extract<
          WalletSpendRecoveryObservationV1,
          { disposition: "settled" }
        >;
      },
    });
    expect(completed).toEqual({ status: "completed", result: "rail-finality" });
    expect(calls).toEqual(["effect"]);

    const ambiguous = authority({});
    await expect(executeWalletSpendEffectV1({
      authority: ambiguous,
      reservation: reservation("two"),
      async effect(fence) {
        await fence.assertCurrent();
        throw new Error("connection lost after submission");
      },
      async settlement() {
        throw new Error("unreachable");
      },
    })).rejects.toThrow(/connection lost/);
    expect((await ambiguous.inspect()).activeEffects).toBe(1);
  });

  test("combines settlement and wallet generations at the irreversible boundary", async () => {
    const wallet = authority({});
    const claim = await wallet.reserve(reservation("one"));
    if (claim.status !== "reserved") throw new Error("expected reservation");
    await claim.permit.beginEffect();
    const calls: string[] = [];
    const combined = combineWalletSpendEffectFenceV1({
      settlementKey: "rail:job:0",
      bindingHash: HASH_C,
      owner: "settlement-worker",
      generation: 7,
      async assertCurrent() {
        calls.push("settlement");
      },
    }, {
      ...claim.permit,
      async assertCurrent() {
        calls.push("wallet");
        await claim.permit.assertCurrent();
      },
    });
    await combined.assertCurrent();
    expect(calls).toEqual(["settlement", "wallet"]);
    expect(combined).toMatchObject({
      settlementKey: "rail:job:0",
      bindingHash: HASH_C,
      owner: "settlement-worker",
      generation: 7,
    });
    expect(() => combineWalletSpendEffectFenceV1({
      settlementKey: "other:job:0",
      bindingHash: HASH_A,
      owner: "settlement-worker",
      generation: 8,
      async assertCurrent() {},
    }, claim.permit)).toThrow(/does not bind/);
  });

  test("rejects accessor/proxy authority inputs before invoking them", async () => {
    expect(() => createWalletSpendAuthorityV1(policy(), new Proxy({
      store: createInMemoryWalletSpendStateStore(),
      readBalance: async () => "1000",
      authenticateRecovery: async () => true,
    }, {}))).toThrow(/stable data/);

    const hostileDependencies = {
      store: createInMemoryWalletSpendStateStore(),
      authenticateRecovery: async () => true,
    } as Record<string, unknown>;
    Object.defineProperty(hostileDependencies, "readBalance", {
      enumerable: true,
      get() {
        throw new Error("must not execute");
      },
    });
    expect(() => createWalletSpendAuthorityV1(
      policy(),
      hostileDependencies as unknown as WalletSpendAuthorityDependenciesV1,
    )).toThrow(/stable/);

    const wallet = authority({});
    const options = {} as { operatorApproval?: string };
    Object.defineProperty(options, "operatorApproval", {
      enumerable: true,
      get() {
        throw new Error("must not execute");
      },
    });
    await expect(wallet.reserve(reservation("one"), options)).rejects.toThrow(/stable/);
  });

  test("rejects over-debit, underpaid service, missing debit, and unauthenticated settlement", async () => {
    for (const observation of [
      settled(HASH_C, "11"),
      { ...settled(), debits: [
        { asset: "DEM-OS", purpose: "service" as const, amount: "99" },
        { asset: "DEM-OS", purpose: "network-fee" as const, amount: "7" },
      ] },
      { ...settled(), debits: [
        { asset: "DEM-OS", purpose: "service" as const, amount: "100" },
      ] },
    ]) {
      const wallet = authority({});
      const claim = await wallet.reserve(reservation("one"));
      if (claim.status !== "reserved") throw new Error("expected reservation");
      await claim.permit.beginEffect();
      await expect(claim.permit.settle(observation as Extract<
        WalletSpendRecoveryObservationV1,
        { disposition: "settled" }
      >)).rejects.toThrow();
    }
    const unauthenticated = authority({ authenticate: () => false });
    const claim = await unauthenticated.reserve(reservation("one"));
    if (claim.status !== "reserved") throw new Error("expected reservation");
    await claim.permit.beginEffect();
    await expect(claim.permit.settle(settled() as Extract<
      WalletSpendRecoveryObservationV1,
      { disposition: "settled" }
    >)).rejects.toThrow(/authentication failed/);
  });
});

describe("authenticated filesystem wallet spend store", () => {
  async function fixture(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "dacs-wallet-spend-"));
    dirs.push(dir);
    return dir;
  }

  test("survives restart and serializes separate store instances", async () => {
    const dir = await fixture();
    const firstStore = await createFsWalletSpendStateStoreV1({ dir, integrityKey: KEY });
    const secondStore = await createFsWalletSpendStateStoreV1({ dir, integrityKey: KEY });
    const first = createWalletSpendAuthorityV1(policy({ maximumConcurrentEffects: 2 }), {
      store: firstStore,
      readBalance: async () => "1000",
      authenticateRecovery: async () => true,
      owner: "process-a",
      now: () => 1_000,
    });
    const second = createWalletSpendAuthorityV1(policy({ maximumConcurrentEffects: 2 }), {
      store: secondStore,
      readBalance: async () => "1000",
      authenticateRecovery: async () => true,
      owner: "process-b",
      now: () => 1_000,
    });
    const claims = await Promise.all([
      first.reserve(reservation("one")),
      second.reserve(reservation("two")),
      second.reserve(reservation("three")),
    ]);
    expect(claims.filter(({ status }) => status === "reserved")).toHaveLength(2);
    expect(claims.filter(({ status }) => status === "denied")).toEqual([
      { status: "denied", reason: "concurrency-limit" },
    ]);

    const restarted = createWalletSpendAuthorityV1(policy({ maximumConcurrentEffects: 2 }), {
      store: await createFsWalletSpendStateStoreV1({ dir, integrityKey: KEY }),
      readBalance: async () => "1000",
      authenticateRecovery: async () => true,
      owner: "process-c",
      now: () => 2_000,
    });
    expect((await restarted.inspect()).activeEffects).toBe(2);
  });

  test("retains cumulative and counterparty budgets across restart", async () => {
    const dir = await fixture();
    const selectedPolicy = policy({
      assets: [{
        ...policy().assets[0]!,
        maximumRollingDebit: "1000",
        maximumCumulativeDebit: "210",
        maximumCounterpartyDebit: "1000",
      }],
    });
    const first = createWalletSpendAuthorityV1(selectedPolicy, {
      store: await createFsWalletSpendStateStoreV1({ dir, integrityKey: KEY }),
      readBalance: async () => "1000",
      authenticateRecovery: async () => true,
      owner: "process-a",
      now: () => 1_000,
    });
    const claim = await first.reserve(reservation("first"));
    if (claim.status !== "reserved") throw new Error("expected reservation");
    await claim.permit.beginEffect();
    await claim.permit.settle(settled() as Extract<
      WalletSpendRecoveryObservationV1,
      { disposition: "settled" }
    >);

    const restarted = createWalletSpendAuthorityV1(selectedPolicy, {
      store: await createFsWalletSpendStateStoreV1({ dir, integrityKey: KEY }),
      readBalance: async () => "893",
      authenticateRecovery: async () => true,
      owner: "process-b",
      now: () => 2_000,
    });
    expect(await restarted.reserve(reservation("different-job"))).toEqual({
      status: "denied",
      reason: "cumulative-limit",
    });
    expect((await restarted.inspect()).assets[0]?.cumulativeSettledDebit).toBe("107");
  });

  test("serializes the same wallet across real independent processes", async () => {
    const dir = await fixture();
    const start = join(dir, "start");
    const key = Buffer.from(KEY).toString("hex");
    const children = ["a", "b"].map((id) => {
      const ready = join(dir, `ready-${id}`);
      const output = join(dir, `output-${id}`);
      const child = spawn(process.execPath, [
        "./node_modules/vitest/vitest.mjs",
        "run",
        "test/fixtures/wallet-spend-child.test.ts",
        "--pool=forks",
        "--maxWorkers=1",
        "--testTimeout=60000",
        "--reporter=dot",
      ], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          DACS_WALLET_SPEND_CHILD: "1",
          DACS_WALLET_SPEND_DIR: dir,
          DACS_WALLET_SPEND_READY: ready,
          DACS_WALLET_SPEND_START: start,
          DACS_WALLET_SPEND_OUTPUT: output,
          DACS_WALLET_SPEND_RESERVATION: id,
          DACS_WALLET_SPEND_KEY: key,
        },
      });
      const diagnostics: Buffer[] = [];
      child.stdout.on("data", (chunk) => diagnostics.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => diagnostics.push(Buffer.from(chunk)));
      return { child, ready, output, diagnostics };
    });
    try {
      // These are real, separately bootstrapped Vitest processes. A busy CI
      // runner can spend well over ten seconds compiling unrelated workers;
      // that scheduling delay is not a wallet-lock failure.
      const deadline = Date.now() + 30_000;
      for (const { ready } of children) {
        while (true) {
          try {
            await readFile(ready, "utf8");
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            if (Date.now() >= deadline) throw new Error("wallet spend child was not ready");
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
      }
      await writeFile(start, "go", { mode: 0o600 });
      await Promise.all(children.map(({ child, diagnostics }) => new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => code === 0
          ? resolve()
          : reject(new Error(
              `wallet spend child exited ${String(code)}\n` +
                Buffer.concat(diagnostics).toString("utf8"),
            )));
      })));
      const outcomes = await Promise.all(children.map(async ({ output }) =>
        JSON.parse(await readFile(output, "utf8")) as { status: string; reason?: string }));
      expect(outcomes.map(({ status }) => status).sort()).toEqual(["denied", "reserved"]);
      expect(outcomes.find(({ status }) => status === "denied")).toEqual({
        status: "denied",
        reason: "concurrency-limit",
      });
    } finally {
      for (const { child } of children) child.kill("SIGKILL");
    }
  }, 90_000);

  test("detects wrong keys, tampering, state deletion, and unsafe permissions", async () => {
    const dir = await fixture();
    const store = await createFsWalletSpendStateStoreV1({ dir, integrityKey: KEY });
    const wallet = createWalletSpendAuthorityV1(policy(), {
      store,
      readBalance: async () => "1000",
      authenticateRecovery: async () => true,
      owner: "process-a",
      now: () => 1_000,
    });
    expect((await wallet.reserve(reservation("one"))).status).toBe("reserved");
    const recordName = (await readdir(join(dir, "records")))[0]!;
    const recordPath = join(dir, "records", recordName);
    const original = await readFile(recordPath, "utf8");

    const wrongKey = createWalletSpendAuthorityV1(policy(), {
      store: await createFsWalletSpendStateStoreV1({
        dir,
        integrityKey: Uint8Array.from({ length: 32 }, () => 9),
      }),
      readBalance: async () => "1000",
      authenticateRecovery: async () => true,
      owner: "process-b",
      now: () => 1_000,
    });
    await expect(wrongKey.inspect()).rejects.toThrow(/unauthenticated/);

    const parsed = JSON.parse(original) as { state: { generation: number } };
    parsed.state.generation += 1;
    await writeFile(recordPath, JSON.stringify(parsed), { mode: 0o600 });
    await expect(wallet.inspect()).rejects.toThrow(/unauthenticated/);
    await writeFile(recordPath, original, { mode: 0o600 });

    await unlink(recordPath);
    await expect(wallet.inspect()).rejects.toThrow(/missing after initialization/);
  });

  test("rejects a pre-existing world-readable directory", async () => {
    if (process.platform === "win32") return;
    const dir = await fixture();
    await chmod(dir, 0o755);
    await expect(createFsWalletSpendStateStoreV1({
      dir,
      integrityKey: KEY,
    })).rejects.toThrow(/not private/);
  });
});
