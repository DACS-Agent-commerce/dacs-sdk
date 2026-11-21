import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type WalletSpendPolicyV1,
  type WalletSpendReservationV1,
  type WalletSpendStateV1,
} from "@kynesyslabs/dacs";

import {
  createDacsWalletSpendContinuityAuthorityV2,
  createDurableDacsWalletSpendContinuityStateStoreV1,
  dacsWalletSpendLineageKeyV1,
  verifyDacsWalletSpendContinuityReceiptV1,
  type DacsPostgresWalletSpendStateStoreV1,
} from "../src/walletSpendPostgres.js";
import {
  WITNESS_AUTHORITY_ID,
  WITNESS_EPOCH,
  WITNESS_LINEAGE,
  openTestWitness,
  transitionTo,
} from "./helpers/walletSpendFileWitness.js";

const REQUEST = {
  authorityId: WITNESS_AUTHORITY_ID,
  epoch: WITNESS_EPOCH,
  lineageKey: WITNESS_LINEAGE,
  operationId: "33333333-0000-4000-8000-000000000001",
  requestHash: "c".repeat(64),
  clientNonce: "d".repeat(64),
};

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dacs-file-witness-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function revisionFiles(): string[] {
  return readdirSync(directory).sort();
}

function snapshotDirectory(): Record<string, string> {
  return Object.fromEntries(
    revisionFiles().map((name) => [name, readFileSync(join(directory, name), "utf8")]),
  );
}

async function advanceTo(revision: number): Promise<void> {
  const { witness } = await openTestWitness(directory);
  for (let index = 0; index <= revision; index += 1) {
    await witness.compareAndSet(transitionTo(index));
  }
}

function rewriteFile(name: string, change: (text: string) => string): void {
  const path = join(directory, name);
  writeFileSync(path, change(readFileSync(path, "utf8")), { mode: 0o600 });
}

function flipFirstCharacterAfter(text: string, marker: string): string {
  const at = text.indexOf(marker) + marker.length;
  const replacement = text[at] === "A" ? "B" : "A";
  return `${text.slice(0, at)}${replacement}${text.slice(at + 1)}`;
}

describe("first use", () => {
  it("reads null from an empty directory and writes revision zero with a receipt that verifies", async () => {
    const { witness, verificationKey } = await openTestWitness(directory);
    await expect(witness.readCurrent(REQUEST)).resolves.toBeNull();

    const receipt = await witness.compareAndSet(transitionTo(0));

    expect(revisionFiles()).toEqual(["0000000000000000.json"]);
    expect(verifyDacsWalletSpendContinuityReceiptV1(receipt, {
      authorityId: WITNESS_AUTHORITY_ID, epoch: WITNESS_EPOCH, verificationKey,
    })).toBe(true);
    expect(JSON.parse(readFileSync(join(directory, "0000000000000000.json"), "utf8"))).toEqual({
      recordVersion: 1, roleId: "role-a", receipt,
    });
    const current = await witness.readCurrent(REQUEST);
    expect(current).toMatchObject({
      kind: "current", revision: 0, operationId: REQUEST.operationId,
      requestHash: REQUEST.requestHash, clientNonce: REQUEST.clientNonce,
    });
    expect(verifyDacsWalletSpendContinuityReceiptV1(current, {
      authorityId: WITNESS_AUTHORITY_ID, epoch: WITNESS_EPOCH, verificationKey,
    })).toBe(true);
  });

  it("refuses a directory that is not private", async () => {
    rmSync(directory, { recursive: true });
    writeFileSync(directory, "not a directory");
    await expect(openTestWitness(directory)).rejects.toThrow("wallet-spend-file-directory-unsafe");
  });
});

describe("restart", () => {
  const wallet = `0x${"5e".repeat(20)}`;
  const policy: WalletSpendPolicyV1 = {
    policyVersion: "1", policyId: "policy-a", wallet, chainId: "chain-a",
    maximumConcurrentEffects: 1, maximumRetainedReservations: 10,
    assets: [{
      asset: "ASSET", maximumPerOrderDebit: "100", maximumNetworkFeeDebit: "10",
      minimumReserve: "10", rollingWindowMs: 60_000, maximumRollingEffects: 10,
      maximumRollingDebit: "500", maximumCumulativeDebit: "1000",
      maximumCounterpartyDebit: "500",
    }],
  };
  const reservation: WalletSpendReservationV1 = {
    reservationVersion: "1", reservationId: "file-one", jobId: "job-one", phaseIndex: 2,
    phase: "payment", agreementHash: "a".repeat(64), settlementBindingHash: "b".repeat(64),
    railId: "rail-one", railDefinitionHash: "c".repeat(64), wallet, chainId: "chain-a",
    payee: "payee-a", finality: { model: "final" },
    debits: [{ asset: "ASSET", purpose: "service", expectedAmount: "25", maximumAmount: "25" }],
  };
  const scope = dacsWalletSpendLineageKeyV1(wallet, "chain-a");

  async function openStore(states: Map<string, unknown>): Promise<DacsPostgresWalletSpendStateStoreV1> {
    const { witness, verificationKey } = await openTestWitness(directory, {
      lineageKey: scope,
    });
    const views = await createDurableDacsWalletSpendContinuityStateStoreV1({
      policy,
      continuity: {
        authorityId: WITNESS_AUTHORITY_ID, epoch: WITNESS_EPOCH, verificationKey, witness,
      },
      snapshots: {
        load: async (stateHash) => structuredClone(states.get(stateHash)),
        persist: async (stateHash, state) => { states.set(stateHash, structuredClone(state)); },
      },
    });
    return views.bind();
  }

  function authorityOver(store: DacsPostgresWalletSpendStateStoreV1) {
    return createDacsWalletSpendContinuityAuthorityV2({
      policy,
      store,
      dependencies: {
        readBalance: async () => "1000",
        authenticateRecovery: async () => true,
        owner: "file-witness-test",
        leaseDurationMs: 60_000,
        now: () => 1_000,
      },
    }).authority;
  }

  function bumpGeneration(current: Readonly<WalletSpendStateV1> | null) {
    if (current === null) throw new Error("expected a state");
    return { state: { ...current, generation: current.generation + 1 }, value: current.generation + 1 };
  }

  it("keeps the head after three advances and answers a repeated reserve as held without a new file", async () => {
    const states = new Map<string, unknown>();
    const first = await openStore(states);
    await first.transact?.(scope, bumpGeneration);
    await first.transact?.(scope, bumpGeneration);
    await expect(authorityOver(first).reserve(reservation)).resolves.toMatchObject({
      status: "reserved",
    });
    const filesBefore = revisionFiles();
    expect(filesBefore).toHaveLength(4);
    const stateBefore = await first.read?.(scope);

    const restarted = await openTestWitness(directory, { lineageKey: scope });
    await expect(restarted.witness.readCurrent({ ...REQUEST, lineageKey: scope }))
      .resolves.toMatchObject({ kind: "current", revision: 3 });

    const second = await openStore(states);
    expect(await second.read?.(scope)).toEqual(stateBefore);
    await expect(authorityOver(second).reserve(reservation)).resolves.toMatchObject({
      status: "held",
    });
    expect(revisionFiles()).toEqual(filesBefore);
  });
});

describe("damaged records", () => {
  const damageCases: ReadonlyArray<readonly [string, () => void]> = [
    ["a truncated head file", () => rewriteFile("0000000000000003.json", (text) => text.slice(0, 40))],
    ["one changed signature character", () => rewriteFile(
      "0000000000000003.json",
      (text) => flipFirstCharacterAfter(text, '"signature":{"algorithm":"ed25519","value":"'),
    )],
    ["one changed state hash character", () => rewriteFile(
      "0000000000000003.json",
      (text) => text.replace(/"stateHash":"0/, '"stateHash":"1'),
    )],
    ["a head file renamed to another revision", () => renameSync(
      join(directory, "0000000000000003.json"), join(directory, "0000000000000004.json"),
    )],
    ["a missing middle revision", () => rmSync(join(directory, "0000000000000001.json"))],
  ];

  for (const [label, damage] of damageCases) {
    it(`refuses to open with ${label} and changes no file`, async () => {
      await advanceTo(3);
      damage();
      const before = snapshotDirectory();

      await expect(openTestWitness(directory)).rejects.toThrow(
        "wallet-spend-file-witness-record-damaged",
      );

      expect(snapshotDirectory()).toEqual(before);
    });
  }

  it("refuses a later read of a record that was damaged after opening", async () => {
    await advanceTo(2);
    const { witness } = await openTestWitness(directory);
    rewriteFile("0000000000000001.json", (text) => text.slice(0, 40));
    await expect(witness.lookupAdvance({
      authorityId: WITNESS_AUTHORITY_ID, epoch: WITNESS_EPOCH, lineageKey: WITNESS_LINEAGE,
      candidateId: transitionTo(1).candidateId, roleId: "role-a",
      operationId: transitionTo(1).operationId, requestHash: transitionTo(1).requestHash,
      mutationIndex: 1,
    })).rejects.toThrow("wallet-spend-file-witness-record-damaged");
  });
});

describe("foreign records", () => {
  const foreignCases: ReadonlyArray<readonly [string, Parameters<typeof openTestWitness>[1]]> = [
    ["another epoch", { epoch: "epoch-2" }],
    ["another authority id", { authorityId: "authority-other" }],
    ["another lineage", { lineageKey: "lineage-other" }],
  ];

  for (const [label, overrides] of foreignCases) {
    it(`refuses a directory written under ${label}`, async () => {
      await advanceTo(1);
      await expect(openTestWitness(directory, overrides)).rejects.toThrow(
        "wallet-spend-file-witness-record-foreign",
      );
    });
  }

  it("refuses a directory holding an unknown file name", async () => {
    await advanceTo(1);
    writeFileSync(join(directory, "notes.txt"), "x", { mode: 0o600 });
    await expect(openTestWitness(directory)).rejects.toThrow(
      "wallet-spend-file-witness-record-foreign",
    );
  });

  it("ignores a left-over temporary file", async () => {
    await advanceTo(1);
    writeFileSync(join(directory, "0000000000000002.json.1.abc.tmp"), "{", { mode: 0o600 });
    const { witness } = await openTestWitness(directory);
    await expect(witness.readCurrent(REQUEST)).resolves.toMatchObject({ revision: 1 });
  });
});

describe("compare-and-set rules", () => {
  it("refuses a request for another authority id or epoch and reads nothing", async () => {
    const { witness } = await openTestWitness(directory);
    await expect(witness.readCurrent({ ...REQUEST, authorityId: "other" }))
      .rejects.toThrow("wallet-spend-continuity-identity-mismatch");
    await expect(witness.readCurrent({ ...REQUEST, epoch: "other" }))
      .rejects.toThrow("wallet-spend-continuity-identity-mismatch");
    await expect(witness.readCurrent({ ...REQUEST, lineageKey: "other" }))
      .rejects.toThrow("wallet-spend-continuity-identity-mismatch");
    await expect(witness.compareAndSet(transitionTo(0, { epoch: "other" })))
      .rejects.toThrow("wallet-spend-continuity-identity-mismatch");
    expect(revisionFiles()).toEqual([]);
  });

  it("refuses a wrong predecessor, a skipped revision, a second first transition and a mismatched index", async () => {
    const { witness } = await openTestWitness(directory);
    await witness.compareAndSet(transitionTo(0));
    await witness.compareAndSet(transitionTo(1));
    const files = revisionFiles();

    await expect(witness.compareAndSet(transitionTo(2, {
      predecessor: { revision: 1, stateHash: "f".repeat(64) },
    }))).rejects.toThrow("wallet-spend-continuity-conflict");
    await expect(witness.compareAndSet(transitionTo(3, {
      predecessor: { revision: 1, stateHash: transitionTo(1).next.stateHash },
    }))).rejects.toThrow("wallet-spend-continuity-conflict");
    await expect(witness.compareAndSet(transitionTo(2, {
      predecessor: { revision: 0, stateHash: transitionTo(0).next.stateHash },
    }))).rejects.toThrow("wallet-spend-continuity-conflict");
    await expect(witness.compareAndSet(transitionTo(0, { candidateId: "99999999-0000-4000-8000-000000000001" })))
      .rejects.toThrow("wallet-spend-continuity-conflict");
    await expect(witness.compareAndSet(transitionTo(2, { mutationIndex: 3 })))
      .rejects.toThrow("wallet-spend-file-witness-transition-unsupported");
    expect(revisionFiles()).toEqual(files);
  });

  it("refuses a first transition that does not start at revision zero", async () => {
    const { witness } = await openTestWitness(directory);
    await expect(witness.compareAndSet(transitionTo(0, {
      next: { revision: 1, stateHash: "1".repeat(64) }, mutationIndex: 1,
    }))).rejects.toThrow("wallet-spend-continuity-conflict");
    expect(revisionFiles()).toEqual([]);
  });
});

describe("idempotency and lookup", () => {
  const lookupFor = (revision: number) => {
    const transition = transitionTo(revision);
    return {
      authorityId: WITNESS_AUTHORITY_ID, epoch: WITNESS_EPOCH, lineageKey: WITNESS_LINEAGE,
      candidateId: transition.candidateId, roleId: transition.roleId,
      operationId: transition.operationId, requestHash: transition.requestHash,
      mutationIndex: transition.mutationIndex,
    };
  };

  it("returns the same receipt for the same transition and keeps one file", async () => {
    const { witness } = await openTestWitness(directory);
    await witness.compareAndSet(transitionTo(0));
    const first = await witness.compareAndSet(transitionTo(1));
    const again = await witness.compareAndSet(transitionTo(1));
    expect(again).toEqual(first);
    expect(revisionFiles()).toEqual(["0000000000000000.json", "0000000000000001.json"]);
  });

  it("finds an advance only by its exact identity", async () => {
    const { witness, appliedAdvance } = await openTestWitness(directory);
    await witness.compareAndSet(transitionTo(0));
    const receipt = await witness.compareAndSet(transitionTo(1));

    await expect(witness.lookupAdvance(lookupFor(1))).resolves.toEqual(receipt);
    const applied = {
      roleId: "role-a", operationId: transitionTo(1).operationId,
      requestHash: transitionTo(1).requestHash, revision: 1,
    };
    await expect(appliedAdvance(applied)).resolves.toEqual(receipt);

    const lookupChanges: ReadonlyArray<Partial<ReturnType<typeof lookupFor>>> = [
      { candidateId: "99999999-0000-4000-8000-000000000001" },
      { roleId: "role-b" },
      { operationId: "99999999-0000-4000-8000-000000000002" },
      { requestHash: "e".repeat(64) },
      { mutationIndex: 0 },
    ];
    for (const change of lookupChanges) {
      await expect(witness.lookupAdvance({ ...lookupFor(1), ...change })).resolves.toBeNull();
    }
    await expect(witness.lookupAdvance(lookupFor(2))).resolves.toBeNull();
    const appliedChanges: ReadonlyArray<Partial<typeof applied>> = [
      { roleId: "role-b" },
      { operationId: "99999999-0000-4000-8000-000000000002" },
      { requestHash: "e".repeat(64) },
      { revision: 0 },
      { revision: 2 },
    ];
    for (const change of appliedChanges) {
      await expect(appliedAdvance({ ...applied, ...change })).resolves.toBeNull();
    }
  });
});

describe("two writers on one directory", () => {
  it("issues one receipt and tells the loser of a concurrent writer on its next read", async () => {
    const first = await openTestWitness(directory);
    const second = await openTestWitness(directory);

    const outcomes = await Promise.allSettled([
      first.witness.compareAndSet(transitionTo(0)),
      second.witness.compareAndSet(transitionTo(0, {
        candidateId: "99999999-0000-4000-8000-000000000001",
      })),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toContain(
      "wallet-spend-continuity-conflict",
    );
    expect(revisionFiles()).toEqual(["0000000000000000.json"]);
    const loser = outcomes[0]?.status === "rejected" ? first : second;
    await expect(loser.witness.readCurrent(REQUEST)).rejects.toThrow(
      "wallet-spend-file-witness-concurrent-writer",
    );
    await expect(loser.witness.compareAndSet(transitionTo(1))).rejects.toThrow(
      "wallet-spend-file-witness-concurrent-writer",
    );
  });

  it("refuses a read when another writer already added the next revision", async () => {
    const stale = await openTestWitness(directory);
    const other = await openTestWitness(directory);
    await other.witness.compareAndSet(transitionTo(0));
    await expect(stale.witness.readCurrent(REQUEST)).rejects.toThrow(
      "wallet-spend-file-witness-concurrent-writer",
    );
  });

  it("gives one success and forty-nine conflicts to fifty parallel advances from one predecessor", async () => {
    const { witness } = await openTestWitness(directory);
    await witness.compareAndSet(transitionTo(0));
    const outcomes = await Promise.allSettled(Array.from({ length: 50 }, (_, index) =>
      witness.compareAndSet(transitionTo(1, {
        candidateId: `88888888-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
      }))));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const conflicts = outcomes.filter((outcome) =>
      outcome.status === "rejected" &&
      String(outcome.reason).includes("wallet-spend-continuity-conflict"));
    expect(conflicts).toHaveLength(49);
    expect(revisionFiles()).toEqual(["0000000000000000.json", "0000000000000001.json"]);
  });
});

describe("a process killed during an advance", () => {
  const children: ChildProcess[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) {
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  });

  async function crashDuringAdvance(point: "before-link" | "after-link"): Promise<void> {
    const readyPath = `${directory}.ready`;
    const packageRoot = fileURLToPath(new URL("../", import.meta.url));
    const child = spawn(process.execPath, [
      join(packageRoot, "../../node_modules/vitest/vitest.mjs"),
      "run", "test/fixtures/walletSpendFileWitnessCrash.test.ts",
      "--config", "vitest.config.ts", "--pool=forks", "--maxWorkers=1", "--reporter=dot",
    ], {
      cwd: packageRoot,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        DACS_FILE_WITNESS_CRASH_DIRECTORY: directory,
        DACS_FILE_WITNESS_CRASH_READY: readyPath,
        DACS_FILE_WITNESS_CRASH_POINT: point,
        DACS_FILE_WITNESS_CRASH_REVISION: "1",
      },
      stdio: "ignore",
    });
    children.push(child);
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const deadline = Date.now() + 120_000;
    while (!existsSync(readyPath)) {
      if (child.exitCode !== null || Date.now() > deadline) {
        throw new Error("the crash fixture exited before reaching its kill point");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    process.kill(-(child.pid as number), "SIGKILL");
    await exited;
    rmSync(readyPath);
  }

  it("keeps the old head when it dies after writing the temporary file and before the link", async () => {
    await advanceTo(0);
    await crashDuringAdvance("before-link");
    expect(revisionFiles().some((name) => name.endsWith(".tmp"))).toBe(true);

    const { witness } = await openTestWitness(directory);
    await expect(witness.readCurrent(REQUEST)).resolves.toMatchObject({ revision: 0 });
    await expect(witness.compareAndSet(transitionTo(1))).resolves.toMatchObject({ revision: 1 });
  }, 180_000);

  it("takes the new head when it dies right after the link", async () => {
    await advanceTo(0);
    await crashDuringAdvance("after-link");

    const { witness } = await openTestWitness(directory);
    await expect(witness.readCurrent(REQUEST)).resolves.toMatchObject({ revision: 1 });
    await expect(witness.compareAndSet(transitionTo(1))).resolves.toMatchObject({ revision: 1 });
  }, 180_000);
});
