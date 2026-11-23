import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureWalletSpendPolicyV1,
  type WalletSpendRecoveryObservationV1,
  type WalletSpendReservationV1,
  type WalletSpendStateV1,
  type WalletSpendStoredReservationV1,
} from "@kynesyslabs/dacs";
import { TP1_APPROVED_IDENTITY_RECORD } from "@kynesyslabs/dacs/wire";

import { createDacsWalletSpendDemosReaderV1 } from "../src/walletSpendDemosReader.js";
import {
  createDacsWalletSpendTestnetDemRecoveryV1,
  openDacsWalletSpendDemEvidenceStoreV1,
} from "../src/walletSpendTestnetDemRecovery.js";
import {
  CONFIRMED_FEE,
  CONFIRMED_HASH,
  DEMOS_PAYEE,
  DEMOS_RAIL_ID as RAIL_ID,
  FAILED_HASH,
  closeDemosNodeStubs,
  closedPortUrl,
  demosHold as demHold,
  demosNodeStub,
  demosPolicy,
  demosSettledClaim as settled,
  recordedDemosState,
  type DemosNodeAnswer,
  type DemosNodeCall,
  type DemosNodeState,
} from "./helpers/walletSpendDemosNode.js";

const evidenceDirectories: string[] = [];
async function evidenceDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dem-evidence-"));
  evidenceDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.useRealTimers();
  await closeDemosNodeStubs();
  await Promise.all(evidenceDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const POLICY = captureWalletSpendPolicyV1(demosPolicy());
const CREATED_AT = 1_700_000_000_000;

function row(reservation: WalletSpendReservationV1, settledWith?: string): WalletSpendStoredReservationV1 {
  return {
    reservationId: reservation.reservationId,
    bindingHash: "e".repeat(64),
    reservation,
    stage: settledWith === undefined ? "effect-pending" : "settled",
    generation: 2,
    owner: "testnet",
    leaseExpiresAt: CREATED_AT + 300_000,
    ...(settledWith === undefined ? {} : { evidenceHash: settledWith }),
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function stateOf(...rows: WalletSpendStoredReservationV1[]): WalletSpendStateV1 {
  return { stateVersion: 1, policyHash: "f".repeat(64), generation: 2, reservations: rows, totals: [], rollingEvents: [] };
}

interface RuleWorld {
  rule: ReturnType<typeof createDacsWalletSpendTestnetDemRecoveryV1>;
  calls: DemosNodeCall[];
  node: DemosNodeState;
  reports: Readonly<Record<string, string>>[];
}

async function world(state: WalletSpendStateV1, options: Readonly<{
  answer?: (call: DemosNodeCall) => DemosNodeAnswer | undefined;
  hold?: (call: DemosNodeCall) => Promise<void> | undefined;
  url?: string;
  evidenceDirectory?: string;
  evidenceStore?: Parameters<typeof createDacsWalletSpendTestnetDemRecoveryV1>[0]["evidenceStore"];
}> = {}): Promise<RuleWorld> {
  const stub = await demosNodeStub(recordedDemosState(TP1_APPROVED_IDENTITY_RECORD.chainIdentity), options);
  const reports: Readonly<Record<string, string>>[] = [];
  const reader = createDacsWalletSpendDemosReaderV1({ rpcUrl: options.url ?? stub.url, policy: POLICY });
  const rule = createDacsWalletSpendTestnetDemRecoveryV1({
    policy: POLICY,
    reader,
    readState: async () => state,
    evidenceStore: options.evidenceStore ??
      await openDacsWalletSpendDemEvidenceStoreV1(options.evidenceDirectory ?? await evidenceDirectory()),
    report: (line) => reports.push(line),
  });
  return { rule, calls: stub.calls, node: stub.state, reports };
}

/** Edits the served confirmed record in place. */
function editConfirmed(node: DemosNodeState, edit: (content: Record<string, unknown>, record: Record<string, unknown>) => void) {
  const record = node.records.get(CONFIRMED_HASH) as Record<string, unknown>;
  edit(record.content as Record<string, unknown>, record);
}

const gcrEdits = (content: Record<string, unknown>) => content.gcr_edits as Record<string, unknown>[];

const answering = (message: string, answer: DemosNodeAnswer) =>
  (call: DemosNodeCall) => (call.message === message ? answer : undefined);

describe("DEM chain rule for the testnet wallet-spend authority", () => {
  it("accepts settled only when the chain shows that exact transfer executed with its real fee", async () => {
    const hold = demHold();
    const paid = await world(stateOf(row(hold)));
    await expect(paid.rule.check(hold, settled())).resolves.toEqual({ accepted: true, reasonCode: "wallet-spend-dem-paid" });
    await expect(paid.rule.authenticateRecovery(hold, settled())).resolves.toBe(true);
    expect(paid.reports).toEqual([]);

    const noFeeHold = demHold("job-no-fee", { fee: false });
    const noFee = await world(stateOf(row(noFeeHold)));
    editConfirmed(noFee.node, (content) => {
      content.gcr_edits = gcrEdits(content).filter((edit) => edit.amount !== CONFIRMED_FEE);
    });
    await expect(noFee.rule.check(noFeeHold, settled(CONFIRMED_HASH, null)))
      .resolves.toEqual({ accepted: true, reasonCode: "wallet-spend-dem-paid" });
  });

  it("refuses settled for anything but that exact executed transfer", async () => {
    const hold = demHold();
    const refusedWith = async (
      reasonCode: string,
      setup: Readonly<{
        answer?: (call: DemosNodeCall) => DemosNodeAnswer | undefined;
        url?: string;
        edit?: Parameters<typeof editConfirmed>[1];
        reservation?: WalletSpendReservationV1;
        claim?: WalletSpendRecoveryObservationV1;
      }> = {},
    ) => {
      const reservation = setup.reservation ?? hold;
      const state = stateOf(row(reservation));
      const before = structuredClone(state);
      const subject = await world(state, setup);
      if (setup.edit !== undefined) editConfirmed(subject.node, setup.edit);
      await expect(subject.rule.check(reservation, setup.claim ?? settled()))
        .resolves.toEqual({ accepted: false, reasonCode });
      expect(state).toEqual(before);
      return subject;
    };
    const status = (body: unknown) => answering("getTransactionStatus", { status: 200, body });

    const pending = "wallet-spend-dem-transfer-pending";
    await refusedWith(pending, { answer: status({ result: 200, response: { state: "pending" } }) });
    await refusedWith(pending, { answer: status({ result: 400, response: "error" }) });
    await refusedWith(pending, { answer: status({ result: 404, response: null }) });
    await refusedWith(pending, { answer: status({ result: 200, response: { state: "not-found" } }) });
    await refusedWith(pending, { edit: (_content, record) => { record.status = "included"; } });

    await refusedWith("wallet-spend-dem-transfer-failed", { claim: settled(FAILED_HASH) });

    const mismatch = "wallet-spend-dem-transfer-mismatch";
    for (const reservation of [demHold("job-dem", { payee: "ab".repeat(32) }), demHold("job-dem", { amount: "9500000001" })]) {
      const subject = await refusedWith(mismatch, { reservation });
      expect(subject.reports).toEqual([{
        status: "hold-needs-operator", reasonCode: mismatch, reservationId: reservation.reservationId,
        transactionHash: CONFIRMED_HASH,
      }]);
    }
    const otherPayer = await refusedWith(mismatch, {
      edit: (content) => {
        content.from = `0x${"ab".repeat(32)}`;
        content.from_ed25519_address = `0x${"ab".repeat(32)}`;
      },
    });
    expect(otherPayer.reports).toHaveLength(1);

    const fee = "wallet-spend-dem-fee-mismatch";
    await refusedWith(fee, { claim: settled(CONFIRMED_HASH, "999999999") });
    await refusedWith(fee, { claim: settled(CONFIRMED_HASH, "1000000001") });
    await refusedWith(fee, { reservation: demHold("job-dem", { fee: false }), claim: settled(CONFIRMED_HASH, null) });
    await refusedWith(fee, { edit: (content) => { gcrEdits(content)[2]!.isRollback = true; } });

    for (const evidenceHash of [`0x${CONFIRMED_HASH}`, CONFIRMED_HASH.toUpperCase()]) {
      const subject = await refusedWith("wallet-spend-dem-evidence-invalid", { claim: { ...settled(), evidenceHash } });
      expect(subject.calls).toEqual([]);
    }

    const unavailable = "wallet-spend-dem-unavailable";
    await refusedWith(unavailable, { url: await closedPortUrl() });
    await refusedWith(unavailable, { answer: answering("getTransactionStatus", { status: 503, body: "" }) });
    await refusedWith(unavailable, { answer: status({ result: 500, response: "error" }) });
    await refusedWith(unavailable, {
      answer: answering("getBlockByNumber", {
        status: 200, body: { result: 200, response: { padding: "x".repeat(5 * 1024 * 1024) } },
      }),
    });
  });

  it("never releases a DEM hold on an absence claim", async () => {
    const hold = demHold();
    const leaseEndedLongAgo = { ...row(hold), leaseExpiresAt: CREATED_AT - 86_400_000 };
    for (const state of [stateOf(row(hold)), stateOf(leaseEndedLongAgo)]) {
      const subject = await world(state);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 10 * 86_400_000);
      for (const disposition of ["terminal-absent", "not-invoked"] as const) {
        await expect(subject.rule.check(hold, { disposition, evidenceHash: CONFIRMED_HASH }))
          .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-dem-absence-refused" });
      }
      await expect(subject.rule.authenticateRecovery(hold, { disposition: "terminal-absent", evidenceHash: "0".repeat(64) }))
        .resolves.toBe(false);
      vi.useRealTimers();
      expect(subject.calls).toEqual([]);
      expect(subject.reports).toEqual([{
        status: "hold-needs-operator", reasonCode: "wallet-spend-dem-absence-refused", reservationId: hold.reservationId,
      }]);
    }
  });

  it("counts one transfer for one hold only", async () => {
    const first = demHold("job-one");
    const second = demHold("job-two");
    const counted = await world(stateOf(row(first, CONFIRMED_HASH), row(second)));
    await expect(counted.rule.check(second, settled()))
      .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-dem-evidence-reused" });
    expect(counted.reports).toEqual([{
      status: "hold-needs-operator", reasonCode: "wallet-spend-dem-evidence-reused",
      reservationId: second.reservationId, transactionHash: CONFIRMED_HASH,
    }]);
    await expect(counted.rule.check(first, settled()))
      .resolves.toEqual({ accepted: true, reasonCode: "wallet-spend-dem-paid" });

    // Both claims read the chain before either is answered.
    const third = demHold("job-three");
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => { release = resolve; });
    let statusReads = 0;
    const overlapping = await world(stateOf(row(second), row(third)), {
      hold: (call) => {
        if (call.message !== "getTransactionStatus") return undefined;
        statusReads += 1;
        if (statusReads === 2) release();
        return bothRead;
      },
    });
    const answers = await Promise.all([
      overlapping.rule.check(second, settled()),
      overlapping.rule.check(third, settled()),
    ]);
    expect(answers.filter((answer) => answer.accepted)).toHaveLength(1);
    expect(answers.filter((answer) => answer.reasonCode === "wallet-spend-dem-evidence-reused")).toHaveLength(1);
  });

  it("shares transfer ownership across independent rule instances", async () => {
    const first = demHold("job-first");
    const second = demHold("job-second");
    const state = stateOf(row(first), row(second));
    const directory = await evidenceDirectory();
    let release!: () => void;
    const bothReading = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    const options = {
      evidenceDirectory: directory,
      hold: (call: DemosNodeCall) => {
        if (call.message !== "getTransactionStatus") return undefined;
        if (++reads === 2) release();
        return bothReading;
      },
    };
    const one = await world(state, options);
    const two = await world(state, options);
    const answers = await Promise.all([
      one.rule.check(first, settled()),
      two.rule.authenticateRecovery(second, settled()),
    ]);
    expect([answers[0].accepted, answers[1]].filter(Boolean)).toHaveLength(1);
    expect([...one.reports, ...two.reports]).toEqual([expect.objectContaining({
      reasonCode: "wallet-spend-dem-evidence-reused",
    })]);
    expect(state.reservations.every((stored) => stored.evidenceHash === undefined)).toBe(true);
  });

  it("keeps transfer ownership across a restart before core settlement", async () => {
    const first = demHold("job-first");
    const second = demHold("job-second");
    const state = stateOf(row(first), row(second));
    const directory = await evidenceDirectory();
    const original = await world(state, { evidenceDirectory: directory });
    await expect(original.rule.check(first, settled())).resolves.toMatchObject({ accepted: true });
    const restarted = await world(structuredClone(state), { evidenceDirectory: directory });
    await expect(restarted.rule.check(second, settled())).resolves.toEqual({
      accepted: false, reasonCode: "wallet-spend-dem-evidence-reused",
    });
    await expect(restarted.rule.check(first, settled())).resolves.toMatchObject({ accepted: true });
  });

  it("checks a retried claim again from the chain after a restart before the core recorded it", async () => {
    const hold = demHold();
    const other = demHold("job-other");
    // The core had not recorded the first acceptance, so the state still shows no transfer for either hold.
    const state = stateOf(row(hold), row(other));
    const directory = await evidenceDirectory();
    const beforeRestart = await world(state, { evidenceDirectory: directory });
    await expect(beforeRestart.rule.check(hold, settled()))
      .resolves.toEqual({ accepted: true, reasonCode: "wallet-spend-dem-paid" });

    const afterRestart = await world(state, { evidenceDirectory: directory });
    await expect(afterRestart.rule.check(hold, settled()))
      .resolves.toEqual({ accepted: true, reasonCode: "wallet-spend-dem-paid" });
    expect(afterRestart.calls.filter((call) => call.message === "getTxByHash")).toHaveLength(1);
    await expect(afterRestart.rule.check(other, settled()))
      .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-dem-evidence-reused" });
    editConfirmed(afterRestart.node, (_content, record) => { record.status = "included"; });
    await expect(afterRestart.rule.check(hold, settled()))
      .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-dem-transfer-pending" });
  });

  it.each(["fee", "payee", "absence", "pending"] as const)(
    "does not consume transfer ownership for a rejected %s claim",
    async (kind) => {
      const first = demHold("job-first", kind === "payee" ? { payee: "ab".repeat(32) } : {});
      const second = demHold("job-second");
      const state = stateOf(row(first), row(second));
      const directory = await evidenceDirectory();
      const rejected = await world(state, { evidenceDirectory: directory });
      if (kind === "pending") editConfirmed(rejected.node, (_content, record) => { record.status = "included"; });
      const observation = kind === "absence" ? { disposition: "terminal-absent" as const, evidenceHash: CONFIRMED_HASH } :
        kind === "fee" ? settled(CONFIRMED_HASH, "0") : settled();
      await expect(rejected.rule.check(first, observation)).resolves.toMatchObject({ accepted: false });
      const valid = await world(state, { evidenceDirectory: directory });
      await expect(valid.rule.authenticateRecovery(second, settled())).resolves.toBe(true);
    },
  );

  it("refuses acceptance when the evidence store cannot commit", async () => {
    const hold = demHold();
    const subject = await world(stateOf(row(hold)), {
      evidenceStore: { claim: async () => { throw new Error("storage unavailable"); } },
    });
    await expect(subject.rule.check(hold, settled()))
      .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-dem-unavailable" });
    await expect(subject.rule.authenticateRecovery(hold, settled())).resolves.toBe(false);
  });

  it("refuses DEM holds the rule cannot bind", async () => {
    const hold = demHold();
    const [service, fee] = hold.debits;
    const unbound: WalletSpendReservationV1[] = [
      { ...hold, reservationId: `pay-dem:${RAIL_ID}:other-job:0` },
      { ...hold, phase: "x402" },
      { ...hold, finality: { model: "confirmation-depth", finalityBlocks: 3 } },
      { ...hold, debits: [service!, service!] },
      { ...hold, debits: [service!, { ...fee!, expectedAmount: "1" }] },
      { ...hold, debits: [{ ...service!, asset: "USDC" }] },
      { ...hold, payee: `0x${DEMOS_PAYEE}` },
      { ...hold, payee: DEMOS_PAYEE.toUpperCase() },
    ];
    for (const reservation of unbound) {
      const subject = await world(stateOf(row(reservation)));
      await expect(subject.rule.check(reservation, settled()))
        .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-dem-hold-unbound" });
      expect(subject.calls).toEqual([]);
    }
    const missing = await world(stateOf(row(demHold("job-other"))));
    await expect(missing.rule.check(hold, settled()))
      .resolves.toEqual({ accepted: false, reasonCode: "wallet-spend-dem-hold-missing" });
    expect(missing.calls).toEqual([]);
  });
});
