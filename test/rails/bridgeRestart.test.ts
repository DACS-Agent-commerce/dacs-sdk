import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";

import type { SettleRequest, SettleResult } from "../../src/agent/runSessionCore.js";
import { evmErc20Settle } from "../../src/rails/evmErc20.js";
import { createIdempotencyStore, type SettlementLog } from "../../src/rails/idempotency.js";
import { payDemSettle } from "../../src/rails/payDem.js";

vi.mock("../../src/rails/payDemExecutionAuthority.js", async () =>
  import("../support/payDemExecutionAuthority.js"));

const payer = "ab".repeat(32);
const payee = "cd".repeat(32);
const jobId = "settlement-job";

function publish(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function fileLog(path: string): SettlementLog {
  type Record = {
    bindingHash: string;
    lease: { owner: string; generation: number; stage: "fresh"; expiresAt: number };
    outcome?: { bindingHash: string; result: SettleResult };
  };
  const read = (): Record | null => existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8")) as Record
    : null;
  return {
    async readOutcome() {
      const record = read();
      return record?.outcome ?? (record ? { bindingHash: record.bindingHash } : null);
    },
    async claimIntent(input) {
      const record = read();
      if (record) {
        if (record.bindingHash !== input.bindingHash) return { status: "conflict" };
        if (record.outcome) return { status: "outcome", outcome: record.outcome };
        return { status: "held", bindingHash: record.bindingHash, lease: record.lease };
      }
      const lease = { owner: input.owner, generation: 1, stage: "fresh" as const,
        expiresAt: input.now + input.leaseDurationMs };
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify({ bindingHash: input.bindingHash, lease }));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      const directory = openSync(dirname(path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
      return { status: "acquired", bindingHash: input.bindingHash, lease };
    },
    async isCurrent(input) {
      const record = read();
      return record !== null && record.outcome === undefined &&
        record.bindingHash === input.bindingHash &&
        record.lease.owner === input.lease.owner &&
        record.lease.generation === input.lease.generation &&
        record.lease.expiresAt > input.now;
    },
    async grantRecovery() { return { status: "stale" }; },
    async putOutcome(input) {
      const record = read();
      if (!record) return { status: "stale" };
      if (record.bindingHash !== input.bindingHash) return { status: "conflict" };
      if (record.outcome) return { status: "existing", outcome: record.outcome };
      if (record.lease.owner !== input.lease.owner ||
          record.lease.generation !== input.lease.generation ||
          record.lease.expiresAt <= input.now) return { status: "stale" };
      const outcome = { bindingHash: input.bindingHash, result: input.result };
      publish(path, { ...record, outcome });
      return { status: "recorded", outcome };
    },
    async releaseIntent() { return "stale"; },
  };
}

const child = process.env.DACS_BRIDGE_TEST_CHILD === "1";

test.skipIf(!child)("records a child settlement", async () => {
  const directory = process.env.DACS_BRIDGE_TEST_DIRECTORY;
  const railName = process.env.DACS_BRIDGE_TEST_RAIL;
  const step = process.env.DACS_BRIDGE_TEST_STEP;
  if (!directory || !railName || !step) throw new Error("missing child settlement inputs");
  const store = createIdempotencyStore(fileLog(join(directory, "settlement.json")));
  const ledger = join(directory, "external-ledger.json");
  const transfer = () => {
    const count = existsSync(ledger)
      ? (JSON.parse(readFileSync(ledger, "utf8")) as { count: number }).count + 1
      : 1;
    const hash = count.toString(16).padStart(64, "0");
    publish(ledger, { count, hash });
    return hash;
  };
  let settle: (req: SettleRequest) => Promise<SettleResult>;
  let request: SettleRequest;
  if (railName === "evm-erc20") {
    settle = evmErc20Settle({ address: "0xpayer", finalityBlocks: 1,
      async settle() {
        return { ok: true, txHash: `0x${transfer()}`, chainId: "eip155:1",
          payer: "0xpayer", payee: "0xpayee",
          finality: { model: "block-depth", finalityBlocks: 1 } };
      },
    }, { tokenAddress: "0xtoken", network: "eip155:1", recipientEvm: "0xpayee" }, { store });
    request = { rail: "evm-erc20", phase: "pay-evm-erc20", phaseIndex: 0,
      jobId, amount: "100", asset: "TOKEN", payee: "0xpayee", expectedPayee: "0xpayee" };
  } else {
    settle = payDemSettle({ address: payer, async settle() {
      return { ok: true, execution: "executed", txHash: transfer(), chainId: "demos",
        payer, payee, blockNumber: 42, txRefKind: "demos",
        finality: { model: "bft-final" } };
    } }, {}, { store, reconcile: async (context) => {
      const retained = JSON.parse(readFileSync(ledger, "utf8")) as { hash: string };
      return { ok: true, execution: "executed", txHash: retained.hash,
        chainId: context.network, payer: context.payer, payee: context.payee,
        amountOs: context.amountOs, blockNumber: 42, txRefKind: "demos",
        finality: { model: "bft-final" } };
    } });
    request = { rail: "pay-dem", phase: "pay-dem", phaseIndex: 0,
      jobId, amount: "1", asset: "DEM", payee: `did:demos:agent:${payee}`,
      expectedPayee: payee };
  }
  const first = await settle(request);
  const repeated = await settle(request);
  expect(repeated).toEqual(first);
  publish(join(directory, `result-${step}.json`), { pid: process.pid, txHash: first.txHash });
});

describe.skipIf(child)("payment bridge restart with a caller-supplied durable store", () => {
  test.each(["evm-erc20", "pay-dem"])("keeps one external transfer for %s across a restart", (railName) => {
    const directory = mkdtempSync(join(tmpdir(), "bridge-settlement-"));
    const runner = fileURLToPath(new URL("../../node_modules/vitest/vitest.mjs", import.meta.url));
    const file = fileURLToPath(import.meta.url);
    try {
      for (const step of ["first", "second"]) {
        const log = openSync(join(directory, `child-${step}.log`), "w", 0o600);
        try {
          execFileSync(process.execPath, [runner, "run", file, "-t", "records a child settlement"], {
            cwd: process.cwd(),
            env: { ...process.env, DACS_BRIDGE_TEST_CHILD: "1", DACS_BRIDGE_TEST_DIRECTORY: directory,
              DACS_BRIDGE_TEST_RAIL: railName, DACS_BRIDGE_TEST_STEP: step },
            stdio: ["ignore", log, log],
            timeout: 60_000,
          });
        } finally {
          closeSync(log);
        }
      }
      const ledger = JSON.parse(readFileSync(join(directory, "external-ledger.json"), "utf8")) as { count: number };
      const first = JSON.parse(readFileSync(join(directory, "result-first.json"), "utf8")) as { pid: number; txHash: string };
      const second = JSON.parse(readFileSync(join(directory, "result-second.json"), "utf8")) as { pid: number; txHash: string };
      expect(first.pid).not.toBe(second.pid);
      expect(second.txHash).toBe(first.txHash);
      expect(ledger.count).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
