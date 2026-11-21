import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WalletSpendStateV1 } from "@kynesyslabs/dacs";
import { canonicalize } from "@kynesyslabs/dacs/canonical";

import {
  dacsWalletSpendLineageKeyV1,
  dacsWalletSpendPolicyHashV1,
  type DacsPostgresWalletSpendStateStoreV1,
} from "../src/walletSpendPostgres.js";
import {
  STORES_CHAIN_ID,
  STORES_WALLET,
  directoryContents,
  openTestStores,
  privateRoot,
  removeRoot,
  stateFileNames,
  storesPolicy,
  witnessReceipts,
} from "./helpers/walletSpendFileAuthorityStores.js";

const LINEAGE = dacsWalletSpendLineageKeyV1(STORES_WALLET, STORES_CHAIN_ID);

let root: string;
let directory: string;

beforeEach(() => {
  root = privateRoot();
  directory = join(root, "authority");
});

afterEach(() => {
  removeRoot(root);
});

function headStateName(): string {
  const head = witnessReceipts(directory).at(-1);
  if (head === undefined) throw new Error("expected a witness record");
  return `${head.stateHash}.json`;
}

async function bump(store: DacsPostgresWalletSpendStateStoreV1): Promise<void> {
  if (store.transact === undefined) throw new Error("expected a store that can change state");
  await store.transact(LINEAGE, (current) => {
    if (current === null) throw new Error("expected a state");
    return { state: { ...current, generation: current.generation + 1 }, value: undefined };
  });
}

async function readState(store: DacsPostgresWalletSpendStateStoreV1): Promise<WalletSpendStateV1> {
  const state = await store.read?.(LINEAGE);
  if (state === undefined || state === null) throw new Error("expected a readable state");
  return state;
}

async function provisionWithHead(): Promise<void> {
  const stores = await openTestStores(directory);
  await bump(stores.stateStore());
  await stores.close();
}

describe("file-backed authority stores", () => {
  it("first use provisions a missing or empty directory and reopens with the same identity", async () => {
    const empty = join(root, "empty");
    mkdirSync(empty, { mode: 0o700 });
    for (const target of [directory, empty]) {
      const first = await openTestStores(target);
      const [genesis, ...later] = witnessReceipts(target);
      expect(later).toEqual([]);
      expect(genesis).toMatchObject({ revision: 0, lineageKey: LINEAGE });
      expect(stateFileNames(target)).toEqual([`${genesis?.stateHash}.json`]);
      await first.close();

      const second = await openTestStores(target);
      expect({
        verificationKey: second.verificationKey,
        lineageKey: second.lineageKey,
        policyHash: second.policyHash,
      }).toEqual({
        verificationKey: first.verificationKey,
        lineageKey: LINEAGE,
        policyHash: dacsWalletSpendPolicyHashV1(storesPolicy()),
      });
      expect(witnessReceipts(target)).toHaveLength(1);
      await second.close();
    }
  });

  it("refuses an unsafe data directory and writes nothing", async () => {
    const real = join(root, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, directory);

    await expect(openTestStores(directory)).rejects.toThrow("wallet-spend-file-directory-unsafe");
    expect(directoryContents(real)).toEqual({});
  });

  it("refuses a directory whose witness has no head but whose states directory is not empty", async () => {
    await provisionWithHead();
    const leftover = readFileSync(join(directory, "states", headStateName()), "utf8");

    rmSync(join(directory, "witness"), { recursive: true });
    const withoutWitness = directoryContents(directory);
    await expect(openTestStores(directory))
      .rejects.toThrow("wallet-spend-file-store-witness-missing");
    expect(directoryContents(directory)).toEqual(withoutWitness);

    mkdirSync(join(directory, "witness"), { mode: 0o700 });
    const emptyWitness = directoryContents(directory);
    await expect(openTestStores(directory))
      .rejects.toThrow("wallet-spend-file-store-witness-missing");
    expect(directoryContents(directory)).toEqual(emptyWitness);
    expect(Object.values(emptyWitness)).toContain(leftover);
  });

  it("refuses another authority id, epoch, seed, wallet or policy", async () => {
    await provisionWithHead();
    const before = directoryContents(directory);
    const cases = [
      [{ authorityId: "authority-other" }, "wallet-spend-file-witness-record-foreign"],
      [{ epoch: "epoch-2" }, "wallet-spend-file-witness-record-foreign"],
      [{ policy: storesPolicy({ wallet: `0x${"6f".repeat(20)}` }) },
        "wallet-spend-file-witness-record-foreign"],
      [{ seed: new Uint8Array(32).fill(12) }, "wallet-spend-file-witness-record-damaged"],
      [{ policy: storesPolicy({ maximumRetainedReservations: 11 }) },
        "wallet-spend-continuity-policy-mismatch"],
    ] as const;

    for (const [overrides, code] of cases) {
      await expect(openTestStores(directory, overrides)).rejects.toThrow(code);
    }
    expect(directoryContents(directory)).toEqual(before);
  });

  it("refuses damaged records at open and leaves the directory unchanged", async () => {
    await provisionWithHead();
    const headWitness = join(directory, "witness", "0000000000000001.json");
    const headState = join(directory, "states", headStateName());
    const original = { witness: readFileSync(headWitness, "utf8"), state: readFileSync(headState, "utf8") };
    const stored = JSON.parse(original.state) as WalletSpendStateV1;
    const signatureAt = original.witness.indexOf("\"value\":\"") + 9;
    const flipped = original.witness[signatureAt] === "A" ? "B" : "A";
    const cases = [
      ["a damaged head witness record", () => writeFileSync(headWitness,
        `${original.witness.slice(0, signatureAt)}${flipped}${original.witness.slice(signatureAt + 1)}`,
        { mode: 0o600 }), "wallet-spend-file-witness-record-damaged"],
      ["a missing head state file", () => rmSync(headState),
        "wallet-spend-continuity-state-missing"],
      ["an altered head state file", () => writeFileSync(headState,
        canonicalize({ ...stored, generation: stored.generation + 1 }), { mode: 0o600 }),
      "wallet-spend-continuity-state-damaged"],
      ["a head state file that is not canonical JSON", () => writeFileSync(headState,
        `${original.state} `, { mode: 0o600 }), "wallet-spend-continuity-state-damaged"],
    ] as const;

    for (const [label, damage, code] of cases) {
      damage();
      const damaged = directoryContents(directory);
      await expect(openTestStores(directory), label).rejects.toThrow(code);
      expect(directoryContents(directory), label).toEqual(damaged);
      writeFileSync(headWitness, original.witness, { mode: 0o600 });
      writeFileSync(headState, original.state, { mode: 0o600 });
    }
  });

  it("keeps only the head state file after reopening", async () => {
    const stores = await openTestStores(directory);
    const store = stores.stateStore();
    await bump(store);
    const older = readFileSync(join(directory, "states", headStateName()), "utf8");
    await bump(store);
    await bump(store);
    expect(stateFileNames(directory)).toHaveLength(4);
    await stores.close();
    writeFileSync(join(directory, "states", `${"f".repeat(64)}.json`), older, { mode: 0o600 });

    const reopened = await openTestStores(directory);
    expect(stateFileNames(directory)).toEqual([headStateName()]);
    expect((await readState(reopened.stateStore())).generation).toBe(3);
    expect(witnessReceipts(directory)).toHaveLength(4);
    await reopened.close();
  });

  it("a second handle opening the directory keeps a state file another handle wrote but has not witnessed", async () => {
    const twin = join(root, "twin");
    const twinStores = await openTestStores(twin);
    await bump(twinStores.stateStore());
    await bump(twinStores.stateStore());
    const pendingName = `${witnessReceipts(twin).at(-1)?.stateHash}.json`;
    await twinStores.close();

    const first = await openTestStores(directory);
    await bump(first.stateStore());
    // The file the first handle writes for its next commit, before its witness record.
    writeFileSync(join(directory, "states", pendingName),
      readFileSync(join(twin, "states", pendingName), "utf8"), { mode: 0o600 });
    const second = await openTestStores(directory);
    expect(stateFileNames(directory)).toEqual([headStateName(), pendingName].sort());

    await bump(first.stateStore());
    expect(headStateName()).toBe(pendingName);
    const reopened = await openTestStores(directory);
    expect((await readState(reopened.stateStore())).generation).toBe(2);
    await Promise.all([first.close(), second.close(), reopened.close()]);
  });

  it("two handles on one directory with interleaved commits and opens leave the head naming an existing state file", async () => {
    let active = await openTestStores(directory);
    for (let step = 0; step < 24; step += 1) {
      const [committed] = await Promise.allSettled([
        bump(active.stateStore()),
        openTestStores(directory).then((other) => other.close()),
      ]);
      expect(committed.status, `step ${step}`).toBe("fulfilled");
      expect(stateFileNames(directory), `step ${step}`).toContain(headStateName());
      await active.close();
      active = await openTestStores(directory);
    }
    expect((await readState(active.stateStore())).generation).toBe(24);
    await active.close();
  });

  it("refuses a state view after close", async () => {
    const stores = await openTestStores(directory);
    await stores.close();

    expect(() => stores.stateStore()).toThrow("wallet-spend-file-store-closed");
  });
});
