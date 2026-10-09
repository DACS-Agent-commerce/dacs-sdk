import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { SettleRequest, SettleResult } from "../../src/agent/runSessionCore.js";
import { DacsError } from "../../src/errors.js";
import { evmErc20Settle, evmErc20SettleCore } from "../../src/rails/evmErc20.js";
import {
  createIdempotencyStore, settlementBindingHash, settlementKey,
  type SettlementBinding, type SettlementEffectFence, type SettlementLog,
  type SettlementReconcile,
} from "../../src/rails/idempotency.js";
import { x402Settle, x402SettleCore } from "../../src/rails/x402.js";
import { createTestFsSettlementLog } from "./settlementLogFs.js";
import { waitForFiles, type WorkerOptions } from "./settlementProcess.js";

const [root, id, rawOptions] = process.argv.slice(2);
if (!root || !id || !rawOptions) throw new Error("settlement worker arguments are missing");
const options = JSON.parse(rawOptions) as WorkerOptions;
const mode = options.mode ?? "generic";
const now = options.now ?? 100;
const NETWORK = "eip155:84532";
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAYEE = `0x${"1".repeat(40)}`;
const PAYER = `0x${"2".repeat(40)}`;
const TX = `0x${"a".repeat(64)}`;
const BLOCK = `0x${"b".repeat(64)}`;
const NEXT = `0x${"c".repeat(64)}`;
const RESOURCE = "https://seller.example/resource";
const req: SettleRequest = {
  rail: mode === "evm" ? "pay-evm-erc20" : "pay-x402",
  phase: mode === "evm" ? "pay-evm-erc20" : "pay-x402",
  jobId: "job-restart", phaseIndex: 0, amount: options.amount ?? "1000000", asset: "USDC",
  payee: "did:demos:seller", expectedPayee: PAYEE,
};
const success = (): SettleResult => ({
  ok: true, txHash: TX, chainId: NETWORK, payer: PAYER, payee: PAYEE,
  finality: { model: "block-depth", finalityBlocks: 2 },
});

async function marker(name: string, value: unknown = { pid: process.pid }) {
  await writeFile(join(root!, name), JSON.stringify(value));
}

async function stopAt(name: string) {
  await marker(name);
  await waitForFiles(root!, [`continue-${name}`]);
}

function append(name: string, value: unknown) {
  const handle = openSync(join(root!, name), "a", 0o600);
  try { writeSync(handle, `${JSON.stringify(value)}\n`); fsyncSync(handle); }
  finally { closeSync(handle); }
}

async function effect() {
  if (options.crash === "before-effect") await stopAt(`before-effect-${id}`);
  append("effects", { pid: process.pid, txHash: TX });
}

const durable = createTestFsSettlementLog(join(root, "log"));
const log: SettlementLog = {
  ...durable,
  async putOutcome(input) {
    await marker("landed", input.result);
    if (options.crash === "before-outcome") await stopAt(`before-outcome-${id}`);
    return durable.putOutcome(input);
  },
  async grantRecovery(input) {
    const grant = await durable.grantRecovery(input);
    if (grant.status === "granted") append("grants", { pid: process.pid, generation: grant.lease.generation });
    return grant;
  },
};
const store = createIdempotencyStore(log, { owner: id, now: () => now, leaseDurationMs: 100 });
const reconcile: SettlementReconcile = async (_key, fence) => {
  append("reconciles", { pid: process.pid, key: _key, generation: fence?.generation });
  if (options.race) {
    await marker(`reconciling-${id}`);
    await waitForFiles(root!, ["finish-reconcile"]);
  }
  if (options.reconcile === "throws") throw new Error("authoritative lookup unavailable");
  if (options.reconcile === "absent") return null;
  if (options.reconcile === "replay") {
    if (!fence?.effectIdentity) throw new DacsError("test replay requires a retained external identity");
    return {
      disposition: "replay-authorized", bindingHash: fence.bindingHash,
      effectIdentity: fence.effectIdentity, protection: "prior-effect-terminal",
      async assertReplaySafe() {
        // The parent has reaped the pre-effect process before either contender
        // starts. This file is test rail authority that it can never submit.
        await readFile(join(root!, "prior-effect-terminal"), "utf8");
      },
    };
  }
  return JSON.parse(await readFile(join(root!, "landed"), "utf8")) as SettleResult;
};

function binding(request: SettleRequest): SettlementBinding {
  return {
    bindingVersion: "1", railId: request.rail, jobId: request.jobId, phaseIndex: request.phaseIndex ?? 0,
    phase: request.phase, amount: request.amount, agreementAsset: request.asset,
    settlementAsset: TOKEN, payer: PAYER, payee: PAYEE, network: NETWORK,
    finality: { model: "block-depth", finalityBlocks: 2 }, effectIdentity: "test-external-effect",
  };
}

const evm = evmErc20Settle({
  address: PAYER, finalityBlocks: 2,
  settle: (params, fence) => evmErc20SettleCore({ ...params, finalityBlocks: 2 }, {
    address: PAYER,
    transfer: async () => { await effect(); return TX; },
    finalityClient: {
      getChainId: async () => 84532,
      waitForTransactionReceipt: async () => receipt(),
      getTransactionReceipt: async () => receipt(),
      getBlock: async ({ blockNumber }) => ({
        number: blockNumber, hash: blockNumber === 100n ? BLOCK : NEXT,
        parentHash: blockNumber === 100n ? `0x${"d".repeat(64)}` : BLOCK,
        timestamp: blockNumber === 100n ? 1_700_000_000n : 1_700_000_011n,
      }),
    },
  }, fence),
}, { tokenAddress: TOKEN, network: NETWORK, recipientEvm: PAYEE }, { store, reconcile });

function receipt() {
  const topic = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;
  return {
    transactionHash: TX, blockNumber: 100n, blockHash: BLOCK, status: "success",
    logs: [{
      address: TOKEN,
      topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", topic(PAYER), topic(PAYEE)],
      data: `0x${BigInt(req.amount).toString(16).padStart(64, "0")}`,
      transactionHash: TX, blockNumber: 100n, blockHash: BLOCK, logIndex: 7, removed: false,
    }],
  };
}

const x402 = x402Settle({
  address: PAYER, finalityBlocks: 2,
  settle: (params, fence) => x402SettleCore({ ...params, finalityBlocks: 2 }, {
    payerAddress: PAYER, transportPolicy: { mode: "insecure-test" },
    client: {
      getPaymentRequiredResponse: () => ({ accepts: [{ network: NETWORK, payTo: PAYEE, amount: req.amount, asset: TOKEN }] }),
      createPaymentPayload: async (challenge) => challenge,
      encodePaymentSignatureHeader: () => ({ "X-PAYMENT": "test-authority" }),
      getPaymentSettleResponse: () => ({ success: true, transaction: TX, network: NETWORK, payer: PAYER }),
    },
    fetchImpl: async (_url, init) => {
      if (!new Headers(init?.headers).has("X-PAYMENT")) {
        return new Response(JSON.stringify({ x402Version: 2 }), { status: 402 });
      }
      await effect();
      return new Response("delivered", { status: 200, headers: {
        "PAYMENT-RESPONSE": Buffer.from(JSON.stringify({
          success: true, transaction: TX, network: NETWORK, payer: PAYER, amount: req.amount,
        })).toString("base64"),
      } });
    },
    assertFinalityContext: async () => undefined,
    authenticateTransfer: async () => ({
      chainId: 84532, transactionHash: "a".repeat(64), logIndex: 7,
      blockNumber: 100, confirmations: 2, finalityObservedAt: 1_700_000_011_000,
    }),
  }, fence),
}, { url: RESOURCE, network: NETWORK, recipientEvm: PAYEE, asset: TOKEN }, { store, reconcile });

async function settle(request: SettleRequest) {
  let result: SettleResult;
  if (mode === "evm") result = await evm(request);
  else if (mode === "x402") result = await x402(request);
  else result = await store.once(settlementKey(request.rail, request.jobId, request.phaseIndex ?? 0), binding(request),
    async (fence?: Readonly<SettlementEffectFence>) => {
      await fence?.assertCurrent();
      await effect();
      return success();
    }, reconcile);
  return result;
}

async function run() {
  if (options.race) {
    await marker(`ready-${id}`);
    await waitForFiles(root!, ["start-race"]);
  }
  if (options.action === "session") {
    const { runRestartSession } = await import("./settlementSessionWorker.js");
    return runRestartSession({ root: root!, id: id!, options, settle, result: success(), stopAt });
  }
  const key = settlementKey(req.rail, req.jobId, 0);
  const bindingHash = settlementBindingHash(binding(req));
  if (options.action === "stale") {
    const claim = await log.claimIntent({ key, bindingHash, owner: id!, now, leaseDurationMs: 100 });
    if (claim.status !== "acquired") throw new Error("stale worker failed to claim");
    await marker(`claimed-${id}`, claim);
    await waitForFiles(root!, ["try-stale"]);
    // Even a paused process's old clock still inside its original lease must
    // fail by generation, independently of expiry at the replacement's clock.
    const input = { key, bindingHash, lease: claim.lease, now: 150 };
    return {
      current: await log.isCurrent(input),
      put: await log.putOutcome({ ...input, result: success() }),
      release: await log.releaseIntent(input),
      grant: await log.grantRecovery({ ...input, owner: id!, leaseDurationMs: 100 }),
    };
  }
  if (options.action === "takeover") {
    return log.claimIntent({ key, bindingHash, owner: id!, now, leaseDurationMs: 100 });
  }
  if (options.action === "grant") {
    const claim = JSON.parse(await readFile(join(root!, "recovery-claim"), "utf8")) as {
      lease: { owner: string; generation: number };
    };
    return log.grantRecovery({ key, bindingHash, lease: claim.lease, owner: id!, now, leaseDurationMs: 100 });
  }
  return settle(req);
}

try {
  const value = await run();
  await marker(`result-${id}`, { pid: process.pid, ok: true, value });
} catch (error) {
  await marker(`result-${id}`, {
    pid: process.pid, ok: false,
    error: { name: error instanceof Error ? error.name : "unknown", message: String(error instanceof Error ? error.message : error),
      ...(error instanceof DacsError ? { category: error.category } : {}) },
  });
}
