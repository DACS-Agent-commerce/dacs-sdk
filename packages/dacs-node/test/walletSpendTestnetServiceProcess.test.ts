import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { sha256Hex } from "@kynesyslabs/dacs/canonical";

import { createDacsRemoteWalletSpendAuthorityV2 } from "../src/walletSpendRemote.js";
import { witnessReceipts } from "./helpers/walletSpendFileAuthorityStores.js";
import {
  TESTNET_TOKEN,
  chainStub,
  closeChainStubs,
  defaultChain,
  serviceSettings,
  testnetPolicy,
  testnetReservation,
  witnessPublicKey,
  type RpcCall,
} from "./helpers/walletSpendTestnetChain.js";

const PACKAGE_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(PACKAGE_DIRECTORY, "dist/walletSpendTestnetServiceMain.js");
const WINDOW = { authorizationWindowSeconds: 120 };
const children: ChildProcess[] = [];
const cleanups: (() => Promise<void>)[] = [];

beforeAll(() => {
  expect(existsSync(BIN), "build packages/dacs-node (and the core package) before running this file").toBe(true);
});

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await closeChainStubs();
});

interface Run {
  child: ChildProcess;
  /** The `listening` line, or the exit code when the process ends first. */
  started: Promise<Readonly<{ url: string }> | number | null>;
  exited: Promise<number | null>;
  stderr(): string;
  stdout(): string;
}

function run(environment: Record<string, string | undefined>, args: readonly string[] = []): Run {
  const child = spawn(process.execPath, [BIN, ...args], {
    env: { PATH: process.env.PATH, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const started = new Promise<Readonly<{ url: string }> | number | null>((resolve) => {
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      const [line] = stdout.split("\n");
      if (stdout.includes("\n") && line?.startsWith("{")) resolve(JSON.parse(line) as { url: string });
    });
    void exited.then(resolve);
  });
  return { child, started, exited, stderr: () => stderr, stdout: () => stdout };
}

async function listening(service: Run): Promise<string> {
  const started = await service.started;
  if (typeof started !== "object" || started === null) throw new Error(`exited ${started}: ${service.stderr()}`);
  return started.url;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function portRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(port, "127.0.0.1");
    probe.once("connect", () => {
      probe.destroy();
      resolve(false);
    });
    probe.once("error", () => resolve(true));
  });
}

async function fixture(stubOptions: Parameters<typeof chainStub>[1] = {}) {
  const stub = await chainStub(defaultChain(), stubOptions);
  const settings = await serviceSettings({ rpcUrl: stub.url });
  cleanups.push(() => settings.remove());
  const sent: { body: string; operationId: string }[] = [];
  const client = (url: string) => createDacsRemoteWalletSpendAuthorityV2({
    policy: testnetPolicy(), endpoint: url, tokenFilePath: settings.tokenFile,
    authorityId: "testnet-authority", epoch: "epoch-one", witnessVerificationKey: witnessPublicKey(),
    allowInsecureLoopback: true,
    fetch: async (input, init) => {
      if (init?.method === "POST" && typeof init.body === "string") {
        sent.push({ body: init.body, operationId: (JSON.parse(init.body) as { operationId: string }).operationId });
      }
      return fetch(input, init);
    },
  });
  return { stub, settings, sent, client };
}

const post = (url: string, body: string) => fetch(new URL("v2/wallet-spend/operations", url), {
  method: "POST", headers: { authorization: `Bearer ${TESTNET_TOKEN}`, "content-type": "application/json" }, body,
});

/** The GET form for one operation; the client sends canonical bytes, so their hash is the request hash. */
const lookup = (url: string, operationId: string, body: string) => {
  const query = new URL(`v2/wallet-spend/operations/${operationId}`, url);
  query.searchParams.set("requestHash", sha256Hex(body));
  return query;
};

describe("testnet wallet-spend authority process", { timeout: 60_000 }, () => {
  it("a real restart answers held for the recorded hold", async () => {
    const { settings, sent, client } = await fixture();
    const first = run(settings.environment);
    const firstClient = await client(await listening(first));
    const claim = await firstClient.reserve(testnetReservation(), WINDOW);
    expect(claim.status).toBe("reserved");
    const [reserve] = sent.filter((request) => request.body.includes("\"operation\":\"reserve\""));
    if (reserve === undefined) throw new Error("expected a reserve request");
    const { revision } = await firstClient.inspect();
    const records = readdirSync(join(settings.dataDirectory, "witness")).length;
    first.child.kill("SIGTERM");
    await expect(first.exited).resolves.toBe(0);

    const second = run(settings.environment);
    const url = await listening(second);
    const missing = await fetch(lookup(url, reserve.operationId, reserve.body), {
      headers: { authorization: `Bearer ${TESTNET_TOKEN}` },
    });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ reasonCode: "wallet-spend-authority-operation-missing" });
    const repeated = await post(url, reserve.body);
    const answer = await repeated.json() as { revision: number; result: unknown };
    expect(answer.result).toMatchObject({ status: "held", stage: "reserved" });
    expect(answer.revision).toBe(revision);
    expect(readdirSync(join(settings.dataDirectory, "witness"))).toHaveLength(records);
    await expect((await client(url)).reserve(testnetReservation(), WINDOW))
      .resolves.toMatchObject({ status: "held", stage: "reserved" });
  });

  it("a kill between recording and answering never yields a second authorization", async () => {
    let balanceReads = 0;
    let release = (): void => undefined;
    let reached = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recorded = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const isBalanceRead = (call: RpcCall) =>
      call.method === "eth_call" && String((call.params[0] as { data: string }).data).startsWith("0x70a08231");
    const { settings, sent, client } = await fixture({
      hold: (call) => {
        if (!isBalanceRead(call) || ++balanceReads !== 2) return undefined;
        reached();
        return held;
      },
    });
    const first = run(settings.environment);
    const reserving = (await client(await listening(first))).reserve(testnetReservation(), WINDOW).catch(() => "unanswered");
    await recorded;
    first.child.kill("SIGKILL");
    await first.exited;
    release();
    await expect(reserving).resolves.toBe("unanswered");
    const [reserve] = sent.filter((request) => request.body.includes("\"operation\":\"reserve\""));
    if (reserve === undefined) throw new Error("expected a reserve request");

    const second = run(settings.environment);
    const url = await listening(second);
    const query = await fetch(lookup(url, reserve.operationId, reserve.body), {
      headers: { authorization: `Bearer ${TESTNET_TOKEN}` },
    });
    expect(query.status).toBe(404);
    const repeated = await (await post(url, reserve.body)).json() as { result: unknown };
    expect(repeated.result).toMatchObject({ status: "held", stage: "reserved" });
    const states = readdirSync(join(settings.dataDirectory, "states")).map((name) =>
      JSON.parse(readFileSync(join(settings.dataDirectory, "states", name), "utf8")) as {
        generation: number; reservations: unknown[];
      });
    const head = states.reduce((top, state) => state.generation > top.generation ? state : top);
    expect(head.reservations).toHaveLength(1);
    expect(witnessReceipts(settings.dataDirectory).filter((receipt) => receipt.operationId === reserve.operationId))
      .toHaveLength(1);
  });

  it("refuses to start on a missing setting, a mainnet policy, a wrong chain or a damaged witness", async () => {
    const { stub, settings } = await fixture();
    const port = await freePort();
    const environment = { ...settings.environment, DACS_WALLET_AUTHORITY_URL: `http://127.0.0.1:${port}` };
    const refusedWith = async (changed: Record<string, string | undefined>, reasonCode: string) => {
      const service = run(changed);
      await expect(service.exited).resolves.toBe(1);
      expect(JSON.parse(service.stderr().trim())).toMatchObject({ status: "refused", reasonCode });
    };

    await refusedWith({ ...environment, DACS_WALLET_AUTHORITY_EPOCH: undefined },
      "wallet-spend-testnet-authority-setting-missing");
    expect(await portRefused(port)).toBe(true);
    const mainnetPolicy = join(settings.root, "mainnet-policy.json");
    writeFileSync(mainnetPolicy, JSON.stringify(testnetPolicy({ chainId: "eip155:8453" })), { mode: 0o644 });
    await refusedWith({ ...environment, DACS_WALLET_AUTHORITY_POLICY_FILE: mainnetPolicy },
      "wallet-spend-testnet-authority-network-refused");
    expect(await portRefused(port)).toBe(true);
    stub.state.chainId = "0x2105";
    await refusedWith(environment, "wallet-spend-testnet-authority-rpc-chain-mismatch");
    expect(await portRefused(port)).toBe(true);
    expect(existsSync(settings.dataDirectory)).toBe(false);

    stub.state.chainId = "0x14a34";
    const provisioned = run(environment);
    await listening(provisioned);
    provisioned.child.kill("SIGTERM");
    await provisioned.exited;
    const witness = join(settings.dataDirectory, "witness");
    const head = join(witness, readdirSync(witness).sort().at(-1) ?? "");
    const text = readFileSync(head, "utf8");
    const signed = text.indexOf("\"stateHash\":\"") + "\"stateHash\":\"".length;
    writeFileSync(head, `${text.slice(0, signed)}${text[signed] === "0" ? "1" : "0"}${text.slice(signed + 1)}`);
    await refusedWith(environment, "wallet-spend-file-witness-record-damaged");
  });

  it("prints the witness public key from the seed file alone", async () => {
    const { settings } = await fixture();
    const printed = run({
      DACS_WALLET_AUTHORITY_WITNESS_SEED_FILE: settings.environment.DACS_WALLET_AUTHORITY_WITNESS_SEED_FILE,
    }, ["--print-witness-public-key"]);
    await expect(printed.exited).resolves.toBe(0);
    expect(printed.stdout()).toBe(`${witnessPublicKey()}\n`);

    const unknown = run(settings.environment, ["--listen-anywhere"]);
    await expect(unknown.exited).resolves.toBe(2);
    expect(unknown.stderr()).toMatch(/^usage: dacs-wallet-spend-testnet-authority/);
  });
});
