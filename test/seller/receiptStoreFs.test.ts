import { spawn, type ChildProcess } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import {
  SELLER_RECEIPT_STORE_VERSION as ROOT_SELLER_RECEIPT_STORE_VERSION,
  createFsSellerReceiptStore as createRootFsSellerReceiptStore,
} from "../../src/index.js";
import {
  sellerFulfilmentCandidateHash,
  type SellerFulfilmentHandoff,
  type SellerPaymentAuthorization,
  type SellerPaymentEvidenceInput,
  type SellerReceiptClaim,
} from "../../src/seller/paymentIntake.js";
import {
  sellerFulfilmentAuditSourceHash,
  type SellerFulfilmentAuditSourceV1,
} from "../../src/seller/fulfilmentAuditSource.js";
import {
  SELLER_RECEIPT_STORE_VERSION as SELLER_SURFACE_RECEIPT_STORE_VERSION,
  createFsSellerReceiptStore as createSellerSurfaceFsSellerReceiptStore,
} from "../../src/seller/index.js";
import {
  SELLER_RECEIPT_STORE_VERSION,
  createFsSellerReceiptStore,
} from "../../src/seller/receiptStoreFs.js";

const STATE_FILE = "seller-receipts.json";
const INITIALIZATION_FILE = "seller-receipts.initialized";
const INITIALIZATION_TEXT = JSON.stringify({
  markerVersion: 1,
  stateFile: STATE_FILE,
});
const LOCK_DIR = "seller-receipts.lock";
const SETTLEMENT = `demos:${"ef".repeat(32)}`;
const dirs: string[] = [];
const children = new Set<ChildProcess>();

const delay = async (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function tempStoreDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dacs-seller-receipts-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function receiptClaim(overrides: Partial<{
  settlementId: string;
  jobId: string;
  phaseIndex: number;
  observedAt: number;
}> = {}): SellerReceiptClaim {
  const settlementId = overrides.settlementId ?? SETTLEMENT;
  const jobId = overrides.jobId ?? "job-store-fs";
  const phaseIndex = overrides.phaseIndex ?? 1;
  const observedAt = overrides.observedAt ?? 5_000;
  const evm = /^evm:(\d+):([0-9a-fA-F]{64}):(\d+)$/.exec(settlementId);
  const demos = /^demos:([0-9a-fA-F]{64})$/.exec(settlementId);
  if (!evm && !demos) throw new TypeError("fixture requires a canonical settlement id");
  const chainId = evm ? Number(evm[1]) : undefined;
  const txHash = evm ? evm[2]! : demos![1]!;
  const logIndex = evm ? Number(evm[3]) : undefined;
  const evidenceInput: SellerPaymentEvidenceInput = evm
    ? {
        evidenceVersion: "1",
        jobId,
        phase: "pay-x402",
        outcome: "success",
        paymentTxRefs: [{
          kind: "x402-event",
          httpResource: "https://seller.example/pay/store-test",
          paymentReceiptHash: "dd".repeat(32),
          settlementTxHash: txHash,
          chainId: chainId!,
          logIndex: logIndex!,
          protocolVersion: "2",
        }],
        paymentAmount: { amount: "1", currency: "USDC" },
        settlementFinality: {
          model: "block-depth",
          finalityBlocks: 1,
          finalityObservedAt: observedAt,
        },
        observedAt,
      }
    : {
        evidenceVersion: "1",
        jobId,
        phase: "pay-dem",
        outcome: "success",
        paymentTxRefs: [{ kind: "demos", txHash, blockNumber: 1 }],
        paymentAmount: { amount: "1", currency: "DEM" },
        settlementFinality: { model: "bft-final", finalityObservedAt: observedAt },
        observedAt,
      };
  const evidenceHash = sha256Hex(canonicalize(evidenceInput));
  const authorization: SellerPaymentAuthorization = {
    jobId,
    phaseIndex,
    agreementHash: "aa".repeat(32),
    listingRef: {
      listingId: "listing-store-test",
      version: 1,
      contentHash: "bb".repeat(32),
    },
    railId: evm ? "x402:default" : "demos-native:DEM",
    railRegistryVersion: 7,
    commitment: {
      ref: `dacs3:commitment:${jobId}`,
      contentHash: "cc".repeat(32),
      finalizedAt: 0,
      signer: "did:demos:agent:commitment-authority",
    },
    settlementIdentity: evm
      ? {
          kind: "evm",
          chainId: chainId!,
          txHash,
          logIndex: logIndex!,
          includedAt: observedAt,
        }
      : { kind: "demos", txHash, blockNumber: 1, includedAt: observedAt },
    settlementId,
    evidenceHash,
    evidenceInput,
    payoutBindingTier: 1,
  };
  return { settlementId, jobId, phaseIndex, observedAt, evidenceHash, authorization };
}

function handoff(claim: SellerReceiptClaim, artifactValue = 42): SellerFulfilmentHandoff {
  const artifact = {
    kind: "deliver-storage-program",
    cleartextPayload: { value: artifactValue },
    anchoredValue: { value: artifactValue },
    access: { model: "public" },
  };
  const base = {
    fulfilmentId: `fulfilment:${claim.jobId}:${claim.phaseIndex + 1}`,
    jobId: claim.jobId,
    agreementRef: `agreement:${claim.jobId}`,
    agreementHash: claim.authorization.agreementHash,
    commitmentRef: claim.authorization.commitment.ref,
    authorizationHash: sha256Hex(canonicalize(claim.authorization)),
    settlementId: claim.settlementId,
    paymentEvidenceHash: claim.evidenceHash,
    paymentPhaseIndex: claim.phaseIndex,
    deliveryPhaseIndex: claim.phaseIndex + 1,
    phase: "deliver-storage-program" as const,
    logicalAddress: `dacs4:deliverable:${claim.jobId}`,
    deliverableSpecHash: "dd".repeat(32),
    agreementViewHash: "ee".repeat(32),
    validationFloorAt: Math.max(
      claim.authorization.commitment.finalizedAt,
      claim.observedAt,
    ),
    deliveryInvokedAt: claim.observedAt,
    evidenceAuthority: {
      primaryClaim: "did:demos:seller",
      algorithm: "ed25519" as const,
    },
    candidate: {
      status: "prepared" as const,
      validatedAt: claim.observedAt,
      artifactHash: sha256Hex(canonicalize(artifact)),
      delivery: { artifact },
    },
  };
  const pipeline = [
    { kind: "negotiate-fixed-price" as const },
    {
      kind: claim.authorization.evidenceInput.phase,
      parameters: { rail: claim.authorization.railId },
    },
    { kind: "deliver-storage-program" as const },
  ];
  const paymentRef = {
    anchor: {
      kind: "storage-program" as const,
      locator: `dacs4:payment:${claim.jobId}:${claim.phaseIndex}`,
    },
    contentHash: claim.evidenceHash,
  };
  const auditSource: SellerFulfilmentAuditSourceV1 = {
    sourceVersion: "1" as const,
    session: {
      recordVersion: "1" as const,
      jobId: claim.jobId,
      state: "settle-pending",
      listingRef: structuredClone(claim.authorization.listingRef),
      parties: [
        { role: "buyer" as const, bundleHash: "1".repeat(64), primaryClaim: "did:demos:buyer" },
        { role: "seller" as const, bundleHash: "2".repeat(64), primaryClaim: "did:demos:seller" },
        { role: "orchestrator" as const, bundleHash: "2".repeat(64), primaryClaim: "did:demos:seller" },
      ],
      pipeline,
      phaseResults: [
        {
          index: 0,
          step: structuredClone(pipeline[0]!),
          invokedAt: Math.max(0, claim.observedAt - 1),
          result: { ok: true, contextDelta: {} },
          contextDelta: {},
        },
        {
          index: claim.phaseIndex,
          step: structuredClone(pipeline[claim.phaseIndex]!),
          invokedAt: claim.observedAt,
          result: {
            ok: true,
            txRefs: structuredClone(claim.authorization.evidenceInput.paymentTxRefs),
            attestationRef: structuredClone(paymentRef),
            contextDelta: {},
          },
          contextDelta: {},
        },
      ],
      startedAt: Math.max(0, claim.observedAt - 2),
      lastUpdatedAt: claim.observedAt,
      recipeRegistryVersion: 1,
      railRegistryVersion: claim.authorization.railRegistryVersion,
    },
    artifacts: {
      agreementCommitment: {
        anchor: { kind: "storage-program" as const, locator: claim.authorization.commitment.ref },
        contentHash: claim.authorization.commitment.contentHash,
      },
      vetRecords: [],
      vetRequirements: [],
      settlementEvidence: [structuredClone(paymentRef)],
    },
    provenanceProfile: "dacs-sdk-operational-v1" as const,
  };
  const auditSourceHash = sellerFulfilmentAuditSourceHash(auditSource);
  return {
    ...base,
    handoffVersion: "2",
    auditSource,
    auditSourceHash,
    auditSourceCommitment: {
      commitmentVersion: "1",
      fulfilmentId: base.fulfilmentId,
      jobId: base.jobId,
      agreementRef: base.agreementRef,
      agreementHash: base.agreementHash,
      commitmentRef: base.commitmentRef,
      authorizationHash: base.authorizationHash,
      paymentPhaseIndex: base.paymentPhaseIndex,
      deliveryPhaseIndex: base.deliveryPhaseIndex,
      phase: base.phase,
      logicalAddress: base.logicalAddress,
      deliverableSpecHash: base.deliverableSpecHash,
      auditSourceHash,
      candidateHash: sellerFulfilmentCandidateHash(base.candidate),
      deliveryInvokedAt: base.deliveryInvokedAt,
      signature: { algorithm: "ed25519", signer: "did:demos:seller", value: "c2ln" },
    },
  };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (true) {
    try {
      await access(path);
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error("timed out waiting for child process");
      await delay(5);
    }
  }
}

async function childExit(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      children.delete(child);
      if (code === 0) resolve();
      else reject(new Error(`child exited with ${String(code)} (${String(signal)})`));
    });
  });
}

describe("filesystem seller receipt store", () => {
  test("is exported from both public seller surfaces", () => {
    expect(createRootFsSellerReceiptStore).toBe(createFsSellerReceiptStore);
    expect(createSellerSurfaceFsSellerReceiptStore).toBe(createFsSellerReceiptStore);
    expect(ROOT_SELLER_RECEIPT_STORE_VERSION).toBe(SELLER_RECEIPT_STORE_VERSION);
    expect(SELLER_SURFACE_RECEIPT_STORE_VERSION).toBe(SELLER_RECEIPT_STORE_VERSION);
  });

  test("rejects proxy options without invoking traps and rejects a symlinked root", async () => {
    const dir = await tempStoreDir();
    let trapCalls = 0;
    const options = new Proxy({ dir }, {
      getPrototypeOf() {
        trapCalls += 1;
        return Object.prototype;
      },
      ownKeys(target) {
        trapCalls += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, key) {
        trapCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    await expect(createFsSellerReceiptStore(options)).rejects.toThrow(/plain object/);
    expect(trapCalls).toBe(0);

    let accessorReads = 0;
    const accessorOptions: Record<string, unknown> = {};
    Object.defineProperty(accessorOptions, "dir", {
      enumerable: true,
      get() {
        accessorReads += 1;
        return dir;
      },
    });
    await expect(createFsSellerReceiptStore(
      accessorOptions as unknown as { dir: string },
    )).rejects.toThrow(/data property/);
    expect(accessorReads).toBe(0);

    const container = await tempStoreDir();
    const linkedRoot = join(container, "linked-root");
    await symlink(dir, linkedRoot);
    await expect(createFsSellerReceiptStore({ dir: linkedRoot })).rejects.toThrow(
      /safe directory/,
    );
  });

  test("never imports foreign bearer authority through a symlinked state file", async () => {
    const foreignDir = await tempStoreDir();
    const foreignStore = await createFsSellerReceiptStore({ dir: foreignDir });
    const claimed = await foreignStore.claim(receiptClaim());
    if (claimed.status !== "claimed") throw new Error("fixture");

    const localDir = await tempStoreDir();
    const localStore = await createFsSellerReceiptStore({ dir: localDir });
    await symlink(join(foreignDir, STATE_FILE), join(localDir, STATE_FILE));
    await expect(localStore.inspectPermit(claimed.permitId)).rejects.toThrow(/unsafe/);
    await expect(localStore.claim(receiptClaim())).rejects.toThrow(/unsafe/);
    expect(await readFile(join(localDir, STATE_FILE), "utf8"))
      .toBe(await readFile(join(foreignDir, STATE_FILE), "utf8"));
  });

  test("cold restart retains a pending permit and the exact consumed handoff", async () => {
    const dir = await tempStoreDir();
    const claim = receiptClaim();
    const firstStore = await createFsSellerReceiptStore({ dir });
    const first = await firstStore.claim(claim);
    expect(first.status).toBe("claimed");
    if (first.status !== "claimed") throw new Error("fixture");
    expect(first.permitId).toMatch(/^seller-payment:[A-Za-z0-9_-]{43}$/);

    const restarted = await createFsSellerReceiptStore({ dir });
    expect(await restarted.inspectPermit(first.permitId)).toEqual({
      status: "available",
      claim,
    });
    const retainedHandoff = handoff(claim);
    expect(await restarted.consumePermit(first.permitId, retainedHandoff)).toEqual({
      status: "consumed",
      claim,
      handoff: retainedHandoff,
    });

    const coldRestart = await createFsSellerReceiptStore({ dir });
    const recovered = await coldRestart.inspectPermit(first.permitId);
    expect(recovered).toEqual({
      status: "already-consumed",
      claim,
      handoff: retainedHandoff,
    });
    if (recovered.status !== "already-consumed") throw new Error("fixture");
    recovered.claim.jobId = "mutated-return-value";
    expect(await coldRestart.inspectPermit(first.permitId)).toMatchObject({
      status: "already-consumed",
      claim: { jobId: claim.jobId },
    });
  });

  test("fails closed after initialized state is deleted instead of issuing a new permit", async () => {
    const dir = await tempStoreDir();
    const claim = receiptClaim();
    const firstStore = await createFsSellerReceiptStore({ dir });
    const first = await firstStore.claim(claim);
    if (first.status !== "claimed") throw new Error("fixture");
    expect(await readFile(join(dir, INITIALIZATION_FILE), "utf8"))
      .toBe(INITIALIZATION_TEXT);

    await unlink(join(dir, STATE_FILE));
    const restarted = await createFsSellerReceiptStore({ dir });
    await expect(restarted.inspectPermit(first.permitId)).rejects.toThrow(
      "filesystem seller receipt store state is corrupt",
    );
    await expect(restarted.claim(claim)).rejects.toThrow(
      "filesystem seller receipt store state is corrupt",
    );
    await expect(access(join(dir, STATE_FILE))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(dir, INITIALIZATION_FILE), "utf8"))
      .toBe(INITIALIZATION_TEXT);
  });

  test("migrates a valid legacy or post-state crash file before returning authority", async () => {
    const dir = await tempStoreDir();
    const claim = receiptClaim();
    const firstStore = await createFsSellerReceiptStore({ dir });
    const first = await firstStore.claim(claim);
    if (first.status !== "claimed") throw new Error("fixture");

    // Version 1 state predates the marker. This is also the only safe crash
    // point during first initialization: durable state exists, marker does not.
    await unlink(join(dir, INITIALIZATION_FILE));
    const restarted = await createFsSellerReceiptStore({ dir });
    await expect(restarted.inspectPermit(first.permitId)).resolves.toEqual({
      status: "available",
      claim,
    });
    expect(await readFile(join(dir, INITIALIZATION_FILE), "utf8"))
      .toBe(INITIALIZATION_TEXT);
    expect((await stat(join(dir, INITIALIZATION_FILE))).mode & 0o777).toBe(0o600);
  });

  test("rejects marker-only, symlinked, corrupt, and non-file initialization state", async () => {
    const freshDir = await tempStoreDir();
    const freshStore = await createFsSellerReceiptStore({ dir: freshDir });
    await expect(freshStore.inspectPermit("never-issued")).resolves.toEqual({ status: "invalid" });
    expect(await readdir(freshDir)).toEqual([]);

    const sourceDir = await tempStoreDir();
    const sourceStore = await createFsSellerReceiptStore({ dir: sourceDir });
    const sourceClaim = await sourceStore.claim(receiptClaim());
    if (sourceClaim.status !== "claimed") throw new Error("fixture");
    const markerText = await readFile(join(sourceDir, INITIALIZATION_FILE), "utf8");

    const markerOnlyDir = await tempStoreDir();
    await writeFile(join(markerOnlyDir, INITIALIZATION_FILE), markerText, { mode: 0o600 });
    const markerOnlyStore = await createFsSellerReceiptStore({ dir: markerOnlyDir });
    await expect(markerOnlyStore.claim(receiptClaim())).rejects.toThrow(/state is corrupt/);
    await expect(access(join(markerOnlyDir, STATE_FILE))).rejects.toMatchObject({ code: "ENOENT" });

    const symlinkDir = await tempStoreDir();
    const symlinkStore = await createFsSellerReceiptStore({ dir: symlinkDir });
    await symlink(join(sourceDir, INITIALIZATION_FILE), join(symlinkDir, INITIALIZATION_FILE));
    await expect(symlinkStore.inspectPermit(sourceClaim.permitId)).rejects.toThrow(/unsafe/);

    const corruptDir = await tempStoreDir();
    const corruptStore = await createFsSellerReceiptStore({ dir: corruptDir });
    await writeFile(join(corruptDir, INITIALIZATION_FILE), "{not-marker", { mode: 0o600 });
    await expect(corruptStore.claim(receiptClaim())).rejects.toThrow(/marker is corrupt/);

    const nonFileDir = await tempStoreDir();
    const nonFileStore = await createFsSellerReceiptStore({ dir: nonFileDir });
    await mkdir(join(nonFileDir, INITIALIZATION_FILE), { mode: 0o700 });
    await expect(nonFileStore.claim(receiptClaim())).rejects.toThrow(/marker is corrupt/);
  });

  test("serializes concurrent stores and atomically selects the SB-2 winner", async () => {
    const dir = await tempStoreDir();
    const stores = await Promise.all([
      createFsSellerReceiptStore({ dir }),
      createFsSellerReceiptStore({ dir }),
    ]);
    const later = receiptClaim({ jobId: "job-later", observedAt: 6_000 });
    const earlier = receiptClaim({ jobId: "job-earlier", observedAt: 4_000 });
    const results = await Promise.all([
      stores[0].claim(later),
      stores[1].claim(earlier),
    ]);
    const retry = await stores[0].claim(earlier);
    expect(retry).toMatchObject({
      status: "already-claimed",
      claim: { jobId: "job-earlier", observedAt: 4_000 },
    });
    if (retry.status !== "already-claimed") throw new Error("fixture");

    for (const result of results) {
      if ((result.status === "claimed" || result.status === "already-claimed") &&
          result.permitId !== retry.permitId) {
        expect(await stores[0].inspectPermit(result.permitId)).toEqual({ status: "invalid" });
      }
    }
    await expect(stores[1].consumePermit(retry.permitId, handoff(earlier)))
      .resolves.toMatchObject({ status: "consumed", claim: { jobId: "job-earlier" } });
  });

  test("gives concurrent exact claims one unpredictable permit", async () => {
    const dir = await tempStoreDir();
    const stores = await Promise.all(Array.from(
      { length: 8 },
      () => createFsSellerReceiptStore({ dir }),
    ));
    const claim = receiptClaim();
    const results = await Promise.all(stores.map((store) => store.claim(claim)));
    expect(results.filter((result) => result.status === "claimed")).toHaveLength(1);
    expect(results.filter((result) => result.status === "already-claimed")).toHaveLength(7);
    const permits = results.flatMap((result) =>
      result.status === "claimed" || result.status === "already-claimed"
        ? [result.permitId]
        : []);
    expect(new Set(permits).size).toBe(1);
  });

  test("retains one handoff under competing consumption and response-loss replay", async () => {
    const dir = await tempStoreDir();
    const firstStore = await createFsSellerReceiptStore({ dir });
    const claim = receiptClaim();
    const claimed = await firstStore.claim(claim);
    if (claimed.status !== "claimed") throw new Error("fixture");
    const stores = await Promise.all([
      createFsSellerReceiptStore({ dir }),
      createFsSellerReceiptStore({ dir }),
    ]);
    const proposed = [handoff(claim, 1), handoff(claim, 2)] as const;
    const consumed = await Promise.all([
      stores[0].consumePermit(claimed.permitId, proposed[0]),
      stores[1].consumePermit(claimed.permitId, proposed[1]),
    ]);
    expect(consumed.filter((result) => result.status === "consumed")).toHaveLength(1);
    expect(consumed.filter((result) => result.status === "already-consumed")).toHaveLength(1);
    if (consumed[0].status === "invalid" || consumed[1].status === "invalid") {
      throw new Error("fixture");
    }
    expect(consumed[0].handoff).toEqual(consumed[1].handoff);

    // Simulate a committed consume whose response was lost to the caller.
    const restarted = await createFsSellerReceiptStore({ dir });
    expect(await restarted.consumePermit(claimed.permitId, handoff(claim, 999)))
      .toEqual({
        status: "already-consumed",
        claim,
        handoff: consumed[0].handoff,
      });
    const laterObservation = receiptClaim({ observedAt: 6_000 });
    expect(await restarted.claim(laterObservation)).toEqual({
      status: "already-consumed",
      permitId: claimed.permitId,
      claim,
    });
  });

  test("persists an earlier SB-2 winner without replacing an already-consumed authorization", async () => {
    const dir = await tempStoreDir();
    const store = await createFsSellerReceiptStore({ dir });
    const consumedClaim = receiptClaim({ jobId: "job-consumed", observedAt: 6_000 });
    const claimed = await store.claim(consumedClaim);
    if (claimed.status !== "claimed") throw new Error("fixture");
    const retainedHandoff = handoff(consumedClaim);
    await expect(store.consumePermit(claimed.permitId, retainedHandoff)).resolves.toMatchObject({
      status: "consumed",
      claim: { jobId: consumedClaim.jobId },
    });

    const earlierWinner = receiptClaim({ jobId: "job-earlier", observedAt: 4_000 });
    await expect(store.claim(earlierWinner)).resolves.toEqual({
      status: "conflict",
      reason: "winner-already-consumed",
      existing: earlierWinner,
      consumed: consumedClaim,
    });

    const restarted = await createFsSellerReceiptStore({ dir });
    await expect(restarted.claim(earlierWinner)).resolves.toEqual({
      status: "conflict",
      reason: "winner-already-consumed",
      existing: earlierWinner,
      consumed: consumedClaim,
    });
    await expect(restarted.claim(consumedClaim)).resolves.toEqual({
      status: "already-consumed",
      permitId: claimed.permitId,
      claim: consumedClaim,
    });
    await expect(restarted.inspectPermit(claimed.permitId)).resolves.toEqual({
      status: "already-consumed",
      claim: consumedClaim,
      handoff: retainedHandoff,
    });
  });

  test("never substitutes an authorization scope before or after consumption", async () => {
    const dir = await tempStoreDir();
    const store = await createFsSellerReceiptStore({ dir });
    const claim = receiptClaim();
    const claimed = await store.claim(claim);
    if (claimed.status !== "claimed") throw new Error("fixture");
    const substituted = receiptClaim({ observedAt: 6_000 });
    substituted.authorization.agreementHash = "99".repeat(32);
    await expect(store.claim(substituted)).resolves.toMatchObject({
      status: "conflict",
      reason: "authorization-scope-conflict",
      existing: { authorization: { agreementHash: claim.authorization.agreementHash } },
    });
    await store.consumePermit(claimed.permitId, handoff(claim));
    await expect(store.claim(substituted)).resolves.toMatchObject({
      status: "conflict",
      reason: "authorization-scope-conflict",
      consumed: { authorization: { agreementHash: claim.authorization.agreementHash } },
    });
    expect(await store.inspectPermit(claimed.permitId)).toMatchObject({
      status: "already-consumed",
      claim: { authorization: { agreementHash: claim.authorization.agreementHash } },
    });
  });

  test("waits for a live competing process that owns the global store lock", async () => {
    const dir = await tempStoreDir();
    const store = await createFsSellerReceiptStore({
      dir,
      lockTimeoutMs: 2_000,
      lockStaleMs: 10,
      lockPollMs: 2,
    });
    const ready = join(dir, "child-ready");
    const release = join(dir, "child-release");
    const lock = join(dir, LOCK_DIR);
    const script = String.raw`
      const fs = require("node:fs/promises");
      const [lock, ready, release] = process.argv.slice(1);
      (async () => {
        const candidate = lock + ".child-candidate";
        await fs.mkdir(candidate, { mode: 0o700 });
        await fs.writeFile(candidate + "/owner.json", JSON.stringify({
          pid: process.pid,
          token: "child-owner"
        }), { mode: 0o600, flag: "wx" });
        await fs.rename(candidate, lock);
        await fs.writeFile(ready, "ready", { mode: 0o600 });
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          try { await fs.access(release); break; } catch {}
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        const released = lock + ".child-released";
        await fs.rename(lock, released);
        await fs.rm(released, { recursive: true, force: true });
      })().catch(() => process.exitCode = 1);
    `;
    const child = spawn(process.execPath, ["-e", script, lock, ready, release], {
      stdio: "ignore",
    });
    children.add(child);
    const exited = childExit(child).then(
      () => null,
      (childError: unknown) => childError,
    );
    await waitForFile(ready);

    let settled = false;
    const pending = store.claim(receiptClaim()).then((result) => {
      settled = true;
      return result;
    });
    await delay(50);
    expect(settled).toBe(false);
    await writeFile(release, "release", { mode: 0o600 });
    await expect(pending).resolves.toMatchObject({ status: "claimed" });
    const childError = await exited;
    if (childError) throw childError;
  });

  test("competing reclaimers recover one stale lock without fencing a successor", async () => {
    const dir = await tempStoreDir();
    const lock = join(dir, LOCK_DIR);
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, "owner.json"), JSON.stringify({
      pid: 999_999,
      token: "dead-owner",
    }), { mode: 0o600 });
    const stale = new Date(Date.now() - 60_000);
    await utimes(lock, stale, stale);

    const stores = await Promise.all(Array.from(
      { length: 4 },
      () => createFsSellerReceiptStore({
        dir,
        lockTimeoutMs: 2_000,
        lockStaleMs: 10,
        lockPollMs: 2,
      }),
    ));
    const results = await Promise.all(stores.map((store) => store.claim(receiptClaim())));
    expect(results.filter((result) => result.status === "claimed")).toHaveLength(1);
    expect(results.filter((result) => result.status === "already-claimed")).toHaveLength(3);
    const permits = results.flatMap((result) =>
      result.status === "claimed" || result.status === "already-claimed"
        ? [result.permitId]
        : []);
    expect(new Set(permits).size).toBe(1);
    expect((await readdir(dir)).sort()).toEqual([INITIALIZATION_FILE, STATE_FILE]);
  });

  test("fails closed on malformed and unsupported state without overwriting it", async () => {
    const dir = await tempStoreDir();
    const store = await createFsSellerReceiptStore({ dir });
    const claim = receiptClaim();
    const claimed = await store.claim(claim);
    if (claimed.status !== "claimed") throw new Error("fixture");
    const statePath = join(dir, STATE_FILE);
    const valid = await readFile(statePath, "utf8");

    await writeFile(statePath, "{not-json", { mode: 0o600 });
    const corruptStore = await createFsSellerReceiptStore({ dir });
    await expect(corruptStore.inspectPermit(claimed.permitId)).rejects.toThrow(
      "filesystem seller receipt store state is corrupt",
    );
    await expect(corruptStore.claim(claim)).rejects.toThrow(
      "filesystem seller receipt store state is corrupt",
    );
    expect(await readFile(statePath, "utf8")).toBe("{not-json");

    const parsedValid = JSON.parse(valid) as Record<string, unknown>;
    const records = JSON.stringify(parsedValid.records);
    const permits = JSON.stringify(parsedValid.permits);
    const noncanonicalStates = [
      `{"storeVersion":2,"storeVersion":1,"records":${records},"permits":${permits}}`,
      `{"storeVersion":1,"records":${records},"records":{},"permits":{}}`,
      ` ${valid}`,
    ];
    for (const noncanonical of noncanonicalStates) {
      await writeFile(statePath, noncanonical, { mode: 0o600 });
      const noncanonicalStore = await createFsSellerReceiptStore({ dir });
      await expect(noncanonicalStore.inspectPermit(claimed.permitId)).rejects.toThrow(
        "filesystem seller receipt store state is corrupt",
      );
      await expect(noncanonicalStore.claim(claim)).rejects.toThrow(
        "filesystem seller receipt store state is corrupt",
      );
      expect(await readFile(statePath, "utf8")).toBe(noncanonical);
    }

    const newer = structuredClone(parsedValid);
    newer.storeVersion = SELLER_RECEIPT_STORE_VERSION + 1;
    await writeFile(statePath, JSON.stringify(newer), { mode: 0o600 });
    const newerStore = await createFsSellerReceiptStore({ dir });
    await expect(newerStore.inspectPermit(claimed.permitId)).rejects.toThrow(
      "filesystem seller receipt store version 2 is unsupported",
    );
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      storeVersion: 2,
    });

    const nonFileDir = await tempStoreDir();
    const nonFileStore = await createFsSellerReceiptStore({ dir: nonFileDir });
    await mkdir(join(nonFileDir, STATE_FILE), { mode: 0o700 });
    await expect(nonFileStore.inspectPermit(claimed.permitId)).rejects.toThrow(
      "filesystem seller receipt store state is corrupt",
    );
  });

  test("uses restrictive permissions and emits no bearer capability to logs", async () => {
    const dir = await tempStoreDir();
    await writeFile(join(dir, "preexisting"), "fixture", { mode: 0o644 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = await createFsSellerReceiptStore({ dir });
    const claimed = await store.claim(receiptClaim());
    expect(claimed.status).toBe("claimed");
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, STATE_FILE))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, INITIALIZATION_FILE))).mode & 0o777).toBe(0o600);
    expect(log).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  test("hash-indexes independent records and contains traversal-shaped inputs", async () => {
    const dir = await tempStoreDir();
    const store = await createFsSellerReceiptStore({ dir });
    const first = receiptClaim({ jobId: "../../outside/first" });
    const second = receiptClaim({
      settlementId: `evm:84532:${"ab".repeat(32)}:7`,
      jobId: "..%2F..%2Foutside%2Fsecond",
    });
    const [one, two] = await Promise.all([store.claim(first), store.claim(second)]);
    expect(one.status).toBe("claimed");
    expect(two.status).toBe("claimed");
    expect(await store.inspectPermit("../../seller-receipts.json")).toEqual({
      status: "invalid",
    });
    expect(await store.inspectPermit("..%2F..%2Fseller-receipts.json")).toEqual({
      status: "invalid",
    });

    const state = JSON.parse(await readFile(join(dir, STATE_FILE), "utf8")) as {
      records: Record<string, unknown>;
    };
    expect(Object.keys(state.records)).toHaveLength(2);
    expect(Object.keys(state.records).every((key) => /^[0-9a-f]{64}$/.test(key))).toBe(true);
    expect((await readdir(dir)).sort()).toEqual([INITIALIZATION_FILE, STATE_FILE]);
  });
});
