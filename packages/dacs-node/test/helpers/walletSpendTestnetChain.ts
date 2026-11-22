import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EIP3009_AUTHORIZATION_CANCELED_TOPIC,
  EIP3009_AUTHORIZATION_USED_TOPIC,
  ERC20_TRANSFER_TOPIC,
  sha256Hex,
  x402BuyerSettlementKey,
  type WalletSpendPolicyV1,
  type WalletSpendReservationV1,
  type WalletSpendStateV1,
} from "@kynesyslabs/dacs";

import { createDacsWalletSpendContinuitySignerV1 } from "../../src/walletSpendPostgres.js";

type Hex = `0x${string}`;

export const TESTNET_WALLET = `0x${"5e".repeat(20)}`;
export const TESTNET_ASSET = `0x${"03".repeat(20)}`;
export const TESTNET_PAYEE = `0x${"7a".repeat(20)}`;
export const TESTNET_AMOUNT = "250000";
export const TESTNET_DEPTH = 3;
export const SEARCH_FLOOR = 10_000;
export const LATEST_NUMBER = 20_000;
/** The final head's height at the fixture depth. */
export const FINAL_NUMBER = LATEST_NUMBER - TESTNET_DEPTH + 1;
/** The wallet's token balance the stub answers to `balanceOf`. */
const TESTNET_BALANCE = 10_000_000n;
const BALANCE_OF_SELECTOR = "0x70a08231";
export const TESTNET_TOKEN ="testnet-authority-bearer-".padEnd(48, "k");
const SEED = Buffer.alloc(32, 7);

export function testnetPolicy(overrides: Partial<WalletSpendPolicyV1> = {}): WalletSpendPolicyV1 {
  return {
    policyVersion: "1",
    policyId: "testnet-buyer",
    wallet: TESTNET_WALLET,
    chainId: "eip155:84532",
    maximumConcurrentEffects: 1,
    maximumRetainedReservations: 100,
    assets: [{
      asset: TESTNET_ASSET,
      maximumPerOrderDebit: "5000000",
      maximumNetworkFeeDebit: "0",
      minimumReserve: "0",
      rollingWindowMs: 86_400_000,
      maximumRollingEffects: 10,
      maximumRollingDebit: "10000000",
      maximumCumulativeDebit: "100000000",
      maximumCounterpartyDebit: "25000000",
    }],
    ...overrides,
  };
}

/** A hold shaped as the SDK's x402 buyer builds it for one job phase. */
export function testnetReservation(jobId = "job-one"): WalletSpendReservationV1 {
  const phaseIndex = 0;
  const railId = "x402-exact-evm";
  const amount = TESTNET_AMOUNT;
  return {
    reservationVersion: "1",
    reservationId: `x402:${x402BuyerSettlementKey({ railId, jobId, phaseIndex })}`,
    jobId,
    phaseIndex,
    phase: "pay-x402",
    agreementHash: "a".repeat(64),
    settlementBindingHash: sha256Hex(`binding:${jobId}:${phaseIndex}`),
    railId,
    railDefinitionHash: "c".repeat(64),
    wallet: TESTNET_WALLET,
    chainId: "eip155:84532",
    payee: TESTNET_PAYEE,
    finality: { model: "confirmation-depth", finalityBlocks: TESTNET_DEPTH },
    debits: [{ asset: TESTNET_ASSET, purpose: "service", expectedAmount: amount, maximumAmount: amount }],
  };
}

/** The SDK's nonce for a job phase, written out here so a drift in the product rule shows. */
export function nonceOf(jobId: string, phaseIndex: number): Hex {
  return `0x${sha256Hex(`dacs-sb3:v1:${jobId.normalize("NFC")}:${phaseIndex}`)}`;
}

/** A state holding one row for the hold, with the given bound `validBefore`. */
export function stateWithHold(
  reservation: WalletSpendReservationV1,
  authorizationValidBefore?: number,
): WalletSpendStateV1 {
  const createdAt = 1_700_000_000_000;
  return {
    stateVersion: 1,
    policyHash: "f".repeat(64),
    generation: 2,
    reservations: [{
      reservationId: reservation.reservationId,
      bindingHash: "e".repeat(64),
      reservation,
      stage: "effect-pending",
      generation: 2,
      owner: "testnet",
      leaseExpiresAt: createdAt + 300_000,
      ...(authorizationValidBefore === undefined ? {} : { authorizationValidBefore }),
      createdAt,
      updatedAt: createdAt,
    }],
    totals: [],
    rollingEvents: [],
  };
}

export interface StubBlock { number: number; hash: Hex; parentHash: Hex; timestamp: number }

export const blockHash = (fork: string, number: number): Hex => `0x${sha256Hex(`block:${fork}:${number}`)}`;

/**
 * Blocks `low..high` of one chain. Below `split` the blocks are fork "a"'s, so
 * two chains with the same split share their history below it.
 */
export function chainBlocks(input: Readonly<{
  fork?: string;
  split?: number;
  low?: number;
  high?: number;
  time(number: number): number;
}>): StubBlock[] {
  const fork = input.fork ?? "a";
  const split = input.split ?? Number.NEGATIVE_INFINITY;
  const label = (number: number) => number < split ? "a" : fork;
  const blocks: StubBlock[] = [];
  for (let number = input.low ?? LATEST_NUMBER - 40; number <= (input.high ?? LATEST_NUMBER); number += 1) {
    blocks.push({
      number,
      hash: blockHash(label(number), number),
      parentHash: blockHash(label(number - 1), number - 1),
      timestamp: input.time(number),
    });
  }
  return blocks;
}

/** Chain time that puts the final head at `finalTime`, two seconds per block. */
export const timeWithFinalAt = (finalTime: number) => (number: number) => finalTime + (number - FINAL_NUMBER) * 2;

/** What the stub serves; tests change it between and during checks. */
export interface ChainState {
  chainId: string;
  latest: number;
  /** Blocks served by number. */
  byNumber: Map<number, StubBlock>;
  /** Blocks served by hash, from every fork. */
  byHash: Map<Hex, StubBlock>;
  /** For each nonce, the height from which `authorizationState` answers used. */
  usedFrom: Map<string, number>;
  logs: Record<string, unknown>[];
  receipts: Map<Hex, Record<string, unknown>>;
}

export function chainState(blocks: readonly StubBlock[], extraByHash: readonly StubBlock[] = []): ChainState {
  return {
    chainId: "0x14a34",
    latest: Math.max(...blocks.map((block) => block.number)),
    byNumber: new Map(blocks.map((block) => [block.number, block])),
    byHash: new Map([...blocks, ...extraByHash].map((block) => [block.hash, block])),
    usedFrom: new Map(),
    logs: [],
    receipts: new Map(),
  };
}

const quantity = (value: number | bigint): string => `0x${value.toString(16)}`;
const word = (value: bigint | number): string => `0x${value.toString(16).padStart(64, "0")}`;
const topicOf = (address: string): string => `0x${address.slice(2).padStart(64, "0")}`;

function blockAnswer(block: StubBlock | undefined): unknown {
  return block === undefined ? null : {
    number: quantity(block.number), hash: block.hash, parentHash: block.parentHash,
    timestamp: quantity(block.timestamp),
  };
}

/** Puts one authorization event, and the transfers given, in one receipt in `block`. */
export function recordAuthorization(state: ChainState, input: Readonly<{
  block: StubBlock;
  nonce: Hex;
  event?: "used" | "canceled";
  transfers?: readonly Readonly<{ payee: string; amount: string }>[];
  status?: "0x1" | "0x0";
  /** Whether `authorizationState` answers used from this block on; true unless set false. */
  marksUsed?: boolean;
}>): Hex {
  const transactionHash: Hex = `0x${sha256Hex(`transaction:${input.block.hash}:${input.nonce}`)}`;
  const placed = { blockNumber: quantity(input.block.number), blockHash: input.block.hash, transactionHash };
  const authorization = {
    address: TESTNET_ASSET,
    topics: [
      input.event === "canceled" ? EIP3009_AUTHORIZATION_CANCELED_TOPIC : EIP3009_AUTHORIZATION_USED_TOPIC,
      topicOf(TESTNET_WALLET), input.nonce,
    ],
    data: "0x",
    ...placed,
    logIndex: "0x0",
    removed: false,
  };
  const transfers = (input.transfers ?? []).map((transfer, index) => ({
    address: TESTNET_ASSET,
    topics: [ERC20_TRANSFER_TOPIC, topicOf(TESTNET_WALLET), topicOf(transfer.payee)],
    data: word(BigInt(transfer.amount)),
    ...placed,
    logIndex: quantity(index + 1),
  }));
  state.logs.push(authorization);
  if (input.marksUsed !== false) state.usedFrom.set(input.nonce, input.block.number);
  state.receipts.set(transactionHash, {
    ...placed,
    status: input.status ?? "0x1",
    logs: [authorization, ...transfers],
  });
  return transactionHash;
}

export interface RpcCall { id: number; method: string; params: unknown[] }

export interface ChainStub {
  url: string;
  /** The view the stub serves; tests change it between requests. */
  state: ChainState;
  calls: RpcCall[];
  close(): Promise<void>;
}

const stubs: Server[] = [];

/** Closes every stub the tests opened. */
export async function closeChainStubs(): Promise<void> {
  await Promise.all(stubs.splice(0).map((server) => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  })));
}

function answerFor(state: ChainState, call: RpcCall): unknown {
  const [first] = call.params;
  switch (call.method) {
    case "eth_chainId":
      return state.chainId;
    case "eth_getBlockByNumber":
      return blockAnswer(state.byNumber.get(first === "latest" ? state.latest : Number(first)));
    case "eth_getBlockByHash":
      return blockAnswer(state.byHash.get(String(first).toLowerCase() as Hex));
    case "eth_call": {
      const data = String((first as { data: string }).data);
      if (data.startsWith(BALANCE_OF_SELECTOR)) return word(TESTNET_BALANCE);
      const at = state.byHash.get((call.params[1] as { blockHash: Hex }).blockHash);
      const usedFrom = state.usedFrom.get(`0x${data.slice(-64)}`);
      return word(at !== undefined && usedFrom !== undefined && at.number >= usedFrom ? 1 : 0);
    }
    case "eth_getLogs": {
      const filter = first as { fromBlock: string; toBlock: string; topics: unknown[] };
      return state.logs.filter((log) => {
        const height = Number(log.blockNumber);
        return height >= Number(filter.fromBlock) && height <= Number(filter.toBlock) &&
          (log.topics as string[])[2] === filter.topics[2];
      });
    }
    case "eth_getTransactionReceipt":
      return state.receipts.get(first as Hex) ?? null;
    default:
      return null;
  }
}

function reply(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(typeof body === "string" ? body : JSON.stringify(body));
}

/**
 * A loopback JSON-RPC stand-in for Base Sepolia that serves `state` and records
 * every call. `answer` may replace an answer (return a status and body).
 * `hold` may delay an answer until the promise it returns settles.
 */
export async function chainStub(state: ChainState, options: Readonly<{
  answer?: (call: RpcCall) => Readonly<{ status: number; body: unknown }> | undefined;
  hold?: (call: RpcCall) => Promise<void> | undefined;
}> = {}): Promise<ChainStub> {
  const calls: RpcCall[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const call = JSON.parse(body) as RpcCall;
      calls.push(call);
      const replaced = options.answer?.(call);
      if (replaced !== undefined) return reply(response, replaced.body, replaced.status);
      const answer = () => reply(response, { jsonrpc: "2.0", id: call.id, result: answerFor(state, call) });
      const held = options.hold?.(call);
      if (held === undefined) return answer();
      void held.then(answer);
    });
  });
  stubs.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    state,
    calls,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** The default view: one chain whose final head is at `finalTime`. */
export function defaultChain(finalTime = 1_800_000_000): ChainState {
  return chainState(chainBlocks({ time: timeWithFinalAt(finalTime) }));
}

export const witnessPublicKey = (): string => createDacsWalletSpendContinuitySignerV1({ seed: SEED }).verificationKey;

async function privateFile(path: string, content: string, mode = 0o600): Promise<string> {
  await writeFile(path, content, { mode });
  await chmod(path, mode);
  return path;
}

/** A private directory with the token, seed and policy files, and the ten settings. */
export async function serviceSettings(input: Readonly<{
  rpcUrl: string;
  port?: number;
  policy?: unknown;
}>): Promise<Readonly<{
  root: string;
  dataDirectory: string;
  tokenFile: string;
  environment: Record<string, string | undefined>;
  remove(): Promise<void>;
}>> {
  const root = await mkdtemp(join(tmpdir(), "dacs-testnet-authority-"));
  const tokenFile = await privateFile(join(root, "token"), `${TESTNET_TOKEN}\n`);
  const dataDirectory = join(root, "data");
  return {
    root,
    dataDirectory,
    tokenFile,
    environment: {
      DACS_WALLET_AUTHORITY_URL: `http://127.0.0.1:${input.port ?? 0}`,
      DACS_BUYER_WALLET_AUTHORITY_TOKEN_FILE: tokenFile,
      DACS_WALLET_AUTHORITY_ID: "testnet-authority",
      DACS_WALLET_AUTHORITY_EPOCH: "epoch-one",
      DACS_WALLET_AUTHORITY_WITNESS_PUBLIC_KEY: witnessPublicKey(),
      DACS_WALLET_AUTHORITY_WITNESS_SEED_FILE: await privateFile(join(root, "seed"), `${SEED.toString("hex")}\n`),
      DACS_WALLET_AUTHORITY_DATA_DIRECTORY: dataDirectory,
      DACS_WALLET_AUTHORITY_POLICY_FILE:
        await privateFile(join(root, "policy.json"), JSON.stringify(input.policy ?? testnetPolicy()), 0o644),
      DACS_EVM_RPC_URL: input.rpcUrl,
      DACS_X402_AUTHORIZATION_SEARCH_FROM_BLOCK: String(SEARCH_FLOOR),
    },
    remove: () => rm(root, { recursive: true, force: true }),
  };
}
