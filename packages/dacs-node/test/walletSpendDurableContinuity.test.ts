import { describe, expect, it } from "vitest";

import {
  WALLET_SPEND_STATE_VERSION,
  type WalletSpendPolicyV1,
  type WalletSpendReservationV1,
  type WalletSpendStateV1,
} from "@kynesyslabs/dacs";

import {
  createDacsWalletSpendContinuityAuthorityV2,
  createDacsWalletSpendContinuitySignerV1,
  createDurableDacsWalletSpendContinuityStateStoreV1,
  createInMemoryDacsWalletSpendContinuityWitnessV1,
  dacsWalletSpendLineageKeyV1,
  dacsWalletSpendPolicyHashV1,
  verifyDacsWalletSpendContinuityReceiptV1,
  type DacsPostgresWalletSpendStateStoreV1,
  type DacsWalletSpendContinuityOperationV1,
  type DacsWalletSpendContinuityPinV1,
  type DacsWalletSpendContinuityReceiptV1,
  type DacsWalletSpendContinuitySnapshotPortV1,
  type DacsWalletSpendContinuityTransitionV1,
  type DacsWalletSpendContinuityWitnessV1,
} from "../src/walletSpendPostgres.js";

const WALLET = `0x${"5e".repeat(20)}`;
const AUTHORITY_ID = "authority-durable-test";
const EPOCH = "epoch-1";
const HASH = "a".repeat(64);
const OPERATION_ID = "11111111-1111-4111-8111-111111111111";

function policy(policyId = "policy-a"): WalletSpendPolicyV1 {
  return {
    policyVersion: "1",
    policyId,
    wallet: WALLET,
    chainId: "chain-a",
    maximumConcurrentEffects: 1,
    maximumRetainedReservations: 10,
    assets: [{
      asset: "ASSET",
      maximumPerOrderDebit: "100",
      maximumNetworkFeeDebit: "10",
      minimumReserve: "10",
      rollingWindowMs: 60_000,
      maximumRollingEffects: 10,
      maximumRollingDebit: "500",
      maximumCumulativeDebit: "1000",
      maximumCounterpartyDebit: "500",
    }],
  };
}

function reservation(): WalletSpendReservationV1 {
  return {
    reservationVersion: "1",
    reservationId: "durable-one",
    jobId: "job-one",
    phaseIndex: 2,
    phase: "payment",
    agreementHash: HASH,
    settlementBindingHash: "b".repeat(64),
    railId: "rail-one",
    railDefinitionHash: "c".repeat(64),
    wallet: WALLET,
    chainId: "chain-a",
    payee: "payee-a",
    finality: { model: "final" },
    debits: [{
      asset: "ASSET",
      purpose: "service",
      expectedAmount: "25",
      maximumAmount: "25",
    }],
  };
}

interface Faults {
  /** Rejects every compare-and-set before the witness sees it. */
  rejectAnchor?: Error;
  /** Applies the compare-and-set, then reports an error to the caller. */
  applyThenReject?: Error;
  /** Makes the exact-candidate lookup find nothing. */
  hideLookups?: boolean;
  /** Fails the next `persist`. */
  failPersist?: Error;
  /** Fails every `load`. */
  failLoad?: Error;
}

interface World {
  events: string[];
  anchors: DacsWalletSpendContinuityTransitionV1[];
  faults: Faults;
  states: Map<string, unknown>;
  inner: DacsWalletSpendContinuityWitnessV1;
  pin: DacsWalletSpendContinuityPinV1;
  port: DacsWalletSpendContinuitySnapshotPortV1;
}

function newWorld(seedByte = 7): World {
  const reference = createInMemoryDacsWalletSpendContinuityWitnessV1({
    authorityId: AUTHORITY_ID, epoch: EPOCH, seed: new Uint8Array(32).fill(seedByte),
  });
  const events: string[] = [];
  const anchors: DacsWalletSpendContinuityTransitionV1[] = [];
  const faults: Faults = {};
  const states = new Map<string, unknown>();
  const inner = reference.witness;
  const witness: DacsWalletSpendContinuityWitnessV1 = {
    readCurrent: (request) => {
      events.push("witness-read");
      return inner.readCurrent(request);
    },
    async compareAndSet(transition) {
      events.push(`anchor:${transition.next.stateHash}`);
      anchors.push(transition);
      if (faults.rejectAnchor !== undefined) throw faults.rejectAnchor;
      const receipt = await inner.compareAndSet(transition);
      if (faults.applyThenReject !== undefined) throw faults.applyThenReject;
      return receipt;
    },
    lookupAdvance: async (request) =>
      faults.hideLookups === true ? null : inner.lookupAdvance(request),
  };
  const port: DacsWalletSpendContinuitySnapshotPortV1 = {
    async load(stateHash) {
      events.push(`load:${stateHash}`);
      if (faults.failLoad !== undefined) throw faults.failLoad;
      return structuredClone(states.get(stateHash));
    },
    async persist(stateHash, state) {
      events.push(`persist-start:${stateHash}`);
      await Promise.resolve();
      if (faults.failPersist !== undefined) {
        const failure = faults.failPersist;
        delete faults.failPersist;
        throw failure;
      }
      states.set(stateHash, structuredClone(state));
      events.push(`persist-end:${stateHash}`);
    },
  };
  return {
    events, anchors, faults, states, inner, port,
    pin: {
      authorityId: AUTHORITY_ID, epoch: EPOCH,
      verificationKey: reference.verificationKey, witness,
    },
  };
}

async function open(
  world: World,
  selected: WalletSpendPolicyV1 = policy(),
): Promise<Readonly<{ bind(operation?: Readonly<DacsWalletSpendContinuityOperationV1>): DacsPostgresWalletSpendStateStoreV1 }>> {
  return createDurableDacsWalletSpendContinuityStateStoreV1({
    policy: selected, continuity: world.pin, snapshots: world.port,
  });
}

function authorityOver(store: DacsPostgresWalletSpendStateStoreV1) {
  return createDacsWalletSpendContinuityAuthorityV2({
    policy: policy(),
    store,
    dependencies: {
      readBalance: async () => "1000",
      authenticateRecovery: async () => true,
      owner: "durable-test",
      leaseDurationMs: 60_000,
      now: () => 1_000,
    },
  }).authority;
}

const scope = dacsWalletSpendLineageKeyV1(WALLET, "chain-a");

function bumpGeneration(current: Readonly<WalletSpendStateV1> | null) {
  if (current === null) throw new Error("expected a state");
  return { state: { ...current, generation: current.generation + 1 }, value: current.generation + 1 };
}

async function readState(store: DacsPostgresWalletSpendStateStoreV1): Promise<WalletSpendStateV1> {
  const state = await store.read?.(scope);
  if (state === undefined || state === null) throw new Error("expected a readable state");
  return state;
}

async function bump(store: DacsPostgresWalletSpendStateStoreV1): Promise<number> {
  if (store.transact === undefined) throw new Error("expected a store that can change state");
  return store.transact(scope, bumpGeneration);
}

async function reserveOnce(world: World): Promise<DacsPostgresWalletSpendStateStoreV1> {
  const store = (await open(world)).bind();
  await expect(authorityOver(store).reserve(reservation())).resolves.toMatchObject({
    status: "reserved",
  });
  return store;
}

function headHash(world: World): string {
  const last = [...world.anchors].reverse()[0];
  if (last === undefined) throw new Error("expected an anchor");
  return last.next.stateHash;
}

describe("durable continuity state store", () => {
  describe("signer", () => {
    it("signs receipts that verify under its verification key", () => {
      const signer = createDacsWalletSpendContinuitySignerV1({ seed: new Uint8Array(32).fill(3) });
      const receipt: DacsWalletSpendContinuityReceiptV1 = signer.sign({
        receiptVersion: "1", kind: "current", authorityId: AUTHORITY_ID, epoch: EPOCH,
        lineageKey: scope, revision: 0, stateHash: HASH, operationId: OPERATION_ID,
        requestHash: HASH, clientNonce: HASH, candidateId: null, mutationIndex: null,
        priorRevision: null, priorStateHash: null,
      });
      expect(verifyDacsWalletSpendContinuityReceiptV1(receipt, {
        authorityId: AUTHORITY_ID, epoch: EPOCH, verificationKey: signer.verificationKey,
      })).toBe(true);
    });

    it("refuses a seed that is not 32 bytes", () => {
      expect(() => createDacsWalletSpendContinuitySignerV1({ seed: new Uint8Array(31) }))
        .toThrow("wallet-spend-continuity-seed-invalid");
    });

    it("gives the in-memory witness the same key as a signer from the same seed", () => {
      const seed = new Uint8Array(32).fill(9);
      expect(createInMemoryDacsWalletSpendContinuityWitnessV1({
        authorityId: AUTHORITY_ID, epoch: EPOCH, seed,
      }).verificationKey).toBe(createDacsWalletSpendContinuitySignerV1({ seed }).verificationKey);
    });
  });

  describe("restart", () => {
    it("reopens with the state the witness head names and answers a repeated reserve as held", async () => {
      const world = newWorld();
      const first = await reserveOnce(world);
      const before = await readState(first);

      const second = (await open(world)).bind();
      expect(await readState(second)).toEqual(before);
      await expect(authorityOver(second).reserve(reservation())).resolves.toMatchObject({
        status: "held",
      });
      expect((await readState(second)).generation).toBe(before.generation);
    });

    it("reopens at the latest state after several changes", async () => {
      const world = newWorld();
      const first = (await open(world)).bind();
      await bump(first);
      await bump(first);
      await bump(first);

      const second = (await open(world)).bind();
      expect((await readState(second)).generation).toBe(3);
    });

    it("ignores a snapshot whose anchor never happened", async () => {
      const world = newWorld();
      const first = (await open(world)).bind();
      world.faults.rejectAnchor = new Error("wallet-spend-continuity-conflict");
      await expect(bump(first))
        .rejects.toThrow("wallet-spend-continuity-conflict");
      expect(world.states.size).toBe(2);
      delete world.faults.rejectAnchor;

      const second = (await open(world)).bind();
      expect((await readState(second)).generation).toBe(0);
    });
  });

  describe("write order", () => {
    it("completes the snapshot write before the witness anchor for provisioning and for a change", async () => {
      const world = newWorld();
      const store = (await open(world)).bind();
      await bump(store);

      const hashes = world.anchors.map((anchor) => anchor.next.stateHash);
      expect(hashes).toHaveLength(2);
      for (const hash of hashes) {
        const written = world.events.indexOf(`persist-end:${hash}`);
        const anchored = world.events.indexOf(`anchor:${hash}`);
        expect(written).toBeGreaterThanOrEqual(0);
        expect(anchored).toBeGreaterThan(written);
      }
    });

    it("refuses with snapshot-unavailable and does not anchor when the snapshot write fails", async () => {
      const world = newWorld();
      const store = (await open(world)).bind();
      const anchorsBefore = world.anchors.length;
      const before = await readState(store);
      world.faults.failPersist = new Error("disk full");

      await expect(bump(store))
        .rejects.toThrow("wallet-spend-continuity-snapshot-unavailable");
      expect(world.anchors).toHaveLength(anchorsBefore);
      expect(await readState(store)).toEqual(before);
    });

    it("refuses with snapshot-unavailable when the first snapshot write fails", async () => {
      const world = newWorld();
      world.faults.failPersist = new Error("disk full");

      await expect(open(world)).rejects.toThrow("wallet-spend-continuity-snapshot-unavailable");
      expect(world.anchors).toHaveLength(0);
    });

    it("keeps the old state when the witness refuses the anchor", async () => {
      const world = newWorld();
      const store = (await open(world)).bind();
      const before = await readState(store);
      world.faults.rejectAnchor = new Error("wallet-spend-continuity-conflict");

      await expect(bump(store))
        .rejects.toThrow("wallet-spend-continuity-conflict");
      delete world.faults.rejectAnchor;
      expect(await readState(store)).toEqual(before);
    });

    it("refuses every later call after an anchor outcome cannot be resolved, until reopened", async () => {
      const world = newWorld();
      const store = (await open(world)).bind();
      world.faults.applyThenReject = new Error("connection reset");
      world.faults.hideLookups = true;

      await expect(bump(store))
        .rejects.toThrow("wallet-spend-continuity-outcome-unresolved");
      delete world.faults.applyThenReject;
      delete world.faults.hideLookups;
      await expect(readState(store)).rejects.toThrow("wallet-spend-continuity-head-mismatch");

      const reopened = (await open(world)).bind();
      expect((await readState(reopened)).generation).toBe(1);
    });
  });

  describe("opening over a recorded head", () => {
    async function headedWorld(): Promise<World> {
      const world = newWorld();
      await reserveOnce(world);
      return world;
    }

    it("refuses when the snapshot for the head is missing, and does not anchor", async () => {
      const world = await headedWorld();
      world.states.delete(headHash(world));
      const anchorsBefore = world.anchors.length;

      await expect(open(world)).rejects.toThrow("wallet-spend-continuity-state-missing");
      expect(world.anchors).toHaveLength(anchorsBefore);
      expect(world.events.at(-1)).toBe(`load:${headHash(world)}`);
    });

    it("refuses a snapshot whose content was altered", async () => {
      const world = await headedWorld();
      const stored = world.states.get(headHash(world)) as WalletSpendStateV1;
      world.states.set(headHash(world), {
        ...stored,
        reservations: stored.reservations.map((row) => ({ ...row, updatedAt: row.updatedAt + 1 })),
      });

      await expect(open(world)).rejects.toThrow("wallet-spend-continuity-state-damaged");
    });

    it("refuses a snapshot with another generation", async () => {
      const world = await headedWorld();
      const stored = world.states.get(headHash(world)) as WalletSpendStateV1;
      world.states.set(headHash(world), { ...stored, generation: stored.generation + 1 });

      await expect(open(world)).rejects.toThrow("wallet-spend-continuity-state-damaged");
    });

    it("refuses a snapshot that is not a state at all", async () => {
      const world = await headedWorld();
      world.states.set(headHash(world), { generation: "one" });

      await expect(open(world)).rejects.toThrow("wallet-spend-continuity-state-damaged");
    });

    it("refuses a snapshot written for another policy", async () => {
      const world = await headedWorld();
      const stored = world.states.get(headHash(world)) as WalletSpendStateV1;
      world.states.set(headHash(world), {
        ...stored,
        policyHash: dacsWalletSpendPolicyHashV1(policy("policy-b")),
      });

      await expect(open(world)).rejects.toThrow("wallet-spend-continuity-policy-mismatch");
    });

    it("passes on the error the snapshot port throws when loading", async () => {
      const world = await headedWorld();
      world.faults.failLoad = new Error("port offline");

      await expect(open(world)).rejects.toThrow("port offline");
    });

    it("refuses a head receipt that was not signed by the pinned key", async () => {
      const world = await headedWorld();
      const other = createInMemoryDacsWalletSpendContinuityWitnessV1({
        authorityId: AUTHORITY_ID, epoch: EPOCH, seed: new Uint8Array(32).fill(99),
      });
      world.pin = { ...world.pin, verificationKey: other.verificationKey };

      await expect(open(world)).rejects.toThrow("wallet-spend-continuity-head-mismatch");
    });

    it("refuses a head receipt that is for another lineage", async () => {
      const world = await headedWorld();
      const witness = world.pin.witness;
      const signer = createDacsWalletSpendContinuitySignerV1({ seed: new Uint8Array(32).fill(7) });
      world.pin = {
        ...world.pin,
        witness: {
          ...witness,
          async readCurrent(request) {
            const receipt = await witness.readCurrent(request);
            if (receipt === null) return null;
            const { signature: _signature, ...statement } = receipt;
            return signer.sign({ ...statement, lineageKey: "another-lineage" });
          },
        },
      };

      await expect(open(world)).rejects.toThrow("wallet-spend-continuity-head-mismatch");
    });
  });

  describe("bound operation", () => {
    const operation: DacsWalletSpendContinuityOperationV1 = {
      roleId: "buyer", operationId: OPERATION_ID, requestHash: "d".repeat(64),
    };

    it("anchors a change under the bound role, operation id and request hash", async () => {
      const world = newWorld();
      const store = (await open(world)).bind(operation);
      await bump(store);

      const anchor = world.anchors.at(-1);
      expect(anchor).toMatchObject({ ...operation, mutationIndex: 1 });
      const found = await world.inner.lookupAdvance({
        authorityId: AUTHORITY_ID, epoch: EPOCH, lineageKey: scope,
        candidateId: anchor?.candidateId ?? "", roleId: operation.roleId,
        operationId: operation.operationId, requestHash: operation.requestHash,
        mutationIndex: 1,
      });
      expect(found).toMatchObject({
        kind: "advance", revision: 1, mutationIndex: 1,
        operationId: operation.operationId, requestHash: operation.requestHash,
      });
    });

    it("keeps the reference identity for a view with no bound operation", async () => {
      const world = newWorld();
      const store = (await open(world)).bind();
      await bump(store);

      expect(world.anchors.at(-1)).toMatchObject({ roleId: "reference:mutation", mutationIndex: 1 });
    });

    it("shares one state between views", async () => {
      const world = newWorld();
      const opened = await open(world);
      const first = opened.bind(operation);
      const second = opened.bind();
      await bump(first);

      expect((await readState(second)).generation).toBe(1);
    });

    it.each([
      ["an empty role", { ...operation, roleId: "" }],
      ["a padded role", { ...operation, roleId: " buyer" }],
      ["an operation id that is not a UUID", { ...operation, operationId: "not-a-uuid" }],
      ["a request hash that is not a hash", { ...operation, requestHash: "XYZ" }],
    ])("refuses to bind %s", async (_label, invalid) => {
      const opened = await open(newWorld());

      expect(() => opened.bind(invalid))
        .toThrow("wallet-spend-continuity-operation-identity-invalid");
    });
  });

  describe("official store brand", () => {
    it("accepts a bound view and refuses a plain object or a copy of a view", async () => {
      const world = newWorld();
      const view = (await open(world)).bind();
      const dependencies = {
        readBalance: async () => "1000",
        authenticateRecovery: async () => true,
      };

      expect(createDacsWalletSpendContinuityAuthorityV2({
        policy: policy(), store: view, dependencies,
      }).authority.policyHash).toBe(dacsWalletSpendPolicyHashV1(policy()));
      const plain: DacsPostgresWalletSpendStateStoreV1 = {
        lineageScope: () => scope,
        read: async () => ({
          stateVersion: WALLET_SPEND_STATE_VERSION, policyHash: HASH, generation: 0,
          reservations: [], totals: [], rollingEvents: [],
        }),
        transact: async () => { throw new Error("unused"); },
        attestCurrent: view.attestCurrent,
      };
      expect(() => createDacsWalletSpendContinuityAuthorityV2({
        policy: policy(), store: plain, dependencies,
      })).toThrow("wallet-spend-continuity-official-store-required");
      expect(() => createDacsWalletSpendContinuityAuthorityV2({
        policy: policy(), store: { ...view }, dependencies,
      })).toThrow("wallet-spend-continuity-official-store-required");
    });
  });
});
