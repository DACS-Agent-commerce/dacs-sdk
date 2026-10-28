import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { x402Client, x402HTTPClient } from "@x402/fetch";

import type { SettleRequest, SettleResult } from "../../src/agent/runSessionCore.js";
import { DacsError } from "../../src/errors.js";
import { evmErc20Settle, evmErc20SettleCore } from "../../src/rails/evmErc20.js";
import {
  createIdempotencyStore, settlementBindingHash, settlementKey,
  type SettlementBinding, type SettlementEffectFence, type SettlementLog,
  type SettlementReconcile,
} from "../../src/rails/idempotency.js";
import {
  dacsX402AuthorizationNonce, x402Settle, x402SettleCore, type X402ClientLike,
} from "../../src/rails/x402.js";
import { createTestFsSettlementLog } from "./settlementLogFs.js";
import {
  RESTART_JOB_ID, waitForFiles, X402_SIGNED_WINDOW, type RailRecord, type WorkerOptions,
} from "./settlementProcess.js";

const [root, id, rawOptions] = process.argv.slice(2);
if (!root || !id || !rawOptions) throw new Error("settlement worker arguments are missing");
const options = JSON.parse(rawOptions) as WorkerOptions;
const mode = options.mode ?? "generic";
const now = options.now ?? 100;
const NETWORK = "eip155:84532";
const USDC_CONTRACT = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAYEE = `0x${"1".repeat(40)}`;
const PAYER = `0x${"2".repeat(40)}`;
const TX = `0x${"a".repeat(64)}`;
const BLOCK = `0x${"b".repeat(64)}`;
const NEXT = `0x${"c".repeat(64)}`;
const RESOURCE = "https://seller.example/resource";
const token = options.token ?? USDC_CONTRACT;
const req: SettleRequest = {
  rail: mode === "evm" ? "pay-evm-erc20" : "pay-x402",
  phase: mode === "evm" ? "pay-evm-erc20" : "pay-x402",
  jobId: RESTART_JOB_ID, phaseIndex: 0, amount: options.amount ?? "1000000", asset: "USDC",
  payee: "did:demos:seller", expectedPayee: PAYEE,
};
const success = (txHash = TX): SettleResult => ({
  ok: true, txHash, chainId: NETWORK, payer: PAYER, payee: PAYEE,
  finality: { model: "block-depth", finalityBlocks: 2 },
});
// The rail identity each mode can recompute from its own request after a restart.
type Phase = Pick<SettleRequest, "jobId" | "phaseIndex">;
const genericIdentity = (request: Phase) => `test-effect:${request.jobId}:${request.phaseIndex ?? 0}`;
const sb3Nonce = (request: Phase) =>
  dacsX402AuthorizationNonce({ jobId: request.jobId, phaseIndex: request.phaseIndex ?? 0 });
// Recovery derives the phase from the settlement key it is reconciling, never
// from whichever request this process happened to be started with.
function recovered(key: string): Phase {
  const phaseAt = key.lastIndexOf(":");
  const jobAt = key.lastIndexOf(":", phaseAt - 1);
  return { jobId: key.slice(jobAt + 1, phaseAt), phaseIndex: Number(key.slice(phaseAt + 1)) };
}

async function marker(name: string, value: unknown = { pid: process.pid }) {
  // Publish complete content: the parent may read a marker as soon as it exists.
  const temporary = join(root!, `.${name}.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, join(root!, name));
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

async function lines<T>(name: string): Promise<T[]> {
  try { return (await readFile(join(root!, name), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as T); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

// The irreversible effect: the test rail records it in its own authoritative
// ledger, keyed by what that rail can be queried by. Nothing is copied from the
// settlement result that the crashed process failed to persist.
async function effect(record: RailRecord) {
  if (options.crash === "before-effect") await stopAt(`before-effect-${id}`);
  append("authority", record);
  append("effects", { pid: process.pid, ...record });
  if (options.crash === "replay-effect-committed") await stopAt(`replay-effect-committed-${id}`);
}

const durable = createTestFsSettlementLog(join(root, "log"), {
  async beforeCommit(transition) {
    // Racing grants both read the reconcile revision before either may commit it.
    if (options.action === "grant" && options.race) {
      await marker(`decided-${id}`);
      await waitForFiles(root!, ["commit-grant"]);
    }
    // A torn commit: the candidate is flushed but never becomes a revision.
    if (options.crash === `${transition}-flushed`) await stopAt(`${options.crash}-${id}`);
  },
  async afterLink(transition) {
    // Committed for every reader, but the directory flush has not run.
    if (options.crash === `${transition}-linked`) await stopAt(`${options.crash}-${id}`);
  },
});
const log: SettlementLog = {
  ...durable,
  async putOutcome(input) {
    if (options.crash === "before-outcome") await stopAt(`before-outcome-${id}`);
    return durable.putOutcome(input);
  },
  async grantRecovery(input) {
    const grant = await durable.grantRecovery(input);
    if (grant.status === "granted") {
      append("grants", { pid: process.pid, generation: grant.lease.generation });
      if (options.crash === "grant-committed") await stopAt(`grant-committed-${id}`);
    }
    return grant;
  },
};
// A deployment may fix one owner ID for every process it restarts.
const owner = options.owner ?? id;
const store = createIdempotencyStore(log, { owner, now: () => now, leaseDurationMs: 100 });

// Query the test rail authority by the identity this process derives itself
// from the key being recovered: the generic effect identity or the SB-3
// EIP-3009 nonce.
async function lookup(key: string, fence?: Readonly<SettlementEffectFence>): Promise<SettleResult | null> {
  if (mode === "evm") {
    // Direct ERC-20 retains no submission reference before the crash window
    // (evmErc20Settle binds no effect identity), so this job's transfer cannot
    // be told apart from an earlier one with the same token, payer, payee and
    // value. Never attribute a transfer by its terms alone.
    throw new DacsError(
      "direct ERC-20 retained no submission reference; refusing to attribute a transfer by its terms; operator action required",
    );
  }
  const phase = recovered(key);
  const ledger = await lines<RailRecord>("authority");
  if (mode === "generic") {
    const found = ledger.filter((entry) => entry.rail === "generic" && entry.identity === genericIdentity(phase)).at(-1);
    return found ? success(found.txHash) : null;
  }
  // DACS-4 §9.5.8 SB-3: the derived nonce is the retry identity. Reconcile its
  // authorization state; resume only the same transfer and never mint a new nonce.
  // The state is read where the token contract keeps it: this chain, this
  // token and this payer. The same nonce in any other scope is not this one.
  const nonce = await sb3Nonce(phase);
  if (fence?.effectIdentity !== nonce) throw new DacsError("x402 effect fence does not retain the SB-3 nonce");
  const found = ledger.filter((entry): entry is Extract<RailRecord, { rail: "x402" }> =>
    entry.rail === "x402" && entry.network === NETWORK && entry.asset.toLowerCase() === token.toLowerCase() &&
    entry.from.toLowerCase() === PAYER && entry.nonce === nonce).at(-1);
  if (!found) return null;
  if (found.state === "cancelled") {
    throw new DacsError("SB-3 authorization nonce is cancelled; refusing a fresh nonce for this phase");
  }
  // Resume only the authorization this phase signed: the same transfer and the
  // same signed validity window. A record that cannot show both bounds is not
  // proof of that authorization, so it fails closed as well.
  if (found.to !== PAYEE || found.value !== req.amount || !found.txHash ||
      found.validAfter !== X402_SIGNED_WINDOW.validAfter ||
      found.validBefore !== X402_SIGNED_WINDOW.validBefore) {
    throw new DacsError("SB-3 authorization nonce was used by a different transfer; refusing a fresh nonce for this phase");
  }
  return success(found.txHash);
}

const reconcile: SettlementReconcile = async (key, fence) => {
  append("reconciles", { pid: process.pid, key, generation: fence?.generation, identity: fence?.effectIdentity });
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
      // Bind the identity this rail derives, never an echo of the fence.
      effectIdentity: mode === "x402" ? await sb3Nonce(recovered(key)) : genericIdentity(recovered(key)),
      protection: "prior-effect-terminal",
      async assertReplaySafe() {
        // The parent has reaped the pre-effect process before either contender
        // starts. This file is test rail authority that it can never submit.
        try { await readFile(join(root!, "prior-effect-terminal"), "utf8"); }
        catch { throw new DacsError("test rail cannot prove the prior effect terminal"); }
      },
    };
  }
  return lookup(key, fence);
};

function binding(request: SettleRequest): SettlementBinding {
  return {
    bindingVersion: "1", railId: request.rail, jobId: request.jobId, phaseIndex: request.phaseIndex ?? 0,
    phase: request.phase, amount: request.amount, agreementAsset: request.asset,
    settlementAsset: token, payer: PAYER, payee: PAYEE, network: NETWORK,
    finality: { model: "block-depth", finalityBlocks: 2 }, effectIdentity: genericIdentity(request),
  };
}

const evm = evmErc20Settle({
  address: PAYER, finalityBlocks: 2,
  settle: (params, fence) => evmErc20SettleCore({ ...params, finalityBlocks: 2 }, {
    address: PAYER,
    transfer: async () => {
      await effect({ rail: "evm", txHash: TX, token: params.tokenAddress, from: PAYER, to: params.recipientEvm, value: params.amount });
      return TX;
    },
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
}, { tokenAddress: token, network: NETWORK, recipientEvm: PAYEE }, { store, reconcile });

function receipt() {
  const topic = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;
  return {
    transactionHash: TX, blockNumber: 100n, blockHash: BLOCK, status: "success",
    logs: [{
      address: USDC_CONTRACT,
      topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", topic(PAYER), topic(PAYEE)],
      data: `0x${BigInt(req.amount).toString(16).padStart(64, "0")}`,
      transactionHash: TX, blockNumber: 100n, blockHash: BLOCK, logIndex: 7, removed: false,
    }],
  };
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
// The real x402 v2 HTTP client: PAYMENT-REQUIRED in, PAYMENT-SIGNATURE out. Only
// the EIP-3009 signer is replaced; it signs the SB-3 nonce for this exact phase.
function x402HttpClient(nonce: string): X402ClientLike {
  return new x402HTTPClient(new x402Client().register(NETWORK, {
    scheme: "exact",
    async createPaymentPayload(version, requirements) {
      // The intent is reserved under this nonce, and nothing is signed yet.
      if (options.crash === "before-sign") await stopAt(`before-sign-${id}`);
      const authorization = {
        from: PAYER, to: requirements.payTo, value: requirements.amount,
        ...X402_SIGNED_WINDOW, nonce,
      };
      append("payloads", { pid: process.pid, nonce, authorization });
      return {
        x402Version: version,
        payload: { authorization, signature: `0x${"44".repeat(65)}` },
      };
    },
  })) as unknown as X402ClientLike;
}

const x402 = x402Settle({
  address: PAYER, finalityBlocks: 2,
  settle: async (params, fence) => x402SettleCore({ ...params, finalityBlocks: 2 }, {
    payerAddress: PAYER, transportPolicy: { mode: "insecure-test" },
    client: x402HttpClient(await dacsX402AuthorizationNonce({ jobId: params.jobId!, phaseIndex: params.phaseIndex! })),
    fetchImpl: async (url, init) => {
      const signature = new Headers(init?.headers).get("PAYMENT-SIGNATURE");
      if (signature === null) {
        const challenge = {
          x402Version: 2, resource: { url: String(url), mimeType: "application/json" },
          accepts: [{
            scheme: "exact", network: NETWORK, amount: req.amount, asset: USDC_CONTRACT, payTo: PAYEE,
            // The EIP-712 domain of Base Sepolia USDC, as @x402/evm names it.
            maxTimeoutSeconds: 120, extra: { name: "USDC", version: "2" },
          }],
          extensions: {},
        };
        return new Response(JSON.stringify(challenge), { status: 402, headers: { "PAYMENT-REQUIRED": encode(challenge) } });
      }
      // The facilitator executes the signed authorization it was given, on the
      // chain and token contract of the requirement it was signed for.
      const { accepted, payload: { authorization } } = JSON.parse(Buffer.from(signature, "base64").toString("utf8")) as {
        accepted: { network: string; asset: string };
        payload: { authorization: {
          from: string; nonce: string; to: string; value: string; validAfter: string; validBefore: string;
        } };
      };
      await effect({
        rail: "x402", txHash: TX, network: accepted.network, asset: accepted.asset, from: authorization.from,
        nonce: authorization.nonce, state: "used", to: authorization.to, value: authorization.value,
        validAfter: authorization.validAfter, validBefore: authorization.validBefore,
      });
      return new Response("delivered", { status: 200, headers: {
        "PAYMENT-RESPONSE": encode({ success: true, transaction: TX, network: NETWORK, payer: PAYER, amount: req.amount }),
      } });
    },
    assertFinalityContext: async () => undefined,
    authenticateTransfer: async () => ({
      chainId: 84532, transactionHash: "a".repeat(64), logIndex: 7,
      blockNumber: 100, confirmations: 2, finalityObservedAt: 1_700_000_011_000,
    }),
  }, fence),
}, { url: options.resource ?? RESOURCE, network: NETWORK, recipientEvm: PAYEE, asset: token }, { store, reconcile });

async function settle(request: SettleRequest) {
  let result: SettleResult;
  if (mode === "evm") result = await evm(request);
  else if (mode === "x402") result = await x402(request);
  else result = await store.once(settlementKey(request.rail, request.jobId, request.phaseIndex ?? 0), binding(request),
    async (fence?: Readonly<SettlementEffectFence>) => {
      await fence?.assertCurrent();
      if (options.submit === "not-invoked") {
        const { finality: _finality, ...terms } = success();
        return { disposition: "not-invoked" as const, result: { ...terms, ok: false, txHash: "" } };
      }
      await effect({ rail: "generic", txHash: TX, identity: fence!.effectIdentity! });
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
    const claim = await log.claimIntent({ key, bindingHash, owner, now, leaseDurationMs: 100 });
    if (claim.status !== "acquired") throw new Error("stale worker failed to claim");
    await marker(`claimed-${id}`, claim);
    await waitForFiles(root!, ["try-stale"]);
    // Even a paused process's old clock still inside its original lease must
    // fail by generation, independently of expiry at the replacement's clock.
    // With one fixed owner, the generation is the only thing that differs.
    const input = { key, bindingHash, lease: claim.lease, now: now + 50 };
    return {
      current: await log.isCurrent(input),
      grant: await log.grantRecovery({ ...input, owner, leaseDurationMs: 100 }),
      put: await log.putOutcome({ ...input, result: success() }),
      release: await log.releaseIntent(input),
    };
  }
  if (options.action === "takeover") {
    return log.claimIntent({ key, bindingHash, owner, now, leaseDurationMs: 100 });
  }
  if (options.action === "grant") {
    const claim = JSON.parse(await readFile(join(root!, "recovery-claim"), "utf8")) as {
      lease: { owner: string; generation: number };
    };
    return log.grantRecovery({ key, bindingHash, lease: claim.lease, owner, now, leaseDurationMs: 100 });
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
