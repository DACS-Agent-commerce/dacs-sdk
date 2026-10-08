import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type RailMode = "generic" | "evm" | "x402";
export interface WorkerOptions {
  mode?: RailMode;
  action?: "settle" | "stale" | "takeover" | "session" | "grant";
  now?: number;
  crash?: "before-effect" | "before-outcome" | "before-anchor";
  reconcile?: "landed" | "absent" | "throws" | "replay";
  race?: boolean;
  amount?: string;
}

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
// cannot be missed. The deadline also handles a crashed writer without polling.
export async function waitForFiles(root: string, names: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const watcher = watch(root, inspect);
    const timeout = setTimeout(() => finish(new Error(`barrier timed out: ${names.join(", ")}`)), timeoutMs);
    function finish(error?: Error, name?: string) {
      clearTimeout(timeout);
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

export async function createSettlementProcessHarness() {
  const root = await mkdtemp(join(tmpdir(), "dacs-settlement-restart-"));
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
      ], { stdio: ["ignore", "pipe", "pipe"] });
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
