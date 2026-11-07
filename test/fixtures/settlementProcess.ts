import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { preparePrivateStoreDirectory } from "../../src/filesystem/privateStore.js";

/** A canonical CORE JID-1 ULID: the Standard's `valid-ulid-full-input` vector. */
export const RESTART_JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

export type RailMode = "generic" | "evm" | "x402";
/**
 * A stop inside the test log's CAS commit: `flushed` after the candidate is
 * written and flushed but before it is linked, `linked` after the link and
 * before the directory flush.
 */
export type CommitCrash =
  `${"claimIntent" | "grantRecovery" | "putOutcome" | "releaseIntent"}-${"flushed" | "linked"}`;
export interface WorkerOptions {
  mode?: RailMode;
  action?: "settle" | "stale" | "takeover" | "session" | "grant";
  now?: number;
  /** `before-sign` is x402 only: after the intent is reserved, before the EIP-3009 signer runs. */
  crash?: "before-sign" | "before-effect" | "before-outcome" | "before-anchor" | "grant-committed" |
    "replay-effect-committed" | CommitCrash;
  /** `landed` queries the test rail authority by the effect's own rail identity. */
  reconcile?: "landed" | "absent" | "throws" | "replay";
  /** Generic only: the rail proves it never invoked the effect, so the store releases the attempt. */
  submit?: "not-invoked";
  race?: boolean;
  /** Changed terms for a restarted process: amount, token/asset, x402 resource. */
  amount?: string;
  token?: string;
  resource?: string;
  owner?: string;
}

/**
 * The EIP-3009 validity window the worker's signer puts in every authorization.
 * Both bounds are signed, so they are part of the authorization SB-3 resumes.
 */
export const X402_SIGNED_WINDOW = { validAfter: "0", validBefore: "4102444800" } as const;

/**
 * One line of the test rail's authoritative ledger, written as the effect lands.
 * An EIP-3009 nonce's state lives on one token contract on one chain, per
 * authorizer, so an x402 record carries that whole scope, and a used nonce
 * carries the signed transfer it executed, validity window included.
 */
export type RailRecord =
  | { rail: "generic"; txHash: string; identity: string }
  | { rail: "evm"; txHash: string; token: string; from: string; to: string; value: string }
  | {
    rail: "x402"; txHash?: string; network: string; asset: string; from: string; nonce: string;
    state: "used" | "cancelled"; to?: string; value?: string; validAfter?: string; validBefore?: string;
  };

export interface WorkerResult {
  pid: number;
  ok: boolean;
  value?: unknown;
  error?: { name: string; message: string; category?: string };
}

export interface WorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}

// Watch before checking: a barrier published between subscription and inspection
// cannot be missed. fs.watch can still lose an event (inotify drops events when
// its queue overflows), so a slow poll backs it up. The deadline ends a wait on
// a crashed writer.
export async function waitForFiles(root: string, names: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const watcher = watch(root, inspect);
    const poll = setInterval(inspect, 100);
    const timeout = setTimeout(() => finish(new Error(`barrier timed out: ${names.join(", ")}`)), timeoutMs);
    function finish(error?: Error, name?: string) {
      clearTimeout(timeout);
      clearInterval(poll);
      watcher.close();
      if (error) reject(error);
      else resolve(name!);
    }
    function inspect() {
      const found = names.find((name) => existsSync(join(root, name)));
      if (found) finish(undefined, found);
    }
    watcher.once("error", (error) => finish(error));
    inspect();
  });
}

// The filesystem stores admit a directory only if every ancestor is owned by the
// user or root and is not group/world writable (a root-owned sticky /tmp is
// allowed), so a private directory under an unsafe TMPDIR is still refused.
// Use the first scratch base whose chain the SDK's own policy admits; if none
// does, keep the TMPDIR root and let the stores name the unsafe component.
export async function createPrivateScratchRoot(prefix: string, bases = [tmpdir(), "/tmp"]): Promise<string> {
  for (const base of bases) {
    let root: string | undefined;
    try {
      root = await mkdtemp(join(base, prefix));
      return await preparePrivateStoreDirectory(root, "settlement restart harness");
    } catch {
      if (root) await rm(root, { recursive: true, force: true });
    }
  }
  return mkdtemp(join(tmpdir(), prefix));
}

export async function createSettlementProcessHarness() {
  const root = await createPrivateScratchRoot("dacs-settlement-restart-");
  await mkdir(join(root, "log"));
  const children: Array<{ child: ChildProcess; exit: Promise<WorkerExit>; output: () => string }> = [];
  return {
    root,
    async barrier(name: string) { await writeFile(join(root, name), "ready"); },
    async wait(names: string[]) {
      try { return await waitForFiles(root, names); }
      catch (error) {
        throw new Error(`${String(error)}\n${children.map(({ child, output }) =>
          `worker ${child.pid}, exit ${child.exitCode}/${child.signalCode}: ${output()}`).join("\n")}`);
      }
    },
    async read<T>(name: string): Promise<T> {
      return JSON.parse(await readFile(join(root, name), "utf8")) as T;
    },
    async lines<T>(name: string): Promise<T[]> {
      try {
        return (await readFile(join(root, name), "utf8")).trim().split("\n").filter(Boolean)
          .map((line) => JSON.parse(line) as T);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
    async count(name = "effects") {
      try { return (await readFile(join(root, name), "utf8")).trim().split("\n").filter(Boolean).length; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw error;
      }
    },
    start(id: string, options: WorkerOptions = {}) {
      const child = spawn(process.execPath, [
        "--loader", fileURLToPath(new URL("./settlementProcessLoader.mjs", import.meta.url)),
        fileURLToPath(new URL("./settlementProcessWorker.ts", import.meta.url)),
        root, id, JSON.stringify(options),
      ], {
        stdio: ["ignore", "pipe", "pipe"],
        // Later children of a scenario reuse the first child's transpiled fixtures.
        env: { ...process.env, DACS_TEST_TRANSPILE_CACHE: join(root, "transpiled") },
      });
      let output = "";
      child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      const exit = new Promise<WorkerExit>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`settlement worker ${id} timed out\n${output}`));
        }, 25_000);
        child.once("error", (error) => { clearTimeout(timeout); reject(error); });
        child.once("close", (code, signal) => {
          clearTimeout(timeout);
          resolve({ code, signal, output });
        });
      });
      // Keep a rejection observed even if a parent assertion fails before joining.
      void exit.catch(() => {});
      children.push({ child, exit, output: () => output });
      return {
        child, exit,
        async wait(names: string[]) {
          const barrier = await waitForFiles(root, [...names, `result-${id}`]);
          if (barrier === `result-${id}`) {
            const ended = await exit;
            const result = await readFile(join(root, barrier), "utf8");
            throw new Error(`worker ${id} completed before ${names.join(", ")}: ${result}\n${ended.output}`);
          }
          return barrier;
        },
        async result() {
          const ended = await exit;
          if (ended.code !== 0 || ended.signal !== null) {
            throw new Error(`settlement worker ${id} failed: ${JSON.stringify(ended)}`);
          }
          return JSON.parse(await readFile(join(root, `result-${id}`), "utf8")) as WorkerResult;
        },
      };
    },
    async cleanup() {
      for (const { child } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      await Promise.allSettled(children.map(({ exit }) => exit));
      await rm(root, { recursive: true, force: true });
    },
  };
}

export type SettlementProcessHarness = Awaited<ReturnType<typeof createSettlementProcessHarness>>;
